# REQ-00370: 精灵训练营系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00370 |
| 标题 | 精灵训练营系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 17:30 UTC |

## 需求描述

精灵训练营系统是一个被动训练机制，允许玩家将精灵送入训练营进行离线训练。训练期间精灵可以获得经验值、提升亲密度或学习新技能。玩家可以根据精灵的需求选择不同的训练课程。

### 核心功能
1. **多类型训练营**：提供经验训练营、技能训练营、亲密度训练营三种类型
2. **训练队列系统**：每个玩家有固定数量的训练槽位，可通过购买或升级扩展
3. **训练课程选择**：不同课程有不同的训练效果和资源消耗
4. **训练加速道具**：支持使用道具加速训练进度
5. **训练报告系统**：训练完成后提供详细报告，包含收益数据

### 业务价值
- 增加玩家离线收益，提高日活跃率
- 提供新的资源消耗途径，平衡游戏经济
- 增强精灵培养体验，丰富游戏内容
- 促进付费转化（训练槽位扩展、加速道具）

## 技术方案

### 1. 数据库设计

```sql
-- 训练营配置表
CREATE TABLE training_camps (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'experience', 'skill', 'friendship'
  description TEXT,
  max_level INT DEFAULT 10,
  base_capacity INT DEFAULT 3,
  capacity_per_level INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 训练课程配置表
CREATE TABLE training_courses (
  id SERIAL PRIMARY KEY,
  camp_id INT REFERENCES training_camps(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  duration_minutes INT NOT NULL,
  cost_type VARCHAR(50), -- 'gold', 'stardust', 'premium'
  cost_amount INT NOT NULL,
  exp_reward INT DEFAULT 0,
  skill_id INT, -- 可学习的技能ID
  friendship_reward INT DEFAULT 0,
  required_level INT DEFAULT 1,
  max_pokemon_level INT, -- 适用精灵等级上限
  is_premium BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 玩家训练营等级表
CREATE TABLE user_training_camps (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  camp_id INT REFERENCES training_camps(id),
  level INT DEFAULT 1,
  capacity INT DEFAULT 3,
  upgrade_materials JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, camp_id)
);

-- 训练队列表
CREATE TABLE training_slots (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  camp_id INT REFERENCES training_camps(id),
  slot_index INT NOT NULL,
  pokemon_instance_id INT REFERENCES pokemon_instances(id),
  course_id INT REFERENCES training_courses(id),
  started_at TIMESTAMP NOT NULL,
  ends_at TIMESTAMP NOT NULL,
  progress_percentage DECIMAL(5,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'training', -- 'training', 'completed', 'cancelled'
  acceleration_items JSONB DEFAULT '[]',
  completion_rewards JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, camp_id, slot_index)
);

-- 训练历史记录表
CREATE TABLE training_history (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  pokemon_instance_id INT REFERENCES pokemon_instances(id),
  course_id INT REFERENCES training_courses(id),
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP NOT NULL,
  actual_duration_minutes INT,
  rewards JSONB NOT NULL,
  acceleration_items_used JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_training_slots_user_camp ON training_slots(user_id, camp_id);
CREATE INDEX idx_training_slots_status ON training_slots(status);
CREATE INDEX idx_training_slots_ends_at ON training_slots(ends_at);
CREATE INDEX idx_training_history_user ON training_history(user_id);
CREATE INDEX idx_training_history_pokemon ON training_history(pokemon_instance_id);
```

### 2. 后端服务实现

#### pokemon-service/routes/trainingCamp.js

