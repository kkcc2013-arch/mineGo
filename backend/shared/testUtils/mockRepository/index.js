// backend/shared/testUtils/mockRepository/index.js
'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logger');

const logger = createLogger('mock-repository');

/**
 * Mock 数据仓库
 * 集中管理所有测试数据，支持：
 * - 加载 fixtures 文件
 * - 缓存数据
 * - 深拷贝和覆盖
 * - 版本管理
 */
class MockRepository {
  constructor(config = {}) {
    this.dataDir = config.dataDir || path.join(__dirname, '../../../fixtures');
    this.cache = new Map();
    this.metadata = new Map();
    this.loadAllFixtures();
  }

  /**
   * 加载所有 fixtures 文件
   */
  loadAllFixtures() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      logger.info('Created fixtures directory');
      return;
    }

    const categories = fs.readdirSync(this.dataDir);
    let totalFiles = 0;
    
    for (const category of categories) {
      const categoryPath = path.join(this.dataDir, category);
      if (fs.statSync(categoryPath).isDirectory()) {
        totalFiles += this.loadCategory(category, categoryPath);
      }
    }
    
    logger.info({ categories: categories.length, files: totalFiles }, 'Fixtures loaded');
  }

  /**
   * 加载单个类别的 fixtures
   */
  loadCategory(category, categoryPath) {
    const files = fs.readdirSync(categoryPath);
    let loaded = 0;
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(categoryPath, file);
        const key = `${category}:${path.basename(file, '.json')}`;
        
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(content);
          this.cache.set(key, data);
          
          // 保存元数据（版本、创建时间等）
          this.metadata.set(key, {
            path: filePath,
            loadedAt: new Date().toISOString(),
            size: Buffer.byteLength(content, 'utf8')
          });
          
          loaded++;
        } catch (err) {
          logger.error({ file: filePath, error: err.message }, 'Failed to load fixture');
        }
      }
    }
    
    return loaded;
  }

  /**
   * 获取 Mock 数据
   * @param {string} key - 格式: category:name
   * @param {object} overrides - 覆盖字段
   * @returns {object} Mock 数据副本
   */
  get(key, overrides = {}) {
    if (!this.cache.has(key)) {
      throw new Error(`Mock data not found: ${key}. Available keys: ${this.list().slice(0, 10).join(', ')}`);
    }
    
    const data = this.cache.get(key);
    
    // 深拷贝避免污染原数据
    const copy = this.deepClone(data);
    
    // 应用覆盖
    return this.deepMerge(copy, overrides);
  }

  /**
   * 获取 Mock 数据数组（批量生成）
   * @param {string} key - base key
   * @param {number} count - 生成数量
   * @param {array} overrides - 每个元素的覆盖
   * @returns {array} Mock 数据数组
   */
  getMany(key, count, overrides = []) {
    if (!this.cache.has(key)) {
      throw new Error(`Mock data not found: ${key}`);
    }

    const results = [];
    for (let i = 0; i < count; i++) {
      const copy = this.deepClone(this.cache.get(key));
      const override = overrides[i] || {};
      results.push(this.deepMerge(copy, override));
    }
    
    return results;
  }

  /**
   * 设置 Mock 数据
   * @param {string} key - 格式: category:name
   * @param {object} data - Mock 数据
   */
  set(key, data) {
    const [category, name] = key.split(':');
    
    if (!category || !name) {
      throw new Error('Key must be format: category:name');
    }

    // 确保目录存在
    const categoryPath = path.join(this.dataDir, category);
    if (!fs.existsSync(categoryPath)) {
      fs.mkdirSync(categoryPath, { recursive: true });
    }

    // 写入文件
    const filePath = path.join(categoryPath, `${name}.json`);
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, content, 'utf8');
    
    // 更新缓存和元数据
    this.cache.set(key, data);
    this.metadata.set(key, {
      path: filePath,
      loadedAt: new Date().toISOString(),
      size: Buffer.byteLength(content, 'utf8')
    });
    
    logger.info({ key, size: Buffer.byteLength(content, 'utf8') }, 'Mock data saved');
  }

  /**
   * 删除 Mock 数据
   * @param {string} key
   */
  delete(key) {
    if (!this.cache.has(key)) {
      return false;
    }
    
    const meta = this.metadata.get(key);
    if (meta && meta.path && fs.existsSync(meta.path)) {
      fs.unlinkSync(meta.path);
    }
    
    this.cache.delete(key);
    this.metadata.delete(key);
    
    logger.info({ key }, 'Mock data deleted');
    return true;
  }

  /**
   * 列出所有可用的 Mock 数据
   * @param {string} category - 可选，过滤特定类别
   * @returns {array} keys
   */
  list(category = null) {
    const keys = Array.from(this.cache.keys());
    
    if (category) {
      return keys.filter(k => k.startsWith(`${category}:`));
    }
    
    return keys;
  }

  /**
   * 获取 Mock 数据元数据
   * @param {string} key
   * @returns {object} metadata
   */
  getMetadata(key) {
    return this.metadata.get(key);
  }

  /**
   * 深度克隆对象
   */
  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.deepClone(item));
    }
    
    const clone = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clone[key] = this.deepClone(obj[key]);
      }
    }
    
    return clone;
  }

  /**
   * 深度合并对象
   */
  deepMerge(target, source) {
    if (!source || typeof source !== 'object') {
      return target;
    }
    
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key] || typeof target[key] !== 'object') {
          target[key] = {};
        }
        target[key] = this.deepMerge(target[key], source[key]);
      } else if (Array.isArray(source[key])) {
        target[key] = source[key].slice();
      } else {
        target[key] = source[key];
      }
    }
    
    return target;
  }

  /**
   * 重新加载所有 fixtures
   */
  reload() {
    this.cache.clear();
    this.metadata.clear();
    this.loadAllFixtures();
  }

  /**
   * 获取统计信息
   */
  stats() {
    return {
      totalKeys: this.cache.size,
      categories: this.list().map(k => k.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i),
      totalSize: Array.from(this.metadata.values()).reduce((sum, m) => sum + m.size, 0)
    };
  }
}

// 导出单例（便于测试时使用）
const createMockRepository = (config = {}) => new MockRepository(config);
const defaultRepository = new MockRepository();

module.exports = {
  MockRepository,
  createMockRepository,
  defaultRepository,
  mockRepo: defaultRepository
};