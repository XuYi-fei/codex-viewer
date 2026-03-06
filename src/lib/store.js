import { nowIso, sortByUpdatedDesc } from './utils.js';

function pickThreadSummary(thread = {}) {
  const title = thread.title || thread.name || thread.preview || thread.summary || 'Untitled thread';
  return {
    id: thread.id,
    title,
    status: thread.status || 'idle',
    cwd: thread.cwd || null,
    updatedAt: thread.updatedAt || thread.updated_at || nowIso(),
    metadata: thread.metadata || null,
    raw: thread,
  };
}

function createThreadDetails(id) {
  return { id, events: [], messages: [], commandLog: [], planLog: [] };
}

function toIsoTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return null;
}

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => extractText(entry)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return value.content.map((entry) => extractText(entry)).filter(Boolean).join('\n');
  }
  return '';
}

function extractTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => extractText(entry)).filter(Boolean);
}

function extractFilePath(change) {
  if (!change || typeof change !== 'object') return null;
  return change.path || change.filePath || change.newPath || change.oldPath || null;
}

function buildFileChangeSummary(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change) => extractFilePath(change))
    .filter(Boolean);
  const uniquePaths = [...new Set(paths)];
  const count = uniquePaths.length || changes.length;
  const head = count === 1 ? 'Updated 1 file.' : `Updated ${count} files.`;
  if (!count) {
    return { count: 0, paths: [], text: 'Updated files.' };
  }

  const preview = uniquePaths.slice(0, 6).map((filePath) => `- \`${filePath}\``).join('\n');
  const more = uniquePaths.length > 6 ? `\n- …and ${uniquePaths.length - 6} more` : '';
  return {
    count,
    paths: uniquePaths,
    text: `${head}\n${preview}${more}`,
  };
}

export class ViewerStore {
  constructor({ workspacePath, localUrl, publicUrl, pairUrl, proxyPort, appServerPort }) {
    this.workspacePath = workspacePath;
    this.localUrl = localUrl;
    this.publicUrl = publicUrl || null;
    this.pairUrl = pairUrl;
    this.proxyPort = proxyPort;
    this.appServerPort = appServerPort;
    this.status = {
      proxy: 'starting',
      appServer: 'starting',
      web: 'starting',
    };
    this.threadMap = new Map();
    this.threadDetails = new Map();
    this.approvals = new Map();
    this.sessions = new Map();
    this.writerSessionId = null;
    this.listeners = new Set();
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureThreadDetail(threadId) {
    if (!this.threadDetails.has(threadId)) {
      this.threadDetails.set(threadId, createThreadDetails(threadId));
    }
    return this.threadDetails.get(threadId);
  }

  setStatus(name, value, error = null) {
    this.status[name] = value;
    this.emit({ type: 'system.status', payload: { name, value, error }, timestamp: nowIso() });
  }

  registerSession(session) {
    this.sessions.set(session.id, session);
    if (!this.writerSessionId) {
      this.writerSessionId = session.id;
    }
  }

  getSessionRole(sessionId) {
    return this.writerSessionId === sessionId ? 'controller' : 'viewer';
  }

  claimWriter(sessionId) {
    this.writerSessionId = sessionId;
    this.emit({ type: 'system.writerChanged', payload: { sessionId }, timestamp: nowIso() });
  }

  upsertThread(thread) {
    const summary = pickThreadSummary(thread);
    const previous = this.threadMap.get(summary.id) || {};
    const merged = { ...previous, ...summary };
    this.threadMap.set(summary.id, merged);
    this.ensureThreadDetail(summary.id);
    this.emit({ type: 'thread.updated', payload: merged, timestamp: nowIso() });
    return merged;
  }

  addThreadEvent(threadId, entry) {
    const detail = this.ensureThreadDetail(threadId);
    detail.events.push(entry);
    if (detail.events.length > 500) detail.events = detail.events.slice(-500);
    this.emit({ type: 'thread.event', payload: entry, timestamp: nowIso() });
  }

  ensureMessage({ threadId, turnId, itemId, role }) {
    const detail = this.ensureThreadDetail(threadId);
    let message = detail.messages.find((entry) => entry.turnId === turnId && entry.itemId === itemId && entry.role === role);
    if (!message) {
      message = {
        id: `${threadId}:${turnId}:${itemId}:${role}`,
        role,
        threadId,
        turnId,
        itemId,
        text: '',
        summaryText: '',
        updatedAt: nowIso(),
        createdAt: nowIso(),
        status: 'streaming',
      };
      detail.messages.push(message);
    }
    return message;
  }

  startItem({ threadId, turnId, item }) {
    if (!item?.type) {
      this.addThreadEvent(threadId, { kind: 'item_started', threadId, turnId, itemType: 'unknown', timestamp: nowIso() });
      return;
    }

    if (item.type === 'userMessage') {
      const text = Array.isArray(item.content)
        ? item.content.map((entry) => entry.text || '').join('')
        : item.text || '';
      const detail = this.ensureThreadDetail(threadId);
      const exists = detail.messages.find((entry) => entry.turnId === turnId && entry.itemId === item.id && entry.role === 'user');
      if (!exists) {
        detail.messages.push({
          id: `${threadId}:${turnId}:${item.id}:user`,
          role: 'user',
          threadId,
          turnId,
          itemId: item.id,
          text,
          summaryText: '',
          updatedAt: nowIso(),
          createdAt: nowIso(),
          status: 'completed',
        });
      }
    }

    if (item.type === 'agentMessage') {
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'assistant' });
      if (typeof item.text === 'string' && item.text && !message.text) {
        message.text = item.text;
      }
      message.phase = item.phase || message.phase || null;
    }

