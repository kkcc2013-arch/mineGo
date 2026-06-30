/**
 * Image Processor - 图片处理与优化
 * 
 * 提供图片压缩、格式转换、尺寸调整、响应式图片生成等功能。
 * 支持 WebP、AVIF 等现代图片格式。
 * 
 * @module ImageProcessor
 */

'use strict';

const EventEmitter = require('events');
const path = require('path');
const crypto = require('crypto');

/**
 * 预设图片尺寸
 */
const IMAGE_PRESETS = {
  thumbnail: { width: 64, height: 64, quality: 80 },
  small: { width: 128, height: 128, quality: 85 },
  medium: { width: 256, height: 256, quality: 85 },
  large: { width: 512, height: 512, quality: 90 },
  hero: { width: 1024, height: 1024, quality: 90 },
  original: null
};

/**
 * 图片格式配置
 */
const FORMAT_CONFIG = {
  webp: {
    extension: '.webp',
    mimeType: 'image/webp',
    quality: 85,
    lossless: false
  },
  avif: {
    extension: '.avif',
    mimeType: 'image/avif',
    quality: 80,
    lossless: false
  },
  jpeg: {
    extension: '.jpg',
    mimeType: 'image/jpeg',
    quality: 85,
    progressive: true
  },
  png: {
    extension: '.png',
    mimeType: 'image/png',
    compressionLevel: 9
  }
};

/**
 * 图片处理器类
 * 
 * @example
 * const processor = new ImageProcessor();
 * 
 * // 生成响应式图片
 * const results = await processor.generateResponsiveImages('/path/to/image.png');
 * 
 * // 转换格式
 * const webp = await processor.convert('/path/to/image.png', { format: 'webp' });
 */
class ImageProcessor extends EventEmitter {
  /**
   * 创建图片处理器实例
   * 
   * @param {Object} config - 配置选项
   * @param {string} [config.outputDir] - 输出目录
   * @param {number} [config.defaultQuality=85] - 默认质量
   * @param {boolean} [config.webpEnabled=true] - 是否启用 WebP
   * @param {boolean} [config.avifEnabled=true] - 是否启用 AVIF
   */
  constructor(config = {}) {
    super();
    
    this.outputDir = config.outputDir || './optimized';
    this.defaultQuality = config.defaultQuality || 85;
    this.webpEnabled = config.webpEnabled !== false;
    this.avifEnabled = config.avifEnabled !== false;
    
    // 处理统计
    this.stats = {
      processed: 0,
      bytesSaved: 0,
      errors: 0,
      byFormat: {}
    };
    
    logger.info({ webpEnabled: this.webpEnabled, avifEnabled: this.avifEnabled }, 'ImageProcessor initialized');
  }

  /**
   * 生成响应式图片
   * 
   * @param {string} imagePath - 源图片路径
   * @param {Object} [options] - 生成选项
   * @param {string[]} [options.presets] - 要生成的预设尺寸
   * @param {string[]} [options.formats] - 要生成的格式
   * @returns {Promise<Object>} 生成的图片信息
   */
  async generateResponsiveImages(imagePath, options = {}) {
    const presets = options.presets || Object.keys(IMAGE_PRESETS);
    const formats = options.formats || this._getEnabledFormats();
    
    const results = {
      original: imagePath,
      images: {},
      meta: {
        generatedAt: new Date().toISOString(),
        totalFiles: 0,
        totalBytes: 0
      }
    };
    
    // 模拟图片处理（实际部署时使用 sharp/jimp）
    for (const presetName of presets) {
      const preset = IMAGE_PRESETS[presetName];
      if (!preset) continue;
      
      results.images[presetName] = {};
      
      for (const format of formats) {
        const result = await this._processImage(imagePath, {
          ...preset,
          format
        });
        
        if (result) {
          results.images[presetName][format] = result;
          results.meta.totalFiles++;
          results.meta.totalBytes += result.size || 0;
        }
      }
    }
    
    this.stats.processed++;
    this.emit('processed', { path: imagePath, results });
    
    return results;
  }

  /**
   * 转换图片格式
   * 
   * @param {string} imagePath - 源图片路径
   * @param {Object} options - 转换选项
   * @param {string} options.format - 目标格式
   * @param {number} [options.quality] - 图片质量
   * @returns {Promise<Object>} 转换结果
   */
  async convert(imagePath, options) {
    const format = options.format || 'webp';
    const quality = options.quality || this.defaultQuality;
    
    const result = await this._processImage(imagePath, {
      format,
      quality,
      width: null,
      height: null
    });
    
    return result;
  }

  /**
   * 压缩图片
   * 
   * @param {string} imagePath - 源图片路径
   * @param {Object} [options] - 压缩选项
   * @param {number} [options.quality] - 压缩质量
   * @param {number} [options.maxWidth] - 最大宽度
   * @param {number} [options.maxHeight] - 最大高度
   * @returns {Promise<Object>} 压缩结果
   */
  async compress(imagePath, options = {}) {
    const quality = options.quality || this.defaultQuality;
    
    const result = await this._processImage(imagePath, {
      format: this._detectFormat(imagePath),
      quality,
      width: options.maxWidth,
      height: options.maxHeight
    });
    
    return result;
  }

