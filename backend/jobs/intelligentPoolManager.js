/**
 * 数据库连接池智能预热与动态自适应管理系统
 * REQ-00623: 数据库连接池智能预热与动态自适应管理系统
 * 
 * 功能：
 * 1. 流量趋势分析 - 基于历史数据预测流量高峰
 * 2. 智能预热 - 在高峰前 5-10 分钟预热连接池
 * 3. 动态调整 - 根据实时连接使用率动态调整连接池大小
 * 4. 安全保护 - 设置最大连接数限制，防止资源耗尽
 */

const { createLogger } = require('../shared/logger');
const { getPoolConfigCenter } = require('../shared/poolConfigCenter');
const redis = require('../shared/redis');
const { Kafka } = require('kafkajs');

const logger = createLogger('intelligent-pool-manager');

class IntelligentPoolManager {
  constructor(options = {}) {
    // Kafka 配置
    this.kafka = new Kafka({
      clientId: options.clientId || 'intelligent-pool-manager',
      brokers: options.kafkaBrokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'pool-manager-group' });

    // 配置中心
    this.configCenter = getPoolConfigCenter();

    // Redis 键前缀
    this.redisPrefix = 'pool-manager:';

    // 预热提前时间（分钟）
    this.preheatAdvanceMinutes = options.preheatAdvanceMinutes || 10;

    // 监控间隔（秒）
    this.monitorIntervalSeconds = options.monitorIntervalSeconds || 60;

    // 扩缩容阈值
    this.scaleUpThreshold = options.scaleUpThreshold || 0.85;  // 使用率 > 85% 扩容
    this.scaleDownThreshold = options.scaleDownThreshold || 0.30; // 使用率 < 30% 缩容
    this.scaleStableMinutes = options.scaleStableMinutes || 5;  // 连续 5 分钟才触发调整

    // 安全限制
    this.maxPoolSize = options.maxPoolSize || 30;
    this.minPoolSize = options.minPoolSize || 2;

    // 流量历史数据保留时间（小时）
    this.historyRetentionHours = options.historyRetentionHours || 24;

    // 服务列表
    this.services = [
      'user-service',
      'location-service',
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service',
      'gateway'
    ];

    // 当前连接池状态
    this.poolStates = new Map();

    // 定时器
    this.monitorTimer = null;
    this.preheatTimer = null;

    // 运行状态
    this.initialized = false;
  }

  /**
   * 启动智能连接池管理器
   */
  async start() {
    if (this.initialized) {
      logger.warn('IntelligentPoolManager already started');
      return;
    }

    try {
      // 连接 Kafka
      await this.producer.connect();
      await this.consumer.connect();

      // 订阅相关主题
      await this.consumer.subscribe({ topic: 'pool-metrics', fromBeginning: false });
      await this.consumer.subscribe({ topic: 'traffic-prediction', fromBeginning: false });

      // 启动 Kafka 消费者
      await this.consumer.run({
        eachMessage: async ({ topic, message }) => {
          try {
            const data = JSON.parse(message.value.toString());

            if (topic === 'pool-metrics') {
              await this.handlePoolMetrics(data);
            } else if (topic === 'traffic-prediction') {
              await this.handleTrafficPrediction(data);
            }
          } catch (error) {
            logger.error('Failed to process message', { 
              topic, 
              error: error.message 
            });
          }
        }
      });

      // 启动监控定时任务
      this.monitorTimer = setInterval(
        () => this.monitorAndAdjust(),
        this.monitorIntervalSeconds * 1000
      );

      // 启动预热检查定时任务
      this.preheatTimer = setInterval(
        () => this.checkAndPreheat(),
        60000  // 每分钟检查一次
      );

      // 加载历史数据
      await this.loadHistoricalData();

      this.initialized = true;
      logger.info('IntelligentPoolManager started successfully', {
        services: this.services.length,
        monitorInterval: this.monitorIntervalSeconds,
        preheatAdvance: this.preheatAdvanceMinutes
      });

      // 立即执行一次检查
      await this.monitorAndAdjust();
      await this.checkAndPreheat();

    } catch (error) {
      logger.error('Failed to start IntelligentPoolManager', { error: error.message });
      throw error;
    }
  }

  /**
   * 停止智能连接池管理器
   */
  async stop() {
    if (!this.initialized) {
      return;
    }

    // 清除定时器
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    if (this.preheatTimer) {
      clearInterval(this.preheatTimer);
      this.preheatTimer = null;
    }

    // 断开 Kafka 连接
    await this.consumer.disconnect();
    await this.producer.disconnect();

    this.initialized = false;
    logger.info('IntelligentPoolManager stopped');
  }

