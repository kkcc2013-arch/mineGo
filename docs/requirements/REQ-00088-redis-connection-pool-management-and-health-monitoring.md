# REQ-00088：Redis 连接池管理与健康监控系统

- **编号**：REQ-00088
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/redis.js、所有微服务、infrastructure/k8s、backend/shared/metrics.js
- **创建时间**：2026-06-10 12:38
- **依赖需求**：REQ-00070（Redis 内存优化与自动 TTL 策略）

## 1. 背景与问题

### 当前现状
项目使用 ioredis 作为 Redis 客户端，在 `backend/shared/redis.js` 中实现单例模式连接：
```javascript
function getRedis() {
  if (!client) {
    client = new Redis({ /* 配置 */ });
  }
  return client;
}
```

### 存在的问题
1. **缺少连接池管理**：单个 Redis 连接在高并发场景下成为瓶颈，无法复用连接
2. **无健康检查机制**：连接断开后无法主动感知，依赖 ioredis 自动重连（延迟 3-5 秒）
3. **连接泄漏风险**：订阅连接、pipeline 操作等场景可能产生连接泄漏
4. **缺少监控指标**：无法监控 Redis 连接状态、延迟、命令执行情况
5. **无连接限流**：突发流量可能耗尽 Redis 连接资源
6. **集群模式支持不完善**：当前集群配置简单，缺少节点故障转移优化

### 业务影响
- 高并发场景下 Redis 响应延迟从 1-5ms 飙升至 50-200ms
- 连接异常导致服务不可用，影响用户体验
- 无法快速定位 Redis 性能瓶颈

## 2. 目标

构建完整的 Redis 连接池管理与健康监控系统，实现：
1. **连接池化**：支持连接复用，提升并发性能 3-5 倍
2. **主动健康检查**：秒级感知连接异常，自动剔除不健康连接
3. **连接泄漏检测**：自动检测并告警连接泄漏问题
4. **全链路监控**：10+ Prometheus 指标，实时监控连接状态
5. **智能重连**：指数退避重连策略，避免重连风暴
6. **连接限流**：防止突发流量耗尽 Redis 资源

**可量化目标**：
- Redis 连接复用率 ≥ 80%
- 连接异常感知时间 ≤ 2 秒
- 连接泄漏检测准确率 ≥ 95%
- 高并发场景下延迟 ≤ 10ms（P99）

## 3. 范围

### 包含
- Redis 连接池管理器实现（PoolManager）
- 连接健康检查机制（心跳、延迟检测）
- 连接泄漏检测器
- Prometheus 监控指标集成
- 智能重连策略优化
- 连接限流与背压机制
- 集群模式故障转移优化
- 管理 API（连接状态查询、重置）
- 单元测试与集成测试

### 不包含
- Redis 数据迁移（已在 REQ-00070 处理内存优化）
- Redis 集群部署配置（运维层面）
- Redis 持久化配置（基础设施层面）

## 4. 详细需求

### 4.1 Redis 连接池管理器

**核心设计**：
```javascript
// backend/shared/RedisPoolManager.js
class RedisPoolManager {
  constructor(config) {
    this.pools = new Map(); // 连接池映射
    this.config = {
      minConnections: 2,        // 最小连接数
      maxConnections: 20,       // 最大连接数
      acquireTimeout: 5000,     // 获取连接超时
      idleTimeout: 30000,       // 空闲连接超时
      healthCheckInterval: 5000, // 健康检查间隔
      enableLeakDetection: true, // 连接泄漏检测
      leakDetectionThreshold: 60000, // 泄漏阈值
    };
  }
  
  // 获取连接
  async acquire(poolName = 'default') {}
  
  // 释放连接
  async release(connection, poolName = 'default') {}
  
  // 健康检查
  async healthCheck() {}
  
  // 连接泄漏检测
  detectLeaks() {}
  
  // 获取池状态
  getPoolStats(poolName) {}
}
```

