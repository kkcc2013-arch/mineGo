/**
 * REQ-00481: 精灵数据预编译缓存系统
 * 数据变更监听器 - 监听配置变更并自动触发缓存更新
 */

'use strict';

const { createLogger } = require('./logger');
const { getInstance: getCacheInstance } = require('./pokemonPrecompiledCache');
const EventBus = require('./EventBus');

const logger = createLogger('DataConfigChangeMonitor');

/**
 * 数据配置变更监听器
 */
class DataConfigChangeMonitor {
  constructor() {
    this.cache = null;
    this.eventHandlers = new Map();
    this.debounceTimers = new Map();
    this.debounceDelay = 1000; // 1 秒防抖
  }

  /**
   * 初始化监听器
   */
  async initialize() {
    this.cache = getCacheInstance();
    
    // 注册事件处理器
    this.registerEventHandlers();
    
    logger.info('DataConfigChangeMonitor initialized');
  }

  /**
   * 注册事件处理器
   */
  registerEventHandlers() {
    // 监听精灵配置变更
    this.eventHandlers.set('pokemon:species:updated', async (data) => {
      await this.handleSpeciesUpdate(data);
    });
    
    this.eventHandlers.set('pokemon:species:created', async (data) => {
      await this.handleSpeciesCreate(data);
    });
    
    this.eventHandlers.set('pokemon:species:deleted', async (data) => {
      await this.handleSpeciesDelete(data);
    });
    
    // 监听技能配置变更
    this.eventHandlers.set('pokemon:moves:updated', async (data) => {
      await this.handleMovesUpdate(data);
    });
    
    // 监听进化链配置变更
    this.eventHandlers.set('pokemon:evolution:updated', async (data) => {
      await this.handleEvolutionUpdate(data);
    });
    
    // 监听批量配置变更
    this.eventHandlers.set('pokemon:config:bulkUpdate', async (data) => {
      await this.handleBulkUpdate(data);
    });
    
    // 注册所有事件监听器
    for (const [event, handler] of this.eventHandlers) {
      EventBus.on(event, handler);
      logger.debug('Event handler registered', { event });
    }
  }

  /**
   * 处理精灵更新事件
   * @param {Object} data - 事件数据
   */
  async handleSpeciesUpdate(data) {
    const { pokemonId } = data;
    
    // 防抖处理
    const timerKey = `update:${pokemonId}`;
    
    if (this.debounceTimers.has(timerKey)) {
      clearTimeout(this.debounceTimers.get(timerKey));
    }
    
    this.debounceTimers.set(timerKey, setTimeout(async () => {
      try {
        logger.info('Processing species update', { pokemonId });
        
        // 使旧缓存失效
        await this.cache.invalidate(pokemonId);
        
        // 重新加载并编译数据
        const compiledData = await this.cache.fetchAndCompile(pokemonId);
        
        if (compiledData) {
          // 更新缓存
          await this.cache.set(pokemonId, compiledData);
          
          // 发布缓存更新事件
          EventBus.emit('cache:updated', {
            type: 'pokemon',
            id: pokemonId,
            timestamp: Date.now()
          });
        }
        
        this.debounceTimers.delete(timerKey);
      } catch (err) {
        logger.error('Failed to handle species update', { pokemonId, err: err.message });
      }
    }, this.debounceDelay));
  }

  /**
   * 处理精灵创建事件
   * @param {Object} data - 事件数据
   */
  async handleSpeciesCreate(data) {
    const { pokemonId } = data;
    
    try {
      logger.info('Processing species create', { pokemonId });
      
      // 编译新数据
      const compiledData = await this.cache.fetchAndCompile(pokemonId);
      
      if (compiledData) {
        // 存储到缓存
        await this.cache.set(pokemonId, compiledData);
        
        EventBus.emit('cache:created', {
          type: 'pokemon',
          id: pokemonId,
          timestamp: Date.now()
        });
      }
    } catch (err) {
      logger.error('Failed to handle species create', { pokemonId, err: err.message });
    }
  }

  /**
   * 处理精灵删除事件
   * @param {Object} data - 事件数据
   */
  async handleSpeciesDelete(data) {
    const { pokemonId } = data;
    
    try {
      logger.info('Processing species delete', { pokemonId });
      
      // 删除缓存
      await this.cache.invalidate(pokemonId);
      
      EventBus.emit('cache:deleted', {
        type: 'pokemon',
        id: pokemonId,
        timestamp: Date.now()
      });
    } catch (err) {
      logger.error('Failed to handle species delete', { pokemonId, err: err.message });
    }
  }

  /**
   * 处理技能更新事件
   * @param {Object} data - 事件数据
   */
  async handleMovesUpdate(data) {
    const { pokemonIds } = data;
    
    // 批量更新受影响的精灵
    for (const pokemonId of pokemonIds) {
      await this.handleSpeciesUpdate({ pokemonId });
    }
  }

  /**
   * 处理进化链更新事件
   * @param {Object} data - 事件数据
   */
  async handleEvolutionUpdate(data) {
    const { evolutionChain } = data;
    
    // 更新整个进化链的所有精灵
    for (const pokemonId of evolutionChain) {
      await this.handleSpeciesUpdate({ pokemonId });
    }
  }

  /**
   * 处理批量更新事件
   * @param {Object} data - 事件数据
   */
  async handleBulkUpdate(data) {
    const { changes } = data;
    
    logger.info('Processing bulk update', { changeCount: changes.length });
    
    // 更新版本号
    await this.cache.updateVersion();
    
    // 批量处理变更
    for (const change of changes) {
      switch (change.type) {
        case 'update':
          await this.handleSpeciesUpdate({ pokemonId: change.pokemonId });
          break;
        case 'create':
          await this.handleSpeciesCreate({ pokemonId: change.pokemonId });
          break;
        case 'delete':
          await this.handleSpeciesDelete({ pokemonId: change.pokemonId });
          break;
      }
    }
    
    logger.info('Bulk update completed');
  }

  /**
   * 手动触发更新（用于测试或管理接口）
   * @param {string} event - 事件名称
   * @param {Object} data - 事件数据
   */
  async triggerUpdate(event, data) {
    const handler = this.eventHandlers.get(event);
    
    if (handler) {
      await handler(data);
    } else {
      logger.warn('Unknown event', { event });
    }
  }

  /**
   * 关闭监听器
   */
  async close() {
    // 清理所有防抖定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    
    this.debounceTimers.clear();
    
    // 移除事件监听器
    for (const [event, handler] of this.eventHandlers) {
      EventBus.off(event, handler);
    }
    
    logger.info('DataConfigChangeMonitor closed');
  }

  /**
   * 获取监听器状态
   */
  getStatus() {
    return {
      handlersRegistered: this.eventHandlers.size,
      pendingTimers: this.debounceTimers.size
    };
  }
}

// 单例
let monitorInstance = null;

function getMonitorInstance() {
  if (!monitorInstance) {
    monitorInstance = new DataConfigChangeMonitor();
  }
  return monitorInstance;
}

module.exports = {
  DataConfigChangeMonitor,
  getMonitorInstance
};