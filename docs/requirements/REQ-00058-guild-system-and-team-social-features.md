# REQ-00058: 公会系统与团队社交功能

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00058 |
| 标题 | 公会系统与团队社交功能 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 19:00 |

## 需求描述

实现完整的公会系统，支持玩家创建和加入公会，进行团队协作、共享资源和参与公会活动。通过公会系统增强社交黏性，提升用户长期留存率。

### 核心功能

1. **公会管理**
   - 创建公会（消耗金币，设置名称、徽章、简介）
   - 加入方式（公开、申请、邀请码）
   - 公会等级系统（通过贡献升级）
   - 公会职位管理（会长、副会长、长老、成员）
   - 公会设置（公告、加入条件、最低等级要求）

2. **公会成员功能**
   - 成员列表与在线状态
   - 成员贡献统计
   - 公会贡献值系统
   - 成员权限管理
   - 成员招募与邀请

3. **公会资源**
   - 公会仓库（共享道具）
   - 公会资金（捐赠与使用）
   - 公会经验值（升级解锁福利）
   - 公会增益效果（捕捉加成、经验加成）

4. **公会活动**
   - 公会任务系统（每日/每周任务）
   - 公会战（公会PVP）
   - 公会Raid Boss
   - 公会排行榜竞赛
   - 公会礼物交换

5. **公会社交**
   - 公会聊天频道
   - 公会公告板
   - 公会活动日历
   - 成员位置共享（可选）
   - 公会战报与战绩

6. **公会特权**
   - 公会专属徽章与称号
   - 公会等级奖励
   - 公会商店折扣
   - 公会专属活动
   - 公会专属精灵（公会限定）

## 技术方案

### 1. 数据库设计

