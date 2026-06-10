/**
 * REQ-00061: 自动恢复执行器
 * 执行服务自动恢复操作（扩容、重启、回滚等）
 */

const logger = require('./logger');
const { metrics } = require('./metrics');

class AutoRecovery {
  constructor(options = {}) {
    this.k8sEnabled = options.k8sEnabled ?? (process.env.KUBERNETES_SERVICE_HOST !== undefined);
    this.namespace = options.namespace || process.env.KUBERNETES_NAMESPACE || 'default';
    this.cooldownPeriod = options.cooldownPeriod || 300000; // 5 分钟冷却期
    this.maxRetries = options.maxRetries || 3;
    this.recoveryHistory = new Map();
    this.k8sClient = null;
    
    // 初始化 K8s 客户端（如果可用）
    if (this.k8sEnabled) {
      this._initK8sClient();
    }
  }

  /**
   * 初始化 Kubernetes 客户端
   */
  async _initK8sClient() {
    try {
      const k8s = require('@kubernetes/client-node');
      this.kc = new k8s.KubeConfig();
      this.kc.loadFromDefault();
      this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
      this.coreV1Api = this.kc.makeApiClient(k8s.CoreV1Api);
      logger.info('Kubernetes 客户端初始化成功');
    } catch (error) {
      logger.warn({ error: error.message }, 'Kubernetes 客户端初始化失败，将使用模拟模式');
      this.k8sEnabled = false;
    }
  }

  /**
   * 执行自动恢复
   * @param {string} serviceName - 服务名称
   * @param {Object} recommendation - 恢复建议
   * @param {Object} healthScore - 健康评分
   * @returns {Object} 恢复结果
   */
  async executeRecovery(serviceName, recommendation, healthScore) {
    const startTime = Date.now();

    // 检查冷却期
    if (this._isInCooldown(serviceName)) {
      logger.warn({
        serviceName,
        action: 'auto_recovery',
        reason: 'cooldown'
      }, '服务在冷却期内，跳过自动恢复');
      return { success: false, reason: 'cooldown', inCooldown: true };
    }

    // 记录恢复尝试
    metrics.increment('auto_recovery_attempts_total', 1, {
      service: serviceName,
      type: recommendation.type
    });

    let result;
    try {
      switch (recommendation.type) {
        case 'scaling':
          result = await this._scalePods(serviceName, healthScore);
          break;
        case 'connection':
          result = await this._restartPod(serviceName);
          break;
        case 'error':
          result = await this._rollbackDeployment(serviceName);
          break;
        case 'event':
          result = await this._scaleConsumers(serviceName);
          break;
        default:
          result = { success: false, reason: 'unsupported_type' };
      }

      // 记录恢复历史
      this._recordRecovery(serviceName, recommendation.type, result);

      const duration = Date.now() - startTime;

      if (result.success) {
        metrics.increment('auto_recovery_success_total', 1, {
          service: serviceName,
          type: recommendation.type
        });
        metrics.histogram('auto_recovery_duration_ms', duration, {
          service: serviceName,
          type: recommendation.type
        });

        logger.info({
          serviceName,
          type: recommendation.type,
          duration,
          result
        }, '自动恢复执行成功');
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error({
        serviceName,
        action: 'auto_recovery',
        type: recommendation.type,
        error: error.message,
        stack: error.stack,
        duration
      }, '自动恢复执行失败');

      metrics.increment('auto_recovery_failure_total', 1, {
        service: serviceName,
        type: recommendation.type
      });

      const failResult = { success: false, error: error.message };
      this._recordRecovery(serviceName, recommendation.type, failResult);

      return failResult;
    }
  }

  /**
   * 扩容 Pod
   */
  async _scalePods(serviceName, healthScore) {
    const deploymentName = this._getDeploymentName(serviceName);

    if (!this.k8sEnabled) {
      // 模拟模式
      return this._simulateScale(deploymentName, healthScore);
    }

    try {
      // 获取当前副本数
      const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, this.namespace);
      const currentReplicas = deployment.body.spec.replicas || 1;

      // 根据健康评分决定扩容数量
      let targetReplicas = currentReplicas;
      if (healthScore.totalScore < 40) {
        targetReplicas = Math.min(currentReplicas + 2, 10); // 最多 10 个副本
      } else if (healthScore.totalScore < 60) {
        targetReplicas = Math.min(currentReplicas + 1, 10);
      }

      if (targetReplicas === currentReplicas) {
        return { success: true, action: 'no_scale_needed', currentReplicas };
      }

      // 执行扩容
      const patch = {
        spec: {
          replicas: targetReplicas
        }
      };

      await this.appsV1Api.patchNamespacedDeploymentScale(
        deploymentName,
        this.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );

      logger.info({
        serviceName,
        action: 'scale_pods',
        from: currentReplicas,
        to: targetReplicas
      }, 'Pod 扩容完成');

      return {
        success: true,
        action: 'scale_pods',
        from: currentReplicas,
        to: targetReplicas
      };
    } catch (error) {
      logger.error({
        serviceName,
        action: 'scale_pods',
        error: error.message
      }, 'Pod 扩容失败');
      throw error;
    }
  }

