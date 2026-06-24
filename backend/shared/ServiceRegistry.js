'use strict';
/**
 * 服务注册中心
 * REQ-00300: 动态服务注册发现与健康感知路由系统
 * 
 * 基于 Redis 的轻量级服务注册中心
 */

const logger = require('./logger');
const { getRedis } = require('./redis');

/**
 * 服务注册中心配置
 */
const DEFAULT_CONFIG = {
  heartbeatInterval: 10000, // 心跳间隔 10秒
  ttl: 30000, // 实例过期时间 30秒
  unhealthyThreshold: 30000, // 标记 unhealthy 阈值 30秒
  removalThreshold: 60000, // 自动移除阈值 60秒
  healthCheckInterval: 15000, // 健康检查间隔 15秒
  redisKeyPrefix: 'service:registry:'
};

/**
 * 服务实例信息
 */
class ServiceInstance {
  constructor(data) {
    this.instanceId = data.instanceId;
    this.serviceName = data.serviceName;
    this.host = data.host;
    this.port = data.port;
    this.version = data.version || '1.0.0';
    this.metadata = data.metadata || {};
    this.healthStatus = data.healthStatus || 'healthy';
    this.healthScore = data.healthScore || 100;
    this.lastHeartbeat = data.lastHeartbeat || Date.now();
    this.registeredAt = data.registeredAt || Date.now();
    this.connections = data.connections || 0;
  }

  toJSON() {
    return {
      instanceId: this.instanceId,
      serviceName: this.serviceName,
      host: this.host,
      port: this.port,
      version: this.version,
      metadata: this.metadata,
      healthStatus: this.healthStatus,
      healthScore: this.healthScore,
      lastHeartbeat: this.lastHeartbeat,
      registeredAt: this.registeredAt,
      connections: this.connections
    };
  }

  static fromJSON(json) {
    if (typeof json === 'string') {
      json = JSON.parse(json);
    }
    return new ServiceInstance(json);
  }
}

/**
 * 服务注册中心
 */
