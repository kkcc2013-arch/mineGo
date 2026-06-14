// shared/errorCodes.js - 统一错误码定义
'use strict';

/**
 * 错误码定义（标准化）
 * 格式：{服务}_{模块}_{错误类型}
 * 
 * 错误码范围：
 * - 1xxx: 通用错误
 * - 2xxx: 用户服务
 * - 3xxx: 精灵服务
 * - 4xxx: 捕捉服务
 * - 5xxx: 道馆服务
 * - 6xxx: 社交服务
 * - 7xxx: 支付服务
 * - 8xxx: 奖励服务
 * - 9xxx: GPS 反作弊
 * - 10xxx: GDPR 合规
 * - 11xxx: 位置服务
 * - 12xxx: 网关错误
 */
const ERROR_CODES = {
  // ── 通用错误 (1xxx) ─────────────────────────────────────────
  UNKNOWN_ERROR: { code: 1000, httpStatus: 500, category: 'general' },
  INVALID_REQUEST: { code: 1001, httpStatus: 400, category: 'general' },
  UNAUTHORIZED: { code: 1002, httpStatus: 401, category: 'general' },
  FORBIDDEN: { code: 1003, httpStatus: 403, category: 'general' },
  NOT_FOUND: { code: 1004, httpStatus: 404, category: 'general' },
  RATE_LIMITED: { code: 1005, httpStatus: 429, category: 'general' },
  INTERNAL_ERROR: { code: 1006, httpStatus: 500, category: 'general' },
  SERVICE_UNAVAILABLE: { code: 1007, httpStatus: 503, category: 'general' },
  VALIDATION_ERROR: { code: 1008, httpStatus: 400, category: 'general' },
  CONFLICT: { code: 1009, httpStatus: 409, category: 'general' },
  
  // ── 用户服务 (2xxx) ─────────────────────────────────────────
  USER_NOT_FOUND: { code: 2001, httpStatus: 404, category: 'user' },
  USER_ALREADY_EXISTS: { code: 2002, httpStatus: 409, category: 'user' },
  INVALID_CREDENTIALS: { code: 2003, httpStatus: 401, category: 'user' },
  EMAIL_NOT_VERIFIED: { code: 2004, httpStatus: 403, category: 'user' },
  ACCOUNT_SUSPENDED: { code: 2005, httpStatus: 403, category: 'user' },
  PHONE_NOT_VERIFIED: { code: 2006, httpStatus: 403, category: 'user' },
  INVALID_VERIFICATION_CODE: { code: 2007, httpStatus: 400, category: 'user' },
  PASSWORD_TOO_WEAK: { code: 2008, httpStatus: 400, category: 'user' },
  PROFILE_UPDATE_FAILED: { code: 2009, httpStatus: 500, category: 'user' },
  MFA_REQUIRED: { code: 2010, httpStatus: 403, category: 'user' },
  MFA_INVALID_CODE: { code: 2011, httpStatus: 400, category: 'user' },
  SESSION_EXPIRED: { code: 2012, httpStatus: 401, category: 'user' },
  
  // ── 精灵服务 (3xxx) ─────────────────────────────────────────
  POKEMON_NOT_FOUND: { code: 3001, httpStatus: 404, category: 'pokemon' },
  POKEMON_ALREADY_CAUGHT: { code: 3002, httpStatus: 409, category: 'pokemon' },
  INSUFFICIENT_RESOURCES: { code: 3003, httpStatus: 400, category: 'pokemon' },
  POKEMON_EVOLUTION_FAILED: { code: 3004, httpStatus: 500, category: 'pokemon' },
  POKEMON_TRANSFER_FAILED: { code: 3005, httpStatus: 500, category: 'pokemon' },
  POKEMON_FAVORITE_FAILED: { code: 3006, httpStatus: 500, category: 'pokemon' },
  POKEMON_POWER_UP_FAILED: { code: 3007, httpStatus: 500, category: 'pokemon' },
  POKEMON_NOT_ELIGIBLE: { code: 3008, httpStatus: 400, category: 'pokemon' },
  BAG_FULL: { code: 3009, httpStatus: 400, category: 'pokemon' },
  ITEM_NOT_FOUND: { code: 3010, httpStatus: 404, category: 'pokemon' },
  
  // ── 捕捉服务 (4xxx) ─────────────────────────────────────────
  CATCH_FAILED: { code: 4001, httpStatus: 500, category: 'catch' },
  CATCH_COOLDOWN: { code: 4002, httpStatus: 429, category: 'catch' },
  INVALID_THROW: { code: 4003, httpStatus: 400, category: 'catch' },
  NO_POKEBALLS: { code: 4004, httpStatus: 400, category: 'catch' },
  POKEMON_TOO_FAR: { code: 4005, httpStatus: 400, category: 'catch' },
  CATCH_SESSION_EXPIRED: { code: 4006, httpStatus: 410, category: 'catch' },
  
  // ── 道馆服务 (5xxx) ─────────────────────────────────────────
  GYM_NOT_FOUND: { code: 5001, httpStatus: 404, category: 'gym' },
  GYM_BATTLE_FAILED: { code: 5002, httpStatus: 500, category: 'gym' },
  GYM_COOLDOWN: { code: 5003, httpStatus: 429, category: 'gym' },
  GYM_ALREADY_DEFENDED: { code: 5004, httpStatus: 409, category: 'gym' },
  GYM_TEAM_MISMATCH: { code: 5005, httpStatus: 403, category: 'gym' },
  GYM_NOT_ELIGIBLE: { code: 5006, httpStatus: 400, category: 'gym' },
  RAID_NOT_FOUND: { code: 5007, httpStatus: 404, category: 'gym' },
  RAID_NOT_ACTIVE: { code: 5008, httpStatus: 400, category: 'gym' },
  RAID_LOBBY_FULL: { code: 5009, httpStatus: 403, category: 'gym' },
  
  // ── 社交服务 (6xxx) ─────────────────────────────────────────
  FRIEND_ALREADY_EXISTS: { code: 6001, httpStatus: 409, category: 'social' },
  FRIEND_LIMIT_REACHED: { code: 6002, httpStatus: 403, category: 'social' },
  TRADE_NOT_ALLOWED: { code: 6003, httpStatus: 403, category: 'social' },
  FRIEND_REQUEST_NOT_FOUND: { code: 6004, httpStatus: 404, category: 'social' },
  TRADE_ALREADY_PENDING: { code: 6005, httpStatus: 409, category: 'social' },
  GIFT_NOT_FOUND: { code: 6006, httpStatus: 404, category: 'social' },
  GIFT_ALREADY_OPENED: { code: 6007, httpStatus: 409, category: 'social' },
  NICKNAME_INVALID: { code: 6008, httpStatus: 400, category: 'social' },
  
  // ── 支付服务 (7xxx) ─────────────────────────────────────────
  PAYMENT_FAILED: { code: 7001, httpStatus: 500, category: 'payment' },
  INSUFFICIENT_BALANCE: { code: 7002, httpStatus: 400, category: 'payment' },
  PAYMENT_TIMEOUT: { code: 7003, httpStatus: 408, category: 'payment' },
  PAYMENT_CANCELLED: { code: 7004, httpStatus: 400, category: 'payment' },
  PAYMENT_ALREADY_PROCESSED: { code: 7005, httpStatus: 409, category: 'payment' },
  REFUND_NOT_ALLOWED: { code: 7006, httpStatus: 403, category: 'payment' },
  SUBSCRIPTION_NOT_FOUND: { code: 7007, httpStatus: 404, category: 'payment' },
  
  // ── 奖励服务 (8xxx) ─────────────────────────────────────────
  REWARD_NOT_FOUND: { code: 8001, httpStatus: 404, category: 'reward' },
  REWARD_ALREADY_CLAIMED: { code: 8002, httpStatus: 409, category: 'reward' },
  QUEST_NOT_FOUND: { code: 8003, httpStatus: 404, category: 'reward' },
  QUEST_NOT_COMPLETE: { code: 8004, httpStatus: 400, category: 'reward' },
  ACHIEVEMENT_NOT_FOUND: { code: 8005, httpStatus: 404, category: 'reward' },
  ACHIEVEMENT_ALREADY_CLAIMED: { code: 8006, httpStatus: 409, category: 'reward' },
  EVENT_NOT_FOUND: { code: 8007, httpStatus: 404, category: 'reward' },
  EVENT_NOT_ACTIVE: { code: 8008, httpStatus: 400, category: 'reward' },
  
  // ── GPS 反作弊 (9xxx) ─────────────────────────────────────────
  GPS_SPOOFING_DETECTED: { code: 9001, httpStatus: 403, category: 'anticheat' },
  SPEED_LIMIT_EXCEEDED: { code: 9002, httpStatus: 403, category: 'anticheat' },
  LOCATION_INVALID: { code: 9003, httpStatus: 400, category: 'anticheat' },
  TELEPORT_DETECTED: { code: 9004, httpStatus: 403, category: 'anticheat' },
  EMULATOR_DETECTED: { code: 9005, httpStatus: 403, category: 'anticheat' },
  ROOT_DETECTED: { code: 9006, httpStatus: 403, category: 'anticheat' },
  MACRO_DETECTED: { code: 9007, httpStatus: 403, category: 'anticheat' },
  
  // ── GDPR 合规 (10xxx) ─────────────────────────────────────────
  PRIVACY_POLICY_NOT_FOUND: { code: 10001, httpStatus: 404, category: 'privacy' },
  CONSENT_REQUIRED: { code: 10002, httpStatus: 403, category: 'privacy' },
  DATA_EXPORT_FAILED: { code: 10003, httpStatus: 500, category: 'privacy' },
  DATA_DELETION_FAILED: { code: 10004, httpStatus: 500, category: 'privacy' },
  CONSENT_WITHDRAWN: { code: 10005, httpStatus: 403, category: 'privacy' },
  
  // ── 位置服务 (11xxx) ─────────────────────────────────────────
  LOCATION_SERVICE_UNAVAILABLE: { code: 11001, httpStatus: 503, category: 'location' },
  SPAWN_NOT_FOUND: { code: 11002, httpStatus: 404, category: 'location' },
  POKESTOP_NOT_FOUND: { code: 11003, httpStatus: 404, category: 'location' },
  POKESTOP_COOLDOWN: { code: 11004, httpStatus: 429, category: 'location' },
  WEATHER_UNAVAILABLE: { code: 11005, httpStatus: 503, category: 'location' },
  
  // ── 网关错误 (12xxx) ─────────────────────────────────────────
  GATEWAY_TIMEOUT: { code: 12001, httpStatus: 504, category: 'gateway' },
  SERVICE_CONNECTION_FAILED: { code: 12002, httpStatus: 503, category: 'gateway' },
  CIRCUIT_BREAKER_OPEN: { code: 12003, httpStatus: 503, category: 'gateway' },
  RATE_LIMIT_EXCEEDED: { code: 12004, httpStatus: 429, category: 'gateway' }
};

