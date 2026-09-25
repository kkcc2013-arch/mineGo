/**
 * REQ-00532 / REQ-00251: 响应字段投影、预定义字段集、别名压缩、扁平化
 *
 * fields 语法：逗号分隔；`.` 表示嵌套对象；`[]` 表示数组元素；括号分组
 *   ?fields=id,name,stats.hp,moves[].name,trainer(id,nickname)
 * 对象数组会逐元素投影；请求的字段不存在时忽略（响应中没有就不输出）。
 * 敏感字段（密码、令牌、密钥、哈希）永远不能被选中。
 */
'use strict';

const MAX_FIELDS_DEFAULT = 50;

/** 永远不返回给客户端的字段（全局剥离，纵深防御） */
const ALWAYS_STRIPPED = new Set(['password', 'password_hash', 'passwordHash', 'pin_hash']);
/** 不允许通过 fields/fieldset 选择的字段（出现时静默丢弃） */
const SENSITIVE_FIELDS = new Set([
  ...ALWAYS_STRIPPED,
  'token', 'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'secret', 'mfa_secret', 'totp_secret',
  'phone_hash', 'phone_encrypted', 'id_card', 'id_card_hash', 'api_key', 'apiKey', 'private_key',
]);

class ProjectionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ProjectionError';
    this.status = 400;
    this.details = details;
  }
}

/** 把 fields 字符串拆成顶层条目（尊重括号） */
function splitTop(str) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) throw new ProjectionError('fields 参数括号不匹配');
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (depth !== 0) throw new ProjectionError('fields 参数括号不匹配');
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/;

/**
 * 解析为字段树：{ key: true | subtree }，subtree 中 `__array` 表示按数组逐项投影
 * @returns {{ tree: object, paths: string[] }}
 */
function parseFields(input, { maxFields = MAX_FIELDS_DEFAULT } = {}) {
  if (input === undefined || input === null || input === '') return null;
  const raw = Array.isArray(input) ? input.join(',') : String(input);
  if (raw.length > 2000) throw new ProjectionError('fields 参数过长');
  const tree = {};
  const paths = [];

  function addPath(path, base) {
    // path 形如 a.b[].c
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) throw new ProjectionError(`非法字段: "${path}"`);
    let node = base;
    parts.forEach((p, i) => {
      const isArr = p.endsWith('[]');
      const name = isArr ? p.slice(0, -2) : p;
      if (!NAME_RE.test(name)) throw new ProjectionError(`非法字段名: "${name}"`);
      const last = i === parts.length - 1;
      if (last) {
        if (node[name] === undefined || node[name] === true) node[name] = true;
      } else {
        if (node[name] === true || node[name] === undefined) node[name] = {};
        node = node[name];
      }
    });
  }

  function walk(str, base, prefix) {
    for (const item of splitTop(str)) {
      const open = item.indexOf('(');
      if (open > 0) {
        if (!item.endsWith(')')) throw new ProjectionError(`非法字段: "${item}"`);
        const head = item.slice(0, open).replace(/\[\]$/, '');
        if (!NAME_RE.test(head)) throw new ProjectionError(`非法字段名: "${head}"`);
        if (base[head] === undefined || base[head] === true) base[head] = {};
        walk(item.slice(open + 1, -1), base[head], `${prefix}${head}.`);
      } else {
        addPath(item, base);
        paths.push(prefix + item.replace(/\[\]/g, ''));
      }
    }
  }
  walk(raw, tree, '');
  if (paths.length > maxFields) {
    throw new ProjectionError(`fields 最多 ${maxFields} 个，实际 ${paths.length}`, { maxFields, requested: paths.length });
  }
  return { tree, paths };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

/** 按字段树投影；数组逐项投影；原始值直接返回 */
function project(value, tree) {
  if (!tree) return value;
  if (Array.isArray(value)) return value.map((v) => project(v, tree));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, sub] of Object.entries(tree)) {
    if (SENSITIVE_FIELDS.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
    out[k] = sub === true ? stripSensitive(value[k], false) : project(value[k], sub);
  }
  return out;
}

/**
 * 移除敏感字段。alwaysOnly=true 时只剥离 ALWAYS_STRIPPED（全局纵深防御），否则剥离所有 SENSITIVE_FIELDS
 * 返回新对象（未命中时返回原引用，避免无谓拷贝）
 */
function stripSensitive(value, alwaysOnly = true, depth = 0) {
  if (depth > 64) return value;
  const set = alwaysOnly ? ALWAYS_STRIPPED : SENSITIVE_FIELDS;
  if (Array.isArray(value)) {
    let changed = false;
    const arr = value.map((v) => { const r = stripSensitive(v, alwaysOnly, depth + 1); if (r !== v) changed = true; return r; });
    return changed ? arr : value;
  }
  if (!isPlainObject(value)) return value;
  let out = null;
  for (const [k, v] of Object.entries(value)) {
    if (set.has(k)) { out = out || { ...value }; delete out[k]; continue; }
    const r = stripSensitive(v, alwaysOnly, depth + 1);
    if (r !== v) { out = out || { ...value }; out[k] = r; }
  }
  return out || value;
}

