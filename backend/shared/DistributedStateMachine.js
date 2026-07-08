'use strict';

/**
 * DistributedStateMachine - 分布式状态机
 * REQ-00499: 事件驱动服务编排与分布式状态机引擎
 * 
 * 功能：
 * - Redis 分布式状态存储
 * - 状态转换原子性保证（分布式锁）
 * - 状态超时处理
 * - 状态历史记录
 */

const { createLogger } = require('./logger');
const { getRedis } = require('./redis');
const DistributedLock = require('./distributedLock');

const logger = createLogger('distributed-state-machine');

/**
 * 状态机配置
 */
const DEFAULT_CONFIG = {
  lockTimeout: 10000, // 分布式锁超时 10秒
  stateTimeout: 60000, // 状态默认超时 60秒
  historyLimit: 100, // 历史记录最大数量
  redisKeyPrefix: 'sm:'
};

/**
 * 状态机状态定义
 */
const StateMachineState = {
  // 流程状态
  PENDING: 'pending',
  RUNNING: 'running',
  STEP_WAITING: 'step-waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  COMPENSATING: 'compensating',
  COMPENSATED: 'compensated'
};

/**
 * 状态转换记录
 */
class StateTransition {
  constructor(data) {
    this.instanceId = data.instanceId;
    this.fromState = data.fromState;
    this.toState = data.toState;
    this.timestamp = data.timestamp || Date.now();
    this.metadata = data.metadata || {};
    this.trigger = data.trigger || 'manual';
  }

  toJSON() {
    return {
      instanceId: this.instanceId,
      fromState: this.fromState,
      toState: this.toState,
      timestamp: this.timestamp,
      metadata: this.metadata,
      trigger: this.trigger
    };
  }
}

/**
 * 分布式状态机
 */
class DistributedStateMachine {
  constructor(redisClient, config = {}) {
    this.redis = redisClient || getRedis();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lockManager = new DistributedLock(this.redis, {
      prefix: `${this.config.redisKeyPrefix}lock:`,
      timeout: this.config.lockTimeout
    });
    
    // 超时处理器映射
    this.timeoutHandlers = new Map();
    
    // Prometheus 指标
    this.metrics = {
      transitions: 0,
      transitionsFailed: 0,
      timeoutsTriggered: 0,
      stateLocksAcquired: 0,
      stateLocksFailed: 0
    };
  }

