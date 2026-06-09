/**
 * HealthChecker - 多区域健康检查服务
 * 
 * 功能：
 * - 定期检测所有服务的健康状态
 * - 跟踪连续失败/恢复次数
 * - 触发健康状态变更事件
 * - 暴露 Prometheus 指标
 */

const { EventEmitter } = require('events');
const axios = require('axios');

class HealthChecker extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      checkInterval: config.checkInterval || 5000,
      timeout: config.timeout || 3000,
      failureThreshold: config.failureThreshold || 3,
      recoveryThreshold: config.recoveryThreshold || 2,
      services: config.services || [],
      ...config
    };
    
    this.region = process.env.REGION || 'primary';
    this.healthStatus = new Map();
    this.failureCounts = new Map();
    this.recoveryCounts = new Map();
    this.isRunning = false;
    this.timer = null;
    this.metrics = null;
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    try {
      const { metrics } = require('../logging');
      this.metrics = metrics;
      
      // 健康检查指标
      if (!metrics._registered_dr_health_check_status) {
        metrics.gauge('dr_health_check_status', 'Health check status (1=healthy, 0=unhealthy)', 
          ['service', 'region']);
        metrics._registered_dr_health_check_status = true;
      }
      
      if (!metrics._registered_dr_failure_count) {
        metrics.gauge('dr_failure_count', 'Consecutive failure count', 
          ['service', 'region']);
        metrics._registered_dr_failure_count = true;
      }
      
      if (!metrics._registered_dr_health_check_latency_seconds) {
        metrics.histogram('dr_health_check_latency_seconds', 'Health check latency', 
          ['service', 'region']);
        metrics._registered_dr_health_check_latency_seconds = true;
      }
      
      if (!metrics._registered_dr_failover_events_total) {
        metrics.counter('dr_failover_events_total', 'Failover events count', 
          ['from_region', 'to_region', 'trigger']);
        metrics._registered_dr_failover_events_total = true;
      }
    } catch (e) {
      // metrics may not be available in test environment
    }
  }
  
  /**
   * 启动健康检查
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('[HealthChecker] Started', { region: this.region });
    
    // 初始检查
    await this.runHealthChecks();
    
    // 定时检查
    this.timer = setInterval(() => {
      this.runHealthChecks().catch(err => {
        console.error('[HealthChecker] Error:', err.message);
      });
    }, this.config.checkInterval);
  }
  
  /**
   * 执行所有健康检查
   */
  async runHealthChecks() {
    if (this.config.services.length === 0) {
      return { healthy: true, healthyServices: [], unhealthyServices: [] };
    }
    
    const results = await Promise.allSettled(
      this.config.services.map(service => this.checkService(service))
    );
    
    const unhealthyServices = [];
    const healthyServices = [];
    
    results.forEach((result, index) => {
      const service = this.config.services[index];
      const key = `${service.name}:${service.region || this.region}`;
      
      if (result.status === 'fulfilled' && result.value.healthy) {
        healthyServices.push(service);
        this.handleHealthy(service, result.value);
      } else {
        unhealthyServices.push(service);
        this.handleUnhealthy(service, result.reason || result.value);
      }
    });
    
    // 触发健康状态变更事件
    const overallHealth = unhealthyServices.length === 0;
    this.emit('health-status-change', {
      region: this.region,
      healthy: overallHealth,
      healthyCount: healthyServices.length,
      unhealthyCount: unhealthyServices.length,
      timestamp: new Date().toISOString()
    });
    
    return {
      healthy: overallHealth,
      healthyServices,
      unhealthyServices
    };
  }
  
  /**
   * 检查单个服务
   */
  async checkService(service) {
    const startTime = Date.now();
    
    try {
      const response = await axios.get(`${service.url}/health`, {
        timeout: this.config.timeout,
        validateStatus: (status) => status < 500
      });
      
      const latency = (Date.now() - startTime) / 1000;
      
      this.recordLatency(service.name, service.region || this.region, latency);
      
      if (response.status === 200 && response.data?.status === 'healthy') {
        return {
          healthy: true,
          latency,
          checks: response.data.checks || {}
        };
      }
      
      return {
        healthy: false,
        latency,
        status: response.status,
        error: 'Unhealthy response'
      };
    } catch (error) {
      const latency = (Date.now() - startTime) / 1000;
      
      this.recordLatency(service.name, service.region || this.region, latency);
      
      return {
        healthy: false,
        latency,
        error: error.message
      };
    }
  }
  
  /**
   * 记录延迟指标
   */
  recordLatency(serviceName, region, latency) {
    if (this.metrics) {
      try {
        this.metrics.histogram('dr_health_check_latency_seconds').observe(
          { service: serviceName, region },
          latency
        );
      } catch (e) {
        // Ignore metric errors
      }
    }
  }
  
  /**
   * 处理健康服务
   */
  handleHealthy(service, result) {
    const key = `${service.name}:${service.region || this.region}`;
    
    // 重置失败计数
    this.failureCounts.set(key, 0);
    
    // 增加恢复计数
    const recoveryCount = (this.recoveryCounts.get(key) || 0) + 1;
    this.recoveryCounts.set(key, recoveryCount);
    
    // 更新健康状态
    if (recoveryCount >= this.config.recoveryThreshold) {
      const wasUnhealthy = this.healthStatus.get(key) === false;
      this.healthStatus.set(key, true);
      
      if (wasUnhealthy) {
        console.log('[HealthChecker] Service recovered:', { 
          service: service.name, 
          region: service.region || this.region,
          recoveryCount 
        });
        this.emit('service-recovered', { service, result });
      }
    }
    
    // 更新指标
    this.updateMetrics(service.name, service.region || this.region, true, 0);
  }
  
  /**
   * 处理不健康服务
   */
  handleUnhealthy(service, reason) {
    const key = `${service.name}:${service.region || this.region}`;
    
    // 重置恢复计数
    this.recoveryCounts.set(key, 0);
    
    // 增加失败计数
    const failureCount = (this.failureCounts.get(key) || 0) + 1;
    this.failureCounts.set(key, failureCount);
    
    console.warn('[HealthChecker] Service health check failed:', {
      service: service.name,
      region: service.region || this.region,
      failureCount,
      threshold: this.config.failureThreshold,
      reason: reason?.message || reason?.error || 'Unknown'
    });
    
    // 更新健康状态
    if (failureCount >= this.config.failureThreshold) {
      const wasHealthy = this.healthStatus.get(key) !== false;
      this.healthStatus.set(key, false);
      
      if (wasHealthy) {
        console.error('[HealthChecker] Service marked unhealthy:', {
          service: service.name,
          region: service.region || this.region,
          failureCount
        });
        this.emit('service-unhealthy', { service, reason, failureCount });
      }
    }
    
    // 更新指标
    this.updateMetrics(service.name, service.region || this.region, false, failureCount);
  }
  
  /**
   * 更新 Prometheus 指标
   */
  updateMetrics(serviceName, region, healthy, failureCount) {
    if (this.metrics) {
      try {
        this.metrics.gauge('dr_health_check_status').set(
          { service: serviceName, region },
          healthy ? 1 : 0
        );
        this.metrics.gauge('dr_failure_count').set(
          { service: serviceName, region },
          failureCount
        );
      } catch (e) {
        // Ignore metric errors
      }
    }
  }
  
  /**
   * 获取健康状态
   */
  getHealthStatus() {
    const status = {
      region: this.region,
      overall: true,
      services: {},
      timestamp: new Date().toISOString()
    };
    
    this.healthStatus.forEach((healthy, key) => {
      const [serviceName, serviceRegion] = key.split(':');
      
      if (!status.services[serviceName]) {
        status.services[serviceName] = {};
      }
      
      status.services[serviceName][serviceRegion] = {
        healthy,
        failureCount: this.failureCounts.get(key) || 0,
        recoveryCount: this.recoveryCounts.get(key) || 0
      };
      
      if (!healthy) {
        status.overall = false;
      }
    });
    
    return status;
  }
  
  /**
   * 停止健康检查
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('[HealthChecker] Stopped', { region: this.region });
  }
  
  /**
   * 添加服务到监控列表
   */
  addService(service) {
    this.config.services.push(service);
  }
  
  /**
   * 移除服务
   */
  removeService(serviceName, region) {
    const key = `${serviceName}:${region || this.region}`;
    this.config.services = this.config.services.filter(
      s => !(s.name === serviceName && (s.region || this.region) === (region || this.region))
    );
    this.healthStatus.delete(key);
    this.failureCounts.delete(key);
    this.recoveryCounts.delete(key);
  }
}

module.exports = HealthChecker;
