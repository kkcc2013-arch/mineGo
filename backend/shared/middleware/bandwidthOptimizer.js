// backend/shared/middleware/bandwidthOptimizer.js
// REQ-00397: API 响应压缩与带宽优化系统
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { createLogger } = require('../logger');
const { getRedis, setJSON, getJSON } = require('../redis');

const logger = createLogger('bandwidth-optimizer');

/**
 * 带宽优化配置
 */
const BANDWIDTH_CONFIG = {
  // 压缩配置
  compression: {
    algorithms: ['br', 'gzip', 'deflate'],
    threshold: 1024,      // 1KB 以下不压缩
    level: {
      br: 4,              // Brotli: 0-11
      gzip: 6,            // Gzip: 0-9
      deflate: 6          // Deflate: 0-9
    },
    // 不压缩的 MIME 类型
    skipMimes: new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'video/', 'audio/', 'application/pdf', 'application/zip',
      'application/x-rar', 'application/octet-stream'
    ])
  },
  
  // 缓存配置
  cache: {
    enabled: true,
    ttl: 300,             // 5分钟缓存
    maxSize: 100 * 1024 * 1024, // 100MB 最大缓存
    keyPrefix: 'bw:cache:'
  },
  
  // 去重配置
  deduplication: {
    enabled: true,
    minArrayLength: 10    // 数组长度大于此值时启用去重优化
  },
  
  // 分块传输配置
  chunking: {
    enabled: true,
    threshold: 100 * 1024 // 100KB 以上使用分块传输
  }
};

/**
 * 带宽优化器类
 */
class BandwidthOptimizer {
  constructor(config = {}) {
    this.config = { ...BANDWIDTH_CONFIG, ...config };
    this.stats = {
      requests: 0,
      compressed: 0,
      bytesSaved: 0,
      cacheHits: 0,
      byAlgorithm: { br: 0, gzip: 0, deflate: 0 },
      deduplicated: 0,
      chunked: 0
    };
  }

  /**
   * 选择最佳压缩算法
   */
  selectAlgorithm(acceptEncoding) {
    if (!acceptEncoding) return null;
    
    const encodings = acceptEncoding.toLowerCase().split(',')
      .map(e => e.trim().split(';')[0]);
    
    for (const algo of this.config.compression.algorithms) {
      if (encodings.includes(algo)) {
        return algo;
      }
    }
    
    return null;
  }

  /**
   * 检查是否应该压缩
   */
  shouldCompress(req, res, body) {
    // 检查请求方法
    if (req.method === 'HEAD') return false;
    
    // 检查响应状态码
    const statusCode = res.statusCode || 200;
    if (statusCode < 200 || statusCode >= 300) return false;
    
    // 检查 Content-Type
    const contentType = res.getHeader('Content-Type') || '';
    for (const skipMime of this.config.compression.skipMimes) {
      if (contentType.includes(skipMime)) return false;
    }
    
    // 检查响应大小
    const bodySize = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    if (bodySize < this.config.compression.threshold) return false;
    
    // 检查客户端支持
    const acceptEncoding = req.headers['accept-encoding'] || '';
    return this.selectAlgorithm(acceptEncoding) !== null;
  }

