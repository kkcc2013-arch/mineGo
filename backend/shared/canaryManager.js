/**
 * 金丝雀发布管理器
 * 
 * 实现金丝雀发布的创建、管理、监控和回滚
 */

const { db } = require('./db');
const logger = require('./logger');
const { EventBus, EVENTS } = require('./EventBus');

class CanaryManager {
  constructor() {
    // 金丝雀发布策略
    this.strategies = {
      progressive: [5, 25, 50, 100], // 渐进式：5% -> 25% -> 50% -> 100%
      manual: [], // 手动控制
      auto: [10, 30, 50, 80, 100], // 自动：10% -> 30% -> 50% -> 80% -> 100%
      'user-segment': [10, 25, 50, 100] // 用户分片
    };
    
    // 验证指标阈值
    this.metricThresholds = {
      errorRate: 0.05, // 错误率 < 5%
      latencyP95: 1000, // P95 延迟 < 1000ms
      successRate: 0.95 // 成功率 > 95%
    };
    
    // 初始化定时任务
    this.initializeAutoPromote();
  }
  
  /**
   * 创建金丝雀发布
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
      createdBy = null
    } = options;
    
    try {
      // 检查是否已有活跃的金丝雀发布
      const existing = await db.query(`
        SELECT * FROM canary_deployments 
        WHERE service_name = $1 AND status IN ('active', 'promoting')
      `, [serviceName]);
      
      if (existing.rows.length > 0) {
        throw new Error('Active canary deployment already exists for this service');
      }
      
      // 创建金丝雀发布记录
      const result = await db.query(`
        INSERT INTO canary_deployments 
          (service_name, canary_version, stable_version, traffic_split, 
           strategy, auto_promote, metrics_baseline, status, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
        RETURNING *
      `, [serviceName, canaryVersion, stableVersion, initialTraffic, 
          strategy, autoPromote, JSON.stringify(metricsBaseline), createdBy]);
      
      const deployment = result.rows[0];
      
      // 记录历史
      await this.recordHistory(deployment.id, 'created', {
        serviceName,
        canaryVersion,
        stableVersion,
        initialTraffic,
        strategy,
        autoPromote
      });
      
      // 发布事件
      if (EventBus) {
        await EventBus.publish(EVENTS.CANARY_DEPLOYMENT_STARTED, {
          deploymentId: deployment.id,
          serviceName,
          canaryVersion,
          initialTraffic,
          timestamp: new Date()
        });
      }
      
      logger.info('Canary deployment created', {
        deploymentId: deployment.id,
        serviceName,
        canaryVersion,
        initialTraffic
      });
      
      return deployment;
    } catch (error) {
      logger.error('Failed to create canary deployment', {
        error: error.message,
        serviceName,
        canaryVersion
      });
      throw error;
    }
  }
  
  /**
   * 调整金丝雀流量
   */
  async adjustTraffic(deploymentId, newTraffic) {
    const deployment = await this.getDeployment(deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    
    if (deployment.status !== 'active' && deployment.status !== 'promoting') {
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
      SET traffic_split = $1, 
          updated_at = CURRENT_TIMESTAMP,
          status = CASE WHEN $1 = 100 THEN 'promoting' ELSE status END
      WHERE id = $2
    `, [newTraffic, deploymentId]);
    
    // 记录历史
    await this.recordHistory(deploymentId, 'traffic_adjusted', {
      oldTraffic,
      newTraffic
    });
    
    // 发布事件
    if (EventBus) {
      await EventBus.publish(EVENTS.CANARY_TRAFFIC_ADJUSTED, {
        deploymentId,
        serviceName: deployment.service_name,
        oldTraffic,
        newTraffic,
        timestamp: new Date()
      });
    }
    
    logger.info('Canary traffic adjusted', {
      deploymentId,
      serviceName: deployment.service_name,
      oldTraffic,
      newTraffic
    });
    
    return { success: true, oldTraffic, newTraffic };
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
    
    logger.info('Promoting canary deployment', {
      deploymentId,
      currentTraffic: deployment.traffic_split,
      nextTraffic
    });
    
    if (nextTraffic === 100) {
      // 完成金丝雀发布，全部切换到新版本
      return await this.completeCanary(deploymentId);
    } else {
      // 推进到下一阶段
      return await this.adjustTraffic(deploymentId, nextTraffic);
    }
  }
  
  /**
   * 完成金丝雀发布
   */
  async completeCanary(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    
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
      canaryVersion: deployment.canary_version,
      duration: Date.now() - new Date(deployment.started_at).getTime()
    });
    
    // 发布事件
    if (EventBus) {
      await EventBus.publish(EVENTS.CANARY_DEPLOYMENT_COMPLETED, {
        deploymentId,
        serviceName: deployment.service_name,
        canaryVersion: deployment.canary_version,
        timestamp: new Date()
      });
    }
    
    logger.info('Canary deployment completed', {
      deploymentId,
      serviceName: deployment.service_name,
      canaryVersion: deployment.canary_version
    });
    
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
    if (EventBus) {
      await EventBus.publish(EVENTS.CANARY_DEPLOYMENT_ROLLED_BACK, {
        deploymentId,
        serviceName: deployment.service_name,
        reason,
        timestamp: new Date()
      });
    }
    
    logger.warn('Canary deployment rolled back', {
      deploymentId,
      serviceName: deployment.service_name,
      reason
    });
    
    return { success: true, status: 'rolled_back', reason };
  }
  
  /**
   * 验证指标
   */
  async validateMetrics(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    const metrics = await this.collectMetrics(deploymentId);
    
    // 对比基线指标
    const baseline = deployment.metrics_baseline || {};
    
    // 错误率检查
    if (metrics.errorRate > this.metricThresholds.errorRate) {
      return {
        valid: false,
        reason: `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds threshold ${(this.metricThresholds.errorRate * 100)}%`,
        metrics
      };
    }
    
    // 延迟检查
    if (metrics.latencyP95 > this.metricThresholds.latencyP95) {
      return {
        valid: false,
        reason: `P95 latency ${metrics.latencyP95}ms exceeds threshold ${this.metricThresholds.latencyP95}ms`,
        metrics
      };
    }
    
    // 成功率检查
    if (metrics.successRate < this.metricThresholds.successRate) {
      return {
        valid: false,
        reason: `Success rate ${(metrics.successRate * 100).toFixed(2)}% below threshold ${(this.metricThresholds.successRate * 100)}%`,
        metrics
      };
    }
    
    return { valid: true, metrics };
  }
  
  /**
   * 收集指标
   */
  async collectMetrics(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    
    // 从 Prometheus 或监控系统查询指标
    // 这里简化为模拟数据，实际应查询 Prometheus
    const metrics = {
      errorRate: Math.random() * 0.05, // 模拟错误率 0-5%
      latencyP95: 300 + Math.random() * 400, // 模拟延迟 300-700ms
      latencyP50: 100 + Math.random() * 150, // 模拟延迟 100-250ms
      successRate: 0.95 + Math.random() * 0.05, // 模拟成功率 95-100%
      requestRate: 800 + Math.random() * 400, // 模拟请求率
      timestamp: new Date().toISOString()
    };
    
    // 保存指标快照
    await db.query(`
      INSERT INTO canary_metrics_snapshots 
        (deployment_id, metrics, created_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
    `, [deploymentId, JSON.stringify(metrics)]);
    
    return metrics;
  }
  
  /**
   * 自动推进金丝雀发布
   */
  initializeAutoPromote() {
    // 每 5 分钟检查一次
    setInterval(async () => {
      try {
        await this.autoPromoteCanary();
      } catch (error) {
        logger.error('Auto promote check failed', { error: error.message });
      }
    }, 5 * 60 * 1000);
  }
  
  /**
   * 自动推进金丝雀发布
   */
  async autoPromoteCanary() {
    // 查询所有启用自动推进的活跃金丝雀发布
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status IN ('active', 'promoting') AND auto_promote = true
    `);
    
    for (const deployment of result.rows) {
      try {
        // 验证指标
        const validation = await this.validateMetrics(deployment.id);
        
        if (validation.valid) {
          // 检查是否已在当前流量百分比停留足够时间
          const timeSinceUpdate = Date.now() - new Date(deployment.updated_at).getTime();
          const minDuration = 5 * 60 * 1000; // 5 分钟
          
          if (timeSinceUpdate > minDuration) {
            logger.info('Auto promoting canary deployment', {
              deploymentId: deployment.id,
              serviceName: deployment.service_name,
              currentTraffic: deployment.traffic_split
            });
            
            // 自动推进
            await this.promoteCanary(deployment.id);
          }
        } else {
          // 指标异常，自动回滚
          logger.warn('Metrics validation failed, auto rolling back', {
            deploymentId: deployment.id,
            serviceName: deployment.service_name,
            reason: validation.reason
          });
          
          await this.rollbackCanary(deployment.id, `Auto rollback: ${validation.reason}`);
        }
      } catch (error) {
        logger.error('Auto promote failed for deployment', {
          deploymentId: deployment.id,
          error: error.message
        });
      }
    }
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
   * 获取所有金丝雀发布
   */
  async getAllDeployments(limit = 100) {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  }
  
  /**
   * 获取部署历史
   */
  async getDeploymentHistory(deploymentId, limit = 50) {
    const result = await db.query(`
      SELECT * FROM canary_deployment_history 
      WHERE deployment_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [deploymentId, limit]);
    return result.rows;
  }
  
  /**
   * 获取指标快照
   */
  async getMetricsSnapshots(deploymentId, limit = 100) {
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
}

module.exports = new CanaryManager();
