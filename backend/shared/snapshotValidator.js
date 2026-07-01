/**
 * API 快照验证器
 * 用于捕获、比对和验证 API 响应结构
 */

const fs = require('fs');
const path = require('path');

class ApiSnapshotValidator {
  constructor(config = {}) {
    this.snapshotDir = config.snapshotDir || path.join(__dirname, '../tests/snapshots');
    this.autoUpdate = config.autoUpdate || false;
    this.ignoreFields = config.ignoreFields || [
      'timestamp',
      'reqId',
      'requestId',
      'traceId',
      'sessionId',
      'createdAt',
      'updatedAt',
      'token',
      'accessToken',
      'refreshToken'
    ];
    this.ignorePatterns = config.ignorePatterns || [
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO dates
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i, // UUIDs
      /^pk_\d+$/, // Pokemon IDs
      /^user_\d+$/ // User IDs
    ];
  }

  /**
   * 获取快照文件路径
   */
  getSnapshotPath(apiPath, method) {
    const safeName = apiPath
      .replace(/^\//, '')
      .replace(/\//g, '-')
      .replace(/:/g, '_')
      .replace(/\{/g, '_')
      .replace(/\}/g, '');
    return path.join(this.snapshotDir, method.toUpperCase(), `${safeName}.json`);
  }

  /**
   * 提取 API 版本
   */
  extractApiVersion(apiPath) {
    const match = apiPath.match(/\/api\/(v\d+)/);
    return match ? match[1] : 'v1';
  }

  /**
   * 清理动态字段
   */
  sanitizeDynamicFields(obj, depth = 0) {
    if (depth > 20) return obj; // 防止无限递归
    if (obj === null || obj === undefined) return obj;
    
    if (Array.isArray(obj)) {
      if (obj.length === 0) return obj;
      // 只保留第一个元素的结构作为模板
      return [this.sanitizeDynamicFields(obj[0], depth + 1)];
    }
    
    if (typeof obj === 'object') {
      const sanitized = {};
      for (const key of Object.keys(obj)) {
        // 跳过忽略字段
        if (this.ignoreFields.includes(key)) {
          sanitized[key] = '<DYNAMIC>';
          continue;
        }
        
        const value = obj[key];
        
        // 检查是否匹配忽略模式
        if (typeof value === 'string') {
          for (const pattern of this.ignorePatterns) {
            if (pattern.test(value)) {
              sanitized[key] = '<DYNAMIC>';
              continue;
            }
          }
          if (sanitized[key] === '<DYNAMIC>') continue;
        }
        
        sanitized[key] = this.sanitizeDynamicFields(value, depth + 1);
      }
      return sanitized;
    }
    
    return obj;
  }

  /**
   * 捕获 API 响应快照
   */
  async captureSnapshot(apiPath, method, response, statusCode = 200) {
    const snapshotPath = this.getSnapshotPath(apiPath, method);
    const snapshotDir = path.dirname(snapshotPath);
    
    // 确保目录存在
    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }
    
    const sanitizedResponse = this.sanitizeDynamicFields(response);
    
    const snapshot = {
      metadata: {
        apiPath,
        method: method.toUpperCase(),
        statusCode,
        capturedAt: new Date().toISOString(),
        version: this.extractApiVersion(apiPath),
        validatorVersion: '1.0.0'
      },
      response: sanitizedResponse
    };
    
    await fs.promises.writeFile(
      snapshotPath,
      JSON.stringify(snapshot, null, 2),
      'utf-8'
    );
    
    return {
      status: 'captured',
      path: snapshotPath,
      snapshot
    };
  }

  /**
   * 获取对象类型
   */
  getType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * 深度差异计算
   */
  computeDeepDiff(expected, actual, path = '') {
    const diffs = [];
    
    // 处理数组差异
    if (Array.isArray(expected) && Array.isArray(actual)) {
      // 数组长度差异
      if (expected.length !== actual.length) {
        diffs.push({
          type: 'array_length_mismatch',
          path: path || 'root',
          expectedLength: expected.length,
          actualLength: actual.length
        });
      }
      
      // 比较第一个元素（模板）
      if (expected.length > 0 && actual.length > 0) {
        diffs.push(...this.computeDeepDiff(expected[0], actual[0], path ? `${path}[0]` : '[0]'));
      }
      
      return diffs;
    }
    
    // 非对象类型直接比较
    if (typeof expected !== 'object' || typeof actual !== 'object') {
      if (expected !== actual && expected !== '<DYNAMIC>') {
        diffs.push({
          type: 'value_mismatch',
          path: path || 'root',
          expected,
          actual
        });
      }
      return diffs;
    }
    
    // 字段缺失检测
    for (const key in expected) {
      const fieldPath = path ? `${path}.${key}` : key;
      
      if (!(key in actual)) {
        diffs.push({
          type: 'field_missing',
          path: fieldPath,
          expected: expected[key],
          actual: undefined
        });
      }
    }
    
    // 字段新增检测
    for (const key in actual) {
      const fieldPath = path ? `${path}.${key}` : key;
      
      if (!(key in expected)) {
        diffs.push({
          type: 'field_added',
          path: fieldPath,
          expected: undefined,
          actual: actual[key]
        });
      }
    }
    
    // 类型不匹配检测
    for (const key in expected) {
      if (key in actual) {
        const fieldPath = path ? `${path}.${key}` : key;
        const expectedType = this.getType(expected[key]);
        const actualType = this.getType(actual[key]);
        
        if (expectedType !== actualType && expected[key] !== '<DYNAMIC>') {
          diffs.push({
            type: 'type_mismatch',
            path: fieldPath,
            expectedType,
            actualType
          });
        } else if (expectedType === 'object' && expected[key] !== '<DYNAMIC>') {
          diffs.push(...this.computeDeepDiff(expected[key], actual[key], fieldPath));
        } else if (expectedType === 'array' && expected[key] !== '<DYNAMIC>') {
          diffs.push(...this.computeDeepDiff(expected[key], actual[key], fieldPath));
        }
      }
    }
    
    return diffs;
  }

  /**
   * 比对快照
   */
  async compareSnapshot(apiPath, method, currentResponse, statusCode = 200) {
    const snapshotPath = this.getSnapshotPath(apiPath, method);
    
    // 快照不存在
    if (!fs.existsSync(snapshotPath)) {
      if (this.autoUpdate) {
        return await this.captureSnapshot(apiPath, method, currentResponse, statusCode);
      }
      
      return {
        status: 'missing',
        message: '快照不存在，需要首次捕获',
        path: snapshotPath,
        suggestion: '运行 npm run test:snapshot -- --update 捕获快照'
      };
    }
    
    // 读取存储的快照
    const storedSnapshot = JSON.parse(await fs.promises.readFile(snapshotPath, 'utf-8'));
    const sanitizedCurrent = this.sanitizeDynamicFields(currentResponse);
    
    // 计算差异
    const diff = this.computeDeepDiff(storedSnapshot.response, sanitizedCurrent);
    
    if (diff.length === 0) {
      return {
        status: 'match',
        message: '快照匹配成功',
        path: snapshotPath
      };
    }
    
    // 存在差异
    return {
      status: 'diff',
      message: '快照不匹配，API 响应结构发生变化',
      path: snapshotPath,
      diff,
      storedSnapshot,
      currentResponse: sanitizedCurrent,
      diffCount: diff.length,
      breakingChanges: diff.filter(d => 
        d.type === 'field_missing' || d.type === 'type_mismatch'
      ).length
    };
  }

  /**
   * 更新快照
   */
  async updateSnapshot(apiPath, method, response, statusCode = 200) {
    return await this.captureSnapshot(apiPath, method, response, statusCode);
  }

  /**
   * 删除快照
   */
  async deleteSnapshot(apiPath, method) {
    const snapshotPath = this.getSnapshotPath(apiPath, method);
    
    if (fs.existsSync(snapshotPath)) {
      await fs.promises.unlink(snapshotPath);
      return { status: 'deleted', path: snapshotPath };
    }
    
    return { status: 'not_found', path: snapshotPath };
  }

  /**
   * 列出所有快照
   */
  async listSnapshots() {
    const snapshots = [];
    
    if (!fs.existsSync(this.snapshotDir)) {
      return snapshots;
    }
    
    const methods = fs.readdirSync(this.snapshotDir);
    
    for (const method of methods) {
      const methodDir = path.join(this.snapshotDir, method);
      if (fs.statSync(methodDir).isDirectory()) {
        const files = fs.readdirSync(methodDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const snapshotPath = path.join(methodDir, file);
            try {
              const snapshot = JSON.parse(await fs.promises.readFile(snapshotPath, 'utf-8'));
              snapshots.push({
                path: snapshotPath,
                apiPath: snapshot.metadata?.apiPath || file.replace('.json', ''),
                method: snapshot.metadata?.method || method,
                capturedAt: snapshot.metadata?.capturedAt,
                version: snapshot.metadata?.version
              });
            } catch (e) {
              // 跳过无效的快照文件
            }
          }
        }
      }
    }
    
    return snapshots;
  }

  /**
   * 获取快照覆盖率统计
   */
  async getCoverageStats(openApiSpec = null) {
    const snapshots = await this.listSnapshots();
    
    const stats = {
      totalSnapshots: snapshots.length,
      byMethod: {},
      byVersion: {},
      apis: snapshots.map(s => s.apiPath)
    };
    
    // 按方法统计
    for (const snapshot of snapshots) {
      const method = snapshot.method || 'UNKNOWN';
      stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
    }
    
    // 按版本统计
    for (const snapshot of snapshots) {
      const version = snapshot.version || 'unknown';
      stats.byVersion[version] = (stats.byVersion[version] || 0) + 1;
    }
    
    return stats;
  }
}

module.exports = { ApiSnapshotValidator };
