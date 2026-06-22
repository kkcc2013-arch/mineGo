# REQ-00285：服务实例优雅停机与连接排空系统

- **编号**：REQ-00285
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared, gateway, 所有微服务, k8s
- **创建时间**：2026-06-22 07:00
- **依赖需求**：REQ-00006, REQ-00014

## 1. 背景与问题

当前 mineGo 微服务在 Kubernetes 环境中运行，但在滚动更新、缩容或故障转移时存在以下问题：

1. **连接中断**：Pod 终止时，正在处理的请求可能被强制中断，导致用户操作失败
2. **数据不一致**：数据库事务在服务停止时未完成，可能造成数据不一致
3. **WebSocket 断开**：实时战斗、聊天等长连接被突然断开，用户体验差
4. **健康检查延迟**：K8s 在 Pod 标记为 Terminating 后仍可能将流量路由到该 Pod
5. **资源泄漏**：数据库连接、Redis 连接、Kafka 消费者未正确关闭

这些问题在高峰期滚动更新时尤为严重，可能导致大量用户请求失败。

## 2. 目标

实现生产级优雅停机系统，确保：
- 正在处理的请求能够正常完成
- 新请求被正确拒绝并路由到健康实例
- 所有资源（连接、句柄）被正确释放
- WebSocket 连接被优雅关闭并通知客户端重连
- 滚动更新期间零请求失败

## 3. 范围

- **包含**：
  - 优雅停机信号处理器（SIGTERM/SIGINT）
  - 连接排空机制与超时控制
  - 健康检查状态切换
  - WebSocket 优雅关闭
  - 资源清理钩子
  - K8s preStop 钩子集成
  - 停机进度监控端点

- **不包含**：
  - 客户端重连逻辑（已有实现）
  - 数据库事务补偿（REQ-00284 已覆盖）
  - 服务网格配置（Istio/Linkerd）

## 4. 详细需求

### 4.1 核心组件

#### 4.1.1 GracefulShutdownManager
```javascript
class GracefulShutdownManager {
  constructor(options) {
    this.shutdownTimeout = options.shutdownTimeout || 30000; // 30秒
    this.connectionDrainTimeout = options.drainTimeout || 10000; // 10秒
    this.isShuttingDown = false;
    this.activeConnections = new Set();
    this.shutdownHooks = [];
  }

  // 注册停机钩子
  registerHook(name, hook, priority = 0);

  // 标记开始停机
  beginShutdown(reason);

  // 等待所有连接完成
  waitForConnections();

  // 执行清理钩子
  executeHooks();
}
```

#### 4.1.2 ConnectionTracker
```javascript
class ConnectionTracker {
  // 跟踪 HTTP 连接
  trackRequest(req, res, next);

  // 跟踪 WebSocket 连接
  trackWebSocket(ws);

  // 获取活跃连接数
  getActiveCount();

  // 获取连接详情
  getConnectionStats();
}
```

#### 4.1.3 HealthCheckController
```javascript
// /health/live - 存活探针
// /health/ready - 就绪探针
// /health/draining - 排空状态探针

// 停机时：
// live: true（进程存活）
// ready: false（拒绝新流量）
// draining: true（正在排空连接）
```

### 4.2 优雅停机流程

```
1. 收到 SIGTERM 信号
2. 标记 isShuttingDown = true
3. 健康检查 /health/ready 返回 503
4. 停止接受新连接（close() 但不销毁）
5. 等待活跃请求完成（最多 drainTimeout）
6. 通知 WebSocket 客户端重连
7. 执行清理钩子（按优先级）：
   - 停止 Kafka 消费者
   - 完成数据库事务
   - 关闭 Redis 连接
   - 清理定时器
8. 等待所有钩子完成（最多 shutdownTimeout）
9. 退出进程（code 0）
```

### 4.3 WebSocket 优雅关闭

```javascript
// 通知客户端服务即将重启
ws.send(JSON.stringify({
  type: 'SERVER_SHUTDOWN',
  reason: 'ROLLING_UPDATE',
  reconnectDelay: 5000,
  reconnectUrl: 'wss://gateway.example.com/ws'
}));

// 等待客户端确认或超时
await waitForClientAckOrTimeout(ws, 5000);

// 关闭连接
ws.close(1001, 'Server shutting down');
```

### 4.4 K8s 集成

```yaml
# Pod lifecycle 配置
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "curl -X POST http://localhost:3000/shutdown"]

# 探针配置
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 10

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 5

# 终止宽限期
terminationGracePeriodSeconds: 60
```

### 4.5 监控指标

```javascript
// Prometheus 指标
graceful_shutdown_total{reason, status}
graceful_shutdown_duration_seconds
active_connections_during_shutdown
shutdown_hook_duration_seconds{hook_name}
websocket_drain_count{status}
```

### 4.6 配置项

```javascript
const shutdownConfig = {
  // 总停机超时（秒）
  shutdownTimeout: 30,
  
  // 连接排空超时（秒）
  drainTimeout: 10,
  
  // WebSocket 关闭超时（秒）
  wsCloseTimeout: 5,
  
  // 是否启用优雅停机
  enabled: true,
  
  // 停机前等待时间（给 Ingress 时间更新路由）
  preWaitMs: 5000,
  
  // 清理钩子超时（秒）
  hookTimeout: 5
};
```

## 5. 验收标准（可测试）

- [ ] 收到 SIGTERM 后，正在处理的 HTTP 请求能够正常完成并返回响应
- [ ] 停机期间新请求收到 503 Service Unavailable 响应
- [ ] WebSocket 连接收到 SERVER_SHUTDOWN 消息后被正确关闭
- [ ] 所有数据库连接在停机时被正确释放（无连接泄漏）
- [ ] 所有 Redis 连接在停机时被正确关闭
- [ ] Kafka 消费者在停机时停止消费并提交当前 offset
- [ ] 健康检查端点正确反映停机状态（live=true, ready=false）
- [ ] 停机过程在配置的超时时间内完成
- [ ] Prometheus 指标正确记录停机事件
- [ ] 滚动更新期间无请求失败（通过 E2E 测试验证）
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 集成测试覆盖 K8s 环境

## 6. 工作量估算

**L（Large）**

理由：
- 需要修改所有 9 个微服务的启动逻辑
- 需要与 K8s 生命周期深度集成
- WebSocket 优雅关闭需要客户端配合
- 需要充分的测试验证（单元测试 + 集成测试 + E2E 测试）
- 预计工作量：3-4 人日

## 7. 优先级理由

**P1 理由：**

1. **生产稳定性**：直接影响滚动更新期间的用户体验和服务稳定性
2. **数据安全**：防止因强制停机导致的数据不一致
3. **高可用保障**：是零停机部署的关键基础设施
4. **影响范围广**：所有微服务都需要此能力
5. **依赖关系**：REQ-00006（滚动更新）和 REQ-00014（熔断器）的补充

当前项目成熟度评分 84 分，缺少优雅停机能力是高可用维度的明显短板。
