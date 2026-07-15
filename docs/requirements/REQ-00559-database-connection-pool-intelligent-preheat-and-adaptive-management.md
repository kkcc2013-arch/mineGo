# REQ-00559：数据库连接池智能预热与自适应管理系统

- **编号**：REQ-00559
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/db, 所有微服务, infrastructure/monitoring
- **创建时间**：2026-07-15 09:00
- **依赖需求**：REQ-00015 数据库连接池优化（部分实现）

## 1. 背景与问题

mineGo 项目采用 PostgreSQL 15 作为主数据库，所有微服务通过 `backend/shared/db` 模块共享数据库连接池。当前实现存在以下性能问题：

### 现状分析

1. **冷启动延迟**：
   - 服务重启后首次数据库查询响应时间高达 500-2000ms
   - 连接池预热不足，导致用户首次请求体验差
   - 新实例扩容时缺少预加载机制

2. **连接池管理粗放**：
   - 使用固定连接池大小（默认10），未根据负载动态调整
   - 高峰期连接等待超时，低谷期资源浪费
   - 缺少基于时间段的智能调度（如凌晨低负载时段）

3. **健康检查缺失**：
   - 未检测连接池实际可用性
   - 连接泄漏、超时等问题无自动恢复
   - 缺少连接质量的实时监控和告警

4. **与业务场景脱节**：
   - 未结合用户活跃时段（早晚高峰）预预热
   - Raid、道馆战斗等高并发场景缺少专项优化
   - 活动运营无法提前扩容连接池

### 用户影响

- 用户首次打开App加载慢，影响留存
- 高峰时段API响应延迟增加30-50%
- 服务器资源利用率不均衡，浪费成本

## 2. 目标

构建智能的数据库连接池管理系统：

1. **智能预热**：服务启动时自动预热连接池，首次查询延迟降低80%
2. **自适应调整**：根据负载动态调整连接池大小，资源利用率提升40%
3. **健康监控**：实时监控连接池状态，异常自动恢复，故障率降低90%
4. **时段调度**：结合业务高峰时段预扩容，关键时段响应时间稳定在50ms内
5. **活动支持**：支持运营活动提前扩容，保障高并发场景性能

## 3. 范围

### 包含

- 连接池预热机制（启动时、时段调度）
- 自适应连接池大小调整算法
- 连接健康检查与自动恢复
- Prometheus 监控指标与 Grafana 仪表板
- 与业务高峰时段集成的智能调度
- 运营活动连接池预扩容 API

### 不包含

- 数据库分库分表（属于 REQ-00027 数据库分区策略）
- 读写分离（属于 REQ-00259 数据库读写分离）
- 连接池配置热更新（作为后续需求）

## 4. 详细需求

### 4.1 智能预热机制

**启动预热**：
```javascript
// backend/shared/db/poolPreheater.js
class PoolPreheater {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.minConnections = options.minConnections || 5;
    this.warmupQueries = options.warmupQueries || [];
  }

  async preheat() {
    const startTime = Date.now();
    const tasks = [];
    
    // 1. 创建最小连接数
    for (let i = 0; i < this.minConnections; i++) {
      tasks.push(this.createAndWarmupConnection());
    }
    
    // 2. 执行预热查询
    for (const query of this.warmupQueries) {
      tasks.push(this.executeWarmupQuery(query));
    }
    
    await Promise.all(tasks);
    
    const duration = Date.now() - startTime;
    logger.info('Pool preheated', {
      connections: this.minConnections,
      duration,
      poolSize: this.pool.totalCount
    });
  }

  async createAndWarmupConnection() {
    const client = await this.pool.connect();
    await client.query('SELECT 1'); // 简单查询激活连接
    client.release();
  }
}
```

**时段调度预热**：
- 配置高峰时段（早8-10点、晚18-22点）
- 提前30分钟自动扩容连接池
- 支持自定义时段配置

### 4.2 自适应连接池调整

**动态调整算法**：
```javascript
// backend/shared/db/adaptivePool.js
class AdaptivePoolManager {
  constructor(pool, config = {}) {
    this.pool = pool;
    this.config = {
      minSize: config.minSize || 5,
      maxSize: config.maxSize || 50,
      scaleUpThreshold: config.scaleUpThreshold || 0.8,  // 80%使用率
      scaleDownThreshold: config.scaleDownThreshold || 0.3, // 30%使用率
      checkIntervalMs: config.checkIntervalMs || 60000 // 1分钟检查一次
    };
    
    this.currentSize = this.config.minSize;
    this.metrics = {
      waitingCount: 0,
      idleCount: 0,
      totalCount: 0
    };
  }

  start() {
    this.timer = setInterval(() => this.adjust(), this.config.checkIntervalMs);
  }

  async adjust() {
    const metrics = {
      waiting: this.pool.waitingCount,
      idle: this.pool.idleCount,
      total: this.pool.totalCount,
      utilization: (this.pool.totalCount - this.pool.idleCount) / this.pool.totalCount
    };
    
    // 扩容条件：等待连接 > 0 且使用率 > 阈值
    if (metrics.waiting > 0 && metrics.utilization > this.config.scaleUpThreshold) {
      await this.scaleUp();
    }
    // 缩容条件：使用率 < 阈值且当前 > 最小值
    else if (metrics.utilization < this.config.scaleDownThreshold && 
             this.currentSize > this.config.minSize) {
      await this.scaleDown();
    }
    
    this.emitMetrics(metrics);
  }

  async scaleUp() {
    const newSize = Math.min(this.currentSize + 5, this.config.maxSize);
    if (newSize > this.currentSize) {
      // 创建新连接
      for (let i = 0; i < newSize - this.currentSize; i++) {
        const client = await this.pool.connect();
        client.release();
      }
      this.currentSize = newSize;
      logger.info('Pool scaled up', { newSize });
    }
  }

  scaleDown() {
    // 缩容通过自然释放实现，不强制关闭连接
    this.currentSize = Math.max(this.currentSize - 2, this.config.minSize);
    logger.info('Pool target size reduced', { newSize: this.currentSize });
  }

  emitMetrics(metrics) {
    promClient.gauge('db_pool_utilization', metrics.utilization);
    promClient.gauge('db_pool_waiting', metrics.waiting);
    promClient.gauge('db_pool_idle', metrics.idle);
    promClient.gauge('db_pool_total', metrics.total);
    promClient.gauge('db_pool_current_size', this.currentSize);
  }
}
```