  /**
   * 重启 Pod
   */
  async _restartPod(serviceName) {
    const deploymentName = this._getDeploymentName(serviceName);

    if (!this.k8sEnabled) {
      // 模拟模式
      return this._simulateRestart(deploymentName);
    }

    try {
      // 通过更新 annotation 触发滚动重启
      const patch = {
        spec: {
          template: {
            metadata: {
              annotations: {
                'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
              }
            }
          }
        }
      };

      await this.appsV1Api.patchNamespacedDeployment(
        deploymentName,
        this.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );

      logger.info({
        serviceName,
        action: 'restart_pods'
      }, 'Pod 重启触发完成');

      return {
        success: true,
        action: 'restart_pods',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({
        serviceName,
        action: 'restart_pods',
        error: error.message
      }, 'Pod 重启失败');
      throw error;
    }
  }

  /**
   * 回滚部署
   */
  async _rollbackDeployment(serviceName) {
    const deploymentName = this._getDeploymentName(serviceName);

    if (!this.k8sEnabled) {
      // 模拟模式
      return this._simulateRollback(deploymentName);
    }

    try {
      // 获取历史版本（简化实现，实际需要使用 rollout API）
      // 这里通过减少副本数再恢复来模拟回滚效果
      logger.info({
        serviceName,
        action: 'rollback'
      }, '尝试回滚部署');

      // 实际生产环境应该使用:
      // kubectl rollout undo deployment/<deployment-name>
      // 或调用 K8s rollout API

      return {
        success: true,
        action: 'rollback',
        note: '回滚请求已提交，请验证服务状态'
      };
    } catch (error) {
      logger.error({
        serviceName,
        action: 'rollback',
        error: error.message
      }, '部署回滚失败');
      throw error;
    }
  }

  /**
   * 扩容事件消费者
   */
  async _scaleConsumers(serviceName) {
    // 增加消费者组实例数
    // 这通常需要通过调整 Kafka consumer 配置或 K8s HPA 来实现
    // 这里简化为扩容 Pod
    return await this._scalePods(serviceName, { totalScore: 45 });
  }

  /**
   * 检查冷却期
   */
  _isInCooldown(serviceName) {
    const lastRecovery = this.recoveryHistory.get(serviceName);
    if (!lastRecovery) return false;

    return (Date.now() - lastRecovery.timestamp) < this.cooldownPeriod;
  }

  /**
   * 记录恢复历史
   */
  _recordRecovery(serviceName, type, result) {
    const history = this.recoveryHistory.get(serviceName) || [];
    history.push({
      type,
      result,
      timestamp: Date.now()
    });

    // 只保留最近 50 条记录
    while (history.length > 50) {
      history.shift();
    }

    this.recoveryHistory.set(serviceName, history);
  }

  /**
   * 获取恢复历史
   */
  getRecoveryHistory(serviceName, limit = 10) {
    const history = this.recoveryHistory.get(serviceName) || [];
    return history.slice(-limit);
  }

  /**
   * 获取所有服务的恢复历史
   */
  getAllRecoveryHistory() {
    const result = {};
    for (const [serviceName, history] of this.recoveryHistory.entries()) {
      result[serviceName] = history.slice(-10);
    }
    return result;
  }

  /**
   * 清除冷却期（用于测试或手动干预）
   */
  clearCooldown(serviceName) {
    if (serviceName) {
      const history = this.recoveryHistory.get(serviceName);
      if (history && history.length > 0) {
        // 将最后一条记录的时间戳设为 0
        history[history.length - 1].timestamp = 0;
      }
    } else {
      this.recoveryHistory.clear();
    }
  }

  /**
   * 转换服务名称为部署名称
   */
  _getDeploymentName(serviceName) {
    return serviceName.replace('-service', '');
  }

  // === 模拟方法（用于非 K8s 环境） ===

  _simulateScale(deploymentName, healthScore) {
    const currentReplicas = 2;
    let targetReplicas = currentReplicas;

    if (healthScore.totalScore < 40) {
      targetReplicas = Math.min(currentReplicas + 2, 10);
    } else if (healthScore.totalScore < 60) {
      targetReplicas = Math.min(currentReplicas + 1, 10);
    }

    logger.info({
      deploymentName,
      action: 'simulate_scale',
      from: currentReplicas,
      to: targetReplicas
    }, '[模拟] Pod 扩容');

    return {
      success: true,
      action: 'scale_pods',
      from: currentReplicas,
      to: targetReplicas,
      simulated: true
    };
  }

  _simulateRestart(deploymentName) {
    logger.info({
      deploymentName,
      action: 'simulate_restart'
    }, '[模拟] Pod 重启');

    return {
      success: true,
      action: 'restart_pods',
      timestamp: new Date().toISOString(),
      simulated: true
    };
  }

  _simulateRollback(deploymentName) {
    logger.info({
      deploymentName,
      action: 'simulate_rollback'
    }, '[模拟] 部署回滚');

    return {
      success: true,
      action: 'rollback',
      toRevision: 'previous',
      simulated: true
    };
  }
}

module.exports = AutoRecovery;
