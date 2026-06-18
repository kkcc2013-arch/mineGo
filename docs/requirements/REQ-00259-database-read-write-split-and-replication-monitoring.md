# REQ-00259：数据库读写分离与主从同步监控系统

- **编号**：REQ-00259
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/db.js、backend/shared/ReadWriteRouter.js、所有微服务、PostgreSQL、infrastructure/k8s、admin-dashboard
- **创建时间**：2026-06-18 15:00
- **依赖需求**：REQ-00007

## 1. 背景与问题

当前 mineGo 项目所有数据库访问都通过单一连接池连接主库，在高并发场景下存在以下问题：

1. **读取压力集中**：所有查询（包括只读查询）都打到主库，主库负载过高
2. **无法横向扩展读取能力**：随着用户增长，读取 QPS 成为瓶颈
3. **主从同步延迟不可见**：未监控主从同步延迟，可能导致读取到过期数据
4. **故障切换无感知**：主库故障时，应用层无自动切换机制
5. **读写路由不智能**：无法根据查询类型自动路由到合适的数据库节点

PostgreSQL 已支持流复制和主从架构，但应用层未实现读写分离路由逻辑。

## 2. 目标

1. 实现智能读写分离路由，将读请求自动分发到从库
2. 监控主从同步延迟，延迟过高时自动降级到主库读取
3. 提供主库故障自动切换能力，提升系统可用性
4. 降低主库读取压力 60% 以上
5. 提供可视化监控面板，实时展示读写分布和同步状态

## 3. 范围

- **包含**：
  - 读写分离路由中间件
  - 主从同步延迟监控
  - 自动故障切换机制
  - 连接池管理（主/从分离）
  - 监控指标和告警
  - 管理后台监控面板

- **不包含**：
  - PostgreSQL 主从架构部署（假设已存在）
  - 数据库备份恢复（已有 REQ-00025）
  - 分库分表（超出范围）

## 4. 详细需求

### 4.1 读写分离路由中间件

```javascript
// backend/shared/ReadWriteRouter.js
class ReadWriteRouter {
  constructor(config) {
    this.masterPool = createPool(config.master);
    this.replicaPools = config.replicas.map(r => createPool(r));
    this.syncDelayThreshold = config.syncDelayThreshold || 100; // ms
    this.readWriteRatio = { read: 0, write: 0 };
  }

  // 自动识别读写并路由
  async query(sql, params, options = {}) {
    const isRead = this.isReadOnlyQuery(sql);
    
    if (isRead && !options.forceMaster) {
      return this.routeToReplica(sql, params);
    }
    return this.routeToMaster(sql, params);
  }

  // 智能从库选择（考虑延迟和负载）
  async routeToReplica(sql, params) {
    const healthyReplicas = await this.getHealthyReplicas();
    if (healthyReplicas.length === 0) {
      return this.routeToMaster(sql, params); // 降级到主库
    }
    const replica = this.selectByLoad(healthyReplicas);
    return replica.query(sql, params);
  }

  // 查询类型识别
  isReadOnlyQuery(sql) {
    const readOnlyPatterns = [
      /^SELECT\s/i,
      /^EXPLAIN\s/i,
      /^SHOW\s/i
    ];
    const writePatterns = [
      /^INSERT\s/i,
      /^UPDATE\s/i,
      /^DELETE\s/i,
      /^ALTER\s/i,
      /^CREATE\s/i,
      /^DROP\s/i
    ];
    
    const normalizedSql = sql.trim();
    return readOnlyPatterns.some(p => p.test(normalizedSql)) &&
           !writePatterns.some(p => p.test(normalizedSql));
  }
}
```

### 4.2 主从同步延迟监控

