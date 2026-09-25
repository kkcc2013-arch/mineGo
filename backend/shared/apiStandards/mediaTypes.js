/**
 * REQ-00368 / REQ-00554: 内容协商与媒体类型管理
 *
 * - parseAccept(): RFC 9110 Accept 解析（q 值、参数、通配符、出现顺序）
 * - MediaTypeRegistry: 注册 / 查询 / 弃用 / 注销媒体类型，每个类型绑定一个序列化器
 * - negotiate(): 按 q 值 → 具体程度 → 服务端优先级 选出最佳类型；
 *     · Accept 缺失 / 空 / 只含通配 → application/json; charset=utf-8
 *     · 只含"已知但未实现"的二进制格式（protobuf）→ 回退 JSON（REQ-00554），标记 fallback
 *     · 只含完全不支持的类型 → notAcceptable（网关返回 406，REQ-00368）
 * - checkContentType(): POST/PUT/PATCH 请求体的 Content-Type 校验（缺失/非法 → 415）
 */
'use strict';

const msgpack = require('./msgpack');

/** 解析单个媒体范围 "type/subtype;a=b;q=0.5" */
function parseMediaRange(part, index) {
  const segs = part.split(';').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return null;
  const full = segs[0].toLowerCase();
  const slash = full.indexOf('/');
  if (slash <= 0 || slash === full.length - 1) return null;
  const type = full.slice(0, slash);
  const subtype = full.slice(slash + 1);
  if (!/^[a-z0-9!#$&^_.+*-]+$/.test(type) || !/^[a-z0-9!#$&^_.+*-]+$/.test(subtype)) return null;
  let q = 1;
  const params = {};
  for (const p of segs.slice(1)) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    const v = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (k === 'q') {
      const n = Number(v);
      q = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
    } else {
      params[k] = v;
    }
  }
  const specificity = type === '*' ? 0 : subtype === '*' ? 1 : 2 + (Object.keys(params).length ? 1 : 0);
  return { type, subtype, full: `${type}/${subtype}`, params, q, specificity, index };
}

function parseAccept(header) {
  if (header === undefined || header === null) return [];
  const raw = Array.isArray(header) ? header.join(',') : String(header);
  const out = [];
  raw.split(',').forEach((part, i) => {
    const r = parseMediaRange(part, i);
    if (r) out.push(r);
  });
  return out.sort((a, b) => (b.q - a.q) || (b.specificity - a.specificity) || (a.index - b.index));
}

// ── 序列化器 ─────────────────────────────────────────────────
const jsonSerializer = {
  name: 'json',
  binary: false,
  serialize: (body) => Buffer.from(JSON.stringify(body), 'utf8'),
  deserialize: (buf) => JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : buf),
};
const msgpackSerializer = {
  name: 'msgpack',
  binary: true,
  serialize: (body) => msgpack.encode(body),
  deserialize: (buf) => msgpack.decode(buf),
};

/** 媒体类型注册表 */
class MediaTypeRegistry {
  constructor() {
    this.types = new Map();
  }

  /**
   * @param {string} mediaType  如 application/json、application/vnd.minego.pokemon.v1+json
   * @param {object} opts { serializer, charset, priority(越大越优先), description, implemented=true, fallback }
   */
  register(mediaType, opts = {}) {
    const key = String(mediaType).toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/.test(key)) throw new Error(`invalid media type: ${mediaType}`);
    const entry = {
      mediaType: key,
      serializer: opts.serializer || jsonSerializer,
      charset: opts.charset === undefined ? (opts.serializer && opts.serializer.binary ? null : 'utf-8') : opts.charset,
      priority: opts.priority || 0,
      description: opts.description || '',
      implemented: opts.implemented !== false,
      fallback: opts.fallback || null,
      deprecated: false,
      deprecatedAt: null,
      replacement: null,
      registeredAt: new Date().toISOString(),
    };
    this.types.set(key, entry);
    return entry;
  }

  unregister(mediaType) { return this.types.delete(String(mediaType).toLowerCase()); }

  get(mediaType) {
    const key = String(mediaType || '').toLowerCase();
    if (this.types.has(key)) return this.types.get(key);
    // application/vnd.minego.<resource>.v<N>+json：按模式匹配到通用厂商类型
    const m = key.match(/^application\/vnd\.minego(?:\.([a-z0-9-]+))?(?:\.v(\d+))?\+json$/);
    if (m && this.types.has('application/vnd.minego+json')) {
      return { ...this.types.get('application/vnd.minego+json'), mediaType: key, resource: m[1] || null, version: m[2] ? Number(m[2]) : null };
    }
    return null;
  }

  deprecate(mediaType, { replacement = null } = {}) {
    const e = this.types.get(String(mediaType).toLowerCase());
    if (!e) return null;
    e.deprecated = true;
    e.deprecatedAt = new Date().toISOString();
    e.replacement = replacement;
    return e;
  }

  list() {
    return [...this.types.values()].map(({ serializer, ...rest }) => ({ ...rest, serializer: serializer.name }));
  }

  /** 所有已实现的类型，按服务端优先级降序 */
  implemented() {
    return [...this.types.values()].filter((e) => e.implemented).sort((a, b) => b.priority - a.priority);
  }
}

