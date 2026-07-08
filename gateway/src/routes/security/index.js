/**
 * 安全相关路由
 * 包含注入检测报告、检测规则热更新等接口
 * 
 * @module gateway/src/routes/security
 */

const express = require('express');
const router = express.Router();
const { query } = require('../../shared/db');
const redis = require('../../shared/redis');
const logger = require('../../shared/logger');
const metrics = require('../../shared/metrics');
const { verifyRequestSignature } = require('../../shared/security/requestVerifier');

/**
 * POST /api/v1/security/injection-report
 * 接收客户端注入检测结果
 */
router.post('/injection-report', async (req, res) => {
  try {
    const { deviceId, timestamp, riskLevel, detections } = req.body;
    
    // 验证请求签名（可选，根据配置）
    if (process.env.VERIFY_SIGNATURE === 'true') {
      if (!verifyRequestSignature(req)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // 验证必要字段
    if (!deviceId || !timestamp || !riskLevel || !detections) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 验证风险等级
    const validRiskLevels = ['low', 'medium', 'high', 'critical'];
    if (!validRiskLevels.includes(riskLevel)) {
      return res.status(400).json({ error: 'Invalid risk level' });
    }

    // 存储检测结果
    await query(
      `INSERT INTO injection_detection_reports 
       (device_id, timestamp, risk_level, detections, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [deviceId, timestamp, riskLevel, JSON.stringify(detections)]
    );

    // 高风险设备自动标记
    if (riskLevel === 'critical' || riskLevel === 'high') {
      // Redis 缓存标记，30 天过期
      await redis.set(`flagged_device:${deviceId}`, riskLevel, 'EX', 86400 * 30);
      
      // 触发账号风控联动（如果有用户 ID）
      const userId = req.headers['x-user-id'];
      if (userId) {
        await triggerAccountSecurityReview(userId, deviceId, riskLevel);
      }
      
      logger.warn('[Security] High-risk device detected', {
        deviceId,
        riskLevel,
        detectionCount: detections.length
      });
    }

    // Prometheus 指标
    metrics.increment('injection_reports_total', 1, { 
      risk_level: riskLevel,
      detection_count: detections.length.toString()
    });

    const action = getActionForRiskLevel(riskLevel);
    
    res.json({ 
      success: true, 
      action,
      message: 'Report processed successfully'
    });
  } catch (error) {
    logger.error('[Security] Failed to process injection report', { 
      error: error.message,
      stack: error.stack 
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/v1/security/detection-rules
 * 提供检测规则热更新
 */
router.get('/detection-rules', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    const clientVersion = req.headers['x-client-version'] || '1.0.0';
    
    // 根据设备特征返回定制规则（如地区、版本）
    const deviceRegion = getDeviceRegion(deviceId);
    
    const rules = await query(
      `SELECT id, name, tool_type, detection_strategy, severity, priority 
       FROM detection_rules 
       WHERE enabled = true 
       AND (target_region IS NULL OR target_region = $1)
       AND (min_version IS NULL OR min_version <= $2)
       ORDER BY priority DESC`,
      [deviceRegion, clientVersion]
    );

    // 获取当前规则版本号
    const versionResult = await query(
      `SELECT MAX(updated_at) as version FROM detection_rules WHERE enabled = true`
    );
    const version = versionResult.rows[0]?.version || new Date().toISOString();

    res.json({ 
      version,
      rules: rules.rows,
      nextUpdateIn: 3600, // 1小时后更新
      message: 'Rules retrieved successfully'
    });
  } catch (error) {
    logger.error('[Security] Failed to get detection rules', { 
      error: error.message 
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/v1/security/device-status/:deviceId
 * 查询设备安全状态
 */
router.get('/device-status/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    // 从 Redis 查询设备标记
    const flaggedLevel = await redis.get(`flagged_device:${deviceId}`);
    
    // 查询最近的检测报告
    const recentReports = await query(
      `SELECT risk_level, detections, created_at 
       FROM injection_detection_reports 
       WHERE device_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [deviceId]
    );

    // 计算风险评分
    const riskScore = calculateRiskScore(flaggedLevel, recentReports.rows);

    res.json({
      deviceId,
      flagged: flaggedLevel !== null,
      flaggedLevel: flaggedLevel || 'none',
      riskScore,
      recentReports: recentReports.rows.map(r => ({
        riskLevel: r.risk_level,
        detectionCount: r.detections?.length || 0,
        timestamp: r.created_at
      })),
      message: 'Device status retrieved successfully'
    });
  } catch (error) {
    logger.error('[Security] Failed to get device status', { 
      error: error.message 
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/v1/security/report-batch
 * 批量接收多个设备的检测报告（用于高峰时段优化）
 */
router.post('/report-batch', async (req, res) => {
  try {
    const { reports } = req.body;
    
    if (!Array.isArray(reports) || reports.length === 0) {
      return res.status(400).json({ error: 'Invalid reports array' });
    }

    // 批量插入
    const insertPromises = reports.map(report => {
      const { deviceId, timestamp, riskLevel, detections } = report;
      
      // 验证必要字段
      if (!deviceId || !timestamp || !riskLevel || !detections) {
        return Promise.resolve({ skipped: true, reason: 'Missing fields' });
      }

      return query(
        `INSERT INTO injection_detection_reports 
         (device_id, timestamp, risk_level, detections, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [deviceId, timestamp, riskLevel, JSON.stringify(detections)]
      ).then(() => {
        // 高风险设备标记
        if (riskLevel === 'critical' || riskLevel === 'high') {
          return redis.set(`flagged_device:${deviceId}`, riskLevel, 'EX', 86400 * 30);
        }
        return Promise.resolve();
      }).then(() => ({ success: true, deviceId }));
    });

    const results = await Promise.all(insertPromises);
    
    const successCount = results.filter(r => r.success).length;
    const skippedCount = results.filter(r => r.skipped).length;

    // Prometheus 指标
    metrics.increment('injection_reports_batch_total', successCount);

    res.json({
      success: true,
      processed: successCount,
      skipped: skippedCount,
      message: 'Batch reports processed'
    });
  } catch (error) {
    logger.error('[Security] Failed to process batch reports', { 
      error: error.message 
    });
    res.status(500).json({ error: 'Internal error' });
  }
});

// ========== 辅助函数 ==========

/**
 * 根据风险等级返回响应动作
 */
function getActionForRiskLevel(riskLevel) {
  switch (riskLevel) {
    case 'critical': return 'block';
    case 'high': return 'degrade';
    case 'medium': return 'warn';
    case 'low': return 'none';
    default: return 'none';
  }
}

/**
 * 获取设备地区（从设备 ID 或请求头推断）
 */
function getDeviceRegion(deviceId) {
  // 简化版：从设备 ID hash 推断地区
  // 实际应从用户设置或 IP 地理位置获取
  if (!deviceId) return null;
  
  const hash = deviceId.split('_').pop();
  if (!hash) return null;
  
  // 根据首字符分配地区（示例）
  const regionMap = {
    'a': 'asia',
    'e': 'europe',
    'u': 'us',
    'c': 'china'
  };
  
  return regionMap[hash[0]?.toLowerCase()] || null;
}

/**
 * 触发账号安全审查
 */
async function triggerAccountSecurityReview(userId, deviceId, riskLevel) {
  try {
    // 写入安全审查队列
    await redis.lpush('security_review_queue', JSON.stringify({
      userId,
      deviceId,
      riskLevel,
      timestamp: Date.now(),
      source: 'injection_detection'
    }));
    
    logger.info('[Security] Account security review triggered', {
      userId,
      deviceId,
      riskLevel
    });
  } catch (error) {
    logger.error('[Security] Failed to trigger security review', { 
      error: error.message 
    });
  }
}

/**
 * 计算设备风险评分（0-100）
 */
function calculateRiskScore(flaggedLevel, recentReports) {
  let score = 0;
  
  // 基础分数（从标记等级）
  if (flaggedLevel === 'critical') score += 80;
  else if (flaggedLevel === 'high') score += 50;
  else if (flaggedLevel === 'medium') score += 20;
  
  // 根据最近报告调整
  const recentHighCount = recentReports.filter(r => 
    r.risk_level === 'high' || r.risk_level === 'critical'
  ).length;
  
  score += Math.min(recentHighCount * 5, 20); // 最多加 20 分
  
  return Math.min(score, 100);
}

module.exports = router;