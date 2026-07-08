/**
 * 自动回滚触发器
 * 当健康验证失败时自动触发 Kubernetes 回滚
 * 
 * @module infrastructure/health/AutoRollbackTrigger
 */

'use strict';

const EventEmitter = require('events');
const { execSync } = require('child_process');

/**
 * 自动回滚触发器
 * 执行 Kubernetes deployment 回滚操作
 */
class AutoRollbackTrigger extends EventEmitter {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   * @param {string} config.namespace - Kubernetes namespace
   * @param {number} config.timeout - 回滚超时时间（秒）
   * @param {number} config.maxRetries - 最大重试次数
   */
  constructor(config = {}) {
    super();
    this.config = config;
    this.namespace = config.namespace || 'production';
    this.timeout = config.timeout || 120;
    this.maxRetries = config.maxRetries || 2;
    this.rollbackHistory = [];
    
    // 需要回滚的 deployment 列表
    this.deployments = [
      'gateway',
      'user-service',
      'location-service',
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service'
    ];
    
    // 关键服务（回滚时优先处理）
    this.criticalDeployments = ['gateway', 'user-service', 'catch-service'];
  }

  /**
   * 触发自动回滚
   * @param {Object} verificationResult - 健康验证结果
   * @returns {Promise<Object>} 回滚结果
   */
  async trigger(verificationResult) {
    console.log('[AutoRollbackTrigger] Triggering rollback due to verification failure');
    
    const rollbackId = `rollback-${Date.now()}`;
    const startTime = Date.now();

    const rollbackResult = {
      rollbackId,
      deploymentId: verificationResult.deploymentId,
      reason: this.formatReason(verificationResult),
      timestamp: startTime,
      success: false,
      duration: 0,
      steps: [],
      rolledBackDeployments: [],
      errors: []
    };

    try {
      // 1. 记录回滚决策
      console.log(`[AutoRollbackTrigger] Rollback reason: ${rollbackResult.reason}`);
      rollbackResult.steps.push({ 
        step: 'record-decision', 
        success: true,
        timestamp: Date.now()
      });

      // 2. 确定需要回滚的 deployments
      const deploymentsToRollback = this.determineDeploymentsToRollback(verificationResult);
      console.log(`[AutoRollbackTrigger] Deployments to rollback: ${deploymentsToRollback.join(', ')}`);

      // 3. 执行回滚命令
      for (const deployment of deploymentsToRollback) {
        try {
          const rollbackStepResult = await this.rollbackDeployment(deployment);
          rollbackResult.steps.push(rollbackStepResult);
          
          if (rollbackStepResult.success) {
            rollbackResult.rolledBackDeployments.push(deployment);
          } else {
            rollbackResult.errors.push({
              deployment,
              error: rollbackStepResult.error
            });
          }
        } catch (error) {
          rollbackResult.steps.push({
            step: `rollback-${deployment}`,
            success: false,
            error: error.message
          });
          rollbackResult.errors.push({
            deployment,
            error: error.message
          });
        }
      }

      // 4. 等待回滚完成
      await this.waitForRollbacksComplete(deploymentsToRollback);
      rollbackResult.steps.push({
        step: 'wait-complete',
        success: true,
        timestamp: Date.now()
      });

      // 5. 验证回滚后状态
      const postRollbackHealth = await this.verifyPostRollback();
      rollbackResult.steps.push({
        step: 'post-verification',
        success: postRollbackHealth.ok,
        details: postRollbackHealth
      });

      // 6. 综合判断回滚结果
      rollbackResult.success = rollbackResult.rolledBackDeployments.length > 0 
        && postRollbackHealth.ok;
      rollbackResult.duration = Date.now() - startTime;

      // 7. 记录历史
      this.rollbackHistory.push(rollbackResult);

      this.emit('rollback:complete', rollbackResult);
      
      console.log(`[AutoRollbackTrigger] Rollback completed in ${rollbackResult.duration}ms`);
      
      return rollbackResult;
    } catch (error) {
      rollbackResult.success = false;
      rollbackResult.error = error.message;
      rollbackResult.duration = Date.now() - startTime;
      
      this.emit('rollback:error', { rollbackId, error });
      
      console.error('[AutoRollbackTrigger] Rollback failed:', error);
      
      return rollbackResult;
    }
  }

