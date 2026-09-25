/**
 * REQ-00302 / REQ-00465: 分页标准化
 *
 * 参数（优先级从高到低）：
 *   cursor [+ direction=next|prev]            游标分页
 *   page + pageSize（别名 page_size/per_page/size/limit）  偏移分页
 *   offset + limit                             旧参数（兼容，标记 deprecatedParams）
 * 默认 pageSize=20，最大 100。
 *
 * 响应元数据（同一对象同时出现在顶层 pagination 与 meta.pagination，字段取两份需求的并集）：
 *   { type, page, pageSize, limit, offset, total, totalPages, hasMore, hasNext, hasPrev, nextCursor, prevCursor }
 * 链接：_links.{self,first,prev,next,last}（HAL）+ RFC 8288 Link 头
 */
'use strict';

const crypto = require('crypto');

const DEFAULTS = { defaultPageSize: 20, maxPageSize: 100, deferredJoinThreshold: 1000 };

class PaginationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PaginationError';
    this.status = 400;
    this.details = details;
  }
}

function firstDefined(q, names) {
  for (const n of names) {
    const v = q[n];
    if (v !== undefined && v !== null && v !== '') return { name: n, value: Array.isArray(v) ? v[0] : v };
  }
  return null;
}

function toInt(name, raw, { min, max }) {
  if (!/^-?\d+$/.test(String(raw).trim())) throw new PaginationError(`分页参数 ${name} 必须是整数`, { param: name, value: raw });
  const n = parseInt(raw, 10);
  if (n < min) throw new PaginationError(`分页参数 ${name} 不能小于 ${min}`, { param: name, value: n, min });
  if (max !== undefined && n > max) return max; // 超过上限时截断而不是报错
  return n;
}

/**
 * 解析分页参数
 * @param {object} query req.query
 * @returns {{ type, page, pageSize, limit, offset, cursor, cursorData, direction, deprecatedParams, clamped }}
 */
function parsePagination(query = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const deprecatedParams = [];
  const cursorP = firstDefined(query, ['cursor', 'after', 'before']);
  const sizeP = firstDefined(query, ['pageSize', 'page_size', 'per_page', 'size', 'limit']);
  let pageSize = o.defaultPageSize;
  let clamped = false;
  if (sizeP) {
    if (['limit', 'size', 'per_page'].includes(sizeP.name)) deprecatedParams.push(sizeP.name);
    const n = toInt(sizeP.name, sizeP.value, { min: 1 });
    pageSize = Math.min(n, o.maxPageSize);
    clamped = n > o.maxPageSize;
  }

  if (cursorP) {
    const direction = cursorP.name === 'before' ? 'prev' : (query.direction === 'prev' ? 'prev' : 'next');
    if (query.direction && !['next', 'prev'].includes(query.direction)) {
      throw new PaginationError('direction 只能是 next 或 prev', { param: 'direction', value: query.direction });
    }
    // cursor=first：从第一页开始游标分页（此时没有游标数据）
    const cursorData = cursorP.value === 'first' ? null : decodeCursor(cursorP.value, o.cursorSecret);
    return { type: 'cursor', page: null, pageSize, limit: pageSize, offset: null, cursor: cursorP.value, cursorData, direction, deprecatedParams, clamped };
  }

  const pageP = firstDefined(query, ['page', 'p']);
  const offsetP = firstDefined(query, ['offset', 'skip']);
  let page, offset;
  if (pageP) {
    page = toInt(pageP.name, pageP.value, { min: 1, max: 1e6 });
    offset = (page - 1) * pageSize;
  } else if (offsetP) {
    deprecatedParams.push(offsetP.name);
    offset = toInt(offsetP.name, offsetP.value, { min: 0, max: 1e9 });
    page = Math.floor(offset / pageSize) + 1;
  } else {
    page = 1;
    offset = 0;
  }
  return { type: 'offset', page, pageSize, limit: pageSize, offset, cursor: null, cursorData: null, direction: 'next', deprecatedParams, clamped };
}

// ── 游标编码（base64url(JSON) + 可选 HMAC 签名，防篡改/防注入） ───────────
function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 16);
}
function encodeCursor(data, secret) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return secret ? `${payload}.${sign(payload, secret)}` : payload;
}
function decodeCursor(cursor, secret) {
  if (typeof cursor !== 'string' || cursor.length > 1024) throw new PaginationError('无效的游标');
  const [payload, sig] = cursor.split('.');
  if (secret && (!sig || sig !== sign(payload, secret))) throw new PaginationError('无效的游标（签名不匹配）');
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('bad');
    return data;
  } catch {
    throw new PaginationError('无效的游标');
  }
}

