/**
 * 错误上下文快照管理器
 * 
 * 功能：
 * - 保存错误发生时的完整上下文
 * - 敏感信息脱敏
 * - 快照生命周期管理
 * - 快照查询与导出
 * 
 * @module ErrorContextSnapshot
 */

const crypto = require('crypto');
const logger = require('../logger');
const redis = require('../redis');

class ErrorContextSnapshot {
  constructor(config = {}) {
    this.retentionMs = config.retentionMs || 604800000; // 7天
    this.maxSnapshotsPerGroup = config.maxSnapshotsPerGroup || 10;
    this.sensitiveFields = config.sensitiveFields || [
      'password',
      'passwordHash',
      'token',
      'accessToken',
      'refreshToken',
      'apiKey',
      'secret',
      'creditCard',
      'cardNumber',
      'cvv',
      'ssn',
      'idNumber'
    ];
    
    this.snapshotPrefix = 'error:snapshot:';
    this.groupSnapshotsPrefix = 'error:group:';
  }

  /**
   * 保存错误上下文快照
   * @param {Object} errorEvent - 错误事件
   * @param {Object} context - 上下文信息
   * @returns {string} 快照ID
   */
  async save(errorEvent, context = {}) {
    try {
      const snapshot = {
        id: this._generateId(),
        groupId: errorEvent.groupId || null,
        timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.retentionMs).toISOString(),
        
        error: {
          name: errorEvent.errorName || errorEvent.name,
          code: errorEvent.errorCode || errorEvent.code,
          message: errorEvent.message,
          stack: this._truncateStack(errorEvent.stackTrace || errorEvent.stack)
        },
        
        request: context.request ? this._sanitizeRequest(context.request) : null,
        user: context.user ? this._extractUserInfo(context.user) : null,
        trace: context.trace ? this._extractTraceInfo(context.trace) : null,
        
        environment: {
          serviceVersion: process.env.SERVICE_VERSION || 'unknown',
          nodeEnv: process.env.NODE_ENV || 'development',
          hostname: process.env.HOSTNAME || process.env.HOST || 'unknown',
          region: process.env.REGION || 'unknown',
          nodeId: process.env.NODE_ID || 'unknown'
        },
        
        system: await this._collectSystemMetrics(),
        
        customData: context.customData || {}
      };
      
      // 保存到 Redis
      const key = `${this.snapshotPrefix}${snapshot.id}`;
      await redis.setex(
        key,
        Math.floor(this.retentionMs / 1000),
        JSON.stringify(snapshot)
      );
      
      // 关联到聚合组
      if (errorEvent.groupId) {
        await this._associateWithGroup(snapshot.id, errorEvent.groupId);
      }
      
      logger.debug('Error snapshot saved', {
        snapshotId: snapshot.id,
        groupId: errorEvent.groupId
      });
      
      return snapshot.id;
    } catch (error) {
      logger.error('Failed to save error snapshot', {
        error: error.message,
        event: errorEvent
      });
      throw error;
    }
  }

  /**
   * 获取快照详情
   * @param {string} snapshotId - 快照ID
   * @returns {Object|null} 快照详情
   */
  async get(snapshotId) {
    try {
      const key = `${this.snapshotPrefix}${snapshotId}`;
      const data = await redis.get(key);
      
      if (!data) {
        return null;
      }
      
      return JSON.parse(data);
    } catch (error) {
      logger.error('Failed to get snapshot', {
        error: error.message,
        snapshotId
      });
      return null;
    }
  }

  /**
   * 获取聚合组的快照列表
   * @param {string} groupId - 聚合组ID
   * @param {Object} options - 查询选项
   * @returns {Array} 快照列表
   */
  async getGroupSnapshots(groupId, options = {}) {
    try {
      const key = `${this.groupSnapshotsPrefix}${groupId}:snapshots`;
      const snapshotIds = await redis.lrange(key, 0, (options.limit || 10) - 1);
      
      const snapshots = [];
      for (const snapshotId of snapshotIds) {
        const snapshot = await this.get(snapshotId);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }
      
      return snapshots;
    } catch (error) {
      logger.error('Failed to get group snapshots', {
        error: error.message,
        groupId
      });
      return [];
    }
  }

  /**
   * 删除快照
   * @param {string} snapshotId - 快照ID
   * @returns {boolean} 是否成功
   */
  async delete(snapshotId) {
    try {
      const snapshot = await this.get(snapshotId);
      
      if (!snapshot) {
        return false;
      }
      
      // 从聚合组列表中移除
      if (snapshot.groupId) {
        const key = `${this.groupSnapshotsPrefix}${snapshot.groupId}:snapshots`;
        await redis.lrem(key, 0, snapshotId);
      }
      
      // 删除快照
      await redis.del(`${this.snapshotPrefix}${snapshotId}`);
      
      return true;
    } catch (error) {
      logger.error('Failed to delete snapshot', {
        error: error.message,
        snapshotId
      });
      return false;
    }
  }

  /**
   * 关联快照到聚合组
   * @param {string} snapshotId - 快照ID
   * @param {string} groupId - 聚合组ID
   */
  async _associateWithGroup(snapshotId, groupId) {
    const key = `${this.groupSnapshotsPrefix}${groupId}:snapshots`;
    
    // 添加到列表
    await redis.lpush(key, snapshotId);
    
    // 限制列表长度
    await redis.ltrim(key, 0, this.maxSnapshotsPerGroup - 1);
  }

  /**
   * 敏感信息脱敏
   * @param {Object} request - 请求对象
   * @returns {Object} 脱敏后的请求
   */
  _sanitizeRequest(request) {
    const sanitized = {
      method: request.method,
      url: this._sanitizeUrl(request.url),
      path: request.path,
      query: this._sanitizeObject(request.query),
      headers: this._sanitizeHeaders(request.headers),
      body: this._sanitizeObject(request.body),
      params: this._sanitizeObject(request.params),
      ip: this._sanitizeIp(request.ip)
    };
    
    return sanitized;
  }

  /**
   * 脱敏 URL
   * @param {string} url - 原始 URL
   * @returns {string} 脱敏后的 URL
   */
  _sanitizeUrl(url) {
    if (!url) return '';
    
    // 移除 URL 中的敏感参数
    return url.replace(/([?&])(token|key|secret|password)=[^&]*/gi, '$1$2=***REDACTED***');
  }

  /**
   * 脱敏对象
   * @param {Object} obj - 原始对象
   * @returns {Object} 脱敏后的对象
   */
  _sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    
    const sanitized = {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (this.sensitiveFields.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      )) {
        sanitized[key] = '***REDACTED***';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this._sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * 脱敏请求头
   * @param {Object} headers - 原始请求头
   * @returns {Object} 脱敏后的请求头
   */
  _sanitizeHeaders(headers) {
    if (!headers) return {};
    
    const sanitized = {};
    const sensitiveHeaders = [
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'x-auth-token'
    ];
    
    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * 脱敏 IP 地址
   * @param {string} ip - 原始 IP
   * @returns {string} 脱敏后的 IP
   */
  _sanitizeIp(ip) {
    if (!ip) return '';
    
    // IPv4: 保留前三段
    if (ip.includes('.')) {
      return ip.replace(/\.\d+$/, '.***');
    }
    
    // IPv6: 保留前三组
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return parts.slice(0, 3).join(':') + '::***';
    }
    
    return ip;
  }

  /**
   * 提取用户信息
   * @param {Object} user - 用户对象
   * @returns {Object} 用户信息
   */
  _extractUserInfo(user) {
    if (!user) return null;
    
    return {
      id: user.id || user.userId || 'unknown',
      email: user.email ? this._sanitizeEmail(user.email) : null,
      name: user.name || null,
      level: user.level || null,
      role: user.role || null,
      locale: user.locale || null,
      deviceType: user.deviceType || null,
      appVersion: user.appVersion || null,
      lastLoginAt: user.lastLoginAt || null
    };
  }

  /**
   * 脱敏邮箱
   * @param {string} email - 原始邮箱
   * @returns {string} 脱敏后的邮箱
   */
  _sanitizeEmail(email) {
    if (!email || !email.includes('@')) return email;
    
    const [localPart, domain] = email.split('@');
    const sanitizedLocal = localPart.substring(0, 2) + '***';
    
    return `${sanitizedLocal}@${domain}`;
  }

  /**
   * 提取追踪信息
   * @param {Object} trace - 追踪对象
   * @returns {Object} 追踪信息
   */
  _extractTraceInfo(trace) {
    if (!trace) return null;
    
    return {
      traceId: trace.traceId || null,
      spanId: trace.spanId || null,
      parentSpanId: trace.parentSpanId || null,
      sampled: trace.sampled || false
    };
  }

  /**
   * 收集系统指标
   * @returns {Object} 系统指标
   */
  async _collectSystemMetrics() {
    const metrics = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.floor(process.uptime()),
      memory: {
        rss: Math.floor(process.memoryUsage().rss / 1024 / 1024),
        heapTotal: Math.floor(process.memoryUsage().heapTotal / 1024 / 1024),
        heapUsed: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
        external: Math.floor(process.memoryUsage().external / 1024 / 1024)
      },
      cpu: {
        usage: process.cpuUsage()
      }
    };
    
    return metrics;
  }

  /**
   * 截断堆栈信息
   * @param {string} stack - 原始堆栈
   * @param {number} maxLength - 最大长度
   * @returns {string} 截断后的堆栈
   */
  _truncateStack(stack, maxLength = 5000) {
    if (!stack) return '';
    
    if (stack.length <= maxLength) {
      return stack;
    }
    
    return stack.substring(0, maxLength) + '\n... (truncated)';
  }

  /**
   * 生成快照ID
   * @returns {string} 快照ID
   */
  _generateId() {
    return `snap-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  }

  /**
   * 导出快照为 JSON
   * @param {string} snapshotId - 快照ID
   * @returns {string|null} JSON 字符串
   */
  async exportAsJson(snapshotId) {
    const snapshot = await this.get(snapshotId);
    
    if (!snapshot) {
      return null;
    }
    
    return JSON.stringify(snapshot, null, 2);
  }

  /**
   * 清理过期快照
   */
  async cleanup() {
    logger.info('Snapshot cleanup started');
    
    // 由于使用了 Redis TTL，快照会自动过期
    // 此方法可用于手动清理或验证
    
    logger.info('Snapshot cleanup completed');
  }
}

module.exports = ErrorContextSnapshot;