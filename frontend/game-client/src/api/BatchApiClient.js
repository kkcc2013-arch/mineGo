// frontend/game-client/src/api/BatchApiClient.js
// REQ-00092: API 请求合并与批量查询优化 - 批量请求客户端
'use strict';

/**
 * BatchApiClient - 批量请求合并与去重客户端
 * 
 * 功能:
 * 1. 请求去重: 短时间内相同请求自动合并
 * 2. 批量查询: 将多个单条查询合并为批量请求
 * 3. 智能缓存: 本地内存缓存减少重复请求
 */
export class BatchApiClient {
  constructor(apiClient, options = {}) {
    this._apiClient = apiClient;
    
    // 配置
    this._config = {
      batchWindow: options.batchWindow || 50,      // 批量窗口期 (ms)
      maxBatchSize: options.maxBatchSize || 20,    // 单次批量最大请求数
      dedupeWindow: options.dedupeWindow || 100,   // 去重窗口期 (ms)
      cacheTTL: options.cacheTTL || 300000,        // 内存缓存 TTL (5分钟)
      maxCacheSize: options.maxCacheSize || 200    // 最大缓存条目数
    };
    
    // 请求去重
    this._pendingRequests = new Map();
    
    // 批量请求队列
    this._batchQueues = new Map();
    
    // 内存缓存
    this._memoryCache = new Map();
    this._cacheOrder = []; // LRU 顺序
    
    // 统计
    this._stats = {
      dedupeHits: 0,
      batchRequests: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 请求去重
  // ═══════════════════════════════════════════════════════════

  /**
   * 发起请求（自动去重）
   * 短时间内相同请求只发起一次，多个调用者共享同一个 Promise
   */
  async request(method, path, body, options = {}) {
    const requestKey = `${method}:${path}:${JSON.stringify(body || {})}`;
    
    // 检查是否有正在进行的相同请求
    if (this._pendingRequests.has(requestKey)) {
      this._stats.dedupeHits++;
      return this._pendingRequests.get(requestKey);
    }
    
    // 检查内存缓存（仅 GET 请求）
    if (method === 'GET' && !options.skipCache) {
      const cached = this._getCached(requestKey);
      if (cached) {
        this._stats.cacheHits++;
        return Promise.resolve(cached);
      }
    }
    
    // 创建请求 Promise
    const promise = this._executeRequest(method, path, body, options)
      .then(result => {
        // 缓存 GET 请求结果
        if (method === 'GET' && !options.skipCache) {
          this._setCache(requestKey, result);
        }
        return result;
      })
      .finally(() => {
        // 延迟移除（窗口期内相同请求仍可去重）
        setTimeout(() => {
          this._pendingRequests.delete(requestKey);
        }, this._config.dedupeWindow);
      });
    
    this._pendingRequests.set(requestKey, promise);
    return promise;
  }

  async _executeRequest(method, path, body, options) {
    // 调用底层 API 客户端
    if (method === 'GET') {
      return this._apiClient.get(path, options);
    } else if (method === 'POST') {
      return this._apiClient.post(path, body, options);
    } else if (method === 'PUT') {
      return this._apiClient.put(path, body, options);
    } else if (method === 'DELETE') {
      return this._apiClient.delete(path, options);
    }
    throw new Error(`Unsupported method: ${method}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 批量查询 API
  // ═══════════════════════════════════════════════════════════

  /**
   * 批量获取精灵详情
   * @param {number[]} ids - 精灵实例 ID 列表
   * @returns {Promise<Object[]>} 精灵详情数组
   */
  async batchGetPokemonDetails(ids) {
    if (!ids || ids.length === 0) return [];
    
    // 单条请求直接走单条接口
    if (ids.length === 1) {
      const result = await this.request('GET', `/pokemon/my/${ids[0]}`);
      return [result];
    }
    
    // 批量请求
    this._stats.batchRequests++;
    const response = await this.request('POST', '/pokemon/batch/details', { ids });
    return response.pokemon || [];
  }

  /**
   * 批量获取精灵种族数据
   * @param {number[]} speciesIds - 种族 ID 列表
   * @returns {Promise<Object[]>} 种族数据数组
   */
  async batchGetSpecies(speciesIds) {
    if (!speciesIds || speciesIds.length === 0) return [];
    
    if (speciesIds.length === 1) {
      const result = await this.request('GET', `/pokemon/species/${speciesIds[0]}`);
      return [result];
    }
    
    this._stats.batchRequests++;
    const response = await this.request('POST', '/pokemon/batch/species', { speciesIds });
    return response.species || [];
  }

  /**
   * 批量获取好友状态
   * @param {string[]} friendIds - 好友 ID 列表
   * @returns {Promise<Object[]>} 好友状态数组
   */
  async batchGetFriendStatus(friendIds) {
    if (!friendIds || friendIds.length === 0) return [];
    
    if (friendIds.length === 1) {
      const result = await this.request('GET', `/social/friends/${friendIds[0]}/status`);
      return [result];
    }
    
    this._stats.batchRequests++;
    const response = await this.request('POST', '/social/batch/friends/status', { friendIds });
    return response.friends || [];
  }

  /**
   * 批量获取道馆信息
   * @param {string[]} gymIds - 道馆 ID 列表
   * @returns {Promise<Object[]>} 道馆信息数组
   */
  async batchGetGyms(gymIds) {
    if (!gymIds || gymIds.length === 0) return [];
    
    if (gymIds.length === 1) {
      const result = await this.request('GET', `/gym/${gymIds[0]}`);
      return [result];
    }
    
    this._stats.batchRequests++;
    const response = await this.request('POST', '/gym/batch/details', { gymIds });
    return response.gyms || [];
  }

  // ═══════════════════════════════════════════════════════════
  // 智能请求合并（延迟窗口内的请求自动合并）
  // ═══════════════════════════════════════════════════════════

  /**
   * 将请求加入批量队列
   * 在窗口期内的所有请求会合并为一个批量请求
   */
  queueBatchRequest(endpoint, id) {
    return new Promise((resolve, reject) => {
      if (!this._batchQueues.has(endpoint)) {
        this._batchQueues.set(endpoint, {
          ids: [],
          resolves: [],
          rejects: [],
          timer: null
        });
      }

      const batch = this._batchQueues.get(endpoint);
      batch.ids.push(id);
      batch.resolves.push(resolve);
      batch.rejects.push(reject);

      // 达到最大批量大小立即执行
      if (batch.ids.length >= this._config.maxBatchSize) {
        this._executeBatch(endpoint);
      } else if (!batch.timer) {
        // 设置窗口期定时器
        batch.timer = setTimeout(() => {
          this._executeBatch(endpoint);
        }, this._config.batchWindow);
      }
    });
  }

  /**
   * 执行批量请求
   */
  async _executeBatch(endpoint) {
    const batch = this._batchQueues.get(endpoint);
    if (!batch || batch.ids.length === 0) return;

    this._batchQueues.delete(endpoint);
    clearTimeout(batch.timer);

    try {
      // 根据端点选择批量方法
      let results;
      const uniqueIds = [...new Set(batch.ids)];
      
      if (endpoint === 'pokemon/details') {
        results = await this.batchGetPokemonDetails(uniqueIds);
      } else if (endpoint === 'pokemon/species') {
        results = await this.batchGetSpecies(uniqueIds);
      } else if (endpoint === 'friends/status') {
        results = await this.batchGetFriendStatus(uniqueIds);
      } else if (endpoint === 'gyms') {
        results = await this.batchGetGyms(uniqueIds);
      } else {
        throw new Error(`Unknown batch endpoint: ${endpoint}`);
      }
      
      // 按 ID 映射结果
      const resultMap = new Map(results.map(r => [r?.id, r]));
      
      // 分发结果给所有等待者
      batch.resolves.forEach((resolve, i) => {
        resolve(resultMap.get(batch.ids[i]) || null);
      });
    } catch (error) {
      // 所有等待者收到相同错误
      batch.rejects.forEach(reject => reject(error));
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 内存缓存
  // ═══════════════════════════════════════════════════════════

  _getCached(key) {
    const entry = this._memoryCache.get(key);
    if (!entry) {
      this._stats.cacheMisses++;
      return null;
    }
    
    // 检查 TTL
    if (Date.now() - entry.timestamp > this._config.cacheTTL) {
      this._memoryCache.delete(key);
      this._cacheOrder = this._cacheOrder.filter(k => k !== key);
      this._stats.cacheMisses++;
      return null;
    }
    
    // 更新 LRU 顺序
    this._cacheOrder = this._cacheOrder.filter(k => k !== key);
    this._cacheOrder.push(key);
    
    return entry.data;
  }

  _setCache(key, data) {
    // LRU 淘汰
    while (this._memoryCache.size >= this._config.maxCacheSize) {
      const oldest = this._cacheOrder.shift();
      if (oldest) {
        this._memoryCache.delete(oldest);
      }
    }
    
    this._memoryCache.set(key, {
      data,
      timestamp: Date.now()
    });
    this._cacheOrder.push(key);
  }

  /**
   * 清除缓存
   * @param {string} pattern - 可选的键模式匹配
   */
  clearCache(pattern) {
    if (!pattern) {
      this._memoryCache.clear();
      this._cacheOrder = [];
      return;
    }
    
    // 按模式清除
    for (const key of this._memoryCache.keys()) {
      if (key.includes(pattern)) {
        this._memoryCache.delete(key);
        this._cacheOrder = this._cacheOrder.filter(k => k !== key);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 统计与调试
  // ═══════════════════════════════════════════════════════════

  getStats() {
    const totalRequests = this._stats.cacheHits + this._stats.cacheMisses;
    
    return {
      ...this._stats,
      cacheHitRate: totalRequests > 0 ? 
        (this._stats.cacheHits / totalRequests * 100).toFixed(1) + '%' : '0%',
      dedupeRate: this._stats.dedupeHits > 0 ?
        (this._stats.dedupeHits / (this._stats.dedupeHits + this._stats.batchRequests) * 100).toFixed(1) + '%' : '0%',
      cacheSize: this._memoryCache.size,
      pendingRequests: this._pendingRequests.size,
      batchQueues: this._batchQueues.size
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this._stats = {
      dedupeHits: 0,
      batchRequests: 0,
      cacheHits: 0,
      cacheMisses: 0
    };
  }
}

// 创建单例
let batchApiClientInstance = null;

/**
 * 获取 BatchApiClient 单例
 * @param {Object} apiClient - 底层 API 客户端
 * @param {Object} options - 配置选项
 */
export function getBatchApiClient(apiClient, options) {
  if (!batchApiClientInstance && apiClient) {
    batchApiClientInstance = new BatchApiClient(apiClient, options);
  }
  return batchApiClientInstance;
}

/**
 * 重置单例（用于测试）
 */
export function resetBatchApiClient() {
  batchApiClientInstance = null;
}

export default BatchApiClient;
