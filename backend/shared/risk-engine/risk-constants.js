// backend/shared/risk-engine/risk-constants.js - 风控引擎配置常量
'use strict';

/**
 * 风控引擎配置常量
 * 包含阈值、窗口配置、Kafka配置等
 */

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
  
  // 滑动窗口配置（秒）
  WINDOWS: {
    MINUTE: 60,
    HOUR: 3600,
    DAY: 86400
  },
  
  // Kafka 配置
  KAFKA_TOPIC: 'game-behavior-events',
  KAFKA_GROUP: 'risk-control-engine',
  
  // 速度阈值（米/秒）
  SPEED_LIMITS: {
    WALKING: 5,      // 步行最大 5 m/s (18 km/h)
    CYCLING: 15,     // 骑行最大 15 m/s (54 km/h)
    DRIVING: 50,     // 驾车最大 50 m/s (180 km/h)
    TELEPORT: 200    // 瞬移阈值
  },
  
  // 捕捉频率阈值
  CATCH_LIMITS: {
    MAX_PER_MINUTE: 30,
    MAX_PER_HOUR: 500
  },
  
  // 道具使用阈值
  ITEM_LIMITS: {
    MAX_PER_MINUTE: 60
  }
};

module.exports = {
  CONFIG
};