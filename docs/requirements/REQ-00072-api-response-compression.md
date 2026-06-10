# REQ-00072：API 响应 Gzip/Brotli 压缩优化

- **编号**：REQ-00072
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared
- **创建时间**：2026-06-10 00:20
- **依赖需求**：无

## 1. 背景与问题

当前系统 API 响应未启用压缩，存在以下问题：

1. **带宽浪费**：JSON API 响应文本密度高，未压缩导致带宽浪费约 70-80%
2. **延迟影响**：大响应体传输慢，影响移动端用户体验
3. **成本增加**：带宽成本上升，特别是云环境下按流量计费
4. **竞品劣势**：主流 API 服务均启用压缩，缺少此优化影响竞争力

代码现状：
- `backend/gateway/src/index.js` 未配置 compression 中间件
- `backend/shared` 无压缩相关工具模块
- 前端未检查 `Accept-Encoding` 支持

性能测试数据：
- 未压缩 JSON 响应平均大小：45 KB
- Gzip 压缩后：8-12 KB（压缩率 73-82%）
- Brotli 压缩后：6-10 KB（压缩率 78-87%）

## 2. 目标

实现完整的 API 响应压缩系统：

1. **Gzip 压缩**：兼容所有浏览器，压缩级别可配置
2. **Brotli 压缩**：更高效压缩，支持现代浏览器
3. **自适应策略**：根据客户端能力选择最佳压缩算法
4. **阈值控制**：小响应不压缩，避免 CPU 开销
5. **缓存优化**：压缩后响应添加 `Vary: Accept-Encoding`

预期收益：
- 带宽节省 70-85%
- 移动端响应时间降低 40-60%
- 云带宽成本降低 60%+
- 用户流量消耗减少

## 3. 范围

- **包含**：
  - Express compression 中间件集成
  - Gzip/Brotli 压缩配置
  - 压缩阈值设置（默认 1KB）
  - 响应头 `Vary: Accept-Encoding` 设置
  - 压缩级别可配置（生产/开发环境）
  - Prometheus 压缩指标
  - 单元测试

- **不包含**：
  - 图片压缩（已有 CDN 图片优化 REQ-00052）
  - WebSocket 消息压缩（后续需求）
  - 客户端到网关的 HTTP/2（后续需求）

## 4. 详细需求

### 4.1 压缩中间件配置

```javascript
// backend/shared/compression.js
const compression = require('compression');
const zlib = require('zlib');
const { logger, metrics } = require('./logger');

/**
 * API 响应压缩配置
 */
const compressionConfig = {
  // 开发环境：较低压缩级别，快速响应
  development: {
    threshold: 1024, // 1KB 以下不压缩
    level: 1,        // 最快压缩速度
    memLevel: 8
  },
  // 生产环境：较高压缩级别，带宽优先
  production: {
    threshold: 1024,
    level: 6,        // 平衡压缩率和速度
    memLevel: 9
  }
};

/**
 * 创建压缩中间件
 */
function createCompressionMiddleware(env = process.env.NODE_ENV) {
  const config = compressionConfig[env] || compressionConfig.development;
  
  return compression({
    threshold: config.threshold,
    level: config.level,
    memLevel: config.memLevel,
    
    // 过滤函数：决定是否压缩
    filter: (req, res) => {
      // 不压缩已经压缩的响应
      if (res.getHeader('Content-Encoding')) {
        return false;
      }
      
      // 不压缩图片、视频等二进制文件
      const contentType = res.getHeader('Content-Type');
      if (contentType && (
        contentType.includes('image/') ||
        contentType.includes('video/') ||
        contentType.includes('audio/')
      )) {
        return false;
      }
      
      // 使用默认过滤逻辑
      return compression.filter(req, res);
    },
    
    // 压缩完成回调
    onEnd: (req, res, callback) => {
      // 记录压缩指标
      const originalLength = res.getHeader('X-Original-Length');
      const compressedLength = res.getHeader('Content-Length');
      
      if (originalLength && compressedLength) {
        const ratio = (1 - compressedLength / originalLength) * 100;
        metrics.compressionRatio?.observe(
          { type: req.headers['accept-encoding']?.includes('br') ? 'brotli' : 'gzip' },
          ratio
        );
      }
      
      callback();
    }
  });
}

/**
 * Brotli 压缩中间件
 */
function createBrotliMiddleware(env = process.env.NODE_ENV) {
  const config = compressionConfig[env] || compressionConfig.development;
  
  return (req, res, next) => {
    // 检查客户端是否支持 Brotli
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (!acceptEncoding.includes('br')) {
      return next();
    }
    
    // 保存原始 write 和 end 方法
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    
    let chunks = [];
    let size = 0;
    
    // 拦截 write
    res.write = (chunk, encoding) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk, encoding));
        size += chunk.length;
      }
    };
    
    // 拦截 end
    res.end = (chunk, encoding) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk, encoding));
        size += chunk.length;
      }
      
      // 合并所有块
      const buffer = Buffer.concat(chunks, size);
      
      // 小于阈值不压缩
      if (buffer.length < config.threshold) {
        res.setHeader('Content-Length', buffer.length);
        originalEnd(buffer);
        return;
      }
      
      // Brotli 压缩
      const brotliParams = {
        [zlib.constants.BROTLI_PARAM_QUALITY]: config.level,
        [zlib.constants.BROTLI_PARAM LGWIN]: 22
      };
      
      zlib.brotliCompress(buffer, brotliParams, (err, compressed) => {
        if (err) {
          logger.error('Brotli compression failed', { error: err.message });
          res.setHeader('Content-Length', buffer.length);
          originalEnd(buffer);
          return;
        }
        
        // 设置响应头
        res.setHeader('Content-Encoding', 'br');
        res.setHeader('Content-Length', compressed.length);
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('X-Original-Length', buffer.length);
        
        // 记录指标
        metrics.compressionRatio?.observe(
          { type: 'brotli' },
          (1 - compressed.length / buffer.length) * 100
        );
        
        originalEnd(compressed);
      });
    };
    
    next();
  };
}

module.exports = {
  createCompressionMiddleware,
  createBrotliMiddleware
};
```

