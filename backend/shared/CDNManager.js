/**
 * CDN Manager - CDN 资源管理与 URL 生成
 * 
 * 支持多 CDN 提供商（Cloudflare、阿里云 CDN），
 * 提供资源 URL 生成、缓存清除、统计查询等功能。
 * 
 * @module CDNManager
 */

'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * CDN 提供商配置
 */
const PROVIDERS = {
  cloudflare: {
    name: 'Cloudflare',
    apiBase: 'https://api.cloudflare.com/client/v4',
    purgeEndpoint: '/zones/{zoneId}/purge_cache'
  },
  aliyun: {
    name: 'Aliyun CDN',
    apiBase: 'https://cdn.aliyuncs.com',
    purgeEndpoint: '/2018-05-10/cdn/PushObjectCache'
  }
};

/**
 * 图片格式 MIME 类型映射
 */
const FORMAT_MIME = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif'
};

/**
 * CDN 管理器类
 * 
 * @example
 * const cdn = new CDNManager({
 *   provider: 'cloudflare',
 *   domain: 'https://cdn.minego.example.com',
 *   originUrl: 'https://static.minego.example.com'
 * });
 * 
 * const url = cdn.getResourceUrl('/pokemon/25.png', { width: 128, format: 'webp' });
 */
class CDNManager extends EventEmitter {
  /**
   * 创建 CDN 管理器实例
   * 
   * @param {Object} config - 配置选项
   * @param {string} config.provider - CDN 提供商 ('cloudflare' | 'aliyun')
   * @param {string} config.domain - CDN 域名
   * @param {string} [config.originUrl] - 源站 URL（CDN 不可用时回退）
   * @param {boolean} [config.enabled=true] - 是否启用 CDN
   * @param {Object} [config.providerConfig] - 提供商特定配置
   */
  constructor(config) {
    super();
    
    this.provider = config.provider || 'cloudflare';
    this.domain = config.domain || '';
    this.originUrl = config.originUrl || '';
    this.enabled = config.enabled !== false;
    this.providerConfig = config.providerConfig || {};
    
    // 统计数据
    this.stats = {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesTransferred: 0,
      errors: 0
    };
    
    // 资源版本缓存
    this.resourceVersions = new Map();
    
    // 验证配置
    if (!PROVIDERS[this.provider]) {
      throw new Error(`Unsupported CDN provider: ${this.provider}`);
    }
    
    console.log(`[CDN] Initialized with provider: ${PROVIDERS[this.provider].name}, enabled: ${this.enabled}`);
  }

  /**
   * 获取 CDN 资源 URL
   * 
   * @param {string} path - 资源路径
   * @param {Object} [options] - 优化选项
   * @param {number} [options.width] - 图片宽度
   * @param {number} [options.height] - 图片高度
   * @param {string} [options.format] - 图片格式 ('webp' | 'avif' | 'original')
   * @param {number} [options.quality] - 图片质量 (1-100)
   * @param {string} [options.fit] - 图片裁剪方式 ('cover' | 'contain' | 'fill')
   * @param {boolean} [options.cacheBust=false] - 是否添加缓存破坏参数
   * @returns {string} 资源 URL
   */
  getResourceUrl(path, options = {}) {
    if (!this.enabled || !this.domain) {
      return this._getFallbackUrl(path);
    }
    
    // 规范化路径
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    
    // 构建查询参数
    const params = new URLSearchParams();
    
    if (options.width) params.set('w', Math.min(options.width, 2048));
    if (options.height) params.set('h', Math.min(options.height, 2048));
    if (options.format && options.format !== 'original') {
      params.set('f', options.format);
    }
    if (options.quality) params.set('q', Math.min(100, Math.max(1, options.quality)));
    if (options.fit) params.set('fit', options.fit);
    
    // 添加版本号用于缓存破坏
    if (options.cacheBust) {
      params.set('v', Date.now().toString(36));
    } else {
      const version = this.resourceVersions.get(normalizedPath);
      if (version) {
        params.set('v', version);
      }
    }
    
    const queryString = params.toString();
    return queryString 
      ? `${this.domain}${normalizedPath}?${queryString}`
      : `${this.domain}${normalizedPath}`;
  }

  /**
   * 获取响应式图片 URL 集合
   * 
   * @param {string} path - 图片路径
   * @param {Object} [options] - 基础选项
   * @returns {Object} 不同尺寸的 URL 集合
   */
  getResponsiveUrls(path, options = {}) {
    const presets = {
      thumbnail: { width: 64, height: 64 },
      small: { width: 128, height: 128 },
      medium: { width: 256, height: 256 },
      large: { width: 512, height: 512 },
      original: {}
    };
    
    const urls = {};
    for (const [name, size] of Object.entries(presets)) {
      urls[name] = this.getResourceUrl(path, { ...options, ...size });
    }
    
    return urls;
  }

