/**
 * REQ-00520 / REQ-00547 / REQ-00315: API 兼容性检测引擎（破坏性变更识别 + 迁移建议）
 *
 * 输入可以是两份 OpenAPI 3 文档（detectOpenApiChanges），也可以是两份"契约快照"
 * （{ contractId: { method, route, schema, requestSchema?, auth? } }，detectContractChanges）。
 *
 * 破坏性变更类型（7 类）与严重级别：
 *   ENDPOINT_REMOVED           CRITICAL  删除端点
 *   METHOD_CHANGED             CRITICAL  同一路径的 HTTP 方法被替换
 *   REQUIRED_FIELD_REMOVED     CRITICAL  删除必填响应字段（或字段由必填变为缺失）
 *   FIELD_TYPE_CHANGED         HIGH      字段类型变化（string → number 等）
 *   REQUIRED_REQUEST_FIELD_ADDED HIGH    新增必填请求字段
 *   AUTH_CHANGED               HIGH      认证要求变化（新增鉴权）
 *   OPTIONAL_FIELD_REMOVED     MEDIUM    删除可选响应字段
 * 非破坏性：ENUM_VALUE_REMOVED/CONSTRAINT_TIGHTENED（MEDIUM），FIELD_ADDED/ENDPOINT_ADDED/DESCRIPTION_CHANGED（LOW）
 */
'use strict';

const SEVERITY = { CRITICAL: 'P0', HIGH: 'P1', MEDIUM: 'P2', LOW: 'P3' };
const CHANGE_TYPES = {
  ENDPOINT_REMOVED: { severity: 'CRITICAL', breaking: true },
  METHOD_CHANGED: { severity: 'CRITICAL', breaking: true },
  REQUIRED_FIELD_REMOVED: { severity: 'CRITICAL', breaking: true },
  FIELD_TYPE_CHANGED: { severity: 'HIGH', breaking: true },
  REQUIRED_REQUEST_FIELD_ADDED: { severity: 'HIGH', breaking: true },
  AUTH_CHANGED: { severity: 'HIGH', breaking: true },
  OPTIONAL_FIELD_REMOVED: { severity: 'MEDIUM', breaking: true },
  ENUM_VALUE_REMOVED: { severity: 'MEDIUM', breaking: true },
  CONSTRAINT_TIGHTENED: { severity: 'MEDIUM', breaking: false },
  FIELD_ADDED: { severity: 'LOW', breaking: false },
  ENDPOINT_ADDED: { severity: 'LOW', breaking: false },
  DESCRIPTION_CHANGED: { severity: 'LOW', breaking: false },
};

function change(type, where, detail = {}) {
  const t = CHANGE_TYPES[type];
  return { type, severity: t.severity, priority: SEVERITY[t.severity], breaking: t.breaking, ...where, ...detail };
}

function norm(schema, resolve, depth = 0) {
  if (!schema || depth > 20) return schema || {};
  if (schema.$ref && resolve) {
    const r = resolve(schema.$ref);
    if (r) return norm(r, resolve, depth + 1);
  }
  if (schema.allOf) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const s of schema.allOf) {
      const n = norm(s, resolve, depth + 1);
      Object.assign(merged.properties, n.properties || {});
      merged.required.push(...(n.required || []));
      if (n.type && n.type !== 'object') merged.type = n.type;
    }
    return merged;
  }
  return schema;
}

function typesOf(s) {
  if (!s) return [];
  if (s.type) {
    const t = Array.isArray(s.type) ? [...s.type] : [s.type];
    if (s.nullable) t.push('null');
    return t.map((x) => (x === 'integer' ? 'number' : x)).sort();
  }
  if (s.properties) return ['object'];
  if (s.items) return ['array'];
  return [];
}

/**
 * 对比两份 JSON Schema（响应方向：旧 → 新，删除/收窄为破坏）
 * @param {string} direction 'response' | 'request'
 */
