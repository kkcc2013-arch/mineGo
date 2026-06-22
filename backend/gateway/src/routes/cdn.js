/**
 * CDN 静态资源服务 API 路由
 * 提供静态资源 URL 生成、缓存清除、统计数据等 API
 * 
 * @module backend/gateway/src/routes/cdn
 */
'use strict';

const express = require('express');
const router = express.Router();
const { cdnManager, imageProcessor, IMAGE_PRESETS, CACHE_CONFIG } = require('@pmg/shared/CDNManager');
const { promClient } = require('@pmg/shared/metrics');

// ── Prometheus 指标 ─────────────────────────────────────────────────

const cdnRequestsTotal = new promClient.Counter({
  name: 'cdn_requests_total',
  help: 'Total number of CDN requests',
  labelNames: ['type', 'preset']
});

const cdnCacheHits = new promClient.Counter({
  name: 'cdn_cache_hits_total',
  help: 'Total number of CDN cache hits',
  labelNames: ['hit']
});

const cdnImagesOptimized = new promClient.Counter({
  name: 'cdn_images_optimized_total',
  help: 'Total number of images optimized'
});

const cdnBytesSaved = new promClient.Counter({
  name: 'cdn_bytes_saved_total',
  help: 'Total bytes saved from optimization and caching'
});

const cdnPurgeOperations = new promClient.Counter({
  name: 'cdn_purge_operations_total',
  help: 'Total number of CDN cache purge operations',
  labelNames: ['result']
});

// ── API 路由 ───────────────────────────────────────────────────────

/**
 * GET /cdn/resource
 * 获取 CDN 资源 URL
 * 
 * Query params:
 * - path: 资源路径 (必填)
 * - width: 宽度 (可选)
 * - height: 高度 (可选)
 * - format: 格式 webp/avif/jpg/png (可选)
 * - quality: 质量 1-100 (可选)
 * - preset: 预设 thumbnail/small/medium/large/hd/original (可选)
 */
router.get('/resource', (req, res) => {
  const { path: resourcePath, width, height, format, quality, preset } = req.query;

  if (!resourcePath) {
    return res.status(400).json({
      code: 400001,
      message: 'Resource path is required'
    });
  }

  const options = {};
  if (width) options.width = parseInt(width, 10);
  if (height) options.height = parseInt(height, 10);
  if (format) options.format = format;
  if (quality) options.quality = parseInt(quality, 10);
  if (preset) options.preset = preset;

  const url = cdnManager.getResourceUrl(resourcePath, options);
  const cachePolicy = cdnManager.getCachePolicy(resourcePath);

  // 记录指标
  cdnRequestsTotal.inc({ type: 'resource', preset: preset || 'none' });

  res.json({
    code: 0,
    message: 'success',
    data: {
      url,
      cachePolicy,
      preset: preset || null,
      options: Object.keys(options).length > 0 ? options : null
    }
  });
});

/**
 * GET /cdn/responsive
 * 获取响应式图片 URL 集合
 * 
 * Query params:
 * - path: 资源路径 (必填)
 * - format: 格式 (可选)
 */
router.get('/responsive', (req, res) => {
  const { path: resourcePath, format } = req.query;

  if (!resourcePath) {
    return res.status(400).json({
      code: 400001,
      message: 'Resource path is required'
    });
  }

  const options = format ? { format } : {};
  const urls = cdnManager.getResponsiveUrls(resourcePath, options);
  const srcSet = cdnManager.getResponsiveSrcSet(resourcePath, options);

  // 记录指标
  cdnRequestsTotal.inc({ type: 'responsive', preset: 'all' });

  res.json({
    code: 0,
    message: 'success',
    data: {
      urls,
      srcSet,
      presets: Object.keys(IMAGE_PRESETS)
    }
  });
});

/**
 * GET /cdn/srcset
 * 获取图片 srcset 属性值
 * 
 * Query params:
 * - path: 资源路径 (必填)
 * - format: 格式 (可选)
 */
router.get('/srcset', (req, res) => {
  const { path: resourcePath, format } = req.query;

  if (!resourcePath) {
    return res.status(400).json({
      code: 400001,
      message: 'Resource path is required'
    });
  }

  const options = format ? { format } : {};
  const srcSet = cdnManager.getResponsiveSrcSet(resourcePath, options);

  res.json({
    code: 0,
    message: 'success',
    data: { srcSet }
  });
});

/**
 * POST /cdn/purge
 * 清除 CDN 缓存
 * 
 * Body:
 * - paths: 要清除的路径数组 (可选，不传则清除所有)
 */
router.post('/purge', async (req, res) => {
  const { paths } = req.body;

  try {
    let result;
    
    if (paths && Array.isArray(paths) && paths.length > 0) {
      result = await cdnManager.purgeCache(paths);
    } else {
      result = await cdnManager.purgeAll();
    }

    // 记录指标
    cdnPurgeOperations.inc({ result: result.success ? 'success' : 'failed' });

    res.json({
      code: 0,
      message: result.success ? 'Cache purged successfully' : 'Purge failed',
      data: result
    });
  } catch (error) {
    console.error('[CDN API] Purge error:', error);
    cdnPurgeOperations.inc({ result: 'error' });
    
    res.status(500).json({
      code: 500001,
      message: 'Cache purge failed',
      error: error.message
    });
  }
});

/**
 * GET /cdn/stats
 * 获取 CDN 统计数据
 */
router.get('/stats', (req, res) => {
  const stats = cdnManager.getStats();

  res.json({
    code: 0,
    message: 'success',
    data: stats
  });
});

/**
 * POST /cdn/stats/reset
 * 重置统计数据
 */
