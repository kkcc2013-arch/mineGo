# REQ-00084: 数据库连接池监控与自适应扩缩容系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00084 |
| 标题 | 数据库连接池监控与自适应扩缩容系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、PostgreSQL、infrastructure/k8s |
| 创建时间 | 2026-06-10 09:00 |

## 需求描述

当前数据库连接池配置是静态的，无法根据实际负载动态调整。在高并发时段可能出现连接不足导致的请求排队或超时，而在低峰时段可能存在连接资源浪费。需要实现：

1. **实时监控**：连接池使用率、等待队列、连接创建/销毁统计
2. **自适应扩缩容**：根据负载自动调整连接池大小
3. **成本优化**：在保证性能的前提下最小化连接资源占用
4. **预警机制**：连接池饱和、等待超时、连接泄漏检测

### 背景
- 当前所有服务使用固定连接池配置（默认 10-20 连接）
- 高峰时段连接等待时间可达 200ms+
- 低峰时段连接利用率不足 20%
- 缺乏连接池级别的可观测性

## 技术方案

### 1. 连接池监控指标采集

```javascript
// backend/shared/poolMetrics.js
const promClient = require('prom-client');
const { Pool } = require('pg');

// Prometheus 指标定义
const poolMetrics = {
  // 连接池总大小
  poolSize: new promClient.Gauge({
    name: 'db_pool_total_connections',
    help: 'Total connections in the pool',
    labelNames: ['service', 'database']
  }),
  
  // 空闲连接数
  idleConnections: new promClient.Gauge({
    name: 'db_pool_idle_connections',
    help: 'Number of idle connections',
    labelNames: ['service', 'database']
  }),
  
  // 等待队列长度
  waitingClients: new promClient.Gauge({
    name: 'db_pool_waiting_clients',
    help: 'Number of clients waiting for a connection',
    labelNames: ['service', 'database']
  }),
  
  // 连接使用率
  utilizationRate: new promClient.Gauge({
    name: 'db_pool_utilization_rate',
    help: 'Connection pool utilization rate (0-1)',
    labelNames: ['service', 'database']
  }),
  
  // 平均等待时间
  avgWaitTime: new promClient.Histogram({
    name: 'db_pool_wait_time_seconds',
    help: 'Time spent waiting for a connection',
    labelNames: ['service', 'database'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
  }),
  
  // 连接创建速率
  connectionCreated: new promClient.Counter({
    name: 'db_pool_connections_created_total',
    help: 'Total number of connections created',
    labelNames: ['service', 'database']
  }),
  
  // 连接销毁速率
  connectionDestroyed: new promClient.Counter({
    name: 'db_pool_connections_destroyed_total',
    help: 'Total number of connections destroyed',
    labelNames: ['service', 'database', 'reason']
  }),
  
  // 连接泄漏检测
  connectionLeaked: new promClient.Counter({
    name: 'db_pool_connections_leaked_total',
    help: 'Number of connections that may be leaked',
    labelNames: ['service', 'database']
  }),
  
  // 查询执行时间
  queryDuration: new promClient.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Query execution time',
    labelNames: ['service', 'database', 'query_type'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  })
};

class PoolMonitor {
  constructor(pool, serviceName, database = 'default') {
    this.pool = pool;
    this.serviceName = serviceName;
    this.database = database;
    this.labels = { service: serviceName, database };
    
    // 连接追踪
    this.activeConnections = new Map();
    this.leakCheckInterval = null;
    
    this.setupMonitoring();
    this.startLeakDetection();
  }
  
  setupMonitoring() {
    // 定期采集指标
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 1000); // 每秒采集一次
    
    // 监听池事件
    this.pool.on('connect', (client) => {
      poolMetrics.connectionCreated.inc(this.labels);
      this.trackConnection(client);
    });
    
    this.pool.on('acquire', (client) => {
      const info = this.activeConnections.get(client);
      if (info) {
        info.acquiredAt = Date.now();
        info.waitTime = Date.now() - info.requestedAt;
        poolMetrics.avgWaitTime.observe(this.labels, info.waitTime / 1000);
      }
    });
    
    this.pool.on('release', (client) => {
      const info = this.activeConnections.get(client);
      if (info) {
        info.releasedAt = Date.now();
        this.checkLeakedQuery(client, info);
      }
    });
    
    this.pool.on('remove', (client) => {
      poolMetrics.connectionDestroyed.inc({ ...this.labels, reason: 'normal' });
      this.activeConnections.delete(client);
    });
  }
  
  collectMetrics() {
    const pool = this.pool;
    
    // 基础指标
    const totalCount = pool.totalCount || 0;
    const idleCount = pool.idleCount || 0;
    const waitingCount = pool.waitingCount || 0;
    
    poolMetrics.poolSize.set(this.labels, totalCount);
    poolMetrics.idleConnections.set(this.labels, idleCount);
    poolMetrics.waitingClients.set(this.labels, waitingCount);
    
    // 计算使用率
    const utilization = totalCount > 0 ? (totalCount - idleCount) / totalCount : 0;
    poolMetrics.utilizationRate.set(this.labels, utilization);
    
    // 检查饱和状态
    if (waitingCount > 0 && utilization > 0.9) {
      logger.warn('Connection pool near saturation', {
        service: this.serviceName,
        total: totalCount,
        idle: idleCount,
        waiting: waitingCount,
        utilization: utilization.toFixed(2)
      });
    }
  }
  
  trackConnection(client) {
    this.activeConnections.set(client, {
      requestedAt: Date.now(),
      acquiredAt: null,
      releasedAt: null,
      queries: []
    });
  }
  
  trackQuery(client, queryText, startTime) {
    const info = this.activeConnections.get(client);
    if (info) {
      info.queries.push({
        text: queryText,
        startTime,
        endTime: null
      });
    }
  }
  
  checkLeakedQuery(client, info) {
    if (info.queries.some(q => q.endTime === null)) {
      poolMetrics.connectionLeaked.inc(this.labels);
      logger.warn('Potential query leak detected', {
        service: this.serviceName,
        connectionAge: Date.now() - info.requestedAt,
        pendingQueries: info.queries.filter(q => q.endTime === null).length
      });
    }
  }
  
  startLeakDetection() {
    // 每 30 秒检查连接泄漏
    this.leakCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [client, info] of this.activeConnections) {
        const age = now - info.acquiredAt;
        // 超过 30 秒未释放的连接可能是泄漏
        if (age > 30000) {
          logger.warn('Long-held connection detected', {
            service: this.serviceName,
            connectionAge: age,
            queries: info.queries.length
          });
        }
      }
    }, 30000);
  }
  
  // 查询包装器，添加追踪
  async query(client, queryText, params) {
    const startTime = Date.now();
    const queryType = this.getQueryType(queryText);
    
    try {
      const result = await client.query(queryText, params);
      const duration = (Date.now() - startTime) / 1000;
      
      poolMetrics.queryDuration.observe(
        { ...this.labels, query_type: queryType },
        duration
      );
      
      // 标记查询完成
      const info = this.activeConnections.get(client);
      if (info && info.queries.length > 0) {
        info.queries[info.queries.length - 1].endTime = Date.now();
      }
      
      return result;
    } catch (error) {
      // 错误也标记完成
      const info = this.activeConnections.get(client);
      if (info && info.queries.length > 0) {
        info.queries[info.queries.length - 1].endTime = Date.now();
      }
      throw error;
    }
  }
  
  getQueryType(queryText) {
    const firstWord = queryText.trim().split(/\s+/)[0].toUpperCase();
    const typeMap = {
      'SELECT': 'select',
      'INSERT': 'insert',
      'UPDATE': 'update',
      'DELETE': 'delete',
      'BEGIN': 'transaction',
      'COMMIT': 'transaction',
      'ROLLBACK': 'transaction'
    };
    return typeMap[firstWord] || 'other';
  }
  
  destroy() {
    clearInterval(this.metricsInterval);
    clearInterval(this.leakCheckInterval);
  }
}

module.exports = { PoolMonitor, poolMetrics };
```

