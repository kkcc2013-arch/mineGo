// gateway/src/middleware/client-integrity.js
// REQ-00483: 客户端完整性验证与运行环境检测中间件

'use strict';

const { createLogger } = require('../../shared/logger');
const { getRedis, setJSON, getJSON } = require('../../shared/redis');
const crypto = require('crypto');

const logger = createLogger('client-integrity');

/**
 * 客户端完整性验证中间件
 */
class ClientIntegrityMiddleware {
  constructor() {
    this.redis = getRedis();
    
    // 客户端签名密钥（从环境变量读取）
    this.signingKey = process.env.CLIENT_SIGNING_KEY || 
      crypto.randomBytes(32).toString('hex');
    
    // 挑战超时时间（秒）
    this.challengeTimeout = 5000;
    
    // 验证失败阈值
    this.maxFailedAttempts = 5;
    
    // 核心函数哈希表（预编译）
    this.criticalFunctionHashes = {
      'calculateCaptureProbability': 'a1b2c3d4e5f6g7h8i9j0',
      'processPokemonData': 'b2c3d4e5f6g7h8i9j0k1',
      'validateLocation': 'c3d4e5f6g7h8i9j0k1l2',
      'encryptPayload': 'd4e5f6g7h8i9j0k1l2m3'
    };
  }

  /**
   * 获取完整性验证中间件
   */
  getMiddleware() {
    return async (req, res, next) => {
      return this.handle(req, res, next);
    };
  }

  /**
   * 主处理器
   */
  async handle(req, res, next) {
    const userId = req.user?.sub;
    const requestId = req.headers['x-request-id'];
    const clientSignature = req.headers['x-client-signature'];
    const clientVersion = req.headers['x-client-version'];
    
    // 获取设备指纹
    const deviceFingerprint = this._extractDeviceFingerprint(req);
    
    try {
      // 1. 验证客户端签名
      const signatureValid = await this._verifyClientSignature(
        clientSignature, 
        requestId,
        clientVersion
      );
      
      if (!signatureValid.valid) {
        logger.warn({ userId, reason: signatureValid.reason }, 
          'Client signature validation failed');
        
        // 记录失败尝试
        await this._recordFailedAttempt(userId, deviceFingerprint);
        
        return res.status(403).json({
          success: false,
          error: {
            code: 'CLIENT_SIGNATURE_INVALID',
            message: '客户端签名验证失败',
            reason: signatureValid.reason
          }
        });
      }
      
      // 2. 检查客户端环境（Root/越狱、模拟器、注入框架）
      const environmentData = req.body._environment || {};
      const environmentRisk = await this._assessEnvironmentRisk(
        userId,
        environmentData,
        deviceFingerprint
      );
      
      // 3. 计算综合风险评分
      const riskScore = this._calculateIntegrityRiskScore(
        signatureValid,
        environmentRisk,
        deviceFingerprint
      );
      
      // 4. 根据风险等级决定是否需要挑战-响应验证
      if (riskScore >= 50) {
        logger.warn({ userId, riskScore }, 
          'High integrity risk detected, requiring challenge');
        
        // 发送挑战
        const challenge = await this._generateChallenge(userId, riskScore);
        
        return res.status(202).json({
          success: false,
          requiresChallenge: true,
          challenge: challenge,
          riskScore: riskScore
        });
      }
      
      // 5. 验证通过，附加完整性信息到请求
      req.clientIntegrity = {
        verified: true,
        signatureValid: signatureValid.valid,
        environmentRisk: environmentRisk.level,
        riskScore: riskScore,
        deviceFingerprint: deviceFingerprint,
        verifiedAt: new Date().toISOString()
      };
      
      // 6. 缓存验证结果
      await this._cacheVerificationResult(userId, deviceFingerprint, req.clientIntegrity);
      
      next();
      
    } catch (error) {
      logger.error({ userId, error: error.message }, 
        'Client integrity verification failed');
      
      // 发生错误时允许请求通过，但标记为未验证
      req.clientIntegrity = {
        verified: false,
        reason: 'verification_error'
      };
      
      next();
    }
  }

