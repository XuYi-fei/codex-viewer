import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { acceptWebSocket } from './ws.js';
import { json, readJsonBody, setCookie } from './utils.js';

function send(res, response) {
  res.writeHead(response.status, response.headers);
  res.end(response.body);
}

function contentType(path) {
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function serveStatic(publicDir, pathname, res) {
  const localPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(publicDir, localPath);
  if (!existsSync(filePath)) {
    send(res, json({ error: 'Not found' }, 404));
    return true;
  }
  res.writeHead(200, { 'content-type': contentType(filePath) });
  res.end(readFileSync(filePath));
  return true;
}

function extractThread(result) {
  return result?.thread || result?.data?.thread || result?.data || result || null;
}

function readLogLines(filePath, limit = 400) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    const numericLimit = Number(limit);
    if (Number.isFinite(numericLimit) && numericLimit <= 0) return lines;
    const safeLimit = Math.max(1, Math.min(5000, numericLimit || 400));
    return lines.slice(-safeLimit);
  } catch {
    return [];
  }
}

function parseAppLogLine(line) {
  const match = String(line || '').match(/^(\S+)\s+\[([A-Z]+)\]\s+(.+)$/);
  if (!match) return {
    timestamp: null,
    level: 'INFO',
    message: String(line || ''),
    raw: String(line || ''),
  };
  return {
    timestamp: match[1],
    level: match[2],
    message: match[3],
    raw: String(line || ''),
  };
}

function parseJsonLines(lines = []) {
  const data = [];
  for (const line of lines) {
    try {
      data.push(JSON.parse(line));
    } catch {}
  }
  return data;
}

