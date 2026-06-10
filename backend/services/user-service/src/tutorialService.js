/**
 * REQ-00059: 新手引导与教程系统
 * 教程服务核心模块
 */

const { db } = require('../../../shared/db');
const { EventBus, EVENTS } = require('../../../shared/EventBus');
const logger = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

class TutorialService {
  constructor() {
    this.TUTORIAL_STEPS = null;
    this.initialized = false;
  }

  /**
   * 初始化 - 从数据库加载教程步骤
   */
  async init() {
    if (this.initialized) return;
    
    try {
      const result = await db.query(
        'SELECT * FROM tutorial_steps WHERE is_active = TRUE ORDER BY display_order'
      );
      
      this.TUTORIAL_STEPS = {};
      for (const step of result.rows) {
        this.TUTORIAL_STEPS[step.step_key] = step;
      }
      
      this.initialized = true;
      logger.info('TutorialService initialized', { stepCount: Object.keys(this.TUTORIAL_STEPS).length });
    } catch (error) {
      logger.error('Failed to initialize TutorialService', { error: error.message });
      // 使用默认配置
      this.TUTORIAL_STEPS = this.getDefaultSteps();
      this.initialized = true;
    }
  }

  /**
   * 获取默认教程步骤
   */
  getDefaultSteps() {
    return {
      'welcome': {
        step_key: 'welcome',
        title: '欢迎来到 mineGo!',
        description: '开始你的精灵训练师之旅',
        step_type: 'dialogue',
        next_step: 'choose_starter',
        rewards: {}
      },
      'choose_starter': {
        step_key: 'choose_starter',
        title: '选择你的初始精灵',
        description: '从三只初始精灵中选择一只作为你的伙伴',
        step_type: 'action_required',
        required_action: 'choose_starter',
        target_element: '.starter-selection',
        next_step: 'first_catch',
        rewards: { coins: 100 }
      },
      'first_catch': {
        step_key: 'first_catch',
        title: '捕捉你的第一只精灵',
        description: '在地图上找到精灵并尝试捕捉',
        step_type: 'action_required',
        required_action: 'catch_pokemon',
        target_element: '.catch-button',
        position: 'top',
        next_step: 'visit_pokestop',
        rewards: { pokeballs: 5 }
      },
      'visit_pokestop': {
        step_key: 'visit_pokestop',
        title: '访问精灵站点',
        description: '访问附近的精灵站点获取补给',
        step_type: 'action_required',
        required_action: 'visit_pokestop',
        target_element: '.pokestop-marker',
        next_step: 'first_battle',
        rewards: { potions: 5 }
      },
      'first_battle': {
        step_key: 'first_battle',
        title: '你的第一场战斗',
        description: '挑战一个道馆，体验战斗系统',
        step_type: 'action_required',
        required_action: 'battle_gym',
        target_element: '.gym-marker',
        next_step: 'add_friend',
        rewards: { coins: 200 }
      },
      'add_friend': {
        step_key: 'add_friend',
        title: '添加好友',
        description: '添加好友可以互相帮助和交换精灵',
        step_type: 'action_required',
        required_action: 'add_friend',
        target_element: '.add-friend-button',
        next_step: 'tutorial_complete',
        rewards: { stardust: 500 }
      },
      'tutorial_complete': {
        step_key: 'tutorial_complete',
        title: '恭喜完成新手教程!',
        description: '你已经准备好开始真正的冒险了',
        step_type: 'cutscene',
        rewards: {
          coins: 1000,
          pokeballs: 20,
          potions: 10,
          revives: 5
        }
      }
    };
  }

