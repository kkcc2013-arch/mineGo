// backend/shared/risk-engine/anti-cheat-rules.js - 反作弊规则定义
'use strict';

const { CONFIG } = require('./risk-constants');
const { calculateDistance, calculateStraightness, calculateAltitudeVariance, calculateVariance, hasTimeOverlap } = require('./risk-helpers');

/**
 * 反作弊规则集合
 * 每个规则包含 id, name, category, severity, description, check 函数
 */
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
        const timeDiff = (curr.timestamp - prev.timestamp) / 1000;
        const speed = timeDiff > 0 ? distance / timeDiff : 0;
        speeds.push(speed);
      }
      
      const maxSpeed = Math.max(...speeds);
      const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      
      if (maxSpeed > CONFIG.SPEED_LIMITS.TELEPORT) {
        return {
          rule_id: 'SPEED_HACK_001',
          matched: true,
          severity: 'critical',
          score: 100,
          details: { maxSpeed, avgSpeed, speedCount: speeds.length },
          message: `瞬移作弊检测：最高速度 ${maxSpeed.toFixed(2)} m/s`
        };
      } else if (maxSpeed > CONFIG.SPEED_LIMITS.DRIVING && avgSpeed > 30) {
        return {
          rule_id: 'SPEED_HACK_001',
          matched: true,
          severity: 'high',
          score: 85,
          details: { maxSpeed, avgSpeed, speedCount: speeds.length },
          message: `速度异常：最高速度 ${maxSpeed.toFixed(2)} m/s，平均速度 ${avgSpeed.toFixed(2)} m/s`
        };
      } else if (maxSpeed > CONFIG.SPEED_LIMITS.CYCLING && avgSpeed > 10) {
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
      
      const catchesPerMinute = catchEvents.length / (windowSize / 60);
      
      if (catchesPerMinute > CONFIG.CATCH_LIMITS.MAX_PER_MINUTE * 2) {
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
      } else if (catchesPerMinute > CONFIG.CATCH_LIMITS.MAX_PER_MINUTE) {
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
      
      // 1. 检测完美直线移动
      const straightness = calculateStraightness(locationEvents);
      if (straightness > 0.95) {
        spoofIndicators.push({
          type: 'perfect_straight_line',
          value: straightness,
          description: '移动轨迹过于平直'
        });
      }
      
      // 2. 检测海拔异常
      const altitudeVariance = calculateAltitudeVariance(locationEvents);
      if (altitudeVariance > 1000) {
        spoofIndicators.push({
          type: 'altitude_anomaly',
          value: altitudeVariance,
          description: '海拔变化异常'
        });
      }
      
      // 3. 检测精度异常
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
      
      if (itemsPerMinute > CONFIG.ITEM_LIMITS.MAX_PER_MINUTE * 2) {
        return {
          rule_id: 'ITEM_USAGE_001',
          matched: true,
          severity: 'high',
          score: 85,
          details: { totalItems: itemEvents.length, itemsPerMinute: itemsPerMinute.toFixed(2) },
          message: `道具使用异常：${itemsPerMinute.toFixed(2)} 次/分钟`
        };
      } else if (itemsPerMinute > CONFIG.ITEM_LIMITS.MAX_PER_MINUTE) {
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
      
      const deviceList = Array.from(devices.entries());
      let overlappingDevices = 0;
      
      for (let i = 0; i < deviceList.length; i++) {
        for (let j = i + 1; j < deviceList.length; j++) {
          const [, data1] = deviceList[i];
          const [, data2] = deviceList[j];
          
          const times1 = data1.timestamps.sort();
          const times2 = data2.timestamps.sort();
          
          if (times1.length > 0 && times2.length > 0) {
            const overlap = hasTimeOverlap(times1, times2, 300000);
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
      
      // 2. 交易对象单一
      const tradePartners = new Set(tradeEvents.map(e => e.details?.partner_id).filter(Boolean));
      if (tradePartners.size === 1 && tradeEvents.length > 10) {
        anomalies.push({
          type: 'single_partner',
          partnerId: Array.from(tradePartners)[0],
          count: tradeEvents.length,
          description: '交易对象单一'
        });
      }
      
      // 3. 不对等交易
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

module.exports = {
  ANTI_CHEAT_RULES
};