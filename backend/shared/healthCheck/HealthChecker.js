'use strict';

/**
 * REQ-00508: 服务健康检查器
 * 
 * 功能：
 * - HTTP/gRPC 健康探针
 * - 支持自定义检查频率、超时、失败阈值
 * - 健康状态管理与事件通知
 * - 服务实例权重调整
 */

const http = require('http');
const https = require('https');
const EventEmitter = require('events');

class HealthChecker extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.checkIntervalMs = config.checkIntervalMs || 5000;   // 默认 5 秒
    this.timeoutMs = config.timeoutMs || 2000;                // 默认 2 秒
    this.failureThreshold = config.failureThreshold || 3;     // 默认 3 次失败
    this.successThreshold = config.successThreshold || 2;     // 默认 2 次成功恢复
    
    this.services = new Map();  // 服务实例映射
    this.timers = new Map();    // 定时器映射
    this.logger = config.logger || console;
  }

  /**
   * 注册服务实例
   * @param {Object} serviceInstance - 服务实例配置
   * @returns {string} 实例ID
   */
  register(serviceInstance) {
    const {
      id,
      name,
      host,
      port,
      protocol = 'http',
      healthPath = '/health',
      checkInterval = this.checkIntervalMs,
      timeout = this.timeoutMs,
      metadata = {}
    } = serviceInstance;

    const instanceId = id || `${name}-${host}:${port}`;
    
    const instance = {
      id: instanceId,
      name,
      host,
      port,
      protocol,
      healthPath,
      checkInterval,
      timeout,
      metadata,
      status: 'unknown',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastCheck: null,
      lastError: null,
      responseTime: null,
      totalChecks: 0,
      totalFailures: 0
    };

    this.services.set(instanceId, instance);
    
    // 启动健康检查
    this._startChecking(instanceId);
    
    this.logger.info(`[HealthChecker] Registered service: ${instanceId}`);
    this.emit('registered', instance);
    
    return instanceId;
  }

  /**
   * 注销服务实例
   * @param {string} instanceId - 实例ID
   */
  deregister(instanceId) {
    const instance = this.services.get(instanceId);
    if (!instance) return;

    // 停止定时检查
    this._stopChecking(instanceId);
    
    // 移除实例
    this.services.delete(instanceId);
    
    this.logger.info(`[HealthChecker] Deregistered service: ${instanceId}`);
    this.emit('deregistered', instance);
  }

  /**
   * 获取服务状态
   * @param {string} instanceId - 实例ID（可选）
   * @returns {Object} 状态信息
   */
  getStatus(instanceId) {
    if (instanceId) {
      return this.services.get(instanceId);
    }
    
    // 返回所有服务状态
    const result = {};
    for (const [id, instance] of this.services) {
      result[id] = {
        id: instance.id,
        name: instance.name,
        status: instance.status,
        lastCheck: instance.lastCheck,
        responseTime: instance.responseTime,
        consecutiveFailures: instance.consecutiveFailures
      };
    }
    return result;
  }

  /**
   * 获取健康的实例列表
   * @param {string} serviceName - 服务名称
   * @returns {Array} 健康实例列表
   */
  getHealthyInstances(serviceName) {
    const healthy = [];
    for (const instance of this.services.values()) {
      if (instance.name === serviceName && instance.status === 'healthy') {
        healthy.push(instance);
      }
    }
    return healthy;
  }

  /**
   * 获取所有服务统计
   * @returns {Object} 统计信息
   */
  getStats() {
    const stats = {
      total: this.services.size,
      healthy: 0,
      unhealthy: 0,
      unknown: 0
    };

    for (const instance of this.services.values()) {
      if (instance.status === 'healthy') stats.healthy++;
      else if (instance.status === 'unhealthy') stats.unhealthy++;
      else stats.unknown++;
    }

    return stats;
  }

  /**
   * 手动触发健康检查
   * @param {string} instanceId - 实例ID
   * @returns {Object} 检查结果
   */
  async checkNow(instanceId) {
    const instance = this.services.get(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    return this._performCheck(instance);
  }

  /**
   * 启动健康检查
   * @private
   */
  _startChecking(instanceId) {
    const instance = this.services.get(instanceId);
    if (!instance) return;

    // 立即执行一次检查
    this._performCheck(instance).catch(err => {
      this.logger.error(`[HealthChecker] Initial check failed for ${instanceId}:`, err.message);
    });

    // 设置定时检查
    const timer = setInterval(async () => {
      try {
        await this._performCheck(instance);
      } catch (err) {
        this.logger.error(`[HealthChecker] Check failed for ${instanceId}:`, err.message);
      }
    }, instance.checkInterval);

    this.timers.set(instanceId, timer);
  }

  /**
   * 停止健康检查
   * @private
   */
  _stopChecking(instanceId) {
    const timer = this.timers.get(instanceId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(instanceId);
    }
  }

  /**
   * 执行健康检查
   * @private
   */
  async _performCheck(instance) {
    const startTime = Date.now();
    instance.totalChecks++;
    
    let isHealthy = false;
    let error = null;
    let responseTime = 0;

    try {
      const result = await this._httpCheck(instance);
      isHealthy = result.healthy;
      responseTime = result.responseTime;
    } catch (err) {
      error = err;
      isHealthy = false;
    }

    responseTime = Date.now() - startTime;
    instance.lastCheck = new Date().toISOString();
    instance.responseTime = responseTime;
    instance.totalFailures += isHealthy ? 0 : 1;

    // 更新连续失败/成功计数
    if (isHealthy) {
      instance.consecutiveFailures = 0;
      instance.consecutiveSuccesses++;
      instance.lastError = null;
    } else {
      instance.consecutiveFailures++;
      instance.consecutiveSuccesses = 0;
      instance.lastError = error?.message || 'Health check failed';
    }

    // 状态转换
    const previousStatus = instance.status;
    
    if (isHealthy && instance.consecutiveSuccesses >= this.successThreshold) {
      instance.status = 'healthy';
    } else if (!isHealthy && instance.consecutiveFailures >= this.failureThreshold) {
      instance.status = 'unhealthy';
    }

    // 触发事件
    if (previousStatus !== instance.status) {
      this.logger.info(
        `[HealthChecker] ${instance.id} status changed: ${previousStatus} -> ${instance.status}`
      );
      this.emit('statusChange', {
        instance,
        previousStatus,
        currentStatus: instance.status,
        error: instance.lastError
      });
    }

    return {
      instanceId: instance.id,
      healthy: isHealthy,
      status: instance.status,
      responseTime,
      error: instance.lastError
    };
  }

  /**
   * HTTP 健康检查
   * @private
   */
  async _httpCheck(instance) {
    return new Promise((resolve, reject) => {
      const client = instance.protocol === 'https' ? https : http;
      
      const options = {
        hostname: instance.host,
        port: instance.port,
        path: instance.healthPath,
        method: 'GET',
        timeout: instance.timeout
      };

      const startTime = Date.now();
      
      const req = client.request(options, (res) => {
        const responseTime = Date.now() - startTime;
        
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          const healthy = res.statusCode >= 200 && res.statusCode < 300;
          resolve({
            healthy,
            responseTime,
            statusCode: res.statusCode,
            body: data.substring(0, 500)  // 限制长度
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Health check timeout after ${instance.timeout}ms`));
      });

      req.end();
    });
  }

  /**
   * 关闭健康检查器
   */
  async shutdown() {
    // 停止所有定时器
    for (const instanceId of this.timers.keys()) {
      this._stopChecking(instanceId);
    }

    this.logger.info('[HealthChecker] Shutdown complete');
    this.emit('shutdown');
  }
}

module.exports = HealthChecker;
