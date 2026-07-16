// backend/services/social-service/src/teamService.js
// REQ-00558: 游戏客户端团队实时协作与语音通信系统

'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { publishEvent } = require('../../../shared/KafkaProducer');
const redis = require('../../../shared/redis');

const logger = createLogger('team-service');

/**
 * 团队服务
 * 管理团队创建、加入、退出、邀请、状态同步
 */
class TeamService {
  constructor() {
    this.pool = null;
    this.redis = null;
  }

  /**
   * 初始化数据库连接
   */
  async init() {
    if (!this.pool) {
      this.pool = getPool();
    }
    if (!this.redis) {
      this.redis = redis;
    }
    
    // 创建团队相关表
    await this.createTables();
  }

  /**
   * 创建数据库表
   */
  async createTables() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        -- 团队表
        CREATE TABLE IF NOT EXISTS teams (
          team_id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          leader_id VARCHAR(36) NOT NULL,
          team_type VARCHAR(20) DEFAULT 'casual',
          status VARCHAR(20) DEFAULT 'active',
          max_members INTEGER DEFAULT 20,
          voice_channel_id VARCHAR(36),
          settings JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          disbanded_at TIMESTAMPTZ
        );

        -- 团队成员表
        CREATE TABLE IF NOT EXISTS team_members (
          id SERIAL PRIMARY KEY,
          team_id VARCHAR(36) NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
          user_id VARCHAR(36) NOT NULL,
          role VARCHAR(20) DEFAULT 'member',
          status VARCHAR(20) DEFAULT 'active',
          joined_at TIMESTAMPTZ DEFAULT NOW(),
          left_at TIMESTAMPTZ,
          contribution_score INTEGER DEFAULT 0,
          UNIQUE(team_id, user_id)
        );

        -- 团队战绩表
        CREATE TABLE IF NOT EXISTS team_battle_records (
          id SERIAL PRIMARY KEY,
          team_id VARCHAR(36) NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
          battle_type VARCHAR(20) NOT NULL,
          battle_id VARCHAR(36),
          result VARCHAR(20) NOT NULL,
          duration_seconds INTEGER,
          members JSONB DEFAULT '[]',
          total_contribution INTEGER DEFAULT 0,
          rewards JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- 团队邀请表
        CREATE TABLE IF NOT EXISTS team_invitations (
          id SERIAL PRIMARY KEY,
          team_id VARCHAR(36) NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
          inviter_id VARCHAR(36) NOT NULL,
          invitee_id VARCHAR(36) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          message TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
          responded_at TIMESTAMPTZ
        );

        -- 团队位置共享缓存（Redis）
        CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
        CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_team_battle_records_team_id ON team_battle_records(team_id);
      `);
      logger.info('Team tables created/verified');
    } finally {
      client.release();
    }
  }

  /**
   * 创建团队
   */
  async createTeam(userId, options = {}) {
    await this.init();

    const {
      name,
      teamType = 'casual',
      maxMembers = 20,
      settings = {}
    } = options;

    const teamId = uuidv4();
    const voiceChannelId = `voice_${teamId}`;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 创建团队
      await client.query(`
        INSERT INTO teams (team_id, name, leader_id, team_type, max_members, voice_channel_id, settings)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [teamId, name, userId, teamType, maxMembers, voiceChannelId, JSON.stringify(settings)]);

      // 创建者作为队长加入
      await client.query(`
        INSERT INTO team_members (team_id, user_id, role, status)
        VALUES ($1, $2, 'leader', 'active')
      `, [teamId, userId]);

      await client.query('COMMIT');

      const team = await this.getTeamById(teamId);

      // 发布团队创建事件
      await publishEvent('team-events', {
        type: 'team_created',
        teamId,
        userId,
        team: team,
        timestamp: new Date().toISOString()
      });

      logger.info('Team created', { teamId, userId, name });

