// backend/shared/testUtils/MockDataFactory.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const mockRepo = require('./mockRepository').defaultRepository;

/**
 * Mock 数据工厂
 * 智能生成符合业务规则的测试数据
 */
class MockDataFactory {
  constructor(config = {}) {
    this.pokemonSpecies = this.loadPokemonSpecies();
    this.pokemonTypes = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
    this.items = ['Pokeball', 'Great Ball', 'Ultra Ball', 'Master Ball', 'Potion', 'Super Potion', 'Hyper Potion', 'Max Potion', 'Revive', 'Max Revive', 'Lucky Egg', 'Incense', 'Lure Module', 'Razz Berry', 'Nanab Berry', 'Pinap Berry'];
    this.achievements = ['First Catch', 'Pokemon Collector', 'Gym Leader', 'Social Butterfly', 'Daily Player', 'Week Warrior', 'Level Master', 'Evolution Expert', 'Lucky Trainer', 'Shiny Hunter'];
    this.genders = ['male', 'female', 'unknown'];
    this.countries = ['CN', 'US', 'JP', 'KR', 'UK', 'DE', 'FR', 'AU', 'CA', 'BR'];
  }

  /**
   * 加载精灵物种数据
   */
  loadPokemonSpecies() {
    // 简化的精灵数据（实际应从数据库或配置加载）
    return [
      { id: 1, name: 'Bulbasaur', type: 'grass', baseAttack: 118, baseDefense: 111, baseStamina: 128 },
      { id: 4, name: 'Charmander', type: 'fire', baseAttack: 116, baseDefense: 93, baseStamina: 118 },
      { id: 7, name: 'Squirtle', type: 'water', baseAttack: 94, baseDefense: 122, baseStamina: 127 },
      { id: 25, name: 'Pikachu', type: 'electric', baseAttack: 112, baseDefense: 96, baseStamina: 111 },
      { id: 39, name: 'Jigglypuff', type: 'normal', baseAttack: 80, baseDefense: 54, baseStamina: 225 },
      { id: 129, name: 'Magikarp', type: 'water', baseAttack: 29, baseDefense: 85, baseStamina: 85 },
      { id: 130, name: 'Gyarados', type: 'water', baseAttack: 182, baseDefense: 196, baseStamina: 190 },
      { id: 150, name: 'Mewtwo', type: 'psychic', baseAttack: 300, baseDefense: 182, baseStamina: 214 },
    ];
  }

  /**
   * 生成用户数据
   */
  createUser(overrides = {}) {
    const userId = uuidv4();
    const level = overrides.level || this.randomInt(1, 50);
    
    return {
      userId,
      email: `testuser_${this.randomString(8)}@example.com`,
      username: `Trainer_${this.randomString(6)}`,
      nickname: this.randomChoice(['Ash', 'Misty', 'Brock', 'Gary', 'Dawn', 'May', 'Serena', 'Clemont']),
      level,
      exp: this.calculateExpForLevel(level),
      coins: this.randomInt(0, 10000),
      gems: this.randomInt(0, 1000),
      pokeballs: this.randomInt(10, 200),
      berries: this.randomInt(0, 100),
      team: this.randomChoice(['valor', 'mystic', 'instinct']),
      country: this.randomChoice(this.countries),
      language: this.randomChoice(['zh-CN', 'en-US', 'ja-JP']),
      gender: this.randomChoice(this.genders),
      avatar: `avatar_${this.randomInt(1, 20)}.png`,
      createdAt: new Date(Date.now() - this.randomInt(0, 365) * 24 * 60 * 60 * 1000).toISOString(),
      lastLoginAt: new Date().toISOString(),
      deviceInfo: {
        deviceId: uuidv4(),
        platform: this.randomChoice(['ios', 'android']),
        osVersion: this.randomChoice(['14.0', '15.0', '16.0', '12', '13']),
        appVersion: '1.0.0'
      },
      settings: {
        pushNotifications: true,
        soundEnabled: true,
        language: 'zh-CN'
      },
      ...overrides
    };
  }

  /**
   * 批量生成用户
   */
  createUsers(count, overrides = {}) {
    return Array.from({ length: count }, () => this.createUser(overrides));
  }

