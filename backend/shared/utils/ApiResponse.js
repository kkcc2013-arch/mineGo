/**
 * 统一 API 响应工具类
 * REQ-00386：统一响应格式（success / code / message / data / meta），错误走统一错误目录
 * REQ-00518：HATEOAS（_links，HAL）
 * REQ-00302/465：分页（pagination 与 meta.pagination，first/prev/next/last 链接）
 *
 * 兼容性：保留旧客户端依赖的 code:0 与 message（game-client 以 data.code !== 0 判错），只增字段。
 *
 *   ApiResponse.success(res, data, { links, meta, status })
 *   ApiResponse.created(res, data)
 *   ApiResponse.noContent(res)
 *   ApiResponse.list(res, items, { total })                        不分页的完整列表
 *   ApiResponse.paginated(res, items, { page, pageSize|limit, total, nextCursor })
 *   ApiResponse.withLinks(res, data, resourceType, { pathId, isMe })  资源 + 操作链接
 *   ApiResponse.paginatedWithLinks(res, items, resourceType, pagination)
 *   ApiResponse.hal(res, data, resourceType)                       application/hal+json
 *   ApiResponse.error(res, 'NOT_FOUND', { message, details })
 */
'use strict';

const { randomUUID } = require('crypto');
const pagination = require('../apiStandards/pagination');
const hateoas = require('../apiStandards/hateoas');
const { buildErrorBody } = require('../apiStandards/errorCatalog');

const linkRegistry = hateoas.createDefaultRegistry();
const linksBuilder = new hateoas.LinksBuilder(linkRegistry);

function requestPath(res) {
  const req = res.req || {};
  return String(req.originalUrl || req.url || '/').split('?')[0];
}

class ApiResponse {
  static _generateMeta(res, options = {}) {
    const req = res.req || {};
    return {
      requestId: (res.locals && res.locals.requestId) || (req.headers && req.headers['x-request-id']) || randomUUID(),
      timestamp: new Date().toISOString(),
      ...(options.meta || {}),
    };
  }

  static _envelope(res, data, options = {}) {
    const body = { success: true, code: 0, message: options.message || 'ok', data, meta: this._generateMeta(res, options) };
    if (options.links) body._links = options.links;
    return body;
  }

  /** 成功响应 { success, code:0, message, data, meta } */
  static success(res, data, options = {}) {
    return res.status(options.status || 200).json(this._envelope(res, data, options));
  }

  static created(res, data, options = {}) {
    return this.success(res, data, { ...options, status: 201, message: options.message || 'created' });
  }

  static noContent(res) {
    return res.status(204).send();
  }

  /** 完整列表（不分页）：仍给出分页元数据（单页） */
  static list(res, items, options = {}) {
    const total = options.total !== undefined ? options.total : items.length;
    const meta = pagination.buildMeta({ type: 'offset', page: 1, pageSize: Math.max(items.length, 1), offset: 0, total, count: items.length });
    const body = this._envelope(res, items, options);
    body.pagination = meta;
    body.meta.pagination = meta;
    return res.status(options.status || 200).json(body);
  }

  /**
   * 分页响应
   * @param {object} p { page, pageSize|limit, offset, total, nextCursor, prevCursor, type }
   */
  static paginated(res, items, p = {}, options = {}) {
    const pageSize = Number(p.pageSize || p.limit) || Math.max(items.length, 1);
    const page = Number(p.page) || (p.offset !== undefined ? Math.floor(Number(p.offset) / pageSize) + 1 : 1);
    const meta = pagination.buildMeta({
      type: p.type || (p.nextCursor || p.prevCursor ? 'cursor' : 'offset'),
      page, pageSize, offset: p.offset !== undefined ? Number(p.offset) : (page - 1) * pageSize,
      total: p.total !== undefined ? Number(p.total) : null, count: items.length,
      nextCursor: p.nextCursor, prevCursor: p.prevCursor, hasMore: p.hasMore,
    });
    const req = res.req || {};
    const links = pagination.buildLinks(requestPath(res), req.query || {}, meta);
    const header = pagination.toLinkHeader(links);
    if (header && typeof res.setHeader === 'function') res.setHeader('Link', header);
    const body = this._envelope(res, items, { ...options, links: { ...links, ...(options.links || {}) } });
    body.pagination = meta;
    body.meta.pagination = meta;
    return res.status(200).json(body);
  }

  /** 资源 + HATEOAS 操作链接 */
  static withLinks(res, data, resourceType, options = {}) {
    const links = { self: { href: (res.req && res.req.originalUrl) || requestPath(res) }, ...linksBuilder.forResource(resourceType, data, options) };
    return this.success(res, data, { ...options, links });
  }

  static paginatedWithLinks(res, items, resourceType, p = {}, options = {}) {
    const withItemLinks = items.map((it) => (it && typeof it === 'object' ? { ...it, _links: linksBuilder.forResource(resourceType, it, {}) } : it));
    return this.paginated(res, withItemLinks, p, { ...options, links: linksBuilder.forCollection(resourceType, requestPath(res)) });
  }

  /** HAL 表示（Content-Type: application/hal+json） */
  static hal(res, data, resourceType, options = {}) {
    const links = { self: { href: (res.req && res.req.originalUrl) || requestPath(res) }, ...linksBuilder.forResource(resourceType, data, options) };
    const body = hateoas.HalFormatter.format({ success: true, code: 0, data, _links: links, meta: this._generateMeta(res, options) }, { rel: resourceType });
    res.status(options.status || 200);
    if (typeof res.type === 'function') res.type('application/hal+json');
    return res.json(body);
  }

  static halPaginated(res, items, resourceType, p = {}, options = {}) {
    const pageSize = Number(p.pageSize || p.limit) || Math.max(items.length, 1);
    const meta = pagination.buildMeta({ type: 'offset', page: Number(p.page) || 1, pageSize, offset: ((Number(p.page) || 1) - 1) * pageSize, total: p.total, count: items.length });
    const links = pagination.buildLinks(requestPath(res), (res.req && res.req.query) || {}, meta);
    const body = hateoas.HalFormatter.format({ success: true, code: 0, data: items.map((it) => ({ ...it, _links: linksBuilder.forResource(resourceType, it, {}) })), _links: links, pagination: meta, meta: this._generateMeta(res, options) }, { rel: resourceType });
    if (typeof res.type === 'function') res.type('application/hal+json');
    return res.status(200).json(body);
  }

  static discovery(res) {
    return res.status(200).json(new hateoas.ResourceDiscoverer(linkRegistry).discover());
  }

  /** 统一错误响应 */
  static error(res, name, options = {}) {
    const { status, body } = buildErrorBody(name, { ...options, requestId: this._generateMeta(res).requestId });
    return res.status(options.status || status).json(body);
  }

  static actionResult(res, result, options = {}) {
    return this.success(res, result, options);
  }

  static deleted(res, affected = 1) {
    return this.success(res, { affected, message: `Successfully deleted ${affected} item(s)` });
  }

  static updated(res, data) {
    return this.success(res, data);
  }

  static batchResult(res, result) {
    const { succeeded = [], failed = [], total = 0 } = result;
    return this.success(res, { total, succeeded: succeeded.length, failed: failed.length, details: { succeeded, failed } });
  }
}

module.exports = ApiResponse;
