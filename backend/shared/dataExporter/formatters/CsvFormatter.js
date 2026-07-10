/**
 * REQ-00527: CSV 格式化器
 * 将用户数据转换为 CSV 格式（每种数据类型单独文件）
 */

class CsvFormatter {
  constructor() {
    this.name = 'csv';
    this.mimeType = 'text/csv';
    this.supportsCompression = true;
  }

  /**
   * 格式化数据
   * @param {object} data - 用户数据
   * @returns {Buffer} CSV 格式的数据（多文件合并）
   */
  async format(data) {
    const csvFiles = [];
    
    // 为每种数据类型生成 CSV
    for (const [type, records] of Object.entries(data.data)) {
      if (records && !records.error) {
        const csv = this._generateCsv(type, records);
        csvFiles.push({
          type,
          filename: `${type}.csv`,
          content: csv
        });
      }
    }
    
    // 如果只有一个文件，直接返回
    if (csvFiles.length === 1) {
      return Buffer.from(csvFiles[0].content, 'utf-8');
    }
    
    // 多个文件时，生成目录索引
    const index = this._generateIndex(csvFiles);
    
    // 合并所有 CSV（用分隔符分隔）
    const combined = csvFiles.map(f => 
      `=== ${f.filename} ===\n${f.content}`
    ).join('\n\n');
    
    const fullContent = `# User Data Export - CSV Format\n\n${index}\n\n${combined}`;
    
    return Buffer.from(fullContent, 'utf-8');
  }

  /**
   * 生成单类型 CSV
   * @param {string} type - 数据类型
   * @param {Array|Object} records - 数据记录
   * @returns {string} CSV 内容
   */
  _generateCsv(type, records) {
    if (!records) return '';
    
    // 单对象（如 profile）
    if (!Array.isArray(records)) {
      const fields = Object.keys(records);
      const values = Object.values(records);
      
      const header = this._csvRow(fields);
      const row = this._csvRow(values);
      
      return `${header}\n${row}`;
    }
    
    // 数组数据
    if (records.length === 0) return `${type}_id,no_data`;
    
    // 提取所有字段名
    const allFields = new Set();
    for (const record of records) {
      for (const field of Object.keys(record)) {
        allFields.add(field);
      }
    }
    
    const fields = Array.from(allFields);
    const header = this._csvRow(fields);
    
    // 生成数据行
    const rows = records.map(record => {
      const values = fields.map(field => {
        const value = record[field];
        
        // 处理特殊类型
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return value;
      });
      
      return this._csvRow(values);
    });
    
    return `${header}\n${rows.join('\n')}`;
  }

  /**
   * 生成 CSV 行
   * @param {Array} values - 值数组
   * @returns {string} CSV 行
   */
  _csvRow(values) {
    return values.map(v => {
      if (v === null || v === undefined) return '';
      
      const str = String(v);
      
      // 需要引号的情况
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      
      return str;
    }).join(',');
  }

  /**
   * 生成目录索引
   * @param {Array} files - 文件列表
   * @returns {string} 索引内容
   */
  _generateIndex(files) {
    const lines = files.map(f => `- ${f.filename}: ${f.type} data`);
    
    return `## File Index\n${lines.join('\n')}`;
  }

  /**
   * 获取格式描述
   */
  getDescription() {
    return {
      name: this.name,
      mimeType: this.mimeType,
      description: 'Tabular format suitable for spreadsheet analysis',
      useCase: 'Ideal for manual data review in Excel or Google Sheets',
      advantages: [
        'Human-readable in spreadsheets',
        'Easy to filter and sort',
        'Compatible with Excel/Google Sheets',
        'Small file size for simple data'
      ],
      limitations: [
        'No support for nested objects',
        'Multiple files for different data types',
        'Loss of structure for complex data'
      ],
      compliance: {
        gdpr: true,
        ccpa: true
      }
    };
  }
}

module.exports = CsvFormatter;