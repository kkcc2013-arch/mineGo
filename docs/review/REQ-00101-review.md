# REQ-00101 Review：后端 API 错误消息国际化系统

**审核时间**：2026-06-14 19:10 UTC  
**审核状态**：✅ 已审核通过

---

## 1. 实现检查清单

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 统一错误码系统 | ✅ | 创建 `errorCodes.js`，定义 91 个标准化错误码 |
| 错误消息翻译管理 | ✅ | 创建 `errorMessages.js`，支持中/英/日三语 |
| API 错误处理中间件 | ✅ | 创建 `errorHandler.js`，自动本地化错误消息 |
| 错误消息参数化 | ✅ | 支持 `{param}` 格式参数插值 |
| 单元测试覆盖 | ✅ | 创建 `errorHandler.test.js`，全部通过 |
| 预定义错误工厂 | ✅ | 提供 `Errors` 对象快速创建常见错误 |
| 异步处理包装器 | ✅ | 提供 `asyncHandler` 包装异步路由 |

---

## 2. 核心实现文件

### 2.1 backend/shared/errorCodes.js
- 定义 91 个标准化错误码
- 错误码范围：
  - 1xxx: 通用错误
  - 2xxx: 用户服务
  - 3xxx: 精灵服务
  - 4xxx: 捕捉服务
  - 5xxx: 道馆服务
  - 6xxx: 社交服务
  - 7xxx: 支付服务
  - 8xxx: 奖励服务
  - 9xxx: GPS 反作弊
  - 10xxx: GDPR 合规
  - 11xxx: 位置服务
  - 12xxx: 网关错误
- 每个错误码包含：code、httpStatus、category

### 2.2 backend/shared/errorMessages.js
- 支持语言：zh-CN、en-US、ja-JP
- 所有错误码都有三语翻译
- 支持参数插值：`{paramName}`

### 2.3 backend/shared/errorHandler.js
- `AppError` 类：标准化应用错误
- `Errors` 对象：预定义错误工厂
- `errorHandler` 中间件：自动本地化
- `getUserLanguage` 函数：解析用户语言偏好
- `asyncHandler` 包装器：异步错误捕获

---

## 3. 使用示例

```javascript
// 在路由中使用
const { Errors, asyncHandler } = require('../shared/errorHandler');

// 方式 1：使用预定义错误工厂
router.get('/user/:id', asyncHandler(async (req, res) => {
  const user = await getUser(req.params.id);
  if (!user) {
    throw Errors.userNotFound({ userId: req.params.id });
  }
  res.json({ success: true, data: user });
}));

// 方式 2：创建自定义错误
const { AppError } = require('../shared/errorHandler');
throw new AppError('INSUFFICIENT_RESOURCES', {
  resource: '精币',
  required: 100,
  current: 50
});

// 方式 3：包装异步路由
router.post('/catch', asyncHandler(async (req, res) => {
  // 自动捕获 Promise 错误
  const result = await catchPokemon(req.body);
  res.json({ success: true, data: result });
}));
```

---

## 4. API 响应格式

### 成功响应
```json
{
  "success": true,
  "data": { ... }
}
```

### 错误响应（自动本地化）
```json
{
  "success": false,
  "error": {
    "code": 2001,
    "name": "USER_NOT_FOUND",
    "message": "用户不存在"
  }
}
```

### 带参数的错误响应
```json
{
  "success": false,
  "error": {
    "code": 3003,
    "name": "INSUFFICIENT_RESOURCES",
    "message": "精币不足，需要 100，当前 50"
  }
}
```

---

## 5. 语言偏好解析优先级

1. 查询参数 `?lang=zh-CN`（用于测试）
2. 用户设置 `req.user.language`
3. HTTP 头 `Accept-Language: zh-CN,zh;q=0.9`
4. 默认语言 `en-US`

---

## 6. 测试结果

```
Testing errorCodes.js...
✅ errorCodes.js tests passed

Testing errorMessages.js...
✅ errorMessages.js tests passed

Testing errorHandler.js...
✅ errorHandler.js tests passed

Testing error code coverage...
✅ All error codes have translations

========================================
All errorHandler tests passed! ✅
========================================

Test Summary:
- Error codes defined: 91
- Supported languages: zh-CN, en-US, ja-JP
- Default language: en-US
```

---

## 7. 待集成服务

以下服务需要更新错误处理代码以使用新的错误系统：

| 服务 | 状态 | 优先级 |
|------|------|--------|
| gateway | 待集成 | P0 |
| user-service | 待集成 | P1 |
| pokemon-service | 待集成 | P1 |
| catch-service | 待集成 | P1 |
| gym-service | 待集成 | P1 |
| social-service | 待集成 | P1 |
| payment-service | 待集成 | P1 |
| reward-service | 待集成 | P1 |
| location-service | 待集成 | P1 |

---

## 8. 审核结论

**✅ 审核通过**

实现完整，代码质量高，测试覆盖充分。建议后续：

1. 在 gateway 中集成错误处理中间件
2. 逐步迁移各服务的错误处理代码
3. 添加 Prometheus 指标监控错误分布
4. 考虑添加错误消息管理 API（支持动态更新翻译）
