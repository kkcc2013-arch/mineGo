# REQ-00115: 数据库连接池自适应调度与负载均衡系统

- **编号**：REQ-00115
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/db.js、所有微服务、PostgreSQL、infrastructure/k8s
- **创建时间**：2026-06-11 15:50
- **依赖需求**：REQ-00015（数据库连接池优化）、REQ-00084（连接池监控）

## 1. 背景与问题

当前项目的数据库连接池（REQ-00015）已实现基础优化，但缺乏智能调度能力：

1. **固定连接池大小**：所有服务使用相同配置，无法根据实际负载动态调整
2. **缺乏负载感知**：连接分配不考虑当前数据库负载和查询复杂度
3. **高峰期瓶颈**：在用户高峰期（如活动开始时）连接池耗尽导致请求超时
4. **低谷期浪费**：夜间低峰期大量空闲连接占用资源
5. **无优先级调度**：关键业务请求（支付、战斗）与普通请求（查询）同等对待

根据生产环境监控数据，连接池利用率在 20%-95% 之间波动，极端情况下连接等待时间超过 5 秒，影响用户体验。

## 2. 目标

构建智能的数据库连接池调度系统，实现：

1. **自适应连接池大小**：根据负载动态调整最小/最大连接数
2. **查询优先级队列**：高优先级请求优先获取连接
3. **负载感知路由**：根据数据库负载智能分配连接
4. **连接预热机制**：预测高峰期提前扩展连接池
5. **连接健康检查**：自动检测和移除问题连接

预期收益：
- 高峰期请求超时率降低 80%+
- 低谷期资源利用率提升 40%+
- 关键业务响应时间稳定性提升 50%+
- 数据库连接资源节省 20%+

## 3. 范围

- **包含**：
  - 连接池动态配置管理
  - 查询优先级队列实现
  - 负载监控与自适应调度算法
  - 连接预热与预测机制
  - 连接健康检查与自动恢复
  - 管理员配置 API
  - Prometheus 指标扩展

- **不包含**：
  - 读写分离路由（已有计划）
  - 多数据库实例负载均衡
  - 连接池分片

## 4. 详细需求

### 4.1 连接池动态配置

```javascript
const POOL_CONFIG = {
  // 基础配置
  base: {
    minConnections: 5,
    maxConnections: 50,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 30000
  },
  
  // 自适应配置范围
  adaptive: {
    minConnectionsRange: [2, 10],
    maxConnectionsRange: [20, 100],
    scaleUpThreshold: 0.8,  // 利用率 > 80% 扩展
    scaleDownThreshold: 0.3, // 利用率 < 30% 缩减
    scaleCooldownMs: 60000   // 扩缩容冷却时间
  },
  
  // 优先级配置
  priorities: {
    CRITICAL: { level: 1, description: '支付、战斗' },
    HIGH: { level: 2, description: '捕捉、交易' },
    NORMAL: { level: 3, description: '常规查询' },
    LOW: { level: 4, description: '后台任务' }
  }
};
```

### 4.2 查询优先级队列

```javascript
class PriorityConnectionPool {
  constructor(config) {
    this.pools = {
      CRITICAL: createPool({ ...config, maxConnections: 10 }),
      HIGH: createPool({ ...config, maxConnections: 15 }),
      NORMAL: createPool({ ...config, maxConnections: 20 }),
      LOW: createPool({ ...config, maxConnections: 5 })
    };
    
    this.queue = new PriorityQueue();
    this.loadMonitor = new LoadMonitor();
  }

  async acquire(priority, queryFn) {
    const ticket = { priority, queryFn, timestamp: Date.now() };
    
    // 检查是否有可用连接
    const pool = this.pools[priority];
    if (pool.available > 0) {
      return this.executeWithConnection(pool, queryFn);
    }
    
    // 高优先级可以借用低优先级池的连接
    if (priority === 'CRITICAL' || priority === 'HIGH') {
      const borrowedPool = this.tryBorrowFromLower(priority);
      if (borrowedPool) {
        return this.executeWithConnection(borrowedPool, queryFn);
      }
    }
    
    // 加入等待队列
    return this.enqueueAndWait(ticket);
  }

  tryBorrowFromLower(priority) {
    const lowerLevels = ['NORMAL', 'LOW'];
    for (const level of lowerLevels) {
      const pool = this.pools[level];
      if (pool.available > pool.reserved) {
        pool.reserved++;
        return pool;
      }
    }
    return null;
  }
}
```

