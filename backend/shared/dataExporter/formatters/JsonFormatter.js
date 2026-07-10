/**
 * REQ-00527: JSON 格式化器
 * 将用户数据转换为标准 JSON 格式
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);

class JsonFormatter {
  constructor() {
    this.name = 'json';
    this.mimeType = 'application/json';
    this.supportsCompression = true;
  }

  /**
   * 格式化数据
   * @param {object} data - 用户数据
   * @returns {Buffer} JSON 格式的数据
   */
  async format(data) {
    // 标准化 JSON 结构
    const standardized = {
      export: {
        version: data.export.version || '1.0',
        userId: data.export.userId,
        exportedAt: data.export.exportedAt,
        format: 'json',
        dataTypes: data.export.dataTypes,
        recordCounts: data.export.recordCounts,
        checksum: '', // 在 DataExporter 中计算
        schema: 'https://schema.minego.io/export/v1.0.json'
      },
      data: data.data,
      metadata: {
        generator: 'mineGo Data Exporter',
        generatorVersion: '1.0.0',
        compliance: {
          gdpr: true,
          ccpa: true,
          standard: 'ISO/IEC 27001'
        },
        rights: {
          'GDPR Article 20': 'Right to data portability',
          'GDPR Article 15': 'Right of access by the data subject'
        }
      }
    };

    // 转换为 JSON
    const jsonString = JSON.stringify(standardized, null, 2);
    
    return Buffer.from(jsonString, 'utf-8');
  }

  /**
   * 解析 JSON 数据
   * @param {Buffer|string} data - JSON 数据
   * @returns {object} 解析后的数据
   */
  async parse(data) {
    const jsonString = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
    return JSON.parse(jsonString);
  }

  /**
   * 验证 JSON 结构
   * @param {object} data - JSON 数据
   * @returns {boolean} 验证结果
   */
  validate(data) {
    if (!data || typeof data !== 'object') return false;
    
    // 验证必需字段
    const requiredFields = ['export', 'data'];
    for (const field of requiredFields) {
      if (!data[field]) return false;
    }
    
    // 验证 export 结构
    if (!data.export.version || !data.export.userId) return false;
    
    return true;
  }

  /**
   * 获取格式描述
   */
  getDescription() {
    return {
      name: this.name,
      mimeType: this.mimeType,
      description: 'Machine-readable JSON format, ideal for data migration',
      useCase: 'Recommended for transferring data to another platform',
      advantages: [
        'Standard format',
        'Easy to parse',
        'Preserves data structure',
        'Supports nested objects'
      ],
      limitations: [
        'Large file size for big datasets',
        'Not human-friendly for manual review'
      ],
      compliance: {
        gdpr: true,
        ccpa: true
      }
    };
  }
}

module.exports = JsonFormatter;