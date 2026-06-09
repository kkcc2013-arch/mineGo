# REQ-00059: 新手引导与教程系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00059 |
| 标题 | 新手引导与教程系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 20:00 |

## 需求描述

实现完整的新手引导系统，通过交互式教程、任务指引和智能提示，帮助新玩家快速上手游戏，降低流失率，提升新手转化率和次日留存率。

### 核心功能

1. **交互式教程系统**
   - 分步骤引导（捕捉、战斗、道馆、好友等）
   - 高亮显示UI元素
   - 强制操作指引（必须完成才能继续）
   - 可跳过选项（老玩家或已有经验玩家）

2. **新手任务系统**
   - 新手专属任务线（引导玩家了解所有功能）
   - 任务奖励（新手礼包、金币、精灵球）
   - 进度追踪与里程碑奖励
   - 任务完成提示与庆祝动画

3. **智能提示系统**
   - 上下文相关提示（根据玩家位置和状态）
   - 功能解锁提示（新功能解锁时）
   - 效率提升建议（如背包已满提示清理）
   - 成就提示（接近达成成就时）

4. **教学精灵系统**
   - 新手专属初始精灵选择
   - 教学战斗（与教学NPC对战）
   - 伤害计算教学
   - 属性克制教学

5. **帮助中心**
   - FAQ搜索
   - 功能说明文档
   - 视频教程链接
   - 在线客服入口

6. **新手数据分析**
   - 新手流失节点分析
   - 教程完成率统计
   - 任务完成时间分析
   - A/B测试支持

## 技术方案

### 1. 数据库设计