function createDefaultRegistry() {
  const r = new MediaTypeRegistry();
  r.register('application/json', { priority: 100, description: '默认 JSON' });
  r.register('application/vnd.minego+json', {
    priority: 50,
    description: 'mineGo 厂商类型，可带资源与版本：application/vnd.minego.pokemon.v1+json',
  });
  r.register('application/hal+json', { priority: 40, description: 'HAL 超媒体（_links/_embedded）' });
  r.register('application/x-msgpack', { serializer: msgpackSerializer, priority: 30, description: 'MessagePack 二进制' });
  r.register('application/msgpack', { serializer: msgpackSerializer, priority: 29, description: 'MessagePack（IANA 名称）' });
  r.register('application/vnd.msgpack', { serializer: msgpackSerializer, priority: 28, description: 'MessagePack（别名）' });
  // 已知但未实现：请求这些类型时回退 JSON 而不是 406（REQ-00554）
  r.register('application/x-protobuf', { implemented: false, fallback: 'application/json', description: 'Protobuf（未实现，回退 JSON）' });
  r.register('application/protobuf', { implemented: false, fallback: 'application/json', description: 'Protobuf（未实现，回退 JSON）' });
  return r;
}

function matches(range, mediaType) {
  const [t, s] = mediaType.split('/');
  if (range.type === '*') return true;
  if (range.type !== t) return false;
  if (range.subtype === '*') return true;
  if (range.subtype === s) return true;
  // application/*+json 形式
  if (range.subtype.startsWith('*+')) return s.endsWith(range.subtype.slice(1));
  return false;
}

/**
 * 协商响应媒体类型
 * @returns {{ mediaType, entry, contentType, fallback, notAcceptable, version, resource, requested }}
 */
function negotiate(acceptHeader, registry, { defaultType = 'application/json' } = {}) {
  const ranges = parseAccept(acceptHeader);
  const def = registry.get(defaultType);
  const build = (entry, extra = {}) => ({
    mediaType: entry.mediaType,
    entry,
    contentType: entry.charset ? `${entry.mediaType}; charset=${entry.charset}` : entry.mediaType,
    fallback: false,
    notAcceptable: false,
    version: entry.version || null,
    resource: entry.resource || null,
    requested: ranges.map((r) => r.full),
    ...extra,
  });
  if (!ranges.length) return build(def);

  const candidates = registry.implemented();
  let sawKnownUnimplemented = null;
  for (const range of ranges) {
    if (range.q === 0) continue;
    // 精确类型（含厂商模式）
    if (range.type !== '*' && range.subtype !== '*' && !range.subtype.startsWith('*+')) {
      const e = registry.get(range.full);
      if (e && e.implemented) {
        // 显式 q=0 排除
        return build(e);
      }
      if (e && !e.implemented) { sawKnownUnimplemented = sawKnownUnimplemented || e; continue; }
      continue;
    }
    // 通配：选服务端优先级最高、且未被 q=0 排除的类型
    const excluded = new Set(ranges.filter((r) => r.q === 0).map((r) => r.full));
    const hit = candidates.find((c) => matches(range, c.mediaType) && !excluded.has(c.mediaType));
    if (hit) return build(hit);
  }
  if (sawKnownUnimplemented) {
    const fb = registry.get(sawKnownUnimplemented.fallback || defaultType) || def;
    return build(fb, { fallback: true, fallbackFrom: sawKnownUnimplemented.mediaType });
  }
  return { ...build(def), notAcceptable: true };
}

// ── Content-Type 校验 ────────────────────────────────────────
const DEFAULT_ALLOWED_REQUEST_TYPES = [
  'application/json',
  'application/*+json',       // application/vnd.minego.*+json、application/merge-patch+json
  'application/csp-report',   // 浏览器 CSP 违规上报
];

function hasBody(req) {
  const te = req.headers['transfer-encoding'];
  const cl = req.headers['content-length'];
  if (te !== undefined) return true;
  if (cl === undefined) return false;
  return Number(cl) > 0;
}

/**
 * @returns {{ ok: true } | { ok: false, reason: 'missing'|'invalid'|'unsupported', contentType }}
 */
function checkContentType(req, { allowed = DEFAULT_ALLOWED_REQUEST_TYPES } = {}) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return { ok: true };
  if (!hasBody(req)) return { ok: true };
  const raw = req.headers['content-type'];
  if (!raw) return { ok: false, reason: 'missing', contentType: null };
  const parsed = parseMediaRange(String(raw), 0);
  if (!parsed || parsed.type === '*' || parsed.subtype === '*') return { ok: false, reason: 'invalid', contentType: String(raw) };
  const cs = parsed.params.charset;
  if (cs && !/^utf-?8$/i.test(cs)) return { ok: false, reason: 'unsupported', contentType: String(raw) };
  const ok = allowed.some((a) => {
    const r = parseMediaRange(a, 0);
    return r && matches(r, parsed.full);
  });
  return ok ? { ok: true, mediaType: parsed.full } : { ok: false, reason: 'unsupported', contentType: String(raw) };
}

module.exports = {
  parseAccept,
  parseMediaRange,
  MediaTypeRegistry,
  createDefaultRegistry,
  negotiate,
  checkContentType,
  hasBody,
  jsonSerializer,
  msgpackSerializer,
  DEFAULT_ALLOWED_REQUEST_TYPES,
};
