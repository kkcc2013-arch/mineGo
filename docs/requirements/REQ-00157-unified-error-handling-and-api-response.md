# REQ-00157：统一错误处理与 API 响应格式标准化

- **编号**：REQ-00157
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：所有微服务、backend/shared、gateway、game-client
- **创建时间**：2026-06-13 09:05
- **依赖需求**：REQ-00066 (API 错误码标准化与故障排查手册)

## 1. 背景与问题

当前项目 9 个微服务在错误处理和 API 响应格式方面存在以下问题：

1. **错误处理不统一**：各服务自行实现错误处理逻辑，缺乏统一的错误分类、错误码映射和错误传播机制
2. **响应格式不一致**：成功响应和错误响应格式在不同服务间存在差异，前端需要适配多种格式
3. **错误信息不标准**：错误消息缺少统一的结构化字段（如 requestId、timestamp、path 等），影响调试和监控
4. **错误追踪困难**：缺少统一的错误链路追踪标识，难以跨服务追踪错误根因
5. **重复代码多**：每个服务都重复实现相似的错误处理逻辑，增加维护成本

代码示例：
```javascript
// user-service 的错误处理
res.status(400).json({ code: 1001, message: '参数错误' });

// pokemon-service 的错误处理
res.status(400).json({ error: 'INVALID_PARAMS', detail: 'Missing required field' });

// catch-service 的错误处理
res.status(400).json({ success: false, error: { code: 2001, msg: '捕捉失败' } });
```

这种不一致性导致：
- 前端需要为不同服务编写不同的错误处理逻辑
- 监控系统难以统一收集和分析错误
- 新开发者学习成本高
- 跨服务错误追踪困难

## 2. 目标

建立统一的错误处理和 API 响应标准化体系：

1. **统一响应格式**：定义标准的成功/错误响应结构，所有服务遵循同一规范
2. **标准化错误码体系**：完善错误码分类（系统错误、业务错误、参数错误等），确保错误码唯一且有明确语义
3. **统一错误处理中间件**：提供全局错误处理中间件，自动捕获、格式化、记录错误
4. **错误追踪增强**：为每个请求生成唯一 requestId，错误发生时自动注入追踪信息
5. **前端适配简化**：前端只需处理统一的响应格式，降低开发和维护成本
6. **可观测性提升**：错误自动记录到日志和监控系统，支持错误统计和告警

## 3. 范围

### 包含

1. **错误分类体系设计**
   - 定义错误分类（ValidationError、BusinessError、DatabaseError、ExternalServiceError 等）
   - 设计错误码范围分配表（1000-1999 用户服务、2000-2999 精灵服务等）
   - 创建 `backend/shared/errors` 错误类库

2. **统一响应格式定义**
   - 成功响应格式：`{ success: true, code: 0, data: {}, requestId, timestamp }`
   - 错误响应格式：`{ success: false, code: number, message: string, details: {}, requestId, timestamp, path }`
   - 分页响应格式：`{ success: true, code: 0, data: [], pagination: {}, requestId, timestamp }`

3. **统一错误处理中间件**
   - 实现 `ErrorHandlerMiddleware` 全局错误处理
   - 自动捕获未处理异常和 Promise rejection
   - 错误分类、格式化、日志记录、指标上报
   - 根据环境配置隐藏敏感错误详情

4. **Request ID 生成与传播**
   - 实现 `RequestIdMiddleware` 自动生成或继承 requestId
   - 在日志、错误响应、链路追踪中携带 requestId
   - 支持 HTTP 头传递（X-Request-Id）

5. **响应格式化工具**
   - 实现 `ResponseFormatter` 工具类
   - 提供成功响应、错误响应、分页响应的标准方法
   - 支持响应数据转换和字段过滤

6. **现有服务迁移**
   - 重构所有 9 个微服务的错误处理逻辑
   - 更新现有 API 端点使用新的响应格式
   - 保持向后兼容性（版本化过渡）

7. **前端适配**
   - 更新 game-client 的 API 响应处理逻辑
   - 实现统一的错误提示组件
   - 更新 API 客户端 SDK

8. **文档与测试**
   - 更新 API 文档，说明新的响应格式规范
   - 编写错误码速查表
   - 添加单元测试和集成测试

### 不包含

- 网络层错误处理（由 gateway 和基础设施层处理）
- 前端 UI 错误展示优化（仅做基础适配）
- 第三方库错误码转换（仅处理应用层错误）

## 4. 详细需求

### 4.1 错误分类体系

创建 `backend/shared/errors` 目录结构：

