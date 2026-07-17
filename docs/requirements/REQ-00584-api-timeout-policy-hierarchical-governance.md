# REQ-00584：API 超时策略标准化与分级超时治理系统

- **编号**：REQ-00584
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared/timeoutPolicy.js、backend/gateway/src/middleware/timeoutMiddleware.js
- **创建时间**：2026-07-16 21:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目的 API 超时配置分散在各处且缺乏统一治理：

1. **circuitBreakers.js** 中硬编码了各服务的超时值（15s/20s/30s/60s），没有按接口粒度区分
2. **EventBus.js** 全局使用 30s requestTimeout，未区分消息类型
3. **RedisPoolManager.js** 使用固定的 10s connectTimeout
4. 缺乏客户端可见的超时策略声明（Retry-After、X-Request-Timeout 响应头）
5. 无超时分级体系——读操作、写操作、批量操作、流式操作应使用不同超时阈值
6. 缺少超时熔断联动：当某接口频繁超时时，没有自动降级或调整超时阈值的机制
7. 未对外暴露超时配置 API，运维无法动态调整

## 2. 目标

- 建立统一的 API 超时分级策略（L1~L4 四级超时体系）
- 提供集中式超时配置中心，支持按路由/方法/优先级配置不同超时
- 实现客户端超时协商机制（请求头声明期望超时，服务端返回实际超时）
- 超时阈值支持动态热更新，无需重启服务
- 超时指标接入 Prometheus，建立超时率 SLO 与自动告警

## 3. 范围

- **包含**：
  - 分级超时策略定义（L1 快速读 / L2 标准写 / L3 批量操作 / L4 流式长连接）
  - 集中式超时配置管理器（TimeoutPolicyManager）
  - 网关层超时中间件（per-route timeout enforcement）
  - 客户端超时协商协议（X-Client-Timeout / X-Server-Timeout 响应头）
  - 超时热更新 API（admin 端点）
  - Prometheus 超时指标（timeout_total, timeout_threshold_seconds, timeout_exceeded_total）
  - 超时率 SLO 与自动告警规则

- **不包含**：
  - 前端超时重试逻辑（属于客户端职责）
  - 数据库查询超时优化（属于 REQ-00581 范围）
  - WebSocket 长连接心跳超时（已有独立机制）

## 4. 详细需求

### 4.1 分级超时策略定义

```javascript
const TIMEOUT_LEVELS = {
  L1_FAST_READ: {
    description: '快速读操作（单个资源查询、缓存命中路径）',
    defaultMs: 3000,
    maxMs: 5000,
    examples: ['GET /api/v2/users/:id', 'GET /api/v2/pokemon/:id']
  },
  L2_STANDARD_WRITE: {
    description: '标准写操作（创建、更新、删除）',
    defaultMs: 10000,
    maxMs: 15000,
    examples: ['POST /api/v2/catch', 'PUT /api/v2/users/:id', 'POST /api/v2/trades']
  },
  L3_BATCH_OPERATION: {
    description: '批量操作（列表查询、批量导入、聚合统计）',
    defaultMs: 30000,
    maxMs: 60000,
    examples: ['GET /api/v2/pokemon?page=1&size=100', 'POST /api/v2/admin/import']
  },
  L4_STREAMING: {
    description: '流式长连接操作（道馆实时战斗、大范围地图查询）',
    defaultMs: 60000,
    maxMs: 120000,
    examples: ['WS /api/v2/gym/battle', 'GET /api/v2/map/region']
  }
};
```

### 4.2 集中式超时配置管理器

```javascript
// backend/shared/timeoutPolicy.js
class TimeoutPolicyManager {
  constructor() {
    this.policies = new Map();  // route -> policy
    this.defaults = TIMEOUT_LEVELS;
  }

  // 注册路由超时策略
  register(route, level, options = {}) { ... }

  // 获取路由超时阈值
  getTimeout(route, method) { ... }

  // 动态更新超时配置
  update(route, newTimeoutMs) { ... }

  // 热更新：从 Redis/ConfigCenter 加载最新配置
  async reloadFromConfig() { ... }
}
```

### 4.3 网关超时中间件

```javascript
// gateway/middleware/timeoutMiddleware.js
function timeoutMiddleware(policyManager) {
  return (req, res, next) => {
    const timeout = policyManager.getTimeout(req.route?.path, req.method);
    
    // 客户端协商
    const clientTimeout = parseInt(req.headers['x-client-timeout'], 10);
    const effectiveTimeout = clientTimeout
      ? Math.min(clientTimeout, timeout.maxMs)
      : timeout.defaultMs;
    
    // 设置响应头
    res.setHeader('X-Server-Timeout', effectiveTimeout);
    res.setHeader('X-Timeout-Level', timeout.level);
    
    // 超时中断
    req.setTimeout(effectiveTimeout, () => {
      res.status(408).json({
        error: { code: 1009, message: '请求超时', timeout: effectiveTimeout }
      });
    });
    
    next();
  };
}
```

### 4.4 Prometheus 指标

```
minego_api_timeout_threshold_seconds{route, method, level} - 当前超时阈值
minego_api_timeout_exceeded_total{route, method, level} - 超时次数计数
minego_api_timeout_negotiation_total{route, result} - 协商结果统计(accepted/capped/rejected)
```

### 4.5 超时热更新 Admin API

```
GET    /admin/timeout-policies          - 查询所有超时策略
PUT    /admin/timeout-policies/:route   - 更新指定路由超时阈值
POST   /admin/timeout-policies/reload   - 从配置中心重新加载
```

## 5. 验收标准（可测试）

- [ ] 四级超时体系（L1~L4）定义清晰，所有现有 API 路由已注册到对应级别
- [ ] 超时中间件在网关层生效，超时请求返回 408 和标准错误码 1009
- [ ] 客户端可通过 X-Client-Timeout 头协商超时，服务端返回 X-Server-Timeout 头
- [ ] 客户端请求超时值超过 maxMs 时被截断到 maxMs，协商结果计入 Prometheus
- [ ] Admin API 支持动态更新超时阈值，无需重启服务即可生效
- [ ] Prometheus 采集到 timeout_threshold_seconds 和 timeout_exceeded_total 指标
- [ ] 现有 circuitBreakers.js 中的硬编码超时值迁移到 TimeoutPolicyManager
- [ ] 单元测试覆盖率 >= 85%

## 6. 工作量估算

**M（中等）**
- 分级策略设计与实现：2 小时
- TimeoutPolicyManager 核心逻辑：3 小时
- 网关中间件集成：2 小时
- Admin API 与热更新：2 小时
- Prometheus 指标与告警规则：1.5 小时
- 迁移 circuitBreakers 硬编码：1 小时
- 测试与验证：2 小时
- 总计：约 1.5 个工作日

## 7. 优先级理由

P1 优先级原因：
1. 超时是 API 可靠性的基础——没有合理超时策略，级联故障风险高
2. 当前硬编码超时分散各处，运维无法根据业务变化动态调整
3. 客户端超时协商能力缺失，移动弱网环境下用户体验差
4. 属于 API 设计规范类核心需求，是项目达到生产可用标准的必要条件
5. 为后续熔断降级策略提供数据基础（超时率是熔断触发条件之一）
