/**
 * 数据库连接池自动弹性伸缩与健康巡检系统
 * REQ-00484 实现
 * 
 * 功能：
 * 1. 根据实时负载自动动态调整连接池大小
 * 2. 定期对 idle 连接执行心跳检测
 * 3. 检测并清理无效的陈旧连接
 * 4. 连接池溢出保护
 */

const EventEmitter = require('events');

/**
 * 连接池自动伸缩控制器
 */
class ConnectionPoolAutoScaler extends EventEmitter {
  constructor(pool, redis, config = {}) {
    super();
    this.pool = pool;
    this.redis = redis;
    this.config = {
      // 最小/最大连接数
      minConnections: config.minConnections || 5,
      maxConnections: config.maxConnections || 100,
      
      // 自动伸缩阈值
      scaleUpThreshold: config.scaleUpThreshold || 0.8, // 使用率超过80%扩容
      scaleDownThreshold: config.scaleDownThreshold || 0.3, // 使用率低于30%缩容
      
      // 伸缩步长
      scaleUpStep: config.scaleUpStep || 5,
      scaleDownStep: config.scaleDownStep || 3,
      
      // 冷却时间（毫秒）
      scaleCooldownMs: config.scaleCooldownMs || 60000, // 1分钟冷却
      
      // 健康检查
      healthCheckIntervalMs: config.healthCheckIntervalMs || 30000, // 30秒检查一次
      idleTimeoutMs: config.idleTimeoutMs || 300000, // 5分钟空闲超时
      
      // PID 控制参数
      pidKp: config.pidKp || 0.5,
      pidKi: config.pidKi || 0.1,
      pidKd: config.pidKd || 0.05,
      
      ...config
    };
    
    // PID 控制器状态
    this.pidState = {
      integral: 0,
      previousError: 0
    };
    
    // 伸缩状态
    this.scaleState = {
      currentConnections: this.config.minConnections,
      lastScaleTime: 0,
      scaleHistory: []
    };
    
    // 健康检查定时器
    this.healthCheckTimer = null;
    
    // 统计数据
    this.stats = {
      totalScaleUps: 0,
      totalScaleDowns: 0,
      healthChecks: 0,
      unhealthyConnections: 0,
      lastCheckTime: null
    };
  }

  /**
   * 启动自动伸缩器
   */
  start() {
    // 启动健康检查定时器
    this.healthCheckTimer = setInterval(
      () => this.performHealthCheck(),
      this.config.healthCheckIntervalMs
    );
    
    // 初始健康检查
    this.performHealthCheck();
    
    this.emit('started', {
      minConnections: this.config.minConnections,
      maxConnections: this.config.maxConnections
    });
  }