/** 收集对象（或对象数组）里出现过的全部字段路径，用于"允许字段"提示 */
function collectPaths(value, prefix = '', out = new Set(), depth = 0) {
  if (depth > 4) return out;
  const items = Array.isArray(value) ? value.slice(0, 20) : [value];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      if (SENSITIVE_FIELDS.has(k)) continue;
      const p = prefix + k;
      out.add(p);
      if (isPlainObject(v) || (Array.isArray(v) && v.some(isPlainObject))) collectPaths(v, `${p}.`, out, depth + 1);
    }
  }
  return out;
}

/** 检查请求字段是否都在允许集合内（允许集合为 schema/字段集推导的路径） */
function validateAgainst(paths, allowed) {
  if (!allowed) return [];
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return paths.filter((p) => !set.has(p) && !SENSITIVE_FIELDS.has(p.split('.').pop()));
}

// ── 预定义字段集 ─────────────────────────────────────────────
class FieldsetRegistry {
  constructor() {
    this.sets = new Map(); // resource -> Map(name -> { fields: string[]|null, description, isDefault })
  }
  register(resource, name, fields, { description = '', isDefault = false } = {}) {
    if (!this.sets.has(resource)) this.sets.set(resource, new Map());
    this.sets.get(resource).set(name, { fields: fields ? [...fields] : null, description, isDefault: !!isDefault });
  }
  get(resource, name) {
    const m = this.sets.get(resource);
    return m ? m.get(name) || null : null;
  }
  list(resource) {
    const toObj = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v]));
    if (resource) return this.sets.has(resource) ? toObj(this.sets.get(resource)) : {};
    return Object.fromEntries([...this.sets.entries()].map(([r, m]) => [r, toObj(m)]));
  }
  names(resource) { return this.sets.has(resource) ? [...this.sets.get(resource).keys()] : []; }
}

function createDefaultFieldsets() {
  const f = new FieldsetRegistry();
  // 字段名与 pokemon-service 实际返回一致（下划线命名）
  f.register('pokemon', 'list', ['id', 'species_id', 'nickname', 'cp', 'is_shiny', 'sprite_url', 'name_zh', 'name_en'], { description: '精灵列表最小字段集', isDefault: true });
  f.register('pokemon', 'detail', null, { description: '精灵完整信息' });
  f.register('pokemon', 'battle', ['id', 'species_id', 'nickname', 'cp', 'hp_current', 'hp_max', 'iv_attack', 'iv_defense', 'iv_hp', 'fast_move', 'charge_move', 'type1', 'type2'], { description: '战斗所需字段' });
  f.register('pokemon', 'social', ['id', 'species_id', 'nickname', 'cp', 'is_shiny', 'is_lucky', 'caught_at', 'sprite_url'], { description: '社交展示字段' });
  f.register('species', 'list', ['id', 'name', 'type1', 'type2', 'rarity', 'sprite_url'], { description: '图鉴列表', isDefault: true });
  f.register('user', 'profile', ['id', 'nickname', 'level', 'xp', 'team', 'avatar', 'created_at'], { description: '用户档案', isDefault: true });
  f.register('user', 'minimal', ['id', 'nickname', 'avatar'], { description: '最小用户信息' });
  f.register('gym', 'list', ['id', 'name', 'team', 'lat', 'lng', 'level'], { description: '道馆列表', isDefault: true });
  f.register('gym', 'detail', null, { description: '道馆完整信息' });
  return f;
}

// ── 别名压缩（REQ-00251） ─────────────────────────────────────
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 第 n 个短别名：a..Z（52），aa..ZZ（2704），aaa..（140608）——最多 3 个字符 */
function aliasFor(n) {
  const B = ALPHABET.length;
  if (n < B) return ALPHABET[n];
  n -= B;
  if (n < B * B) return ALPHABET[Math.floor(n / B)] + ALPHABET[n % B];
  n -= B * B;
  if (n < B * B * B) return ALPHABET[Math.floor(n / (B * B))] + ALPHABET[Math.floor(n / B) % B] + ALPHABET[n % B];
  throw new Error('too many distinct keys for alias compression');
}

/**
 * 把对象键替换为 ≤3 字符的短别名；只对长度 > 2 的键建别名，按出现频次分配最短别名。
 * @returns {{ data, aliases: { alias: original } }}
 */
