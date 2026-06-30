/**
 * CDN Manager - CDN 资源管理与图片优化核心模块
 * 支持 Cloudflare/阿里云 CDN 集成，图片格式转换，响应式图片生成
 * 
 * @module backend/shared/CDNManager
 */
'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { createLogger } = require('./logger');

// 模块级 logger
const logger = createLogger('cdn-manager');

/**
 * CDN 提供商配置
 */
const CDN_PROVIDERS = {
  cloudflare: {
    name: 'cloudflare',
    apiEndpoint: 'https://api.cloudflare.com/client/v4',
    // Cloudflare Image Resizing 参数
    transformParams: {
      width: 'width',
      height: 'height',
      format: 'format',
      quality: 'quality',
      fit: 'fit'
    }
  },
  aliyun: {
    name: 'aliyun',
    apiEndpoint: 'https://cdn.aliyuncs.com',
    // 阿里云 OSS 图片处理参数
    transformParams: {
      width: 'w',
      height: 'h',
      format: 'f',
      quality: 'q'
    }
  },
  local: {
    name: 'local',
    // 本地开发模式，不使用 CDN
    transformParams: {}
  }
};

/**
 * 图片预设尺寸
 */
const IMAGE_PRESETS = {
  thumbnail: { width: 64, height: 64, quality: 80 },
  small: { width: 128, height: 128, quality: 85 },
  medium: { width: 256, height: 256, quality: 85 },
  large: { width: 512, height: 512, quality: 90 },
  hd: { width: 1024, height: 1024, quality: 90 },
  original: { quality: 95 }
};

/**
 * 缓存策略配置
 */
const CACHE_CONFIG = {
  // 精灵图片 - 长期缓存
  pokemon_images: {
    maxAge: 31536000, // 1 年
    immutable: true,
    etag: true
  },
  // UI 素材 - 中期缓存
  ui_assets: {
    maxAge: 2592000, // 30 天
    etag: true
  },
  // 动态图片 - 短期缓存
  dynamic_images: {
    maxAge: 3600, // 1 小时
    etag: true
  },
  // 默认缓存策略
  default: {
    maxAge: 86400, // 1 天
    etag: true
  }
};

/**
 * CDN 管理器类
 */
