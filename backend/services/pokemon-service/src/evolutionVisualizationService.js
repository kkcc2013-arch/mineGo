/**
 * REQ-00355: 精灵进化路径可视化系统
 * 进化路径可视化服务
 */

const { query, transaction, getPoolManagerInstance } = require('../../../shared/db');
const { getRedis } = require('../../../shared/redis');
const { logger } = require('../../../shared/logger');
const promClient = require('prom-client');

// Prometheus 指标
const metrics = {
  evolutionChainQueries: new promClient.Counter({
    name: 'evolution_chain_queries_total',
    help: 'Total evolution chain queries',
    labelNames: ['species_id', 'has_data']
  }),
  
  evolutionPathCalculations: new promClient.Histogram({
    name: 'evolution_path_calculation_duration_seconds',
    help: 'Duration of evolution path calculations',
    buckets: [0.01, 0.05, 0.1, 0.5, 1]
  }),
  
  evolutionPreviewsGenerated: new promClient.Counter({
    name: 'evolution_previews_generated_total',
    help: 'Total evolution previews generated',
    labelNames: ['evolution_type']
  })
};

/**
 * 进化类型枚举
 */
const EVOLUTION_TYPES = {
  LEVEL: 'level',
  ITEM: 'item',
  FRIENDSHIP: 'friendship',
  TIME: 'time',
  LOCATION: 'location',
  TRADE: 'trade',
  SPECIAL: 'special'
};

/**
 * 进化类型名称多语言映射
 */
const EVOLUTION_TYPE_NAMES = {
  zh: {
    [EVOLUTION_TYPES.LEVEL]: '等级进化',
    [EVOLUTION_TYPES.ITEM]: '道具进化',
    [EVOLUTION_TYPES.FRIENDSHIP]: '亲密度进化',
    [EVOLUTION_TYPES.TIME]: '时间进化',
    [EVOLUTION_TYPES.LOCATION]: '地点进化',
    [EVOLUTION_TYPES.TRADE]: '交换进化',
    [EVOLUTION_TYPES.SPECIAL]: '特殊进化'
  },
  en: {
    [EVOLUTION_TYPES.LEVEL]: 'Level Up',
    [EVOLUTION_TYPES.ITEM]: 'Item Evolution',
    [EVOLUTION_TYPES.FRIENDSHIP]: 'Friendship Evolution',
    [EVOLUTION_TYPES.TIME]: 'Time-Based Evolution',
    [EVOLUTION_TYPES.LOCATION]: 'Location Evolution',
    [EVOLUTION_TYPES.TRADE]: 'Trade Evolution',
    [EVOLUTION_TYPES.SPECIAL]: 'Special Evolution'
  }
};

class EvolutionVisualizationService {
  constructor() {
    this.db = getPoolManagerInstance().getPool(process.env.SERVICE_NAME || 'pokemon-service');
    this.redis = getRedis();
    this.cachePrefix = 'evolution:viz:';
  }

  /**
   * 获取精灵进化链（完整树形结构）
   * @param {number} speciesId - 精灵物种 ID
   * @param {string} language - 语言代码
   * @returns {Promise<Object>} 进化链数据
   */
  async getEvolutionChain(speciesId, language = 'zh') {
    const cacheKey = `${this.cachePrefix}chain:${speciesId}:${language}`;
    
    try {
      // 尝试从缓存获取
      const cached = await this.redis?.get(cacheKey);
      if (cached) {
        metrics.evolutionChainQueries.labels(speciesId, 'cached').inc();
        return JSON.parse(cached);
      }
      
      const timer = metrics.evolutionPathCalculations.startTimer();
      
      // 查找精灵所属的进化链
      const { rows: [node] } = await query(`
        SELECT en.*, ec.chain_name, ec.description
        FROM evolution_nodes en
        JOIN evolution_chains ec ON en.chain_id = ec.id
        WHERE en.pokemon_species_id = $1
      `, [speciesId]);
      
      if (!node) {
        // 如果没有进化链数据，从 pokemon_species 生成基础进化链
        const basicChain = await this.generateBasicEvolutionChain(speciesId, language);
        metrics.evolutionChainQueries.labels(speciesId, 'basic').inc();
        return basicChain;
      }
      
      // 获取该进化链的所有节点和路径
      const evolutionChain = await this.buildEvolutionTree(node.chain_id, language);
      
      // 缓存结果（1小时）
      await this.redis?.setex(cacheKey, 3600, JSON.stringify(evolutionChain));
      
      metrics.evolutionChainQueries.labels(speciesId, 'full').inc();
      timer();
      
      return evolutionChain;
    } catch (error) {
      logger.error('Failed to get evolution chain', { speciesId, error: error.message });
      throw error;
    }
  }

