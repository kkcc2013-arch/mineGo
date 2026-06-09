/**
 * CDN Routes - CDN 管理 API 路由
 * 
 * 提供 CDN URL 生成、缓存清除、统计查询等 API。
 * 
 * @module cdnRoutes
 */

'use strict';

const express = require('express');
const { CDNManager } = require('../../../shared/CDNManager');
const { ImageProcessor, IMAGE_PRESETS } = require('../../../shared/ImageProcessor');
const { imageOptimizationMiddleware, parseImageParams } = require('./middleware/imageOptimization');
const metrics = require('../../../shared/metrics');

// 创建路由
const router = express.Router();

// 创建 CDN 管理器实例（配置从环境变量读取）
const cdnConfig = {
  provider: process.env.CDN_PROVIDER || 'cloudflare',
  domain: process.env.CDN_DOMAIN || '',
  originUrl: process.env.CDN_ORIGIN_URL || '',
  enabled: process.env.CDN_ENABLED === 'true',
  providerConfig: {
    zoneId: process.env.CDN_ZONE_ID || '',
    apiToken: process.env.CDN_API_TOKEN || ''
  }
};

const cdnManager = new CDNManager(cdnConfig);
const imageProcessor = new ImageProcessor({
  outputDir: process.env.IMAGE_OUTPUT_DIR || './optimized',
  webpEnabled: process.env.WEBP_ENABLED !== 'false',
  avifEnabled: process.env.AVIF_ENABLED !== 'false'
});

// Prometheus 指标
const cdnMetrics = {
  requestsTotal: metrics.registerCounter({
    name: 'cdn_requests_total',
    help: 'Total CDN requests',
    labelNames: ['type', 'format', 'size']
  }),
  cacheHits: metrics.registerCounter({
    name: 'cdn_cache_hits_total',
    help: 'Total CDN cache hits'
  }),
  cacheMisses: metrics.registerCounter({
    name: 'cdn_cache_misses_total',
    help: 'Total CDN cache misses'
  }),
  purgeOperations: metrics.registerCounter({
    name: 'cdn_purge_operations_total',
    help: 'Total CDN cache purge operations'
  }),
  imagesOptimized: metrics.registerCounter({
    name: 'cdn_images_optimized_total',
    help: 'Total images optimized',
    labelNames: ['format', 'preset']
  }),
  bytesSaved: metrics.registerGauge({
    name: 'cdn_bytes_saved_total',
    help: 'Total bytes saved by optimization'
  })
};

/**
 * 获取 CDN 资源 URL
 * 
 * GET /cdn/resource
 * 
 * Query params:
 * - path: 资源路径（必填）
 * - w/width: 图片宽度
 * - h/height: 图片高度
 * - q/quality: 图片质量 (1-100)
 * - f/format: 图片格式 (webp/avif/original)
 * - fit: 裁剪方式 (cover/contain/fill)
 * - responsive: 是否生成响应式 URL (true/false)
 * 
 * @example
 * GET /cdn/resource?path=/pokemon/25.png&w=128&f=webp
 */
router.get('/resource', parseImageParams, (req, res) => {
  const { path } = req.query;
  
  if (!path) {
    return res.status(400).json({
      error: 'path parameter is required',
      code: 'MISSING_PATH'
    });
  }
  
  const params = req.imageParams;
  const options = {
    width: params.width,
    height: params.height,
    quality: params.quality,
    format: params.format,
    fit: params.fit
  };
  
  // 记录请求
  cdnMetrics.requestsTotal.inc({
    type: 'resource',
    format: params.format || 'original',
    size: params.width ? `${params.width}px` : 'original'
  });
  
  // 检查是否需要响应式 URL
  if (req.query.responsive === 'true') {
    const urls = cdnManager.getResponsiveUrls(path, options);
    const srcset = cdnManager.generateSrcset(path, options);
    
    return res.json({
      urls,
      srcset,
      recommended: urls.medium,
      format: options.format
    });
  }
  
  // 单个 URL
  const url = cdnManager.getResourceUrl(path, options);
  
  res.json({
    url,
    path,
    options,
    cdnEnabled: cdnManager.enabled
  });
});

