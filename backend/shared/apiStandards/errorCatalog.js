/**
 * REQ-00386: 响应格式与错误码统一
 *
 * 统一错误响应（与 shared/errorHandler.js 的 { success:false, error:{ code, name, message } } 对齐并扩展）：
 *   {
 *     success: false,
 *     code, message,                       // 旧客户端读取的顶层字段：已有则原样保留，缺失时补齐
 *     error: { code, name, message, httpStatus, i18nKey, docUrl, retryable, details? },
 *     meta: { requestId, timestamp }
 *   }
 * 规则：只增不减 —— 从不删除或改写下游已有字段；error 为字符串（旧格式）时保留字符串，
 *       标准对象放到 errorInfo。
 *
 * 错误名（error.name）来源优先级：下游 error.name → 大写下划线风格的字符串 code → HTTP 状态码默认名。
 * 数字错误码在系统中存在两套历史编号（shared/errors.js 与 shared/errorCodes.js），不做数字→名称反推。
 */
'use strict';

const legacyNamed = (() => { try { return require('../errorCodes').ERROR_CODES; } catch { return {}; } })();
const stringCatalog = (() => { try { return require('../errors/ErrorCodes'); } catch { return {}; } })();

const DOC_BASE = process.env.API_ERROR_DOC_BASE || '/api/errors';

/** HTTP 状态码 → 默认错误名 / 数字码 / 默认消息 */
const STATUS_DEFAULTS = {
  400: { name: 'INVALID_REQUEST', code: 1001, message: '参数错误' },
  401: { name: 'UNAUTHORIZED', code: 1002, message: '未认证，请先登录' },
  403: { name: 'FORBIDDEN', code: 1004, message: '权限不足' },
  404: { name: 'NOT_FOUND', code: 1005, message: '资源不存在' },
  405: { name: 'METHOD_NOT_ALLOWED', code: 1006, message: '方法不允许' },
  406: { name: 'NOT_ACCEPTABLE', code: 1013, message: '无法提供客户端可接受的响应格式' },
  408: { name: 'REQUEST_TIMEOUT', code: 1009, message: '请求超时' },
  409: { name: 'CONFLICT', code: 1009, message: '资源冲突' },
  410: { name: 'GONE', code: 1014, message: '接口已下线' },
  413: { name: 'PAYLOAD_TOO_LARGE', code: 1001, message: '请求体过大' },
  415: { name: 'UNSUPPORTED_MEDIA_TYPE', code: 1010, message: '内容类型不支持' },
  422: { name: 'VALIDATION_ERROR', code: 1001, message: '请求参数校验失败' },
  429: { name: 'RATE_LIMITED', code: 1007, message: '请求过于频繁，请稍后重试' },
  500: { name: 'INTERNAL_ERROR', code: 9001, message: '服务内部错误' },
  502: { name: 'BAD_GATEWAY', code: 9002, message: '下游服务暂时不可用' },
  503: { name: 'SERVICE_UNAVAILABLE', code: 9002, message: '服务暂时不可用' },
  504: { name: 'GATEWAY_TIMEOUT', code: 9002, message: '下游服务响应超时' },
};

