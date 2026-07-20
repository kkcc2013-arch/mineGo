/**
 * REQ-00348: 精灵背包智能整理与自动分类系统
 * 多维度排序引擎
 */

'use strict';

const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('inventory-sorter');

// 稀有度分数映射
const RARITY_SCORES = {
  'common': 1,
  'uncommon': 2,
  'rare': 3,
  'legendary': 4,
  'mythical': 5
};

// 精灵类型列表
const POKEMON_TYPES = [
  'fire', 'water', 'grass', 'electric', 'psychic', 'ice',
  'dragon', 'dark', 'fairy', 'fighting', 'flying', 'poison',
  'ground', 'rock', 'bug', 'ghost', 'steel', 'normal'
];

/**
 * 背包排序引擎
 */
class InventorySorter {
  constructor() {
    this.sortFunctions = {
      combatPower: (p) => p.combatPower || p.cp || 0,
      cp: (p) => p.cp || 0,
      catchTime: (p) => new Date(p.caughtAt || p.created_at || 0).getTime(),
      type: (p) => (p.types && p.types[0]) || 'normal',
      rarity: (p) => this.getRarityScore(p),
      bond: (p) => p.bondLevel || p.friendship || 0,
      evolutionPotential: (p) => this.calculateEvolutionPotential(p),
      ivTotal: (p) => p.ivTotal || 0,
      level: (p) => p.level || 1
    };
  }

  /**
   * 多维度排序
   * @param {Array} pokemonList - 精灵列表
   * @param {Object} sortOptions - 排序选项
   * @returns {Array} 排序后的精灵列表
   */
  sortPokemon(pokemonList, sortOptions = {}) {
    const {
      primarySort = 'combatPower',
      secondarySort = 'rarity',
      order = 'desc',
      filters = {}
    } = sortOptions;

    try {
      // 应用过滤条件
      let filtered = this.applyFilters(pokemonList, filters);

      // 多级排序
      filtered.sort((a, b) => {
        let comparison = 0;

        // 主排序
        const sortFn = this.sortFunctions[primarySort];
        if (sortFn) {
          const aValue = sortFn(a);
          const bValue = sortFn(b);
          comparison = this.compareValues(aValue, bValue, order);
        }

        // 主排序相同则使用次排序
        if (comparison === 0 && secondarySort && secondarySort !== primarySort) {
          const secondFn = this.sortFunctions[secondarySort];
          if (secondFn) {
            const aSecond = secondFn(a);
            const bSecond = secondFn(b);
            comparison = this.compareValues(aSecond, bSecond, order);
          }
        }

        // 收藏精灵优先
        if (comparison === 0) {
          if (a.isFavorite && !b.isFavorite) comparison = -1;
          else if (!a.isFavorite && b.isFavorite) comparison = 1;
        }

        return comparison;
      });

      return filtered;
    } catch (error) {
      logger.error({ error: error.message }, 'Sort failed');
      return pokemonList;
    }
  }

  /**
   * 智能分组
   * @param {Array} pokemonList - 精灵列表
   * @param {string} groupBy - 分组维度
   * @returns {Object} 分组后的精灵对象
   */
  groupPokemon(pokemonList, groupBy) {
    const groups = {};

    try {
      switch (groupBy) {
        case 'type':
          // 按18种类型分组
          POKEMON_TYPES.forEach(type => {
            groups[type] = [];
          });
          pokemonList.forEach(pokemon => {
            const types = pokemon.types || ['normal'];
            types.forEach(type => {
              if (groups[type]) {
                groups[type].push(pokemon);
              }
            });
          });
          // 清理空分组
          Object.keys(groups).forEach(key => {
            if (groups[key].length === 0) delete groups[key];
          });
          break;

        case 'purpose':
          // 按用途分组
          pokemonList.forEach(pokemon => {
            const purpose = this.determinePurpose(pokemon);
            if (!groups[purpose]) groups[purpose] = [];
            groups[purpose].push(pokemon);
          });
          break;

        case 'rarity':
          // 按稀有度分组
          Object.keys(RARITY_SCORES).forEach(level => {
            const pokemon = pokemonList.filter(p => 
              (p.rarity || 'common') === level
            );
            if (pokemon.length > 0) {
              groups[level] = pokemon;
            }
          });
          break;

        case 'generation':
          // 按世代分组
          pokemonList.forEach(pokemon => {
            const gen = this.getGeneration(pokemon.speciesId || pokemon.species_id);
            if (!groups[gen]) groups[gen] = [];
            groups[gen].push(pokemon);
          });
          break;

        case 'favorite':
          // 按收藏状态分组
          groups.favorite = pokemonList.filter(p => p.isFavorite);
          groups.normal = pokemonList.filter(p => !p.isFavorite);
          break;

        default:
          groups.all = pokemonList;
      }

      return groups;
    } catch (error) {
      logger.error({ error: error.message }, 'Group failed');
      return { all: pokemonList };
    }
  }

