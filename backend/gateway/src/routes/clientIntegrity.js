// backend/gateway/src/routes/clientIntegrity.js
// REQ-00483: 客户端完整性验证路由

'use strict';

const express = require('express');
const router = express.Router();
const { middleware, verifyChallengeResponse, verifyRuntimeIntegrity } = require('../middleware/client-integrity');
const { createLogger } = require('../../shared/logger');
const { getRedis, setJSON, getJSON } = require('../../shared/redis');
const { query } = require('../../shared/db');

const logger = createLogger('client-integrity-routes');
const redis = getRedis();

/**
 * POST /api/v1/integrity/report
 * 接收客户端环境检测报告
 */
router.post('/report', async (req, res) => {
  const userId = req.user?.sub;
  const deviceId = req.headers['x-device-id'];
  const clientVersion = req.headers['x-client-version'];
  
  try {
    const report = req.body;
    
    // 1. 存储检测报告
    const reportId = await storeIntegrityReport(userId, deviceId, report);
    
    // 2. 评估风险
    const riskAssessment = await assessIntegrityRisk(report);
    
    // 3. 根据风险等级决定下一步操作
    let response = {
      success: true,
      reportId,
      riskLevel: riskAssessment.level,
      riskScore: riskAssessment.score,
      recommendations: []
    };
    
    if (riskAssessment.level === 'CRITICAL') {
      // 严重风险：要求立即验证
      response.requiresVerification = true;
      response.message = '检测到严重安全风险，请完成验证后继续';
      
      // 记录到高风险账号列表
      await flagHighRiskAccount(userId, deviceId, report, riskAssessment);
    } else if (riskAssessment.level === 'HIGH') {
      // 高风险：建议验证
      response.requiresVerification = true;
      response.message = '检测到安全风险，建议完成验证';
    } else if (riskAssessment.level === 'MEDIUM') {
      // 中等风险：监控
      await addToWatchlist(userId, deviceId, report, riskAssessment);
      response.message = '已记录设备信息';
    }
    
    // 4. 返回客户端需要执行的验证类型（如有）
    if (response.requiresVerification) {
      response.verificationType = getVerificationType(riskAssessment.score);
    }
    
    res.json(response);
    
  } catch (error) {
    logger.error({ userId, deviceId, error: error.message }, 
      'Failed to process integrity report');
    
    res.status(500).json({
      success: false,
      error: 'Failed to process integrity report'
    });
  }
});

/**
 * POST /api/v1/integrity/verify
 * 完成挑战-响应验证
 */
router.post('/verify', async (req, res) => {
  const userId = req.user?.sub;
  const { challengeId, response } = req.body;
  
  try {
    // 验证挑战响应
    const result = await verifyChallengeResponse(userId, challengeId, response);
    
    if (result.valid) {
      // 验证成功，清除风险标记
      await clearRiskFlag(userId);
      
      // 记录验证成功
      await logVerificationSuccess(userId, challengeId);
      
      res.json({
        success: true,
        message: '验证成功',
        verified: true,
        timestamp: new Date().toISOString()
      });
    } else {
      // 验证失败，记录失败次数
      await recordVerificationFailure(userId, challengeId, result.reason);
      
      res.status(403).json({
        success: false,
        verified: false,
        reason: result.reason,
        message: getVerificationFailureMessage(result.reason)
      });
    }
    
  } catch (error) {
    logger.error({ userId, challengeId, error: error.message }, 
      'Verification failed');
    
    res.status(500).json({
      success: false,
      error: 'Verification process failed'
    });
  }
});

/**
 * POST /api/v1/integrity/runtime-check
 * 运行时完整性校验
 */
