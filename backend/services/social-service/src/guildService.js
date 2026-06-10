/**
 * 公会服务 - REQ-00058
 * 
 * 核心功能：
 * 1. 公会管理（创建、解散、转让）
 * 2. 成员管理（加入、退出、职位）
 * 3. 公会资源（捐赠、仓库、增益）
 * 4. 公会任务系统
 * 5. 公会排行榜
 */

const { query, getClient } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { v4: uuidv4 } = require('uuid');
const metrics = require('../../../shared/metrics');

const logger = createLogger('guild-service');

class GuildService {
  constructor() {
    // 公会等级配置
    this.GUILD_LEVEL_CONFIG = this.loadGuildLevelConfig();
    this.MAX_MEMBERS_BASE = 50;
    this.MEMBER_PER_LEVEL = 2;
    this.CREATE_COST = 5000; // 创建公会费用
    this.MAX_FRIENDS = 200;
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
    const { name, description = '', badgeUrl, joinType = 'apply', minLevel = 5, minPokedexCount = 0 } = guildData;

    // 验证公会名
    if (!name || name.length < 2 || name.length > 100) {
      throw new Error('公会名称长度必须在 2-100 字符之间');
    }

    // 检查用户是否已有公会
    const existingGuild = await query(
      'SELECT 1 FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (existingGuild.rows.length > 0) {
      throw new Error('你已经加入了一个公会，无法创建新公会');
    }

    // 检查公会名是否已存在
    const existingName = await query(
      'SELECT 1 FROM guilds WHERE name = $1',
      [name]
    );

    if (existingName.rows.length > 0) {
      throw new Error('公会名称已被使用');
    }

    // 生成公会 Key
    const guildKey = `GUILD-${uuidv4().substring(0, 8).toUpperCase()}`;

    // 生成邀请码
    const inviteCode = uuidv4().substring(0, 8).toUpperCase();

    const client = await getClient();
    
    try {
      await client.query('BEGIN');

      // 扣除创建费用
      const deductResult = await client.query(`
        UPDATE users 
        SET coins = coins - $1 
        WHERE id = $2 AND coins >= $1
        RETURNING coins
      `, [this.CREATE_COST, userId]);

      if (deductResult.rows.length === 0) {
        throw new Error(`金币不足，创建公会需要 ${this.CREATE_COST} 金币`);
      }

      // 创建公会
      const guildResult = await client.query(`
        INSERT INTO guilds 
          (guild_key, name, description, badge_url, join_type, min_level, min_pokedex_count, created_by, invite_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [guildKey, name, description, badgeUrl, joinType, minLevel, minPokedexCount, userId, inviteCode]);

      const guild = guildResult.rows[0];

      // 添加创建者为会长
      await client.query(`
        INSERT INTO guild_members 
          (guild_id, user_id, role, contribution)
        VALUES ($1, $2, 'leader', 100)
      `, [guild.id, userId]);

      // 创建初始公会任务
      await this.createInitialGuildTasks(guild.id, client);

      // 初始化公会排行榜
      await client.query(`
        INSERT INTO guild_leaderboard (guild_id, leaderboard_type, score, period)
        VALUES ($1, 'global', 0, 'all_time')
      `, [guild.id]);

      await client.query('COMMIT');

      logger.info({ guildId: guild.id, userId }, '公会创建成功');
      metrics.guildCreationsTotal?.inc({ join_type: joinType });

      return guild;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 创建初始公会任务
   */
  async createInitialGuildTasks(guildId, client) {
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
   * 加入公会
   */
  async joinGuild(userId, guildIdOrKey, applicationText = null) {
    // 检查用户是否已有公会
    const existingGuild = await query(
      'SELECT 1 FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (existingGuild.rows.length > 0) {
      throw new Error('你已经加入了一个公会');
    }

    // 查找公会（支持 ID 或 Key）
    const guildResult = await query(`
      SELECT * FROM guilds 
      WHERE (id = $1 OR guild_key = $1) AND status = 'active'
    `, [guildIdOrKey]);

    if (guildResult.rows.length === 0) {
      throw new Error('公会不存在或已解散');
    }

    const guild = guildResult.rows[0];

    // 检查公会是否已满
    const memberCount = await this.getMemberCount(guild.id);
    if (memberCount >= guild.max_members) {
      throw new Error('公会成员已满');
    }

    // 获取用户信息
    const userResult = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    if (!user) {
      throw new Error('用户不存在');
    }

    // 检查等级要求
    if (user.level < guild.min_level) {
      throw new Error(`加入该公会需要达到 ${guild.min_level} 级`);
    }

    // 根据加入方式处理
    if (guild.join_type === 'public') {
      return await this.directJoinGuild(userId, guild.id);
    } else if (guild.join_type === 'apply') {
      return await this.applyToGuild(userId, guild.id, applicationText);
    } else if (guild.join_type === 'invite_only') {
      // 检查是否有有效邀请
      const invite = await query(`
        SELECT * FROM guild_invitations 
        WHERE guild_id = $1 AND invitee_id = $2 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
      `, [guild.id, userId]);

      if (invite.rows.length === 0) {
        throw new Error('该公会仅限邀请加入');
      }

      return await this.acceptInvitation(invite.rows[0].id);
    }

    throw new Error('未知的加入方式');
  }

  /**
   * 直接加入公会
   */
  async directJoinGuild(userId, guildId) {
    const result = await query(`
      INSERT INTO guild_members (guild_id, user_id, role)
      VALUES ($1, $2, 'novice')
      RETURNING *
    `, [guildId, userId]);

    // 更新公会活跃度
    await query(
      'UPDATE guilds SET last_active_at = CURRENT_TIMESTAMP WHERE id = $1',
      [guildId]
    );

    logger.info({ userId, guildId }, '用户加入公会成功');
    metrics.guildJoinsTotal?.inc({ join_type: 'public' });

    return result.rows[0];
  }

  /**
   * 申请加入公会
   */
  async applyToGuild(userId, guildId, applicationText = null) {
    // 检查是否已有待处理的申请
    const existing = await query(`
      SELECT 1 FROM guild_applications 
      WHERE guild_id = $1 AND user_id = $2 AND status = 'pending'
    `, [guildId, userId]);

    if (existing.rows.length > 0) {
      throw new Error('你已提交过申请，请等待审核');
    }

    const result = await query(`
      INSERT INTO guild_applications (guild_id, user_id, application_text)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [guildId, userId, applicationText]);

    logger.info({ userId, guildId, applicationId: result.rows[0].id }, '公会申请已提交');
    metrics.guildApplicationsTotal?.inc();

    return result.rows[0];
  }

  /**
   * 审批公会申请
   */
  async reviewApplication(applicationId, reviewerId, approved, note = null) {
    // 检查审批人权限
    const reviewerRole = await this.getMemberRole(reviewerId);
    if (!['leader', 'co_leader'].includes(reviewerRole)) {
      throw new Error('只有会长或副会长可以审批申请');
    }

    const applicationResult = await query(
      'SELECT * FROM guild_applications WHERE id = $1',
      [applicationId]
    );

    if (applicationResult.rows.length === 0) {
      throw new Error('申请不存在');
    }

    const application = applicationResult.rows[0];

    if (application.status !== 'pending') {
      throw new Error('该申请已处理');
    }

    const status = approved ? 'approved' : 'rejected';

    await query(`
      UPDATE guild_applications
      SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_note = $3
      WHERE id = $4
    `, [status, reviewerId, note, applicationId]);

    if (approved) {
      // 检查公会是否已满
      const memberCount = await this.getMemberCount(application.guild_id);
      const guild = await this.getGuild(application.guild_id);
      
      if (memberCount >= guild.max_members) {
        throw new Error('公会成员已满，无法批准申请');
      }

      await this.directJoinGuild(application.user_id, application.guild_id);
    }

    logger.info({ applicationId, reviewerId, approved }, '公会申请已审核');
    metrics.guildApplicationReviewsTotal?.inc({ result: approved ? 'approved' : 'rejected' });

    return { success: true, status };
  }

  /**
   * 离开公会
   */
  async leaveGuild(userId) {
    const member = await query(
      'SELECT * FROM guild_members WHERE user_id = $1',
      [userId]
    );

    if (member.rows.length === 0) {
      throw new Error('你未加入任何公会');
    }

    const guildMember = member.rows[0];

    // 检查是否是会长
    if (guildMember.role === 'leader') {
      // 检查是否还有其他成员
      const otherMembers = await query(`
        SELECT COUNT(*) as count FROM guild_members 
        WHERE guild_id = $1 AND user_id != $2
      `, [guildMember.guild_id, userId]);

      if (parseInt(otherMembers.rows[0].count) > 0) {
        throw new Error('会长必须先转让职位或解散公会');
      }

      // 解散公会
      return await this.disbandGuild(guildMember.guild_id, userId);
    }

    // 普通成员离开
    await query('DELETE FROM guild_members WHERE user_id = $1', [userId]);

    logger.info({ userId, guildId: guildMember.guild_id }, '成员离开公会');
    metrics.guildMemberLeavesTotal?.inc();

    return { success: true };
  }

  /**
   * 解散公会
   */
  async disbandGuild(guildId, userId) {
    const role = await this.getMemberRole(userId);
    if (role !== 'leader') {
      throw new Error('只有会长可以解散公会');
    }

    await query('UPDATE guilds SET status = $1 WHERE id = $2', ['disbanded', guildId]);
    await query('DELETE FROM guild_members WHERE guild_id = $1', [guildId]);

    logger.info({ guildId, userId }, '公会已解散');
    metrics.guildDisbandsTotal?.inc();

    return { success: true, disbanded: true };
  }

  /**
   * 转让会长
   */
  async transferLeadership(guildId, currentLeaderId, newLeaderId) {
    const currentRole = await this.getMemberRole(currentLeaderId);
    if (currentRole !== 'leader') {
      throw new Error('只有会长可以转让职位');
    }

    const newLeaderRole = await this.getMemberRole(newLeaderId);
    if (!newLeaderRole) {
      throw new Error('目标用户不在公会中');
    }

    const client = await getClient();

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

      logger.info({ guildId, currentLeaderId, newLeaderId }, '会长已转让');
      metrics.guildLeadershipTransfersTotal?.inc();

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
      throw new Error('只有会长或副会长可以设置职位');
    }

    const validRoles = ['co_leader', 'elder', 'member', 'novice'];
    if (!validRoles.includes(newRole)) {
      throw new Error('无效的职位');
    }

    await query(`
      UPDATE guild_members SET role = $1 
      WHERE guild_id = $2 AND user_id = $3
    `, [newRole, guildId, memberId]);

    logger.info({ guildId, memberId, newRole, adminId }, '成员职位已更新');

    return { success: true };
  }

