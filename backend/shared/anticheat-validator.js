/**
 * REQ-00399: 反作弊验证器
 * 提供请求验证功能，防止作弊行为
 */

const logger = require('./logger');

// 配置
const CONFIG = {
  maxCatchDistance: 1000, // 最大捕捉距离（米）
  maxBattleDistance: 500, // 最大战斗距离（米）
  maxSpeed: 100, // 最大速度（米/秒）
  teleportThreshold: 500, // 瞬移阈值（米）
  timeWindow: 60, // 时间窗口（秒）
};

/**
 * 验证捕捉请求
 * 
 * @param {Object} request - 捕捉请求
 * @param {Object} context - 请求上下文
 * @returns {Object} 验证结果
 */
function validateCatchRequest(request, context = {}) {
  const errors = [];
  const warnings = [];
  
  try {
    // 验证必需字段
    if (!request.pokemonId) {
      errors.push('Missing pokemonId');
    }
    
    if (!request.location) {
      errors.push('Missing location');
    } else {
      // 验证坐标
      const { lat, lng } = request.location;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        errors.push('Invalid location coordinates');
      } else if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        errors.push('Location coordinates out of range');
      }
      
      // 检查距离（如果有用户位置）
      if (context.userLocation) {
        const distance = calculateDistance(
          request.location,
          context.userLocation
        );
        if (distance > CONFIG.maxCatchDistance) {
          warnings.push(`Catch distance exceeds threshold: ${distance}m`);
        }
      }
    }
    
    // 检查速度
    if (context.speed && context.speed > CONFIG.maxSpeed) {
      warnings.push(`Movement speed suspicious: ${context.speed}m/s`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error({
      module: 'anticheat-validator',
      msg: 'Failed to validate catch request',
      error: error.message
    });
    return {
      valid: false,
      errors: ['Validation error'],
      warnings: [],
      timestamp: Date.now()
    };
  }
}

/**
 * 验证战斗请求
 * 
 * @param {Object} request - 战斗请求
 * @param {Object} context - 请求上下文
 * @returns {Object} 验证结果
 */
function validateBattleRequest(request, context = {}) {
  const errors = [];
  const warnings = [];
  
  try {
    // 验证必需字段
    if (!request.battleId) {
      errors.push('Missing battleId');
    }
    
    if (!request.pokemonId) {
      errors.push('Missing pokemonId');
    }
    
    // 验证战斗位置
    if (request.location) {
      const { lat, lng } = request.location;
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        errors.push('Invalid location coordinates');
      }
      
      // 检查与用户位置的距离
      if (context.userLocation) {
        const distance = calculateDistance(
          request.location,
          context.userLocation
        );
        if (distance > CONFIG.maxBattleDistance) {
          warnings.push(`Battle distance exceeds threshold: ${distance}m`);
        }
      }
    }
    
    // 检查战斗状态
    if (request.action && !['attack', 'defend', 'flee', 'item'].includes(request.action)) {
      errors.push('Invalid battle action');
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error({
      module: 'anticheat-validator',
      msg: 'Failed to validate battle request',
      error: error.message
    });
    return {
      valid: false,
      errors: ['Validation error'],
      warnings: [],
      timestamp: Date.now()
    };
  }
}

/**
 * 计算两点之间的距离（Haversine公式）
 */
function calculateDistance(point1, point2) {
  const R = 6371000; // 地球半径（米）
  const lat1 = point1.lat * Math.PI / 180;
  const lat2 = point2.lat * Math.PI / 180;
  const deltaLat = (point2.lat - point1.lat) * Math.PI / 180;
  const deltaLng = (point2.lng - point1.lng) * Math.PI / 180;
  
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return R * c;
}

/**
 * 检测瞬移行为
 */
function detectTeleport(locations) {
  if (locations.length < 2) return false;
  
  for (let i = 1; i < locations.length; i++) {
    const distance = calculateDistance(locations[i - 1], locations[i]);
    const timeDiff = (locations[i].timestamp - locations[i - 1].timestamp) / 1000;
    
    if (timeDiff > 0) {
      const speed = distance / timeDiff;
      if (distance > CONFIG.teleportThreshold && speed > CONFIG.maxSpeed) {
        return true;
      }
    }
  }
  
  return false;
}

module.exports = {
  validateCatchRequest,
  validateBattleRequest,
  calculateDistance,
  detectTeleport,
  CONFIG
};
