/**
 * 预测型调度算法
 * 实现主动扩缩容（Proactive Scaling）
 */

const logger = require('../../shared/logger');
const TrafficAnalyzer = require('./trafficAnalyzer');

class PredictiveScheduler {
  constructor(config = {}) {
    this.config = {
      proactiveScalingWindow: config.proactiveScalingWindow || 15 * 60 * 1000, // 提前15分钟
      minReplicas: config.minReplicas || 2,
      maxReplicas: config.maxReplicas || 50,
      scalingCooldown: config.scalingCooldown || 5 * 60 * 1000, // 5分钟冷却期
      thresholds: {
        cpu: config.cpuThreshold || 70,
        memory: config.memoryThreshold || 80,
        requests: config.requestsThreshold || 1000
      },
      ...config
    };

    this.trafficAnalyzer = new TrafficAnalyzer(config);
    this.lastScalingAction = null;
    this.currentReplicas = new Map();
    this.predictions = [];
  }

  /**
   * 初始化调度器
   */
  async initialize() {
    await this.trafficAnalyzer.initialize();
    logger.info('PredictiveScheduler initialized', {
      proactiveScalingWindow: this.config.proactiveScalingWindow,
      minReplicas: this.config.minReplicas,
      maxReplicas: this.config.maxReplicas
    });
    return true;
  }

  /**
   * 执行预测调度
   */
  async executeScheduling() {
    try {
      // 1. 获取流量预测
      const prediction = await this.trafficAnalyzer.predictTrafficTrend();
      if (!prediction) {
        logger.warn('No prediction available, using reactive scaling');
        return await this.reactiveScaling();
      }

      this.predictions = prediction.predictions;

      // 2. 计算未来15分钟的资源需求
      const futureNeeds = this.calculateFutureNeeds(prediction);

      // 3. 决定是否需要主动扩容
      const scalingDecision = this.makeScalingDecision(futureNeeds);

      // 4. 执行扩缩容
      if (scalingDecision.action !== 'none') {
        await this.executeScalingAction(scalingDecision);
      }

      // 5. 记录预测结果（用于后续准确率验证）
      await this.recordPrediction(prediction.summary);

      return scalingDecision;
    } catch (error) {
      logger.error('Failed to execute predictive scheduling', { error: error.message });
      throw error;
    }
  }

  /**
   * 计算未来资源需求
   */
  calculateFutureNeeds(prediction) {
    const proactiveWindow = Date.now() + this.config.proactiveScalingWindow;
    
    // 找到未来15分钟内的预测
    const futurePredictions = prediction.predictions.filter(p => 
      p.timestamp.getTime() <= proactiveWindow
    );

    if (futurePredictions.length === 0) {
      return null;
    }

    // 计算平均和峰值需求
    const avgRequests = futurePredictions.reduce((sum, p) => sum + p.predictedRequests, 0) / futurePredictions.length;
    const maxRequests = Math.max(...futurePredictions.map(p => p.predictedRequests));
    const minConfidence = Math.min(...futurePredictions.map(p => p.confidence));

    // 转换为资源需求（基于经验公式）
    const avgReplicasNeeded = Math.ceil(avgRequests / this.config.thresholds.requests);
    const maxReplicasNeeded = Math.ceil(maxRequests / this.config.thresholds.requests);

    return {
      avgReplicas: avgReplicasNeeded,
      maxReplicas: maxReplicasNeeded,
      avgRequests: Math.round(avgRequests),
      maxRequests: Math.round(maxRequests),
      confidence: minConfidence,
      timeWindow: this.config.proactiveScalingWindow
    };
  }

  /**
   * 制定扩缩容决策
   */
  makeScalingDecision(futureNeeds) {
    if (!futureNeeds) {
      return { action: 'none', reason: 'no_prediction' };
    }

    const currentReplicas = this.getCurrentReplicaCount();
    const currentTraffic = this.trafficAnalyzer.historicalData[this.trafficAnalyzer.historicalData.length - 1];

    // 检查冷却期
    if (this.lastScalingAction && Date.now() - this.lastScalingAction.timestamp < this.config.scalingCooldown) {
      return { action: 'none', reason: 'cooldown_period' };
    }

    let decision = {
      action: 'none',
      currentReplicas,
      targetReplicas: currentReplicas,
      reason: '',
      confidence: futureNeeds.confidence
    };

    // 主动扩容逻辑：未来需求高于当前
    if (futureNeeds.maxReplicas > currentReplicas) {
      const neededReplicas = Math.min(futureNeeds.maxReplicas, this.config.maxReplicas);
      
      // 只有在置信度足够高时才主动扩容
      if (futureNeeds.confidence >= 0.75) {
        decision.action = 'scale_up';
        decision.targetReplicas = neededReplicas;
        decision.reason = `proactive_scaling: predicted traffic ${futureNeeds.maxRequests} req/s requires ${neededReplicas} replicas`;
      } else {
        decision.reason = `low_confidence: ${futureNeeds.confidence.toFixed(2)}, waiting for reactive scaling`;
      }
    }

    // 主动缩容逻辑：未来需求明显低于当前
    if (futureNeeds.avgReplicas < currentReplicas * 0.6 && currentTraffic.requestCount < futureNeeds.avgRequests * 0.5) {
      const targetReplicas = Math.max(futureNeeds.avgReplicas, this.config.minReplicas);
      
      if (futureNeeds.confidence >= 0.8) {
        decision.action = 'scale_down';
        decision.targetReplicas = targetReplicas;
        decision.reason = `proactive_scaling: predicted low traffic ${futureNeeds.avgRequests} req/s, scaling down to ${targetReplicas} replicas`;
      }
    }

    // 记录决策
    logger.info('Scaling decision made', {
      action: decision.action,
      currentReplicas,
      targetReplicas: decision.targetReplicas,
      reason: decision.reason,
      confidence: decision.confidence
    });

    return decision;
  }