  /**
   * 判断精灵用途
   */
  determinePurpose(pokemon) {
    const cp = pokemon.combatPower || pokemon.cp || 0;
    const bondLevel = pokemon.bondLevel || pokemon.friendship || 0;
    const rarity = pokemon.rarity || 'common';

    // 高战力精灵
    if (cp >= 3000) return 'battle';
    // 高亲密度精灵
    if (bondLevel >= 50) return 'bonding';
    // 传说/神话精灵
    if (rarity === 'legendary' || rarity === 'mythical') return 'collection';
    // 培育潜力精灵
    if (this.calculateEvolutionPotential(pokemon) >= 0.7) return 'breeding';
    // 其他适合交易
    return 'trading';
  }

  /**
   * 获取稀有度分数
   */
  getRarityScore(pokemon) {
    const rarity = pokemon.rarity || 'common';
    return RARITY_SCORES[rarity] || 0;
  }

  /**
   * 计算进化潜力
   */
  calculateEvolutionPotential(pokemon) {
    try {
      const evolutionStage = pokemon.evolutionStage || 1;
      const ivTotal = pokemon.ivTotal || 0;
      const level = pokemon.level || 1;

      // 进化阶段评分（越早阶段潜力越大）
      const stageScore = Math.max(0, 3 - evolutionStage) / 3;
      // IV评分
      const ivScore = ivTotal / 45; // 最大IV总和通常是45
      // 等级评分（等级越低潜力越大）
      const levelScore = (100 - level) / 100;

      return stageScore * 0.4 + ivScore * 0.35 + levelScore * 0.25;
    } catch (error) {
      return 0;
    }
  }

  /**
   * 获取世代
   */
  getGeneration(speciesId) {
    if (!speciesId) return 'unknown';
    const id = parseInt(speciesId);
    if (id <= 151) return 'gen1';
    if (id <= 251) return 'gen2';
    if (id <= 386) return 'gen3';
    if (id <= 493) return 'gen4';
    if (id <= 649) return 'gen5';
    if (id <= 721) return 'gen6';
    if (id <= 809) return 'gen7';
    if (id <= 905) return 'gen8';
    return 'gen9';
  }

  /**
   * 比较值
   */
  compareValues(a, b, order) {
    const multiplier = order === 'desc' ? -1 : 1;

    // 字符串比较
    if (typeof a === 'string' && typeof b === 'string') {
      return a.localeCompare(b) * multiplier;
    }

    // 数字比较
    if (a < b) return -1 * multiplier;
    if (a > b) return 1 * multiplier;
    return 0;
  }

  /**
   * 应用过滤条件
   */
  applyFilters(pokemonList, filters) {
    if (!filters || Object.keys(filters).length === 0) {
      return [...pokemonList];
    }

    let filtered = [...pokemonList];

    // 类型过滤
    if (filters.type) {
      filtered = filtered.filter(p => 
        (p.types || []).includes(filters.type)
      );
    }

    // CP范围过滤
    if (filters.minCP !== undefined) {
      filtered = filtered.filter(p => (p.cp || 0) >= filters.minCP);
    }
    if (filters.maxCP !== undefined) {
      filtered = filtered.filter(p => (p.cp || 0) <= filters.maxCP);
    }

    // 稀有度过滤
    if (filters.rarity) {
      filtered = filtered.filter(p => (p.rarity || 'common') === filters.rarity);
    }

    // 收藏过滤
    if (filters.isFavorite !== undefined) {
      filtered = filtered.filter(p => p.isFavorite === filters.isFavorite);
    }

    // 锁定过滤
    if (filters.isLocked !== undefined) {
      filtered = filtered.filter(p => p.isLocked === filters.isLocked);
    }

    // 名称搜索
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filtered = filtered.filter(p => 
        (p.speciesName || p.name || '').toLowerCase().includes(searchLower) ||
        (p.nickname || '').toLowerCase().includes(searchLower)
      );
    }

    // 自定义标签过滤
    if (filters.tags && filters.tags.length > 0) {
      filtered = filtered.filter(p => 
        (p.customTags || []).some(tag => filters.tags.includes(tag))
      );
    }

    return filtered;
  }

  /**
   * 获取排序选项列表
   */
  static getSortOptions() {
    return [
      { value: 'combatPower', label: '战斗力', description: '按战斗力从高到低排序' },
      { value: 'cp', label: 'CP值', description: '按CP值排序' },
      { value: 'catchTime', label: '捕捉时间', description: '按捕捉时间排序' },
      { value: 'type', label: '类型', description: '按精灵类型排序' },
      { value: 'rarity', label: '稀有度', description: '按稀有度排序' },
      { value: 'bond', label: '亲密度', description: '按亲密度排序' },
      { value: 'evolutionPotential', label: '进化潜力', description: '按进化潜力排序' },
      { value: 'ivTotal', label: 'IV总和', description: '按IV值排序' },
      { value: 'level', label: '等级', description: '按等级排序' }
    ];
  }

  /**
   * 获取分组选项列表
   */
  static getGroupOptions() {
    return [
      { value: null, label: '不分组', description: '显示所有精灵' },
      { value: 'type', label: '按类型', description: '按18种属性类型分组' },
      { value: 'purpose', label: '按用途', description: '按战斗、培育、收藏等分组' },
      { value: 'rarity', label: '按稀有度', description: '按稀有度等级分组' },
      { value: 'generation', label: '按世代', description: '按世代分组' },
      { value: 'favorite', label: '按收藏', description: '按收藏状态分组' }
    ];
  }
}

module.exports = InventorySorter;
