// backend/shared/FallbackStrategy.js
'use strict';
const { createLogger } = require('./logger');
const { getRedis } = require('./redis');

const logger = createLogger('fallback-strategy');

/**
 * Fallback Strategy Base Class
 * 
 * Provides a framework for handling service failures gracefully.
 */
class FallbackStrategy {
  constructor(options = {}) {
    this.name = options.name || 'default-fallback';
    this.handler = options.handler || this.defaultHandler.bind(this);
    this.enabled = options.enabled !== false;
  }

  /**
   * Default fallback handler
   * @param {Object} ctx - Request context
   * @param {Error} err - The error that triggered the fallback
   * @returns {Promise<Object>}
   */
  async defaultHandler(ctx, err) {
    logger.warn({
      strategy: this.name,
      error: err?.message,
      context: ctx
    }, 'Fallback triggered');
    
    return {
      success: false,
      fallback: true,
      strategy: this.name,
      message: 'Service temporarily unavailable'
    };
  }

  /**
   * Execute the fallback strategy
   * @param {Object} ctx - Request context
   * @param {Error} err - The error that triggered the fallback
   * @returns {Promise<Object>}
   */
  async execute(ctx, err) {
    if (!this.enabled) {
      throw err;
    }
    
    try {
      return await this.handler(ctx, err);
    } catch (fallbackErr) {
      logger.error({
        strategy: this.name,
        error: fallbackErr.message
      }, 'Fallback handler failed');
      
      return {
        success: false,
        fallback: true,
        strategy: this.name,
        error: fallbackErr.message
      };
    }
  }
}

/**
 * Predefined Fallback Strategies
 */
const FallbackStrategies = {
  /**
   * Return empty data
   */
  emptyData: new FallbackStrategy({
    name: 'empty-data',
    handler: async (ctx) => ({
      success: true,
      fallback: true,
      data: [],
      message: 'No data available (service degraded)'
    })
  }),

  /**
   * Return cached data
   */
  cachedData: new FallbackStrategy({
    name: 'cached-data',
    handler: async (ctx) => {
      if (!ctx.cacheKey) {
        return { success: false, fallback: true, message: 'No cache key provided' };
      }
      
      const redis = getRedis();
      const cached = await redis.get(ctx.cacheKey);
      
      if (cached) {
        logger.info({ cacheKey: ctx.cacheKey }, 'Returning cached data');
        return {
          success: true,
          fallback: true,
          cached: true,
          data: JSON.parse(cached)
        };
      }
      
      return {
        success: false,
        fallback: true,
        message: 'No cached data available'
      };
    }
  }),

  /**
   * Return a default value
   */
  defaultValue: new FallbackStrategy({
    name: 'default-value',
    handler: async (ctx) => ({
      success: true,
      fallback: true,
      ...ctx.defaultValue,
      message: 'Using default value (service degraded)'
    })
  }),

  /**
   * Queue for retry later (requires event bus)
   */
  retryLater: new FallbackStrategy({
    name: 'retry-later',
    handler: async (ctx, err) => {
      // This would typically publish to a message queue
      // For now, we just log and return a pending status
      logger.info({
        context: ctx,
        error: err?.message
      }, 'Request queued for retry');
      
      return {
        success: true,
        fallback: true,
        pending: true,
        message: 'Request queued for later processing'
      };
    }
  }),

  /**
   * Skip the operation (for non-critical operations)
   */
  skip: new FallbackStrategy({
    name: 'skip',
    handler: async (ctx) => ({
      success: true,
      fallback: true,
      skipped: true,
      message: 'Operation skipped (non-critical)'
    })
  }),

  /**
   * Return null/undefined (silently fail)
   */
  silent: new FallbackStrategy({
    name: 'silent',
    handler: async () => null
  }),

  /**
   * Propagate the error (no fallback)
   */
  propagate: new FallbackStrategy({
    name: 'propagate',
    enabled: false,
    handler: async (ctx, err) => {
      throw err;
    }
  })
};

/**
 * Service-specific Fallback Strategies for mineGo
 */
