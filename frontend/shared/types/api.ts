/**
 * REQ-00386 统一响应格式 —— 前端共享类型（与 backend/shared/apiStandards/errorCatalog.js、pagination.js、hateoas.js 对应）
 *
 * 成功：{ success: true, code: 0, message, data, meta, _links?, pagination?, deprecation? }
 * 错误：{ success: false, code, message, error: ApiErrorObject, meta, _links? }
 *       旧服务返回字符串 error 时，标准对象在 errorInfo（只增不减，兼容旧客户端）
 * 分页：pagination 与 meta.pagination 为同一对象；_links 含 self/first/prev/next/last
 *
 * 具体接口的 data 类型见 frontend/game-client/src/types/api.generated.d.ts（由契约生成）。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** HAL 链接 */
export interface Link {
  href: string;
  method?: HttpMethod;
  title?: string;
  templated?: boolean;
  type?: string;
}

export type Links = Record<string, Link>;

export interface PaginationMeta {
  type: 'offset' | 'cursor';
  page: number | null;
  pageSize: number;
  limit: number;
  offset: number | null;
  total: number | null;
  totalPages: number | null;
  hasMore: boolean;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor?: string | null;
  prevCursor?: string | null;
  estimated?: boolean;
}

export interface ResponseMeta {
  requestId?: string;
  timestamp?: string;
  apiVersion?: number;
  pagination?: PaginationMeta;
  [key: string]: unknown;
}

/** 弃用接口在响应体中附带的说明（REQ-00407） */
export interface DeprecationNotice {
  deprecated: true;
  deprecatedAt?: string;
  sunsetAt?: string | null;
  daysRemaining?: number | null;
  successorApi?: string | null;
  migrationGuide: string;
  breakingChanges?: unknown[];
}

/** 错误码目录条目（GET /api/errors） */
export interface ApiErrorObject {
  code: number | string;
  name: string;
  message: string;
  httpStatus?: number;
  i18nKey?: string;
  localizedMessage?: string;
  docUrl?: string;
  retryable?: boolean;
  retryAfter?: number;
  details?: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  code: 0;
  message: string;
  data: T;
  meta?: ResponseMeta;
  _links?: Links;
  deprecation?: DeprecationNotice;
  /** ?_aliases=1 时的别名表（客户端 expandAliasedBody 还原后移除） */
  _aliases?: Record<string, string>;
}

export interface ApiPaginated<T> extends ApiSuccess<T[]> {
  pagination: PaginationMeta;
  meta: ResponseMeta & { pagination: PaginationMeta };
  _links: Links & { self: Link; first?: Link; prev?: Link; next?: Link; last?: Link };
}

export interface ApiFailure {
  success: false;
  code: number | string;
  message: string;
  error: ApiErrorObject | string;
  errorInfo?: ApiErrorObject;
  meta?: ResponseMeta;
  _links?: Links;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function isApiFailure<T>(r: ApiResponse<T>): r is ApiFailure {
  return r.success === false;
}

/** 取标准错误对象（兼容 error 为字符串的旧格式） */
export function errorObjectOf(r: ApiFailure): ApiErrorObject {
  if (typeof r.error === 'object' && r.error !== null) return r.error;
  return r.errorInfo ?? { code: r.code, name: 'UNKNOWN', message: r.message };
}

/** 批量请求（REQ-00308） */
export interface BatchSubRequest {
  id?: string;
  method?: HttpMethod;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  priority?: 'high' | 'normal' | 'low';
}

export interface BatchOptions {
  parallel?: boolean;
  maxParallel?: number;
  timeout?: number;
  failFast?: boolean;
  cacheTTL?: number;
}

export interface BatchSubResponse {
  id: string;
  status: number;
  priority: 'high' | 'normal' | 'low';
  cached: boolean;
  duration: number;
  data?: unknown;
  pagination?: PaginationMeta;
  error?: { code: number | string; name?: string; message?: string };
}

export interface BatchResult {
  responses: BatchSubResponse[];
  summary: {
    total: number;
    success: number;
    failed: number;
    cached: number;
    totalDuration: number;
    costSaved: number;
    failedFast: boolean;
    timedOut: boolean;
    sequentialEstimate: number;
  };
}
