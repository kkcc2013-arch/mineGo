const { IPlugin } = require('../IPlugin');
const jwt = require('jsonwebtoken');
const { getRedisClient } = require('../../cache');

/**
 * 认证插件 - JWT 认证中间件
 */
class AuthPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'auth',
      version: '1.0.0',
      description: 'JWT 认证中间件，支持黑名单和设备绑定',
      author: 'mineGo Team',
      dependencies: [],
      priority: 10, // 最高优先级
      category: 'auth',
    };
  }

  static get configSchema() {
    return {
      type: 'object',
      properties: {
        jwtSecret: { type: 'string' },
        tokenExpiry: { type: 'number' },
        blacklistEnabled: { type: 'boolean' },
        deviceBinding: { type: 'boolean' },
      },
      required: ['jwtSecret'],
    };
  }

  static get defaultConfig() {
    return {
      jwtSecret: process.env.JWT_SECRET || 'mineGo-secret-key',
      tokenExpiry: 7 * 24 * 60 * 60, // 7天
      blacklistEnabled: true,
      deviceBinding: true,
    };
  }

  async init(config, context) {
    this.config = config;
    this.logger = context.logger.child({ plugin: 'auth' });
    this.redis = getRedisClient ? getRedisClient() : null;
    
    this.logger.info({ config: { ...config, jwtSecret: '***' } }, 'Auth plugin initialized');
  }

  async start(context) {
    this.logger.info('Auth plugin started');
  }

  async stop(context) {
    this.logger.info('Auth plugin stopped');
  }

  async healthCheck() {
    const details = {
      blacklistEnabled: this.config.blacklistEnabled,
      redisConnected: this.redis ? this.redis.status === 'ready' : false,
    };

    const status = this.config.blacklistEnabled && !details.redisConnected 
      ? 'degraded' 
      : 'healthy';

    return { status, details };
  }

  getMiddleware() {
    return async (req, res, next) => {
      try {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.substring(7);
        
        // 检查黑名单
        if (this.config.blacklistEnabled && this.redis) {
          const isBlacklisted = await this.redis.get(`jwt:blacklist:${token}`);
          if (isBlacklisted) {
            return res.status(401).json({ error: 'Token revoked' });
          }
        }

        // 验证 token
        const decoded = jwt.verify(token, this.config.jwtSecret);
        
        // 设备绑定检查
        if (this.config.deviceBinding && decoded.deviceId) {
          const deviceId = req.headers['x-device-id'];
          if (deviceId && deviceId !== decoded.deviceId) {
            return res.status(401).json({ error: 'Device mismatch' });
          }
        }

        req.user = decoded;
        req.token = token;
        next();
      } catch (err) {
        if (err.name === 'JsonWebTokenError') {
          return res.status(401).json({ error: 'Invalid token' });
        }
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({ error: 'Token expired' });
        }
        next(err);
      }
    };
  }
}

module.exports = AuthPlugin;
