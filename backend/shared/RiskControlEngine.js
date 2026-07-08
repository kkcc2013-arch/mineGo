// backend/shared/RiskControlEngine.js - 实时风控与反作弊分析引擎
'use strict';

const { query } = require('./db');
const { getRedis, setJSON, getJSON, incr, expire } = require('./redis');
const { createLogger } = require('./logger');
const { Kafka } = require('kafkajs');
const promClient = require('prom-client');

const logger = createLogger('risk-control-engine');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  eventsProcessed: new promClient.Counter({
    name: 'risk_control_events_processed_total',
    help: 'Total number of events processed by risk control engine',
    labelNames: ['event_type', 'result']
  }),
  
  cheatingDetected: new promClient.Counter({
    name: 'risk_control_cheating_detected_total',
    help: 'Total number of cheating incidents detected',
    labelNames: ['type', 'severity']
  }),
  
  actionTaken: new promClient.Counter({
    name: 'risk_control_actions_taken_total',
    help: 'Total number of actions taken against cheaters',
    labelNames: ['action_type']
  }),
  
  processingLatency: new promClient.Histogram({
    name: 'risk_control_processing_latency_seconds',
    help: 'Latency of risk control processing',
    labelNames: ['event_type'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
  }),
  
  ruleHits: new promClient.Counter({
    name: 'risk_control_rule_hits_total',
    help: 'Total number of rule hits',
    labelNames: ['rule_id', 'rule_name']
  })
};

// ============================================================
// 配置常量
// ============================================================

const CONFIG = {
  // 风险分数阈值
  RISK_THRESHOLDS: {
    LOW: 30,
    MEDIUM: 60,
    HIGH: 80,
    CRITICAL: 95
  },
  
  // 行动阈值
  ACTION_THRESHOLDS: {
    WARNING: 60,
    RATE_LIMIT: 75,
    TEMP_BAN: 85,
    PERM_BAN: 95
  },
  
  // 滑动窗口配置
  WINDOWS: {
    MINUTE: 60,
    HOUR: 3600,
    DAY: 86400
  },
  
  // Kafka 配置
  KAFKA_TOPIC: 'game-behavior-events',
  KAFKA_GROUP: 'risk-control-engine'
};

// ============================================================
// 规则定义
// ============================================================

