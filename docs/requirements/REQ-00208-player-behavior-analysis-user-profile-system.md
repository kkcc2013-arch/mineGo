# REQ-00208: 玩家行为数据分析与用户画像系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00208 |
| 标题 | 玩家行为数据分析与用户画像系统 |
| 类别 | 数据治理/分析 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、backend/shared、backend/jobs、admin-dashboard |
| 创建时间 | 2026-06-14 19:10 |

## 需求描述

构建一套完整的玩家行为数据分析与用户画像系统，用于收集、存储、分析玩家在游戏中的各类行为数据，生成用户画像标签，为运营决策、个性化推荐、反作弊检测提供数据支撑。

### 核心目标
1. **行为数据采集**：记录玩家捕捉、战斗、社交、消费等核心行为
2. **用户画像生成**：基于行为数据自动生成玩家标签（大R、休闲玩家、竞技型等）
3. **行为趋势分析**：提供玩家活跃度、留存率、付费意愿等趋势分析
4. **个性化推荐基础**：为推荐系统提供用户偏好数据支撑

### 业务价值
- 提升运营决策效率，从数据驱动优化游戏体验
- 精准识别高价值用户，提升付费转化率
- 发现流失风险用户，提前干预挽回
- 为反作弊系统提供异常行为模式参考

## 技术方案

### 1. 行为数据采集模块

```javascript
// backend/shared/behaviorCollector.js
const { Kafka } = require('kafkajs');

class BehaviorCollector {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'behavior-collector',
      brokers: process.env.KAFKA_BROKERS.split(',')
    });
    this.producer = this.kafka.producer();
  }

  async init() {
    await this.producer.connect();
  }

  /**
   * 记录玩家行为事件
   * @param {string} userId - 用户ID
   * @param {string} eventType - 事件类型 (catch|battle|trade|purchase|social|explore)
   * @param {object} eventData - 事件详情
   */
  async track(userId, eventType, eventData) {
    const event = {
      userId,
      eventType,
      eventData,
      timestamp: Date.now(),
      sessionId: eventData.sessionId,
      deviceInfo: eventData.deviceInfo,
      geoInfo: eventData.geoInfo
    };

    await this.producer.send({
      topic: 'player-behavior-events',
      messages: [{
        key: `${userId}:${Date.now()}`,
        value: JSON.stringify(event),
        headers: {
          'event-type': eventType,
          'user-id': userId
        }
      }]
    });

    // 同时更新实时统计
    await this.updateRealtimeStats(userId, eventType);
  }

  /**
   * 更新实时统计 (Redis)
   */
  async updateRealtimeStats(userId, eventType) {
    const redis = require('./redis');
    const today = new Date().toISOString().split('T')[0];
    const hour = new Date().getHours();

    const pipeline = redis.pipeline();
    
    // 用户日活跃统计
    pipeline.sadd(`stats:daily:${today}:users`, userId);
    
    // 用户小时活跃统计
    pipeline.sadd(`stats:hourly:${today}:${hour}:users`, userId);
    
    // 事件类型计数
    pipeline.hincrby(`stats:daily:${today}:events`, eventType, 1);
    
    // 用户行为计数
    pipeline.hincrby(`user:behavior:${userId}:daily`, eventType, 1);
    pipeline.expire(`user:behavior:${userId}:daily`, 86400); // 24h 过期

    await pipeline.exec();
  }
}

// 支持的事件类型
const EVENT_TYPES = {
  CATCH: 'catch',           // 捕捉精灵
  BATTLE: 'battle',         // 战斗（道馆/PVP）
  TRADE: 'trade',           // 精灵交易
  PURCHASE: 'purchase',     // 付费购买
  SOCIAL: 'social',         // 社交互动（好友/公会）
  EXPLORE: 'explore',       // 地图探索
  LOGIN: 'login',           // 登录
  LOGOUT: 'logout',         // 登出
  ACHIEVEMENT: 'achievement', // 成就完成
  QUEST: 'quest'            // 任务完成
};

module.exports = { BehaviorCollector, EVENT_TYPES };
```

### 2. 用户画像计算引擎