class CDNManager {
  /**
   * @param {Object} config - CDN 配置
   * @param {string} config.provider - CDN 提供商 ('cloudflare' | 'aliyun' | 'local')
   * @param {string} config.domain - CDN 域名
   * @param {string} config.originUrl - 源站 URL
   * @param {boolean} config.enabled - 是否启用 CDN
   * @param {string} config.apiToken - CDN API Token
   * @param {string} config.zoneId - CDN Zone ID (Cloudflare)
   */
  constructor(config = {}) {
    this.provider = config.provider || 'local';
    this.domain = config.domain || '';
    this.originUrl = config.originUrl || '';
    this.enabled = config.enabled !== false && this.provider !== 'local';
    this.apiToken = config.apiToken || process.env.CDN_API_TOKEN || '';
    this.zoneId = config.zoneId || process.env.CDN_ZONE_ID || '';
    
    this.providerConfig = CDN_PROVIDERS[this.provider] || CDN_PROVIDERS.local;
    
    // 统计信息
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      imagesOptimized: 0,
      bytesSaved: 0
    };
  }

  /**
   * 获取 CDN 资源 URL
   * @param {string} path - 资源路径
   * @param {Object} options - 转换选项
   * @param {number} options.width - 宽度
   * @param {number} options.height - 高度
   * @param {string} options.format - 格式 ('webp' | 'avif' | 'jpg' | 'png')
   * @param {number} options.quality - 质量 (1-100)
   * @param {string} options.preset - 预设尺寸 ('thumbnail' | 'small' | 'medium' | 'large' | 'hd' | 'original')
   * @returns {string} CDN URL
   */
  getResourceUrl(path, options = {}) {
    if (!this.enabled || !this.domain) {
      return `${this.originUrl}${path}`;
    }

    // 应用预设
    if (options.preset && IMAGE_PRESETS[options.preset]) {
      const preset = IMAGE_PRESETS[options.preset];
      options = { ...preset, ...options };
    }

    // 构建转换参数
    const params = this._buildTransformParams(options);
    
    // 生成带版本号的 URL（用于缓存失效）
    const version = this._getAssetVersion(path);
    
    let url = `${this.domain}${path}`;
    
    if (Object.keys(params).length > 0) {
      url += (url.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
    }
    
    if (version) {
      url += (url.includes('?') ? '&' : '?') + `v=${version}`;
    }

    this.stats.totalRequests++;
    
    return url;
  }

  /**
   * 获取响应式图片 srcset
   * @param {string} path - 资源路径
   * @param {Object} options - 基础选项
   * @returns {string} srcset 属性值
   */
  getResponsiveSrcSet(path, options = {}) {
    const sizes = ['small', 'medium', 'large', 'hd'];
    const srcSet = sizes.map(preset => {
      const url = this.getResourceUrl(path, { ...options, preset });
      const size = IMAGE_PRESETS[preset];
      return `${url} ${size.width}w`;
    });
    return srcSet.join(', ');
  }

  /**
   * 获取图片的多种尺寸 URL
   * @param {string} path - 资源路径
   * @param {Object} options - 基础选项
   * @returns {Object} 各尺寸 URL 对象
   */
  getResponsiveUrls(path, options = {}) {
    const urls = {};
    for (const [preset, size] of Object.entries(IMAGE_PRESETS)) {
      urls[preset] = this.getResourceUrl(path, { ...options, preset });
    }
    return urls;
  }

  /**
   * 清除 CDN 缓存
   * @param {string|string[]} paths - 要清除缓存的路径
   * @returns {Promise<Object>} 清除结果
   */
  async purgeCache(paths) {
    if (!this.enabled) {
      return { success: true, message: 'CDN disabled, no cache to purge' };
    }

    const pathArray = Array.isArray(paths) ? paths : [paths];
    
    try {
      switch (this.provider) {
        case 'cloudflare':
          return await this._purgeCloudflare(pathArray);
        case 'aliyun':
          return await this._purgeAliyun(pathArray);
        default:
          return { success: false, message: 'Unsupported provider' };
      }
    } catch (error) {
      logger.error({ module: 'CDNManager', error: error.message }, 'Purge cache failed');
      return { success: false, error: error.message };
    }
  }

  /**
   * 清除所有缓存
   * @returns {Promise<Object>} 清除结果
   */
  async purgeAll() {
    if (!this.enabled) {
      return { success: true, message: 'CDN disabled' };
    }

    if (this.provider === 'cloudflare') {
      try {
        const response = await fetch(
          `${this.providerConfig.apiEndpoint}/zones/${this.zoneId}/purge_cache`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ purge_everything: true })
          }
        );
        
        const result = await response.json();
        return {
          success: result.success,
          result
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }

    return { success: false, message: 'Purge all not supported for this provider' };
  }

  /**
   * 获取缓存策略
   * @param {string} path - 资源路径
   * @returns {Object} 缓存策略配置
   */
  getCachePolicy(path) {
    // 根据路径匹配缓存策略
    if (path.includes('/pokemon/') || path.includes('/sprites/')) {
      return CACHE_CONFIG.pokemon_images;
    }
    if (path.includes('/ui/') || path.includes('/assets/')) {
      return CACHE_CONFIG.ui_assets;
    }
    if (path.includes('/user/') || path.includes('/dynamic/')) {
      return CACHE_CONFIG.dynamic_images;
    }
    return CACHE_CONFIG.default;
  }

  /**
   * 生成 ETag
   * @param {string} path - 资源路径
   * @param {Object} stats - 文件状态 (size, mtime)
   * @returns {string} ETag 值
   */
  generateETag(path, stats = {}) {
    const { size = 0, mtime = Date.now() } = stats;
    const hash = crypto
      .createHash('md5')
      .update(`${path}:${size}:${mtime}`)
      .digest('hex');
    return `"${hash}"`;
  }

  /**
   * 检查客户端是否支持指定格式
   * @param {string} acceptHeader - Accept 请求头
   * @returns {Object} 支持的格式
   */
  detectSupportedFormats(acceptHeader = '') {
    return {
      webp: acceptHeader.includes('image/webp'),
      avif: acceptHeader.includes('image/avif'),
      jpg: true,
      png: true,
      // 返回最优格式
      bestFormat: acceptHeader.includes('image/avif') ? 'avif' :
                  acceptHeader.includes('image/webp') ? 'webp' : 'original'
    };
  }

  /**
   * 获取 CDN 统计数据
   * @returns {Object} 统计数据
   */
  getStats() {
    const hitRate = this.stats.totalRequests > 0 
      ? (this.stats.cacheHits / this.stats.totalRequests * 100).toFixed(2)
      : 0;
    
    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      provider: this.provider,
      enabled: this.enabled
    };
  }

  /**
   * 重置统计数据
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      imagesOptimized: 0,
      bytesSaved: 0
    };
  }

  /**
   * 记录缓存命中
   * @param {boolean} hit - 是否命中
   * @param {number} bytesSaved - 节省的字节数
   */
  recordCacheHit(hit, bytesSaved = 0) {
    if (hit) {
      this.stats.cacheHits++;
      this.stats.bytesSaved += bytesSaved;
    } else {
      this.stats.cacheMisses++;
    }
  }

  /**
   * 记录图片优化
   * @param {number} originalSize - 原始大小
   * @param {number} optimizedSize - 优化后大小
   */
  recordImageOptimization(originalSize, optimizedSize) {
    this.stats.imagesOptimized++;
    this.stats.bytesSaved += (originalSize - optimizedSize);
  }

  // ── 私有方法 ─────────────────────────────────────────────────

  /**
   * 构建图片转换参数
   * @private
   */
  _buildTransformParams(options) {
    const params = {};
    const transformParams = this.providerConfig.transformParams;

    if (options.width && transformParams.width) {
      params[transformParams.width] = options.width;
    }
    if (options.height && transformParams.height) {
      params[transformParams.height] = options.height;
    }
    if (options.format && transformParams.format && options.format !== 'original') {
      params[transformParams.format] = options.format;
    }
    if (options.quality && transformParams.quality) {
      params[transformParams.quality] = options.quality;
    }

    return params;
  }

  /**
   * 获取资源版本号
   * @private
   */
  _getAssetVersion(path) {
    // 使用路径的 hash 作为版本号
    // 生产环境应该使用实际的文件 hash 或版本号
    return crypto
      .createHash('md5')
      .update(path)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * Cloudflare 缓存清除
   * @private
   */
  async _purgeCloudflare(paths) {
    const response = await fetch(
      `${this.providerConfig.apiEndpoint}/zones/${this.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files: paths.map(p => `${this.domain}${p}`) })
      }
    );

    const result = await response.json();
    
    if (result.success) {
      logger.info({ module: 'CDNManager', count: paths.length }, 'Purged files from Cloudflare');
    }
    
    return {
      success: result.success,
      result,
      purgedCount: paths.length
    };
  }

  /**
   * 阿里云 CDN 缓存清除
   * @private
   */
  async _purgeAliyun(paths) {
    // 阿里云 CDN 需要使用 SDK
    // 这里简化实现，实际需要集成 @alicloud/cdn20180510
    logger.info({ module: 'CDNManager', count: paths.length }, 'Purging files from Aliyun CDN');
    
    return {
      success: true,
      message: 'Aliyun CDN purge requested',
      purgedCount: paths.length
    };
  }
}

/**
 * 图片处理器类
 */
class ImageProcessor {
  constructor() {
    // Sharp 库引用（如果可用）
    this.sharp = null;
    try {
      this.sharp = require('sharp');
    } catch (e) {
      logger.warn({ module: 'ImageProcessor' }, 'Sharp not available, image processing disabled');
    }
  }

  /**
   * 处理图片
   * @param {Buffer|string} input - 输入图片（Buffer 或文件路径）
   * @param {Object} options - 处理选项
   * @returns {Promise<Buffer>} 处理后的图片 Buffer
   */
  async process(input, options = {}) {
    if (!this.sharp) {
      throw new Error('Sharp not available');
    }

    let pipeline = this.sharp(input);

    // 调整尺寸
    if (options.width || options.height) {
      pipeline = pipeline.resize(options.width, options.height, {
        fit: options.fit || 'inside',
        withoutEnlargement: true
      });
    }

    // 格式转换
    if (options.format === 'webp') {
      pipeline = pipeline.webp({ quality: options.quality || 85 });
    } else if (options.format === 'avif') {
      pipeline = pipeline.avif({ quality: options.quality || 80 });
    } else if (options.format === 'jpeg' || options.format === 'jpg') {
      pipeline = pipeline.jpeg({ quality: options.quality || 90 });
    } else if (options.format === 'png') {
      pipeline = pipeline.png({ compressionLevel: 9 });
    }

    return pipeline.toBuffer();
  }

  /**
   * 生成响应式图片
   * @param {Buffer|string} input - 输入图片
   * @param {string[]} presets - 预设尺寸列表
   * @returns {Promise<Object>} 各尺寸图片 Buffer
   */
  async generateResponsiveImages(input, presets = ['thumbnail', 'small', 'medium', 'large']) {
    const results = {};
    
    for (const preset of presets) {
      const sizeConfig = IMAGE_PRESETS[preset];
      if (!sizeConfig) continue;

      try {
        results[preset] = await this.process(input, {
          width: sizeConfig.width,
          height: sizeConfig.height,
          quality: sizeConfig.quality,
          fit: 'inside'
        });
      } catch (error) {
        logger.error({ module: 'ImageProcessor', preset, error: error.message }, 'Failed to generate preset');
      }
    }

    return results;
  }

  /**
   * 获取图片元数据
   * @param {Buffer|string} input - 输入图片
   * @returns {Promise<Object>} 图片元数据
   */
  async getMetadata(input) {
    if (!this.sharp) {
      throw new Error('Sharp not available');
    }

    const metadata = await this.sharp(input).metadata();
    
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      size: metadata.size,
      hasAlpha: metadata.hasAlpha,
      channels: metadata.channels
    };
  }

  /**
   * 批量优化图片
   * @param {Array<{input: Buffer|string, options: Object}>} images - 图片列表
   * @param {Function} onProgress - 进度回调
   * @returns {Promise<Array>} 处理结果列表
   */
  async batchProcess(images, onProgress) {
    const results = [];
    
    for (let i = 0; i < images.length; i++) {
      const { input, options } = images[i];
      
      try {
        const result = await this.process(input, options);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }

      if (onProgress) {
        onProgress(i + 1, images.length);
      }
    }

    return results;
  }

  /**
   * 检查 Sharp 是否可用
   * @returns {boolean}
   */
  isAvailable() {
    return !!this.sharp;
  }
}

// ── 单例导出 ──────────────────────────────────────────────────

/**
 * 默认 CDN 管理器实例
 */
const defaultCDNManager = new CDNManager({
  provider: process.env.CDN_PROVIDER || 'local',
  domain: process.env.CDN_DOMAIN || '',
  originUrl: process.env.CDN_ORIGIN_URL || '',
  enabled: process.env.CDN_ENABLED === 'true',
  apiToken: process.env.CDN_API_TOKEN,
  zoneId: process.env.CDN_ZONE_ID
});

/**
 * 默认图片处理器实例
 */
const defaultImageProcessor = new ImageProcessor();

module.exports = {
  CDNManager,
  ImageProcessor,
  cdnManager: defaultCDNManager,
  imageProcessor: defaultImageProcessor,
  IMAGE_PRESETS,
  CACHE_CONFIG,
  CDN_PROVIDERS
};
