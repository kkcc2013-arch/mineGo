# REQ-00057: 游戏活动系统与限时活动管理

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00057 |
| 标题 | 游戏活动系统与限时活动管理 |
| 类别 | 功能增强 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | reward-service、location-service、pokemon-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 18:00 |

## 需求描述

实现完整的游戏活动系统，支持运营团队灵活创建和管理各类限时活动，提升用户活跃度和留存率。系统支持多种活动类型、自动触发、实时奖励发放和活动数据分析。

### 核心功能

1. **活动类型支持**
   - 精灵刷新率提升活动（特定精灵出现率 × N 倍）
   - 闪光精灵活动（闪光概率提升）
   - 双倍经验/星尘活动
   - 限时捕捉挑战（捕捉目标精灵获得奖励）
   - Boss 团队战活动（Raid Boss）
   - 节日活动（春节、圣诞节等）
   - 精灵迁徙活动（地区限定精灵全球出现）
   - 捕捉竞赛活动（排行榜活动）

2. **活动创建与管理**
   - 可视化活动创建工具
   - 活动时间调度（开始/结束时间、重复周期）
   - 活动范围控制（全球/地区/特定地点）
   - 活动奖励配置（道具、精灵、虚拟货币）
   - 活动预览与测试功能
   - 活动克隆与模板系统

3. **活动触发与执行**
   - 自动触发（时间到达）
   - 手动触发（运营后台）
   - 条件触发（用户行为、地理位置）
   - 活动状态管理（草稿、预发布、进行中、已结束）

4. **实时活动通知**
   - 游戏内推送通知
   - 活动开始/结束提醒
   - 倒计时显示
   - 活动进度追踪

5. **活动数据统计**
   - 参与用户数
   - 活动完成率
   - 奖励发放统计
   - 用户行为分析
   - 活动ROI分析

6. **活动商店系统**
   - 限时活动商店
   - 活动积分兑换
   - 活动专属道具

## 技术方案

### 1. 数据库设计

