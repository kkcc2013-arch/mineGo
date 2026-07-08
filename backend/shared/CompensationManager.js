'use strict';

/**
 * CompensationManager - 补偿事务管理器
 * REQ-00499: 事件驱动服务编排与分布式状态机引擎
 * 
 * 功能：
 * - 记录可补偿步骤
 * - Saga 模式逆向补偿执行
 * - 补偿状态追踪
 * - 补偿失败重试
 */

const { createLogger } = require('./logger');
const { getRedis } = require('./redis');
const { getEventBus } = require('./EventBus');

const logger = createLogger('compensation-manager');

/**
 * 补偿状态
 */
const CompensationStatus = {
  PENDING: 'pending',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

/**
 * 补偿步骤定义
 */
class CompensationStep {
  constructor(data) {
    this.stepIndex = data.stepIndex;
    this.stepName = data.stepName;
    this.service = data.service;
    this.action = data.action;
    this.input = data.input || {};
    this.status = data.status || CompensationStatus.PENDING;
    this.executedAt = data.executedAt;
    this.completedAt = data.completedAt;
    this.error = data.error;
    this.retryCount = data.retryCount || 0;
  }

  toJSON() {
    return {
      stepIndex: this.stepIndex,
      stepName: this.stepName,
      service: this.service,
      action: this.action,
      input: this.input,
      status: this.status,
      executedAt: this.executedAt,
      completedAt: this.completedAt,
      error: this.error,
      retryCount: this.retryCount
    };
  }

  static fromJSON(json) {
    if (typeof json === 'string') {
      json = JSON.parse(json);
    }
    return new CompensationStep(json);
  }
}

/**
 * 补偿管理器配置
 */
const DEFAULT_CONFIG = {
  redisKeyPrefix: 'compensation:',
  maxRetries: 3,
  retryDelay: 1000, // 1秒
  executionTimeout: 30000, // 30秒
  historyTTL: 86400 // 24小时
};

/**
 * 补偿事务管理器
 */
class CompensationManager {
  constructor(redisClient, config = {}) {
    this.redis = redisClient || getRedis();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = null;
    
    // Prometheus 指标
    this.metrics = {
      compensationsExecuted: 0,
      compensationsCompleted: 0,
      compensationsFailed: 0,
      compensationSteps: 0,
      compensationRetries: 0
    };
  }

  /**
   * 初始化 EventBus
   */
  async initialize() {
    if (!this.eventBus) {
      this.eventBus = getEventBus({ clientId: 'compensation-manager' });
      await this.eventBus.connect();
    }
    return this;
  }

  /**
   * 记录补偿步骤
   */
  async recordCompensationStep(instanceId, stepName, compensationAction, input = {}) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    
    // 获取当前步骤列表
    const existingSteps = await this.redis.lrange(key, 0, -1);
    const stepIndex = existingSteps.length;
    
    const step = new CompensationStep({
      stepIndex,
      stepName,
      service: compensationAction.service,
      action: compensationAction.action,
      input,
      status: CompensationStatus.PENDING
    });
    
    await this.redis.rpush(key, JSON.stringify(step.toJSON()));
    
    logger.debug('Compensation step recorded', {
      instanceId,
      stepName,
      stepIndex,
      service: step.service,
      action: step.action
    });
    
    this.metrics.compensationSteps++;
    
    return step;
  }

  /**
   * 获取补偿步骤列表
   */
  async getCompensationSteps(instanceId) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    const steps = await this.redis.lrange(key, 0, -1);
    
    return steps.map(s => CompensationStep.fromJSON(s));
  }

  /**
   * 执行补偿事务
   */
  async executeCompensation(instanceId, context = {}) {
    const steps = await this.getCompensationSteps(instanceId);
    
    if (steps.length === 0) {
      logger.info('No compensation steps to execute', { instanceId });
      return { success: true, executed: 0 };
    }
    
    // 逆序执行补偿步骤
    const reversedSteps = [...steps].reverse();
    
    const results = {
      success: true,
      executed: 0,
      skipped: 0,
      failed: 0,
      details: []
    };
    
    for (const step of reversedSteps) {
      if (step.status === CompensationStatus.SKIPPED) {
        results.skipped++;
        results.details.push({
          step: step.stepName,
          status: 'skipped',
          reason: 'Already skipped'
        });
        continue;
      }
      
      const result = await this._executeCompensationStep(instanceId, step, context);
      
      results.details.push({
        step: step.stepName,
        status: result.status,
        error: result.error
      });
      
      if (result.status === CompensationStatus.COMPLETED) {
        results.executed++;
      } else if (result.status === CompensationStatus.FAILED) {
        results.failed++;
        results.success = false;
        
        // 可选：继续执行后续补偿，或停止
        // 这里采用继续执行策略
        logger.warn('Compensation step failed, continuing', {
          instanceId,
          step: step.stepName,
          error: result.error
        });
      }
    }
    
    this.metrics.compensationsExecuted++;
    
    if (results.success) {
      this.metrics.compensationsCompleted++;
    } else {
      this.metrics.compensationsFailed++;
    }
    
    logger.info('Compensation execution completed', {
      instanceId,
      success: results.success,
      executed: results.executed,
      failed: results.failed
    });
    
    return results;
  }

  /**
   * 执行单个补偿步骤
   */
  async _executeCompensationStep(instanceId, step, context) {
    // 更新状态为执行中
    await this._updateStepStatus(instanceId, step.stepIndex, CompensationStatus.EXUTING);
    
    // 构建补偿输入
    const compensationInput = this._buildCompensationInput(step, context);
    
    // 发布补偿执行事件
    const compensationEvent = {
      instanceId,
      stepName: step.stepName,
      stepIndex: step.stepIndex,
      service: step.service,
      action: step.action,
      input: compensationInput,
      eventType: 'compensation.execute',
      timestamp: Date.now()
    };
    
    try {
      // 发布到目标服务执行
      await this.eventBus.publish(`${step.service}.compensate`, compensationEvent);
      
      // 等待确认（简化版，实际应订阅确认事件）
      // 这里我们假设补偿执行成功，实际应用需要更完整的确认机制
      
      await this._updateStepStatus(instanceId, step.stepIndex, CompensationStatus.COMPLETED);
      
      logger.info('Compensation step executed', {
        instanceId,
        step: step.stepName,
        service: step.service,
        action: step.action
      });
      
      return {
        status: CompensationStatus.COMPLETED,
        step
      };
      
    } catch (error) {
      logger.error('Compensation step execution failed', {
        instanceId,
        step: step.stepName,
        error: error.message
      });
      
      // 尝试重试
      if (step.retryCount < this.config.maxRetries) {
        return await this._retryCompensationStep(instanceId, step, context);
      }
      
      await this._updateStepStatus(
        instanceId, 
        step.stepIndex, 
        CompensationStatus.FAILED, 
        error.message
      );
      
      return {
        status: CompensationStatus.FAILED,
        step,
        error: error.message
      };
    }
  }

  /**
   * 重试补偿步骤
   */
  async _retryCompensationStep(instanceId, step, context) {
    step.retryCount++;
    
    // 更新重试次数
    await this._updateStepRetryCount(instanceId, step.stepIndex, step.retryCount);
    
    this.metrics.compensationRetries++;
    
    logger.warn('Retrying compensation step', {
      instanceId,
      step: step.stepName,
      retryCount: step.retryCount
    });
    
    // 延迟重试
    await new Promise(resolve => 
      setTimeout(resolve, this.config.retryDelay * step.retryCount)
    );
    
    return await this._executeCompensationStep(instanceId, step, context);
  }

  /**
   * 构建补偿输入
   */
  _buildCompensationInput(step, context) {
    const input = { ...step.input };
    
    // 从上下文中补充必要数据
    for (const key of Object.keys(input)) {
      if (input[key] === undefined && context[key] !== undefined) {
        input[key] = context[key];
      }
    }
    
    return input;
  }

  /**
   * 更新步骤状态
   */
  async _updateStepStatus(instanceId, stepIndex, status, error = null) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    const steps = await this.getCompensationSteps(instanceId);
    
    const step = steps[stepIndex];
    if (!step) return false;
    
    step.status = status;
    step.executedAt = Date.now();
    
    if (status === CompensationStatus.COMPLETED) {
      step.completedAt = Date.now();
    }
    
    if (error) {
      step.error = error;
    }
    
    // 更新 Redis 中的步骤
    await this.redis.lset(key, stepIndex, JSON.stringify(step.toJSON()));
    
    return true;
  }

  /**
   * 更新重试次数
   */
  async _updateStepRetryCount(instanceId, stepIndex, retryCount) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    const steps = await this.getCompensationSteps(instanceId);
    
    const step = steps[stepIndex];
    if (!step) return false;
    
    step.retryCount = retryCount;
    
    await this.redis.lset(key, stepIndex, JSON.stringify(step.toJSON()));
    
    return true;
  }

  /**
   * 获取补偿状态
   */
  async getCompensationStatus(instanceId) {
    const steps = await this.getCompensationSteps(instanceId);
    
    const status = {
      total: steps.length,
      pending: 0,
      executing: 0,
      completed: 0,
      failed: 0,
      skipped: 0
    };
    
    for (const step of steps) {
      status[step.status]++;
    }
    
    status.success = status.failed === 0;
    status.progress = (status.completed + status.skipped) / status.total;
    
    return status;
  }

  /**
   * 跳过补偿步骤
   */
  async skipCompensationStep(instanceId, stepIndex, reason) {
    await this._updateStepStatus(instanceId, stepIndex, CompensationStatus.SKIPPED);
    
    logger.info('Compensation step skipped', {
      instanceId,
      stepIndex,
      reason
    });
    
    return true;
  }

  /**
   * 清理补偿记录
   */
  async clearCompensation(instanceId) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:steps`;
    await this.redis.del(key);
    
    logger.debug('Compensation cleared', { instanceId });
  }

  /**
   * 获取指标
   */
  getMetrics() {
    return this.metrics;
  }

  /**
   * Prometheus 指标格式
   */
  getPrometheusMetrics() {
    const m = this.metrics;
    return `
# HELP compensation_executed_total Total compensations executed
# TYPE compensation_executed_total counter
compensation_executed_total ${m.compensationsExecuted}

# HELP compensation_completed_total Compensations completed successfully
# TYPE compensation_completed_total counter
compensation_completed_total ${m.compensationsCompleted}

# HELP compensation_failed_total Compensations failed
# TYPE compensation_failed_total counter
compensation_failed_total ${m.compensationsFailed}

# HELP compensation_steps_total Compensation steps recorded
# TYPE compensation_steps_total counter
compensation_steps_total ${m.compensationSteps}

# HELP compensation_retries_total Compensation retries
# TYPE compensation_retries_total counter
compensation_retries_total ${m.compensationRetries}
`;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    return {
      healthy: true,
      metrics: this.metrics
    };
  }
}

module.exports = {
  CompensationManager,
  CompensationStatus,
  CompensationStep,
  DEFAULT_CONFIG
};