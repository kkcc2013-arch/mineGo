/**
 * 图片优化中间件
 * 自动检测客户端支持的图片格式，添加响应头
 * 
 * @module backend/gateway/src/middleware/imageOptimization
 */
'use strict';

const { cdnManager } = require('@pmg/shared/CDNManager');

/**
 * 图片优化中间件
 * 检测客户端支持的格式，设置 res.locals
 */
function imageOptimizationMiddleware(options = {}) {
  return (req, res, next) => {
    // 检测客户端支持的格式
    const acceptHeader = req.headers.accept || '';
    const formats = cdnManager.detectSupportedFormats(acceptHeader);

    // 存储到 res.locals 供后续使用
    res.locals.imageFormats = formats;
    res.locals.imageFormat = formats.bestFormat;
    res.locals.imageQuality = parseInt(req.query.q || req.query.quality, 10) || 85;

    // 添加辅助方法
    res.locals.getOptimizedImageUrl = (path, extraOptions = {}) => {
      const opts = {
        format: res.locals.imageFormat !== 'original' ? res.locals.imageFormat : undefined,
        quality: res.locals.imageQuality,
        ...extraOptions
      };
      return cdnManager.getResourceUrl(path, opts);
    };

    next();
  };
}

/**
 * 静态资源缓存头中间件
 * 为静态资源添加正确的 Cache-Control 和 ETag 头
 */
function staticCacheMiddleware(options = {}) {
  return (req, res, next) => {
    const path = req.path;
    const cachePolicy = cdnManager.getCachePolicy(path);

    // 设置 Cache-Control
    const cacheDirectives = [];
    
    if (cachePolicy.maxAge) {
      cacheDirectives.push(`max-age=${cachePolicy.maxAge}`);
    }
    
    if (cachePolicy.immutable) {
      cacheDirectives.push('immutable');
    }
    
    if (cachePolicy.public !== false) {
      cacheDirectives.push('public');
    }

    if (cacheDirectives.length > 0) {
      res.set('Cache-Control', cacheDirectives.join(', '));
    }

    // 设置 ETag（如果需要）
    if (cachePolicy.etag) {
      // Express 默认会生成 ETag，这里确保启用
      res.set('ETag', cdnManager.generateETag(path));
    }

    // 设置 Vary 头
    if (req.path.match(/\.(png|jpg|jpeg|gif|webp|avif)$/i)) {
      res.set('Vary', 'Accept');
    }

    next();
  };
}

/**
 * CDN URL 注入中间件
 * 在请求中注入 CDN URL 辅助函数
 */
function cdnUrlMiddleware(options = {}) {
  return (req, res, next) => {
    // 在请求对象上添加 CDN 辅助方法
    req.cdn = {
      getUrl: (path, opts) => cdnManager.getResourceUrl(path, opts),
      getResponsiveUrls: (path, opts) => cdnManager.getResponsiveUrls(path, opts),
      getSrcSet: (path, opts) => cdnManager.getResponsiveSrcSet(path, opts),
      getCachePolicy: (path) => cdnManager.getCachePolicy(path),
      isEnabled: () => cdnManager.enabled,
      getProvider: () => cdnManager.provider
    };

    // 在响应对象上添加辅助方法
    res.cdnUrl = (path, opts) => cdnManager.getResourceUrl(path, opts);
    res.cdnResponsive = (path, opts) => cdnManager.getResponsiveUrls(path, opts);

    next();
  };
}

/**
 * 图片格式协商中间件
 * 根据客户端能力自动选择最佳图片格式
 */
function imageFormatNegotiationMiddleware(options = {}) {
  const { 
    defaultFormat = 'original',
    forceFormat = null,
    qualityMap = {
      avif: 75,
      webp: 85,
      jpeg: 90,
      png: 90,
      original: 95
    }
  } = options;

  return (req, res, next) => {
    // 如果强制指定格式
    if (forceFormat) {
      res.locals.negotiatedFormat = forceFormat;
      res.locals.negotiatedQuality = qualityMap[forceFormat] || qualityMap.original;
      return next();
    }

    // 根据客户端能力选择格式
    const acceptHeader = req.headers.accept || '';
    const formats = cdnManager.detectSupportedFormats(acceptHeader);

    // 选择最佳格式
    let selectedFormat = defaultFormat;
    let selectedQuality = qualityMap.original;

    if (formats.avif && options.enableAvif !== false) {
      selectedFormat = 'avif';
      selectedQuality = qualityMap.avif;
    } else if (formats.webp && options.enableWebp !== false) {
      selectedFormat = 'webp';
      selectedQuality = qualityMap.webp;
    }

    // 允许客户端通过查询参数覆盖
    if (req.query.format && ['avif', 'webp', 'jpeg', 'png', 'original'].includes(req.query.format)) {
      selectedFormat = req.query.format;
      selectedQuality = qualityMap[selectedFormat] || qualityMap.original;
    }

    if (req.query.q || req.query.quality) {
      selectedQuality = parseInt(req.query.q || req.query.quality, 10);
    }

    res.locals.negotiatedFormat = selectedFormat;
    res.locals.negotiatedQuality = selectedQuality;

    // 添加 Vary 头
    res.set('Vary', 'Accept');

    next();
  };
}

/**
 * 图片响应头中间件
 * 为图片响应添加正确的 Content-Type 和其他头
 */
function imageResponseMiddleware(options = {}) {
  const contentTypeMap = {
    avif: 'image/avif',
    webp: 'image/webp',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif'
  };

  return (req, res, next) => {
    const format = res.locals.negotiatedFormat || res.locals.imageFormat;
    
    if (format && format !== 'original' && contentTypeMap[format]) {
      res.set('Content-Type', contentTypeMap[format]);
    }

    // 添加缓存头
    const path = req.path;
    const cachePolicy = cdnManager.getCachePolicy(path);

    if (cachePolicy.maxAge) {
      res.set('Cache-Control', `public, max-age=${cachePolicy.maxAge}${cachePolicy.immutable ? ', immutable' : ''}`);
    }

    next();
  };
}

/**
 * 预加载提示中间件
 * 添加 Link 头提示浏览器预加载关键资源
 */
function preloadHintsMiddleware(options = {}) {
  const { criticalResources = [] } = options;

  return (req, res, next) => {
    const linkHeaders = [];

    for (const resource of criticalResources) {
      if (typeof resource === 'string') {
        linkHeaders.push(`<${resource}>; rel=preload; as=image`);
      } else if (resource.path) {
        const url = cdnManager.getResourceUrl(resource.path, resource.options);
        const as = resource.as || 'image';
        linkHeaders.push(`<${url}>; rel=preload; as=${as}`);
      }
    }

    if (linkHeaders.length > 0) {
      res.set('Link', linkHeaders.join(', '));
    }

    next();
  };
}

module.exports = {
  imageOptimizationMiddleware,
  staticCacheMiddleware,
  cdnUrlMiddleware,
  imageFormatNegotiationMiddleware,
  imageResponseMiddleware,
  preloadHintsMiddleware
};
