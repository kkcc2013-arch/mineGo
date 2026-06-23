/**
 * 连击引擎 - 负责技能序列检测和连击判定
 * @module comboEngine
 */

const { db } = require('../../../shared/db');
const { metrics, startTimer } = require('../../../shared/metrics');
const logger = require('../../../shared/logger');

class ComboEngine {
  constructor() {
    // 用户活跃连击状态: Map<userId_pokemonId, ComboState>
    this.activeCombos = new Map();
    
    // 连击链缓存
    this.comboChains = new Map();
    
    // 连击配置
    this.config = {
      maxSequenceLength: 10,      // 最大技能序列长度
      defaultTimeWindow: 5000,    // 默认时间窗口 5 秒
      cleanupInterval: 60000,     // 清理间隔 1 分钟
      timeoutMultiplier: 2        // 超时倍数
    };
    
    // 加载连击链配置
    this.loadComboChains();
    
    // 启动定期清理
    this.startCleanupTimer();
  }

  /**
   * 从数据库加载连击链配置
   */
  async loadComboChains() {
    try {
      const chains = await db('combo_chains')
        .where({ is_active: true })
        .select('*');
      
      this.comboChains.clear();
      
      for (const chain of chains) {
        this.comboChains.set(chain.chain_id, {
          ...chain,
          trigger_sequence: typeof chain.trigger_sequence === 'string' 
            ? JSON.parse(chain.trigger_sequence) 
            : chain.trigger_sequence,
          bonus_effects: typeof chain.bonus_effects === 'string'
            ? JSON.parse(chain.bonus_effects)
            : chain.bonus_effects
        });
      }
      
      logger.info(`Loaded ${chains.length} combo chains`);
      metrics.gauge('combo_chains_loaded').set(chains.length);
    } catch (error) {
      logger.error('Failed to load combo chains:', error);
    }
  }

  /**
   * 记录技能释放并检查连击
   */
  async recordSkillUsage(userId, pokemonId, skillId, context = {}) {
    const timer = startTimer('combo_skill_record_duration_seconds');
    
    try {
      const stateKey = `${userId}_${pokemonId}`;
      const state = this.getOrCreateState(stateKey);
      
      // 更新技能序列
      const now = Date.now();
      state.sequence.push({
        skillId,
        timestamp: now,
        pokemonId
      });
      
      // 限制序列长度
      if (state.sequence.length > this.config.maxSequenceLength) {
        state.sequence.shift();
      }
      
      // 检查可能的连击
      const matchedCombos = await this.checkComboMatch(state, context);
      
      if (matchedCombos.length > 0) {
        // 选择最优连击
        const bestCombo = this.selectBestCombo(matchedCombos);
        
        // 判定连击质量
        const quality = this.evaluateComboQuality(state, bestCombo);
        
        // 应用连击效果
        const effect = await this.applyComboEffect(
          userId, 
          pokemonId, 
          bestCombo, 
          quality, 
          context
        );
        
        // 记录统计
        await this.recordComboExecution(userId, pokemonId, bestCombo, quality, effect, context);
        
        // 重置状态
        this.resetState(stateKey);
        
        // 返回连击结果
        const result = {
          comboTriggered: true,
          combo: {
            chainId: bestCombo.chain_id,
            name: bestCombo.name,
            description: bestCombo.description
          },
          quality,
          effect,
          stats: {
            executionTime: now - state.sequence[0].timestamp,
            comboPoints: effect.comboPoints
          }
        };
        
        metrics.increment('combos_executed', 1, { quality, chain: bestCombo.chain_id });
        timer();
        
        return result;
      }
      
      // 检查是否超时
      if (this.isTimeout(state)) {
        this.resetState(stateKey);
      }
      
      timer();
      return { comboTriggered: false };
    } catch (error) {
      timer({ error: true });
      logger.error('Failed to record skill usage:', error);
      throw error;
    }
  }

