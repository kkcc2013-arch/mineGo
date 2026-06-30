# REQ-00386：API 响应格式标准化与错误码统一系统

- **编号**：REQ-00386
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：所有微服务、backend/shared/middleware、gateway、frontend/game-client、frontend/admin-dashboard、docs/api-spec
- **创建时间**：2026-06-30 12:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 微服务架构中的 API 响应格式存在不一致问题：

1. **响应结构不统一**：
   - catch-service 使用 `successResp()` 返回 `{ success: true, data: {...} }`
   - 部分 service 直接返回对象 `{ user: {...} }`
   - 部分接口返回数组，部分返回对象包裹数组

2. **错误码混乱**：
   - HTTP 状态码使用不一致（同样是业务错误，有的返回 400，有的返回 500）
   - 缺乏统一的业务错误码体系（用户难以区分"余额不足"和"道具不存在"）
   - 错误消息格式不统一：`{ error: "xxx" }` vs `{ message: "xxx" }` vs `{ error: { code: "xxx", message: "yyy" } }`

3. **分页格式多样**：
   - 部分接口使用 `{ items: [], total: 100 }`
   - 部分使用 `{ data: [], pagination: { page, limit, total } }`
   - 部分直接返回数组，客户端无法获取总数

4. **国际化支持缺失**：
   - 错误消息硬编码中英文混杂
   - 客户端无法根据用户语言显示本地化错误消息
   - 缺少错误码到 i18n key 的映射

5. **文档维护困难**：
   - 缺少 OpenAPI 规范的统一响应模式定义
   - 前端开发需要逐个接口测试才能了解响应格式

示例问题代码：
```javascript
// catch-service/src/index.js - 当前格式
res.json({ success: true, data: { xp, stardust, candy } });

// 其他服务可能使用
res.json({ user: user }); // 直接对象

// 错误响应
res.status(400).json({ error: 'insufficient_balance' });
// 或
res.status(500).json({ message: 'Database error' });
```

## 2. 目标

建立统一的 API 响应格式标准，实现：

1. **统一响应结构**：所有接口返回一致的数据结构
2. **标准化错误体系**：HTTP 状态码 + 业务错误码 + 本地化消息
3. **统一分页格式**：列表接口使用一致的分页结构
4. **自动化文档生成**：基于代码自动生成 OpenAPI 规范
5. **客户端 SDK 友好**：支持类型定义和智能提示
6. **向后兼容**：提供迁移期支持，逐步过渡

## 3. 范围

### 包含
- 设计并实现统一的 API 响应格式规范
- 创建统一的错误码体系和错误码注册表
- 实现 ApiResponse 中间件和工具类
- 实现 ErrorHandler 中间件统一错误处理
- 创建分页响应工具类
- 更新现有服务的响应格式（渐进式）
- 更新 OpenAPI 文档规范
- 创建 TypeScript 类型定义

### 不包含
- 前端客户端 SDK 重构（后续需求）
- GraphQL 迁移（不在当前规划）
- WebSocket 消息格式标准化（单独需求）

## 4. 详细需求

### 4.1 统一响应格式规范

#### 成功响应格式

```javascript
// 单个资源
{
  "success": true,
  "data": {
    "id": "abc123",
    "name": "Pikachu"
  },
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}

// 列表资源（带分页）
{
  "success": true,
  "data": [
    { "id": "1", "name": "Pikachu" },
    { "id": "2", "name": "Charizard" }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8,
    "hasMore": true
  },
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}

// 操作确认
{
  "success": true,
  "data": {
    "affected": 3,
    "message": "Successfully deleted 3 items"
  },
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}
```

#### 错误响应格式

```javascript
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient coins to purchase this item",
    "details": {
      "required": 1000,
      "available": 500
    },
    "i18nKey": "errors.payment.insufficient_balance",
    "docUrl": "https://docs.minego.game/errors/INSUFFICIENT_BALANCE"
  },
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}
```

### 4.2 业务错误码体系