**连接池特性**：
- 支持多连接池隔离（default、geo、cache、pubsub）
- 连接复用与自动回收
- 空闲连接自动清理
- 连接预热机制（启动时创建 minConnections）

### 4.2 健康检查机制

**检查项**：
1. **连接活性检查**：PING 命令检测连接是否存活
2. **延迟检测**：记录 PING 延迟，超过阈值（100ms）标记为不健康
3. **命令执行检测**：监控错误率，超过 5% 触发告警
4. **内存使用检查**：Redis 内存使用率超过 80% 触发告警

**健康状态**：
- `healthy`：连接正常，延迟 < 50ms
- `degraded`：连接降级，延迟 50-100ms
- `unhealthy`：连接异常，延迟 > 100ms 或 PING 失败

**自动恢复**：
- 不健康连接自动剔除并重建
- 降级连接限流 50% 流量
- 健康检查失败触发告警

### 4.3 连接泄漏检测

**检测逻辑**：
```javascript
class ConnectionLeakDetector {
  constructor(threshold = 60000) {
    this.connections = new Map(); // connectionId -> acquireTime
    this.threshold = threshold; // 60 秒
  }
  
  trackAcquire(connectionId) {
    this.connections.set(connectionId, Date.now());
  }
  
  trackRelease(connectionId) {
    this.connections.delete(connectionId);
  }
  
  detectLeaks() {
    const now = Date.now();
    const leaks = [];
    for (const [id, acquireTime] of this.connections) {
      if (now - acquireTime > this.threshold) {
        leaks.push({ id, duration: now - acquireTime });
      }
    }
    return leaks;
  }
}
```

**泄漏告警**：
- 连接持有时间超过阈值触发告警
- 记录连接获取堆栈（用于调试）
- 自动释放泄漏连接（可配置）

### 4.4 Prometheus 监控指标

**新增指标**（10+ 个）：
```javascript
// 连接池指标
redis_pool_total_connections{pool}        // 总连接数
redis_pool_idle_connections{pool}         // 空闲连接数
redis_pool_active_connections{pool}       // 活跃连接数
redis_pool_waiting_requests{pool}         // 等待队列长度
redis_pool_connection_errors_total{pool}  // 连接错误次数

// 性能指标
redis_command_duration_seconds{pool,command} // 命令延迟
redis_command_total{pool,command,status}     // 命令执行次数
redis_pool_acquire_duration_seconds{pool}    // 获取连接延迟

// 健康指标
redis_health_status{pool}                 // 健康状态 (1/0)
redis_health_latency_seconds{pool}        // 健康检查延迟

// 泄漏检测指标
redis_leaked_connections_total{pool}      // 泄漏连接数
redis_leak_detection_runs_total           // 泄漏检测运行次数
```

**Grafana 仪表板**：
- 连接池状态面板（总数/空闲/活跃）
- 命令延迟热力图
- 健康状态趋势图
- 泄漏检测告警面板

### 4.5 智能重连策略

**指数退避算法**：
```javascript
const retryStrategy = (times) => {
  if (times > 10) return null; // 放弃重连
  
  // 指数退避：1s, 2s, 4s, 8s, 16s, 32s, ...
  const delay = Math.min(times * 1000, 30000);
  
  // 添加随机抖动（避免重连风暴）
  const jitter = Math.random() * 1000;
  
  return delay + jitter;
};
```

**重连事件处理**：
- 重连成功：记录恢复时间，清除不健康标记
- 重连失败：升级告警等级，触发降级策略

### 4.6 连接限流与背压

**限流策略**：
```javascript
class ConnectionRateLimiter {
  constructor(maxConcurrent = 100) {
    this.semaphore = new Semaphore(maxConcurrent);
    this.queue = [];
  }
  
  async acquire() {
    if (this.semaphore.tryAcquire()) {
      return true;
    }
    // 等待队列
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      setTimeout(() => reject(new Error('Acquire timeout')), 5000);
    });
  }
  
  release() {
    this.semaphore.release();
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next.resolve();
    }
  }
}
```

