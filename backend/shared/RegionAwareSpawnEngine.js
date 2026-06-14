/**
 * 区域感知精灵刷新引擎
 * 
 * 功能：
 * 1. 根据用户区域调整精灵刷新池
 * 2. 应用区域活动加成
 * 3. 合规内容过滤
 * 
 * @module RegionAwareSpawnEngine
 * @requirement REQ-00083
 */

'use strict';

const { getRegionManager } = require('./RegionManager');
const { createLogger } = require('./logger');

const logger = createLogger('RegionAwareSpawnEngine');

/**
 * 区域感知精灵刷新引擎
 */
class RegionAwareSpawnEngine {
  /**
   * @param {Object} options - 配置选项
   */
  constructor(options = {}) {
    this.regionManager = getRegionManager();
    this.enableRegionWeights = options.enableRegionWeights !== false;
    this.enableEvents = options.enableEvents !== false;
    this.enableCompliance = options.enableCompliance !== false;
  }

  /**
   * 生成区域化的精灵刷新池
   * 
   * @param {number} lat - 纬度
   * @param {number} lng - 经度
   * @param {number} radius - 半径（米）
   * @param {Object} basePool - 基础刷新池配置
   * @returns {Promise<Object>} 区域化刷新池
   */
  async generateSpawnPool(lat, lng, radius, basePool = {}) {
    const startTime = Date.now();
    
    try {
      // 1. 检测用户区域
      const region = await this.regionManager.detectRegion(lat, lng);
      logger.debug({ lat, lng, region: region.code }, 'Region detected');
      
      // 2. 生成基础刷新池
      let spawnPool = this.generateBaseSpawnPool(basePool);
      
      // 3. 应用区域权重
      if (this.enableRegionWeights) {
        spawnPool = await this.applyRegionWeights(spawnPool, region.code);
      }
      
      // 4. 获取活跃活动并应用加成
      let activeEvents = [];
      if (this.enableEvents) {
        activeEvents = await this.regionManager.getActiveEvents(region.code);
        spawnPool = this.applyEventBonuses(spawnPool, activeEvents);
      }
      
      // 5. 应用合规过滤
      if (this.enableCompliance) {
        spawnPool = await this.applyComplianceFilters(spawnPool, region.code);
      }
      
      // 6. 添加区域专属精灵
      const exclusivePokemon = await this.regionManager.getExclusivePokemon(region.code);
      spawnPool = this.addExclusivePokemon(spawnPool, exclusivePokemon);
      
      const duration = Date.now() - startTime;
      logger.info({
        region: region.code,
        poolSize: spawnPool.length,
        events: activeEvents.length,
        exclusive: exclusivePokemon.length,
        duration
      }, 'Region-aware spawn pool generated');
      
      return {
        region: region.code,
        spawnPool,
        activeEvents,
        exclusivePokemon,
        metadata: {
          generatedAt: new Date().toISOString(),
          generationTimeMs: duration
        }
      };
    } catch (err) {
      logger.error({ err, lat, lng }, 'Failed to generate spawn pool');
      throw err;
    }
  }

  /**
   * 生成基础刷新池
   */
  generateBaseSpawnPool(config) {
    const {
      common = [],
      uncommon = [],
      rare = [],
      ultra_rare = [],
      legendary = []
    } = config;
    
    // 基础权重
    const pool = [];
    
    // 普通精灵（60%）
    common.forEach(pokemon => {
      pool.push({
        pokemon_id: pokemon.id,
        spawn_weight: pokemon.weight || 0.6,
        rarity: 'common'
      });
    });
    
    // 稀有精灵（25%）
    uncommon.forEach(pokemon => {
      pool.push({
        pokemon_id: pokemon.id,
        spawn_weight: pokemon.weight || 0.25,
        rarity: 'uncommon'
      });
    });
    
    // 稀有精灵（10%）
    rare.forEach(pokemon => {
      pool.push({
        pokemon_id: pokemon.id,
        spawn_weight: pokemon.weight || 0.1,
        rarity: 'rare'
      });
    });
    
    // 超稀有精灵（4%）
    ultra_rare.forEach(pokemon => {
      pool.push({
        pokemon_id: pokemon.id,
        spawn_weight: pokemon.weight || 0.04,
        rarity: 'ultra_rare'
      });
    });
    
    // 传说精灵（1%）
    legendary.forEach(pokemon => {
      pool.push({
        pokemon_id: pokemon.id,
        spawn_weight: pokemon.weight || 0.01,
        rarity: 'legendary'
      });
    });
    
    return pool;
  }

  /**
   * 应用区域权重
   */
  async applyRegionWeights(spawnPool, regionCode) {
    const weights = await this.regionManager.getPokemonWeights(regionCode);
    const weightMap = new Map(weights.map(w => [w.pokemon_id, w]));
    
    return spawnPool.map(spawn => {
      const regionWeight = weightMap.get(spawn.pokemon_id);
      
      if (regionWeight) {
        return {
          ...spawn,
          spawn_weight: spawn.spawn_weight * regionWeight.spawn_weight,
          region_modified: true,
          region_exclusive: regionWeight.is_exclusive
        };
      }
      
      return spawn;
    });
  }