  /**
   * 停止自动伸缩器
   */
  stop() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    this.emit('stopped');
  }

  /**
   * 执行健康检查并自动伸缩
   */
  async performHealthCheck() {
    const startTime = Date.now();
    
    try {
      // 1. 获取连接池状态
      const poolStatus = await this.getPoolStatus();
      
      // 2. 执行连接健康检查
      const healthResults = await this.checkConnectionHealth(poolStatus);
      
      // 3. 清理不健康的连接
      await this.cleanupUnhealthyConnections(healthResults.unhealthy);
      
      // 4. 根据 PID 控制算法计算目标连接数
      const targetConnections = this.calculateTargetConnections(poolStatus);
      
      // 5. 执行伸缩操作
      await this.adjustPoolSize(targetConnections, poolStatus);
      
      // 6. 更新统计
      this.stats.healthChecks++;
      this.stats.lastCheckTime = new Date().toISOString();
      
      // 7. 缓存状态到 Redis
      await this.cachePoolStatus(poolStatus);
      
      const duration = Date.now() - startTime;
      
      this.emit('health-check-completed', {
        poolStatus,
        healthResults,
        targetConnections,
        duration
      });
      
      return {
        poolStatus,
        healthResults,
        duration
      };
    } catch (error) {
      this.emit('health-check-error', { error });
      throw error;
    }
  }

  /**
   * 获取连接池状态
   */
  async getPoolStatus() {
    const poolInfo = this.pool.pool || this.pool;
    
    // 获取连接池信息
    const totalConnections = poolInfo.totalCount || poolInfo._allConnections?.length || 0;
    const idleConnections = poolInfo.idleCount || poolInfo._idle?.length || 0;
    const waitingClients = poolInfo.waitingCount || poolInfo._pendingAcquires?.length || 0;
    
    // 计算使用率
    const activeConnections = totalConnections - idleConnections;
    const utilization = totalConnections > 0 ? activeConnections / totalConnections : 0;
    
    // 从 Redis 获取历史数据
    const historyKey = 'pool:stats:history';
    const history = await this.redis.lrange(historyKey, 0, 59); // 最近60个数据点
    
    // 计算平均使用率
    let avgUtilization = utilization;
    if (history.length > 0) {
      const utilizationSum = history.reduce((sum, data) => {
        try {
          const parsed = JSON.parse(data);
          return sum + parsed.utilization;
        } catch {
          return sum;
        }
      }, utilization);
      avgUtilization = utilizationSum / (history.length + 1);
    }
    
    return {
      totalConnections,
      idleConnections,
      activeConnections,
      waitingClients,
      utilization,
      avgUtilization,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 检查连接健康
   */
  async checkConnectionHealth(poolStatus) {
    const healthy = [];
    const unhealthy = [];
    
    // 获取空闲连接
    const idleConnections = this._getIdleConnections();
    
    for (const conn of idleConnections) {
      try {
        // 执行心跳检测
        await this._pingConnection(conn);
        
        // 检查连接是否超时
        const idleTime = Date.now() - (conn.lastUsed || conn._idleStart || 0);
        
        if (idleTime > this.config.idleTimeoutMs) {
          unhealthy.push({
            connection: conn,
            reason: 'idle_timeout',
            idleTime
          });
        } else {
          healthy.push(conn);
        }
      } catch (error) {
        unhealthy.push({
          connection: conn,
          reason: 'health_check_failed',
          error: error.message
        });
      }
    }
    
    return {
      healthy: healthy.length,
      unhealthy,
      checkedCount: idleConnections.length
    };
  }

  /**
   * 清理不健康的连接
   */
  async cleanupUnhealthyConnections(unhealthyList) {
    for (const item of unhealthyList) {
      try {
        // 从连接池移除连接
        await this._removeConnection(item.connection);
        
        this.stats.unhealthyConnections++;
        
        this.emit('connection-removed', {
          reason: item.reason,
          idleTime: item.idleTime
        });
      } catch (error) {
        this.emit('connection-remove-error', {
          error: error.message
        });
      }
    }
  }

  /**
   * 使用 PID 控制算法计算目标连接数
   */
  calculateTargetConnections(poolStatus) {
    const setpoint = (this.config.scaleUpThreshold + this.config.scaleDownThreshold) / 2;
    const error = setpoint - poolStatus.avgUtilization;
    
    // PID 计算
    const deltaTime = this.config.healthCheckIntervalMs / 1000;
    
    // 积分项
    this.pidState.integral += error * deltaTime;
    this.pidState.integral = Math.max(-10, Math.min(10, this.pidState.integral)); // 抗饱和
    
    // 微分项
    const derivative = (error - this.pidState.previousError) / deltaTime;
    this.pidState.previousError = error;
    
    // PID 输出
    const pidOutput = (
      this.config.pidKp * error +
      this.config.pidKi * this.pidState.integral +
      this.config.pidKd * derivative
    );
    
    // 计算目标连接数
    let targetConnections = this.scaleState.currentConnections + pidOutput * this.config.scaleUpStep;
    
    // 限制范围
    targetConnections = Math.max(
      this.config.minConnections,
      Math.min(this.config.maxConnections, Math.round(targetConnections))
    );
    
    return targetConnections;
  }

  /**
   * 调整连接池大小
   */
  async adjustPoolSize(targetConnections, poolStatus) {
    const currentConnections = poolStatus.totalConnections;
    const now = Date.now();
    
    // 检查冷却时间
    if (now - this.scaleState.lastScaleTime < this.config.scaleCooldownMs) {
      return { action: 'cooldown', reason: '冷却时间内' };
    }
    
    // 无需调整
    if (targetConnections === currentConnections) {
      return { action: 'none', reason: '连接数已达目标' };
    }
    
    // 扩容
    if (targetConnections > currentConnections) {
      const increment = Math.min(
        this.config.scaleUpStep,
        targetConnections - currentConnections
      );
      
      await this._scaleUp(increment);
      
      this.stats.totalScaleUps++;
      this.scaleState.lastScaleTime = now;
      this.scaleState.currentConnections = currentConnections + increment;
      this.scaleState.scaleHistory.push({
        action: 'scale_up',
        from: currentConnections,
        to: currentConnections + increment,
        timestamp: new Date().toISOString()
      });
      
      this.emit('scaled-up', {
        from: currentConnections,
        to: currentConnections + increment,
        reason: 'high_utilization'
      });
      
      return { action: 'scale_up', increment };
    }
    
    // 缩容
    if (targetConnections < currentConnections) {
      const decrement = Math.min(
        this.config.scaleDownStep,
        currentConnections - targetConnections
      );
      
      await this._scaleDown(decrement);
      
      this.stats.totalScaleDowns++;
      this.scaleState.lastScaleTime = now;
      this.scaleState.currentConnections = currentConnections - decrement;
      this.scaleState.scaleHistory.push({
        action: 'scale_down',
        from: currentConnections,
        to: currentConnections - decrement,
        timestamp: new Date().toISOString()
      });
      
      this.emit('scaled-down', {
        from: currentConnections,
        to: currentConnections - decrement,
        reason: 'low_utilization'
      });
      
      return { action: 'scale_down', decrement };
    }
  }

  /**
   * 缓存连接池状态到 Redis
   */
  async cachePoolStatus(poolStatus) {
    const key = 'pool:stats:current';
    const historyKey = 'pool:stats:history';
    
    // 存储当前状态
    await this.redis.set(key, JSON.stringify(poolStatus), 'EX', 60);
    
    // 添加到历史列表
    await this.redis.lpush(historyKey, JSON.stringify(poolStatus));
    await this.redis.ltrim(historyKey, 0, 59); // 保留最近60个数据点
    await this.redis.expire(historyKey, 3600); // 1小时过期
  }

  /**
   * 获取健康度指标
   */
  getHealthMetrics() {
    return {
      ...this.stats,
      pidState: this.pidState,
      scaleState: {
        currentConnections: this.scaleState.currentConnections,
        lastScaleTime: this.scaleState.lastScaleTime,
        recentScales: this.scaleState.scaleHistory.slice(-10)
      }
    };
  }

  // 私有方法

  _getIdleConnections() {
    const poolInfo = this.pool.pool || this.pool;
    
    if (poolInfo._idle) {
      return poolInfo._idle;
    }
    
    if (poolInfo._allConnections) {
      return poolInfo._allConnections.filter(conn => !conn.inUse);
    }
    
    return [];
  }

  async _pingConnection(connection) {
    // 执行简单的 SELECT 1 测试
    if (connection.query) {
      await connection.query('SELECT 1');
    } else if (connection.execute) {
      await connection.execute('SELECT 1');
    }
  }

  async _removeConnection(connection) {
    try {
      if (connection.end) {
        await connection.end();
      } else if (connection.release) {
        connection.release();
      } else if (connection.destroy) {
        connection.destroy();
      }
    } catch (error) {
      // 忽略移除错误
    }
  }

  async _scaleUp(increment) {
    // pg 连接池动态扩容
    const poolInfo = this.pool.pool || this.pool;
    
    // 对于 pg-pool，增加 min/max 配置
    if (poolInfo.options) {
      poolInfo.options.min = (poolInfo.options.min || 0) + increment;
      poolInfo.options.max = (poolInfo.options.max || 0) + increment;
    }
    
    // 对于 generic-pool，动态增加容量
    if (poolInfo._config) {
      poolInfo._config.max = (poolInfo._config.max || 0) + increment;
    }
  }

  async _scaleDown(decrement) {
    const poolInfo = this.pool.pool || this.pool;
    
    // 对于 pg-pool，减少 min/max 配置
    if (poolInfo.options) {
      poolInfo.options.min = Math.max(
        this.config.minConnections,
        (poolInfo.options.min || 0) - decrement
      );
      poolInfo.options.max = Math.max(
        this.config.minConnections,
        (poolInfo.options.max || 0) - decrement
      );
    }
    
    // 对于 generic-pool，动态减少容量
    if (poolInfo._config) {
      poolInfo._config.max = Math.max(
        this.config.minConnections,
        (poolInfo._config.max || 0) - decrement
      );
    }
  }
}

/**
 * 连接池健康巡检器
 */
class ConnectionPoolHealthChecker {
  constructor(pool, db, config = {}) {
    this.pool = pool;
    this.db = db;
    this.config = {
      checkIntervalMs: config.checkIntervalMs || 60000, // 1分钟
      queryTimeoutMs: config.queryTimeoutMs || 5000, // 5秒超时
      unhealthyThreshold: config.unhealthyThreshold || 3, // 连续3次失败判定不健康
      ...config
    };
    
    this.checkTimer = null;
    this.failureCounts = new Map();
    this.healthStatus = {
      isHealthy: true,
      lastCheckTime: null,
      consecutiveFailures: 0,
      issues: []
    };
  }

  /**
   * 启动健康巡检
   */
  start() {
    this.checkTimer = setInterval(
      () => this.performCheck(),
      this.config.checkIntervalMs
    );
    
    // 立即执行一次检查
    this.performCheck();
  }

  /**
   * 停止健康巡检
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 执行健康检查
   */
  async performCheck() {
    const startTime = Date.now();
    const issues = [];
    
    try {
      // 1. 检查连接池基本状态
      const poolStatus = await this.checkPoolStatus();
      
      // 2. 执行数据库连接测试
      const connectionTest = await this.testConnection();
      
      // 3. 检查数据库响应时间
      const responseTime = Date.now() - startTime;
      
      // 4. 检查连接泄漏
      const leakCheck = await this.checkConnectionLeak(poolStatus);
      
      // 5. 判断健康状态
      const isHealthy = connectionTest.success && 
                        responseTime < this.config.queryTimeoutMs &&
                        !leakCheck.hasLeak;
      
      if (!connectionTest.success) {
        issues.push({
          type: 'connection_failed',
          severity: 'critical',
          message: connectionTest.error
        });
      }
      
      if (responseTime > this.config.queryTimeoutMs) {
        issues.push({
          type: 'slow_response',
          severity: 'warning',
          message: `响应时间 ${responseTime}ms 超过阈值 ${this.config.queryTimeoutMs}ms`
        });
      }
      
      if (leakCheck.hasLeak) {
        issues.push({
          type: 'connection_leak',
          severity: 'warning',
          message: `检测到 ${leakCheck.leakedCount} 个潜在连接泄漏`
        });
      }
      
      // 更新健康状态
      this.healthStatus = {
        isHealthy,
        lastCheckTime: new Date().toISOString(),
        consecutiveFailures: isHealthy ? 0 : this.healthStatus.consecutiveFailures + 1,
        poolStatus,
        responseTime,
        issues
      };
      
      // 记录到数据库
      await this.recordHealthCheck(this.healthStatus);
      
      return this.healthStatus;
    } catch (error) {
      this.healthStatus.consecutiveFailures++;
      this.healthStatus.issues.push({
        type: 'check_error',
        severity: 'critical',
        message: error.message
      });
      
      return this.healthStatus;
    }
  }

  /**
   * 检查连接池状态
   */
  async checkPoolStatus() {
    const poolInfo = this.pool.pool || this.pool;
    
    return {
      totalConnections: poolInfo.totalCount || poolInfo._allConnections?.length || 0,
      idleConnections: poolInfo.idleCount || poolInfo._idle?.length || 0,
      waitingClients: poolInfo.waitingCount || poolInfo._pendingAcquires?.length || 0
    };
  }

  /**
   * 测试数据库连接
   */
  async testConnection() {
    try {
      const client = await this.pool.connect();
      
      try {
        await client.query('SELECT 1');
        return { success: true };
      } finally {
        client.release();
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 检查连接泄漏
   */
  async checkConnectionLeak(poolStatus) {
    // 如果活跃连接数远大于等待客户端数，可能存在泄漏
    const activeConnections = poolStatus.totalConnections - poolStatus.idleConnections;
    const hasLeak = activeConnections > poolStatus.waitingClients * 2;
    
    return {
      hasLeak,
      leakedCount: hasLeak ? activeConnections - poolStatus.waitingClients : 0
    };
  }

  /**
   * 记录健康检查结果
   */
  async recordHealthCheck(status) {
    try {
      await this.db.query(`
        INSERT INTO connection_pool_health_checks
          (is_healthy, pool_status, response_time_ms, issues, checked_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [
        status.isHealthy,
        JSON.stringify(status.poolStatus),
        status.responseTime || 0,
        JSON.stringify(status.issues)
      ]);
    } catch (error) {
      // 忽略记录错误
    }
  }

  /**
   * 获取健康状态
   */
  getHealthStatus() {
    return this.healthStatus;
  }
}

/**
 * 连接池溢出保护器
 */
class ConnectionPoolOverflowProtector {
  constructor(pool, redis, config = {}) {
    this.pool = pool;
    this.redis = redis;
    this.config = {
      maxQueueSize: config.maxQueueSize || 100,
      queueTimeoutMs: config.queueTimeoutMs || 5000,
      failureThreshold: config.failureThreshold || 10,
      failureWindowMs: config.failureWindowMs || 60000,
      ...config
    };
    
    this.queue = [];
    this.failures = [];
    this.isCircuitOpen = false;
  }

  /**
   * 获取连接（带溢出保护）
   */
  async getConnection() {
    // 检查熔断器状态
    if (this.isCircuitOpen) {
      throw new Error('Connection pool circuit breaker is open');
    }
    
    // 检查队列长度
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new Error('Connection pool queue is full');
    }
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.queue.findIndex(item => item.reject === reject);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new Error('Connection pool queue timeout'));
        }
      }, this.config.queueTimeoutMs);
      
      this.queue.push({
        resolve: (client) => {
          clearTimeout(timeoutId);
          resolve(client);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      });
      
      this._processQueue();
    });
  }

  /**
   * 处理队列
   */
  async _processQueue() {
    while (this.queue.length > 0) {
      const item = this.queue[0];
      
      try {
        const client = await this.pool.connect();
        this.queue.shift();
        item.resolve(client);
        
        // 清除失败记录
        this.failures = this.failures.filter(
          f => Date.now() - f.time < this.config.failureWindowMs
        );
      } catch (error) {
        // 记录失败
        this.failures.push({
          time: Date.now(),
          error: error.message
        });
        
        // 检查是否需要打开熔断器
        const recentFailures = this.failures.filter(
          f => Date.now() - f.time < this.config.failureWindowMs
        );
        
        if (recentFailures.length >= this.config.failureThreshold) {
          this.isCircuitOpen = true;
          
          // 拒绝所有等待的请求
          while (this.queue.length > 0) {
            const waitingItem = this.queue.shift();
            waitingItem.reject(new Error('Connection pool circuit breaker opened'));
          }
          
          // 设置熔断器恢复时间
          setTimeout(() => {
            this.isCircuitOpen = false;
            this.failures = [];
          }, this.config.failureWindowMs);
        }
        
        break;
      }
    }
  }

  /**
   * 获取溢出保护状态
   */
  getStatus() {
    return {
      queueSize: this.queue.length,
      maxQueueSize: this.config.maxQueueSize,
      recentFailures: this.failures.filter(
        f => Date.now() - f.time < this.config.failureWindowMs
      ).length,
      isCircuitOpen: this.isCircuitOpen
    };
  }
}

module.exports = {
  ConnectionPoolAutoScaler,
  ConnectionPoolHealthChecker,
  ConnectionPoolOverflowProtector
};
