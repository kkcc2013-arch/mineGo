/**
 * Image Optimization Middleware - 图片优化中间件
 * 
 * 自动检测客户端支持的图片格式，设置优化参数，
 * 并添加缓存控制头。
 * 
 * @module imageOptimization
 */

'use strict';

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  // 图片质量
  defaultQuality: 85,
  
  // 格式优先级（按支持程度排序）
  formatPriority: ['avif', 'webp', 'original'],
  
  // 缓存配置
  cache: {
    // 精灵图片 - 长期缓存
    pokemon: {
      maxAge: 31536000, // 1 年
      immutable: true
    },
    // UI 素材 - 中期缓存
    ui: {
      maxAge: 2592000, // 30 天
      immutable: false
    },
    // 动态图片 - 短期缓存
    dynamic: {
      maxAge: 3600, // 1 小时
      immutable: false
    }
  },
  
  // 图片尺寸限制
  maxDimensions: {
    width: 2048,
    height: 2048
  }
};

/**
 * 创建图片优化中间件
 * 
 * @param {Object} config - 配置选项
 * @returns {Function} Express 中间件
 * 
 * @example
 * app.use('/images', imageOptimizationMiddleware({
 *   defaultQuality: 90,
 *   webpEnabled: true
 * }));
 */
function imageOptimizationMiddleware(config = {}) {
  const options = { ...DEFAULT_CONFIG, ...config };
  
  return (req, res, next) => {
    // 1. 检测客户端支持的图片格式
    const acceptHeader = req.headers.accept || '';
    const userAgent = req.headers['user-agent'] || '';
    
    // 检测格式支持
    const formatSupport = {
      webp: _detectWebPSupport(acceptHeader, userAgent),
      avif: _detectAVIFSupport(acceptHeader, userAgent)
    };
    
    // 选择最优格式
    const optimalFormat = _selectOptimalFormat(formatSupport, options.formatPriority);
    
    // 2. 解析查询参数
    const queryWidth = parseInt(req.query.w || req.query.width, 10);
    const queryHeight = parseInt(req.query.h || req.query.height, 10);
    const queryQuality = parseInt(req.query.q || req.query.quality, 10);
    const queryFormat = req.query.f || req.query.format;
    const queryFit = req.query.fit || 'cover';
    
    // 3. 构建优化参数
    const optimization = {
      width: _clampDimension(queryWidth, options.maxDimensions.width),
      height: _clampDimension(queryHeight, options.maxDimensions.height),
      quality: _clampQuality(queryQuality || options.defaultQuality),
      format: _validateFormat(queryFormat) || optimalFormat,
      fit: ['cover', 'contain', 'fill', 'inside', 'outside'].includes(queryFit) 
        ? queryFit 
        : 'cover'
    };
    
    // 4. 存储到 res.locals 供后续使用
    res.locals.imageOptimization = optimization;
    res.locals.formatSupport = formatSupport;
    
    // 5. 设置 Vary 头（用于缓存区分）
    res.setHeader('Vary', 'Accept');
    
    // 6. 设置缓存头
    const cacheType = _detectCacheType(req.path);
    const cacheConfig = options.cache[cacheType] || options.cache.dynamic;
    _setCacheHeaders(res, cacheConfig);
    
    // 7. 添加响应拦截器（用于设置 ETag 和 Last-Modified）
    const originalEnd = res.end.bind(res);
    res.end = function(chunk, encoding) {
      // 设置 ETag
      if (chunk && !res.getHeader('ETag')) {
        const etag = _generateETag(chunk);
        res.setHeader('ETag', etag);
      }
      
      // 设置 Last-Modified（如果未设置）
      if (!res.getHeader('Last-Modified')) {
        res.setHeader('Last-Modified', new Date().toUTCString());
      }
      
      // 设置 Content-Type（基于优化格式）
      const mimeType = _getMimeType(optimization.format);
      if (mimeType && !res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', mimeType);
      }
      
      return originalEnd(chunk, encoding);
    };
    
    next();
  };
}

/**
 * WebP 支持检测
 * 
 * @private
 */
function _detectWebPSupport(acceptHeader, userAgent) {
  // 1. Accept 头检测
  if (acceptHeader.includes('image/webp')) {
    return true;
  }
  
  // 2. User-Agent 检测（常见浏览器）
  const webPBrowserPatterns = [
    /Chrome\/[6-9][0-9]/,          // Chrome 60+
    /Firefox\/[6-9][0-9]/,         // Firefox 65+
    /Edge\/[1-9][0-9]/,            // Edge 18+
    /Safari\/60[5-9]/,             // Safari 14+
    /Version\/1[4-9]\.[0-9]+ Safari/ // Safari 14+
  ];
  
  return webPBrowserPatterns.some(pattern => pattern.test(userAgent));
}

