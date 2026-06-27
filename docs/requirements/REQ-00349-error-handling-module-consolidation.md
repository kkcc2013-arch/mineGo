# REQ-00349：错误处理模块重构与统一化

- **编号**：REQ-00349
- **类别**：技术债/重构
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：backend/shared/auth.js、backend/shared/errorHandler.js、所有微服务、gateway
- **创建时间**：2026-06-27 05:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前项目在 `backend/shared/` 目录下存在错误处理逻辑的重复定义：

1. **`auth.js`** 中定义了 `class AppError extends Error`
2. **`errorHandler.js`** 中也定义了 `class AppError extends Error`
3. 两个文件的 `AppError` 实现细节略有不同，导致行为不一致
4. 各微服务在导入时可能导入不同的 `AppError`，造成混乱

**问题影响**：
- 代码重复违反 DRY 原则
- 两个不同的错误类可能导致错误处理逻辑不一致
- 新开发者难以理解应该使用哪个 `AppError`
- 未来修改错误处理逻辑需要同时修改两处，增加维护成本
- 错误码和错误消息可能不统一

**代码证据**：
```bash
$ grep -r "class AppError" backend/shared --include="*.js"
backend/shared/auth.js:class AppError extends Error { ... }
backend/shared/errorHandler.js:class AppError extends Error { ... }
```

## 2. 目标

通过重构统一错误处理模块，达成以下目标：

1. **消除代码重复**：合并两个 `AppError` 为单一实现
2. **统一错误处理**：所有微服务使用相同的错误类和错误码
3. **提升可维护性**：错误处理逻辑集中管理，易于扩展
4. **保持向后兼容**：重构后不影响现有代码，提供过渡期
5. **改善开发者体验**：清晰的 API 文档和使用示例

## 3. 范围

### 包含

- 创建统一的错误处理模块 `backend/shared/errors/`
- 合并 `AppError` 类实现，保留两个版本的特性
- 定义标准错误码枚举和错误消息模板
- 创建工厂函数（如 `Errors.notFound()`, `Errors.unauthorized()` 等）
- 更新所有导入 `AppError` 的文件
- 添加迁移指南和废弃警告
- 添加单元测试覆盖

### 不包含

- HTTP 错误响应格式的修改（已有统一格式）
- 错误日志系统的重构（已有完善日志）
- 客户端错误处理逻辑

## 4. 详细需求

### 4.1 统一错误模块结构

创建 `backend/shared/errors/` 目录：

```
backend/shared/errors/
├── index.js              # 主入口，导出 AppError 和工厂函数
├── AppError.js           # AppError 基类
├── codes.js              # 标准错误码枚举
├── factory.js            # 错误工厂函数
├── middleware.js         # Express 错误处理中间件
└── README.md             # 使用文档
```

### 4.2 AppError 类设计

```javascript
// backend/shared/errors/AppError.js
class AppError extends Error {
  constructor(code, message, statusCode = 500, details = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
    this.isOperational = true;
    
    Error.captureStackTrace(this, this.constructor);
  }
  
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        timestamp: this.timestamp
      }
    };
  }
}
```

### 4.3 标准错误码

```javascript
// backend/shared/errors/codes.js
module.exports = {
  // 4xx 错误
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  
  // 5xx 错误
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  
  // 业务错误
  POKEMON_NOT_FOUND: 'POKEMON_NOT_FOUND',
  INSUFFICIENT_RESOURCES: 'INSUFFICIENT_RESOURCES',
  CATCH_FAILED: 'CATCH_FAILED',
  BATTLE_INVALID: 'BATTLE_INVALID'
};
```

### 4.4 错误工厂函数

```javascript
// backend/shared/errors/factory.js
const AppError = require('./AppError');
const codes = require('./codes');

module.exports = {
  badRequest: (message, details) => 
    new AppError(codes.BAD_REQUEST, message, 400, details),
    
  unauthorized: (message = 'Unauthorized', details) => 
    new AppError(codes.UNAUTHORIZED, message, 401, details),
    
  forbidden: (message = 'Forbidden', details) => 
    new AppError(codes.FORBIDDEN, message, 403, details),
    
  notFound: (resource = 'Resource', details) => 
    new AppError(codes.NOT_FOUND, `${resource} not found`, 404, details),
    
  conflict: (message, details) => 
    new AppError(codes.CONFLICT, message, 409, details),
    
  validationError: (errors) => 
    new AppError(codes.VALIDATION_ERROR, 'Validation failed', 422, errors),
    
  rateLimited: (retryAfter = 60, details) => 
    new AppError(codes.RATE_LIMITED, 'Too many requests', 429, { retryAfter, ...details }),
    
  internal: (message = 'Internal server error', details) => 
    new AppError(codes.INTERNAL_ERROR, message, 500, details),
    
  serviceUnavailable: (service, details) => 
    new AppError(codes.SERVICE_UNAVAILABLE, `${service} is unavailable`, 503, details)
};
```