router.post('/stats/reset', (req, res) => {
  cdnManager.resetStats();

  res.json({
    code: 0,
    message: 'Stats reset successfully'
  });
});

/**
 * GET /cdn/config
 * 获取 CDN 配置信息
 */
router.get('/config', (req, res) => {
  res.json({
    code: 0,
    message: 'success',
    data: {
      enabled: cdnManager.enabled,
      provider: cdnManager.provider,
      domain: cdnManager.domain,
      presets: IMAGE_PRESETS,
      cacheConfig: CACHE_CONFIG
    }
  });
});

/**
 * GET /cdn/formats
 * 检测客户端支持的图片格式
 */
router.get('/formats', (req, res) => {
  const acceptHeader = req.headers.accept || '';
  const formats = cdnManager.detectSupportedFormats(acceptHeader);

  res.json({
    code: 0,
    message: 'success',
    data: formats
  });
});

/**
 * GET /cdn/presets
 * 获取图片预设配置
 */
router.get('/presets', (req, res) => {
  res.json({
    code: 0,
    message: 'success',
    data: IMAGE_PRESETS
  });
});

/**
 * GET /cdn/cache-policy
 * 获取指定路径的缓存策略
 * 
 * Query params:
 * - path: 资源路径
 */
router.get('/cache-policy', (req, res) => {
  const { path: resourcePath } = req.query;

  if (!resourcePath) {
    return res.status(400).json({
      code: 400001,
      message: 'Resource path is required'
    });
  }

  const policy = cdnManager.getCachePolicy(resourcePath);

  res.json({
    code: 0,
    message: 'success',
    data: policy
  });
});

/**
 * POST /cdn/optimize
 * 优化图片（需要 Sharp 库支持）
 * 
 * Body:
 * - imageUrl: 图片 URL（可选，与 imageBase64 二选一）
 * - imageBase64: Base64 编码的图片（可选）
 * - options: 处理选项
 */
router.post('/optimize', async (req, res) => {
  if (!imageProcessor.isAvailable()) {
    return res.status(503).json({
      code: 503001,
      message: 'Image processing not available (Sharp not installed)'
    });
  }

  const { imageUrl, imageBase64, options = {} } = req.body;

  if (!imageUrl && !imageBase64) {
    return res.status(400).json({
      code: 400001,
      message: 'Either imageUrl or imageBase64 is required'
    });
  }

  try {
    let input;
    
    if (imageBase64) {
      // 解码 Base64
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      input = Buffer.from(base64Data, 'base64');
    } else {
      // 下载图片
      const response = await fetch(imageUrl);
      input = Buffer.from(await response.arrayBuffer());
    }

    const originalSize = input.length;
    const result = await imageProcessor.process(input, options);
    const optimizedSize = result.length;

    // 记录优化统计
    cdnManager.recordImageOptimization(originalSize, optimizedSize);
    cdnImagesOptimized.inc();
    cdnBytesSaved.inc(originalSize - optimizedSize);

    res.json({
      code: 0,
      message: 'success',
      data: {
        image: result.toString('base64'),
        originalSize,
        optimizedSize,
        savedBytes: originalSize - optimizedSize,
        compressionRatio: ((1 - optimizedSize / originalSize) * 100).toFixed(2) + '%'
      }
    });
  } catch (error) {
    console.error('[CDN API] Optimize error:', error);
    res.status(500).json({
      code: 500002,
      message: 'Image optimization failed',
      error: error.message
    });
  }
});

/**
 * POST /cdn/responsive-images
 * 生成响应式图片集（需要 Sharp 库支持）
 * 
 * Body:
 * - imageUrl: 图片 URL
 * - imageBase64: Base64 编码的图片
 * - presets: 预设尺寸列表
 */
router.post('/responsive-images', async (req, res) => {
  if (!imageProcessor.isAvailable()) {
    return res.status(503).json({
      code: 503001,
      message: 'Image processing not available'
    });
  }

  const { imageUrl, imageBase64, presets } = req.body;

  if (!imageUrl && !imageBase64) {
    return res.status(400).json({
      code: 400001,
      message: 'Either imageUrl or imageBase64 is required'
    });
  }

  try {
    let input;
    
    if (imageBase64) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      input = Buffer.from(base64Data, 'base64');
    } else {
      const response = await fetch(imageUrl);
      input = Buffer.from(await response.arrayBuffer());
    }

    const results = await imageProcessor.generateResponsiveImages(
      input, 
      presets || ['thumbnail', 'small', 'medium', 'large']
    );

    // 转换为 Base64
    const response = {};
    let totalSaved = 0;
    
    for (const [preset, buffer] of Object.entries(results)) {
      if (buffer) {
        response[preset] = {
          image: buffer.toString('base64'),
          size: buffer.length
        };
        totalSaved += input.length - buffer.length;
      }
    }

    // 记录指标
    cdnImagesOptimized.inc(Object.keys(results).length);
    cdnBytesSaved.inc(totalSaved);

    res.json({
      code: 0,
      message: 'success',
      data: {
        images: response,
        originalSize: input.length,
        totalSaved
      }
    });
  } catch (error) {
    console.error('[CDN API] Generate responsive images error:', error);
    res.status(500).json({
      code: 500003,
      message: 'Failed to generate responsive images',
      error: error.message
    });
  }
});

/**
 * GET /cdn/health
 * 健康检查
 */
router.get('/health', (req, res) => {
  res.json({
    code: 0,
    message: 'success',
    data: {
      status: 'healthy',
      cdnEnabled: cdnManager.enabled,
      provider: cdnManager.provider,
      imageProcessorAvailable: imageProcessor.isAvailable()
    }
  });
});

module.exports = router;
