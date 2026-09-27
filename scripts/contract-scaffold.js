#!/usr/bin/env node
/**
 * REQ-00315 / REQ-00547：契约草稿生成——扩大 JSON Schema 覆盖面的辅助工具
 *
 * 经网关调用一组接口（多次采样），从真实响应推断 JSON Schema 草稿，写到 docs/api-spec/contracts/drafts/<service>.json。
 * 草稿**不会被网关加载**：人工审阅（收紧类型、补 description、确认必填字段）后移入
 * backend/shared/apiStandards/schemas/<文件>.json，再运行 contract-snapshot --update / generate-api-types / generate-openapi-standards。
 *
 * 用法（需运行中的网关；自动注册测试用户并写入 5 只测试精灵，{{pokemonId}} 会被替换）：
 *   node scripts/contract-scaffold.js --service gym \
 *     --endpoint "gym.nearby GET /v1/gyms/nearby?lat=31.2398&lng=121.5014" \
 *     --endpoint "gym.detail GET /v1/gyms/:id=<gymId>"
 *   --samples 3     每个接口采样次数（合并推断）
 *
 * inferSchema() 为纯函数（单测覆盖）：对象 → properties + 在所有样本中都出现的键为 required；数组合并元素；
 * null 与其它类型合并为 ["type","null"]；字符串识别 uuid / date-time；整数与小数区分。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string / boolean / object
}

/** 从一组样本推断 Schema */
function inferSchema(samples, { depth = 0, maxDepth = 12 } = {}) {
  const vals = samples.filter((v) => v !== undefined);
  if (!vals.length || depth > maxDepth) return {};
  const types = new Set(vals.map(typeOf));
  if (types.has('integer') && types.has('number')) types.delete('integer');
  const nonNull = [...types].filter((t) => t !== 'null');
  const nullable = types.has('null');
  if (nonNull.length !== 1) {
    return nonNull.length ? { type: [...nonNull, ...(nullable ? ['null'] : [])].sort() } : { type: 'null' };
  }
  const t = nonNull[0];
  const withNull = (s) => (nullable ? { ...s, type: [s.type, 'null'] } : s);
  if (t === 'object') {
    const objs = vals.filter((v) => typeOf(v) === 'object');
    const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))].sort();
    const properties = {};
    for (const k of keys) properties[k] = inferSchema(objs.map((o) => o[k]), { depth: depth + 1, maxDepth });
    const required = keys.filter((k) => objs.every((o) => Object.prototype.hasOwnProperty.call(o, k)));
    return withNull({ type: 'object', ...(required.length ? { required } : {}), properties });
  }
  if (t === 'array') {
    const items = vals.filter(Array.isArray).flat();
    return withNull({ type: 'array', ...(items.length ? { items: inferSchema(items, { depth: depth + 1, maxDepth }) } : {}) });
  }
  if (t === 'string') {
    const strs = vals.filter((v) => typeof v === 'string');
    const fmt = strs.every((s) => UUID_RE.test(s)) ? 'uuid' : strs.every((s) => DATE_TIME_RE.test(s)) ? 'date-time' : null;
    return withNull({ type: 'string', ...(fmt ? { format: fmt } : {}) });
  }
  return withNull({ type: t });
}

/** 标准信封：只对 data 推断，外层引用 common#/definitions/SuccessEnvelope */
function contractFromSamples({ id, method, route, service, auth }, bodies) {
  const enveloped = bodies.every((b) => b && typeof b === 'object' && b.code === 0 && Object.prototype.hasOwnProperty.call(b, 'data'));
  const schema = enveloped
    ? { allOf: [{ $ref: 'common#/definitions/SuccessEnvelope' }, { type: 'object', properties: { data: inferSchema(bodies.map((b) => b.data)) } }] }
    : inferSchema(bodies);
  return { id, method, route, service, auth: auth || 'bearer', description: `（草稿，由 contract-scaffold 从 ${bodies.length} 个样本推断，待审阅）`, schema };
}

/** "gym.detail GET /v1/gyms/:id=<gymId>" → { id, method, route, url } */
function parseEndpoint(spec) {
  const m = String(spec).trim().match(/^(\S+)\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
  if (!m) throw new Error(`无法解析 --endpoint "${spec}"，格式：<契约id> <方法> <路径>（路径参数写成 :name=值）`);
  const [pathPart, query] = m[3].split('?');
  const route = pathPart.replace(/:([A-Za-z0-9_]+)=[^/]+/g, ':$1');
  const url = pathPart.replace(/:([A-Za-z0-9_]+)=([^/]+)/g, '$2') + (query ? `?${query}` : '');
  return { id: m[1], method: m[2].toUpperCase(), route, url };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
  const service = get('service');
  const endpoints = args.flatMap((a, i) => (a === '--endpoint' ? [args[i + 1]] : [])).map(parseEndpoint);
  if (!service || !endpoints.length) {
    console.error('用法：node scripts/contract-scaffold.js --service <服务> --endpoint "<id> GET /v1/..." [--endpoint ...] [--samples 3]');
    return 2;
  }
  const samples = Number(get('samples') || 3);
  const T = require('./lib/testUser');
  const redis = T.redisClient();
  await redis.connect();
  const pg = T.pgClient();
  await pg.connect();
  const contracts = [];
  try {
    const user = await T.registerUser(redis, { prefix: 'cs' });
    const ids = await T.seedPokemon(pg, user.userId, 5);
    for (const ep of endpoints) {
      const bodies = [];
      for (let i = 0; i < samples; i++) {
        const r = await T.call(ep.method, ep.url.replace(/\{\{pokemonId\}\}/g, ids[i % ids.length]), { token: user.token, ip: T.randomIp() });
        if (r.status >= 200 && r.status < 300 && r.body) bodies.push(r.body);
        else console.error(`  ${ep.id}: 第 ${i + 1} 次 ${r.status}，已忽略该样本`);
      }
      if (!bodies.length) { console.error(`  ${ep.id}: 没有成功样本，跳过`); continue; }
      contracts.push(contractFromSamples({ ...ep, service }, bodies));
      console.error(`  ${ep.id}: ${bodies.length} 个样本`);
    }
    await pg.query('DELETE FROM pokemon_instances WHERE user_id = $1', [user.userId]).catch(() => {});
  } finally {
    await pg.end();
    await redis.quit();
  }
  const dir = path.join(ROOT, 'docs', 'api-spec', 'contracts', 'drafts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${service}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ service, contracts }, null, 2)}\n`);
  console.log(`已写入 ${path.relative(ROOT, file)}（${contracts.length} 个契约草稿）`);
  return 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }).catch((err) => { console.error(err); process.exitCode = 2; });

module.exports = { inferSchema, contractFromSamples, parseEndpoint };