/**
 * AVIF 支持检测
 * 
 * @private
 */
function _detectAVIFSupport(acceptHeader, userAgent) {
  // 1. Accept 头检测
  if (acceptHeader.includes('image/avif')) {
    return true;
  }
  
  // 2. User-Agent 检测（AVIF 支持较新）
  const avifBrowserPatterns = [
    /Chrome\/[8-9][0-9]/,          // Chrome 85+
    /Firefox\/[9][0-9]/,           // Firefox 93+
    /Safari\/61[6-9]/              // Safari 16+
  ];
  
  return avifBrowserPatterns.some(pattern => pattern.test(userAgent));
}

/**
 * 选择最优格式
 * 
 * @private
 */
function _selectOptimalFormat(formatSupport, priority) {
  for (const format of priority) {
    if (format === 'original' || formatSupport[format]) {
      return format;
    }
  }
  return 'original';
}

/**
 * 限制尺寸范围
 * 
 * @private
 */
function _clampDimension(value, max) {
  if (!value || isNaN(value)) return null;
  return Math.max(1, Math.min(value, max));
}

/**
 * 限制质量范围
 * 
 * @private
 */
function _clampQuality(value) {
  if (!value || isNaN(value)) return DEFAULT_CONFIG.defaultQuality;
  return Math.max(1, Math.min(100, value));
}

/**
 * 验证格式
 * 
 * @private
 */
function _validateFormat(format) {
  const validFormats = ['webp', 'avif', 'jpeg', 'jpg', 'png', 'gif', 'original'];
  return validFormats.includes(format) ? format : null;
}

/**
 * 检测缓存类型
 * 
 * @private
 */
function _detectCacheType(path) {
  if (path.includes('/pokemon/') || path.includes('/sprites/')) {
    return 'pokemon';
  }
  if (path.includes('/ui/') || path.includes('/assets/')) {
    return 'ui';
  }
  return 'dynamic';
}

/**
 * 设置缓存头
 * 
 * @private
 */
function _setCacheHeaders(res, config) {
  const cacheControl = [
    `public`,
    `max-age=${config.maxAge}`,
    config.immutable ? 'immutable' : ''
  ].filter(Boolean).join(', ');
  
  res.setHeader('Cache-Control', cacheControl);
}

/**
 * 生成 ETag
 * 
 * @private
 */
function _generateETag(content) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(content).digest('hex');
  return `"${hash}"`;
}

/**
 * 获取 MIME 类型
 * 
 * @private
 */
function _getMimeType(format) {
  const mimeTypes = {
    webp: 'image/webp',
    avif: 'image/avif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif'
  };
  return mimeTypes[format];
}

/**
 * 图片优化参数解析中间件
 * 
 * 用于从请求中提取优化参数，不设置缓存头
 */
function parseImageParams(req, res, next) {
  const { w, h, q, f, fit } = req.query;
  
  req.imageParams = {
    width: w ? parseInt(w, 10) : null,
    height: h ? parseInt(h, 10) : null,
    quality: q ? parseInt(q, 10) : 85,
    format: f || null,
    fit: fit || 'cover'
  };
  
  next();
}

/**
 * CDN 缓存预热中间件
 * 
 * 为响应添加 CDN 缓存预热相关头
 */
function cdnCacheWarmup(config = {}) {
  const { cdnDomain, cacheTags = [] } = config;
  
  return (req, res, next) => {
    // 设置 CDN 相关头
    if (cdnDomain) {
      res.setHeader('CDN-Cache-Control', 'max-age=31536000');
    }
    
    // 设置缓存标签（用于按标签清除缓存）
    if (cacheTags.length > 0) {
      res.setHeader('Cache-Tag', cacheTags.join(', '));
    }
    
    // 添加 Surrogate-Key（某些 CDN 使用）
    if (req.path) {
      const key = req.path.replace(/[/]/g, '-').substring(1);
      res.setHeader('Surrogate-Key', key);
    }
    
    next();
  };
}

module.exports = {
  imageOptimizationMiddleware,
  parseImageParams,
  cdnCacheWarmup,
  DEFAULT_CONFIG
};
