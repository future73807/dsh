import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 8788;
const UPSTREAM_ORIGIN = 'https://opencode.ai';
const UPSTREAM_PREFIX = '/zen/go';
const USER_AGENT = 'dsh-coding-agent-proxy/1.0';
const SESSION_ID = randomUUID();
const UPSTREAM_TIMEOUT_MS = 120_000;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function getConnectionHeaderNames(headers) {
  const connection = headers.connection;
  if (!connection) return new Set();

  const values = Array.isArray(connection) ? connection : [connection];
  return new Set(
    values
      .flatMap((value) => value.split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function copyEndToEndHeaders(headers) {
  const connectionHeaderNames = getConnectionHeaderNames(headers);
  const copied = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || connectionHeaderNames.has(lowerName)) {
      continue;
    }
    copied[lowerName] = value;
  }

  return copied;
}

function getUpstreamPath(requestUrl) {
  const incoming = new URL(requestUrl || '/', 'http://127.0.0.1');
  const path = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;
  return `${UPSTREAM_PREFIX}${path}${incoming.search}`;
}

function writeProxyError(response, statusCode, message) {
  if (response.headersSent || response.destroyed) {
    if (!response.writableEnded) response.destroy();
    return;
  }

  const body = JSON.stringify({
    error: {
      message,
      type: 'proxy_error',
    },
  });

  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function logRequest(method, path, statusCode) {
  console.log(`[proxy] ${method} ${path} -> ${statusCode} (session ${SESSION_ID})`);
}

function handleRequest(request, response) {
  const targetPath = getUpstreamPath(request.url);
  const target = new URL(targetPath, UPSTREAM_ORIGIN);
  const headers = copyEndToEndHeaders(request.headers);

  headers.host = target.host;
  headers['user-agent'] = USER_AGENT;
  headers['x-opencode-session'] = SESSION_ID;

  const upstreamRequest = https.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      method: request.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = copyEndToEndHeaders(upstreamResponse.headers);
      const statusCode = upstreamResponse.statusCode ?? 502;

      if (!response.destroyed) {
        response.writeHead(statusCode, responseHeaders);
        logRequest(request.method ?? 'UNKNOWN', request.url ?? '/', statusCode);
        upstreamResponse.pipe(response);
      } else {
        upstreamResponse.resume();
      }
    },
  );

  let requestFinished = false;

  upstreamRequest.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamRequest.destroy(new Error('upstream request timed out'));
  });

  upstreamRequest.on('error', (error) => {
    if (requestFinished || response.destroyed) return;
    requestFinished = true;
    console.error(`[proxy] upstream error for ${request.method ?? 'UNKNOWN'} ${request.url ?? '/'}: ${error.message}`);
    writeProxyError(response, 502, 'The upstream request failed.');
  });

  upstreamRequest.on('close', () => {
    requestFinished = true;
  });

  request.on('aborted', () => {
    upstreamRequest.destroy();
  });

  response.on('close', () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });

  request.pipe(upstreamRequest);
}

const server = http.createServer(handleRequest);

server.on('clientError', (error, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
  console.error(`[proxy] client error: ${error.message}`);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`[proxy] forwarding to ${UPSTREAM_ORIGIN}${UPSTREAM_PREFIX}`);
  console.log(`[proxy] x-opencode-session: ${SESSION_ID}`);
  console.log(`[proxy] user-agent: ${USER_AGENT}`);
});

function shutdown(signal) {
  console.log(`[proxy] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
