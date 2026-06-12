# REQ-00149: user-service ipAppeal 路由挂载与集成

- **编号**：REQ-00149
- **类别**：集成与修复
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：user-service、backend/services/user-service/src/index.js、backend/services/user-service/src/routes/ipAppeal.js
- **创建时间**：2026-06-12 08:10
- **依赖需求**：REQ-00075（IP 黑名单与恶意 IP 自动封禁系统）

## 1. 背景与问题

REQ-00075 实现了完整的 IP 黑名单与恶意 IP 自动封禁系统，包括用户端申诉路由 `ipAppeal.js`。该路由文件已存在，包含 3 个 API 端点：
- POST /api/ip-appeal - 提交封禁申诉
- GET /api/ip-appeal/status - 查询申诉状态
- GET /api/ip-appeal/check - 检查当前 IP 是否被封禁

但是，该路由从未在 `user-service/src/index.js` 中挂载，导致所有端点返回 404，用户无法提交申诉或查询申诉状态。这是一个典型的"孤儿路由"问题，违反了 GUIDELINES.md §4 质量红线第 2 条。

## 2. 目标

- 将 ipAppeal.js 路由挂载到 user-service
- 确保 3 个端点可通过网关访问
- 为被封禁用户提供申诉渠道
- 符合 REQ-00075 的原始设计意图

## 3. 范围

### 包含
- 在 user-service/src/index.js 中导入 ipAppealRouter
- 使用 app.use 挂载到合适路径
- 添加基础认证中间件（requireAuth）
- 验收命令验证 3 个端点可达

### 不包含
- ipAppeal.js 路由逻辑修改（已实现完整）
- IpBanManager 功能修改（已实现完整）
- 前端申诉界面开发（属于 game-client）

## 4. 详细需求

### 4.1 路由导入
在 `backend/services/user-service/src/index.js` 文件中：
```javascript
const ipAppealRouter = require('./routes/ipAppeal'); // REQ-00075: IP 封禁申诉路由
```

### 4.2 路由挂载
在路由数组中添加：
```javascript
{
  path: '/ip-appeal',
  router: ipAppealRouter,
  rateLimit: { windowMs: 60_000, max: 10, message: { code: 1007, message: '请求太频繁' } }
}
```

### 4.3 路径映射
挂载后的完整路径：
- POST /users/ip-appeal → 提交申诉
- GET /users/ip-appeal/status → 查询状态
- GET /users/ip-appeal/check → 检查 IP

注意：由于 ipAppeal.js 中已有路径处理（'/', '/status', '/check'），挂载路径应为 '/ip-appeal'。

### 4.4 认证需求
ipAppeal.js 路由内部已实现认证检查：
- POST / 和 GET /status 需要 req.user.id
- GET /check 不需要认证（公开检查 IP 状态）

因此路由挂载时**不添加全局 requireAuth**，保持路由内部认证逻辑。

### 4.5 限流配置
申诉接口敏感，建议：
- POST / → 10 次/分钟
- GET /status → 30 次/分钟
- GET /check → 60 次/分钟

## 5. 验收标准（可测试）

- [ ] `node --check backend/services/user-service/src/index.js` 通过
- [ ] `grep -n "ipAppealRouter" backend/services/user-service/src/index.js` 返回至少 1 行
- [ ] `grep -n "app.use.*ip-appeal\|path.*ip-appeal" backend/services/user-service/src/index.js` 返回挂载配置
- [ ] 启动 user-service 后，`curl -sf http://localhost:8081/ip-appeal/check` 返回 200（公开端点）
- [ ] 启动 user-service 后，`curl -sf http://localhost:8081/ip-appeal/status -H "Authorization: Bearer invalid"` 返回 401（认证端点）
- [ ] `npm test --prefix backend/services/user-service` 通过（如有相关测试）

## 6. 工作量估算

**S**（Small）

理由：
- 仅需添加 2-3 行代码（导入 + 挂载）
- 无需修改业务逻辑
- ipAppeal.js 已完整实现
- 风险低，改动面小

## 7. 优先级理由

### P0 的原因：
1. **用户权益影响**：被封禁用户无法申诉，违反公平性原则
2. **合规需求**：申诉机制是安全系统的必要组成部分
3. **已完成功能不可用**：REQ-00075 已标记 done，但核心功能不可达
4. **符合 GUIDELINES §5 配比**：集成与修复优先级最高（3/10）
5. **属于 §6 欠账清单**：明确列在 user-service 未挂载路由清单中

### 对"项目可用"的贡献：
- 完善用户权益保护机制
- 提升安全系统完整性
- 填补 REQ-00075 的功能缺口
- 符合"生产可用"标准