/**
 * 组装分页元数据（两份需求字段的并集）
 */
function buildMeta({ type = 'offset', page = null, pageSize, offset = null, total = null, count = null, hasMore = null, nextCursor = null, prevCursor = null, direction = 'next' }) {
  const t = Number.isFinite(Number(total)) && total !== null ? Number(total) : null;
  let hasNext;
  if (hasMore !== null && hasMore !== undefined) hasNext = !!hasMore;
  else if (type === 'cursor') hasNext = !!nextCursor;
  else if (t !== null) hasNext = (offset || 0) + (count === null ? pageSize : count) < t;
  else hasNext = count !== null ? count >= pageSize : false;
  const meta = {
    type,
    page: type === 'offset' ? (page || (offset !== null ? Math.floor(offset / pageSize) + 1 : 1)) : null,
    pageSize,
    limit: pageSize,
    offset: type === 'offset' ? (offset || 0) : null,
    total: t,
    totalPages: t !== null ? Math.max(1, Math.ceil(t / pageSize)) : null,
    hasMore: hasNext,
    hasNext,
    hasPrev: type === 'offset' ? (offset || 0) > 0 : !!prevCursor || direction === 'prev',
  };
  if (type === 'cursor' || nextCursor || prevCursor) {
    meta.nextCursor = nextCursor || null;
    meta.prevCursor = prevCursor || null;
  }
  return meta;
}

function withQuery(basePath, query, overrides) {
  const q = { ...query };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === undefined) delete q[k]; else q[k] = v;
  }
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) v.forEach((x) => s.append(k, x)); else if (v !== undefined) s.append(k, String(v));
  }
  const qs = s.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * HAL 分页链接
 * @param {string} basePath 不含查询串的路径（网关对外路径）
 * @param {object} query 原始查询参数
 * @param {object} meta buildMeta() 的结果
 */
function buildLinks(basePath, query, meta) {
  const q = { ...query };
  // 输出统一使用标准参数名
  for (const k of ['limit', 'size', 'per_page', 'page_size', 'offset', 'skip', 'p', 'after', 'before']) delete q[k];
  const links = {};
  if (meta.type === 'cursor') {
    delete q.cursor; delete q.direction; delete q.page;
    links.self = { href: withQuery(basePath, query, {}) };
    links.first = { href: withQuery(basePath, q, { pageSize: meta.pageSize, cursor: 'first' }) };
    if (meta.nextCursor) links.next = { href: withQuery(basePath, q, { pageSize: meta.pageSize, cursor: meta.nextCursor }) };
    if (meta.prevCursor) links.prev = { href: withQuery(basePath, q, { pageSize: meta.pageSize, cursor: meta.prevCursor, direction: 'prev' }) };
    return links;
  }
  const page = meta.page || 1;
  links.self = { href: withQuery(basePath, q, { page, pageSize: meta.pageSize }) };
  links.first = { href: withQuery(basePath, q, { page: 1, pageSize: meta.pageSize }) };
  if (page > 1) links.prev = { href: withQuery(basePath, q, { page: page - 1, pageSize: meta.pageSize }) };
  if (meta.hasNext) links.next = { href: withQuery(basePath, q, { page: page + 1, pageSize: meta.pageSize }) };
  if (meta.totalPages) links.last = { href: withQuery(basePath, q, { page: meta.totalPages, pageSize: meta.pageSize }) };
  return links;
}

/** RFC 8288 Link 头 */
function toLinkHeader(links) {
  return Object.entries(links)
    .filter(([rel, l]) => l && l.href && rel !== 'self')
    .map(([rel, l]) => `<${l.href}>; rel="${rel}"`)
    .join(', ');
}

/**
 * 识别常见的列表响应形态，返回 { items, container, key, total, limit, offset }
 * 支持：
 *   [ ... ]                                   顶层数组
 *   { data: [ ... ], total? }                 （含 success/code 信封）
 *   { data: { <key>: [ ... ], total, limit, offset } }   如 pokemon-service /pokemon/my
 *   { items|list|results|rows: [ ... ], total }
 */
