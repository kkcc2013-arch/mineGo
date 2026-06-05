# REQ-00015：数据库连接池优化与成本控制

- **编号**：REQ-00015
- **类别**：成本/资源优化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：所有微服务、database、backend/shared
- **创建时间**：2026-06-05 09:35
- **依赖需求**：REQ-00007（数据库迁移管理）

## 1. 背景与问题

当前 mineGo 数据库连接存在资源浪费和成本问题：

### 1.1 连接池配置不合理

```javascript
// 当前配置（各服务独立配置）
const pool = new Pool({
  host: 'localhost',
  database: 'minego',
  user: 'postgres',
  password: 'password',
  max: 20,  // 每个服务 20 个连接
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});
```

**问题**：
- **连接数过多**：8 个服务 × 20 连接 = 160 个连接
- **资源浪费**：大部分时间连接空闲，但仍占用数据库资源
- **成本高昂**：PostgreSQL 按连接数计费，160 连接成本显著
- **配置不一致**：各服务独立配置，难以统一管理

### 1.2 成本分析

| 资源 | 当前使用 | 月成本 | 优化后 | 节省 |
|------|---------|--------|--------|------|
| PostgreSQL 连接 | 160 | $320 | 60 | $200 |
| 内存（连接池） | 1.6 GB | $50 | 0.6 GB | $20 |
| CPU（连接管理） | 8% | $30 | 3% | $15 |

**总计月节省：$235**

## 2. 目标

通过数据库连接池优化实现：

1. **减少连接数**：从 160 降至 60，节省 62.5%
2. **统一连接池管理**：共享连接池，避免重复配置
3. **动态调整**：根据负载动态调整连接池大小
4. **监控和告警**：连接池使用率监控，异常告警
5. **成本可视化**：数据库成本仪表盘

## 3. 范围

### 包含
- 共享数据库连接池实现
- 连接池配置优化
- 动态连接池调整
- 连接池监控指标
- 成本分析仪表盘

### 不包含
- 数据库分库分表
- 读写分离
- 连接池租户隔离（多租户场景）

## 4. 详细需求

### 4.1 共享连接池实现

#### 4.1.1 连接池管理器
```javascript
// backend/shared/DatabasePool.js
const { Pool } = require('pg');

class DatabasePoolManager {
  constructor() {
    this.pools = new Map();
    this.config = {
      // 默认配置
      max: 10,  // 每个连接池最大连接数
      min: 2,   // 最小连接数
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      
      // 动态调整
      enableDynamicSizing: true,
      scaleUpThreshold: 0.8,  // 使用率 > 80% 扩容
      scaleDownThreshold: 0.3, // 使用率 < 30% 缩容
      scaleInterval: 60000  // 每分钟检查一次
    };
  }

  // 获取或创建连接池
  getPool(database = 'minego', options = {}) {
    const key = `${database}-${options.schema || 'public'}`;
    
    if (!this.pools.has(key)) {
      const pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        max: options.max || this.config.max,
        min: options.min || this.config.min,
        idleTimeoutMillis: this.config.idleTimeoutMillis,
        connectionTimeoutMillis: this.config.connectionTimeoutMillis
      });
      
      // 监听连接事件
      pool.on('connect', () => this.onConnect(key));
      pool.on('acquire', () => this.onAcquire(key));
      pool.on('release', () => this.onRelease(key));
      pool.on('error', (err) => this.onError(key, err));
      
      this.pools.set(key, {
        pool,
        stats: { total: 0, idle: 0, waiting: 0 }
      });
      
      logger.info({ database, key }, 'Database pool created');
    }
    
    return this.pools.get(key).pool;
  }

  // 动态调整连接池大小
  async enableDynamicScaling() {
    setInterval(async () => {
      for (const [key, { pool, stats }] of this.pools) {
        const usage = (stats.total - stats.idle) / pool.options.max;
        
        if (usage > this.config.scaleUpThreshold && pool.options.max < 20) {
          // 扩容
          const newSize = Math.min(pool.options.max + 2, 20);
          await this.resizePool(key, newSize);
          logger.info({ key, newSize }, 'Pool scaled up');
        } else if (usage < this.config.scaleDownThreshold && pool.options.max > 5) {
          // 缩容
          const newSize = Math.max(pool.options.max - 1, 5);
          await this.resizePool(key, newSize);
          logger.info({ key, newSize }, 'Pool scaled down');
        }
      }
    }, this.config.scaleInterval);
  }

  // 调整连接池大小
  async resizePool(key, newSize) {
    const { pool } = this.pools.get(key);
    // pg 库不支持动态调整，需要重建
    // 这里简化处理，实际需要等待所有连接释放后重建
    pool.options.max = newSize;
  }

  // 获取统计信息
  getStats() {
    const stats = {};
    for (const [key, { pool }] of this.pools) {
      stats[key] = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
        max: pool.options.max,
        usage: ((pool.totalCount - pool.idleCount) / pool.options.max * 100).toFixed(2) + '%'
      };
    }
    return stats;
  }
}

// 单例
const poolManager = new DatabasePoolManager();
module.exports = { poolManager, DatabasePoolManager };
```

### 4.2 服务集成

