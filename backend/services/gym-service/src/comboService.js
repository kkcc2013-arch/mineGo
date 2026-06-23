/**
 * 连击服务 - 提供连击相关的业务逻辑
 * @module comboService
 */

const comboEngine = require('./comboEngine');
const { db } = require('../../../shared/db');
const { metrics, startTimer } = require('../../../shared/metrics');
const logger = require('../../../shared/logger');

class ComboService {
  constructor() {
    this.cachePrefix = 'combo:';
  }

  /**
   * 处理战斗中的技能释放
   */
  async handleSkillInBattle(userId, pokemonId, skillId, battleContext) {
    const timer = startTimer('combo_skill_handle_duration_seconds');
    
    try {
      // 记录技能并检查连击
      const result = await comboEngine.recordSkillUsage(
        userId,
        pokemonId,
        skillId,
        battleContext
      );
      
      timer();
      return result;
    } catch (error) {
      timer({ error: true });
      logger.error('Failed to handle skill in battle:', error);
      throw error;
    }
  }

  /**
   * 获取所有可用连击链
   */
  async getAvailableCombos(userId, options = {}) {
    try {
      // 获取玩家信息
      const user = await db('users')
        .where({ id: userId })
        .select('level', 'badges')
        .first();
      
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }
      
      // 获取可用连击
      const availableCombos = comboEngine.getAvailableComboChains(
        user.level,
        user.badges || 0
      );
      
      // 如果需要统计信息
      if (options.includeStats) {
        const stats = await this.getUserComboStats(userId);
        const statsMap = new Map(stats.map(s => [s.chain_id, s]));
        
        return availableCombos.map(combo => ({
          ...combo,
          stats: statsMap.get(combo.chain_id) || {
            times_executed: 0,
            perfect_executions: 0,
            highest_damage_dealt: 0
          }
        }));
      }
      
      return availableCombos;
    } catch (error) {
      logger.error('Failed to get available combos:', error);
      throw error;
    }
  }

  /**
   * 获取连击链详情
   */
  async getComboDetails(chainId, userId) {
    try {
      const combo = comboEngine.getComboChainDetails(chainId);
      
      if (!combo) {
        throw new Error('COMBO_NOT_FOUND');
      }
      
      // 获取玩家统计
      const stats = await db('user_combo_stats')
        .where({ user_id: userId, chain_id: chainId })
        .first();
      
      // 获取排行榜信息
      const rank = await this.getUserComboRank(userId, chainId);
      
      return {
        ...combo,
        stats: stats || {
          times_executed: 0,
          perfect_executions: 0,
          highest_damage_dealt: 0
        },
        rank
      };
    } catch (error) {
      logger.error('Failed to get combo details:', error);
      throw error;
    }
  }

  /**
   * 获取玩家连击统计
   */
  async getUserComboStats(userId) {
    try {
      const stats = await db('user_combo_stats')
        .where({ user_id: userId })
        .select('*');
      
      return stats;
    } catch (error) {
      logger.error('Failed to get user combo stats:', error);
      throw error;
    }
  }

  /**
   * 获取连击排行榜
   */
  async getComboLeaderboard(chainId, options = {}) {
    const { limit = 100, battleType = 'all', period = 'all' } = options;
    
    try {
      let query = db('combo_records as cr')
        .join('users as u', 'cr.user_id', 'u.id')
        .select(
          'u.id',
          'u.username',
          'u.avatar_url',
          'u.level',
          db.raw('COUNT(*) as total_executions'),
          db.raw('SUM(CASE WHEN cr.quality = \'perfect\' THEN 1 ELSE 0 END) as perfect_count'),
          db.raw('MAX(cr.damage_dealt) as max_damage'),
          db.raw('SUM(cr.combo_points_earned) as total_points')
        )
        .groupBy('u.id', 'u.username', 'u.avatar_url', 'u.level')
        .orderBy('total_points', 'desc')
        .limit(limit);
      
      // 按连击类型过滤
      if (chainId && chainId !== 'all') {
        query = query.where('cr.chain_id', chainId);
      }
      
      // 按战斗类型过滤
      if (battleType !== 'all') {
        query = query.where('cr.battle_type', battleType);
      }
      
      // 按时间周期过滤
      if (period !== 'all') {
        const periodMap = {
          daily: '1 day',
          weekly: '7 days',
          monthly: '30 days'
        };
        query = query.where('cr.executed_at', '>=', db.raw(`NOW() - INTERVAL '${periodMap[period]}'`));
      }
      
      const leaderboard = await query;
      
      return leaderboard;
    } catch (error) {
      logger.error('Failed to get combo leaderboard:', error);
      throw error;
    }
  }

  /**
   * 获取玩家在特定连击排行榜中的排名
   */
  async getUserComboRank(userId, chainId) {
    try {
      const result = await db.raw(`
        WITH ranked_users AS (
          SELECT 
            user_id,
            SUM(combo_points_earned) as total_points,
            RANK() OVER (ORDER BY SUM(combo_points_earned) DESC) as rank
          FROM combo_records
          WHERE chain_id = ?
          GROUP BY user_id
        )
        SELECT rank, total_points
        FROM ranked_users
        WHERE user_id = ?
      `, [chainId, userId]);
      
      if (result.rows.length === 0) {
        return { rank: null, totalPoints: 0 };
      }
      
      return {
        rank: result.rows[0].rank,
        totalPoints: result.rows[0].total_points
      };
    } catch (error) {
      logger.error('Failed to get user combo rank:', error);
      return { rank: null, totalPoints: 0 };
    }
  }

  /**
   * 练习连击模式
   */
  async practiceCombo(userId, chainId, pokemonId) {
    try {
      // 验证连击存在
      const combo = comboEngine.getComboChainDetails(chainId);
      if (!combo) {
        throw new Error('COMBO_NOT_FOUND');
      }
      
      // 验证玩家等级
      const user = await db('users')
        .where({ id: userId })
        .select('level')
        .first();
      
      if (!user || user.level < combo.min_trainer_level) {
        throw new Error('LEVEL_TOO_LOW');
      }
      
      // 创建练习会话
      const session = {
        chainId,
        pokemonId,
        startTime: Date.now(),
        skills: [],
        completed: false
      };
      
      return {
        session,
        combo: {
          chainId: combo.chain_id,
          name: combo.name,
          triggerSequence: combo.trigger_sequence,
          timeWindowMs: combo.time_window_ms
        },
        instructions: `在 ${combo.time_window_ms / 1000} 秒内按顺序释放: ${combo.trigger_sequence.join(' → ')}`
      };
    } catch (error) {
      logger.error('Failed to start combo practice:', error);
      throw error;
    }
  }

  /**
   * 获取连击推荐（基于玩家精灵池）
   */
  async getComboRecommendations(userId) {
    try {
      // 获取玩家精灵
      const pokemons = await db('user_pokemons')
        .where({ user_id: userId })
        .select('pokemon_id', 'species_id');
      
      // 获取可用连击
      const user = await db('users')
        .where({ id: userId })
        .select('level')
        .first();
      
      const availableCombos = comboEngine.getAvailableComboChains(user.level);
      
      // TODO: 基于精灵类型匹配推荐连击
      
      return availableCombos.slice(0, 5); // 返回前 5 个推荐
    } catch (error) {
      logger.error('Failed to get combo recommendations:', error);
      throw error;
    }
  }

  /**
   * 重置连击引擎缓存
   */
  async refreshComboCache() {
    await comboEngine.loadComboChains();
    metrics.increment('combo_cache_refresh', 1);
  }
}

module.exports = new ComboService();