const LIST_KEYS = ['items', 'list', 'results', 'rows', 'records', 'entries'];
function detectList(body) {
  if (Array.isArray(body)) return { items: body, container: null, key: null, total: null };
  if (!body || typeof body !== 'object') return null;
  const pick = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const keys = Object.keys(obj).filter((k) => Array.isArray(obj[k]));
    let key = keys.find((k) => LIST_KEYS.includes(k));
    // 形如 { pokemon: [...], total: 3 } —— 恰好一个数组字段且带 total/count 时视为列表
    if (!key && keys.length === 1 && ['total', 'count', 'totalCount', 'total_count'].some((t) => t in obj)) key = keys[0];
    if (!key) return null;
    const total = obj.total ?? obj.totalCount ?? obj.total_count ?? obj.count ?? null;
    return { items: obj[key], container: obj, key, total: typeof total === 'number' ? total : (typeof total === 'string' && /^\d+$/.test(total) ? Number(total) : null), limit: obj.limit, offset: obj.offset };
  };
  if (Array.isArray(body.data)) {
    const p = body.pagination || (body.meta && body.meta.pagination) || {};
    return { items: body.data, container: body, key: 'data', total: typeof body.total === 'number' ? body.total : (typeof p.total === 'number' ? p.total : null), limit: p.limit ?? p.pageSize, offset: p.offset };
  }
  return pick(body.data) || pick(body);
}

// ── Express 辅助（服务内使用） ─────────────────────────────────
function offsetPaginationMiddleware(opts = {}) {
  return (req, res, next) => {
    try {
      const p = parsePagination({ ...req.query, cursor: undefined, after: undefined, before: undefined }, opts);
      req.pagination = p;
      attachHelpers(req, res);
      next();
    } catch (err) {
      if (err instanceof PaginationError) return res.status(400).json({ success: false, code: 1001, message: err.message, error: { code: 1001, name: 'INVALID_PAGINATION', message: err.message, details: err.details } });
      next(err);
    }
  };
}

function cursorPaginationMiddleware(opts = {}) {
  return (req, res, next) => {
    try {
      req.pagination = parsePagination(req.query, opts);
      attachHelpers(req, res);
      next();
    } catch (err) {
      if (err instanceof PaginationError) return res.status(400).json({ success: false, code: 1001, message: err.message, error: { code: 1001, name: 'INVALID_PAGINATION', message: err.message, details: err.details } });
      next(err);
    }
  };
}

function attachHelpers(req, res) {
  /** 在 res.json 输出前把分页元数据合并进响应体 */
  res.addPaginationMeta = (info = {}) => {
    const p = req.pagination || parsePagination(req.query);
    res.locals.paginationMeta = buildMeta({ ...p, ...info });
    return res.locals.paginationMeta;
  };
  res.addLinks = (links) => {
    res.locals.links = { ...(res.locals.links || {}), ...links };
    const header = toLinkHeader(res.locals.links);
    if (header) res.setHeader('Link', header);
    return res.locals.links;
  };
  /** 输出标准分页响应（保留 code:0/message 以兼容旧客户端） */
  res.paginated = (items, info = {}) => {
    const meta = res.addPaginationMeta({ count: items.length, ...info });
    const basePath = (req.originalUrl || req.url).split('?')[0];
    const links = buildLinks(basePath, req.query, meta);
    res.addLinks(links);
    return res.json({
      success: true,
      code: 0,
      message: 'ok',
      data: items,
      pagination: meta,
      meta: { timestamp: new Date().toISOString(), pagination: meta },
      _links: links,
      ...(info.extra || {}),
    });
  };
}

// ── SQL 辅助 ─────────────────────────────────────────────────
const IDENT_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;
function ident(s) {
  if (!IDENT_RE.test(s)) throw new Error(`invalid identifier: ${s}`);
  return s;
}

/**
 * 键集（游标）分页 SQL 片段：按 (sortCol, idCol) 排序
 * @returns {{ where: string, order: string, params: any[], limit: number }}
 */
function keysetClause({ sortCol, idCol = 'id', dir = 'desc', cursorData, direction = 'next', paramOffset = 0, pageSize }) {
  ident(sortCol); ident(idCol);
  const desc = String(dir).toLowerCase() !== 'asc';
  const forward = direction !== 'prev';
  const effectiveDesc = forward ? desc : !desc;
  const params = [];
  let where = '';
  if (cursorData && cursorData.s !== undefined && cursorData.i !== undefined) {
    params.push(cursorData.s, cursorData.i);
    const op = effectiveDesc ? '<' : '>';
    where = `(${sortCol}, ${idCol}) ${op} ($${paramOffset + 1}, $${paramOffset + 2})`;
  }
  const d = effectiveDesc ? 'DESC' : 'ASC';
  return { where, order: `${sortCol} ${d}, ${idCol} ${d}`, params, limit: pageSize + 1, reversed: !forward };
}

