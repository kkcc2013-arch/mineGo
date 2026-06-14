// backend/shared/HealthChecker.js
'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const os = require('os');

const logger = createLogger('health-checker');

/**
 * 多层级健康检查系统
 * 
 * 支持多层健康检查：
 * - HTTP 健康检查（/health/live、/health/ready）
 * - 依赖服务健康检查（PostgreSQL、Redis、Kafka）
 * - 资源健康检查（CPU、内存、磁盘、连接池）
 * - 业务健康检查（关键业务指标监控）
 */
class HealthChecker extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.checks = new Map();
    this.criticalChecks = config.criticalChecks || ['database', 'redis'];
    this.importantChecks = config.importantChecks || ['kafka', 'resources'];
    this.checkInterval = config.checkInterval || 30000; // 30 seconds
    this.timeout = config.timeout || 5000; // 5 seconds per check
    
    this.lastResults = null;
    this.checkTimer = null;
    this.isRunning = false;
    
    // 资源阈值
    this.resourceThresholds = {
      cpu: config.cpuThreshold || 80, // CPU 使用率阈值 (%)
      memory: config.memoryThreshold || 85, // 内存使用率阈值 (%)
      disk: config.diskThreshold || 90, // 磁盘使用率阈值 (%)
      connections: config.connectionsThreshold || 80 // 连接池使用率阈值 (%)
    };
  }
  
  /**
   * 注册健康检查
   */
  register(name, checkFn, options = {}) {
    const config = {
      checkFn,
      critical: options.critical || false,
      timeout: options.timeout || this.timeout,
      description: options.description || '',
      ...options
    };
    
    this.checks.set(name, config);
    logger.info(`Health check registered: ${name}`, { critical: config.critical });
  }
  
  /**
   * 执行单个健康检查
   */
  async runCheck(name, config) {
    const startTime = Date.now();
    
    try {
      const result = await Promise.race([
        config.checkFn(),
        this.createTimeout(config.timeout)
      ]);
      
      const latency = Date.now() - startTime;
      
      return {
        name,
        status: 'healthy',
        latency_ms: latency,
        timestamp: new Date().toISOString(),
        ...result
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      
      logger.error(`Health check failed: ${name}`, {
        error: error.message,
        latency_ms: latency
      });
      
      return {
        name,
        status: 'unhealthy',
        latency_ms: latency,
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }
  
  /**
   * 执行所有健康检查
   */
  async runAllChecks() {
    const results = {};
    const checkPromises = [];
    
    for (const [name, config] of this.checks) {
      checkPromises.push(this.runCheck(name, config));
    }
    
    const checkResults = await Promise.all(checkPromises);
    
    for (const result of checkResults) {
      results[result.name] = result;
      delete result.name; // Remove duplicate name field
    }
    
    const overall = this.calculateOverallStatus(results);
    this.lastResults = { ...overall, checks: results };
    
    return this.lastResults;
  }
  
  /**
   * 计算整体健康状态
   */
  calculateOverallStatus(results) {
    // 检查关键服务
    for (const name of this.criticalChecks) {
      if (results[name] && results[name].status === 'unhealthy') {
        return {
          status: 'unhealthy',
          message: `Critical service ${name} is unhealthy`,
          timestamp: new Date().toISOString()
        };
      }
    }
    
    // 检查重要服务
    const degradedServices = [];
    for (const name of this.importantChecks) {
      if (results[name] && results[name].status === 'unhealthy') {
        degradedServices.push(name);
      }
    }
    
    if (degradedServices.length > 0) {
      return {
        status: 'degraded',
        message: `Services degraded: ${degradedServices.join(', ')}`,
        degradedServices,
        timestamp: new Date().toISOString()
      };
    }
    
    return {
      status: 'healthy',
      message: 'All services are healthy',
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 存活探针检查（Liveness Probe）
   * 仅检查服务自身是否存活
   */
  async livenessCheck() {
    return {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 就绪探针检查（Readiness Probe）
   * 检查服务是否准备好接收流量
   */
  async readinessCheck() {
    if (!this.lastResults) {
      await this.runAllChecks();
    }
    
    return {
      status: this.lastResults.status === 'healthy' ? 'ready' : 'not_ready',
      checks: this.lastResults.checks,
      degradedServices: this.lastResults.degradedServices || [],
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 资源健康检查
   */
  async checkResources() {
    const cpuUsage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    
    const memoryPercent = ((totalMemory - freeMemory) / totalMemory) * 100;
    const heapUsedPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
    
    // 获取 CPU 使用率（近似值）
    const cpuPercent = (cpuUsage.user + cpuUsage.system) / (process.uptime() * 1000000) * 100;
    
    const status = {
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_percent: Math.round(memoryPercent * 100) / 100,
      heap_used_percent: Math.round(heapUsedPercent * 100) / 100,
      heap_used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      external_mb: Math.round(memoryUsage.external / 1024 / 1024),
      uptime_seconds: Math.round(process.uptime())
    };
    
    // 检查资源是否超过阈值
    const issues = [];
    
    if (status.cpu_percent > this.resourceThresholds.cpu) {
      issues.push(`CPU usage ${status.cpu_percent}% exceeds threshold ${this.resourceThresholds.cpu}%`);
    }
    
    if (status.memory_percent > this.resourceThresholds.memory) {
      issues.push(`Memory usage ${status.memory_percent}% exceeds threshold ${this.resourceThresholds.memory}%`);
    }
    
    if (issues.length > 0) {
      return {
        status: 'unhealthy',
        ...status,
        issues
      };
    }
    
    return {
      status: 'healthy',
      ...status
    };
  }
  
  /**
   * 创建超时 Promise
   */
  createTimeout(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Health check timeout after ${ms}ms`)), ms);
    });
  }
  
  /**
   * 启动定期健康检查
   */
  startPeriodicCheck() {
    if (this.isRunning) {
      return;
    }
    
    this.isRunning = true;
    
    // 立即执行一次
    this.runAllChecks().catch(err => {
      logger.error('Periodic health check failed', { error: err.message });
    });
    
    // 定期执行
    this.checkTimer = setInterval(async () => {
      try {
        const results = await this.runAllChecks();
        this.emit('health-check', results);
        
        // 如果状态变化，发出事件
        if (results.status !== 'healthy') {
          this.emit('health-degraded', results);
        }
      } catch (error) {
        logger.error('Periodic health check failed', { error: error.message });
        this.emit('health-check-error', error);
      }
    }, this.checkInterval);
    
    logger.info('Periodic health check started', { interval: this.checkInterval });
  }
  
  /**
   * 停止定期健康检查
   */
  stopPeriodicCheck() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    
    this.isRunning = false;
    logger.info('Periodic health check stopped');
  }
  
  /**
   * 获取上次检查结果
   */
  getLastResults() {
    return this.lastResults;
  }
  
  /**
   * 获取健康检查统计信息
   */
  getStats() {
    return {
      totalChecks: this.checks.size,
      criticalChecks: this.criticalChecks.length,
      importantChecks: this.importantChecks.length,
      isRunning: this.isRunning,
      lastCheckTime: this.lastResults?.timestamp || null
    };
  }
}

module.exports = HealthChecker;
