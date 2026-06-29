/**
 * 用户测试数据工厂
 * 用于集成测试中创建测试用户数据
 */

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const faker = require('@faker-js/faker').faker;

class UserFactory {
  constructor(dbPool) {
    this.dbPool = dbPool;
  }

  /**
   * 创建单个用户
   */
  async create(overrides = {}) {
    const userId = overrides.id || uuidv4();
    const email = overrides.email || faker.internet.email();
    const username = overrides.username || faker.internet.userName().replace(/\s/g, '_');
    const passwordHash = await bcrypt.hash(overrides.password || 'testpass123', 10);
    
    const user = {
      id: userId,
      email,
      username,
      passwordHash,
      password: overrides.password || 'testpass123',
      level: overrides.level || 1,
      experience: overrides.experience || 0,
      coins: overrides.coins || 1000,
      stardust: overrides.stardust || 10000,
      pokeballs: overrides.pokeballs || 50,
      greatballs: overrides.greatballs || 10,
      ultraballs: overrides.ultraballs || 5,
      masterballs: overrides.masterballs || 0,
      berries: overrides.berries || 20,
      incense: overrides.incense || 0,
      lureModules: overrides.lureModules || 0,
      luckyEggs: overrides.luckyEggs || 0,
      avatarUrl: overrides.avatarUrl || null,
      bio: overrides.bio || null,
      region: overrides.region || 'Asia',
      timezone: overrides.timezone || 'UTC',
      language: overrides.language || 'en',
      theme: overrides.theme || 'default',
      notificationSettings: overrides.notificationSettings || {
        pushEnabled: true,
        emailEnabled: true,
        friendRequests: true,
        guildInvites: true,
        eventReminders: true
      },
      privacySettings: overrides.privacySettings || {
        profilePublic: true,
        pokemonPublic: true,
        locationShared: false,
        activityVisible: true
      },
      createdAt: overrides.createdAt || new Date(),
      lastLoginAt: overrides.lastLoginAt || new Date(),
      lastActiveAt: overrides.lastActiveAt || new Date(),
      isVerified: overrides.isVerified || true,
      isBanned: overrides.isBanned || false,
      banReason: overrides.banReason || null,
      mfaEnabled: overrides.mfaEnabled || false,
      mfaSecret: overrides.mfaSecret || null,
      deviceId: overrides.deviceId || uuidv4(),
      deviceType: overrides.deviceType || 'mobile',
      osVersion: overrides.osVersion || 'iOS 17.0',
      appVersion: overrides.appVersion || '1.0.0',
      ...overrides
    };

    // 插入用户表
    await this.dbPool.query(
      `INSERT INTO users (
        id, email, username, password_hash, level, experience, coins, stardust,
        pokeballs, greatballs, ultraballs, masterballs, berries, incense, lure_modules, lucky_eggs,
        avatar_url, bio, region, timezone, language, theme,
        notification_settings, privacy_settings,
        created_at, last_login_at, last_active_at,
        is_verified, is_banned, ban_reason,
        mfa_enabled, mfa_secret, device_id, device_type, os_version, app_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)`,
      [
        user.id, user.email, user.username, user.passwordHash,
        user.level, user.experience, user.coins, user.stardust,
        user.pokeballs, user.greatballs, user.ultraballs, user.masterballs,
        user.berries, user.incense, user.lureModules, user.luckyEggs,
        user.avatarUrl, user.bio, user.region, user.timezone, user.language, user.theme,
        JSON.stringify(user.notificationSettings), JSON.stringify(user.privacySettings),
        user.createdAt, user.lastLoginAt, user.lastActiveAt,
        user.isVerified, user.isBanned, user.banReason,
        user.mfaEnabled, user.mfaSecret, user.deviceId, user.deviceType,
        user.osVersion, user.appVersion
      ]
    );

    return user;
  }

  /**
   * 批量创建用户
   */
  async createBatch(count, overrides = {}) {
    const users = [];
    for (let i = 0; i < count; i++) {
      users.push(await this.create(overrides));
    }
    return users;
  }

  /**
   * 创建好友关系
   */
  async createFriendship(userId1, userId2, overrides = {}) {
    const friendshipId = uuidv4();
    
    const friendship = {
      id: friendshipId,
      userId1,
      userId2,
      status: overrides.status || 'accepted',
      friendshipLevel: overrides.friendshipLevel || 1,
      interactionCount: overrides.interactionCount || 0,
      giftsSent: overrides.giftsSent || 0,
      giftsReceived: overrides.giftsReceived || 0,
      battlesTogether: overrides.battlesTogether || 0,
      raidsTogether: overrides.raidsTogether || 0,
      tradesTogether: overrides.tradesTogether || 0,
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO friendships (
        id, user_id1, user_id2, status, friendship_level,
        interaction_count, gifts_sent, gifts_received,
        battles_together, raids_together, trades_together,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        friendship.id, friendship.userId1, friendship.userId2,
        friendship.status, friendship.friendshipLevel,
        friendship.interactionCount, friendship.giftsSent, friendship.giftsReceived,
        friendship.battlesTogether, friendship.raidsTogether, friendship.tradesTogether,
        friendship.createdAt, friendship.updatedAt
      ]
    );

    return friendship;
  }