### 4.3 连接健康检查

**健康检查机制**：
- 每30秒检测连接池可用性
- 检测连接泄漏（连接持有时间过长）
- 自动释放僵死连接
- 健康检查失败触发告警

```javascript
// backend/shared/db/healthChecker.js
class PoolHealthChecker {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.checkIntervalMs = options.checkIntervalMs || 30000;
    this.maxConnectionAge = options.maxConnectionAge || 300000; // 5分钟
    this.unhealthyConnections = new Map();
  }

  start() {
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }

  async check() {
    try {
      // 1. 基础可用性检查
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      // 2. 连接泄漏检测
      this.detectLeaks();
      
      // 3. 发送健康指标
      this.emitHealth(true);
      
    } catch (error) {
      logger.error('Pool health check failed', { error: error.message });
      this.emitHealth(false);
      await this.recover();
    }
  }

  detectLeaks() {
    // 检测持有时间过长的连接
    // 如果有连接超过 maxConnectionAge 未释放，记录告警
    const leaks = this.pool._clients.filter(c => 
      Date.now() - c.lastUseTime > this.maxConnectionAge
    );
    
    if (leaks.length > 0) {
      logger.warn('Potential connection leaks detected', { count: leaks.length });
      promClient.increment('db_pool_leak_detected', leaks.length);
    }
  }

  async recover() {
    // 尝试重建连接池
    logger.info('Attempting pool recovery...');
    // 实现恢复逻辑
  }

  emitHealth(healthy) {
    promClient.gauge('db_pool_healthy', healthy ? 1 : 0);
  }
}
```

### 4.4 业务时段集成

**时段配置**：
```javascript
// config/peakHours.js
module.exports = {
  peakHours: [
    { start: '08:00', end: '10:00', timezone: 'Asia/Shanghai' },  // 早高峰
    { start: '18:00', end: '22:00', timezone: 'Asia/Shanghai' },  // 晚高峰
    { start: '12:00', end: '14:00', timezone: 'Asia/Shanghai' }   // 午间
  ],
  preheatMinutes: 30, // 提前30分钟预热
  eventBoost: {
    enabled: true,
    defaultSize: 40,
    maxSize: 100
  }
};
```

### 4.5 运营活动支持

**活动扩容 API**：
- `POST /api/admin/db/pool/preheat` - 触发预热
- `POST /api/admin/db/pool/resize` - 调整连接池大小
- `GET /api/admin/db/pool/status` - 获取连接池状态

### 4.6 监控指标

**Prometheus 指标**：
- `db_pool_utilization` - 连接池使用率
- `db_pool_waiting` - 等待连接数
- `db_pool_idle` - 空闲连接数
- `db_pool_total` - 总连接数
- `db_pool_current_size` - 当前目标大小
- `db_pool_healthy` - 健康状态（0/1）
- `db_pool_leak_detected` - 检测到的连接泄漏数
- `db_pool_scale_up_total` - 扩容总次数
- `db_pool_scale_down_total` - 缩容总次数

## 5. 验收标准（可测试）

- [ ] 服务启动后首次查询延迟降低 80%（从 500-2000ms 降至 100-400ms）
- [ ] 高峰时段连接等待超时率降低 90%
- [ ] 连接池使用率保持在 60-80% 区间，避免资源浪费
- [ ] 连接泄漏检测准确率 > 95%
- [ ] 连接池异常自动恢复成功率 > 95%
- [ ] 提供 Prometheus 监控指标和 Grafana 仪表板
- [ ] 支持配置时段预热，提前30分钟自动扩容
- [ ] 运营活动 API 可在5分钟内完成连接池扩容
- [ ] 单元测试覆盖率 > 80%
- [ ] 压测验证：1000 QPS 下响应时间稳定在 50ms 内

## 6. 工作量估算

**M (Medium)**

理由：
- 主要修改 `backend/shared/db` 模块
- 涉及预热、自适应、健康检查三个子系统
- 需要与现有连接池逻辑集成
- 监控和告警配置相对简单
- 预计开发时间：2-3 周

## 7. 优先级理由

**P1（高优先级）**

1. **性能收益明显**：首次查询延迟降低80%，直接影响用户体验
2. **资源优化**：自适应调整可节省30-40%服务器资源，降低成本
3. **稳定性提升**：健康检查和自动恢复显著提高系统稳定性
4. **成熟度贡献大**：对"性能与可扩展"维度（权重15分）有显著提升
5. **影响范围广**：所有微服务共享数据库连接池，改进受益面大

---

## 相关文档

- [数据库连接池优化 (REQ-00015)](/docs/requirements/REQ-00015-database-pool-optimization.md)
- [数据库连接池监控 (REQ-00232)](/docs/requirements/REQ-00232-database-connection-health-monitoring-system.md)
- [PostgreSQL 连接池最佳实践](/docs/database/pool-best-practices.md)