```sql
-- 教程进度表
CREATE TABLE tutorial_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 教程步骤完成状态
    completed_steps JSONB DEFAULT '[]',
    current_step VARCHAR(50),
    
    -- 新手任务进度
    tutorial_tasks JSONB DEFAULT '{}',
    
    -- 跳过状态
    skipped BOOLEAN DEFAULT FALSE,
    skipped_at TIMESTAMP,
    
    -- 时间统计
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    total_time_seconds INTEGER DEFAULT 0,
    
    -- 标记
    is_first_time_player BOOLEAN DEFAULT TRUE,
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 教程步骤定义表
CREATE TABLE tutorial_steps (
    id SERIAL PRIMARY KEY,
    step_key VARCHAR(50) UNIQUE NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    
    -- 步骤类型
    step_type VARCHAR(20) NOT NULL CHECK (step_type IN ('instruction', 'action_required', 'dialogue', 'cutscene')),
    
    -- 引导配置
    target_element VARCHAR(100), -- CSS选择器
    highlight_style JSONB DEFAULT '{}',
    position VARCHAR(20) DEFAULT 'bottom', -- tooltip位置
    
    -- 操作要求
    required_action VARCHAR(100), -- 'catch_pokemon', 'visit_gym', etc.
    required_params JSONB DEFAULT '{}',
    
    -- 奖励
    rewards JSONB DEFAULT '{}',
    
    -- 流程控制
    next_step VARCHAR(50),
    prerequisite_steps JSONB DEFAULT '[]',
    can_skip BOOLEAN DEFAULT TRUE,
    
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 新手任务表
CREATE TABLE beginner_tasks (
    id SERIAL PRIMARY KEY,
    task_key VARCHAR(100) UNIQUE NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    
    -- 任务类型
    task_type VARCHAR(50) NOT NULL,
    
    -- 要求
    requirement JSONB NOT NULL,
    target_count INTEGER DEFAULT 1,
    
    -- 奖励
    rewards JSONB NOT NULL,
    
    -- 依赖关系
    prerequisite_tasks JSONB DEFAULT '[]',
    
    -- 显示配置
    display_order INTEGER DEFAULT 0,
    category VARCHAR(50) DEFAULT 'basic', -- 'basic', 'advanced', 'social'
    
    -- 时间限制（可选）
    time_limit_hours INTEGER,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户新手任务完成记录
CREATE TABLE user_beginner_tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES beginner_tasks(id) ON DELETE CASCADE,
    
    progress INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_id, task_id)
);

-- 智能提示配置表
CREATE TABLE smart_tips (
    id SERIAL PRIMARY KEY,
    tip_key VARCHAR(100) UNIQUE NOT NULL,
    
    title VARCHAR(200),
    content TEXT NOT NULL,
    
    -- 触发条件
    trigger_type VARCHAR(50) NOT NULL, -- 'location', 'action', 'state', 'time'
    trigger_conditions JSONB NOT NULL,
    
    -- 显示配置
    display_type VARCHAR(20) DEFAULT 'tooltip', -- 'tooltip', 'modal', 'banner'
    priority INTEGER DEFAULT 0,
    
    -- 限制
    max_displays INTEGER DEFAULT 3, -- 最多显示次数
    cooldown_hours INTEGER DEFAULT 24, -- 冷却时间
    
    -- 过期条件
    dismiss_conditions JSONB DEFAULT '{}',
    
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户提示显示记录
CREATE TABLE user_tip_displays (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tip_id INTEGER NOT NULL REFERENCES smart_tips(id) ON DELETE CASCADE,
    
    display_count INTEGER DEFAULT 1,
    last_displayed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    dismissed BOOLEAN DEFAULT FALSE,
    
    UNIQUE(user_id, tip_id)
);

-- 功能解锁表
CREATE TABLE feature_unlocks (
    id SERIAL PRIMARY KEY,
    feature_key VARCHAR(100) UNIQUE NOT NULL,
    
    feature_name VARCHAR(200) NOT NULL,
    description TEXT,
    
    -- 解锁条件
    unlock_type VARCHAR(20) NOT NULL CHECK (unlock_type IN ('level', 'tutorial', 'quest', 'manual')),
    unlock_requirement JSONB NOT NULL,
    
    -- 解锁提示
    unlock_message TEXT,
    unlock_image VARCHAR(500),
    
    -- 相关教程步骤
    tutorial_step VARCHAR(50),
    
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户功能解锁记录
CREATE TABLE user_feature_unlocks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES feature_unlocks(id) ON DELETE CASCADE,
    
    unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notification_shown BOOLEAN DEFAULT FALSE,
    
    UNIQUE(user_id, feature_id)
);

-- 帮助中心FAQ表
CREATE TABLE help_faq (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    
    -- 搜索优化
    keywords JSONB DEFAULT '[]',
    
    -- 统计
    view_count INTEGER DEFAULT 0,
    helpful_count INTEGER DEFAULT 0,
    not_helpful_count INTEGER DEFAULT 0,
    
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户帮助反馈表
CREATE TABLE help_feedback (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    faq_id INTEGER REFERENCES help_faq(id) ON DELETE CASCADE,
    
    was_helpful BOOLEAN,
    feedback_text TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 新手分析事件表
CREATE TABLE beginner_analytics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB DEFAULT '{}',
    
    -- 上下文
    tutorial_step VARCHAR(50),
    task_key VARCHAR(100),
    session_id VARCHAR(100),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_tutorial_progress_user ON tutorial_progress(user_id);
CREATE INDEX idx_tutorial_steps_order ON tutorial_steps(display_order);
CREATE INDEX idx_beginner_tasks_category ON beginner_tasks(category, display_order);
CREATE INDEX idx_user_beginner_tasks_user ON user_beginner_tasks(user_id);
CREATE INDEX idx_smart_tips_trigger ON smart_tips(trigger_type, is_active);
CREATE INDEX idx_user_tip_displays_user ON user_tip_displays(user_id);
CREATE INDEX idx_feature_unlocks_type ON feature_unlocks(unlock_type);
CREATE INDEX idx_user_feature_unlocks_user ON user_feature_unlocks(user_id);
CREATE INDEX idx_help_faq_category ON help_faq(category);
CREATE INDEX idx_beginner_analytics_user ON beginner_analytics(user_id, created_at);
```