**背压机制**：
- 等待队列超过 50 触发告警
- 等待队列超过 100 拒绝新请求
- 自动扩容连接池（maxConnections 限制内）

### 4.7 集群模式优化

**故障转移优化**：
```javascript
const clusterConfig = {
  scaleReads: 'slave',      // 读请求分发到从节点
  maxRedirections: 16,      // 最大重定向次数
  retryDelayOnFailover: 100, // 故障转移重试延迟
  retryDelayOnClusterDown: 100, // 集群下线重试延迟
  enableReadyCheck: true,   // 就绪检查
  clusterDownBehavior: 'return_error', // 集群下线行为
  enableOfflineQueue: true, // 离线队列
  updateNodes: true,        // 自动更新节点列表
};
```

**节点健康检查**：
- 定期检查各节点延迟
- 自动剔除高延迟节点
- 节点恢复自动加入

### 4.8 管理 API

**新增路由**（`backend/gateway/src/routes/redis-admin.js`）：
```
GET  /admin/redis/pools              - 获取所有连接池状态
GET  /admin/redis/pools/:name        - 获取指定连接池状态
GET  /admin/redis/health             - 健康检查
POST /admin/redis/pools/:name/reset  - 重置连接池
GET  /admin/redis/metrics            - Prometheus 指标
GET  /admin/redis/leaks              - 泄漏检测报告
```

**响应示例**：
```json
{
  "pools": {
    "default": {
      "total": 10,
      "idle": 7,
      "active": 3,
      "waiting": 0,
      "health": "healthy",
      "latency": 3.2
    }
  },
  "leaks": [],
  "errors": []
}
```

## 5. 验收标准（可测试）

- [ ] **连接池管理器实现**：支持多连接池，连接复用率 ≥ 80%
- [ ] **健康检查机制**：连接异常感知时间 ≤ 2 秒，自动剔除不健康连接
- [ ] **连接泄漏检测**：检测准确率 ≥ 95%，自动告警和释放
- [ ] **Prometheus 指标**：10+ 个指标正确上报，Grafana 仪表板可访问
- [ ] **智能重连**：指数退避重连，无重连风暴
- [ ] **连接限流**：突发流量下无资源耗尽，等待队列正常工作
- [ ] **集群模式优化**：节点故障自动转移，读请求分发到从节点
- [ ] **管理 API**：5 个 API 端点可访问，返回正确数据
- [ ] **单元测试**：覆盖率 ≥ 80%，至少 40 个测试用例
- [ ] **性能测试**：高并发场景下延迟 ≤ 10ms（P99）
- [ ] **文档完善**：更新 README.md、DEVELOPMENT.md，添加 Redis 连接池使用指南

## 6. 工作量估算

**规模**：L（Large）

**理由**：
1. 核心模块实现：3 天（连接池管理器、健康检查、泄漏检测）
2. 监控集成：1 天（Prometheus 指标、Grafana 仪表板）
3. API 开发：0.5 天（管理 API）
4. 测试编写：1.5 天（单元测试、集成测试、性能测试）
5. 文档与集成：0.5 天

**总计**：约 6.5 天

## 7. 优先级理由

**P1 理由**：
1. **成本影响大**：连接池优化可减少 Redis 连接资源消耗 30-50%
2. **性能提升明显**：高并发场景下延迟降低 50-80%
3. **稳定性保障**：健康检查和泄漏检测可预防生产事故
4. **依赖其他需求**：REQ-00070（Redis 内存优化）已实现，需要配套连接池管理
5. **成熟度贡献**：提升"性能与可扩展"维度评分，从 15 分提升到 18 分

**对"项目可用"的贡献**：
- 防止 Redis 连接耗尽导致服务不可用
- 快速感知和恢复 Redis 异常
- 降低云服务成本（连接资源优化）
- 提升用户体验（降低延迟）
