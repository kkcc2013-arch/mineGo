# REQ-00334: 数据库读写分离与主从同步监控系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00334 |
| 标题 | 数据库读写分离与主从同步监控系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | 所有微服务、backend/shared、PostgreSQL、infrastructure/k8s、admin-dashboard |
| 创建时间 | 2026-06-26 07:00 UTC |

## 需求描述

实现 PostgreSQL 数据库读写分离架构，将读操作分流到只读副本节点，减轻主节点压力，提升查询性能和系统可用性。同时建立完善的主从同步监控体系，确保数据一致性。

### 核心目标

1. **读写分离**：读操作自动路由到只读副本，写操作路由到主节点
2. **主从同步监控**：实时监控主从延迟，延迟超阈值自动告警
3. **故障自动切换**：主节点故障时自动提升副本为新主节点
4. **负载均衡**：读请求在多个副本间智能负载均衡
5. **透明切换**：应用层无感知，中间件自动处理路由

### 业务价值

- **性能提升**：读操作分流，主节点负载降低 50-70%
- **可用性增强**：主节点故障时，副本自动接管，RTO < 30s
- **成本优化**：读写分离后，主节点规格可降低，节省成本 30-40%
- **可扩展性**：支持横向扩展只读副本，应对读密集场景

## 技术方案

### 1. 读写分离中间件设计

#### 1.1 数据库连接池管理器