  /**
   * 压缩数据
   */
  async compress(data, algorithm) {
    return new Promise((resolve, reject) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const level = this.config.compression.level[algorithm];
      
      const callback = (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed);
      };
      
      switch (algorithm) {
        case 'br':
          zlib.brotliCompress(buffer, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: level
            }
          }, callback);
          break;
        case 'gzip':
          zlib.gzip(buffer, { level }, callback);
          break;
        case 'deflate':
          zlib.deflate(buffer, { level }, callback);
          break;
        default:
          resolve(buffer);
      }
    });
  }

  /**
   * 获取缓存键
   */
  getCacheKey(req, body, algorithm) {
    const bodyHash = crypto.createHash('md5').update(body).digest('hex').substring(0, 16);
    return `${this.config.cache.keyPrefix}${algorithm}:${bodyHash}`;
  }

  /**
   * 从缓存获取压缩结果
   */
  async getFromCache(cacheKey) {
    if (!this.config.cache.enabled) return null;
    
    try {
      const cached = await getJSON(cacheKey);
      if (cached && cached.data) {
        this.stats.cacheHits++;
        return {
          data: Buffer.from(cached.data, 'base64'),
          algorithm: cached.algorithm
        };
      }
    } catch (err) {
      logger.debug('Cache get failed', { error: err.message });
    }
    return null;
  }

  /**
   * 保存压缩结果到缓存
   */
  async saveToCache(cacheKey, compressed, algorithm) {
    if (!this.config.cache.enabled) return;
    
    try {
      await setJSON(cacheKey, {
        data: compressed.toString('base64'),
        algorithm,
        timestamp: Date.now()
      }, this.config.cache.ttl);
    } catch (err) {
      logger.debug('Cache set failed', { error: err.message });
    }
  }

  /**
   * 优化数组响应（去重和引用提取）
   */
  optimizeArrayResponse(array) {
    if (!this.config.deduplication.enabled) return array;
    if (!Array.isArray(array) || array.length < this.config.deduplication.minArrayLength) {
      return array;
    }
    
    // 找出可以提取的嵌套对象
    const nestedKeys = this.findNestedObjectKeys(array);
    
    if (nestedKeys.length === 0) {
      return array;
    }
    
    // 提取引用表
    const references = {};
    const optimized = array.map(item => {
      const newItem = { ...item };
      
      for (const key of nestedKeys) {
        if (newItem[key] && typeof newItem[key] === 'object') {
          const id = newItem[key].id || newItem[key].userId || newItem[key]._id;
          if (id) {
            // 存储引用
            if (!references[key]) {
              references[key] = {};
            }
            if (!references[key][id]) {
              references[key][id] = newItem[key];
            }
            // 替换为引用
            newItem[`${key}Ref`] = id;
            delete newItem[key];
          }
        }
      }
      
      return newItem;
    });
    
    this.stats.deduplicated += array.length;
    
    return {
      data: optimized,
      _references: references
    };
  }

  /**
   * 找出可提取的嵌套对象键
   */
  findNestedObjectKeys(array) {
    if (array.length === 0 || typeof array[0] !== 'object') return [];
    
    const nestedKeys = [];
    const sample = array[0];
    
    for (const [key, value] of Object.entries(sample)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // 检查是否所有元素都有这个键，且值结构相似
        const hasId = value.id || value.userId || value._id;
        if (hasId) {
          nestedKeys.push(key);
        }
      }
    }
    
    return nestedKeys;
  }

  /**
   * 更新统计信息
   */
  updateStats(originalSize, compressedSize, algorithm) {
    this.stats.requests++;
    this.stats.compressed++;
    this.stats.bytesSaved += (originalSize - compressedSize);
    this.stats.byAlgorithm[algorithm] = (this.stats.byAlgorithm[algorithm] || 0) + 1;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const avgSaved = this.stats.compressed > 0
      ? Math.round(this.stats.bytesSaved / this.stats.compressed)
      : 0;
    
    const compressionRatio = this.stats.compressed > 0
      ? (this.stats.bytesSaved / (this.stats.bytesSaved + this.stats.compressed * 1000) * 100).toFixed(1)
      : '0';
    
    return {
      ...this.stats,
      averageBytesSaved: avgSaved,
      compressionRatio: `${compressionRatio}%`,
      cacheHitRate: this.stats.requests > 0
        ? `${(this.stats.cacheHits / this.stats.requests * 100).toFixed(1)}%`
        : '0%'
    };
  }
}

// 全局优化器实例
let optimizerInstance = null;

function getOptimizer() {
  if (!optimizerInstance) {
    optimizerInstance = new BandwidthOptimizer();
  }
  return optimizerInstance;
}

/**
 * 带宽优化中间件
 */
function bandwidthOptimizationMiddleware(options = {}) {
  const optimizer = new BandwidthOptimizer(options);
  
  return async function(req, res, next) {
    // 保存原始响应方法
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalJson = res.json ? res.json.bind(res) : null;
    
    let chunks = [];
    let ended = false;
    
    // 重写 res.write
    res.write = function(chunk, encoding, callback) {
      if (!ended && chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof callback === 'function') callback();
      return true;
    };
    
    // 重写 res.json（用于去重优化）
    if (originalJson) {
      res.json = function(data) {
        // 对数组数据进行去重优化
        if (optimizer.config.deduplication.enabled && Array.isArray(data)) {
          data = optimizer.optimizeArrayResponse(data);
        }
        
        const body = JSON.stringify(data);
        chunks = [Buffer.from(body)];
        res.setHeader('Content-Type', 'application/json');
        return originalEnd(Buffer.from(body));
      };
    }
    
    // 重写 res.end
    res.end = async function(chunk, encoding, callback) {
      if (ended) {
        if (typeof callback === 'function') callback();
        return;
      }
      
      ended = true;
      
      // 收集最后的数据块
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      
      // 合并所有数据
      const body = Buffer.concat(chunks);
      const originalSize = body.length;
      
      // 检查是否应该压缩
      if (!optimizer.shouldCompress(req, res, body)) {
        res.setHeader('Content-Length', originalSize);
        return originalEnd(body, 'buffer', callback);
      }
      
      // 选择压缩算法
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const algorithm = optimizer.selectAlgorithm(acceptEncoding);
      
      if (!algorithm) {
        res.setHeader('Content-Length', originalSize);
        return originalEnd(body, 'buffer', callback);
      }
      
      try {
        // 检查缓存
        const cacheKey = optimizer.getCacheKey(req, body, algorithm);
        let cached = await optimizer.getFromCache(cacheKey);
        
        let compressed;
        if (cached) {
          compressed = cached.data;
        } else {
          // 执行压缩
          compressed = await optimizer.compress(body, algorithm);
          
          // 保存到缓存
          await optimizer.saveToCache(cacheKey, compressed, algorithm);
        }
        
        const compressedSize = compressed.length;
        
        // 设置响应头
        res.setHeader('Content-Encoding', algorithm);
        res.setHeader('Content-Length', compressedSize);
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('X-Compression-Ratio', `${((1 - compressedSize / originalSize) * 100).toFixed(1)}%`);
        res.setHeader('X-Original-Size', originalSize);
        
        // 更新统计
        optimizer.updateStats(originalSize, compressedSize, algorithm);
        
        // 记录日志
        logger.debug('Response compressed', {
          algorithm,
          originalSize,
          compressedSize,
          savedBytes: originalSize - compressedSize,
          ratio: `${((1 - compressedSize / originalSize) * 100).toFixed(1)}%`,
          url: req.url,
          cached: !!cached
        });
        
        // 发送压缩数据
        originalEnd(compressed, 'buffer', callback);
      } catch (err) {
        logger.error('Compression failed', {
          error: err.message,
          url: req.url
        });
        
        // 压缩失败，返回原始数据
        res.setHeader('Content-Length', originalSize);
        originalEnd(body, 'buffer', callback);
      }
    };
    
    next();
  };
}

