# REQ-00397: API 响应压缩与带宽优化系统

- **编号**: REQ-00397
- **类别**: 性能优化
- **优先级**: P1
- **状态**: new
- **涉及服务/模块**: gateway、所有微服务、backend/shared/middleware/compression.js、game-client、infrastructure/k8s
- **创建时间**: 2026-06-30 21:00 UTC
- **依赖需求**: REQ-00086（CDN 分发与静态资源优化）、REQ-00329（WebSocket 连接池与消息批处理性能优化）

## 1. 背景与问题

### 1.1 带宽消耗分析

mineGo 游戏客户端与后端 API 交互频繁，当前存在以下带宽优化机会：

1. **API 响应体积大**
   - 精灵列表查询返回完整精灵数据（平均 2-5KB/条）
   - 排行榜数据包含大量重复字段
   - 社交动态包含完整的用户信息嵌套
   - 地图数据传输量巨大（精灵位置、道馆信息、补给站）

2. **缺乏智能压缩**
   - 未启用 Gzip/Brotli 压缩
   - 响应数据未按客户端能力适配
   - 重复数据未去重
   - 大响应未分块传输

3. **移动端网络成本高**
   - 用户流量消耗大，影响用户体验
   - 弱网环境下响应慢
   - 高延迟导致游戏体验下降

### 1.2 性能影响

| 场景 | 当前响应体积 | 目标响应体积 | 优化幅度 |
|------|-------------|-------------|---------|
| 精灵列表 (100条) | ~350KB | ~45KB | 87% |
| 排行榜 (100条) | ~180KB | ~22KB | 88% |
| 社交动态 (50条) | ~95KB | ~12KB | 87% |
| 地图数据 | ~500KB | ~65KB | 87% |
| 战斗记录 | ~120KB | ~15KB | 87% |

### 1.3 当前缺失功能

```javascript
// gateway/server.js - 缺少压缩中间件
const app = express();
app.use(express.json());
// ❌ 未启用压缩
// ❌ 未针对不同内容类型优化
// ❌ 未处理大数据响应分块
```

## 2. 目标

构建 API 响应压缩与带宽优化系统，实现：

1. **智能压缩**: 根据客户端支持自动选择 Gzip/Brotli/Deflate
2. **响应体积减少**: 平均减少 85% 传输体积
3. **选择性压缩**: 针对不同内容类型采用不同策略
4. **分块传输**: 大响应支持流式传输
5. **缓存优化**: 压缩结果缓存，减少 CPU 开销
6. **带宽监控**: 实时带宽使用统计和告警

**预期收益**:
- 减少 85% 带宽成本
- 提升弱网环境下用户体验
- 降低 CDN 流量费用
- 减少响应延迟 30-50%

## 3. 范围

### 包含
- CompressionMiddleware 核心模块
- Brotli/Gzip/Deflate 多算法支持
- 响应数据压缩策略配置
- 大数据响应分块传输
- 压缩结果缓存系统
- 带宽使用监控指标
- game-client 解压适配
- admin-dashboard 压缩策略管理

### 不包含
- 图片压缩（已在 CDN 层处理）
- 视频压缩（独立需求）
- WebSocket 消息压缩（已在 REQ-00329 处理）
- 数据库查询优化（独立需求）

## 4. 详细需求

### 4.1 CompressionMiddleware 核心模块

创建 `backend/shared/middleware/compression.js`:

