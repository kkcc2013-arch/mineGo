/**
 * IP 封禁管理器
 * REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { logger, metrics } = require('./index');

// 封禁严重级别对应的默认时长
const BAN_DURATIONS = {
  low: 12 * 60 * 60 * 1000,      // 12 小时
  medium: 24 * 60 * 60 * 1000,   // 24 小时
  high: 48 * 60 * 60 * 1000,     // 48 小时
  critical: null                  // 永久
};

// 自动封禁触发阈值
const AUTO_BAN_THRESHOLDS = {
  gps_cheat: { count: 5, duration: 24 * 60 * 60 * 1000, severity: 'medium' },
  device_anomaly: { count: 3, duration: 48 * 60 * 60 * 1000, severity: 'high' },
  captcha_fail: { count: 10, duration: 12 * 60 * 60 * 1000, severity: 'low' },
  rate_limit: { count: 5, duration: 6 * 60 * 60 * 1000, severity: 'medium' },
  tor_exit: { count: 1, duration: null, severity: 'critical' },
  vpn_proxy: { count: 3, duration: 48 * 60 * 60 * 1000, severity: 'high' }
};

// Redis 缓存键前缀
const CACHE_PREFIX = 'ipban:';
const BLACKLIST_CACHE_KEY = `${CACHE_PREFIX}blacklist`;
const WHITELIST_CACHE_KEY = `${CACHE_PREFIX}whitelist`;
const RISK_SCORE_PREFIX = `${CACHE_PREFIX}risk:`;
const PUB_CHANNEL = 'ipban:events';

class IpBanManager {
  constructor(options = {}) {
    this.db = options.db || new Pool();
    this.redis = options.redis || new Redis();
    this.publisher = options.publisher || new Redis();
    this.subscriber = options.subscriber || new Redis();
    
    // 本地缓存
    this.localBlacklist = new Map();
    this.localWhitelist = new Map();
    
    // 初始化时加载缓存
    this.initialized = false;
    this.init();
  }

  async init() {
    try {
      // 订阅 Redis 事件
      await this.subscriber.subscribe(PUB_CHANNEL);
      this.subscriber.on('message', (channel, message) => {
        if (channel === PUB_CHANNEL) {
          this.handleRedisEvent(JSON.parse(message));
        }
      });
      
      // 加载黑名单和白名单到本地缓存
      await this.loadCaches();
      this.initialized = true;
      logger.info('IpBanManager initialized successfully');
    } catch (error) {
      logger.error('IpBanManager initialization failed', { error: error.message });
    }
  }

  /**
   * 加载黑名单和白名单到缓存
   */
  async loadCaches() {
    const client = await this.db.connect();
    try {
      // 加载黑名单
      const blacklistResult = await client.query(`
        SELECT ip_address, expires_at 
        FROM ip_blacklist 
        WHERE (expires_at IS NULL OR expires_at > NOW())
      `);
      
      this.localBlacklist.clear();
      for (const row of blacklistResult.rows) {
        this.localBlacklist.set(row.ip_address, row.expires_at);
      }
      
      // 加载白名单
      const whitelistResult = await client.query('SELECT ip_address FROM ip_whitelist');
      this.localWhitelist.clear();
      for (const row of whitelistResult.rows) {
        this.localWhitelist.add(row.ip_address);
      }
      
      // 同步到 Redis
      await this.redis.del(BLACKLIST_CACHE_KEY);
      await this.redis.del(WHITELIST_CACHE_KEY);
      
      for (const [ip, expires] of this.localBlacklist) {
        if (expires) {
          const ttl = Math.floor((new Date(expires) - new Date()) / 1000);
          if (ttl > 0) {
            await this.redis.hset(BLACKLIST_CACHE_KEY, ip, expires.toISOString());
            await this.redis.expire(BLACKLIST_CACHE_KEY, ttl);
          }
        } else {
          await this.redis.hset(BLACKLIST_CACHE_KEY, ip, 'permanent');
        }
      }
      
      for (const ip of this.localWhitelist) {
        await this.redis.sadd(WHITELIST_CACHE_KEY, ip);
      }
      
      logger.info('IP caches loaded', {
        blacklist: this.localBlacklist.size,
        whitelist: this.localWhitelist.size
      });
    } finally {
      client.release();
    }
  }

  /**
   * 检查 IP 是否在白名单
   */
  async isWhitelisted(ipAddress) {
    // 先检查本地缓存
    if (this.localWhitelist.has(ipAddress)) {
      return true;
    }
    
    // 检查 Redis
    const inWhitelist = await this.redis.sismember(WHITELIST_CACHE_KEY, ipAddress);
    return inWhitelist === 1;
  }

  /**
   * 检查 IP 是否被封禁
   */
  async isBlocked(ipAddress) {
    // 1. 白名单优先
    if (await this.isWhitelisted(ipAddress)) {
      return { blocked: false, reason: 'whitelisted' };
    }
    
    // 2. 检查本地缓存
    const localExpiry = this.localBlacklist.get(ipAddress);
    if (localExpiry) {
      if (localExpiry === null || new Date(localExpiry) > new Date()) {
        return { blocked: true, reason: 'blacklist', expires: localExpiry };
      }
    }
    
    // 3. 检查 Redis
    const redisResult = await this.redis.hget(BLACKLIST_CACHE_KEY, ipAddress);
    if (redisResult) {
      if (redisResult === 'permanent') {
        return { blocked: true, reason: 'blacklist', expires: null };
      }
      const expires = new Date(redisResult);
      if (expires > new Date()) {
        return { blocked: true, reason: 'blacklist', expires };
      }
    }
    
    // 4. 检查地理位置封禁
    const geoBlocked = await this.checkGeoBan(ipAddress);
    if (geoBlocked) {
      return { blocked: true, reason: 'geo_ban', country: geoBlocked };
    }
    
    return { blocked: false };
  }

  /**
   * 检查地理位置封禁
   */
  async checkGeoBan(ipAddress) {
    const client = await this.db.connect();
    try {
      // 获取 IP 的国家代码
      const country = await this.getIpCountry(ipAddress);
      if (!country) return null;
      
      // 检查是否被封禁
      const result = await client.query(
        'SELECT country_code FROM geo_bans WHERE country_code = $1 AND is_active = true',
        [country]
      );
      
      return result.rows.length > 0 ? country : null;
    } finally {
      client.release();
    }
  }

  /**
   * 获取 IP 国家代码（简化版，实际应使用 GeoIP 数据库）
   */
  async getIpCountry(ipAddress) {
    const client = await this.db.connect();
    try {
      const result = await client.query(
        'SELECT country_code FROM ip_risk_scores WHERE ip_address = $1',
        [ipAddress]
      );
      return result.rows[0]?.country_code || null;
    } finally {
      client.release();
    }
  }

  /**
   * 添加 IP 到黑名单
   */
  async addToBlacklist(ipAddress, reason, severity = 'medium', expiresAt = null, blockedBy = null) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      // 计算默认过期时间
      if (!expiresAt && BAN_DURATIONS[severity]) {
        expiresAt = new Date(Date.now() + BAN_DURATIONS[severity]);
      }
      
      // 插入数据库
      await client.query(`
        INSERT INTO ip_blacklist (ip_address, reason, severity, is_auto, expires_at, blocked_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [ipAddress, reason, severity, blockedBy === null, expiresAt, blockedBy]);
      
      // 更新本地缓存
      this.localBlacklist.set(ipAddress, expiresAt);
      
      // 更新 Redis
      if (expiresAt) {
        const ttl = Math.floor((new Date(expiresAt) - new Date()) / 1000);
        if (ttl > 0) {
          await this.redis.hset(BLACKLIST_CACHE_KEY, ipAddress, expiresAt.toISOString());
        }
      } else {
        await this.redis.hset(BLACKLIST_CACHE_KEY, ipAddress, 'permanent');
      }
      
      // 发布事件
      await this.publishEvent('ban', { ipAddress, reason, severity, expiresAt });
      
      await client.query('COMMIT');
      
      // 更新指标
      metrics.increment('ip_ban_total', 1, { type: 'blacklist', severity });
      
      logger.info('IP added to blacklist', { ipAddress, reason, severity, expiresAt });
      
      return { success: true, ipAddress, expiresAt };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to add IP to blacklist', { ipAddress, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 从黑名单移除
   */
  async removeFromBlacklist(ipAddress) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      await client.query('DELETE FROM ip_blacklist WHERE ip_address = $1', [ipAddress]);
      
      // 更新本地缓存
      this.localBlacklist.delete(ipAddress);
      
      // 更新 Redis
      await this.redis.hdel(BLACKLIST_CACHE_KEY, ipAddress);
      
      // 发布事件
      await this.publishEvent('unban', { ipAddress });
      
      await client.query('COMMIT');
      
      logger.info('IP removed from blacklist', { ipAddress });
      
      return { success: true, ipAddress };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to remove IP from blacklist', { ipAddress, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 添加 IP 到白名单
   */
  async addToWhitelist(ipAddress, description = '', addedBy = null) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        INSERT INTO ip_whitelist (ip_address, description, added_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (ip_address) DO UPDATE SET description = $2, added_by = $3
      `, [ipAddress, description, addedBy]);
      
      // 更新本地缓存
      this.localWhitelist.add(ipAddress);
      
      // 更新 Redis
      await this.redis.sadd(WHITELIST_CACHE_KEY, ipAddress);
      
      // 发布事件
      await this.publishEvent('whitelist_add', { ipAddress, description });
      
      await client.query('COMMIT');
      
      metrics.increment('ip_ban_total', 1, { type: 'whitelist' });
      
      logger.info('IP added to whitelist', { ipAddress, description });
      
      return { success: true, ipAddress };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to add IP to whitelist', { ipAddress, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 从白名单移除
   */
  async removeFromWhitelist(ipAddress) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      await client.query('DELETE FROM ip_whitelist WHERE ip_address = $1', [ipAddress]);
      
      // 更新本地缓存
      this.localWhitelist.delete(ipAddress);
      
      // 更新 Redis
      await this.redis.srem(WHITELIST_CACHE_KEY, ipAddress);
      
      // 发布事件
      await this.publishEvent('whitelist_remove', { ipAddress });
      
      await client.query('COMMIT');
      
      logger.info('IP removed from whitelist', { ipAddress });
      
      return { success: true, ipAddress };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 记录触发事件并检查是否需要自动封禁
   */
  async recordTrigger(ipAddress, triggerType) {
    const client = await this.db.connect();
    try {
      const threshold = AUTO_BAN_THRESHOLDS[triggerType];
      if (!threshold) {
        logger.warn('Unknown trigger type', { triggerType });
        return { triggered: false };
      }
      
      await client.query('BEGIN');
      
      // 更新触发记录
      const result = await client.query(`
        INSERT INTO auto_ban_triggers (ip_address, trigger_type, trigger_count, first_triggered_at, last_triggered_at)
        VALUES ($1, $2, 1, NOW(), NOW())
        ON CONFLICT (ip_address, trigger_type)
        DO UPDATE SET 
          trigger_count = auto_ban_triggers.trigger_count + 1,
          last_triggered_at = NOW()
        RETURNING trigger_count
      `, [ipAddress, triggerType]);
      
      const triggerCount = result.rows[0].trigger_count;
      
      // 检查是否达到阈值
      if (triggerCount >= threshold.count) {
        // 自动封禁
        await this.addToBlacklist(
          ipAddress,
          `Auto-ban: ${triggerType} triggered ${triggerCount} times`,
          threshold.severity,
          threshold.duration ? new Date(Date.now() + threshold.duration) : null,
          null
        );
        
        metrics.increment('ip_ban_auto_total', 1, { reason: triggerType });
        
        await client.query('COMMIT');
        
        logger.info('Auto-ban triggered', { ipAddress, triggerType, triggerCount });
        
        return { triggered: true, autoBanned: true };
      }
      
      await client.query('COMMIT');
      
      return { triggered: true, autoBanned: false, triggerCount, threshold: threshold.count };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to record trigger', { ipAddress, triggerType, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取 IP 风险评分
   */
  async getRiskScore(ipAddress) {
    // 先检查 Redis 缓存
    const cached = await this.redis.get(`${RISK_SCORE_PREFIX}${ipAddress}`);
    if (cached) {
      return parseInt(cached, 10);
    }
    
    const client = await this.db.connect();
    try {
      const result = await client.query(
        'SELECT risk_score FROM ip_risk_scores WHERE ip_address = $1',
        [ipAddress]
      );
      
      const score = result.rows[0]?.risk_score || 0;
      
      // 缓存 5 分钟
      await this.redis.setex(`${RISK_SCORE_PREFIX}${ipAddress}`, 300, score.toString());
      
      return score;
    } finally {
      client.release();
    }
  }

  /**
   * 更新风险评分
   */
  async updateRiskScore(ipAddress, delta, reason = '') {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        INSERT INTO ip_risk_scores (ip_address, risk_score, violation_count, last_violation_at)
        VALUES ($1, LEAST(GREATEST($2, 0), 100), 1, NOW())
        ON CONFLICT (ip_address)
        DO UPDATE SET
          risk_score = LEAST(GREATEST(ip_risk_scores.risk_score + $2, 0), 100),
          violation_count = ip_risk_scores.violation_count + 1,
          last_violation_at = NOW(),
          updated_at = NOW()
      `, [ipAddress, delta]);
      
      // 清除缓存
      await this.redis.del(`${RISK_SCORE_PREFIX}${ipAddress}`);
      
      await client.query('COMMIT');
      
      // 获取更新后的评分
      const newScore = await this.getRiskScore(ipAddress);
      
      // 如果评分达到 100，自动封禁
      if (newScore >= 100) {
        await this.addToBlacklist(ipAddress, 'Risk score reached maximum', 'critical', null, null);
      }
      
      return newScore;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 记录访问日志
   */
  async logAccess(ipAddress, userId, endpoint, method, statusCode, responseTime, isBlocked = false, blockReason = null, userAgent = '') {
    const client = await this.db.connect();
    try {
      await client.query(`
        INSERT INTO ip_access_logs 
        (ip_address, user_id, endpoint, method, status_code, response_time_ms, is_blocked, block_reason, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [ipAddress, userId, endpoint, method, statusCode, responseTime, isBlocked, blockReason, userAgent]);
      
      // 更新最后访问时间
      await client.query(`
        INSERT INTO ip_risk_scores (ip_address, last_access_at)
        VALUES ($1, NOW())
        ON CONFLICT (ip_address)
        DO UPDATE SET last_access_at = NOW()
      `, [ipAddress]);
    } finally {
      client.release();
    }
  }

  /**
   * 提交申诉
   */
  async submitAppeal(ipAddress, userId, appealReason) {
    const client = await this.db.connect();
    try {
      const result = await client.query(`
        INSERT INTO ip_ban_appeals (ip_address, user_id, appeal_reason)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [ipAddress, userId, appealReason]);
      
      metrics.increment('ip_ban_appeal_total', 1, { status: 'pending' });
      
      return { appealId: result.rows[0].id };
    } finally {
      client.release();
    }
  }

  /**
   * 处理申诉
   */
  async processAppeal(appealId, approved, reviewedBy, reviewNote = '') {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      const result = await client.query(`
        UPDATE ip_ban_appeals
        SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_note = $3
        WHERE id = $4
        RETURNING ip_address
      `, [approved ? 'approved' : 'rejected', reviewedBy, reviewNote, appealId]);
      
      if (result.rows.length === 0) {
        throw new Error('Appeal not found');
      }
      
      const ipAddress = result.rows[0].ip_address;
      
      if (approved) {
        await this.removeFromBlacklist(ipAddress);
      }
      
      await client.query('COMMIT');
      
      return { success: true, ipAddress, approved };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 发布事件到 Redis
   */
  async publishEvent(eventType, data) {
    const message = JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() });
    await this.publisher.publish(PUB_CHANNEL, message);
  }

  /**
   * 处理 Redis 事件
   */
  handleRedisEvent(event) {
    logger.debug('Received IP ban event', { event });
    
    switch (event.type) {
      case 'ban':
        this.localBlacklist.set(event.data.ipAddress, event.data.expiresAt);
        break;
      case 'unban':
        this.localBlacklist.delete(event.data.ipAddress);
        break;
      case 'whitelist_add':
        this.localWhitelist.add(event.data.ipAddress);
        break;
      case 'whitelist_remove':
        this.localWhitelist.delete(event.data.ipAddress);
        break;
    }
  }

  /**
   * 清理过期的封禁
   */
  async cleanupExpired() {
    const client = await this.db.connect();
    try {
      const result = await client.query(`
        DELETE FROM ip_blacklist
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
        RETURNING ip_address
      `);
      
      for (const row of result.rows) {
        this.localBlacklist.delete(row.ip_address);
        await this.redis.hdel(BLACKLIST_CACHE_KEY, row.ip_address);
      }
      
      if (result.rows.length > 0) {
        logger.info('Cleaned up expired IP bans', { count: result.rows.length });
      }
      
      return result.rows.length;
    } finally {
      client.release();
    }
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    const client = await this.db.connect();
    try {
      const blacklistCount = await client.query('SELECT COUNT(*) FROM ip_blacklist WHERE expires_at IS NULL OR expires_at > NOW()');
      const whitelistCount = await client.query('SELECT COUNT(*) FROM ip_whitelist');
      const appealsCount = await client.query("SELECT COUNT(*) FROM ip_ban_appeals WHERE status = 'pending'");
      const highRiskCount = await client.query('SELECT COUNT(*) FROM ip_risk_scores WHERE risk_score >= 80');
      
      return {
        blacklist: parseInt(blacklistCount.rows[0].count, 10),
        whitelist: parseInt(whitelistCount.rows[0].count, 10),
        pendingAppeals: parseInt(appealsCount.rows[0].count, 10),
        highRiskIps: parseInt(highRiskCount.rows[0].count, 10)
      };
    } finally {
      client.release();
    }
  }

  /**
   * 批准申诉
   */
  async approveAppeal(appealId, reviewedBy, reviewNote = '') {
    return this.processAppeal(appealId, true, reviewedBy, reviewNote);
  }

  /**
   * 拒绝申诉
   */
  async rejectAppeal(appealId, reviewedBy, reviewNote = '') {
    return this.processAppeal(appealId, false, reviewedBy, reviewNote);
  }

  /**
   * 添加地理位置封禁
   */
  async addGeoBan(countryCode, reason, bannedBy = null) {
    const client = await this.db.connect();
    try {
      await client.query(`
        INSERT INTO geo_ban (country_code, reason, banned_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (country_code) DO UPDATE SET
          reason = $2, is_active = true, banned_by = $3, updated_at = NOW()
      `, [countryCode, reason, bannedBy]);
      
      logger.info('Geo ban added', { countryCode, reason });
      
      return { success: true, countryCode };
    } finally {
      client.release();
    }
  }

  /**
   * 解除地理位置封禁
   */
  async removeGeoBan(countryCode, removedBy = null) {
    const client = await this.db.connect();
    try {
      await client.query(`
        UPDATE geo_ban SET is_active = false, updated_at = NOW()
        WHERE country_code = $1
      `, [countryCode]);
      
      logger.info('Geo ban removed', { countryCode });
      
      return { success: true, countryCode };
    } finally {
      client.release();
    }
  }

  /**
   * 重置 IP 风险评分
   */
  async resetRiskScore(ipAddress) {
    const client = await this.db.connect();
    try {
      await client.query(`
        UPDATE ip_risk_scores
        SET risk_score = 0, violation_count = 0, last_violation_at = NULL, updated_at = NOW()
        WHERE ip_address = $1
      `, [ipAddress]);
      
      // 清除 Redis 缓存
      await this.redis.del(`${RISK_SCORE_PREFIX}${ipAddress}`);
      
      logger.info('IP risk score reset', { ipAddress });
      
      return { success: true, ipAddress };
    } finally {
      client.release();
    }
  }

  /**
   * 更新 removeFromWhitelist 支持操作人参数
   */
  async removeFromWhitelistWithLog(ipAddress, removedBy = null) {
    const client = await this.db.connect();
    try {
      await client.query('DELETE FROM ip_whitelist WHERE ip_address = $1', [ipAddress]);
      
      this.localWhitelist.delete(ipAddress);
      await this.redis.srem(WHITELIST_CACHE_KEY, ipAddress);
      
      await this.publishEvent('whitelist_remove', { ipAddress });
      
      logger.info('IP removed from whitelist', { ipAddress, removedBy });
      
      return { success: true, ipAddress };
    } finally {
      client.release();
    }
  }
}

module.exports = IpBanManager;
