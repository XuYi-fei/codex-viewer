import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

export function parseArgs(argv) {
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

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

export async function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(startPort, { host = '127.0.0.1', maxTries = 500 } = {}) {
  const base = Number(startPort);
  if (!Number.isInteger(base) || base <= 0 || base > 65535) {
    throw new Error(`Invalid start port: ${startPort}`);
  }

  let port = base;
  for (let attempt = 0; attempt < maxTries && port <= 65535; attempt += 1, port += 1) {
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(port, host);
    if (available) return port;
  }
  throw new Error(`No available port found from ${base} on ${host}`);
}

export function json(value, status = 200, headers = {}) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: JSON.stringify(value),
  };
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function randomToken(size = 24) {
  return randomBytes(size).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function redactHeaders(headers = {}) {
  const copy = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (['authorization', 'cookie', 'set-cookie', 'x-api-key'].includes(lower)) {
      copy[key] = redactSecret(String(value));
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

export function redactSecret(value) {
  if (!value) return value;
  if (value.length <= 10) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function cookieParse(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...rest] = entry.split('=');
        return [key, rest.join('=')];
      }),
  );
}

export function setCookie(name, value, options = {}) {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.sameSite || options.sameSite === '') parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

export function nowIso() {
  return new Date().toISOString();
}

export function sortByUpdatedDesc(items, getTs) {
  return [...items].sort((left, right) => {
    const leftTs = normalizeTimestamp(getTs(left));
    const rightTs = normalizeTimestamp(getTs(right));
    return rightTs - leftTs;
  });
}

export function normalizeTimestamp(value) {
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = new Date(value || 0).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}