/** 网关新增的错误名（REQ-00201/368/407/532/308/315） */
const GATEWAY_ERRORS = {
  NOT_ACCEPTABLE: { code: 1013, httpStatus: 406, message: '无法提供客户端可接受的响应格式', category: 'gateway' },
  UNSUPPORTED_MEDIA_TYPE: { code: 1010, httpStatus: 415, message: '内容类型不支持', category: 'gateway' },
  API_SUNSET: { code: 1014, httpStatus: 410, message: '接口已下线，请迁移到新版本', category: 'gateway' },
  API_VERSION_UNSUPPORTED: { code: 1010, httpStatus: 400, message: '不支持的 API 版本', category: 'gateway' },
  INVALID_FIELDS: { code: 1001, httpStatus: 400, message: 'fields/fieldset 参数无效', category: 'gateway' },
  INVALID_PAGINATION: { code: 1001, httpStatus: 400, message: '分页参数无效', category: 'gateway' },
  BATCH_LIMIT_EXCEEDED: { code: 1015, httpStatus: 400, message: '批量请求超出限制', category: 'gateway' },
  BATCH_RATE_LIMITED: { code: 1007, httpStatus: 429, message: '批量请求过于频繁', category: 'gateway' },
  RESPONSE_SCHEMA_VIOLATION: { code: 9007, httpStatus: 500, message: '响应不符合接口契约', category: 'gateway' },
  BAD_GATEWAY: { code: 9002, httpStatus: 502, message: '下游服务暂时不可用', category: 'gateway' },
  GATEWAY_TIMEOUT: { code: 9002, httpStatus: 504, message: '下游服务响应超时', category: 'gateway' },
  GONE: { code: 1014, httpStatus: 410, message: '资源已不可用', category: 'gateway' },
  REQUEST_TIMEOUT: { code: 1009, httpStatus: 408, message: '请求超时', category: 'general' },
  PAYLOAD_TOO_LARGE: { code: 1001, httpStatus: 413, message: '请求体过大', category: 'general' },
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function i18nKeyFor(name, category) {
  return `errors.${(category || 'common').toLowerCase()}.${String(name).toLowerCase()}`;
}

/** 汇总后的错误目录：name → { name, code, httpStatus, message, i18nKey, category, retryable } */
const CATALOG = (() => {
  const out = {};
  for (const [name, d] of Object.entries(legacyNamed)) {
    out[name] = { name, code: d.code, httpStatus: d.httpStatus, message: d.message || name, category: d.category || 'general' };
  }
  for (const [name, d] of Object.entries(stringCatalog)) {
    if (!d || typeof d !== 'object' || !d.httpStatus) continue;
    out[name] = { name, code: out[name] ? out[name].code : (STATUS_DEFAULTS[d.httpStatus] || {}).code || null, httpStatus: d.httpStatus, message: d.message, i18nKey: d.i18nKey, category: name.split('_')[0].toLowerCase() };
  }
  for (const [name, d] of Object.entries(GATEWAY_ERRORS)) out[name] = { name, ...d };
  for (const [status, d] of Object.entries(STATUS_DEFAULTS)) {
    if (!out[d.name]) out[d.name] = { name: d.name, code: d.code, httpStatus: Number(status), message: d.message, category: 'general' };
  }
  for (const e of Object.values(out)) {
    e.i18nKey = e.i18nKey || i18nKeyFor(e.name, e.category);
    e.retryable = RETRYABLE_STATUS.has(e.httpStatus);
    e.docUrl = `${DOC_BASE}/${e.name}`;
  }
  return out;
})();

function lookup(name) {
  return CATALOG[name] || null;
}

function statusDefault(status) {
  return STATUS_DEFAULTS[status] || (status >= 500 ? STATUS_DEFAULTS[500] : STATUS_DEFAULTS[400]);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

function resolveName(body, status) {
  const err = isPlainObject(body.error) ? body.error : null;
  if (err && typeof err.name === 'string' && NAME_RE.test(err.name)) return err.name;
  if (err && typeof err.code === 'string' && NAME_RE.test(err.code)) return err.code;
  if (typeof body.error === 'string' && NAME_RE.test(body.error)) return body.error;
  if (typeof body.code === 'string' && NAME_RE.test(body.code)) return body.code;
  if (typeof body.errorCode === 'string' && NAME_RE.test(body.errorCode)) return body.errorCode;
  return statusDefault(status).name;
}

/**
 * 规范化错误响应体（原地增补，返回同一对象；非对象原样返回）
 * @param {object} body
 * @param {number} status
 * @param {object} ctx { requestId, timestamp, retryAfter }
 */
function normalizeErrorBody(body, status, ctx = {}) {
  if (!isPlainObject(body)) return body;
  const name = resolveName(body, status);
  const def = lookup(name) || { name, ...statusDefault(status), category: 'general' };
  const errObj = isPlainObject(body.error) ? body.error : null;
  const message =
    (errObj && typeof errObj.message === 'string' && errObj.message) ||
    (typeof body.message === 'string' && body.message) ||
    (typeof body.error === 'string' && body.error) ||
    (typeof body.msg === 'string' && body.msg) ||
    def.message;
  const numericCode =
    (errObj && typeof errObj.code === 'number' && errObj.code) ||
    (typeof body.code === 'number' && body.code) ||
    def.code || statusDefault(status).code;
  const retryable = RETRYABLE_STATUS.has(status);

  const standard = {
    code: numericCode,
    name,
    message,
    httpStatus: status,
    i18nKey: def.i18nKey || i18nKeyFor(name, def.category),
    docUrl: def.docUrl || `${DOC_BASE}/${name}`,
    retryable,
  };
  if (retryable && ctx.retryAfter !== undefined && ctx.retryAfter !== null) standard.retryAfter = Number(ctx.retryAfter);
  const details = (errObj && errObj.details) || body.details || (isPlainObject(body.data) && Object.keys(body.data).length ? body.data : undefined);
  if (details !== undefined && details !== null) standard.details = details;

  if (body.success === undefined) body.success = false;
  if (body.code === undefined) body.code = numericCode;
  if (body.message === undefined) body.message = message;
  if (errObj) {
    for (const [k, v] of Object.entries(standard)) if (errObj[k] === undefined) errObj[k] = v;
  } else if (body.error === undefined || body.error === null) {
    body.error = standard;
  } else if (body.errorInfo === undefined) {
    body.errorInfo = standard; // 旧格式 error: "字符串" 保留不动
  }
  if (ctx.meta !== false) addMeta(body, ctx);
  return body;
}

function addMeta(body, ctx = {}) {
  if (!isPlainObject(body)) return body;
  if (body.meta === undefined || body.meta === null) body.meta = {};
  if (!isPlainObject(body.meta)) return body; // 下游 meta 不是对象：不改动
  if (body.meta.requestId === undefined && ctx.requestId) body.meta.requestId = ctx.requestId;
  if (body.meta.timestamp === undefined) body.meta.timestamp = ctx.timestamp || new Date().toISOString();
  if (ctx.apiVersion !== undefined && body.meta.apiVersion === undefined) body.meta.apiVersion = ctx.apiVersion;
  return body;
}

/** 生成一个完整的标准错误响应体（网关自身产生的错误） */
function buildErrorBody(name, { message, details, requestId, status, retryAfter } = {}) {
  const def = lookup(name) || { name, ...statusDefault(status || 500) };
  const httpStatus = status || def.httpStatus || 500;
  const body = {
    success: false,
    code: def.code,
    message: message || def.message,
    error: { code: def.code, name, message: message || def.message },
  };
  if (details !== undefined) body.error.details = details;
  normalizeErrorBody(body, httpStatus, { requestId, retryAfter });
  return { status: httpStatus, body };
}

/** 成功响应：只补 success/meta，不改 code/message/data */
function normalizeSuccessBody(body, status, ctx = {}) {
  if (!isPlainObject(body)) return body;
  if (body.success === undefined) body.success = true;
  addMeta(body, ctx);
  return body;
}

function listCatalog() {
  return Object.values(CATALOG).sort((a, b) => (a.httpStatus - b.httpStatus) || a.name.localeCompare(b.name));
}

module.exports = {
  CATALOG,
  STATUS_DEFAULTS,
  GATEWAY_ERRORS,
  RETRYABLE_STATUS,
  lookup,
  statusDefault,
  normalizeErrorBody,
  normalizeSuccessBody,
  buildErrorBody,
  addMeta,
  listCatalog,
};