function diffSchemas(oldS, newS, { path = '$', where = {}, direction = 'response', resolveOld, resolveNew, out = [], depth = 0 } = {}) {
  if (depth > 20) return out;
  const o = norm(oldS, resolveOld);
  const n = norm(newS, resolveNew);
  const ot = typesOf(o), nt = typesOf(n);
  if (ot.length && nt.length) {
    const lost = direction === 'response'
      ? ot.filter((t) => !nt.includes(t) && t !== 'null') // 响应：新类型不再覆盖旧类型
      : nt.filter((t) => !ot.includes(t) && t !== 'null'); // 请求：新类型要求旧客户端没发过的类型
    const gainedInResponse = direction === 'response' ? nt.filter((t) => !ot.includes(t) && t !== 'null') : [];
    if (lost.length || gainedInResponse.length) {
      out.push(change('FIELD_TYPE_CHANGED', where, { path, from: ot.join('|'), to: nt.join('|') }));
      return out;
    }
  }
  if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
    const removed = o.enum.filter((v) => !n.enum.includes(v));
    const added = n.enum.filter((v) => !o.enum.includes(v));
    if (direction === 'request' && removed.length) out.push(change('ENUM_VALUE_REMOVED', where, { path, values: removed }));
    if (direction === 'response' && added.length) out.push(change('ENUM_VALUE_REMOVED', where, { path, values: added, note: '响应出现旧客户端未知的枚举值' }));
  }
  if (direction === 'request') {
    for (const k of ['maxLength', 'maximum', 'maxItems']) if (n[k] !== undefined && (o[k] === undefined || n[k] < o[k])) out.push(change('CONSTRAINT_TIGHTENED', where, { path, keyword: k, from: o[k], to: n[k] }));
    for (const k of ['minLength', 'minimum', 'minItems']) if (n[k] !== undefined && (o[k] === undefined || n[k] > o[k])) out.push(change('CONSTRAINT_TIGHTENED', where, { path, keyword: k, from: o[k], to: n[k] }));
  }
  if (o.description !== n.description && o.description && n.description) out.push(change('DESCRIPTION_CHANGED', where, { path }));

  const op = o.properties || {}, np = n.properties || {};
  const oreq = new Set(o.required || []), nreq = new Set(n.required || []);
  for (const k of Object.keys(op)) {
    const p = `${path}.${k}`;
    if (!(k in np)) {
      if (direction === 'response') out.push(change(oreq.has(k) ? 'REQUIRED_FIELD_REMOVED' : 'OPTIONAL_FIELD_REMOVED', where, { path: p }));
      continue;
    }
    if (direction === 'response' && oreq.has(k) && !nreq.has(k)) out.push(change('REQUIRED_FIELD_REMOVED', where, { path: p, note: '字段由必填变为可选' }));
    diffSchemas(op[k], np[k], { path: p, where, direction, resolveOld, resolveNew, out, depth: depth + 1 });
  }
  for (const k of Object.keys(np)) {
    if (k in op) continue;
    const p = `${path}.${k}`;
    if (direction === 'request' && nreq.has(k)) out.push(change('REQUIRED_REQUEST_FIELD_ADDED', where, { path: p }));
    else out.push(change('FIELD_ADDED', where, { path: p }));
  }
  if (direction === 'request') {
    for (const k of nreq) if (!oreq.has(k) && k in op) out.push(change('REQUIRED_REQUEST_FIELD_ADDED', where, { path: `${path}.${k}`, note: '可选字段变为必填' }));
  }
  if (o.items && n.items) diffSchemas(o.items, n.items, { path: `${path}[]`, where, direction, resolveOld, resolveNew, out, depth: depth + 1 });
  return out;
}

function summarize(changes) {
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of changes) bySeverity[c.severity]++;
  const breaking = changes.filter((c) => c.breaking);
  return { total: changes.length, breaking: breaking.length, bySeverity, compatible: breaking.length === 0, blocking: breaking.some((c) => c.severity === 'CRITICAL') };
}

