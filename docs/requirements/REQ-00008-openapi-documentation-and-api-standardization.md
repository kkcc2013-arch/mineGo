# REQ-00008：OpenAPI 文档与 API 设计规范统一

- **编号**：REQ-00008
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、docs/api-spec
- **创建时间**：2026-06-05 04:00
- **依赖需求**：REQ-00002 (结构化日志与 Prometheus 指标集成)

## 1. 背景与问题

当前 mineGo 项目存在以下 API 设计规范问题：

1. **文档缺失**：9 个微服务提供 REST API，但缺少 OpenAPI/Swagger 规范文档，前后端开发者需要阅读源码才能理解接口定义
2. **错误码分散**：各服务独立定义错误码（user-service: 1001-2004, payment-service: 5001-5005），缺乏统一管理和文档
3. **响应格式不统一**：
   - user-service 使用 `successResp()` 包装
   - catch-service 直接返回 `{ success: true, data: {} }`
   - 部分接口缺少 traceId 返回，调试困难
4. **请求校验不一致**：部分服务使用 Zod 校验，部分服务缺少校验
5. **版本管理缺失**：当前 `/v1/` 路径固定，缺少版本演进策略

这些问题导致：
- 前端开发效率低，需要频繁询问接口细节
- API 变更影响范围难以评估
- 新成员上手成本高
- 接口测试用例编写困难

## 2. 目标

建立统一的 API 设计规范体系：

1. **规范化**：定义统一的请求/响应格式、错误码体系、命名规范
2. **文档化**：为所有公开 API 生成 OpenAPI 3.0 规范文档
3. **自动化**：集成 Swagger UI，支持在线调试；从 OpenAPI 规范生成 TypeScript 类型定义
4. **可维护**：API 变更需更新文档，CI 校验规范一致性

## 3. 范围

### 包含
- 制定 API 设计规范文档（命名、版本、错误码、响应格式）
- 统一错误码管理（创建 `shared/errors.js` 错误码注册表）
- 为核心 API 生成 OpenAPI 3.0 规范文件（yaml 格式）
- 在 Gateway 集成 Swagger UI（访问 `/api-docs`）
- 创建错误码查询文档（`docs/api-spec/error-codes.md`）
- 添加请求/响应校验中间件（基于 OpenAPI schema）
- CI 检查：API 变更时校验 OpenAPI 规范有效性

### 不包含
- 前端 SDK 自动生成（后续需求）
- API Mock 服务器（后续需求）
- 性能优化（已在 REQ-00001）

## 4. 详细需求

### 4.1 API 设计规范文档

创建 `docs/api-spec/API-DESIGN-GUIDELINES.md`，包含：

**命名规范**
- RESTful 资源命名：复数名词（`/v1/users`, `/v1/pokemons`）
- 操作命名：使用标准 HTTP 方法（GET 查询, POST 创建, PUT 全量更新, PATCH 部分更新, DELETE 删除）
- 查询参数：驼峰命名（`pageSize`, `sortBy`）

**版本管理**
- URL 路径版本：`/v1/`, `/v2/`
- 版本升级策略：非破坏性变更（新增字段）不升级版本；破坏性变更需新版本并存至少 6 个月

**请求规范**
- Content-Type: `application/json`
- 必需 Header: `X-Request-ID`, `X-Trace-ID`（由 Gateway 注入）
- 认证 Header: `Authorization: Bearer {token}`
- 幂等性 Header: `X-Idempotency-Key`（POST/PUT 请求）

**响应规范**
统一响应格式：
```json
{
  "code": 0,           // 0 表示成功，非 0 表示业务错误
  "message": "string", // 人类可读消息
  "data": {},          // 业务数据
  "traceId": "uuid"    // 追踪 ID（由 Gateway 注入）
}
```