  /**
   * 捐赠公会资金
   */
  async donateToGuild(userId, amount) {
    if (amount <= 0 || amount > 1000000) {
      throw new Error('捐赠金额必须在 1-1000000 之间');
    }

    const member = await this.getMemberByUserId(userId);
    if (!member) {
      throw new Error('你未加入任何公会');
    }

    const guildId = member.guild_id;
    const contributionGained = Math.floor(amount / 10);

    const client = await getClient();

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
        throw new Error('金币不足');
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
      `, [guildId, userId, amount, contributionGained]);

      // 增加用户贡献值
      await client.query(`
        UPDATE guild_members 
        SET contribution = contribution + $1, 
            weekly_contribution = weekly_contribution + $1,
            total_donated = total_donated + $2,
            last_contribution_at = CURRENT_TIMESTAMP
        WHERE guild_id = $3 AND user_id = $4
      `, [contributionGained, amount, guildId, userId]);

      // 增加公会经验
      await this.addGuildExperience(guildId, Math.floor(amount / 100), client);

      await client.query('COMMIT');

      logger.info({ userId, guildId, amount, contributionGained }, '公会捐赠成功');
      metrics.guildDonationsTotal?.inc({ type: 'coins' });

      return { success: true, contributionGained };
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
      throw new Error('只有会长或副会长可以激活增益');
    }

    const guild = await this.getGuild(guildId);
    
    // 检查公会等级是否解锁该增益
    const availableBuffs = this.getAvailableBuffs(guild.level);
    if (!availableBuffs.includes(buffType)) {
      throw new Error('该增益尚未解锁');
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
      throw new Error('无效的增益类型');
    }

    if (guild.treasury < config.cost) {
      throw new Error('公会资金不足');
    }

    const client = await getClient();

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

      logger.info({ guildId, buffType, cost: config.cost }, '公会增益已激活');
      metrics.guildBuffsActivatedTotal?.inc({ buff_type: buffType });

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
    const result = await query(`
      SELECT * FROM guild_buffs
      WHERE guild_id = $1 AND expires_at > CURRENT_TIMESTAMP
    `, [guildId]);

    return result.rows;
  }

  /**
   * 增加公会经验
   */
  async addGuildExperience(guildId, amount, client = null) {
    const db = client || query;
    const guild = await this.getGuild(guildId);
    const newExperience = guild.experience + amount;
    const levelConfig = this.GUILD_LEVEL_CONFIG[guild.level];

    if (newExperience >= levelConfig.experienceRequired && guild.level < 50) {
      // 升级
      const newLevel = guild.level + 1;
      await db.query(`
        UPDATE guilds 
        SET level = $1, experience = $2, max_members = $3
        WHERE id = $4
      `, [newLevel, newExperience - levelConfig.experienceRequired, 
          this.GUILD_LEVEL_CONFIG[newLevel].maxMembers, guildId]);

      logger.info({ guildId, newLevel }, '公会升级');
    } else {
      await db.query(
        'UPDATE guilds SET experience = $1 WHERE id = $2',
        [newExperience, guildId]
      );
    }
  }

  /**
   * 发送公会聊天消息
   */
  async sendChatMessage(guildId, userId, content) {
    if (!content || content.trim().length === 0) {
      throw new Error('消息内容不能为空');
    }

    if (content.length > 500) {
      throw new Error('消息长度不能超过 500 字符');
    }

    const member = await this.getMemberByUserId(userId);
    if (!member || member.guild_id !== guildId) {
      throw new Error('你不是该公会的成员');
    }

    const result = await query(`
      INSERT INTO guild_chat_messages (guild_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [guildId, userId, content.trim()]);

    return result.rows[0];
  }

