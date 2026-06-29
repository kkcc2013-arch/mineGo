/**
 * REQ-00348: 精灵背包智能整理与自动分类系统
 * 智能整理建议服务
 */

'use strict';

const { query } = require('../../../shared/db');
const redis = require('../../../shared/redis');
const { createLogger } = require('../../../shared/logger');
const InventorySorter = require('./InventorySorter');

const logger = createLogger('organization-advisor');

// 默认背包容量
const DEFAULT_MAX_STORAGE = 300;

// 低价值精灵阈值
const LOW_VALUE_THRESHOLD = {
  minCP: 500,
  excludeRarity: ['legendary', 'mythical']
};

/**
 * 智能整理建议服务
 */
class OrganizationAdvisor {
  constructor() {
    this.sorter = new InventorySorter();
  }

  /**
   * 生成整理建议
   * @param {string} userId - 用户ID
   * @returns {Promise<Object>} 整理建议
   */
  async generateOrganizationAdvice(userId) {
    try {
      // 获取用户精灵列表
      const pokemonList = await this.getUserPokemon(userId);

      const advice = {
        recommendedSort: await this.recommendSort(userId, pokemonList),
        duplicates: this.findDuplicates(pokemonList),
        lowValuePokemon: this.identifyLowValuePokemon(pokemonList),
        battleTeamRecommendation: await this.recommendBattleTeam(userId, pokemonList),
        storageUsage: this.calculateStorageUsage(userId, pokemonList),
        quickActions: this.generateQuickActions(pokemonList),
        generatedAt: new Date().toISOString()
      };

      logger.info({ userId, adviceCount: advice.duplicates.length + advice.lowValuePokemon.length }, 
        'Organization advice generated');

      return advice;
    } catch (error) {
      logger.error({ error: error.message, userId }, 'Failed to generate organization advice');
      throw error;
    }
  }