  /**
   * 获取图片信息
   * 
   * @param {string} imagePath - 图片路径
   * @returns {Promise<Object>} 图片信息
   */
  async getImageInfo(imagePath) {
    // 模拟获取图片信息
    const ext = path.extname(imagePath).toLowerCase();
    const format = ext.replace('.', '');
    
    return {
      path: imagePath,
      format,
      mimeType: FORMAT_CONFIG[format]?.mimeType || 'image/unknown',
      // 实际部署时从图片读取
      width: 512,
      height: 512,
      size: 102400,
      hash: this._generateHash(imagePath)
    };
  }

  /**
   * 批量处理图片
   * 
   * @param {string[]} imagePaths - 图片路径数组
   * @param {Object} [options] - 处理选项
   * @returns {Promise<Object[]>} 处理结果数组
   */
  async batchProcess(imagePaths, options = {}) {
    const results = [];
    
    for (const imagePath of imagePaths) {
      try {
        const result = await this.generateResponsiveImages(imagePath, options);
        results.push(result);
      } catch (error) {
        this.stats.errors++;
        results.push({
          path: imagePath,
          error: error.message
        });
      }
    }
    
    return results;
  }

  /**
   * 计算优化收益
   * 
   * @param {Object} original - 原始图片信息
   * @param {Object} optimized - 优化后图片信息
   * @returns {Object} 收益统计
   */
  calculateSavings(original, optimized) {
    const originalSize = original.size || 0;
    const optimizedSize = optimized.size || 0;
    const saved = originalSize - optimizedSize;
    const percentage = originalSize > 0 ? (saved / originalSize * 100).toFixed(2) : 0;
    
    this.stats.bytesSaved += Math.max(0, saved);
    
    return {
      originalSize,
      optimizedSize,
      savedBytes: Math.max(0, saved),
      savedPercentage: `${percentage}%`
    };
  }

  /**
   * 获取统计数据
   * 
   * @returns {Object} 统计数据
   */
  getStats() {
    return {
      ...this.stats,
      webpEnabled: this.webpEnabled,
      avifEnabled: this.avifEnabled
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.stats = {
      processed: 0,
      bytesSaved: 0,
      errors: 0,
      byFormat: {}
    };
  }

  /**
   * 获取预设配置
   * 
   * @returns {Object} 预设配置
   */
  static getPresets() {
    return { ...IMAGE_PRESETS };
  }

  /**
   * 获取格式配置
   * 
   * @returns {Object} 格式配置
   */
  static getFormatConfig() {
    return { ...FORMAT_CONFIG };
  }

  // ============ 私有方法 ============

  /**
   * 处理单张图片
   * 
   * @private
   */
  async _processImage(imagePath, options) {
    const format = options.format || 'webp';
    const quality = options.quality || this.defaultQuality;
    const width = options.width;
    const height = options.height;
    
    // 模拟处理过程
    const outputPath = this._generateOutputPath(imagePath, format, width);
    const estimatedSize = this._estimateSize(imagePath, { format, quality, width, height });
    
    // 更新格式统计
    if (!this.stats.byFormat[format]) {
      this.stats.byFormat[format] = { count: 0, bytes: 0 };
    }
    this.stats.byFormat[format].count++;
    this.stats.byFormat[format].bytes += estimatedSize;
    
    return {
      inputPath: imagePath,
      outputPath,
      format,
      width: width || 'original',
      height: height || 'original',
      quality,
      size: estimatedSize,
      mimeType: FORMAT_CONFIG[format]?.mimeType || 'image/unknown',
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 获取启用的格式列表
   * 
   * @private
   */
  _getEnabledFormats() {
    const formats = ['original'];
    if (this.webpEnabled) formats.push('webp');
    if (this.avifEnabled) formats.push('avif');
    return formats;
  }

  /**
   * 检测图片格式
   * 
   * @private
   */
  _detectFormat(imagePath) {
    const ext = path.extname(imagePath).toLowerCase().replace('.', '');
    return ext === 'jpg' ? 'jpeg' : ext;
  }

  /**
   * 生成输出路径
   * 
   * @private
   */
  _generateOutputPath(imagePath, format, size) {
    const dir = path.dirname(imagePath);
    const name = path.basename(imagePath, path.extname(imagePath));
    const ext = FORMAT_CONFIG[format]?.extension || `.${format}`;
    const sizeSuffix = size ? `-${size}` : '';
    return path.join(this.outputDir, dir, `${name}${sizeSuffix}${ext}`);
  }

  /**
   * 估算优化后大小
   * 
   * @private
   */
  _estimateSize(imagePath, options) {
    // 模拟大小估算
    // 实际部署时根据原图和优化参数计算
    const baseSize = 102400; // 基准 100KB
    const formatFactor = {
      webp: 0.7,  // WebP 通常比 JPEG 小 30%
      avif: 0.5,  // AVIF 通常比 JPEG 小 50%
      jpeg: 1.0,
      png: 1.2
    };
    const qualityFactor = (options.quality || 85) / 100;
    const sizeFactor = options.width ? (options.width / 512) : 1;
    
    const factor = (formatFactor[options.format] || 1) * qualityFactor * sizeFactor;
    return Math.round(baseSize * factor);
  }

  /**
   * 生成文件哈希
   * 
   * @private
   */
  _generateHash(content) {
    return crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
  }
}

module.exports = {
  ImageProcessor,
  IMAGE_PRESETS,
  FORMAT_CONFIG
};