```javascript
/**
 * REQ-00370: 精灵训练营系统 API
 * 路由: /api/pokemon/training-camp
 */

const express = require('express');
const router = express.Router();
const db = require('../../../shared/db');
const logger = require('../../../shared/logger');
const { authenticate } = require('../../../shared/authMiddleware');
const { sendKafkaEvent } = require('../../../shared/kafkaProducer');
const metrics = require('../../../shared/metrics');
const TrainingCampService = require('../services/TrainingCampService');
const TrainingQueueManager = require('../services/TrainingQueueManager');

/**
 * GET /api/pokemon/training-camp/camps
 * 获取所有训练营信息
 */
router.get('/camps', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 获取训练营配置
    const camps = await db.query(`
      SELECT tc.*, 
        COALESCE(utc.level, 1) as user_level,
        COALESCE(utc.capacity, tc.base_capacity) as user_capacity
      FROM training_camps tc
      LEFT JOIN user_training_camps utc ON tc.id = utc.camp_id AND utc.user_id = $1
      ORDER BY tc.id
    `, [userId]);
    
    res.json({
      success: true,
      data: camps.rows
    });
  } catch (error) {
    logger.error('获取训练营信息失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/pokemon/training-camp/courses
 * 获取可用的训练课程
 */
router.get('/courses', authenticate, async (req, res) => {
  try {
    const { campId, pokemonId } = req.query;
    const userId = req.user.id;
    
    // 获取课程配置
    let query = `
      SELECT tc.*, 
        CASE WHEN tc.cost_type = 'gold' THEN tc.cost_amount ELSE 0 END as gold_cost,
        CASE WHEN tc.cost_type = 'stardust' THEN tc.cost_amount ELSE 0 END as stardust_cost
      FROM training_courses tc
      WHERE tc.required_level <= (
        SELECT COALESCE(level, 1) FROM user_training_camps 
        WHERE user_id = $1 AND camp_id = tc.camp_id
      )
    `;
    const params = [userId];
    
    if (campId) {
      query += ' AND tc.camp_id = $2';
      params.push(campId);
    }
    
    // 如果指定了精灵，筛选适合该精灵的课程
    if (pokemonId) {
      const pokemon = await db.query(`
        SELECT level FROM pokemon_instances WHERE id = $1 AND owner_id = $2
      `, [pokemonId, userId]);
      
      if (pokemon.rows.length > 0) {
        const pokemonLevel = pokemon.rows[0].level;
        query += params.length > 1 ? ' AND $3' : ' AND $2';
        query += `::int >= tc.required_level AND (tc.max_pokemon_level IS NULL OR ${pokemonLevel} <= tc.max_pokemon_level)`;
        params.push(pokemonLevel);
      }
    }
    
    query += ' ORDER BY tc.duration_minutes ASC';
    
    const courses = await db.query(query, params);
    
    res.json({
      success: true,
      data: courses.rows
    });
  } catch (error) {
    logger.error('获取训练课程失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/pokemon/training-camp/slots
 * 获取当前训练队列
 */
router.get('/slots', authenticate, async (req, res) => {
  try {
    const { campId } = req.query;
    const userId = req.user.id;
    
    let query = `
      SELECT ts.*, 
        tc.name as course_name,
        tc.type as camp_type,
        ps.name as pokemon_name,
        ps.pokedex_number,
        pi.level as pokemon_level,
        pi.nickname as pokemon_nickname,
        EXTRACT(EPOCH FROM (ts.ends_at - NOW())) / 60 as remaining_minutes
      FROM training_slots ts
      JOIN training_courses tc ON ts.course_id = tc.id
      JOIN pokemon_instances pi ON ts.pokemon_instance_id = pi.id
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE ts.user_id = $1 AND ts.status IN ('training', 'completed')
    `;
    const params = [userId];
    
    if (campId) {
      query += ' AND ts.camp_id = $2';
      params.push(campId);
    }
    
    query += ' ORDER BY ts.slot_index ASC';
    
    const slots = await db.query(query, params);
    
    // 计算实时进度
    const slotsWithProgress = slots.rows.map(slot => {
      if (slot.status === 'completed') {
        return { ...slot, progress_percentage: 100 };
      }
      
      const totalDuration = (new Date(slot.ends_at) - new Date(slot.started_at)) / 1000 / 60;
      const elapsed = totalDuration - slot.remaining_minutes;
      const progress = Math.min(100, (elapsed / totalDuration) * 100);
      
      return { ...slot, progress_percentage: Math.round(progress * 100) / 100 };
    });
    
    res.json({
      success: true,
      data: slotsWithProgress
    });
  } catch (error) {
    logger.error('获取训练队列失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/pokemon/training-camp/start
 * 开始训练
 */
router.post('/start', authenticate, async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { campId, pokemonId, courseId, slotIndex } = req.body;
    const userId = req.user.id;
    
    // 验证精灵所有权
    const pokemon = await client.query(`
      SELECT pi.*, ps.name as species_name
      FROM pokemon_instances pi
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE pi.id = $1 AND pi.owner_id = $2
      FOR UPDATE
    `, [pokemonId, userId]);
    
    if (pokemon.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_POKEMON',
        message: '精灵不存在或不属于该用户'
      });
    }
    
    // 检查精灵是否已在训练中
    const existingTraining = await client.query(`
      SELECT id FROM training_slots 
      WHERE pokemon_instance_id = $1 AND status = 'training'
    `, [pokemonId]);
    
    if (existingTraining.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'POKEMON_IN_TRAINING',
        message: '该精灵正在训练中'
      });
    }
    
    // 获取训练营信息和槽位容量
    const campInfo = await client.query(`
      SELECT tc.*, 
        COALESCE(utc.level, 1) as user_level,
        COALESCE(utc.capacity, tc.base_capacity) as user_capacity
      FROM training_camps tc
      LEFT JOIN user_training_camps utc ON tc.id = utc.camp_id AND utc.user_id = $1
      WHERE tc.id = $2
    `, [userId, campId]);
    
    if (campInfo.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_CAMP',
        message: '训练营不存在'
      });
    }
    
    // 获取课程信息
    const course = await client.query(`
      SELECT * FROM training_courses WHERE id = $1
    `, [courseId]);
    
    if (course.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_COURSE',
        message: '训练课程不存在'
      });
    }
    
    // 检查槽位可用性
    const currentSlots = await client.query(`
      SELECT COUNT(*) as count FROM training_slots
      WHERE user_id = $1 AND camp_id = $2 AND status = 'training'
    `, [userId, campId]);
    
    if (parseInt(currentSlots.rows[0].count) >= campInfo.rows[0].user_capacity) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'NO_AVAILABLE_SLOT',
        message: '没有可用的训练槽位'
      });
    }
    
    // 扣除资源
    const courseData = course.rows[0];
    await TrainingCampService.deductResources(client, userId, courseData);
    
    // 创建训练槽位
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + courseData.duration_minutes * 60000);
    
    const slotResult = await client.query(`
      INSERT INTO training_slots 
        (user_id, camp_id, slot_index, pokemon_instance_id, course_id, started_at, ends_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'training')
      RETURNING *
    `, [userId, campId, slotIndex || currentSlots.rows[0].count + 1, pokemonId, courseId, startTime, endTime]);
    
    // 发送 Kafka 事件
    await sendKafkaEvent('training.started', {
      userId,
      slotId: slotResult.rows[0].id,
      campId,
      courseId,
      pokemonId,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString()
    });
    
    await client.query('COMMIT');
    
    // 记录指标
    metrics.trainingStartTotal?.inc({ camp_type: campInfo.rows[0].type });
    
    logger.info('训练开始', {
      userId,
      pokemonId,
      courseId,
      duration: courseData.duration_minutes
    });
    
    res.json({
      success: true,
      data: {
        slot: slotResult.rows[0],
        endTime: endTime.toISOString(),
        message: '训练已开始'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('开始训练失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/training-camp/complete
 * 完成训练并领取奖励
 */
router.post('/complete', authenticate, async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { slotId } = req.body;
    const userId = req.user.id;
    
    // 获取训练槽位信息
    const slot = await client.query(`
      SELECT ts.*, tc.*, pi.level as pokemon_level
      FROM training_slots ts
      JOIN training_courses tc ON ts.course_id = tc.id
      JOIN pokemon_instances pi ON ts.pokemon_instance_id = pi.id
      WHERE ts.id = $1 AND ts.user_id = $2 AND ts.status = 'training'
      FOR UPDATE
    `, [slotId, userId]);
    
    if (slot.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_SLOT',
        message: '训练槽位不存在或已完成'
      });
    }
    
    const slotData = slot.rows[0];
    const now = new Date();
    
    // 检查是否已到结束时间
    if (now < new Date(slotData.ends_at)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'TRAINING_IN_PROGRESS',
        message: '训练尚未完成',
        remainingMinutes: Math.ceil((new Date(slotData.ends_at) - now) / 60000)
      });
    }
    
    // 计算奖励
    const rewards = TrainingCampService.calculateRewards(slotData);
    
    // 发放奖励
    await TrainingCampService.grantRewards(client, userId, slotData.pokemon_instance_id, rewards);
    
    // 更新槽位状态
    await client.query(`
      UPDATE training_slots 
      SET status = 'completed', completion_rewards = $1, updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(rewards), slotId]);
    
    // 记录训练历史
    await client.query(`
      INSERT INTO training_history 
        (user_id, pokemon_instance_id, course_id, started_at, completed_at, 
         actual_duration_minutes, rewards, acceleration_items_used)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      userId, slotData.pokemon_instance_id, slotData.course_id,
      slotData.started_at, now, Math.ceil((now - new Date(slotData.started_at)) / 60000),
      JSON.stringify(rewards), slotData.acceleration_items
    ]);
    
    // 发送 Kafka 事件
    await sendKafkaEvent('training.completed', {
      userId,
      slotId,
      pokemonId: slotData.pokemon_instance_id,
      courseId: slotData.course_id,
      rewards,
      duration: slotData.duration_minutes
    });
    
    await client.query('COMMIT');
    
    // 记录指标
    metrics.trainingCompleteTotal?.inc({ camp_type: slotData.type });
    metrics.trainingExpGranted?.inc({ amount: rewards.experience || 0 });
    
    logger.info('训练完成', { userId, slotId, rewards });
    
    res.json({
      success: true,
      data: {
        rewards,
        message: '训练完成，奖励已发放'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('完成训练失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/training-camp/accelerate
 * 加速训练
 */
router.post('/accelerate', authenticate, async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { slotId, itemId, amount } = req.body;
    const userId = req.user.id;
    
    // 获取训练槽位
    const slot = await client.query(`
      SELECT ts.*, tc.duration_minutes
      FROM training_slots ts
      JOIN training_courses tc ON ts.course_id = tc.id
      WHERE ts.id = $1 AND ts.user_id = $2 AND ts.status = 'training'
      FOR UPDATE
    `, [slotId, userId]);
    
    if (slot.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_SLOT',
        message: '训练槽位不存在或已完成'
      });
    }
    
    const slotData = slot.rows[0];
    
    // 验证加速道具
    const accelerationMinutes = await TrainingCampService.useAccelerationItem(
      client, userId, itemId, amount
    );
    
    // 更新结束时间
    const newEndTime = new Date(slotData.ends_at.getTime() - accelerationMinutes * 60000);
    const minEndTime = new Date();
    
    const finalEndTime = newEndTime < minEndTime ? minEndTime : newEndTime;
    
    await client.query(`
      UPDATE training_slots 
      SET ends_at = $1, 
          acceleration_items = array_append(acceleration_items, $2),
          updated_at = NOW()
      WHERE id = $3
    `, [finalEndTime, JSON.stringify({ itemId, amount, accelerationMinutes }), slotId]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: {
        newEndTime: finalEndTime.toISOString(),
        acceleratedMinutes: accelerationMinutes,
        message: '加速成功'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('加速训练失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/pokemon/training-camp/cancel
 * 取消训练
 */
router.post('/cancel', authenticate, async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { slotId } = req.body;
    const userId = req.user.id;
    
    // 获取训练槽位
    const slot = await client.query(`
      SELECT * FROM training_slots
      WHERE id = $1 AND user_id = $2 AND status = 'training'
      FOR UPDATE
    `, [slotId, userId]);
    
    if (slot.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'INVALID_SLOT',
        message: '训练槽位不存在或已完成'
      });
    }
    
    // 更新状态为已取消
    await client.query(`
      UPDATE training_slots 
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
    `, [slotId]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: {
        message: '训练已取消（已消耗资源不退还）'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('取消训练失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/pokemon/training-camp/history
 * 获取训练历史
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, campId } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT th.*, 
        tc.name as course_name,
        ps.name as pokemon_name,
        pi.nickname as pokemon_nickname
      FROM training_history th
      JOIN training_courses tc ON th.course_id = tc.id
      JOIN pokemon_instances pi ON th.pokemon_instance_id = pi.id
      JOIN pokemon_species ps ON pi.species_id = ps.id
      WHERE th.user_id = $1
    `;
    const params = [userId];
    
    if (campId) {
      query += ' AND tc.camp_id = $2';
      params.push(campId);
    }
    
    query += ' ORDER BY th.completed_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const history = await db.query(query, params);
    
    const countQuery = `
      SELECT COUNT(*) as total FROM training_history th
      JOIN training_courses tc ON th.course_id = tc.id
      WHERE th.user_id = $1 ${campId ? 'AND tc.camp_id = $2' : ''}
    `;
    const countParams = campId ? [userId, campId] : [userId];
    const count = await db.query(countQuery, countParams);
    
    res.json({
      success: true,
      data: {
        history: history.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(count.rows[0].total)
        }
      }
    });
  } catch (error) {
    logger.error('获取训练历史失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/pokemon/training-camp/upgrade
 * 升级训练营
 */
router.post('/upgrade', authenticate, async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { campId } = req.body;
    const userId = req.user.id;
    
    // 获取当前训练营等级
    const camp = await client.query(`
      SELECT utc.*, tc.max_level, tc.capacity_per_level
      FROM user_training_camps utc
      JOIN training_camps tc ON utc.camp_id = tc.id
      WHERE utc.user_id = $1 AND utc.camp_id = $2
      FOR UPDATE
    `, [userId, campId]);
    
    if (camp.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'CAMP_NOT_FOUND',
        message: '训练营未解锁'
      });
    }
    
    const campData = camp.rows[0];
    
    if (campData.level >= campData.max_level) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'MAX_LEVEL_REACHED',
        message: '已达最高等级'
      });
    }
    
    // 计算升级消耗
    const upgradeCost = TrainingCampService.calculateUpgradeCost(campData);
    
    // 扣除升级材料
    await TrainingCampService.deductUpgradeMaterials(client, userId, upgradeCost);
    
    // 升级训练营
    const newLevel = campData.level + 1;
    const newCapacity = campData.capacity + campData.capacity_per_level;
    
    await client.query(`
      UPDATE user_training_camps 
      SET level = $1, capacity = $2, updated_at = NOW()
      WHERE user_id = $3 AND camp_id = $4
    `, [newLevel, newCapacity, userId, campId]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: {
        newLevel,
        newCapacity,
        message: '训练营升级成功'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('升级训练营失败', { error: error.message, userId: req.user?.id });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  } finally {
    client.release();
  }
});

