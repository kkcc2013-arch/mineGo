#!/usr/bin/env node
/**
 * REQ-00315：从契约 JSON Schema 生成前端 TypeScript 类型
 *
 *   node scripts/generate-api-types.js           写入 frontend/game-client/src/types/api.generated.d.ts
 *   node scripts/generate-api-types.js --check   生成物与契约不一致时退出码 1（CI/单测保持同步）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, loadRegistry, defName, contractTypeName, toTs } = require('./lib/contracts');

const OUT = path.join(ROOT, 'frontend', 'game-client', 'src', 'types', 'api.generated.d.ts');

function render() {
  const reg = loadRegistry();
  const refName = (ref) => defName(ref);
  const lines = [
    '// 自动生成，请勿手改：node scripts/generate-api-types.js',
    '// 来源：backend/shared/apiStandards/schemas/*.json（REQ-00315 契约）',
    '/* eslint-disable */',
    '',
  ];
  const seen = new Set();
  for (const [fileId, file] of [...reg.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [name, schema] of Object.entries(file.definitions || {}).sort((a, b) => a[0].localeCompare(b[0]))) {
      const n = defName(`${fileId}#/definitions/${name}`);
      if (seen.has(n)) continue;
      seen.add(n);
      if (schema.description) lines.push(`/** ${schema.description} */`);
      const body = toTs(schema, { refName });
      const isPlainObject = (schema.type === 'object' || (!schema.type && schema.properties)) && !schema.allOf && !schema.anyOf && !schema.oneOf && body.startsWith('{');
      lines.push(isPlainObject ? `export interface ${n} ${body}` : `export type ${n} = ${body};`, '');
    }
  }
  const index = [];
  for (const c of reg.list().sort((a, b) => a.id.localeCompare(b.id))) {
    const contract = reg.get(c.id);
    const t = contractTypeName(c.id);
    lines.push(`/** ${c.method} ${c.route}${c.description ? ` — ${c.description}` : ''} */`);
    lines.push(`export type ${t}Response = ${toTs(contract.schema, { refName })};`);
    if (contract.requestSchema) lines.push(`export type ${t}Request = ${toTs(contract.requestSchema, { refName })};`);
    lines.push('');
    if (c.route !== '*') index.push(`  ${JSON.stringify(`${c.method} ${c.route}`)}: { response: ${t}Response${contract.requestSchema ? `; request: ${t}Request` : ''} };`);
  }
  lines.push('/** 路由 → 请求/响应类型索引 */', 'export interface ApiContracts {', ...index, '}', '');
  return lines.join('\n');
}

function main() {
  const content = render();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== content) {
      console.error(`${path.relative(ROOT, OUT)} 与契约不同步，请运行 node scripts/generate-api-types.js`);
      return 1;
    }
    console.log('TypeScript 类型与契约同步');
    return 0;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, content);
  console.log(`已生成 ${path.relative(ROOT, OUT)}`);
  return 0;
}

process.exitCode = main();
