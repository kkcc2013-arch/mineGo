/**
 * REQ-00506: 容器资源智能利用率分析系统
 * 自动弹性调整插件
 * 
 * 功能：
 * - 根据分析报告自动调整资源配额
 * - 支持手动审核和自动执行模式
 * - 执行滚动更新
 * - 集成到 CI/CD 流水线
 * 
 * @module backend/shared/resourceAnalysis/AutoAdjustmentPlugin
 */

'use strict';

const { createLogger } = require('../logger');
const { executeQuery } = require('../db');
const axios = require('axios');

const logger = createLogger('auto-adjustment-plugin');

/**
 * 调整策略配置
 */
const ADJUSTMENT_STRATEGIES = {
  conservative: {
    cpuBuffer: 1.5,       // 留 50% 缓冲
    memoryBuffer: 1.3,    // 留 30% 缓冲
    autoExecute: false,    // 需手动审核
    maxReduction: 0.3      // 最大降幅 30%
  },
  balanced: {
    cpuBuffer: 1.3,
    memoryBuffer: 1.2,
    autoExecute: false,     // 需手动审核
    maxReduction: 0.4
  },
  aggressive: {
    cpuBuffer: 1.2,
    memoryBuffer: 1.15,
    autoExecute: true,      // 自动执行
    maxReduction: 0.5
  }
};

/**
 * 自动调整插件类
 */
class AutoAdjustmentPlugin {
  constructor(config = {}) {
    this.kubernetesApiUrl = config.kubernetesApiUrl || process.env.K8S_API_URL;
    this.strategy = config.strategy || 'conservative';
    this.dryRun = config.dryRun || false;
    this.axiosInstance = axios.create({
      baseURL: this.kubernetesApiUrl,
      timeout: 30000
    });
  }

