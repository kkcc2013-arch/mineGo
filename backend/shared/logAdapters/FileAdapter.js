/**
 * 文件输出适配器
 * 输出日志到本地文件，支持日志轮转
 */
'use strict';

const ILogOutputAdapter = require('./ILogOutputAdapter');
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);

class FileAdapter extends ILogOutputAdapter {
  constructor() {
    super('file');
    this.filePath = null;
    this.currentSize = 0;
    this.currentFile = null;
    this.writeStream = null;
  }

  async initialize(config) {
    await super.initialize(config);
    
    if (!config.path) {
      throw new Error('FileAdapter requires "path" configuration');
    }
    
    this.filePath = config.path;
    this.maxSize = this.parseSize(config.maxSize || '100MB');
    this.maxFiles = config.maxFiles || 10;
    this.compress = config.compress !== false;
    
    // 确保日志目录存在
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    
    // 打开当前日志文件
    await this.openFile();
    
    this.healthStatus = 'healthy';
  }

  async openFile() {
    if (this.writeStream) {
      await this.closeStream();
    }
    
    this.currentFile = this.filePath;
    
    try {
      const stats = await fs.stat(this.filePath);
      this.currentSize = stats.size;
    } catch {
      this.currentSize = 0;
    }
    
    this.writeStream = fs.createWriteStream(this.filePath, {
      flags: 'a',
      encoding: 'utf8'
    });
    
    this.writeStream.on('error', (err) => {
      console.error(`[FileAdapter] Write stream error:`, err);
      this.healthStatus = 'error';
    });
  }

  async closeStream() {
    return new Promise((resolve) => {
      if (this.writeStream) {
        this.writeStream.end(() => {
          this.writeStream = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async write(logEntry) {
    if (!this.initialized || !this.writeStream) {
      throw new Error('FileAdapter not initialized or stream closed');
    }
    
    const formatted = this.formatEntry(logEntry);
    const line = JSON.stringify(formatted) + '\n';
    const size = Buffer.byteLength(line, 'utf8');
    
    // 检查是否需要轮转
    if (this.currentSize + size > this.maxSize) {
      await this.rotate();
    }
    
    return new Promise((resolve, reject) => {
      this.writeStream.write(line, (err) => {
        if (err) {
          reject(err);
        } else {
          this.currentSize += size;
          resolve();
        }
      });
    });
  }

  async writeBatch(logEntries) {
    const lines = logEntries.map(entry => JSON.stringify(this.formatEntry(entry)) + '\n');
    const data = lines.join('');
    
    // 检查是否需要轮转
    const size = Buffer.byteLength(data, 'utf8');
    if (this.currentSize + size > this.maxSize) {
      await this.rotate();
    }
    
    return new Promise((resolve, reject) => {
      this.writeStream.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          this.currentSize += size;
          resolve();
        }
      });
    });
  }

  async rotate() {
    await this.closeStream();
    
    // 压缩并移动旧文件
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const oldPath = `${this.filePath}.${i}${this.compress ? '.gz' : ''}`;
      const newPath = `${this.filePath}.${i + 1}${this.compress ? '.gz' : ''}`;
      
      try {
        await fs.access(oldPath);
        if (i === this.maxFiles - 1) {
          await fs.unlink(oldPath);
        } else {
          await fs.rename(oldPath, newPath);
        }
      } catch {
        // 文件不存在，跳过
      }
    }
    
    // 压缩当前文件并移动
    if (this.compress) {
      try {
        const content = await fs.readFile(this.filePath);
        const compressed = await gzip(content);
        await fs.writeFile(`${this.filePath}.1.gz`, compressed);
        await fs.unlink(this.filePath);
      } catch (err) {
        console.error(`[FileAdapter] Compression error:`, err);
      }
    } else {
      try {
        await fs.rename(this.filePath, `${this.filePath}.1`);
      } catch {
        // 文件不存在，跳过
      }
    }
    
    // 打开新文件
    await this.openFile();
  }

  parseSize(sizeStr) {
    const units = { 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB)?$/i);
    
    if (!match) return parseInt(sizeStr) || 100 * 1024 * 1024;
    
    const value = parseFloat(match[1]);
    const unit = (match[2] || '').toUpperCase();
    
    return value * (units[unit] || 1);
  }

  async close() {
    await super.close();
    await this.closeStream();
    this.healthStatus = 'closed';
  }

  async healthCheck() {
    const base = await super.healthCheck();
    
    let fileStats = null;
    try {
      fileStats = await fs.stat(this.filePath);
    } catch {
      // 文件不存在
    }
    
    return {
      ...base,
      status: this.writeStream && fileStats ? 'healthy' : 'unhealthy',
      details: {
        file: this.currentFile,
        currentSize: this.currentSize,
        maxSize: this.maxSize,
        usage: `${((this.currentSize / this.maxSize) * 100).toFixed(2)}%`
      }
    };
  }
}

module.exports = FileAdapter;