### 4.3 负载感知调度

```javascript
class LoadAwareScheduler {
  constructor(db) {
    this.db = db;
    this.metrics = {
      activeConnections: 0,
      waitingQueries: 0,
      avgQueryTime: 0,
      errorRate: 0
    };
  }

  async collectMetrics() {
    const result = await this.db.query(`
      SELECT 
        count(*) FILTER (WHERE state = 'active') as active,
        count(*) FILTER (WHERE wait_event IS NOT NULL) as waiting,
        avg(extract(epoch FROM (now() - query_start))) FILTER (WHERE state = 'active') as avg_time
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);
    
    this.metrics = {
      activeConnections: result.rows[0].active,
      waitingQueries: result.rows[0].waiting,
      avgQueryTime: result.rows[0].avg_time || 0,
      errorRate: this.calculateErrorRate()
    };
    
    return this.metrics;
  }

  calculateLoadScore() {
    const { activeConnections, waitingQueries, avgQueryTime, errorRate } = this.metrics;
    
    // 负载分数 0-100
    const connectionScore = (activeConnections / 100) * 40;
    const waitScore = Math.min(waitingQueries * 5, 30);
    const timeScore = Math.min(avgQueryTime / 10, 20);
    const errorScore = errorRate * 10;
    
    return Math.min(connectionScore + waitScore + timeScore + errorScore, 100);
  }

  shouldScaleUp() {
    return this.calculateLoadScore() > 70;
  }

  shouldScaleDown() {
    return this.calculateLoadScore() < 30;
  }
}
```

### 4.4 连接预热机制

```javascript
class ConnectionWarmer {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.schedule = new Map();
  }

  // 根据历史数据预测高峰时段
  async learnFromHistory() {
    const hourlyStats = await this.getHourlyConnectionStats();
    
    for (const stat of hourlyStats) {
      if (stat.avgUtilization > 0.7) {
        this.schedule.set(stat.hour, {
          targetConnections: Math.ceil(stat.maxConnections * 1.2),
          warmupMinutes: 15
        });
      }
    }
  }

  async warmup(hour) {
    const schedule = this.schedule.get(hour);
    if (!schedule) return;
    
    const { targetConnections, warmupMinutes } = schedule;
    const currentConnections = this.pool.totalCount;
    
    if (currentConnections < targetConnections) {
      const toCreate = targetConnections - currentConnections;
      const rate = toCreate / warmupMinutes;
      
      // 逐步创建连接，避免瞬时压力
      for (let i = 0; i < toCreate; i++) {
        await this.pool.query('SELECT 1');
        await sleep(60000 / rate);
      }
      
      logger.info({ hour, targetConnections }, 'Connection warmup completed');
    }
  }

  async getHourlyConnectionStats() {
    const result = await this.db.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        avg(active_connections) as avg_utilization,
        max(active_connections) as max_connections
      FROM connection_stats
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY hour
      ORDER BY hour
    `);
    return result.rows;
  }
}
```

### 4.5 连接健康检查

```javascript
class ConnectionHealthChecker {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.unhealthyConnections = new Set();
  }

  async checkHealth() {
    const clients = this.pool._clients || [];
    
    for (const client of clients) {
      const health = await this.checkClientHealth(client);
      
      if (!health.healthy) {
        this.unhealthyConnections.add(client);
        this.pool._removeClient(client);
        logger.warn({ reason: health.reason }, 'Removed unhealthy connection');
      }
    }
    
    // 补充健康连接
    const shortage = this.config.minConnections - this.pool.totalCount;
    if (shortage > 0) {
      await this.createConnections(shortage);
    }
    
    return {
      healthy: this.pool.totalCount,
      unhealthy: this.unhealthyConnections.size
    };
  }

  async checkClientHealth(client) {
    try {
      // 检查连接是否响应
      const start = Date.now();
      await client.query('SELECT 1');
      const latency = Date.now() - start;
      
      // 检查延迟是否异常
      if (latency > this.config.maxLatencyMs) {
        return { healthy: false, reason: 'high_latency' };
      }
      
      // 检查连接是否过期
      if (client.lastError && Date.now() - client.lastError < 60000) {
        return { healthy: false, reason: 'recent_error' };
      }
      
      return { healthy: true };
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }
}
```

### 4.6 管理 API

```javascript
// GET /api/v1/admin/db-pool/status
{
  "pools": {
    "CRITICAL": { "total": 10, "idle": 5, "waiting": 0 },
    "HIGH": { "total": 15, "idle": 8, "waiting": 2 },
    "NORMAL": { "total": 20, "idle": 15, "waiting": 5 },
    "LOW": { "total": 5, "idle": 5, "waiting": 0 }
  },
  "loadScore": 45,
  "recommendations": [
    "Consider increasing HIGH pool size during peak hours"
  ]
}

// PATCH /api/v1/admin/db-pool/config
{
  "priority": "HIGH",
  "maxConnections": 25
}

// POST /api/v1/admin/db-pool/warmup
{
  "priority": "CRITICAL",
  "targetConnections": 15
}
```

### 4.7 Prometheus 指标扩展

```javascript
// 连接池状态
const poolConnectionsTotal = new Gauge({
  name: 'minego_db_pool_connections_total',
  help: 'Total connections in pool',
  labelNames: ['service', 'priority', 'state'] // state: total, idle, waiting
});

// 负载分数
const poolLoadScore = new Gauge({
  name: 'minego_db_pool_load_score',
  help: 'Database load score (0-100)',
  labelNames: ['service']
});

// 优先级队列长度
const priorityQueueLength = new Gauge({
  name: 'minego_db_priority_queue_length',
  help: 'Priority queue length',
  labelNames: ['service', 'priority']
});

// 扩缩容事件
const poolScaleEvents = new Counter({
  name: 'minego_db_pool_scale_events_total',
  help: 'Pool scale events',
  labelNames: ['service', 'direction'] // direction: up, down
});

// 连接健康检查
const connectionHealthChecks = new Counter({
  name: 'minego_db_connection_health_checks_total',
  help: 'Connection health check results',
  labelNames: ['service', 'result'] // result: healthy, unhealthy
});
```

## 5. 验收标准（可测试）

- [ ] 连接池可根据负载自动调整大小（在配置范围内）
- [ ] 高优先级请求优先获取连接，平均等待时间减少 50%+
- [ ] 负载分数计算准确，与实际数据库负载相关系数 > 0.9
- [ ] 高峰期预热机制生效，连接等待超时率降低 80%+
- [ ] 低谷期自动缩减连接池，资源利用率提升 30%+
- [ ] 不健康连接自动检测并移除，不影响正常请求
- [ ] 管理 API 可查询池状态、调整配置、触发预热
- [ ] 5 个 Prometheus 指标正常暴露
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L**（大型）

理由：
- 连接池核心改造约 3 天
- 优先级队列实现约 2 天
- 负载感知调度约 2 天
- 预热机制约 1 天
- 健康检查约 1 天
- 管理 API 和指标约 1 天
- 测试和调优约 2 天
- 总计约 10-12 天

## 7. 优先级理由

**P1**（高优先级）

理由：
1. **生产稳定性**：连接池是系统稳定性关键组件，高峰期超时影响用户体验
2. **资源优化**：智能调度可显著降低资源浪费，节省成本
3. **可观测性**：负载感知提供重要运维指标
4. **依赖关系**：依赖 REQ-00015（连接池优化）和 REQ-00084（监控），已完成
5. **技术成熟度**：相关技术方案成熟，风险可控

相比 P0 的核心功能和安全问题，此需求优先级适中但重要。
