// backend/shared/habitatService.js
// REQ-00361: 精灵栖息地偏好与环境加成系统

'use strict';

const { query } = require('./db');
const { getJSON, setJSON } = require('./redis');

/**
 * 栖息地识别与加成计算服务
 */
class HabitatService {
  constructor() {
    this.cacheTimeout = 3600; // 1 小时缓存
  }

  /**
   * 基于地理位置识别栖息地类型
   * @param {number} latitude - 纬度
   * @param {number} longitude - 经度
   * @returns {Promise<{primary: string, secondary: string|null, confidence: number}>}
   */
  async identifyHabitat(latitude, longitude) {
    // 1. 检查缓存
    const cacheKey = `habitat:${latitude.toFixed(4)}:${longitude.toFixed(4)}`;
    const cached = await getJSON(cacheKey);
    if (cached) {
      return cached;
    }

    // 2. 检查自定义栖息地区域
    const customHabitat = await this.checkCustomHabitatArea(latitude, longitude);
    if (customHabitat) {
      await setJSON(cacheKey, customHabitat, this.cacheTimeout);
      return customHabitat;
    }

    // 3. 基于地形数据识别（简化版：使用启发式规则）
    const habitat = await this.identifyByTerrain(latitude, longitude);
    
    // 4. 缓存结果
    await setJSON(cacheKey, habitat, this.cacheTimeout);
    
    return habitat;
  }

  /**
   * 检查自定义栖息地区域
   */
  async checkCustomHabitatArea(latitude, longitude) {
    const result = await query(`
      SELECT 
        ha.habitat_id,
        ha.area_name,
        ha.radius_meters,
        ST_Distance(
          ST_MakePoint($1, $2)::geography,
          ST_MakePoint(ha.center_lon, ha.center_lat)::geography
        ) as distance
      FROM habitat_areas ha
      WHERE ha.is_active = TRUE
        AND ST_DWithin(
          ST_MakePoint(ha.center_lon, ha.center_lat)::geography,
          ST_MakePoint($2, $1)::geography,
          ha.radius_meters
        )
      ORDER BY distance ASC
      LIMIT 1
    `, [longitude, latitude]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const confidence = Math.max(0.7, 1 - (row.distance / row.radius_meters) * 0.3);
      
      return {
        primary: row.habitat_id,
        secondary: null,
        confidence: parseFloat(confidence.toFixed(2)),
        source: 'custom_area',
        area_name: row.area_name
      };
    }

    return null;
  }

  /**
   * 基于地形数据识别栖息地（启发式规则）
   */
  async identifyByTerrain(latitude, longitude) {
    // 简化版识别逻辑（实际项目中可集成 OpenStreetMap API）
    // 这里使用基于位置的启发式规则
    
    // 水域检测：检查是否靠近已知水域坐标
    const nearWater = await this.checkNearWaterBody(latitude, longitude);
    if (nearWater) {
      return {
        primary: 'water',
        secondary: null,
        confidence: 0.85,
        source: 'terrain_analysis'
      };
    }

    // 海岸检测：检查是否靠近海岸线
    const nearCoast = await this.checkNearCoastline(latitude, longitude);
    if (nearCoast) {
      return {
        primary: 'coastal',
        secondary: 'water',
        confidence: 0.80,
        source: 'terrain_analysis'
      };
    }

    // 山地检测：基于海拔（简化版，实际应使用 DEM 数据）
    const elevation = await this.getElevation(latitude, longitude);
    if (elevation > 500) {
      return {
        primary: 'mountain',
        secondary: null,
        confidence: 0.75,
        source: 'terrain_analysis'
      };
    }

    // 默认返回城市/森林/草原（基于人口密度估算）
    const populationDensity = await this.estimatePopulationDensity(latitude, longitude);
    
    if (populationDensity > 1000) {
      return {
        primary: 'urban',
        secondary: null,
        confidence: 0.70,
        source: 'population_estimate'
      };
    } else if (populationDensity < 100) {
      return {
        primary: 'forest',
        secondary: 'grassland',
        confidence: 0.65,
        source: 'population_estimate'
      };
    } else {
      return {
        primary: 'grassland',
        secondary: null,
        confidence: 0.70,
        source: 'population_estimate'
      };
    }
  }