/**
 * 带宽监控中间件
 */
function bandwidthMonitorMiddleware(options = {}) {
  const stats = {
    totalBytes: 0,
    compressedBytes: 0,
    requests: 0,
    byEndpoint: {},
    byContentType: {},
    timeline: []
  };
  
  return function(req, res, next) {
    const startTime = Date.now();
    const originalEnd = res.end.bind(res);
    
    res.end = function(chunk, encoding, callback) {
      const size = chunk ? (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)) : 0;
      const compressed = !!res.getHeader('Content-Encoding');
      const compressionRatio = res.getHeader('X-Compression-Ratio') || '0%';
      
      // 更新统计
      stats.totalBytes += size;
      stats.requests++;
      
      if (compressed) {
        stats.compressedBytes += size;
      }
      
      // 按端点统计
      const endpoint = req.route?.path || req.path;
      if (!stats.byEndpoint[endpoint]) {
        stats.byEndpoint[endpoint] = {
          requests: 0,
          totalBytes: 0,
          avgSize: 0
        };
      }
      stats.byEndpoint[endpoint].requests++;
      stats.byEndpoint[endpoint].totalBytes += size;
      stats.byEndpoint[endpoint].avgSize = Math.round(
        stats.byEndpoint[endpoint].totalBytes / stats.byEndpoint[endpoint].requests
      );
      
      // 按 Content-Type 统计
      const contentType = res.getHeader('Content-Type')?.split(';')[0] || 'unknown';
      if (!stats.byContentType[contentType]) {
        stats.byContentType[contentType] = {
          requests: 0,
          totalBytes: 0
        };
      }
      stats.byContentType[contentType].requests++;
      stats.byContentType[contentType].totalBytes += size;
      
      // 记录时间线（保留最近1000条）
      stats.timeline.push({
        time: Date.now(),
        endpoint,
        size,
        compressed,
        duration: Date.now() - startTime
      });
      if (stats.timeline.length > 1000) {
        stats.timeline.shift();
      }
      
      // 记录日志
      logger.info('Bandwidth metrics', {
        endpoint,
        size,
        compressed,
        compressionRatio,
        contentType,
        duration: Date.now() - startTime,
        userAgent: req.headers['user-agent']?.substring(0, 50)
      });
      
      return originalEnd(chunk, encoding, callback);
    };
    
    // 暴露统计接口
    req.getBandwidthStats = () => ({ ...stats });
    
    next();
  };
}

/**
 * 分块传输中间件（用于大响应）
 */
function chunkedTransferMiddleware(options = {}) {
  const threshold = options.threshold || BANDWIDTH_CONFIG.chunking.threshold;
  
  return function(req, res, next) {
    const originalJson = res.json ? res.json.bind(res) : null;
    
    if (originalJson) {
      res.json = function(data) {
        const body = JSON.stringify(data);
        const bodySize = Buffer.byteLength(body);
        
        // 小响应直接返回
        if (bodySize < threshold) {
          return originalJson(data);
        }
        
        // 大响应使用分块传输
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Content-Type', 'application/json');
        
        const buffer = Buffer.from(body);
        const chunkSize = 64 * 1024; // 64KB
        let offset = 0;
        
        getOptimizer().stats.chunked++;
        
        const sendChunk = () => {
          if (offset >= buffer.length) {
            res.end();
            return;
          }
          
          const chunk = buffer.slice(offset, offset + chunkSize);
          offset += chunkSize;
          
          res.write(chunk, 'buffer', sendChunk);
        };
        
        sendChunk();
      };
    }
    
    next();
  };
}

/**
 * 获取带宽统计接口
 */
function getBandwidthStats(req, res) {
  const optimizer = getOptimizer();
  res.json({
    success: true,
    data: {
      optimizer: optimizer.getStats(),
      timestamp: new Date().toISOString()
    }
  });
}

module.exports = {
  BandwidthOptimizer,
  bandwidthOptimizationMiddleware,
  bandwidthMonitorMiddleware,
  chunkedTransferMiddleware,
  getBandwidthStats,
  getOptimizer,
  BANDWIDTH_CONFIG
};