### 2. 自适应连接池管理器

```javascript
// backend/shared/adaptivePoolManager.js
const EventEmitter = require('events');
const logger = require('./logger');

class AdaptivePoolManager extends EventEmitter {
  constructor(pool, serviceName, options = {}) {
    super();
    
    this.pool = pool;
    this.serviceName = serviceName;
    
    // 配置参数
    this.config = {
      minSize: options.minSize || 5,
      maxSize: options.maxSize || 50,
      targetUtilization: options.targetUtilization || 0.7,
      scaleUpThreshold: options.scaleUpThreshold || 0.85,
      scaleDownThreshold: options.scaleDownThreshold || 0.3,
      scaleUpStep: options.scaleUpStep || 5,
      scaleDownStep: options.scaleDownStep || 3,
      evaluationInterval: options.evaluationInterval || 30000, // 30 秒
      stabilizationPeriod: options.stabilizationPeriod || 60000, // 60 秒
      maxIdleTime: options.maxIdleTime || 300000, // 5 分钟
      ...options
    };
    
    this.currentSize = pool.options.max || this.config.minSize;
    this.lastScaleTime = 0;
    this.scaleHistory = [];
    this.utilizationHistory = [];
    
    this.startEvaluation();
  }
  
  startEvaluation() {
    this.evaluationInterval = setInterval(() => {
      this.evaluateAndAdjust();
    }, this.config.evaluationInterval);
  }
  
  async evaluateAndAdjust() {
    const metrics = this.collectPoolMetrics();
    
    // 记录历史数据
    this.utilizationHistory.push(metrics.utilization);
    if (this.utilizationHistory.length > 20) {
      this.utilizationHistory.shift();
    }
    
    // 计算平均使用率（平滑处理）
    const avgUtilization = this.utilizationHistory.reduce((a, b) => a + b, 0) 
      / this.utilizationHistory.length;
    
    const action = this.decideAction(metrics, avgUtilization);
    
    if (action) {
      await this.executeAction(action, metrics);
    }
    
    // 定期清理空闲连接
    this.cleanupIdleConnections(metrics);
  }
  
  collectPoolMetrics() {
    const pool = this.pool;
    
    return {
      totalConnections: pool.totalCount || 0,
      idleConnections: pool.idleCount || 0,
      waitingClients: pool.waitingCount || 0,
      utilization: pool.totalCount > 0 
        ? (pool.totalCount - pool.idleCount) / pool.totalCount 
        : 0,
      avgWaitTime: this.getRecentAvgWaitTime()
    };
  }
  
  getRecentAvgWaitTime() {
    // 从 Prometheus 指标获取平均等待时间
    // 简化实现，返回估计值
    return this.pool.waitingCount > 0 ? 50 : 0; // ms
  }
  
  decideAction(metrics, avgUtilization) {
    const now = Date.now();
    
    // 稳定期内不调整
    if (now - this.lastScaleTime < this.config.stabilizationPeriod) {
      return null;
    }
    
    // 有等待队列，紧急扩容
    if (metrics.waitingClients > 0 && avgUtilization > this.config.scaleUpThreshold) {
      return {
        type: 'scale_up',
        reason: 'waiting_clients',
        urgency: 'high',
        amount: Math.min(
          this.config.scaleUpStep * 2, // 紧急情况加倍
          this.config.maxSize - this.currentSize
        )
      };
    }
    
    // 使用率持续高位，扩容
    if (avgUtilization > this.config.scaleUpThreshold) {
      return {
        type: 'scale_up',
        reason: 'high_utilization',
        urgency: 'normal',
        amount: Math.min(
          this.config.scaleUpStep,
          this.config.maxSize - this.currentSize
        )
      };
    }
    
    // 使用率持续低位，缩容
    if (avgUtilization < this.config.scaleDownThreshold && 
        this.currentSize > this.config.minSize) {
      return {
        type: 'scale_down',
        reason: 'low_utilization',
        urgency: 'normal',
        amount: Math.min(
          this.config.scaleDownStep,
          this.currentSize - this.config.minSize
        )
      };
    }
    
    return null;
  }
  
  async executeAction(action, metrics) {
    const oldSize = this.currentSize;
    
    if (action.type === 'scale_up') {
      if (action.amount <= 0) return;
      
      this.currentSize = Math.min(
        this.currentSize + action.amount,
        this.config.maxSize
      );
      
      // 扩展连接池
      try {
        await this.resizePool(this.currentSize);
        
        this.lastScaleTime = Date.now();
        this.recordScaleAction(action, oldSize, this.currentSize, metrics);
        
        this.emit('scale_up', {
          from: oldSize,
          to: this.currentSize,
          reason: action.reason,
          metrics
        });
        
        logger.info('Connection pool scaled up', {
          service: this.serviceName,
          from: oldSize,
          to: this.currentSize,
          reason: action.reason
        });
      } catch (error) {
        logger.error('Failed to scale up connection pool', {
          service: this.serviceName,
          error: error.message
        });
      }
    } else if (action.type === 'scale_down') {
      if (action.amount <= 0) return;
      
      this.currentSize = Math.max(
        this.currentSize - action.amount,
        this.config.minSize
      );
      
      // 收缩连接池
      try {
        await this.resizePool(this.currentSize);
        
        this.lastScaleTime = Date.now();
        this.recordScaleAction(action, oldSize, this.currentSize, metrics);
        
        this.emit('scale_down', {
          from: oldSize,
          to: this.currentSize,
          reason: action.reason,
          metrics
        });
        
        logger.info('Connection pool scaled down', {
          service: this.serviceName,
          from: oldSize,
          to: this.currentSize,
          reason: action.reason
        });
      } catch (error) {
        logger.error('Failed to scale down connection pool', {
          service: this.serviceName,
          error: error.message
        });
      }
    }
  }
  
  async resizePool(newSize) {
    // pg 连接池动态调整
    // 注意：pg-pool 不直接支持动态调整，需要通过其他方式
    
    // 方法 1：使用 pg-pool 的 max 属性（某些版本支持）
    if (this.pool.options && 'max' in this.pool.options) {
      this.pool.options.max = newSize;
    }
    
    // 方法 2：创建新连接预填充
    const currentTotal = this.pool.totalCount || 0;
    if (newSize > currentTotal) {
      // 创建新连接
      const newConnections = [];
      for (let i = 0; i < newSize - currentTotal; i++) {
        newConnections.push(this.pool.connect());
      }
      const clients = await Promise.all(newConnections);
      clients.forEach(client => client.release());
    }
    
    // 方法 3：标记需要减少的连接（空闲时移除）
    if (newSize < currentTotal) {
      // 设置淘汰标记，空闲连接会被移除
      this.pool._removeCount = currentTotal - newSize;
    }
  }
  
  recordScaleAction(action, from, to, metrics) {
    this.scaleHistory.push({
      timestamp: Date.now(),
      action: action.type,
      reason: action.reason,
      from,
      to,
      utilization: metrics.utilization,
      waitingClients: metrics.waitingClients
    });
    
    // 保留最近 100 条记录
    if (this.scaleHistory.length > 100) {
      this.scaleHistory.shift();
    }
  }
  
  cleanupIdleConnections(metrics) {
    // 定期清理长时间空闲的连接
    if (metrics.idleConnections > this.config.minSize) {
      const excessIdle = metrics.idleConnections - this.config.minSize;
      
      // 让池自动回收空闲连接
      // pg-pool 有 idleTimeoutMillis 配置
      logger.debug('Cleaning up idle connections', {
        service: this.serviceName,
        excessIdle
      });
    }
  }
  
  // 获取扩缩容历史
  getScaleHistory(limit = 20) {
    return this.scaleHistory.slice(-limit);
  }
  
  // 获取当前状态
  getStatus() {
    const metrics = this.collectPoolMetrics();
    return {
      serviceName: this.serviceName,
      currentSize: this.currentSize,
      minSize: this.config.minSize,
      maxSize: this.config.maxSize,
      targetUtilization: this.config.targetUtilization,
      ...metrics,
      lastScaleTime: this.lastScaleTime,
      recentScaleActions: this.getScaleHistory(5)
    };
  }
  
  destroy() {
    clearInterval(this.evaluationInterval);
  }
}

module.exports = { AdaptivePoolManager };
```