```javascript
// backend/shared/DatabasePoolManager.js

const { Pool } = require('pg');
const EventEmitter = require('events');

class DatabasePoolManager extends EventEmitter {
  constructor(config) {
    super();
    
    // 主节点连接池（写操作）
    this.masterPool = new Pool({
      host: config.master.host,
      port: config.master.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.master.maxConnections || 20,
      min: config.master.minConnections || 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // 只读副本连接池（读操作）
    this.replicaPools = config.replicas.map(replica => ({
      pool: new Pool({
        host: replica.host,
        port: replica.port,
        database: config.database,
        user: config.user,
        password: config.password,
        max: replica.maxConnections || 15,
        min: replica.minConnections || 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      }),
      weight: replica.weight || 1,
      health: {
        status: 'healthy',
        lag: 0,
        lastCheck: Date.now(),
      },
    }));

    // 路由策略
    this.routingStrategy = config.routingStrategy || 'round-robin';
    this.currentReplicaIndex = 0;
    
    // 读写分离规则
    this.readOperations = new Set([
      'SELECT', 'EXPLAIN', 'SHOW'
    ]);
    
    this.writeOperations = new Set([
      'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'
    ]);

    // 监控指标
    this.metrics = {
      masterQueries: 0,
      replicaQueries: 0,
      masterLatency: [],
      replicaLatency: [],
      errors: [],
    };

    // 健康检查
    this.startHealthCheck();
  }

  /**
   * 智能查询路由
   */
  async query(sql, params = [], options = {}) {
    const startTime = Date.now();
    
    try {
      // 强制使用主节点
      if (options.forceMaster) {
        return await this.executeOnMaster(sql, params, startTime);
      }

      // 强制使用副本
      if (options.forceReplica) {
        return await this.executeOnReplica(sql, params, startTime);
      }

      // 自动路由
      const operation = this.detectOperation(sql);
      
      if (this.isWriteOperation(operation)) {
        return await this.executeOnMaster(sql, params, startTime);
      } else {
        return await this.executeOnReplica(sql, params, startTime);
      }
    } catch (error) {
      this.recordError(error, sql);
      throw error;
    }
  }

  /**
   * 检测操作类型
   */
  detectOperation(sql) {
    const trimmedSql = sql.trim().toUpperCase();
    for (const op of this.readOperations) {
      if (trimmedSql.startsWith(op)) return op;
    }
    for (const op of this.writeOperations) {
      if (trimmedSql.startsWith(op)) return op;
    }
    return 'UNKNOWN';
  }

  /**
   * 是否为写操作
   */
  isWriteOperation(operation) {
    return this.writeOperations.has(operation) || operation === 'UNKNOWN';
  }

  /**
   * 在主节点执行
   */
  async executeOnMaster(sql, params, startTime) {
    const client = await this.masterPool.connect();
    try {
      const result = await client.query(sql, params);
      this.recordMetrics('master', startTime);
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * 在副本执行（负载均衡）
   */
  async executeOnReplica(sql, params, startTime) {
    const replicaPool = this.selectReplica();
    
    if (!replicaPool) {
      // 无可用副本，回退到主节点
      return await this.executeOnMaster(sql, params, startTime);
    }

    const client = await replicaPool.pool.connect();
    try {
      const result = await client.query(sql, params);
      this.recordMetrics('replica', startTime, replicaPool);
      return result;
    } catch (error) {
      // 副本查询失败，尝试主节点
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        this.markReplicaUnhealthy(replicaPool);
        return await this.executeOnMaster(sql, params, startTime);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 选择副本（负载均衡）
   */
  selectReplica() {
    const healthyReplicas = this.replicaPools.filter(r => 
      r.health.status === 'healthy' && 
      r.health.lag < this.config.maxLagThreshold
    );

    if (healthyReplicas.length === 0) {
      return null;
    }

    switch (this.routingStrategy) {
      case 'round-robin':
        return this.selectRoundRobin(healthyReplicas);
      
      case 'least-connections':
        return this.selectLeastConnections(healthyReplicas);
      
      case 'weighted':
        return this.selectWeighted(healthyReplicas);
      
      case 'least-lag':
        return this.selectLeastLag(healthyReplicas);
      
      default:
        return healthyReplicas[0];
    }
  }

  /**
   * 轮询选择
   */
  selectRoundRobin(replicas) {
    this.currentReplicaIndex = (this.currentReplicaIndex + 1) % replicas.length;
    return replicas[this.currentReplicaIndex];
  }

  /**
   * 最少连接数选择
   */
  selectLeastConnections(replicas) {
    return replicas.reduce((min, r) => 
      r.pool.waitingCount < min.pool.waitingCount ? r : min
    );
  }

  /**
   * 加权选择
   */
  selectWeighted(replicas) {
    const totalWeight = replicas.reduce((sum, r) => sum + r.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const replica of replicas) {
      random -= replica.weight;
      if (random <= 0) return replica;
    }
    
    return replicas[0];
  }

  /**
   * 最小延迟选择
   */
  selectLeastLag(replicas) {
    return replicas.reduce((min, r) => 
      r.health.lag < min.health.lag ? r : min
    );
  }

  /**
   * 健康检查
   */
  startHealthCheck() {
    setInterval(async () => {
      await this.checkReplicasHealth();
    }, this.config.healthCheckInterval || 5000);
  }

  /**
   * 检查副本健康状态
   */
  async checkReplicasHealth() {
    for (const replica of this.replicaPools) {
      try {
        // 检查连接性
        const client = await replica.pool.connect();
        
        // 检查复制延迟
        const result = await client.query(`
          SELECT 
            EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag_seconds
        `);
        
        client.release();
        
        const lag = result.rows[0].lag_seconds || 0;
        replica.health.lag = lag;
        replica.health.lastCheck = Date.now();
        
        // 判断健康状态
        if (lag > this.config.maxLagThreshold) {
          replica.health.status = 'degraded';
          this.emit('replica-lag', { replica, lag });
        } else {
          replica.health.status = 'healthy';
        }
      } catch (error) {
        replica.health.status = 'unhealthy';
        replica.health.error = error.message;
        this.emit('replica-error', { replica, error });
      }
    }
  }

  /**
   * 标记副本不健康
   */
  markReplicaUnhealthy(replica) {
    replica.health.status = 'unhealthy';
    replica.health.lastCheck = Date.now();
    this.emit('replica-down', replica);
  }

  /**
   * 记录指标
   */
  recordMetrics(type, startTime, replica = null) {
    const latency = Date.now() - startTime;
    
    if (type === 'master') {
      this.metrics.masterQueries++;
      this.metrics.masterLatency.push(latency);
    } else {
      this.metrics.replicaQueries++;
      this.metrics.replicaLatency.push(latency);
    }

    // 保持最近 1000 条记录
    if (this.metrics.masterLatency.length > 1000) {
      this.metrics.masterLatency.shift();
    }
    if (this.metrics.replicaLatency.length > 1000) {
      this.metrics.replicaLatency.shift();
    }
  }

  /**
   * 记录错误
   */
  recordError(error, sql) {
    this.metrics.errors.push({
      error: error.message,
      code: error.code,
      sql: sql.substring(0, 100),
      timestamp: Date.now(),
    });

    // 保持最近 100 条错误
    if (this.metrics.errors.length > 100) {
      this.metrics.errors.shift();
    }
  }

  /**
   * 获取指标
   */
  getMetrics() {
    return {
      masterQueries: this.metrics.masterQueries,
      replicaQueries: this.metrics.replicaQueries,
      masterLatency: {
        avg: this.calculateAvg(this.metrics.masterLatency),
        p95: this.calculateP95(this.metrics.masterLatency),
        p99: this.calculateP99(this.metrics.masterLatency),
      },
      replicaLatency: {
        avg: this.calculateAvg(this.metrics.replicaLatency),
        p95: this.calculateP95(this.metrics.replicaLatency),
        p99: this.calculateP99(this.metrics.replicaLatency),
      },
      replicas: this.replicaPools.map(r => ({
        host: r.pool.options.host,
        health: r.health,
        waitingCount: r.pool.waitingCount,
        totalCount: r.pool.totalCount,
        idleCount: r.pool.idleCount,
      })),
      errors: this.metrics.errors.slice(-10),
    };
  }

  calculateAvg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  calculateP95(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[index];
  }

  calculateP99(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.99) - 1;
    return sorted[index];
  }
}

module.exports = DatabasePoolManager;
```

