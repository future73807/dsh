import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
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

// 上游错误响应：代理把 4xx/5xx 的原因解析出来打印到控制台，
// 并在上游没给可用信息时（空响应体、或 JSON 里没有 message）补上具体原因，
// 避免客户端只看到一个光秃秃的状态码。
const MAX_ERROR_BODY_BYTES = 128 * 1024;
const MAX_ERROR_REASON_CHARS = 1500;
const ERROR_MESSAGE_KEYS = ['message', 'msg', 'detail', 'reason', 'error_description'];

// 上游（DeepSeek 思考模式）要求：历史里带 tool_calls 的 assistant 消息必须回传 reasoning_content，
// 否则整轮请求 400：The reasoning_content in the thinking mode must be passed back to the API.
//
// 但 VS Code Copilot 只在响应提供 cot_id / reasoning_opaque / signature 时才回传该字段
// （内部 getCompletionsCallback 被 `if (thinking.id)` 门控），
// 而 DeepSeek 流式响应只给 reasoning_content、不给 id，于是永远不回传。
// 代理是唯一能同时看到两个方向的地方：旁路读取响应流缓存真实思考内容，在后续请求里补回去。
const REASONING_CACHE_LIMIT = 500;
const MAX_RESPONSE_SNIFF_BYTES = 16 * 1024 * 1024;
// 单条思考内容上限，防止个别超长响应把缓存文件撑爆。
const MAX_REASONING_ENTRY_CHARS = 200_000;
// 缓存落盘，使代理重启后旧会话仍能命中真实思考内容（否则只能走占位兜底）。
const REASONING_CACHE_FILE = path.join(import.meta.dirname, 'proxy-reasoning-cache.json');
// 缓存未命中时的兜底值：上游只校验该字段是否存在，非空占位即可通过。
const REASONING_PLACEHOLDER = '(thinking content was not returned by the client)';

const reasoningCache = new Map();

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