  /**
   * 获取当前状态
   */
  async getCurrentState(instanceId) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:state`;
    const state = await this.redis.get(key);
    
    if (!state) return null;
    
    const stateData = JSON.parse(state);
    return stateData.current;
  }

  /**
   * 获取完整状态数据
   */
  async getStateData(instanceId) {
    const key = `${this.config.redisKeyPrefix}${instanceId}:state`;
    const state = await this.redis.get(key);
    
    if (!state) return null;
    
    return JSON.parse(state);
  }

  /**
   * 状态转换（原子性）
   */
  async transition(instanceId, fromState, toState, metadata = {}) {
    const lockKey = `${instanceId}:transition`;
    const lock = await this.lockManager.acquire(lockKey);
    
    if (!lock.acquired) {
      this.metrics.stateLocksFailed++;
      logger.warn('Failed to acquire state lock', { 
        instanceId, 
        fromState, 
        toState 
      });
      throw new Error('State transition lock acquisition failed');
    }
    
    this.metrics.stateLocksAcquired++;
    
    try {
      const stateKey = `${this.config.redisKeyPrefix}${instanceId}:state`;
      
      // 检查当前状态
      const currentStateData = await this.redis.get(stateKey);
      const currentState = currentStateData ? JSON.parse(currentStateData).current : null;
      
      // 验证起始状态（如果指定）
      if (fromState && currentState !== fromState) {
        logger.warn('State transition rejected', {
          instanceId,
          expected: fromState,
          actual: currentState,
          target: toState
        });
        throw new Error(`Invalid state transition: expected ${fromState}, actual ${currentState}`);
      }
      
      // 记录转换
      const transition = new StateTransition({
        instanceId,
        fromState: currentState,
        toState,
        metadata
      });
      
      // 更新状态
      const newStateData = {
        current: toState,
        previous: currentState,
        updatedAt: Date.now(),
        metadata
      };
      
      await this.redis.multi()
        .set(stateKey, JSON.stringify(newStateData), 'EX', 86400)
        .rpush(
          `${this.config.redisKeyPrefix}${instanceId}:history`,
          JSON.stringify(transition.toJSON())
        )
        .ltrim(
          `${this.config.redisKeyPrefix}${instanceId}:history`,
          -this.config.historyLimit,
          -1
        )
        .exec();
      
      // 发布状态变更事件
      await this._publishStateChange(instanceId, transition);
      
      this.metrics.transitions++;
      
      logger.info('State transitioned', {
        instanceId,
        fromState: currentState,
        toState,
        metadata
      });
      
      return transition;
      
    } finally {
      await this.lockManager.release(lockKey);
    }
  }

  /**
   * 设置状态超时
   */
  async setTimeout(instanceId, timeoutMs, currentStep) {
    const timeoutKey = `${this.config.redisKeyPrefix}${instanceId}:timeout`;
    const timeoutAt = Date.now() + timeoutMs;
    
    await this.redis.set(
      timeoutKey,
      JSON.stringify({
        timeoutAt,
        currentStep,
        setAt: Date.now()
      }),
      'EX',
      Math.ceil(timeoutMs / 1000) + 60 // 留缓冲时间
    );
    
    // 设置 Redis 过期触发（用于检测）
    await this.redis.set(
      `${timeoutKey}:flag`,
      timeoutAt.toString(),
      'EX',
      Math.ceil(timeoutMs / 1000)
    );
    
    logger.debug('State timeout set', {
      instanceId,
      timeoutMs,
      currentStep,
      timeoutAt
    });
  }

  /**
   * 检查超时状态
   */
  async checkTimeout(instanceId) {
    const timeoutKey = `${this.config.redisKeyPrefix}${instanceId}:timeout`;
    const timeoutData = await this.redis.get(timeoutKey);
    
    if (!timeoutData) return { hasTimeout: false };
    
    const { timeoutAt, currentStep } = JSON.parse(timeoutData);
    const now = Date.now();
    
    if (now > timeoutAt) {
      // 触发超时处理
      const currentState = await this.getCurrentState(instanceId);
      
      await this.transition(instanceId, currentState, 'failed', {
        reason: 'timeout',
        timedOutStep: currentStep,
        timeoutAt,
        triggeredAt: now
      });
      
      // 清理超时记录
      await this.redis.del(timeoutKey);
      await this.redis.del(`${timeoutKey}:flag`);
      
      this.metrics.timeoutsTriggered++;
      
      logger.warn('State timeout triggered', {
        instanceId,
        timedOutStep: currentStep,
        currentState
      });
      
      return {
        hasTimeout: true,
        timedOut: true,
        currentStep
      };
    }
    
    return {
      hasTimeout: true,
      timedOut: false,
      remaining: timeoutAt - now,
      currentStep
    };
  }

  /**
   * 清除超时设置
   */
  async clearTimeout(instanceId) {
    const timeoutKey = `${this.config.redisKeyPrefix}${instanceId}:timeout`;
    await this.redis.del(timeoutKey);
    await this.redis.del(`${timeoutKey}:flag`);
    
    logger.debug('Timeout cleared', { instanceId });
  }

  /**
   * 获取状态历史
   */
  async getHistory(instanceId, limit = 20) {
    const historyKey = `${this.config.redisKeyPrefix}${instanceId}:history`;
    const history = await this.redis.lrange(historyKey, -limit, -1);
    
    return history.map(h => JSON.parse(h));
  }

  /**
   * 获取完整状态上下文
   */
  async getFullContext(instanceId) {
    const state = await this.getStateData(instanceId);
    const history = await this.getHistory(instanceId, 10);
    const timeoutCheck = await this.checkTimeout(instanceId);
    
    return {
      state,
      history,
      timeout: timeoutCheck
    };
  }

  /**
   * 发布状态变更事件
   */
  async _publishStateChange(instanceId, transition) {
    const channel = `${this.config.redisKeyPrefix}events`;
    
    await this.redis.publish(channel, JSON.stringify({
      type: 'state.change',
      instanceId,
      transition: transition.toJSON()
    }));
  }

  /**
   * 检查状态是否为终态
   */
  isFinalState(state) {
    const finalStates = [
      StateMachineState.COMPLETED,
      StateMachineState.FAILED,
      StateMachineState.COMPENSATED
    ];
    return finalStates.includes(state);
  }

  /**
   * 检查状态是否可转换
   */
  canTransition(fromState, toState) {
    // 简化版状态转换规则
    const allowedTransitions = {
      [StateMachineState.PENDING]: [
        StateMachineState.RUNNING,
        StateMachineState.CANCELLED
      ],
      [StateMachineState.RUNNING]: [
        StateMachineState.STEP_WAITING,
        StateMachineState.COMPLETED,
        StateMachineState.FAILED,
        StateMachineState.CANCELLED,
        StateMachineState.COMPENSATING
      ],
      [StateMachineState.STEP_WAITING]: [
        StateMachineState.RUNNING,
        StateMachineState.COMPLETED,
        StateMachineState.FAILED,
        StateMachineState.COMPENSATING
      ],
      [StateMachineState.FAILED]: [
        StateMachineState.COMPENSATING
      ],
      [StateMachineState.COMPENSATING]: [
        StateMachineState.COMPENSATED,
        StateMachineState.FAILED
      ],
      // 终态不可转换
      [StateMachineState.COMPLETED]: [],
      [StateMachineState.COMPENSATED]: [],
      [StateMachineState.CANCELLED]: []
    };
    
    const allowed = allowedTransitions[fromState] || [];
    return allowed.includes(toState);
  }

  /**
   * 批量获取多个实例状态
   */
  async batchGetStates(instanceIds) {
    const states = {};
    
    for (const instanceId of instanceIds) {
      states[instanceId] = await this.getCurrentState(instanceId);
    }
    
    return states;
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
# HELP sm_transitions_total Total state transitions
# TYPE sm_transitions_total counter
sm_transitions_total ${m.transitions}

# HELP sm_transitions_failed_total Failed state transitions
# TYPE sm_transitions_failed_total counter
sm_transitions_failed_total ${m.transitionsFailed}

# HELP sm_timeouts_triggered_total Timeouts triggered
# TYPE sm_timeouts_triggered_total counter
sm_timeouts_triggered_total ${m.timeoutsTriggered}

# HELP sm_locks_acquired_total State locks acquired
# TYPE sm_locks_acquired_total counter
sm_locks_acquired_total ${m.stateLocksAcquired}

# HELP sm_locks_failed_total State locks failed
# TYPE sm_locks_failed_total counter
sm_locks_failed_total ${m.stateLocksFailed}
`;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      await this.redis.ping();
      return {
        healthy: true,
        metrics: this.metrics
      };
    } catch (err) {
      return {
        healthy: false,
        error: err.message
      };
    }
  }
}

module.exports = {
  DistributedStateMachine,
  StateMachineState,
  StateTransition,
  DEFAULT_CONFIG
};