  /**
   * 生成 srcset 属性值
   * 
   * @param {string} path - 图片路径
   * @param {Object} [options] - 基础选项
   * @returns {string} srcset 属性值
   */
  generateSrcset(path, options = {}) {
    const sizes = [
      { width: 64, descriptor: '64w' },
      { width: 128, descriptor: '128w' },
      { width: 256, descriptor: '256w' },
      { width: 512, descriptor: '512w' }
    ];
    
    return sizes
      .map(({ width, descriptor }) => {
        const url = this.getResourceUrl(path, { ...options, width });
        return `${url} ${descriptor}`;
      })
      .join(', ');
  }

  /**
   * 清除 CDN 缓存
   * 
   * @param {string|string[]} paths - 要清除的路径
   * @returns {Promise<Object>} 清除结果
   */
  async purgeCache(paths) {
    const pathArray = Array.isArray(paths) ? paths : [paths];
    
    if (!this.enabled) {
      return { success: true, message: 'CDN disabled, no cache to purge' };
    }
    
    try {
      const provider = PROVIDERS[this.provider];
      
      // 模拟 API 调用（实际部署时替换为真实 API）
      console.log(`[CDN] Purging cache for ${pathArray.length} paths`);
      
      // 根据提供商调用不同的 API
      if (this.provider === 'cloudflare') {
        // Cloudflare API 调用
        // await this._cloudflarePurge(pathArray);
      } else if (this.provider === 'aliyun') {
        // 阿里云 CDN API 调用
        // await this._aliyunPurge(pathArray);
      }
      
      // 清除本地版本缓存
      pathArray.forEach(path => {
        this.resourceVersions.delete(path);
      });
      
      this.emit('cache:purged', { paths: pathArray, timestamp: Date.now() });
      
      return {
        success: true,
        provider: this.provider,
        paths: pathArray,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      this.stats.errors++;
      this.emit('error', { type: 'purge', error, paths: pathArray });
      throw error;
    }
  }

  /**
   * 设置资源版本
   * 
   * @param {string} path - 资源路径
   * @param {string} [version] - 版本号（不传则自动生成）
   */
  setResourceVersion(path, version) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const v = version || crypto.randomBytes(4).toString('hex');
    this.resourceVersions.set(normalizedPath, v);
  }

  /**
   * 批量设置资源版本
   * 
   * @param {Object} versions - 路径到版本的映射
   */
  setResourceVersions(versions) {
    for (const [path, version] of Object.entries(versions)) {
      this.setResourceVersion(path, version);
    }
  }

  /**
   * 记录请求统计
   * 
   * @param {Object} data - 请求数据
   */
  recordRequest(data = {}) {
    this.stats.requests++;
    if (data.cacheHit) {
      this.stats.cacheHits++;
    } else {
      this.stats.cacheMisses++;
    }
    if (data.bytes) {
      this.stats.bytesTransferred += data.bytes;
    }
  }

  /**
   * 获取统计数据
   * 
   * @returns {Object} 统计数据
   */
  getStats() {
    const hitRate = this.stats.requests > 0 
      ? (this.stats.cacheHits / this.stats.requests * 100).toFixed(2)
      : 0;
    
    return {
      ...this.stats,
      cacheHitRate: `${hitRate}%`,
      provider: this.provider,
      enabled: this.enabled,
      domain: this.domain
    };
  }

  /**
   * 重置统计数据
   */
  resetStats() {
    this.stats = {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesTransferred: 0,
      errors: 0
    };
  }

  /**
   * 获取回退 URL
   * 
   * @private
   * @param {string} path - 资源路径
   * @returns {string} 源站 URL
   */
  _getFallbackUrl(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return this.originUrl 
      ? `${this.originUrl}${normalizedPath}`
      : normalizedPath;
  }

  /**
   * 检查是否支持指定格式
   * 
   * @param {string} format - 图片格式
   * @returns {boolean} 是否支持
   */
  isFormatSupported(format) {
    return format in FORMAT_MIME;
  }

  /**
   * 获取 MIME 类型
   * 
   * @param {string} format - 图片格式
   * @returns {string} MIME 类型
   */
  getMimeType(format) {
    return FORMAT_MIME[format] || 'application/octet-stream';
  }

  /**
   * 健康检查
   * 
   * @returns {Object} 健康状态
   */
  healthCheck() {
    return {
      status: this.enabled ? 'healthy' : 'disabled',
      provider: this.provider,
      domain: this.domain,
      stats: {
        requests: this.stats.requests,
        errors: this.stats.errors,
        cacheHitRate: this.stats.requests > 0 
          ? `${(this.stats.cacheHits / this.stats.requests * 100).toFixed(2)}%`
          : 'N/A'
      }
    };
  }
}

module.exports = {
  CDNManager,
  PROVIDERS,
  FORMAT_MIME
};
