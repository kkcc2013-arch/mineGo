/**
 * REQ-00485: 用户数据导出频率限制中间件
 * 实现多层限流机制，防止滥用和数据泄露
 */

const crypto = require('crypto');

class ExportRateLimiter {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
    
    // 限制配置
    this.limits = {
      user: {
        maxRequests: 2,           // 每月最多2次
        windowSeconds: 30 * 24 * 3600  // 30天窗口
      },
      admin: {
        maxRequestsPerDay: 10,    // 每天最多10次批量导出
        maxUsersPerRequest: 1000  // 单次最多1000用户
      }
    };
  }

  /**
   * 检查用户导出限制
   * @param {number} userId - 用户ID
   * @returns {object} 限制检查结果
   */
  async checkUserExportLimit(userId) {
    const key = `export:user:${userId}`;
    const now = Date.now();
    const windowStart = now - this.limits.user.windowSeconds * 1000;
    
    // 获取窗口内的导出记录
    const exports = await this.redis.zrangebyscore(
      key,
      windowStart,
      '+inf',
      'WITHSCORES'
    );
    
    const count = exports.length / 2;
    
    if (count >= this.limits.user.maxRequests) {
      // 获取最早的导出时间，计算冷却时间
      const oldestExport = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const cooldownSeconds = Math.ceil(
        (this.limits.user.windowSeconds * 1000 - (now - parseInt(oldestExport[1]))) / 1000
      );
      
      return {
        allowed: false,
        reason: 'RATE_LIMIT_EXCEEDED',
        message: `本月导出次数已达上限，请${this._formatCooldown(cooldownSeconds)}后再试`,
        nextAvailableAt: new Date(now + cooldownSeconds * 1000).toISOString(),
        currentCount: count,
        maxCount: this.limits.user.maxRequests
      };
    }
    
    return {
      allowed: true,
      currentCount: count,
      maxCount: this.limits.user.maxRequests,
      remaining: this.limits.user.maxRequests - count
    };
  }

  /**
   * 记录导出操作
   * @param {number} userId - 用户ID
   * @param {string} requestId - 请求ID
   */
  async recordUserExport(userId, requestId) {
    const key = `export:user:${userId}`;
    const now = Date.now();
    
    // 添加导出记录到Redis
    await this.redis.zadd(key, now, requestId);
    
    // 设置过期时间
    await this.redis.expire(key, this.limits.user.windowSeconds);
    
    // 写入数据库审计日志
    try {
      await this.db.query(`
        INSERT INTO export_audit_log 
          (request_id, user_id, export_type, status, created_at)
        VALUES ($1, $2, 'user', 'initiated', NOW())
      `, [requestId, userId]);
    } catch (err) {
      // 如果表不存在，创建表
      await this._createAuditTableIfNeeded();
      await this.db.query(`
        INSERT INTO export_audit_log 
          (request_id, user_id, export_type, status, created_at)
        VALUES ($1, $2, 'user', 'initiated', NOW())
      `, [requestId, userId]);
    }
  }

  /**
   * 检查管理员批量导出限制
   * @param {number} adminId - 管理员ID
   * @param {number} userCount - 用户数量
   */
  async checkAdminExportLimit(adminId, userCount) {
    // 检查单次导出数量
    if (userCount > this.limits.admin.maxUsersPerRequest) {
      return {
        allowed: false,
        reason: 'BATCH_SIZE_EXCEEDED',
        message: `单次导出用户数不能超过 ${this.limits.admin.maxUsersPerRequest}`,
        maxUsers: this.limits.admin.maxUsersPerRequest
      };
    }
    
    // 检查每日导出次数
    const today = new Date().toISOString().split('T')[0];
    const key = `export:admin:${adminId}:${today}`;
    const count = await this.redis.incr(key);
    
    if (count === 1) {
      await this.redis.expire(key, 24 * 3600);
    }
    
    if (count > this.limits.admin.maxRequestsPerDay) {
      return {
        allowed: false,
        reason: 'DAILY_LIMIT_EXCEEDED',
        message: `今日批量导出次数已达上限`,
        currentCount: count,
        maxCount: this.limits.admin.maxRequestsPerDay
      };
    }
    
    return {
      allowed: true,
      currentCount: count,
      maxCount: this.limits.admin.maxRequestsPerDay,
      remaining: this.limits.admin.maxRequestsPerDay - count
    };
  }

  /**
   * 生成请求ID
   */
  generateRequestId() {
    return `export_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * 格式化冷却时间
   */
  _formatCooldown(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    
    if (days > 0) return `${days}天`;
    if (hours > 0) return `${hours}小时`;
    return `${Math.floor(seconds / 60)}分钟`;
  }

  /**
   * 创建审计表（如果不存在）
   */
  async _createAuditTableIfNeeded() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS export_audit_log (
        id SERIAL PRIMARY KEY,
        request_id VARCHAR(100) UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        export_type VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL,
        file_url TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
  }

  /**
   * 获取用户导出历史
   */
  async getUserExportHistory(userId, limit = 10) {
    const result = await this.db.query(`
      SELECT request_id, export_type, status, created_at, completed_at
      FROM export_audit_log
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, limit]);
    
    return result.rows;
  }

  /**
   * 更新导出状态
   */
  async updateExportStatus(requestId, status, fileUrl = null, errorMessage = null) {
    const updateFields = ['status = $2', 'updated_at = NOW()'];
    const params = [requestId, status];
    
    if (fileUrl) {
      updateFields.push('file_url = $' + (params.length + 1));
      params.push(fileUrl);
    }
    
    if (errorMessage) {
      updateFields.push('error_message = $' + (params.length + 1));
      params.push(errorMessage);
    }
    
    if (status === 'completed' || status === 'failed') {
      updateFields.push('completed_at = NOW()');
    }
    
    await this.db.query(`
      UPDATE export_audit_log
      SET ${updateFields.join(', ')}
      WHERE request_id = $1
    `, params);
  }
}

module.exports = ExportRateLimiter;