  /**
   * 构建进化树形结构
   */
  async buildEvolutionTree(chainId, language) {
    // 获取所有节点
    const { rows: nodes } = await query(`
      SELECT en.*, ps.name_zh, ps.name_en, ps.type1, ps.type2, 
             ps.base_attack, ps.base_defense, ps.base_hp,
             ps.sprite_url, ps.sprite_shiny_url, ps.rarity
      FROM evolution_nodes en
      JOIN pokemon_species ps ON en.pokemon_species_id = ps.id
      WHERE en.chain_id = $1
      ORDER BY en.node_position->>'level'::int
    `, [chainId]);
    
    // 获取所有路径
    const { rows: paths } = await query(`
      SELECT ep.*, ecd.description, ecd.hint
      FROM evolution_paths ep
      LEFT JOIN evolution_condition_descriptions ecd 
        ON ep.id = ecd.evolution_path_id AND ecd.language_code = $1
      WHERE ep.from_node_id IN (SELECT id FROM evolution_nodes WHERE chain_id = $2)
    `, [language, chainId]);
    
    // 构建节点映射
    const nodeMap = {};
    nodes.forEach(node => {
      nodeMap[node.id] = {
        id: node.id,
        speciesId: node.pokemon_species_id,
        name: language === 'zh' ? node.name_zh : node.name_en,
        types: [node.type1, node.type2].filter(Boolean),
        stats: {
          attack: node.base_attack,
          defense: node.base_defense,
          hp: node.base_hp
        },
        sprite: node.sprite_url,
        spriteShiny: node.sprite_shiny_url,
        rarity: node.rarity,
        position: node.node_position,
        isRoot: node.is_root,
        evolutionPaths: []
      };
    });
    
    // 添加进化路径
    paths.forEach(path => {
      const fromNode = nodeMap[path.from_node_id];
      if (fromNode) {
        fromNode.evolutionPaths.push({
          targetNodeId: path.to_node_id,
          targetSpeciesId: nodes.find(n => n.id === path.to_node_id)?.pokemon_species_id,
          evolutionType: path.evolution_type,
          evolutionTypeName: EVOLUTION_TYPE_NAMES[language]?.[path.evolution_type] || path.evolution_type,
          conditions: path.conditions,
          statChanges: path.stat_changes,
          isHidden: path.is_hidden,
          description: path.description,
          hint: path.hint
        });
      }
    });
    
    // 找到根节点
    const rootNode = nodes.find(n => n.is_root);
    
    return {
      chainId,
      nodes: Object.values(nodeMap),
      rootSpeciesId: rootNode?.pokemon_species_id,
      totalStages: Math.max(...nodes.map(n => n.node_position?.level || 1)),
      hasBranches: paths.some(p => {
        const fromPaths = paths.filter(fp => fp.from_node_id === p.from_node_id);
        return fromPaths.length > 1;
      })
    };
  }