    if (item.type === 'reasoning') {
      this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'reasoning' });
    }

    this.addThreadEvent(threadId, {
      kind: 'item_started',
      threadId,
      turnId,
      itemType: item.type,
      itemId: item.id,
      text: item.type === 'userMessage' ? (Array.isArray(item.content) ? item.content.map((entry) => entry.text || '').join('') : item.text || '') : undefined,
      label: item.type === 'reasoning' ? 'Thinking started' : `${item.type} started`,
      timestamp: nowIso(),
    });
  }

  completeItem({ threadId, turnId, item }) {
    const detail = this.ensureThreadDetail(threadId);

    if (item?.type === 'agentMessage') {
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'assistant' });
      if (typeof item.text === 'string') message.text = item.text;
      message.phase = item.phase || message.phase || null;
      message.status = 'completed';
      message.updatedAt = nowIso();
    }

    if (item?.type === 'reasoning') {
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'reasoning' });
      if (Array.isArray(item.content) && !message.text) {
        message.text = item.content.map((entry) => entry.text || '').join('');
      }
      if (Array.isArray(item.summary) && !message.summaryText) {
        message.summaryText = item.summary.map((entry) => entry.text || '').join('');
      }
      message.status = 'completed';
      message.updatedAt = nowIso();
    }

    if (item?.type === 'fileChange') {
      const summary = buildFileChangeSummary(item);
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'assistant' });
      message.text = summary.text;
      message.phase = item.status || message.phase || null;
      message.status = 'completed';
      message.updatedAt = nowIso();
      this.addThreadEvent(threadId, {
        kind: 'file_change',
        threadId,
        turnId,
        itemId: item.id,
        label: 'Files updated',
        count: summary.count,
        files: summary.paths,
        status: item.status || null,
        timestamp: nowIso(),
      });
    }

    if (item?.type === 'userMessage') {
      const userMessage = detail.messages.find((entry) => entry.turnId === turnId && entry.itemId === item.id && entry.role === 'user');
      if (userMessage) {
        userMessage.status = 'completed';
        userMessage.updatedAt = nowIso();
      }
    }

    this.addThreadEvent(threadId, {
      kind: 'item_completed',
      threadId,
      turnId,
      itemType: item?.type || 'unknown',
      itemId: item?.id || null,
      label: item?.type === 'reasoning' ? 'Thinking completed' : `${item?.type || 'item'} completed`,
      timestamp: nowIso(),
    });
  }

  appendMessageDelta({ threadId, turnId, itemId, delta, role = 'assistant' }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role });
    message.text += delta;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: role === 'assistant' ? 'assistant_delta' : 'message',
      role,
      threadId,
      turnId,
      itemId,
      delta,
      text: message.text,
      timestamp: nowIso(),
    });
  }

  appendReasoningDelta({ threadId, turnId, itemId, delta, contentIndex = 0 }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role: 'reasoning' });
    if (message.lastContentIndex != null && message.lastContentIndex !== contentIndex && message.text) {
      message.text += '\n';
    }
    message.lastContentIndex = contentIndex;
    message.text += delta;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: 'reasoning_delta',
      threadId,
      turnId,
      itemId,
      delta,
      contentIndex,
      timestamp: nowIso(),
    });
  }

  appendReasoningSummaryPart({ threadId, turnId, itemId, summaryIndex }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role: 'reasoning' });
    if (message.summaryText) {
      message.summaryText += '\n';
    }
    message.lastSummaryIndex = summaryIndex;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: 'reasoning_summary_part',
      threadId,
      turnId,
      itemId,
      summaryIndex,
      timestamp: nowIso(),
    });
  }

  appendReasoningSummaryDelta({ threadId, turnId, itemId, delta, summaryIndex = 0 }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role: 'reasoning' });
    if (message.lastSummaryIndex != null && message.lastSummaryIndex !== summaryIndex && message.summaryText) {
      message.summaryText += '\n';
    }
    message.lastSummaryIndex = summaryIndex;
    message.summaryText += delta;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: 'reasoning_summary_delta',
      threadId,
      turnId,
      itemId,
      summaryIndex,
      delta,
      timestamp: nowIso(),
    });
  }

  appendCommandDelta({ threadId, turnId, itemId, callId, delta }) {
    const detail = this.ensureThreadDetail(threadId);
    let command = detail.commandLog.find((entry) => entry.itemId === itemId);
    if (!command) {
      command = { threadId, turnId, itemId, callId, output: '', updatedAt: nowIso() };
      detail.commandLog.push(command);
    }
    command.output += delta;
    command.updatedAt = nowIso();
    this.addThreadEvent(threadId, { kind: 'command', threadId, turnId, itemId, callId, delta, output: command.output, timestamp: nowIso() });
  }

  appendPlanDelta({ threadId, turnId, itemId, delta }) {
    const detail = this.ensureThreadDetail(threadId);
    detail.planLog.push({ threadId, turnId, itemId, delta, timestamp: nowIso() });
    this.addThreadEvent(threadId, { kind: 'plan', threadId, turnId, itemId, delta, timestamp: nowIso() });
  }

  hydrateThread(thread) {
    if (!thread?.id) return null;

    const summary = pickThreadSummary(thread);
    const previous = this.threadMap.get(summary.id) || {};
    const merged = { ...previous, ...summary, raw: thread };
    this.threadMap.set(summary.id, merged);

    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const hasHydratableTurns = turns.some((turn) => Array.isArray(turn?.items) && turn.items.length > 0);
    const detail = hasHydratableTurns ? createThreadDetails(summary.id) : (this.threadDetails.get(summary.id) || createThreadDetails(summary.id));
    const fallbackTimestamp = toIsoTimestamp(thread.updatedAt) || nowIso();

    if (hasHydratableTurns) {
      for (const turn of turns) {
        const turnId = turn?.id || `turn-${detail.events.length + 1}`;
        const timestamp = fallbackTimestamp;
        const items = Array.isArray(turn?.items) ? turn.items : [];

        for (const item of items) {
          if (!item?.id || !item?.type) continue;

          if (item.type === 'userMessage') {
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:user`,
              role: 'user',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: extractText(item.content),
              summaryText: '',
              updatedAt: timestamp,
              createdAt: timestamp,
              status: 'completed',
            });
            continue;
          }

          if (item.type === 'agentMessage') {
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:assistant`,
              role: 'assistant',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: item.text || '',
              summaryText: '',
              phase: item.phase || null,
              updatedAt: timestamp,
              createdAt: timestamp,
              status: turn?.status === 'inProgress' ? 'streaming' : 'completed',
            });
            continue;
          }

          if (item.type === 'reasoning') {
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:reasoning`,
              role: 'reasoning',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: extractTextList(item.content).join('\n'),
              summaryText: extractTextList(item.summary).join('\n'),
              updatedAt: timestamp,
              createdAt: timestamp,
              status: turn?.status === 'inProgress' ? 'streaming' : 'completed',
            });
            continue;
          }

          if (item.type === 'commandExecution') {
            detail.commandLog.push({
              threadId: summary.id,
              turnId,
              itemId: item.id,
              callId: item.processId || item.id,
              command: item.command || '',
              cwd: item.cwd || null,
              status: item.status || null,
              exitCode: item.exitCode ?? null,
              durationMs: item.durationMs ?? null,
              output: item.aggregatedOutput || '',
              updatedAt: timestamp,
            });
            detail.events.push({
              kind: 'command',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              callId: item.processId || item.id,
              output: item.aggregatedOutput || '',
              timestamp,
            });
            continue;
          }

          if (item.type === 'plan') {
            detail.planLog.push({
              threadId: summary.id,
              turnId,
              itemId: item.id,
              delta: item.text || '',
              timestamp,
            });
            detail.events.push({ kind: 'plan', threadId: summary.id, turnId, itemId: item.id, delta: item.text || '', timestamp });
            continue;
          }

          if (item.type === 'fileChange') {
            const fileSummary = buildFileChangeSummary(item);
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:assistant`,
              role: 'assistant',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: fileSummary.text,
              summaryText: '',
              phase: item.status || null,
              updatedAt: timestamp,
              createdAt: timestamp,
              status: turn?.status === 'inProgress' ? 'streaming' : 'completed',
            });
            detail.events.push({
              kind: 'file_change',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              label: 'Files updated',
              count: fileSummary.count,
              files: fileSummary.paths,
              status: item.status || null,
              timestamp,
            });
            continue;
          }

          detail.events.push({
            kind: 'item_loaded',
            threadId: summary.id,
            turnId,
            itemId: item.id,
            itemType: item.type,
            label: `${item.type} loaded`,
            timestamp,
          });
        }

        if (turn?.error?.message) {
          detail.events.push({
            kind: 'turn_error',
            threadId: summary.id,
            turnId,
            message: turn.error.message,
            timestamp,
          });
        }

        detail.events.push({
          kind: turn?.status === 'completed' ? 'turn/completed' : 'turn/status',
          threadId: summary.id,
          turnId,
          status: turn?.status || 'unknown',
          timestamp,
        });
      }
    }

    detail.messages.sort((left, right) => new Date(left.createdAt || left.updatedAt || 0).getTime() - new Date(right.createdAt || right.updatedAt || 0).getTime());
    detail.commandLog.sort((left, right) => new Date(left.updatedAt || 0).getTime() - new Date(right.updatedAt || 0).getTime());
    detail.events.sort((left, right) => new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime());

    this.threadDetails.set(summary.id, detail);

    const hydrated = {
      ...merged,
      details: detail,
    };

    this.emit({ type: 'thread.updated', payload: hydrated, timestamp: nowIso() });
    return hydrated;
  }

  setApproval(approval) {
    this.approvals.set(approval.id, approval);
    this.emit({ type: 'approval.pending', payload: approval, timestamp: nowIso() });
  }

  resolveApproval(id, resolution) {
    const item = this.approvals.get(id);
    if (!item) return;
    item.resolvedAt = nowIso();
    item.resolution = resolution;
    item.status = 'resolved';
    this.emit({ type: 'approval.resolved', payload: item, timestamp: nowIso() });
  }

  getApprovals() {
    return [...this.approvals.values()].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  getThreads() {
    return sortByUpdatedDesc([...this.threadMap.values()].map((thread) => ({
      ...thread,
      details: this.threadDetails.get(thread.id) || createThreadDetails(thread.id),
    })), (thread) => thread.updatedAt);
  }

  getThread(threadId) {
    const thread = this.threadMap.get(threadId);
    if (!thread) return null;
    return {
      ...thread,
      details: this.threadDetails.get(threadId) || createThreadDetails(threadId),
    };
  }

  snapshot(sessionId = null) {
    return {
      workspacePath: this.workspacePath,
      localUrl: this.localUrl,
      publicUrl: this.publicUrl,
      pairUrl: this.pairUrl,
      proxyPort: this.proxyPort,
      appServerPort: this.appServerPort,
      status: this.status,
      viewerRole: sessionId ? this.getSessionRole(sessionId) : 'viewer',
      writerSessionId: this.writerSessionId,
      threads: this.getThreads(),
      approvals: this.getApprovals(),
    };
  }
}