function loadReasoningCache() {
  let raw;
  try {
    raw = fs.readFileSync(REASONING_CACHE_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[proxy] 读取思考缓存失败（忽略）: ${error.message}`);
    }
    return;
  }

  try {
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [key, value] = entry;
        if (typeof key === 'string' && typeof value === 'string') reasoningCache.set(key, value);
      }
    }
    if (reasoningCache.size) {
      console.log(`[proxy] 已从磁盘恢复 ${reasoningCache.size} 条思考缓存`);
    }
  } catch (error) {
    console.error(`[proxy] 解析思考缓存失败（忽略）: ${error.message}`);
  }
}

let cacheSaveTimer = null;

function scheduleReasoningCacheSave() {
  if (cacheSaveTimer) return;

  // 防抖：一次对话会多次命中，等写入安静下来再落盘。
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      fs.writeFileSync(REASONING_CACHE_FILE, JSON.stringify([...reasoningCache]), 'utf8');
    } catch (error) {
      console.error(`[proxy] 保存思考缓存失败（忽略）: ${error.message}`);
    }
  }, 1000);
  cacheSaveTimer.unref();
}

function rememberReasoning(toolCallIds, reasoningText) {
  if (!toolCallIds.length || !reasoningText) return 0;
  if (reasoningText.length > MAX_REASONING_ENTRY_CHARS) {
    console.warn(`[proxy] 思考内容过长（${reasoningText.length} 字符），放弃缓存`);
    return 0;
  }

  let stored = 0;
  for (const id of toolCallIds) {
    if (!id) continue;
    // 重新插入以刷新 LRU 位置。
    if (reasoningCache.has(id)) reasoningCache.delete(id);
    reasoningCache.set(id, reasoningText);
    stored++;
  }

  while (reasoningCache.size > REASONING_CACHE_LIMIT) {
    reasoningCache.delete(reasoningCache.keys().next().value);
  }

  if (stored) scheduleReasoningCacheSave();
  return stored;
}

// 兼容流式（SSE）与一次性 JSON 两种响应形状。
function extractReasoningPayload(text) {
  const reasoningParts = [];
  const toolCallIds = [];

  const collectChoice = (choice) => {
    const delta = choice?.delta ?? choice?.message;
    if (!delta) return;

    const piece = delta.reasoning_content ?? delta.reasoning;
    if (typeof piece === 'string' && piece.length > 0) {
      reasoningParts.push(piece);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (call?.id) toolCallIds.push(call.id);
      }
    }
  };

  const collectJson = (payload) => {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (!Array.isArray(json?.choices)) return;
    for (const choice of json.choices) collectChoice(choice);
  };

  let sawSseFrame = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    sawSseFrame = true;
    collectJson(payload);
  }

  if (!sawSseFrame) collectJson(text);

  return { reasoning: reasoningParts.join(''), toolCallIds };
}

function injectMissingReasoning(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return { restored: 0, placeholder: 0 };

  let restored = 0;
  let placeholder = 0;

  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;

    const existing = message.reasoning_content;
    if (typeof existing === 'string' && existing.length > 0) continue;

    let cached;
    for (const call of message.tool_calls) {
      const hit = call?.id ? reasoningCache.get(call.id) : undefined;
      if (hit) {
        cached = hit;
        break;
      }
    }

    if (cached) {
      message.reasoning_content = cached;
      restored++;
    } else {
      message.reasoning_content = REASONING_PLACEHOLDER;
      placeholder++;
    }
  }

  return { restored, placeholder };
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

function injectThinkEffort(rawBody, pathname, meta) {
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

  // 仅思考模式需要回填：none 模式下上游不做该校验。
  const fixed = thinkEffort === 'none'
    ? { restored: 0, placeholder: 0 }
    : injectMissingReasoning(parsed);

  const notes = [`reasoning_effort=${thinkEffort}`];
  if (fixed.restored) notes.push(`回填思考 ${fixed.restored} 条`);
  if (fixed.placeholder) notes.push(`占位思考 ${fixed.placeholder} 条`);
  console.log(`[proxy] 注入 ${notes.join('，')}`);

  if (meta) {
    meta.model = typeof parsed?.model === 'string' ? parsed.model : undefined;
    meta.messageCount = Array.isArray(parsed?.messages) ? parsed.messages.length : undefined;
    meta.note = notes.join('，');
  }

  const serialized = Buffer.from(JSON.stringify(parsed), 'utf8');
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

function truncateText(text, max) {
  if (typeof text !== 'string') return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

// 上游错误体可能是压缩过的，解压一份副本用于阅读（转发时仍用原始字节）。
function decodePossiblyCompressed(buffer, headers) {
  const encoding = String(headers['content-encoding'] ?? '').toLowerCase();

  try {
    if (encoding.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8');
    if (encoding.includes('br')) return zlib.brotliDecompressSync(buffer).toString('utf8');
    if (encoding.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8');
    if (encoding.includes('zstd') && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buffer).toString('utf8');
    }
  } catch {
    // 解压失败就退回原始字节
  }

  return buffer.toString('utf8');
}

// 从错误响应体里挖出人话。兼容 {error:{message}}、{error:"..."}、{message} 等常见网关形状。
function extractErrorReason(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return truncateText(trimmed, MAX_ERROR_REASON_CHARS);
  }

  const visited = new Set();
  const queue = [json];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);

    for (const key of ERROR_MESSAGE_KEYS) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) {
        return truncateText(value, MAX_ERROR_REASON_CHARS);
      }
    }

    if (typeof node.error === 'string' && node.error.trim()) {
      return truncateText(node.error, MAX_ERROR_REASON_CHARS);
    }

    for (const key of ['error', 'errors', 'details']) {
      const value = node[key];
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === 'object') queue.push(value);
    }
  }

  return truncateText(trimmed, MAX_ERROR_REASON_CHARS);
}

// 错误体是 JSON 但里面没有可读 message 时，补一条，否则客户端拿不到任何原因。
function ensureErrorMessage(text, statusCode) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { text, changed: false };
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { text, changed: false };
  }

  const errorObject = json.error && typeof json.error === 'object' && !Array.isArray(json.error)
    ? json.error
    : json;

  const alreadyReadable = ERROR_MESSAGE_KEYS.some(
    (key) => typeof errorObject[key] === 'string' && errorObject[key].trim(),
  ) || (typeof json.error === 'string' && json.error.trim());

  if (alreadyReadable) {
    return { text, changed: false };
  }

  const statusText = http.STATUS_CODES[statusCode] ?? '';
  errorObject.message = `Upstream returned ${statusCode}${statusText ? ` ${statusText}` : ''} without a message field.`;

  return { text: JSON.stringify(json), changed: true };
}

function relayErrorResponse({ statusCode, responseHeaders, upstreamResponse, response, method, url, requestMeta }) {
  const chunks = [];
  let total = 0;
  let settled = false;

  const statusText = http.STATUS_CODES[statusCode] ?? '';

  const describeRequest = () => {
    if (!requestMeta) return '';
    const bits = [];
    if (requestMeta.model) bits.push(`模型 ${requestMeta.model}`);
    if (requestMeta.messageCount !== undefined) bits.push(`消息 ${requestMeta.messageCount} 条`);
    if (requestMeta.note) bits.push(requestMeta.note);
    return bits.length ? `（${bits.join('，')}）` : '';
  };

  const onOverflow = () => {
    if (settled) return;
    settled = true;

    console.error(
      `[proxy] 上游错误 ${statusCode} ${statusText} ${method} ${url}：响应体超过 ${MAX_ERROR_BODY_BYTES} 字节，原样透传，未解析原因${describeRequest()}`,
    );

    if (response.destroyed) {
      upstreamResponse.resume();
      return;
    }

    // 长度已不可知，去掉 content-length 让 Node 走 chunked。
    const headers = { ...responseHeaders };
    delete headers['content-length'];
    response.writeHead(statusCode, headers);
    for (const chunk of chunks) response.write(chunk);
    upstreamResponse.pipe(response);
    upstreamResponse.resume();
  };

  upstreamResponse.on('data', (chunk) => {
    if (settled) return;
    total += chunk.length;
    if (total > MAX_ERROR_BODY_BYTES) {
      onOverflow();
      return;
    }
    chunks.push(chunk);
  });

  upstreamResponse.on('end', () => {
    if (settled) return;
    settled = true;

    const raw = Buffer.concat(chunks);
    const decoded = raw.length ? decodePossiblyCompressed(raw, responseHeaders) : '';
    const reason = extractErrorReason(decoded);

    console.error(
      `[proxy] 上游错误 ${statusCode} ${statusText} ${method} ${url}：${reason || '上游返回空响应体，无具体原因'}${describeRequest()}`,
    );

    if (response.destroyed || response.writableEnded) return;

    if (raw.length) {
      const headers = { ...responseHeaders, 'content-length': raw.length };
      let body = raw;

      const ensured = ensureErrorMessage(decoded, statusCode);
      if (ensured.changed) {
        body = Buffer.from(ensured.text, 'utf8');
        headers['content-length'] = body.length;
        // 重新序列化成明文，原来的压缩标记必须去掉。
        delete headers['content-encoding'];
        console.log('[proxy] 上游错误体缺少 message 字段，已补上状态说明');
      }

      response.writeHead(statusCode, headers);
      response.end(body);
      return;
    }

    // 上游什么都没给：补一个带原因的 JSON 错误体。
    const body = JSON.stringify({
      error: {
        message: `Upstream returned ${statusCode}${statusText ? ` ${statusText}` : ''} with an empty response body.`,
        type: 'proxy_upstream_error',
        code: 'upstream_error',
        proxy_upstream_status: statusCode,
      },
    });

    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  });

  upstreamResponse.on('error', (error) => {
    if (settled) return;
    settled = true;
    chunks.length = 0;
    console.error(`[proxy] 上游错误 ${statusCode} ${statusText} ${method} ${url}：响应中断 ${error.message}${describeRequest()}`);
    writeProxyError(response, 502, `Upstream connection failed while returning ${statusCode}: ${error.message}`);
  });
}

// 旁路监听响应数据流：不影响原有转发，只在流结束后分析出思考内容与 tool_call id。
function sniffReasoningFromUpstream(upstreamResponse) {
  const chunks = [];
  let total = 0;

  upstreamResponse.on('data', (chunk) => {
    if (total > MAX_RESPONSE_SNIFF_BYTES) return;
    total += chunk.length;
    if (total > MAX_RESPONSE_SNIFF_BYTES) {
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });

  upstreamResponse.on('end', () => {
    if (!chunks.length) return;
    try {
      const { reasoning, toolCallIds } = extractReasoningPayload(Buffer.concat(chunks).toString('utf8'));
      const stored = rememberReasoning(toolCallIds, reasoning);
      if (stored) {
        console.log(`[proxy] 缓存思考内容 ${reasoning.length} 字符 → ${stored} 个 tool_call`);
      }
    } catch (error) {
      console.error(`[proxy] 解析响应思考内容失败: ${error.message}`);
    } finally {
      chunks.length = 0;
    }
  });

  upstreamResponse.on('error', () => {
    chunks.length = 0;
  });
}

function handleRequest(request, response) {
  const targetPath = getUpstreamPath(request.url);
  const target = new URL(targetPath, UPSTREAM_ORIGIN);
  const headers = copyEndToEndHeaders(request.headers);

  headers.host = target.host;
  headers['user-agent'] = USER_AGENT;
  headers['x-opencode-session'] = SESSION_ID;

  // 供错误日志标注"是哪一个请求失败了"，不记录任何消息内容。
  const requestMeta = {};

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
      const methodName = request.method ?? 'UNKNOWN';
      const requestUrl = request.url ?? '/';

      // 4xx/5xx：解析出具体原因，必要时补上说明。
      if (statusCode >= 400) {
        relayErrorResponse({
          statusCode,
          responseHeaders,
          upstreamResponse,
          response,
          method: methodName,
          url: requestUrl,
          requestMeta,
        });
        return;
      }

      // 只嗅探成功的 chat/completions 响应，其余原样透传。
      if (statusCode === 200 && isChatCompletionsPath(target.pathname)) {
        sniffReasoningFromUpstream(upstreamResponse);
      }

      if (!response.destroyed) {
        response.writeHead(statusCode, responseHeaders);
        logRequest(methodName, requestUrl, statusCode);
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
        payload = injectThinkEffort(rawBody, new URL(request.url || '/', 'http://127.0.0.1').pathname, requestMeta);
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
  loadReasoningCache();

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
