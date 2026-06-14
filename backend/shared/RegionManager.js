/**
 * 区域管理器 - 区域化内容分发核心模块
 * 
 * 功能：
 * 1. 根据用户坐标自动检测区域
 * 2. 获取区域精灵权重配置
 * 3. 应用合规过滤规则
 * 4. 管理区域活动
 * 
 * @module RegionManager
 * @requirement REQ-00083
 */

'use strict';

const { Pool } = require('pg');
const Redis = require('ioredis');
const { createLogger } = require('./logger');

const logger = createLogger('RegionManager');

/**
 * 区域管理器类
 */
class RegionManager {
  /**
   * @param {Object} config - 配置
   * @param {string} config.databaseUrl - 数据库连接字符串
   * @param {string} config.redisUrl - Redis 连接字符串
   * @param {number} config.cacheTTL - 缓存过期时间（秒）
   */
  constructor(config = {}) {
    this.pool = new Pool({
      connectionString: config.databaseUrl || process.env.DATABASE_URL
    });
    
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.cacheTTL = config.cacheTTL || 300; // 5分钟缓存
    
    this.regionCache = new Map();
    this.lastCacheRefresh = 0;
  }

  /**
   * 根据坐标检测用户所在区域
   * 
   * @param {number} lat - 纬度
   * @param {number} lng - 经度
   * @returns {Promise<Object>} 区域信息
   */
  async detectRegion(lat, lng) {
    const cacheKey = `region:${lat.toFixed(2)}:${lng.toFixed(2)}`;
    
    // 尝试从缓存获取
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 使用 PostGIS 查询区域
    const result = await this.pool.query(`
      SELECT 
        code, name, level, timezone, currency, language,
        compliance_rules
      FROM regions
      WHERE is_active = true
        AND ST_Contains(
          ST_GeomFromGeoJSON(geo_bounds::text),
          ST_Point($1, $2)
        )
      ORDER BY 
        CASE level 
          WHEN 'city' THEN 1 
          WHEN 'province' THEN 2 
          WHEN 'country' THEN 3 
        END
      LIMIT 1
    `, [lng, lat]);
    
    let region;
    
    if (result.rows.length > 0) {
      region = result.rows[0];
    } else {
      // 如果没有匹配的区域，使用 IP 地理位置或默认区域
      region = await this.detectRegionByIP(lat, lng);
    }
    
    // 缓存结果
    await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(region));
    