  /**
   * 验证客户端签名
   */
  async _verifyClientSignature(signature, requestId, version) {
    if (!signature || !requestId) {
      return {
        valid: false,
        reason: 'missing_signature_or_request_id'
      };
    }
    
    // 检查版本是否在允许范围内
    const allowedVersions = process.env.ALLOWED_CLIENT_VERSIONS?.split(',') || ['1.0.0'];
    if (!allowedVersions.includes(version)) {
      return {
        valid: false,
        reason: 'invalid_client_version',
        version: version
      };
    }
    
    // 计算期望签名
    const payload = `${requestId}:${version}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.signingKey)
      .update(payload)
      .digest('hex');
    
    // 验证签名
    if (signature !== expectedSignature) {
      return {
        valid: false,
        reason: 'signature_mismatch',
        expected: expectedSignature.slice(0, 16) + '...',
        received: signature.slice(0, 16) + '...'
      };
    }
    
    return {
      valid: true,
      signature: signature
    };
  }

  /**
   * 评估客户端环境风险
   */
  async _assessEnvironmentRisk(userId, environmentData, fingerprint) {
    const riskFactors = {
      isRooted: 0,
      isEmulator: 0,
      hasDebugger: 0,
      hasInjection: 0,
      isModified: 0
    };
    
    // 1. Root/越狱检测
    if (environmentData.isRooted || environmentData.isJailbroken) {
      riskFactors.isRooted = 40;
    }
    
    // 2. 模拟器检测
    if (environmentData.isEmulator || this._detectEmulator(environmentData)) {
      riskFactors.isEmulator = 50;
    }
    
    // 3. 调试器检测
    if (environmentData.hasDebuggerAttached) {
      riskFactors.hasDebugger = 60;
    }
    
    // 4. 注入框架检测
    if (environmentData.hasInjection || environmentData.detectedHooks) {
      riskFactors.hasInjection = 70;
    }
    
    // 5. 代码修改检测
    if (environmentData.modifiedFunctions?.length > 0) {
      riskFactors.isModified = 90;
    }
    
    // 计算总分
    const totalRisk = Object.values(riskFactors).reduce((sum, val) => sum + val, 0);
    
    // 确定风险等级
    let level = 'LOW';
    if (totalRisk >= 100) level = 'CRITICAL';
    else if (totalRisk >= 70) level = 'HIGH';
    else if (totalRisk >= 40) level = 'MEDIUM';
    
    return {
      factors: riskFactors,
      total: totalRisk,
      level: level,
      details: environmentData
    };
  }

  /**
   * 模拟器检测算法
   */
  _detectEmulator(envData) {
    const emulatorIndicators = [
      envData.webglRenderer?.includes('SwiftShader'),
      envData.webglRenderer?.includes('ANGLE'),
      envData.platform?.includes('Linux x86_64'),
      !envData.hasTouchSupport,
      envData.screenWidth === envData.screenHeight,
      envData.batteryLevel === 100 && envData.batteryCharging === true,
      envData.hardwareConcurrency <= 2
    ];
    
    const suspiciousCount = emulatorIndicators.filter(Boolean).length;
    
    return suspiciousCount >= 3;
  }

  /**
   * 计算综合完整性风险评分
   */
  _calculateIntegrityRiskScore(signature, environment, fingerprint) {
    // 签名权重：30%
    const signatureScore = signature.valid ? 0 : 80;
    
    // 环境风险权重：50%
    const environmentScore = environment.total;
    
    // 设备指纹权重：20%
    const fingerprintScore = await this._assessFingerprintRisk(fingerprint);
    
    // 综合评分
    const totalScore = 
      signatureScore * 0.30 +
      environmentScore * 0.50 +
      fingerprintScore * 0.20;
    
    return Math.round(totalScore);
  }

  /**
   * 评估设备指纹风险
   */
  async _assessFingerprintRisk(fingerprint) {
    // 检查是否有历史异常记录
    const cacheKey = `device:risk:${fingerprint}`;
    const history = await getJSON(cacheKey);
    
    if (!history) return 0;
    
    // 根据历史记录计算风险
    const failedAttempts = history.failedAttempts || 0;
    
    if (failedAttempts >= this.maxFailedAttempts) {
      return 80;
    } else if (failedAttempts >= 3) {
      return 50;
    } else if (failedAttempts >= 1) {
      return 20;
    }
    
    return 0;
  }

  /**
   * 提取设备指纹
   */
  _extractDeviceFingerprint(req) {
    const components = [
      req.headers['user-agent'],
      req.headers['accept-language'],
      req.headers['x-device-id'],
      req.ip
    ];
    
    const fingerprintData = components.filter(Boolean).join('|');
    
    return crypto
      .createHash('sha256')
      .update(fingerprintData)
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * 生成挑战
   */
  async _generateChallenge(userId, riskScore) {
    const challengeId = crypto.randomBytes(16).toString('hex');
    
    // 根据风险等级选择挑战类型
    let challengeType;
    if (riskScore >= 80) {
      challengeType = 'computation_hard';  // 高难度计算挑战
    } else if (riskScore >= 60) {
      challengeType = 'computation_medium';
    } else {
      challengeType = 'behavior';  // 行为挑战（如点击验证）
    }
    
    // 生成挑战数据
    const challengeData = this._generateChallengeData(challengeType);
    
    // 缓存挑战
    const cacheKey = `challenge:${userId}:${challengeId}`;
    await setJSON(cacheKey, {
      type: challengeType,
      data: challengeData,
      createdAt: Date.now(),
      riskScore: riskScore
    }, this.challengeTimeout);
    
    return {
      challengeId,
      type: challengeType,
      data: challengeData,
      timeout: this.challengeTimeout
    };
  }

  /**
   * 生成挑战数据
   */
  _generateChallengeData(type) {
    if (type === 'computation_hard' || type === 'computation_medium') {
      // 计算挑战
      const difficulty = type === 'computation_hard' ? 3 : 2;
      const payload = crypto.randomBytes(32).toString('base64');
      
      return {
        operations: ['hash', 'encrypt'],
        payload: payload,
        difficulty: difficulty,
        expectedResult: crypto
          .createHash('sha256')
          .update(payload.repeat(difficulty))
          .digest('hex')
          .slice(0, 16)
      };
    }
    
    // 行为挑战
    return {
      action: 'click_sequence',
      sequence: ['top-left', 'center', 'bottom-right'],
      timeout: 3000
    };
  }

  /**
   * 验证挑战响应
   */
  async verifyChallengeResponse(userId, challengeId, response) {
    const cacheKey = `challenge:${userId}:${challengeId}`;
    const challenge = await getJSON(cacheKey);
    
    if (!challenge) {
      return {
        valid: false,
        reason: 'challenge_expired_or_not_found'
      };
    }
    
    // 检查超时
    const elapsed = Date.now() - challenge.createdAt;
    if (elapsed > this.challengeTimeout) {
      return {
        valid: false,
        reason: 'challenge_timeout'
      };
    }
    
    // 验证响应
    if (challenge.type.startsWith('computation')) {
      const isValid = response.result === challenge.data.expectedResult;
      
      // 检查是否有时间加速（响应时间异常快）
      const minTime = challenge.data.difficulty * 100;  // 最少需要的时间
      if (elapsed < minTime) {
        logger.warn({ userId, elapsed, minTime }, 
          'Challenge response too fast, possible time acceleration');
        
        return {
          valid: false,
          reason: 'time_acceleration_detected'
        };
      }
      
      return {
        valid: isValid,
        reason: isValid ? 'success' : 'wrong_result'
      };
    }
    
    // 行为挑战验证
    if (challenge.type === 'behavior') {
      const isValid = response.sequence === challenge.data.sequence.join(',');
      
      return {
        valid: isValid,
        reason: isValid ? 'success' : 'wrong_sequence'
      };
    }
    
    return {
      valid: false,
      reason: 'unknown_challenge_type'
    };
  }

  /**
   * 记录失败尝试
   */
  async _recordFailedAttempt(userId, fingerprint) {
    const key = `device:risk:${fingerprint}`;
    const history = await getJSON(key) || { failedAttempts: 0 };
    
    history.failedAttempts++;
    history.lastFailedAt = Date.now();
    
    await setJSON(key, history, 7 * 24 * 3600);  // 7天缓存
  }

  /**
   * 缓存验证结果
   */
  async _cacheVerificationResult(userId, fingerprint, result) {
    const key = `integrity:result:${userId}:${fingerprint}`;
    
    await setJSON(key, result, 5 * 60);  // 5分钟缓存
  }

  /**
   * 定期运行时完整性校验（供客户端调用）
   */
  async verifyRuntimeIntegrity(userId, integrityReport) {
    const issues = [];
    
    // 检查关键函数是否被篡改
    if (integrityReport.functionHashes) {
      for (const [funcName, hash] of Object.entries(integrityReport.functionHashes)) {
        const expectedHash = this.criticalFunctionHashes[funcName];
        
        if (expectedHash && hash !== expectedHash) {
          issues.push({
            type: 'function_tampered',
            function: funcName,
            severity: 'critical'
          });
        }
      }
    }
    
    // 检查全局对象是否被修改
    if (integrityReport.globalObjectsModified?.length > 0) {
      issues.push({
        type: 'globals_modified',
        objects: integrityReport.globalObjectsModified,
        severity: 'high'
      });
    }
    
    // 检查原型链是否被篡改
    if (integrityReport.prototypeChainModified) {
      issues.push({
        type: 'prototype_tampered',
        severity: 'high'
      });
    }
    
    if (issues.length > 0) {
      logger.warn({ userId, issues }, 'Runtime integrity issues detected');
      
      // 记录到审计日志
      await this._logIntegrityIssue(userId, issues);
      
      return {
        valid: false,
        issues: issues,
        riskScore: this._calculateIssueRiskScore(issues)
      };
    }
    
    return {
      valid: true,
      issues: [],
      riskScore: 0
    };
  }

  /**
   * 计算问题风险评分
   */
  _calculateIssueRiskScore(issues) {
    const severityWeights = {
      critical: 90,
      high: 60,
      medium: 30,
      low: 10
    };
    
    return issues.reduce((sum, issue) => {
      return sum + severityWeights[issue.severity] || 0;
    }, 0);
  }

  /**
   * 记录完整性问题
   */
  async _logIntegrityIssue(userId, issues) {
    logger.warn({
      userId,
      issues: JSON.stringify(issues),
      timestamp: new Date().toISOString()
    }, 'Client integrity violation logged');
    
    // 可选：触发账号限制或封禁
    if (issues.some(i => i.severity === 'critical')) {
      // 标记为高风险账号
      const key = `account:flag:${userId}`;
      await setJSON(key, {
        flag: 'integrity_violation',
        issues: issues,
        flaggedAt: new Date().toISOString()
      }, 30 * 24 * 3600);  // 30天标记
    }
  }
}

// 导出单例
const clientIntegrityMiddleware = new ClientIntegrityMiddleware();

module.exports = {
  ClientIntegrityMiddleware,
  middleware: clientIntegrityMiddleware.getMiddleware(),
  verifyChallengeResponse: clientIntegrityMiddleware.verifyChallengeResponse,
  verifyRuntimeIntegrity: clientIntegrityMiddleware.verifyRuntimeIntegrity
};