```javascript
// backend/shared/errors/ErrorCodes.js

/**
 * 错误码分类规范
 * 
 * 格式：{模块}_{动作}_{原因}
 * - 模块：USER, POKEMON, CATCH, GYM, SOCIAL, PAYMENT, SYSTEM
 * - 动作：CREATE, UPDATE, DELETE, QUERY, AUTH, VALIDATE
 * - 原因：具体错误原因
 * 
 * 示例：
 * - USER_AUTH_TOKEN_EXPIRED
 * - POKEMON_QUERY_NOT_FOUND
 * - PAYMENT_CREATE_INSUFFICIENT_BALANCE
 */

module.exports = {
  // ==================== 通用错误 (1xxx) ====================
  VALIDATION_ERROR: {
    code: 'VALIDATION_ERROR',
    httpStatus: 400,
    message: 'Request validation failed',
    i18nKey: 'errors.common.validation'
  },
  RESOURCE_NOT_FOUND: {
    code: 'RESOURCE_NOT_FOUND',
    httpStatus: 404,
    message: 'Requested resource not found',
    i18nKey: 'errors.common.not_found'
  },
  RATE_LIMIT_EXCEEDED: {
    code: 'RATE_LIMIT_EXCEEDED',
    httpStatus: 429,
    message: 'Rate limit exceeded',
    i18nKey: 'errors.common.rate_limit'
  },

  // ==================== 用户认证错误 (2xxx) ====================
  USER_AUTH_TOKEN_EXPIRED: {
    code: 'USER_AUTH_TOKEN_EXPIRED',
    httpStatus: 401,
    message: 'Authentication token has expired',
    i18nKey: 'errors.auth.token_expired'
  },
  USER_AUTH_INVALID_TOKEN: {
    code: 'USER_AUTH_INVALID_TOKEN',
    httpStatus: 401,
    message: 'Invalid authentication token',
    i18nKey: 'errors.auth.invalid_token'
  },
  USER_AUTH_UNAUTHORIZED: {
    code: 'USER_AUTH_UNAUTHORIZED',
    httpStatus: 403,
    message: 'You are not authorized to perform this action',
    i18nKey: 'errors.auth.unauthorized'
  },

  // ==================== 精灵相关错误 (3xxx) ====================
  POKEMON_QUERY_NOT_FOUND: {
    code: 'POKEMON_QUERY_NOT_FOUND',
    httpStatus: 404,
    message: 'Pokemon not found',
    i18nKey: 'errors.pokemon.not_found'
  },
  POKEMON_VALIDATE_INSUFFICIENT_CANDY: {
    code: 'POKEMON_VALIDATE_INSUFFICIENT_CANDY',
    httpStatus: 400,
    message: 'Insufficient candy to evolve this Pokemon',
    i18nKey: 'errors.pokemon.insufficient_candy'
  },
  POKEMON_UPDATE_MAX_LEVEL: {
    code: 'POKEMON_UPDATE_MAX_LEVEL',
    httpStatus: 400,
    message: 'Pokemon has reached maximum level',
    i18nKey: 'errors.pokemon.max_level'
  },

  // ==================== 捕捉相关错误 (4xxx) ====================
  CATCH_VALIDATE_OUT_OF_RANGE: {
    code: 'CATCH_VALIDATE_OUT_OF_RANGE',
    httpStatus: 400,
    message: 'You are too far from the Pokemon',
    i18nKey: 'errors.catch.out_of_range'
  },
  CATCH_VALIDATE_ALREADY_CAUGHT: {
    code: 'CATCH_VALIDATE_ALREADY_CAUGHT',
    httpStatus: 409,
    message: 'This Pokemon has already been caught',
    i18nKey: 'errors.catch.already_caught'
  },
  CATCH_VALIDATE_NO_BALLS: {
    code: 'CATCH_VALIDATE_NO_BALLS',
    httpStatus: 400,
    message: 'No Pokeballs available',
    i18nKey: 'errors.catch.no_balls'
  },

  // ==================== 道馆相关错误 (5xxx) ====================
  GYM_VALIDATE_TEAM_MISMATCH: {
    code: 'GYM_VALIDATE_TEAM_MISMATCH',
    httpStatus: 403,
    message: 'Cannot battle your own team\'s gym',
    i18nKey: 'errors.gym.team_mismatch'
  },
  GYM_VALIDATE_COOLDOWN: {
    code: 'GYM_VALIDATE_COOLDOWN',
    httpStatus: 429,
    message: 'You must wait before battling again',
    i18nKey: 'errors.gym.cooldown'
  },

  // ==================== 社交相关错误 (6xxx) ====================
  SOCIAL_CREATE_FRIEND_EXISTS: {
    code: 'SOCIAL_CREATE_FRIEND_EXISTS',
    httpStatus: 409,
    message: 'Already friends with this user',
    i18nKey: 'errors.social.friend_exists'
  },
  SOCIAL_VALIDATE_FRIEND_LIMIT: {
    code: 'SOCIAL_VALIDATE_FRIEND_LIMIT',
    httpStatus: 400,
    message: 'Maximum number of friends reached',
    i18nKey: 'errors.social.friend_limit'
  },

  // ==================== 支付相关错误 (7xxx) ====================
  PAYMENT_CREATE_INSUFFICIENT_BALANCE: {
    code: 'PAYMENT_CREATE_INSUFFICIENT_BALANCE',
    httpStatus: 402,
    message: 'Insufficient balance',
    i18nKey: 'errors.payment.insufficient_balance'
  },
  PAYMENT_VALIDATE_PRODUCT_NOT_FOUND: {
    code: 'PAYMENT_VALIDATE_PRODUCT_NOT_FOUND',
    httpStatus: 404,
    message: 'Product not found',
    i18nKey: 'errors.payment.product_not_found'
  },
  PAYMENT_CREATE_DUPLICATE_ORDER: {
    code: 'PAYMENT_CREATE_DUPLICATE_ORDER',
    httpStatus: 409,
    message: 'Duplicate order detected',
    i18nKey: 'errors.payment.duplicate_order'
  },

  // ==================== 系统错误 (9xxx) ====================
  SYSTEM_DATABASE_ERROR: {
    code: 'SYSTEM_DATABASE_ERROR',
    httpStatus: 500,
    message: 'Database operation failed',
    i18nKey: 'errors.system.database'
  },
  SYSTEM_EXTERNAL_SERVICE_ERROR: {
    code: 'SYSTEM_EXTERNAL_SERVICE_ERROR',
    httpStatus: 502,
    message: 'External service unavailable',
    i18nKey: 'errors.system.external_service'
  },
  SYSTEM_INTERNAL_ERROR: {
    code: 'SYSTEM_INTERNAL_ERROR',
    httpStatus: 500,
    message: 'Internal server error',
    i18nKey: 'errors.system.internal'
  }
};
```

