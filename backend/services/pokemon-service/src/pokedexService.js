/**
 * REQ-00056: 精灵图鉴完成度奖励系统
 * 核心服务：图鉴进度追踪、里程碑奖励、成就系统
 */

const { query, transaction } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { getRedis, setJSON, getJSON } = require('../../../shared/redis');

const logger = createLogger('pokedex-service');

// 总精灵种类数（根据实际数据调整）
const TOTAL_SPECIES = 905;

// 缓存 TTL
const CACHE_TTL = {
  progress: 60,      // 1 分钟
  achievements: 300, // 5 分钟
  leaderboard: 30,   // 30 秒
};

class PokedexService {
  constructor() {
    this.totalSpecies = TOTAL_SPECIES;
  }

  /**
   * 记录精灵见过
   * @param {number} userId - 用户 ID
   * @param {number} pokemonSpeciesId - 精灵种类 ID
   * @returns {Object} 更新结果
   */
  async recordSeen(userId, pokemonSpeciesId) {
    try {
      const existing = await query(
        `SELECT * FROM pokedex_progress WHERE user_id = $1 AND pokemon_species_id = $2`,
        [userId, pokemonSpeciesId]
      );

      if (existing.rows.length > 0) {
        // 更新见过状态
        await query(
          `UPDATE pokedex_progress 
           SET seen = TRUE, last_seen_at = CURRENT_TIMESTAMP 
           WHERE user_id = $1 AND pokemon_species_id = $2`,
          [userId, pokemonSpeciesId]
        );
      } else {
        // 新增记录
        await query(
          `INSERT INTO pokedex_progress 
           (user_id, pokemon_species_id, seen, first_seen_at, last_seen_at)
           VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [userId, pokemonSpeciesId]
        );
      }

      // 更新统计缓存
      await this.updateStatsCache(userId);

      // 检查里程碑和成就
      const milestones = await this.checkMilestones(userId);
      const achievements = await this.checkAchievements(userId);

      // 清除缓存
      await this.invalidateCache(userId);

      logger.info({ userId, pokemonSpeciesId }, 'Pokedex seen recorded');

      return {
        success: true,
        newEntry: existing.rows.length === 0,
        milestones,
        achievements,
      };
    } catch (error) {
      logger.error({ err: error, userId, pokemonSpeciesId }, 'Failed to record seen');
      throw error;
    }
  }

  /**
   * 记录精灵捕获
   * @param {number} userId - 用户 ID
   * @param {number} pokemonSpeciesId - 精灵种类 ID
   * @param {boolean} isShiny - 是否闪光
   * @returns {Object} 更新结果
   */
  async recordCaught(userId, pokemonSpeciesId, isShiny = false) {
    try {
      const existing = await query(
        `SELECT * FROM pokedex_progress WHERE user_id = $1 AND pokemon_species_id = $2`,
        [userId, pokemonSpeciesId]
      );

      const isNew = existing.rows.length === 0;
      const isFirstCatch = existing.rows.length > 0 ? !existing.rows[0].caught : true;

      if (existing.rows.length > 0) {
        // 更新捕获状态
        const updates = [
          'caught = TRUE',
          'catch_count = catch_count + 1',
          'last_caught_at = CURRENT_TIMESTAMP',
        ];
        const values = [userId, pokemonSpeciesId];

        if (isShiny) {
          updates.push('shiny_caught = TRUE');
        }

        if (!existing.rows[0].first_caught_at) {
          updates.push('first_caught_at = CURRENT_TIMESTAMP');
        }

        await query(
          `UPDATE pokedex_progress SET ${updates.join(', ')} WHERE user_id = $1 AND pokemon_species_id = $2`,
          values
        );
      } else {
        // 新增记录
        await query(
          `INSERT INTO pokedex_progress 
           (user_id, pokemon_species_id, seen, caught, catch_count, shiny_caught, 
            first_seen_at, first_caught_at, last_caught_at)
           VALUES ($1, $2, TRUE, TRUE, 1, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [userId, pokemonSpeciesId, isShiny]
        );
      }

      // 更新统计缓存
      await this.updateStatsCache(userId);

      // 检查里程碑和成就
      const milestones = await this.checkMilestones(userId);
      const achievements = await this.checkAchievements(userId);

      // 清除缓存
      await this.invalidateCache(userId);

      // 记录指标
      metrics.incrementCounter('pokedex_caught_total', { user_id: userId.toString() });
      if (isShiny) {
        metrics.incrementCounter('pokedex_shiny_caught_total', { user_id: userId.toString() });
      }

      logger.info(
        { userId, pokemonSpeciesId, isShiny, isNew, isFirstCatch },
        'Pokedex caught recorded'
      );

      return {
        success: true,
        isNew,
        isFirstCatch,
        milestones,
        achievements,
      };
    } catch (error) {
      logger.error({ err: error, userId, pokemonSpeciesId }, 'Failed to record caught');
      throw error;
    }
  }

  /**
   * 获取图鉴进度
   * @param {number} userId - 用户 ID
   * @returns {Object} 图鉴进度数据
   */
  async getPokedexProgress(userId) {
    try {
      // 尝试从缓存获取
      const cacheKey = `pokedex:progress:${userId}`;
      const cached = await getJSON(cacheKey);
      if (cached) {
        return cached;
      }

      // 从数据库获取
      const result = await query(
        `SELECT * FROM pokedex_stats_cache WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        // 没有缓存，重新计算
        await this.updateStatsCache(userId);
        return this.getPokedexProgress(userId);
      }

      const progress = result.rows[0];

      // 缓存结果
      await setJSON(cacheKey, progress, CACHE_TTL.progress);

      return progress;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get pokedex progress');
      throw error;
    }
  }

  /**
   * 获取详细图鉴列表
   * @param {number} userId - 用户 ID
   * @param {Object} filters - 筛选条件
   * @returns {Array} 详细进度列表
   */
  async getDetailedProgress(userId, filters = {}) {
    try {
      let queryStr = `
        SELECT 
          pp.*,
          ps.name as species_name,
          ps.name_zh,
          ps.pokedex_number,
          ps.generation,
          ps.region,
          ps.types,
          ps.is_legendary,
          ps.is_mythical,
          ps.rarity
        FROM pokedex_progress pp
        JOIN pokemon_species ps ON pp.pokemon_species_id = ps.id
        WHERE pp.user_id = $1
      `;

      const values = [userId];
      let paramCount = 2;

      if (filters.region) {
        queryStr += ` AND ps.region = $${paramCount}`;
        values.push(filters.region);
        paramCount++;
      }

      if (filters.type) {
        queryStr += ` AND $${paramCount} = ANY(ps.types)`;
        values.push(filters.type);
        paramCount++;
      }

      if (filters.caught !== undefined) {
        queryStr += ` AND pp.caught = $${paramCount}`;
        values.push(filters.caught);
        paramCount++;
      }

      if (filters.shiny) {
        queryStr += ` AND pp.shiny_caught = TRUE`;
      }

      if (filters.seen !== undefined) {
        queryStr += ` AND pp.seen = $${paramCount}`;
        values.push(filters.seen);
        paramCount++;
      }

      queryStr += ` ORDER BY ps.pokedex_number`;

      const result = await query(queryStr, values);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId, filters }, 'Failed to get detailed progress');
      throw error;
    }
  }

  /**
   * 获取用户未拥有的精灵列表
   * @param {number} userId - 用户 ID
   * @param {Object} filters - 筛选条件
   * @returns {Array} 未拥有的精灵列表
   */
  async getMissingPokemon(userId, filters = {}) {
    try {
      let queryStr = `
        SELECT 
          ps.id,
          ps.name,
          ps.name_zh,
          ps.pokedex_number,
          ps.generation,
          ps.region,
          ps.types,
          ps.is_legendary,
          ps.is_mythical
        FROM pokemon_species ps
        LEFT JOIN pokedex_progress pp ON ps.id = pp.pokemon_species_id AND pp.user_id = $1
        WHERE pp.id IS NULL OR pp.caught = FALSE
      `;

      const values = [userId];
      let paramCount = 2;

      if (filters.region) {
        queryStr += ` AND ps.region = $${paramCount}`;
        values.push(filters.region);
        paramCount++;
      }

      if (filters.type) {
        queryStr += ` AND $${paramCount} = ANY(ps.types)`;
        values.push(filters.type);
        paramCount++;
      }

      queryStr += ` ORDER BY ps.pokedex_number`;

      const result = await query(queryStr, values);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId, filters }, 'Failed to get missing pokemon');
      throw error;
    }
  }

  /**
   * 更新统计缓存
   * @param {number} userId - 用户 ID
   */
  async updateStatsCache(userId) {
    try {
      // 使用存储过程更新缓存
      await query('SELECT update_pokedex_stats($1)', [userId]);

      // 获取详细的地区和属性统计
      const regionStats = await this.calculateRegionStats(userId);
      const typeStats = await this.calculateTypeStats(userId);
      const generationStats = await this.calculateGenerationStats(userId);

      // 更新详细统计
      await query(
        `UPDATE pokedex_stats_cache 
         SET region_stats = $1, type_stats = $2, generation_stats = $3, last_updated = CURRENT_TIMESTAMP
         WHERE user_id = $4`,
        [JSON.stringify(regionStats), JSON.stringify(typeStats), JSON.stringify(generationStats), userId]
      );

      logger.debug({ userId }, 'Stats cache updated');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to update stats cache');
      throw error;
    }
  }

  /**
   * 计算地区统计
   */
  async calculateRegionStats(userId) {
    const result = await query(
      `SELECT 
        ps.region,
        COUNT(DISTINCT CASE WHEN pp.caught THEN pp.pokemon_species_id END) as caught_count,
        COUNT(DISTINCT ps.id) as total_in_region
      FROM pokemon_species ps
      LEFT JOIN pokedex_progress pp ON ps.id = pp.pokemon_species_id AND pp.user_id = $1
      WHERE ps.region IS NOT NULL
      GROUP BY ps.region`,
      [userId]
    );

    return result.rows;
  }

  /**
   * 计算属性统计
   */
  async calculateTypeStats(userId) {
    const result = await query(
      `SELECT 
        t.type,
        COUNT(DISTINCT CASE WHEN pp.caught THEN pp.pokemon_species_id END) as caught_count,
        COUNT(DISTINCT ps.id) as total_of_type
      FROM pokemon_species ps,
           LATERAL (SELECT unnest(ps.types) as type) t
      LEFT JOIN pokedex_progress pp ON ps.id = pp.pokemon_species_id AND pp.user_id = $1
      GROUP BY t.type`,
      [userId]
    );

    return result.rows;
  }

  /**
   * 计算世代统计
   */
  async calculateGenerationStats(userId) {
    const result = await query(
      `SELECT 
        ps.generation,
        COUNT(DISTINCT CASE WHEN pp.caught THEN pp.pokemon_species_id END) as caught_count,
        COUNT(DISTINCT ps.id) as total_in_generation
      FROM pokemon_species ps
      LEFT JOIN pokedex_progress pp ON ps.id = pp.pokemon_species_id AND pp.user_id = $1
      WHERE ps.generation IS NOT NULL
      GROUP BY ps.generation
      ORDER BY ps.generation`,
      [userId]
    );

    return result.rows;
  }

  /**
   * 检查里程碑奖励
   * @param {number} userId - 用户 ID
   * @returns {Array} 新获得的里程碑
   */
  async checkMilestones(userId) {
    try {
      const progress = await this.getPokedexProgress(userId);
      const completionPercent = parseFloat(progress.completion_percentage);
      const newMilestones = [];

      // 获取未领取的里程碑
      const result = await query(
        `SELECT pm.* 
         FROM pokedex_milestones pm
         LEFT JOIN user_milestone_claims umc ON pm.id = umc.milestone_id AND umc.user_id = $1
         WHERE umc.id IS NULL 
           AND (
             (pm.milestone_type = 'percentage' AND $2 >= pm.threshold) OR
             (pm.milestone_type = 'count' AND $3 >= pm.threshold) OR
             (pm.milestone_type = 'special' AND pm.category = 'shiny' AND $4 >= pm.threshold) OR
             (pm.milestone_type = 'special' AND pm.category = 'legendary' AND $5 >= pm.threshold)
           )
         ORDER BY pm.sort_order`,
        [
          userId,
          completionPercent,
          progress.caught_count,
          progress.shiny_count,
          progress.legendary_count,
        ]
      );

      // 自动发放奖励
      for (const milestone of result.rows) {
        await this.claimMilestone(userId, milestone.id, milestone);
        newMilestones.push(milestone);

        metrics.incrementCounter('pokedex_milestone_claimed_total', {
          milestone_type: milestone.milestone_type,
        });
      }

      return newMilestones;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check milestones');
      return [];
    }
  }

  /**
   * 领取里程碑奖励
   * @param {number} userId - 用户 ID
   * @param {number} milestoneId - 里程碑 ID
   * @param {Object} milestone - 里程碑数据（可选）
   * @returns {Object} 里程碑信息
   */
  async claimMilestone(userId, milestoneId, milestone = null) {
    try {
      if (!milestone) {
        const result = await query('SELECT * FROM pokedex_milestones WHERE id = $1', [milestoneId]);
        if (result.rows.length === 0) {
          throw new Error('Milestone not found');
        }
        milestone = result.rows[0];
      }

      // 记录领取
      await query(
        `INSERT INTO user_milestone_claims (user_id, milestone_id, reward_data) 
         VALUES ($1, $2, $3) 
         ON CONFLICT DO NOTHING`,
        [userId, milestoneId, milestone.reward_data]
      );

      // TODO: 调用 reward-service 发放奖励
      // await EventBus.publish(EVENTS.REWARD_GRANT, {
      //   userId,
      //   source: 'pokedex_milestone',
      //   sourceId: milestoneId,
      //   rewards: milestone.reward_data
      // });

      logger.info({ userId, milestoneId, milestoneTitle: milestone.title }, 'Milestone claimed');

      return milestone;
    } catch (error) {
      logger.error({ err: error, userId, milestoneId }, 'Failed to claim milestone');
      throw error;
    }
  }

  /**
   * 检查成就解锁
   * @param {number} userId - 用户 ID
   * @returns {Array} 新解锁的成就
   */
  async checkAchievements(userId) {
    try {
      const progress = await this.getPokedexProgress(userId);
      const newAchievements = [];

      // 获取所有成就
      const achievementsResult = await query(
        `SELECT * FROM pokedex_achievements ORDER BY requirement_value`
      );

      for (const achievement of achievementsResult.rows) {
        // 检查是否已解锁
        const existing = await query(
          `SELECT 1 FROM user_pokedex_achievements WHERE user_id = $1 AND achievement_id = $2`,
          [userId, achievement.id]
        );

        if (existing.rows.length > 0) continue;

        // 检查解锁条件
        let shouldUnlock = false;

        switch (achievement.requirement_type) {
          case 'caught_count':
            shouldUnlock = progress.caught_count >= achievement.requirement_value;
            break;
          case 'seen_count':
            shouldUnlock = progress.seen_count >= achievement.requirement_value;
            break;
          case 'shiny_count':
            shouldUnlock = progress.shiny_count >= achievement.requirement_value;
            break;
          case 'legendary_count':
            shouldUnlock = progress.legendary_count >= achievement.requirement_value;
            break;
          case 'completion_percentage':
            shouldUnlock = parseFloat(progress.completion_percentage) >= achievement.requirement_value;
            break;
        }

        if (shouldUnlock) {
          // 记录解锁
          await query(
            `INSERT INTO user_pokedex_achievements (user_id, achievement_id) VALUES ($1, $2)`,
            [userId, achievement.id]
          );

          // TODO: 发放奖励
          // if (achievement.reward_data) {
          //   await EventBus.publish(EVENTS.REWARD_GRANT, {
          //     userId,
          //     source: 'pokedex_achievement',
          //     sourceId: achievement.id,
          //     rewards: achievement.reward_data
          //   });
          // }

          newAchievements.push(achievement);

          metrics.incrementCounter('pokedex_achievement_unlocked_total', {
            achievement_key: achievement.achievement_key,
          });
        }
      }

      return newAchievements;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check achievements');
      return [];
    }
  }

  /**
   * 获取用户成就列表
   * @param {number} userId - 用户 ID
   * @returns {Array} 成就列表
   */
  async getUserAchievements(userId) {
    try {
      const result = await query(
        `SELECT 
          pa.*,
          upa.unlocked_at
        FROM pokedex_achievements pa
        LEFT JOIN user_pokedex_achievements upa ON pa.id = upa.achievement_id AND upa.user_id = $1
        ORDER BY pa.requirement_value`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get user achievements');
      throw error;
    }
  }

  /**
   * 获取里程碑列表
   * @param {number} userId - 用户 ID
   * @returns {Array} 里程碑列表
   */
  async getMilestones(userId) {
    try {
      const result = await query(
        `SELECT 
          pm.*,
          CASE WHEN umc.id IS NOT NULL THEN TRUE ELSE FALSE END as claimed,
          umc.claimed_at
        FROM pokedex_milestones pm
        LEFT JOIN user_milestone_claims umc ON pm.id = umc.milestone_id AND umc.user_id = $1
        ORDER BY pm.sort_order`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get milestones');
      throw error;
    }
  }

  /**
   * 获取捕捉概率加成
   * @param {number} userId - 用户 ID
   * @returns {Object} 加成信息
   */
  async getCatchBonus(userId) {
    try {
      const progress = await this.getPokedexProgress(userId);

      // 每 10% 完成度增加 1% 捕捉概率（最高 10%）
      const bonusPercent = Math.min(10, Math.floor(parseFloat(progress.completion_percentage) / 10));

      return {
        bonusPercent,
        reason: `图鉴完成度 ${progress.completion_percentage}%`,
        details: {
          caughtCount: progress.caught_count,
          completionPercentage: progress.completion_percentage,
        },
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get catch bonus');
      throw error;
    }
  }

  /**
   * 获取排行榜
   * @param {number} limit - 数量限制
   * @param {number} offset - 偏移量
   * @returns {Array} 排行榜数据
   */
  async getLeaderboard(limit = 100, offset = 0) {
    try {
      const cacheKey = `pokedex:leaderboard:${limit}:${offset}`;
      const cached = await getJSON(cacheKey);
      if (cached) {
        return cached;
      }

      const result = await query(
        `SELECT 
          psc.user_id,
          psc.caught_count,
          psc.completion_percentage,
          psc.shiny_count,
          psc.legendary_count,
          u.username,
          u.avatar,
          RANK() OVER (ORDER BY psc.caught_count DESC, psc.shiny_count DESC) as rank
        FROM pokedex_stats_cache psc
        JOIN users u ON psc.user_id = u.id
        ORDER BY psc.caught_count DESC, psc.shiny_count DESC
        LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const leaderboard = result.rows;

      // 缓存结果
      await setJSON(cacheKey, leaderboard, CACHE_TTL.leaderboard);

      return leaderboard;
    } catch (error) {
      logger.error({ err: error, limit, offset }, 'Failed to get leaderboard');
      throw error;
    }
  }

  /**
   * 获取用户排名
   * @param {number} userId - 用户 ID
   * @returns {Object} 排名信息
   */
  async getUserRank(userId) {
    try {
      const result = await query(
        `SELECT 
          psc.user_id,
          psc.caught_count,
          psc.completion_percentage,
          psc.shiny_count,
          (
            SELECT COUNT(*) + 1
            FROM pokedex_stats_cache psc2
            WHERE psc2.caught_count > psc.caught_count
              OR (psc2.caught_count = psc.caught_count AND psc2.shiny_count > psc.shiny_count)
          ) as rank
        FROM pokedex_stats_cache psc
        WHERE psc.user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return { rank: null, caughtCount: 0, completionPercentage: 0 };
      }

      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get user rank');
      throw error;
    }
  }

  /**
   * 清除缓存
   * @param {number} userId - 用户 ID
   */
  async invalidateCache(userId) {
    try {
      const redis = getRedis();
      await redis.del(`pokedex:progress:${userId}`);
    } catch (error) {
      logger.warn({ err: error, userId }, 'Failed to invalidate cache');
    }
  }
}

// 单例实例
const pokedexService = new PokedexService();

module.exports = {
  PokedexService,
  pokedexService,
  TOTAL_SPECIES,
};