  /**
   * 获取公会聊天历史
   */
  async getChatHistory(guildId, limit = 100, beforeId = null) {
    let queryStr = `
      SELECT 
        m.id, m.content, m.message_type, m.created_at,
        u.id as user_id, u.nickname, u.avatar_url
      FROM guild_chat_messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.guild_id = $1
    `;
    const values = [guildId];
    let paramCount = 2;

    if (beforeId) {
      queryStr += ` AND m.id < $${paramCount}`;
      values.push(beforeId);
      paramCount++;
    }

    queryStr += ` ORDER BY m.created_at DESC LIMIT $${paramCount}`;
    values.push(limit);

    const result = await query(queryStr, values);
    return result.rows.reverse();
  }

  /**
   * 获取公会信息
   */
  async getGuild(guildId) {
    const result = await query('SELECT * FROM guilds WHERE id = $1', [guildId]);
    return result.rows[0];
  }

  /**
   * 获取公会成员列表
   */
  async getGuildMembers(guildId, limit = 50, offset = 0) {
    const result = await query(`
      SELECT gm.*, u.nickname, u.avatar_url, u.level
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
    const result = await query(
      'SELECT COUNT(*) FROM guild_members WHERE guild_id = $1',
      [guildId]
    );
    return parseInt(result.rows[0].count);
  }

  /**
   * 获取用户成员信息
   */
  async getMemberByUserId(userId) {
    const result = await query(
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
    let queryStr = 'SELECT * FROM guilds WHERE status = $1';
    const values = ['active'];
    let paramCount = 2;

    if (filters.name) {
      queryStr += ` AND name ILIKE $${paramCount}`;
      values.push(`%${filters.name}%`);
      paramCount++;
    }

    if (filters.minLevel) {
      queryStr += ` AND level >= $${paramCount}`;
      values.push(filters.minLevel);
      paramCount++;
    }

    if (filters.joinType) {
      queryStr += ` AND join_type = $${paramCount}`;
      values.push(filters.joinType);
      paramCount++;
    }

    queryStr += ' ORDER BY level DESC, total_contribution DESC';

    if (filters.limit) {
      queryStr += ` LIMIT $${paramCount}`;
      values.push(filters.limit);
    }

    const result = await query(queryStr, values);
    return result.rows;
  }

  /**
   * 获取公会排行榜
   */
  async getGuildLeaderboard(leaderboardType = 'global', limit = 100) {
    const result = await query(`
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
   * 获取公会任务列表
   */
  async getGuildTasks(guildId) {
    const result = await query(`
      SELECT * FROM guild_tasks
      WHERE guild_id = $1 AND is_completed = FALSE AND ends_at > CURRENT_TIMESTAMP
      ORDER BY ends_at
    `, [guildId]);

    return result.rows;
  }
}

// 导出单例
module.exports = new GuildService();