  /**
   * 执行单个 deployment 回滚
   * @param {string} deployment - Deployment 名称
   * @returns {Promise<Object>}
   */
  async rollbackDeployment(deployment) {
    const startTime = Date.now();
    
    const result = {
      step: `rollback-${deployment}`,
      deployment,
      success: false,
      timestamp: startTime
    };

    try {
      // 在实际环境中执行 kubectl rollout undo
      if (process.env.KUBECTL_ENABLED === 'true') {
        const output = execSync(
          `kubectl rollout undo deployment/${deployment} -n ${this.namespace}`,
          { encoding: 'utf8', timeout: 30000 }
        );
        
        result.success = true;
        result.output = output;
        result.latency = Date.now() - startTime;
      } else {
        // 模拟模式（用于测试）
        console.log(`[AutoRollbackTrigger] [MOCK] kubectl rollout undo deployment/${deployment} -n ${this.namespace}`);
        
        // 模拟成功
        result.success = true;
        result.output = `deployment "${deployment}" successfully rolled back (simulated)`;
        result.latency = Math.floor(Math.random() * 500) + 100;
      }

      this.emit('deployment:rolledback', { deployment, result });
      
      return result;
    } catch (error) {
      result.success = false;
      result.error = error.message;
      result.latency = Date.now() - startTime;
      
      return result;
    }
  }

  /**
   * 等待所有回滚完成
   * @param {string[]} deployments - Deployment 列表
   */
  async waitForRollbacksComplete(deployments) {
    console.log('[AutoRollbackTrigger] Waiting for rollbacks to complete...');
    
    if (process.env.KUBECTL_ENABLED === 'true') {
      for (const deployment of deployments) {
        execSync(
          `kubectl rollout status deployment/${deployment} -n ${this.namespace} --timeout=${this.timeout}s`,
          { encoding: 'utf8', timeout: this.timeout * 1000 }
        );
      }
    } else {
      // 模拟等待
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  /**
   * 验证回滚后状态
   * @returns {Promise<Object>}
   */
  async verifyPostRollback() {
    console.log('[AutoRollbackTrigger] Verifying post-rollback health...');
    
    const start = Date.now();
    
    try {
      // 检查关键服务状态
      const healthChecks = [];
      
      for (const deployment of this.criticalDeployments) {
        const health = await this.checkDeploymentHealth(deployment);
        healthChecks.push(health);
      }
      
      const allHealthy = healthChecks.every(h => h.ok);
      
      return {
        ok: allHealthy,
        checks: healthChecks,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message,
        latency: Date.now() - start
      };
    }
  }

  /**
   * 检查 deployment 健康状态
   * @param {string} deployment - Deployment 名称
   * @returns {Promise<Object>}
   */
  async checkDeploymentHealth(deployment) {
    const port = {
      'gateway': 8080,
      'user-service': 8081,
      'catch-service': 8084
    }[deployment] || 8080;
    
    const baseUrl = process.env.SERVICE_BASE_URL || 'http://localhost';
    const start = Date.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${baseUrl}:${port}/health`, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      return {
        deployment,
        ok: response.ok,
        status: response.status,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        deployment,
        ok: false,
        error: error.message,
        latency: Date.now() - start
      };
    }
  }

  /**
   * 确定需要回滚的 deployments
   * @param {Object} verificationResult - 验证结果
   * @returns {string[]}
   */
  determineDeploymentsToRollback(verificationResult) {
    // 根据验证结果确定回滚范围
    
    // 1. 优先回滚失败的服务
    const failedServices = verificationResult.issues
      .filter(i => i.service && i.severity === 'critical')
      .map(i => i.service);
    
    // 2. 如果关键服务失败，只回滚这些
    const criticalFailed = failedServices.filter(s => 
      this.criticalDeployments.includes(s)
    );
    
    if (criticalFailed.length > 0) {
      return criticalFailed;
    }
    
    // 3. 否则回滚所有关键服务
    return this.criticalDeployments;
  }

  /**
   * 格式化回滚原因
   * @param {Object} verificationResult - 验证结果
   * @returns {string}
   */
  formatReason(verificationResult) {
    const issues = verificationResult.issues || [];
    
    if (issues.length === 0) {
      return 'Unknown failure - no issues recorded';
    }
    
    // 取前 3 个关键 issue
    const keyIssues = issues
      .filter(i => i.severity === 'critical' || i.severity === 'high')
      .slice(0, 3);
    
    if (keyIssues.length === 0) {
      return 'Multiple minor issues detected';
    }
    
    return keyIssues.map(i => `[${i.type}] ${i.message}`).join('; ');
  }

  /**
   * 获取回滚历史
   * @param {number} limit - 限制数量
   * @returns {Object[]}
   */
  getHistory(limit = 10) {
    return this.rollbackHistory.slice(-limit);
  }

  /**
   * 获取最近一次回滚
   * @returns {Object|null}
   */
  getLastRollback() {
    return this.rollbackHistory.length > 0 
      ? this.rollbackHistory[this.rollbackHistory.length - 1] 
      : null;
  }

  /**
   * 清理历史记录
   * @param {number} maxAge - 最大保留天数
   */
  cleanupHistory(maxAge = 30) {
    const cutoff = Date.now() - maxAge * 24 * 60 * 60 * 1000;
    this.rollbackHistory = this.rollbackHistory.filter(r => r.timestamp >= cutoff);
  }
}

module.exports = AutoRollbackTrigger;