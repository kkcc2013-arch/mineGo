// backend/services/pokemon-service/src/trainingCampService.js
// REQ-00370: 精灵训练营系统
'use strict';

const { query, transaction, getPool } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

const logger = createLogger('training-camp-service');

/**
 * 精灵训练营服务
 */
class TrainingCampService {
  constructor() {
    // 训练类型配置
    this.campTypes = {
      experience: { name: '经验训练营', maxLevel: 10, baseCapacity: 3 },
      skill: { name: '技能训练营', maxLevel: 10, baseCapacity: 2 },
      friendship: { name: '亲密度训练营', maxLevel: 10, baseCapacity: 3 }
    };
    
    // 加速道具效果
    this.boostEffects = {
      time_50: { timeReduction: 0.5, name: '时间减半' },
      time_75: { timeReduction: 0.75, name: '时间减少75%' },
      instant: { timeReduction: 1.0, name: '立即完成' },
      exp_double: { expMultiplier: 2.0, name: '经验翻倍' }
    };
  }

  /**
   * 初始化玩家训练营（首次访问时调用）
   */
  async initUserCamps(userId) {
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查是否已初始化
      const existing = await client.query(
        'SELECT id FROM user_training_camps WHERE user_id = $1',
        [userId]
      );
      
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows;
      }
      
      // 获取所有训练营类型
      const camps = await client.query('SELECT id, base_capacity FROM training_camps');
      
      // 为玩家创建所有训练营
      const results = [];
      for (const camp of camps.rows) {
        const result = await client.query(
          `INSERT INTO user_training_camps (user_id, camp_id, level, capacity)
           VALUES ($1, $2, 1, $3)
           RETURNING *`,
          [userId, camp.id, camp.base_capacity]
        );
        results.push(result.rows[0]);
      }
      
      await client.query('COMMIT');
      
