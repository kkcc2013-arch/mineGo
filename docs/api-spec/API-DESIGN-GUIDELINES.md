# mineGo API 设计规范

> 版本：1.0.0  
> 最后更新：2026-06-05

本文档定义 mineGo 项目所有 RESTful API 的设计规范，确保接口一致性、可维护性和开发效率。

---

## 1. 命名规范

### 1.1 资源命名

- 使用**复数名词**表示资源集合：`/v1/users`, `/v1/pokemons`, `/v1/gym`
- 使用**小写字母**和**连字符**（kebab-case）：`/v1/friend-requests`, `/v1/daily-quests`
- 避免**动词**作为资源名：❌ `/v1/getUser` → ✅ `GET /v1/users/{id}`
- 使用**嵌套资源**表示关系：`/v1/users/{id}/friends`, `/v1/gym/{id}/raids`

### 1.2 操作命名

使用标准 HTTP 方法表示操作：

| HTTP 方法 | 操作 | 示例 |
|-----------|------|------|
| GET | 查询资源 | `GET /v1/users/{id}` |
| POST | 创建资源 | `POST /v1/auth/register` |
| PUT | 全量更新资源 | `PUT /v1/users/{id}` |
| PATCH | 部分更新资源 | `PATCH /v1/users/{id}` |
| DELETE | 删除资源 | `DELETE /v1/friends/{id}` |

### 1.3 查询参数命名

- 使用**驼峰命名**（camelCase）：`pageSize`, `sortBy`, `createdAt`
- 布尔参数使用 `true/false`：`?isOnline=true`
- 数组参数使用逗号分隔或重复：`?ids=1,2,3` 或 `?ids=1&ids=2&ids=3`

### 1.4 字段命名

- 使用**驼峰命名**（camelCase）：`userId`, `createdAt`, `updatedAt`
- 避免缩写：❌ `usrId` → ✅ `userId`
- 时间字段统一后缀：`xxxAt`（如 `createdAt`, `expiredAt`）

---

## 2. 版本管理

### 2.1 版本策略

- **URL 路径版本**：`/v1/`, `/v2/`
- 当前版本：`v1`
- 版本号格式：`v{major}`（仅主版本号）

### 2.2 版本升级规则

**非破坏性变更**（不升级版本）：
- 新增可选参数
- 新增响应字段
- 新增接口

**破坏性变更**（需升级版本）：
- 删除或重命名接口
- 修改必填参数
- 修改响应字段类型
- 修改错误码

**版本共存策略**：
- 破坏性变更需发布新版本（如 `v2`）
- 旧版本需共存至少 **6 个月**
- 提前 3 个月发送下线通知

---

## 3. 请求规范

### 3.1 通用 Header

所有请求应包含：

```http
Content-Type: application/json
Accept: application/json
X-Request-ID: {uuid}          # 客户端生成，用于幂等性
X-Trace-ID: {uuid}            # 由 Gateway 注入，全链路追踪
```

### 3.2 认证 Header

需要认证的接口：

```http
Authorization: Bearer {accessToken}
```

### 3.3 幂等性 Header

POST/PUT 请求应包含：

```http
X-Idempotency-Key: {unique-key}  # 防止重复提交
```

### 3.4 请求体格式

- 使用 JSON 格式：`Content-Type: application/json`
- 日期时间使用 ISO 8601 格式：`2026-06-05T04:00:00Z`
- 金额使用**整数**（单位：分）：`199` 表示 1.99 元

---

## 4. 响应规范

### 4.1 统一响应格式

**成功响应**：

```json
{
  "code": 0,
  "message": "成功",
  "data": { ... },
  "traceId": "abc-123-def-456"
}
```

**错误响应**：