### 4.3 ApiResponse 工具类

```javascript
// backend/shared/utils/ApiResponse.js

const { v4: uuidv4 } = require('uuid');

class ApiResponse {
  /**
   * 成功响应
   */
  static success(res, data, options = {}) {
    const response = {
      success: true,
      data,
      meta: {
        requestId: res.locals.requestId || uuidv4(),
        timestamp: new Date().toISOString(),
        ...options.meta
      }
    };

    return res.status(options.status || 200).json(response);
  }

  /**
   * 创建成功响应 (201)
   */
  static created(res, data, options = {}) {
    return this.success(res, data, { ...options, status: 201 });
  }

  /**
   * 无内容响应 (204)
   */
  static noContent(res) {
    return res.status(204).send();
  }

  /**
   * 分页响应
   */
  static paginated(res, items, pagination, options = {}) {
    const { page, limit, total } = pagination;
    const totalPages = Math.ceil(total / limit);

    const response = {
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages
      },
      meta: {
        requestId: res.locals.requestId || uuidv4(),
        timestamp: new Date().toISOString(),
        ...options.meta
      }
    };

    return res.status(200).json(response);
  }

  /**
   * 列表响应（无分页）
   */
  static list(res, items, options = {}) {
    return this.success(res, items, options);
  }

  /**
   * 操作确认响应
   */
  static actionResult(res, result, options = {}) {
    return this.success(res, result, options);
  }
}

module.exports = ApiResponse;
```

### 4.4 统一错误处理中间件