**分页规范**
```json
{
  "code": 0,
  "data": {
    "items": [],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

**错误响应**
```json
{
  "code": 2001,
  "message": "该手机号已注册",
  "data": null,
  "traceId": "uuid"
}
```

### 4.2 统一错误码管理

创建 `backend/shared/errors.js`：

```javascript
// 错误码注册表
const ERROR_CODES = {
  // 通用错误 1000-1999
  1001: { message: '参数错误', httpStatus: 400 },
  1002: { message: '未认证，请先登录', httpStatus: 401 },
  1003: { message: 'Token 无效或已过期', httpStatus: 401 },
  1007: { message: '请求过于频繁', httpStatus: 429 },
  
  // 用户相关 2000-2999
  2001: { message: '该手机号已注册', httpStatus: 409 },
  2002: { message: '昵称已被使用', httpStatus: 409 },
  2003: { message: '账号不存在', httpStatus: 404 },
  2004: { message: '账号已封禁', httpStatus: 403 },
  
  // 精灵/捕捉 3000-3999
  3001: { message: '精灵不存在', httpStatus: 404 },
  3002: { message: '捕捉距离过远', httpStatus: 400 },
  
  // 道馆/社交 4000-4999
  4001: { message: '道馆不存在', httpStatus: 404 },
  4002: { message: '道馆已被占领', httpStatus: 409 },
  
  // 支付 5000-5999
  5001: { message: '订单不存在', httpStatus: 404 },
  5002: { message: '订单已支付', httpStatus: 409 },
  5003: { message: '签名验证失败', httpStatus: 400 },
  
  // 系统错误 9000-9999
  9001: { message: '服务内部错误', httpStatus: 500 },
  9002: { message: '下游服务暂时不可用', httpStatus: 502 },
};

function getErrorInfo(code) {
  return ERROR_CODES[code] || { message: '未知错误', httpStatus: 500 };
}

module.exports = { ERROR_CODES, getErrorInfo };
```

### 4.3 OpenAPI 规范文件

创建 `docs/api-spec/openapi/` 目录结构：

```
docs/api-spec/openapi/
├── base.yaml                    # OpenAPI 基础定义（info, servers, components）
├── components/
│   ├── schemas.yaml            # 通用数据模型（User, Pokemon, Error）
│   ├── parameters.yaml         # 通用参数（page, pageSize, traceId）
│   └── responses.yaml          # 通用响应（401, 429, 500）
└── paths/
    ├── auth.yaml               # 认证相关接口
    ├── users.yaml              # 用户相关接口
    ├── map.yaml                # 地图/位置相关接口
    ├── catch.yaml              # 捕捉相关接口
    ├── gym.yaml                # 道馆相关接口
    ├── social.yaml             # 社交相关接口
    ├── reward.yaml             # 奖励相关接口
    └── payment.yaml            # 支付相关接口
```

**base.yaml 示例**：
```yaml
openapi: 3.0.3
info:
  title: mineGo API
  version: 1.0.0
  description: 基于 GPS 的 AR 精灵捕捉手游 API
  contact:
    name: mineGo Team
    email: support@minego.app

servers:
  - url: https://api.minego.app/v1
    description: Production
  - url: http://localhost:8080/v1
    description: Development

tags:
  - name: Auth
    description: 认证相关
  - name: Users
    description: 用户管理
  - name: Map
    description: 地图与位置
  - name: Catch
    description: 精灵捕捉
  - name: Gym
    description: 道馆系统
  - name: Social
    description: 社交系统
  - name: Reward
    description: 任务奖励
  - name: Payment
    description: 支付系统

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

**paths/auth.yaml 示例**：
```yaml
paths:
  /auth/sms-code:
    post:
      tags: [Auth]
      summary: 发送短信验证码
      operationId: sendSmsCode
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [phone, scene]
              properties:
                phone:
                  type: string
                  pattern: '^1[3-9]\d{9}$'
                  example: '13800138000'
                scene:
                  type: string
                  enum: [register, login, reset]
                  default: login
      responses:
        '200':
          description: 发送成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Success'
              example:
                code: 0
                message: 验证码已发送
                data:
                  expireIn: 300
                traceId: abc-123
        '429':
          $ref: '#/components/responses/TooManyRequests'
```