module.exports = router;
```

### 3. 训练服务实现

#### pokemon-service/services/TrainingCampService.js

```javascript
/**
 * REQ-00370: 精灵训练营服务
 */

const db = require('../../../shared/db');
const logger = require('../../../shared/logger');

class TrainingCampService {
  /**
   * 扣除训练资源
   */
  static async deductResources(client, userId, course) {
    const costType = course.cost_type;
    const costAmount = course.cost_amount;
    
    if (costType === 'gold') {
      await client.query(`
        UPDATE users SET gold = gold - $1, updated_at = NOW()
        WHERE id = $2 AND gold >= $1
      `, [costAmount, userId]);
      
      const result = await client.query('SELECT 1 FROM users WHERE id = $1 AND gold < 0', [userId]);
      if (result.rows.length > 0) {
        throw new Error('金币不足');
      }
    } else if (costType === 'stardust') {
      await client.query(`
        UPDATE users SET stardust = stardust - $1, updated_at = NOW()
        WHERE id = $2 AND stardust >= $1
      `, [costAmount, userId]);
      
      const result = await client.query('SELECT 1 FROM users WHERE id = $1 AND stardust < 0', [userId]);
      if (result.rows.length > 0) {
        throw new Error('星尘不足');
      }
    }
  }
  
  /**
   * 计算训练奖励
   */
  static calculateRewards(slotData) {
    const rewards = {
      experience: 0,
      friendship: 0,
      skillLearned: null
    };
    
    // 基础奖励
    rewards.experience = slotData.exp_reward || 0;
    rewards.friendship = slotData.friendship_reward || 0;
    
    // 根据训练时长计算额外奖励
    const durationHours = slotData.duration_minutes / 60;
    const bonusMultiplier = 1 + Math.floor(durationHours / 2) * 0.1;
    
    rewards.experience = Math.floor(rewards.experience * bonusMultiplier);
    rewards.friendship = Math.floor(rewards.friendship * bonusMultiplier);
    
    // 技能学习判定
    if (slotData.skill_id && Math.random() < 0.5 + durationHours * 0.05) {
      rewards.skillLearned = slotData.skill_id;
    }
    
    return rewards;
  }
  