```javascript
// backend/shared/middleware/errorHandler.js

const logger = require('../logger');
const ErrorCodes = require('../errors/ErrorCodes');
const { v4: uuidv4 } = require('uuid');

/**
 * 应用错误类
 */
class AppError extends Error {
  constructor(errorCode, details = null) {
    const errorDef = typeof errorCode === 'string' 
      ? ErrorCodes[errorCode] 
      : errorCode;
    
    if (!errorDef) {
      throw new Error(`Unknown error code: ${errorCode}`);
    }

    super(errorDef.message);
    this.name = 'AppError';
    this.code = errorDef.code;
    this.httpStatus = errorDef.httpStatus;
    this.i18nKey = errorDef.i18nKey;
    this.details = details;
    this.isOperational = true; // 可预期的业务错误
  }
}

/**
 * 统一错误处理中间件
 */
function errorHandler(err, req, res, next) {
  // 如果响应已发送，交给默认错误处理
  if (res.headersSent) {
    return next(err);
  }

  const requestId = res.locals.requestId || uuidv4();

  // AppError - 业务错误
  if (err instanceof AppError) {
    logger.warn({
      requestId,
      code: err.code,
      message: err.message,
      details: err.details,
      path: req.path
    }, 'Business error');

    return res.status(err.httpStatus).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        i18nKey: err.i18nKey,
        docUrl: `https://docs.minego.game/errors/${err.code}`
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString()
      }
    });
  }

  // 验证错误 (Joi/express-validator)
  if (err.name === 'ValidationError' || err.name === 'ArgumentError') {
    logger.warn({
      requestId,
      errors: err.details || err.errors,
      path: req.path
    }, 'Validation error');

    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.details || err.errors,
        i18nKey: 'errors.common.validation'
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString()
      }
    });
  }

  // JWT 错误
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'USER_AUTH_INVALID_TOKEN',
        message: 'Invalid authentication token',
        i18nKey: 'errors.auth.invalid_token'
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString()
      }
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'USER_AUTH_TOKEN_EXPIRED',
        message: 'Authentication token has expired',
        i18nKey: 'errors.auth.token_expired'
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString()
      }
    });
  }

  // 数据库错误
  if (err.code === '23505') { // PostgreSQL unique violation
    return res.status(409).json({
      success: false,
      error: {
        code: 'RESOURCE_ALREADY_EXISTS',
        message: 'Resource already exists',
        details: { constraint: err.constraint },
        i18nKey: 'errors.common.already_exists'
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString()
      }
    });
  }

  // 未知错误 - 500
  logger.error({
    requestId,
    error: err.message,
    stack: err.stack,
    path: req.path
  }, 'Unexpected error');

  return res.status(500).json({
    success: false,
    error: {
      code: 'SYSTEM_INTERNAL_ERROR',
      message: 'Internal server error',
      i18nKey: 'errors.system.internal'
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString()
    }
  });
}

/**
 * 404 处理
 */
function notFoundHandler(req, res) {
  const requestId = res.locals.requestId || uuidv4();

  res.status(404).json({
    success: false,
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Requested resource not found',
      i18nKey: 'errors.common.not_found'
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString()
    }
  });
}