```sql
-- 公会主表
CREATE TABLE guilds (
    id SERIAL PRIMARY KEY,
    guild_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    badge_url VARCHAR(500),
    banner_url VARCHAR(500),
    
    -- 等级与经验
    level INTEGER DEFAULT 1,
    experience INTEGER DEFAULT 0,
    max_members INTEGER DEFAULT 50,
    
    -- 资源
    treasury INTEGER DEFAULT 0, -- 公会资金
    total_contribution INTEGER DEFAULT 0, -- 总贡献值
    
    -- 加入设置
    join_type VARCHAR(20) DEFAULT 'apply' CHECK (join_type IN ('public', 'apply', 'invite_only')),
    min_level INTEGER DEFAULT 5,
    min_pokedex_count INTEGER DEFAULT 0,
    application_form TEXT,
    
    -- 公会增益
    active_buffs JSONB DEFAULT '{}',
    buffs_expires_at JSONB DEFAULT '{}',
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'disbanded')),
    
    -- 统计数据
    total_battles_won INTEGER DEFAULT 0,
    total_raids_completed INTEGER DEFAULT 0,
    total_tasks_completed INTEGER DEFAULT 0,
    
    -- 时间戳
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    created_by INTEGER REFERENCES users(id),
    
    CONSTRAINT valid_level CHECK (level >= 1 AND level <= 50)
);

-- 公会成员表
CREATE TABLE guild_members (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 职位
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('leader', 'co_leader', 'elder', 'member', 'novice')),
    
    -- 贡献
    contribution INTEGER DEFAULT 0,
    weekly_contribution INTEGER DEFAULT 0,
    total_donated INTEGER DEFAULT 0,
    
    -- 统计
    battles_participated INTEGER DEFAULT 0,
    raids_participated INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,
    
    -- 权限
    permissions JSONB DEFAULT '{}',
    
    -- 时间
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_contribution_at TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(guild_id, user_id),
    UNIQUE(user_id) -- 一个用户只能加入一个公会
);

-- 公会申请表
CREATE TABLE guild_applications (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    
    application_text TEXT,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_note TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(guild_id, user_id)
);

-- 公会邀请表
CREATE TABLE guild_invitations (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id),
    invitee_id INTEGER NOT NULL REFERENCES users(id),
    
    invite_code VARCHAR(20) UNIQUE,
    
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    
    expires_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP,
    
    UNIQUE(guild_id, invitee_id)
);

-- 公会仓库表
CREATE TABLE guild_warehouse (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    item_type VARCHAR(50) NOT NULL,
    item_data JSONB NOT NULL,
    quantity INTEGER DEFAULT 1,
    
    donated_by INTEGER REFERENCES users(id),
    donated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 公会仓库领取记录
CREATE TABLE guild_warehouse_claims (
    id SERIAL PRIMARY KEY,
    warehouse_item_id INTEGER NOT NULL REFERENCES guild_warehouse(id) ON DELETE CASCADE,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    quantity INTEGER DEFAULT 1,
    
    claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 公会资金捐赠记录
CREATE TABLE guild_donations (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    donation_type VARCHAR(20) NOT NULL CHECK (donation_type IN ('coins', 'items', 'pokemon')),
    amount INTEGER NOT NULL,
    contribution_gained INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 公会任务表
CREATE TABLE guild_tasks (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    task_key VARCHAR(100) NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'donate', 'raid'
    
    requirement JSONB NOT NULL,
    rewards JSONB NOT NULL,
    
    -- 任务周期
    task_period VARCHAR(20) DEFAULT 'weekly' CHECK (task_period IN ('daily', 'weekly', 'monthly', 'special')),
    
    -- 进度
    current_progress INTEGER DEFAULT 0,
    target_progress INTEGER NOT NULL,
    
    -- 限制
    max_completions INTEGER DEFAULT 0, -- 0 = 无限
    contribution_reward INTEGER DEFAULT 0,
    
    -- 时间
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    
    is_completed BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(guild_id, task_key, task_period)
);

-- 用户公会任务完成记录
CREATE TABLE user_guild_tasks (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES guild_tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    
    progress INTEGER DEFAULT 0,
    completed_count INTEGER DEFAULT 0,
    
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(task_id, user_id)
);

-- 公会战表
CREATE TABLE guild_wars (
    id SERIAL PRIMARY KEY,
    attacking_guild_id INTEGER NOT NULL REFERENCES guilds(id),
    defending_guild_id INTEGER NOT NULL REFERENCES guilds(id),
    
    war_type VARCHAR(20) DEFAULT 'regular' CHECK (war_type IN ('regular', 'championship', 'friendly')),
    
    status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'preparation', 'active', 'completed', 'cancelled')),
    
    -- 准备期和战斗期
    preparation_starts_at TIMESTAMP,
    battle_starts_at TIMESTAMP,
    battle_ends_at TIMESTAMP,
    
    -- 结果
    winner_guild_id INTEGER REFERENCES guilds(id),
    attacking_score INTEGER DEFAULT 0,
    defending_score INTEGER DEFAULT 0,
    
    -- 战利品
    war_chest INTEGER DEFAULT 0,
    experience_reward INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);

-- 公会战参与记录
CREATE TABLE guild_war_participations (
    id SERIAL PRIMARY KEY,
    war_id INTEGER NOT NULL REFERENCES guild_wars(id) ON DELETE CASCADE,
    guild_id INTEGER NOT NULL REFERENCES guilds(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    
    battles_won INTEGER DEFAULT 0,
    battles_lost INTEGER DEFAULT 0,
    stars_earned INTEGER DEFAULT 0,
    
    contribution_score INTEGER DEFAULT 0,
    
    UNIQUE(war_id, user_id)
);

-- 公会排行榜
CREATE TABLE guild_leaderboard (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER UNIQUE NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    
    leaderboard_type VARCHAR(20) NOT NULL CHECK (leaderboard_type IN ('global', 'regional', 'contribution', 'war')),
    
    score INTEGER DEFAULT 0,
    rank INTEGER,
    
    period VARCHAR(20) DEFAULT 'all_time' CHECK (period IN ('daily', 'weekly', 'monthly', 'all_time')),
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 公会增益效果表
CREATE TABLE guild_buffs (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    buff_type VARCHAR(50) NOT NULL,
    
    buff_value DECIMAL(10, 2) NOT NULL,
    duration_hours INTEGER NOT NULL,
    
    activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    
    cost INTEGER NOT NULL, -- 消耗的公会资金
    
    UNIQUE(guild_id, buff_type)
);

-- 公会聊天消息表（简化版，实际可能用Redis或消息队列）
CREATE TABLE guild_chat_messages (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'announcement')),
    
    content TEXT NOT NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 公会公告表
CREATE TABLE guild_announcements (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    
    is_pinned BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_guilds_level ON guilds(level DESC);
CREATE INDEX idx_guilds_status ON guilds(status);
CREATE INDEX idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX idx_guild_members_user ON guild_members(user_id);
CREATE INDEX idx_guild_members_contribution ON guild_members(guild_id, contribution DESC);
CREATE INDEX idx_guild_applications_status ON guild_applications(guild_id, status);
CREATE INDEX idx_guild_tasks_guild ON guild_tasks(guild_id, task_period);
CREATE INDEX idx_guild_wars_status ON guild_wars(status);
CREATE INDEX idx_guild_chat_guild_time ON guild_chat_messages(guild_id, created_at DESC);
CREATE INDEX idx_guild_leaderboard_rank ON guild_leaderboard(leaderboard_type, rank);
```

