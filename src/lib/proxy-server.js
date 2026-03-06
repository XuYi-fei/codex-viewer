import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';
import { nowIso, randomToken, redactHeaders, tryParseJson } from './utils.js';

function chooseModule(targetUrl) {
  return targetUrl.protocol === 'https:' ? https : http;
}

function collectPreview(chunks, contentType) {
  const preview = Buffer.concat(chunks).toString('utf8');
  if ((contentType || '').includes('application/json')) {
    return tryParseJson(preview) ?? preview;
  }
  return preview;
}

export function createProxyServer({ port, upstreamBaseUrl, logStore, onEvent }) {
  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const requestId = randomToken(8);
    const rawUrl = req.url || '/';
    const isAbsolute = /^https?:\/\//i.test(rawUrl);
    const targetUrl = isAbsolute ? new URL(rawUrl) : new URL(rawUrl, upstreamBaseUrl);
    const client = chooseModule(targetUrl);
    const requestChunks = [];

    req.on('data', (chunk) => requestChunks.push(chunk));

    const upstreamReq = client.request(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
      },
    }, (upstreamRes) => {
      const responseChunks = [];
      upstreamRes.on('data', (chunk) => responseChunks.push(chunk));
      upstreamRes.on('end', () => {
        const entry = {
          id: requestId,
          timestamp: nowIso(),
          type: 'request.completed',
          transport: isAbsolute ? 'forward-proxy' : 'reverse-proxy',
          request: {
            method: req.method,
            url: targetUrl.toString(),
            headers: redactHeaders(req.headers),
            body: collectPreview(requestChunks, req.headers['content-type']),
          },
          response: {
            statusCode: upstreamRes.statusCode,
            statusMessage: upstreamRes.statusMessage,
            headers: redactHeaders(upstreamRes.headers),
            body: collectPreview(responseChunks, upstreamRes.headers['content-type']),
          },
          durationMs: Date.now() - startedAt,
        };
        logStore.append(entry);
        onEvent({ type: 'request.completed', payload: entry, timestamp: entry.timestamp });
      });

      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (error) => {
      const entry = {
        id: requestId,
        timestamp: nowIso(),
        type: 'request.failed',
        transport: isAbsolute ? 'forward-proxy' : 'reverse-proxy',
        request: {
          method: req.method,
          url: targetUrl.toString(),
          headers: redactHeaders(req.headers),
          body: collectPreview(requestChunks, req.headers['content-type']),
        },
        response: null,
        error: error.message,
        durationMs: Date.now() - startedAt,
      };
      logStore.append(entry);
      onEvent({ type: 'request.failed', payload: entry, timestamp: entry.timestamp });
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    });

    req.pipe(upstreamReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    const startedAt = Date.now();
    const requestId = randomToken(8);
    const [hostname, portString] = (req.url || '').split(':');
    const upstreamSocket = net.connect(Number(portString || 443), hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);

      const entry = {
        id: requestId,
        timestamp: nowIso(),
        type: 'request.connect',
        transport: 'connect-tunnel',
        request: {
          method: 'CONNECT',
          url: req.url,
          headers: redactHeaders(req.headers),
          body: null,
        },
        response: {
          statusCode: 200,
          statusMessage: 'Connection Established',
          headers: {},
          body: 'TLS tunnel established; payload is not inspectable in CONNECT mode.',
        },
        durationMs: Date.now() - startedAt,
      };
      logStore.append(entry);
      onEvent({ type: 'request.connect', payload: entry, timestamp: entry.timestamp });
    });

    upstreamSocket.on('error', (error) => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      const entry = {
        id: requestId,
        timestamp: nowIso(),
        type: 'request.connectFailed',
        transport: 'connect-tunnel',
        request: {
          method: 'CONNECT',
          url: req.url,
          headers: redactHeaders(req.headers),
          body: null,
        },
        response: null,
        error: error.message,
        durationMs: Date.now() - startedAt,
      };
      logStore.append(entry);
      onEvent({ type: 'request.connectFailed', payload: entry, timestamp: entry.timestamp });
    });
  });

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