/**
 * 错误码反向映射（通过数字代码查找错误码名称）
 */
const ERROR_CODE_MAP = {};
for (const [name, def] of Object.entries(ERROR_CODES)) {
  ERROR_CODE_MAP[def.code] = name;
}

/**
 * 获取错误码定义
 * @param {string} errorCode - 错误码名称
 * @returns {Object} 错误码定义
 */
function getErrorDefinition(errorCode) {
  return ERROR_CODES[errorCode] || ERROR_CODES.UNKNOWN_ERROR;
}

/**
 * 通过数字代码获取错误码名称
 * @param {number} code - 数字错误码
 * @returns {string} 错误码名称
 */
function getErrorCodeName(code) {
  return ERROR_CODE_MAP[code] || 'UNKNOWN_ERROR';
}

/**
 * 获取所有错误码（用于文档生成）
 * @returns {Object} 所有错误码定义
 */
function getAllErrorCodes() {
  return { ...ERROR_CODES };
}

/**
 * 按类别获取错误码
 * @param {string} category - 类别名称
 * @returns {Object} 该类别的错误码
 */
function getErrorCodesByCategory(category) {
  const result = {};
  for (const [name, def] of Object.entries(ERROR_CODES)) {
    if (def.category === category) {
      result[name] = def;
    }
  }
  return result;
}

module.exports = {
  ERROR_CODES,
  ERROR_CODE_MAP,
  getErrorDefinition,
  getErrorCodeName,
  getAllErrorCodes,
  getErrorCodesByCategory
};