```javascript
// backend/jobs/userProfileEngine.js
const { CronJob } = require('cron');
const { db } = require('../shared/db');
const redis = require('../shared/redis');
const logger = require('../shared/logger');

class UserProfileEngine {
  constructor() {
    this.labelRules = this.initLabelRules();
  }

  /**
   * 用户画像标签规则定义
   */
  initLabelRules() {
    return {
      // 消费能力标签
      'big_whale': {
        condition: (stats) => stats.totalSpent >= 10000,
        weight: 10
      },
      'medium_spender': {
        condition: (stats) => stats.totalSpent >= 1000 && stats.totalSpent < 10000,
        weight: 7
      },
      'light_spender': {
        condition: (stats) => stats.totalSpent >= 10 && stats.totalSpent < 1000,
        weight: 4
      },
      'free_player': {
        condition: (stats) => stats.totalSpent < 10,
        weight: 1
      },

      // 活跃度标签
      'daily_active': {
        condition: (stats) => stats.loginDays >= 28 && stats.recentActiveDays >= 7,
        weight: 8
      },
      'weekly_active': {
        condition: (stats) => stats.recentActiveDays >= 3 && stats.recentActiveDays < 7,
        weight: 5
      },
      'returning_player': {
        condition: (stats) => stats.daysSinceLastLogin > 7 && stats.daysSinceLastLogin <= 30,
        weight: 3
      },
      'churn_risk': {
        condition: (stats) => stats.daysSinceLastLogin > 30,
        weight: 2
      },

      // 玩法偏好标签
      'collector': {
        condition: (stats) => stats.uniquePokemonCount >= 100,
        weight: 6
      },
      'battler': {
        condition: (stats) => stats.battleWinRate >= 0.6 && stats.totalBattles >= 100,
        weight: 7
      },
      'social_butterfly': {
        condition: (stats) => stats.friendCount >= 50,
        weight: 5
      },
      'explorer': {
        condition: (stats) => stats.uniqueLocationsVisited >= 100,
        weight: 4
      },

      // 技能水平标签
      'elite_trainer': {
        condition: (stats) => stats.avgCatchRate >= 0.7 && stats.elitePokemonCount >= 10,
        weight: 9
      },
      'casual_player': {
        condition: (stats) => stats.avgSessionDuration < 30 && stats.loginDays >= 7,
        weight: 3
      }
    };
  }

  /**
   * 计算用户统计数据
   */
  async calculateUserStats(userId) {
    const client = await db.connect();
    try {
      // 基础统计数据查询
      const [
        spendingData,
        activityData,
        pokemonData,
        battleData,
        socialData
      ] = await Promise.all([
        this.getSpendingStats(userId, client),
        this.getActivityStats(userId, client),
        this.getPokemonStats(userId, client),
        this.getBattleStats(userId, client),
        this.getSocialStats(userId, client)
      ]);

      return {
        ...spendingData,
        ...activityData,
        ...pokemonData,
        ...battleData,
        ...socialData,
        lastUpdated: Date.now()
      };
    } finally {
      client.release();
    }
  }

  async getSpendingStats(userId, client) {
    const result = await client.query(`
      SELECT 
        COALESCE(SUM(amount), 0) as total_spent,
        COUNT(*) as purchase_count,
        COUNT(DISTINCT DATE(created_at)) as purchase_days
      FROM payment_orders
      WHERE user_id = $1 AND status = 'completed'
    `, [userId]);

    const row = result.rows[0];
    return {
      totalSpent: parseFloat(row.total_spent) || 0,
      purchaseCount: parseInt(row.purchase_count) || 0,
      purchaseDays: parseInt(row.purchase_days) || 0
    };
  }

  async getActivityStats(userId, client) {
    const result = await client.query(`
      SELECT 
        COUNT(DISTINCT DATE(created_at)) as login_days,
        MAX(created_at) as last_login,
        COUNT(*) as total_sessions,
        AVG(EXTRACT(EPOCH FROM (
          COALESCE(logout_time, created_at + INTERVAL '1 hour') - created_at
        )) / 60) as avg_session_minutes
      FROM user_sessions
      WHERE user_id = $1
    `, [userId]);

    const row = result.rows[0];
    const lastLogin = row.last_login ? new Date(row.last_login) : null;
    const daysSinceLastLogin = lastLogin 
      ? Math.floor((Date.now() - lastLogin.getTime()) / 86400000) 
      : 999;

    // 计算最近7天活跃天数
    const recentActiveResult = await client.query(`
      SELECT COUNT(DISTINCT DATE(created_at)) as recent_active_days
      FROM user_sessions
      WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
    `, [userId]);

    return {
      loginDays: parseInt(row.login_days) || 0,
      daysSinceLastLogin,
      totalSessions: parseInt(row.total_sessions) || 0,
      avgSessionDuration: parseFloat(row.avg_session_minutes) || 0,
      recentActiveDays: parseInt(recentActiveResult.rows[0].recent_active_days) || 0
    };
  }

  async getPokemonStats(userId, client) {
    const result = await client.query(`
      SELECT 
        COUNT(*) as total_pokemon,
        COUNT(DISTINCT species_id) as unique_species,
        COUNT(*) FILTER (WHERE iv_total >= 150) as elite_pokemon,
        AVG(iv_total) as avg_iv
      FROM user_pokemon
      WHERE user_id = $1
    `, [userId]);

    const row = result.rows[0];
    return {
      totalPokemon: parseInt(row.total_pokemon) || 0,
      uniquePokemonCount: parseInt(row.unique_species) || 0,
      elitePokemonCount: parseInt(row.elite_pokemon) || 0,
      avgIv: parseFloat(row.avg_iv) || 0
    };
  }

  async getBattleStats(userId, client) {
    const result = await client.query(`
      SELECT 
        COUNT(*) as total_battles,
        COUNT(*) FILTER (WHERE result = 'win') as wins,
        AVG(EXTRACT(EPOCH FROM duration) / 60) as avg_battle_duration
      FROM battle_history
      WHERE attacker_id = $1
    `, [userId]);

    const row = result.rows[0];
    const totalBattles = parseInt(row.total_battles) || 0;
    const wins = parseInt(row.wins) || 0;

    return {
      totalBattles,
      battleWins: wins,
      battleWinRate: totalBattles > 0 ? wins / totalBattles : 0,
      avgBattleDuration: parseFloat(row.avg_battle_duration) || 0
    };
  }

  async getSocialStats(userId, client) {
    const result = await client.query(`
      SELECT 
        (SELECT COUNT(*) FROM friendships WHERE user_id = $1 OR friend_id = $1) as friend_count,
        (SELECT COUNT(*) FROM guild_members WHERE user_id = $1) as guild_count,
        (SELECT COUNT(*) FROM trades WHERE initiator_id = $1 OR receiver_id = $1) as trade_count
    `, [userId]);

    const row = result.rows[0];
    return {
      friendCount: parseInt(row.friend_count) || 0,
      guildCount: parseInt(row.guild_count) || 0,
      tradeCount: parseInt(row.trade_count) || 0
    };
  }

  /**
   * 生成用户画像标签
   */
  async generateUserLabels(userId) {
    const stats = await this.calculateUserStats(userId);
    const labels = [];

    for (const [labelName, rule] of Object.entries(this.labelRules)) {
      try {
        if (rule.condition(stats)) {
          labels.push({
            name: labelName,
            weight: rule.weight,
            assignedAt: Date.now()
          });
        }
      } catch (err) {
        logger.error('Label rule evaluation failed', {
          userId,
          label: labelName,
          error: err.message
        });
      }
    }

    // 排序并保存
    labels.sort((a, b) => b.weight - a.weight);

    await this.saveUserLabels(userId, labels, stats);
    return labels;
  }

  async saveUserLabels(userId, labels, stats) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // 清除旧标签
      await client.query('DELETE FROM user_labels WHERE user_id = $1', [userId]);

      // 插入新标签
      for (const label of labels) {
        await client.query(`
          INSERT INTO user_labels (user_id, label_name, weight, assigned_at)
          VALUES ($1, $2, $3, $4)
        `, [userId, label.name, label.weight, new Date(label.assignedAt)]);
      }

      // 更新用户统计快照
      await client.query(`
        INSERT INTO user_profile_snapshots (user_id, stats, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE SET stats = $2, updated_at = NOW()
      `, [userId, JSON.stringify(stats)]);

      await client.query('COMMIT');

      // 缓存到 Redis
      await redis.setex(
        `user:profile:${userId}`,
        3600,
        JSON.stringify({ labels, stats })
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 定时任务：批量更新用户画像
   */
  startScheduledJob() {
    // 每小时更新活跃用户画像
    new CronJob('0 * * * *', async () => {
      await this.batchUpdateActiveUsers();
    }, null, true);

    // 每天凌晨更新所有用户画像
    new CronJob('0 2 * * *', async () => {
      await this.batchUpdateAllUsers();
    }, null, true);
  }

  async batchUpdateActiveUsers() {
    const result = await db.query(`
      SELECT DISTINCT user_id
      FROM user_sessions
      WHERE created_at >= NOW() - INTERVAL '1 day'
      LIMIT 1000
    `);

    for (const row of result.rows) {
      try {
        await this.generateUserLabels(row.user_id);
      } catch (err) {
        logger.error('Failed to update user profile', {
          userId: row.user_id,
          error: err.message
        });
      }
    }
  }
}

module.exports = { UserProfileEngine };
```

### 3. API 接口层

```javascript
// backend/services/user-service/src/routes/userProfile.js
const express = require('express');
const router = express.Router();
const { db } = require('../../../shared/db');
const redis = require('../../../shared/redis');
const logger = require('../../../shared/logger');

/**
 * GET /api/users/:id/profile
 * 获取用户画像
 */
router.get('/:id/profile', async (req, res) => {
  try {
    const userId = req.params.id;

    // 尝试从缓存读取
    const cached = await redis.get(`user:profile:${userId}`);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    // 从数据库读取
    const labelsResult = await db.query(`
      SELECT label_name, weight, assigned_at
      FROM user_labels
      WHERE user_id = $1
      ORDER BY weight DESC
    `, [userId]);

    const statsResult = await db.query(`
      SELECT stats, updated_at
      FROM user_profile_snapshots
      WHERE user_id = $1
    `, [userId]);

    const profile = {
      userId,
      labels: labelsResult.rows.map(row => ({
        name: row.label_name,
        weight: row.weight,
        assignedAt: row.assigned_at
      })),
      stats: statsResult.rows[0]?.stats || {},
      updatedAt: statsResult.rows[0]?.updated_at || null
    };

    // 缓存
    await redis.setex(`user:profile:${userId}`, 3600, JSON.stringify(profile));

    res.json(profile);
  } catch (err) {
    logger.error('Failed to get user profile', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/users/profiles/batch
 * 批量获取用户画像（用于运营分析）
 */
router.post('/profiles/batch', async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length > 100) {
      return res.status(400).json({ error: 'Invalid userIds (max 100)' });
    }

    const result = await db.query(`
      SELECT 
        ul.user_id,
        json_agg(json_build_object(
          'name', ul.label_name,
          'weight', ul.weight
        )) as labels
      FROM user_labels ul
      WHERE ul.user_id = ANY($1)
      GROUP BY ul.user_id
    `, [userIds]);

    const profiles = {};
    for (const row of result.rows) {
      profiles[row.user_id] = row.labels;
    }

    res.json({ profiles });
  } catch (err) {
    logger.error('Failed to batch get profiles', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/analytics/cohorts
 * 获取用户分群统计
 */
router.get('/analytics/cohorts', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        label_name,
        COUNT(*) as user_count,
        AVG(weight) as avg_weight
      FROM user_labels
      GROUP BY label_name
      ORDER BY user_count DESC
    `);

    res.json({
      cohorts: result.rows.map(row => ({
        label: row.label_name,
        userCount: parseInt(row.user_count),
        avgWeight: parseFloat(row.avg_weight)
      }))
    });
  } catch (err) {
    logger.error('Failed to get cohort analytics', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/analytics/retention
 * 获取留存率分析
 */
router.get('/analytics/retention', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await db.query(`
      WITH cohorts AS (
        SELECT 
          DATE(created_at) as cohort_date,
          user_id
        FROM user_sessions
        WHERE DATE(created_at) BETWEEN $1 AND $2
        GROUP BY DATE(created_at), user_id
      ),
      retention AS (
        SELECT 
          c.cohort_date,
          COUNT(DISTINCT c.user_id) as cohort_size,
          COUNT(DISTINCT CASE WHEN s.created_at >= c.cohort_date + INTERVAL '1 day' 
                               AND s.created_at < c.cohort_date + INTERVAL '2 days' 
                          THEN c.user_id END) as day1_retention,
          COUNT(DISTINCT CASE WHEN s.created_at >= c.cohort_date + INTERVAL '6 days' 
                               AND s.created_at < c.cohort_date + INTERVAL '7 days' 
                          THEN c.user_id END) as day7_retention,
          COUNT(DISTINCT CASE WHEN s.created_at >= c.cohort_date + INTERVAL '29 days' 
                               AND s.created_at < c.cohort_date + INTERVAL '30 days' 
                          THEN c.user_id END) as day30_retention
        FROM cohorts c
        LEFT JOIN user_sessions s ON s.user_id = c.user_id
        GROUP BY c.cohort_date
        ORDER BY c.cohort_date
      )
      SELECT * FROM retention
    `, [startDate, endDate]);

    res.json({
      retention: result.rows.map(row => ({
        date: row.cohort_date,
        cohortSize: parseInt(row.cohort_size),
        day1: parseFloat((row.day1_retention / row.cohort_size * 100).toFixed(2)),
        day7: parseFloat((row.day7_retention / row.cohort_size * 100).toFixed(2)),
        day30: parseFloat((row.day30_retention / row.cohort_size * 100).toFixed(2))
      }))
    });
  } catch (err) {
    logger.error('Failed to get retention analytics', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

### 4. 数据库迁移

```sql
-- database/migrations/025_create_user_profile_tables.sql

-- 用户画像标签表
CREATE TABLE user_labels (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_name VARCHAR(50) NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, label_name)
);

CREATE INDEX idx_user_labels_user ON user_labels(user_id);
CREATE INDEX idx_user_labels_name ON user_labels(label_name);
CREATE INDEX idx_user_labels_weight ON user_labels(weight);

-- 用户画像快照表
CREATE TABLE user_profile_snapshots (
  user_id VARCHAR(36) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stats JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 用户行为事件表（用于深度分析）
CREATE TABLE user_behavior_events (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}',
  session_id VARCHAR(100),
  device_info JSONB,
  geo_info JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- 创建分区（按月）
CREATE TABLE user_behavior_events_202606 PARTITION OF user_behavior_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE user_behavior_events_202607 PARTITION OF user_behavior_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX idx_behavior_events_user ON user_behavior_events(user_id);
CREATE INDEX idx_behavior_events_type ON user_behavior_events(event_type);
CREATE INDEX idx_behavior_events_created ON user_behavior_events(created_at);

-- 用户会话表
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  session_token VARCHAR(255) NOT NULL,
  device_id VARCHAR(255),
  ip_address VARCHAR(45),
  user_agent TEXT,
  logout_time TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON user_sessions(created_at);

-- 注释
COMMENT ON TABLE user_labels IS '用户画像标签表';
COMMENT ON TABLE user_profile_snapshots IS '用户统计数据快照';
COMMENT ON TABLE user_behavior_events IS '用户行为事件日志（分区表）';
```

### 5. 运营仪表板数据接口

```javascript
// backend/services/admin-dashboard/src/routes/behaviorAnalytics.js
const express = require('express');
const router = express.Router();
const { db } = require('../../../shared/db');
const redis = require('../../../shared/redis');

/**
 * GET /api/admin/behavior/dashboard
 * 运营数据看板
 */
router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // 并行查询各项指标
    const [
      dauResult,
      newUsersResult,
      revenueResult,
      engagementResult
    ] = await Promise.all([
      // DAU
      db.query(`
        SELECT COUNT(DISTINCT user_id) as dau
        FROM user_sessions
        WHERE DATE(created_at) = $1
      `, [today]),

      // 新用户
      db.query(`
        SELECT COUNT(*) as new_users
        FROM users
        WHERE DATE(created_at) = $1
      `, [today]),

      // 收入
      db.query(`
        SELECT COALESCE(SUM(amount), 0) as revenue
        FROM payment_orders
        WHERE DATE(created_at) = $1 AND status = 'completed'
      `, [today]),

      // 活跃度
      db.query(`
        SELECT 
          AVG(session_count) as avg_sessions,
          AVG(pokemon_caught) as avg_catches
        FROM (
          SELECT 
            user_id,
            COUNT(*) as session_count,
            (SELECT COUNT(*) FROM catches WHERE user_id = s.user_id AND DATE(created_at) = $1) as pokemon_caught
          FROM user_sessions s
          WHERE DATE(created_at) = $1
          GROUP BY user_id
        ) sub
      `, [today])
    ]);

    res.json({
      date: today,
      dau: parseInt(dauResult.rows[0].dau) || 0,
      newUsers: parseInt(newUsersResult.rows[0].new_users) || 0,
      revenue: parseFloat(revenueResult.rows[0].revenue) || 0,
      engagement: {
        avgSessions: parseFloat(engagementResult.rows[0].avg_sessions) || 0,
        avgCatches: parseFloat(engagementResult.rows[0].avg_catches) || 0
      }
    });
  } catch (err) {
    console.error('Dashboard query failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/behavior/funnels
 * 用户漏斗分析
 */
router.get('/funnels', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const result = await db.query(`
      WITH funnel AS (
        SELECT 
          COUNT(DISTINCT CASE WHEN event_type = 'login' THEN user_id END) as login_users,
          COUNT(DISTINCT CASE WHEN event_type = 'catch' THEN user_id END) as catch_users,
          COUNT(DISTINCT CASE WHEN event_type = 'battle' THEN user_id END) as battle_users,
          COUNT(DISTINCT CASE WHEN event_type = 'trade' THEN user_id END) as trade_users,
          COUNT(DISTINCT CASE WHEN event_type = 'purchase' THEN user_id END) as purchase_users
        FROM user_behavior_events
        WHERE DATE(created_at) BETWEEN $1 AND $2
      )
      SELECT 
        login_users,
        catch_users,
        ROUND(catch_users::NUMERIC / NULLIF(login_users, 0) * 100, 2) as catch_rate,
        battle_users,
        ROUND(battle_users::NUMERIC / NULLIF(login_users, 0) * 100, 2) as battle_rate,
        trade_users,
        ROUND(trade_users::NUMERIC / NULLIF(login_users, 0) * 100, 2) as trade_rate,
        purchase_users,
        ROUND(purchase_users::NUMERIC / NULLIF(login_users, 0) * 100, 2) as purchase_rate
      FROM funnel
    `, [startDate, endDate]);

    res.json({ funnel: result.rows[0] });
  } catch (err) {
    console.error('Funnel analysis failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 行为事件采集覆盖所有核心业务操作（捕捉、战斗、交易、购买、社交）
- [ ] 用户画像标签系统可正确识别至少 15 种用户类型
- [ ] 画像生成任务每小时自动更新活跃用户
- [ ] API 响应时间 < 200ms（95分位）
- [ ] 行为数据表支持按月分区，可存储 1 年以上数据
- [ ] 留存率分析 API 可计算次日、7日、30日留存
- [ ] 运营仪表板展示 DAU、新用户、收入等核心指标
- [ ] 用户分群统计支持按标签聚合

## 影响范围

- user-service：新增 profile 路由和 analytics 接口
- gateway：路由代理配置
- backend/shared：新增 behaviorCollector.js
- backend/jobs：新增 userProfileEngine.js
- database/migrations：新增用户画像相关表
- admin-dashboard：新增行为分析路由

## 参考

- [Kafka Event Streaming](https://kafka.apache.org/documentation/)
- [User Behavior Analytics Best Practices](https://amplitude.com/blog/user-behavior-analytics)
- [Cohort Analysis Guide](https://www.fullstory.com/blog/cohort-analysis/)