### 4.4 Swagger UI 集成

在 Gateway 添加 Swagger UI：

```javascript
// gateway/src/index.js
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const swaggerDocument = YAML.load('./docs/api-spec/openapi/bundled.yaml');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'mineGo API Docs'
}));
```

### 4.5 响应格式统一化

更新所有微服务使用统一响应格式：

**创建 `backend/shared/response.js`**：
```javascript
function successResp(data, message = '成功') {
  return {
    code: 0,
    message,
    data,
    traceId: this.traceId || null  // 从请求上下文获取
  };
}

function errorResp(code, message, data = null) {
  return {
    code,
    message,
    data,
    traceId: this.traceId || null
  };
}
```

### 4.6 请求校验中间件

创建 `backend/shared/validate.js`：
```javascript
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

function validate(schema) {
  return (req, res, next) => {
    const valid = ajv.validate(schema, req.body);
    if (!valid) {
      return res.status(400).json({
        code: 1001,
        message: '参数错误',
        data: { errors: ajv.errors },
        traceId: req.headers['x-trace-id']
      });
    }
    next();
  };
}
```

### 4.7 错误码文档

创建 `docs/api-spec/error-codes.md`：
```markdown
# mineGo 错误码参考

## 错误码范围

| 范围 | 类别 |
|------|------|
| 1000-1999 | 通用错误 |
| 2000-2999 | 用户相关 |
| 3000-3999 | 精灵/捕捉 |
| 4000-4999 | 道馆/社交 |
| 5000-5999 | 支付 |
| 9000-9999 | 系统错误 |

## 详细错误码

### 通用错误 (1000-1999)

| 错误码 | HTTP 状态 | 说明 | 解决方案 |
|--------|-----------|------|----------|
| 1001 | 400 | 参数错误 | 检查请求参数格式 |
| 1002 | 401 | 未认证 | 需要先登录 |
| 1003 | 401 | Token 无效 | 重新登录或刷新 Token |
| 1007 | 429 | 请求过于频繁 | 降低请求频率 |

...
```

### 4.8 CI 校验

添加 GitHub Actions 步骤：
```yaml
- name: Validate OpenAPI Spec
  run: |
    npx @apidevtools/swagger-cli validate docs/api-spec/openapi/bundled.yaml
```

## 5. 验收标准

- [ ] 创建 API 设计规范文档 `docs/api-spec/API-DESIGN-GUIDELINES.md`
- [ ] 创建统一错误码管理 `backend/shared/errors.js`，包含所有现有错误码
- [ ] 为核心 API（auth, users, map, catch, payment）生成 OpenAPI 3.0 规范文件
- [ ] Gateway 集成 Swagger UI，可通过 `/api-docs` 访问
- [ ] 创建错误码查询文档 `docs/api-spec/error-codes.md`
- [ ] 所有微服务响应格式统一为 `{ code, message, data, traceId }`
- [ ] CI 流程新增 OpenAPI 规范校验步骤
- [ ] 前端开发者可通过 Swagger UI 了解所有接口定义

## 6. 工作量估算

**L（Large）**

理由：
- 需要梳理 9 个微服务的所有 API
- 需要统一所有错误码（预计 50+ 个）
- 需要编写 OpenAPI 规范文件（预计 30+ 个接口）
- 需要更新所有服务的响应格式
- 需要充分测试确保不破坏现有功能

预计工时：2-3 天

## 7. 优先级理由

**P1** 理由：

1. **开发效率**：缺少 API 文档是当前最大的开发瓶颈，影响前后端协作
2. **项目可用性**：成熟度评分中"文档与开发者体验"仅 3/5 分，是重要缺口
3. **维护成本**：早期建立规范可避免后续重构成本
4. **依赖关系**：后续前端 SDK 生成、API Mock 等需求都依赖此规范

虽然不是 P0（不影响核心功能），但对项目长期可维护性至关重要。
