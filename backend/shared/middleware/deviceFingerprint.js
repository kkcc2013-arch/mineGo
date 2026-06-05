/**
 * REQ-00028: 设备指纹中间件
 * 自动收集和处理设备指纹
 * 
 * 创建时间: 2026-06-05 21:28
 */

'use strict';

const crypto = require('crypto');
const logger = require('../logger');

/**
 * 设备指纹配置
 */
const FINGERPRINT_CONFIG = {
  requiredHeaders: ['x-device-id'],
  optionalHeaders: [
    'user-agent',
    'x-screen-width',
    'x-screen-height',
    'x-timezone',
    'accept-language',
    'x-platform',
    'x-os-version',
    'x-app-version',
  ],
};

/**
 * 收集设备指纹
 */
function collectFingerprint(req) {
  const fingerprint = {
    deviceId: req.headers['x-device-id'] || null,
    userAgent: req.headers['user-agent'] || null,
    screenWidth: parseInt(req.headers['x-screen-width']) || null,
    screenHeight: parseInt(req.headers['x-screen-height']) || null,
    timezone: req.headers['x-timezone'] || 'UTC',
    language: req.headers['accept-language'] || null,
    platform: req.headers['x-platform'] || null,
    osVersion: req.headers['x-os-version'] || null,
    appVersion: req.headers['x-app-version'] || null,
    ipHash: hashIP(req.ip),
  };
  
  return fingerprint;
}

/**
 * 生成设备哈希
 */
function generateDeviceHash(fingerprint) {
  if (!fingerprint.deviceId) return null;
  
  const data = [
    fingerprint.deviceId,
    fingerprint.platform || '',
    `${fingerprint.screenWidth || 0}x${fingerprint.screenHeight || 0}`,
  ].join('|');
  
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex')
    .substring(0, 16);
}

/**
 * 哈希 IP 地址
 */
function hashIP(ip) {
  if (!ip) return null;
  
  return crypto
    .createHash('sha256')
    .update(ip)
    .digest('hex')
    .substring(0, 16);
}

/**
 * 设备指纹中间件
 * 自动收集并验证设备指纹
 */
function deviceFingerprintMiddleware(req, res, next) {
  // 跳过不需要指纹的路径
  const skipPaths = ['/health', '/metrics', '/favicon.ico'];
  if (skipPaths.some(p => req.path.startsWith(p))) {
    return next();
  }
  
  // 收集指纹
  const fingerprint = collectFingerprint(req);
  const deviceHash = generateDeviceHash(fingerprint);
  
  // 添加到请求对象
  req.deviceFingerprint = fingerprint;
  req.deviceHash = deviceHash;
  
  // 添加到响应 locals
  res.locals.deviceHash = deviceHash;
  
  // 验证必需字段（仅对需要认证的路由）
  if (req.user && !deviceHash) {
    logger.warn({ 
      userId: req.user.id,
      path: req.path,
    }, 'Missing device fingerprint for authenticated request');
    
    // 可以选择记录或标记
    req.deviceFingerprintIncomplete = true;
  }
  
  next();
}

/**
 * 设备指纹记录中间件
 * 在请求完成后记录设备指纹
 */
function deviceFingerprintRecorder(db) {
  return async (req, res, next) => {
    // 仅对认证用户记录
    if (!req.user || !req.deviceHash) {
      return next();
    }
    
    // 保存原始 end 方法
    const originalEnd = res.end;
    
    // 重写 end 方法
    res.end = function(...args) {
      // 异步记录设备指纹
      recordDeviceFingerprint(req, db).catch(err => {
        logger.error({ err }, 'Failed to record device fingerprint');
      });
      
      // 调用原始 end
      originalEnd.apply(this, args);
    };
    
    next();
  };
}

/**
 * 记录设备指纹到数据库
 */