### 2. 后端服务实现

#### social-service/src/guildService.js

```javascript
const { db } = require('../shared/db');
const { EventBus, EVENTS } = require('../shared/EventBus');
const { v4: uuidv4 } = require('uuid');

class GuildService {
  constructor() {
    this.GUILD_LEVEL_CONFIG = this.loadGuildLevelConfig();
    this.MAX_MEMBERS_BASE = 50;
    this.MEMBER_PER_LEVEL = 2;
  }

  /**
   * 加载公会等级配置
   */
  loadGuildLevelConfig() {
    const config = {};
    for (let level = 1; level <= 50; level++) {
      config[level] = {
        experienceRequired: level * level * 1000,
        maxMembers: this.MAX_MEMBERS_BASE + (level - 1) * this.MEMBER_PER_LEVEL,
        buffs: this.getAvailableBuffs(level)
      };
    }
    return config;
  }

  /**
   * 获取可用增益
   */
  getAvailableBuffs(level) {
    const buffs = [];
    if (level >= 5) buffs.push('catch_bonus_5');
    if (level >= 10) buffs.push('experience_bonus_10');
    if (level >= 15) buffs.push('stardust_bonus_15');
    if (level >= 20) buffs.push('raid_bonus_20');
    if (level >= 30) buffs.push('shiny_bonus_30');
    return buffs;
  }

  /**
   * 创建公会
   */
  async createGuild(userId, guildData) {
    const { name, description, badgeUrl, joinType, minLevel, minPokedexCount } = guildData;

    // 检查用户是否已有公会
    const existingGuild = await db.query(
      'SELECT 1 FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (existingGuild.rows.length > 0) {
      throw new Error('User already in a guild');
    }

    // 检查公会名是否已存在
    const existingName = await db.query(
      'SELECT 1 FROM guilds WHERE name = $1',
      [name]
    );

    if (existingName.rows.length > 0) {
      throw new Error('Guild name already taken');
    }

    // 生成公会Key
    const guildKey = `GUILD-${uuidv4().substring(0, 8).toUpperCase()}`;

    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 扣除创建费用（5000金币）
      const deductResult = await client.query(`
        UPDATE users 
        SET coins = coins - 5000 
        WHERE id = $1 AND coins >= 5000
        RETURNING coins
      `, [userId]);

      if (deductResult.rows.length === 0) {
        throw new Error('Insufficient coins to create guild');
      }

      // 创建公会
      const guildResult = await client.query(`
        INSERT INTO guilds 
          (guild_key, name, description, badge_url, join_type, min_level, min_pokedex_count, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [guildKey, name, description, badgeUrl, joinType, minLevel, minPokedexCount, userId]);

      const guild = guildResult.rows[0];

      // 添加创建者为会长
      await client.query(`
        INSERT INTO guild_members 
          (guild_id, user_id, role, contribution)
        VALUES ($1, $2, 'leader', 100)
      `, [guild.id, userId]);

      // 创建初始公会任务
      await this.createWeeklyGuildTasks(guild.id, client);

      await client.query('COMMIT');

      // 发布事件
      await EventBus.publish(EVENTS.GUILD_CREATED, {
        guildId: guild.id,
        guildKey: guild.guild_key,
        leaderId: userId,
        name: guild.name,
        timestamp: new Date()
      });

      return guild;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 加入公会
   */
  async joinGuild(userId, guildId, applicationText = null) {
    // 检查用户是否已有公会
    const existingGuild = await db.query(
      'SELECT 1 FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (existingGuild.rows.length > 0) {
      throw new Error('User already in a guild');
    }

    const guild = await this.getGuild(guildId);

    if (!guild || guild.status !== 'active') {
      throw new Error('Guild not found or inactive');
    }

    // 检查公会是否已满
    const memberCount = await this.getMemberCount(guildId);
    if (memberCount >= guild.max_members) {
      throw new Error('Guild is full');
    }

    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

    // 检查等级要求
    if (user.rows[0].level < guild.min_level) {
      throw new Error(`Minimum level ${guild.min_level} required`);
    }

    // 根据加入方式处理
    if (guild.join_type === 'public') {
      return await this.directJoinGuild(userId, guildId);
    } else if (guild.join_type === 'apply') {
      return await this.applyToGuild(userId, guildId, applicationText);
    } else {
      throw new Error('This guild requires an invitation');
    }
  }

  /**
   * 直接加入公会
   */
  async directJoinGuild(userId, guildId) {
    const result = await db.query(`
      INSERT INTO guild_members (guild_id, user_id, role)
      VALUES ($1, $2, 'novice')
      RETURNING *
    `, [guildId, userId]);

    // 更新公会活跃度
    await db.query(
      'UPDATE guilds SET last_active_at = CURRENT_TIMESTAMP WHERE id = $1',
      [guildId]
    );

    await EventBus.publish(EVENTS.GUILD_MEMBER_JOINED, {
      guildId,
      userId,
      timestamp: new Date()
    });

    return result.rows[0];
  }

  /**
   * 申请加入公会
   */
  async applyToGuild(userId, guildId, applicationText) {
    const existing = await db.query(`
      SELECT 1 FROM guild_applications 
      WHERE guild_id = $1 AND user_id = $2 AND status = 'pending'
    `, [guildId, userId]);

    if (existing.rows.length > 0) {
      throw new Error('Application already pending');
    }

    const result = await db.query(`
      INSERT INTO guild_applications (guild_id, user_id, application_text)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [guildId, userId, applicationText]);

    await EventBus.publish(EVENTS.GUILD_APPLICATION_SUBMITTED, {
      guildId,
      userId,
      timestamp: new Date()
    });

    return result.rows[0];
  }

  /**
   * 审批公会申请
   */
  async reviewApplication(applicationId, reviewerId, approved, note = null) {
    // 检查审批人权限
    const reviewerRole = await this.getMemberRole(reviewerId);
    if (!['leader', 'co_leader'].includes(reviewerRole)) {
      throw new Error('Insufficient permissions');
    }

    const application = await db.query(
      'SELECT * FROM guild_applications WHERE id = $1',
      [applicationId]
    );

    if (application.rows.length === 0) {
      throw new Error('Application not found');
    }

    const status = approved ? 'approved' : 'rejected';

    await db.query(`
      UPDATE guild_applications
      SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_note = $3
      WHERE id = $4
    `, [status, reviewerId, note, applicationId]);

    if (approved) {
      await this.directJoinGuild(application.rows[0].user_id, application.rows[0].guild_id);
    }

    await EventBus.publish(EVENTS.GUILD_APPLICATION_REVIEWED, {
      applicationId,
      guildId: application.rows[0].guild_id,
      userId: application.rows[0].user_id,
      approved,
      reviewerId,
      timestamp: new Date()
    });

    return { success: true, status };
  }

  /**
   * 离开公会
   */
  async leaveGuild(userId) {
    const member = await db.query(`
      SELECT * FROM guild_members WHERE user_id = $1
    `, [userId]);

    if (member.rows.length === 0) {
      throw new Error('User not in a guild');
    }

    const guildMember = member.rows[0];

    // 检查是否是会长
    if (guildMember.role === 'leader') {
      // 检查是否还有其他成员
      const otherMembers = await db.query(`
        SELECT COUNT(*) as count FROM guild_members 
        WHERE guild_id = $1 AND user_id != $2
      `, [guildMember.guild_id, userId]);

      if (parseInt(otherMembers.rows[0].count) > 0) {
        throw new Error('Leader must transfer leadership or disband guild first');
      }

      // 解散公会
      await this.disbandGuild(guildMember.guild_id, userId);
    } else {
      await db.query('DELETE FROM guild_members WHERE user_id = $1', [userId]);

      await EventBus.publish(EVENTS.GUILD_MEMBER_LEFT, {
        guildId: guildMember.guild_id,
        userId,
        timestamp: new Date()
      });
    }

    return { success: true };
  }

  /**
   * 解散公会
   */
  async disbandGuild(guildId, userId) {
    const role = await this.getMemberRole(userId);
    if (role !== 'leader') {
      throw new Error('Only leader can disband guild');
    }

    await db.query('UPDATE guilds SET status = $1 WHERE id = $2', ['disbanded', guildId]);

    await db.query('DELETE FROM guild_members WHERE guild_id = $1', [guildId]);

    await EventBus.publish(EVENTS.GUILD_DISBANDED, {
      guildId,
      userId,
      timestamp: new Date()
    });
  }

  /**
   * 转让会长
   */
  async transferLeadership(guildId, currentLeaderId, newLeaderId) {
    const currentRole = await this.getMemberRole(currentLeaderId);
    if (currentRole !== 'leader') {
      throw new Error('Only leader can transfer leadership');
    }

    const newLeaderRole = await this.getMemberRole(newLeaderId);
    if (!newLeaderRole) {
      throw new Error('New leader not in guild');
    }

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 降级当前会长为副会长
      await client.query(`
        UPDATE guild_members SET role = 'co_leader' 
        WHERE guild_id = $1 AND user_id = $2
      `, [guildId, currentLeaderId]);

      // 升级新会长
      await client.query(`
        UPDATE guild_members SET role = 'leader' 
        WHERE guild_id = $1 AND user_id = $2
      `, [guildId, newLeaderId]);

      // 更新公会创建者
      await client.query(`
        UPDATE guilds SET created_by = $1 WHERE id = $2
      `, [newLeaderId, guildId]);

      await client.query('COMMIT');

      await EventBus.publish(EVENTS.GUILD_LEADERSHIP_TRANSFERRED, {
        guildId,
        oldLeaderId: currentLeaderId,
        newLeaderId,
        timestamp: new Date()
      });

      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 设置成员职位
   */
  async setMemberRole(guildId, adminId, memberId, newRole) {
    const adminRole = await this.getMemberRole(adminId);
    if (!['leader', 'co_leader'].includes(adminRole)) {
      throw new Error('Insufficient permissions');
    }

    const validRoles = ['co_leader', 'elder', 'member', 'novice'];
    if (!validRoles.includes(newRole)) {
      throw new Error('Invalid role');
    }

    await db.query(`
      UPDATE guild_members SET role = $1 
      WHERE guild_id = $2 AND user_id = $3
    `, [newRole, guildId, memberId]);

    return { success: true };
  }

  /**
   * 捐赠公会资金
   */
  async donateToGuild(userId, guildId, amount) {
    const member = await this.getMemberByUserId(userId);
    if (!member) {
      throw new Error('User not in a guild');
    }

    if (member.guild_id !== guildId) {
      throw new Error('User not in this guild');
    }

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 扣除用户金币
      const deductResult = await client.query(`
        UPDATE users 
        SET coins = coins - $1 
        WHERE id = $2 AND coins >= $1
        RETURNING coins
      `, [amount, userId]);

      if (deductResult.rows.length === 0) {
        throw new Error('Insufficient coins');
      }

      // 增加公会资金
      await client.query(`
        UPDATE guilds 
        SET treasury = treasury + $1, total_contribution = total_contribution + $1
        WHERE id = $2
      `, [amount, guildId]);

      // 记录捐赠
      await client.query(`
        INSERT INTO guild_donations (guild_id, user_id, donation_type, amount, contribution_gained)
        VALUES ($1, $2, 'coins', $3, $4)
      `, [guildId, userId, amount, Math.floor(amount / 10)]);

      // 增加用户贡献值
      await client.query(`
        UPDATE guild_members 
        SET contribution = contribution + $1, 
            weekly_contribution = weekly_contribution + $1,
            total_donated = total_donated + $2,
            last_contribution_at = CURRENT_TIMESTAMP
        WHERE guild_id = $3 AND user_id = $4
      `, [Math.floor(amount / 10), amount, guildId, userId]);

      // 增加公会经验
      await this.addGuildExperience(guildId, Math.floor(amount / 100), client);

      await client.query('COMMIT');

      await EventBus.publish(EVENTS.GUILD_DONATION, {
        guildId,
        userId,
        amount,
        contributionGained: Math.floor(amount / 10),
        timestamp: new Date()
      });

      return { success: true, contributionGained: Math.floor(amount / 10) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 激活公会增益
   */
  async activateBuff(guildId, userId, buffType) {
    const role = await this.getMemberRole(userId);
    if (!['leader', 'co_leader'].includes(role)) {
      throw new Error('Insufficient permissions');
    }

    const guild = await this.getGuild(guildId);
    
    // 检查公会等级是否解锁该增益
    const availableBuffs = this.getAvailableBuffs(guild.level);
    if (!availableBuffs.includes(buffType)) {
      throw new Error('Buff not unlocked for this guild level');
    }

    // 增益配置
    const buffConfigs = {
      'catch_bonus_5': { value: 0.05, duration: 24, cost: 1000 },
      'experience_bonus_10': { value: 0.10, duration: 24, cost: 2000 },
      'stardust_bonus_15': { value: 0.15, duration: 24, cost: 3000 },
      'raid_bonus_20': { value: 0.20, duration: 24, cost: 4000 },
      'shiny_bonus_30': { value: 0.10, duration: 12, cost: 10000 }
    };

    const config = buffConfigs[buffType];
    if (!config) {
      throw new Error('Invalid buff type');
    }

    if (guild.treasury < config.cost) {
      throw new Error('Insufficient guild treasury');
    }

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 扣除公会资金
      await client.query(
        'UPDATE guilds SET treasury = treasury - $1 WHERE id = $2',
        [config.cost, guildId]
      );

      // 激活增益
      const expiresAt = new Date(Date.now() + config.duration * 60 * 60 * 1000);
      await client.query(`
        INSERT INTO guild_buffs (guild_id, buff_type, buff_value, duration_hours, expires_at, cost)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (guild_id, buff_type)
        DO UPDATE SET 
          buff_value = EXCLUDED.buff_value,
          expires_at = EXCLUDED.expires_at,
          activated_at = CURRENT_TIMESTAMP,
          cost = EXCLUDED.cost
      `, [guildId, buffType, config.value, config.duration, expiresAt, config.cost]);

      await client.query('COMMIT');

      await EventBus.publish(EVENTS.GUILD_BUFF_ACTIVATED, {
        guildId,
        buffType,
        buffValue: config.value,
        duration: config.duration,
        cost: config.cost,
        timestamp: new Date()
      });

      return {
        success: true,
        buff: buffType,
        value: config.value,
        expiresAt
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取公会活跃增益
   */
  async getActiveBuffs(guildId) {
    const result = await db.query(`
      SELECT * FROM guild_buffs
      WHERE guild_id = $1 AND expires_at > CURRENT_TIMESTAMP
    `, [guildId]);

    return result.rows;
  }

  /**
   * 增加公会经验
   */
  async addGuildExperience(guildId, amount, client = db) {
    const guild = await this.getGuild(guildId);
    const newExperience = guild.experience + amount;
    const levelConfig = this.GUILD_LEVEL_CONFIG[guild.level];

    if (newExperience >= levelConfig.experienceRequired && guild.level < 50) {
      // 升级
      const newLevel = guild.level + 1;
      await client.query(`
        UPDATE guilds 
        SET level = $1, experience = $2, max_members = $3
        WHERE id = $4
      `, [newLevel, newExperience - levelConfig.experienceRequired, 
          this.GUILD_LEVEL_CONFIG[newLevel].maxMembers, guildId]);

      await EventBus.publish(EVENTS.GUILD_LEVEL_UP, {
        guildId,
        newLevel,
        timestamp: new Date()
      });
    } else {
      await client.query(
        'UPDATE guilds SET experience = $1 WHERE id = $2',
        [newExperience, guildId]
      );
    }
  }

  /**
   * 创建每周公会任务
   */
  async createWeeklyGuildTasks(guildId, client = db) {
    const tasks = [
      {
        taskKey: 'weekly_catch',
        title: '公会捕捉挑战',
        taskType: 'catch',
        requirement: { target: 500 },
        targetProgress: 500,
        rewards: { coins: 5000, experience: 1000 },
        contributionReward: 50
      },
      {
        taskKey: 'weekly_battle',
        title: '公会战斗挑战',
        taskType: 'battle',
        requirement: { target: 100 },
        targetProgress: 100,
        rewards: { coins: 3000, experience: 500 },
        contributionReward: 30
      },
      {
        taskKey: 'weekly_donation',
        title: '公会捐赠目标',
        taskType: 'donate',
        requirement: { target: 10000 },
        targetProgress: 10000,
        rewards: { coins: 2000, experience: 300 },
        contributionReward: 20
      }
    ];

    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    for (const task of tasks) {
      await client.query(`
        INSERT INTO guild_tasks
          (guild_id, task_key, title, task_type, requirement, rewards, 
           target_progress, contribution_reward, starts_at, ends_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [guildId, task.taskKey, task.title, task.taskType, 
          JSON.stringify(task.requirement), JSON.stringify(task.rewards),
          task.targetProgress, task.contributionReward, weekStart, weekEnd]);
    }
  }

  /**
   * 获取公会信息
   */
  async getGuild(guildId) {
    const result = await db.query('SELECT * FROM guilds WHERE id = $1', [guildId]);
    return result.rows[0];
  }

  /**
   * 获取公会成员列表
   */
  async getGuildMembers(guildId, limit = 50, offset = 0) {
    const result = await db.query(`
      SELECT gm.*, u.username, u.avatar, u.level
      FROM guild_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.guild_id = $1
      ORDER BY 
        CASE gm.role
          WHEN 'leader' THEN 1
          WHEN 'co_leader' THEN 2
          WHEN 'elder' THEN 3
          WHEN 'member' THEN 4
          WHEN 'novice' THEN 5
        END,
        gm.contribution DESC
      LIMIT $2 OFFSET $3
    `, [guildId, limit, offset]);

    return result.rows;
  }

  /**
   * 获取成员数量
   */
  async getMemberCount(guildId) {
    const result = await db.query(
      'SELECT COUNT(*) FROM guild_members WHERE guild_id = $1',
      [guildId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * 获取用户成员信息
   */
  async getMemberByUserId(userId) {
    const result = await db.query(
      'SELECT * FROM guild_members WHERE user_id = $1',
      [userId]
    );
    return result.rows[0];
  }

  /**
   * 获取成员角色
   */
  async getMemberRole(userId) {
    const member = await this.getMemberByUserId(userId);
    return member ? member.role : null;
  }

  /**
   * 搜索公会
   */
  async searchGuilds(filters = {}) {
    let query = 'SELECT * FROM guilds WHERE status = $1';
    const values = ['active'];
    let paramCount = 2;

    if (filters.name) {
      query += ` AND name ILIKE $${paramCount}`;
      values.push(`%${filters.name}%`);
      paramCount++;
    }

    if (filters.minLevel) {
      query += ` AND level >= $${paramCount}`;
      values.push(filters.minLevel);
      paramCount++;
    }

    if (filters.joinType) {
      query += ` AND join_type = $${paramCount}`;
      values.push(filters.joinType);
      paramCount++;
    }

    query += ' ORDER BY level DESC, total_contribution DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramCount}`;
      values.push(filters.limit);
    }

    const result = await db.query(query, values);
    return result.rows;
  }

  /**
   * 获取公会排行榜
   */
  async getGuildLeaderboard(leaderboardType = 'global', limit = 100) {
    const result = await db.query(`
      SELECT 
        g.id, g.name, g.level, g.guild_key, g.badge_url,
        gl.score, gl.rank
      FROM guild_leaderboard gl
      JOIN guilds g ON gl.guild_id = g.id
      WHERE gl.leaderboard_type = $1 AND gl.period = 'all_time'
      ORDER BY gl.rank
      LIMIT $2
    `, [leaderboardType, limit]);

    return result.rows;
  }

  /**
   * 发送公会聊天消息
   */
  async sendChatMessage(guildId, userId, content) {
    const member = await this.getMemberByUserId(userId);
    if (!member || member.guild_id !== guildId) {
      throw new Error('User not in this guild');
    }

    const result = await db.query(`
      INSERT INTO guild_chat_messages (guild_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [guildId, userId, content]);

    // 发布聊天事件（用于WebSocket推送）
    await EventBus.publish(EVENTS.GUILD_CHAT_MESSAGE, {
      guildId,
      userId,
      messageId: result.rows[0].id,
      content,
      timestamp: new Date()
    });

    return result.rows[0];
  }

  /**
   * 获取公会聊天历史
   */
  async getChatHistory(guildId, limit = 100, beforeId = null) {
    let query = `
      SELECT 
        m.id, m.content, m.message_type, m.created_at,
        u.id as user_id, u.username, u.avatar
      FROM guild_chat_messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.guild_id = $1
    `;
    const values = [guildId];
    let paramCount = 2;

    if (beforeId) {
      query += ` AND m.id < $${paramCount}`;
      values.push(beforeId);
      paramCount++;
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
    values.push(limit);

    const result = await db.query(query, values);
    return result.rows.reverse();
  }
}

module.exports = new GuildService();