const ANTI_CHEAT_RULES = [
  {
    id: 'SPEED_HACK_001',
    name: '速度异常检测',
    category: 'location',
    severity: 'high',
    description: '检测移动速度是否超过物理限制',
    check: async (events, context) => {
      const locationEvents = events.filter(e => e.type === 'location_update');
      if (locationEvents.length < 2) return null;
      
      const speeds = [];
      for (let i = 1; i < locationEvents.length; i++) {
        const prev = locationEvents[i - 1];
        const curr = locationEvents[i];
        const distance = calculateDistance(
          prev.latitude, prev.longitude,
          curr.latitude, curr.longitude
        );
        const timeDiff = (curr.timestamp - prev.timestamp) / 1000; // 秒
        const speed = timeDiff > 0 ? distance / timeDiff : 0;
        speeds.push(speed);
      }
      
      const maxSpeed = Math.max(...speeds);
      const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      
      // 步行：最大 5 m/s (18 km/h)
      // 骑行：最大 15 m/s (54 km/h)
      // 驾车：最大 50 m/s (180 km/h)
      // 瞬移：超过 200 m/s
      
      if (maxSpeed > 200) {
        return {
          rule_id: 'SPEED_HACK_001',
          matched: true,
          severity: 'critical',
          score: 100,
          details: { maxSpeed, avgSpeed, speedCount: speeds.length },
          message: `瞬移作弊检测：最高速度 ${maxSpeed.toFixed(2)} m/s`
        };
      } else if (maxSpeed > 50 && avgSpeed > 30) {
        return {
          rule_id: 'SPEED_HACK_001',
          matched: true,
          severity: 'high',
          score: 85,
          details: { maxSpeed, avgSpeed, speedCount: speeds.length },
          message: `速度异常：最高速度 ${maxSpeed.toFixed(2)} m/s，平均速度 ${avgSpeed.toFixed(2)} m/s`
        };
      } else if (maxSpeed > 15 && avgSpeed > 10) {
        return {
          rule_id: 'SPEED_HACK_001',
          matched: true,
          severity: 'medium',
          score: 70,
          details: { maxSpeed, avgSpeed },
          message: `速度可疑：最高速度 ${maxSpeed.toFixed(2)} m/s`
        };
      }
      
      return null;
    }
  },
  
  {
    id: 'CATCH_FREQUENCY_001',
    name: '捕捉频率异常',
    category: 'catch',
    severity: 'high',
    description: '检测捕捉频率是否超过合理范围',
    check: async (events, context) => {
      const catchEvents = events.filter(e => e.type === 'pokemon_catch');
      const windowSize = context.windowSize || CONFIG.WINDOWS.HOUR;
      
      // 正常捕捉频率：
      // 每分钟最多 30 次
      // 每小时最多 500 次
      
      const catchesPerMinute = catchEvents.length / (windowSize / 60);
      const maxCatchesPerMinute = 30;
      
      if (catchesPerMinute > maxCatchesPerMinute * 2) {
        return {
          rule_id: 'CATCH_FREQUENCY_001',
          matched: true,
          severity: 'critical',
          score: 95,
          details: { 
            totalCatches: catchEvents.length, 
            catchesPerMinute: catchesPerMinute.toFixed(2) 
          },
          message: `捕捉频率异常：${catchEvents.length} 次/${windowSize}秒 (${catchesPerMinute.toFixed(2)} 次/分钟)`
        };
      } else if (catchesPerMinute > maxCatchesPerMinute) {
        return {
          rule_id: 'CATCH_FREQUENCY_001',
          matched: true,
          severity: 'high',
          score: 80,
          details: { totalCatches: catchEvents.length, catchesPerMinute: catchesPerMinute.toFixed(2) },
          message: `捕捉频率偏高：${catchesPerMinute.toFixed(2)} 次/分钟`
        };
      }
      
      return null;
    }
  },
  
  {
    id: 'LOCATION_SPOOF_001',
    name: 'GPS 伪造检测',
    category: 'location',
    severity: 'critical',
    description: '检测 GPS 坐标伪造特征',
    check: async (events, context) => {
      const locationEvents = events.filter(e => e.type === 'location_update');
      if (locationEvents.length < 3) return null;
      
      const spoofIndicators = [];
      
      // 1. 检测完美直线移动（真实 GPS 会有抖动）
      const straightness = calculateStraightness(locationEvents);
      if (straightness > 0.95) {
        spoofIndicators.push({
          type: 'perfect_straight_line',
          value: straightness,
          description: '移动轨迹过于平直'
        });
      }
      
      // 2. 检测海拔异常（突然从海平面变为高山）
      const altitudeVariance = calculateAltitudeVariance(locationEvents);
      if (altitudeVariance > 1000) {
        spoofIndicators.push({
          type: 'altitude_anomaly',
          value: altitudeVariance,
          description: '海拔变化异常'
        });
      }
      
      // 3. 检测精度异常（GPS 精度永远完美）
      const accuracyValues = locationEvents.map(e => e.accuracy).filter(a => a !== undefined);
      if (accuracyValues.length > 0) {
        const avgAccuracy = accuracyValues.reduce((a, b) => a + b, 0) / accuracyValues.length;
        if (avgAccuracy < 1) {
          spoofIndicators.push({
            type: 'perfect_accuracy',
            value: avgAccuracy,
            description: 'GPS 精度异常完美'
          });
        }
      }
      
      if (spoofIndicators.length >= 2) {
        return {
          rule_id: 'LOCATION_SPOOF_001',
          matched: true,
          severity: 'critical',
          score: 90 + spoofIndicators.length * 5,
          details: { indicators: spoofIndicators },
          message: `GPS 伪造特征：${spoofIndicators.map(i => i.description).join(', ')}`
        };
      } else if (spoofIndicators.length === 1) {
        return {
          rule_id: 'LOCATION_SPOOF_001',
          matched: true,
          severity: 'high',
          score: 75,
          details: { indicators: spoofIndicators },
          message: `GPS 可疑：${spoofIndicators[0].description}`
        };
      }
      
      return null;
    }
  },
  
  {
    id: 'ITEM_USAGE_001',
    name: '道具使用异常',
    category: 'item',
    severity: 'medium',
    description: '检测道具使用频率异常',
    check: async (events, context) => {
      const itemEvents = events.filter(e => e.type === 'item_use');
      const windowSize = context.windowSize || CONFIG.WINDOWS.MINUTE;
      
      const itemsPerMinute = itemEvents.length / (windowSize / 60);
      const maxItemsPerMinute = 60;
      
      if (itemsPerMinute > maxItemsPerMinute * 2) {
        return {
          rule_id: 'ITEM_USAGE_001',
          matched: true,
          severity: 'high',
          score: 85,
          details: { totalItems: itemEvents.length, itemsPerMinute: itemsPerMinute.toFixed(2) },
          message: `道具使用异常：${itemsPerMinute.toFixed(2)} 次/分钟`
        };
      } else if (itemsPerMinute > maxItemsPerMinute) {
        return {
          rule_id: 'ITEM_USAGE_001',
          matched: true,
          severity: 'medium',
          score: 65,
          details: { totalItems: itemEvents.length, itemsPerMinute: itemsPerMinute.toFixed(2) },
          message: `道具使用频率偏高`
        };
      }
      
      return null;
    }
  },
  
  {
    id: 'GYM_BATTLE_001',
    name: '道馆战斗异常',
    category: 'gym',
    severity: 'high',
    description: '检测道馆战斗异常（自动战斗脚本）',
    check: async (events, context) => {
      const battleEvents = events.filter(e => e.type === 'gym_battle');
      if (battleEvents.length < 5) return null;
      
      const anomalies = [];
      
      // 1. 检测战斗间隔过于规律
      const intervals = [];
      for (let i = 1; i < battleEvents.length; i++) {
        intervals.push(battleEvents[i].timestamp - battleEvents[i - 1].timestamp);
      }
      
      const intervalVariance = calculateVariance(intervals);
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      
      // 如果间隔方差极小（几乎相同），可能是脚本
      if (intervalVariance < 100 && avgInterval > 0) {
        anomalies.push({
          type: 'regular_interval',
          value: avgInterval,
          variance: intervalVariance,
          description: '战斗间隔过于规律'
        });
      }
      
      // 2. 检测完美闪避/攻击
      const perfectActions = battleEvents.filter(e => 
        e.details && (e.details.perfect_dodge || e.details.perfect_hit)
      ).length;
      
      if (perfectActions > battleEvents.length * 0.9) {
        anomalies.push({
          type: 'perfect_actions',
          ratio: perfectActions / battleEvents.length,
          description: '完美操作比例异常'
        });
      }
      
      if (anomalies.length >= 2) {
        return {
          rule_id: 'GYM_BATTLE_001',
          matched: true,
          severity: 'critical',
          score: 90 + anomalies.length * 5,
          details: { anomalies },
          message: `道馆战斗异常：${anomalies.map(a => a.description).join(', ')}`
        };
      } else if (anomalies.length === 1) {
        return {
          rule_id: 'GYM_BATTLE_001',
          matched: true,
          severity: 'high',
          score: 80,
          details: { anomalies },
          message: `道馆战斗可疑：${anomalies[0].description}`
        };
      }
      
      return null;
    }
  },
  
  {
    id: 'MULTI_DEVICE_001',
    name: '多设备登录检测',
    category: 'auth',
    severity: 'high',
    description: '检测同一账号多设备同时登录',
    check: async (events, context) => {
      const authEvents = events.filter(e => e.type === 'auth');
      const devices = new Map();
      
      authEvents.forEach(event => {
        const deviceId = event.device_id || event.fingerprint;
        const ip = event.ip_address;
        
        if (!devices.has(deviceId)) {
          devices.set(deviceId, { 
            ips: new Set(),
            locations: new Set(),
            timestamps: []
          });
        }
        
        const device = devices.get(deviceId);
        device.ips.add(ip);
        device.locations.add(`${event.latitude},${event.longitude}`);
        device.timestamps.push(event.timestamp);
      });
      
      // 检测时间重叠的多设备
      const deviceList = Array.from(devices.entries());
      let overlappingDevices = 0;
      
      for (let i = 0; i < deviceList.length; i++) {
        for (let j = i + 1; j < deviceList.length; j++) {
          const [dev1, data1] = deviceList[i];
          const [dev2, data2] = deviceList[j];
          
          // 检查时间窗口重叠
          const times1 = data1.timestamps.sort();
          const times2 = data2.timestamps.sort();
          
          if (times1.length > 0 && times2.length > 0) {
            const overlap = hasTimeOverlap(times1, times2, 300000); // 5分钟窗口
            if (overlap) {
              overlappingDevices++;
            }
          }
        }
      }
      
      if (overlappingDevices >= 2) {
        return {
          rule_id: 'MULTI_DEVICE_001',
          matched: true,
          severity: 'critical',
          score: 95,
          details: { 
            deviceCount: devices.size,
            overlappingPairs: overlappingDevices
          },
          message: `检测到同时多设备登录：${devices.size} 个设备`
        };
      } else if (overlappingDevices === 1) {
        return {
          rule_id: 'MULTI_DEVICE_001',
          matched: true,
          severity: 'high',
          score: 80,
          details: { deviceCount: devices.size, overlappingPairs: overlappingDevices },
          message: `检测到多设备登录`
        };
      }
      
      return null;
    }
  },
  
  {
    id: 'ANOMALOUS_TRADE_001',
    name: '异常交易检测',
    category: 'trade',
    severity: 'medium',
    description: '检测精灵交易异常模式',
    check: async (events, context) => {
      const tradeEvents = events.filter(e => e.type === 'pokemon_trade');
      if (tradeEvents.length < 3) return null;
      
      const anomalies = [];
      
      // 1. 高价值精灵频繁交易
      const highValueTrades = tradeEvents.filter(e => 
        e.details && e.details.pokemon_rarity && ['legendary', 'mythical'].includes(e.details.pokemon_rarity)
      ).length;
      
      if (highValueTrades > 5) {
        anomalies.push({
          type: 'high_value_frequency',
          count: highValueTrades,
          description: '高价值精灵频繁交易'
        });
      }
      
      // 2. 交易对象单一（洗号嫌疑）
      const tradePartners = new Set(tradeEvents.map(e => e.details?.partner_id).filter(Boolean));
      if (tradePartners.size === 1 && tradeEvents.length > 10) {
        anomalies.push({
          type: 'single_partner',
          partnerId: Array.from(tradePartners)[0],
          count: tradeEvents.length,
          description: '交易对象单一'
        });
      }
      
      // 3. 不对等交易（高换低）
      const unfairTrades = tradeEvents.filter(e => 
        e.details && e.details.value_difference && Math.abs(e.details.value_difference) > 1000
      ).length;
      
      if (unfairTrades > 3) {
        anomalies.push({
          type: 'unfair_trades',
          count: unfairTrades,
          description: '不对等交易'
        });
      }
      
      if (anomalies.length >= 2) {
        return {
          rule_id: 'ANOMALOUS_TRADE_001',
          matched: true,
          severity: 'high',
          score: 85,
          details: { anomalies },
          message: `交易异常：${anomalies.map(a => a.description).join(', ')}`
        };
      } else if (anomalies.length === 1) {
        return {
          rule_id: 'ANOMALOUS_TRADE_001',
          matched: true,
          severity: 'medium',
          score: 70,
          details: { anomalies },
          message: `交易可疑：${anomalies[0].description}`
        };
      }
      
      return null;
    }
  }
];