### 2. 主从同步监控系统

#### 2.1 复制延迟监控

```javascript
// backend/shared/ReplicationMonitor.js

const Prometheus = require('prom-client');
const EventEmitter = require('events');

class ReplicationMonitor extends EventEmitter {
  constructor(poolManager, config = {}) {
    super();
    this.poolManager = poolManager;
    this.config = {
      checkInterval: config.checkInterval || 5000,
      lagWarningThreshold: config.lagWarningThreshold || 1000, // 1s
      lagCriticalThreshold: config.lagCriticalThreshold || 5000, // 5s
      ...config,
    };

    // Prometheus 指标
    this.registerMetrics();
    
    // 启动监控
    this.startMonitoring();
  }

  registerMetrics() {
    // 主从延迟
    this.replicationLag = new Prometheus.Gauge({
      name: 'postgresql_replication_lag_seconds',
      help: 'Replication lag in seconds',
      labelNames: ['replica_host'],
    });

    // 主节点查询数
    this.masterQueries = new Prometheus.Counter({
      name: 'postgresql_master_queries_total',
      help: 'Total queries executed on master',
    });

    // 副本查询数
    this.replicaQueries = new Prometheus.Counter({
      name: 'postgresql_replica_queries_total',
      help: 'Total queries executed on replica',
      labelNames: ['replica_host'],
    });

    // 查询延迟
    this.queryLatency = new Prometheus.Histogram({
      name: 'postgresql_query_latency_seconds',
      help: 'Query latency in seconds',
      labelNames: ['node_type', 'operation'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    });

    // 连接池状态
    this.poolConnections = new Prometheus.Gauge({
      name: 'postgresql_pool_connections',
      help: 'Connection pool status',
      labelNames: ['node_type', 'state'],
    });
  }

  startMonitoring() {
    // 监听池管理器事件
    this.poolManager.on('replica-lag', (data) => {
      this.handleLagWarning(data);
    });

    this.poolManager.on('replica-error', (data) => {
      this.handleReplicaError(data);
    });

    this.poolManager.on('replica-down', (data) => {
      this.handleReplicaDown(data);
    });

    // 定期收集指标
    setInterval(() => {
      this.collectMetrics();
    }, this.config.checkInterval);
  }

  async collectMetrics() {
    const metrics = this.poolManager.getMetrics();

    // 更新查询计数
    this.masterQueries.inc(metrics.masterQueries);
    metrics.replicas.forEach(r => {
      this.replicaQueries.inc({ replica_host: r.host }, r.health.queries || 0);
    });

    // 更新延迟指标
    this.queryLatency.observe(
      { node_type: 'master', operation: 'read' },
      metrics.masterLatency.avg / 1000
    );
    
    this.queryLatency.observe(
      { node_type: 'replica', operation: 'read' },
      metrics.replicaLatency.avg / 1000
    );

    // 更新连接池状态
    this.poolConnections.set(
      { node_type: 'master', state: 'total' },
      this.poolManager.masterPool.totalCount
    );
    this.poolConnections.set(
      { node_type: 'master', state: 'idle' },
      this.poolManager.masterPool.idleCount
    );
    this.poolConnections.set(
      { node_type: 'master', state: 'waiting' },
      this.poolManager.masterPool.waitingCount
    );

    metrics.replicas.forEach(r => {
      this.poolConnections.set(
        { node_type: 'replica', state: 'total' },
        r.totalCount
      );
      this.poolConnections.set(
        { node_type: 'replica', state: 'idle' },
        r.idleCount
      );
      this.poolConnections.set(
        { node_type: 'replica', state: 'waiting' },
        r.waitingCount
      );
    });

    // 更新复制延迟
    metrics.replicas.forEach(r => {
      this.replicationLag.set(
        { replica_host: r.host },
        r.health.lag
      );
    });
  }

  handleLagWarning(data) {
    const { replica, lag } = data;
    
    if (lag > this.config.lagCriticalThreshold) {
      this.emit('alert', {
        level: 'critical',
        type: 'replication_lag',
        message: `Replication lag critical on ${replica.pool.options.host}: ${lag}s`,
        replica: replica.pool.options.host,
        lag,
      });
    } else if (lag > this.config.lagWarningThreshold) {
      this.emit('alert', {
        level: 'warning',
        type: 'replication_lag',
        message: `Replication lag high on ${replica.pool.options.host}: ${lag}s`,
        replica: replica.pool.options.host,
        lag,
      });
    }
  }

  handleReplicaError(data) {
    this.emit('alert', {
      level: 'error',
      type: 'replica_error',
      message: `Replica error on ${data.replica.pool.options.host}`,
      error: data.error.message,
    });
  }

  handleReplicaDown(data) {
    this.emit('alert', {
      level: 'critical',
      type: 'replica_down',
      message: `Replica ${data.pool.options.host} is down`,
      replica: data.pool.options.host,
    });
  }
}

module.exports = ReplicationMonitor;
```

