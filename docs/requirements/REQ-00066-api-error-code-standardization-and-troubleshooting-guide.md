# REQ-00066：API 错误码标准化与故障排查手册

- **编号**：REQ-00066
- **类别**：文档/开发者体验
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared、docs/api-spec、docs/troubleshooting
- **创建时间**：2026-06-09 21:15
- **依赖需求**：REQ-00008（OpenAPI 文档与 API 设计规范）

## 1. 背景与问题

当前 mineGo 项目存在以下问题：

1. **错误码不统一**：各微服务返回的错误码格式不一致，有的使用 HTTP 状态码，有的使用自定义数字码，有的使用字符串码，前端难以统一处理。

2. **错误信息缺乏上下文**：错误响应通常只包含简短描述，缺少错误码、请求ID、文档链接等关键信息，开发者无法快速定位问题。

3. **故障排查困难**：缺乏系统化的错误码文档和故障排查指南，当用户遇到错误时，需要翻阅源码才能理解错误含义。

4. **国际化缺失**：错误信息硬编码为英文或中文，无法根据用户语言偏好返回本地化错误信息。

5. **前端体验差**：前端需要针对每个 API 单独处理错误逻辑，无法实现统一的错误提示组件。

## 2. 目标

1. 建立统一的错误码体系，覆盖所有业务场景（认证、支付、捕捉、道馆、社交等）。
2. 所有 API 错误响应包含标准化字段：code、message、details、requestId、docUrl。
3. 提供完整的错误码文档和故障排查手册，开发者可快速定位问题。
4. 支持错误信息国际化（中/英/日）。
5. 前端可基于错误码实现统一的错误提示组件和重试策略。

## 3. 范围

### 包含
- 定义统一的错误码格式和分类规则
- 实现 `ErrorHandler` 中间件，标准化所有错误响应
- 创建错误码注册表，涵盖所有业务场景（预计 200+ 错误码）
- 编写错误码文档和故障排查手册
- 实现错误信息国际化
- 提供前端错误处理工具类

### 不包含
- 第三方服务错误码（支付网关、天气 API）的统一封装
- 移动端原生 SDK 的错误处理

## 4. 详细需求

### 4.1 错误码格式

采用分层错误码格式：`{服务码}{模块码}{错误序号}`

```
格式：SX-MMM-EEE
S: 服务码 (1=网关, 2=用户, 3=位置, 4=精灵, 5=捕捉, 6=道馆, 7=社交, 8=奖励, 9=支付)
X: 子系统码 (0=通用)
M: 模块码 (001=认证, 002=用户资料, 003=好友, ...)
E: 错误序号 (001-999)

示例：
  G1-001-001: 网关认证模块 - 无效的访问令牌
  U2-002-005: 用户服务 - 用户资料模块 - 用户名已被使用
  C5-001-010: 捕捉服务 - 捕捉模块 - 精灵已逃跑
```

### 4.2 标准错误响应格式

```json
{
  "success": false,
  "error": {
    "code": "G1-001-001",
    "message": "Invalid access token",
    "messageKey": "error.auth.invalid_token",
    "details": {
      "reason": "token_expired",
      "expiredAt": "2026-06-09T20:00:00Z"
    },
    "requestId": "req_abc123def456",
    "docUrl": "https://docs.minego.app/errors/G1-001-001",
    "retryable": false,
    "severity": "warning"
  },
  "timestamp": "2026-06-09T21:15:00Z"
}
```

### 4.3 错误分类

| 类别 | HTTP 状态码 | 说明 | 示例 |
|------|-------------|------|------|
| 认证错误 | 401 | 未认证或令牌无效 | 令牌过期、签名无效 |
| 权限错误 | 403 | 无权限访问资源 | 非管理员访问管理接口 |
| 资源错误 | 404 | 资源不存在 | 精灵不存在、用户不存在 |
| 验证错误 | 400 | 请求参数无效 | 缺少必填字段、格式错误 |
| 业务错误 | 422 | 业务规则冲突 | 精灵已逃跑、背包已满 |
| 限流错误 | 429 | 请求过于频繁 | 超出 API 调用限制 |
| 系统错误 | 500/503 | 服务内部错误 | 数据库连接失败、外部服务不可用 |

### 4.4 错误码注册表结构

```javascript
// backend/shared/errorCodes.js
module.exports = {
  // 网关错误 (G1-xxx-xxx)
  'G1-001-001': {
    code: 'G1-001-001',
    httpStatus: 401,
    message: 'Invalid access token',
    messageKey: 'error.auth.invalid_token',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    docUrl: '/errors/G1-001-001',
    troubleshooting: '请检查访问令牌是否正确，或重新登录获取新令牌。'
  },
  // ... 更多错误码
};
```

### 4.5 国际化支持

```json
// frontend/game-client/src/i18n/locales/zh-CN.json
{
  "error": {
    "auth": {
      "invalid_token": "无效的访问令牌",
      "token_expired": "登录已过期，请重新登录"
    }
  }
}
```

### 4.6 前端错误处理工具

```javascript
// frontend/game-client/src/utils/ErrorHandler.js
class ErrorHandler {
  static handle(error) {
    const errorCode = error.error?.code;
    const config = ERROR_CONFIGS[errorCode];
    
    // 根据错误类型显示不同提示
    if (config.retryable) {
      return this.showRetryDialog(error);
    }
    if (config.severity === 'critical') {
      return this.showCriticalAlert(error);
    }
    return this.showToast(error);
  }
  
  static getLocalizedMessage(error, locale) {
    return i18n.t(error.error?.messageKey, { defaultValue: error.error?.message });
  }
}
```

## 5. 验收标准

- [ ] 定义并实现统一的错误码格式（SX-MMM-EEE）
- [ ] 创建 ErrorHandler 中间件，所有 API 错误响应符合标准格式
- [ ] 错误码注册表包含至少 100 个业务错误码
- [ ] 错误响应包含所有标准字段：code、message、details、requestId、docUrl、retryable、severity
- [ ] 编写完整的错误码文档（docs/api/error-codes.md），包含所有错误码说明
- [ ] 编写故障排查手册（docs/troubleshooting/common-errors.md），覆盖 20+ 常见错误
- [ ] 实现错误信息国际化（中/英/日三语言）
- [ ] 提供前端 ErrorHandler 工具类
- [ ] 所有现有 API 迁移到新的错误码体系
- [ ] 单元测试覆盖率 ≥ 90%

## 6. 工作量估算

**L（Large）**

- 错误码定义和注册表创建：4 小时
- ErrorHandler 中间件开发：3 小时
- 现有 API 迁移：6 小时
- 国际化支持：2 小时
- 文档编写：4 小时
- 前端工具类开发：2 小时
- 单元测试：3 小时

总计：约 24 小时（3 个工作日）

## 7. 优先级理由

**P1 - 重要但非紧急**

1. **开发者体验提升**：标准化的错误码大幅降低前后端沟通成本，提升开发效率。
2. **用户体验改善**：前端可提供更友好的错误提示，而不是显示原始错误信息。
3. **运维效率提升**：完善的故障排查手册减少问题定位时间。
4. **国际化基础**：为全球化部署奠定基础。

该需求不影响核心业务功能，但对项目的可维护性和用户体验有显著提升，因此定为 P1。
