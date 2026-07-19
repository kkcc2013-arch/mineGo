// backend/shared/k8s-operator/controllers/DeploymentHealthCheckController.js
// REQ-00592: 生产环境部署健康检查与自动回滚系统

'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('../logger');
const { metrics } = require('../metrics');
const PrometheusClient = require('../PrometheusClient');
const KubernetesClient = require('../KubernetesClient');
const NotificationService = require('../NotificationService');

const logger = createLogger('deployment-health-check-controller');

/**
 * 部署健康检查控制器
 * 
 * 监控新部署的服务健康状态，自动触发回滚
 */
class DeploymentHealthCheckController extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // 依赖组件
    this.k8sClient = options.k8sClient || new KubernetesClient();
    this.promClient = options.promClient || new PrometheusClient();
    this.notifier = options.notifier || new NotificationService();
    
    // 配置
    this.defaultWindowSeconds = options.defaultWindowSeconds || 300;
    this.defaultCheckInterval = options.defaultCheckInterval || 10000;
    this.defaultErrorRateThreshold = options.defaultErrorRateThreshold || 0.01;
    this.defaultLatencyThresholdMs = options.defaultLatencyThresholdMs || 2000;
    
    // 状态
    this.activeChecks = new Map(); // deployment -> check state
    this.checkIntervals = new Map();
    
    // 指标
    this.metrics = {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      rollbacksTriggered: 0,
      totalDowntime: 0
    };
    
    logger.info('DeploymentHealthCheckController initialized');
  }

  /**
   * 启动健康检查
   * @param {Object} healthCheck - DeploymentHealthCheck CRD 对象
   */
  async startHealthCheck(healthCheck) {
    const {
      metadata: { name, namespace = 'pmg' },
      spec: {
        targetDeployment,
        windowSeconds = this.defaultWindowSeconds,
        checkIntervalSeconds = 10,
        errorRateThreshold = this.defaultErrorRateThreshold,
        latencyThresholdMs = this.defaultLatencyThresholdMs,
        restartCountThreshold = 3,
        rollbackConfig = {},
        probes = {}
      }
    } = healthCheck;

    const checkId = `${namespace}/${targetDeployment}`;
    
    // 避免重复检查
    if (this.activeChecks.has(checkId)) {
      logger.warn({ checkId }, 'Health check already active');
      return;
    }

    // 获取当前部署状态
    const deployment = await this.k8sClient.getDeployment(namespace, targetDeployment);
    const currentRevision = deployment.metadata.annotations['deployment.kubernetes.io/revision'];
    const previousRevision = await this.getPreviousRevision(namespace, targetDeployment);

    // 初始化检查状态
    const checkState = {
      id: checkId,
      healthCheckName: name,
      namespace,
      targetDeployment,
      currentRevision,
      previousRevision,
      startTime: Date.now(),
      endTime: null,
      windowSeconds,
      errorRateThreshold,
      latencyThresholdMs,
      restartCountThreshold,
      rollbackConfig,
      probes,
      phase: 'Monitoring',
      checksTotal: 0,
      checksPassed: 0,
      checksFailed: 0,
      currentErrorRate: 0,
      currentLatencyP99: 0,
      restartCounts: new Map(), // pod -> restart count
      consecutiveFailures: 0,
      rollbackTriggered: false
    };

    this.activeChecks.set(checkId, checkState);
    this.metrics.totalChecks++;

    logger.info({
      checkId,
      targetDeployment,
      currentRevision,
      previousRevision,
      windowSeconds
    }, 'Starting deployment health check');

    // 启动定时检查
    const intervalId = setInterval(
      () => this.performCheck(checkId).catch(err =>
        logger.error({ error: err.message, checkId }, 'Health check failed')
      ),
      checkIntervalSeconds * 1000
    );
    this.checkIntervals.set(checkId, intervalId);

    // 设置超时
    setTimeout(() => this.completeHealthCheck(checkId), windowSeconds * 1000);
  }

  /**
   * 执行单次健康检查
   */
  async performCheck(checkId) {
    const state = this.activeChecks.get(checkId);
    if (!state) return;

    state.checksTotal++;

    try {
      // 1. HTTP 健康探针检查
      const httpHealthy = await this.checkHttpProbe(state);
      
      // 2. 从 Prometheus 获取错误率
      const errorRate = await this.queryErrorRate(state);
      state.currentErrorRate = errorRate;
      
      // 3. 从 Prometheus 获取延迟
      const latency = await this.queryLatency(state);
      state.currentLatencyP99 = latency;
      
      // 4. 检查 Pod 重启次数
      const restartExceeded = await this.checkRestartCount(state);
      
      // 5. 检查条件
      const errorRateExceeded = errorRate > state.errorRateThreshold;
      const latencyExceeded = latency > state.latencyThresholdMs;
      
      const isHealthy = httpHealthy && !errorRateExceeded && !latencyExceeded && !restartExceeded;
      
      if (isHealthy) {
        state.checksPassed++;
        state.consecutiveFailures = 0;
        this.updatePhase(state, 'Healthy');
      } else {
        state.checksFailed++;
        state.consecutiveFailures++;
        
        const reasons = [];
        if (!httpHealthy) reasons.push(`HTTP probe failed`);
        if (errorRateExceeded) reasons.push(`error rate ${((errorRate) * 100).toFixed(2)}% > ${((state.errorRateThreshold) * 100).toFixed(2)}%`);
        if (latencyExceeded) reasons.push(`latency ${latency}ms > ${state.latencyThresholdMs}ms`);
        if (restartExceeded) reasons.push(`restart count exceeded`);
        
        logger.warn({
          checkId,
          consecutiveFailures: state.consecutiveFailures,
          reasons
        }, 'Health check failed');
        
        // 连续失败达到阈值，触发回滚
        if (state.consecutiveFailures >= 3 && !state.rollbackTriggered) {
          await this.triggerRollback(state, reasons.join('; '));
        }
      }
      
      // 更新 CRD 状态
      await this.updateHealthCheckStatus(state);
      
    } catch (error) {
      logger.error({ error: error.message, checkId }, 'Check execution failed');
      state.checksFailed++;
    }
  }

  /**
   * HTTP 探针检查
   */
  async checkHttpProbe(state) {
    const {
      namespace,
      targetDeployment,
      probes
    } = state;
    
    const httpPath = probes.httpPath || '/health';
    const httpPort = probes.httpPort || 8080;
    
    try {
      // 获取 Pod 列表
      const pods = await this.k8sClient.listPods(namespace, {
        labelSelector: `app=${targetDeployment}`
      });
      
      if (pods.items.length === 0) {
        logger.warn({ targetDeployment }, 'No pods found');
        return false;
      }
      
      // 检查每个 Pod 的健康状态
      let healthyCount = 0;
      for (const pod of pods.items) {
        if (pod.status.phase !== 'Running') continue;
        
        // 通过端口转发检查（简化版，生产环境应使用 Service）
        const podName = pod.metadata.name;
        try {
          const result = await this.k8sClient.execInPod(
            namespace,
            podName,
            `curl -sf http://localhost:${httpPort}${httpPath}`
          );
          if (result.includes('healthy') || result.includes('ok')) {
            healthyCount++;
          }
        } catch {
          // 探针失败
        }
      }
      
      const successThreshold = probes.successThreshold || 1;
      return healthyCount >= successThreshold;
      
    } catch (error) {
      logger.error({ error: error.message }, 'HTTP probe check failed');
      return false;
    }
  }

  /**
   * 从 Prometheus 查询错误率
   */
  async queryErrorRate(state) {
    const { targetDeployment } = state;
    
    try {
      const query = `sum(rate(http_requests_total{status=~"5..",service="${targetDeployment}"}[1m]))/sum(rate(http_requests_total{service="${targetDeployment}"}[1m]))`;
      const result = await this.promClient.query(query);
      return parseFloat(result) || 0;
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to query error rate');
      return 0;
    }
  }

  /**
   * 从 Prometheus 查询延迟
   */
  async queryLatency(state) {
    const { targetDeployment } = state;
    
    try {
      const query = `histogram_quantile(0.99,sum(rate(http_request_duration_seconds_bucket{service="${targetDeployment}"}[1m]))by(le))`;
      const result = await this.promClient.query(query);
      return (parseFloat(result) || 0) * 1000; // 转换为毫秒
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to query latency');
      return 0;
    }
  }

  /**
   * 检查重启次数
   */
  async checkRestartCount(state) {
    const { namespace, targetDeployment, restartCountThreshold } = state;
    
    try {
      const pods = await this.k8sClient.listPods(namespace, {
        labelSelector: `app=${targetDeployment}`
      });
      
      let maxRestarts = 0;
      for (const pod of pods.items) {
        for (const container of pod.status.containerStatuses || []) {
          const restarts = container.restartCount || 0;
          state.restartCounts.set(pod.metadata.name, restarts);
          maxRestarts = Math.max(maxRestarts, restarts);
        }
      }
      
      return maxRestarts >= restartCountThreshold;
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to check restart count');
      return false;
    }
  }

  /**
   * 触发回滚
   */
  async triggerRollback(state, reason) {
    if (!state.rollbackConfig.enabled) {
      logger.info({ checkId: state.id }, 'Rollback disabled, skipping');
      return;
    }
    
    state.rollbackTriggered = true;
    state.phase = 'RollbackTriggered';
    this.metrics.rollbacksTriggered++;
    
    logger.error({
      checkId: state.id,
      targetDeployment: state.targetDeployment,
      currentRevision: state.currentRevision,
      previousRevision: state.previousRevision,
      reason
    }, 'Triggering automatic rollback');
    
    try {
      // 执行 kubectl rollout undo
      await this.k8sClient.rollbackDeployment(
        state.namespace,
        state.targetDeployment
      );
      
      state.phase = 'RollbackComplete';
      state.rollbackCount = (state.rollbackCount || 0) + 1;
      state.lastRollbackTime = new Date().toISOString();
      state.lastRollbackReason = reason;
      
      // 发送通知
      await this.sendRollbackNotification(state, reason);
      
      logger.info({
        checkId: state.id,
        targetDeployment: state.targetDeployment
      }, 'Rollback completed');
      
    } catch (error) {
      logger.error({
        error: error.message,
        checkId: state.id
      }, 'Rollback failed');
    }
    
    // 清理检查
    this.stopHealthCheck(state.id);
  }

  /**
   * 发送回滚通知
   */
  async sendRollbackNotification(state, reason) {
    const { rollbackConfig } = state;
    
    const message = {
      type: 'rollback',
      deployment: state.targetDeployment,
      namespace: state.namespace,
      revision: {
        from: state.currentRevision,
        to: state.previousRevision
      },
      reason,
      timestamp: new Date().toISOString(),
      healthCheckName: state.healthCheckName
    };
    
    // Slack 通知
    if (rollbackConfig.slackChannel) {
      try {
        await this.notifier.sendSlack(rollbackConfig.slackChannel, {
          text: `🚨 *Automatic Rollback Triggered*\n` +
            `*Deployment:* ${state.targetDeployment}\n` +
            `*Reason:* ${reason}\n` +
            `*Reverted to:* revision ${state.previousRevision}`
        });
      } catch (error) {
        logger.warn({ error: error.message }, 'Slack notification failed');
      }
    }
    
    // Webhook 通知
    if (rollbackConfig.notificationWebhook) {
      try {
        await this.notifier.sendWebhook(rollbackConfig.notificationWebhook, message);
      } catch (error) {
        logger.warn({ error: error.message }, 'Webhook notification failed');
      }
    }
  }

  /**
   * 完成健康检查
   */
  async completeHealthCheck(checkId) {
    const state = this.activeChecks.get(checkId);
    if (!state) return;
    
    state.endTime = Date.now();
    state.phase = state.rollbackTriggered ? 'RollbackComplete' : 'Healthy';
    
    // 更新最终状态
    await this.updateHealthCheckStatus(state);
    
    // 清理
    this.stopHealthCheck(checkId);
    
    logger.info({
      checkId,
      phase: state.phase,
      checksTotal: state.checksTotal,
      checksPassed: state.checksPassed,
      checksFailed: state.checksFailed
    }, 'Health check completed');
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck(checkId) {
    const intervalId = this.checkIntervals.get(checkId);
    if (intervalId) {
      clearInterval(intervalId);
      this.checkIntervals.delete(checkId);
    }
    this.activeChecks.delete(checkId);
  }

  /**
   * 获取上一个修订版本
   */
  async getPreviousRevision(namespace, deployment) {
    const history = await this.k8sClient.getDeploymentHistory(namespace, deployment);
    if (history.length < 2) return null;
    return history[1].revision;
  }

  /**
   * 更新健康检查状态
   */
  async updateHealthCheckStatus(state) {
    try {
      await this.k8sClient.updateCustomResourceStatus(
        'pmg.io',
        'v1',
        'deploymenthealthchecks',
        state.namespace,
        state.healthCheckName,
        {
          phase: state.phase,
          currentRevision: state.currentRevision,
          previousRevision: state.previousRevision,
          healthChecksTotal: state.checksTotal,
          healthChecksPassed: state.checksPassed,
          healthChecksFailed: state.checksFailed,
          currentErrorRate: state.currentErrorRate,
          currentLatencyP99: state.currentLatencyP99,
          lastCheckTime: new Date().toISOString(),
          rollbackCount: state.rollbackCount || 0,
          lastRollbackTime: state.lastRollbackTime,
          lastRollbackReason: state.lastRollbackReason
        }
      );
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to update status');
    }
  }

  /**
   * 更新阶段状态
   */
  updatePhase(state, phase) {
    if (state.phase !== phase) {
      state.phase = phase;
      this.emit('phaseChange', { checkId: state.id, phase });
    }
  }

  /**
   * 获取检查状态
   */
  getCheckState(checkId) {
    return this.activeChecks.get(checkId);
  }

  /**
   * 获取所有活跃检查
   */
  getActiveChecks() {
    return Array.from(this.activeChecks.values());
  }

  /**
   * 获取指标
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeChecks: this.activeChecks.size
    };
  }
}

module.exports = DeploymentHealthCheckController;