export function createWebServer({ port, host = '127.0.0.1', publicDir, authManager, store, logStore, appServerClient, runtimeState }) {
  const clients = new Set();

  function broadcast(message) {
    const text = JSON.stringify(message);
    for (const client of [...clients]) {
      const ok = client.send(text);
      if (!ok) clients.delete(client);
    }
  }

  const unsubscribeStore = store.subscribe((event) => broadcast({ type: 'event', event }));
  const unsubscribeLogs = logStore.onAppend((entry) => broadcast({ type: 'rawRequest', entry }));

  function requireAuth(req, res) {
    const session = authManager.authenticate(req);
    if (!session) {
      send(res, json({ error: 'Unauthorized' }, 401));
      return null;
    }
    return session;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const pathname = url.pathname;

    if (pathname === '/api/pair/exchange' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const session = authManager.exchangePairing(body.token || '');
      if (!session) {
        send(res, json({ error: 'Invalid or expired pairing token' }, 400));
        return;
      }
      store.registerSession(session);
      send(res, json({
        token: session.bearerToken,
        sessionId: session.id,
        localUrl: runtimeState.localUrl,
        publicUrl: runtimeState.publicUrl,
      }, 200, {
        'set-cookie': authManager.cookieFor(session),
      }));
      return;
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;
      send(res, json({
        ...store.snapshot(session.id),
        sessionId: session.id,
        pairTokenExpiresAt: authManager.getPairing().expiresAt,
      }));
      return;
    }

    if (pathname === '/api/session/takeover' && req.method === 'POST') {
      const session = requireAuth(req, res);
      if (!session) return;
      store.claimWriter(session.id);
      send(res, json({ ok: true, role: store.getSessionRole(session.id) }));
      return;
    }

    if (pathname === '/api/threads' && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;
      send(res, json({ data: store.getThreads() }));
      return;
    }

    if (pathname.startsWith('/api/threads/') && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;

      const threadId = pathname.split('/')[3];
      const shouldResume = url.searchParams.get('resume') !== '0';

      if (shouldResume) {
        try {
          const resumed = await appServerClient.resumeThread(threadId, { cwd: runtimeState.workspacePath });
          const resumedThread = extractThread(resumed);
          if (resumedThread?.id) store.hydrateThread(resumedThread);
        } catch (error) {
          store.emit({
            type: 'diagnostic',
            payload: { stream: 'web-server', text: `resume ${threadId}: ${error.message}` },
            timestamp: new Date().toISOString(),
          });
        }
      }

      const result = await appServerClient.readThread(threadId);
      const rawThread = extractThread(result);
      const thread = rawThread?.id ? store.hydrateThread(rawThread) : store.getThread(threadId);
      if (!thread) {
        send(res, json({ error: 'Thread not found' }, 404));
        return;
      }
      send(res, json({ thread }));
      return;
    }

    if (pathname === '/api/threads' && req.method === 'POST') {
      const session = requireAuth(req, res);
      if (!session) return;
      if (store.getSessionRole(session.id) !== 'controller') {
        send(res, json({ error: 'Viewer is read-only. Take control first.' }, 409));
        return;
      }
      const body = await readJsonBody(req);
      const threadResult = await appServerClient.startThread({ cwd: body.cwd || runtimeState.workspacePath, model: body.model || null });
      const rawThread = extractThread(threadResult);
      const thread = store.upsertThread(rawThread) || rawThread;
      if (!thread?.id) {
        send(res, json({ error: 'Failed to create thread' }, 500));
        return;
      }
      if (body.prompt) {
        await appServerClient.sendTurn({ threadId: thread.id, prompt: body.prompt, cwd: body.cwd || runtimeState.workspacePath, model: body.model || null });
      }
      send(res, json({ thread: store.getThread(thread.id) || thread }));
      return;
    }

    if (pathname.startsWith('/api/threads/') && pathname.endsWith('/interrupt') && req.method === 'POST') {
      const session = requireAuth(req, res);
      if (!session) return;
      if (store.getSessionRole(session.id) !== 'controller') {
        send(res, json({ error: 'Viewer is read-only. Take control first.' }, 409));
        return;
      }
      const threadId = pathname.split('/')[3];
      const thread = store.getThread(threadId);
      if (!thread) {
        send(res, json({ error: 'Thread not found' }, 404));
        return;
      }
      try {
        await appServerClient.interruptTurn(threadId);
      } catch (error) {
        store.emit({
          type: 'diagnostic',
          payload: { stream: 'web-server', text: `interrupt ${threadId}: ${error.message}` },
          timestamp: new Date().toISOString(),
        });
      }
      store.markTurnCompleted({ threadId, turnId: thread.activeTurnId || null, status: 'interrupted', timestamp: new Date().toISOString() });
      store.addThreadEvent(threadId, {
        kind: 'turn/interrupted',
        threadId,
        turnId: thread.activeTurnId || null,
        by: 'viewer',
        timestamp: new Date().toISOString(),
      });
      send(res, json({ ok: true }));
      return;
    }

    if (pathname.startsWith('/api/threads/') && pathname.endsWith('/remove') && req.method === 'POST') {
      const session = requireAuth(req, res);
      if (!session) return;
      if (store.getSessionRole(session.id) !== 'controller') {
        send(res, json({ error: 'Viewer is read-only. Take control first.' }, 409));
        return;
      }
      const threadId = pathname.split('/')[3];
      const thread = store.getThread(threadId);
      if (!thread) {
        send(res, json({ error: 'Thread not found' }, 404));
        return;
      }
      let interrupted = false;
      let interruptError = null;
      if (thread.isBusy) {
        try {
          await appServerClient.interruptTurn(threadId);
          interrupted = true;
        } catch (error) {
          interruptError = error?.message || String(error);
          store.emit({
            type: 'diagnostic',
            payload: { stream: 'web-server', text: `interrupt-before-remove ${threadId}: ${interruptError}` },
            timestamp: new Date().toISOString(),
          });
        }
      }
      store.removeThread(threadId, { reason: 'manual-remove' });
      send(res, json({ ok: true, interrupted, interruptError }));
      return;
    }

    if (pathname === '/api/turns' && req.method === 'POST') {
      const session = requireAuth(req, res);
      if (!session) return;
      if (store.getSessionRole(session.id) !== 'controller') {
        send(res, json({ error: 'Viewer is read-only. Take control first.' }, 409));
        return;
      }
      const body = await readJsonBody(req);
      try {
        const resumed = await appServerClient.resumeThread(body.threadId, { cwd: body.cwd || runtimeState.workspacePath, model: body.model || null });
        const resumedThread = extractThread(resumed);
        if (resumedThread?.id) store.hydrateThread(resumedThread);
      } catch (error) {
        store.emit({
          type: 'diagnostic',
          payload: { stream: 'web-server', text: `resume-before-turn ${body.threadId}: ${error.message}` },
          timestamp: new Date().toISOString(),
        });
      }
      const result = await appServerClient.sendTurn({ threadId: body.threadId, prompt: body.prompt, cwd: body.cwd || runtimeState.workspacePath, model: body.model || null });
      send(res, json({ ok: true, result }));
      return;
    }

    if (pathname === '/api/raw-requests' && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;
      const limit = Number(url.searchParams.get('limit') || 100);
      const cursor = url.searchParams.get('cursor') || null;
      send(res, json(logStore.list({ limit, cursor })));
      return;
    }

    if (pathname === '/api/logs/errors' && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;
      const limit = Number(url.searchParams.get('limit') || 500);
      const levels = String(url.searchParams.get('levels') || 'WARN,ERROR,DIAG')
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
      const allEntries = readLogLines(runtimeState.appLogPath, limit * 3).map((line) => parseAppLogLine(line));
      const filtered = allEntries
        .filter((entry) => levels.includes(entry.level))
        .slice(-Math.max(1, Math.min(5000, limit)));
      send(res, json({
        data: filtered,
        total: filtered.length,
        source: runtimeState.appLogPath || null,
      }));
      return;
    }

    if (pathname === '/api/logs/intercepted' && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;
      const all = url.searchParams.get('all') === '1';
      const limit = all ? 0 : Number(url.searchParams.get('limit') || 1000);
      const rawLines = readLogLines(runtimeState.rawLogPath, limit);
      const data = parseJsonLines(rawLines);
      const typeStats = {};
      const statusStats = {};
      for (const entry of data) {
        const type = String(entry?.type || 'unknown');
        typeStats[type] = (typeStats[type] || 0) + 1;
        const statusCode = entry?.response?.statusCode;
        if (statusCode != null) {
          const key = String(statusCode);
          statusStats[key] = (statusStats[key] || 0) + 1;
        }
      }
      send(res, json({
        data,
        typeStats,
        statusStats,
        total: data.length,
        source: runtimeState.rawLogPath || null,
        rawLines,
      }));
      return;
    }

    if (pathname === '/api/approvals' && req.method === 'GET') {
      const session = requireAuth(req, res);
      if (!session) return;
      send(res, json({ data: store.getApprovals() }));
      return;
    }

    if (pathname.startsWith('/api/approvals/') && pathname.endsWith('/resolve') && req.method === 'POST') {
      const session = requireAuth(req, res);
      if (!session) return;
      if (store.getSessionRole(session.id) !== 'controller') {
        send(res, json({ error: 'Viewer is read-only. Take control first.' }, 409));
        return;
      }
      const approvalId = pathname.split('/')[3];
      const body = await readJsonBody(req);
      await appServerClient.resolveApproval(approvalId, body.result);
      store.resolveApproval(approvalId, body.result);
      send(res, json({ ok: true }));
      return;
    }

    if (pathname === '/healthz') {
      send(res, json({ ok: true }));
      return;
    }

      serveStatic(publicDir, pathname, res);
    } catch (error) {
      if (!res.headersSent) {
        send(res, json({ error: error?.message || 'Internal server error' }, 500));
      } else {
        try { res.end(); } catch {}
      }
      store.emit({
        type: 'diagnostic',
        payload: {
          stream: 'web-server',
          text: error?.stack || error?.message || String(error),
        },
        timestamp: new Date().toISOString(),
      });
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname !== '/ws/events') {
      socket.destroy();
      return;
    }
    const session = authManager.authenticate({ headers: { ...req.headers, authorization: `Bearer ${url.searchParams.get('token') || ''}` } });
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    clients.add(ws);
    ws.send({ type: 'snapshot', data: store.snapshot(session.id) });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return {
    async listen() {
      await new Promise((resolve) => server.listen(port, host, resolve));
      return server;
    },
    async close() {
      unsubscribeStore();
      unsubscribeLogs();
      for (const client of clients) client.close();
      await new Promise((resolve) => server.close(resolve));
    },
    broadcast,
  };
}