### 3. 自动故障切换

#### 3.1 故障检测与自动切换

```javascript
// backend/shared/FailoverManager.js

const EventEmitter = require('events');

class FailoverManager extends EventEmitter {
  constructor(poolManager, config = {}) {
    super();
    this.poolManager = poolManager;
    this.config = {
      masterCheckInterval: config.masterCheckInterval || 3000,
      failureThreshold: config.failureThreshold || 3,
      failoverTimeout: config.failoverTimeout || 30000,
      ...config,
    };

    this.masterFailures = 0;
    this.isFailoverInProgress = false;
    this.currentMaster = null;

    this.startMasterHealthCheck();
  }

  startMasterHealthCheck() {
    setInterval(async () => {
      await this.checkMasterHealth();
    }, this.config.masterCheckInterval);
  }

  async checkMasterHealth() {
    if (this.isFailoverInProgress) return;

    try {
      const client = await this.poolManager.masterPool.connect();
      await client.query('SELECT 1');
      client.release();
      
      this.masterFailures = 0;
    } catch (error) {
      this.masterFailures++;
      
      if (this.masterFailures >= this.config.failureThreshold) {
        await this.initiateFailover();
      }
    }
  }

  async initiateFailover() {
    if (this.isFailoverInProgress) return;
    
    this.isFailoverInProgress = true;
    this.emit('failover-started');

    try {
      // 1. 选择最健康的副本
      const healthyReplica = this.selectNewMaster();
      
      if (!healthyReplica) {
        throw new Error('No healthy replica available for failover');
      }

      // 2. 提升副本为主节点
      await this.promoteReplica(healthyReplica);

      // 3. 更新连接池配置
      await this.updatePoolConfiguration(healthyReplica);

      // 4. 通知所有服务
      await this.notifyServices(healthyReplica);

      this.currentMaster = healthyReplica;
      this.emit('failover-completed', { newMaster: healthyReplica });
      
    } catch (error) {
      this.emit('failover-failed', { error: error.message });
    } finally {
      this.isFailoverInProgress = false;
      this.masterFailures = 0;
    }
  }

  selectNewMaster() {
    const healthyReplicas = this.poolManager.replicaPools.filter(r => 
      r.health.status === 'healthy' &&
      r.health.lag < this.config.maxLagThreshold
    );

    if (healthyReplicas.length === 0) {
      return null;
    }

    // 选择延迟最小的副本
    return healthyReplicas.reduce((min, r) => 
      r.health.lag < min.health.lag ? r : min
    );
  }

  async promoteReplica(replica) {
    // 这里需要调用 PostgreSQL 的 pg_promote 或类似命令
    // 实际实现取决于 PostgreSQL 版本和配置
    const client = await replica.pool.connect();
    
    try {
      // PostgreSQL 12+ 支持 pg_promote
      await client.query('SELECT pg_promote()');
      
      this.emit('replica-promoted', {
        host: replica.pool.options.host,
        timestamp: Date.now(),
      });
    } finally {
      client.release();
    }
  }

  async updatePoolConfiguration(newMaster) {
    // 更新主节点连接池
    // 实际实现需要重新创建连接池或更新配置
    this.emit('pool-updated', { newMaster: newMaster.pool.options.host });
  }

  async notifyServices(newMaster) {
    // 通过 Kafka 或其他消息系统通知所有服务
    this.emit('services-notified', { newMaster: newMaster.pool.options.host });
  }
}

module.exports = FailoverManager;
```

