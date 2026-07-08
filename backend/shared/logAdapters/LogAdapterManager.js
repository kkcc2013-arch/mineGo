/**
 * 日志适配器管理器
 * 管理多个日志输出适配器的协调工作
 */
'use strict';

const EventEmitter = require('events');

class LogAdapterManager extends EventEmitter {
  constructor() {
    super();
    this.adapters = new Map();
    this.adapterConfigs = new Map();
    this.fallbackAdapter = null;
    this.degradedMode = false;
    this.degradedAdapter = null;
    this.initialized = false;
    this.stats = {
      totalLogs: 0,
      successfulWrites: 0,
      failedWrites: 0,
      degradedWrites: 0
    };
  }

  /**
   * 注册适配器
   * @param {ILogOutputAdapter} adapter - 适配器实例
   * @param {Object} config - 适配器配置
   */
  async registerAdapter(adapter, config = {}) {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter ${adapter.name} already registered`);
    }
    
    this.adapters.set(adapter.name, adapter);
    this.adapterConfigs.set(adapter.name, config);
    
    // 初始化适配器
    if (config.enabled) {
      try {
        await adapter.initialize(config);
        this.emit('adapter:initialized', { name: adapter.name });
      } catch (error) {
        this.emit('adapter:error', { name: adapter.name, error, phase: 'initialize' });
        throw error;
      }
    }
    
    // 设置降级适配器
    if (config.isFallback) {
      this.fallbackAdapter = adapter;
    }
  }

  /**
   * 移除适配器
   * @param {string} name - 适配器名称
   */
  async removeAdapter(name) {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Adapter ${name} not found`);
    }
    
    await adapter.close();
    this.adapters.delete(name);
    this.adapterConfigs.delete(name);
    
    this.emit('adapter:removed', { name });
  }

  /**
   * 获取适配器
   * @param {string} name - 适配器名称
   */
  getAdapter(name) {
    return this.adapters.get(name);
  }

  /**
   * 获取所有适配器状态
   */
  async getAllAdapterStates() {
    const states = {};
    for (const [name, adapter] of this.adapters) {
      states[name] = await adapter.healthCheck();
    }
    return states;
  }

  /**
   * 写入日志到所有启用的适配器
   * @param {Object} logEntry - 日志条目
   */
  async writeToAll(logEntry) {
    this.stats.totalLogs++;
    
    const errors = [];
    const enabledAdapters = [];
    
    for (const [name, adapter] of this.adapters) {
      const config = this.adapterConfigs.get(name);
      if (config?.enabled && adapter.initialized) {
        enabledAdapters.push({ name, adapter });
      }
    }
    
    // 如果处于降级模式，只写入降级适配器
    if (this.degradedMode && this.degradedAdapter) {
      try {
        await this.degradedAdapter.write(logEntry);
        this.stats.degradedWrites++;
        return;
      } catch (error) {
        this.stats.failedWrites++;
        throw error;
      }
    }
    
    // 并行写入所有适配器
    for (const { name, adapter } of enabledAdapters) {
      try {
        await adapter.write(logEntry);
        this.stats.successfulWrites++;
      } catch (error) {
        errors.push({ name, error });
        this.stats.failedWrites++;
        this.emit('adapter:write-error', { name, error, logEntry });
      }
    }
    
    // 所有适配器都失败，尝试降级
    if (errors.length === enabledAdapters.length) {
      await this.handleDegradation(logEntry, errors);
    }
  }

  /**
   * 批量写入日志
   * @param {Array} logEntries - 日志条目数组
   */
  async writeToAllBatch(logEntries) {
    this.stats.totalLogs += logEntries.length;
    
    const errors = [];
    const enabledAdapters = [];
    
    for (const [name, adapter] of this.adapters) {
      const config = this.adapterConfigs.get(name);
      if (config?.enabled && adapter.initialized) {
        enabledAdapters.push({ name, adapter });
      }
    }
    
    if (this.degradedMode && this.degradedAdapter) {
      try {
        await this.degradedAdapter.writeBatch(logEntries);
        this.stats.degradedWrites += logEntries.length;
        return;
      } catch (error) {
        this.stats.failedWrites += logEntries.length;
        throw error;
      }
    }
    
    for (const { name, adapter } of enabledAdapters) {
      try {
        await adapter.writeBatch(logEntries);
        this.stats.successfulWrites += logEntries.length;
      } catch (error) {
        errors.push({ name, error });
        this.stats.failedWrites += logEntries.length;
      }
    }
    
    if (errors.length === enabledAdapters.length) {
      await this.handleDegradation(logEntries, errors, true);
    }
  }

  /**
   * 处理降级
   */
  async handleDegradation(logEntry, errors, isBatch = false) {
    if (this.fallbackAdapter && this.fallbackAdapter.initialized) {
      this.degradedMode = true;
      this.degradedAdapter = this.fallbackAdapter;
      
      this.emit('manager:degraded', {
        reason: 'All primary adapters failed',
        errors,
        fallback: this.fallbackAdapter.name
      });
      
      try {
        if (isBatch) {
          await this.fallbackAdapter.writeBatch(logEntry);
        } else {
          await this.fallbackAdapter.write(logEntry);
        }
        this.stats.degradedWrites += isBatch ? logEntry.length : 1;
      } catch (fallbackError) {
        this.stats.failedWrites += isBatch ? logEntry.length : 1;
        this.emit('manager:fallback-failed', { error: fallbackError });
        throw new Error('All adapters including fallback failed');
      }
      
      // 定期尝试恢复
      this.scheduleRecovery();
    } else {
      throw new Error('No fallback adapter available');
    }
  }

  /**
   * 定期尝试恢复
   */
  scheduleRecovery() {
    if (this.recoveryTimer) return;
    
    this.recoveryTimer = setInterval(async () => {
      const states = await this.getAllAdapterStates();
      
      // 检查是否有健康的适配器
      for (const [name, state] of Object.entries(states)) {
        if (state.status === 'healthy' && name !== this.fallbackAdapter?.name) {
          this.degradedMode = false;
          this.degradedAdapter = null;
          
          clearInterval(this.recoveryTimer);
          this.recoveryTimer = null;
          
          this.emit('manager:recovered', { recoveredAdapter: name });
          return;
        }
      }
    }, 30000); // 每 30 秒检查一次
  }

  /**
   * 刷新所有缓冲区
   */
  async flushAll() {
    for (const [name, adapter] of this.adapters) {
      if (adapter.initialized) {
        try {
          await adapter.flush();
          this.emit('adapter:flushed', { name });
        } catch (error) {
          this.emit('adapter:error', { name, error, phase: 'flush' });
        }
      }
    }
  }

  /**
   * 关闭所有适配器
   */
  async closeAll() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    
    await this.flushAll();
    
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.close();
        this.emit('adapter:closed', { name });
      } catch (error) {
        this.emit('adapter:error', { name, error, phase: 'close' });
      }
    }
    
    this.initialized = false;
  }

  /**
   * 健康检查所有适配器
   */
  async healthCheckAll() {
    const results = new Map();
    
    for (const [name, adapter] of this.adapters) {
      try {
        const health = await adapter.healthCheck();
        results.set(name, health);
      } catch (error) {
        results.set(name, {
          name,
          status: 'error',
          error: error.message
        });
      }
    }
    
    return {
      adapters: results,
      manager: {
        initialized: this.initialized,
        degradedMode: this.degradedMode,
        degradedAdapter: this.degradedAdapter?.name || null,
        fallbackAdapter: this.fallbackAdapter?.name || null,
        stats: this.stats
      }
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      adaptersCount: this.adapters.size,
      degradedMode: this.degradedMode
    };
  }

  /**
   * 动态启用/禁用适配器
   */
  async setAdapterEnabled(name, enabled) {
    const adapter = this.adapters.get(name);
    const config = this.adapterConfigs.get(name);
    
    if (!adapter) {
      throw new Error(`Adapter ${name} not found`);
    }
    
    if (enabled && !adapter.initialized) {
      await adapter.initialize(config);
    } else if (!enabled && adapter.initialized) {
      await adapter.close();
    }
    
    this.adapterConfigs.set(name, { ...config, enabled });
    this.emit('adapter:enabled-changed', { name, enabled });
  }
}

module.exports = LogAdapterManager;