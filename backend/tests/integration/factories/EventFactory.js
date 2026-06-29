/**
 * 游戏活动测试数据工厂
 */

const { v4: uuidv4 } = require('uuid');
const faker = require('@faker-js/faker').faker;

class EventFactory {
  constructor(dbPool) {
    this.dbPool = dbPool;
  }

  /**
   * 创建游戏活动
   */
  async create(overrides = {}) {
    const eventId = overrides.eventId || uuidv4();
    
    const event = {
      id: eventId,
      eventType: overrides.eventType || 'spawn_boost',
      name: overrides.name || faker.company.catchPhrase(),
      description: overrides.description || faker.lorem.paragraph(),
      startTime: overrides.startTime || new Date(),
      endTime: overrides.endTime || new Date(Date.now() + 24 * 60 * 60 * 1000),
      isActive: overrides.isActive || true,
      isGlobal: overrides.isGlobal || true,
      regions: overrides.regions || ['Asia', 'Europe', 'America'],
      spawnMultiplier: overrides.spawnMultiplier || 1.5,
      experienceMultiplier: overrides.experienceMultiplier || 1.0,
      candyMultiplier: overrides.candyMultiplier || 1.0,
      featuredPokemon: overrides.featuredPokemon || [1, 25, 94, 150],
      rewards: overrides.rewards || {
        coins: 500,
        stardust: 5000,
        items: ['lucky_egg', 'incense']
      },
      tasks: overrides.tasks || [],
      bannerUrl: overrides.bannerUrl || null,
      metadata: overrides.metadata || {},
      createdAt: overrides.createdAt || new Date(),
      updatedAt: overrides.updatedAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO events (
        id, event_type, name, description, start_time, end_time,
        is_active, is_global, regions, spawn_multiplier, experience_multiplier, candy_multiplier,
        featured_pokemon, rewards, tasks, banner_url, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        event.id, event.eventType, event.name, event.description,
        event.startTime, event.endTime, event.isActive, event.isGlobal,
        JSON.stringify(event.regions), event.spawnMultiplier, event.experienceMultiplier, event.candyMultiplier,
        JSON.stringify(event.featuredPokemon), JSON.stringify(event.rewards),
        JSON.stringify(event.tasks), event.bannerUrl, JSON.stringify(event.metadata),
        event.createdAt, event.updatedAt
      ]
    );

    return event;
  }

  /**
   * 创建限时活动
   */
  async createLimitedEvent(overrides = {}) {
    return await this.create({
      eventType: 'limited_time',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3 * 60 * 60 * 1000), // 3小时
      spawnMultiplier: 3.0,
      experienceMultiplier: 2.0,
      ...overrides
    });
  }

  /**
   * 创建社区日活动
   */
  async createCommunityDay(overrides = {}) {
    const featuredSpecies = overrides.featuredPokemon || [25];
    
    return await this.create({
      eventType: 'community_day',
      name: `${featuredSpecies[0]} Community Day`,
      spawnMultiplier: 4.0,
      experienceMultiplier: 3.0,
      candyMultiplier: 2.0,
      featuredPokemon: featuredSpecies,
      rewards: {
        coins: 1000,
        stardust: 10000,
        items: ['incense', 'lucky_egg']
      },
      ...overrides
    });
  }

  /**
   * 创建Raids活动
   */
  async createRaidEvent(overrides = {}) {
    return await this.create({
      eventType: 'raid',
      name: 'Legendary Raid Hour',
      description: 'Increased Legendary Pokemon raids',
      featuredPokemon: [150, 149, 150], // Mewtwo raids
      spawnMultiplier: 1.0,
      metadata: {
        raidLevel: 5,
        maxRaidPasses: 2,
        raidBosses: [150, 149]
      },
      ...overrides
    });
  }

  /**
   * 创建用户活动参与记录
   */
  async createUserEventParticipation(userId, eventId, overrides = {}) {
    const participationId = uuidv4();
    
    const participation = {
      id: participationId,
      userId,
      eventId,
      progress: overrides.progress || 0,
      tasksCompleted: overrides.tasksCompleted || [],
      rewardsClaimed: overrides.rewardsClaimed || false,
      rewardsClaimedAt: overrides.rewardsClaimedAt || null,
      joinedAt: overrides.joinedAt || new Date(),
      lastActiveAt: overrides.lastActiveAt || new Date(),
      ...overrides
    };

    await this.dbPool.query(
      `INSERT INTO event_participations (
        id, user_id, event_id, progress, tasks_completed,
        rewards_claimed, rewards_claimed_at, joined_at, last_active_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        participation.id, participation.userId, participation.eventId,
        participation.progress, JSON.stringify(participation.tasksCompleted),
        participation.rewardsClaimed, participation.rewardsClaimedAt,
        participation.joinedAt, participation.lastActiveAt
      ]
    );

    return participation;
  }

  /**
   * 查询活动
   */
  async getActiveEvents(region = null) {
    let query = `
      SELECT * FROM events 
      WHERE is_active = true 
      AND start_time <= CURRENT_TIMESTAMP 
      AND end_time > CURRENT_TIMESTAMP
    `;
    const params = [];
    
    if (region) {
      query += ` AND $1 = ANY(regions)`;
      params.push(region);
    }
    
    query += ' ORDER BY start_time DESC';
    
    const result = await this.dbPool.query(query, params);
    return result.rows;
  }

  /**
   * 清理测试活动
   */
  async clearTestEvents() {
    await this.dbPool.query('DELETE FROM event_participations');
    await this.dbPool.query('DELETE FROM events');
  }
}

module.exports = EventFactory;