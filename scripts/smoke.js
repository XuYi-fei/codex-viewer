#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildApprovalPayload(approval) {
  const method = String(approval?.method || '');
  if (method === 'item/tool/requestUserInput') {
    const answers = {};
    const questions = Array.isArray(approval?.params?.questions) ? approval.params.questions : [];
    for (const [index, question] of questions.entries()) {
      const questionId = question?.id || `question_${index + 1}`;
      const option = Array.isArray(question?.options) ? question.options[0] : null;
      const text = option?.label || option?.value || option?.title || '继续';
      answers[questionId] = { answers: [text] };
    }
    return { answers };
  }

  if (method === 'mcpServer/elicitation/request') return { action: 'accept' };

  if (
    method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval'
  ) {
    const available = Array.isArray(approval?.params?.availableDecisions) ? approval.params.availableDecisions : [];
    const hasAccept = available.some((entry) => entry === 'accept');
    if (hasAccept || available.length === 0) return { decision: 'accept' };
    if (available.some((entry) => entry === 'acceptForSession')) return { decision: 'acceptForSession' };
    if (available.some((entry) => entry === 'decline')) return { decision: 'decline' };
    if (available.some((entry) => entry === 'cancel')) return { decision: 'cancel' };
    return { decision: 'accept' };
  }

  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: 'approved' };
  }
  return { decision: 'accept' };
}

function modePrompt(mode) {
  if (mode === 'approval') {
    return '请执行命令 `curl -I https://example.com`。如果需要审批，请立即发起审批并等待用户选择。';
  }
  return '请回复“smoke ok”，并简述你当前是否可用。';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = resolve(args.workspace || process.cwd());
  const runtimeStatePath = join(workspace, '.codex-viewer', 'runtime-state.json');
  if (!existsSync(runtimeStatePath)) {
    throw new Error(`runtime-state not found: ${runtimeStatePath}`);
  }

  const runtime = readJson(runtimeStatePath);
  const baseUrl = String(runtime.localUrl || '').trim();
  const pairToken = String(runtime.pairingToken || '').trim();
  if (!baseUrl || !pairToken) {
    throw new Error('runtime-state missing localUrl or pairingToken');
  }

  const timeoutMs = Math.max(20_000, Number(args.timeoutMs || 120_000));
  const mode = args.mode === 'approval' || args.approval ? 'approval' : 'basic';
  const prompt = String(args.prompt || modePrompt(mode));
  const reportPath = resolve(args.report || join(workspace, '.codex-viewer', 'logs', `smoke-${mode}.json`));

  async function api(path, { method = 'GET', token = '', body = null } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
    }
    return data;
  }

  const report = {
    mode,
    startedAt: nowIso(),
    workspace,
    baseUrl,
    reportPath,
    threadId: null,
    pendingApprovals: [],
    resolvedApprovals: [],
    finalThread: null,
    errors: [],
  };

  try {
    const pair = await api('/api/pair/exchange', { method: 'POST', body: { token: pairToken } });
    const token = pair.token;
    const session = await api('/api/session', { token });
    if (session.viewerRole !== 'controller') {
      await api('/api/session/takeover', { method: 'POST', token, body: {} });
    }

    const create = await api('/api/threads', {
      method: 'POST',
      token,
      body: { prompt },
    });
    const threadId = create?.thread?.id;
    if (!threadId) throw new Error('thread id missing');
    report.threadId = threadId;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sessionNow = await api('/api/session', { token });
      const thread = (sessionNow.threads || []).find((entry) => entry.id === threadId);
      const pending = (sessionNow.approvals || [])
        .filter((entry) => entry.status === 'pending')
        .filter((entry) => !entry.threadId || entry.threadId === threadId);

      for (const approval of pending) {
        if (report.resolvedApprovals.some((item) => String(item.id) === String(approval.id))) continue;
        report.pendingApprovals.push({
          id: approval.id,
          method: approval.method,
          createdAt: approval.createdAt,
        });
        const result = buildApprovalPayload(approval);
        await api(`/api/approvals/${encodeURIComponent(approval.id)}/resolve`, {
          method: 'POST',
          token,
          body: { result },
        });
        report.resolvedApprovals.push({
          id: approval.id,
          method: approval.method,
          result,
        });
      }

      if (thread && thread.isBusy === false) {
        report.finalThread = {
          id: thread.id,
          status: thread.status,
          isBusy: thread.isBusy,
          lastTurnStatus: thread.lastTurnStatus || null,
        };
        break;
      }
      await sleep(1500);
    }

    if (!report.finalThread) {
      const detail = await api(`/api/threads/${encodeURIComponent(threadId)}?resume=0`, { token });
      const thread = detail?.thread || null;
      report.finalThread = thread
        ? {
            id: thread.id,
            status: thread.status,
            isBusy: thread.isBusy,
            lastTurnStatus: thread.lastTurnStatus || null,
            activeFlags: thread?.raw?.status?.activeFlags || [],
          }
        : null;
    }
  } catch (error) {
    report.errors.push(error?.message || String(error));
  }

  report.finishedAt = nowIso();
  report.ok = report.errors.length === 0 && report.finalThread && report.finalThread.isBusy === false;

  mkdirSync(resolve(reportPath, '..'), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