  /**
   * 生成精灵数据
   */
  createPokemon(overrides = {}) {
    const species = overrides.species || this.randomChoice(this.pokemonSpecies);
    const level = overrides.level || this.randomInt(1, 35);
    const ivAttack = this.randomInt(0, 15);
    const ivDefense = this.randomInt(0, 15);
    const ivStamina = this.randomInt(0, 15);
    const ivPercentage = (ivAttack + ivDefense + ivStamina) / 45 * 100;
    
    return {
      pokemonId: uuidv4(),
      ownerId: overrides.ownerId || uuidv4(),
      speciesId: species.id,
      speciesName: species.name,
      type: species.type,
      level,
      cp: this.calculateCP(species, level, ivAttack, ivDefense, ivStamina),
      hp: Math.floor(species.baseStamina * level * 0.1) + this.randomInt(10, 30),
      maxHp: Math.floor(species.baseStamina * level * 0.1) + 30,
      iv: { attack: ivAttack, defense: ivDefense, stamina: ivStamina },
      ivPercentage: parseFloat(ivPercentage.toFixed(2)),
      moves: this.generateRandomMoves(species.type),
      isShiny: Math.random() < 0.01,
      gender: this.randomChoice(this.genders),
      weight: this.randomFloat(0.5, 100, 1),
      height: this.randomFloat(0.3, 3.0, 2),
      capturedAt: new Date(Date.now() - this.randomInt(0, 180) * 24 * 60 * 60 * 1000).toISOString(),
      capturedLocation: {
        latitude: this.randomFloat(-90, 90, 6),
        longitude: this.randomFloat(-180, 180, 6),
        name: this.randomChoice(['Central Park', 'Tokyo Tower', 'Golden Gate', 'Eiffel Tower'])
      },
      favorite: Math.random() < 0.1,
      buddy: Math.random() < 0.05,
      ...overrides
    };
  }

  /**
   * 批量生成精灵
   */
  createPokemon(count, overrides = {}) {
    return Array.from({ length: count }, () => this.createPokemon(overrides));
  }

