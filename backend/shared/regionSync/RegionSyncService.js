/**
 * 多区域服务状态同步系统
 * @module backend/shared/regionSync/RegionSyncService
 * 
 * 功能：
 * - 多区域服务状态实时同步
 * - 状态变更广播与确认
 * - 冲突检测与解决
 * - 同步状态追踪与监控
 */

'use strict';

const { createLogger } = require('../logger');
const { getRedis } = require('../redis');
const { query, transaction } = require('../db');
const metrics = require('../metrics');

const logger = createLogger('region-sync-service');

// 区域配置
const REGIONS = {
  'cn-east': { name: '华东', priority: 1, endpoint: process.env.REGION_CN_EAST },
  'cn-north': { name: '华北', priority: 2, endpoint: process.env.REGION_CN_NORTH },
  'cn-south': { name: '华南', priority: 3, endpoint: process.env.REGION_CN_SOUTH },
  'ap-southeast': { name: '东南亚', priority: 4, endpoint: process.env.REGION_AP_SOUTHEAST }
};

// 服务状态定义
const SERVICE_STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
};

// 同步状态
const SYNC_STATUS = {
  SYNCED: 'synced',
  SYNCING: 'syncing',
  CONFLICT: 'conflict',
  FAILED: 'failed'
};

/**
 * 区域同步服务
 */
class RegionSyncService {
  constructor(options = {}) {
    this.currentRegion = options.currentRegion || process.env.REGION_ID || 'cn-east';
    this.syncInterval = options.syncInterval || 5000; // 5秒同步间隔
    this.timeout = options.timeout || 10000; // 10秒超时
    this.retryAttempts = options.retryAttempts || 3;
    
    this.redis = null;
    this.syncTimer = null;
    this.isRunning = false;
    
    // 状态缓存
    this.regionStates = new Map();
    this.syncQueue = [];
    
    this.metrics = this._initMetrics();
  }

  /**
   * 初始化指标
   */
  _initMetrics() {
    return {
      syncTotal: metrics.counter('region_sync_total', 'Region sync total count', ['region', 'status']),
      syncDuration: metrics.histogram('region_sync_duration_ms', 'Region sync duration', ['region'], [100, 500, 1000, 2000, 5000]),
      conflictCount: metrics.counter('region_conflict_total', 'Region conflict count', ['type']),
      syncQueueSize: metrics.gauge('region_sync_queue_size', 'Sync queue size')
    };
  }

  /**
   * 启动同步服务
   */
  async start() {
    this.redis = getRedis();
    
    logger.info({ currentRegion: this.currentRegion }, 'Starting region sync service');
    
    // 加载初始状态
    await this._loadInitialState();
    
    // 启动同步定时器
    this.syncTimer = setInterval(() => this._sync(), this.syncInterval);
    
    // 订阅状态变更事件
    await this._subscribeToChanges();
    
    this.isRunning = true;
    
    logger.info('Region sync service started successfully');
  }

  /**
   * 停止同步服务
   */
  async stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    
    this.isRunning = false;
    
