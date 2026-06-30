// backend/shared/criticalPathTracing.js
// REQ-00148: 分布式追踪与请求链路可视化系统 - 关键路径追踪
'use strict';
const { createLogger } = require('./logger');
const logger = createLogger('criticalPathTracing');

let traceApi = null;
let tracer = null;

// 初始化
async function init() {
  if (tracer) return;
  
  try {
    traceApi = (await import('@opentelemetry/api')).trace;
    tracer = traceApi.getTracer('mineGo-critical-paths', '1.0.0');
  } catch (error) {
    // OpenTelemetry 未安装
  }
}

// 定义关键路径
const CRITICAL_PATHS = {
  CATCH_POKEMON: {
    name: 'catch_pokemon_flow',
    description: '精灵捕捉完整流程',
    steps: [
      'auth_check',
      'location_verify',
      'spawn_fetch',
      'catch_attempt',
      'inventory_update',
      'db_save',
      'event_publish',
      'xp_award',
    ],
    expectedDurationMs: 500,
  },
  GYM_BATTLE: {
    name: 'gym_battle_flow',
    description: '道馆战斗完整流程',
    steps: [
      'auth_check',
      'gym_fetch',
      'team_load',
      'energy_check',
      'battle_calc',
      'damage_apply',
      'xp_award',
      'db_save',
      'event_publish',
    ],
    expectedDurationMs: 800,
  },
  PAYMENT: {
    name: 'payment_flow',
    description: '支付完整流程',
    steps: [
      'auth_check',
      'order_validate',
      'inventory_check',
      'payment_gateway',
      'transaction_save',
      'inventory_update',
      'receipt_generate',
      'notification_send',
    ],
    expectedDurationMs: 2000,
  },
  USER_REGISTER: {
    name: 'user_register_flow',
    description: '用户注册完整流程',
    steps: [
      'input_validate',
      'duplicate_check',
      'password_hash',
      'user_create',
      'profile_init',
      'starter_pokemon_assign',
      'welcome_notification',
    ],
    expectedDurationMs: 300,
  },
  PVP_DUEL: {
    name: 'pvp_duel_flow',
    description: 'PVP 对战完整流程',
    steps: [
      'auth_check',
      'opponent_find',
      'team_load',
      'battle_init',
      'turn_execute',
      'result_calc',
      'rating_update',
      'rewards_grant',
      'event_publish',
    ],
    expectedDurationMs: 1000,
  },
  TRADE_POKEMON: {
    name: 'trade_pokemon_flow',
    description: '精灵交换完整流程',
    steps: [
      'auth_check',
      'trade_validate',
      'pokemon_fetch',
      'ownership_verify',
      'trade_execute',
      'ownership_transfer',
      'db_save',
      'notification_send',
    ],
    expectedDurationMs: 600,
  },
};

/**
 * 开始关键路径追踪
 * @param {string} pathName - 路径名称（CRITICAL_PATHS 的 key）
 * @param {Object} context - 上下文信息
 * @returns {Object} 路径追踪器
 */