```
backend/shared/errors/
├── index.js              # 导出所有错误类
├── BaseError.js          # 基础错误类
├── ValidationError.js    # 参数验证错误
├── BusinessError.js      # 业务逻辑错误
├── DatabaseError.js      # 数据库错误
├── ExternalServiceError.js # 外部服务错误
├── AuthenticationError.js # 认证授权错误
├── RateLimitError.js     # 限流错误
├── errorCodes.js         # 错误码定义
└── errorHandler.js       # 错误处理中间件
```

### 4.2 BaseError 错误基类

```javascript
class BaseError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.code = code;                    // 错误码
    this.statusCode = options.statusCode || 500;  // HTTP 状态码
    this.details = options.details || {};         // 错误详情
    this.isOperational = options.isOperational !== false;  // 是否为可预期的错误
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      success: false,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      stack: process.env.NODE_ENV !== 'production' ? this.stack : undefined
    };
  }
}
```

### 4.3 错误码分配表

```javascript
// errorCodes.js
module.exports = {
  // 通用错误 (0-999)
  SUCCESS: 0,
  UNKNOWN_ERROR: 1,
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,

  // 用户服务错误 (1000-1999)
  USER_INVALID_CREDENTIALS: 1001,
  USER_NOT_FOUND: 1002,
  USER_ALREADY_EXISTS: 1003,
  USER_INVALID_TOKEN: 1004,
  USER_MFA_REQUIRED: 1005,
  // ... 更多错误码

  // 精灵服务错误 (2000-2999)
  POKEMON_NOT_FOUND: 2001,
  POKEMON_ALREADY_CAPTURED: 2002,
  POKEMON_EVOLUTION_FAILED: 2003,
  // ... 更多错误码

  // 位置服务错误 (3000-3999)
  LOCATION_INVALID_COORDINATES: 3001,
  LOCATION_OUT_OF_RANGE: 3002,
  // ... 更多错误码

  // 捕捉服务错误 (4000-4999)
  CATCH_FAILED: 4001,
  CATCH_NO_BALLS: 4002,
  CATCH_DISTANCE_TOO_FAR: 4003,
  // ... 更多错误码

  // 道馆服务错误 (5000-5999)
  GYM_NOT_FOUND: 5001,
  GYM_ALREADY_OCCUPIED: 5002,
  GYM_BATTLE_FAILED: 5003,
  // ... 更多错误码

  // 社交服务错误 (6000-6999)
  SOCIAL_FRIEND_ALREADY_EXISTS: 6001,
  SOCIAL_CANNOT_TRADE_WITH_SELF: 6002,
  // ... 更多错误码

  // 奖励服务错误 (7000-7999)
  REWARD_ALREADY_CLAIMED: 7001,
  REWARD_NOT_ELIGIBLE: 7002,
  // ... 更多错误码

  // 支付服务错误 (8000-8999)
  PAYMENT_FAILED: 8001,
  PAYMENT_INVALID_AMOUNT: 8002,
  PAYMENT_INSUFFICIENT_BALANCE: 8003,
  // ... 更多错误码
};
```

### 4.4 统一响应格式化工具

```javascript
// backend/shared/ResponseFormatter.js
class ResponseFormatter {
  /**
   * 成功响应
   */
  static success(data, message = 'Success', requestId = null) {
    return {
      success: true,
      code: 0,
      message,
      data,
      requestId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 分页响应
   */
  static paginated(data, pagination, requestId = null) {
    return {
      success: true,
      code: 0,
      data,
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        total: pagination.total,
        totalPages: Math.ceil(pagination.total / pagination.pageSize)
      },
      requestId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 错误响应（从 Error 对象生成）
   */
  static error(error, requestId = null, path = null) {
    const response = {
      success: false,
      code: error.code || 1,
      message: error.message || 'Internal Server Error',
      details: error.details || {},
      requestId,
      timestamp: error.timestamp || new Date().toISOString()
    };

    if (path) response.path = path;
    
    // 开发环境包含堆栈信息
    if (process.env.NODE_ENV !== 'production' && error.stack) {
      response.stack = error.stack;
    }

    return response;
  }

  /**
   * 从错误码创建错误响应
   */
  static fromCode(code, message = null, details = {}, requestId = null) {
    return {
      success: false,
      code,
      message: message || ERROR_MESSAGES[code] || 'Unknown Error',
      details,
      requestId,
      timestamp: new Date().toISOString()
    };
  }
}
```

### 4.5 全局错误处理中间件