#### 4.2.1 统一数据库访问
```javascript
// backend/shared/db.js (重构)
const { poolManager } = require('./DatabasePool');

// 获取共享连接池
const pool = poolManager.getPool();

// 查询辅助函数
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  
  metrics.dbQueryDuration.observe({ query: text.substring(0, 50) }, duration);
  
  return result;
}

// 事务辅助函数
async function transaction(callback) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, pool };
```

#### 4.2.2 服务配置优化
```javascript
// backend/services/user-service/src/index.js (重构后)
const { poolManager } = require('../../../shared/DatabasePool');

// 使用共享连接池，配置服务特定参数
const dbPool = poolManager.getPool('minego', {
  max: 8,  // user-service 使用 8 个连接
  min: 2
});

// 不再独立创建连接池
```

### 4.3 连接池配置优化

#### 4.3.1 按服务重要性分配连接
```javascript
// backend/shared/config.js
const SERVICE_POOL_CONFIG = {
  // 核心服务，多分配连接
  'user-service': { max: 12, min: 3 },
  'catch-service': { max: 12, min: 3 },
  'payment-service': { max: 10, min: 3 },
  
  // 普通服务
  'location-service': { max: 8, min: 2 },
  'pokemon-service': { max: 8, min: 2 },
  'gym-service': { max: 8, min: 2 },
  
  // 非核心服务，少分配连接
  'reward-service': { max: 6, min: 1 },
  'social-service': { max: 6, min: 1 }
};

// 总连接数：12+12+10+8+8+8+6+6 = 70（比原来 160 减少 56%）
```

### 4.4 监控和告警

#### 4.4.1 Prometheus 指标
```javascript
// backend/shared/metrics.js (扩展)
const dbPoolTotal = new Gauge({
  name: 'db_pool_connections_total',
  help: 'Total database connections',
  labelNames: ['pool']
});

const dbPoolIdle = new Gauge({
  name: 'db_pool_connections_idle',
  help: 'Idle database connections',
  labelNames: ['pool']
});

const dbPoolWaiting = new Gauge({
  name: 'db_pool_connections_waiting',
  help: 'Waiting database connections',
  labelNames: ['pool']
});

const dbPoolUsage = new Gauge({
  name: 'db_pool_usage_percent',
  help: 'Database pool usage percentage',
  labelNames: ['pool']
});

// 定期更新指标
setInterval(() => {
  const stats = poolManager.getStats();
  for (const [pool, data] of Object.entries(stats)) {
    dbPoolTotal.set({ pool }, data.total);
    dbPoolIdle.set({ pool }, data.idle);
    dbPoolWaiting.set({ pool }, data.waiting);
    dbPoolUsage.set({ pool }, parseFloat(data.usage));
  }
}, 5000);
```

#### 4.4.2 告警规则
```yaml
# infrastructure/k8s/monitoring/prometheus-rules.yml (扩展)
groups:
  - name: database_pool
    rules:
      - alert: DatabasePoolHighUsage
        expr: db_pool_usage_percent > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Database pool usage high"
          description: "Pool {{ $labels.pool }} usage is {{ $value }}%"
      
      - alert: DatabasePoolExhausted
        expr: db_pool_connections_waiting > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database pool exhausted"
          description: "{{ $labels.pool }} has {{ $value }} waiting connections"
```

### 4.5 成本分析仪表盘

#### 4.5.1 Grafana Dashboard
```json
{
  "dashboard": {
    "title": "Database Cost Analysis",
    "panels": [
      {
        "title": "Total Connections",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(db_pool_connections_total)"
          }
        ]
      },
      {
        "title": "Monthly Cost Estimate",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(db_pool_connections_total) * 2"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "unit": "currencyUSD"
          }
        }
      },
      {
        "title": "Pool Usage Distribution",
        "type": "piechart",
        "targets": [
          {
            "expr": "db_pool_connections_total"
          }
        ]
      }
    ]
  }
}
```

## 5. 验收标准（可测试）

- [ ] DatabasePoolManager 已实现，支持共享连接池
- [ ] 所有服务已重构使用共享连接池
- [ ] 总连接数从 160 降至 ≤ 70
- [ ] 动态连接池调整正常：负载高时扩容，低时缩容
- [ ] Prometheus 指标正常：total、idle、waiting、usage
- [ ] 告警规则生效：使用率 > 90% 触发告警
- [ ] Grafana 成本仪表盘可访问，显示连接数和成本估算
- [ ] 单元测试覆盖率 ≥ 85%（DatabasePoolManager）
- [ ] 性能测试：连接获取延迟 < 5ms
- [ ] 压力测试：高并发下连接池不耗尽
- [ ] 文档已更新，包含连接池配置指南

## 6. 工作量估算

**M (Medium)**

- DatabasePoolManager 实现：1 天
- 服务集成重构：1 天
- 监控和告警：0.5 天
- 成本仪表盘：0.5 天
- 测试和验证：1 天

**总计：4 天**

## 7. 优先级理由

**P2** 理由：

1. **成本节省显著**：月节省 $235，年节省 $2820
2. **资源利用率提升**：减少空闲连接，提高资源利用率
3. **运维友好**：统一管理，动态调整，减少人工干预
4. **可观测性增强**：监控和告警帮助及时发现连接池问题
5. **非阻塞**：不影响核心功能，可渐进实施

虽然优先级为 P2，但成本优化对项目长期运营有重要意义。