```javascript
/**
 * API 响应压缩中间件
 * 支持 Gzip、Brotli、Deflate 多算法
 */

const zlib = require('zlib');
const { createLogger } = require('../logger');
const { getRedis, setJSON, getJSON } = require('../redis');

const logger = createLogger('compression-middleware');

// 压缩配置
const COMPRESSION_CONFIG = {
  // 压缩算法优先级（根据客户端支持选择）
  algorithms: ['br', 'gzip', 'deflate'],
  
  // 压缩阈值（小于此大小不压缩）
  threshold: 1024, // 1KB
  
  // 压缩级别
  level: {
    br: 4,      // Brotli: 0-11
    gzip: 6,    // Gzip: 0-9
    deflate: 6  // Deflate: 0-9
  },
  
  // 不压缩的 MIME 类型
  skipTypes: [
    'image/',
    'video/',
    'audio/',
    'application/pdf',
    'application/zip',
    'application/x-rar',
    'application/octet-stream'
  ],
  
  // 压缩缓存 TTL（秒）
  cacheTTL: 300,
  
  // 缓存键前缀
  cacheKeyPrefix: 'compression:cache:'
};

/**
 * 压缩策略类
 */
class CompressionStrategy {
  constructor(config = {}) {
    this.config = { ...COMPRESSION_CONFIG, ...config };
    this.stats = {
      totalRequests: 0,
      compressedRequests: 0,
      bytesSaved: 0,
      byAlgorithm: { br: 0, gzip: 0, deflate: 0 },
      cacheHits: 0
    };
  }

  /**
   * 选择最佳压缩算法
   */
  selectAlgorithm(acceptEncoding) {
    if (!acceptEncoding) return null;
    
    const encodings = acceptEncoding.toLowerCase().split(',').map(e => e.trim());
    
    for (const algo of this.config.algorithms) {
      if (encodings.some(e => e.includes(algo))) {
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
    for (const skipType of this.config.skipTypes) {
      if (contentType.includes(skipType)) return false;
    }
    
    // 检查响应大小
    const bodySize = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
    if (bodySize < this.config.threshold) return false;
    
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
      
      const options = {
        level: this.config.level[algorithm]
      };
      
      const callback = (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed);
      };
      
      switch (algorithm) {
        case 'br':
          zlib.brotliCompress(buffer, options, callback);
          break;
        case 'gzip':
          zlib.gzip(buffer, options, callback);
          break;
        case 'deflate':
          zlib.deflate(buffer, options, callback);
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
    const crypto = require('crypto');
    const bodyHash = crypto.createHash('md5').update(body).digest('hex');
    return `${this.config.cacheKeyPrefix}${algorithm}:${bodyHash}`;
  }

  /**
   * 从缓存获取压缩结果
   */
  async getFromCache(cacheKey) {
    try {
      const cached = await getJSON(cacheKey);
      if (cached) {
        this.stats.cacheHits++;
        return Buffer.from(cached.data, 'base64');
      }
    } catch (err) {
      logger.debug('Cache get failed', { error: err.message });
    }
    return null;
  }

  /**
   * 保存压缩结果到缓存
   */
  async saveToCache(cacheKey, compressed) {
    try {
      await setJSON(cacheKey, {
        data: compressed.toString('base64'),
        algorithm: this.currentAlgorithm,
        timestamp: Date.now()
      }, this.config.cacheTTL);
    } catch (err) {
      logger.debug('Cache set failed', { error: err.message });
    }
  }

  /**
   * 更新统计信息
   */
  updateStats(originalSize, compressedSize, algorithm) {
    this.stats.totalRequests++;
    this.stats.compressedRequests++;
    this.stats.bytesSaved += (originalSize - compressedSize);
    this.stats.byAlgorithm[algorithm] = (this.stats.byAlgorithm[algorithm] || 0) + 1;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const compressionRatio = this.stats.compressedRequests > 0
      ? (this.stats.bytesSaved / (this.stats.bytesSaved + this.stats.compressedRequests * 1000)).toFixed(2)
      : 0;
    
    return {
      ...this.stats,
      compressionRatio: `${(compressionRatio * 100).toFixed(1)}%`,
      averageBytesSaved: this.stats.compressedRequests > 0
        ? Math.round(this.stats.bytesSaved / this.stats.compressedRequests)
        : 0
    };
  }
}

/**
 * 压缩中间件工厂
 */
function compressionMiddleware(options = {}) {
  const strategy = new CompressionStrategy(options);
  
  return async function(req, res, next) {
    // 保存原始响应方法
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    
    // 收集响应数据
    const chunks = [];
    let ended = false;
    
    // 重写 res.write
    res.write = function(chunk, encoding, callback) {
      if (!ended) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof callback === 'function') callback();
      return true;
    };
    
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
      if (!strategy.shouldCompress(req, res, body)) {
        // 不压缩，直接返回原始数据
        res.setHeader('Content-Length', originalSize);
        originalEnd.call(res, body, 'buffer', callback);
        return;
      }
      
      // 选择压缩算法
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const algorithm = strategy.selectAlgorithm(acceptEncoding);
      
      if (!algorithm) {
        res.setHeader('Content-Length', originalSize);
        originalEnd.call(res, body, 'buffer', callback);
        return;
      }
      
      try {
        // 检查缓存
        const cacheKey = strategy.getCacheKey(req, body, algorithm);
        let compressed = await strategy.getFromCache(cacheKey);
        
        if (!compressed) {
          // 执行压缩
          compressed = await strategy.compress(body, algorithm);
          
          // 保存到缓存
          await strategy.saveToCache(cacheKey, compressed);
        }
        
        const compressedSize = compressed.length;
        
        // 设置响应头
        res.setHeader('Content-Encoding', algorithm);
        res.setHeader('Content-Length', compressedSize);
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('X-Compression-Ratio', `${((1 - compressedSize / originalSize) * 100).toFixed(1)}%`);
        
        // 更新统计
        strategy.updateStats(originalSize, compressedSize, algorithm);
        
        // 记录日志
        logger.debug('Response compressed', {
          algorithm,
          originalSize,
          compressedSize,
          savedBytes: originalSize - compressedSize,
          ratio: `${((1 - compressedSize / originalSize) * 100).toFixed(1)}%`,
          url: req.url
        });
        
        // 发送压缩数据
        originalEnd.call(res, compressed, 'buffer', callback);
      } catch (err) {
        logger.error('Compression failed', {
          error: err.message,
          url: req.url
        });
        
        // 压缩失败，返回原始数据
        res.setHeader('Content-Length', originalSize);
        originalEnd.call(res, body, 'buffer', callback);
      }
    };
    
    next();
  };
}

/**
 * 分块传输中间件（用于大响应）
 */
function chunkedTransferMiddleware(options = {}) {
  const chunkSize = options.chunkSize || 64 * 1024; // 64KB
  
  return function(req, res, next) {
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
      const body = JSON.stringify(data);
      const bodySize = Buffer.byteLength(body);
      
      // 小响应直接返回
      if (bodySize < chunkSize * 2) {
        return originalJson(data);
      }
      
      // 大响应使用分块传输
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Content-Type', 'application/json');
      
      const buffer = Buffer.from(body);
      let offset = 0;
      
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
    
    next();
  };
}

/**
 * 响应数据去重中间件
 */
function deduplicationMiddleware(options = {}) {
  return function(req, res, next) {
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
      // 对数组数据进行去重优化
      if (Array.isArray(data)) {
        data = optimizeArrayResponse(data);
      }
      
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * 优化数组响应（去重、提取公共字段）
 */
function optimizeArrayResponse(array) {
  if (array.length === 0) return array;
  
  // 检查是否是对象数组
  if (typeof array[0] !== 'object') return array;
  
  // 提取公共字段
  const allKeys = new Set();
  array.forEach(item => {
    if (item && typeof item === 'object') {
      Object.keys(item).forEach(key => allKeys.add(key));
    }
  });
  
  // 检查是否有嵌套对象可以提取
  const nestedKeys = [];
  allKeys.forEach(key => {
    const sampleValue = array.find(item => item && item[key] !== undefined)?.[key];
    if (sampleValue && typeof sampleValue === 'object' && !Array.isArray(sampleValue)) {
      nestedKeys.push(key);
    }
  });
  
  // 如果有可提取的嵌套对象，进行优化
  if (nestedKeys.length > 0) {
    const optimized = array.map(item => {
      const newItem = { ...item };
      nestedKeys.forEach(key => {
        if (newItem[key] && typeof newItem[key] === 'object') {
          // 将嵌套对象转换为引用 ID
          newItem[`${key}Id`] = newItem[key].id || newItem[key].userId;
          delete newItem[key];
        }
      });
      return newItem;
    });
    
    // 返回优化后的数据和引用表
    return {
      data: optimized,
      _references: nestedKeys.reduce((refs, key) => {
        refs[key] = [...new Set(array.map(item => item[key]).filter(Boolean))];
        return refs;
      }, {})
    };
  }
  
  return array;
}

/**
 * 带宽监控中间件
 */
function bandwidthMonitorMiddleware(options = {}) {
  const stats = {
    totalBytes: 0,
    compressedBytes: 0,
    requests: 0,
    byEndpoint: {}
  };
  
  return function(req, res, next) {
    const startTime = Date.now();
    const originalEnd = res.end.bind(res);
    
    res.end = function(chunk, encoding, callback) {
      const size = chunk ? (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)) : 0;
      const compressionRatio = res.getHeader('X-Compression-Ratio') || '0%';
      
      stats.totalBytes += size;
      stats.requests++;
      
      if (res.getHeader('Content-Encoding')) {
        stats.compressedBytes += size;
      }
      
      const endpoint = req.route ? req.route.path : req.path;
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
      
      logger.info('Bandwidth metrics', {
        endpoint,
        size,
        compressed: !!res.getHeader('Content-Encoding'),
        compressionRatio,
        duration: Date.now() - startTime
      });
      
      return originalEnd(chunk, encoding, callback);
    };
    
    next();
  };
}

module.exports = {
  compressionMiddleware,
  chunkedTransferMiddleware,
  deduplicationMiddleware,
  bandwidthMonitorMiddleware,
  CompressionStrategy
};
```

