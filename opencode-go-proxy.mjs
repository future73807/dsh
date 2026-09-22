import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 8788;
const UPSTREAM_ORIGIN = 'https://opencode.ai';
const UPSTREAM_PREFIX = '/zen/go';
const USER_AGENT = 'dsh-coding-agent-proxy/1.0';
const SESSION_ID = randomUUID();
const UPSTREAM_TIMEOUT_MS = 120_000;

// 思考强度：启动时选定，之后由代理注入到每个 chat/completions 请求体里。
// 取值沿用 DeepSeek 官方 chat/completions 的 reasoning_effort 定义：
// none 关闭思考，low / high / max 开启思考，默认 high。
// off 表示代理完全不注入，请求体按客户端原样转发。
const THINK_EFFORT_CHOICES = [
  { value: 'none', label: '不思考（最快、最省 token）' },
  { value: 'low', label: '轻度思考' },
  { value: 'high', label: '标准思考（默认）' },
  { value: 'max', label: '最大思考（最慢、最费 token）' },
];
const DEFAULT_THINK_EFFORT = 'high';
const THINK_EFFORT_ALIASES = new Map([
  ['1', 'none'],
  ['2', 'low'],
  ['3', 'high'],
  ['4', 'max'],
  ['none', 'none'],
  ['no', 'off'],
  ['off', 'off'],
  ['false', 'off'],
  ['low', 'low'],
  ['minimal', 'low'],
  ['medium', 'high'],
  ['mid', 'high'],
  ['high', 'high'],
  ['xhigh', 'high'],
  ['max', 'max'],
  ['maximum', 'max'],
]);
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

let thinkEffort = DEFAULT_THINK_EFFORT;

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

function isChatCompletionsPath(pathname) {
  return /\/chat\/completions\/?$/.test(pathname);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('request aborted')));
  });
}

function applyThinkEffort(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  if (thinkEffort === 'off') {
    // 不注入，也不清理；请求体保持客户端原样。
    return body;
  }

  if (thinkEffort === 'none') {
    // 关闭思考：清掉客户端可能带来的任何思考参数，避免上游仍进入思考模式。
    delete body.reasoning_effort;
    delete body.reasoning;
    delete body.thinking;
    delete body.output_config;
    return body;
  }

  body.reasoning_effort = thinkEffort;
  // 客户端（VS Code）可能按别的形状塞了思考配置，统一清掉避免冲突。
  delete body.reasoning;
  delete body.thinking;
  delete body.output_config;
  return body;
}

function injectThinkEffort(rawBody, pathname) {
  if (!rawBody.length || thinkEffort === 'off') {
    return rawBody;
  }

  if (!isChatCompletionsPath(pathname)) {
    return rawBody;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rawBody;
  }

  applyThinkEffort(parsed);

  const serialized = Buffer.from(JSON.stringify(parsed), 'utf8');
  console.log(`[proxy] 注入 reasoning_effort=${thinkEffort}`);
  return serialized;
}

function parseThinkEffortArg(raw) {
  if (raw === undefined || raw === null) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  const resolved = THINK_EFFORT_ALIASES.get(normalized);
  return resolved ?? undefined;
}

function describeThinkEffort() {
  if (thinkEffort === 'off') return '不注入（客户端原样转发）';
  if (thinkEffort === 'none') return '不思考（reasoning_effort=none）';
  return `reasoning_effort=${thinkEffort}`;
}

function promptForThinkEffort() {
  if (!process.stdin.isTTY) {
    console.log(`[proxy] 非交互环境，思考强度使用默认值：${describeThinkEffort()}`);
    return Promise.resolve();
  }

  console.log('[proxy] 请选择思考强度（回车 = 3 标准思考）：');
  THINK_EFFORT_CHOICES.forEach((choice, index) => {
    const isDefault = choice.value === DEFAULT_THINK_EFFORT ? '  <- 默认' : '';
    console.log(`  ${index + 1}) ${choice.value.padEnd(4)} ${choice.label}${isDefault}`);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const ask = () => {
      rl.question('[proxy] 输入 1-4 或 none/low/high/max: ', (answer) => {
        const trimmed = answer.trim();
        if (!trimmed) {
          rl.close();
          resolve();
          return;
        }

        const resolved = parseThinkEffortArg(trimmed);
        if (!resolved) {
          console.log(`[proxy] 无法识别的输入「${trimmed}」，请输入 1-4 或 none/low/high/max。`);
          ask();
          return;
        }

        thinkEffort = resolved;
        rl.close();
        resolve();
      });
    };

    ask();
  });
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

  const method = (request.method ?? 'GET').toUpperCase();
  const needsBodyRewrite = method !== 'GET' && method !== 'HEAD' && thinkEffort !== 'off';

  if (!needsBodyRewrite) {
    request.pipe(upstreamRequest);
    return;
  }

  readRequestBody(request)
    .then((rawBody) => {
      if (response.destroyed || upstreamRequest.destroyed) return;

      let payload = rawBody;
      try {
        payload = injectThinkEffort(rawBody, new URL(request.url || '/', 'http://127.0.0.1').pathname);
      } catch (error) {
        console.error(`[proxy] 注入思考强度失败，按原样转发: ${error.message}`);
        payload = rawBody;
      }

      // 请求体长度会变，Content-Length 必须跟着改，否则上游会截断或挂住。
      headers['content-length'] = Buffer.byteLength(payload);
      upstreamRequest.setHeader('content-length', headers['content-length']);
      upstreamRequest.end(payload);
    })
    .catch((error) => {
      if (requestFinished || response.destroyed) return;
      requestFinished = true;
      console.error(`[proxy] 读取请求体失败: ${error.message}`);
      upstreamRequest.destroy();
      writeProxyError(response, 400, 'The proxy could not read the request body.');
    });
}

const server = http.createServer(handleRequest);

server.on('clientError', (error, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  }
  console.error(`[proxy] client error: ${error.message}`);
});

function shutdown(signal) {
  console.log(`[proxy] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  const cliValue = parseThinkEffortArg(process.argv[2]);

  if (process.argv[2] !== undefined && cliValue === undefined) {
    console.error(`[proxy] 无法识别的思考强度参数「${process.argv[2]}」。`);
    console.error('[proxy] 可用值：none / low / high / max / off');
    process.exit(1);
  }

  if (cliValue !== undefined) {
    thinkEffort = cliValue;
  } else {
    await promptForThinkEffort();
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`[proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
    console.log(`[proxy] forwarding to ${UPSTREAM_ORIGIN}${UPSTREAM_PREFIX}`);
    console.log(`[proxy] x-opencode-session: ${SESSION_ID}`);
    console.log(`[proxy] user-agent: ${USER_AGENT}`);
    console.log(`[proxy] 思考强度: ${describeThinkEffort()}`);
  });
}

main();