function startCriticalPath(pathName, context = {}) {
  // 确保初始化
  init();

  const path = CRITICAL_PATHS[pathName];
  if (!path) {
    logger.warn({ module: 'CriticalPath] Unknown path: ${pathName}' }, 'CriticalPath] Unknown path: ${pathName} warning');;
    return createNoOpTracker(pathName);
  }

  // 如果没有 tracer，返回降级追踪器
  if (!tracer) {
    return createFallbackTracker(path, context);
  }

  const startTime = Date.now();
  
  const span = tracer.startSpan(path.name, {
    attributes: {
      'critical_path.name': pathName,
      'critical_path.description': path.description,
      'critical_path.steps': path.steps.join(','),
      'critical_path.step_count': path.steps.length,
      'critical_path.expected_duration_ms': path.expectedDurationMs,
      ...context,
    },
  });

  const tracker = {
    span,
    path,
    pathName,
    currentStep: 0,
    steps: path.steps,
    startTime,
    stepTimings: [],
    completed: false,
    error: null,

    /**
     * 进入下一步
     * @param {string} stepName - 步骤名称
     * @param {Object} attributes - 附加属性
     */
    nextStep(stepName, attributes = {}) {
      const stepStartTime = Date.now();
      
      // 检查步骤是否匹配预期
      const expectedStep = this.steps[this.currentStep];
      if (expectedStep !== stepName) {
        this.span.addEvent('step_mismatch', {
          expected: expectedStep,
          actual: stepName,
          'step.index': this.currentStep,
        });
        logger.warn({ module: 'CriticalPath] Step mismatch at ${this.pathName}: expected ${expectedStep}, got ${stepName}' }, 'CriticalPath] Step mismatch at ${this.pathName}: expected ${expectedStep}, got ${stepName} warning');;
      }

      // 记录步骤开始
      this.span.addEvent(`step_start:${stepName}`, {
        'step.index': this.currentStep,
        'step.name': stepName,
        'step.timestamp': stepStartTime,
        ...attributes,
      });

      // 返回步骤结束函数
      return {
        end: (resultAttributes = {}) => {
          const stepEndTime = Date.now();
          const stepDuration = stepEndTime - stepStartTime;
          
          this.stepTimings.push({
            step: stepName,
            duration: stepDuration,
            index: this.currentStep,
          });

          this.span.addEvent(`step_end:${stepName}`, {
            'step.index': this.currentStep,
            'step.name': stepName,
            'step.duration_ms': stepDuration,
            ...resultAttributes,
          });

          this.currentStep++;
        },
      };
    },

    /**
     * 记录错误
     * @param {Error} error - 错误对象
     * @param {string} stepName - 发生错误的步骤
     */
    recordError(error, stepName) {
      this.error = error;
      this.span.recordException(error);
      this.span.addEvent('error_occurred', {
        'error.step': stepName,
        'error.message': error.message,
        'error.stack': error.stack?.slice(0, 500),
      });
    },

    /**
     * 结束追踪
     * @param {boolean} success - 是否成功
     */
    end(success = true) {
      if (this.completed) return;
      this.completed = true;

      const totalDuration = Date.now() - this.startTime;
      
      // 计算统计信息
      const completedSteps = this.currentStep;
      const totalSteps = this.steps.length;
      const completionRate = (completedSteps / totalSteps * 100).toFixed(1);

      this.span.setAttributes({
        'critical_path.total_duration_ms': totalDuration,
        'critical_path.completed_steps': completedSteps,
        'critical_path.total_steps': totalSteps,
        'critical_path.completion_rate': completionRate,
        'critical_path.success': success,
        'critical_path.duration_vs_expected_ms': totalDuration - this.path.expectedDurationMs,
      });

      // 检查是否超时
      if (totalDuration > this.path.expectedDurationMs) {
        this.span.addEvent('duration_exceeded', {
          'expected_ms': this.path.expectedDurationMs,
          'actual_ms': totalDuration,
          'over_ms': totalDuration - this.path.expectedDurationMs,
        });
      }

      // 设置状态
      this.span.setStatus({
        code: success ? traceApi.SpanStatusCode.OK : traceApi.SpanStatusCode.ERROR,
      });

      this.span.end();

      // 返回摘要
      return {
        pathName: this.pathName,
        totalDuration,
        expectedDuration: this.path.expectedDurationMs,
        completedSteps,
        totalSteps,
        success,
        stepTimings: this.stepTimings,
      };
    },
  };

  return tracker;
}

/**
 * 创建降级追踪器（无 OpenTelemetry）
 */
function createFallbackTracker(path, context) {
  const startTime = Date.now();
  
  return {
    path,
    pathName: path.name,
    currentStep: 0,
    steps: path.steps,
    startTime,
    stepTimings: [],
    completed: false,

    nextStep(stepName, attributes = {}) {
      const stepStartTime = Date.now();
      return {
        end: (resultAttributes = {}) => {
          const stepDuration = Date.now() - stepStartTime;
          this.stepTimings.push({ step: stepName, duration: stepDuration });
          this.currentStep++;
        },
      };
    },

    recordError(error, stepName) {
      logger.error({ module: 'CriticalPath:${path.name}] Error at ${stepName}', error: error.message.message }, 'CriticalPath:${path.name}] Error at ${stepName} error');;
    },

    end(success = true) {
      if (this.completed) return null;
      this.completed = true;
      
      const totalDuration = Date.now() - startTime;
      logger.info({ module: 'CriticalPath:${path.name}] Completed in ${totalDuration}ms, success=${success}' }, 'CriticalPath:${path.name}] Completed in ${totalDuration}ms, success=${success} message');;
      
      return {
        pathName: path.name,
        totalDuration,
        completedSteps: this.currentStep,
        totalSteps: this.steps.length,
        success,
        stepTimings: this.stepTimings,
      };
    },
  };
}

/**
 * 创建无操作追踪器（未知路径）
 */
function createNoOpTracker(pathName) {
  return {
    pathName,
    nextStep: () => ({ end: () => {} }),
    recordError: () => {},
    end: () => null,
  };
}

/**
 * 获取所有关键路径定义
 */
function getCriticalPaths() {
  return CRITICAL_PATHS;
}

/**
 * 获取路径定义
 * @param {string} pathName - 路径名称
 */
function getPathDefinition(pathName) {
  return CRITICAL_PATHS[pathName] || null;
}

module.exports = {
  startCriticalPath,
  getCriticalPaths,
  getPathDefinition,
  CRITICAL_PATHS,
};
