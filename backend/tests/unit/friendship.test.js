/**
 * 精灵羁绊系统单元测试 - REQ-00067
 */

const FriendshipService = require('../../services/pokemon-service/src/friendshipService');
const { Pool } = require('pg');
const Redis = require('ioredis');

// Mock dependencies
jest.mock('pg');
jest.mock('ioredis');
jest.mock('../../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  })
}));

describe('FriendshipService', () => {
  let friendshipService;
  let mockDb;
  let mockRedis;
  
  beforeEach(() => {
    // 创建 mock 数据库和 Redis
    mockDb = {
      query: jest.fn()
    };
    
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      del: jest.fn()
    };
    
    Pool.mockImplementation(() => mockDb);
    Redis.mockImplementation(() => mockRedis);
    
    friendshipService = new FriendshipService({
      db: mockDb,
      redis: mockRedis
    });
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('getLevelConfig', () => {
    test('should return level 0 for value 0', () => {
      const config = friendshipService.getLevelConfig(0);
      expect(config.level).toBe(0);
      expect(config.name).toBe('陌生人');
    });
    
    test('should return level 5 for value 130', () => {
      const config = friendshipService.getLevelConfig(130);
      expect(config.level).toBe(5);
      expect(config.name).toBe('亲密');
    });
    
    test('should return level 10 for value 255', () => {
      const config = friendshipService.getLevelConfig(255);
      expect(config.level).toBe(10);
      expect(config.name).toBe('灵魂羁绊');
    });
    
    test('should return level 10 for value 251', () => {
      const config = friendshipService.getLevelConfig(251);
      expect(config.level).toBe(10);
    });
    
    test('should return level 3 for value 76', () => {
      const config = friendshipService.getLevelConfig(76);
      expect(config.level).toBe(3);
    });
  });
  
  describe('calculateLevel', () => {
    test('should calculate correct level for various values', () => {
      expect(friendshipService.calculateLevel(0)).toBe(0);
      expect(friendshipService.calculateLevel(50)).toBe(1);
      expect(friendshipService.calculateLevel(100)).toBe(3);
      expect(friendshipService.calculateLevel(150)).toBe(5);
      expect(friendshipService.calculateLevel(200)).toBe(7);
      expect(friendshipService.calculateLevel(255)).toBe(10);
    });
  });
  
  describe('calculateProgress', () => {
    test('should calculate progress correctly for level 0', () => {
      const levelConfig = friendshipService.FRIENDSHIP_LEVELS[0];
      const progress = friendshipService.calculateProgress(12, levelConfig);
      expect(progress).toBeCloseTo(48); // (12 / 25) * 100
    });
    
    test('should return 100 for max level', () => {
      const levelConfig = friendshipService.FRIENDSHIP_LEVELS[10];
      const progress = friendshipService.calculateProgress(255, levelConfig);
      expect(progress).toBe(100);
    });
    
    test('should calculate progress correctly for middle level', () => {
      const levelConfig = friendshipService.FRIENDSHIP_LEVELS[5]; // 126-150
      const progress = friendshipService.calculateProgress(138, levelConfig);
      expect(progress).toBeCloseTo(50); // (138-126) / (150-126) * 100
    });
  });
  
  describe('calculateBattleBonuses', () => {
    test('should return no bonuses for level 0', () => {
      const bonuses = friendshipService.calculateBattleBonuses(0, 'neutral');
      expect(bonuses.critRateBonus).toBe(0);
      expect(bonuses.evasionRateBonus).toBe(0);
      expect(bonuses.statusResistBonus).toBe(0);
      expect(bonuses.expBonus).toBe(0);
    });
    
    test('should return crit rate bonus for level 3', () => {
      const bonuses = friendshipService.calculateBattleBonuses(3, 'neutral');
      expect(bonuses.critRateBonus).toBe(0.02);
      expect(bonuses.evasionRateBonus).toBe(0);
    });
    
    test('should return evasion bonus for level 5', () => {
      const bonuses = friendshipService.calculateBattleBonuses(5, 'neutral');
      expect(bonuses.critRateBonus).toBe(0.06);
      expect(bonuses.evasionRateBonus).toBe(0.01);
    });
    
    test('should return all bonuses for level 10', () => {
      const bonuses = friendshipService.calculateBattleBonuses(10, 'neutral');
      expect(bonuses.critRateBonus).toBe(0.16);
      expect(bonuses.evasionRateBonus).toBe(0.06);
      expect(bonuses.statusResistBonus).toBe(0.20);
      expect(bonuses.expBonus).toBe(0.30);
    });
    
    test('should add happy mood bonus to crit rate', () => {
      const bonuses = friendshipService.calculateBattleBonuses(3, 'happy');
      expect(bonuses.critRateBonus).toBe(0.07); // 0.02 (level) + 0.05 (mood)
    });
    
    test('should add excited mood bonus to evasion rate', () => {
      const bonuses = friendshipService.calculateBattleBonuses(5, 'excited');
      expect(bonuses.evasionRateBonus).toBe(0.06); // 0.01 (level) + 0.05 (mood)
    });
    
    test('should reduce crit rate for tired mood', () => {
      const bonuses = friendshipService.calculateBattleBonuses(3, 'tired');
      expect(bonuses.critRateBonus).toBe(-0.03); // 0.02 (level) - 0.05 (mood)
    });
  });
  
  describe('getFriendshipInfo', () => {
    test('should return cached data if available', async () => {
      const cachedData = {
        friendship_value: 100,
        friendship_level: 3,
        mood: 'happy'
      };
      
      mockRedis.get.mockResolvedValue(JSON.stringify(cachedData));
      
      const result = await friendshipService.getFriendshipInfo('pokemon-1', 'user-1');
      
      expect(result).toEqual(cachedData);
      expect(mockRedis.get).toHaveBeenCalledWith('friendship:pokemon-1:user-1');
      expect(mockDb.query).not.toHaveBeenCalled();
    });
    
    test('should initialize friendship if not exists', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'friendship-1',
            pokemon_id: 'pokemon-1',
            user_id: 'user-1',
            friendship_value: 0,
            friendship_level: 0,
            mood: 'neutral',
            total_interactions: 0
          }]
        });
      
      const result = await friendshipService.getFriendshipInfo('pokemon-1', 'user-1');
      
      expect(result.friendship_value).toBe(0);
      expect(result.friendship_level).toBe(0);
      expect(result.levelName).toBe('陌生人');
    });
    
    test('should return friendship info from database', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDb.query.mockResolvedValue({
        rows: [{
          id: 'friendship-1',
          pokemon_id: 'pokemon-1',
          user_id: 'user-1',
          friendship_value: 150,
          friendship_level: 5,
          mood: 'happy',
          mood_expiry: new Date(Date.now() + 60000),
          total_interactions: 42,
          species_id: 'pikachu',
          nickname: 'Sparky',
          pokemon_level: 50,
          is_shiny: false
        }]
      });
      
      const result = await friendshipService.getFriendshipInfo('pokemon-1', 'user-1');
      
      expect(result.friendship_value).toBe(150);
      expect(result.friendship_level).toBe(5);
      expect(result.levelName).toBe('亲密');
      expect(result.battleBonuses.critRateBonus).toBeGreaterThan(0);
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });
  
  describe('performInteraction', () => {
    test('should throw error for invalid interaction type', async () => {
      await expect(
        friendshipService.performInteraction('pokemon-1', 'user-1', 'invalid')
      ).rejects.toThrow('Invalid interaction type');
    });
    
    test('should throw error if cooldown is active', async () => {
      const futureTime = Date.now() + 3600000; // 1小时后
      mockRedis.get.mockResolvedValue(futureTime.toString());
      
      await expect(
        friendshipService.performInteraction('pokemon-1', 'user-1', 'feed')
      ).rejects.toThrow('Cooldown remaining');
    });
    
    test('should perform feed interaction successfully', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      // Mock getFriendshipInfo
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: 'friendship-1',
            pokemon_id: 'pokemon-1',
            user_id: 'user-1',
            friendship_value: 100,
            friendship_level: 3,
            mood: 'happy',
            mood_expiry: new Date(Date.now() + 60000),
            total_interactions: 10,
            is_shiny: false
          }]
        })
        // Mock update
        .mockResolvedValueOnce({
          rows: [{
            friendship_value: 118, // 100 + 15 * 1.2 (happy mood)
            friendship_level: 3
          }]
        })
        // Mock insert interaction
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await friendshipService.performInteraction('pokemon-1', 'user-1', 'feed');
      
      expect(result.success).toBe(true);
      expect(result.friendshipGain).toBe(18); // 15 * 1.2
      expect(result.mood).toBe('happy');
      expect(mockRedis.setex).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });
    
    test('should add bonus for shiny pokemon', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: 'friendship-1',
            pokemon_id: 'pokemon-1',
            user_id: 'user-1',
            friendship_value: 100,
            friendship_level: 3,
            mood: 'neutral',
            mood_expiry: null,
            total_interactions: 10,
            is_shiny: true
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            friendship_value: 120, // 100 + 15 + 5 (shiny bonus)
            friendship_level: 3
          }]
        })
        .mockResolvedValueOnce({ rows: [] });
      
      const result = await friendshipService.performInteraction('pokemon-1', 'user-1', 'feed');
      
      expect(result.friendshipGain).toBe(20); // 15 + 5
    });
    
    test('should emit levelUp event when level increases', async () => {
      mockRedis.get.mockResolvedValue(null);
      
      const levelUpHandler = jest.fn();
      friendshipService.on('levelUp', levelUpHandler);
      
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{
            id: 'friendship-1',
            pokemon_id: 'pokemon-1',
            user_id: 'user-1',
            friendship_value: 98,
            friendship_level: 3,
            mood: 'happy',
            is_shiny: false,
            total_interactions: 10
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            friendship_value: 118,
            friendship_level: 4 // Level up!
          }]
        })
        .mockResolvedValueOnce({ rows: [] }) // interaction
        .mockResolvedValueOnce({ rows: [] }); // milestone
      
      const result = await friendshipService.performInteraction('pokemon-1', 'user-1', 'feed');
      
      expect(result.levelUp).toBe(true);
      expect(result.newLevel).toBe(4);
      expect(levelUpHandler).toHaveBeenCalled();
    });
  });
  
  describe('getLeaderboard', () => {
    test('should return leaderboard with correct ranking', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { friendship_value: 255, total_interactions: 100, username: 'player1' },
          { friendship_value: 255, total_interactions: 95, username: 'player2' },
          { friendship_value: 254, total_interactions: 80, username: 'player3' }
        ]
      });
      
      const result = await friendshipService.getLeaderboard(10);
      
      expect(result).toHaveLength(3);
      expect(result[0].rank).toBe(1);
      expect(result[1].rank).toBe(2);
      expect(result[2].rank).toBe(3);
    });
  });
  
  describe('MOOD_EFFECTS', () => {
    test('should have correct multipliers', () => {
      expect(friendshipService.MOOD_EFFECTS.happy.friendshipMultiplier).toBe(1.2);
      expect(friendshipService.MOOD_EFFECTS.excited.friendshipMultiplier).toBe(1.3);
      expect(friendshipService.MOOD_EFFECTS.neutral.friendshipMultiplier).toBe(1.0);
      expect(friendshipService.MOOD_EFFECTS.sad.friendshipMultiplier).toBe(0.8);
      expect(friendshipService.MOOD_EFFECTS.tired.friendshipMultiplier).toBe(0.9);
    });
  });
  
  describe('INTERACTION_TYPES', () => {
    test('should have all 5 interaction types', () => {
      expect(friendshipService.INTERACTION_TYPES.feed).toBeDefined();
      expect(friendshipService.INTERACTION_TYPES.play).toBeDefined();
      expect(friendshipService.INTERACTION_TYPES.pet).toBeDefined();
      expect(friendshipService.INTERACTION_TYPES.train).toBeDefined();
      expect(friendshipService.INTERACTION_TYPES.walk).toBeDefined();
    });
    
    test('should have correct cooldowns', () => {
      expect(friendshipService.INTERACTION_TYPES.feed.cooldown).toBe(60);
      expect(friendshipService.INTERACTION_TYPES.play.cooldown).toBe(120);
      expect(friendshipService.INTERACTION_TYPES.pet.cooldown).toBe(30);
      expect(friendshipService.INTERACTION_TYPES.train.cooldown).toBe(180);
      expect(friendshipService.INTERACTION_TYPES.walk.cooldown).toBe(240);
    });
    
    test('walk should require location', () => {
      expect(friendshipService.INTERACTION_TYPES.walk.locationRequired).toBe(true);
    });
  });
});

// 运行测试
console.log('Friendship Service Tests');