```javascript
// backend/shared/middleware/errorHandler.js
const { createLogger } = require('../logger');
const metrics = require('../metrics');
const ResponseFormatter = require('../ResponseFormatter');
const BaseError = require('../errors/BaseError');

function errorHandler(err, req, res, next) {
  const logger = createLogger('error-handler');
  const requestId = req.requestId || req.headers['x-request-id'];

  // 错误分类
  let statusCode = err.statusCode || 500;
  let errorCode = err.code || 1;
  let message = err.message || 'Internal Server Error';

  // 特定错误类型处理
  if (err.name === 'ValidationError') {
    statusCode = 400;
    errorCode = 400;
  } else if (err.name === 'UnauthorizedError') {
    statusCode = 401;
    errorCode = 401;
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 413;
    errorCode = 413;
  }

  // 记录错误日志
  if (statusCode >= 500) {
    logger.error('Server error', {
      requestId,
      errorCode,
      message,
      stack: err.stack,
      path: req.path,
      method: req.method
    });
  } else {
    logger.warn('Client error', {
      requestId,
      errorCode,
      message,
      path: req.path
    });
  }

  // 上报指标
  metrics.increment('errors_total', 1, {
    service: process.env.SERVICE_NAME,
    code: errorCode,
    status: statusCode
  });

  // 发送响应
  const response = ResponseFormatter.error(err, requestId, req.path);
  res.status(statusCode).json(response);
}

module.exports = errorHandler;
```

### 4.6 Request ID 中间件

```javascript
// backend/shared/middleware/requestId.js
const { v4: uuidv4 } = require('crypto');

function requestIdMiddleware(req, res, next) {
  // 从请求头获取或生成新的 requestId
  const requestId = req.headers['x-request-id'] || 
                    req.headers['x-correlation-id'] || 
                    `req_${Date.now()}_${uuidv4().substr(0, 8)}`;
  
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  
  next();
}

module.exports = requestIdMiddleware;
```

### 4.7 ServiceLauncher 集成

更新 `ServiceLauncher.js` 自动集成错误处理和 Request ID 中间件：

```javascript
const requestIdMiddleware = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');

class ServiceLauncher {
  setupMiddleware() {
    // 添加 Request ID 中间件
    this.app.use(requestIdMiddleware);
    
    // ... 其他中间件

    // 添加错误处理中间件（必须最后添加）
    this.app.use(errorHandler);
  }
}
```

### 4.8 迁移计划

**Phase 1：基础设施（1-2 天）**
- 实现错误类库和响应格式化工具
- 实现错误处理中间件和 Request ID 中间件
- 编写单元测试

**Phase 2：服务迁移（3-4 天）**
- 按优先级迁移服务：gateway → user-service → pokemon-service → catch-service → 其他服务
- 更新现有错误处理代码
- 更新 API 端点使用 `ResponseFormatter`

**Phase 3：前端适配（2-3 天）**
- 更新 game-client API 客户端
- 实现统一错误提示组件
- 测试所有 API 调用

**Phase 4：文档与验证（1 天）**
- 更新 API 文档
- 编写错误码速查表
- 端到端测试

## 5. 验收标准（可测试）

- [ ] 所有 9 个微服务使用统一的错误处理中间件
- [ ] 所有 API 响应遵循统一的格式规范（成功、错误、分页）
- [ ] 错误响应包含 requestId、timestamp、path、code、message、details 字段
- [ ] 所有错误自动记录到日志系统，包含完整上下文信息
- [ ] 错误指标自动上报到 Prometheus
- [ ] 错误码定义完整，覆盖所有服务的业务场景（至少 200 个错误码）
- [ ] 前端 game-client 成功适配新的响应格式
- [ ] API 文档更新，包含完整的响应格式说明和错误码列表
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证所有服务的错误处理流程
- [ ] 性能测试：错误处理中间件增加延迟 < 5ms
- [ ] 向后兼容：支持旧版响应格式（通过 Accept 头或 API 版本控制）

## 6. 工作量估算

**L (Large)** - 需要重构所有 9 个微服务，影响范围广

**估算理由**：
- 基础设施实现：2 天
- 服务迁移（9 个服务）：4 天
- 前端适配：2 天
- 文档与测试：2 天
- **总计：约 10 个工作日**

## 7. 优先级理由

**P1 理由**：
1. **基础性**：错误处理是所有服务的基础能力，影响所有 API 接口
2. **开发效率**：统一标准后，新功能开发时无需重复考虑错误处理格式
3. **用户体验**：一致的错误提示提升用户体验，减少用户困惑
4. **可观测性**：标准化错误有助于监控、告警和问题排查
5. **技术债累积**：当前不一致性已影响多个需求开发，越晚重构成本越高
6. **无破坏性**：可通过版本化 API 平滑过渡，不影响现有功能
