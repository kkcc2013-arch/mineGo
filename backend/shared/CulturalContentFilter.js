// backend/shared/CulturalContentFilter.js
// REQ-00495: 文化敏感内容本地化过滤与合规适配系统
'use strict';

const { query } = require('./db');
const { getRedis, getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');

const logger = createLogger('cultural-filter');

class CulturalContentFilter {
  constructor(dbPool = null, redisClient = null) {
    this.db = dbPool;
    this.redis = redisClient;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
  }

  /**
   * 过滤实体列表，移除或替换地区敏感内容
   * @param {Array} entities - 精灵/道具/技能列表
   * @param {string} regionCode - 用户所在地区（ISO 3166-1 alpha-2）
   * @param {number} userAge - 用户年龄（用于年龄分级过滤）
   * @param {string} language - 用户语言偏好
   * @returns {Array} 过滤后的实体列表
   */
  async filterEntities(entities, regionCode, userAge = null, language = 'en') {
    if (!entities || entities.length === 0) {
      return [];
    }

    const startTime = Date.now();
    let filteredCount = 0;
    let modifiedCount = 0;

    try {
      // 加载地区规则（带缓存）
      const regionRules = await this.loadRegionRules(regionCode);
      
      const results = [];
      
      for (const entity of entities) {
        // 检查实体是否受地区限制
        const restriction = await this.checkEntityRestriction(
          entity.type || entity.entity_type,
          entity.id || entity.entity_id,
          regionCode
        );

        // 完全屏蔽
        if (restriction.level === 'blocked') {
          filteredCount++;
          logger.debug({
            entityType: entity.type,
            entityId: entity.id,
            regionCode,
            reason: restriction.reason
          }, 'Entity blocked by region restriction');
          continue;
        }

        // 内容修改（如改名、换图）
        if (restriction.level === 'modified' && restriction.alternative) {
          const modifiedEntity = this.applyModification(entity, restriction, language);
          modifiedCount++;
          results.push(modifiedEntity);
          continue;
        }

        // 年龄分级检查
        if (restriction.level === 'restricted' || entity.age_restricted) {
          const ageRating = await this.getAgeRating(
            entity.type || entity.entity_type,
            entity.id || entity.entity_id,
            regionCode
          );
          
          if (ageRating && userAge !== null && userAge < ageRating.minAge) {
            filteredCount++;
            logger.debug({
              entityType: entity.type,
              entityId: entity.id,
              userAge,
              minAge: ageRating.minAge,
              regionCode
            }, 'Entity filtered by age rating');
            continue;
          }

          // 添加年龄分级标记
          if (ageRating) {
            entity.age_rating = ageRating;
          }
        }

        // 应用文化规则（改名、警告等）
        const culturalModification = await this.applyCulturalRules(entity, regionRules, language);
        if (culturalModification.modified) {
          modifiedCount++;
        }
        
        results.push(culturalModification.entity);
      }

      const duration = Date.now() - startTime;
      logger.info({
        regionCode,
        inputCount: entities.length,
        outputCount: results.length,
        filteredCount,
        modifiedCount,
        durationMs: duration
      }, 'Cultural filtering completed');

      return results;
    } catch (err) {
      logger.error({ err, regionCode }, 'Cultural filtering failed');
      // 失败时返回原列表（降级）
      return entities;
    }
  }

  /**
   * 检查实体是否受地区限制
   */
  async checkEntityRestriction(entityType, entityId, regionCode) {
    const cacheKey = `${entityType}:${entityId}:${regionCode}`;
    
    // 检查内存缓存
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await query(`
        SELECT 
          restriction_level,
          reason,
          alternative_content,
          effective_from,
          effective_until
        FROM region_restricted_entities
        WHERE entity_type = $1 
          AND entity_id = $2 
          AND region_code = $3
          AND (effective_from IS NULL OR effective_from <= NOW())
          AND (effective_until IS NULL OR effective_until >= NOW())
        LIMIT 1
      `, [entityType, entityId, regionCode]);

      const result = rows.length > 0 ? {
        level: rows[0].restriction_level,
        reason: rows[0].reason,
        alternative: rows[0].alternative_content
      } : { level: 'none' };

      // 缓存结果
      this.cache.set(cacheKey, result);
      setTimeout(() => this.cache.delete(cacheKey), this.cacheTimeout);

      return result;
    } catch (err) {
      logger.error({ err, entityType, entityId, regionCode }, 'Failed to check entity restriction');
      return { level: 'none' };
    }
  }

  /**
   * 应用内容修改
   */
  applyModification(entity, restriction, language) {
    const modified = { ...entity };
    const alternative = restriction.alternative;

    if (!alternative) {
      return modified;
    }

    // 替换名称
    if (alternative.name && alternative.name[language]) {
      modified.name = alternative.name[language];
      modified.original_name = entity.name;
      modified.localized = true;
    }

    // 替换描述
    if (alternative.description && alternative.description[language]) {
      modified.description = alternative.description[language];
      modified.original_description = entity.description;
    }

    // 替换图片
    if (alternative.image_url) {
      modified.image_url = alternative.image_url;
      modified.original_image_url = entity.image_url;
    }

    return modified;
  }

  /**
   * 应用文化规则
   */
  async applyCulturalRules(entity, regionRules, language) {
    const entityType = entity.type || entity.entity_type;
    const entityId = entity.id || entity.entity_id;
    
    let modified = false;
    const result = { ...entity };

    for (const rule of regionRules) {
      if (rule.entity_type === entityType && 
          (rule.entity_id === entityId || rule.entity_id === null)) {
        
        switch (rule.restriction_type) {
          case 'rename':
            if (rule.alternative_content?.name?.[language]) {
              result.name = rule.alternative_content.name[language];
              result.original_name = entity.name;
              modified = true;
            }
            break;
          
          case 'warn':
            result.cultural_warning = {
              level: rule.sensitivity_level,
              context: rule.cultural_context
            };
            modified = true;
            break;
          
          case 'age_gate':
            result.age_gate_required = true;
            result.min_age = this.getMinAgeForSensitivity(rule.sensitivity_level);
            modified = true;
            break;
          
          case 'replace_image':
            if (rule.alternative_content?.image_url) {
              result.image_url = rule.alternative_content.image_url;
              result.original_image_url = entity.image_url;
              modified = true;
            }
            break;
        }
      }
    }

    return { entity: result, modified };
  }

  /**
   * 加载地区规则
   */
  async loadRegionRules(regionCode) {
    const cacheKey = `rules:${regionCode}`;
    
    // 检查内存缓存
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await query(`
        SELECT *
        FROM v_active_cultural_rules
        WHERE $1 = ANY(ARRAY(SELECT jsonb_array_elements_text(affected_regions)))
        ORDER BY priority DESC
      `, [regionCode]);

      // 缓存结果
      this.cache.set(cacheKey, rows);
      setTimeout(() => this.cache.delete(cacheKey), this.cacheTimeout);

      return rows;
    } catch (err) {
      logger.error({ err, regionCode }, 'Failed to load region rules');
      return [];
    }
  }

  /**
   * 获取实体年龄分级
   */
  async getAgeRating(entityType, entityId, regionCode) {
    const ratingSystem = this.getRatingSystemForRegion(regionCode);
    
    try {
      const { rows } = await query(`
        SELECT age_rating, content_descriptors
        FROM content_age_ratings
        WHERE entity_type = $1 AND entity_id = $2 
          AND rating_system = $3 
          AND region_code = $4
        LIMIT 1
      `, [entityType, entityId, ratingSystem, regionCode]);

      if (rows.length === 0) {
        return null;
      }

      return {
        rating: rows[0].age_rating,
        minAge: this.ageRatingToMinAge(rows[0].age_rating, ratingSystem),
        descriptors: rows[0].content_descriptors,
        system: ratingSystem
      };
    } catch (err) {
      logger.error({ err, entityType, entityId, regionCode }, 'Failed to get age rating');
      return null;
    }
  }

  /**
   * 根据地区获取分级系统
   */
  getRatingSystemForRegion(regionCode) {
    const regionToRating = {
      'US': 'ESRB', 'CA': 'ESRB',
      'GB': 'PEGI', 'DE': 'PEGI', 'FR': 'PEGI', 'IT': 'PEGI', 'ES': 'PEGI',
      'JP': 'CERO',
      'CN': 'CADPA',
      'KR': 'GRAC',
      'AU': 'ACB'
    };
    return regionToRating[regionCode] || 'PEGI';
  }

  /**
   * 年龄分级转换为最低年龄
   */
  ageRatingToMinAge(rating, system) {
    const ageMap = {
      'PEGI': { '3': 3, '7': 7, '12': 12, '16': 16, '18': 18 },
      'ESRB': { 'E': 6, 'E10+': 10, 'T': 13, 'M': 17, 'AO': 18 },
      'CERO': { 'A': 3, 'B': 12, 'C': 15, 'D': 17, 'Z': 18 },
      'CADPA': { '8+': 8, '12+': 12, '16+': 16, '18+': 18 },
      'GRAC': { 'ALL': 3, '12': 12, '15': 15, '18': 18 },
      'ACB': { 'G': 0, 'PG': 8, 'M': 15, 'MA15+': 15, 'R18+': 18 }
    };
    return ageMap[system]?.[rating] || 0;
  }

  /**
   * 敏感度级别转最小年龄
   */
  getMinAgeForSensitivity(level) {
    const sensitivityToAge = {
      'low': 12,
      'medium': 16,
      'high': 18,
      'critical': 21
    };
    return sensitivityToAge[level] || 0;
  }

  /**
   * 检查活动是否在地区启用
   */
  async isActivityEnabled(activityId, regionCode) {
    try {
      const { rows } = await query(`
        SELECT restriction_type
        FROM cultural_content_rules
        WHERE entity_type = 'activity'
          AND entity_id = $1
          AND $2 = ANY(ARRAY(SELECT jsonb_array_elements_text(affected_regions)))
          AND restriction_type = 'hide'
      `, [activityId, regionCode]);

      return rows.length === 0;
    } catch (err) {
      logger.error({ err, activityId, regionCode }, 'Failed to check activity status');
      return true; // 默认启用
    }
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache.clear();
    logger.info('Cultural filter cache cleared');
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      timeout: this.cacheTimeout
    };
  }
}

// 单例实例
let instance = null;

/**
 * 获取或创建 CulturalContentFilter 实例
 */
function getCulturalContentFilter(dbPool, redisClient) {
  if (!instance) {
    instance = new CulturalContentFilter(dbPool, redisClient);
  }
  return instance;
}

module.exports = {
  CulturalContentFilter,
  getCulturalContentFilter
};
