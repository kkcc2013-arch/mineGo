// pokemon-service/src/friendshipCalculator.js
'use strict';

const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('friendship-calculator');

const FRIENDSHIP_LEVELS = {
  MIN: 0,
  BASE_CAPTURE: 70,           // 捕获时基础值
  BASE_HATCH: 120,            // 孵化时基础值
  BASE_TRADE: 70,             // 交易后基础值
  EVOLUTION_THRESHOLD: 220,   // 标准进化阈值
  MAX: 255
};

const FRIENDSHIP_SOURCES = {
  WALK: { amount: 1, description: '行走1km' },
  BATTLE_WIN: { amount: 1, description: '赢得道馆战斗' },
  BATTLE_RAID: { amount: 3, description: '赢得Raid战斗' },
  FEED_BERRY: { amount: 1, description: '喂食树果' },
  FEED_GOLDEN_BERRY: { amount: 3, description: '喂食金果' },
  SPA_TREATMENT: { amount: 2, description: '温泉护理' },
  GIFT_RECEIVE: { amount: 2, description: '收到好友礼物' },
  TRADE_AWAY: { amount: -20, description: '被交易出去' },
  FAINT: { amount: -1, description: '战斗中濒死' },
  ENERGY_DRINK: { amount: -1, description: '使用能量饮料' }
};

const FRIENDSHIP_SOURCE_LABELS = {
  walk: '行走',
  battle_win: '道馆战斗胜利',
  battle_raid: 'Raid战斗',
  feed_berry: '喂食树果',
  feed_golden_berry: '喂食金果',
  spa_treatment: '温泉护理',
  gift_receive: '收到礼物',
  trade_away: '交易',
  faint: '战斗濒死',
  energy_drink: '能量饮料'
};

class FriendshipCalculator {
  /**
   * 获取精灵当前亲密度及等级描述
   */
  async getFriendshipStatus(pokemonId) {
    const { rows: [pokemon] } = await query(`
      SELECT id, species_id, friendship, friendship_updated_at,
             s.name as species_name
      FROM pokemon_instances pi
      JOIN pokemon_species s ON pi.species_id = s.id
      WHERE pi.id = $1
    `, [pokemonId]);

    if (!pokemon) throw new Error('Pokemon not found');

    const level = this.getFriendshipLevel(pokemon.friendship);
    const progress = await this.calculateEvolutionProgress(pokemon);

    return {
      ...pokemon,
      friendshipLevel: level,
      evolutionProgress: progress,
      canEvolve: progress.ready
    };
  }

  /**
   * 亲密度等级描述
   */
  getFriendshipLevel(value) {
    if (value >= 255) return { name: 'best_friends', label: '挚友', color: '#FFD700' };
    if (value >= 220) return { name: 'great_friends', label: '至交', color: '#FF69B4' };
    if (value >= 150) return { name: 'good_friends', label: '好友', color: '#87CEEB' };
    if (value >= 100) return { name: 'friends', label: '朋友', color: '#90EE90' };
    if (value >= 50) return { name: 'buddy', label: '伙伴', color: '#DDA0DD' };
    return { name: 'stranger', label: '陌生', color: '#A9A9A9' };
  }

  /**
   * 计算进化进度
   */
  async calculateEvolutionProgress(pokemon) {
    const { rows: rules } = await query(`
      SELECT fer.*, ps.name as target_name
      FROM friendship_evolution_rules fer
      JOIN pokemon_species ps ON fer.target_species_id = ps.id
      WHERE fer.species_id = $1
    `, [pokemon.species_id]);

    if (rules.length === 0) {
      return { hasEvolution: false, ready: false };
    }

    // 取第一个适用规则（简化处理，实际可能需要多条件检测）
    const rule = rules[0];
    const percentage = Math.min(100, (pokemon.friendship / rule.required_friendship) * 100);
    const needed = Math.max(0, rule.required_friendship - pokemon.friendship);

    // 检查时间限制
    let timeReady = true;
    let currentTimePeriod = null;
    if (rule.time_restriction) {
      const hour = new Date().getHours();
      currentTimePeriod = (hour >= 6 && hour < 18) ? 'day' : 'night';
      timeReady = rule.time_restriction === currentTimePeriod;
    }

    return {
      hasEvolution: true,
      targetSpecies: rule.target_name,
      targetSpeciesId: rule.target_species_id,
      requiredFriendship: rule.required_friendship,
      currentFriendship: pokemon.friendship,
      percentage: Math.round(percentage),
      needed: needed,
      ready: pokemon.friendship >= rule.required_friendship && timeReady,
      timeRestriction: rule.time_restriction,
      currentTimePeriod,
      timeReady
    };
  }

