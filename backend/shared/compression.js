// backend/shared/compression.js
// REQ-00072: API 响应 Gzip/Brotli 压缩优化
'use strict';

const zlib = require('zlib');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('compression');

/**
 * 压缩配置
 */
const COMPRESSION_CONFIG = {
  // 开发环境：较低压缩级别，快速响应
  development: {
    threshold: 1024,      // 1KB 以下不压缩
    gzipLevel: 1,         // 最快压缩速度
    brotliLevel: 1,
    memLevel: 8
  },
  // 生产环境：较高压缩级别，带宽优先
  production: {
    threshold: 1024,
    gzipLevel: 6,         // 平衡压缩率和速度
    brotliLevel: 6,
    memLevel: 9
  },
  // 测试环境
  test: {
    threshold: 512,
    gzipLevel: 1,
    brotliLevel: 1,
    memLevel: 8
  }
};

/**
 * 不压缩的 MIME 类型
 */
const SKIP_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/ico',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/pdf',
  'application/octet-stream'
]);

/**
 * 不压缩的路由前缀
 */
const SKIP_PATH_PREFIXES = [
  '/health',
  '/metrics',
  '/static/',
  '/assets/',
  '/uploads/'
];

/**
 * 获取当前环境配置
 */
function getConfig(env = process.env.NODE_ENV || 'development') {
  return COMPRESSION_CONFIG[env] || COMPRESSION_CONFIG.development;
}

/**
 * 检查是否应该跳过压缩
 */
function shouldSkipCompression(req, res) {
  // 1. 检查路径
  const path = req.path || req.url;
  for (const prefix of SKIP_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      return true;
    }
  }

  // 2. 检查是否已经有编码
  if (res.getHeader('Content-Encoding')) {
    return true;
  }

  // 3. 检查 Content-Type
  const contentType = res.getHeader('Content-Type');
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (SKIP_MIME_TYPES.has(mime)) {
      return true;
    }
    // 检查通配符
    if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) {
      return true;
    }
  }

  // 4. 检查 Content-Length（如果已知且小于阈值）
  const contentLength = res.getHeader('Content-Length');
  const config = getConfig();
  if (contentLength && parseInt(contentLength, 10) < config.threshold) {
    return true;
  }

  return false;
}

/**
 * 解析 Accept-Encoding 头
 */
function parseAcceptEncoding(req) {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  const encodings = new Map();

  // 解析编码和权重
  // 例如: "gzip, deflate, br;q=0.9"
  for (const part of acceptEncoding.split(',')) {
    const trimmed = part.trim();
    const [encoding, ...params] = trimmed.split(';');
    let q = 1;

    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q') {
        q = parseFloat(value) || 0;
      }
    }

    if (encoding && q > 0) {
      encodings.set(encoding.trim().toLowerCase(), q);
    }
  }

  return encodings;
}

/**
 * 选择最佳压缩算法
 */
function selectBestEncoding(req) {
  const encodings = parseAcceptEncoding(req);

  // Brotli 优先（压缩率更高）
  if (encodings.has('br') && encodings.get('br') > 0) {
    return 'br';
  }

  // Gzip 次之
  if (encodings.has('gzip') && encodings.get('gzip') > 0) {
    return 'gzip';
  }

  // Deflate 兼容
  if (encodings.has('deflate') && encodings.get('deflate') > 0) {
    return 'deflate';
  }

  return null;
}

/**
 * 创建压缩中间件
 */