// ============================================================
// 风控引擎类
// ============================================================

class RiskControlEngine {
  constructor(options = {}) {
    this.db = options.db || require('./db');
    this.redis = options.redis || getRedis();
    this.kafka = null;
    this.consumer = null;
    this.rules = ANTI_CHEAT_RULES;
    this.actionHandlers = new Map();
    this.isRunning = false;
    
    // 注册默认行动处理器
    this.registerActionHandlers();
    
    // Kafka 初始化
    this.initKafka(options.kafkaConfig);
  }
  
  // -----------------------------------------------------------
  // Kafka 初始化
  // -----------------------------------------------------------
  
  async initKafka(config = {}) {
    try {
      this.kafka = new Kafka({
        clientId: config.clientId || 'risk-control-engine',
        brokers: config.brokers || (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']),
        retry: {
          initialRetryTime: 100,
          retries: 8
        }
      });
      
      this.consumer = this.kafka.consumer({
        groupId: CONFIG.KAFKA_GROUP,
        sessionTimeout: 30000,
        heartbeatInterval: 10000
      });
      
      logger.info('Kafka consumer initialized', { groupId: CONFIG.KAFKA_GROUP });
    } catch (error) {
      logger.error('Failed to initialize Kafka', { error: error.message });
    }
  }
  
  // -----------------------------------------------------------
  // 行动处理器注册
  // -----------------------------------------------------------
  
  registerActionHandlers() {
    // 警告
    this.actionHandlers.set('warning', async (userId, result) => {
      await this.redis.setex(`user:${userId}:warning`, CONFIG.WINDOWS.DAY, JSON.stringify({
        type: 'anti_cheat_warning',
        message: result.message,
        timestamp: Date.now()
      }));
      
      await this.sendUserNotification(userId, 'warning', result.message);
      
      metrics.actionTaken.inc({ action_type: 'warning' });
      logger.info('Warning issued', { userId, ruleId: result.rule_id });
    });
    
    // 限速
    this.actionHandlers.set('rate_limit', async (userId, result) => {
      const limitKey = `user:${userId}:restricted`;
      await this.redis.setex(limitKey, CONFIG.WINDOWS.HOUR, '1');
      
      await this.db.query(`
        UPDATE users 
        SET rate_limit_multiplier = 0.5, rate_limit_reason = $2, updated_at = NOW()
        WHERE id = $1
      `, [userId, result.message]);
      
      await this.sendUserNotification(userId, 'rate_limit', '您的账号因异常行为被临时限速');
      
      metrics.actionTaken.inc({ action_type: 'rate_limit' });
      logger.warn('Rate limit applied', { userId, ruleId: result.rule_id });
    });
    
    // 临时封禁
    this.actionHandlers.set('temp_ban', async (userId, result) => {
      const banDuration = 24 * 60 * 60; // 24小时
      const banKey = `user:${userId}:banned`;
      
      await this.redis.setex(banKey, banDuration, JSON.stringify({
        reason: 'anti_cheat_detection',
        details: result.message,
        endTime: Date.now() + banDuration * 1000
      }));
      
      await this.db.query(`
        UPDATE users 
        SET status = 'suspended', 
            suspended_reason = 'anti_cheat_detection',
            suspended_until = NOW() + INTERVAL '24 hours',
            updated_at = NOW()
        WHERE id = $1
      `, [userId]);
      
      await this.auditBan(userId, 'temp_ban', result);
      
      metrics.actionTaken.inc({ action_type: 'temp_ban' });
      logger.error('Temporary ban applied', { userId, ruleId: result.rule_id, score: result.score });
    });
    
    // 永久封禁
    this.actionHandlers.set('perm_ban', async (userId, result) => {
      await this.db.query(`
        UPDATE users 
        SET status = 'banned',
            banned_reason = 'anti_cheat_detection',
            banned_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `, [userId]);
      
      await this.auditBan(userId, 'perm_ban', result);
      
      metrics.actionTaken.inc({ action_type: 'perm_ban' });
      logger.error('Permanent ban applied', { userId, ruleId: result.rule_id, score: result.score });
    });
    
    // 人工审核
    this.actionHandlers.set('manual_review', async (userId, result) => {
      await this.db.query(`
        INSERT INTO manual_review_queue (user_id, trigger_type, details, score, status, created_at)
        VALUES ($1, 'anti_cheat', $2, $3, 'pending', NOW())
      `, [userId, result.message, result.score]);
      
      metrics.actionTaken.inc({ action_type: 'manual_review' });
      logger.info('Added to manual review queue', { userId, ruleId: result.rule_id });
    });
  }
  
  // -----------------------------------------------------------
  // 启动引擎
  // -----------------------------------------------------------
  
  async start() {
    if (this.isRunning) {
      logger.warn('Risk control engine is already running');
      return;
    }
    
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: CONFIG.KAFKA_TOPIC, fromBeginning: false });
      