```json
{
  "code": 2001,
  "message": "该手机号已注册",
  "data": null,
  "traceId": "abc-123-def-456"
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| code | number | 业务状态码，0 表示成功，非 0 表示错误 |
| message | string | 人类可读的消息 |
| data | any | 业务数据，错误时为 `null` |
| traceId | string | 追踪 ID，用于日志关联 |

### 4.2 分页响应

```json
{
  "code": 0,
  "message": "成功",
  "data": {
    "items": [ ... ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 100,
      "totalPages": 5
    }
  },
  "traceId": "abc-123-def-456"
}
```

### 4.3 HTTP 状态码

| 状态码 | 说明 | 示例 |
|--------|------|------|
| 200 | 成功 | 查询成功 |
| 201 | 创建成功 | 注册成功 |
| 400 | 参数错误 | 缺少必填参数 |
| 401 | 未认证 | Token 无效 |
| 403 | 权限不足 | 访问他人资源 |
| 404 | 资源不存在 | 用户不存在 |
| 409 | 冲突 | 手机号已注册 |
| 429 | 请求过多 | 触发限流 |
| 500 | 服务器错误 | 内部异常 |
| 502 | 下游错误 | 服务不可用 |

---

## 5. 错误码规范

### 5.1 错误码范围

| 范围 | 类别 |
|------|------|
| 1000-1999 | 通用错误 |
| 2000-2999 | 用户相关 |
| 3000-3999 | 精灵/捕捉 |
| 4000-4999 | 道馆/社交 |
| 5000-5999 | 支付 |
| 9000-9999 | 系统错误 |

### 5.2 错误码定义

详见：[错误码参考](./error-codes.md)

所有错误码定义在：`backend/shared/errors.js`

---

## 6. 接口分类

### 6.1 公开接口

无需认证，如注册、登录、发送验证码。

### 6.2 认证接口

需要 `Authorization: Bearer {token}` Header。

### 6.3 管理接口

需要管理员权限，路径前缀：`/admin/`

---

## 7. 安全规范

### 7.1 认证方式

- 使用 JWT（JSON Web Token）
- Access Token 有效期：2 小时
- Refresh Token 有效期：7 天

### 7.2 敏感数据

- 密码、支付密钥等使用 bcrypt 加密
- 手机号脱敏显示：`138****8000`
- 日志中不记录敏感字段

### 7.3 防刷策略

- 接口限流：全局 200 次/分钟，敏感接口 20 次/分钟
- IP 黑名单：封禁恶意 IP
- 设备指纹：检测异常设备

---

## 8. 文档规范

### 8.1 OpenAPI 规范

所有公开接口必须提供 OpenAPI 3.0 规范文件，位于：`docs/api-spec/openapi/`

### 8.2 示例代码

每个接口应提供：
- 请求示例
- 响应示例
- 错误示例

### 8.3 更新日志

API 变更需记录在 `CHANGELOG.md`，包含：
- 变更日期
- 变更内容
- 影响范围
- 升级指南

---

## 9. 测试规范

### 9.1 单元测试

- 验证请求参数校验
- 验证响应格式
- 验证错误码

### 9.2 集成测试

- 验证完整业务流程
- 验证权限控制
- 验证错误处理

---

## 10. 最佳实践

### 10.1 幂等性

- GET、DELETE 天然幂等
- POST、PUT 使用 `X-Idempotency-Key` 确保幂等

### 10.2 缓存策略

- GET 请求可缓存
- 使用 `ETag` 和 `If-None-Match` 实现协商缓存
- 避免缓存敏感数据

### 10.3 错误处理

- 捕获所有异常，返回统一错误格式
- 记录详细日志（包含 traceId）
- 不暴露内部实现细节

### 10.4 性能优化

- 批量接口减少请求次数
- 字段按需返回（GraphQL 或字段过滤）
- 使用压缩（gzip）

---

## 附录

### A. 常用错误码速查

| 错误码 | 说明 |
|--------|------|
| 1001 | 参数错误 |
| 1002 | 未认证 |
| 1003 | Token 无效 |
| 1007 | 请求过多 |
| 2001 | 手机号已注册 |
| 2003 | 账号不存在 |
| 3001 | 精灵不存在 |
| 5001 | 订单不存在 |

### B. 参考资源

- [OpenAPI 3.0 规范](https://swagger.io/specification/)
- [RESTful API 设计指南](https://restfulapi.net/)
- [HTTP 状态码](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status)
