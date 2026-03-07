import process from 'node:process';
import { appendFileSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { parseArgs, getFreePort, findAvailablePort, nowIso } from './lib/utils.js';
import { createRuntimePaths, writeRuntimeState } from './lib/runtime.js';
import { LogStore } from './lib/log-store.js';
import { ViewerStore } from './lib/store.js';
import { AuthManager } from './lib/auth.js';
import { createProxyServer } from './lib/proxy-server.js';
import { AppServerClient } from './lib/app-server-client.js';
import { createWebServer } from './lib/web-server.js';

const args = parseArgs(process.argv.slice(2));
const workspacePath = args.workspace || process.cwd();
const runtime = createRuntimePaths(workspacePath);
const appLogPath = args['log-file']
  ? String(args['log-file'])
  : (process.env.CODEX_VIEWER_LOG_FILE || runtime.appLogPath);
const webHost = args['web-host'] === true
  ? '0.0.0.0'
  : (String(args['web-host'] || process.env.CODEX_VIEWER_WEB_HOST || '127.0.0.1').trim() || '127.0.0.1');
const requestedWebPort = Number(args['web-port'] || process.env.CODEX_VIEWER_WEB_PORT || 17777);
const webPort = await findAvailablePort(requestedWebPort, { host: webHost, maxTries: 1000 });
const proxyPort = await getFreePort();
const appServerPort = await getFreePort();
const publicUrl = args['public-url'] || process.env.CODEX_VIEWER_PUBLIC_URL || null;

function writeAppLog(level, message, details = null) {
  const timestamp = nowIso();
  const suffix = details ? ` ${typeof details === 'string' ? details : JSON.stringify(details)}` : '';
  try {
    appendFileSync(appLogPath, `${timestamp} [${level}] ${message}${suffix}\n`);
  } catch {}
}

function logInfo(message, details = null) {
  console.log(`[codex-viewer] ${message}`);
  writeAppLog('INFO', message, details);
}

function logWarn(message, details = null) {
  console.warn(`[codex-viewer] ${message}`);
  writeAppLog('WARN', message, details);
}

function logError(message, details = null) {
  console.error(`[codex-viewer] ${message}`);
  writeAppLog('ERROR', message, details);
}

function discoverExternalHost(bindHost) {
  if (!bindHost || bindHost === '127.0.0.1' || bindHost === 'localhost') return null;
  if (bindHost !== '0.0.0.0') return bindHost;
  const interfaces = networkInterfaces();
  for (const records of Object.values(interfaces)) {
    for (const record of records || []) {
      if (record.family === 'IPv4' && !record.internal && record.address) {
        return record.address;
      }
    }
  }
  return null;
}

const localUrl = `http://127.0.0.1:${webPort}`;
const discoveredHost = discoverExternalHost(webHost);
const inferredPublicUrl = discoveredHost ? `http://${discoveredHost}:${webPort}` : null;
const effectivePublicUrl = publicUrl || inferredPublicUrl;
const authManager = new AuthManager();
const pairing = authManager.getPairing();
const pairUrl = `${effectivePublicUrl || localUrl}/?pair=${pairing.token}`;

const store = new ViewerStore({
  workspacePath,
  localUrl,
  publicUrl: effectivePublicUrl,
  pairUrl,
  proxyPort,
  appServerPort,
});
const logStore = new LogStore({ filePath: runtime.rawLogPath });

store.subscribe((event) => {
  if (!event) return;
  if (event.type === 'diagnostic') {
    writeAppLog('DIAG', `diagnostic:${event.payload?.stream || 'unknown'}`, event.payload?.text || '');
    return;
  }
  if (event.type === 'system.status') {
    writeAppLog('STATUS', `${event.payload?.name}=${event.payload?.value}`, event.payload?.error || null);
    return;
  }
  if (event.type === 'request.failed' || event.type === 'request.connectFailed') {
    writeAppLog('WARN', `${event.type}`, {
      url: event.payload?.request?.url || null,
      method: event.payload?.request?.method || null,
      error: event.payload?.error || null,
    });
  }
});

const proxyServer = createProxyServer({
  port: proxyPort,
  upstreamBaseUrl: 'https://api.openai.com',
  logStore,
  onEvent: (event) => store.emit(event),
});

const appServerClient = new AppServerClient({
  port: appServerPort,
  workspacePath,
  proxyPort,
});

appServerClient.on('notification', ({ method, params, timestamp }) => {
  if (method === 'thread/started' && params?.thread) {
    store.upsertThread(params.thread);
    return;
  }
  if (method === 'thread/name/updated' && params?.thread) {
    store.upsertThread(params.thread);
    return;
  }
  if (method === 'turn/started') {
    if (params?.threadId) {
      store.addThreadEvent(params.threadId, { kind: 'turn_started', timestamp, ...params });
    }
    return;
  }
  if (method === 'item/started') {
    store.startItem({ threadId: params.threadId, turnId: params.turnId, item: params.item });
    return;
  }
  if (method === 'item/completed') {
    store.completeItem({ threadId: params.threadId, turnId: params.turnId, item: params.item });
    return;
  }
  if (method === 'item/agentMessage/delta') {
    store.appendMessageDelta({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta });
    return;
  }
  if (method === 'item/reasoning/textDelta') {
    store.appendReasoningDelta({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta, contentIndex: params.contentIndex });
    return;
  }
  if (method === 'item/reasoning/summaryPartAdded') {
    store.appendReasoningSummaryPart({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, summaryIndex: params.summaryIndex });
    return;
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    store.appendReasoningSummaryDelta({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta, summaryIndex: params.summaryIndex });
    return;
  }
  if (method === 'item/commandExecution/outputDelta') {
    store.appendCommandDelta({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, callId: params.callId, delta: params.delta });
    return;
  }
  if (method === 'item/plan/delta') {
    store.appendPlanDelta({ threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta });
    return;
  }
  if (params?.threadId) {
    store.addThreadEvent(params.threadId, { kind: method, timestamp, ...params });
  } else {
    store.emit({ type: method, payload: params, timestamp });
  }
});

appServerClient.on('response', ({ method, result }) => {
  if (method === 'thread/start' && result?.thread) {
    store.upsertThread(result.thread);
  }
  if (method === 'thread/list' && Array.isArray(result?.data)) {
    for (const thread of result.data) store.upsertThread(thread);
  }
  if (method === 'thread/read' || method === 'thread/resume') {
    const thread = result?.thread || result?.data?.thread || result?.data || result;
    if (thread?.id) store.hydrateThread(thread);
  }
});

appServerClient.on('serverRequest', ({ requestId, method, params, timestamp }) => {
  const approval = {
    id: requestId,
    method,
    params,
    threadId: params.threadId || params.conversationId || null,
    turnId: params.turnId || null,
    createdAt: timestamp,
    status: 'pending',
  };
  store.setApproval(approval);
});

appServerClient.on('diagnostic', ({ stream, text }) => {
  store.emit({ type: 'diagnostic', payload: { stream, text }, timestamp: nowIso() });
});

appServerClient.on('exit', ({ code, signal }) => {
  store.setStatus('appServer', 'exited', `code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  logWarn('app-server exited', { code, signal });
});

const webServer = createWebServer({
  port: webPort,
  host: webHost,
  publicDir: new URL('../public', import.meta.url).pathname,
  authManager,
  store,
  logStore,
  appServerClient,
  runtimeState: { workspacePath, localUrl, publicUrl: effectivePublicUrl },
});

async function main() {
  writeAppLog('INFO', 'daemon starting', {
    workspacePath,
    webHost,
    requestedWebPort,
    resolvedWebPort: webPort,
    proxyPort,
    appServerPort,
    appLogPath,
  });
  if (webPort !== requestedWebPort) {
    logWarn(`requested web port ${requestedWebPort} is busy, switched to ${webPort}`);
  }

  store.setStatus('proxy', 'starting');
  await proxyServer.listen();
  store.setStatus('proxy', 'ready');

  store.setStatus('appServer', 'starting');
  await appServerClient.start();
  store.setStatus('appServer', 'ready');

  try {
    const list = await appServerClient.listThreads();
    if (Array.isArray(list?.data)) {
      for (const thread of list.data) store.upsertThread(thread);
    }
  } catch (error) {
    store.emit({ type: 'diagnostic', payload: { stream: 'bootstrap', text: error.message }, timestamp: nowIso() });
  }

  store.setStatus('web', 'starting');
  await webServer.listen();
  store.setStatus('web', 'ready');

  writeRuntimeState(runtime.statePath, {
    pid: process.pid,
    startedAt: nowIso(),
    workspacePath,
    localUrl,
    publicUrl: effectivePublicUrl,
    pairUrl,
    pairingToken: pairing.token,
    webPort,
    requestedWebPort,
    webHost,
    proxyPort,
    appServerPort,
    appLogPath,
  });

  logInfo(`Local URL: ${localUrl}`);
  if (webHost !== '127.0.0.1') {
    logInfo(`Web Host: ${webHost} (accessible from remote network if firewall allows)`);
  }
  if (effectivePublicUrl) logInfo(`Public URL: ${effectivePublicUrl}`);
  logInfo(`Pair URL: ${pairUrl}`);
  logInfo(`Debug log: ${appLogPath}`);
}

async function shutdown(signal) {
  logInfo(`shutting down on ${signal}`);
  try { await webServer.close(); } catch {}
  try { await proxyServer.close(); } catch {}
  try { appServerClient.stop(); } catch {}
  try { rmSync(runtime.statePath, { force: true }); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logError('uncaughtException', error?.stack || error?.message || String(error));
});
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', typeof reason === 'string' ? reason : (reason?.stack || JSON.stringify(reason)));
});

main().catch((error) => {
  logError('fatal', error?.stack || error?.message || String(error));
  process.exit(1);
});
