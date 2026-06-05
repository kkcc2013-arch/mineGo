// shared/JwtBlacklist.js - JWT Token Blacklist Management
'use strict';

const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('jwt-blacklist');

// Redis key prefixes
const BLACKLIST_TOKEN_PREFIX = 'blacklist:token:';
const BLACKLIST_USER_TOKENS_PREFIX = 'blacklist:user:';
const BLACKLIST_USER_SESSIONS_PREFIX = 'sessions:user:';

// Prometheus metrics
const blacklistCheckTotal = metrics.register
  ? new (require('prom-client').Counter)({
      name: 'jwt_blacklist_check_total',
      help: 'Total number of blacklist checks',
      registers: [metrics.register]
    })
  : null;

const blacklistHitTotal = metrics.register
  ? new (require('prom-client').Counter)({
      name: 'jwt_blacklist_hit_total',
      help: 'Total number of blacklist hits (revoked tokens)',
      registers: [metrics.register]
    })
  : null;

const blacklistRevokeTotal = metrics.register
  ? new (require('prom-client').Counter)({
      name: 'jwt_blacklist_revoke_total',
      help: 'Total number of tokens revoked',
      labelNames: ['reason'],
      registers: [metrics.register]
    })
  : null;

class JwtBlacklist {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  /**
   * Check if a token is blacklisted
   * @param {string} jti - JWT ID
   * @returns {Promise<boolean>}
   */
  async isBlacklisted(jti) {
    if (!jti) return false;
    
    blacklistCheckTotal?.inc();
    
    try {
      const exists = await this.redis.exists(`${BLACKLIST_TOKEN_PREFIX}${jti}`);
      const isBlacklisted = exists === 1;
      
      if (isBlacklisted) {
        blacklistHitTotal?.inc();
        logger.debug({ jti }, 'Token is blacklisted');
      }
      
      return isBlacklisted;
    } catch (err) {
      logger.error({ err, jti }, 'Failed to check blacklist');
      // On error, allow the request to proceed (fail-open for availability)
      return false;
    }
  }

  /**
   * Revoke a single token
   * @param {string} jti - JWT ID
   * @param {string} userId - User ID
   * @param {number} expiresAt - Token expiration timestamp (seconds)
   * @param {object} options - Additional options
   * @param {string} options.reason - Reason for revocation
   * @param {object} options.deviceInfo - Device information
   */
  async revokeToken(jti, userId, expiresAt, options = {}) {
    const { reason = 'logout', deviceInfo = null } = options;
    
    // Calculate TTL: time until expiration + 5 min buffer
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(expiresAt - now + 300, 300); // Minimum 5 min
    
    try {
      const multi = this.redis.multi();
      
      // Add to blacklist with TTL
      multi.setex(
        `${BLACKLIST_TOKEN_PREFIX}${jti}`,
        ttl,
        JSON.stringify({ revokedAt: now, reason })
      );
      
      // Add to user's token set (for bulk revocation)
      multi.sadd(`${BLACKLIST_USER_TOKENS_PREFIX}${userId}`, jti);
      
      // Store session info if deviceInfo provided
      if (deviceInfo) {
        multi.hset(
          `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
          jti,
          JSON.stringify({
            ...deviceInfo,
            createdAt: now,
            revokedAt: now,
            reason
          })
        );
      }
      
      await multi.exec();
      
      blacklistRevokeTotal?.inc({ reason });
      logger.info({ jti, userId, reason, ttl }, 'Token revoked');
      
      return true;
    } catch (err) {
      logger.error({ err, jti, userId }, 'Failed to revoke token');
      throw err;
    }
  }

  /**
   * Register a new session (not revoked)
   * @param {string} jti - JWT ID
   * @param {string} userId - User ID
   * @param {number} expiresAt - Token expiration timestamp
   * @param {object} deviceInfo - Device information
   */
  async registerSession(jti, userId, expiresAt, deviceInfo = {}) {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(expiresAt - now + 300, 300);
    
    try {
      const multi = this.redis.multi();
      
      // Add to user's token set
      multi.sadd(`${BLACKLIST_USER_TOKENS_PREFIX}${userId}`, jti);
      
      // Store session info
      multi.hset(
        `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
        jti,
        JSON.stringify({
          ...deviceInfo,
          jti,
          createdAt: now,
          lastActiveAt: now,
          expiresAt
        })
      );
      
      // Set TTL on the sessions hash
      multi.expire(`${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`, 2592000); // 30 days
      
      await multi.exec();
      
      logger.debug({ jti, userId }, 'Session registered');
      return true;
    } catch (err) {
      logger.error({ err, jti, userId }, 'Failed to register session');
      throw err;
    }
  }

  /**
   * Update session last active time
   * @param {string} jti - JWT ID
   * @param {string} userId - User ID
   */
  async updateSessionActivity(jti, userId) {
    try {
      const sessionData = await this.redis.hget(
        `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
        jti
      );
      
      if (sessionData) {
        const session = JSON.parse(sessionData);
        session.lastActiveAt = Math.floor(Date.now() / 1000);
        
        await this.redis.hset(
          `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
          jti,
          JSON.stringify(session)
        );
      }
    } catch (err) {
      logger.error({ err, jti, userId }, 'Failed to update session activity');
    }
  }