### 4. 配置示例

```javascript
// config/database.js

module.exports = {
  database: 'minego',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  
  // 主节点配置
  master: {
    host: process.env.DB_MASTER_HOST || 'localhost',
    port: process.env.DB_MASTER_PORT || 5432,
    maxConnections: 20,
    minConnections: 5,
  },

  // 只读副本配置
  replicas: [
    {
      host: process.env.DB_REPLICA_1_HOST || 'localhost',
      port: process.env.DB_REPLICA_1_PORT || 5433,
      maxConnections: 15,
      minConnections: 3,
      weight: 1,
    },
    {
      host: process.env.DB_REPLICA_2_HOST || 'localhost',
      port: process.env.DB_REPLICA_2_PORT || 5434,
      maxConnections: 15,
      minConnections: 3,
      weight: 2,
    },
  ],

  // 路由策略
  routingStrategy: 'least-lag', // round-robin, least-connections, weighted, least-lag
  
  // 健康检查
  healthCheckInterval: 5000,
  maxLagThreshold: 5, // 秒
  
  // 故障切换
  masterCheckInterval: 3000,
  failureThreshold: 3,
  failoverTimeout: 30000,
};
```

### 5. Kubernetes 部署配置

```yaml
# infrastructure/k8s/postgres-ha.yaml

apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-ha-config
  namespace: minego
data:
  POSTGRES_MASTER_HOST: "postgres-master-0.postgres-master"
  POSTGRES_REPLICA_1_HOST: "postgres-replica-0.postgres-replica"
  POSTGRES_REPLICA_2_HOST: "postgres-replica-1.postgres-replica"
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-master
  namespace: minego
spec:
  serviceName: postgres-master
  replicas: 1
  selector:
    matchLabels:
      app: postgres
      role: master
  template:
    metadata:
      labels:
        app: postgres
        role: master
    spec:
      containers:
      - name: postgres
        image: postgres:15
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_DB
          value: minego
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres-replica
  namespace: minego
spec:
  serviceName: postgres-replica
  replicas: 2
  selector:
    matchLabels:
      app: postgres
      role: replica
  template:
    metadata:
      labels:
        app: postgres
        role: replica
    spec:
      containers:
      - name: postgres
        image: postgres:15
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_DB
          value: minego
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: postgres-secret
              key: password
        - name: POSTGRES_MASTER_HOST
          valueFrom:
            configMapKeyRef:
              name: postgres-ha-config
              key: POSTGRES_MASTER_HOST
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 50Gi
```