  /**
   * 获取或创建连击状态
   */
  getOrCreateState(stateKey) {
    if (!this.activeCombos.has(stateKey)) {
      this.activeCombos.set(stateKey, {
        sequence: [],
        startedAt: null,
        lastUpdate: Date.now()
      });
    }
    
    const state = this.activeCombos.get(stateKey);
    state.lastUpdate = Date.now();
    
    return state;
  }

  /**
   * 检查连击匹配
   */
  async checkComboMatch(state, context) {
    const matches = [];
    const currentSequence = state.sequence.map(s => s.skillId);
    
    for (const [chainId, chain] of this.comboChains) {
      // 检查序列匹配
      if (this.matchesSequence(currentSequence, chain.trigger_sequence)) {
        // 检查时间窗口
        if (this.checkTimeWindow(state, chain.time_window_ms)) {
          // 检查元素要求
          if (chain.element_requirement && context.element !== chain.element_requirement) {
            continue;
          }
          
          // 检查解锁条件
          if (context.trainerLevel < chain.min_trainer_level) {
            continue;
          }
          
          if (context.badgeCount < chain.required_badges) {
            continue;
          }
          
          matches.push(chain);
        }
      }
    }
    
    return matches;
  }

  /**
   * 检查技能序列是否匹配
   */
  matchesSequence(currentSequence, triggerSequence) {
    if (currentSequence.length < triggerSequence.length) {
      return false;
    }
    
    // 获取最后 N 个技能
    const lastN = currentSequence.slice(-triggerSequence.length);
    
    // 逐个比较
    for (let i = 0; i < triggerSequence.length; i++) {
      if (lastN[i] !== triggerSequence[i]) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * 检查是否在时间窗口内
   */
  checkTimeWindow(state, timeWindowMs) {
    if (state.sequence.length === 0) return false;
    
    const startTime = state.sequence[0].timestamp;
    const endTime = state.sequence[state.sequence.length - 1].timestamp;
    const duration = endTime - startTime;
    
    return duration <= timeWindowMs;
  }

  /**
   * 选择最优连击（优先选择伤害倍率最高的）
   */
  selectBestCombo(matchedCombos) {
    return matchedCombos.reduce((best, current) => {
      if (!best) return current;
      
      // 优先选择伤害倍率高的
      if (current.damage_multiplier > best.damage_multiplier) {
        return current;
      }
      
      // 相同倍率选择连击点数多的
      if (current.damage_multiplier === best.damage_multiplier &&
          current.combo_points > best.combo_points) {
        return current;
      }
      
      return best;
    }, null);
  }

  /**
   * 评估连击质量
   */
  evaluateComboQuality(state, chain) {
    const expectedWindow = chain.time_window_ms;
    const actualTime = state.sequence[state.sequence.length - 1].timestamp -
                       state.sequence[0].timestamp;
    
    const ratio = actualTime / expectedWindow;
    
    // 完美：半时间内完成
    if (ratio < 0.5) {
      return 'perfect';
    }
    
    // 优秀：80% 时间内完成
    if (ratio < 0.8) {
      return 'excellent';
    }
    
    // 普通
    return 'normal';
  }

  /**
   * 应用连击效果
   */
  async applyComboEffect(userId, pokemonId, chain, quality, context) {
    const qualityMultiplier = {
      perfect: 1.5,
      excellent: 1.25,
      normal: 1.0
    };
    
    const multiplier = qualityMultiplier[quality];
    
    // 计算效果
    const effect = {
      damageMultiplier: chain.damage_multiplier * multiplier,
      bonusEffects: chain.bonus_effects || {},
      cooldownReduction: Math.floor(chain.cooldown_reduction * multiplier),
      comboPoints: Math.floor(chain.combo_points * multiplier),
      quality,
      xpBonus: Math.floor(chain.xp_bonus * multiplier)
    };
    
    // 完美连击额外奖励
    if (quality === 'perfect') {
      effect.bonusEffects = {
        ...effect.bonusEffects,
        perfect_bonus: {
          crit_rate_boost: 20,
          accuracy_boost: 10
        }
      };
    }
    
    return effect;
  }

  /**
   * 记录连击执行统计
   */
  async recordComboExecution(userId, pokemonId, chain, quality, effect, context) {
    const trx = await db.transaction();
    
    try {
      // 更新玩家连击统计
      await trx('user_combo_stats')
        .insert({
          user_id: userId,
          chain_id: chain.chain_id,
          times_executed: 1,
          perfect_executions: quality === 'perfect' ? 1 : 0,
          last_executed_at: new Date(),
          highest_damage_dealt: effect.damageMultiplier * (context.baseDamage || 0)
        })
        .onConflict(['user_id', 'chain_id'])
        .merge({
          times_executed: db.raw('user_combo_stats.times_executed + 1'),
          perfect_executions: db.raw(`user_combo_stats.perfect_executions + ${quality === 'perfect' ? 1 : 0}`),
          last_executed_at: new Date(),
          highest_damage_dealt: db.raw(`GREATEST(user_combo_stats.highest_damage_dealt, ${effect.damageMultiplier * (context.baseDamage || 0)})`),
          updated_at: new Date()
        });
      
      // 记录连击历史
      await trx('combo_records').insert({
        user_id: userId,
        chain_id: chain.chain_id,
        pokemon_id: pokemonId,
        battle_type: context.battleType || 'pvp',
        quality,
        damage_dealt: effect.damageMultiplier * (context.baseDamage || 0),
        combo_points_earned: effect.comboPoints,
        battle_id: context.battleId,
        opponent_id: context.opponentId
      });
      
      await trx.commit();
      
      logger.info({
        userId,
        chainId: chain.chain_id,
        quality,
        comboPoints: effect.comboPoints
      }, 'Combo executed successfully');
    } catch (error) {
      await trx.rollback();
      logger.error('Failed to record combo execution:', error);
      throw error;
    }
  }

  /**
   * 检查是否超时
   */
  isTimeout(state) {
    if (state.sequence.length === 0) return false;
    
    const lastSkillTime = state.sequence[state.sequence.length - 1].timestamp;
    const now = Date.now();
    
    // 超过默认时间窗口的 2 倍则超时
    return (now - lastSkillTime) > this.config.defaultTimeWindow * this.config.timeoutMultiplier;
  }

  /**
   * 重置状态
   */
  resetState(stateKey) {
    this.activeCombos.delete(stateKey);
  }

  /**
   * 获取用户活跃连击状态
   */
  getActiveState(userId, pokemonId) {
    const stateKey = `${userId}_${pokemonId}`;
    return this.activeCombos.get(stateKey);
  }

  /**
   * 启动定期清理
   */
  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      const threshold = this.config.defaultTimeWindow * this.config.timeoutMultiplier;
      
      for (const [key, state] of this.activeCombos) {
        if (now - state.lastUpdate > threshold) {
          this.activeCombos.delete(key);
        }
      }
      
      logger.debug(`Cleanup: ${this.activeCombos.size} active combos remaining`);
    }, this.config.cleanupInterval);
  }

  /**
   * 获取所有连击链配置
   */
  getAllComboChains() {
    return Array.from(this.comboChains.values());
  }

  /**
   * 根据玩家等级过滤可用连击
   */
  getAvailableComboChains(trainerLevel, badgeCount = 0) {
    return this.getAllComboChains().filter(chain => 
      chain.min_trainer_level <= trainerLevel &&
      chain.required_badges <= badgeCount
    );
  }

  /**
   * 获取连击链详情
   */
  getComboChainDetails(chainId) {
    return this.comboChains.get(chainId);
  }
}

// 导出单例
module.exports = new ComboEngine();