/**
 * 异步路由包装器
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  AppError,
  errorHandler,
  notFoundHandler,
  asyncHandler
};
```

### 4.5 迁移示例

```javascript
// 迁移前 - catch-service/src/index.js
async function handleCatchSuccess(userId, session, throwRating, isCurve) {
  // ...
  res.json({ success: true, data: { xp, stardust, candy } });
}

// 迁移后
const { ApiResponse, AppError } = require('../../../shared/middleware/errorHandler');
const ErrorCodes = require('../../../shared/errors/ErrorCodes');

async function handleCatchSuccess(userId, session, throwRating, isCurve) {
  // ...
  return ApiResponse.success(res, {
    xp,
    stardust,
    candy,
    pokemon: caughtPokemon
  });
}

// 错误处理
if (!hasBalls) {
  throw new AppError('CATCH_VALIDATE_NO_BALLS', {
    available: userBalls,
    required: 1
  });
}
```

### 4.6 OpenAPI 规范更新

```yaml
# docs/api-spec/openapi.yaml
openapi: 3.0.3
info:
  title: mineGo API
  version: 1.0.0

components:
  schemas:
    SuccessResponse:
      type: object
      required:
        - success
        - data
        - meta
      properties:
        success:
          type: boolean
          example: true
        data:
          type: object
        meta:
          $ref: '#/components/schemas/ResponseMeta'
    
    PaginatedResponse:
      type: object
      required:
        - success
        - data
        - pagination
        - meta
      properties:
        success:
          type: boolean
          example: true
        data:
          type: array
          items: {}
        pagination:
          $ref: '#/components/schemas/Pagination'
        meta:
          $ref: '#/components/schemas/ResponseMeta'
    
    ErrorResponse:
      type: object
      required:
        - success
        - error
        - meta
      properties:
        success:
          type: boolean
          example: false
        error:
          $ref: '#/components/schemas/Error'
        meta:
          $ref: '#/components/schemas/ResponseMeta'
    
    Error:
      type: object
      required:
        - code
        - message
      properties:
        code:
          type: string
          example: 'VALIDATION_ERROR'
        message:
          type: string
          example: 'Request validation failed'
        details:
          type: object
        i18nKey:
          type: string
          example: 'errors.common.validation'
        docUrl:
          type: string
          format: uri
          example: 'https://docs.minego.game/errors/VALIDATION_ERROR'
    
    Pagination:
      type: object
      properties:
        page:
          type: integer
          example: 1
        limit:
          type: integer
          example: 20
        total:
          type: integer
          example: 150
        totalPages:
          type: integer
          example: 8
        hasMore:
          type: boolean
          example: true
    
    ResponseMeta:
      type: object
      properties:
        requestId:
          type: string
          format: uuid
        timestamp:
          type: string
          format: date-time
```

### 4.7 TypeScript 类型定义

```typescript
// frontend/shared/types/api.ts

export interface ApiResponse<T = any> {
  success: boolean;
  data: T;
  meta: ResponseMeta;
}

export interface PaginatedResponse<T = any> {
  success: boolean;
  data: T[];
  pagination: Pagination;
  meta: ResponseMeta;
}

export interface ErrorResponse {
  success: false;
  error: ApiError;
  meta: ResponseMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, any>;
  i18nKey: string;
  docUrl?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
}
```

## 5. 验收标准（可测试）

- [ ] `backend/shared/utils/ApiResponse.js` 存在且导出 `success`, `created`, `paginated`, `list`, `noContent` 方法
- [ ] `backend/shared/middleware/errorHandler.js` 存在且导出 `AppError`, `errorHandler`, `notFoundHandler`, `asyncHandler`
- [ ] `backend/shared/errors/ErrorCodes.js` 包含至少 20 个错误码定义
- [ ] 所有错误码包含 `code`, `httpStatus`, `message`, `i18nKey` 四个字段
- [ ] 测试用例验证：成功响应格式符合 `{ success: true, data: {}, meta: {} }`
- [ ] 测试用例验证：错误响应格式符合 `{ success: false, error: {}, meta: {} }`
- [ ] 测试用例验证：分页响应包含 `pagination` 字段且格式正确
- [ ] 测试用例验证：`AppError` 正确映射到 HTTP 状态码
- [ ] `docs/api-spec/openapi.yaml` 更新并包含 `SuccessResponse`, `ErrorResponse`, `PaginatedResponse` 组件定义
- [ ] `frontend/shared/types/api.ts` 类型定义文件存在且可编译
- [ ] 至少 3 个服务的响应格式已迁移使用新标准
- [ ] 文档更新：`docs/api-guidelines.md` 包含响应格式规范说明

## 6. 工作量估算

**L (Large)**
- 设计响应格式标准和错误码体系：2-3 天
- 实现工具类和中间件：2-3 天
- 更新 OpenAPI 规范：1 天
- 创建 TypeScript 类型定义：0.5 天
- 迁移现有服务（渐进式）：3-5 天
- 文档和测试：1-2 天
- 总计：约 10-15 人天

## 7. 优先级理由

**P1 理由**：
1. **影响所有 API**：响应格式是所有接口的基础，统一后极大提升开发效率
2. **客户端友好**：统一的错误码和格式让客户端开发更简单，减少沟通成本
3. **国际化基础**：错误码与 i18nKey 绑定，为多语言支持奠定基础
4. **可维护性提升**：标准化响应让问题排查和监控更简单
5. **文档自动化**：统一格式支持自动生成准确的 API 文档
6. **向后兼容设计**：渐进式迁移策略不影响现有功能