    logger.info('Region sync service stopped');
  }

  /**
   * 加载初始状态
   */
  async _loadInitialState() {
    try {
      // 从 Redis 加载各区域状态
      const regionKeys = Object.keys(REGIONS).map(r => `region:status:${r}`);
      const states = await this.redis.mget(regionKeys);
      
      for (let i = 0; i < states.length; i++) {
        const regionId = Object.keys(REGIONS)[i];
        if (states[i]) {
          const state = JSON.parse(states[i]);
          this.regionStates.set(regionId, state);
        }
      }
      
      logger.info({ loadedRegions: this.regionStates.size }, 'Initial state loaded');
    } catch (error) {
      logger.error({ error }, 'Failed to load initial state');
      throw error;
    }
  }

  /**
   * 订阅状态变更
   */
  async _subscribeToChanges() {
    try {
      // 订阅 Redis Pub/Sub 频道
      await this.redis.subscribe('region:status:changes');
      
      this.redis.on('message', (channel, message) => {
        if (channel === 'region:status:changes') {
          this._handleStatusChange(JSON.parse(message));
        }
      });
      
      logger.info('Subscribed to region status changes');
    } catch (error) {
      logger.error({ error }, 'Failed to subscribe to changes');
    }
  }

  /**
   * 同步状态到其他区域
   */
  async _sync() {
    if (this.syncQueue.length === 0) {
      return;
    }
    
    const startTime = Date.now();
    const batch = this.syncQueue.splice(0, 10); // 批量处理
    
    try {
      // 获取当前区域状态
      const currentState = await this._collectCurrentState();
      
      // 广播到其他区域
      const results = await Promise.allSettled(
        Object.keys(REGIONS)
          .filter(r => r !== this.currentRegion)
          .map(region => this._syncToRegion(region, currentState))
      );
      
      // 处理结果
      let successCount = 0;
      let conflictCount = 0;
      
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.conflict) {
            conflictCount++;
            this.metrics.conflictCount.inc({ type: result.value.conflictType });
          } else {
            successCount++;
          }
        }
      }
      
      this.metrics.syncTotal.inc({ region: this.currentRegion, status: 'success' }, successCount);
      this.metrics.syncTotal.inc({ region: this.currentRegion, status: 'failed' }, results.length - successCount);
      
      const duration = Date.now() - startTime;
      this.metrics.syncDuration.observe({ region: this.currentRegion }, duration);
      
      // 更新同步状态
      await this._updateSyncStatus(successCount, conflictCount);
      
      logger.debug({
        batch: batch.length,
        success: successCount,
        conflicts: conflictCount,
        duration
      }, 'Sync batch completed');
      
    } catch (error) {
      logger.error({ error }, 'Sync failed');
      this.metrics.syncTotal.inc({ region: this.currentRegion, status: 'error' });
    }
    
    this.metrics.syncQueueSize.set(this.syncQueue.length);
  }

  /**
   * 收集当前区域状态
   */
  async _collectCurrentState() {
    const state = {
      regionId: this.currentRegion,
      timestamp: Date.now(),
      services: {},
      metrics: {}
    };
    
    try {
      // 收集各服务状态
      const { rows: services } = await query(`
        SELECT service_name, status, health_score, last_check_at, metadata
        FROM service_health
        WHERE region_id = $1
        ORDER BY service_name
      `, [this.currentRegion]);
      
      for (const service of services) {
        state.services[service.service_name] = {
          status: service.status,
          healthScore: service.health_score,
          lastCheck: service.last_check_at,
          metadata: service.metadata || {}
        };
      }
      
      // 收集关键指标
      const { rows: metrics } = await query(`
        SELECT metric_name, metric_value, unit
        FROM region_metrics
        WHERE region_id = $1
        AND collected_at > NOW() - INTERVAL '5 minutes'
        ORDER BY metric_name
      `, [this.currentRegion]);
      
      for (const metric of metrics) {
        state.metrics[metric.metric_name] = {
          value: metric.metric_value,
          unit: metric.unit
        };
      }
      
      // 计算 region hash 用于冲突检测
      state.hash = this._calculateHash(state);
      
    } catch (error) {
      logger.error({ error }, 'Failed to collect current state');
      throw error;
    }
    
    return state;
  }

  /**
   * 同步到指定区域
   */
  async _syncToRegion(targetRegion, state) {
    const targetConfig = REGIONS[targetRegion];
    if (!targetConfig || !targetConfig.endpoint) {
      return { success: false, reason: 'endpoint_not_configured' };
    }
    
    try {
      const response = await this._sendSyncRequest(targetConfig.endpoint, state);
      
      if (response.conflict) {
        return {
          success: false,
          conflict: true,
          conflictType: response.conflictType,
          theirState: response.theirState
        };
      }
      
      // 更新本地缓存的远端状态
      this.regionStates.set(targetRegion, response.theirState);
      
      return { success: true };
      
    } catch (error) {
      logger.error({ targetRegion, error: error.message }, 'Sync to region failed');
      return { success: false, reason: error.message };
    }
  }

  /**
   * 发送同步请求
   */
  async _sendSyncRequest(endpoint, state) {
    const axios = require('axios');
    
    const response = await axios.post(`${endpoint}/api/internal/region/sync`, {
      sourceRegion: this.currentRegion,
      state: state,
      timestamp: Date.now()
    }, {
      timeout: this.timeout,
      headers: {
        'X-Region-Auth': process.env.REGION_AUTH_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data;
  }

  /**
   * 处理状态变更事件
   */
  async _handleStatusChange(message) {
    const { regionId, changeType, data } = message;
    
    logger.debug({ regionId, changeType }, 'Received status change');
    
    switch (changeType) {
      case 'service_status':
        await this._handleServiceStatusChange(regionId, data);
        break;
      case 'region_health':
        await this._handleRegionHealthChange(regionId, data);
        break;
      case 'conflict_detected':
        await this._handleConflictDetected(regionId, data);
        break;
      default:
        logger.warn({ changeType }, 'Unknown change type');
    }
  }

  /**
   * 处理服务状态变更
   */
  async _handleServiceStatusChange(regionId, data) {
    const { serviceName, status, healthScore } = data;
    
    // 更新缓存
    const regionState = this.regionStates.get(regionId) || { services: {} };
    regionState.services[serviceName] = { status, healthScore };
    this.regionStates.set(regionId, regionState);
    
    // 触发同步队列
    this.syncQueue.push({
      type: 'service_status',
      regionId,
      serviceName,
      data
    });
    
    // 记录到数据库
    await query(`
      INSERT INTO region_service_events (region_id, service_name, event_type, event_data, created_at)
      VALUES ($1, $2, 'status_change', $3, NOW())
    `, [regionId, serviceName, JSON.stringify(data)]);
  }

  /**
   * 处理区域健康变更
   */
  async _handleRegionHealthChange(regionId, data) {
    logger.info({ regionId, health: data.health }, 'Region health changed');
    
    // 更新区域状态
    const regionState = this.regionStates.get(regionId) || {};
    regionState.health = data.health;
    regionState.lastUpdate = Date.now();
    this.regionStates.set(regionId, regionState);
    
    // 如果当前区域不健康，触发仲裁
    if (regionId === this.currentRegion && data.health !== 'healthy') {
      await this._triggerArbitration('region_health_degraded');
    }
  }

  /**
   * 处理冲突检测事件
   */
  async _handleConflictDetected(regionId, data) {
    logger.warn({ regionId, conflict: data }, 'Conflict detected');
    
    this.metrics.conflictCount.inc({ type: data.conflictType });
    
    // 触发仲裁
    await this._triggerArbitration(data.conflictType, data);
  }

  /**
   * 触发仲裁流程
   */
  async _triggerArbitration(reason, data = {}) {
    const ArbitrationEngine = require('./ArbitrationEngine');
    const engine = new ArbitrationEngine();
    
    try {
      const result = await engine.arbitrate({
        currentRegion: this.currentRegion,
        reason,
        regionStates: Object.fromEntries(this.regionStates),
        conflictData: data
      });
      
      logger.info({ result }, 'Arbitration completed');
      
      // 应用仲裁结果
      await this._applyArbitrationResult(result);
      
    } catch (error) {
      logger.error({ error, reason }, 'Arbitration failed');
    }
  }

  /**
   * 应用仲裁结果
   */
  async _applyArbitrationResult(result) {
    switch (result.action) {
      case 'switch_region':
        await this._handleRegionSwitch(result.targetRegion, result.reason);
        break;
      case 'sync_state':
        await this._forceSyncState(result.sourceRegion);
        break;
      case 'alert':
        await this._sendAlert(result.message);
        break;
      default:
        logger.warn({ action: result.action }, 'Unknown arbitration action');
    }
  }

  /**
   * 处理区域切换
   */
  async _handleRegionSwitch(targetRegion, reason) {
    logger.warn({ targetRegion, reason }, 'Executing region switch');
    
    // 记录切换事件
    await query(`
      INSERT INTO region_switch_events (from_region, to_region, reason, executed_at, status)
      VALUES ($1, $2, $3, NOW(), 'completed')
    `, [this.currentRegion, targetRegion, reason]);
    
    // 更新 Redis 中的活跃区域标记
    await this.redis.set('region:active', targetRegion);
    
    // 广播切换事件
    await this.redis.publish('region:switch', JSON.stringify({
      from: this.currentRegion,
      to: targetRegion,
      reason,
      timestamp: Date.now()
    }));
    
    // 发送告警
    await this._sendAlert(`Region switched from ${this.currentRegion} to ${targetRegion}: ${reason}`);
  }

  /**
   * 强制同步状态
   */
  async _forceSyncState(sourceRegion) {
    logger.info({ sourceRegion }, 'Forcing state sync from source region');
    
    const sourceConfig = REGIONS[sourceRegion];
    if (!sourceConfig || !sourceConfig.endpoint) {
      throw new Error('Source region endpoint not configured');
    }
    
    try {
      const axios = require('axios');
      const response = await axios.get(`${sourceConfig.endpoint}/api/internal/region/state`, {
        headers: { 'X-Region-Auth': process.env.REGION_AUTH_TOKEN }
      });
      
      const sourceState = response.data;
      
      // 应用源状态到本地
      await this._applyState(sourceState);
      
      logger.info({ sourceRegion }, 'State sync completed');
      
    } catch (error) {
      logger.error({ error, sourceRegion }, 'Failed to sync state from source region');
      throw error;
    }
  }

  /**
   * 应用状态到本地
   */
  async _applyState(state) {
    await transaction(async (client) => {
      // 更新服务状态
      for (const [serviceName, serviceState] of Object.entries(state.services || {})) {
        await client.query(`
          INSERT INTO service_health (region_id, service_name, status, health_score, metadata, last_check_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (region_id, service_name) DO UPDATE SET
            status = EXCLUDED.status,
            health_score = EXCLUDED.health_score,
            metadata = EXCLUDED.metadata,
            last_check_at = EXCLUDED.last_check_at
        `, [this.currentRegion, serviceName, serviceState.status, serviceState.healthScore, JSON.stringify(serviceState.metadata)]);
      }
      
      // 更新区域指标
      for (const [metricName, metric] of Object.entries(state.metrics || {})) {
        await client.query(`
          INSERT INTO region_metrics (region_id, metric_name, metric_value, unit, collected_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [this.currentRegion, metricName, metric.value, metric.unit]);
      }
    });
  }

  /**
   * 发送告警
   */
  async _sendAlert(message) {
    // 发送到监控系统
    try {
      await query(`
        INSERT INTO region_alerts (region_id, alert_type, message, severity, created_at)
        VALUES ($1, 'arbitration', $2, 'high', NOW())
      `, [this.currentRegion, message]);
      
      // 也可以通过 WebSocket 或其他方式实时通知
      logger.warn({ message }, 'Region alert sent');
      
    } catch (error) {
      logger.error({ error }, 'Failed to send alert');
    }
  }

  /**
   * 更新同步状态
   */
  async _updateSyncStatus(successCount, conflictCount) {
    const status = conflictCount > 0 ? SYNC_STATUS.CONFLICT :
                   successCount > 0 ? SYNC_STATUS.SYNCED : SYNC_STATUS.FAILED;
    
    await this.redis.hset(
      `region:sync:${this.currentRegion}`,
      'status', status,
      'lastSync', Date.now(),
      'successCount', successCount,
      'conflictCount', conflictCount
    );
  }

  /**
   * 计算状态哈希
   */
  _calculateHash(state) {
    const crypto = require('crypto');
    const content = JSON.stringify({
      services: state.services,
      metrics: state.metrics
    });
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * 获取所有区域状态
   */
  async getAllRegionStates() {
    const states = {};
    
    for (const [regionId] of Object.entries(REGIONS)) {
      if (this.regionStates.has(regionId)) {
        states[regionId] = this.regionStates.get(regionId);
      } else {
        // 尝试从 Redis 加载
        const cached = await this.redis.get(`region:status:${regionId}`);
        if (cached) {
          states[regionId] = JSON.parse(cached);
        }
      }
    }
    
    return states;
  }

  /**
   * 获取特定区域状态
   */
  async getRegionState(regionId) {
    if (this.regionStates.has(regionId)) {
      return this.regionStates.get(regionId);
    }
    
    const cached = await this.redis.get(`region:status:${regionId}`);
    return cached ? JSON.parse(cached) : null;
  }

  /**
   * 手动触发同步
   */
  async manualSync() {
    logger.info('Manual sync triggered');
    await this._sync();
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const states = await this.getAllRegionStates();
    const healthyRegions = Object.values(states).filter(s => s.health === 'healthy').length;
    
    return {
      status: this.isRunning ? 'running' : 'stopped',
      currentRegion: this.currentRegion,
      totalRegions: Object.keys(REGIONS).length,
      healthyRegions,
      syncQueueSize: this.syncQueue.length,
      lastSync: await this.redis.hget(`region:sync:${this.currentRegion}`, 'lastSync')
    };
  }
}

// 导出单例
let instance = null;

function getRegionSyncService(options = {}) {
  if (!instance) {
    instance = new RegionSyncService(options);
  }
  return instance;
}

module.exports = {
  RegionSyncService,
  getRegionSyncService,
  REGIONS,
  SERVICE_STATUS,
  SYNC_STATUS
};