async function recordDeviceFingerprint(req, db) {
  const { query } = db;
  const userId = req.user.id;
  const deviceHash = req.deviceHash;
  const fingerprint = req.deviceFingerprint;
  
  try {
    await query(`
      INSERT INTO device_fingerprints (
        user_id, device_hash, device_info, ip_hash, last_seen
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, device_hash)
      DO UPDATE SET
        device_info = EXCLUDED.device_info,
        ip_hash = EXCLUDED.ip_hash,
        last_seen = NOW()
    `, [
      userId,
      deviceHash,
      JSON.stringify({
        userAgent: fingerprint.userAgent,
        screenWidth: fingerprint.screenWidth,
        screenHeight: fingerprint.screenHeight,
        timezone: fingerprint.timezone,
        language: fingerprint.language,
        platform: fingerprint.platform,
        osVersion: fingerprint.osVersion,
        appVersion: fingerprint.appVersion,
      }),
      fingerprint.ipHash,
    ]);
  } catch (err) {
    logger.error({ err, userId, deviceHash }, 'Failed to upsert device fingerprint');
    throw err;
  }
}

/**
 * 行为事件记录中间件
 * 自动记录用户行为事件
 */
function actionRecorder(db) {
  return async (req, res, next) => {
    // 仅对认证用户记录
    if (!req.user) {
      return next();
    }
    
    // 保存原始 end 方法
    const originalEnd = res.end;
    
    // 重写 end 方法
    res.end = function(...args) {
      // 异步记录行为事件
      recordActionEvent(req, res, db).catch(err => {
        logger.error({ err }, 'Failed to record action event');
      });
      
      // 调用原始 end
      originalEnd.apply(this, args);
    };
    
    next();
  };
}

/**
 * 记录行为事件到数据库
 */
async function recordActionEvent(req, res, db) {
  const { query } = db;
  const userId = req.user.id;
  
  // 提取行为类型
  const actionType = extractActionType(req);
  
  if (!actionType) return;
  
  try {
    await query(`
      INSERT INTO user_action_events (
        user_id, action_type, action_data,
        latitude, longitude, device_hash, ip_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      userId,
      actionType,
      JSON.stringify({
        method: req.method,
        path: req.path,
        query: req.query,
      }),
      req.body?.latitude || null,
      req.body?.longitude || null,
      req.deviceHash || null,
      req.deviceFingerprint?.ipHash || null,
    ]);
  } catch (err) {
    logger.error({ err, userId, actionType }, 'Failed to insert action event');
    throw err;
  }
}

/**
 * 从请求中提取行为类型
 */
function extractActionType(req) {
  const path = req.path;
  const method = req.method;
  
  // 捕捉相关
  if (path.includes('/catch')) return 'CATCH';
  if (path.includes('/throw')) return 'THROW';
  
  // 战斗相关
  if (path.includes('/battle') || path.includes('/raid')) return 'BATTLE';
  if (path.includes('/gym')) return 'GYM';
  
  // 社交相关
  if (path.includes('/trade')) return 'TRADE';
  if (path.includes('/gift')) return 'GIFT';
  if (path.includes('/friend')) return 'FRIEND';
  
  // 奖励相关
  if (path.includes('/reward') || path.includes('/claim')) return 'CLAIM_REWARD';
  if (path.includes('/daily')) return 'DAILY';
  
  // 支付相关
  if (path.includes('/payment') || path.includes('/purchase')) return 'PURCHASE';
  
  // 其他
  if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
    return 'API_CALL';
  }
  
  return null;
}

/**
 * 捕捉尝试记录器
 * 用于捕捉服务调用
 */
async function recordCatchAttempt(db, data) {
  const { query } = db;
  
  const {
    userId,
    pokemonId,
    pokemonRarity,
    success,
    playerLevel,
    itemsUsed,
    technique,
    latitude,
    longitude,
  } = data;
  
  // 计算期望捕获率
  const behaviorAnalyzer = require('../behaviorAnalyzer');
  const expectedRate = behaviorAnalyzer.calculateExpectedCatchRate(
    pokemonRarity,
    playerLevel,
    itemsUsed,
    technique
  );
  
  try {
    await query(`
      INSERT INTO catch_attempts (
        user_id, pokemon_id, pokemon_rarity, success,
        expected_rate, actual_items_used, technique,
        latitude, longitude
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      userId,
      pokemonId,
      pokemonRarity,
      success,
      expectedRate,
      JSON.stringify(itemsUsed || []),
      technique || null,
      latitude || null,
      longitude || null,
    ]);
    
    return expectedRate;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to record catch attempt');
    throw err;
  }
}

module.exports = {
  collectFingerprint,
  generateDeviceHash,
  hashIP,
  deviceFingerprintMiddleware,
  deviceFingerprintRecorder,
  actionRecorder,
  recordCatchAttempt,
  extractActionType,
};