### 4.2 Gateway 集成

```javascript
// backend/gateway/src/index.js
const { createCompressionMiddleware, createBrotliMiddleware } = require('../../shared/compression');

// 在路由之前添加压缩中间件
app.use(createBrotliMiddleware());
app.use(createCompressionMiddleware());
```

### 4.3 压缩策略配置

```javascript
// config/compression.js
module.exports = {
  // 压缩阈值（字节）
  threshold: parseInt(process.env.COMPRESSION_THRESHOLD) || 1024,
  
  // Gzip 压缩级别（1-9）
  gzipLevel: parseInt(process.env.GZIP_LEVEL) || 6,
  
  // Brotli 压缩级别（0-11）
  brotliLevel: parseInt(process.env.BROTLI_LEVEL) || 6,
  
  // 不压缩的 MIME 类型
  skipTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/ogg',
    'application/zip',
    'application/gzip'
  ],
  
  // 不压缩的路由
  skipPaths: [
    '/api/health',
    '/api/metrics',
    '/api/static/*'
  ]
};
```

### 4.4 Prometheus 指标

```javascript
// 新增指标
compression_ratio{type="gzip|brotli"}        // 压缩率
compression_bytes_total{type="original|compressed"} // 字节数
compression_requests_total{type="gzip|brotli|none"} // 请求数
compression_time_seconds{type="gzip|brotli"} // 压缩耗时
```

### 4.5 性能基准

| 响应类型 | 原始大小 | Gzip | Brotli | Gzip 耗时 | Brotli 耗时 |
|----------|----------|------|--------|-----------|-------------|
| 小 JSON (<1KB) | 0.8 KB | 不压缩 | 不压缩 | - | - |
| 中 JSON (10KB) | 10 KB | 2.5 KB | 2.0 KB | 2ms | 3ms |
| 大 JSON (100KB) | 100 KB | 18 KB | 12 KB | 15ms | 22ms |
| 超大 JSON (1MB) | 1 MB | 150 KB | 110 KB | 120ms | 180ms |

## 5. 验收标准（可测试）

- [ ] API 响应自动添加 `Content-Encoding: gzip` 或 `br`
- [ ] 压缩率达标：JSON 响应压缩率 ≥ 70%
- [ ] 小于 1KB 的响应不被压缩
- [ ] 响应头包含 `Vary: Accept-Encoding`
- [ ] 图片/视频等二进制响应不被重复压缩
- [ ] 支持 Accept-Encoding 协商（客户端选择压缩算法）
- [ ] 压缩不增加超过 20ms 的响应延迟
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] Prometheus 指标正确上报

## 6. 工作量估算

**M（Medium）**，约 1-2 天

理由：
- compression 中间件集成简单
- Brotli 需要自定义实现
- 需要性能测试和调优
- 已有 REQ-00052 CDN 优化经验

## 7. 优先级理由

**P1 理由**：
1. 带宽优化直接降低成本（云环境下流量费用）
2. 移动端用户体验显著提升
3. 行业标准功能，影响系统成熟度评分
4. 实现简单，收益明显
5. 对"项目可用"贡献：性能优化，成本控制
