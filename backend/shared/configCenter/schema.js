// backend/shared/configCenter/schema.js
// E15 配置中心：类型化配置定义、校验、默认值合并、灰度解析、快照差异（纯函数，不依赖 DB/Redis/第三方包）
//
// 定义（def）字段：
//   type: 'number' | 'boolean' | 'string' | 'array' | 'object' | 'json'
//   default: 默认值（必须能通过自身校验，defineConfig 时检查）
//   number:  min / max / integer
//   string:  enum / pattern（RegExp 或字符串）/ minLength / maxLength
//   array:   items（子 def）/ minItems / maxItems
//   object:  properties { name: def } / required [...] / additionalProperties（false | 子 def）
//            对象型配置按属性与默认值深合并（管理员只需提交要改的字段）
//   json:    任意 JSON，maxBytes（默认 64KB）
//   clientVisible: true → 可经 /v1/client-config 下发到游戏客户端（绝不能是敏感配置）
//   secret: true → 敏感配置（加密存储、管理接口只返回掩码）
//   hot: false → 声明该配置需要重启才生效（仅用于提示，默认 true）
'use strict';

const KEY_RE = /^[a-z][a-z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
const SERVICE_RE = /^(\*|[a-z][a-z0-9-]{0,63})$/;
const SECRET_KEY_RE = /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|access[_-]?key|dsn)/i;
const DEFAULT_JSON_MAX_BYTES = 64 * 1024;
const ENVIRONMENTS = ['development', 'test', 'staging', 'production'];

class ConfigValidationError extends Error {
  constructor(key, errors) {
    super(`配置 ${key} 校验失败：${errors.join('；')}`);
    this.name = 'ConfigValidationError';
    this.key = key;
    this.errors = errors;
    this.statusCode = 400;
  }
}

/** 规范化环境名：prod→production、dev→development、stage→staging */
function normalizeEnvironment(name) {
  const v = String(name || '').trim().toLowerCase();
  if (v === 'prod' || v === 'production') return 'production';
  if (v === 'stage' || v === 'staging') return 'staging';
  if (v === 'test' || v === 'testing' || v === 'ci') return 'test';
  if (v === 'dev' || v === 'development' || v === 'local' || v === '') return 'development';
  return null;
}

function currentEnvironment(env = process.env) {
  return normalizeEnvironment(env.CONFIG_ENV || env.NODE_ENV) || 'development';
}

function isValidKey(key) {
  return typeof key === 'string' && key.length <= 200 && KEY_RE.test(key);
}

function isValidService(service) {
  return typeof service === 'string' && SERVICE_RE.test(service);
}