### 4.5 迁移策略

**阶段 1：创建新模块（向后兼容）**
- 创建 `backend/shared/errors/` 目录
- 在 `auth.js` 和 `errorHandler.js` 中添加废弃警告
- 保持旧导出继续工作

**阶段 2：更新导入**
- 扫描所有 `require('../../../shared/auth').AppError` 或 `require('../../../shared/errorHandler').AppError`
- 替换为 `require('../../../shared/errors')`
- 运行测试确保无破坏性变更

**阶段 3：清理**
- 移除 `auth.js` 和 `errorHandler.js` 中的重复代码
- 更新文档

### 4.6 Express 错误处理中间件

```javascript
// backend/shared/errors/middleware.js
const logger = require('../logger');
const AppError = require('./AppError');

function errorMiddleware(err, req, res, next) {
  // 记录错误日志
  logger.error({
    err,
    req: {
      method: req.method,
      url: req.url,
      headers: req.headers
    }
  }, 'Request error');
  
  // AppError 实例
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(err.toJSON());
  }
  
  // JWT 错误
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: { code: 'INVALID_TOKEN', message: 'Invalid token' }
    });
  }
  
  // 验证错误
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: err.message }
    });
  }
  
  // 未知错误
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
  });
}

module.exports = errorMiddleware;
```

### 4.7 单元测试

创建 `backend/shared/errors/__tests__/` 目录：

```javascript
// AppError.test.js
const AppError = require('../AppError');
const { notFound, unauthorized, validationError } = require('../factory');

describe('AppError', () => {
  it('should create error with correct properties', () => {
    const err = new AppError('TEST_CODE', 'Test message', 400, { foo: 'bar' });
    
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('Test message');
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual({ foo: 'bar' });
    expect(err.isOperational).toBe(true);
  });
  
  it('should have toJSON method', () => {
    const err = new AppError('TEST', 'Msg', 404);
    const json = err.toJSON();
    
    expect(json.error.code).toBe('TEST');
    expect(json.error.message).toBe('Msg');
    expect(json.error.timestamp).toBeDefined();
  });
});

describe('Error Factory', () => {
  it('should create 404 error', () => {
    const err = notFound('Pokemon');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Pokemon not found');
  });
  
  it('should create 401 error with default message', () => {
    const err = unauthorized();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Unauthorized');
  });
  
  it('should create validation error with details', () => {
    const err = validationError([{ field: 'email', message: 'Invalid email' }]);
    expect(err.statusCode).toBe(422);
    expect(err.details).toHaveLength(1);
  });
});
```

## 5. 验收标准（可测试）

- [ ] 创建 `backend/shared/errors/` 目录及所有必需文件
- [ ] `AppError` 类包含 `code`, `message`, `statusCode`, `details`, `timestamp`, `isOperational` 属性
- [ ] 至少定义 10 个标准错误码
- [ ] 工厂函数支持所有 4xx/5xx 常见错误类型
- [ ] 错误处理中间件正确处理 `AppError`、JWT 错误、验证错误
- [ ] 所有微服务和 gateway 更新为使用新模块
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 添加废弃警告到旧的 `auth.js` 和 `errorHandler.js`
- [ ] 更新 `backend/shared/index.js` 导出新模块
- [ ] 创建迁移文档 `backend/shared/errors/README.md`
- [ ] 运行全量测试通过（`npm test`）
- [ ] 在至少一个微服务中验证错误响应格式不变

## 6. 工作量估算

**M（中等）** — 预计 4-6 小时

**理由**：
- 需要创建新模块但逻辑相对简单
- 主要工作是更新导入和测试
- 需要仔细处理向后兼容性
- 单元测试编写耗时

## 7. 优先级理由

**P2** — 技术债清理，非紧急但重要

**理由**：
1. **代码质量**：消除重复，提升可维护性
2. **开发者体验**：统一 API 减少混淆
3. **长期收益**：未来错误处理修改更容易
4. **非阻塞**：不影响当前功能，可在迭代中完成
5. **适合时机**：项目成熟度已达 91 分，适合处理技术债

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 破坏现有错误处理 | 高 | 保持向后兼容，添加废弃警告，全量测试 |
| 遗漏某些导入点 | 中 | 使用 grep 扫描所有导入，CI 检查 |
| 错误码冲突 | 低 | 使用新命名空间，逐步迁移 |
| 性能影响 | 低 | 单例模式，避免重复创建 |

## 9. 相关文档

- [Express 错误处理最佳实践](https://expressjs.com/en/guide/error-handling.html)
- [Node.js 错误处理指南](https://nodejs.org/api/errors.html)
- REQ-00157：统一错误处理与 API 响应格式（已完成）