function compressKeys(value) {
  const freq = new Map();
  (function count(v, d) {
    if (d > 64) return;
    if (Array.isArray(v)) { for (const x of v) count(x, d + 1); return; }
    if (!isPlainObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k.length > 2) freq.set(k, (freq.get(k) || 0) + 1);
      count(x, d + 1);
    }
  })(value, 0);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const map = new Map();
  const aliases = {};
  const reserved = new Set();
  // 避免别名与原有短键（≤2 字符）冲突
  (function collectShort(v, d) {
    if (d > 64) return;
    if (Array.isArray(v)) { for (const x of v) collectShort(x, d + 1); return; }
    if (!isPlainObject(v)) return;
    for (const [k, x] of Object.entries(v)) { if (k.length <= 2) reserved.add(k); collectShort(x, d + 1); }
  })(value, 0);
  let n = 0;
  for (const [k] of sorted) {
    let a;
    do { a = aliasFor(n++); } while (reserved.has(a));
    map.set(k, a);
    aliases[a] = k;
  }
  function rewrite(v, d) {
    if (d > 64) return v;
    if (Array.isArray(v)) return v.map((x) => rewrite(x, d + 1));
    if (!isPlainObject(v)) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[map.get(k) || k] = rewrite(x, d + 1);
    return o;
  }
  return { data: rewrite(value, 0), aliases };
}

function expandKeys(value, aliases) {
  if (Array.isArray(value)) return value.map((x) => expandKeys(x, aliases));
  if (!isPlainObject(value)) return value;
  const o = {};
  for (const [k, x] of Object.entries(value)) o[Object.prototype.hasOwnProperty.call(aliases, k) ? aliases[k] : k] = expandKeys(x, aliases);
  return o;
}

/** 压缩包装格式：{ "$a": 别名表, "$d": 数据 }，客户端 expandPayload() 还原 */
function packAliased(body) {
  const { data, aliases } = compressKeys(body);
  return { $a: aliases, $d: data };
}
function expandPayload(packed) {
  if (!isPlainObject(packed) || !packed.$a || !Object.prototype.hasOwnProperty.call(packed, '$d')) return packed;
  return expandKeys(packed.$d, packed.$a);
}

// ── 扁平化（减少嵌套层级） ─────────────────────────────────────
function flatten(value, { sep = '.', maxDepth = 8 } = {}) {
  if (Array.isArray(value)) return value.map((v) => flatten(v, { sep, maxDepth }));
  if (!isPlainObject(value)) return value;
  const out = {};
  (function walk(obj, prefix, d) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}${sep}${k}` : k;
      if (isPlainObject(v) && d < maxDepth && Object.keys(v).length) walk(v, key, d + 1);
      else out[key] = Array.isArray(v) ? v.map((x) => flatten(x, { sep, maxDepth })) : v;
    }
  })(value, '', 0);
  return out;
}

function unflatten(value, { sep = '.' } = {}) {
  if (Array.isArray(value)) return value.map((v) => unflatten(v, { sep }));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const parts = k.split(sep);
    let node = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = Array.isArray(v) ? v.map((x) => unflatten(x, { sep })) : v;
      else { node[p] = isPlainObject(node[p]) ? node[p] : {}; node = node[p]; }
    });
  }
  return out;
}

// ── 数据库层投影（REQ-00532：只查询需要的列） ────────────────────
/**
 * 根据 ?fields= / ?fieldset= 计算 SELECT 列表。columnMap：{ 字段名: 'SQL 表达式' }（表达式需自带 AS 别名）。
 * 参数缺失、非法（交给网关返回 400）或字段集为"完整字段"时返回全部列。
 * @returns {{ columns: string[], projected: boolean, fields: string[] }}
 */
function sqlColumns(query = {}, columnMap = {}, { always = ['id'], resource = null, fieldsets = null, maxFields = MAX_FIELDS_DEFAULT } = {}) {
  const all = { columns: Object.values(columnMap), projected: false, fields: Object.keys(columnMap) };
  let names = null;
  try {
    if (query.fields) {
      const parsed = parseFields(String(query.fields), { maxFields });
      names = parsed ? Object.keys(parsed.tree) : null;
    } else if (query.fieldset && fieldsets && resource) {
      const set = fieldsets.get(resource, String(query.fieldset));
      names = set && Array.isArray(set.fields) ? set.fields.map((f) => f.split(/[.[]/)[0]) : null;
    }
  } catch {
    names = null;
  }
  if (!names) return all;
  const keep = [...new Set([...always, ...names])].filter((n) => Object.prototype.hasOwnProperty.call(columnMap, n) && !SENSITIVE_FIELDS.has(n));
  return { columns: keep.map((n) => columnMap[n]), projected: true, fields: keep };
}

module.exports = {
  sqlColumns,
  MAX_FIELDS_DEFAULT,
  ALWAYS_STRIPPED,
  SENSITIVE_FIELDS,
  ProjectionError,
  parseFields,
  project,
  stripSensitive,
  collectPaths,
  validateAgainst,
  FieldsetRegistry,
  createDefaultFieldsets,
  aliasFor,
  compressKeys,
  expandKeys,
  packAliased,
  expandPayload,
  flatten,
  unflatten,
  isPlainObject,
};
