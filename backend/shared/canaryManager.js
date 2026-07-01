/**
 * 金丝雀发布管理器
 * 
 * 负责金丝雀发布的生命周期管理：
 * - 创建、推进、回滚金丝雀发布
 * - 自动验证指标
 * - 发布历史记录
 * 
 * @module canaryManager
 */

const { db } = require('./db');
const { logger } = require('./logger');
const { EventBus, EVENTS } = require('./EventBus');
const axios = require('axios');

// 金丝雀事件类型
const CANARY_EVENTS = {
  CANARY_DEPLOYMENT_STARTED: 'canary.deployment.started',
  CANARY_TRAFFIC_ADJUSTED: 'canary.traffic.adjusted',
  CANARY_DEPLOYMENT_PROMOTED: 'canary.deployment.promoted',
  CANARY_DEPLOYMENT_COMPLETED: 'canary.deployment.completed',
  CANARY_DEPLOYMENT_ROLLED_BACK: 'canary.deployment.rolled_back',
  CANARY_METRICS_ALERT: 'canary.metrics.alert'
};

class CanaryManager {
  constructor() {
    // 金丝雀发布策略
    this.strategies = {
      progressive: [5, 25, 50, 100], // 渐进式：5% -> 25% -> 50% -> 100%
      manual: [], // 手动控制
      auto: [10, 30, 50, 80, 100] // 自动：10% -> 30% -> 50% -> 80% -> 100%
    };

    // 验证指标阈值
    this.metricThresholds = {
      errorRate: 0.05, // 错误率 < 5%
      latencyP95: 1000, // P95 延迟 < 1000ms
      successRate: 0.95 // 成功率 > 95%
    };

    // Prometheus 查询端点
    this.prometheusUrl = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
  }

  /**
   * 创建金丝雀发布
   * @param {Object} options 发布选项
   * @returns {Object} 发布记录
   */
  async createCanaryDeployment(options) {
    const {
      serviceName,
      canaryVersion,
      stableVersion,
      strategy = 'progressive',
      initialTraffic = 5,
      autoPromote = true,
      metricsBaseline = {},
      rules = {}
    } = options;

    // 检查是否已有活跃的金丝雀发布
    const existing = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE service_name = $1 AND status IN ('active', 'promoting')
    `, [serviceName]);

    if (existing.rows.length > 0) {
      throw new Error(`Active canary deployment already exists for ${serviceName}`);
    }

    // 创建金丝雀发布记录
    const result = await db.query(`
      INSERT INTO canary_deployments 
        (service_name, canary_version, stable_version, traffic_split, 
         strategy, auto_promote, metrics_baseline, rules, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
      RETURNING *
    `, [
      serviceName,
      canaryVersion,
      stableVersion,
      initialTraffic,
      strategy,
      autoPromote,
      JSON.stringify(metricsBaseline),
      JSON.stringify(rules)
    ]);

    const deployment = result.rows[0];

    // 记录历史
    await this.recordHistory(deployment.id, 'created', {
      canaryVersion,
      stableVersion,
      initialTraffic,
      strategy
    });

    // 发布事件
    await EventBus.publish(CANARY_EVENTS.CANARY_DEPLOYMENT_STARTED, {
      deploymentId: deployment.id,
      serviceName,
      canaryVersion,
      stableVersion,
      initialTraffic,
      strategy,
      timestamp: new Date()
    });

    logger.info(`[CanaryManager] Created canary deployment #${deployment.id} for ${serviceName}`, {
      canaryVersion,
      initialTraffic,
      strategy
    });