      this.isRunning = true;
      
      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const startTime = Date.now();
          
          try {
            const event = JSON.parse(message.value.toString());
            await this.processEvent(event);
            
            metrics.processingLatency.labels(event.type || 'unknown').observe((Date.now() - startTime) / 1000);
          } catch (error) {
            logger.error('Failed to process message', { error: error.message, message: message.value.toString() });
          }
        }
      });
      
      logger.info('Risk control engine started successfully');
    } catch (error) {
      logger.error('Failed to start risk control engine', { error: error.message });
      throw error;
    }
  }
  
  // -----------------------------------------------------------
  // 处理事件
  // -----------------------------------------------------------
  
  async processEvent(event) {
    const { user_id, type, timestamp, ...details } = event;
    
    metrics.eventsProcessed.labels(type, 'received').inc();
    
    // 1. 获取用户行为窗口
    const window = await this.getUserBehaviorWindow(user_id, CONFIG.WINDOWS.HOUR);
    
    // 2. 添加新事件到窗口
    window.push({ type, timestamp, ...details });
    
    // 3. 执行规则检查
    const results = await this.executeRules(window, { windowSize: CONFIG.WINDOWS.HOUR });
    
    // 4. 计算综合风险分数
    const overallScore = this.calculateOverallScore(results);
    
    // 5. 决定并执行行动
    const action = this.decideAction(overallScore, results);
    
    if (action) {
      await this.executeAction(user_id, action, results);
    }
    
    // 6. 缓存用户风险分数
    await this.cacheUserRiskScore(user_id, overallScore, results);
    
    // 7. 记录审计日志
    await this.recordAuditLog(user_id, event, results, overallScore, action);
    
    metrics.eventsProcessed.labels(type, 'processed').inc();
  }
  
  // -----------------------------------------------------------
  // 获取用户行为窗口
  // -----------------------------------------------------------
  
  async getUserBehaviorWindow(userId, windowSizeMs) {
    const cacheKey = `user:${userId}:behavior_window`;
    const cached = await getJSON(cacheKey);
    
    if (cached) {
      // 过滤掉过期事件
      const cutoff = Date.now() - windowSizeMs;
      return cached.filter(e => e.timestamp > cutoff);
    }
    
    // 从数据库加载最近事件
    const { rows } = await this.db.query(`
      SELECT event_type, event_data, created_at
      FROM user_behavior_events
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${Math.floor(windowSizeMs / 1000)} seconds'
      ORDER BY created_at DESC
      LIMIT 1000
    `, [userId]);
    
    return rows.map(row => ({
      type: row.event_type,
      timestamp: row.created_at.getTime(),
      ...row.event_data
    }));
  }
  
  // -----------------------------------------------------------
  // 执行规则检查
  // -----------------------------------------------------------
  
  async executeRules(window, context) {
    const results = [];
    
    for (const rule of this.rules) {
      try {
        const result = await rule.check(window, context);
        
        if (result && result.matched) {
          results.push(result);
          metrics.ruleHits.labels(rule.id, rule.name).inc();
          metrics.cheatingDetected.labels(rule.category, rule.severity).inc();
        }
      } catch (error) {
        logger.error(`Rule ${rule.id} execution failed`, { error: error.message });
      }
    }
    
    return results;
  }
  
  // -----------------------------------------------------------
  // 计算综合风险分数
  // -----------------------------------------------------------
  
  calculateOverallScore(results) {
    if (results.length === 0) return 0;
    
    // 使用最高分作为基准，其他规则按权重叠加
    const maxScore = Math.max(...results.map(r => r.score));
    const additionalScores = results
      .filter(r => r.score < maxScore)
      .reduce((sum, r) => sum + r.score * 0.1, 0);
    
    return Math.min(100, maxScore + additionalScores);
  }
  
  // -----------------------------------------------------------
  // 决定行动
  // -----------------------------------------------------------
  
  decideAction(score, results) {
    const criticalHits = results.filter(r => r.severity === 'critical').length;
    
    if (score >= CONFIG.ACTION_THRESHOLDS.PERM_BAN || criticalHits >= 2) {
      return 'perm_ban';
    } else if (score >= CONFIG.ACTION_THRESHOLDS.TEMP_BAN) {
      return 'temp_ban';
    } else if (score >= CONFIG.ACTION_THRESHOLDS.RATE_LIMIT) {
      return 'rate_limit';
    } else if (score >= CONFIG.ACTION_THRESHOLDS.WARNING) {
      return 'warning';
    }
    
    return null;
  }
  
  // -----------------------------------------------------------
  // 执行行动
  // -----------------------------------------------------------
  
  async executeAction(userId, action, results) {
    const handler = this.actionHandlers.get(action);
    
    if (!handler) {
      logger.error('Unknown action type', { action });
      return;
    }
    
    const topResult = results.sort((a, b) => b.score - a.score)[0];
    
    try {
      await handler(userId, topResult);
    } catch (error) {
      logger.error('Failed to execute action', { action, userId, error: error.message });
    }
  }
  
  // -----------------------------------------------------------
  // 缓存用户风险分数
  // -----------------------------------------------------------
  
  async cacheUserRiskScore(userId, score, results) {
    const cacheKey = `user:${userId}:risk_score`;
    const data = {
      score,
      topRules: results.slice(0, 3).map(r => r.rule_id),
      timestamp: Date.now()
    };
    
    await setJSON(cacheKey, CONFIG.WINDOWS.HOUR, data);
  }
  
  // -----------------------------------------------------------
  // 记录审计日志
  // -----------------------------------------------------------
  
  async recordAuditLog(userId, event, results, score, action) {
    try {
      await this.db.query(`
        INSERT INTO anti_cheat_audit_logs (
          user_id, event_type, event_data, 
          rules_triggered, risk_score, action_taken, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        userId,
        event.type,
        JSON.stringify(event),
        JSON.stringify(results.map(r => r.rule_id)),
        score,
        action
      ]);
    } catch (error) {
      logger.error('Failed to record audit log', { error: error.message });
    }
  }
  
  // -----------------------------------------------------------
  // 辅助方法：审计封禁
  // -----------------------------------------------------------
  
  async auditBan(userId, banType, result) {
    await this.db.query(`
      INSERT INTO user_bans (
        user_id, ban_type, reason, triggered_rules, score, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, [userId, banType, result.message, JSON.stringify([result.rule_id]), result.score]);
  }
  
  // -----------------------------------------------------------
  // 辅助方法：发送用户通知
  // -----------------------------------------------------------
  
  async sendUserNotification(userId, type, message) {
    // 实现通知发送逻辑（通过 WebSocket、推送等）
    logger.info('User notification sent', { userId, type, message });
  }
  
  // -----------------------------------------------------------
  // 停止引擎
  // -----------------------------------------------------------
  
  async stop() {
    if (this.consumer) {
      await this.consumer.disconnect();
    }
    
    this.isRunning = false;
    logger.info('Risk control engine stopped');
  }
  
  // -----------------------------------------------------------
  // 手动触发检测（用于测试或管理）
  // -----------------------------------------------------------
  
  async manualCheck(userId, windowSize = CONFIG.WINDOWS.HOUR) {
    const window = await this.getUserBehaviorWindow(userId, windowSize);
    const results = await this.executeRules(window, { windowSize });
    const score = this.calculateOverallScore(results);
    const action = this.decideAction(score, results);
    
    return {
      userId,
      windowSize,
      eventCount: window.length,
      results,
      score,
      action
    };
  }
}

// ============================================================
// 辅助函数
// ============================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateStraightness(events) {
  if (events.length < 3) return 0;
  
  let totalDeviation = 0;
  let count = 0;
  
  for (let i = 1; i < events.length - 1; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    const next = events[i + 1];
    
    const dist1 = calculateDistance(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
    const dist2 = calculateDistance(curr.latitude, curr.longitude, next.latitude, next.longitude);
    const dist3 = calculateDistance(prev.latitude, prev.longitude, next.latitude, next.longitude);
    
    if (dist1 + dist2 > 0) {
      const deviation = Math.abs(dist3 - dist1 - dist2) / (dist1 + dist2);
      totalDeviation += deviation;
      count++;
    }
  }
  
  return count > 0 ? 1 - (totalDeviation / count) : 0;
}

function calculateAltitudeVariance(events) {
  const altitudes = events
    .filter(e => e.altitude !== undefined && e.altitude !== null)
    .map(e => e.altitude);
  
  if (altitudes.length < 2) return 0;
  
  const mean = altitudes.reduce((a, b) => a + b, 0) / altitudes.length;
  const variance = altitudes.reduce((sum, alt) => sum + Math.pow(alt - mean, 2), 0) / altitudes.length;
  
  return Math.sqrt(variance);
}

function calculateVariance(values) {
  if (values.length < 2) return 0;
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
}

function hasTimeOverlap(times1, times2, thresholdMs) {
  if (times1.length === 0 || times2.length === 0) return false;
  
  const min1 = Math.min(...times1);
  const max1 = Math.max(...times1);
  const min2 = Math.min(...times2);
  const max2 = Math.max(...times2);
  
  return !(max1 + thresholdMs < min2 || max2 + thresholdMs < min1);
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  RiskControlEngine,
  ANTI_CHEAT_RULES,
  CONFIG,
  metrics
};
