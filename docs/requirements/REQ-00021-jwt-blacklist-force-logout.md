# REQ-00021：JWT 令牌黑名单与强制登出机制

- **编号**：REQ-00021
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared、Redis
- **创建时间**：2026-06-05 12:00
- **依赖需求**：无

## 1. 背景与问题

当前系统使用 JWT 令牌进行身份认证，但存在以下安全风险：

1. **令牌无法主动失效**：JWT 一旦签发，在过期前无法被撤销，即使用户修改密码、被管理员封禁或检测到异常行为，令牌仍然有效。

2. **缺少强制登出机制**：用户点击"退出登录"后，JWT 令牌仍在有效期内，可被恶意第三方继续使用。

3. **安全事件响应滞后**：检测到账户被盗用或异常登录时，无法立即让所有已签发令牌失效，攻击者仍有时间窗口进行操作。

4. **多设备登录管理缺失**：无法查看和管控用户在不同设备上的登录状态，无法实现"强制其他设备下线"功能。

根据 REQ-00003 已实现的支付安全加固，系统具备了金融级安全保障，但用户认证层面的令牌管理仍是短板。

## 2. 目标

建立完善的 JWT 令牌生命周期管理机制：

1. **令牌黑名单**：实现基于 Redis 的 JWT 黑名单，支持主动撤销令牌
2. **强制登出**：用户退出时立即使令牌失效
3. **安全响应**：密码修改、账户封禁时批量撤销令牌
4. **多设备管理**：用户可查看活跃会话并强制登出指定设备

预期收益：
- 将令牌被盗用的风险窗口从数小时缩短至秒级
- 提供用户可控的多设备登录管理
- 支持安全事件快速响应（账户泄露时 5 秒内撤销所有令牌）

## 3. 范围

**包含**：
- JWT 黑名单核心逻辑（Redis 存储与验证）
- Gateway 黑名单检查中间件
- user-service 会话管理 API（登录设备列表、强制登出）
- 批量撤销机制（密码修改、账户封禁时触发）
- 黑名单清理定时任务（已过期令牌自动清理）

**不包含**：
- 前端会话管理界面（单独需求）
- OAuth2 第三方登录令牌管理
- 分布式锁优化（单 Redis 实例足够）

## 4. 详细需求

### 4.1 JWT 黑名单数据结构

```
Redis Key设计：
- blacklist:token:{jti} -> "revoked_at_timestamp"
- blacklist:user:{user_id}:tokens -> Set<jti>
- blacklist:user:{user_id}:sessions -> Hash<jti, device_info_json>

TTL策略：
- 单个令牌黑名单：JWT剩余有效期 + 5分钟
- 用户令牌集合：无过期（由定时任务清理）
```

### 4.2 Gateway 中间件实现

```javascript
// backend/gateway/src/middleware/jwtBlacklist.js
const JWT_BLACKLIST_PREFIX = 'blacklist:token:';

async function checkBlacklist(jti) {
  const exists = await redisClient.exists(`${JWT_BLACKLIST_PREFIX}${jti}`);
  return exists === 1;
}

// 在 JWT 验证通过后，额外检查黑名单
// 黑名单命中返回 401 Unauthorized
// 添加 Prometheus 指标：blacklist_check_total, blacklist_hit_total
```

### 4.3 user-service API 设计

```
POST /api/v1/users/me/sessions/logout
  - 当前设备登出，令牌加入黑名单
  
POST /api/v1/users/me/sessions/logout-all
  - 所有设备登出（除当前设备）
  - 返回：已登出设备数量

GET /api/v1/users/me/sessions
  - 获取活跃会话列表
  - 返回：[{ jti, device_name, ip, last_active, created_at }]
  
DELETE /api/v1/users/me/sessions/:jti
  - 强制登出指定会话
```

### 4.4 批量撤销触发点

```javascript
// 1. 用户修改密码时
userRouter.put('/me/password', async (req, res) => {
  await revokeAllUserTokens(user_id);
  // ...
});

// 2. 管理员封禁用户时
adminRouter.post('/users/:id/ban', async (req, res) => {
  await revokeAllUserTokens(user_id);
  // ...
});

// 3. 检测到异常登录时（可扩展）
if (detectAnomalousLogin(user_id)) {
  await revokeAllUserTokens(user_id);
}
```

### 4.5 黑名单清理定时任务

```javascript
// backend/shared/tokenCleanup.js
// 每小时执行一次
// 扫描 blacklist:user:{user_id}:tokens
// 移除已过期 JWT 的 jti
// 防止集合无限增长
```

## 5. 验收标准（可测试）

- [ ] 用户点击登出后，原 JWT 在 5 秒内失效，后续请求返回 401
- [ ] 用户修改密码后，所有已签发令牌立即失效
- [ ] 用户可通过 API 查看所有活跃会话（含设备信息）
- [ ] 用户可强制登出指定设备，被登出设备请求返回 401
- [ ] "登出所有设备"功能正常，当前设备保持有效，其他设备全部失效
- [ ] 黑名单检查延迟 < 10ms（P99），不影响正常请求性能
- [ ] 定时清理任务能正确移除已过期令牌，集合不溢出
- [ ] 单元测试覆盖率 >= 90%（黑名单逻辑、会话管理 API）
- [ ] 集成测试：端到端验证登出流程
- [ ] Prometheus 指标正常采集（黑名单命中率、清理任务执行情况）

## 6. 工作量估算

**M（中等）**

理由：
- 核心逻辑清晰（Redis 黑名单），但需改动 Gateway 和 user-service
- API 数量适中（4 个端点）
- 需要定时任务和完善的错误处理
- 预计开发时间：2-3 天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **安全短板**：当前 JWT 无法撤销是认证安全的重大缺陷，影响整体安全评分
2. **用户体验**：用户无法管理多设备登录是常见投诉点
3. **事件响应**：安全事件（如账户泄露）需要快速响应能力
4. **依赖关系**：后续的"异常登录检测"（安全加固）依赖本需求的会话管理基础
5. **成熟度贡献**：直接提升"安全与合规"维度评分（从 15 -> 18）