  /**
   * 推荐排序方式
   */
  async recommendSort(userId, pokemonList) {
    try {
      // 获取用户偏好
      const preference = await this.getUserSortPreference(userId);

      if (preference) {
        return {
          primarySort: preference.primarySort,
          secondarySort: preference.secondarySort,
          order: preference.sortOrder || 'desc',
          reason: 'based_on_your_preference'
        };
      }

      // 基于精灵分布智能推荐
      const avgCP = this.calculateAverageCP(pokemonList);
      const hasManyFavorites = pokemonList.filter(p => p.isFavorite).length > 10;

      if (avgCP >= 2000) {
        return {
          primarySort: 'combatPower',
          secondarySort: 'rarity',
          order: 'desc',
          reason: 'high_cp_collection'
        };
      }

      if (hasManyFavorites) {
        return {
          primarySort: 'bond',
          secondarySort: 'combatPower',
          order: 'desc',
          reason: 'many_favorites'
        };
      }

      // 默认推荐
      return {
        primarySort: 'combatPower',
        secondarySort: 'catchTime',
        order: 'desc',
        reason: 'recommended_default'
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to recommend sort');
      return {
        primarySort: 'combatPower',
        secondarySort: 'rarity',
        order: 'desc',
        reason: 'error_fallback'
      };
    }
  }

  /**
   * 查找重复精灵
   */
  findDuplicates(pokemonList) {
    const speciesMap = new Map();

    pokemonList.forEach(pokemon => {
      const speciesId = pokemon.speciesId || pokemon.species_id;
      if (!speciesMap.has(speciesId)) {
        speciesMap.set(speciesId, []);
      }
      speciesMap.get(speciesId).push(pokemon);
    });

    const duplicates = [];

    speciesMap.forEach((pokemon, speciesId) => {
      if (pokemon.length > 1) {
        // 按CP排序找出最强和最弱的
        const sorted = this.sorter.sortPokemon(pokemon, {
          primarySort: 'cp',
          order: 'desc'
        });

        // 最强的一只建议保留
        const keep = sorted[0];
        // 其余的建议转移（排除收藏和锁定的）
        const transferCandidates = sorted.slice(1).filter(p => !p.isFavorite && !p.isLocked);

        if (transferCandidates.length > 0) {
          duplicates.push({
            speciesId,
            speciesName: pokemon[0].speciesName || pokemon[0].name,
            count: pokemon.length,
            recommendedKeep: {
              id: keep.id,
              cp: keep.cp,
              isFavorite: keep.isFavorite
            },
            recommendedTransfer: transferCandidates.map(p => ({
              id: p.id,
              cp: p.cp,
              isFavorite: p.isFavorite,
              isLocked: p.isLocked
            })),
            potentialCandy: transferCandidates.length * 1
          });
        }
      }
    });

    // 按重复数量排序
    duplicates.sort((a, b) => b.count - a.count);

    return duplicates;
  }

  /**
   * 识别低价值精灵
   */
  identifyLowValuePokemon(pokemonList) {
    const lowValue = pokemonList.filter(pokemon => {
      const cp = pokemon.cp || 0;
      const rarity = pokemon.rarity || 'common';

      // 低价值条件：
      // 1. CP低于阈值
      // 2. 不是收藏
      // 3. 不是锁定
      // 4. 不是传说/神话
      return cp < LOW_VALUE_THRESHOLD.minCP &&
             !pokemon.isFavorite &&
             !pokemon.isLocked &&
             !LOW_VALUE_THRESHOLD.excludeRarity.includes(rarity);
    });

    // 按CP排序（最低的排在前面）
    lowValue.sort((a, b) => (a.cp || 0) - (b.cp || 0));

    return lowValue.map(p => ({
      id: p.id,
      speciesId: p.speciesId || p.species_id,
      speciesName: p.speciesName || p.name,
      cp: p.cp,
      rarity: p.rarity,
      evolutionPotential: this.sorter.calculateEvolutionPotential(p)
    }));
  }

  /**
   * 推荐战斗队伍
   */
  async recommendBattleTeam(userId, pokemonList) {
    try {
      // 获取用户历史战斗队伍
      const recentTeams = await this.getUserRecentTeams(userId);

      // 按战斗力排序取前20只
      const topPokemon = this.sorter.sortPokemon(pokemonList, {
        primarySort: 'combatPower',
        secondarySort: 'type',
        order: 'desc'
      }).slice(0, 20);

      // 构建推荐队伍（考虑类型多样性）
      const recommended = this.buildBalancedTeam(topPokemon);
      const alternatives = topPokemon.slice(6, 12).map(p => ({
        id: p.id,
        speciesName: p.speciesName || p.name,
        cp: p.cp,
        types: p.types
      }));

      return {
        recommended: recommended.map(p => ({
          id: p.id,
          speciesName: p.speciesName || p.name,
          cp: p.cp,
          types: p.types,
          combatPower: p.combatPower
        })),
        alternatives,
        strategy: 'balanced_types',
        historicTeams: recentTeams.length > 0
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to recommend battle team');
      return { recommended: [], alternatives: [], strategy: 'error' };
    }
  }

  /**
   * 构建平衡队伍（考虑类型多样性）
   */
  buildBalancedTeam(topPokemon) {
    const team = [];
    const usedTypes = new Set();

    // 首先选择类型多样的精灵
    for (const pokemon of topPokemon) {
      if (team.length >= 6) break;

      const types = pokemon.types || [];
      const hasNewType = types.some(t => !usedTypes.has(t));

      if (hasNewType || team.length < 3) {
        team.push(pokemon);
        types.forEach(t => usedTypes.add(t));
      }
    }

    // 如果队伍不足6只，用剩余最高CP精灵补充
    while (team.length < 6 && topPokemon.length > team.length) {
      const remaining = topPokemon.filter(p => !team.includes(p));
      if (remaining.length > 0) {
        team.push(remaining[0]);
      }
    }

    return team;
  }

  /**
   * 计算存储使用情况
   */
  calculateStorageUsage(userId, pokemonList) {
    // TODO: 从用户配置获取实际最大容量
    const maxStorage = DEFAULT_MAX_STORAGE;
    const used = pokemonList.length;
    const percentage = Math.round((used / maxStorage) * 100);

    return {
      used,
      max: maxStorage,
      percentage,
      available: maxStorage - used,
      shouldWarn: percentage >= 80,
      shouldAlert: percentage >= 95,
      recommendation: percentage >= 95 
        ? 'immediate_cleanup' 
        : percentage >= 80 
          ? 'cleanup_suggested' 
          : 'healthy'
    };
  }

  /**
   * 生成快速操作建议
   */
  generateQuickActions(pokemonList) {
    const actions = [];

    // 检查是否有可以快速转移的低价值精灵
    const lowValue = this.identifyLowValuePokemon(pokemonList);
    if (lowValue.length >= 10) {
      actions.push({
        type: 'batch_transfer',
        label: '批量转移低价值精灵',
        count: lowValue.length,
        candyReward: lowValue.length * 1,
        urgency: 'medium'
      });
    }

    // 检查重复精灵
    const duplicates = this.findDuplicates(pokemonList);
    const duplicateTransferCount = duplicates.reduce(
      (sum, d) => sum + d.recommendedTransfer.length, 0
    );
    if (duplicateTransferCount >= 5) {
      actions.push({
        type: 'deduplicate',
        label: '整理重复精灵',
        count: duplicateTransferCount,
        candyReward: duplicateTransferCount,
        urgency: 'low'
      });
    }

    // 检查收藏精灵数量
    const favorites = pokemonList.filter(p => p.isFavorite);
    if (favorites.length < 10 && pokemonList.length >= 20) {
      actions.push({
        type: 'suggest_favorites',
        label: '建议收藏高价值精灵',
        count: Math.min(10, pokemonList.filter(p => (p.cp || 0) >= 2000).length),
        urgency: 'info'
      });
    }

    return actions;
  }

  /**
   * 计算平均CP
   */
  calculateAverageCP(pokemonList) {
    if (!pokemonList || pokemonList.length === 0) return 0;
    const total = pokemonList.reduce((sum, p) => sum + (p.cp || 0), 0);
    return Math.round(total / pokemonList.length);
  }

  /**
   * 获取用户精灵列表
   */
  async getUserPokemon(userId) {
    const cacheKey = `user:${userId}:pokemon:list`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // 缓存损坏，忽略
      }
    }

    const result = await query(`
      SELECT 
        pi.id,
        pi.species_id as "speciesId",
        ps.name as "speciesName",
        pi.cp,
        pi.combat_power as "combatPower",
        pi.level,
        pi.iv_total as "ivTotal",
        pi.types,
        pi.rarity,
        pi.is_favorite as "isFavorite",
        pi.is_locked as "isLocked",
        pi.friendship as "bondLevel",
        pi.evolution_stage as "evolutionStage",
        pi.caught_at as "caughtAt",
        pi.nickname,
        pi.custom_tags as "customTags"
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.user_id = $1 AND pi.is_deleted = false
      ORDER BY pi.caught_at DESC
    `, [userId]);

    // 缓存5分钟
    await redis.setex(cacheKey, 300, JSON.stringify(result.rows));

    return result.rows;
  }

