/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * MultiRegionStateCollector - 多区域状态收集器
 * 
 * 功能：
 * - 收集各区域服务健康状态
 * - 通过 Redis Pub/Sub 同步状态到所有区域（延迟 < 500ms）
 * - 维护全局状态快照
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const { EventEmitter } = require('events');
const Redis = require('ioredis');
const axios = require('axios');
const { createLogger } = require('../logger');
const promClient = require('prom-client');

const logger = createLogger('multi-region-state-collector');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  stateSyncLatency: new promClient.Histogram({
    name: 'minego_multi_region_state_sync_latency_ms',
    help: 'Multi-region state sync latency in milliseconds',
    labelNames: ['from_region', 'to_region'],
    buckets: [10, 50, 100, 250, 500, 1000, 2500]
  }),
  
  regionHealth: new promClient.Gauge({
    name: 'minego_region_health_status',
    help: 'Region health status (1=healthy, 0=unhealthy)',
    labelNames: ['region']
  }),
  
  serviceLatency: new promClient.Gauge({
    name: 'minego_region_service_latency_ms',
    help: 'Service latency by region',
    labelNames: ['region', 'service']
  }),
  
  stateUpdatesTotal: new promClient.Counter({
    name: 'minego_multi_region_state_updates_total',
    help: 'Total state updates received',
    labelNames: ['region', 'source']
  }),
  
  syncErrorsTotal: new promClient.Counter({
    name: 'minego_multi_region_sync_errors_total',
    help: 'Total sync errors',
    labelNames: ['region', 'operation']
  })
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  regions: process.env.REGIONS?.split(',') || ['primary', 'secondary', 'backup'],
  currentRegion: process.env.REGION || 'primary',
  syncIntervalMs: parseInt(process.env.STATE_SYNC_INTERVAL_MS || '500'),
  heartbeatTimeoutMs: parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '3000'),
  healthCheckTimeoutMs: parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '5000'),
  staleStateMs: parseInt(process.env.STATE_STALE_MS || '10000'),
  redisChannel: 'minego:multi-region:state-sync',
  stateKeyPrefix: 'minego:multi-region:state:'
};

// ============================================================
// 区域服务端点配置
// ============================================================

const REGION_ENDPOINTS = {
  primary: {
    gateway: process.env.GATEWAY_PRIMARY_URL || 'http://gateway-primary:8080',
    user: process.env.USER_SERVICE_PRIMARY_URL || 'http://user-service-primary:8080',
    pokemon: process.env.POKEMON_SERVICE_PRIMARY_URL || 'http://pokemon-service-primary:8080',
    catch: process.env.CATCH_SERVICE_PRIMARY_URL || 'http://catch-service-primary:8080',
    gym: process.env.GYM_SERVICE_PRIMARY_URL || 'http://gym-service-primary:8080',
    social: process.env.SOCIAL_SERVICE_PRIMARY_URL || 'http://social-service-primary:8080',
    reward: process.env.REWARD_SERVICE_PRIMARY_URL || 'http://reward-service-primary:8080',
    payment: process.env.PAYMENT_SERVICE_PRIMARY_URL || 'http://payment-service-primary:8080',
    location: process.env.LOCATION_SERVICE_PRIMARY_URL || 'http://location-service-primary:8080'
  },
  secondary: {
    gateway: process.env.GATEWAY_SECONDARY_URL || 'http://gateway-secondary:8080',
    user: process.env.USER_SERVICE_SECONDARY_URL || 'http://user-service-secondary:8080',
    pokemon: process.env.POKEMON_SERVICE_SECONDARY_URL || 'http://pokemon-service-secondary:8080',
    catch: process.env.CATCH_SERVICE_SECONDARY_URL || 'http://catch-service-secondary:8080',
    gym: process.env.GYM_SERVICE_SECONDARY_URL || 'http://gym-service-secondary:8080',
    social: process.env.SOCIAL_SERVICE_SECONDARY_URL || 'http://social-service-secondary:8080',
    reward: process.env.REWARD_SERVICE_SECONDARY_URL || 'http://reward-service-secondary:8080',
    payment: process.env.PAYMENT_SERVICE_SECONDARY_URL || 'http://payment-service-secondary:8080',
    location: process.env.LOCATION_SERVICE_SECONDARY_URL || 'http://location-service-secondary:8080'
  },
  backup: {
    gateway: process.env.GATEWAY_BACKUP_URL || 'http://gateway-backup:8080',
    user: process.env.USER_SERVICE_BACKUP_URL || 'http://user-service-backup:8080',
    pokemon: process.env.POKEMON_SERVICE_BACKUP_URL || 'http://pokemon-service-backup:8080',
    catch: process.env.CATCH_SERVICE_BACKUP_URL || 'http://catch-service-backup:8080',
    gym: process.env.GYM_SERVICE_BACKUP_URL || 'http://gym-service-backup:8080',
    social: process.env.SOCIAL_SERVICE_BACKUP_URL || 'http://social-service-backup:8080',
    reward: process.env.REWARD_SERVICE_BACKUP_URL || 'http://reward-service-backup:8080',
    payment: process.env.PAYMENT_SERVICE_BACKUP_URL || 'http://payment-service-backup:8080',
    location: process.env.LOCATION_SERVICE_BACKUP_URL || 'http://location-service-backup:8080'
  }
};