/**
 * 批量获取 CDN 资源 URL
 * 
 * POST /cdn/resources/batch
 * 
 * Body:
 * - paths: 资源路径数组
 * - options: 全局优化选项
 */
router.post('/resources/batch', (req, res) => {
  const { paths, options = {} } = req.body;
  
  if (!paths || !Array.isArray(paths)) {
    return res.status(400).json({
      error: 'paths array is required',
      code: 'MISSING_PATHS'
    });
  }
  
  if (paths.length > 100) {
    return res.status(400).json({
      error: 'Maximum 100 paths per batch request',
      code: 'PATHS_LIMIT_EXCEEDED'
    });
  }
  
  const urls = paths.map(path => ({
    path,
    url: cdnManager.getResourceUrl(path, options)
  }));
  
  cdnMetrics.requestsTotal.inc({ type: 'batch' }, paths.length);
  
  res.json({
    urls,
    count: urls.length,
    options
  });
});

/**
 * 清除 CDN 缓存
 * 
 * POST /cdn/purge
 * 
 * Body:
 * - paths: 要清除的路径数组
 * - all: 是否清除所有缓存
 * 
 * 需要管理员权限
 */
router.post('/purge', async (req, res) => {
  const { paths, all } = req.body;
  
  // 权限检查（简化版，实际部署需完整实现）
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authorization required',
      code: 'UNAUTHORIZED'
    });
  }
  
  try {
    if (all) {
      // 清除所有缓存
      const result = await cdnManager.purgeCache(['/*']);
      cdnMetrics.purgeOperations.inc({ type: 'all' });
      
      return res.json({
        success: true,
        message: 'All CDN cache purged',
        timestamp: new Date().toISOString()
      });
    }
    
    if (!paths || !Array.isArray(paths)) {
      return res.status(400).json({
        error: 'paths array is required when not purging all',
        code: 'MISSING_PATHS'
      });
    }
    
    const result = await cdnManager.purgeCache(paths);
    cdnMetrics.purgeOperations.inc({ type: 'partial' });
    
    res.json({
      success: true,
      purged: paths.length,
      paths,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[CDN] Purge error:', error);
    res.status(500).json({
      error: 'Failed to purge cache',
      code: 'PURGE_ERROR',
      details: error.message
    });
  }
});

/**
 * 获取 CDN 统计数据
 * 
 * GET /cdn/stats
 */