### 4.2 集成到 Gateway

修改 `backend/services/gateway/server.js`:

```javascript
const {
  compressionMiddleware,
  bandwidthMonitorMiddleware
} = require('../../shared/middleware/compression');

// 启用压缩中间件（在其他中间件之前）
app.use(compressionMiddleware({
  threshold: 1024,
  level: {
    br: 4,
    gzip: 6,
    deflate: 6
  }
}));

// 启用带宽监控
app.use(bandwidthMonitorMiddleware());
```

### 4.3 压缩策略配置 API

创建 `backend/services/admin/routes/compression.js`:

```javascript
const express = require('express');
const router = express.Router();
const auth = require('../../../shared/auth');
const { requirePermission } = require('../../../shared/middleware/permission');

/**
 * 获取压缩统计信息
 */
router.get('/stats',
  auth.authenticate,
  requirePermission('admin.system.read'),
  async (req, res) => {
    try {
      const strategy = global.compressionStrategy;
      if (!strategy) {
        return res.status(503).json({
          success: false,
          error: 'Compression strategy not initialized'
        });
      }
      
      res.json({
        success: true,
        data: strategy.getStats()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 更新压缩配置
 */
router.put('/config',
  auth.authenticate,
  requirePermission('admin.system.write'),
  async (req, res) => {
    try {
      const { threshold, level } = req.body;
      
      if (threshold) {
        global.compressionStrategy.config.threshold = threshold;
      }
      
      if (level) {
        global.compressionStrategy.config.level = {
          ...global.compressionStrategy.config.level,
          ...level
        };
      }
      
      res.json({
        success: true,
        message: 'Compression config updated'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

module.exports = router;
```