      return team;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取团队详情
   */
  async getTeamById(teamId) {
    await this.init();

    const result = await this.pool.query(`
      SELECT t.*, 
        json_agg(
          json_build_object(
            'userId', tm.user_id,
            'role', tm.role,
            'status', tm.status,
            'joinedAt', tm.joined_at,
            'contributionScore', tm.contribution_score
          )
        ) FILTER (WHERE tm.user_id IS NOT NULL) as members
      FROM teams t
      LEFT JOIN team_members tm ON t.team_id = tm.team_id AND tm.status = 'active'
      WHERE t.team_id = $1 AND t.status != 'disbanded'
      GROUP BY t.team_id
    `, [teamId]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      teamId: row.team_id,
      name: row.name,
      leader: row.leader_id,
      members: row.members || [],
      maxMembers: row.max_members,
      type: row.team_type,
      status: row.status,
      voiceChannelId: row.voice_channel_id,
      settings: row.settings || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /**
   * 加入团队
   */
  async joinTeam(teamId, userId) {
    await this.init();

    // 检查团队是否存在且活跃
    const teamResult = await this.pool.query(`
      SELECT * FROM teams WHERE team_id = $1 AND status = 'active'
    `, [teamId]);

    if (teamResult.rows.length === 0) {
      throw new Error('TEAM_NOT_FOUND');
    }

    const team = teamResult.rows[0];

    // 检查是否已满
    const memberCount = await this.pool.query(`
      SELECT COUNT(*) FROM team_members WHERE team_id = $1 AND status = 'active'
    `, [teamId]);

    if (parseInt(memberCount.rows[0].count) >= team.max_members) {
      throw new Error('TEAM_FULL');
    }

    // 检查是否已是成员
    const existingMember = await this.pool.query(`
      SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2
    `, [teamId, userId]);

    if (existingMember.rows.length > 0) {
      // 重新激活
      await this.pool.query(`
        UPDATE team_members SET status = 'active', left_at = NULL, role = 'member'
        WHERE team_id = $1 AND user_id = $2
      `, [teamId, userId]);
    } else {
      // 新成员
      await this.pool.query(`
        INSERT INTO team_members (team_id, user_id, role, status)
        VALUES ($1, $2, 'member', 'active')
      `, [teamId, userId]);
    }

    // 发布加入事件
    await publishEvent('team-events', {
      type: 'member_joined',
      teamId,
      userId,
      timestamp: new Date().toISOString()
    });

    logger.info('User joined team', { teamId, userId });

    return await this.getTeamById(teamId);
  }

  /**
   * 退出团队
   */
  async leaveTeam(teamId, userId) {
    await this.init();

    const team = await this.getTeamById(teamId);
    if (!team) {
      throw new Error('TEAM_NOT_FOUND');
    }

    // 队长不能直接退出，需要先转让或解散
    if (team.leader === userId) {
      throw new Error('LEADER_MUST_TRANSFER_OR_DISBAND');
    }

    await this.pool.query(`
      UPDATE team_members 
      SET status = 'left', left_at = NOW()
      WHERE team_id = $1 AND user_id = $2
    `, [teamId, userId]);

    // 发布退出事件
    await publishEvent('team-events', {
      type: 'member_left',
      teamId,
      userId,
      timestamp: new Date().toISOString()
    });

    logger.info('User left team', { teamId, userId });

    return { success: true };
  }

  /**
   * 邀请好友
   */
  async inviteMember(teamId, inviterId, inviteeId, message = '') {
    await this.init();

    // 验证邀请者权限
    const memberResult = await this.pool.query(`
      SELECT * FROM team_members 
      WHERE team_id = $1 AND user_id = $2 AND status = 'active'
    `, [teamId, inviterId]);

    if (memberResult.rows.length === 0) {
      throw new Error('NOT_A_MEMBER');
    }

    // 检查团队是否已满
    const team = await this.getTeamById(teamId);
    if (team.members.length >= team.maxMembers) {
      throw new Error('TEAM_FULL');
    }

    // 检查是否已有待处理邀请
    const existingInvitation = await this.pool.query(`
      SELECT * FROM team_invitations 
      WHERE team_id = $1 AND invitee_id = $2 AND status = 'pending'
    `, [teamId, inviteeId]);

    if (existingInvitation.rows.length > 0) {
      throw new Error('INVITATION_ALREADY_EXISTS');
    }

    // 创建邀请
    const invitationId = await this.pool.query(`
      INSERT INTO team_invitations (team_id, inviter_id, invitee_id, message)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [teamId, inviterId, inviteeId, message]);

    // 发布邀请事件
    await publishEvent('team-events', {
      type: 'invitation_created',
      teamId,
      inviterId,
      inviteeId,
      invitationId: invitationId.rows[0].id,
      timestamp: new Date().toISOString()
    });

    logger.info('Team invitation created', { teamId, inviterId, inviteeId });

    return {
      invitationId: invitationId.rows[0].id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };
  }

  /**
   * 响应邀请
   */
  async respondToInvitation(invitationId, userId, accept) {
    await this.init();

    const invitationResult = await this.pool.query(`
      SELECT * FROM team_invitations WHERE id = $1 AND invitee_id = $2
    `, [invitationId, userId]);

    if (invitationResult.rows.length === 0) {
      throw new Error('INVITATION_NOT_FOUND');
    }

    const invitation = invitationResult.rows[0];

    if (invitation.status !== 'pending') {
      throw new Error('INVITATION_ALREADY_RESPONDED');
    }

    if (new Date() > new Date(invitation.expires_at)) {
      throw new Error('INVITATION_EXPIRED');
    }

    const status = accept ? 'accepted' : 'declined';

    await this.pool.query(`
      UPDATE team_invitations 
      SET status = $1, responded_at = NOW()
      WHERE id = $2
    `, [status, invitationId]);

    if (accept) {
      await this.joinTeam(invitation.team_id, userId);
    }

    // 发布响应事件
    await publishEvent('team-events', {
      type: 'invitation_responded',
      teamId: invitation.team_id,
      invitationId,
      userId,
      accepted: accept,
      timestamp: new Date().toISOString()
    });

    return { success: true, status };
  }

  /**
   * 移除成员（队长权限）
   */
  async kickMember(teamId, leaderId, memberId) {
    await this.init();

    // 验证队长权限
    const team = await this.getTeamById(teamId);
    if (!team || team.leader !== leaderId) {
      throw new Error('NOT_LEADER');
    }

    if (memberId === leaderId) {
      throw new Error('CANNOT_KICK_SELF');
    }

    await this.pool.query(`
      UPDATE team_members 
      SET status = 'kicked', left_at = NOW()
      WHERE team_id = $1 AND user_id = $2
    `, [teamId, memberId]);

    // 发布事件
    await publishEvent('team-events', {
      type: 'member_kicked',
      teamId,
      leaderId,
      memberId,
      timestamp: new Date().toISOString()
    });

    logger.info('Member kicked', { teamId, leaderId, memberId });

    return { success: true };
  }

  /**
   * 转让队长
   */
  async transferLeadership(teamId, currentLeaderId, newLeaderId) {
    await this.init();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 验证当前队长
      const teamResult = await client.query(`
        SELECT * FROM teams WHERE team_id = $1 AND leader_id = $2 AND status = 'active'
      `, [teamId, currentLeaderId]);

      if (teamResult.rows.length === 0) {
        throw new Error('NOT_LEADER');
      }

      // 验证新队长是否是成员
      const memberResult = await client.query(`
        SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2 AND status = 'active'
      `, [teamId, newLeaderId]);

      if (memberResult.rows.length === 0) {
        throw new Error('NEW_LEADER_NOT_MEMBER');
      }

      // 更新团队表
      await client.query(`
        UPDATE teams SET leader_id = $1, updated_at = NOW() WHERE team_id = $2
      `, [newLeaderId, teamId]);

      // 更新成员角色
      await client.query(`
        UPDATE team_members SET role = 'member' WHERE team_id = $1 AND user_id = $2
      `, [teamId, currentLeaderId]);

      await client.query(`
        UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND user_id = $2
      `, [teamId, newLeaderId]);

      await client.query('COMMIT');

      // 发布事件
      await publishEvent('team-events', {
        type: 'leadership_transferred',
        teamId,
        previousLeader: currentLeaderId,
        newLeader: newLeaderId,
        timestamp: new Date().toISOString()
      });

      logger.info('Leadership transferred', { teamId, from: currentLeaderId, to: newLeaderId });

      return await this.getTeamById(teamId);

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 解散团队
   */
  async disbandTeam(teamId, leaderId) {
    await this.init();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 验证队长
      const teamResult = await client.query(`
        SELECT * FROM teams WHERE team_id = $1 AND leader_id = $2
      `, [teamId, leaderId]);

      if (teamResult.rows.length === 0) {
        throw new Error('NOT_LEADER');
      }

      // 标记团队已解散
      await client.query(`
        UPDATE teams SET status = 'disbanded', disbanded_at = NOW() WHERE team_id = $1
      `, [teamId]);

      // 标记所有成员已离开
      await client.query(`
        UPDATE team_members SET status = 'disbanded', left_at = NOW() 
        WHERE team_id = $1 AND status = 'active'
      `, [teamId]);

      await client.query('COMMIT');

      // 发布事件
      await publishEvent('team-events', {
        type: 'team_disbanded',
        teamId,
        leaderId,
        timestamp: new Date().toISOString()
      });

      logger.info('Team disbanded', { teamId, leaderId });

      return { success: true };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取用户的团队列表
   */
  async getUserTeams(userId) {
    await this.init();

    const result = await this.pool.query(`
      SELECT t.*, tm.role, tm.joined_at
      FROM teams t
      JOIN team_members tm ON t.team_id = tm.team_id
      WHERE tm.user_id = $1 AND tm.status = 'active' AND t.status != 'disbanded'
      ORDER BY t.created_at DESC
    `, [userId]);

    return result.rows.map(row => ({
      teamId: row.team_id,
      name: row.name,
      type: row.team_type,
      status: row.status,
      role: row.role,
      joinedAt: row.joined_at,
      leader: row.leader_id === userId,
      voiceChannelId: row.voice_channel_id
    }));
  }

  /**
   * 更新成员位置（用于实时位置共享）
   */
  async updateMemberLocation(teamId, userId, location) {
    await this.init();

    const { lat, lng } = location;
    const cacheKey = `team:${teamId}:locations`;

    // 存储到 Redis（5分钟过期）
    await this.redis.hset(cacheKey, userId, JSON.stringify({
      lat,
      lng,
      updatedAt: Date.now()
    }));
    await this.redis.expire(cacheKey, 300);

    return { success: true };
  }

  /**
   * 获取团队成员位置
   */
  async getTeamLocations(teamId) {
    await this.init();

    const cacheKey = `team:${teamId}:locations`;
    const locations = await this.redis.hgetall(cacheKey);

    const result = {};
    for (const [userId, data] of Object.entries(locations || {})) {
      try {
        result[userId] = JSON.parse(data);
      } catch (e) {
        // 忽略解析错误
      }
    }

    return result;
  }

  /**
   * 更新成员状态
   */
  async updateMemberStatus(teamId, userId, status) {
    await this.init();

    const cacheKey = `team:${teamId}:statuses`;
    await this.redis.hset(cacheKey, userId, JSON.stringify({
      status,
      updatedAt: Date.now()
    }));
    await this.redis.expire(cacheKey, 3600); // 1小时过期

    return { success: true };
  }

  /**
   * 获取团队成员状态
   */
  async getTeamStatuses(teamId) {
    await this.init();

    const cacheKey = `team:${teamId}:statuses`;
    const statuses = await this.redis.hgetall(cacheKey);

    const result = {};
    for (const [userId, data] of Object.entries(statuses || {})) {
      try {
        result[userId] = JSON.parse(data);
      } catch (e) {
        // 忽略解析错误
      }
    }

    return result;
  }

  /**
   * 记录团队战绩
   */
  async recordBattleResult(teamId, battleData) {
    await this.init();

    const {
      battleType,
      battleId,
      result,
      durationSeconds,
      members,
      totalContribution,
      rewards
    } = battleData;

    const recordResult = await this.pool.query(`
      INSERT INTO team_battle_records 
      (team_id, battle_type, battle_id, result, duration_seconds, members, total_contribution, rewards)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [teamId, battleType, battleId, result, durationSeconds, 
        JSON.stringify(members), totalContribution, JSON.stringify(rewards)]);

    // 更新成员贡献分
    for (const member of members) {
      if (member.contribution) {
        await this.pool.query(`
          UPDATE team_members 
          SET contribution_score = contribution_score + $1
          WHERE team_id = $2 AND user_id = $3
        `, [member.contribution, teamId, member.userId]);
      }
    }

    logger.info('Team battle recorded', { teamId, battleId, result });

    return { recordId: recordResult.rows[0].id };
  }

  /**
   * 获取团队战绩统计
   */
  async getTeamStats(teamId) {
    await this.init();

    const statsResult = await this.pool.query(`
      SELECT 
        COUNT(*) as total_battles,
        COUNT(*) FILTER (WHERE result = 'win') as wins,
        COUNT(*) FILTER (WHERE result = 'loss') as losses,
        AVG(duration_seconds) as avg_duration,
        SUM(total_contribution) as total_contribution
      FROM team_battle_records
      WHERE team_id = $1
    `, [teamId]);

    const memberStatsResult = await this.pool.query(`
      SELECT 
        tm.user_id,
        tm.contribution_score,
        COUNT(tbr.id) as battles_participated
      FROM team_members tm
      LEFT JOIN team_battle_records tbr ON tbr.team_id = tm.team_id 
        AND tbr.members::jsonb @> jsonb_build_array(jsonb_build_object('userId', tm.user_id))::jsonb
      WHERE tm.team_id = $1 AND tm.status = 'active'
      GROUP BY tm.user_id, tm.contribution_score
      ORDER BY tm.contribution_score DESC
    `, [teamId]);

    const stats = statsResult.rows[0];
    const totalBattles = parseInt(stats.total_battles) || 0;
    const wins = parseInt(stats.wins) || 0;

    return {
      totalBattles,
      wins,
      losses: parseInt(stats.losses) || 0,
      winRate: totalBattles > 0 ? (wins / totalBattles * 100).toFixed(2) : 0,
      avgDuration: parseFloat(stats.avg_duration) || 0,
      totalContribution: parseInt(stats.total_contribution) || 0,
      memberStats: memberStatsResult.rows.map(row => ({
        userId: row.user_id,
        contributionScore: row.contribution_score,
        battlesParticipated: parseInt(row.battles_participated) || 0
      }))
    };
  }
}

// 单例导出
let teamServiceInstance = null;

function getTeamService() {
  if (!teamServiceInstance) {
    teamServiceInstance = new TeamService();
  }
  return teamServiceInstance;
}

module.exports = {
  TeamService,
  getTeamService
};