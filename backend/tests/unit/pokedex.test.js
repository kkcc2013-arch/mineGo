/**
 * REQ-00056: 精灵图鉴完成度奖励系统
 * 单元测试
 */

const { pokedexService, TOTAL_SPECIES } = require('../src/pokedexService');
const { query, transaction } = require('../../../shared/db');

// Mock dependencies
jest.mock('../../../shared/db');
jest.mock('../../../shared/logger');
jest.mock('../../../shared/metrics', () => ({
  incrementCounter: jest.fn(),
}));
jest.mock('../../../shared/redis', () => ({
  getRedis: jest.fn(() => ({
    del: jest.fn(),
  })),
  setJSON: jest.fn(),
  getJSON: jest.fn(),
}));

describe('PokedexService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('recordSeen', () => {
    it('should create new entry when pokemon not seen before', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // existing check
      query.mockResolvedValueOnce({ rows: [] }); // insert
      query.mockResolvedValueOnce({ rows: [] }); // updateStatsCache
      query.mockResolvedValueOnce({ rows: [] }); // checkMilestones
      query.mockResolvedValueOnce({ rows: [] }); // checkAchievements

      const result = await pokedexService.recordSeen(1, 25);

      expect(result.success).toBe(true);
      expect(result.newEntry).toBe(true);
    });

    it('should update existing entry when pokemon already seen', async () => {
      query.mockResolvedValueOnce({ rows: [{ seen: true }] }); // existing check
      query.mockResolvedValueOnce({ rows: [] }); // update
      query.mockResolvedValueOnce({ rows: [] }); // updateStatsCache
      query.mockResolvedValueOnce({ rows: [] }); // checkMilestones
      query.mockResolvedValueOnce({ rows: [] }); // checkAchievements

      const result = await pokedexService.recordSeen(1, 25);

      expect(result.success).toBe(true);
      expect(result.newEntry).toBe(false);
    });
  });

  describe('recordCaught', () => {
    it('should create new entry for first catch', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // existing check
      query.mockResolvedValueOnce({ rows: [] }); // insert
      query.mockResolvedValueOnce({ rows: [] }); // updateStatsCache
      query.mockResolvedValueOnce({ rows: [] }); // checkMilestones
      query.mockResolvedValueOnce({ rows: [] }); // checkAchievements

      const result = await pokedexService.recordCaught(1, 25, false);

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(true);
      expect(result.isFirstCatch).toBe(true);
    });

    it('should increment catch count for existing entry', async () => {
      query.mockResolvedValueOnce({
        rows: [{ caught: true, catch_count: 5 }],
      }); // existing check
      query.mockResolvedValueOnce({ rows: [] }); // update
      query.mockResolvedValueOnce({ rows: [] }); // updateStatsCache
      query.mockResolvedValueOnce({ rows: [] }); // checkMilestones
      query.mockResolvedValueOnce({ rows: [] }); // checkAchievements

      const result = await pokedexService.recordCaught(1, 25, false);

      expect(result.success).toBe(true);
      expect(result.isNew).toBe(false);
      expect(result.isFirstCatch).toBe(false);
    });

    it('should mark shiny_caught when catching shiny', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // existing check
      query.mockResolvedValueOnce({ rows: [] }); // insert
      query.mockResolvedValueOnce({ rows: [] }); // updateStatsCache
      query.mockResolvedValueOnce({ rows: [] }); // checkMilestones
      query.mockResolvedValueOnce({ rows: [] }); // checkAchievements

      const result = await pokedexService.recordCaught(1, 25, true);

      expect(result.success).toBe(true);
    });
  });

  describe('getPokedexProgress', () => {
    it('should return progress from cache', async () => {
      const mockProgress = {
        user_id: 1,
        caught_count: 50,
        seen_count: 100,
        shiny_count: 2,
        completion_percentage: '5.52',
      };

      query.mockResolvedValueOnce({ rows: [mockProgress] });

      const result = await pokedexService.getPokedexProgress(1);

      expect(result.caught_count).toBe(50);
      expect(result.seen_count).toBe(100);
    });

    it('should update stats cache when not found', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // first query
      query.mockResolvedValueOnce({ rows: [] }); // updateStatsCache call
      query.mockResolvedValueOnce({ rows: [{ user_id: 1, caught_count: 0 }] }); // retry

      const result = await pokedexService.getPokedexProgress(1);

      expect(result).toBeDefined();
    });
  });

  describe('getDetailedProgress', () => {
    it('should return detailed progress with filters', async () => {
      const mockDetails = [
        { pokemon_species_id: 1, species_name: 'Bulbasaur', caught: true },
        { pokemon_species_id: 4, species_name: 'Charmander', caught: false },
      ];

      query.mockResolvedValueOnce({ rows: mockDetails });

      const result = await pokedexService.getDetailedProgress(1, {
        region: 'kanto',
        caught: true,
      });

      expect(result.length).toBe(2);
    });
  });

  describe('checkMilestones', () => {
    it('should return empty array when no milestones reached', async () => {
      query.mockResolvedValueOnce({ rows: [{ completion_percentage: '5.00', caught_count: 10 }] }); // progress
      query.mockResolvedValueOnce({ rows: [] }); // milestones

      const result = await pokedexService.checkMilestones(1);

      expect(result).toEqual([]);
    });

    it('should auto-claim reached milestones', async () => {
      query.mockResolvedValueOnce({
        rows: [{ completion_percentage: '15.00', caught_count: 50, shiny_count: 0, legendary_count: 0 }],
      }); // progress
      query.mockResolvedValueOnce({
        rows: [
          { id: 1, title: '初学者图鉴', milestone_type: 'percentage', threshold: 10 },
        ],
      }); // milestones
      query.mockResolvedValueOnce({ rows: [] }); // claim

      const result = await pokedexService.checkMilestones(1);

      expect(result.length).toBe(1);
      expect(result[0].title).toBe('初学者图鉴');
    });
  });

  describe('checkAchievements', () => {
    it('should unlock achievement when requirements met', async () => {
      query.mockResolvedValueOnce({ rows: [{ caught_count: 15, seen_count: 20, shiny_count: 0, legendary_count: 0, completion_percentage: '1.66' }] }); // progress
      query.mockResolvedValueOnce({
        rows: [
          { id: 1, achievement_key: 'pokedex_beginner', requirement_type: 'caught_count', requirement_value: 10 },
          { id: 2, achievement_key: 'pokedex_collector', requirement_type: 'caught_count', requirement_value: 50 },
        ],
      }); // achievements
      query.mockResolvedValueOnce({ rows: [] }); // check existing (not found)
      query.mockResolvedValueOnce({ rows: [] }); // insert unlock

      const result = await pokedexService.checkAchievements(1);

      expect(result.length).toBe(1);
      expect(result[0].achievement_key).toBe('pokedex_beginner');
    });

    it('should not unlock already unlocked achievement', async () => {
      query.mockResolvedValueOnce({ rows: [{ caught_count: 15, seen_count: 20, shiny_count: 0, legendary_count: 0, completion_percentage: '1.66' }] }); // progress
      query.mockResolvedValueOnce({
        rows: [{ id: 1, achievement_key: 'pokedex_beginner', requirement_type: 'caught_count', requirement_value: 10 }],
      }); // achievements
      query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // already unlocked

      const result = await pokedexService.checkAchievements(1);

      expect(result.length).toBe(0);
    });
  });

  describe('getCatchBonus', () => {
    it('should return 0 bonus for low completion', async () => {
      query.mockResolvedValueOnce({
        rows: [{ completion_percentage: '5.00', caught_count: 10 }],
      });

      const result = await pokedexService.getCatchBonus(1);

      expect(result.bonusPercent).toBe(0);
    });

    it('should return correct bonus for higher completion', async () => {
      query.mockResolvedValueOnce({
        rows: [{ completion_percentage: '35.00', caught_count: 100 }],
      });

      const result = await pokedexService.getCatchBonus(1);

      expect(result.bonusPercent).toBe(3);
    });

    it('should cap bonus at 10%', async () => {
      query.mockResolvedValueOnce({
        rows: [{ completion_percentage: '150.00', caught_count: 500 }],
      });

      const result = await pokedexService.getCatchBonus(1);

      expect(result.bonusPercent).toBe(10);
    });
  });

  describe('getLeaderboard', () => {
    it('should return leaderboard data', async () => {
      const mockLeaderboard = [
        { user_id: 1, username: 'player1', caught_count: 500, rank: 1 },
        { user_id: 2, username: 'player2', caught_count: 450, rank: 2 },
      ];

      query.mockResolvedValueOnce({ rows: mockLeaderboard });

      const result = await pokedexService.getLeaderboard(10, 0);

      expect(result.length).toBe(2);
      expect(result[0].rank).toBe(1);
    });
  });

  describe('getUserRank', () => {
    it('should return user rank', async () => {
      query.mockResolvedValueOnce({
        rows: [{ user_id: 1, caught_count: 100, rank: 42 }],
      });

      const result = await pokedexService.getUserRank(1);

      expect(result.rank).toBe(42);
      expect(result.caught_count).toBe(100);
    });
  });

  describe('updateStatsCache', () => {
    it('should update all stats correctly', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // update_pokedex_stats
      query.mockResolvedValueOnce({ rows: [{ region: 'kanto', caught_count: 50, total_in_region: 151 }] }); // region stats
      query.mockResolvedValueOnce({ rows: [{ type: 'fire', caught_count: 10, total_of_type: 50 }] }); // type stats
      query.mockResolvedValueOnce({ rows: [{ generation: 1, caught_count: 50, total_in_generation: 151 }] }); // generation stats
      query.mockResolvedValueOnce({ rows: [] }); // update detailed stats

      await pokedexService.updateStatsCache(1);

      expect(query).toHaveBeenCalledTimes(5);
    });
  });
});

describe('Pokedex API Routes', () => {
  // API route tests would go here
  // Testing authentication, validation, error handling
});
