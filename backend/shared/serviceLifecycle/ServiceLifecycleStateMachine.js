// backend/shared/serviceLifecycle/ServiceLifecycleStateMachine.js
// 服务生命周期状态机
'use strict';

const EventEmitter = require('events');
const { ServiceLifecycleState, STATE_TRANSITIONS, STATE_DESCRIPTIONS } = require('./ServiceLifecycleState');

/**
 * 服务生命周期状态机
 * 管理服务状态的转换和事件通知
 */
class ServiceLifecycleStateMachine extends EventEmitter {
  constructor(serviceName) {
    super();
    this.serviceName = serviceName;
    this.currentState = ServiceLifecycleState.UNINITIALIZED;
    this.previousState = null;
    this.stateHistory = [];
    this.transitionCallbacks = new Map();
    this.errorInfo = null;
    this.stateEnteredAt = null;
    this.maxHistorySize = 100;
  }

  /**
   * 获取当前状态
   */
  getCurrentState() {
    return this.currentState;
  }

  /**
   * 获取当前状态描述
   */
  getCurrentStateDescription() {
    return STATE_DESCRIPTIONS[this.currentState] || 'Unknown state';
  }

  /**
   * 检查是否可以转换到目标状态
   */
  canTransitionTo(targetState) {
    const allowedTransitions = STATE_TRANSITIONS[this.currentState] || [];
    return allowedTransitions.includes(targetState);
  }

  /**
   * 转换到目标状态
   */
  async transitionTo(targetState, metadata = {}) {
    if (!this.canTransitionTo(targetState)) {
      const error = new Error(
        `Invalid state transition: ${this.currentState} → ${targetState}. ` +
        `Allowed transitions: ${STATE_TRANSITIONS[this.currentState]?.join(', ') || 'none'}`
      );
      this.emit('transition:error', { 
        serviceName: this.serviceName,
        from: this.currentState, 
        to: targetState, 
        error,
        metadata
      });
      throw error;
    }

    const previousState = this.currentState;
    const transitionTimestamp = Date.now();

    // 记录状态历史
    const historyEntry = {
      from: previousState,
      to: targetState,
      timestamp: transitionTimestamp,
      metadata,
      duration: this.stateEnteredAt ? transitionTimestamp - this.stateEnteredAt : 0
    };
    
    this.stateHistory.push(historyEntry);
    
    // 限制历史记录大小
    if (this.stateHistory.length > this.maxHistorySize) {
      this.stateHistory = this.stateHistory.slice(-this.maxHistorySize);
    }

    // 更新状态
    this.previousState = previousState;
    this.currentState = targetState;
    this.stateEnteredAt = transitionTimestamp;

    // 执行状态进入回调
    const callback = this.transitionCallbacks.get(targetState);
    if (callback) {
      try {
        await callback(metadata);
      } catch (error) {
        console.error(`State transition callback failed for ${targetState}:`, error);
        this.errorInfo = { error, metadata, timestamp: transitionTimestamp };
        await this.transitionTo(ServiceLifecycleState.ERROR, { 
          error: error.message,
          originalTransition: { from: previousState, to: targetState }
        });
        throw error;
      }
    }

    // 发出状态变更事件
    this.emit('state:changed', {
      serviceName: this.serviceName,
      from: previousState,
      to: targetState,
      timestamp: transitionTimestamp,
      metadata,
      duration: historyEntry.duration
    });

    return {
      previousState,
      currentState: targetState,
      timestamp: transitionTimestamp,
      description: STATE_DESCRIPTIONS[targetState]
    };
  }

  /**
   * 注册状态进入回调
   */
  onEnterState(state, callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    this.transitionCallbacks.set(state, callback);
  }

  /**
   * 移除状态回调
   */
  removeStateCallback(state) {
    this.transitionCallbacks.delete(state);
  }