  /**
   * 获取用户排序偏好
   */
  async getUserSortPreference(userId) {
    try {
      const result = await query(`
        SELECT primary_sort, secondary_sort, sort_order
        FROM user_inventory_preferences
        WHERE user_id = $1
      `, [userId]);

      if (result.rows.length > 0) {
        return {
          primarySort: result.rows[0].primary_sort,
          secondarySort: result.rows[0].secondary_sort,
          sortOrder: result.rows[0].sort_order
        };
      }

      return null;
    } catch (error) {
      // 表可能不存在，返回默认
      return null;
    }
  }

  /**
   * 获取用户历史战斗队伍
   */
  async getUserRecentTeams(userId) {
    try {
      const result = await query(`
        SELECT id, name, pokemon_ids, used_at
        FROM battle_teams
        WHERE user_id = $1
        ORDER BY used_at DESC
        LIMIT 5
      `, [userId]);

      return result.rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * 更新用户排序偏好
   */
  async updateUserSortPreference(userId, preference) {
    try {
      await query(`
        INSERT INTO user_inventory_preferences (user_id, primary_sort, secondary_sort, sort_order)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id) DO UPDATE SET
          primary_sort = $2,
          secondary_sort = $3,
          sort_order = $4,
          updated_at = NOW()
      `, [userId, preference.primarySort, preference.secondarySort, preference.order]);

      logger.info({ userId, preference }, 'User sort preference updated');
    } catch (error) {
      logger.error({ error: error.message, userId }, 'Failed to update preference');
    }
  }
}

module.exports = OrganizationAdvisor;