### 3. 连接池配置中心

```javascript
// backend/shared/poolConfigCenter.js
const logger = require('./logger');

class PoolConfigCenter {
  constructor() {
    // 服务级别的连接池配置
    this.serviceConfigs = new Map();
    
    // 全局默认配置
    this.defaultConfig = {
      minSize: 5,
      maxSize: 50,
      targetUtilization: 0.7,
      idleTimeoutMillis: 300000, // 5 分钟
      connectionTimeoutMillis: 10000, // 10 秒
      statement_timeout: 30000, // 30 秒
      query_timeout: 30000
    };
    
    // 时间段配置（针对不同时段调整基线）
    this.timeBasedConfigs = [
      {
        name: 'night',
        startHour: 0,
        endHour: 6,
        multiplier: 0.5 // 减半
      },
      {
        name: 'morning',
        startHour: 6,
        endHour: 12,
        multiplier: 0.8
      },
      {
        name: 'afternoon',
        startHour: 12,
        endHour: 18,
        multiplier: 1.0
      },
      {
        name: 'evening',
        startHour: 18,
        endHour: 24,
        multiplier: 1.2 // 高峰时段增加 20%
      }
    ];
  }
  
  registerService(serviceName, customConfig = {}) {
    const baseConfig = { ...this.defaultConfig, ...customConfig };
    
    this.serviceConfigs.set(serviceName, {
      baseConfig,
      currentConfig: { ...baseConfig },
      lastUpdated: Date.now()
    });
    
    logger.info('Service pool config registered', {
      service: serviceName,
      config: baseConfig
    });
  }
  
  getConfig(serviceName) {
    const serviceConfig = this.serviceConfigs.get(serviceName);
    if (!serviceConfig) {
      return this.defaultConfig;
    }
    
    // 应用时段调整
    const timeMultiplier = this.getTimeMultiplier();
    const config = { ...serviceConfig.baseConfig };
    
    config.maxSize = Math.ceil(config.maxSize * timeMultiplier);
    config.minSize = Math.max(
      Math.ceil(config.minSize * timeMultiplier),
      1 // 最少保留 1 个连接
    );
    
    return config;
  }
  
  getTimeMultiplier() {
    const hour = new Date().getHours();
    
    for (const timeConfig of this.timeBasedConfigs) {
      if (hour >= timeConfig.startHour && hour < timeConfig.endHour) {
        return timeConfig.multiplier;
      }
    }
    
    return 1.0;
  }
  
  // 根据历史数据优化配置
  optimizeConfig(serviceName, historicalMetrics) {
    const serviceConfig = this.serviceConfigs.get(serviceName);
    if (!serviceConfig) return;
    
    // 分析历史数据
    const peakUtilization = Math.max(...historicalMetrics.map(m => m.utilization));
    const avgUtilization = historicalMetrics.reduce((sum, m) => sum + m.utilization, 0) 
      / historicalMetrics.length;
    const maxWaitingClients = Math.max(...historicalMetrics.map(m => m.waitingClients));
    
    // 调整配置
    const optimizedConfig = { ...serviceConfig.baseConfig };
    
    // 如果峰值使用率接近上限，增加最大连接数
    if (peakUtilization > 0.9) {
      optimizedConfig.maxSize = Math.ceil(optimizedConfig.maxSize * 1.2);
    }
    
    // 如果平均使用率很低，减少最小连接数
    if (avgUtilization < 0.3) {
      optimizedConfig.minSize = Math.max(
        Math.ceil(optimizedConfig.minSize * 0.7),
        2
      );
    }
    
    // 如果经常有等待，增加基准连接数
    if (maxWaitingClients > 5) {
      optimizedConfig.minSize = Math.ceil(optimizedConfig.minSize * 1.5);
    }
    
    serviceConfig.baseConfig = optimizedConfig;
    serviceConfig.lastUpdated = Date.now();
    
    logger.info('Pool config optimized', {
      service: serviceName,
      newConfig: optimizedConfig,
      analysis: {
        peakUtilization,
        avgUtilization,
        maxWaitingClients
      }
    });
    
    return optimizedConfig;
  }
  
  // 批量更新配置
  updateConfigs(updates) {
    for (const [serviceName, newConfig] of Object.entries(updates)) {
      const serviceConfig = this.serviceConfigs.get(serviceName);
      if (serviceConfig) {
        serviceConfig.baseConfig = {
          ...serviceConfig.baseConfig,
          ...newConfig
        };
        serviceConfig.lastUpdated = Date.now();
      }
    }
  }
  
  // 获取所有服务状态
  getAllStatus() {
    const status = {};
    for (const [serviceName, config] of this.serviceConfigs) {
      status[serviceName] = {
        currentConfig: this.getConfig(serviceName),
        lastUpdated: config.lastUpdated
      };
    }
    return status;
  }
}

// 单例
const poolConfigCenter = new PoolConfigCenter();

module.exports = { PoolConfigCenter, poolConfigCenter };
```