  /**
   * 处理连接池指标数据
   */
  async handlePoolMetrics(data) {
    const { service, metrics, timestamp } = data;

    // 更新连接池状态
    const state = this.poolStates.get(service) || {
      utilization: [],
      waitingClients: [],
      totalConnections: [],
      lastScaleTime: null,
      scaleDirection: null
    };

    // 添加新指标
    state.utilization.push({
      value: metrics.utilization,
      timestamp
    });
    state.waitingClients.push({
      value: metrics.waitingClients,
      timestamp
    });
    state.totalConnections.push({
      value: metrics.totalConnections,
      timestamp
    });

    // 保留最近 15 分钟数据
    const cutoff = Date.now() - 15 * 60 * 1000;
    state.utilization = state.utilization.filter(d => d.timestamp > cutoff);
    state.waitingClients = state.waitingClients.filter(d => d.timestamp > cutoff);
    state.totalConnections = state.totalConnections.filter(d => d.timestamp > cutoff);

    this.poolStates.set(service, state);

    // 记录到配置中心
    this.configCenter.recordMetrics(service, metrics);

    // 保存到 Redis
    await this.saveMetricsToRedis(service, metrics, timestamp);
  }

  /**
   * 处理流量预测数据
   */
  async handleTrafficPrediction(data) {
    const { predictions, timestamp } = data;

    logger.info('Received traffic predictions', {
      predictionCount: predictions?.length || 0,
      timestamp
    });

    // 保存预测数据到 Redis
    await redis.setex(
      this.redisPrefix + 'traffic-prediction',
      3600, // 1 小时过期
      JSON.stringify({ predictions, timestamp, receivedAt: Date.now() })
    );
  }

  /**
   * 监控并动态调整连接池
   */
  async monitorAndAdjust() {
    const results = [];

    for (const service of this.services) {
      try {
        const result = await this.adjustPoolSize(service);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        logger.error('Failed to adjust pool size', {
          service,
          error: error.message
        });
      }
    }

    if (results.length > 0) {
      logger.info('Pool adjustment completed', {
        adjustments: results.length,
        results
      });
    }

    return results;
  }

  /**
   * 调整单个服务的连接池大小
   */
  async adjustPoolSize(service) {
    const state = this.poolStates.get(service);
    if (!state || state.utilization.length < 5) {
      return null; // 数据不足
    }

    // 计算最近 N 分钟的平均使用率
    const recentMinutes = this.scaleStableMinutes;
    const recentData = state.utilization.slice(-recentMinutes);
    
    if (recentData.length < recentMinutes) {
      return null; // 数据不足
    }

    const avgUtilization = recentData.reduce((sum, d) => sum + d.value, 0) / recentData.length;
    const maxUtilization = Math.max(...recentData.map(d => d.value));
    const avgWaiting = state.waitingClients.slice(-recentMinutes)
      .reduce((sum, d) => sum + d.value, 0) / recentMinutes;

    const currentConfig = this.configCenter.getConfig(service);
    let newSize = currentConfig.maxSize;
    let action = null;

    // 扩容判断
    if (avgUtilization > this.scaleUpThreshold && avgWaiting > 3) {
      // 连续高使用率且有等待客户端，需要扩容
      const newSize = Math.min(
        Math.ceil(currentConfig.maxSize * 1.3),
        this.maxPoolSize
      );

      if (newSize > currentConfig.maxSize) {
        action = 'scale_up';
        
        // 检查是否刚扩容过（避免频繁调整）
        if (state.lastScaleTime && Date.now() - state.lastScaleTime < 5 * 60 * 1000) {
          logger.debug('Skipping scale up due to recent adjustment', { service });
          return null;
        }

        await this.applyPoolSize(service, {
          maxSize: newSize,
          minSize: Math.min(currentConfig.minSize + 1, newSize - 2)
        });

        state.lastScaleTime = Date.now();
        state.scaleDirection = 'up';
        this.poolStates.set(service, state);

        return {
          service,
          action,
          oldSize: currentConfig.maxSize,
          newSize,
          reason: `Avg utilization ${(avgUtilization * 100).toFixed(1)}% > ${this.scaleUpThreshold * 100}%`,
          avgWaiting
        };
      }
    }

    // 缩容判断
    if (avgUtilization < this.scaleDownThreshold && avgWaiting < 1) {
      // 连续低使用率且无等待客户端，可以缩容
      const newSize = Math.max(
        Math.ceil(currentConfig.maxSize * 0.7),
        this.minPoolSize
      );

      if (newSize < currentConfig.maxSize) {
        action = 'scale_down';

        // 检查是否刚缩容过
        if (state.lastScaleTime && Date.now() - state.lastScaleTime < 10 * 60 * 1000) {
          logger.debug('Skipping scale down due to recent adjustment', { service });
          return null;
        }

        await this.applyPoolSize(service, {
          maxSize: newSize,
          minSize: Math.max(currentConfig.minSize - 1, this.minPoolSize)
        });

        state.lastScaleTime = Date.now();
        state.scaleDirection = 'down';
        this.poolStates.set(service, state);

        return {
          service,
          action,
          oldSize: currentConfig.maxSize,
          newSize,
          reason: `Avg utilization ${(avgUtilization * 100).toFixed(1)}% < ${this.scaleDownThreshold * 100}%`,
          avgWaiting
        };
      }
    }

    return null;
  }