const ServiceFallbackStrategies = {
  /**
   * User service fallback
   * - For profile requests: return cached profile
   * - For auth validation: fail (critical)
   */
  'user-service': {
    profile: new FallbackStrategy({
      name: 'user-profile-cached',
      handler: async (ctx) => {
        const redis = getRedis();
        const cached = await redis.get(`user:profile:${ctx.userId}`);
        
        if (cached) {
          return {
            success: true,
            fallback: true,
            cached: true,
            user: JSON.parse(cached)
          };
        }
        
        return {
          success: false,
          fallback: true,
          message: 'User profile unavailable'
        };
      }
    }),
    
    auth: FallbackStrategies.propagate, // Auth is critical, don't fallback
  },

  /**
   * Location service fallback
   * - Use coarse location (client-provided) instead of precise GPS
   */
  'location-service': new FallbackStrategy({
    name: 'location-coarse',
    handler: async (ctx) => ({
      success: true,
      fallback: true,
      degraded: true,
      location: {
        lat: ctx.lat,
        lng: ctx.lng,
        accuracy: 'low',
        accuracyMeters: 1000
      },
      message: 'Using coarse location (service degraded)'
    })
  }),

  /**
   * Reward service fallback
   * - Queue rewards for later processing
   */
  'reward-service': new FallbackStrategy({
    name: 'reward-queue',
    handler: async (ctx) => {
      logger.info({
        userId: ctx.userId,
        rewards: ctx.rewards
      }, 'Rewards queued for later');
      
      // Store in Redis for later processing
      const redis = getRedis();
      const queueKey = `reward:queue:${ctx.userId}`;
      await redis.rpush(queueKey, JSON.stringify({
        userId: ctx.userId,
        rewards: ctx.rewards,
        createdAt: new Date().toISOString()
      }));
      await redis.expire(queueKey, 86400); // 24h TTL
      
      return {
        success: true,
        fallback: true,
        pending: true,
        message: 'Rewards will be credited shortly'
      };
    }
  }),

  /**
   * Social service fallback
   * - Skip notifications (non-critical)
   */
  'social-service': new FallbackStrategy({
    name: 'social-skip',
    handler: async (ctx) => {
      logger.info({ context: ctx }, 'Social operation skipped');
      
      return {
        success: true,
        fallback: true,
        skipped: true,
        message: 'Social features temporarily unavailable'
      };
    }
  }),

  /**
   * Pokemon service fallback
   * - For species data: return cached
   * - For instance operations: fail (critical)
   */
  'pokemon-service': {
    species: new FallbackStrategy({
      name: 'pokemon-species-cached',
      handler: async (ctx) => {
        const redis = getRedis();
        const cached = await redis.get(`pokemon:species:${ctx.speciesId}`);
        
        if (cached) {
          return {
            success: true,
            fallback: true,
            cached: true,
            species: JSON.parse(cached)
          };
        }
        
        return {
          success: false,
          fallback: true,
          message: 'Pokemon data unavailable'
        };
      }
    }),
    
    instance: FallbackStrategies.propagate // Instance ops are critical
  },

  /**
   * Gym service fallback
   * - For gym info: return cached
   * - For battles: fail (critical)
   */
  'gym-service': {
    info: FallbackStrategies.cachedData,
    battle: FallbackStrategies.propagate
  },

  /**
   * Catch service fallback
   * - Never fallback (catching is core gameplay)
   */
  'catch-service': FallbackStrategies.propagate,

  /**
   * Payment service fallback
   * - Never fallback (payments are critical)
   */
  'payment-service': FallbackStrategies.propagate
};

/**
 * Create a composite fallback strategy
 * @param {Object} strategies - Map of operation -> strategy
 * @returns {Function}
 */
function createCompositeFallback(strategies) {
  return async (operation, ctx, err) => {
    const strategy = strategies[operation] || FallbackStrategies.default;
    return strategy.execute(ctx, err);
  };
}

module.exports = {
  FallbackStrategy,
  FallbackStrategies,
  ServiceFallbackStrategies,
  createCompositeFallback
};