  /**
   * 发放训练奖励
   */
  static async grantRewards(client, userId, pokemonId, rewards) {
    // 增加精灵经验
    if (rewards.experience > 0) {
      await client.query(`
        UPDATE pokemon_instances 
        SET experience = COALESCE(experience, 0) + $1,
            updated_at = NOW()
        WHERE id = $2
      `, [rewards.experience, pokemonId]);
    }
    
    // 增加亲密度
    if (rewards.friendship > 0) {
      await client.query(`
        UPDATE pokemon_instances 
        SET friendship = LEAST(255, COALESCE(friendship, 0) + $1),
            updated_at = NOW()
        WHERE id = $2
      `, [rewards.friendship, pokemonId]);
    }
    
    // 学习技能
    if (rewards.skillLearned) {
      const existingSkills = await client.query(`
        SELECT skills FROM pokemon_instances WHERE id = $1
      `, [pokemonId]);
      
      const skills = existingSkills.rows[0]?.skills || [];
      if (skills.length < 4) {
        await client.query(`
          UPDATE pokemon_instances 
          SET skills = array_append(skills, $1),
              updated_at = NOW()
          WHERE id = $2
        `, [rewards.skillLearned, pokemonId]);
      }
    }
  }
  
  /**
   * 使用加速道具
   */
  static async useAccelerationItem(client, userId, itemId, amount) {
    // 验证道具数量
    const item = await client.query(`
      SELECT quantity, metadata FROM inventory 
      WHERE user_id = $1 AND item_id = $2
      FOR UPDATE
    `, [userId, itemId]);
    
    if (item.rows.length === 0 || item.rows[0].quantity < amount) {
      throw new Error('道具数量不足');
    }
    
    // 扣除道具
    await client.query(`
      UPDATE inventory 
      SET quantity = quantity - $1, updated_at = NOW()
      WHERE user_id = $2 AND item_id = $3
    `, [amount, userId, itemId]);
    
    // 返回加速时间（分钟）
    const accelerationPerItem = item.rows[0].metadata?.acceleration_minutes || 30;
    return accelerationPerItem * amount;
  }
  