```javascript
// backend/shared/ReplicationMonitor.js
class ReplicationMonitor {
  async getReplicationLag() {
    const result = await this.masterPool.query(`
      SELECT 
        client_addr,
        state,
        sync_state,
        EXTRACT(EPOCH FROM (now() - replay_lsn::text::pg_lsn)) as lag_seconds
      FROM pg_stat_replication
    `);
    return result.rows;
  }

  async startMonitoring() {
    setInterval(async () => {
      const lag = await this.getReplicationLag();
      lag.forEach(replica => {
        metrics.gauge('db.replication.lag', replica.lag_seconds, {
          replica: replica.client_addr
        });
        
        if (replica.lag_seconds > this.criticalThreshold) {
          alerts.fire('replication_lag_critical', replica);
        }
      });
    }, 5000); // 每 5 秒检查
  }
}
```

### 4.3 自动故障切换

```javascript
// backend/shared/FailoverManager.js
class FailoverManager {
  async checkMasterHealth() {
    try {
      await this.masterPool.query('SELECT 1');
      return true;
    } catch (error) {
      logger.error('Master health check failed', error);
      return false;
    }
  }

  async handleMasterFailure() {
    // 1. 标记主库不可用
    this.masterAvailable = false;
    
    // 2. 通知所有服务降级
    await this.broadcastDegradation();
    
    // 3. 触发告警
    await alerts.fire('master_failure', {
      timestamp: new Date(),
      action: 'failover_initiated'
    });
    
    // 4. 等待外部故障切换完成（Patroni/Repmgr）
    await this.waitForNewMaster();
  }
}
```

### 4.4 连接池配置

```yaml
# config/database.yml
pools:
  master:
    host: postgres-master
    port: 5432
    max: 50
    min: 10
    idleTimeoutMillis: 30000
    
  replicas:
    - host: postgres-replica-1
      port: 5432
      max: 30
      min: 5
      weight: 1
    - host: postgres-replica-2
      port: 5432
      max: 30
      min: 5
      weight: 1

routing:
  syncDelayThreshold: 100  # ms
  forceMasterOperations:
    - transaction
    - lock
  readFromMasterOnHighLag: true
```

### 4.5 监控指标

```javascript
// Prometheus 指标
const metrics = {
  // 读写分布
  db_read_queries_total: new Counter({
    name: 'db_read_queries_total',
    help: 'Total read queries routed to replicas',
    labelNames: ['replica']
  }),
  db_write_queries_total: new Counter({
    name: 'db_write_queries_total',
    help: 'Total write queries to master'
  }),
  
  // 主从延迟
  db_replication_lag_seconds: new Gauge({
    name: 'db_replication_lag_seconds',
    help: 'Replication lag in seconds',
    labelNames: ['replica']
  }),
  
  // 连接池状态
  db_pool_active_connections: new Gauge({
    name: 'db_pool_active_connections',
    help: 'Active connections in pool',
    labelNames: ['pool', 'type']
  }),
  
  // 故障切换
  db_failover_events_total: new Counter({
    name: 'db_failover_events_total',
    help: 'Total failover events'
  })
};
```

### 4.6 管理后台监控面板

- 实时读写 QPS 图表
- 主从延迟趋势图
- 连接池使用率
- 查询路由分布饼图
- 故障切换历史记录

## 5. 验收标准（可测试）

- [ ] 读查询自动路由到从库，写查询路由到主库
- [ ] 主从延迟超过阈值时，读请求自动降级到主库
- [ ] 主库故障时，系统自动降级并触发告警
- [ ] Prometheus 指标正确暴露读写分布和同步延迟
- [ ] 管理后台可实时查看读写分离状态
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 压力测试验证主库读取压力降低 ≥ 60%

## 6. 工作量估算

**L（Large）** - 需要实现路由中间件、监控、故障切换、管理面板等多个模块，预计 3-5 天。

## 7. 优先级理由

P1 优先级：
1. 直接影响系统性能和可扩展性
2. 为高并发场景提供必要的基础设施支持
3. 提升系统可用性，减少单点故障风险
4. 是生产环境必备的数据库治理能力