  /**
   * 执行扩缩容动作
   */
  async executeScalingAction(decision) {
    if (decision.action === 'none') {
      return false;
    }

    try {
      // 更新 Kubernetes 自定义指标（供 HPA 使用）
      await this.updateCustomMetrics(decision);

      // 触发 HPA 扩缩容
      await this.triggerHPAScaling(decision.targetReplicas);

      // 记录扩缩容动作
      this.lastScalingAction = {
        action: decision.action,
        timestamp: Date.now(),
        from: decision.currentReplicas,
        to: decision.targetReplicas,
        reason: decision.reason
      };

      logger.info('Scaling action executed', {
        action: decision.action,
        from: decision.currentReplicas,
        to: decision.targetReplicas
      });

      return true;
    } catch (error) {
      logger.error('Failed to execute scaling action', {
        action: decision.action,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 更新自定义指标
   */
  async updateCustomMetrics(decision) {
    const metrics = {
      predicted_replicas_needed: decision.targetReplicas,
      scaling_action: decision.action === 'scale_up' ? 1 : (decision.action === 'scale_down' ? -1 : 0),
      confidence: decision.confidence,
      timestamp: Date.now()
    };

    // 将指标推送到 Prometheus Adapter
    const { getRedisClient } = require('../../shared/redis');
    const redisClient = await getRedisClient();

    await redisClient.hset('k8s:custom_metrics:minego', 
      'predicted_replicas', metrics.predicted_replicas_needed,
      'scaling_action', metrics.scaling_action,
      'confidence', metrics.confidence
    );

    logger.info('Custom metrics updated', metrics);
  }

  /**
   * 触发 HPA 扩缩容
   */
  async triggerHPAScaling(targetReplicas) {
    // 通过 Kubernetes API 更新 HPA 配置
    const k8s = require('@kubernetes/client-node');

    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    const autoscalingV2 = kc.makeApiClient(k8s.AutoscalingV2Api);

    const namespace = 'minego';
    const hpaName = 'minego-gateway-hpa';

    try {
      // 获取当前 HPA 配置
      const currentHPA = await autoscalingV2.readNamespacedHorizontalPodAutoscaler(hpaName, namespace);

      // 更新目标副本数
      const patch = {
        spec: {
          minReplicas: Math.min(targetReplicas, currentHPA.body.spec.maxReplicas),
          maxReplicas: currentHPA.body.spec.maxReplicas
        }
      };

      await autoscalingV2.patchNamespacedHorizontalPodAutoscaler(
        hpaName,
        namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );

      logger.info('HPA configuration updated', {
        hpa: hpaName,
        namespace,
        newMinReplicas: patch.spec.minReplicas
      });

      return true;
    } catch (error) {
      logger.error('Failed to update HPA configuration', {
        error: error.message
      });
      
      // 如果 Kubernetes API 失败，降级为本地标记
      this.currentReplicas.set('gateway', targetReplicas);
      return false;
    }
  }

  /**
   * 响应式扩缩容（降级方案）
   */
  async reactiveScaling() {
    const currentTraffic = await this.trafficAnalyzer.collectCurrentTraffic();
    const currentReplicas = this.getCurrentReplicaCount();

    let targetReplicas = currentReplicas;

    // 基于当前 CPU/内存/请求指标
    if (currentTraffic.requestCount > this.config.thresholds.requests * currentReplicas * 0.8) {
      targetReplicas = Math.min(currentReplicas + 2, this.config.maxReplicas);
    } else if (currentTraffic.requestCount < this.config.thresholds.requests * currentReplicas * 0.3) {
      targetReplicas = Math.max(currentReplicas - 1, this.config.minReplicas);
    }

    if (targetReplicas !== currentReplicas) {
      await this.executeScalingAction({
        action: targetReplicas > currentReplicas ? 'scale_up' : 'scale_down',
        currentReplicas,
        targetReplicas,
        reason: 'reactive_scaling',
        confidence: 1.0
      });
    }

    return {
      action: targetReplicas !== currentReplicas ? 'reactive_scaling' : 'none',
      currentReplicas,
      targetReplicas
    };
  }

  /**
   * 获取当前副本数
   */
  getCurrentReplicaCount() {
    // 从 Kubernetes 或本地缓存获取
    return this.currentReplicas.get('gateway') || this.config.minReplicas;
  }

  /**
   * 记录预测结果
   */
  async recordPrediction(summary) {
    const { getDatabasePool } = require('../../shared/database');
    const pool = await getDatabasePool();

    const query = `
      INSERT INTO traffic_predictions (timestamp, predicted_value, confidence, metadata)
      VALUES (NOW(), $1, $2, $3)
    `;

    await pool.query(query, [
      summary.avgPredictedRequests,
      summary.confidence,
      JSON.stringify(summary)
    ]);

    logger.info('Prediction recorded', {
      predictedValue: summary.avgPredictedRequests,
      confidence: summary.confidence
    });
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const analyzerHealth = await this.trafficAnalyzer.healthCheck();

    return {
      status: 'healthy',
      lastScalingAction: this.lastScalingAction,
      predictionsCount: this.predictions.length,
      trafficAnalyzer: analyzerHealth
    };
  }

  /**
   * 关闭资源
   */
  async shutdown() {
    await this.trafficAnalyzer.shutdown();
    logger.info('PredictiveScheduler shutdown complete');
  }
}

module.exports = PredictiveScheduler;