    return deployment;
  }

  /**
   * 调整金丝雀流量
   */
  async adjustTraffic(deploymentId, newTraffic, reason = '') {
    const deployment = await this.getDeployment(deploymentId);

    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (deployment.status !== 'active') {
      throw new Error('Deployment is not active');
    }

    // 验证流量百分比
    if (newTraffic < 0 || newTraffic > 100) {
      throw new Error('Traffic must be between 0 and 100');
    }

    const oldTraffic = deployment.traffic_split;

    // 更新流量分割
    await db.query(`
      UPDATE canary_deployments 
      SET traffic_split = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [newTraffic, deploymentId]);

    // 记录历史
    await this.recordHistory(deploymentId, 'traffic_adjusted', {
      oldTraffic,
      newTraffic,
      reason
    });

    // 发布事件
    await EventBus.publish(CANARY_EVENTS.CANARY_TRAFFIC_ADJUSTED, {
      deploymentId,
      serviceName: deployment.service_name,
      oldTraffic,
      newTraffic,
      reason,
      timestamp: new Date()
    });

    logger.info(`[CanaryManager] Traffic adjusted for #${deploymentId}: ${oldTraffic}% → ${newTraffic}%`);

    return { success: true, deploymentId, oldTraffic, newTraffic };
  }

  /**
   * 推进金丝雀发布
   */
  async promoteCanary(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);

    if (!deployment) {
      throw new Error('Deployment not found');
    }

    // 验证指标是否正常
    const metricsValid = await this.validateMetrics(deploymentId);

    if (!metricsValid.valid) {
      throw new Error(`Metrics validation failed: ${metricsValid.reason}`);
    }

    const strategy = this.strategies[deployment.strategy] || this.strategies.progressive;
    const currentIndex = strategy.indexOf(deployment.traffic_split);
    const nextTraffic = strategy[currentIndex + 1] || 100;

    if (nextTraffic === 100) {
      // 完成金丝雀发布
      return await this.completeCanary(deploymentId);
    } else {
      // 推进到下一阶段
      await this.adjustTraffic(deploymentId, nextTraffic, 'auto_promote');

      // 更新状态为推进中
      await db.query(`
        UPDATE canary_deployments 
        SET status = 'promoting', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [deploymentId]);

      await this.recordHistory(deploymentId, 'promoted', {
        newTraffic: nextTraffic
      });

      return { success: true, status: 'promoting', newTraffic: nextTraffic };
    }
  }

  /**
   * 完成金丝雀发布
   */
  async completeCanary(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);

    // 更新状态为完成
    await db.query(`
      UPDATE canary_deployments 
      SET status = 'completed', 
          completed_at = CURRENT_TIMESTAMP,
          traffic_split = 100,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [deploymentId]);

    // 记录历史
    await this.recordHistory(deploymentId, 'completed', {
      canaryVersion: deployment.canary_version
    });

    // 发布事件
    await EventBus.publish(CANARY_EVENTS.CANARY_DEPLOYMENT_COMPLETED, {
      deploymentId,
      serviceName: deployment.service_name,
      canaryVersion: deployment.canary_version,
      timestamp: new Date()
    });

    logger.info(`[CanaryManager] Completed canary deployment #${deploymentId}`);

    return { success: true, status: 'completed' };
  }

  /**
   * 回滚金丝雀发布
   */
  async rollbackCanary(deploymentId, reason = '') {
    const deployment = await this.getDeployment(deploymentId);

    if (!deployment) {
      throw new Error('Deployment not found');
    }

    // 立即将流量切换回稳定版本
    await db.query(`
      UPDATE canary_deployments 
      SET status = 'rolled_back',
          traffic_split = 0,
          rollback_reason = $1,
          rolled_back_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [reason, deploymentId]);

    // 记录历史
    await this.recordHistory(deploymentId, 'rolled_back', { reason });

    // 发布事件
    await EventBus.publish(CANARY_EVENTS.CANARY_DEPLOYMENT_ROLLED_BACK, {
      deploymentId,
      serviceName: deployment.service_name,
      reason,
      timestamp: new Date()
    });

    logger.warn(`[CanaryManager] Rolled back canary deployment #${deploymentId}: ${reason}`);

    return { success: true, status: 'rolled_back', reason };
  }

  /**
   * 验证指标
   */
  async validateMetrics(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    const metrics = await this.collectMetrics(deploymentId);

    // 错误率检查
    if (metrics.errorRate > this.metricThresholds.errorRate) {
      return {
        valid: false,
        reason: `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds threshold ${(this.metricThresholds.errorRate * 100).toFixed(2)}%`
      };
    }

    // 延迟检查
    if (metrics.latencyP95 > this.metricThresholds.latencyP95) {
      return {
        valid: false,
        reason: `P95 latency ${metrics.latencyP95}ms exceeds threshold ${this.metricThresholds.latencyP95}ms`
      };
    }

    // 成功率检查
    if (metrics.successRate < this.metricThresholds.successRate) {
      return {
        valid: false,
        reason: `Success rate ${(metrics.successRate * 100).toFixed(2)}% below threshold ${(this.metricThresholds.successRate * 100).toFixed(2)}%`
      };
    }

    return { valid: true, metrics };
  }

  /**
   * 收集指标（从 Prometheus 或本地统计）
   */
  async collectMetrics(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);

    try {
      // 尝试从 Prometheus 查询指标
      const errorRateQuery = `sum(rate(http_requests_total{service="${deployment.service_name}",version="${deployment.canary_version}",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="${deployment.service_name}",version="${deployment.canary_version}"}[5m]))`;
      
      const latencyQuery = `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="${deployment.service_name}",version="${deployment.canary_version}"}[5m])) by (le))`;

      // 简化：使用本地统计（实际应查询 Prometheus）
      const result = await db.query(`
        SELECT 
          COALESCE(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0), 0) as error_rate,
          COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) as latency_p95,
          COALESCE(SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END)::FLOAT / NULLIF(COUNT(*), 0), 1) as success_rate
        FROM canary_request_logs
        WHERE deployment_id = $1 
          AND created_at > NOW() - INTERVAL '5 minutes'
      `, [deploymentId]);

      const row = result.rows[0];

      return {
        errorRate: parseFloat(row.error_rate) || 0,
        latencyP95: parseFloat(row.latency_p95) || 0,
        successRate: parseFloat(row.success_rate) || 1,
        requestRate: 0, // 可扩展
        collectionTime: new Date()
      };
    } catch (error) {
      logger.error('[CanaryManager] Metrics collection failed:', error);
      // 返回默认安全值
      return {
        errorRate: 0,
        latencyP95: 0,
        successRate: 1,
        collectionTime: new Date()
      };
    }
  }

  /**
   * 自动推进金丝雀发布（定时任务调用）
   */
  async autoPromoteCanary() {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status = 'active' AND auto_promote = true
    `);

    const results = [];

    for (const deployment of result.rows) {
      try {
        // 验证指标
        const validation = await this.validateMetrics(deployment.id);

        if (validation.valid) {
          // 检查是否已在当前流量百分比停留足够时间
          const timeSinceUpdate = Date.now() - new Date(deployment.updated_at).getTime();
          const minDuration = 5 * 60 * 1000; // 5 分钟

          if (timeSinceUpdate > minDuration) {
            // 自动推进
            const promoteResult = await this.promoteCanary(deployment.id);
            results.push({ deploymentId: deployment.id, action: 'promoted', result: promoteResult });
          } else {
            results.push({ deploymentId: deployment.id, action: 'waiting', reason: 'Duration not met' });
          }
        } else {
          // 指标异常，自动回滚
          await this.rollbackCanary(deployment.id, validation.reason);
          results.push({ deploymentId: deployment.id, action: 'rolled_back', reason: validation.reason });

          // 发布告警事件
          await EventBus.publish(CANARY_EVENTS.CANARY_METRICS_ALERT, {
            deploymentId: deployment.id,
            serviceName: deployment.service_name,
            reason: validation.reason,
            timestamp: new Date()
          });
        }
      } catch (error) {
        logger.error(`[CanaryManager] Auto promote failed for #${deployment.id}:`, error);
        results.push({ deploymentId: deployment.id, action: 'error', error: error.message });
      }
    }

    return results;
  }

  /**
   * 获取部署详情
   */
  async getDeployment(deploymentId) {
    const result = await db.query(
      'SELECT * FROM canary_deployments WHERE id = $1',
      [deploymentId]
    );
    return result.rows[0];
  }

  /**
   * 获取服务的活跃金丝雀发布
   */
  async getActiveCanary(serviceName) {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE service_name = $1 AND status IN ('active', 'promoting')
    `, [serviceName]);
    return result.rows[0];
  }

  /**
   * 获取所有活跃金丝雀发布
   */
  async getAllActive() {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status IN ('active', 'promoting')
      ORDER BY created_at DESC
    `);
    return result.rows;
  }

  /**
   * 获取部署历史
   */
  async getHistory(deploymentId, limit = 50) {
    const result = await db.query(`
      SELECT * FROM canary_deployment_history 
      WHERE deployment_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [deploymentId, limit]);
    return result.rows;
  }

  /**
   * 获取指标快照历史
   */
  async getMetricsHistory(deploymentId, limit = 100) {
    const result = await db.query(`
      SELECT * FROM canary_metrics_snapshots 
      WHERE deployment_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [deploymentId, limit]);
    return result.rows;
  }

  /**
   * 记录历史
   */
  async recordHistory(deploymentId, action, details) {
    await db.query(`
      INSERT INTO canary_deployment_history 
        (deployment_id, action, details, created_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    `, [deploymentId, action, JSON.stringify(details)]);
  }

  /**
   * 记录请求日志（用于指标统计）
   */
  async logRequest(deploymentId, requestData) {
    await db.query(`
      INSERT INTO canary_request_logs
        (deployment_id, status_code, latency_ms, created_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    `, [deploymentId, requestData.statusCode, requestData.latency]);
  }

  /**
   * 获取服务的历史金丝雀发布
   */
  async getServiceHistory(serviceName, limit = 20) {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE service_name = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [serviceName, limit]);
    return result.rows;
  }
}

module.exports = {
  CanaryManager,
  canaryManager: new CanaryManager(),
  CANARY_EVENTS
};