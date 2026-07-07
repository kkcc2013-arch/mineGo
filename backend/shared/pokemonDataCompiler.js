/**
 * REQ-00481: 精灵数据预编译缓存系统
 * 精灵数据预编译器 - 将精灵配置数据编译为高效缓存格式
 */

'use strict';

const msgpack = require('msgpack-lite');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const cache = require('./cache');

const logger = createLogger('PokemonDataCompiler');

/**
 * 精灵数据预编译器
 */
class PokemonDataCompiler {
  constructor() {
    this.compiledDataVersion = null;
    this.cachePrefix = 'pokemon:compiled:';
    this.compileHooks = new Map();
  }

  /**
   * 初始化预编译器
   */
  async initialize() {
    // 加载当前版本
    const versionKey = `${this.cachePrefix}version`;
    this.compiledDataVersion = await cache.get(versionKey) || Date.now().toString();
    
    logger.info('PokemonDataCompiler initialized', { version: this.compiledDataVersion });
  }

  /**
   * 编译精灵基础数据
   * @param {Object} speciesData - 原始精灵数据
   * @returns {Buffer} 编译后的二进制数据
   */
  compileSpeciesData(speciesData) {
    // 计算满级属性预估
    const maxLevelStats = this.calculateMaxLevelStats(speciesData);
    
    // 构建进化节点查找表
    const evolutionTree = this.buildEvolutionTree(speciesData);
    
    // 构建技能集索引
    const moveIndex = this.buildMoveIndex(speciesData);
    
    // 合并编译数据
    const compiledData = {
      id: speciesData.id,
      baseStats: {
        attack: speciesData.base_attack,
        defense: speciesData.base_defense,
        hp: speciesData.base_hp
      },
      maxLevelStats,
      types: [speciesData.type1, speciesData.type2],
      rarity: speciesData.rarity,
      catchRate: speciesData.base_catch_rate || 0.1,
      fleeRate: speciesData.base_flee_rate || 0.05,
      evolution: evolutionTree,
      moves: moveIndex,
      candyToEvolve: speciesData.candy_to_evolve,
      biomes: speciesData.biomes || [],
      // 压缩后的本地化数据
      names: {
        zh: speciesData.name_zh,
        en: speciesData.name_en,
        ja: speciesData.name_ja
      },
      // 预计算的属性克制关系
      typeEffectiveness: this.calculateTypeEffectiveness(speciesData.type1, speciesData.type2)
    };

    return compiledData;
  }

  /**
   * 计算满级属性预估（基于 CP 公式）
   */
  calculateMaxLevelStats(species) {
    // CP = ((Attack + IV) * sqrt(Defense + IV) * sqrt(HP + IV)) / 10
    // 假设满级（Level 40）和完美 IV（15/15/15）
    const maxIV = 15;
    const maxCPM = 0.7903; // Level 40 CPM
    
    const effectiveAttack = (species.base_attack + maxIV) * maxCPM;
    const effectiveDefense = (species.base_defense + maxIV) * maxCPM;
    const effectiveHP = (species.base_hp + maxIV) * maxCPM;
    
    const maxCP = Math.floor(
      (effectiveAttack * Math.sqrt(effectiveDefense) * Math.sqrt(effectiveHP)) / 10
    );
    
    return {
      maxCP,
      maxAttack: Math.floor(effectiveAttack),
      maxDefense: Math.floor(effectiveDefense),
      maxHP: Math.floor(effectiveHP)
    };
  }

  /**
   * 构建进化节点查找表
   */
  buildEvolutionTree(species) {
    const tree = {
      evolvesTo: species.evolves_to || null,
      evolvesFrom: null,
      evolutionConditions: []
    };

    if (species.evolves_with_item) {
      tree.evolutionConditions.push({
        type: 'ITEM',
        itemId: species.evolves_with_item
      });
    }

    if (species.candy_to_evolve > 0) {
      tree.evolutionConditions.push({
        type: 'CANDY',
        amount: species.candy_to_evolve
      });
    }

    return tree;
  }

  /**
   * 构建技能集索引
   */
  buildMoveIndex(species) {
    // 从数据库查询技能数据
    return {
      fastMoves: species.fast_moves || [],
      chargeMoves: species.charge_moves || [],
      legacyMoves: species.legacy_moves || []
    };
  }