### 4.4 Prometheus 指标

```javascript
const promClient = require('prom-client');

const bandwidthMetrics = {
  totalBytes: new promClient.Counter({
    name: 'minego_bandwidth_total_bytes',
    help: 'Total bytes transferred',
    labelNames: ['service', 'endpoint']
  }),
  
  compressedBytes: new promClient.Counter({
    name: 'minego_bandwidth_compressed_bytes',
    help: 'Compressed bytes transferred',
    labelNames: ['service', 'algorithm']
  }),
  
  compressionRatio: new promClient.Histogram({
    name: 'minego_compression_ratio',
    help: 'Compression ratio percentage',
    labelNames: ['service', 'endpoint'],
    buckets: [50, 60, 70, 80, 85, 90, 95]
  }),
  
  bandwidthSaved: new promClient.Counter({
    name: 'minego_bandwidth_saved_bytes',
    help: 'Bytes saved by compression',
    labelNames: ['service']
  })
};
```

## 5. 验收标准

- [ ] 创建 `backend/shared/middleware/compression.js`，支持 Brotli/Gzip/Deflate
- [ ] 压缩阈值可配置（默认 1KB）
- [ ] 响应体积平均减少 ≥ 80%
- [ ] 压缩缓存命中率 ≥ 60%
- [ ] 压缩延迟 < 20ms
- [ ] 在 gateway 集成压缩中间件
- [ ] 创建 admin-dashboard 压缩监控界面
- [ ] Prometheus 指标正确记录带宽数据
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 性能测试验证 CPU 开销 < 5%
- [ ] game-client 正确处理压缩响应
- [ ] 支持 Accept-Encoding 协商

## 6. 工作量估算

**M (Medium)** - 约 3-5 天

理由：
- 压缩中间件实现相对标准化
- Node.js zlib 模块成熟稳定
- 主要工作在集成和测试

## 7. 优先级理由

**P1** 理由：

1. **带宽成本**: 减少 85% 带宽成本，显著降低运营费用
2. **用户体验**: 弱网环境下响应速度提升 50%
3. **性能优化类别**: 轮转到性能优化类别（397 % 18 = 1）
4. **依赖关系**: 为后续全球化部署提供带宽优化基础
5. **快速收益**: 实施简单，收益明显

与项目目标一致性：
- 满足"性能优化"维度要求
- 提升生产环境可用性
- 支持大规模用户访问