  /**
   * 执行自动调整
   * @param {Object} analysisReport - 分析报告
   * @param {Object} options - 执行选项
   * @returns {Promise<Object>} 执行结果
   */
  async executeAutoAdjustment(analysisReport, options = {}) {
    const strategy = ADJUSTMENT_STRATEGIES[this.strategy];
    const adjustments = [];

    logger.info({ 
      strategy: this.strategy,
      dryRun: this.dryRun 
    }, 'Starting auto adjustment');

    // 处理高优先级建议（立即执行）
    if (analysisReport.recommendations.immediate.length > 0) {
      const highPriorityAdjustments = await this.processHighPriority(
        analysisReport.recommendations.immediate,
        strategy
      );
      adjustments.push(...highPriorityAdjustments);
    }

    // 处理中等优先级建议（计划执行）
    if (analysisReport.recommendations.scheduled.length > 0) {
      const scheduledAdjustments = await this.processScheduled(
        analysisReport.recommendations.scheduled,
        strategy
      );
      adjustments.push(...scheduledAdjustments);
    }

    // 记录调整历史
    await this.recordAdjustmentHistory(adjustments);

    // 如果不是 dry-run 且有实际调整，触发滚动更新
    if (!this.dryRun && adjustments.length > 0 && strategy.autoExecute) {
      await this.triggerRollingUpdate(adjustments);
    }

    return {
      success: true,
      strategy: this.strategy,
      dryRun: this.dryRun,
      totalAdjustments: adjustments.length,
      executedAdjustments: strategy.autoExecute ? adjustments.length : 0,
      pendingApproval: !strategy.autoExecute ? adjustments.length : 0,
      adjustments,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 处理高优先级调整
   * @param {Array} recommendations - 高优先级建议列表
   * @param {Object} strategy - 调整策略
   * @returns {Promise<Array>} 调整列表
   */
  async processHighPriority(recommendations, strategy) {
    const adjustments = [];

    for (const rec of recommendations) {
      // 高优先级（risky/over-utilized）主要是增加资源
      if (rec.type === 'increase_limit') {
        const adjustment = await this.createAdjustment(rec, strategy, 'high');
        adjustments.push(adjustment);
      } else if (rec.type === 'reduce_request') {
        // 高优先级中的降低 request 需要特别谨慎
        const adjustment = await this.createAdjustment(rec, strategy, 'high');
        adjustment.requiresApproval = true;
        adjustments.push(adjustment);
      }
    }

    return adjustments;
  }

  /**
   * 处理计划调整
   * @param {Array} recommendations - 中等优先级建议列表
   * @param {Object} strategy - 调整策略
   * @returns {Promise<Array>} 调整列表
   */
  async processScheduled(recommendations, strategy) {
    const adjustments = [];

    for (const rec of recommendations) {
      // 中等优先级主要是优化配置
      const adjustment = await this.createAdjustment(rec, strategy, 'medium');
      
      // 应用最大降幅限制
      if (rec.type === 'reduce_request') {
        const reduction = (rec.current - rec.suggested) / rec.current;
        if (reduction > strategy.maxReduction) {
          adjustment.suggested = rec.current * (1 - strategy.maxReduction);
          adjustment.note = `降幅超过限制，调整为最大降幅 ${strategy.maxReduction * 100}%`;
        }
      }
      
      adjustments.push(adjustment);
    }

    return adjustments;
  }

  /**
   * 创建调整对象
   * @param {Object} recommendation - 优化建议
   * @param {Object} strategy - 调整策略
   * @param {string} priority - 优先级
   * @returns {Object} 调整对象
   */
  async createAdjustment(recommendation, strategy, priority) {
    const [podName, containerName] = recommendation.container.split('/');
    
    const adjustment = {
      podName,
      containerName,
      resource: recommendation.resource,
      type: recommendation.type,
      current: recommendation.current,
      originalSuggested: recommendation.suggested,
      suggested: recommendation.suggested,
      priority,
      reason: recommendation.reason,
      impact: recommendation.impact,
      status: strategy.autoExecute ? 'pending_execution' : 'pending_approval',
      requiresApproval: !strategy.autoExecute,
      createdAt: new Date().toISOString()
    };

    // 应用缓冲系数
    if (recommendation.type === 'reduce_request') {
      const buffer = recommendation.resource === 'cpu' 
        ? strategy.cpuBuffer 
        : strategy.memoryBuffer;
      adjustment.suggested = recommendation.suggested * buffer;
    }

    return adjustment;
  }

  /**
   * 执行单个调整
   * @param {Object} adjustment - 调整对象
   * @returns {Promise<Object>} 执行结果
   */
  async executeAdjustment(adjustment) {
    if (this.dryRun) {
      logger.info({ adjustment }, 'Dry-run: skipping execution');
      return {
        success: true,
        dryRun: true,
        adjustment,
        message: 'Dry-run mode - no actual changes'
      };
    }

    try {
      // 解析 pod 名称获取 deployment
      const deploymentName = this.extractDeploymentName(adjustment.podName);
      
      // 获取当前 deployment 配置
      const currentDeployment = await this.getDeployment(deploymentName);
      
      // 更新资源配置
      const updatedDeployment = this.updateDeploymentResources(
        currentDeployment,
        adjustment
      );

      // 应用更新到 Kubernetes
      const result = await this.applyDeploymentUpdate(updatedDeployment);

      // 更新调整状态
      adjustment.status = 'completed';
      adjustment.executedAt = new Date().toISOString();
      adjustment.result = result;

      logger.info({ adjustment, deploymentName }, 'Adjustment executed successfully');

      return {
        success: true,
        adjustment,
        deploymentName,
        message: 'Resource adjustment applied'
      };
    } catch (error) {
      adjustment.status = 'failed';
      adjustment.error = error.message;
      adjustment.failedAt = new Date().toISOString();

      logger.error({ err: error, adjustment }, 'Adjustment execution failed');

      return {
        success: false,
        adjustment,
        error: error.message
      };
    }
  }

  /**
   * 批量执行调整
   * @param {Array} adjustments - 调整列表
   * @returns {Promise<Object>} 执行结果
   */
  async executeBatchAdjustments(adjustments) {
    const results = {
      total: adjustments.length,
      successful: 0,
      failed: 0,
      skipped: 0,
      details: []
    };

    for (const adjustment of adjustments) {
      if (adjustment.requiresApproval && !this.dryRun) {
        results.skipped++;
        results.details.push({
          adjustment,
          status: 'skipped',
          reason: 'Requires approval'
        });
        continue;
      }

      const result = await this.executeAdjustment(adjustment);
      results.details.push(result);

      if (result.success) {
        results.successful++;
      } else {
        results.failed++;
      }
    }

    return results;
  }

  /**
   * 触发滚动更新
   * @param {Array} adjustments - 调整列表
   * @returns {Promise<Object>} 滚动更新结果
   */
  async triggerRollingUpdate(adjustments) {
    const deploymentsToUpdate = new Map();

    // 按 deployment 分组调整
    adjustments.forEach(adj => {
      const deploymentName = this.extractDeploymentName(adj.podName);
      if (!deploymentsToUpdate.has(deploymentName)) {
        deploymentsToUpdate.set(deploymentName, []);
      }
      deploymentsToUpdate.get(deploymentName).push(adj);
    });

    logger.info({ 
      deploymentCount: deploymentsToUpdate.size 
    }, 'Triggering rolling updates');

    const updateResults = [];

    for (const [deploymentName, deploymentAdjustments] of deploymentsToUpdate) {
      try {
        // 获取当前 deployment
        const deployment = await this.getDeployment(deploymentName);

        // 合并所有调整到 deployment
        const updatedDeployment = deployment;
        deploymentAdjustments.forEach(adj => {
          this.applyAdjustmentToDeployment(updatedDeployment, adj);
        });

        // 执行更新
        const result = await this.applyDeploymentUpdate(updatedDeployment);

        updateResults.push({
          deploymentName,
          success: true,
          adjustmentCount: deploymentAdjustments.length,
          result
        });

        logger.info({ deploymentName }, 'Rolling update triggered');
      } catch (error) {
        updateResults.push({
          deploymentName,
          success: false,
          error: error.message
        });

        logger.error({ err: error, deploymentName }, 'Rolling update failed');
      }
    }

    return {
      total: deploymentsToUpdate.size,
      successful: updateResults.filter(r => r.success).length,
      failed: updateResults.filter(r => !r.success).length,
      results: updateResults
    };
  }

  /**
   * 获取 Deployment
   * @param {string} deploymentName - Deployment 名称
   * @returns {Promise<Object>} Deployment 配置
   */
  async getDeployment(deploymentName) {
    try {
      const response = await this.axiosInstance.get(
        `/apis/apps/v1/namespaces/pmg/deployments/${deploymentName}`
      );
      return response.data;
    } catch (error) {
      logger.error({ err: error, deploymentName }, 'Failed to get deployment');
      throw error;
    }
  }

  /**
   * 更新 Deployment 资源配置
   * @param {Object} deployment - Deployment 配置
   * @param {Object} adjustment - 调整对象
   * @returns {Object} 更新后的 Deployment
   */
  updateDeploymentResources(deployment, adjustment) {
    const containers = deployment.spec.template.spec.containers;
    
    // 找到对应的容器
    const container = containers.find(c => c.name === adjustment.containerName);
    
    if (!container) {
      throw new Error(`Container ${adjustment.containerName} not found in deployment`);
    }

    // 更新资源配置
    if (!container.resources) {
      container.resources = {};
    }

    if (adjustment.type === 'reduce_request' || adjustment.type === 'increase_limit') {
      if (!container.resources.requests) {
        container.resources.requests = {};
      }
      if (!container.resources.limits) {
        container.resources.limits = {};
      }

      // 根据 resource 类型更新
      if (adjustment.resource === 'cpu') {
        if (adjustment.type.includes('request')) {
          container.resources.requests.cpu = this.formatCpuResource(adjustment.suggested);
        }
        if (adjustment.type.includes('limit')) {
          container.resources.limits.cpu = this.formatCpuResource(adjustment.suggested);
        }
      } else if (adjustment.resource === 'memory') {
        if (adjustment.type.includes('request')) {
          container.resources.requests.memory = this.formatMemoryResource(adjustment.suggested);
        }
        if (adjustment.type.includes('limit')) {
          container.resources.limits.memory = this.formatMemoryResource(adjustment.suggested);
        }
      }
    }

    return deployment;
  }

  /**
   * 应用调整到 Deployment
   */
  applyAdjustmentToDeployment(deployment, adjustment) {
    return this.updateDeploymentResources(deployment, adjustment);
  }

  /**
   * 应用 Deployment 更新
   * @param {Object} deployment - 更新的 Deployment 配置
   * @returns {Promise<Object>} 更新结果
   */
  async applyDeploymentUpdate(deployment) {
    try {
      const response = await this.axiosInstance.put(
        `/apis/apps/v1/namespaces/pmg/deployments/${deployment.metadata.name}`,
        deployment
      );

      return response.data;
    } catch (error) {
      logger.error({ err: error, deployment: deployment.metadata.name }, 'Failed to apply deployment update');
      throw error;
    }
  }

  /**
   * 记录调整历史
   * @param {Array} adjustments - 调整列表
   * @returns {Promise<void>}
   */
  async recordAdjustmentHistory(adjustments) {
    for (const adj of adjustments) {
      await executeQuery(
        `INSERT INTO resource_adjustment_history (
          pod_name, container_name, resource_type, adjustment_type,
          current_value, suggested_value, status, reason, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          adj.podName,
          adj.containerName,
          adj.resource,
          adj.type,
          adj.current,
          adj.suggested,
          adj.status,
          adj.reason,
          new Date()
        ]
      );
    }

    logger.info({ count: adjustments.length }, 'Adjustment history recorded');
  }

  /**
   * 获取调整历史
   * @param {number} limit - 返回条数
   * @returns {Promise<Array>} 历史记录
   */
  async getAdjustmentHistory(limit = 50) {
    const result = await executeQuery(
      `SELECT * FROM resource_adjustment_history 
       ORDER BY created_at DESC 
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  /**
   * 提取 Deployment 名称
   * @param {string} podName - Pod 名称
   * @returns {string} Deployment 名称
   */
  extractDeploymentName(podName) {
    // Pod 名称格式：deployment-name-random-hash
    // 例如：api-gateway-5d8f9a2b3c
    const parts = podName.split('-');
    if (parts.length > 2) {
      // 移除最后的随机 hash
      return parts.slice(0, -1).join('-');
    }
    return podName;
  }

  /**
   * 格式化 CPU 资源
   * @param {number} cores - CPU 核心数
   * @returns {string} Kubernetes 格式
   */
  formatCpuResource(cores) {
    if (cores < 1) {
      return `${Math.round(cores * 1000)}m`;
    }
    return `${cores.toFixed(2)}`;
  }

  /**
   * 格式化 Memory 资源
   * @param {number} bytes - 内存字节
   * @returns {string} Kubernetes 格式
   */
  formatMemoryResource(bytes) {
    return `${Math.round(bytes)}`;
  }

  /**
   * 手动批准调整
   * @param {string} adjustmentId - 调整 ID
   * @returns {Promise<Object>} 执行结果
   */
  async approveAdjustment(adjustmentId) {
    const result = await executeQuery(
      `SELECT * FROM resource_adjustment_history WHERE id = $1`,
      [adjustmentId]
    );

    if (result.rows.length === 0) {
      throw new Error('Adjustment not found');
    }

    const adjustment = result.rows[0];
    
    // 更新状态为已批准
    await executeQuery(
      `UPDATE resource_adjustment_history 
       SET status = 'approved', approved_at = $1 
       WHERE id = $2`,
      [new Date(), adjustmentId]
    );

    // 执行调整
    const executionResult = await this.executeAdjustment({
      podName: adjustment.pod_name,
      containerName: adjustment.container_name,
      resource: adjustment.resource_type,
      type: adjustment.adjustment_type,
      current: adjustment.current_value,
      suggested: adjustment.suggested_value,
      requiresApproval: false
    });

    // 更新执行结果
    await executeQuery(
      `UPDATE resource_adjustment_history 
       SET status = $1, executed_at = $2, result = $3 
       WHERE id = $4`,
      [
        executionResult.success ? 'completed' : 'failed',
        new Date(),
        JSON.stringify(executionResult),
        adjustmentId
      ]
    );

    return executionResult;
  }

  /**
   * 拒绝调整
   * @param {string} adjustmentId - 调整 ID
   * @param {string} reason - 拒绝原因
   * @returns {Promise<void>}
   */
  async rejectAdjustment(adjustmentId, reason) {
    await executeQuery(
      `UPDATE resource_adjustment_history 
       SET status = 'rejected', rejected_at = $1, rejection_reason = $2 
       WHERE id = $3`,
      [new Date(), reason, adjustmentId]
    );

    logger.info({ adjustmentId, reason }, 'Adjustment rejected');
  }
}

module.exports = AutoAdjustmentPlugin;