  /**
   * 计算属性克制关系
   */
  calculateTypeEffectiveness(type1, type2) {
    // 属性克制表（简化版）
    const typeChart = {
      'NORMAL': { weak: [], strong: ['ROCK', 'STEEL'], immune: ['GHOST'] },
      'FIRE': { weak: ['WATER', 'GROUND', 'ROCK'], strong: ['FIRE', 'GRASS', 'ICE', 'BUG', 'STEEL'] },
      'WATER': { weak: ['GRASS', 'ELECTRIC'], strong: ['FIRE', 'GROUND', 'ROCK'] },
      'ELECTRIC': { weak: ['GROUND'], strong: ['ELECTRIC', 'GRASS'] },
      'GRASS': { weak: ['FIRE', 'ICE', 'POISON', 'FLYING', 'BUG'], strong: ['WATER', 'GROUND', 'ROCK'] },
      'ICE': { weak: ['FIRE', 'FIGHTING', 'ROCK', 'STEEL'], strong: ['ICE'] },
      'FIGHTING': { weak: ['FLYING', 'PSYCHIC', 'FAIRY'], strong: ['BUG', 'ROCK', 'DARK'] },
      'POISON': { weak: ['GROUND', 'PSYCHIC'], strong: ['POISON', 'GROUND', 'ROCK', 'FAIRY'] },
      'GROUND': { weak: ['WATER', 'GRASS', 'ICE'], strong: ['POISON', 'ROCK'], immune: ['ELECTRIC'] },
      'FLYING': { weak: ['ELECTRIC', 'ICE', 'ROCK'], strong: ['GRASS', 'FIGHTING', 'BUG'] },
      'PSYCHIC': { weak: ['BUG', 'GHOST', 'DARK'], strong: ['FIGHTING', 'PSYCHIC'] },
      'BUG': { weak: ['FIRE', 'FLYING', 'ROCK'], strong: ['GRASS', 'FIGHTING', 'GROUND'] },
      'ROCK': { weak: ['WATER', 'GRASS', 'FIGHTING', 'GROUND', 'STEEL'], strong: ['FIRE', 'ICE', 'FLYING', 'BUG'] },
      'GHOST': { weak: ['GHOST', 'DARK'], strong: ['POISON', 'BUG'], immune: ['NORMAL', 'FIGHTING'] },
      'DRAGON': { weak: ['ICE', 'DRAGON', 'FAIRY'], strong: ['FIRE', 'WATER', 'GRASS', 'ELECTRIC'] },
      'DARK': { weak: ['FIGHTING', 'BUG', 'FAIRY'], strong: ['GHOST', 'DARK'] },
      'STEEL': { weak: ['FIRE', 'FIGHTING', 'GROUND'], strong: ['NORMAL', 'GRASS', 'ICE', 'FLYING', 'PSYCHIC', 'BUG', 'ROCK', 'DRAGON', 'STEEL', 'FAIRY'] },
      'FAIRY': { weak: ['POISON', 'STEEL'], strong: ['FIGHTING', 'BUG', 'DARK'] }
    };

    const effectiveness = {
      weakTo: [],
      strongAgainst: [],
      immuneTo: []
    };

    const types = [type1, type2].filter(t => t);
    
    for (const type of types) {
      const chart = typeChart[type] || { weak: [], strong: [], immune: [] };
      effectiveness.weakTo.push(...chart.weak);
      effectiveness.strongAgainst.push(...chart.strong);
      effectiveness.immuneTo.push(...chart.immune);
    }

    // 去重
    effectiveness.weakTo = [...new Set(effectiveness.weakTo)];
    effectiveness.strongAgainst = [...new Set(effectiveness.strongAgainst)];
    effectiveness.immuneTo = [...new Set(effectiveness.immuneTo)];

    return effectiveness;
  }

  /**
   * 批量编译精灵数据
   * @param {Array} speciesList - 精灵列表
   * @returns {Object} 编译结果
   */
  async compileAll(speciesList) {
    const compiled = {};
    const startTime = Date.now();

    for (const species of speciesList) {
      try {
        const compiledData = this.compileSpeciesData(species);
        compiled[species.id] = compiledData;
      } catch (err) {
        logger.error('Failed to compile species', { speciesId: species.id, err });
      }
    }

    const compileTime = Date.now() - startTime;
    logger.info('Compilation completed', { count: speciesList.length, timeMs: compileTime });

    return {
      version: this.compiledDataVersion,
      data: compiled,
      compileTime,
      count: speciesList.length
    };
  }

