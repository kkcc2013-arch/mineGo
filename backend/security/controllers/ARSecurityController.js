/**
 * ARSecurityController - AR 安全报告处理控制器
 * 
 * 处理来自客户端的 AR 模式安全报告，进行风险评估和动作执行
 * 
 * @module backend/security/controllers/ARSecurityController
 */

const crypto = require('crypto');
const { db } = require('../../shared/db');
const logger = require('../../shared/logger')('ARSecurityController');

class ARSecurityController {
  constructor() {
    this.riskThresholds = {
      low: 50,
      medium: 70,
      high: 85,
      critical: 95
    };

    this.actionLevels = {
      low: 'LOG',
      medium: 'WARN',
      high: 'RESTRICT',
      critical: 'SUSPEND'
    };

    this.stats = {
      totalReports: 0,
      highRiskReports: 0,
      actionsTaken: 0
    };
  }

  /**
   * 处理 AR 安全报告
   * POST /api/v1/security/ar/report
   */
  async handleARSecurityReport(req, res) {
    try {
      const { 
        deviceId,
        userId,
        validationResults,
        sensorData,
        gpsData,
        arEnvironmentState,
        timestamp 
      } = req.body;

      // 记录报告
      const reportId = this.generateReportId();
      
      this.stats.totalReports++;

      // 计算综合风险评分
      const riskScore = this.calculateRiskScore(validationResults);
      const riskLevel = this.determineRiskLevel(riskScore);

      // 持久化报告
      await this.persistReport({
        reportId,
        deviceId,
        userId,
        validationResults,
        riskScore,
        riskLevel,
        timestamp: timestamp || Date.now()
      });

      // 高风险时执行动作
      let action = null;
      if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
        this.stats.highRiskReports++;
        action = await this.executeSecurityAction(userId, deviceId, riskLevel, validationResults);
        this.stats.actionsTaken++;
      }

      logger.info('AR security report processed', {
        reportId,
        userId,
        deviceId,
        riskScore,
        riskLevel,
        action: action?.type
      });

      res.json({
        success: true,
        reportId,
        riskScore,
        riskLevel,
        action: action?.type || 'NONE',
        timestamp: Date.now()
      });

    } catch (error) {
      logger.error('Failed to process AR security report', {
        error: error.message,
        stack: error.stack
      });

      res.status(500).json({
        success: false,
        error: 'Failed to process security report'
      });
    }
  }

  /**
   * 处理传感器异常报告
   * POST /api/v1/security/ar/sensor-anomaly
   */
  async handleSensorAnomaly(req, res) {
    try {
      const {
        deviceId,
        userId,
        anomalyType,
        sensorData,
        anomalyDetails,
        timestamp
      } = req.body;

      const anomalyRecord = {
        id: crypto.randomUUID(),
        device_id: deviceId,
        user_id: userId,
        anomaly_type: anomalyType,
        sensor_data: JSON.stringify(sensorData),
        anomaly_details: JSON.stringify(anomalyDetails),
        detected_at: timestamp || Date.now(),
        created_at: new Date()
      };

      // 存储异常记录
      await db('ar_sensor_anomalies').insert(anomalyRecord);

      // 更新用户风险评分
      await this.updateUserRiskScore(userId, anomalyType);

      logger.warn('Sensor anomaly detected', {
        userId,
        deviceId,
        anomalyType
      });

      res.json({
        success: true,
        anomalyId: anomalyRecord.id,
        action: 'RECORDED'
      });

    } catch (error) {
      logger.error('Failed to handle sensor anomaly', {
        error: error.message
      });

      res.status(500).json({
        success: false,
        error: 'Failed to process anomaly'
      });
    }
  }

  /**
   * 处理 GPS 欺骗检测报告
   * POST /api/v1/security/ar/gps-spoof
   */
  async handleGPSSpoof(req, res) {
    try {
      const {
        deviceId,
        userId,
        gpsData,
        spoofEvidence,
        confidence,
        timestamp
      } = req.body;

      // 高置信度的 GPS 欺骗直接触发限制
      if (confidence >= 90) {
        await this.executeSecurityAction(userId, deviceId, 'HIGH', {
          type: 'GPS_SPOOFING',
          confidence,
          evidence: spoofEvidence
        });

        return res.json({
          success: true,
          action: 'SUSPENDED',
          reason: 'GPS spoofing detected with high confidence'
        });
      }

      // 中等置信度记录并标记
      if (confidence >= 50) {
        await db('gps_spoof_incidents').insert({
          id: crypto.randomUUID(),
          device_id: deviceId,
          user_id: userId,
          gps_data: JSON.stringify(gpsData),
          spoof_evidence: JSON.stringify(spoofEvidence),
          confidence,
          status: 'INVESTIGATING',
          created_at: new Date()
        });

        return res.json({
          success: true,
          action: 'FLAGGED',
          reason: 'GPS spoofing suspected, under investigation'
        });
      }

      res.json({
        success: true,
        action: 'LOGGED',
        reason: 'Low confidence GPS anomaly logged'
      });

    } catch (error) {
      logger.error('Failed to handle GPS spoof report', {
        error: error.message
      });

      res.status(500).json({
        success: false,
        error: 'Failed to process GPS spoof report'
      });
    }
  }

  /**
   * 处理摄像头流注入检测
   * POST /api/v1/security/ar/camera-injection
   */
  async handleCameraInjection(req, res) {
    try {
      const {
        deviceId,
        userId,
        injectionType,
        detectionMethod,
        evidence,
        confidence,
        timestamp
      } = req.body;

      // 摄像头注入是严重违规
      const action = await this.executeSecurityAction(userId, deviceId, 'CRITICAL', {
        type: 'CAMERA_INJECTION',
        injectionType,
        detectionMethod,
        confidence
      });

      // 记录事件
      await db('camera_injection_incidents').insert({
        id: crypto.randomUUID(),
        device_id: deviceId,
        user_id: userId,
        injection_type: injectionType,
        detection_method: detectionMethod,
        evidence: JSON.stringify(evidence),
        confidence,
        action_taken: action.type,
        created_at: new Date()
      });

      logger.critical('Camera injection detected', {
        userId,
        deviceId,
        injectionType,
        action: action.type
      });

      res.json({
        success: true,
        action: action.type,
        reason: 'Camera stream injection detected'
      });

    } catch (error) {
      logger.error('Failed to handle camera injection report', {
        error: error.message
      });

      res.status(500).json({
        success: false,
        error: 'Failed to process camera injection report'
      });
    }
  }

  /**
   * 获取用户 AR 安全状态
   * GET /api/v1/security/ar/status/:userId
   */
  async getARSecurityStatus(req, res) {
    try {
      const { userId } = req.params;

      // 获取用户最近的 AR 安全记录
      const recentReports = await db('ar_security_reports')
        .where('user_id', userId)
        .orderBy('created_at', 'desc')
        .limit(10);

      // 获取未处理的异常
      const pendingAnomalies = await db('ar_sensor_anomalies')
        .where('user_id', userId)
        .where('resolved', false)
        .count('* as count');

      // 计算风险趋势
      const riskTrend = this.calculateRiskTrend(recentReports);

      // 获取当前限制状态
      const restrictions = await db('user_restrictions')
        .where('user_id', userId)
        .where('active', true)
        .select('*');

      res.json({
        success: true,
        userId,
        recentReports: recentReports.map(r => ({
          reportId: r.report_id,
          riskScore: r.risk_score,
          riskLevel: r.risk_level,
          timestamp: r.created_at
        })),
        pendingAnomalies: pendingAnomalies[0]?.count || 0,
        riskTrend,
        activeRestrictions: restrictions,
        stats: {
          totalReports: this.stats.totalReports,
          highRiskReports: this.stats.highRiskReports
        }
      });

    } catch (error) {
      logger.error('Failed to get AR security status', {
        error: error.message,
        userId: req.params.userId
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get security status'
      });
    }
  }

  /**
   * 计算综合风险评分
   */
  calculateRiskScore(validationResults) {
    if (!validationResults || !validationResults.scores) {
      return 0;
    }

    const weights = {
      gyroscope: 0.25,
      accelerometer: 0.25,
      gps: 0.2,
      behavior: 0.2,
      arEnvironment: 0.1
    };

    let totalScore = 0;
    let totalWeight = 0;

    for (const [key, weight] of Object.entries(weights)) {
      if (validationResults.scores[key] !== undefined) {
        // 将 0-100 的分数转换为风险分数（越高越危险）
        const riskScore = 100 - validationResults.scores[key];
        totalScore += riskScore * weight;
        totalWeight += weight;
      }
    }

    return totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
  }

  /**
   * 确定风险等级
   */
  determineRiskLevel(riskScore) {
    if (riskScore >= this.riskThresholds.critical) return 'CRITICAL';
    if (riskScore >= this.riskThresholds.high) return 'HIGH';
    if (riskScore >= this.riskThresholds.medium) return 'MEDIUM';
    if (riskScore >= this.riskThresholds.low) return 'LOW';
    return 'SAFE';
  }

  /**
   * 执行安全动作
   */
  async executeSecurityAction(userId, deviceId, riskLevel, details) {
    const actionType = this.actionLevels[riskLevel] || 'LOG';

    const action = {
      type: actionType,
      reason: details.type || 'Security violation',
      timestamp: Date.now(),
      details
    };

    switch (actionType) {
      case 'SUSPEND':
        // 暂停用户账户
        await db('users')
          .where('id', userId)
          .update({
            status: 'SUSPENDED',
            suspended_at: new Date(),
            suspension_reason: 'AR security violation'
          });
        
        // 记录暂停
        await db('user_restrictions').insert({
          id: crypto.randomUUID(),
          user_id: userId,
          device_id: deviceId,
          type: 'ACCOUNT_SUSPENSION',
          reason: JSON.stringify(details),
          active: true,
          created_at: new Date()
        });
        break;

      case 'RESTRICT':
        // 限制 AR 功能
        await db('user_restrictions').insert({
          id: crypto.randomUUID(),
          user_id: userId,
          device_id: deviceId,
          type: 'AR_RESTRICTION',
          reason: JSON.stringify(details),
          active: true,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7天
          created_at: new Date()
        });
        break;

      case 'WARN':
        // 发送警告
        await db('user_warnings').insert({
          id: crypto.randomUUID(),
          user_id: userId,
          type: 'AR_SECURITY_WARNING',
          message: 'Suspicious activity detected in AR mode',
          details: JSON.stringify(details),
          created_at: new Date()
        });
        break;

      case 'LOG':
      default:
        // 仅记录
        break;
    }

    return action;
  }

  /**
   * 持久化报告
   */
  async persistReport(reportData) {
    await db('ar_security_reports').insert({
      id: crypto.randomUUID(),
      report_id: reportData.reportId,
      device_id: reportData.deviceId,
      user_id: reportData.userId,
      validation_results: JSON.stringify(reportData.validationResults),
      risk_score: reportData.riskScore,
      risk_level: reportData.riskLevel,
      created_at: new Date(reportData.timestamp)
    });
  }

  /**
   * 更新用户风险评分
   */
  async updateUserRiskScore(userId, anomalyType) {
    const scoreIncrement = this.getAnomalyScoreIncrement(anomalyType);

    await db('users')
      .where('id', userId)
      .increment('risk_score', scoreIncrement);

    // 检查是否达到限制阈值
    const user = await db('users')
      .where('id', userId)
      .first('risk_score');

    if (user && user.risk_score >= 100) {
      await this.executeSecurityAction(userId, null, 'HIGH', {
        type: 'ACCUMULATED_RISK',
        score: user.risk_score
      });
    }
  }

  /**
   * 获取异常类型对应的评分增量
   */
  getAnomalyScoreIncrement(anomalyType) {
    const increments = {
      'SENSOR_VARIANCE_LOW': 15,
      'SENSOR_VARIANCE_HIGH': 10,
      'GPS_SPEED_ANOMALY': 20,
      'GPS_ACCURACY_ANOMALY': 10,
      'CAMERA_INJECTION': 50,
      'MOTION_TOO_SMOOTH': 25,
      'DIRECTION_CHANGE_ANOMALY': 15
    };

    return increments[anomalyType] || 5;
  }

  /**
   * 计算风险趋势
   */
  calculateRiskTrend(reports) {
    if (reports.length < 2) {
      return 'INSUFFICIENT_DATA';
    }

    const recentScores = reports.slice(0, 5).map(r => r.risk_score);
    const olderScores = reports.slice(5, 10).map(r => r.risk_score);

    if (olderScores.length === 0) {
      return 'INSUFFICIENT_DATA';
    }

    const recentAvg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
    const olderAvg = olderScores.reduce((a, b) => a + b, 0) / olderScores.length;

    if (recentAvg > olderAvg + 10) {
      return 'INCREASING';
    } else if (recentAvg < olderAvg - 10) {
      return 'DECREASING';
    }

    return 'STABLE';
  }

  /**
   * 生成报告 ID
   */
  generateReportId() {
    return `AR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }
}

// 路由注册
function registerARSecurityRoutes(app, controller) {
  app.post('/api/v1/security/ar/report', controller.handleARSecurityReport.bind(controller));
  app.post('/api/v1/security/ar/sensor-anomaly', controller.handleSensorAnomaly.bind(controller));
  app.post('/api/v1/security/ar/gps-spoof', controller.handleGPSSpoof.bind(controller));
  app.post('/api/v1/security/ar/camera-injection', controller.handleCameraInjection.bind(controller));
  app.get('/api/v1/security/ar/status/:userId', controller.getARSecurityStatus.bind(controller));
}

module.exports = {
  ARSecurityController,
  registerARSecurityRoutes
};