/** 按键名自动识别敏感配置（password / token / apiKey / secret …） */
function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ''));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function jsonBytes(v) {
  try { return Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { return Infinity; }
}

/**
 * 校验并规范化一个值
 * @returns {{ ok: boolean, errors: string[], value: any }}
 */
function validateValue(def, value, path = '$') {
  const errors = [];
  const out = normalizeInner(def || { type: 'json' }, value, path, errors);
  return { ok: errors.length === 0, errors, value: errors.length ? undefined : out };
}

function normalizeInner(def, value, path, errors) {
  const t = def.type || 'json';
  switch (t) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${path} 应为有限数字`); return undefined; }
      if (def.integer && !Number.isInteger(value)) errors.push(`${path} 应为整数`);
      if (def.min !== undefined && value < def.min) errors.push(`${path} 不能小于 ${def.min}`);
      if (def.max !== undefined && value > def.max) errors.push(`${path} 不能大于 ${def.max}`);
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') { errors.push(`${path} 应为布尔值`); return undefined; }
      return value;
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${path} 应为字符串`); return undefined; }
      if (def.enum && !def.enum.includes(value)) errors.push(`${path} 只能是 ${def.enum.join('/')}`);
      if (def.minLength !== undefined && value.length < def.minLength) errors.push(`${path} 长度不能小于 ${def.minLength}`);
      if (value.length > (def.maxLength || 4096)) errors.push(`${path} 长度不能超过 ${def.maxLength || 4096}`);
      if (def.pattern) {
        const re = def.pattern instanceof RegExp ? def.pattern : new RegExp(def.pattern);
        if (!re.test(value)) errors.push(`${path} 格式不正确`);
      }
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path} 应为数组`); return undefined; }
      if (def.minItems !== undefined && value.length < def.minItems) errors.push(`${path} 至少 ${def.minItems} 项`);
      if (def.maxItems !== undefined && value.length > def.maxItems) errors.push(`${path} 最多 ${def.maxItems} 项`);
      return value.map((item, i) => (def.items ? normalizeInner(def.items, item, `${path}[${i}]`, errors) : clone(item)));
    }
    case 'object': {
      if (!isPlainObject(value)) { errors.push(`${path} 应为对象`); return undefined; }
      const props = def.properties || {};
      const base = isPlainObject(def.default) ? def.default : {};
      const out = {};
      for (const [name, sub] of Object.entries(props)) {
        if (value[name] !== undefined) out[name] = normalizeInner(sub, value[name], `${path}.${name}`, errors);
        else if (base[name] !== undefined) out[name] = clone(base[name]);
        else if (sub.default !== undefined) out[name] = clone(sub.default);
        else if ((def.required || []).includes(name)) errors.push(`${path}.${name} 必填`);
      }
      for (const [name, v] of Object.entries(value)) {
        if (props[name]) continue;
        if (def.additionalProperties === false) { errors.push(`${path}.${name} 不是允许的字段`); continue; }
        if (isPlainObject(def.additionalProperties)) {
          // 额外字段：与默认值中的同名项深合并（如 tiers.critical 只改 limit）
          const subDef = { ...def.additionalProperties };
          if (subDef.type === 'object' && isPlainObject(base[name])) subDef.default = base[name];
          out[name] = normalizeInner(subDef, v, `${path}.${name}`, errors);
        } else {
          out[name] = clone(v);
        }
      }
      // 默认值里有、提交值里没有的额外字段（如未提交的 tier）保留默认
      if (def.additionalProperties !== false) {
        for (const [name, v] of Object.entries(base)) {
          if (out[name] === undefined && !props[name]) out[name] = clone(v);
        }
      }
      return out;
    }
    case 'json':
    default: {
      if (value === undefined) { errors.push(`${path} 不能为空`); return undefined; }
      const bytes = jsonBytes(value);
      const max = def.maxBytes || DEFAULT_JSON_MAX_BYTES;
      if (bytes > max) errors.push(`${path} 过大（${bytes} 字节 > ${max}）`);
      return clone(value);
    }
  }
}

/** 配置定义注册表 */
class ConfigRegistry {
  constructor() {
    this.defs = new Map();
  }

  define(key, def) {
    if (!isValidKey(key)) throw new Error(`非法配置键：${key}`);
    if (!def || !def.type) throw new Error(`配置 ${key} 缺少 type`);
    if (def.secret && def.clientVisible) throw new Error(`配置 ${key} 不能同时是敏感配置与客户端可见`);
    if (def.default !== undefined) {
      const r = validateValue(def, def.default, key);
      if (!r.ok) throw new Error(`配置 ${key} 的默认值不合法：${r.errors.join('；')}`);
    }
    this.defs.set(key, Object.freeze({ hot: true, ...def }));
    return this;
  }

  defineAll(map) {
    for (const [k, d] of Object.entries(map)) this.define(k, d);
    return this;
  }

  get(key) { return this.defs.get(key) || null; }
  has(key) { return this.defs.has(key); }
  keys() { return [...this.defs.keys()]; }

  defaults() {
    const out = {};
    for (const [k, d] of this.defs) if (d.default !== undefined) out[k] = clone(d.default);
    return out;
  }

  /** 未注册的键按 json 类型校验（允许管理员新增临时配置） */
  validate(key, value) {
    if (!isValidKey(key)) return { ok: false, errors: [`非法配置键：${key}`], value: undefined };
    return validateValue(this.get(key) || { type: 'json' }, value, key);
  }

  assertValid(key, value) {
    const r = this.validate(key, value);
    if (!r.ok) throw new ConfigValidationError(key, r.errors);
    return r.value;
  }

  isSecret(key) {
    const d = this.get(key);
    if (d && d.secret !== undefined) return !!d.secret;
    return isSecretKey(key);
  }

  isClientVisible(key) {
    const d = this.get(key);
    return !!(d && d.clientVisible && !d.secret);
  }

  describe() {
    return this.keys().sort().map((k) => {
      const d = this.get(k);
      return { key: k, type: d.type, default: d.secret ? undefined : clone(d.default), description: d.description || '',
        clientVisible: !!d.clientVisible, secret: !!d.secret, hot: d.hot !== false };
    });
  }
}

/**
 * 灰度：实例命中 canary_targets（instances / groups / services）时使用 canary_value
 * @param {{ value, canary_value?, canary_targets? }} entry
 * @param {{ instanceId, group, service }} instance
 */
function matchesCanary(targets, instance = {}) {
  if (!isPlainObject(targets)) return false;
  const inList = (list, v) => Array.isArray(list) && v !== undefined && v !== null && list.includes(v);
  return inList(targets.instances, instance.instanceId)
    || inList(targets.groups, instance.group)
    || inList(targets.services, instance.service);
}

function resolveEntry(entry, instance) {
  if (entry && entry.canary_value !== undefined && entry.canary_value !== null && matchesCanary(entry.canary_targets, instance)) {
    return { value: entry.canary_value, canary: true };
  }
  return { value: entry ? entry.value : undefined, canary: false };
}

/**
 * 合并快照：默认值 < 全局（service='*'）< 本服务专属；每层都要通过校验，不合法的值被丢弃并记录
 * @param {ConfigRegistry} registry
 * @param {Array<{key, service, value, canary_value, canary_targets, version}>} rows
 * @param {{ service, instanceId, group }} instance
 * @param {(key, value) => any} [decode] 敏感值解密（返回 undefined 表示无法解密）
 */
function buildSnapshot(registry, rows, instance, decode) {
  const values = registry.defaults();
  const meta = {};
  const rejected = [];
  const ordered = [...(rows || [])].sort((a, b) => (a.service === '*' ? 0 : 1) - (b.service === '*' ? 0 : 1));
  for (const row of ordered) {
    if (row.service !== '*' && row.service !== instance.service) continue;
    const { value: raw, canary } = resolveEntry(row, instance);
    let value = raw;
    if (decode) {
      value = decode(row.key, raw, row);
      if (value === undefined) { rejected.push({ key: row.key, service: row.service, errors: ['无法解密'] }); continue; }
    }
    const r = registry.validate(row.key, value);
    if (!r.ok) { rejected.push({ key: row.key, service: row.service, errors: r.errors }); continue; }
    values[row.key] = r.value;
    meta[row.key] = { service: row.service, version: row.version, canary };
  }
  return { values, meta, rejected };
}

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/** 两个快照之间变化的键（新增/修改/删除） */
function diffValues(prev = {}, next = {}) {
  const changed = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (!deepEqual(prev[k], next[k])) changed.push({ key: k, oldValue: prev[k], newValue: next[k] });
  }
  return changed.sort((x, y) => x.key.localeCompare(y.key));
}

/** 敏感值掩码（管理接口/历史里展示用） */
function maskSecret(value) {
  if (value === undefined || value === null) return value;
  return '******';
}

module.exports = {
  ConfigRegistry,
  ConfigValidationError,
  validateValue,
  normalizeEnvironment,
  currentEnvironment,
  isValidKey,
  isValidService,
  isSecretKey,
  matchesCanary,
  resolveEntry,
  buildSnapshot,
  diffValues,
  deepEqual,
  stableStringify,
  maskSecret,
  ENVIRONMENTS,
};