router.get('/stats', (req, res) => {
  const cdnStats = cdnManager.getStats();
  const processorStats = imageProcessor.getStats();
  
  // 更新 Prometheus 指标
  cdnMetrics.bytesSaved.set(processorStats.bytesSaved);
  
  res.json({
    cdn: {
      provider: cdnStats.provider,
      enabled: cdnStats.enabled,
      requests: cdnStats.requests,
      cacheHitRate: cdnStats.cacheHitRate,
      bytesTransferred: cdnStats.bytesTransferred,
      errors: cdnStats.errors
    },
    imageProcessor: {
      processed: processorStats.processed,
      bytesSaved: processorStats.bytesSaved,
      errors: processorStats.errors,
      byFormat: processorStats.byFormat
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * 获取图片预设配置
 * 
 * GET /cdn/presets
 */
router.get('/presets', (req, res) => {
  res.json({
    presets: IMAGE_PRESETS,
    formats: ImageProcessor.getFormatConfig(),
    defaultQuality: imageProcessor.defaultQuality,
    webpEnabled: imageProcessor.webpEnabled,
    avifEnabled: imageProcessor.avifEnabled
  });
});

/**
 * 设置资源版本
 * 
 * POST /cdn/version
 * 
 * Body:
 * - path: 资源路径
 * - version: 版本号（可选，自动生成）
 */
router.post('/version', (req, res) => {
  const { path, version } = req.body;
  
  if (!path) {
    return res.status(400).json({
      error: 'path is required',
      code: 'MISSING_PATH'
    });
  }
  
  cdnManager.setResourceVersion(path, version);
  
  res.json({
    success: true,
    path,
    version: version || 'auto-generated',
    timestamp: new Date().toISOString()
  });
});

/**
 * 批量设置资源版本
 * 
 * POST /cdn/versions/batch
 * 
 * Body:
 * - versions: 路径到版本的映射
 */
router.post('/versions/batch', (req, res) => {
  const { versions } = req.body;
  
  if (!versions || typeof versions !== 'object') {
    return res.status(400).json({
      error: 'versions object is required',
      code: 'MISSING_VERSIONS'
    });
  }
  
  const count = Object.keys(versions).length;
  if (count > 100) {
    return res.status(400).json({
      error: 'Maximum 100 versions per batch',
      code: 'VERSIONS_LIMIT_EXCEEDED'
    });
  }
  
  cdnManager.setResourceVersions(versions);
  
  res.json({
    success: true,
    count,
    timestamp: new Date().toISOString()
  });
});

/**
 * 健康检查
 * 
 * GET /cdn/health
 */
router.get('/health', (req, res) => {
  const health = cdnManager.healthCheck();
  
  res.json({
    ...health,
    imageProcessor: {
      webpEnabled: imageProcessor.webpEnabled,
      avifEnabled: imageProcessor.avifEnabled
    },
    uptime: process.uptime()
  });
});

/**
 * 图片优化 API（供内部服务调用）
 * 
 * POST /cdn/images/optimize
 * 
 * Body:
 * - path: 图片路径
 * - presets: 要生成的预设尺寸
 * - formats: 要生成的格式
 */
router.post('/images/optimize', async (req, res) => {
  const { path, presets, formats } = req.body;
  
  if (!path) {
    return res.status(400).json({
      error: 'path is required',
      code: 'MISSING_PATH'
    });
  }
  
  try {
    const result = await imageProcessor.generateResponsiveImages(path, {
      presets,
      formats
    });
    
    // 记录优化统计
    for (const preset of Object.keys(result.images)) {
      for (const format of Object.keys(result.images[preset] || {})) {
        cdnMetrics.imagesOptimized.inc({ format, preset });
      }
    }
    
    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[CDN] Image optimization error:', error);
    res.status(500).json({
      error: 'Failed to optimize image',
      code: 'OPTIMIZE_ERROR',
      details: error.message
    });
  }
});

/**
 * 批量图片优化
 * 
 * POST /cdn/images/optimize/batch
 * 
 * Body:
 * - paths: 图片路径数组
 * - options: 优化选项
 */
router.post('/images/optimize/batch', async (req, res) => {
  const { paths, options = {} } = req.body;
  
  if (!paths || !Array.isArray(paths)) {
    return res.status(400).json({
      error: 'paths array is required',
      code: 'MISSING_PATHS'
    });
  }
  
  if (paths.length > 50) {
    return res.status(400).json({
      error: 'Maximum 50 paths per batch',
      code: 'PATHS_LIMIT_EXCEEDED'
    });
  }
  
  try {
    const results = await imageProcessor.batchProcess(paths, options);
    
    const successCount = results.filter(r => !r.error).length;
    const errorCount = results.filter(r => r.error).length;
    
    res.json({
      success: true,
      results,
      summary: {
        total: paths.length,
        success: successCount,
        errors: errorCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[CDN] Batch optimization error:', error);
    res.status(500).json({
      error: 'Failed to optimize images',
      code: 'BATCH_OPTIMIZE_ERROR',
      details: error.message
    });
  }
});

// 导出路由和实例（供其他模块使用）
module.exports = {
  router,
  cdnManager,
  imageProcessor,
  cdnMetrics
};