  /**
   * 存储编译数据到缓存
   * @param {Object} compiledResult - 编译结果
   */
  async storeCompiledData(compiledResult) {
    const batchSize = 50;
    const ids = Object.keys(compiledResult.data);
    
    // 分批存储到 Redis
    for (let i = 0; i < ids.length; i += batchSize) {
      const batchIds = ids.slice(i, i + batchSize);
      
      for (const id of batchIds) {
        const cacheKey = `${this.cachePrefix}${this.compiledDataVersion}:${id}`;
        const compiledBuffer = compiledResult.data[id];
        
        // 存储为 Buffer（Redis 会自动处理）
        await cache.set(cacheKey, compiledBuffer, 3600, { category: 'pokemon-compiled' });
      }
      
      logger.debug('Stored batch', { batch: i / batchSize, count: batchIds.length });
    }

    // 存储版本和索引
    await cache.set(`${this.cachePrefix}version`, this.compiledDataVersion, 3600);
    await cache.set(`${this.cachePrefix}index:${this.compiledDataVersion}`, ids, 3600);

    logger.info('Compiled data stored', { count: ids.length, version: this.compiledDataVersion });
  }

  /**
   * 解码编译数据
   * @param {Buffer} compiledBuffer - 编译后的 Buffer
   * @returns {Object} 解码后的精灵数据
   */
  decodeData(compiledBuffer) {
    if (Buffer.isBuffer(compiledBuffer)) {
      return msgpack.decode(compiledBuffer);
    }
    return compiledBuffer;
  }

  /**
   * 编码数据为 Buffer
   * @param {Object} compiledData - 编译数据
   * @returns {Buffer} 编码后的 Buffer
   */
  encodeData(compiledData) {
    return msgpack.encode(compiledData);
  }

  /**
   * 批量获取编译数据
   * @param {Array} pokemonIds - 精灵 ID 列表
   * @returns {Object} 精灵数据映射
   */
  async getCompiledDataBatch(pokemonIds) {
    const result = {};
    
    for (const id of pokemonIds) {
      const data = await this.getCompiledData(id);
      if (data) {
        result[id] = data;
      }
    }
    
    return result;
  }

  /**
   * 更新编译版本（触发重新编译）
   */
  async updateVersion() {
    const newVersion = Date.now().toString();
    const oldVersion = this.compiledDataVersion;
    
    this.compiledDataVersion = newVersion;
    
    // 存储新版本
    await cache.set(`${this.cachePrefix}version`, newVersion, 3600);
    
    logger.info('Version updated', { oldVersion, newVersion });
    
    return { oldVersion, newVersion };
  }

  /**
   * 清理旧版本缓存
   * @param {string} oldVersion - 旧版本号
   */
  async cleanupOldVersion(oldVersion) {
    const indexKey = `${this.cachePrefix}index:${oldVersion}`;
    const ids = await cache.get(indexKey);
    
    if (ids && ids.length > 0) {
      // 删除所有旧版本的编译数据
      for (const id of ids) {
        await cache.del(`${this.cachePrefix}${oldVersion}:${id}`);
      }
      
      // 删除旧索引
      await cache.del(indexKey);
      
      logger.info('Cleaned up old version', { version: oldVersion, count: ids.length });
    }
  }

  /**
   * 注册编译钩子（用于数据变更时触发重新编译）
   * @param {string} hookName - 钩子名称
   * @param {Function} hookFn - 钩子函数
   */
  registerCompileHook(hookName, hookFn) {
    this.compileHooks.set(hookName, hookFn);
  }

  /**
   * 触发编译钩子
   * @param {string} event - 事件名称
   * @param {Object} data - 事件数据
   */
  async triggerCompileHook(event, data) {
    const hook = this.compileHooks.get(event);
    if (hook) {
      await hook(data);
    }
  }

  /**
   * 获取编译统计信息
   */
  async getStats() {
    const indexKey = `${this.cachePrefix}index:${this.compiledDataVersion}`;
    const ids = await cache.get(indexKey) || [];
    
    return {
      version: this.compiledDataVersion,
      compiledCount: ids.length,
      cacheKeys: ids.map(id => `${this.cachePrefix}${this.compiledDataVersion}:${id}`)
    };
  }
}

module.exports = new PokemonDataCompiler();