  /**
   * 生成捕捉记录
   */
  createCatchRecord(overrides = {}) {
    const pokemon = this.createPokemon();
    
    return {
      catchId: uuidv4(),
      userId: overrides.userId || uuidv4(),
      pokemonId: pokemon.pokemonId,
      speciesId: pokemon.speciesId,
      speciesName: pokemon.speciesName,
      cp: pokemon.cp,
      location: {
        latitude: this.randomFloat(-90, 90, 6),
        longitude: this.randomFloat(-180, 180, 6)
      },
      ballUsed: this.randomChoice(['Pokeball', 'Great Ball', 'Ultra Ball']),
      berriesUsed: this.randomInt(0, 3),
      throwType: this.randomChoice(['normal', 'nice', 'great', 'excellent']),
      curveball: Math.random() > 0.5,
      catchProbability: this.randomFloat(0.1, 1.0, 4),
      actualCaught: true,
      attempts: this.randomInt(1, 5),
      rewards: {
        exp: this.randomInt(100, 1000),
        stardust: this.randomInt(100, 500),
        candy: this.randomInt(1, 10)
      },
      timestamp: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成道馆数据
   */
  createGym(overrides = {}) {
    const latitude = this.randomFloat(-90, 90, 6);
    const longitude = this.randomFloat(-180, 180, 6);
    
    return {
      gymId: uuidv4(),
      name: this.randomChoice(['Pokemon Gym', 'Battle Arena', 'Training Center', 'Elite Tower']),
      team: this.randomChoice(['valor', 'mystic', 'instinct', 'neutral']),
      level: this.randomInt(1, 6),
      prestige: this.randomInt(0, 50000),
      location: { latitude, longitude },
      defendingPokemon: this.createPokemon({ level: this.randomInt(20, 40) }),
      defenders: this.createPokemon(this.randomInt(1, 6), { level: this.randomInt(20, 40) }),
      raids: [],
      lastModified: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成好友关系
   */
  createFriendship(overrides = {}) {
    return {
      friendshipId: uuidv4(),
      userId1: overrides.userId1 || uuidv4(),
      userId2: overrides.userId2 || uuidv4(),
      level: this.randomInt(1, 5),
      interactionCount: this.randomInt(0, 100),
      giftsSent: this.randomInt(0, 20),
      giftsReceived: this.randomInt(0, 20),
      createdAt: new Date(Date.now() - this.randomInt(0, 365) * 24 * 60 * 60 * 1000).toISOString(),
      lastInteractionAt: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成礼物数据
   */
  createGift(overrides = {}) {
    return {
      giftId: uuidv4(),
      senderId: overrides.senderId || uuidv4(),
      receiverId: overrides.receiverId || uuidv4(),
      status: this.randomChoice(['pending', 'sent', 'opened']),
      contents: {
        stardust: this.randomInt(100, 500),
        items: [this.randomChoice(this.items)],
        pokemon: Math.random() > 0.7 ? this.createPokemon() : null
      },
      postcardLocation: {
        latitude: this.randomFloat(-90, 90, 6),
        longitude: this.randomFloat(-180, 180, 6)
      },
      createdAt: new Date().toISOString(),
      openedAt: null,
      ...overrides
    };
  }

  /**
   * 生成任务数据
   */
  createQuest(overrides = {}) {
    const questTypes = ['catch', 'spin', 'battle', 'walk', 'hatch', 'transfer', 'evolve', 'power_up'];
    const questType = this.randomChoice(questTypes);
    
    return {
      questId: uuidv4(),
      type: questType,
      title: `${questType.charAt(0).toUpperCase() + questType.slice(1)} Quest`,
      description: `${this.randomInt(1, 10)} ${questType} tasks`,
      target: this.randomInt(1, 10),
      progress: this.randomInt(0, 10),
      rewards: {
        exp: this.randomInt(100, 1000),
        stardust: this.randomInt(100, 500),
        items: [this.randomChoice(this.items)]
      },
      status: this.randomChoice(['active', 'completed', 'claimed']),
      category: this.randomChoice(['daily', 'special', 'field', 'research']),
      expiresAt: new Date(Date.now() + this.randomInt(1, 7) * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成成就数据
   */
  createAchievement(overrides = {}) {
    return {
      achievementId: uuidv4(),
      userId: overrides.userId || uuidv4(),
      type: this.randomChoice(this.achievements),
      level: this.randomInt(1, 5),
      progress: this.randomInt(0, 100),
      unlockedAt: new Date().toISOString(),
      rewards: {
        exp: this.randomInt(1000, 10000),
        badge: 'badge_url'
      },
      ...overrides
    };
  }

  /**
   * 生成排行榜数据
   */
  createLeaderboard(overrides = {}) {
    return {
      leaderboardId: uuidv4(),
      category: this.randomChoice(['catches', 'battles', 'distance', 'experience']),
      period: this.randomChoice(['daily', 'weekly', 'monthly', 'all_time']),
      entries: Array.from({ length: 10 }, (_, i) => ({
        rank: i + 1,
        userId: uuidv4(),
        username: `Trainer_${this.randomString(6)}`,
        score: Math.floor(10000 / (i + 1)),
        updatedAt: new Date().toISOString()
      })),
      updatedAt: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成支付订单
   */
  createPaymentOrder(overrides = {}) {
    return {
      orderId: uuidv4(),
      userId: overrides.userId || uuidv4(),
      amount: this.randomChoice([0.99, 4.99, 9.99, 19.99, 49.99, 99.99]),
      currency: this.randomChoice(['USD', 'CNY', 'EUR', 'JPY']),
      productId: this.randomChoice(['coins_100', 'coins_550', 'coins_1200', 'gems_10', 'gems_50']),
      paymentMethod: this.randomChoice(['alipay', 'wechat', 'apple', 'google', 'credit_card']),
      status: this.randomChoice(['pending', 'paid', 'failed', 'refunded']),
      transactionId: uuidv4(),
      metadata: {},
      createdAt: new Date().toISOString(),
      paidAt: null,
      refundedAt: null,
      ...overrides
    };
  }

  /**
   * 生成 WebSocket 消息
   */
  createWebSocketMessage(overrides = {}) {
    return {
      messageId: uuidv4(),
      type: this.randomChoice(['gym_battle', 'raid_update', 'pokemon_spawn', 'friend_request', 'gift_received']),
      payload: {},
      timestamp: new Date().toISOString(),
      ...overrides
    };
  }

  /**
   * 生成位置数据
   */
  createLocation(overrides = {}) {
    return {
      latitude: this.randomFloat(-90, 90, 6),
      longitude: this.randomFloat(-180, 180, 6),
      accuracy: this.randomFloat(5, 50, 1),
      altitude: this.randomFloat(0, 1000, 1),
      speed: this.randomFloat(0, 50, 1),
      heading: this.randomInt(0, 360),
      timestamp: Date.now(),
      ...overrides
    };
  }

  // ==================== 辅助方法 ====================

  /**
   * 随机整数
   */
  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * 随机浮点数
   */
  randomFloat(min, max, decimals = 6) {
    const num = Math.random() * (max - min) + min;
    return parseFloat(num.toFixed(decimals));
  }

  /**
   * 随机字符串
   */
  randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * 随机选择
   */
  randomChoice(array) {
    if (!array || array.length === 0) return null;
    return array[Math.floor(Math.random() * array.length)];
  }

  /**
   * 计算经验值
   */
  calculateExpForLevel(level) {
    return Math.floor(Math.pow(level, 3) * 0.5);
  }

  /**
   * 计算 CP（战斗能力值）
   */
  calculateCP(species, level, ivAttack, ivDefense, ivStamina) {
    const cpMultiplier = 0.790300; // 简化的 CP 乘数
    const attack = species.baseAttack + ivAttack;
    const defense = species.baseDefense + ivDefense;
    const stamina = species.baseStamina + ivStamina;
    
    return Math.floor((attack * Math.pow(defense, 0.5) * Math.pow(stamina, 0.5) * Math.pow(cpMultiplier, 2)) / 10);
  }

  /**
   * 生成随机技能列表
   */
  generateRandomMoves(type) {
    const typeMoves = {
      fire: ['Ember', 'Flamethrower', 'Fire Blast', 'Fire Spin'],
      water: ['Water Gun', 'Hydro Pump', 'Bubble', 'Surf'],
      grass: ['Vine Whip', 'Razor Leaf', 'Solar Beam', 'Leaf Tornado'],
      electric: ['Thunder Shock', 'Thunderbolt', 'Thunder', 'Spark'],
      normal: ['Tackle', 'Scratch', 'Quick Attack', 'Hyper Beam'],
      psychic: ['Confusion', 'Psychic', 'Psybeam', 'Zen Headbutt'],
      fighting: ['Low Kick', 'Karate Chop', 'Brick Break', 'Close Combat'],
      poison: ['Poison Sting', 'Sludge Bomb', 'Acid', 'Toxic']
    };
    
    const moves = typeMoves[type] || typeMoves.normal;
    return this.shuffleArray(moves).slice(0, 2);
  }

  /**
   * 洗牌数组
   */
  shuffleArray(array) {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * 生成过去时间
   */
  generatePastTime(daysAgo) {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * 生成未来时间
   */
  generateFutureTime(daysFromNow) {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * 从 MockRepository 加载数据
   */
  load(key, overrides = {}) {
    try {
      return mockRepo.get(key, overrides);
    } catch (err) {
      // 如果找不到，生成一个新的
      console.warn(`Mock data not found for key: ${key}, generating new data`);
      return this.generateFromKey(key, overrides);
    }
  }

  /**
   * 根据 key 生成数据
   */
  generateFromKey(key, overrides = {}) {
    const [category, name] = key.split(':');
    
    const generators = {
      user: () => this.createUser(overrides),
      pokemon: () => this.createPokemon(overrides),
      gym: () => this.createGym(overrides),
      quest: () => this.createQuest(overrides),
      gift: () => this.createGift(overrides),
      payment: () => this.createPaymentOrder(overrides),
      friendship: () => this.createFriendship(overrides),
      achievement: () => this.createAchievement(overrides),
      location: () => this.createLocation(overrides)
    };
    
    if (generators[category]) {
      return generators[category]();
    }
    
    throw new Error(`Unknown generator for category: ${category}`);
  }
}

// 导出单例
const factory = new MockDataFactory();

module.exports = {
  MockDataFactory,
  factory,
  createFactory: (config) => new MockDataFactory(config)
};