#!/usr/bin/env node
/**
 * REQ-00386 / REQ-00315 / REQ-00329：从契约生成 OpenAPI 3.1 文档
 *
 *   node scripts/generate-openapi-standards.js          写入 docs/api-spec/openapi.yaml
 *   node scripts/generate-openapi-standards.js --check  生成物与契约不一致时退出码 1
 *
 * 包含统一响应组件：SuccessResponse / ErrorResponse / PaginatedResponse / Pagination / Links / Meta，
 * 以及所有已登记契约的路径（请求/响应 schema 引用组件）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, loadRegistry, defName, contractTypeName, toOpenApiRefs, toYaml } = require('./lib/contracts');

const OUT = path.join(ROOT, 'docs', 'api-spec', 'openapi.yaml');

function build() {
  const reg = loadRegistry();
  const schemas = {};
  for (const [fileId, file] of [...reg.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const [name, s] of Object.entries(file.definitions || {}).sort((a, b) => a[0].localeCompare(b[0]))) {
      schemas[defName(`${fileId}#/definitions/${name}`)] = toOpenApiRefs(s);
    }
  }
  schemas.SuccessResponse = { description: '统一成功响应（REQ-00386）', allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }] };
  schemas.PaginatedResponse = {
    description: '统一分页响应：pagination 与 meta.pagination 同一对象，_links 含 first/prev/next/last（REQ-00302/465/518）',
    allOf: [{ $ref: '#/components/schemas/SuccessEnvelope' }, { type: 'object', required: ['pagination'], properties: { pagination: { $ref: '#/components/schemas/Pagination' } } }],
  };
  const paths = {};
  for (const c of reg.list().sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method))) {
    if (c.route === '*') continue;
    const contract = reg.get(c.id);
    const t = contractTypeName(c.id);
    schemas[`${t}Response`] = toOpenApiRefs(contract.schema);
    if (contract.requestSchema) schemas[`${t}Request`] = toOpenApiRefs(contract.requestSchema);
    const p = c.route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const params = [...c.route.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const op = {
      operationId: c.id,
      summary: c.description || c.id,
      tags: [c.service],
      ...(params.length ? { parameters: params } : {}),
      ...(c.auth ? { security: [{ bearerAuth: [] }] } : { security: [] }),
      ...(contract.requestSchema && c.method !== 'GET' ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${t}Request` } } } } } : {}),
      responses: {
        200: {
          description: 'OK',
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${t}Response` } },
            'application/x-msgpack': { schema: { $ref: `#/components/schemas/${t}Response` } },
          },
        },
        default: { description: '错误（统一错误格式）', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
    };
    paths[p] = { ...(paths[p] || {}), [c.method.toLowerCase()]: op };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'mineGo API（契约生成）',
      version: '2.0.0',
      description: '由 scripts/generate-openapi-standards.js 从 backend/shared/apiStandards/schemas 生成，请勿手改。\n'
        + '版本协商：/api/vN/ 或 Accept-Version；内容协商：application/json | application/x-msgpack | application/hal+json；'
        + '字段投影：?fields= / ?fieldset=；分页：page/pageSize 或 cursor；错误码目录：GET /api/errors。',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      parameters: {
        Fields: { name: 'fields', in: 'query', schema: { type: 'string' }, description: '字段投影，如 id,cp,moves[].name（最多 50 个）' },
        Fieldset: { name: 'fieldset', in: 'query', schema: { type: 'string' }, description: '预定义字段集（list/detail/battle/social…）' },
        Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        PageSize: { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        Cursor: { name: 'cursor', in: 'query', schema: { type: 'string' } },
        AcceptVersion: { name: 'Accept-Version', in: 'header', schema: { type: 'integer' } },
      },
      schemas,
    },
  };
}

function main() {
  const content = `# 自动生成，请勿手改：node scripts/generate-openapi-standards.js\n${toYaml(build())}\n`;
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== content) {
      console.error(`${path.relative(ROOT, OUT)} 与契约不同步，请运行 node scripts/generate-openapi-standards.js`);
      return 1;
    }
    console.log('OpenAPI 文档与契约同步');
    return 0;
  }
  fs.writeFileSync(OUT, content);
  console.log(`已生成 ${path.relative(ROOT, OUT)}`);
  return 0;
}

process.exitCode = main();