      logger.info('玩家训练营初始化完成', { userId, campCount: results.length });
      return results;
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('初始化玩家训练营失败', { error, userId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取玩家所有训练营信息
   */
  async getUserCamps(userId) {
    const result = await query(
      `SELECT utc.*, tc.name, tc.type, tc.description, tc.icon_url, tc.max_level
       FROM user_training_camps utc
       JOIN training_camps tc ON utc.camp_id = tc.id
       WHERE utc.user_id = $1
       ORDER BY tc.id`,
      [userId]
    );
    
    // 获取每个训练营的训练中槽位
    for (const camp of result.rows) {
      camp.slots = await this.getCampSlots(userId, camp.camp_id);
      camp.availableSlots = camp.capacity - camp.slots.filter(s => s.status === 'training').length;
    }
    
    return result.rows;
  }

  /**
   * 获取训练营的训练槽位
   */
  async getCampSlots(userId, campId) {
    const result = await query(
      `SELECT ts.*, tc.name as course_name, tc.duration_minutes,
              up.species_id, up.nickname, up.level as pokemon_level,
              ps.name as species_name
       FROM training_slots ts
       JOIN training_courses tc ON ts.course_id = tc.id
       JOIN user_pokemon up ON ts.pokemon_id = up.id
       LEFT JOIN pokemon_species ps ON up.species_id = ps.id
       WHERE ts.user_id = $1 AND ts.camp_id = $2
       ORDER BY ts.slot_index`,
      [userId, campId]
    );
    
    // 计算剩余时间
    const now = new Date();
    for (const slot of result.rows) {
      if (slot.status === 'training' && slot.ends_at) {
        const endsAt = new Date(slot.ends_at);
        slot.remainingMinutes = Math.max(0, Math.ceil((endsAt - now) / 60000));
        slot.progress = this.calculateProgress(slot.started_at, slot.ends_at, now);
      }
    }
    
    return result.rows;
  }

  /**
   * 获取可用课程列表
   */
  async getAvailableCourses(userId, campId) {
    const result = await query(
      `SELECT tc.*, t.name as camp_name, t.type as camp_type
       FROM training_courses tc
       JOIN training_camps t ON tc.camp_id = t.id
       WHERE tc.camp_id = $1
       ORDER BY tc.required_camp_level, tc.id`,
      [campId]
    );
    
    // 获取玩家训练营等级
    const userCamp = await query(
      'SELECT level FROM user_training_camps WHERE user_id = $1 AND camp_id = $2',
      [userId, campId]
    );
    
    const userLevel = userCamp.rows[0]?.level || 1;
    
    // 标记课程是否可用
    for (const course of result.rows) {
      course.unlocked = userLevel >= course.required_camp_level;
      course.lockedReason = course.unlocked ? null : `需要训练营等级 ${course.required_camp_level}`;
      
      // 计算实际奖励（基于训练营等级）
      course.actualExp = course.exp_reward + (course.exp_reward_per_level || 0) * (userLevel - 1);
      course.actualFriendship = course.friendship_reward + (course.friendship_reward_per_level || 0) * (userLevel - 1);
    }
    
    return result.rows;
  }

  /**
   * 开始训练
   */
  async startTraining(userId, campId, slotIndex, pokemonId, courseId) {
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 验证训练营和槽位
      const campResult = await client.query(
        `SELECT utc.*, tc.type as camp_type
         FROM user_training_camps utc
         JOIN training_camps tc ON utc.camp_id = tc.id
         WHERE utc.user_id = $1 AND utc.camp_id = $2`,
        [userId, campId]
      );
      
      if (campResult.rows.length === 0) {
        throw new Error('训练营不存在');
      }
      
      const camp = campResult.rows[0];
      
      if (slotIndex >= camp.capacity) {
        throw new Error('槽位索引超出范围');
      }
      
      // 检查槽位是否已被占用
      const slotResult = await client.query(
        `SELECT id FROM training_slots 
         WHERE user_id = $1 AND camp_id = $2 AND slot_index = $3 AND status = 'training'`,
        [userId, campId, slotIndex]
      );
      
      if (slotResult.rows.length > 0) {
        throw new Error('该槽位正在使用中');
      }
      
      // 验证精灵
      const pokemonResult = await client.query(
        'SELECT * FROM user_pokemon WHERE id = $1 AND user_id = $2',
        [pokemonId, userId]
      );
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('精灵不存在或无权访问');
      }
      
      const pokemon = pokemonResult.rows[0];
      
      // 验证课程
      const courseResult = await client.query(
        'SELECT * FROM training_courses WHERE id = $1 AND camp_id = $2',
        [courseId, campId]
      );
      
      if (courseResult.rows.length === 0) {
        throw new Error('课程不存在');
      }
      
      const course = courseResult.rows[0];
      
      // 检查训练营等级
      if (camp.level < course.required_camp_level) {
        throw new Error(`需要训练营等级 ${course.required_camp_level}`);
      }
      
      // 检查精灵等级限制
      if (course.max_pokemon_level && pokemon.level > course.max_pokemon_level) {
        throw new Error(`精灵等级超出课程限制`);
      }
      
      if (pokemon.level < course.min_pokemon_level) {
        throw new Error(`精灵等级不足`);
      }
      
      // 检查精灵是否已在训练中
      const inTrainingResult = await client.query(
        `SELECT id FROM training_slots 
         WHERE pokemon_id = $1 AND status = 'training'`,
        [pokemonId]
      );
      
      if (inTrainingResult.rows.length > 0) {
        throw new Error('该精灵正在其他训练营中');
      }
      
      // 扣除资源
      if (course.cost_type !== 'free' && course.cost_amount > 0) {
        await this.deductCost(client, userId, course.cost_type, course.cost_amount);
      }
      
      // 计算训练结束时间
      const now = new Date();
      const endsAt = new Date(now.getTime() + course.duration_minutes * 60000);
      
      // 计算预期奖励
      const expectedExp = course.exp_reward + (course.exp_reward_per_level || 0) * (camp.level - 1);
      const expectedFriendship = course.friendship_reward + (course.friendship_reward_per_level || 0) * (camp.level - 1);
      
      // 创建训练槽位
      const insertResult = await client.query(
        `INSERT INTO training_slots 
         (user_id, camp_id, slot_index, pokemon_id, course_id, status, started_at, ends_at,
          expected_exp, expected_friendship, expected_skill_id)
         VALUES ($1, $2, $3, $4, $5, 'training', $6, $7, $8, $9, $10)
         RETURNING *`,
        [userId, campId, slotIndex, pokemonId, courseId, now, endsAt, 
         expectedExp, expectedFriendship, course.skill_id]
      );
      
      await client.query('COMMIT');
      
      // 记录指标
      metrics.increment('training.started', 1, { camp_type: camp.camp_type });
      
      logger.info('训练开始', {
        userId,
        campId,
        slotIndex,
        pokemonId,
        courseId,
        endsAt
      });
      
      return {
        slot: insertResult.rows[0],
        endsAt,
        expectedExp,
        expectedFriendship
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('开始训练失败', { error, userId, campId, pokemonId, courseId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 完成训练并领取奖励
   */
  async completeTraining(userId, slotId) {
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取训练槽位
      const slotResult = await client.query(
        `SELECT ts.*, tc.type as camp_type, tc.name as course_name,
                tc.exp_reward, tc.exp_reward_per_level,
                tc.friendship_reward, tc.friendship_reward_per_level,
                tc.skill_id as course_skill_id,
                up.species_id, up.nickname, up.level as pokemon_level
         FROM training_slots ts
         JOIN training_courses tc ON ts.course_id = tc.id
         JOIN user_pokemon up ON ts.pokemon_id = up.id
         WHERE ts.id = $1 AND ts.user_id = $2`,
        [slotId, userId]
      );
      
      if (slotResult.rows.length === 0) {
        throw new Error('训练槽位不存在');
      }
      
      const slot = slotResult.rows[0];
      
      // 检查是否已到达结束时间
      const now = new Date();
      if (now < new Date(slot.ends_at)) {
        throw new Error('训练尚未完成');
      }
      
      // 计算实际奖励
      const rating = this.calculateRating(slot);
      const expGained = Math.floor(slot.expected_exp * this.getRatingMultiplier(rating));
      const friendshipGained = Math.floor(slot.expected_friendship * this.getRatingMultiplier(rating));
      
      // 更新精灵属性
      await client.query(
        `UPDATE user_pokemon 
         SET exp = exp + $1, 
             friendship = LEAST(255, friendship + $2),
             updated_at = NOW()
         WHERE id = $3`,
        [expGained, friendshipGained, slot.pokemon_id]
      );
      
      // 如果是技能训练营且精灵学会了技能
      let skillLearned = null;
      if (slot.course_skill_id && Math.random() < 0.8) { // 80% 学习成功率
        await client.query(
          `INSERT INTO pokemon_moves (pokemon_id, move_id, learned_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [slot.pokemon_id, slot.course_skill_id]
        );
        skillLearned = slot.course_skill_id;
      }
      
      // 更新训练槽位状态
      await client.query(
        `UPDATE training_slots 
         SET status = 'completed', completed_at = NOW(),
             actual_exp = $1, actual_friendship = $2, skill_learned = $3
         WHERE id = $4`,
        [expGained, friendshipGained, skillLearned ? true : false, slotId]
      );
      
      // 创建训练报告
      const reportResult = await client.query(
        `INSERT INTO training_reports 
         (user_id, slot_id, pokemon_id, camp_type, course_name, duration_minutes,
          exp_gained, friendship_gained, skill_learned_id, cost_type, cost_amount, rating)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [userId, slotId, slot.pokemon_id, slot.camp_type, slot.course_name, 
         slot.duration_minutes || Math.ceil((slot.ends_at - slot.started_at) / 60000),
         expGained, friendshipGained, skillLearned, 
         'completed', 0, rating]
      );
      
      await client.query('COMMIT');
      
      // 记录指标
      metrics.increment('training.completed', 1, { camp_type: slot.camp_type });
      metrics.histogram('training.exp_gained', expGained, { camp_type: slot.camp_type });
      
      logger.info('训练完成', {
        userId,
        slotId,
        pokemonId: slot.pokemon_id,
        expGained,
        friendshipGained,
        skillLearned
      });
      
      return {
        report: reportResult.rows[0],
        rewards: {
          exp: expGained,
          friendship: friendshipGained,
          skillLearned
        }
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('完成训练失败', { error, userId, slotId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 使用加速道具
   */
  async useBoost(userId, slotId, boostType) {
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取训练槽位
      const slotResult = await client.query(
        `SELECT * FROM training_slots WHERE id = $1 AND user_id = $2 AND status = 'training'`,
        [slotId, userId]
      );
      
      if (slotResult.rows.length === 0) {
        throw new Error('训练槽位不存在或已完成');
      }
      
      const slot = slotResult.rows[0];
      
      // 检查玩家是否有该加速道具
      const boostResult = await client.query(
        `SELECT * FROM training_boosts 
         WHERE user_id = $1 AND boost_type = $2 AND remaining_uses > 0
         AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId, boostType]
      );
      
      if (boostResult.rows.length === 0) {
        throw new Error('加速道具不足');
      }
      
      const boost = boostResult.rows[0];
      const effect = this.boostEffects[boostType];
      
      // 计算新的结束时间
      let newEndsAt;
      if (boostType === 'instant') {
        newEndsAt = new Date(); // 立即完成
      } else {
        const remainingMs = new Date(slot.ends_at) - new Date();
        const newRemainingMs = remainingMs * (1 - effect.timeReduction);
        newEndsAt = new Date(Date.now() + newRemainingMs);
      }
      
      // 更新训练槽位
      await client.query(
        `UPDATE training_slots 
         SET ends_at = $1, boost_used = true, boost_type = $2, boost_ends_at = $3
         WHERE id = $4`,
        [newEndsAt, boostType, newEndsAt, slotId]
      );
      
      // 扣除加速道具
      await client.query(
        `UPDATE training_boosts 
         SET remaining_uses = remaining_uses - 1
         WHERE id = $1`,
        [boost.id]
      );
      
      await client.query('COMMIT');
      
      metrics.increment('training.boost_used', 1, { boost_type: boostType });
      
      logger.info('使用加速道具', {
        userId,
        slotId,
        boostType,
        newEndsAt
      });
      
      return {
        success: true,
        newEndsAt
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('使用加速道具失败', { error, userId, slotId, boostType });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 取消训练
   */
  async cancelTraining(userId, slotId) {
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(
        `UPDATE training_slots 
         SET status = 'cancelled', completed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'training'
         RETURNING *`,
        [slotId, userId]
      );
      
      if (result.rows.length === 0) {
        throw new Error('训练槽位不存在或已完成');
      }
      
      await client.query('COMMIT');
      
      logger.info('取消训练', { userId, slotId });
      
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 升级训练营
   */
  async upgradeCamp(userId, campId) {
    const client = await getPool().connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前训练营信息
      const campResult = await client.query(
        `SELECT utc.*, tc.max_level, tc.capacity_per_level
         FROM user_training_camps utc
         JOIN training_camps tc ON utc.camp_id = tc.id
         WHERE utc.user_id = $1 AND utc.camp_id = $2`,
        [userId, campId]
      );
      
      if (campResult.rows.length === 0) {
        throw new Error('训练营不存在');
      }
      
      const camp = campResult.rows[0];
      
      if (camp.level >= camp.max_level) {
        throw new Error('已达到最高等级');
      }
      
      // 计算升级费用
      const upgradeCost = this.calculateUpgradeCost(camp.level);
      
      // 扣除资源
      await this.deductCost(client, userId, 'gold', upgradeCost);
      
      // 升级训练营
      const newLevel = camp.level + 1;
      const newCapacity = camp.capacity + camp.capacity_per_level;
      
      const result = await client.query(
        `UPDATE user_training_camps 
         SET level = $1, capacity = $2, upgraded_at = NOW(), updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [newLevel, newCapacity, camp.id]
      );
      
      await client.query('COMMIT');
      
      metrics.increment('training.camp_upgraded', 1);
      
      logger.info('训练营升级', {
        userId,
        campId,
        newLevel,
        newCapacity
      });
      
      return result.rows[0];
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取训练历史
   */
  async getTrainingHistory(userId, limit = 20, offset = 0) {
    const result = await query(
      `SELECT tr.*, ps.name as species_name
       FROM training_reports tr
       JOIN user_pokemon up ON tr.pokemon_id = up.id
       LEFT JOIN pokemon_species ps ON up.species_id = ps.id
       WHERE tr.user_id = $1
       ORDER BY tr.completed_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    
    return result.rows;
  }

  /**
   * 处理已完成的训练（定时任务调用）
   */
  async processCompletedTrainings() {
    const result = await query(
      `UPDATE training_slots 
       SET status = 'ready'
       WHERE status = 'training' AND ends_at <= NOW()
       RETURNING id, user_id`
    );
    
    logger.info('处理完成的训练', { count: result.rows.length });
    
    return result.rows;
  }

  // 辅助方法
  
  async deductCost(client, userId, costType, amount) {
    switch (costType) {
      case 'gold':
        await client.query(
          `UPDATE users SET gold = gold - $1 WHERE id = $2 AND gold >= $1`,
          [amount, userId]
        );
        break;
      case 'stardust':
        await client.query(
          `UPDATE users SET stardust = stardust - $1 WHERE id = $2 AND stardust >= $1`,
          [amount, userId]
        );
        break;
      case 'premium':
        await client.query(
          `UPDATE users SET premium_currency = premium_currency - $1 WHERE id = $2 AND premium_currency >= $1`,
          [amount, userId]
        );
        break;
    }
  }

  calculateProgress(startedAt, endsAt, now) {
    const start = new Date(startedAt).getTime();
    const end = new Date(endsAt).getTime();
    const current = now.getTime();
    
    return Math.min(100, Math.max(0, ((current - start) / (end - start)) * 100));
  }

  calculateRating(slot) {
    // 随机评级，但有更高的概率获得好评级
    const rand = Math.random();
    if (rand < 0.05) return 'poor';
    if (rand < 0.40) return 'normal';
    if (rand < 0.80) return 'good';
    return 'excellent';
  }

  getRatingMultiplier(rating) {
    const multipliers = {
      poor: 0.5,
      normal: 1.0,
      good: 1.25,
      excellent: 1.5
    };
    return multipliers[rating] || 1.0;
  }

  calculateUpgradeCost(currentLevel) {
    // 每级升级费用递增
    return 1000 * Math.pow(2, currentLevel);
  }
}

module.exports = new TrainingCampService();