const SERVICES = ['gateway', 'user', 'pokemon', 'catch', 'gym', 'social', 'reward', 'payment', 'location'];

// ============================================================
// MultiRegionStateCollector 类
// ============================================================

class MultiRegionStateCollector extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Redis 连接
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.redisSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    
    // 状态快照
    this.stateSnapshot = {
      timestamp: new Date().toISOString(),
      regions: {},
      arbitrationLocked: false,
      activeRegion: this.config.currentRegion,
      version: 0
    };
    
    // 初始化各区域状态
    for (const region of this.config.regions) {
      this.stateSnapshot.regions[region] = {
        healthy: false,
        services: {},
        latency: 0,
        lastUpdate: null
      };
    }
    
    // 收集定时器
    this.collectTimer = null;
    this.syncTimer = null;
    
    // 运行状态
    this.running = false;
    
    // 监听器绑定
    this.handleStateSync = this.handleStateSync.bind(this);
  }

  /**
   * 初始化收集器
   */
  async initialize() {
    try {
      // 订阅状态同步频道
      await this.redisSub.subscribe(this.config.redisChannel);
      this.redisSub.on('message', this.handleStateSync);
      
      // 启动本地状态收集
      this.startLocalCollection();
      
      // 启动状态同步
      this.startStateSync();
      
      this.running = true;
      
      logger.info('MultiRegionStateCollector initialized', {
        regions: this.config.regions,
        currentRegion: this.config.currentRegion
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize MultiRegionStateCollector', { error: error.message });
      throw error;
    }
  }

  /**
   * 启动本地状态收集
   */
  startLocalCollection() {
    // 立即执行一次
    this.collectLocalRegionHealth();
    
    // 定时收集
    this.collectTimer = setInterval(() => {
      this.collectLocalRegionHealth().catch(err => {
        logger.error('Local collection failed', { error: err.message });
      });
    }, this.config.syncIntervalMs);
  }

  /**
   * 收集本地区域健康状态
   */
  async collectLocalRegionHealth() {
    const region = this.config.currentRegion;
    const startTime = Date.now();
    
    try {
      const services = {};
      let allHealthy = true;
      
      // 并发检查所有服务
      const serviceChecks = SERVICES.map(async (service) => {
        const endpoint = REGION_ENDPOINTS[region]?.[service];
        if (!endpoint) {
          return { service, healthy: false, latency: 0, error: 'No endpoint configured' };
        }
        
        const checkStart = Date.now();
        try {
          const response = await axios.get(`${endpoint}/health`, {
            timeout: this.config.healthCheckTimeoutMs
          });
          
          const latency = Date.now() - checkStart;
          const healthy = response.data?.status === 'healthy' || response.data?.status === 'ok';
          
          // 记录服务延迟
          metrics.serviceLatency.set({ region, service }, latency);
          
          return { service, healthy, latency, details: response.data };
        } catch (error) {
          metrics.syncErrorsTotal.inc({ region, operation: 'health_check' });
          return { service, healthy: false, latency: 0, error: error.message };
        }
      });
      
      const results = await Promise.all(serviceChecks);
      
      for (const result of results) {
        services[result.service] = {
          healthy: result.healthy,
          latency: result.latency,
          error: result.error || null,
          details: result.details || null
        };
        
        if (!result.healthy) {
          allHealthy = false;
        }
      }
      
      const totalLatency = Date.now() - startTime;
      
      // 更新本地状态
      this.stateSnapshot.regions[region] = {
        healthy: allHealthy,
        services,
        latency: totalLatency,
        lastUpdate: new Date().toISOString()
      };
      
      this.stateSnapshot.timestamp = new Date().toISOString();
      this.stateSnapshot.version++;
      
      // 更新指标
      metrics.regionHealth.set({ region }, allHealthy ? 1 : 0);
      metrics.stateUpdatesTotal.inc({ region, source: 'local' });
      
      // 广播状态到其他区域
      await this.broadcastState();
      
      logger.debug('Local region health collected', {
        region,
        healthy: allHealthy,
        latency: totalLatency,
        servicesChecked: SERVICES.length
      });
      
      // 触发事件
      this.emit('state-updated', {
        region,
        healthy: allHealthy,
        services
      });
      
      return this.stateSnapshot.regions[region];
    } catch (error) {
      logger.error('Failed to collect local region health', { error: error.message });
      metrics.syncErrorsTotal.inc({ region, operation: 'collect' });
      throw error;
    }
  }

  /**
   * 启动状态同步
   */
  startStateSync() {
    // 从 Redis 恢复其他区域状态
    this.restoreStateFromRedis().catch(err => {
      logger.warn('Failed to restore state from Redis', { error: err.message });
    });
    
    // 定时同步（冗余保障）
    this.syncTimer = setInterval(() => {
      this.restoreStateFromRedis().catch(err => {
        logger.warn('Sync timer failed', { error: err.message });
      });
    }, this.config.syncIntervalMs * 2);
  }

  /**
   * 从 Redis 恢复状态
   */
  async restoreStateFromRedis() {
    const startTime = Date.now();
    
    for (const region of this.config.regions) {
      if (region === this.config.currentRegion) continue;
      
      try {
        const stateKey = `${this.config.stateKeyPrefix}${region}`;
        const stateJson = await this.redis.get(stateKey);
        
        if (stateJson) {
          const state = JSON.parse(stateJson);
          const stateAge = Date.now() - new Date(state.lastUpdate).getTime();
          
          // 检查状态是否过期
          if (stateAge < this.config.staleStateMs) {
            this.stateSnapshot.regions[region] = state;
            metrics.stateUpdatesTotal.inc({ region, source: 'redis' });
          } else {
            logger.warn('Stale state detected', { region, stateAge });
            this.stateSnapshot.regions[region] = {
              ...state,
              healthy: false,
              stale: true
            };
          }
        }
      } catch (error) {
        logger.error('Failed to restore state from Redis', { region, error: error.message });
        metrics.syncErrorsTotal.inc({ region, operation: 'restore' });
      }
    }
    
    const syncLatency = Date.now() - startTime;
    metrics.stateSyncLatency.observe({ from_region: 'redis', to_region: this.config.currentRegion }, syncLatency);
  }

  /**
   * 广播本地状态到其他区域
   */
  async broadcastState() {
    const region = this.config.currentRegion;
    const state = this.stateSnapshot.regions[region];
    
    try {
      // 存储到 Redis
      const stateKey = `${this.config.stateKeyPrefix}${region}`;
      await this.redis.set(stateKey, JSON.stringify(state), 'EX', 30);
      
      // 发布到频道
      await this.redis.publish(this.config.redisChannel, JSON.stringify({
        region,
        state,
        timestamp: new Date().toISOString()
      }));
      
      logger.debug('State broadcasted', { region });
    } catch (error) {
      logger.error('Failed to broadcast state', { error: error.message });
      metrics.syncErrorsTotal.inc({ region, operation: 'broadcast' });
    }
  }

  /**
   * 处理来自其他区域的状态同步消息
   */
  handleStateSync(channel, message) {
    if (channel !== this.config.redisChannel) return;
    
    try {
      const { region, state, timestamp } = JSON.parse(message);
      
      if (region === this.config.currentRegion) return;
      
      const syncLatency = Date.now() - new Date(timestamp).getTime();
      metrics.stateSyncLatency.observe({ from_region: region, to_region: this.config.currentRegion }, syncLatency);
      
      // 更新状态快照
      this.stateSnapshot.regions[region] = state;
      this.stateSnapshot.timestamp = new Date().toISOString();
      this.stateSnapshot.version++;
      
      // 更新指标
      metrics.regionHealth.set({ region }, state.healthy ? 1 : 0);
      metrics.stateUpdatesTotal.inc({ region, source: 'pubsub' });
      
      logger.debug('State synced from remote', { region, latency: syncLatency });
      
      this.emit('remote-state-updated', { region, state });
    } catch (error) {
      logger.error('Failed to handle state sync', { error: error.message });
    }
  }

  /**
   * 收集指定区域健康状态（按需）
   */
  async collectRegionHealth(region) {
    if (region === this.config.currentRegion) {
      return this.collectLocalRegionHealth();
    }
    
    const startTime = Date.now();
    
    try {
      const services = {};
      let allHealthy = true;
      
      for (const service of SERVICES) {
        const endpoint = REGION_ENDPOINTS[region]?.[service];
        if (!endpoint) {
          services[service] = { healthy: false, latency: 0, error: 'No endpoint configured' };
          allHealthy = false;
          continue;
        }
        
        const checkStart = Date.now();
        try {
          const response = await axios.get(`${endpoint}/health`, {
            timeout: this.config.healthCheckTimeoutMs
          });
          
          const latency = Date.now() - checkStart;
          const healthy = response.data?.status === 'healthy' || response.data?.status === 'ok';
          
          services[service] = { healthy, latency, details: response.data };
        } catch (error) {
          services[service] = { healthy: false, latency: 0, error: error.message };
          allHealthy = false;
        }
      }
      
      const totalLatency = Date.now() - startTime;
      
      this.stateSnapshot.regions[region] = {
        healthy: allHealthy,
        services,
        latency: totalLatency,
        lastUpdate: new Date().toISOString()
      };
      
      this.stateSnapshot.timestamp = new Date().toISOString();
      this.stateSnapshot.version++;
      
      metrics.regionHealth.set({ region }, allHealthy ? 1 : 0);
      
      return this.stateSnapshot.regions[region];
    } catch (error) {
      logger.error('Failed to collect region health', { region, error: error.message });
      throw error;
    }
  }

  /**
   * 获取全局状态快照
   */
  getStateSnapshot() {
    return {
      ...this.stateSnapshot,
      currentRegion: this.config.currentRegion,
      regions: { ...this.stateSnapshot.regions }
    };
  }

  /**
   * 设置仲裁锁定状态
   */
  setArbitrationLocked(locked) {
    this.stateSnapshot.arbitrationLocked = locked;
  }

  /**
   * 设置活跃区域
   */
  setActiveRegion(region) {
    if (this.config.regions.includes(region)) {
      this.stateSnapshot.activeRegion = region;
      this.stateSnapshot.version++;
    }
  }

  /**
   * 获取健康区域列表
   */
  getHealthyRegions() {
    return this.config.regions.filter(region => 
      this.stateSnapshot.regions[region]?.healthy === true
    );
  }

  /**
   * 获取不健康区域列表
   */
  getUnhealthyRegions() {
    return this.config.regions.filter(region => 
      this.stateSnapshot.regions[region]?.healthy !== true
    );
  }

  /**
   * 检查状态是否新鲜
   */
  isStateFresh() {
    const now = Date.now();
    for (const region of this.config.regions) {
      const state = this.stateSnapshot.regions[region];
      if (!state?.lastUpdate) return false;
      
      const age = now - new Date(state.lastUpdate).getTime();
      if (age > this.config.staleStateMs) return false;
    }
    return true;
  }

  /**
   * 停止收集器
   */
  async stop() {
    this.running = false;
    
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }
    
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    
    try {
      await this.redisSub.unsubscribe(this.config.redisChannel);
      await this.redisSub.quit();
      await this.redis.quit();
    } catch (error) {
      logger.warn('Error during shutdown', { error: error.message });
    }
    
    logger.info('MultiRegionStateCollector stopped');
  }

  /**
   * 获取收集器状态
   */
  getStatus() {
    return {
      running: this.running,
      currentRegion: this.config.currentRegion,
      regions: this.config.regions,
      stateFresh: this.isStateFresh(),
      version: this.stateSnapshot.version,
      arbitrationLocked: this.stateSnapshot.arbitrationLocked,
      activeRegion: this.stateSnapshot.activeRegion
    };
  }
}

module.exports = MultiRegionStateCollector;