router.post('/runtime-check', async (req, res) => {
  const userId = req.user?.sub;
  const integrityReport = req.body;
  
  try {
    const result = await verifyRuntimeIntegrity(userId, integrityReport);
    
    res.json({
      success: true,
      valid: result.valid,
      issues: result.issues,
      riskScore: result.riskScore,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error({ userId, error: error.message }, 
      'Runtime integrity check failed');
    
    res.status(500).json({
      success: false,
      error: 'Runtime integrity check failed'
    });
  }
});

/**
 * GET /api/v1/integrity/status
 * 获取客户端完整性状态
 */
router.get('/status', async (req, res) => {
  const userId = req.user?.sub;
  const deviceId = req.headers['x-device-id'];
  
  try {
    // 获取最近的完整性报告
    const latestReport = await getLatestIntegrityReport(userId, deviceId);
    
    if (!latestReport) {
      return res.json({
        success: true,
        status: 'unknown',
        message: '尚未进行完整性检测'
      });
    }
    
    // 获取当前风险状态
    const riskStatus = await getRiskStatus(userId, deviceId);
    
    res.json({
      success: true,
      status: riskStatus.status,
      riskLevel: latestReport.riskLevel,
      riskScore: latestReport.riskScore,
      lastCheck: latestReport.createdAt,
      requiresVerification: riskStatus.requiresVerification,
      details: {
        isRooted: latestReport.isRooted,
        isEmulator: latestReport.isEmulator,
        hasDebugger: latestReport.hasDebugger,
        hasInjection: latestReport.hasInjection
      }
    });
    
  } catch (error) {
    logger.error({ userId, deviceId, error: error.message }, 
      'Failed to get integrity status');
    
    res.status(500).json({
      success: false,
      error: 'Failed to get integrity status'
    });
  }
});

/**
 * GET /api/v1/integrity/challenge
 * 获取新的挑战
 */
router.get('/challenge', async (req, res) => {
  const userId = req.user?.sub;
  const { type } = req.query;
  
  try {
    // 获取当前风险评分
    const riskScore = await getCurrentRiskScore(userId);
    
    // 生成挑战
    const challenge = await generateChallenge(userId, type || 'auto', riskScore);
    
    res.json({
      success: true,
      challenge: challenge,
      timeout: challenge.timeout,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error({ userId, error: error.message }, 
      'Failed to generate challenge');
    
    res.status(500).json({
      success: false,
      error: 'Failed to generate challenge'
    });
  }
});

/**
 * GET /api/v1/integrity/history
 * 获取完整性检测历史
 */
router.get('/history', async (req, res) => {
  const userId = req.user?.sub;
  const { limit = 10, offset = 0 } = req.query;
  
  try {
    const history = await getIntegrityHistory(userId, parseInt(limit), parseInt(offset));
    
    res.json({
      success: true,
      history: history,
      total: history.length,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
  } catch (error) {
    logger.error({ userId, error: error.message }, 
      'Failed to get integrity history');
    
    res.status(500).json({
      success: false,
      error: 'Failed to get integrity history'
    });
  }
});

/**
 * POST /api/v1/integrity/whitelist-request
 * 申请白名单（用户申诉）
 */
router.post('/whitelist-request', async (req, res) => {
  const userId = req.user?.sub;
  const { reason, details } = req.body;
  
  try {
    // 创建申诉工单
    const ticketId = await createWhitelistRequest(userId, reason, details);
    
    res.json({
      success: true,
      ticketId,
      message: '申诉申请已提交，预计24小时内处理',
      estimatedTime: '24小时'
    });
    
  } catch (error) {
    logger.error({ userId, error: error.message }, 
      'Whitelist request failed');
    
    res.status(500).json({
      success: false,
      error: 'Failed to submit whitelist request'
    });
  }
});

// ========== 辅助函数 ==========

/**
 * 存储完整性报告
 */
async function storeIntegrityReport(userId, deviceId, report) {
  const { rows } = await query(`
    INSERT INTO client_integrity_reports 
      (user_id, device_id, environment_data, risk_factors, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    RETURNING id
  `, [
    userId,
    deviceId,
    JSON.stringify(report.environment || {}),
    JSON.stringify(report.risks || {})
  ]);
  
  return rows[0].id;
}

/**
 * 评估完整性风险
 */
async function assessIntegrityRisk(report) {
  const risks = report.risks || {};
  let score = 0;
  
  // Root/越狱
  if (risks.isRooted || risks.isJailbroken) score += 40;
  
  // 模拟器
  if (risks.isEmulator) score += 50;
  
  // 调试器
  if (risks.hasDebuggerAttached) score += 60;
  
  // 注入框架
  if (risks.hasInjection) score += 70;
  
  // 代码修改
  if (risks.modifiedFunctions && risks.modifiedFunctions.length > 0) {
    score += 90;
  }
  
  // 检测到的 Hook
  if (risks.detectedHooks && risks.detectedHooks.length > 0) {
    score += risks.detectedHooks.length * 10;
  }
  
  // 确定风险等级
  let level = 'LOW';
  if (score >= 150) level = 'CRITICAL';
  else if (score >= 100) level = 'HIGH';
  else if (score >= 50) level = 'MEDIUM';
  
  return { score, level };
}

/**
 * 标记高风险账号
 */
async function flagHighRiskAccount(userId, deviceId, report, assessment) {
  const key = `account:flag:${userId}`;
  
  await setJSON(key, {
    flag: 'integrity_violation',
    deviceId,
    riskLevel: assessment.level,
    riskScore: assessment.score,
    report,
    flaggedAt: new Date().toISOString()
  }, 30 * 24 * 3600);  // 30天
  
  // 同时记录到数据库
  await query(`
    INSERT INTO risk_events 
      (user_id, event_type, action_taken, score_delta, details, created_at)
    VALUES ($1, 'INTegrity_FLAG', 'FLAGGED', $2, $3, NOW())
  `, [userId, assessment.score, JSON.stringify(report)]);
}

/**
 * 添加到监控列表
 */
async function addToWatchlist(userId, deviceId, report, assessment) {
  const key = `risk:watchlist:${userId}:${deviceId}`;
  
  await setJSON(key, {
    userId,
    deviceId,
    riskLevel: assessment.level,
    riskScore: assessment.score,
    report,
    addedAt: new Date().toISOString()
  }, 7 * 24 * 3600);  // 7天
}

/**
 * 获取验证类型
 */
function getVerificationType(riskScore) {
  if (riskScore >= 150) {
    return {
      type: 'multi_factor',
      steps: ['computation_hard', 'behavior', 'device_confirm']
    };
  } else if (riskScore >= 100) {
    return {
      type: 'computation_hard',
      steps: ['computation_hard']
    };
  } else if (riskScore >= 50) {
    return {
      type: 'computation_medium',
      steps: ['computation_medium']
    };
  } else {
    return {
      type: 'behavior',
      steps: ['behavior']
    };
  }
}

/**
 * 清除风险标记
 */
async function clearRiskFlag(userId) {
  const key = `account:flag:${userId}`;
  
  await redis.del(key);
  
  // 更新数据库
  await query(`
    UPDATE users 
    SET integrity_verified = true, integrity_verified_at = NOW()
    WHERE id = $1
  `, [userId]);
}

/**
 * 记录验证成功
 */
async function logVerificationSuccess(userId, challengeId) {
  await query(`
    INSERT INTO integrity_verifications 
      (user_id, challenge_id, status, verified_at)
    VALUES ($1, $2, 'SUCCESS', NOW())
  `, [userId, challengeId]);
  
  // 清除失败计数
  const key = `integrity:failures:${userId}`;
  await redis.del(key);
}

/**
 * 记录验证失败
 */
async function recordVerificationFailure(userId, challengeId, reason) {
  await query(`
    INSERT INTO integrity_verifications 
      (user_id, challenge_id, status, failure_reason, attempted_at)
    VALUES ($1, $2, 'FAILED', $3, NOW())
  `, [userId, challengeId, reason]);
  
  // 增加失败计数
  const key = `integrity:failures:${userId}`;
  const failures = await redis.incr(key);
  await redis.expire(key, 24 * 3600);  // 24小时
  
  // 如果失败次数过多，触发账号限制
  if (failures >= 5) {
    await query(`
      UPDATE users 
      SET integrity_verified = false, integrity_locked = true
      WHERE id = $1
    `, [userId]);
    
    logger.warn({ userId, failures }, 
      'User locked due to too many verification failures');
  }
}

/**
 * 获取验证失败消息
 */
function getVerificationFailureMessage(reason) {
  const messages = {
    'challenge_expired_or_not_found': '挑战已过期，请重新获取',
    'challenge_timeout': '验证超时，请重新尝试',
    'time_acceleration_detected': '检测到时间异常，验证失败',
    'wrong_result': '计算结果错误',
    'wrong_sequence': '行为验证失败',
    'unknown_challenge_type': '验证类型错误'
  };
  
  return messages[reason] || '验证失败，请重新尝试';
}

/**
 * 生成挑战
 */
async function generateChallenge(userId, type, riskScore) {
  const crypto = require('crypto');
  const challengeId = crypto.randomBytes(16).toString('hex');
  
  // 根据类型和风险评分生成挑战
  let challengeType = type;
  if (type === 'auto') {
    if (riskScore >= 100) challengeType = 'computation_hard';
    else if (riskScore >= 50) challengeType = 'computation_medium';
    else challengeType = 'behavior';
  }
  
  // 生成挑战数据
  const challengeData = generateChallengeData(challengeType);
  
  // 缓存挑战
  const key = `challenge:${userId}:${challengeId}`;
  await setJSON(key, {
    type: challengeType,
    data: challengeData,
    createdAt: Date.now(),
    riskScore
  }, 5000);  // 5秒超时
  
  return {
    challengeId,
    type: challengeType,
    data: challengeData,
    timeout: 5000
  };
}

/**
 * 生成挑战数据
 */
function generateChallengeData(type) {
  const crypto = require('crypto');
  
  if (type === 'computation_hard' || type === 'computation_medium') {
    const difficulty = type === 'computation_hard' ? 3 : 2;
    const payload = crypto.randomBytes(32).toString('base64');
    
    return {
      operations: ['hash', 'encrypt'],
      payload,
      difficulty,
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
 * 获取最新完整性报告
 */
async function getLatestIntegrityReport(userId, deviceId) {
  const { rows } = await query(`
    SELECT 
      id,
      environment_data,
      risk_factors,
      created_at,
      risk_score,
      risk_level
    FROM client_integrity_reports
    WHERE user_id = $1 AND device_id = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId, deviceId]);
  
  if (rows.length === 0) return null;
  
  const row = rows[0];
  const risks = row.risk_factors || {};
  
  return {
    id: row.id,
    createdAt: row.created_at,
    riskLevel: row.risk_level,
    riskScore: row.risk_score,
    isRooted: risks.isRooted || false,
    isEmulator: risks.isEmulator || false,
    hasDebugger: risks.hasDebuggerAttached || false,
    hasInjection: risks.hasInjection || false
  };
}

/**
 * 获取风险状态
 */
async function getRiskStatus(userId, deviceId) {
  const key = `account:flag:${userId}`;
  const flag = await getJSON(key);
  
  if (flag) {
    return {
      status: 'flagged',
      requiresVerification: true,
      flagReason: flag.flag,
      flaggedAt: flag.flaggedAt
    };
  }
  
  const watchlistKey = `risk:watchlist:${userId}:${deviceId}`;
  const watchlistEntry = await getJSON(watchlistKey);
  
  if (watchlistEntry) {
    return {
      status: 'watched',
      requiresVerification: watchlistEntry.riskScore >= 50
    };
  }
  
  return {
    status: 'clean',
    requiresVerification: false
  };
}

/**
 * 获取当前风险评分
 */
async function getCurrentRiskScore(userId) {
  const key = `risk:score:${userId}`;
  const data = await getJSON(key);
  
  return data?.score || 0;
}

/**
 * 获取完整性检测历史
 */
async function getIntegrityHistory(userId, limit, offset) {
  const { rows } = await query(`
    SELECT 
      id,
      device_id,
      risk_level,
      risk_score,
      risk_factors,
      created_at
    FROM client_integrity_reports
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);
  
  return rows.map(row => ({
    id: row.id,
    deviceId: row.device_id,
    riskLevel: row.risk_level,
    riskScore: row.risk_score,
    risks: row.risk_factors,
    createdAt: row.created_at
  }));
}

/**
 * 创建白名单申诉请求
 */
async function createWhitelistRequest(userId, reason, details) {
  const { rows } = await query(`
    INSERT INTO whitelist_requests 
      (user_id, reason, details, status, created_at)
    VALUES ($1, $2, $3, 'PENDING', NOW())
    RETURNING id
  `, [userId, reason, JSON.stringify(details)]);
  
  return rows[0].id;
}

module.exports = router;