  /**
   * 应用活动加成
   */
  applyEventBonuses(spawnPool, events) {
    if (events.length === 0) {
      return spawnPool;
    }
    
    // 找出精灵刷新加成活动
    const spawnBonusEvents = events.filter(e => 
      e.event_type === 'spawn_bonus' || e.event_type === 'special_pokemon'
    );
    
    if (spawnBonusEvents.length === 0) {
      return spawnPool;
    }
    
    return spawnPool.map(spawn => {
      let totalMultiplier = 1.0;
      const appliedEvents = [];
      
      for (const event of spawnBonusEvents) {
        const bonus = event.bonuses;
        
        // 特定精灵加成
        if (bonus.pokemon_ids && bonus.pokemon_ids.includes(spawn.pokemon_id)) {
          totalMultiplier *= bonus.spawn_multiplier || 2.0;
          appliedEvents.push(event.event_id);
        }
        
        // 类型加成
        if (bonus.pokemon_types && spawn.types) {
          const hasMatchingType = spawn.types.some(t => bonus.pokemon_types.includes(t));
          if (hasMatchingType) {
            totalMultiplier *= bonus.spawn_multiplier || 1.5;
            appliedEvents.push(event.event_id);
          }
        }
        
        // 全局加成
        if (!bonus.pokemon_ids && !bonus.pokemon_types) {
          totalMultiplier *= bonus.spawn_multiplier || 1.0;
          appliedEvents.push(event.event_id);
        }
      }
      
      return {
        ...spawn,
        spawn_weight: spawn.spawn_weight * totalMultiplier,
        event_bonus: appliedEvents.length > 0,
        applied_events: appliedEvents
      };
    });
  }

  /**
   * 应用合规过滤
   */
  async applyComplianceFilters(spawnPool, regionCode) {
    const rules = await this.regionManager.getComplianceRules(regionCode, 'pokemon');
    
    if (rules.length === 0) {
      return spawnPool;
    }
    
    return spawnPool.filter(spawn => {
      for (const rule of rules) {
        // 全局隐藏规则
        if (rule.content_id === null && rule.filter_action === 'hide') {
          logger.warn({ regionCode, action: 'global_pokemon_hide' }, 
            'Global pokemon hide rule detected');
          return false;
        }
        
        // 特定精灵隐藏规则
        if (rule.content_id === spawn.pokemon_id && rule.filter_action === 'hide') {
          logger.debug({
            regionCode,
            pokemon_id: spawn.pokemon_id,
            reason: rule.reason
          }, 'Pokemon filtered by compliance rule');
          
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * 添加区域专属精灵
   */
  addExclusivePokemon(spawnPool, exclusiveIds) {
    if (exclusiveIds.length === 0) {
      return spawnPool;
    }
    
    // 为区域专属精灵添加权重
    exclusiveIds.forEach(pokemonId => {
      // 检查是否已在池中
      const existing = spawnPool.find(s => s.pokemon_id === pokemonId);
      
      if (!existing) {
        // 添加新的专属精灵
        spawnPool.push({
          pokemon_id: pokemonId,
          spawn_weight: 0.05, // 中等权重
          rarity: 'regional_exclusive',
          is_exclusive: true,
          region_exclusive: true
        });
      } else {
        // 标记为专属
        existing.is_exclusive = true;
        existing.region_exclusive = true;
      }
    });
    
    return spawnPool;
  }

  /**
   * 根据刷新池随机选择精灵
   * 
   * @param {Array} spawnPool - 刷新池
   * @param {number} count - 数量
   * @returns {Array} 选中的精灵
   */
  selectRandomPokemon(spawnPool, count = 1) {
    const totalWeight = spawnPool.reduce((sum, s) => sum + s.spawn_weight, 0);
    const selected = [];
    
    for (let i = 0; i < count; i++) {
      const random = Math.random() * totalWeight;
      let cumulative = 0;
      
      for (const spawn of spawnPool) {
        cumulative += spawn.spawn_weight;
        if (random <= cumulative) {
          selected.push({
            pokemon_id: spawn.pokemon_id,
            rarity: spawn.rarity,
            spawn_weight: spawn.spawn_weight,
            is_exclusive: spawn.is_exclusive || false
          });
          break;
        }
      }
    }
    
    return selected;
  }

  /**
   * 预热区域缓存
   */
  async warmupCache(regionCodes) {
    for (const code of regionCodes) {
      await Promise.all([
        this.regionManager.getPokemonWeights(code),
        this.regionManager.getActiveEvents(code)
      ]);
      
      logger.debug({ region: code }, 'Cache warmed');
    }
  }
}

module.exports = {
  RegionAwareSpawnEngine
};