function createCompressionMiddleware(options = {}) {
  const config = getConfig(options.env);
  const threshold = options.threshold || config.threshold;
  const gzipLevel = options.gzipLevel || config.gzipLevel;
  const brotliLevel = options.brotliLevel || config.brotliLevel;

  return (req, res, next) => {
    // 检查是否应该跳过
    if (shouldSkipCompression(req, res)) {
      return next();
    }

    // 选择压缩算法
    const encoding = selectBestEncoding(req);
    if (!encoding) {
      return next();
    }

    // 保存原始方法
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    let chunks = [];
    let size = 0;
    let started = false;
    let headersSent = false;

    // 拦截 writeHead
    res.writeHead = function(statusCode, statusMessage, headers) {
      headersSent = true;
      // 再次检查是否应该跳过
      if (shouldSkipCompression(req, res)) {
        return originalWriteHead(statusCode, statusMessage, headers);
      }
      return originalWriteHead(statusCode, statusMessage, headers);
    };

    // 拦截 write
    res.write = function(chunk, encoding) {
      if (!started) {
        started = true;
      }
      if (chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        chunks.push(buffer);
        size += buffer.length;
      }
      return true;
    };

    // 拦截 end
    res.end = function(chunk, encoding) {
      const startTime = Date.now();

      // 处理最后的 chunk
      if (chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        chunks.push(buffer);
        size += buffer.length;
      }

      // 没有数据或小于阈值，不压缩
      if (size === 0 || size < threshold) {
        // 设置 Content-Length
        if (size > 0) {
          res.setHeader('Content-Length', size);
        }
        const buffer = chunks.length > 0 ? Buffer.concat(chunks, size) : Buffer.alloc(0);
        originalEnd(buffer);
        return;
      }

      // 再次检查是否应该跳过
      if (shouldSkipCompression(req, res)) {
        res.setHeader('Content-Length', size);
        const buffer = Buffer.concat(chunks, size);
        originalEnd(buffer);
        return;
      }

      // 合并所有块
      const buffer = Buffer.concat(chunks, size);

      // 根据算法压缩
      const compressCallback = (err, compressed) => {
        if (err) {
          logger.error('压缩失败', {
            encoding,
            error: err.message,
            path: req.path
          });
          res.setHeader('Content-Length', buffer.length);
          originalEnd(buffer);
          return;
        }

        const duration = Date.now() - startTime;
        const ratio = (1 - compressed.length / buffer.length) * 100;

        // 设置响应头
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', compressed.length);

        // 添加 Vary 头，支持缓存
        const existingVary = res.getHeader('Vary');
        if (existingVary) {
          if (!existingVary.includes('Accept-Encoding')) {
            res.setHeader('Vary', existingVary + ', Accept-Encoding');
          }
        } else {
          res.setHeader('Vary', 'Accept-Encoding');
        }

        // 记录指标
        try {
          metrics.compressionRatio?.observe({ type: encoding }, ratio);
          metrics.compressionBytesTotal?.inc({ type: 'original' }, buffer.length);
          metrics.compressionBytesTotal?.inc({ type: 'compressed' }, compressed.length);
          metrics.compressionRequestsTotal?.inc({ type: encoding });
          metrics.compressionTimeSeconds?.observe({ type: encoding }, duration / 1000);
        } catch (e) {
          // 指标记录失败不影响响应
        }

        logger.debug('响应已压缩', {
          encoding,
          originalSize: buffer.length,
          compressedSize: compressed.length,
          ratio: ratio.toFixed(1) + '%',
          duration: duration + 'ms',
          path: req.path
        });

        originalEnd(compressed);
      };

      try {
        if (encoding === 'br') {
          // Brotli 压缩
          zlib.brotliCompress(buffer, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: brotliLevel,
              [zlib.constants.BROTLI_PARAM_LGWIN]: 22
            }
          }, compressCallback);
        } else if (encoding === 'gzip') {
          // Gzip 压缩
          zlib.gzip(buffer, {
            level: gzipLevel,
            memLevel: config.memLevel
          }, compressCallback);
        } else if (encoding === 'deflate') {
          // Deflate 压缩
          zlib.deflate(buffer, {
            level: gzipLevel,
            memLevel: config.memLevel
          }, compressCallback);
        } else {
          // 不支持的编码，返回原始数据
          res.setHeader('Content-Length', buffer.length);
          originalEnd(buffer);
        }
      } catch (err) {
        logger.error('压缩异常', {
          encoding,
          error: err.message,
          path: req.path
        });
        res.setHeader('Content-Length', buffer.length);
        originalEnd(buffer);
      }
    };

    next();
  };
}

/**
 * Express 兼容的 compression 中间件（简化版）
 * 使用标准 compression 包的接口
 */
function compressionMiddleware(options = {}) {
  const config = getConfig(options.env);

  return (req, res, next) => {
    // HEAD 请求不压缩
    if (req.method === 'HEAD') {
      return next();
    }

    // 检查是否应该跳过
    if (shouldSkipCompression(req, res)) {
      return next();
    }

    // 选择压缩算法
    const encoding = selectBestEncoding(req);
    if (!encoding) {
      return next();
    }

    // 标记需要压缩
    req._compression = {
      encoding,
      config
    };

    next();
  };
}

/**
 * 初始化 Prometheus 指标
 */
function initMetrics() {
  try {
    // 压缩率直方图
    if (!metrics.compressionRatio) {
      const Prometheus = require('prom-client');
      metrics.compressionRatio = new Prometheus.Histogram({
        name: 'minego_compression_ratio_percent',
        help: 'API 响应压缩率（百分比）',
        labelNames: ['type'],
        buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 85, 90, 95, 99]
      });
    }

    // 压缩字节计数器
    if (!metrics.compressionBytesTotal) {
      const Prometheus = require('prom-client');
      metrics.compressionBytesTotal = new Prometheus.Counter({
        name: 'minego_compression_bytes_total',
        help: '压缩处理字节数',
        labelNames: ['type']
      });
    }

    // 压缩请求计数器
    if (!metrics.compressionRequestsTotal) {
      const Prometheus = require('prom-client');
      metrics.compressionRequestsTotal = new Prometheus.Counter({
        name: 'minego_compression_requests_total',
        help: '压缩请求数',
        labelNames: ['type']
      });
    }

    // 压缩耗时直方图
    if (!metrics.compressionTimeSeconds) {
      const Prometheus = require('prom-client');
      metrics.compressionTimeSeconds = new Prometheus.Histogram({
        name: 'minego_compression_time_seconds',
        help: '压缩耗时',
        labelNames: ['type'],
        buckets: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2]
      });
    }

    logger.info('压缩指标已初始化');
  } catch (err) {
    logger.warn('压缩指标初始化失败', { error: err.message });
  }
}

// 初始化指标
initMetrics();

module.exports = {
  createCompressionMiddleware,
  compressionMiddleware,
  getConfig,
  shouldSkipCompression,
  selectBestEncoding,
  parseAcceptEncoding,
  SKIP_MIME_TYPES,
  SKIP_PATH_PREFIXES
};