  /**
   * 开始新手教程
   */
  async startTutorial(userId) {
    await this.init();
    
    const existing = await db.query(
      'SELECT * FROM tutorial_progress WHERE user_id = $1',
      [userId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const result = await db.query(`
      INSERT INTO tutorial_progress (user_id, current_step, completed_steps)
      VALUES ($1, 'welcome', '[]'::jsonb)
      RETURNING *
    `, [userId]);

    // 创建新手任务
    await this.initializeBeginnerTasks(userId);

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'tutorial_started', {});

    metrics.incrementCounter('tutorial_started_total');
    logger.info('Tutorial started', { userId });

    return result.rows[0];
  }

  /**
   * 获取当前教程进度
   */
  async getTutorialProgress(userId) {
    await this.init();
    
    const result = await db.query(
      'SELECT * FROM tutorial_progress WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // 自动开始教程
      return await this.startTutorial(userId);
    }

    return result.rows[0];
  }

  /**
   * 获取当前步骤详情
   */
  async getCurrentStep(userId) {
    await this.init();
    
    const progress = await this.getTutorialProgress(userId);
    
    if (progress.skipped || progress.completed_at) {
      return null;
    }

    const currentStepKey = progress.current_step;
    const step = this.TUTORIAL_STEPS[currentStepKey];

    if (!step) {
      return null;
    }

    return {
      stepKey: currentStepKey,
      ...step,
      completedSteps: progress.completed_steps
    };
  }

  /**
   * 完成教程步骤
   */
  async completeStep(userId, stepKey) {
    await this.init();
    
    const progress = await this.getTutorialProgress(userId);

    if (progress.skipped) {
      throw new Error('Tutorial was skipped');
    }

    const step = this.TUTORIAL_STEPS[stepKey];
    if (!step) {
      throw new Error('Invalid step: ' + stepKey);
    }

    // 检查是否已完成
    const completedSteps = progress.completed_steps || [];
    if (completedSteps.includes(stepKey)) {
      throw new Error('Step already completed');
    }

    const nextStep = step.next_step;

    const result = await db.query(`
      UPDATE tutorial_progress
      SET 
        completed_steps = completed_steps || $1::jsonb,
        current_step = $2,
        completed_at = CASE WHEN $3 IS NULL THEN completed_at ELSE CURRENT_TIMESTAMP END,
        total_time_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at))::INTEGER,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $4
      RETURNING *
    `, [JSON.stringify(stepKey), nextStep || null, nextStep ? null : 'done', userId]);

    // 发放步骤奖励
    if (step.rewards && Object.keys(step.rewards).length > 0) {
      await this.grantStepRewards(userId, stepKey, step.rewards);
    }

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'tutorial_step_completed', {
      stepKey,
      nextStep,
      totalSteps: completedSteps.length + 1
    });

    metrics.incrementCounter('tutorial_step_completed_total', { step: stepKey });

    // 如果教程完成
    if (!nextStep) {
      await this.onTutorialComplete(userId);
    }

    logger.info('Tutorial step completed', { userId, stepKey, nextStep });

    return {
      success: true,
      nextStep,
      rewards: step.rewards
    };
  }

  /**
   * 发放步骤奖励
   */
  async grantStepRewards(userId, stepKey, rewards) {
    try {
      await EventBus.publish(EVENTS.REWARD_GRANT, {
        userId,
        source: 'tutorial_step',
        sourceId: stepKey,
        rewards: Object.entries(rewards).map(([type, amount]) => ({
          type,
          amount
        }))
      });
    } catch (error) {
      logger.error('Failed to grant step rewards', { userId, stepKey, error: error.message });
    }
  }

  /**
   * 教程完成处理
   */
  async onTutorialComplete(userId) {
    // 解锁所有基础功能
    await this.unlockAllBasicFeatures(userId);

    // 发放完成奖励
    const completionReward = {
      coins: 2000,
      pokeballs: 50,
      super_potions: 10,
      lucky_egg: 1,
      incense: 2
    };

    try {
      await EventBus.publish(EVENTS.REWARD_GRANT, {
        userId,
        source: 'tutorial_completion',
        rewards: Object.entries(completionReward).map(([type, amount]) => ({
          type,
          amount
        }))
      });
    } catch (error) {
      logger.error('Failed to grant completion rewards', { userId, error: error.message });
    }

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'tutorial_completed', {
      totalTimeSeconds: await this.getTutorialDuration(userId)
    });

