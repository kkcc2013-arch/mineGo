// frontend/game-client/src/api/apiStandards.js
// Epic E25 客户端工具（纯逻辑，无 DOM 依赖，可在 Node 单测中加载）：
//   - expandAliasedBody   REQ-00251：还原 ?_aliases=1 压缩的字段名
//   - retryDelay / shouldRetry  REQ-00402：指数退避 + full jitter，优先 Retry-After，仅幂等请求重试
//   - readNdjson          REQ-00526：逐行解析（浏览器已自动解 br/gzip 的）分块 NDJSON 流，可中止
//   - parseLinkHeader / LinkNavigator  REQ-00518：按 _links 导航与执行操作，不硬编码 URL
//   - pageIterator        REQ-00302/465：沿 _links.next 翻页

'use strict';

// ── REQ-00251 别名还原 ──────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function expandKeys(value, aliases) {
  if (Array.isArray(value)) return value.map((x) => expandKeys(x, aliases));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[Object.prototype.hasOwnProperty.call(aliases, k) ? aliases[k] : k] = expandKeys(v, aliases);
  }
  return out;
}

/** 响应体含 _aliases（别名 → 原字段名）时还原 data，并去掉 _aliases；否则原样返回 */
export function expandAliasedBody(body) {
  if (!isPlainObject(body) || !isPlainObject(body._aliases)) return body;
  const { _aliases: aliases, ...rest } = body;
  return { ...rest, data: expandKeys(rest.data, aliases) };
}

// ── REQ-00402 重试策略 ──────────────────────────────────────
const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/**
 * 是否应重试：只有幂等方法（或带幂等键的请求）在网络错误 / 408 / 429 / 502 / 503 / 504 时重试
 * @param {{ method: string, status?: number, error?: Error, attempt: number, maxRetries: number, idempotencyKey?: string }} p
 */
export function shouldRetry({ method, status, error, attempt, maxRetries, idempotencyKey }) {
  if (attempt >= maxRetries) return false;
  if (error && error.name === 'AbortError') return false; // 调用方主动取消
  const idempotent = IDEMPOTENT.has(String(method).toUpperCase()) || !!idempotencyKey;
  if (!idempotent) return false;
  if (error) return error.name === 'TypeError' || error.name === 'TimeoutError'; // fetch 网络错误 / 超时
  return RETRYABLE_STATUS.has(status);
}

/** 解析 Retry-After（秒数或 HTTP 日期）→ 毫秒；无效返回 null */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/**
 * 第 attempt 次重试前的等待：full jitter 指数退避 random(0, min(max, base·2^(attempt-1)))，
 * 服务端给了 Retry-After 时取其值（不超过 max）。random 可注入便于测试。
 */
export function retryDelay(attempt, { base = 300, max = 8000, retryAfter = null, random = Math.random } = {}) {
  const ra = parseRetryAfter(retryAfter);
  if (ra !== null) return Math.min(ra, max);
  const cap = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * cap);
}

/** 可被 AbortSignal 打断的等待 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }, { once: true });
    }
  });
}

// ── REQ-00526 NDJSON 流 ─────────────────────────────────────
/**
 * 逐行读取 NDJSON 响应（Content-Encoding 由浏览器解压，这里拿到的是明文分块）。
 * 跨块的半行会缓存到下一块；空行跳过；以 _summary 为键的行作为汇总返回。
 * @param {Response|{ body: ReadableStream }} response
 * @param {(item: object, index: number) => void} onItem
 * @param {{ signal?: AbortSignal }} opts  中止时取消底层读取、释放连接
 * @returns {Promise<{ count: number, summary: object|null }>}
 */
export async function readNdjson(response, onItem, { signal } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let count = 0;
  let summary = null;
  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) { onAbort(); throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const handle = (line) => {
    const s = line.trim();
    if (!s) return;
    const obj = JSON.parse(s);
    if (obj && obj._summary) { summary = obj._summary; return; }
    if (obj && obj.type === 'summary' && obj.summary) { summary = obj.summary; return; }
    onItem(obj, count++);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) handle(buf);
    if (signal && signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    return { count, summary };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* 已取消 */ }
  }
}

// ── REQ-00518 超媒体导航 ────────────────────────────────────
/** 解析 RFC 8288 Link 头：'<url>; rel="next", <url2>; rel="prev"' → { next: { href }, prev: { href } } */
export function parseLinkHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]*)>\s*((?:;\s*[^;]+)*)/);
    if (!m) continue;
    const rel = (m[2].match(/rel="?([^";]+)"?/) || [])[1];
    if (rel) for (const r of rel.split(/\s+/)) out[r] = { href: m[1] };
  }
  return out;
}

/**
 * 链接导航器：包装带 _links 的资源（或 API 的完整响应体），按 rel 执行操作。
 *   const nav = new LinkNavigator(api, await api.getPokemonDetail(id, { raw: true }));
 *   if (nav.can('evolve')) await nav.follow('evolve');
 * @param {{ requestUrl(method, url, body, opts) }} client  执行请求的客户端（ApiClient）
 */
export class LinkNavigator {
  constructor(client, resource) {
    this.client = client;
    this.resource = resource || {};
    this.links = (resource && (resource._links || (resource.data && resource.data._links))) || {};
  }

  /** 可用操作名列表 */
  rels() { return Object.keys(this.links); }

  can(rel) { return !!(this.links[rel] && this.links[rel].href); }

  link(rel) {
    const l = this.links[rel];
    if (!l || !l.href) throw new Error(`资源没有 "${rel}" 链接（可用：${this.rels().join(', ') || '无'}）`);
    return { href: l.href, method: String(l.method || 'GET').toUpperCase(), title: l.title };
  }

  /** 执行链接：method 取链接声明（缺省 GET），返回下一个资源的导航器 */
  async follow(rel, body, opts = {}) {
    const { href, method } = this.link(rel);
    const next = await this.client.requestUrl(method, href, method === 'GET' ? null : (body || {}), { ...opts, raw: true });
    return new LinkNavigator(this.client, next);
  }

  /** 当前资源数据（完整响应体时取 data） */
  get data() {
    const r = this.resource;
    return r && Object.prototype.hasOwnProperty.call(r, 'data') && Object.prototype.hasOwnProperty.call(r, 'success') ? r.data : r;
  }
}

/** 沿 _links.next 逐页遍历（offset 或 cursor 分页都适用），yield 每页完整响应体 */
export async function* pageIterator(client, firstUrl, { maxPages = 100, signal } = {}) {
  let url = firstUrl;
  for (let i = 0; url && i < maxPages; i++) {
    const page = await client.requestUrl('GET', url, null, { raw: true, signal });
    yield page;
    url = page && page._links && page._links.next ? page._links.next.href : null;
  }
}

/** 把网关返回的根相对 href（/v1/pokemon/my/1、/api/v1/batch）解析为绝对 URL */
export function resolveHref(apiBase, href) {
  if (/^https?:\/\//i.test(href)) return href;
  const origin = /^https?:\/\//i.test(apiBase) ? new URL(apiBase).origin : (typeof location !== 'undefined' ? location.origin : 'http://localhost');
  return origin + (href.startsWith('/') ? href : `/${href}`);
}
