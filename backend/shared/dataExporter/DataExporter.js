/**
 * REQ-00527: 用户数据导出格式转换与可携带性系统
 * 多格式数据导出引擎
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class DataExporter {
  constructor(config) {
    this.config = config;
    this.formatters = new Map();
    this.encryptionKey = config.encryptionKey || process.env.EXPORT_ENCRYPTION_KEY;
    this.maxFileSize = config.maxFileSize || 100 * 1024 * 1024; // 100MB
    this.tempDir = config.tempDir || '/tmp/exports';
    
    // 注册格式化器
    this._registerFormatters();
  }

  /**
   * 注册所有格式化器
   */
  _registerFormatters() {
    const JsonFormatter = require('./formatters/JsonFormatter');
    const CsvFormatter = require('./formatters/CsvFormatter');
    const XmlFormatter = require('./formatters/XmlFormatter');
    const PdfFormatter = require('./formatters/PdfFormatter');
    const ParquetFormatter = require('./formatters/ParquetFormatter');
    
    this.formatters.set('json', new JsonFormatter());
    this.formatters.set('csv', new CsvFormatter());
    this.formatters.set('xml', new XmlFormatter());
    this.formatters.set('pdf', new PdfFormatter());
    this.formatters.set('parquet', new ParquetFormatter());
  }

  /**
   * 导出用户数据
   * @param {string} userId - 用户 ID
   * @param {object} options - 导出选项
   * @returns {object} 导出结果
   */
  async export(userId, options) {
    const { format = 'json', dataTypes, encrypt = false, sign = false } = options;
    
    const startTime = Date.now();
    logger.info({ userId, format, dataTypes }, 'Starting data export');
    
    try {
      // 1. 验证格式
      if (!this.formatters.has(format)) {
        throw new Error(`Unsupported format: ${format}`);
      }
      
      // 2. 聚合用户数据
      const aggregator = new (require('./UserDataAggregator'))(this.config.services);
      const userData = await aggregator.collect(userId, dataTypes);
      
      // 3. 添加元数据
      const exportData = {
        export: {
          version: '1.0',
          userId,
          exportedAt: new Date().toISOString(),
          format,
          dataTypes,
          recordCounts: this._countRecords(userData)
        },
        data: userData
      };
      
      // 4. 格式化转换
      const formatter = this.formatters.get(format);
      const formatted = await formatter.format(exportData);
      
      // 5. 检查文件大小
      const fileSize = Buffer.isBuffer(formatted) ? formatted.length : Buffer.byteLength(formatted);
      if (fileSize > this.maxFileSize) {
        throw new Error(`Export file too large: ${fileSize} bytes (max: ${this.maxFileSize})`);
      }
      
      // 6. 可选加密
      let result = formatted;
      let encryptionKeyId = null;
      if (encrypt) {
        const encrypted = await this.encrypt(formatted);
        result = encrypted.data;
        encryptionKeyId = encrypted.keyId;
      }
      
      // 7. 可选签名
      let signature = null;
      if (sign) {
        signature = await this.sign(result);
      }
      
      // 8. 计算校验和
      const checksum = this.calculateChecksum(result);
      
      // 9. 保存到临时文件
      const fileName = `user-data-${userId}-${Date.now()}.${format}`;
      const filePath = path.join(this.tempDir, fileName);
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.writeFile(filePath, result);
      
      const duration = Date.now() - startTime;
      logger.info({ userId, format, fileSize, duration }, 'Data export completed');
      
      return {
        success: true,
        filePath,
        fileName,
        fileSize,
        format,
        checksum,
        encryptionKeyId,
        signature,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
      };
    } catch (error) {
      logger.error({ userId, format, error: error.message }, 'Data export failed');
      throw error;
    }
  }

  /**
   * 加密数据
   * @param {Buffer|string} data - 待加密数据
   * @returns {object} 加密结果
   */
  async encrypt(data) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    const keyId = crypto.randomBytes(16).toString('hex');
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    
    // 返回 IV + 加密数据
    const result = Buffer.concat([iv, encrypted]);
    
    return {
      data: result,
      keyId
    };
  }

  /**
   * 解密数据
   * @param {Buffer} encryptedData - 加密数据
   * @returns {Buffer} 解密后的数据
   */
  async decrypt(encryptedData) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    const iv = encryptedData.slice(0, 16);
    const encrypted = encryptedData.slice(16);
    const key = crypto.scryptSync(this.encryptionKey, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * 签名数据
   * @param {Buffer|string} data - 待签名数据
   * @returns {string} 签名
   */
  async sign(data) {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not configured');
    }
    
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const signature = crypto
      .createHmac('sha256', this.encryptionKey)
      .update(buffer)
      .digest('hex');
    
    return `sha256:${signature}`;
  }

  /**
   * 验证签名
   * @param {Buffer|string} data - 原始数据
   * @param {string} signature - 签名
   * @returns {boolean} 验证结果
   */
  async verify(data, signature) {
    const expectedSignature = await this.sign(data);
    return signature === expectedSignature;
  }

  /**
   * 计算校验和
   * @param {Buffer|string} data - 数据
   * @returns {string} 校验和
   */
  calculateChecksum(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    return `sha256:${hash}`;
  }

  /**
   * 统计记录数
   * @param {object} data - 用户数据
   * @returns {object} 记录统计
   */
  _countRecords(data) {
    const counts = {};
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        counts[key] = value.length;
      } else if (value && typeof value === 'object') {
        counts[key] = 1;
      } else {
        counts[key] = value ? 1 : 0;
      }
    }
    return counts;
  }

  /**
   * 清理过期导出文件
   * @param {number} maxAgeHours - 最大保留时间（小时）
   */
  async cleanupExpired(maxAgeHours = 24) {
    const files = await fs.readdir(this.tempDir);
    const now = Date.now();
    let cleaned = 0;
    
    for (const file of files) {
      const filePath = path.join(this.tempDir, file);
      const stats = await fs.stat(filePath);
      const ageHours = (now - stats.mtimeMs) / (60 * 60 * 1000);
      
      if (ageHours > maxAgeHours) {
        await fs.unlink(filePath);
        cleaned++;
      }
    }
    
    logger.info({ cleaned, maxAgeHours }, 'Cleaned up expired export files');
    return cleaned;
  }
}

module.exports = DataExporter;