  /**
   * 计算升级消耗
   */
  static calculateUpgradeCost(campData) {
    const baseGold = 1000;
    const baseStardust = 500;
    
    return {
      gold: baseGold * Math.pow(2, campData.level - 1),
      stardust: baseStardust * Math.pow(1.5, campData.level - 1)
    };
  }
  
  /**
   * 扣除升级材料
   */
  static async deductUpgradeMaterials(client, userId, cost) {
    // 扣除金币
    await client.query(`
      UPDATE users SET gold = gold - $1, updated_at = NOW()
      WHERE id = $2 AND gold >= $1
    `, [cost.gold, userId]);
    
    // 扣除星尘
    await client.query(`
      UPDATE users SET stardust = stardust - $1, updated_at = NOW()
      WHERE id = $2 AND stardust >= $1
    `, [cost.stardust, userId]);
    
    // 验证
    const user = await client.query('SELECT gold, stardust FROM users WHERE id = $1', [userId]);
    if (user.rows[0].gold < 0 || user.rows[0].stardust < 0) {
      throw new Error('资源不足');
    }
  }
}

module.exports = TrainingCampService;
```

### 4. 训练队列管理器

#### pokemon-service/services/TrainingQueueManager.js

```javascript
/**
 * REQ-00370: 训练队列管理器
 * 处理训练完成检测和通知
 */