### 6. 监控仪表板

```yaml
# infrastructure/k8s/monitoring/postgres-replication-dashboard.yaml

apiVersion: v1
kind: ConfigMap
metadata:
  name: postgres-replication-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  postgres-replication.json: |
    {
      "dashboard": {
        "title": "PostgreSQL Replication Monitor",
        "panels": [
          {
            "title": "Replication Lag",
            "type": "graph",
            "targets": [
              {
                "expr": "postgresql_replication_lag_seconds",
                "legendFormat": "{{replica_host}}"
              }
            ],
            "alert": {
              "conditions": [
                {
                  "evaluator": {
                    "type": "gt",
                    "params": [5]
                  }
                }
              ],
              "name": "Replication Lag Critical"
            }
          },
          {
            "title": "Query Distribution",
            "type": "piechart",
            "targets": [
              {
                "expr": "postgresql_master_queries_total",
                "legendFormat": "Master"
              },
              {
                "expr": "sum(postgresql_replica_queries_total)",
                "legendFormat": "Replicas"
              }
            ]
          },
          {
            "title": "Query Latency",
            "type": "graph",
            "targets": [
              {
                "expr": "histogram_quantile(0.95, postgresql_query_latency_seconds_bucket{node_type=\"master\"})",
                "legendFormat": "Master P95"
              },
              {
                "expr": "histogram_quantile(0.95, postgresql_query_latency_seconds_bucket{node_type=\"replica\"})",
                "legendFormat": "Replica P95"
              }
            ]
          },
          {
            "title": "Connection Pool Status",
            "type": "graph",
            "targets": [
              {
                "expr": "postgresql_pool_connections{state=\"total\"}",
                "legendFormat": "{{node_type}} Total"
              },
              {
                "expr": "postgresql_pool_connections{state=\"idle\"}",
                "legendFormat": "{{node_type}} Idle"
              }
            ]
          }
        ]
      }
    }
```

## 验收标准

- [ ] 实现读写分离中间件，支持自动路由
- [ ] 支持多种负载均衡策略（轮询、最少连接、加权、最小延迟）
- [ ] 实现主从同步延迟监控（精确到毫秒）
- [ ] 主节点故障时自动切换到副本（RTO < 30s）
- [ ] 支持强制使用主节点/副本的选项
- [ ] 健康检查机制，自动标记不健康副本
- [ ] Prometheus 指标导出
- [ ] Grafana 监控仪表板
- [ ] 延迟超阈值自动告警
- [ ] 连接池状态监控
- [ ] 完整的单元测试和集成测试
- [ ] 性能基准测试（读写分离后查询性能提升 50%+）
- [ ] 故障切换演练文档

## 影响范围

### 新增文件
- `backend/shared/DatabasePoolManager.js` - 读写分离连接池管理器
- `backend/shared/ReplicationMonitor.js` - 主从同步监控
- `backend/shared/FailoverManager.js` - 自动故障切换
- `infrastructure/k8s/postgres-ha.yaml` - PostgreSQL HA 部署配置
- `infrastructure/k8s/monitoring/postgres-replication-dashboard.yaml` - 监控仪表板
- `config/database.js` - 数据库配置

### 修改文件
- 所有微服务的数据库连接代码（替换为新连接池管理器）
- `infrastructure/k8s/deployments/*` - 更新数据库配置
- `infrastructure/k8s/monitoring/prometheus.yml` - 添加 PostgreSQL 指标采集
- `.github/workflows/ci-cd.yml` - 添加 PostgreSQL HA 测试环境

### 数据库变更
- 配置 PostgreSQL 主从复制
- 创建复制用户和权限
- 配置流复制参数

## 参考

- [PostgreSQL Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html)
- [PostgreSQL High Availability](https://www.postgresql.org/docs/current/high-availability.html)
- [pg-pool Documentation](https://node-postgres.com/apis/pool)
- [Kubernetes StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [Prometheus PostgreSQL Exporter](https://github.com/prometheus-community/postgres_exporter)
- [Patroni - PostgreSQL HA Solution](https://patroni.readthedocs.io/)