/** 契约快照对比 */
function detectContractChanges(oldSnap, newSnap, { resolveOld, resolveNew } = {}) {
  const changes = [];
  const byRoute = (snap) => {
    const m = new Map();
    for (const [id, c] of Object.entries(snap)) m.set(c.route, [...(m.get(c.route) || []), { id, ...c }]);
    return m;
  };
  const oldRoutes = byRoute(oldSnap), newRoutes = byRoute(newSnap);
  for (const [id, oc] of Object.entries(oldSnap)) {
    const where = { contract: id, method: oc.method, route: oc.route };
    const nc = newSnap[id];
    if (!nc) {
      const sameRoute = newRoutes.get(oc.route) || [];
      if (sameRoute.length && !sameRoute.some((x) => x.method === oc.method)) changes.push(change('METHOD_CHANGED', where, { from: oc.method, to: sameRoute.map((x) => x.method).join(',') }));
      else changes.push(change('ENDPOINT_REMOVED', where));
      continue;
    }
    if (nc.method !== oc.method) changes.push(change('METHOD_CHANGED', where, { from: oc.method, to: nc.method }));
    if (!oc.auth && nc.auth) changes.push(change('AUTH_CHANGED', where, { from: 'none', to: nc.auth }));
    diffSchemas(oc.schema, nc.schema, { where, direction: 'response', resolveOld, resolveNew, out: changes });
    if (oc.requestSchema || nc.requestSchema) diffSchemas(oc.requestSchema || {}, nc.requestSchema || {}, { path: '$request', where, direction: 'request', resolveOld, resolveNew, out: changes });
  }
  for (const [id, nc] of Object.entries(newSnap)) {
    if (!oldSnap[id] && !(oldRoutes.get(nc.route) || []).some((x) => x.method === nc.method)) changes.push(change('ENDPOINT_ADDED', { contract: id, method: nc.method, route: nc.route }));
  }
  return { changes, summary: summarize(changes) };
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

function openApiResolver(doc) {
  return (ref) => {
    if (!ref || !ref.startsWith('#/')) return null;
    return ref.slice(2).split('/').reduce((n, k) => (n ? n[k] : undefined), doc) || null;
  };
}

function successSchema(op) {
  const rs = op.responses || {};
  const key = Object.keys(rs).find((k) => /^2\d\d$/.test(k)) || 'default';
  const r = rs[key];
  if (!r) return null;
  const content = r.content || {};
  const ct = content['application/json'] || Object.values(content)[0];
  return ct ? ct.schema : r.schema || null;
}

function requestSchema(op) {
  const rb = op.requestBody;
  const params = op.parameters || [];
  const s = { type: 'object', properties: {}, required: [] };
  for (const p of params) {
    if (!p || !p.name) continue;
    s.properties[`${p.in}:${p.name}`] = p.schema || {};
    if (p.required) s.required.push(`${p.in}:${p.name}`);
  }
  if (rb && rb.content) {
    const ct = rb.content['application/json'] || Object.values(rb.content)[0];
    if (ct && ct.schema) { s.properties.body = ct.schema; if (rb.required) s.required.push('body'); }
  }
  return s;
}

/** 对比两份 OpenAPI 文档 */
function detectOpenApiChanges(oldDoc, newDoc) {
  const changes = [];
  const ro = openApiResolver(oldDoc), rn = openApiResolver(newDoc);
  const op = oldDoc.paths || {}, np = newDoc.paths || {};
  const globalAuthOld = !!(oldDoc.security && oldDoc.security.length);
  const globalAuthNew = !!(newDoc.security && newDoc.security.length);
  for (const [path, item] of Object.entries(op)) {
    const nitem = np[path];
    const oldMethods = METHODS.filter((m) => item[m]);
    if (!nitem) {
      for (const m of oldMethods) changes.push(change('ENDPOINT_REMOVED', { method: m.toUpperCase(), route: path }));
      continue;
    }
    const newMethods = METHODS.filter((m) => nitem[m]);
    for (const m of oldMethods) {
      const where = { method: m.toUpperCase(), route: path };
      if (!nitem[m]) {
        if (newMethods.length && !newMethods.some((x) => oldMethods.includes(x))) changes.push(change('METHOD_CHANGED', where, { from: m.toUpperCase(), to: newMethods.join(',').toUpperCase() }));
        else changes.push(change('ENDPOINT_REMOVED', where));
        continue;
      }
      const oa = item[m].security !== undefined ? item[m].security.length > 0 : globalAuthOld;
      const na = nitem[m].security !== undefined ? nitem[m].security.length > 0 : globalAuthNew;
      if (!oa && na) changes.push(change('AUTH_CHANGED', where, { from: 'none', to: 'required' }));
      diffSchemas(successSchema(item[m]) || {}, successSchema(nitem[m]) || {}, { where, direction: 'response', resolveOld: ro, resolveNew: rn, out: changes });
      diffSchemas(requestSchema(item[m]), requestSchema(nitem[m]), { path: '$request', where, direction: 'request', resolveOld: ro, resolveNew: rn, out: changes });
    }
    for (const m of newMethods) if (!item[m] && !(oldMethods.length && !newMethods.some((x) => oldMethods.includes(x)))) changes.push(change('ENDPOINT_ADDED', { method: m.toUpperCase(), route: path }));
  }
  for (const [path, item] of Object.entries(np)) {
    if (op[path]) continue;
    for (const m of METHODS.filter((x) => item[x])) changes.push(change('ENDPOINT_ADDED', { method: m.toUpperCase(), route: path }));
  }
  return { changes, summary: summarize(changes) };
}

const ADVICE = {
  ENDPOINT_REMOVED: '先登记弃用（/api/admin/deprecations），保留旧端点直到 Sunset 日期，并提供 successor-version 链接',
  METHOD_CHANGED: '同时保留旧方法作为兼容别名，旧方法登记弃用',
  REQUIRED_FIELD_REMOVED: '恢复该字段（可置为默认值），或在新版本（/api/vN+1）中移除并通过版本转换规则为旧版本补回',
  FIELD_TYPE_CHANGED: '新增一个新名称的字段承载新类型，旧字段保持原类型直到旧版本下线',
  REQUIRED_REQUEST_FIELD_ADDED: '把新字段改为可选并提供服务端默认值，或通过请求转换规则为旧版本客户端补默认值',
  AUTH_CHANGED: '提前公告，新鉴权要求只在新版本启用',
  OPTIONAL_FIELD_REMOVED: '确认主要客户端未使用该字段（字段使用统计），否则保留一个版本周期',
  ENUM_VALUE_REMOVED: '客户端需对未知枚举值容错；服务端新增枚举值前先发布兼容客户端',
  CONSTRAINT_TIGHTENED: '对存量数据做校验，必要时放宽约束',
};

/** 生成迁移建议（Markdown） */
function generateMigrationGuide(result, { title = 'API 兼容性报告', affectedClients = ['game-client', 'admin-dashboard'] } = {}) {
  const { changes, summary } = result;
  const lines = [`# ${title}`, '', `- 变更总数：${summary.total}，破坏性：${summary.breaking}（CRITICAL ${summary.bySeverity.CRITICAL} / HIGH ${summary.bySeverity.HIGH} / MEDIUM ${summary.bySeverity.MEDIUM}）`, `- 结论：${summary.compatible ? '✅ 向后兼容' : summary.blocking ? '⛔ 存在 P0 破坏性变更，需审批后才能合并' : '⚠️ 存在破坏性变更，需迁移'}`, ''];
  const breaking = changes.filter((c) => c.breaking);
  if (breaking.length) {
    lines.push('## 变更清单', '', '| 级别 | 类型 | 端点 | 路径 | 说明 |', '|---|---|---|---|---|');
    for (const c of breaking) lines.push(`| ${c.priority} | ${c.type} | ${c.method || ''} ${c.route || ''} | ${c.path || '-'} | ${c.note || (c.from ? `${c.from} → ${c.to}` : '')} |`);
    lines.push('', '## 受影响的客户端', '', ...affectedClients.map((x) => `- ${x}`), '', '## 迁移步骤', '');
    const types = [...new Set(breaking.map((c) => c.type))];
    types.forEach((t, i) => lines.push(`${i + 1}. **${t}**：${ADVICE[t] || '评估影响后处理'}`));
    lines.push('', '## 测试建议', '', '- 运行 `node scripts/contract-test.js` 校验线上响应与契约', '- 运行 `node --test backend/tests/unit/api-contract-snapshot.test.js` 确认快照差异已审批', '- 对旧版本客户端（Accept-Version: 1）做回归');
  }
  const added = changes.filter((c) => !c.breaking);
  if (added.length) {
    lines.push('', '## 非破坏性变更', '');
    for (const c of added.slice(0, 100)) lines.push(`- ${c.type} ${c.method || ''} ${c.route || ''} ${c.path || ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  CHANGE_TYPES,
  SEVERITY,
  diffSchemas,
  detectContractChanges,
  detectOpenApiChanges,
  generateMigrationGuide,
  summarize,
};