  /**
   * 创建公会
   */
  async createGuild(creatorId, overrides = {}) {
    const guildId = uuidv4();
    
    const guild = {
      id: guildId,
      name: overrides.name || `Guild-${faker.company.name()}`,
      description: overrides.description || faker.lorem.sentence(),
      iconUrl: overrides.iconUrl || null,
      creatorId,
      leaderId: creatorId,
      memberCount: overrides.memberCount || 1,
      maxMembers: overrides.maxMembers || 50,
      level: overrides.level || 1,
      experience: overrides.experience || 0,
      reputation: overrides.reputation || 0,
      tags: overrides.tags || ['casual', 'social'],
      inviteOnly: overrides.inviteOnly || false,
      minLevel: overrides.minLevel || 5,
      region: overrides.region || 'Asia',
      language: overrides.language || 'en',
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO guilds (
        id, name, description, icon_url, creator_id, leader_id,
        member_count, max_members, level, experience, reputation,
        tags, invite_only, min_level, region, language, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        guild.id, guild.name, guild.description, guild.iconUrl,
        guild.creatorId, guild.leaderId, guild.memberCount, guild.maxMembers,
        guild.level, guild.experience, guild.reputation,
        JSON.stringify(guild.tags), guild.inviteOnly, guild.minLevel,
        guild.region, guild.language, guild.createdAt, guild.updatedAt
      ]
    );

    // 添加创建者为公会成员
    await this.addGuildMember(guildId, creatorId, { role: 'leader' });

    return guild;
  }

  /**
   * 添加公会成员
   */
  async addGuildMember(guildId, userId, overrides = {}) {
    const membershipId = uuidv4();
    
    await this.dbPool.query(
      `INSERT INTO guild_members (
        id, guild_id, user_id, role, joined_at, contribution, last_active_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        membershipId, guildId, userId,
        overrides.role || 'member',
        overrides.joinedAt || new Date(),
        overrides.contribution || 0,
        overrides.lastActiveAt || new Date()
      ]
    );

    // 更新公会成员数量
    await this.dbPool.query(
      `UPDATE guilds SET member_count = member_count + 1 WHERE id = $1`,
      [guildId]
    );
  }

  /**
   * 创建成就记录
   */
  async createAchievement(userId, overrides = {}) {
    const achievementId = uuidv4();
    
    const achievement = {
      id: achievementId,
      userId,
      achievementType: overrides.achievementType || 'catch_count',
      achievementName: overrides.achievementName || 'First Catch',
      description: overrides.description || 'Caught your first Pokemon!',
      progress: overrides.progress || 100,
      target: overrides.target || 1,
      completed: overrides.completed || true,
      completedAt: overrides.completedAt || new Date(),
      rewards: overrides.rewards || { coins: 100, experience: 50 },
      createdAt: overrides.createdAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO achievements (
        id, user_id, achievement_type, achievement_name, description,
        progress, target, completed, completed_at, rewards, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        achievement.id, achievement.userId, achievement.achievementType,
        achievement.achievementName, achievement.description,
        achievement.progress, achievement.target, achievement.completed,
        achievement.completedAt, JSON.stringify(achievement.rewards), achievement.createdAt
      ]
    );

    return achievement;
  }

  /**
   * 查询用户
   */
  async getUser(userId) {
    const result = await this.dbPool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  /**
   * 更新用户资源
   */
  async updateResources(userId, updates) {
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      updateFields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    values.push(userId);
    
    await this.dbPool.query(
      `UPDATE users SET ${updateFields.join(', ')}, last_active_at = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`,
      values
    );
  }

  /**
   * 清理用户数据
   */
  async clearUser(userId) {
    await this.dbPool.query('DELETE FROM achievements WHERE user_id = $1', [userId]);
    await this.dbPool.query('DELETE FROM friendships WHERE user_id1 = $1 OR user_id2 = $1', [userId]);
    await this.dbPool.query('DELETE FROM guild_members WHERE user_id = $1', [userId]);
    await this.dbPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  /**
   * 清理所有测试用户
   */
  async clearAll() {
    await this.dbPool.query('TRUNCATE users, achievements, friendships, guild_members, guilds CASCADE');
  }
}

module.exports = UserFactory;