### 4. 管理 API 端点

```javascript
// backend/gateway/src/routes/poolManagement.js
const express = require('express');
const router = express.Router();
const { poolConfigCenter } = require('../../shared/poolConfigCenter');
const { poolMetrics } = require('../../shared/poolMetrics');

// 获取所有连接池状态
router.get('/api/admin/pools/status', async (req, res) => {
  try {
    const status = poolConfigCenter.getAllStatus();
    
    // 添加 Prometheus 指标
    const metrics = {};
    for (const [service, config] of Object.entries(status)) {
      metrics[service] = {
        ...config,
        prometheus: {
          poolSize: await poolMetrics.poolSize.get({ service }),
          idleConnections: await poolMetrics.idleConnections.get({ service }),
          waitingClients: await poolMetrics.waitingClients.get({ service }),
          utilizationRate: await poolMetrics.utilizationRate.get({ service })
        }
      };
    }
    
    res.json({
      success: true,
      data: metrics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取单个服务连接池状态
router.get('/api/admin/pools/:service/status', async (req, res) => {
  const { service } = req.params;
  
  try {
    const config = poolConfigCenter.getConfig(service);
    
    res.json({
      success: true,
      data: {
        service,
        config,
        prometheus: {
          poolSize: await poolMetrics.poolSize.get({ service }),
          idleConnections: await poolMetrics.idleConnections.get({ service }),
          waitingClients: await poolMetrics.waitingClients.get({ service }),
          utilizationRate: await poolMetrics.utilizationRate.get({ service })
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 更新服务连接池配置
router.put('/api/admin/pools/:service/config', async (req, res) => {
  const { service } = req.params;
  const updates = req.body;
  
  try {
    poolConfigCenter.updateConfigs({ [service]: updates });
    
    const newConfig = poolConfigCenter.getConfig(service);
    
    res.json({
      success: true,
      message: 'Pool config updated',
      data: {
        service,
        oldConfig: req.body,
        newConfig
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 批量更新配置
router.post('/api/admin/pools/config/batch', async (req, res) => {
  const updates = req.body;
  
  try {
    poolConfigCenter.updateConfigs(updates);
    
    res.json({
      success: true,
      message: 'Batch update completed',
      updatedServices: Object.keys(updates)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 触发优化建议
router.post('/api/admin/pools/:service/optimize', async (req, res) => {
  const { service } = req.params;
  
  try {
    // 获取最近 1 小时的历史数据
    const historicalMetrics = await getHistoricalMetrics(service, 60);
    
    const optimizedConfig = poolConfigCenter.optimizeConfig(service, historicalMetrics);
    
    res.json({
      success: true,
      message: 'Pool config optimized',
      data: {
        service,
        optimizedConfig,
        analysis: {
          dataPoints: historicalMetrics.length,
          timeRange: '1 hour'
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取扩缩容历史
router.get('/api/admin/pools/:service/history', async (req, res) => {
  const { service } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    // 从 AdaptivePoolManager 获取历史
    const history = await getScaleHistory(service, limit);
    
    res.json({
      success: true,
      data: {
        service,
        history,
        count: history.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 强制扩容
router.post('/api/admin/pools/:service/scale-up', async (req, res) => {
  const { service } = req.params;
  const { amount = 5, reason = 'manual' } = req.body;
  
  try {
    const result = await forceScaleUp(service, amount, reason);
    
    res.json({
      success: true,
      message: 'Pool scaled up',
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 强制缩容
router.post('/api/admin/pools/:service/scale-down', async (req, res) => {
  const { service } = req.params;
  const { amount = 3, reason = 'manual' } = req.body;
  
  try {
    const result = await forceScaleDown(service, amount, reason);
    
    res.json({
      success: true,
      message: 'Pool scaled down',
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 5. 告警规则配置

```yaml
# infrastructure/k8s/monitoring/pool-alerts.yml
groups:
  - name: database_pool_alerts
    interval: 30s
    rules:
      # 连接池饱和告警
      - alert: DatabasePoolSaturated
        expr: |
          db_pool_utilization_rate > 0.9
          and db_pool_waiting_clients > 0
        for: 2m
        labels:
          severity: warning
          category: database
        annotations:
          summary: "数据库连接池接近饱和"
          description: "服务 {{ $labels.service }} 连接池使用率 {{ $value | humanizePercentage }}，有 {{ $labels.waiting }} 个客户端在等待"
      
      # 连接池完全耗尽
      - alert: DatabasePoolExhausted
        expr: |
          db_pool_utilization_rate >= 1.0
          and db_pool_waiting_clients > 5
        for: 1m
        labels:
          severity: critical
          category: database
        annotations:
          summary: "数据库连接池已耗尽"
          description: "服务 {{ $labels.service }} 连接池已满，{{ $labels.waiting }} 个客户端在排队等待"
      
      # 等待时间过长
      - alert: DatabasePoolHighWaitTime
        expr: |
          histogram_quantile(0.95, rate(db_pool_wait_time_seconds_bucket[5m])) > 0.1
        for: 5m
        labels:
          severity: warning
          category: database
        annotations:
          summary: "数据库连接等待时间过长"
          description: "服务 {{ $labels.service }} P95 等待时间 {{ $value | humanizeDuration }}"
      
      # 连接泄漏检测
      - alert: DatabaseConnectionLeak
        expr: |
          rate(db_pool_connections_leaked_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
          category: database
        annotations:
          summary: "检测到数据库连接泄漏"
          description: "服务 {{ $labels.service }} 检测到连接泄漏，速率: {{ $value | humanize }} /秒"
      
      # 连接创建速率异常
      - alert: DatabaseConnectionChurn
        expr: |
          rate(db_pool_connections_created_total[5m]) > 10
          or rate(db_pool_connections_destroyed_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
          category: database
        annotations:
          summary: "数据库连接频繁创建/销毁"
          description: "服务 {{ $labels.service }} 连接 churn 率异常"
      
      # 慢查询
      - alert: SlowDatabaseQuery
        expr: |
          histogram_quantile(0.95, rate(db_query_duration_seconds_bucket[5m])) > 1
        for: 5m
        labels:
          severity: warning
          category: database
        annotations:
          summary: "数据库慢查询"
          description: "服务 {{ $labels.service }} P95 查询时间 {{ $value | humanizeDuration }}"
```

### 6. Grafana 仪表板

```json
// infrastructure/k8s/monitoring/grafana-dashboards/db-pool.json
{
  "dashboard": {
    "title": "Database Connection Pool Dashboard",
    "uid": "db-pool",
    "panels": [
      {
        "title": "Pool Utilization by Service",
        "type": "graph",
        "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
        "targets": [
          {
            "expr": "db_pool_utilization_rate",
            "legendFormat": "{{ service }}"
          }
        ],
        "yaxes": [
          { "format": "percentunit", "max": 1, "min": 0 }
        ]
      },
      {
        "title": "Connections Over Time",
        "type": "graph",
        "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
        "targets": [
          {
            "expr": "db_pool_total_connections",
            "legendFormat": "{{ service }} total"
          },
          {
            "expr": "db_pool_idle_connections",
            "legendFormat": "{{ service }} idle"
          },
          {
            "expr": "db_pool_waiting_clients",
            "legendFormat": "{{ service }} waiting"
          }
        ]
      },
      {
        "title": "Wait Time Distribution",
        "type": "heatmap",
        "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
        "targets": [
          {
            "expr": "rate(db_pool_wait_time_seconds_bucket[5m])",
            "format": "heatmap"
          }
        ]
      },
      {
        "title": "Connection Creation/Destroy Rate",
        "type": "graph",
        "gridPos": { "x": 12, "y": 8, "w": 12, "h": 8 },
        "targets": [
          {
            "expr": "rate(db_pool_connections_created_total[5m])",
            "legendFormat": "{{ service }} created"
          },
          {
            "expr": "rate(db_pool_connections_destroyed_total[5m])",
            "legendFormat": "{{ service }} destroyed"
          }
        ]
      },
      {
        "title": "Query Duration by Type",
        "type": "graph",
        "gridPos": { "x": 0, "y": 16, "w": 12, "h": 8 },
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(db_query_duration_seconds_bucket[5m]))",
            "legendFormat": "{{ service }} {{ query_type }} P95"
          }
        ]
      },
      {
        "title": "Pool Status Table",
        "type": "table",
        "gridPos": { "x": 12, "y": 16, "w": 12, "h": 8 },
        "targets": [
          {
            "expr": "db_pool_total_connections",
            "format": "table",
            "instant": true
          }
        ],
        "transformations": [
          {
            "id": "merge"
          }
        ]
      }
    ]
  }
}
```

## 验收标准

- [ ] 所有服务集成连接池监控，Prometheus 指标正常采集
- [ ] 自适应扩缩容功能正常，能根据负载自动调整连接池大小
- [ ] 告警规则配置完成，能检测饱和、泄漏、慢查询等问题
- [ ] Grafana 仪表板创建完成，能可视化连接池状态
- [ ] 管理 API 端点可用，支持状态查询、配置更新、手动扩缩容
- [ ] 单元测试覆盖核心逻辑，覆盖率 > 80%
- [ ] 高峰时段连接等待时间降低 > 50%
- [ ] 低峰时段连接资源节省 > 30%

## 影响范围

- `backend/shared/poolMetrics.js` - 新增连接池监控模块
- `backend/shared/adaptivePoolManager.js` - 新增自适应管理器
- `backend/shared/poolConfigCenter.js` - 新增配置中心
- `backend/gateway/src/routes/poolManagement.js` - 新增管理 API
- `backend/shared/db.js` - 集成监控和管理器
- `infrastructure/k8s/monitoring/pool-alerts.yml` - 新增告警规则
- `infrastructure/k8s/monitoring/grafana-dashboards/db-pool.json` - 新增仪表板
- 所有微服务 - 集成连接池监控

## 参考

- [pg-pool 文档](https://node-postgres.com/apis/pool)
- [Prometheus Histogram 最佳实践](https://prometheus.io/docs/practices/histograms/)
- [PostgreSQL 连接池最佳实践](https://www.postgresql.org/docs/current/runtime-config-connection.html)