  /**
   * 应用连接池大小调整
   */
  async applyPoolSize(service, newConfig) {
    // 更新配置中心
    this.configCenter.updateConfigs({ [service]: newConfig });

    // 发送 Kafka 事件通知各服务
    await this.producer.send({
      topic: 'pool-config-updates',
      messages: [{
        key: service,
        value: JSON.stringify({
          service,
          action: 'update_pool_size',
          config: newConfig,
          timestamp: new Date().toISOString(),
          source: 'intelligent-pool-manager'
        })
      }]
    });

    logger.info('Pool size updated', {
      service,
      newConfig
    });
  }

  /**
   * 检查并预热连接池
   */
  async checkAndPreheat() {
    try {
      // 获取流量预测
      const predictionData = await redis.get(this.redisPrefix + 'traffic-prediction');
      
      if (!predictionData) {
        // 使用默认高峰时段
        await this.preheatBasedOnDefaultSchedule();
        return;
      }

      const { predictions } = JSON.parse(predictionData);
      
      // 检查是否接近预测的高峰时段
      const now = new Date();
      const minutes = now.getMinutes();
      const hour = now.getHours();

      // 查找未来 30 分钟内的流量高峰
      const upcomingPeak = predictions?.find(p => {
        const peakTime = new Date(p.timestamp);
        const minutesToPeak = (peakTime - now) / 60000;
        return minutesToPeak > 0 && minutesToPeak <= this.preheatAdvanceMinutes;
      });

      if (upcomingPeak) {
        logger.info('Upcoming traffic peak detected, preheating pools', {
          peakTime: upcomingPeak.timestamp,
          expectedTraffic: upcomingPeak.expectedTraffic,
          minutesToPeak: Math.round((new Date(upcomingPeak.timestamp) - now) / 60000)
        });

        await this.preheatAllPools(upcomingPeak.expectedTraffic);
      }

    } catch (error) {
      logger.error('Failed to check and preheat', { error: error.message });
    }
  }

  /**
   * 基于默认时间表预热
   */
  async preheatBasedOnDefaultSchedule() {
    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const minutesToNextHour = 60 - minutes;

    // 默认高峰时段（UTC）
    const peakHours = [0, 4, 12, 16, 17, 18, 19]; // 对应不同时区的高峰

    const nextHour = (hour + 1) % 24;

    if (peakHours.includes(nextHour) && minutesToNextHour <= this.preheatAdvanceMinutes) {
      // 检查是否已预热
      const preheatKey = this.redisPrefix + `preheat:${nextHour}:${now.toISOString().split('T')[0]}`;
      const alreadyPreheated = await redis.get(preheatKey);

      if (!alreadyPreheated) {
        logger.info('Approaching default peak hour, preheating pools', {
          peakHour: nextHour,
          minutesToPeak: minutesToNextHour
        });

        await this.preheatAllPools('high');

        // 标记已预热
        await redis.setex(preheatKey, 86400, '1');
      }
    }
  }

  /**
   * 预热所有服务的连接池
   */
  async preheatAllPools(expectedTraffic = 'medium') {
    const results = [];

    // 根据预期流量确定目标连接数
    const trafficMultiplier = {
      'low': 0.7,
      'medium': 1.0,
      'high': 1.3,
      'very_high': 1.5
    };

    const multiplier = trafficMultiplier[expectedTraffic] || 1.0;

    for (const service of this.services) {
      try {
        const currentConfig = this.configCenter.getConfig(service);
        
        // 计算目标连接数
        const targetMaxSize = Math.min(
          Math.ceil(currentConfig.maxSize * multiplier),
          this.maxPoolSize
        );

        const targetMinSize = Math.min(
          Math.ceil(targetMaxSize * 0.5),
          targetMaxSize - 2
        );

        // 应用预热配置
        await this.applyPoolSize(service, {
          maxSize: targetMaxSize,
          minSize: targetMinSize
        });

        results.push({
          service,
          success: true,
          targetMaxSize,
          targetMinSize
        });

      } catch (error) {
        logger.error('Failed to preheat pool', {
          service,
          error: error.message
        });
        results.push({
          service,
          success: false,
          error: error.message
        });
      }
    }

    logger.info('Pool preheat completed', {
      expectedTraffic,
      total: results.length,
      success: results.filter(r => r.success).length
    });

    return results;
  }

