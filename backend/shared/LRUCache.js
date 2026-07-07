/**
 * REQ-00481: 精灵数据预编译缓存系统
 * LRU 内存缓存 - 用于精灵数据的 L1 缓存层
 */

'use strict';

const { createLogger } = require('./logger');
const logger = createLogger('LRUCache');

/**
 * LRU 缓存条目
 */
class CacheEntry {
  constructor(key, value, ttl) {
    this.key = key;
    this.value = value;
    this.ttl = ttl;
    this.expireAt = Date.now() + ttl;
    this.accessCount = 0;
    this.lastAccess = Date.now();
    this.prev = null;
    this.next = null;
  }

  isExpired() {
    return Date.now() > this.expireAt;
  }

  touch() {
    this.accessCount++;
    this.lastAccess = Date.now();
  }
}

/**
 * LRU 缓存实现（双向链表 + Map）
 */
class LRUCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 1000;
    this.defaultTTL = options.defaultTTL || 300000; // 5 分钟
    this.maxMemoryMB = options.maxMemoryMB || 50; // 最大 50MB
    
    this.cache = new Map();
    this.head = null; // 最常使用
    this.tail = null; // 最少使用
    this.currentMemoryBytes = 0;
    
    // 统计
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      memoryEvictions: 0
    };
    
    // 定期清理过期条目
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60000);
    
    logger.info('LRUCache initialized', { maxSize: this.maxSize, defaultTTL: this.defaultTTL });
  }

  /**
   * 获取缓存值
   * @param {string} key - 缓存键
   * @returns {any} 缓存值
   */
  get(key) {
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    if (entry.isExpired()) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }
    
    // 更新访问记录并移到头部
    entry.touch();
    this.moveToHead(entry);
    
    this.stats.hits++;
    logger.debug('Cache hit', { key, accessCount: entry.accessCount });
    
    return entry.value;
  }

  /**
   * 设置缓存值
   * @param {string} key - 缓存键
   * @param {any} value - 缓存值
   * @param {number} ttl - 过期时间（毫秒）
   */
  set(key, value, ttl = this.defaultTTL) {
    // 检查是否已存在
    if (this.cache.has(key)) {
      this.delete(key);
    }
    
    // 计算内存大小
    const sizeBytes = this.calculateSize(value);
    
    // 检查内存限制
    while (this.currentMemoryBytes + sizeBytes > this.maxMemoryMB * 1024 * 1024 && this.tail) {
      this.evictTail();
      this.stats.memoryEvictions++;
    }
    
    // 检查大小限制
    while (this.cache.size >= this.maxSize && this.tail) {
      this.evictTail();
    }
    
    // 创建新条目
    const entry = new CacheEntry(key, value, ttl);
    entry.sizeBytes = sizeBytes;
    
    // 添加到缓存
    this.cache.set(key, entry);
    this.addToHead(entry);
    this.currentMemoryBytes += sizeBytes;
    
    logger.debug('Cache set', { key, ttl, sizeBytes });
    
    return entry;
  }

  /**
   * 删除缓存值
   * @param {string} key - 缓存键
   */
  delete(key) {
    const entry = this.cache.get(key);
    
    if (!entry) return;
    
    this.cache.delete(key);
    this.removeFromList(entry);
    this.currentMemoryBytes -= entry.sizeBytes || 0;
    
    logger.debug('Cache deleted', { key });
  }

  /**
   * 检查缓存是否存在
   * @param {string} key - 缓存键
   * @returns {boolean}
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.isExpired()) {
      this.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 清空缓存
   */
  clear() {
    this.cache.clear();
    this.head = null;
    this.tail = null;
    this.currentMemoryBytes = 0;
    logger.info('Cache cleared');
  }

  /**
   * 清理过期条目
   */
  cleanupExpired() {
    let cleaned = 0;
    
    for (const [key, entry] of this.cache) {
      if (entry.isExpired()) {
        this.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug('Expired entries cleaned', { count: cleaned });
    }
  }

  /**
   * 添加到头部
   * @param {CacheEntry} entry - 缓存条目
   */
  addToHead(entry) {
    entry.prev = null;
    entry.next = this.head;
    
    if (this.head) {
      this.head.prev = entry;
    }
    
    this.head = entry;
    
    if (!this.tail) {
      this.tail = entry;
    }
  }

  /**
   * 移到头部
   * @param {CacheEntry} entry - 缓存条目
   */
  moveToHead(entry) {
    this.removeFromList(entry);
    this.addToHead(entry);
  }

  /**
   * 从链表中移除
   * @param {CacheEntry} entry - 缓存条目
   */
  removeFromList(entry) {
    if (entry.prev) {
      entry.prev.next = entry.next;
    } else {
      this.head = entry.next;
    }
    
    if (entry.next) {
      entry.next.prev = entry.prev;
    } else {
      this.tail = entry.prev;
    }
    
    entry.prev = null;
    entry.next = null;
  }

  /**
   * 淘汰尾部条目（最少使用）
   */
  evictTail() {
    if (!this.tail) return;
    
    const key = this.tail.key;
    this.delete(key);
    this.stats.evictions++;
    
    logger.debug('Entry evicted', { key, reason: 'lru' });
  }

  /**
   * 计算数据大小（字节）
   * @param {any} value - 数据值
   * @returns {number} 大小（字节）
   */
  calculateSize(value) {
    if (value === null || value === undefined) return 0;
    
    if (Buffer.isBuffer(value)) {
      return value.length;
    }
    
    if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    }
    
    // JSON 估算
    try {
      return JSON.stringify(value).length * 2;
    } catch (err) {
      return 1024; // 默认 1KB
    }
  }

  /**
   * 获取缓存统计
   * @returns {Object}
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests) : 0;
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      memoryBytes: this.currentMemoryBytes,
      memoryMB: this.currentMemoryBytes / (1024 * 1024),
      maxMemoryMB: this.maxMemoryMB,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      memoryEvictions: this.stats.memoryEvictions,
      hitRate,
      oldestEntry: this.tail?.lastAccess || null,
      newestEntry: this.head?.lastAccess || null
    };
  }

  /**
   * 获取热点数据列表（访问次数最多的）
   * @param {number} limit - 返回数量
   * @returns {Array}
   */
  getHotKeys(limit = 20) {
    const entries = Array.from(this.cache.values());
    
    entries.sort((a, b) => b.accessCount - a.accessCount);
    
    return entries.slice(0, limit).map(entry => ({
      key: entry.key,
      accessCount: entry.accessCount,
      lastAccess: entry.lastAccess,
      sizeBytes: entry.sizeBytes
    }));
  }

  /**
   * 关闭缓存
   */
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
    logger.info('LRUCache closed');
  }
}

module.exports = LRUCache;