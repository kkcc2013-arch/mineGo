/**
 * REQ-00485: 导出异常检测器
 * 识别批量数据窃取、异常导出模式
 */

class ExportAnomalyDetector {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    
    // 检测阈值
    this.thresholds = {
      // 单用户短时间内导出次数
      rapidExportCount: 3,
      rapidExportWindow: 3600,  // 1小时
      
      // 管理员批量导出异常
      adminBulkExportUsers: 500,
      adminExportFrequency: 5,  // 单日5次
      
      // 异常时段导出（凌晨2-5点）
      abnormalHours: [2, 3, 4, 5],
      
      // 短时间大量用户数据导出
      burstExportCount: 100,
      burstExportWindow: 600,  // 10分钟
      
      // 风险分数阈值
      blockThreshold: 80,
      mfaThreshold: 50,
      monitorThreshold: 30
    };
  }

  /**
   * 检测导出异常
   * @param {number} userId - 用户/管理员ID
   * @param {boolean} isAdmin - 是否是管理员
   * @returns {object} 检测结果
   */
  async detect(userId, isAdmin = false) {
    const anomalies = [];
    
    // 1. 快速重复导出检测
    const rapidExport = await this._detectRapidExport(userId);
    if (rapidExport) {
      anomalies.push(rapidExport);
    }
    
    // 2. 管理员异常批量导出
    if (isAdmin) {
      const adminAnomaly = await this._detectAdminAnomaly(userId);
      if (adminAnomaly) {
        anomalies.push(adminAnomaly);
      }
    }
    
    // 3. 异常时段导出
    const timeAnomaly = this._detectAbnormalTime();
    if (timeAnomaly) {
      anomalies.push(timeAnomaly);
    }
    
    // 4. 突发性导出检测（系统级）
    const burstAnomaly = await this._detectBurstExport();
    if (burstAnomaly) {
      anomalies.push(burstAnomaly);
    }
    
    // 5. 历史行为对比
    const behaviorAnomaly = await this._detectBehaviorChange(userId, isAdmin);
    if (behaviorAnomaly) {
      anomalies.push(behaviorAnomaly);
    }
    
    // 记录异常
    if (anomalies.length > 0) {
      await this._logAnomaly(userId, anomalies);
    }
    
    return {
      hasAnomaly: anomalies.length > 0,
      anomalies,
      riskScore: this._calculateRiskScore(anomalies),
      recommendedAction: this._getRecommendedAction(anomalies)
    };
  }

  /**
   * 检测快速重复导出
   */
  async _detectRapidExport(userId) {
    const key = `export:rapid:${userId}`;
    const now = Date.now();
    const windowStart = now - this.thresholds.rapidExportWindow * 1000;
    
    // 获取窗口内导出次数
    const count = await this.redis.zcount(key, windowStart, '+inf');
    
    if (count >= this.thresholds.rapidExportCount) {
      return {
        type: 'RAPID_EXPORT',
        severity: 'high',
        message: `短时间内多次导出数据（${count}次）`,
        count,
        threshold: this.thresholds.rapidExportCount
      };
    }
    
    return null;
  }

  /**
   * 检测管理员异常
   */
  async _detectAdminAnomaly(adminId) {
    const today = new Date().toISOString().split('T')[0];
    
    // 查询今日导出统计
    const result = await this.db.query(`
      SELECT 
        COUNT(*) as export_count,
        SUM(user_count) as total_users
      FROM export_approval_requests
      WHERE admin_id = $1
        AND DATE(created_at) = $2
        AND status IN ('approved', 'pending')
    `, [adminId, today]);
    
    const stats = result.rows[0];
    
    // 检查单日导出频次
    if (parseInt(stats.export_count) >= this.thresholds.adminExportFrequency) {
      return {
        type: 'ADMIN_EXPORT_FREQUENCY',
        severity: 'critical',
        message: `管理员单日导出次数异常（${stats.export_count}次）`,
        count: stats.export_count,
        threshold: this.thresholds.adminExportFrequency
      };
    }
    
    // 检查导出用户总数
    if (parseInt(stats.total_users) >= this.thresholds.adminBulkExportUsers) {
      return {
        type: 'ADMIN_BULK_EXPORT',
        severity: 'critical',
        message: `管理员导出用户数量异常（${stats.total_users}用户）`,
        count: stats.total_users,
        threshold: this.thresholds.adminBulkExportUsers
      };
    }
    
    return null;
  }

  /**
   * 检测异常时段
   */
  _detectAbnormalTime() {
    const hour = new Date().getHours();
    
    if (this.thresholds.abnormalHours.includes(hour)) {
      return {
        type: 'ABNORMAL_TIME',
        severity: 'medium',
        message: `异常时段导出数据（${hour}:00）`,
        hour
      };
    }
    
    return null;
  }

  /**
   * 检测突发性导出（系统级）
   */
  async _detectBurstExport() {
    const key = 'export:system:burst';
    const now = Date.now();
    const windowStart = now - this.thresholds.burstExportWindow * 1000;
    
    const count = await this.redis.zcount(key, windowStart, '+inf');
    
    if (count >= this.thresholds.burstExportCount) {
      return {
        type: 'BURST_EXPORT',
        severity: 'critical',
        message: `系统短时间内大量导出（${count}次）`,
        count,
        threshold: this.thresholds.burstExportCount
      };
    }
    
    return null;
  }

  /**
   * 检测行为变化
   */
  async _detectBehaviorChange(userId, isAdmin) {
    // 获取用户历史导出行为基线
    const baseline = await this._getUserBaseline(userId, isAdmin);
    
    // 获取近期行为
    const recent = await this._getRecentBehavior(userId, isAdmin);
    
    // 对比检测
    if (recent.exportCount > baseline.avgExportCount * 3) {
      return {
        type: 'BEHAVIOR_CHANGE',
        severity: 'high',
        message: '导出行为显著偏离历史基线',
        baseline: baseline.avgExportCount,
        recent: recent.exportCount,
        deviationRate: ((recent.exportCount - baseline.avgExportCount) / baseline.avgExportCount * 100).toFixed(1)
      };
    }
    
    return null;
  }

  /**
   * 计算风险分数
   */
  _calculateRiskScore(anomalies) {
    const severityWeights = {
      critical: 40,
      high: 25,
      medium: 10,
      low: 5
    };
    
    const score = anomalies.reduce((sum, anomaly) => {
      return sum + (severityWeights[anomaly.severity] || 0);
    }, 0);
    
    return Math.min(score, 100);  // 上限100分
  }

  /**
   * 获取推荐操作
   */
  _getRecommendedAction(anomalies) {
    const score = this._calculateRiskScore(anomalies);
    
    if (score >= this.thresholds.blockThreshold) {
      return {
        action: 'BLOCK_AND_ALERT',
        message: '阻止导出并立即告警',
        requiresApproval: true
      };
    } else if (score >= this.thresholds.mfaThreshold) {
      return {
        action: 'REQUIRE_MFA',
        message: '需要二次身份验证',
        requiresApproval: false
      };
    } else if (score >= this.thresholds.monitorThreshold) {
      return {
        action: 'LOG_AND_MONITOR',
        message: '记录日志并持续监控',
        requiresApproval: false
      };
    }
    
    return {
      action: 'ALLOW_WITH_LOG',
      message: '允许导出并记录日志',
      requiresApproval: false
    };
  }

  /**
   * 记录异常日志
   */
  async _logAnomaly(userId, anomalies) {
    try {
      await this.db.query(`
        INSERT INTO export_anomaly_log
          (user_id, anomalies, risk_score, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [userId, JSON.stringify(anomalies), this._calculateRiskScore(anomalies)]);
    } catch (err) {
      // 如果表不存在，创建表
      await this._ensureAnomalyTableExists();
      await this.db.query(`
        INSERT INTO export_anomaly_log
          (user_id, anomalies, risk_score, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [userId, JSON.stringify(anomalies), this._calculateRiskScore(anomalies)]);
    }
  }

  /**
   * 获取用户基线
   */
  async _getUserBaseline(userId, isAdmin) {
    // 简化实现：返回平均基线
    return {
      avgExportCount: isAdmin ? 2 : 0.5
    };
  }

  /**
   * 获取近期行为
   */
  async _getRecentBehavior(userId, isAdmin) {
    const result = await this.db.query(`
      SELECT COUNT(*) as export_count
      FROM export_audit_log
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '7 days'
    `, [userId]);
    
    return {
      exportCount: parseInt(result.rows[0].export_count)
    };
  }

  /**
   * 确保异常日志表存在
   */
  async _ensureAnomalyTableExists() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS export_anomaly_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        anomalies JSONB NOT NULL,
        risk_score INTEGER NOT NULL,
        action_taken VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  /**
   * 记录导出操作（用于实时监控）
   */
  async recordExportActivity(userId) {
    const key = `export:rapid:${userId}`;
    const now = Date.now();
    
    await this.redis.zadd(key, now, `export_${now}`);
    await this.redis.expire(key, this.thresholds.rapidExportWindow);
    
    // 系统级突发检测
    const systemKey = 'export:system:burst';
    await this.redis.zadd(systemKey, now, `system_${userId}_${now}`);
    await this.redis.expire(systemKey, this.thresholds.burstExportWindow);
  }

  /**
   * 获取最近异常列表
   */
  async getRecentAnomalies(limit = 50) {
    const result = await this.db.query(`
      SELECT 
        user_id, 
        anomalies, 
        risk_score,
        action_taken,
        created_at
      FROM export_anomaly_log
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows;
  }

  /**
   * 获取高风险用户列表
   */
  async getHighRiskUsers(limit = 20) {
    const result = await this.db.query(`
      SELECT 
        user_id,
        SUM(risk_score) as total_risk,
        COUNT(*) as anomaly_count,
        MAX(created_at) as last_anomaly
      FROM export_anomaly_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY user_id
      HAVING SUM(risk_score) >= 50
      ORDER BY total_risk DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows;
  }
}

module.exports = ExportAnomalyDetector;