```sql
-- 活动主表
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    event_key VARCHAR(100) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    event_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'active', 'paused', 'completed', 'cancelled')),
    
    -- 时间配置
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    timezone VARCHAR(50) DEFAULT 'UTC',
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_rule JSONB, -- Cron 表达式或重复规则
    
    -- 范围配置
    scope_type VARCHAR(20) DEFAULT 'global' CHECK (scope_type IN ('global', 'region', 'location', 'user_segment')),
    scope_config JSONB DEFAULT '{}', -- 地区ID列表、坐标范围等
    
    -- 活动配置
    event_config JSONB NOT NULL DEFAULT '{}', -- 根据活动类型的具体配置
    rewards JSONB DEFAULT '[]', -- 奖励配置
    
    -- 显示配置
    banner_image VARCHAR(500),
    icon VARCHAR(255),
    display_priority INTEGER DEFAULT 0,
    show_countdown BOOLEAN DEFAULT TRUE,
    show_progress BOOLEAN DEFAULT TRUE,
    
    -- 统计数据
    participant_count INTEGER DEFAULT 0,
    completion_count INTEGER DEFAULT 0,
    
    -- 元数据
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP,
    
    CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- 活动类型配置表
CREATE TABLE event_types (
    id SERIAL PRIMARY KEY,
    type_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    config_schema JSONB NOT NULL, -- JSON Schema 验证
    default_config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 活动参与记录表
CREATE TABLE event_participations (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
    progress JSONB DEFAULT '{}', -- 活动进度数据
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    completed_at TIMESTAMP,
    UNIQUE(event_id, user_id)
);

-- 活动奖励发放记录
CREATE TABLE event_reward_claims (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reward_type VARCHAR(50) NOT NULL,
    reward_data JSONB NOT NULL,
    claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- 奖励内容快照
    items JSONB,
    pokemon_id INTEGER,
    currency_amount INTEGER,
    
    UNIQUE(event_id, user_id, reward_type)
);

-- 活动精灵刷新配置表
CREATE TABLE event_spawns (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    pokemon_species_id INTEGER NOT NULL,
    spawn_rate_multiplier DECIMAL(10,2) DEFAULT 1.0,
    shiny_rate_multiplier DECIMAL(10,2) DEFAULT 1.0,
    min_iv INTEGER DEFAULT 0,
    max_iv INTEGER DEFAULT 100,
    level_range JSONB DEFAULT '{"min": 1, "max": 35}',
    location_restrictions JSONB, -- 特定地点限制
    time_restrictions JSONB, -- 时间段限制
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 活动任务表
CREATE TABLE event_tasks (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    task_key VARCHAR(100) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'visit', etc.
    requirement JSONB NOT NULL, -- 任务要求
    rewards JSONB NOT NULL, -- 任务奖励
    display_order INTEGER DEFAULT 0,
    is_required BOOLEAN DEFAULT TRUE,
    is_repeatable BOOLEAN DEFAULT FALSE,
    max_completions INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, task_key)
);

-- 用户活动任务完成记录
CREATE TABLE user_event_tasks (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES event_tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    progress JSONB DEFAULT '{}',
    completed_count INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, task_id, user_id)
);

-- 活动商店表
CREATE TABLE event_shops (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    item_key VARCHAR(100) NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    item_type VARCHAR(50) NOT NULL,
    item_data JSONB NOT NULL,
    cost_type VARCHAR(20) NOT NULL, -- 'coins', 'event_points', 'stardust'
    cost_amount INTEGER NOT NULL,
    purchase_limit INTEGER, -- 每人限购数量
    daily_limit INTEGER, -- 每日限购
    total_stock INTEGER, -- 总库存
    sold_count INTEGER DEFAULT 0,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    available_from TIMESTAMP,
    available_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, item_key)
);

-- 活动商店购买记录
CREATE TABLE event_shop_purchases (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    shop_item_id INTEGER NOT NULL REFERENCES event_shops(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purchase_count INTEGER DEFAULT 1,
    total_cost INTEGER NOT NULL,
    purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 活动统计缓存
CREATE TABLE event_stats_cache (
    event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    participant_count INTEGER DEFAULT 0,
    completion_count INTEGER DEFAULT 0,
    total_rewards_distributed INTEGER DEFAULT 0,
    unique_users INTEGER DEFAULT 0,
    avg_completion_time_seconds INTEGER,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_time ON events(start_time, end_time);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_event_participations_user ON event_participations(user_id);
CREATE INDEX idx_event_participations_event ON event_participations(event_id);
CREATE INDEX idx_event_spawns_event ON event_spawns(event_id);
CREATE INDEX idx_event_tasks_event ON event_tasks(event_id);
CREATE INDEX idx_user_event_tasks_user ON user_event_tasks(user_id);
CREATE INDEX idx_event_shops_event ON event_shops(event_id);
CREATE INDEX idx_event_shop_purchases_user ON event_shop_purchases(user_id);
CREATE INDEX idx_event_reward_claims_user ON event_reward_claims(user_id);
```

### 2. 后端服务实现

#### reward-service/src/eventService.js