/** 处理 keyset 查询结果：多取 1 行判断是否还有下一页，生成游标 */
function keysetResult(rows, { pageSize, sortKey, idKey = 'id', reversed = false, hadCursor = false, secret }) {
  let items = rows.slice(0, pageSize);
  const more = rows.length > pageSize;
  if (reversed) items = items.reverse();
  const cur = (row) => encodeCursor({ s: row[sortKey] instanceof Date ? row[sortKey].toISOString() : row[sortKey], i: row[idKey] }, secret);
  const last = items[items.length - 1];
  const first = items[0];
  const nextCursor = reversed ? (hadCursor && last ? cur(last) : null) : (more && last ? cur(last) : null);
  const prevCursor = reversed ? (more && first ? cur(first) : null) : (hadCursor && first ? cur(first) : null);
  return { items, nextCursor, prevCursor, hasMore: reversed ? true : more };
}

/**
 * 延迟关联（deferred join）：大 offset 时先只取主键再回表，避免扫描宽行
 *   SELECT <cols> FROM t JOIN (SELECT id FROM t WHERE ... ORDER BY ... LIMIT n OFFSET m) k USING (id) ORDER BY ...
 */
function deferredJoinSql({ table, alias = 't', idCol = 'id', select, joins = '', where = 'TRUE', orderBy, limitParam, offsetParam }) {
  ident(table); ident(alias); ident(idCol);
  return `SELECT ${select} FROM ${table} ${alias}
    JOIN (SELECT ${alias}.${idCol} FROM ${table} ${alias} WHERE ${where} ORDER BY ${orderBy} LIMIT ${limitParam} OFFSET ${offsetParam}) _k
      ON _k.${idCol} = ${alias}.${idCol}
    ${joins}
    ORDER BY ${orderBy}`;
}

function shouldUseDeferredJoin(offset, threshold = DEFAULTS.deferredJoinThreshold) {
  return Number(offset) > threshold;
}

/**
 * count 估算：优先用规划器估算行数（EXPLAIN），大表避免 COUNT(*) 全扫描
 * @param {function} queryFn (sql, params) => { rows }
 */
async function estimateCount(queryFn, sql, params = []) {
  const { rows } = await queryFn(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const plan = rows[0] && (rows[0]['QUERY PLAN'] || rows[0].query_plan);
  const node = Array.isArray(plan) ? plan[0].Plan : plan && plan.Plan;
  return node ? Math.round(node['Plan Rows']) : null;
}

/**
 * count 策略：exact（COUNT）/ estimate（EXPLAIN）/ none；estimate 结果小于阈值时回退 exact
 */
async function countWithStrategy(queryFn, countSql, params, { mode = 'exact', exactBelow = 10000 } = {}) {
  if (mode === 'none') return { total: null, estimated: false };
  if (mode === 'estimate') {
    const est = await estimateCount(queryFn, countSql.replace(/^\s*SELECT\s+COUNT\(\*\)(::int)?\s+/i, 'SELECT 1 '), params);
    if (est !== null && est >= exactBelow) return { total: est, estimated: true };
  }
  const { rows } = await queryFn(countSql, params);
  const v = rows[0] && (rows[0].count ?? Object.values(rows[0])[0]);
  return { total: Number(v), estimated: false };
}

/**
 * REQ-00465 智能分页策略选择：
 *   显式 cursor → cursor；offset 超过阈值或数据量大（> largeTotal）→ 建议 cursor；否则 offset
 */
class PaginationStrategySelector {
  constructor({ offsetThreshold = 1000, largeTotal = 10000 } = {}) {
    this.offsetThreshold = offsetThreshold;
    this.largeTotal = largeTotal;
  }
  select({ pagination, estimatedTotal = null, supportsCursor = true }) {
    if (pagination && pagination.type === 'cursor') return { strategy: 'cursor', reason: 'explicit-cursor' };
    const offset = pagination ? pagination.offset || 0 : 0;
    if (supportsCursor && offset > this.offsetThreshold) return { strategy: 'cursor', reason: 'large-offset', fallback: 'deferred-join' };
    if (supportsCursor && estimatedTotal !== null && estimatedTotal > this.largeTotal) return { strategy: 'cursor', reason: 'large-dataset', countMode: 'estimate' };
    return { strategy: 'offset', reason: 'default', countMode: estimatedTotal !== null && estimatedTotal > this.largeTotal ? 'estimate' : 'exact' };
  }
}

module.exports = {
  DEFAULTS,
  PaginationError,
  parsePagination,
  encodeCursor,
  decodeCursor,
  buildMeta,
  buildLinks,
  toLinkHeader,
  detectList,
  offsetPaginationMiddleware,
  cursorPaginationMiddleware,
  keysetClause,
  keysetResult,
  deferredJoinSql,
  shouldUseDeferredJoin,
  estimateCount,
  countWithStrategy,
  PaginationStrategySelector,
  withQuery,
};