  /**
   * 增加亲密度
   */
  async addFriendship(pokemonId, source, amount = null, context = {}) {
    const sourceConfig = FRIENDSHIP_SOURCES[source.toUpperCase()];
    if (!sourceConfig) throw new Error(`Invalid friendship source: ${source}`);

    const changeAmount = amount !== null ? amount : sourceConfig.amount;

    const client = await query.pool.connect();
    try {
      await client.query('BEGIN');

      // 获取当前值
      const { rows: [current] } = await client.query(`
        SELECT friendship FROM pokemon_instances WHERE id = $1 FOR UPDATE
      `, [pokemonId]);

      if (!current) throw new Error('Pokemon not found');

      const previousValue = current.friendship;
      const newValue = Math.max(FRIENDSHIP_LEVELS.MIN, 
                        Math.min(FRIENDSHIP_LEVELS.MAX, previousValue + changeAmount));

      // 更新亲密度
      await client.query(`
        UPDATE pokemon_instances 
        SET friendship = $1, friendship_updated_at = NOW()
        WHERE id = $2
      `, [newValue, pokemonId]);

      // 记录日志
      await client.query(`
        INSERT INTO pokemon_friendship_logs 
        (pokemon_instance_id, change_amount, source, context, previous_value, new_value)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [pokemonId, changeAmount, source.toLowerCase(), context, previousValue, newValue]);

      await client.query('COMMIT');

      // 检查是否触发进化条件
      const evolutionCheck = await this.checkEvolutionTrigger(pokemonId, newValue);

      logger.info('Friendship updated', {
        pokemonId,
        source,
        previousValue,
        newValue,
        change: changeAmount,
        evolutionReady: evolutionCheck.ready
      });

      return {
        previousValue,
        newValue,
        change: changeAmount,
        evolutionReady: evolutionCheck.ready,
        evolutionTarget: evolutionCheck.target
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 检查进化触发条件
   */
  async checkEvolutionTrigger(pokemonId, currentFriendship) {
    const { rows: [pokemon] } = await query(`
      SELECT species_id FROM pokemon_instances WHERE id = $1
    `, [pokemonId]);

    const { rows: rules } = await query(`
      SELECT * FROM friendship_evolution_rules WHERE species_id = $1
    `, [pokemon.species_id]);

    for (const rule of rules) {
      if (currentFriendship >= rule.required_friendship) {
        // 检查时间限制
        if (rule.time_restriction) {
          const hour = new Date().getHours();
          const currentPeriod = (hour >= 6 && hour < 18) ? 'day' : 'night';
          if (rule.time_restriction !== currentPeriod) continue;
        }

        return { ready: true, target: rule.target_species_id, rule };
      }
    }

    return { ready: false };
  }

  /**
   * 获取亲密度提升建议
   */
  async getFriendshipImprovementSuggestions(pokemonId) {
    const status = await this.getFriendshipStatus(pokemonId);
    
    if (!status.evolutionProgress.hasEvolution) {
      return { suggestions: [], message: '该精灵无法通过亲密度进化' };
    }

    const needed = status.evolutionProgress.needed;
    if (needed <= 0) {
      return { suggestions: [], message: '已达进化条件！' };
    }

    const suggestions = [];

    // 根据需要的亲密度计算最佳提升方式
    if (needed > 0) {
      suggestions.push({
        method: 'walk',
        description: `行走约${Math.ceil(needed)}公里`,
        efficiency: '稳定但较慢',
        estimatedTime: `${Math.ceil(needed / 10)}天（每天10km）`
      });

      suggestions.push({
        method: 'feed_golden_berry',
        description: `喂食约${Math.ceil(needed / 3)}个金果`,
        efficiency: '快速',
        estimatedTime: '即时'
      });

      suggestions.push({
        method: 'battle_raid',
        description: `参加约${Math.ceil(needed / 3)}场Raid战斗`,
        efficiency: '战斗爱好者首选',
        estimatedTime: `${Math.ceil(needed / 3)}场战斗`
      });

      suggestions.push({
        method: 'spa_treatment',
        description: `温泉护理约${Math.ceil(needed / 2)}次`,
        efficiency: '轻松休闲',
        estimatedTime: `${Math.ceil(needed / 2)}次护理`
      });
    }

    return {
      needed,
      suggestions,
      currentFriendship: status.friendship,
      targetFriendship: status.evolutionProgress.requiredFriendship
    };
  }

  /**
   * 获取亲密度历史记录
   */
  async getFriendshipHistory(pokemonId, limit = 20) {
    const { rows } = await query(`
      SELECT 
        change_amount, source, context, previous_value, new_value, created_at,
        CASE source
          WHEN 'walk' THEN '行走'
          WHEN 'battle_win' THEN '道馆战斗胜利'
          WHEN 'battle_raid' THEN 'Raid战斗'
          WHEN 'feed_berry' THEN '喂食树果'
          WHEN 'feed_golden_berry' THEN '喂食金果'
          WHEN 'spa_treatment' THEN '温泉护理'
          WHEN 'gift_receive' THEN '收到礼物'
          WHEN 'trade_away' THEN '交易'
          WHEN 'faint' THEN '战斗濒死'
          WHEN 'energy_drink' THEN '能量饮料'
          ELSE source
        END as source_label
      FROM pokemon_friendship_logs
      WHERE pokemon_instance_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [pokemonId, limit]);

    return rows;
  }

  /**
   * 预估进化后CP
   */
  estimateEvolvedCP(pokemon, targetSpecies) {
    // 简化的CP计算公式
    // CP = (Attack * Defense^0.5 * Stamina^0.5 * CP_Multiplier^2) / 10
    const cpMultiplier = pokemon.level ? this.getCPMultiplier(pokemon.level) : 0.7;
    
    const attack = (pokemon.attack_iv + targetSpecies.base_attack) * cpMultiplier;
    const defense = (pokemon.defense_iv + targetSpecies.base_defense) * cpMultiplier;
    const stamina = (pokemon.stamina_iv + targetSpecies.base_stamina) * cpMultiplier;
    
    return Math.floor((attack * Math.sqrt(defense) * Math.sqrt(stamina)) / 10);
  }

  /**
   * 获取CP乘数
   */
  getCPMultiplier(level) {
    // 简化的CP乘数表
    const multipliers = {
      1: 0.094, 10: 0.290, 20: 0.597, 30: 0.731, 40: 0.790
    };
    
    const keys = Object.keys(multipliers).map(Number).sort((a, b) => a - b);
    for (const key of keys) {
      if (level <= key) return multipliers[key];
    }
    return multipliers[40];
  }
}

module.exports = {
  FriendshipCalculator,
  FRIENDSHIP_LEVELS,
  FRIENDSHIP_SOURCES,
  FRIENDSHIP_SOURCE_LABELS
};
