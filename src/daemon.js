import process from 'node:process';
import { rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { parseArgs, getFreePort, nowIso } from './lib/utils.js';
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
const webHost = args['web-host'] === true
  ? '0.0.0.0'
  : (String(args['web-host'] || process.env.CODEX_VIEWER_WEB_HOST || '127.0.0.1').trim() || '127.0.0.1');
const webPort = Number(args['web-port'] || await getFreePort(webHost === '0.0.0.0' ? '127.0.0.1' : webHost));
const proxyPort = await getFreePort();
const appServerPort = await getFreePort();
const publicUrl = args['public-url'] || process.env.CODEX_VIEWER_PUBLIC_URL || null;

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
    webHost,
    proxyPort,
    appServerPort,
  });

  console.log(`[codex-viewer] Local URL: ${localUrl}`);
  if (webHost !== '127.0.0.1') {
    console.log(`[codex-viewer] Web Host: ${webHost} (accessible from remote network if firewall allows)`);
  }
  if (effectivePublicUrl) console.log(`[codex-viewer] Public URL: ${effectivePublicUrl}`);
  console.log(`[codex-viewer] Pair URL: ${pairUrl}`);
}

async function shutdown(signal) {
  console.log(`[codex-viewer] shutting down on ${signal}`);
  try { await webServer.close(); } catch {}
  try { await proxyServer.close(); } catch {}
  try { appServerClient.stop(); } catch {}
  try { rmSync(runtime.statePath, { force: true }); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error('[codex-viewer] fatal:', error);
  process.exit(1);
});