  /**
   * 保存指标到 Redis
   */
  async saveMetricsToRedis(service, metrics, timestamp) {
    const key = this.redisPrefix + `metrics:${service}`;
    const data = {
      service,
      metrics,
      timestamp
    };

    // 使用 Redis List 存储历史数据
    await redis.lpush(key, JSON.stringify(data));
    
    // 保留最近 1 小时数据
    await redis.ltrim(key, 0, 59);
    
    // 设置过期时间
    await redis.expire(key, 3600);
  }

  /**
   * 加载历史数据
   */
  async loadHistoricalData() {
    try {
      for (const service of this.services) {
        const key = this.redisPrefix + `metrics:${service}`;
        const data = await redis.lrange(key, 0, 14); // 最近 15 条

        if (data && data.length > 0) {
          const state = {
            utilization: [],
            waitingClients: [],
            totalConnections: [],
            lastScaleTime: null,
            scaleDirection: null
          };

          for (const item of data.reverse()) {
            try {
              const parsed = JSON.parse(item);
              state.utilization.push({
                value: parsed.metrics.utilization,
                timestamp: parsed.timestamp
              });
              state.waitingClients.push({
                value: parsed.metrics.waitingClients,
                timestamp: parsed.timestamp
              });
              state.totalConnections.push({
                value: parsed.metrics.totalConnections,
                timestamp: parsed.timestamp
              });
            } catch (e) {
              // 跳过无效数据
            }
          }

          this.poolStates.set(service, state);
        }
      }

      logger.info('Historical data loaded', {
        servicesWithData: this.poolStates.size
      });

    } catch (error) {
      logger.error('Failed to load historical data', { error: error.message });
    }
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    const poolStatus = {};
    
    for (const [service, state] of this.poolStates) {
      const recentUtilization = state.utilization.slice(-5);
      const avgUtilization = recentUtilization.length > 0
        ? recentUtilization.reduce((sum, d) => sum + d.value, 0) / recentUtilization.length
        : 0;

      poolStatus[service] = {
        avgUtilization: (avgUtilization * 100).toFixed(1) + '%',
        lastScaleTime: state.lastScaleTime,
        scaleDirection: state.scaleDirection,
        dataPoints: state.utilization.length
      };
    }

    return {
      initialized: this.initialized,
      services: this.services,
      poolStates: poolStatus,
      config: {
        preheatAdvanceMinutes: this.preheatAdvanceMinutes,
        monitorIntervalSeconds: this.monitorIntervalSeconds,
        scaleUpThreshold: this.scaleUpThreshold,
        scaleDownThreshold: this.scaleDownThreshold,
        maxPoolSize: this.maxPoolSize,
        minPoolSize: this.minPoolSize
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 手动触发预热
   */
  async forcePreheat(expectedTraffic = 'high') {
    logger.info('Force preheat triggered', { expectedTraffic });
    return await this.preheatAllPools(expectedTraffic);
  }

  /**
   * 获取优化建议
   */
  getOptimizationRecommendations() {
    const recommendations = [];

    for (const [service, state] of this.poolStates) {
      if (state.utilization.length < 60) continue;

      const avgUtilization = state.utilization.reduce((sum, d) => sum + d.value, 0) / state.utilization.length;
      const maxUtilization = Math.max(...state.utilization.map(d => d.value));
      const currentConfig = this.configCenter.getConfig(service);

      if (avgUtilization < 0.4 && maxUtilization < 0.7) {
        recommendations.push({
          service,
          type: 'reduce_size',
          reason: `Low utilization (avg ${(avgUtilization * 100).toFixed(1)}%, max ${(maxUtilization * 100).toFixed(1)}%)`,
          suggestedMaxSize: Math.ceil(currentConfig.maxSize * 0.8)
        });
      } else if (avgUtilization > 0.8 || maxUtilization > 0.95) {
        recommendations.push({
          service,
          type: 'increase_size',
          reason: `High utilization (avg ${(avgUtilization * 100).toFixed(1)}%, max ${(maxUtilization * 100).toFixed(1)}%)`,
          suggestedMaxSize: Math.ceil(currentConfig.maxSize * 1.3)
        });
      }
    }

    return recommendations;
  }
}

// ============================================================
// Singleton Instance
// ============================================================

let instance = null;

function getIntelligentPoolManager() {
  if (!instance) {
    instance = new IntelligentPoolManager();
  }
  return instance;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  IntelligentPoolManager,
  getIntelligentPoolManager
};