class ServiceRegistry {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redisClient = config.redisClient || getRedis();
    this.instanceId = null;
    this.serviceName = null;
    this.heartbeatTimer = null;
    this.healthCheckTimer = null;
    this.isRegistered = false;
  }

  /**
   * 生成实例 ID
   */
  generateInstanceId(serviceName) {
    const hostname = require('os').hostname();
    const pid = process.pid;
    const timestamp = Date.now();
    return `${serviceName}-${hostname}-${pid}-${timestamp}`;
  }

  /**
   * 获取本机 IP
   */
  getHost() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    
    // 优先返回非内部 IPv4 地址
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    
    return '127.0.0.1';
  }

  /**
   * 服务注册
   */
  async register(options) {
    const {
      serviceName,
      port,
      version = process.env.SERVICE_VERSION || '1.0.0',
      metadata = {}
    } = options;

    if (!serviceName || !port) {
      throw new Error('serviceName and port are required');
    }

    this.serviceName = serviceName;
    this.instanceId = this.generateInstanceId(serviceName);

    const instance = new ServiceInstance({
      instanceId: this.instanceId,
      serviceName,
      host: this.getHost(),
      port,
      version,
      metadata: {
        weight: metadata.weight || 100,
        zone: metadata.zone || process.env.ZONE || 'default',
        tags: metadata.tags || [],
        ...metadata
      },
      healthStatus: 'healthy',
      healthScore: 100,
      lastHeartbeat: Date.now(),
      registeredAt: Date.now()
    });

    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${this.instanceId}`;
    const serviceKey = `${key}services:${serviceName}`;
    const healthKey = `${key}health:${serviceName}`;

    // 使用 MULTI 确保原子性
    await this.redisClient.multi()
      .sadd(serviceKey, this.instanceId)
      .hset(instanceKey, 'data', JSON.stringify(instance.toJSON()))
      .hset(instanceKey, 'lastHeartbeat', instance.lastHeartbeat)
      .expire(instanceKey, this.config.ttl)
      .zadd(healthKey, instance.lastHeartbeat, this.instanceId)
      .exec();

    this.isRegistered = true;

    // 启动心跳
    this.startHeartbeat();

    // 启动健康检查（如果启用）
    if (this.config.enableHealthCheck) {
      this.startHealthCheck();
    }

    logger.info(`Service registered`, {
      serviceName,
      instanceId: this.instanceId,
      host: instance.host,
      port: instance.port,
      version: instance.version
    });

    return instance;
  }

  /**
   * 启动心跳
   */
  startHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.heartbeat();
      } catch (err) {
        logger.error('Heartbeat failed', {
          instanceId: this.instanceId,
          error: err.message
        });
      }
    }, this.config.heartbeatInterval);

    // 确保进程退出时清理
    this.heartbeatTimer.unref();
  }

  /**
   * 发送心跳
   */
  async heartbeat() {
    if (!this.isRegistered || !this.instanceId) {
      return;
    }

    const now = Date.now();
    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${this.instanceId}`;
    const healthKey = `${key}health:${this.serviceName}`;

    await this.redisClient.multi()
      .hset(instanceKey, 'lastHeartbeat', now)
      .expire(instanceKey, this.config.ttl)
      .zadd(healthKey, now, this.instanceId)
      .exec();
  }

  /**
   * 服务注销
   */
  async deregister() {
    if (!this.isRegistered || !this.instanceId) {
      return;
    }

    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${this.instanceId}`;
    const serviceKey = `${key}services:${this.serviceName}`;
    const healthKey = `${key}health:${this.serviceName}`;

    await this.redisClient.multi()
      .srem(serviceKey, this.instanceId)
      .del(instanceKey)
      .zrem(healthKey, this.instanceId)
      .exec();

    // 停止心跳
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // 停止健康检查
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.isRegistered = false;

    logger.info(`Service deregistered`, {
      serviceName: this.serviceName,
      instanceId: this.instanceId
    });
  }

  /**
   * 发现服务实例
   */
  async discover(serviceName, filters = {}) {
    const key = this.config.redisKeyPrefix;
    const serviceKey = `${key}services:${serviceName}`;
    
    // 获取所有实例 ID
    const instanceIds = await this.redisClient.smembers(serviceKey);
    
    if (!instanceIds || instanceIds.length === 0) {
      return [];
    }

    // 批量获取实例详情
    const instances = [];
    const now = Date.now();

    for (const instanceId of instanceIds) {
      const instanceKey = `${key}instance:${instanceId}`;
      const data = await this.redisClient.hget(instanceKey, 'data');
      
      if (!data) {
        continue;
      }

      const instance = ServiceInstance.fromJSON(data);
      const lastHeartbeat = parseInt(await this.redisClient.hget(instanceKey, 'lastHeartbeat') || 0);
      
      // 检查心跳超时
      const timeSinceLastHeartbeat = now - lastHeartbeat;
      
      if (timeSinceLastHeartbeat > this.config.removalThreshold) {
        // 超过移除阈值，清理实例
        await this.removeInstance(instanceId);
        continue;
      }

      if (timeSinceLastHeartbeat > this.config.unhealthyThreshold) {
        instance.healthStatus = 'unhealthy';
      }

      // 应用过滤器
      if (filters.healthStatus && instance.healthStatus !== filters.healthStatus) {
        continue;
      }

      if (filters.minHealthScore && instance.healthScore < filters.minHealthScore) {
        continue;
      }

      if (filters.version && instance.version !== filters.version) {
        continue;
      }

      if (filters.zone && instance.metadata.zone !== filters.zone) {
        continue;
      }

      instances.push(instance);
    }

    return instances;
  }

  /**
   * 获取单个实例
   */
  async getInstance(instanceId) {
    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${instanceId}`;
    
    const data = await this.redisClient.hget(instanceKey, 'data');
    if (!data) {
      return null;
    }

    return ServiceInstance.fromJSON(data);
  }

  /**
   * 更新实例健康状态
   */
  async updateHealth(instanceId, healthScore, healthStatus) {
    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${instanceId}`;

    const data = await this.redisClient.hget(instanceKey, 'data');
    if (!data) {
      return false;
    }

    const instance = ServiceInstance.fromJSON(data);
    instance.healthScore = healthScore;
    instance.healthStatus = healthStatus || (healthScore >= 50 ? 'healthy' : 'unhealthy');

    await this.redisClient.hset(instanceKey, 'data', JSON.stringify(instance.toJSON()));

    logger.debug(`Instance health updated`, {
      instanceId,
      healthScore,
      healthStatus: instance.healthStatus
    });

    return true;
  }

  /**
   * 更新实例连接数
   */
  async updateConnections(instanceId, connections) {
    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${instanceId}`;

    const data = await this.redisClient.hget(instanceKey, 'data');
    if (!data) {
      return false;
    }

    const instance = ServiceInstance.fromJSON(data);
    instance.connections = connections;

    await this.redisClient.hset(instanceKey, 'data', JSON.stringify(instance.toJSON()));

    return true;
  }

  /**
   * 移除实例
   */
  async removeInstance(instanceId) {
    const key = this.config.redisKeyPrefix;
    const instanceKey = `${key}instance:${instanceId}`;

    const data = await this.redisClient.hget(instanceKey, 'data');
    if (!data) {
      return false;
    }

    const instance = ServiceInstance.fromJSON(data);
    const serviceKey = `${key}services:${instance.serviceName}`;
    const healthKey = `${key}health:${instance.serviceName}`;

    await this.redisClient.multi()
      .srem(serviceKey, instanceId)
      .del(instanceKey)
      .zrem(healthKey, instanceId)
      .exec();

    logger.info(`Instance removed`, { instanceId, serviceName: instance.serviceName });

    return true;
  }

  /**
   * 获取所有服务名称
   */
  async getAllServices() {
    const key = this.config.redisKeyPrefix;
    const pattern = `${key}services:*`;
    
    const keys = await this.redisClient.keys(pattern);
    return keys.map(k => k.replace(`${key}services:`, ''));
  }

  /**
   * 启动健康检查
   */
  startHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.checkAllInstances();
      } catch (err) {
        logger.error('Health check failed', { error: err.message });
      }
    }, this.config.healthCheckInterval);

    this.healthCheckTimer.unref();
  }

  /**
   * 检查所有实例健康
   */
  async checkAllInstances() {
    const services = await this.getAllServices();
    
    for (const serviceName of services) {
      const instances = await this.discover(serviceName);
      
      for (const instance of instances) {
        await this.checkInstanceHealth(instance);
      }
    }
  }

  /**
   * 检查单个实例健康
   */
  async checkInstanceHealth(instance) {
    const http = require('http');
    
    return new Promise((resolve) => {
      const startTime = Date.now();
      const options = {
        hostname: instance.host,
        port: instance.port,
        path: '/health',
        method: 'GET',
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', async () => {
          const responseTime = Date.now() - startTime;
          let healthScore = 100;

          // 计算健康评分
          if (res.statusCode !== 200) {
            healthScore -= 50;
          }

          if (responseTime > 1000) {
            healthScore -= 20;
          } else if (responseTime > 500) {
            healthScore -= 10;
          }

          try {
            const healthData = JSON.parse(data);
            if (healthData.status !== 'ok') {
              healthScore -= 30;
            }
          } catch (e) {
            healthScore -= 10;
          }

          await this.updateHealth(
            instance.instanceId,
            Math.max(0, healthScore),
            healthScore >= 50 ? 'healthy' : 'unhealthy'
          );

          resolve();
        });
      });

      req.on('error', async (err) => {
        logger.warn(`Instance health check failed`, {
          instanceId: instance.instanceId,
          error: err.message
        });

        await this.updateHealth(instance.instanceId, 0, 'unhealthy');
        resolve();
      });

      req.on('timeout', async () => {
        req.destroy();
        await this.updateHealth(instance.instanceId, 0, 'unhealthy');
        resolve();
      });

      req.end();
    });
  }
}

// 单例实例
let registryInstance = null;

/**
 * 获取注册中心实例
 */
function getRegistry(config = {}) {
  if (!registryInstance) {
    registryInstance = new ServiceRegistry(config);
  }
  return registryInstance;
}

module.exports = {
  ServiceRegistry,
  ServiceInstance,
  getRegistry,
  DEFAULT_CONFIG
};