  /**
   * 检查是否靠近水域（简化版）
   */
  async checkNearWaterBody(latitude, longitude) {
    // 实际项目中应集成 OpenStreetMap 或 Google Maps API
    // 这里使用简化逻辑：检查是否靠近已知湖泊/河流坐标
    const knownWaterBodies = [
      { lat: 39.9, lon: 116.4, radius: 5000 }, // 示例：北京某湖
      { lat: 31.2, lon: 121.5, radius: 5000 }  // 示例：上海某水域
    ];

    for (const water of knownWaterBodies) {
      const distance = this.haversineDistance(latitude, longitude, water.lat, water.lon);
      if (distance < water.radius) {
        return true;
      }
    }

    return false;
  }

  /**
   * 检查是否靠近海岸线（简化版）
   */
  async checkNearCoastline(latitude, longitude) {
    // 简化版：检查是否在海岸线附近（经度接近特定值）
    // 实际应使用 GIS 数据库
    const coastalThreshold = 500; // 米
    
    // 示例：中国东部海岸线附近
    if (longitude > 120 && longitude < 125 && latitude > 20 && latitude < 45) {
      return true;
    }

    return false;
  }

  /**
   * 获取海拔（简化版）
   */
  async getElevation(latitude, longitude) {
    // 实际应使用 DEM（数字高程模型）API
    // 这里返回随机值用于演示
    return Math.random() * 1000;
  }

  /**
   * 估算人口密度（简化版）
   */
  async estimatePopulationDensity(latitude, longitude) {
    // 实际应使用人口密度数据集
    // 简化版：根据坐标范围估算
    if (latitude > 30 && latitude < 40 && longitude > 100 && longitude < 125) {
      return 1500; // 高密度城市
    }
    return 50; // 低密度乡村
  }

  /**
   * 计算两点间距离（Haversine 公式）
   */
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球半径（米）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  /**
   * 获取精灵的栖息地偏好
   * @param {string} speciesId - 精灵物种 ID
   * @returns {Promise<Array>}
   */
  async getPokemonHabitatPreferences(speciesId) {
    const result = await query(`
      SELECT 
        php.*,
        h.name as habitat_name,
        h.name_en as habitat_name_en,
        h.icon_url
      FROM pokemon_habitat_preferences php
      JOIN habitats h ON php.habitat_id = h.id
      WHERE php.species_id = $1
      ORDER BY php.priority ASC
    `, [speciesId]);

    return result.rows;
  }

  /**
   * 计算精灵在特定栖息地的战斗加成
   * @param {string} speciesId - 精灵物种 ID
   * @param {object} habitat - 栖息地信息 {primary, secondary, confidence}
   * @returns {Promise<{multiplier: number, habitatMatch: boolean}>}
   */
  async calculateBattleBonus(speciesId, habitat) {
    const preferences = await this.getPokemonHabitatPreferences(speciesId);
    
    if (!preferences || preferences.length === 0) {
      return { multiplier: 1.0, habitatMatch: false };
    }

    // 检查主要栖息地匹配
    const primaryMatch = preferences.find(p => p.habitat_id === habitat.primary);
    if (primaryMatch) {
      const confidenceBonus = habitat.confidence;
      const finalMultiplier = primaryMatch.battle_bonus * confidenceBonus;
      return {
        multiplier: Math.min(finalMultiplier, 1.5), // 上限 1.5x
        habitatMatch: true,
        matchedHabitat: primaryMatch.habitat_id,
        isPrimary: primaryMatch.is_primary
      };
    }

    // 检查次要栖息地匹配
    if (habitat.secondary) {
      const secondaryMatch = preferences.find(p => p.habitat_id === habitat.secondary);
      if (secondaryMatch) {
        const confidenceBonus = habitat.confidence * 0.8;
        const finalMultiplier = secondaryMatch.battle_bonus * confidenceBonus;
        return {
          multiplier: Math.min(finalMultiplier, 1.3),
          habitatMatch: true,
          matchedHabitat: secondaryMatch.habitat_id,
          isPrimary: secondaryMatch.is_primary
        };
      }
    }

    return { multiplier: 1.0, habitatMatch: false };
  }