    // 发布教程完成事件
    try {
      await EventBus.publish(EVENTS.TUTORIAL_COMPLETED, {
        userId,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Failed to publish tutorial completed event', { userId, error: error.message });
    }

    metrics.incrementCounter('tutorial_completed_total');
    logger.info('Tutorial completed', { userId });
  }

  /**
   * 跳过教程
   */
  async skipTutorial(userId) {
    const progress = await this.getTutorialProgress(userId);

    if (progress.skipped) {
      throw new Error('Tutorial already skipped');
    }

    await db.query(`
      UPDATE tutorial_progress
      SET skipped = TRUE, skipped_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
    `, [userId]);

    // 解锁基础功能
    await this.unlockAllBasicFeatures(userId);

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'tutorial_skipped', {
      completedSteps: progress.completed_steps.length
    });

    metrics.incrementCounter('tutorial_skipped_total');
    logger.info('Tutorial skipped', { userId, completedSteps: progress.completed_steps.length });

    return { success: true };
  }

  /**
   * 初始化新手任务
   */
  async initializeBeginnerTasks(userId) {
    const tasks = await db.query(
      'SELECT id FROM beginner_tasks WHERE is_active = TRUE'
    );

    for (const task of tasks.rows) {
      await db.query(`
        INSERT INTO user_beginner_tasks (user_id, task_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [userId, task.id]);
    }
  }

  /**
   * 获取新手任务列表
   */
  async getBeginnerTasks(userId) {
    const result = await db.query(`
      SELECT 
        bt.id,
        bt.task_key,
        bt.title,
        bt.description,
        bt.task_type,
        bt.target_count,
        bt.rewards,
        bt.category,
        ubt.progress,
        ubt.completed,
        ubt.rewards_claimed
      FROM beginner_tasks bt
      LEFT JOIN user_beginner_tasks ubt ON bt.id = ubt.task_id AND ubt.user_id = $1
      WHERE bt.is_active = TRUE
      ORDER BY bt.display_order
    `, [userId]);

    return result.rows;
  }

  /**
   * 更新新手任务进度
   */
  async updateBeginnerTaskProgress(userId, taskType, increment = 1) {
    const tasks = await db.query(`
      SELECT ubt.*, bt.id as task_id, bt.requirement, bt.target_count, bt.task_key
      FROM user_beginner_tasks ubt
      JOIN beginner_tasks bt ON ubt.task_id = bt.id
      WHERE ubt.user_id = $1 
        AND bt.task_type = $2 
        AND ubt.completed = FALSE
    `, [userId, taskType]);

    for (const task of tasks.rows) {
      const newProgress = Math.min(task.progress + increment, task.target_count);
      const completed = newProgress >= task.target_count;

      await db.query(`
        UPDATE user_beginner_tasks
        SET 
          progress = $1,
          completed = $2,
          completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE completed_at END
        WHERE user_id = $3 AND task_id = $4
      `, [newProgress, completed, userId, task.task_id]);

      if (completed) {
        await this.logAnalyticsEvent(userId, 'beginner_task_completed', {
          taskKey: task.task_key
        });
        metrics.incrementCounter('beginner_task_completed_total', { task: task.task_key });
        logger.info('Beginner task completed', { userId, taskKey: task.task_key });
      }
    }
  }

  /**
   * 领取新手任务奖励
   */
  async claimBeginnerTaskReward(userId, taskId) {
    const task = await db.query(`
      SELECT ubt.*, bt.rewards, bt.task_key
      FROM user_beginner_tasks ubt
      JOIN beginner_tasks bt ON ubt.task_id = bt.id
      WHERE ubt.user_id = $1 AND ubt.task_id = $2 AND ubt.completed = TRUE AND ubt.rewards_claimed = FALSE
    `, [userId, taskId]);

    if (task.rows.length === 0) {
      throw new Error('Task not found or rewards already claimed');
    }

    await db.query(`
      UPDATE user_beginner_tasks
      SET rewards_claimed = TRUE, rewards_claimed_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND task_id = $2
    `, [userId, taskId]);

    // 发放奖励
    const rewards = task.rows[0].rewards;
    try {
      await EventBus.publish(EVENTS.REWARD_GRANT, {
        userId,
        source: 'beginner_task',
        sourceId: taskId,
        rewards: Array.isArray(rewards) ? rewards : Object.entries(rewards).map(([type, amount]) => ({ type, amount }))
      });
    } catch (error) {
      logger.error('Failed to grant beginner task rewards', { userId, taskId, error: error.message });
    }

    logger.info('Beginner task reward claimed', { userId, taskId });
    return { success: true, rewards };
  }

  /**
   * 检查功能是否解锁
   */
  async isFeatureUnlocked(userId, featureKey) {
    const result = await db.query(`
      SELECT 1 FROM user_feature_unlocks ufu
      JOIN feature_unlocks fu ON ufu.feature_id = fu.id
      WHERE ufu.user_id = $1 AND fu.feature_key = $2
    `, [userId, featureKey]);

    return result.rows.length > 0;
  }

  /**
   * 解锁功能
   */
  async unlockFeature(userId, featureKey) {
    const feature = await db.query(
      'SELECT * FROM feature_unlocks WHERE feature_key = $1',
      [featureKey]
    );

    if (feature.rows.length === 0) {
      throw new Error('Feature not found: ' + featureKey);
    }

    const featureData = feature.rows[0];

    await db.query(`
      INSERT INTO user_feature_unlocks (user_id, feature_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [userId, featureData.id]);

    // 发布解锁事件
    try {
      await EventBus.publish(EVENTS.FEATURE_UNLOCKED, {
        userId,
        featureKey,
        featureName: featureData.feature_name,
        message: featureData.unlock_message,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Failed to publish feature unlocked event', { userId, featureKey, error: error.message });
    }

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'feature_unlocked', {
      featureKey,
      unlockType: featureData.unlock_type
    });

    metrics.incrementCounter('feature_unlocked_total', { feature: featureKey });
    logger.info('Feature unlocked', { userId, featureKey });

    return {
      success: true,
      feature: featureData
    };
  }

  /**
   * 获取智能提示
   */
  async getSmartTips(userId, context = {}) {
    const result = await db.query(`
      SELECT st.*, utd.display_count, utd.dismissed
      FROM smart_tips st
      LEFT JOIN user_tip_displays utd ON st.id = utd.tip_id AND utd.user_id = $1
      WHERE st.is_active = TRUE
        AND (utd.display_count IS NULL OR utd.display_count < st.max_displays)
        AND (utd.dismissed IS NULL OR utd.dismissed = FALSE)
      ORDER BY st.priority DESC
    `, [userId]);

    const tips = [];
    for (const tip of result.rows) {
      // 检查触发条件
      if (this.checkTriggerConditions(tip.trigger_type, tip.trigger_conditions, context)) {
        tips.push({
          id: tip.id,
          tipKey: tip.tip_key,
          title: tip.title,
          content: tip.content,
          displayType: tip.display_type
        });
      }
    }

    return tips;
  }

  /**
   * 检查触发条件
   */
  checkTriggerConditions(triggerType, conditions, context) {
    switch (triggerType) {
      case 'location':
        return context.location && conditions.regions?.includes(context.location.region);
      case 'state':
        return this.checkStateConditions(conditions, context);
      case 'time':
        return this.checkTimeConditions(conditions);
      default:
        return false;
    }
  }

  checkStateConditions(conditions, context) {
    if (conditions.backpackFull && context.backpackFull) return true;
    if (conditions.lowPokeballs && (context.pokeballCount ?? 0) < 5) return true;
    if (conditions.nearGym && context.nearGym) return true;
    return false;
  }

  checkTimeConditions(conditions) {
    const now = new Date();
    const hour = now.getHours();
    
    if (conditions.timeRange) {
      return hour >= conditions.timeRange.start && hour < conditions.timeRange.end;
    }
    return false;
  }

  /**
   * 记录提示显示
   */
  async recordTipDisplay(userId, tipId) {
    await db.query(`
      INSERT INTO user_tip_displays (user_id, tip_id, display_count, last_displayed_at)
      VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, tip_id)
      DO UPDATE SET 
        display_count = user_tip_displays.display_count + 1,
        last_displayed_at = CURRENT_TIMESTAMP
    `, [userId, tipId]);
  }

  /**
   * 关闭提示
   */
  async dismissTip(userId, tipId) {
    await db.query(`
      UPDATE user_tip_displays
      SET dismissed = TRUE
      WHERE user_id = $1 AND tip_id = $2
    `, [userId, tipId]);
  }

  /**
   * 解锁所有基础功能
   */
  async unlockAllBasicFeatures(userId) {
    const basicFeatures = await db.query(
      "SELECT feature_key FROM feature_unlocks WHERE unlock_type = 'tutorial'"
    );

    for (const feature of basicFeatures.rows) {
      try {
        await this.unlockFeature(userId, feature.feature_key);
      } catch (error) {
        logger.error('Failed to unlock feature', { userId, featureKey: feature.feature_key, error: error.message });
      }
    }
  }

  /**
   * 获取教程时长
   */
  async getTutorialDuration(userId) {
    const result = await db.query(
      'SELECT total_time_seconds FROM tutorial_progress WHERE user_id = $1',
      [userId]
    );
    return result.rows[0]?.total_time_seconds || 0;
  }

  /**
   * 搜索FAQ
   */
  async searchFAQ(query) {
    const result = await db.query(`
      SELECT id, category, question, answer, view_count, helpful_count
      FROM help_faq
      WHERE is_active = TRUE
        AND (question ILIKE $1 OR answer ILIKE $1 OR $2 = ANY(keywords))
      ORDER BY view_count DESC
      LIMIT 10
    `, [`%${query}%`, query]);

    return result.rows;
  }

  /**
   * 记录FAQ查看
   */
  async recordFAQView(faqId) {
    await db.query(
      'UPDATE help_faq SET view_count = view_count + 1 WHERE id = $1',
      [faqId]
    );
  }

  /**
   * 提交FAQ反馈
   */
  async submitFAQFeedback(userId, faqId, wasHelpful, feedbackText = null) {
    await db.query(`
      INSERT INTO help_feedback (user_id, faq_id, was_helpful, feedback_text)
      VALUES ($1, $2, $3, $4)
    `, [userId, faqId, wasHelpful, feedbackText]);

    if (wasHelpful) {
      await db.query(
        'UPDATE help_faq SET helpful_count = helpful_count + 1 WHERE id = $1',
        [faqId]
      );
    } else {
      await db.query(
        'UPDATE help_faq SET not_helpful_count = not_helpful_count + 1 WHERE id = $1',
        [faqId]
      );
    }
  }

  /**
   * 记录分析事件
   */
  async logAnalyticsEvent(userId, eventType, eventData) {
    try {
      await db.query(`
        INSERT INTO beginner_analytics (user_id, event_type, event_data)
        VALUES ($1, $2, $3)
      `, [userId, eventType, JSON.stringify(eventData)]);
    } catch (error) {
      logger.error('Failed to log analytics event', { userId, eventType, error: error.message });
    }
  }

  /**
   * 获取新手数据统计
   */
  async getBeginnerStats(startDate, endDate) {
    const result = await db.query(`
      SELECT 
        COUNT(DISTINCT user_id) as total_new_users,
        COUNT(DISTINCT CASE WHEN completed_at IS NOT NULL THEN user_id END) as completed_tutorial,
        AVG(total_time_seconds) as avg_completion_time,
        COUNT(DISTINCT CASE WHEN skipped THEN user_id END) as skipped_count
      FROM tutorial_progress
      WHERE started_at >= $1 AND started_at <= $2
    `, [startDate, endDate]);

    return result.rows[0];
  }
}

module.exports = new TutorialService();