  /**
   * 从 pokemon_species 生成基础进化链（兼容旧数据）
   */
  async generateBasicEvolutionChain(speciesId, language) {
    const { rows: [current] } = await query(`
      SELECT id, name_zh, name_en, type1, type2, 
             base_attack, base_defense, base_hp,
             sprite_url, sprite_shiny_url, rarity,
             candy_to_evolve, evolves_to
      FROM pokemon_species
      WHERE id = $1
    `, [speciesId]);
    
    if (!current) {
      return null;
    }
    
    const nodes = [{
      id: 1,
      speciesId: current.id,
      name: language === 'zh' ? current.name_zh : current.name_en,
      types: [current.type1, current.type2].filter(Boolean),
      stats: {
        attack: current.base_attack,
        defense: current.base_defense,
        hp: current.base_hp
      },
      sprite: current.sprite_url,
      spriteShiny: current.sprite_shiny_url,
      rarity: current.rarity,
      position: { x: 0, y: 0, level: 1 },
      isRoot: true,
      evolutionPaths: []
    }];
    
    // 如果有进化目标
    if (current.evolves_to) {
      const { rows: [evolved] } = await query(`
        SELECT id, name_zh, name_en, type1, type2, 
               base_attack, base_defense, base_hp,
               sprite_url, sprite_shiny_url, rarity
        FROM pokemon_species
        WHERE id = $1
      `, [current.evolves_to]);
      
      if (evolved) {
        nodes.push({
          id: 2,
          speciesId: evolved.id,
          name: language === 'zh' ? evolved.name_zh : evolved.name_en,
          types: [evolved.type1, evolved.type2].filter(Boolean),
          stats: {
            attack: evolved.base_attack,
            defense: evolved.base_defense,
            hp: evolved.base_hp
          },
          sprite: evolved.sprite_url,
          spriteShiny: evolved.sprite_shiny_url,
          rarity: evolved.rarity,
          position: { x: 200, y: 0, level: 2 },
          isRoot: false,
          evolutionPaths: []
        });
        
        nodes[0].evolutionPaths.push({
          targetNodeId: 2,
          targetSpeciesId: evolved.id,
          evolutionType: EVOLUTION_TYPES.LEVEL,
          evolutionTypeName: EVOLUTION_TYPE_NAMES[language]?.level || 'Level Up',
          conditions: {
            min_level: 1,
            candy_required: current.candy_to_evolve || 25
          },
          statChanges: {
            attack: evolved.base_attack - current.base_attack,
            defense: evolved.base_defense - current.base_defense,
            hp: evolved.base_hp - current.base_hp
          },
          isHidden: false,
          description: `${current.candy_to_evolve || 25} candies required`
        });
      }
    }
    
    return {
      chainId: null,
      nodes,
      rootSpeciesId: speciesId,
      totalStages: nodes.length,
      hasBranches: false,
      isBasic: true
    };
  }