const db = require('../../../shared/db');
const logger = require('../../../shared/logger');
const { sendKafkaEvent } = require('../../../shared/kafkaProducer');
const NotificationService = require('./NotificationService');

class TrainingQueueManager {
  /**
   * 检查并处理已完成的训练
   */
  static async processCompletedTrainings() {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      // 查找已过期但未标记完成的训练
      const expiredSlots = await client.query(`
        SELECT ts.*, u.push_token, u.locale
        FROM training_slots ts
        JOIN users u ON ts.user_id = u.id
        WHERE ts.status = 'training' AND ts.ends_at <= NOW()
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `);
      
      for (const slot of expiredSlots.rows) {
        try {
          // 发送完成通知
          await NotificationService.sendTrainingCompleteNotification(
            slot.user_id,
            slot.push_token,
            slot.locale,
            {
              slotId: slot.id,
              pokemonId: slot.pokemon_instance_id,
              endsAt: slot.ends_at
            }
          );
          
          logger.info('训练完成通知已发送', {
            userId: slot.user_id,
            slotId: slot.id
          });
        } catch (notifyError) {
          logger.error('发送训练完成通知失败', {
            error: notifyError.message,
            slotId: slot.id
          });
        }
      }
      
      await client.query('COMMIT');
      
      return expiredSlots.rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('处理完成训练失败', { error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * 定时任务：检查训练状态
   */
  static startTrainingChecker() {
    // 每5分钟检查一次
    setInterval(async () => {
      try {
        const processed = await this.processCompletedTrainings();
        if (processed > 0) {
          logger.info('训练状态检查完成', { processedCount: processed });
        }
      } catch (error) {
        logger.error('训练状态检查失败', { error: error.message });
      }
    }, 5 * 60 * 1000);
  }
}

module.exports = TrainingQueueManager;
```

### 5. 前端组件实现

#### game-client/src/components/TrainingCampView.js

```javascript
/**
 * REQ-00370: 精灵训练营界面组件
 */

import React, { useState, useEffect } from 'react';
import { TrainingCampService } from '../services/TrainingCampService';
import { PokemonIcon } from './PokemonIcon';
import { ProgressBar } from './ProgressBar';
import { useTranslation } from '../hooks/useTranslation';

export function TrainingCampView({ campId, onClose }) {
  const { t } = useTranslation();
  const [camps, setCamps] = useState([]);
  const [slots, setSlots] = useState([]);
  const [courses, setCourses] = useState([]);
  const [selectedCamp, setSelectedCamp] = useState(null);
  const [selectedPokemon, setSelectedPokemon] = useState(null);
  const [loading, setLoading] = useState(true);
  const [startingTraining, setStartingTraining] = useState(false);
  
  useEffect(() => {
    loadData();
    
    // 定时刷新训练进度
    const interval = setInterval(() => {
      refreshSlots();
    }, 30000); // 每30秒刷新
    
    return () => clearInterval(interval);
  }, [campId]);
  
  const loadData = async () => {
    try {
      setLoading(true);
      const [campsData, slotsData] = await Promise.all([
        TrainingCampService.getCamps(),
        TrainingCampService.getSlots(campId)
      ]);
      
      setCamps(campsData);
      setSlots(slotsData);
      
      if (campId) {
        const camp = campsData.find(c => c.id === campId);
        setSelectedCamp(camp);
        
        const coursesData = await TrainingCampService.getCourses(campId);
        setCourses(coursesData);
      }
    } catch (error) {
      console.error('加载训练营数据失败:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const refreshSlots = async () => {
    try {
      const slotsData = await TrainingCampService.getSlots(selectedCamp?.id);
      setSlots(slotsData);
    } catch (error) {
      console.error('刷新训练槽位失败:', error);
    }
  };
  
  const handleCampSelect = async (camp) => {
    setSelectedCamp(camp);
    setLoading(true);
    
    try {
      const coursesData = await TrainingCampService.getCourses(camp.id);
      const slotsData = await TrainingCampService.getSlots(camp.id);
      setCourses(coursesData);
      setSlots(slotsData);
    } catch (error) {
      console.error('加载训练营课程失败:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const handleStartTraining = async (course) => {
    if (!selectedPokemon) {
      alert(t('training.select_pokemon_first'));
      return;
    }
    
    try {
      setStartingTraining(true);
      await TrainingCampService.startTraining({
        campId: selectedCamp.id,
        pokemonId: selectedPokemon.id,
        courseId: course.id
      });
      
      alert(t('training.started_successfully'));
      await refreshSlots();
      setSelectedPokemon(null);
    } catch (error) {
      alert(t('training.start_failed') + ': ' + error.message);
    } finally {
      setStartingTraining(false);
    }
  };
  
  const handleCompleteTraining = async (slotId) => {
    try {
      const result = await TrainingCampService.completeTraining(slotId);
      alert(t('training.completed') + '\n' + formatRewards(result.rewards));
      await refreshSlots();
    } catch (error) {
      alert(t('training.complete_failed') + ': ' + error.message);
    }
  };
  
  const handleAccelerate = async (slotId, itemId) => {
    try {
      await TrainingCampService.accelerateTraining(slotId, itemId, 1);
      await refreshSlots();
    } catch (error) {
      alert(t('training.accelerate_failed') + ': ' + error.message);
    }
  };
  
  const formatRewards = (rewards) => {
    const lines = [];
    if (rewards.experience > 0) {
      lines.push(t('training.reward_exp', { amount: rewards.experience }));
    }
    if (rewards.friendship > 0) {
      lines.push(t('training.reward_friendship', { amount: rewards.friendship }));
    }
    if (rewards.skillLearned) {
      lines.push(t('training.reward_skill'));
    }
    return lines.join('\n');
  };
  
  const formatRemainingTime = (minutes) => {
    if (minutes <= 0) return t('training.completed');
    const hours = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    return `${hours}:${mins.toString().padStart(2, '0')}`;
  };
  
  if (loading) {
    return (
      <div className="training-camp-view loading">
        <div className="spinner" />
        <p>{t('common.loading')}</p>
      </div>
    );
  }
  
  return (
    <div className="training-camp-view">
      <div className="camp-header">
        <h2>{t('training.title')}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      {/* 训练营选择 */}
      <div className="camp-tabs">
        {camps.map(camp => (
          <button
            key={camp.id}
            className={`camp-tab ${selectedCamp?.id === camp.id ? 'active' : ''}`}
            onClick={() => handleCampSelect(camp)}
          >
            <span className="camp-icon">{getCampIcon(camp.type)}</span>
            <span className="camp-name">{t(`training.camp_${camp.type}`)}</span>
            <span className="camp-level">Lv.{camp.user_level}</span>
          </button>
        ))}
      </div>
      
      {selectedCamp && (
        <>
          {/* 当前训练槽位 */}
          <div className="training-slots">
            <div className="slots-header">
              <span>{t('training.current_slots')}</span>
              <span>{slots.filter(s => s.status === 'training').length}/{selectedCamp.user_capacity}</span>
            </div>
            
            <div className="slots-grid">
              {Array.from({ length: selectedCamp.user_capacity }).map((_, index) => {
                const slot = slots.find(s => s.slot_index === index + 1);
                
                return (
                  <div key={index} className={`slot ${slot ? 'occupied' : 'empty'}`}>
                    {slot ? (
                      <div className="slot-content">
                        <PokemonIcon
                          pokedexNumber={slot.pokedex_number}
                          nickname={slot.pokemon_nickname}
                          level={slot.pokemon_level}
                        />
                        
                        <div className="slot-info">
                          <span className="course-name">{slot.course_name}</span>
                          {slot.status === 'training' ? (
                            <>
                              <ProgressBar
                                value={slot.progress_percentage}
                                max={100}
                              />
                              <span className="remaining-time">
                                {formatRemainingTime(slot.remaining_minutes)}
                              </span>
                            </>
                          ) : (
                            <span className="completed-badge">
                              {t('training.ready_to_collect')}
                            </span>
                          )}
                        </div>
                        
                        <div className="slot-actions">
                          {slot.status === 'completed' ? (
                            <button
                              className="complete-btn"
                              onClick={() => handleCompleteTraining(slot.id)}
                            >
                              {t('training.collect')}
                            </button>
                          ) : (
                            <button
                              className="accelerate-btn"
                              onClick={() => handleAccelerate(slot.id, 'speed_item')}
                            >
                              {t('training.accelerate')}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="empty-slot">
                        <span className="plus-icon">+</span>
                        <span>{t('training.empty_slot')}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          
          {/* 课程选择 */}
          <div className="courses-section">
            <h3>{t('training.available_courses')}</h3>
            <div className="courses-list">
              {courses.map(course => (
                <div key={course.id} className="course-card">
                  <div className="course-info">
                    <span className="course-name">{course.name}</span>
                    <span className="course-duration">
                      {t('training.duration', { minutes: course.duration_minutes })}
                    </span>
                  </div>
                  
                  <div className="course-rewards">
                    {course.exp_reward > 0 && (
                      <span className="reward">
                        {t('training.reward_exp', { amount: course.exp_reward })}
                      </span>
                    )}
                    {course.friendship_reward > 0 && (
                      <span className="reward">
                        {t('training.reward_friendship', { amount: course.friendship_reward })}
                      </span>
                    )}
                  </div>
                  
                  <div className="course-cost">
                    {course.cost_type === 'gold' && (
                      <span>{course.gold_cost} {t('currency.gold')}</span>
                    )}
                    {course.cost_type === 'stardust' && (
                      <span>{course.stardust_cost} {t('currency.stardust')}</span>
                    )}
                  </div>
                  
                  <button
                    className="start-btn"
                    onClick={() => handleStartTraining(course)}
                    disabled={startingTraining || slots.filter(s => s.status === 'training').length >= selectedCamp.user_capacity}
                  >
                    {t('training.start')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function getCampIcon(type) {
  const icons = {
    experience: '📊',
    skill: '⚡',
    friendship: '❤️'
  };
  return icons[type] || '🏫';
}
```

### 6. 定时任务处理

#### backend/jobs/trainingCompletionChecker.js

```javascript
/**
 * REQ-00370: 训练完成检查定时任务
 * 每分钟执行一次，检查并通知完成的训练
 */

const { CronJob } = require('cron');
const TrainingQueueManager = require('../services/pokemon-service/services/TrainingQueueManager');
const logger = require('../shared/logger');

const trainingCompletionChecker = new CronJob(
  '* * * * *', // 每分钟执行
  async () => {
    try {
      const processed = await TrainingQueueManager.processCompletedTrainings();
      if (processed > 0) {
        logger.info('训练完成检查执行完成', { processedCount: processed });
      }
    } catch (error) {
      logger.error('训练完成检查任务失败', { error: error.message });
    }
  },
  null,
  false,
  'UTC'
);

module.exports = trainingCompletionChecker;
```

## 验收标准

- [ ] 训练营系统支持三种类型（经验/技能/亲密度）
- [ ] 每个训练营有独立的等级和槽位容量
- [ ] 训练课程可配置不同时长和奖励
- [ ] 训练开始时正确扣除资源
- [ ] 训练进度实时更新，精确到分钟
- [ ] 训练完成后可正确领取奖励
- [ ] 支持使用加速道具缩短训练时间
- [ ] 取消训练功能正常（资源不退还）
- [ ] 训练历史记录完整保存
- [ ] 推送通知在训练完成时及时发送
- [ ] 前端界面流畅，支持多语言
- [ ] 单元测试覆盖核心逻辑

## 影响范围

- `backend/services/pokemon-service/` - 新增训练相关路由和服务
- `backend/services/user-service/` - 资源扣除和通知
- `backend/services/reward-service/` - 奖励发放
- `backend/shared/` - 训练相关工具类
- `backend/jobs/` - 定时任务
- `frontend/game-client/src/components/` - 前端组件
- `database/migrations/` - 数据库迁移脚本
- `docs/api-spec/` - API 文档更新

## 参考

- REQ-00253 精灵远征探险系统（异步外出探险）
- REQ-00156 精灵恢复站系统（原地恢复体力）
- REQ-00046 精灵培育系统与遗传机制