  /**
   * 计算精灵在特定栖息地的捕捉加成
   * @param {string} speciesId - 精灵物种 ID
   * @param {object} habitat - 栖息地信息
   * @returns {Promise<{multiplier: number, habitatMatch: boolean}>}
   */
  async calculateCatchBonus(speciesId, habitat) {
    const preferences = await this.getPokemonHabitatPreferences(speciesId);
    
    if (!preferences || preferences.length === 0) {
      return { multiplier: 1.0, habitatMatch: false };
    }

    const primaryMatch = preferences.find(p => p.habitat_id === habitat.primary);
    if (primaryMatch) {
      const finalMultiplier = primaryMatch.catch_bonus * habitat.confidence;
      return {
        multiplier: Math.min(finalMultiplier, 1.3),
        habitatMatch: true,
        matchedHabitat: primaryMatch.habitat_id
      };
    }

    if (habitat.secondary) {
      const secondaryMatch = preferences.find(p => p.habitat_id === habitat.secondary);
      if (secondaryMatch) {
        const finalMultiplier = secondaryMatch.catch_bonus * habitat.confidence * 0.9;
        return {
          multiplier: Math.min(finalMultiplier, 1.2),
          habitatMatch: true,
          matchedHabitat: secondaryMatch.habitat_id
        };
      }
    }

    return { multiplier: 1.0, habitatMatch: false };
  }

  /**
   * 获取栖息地内推荐的精灵列表
   * @param {object} habitat - 栖息地信息
   * @param {number} limit - 返回数量限制
   * @returns {Promise<Array>}
   */
  async getRecommendedPokemon(habitat, limit = 10) {
    const result = await query(`
      SELECT 
        php.species_id,
        php.battle_bonus,
        php.catch_bonus,
        php.spawn_boost,
        php.is_primary,
        h.name as habitat_name
      FROM pokemon_habitat_preferences php
      JOIN habitats h ON php.habitat_id = h.id
      WHERE php.habitat_id = $1
      ORDER BY php.battle_bonus DESC, php.spawn_boost DESC
      LIMIT $2
    `, [habitat.primary, limit]);

    return result.rows;
  }

  /**
   * 更新用户当前位置的栖息地缓存
   */
  async updateUserHabitatCache(userId, latitude, longitude) {
    const habitat = await this.identifyHabitat(latitude, longitude);
    
    await query(`
      INSERT INTO user_habitat_cache (user_id, current_habitat, last_location_lat, last_location_lon, confidence, identified_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '1 hour')
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        current_habitat = $2,
        last_location_lat = $3,
        last_location_lon = $4,
        confidence = $5,
        identified_at = NOW(),
        expires_at = NOW() + INTERVAL '1 hour'
    `, [userId, habitat.primary, latitude, longitude, habitat.confidence]);

    return habitat;
  }

  /**
   * 获取用户缓存的栖息地信息
   */
  async getUserHabitatCache(userId) {
    const result = await query(`
      SELECT * FROM user_habitat_cache
      WHERE user_id = $1 AND expires_at > NOW()
    `, [userId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      primary: row.current_habitat,
      secondary: null,
      confidence: parseFloat(row.confidence),
      latitude: parseFloat(row.last_location_lat),
      longitude: parseFloat(row.last_location_lon)
    };
  }

  /**
   * 获取所有栖息地类型列表
   */
  async getAllHabitats() {
    const result = await query(`
      SELECT * FROM habitats
      ORDER BY name ASC
    `);

    return result.rows;
  }
}

// 导出单例
const habitatService = new HabitatService();
module.exports = { HabitatService, habitatService };