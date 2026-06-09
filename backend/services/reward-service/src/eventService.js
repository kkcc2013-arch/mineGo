/**
 * REQ-00057: 游戏活动系统核心服务
 * 支持多种活动类型、自动触发、实时奖励发放和活动数据分析
 */

const { db } = require('../../shared/db');
const { createLogger } = require('../../shared/logger');
const { publishEvent, EVENTS } = require('../../shared/EventBus');
const cron = require('node-cron');

const logger = createLogger('event-service');

class EventService {
  constructor() {
    this.activeEvents = new Map();
    this.eventSchedulers = new Map();
    this.initialized = false;
  }

  /**
   * 初始化活动系统
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // 加载所有活跃和计划中的活动
      await this.loadScheduledEvents();
      
      // 启动定时任务检查器
      this.startEventScheduler();
      
      // 启动统计聚合定时任务
      this.startStatsAggregator();
      
      this.initialized = true;
      logger.info('Event system initialized', {
        activeCount: this.activeEvents.size
      });
    } catch (error) {
      logger.error({ error }, 'Failed to initialize event system');
      throw error;
    }
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
      timezone = 'UTC',
      scopeType = 'global',
      scopeConfig = {},
      eventConfig = {},
      rewards = [],
      bannerImage,
      icon,
      isRecurring = false,
      recurrenceRule = {},
      displayPriority = 0,
      createdBy
    } = eventData;

    // 验证活动类型
    await this.validateEventConfig(eventType, eventConfig);

    const result = await db.query(`
      INSERT INTO events 
        (event_key, title, description, event_type, start_time, end_time, timezone,
         scope_type, scope_config, event_config, rewards, banner_image, icon,
         is_recurring, recurrence_rule, display_priority, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
    `, [
      eventKey, title, description, eventType, startTime, endTime, timezone,
      scopeType, JSON.stringify(scopeConfig), JSON.stringify(eventConfig),
      JSON.stringify(rewards), bannerImage, icon,
      isRecurring, JSON.stringify(recurrenceRule), displayPriority, createdBy
    ]);

    const event = result.rows[0];

    // 创建活动相关配置
    if (eventType === 'spawn_boost' && eventConfig.spawns) {
      await this.createEventSpawns(event.id, eventConfig.spawns);
    }

    if (eventConfig.tasks) {
      await this.createEventTasks(event.id, eventConfig.tasks);
    }

    if (eventConfig.shop) {
      await this.createEventShop(event.id, eventConfig.shop);
    }

    // 如果活动即将开始，立即调度
    const timeUntilStart = new Date(startTime) - new Date();
    if (timeUntilStart < 30 * 60 * 1000 && timeUntilStart > 0) {
      await this.scheduleEvent(event.id);
    }

    // 发布活动创建事件
    await publishEvent(EVENTS.EVENT_CREATED, {
      eventId: event.id,
      eventKey: event.event_key,
      eventType: event.event_type,
      startTime: event.start_time,
      timestamp: new Date()
    });

    logger.info({ eventId: event.id, eventKey }, 'Event created');
    return event;
  }

  /**
   * 验证活动配置
   */
  async validateEventConfig(eventType, eventConfig) {
    const typeConfig = await db.query(
      'SELECT * FROM event_types WHERE type_key = $1 AND is_active = TRUE',
      [eventType]
    );

    if (typeConfig.rows.length === 0) {
      throw new Error(`Invalid event type: ${eventType}`);
    }

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
      }, Math.min(timeUntilStart, 2147483647)); // Max setTimeout value

      this.eventSchedulers.set(eventId, { type: 'start', timeoutId });
      
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
      }, Math.min(timeUntilEnd, 2147483647));

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

    await db.query(
      'UPDATE events SET status = $1, published_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['active', eventId]
    );

    this.activeEvents.set(eventId, event);

    await publishEvent(EVENTS.EVENT_ACTIVATED, {
      eventId,
      eventKey: event.event_key,
      eventType: event.event_type,
      timestamp: new Date()
    });

    if (event.event_type === 'spawn_boost') {
      await this.notifySpawnBoost(event);
    }

    logger.info({ eventId, eventKey: event.event_key }, 'Event activated');
  }

  /**
   * 停用活动
   */
  async deactivateEvent(eventId) {
    const event = await this.getEvent(eventId);

    await db.query(
      'UPDATE events SET status = $1 WHERE id = $2',
      ['completed', eventId]
    );

    this.activeEvents.delete(eventId);

    if (this.eventSchedulers.has(eventId)) {
      const scheduler = this.eventSchedulers.get(eventId);
      if (scheduler.timeoutId) clearTimeout(scheduler.timeoutId);
      if (scheduler.endTimeoutId) clearTimeout(scheduler.endTimeoutId);
      this.eventSchedulers.delete(eventId);
    }

    await publishEvent(EVENTS.EVENT_DEACTIVATED, {
      eventId,
      eventKey: event.event_key,
      timestamp: new Date()
    });

    await this.aggregateEventStats(eventId);

    logger.info({ eventId, eventKey: event.event_key }, 'Event completed');
  }

  /**
   * 通知精灵刷新加成
   */
  async notifySpawnBoost(event) {
    const spawns = await db.query(
      'SELECT * FROM event_spawns WHERE event_id = $1 AND is_active = TRUE',
      [event.id]
    );

    await publishEvent(EVENTS.SPAWN_BOOST_ACTIVATED, {
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

    const existing = await db.query(
      'SELECT * FROM event_participations WHERE event_id = $1 AND user_id = $2',
      [eventId, userId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const result = await db.query(`
      INSERT INTO event_participations (event_id, user_id)
      VALUES ($1, $2)
      RETURNING *
    `, [eventId, userId]);

    await db.query(
      'UPDATE events SET participant_count = participant_count + 1 WHERE id = $1',
      [eventId]
    );

    await publishEvent(EVENTS.EVENT_JOINED, {
      eventId,
      userId,
      timestamp: new Date()
    });

    return result.rows[0];
  }

  /**
   * 获取用户活跃活动列表
   */
  async getActiveEventsForUser(userId) {
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
   * 获取活动详情（包含任务和商店）
   */
  async getEventWithDetails(eventId, userId = null) {
    const event = await this.getEvent(eventId);
    if (!event) return null;

    // 获取任务
    const tasks = await db.query(`
      SELECT t.*, 
        uet.progress as user_progress,
        uet.completed_count as user_completed_count
      FROM event_tasks t
      LEFT JOIN user_event_tasks uet ON t.id = uet.task_id AND uet.user_id = $1
      WHERE t.event_id = $2
      ORDER BY t.display_order
    `, [userId, eventId]);

    // 获取商店
    const shop = await db.query(`
      SELECT * FROM event_shops
      WHERE event_id = $1 AND is_active = TRUE
      ORDER BY display_order
    `, [eventId]);

    // 获取用户参与状态
    let participation = null;
    if (userId) {
      const pResult = await db.query(
        'SELECT * FROM event_participations WHERE event_id = $1 AND user_id = $2',
        [eventId, userId]
      );
      participation = pResult.rows[0] || null;
    }

    return {
      ...event,
      tasks: tasks.rows,
      shop: shop.rows,
      participation
    };
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
        progress = event_participations.progress || EXCLUDED.progress
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

    const completion = await db.query(`
      SELECT * FROM user_event_tasks
      WHERE event_id = $1 AND task_id = $2 AND user_id = $3
    `, [eventId, taskId, userId]);

    const completedCount = completion.rows.length > 0 ? completion.rows[0].completed_count : 0;

    if (!taskData.is_repeatable && completedCount >= taskData.max_completions) {
      throw new Error('Task already completed');
    }

    await db.query(`
      INSERT INTO user_event_tasks (event_id, task_id, user_id, completed_count)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (event_id, task_id, user_id)
      DO UPDATE SET 
        completed_count = user_event_tasks.completed_count + 1,
        last_updated = CURRENT_TIMESTAMP
    `, [eventId, taskId, userId]);

    await publishEvent(EVENTS.REWARD_GRANT, {
      userId,
      source: 'event_task',
      sourceId: task.id,
      eventId,
      rewards: taskData.rewards
    });

    return { success: true, taskId, userId };
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

    await publishEvent(EVENTS.REWARD_GRANT, {
      userId,
      source: 'event_completion',
      sourceId: eventId,
      eventId,
      rewards: event.rewards
    });

    await db.query(`
      UPDATE event_participations
      SET rewards_claimed = TRUE, rewards_claimed_at = CURRENT_TIMESTAMP, status = 'completed'
      WHERE event_id = $1 AND user_id = $2
    `, [eventId, userId]);

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

    if (item.total_stock !== null && item.sold_count + quantity > item.total_stock) {
      throw new Error('Insufficient stock');
    }

    const userPurchases = await db.query(`
      SELECT COALESCE(SUM(purchase_count), 0) as total_purchased
      FROM event_shop_purchases
      WHERE event_id = $1 AND shop_item_id = $2 AND user_id = $3
    `, [eventId, shopItemId, userId]);

    const totalPurchased = parseInt(userPurchases.rows[0].total_purchased) || 0;

    if (item.purchase_limit && totalPurchased + quantity > item.purchase_limit) {
      throw new Error('Purchase limit exceeded');
    }

    const todayPurchases = await db.query(`
      SELECT COALESCE(SUM(purchase_count), 0) as today_purchased
      FROM event_shop_purchases
      WHERE event_id = $1 AND shop_item_id = $2 AND user_id = $3
        AND DATE(purchased_at) = CURRENT_DATE
    `, [eventId, shopItemId, userId]);

    const todayPurchased = parseInt(todayPurchases.rows[0].today_purchased) || 0;

    if (item.daily_limit && todayPurchased + quantity > item.daily_limit) {
      throw new Error('Daily purchase limit exceeded');
    }

    const totalCost = item.cost_amount * quantity;

    await db.query(`
      INSERT INTO event_shop_purchases
        (event_id, shop_item_id, user_id, purchase_count, total_cost)
      VALUES ($1, $2, $3, $4, $5)
    `, [eventId, shopItemId, userId, quantity, totalCost]);

    await db.query(
      'UPDATE event_shops SET sold_count = sold_count + $1 WHERE id = $2',
      [quantity, shopItemId]
    );

    await publishEvent(EVENTS.REWARD_GRANT, {
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
   * 获取活动排行榜
   */
  async getEventLeaderboard(eventId, limit = 100, offset = 0) {
    const result = await db.query(`
      SELECT 
        ep.user_id,
        ep.progress,
        RANK() OVER (ORDER BY (ep.progress->>'score')::numeric DESC NULLS LAST) as rank
      FROM event_participations ep
      WHERE ep.event_id = $1 AND ep.status = 'active'
      ORDER BY (ep.progress->>'score')::numeric DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `, [eventId, limit, offset]);

    return result.rows;
  }

  /**
   * 启动活动调度器
   */
  startEventScheduler() {
    cron.schedule('* * * * *', async () => {
      try {
        await this.checkScheduledEvents();
      } catch (error) {
        logger.error({ error }, 'Event scheduler error');
      }
    });
  }

  /**
   * 检查计划中的活动
   */
  async checkScheduledEvents() {
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
        logger.error({ error, eventId: event.id }, 'Failed to activate event');
      }
    }

    const toEnd = await db.query(`
      SELECT id FROM events
      WHERE status = 'active'
        AND end_time <= CURRENT_TIMESTAMP
    `);

    for (const event of toEnd.rows) {
      try {
        await this.deactivateEvent(event.id);
      } catch (error) {
        logger.error({ error, eventId: event.id }, 'Failed to deactivate event');
      }
    }
  }

  /**
   * 启动统计聚合
   */
  startStatsAggregator() {
    cron.schedule('*/5 * * * *', async () => {
      for (const eventId of this.activeEvents.keys()) {
        try {
          await this.aggregateEventStats(eventId);
        } catch (error) {
          logger.error({ error, eventId }, 'Failed to aggregate stats');
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
   * 暂停活动
   */
  async pauseEvent(eventId) {
    await db.query(
      'UPDATE events SET status = $1 WHERE id = $2',
      ['paused', eventId]
    );

    this.activeEvents.delete(eventId);
    await publishEvent(EVENTS.EVENT_PAUSED, { eventId });
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
      await publishEvent(EVENTS.EVENT_RESUMED, { eventId });
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

    if (this.eventSchedulers.has(eventId)) {
      const scheduler = this.eventSchedulers.get(eventId);
      if (scheduler.timeoutId) clearTimeout(scheduler.timeoutId);
      if (scheduler.endTimeoutId) clearTimeout(scheduler.endTimeoutId);
      this.eventSchedulers.delete(eventId);
    }

    await publishEvent(EVENTS.EVENT_CANCELLED, { eventId });
  }
}

// 导出单例
const eventService = new EventService();
module.exports = eventService;
