/**
 * 契约工具公共函数（scripts/contract-snapshot.js、generate-api-types.js、generate-openapi-standards.js 共用）
 * 只依赖 backend/shared/apiStandards 下的零依赖模块，宿主机与容器都能运行
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { SchemaRegistry } = require(path.join(ROOT, 'backend', 'shared', 'apiStandards', 'schemaRegistry'));
const { toTs, pascal } = require(path.join(ROOT, 'backend', 'shared', 'apiStandards', 'jsonSchema'));

function loadRegistry() {
  return new SchemaRegistry().loadFromDir();
}

/** 定义名（跨文件唯一） */
function defName(ref) {
  const [, frag] = ref.split('#');
  return pascal(frag.split('/').pop());
}

function contractTypeName(id) {
  return pascal(id.replace(/\./g, '-'));
}

/** 把 "file#/definitions/X" 改写成 OpenAPI 组件引用 */
function toOpenApiRefs(node) {
  if (Array.isArray(node)) return node.map(toOpenApiRefs);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string' && v.includes('#/definitions/')) out.$ref = `#/components/schemas/${defName(v)}`;
    else out[k] = toOpenApiRefs(v);
  }
  return out;
}

/** 极简 YAML 输出（字符串统一用 JSON 双引号形式，保证可被任何 YAML 解析器读取） */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const scalar = (v) => (v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((v) => {
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
        const inner = toYaml(v, indent + 2);
        return `${pad}- ${inner.trimStart()}`;
      }
      return `${pad}- ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return keys.map((k) => {
      const v = value[k];
      const key = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(k) ? k : JSON.stringify(k);
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      return `${pad}${key}: ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`;
    }).join('\n');
  }
  return pad + scalar(value);
}

module.exports = { ROOT, loadRegistry, defName, contractTypeName, toOpenApiRefs, toYaml, toTs, pascal };