```javascript
const { db } = require('../shared/db');
const { EventBus, EVENTS } = require('../shared/EventBus');
const cron = require('node-cron');

class EventService {
  constructor() {
    this.activeEvents = new Map();
    this.eventSchedulers = new Map();
  }

  /**
   * 初始化活动系统
   */
  async initialize() {
    // 加载所有活跃和计划中的活动
    await this.loadScheduledEvents();
    
    // 启动定时任务检查器
    this.startEventScheduler();
    
    // 启动统计聚合定时任务
    this.startStatsAggregator();
    
    console.log('✅ Event system initialized');
  }

  /**
   * 创建活动
   */
  async createEvent(eventData) {
    const {
      eventKey,
      title,
      description,
      eventType,
      startTime,
      endTime,
      timezone,
      scopeType,
      scopeConfig,
      eventConfig,
      rewards,
      bannerImage,
      icon,
      isRecurring,
      recurrenceRule
    } = eventData;

    // 验证活动类型配置
    await this.validateEventConfig(eventType, eventConfig);

    const result = await db.query(`
      INSERT INTO events 
        (event_key, title, description, event_type, start_time, end_time, timezone,
         scope_type, scope_config, event_config, rewards, banner_image, icon,
         is_recurring, recurrence_rule, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `, [
      eventKey, title, description, eventType, startTime, endTime, timezone,
      scopeType, JSON.stringify(scopeConfig || {}), JSON.stringify(eventConfig || {}),
      JSON.stringify(rewards || []), bannerImage, icon,
      isRecurring || false, JSON.stringify(recurrenceRule || {}),
      eventData.createdBy
    ]);

    const event = result.rows[0];

    // 如果是精灵刷新活动，创建刷新配置
    if (eventType === 'spawn_boost' && eventConfig.spawns) {
      await this.createEventSpawns(event.id, eventConfig.spawns);
    }

    // 如果有任务，创建活动任务
    if (eventConfig.tasks) {
      await this.createEventTasks(event.id, eventConfig.tasks);
    }

    // 如果有商店，创建活动商店
    if (eventConfig.shop) {
      await this.createEventShop(event.id, eventConfig.shop);
    }

    // 如果活动即将开始（30分钟内），立即调度
    const timeUntilStart = new Date(startTime) - new Date();
    if (timeUntilStart < 30 * 60 * 1000) {
      await this.scheduleEvent(event.id);
    }

    // 发布活动创建事件
    await EventBus.publish(EVENTS.EVENT_CREATED, {
      eventId: event.id,
      eventKey: event.event_key,
      eventType: event.event_type,
      startTime: event.start_time,
      timestamp: new Date()
    });

    return event;
  }

  /**
   * 验证活动配置
   */
  async validateEventConfig(eventType, eventConfig) {
    const typeConfig = await db.query(
      'SELECT * FROM event_types WHERE type_key = $1',
      [eventType]
    );

    if (typeConfig.rows.length === 0) {
      throw new Error(`Invalid event type: ${eventType}`);
    }

    // 这里可以使用 JSON Schema 验证 eventConfig
    // 简化示例，实际应用中应该使用 ajv 或类似库
    return true;
  }

  /**
   * 创建活动精灵刷新配置
   */
  async createEventSpawns(eventId, spawns) {
    for (const spawn of spawns) {
      await db.query(`
        INSERT INTO event_spawns 
          (event_id, pokemon_species_id, spawn_rate_multiplier, shiny_rate_multiplier,
           min_iv, max_iv, level_range, location_restrictions, time_restrictions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        eventId,
        spawn.pokemonSpeciesId,
        spawn.spawnRateMultiplier || 1.0,
        spawn.shinyRateMultiplier || 1.0,
        spawn.minIv || 0,
        spawn.maxIv || 100,
        JSON.stringify(spawn.levelRange || { min: 1, max: 35 }),
        JSON.stringify(spawn.locationRestrictions || null),
        JSON.stringify(spawn.timeRestrictions || null)
      ]);
    }
  }

  /**
   * 创建活动任务
   */
  async createEventTasks(eventId, tasks) {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      await db.query(`
        INSERT INTO event_tasks
          (event_id, task_key, title, description, task_type, requirement, rewards,
           display_order, is_required, is_repeatable, max_completions)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        eventId,
        task.taskKey,
        task.title,
        task.description,
        task.taskType,
        JSON.stringify(task.requirement),
        JSON.stringify(task.rewards),
        task.displayOrder || i,
        task.isRequired !== false,
        task.isRepeatable || false,
        task.maxCompletions || 1
      ]);
    }
  }

  /**
   * 创建活动商店
   */
  async createEventShop(eventId, shopItems) {
    for (let i = 0; i < shopItems.length; i++) {
      const item = shopItems[i];
      await db.query(`
        INSERT INTO event_shops
          (event_id, item_key, item_name, item_type, item_data, cost_type, cost_amount,
           purchase_limit, daily_limit, total_stock, display_order, available_from, available_until)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        eventId,
        item.itemKey,
        item.itemName,
        item.itemType,
        JSON.stringify(item.itemData),
        item.costType,
        item.costAmount,
        item.purchaseLimit,
        item.dailyLimit,
        item.totalStock,
        item.displayOrder || i,
        item.availableFrom,
        item.availableUntil
      ]);
    }
  }

  /**
   * 加载计划中的活动
   */
  async loadScheduledEvents() {
    const result = await db.query(`
      SELECT * FROM events
      WHERE status IN ('scheduled', 'active')
        AND end_time > CURRENT_TIMESTAMP
      ORDER BY start_time
    `);

    for (const event of result.rows) {
      if (event.status === 'scheduled') {
        await this.scheduleEvent(event.id);
      } else if (event.status === 'active') {
        this.activeEvents.set(event.id, event);
      }
    }
  }

  /**
   * 调度活动
   */
  async scheduleEvent(eventId) {
    const event = await this.getEvent(eventId);
    
    if (!event) {
      throw new Error('Event not found');
    }

    const now = new Date();
    const startTime = new Date(event.start_time);
    const endTime = new Date(event.end_time);

    // 如果活动已经开始
    if (now >= startTime && now < endTime) {
      await this.activateEvent(eventId);
    }
    // 如果活动还未开始
    else if (now < startTime) {
      const timeUntilStart = startTime - now;
      const timeoutId = setTimeout(async () => {
        await this.activateEvent(eventId);
      }, timeUntilStart);

      this.eventSchedulers.set(eventId, { type: 'start', timeoutId });
      
      // 更新状态为 scheduled
      await db.query(
        'UPDATE events SET status = $1 WHERE id = $2',
        ['scheduled', eventId]
      );
    }

    // 调度活动结束
    if (now < endTime) {
      const timeUntilEnd = endTime - now;
      const endTimeoutId = setTimeout(async () => {
        await this.deactivateEvent(eventId);
      }, timeUntilEnd);

      if (this.eventSchedulers.has(eventId)) {
        this.eventSchedulers.get(eventId).endTimeoutId = endTimeoutId;
      } else {
        this.eventSchedulers.set(eventId, { type: 'end', timeoutId: endTimeoutId });
      }
    }
  }

  /**
   * 激活活动
   */
  async activateEvent(eventId) {
    const event = await this.getEvent(eventId);

    // 更新状态
    await db.query(
      'UPDATE events SET status = $1, published_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['active', eventId]
    );

    // 添加到活跃活动列表
    this.activeEvents.set(eventId, event);

    // 发布活动激活事件
    await EventBus.publish(EVENTS.EVENT_ACTIVATED, {
      eventId,
      eventKey: event.event_key,
      eventType: event.event_type,
      timestamp: new Date()
    });

    // 如果是精灵刷新活动，通知 location-service
    if (event.event_type === 'spawn_boost') {
      await this.notifySpawnBoost(event);
    }

    console.log(`🎉 Event activated: ${event.title}`);
  }

  /**
   * 停用活动
   */
  async deactivateEvent(eventId) {
    const event = await this.getEvent(eventId);

    // 更新状态
    await db.query(
      'UPDATE events SET status = $1 WHERE id = $2',
      ['completed', eventId]
    );

    // 从活跃列表移除
    this.activeEvents.delete(eventId);

    // 清理调度器
    if (this.eventSchedulers.has(eventId)) {
      const scheduler = this.eventSchedulers.get(eventId);
      if (scheduler.timeoutId) clearTimeout(scheduler.timeoutId);
      if (scheduler.endTimeoutId) clearTimeout(scheduler.endTimeoutId);
      this.eventSchedulers.delete(eventId);
    }

    // 发布活动结束事件
    await EventBus.publish(EVENTS.EVENT_DEACTIVATED, {
      eventId,
      eventKey: event.event_key,
      timestamp: new Date()
    });

    // 聚合最终统计数据
    await this.aggregateEventStats(eventId);

    console.log(`🏁 Event completed: ${event.title}`);
  }

  /**
   * 通知精灵刷新加成
   */
  async notifySpawnBoost(event) {
    // 获取活动的精灵刷新配置
    const spawns = await db.query(
      'SELECT * FROM event_spawns WHERE event_id = $1',
      [event.id]
    );

    // 发布事件到 Kafka，让 location-service 订阅
    await EventBus.publish(EVENTS.SPAWN_BOOST_ACTIVATED, {
      eventId: event.id,
      eventKey: event.event_key,
      spawns: spawns.rows,
      scopeType: event.scope_type,
      scopeConfig: event.scope_config,
      startTime: event.start_time,
      endTime: event.end_time
    });
  }

  /**
   * 用户参与活动
   */
  async joinEvent(eventId, userId) {
    const event = await this.getEvent(eventId);

    if (!event || event.status !== 'active') {
      throw new Error('Event not active');
    }

    // 检查是否已参与
    const existing = await db.query(
      'SELECT * FROM event_participations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // 创建参与记录
    const result = await db.query(`
      INSERT INTO event_participations (event_id, user_id)
      VALUES ($1, $2)
      RETURNING *
    `, [eventId, userId]);

    // 更新参与人数
    await db.query(
      'UPDATE events SET participant_count = participant_count + 1 WHERE id = $1',
      [eventId]
    );

    // 发布参与事件
    await EventBus.publish(EVENTS.EVENT_JOINED, {
      eventId,
      userId,
      timestamp: new Date()
    });

    return result.rows[0];
  }

  /**
   * 获取用户活跃活动列表
   */
  async getActiveEventsForUser(userId, scope = {}) {
    const result = await db.query(`
      SELECT DISTINCT e.*, 
        ep.joined_at,
        ep.status as participation_status,
        ep.progress as user_progress
      FROM events e
      LEFT JOIN event_participations ep ON e.id = ep.event_id AND ep.user_id = $1
      WHERE e.status = 'active'
        AND e.start_time <= CURRENT_TIMESTAMP
        AND e.end_time > CURRENT_TIMESTAMP
      ORDER BY e.display_priority DESC, e.start_time
    `, [userId]);

    return result.rows;
  }

  /**
   * 获取所有活跃活动
   */
  async getAllActiveEvents() {
    const result = await db.query(`
      SELECT * FROM events
      WHERE status = 'active'
        AND start_time <= CURRENT_TIMESTAMP
        AND end_time > CURRENT_TIMESTAMP
      ORDER BY display_priority DESC, start_time
    `);

    return result.rows;
  }

  /**
   * 获取活动详情
   */
  async getEvent(eventId) {
    const result = await db.query('SELECT * FROM events WHERE id = $1', [eventId]);
    return result.rows[0];
  }

  /**
   * 更新用户活动进度
   */
  async updateEventProgress(eventId, userId, progressUpdate) {
    await db.query(`
      INSERT INTO event_participations (event_id, user_id, progress)
      VALUES ($1, $2, $3)
      ON CONFLICT (event_id, user_id)
      DO UPDATE SET 
        progress = event_participations.progress || EXCLUDED.progress,
        last_updated = CURRENT_TIMESTAMP
    `, [eventId, userId, JSON.stringify(progressUpdate)]);
  }

  /**
   * 完成活动任务
   */
  async completeEventTask(eventId, taskId, userId) {
    const task = await db.query(
      'SELECT * FROM event_tasks WHERE id = $1 AND event_id = $2',
      [taskId, eventId]
    );

    if (task.rows.length === 0) {
      throw new Error('Task not found');
    }

    const taskData = task.rows[0];

    // 检查完成次数
    const completion = await db.query(`
      SELECT * FROM user_event_tasks
      WHERE event_id = $1 AND task_id = $2 AND user_id = $3
    `, [eventId, taskId, userId]);

    const completedCount = completion.rows.length > 0 ? completion.rows[0].completed_count : 0;

    if (!taskData.is_repeatable && completedCount >= taskData.max_completions) {
      throw new Error('Task already completed');
    }

    // 更新任务完成记录
    await db.query(`
      INSERT INTO user_event_tasks (event_id, task_id, user_id, completed_count)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (event_id, task_id, user_id)
      DO UPDATE SET 
        completed_count = user_event_tasks.completed_count + 1,
        last_updated = CURRENT_TIMESTAMP
    `, [eventId, taskId, userId]);

    // 发放任务奖励
    await this.grantTaskRewards(eventId, taskData, userId);

    return { success: true, taskId, userId };
  }

  /**
   * 发放任务奖励
   */
  async grantTaskRewards(eventId, task, userId) {
    const rewards = task.rewards;

    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'event_task',
      sourceId: task.id,
      eventId,
      rewards
    });
  }

  /**
   * 领取活动奖励
   */
  async claimEventRewards(eventId, userId) {
    const participation = await db.query(`
      SELECT * FROM event_participations
      WHERE event_id = $1 AND user_id = $2
    `, [eventId, userId]);

    if (participation.rows.length === 0) {
      throw new Error('User not participating in event');
    }

    const userParticipation = participation.rows[0];

    if (userParticipation.rewards_claimed) {
      throw new Error('Rewards already claimed');
    }

    const event = await this.getEvent(eventId);

    // 发放活动奖励
    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'event_completion',
      sourceId: eventId,
      eventId,
      rewards: event.rewards
    });

    // 更新领取状态
    await db.query(`
      UPDATE event_participations
      SET rewards_claimed = TRUE, rewards_claimed_at = CURRENT_TIMESTAMP
      WHERE event_id = $1 AND user_id = $2
    `, [eventId, userId]);

    // 更新完成人数
    await db.query(
      'UPDATE events SET completion_count = completion_count + 1 WHERE id = $1',
      [eventId]
    );

    return { success: true };
  }

  /**
   * 活动商店购买
   */
  async purchaseFromEventShop(eventId, shopItemId, userId, quantity = 1) {
    const event = await this.getEvent(eventId);

    if (!event || event.status !== 'active') {
      throw new Error('Event not active');
    }

    const shopItem = await db.query(
      'SELECT * FROM event_shops WHERE id = $1 AND event_id = $2 AND is_active = TRUE',
      [shopItemId, eventId]
    );

    if (shopItem.rows.length === 0) {
      throw new Error('Shop item not found or inactive');
    }

    const item = shopItem.rows[0];

    // 检查库存
    if (item.total_stock !== null && item.sold_count + quantity > item.total_stock) {
      throw new Error('Insufficient stock');
    }

    // 检查用户购买限制
    const userPurchases = await db.query(`
      SELECT SUM(purchase_count) as total_purchased
      FROM event_shop_purchases
      WHERE event_id = $1 AND shop_item_id = $2 AND user_id = $3
    `, [eventId, shopItemId, userId]);

    const totalPurchased = userPurchases.rows[0].total_purchased || 0;

    if (item.purchase_limit && totalPurchased + quantity > item.purchase_limit) {
      throw new Error('Purchase limit exceeded');
    }

    // 检查每日限制
    const todayPurchases = await db.query(`
      SELECT SUM(purchase_count) as today_purchased
      FROM event_shop_purchases
      WHERE event_id = $1 AND shop_item_id = $2 AND user_id = $3
        AND DATE(purchased_at) = CURRENT_DATE
    `, [eventId, shopItemId, userId]);

    const todayPurchased = todayPurchases.rows[0].today_purchased || 0;

    if (item.daily_limit && todayPurchased + quantity > item.daily_limit) {
      throw new Error('Daily purchase limit exceeded');
    }

    const totalCost = item.cost_amount * quantity;

    // 扣除货币（这里简化处理，实际应该调用 payment-service）
    await this.deductCurrency(userId, item.cost_type, totalCost);

    // 记录购买
    await db.query(`
      INSERT INTO event_shop_purchases
        (event_id, shop_item_id, user_id, purchase_count, total_cost)
      VALUES ($1, $2, $3, $4, $5)
    `, [eventId, shopItemId, userId, quantity, totalCost]);

    // 更新已售数量
    await db.query(
      'UPDATE event_shops SET sold_count = sold_count + $1 WHERE id = $2',
      [quantity, shopItemId]
    );

    // 发放购买的物品
    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'event_shop',
      sourceId: shopItemId,
      eventId,
      rewards: [{
        type: item.item_type,
        data: item.item_data,
        quantity
      }]
    });

    return {
      success: true,
      item: item.item_name,
      quantity,
      cost: totalCost
    };
  }

  /**
   * 扣除货币
   */
  async deductCurrency(userId, currencyType, amount) {
    // 这里应该调用 payment-service 的接口
    // 简化示例
    console.log(`Deducting ${amount} ${currencyType} from user ${userId}`);
    return true;
  }

  /**
   * 获取活动排行榜
   */
  async getEventLeaderboard(eventId, limit = 100, offset = 0) {
    const result = await db.query(`
      SELECT 
        ep.user_id,
        ep.progress,
        u.username,
        u.avatar,
        RANK() OVER (ORDER BY ep.progress->>'score' DESC NULLS LAST) as rank
      FROM event_participations ep
      JOIN users u ON ep.user_id = u.id
      WHERE ep.event_id = $1 AND ep.status = 'active'
      ORDER BY ep.progress->>'score' DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `, [eventId, limit, offset]);

    return result.rows;
  }

  /**
   * 启动活动调度器
   */
  startEventScheduler() {
    // 每分钟检查一次活动状态
    cron.schedule('* * * * *', async () => {
      try {
        await this.checkScheduledEvents();
      } catch (error) {
        console.error('Event scheduler error:', error);
      }
    });
  }

  /**
   * 检查计划中的活动
   */
  async checkScheduledEvents() {
    const now = new Date();

    // 检查需要启动的活动
    const toStart = await db.query(`
      SELECT id FROM events
      WHERE status = 'scheduled'
        AND start_time <= CURRENT_TIMESTAMP
        AND end_time > CURRENT_TIMESTAMP
    `);

    for (const event of toStart.rows) {
      try {
        await this.activateEvent(event.id);
      } catch (error) {
        console.error(`Failed to activate event ${event.id}:`, error);
      }
    }

    // 检查需要结束的活动
    const toEnd = await db.query(`
      SELECT id FROM events
      WHERE status = 'active'
        AND end_time <= CURRENT_TIMESTAMP
    `);

    for (const event of toEnd.rows) {
      try {
        await this.deactivateEvent(event.id);
      } catch (error) {
        console.error(`Failed to deactivate event ${event.id}:`, error);
      }
    }
  }

  /**
   * 启动统计聚合
   */
  startStatsAggregator() {
    // 每5分钟聚合一次统计数据
    cron.schedule('*/5 * * * *', async () => {
      for (const eventId of this.activeEvents.keys()) {
        try {
          await this.aggregateEventStats(eventId);
        } catch (error) {
          console.error(`Failed to aggregate stats for event ${eventId}:`, error);
        }
      }
    });
  }

  /**
   * 聚合活动统计
   */
  async aggregateEventStats(eventId) {
    const stats = await db.query(`
      SELECT 
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(CASE WHEN rewards_claimed THEN 1 END) as completion_count,
        COUNT(*) as participant_count
      FROM event_participations
      WHERE event_id = $1
    `, [eventId]);

    const rewardStats = await db.query(`
      SELECT COUNT(*) as total_rewards
      FROM event_reward_claims
      WHERE event_id = $1
    `, [eventId]);

    await db.query(`
      INSERT INTO event_stats_cache 
        (event_id, participant_count, completion_count, unique_users, 
         total_rewards_distributed, last_updated)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (event_id)
      DO UPDATE SET
        participant_count = EXCLUDED.participant_count,
        completion_count = EXCLUDED.completion_count,
        unique_users = EXCLUDED.unique_users,
        total_rewards_distributed = EXCLUDED.total_rewards_distributed,
        last_updated = CURRENT_TIMESTAMP
    `, [
      eventId,
      stats.rows[0].participant_count,
      stats.rows[0].completion_count,
      stats.rows[0].unique_users,
      rewardStats.rows[0].total_rewards
    ]);
  }

  /**
   * 搜索活动
   */
  async searchEvents(filters = {}) {
    let query = 'SELECT * FROM events WHERE 1=1';
    const values = [];
    let paramCount = 1;

    if (filters.status) {
      query += ` AND status = $${paramCount}`;
      values.push(filters.status);
      paramCount++;
    }

    if (filters.eventType) {
      query += ` AND event_type = $${paramCount}`;
      values.push(filters.eventType);
      paramCount++;
    }

    if (filters.startDate) {
      query += ` AND start_time >= $${paramCount}`;
      values.push(filters.startDate);
      paramCount++;
    }

    if (filters.endDate) {
      query += ` AND end_time <= $${paramCount}`;
      values.push(filters.endDate);
      paramCount++;
    }

    query += ' ORDER BY start_time DESC';

    const result = await db.query(query, values);
    return result.rows;
  }

  /**
   * 暂停活动
   */
  async pauseEvent(eventId) {
    await db.query(
      'UPDATE events SET status = $1 WHERE id = $2',
      ['paused', eventId]
    );

    this.activeEvents.delete(eventId);

    // 通知相关服务暂停活动效果
    await EventBus.publish(EVENTS.EVENT_PAUSED, { eventId });
  }

  /**
   * 恢复活动
   */
  async resumeEvent(eventId) {
    const event = await this.getEvent(eventId);

    if (new Date() < new Date(event.end_time)) {
      await db.query(
        'UPDATE events SET status = $1 WHERE id = $2',
        ['active', eventId]
      );

      this.activeEvents.set(eventId, event);

      await EventBus.publish(EVENTS.EVENT_RESUMED, { eventId });
    }
  }

  /**
   * 取消活动
   */
  async cancelEvent(eventId) {
    await db.query(
      'UPDATE events SET status = $1 WHERE id = $2',
      ['cancelled', eventId]
    );

    this.activeEvents.delete(eventId);

    // 清理调度器
    if (this.eventSchedulers.has(eventId)) {
      const scheduler = this.eventSchedulers.get(eventId);
      if (scheduler.timeoutId) clearTimeout(scheduler.timeoutId);
      if (scheduler.endTimeoutId) clearTimeout(scheduler.endTimeoutId);
      this.eventSchedulers.delete(eventId);
    }

    await EventBus.publish(EVENTS.EVENT_CANCELLED, { eventId });
  }
}

module.exports = new EventService();