### 2. 后端服务实现

#### user-service/src/tutorialService.js

```javascript
const { db } = require('../shared/db');
const { EventBus, EVENTS } = require('../shared/EventBus');

class TutorialService {
  constructor() {
    this.TUTORIAL_STEPS = this.loadTutorialSteps();
  }

  /**
   * 加载教程步骤配置
   */
  loadTutorialSteps() {
    // 从数据库加载或使用默认配置
    return {
      'welcome': {
        title: '欢迎来到 mineGo!',
        description: '开始你的精灵训练师之旅',
        stepType: 'dialogue',
        nextStep: 'choose_starter'
      },
      'choose_starter': {
        title: '选择你的初始精灵',
        description: '从三只初始精灵中选择一只作为你的伙伴',
        stepType: 'action_required',
        requiredAction: 'choose_starter',
        nextStep: 'first_catch'
      },
      'first_catch': {
        title: '捕捉你的第一只精灵',
        description: '在地图上找到精灵并尝试捕捉',
        stepType: 'action_required',
        requiredAction: 'catch_pokemon',
        targetElement: '.catch-button',
        position: 'top',
        nextStep: 'visit_pokestop'
      },
      'visit_pokestop': {
        title: '访问精灵站点',
        description: '访问附近的精灵站点获取补给',
        stepType: 'action_required',
        requiredAction: 'visit_pokestop',
        nextStep: 'first_battle'
      },
      'first_battle': {
        title: '你的第一场战斗',
        description: '挑战一个道馆，体验战斗系统',
        stepType: 'action_required',
        requiredAction: 'battle_gym',
        nextStep: 'add_friend'
      },
      'add_friend': {
        title: '添加好友',
        description: '添加好友可以互相帮助和交换精灵',
        stepType: 'action_required',
        requiredAction: 'add_friend',
        nextStep: 'tutorial_complete'
      },
      'tutorial_complete': {
        title: '恭喜完成新手教程!',
        description: '你已经准备好开始真正的冒险了',
        stepType: 'cutscene',
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

    return result.rows[0];
  }

  /**
   * 获取当前教程进度
   */
  async getTutorialProgress(userId) {
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
    const progress = await this.getTutorialProgress(userId);

    if (progress.skipped) {
      throw new Error('Tutorial was skipped');
    }

    const step = this.TUTORIAL_STEPS[stepKey];
    if (!step) {
      throw new Error('Invalid step');
    }

    // 检查是否已完成
    const completedSteps = progress.completed_steps || [];
    if (completedSteps.includes(stepKey)) {
      throw new Error('Step already completed');
    }

    const nextStep = step.nextStep;

    const result = await db.query(`
      UPDATE tutorial_progress
      SET 
        completed_steps = completed_steps || $1::jsonb,
        current_step = $2,
        completed_at = CASE WHEN $3 IS NULL THEN completed_at ELSE CURRENT_TIMESTAMP END,
        total_time_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at))
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

    // 如果教程完成
    if (!nextStep) {
      await this.onTutorialComplete(userId);
    }

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
    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'tutorial_step',
      sourceId: stepKey,
      rewards: Object.entries(rewards).map(([type, amount]) => ({
        type,
        amount
      }))
    });
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

    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'tutorial_completion',
      rewards: Object.entries(completionReward).map(([type, amount]) => ({
        type,
        amount
      }))
    });

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'tutorial_completed', {
      totalTimeSeconds: await this.getTutorialDuration(userId)
    });

    // 发布教程完成事件
    await EventBus.publish(EVENTS.TUTORIAL_COMPLETED, {
      userId,
      timestamp: new Date()
    });
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
      SET skipped = TRUE, skipped_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
    `, [userId]);

    // 解锁基础功能
    await this.unlockAllBasicFeatures(userId);

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'tutorial_skipped', {
      completedSteps: progress.completed_steps.length
    });

    return { success: true };
  }

  /**
   * 初始化新手任务
   */
  async initializeBeginnerTasks(userId) {
    const tasks = await db.query(
      'SELECT * FROM beginner_tasks WHERE is_active = TRUE ORDER BY display_order'
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
        bt.*,
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
      SELECT ubt.*, bt.requirement, bt.target_count
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
    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'beginner_task',
      sourceId: taskId,
      rewards: task.rows[0].rewards
    });

    return { success: true, rewards: task.rows[0].rewards };
  }

  /**
   * 检查功能是否解锁
   */
  async isFeatureUnlocked(userId, featureKey) {
    const result = await db.query(`
      SELECT 1 FROM user_feature_unlocks
      WHERE user_id = $1 AND feature_id = (
        SELECT id FROM feature_unlocks WHERE feature_key = $2
      )
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
      throw new Error('Feature not found');
    }

    const featureData = feature.rows[0];

    await db.query(`
      INSERT INTO user_feature_unlocks (user_id, feature_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [userId, featureData.id]);

    // 发布解锁事件
    await EventBus.publish(EVENTS.FEATURE_UNLOCKED, {
      userId,
      featureKey,
      featureName: featureData.feature_name,
      message: featureData.unlock_message,
      timestamp: new Date()
    });

    // 记录分析事件
    await this.logAnalyticsEvent(userId, 'feature_unlocked', {
      featureKey,
      unlockType: featureData.unlock_type
    });

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
    if (conditions.lowPokeballs && context.pokeballCount < 5) return true;
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
      await this.unlockFeature(userId, feature.feature_key);
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
      SELECT * FROM help_faq
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
    await db.query(`
      INSERT INTO beginner_analytics (user_id, event_type, event_data)
      VALUES ($1, $2, $3)
    `, [userId, eventType, JSON.stringify(eventData)]);
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
```

### 3. 前端组件实现

#### game-client/src/components/TutorialOverlay.js

```javascript
class TutorialOverlay {
  constructor() {
    this.currentStep = null;
    this.overlay = null;
    this.tooltip = null;
    this.init();
  }

  async init() {
    await this.loadCurrentStep();
    this.createOverlay();
    if (this.currentStep) {
      this.showStep();
    }
  }

  async loadCurrentStep() {
    try {
      const response = await fetch('/api/tutorial/current-step', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const result = await response.json();
      this.currentStep = result.data;
    } catch (error) {
      console.error('Load tutorial step error:', error);
    }
  }

  createOverlay() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'tutorial-overlay';
    this.overlay.innerHTML = `
      <div class="tutorial-backdrop"></div>
      <div class="tutorial-tooltip">
        <div class="tooltip-header">
          <h3 class="tooltip-title"></h3>
          <button class="skip-btn">跳过</button>
        </div>
        <div class="tooltip-content">
          <p class="tooltip-description"></p>
        </div>
        <div class="tooltip-footer">
          <div class="progress-indicator"></div>
          <button class="next-btn">下一步</button>
        </div>
      </div>
      <div class="highlight-box"></div>
    `;

    document.body.appendChild(this.overlay);

    // 绑定事件
    this.overlay.querySelector('.skip-btn').addEventListener('click', () => {
      this.skipTutorial();
    });

    this.overlay.querySelector('.next-btn').addEventListener('click', () => {
      this.completeCurrentStep();
    });
  }

  showStep() {
    if (!this.currentStep) return;

    const step = this.currentStep;

    // 更新内容
    this.overlay.querySelector('.tooltip-title').textContent = step.title;
    this.overlay.querySelector('.tooltip-description').textContent = step.description;

    // 定位tooltip
    if (step.targetElement) {
      const targetElement = document.querySelector(step.targetElement);
      if (targetElement) {
        this.positionTooltip(targetElement, step.position || 'bottom');
        this.highlightElement(targetElement);
      }
    } else {
      this.centerTooltip();
    }

    // 更新进度指示器
    this.updateProgressIndicator(step.completedSteps);

    // 显示overlay
    this.overlay.classList.add('visible');

    // 自动完成步骤（如果是指令类型）
    if (step.stepType === 'instruction') {
      this.overlay.querySelector('.next-btn').style.display = 'block';
    } else {
      this.overlay.querySelector('.next-btn').style.display = 'none';
    }
  }

  positionTooltip(targetElement, position) {
    const targetRect = targetElement.getBoundingClientRect();
    const tooltip = this.overlay.querySelector('.tutorial-tooltip');
    
    let top, left;

    switch (position) {
      case 'top':
        top = targetRect.top - tooltip.offsetHeight - 10;
        left = targetRect.left + (targetRect.width / 2) - (tooltip.offsetWidth / 2);
        break;
      case 'bottom':
        top = targetRect.bottom + 10;
        left = targetRect.left + (targetRect.width / 2) - (tooltip.offsetWidth / 2);
        break;
      case 'left':
        top = targetRect.top + (targetRect.height / 2) - (tooltip.offsetHeight / 2);
        left = targetRect.left - tooltip.offsetWidth - 10;
        break;
      case 'right':
        top = targetRect.top + (targetRect.height / 2) - (tooltip.offsetHeight / 2);
        left = targetRect.right + 10;
        break;
    }

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  centerTooltip() {
    const tooltip = this.overlay.querySelector('.tutorial-tooltip');
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
  }

  highlightElement(element) {
    const rect = element.getBoundingClientRect();
    const highlightBox = this.overlay.querySelector('.highlight-box');
    
    highlightBox.style.top = `${rect.top - 5}px`;
    highlightBox.style.left = `${rect.left - 5}px`;
    highlightBox.style.width = `${rect.width + 10}px`;
    highlightBox.style.height = `${rect.height + 10}px`;
    highlightBox.classList.add('visible');
  }

  updateProgressIndicator(completedSteps) {
    const totalSteps = Object.keys(this.TUTORIAL_STEPS || {}).length;
    const indicator = this.overlay.querySelector('.progress-indicator');
    
    indicator.innerHTML = `${completedSteps.length} / ${totalSteps}`;
  }

  async completeCurrentStep() {
    try {
      const response = await fetch('/api/tutorial/complete-step', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ stepKey: this.currentStep.stepKey })
      });

      const result = await response.json();

      if (result.success) {
        if (result.rewards) {
          this.showRewardAnimation(result.rewards);
        }

        if (result.nextStep) {
          await this.loadCurrentStep();
          this.showStep();
        } else {
          this.onTutorialComplete();
        }
      }
    } catch (error) {
      console.error('Complete step error:', error);
    }
  }

  async skipTutorial() {
    if (confirm('确定要跳过新手教程吗？你可以稍后在设置中重新查看。')) {
      try {
        await fetch('/api/tutorial/skip', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });

        this.hideOverlay();
      } catch (error) {
        console.error('Skip tutorial error:', error);
      }
    }
  }

  onTutorialComplete() {
    this.hideOverlay();
    this.showCompletionModal();
  }

  showCompletionModal() {
    const modal = document.createElement('div');
    modal.className = 'tutorial-complete-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="celebration-animation">🎉</div>
        <h2>恭喜完成新手教程!</h2>
        <p>你已经准备好开始真正的冒险了</p>
        <button class="start-adventure-btn">开始冒险</button>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.start-adventure-btn').addEventListener('click', () => {
      modal.remove();
    });
  }

  showRewardAnimation(rewards) {
    // 显示奖励动画
    console.log('Rewards:', rewards);
  }

  hideOverlay() {
    if (this.overlay) {
      this.overlay.classList.remove('visible');
    }
  }
}

module.exports = TutorialOverlay;
```

### 4. API路由

#### user-service/src/routes/tutorial.js

```javascript
const express = require('express');
const router = express.Router();
const tutorialService = require('../tutorialService');
const { authenticate } = require('../../../shared/middleware/auth');

/**
 * GET /api/tutorial/progress
 * 获取教程进度
 */
router.get('/progress', authenticate, async (req, res) => {
  try {
    const progress = await tutorialService.getTutorialProgress(req.user.id);
    res.json({ success: true, data: progress });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/current-step
 * 获取当前步骤
 */
router.get('/current-step', authenticate, async (req, res) => {
  try {
    const step = await tutorialService.getCurrentStep(req.user.id);
    res.json({ success: true, data: step });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/complete-step
 * 完成步骤
 */
router.post('/complete-step', authenticate, async (req, res) => {
  try {
    const result = await tutorialService.completeStep(req.user.id, req.body.stepKey);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/skip
 * 跳过教程
 */
router.post('/skip', authenticate, async (req, res) => {
  try {
    const result = await tutorialService.skipTutorial(req.user.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/beginner-tasks
 * 获取新手任务
 */
router.get('/beginner-tasks', authenticate, async (req, res) => {
  try {
    const tasks = await tutorialService.getBeginnerTasks(req.user.id);
    res.json({ success: true, data: tasks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/beginner-tasks/:taskId/claim
 * 领取任务奖励
 */
router.post('/beginner-tasks/:taskId/claim', authenticate, async (req, res) => {
  try {
    const result = await tutorialService.claimBeginnerTaskReward(req.user.id, parseInt(req.params.taskId));
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/smart-tips
 * 获取智能提示
 */
router.get('/smart-tips', authenticate, async (req, res) => {
  try {
    const tips = await tutorialService.getSmartTips(req.user.id, req.query);
    res.json({ success: true, data: tips });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/smart-tips/:tipId/dismiss
 * 关闭提示
 */
router.post('/smart-tips/:tipId/dismiss', authenticate, async (req, res) => {
  try {
    await tutorialService.dismissTip(req.user.id, parseInt(req.params.tipId));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/tutorial/faq/search
 * 搜索FAQ
 */
router.get('/faq/search', async (req, res) => {
  try {
    const results = await tutorialService.searchFAQ(req.query.q);
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/tutorial/faq/:faqId/feedback
 * 提交FAQ反馈
 */
router.post('/faq/:faqId/feedback', authenticate, async (req, res) => {
  try {
    await tutorialService.submitFAQFeedback(
      req.user.id,
      parseInt(req.params.faqId),
      req.body.wasHelpful,
      req.body.feedbackText
    );
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 教程步骤按顺序正确显示
- [ ] 步骤完成可以进入下一步
- [ ] 步骤奖励正确发放
- [ ] 可以跳过教程
- [ ] 新手任务正确跟踪进度
- [ ] 任务完成可以领取奖励
- [ ] 智能提示根据上下文正确显示
- [ ] 功能解锁正确触发
- [ ] FAQ搜索功能正常
- [ ] 教程完成发放完成奖励
- [ ] 前端overlay正确高亮元素
- [ ] 分析事件正确记录
- [ ] 单元测试覆盖率 ≥ 80%

## 影响范围

- **数据库**: 新增 11 张表（tutorial_progress、tutorial_steps、beginner_tasks等）
- **user-service**: 新增 tutorialService.js，新增路由 tutorial.js
- **reward-service**: 集成奖励发放
- **game-client**: 新增 TutorialOverlay 组件
- **API**: 新增 10+ 个教程相关端点
- **metrics**: 新增教程完成率、跳过率等指标

## 参考

- [游戏新手引导设计最佳实践](https://www.gamasutra.com/blogs/DanCook/20180808/324835/Designing_Tutorials.php)
- [用户引导心理学](https://www.nngroup.com/articles/onboarding-tutorials/)
- [游戏教程交互设计](https://www.gdcvault.com/play/1023862/Tutorial)
- REQ-00056: 精灵图鉴完成度奖励系统（奖励系统）
- REQ-00057: 游戏活动系统（任务系统）
