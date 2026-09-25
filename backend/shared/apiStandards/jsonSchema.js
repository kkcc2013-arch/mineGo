/**
 * REQ-00315 / REQ-00547: JSON Schema 校验（draft-07 常用子集，零依赖）+ Mock 生成 + TypeScript 类型生成
 *
 * 支持：type（含数组/integer/null）、nullable（OpenAPI）、enum、const、required、properties、
 *       additionalProperties(bool|schema)、items、minItems/maxItems、minLength/maxLength、pattern、
 *       minimum/maximum/exclusiveMinimum/exclusiveMaximum、format(date-time|date|uuid|email|uri)、
 *       oneOf/anyOf/allOf/not、$ref（#/definitions/x、#/$defs/x、外部注册名 "name" / "name#/definitions/x"）
 * 错误上限 50 条，路径格式 $.data.items[0].id
 */
'use strict';

const FORMATS = {
  'date-time': (s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/'),
  'uri-reference': () => true,
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

class Validator {
  /** @param {object} opts { resolveExternal(name) → schema, maxErrors } */
  constructor({ resolveExternal = () => null, maxErrors = 50 } = {}) {
    this.resolveExternal = resolveExternal;
    this.maxErrors = maxErrors;
  }

  resolveRef(ref, root) {
    if (ref.startsWith('#')) {
      const parts = ref.slice(2).split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      let node = root;
      for (const p of parts) node = node ? node[p] : undefined;
      return node ? { schema: node, root } : null;
    }
    const [name, frag] = ref.split('#');
    const ext = this.resolveExternal(name);
    if (!ext) return null;
    return frag ? this.resolveRef(`#${frag}`, ext) : { schema: ext, root: ext };
  }

  validate(schema, data) {
    const errors = [];
    this._v(schema, data, '$', schema, errors, 0);
    return { valid: errors.length === 0, errors };
  }

  _err(errors, path, message, keyword) {
    if (errors.length < this.maxErrors) errors.push({ path, message, keyword });
  }

  _v(schema, data, path, root, errors, depth) {
    if (errors.length >= this.maxErrors) return;
    if (schema === true || schema === undefined || schema === null) return;
    if (schema === false) { this._err(errors, path, '不允许任何值', 'false'); return; }
    if (depth > 64) return;

    if (schema.$ref) {
      const r = this.resolveRef(schema.$ref, root);
      if (!r) { this._err(errors, path, `无法解析 $ref ${schema.$ref}`, '$ref'); return; }
      this._v(r.schema, data, path, r.root, errors, depth + 1);
      return;
    }

    const t = typeOf(data);
    if (data === null && schema.nullable === true) return;
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((x) => typeMatches(x, t))) {
        this._err(errors, path, `类型应为 ${types.join('|')}，实际为 ${t}`, 'type');
        return;
      }
    }
    if (schema.const !== undefined && !deepEqual(schema.const, data)) this._err(errors, path, `应等于 ${JSON.stringify(schema.const)}`, 'const');
    if (schema.enum && !schema.enum.some((e) => deepEqual(e, data))) this._err(errors, path, `应为枚举值之一：${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`, 'enum');

    if (t === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) this._err(errors, path, `长度应 >= ${schema.minLength}`, 'minLength');
      if (schema.maxLength !== undefined && data.length > schema.maxLength) this._err(errors, path, `长度应 <= ${schema.maxLength}`, 'maxLength');
      if (schema.pattern && !new RegExp(schema.pattern).test(data)) this._err(errors, path, `应匹配 ${schema.pattern}`, 'pattern');
      if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](data)) this._err(errors, path, `格式应为 ${schema.format}`, 'format');
    }
    if (t === 'number' || t === 'integer') {
      if (schema.minimum !== undefined && data < schema.minimum) this._err(errors, path, `应 >= ${schema.minimum}`, 'minimum');
      if (schema.maximum !== undefined && data > schema.maximum) this._err(errors, path, `应 <= ${schema.maximum}`, 'maximum');
      if (typeof schema.exclusiveMinimum === 'number' && data <= schema.exclusiveMinimum) this._err(errors, path, `应 > ${schema.exclusiveMinimum}`, 'exclusiveMinimum');
      if (typeof schema.exclusiveMaximum === 'number' && data >= schema.exclusiveMaximum) this._err(errors, path, `应 < ${schema.exclusiveMaximum}`, 'exclusiveMaximum');
    }
    if (t === 'array') {
      if (schema.minItems !== undefined && data.length < schema.minItems) this._err(errors, path, `元素数应 >= ${schema.minItems}`, 'minItems');
      if (schema.maxItems !== undefined && data.length > schema.maxItems) this._err(errors, path, `元素数应 <= ${schema.maxItems}`, 'maxItems');
      if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
        // 大数组只抽样校验前 200 个元素，保证 < 5ms 的开销目标
        const n = Math.min(data.length, 200);
        for (let i = 0; i < n; i++) this._v(schema.items, data[i], `${path}[${i}]`, root, errors, depth + 1);
      }
    }
    if (t === 'object') {
      const props = schema.properties || {};
      for (const req of schema.required || []) {
        if (data[req] === undefined) this._err(errors, `${path}.${req}`, '缺少必填字段', 'required');
      }
      for (const [k, sub] of Object.entries(props)) {
        if (data[k] !== undefined) this._v(sub, data[k], `${path}.${k}`, root, errors, depth + 1);
      }
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        for (const k of Object.keys(data)) {
          if (props[k] !== undefined) continue;
          if (schema.additionalProperties === false) this._err(errors, `${path}.${k}`, '不允许的额外字段', 'additionalProperties');
          else this._v(schema.additionalProperties, data[k], `${path}.${k}`, root, errors, depth + 1);
        }
      }
    }
    if (schema.allOf) for (const s of schema.allOf) this._v(s, data, path, root, errors, depth + 1);
    if (schema.anyOf) {
      const ok = schema.anyOf.some((s) => { const e = []; this._v(s, data, path, root, e, depth + 1); return e.length === 0; });
      if (!ok) this._err(errors, path, '不满足 anyOf 中任何一个', 'anyOf');
    }
    if (schema.oneOf) {
      const n = schema.oneOf.filter((s) => { const e = []; this._v(s, data, path, root, e, depth + 1); return e.length === 0; }).length;
      if (n !== 1) this._err(errors, path, `应恰好满足 oneOf 中一个（实际 ${n} 个）`, 'oneOf');
    }
    if (schema.not) {
      const e = [];
      this._v(schema.not, data, path, root, e, depth + 1);
      if (e.length === 0) this._err(errors, path, '不应满足 not 子模式', 'not');
    }
  }
}

