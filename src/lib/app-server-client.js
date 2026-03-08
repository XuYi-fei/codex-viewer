import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { randomToken, wait, nowIso } from './utils.js';

export class AppServerClient extends EventEmitter {
  constructor({ port, workspacePath, proxyPort, model = null, approvalPolicy = 'on-request', sandbox = 'workspace-write', requestTimeoutMs = 15_000 }) {
    super();
    this.port = port;
    this.workspacePath = workspacePath;
    this.proxyPort = proxyPort;
    this.model = model;
    this.approvalPolicy = approvalPolicy;
    this.sandbox = sandbox;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.ws = null;
    this.requestMap = new Map();
    this.pendingApprovals = new Map();
  }

  async start() {
    const listenUrl = `ws://127.0.0.1:${this.port}`;
    const env = {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${this.proxyPort}`,
      HTTP_PROXY: `http://127.0.0.1:${this.proxyPort}`,
      HTTPS_PROXY: `http://127.0.0.1:${this.proxyPort}`,
      ALL_PROXY: `http://127.0.0.1:${this.proxyPort}`,
    };
    this.child = spawn('codex', ['app-server', '--listen', listenUrl], {
      cwd: this.workspacePath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this.emit('diagnostic', { stream: 'stdout', text: chunk.toString('utf8') }));
    this.child.stderr.on('data', (chunk) => this.emit('diagnostic', { stream: 'stderr', text: chunk.toString('utf8') }));
    this.child.on('exit', (code, signal) => this.emit('exit', { code, signal }));

    await this.connect(listenUrl);
    await this.initialize();
  }

  async connect(url) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const ws = new WebSocket(url);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
        });
        this.ws = ws;
        ws.addEventListener('message', (event) => this.handleMessage(event.data.toString()));
        ws.addEventListener('close', () => {
          this.failPendingRequests(new Error('Codex app-server connection closed'));
          this.emit('closed');
        });
        ws.addEventListener('error', () => {
          this.emit('diagnostic', { stream: 'protocol', text: 'websocket transport error' });
        });
        return;
      } catch {
        await wait(150);
      }
    }
    throw new Error(`Failed to connect to Codex app-server at ${url}`);
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: {
        name: 'codex-viewer',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized');
  }

  async request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server connection is not open');
    }
    const id = randomToken(10);
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      const safeTimeoutMs = Number(timeoutMs);
      const timer = Number.isFinite(safeTimeoutMs) && safeTimeoutMs > 0
        ? setTimeout(() => {
          if (!this.requestMap.has(id)) return;
          this.clearPendingRequest(id);
          reject(new Error(`App-server request timeout (${method}) after ${safeTimeoutMs}ms`));
        }, safeTimeoutMs)
        : null;
      this.requestMap.set(id, {
        resolve,
        reject,
        method,
        timer,
      });
    });
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      const pending = this.clearPendingRequest(id);
      pending?.reject(error);
    }
    return promise;
  }

  notify(method, params) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  respond(id, result) {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  async listThreads() {
    return this.request('thread/list', {});
  }

  async readThread(threadId) {
    return this.request('thread/read', { threadId, includeTurns: true });
  }

  async resumeThread(threadId, { cwd = this.workspacePath, model = this.model, sandbox = this.sandbox, approvalPolicy = this.approvalPolicy, personality = 'pragmatic' } = {}) {
    return this.request('thread/resume', {
      threadId,
      cwd,
      model,
      sandbox,
      approvalPolicy,
      personality,
    });
  }

  async startThread({ cwd = this.workspacePath, model = this.model, sandbox = this.sandbox, approvalPolicy = this.approvalPolicy } = {}) {
    return this.request('thread/start', {
      cwd,
      model,
      sandbox,
      approvalPolicy,
      personality: 'pragmatic',
    });
  }

  async sendTurn({ threadId, prompt, cwd = this.workspacePath, model = this.model, sandboxPolicy = null, approvalPolicy = null }) {
    return this.request('turn/start', {
      threadId,
      cwd,
      model,
      sandboxPolicy,
      approvalPolicy,
      input: [{ type: 'text', text: prompt }],
    });
  }

  async interruptTurn({ threadId, turnId }) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async resolveApproval(id, result) {
    this.respond(id, result);
  }

  stop() {
    this.failPendingRequests(new Error('Codex app-server client stopped'));
    try {
      this.ws?.close();
    } catch {}
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }

  clearPendingRequest(id) {
    if (!this.requestMap.has(id)) return null;
    const pending = this.requestMap.get(id);
    this.requestMap.delete(id);
    if (pending?.timer) clearTimeout(pending.timer);
    return pending || null;
  }

  failPendingRequests(error) {
    for (const id of [...this.requestMap.keys()]) {
      const pending = this.clearPendingRequest(id);
      if (!pending) continue;
      try {
        pending.reject(error);
      } catch {}
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.emit('diagnostic', { stream: 'protocol', text: raw.toString() });
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const messageId = hasId ? message.id : undefined;

    if (hasId && this.requestMap.has(messageId) && Object.prototype.hasOwnProperty.call(message, 'result')) {
      const pending = this.clearPendingRequest(messageId);
      if (!pending) return;
      pending.resolve(message.result);
      this.emit('response', { method: pending.method, result: message.result, timestamp: nowIso() });
      return;
    }
    if (hasId && this.requestMap.has(messageId) && message.error) {
      const pending = this.clearPendingRequest(messageId);
      if (!pending) return;
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      return;
    }

    if (hasId && message.method) {
      this.pendingApprovals.set(messageId, message);
      this.emit('serverRequest', { requestId: messageId, method: message.method, params: message.params, timestamp: nowIso() });
      return;
    }

    if (message.method) {
      this.emit('notification', { method: message.method, params: message.params, timestamp: nowIso() });
    }
  }
}
