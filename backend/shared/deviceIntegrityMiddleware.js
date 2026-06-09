/**
 * REQ-00045: 设备完整性检测中间件
 * 
 * 创建时间: 2026-06-09 07:00
 */

'use strict';

const deviceIntegrity = require('./deviceIntegrity');
const { createLogger } = require('./logger');

const logger = createLogger('device-integrity-middleware');

/**
 * 设备完整性检查中间件
 * 在请求处理前验证设备安全性
 */
function deviceIntegrityCheck(options = {}) {
  const {
    blockOnFailure = false, // 检测失败时是否阻止请求
    strictMode = false, // 严格模式（不允许未知设备）
    skipPaths = ['/health', '/metrics', '/api/auth/login', '/api/auth/register'],
  } = options;
  
  return async (req, res, next) => {
    // 跳过特定路径
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }
    
    // 获取设备信息（客户端通过 Header 上报）
    const deviceInfoHeader = req.headers['x-device-info'];
    
    if (!deviceInfoHeader) {
      // 旧版本客户端，没有设备信息
      if (strictMode) {
        return res.status(403).json({
          code: 7001,
          message: '您的客户端版本过低，请更新到最新版本',
          data: { action: 'UPDATE_REQUIRED' }
        });
      }
      
      // 非严格模式下允许通过
      req.deviceTrustLevel = 'UNKNOWN';
      req.deviceRestrictions = [];
      return next();
    }
    
    try {
      // 解析设备信息
      const deviceInfo = JSON.parse(Buffer.from(deviceInfoHeader, 'base64').toString('utf-8'));
      const userId = req.user?.sub;
      
      // 执行设备检测
      const result = await deviceIntegrity.registerDevice(deviceInfo, userId);
      
      // 设置请求属性
      req.deviceId = result.device_id;
      req.deviceRiskScore = result.risk_score;
      req.deviceTrustLevel = result.trust_level;
      req.deviceRestrictions = result.restrictions;
      req.deviceDetectionResults = result.detection_results;
      
      // 处理阻止策略
      if (result.action === 'BLOCK') {
        logger.warn({ 
          deviceId: result.device_id, 
          riskScore: result.risk_score,
          userId 
        }, 'Device blocked by integrity check');
        
        return res.status(403).json({
          code: 7002,
          message: result.message || '您的设备存在安全风险，无法访问',
          data: {
            risk_score: result.risk_score,
            trust_level: result.trust_level,
            action: 'CONTACT_SUPPORT'
          }
        });
      }
      
      // 设置响应头警告
      if (result.message) {
        res.setHeader('X-Device-Warning', result.message);
      }
      
      if (result.action === 'MONITOR' || result.action === 'RESTRICT') {
        res.setHeader('X-Device-Trust-Level', result.trust_level);
        res.setHeader('X-Device-Risk-Score', result.risk_score.toString());
      }
      
      next();
    } catch (err) {
      logger.error({ err, path: req.path }, 'Device integrity check failed');
      
      if (blockOnFailure) {
        return res.status(500).json({
          code: 7003,
          message: '设备验证失败，请稍后重试',
          data: { error: 'INTEGRITY_CHECK_FAILED' }
        });
      }
      
      // 失败时允许通过，避免影响正常用户
      req.deviceTrustLevel = 'UNKNOWN';
      req.deviceRestrictions = [];
      next();
    }
  };
}

/**
 * 设备限制检查中间件
 * 检查设备是否有特定功能限制
 * @param {string} restriction - 限制类型
 */
function checkDeviceRestriction(restriction) {
  return async (req, res, next) => {
    const restrictions = req.deviceRestrictions || [];
    
    // 检查是否有全局限制
    if (restrictions.includes('ALL')) {
      return res.status(403).json({
        code: 7004,
        message: '您的设备存在安全风险，所有功能受限',
        data: { restriction: 'ALL' }
      });
    }
    
    // 检查特定限制
    if (restrictions.includes(restriction)) {
      logger.info({
        deviceId: req.deviceId,
        userId: req.user?.sub,
        restriction
      }, 'Device restriction triggered');
      
      const messages = {
        NO_TRADING: '您的设备存在安全风险，交易功能不可用',
        NO_TRANSFER: '您的设备存在安全风险，精灵转移功能不可用',
        LIMITED_CATCH_RATE: '您的设备存在安全风险，捕捉成功率已调整',
      };
      
      return res.status(403).json({
        code: 7005,
        message: messages[restriction] || '您的设备存在安全风险，该功能受限',
        data: { restriction }
      });
    }
    
    next();
  };
}

/**
 * 可信设备要求中间件
 * 要求设备信任等级达到指定级别
 * @param {string} minTrustLevel - 最低信任等级（HIGH/MEDIUM/LOW）
 */
function requireDeviceTrust(minTrustLevel) {
  const trustLevels = { HIGH: 3, MEDIUM: 2, LOW: 1, BANNED: 0, UNKNOWN: 0 };
  
  return async (req, res, next) => {
    const currentLevel = req.deviceTrustLevel || 'UNKNOWN';
    const requiredLevel = trustLevels[minTrustLevel] || 0;
    const actualLevel = trustLevels[currentLevel] || 0;
    
    if (actualLevel < requiredLevel) {
      return res.status(403).json({
        code: 7006,
        message: `您的设备信任等级不足（当前：${currentLevel}，需要：${minTrustLevel}）`,
        data: {
          current_level: currentLevel,
          required_level: minTrustLevel
        }
      });
    }
    
    next();
  };
}

/**
 * 低风险设备要求中间件
 * 要求设备风险评分低于阈值
 * @param {number} maxRiskScore - 最大允许的风险评分
 */
function requireLowRiskDevice(maxRiskScore = 30) {
  return async (req, res, next) => {
    const riskScore = req.deviceRiskScore || 0;
    
    if (riskScore > maxRiskScore) {
      return res.status(403).json({
        code: 7007,
        message: `您的设备风险评分过高（当前：${riskScore}，最大允许：${maxRiskScore}）`,
        data: {
          risk_score: riskScore,
          max_allowed: maxRiskScore
        }
      });
    }
    
    next();
  };
}

/**
 * 设备信息提取中间件
 * 从请求中提取设备信息并附加到请求对象
 */
function extractDeviceInfo() {
  return async (req, res, next) => {
    const deviceInfoHeader = req.headers['x-device-info'];
    
    if (deviceInfoHeader) {
      try {
        req.deviceInfo = JSON.parse(Buffer.from(deviceInfoHeader, 'base64').toString('utf-8'));
      } catch (err) {
        logger.warn({ err }, 'Failed to parse device info header');
      }
    }
    
    next();
  };
}

/**
 * 设备日志中间件
 * 记录设备相关的请求日志
 */
function logDeviceActivity() {
  return async (req, res, next) => {
    if (req.deviceId && req.user?.sub) {
      logger.info({
        deviceId: req.deviceId,
        userId: req.user.sub,
        trustLevel: req.deviceTrustLevel,
        riskScore: req.deviceRiskScore,
        path: req.path,
        method: req.method,
      }, 'Device activity logged');
    }
    
    next();
  };
}

module.exports = {
  deviceIntegrityCheck,
  checkDeviceRestriction,
  requireDeviceTrust,
  requireLowRiskDevice,
  extractDeviceInfo,
  logDeviceActivity,
};