  /**
   * 获取用户精灵的进化预览（具体属性变化）
   * @param {number} userId - 用户 ID
   * @param {number} pokemonInstanceId - 精灵实例 ID
   * @param {number} targetSpeciesId - 目标物种 ID
   * @returns {Promise<Object>} 进化预览数据
   */
  async getEvolutionPreview(userId, pokemonInstanceId, targetSpeciesId) {
    try {
      // 验证用户拥有该精灵
      const { rows: [pokemon] } = await query(`
        SELECT pi.*, ps.name_zh, ps.name_en, ps.type1, ps.type2,
               ps.base_attack, ps.base_defense, ps.base_hp,
               ps.candy_to_evolve, ps.evolves_to,
               COALESCE(ci.amount, 0) AS candy_count
        FROM pokemon_instances pi
        JOIN pokemon_species ps ON pi.species_id = ps.id
        LEFT JOIN candy_inventory ci ON ci.user_id = pi.user_id AND ci.species_id = pi.species_id
        WHERE pi.id = $1 AND pi.user_id = $2
      `, [pokemonInstanceId, userId]);
      
      if (!pokemon) {
        throw new Error('Pokemon not found');
      }
      
      // 获取目标物种信息
      const { rows: [target] } = await query(`
        SELECT id, name_zh, name_en, type1, type2,
               base_attack, base_defense, base_hp,
               sprite_url, sprite_shiny_url, rarity
        FROM pokemon_species
        WHERE id = $1
      `, [targetSpeciesId]);
      
      if (!target) {
        throw new Error('Target species not found');
      }
      
      // 计算进化后属性（CP、HP等）
      const preview = this.calculateEvolvedStats(pokemon, target);
      
      // 检查进化条件是否满足
      const canEvolve = await this.checkEvolutionConditions(userId, pokemon, target);
      
      metrics.evolutionPreviewsGenerated.labels(
        this.determineEvolutionType(pokemon, target)
      ).inc();
      
      return {
        ...preview,
        canEvolve,
        requirements: {
          candyRequired: pokemon.candy_to_evolve || 25,
          candyAvailable: pokemon.candy_count,
          meetsCandyRequirement: pokemon.candy_count >= (pokemon.candy_to_evolve || 25)
        }
      };
    } catch (error) {
      logger.error('Failed to generate evolution preview', {
        userId, pokemonInstanceId, targetSpeciesId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 计算进化后属性
   */
  calculateEvolvedStats(currentPokemon, targetSpecies) {
    const cpMultiplier = this.getCPMultiplier(currentPokemon.level || 20);
    
    // 计算进化后属性（保留 IV）
    const evolvedAttack = targetSpecies.base_attack + currentPokemon.iv_attack;
    const evolvedDefense = targetSpecies.base_defense + currentPokemon.iv_defense;
    const evolvedHp = targetSpecies.base_hp + currentPokemon.iv_hp;
    
    const evolvedCp = Math.floor(
      (evolvedAttack * Math.sqrt(evolvedDefense) * Math.sqrt(evolvedHp) * cpMultiplier * cpMultiplier) / 10
    );
    
    return {
      current: {
        speciesId: currentPokemon.species_id,
        name: currentPokemon.name_zh,
        cp: currentPokemon.cp,
        hp: currentPokemon.hp_max,
        attack: currentPokemon.base_attack + currentPokemon.iv_attack,
        defense: currentPokemon.base_defense + currentPokemon.iv_defense,
        types: [currentPokemon.type1, currentPokemon.type2].filter(Boolean)
      },
      evolved: {
        speciesId: targetSpecies.id,
        name: targetSpecies.name_zh,
        cp: evolvedCp,
        hp: evolvedHp,
        attack: evolvedAttack,
        defense: evolvedDefense,
        types: [targetSpecies.type1, targetSpecies.type2].filter(Boolean),
        sprite: targetSpecies.sprite_url,
        spriteShiny: targetSpecies.sprite_shiny_url,
        rarity: targetSpecies.rarity
      },
      changes: {
        cp: evolvedCp - currentPokemon.cp,
        hp: evolvedHp - currentPokemon.hp_max,
        attack: evolvedAttack - (currentPokemon.base_attack + currentPokemon.iv_attack),
        defense: evolvedDefense - (currentPokemon.base_defense + currentPokemon.iv_defense),
        typesAdded: [targetSpecies.type1, targetSpecies.type2]
          .filter(t => t && ![currentPokemon.type1, currentPokemon.type2].includes(t)),
        typesRemoved: [currentPokemon.type1, currentPokemon.type2]
          .filter(t => t && ![targetSpecies.type1, targetSpecies.type2].includes(t))
      }
    };
  }

  /**
   * 检查进化条件
   */
  async checkEvolutionConditions(userId, currentPokemon, targetSpecies) {
    // 检查是否是有效进化路径
    if (currentPokemon.evolves_to !== targetSpecies.id) {
      // 检查进化链表中是否有直接进化路径
      const { rows: [path] } = await query(`
        SELECT ep.* FROM evolution_paths ep
        JOIN evolution_nodes en_from ON ep.from_node_id = en_from.id
        JOIN evolution_nodes en_to ON ep.to_node_id = en_to.id
        WHERE en_from.pokemon_species_id = $1
        AND en_to.pokemon_species_id = $2
      `, [currentPokemon.species_id, targetSpecies.id]);
      
      if (!path) {
        return { canEvolve: false, reason: 'invalid_evolution_path' };
      }
      
      // 检查条件
      const conditions = path.conditions;
      if (conditions.min_level && currentPokemon.level < conditions.min_level) {
        return { canEvolve: false, reason: 'level_too_low', required: conditions.min_level };
      }
      
      if (conditions.min_friendship && (currentPokemon.friendship || 70) < conditions.min_friendship) {
        return { canEvolve: false, reason: 'friendship_too_low', required: conditions.min_friendship };
      }
      
      if (conditions.item_id) {
        // 检查用户是否有该道具
        const { rows: [item] } = await query(`
          SELECT quantity FROM user_items
          WHERE user_id = $1 AND item_id = $2
        `, [userId, conditions.item_id]);
        
        if (!item || item.quantity < 1) {
          return { canEvolve: false, reason: 'missing_item', required: conditions.item_id };
        }
      }
    }
    
    // 检查糖果数量
    const candyRequired = currentPokemon.candy_to_evolve || 25;
    if (currentPokemon.candy_count < candyRequired) {
      return { canEvolve: false, reason: 'insufficient_candy', required: candyRequired };
    }
    
    return { canEvolve: true };
  }

  /**
   * 获取 CP 倍率
   */
  getCPMultiplier(level) {
    const multipliers = {
      1: 0.094, 10: 0.290, 20: 0.597, 30: 0.732,
      35: 0.761, 40: 0.790, 50: 0.843, 55: 0.874
    };
    
    const closestLevel = Object.keys(multipliers)
      .map(Number)
      .reduce((prev, curr) => 
        Math.abs(curr - level) < Math.abs(prev - level) ? curr : prev
      );
    
    return multipliers[closestLevel] || 0.597;
  }

  /**
   * 确定进化类型
   */
  determineEvolutionType(current, target) {
    const conditions = current.conditions || {};
    
    if (conditions.min_level) return EVOLUTION_TYPES.LEVEL;
    if (conditions.item_id) return EVOLUTION_TYPES.ITEM;
    if (conditions.min_friendship) return EVOLUTION_TYPES.FRIENDSHIP;
    if (conditions.time_range) return EVOLUTION_TYPES.TIME;
    if (conditions.location_ids) return EVOLUTION_TYPES.LOCATION;
    if (conditions.trade_required) return EVOLUTION_TYPES.TRADE;
    
    return EVOLUTION_TYPES.SPECIAL;
  }

  /**
   * 获取精灵的所有进化路径（包括退化）
   */
  async getAllEvolutionPaths(speciesId, language = 'zh') {
    // 正向进化路径
    const forwardPaths = await this.getEvolutionChain(speciesId, language);
    
    // 退化路径（查找哪些精灵进化到当前精灵）
    const { rows: preEvolutions } = await query(`
      SELECT ps.id, ps.name_zh, ps.name_en, ps.type1, ps.type2,
             ps.sprite_url, ps.sprite_shiny_url
      FROM pokemon_species ps
      WHERE ps.evolves_to = $1
    `, [speciesId]);
    
    const preEvolutionNodes = await Promise.all(
      preEvolutions.map(async (pre) => {
        const preChain = await this.getEvolutionChain(pre.id, language);
        return {
          speciesId: pre.id,
          name: language === 'zh' ? pre.name_zh : pre.name_en,
          types: [pre.type1, pre.type2].filter(Boolean),
          sprite: pre.sprite_url,
          spriteShiny: pre.sprite_shiny_url,
          evolutionChain: preChain
        };
      })
    );
    
    return {
      currentSpecies: speciesId,
      forwardEvolution: forwardPaths,
      preEvolutions: preEvolutionNodes
    };
  }

  /**
   * 批量获取多个物种的进化链（用于图鉴列表）
   */
  async batchGetEvolutionChains(speciesIds, language = 'zh') {
    const results = {};
    
    await Promise.all(
      speciesIds.map(async (id) => {
        try {
          results[id] = await this.getEvolutionChain(id, language);
        } catch (error) {
          results[id] = null;
        }
      })
    );
    
    return results;
  }
}

module.exports = {
  EvolutionVisualizationService,
  EVOLUTION_TYPES,
  EVOLUTION_TYPE_NAMES
};
