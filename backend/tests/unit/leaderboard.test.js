/**
 * 排行榜系统单元测试
 * 
 * REQ-00074: 玩家排行榜系统
 */

const { describe, it, beforeEach, afterEach, expect, mock } = require('bun:test');
const LeaderboardCache = require('../../shared/leaderboardCache');
const LeaderboardService = require('../leaderboardService');

// Mock Redis
const mockRedis = {
  zadd: mock(() => Promise.resolve(1)),
  zincrby: mock(() => Promise.resolve('100')),
  zrevrank: mock(() => Promise.resolve(0)),
  zscore: mock(() => Promise.resolve('100')),
  zrevrange: mock(() => Promise.resolve(['1', '100', '2', '90', '3', '80'])),
  zcard: mock(() => Promise.resolve(3)),
  expire: mock(() => Promise.resolve(1)),
  ttl: mock(() => Promise.resolve(3600)),
  get: mock(() => Promise.resolve(null)),
  setex: mock(() => Promise.resolve('OK')),
  del: mock(() => Promise.resolve(1)),
  pipeline: mock(() => ({
    zadd: mock(() => {}),
    exec: mock(() => Promise.resolve([]))
  }))
};

// Mock Database
const mockDb = {
  query: mock(() => Promise.resolve({
    rows: [{
      id: 1,
      name: 'Test Season',
      leaderboard_type: 'catch_total',
      start_time: new Date(),
      end_time: new Date(Date.now() + 86400000),
      status: 'active',
      rewards: []
    }]
  }))
};

describe('LeaderboardCache', () => {
  let cache;

  beforeEach(() => {
    cache = new LeaderboardCache(mockRedis);
  });

  describe('getKey', () => {
    it('should generate correct Redis key', () => {
      const key = cache.getKey('catch_total', 1);
      expect(key).toBe('leaderboard:catch_total:season:1');
    });
  });

  describe('updateScore', () => {
    it('should update player score and return rank', async () => {
      const rank = await cache.updateScore('catch_total', 1, 123, 100);
      
      expect(mockRedis.zadd).toHaveBeenCalled();
      expect(mockRedis.expire).toHaveBeenCalled();
      expect(rank).toBe(1); // rank 0 + 1
    });
  });

  describe('incrementScore', () => {
    it('should increment player score', async () => {
      const result = await cache.incrementScore('catch_total', 1, 123, 10);
      
      expect(mockRedis.zincrby).toHaveBeenCalledWith(
        'leaderboard:catch_total:season:1',
        10,
        '123'
      );
      expect(result.score).toBe(100);
      expect(result.rank).toBe(1);
    });
  });

  describe('getPlayerRank', () => {
    it('should return player rank and score', async () => {
      const result = await cache.getPlayerRank('catch_total', 1, 123);
      
      expect(result.rank).toBe(1);
      expect(result.score).toBe(100);
    });

    it('should return null rank for non-existent player', async () => {
      mockRedis.zrevrank.mockReturnValueOnce(Promise.resolve(null));
      mockRedis.zscore.mockReturnValueOnce(Promise.resolve(null));
      
      const result = await cache.getPlayerRank('catch_total', 1, 999);
      
      expect(result.rank).toBe(null);
      expect(result.score).toBe(0);
    });
  });

  describe('getTopPlayers', () => {
    it('should return top players with ranks and scores', async () => {
      const players = await cache.getTopPlayers('catch_total', 1, 10);
      
      expect(players).toHaveLength(3);
      expect(players[0]).toEqual({
        rank: 1,
        playerId: 1,
        score: 100
      });
      expect(players[1]).toEqual({
        rank: 2,
        playerId: 2,
        score: 90
      });
      expect(players[2]).toEqual({
        rank: 3,
        playerId: 3,
        score: 80
      });
    });
  });

  describe('getTotalPlayers', () => {
    it('should return total player count', async () => {
      const total = await cache.getTotalPlayers('catch_total', 1);
      expect(total).toBe(3);
    });
  });
});

describe('LeaderboardService', () => {
  let service;

  beforeEach(() => {
    service = new LeaderboardService(mockDb, mockRedis);
  });

  describe('isValidType', () => {
    it('should return true for valid types', () => {
      expect(service.isValidType('catch_total')).toBe(true);
      expect(service.isValidType('battle_pvp')).toBe(true);
      expect(service.isValidType('shiny_collection')).toBe(true);
    });

    it('should return false for invalid types', () => {
      expect(service.isValidType('invalid')).toBe(false);
      expect(service.isValidType('')).toBe(false);
    });
  });

  describe('getCurrentSeason', () => {
    it('should return current active season', async () => {
      const season = await service.getCurrentSeason('catch_total');
      
      expect(season).toBeDefined();
      expect(season.leaderboard_type).toBe('catch_total');
      expect(season.status).toBe('active');
    });
  });

  describe('onCatchEvent', () => {
    it('should update catch_total leaderboard', async () => {
      await service.onCatchEvent(123, 'common', 456);
      
      // Verify cache increment was called
      expect(mockRedis.zincrby).toHaveBeenCalled();
    });

    it('should update catch_rare leaderboard for rare pokemon', async () => {
      await service.onCatchEvent(123, 'rare', 456);
      
      // Should be called for both catch_total and catch_rare
      expect(mockRedis.zincrby).toHaveBeenCalled();
    });

    it('should update catch_rare leaderboard with bonus points for legendary', async () => {
      await service.onCatchEvent(123, 'legendary', 456);
      
      expect(mockRedis.zincrby).toHaveBeenCalled();
    });
  });

  describe('onBattleResult', () => {
    it('should increment score for win', async () => {
      await service.onBattleResult(123, true, 10, 'pvp');
      
      expect(mockRedis.zincrby).toHaveBeenCalled();
    });

    it('should decrement score for loss', async () => {
      await service.onBattleResult(123, false, 10, 'pvp');
      
      // Loss should decrement score by 30% of points
      expect(mockRedis.zincrby).toHaveBeenCalled();
    });
  });

  describe('getUserInfoBatch', () => {
    it('should return user info map', async () => {
      mockDb.query.mockReturnValueOnce(Promise.resolve({
        rows: [
          { id: 1, username: 'Player1', avatar: 'avatar1.png', level: 10 },
          { id: 2, username: 'Player2', avatar: 'avatar2.png', level: 20 }
        ]
      }));

      const info = await service.getUserInfoBatch([1, 2]);
      
      expect(info[1]).toEqual({
        username: 'Player1',
        avatar: 'avatar1.png',
        level: 10
      });
      expect(info[2]).toEqual({
        username: 'Player2',
        avatar: 'avatar2.png',
        level: 20
      });
    });

    it('should return empty object for empty array', async () => {
      const info = await service.getUserInfoBatch([]);
      expect(info).toEqual({});
    });
  });
});

describe('Leaderboard Type Validation', () => {
  it('should have all required leaderboard types', () => {
    const types = LeaderboardService.VALID_LEADERBOARD_TYPES;
    
    expect(types).toContain('catch_total');
    expect(types).toContain('catch_rare');
    expect(types).toContain('battle_pvp');
    expect(types).toContain('battle_gym');
    expect(types).toContain('pokedex_completion');
    expect(types).toContain('shiny_collection');
    expect(types).toContain('guild_contribution');
  });
});