  /**
   * 强制转换到错误状态
   */
  async transitionToError(error, metadata = {}) {
    this.errorInfo = { 
      error, 
      metadata, 
      timestamp: Date.now(),
      previousState: this.currentState
    };
    
    try {
      await this.transitionTo(ServiceLifecycleState.ERROR, { 
        error: error.message || String(error), 
        stack: error.stack,
        ...metadata 
      });
    } catch (transitionError) {
      // 如果转换到 ERROR 状态失败，直接设置状态
      console.error('Failed to transition to ERROR state:', transitionError);
      this.currentState = ServiceLifecycleState.ERROR;
      this.emit('state:error', {
        serviceName: this.serviceName,
        error,
        metadata
      });
    }
  }

  /**
   * 获取状态历史
   */
  getStateHistory(limit = 50) {
    return this.stateHistory.slice(-limit);
  }

  /**
   * 获取当前状态持续时间（毫秒）
   */
  getStateDuration() {
    if (!this.stateEnteredAt) return 0;
    return Date.now() - this.stateEnteredAt;
  }

  /**
   * 检查是否处于运行状态
   */
  isRunning() {
    return [ServiceLifecycleState.HEALTHY, ServiceLifecycleState.DEGRADED].includes(this.currentState);
  }

  /**
   * 检查是否可以接受请求
   */
  canAcceptRequests() {
    return this.currentState === ServiceLifecycleState.HEALTHY;
  }

  /**
   * 检查是否处于关闭状态
   */
  isShuttingDown() {
    return [
      ServiceLifecycleState.DRAINING,
      ServiceLifecycleState.STOPPING,
      ServiceLifecycleState.STOPPING_PLUGINS,
      ServiceLifecycleState.CLOSING_CONNECTIONS,
      ServiceLifecycleState.CLEANUP_RESOURCES
    ].includes(this.currentState);
  }

  /**
   * 获取错误信息
   */
  getErrorInfo() {
    return this.errorInfo;
  }

  /**
   * 清除错误信息
   */
  clearError() {
    this.errorInfo = null;
  }

  /**
   * 导出状态快照
   */
  exportSnapshot() {
    return {
      serviceName: this.serviceName,
      currentState: this.currentState,
      currentStateDescription: this.getCurrentStateDescription(),
      previousState: this.previousState,
      stateDuration: this.getStateDuration(),
      stateEnteredAt: this.stateEnteredAt,
      errorInfo: this.errorInfo ? {
        error: this.errorInfo.error?.message || String(this.errorInfo.error),
        timestamp: this.errorInfo.timestamp
      } : null,
      stateHistoryCount: this.stateHistory.length,
      exportedAt: Date.now()
    };
  }

  /**
   * 从快照恢复状态（用于重启恢复）
   */
  restoreFromSnapshot(snapshot) {
    if (snapshot.serviceName !== this.serviceName) {
      throw new Error(`Snapshot serviceName mismatch: ${snapshot.serviceName} !== ${this.serviceName}`);
    }
    
    // 只允许从 stopped 或 error 状态恢复
    if (snapshot.currentState !== ServiceLifecycleState.STOPPED && 
        snapshot.currentState !== ServiceLifecycleState.ERROR) {
      throw new Error(`Cannot restore from non-terminal state: ${snapshot.currentState}`);
    }
    
    this.currentState = snapshot.currentState;
    this.previousState = snapshot.previousState;
    this.errorInfo = snapshot.errorInfo;
    this.stateEnteredAt = Date.now();
    
    this.emit('state:restored', {
      serviceName: this.serviceName,
      restoredFrom: snapshot.currentState,
      timestamp: Date.now()
    });
  }

  /**
   * 重置状态机
   */
  reset() {
    this.currentState = ServiceLifecycleState.UNINITIALIZED;
    this.previousState = null;
    this.stateHistory = [];
    this.errorInfo = null;
    this.stateEnteredAt = null;
    
    this.emit('state:reset', {
      serviceName: this.serviceName,
      timestamp: Date.now()
    });
  }
}

module.exports = ServiceLifecycleStateMachine;