  /**
   * Get all active sessions for a user
   * @param {string} userId - User ID
   * @returns {Promise<Array>}
   */
  async getActiveSessions(userId) {
    try {
      const sessionsData = await this.redis.hgetall(
        `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`
      );
      
      const now = Math.floor(Date.now() / 1000);
      const sessions = [];
      
      for (const [jti, dataStr] of Object.entries(sessionsData)) {
        try {
          const data = JSON.parse(dataStr);
          
          // Skip expired sessions
          if (data.expiresAt && data.expiresAt < now) continue;
          
          // Check if token is blacklisted
          const isBlacklisted = await this.isBlacklisted(jti);
          if (isBlacklisted) continue;
          
          sessions.push({
            jti,
            deviceName: data.deviceName || 'Unknown',
            deviceType: data.deviceType || 'unknown',
            ip: data.ip || null,
            userAgent: data.userAgent || null,
            createdAt: data.createdAt,
            lastActiveAt: data.lastActiveAt || data.createdAt,
            expiresAt: data.expiresAt
          });
        } catch {
          // Invalid JSON, skip
        }
      }
      
      // Sort by last active (most recent first)
      sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      
      return sessions;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to get active sessions');
      return [];
    }
  }

  /**
   * Revoke all tokens for a user (except current)
   * @param {string} userId - User ID
   * @param {string} currentJti - Current token JTI to keep
   * @param {string} reason - Reason for revocation
   * @returns {Promise<number>} Number of tokens revoked
   */
  async revokeAllTokens(userId, currentJti = null, reason = 'security') {
    try {
      // Get all tokens for user
      const jtis = await this.redis.smembers(
        `${BLACKLIST_USER_TOKENS_PREFIX}${userId}`
      );
      
      if (jtis.length === 0) return 0;
      
      const now = Math.floor(Date.now() / 1000);
      let revokedCount = 0;
      
      const multi = this.redis.multi();
      
      for (const jti of jtis) {
        // Skip current token if specified
        if (currentJti && jti === currentJti) continue;
        
        // Check if already blacklisted
        const exists = await this.redis.exists(`${BLACKLIST_TOKEN_PREFIX}${jti}`);
        if (exists) continue;
        
        // Add to blacklist (24h TTL as fallback)
        multi.setex(
          `${BLACKLIST_TOKEN_PREFIX}${jti}`,
          86400,
          JSON.stringify({ revokedAt: now, reason })
        );
        
        // Update session info
        multi.hset(
          `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
          jti,
          JSON.stringify({ revokedAt: now, reason })
        );
        
        revokedCount++;
      }
      
      if (revokedCount > 0) {
        await multi.exec();
        blacklistRevokeTotal?.inc({ reason }, revokedCount);
        logger.info({ userId, reason, count: revokedCount }, 'Bulk token revocation');
      }
      
      return revokedCount;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to revoke all tokens');
      throw err;
    }
  }

  /**
   * Revoke a specific session by JTI
   * @param {string} jti - JWT ID to revoke
   * @param {string} userId - User ID
   * @param {string} reason - Reason for revocation
   */
  async revokeSession(jti, userId, reason = 'force_logout') {
    const now = Math.floor(Date.now() / 1000);
    
    try {
      const multi = this.redis.multi();
      
      // Add to blacklist
      multi.setex(
        `${BLACKLIST_TOKEN_PREFIX}${jti}`,
        86400,
        JSON.stringify({ revokedAt: now, reason })
      );
      
      // Update session info
      const sessionData = await this.redis.hget(
        `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
        jti
      );
      
      if (sessionData) {
        const session = JSON.parse(sessionData);
        session.revokedAt = now;
        session.reason = reason;
        multi.hset(
          `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
          jti,
          JSON.stringify(session)
        );
      }
      
      await multi.exec();
      
      blacklistRevokeTotal?.inc({ reason });
      logger.info({ jti, userId, reason }, 'Session revoked');
      
      return true;
    } catch (err) {
      logger.error({ err, jti, userId }, 'Failed to revoke session');
      throw err;
    }
  }

  /**
   * Cleanup expired tokens (called by cron job)
   * @param {number} batchSize - Number of users to process per run
   * @returns {Promise<object>} Cleanup statistics
   */
  async cleanupExpiredTokens(batchSize = 100) {
    const stats = {
      usersProcessed: 0,
      tokensRemoved: 0,
      sessionsCleaned: 0
    };
    
    try {
      // Scan for user token sets
      let cursor = '0';
      const pattern = `${BLACKLIST_USER_TOKENS_PREFIX}*`;
      
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          batchSize
        );
        cursor = nextCursor;
        
        for (const key of keys) {
          const userId = key.replace(BLACKLIST_USER_TOKENS_PREFIX, '');
          const jtis = await this.redis.smembers(key);
          
          const now = Math.floor(Date.now() / 1000);
          
          for (const jti of jtis) {
            // Check if token has expired (blacklist entry gone)
            const exists = await this.redis.exists(`${BLACKLIST_TOKEN_PREFIX}${jti}`);
            
            // If blacklist entry is gone and token is old, remove from set
            if (!exists) {
              // Check session data for expiration
              const sessionData = await this.redis.hget(
                `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
                jti
              );
              
              if (sessionData) {
                const session = JSON.parse(sessionData);
                if (session.expiresAt && session.expiresAt < now - 86400) {
                  // Token expired more than 24h ago, clean up
                  await this.redis.srem(key, jti);
                  await this.redis.hdel(
                    `${BLACKLIST_USER_SESSIONS_PREFIX}${userId}`,
                    jti
                  );
                  stats.tokensRemoved++;
                  stats.sessionsCleaned++;
                }
              }
            }
          }
          
          stats.usersProcessed++;
        }
      } while (cursor !== '0');
      
      logger.info(stats, 'Token cleanup completed');
      return stats;
    } catch (err) {
      logger.error({ err }, 'Token cleanup failed');
      return stats;
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create JwtBlacklist instance
 * @param {object} redisClient - Redis client (optional, uses shared if not provided)
 */
function getJwtBlacklist(redisClient) {
  if (!instance) {
    const redis = redisClient || require('./redis').getRedis();
    instance = new JwtBlacklist(redis);
  }
  return instance;
}

module.exports = {
  JwtBlacklist,
  getJwtBlacklist,
  BLACKLIST_TOKEN_PREFIX,
  BLACKLIST_USER_TOKENS_PREFIX,
  BLACKLIST_USER_SESSIONS_PREFIX
};