    return region;
  }

  /**
   * 通过 IP 地理位置检测区域（备用方案）
   */
  async detectRegionByIP(lat, lng) {
    // 简化实现：根据经纬度范围判断大致区域
    // 实际项目中可接入 MaxMind GeoIP 或类似服务
    
    const country = this.inferCountryFromCoords(lat, lng);
    
    const result = await this.pool.query(
      'SELECT * FROM regions WHERE code = $1 AND level = $2',
      [country, 'country']
    );
    
    return result.rows[0] || this.getDefaultRegion();
  }

  /**
   * 根据坐标推断国家代码
   */
  inferCountryFromCoords(lat, lng) {
    // 简化实现：基于经纬度范围
    if (lat >= 18 && lat <= 54 && lng >= 73 && lng <= 135) {
      return 'CN'; // 中国
    } else if (lat >= 24 && lat <= 46 && lng >= 122 && lng <= 154) {
      return 'JP'; // 日本
    } else if (lat >= 33 && lat <= 43 && lng >= 124 && lng <= 132) {
      return 'KR'; // 韩国
    } else if (lat >= 25 && lat <= 49 && lng >= -125 && lng <= -66) {
      return 'US'; // 美国
    }
    return 'US'; // 默认
  }

  /**
   * 获取默认区域配置
   */
  getDefaultRegion() {
    return {
      code: 'DEFAULT',
      name: 'Global',
      level: 'country',
      timezone: 'UTC',
      currency: 'USD',
      language: 'en-US',
      compliance_rules: {}
    };
  }

  /**
   * 获取区域精灵权重配置
   * 
   * @param {string} regionCode - 区域代码
   * @returns {Promise<Array>} 精灵权重列表
   */
  async getPokemonWeights(regionCode) {
    const cacheKey = `pokemon_weights:${regionCode}`;
    
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    const result = await this.pool.query(`
      SELECT 
        pokemon_id,
        spawn_weight,
        is_exclusive
      FROM active_region_pokemon_weights
      WHERE region_code = $1
    `, [regionCode]);
    
    const weights = result.rows;
    
    await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(weights));
    
    return weights;
  }

  /**
   * 应用区域精灵权重到刷新池
   * 
   * @param {Array} basePool - 基础刷新池
   * @param {string} regionCode - 区域代码
   * @returns {Promise<Array>} 调整后的刷新池
   */
  async applyRegionWeights(basePool, regionCode) {
    const weights = await this.getPokemonWeights(regionCode);
    const weightMap = new Map(weights.map(w => [w.pokemon_id, w]));
    
    return basePool.map(spawn => {
      const weight = weightMap.get(spawn.pokemon_id);
      
      if (weight) {
        return {
          ...spawn,
          spawn_weight: spawn.spawn_weight * weight.spawn_weight,
          is_exclusive: weight.is_exclusive
        };
      }
      
      return spawn;
    });
  }

  /**
   * 获取区域专属精灵列表
   * 
   * @param {string} regionCode - 区域代码
   * @returns {Promise<Array>} 专属精灵ID列表
   */
  async getExclusivePokemon(regionCode) {
    const result = await this.pool.query(`
      SELECT pokemon_id
      FROM region_pokemon_weights
      WHERE region_code = $1
        AND is_exclusive = true
        AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date IS NULL OR end_date >= NOW())
    `, [regionCode]);
    
    return result.rows.map(r => r.pokemon_id);
  }

  /**
   * 获取当前区域的活跃活动
   * 
   * @param {string} regionCode - 区域代码
   * @returns {Promise<Array>} 活动列表
   */
  async getActiveEvents(regionCode) {
    const cacheKey = `region_events:${regionCode}`;
    
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    const result = await this.pool.query(`
      SELECT 
        event_id,
        title,
        description,
        event_type,
        bonuses,
        start_time,
        end_time
      FROM region_events
      WHERE $1 = ANY(region_codes)
        AND is_active = true
        AND start_time <= NOW()
        AND end_time >= NOW()
      ORDER BY start_time DESC
    `, [regionCode]);
    
    const events = result.rows;
    
    await this.redis.setex(cacheKey, 60, JSON.stringify(events)); // 1分钟缓存
    
    return events;
  }

  /**
   * 应用合规过滤规则
   * 
   * @param {string} regionCode - 区域代码
   * @param {string} contentType - 内容类型
   * @param {Array} content - 内容列表
   * @returns {Promise<Array>} 过滤后的内容
   */
  async applyComplianceFilters(regionCode, contentType, content) {
    const rules = await this.getComplianceRules(regionCode, contentType);
    
    if (rules.length === 0) {
      return content;
    }
    
    return content.filter(item => {
      for (const rule of rules) {
        // 全局规则
        if (rule.content_id === null) {
          if (rule.filter_action === 'hide') {
            logger.info({ regionCode, contentType, action: 'global_hide' }, 'Applied global filter');
            return false;
          }
        }
        
        // 特定内容规则
        if (rule.content_id === item.id) {
          if (rule.filter_action === 'hide') {
            return false;
          } else if (rule.filter_action === 'modify' && rule.modified_content) {
            Object.assign(item, rule.modified_content);
          }
        }
      }
      
      return true;
    });
  }

  /**
   * 获取合规过滤规则
   * 
   * @param {string} regionCode - 区域代码
   * @param {string} contentType - 内容类型
   * @returns {Promise<Array>} 规则列表
   */
  async getComplianceRules(regionCode, contentType) {
    const result = await this.pool.query(`
      SELECT 
        content_type,
        content_id,
        filter_action,
        modified_content,
        reason
      FROM compliance_rules
      WHERE region_code = $1
        AND content_type = $2
    `, [regionCode, contentType]);
    
    return result.rows;
  }

  /**
   * 获取完整的区域配置（客户端API）
   * 
   * @param {number} lat - 纬度
   * @param {number} lng - 经度
   * @returns {Promise<Object>} 完整区域配置
   */
  async getRegionConfig(lat, lng) {
    const region = await this.detectRegion(lat, lng);
    
    const [exclusivePokemon, activeEvents] = await Promise.all([
      this.getExclusivePokemon(region.code),
      this.getActiveEvents(region.code)
    ]);
    
    return {
      region: {
        code: region.code,
        name: region.name,
        country: region.level === 'country' ? region.code : region.code.split('-')[0],
        timezone: region.timezone,
        currency: region.currency,
        language: region.language
      },
      spawnModifiers: {
        exclusivePokemon,
        weightMultiplier: 1.0 // 可根据活动调整
      },
      activeEvents: activeEvents.map(event => ({
        eventId: event.event_id,
        title: event.title,
        description: event.description,
        eventType: event.event_type,
        bonuses: event.bonuses,
        startTime: event.start_time,
        endTime: event.end_time
      })),
      compliance: region.compliance_rules || {}
    };
  }

  /**
   * 更新用户区域映射
   */
  async updateUserRegion(userId, regionCode) {
    await this.pool.query(`
      INSERT INTO user_regions (user_id, region_code, last_updated)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET region_code = $2, last_updated = NOW()
    `, [userId, regionCode]);
  }

  /**
   * 获取用户区域
   */
  async getUserRegion(userId) {
    const result = await this.pool.query(
      'SELECT region_code FROM user_regions WHERE user_id = $1',
      [userId]
    );
    
    return result.rows[0]?.region_code;
  }

  /**
   * 清除缓存
   */
  async clearCache() {
    const keys = await this.redis.keys('region:*');
    const weightKeys = await this.redis.keys('pokemon_weights:*');
    const eventKeys = await this.redis.keys('region_events:*');
    
    const allKeys = [...keys, ...weightKeys, ...eventKeys];
    
    if (allKeys.length > 0) {
      await this.redis.del(...allKeys);
      logger.info({ count: allKeys.length }, 'Cache cleared');
    }
  }

  /**
   * 关闭连接
   */
  async close() {
    await this.pool.end();
    await this.redis.quit();
  }
}

// 导出单例
let instance = null;

function getRegionManager(config) {
  if (!instance) {
    instance = new RegionManager(config);
  }
  return instance;
}

module.exports = {
  RegionManager,
  getRegionManager
};