// ── Mock 数据生成 ────────────────────────────────────────────
function mockFromSchema(schema, { resolveExternal = () => null, root = schema, depth = 0, seed = 1 } = {}) {
  if (!schema || depth > 12) return null;
  if (schema.$ref) {
    const v = new Validator({ resolveExternal });
    const r = v.resolveRef(schema.$ref, root);
    return r ? mockFromSchema(r.schema, { resolveExternal, root: r.root, depth: depth + 1, seed }) : null;
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.examples && schema.examples.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => mockFromSchema(s, { resolveExternal, root, depth: depth + 1, seed })));
  if (schema.oneOf || schema.anyOf) return mockFromSchema((schema.oneOf || schema.anyOf)[0], { resolveExternal, root, depth: depth + 1, seed });
  let type = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') || 'null' : schema.type;
  if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'null': return null;
    case 'boolean': return true;
    case 'integer': return Math.max(schema.minimum ?? 1, Math.min(schema.maximum ?? 1, 1));
    case 'number': return schema.minimum ?? 1.5;
    case 'string': {
      if (schema.format === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000001';
      if (schema.format === 'email') return 'mock@example.com';
      if (schema.format === 'uri') return '/mock';
      let s = 'mock-string';
      if (schema.pattern) {
        const re = new RegExp(schema.pattern);
        s = ['MOCK_VALUE', 'mock', 'a', '1', 'mock-string', '/mock'].find((x) => re.test(x)) || s;
      }
      return schema.minLength && s.length < schema.minLength ? s.padEnd(schema.minLength, 'x') : s.slice(0, schema.maxLength || s.length);
    }
    case 'array': {
      const n = Math.max(schema.minItems || 1, 1);
      return Array.from({ length: n }, () => mockFromSchema(schema.items || {}, { resolveExternal, root, depth: depth + 1, seed }));
    }
    case 'object': {
      const o = {};
      for (const [k, s] of Object.entries(schema.properties || {})) o[k] = mockFromSchema(s, { resolveExternal, root, depth: depth + 1, seed });
      for (const k of schema.required || []) if (o[k] === undefined) o[k] = 'mock';
      return o;
    }
    default: return null;
  }
}

// ── TypeScript 类型生成 ─────────────────────────────────────
function pascal(s) {
  return String(s).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase());
}

function toTs(schema, { root = schema, indent = '', refName = (r) => pascal(r.split('/').pop()) } = {}) {
  if (!schema || schema === true) return 'unknown';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((e) => JSON.stringify(e)).join(' | ');
  if (schema.oneOf || schema.anyOf) return (schema.oneOf || schema.anyOf).map((s) => toTs(s, { root, indent, refName })).join(' | ');
  if (schema.allOf) return schema.allOf.map((s) => toTs(s, { root, indent, refName })).join(' & ');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type || (schema.properties ? 'object' : schema.items ? 'array' : 'unknown')];
  const parts = types.map((t) => {
    switch (t) {
      case 'string': return 'string';
      case 'integer': case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'array': {
        const inner = toTs(schema.items || {}, { root, indent, refName });
        return /[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
      }
      case 'object': {
        const props = schema.properties || {};
        const req = new Set(schema.required || []);
        const lines = Object.entries(props).map(([k, s]) => {
          const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
          const doc = s && s.description ? `${indent}  /** ${s.description} */\n` : '';
          return `${doc}${indent}  ${key}${req.has(k) ? '' : '?'}: ${toTs(s, { root, indent: `${indent}  `, refName })};`;
        });
        if (schema.additionalProperties !== false) lines.push(`${indent}  [key: string]: unknown;`);
        return `{\n${lines.join('\n')}\n${indent}}`;
      }
      default: return 'unknown';
    }
  });
  let out = parts.join(' | ');
  if (schema.nullable) out += ' | null';
  return out;
}

module.exports = { Validator, mockFromSchema, toTs, pascal, typeOf, deepEqual, FORMATS };
