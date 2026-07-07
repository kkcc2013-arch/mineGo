// REQ-00487: 联赛系统单元测试
'use strict';

const LeagueService = require('../shared/LeagueService');
const { LEAGUE_LEVELS, LEAGUE_ORDER } = require('../shared/LeagueConstants');

// Mock database pool
const mockDbPool = {
  query: jest.fn()
};

describe('LeagueService', () => {
  let leagueService;

  beforeEach(() => {
    leagueService = new LeagueService(mockDbPool);
    mockDbPool.query.mockClear();
  });

  describe('calculateWinPoints', () => {
    test('should calculate base points correctly', () => {
      const points = leagueService.calculateWinPoints(1000, 1000, 0);
      expect(points).toBe(25); // Base points only
    });

    test('should add rating bonus for higher opponent', () => {
      const points = leagueService.calculateWinPoints(1000, 1200, 0);
      expect(points).toBe(27); // 25 + 2 rating bonus
    });

    test('should add consecutive win bonus', () => {
      const points = leagueService.calculateWinPoints(1000, 1000, 5);
      expect(points).toBe(50); // 25 + 25 consecutive bonus
    });

    test('should cap consecutive win bonus at 25', () => {
      const points = leagueService.calculateWinPoints(1000, 1000, 10);
      expect(points).toBe(50); // 25 + 25 (capped)
    });
  });

  describe('calculateLossPoints', () => {
    test('should calculate base loss points', () => {
      const points = leagueService.calculateLossPoints(1000, 1000, 0);
      expect(points).toBe(15);
    });

    test('should apply protection for consecutive wins >= 3', () => {
      const points = leagueService.calculateLossPoints(1000, 1000, 5);
      expect(points).toBe(7); // 15 * 0.5 (protection)
    });

    test('should not apply protection for consecutive wins < 3', () => {
      const points = leagueService.calculateLossPoints(1000, 1000, 2);
      expect(points).toBe(15); // No protection
    });
  });

  describe('updateTrueRating', () => {
    test('should increase rating on win', () => {
      const newRating = leagueService.updateTrueRating(1000, 1000, 'win', 32);
      expect(newRating).toBe(1016); // 1000 + 32 * (1 - 0.5)
    });

    test('should decrease rating on loss', () => {
      const newRating = leagueService.updateTrueRating(1000, 1000, 'loss', 32);
      expect(newRating).toBe(984); // 1000 + 32 * (0 - 0.5)
    });

    test('should increase rating more when beating higher rated opponent', () => {
      const newRating = leagueService.updateTrueRating(1000, 1200, 'win', 32);
      const expected = 1 / (1 + Math.pow(10, 200/400));
      expect(newRating).toBe(Math.floor(1000 + 32 * (1 - expected)));
      expect(newRating).toBeGreaterThan(1016);
    });
  });

  describe('determinePromotion', () => {
    test('should stay when points within current league', () => {
      const promotion = leagueService.determinePromotion(500, 'BRONZE', 'III');
      expect(promotion.action).toBe('stay');
      expect(promotion.newLevel).toBe('BRONZE');
      expect(promotion.newGroup).toBe('III');
    });

    test('should promote to SILVER when reaching 1000 points', () => {
      const promotion = leagueService.determinePromotion(1000, 'BRONZE', 'I');
      expect(promotion.action).toBe('promote');
      expect(promotion.newLevel).toBe('SILVER');
      expect(promotion.newGroup).toBe('III');
    });

    test('should promote group within league', () => {
      const promotion = leagueService.determinePromotion(333, 'BRONZE', 'III');
      expect(promotion.action).toBe('groupPromote');
      expect(promotion.newGroup).toBe('II');
    });

    test('should demote when points below league threshold', () => {
      const promotion = leagueService.determinePromotion(800, 'SILVER', 'III');
      expect(promotion.action).toBe('demote');
      expect(promotion.newLevel).toBe('BRONZE');
      expect(promotion.newGroup).toBe('I');
    });

    test('should not demote from BRONZE', () => {
      const promotion = leagueService.determinePromotion(0, 'BRONZE', 'III');
      expect(promotion.action).toBe('stay');
    });

    test('should not promote beyond MASTER', () => {
      const promotion = leagueService.determinePromotion(6000, 'MASTER', 'I');
      expect(promotion.action).toBe('stay');
      expect(promotion.newLevel).toBe('MASTER');
    });
  });

  describe('getCurrentSeason', () => {
    test('should return current active season', async () => {
      mockDbPool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          season_number: 1,
          status: 'active',
          start_time: new Date('2026-07-01'),
          end_time: new Date('2026-07-29')
        }]
      });

      mockDbPool.query.mockResolvedValueOnce({
        rows: [{ total: '100' }]
      });

      const season = await leagueService.getCurrentSeason();
      expect(season.season_number).toBe(1);
      expect(season.status).toBe('active');
      expect(season.total_players).toBe(100);
    });

    test('should throw error when no active season', async () => {
      mockDbPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(leagueService.getCurrentSeason()).rejects.toThrow('No active season found');
    });
  });

  describe('getPlayerLeagueInfo', () => {
    test('should return existing player info', async () => {
      mockDbPool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          season_number: 1,
          status: 'active'
        }]
      });

      mockDbPool.query.mockResolvedValueOnce({
        rows: [{
          player_id: 1,
          league_level: 'GOLD',
          league_group: 'II',
          league_points: 2500,
          league_rating: 1200
        }]
      });

      const info = await leagueService.getPlayerLeagueInfo(1);
      expect(info.league_level).toBe('GOLD');
      expect(info.league_points).toBe(2500);
    });

    test('should initialize new player to BRONZE III', async () => {
      mockDbPool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          season_number: 1,
          status: 'active'
        }]
      });

      mockDbPool.query.mockResolvedValueOnce({ rows: [] });

      mockDbPool.query.mockResolvedValueOnce({
        rows: [{
          player_id: 999,
          league_level: 'BRONZE',
          league_group: 'III',
          league_points: 0,
          league_rating: 1000
        }]
      });

      const info = await leagueService.getPlayerLeagueInfo(999);
      expect(info.league_level).toBe('BRONZE');
      expect(info.league_group).toBe('III');
      expect(info.league_points).toBe(0);
    });
  });
});
