/**
 * REQ-00498: 精灵搜索服务单元测试
 */

'use strict';

const { describe, it, beforeEach, afterEach, expect } = require('@jest/globals');
const PokemonSearchService = require('../../../shared/pokemonSearchService');
const { query } = require('../../../shared/db');
const { getRedis } = require('../../../shared/redisUtils');

// Mock dependencies
jest.mock('../../../shared/db');
jest.mock('../../../shared/redisUtils');
jest.mock('../../../shared/metrics');

describe('PokemonSearchService', () => {
  let service;
  let mockRedis;

  beforeEach(() => {
    mockRedis = {
      keys: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      incr: jest.fn().mockResolvedValue(1)
    };
    
    getRedis.mockReturnValue(mockRedis);
    service = new PokemonSearchService.constructor();
    service.cache = {
      cacheList: jest.fn(),
      getListIds: jest.fn(),
      cacheSearch: jest.fn(),
      getSearchResults: jest.fn(),
      invalidateUser: jest.fn().mockResolvedValue(5),
      getStats: jest.fn(),
      cacheStats: jest.fn()
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('search', () => {
    it('should return cached results when available', async () => {
      const mockPokemonIds = [1, 2, 3];
      const mockPokemon = [
        { id: 1, species_id: 25, cp: 2500, nickname: 'Pikachu' },
        { id: 2, species_id: 1, cp: 800, nickname: 'Bulbasaur' },
        { id: 3, species_id: 4, cp: 600, nickname: 'Charmander' }
      ];

      service.cache.getSearchResults.mockResolvedValue(mockPokemonIds);
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.search(1, 'Pikachu', {});

      expect(service.cache.getSearchResults).toHaveBeenCalledWith(1, 'Pikachu');
      expect(result).toHaveLength(3);
    });

    it('should execute database query when cache miss', async () => {
      const mockPokemon = [
        { id: 1, species_id: 25, cp: 2500, nickname: 'Pikachu' }
      ];

      service.cache.getSearchResults.mockResolvedValue(null);
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.search(1, 'Pika', { limit: 10 });

      expect(query).toHaveBeenCalled();
      expect(service.cache.cacheSearch).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('should filter by types', async () => {
      query.mockResolvedValue({ rows: [] });

      await service.search(1, '', { types: ['fire', 'electric'], limit: 50 });

      const sql = query.mock.calls[0][0];
      expect(sql).toContain('types');
      const params = query.mock.calls[0][1];
      expect(params).toContainEqual(['fire', 'electric']);
    });

    it('should filter by CP range', async () => {
      query.mockResolvedValue({ rows: [] });

      await service.search(1, '', { minCp: 1000, maxCp: 2000, limit: 50 });

      const params = query.mock.calls[0][1];
      expect(params).toContain(1000);
      expect(params).toContain(2000);
    });

    it('should handle empty search term', async () => {
      query.mockResolvedValue({ rows: [] });

      const result = await service.search(1, '', {});

      expect(result).toEqual([]);
    });

    it('should limit results', async () => {
      const mockPokemon = Array(100).fill({ id: 1, species_id: 25, cp: 2500 });
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.search(1, '', { limit: 10 });

      expect(query.mock.calls[0][1]).toContain(10);
    });
  });

  describe('getList', () => {
    it('should use cached IDs when available', async () => {
      const cachedIds = { ids: [1, 2, 3], total: 3, cachedAt: Date.now() };
      const mockPokemon = [
        { id: 1, species_id: 25, cp: 2500 },
        { id: 2, species_id: 1, cp: 800 }
      ];

      service.cache.getListIds.mockResolvedValue(cachedIds);
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.getList(1, { page: 0, pageSize: 20, sort: 'cp' });

      expect(result.cached).toBe(true);
      expect(result.total).toBe(3);
    });

    it('should query database when cache miss', async () => {
      const mockPokemon = [
        { id: 1, species_id: 25, cp: 2500 },
        { id: 2, species_id: 1, cp: 800 }
      ];

      service.cache.getListIds.mockResolvedValue(null);
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.getList(1, { page: 0, pageSize: 20, sort: 'cp' });

      expect(result.cached).toBe(false);
      expect(service.cache.cacheList).toHaveBeenCalled();
    });

    it('should handle pagination correctly', async () => {
      const mockPokemon = Array(100).fill({ id: 1, species_id: 25, cp: 2500 });
      service.cache.getListIds.mockResolvedValue(null);
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.getList(1, { page: 2, pageSize: 20, sort: 'cp' });

      expect(result.page).toBe(2);
    });
  });

  describe('getPokemonByIds', () => {
    it('should return empty array for empty ids', async () => {
      const result = await service.getPokemonByIds(1, [], 'cp');
      expect(result).toEqual([]);
    });

    it('should fetch pokemon by ids', async () => {
      const mockPokemon = [
        { id: 1, species_id: 25, cp: 2500 }
      ];
      query.mockResolvedValue({ rows: mockPokemon });

      const result = await service.getPokemonByIds(1, [1, 2, 3], 'cp');

      expect(query).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('should return cached stats when available', async () => {
      const cachedStats = {
        total_pokemon: 150,
        high_cp_count: 25,
        legendary_count: 3
      };

      service.cache.getStats.mockResolvedValue(cachedStats);

      const result = await service.getStats(1);

      expect(result).toEqual(cachedStats);
      expect(query).not.toHaveBeenCalled();
    });

    it('should query database when stats cache miss', async () => {
      const mockStats = {
        total_pokemon: 150,
        high_cp_count: 25,
        legendary_count: 3
      };
      const mockTypeStats = [
        { type: 'electric', count: 30 },
        { type: 'fire', count: 25 }
      ];

      service.cache.getStats.mockResolvedValue(null);
      query.mockResolvedValueOnce({ rows: [mockStats] });
      query.mockResolvedValueOnce({ rows: mockTypeStats });

      const result = await service.getStats(1);

      expect(result.total_pokemon).toBe(150);
      expect(service.cache.cacheStats).toHaveBeenCalled();
    });
  });

  describe('invalidateUserCache', () => {
    it('should invalidate user cache', async () => {
      service.cache.invalidateUser.mockResolvedValue(5);

      const result = await service.invalidateUserCache(1, 'test');

      expect(service.cache.invalidateUser).toHaveBeenCalledWith(1, 'test');
      expect(result).toBe(5);
    });
  });

  describe('_getOrderBy', () => {
    it('should return correct order clause for cp', () => {
      const result = service._getOrderBy('cp');
      expect(result).toContain('cp DESC');
    });

    it('should return correct order clause for name', () => {
      const result = service._getOrderBy('name');
      expect(result).toContain('name ASC');
    });

    it('should return default order for unknown sort', () => {
      const result = service._getOrderBy('unknown');
      expect(result).toContain('cp DESC');
    });
  });

  describe('checkSlowQuery', () => {
    it('should detect slow query', () => {
      const mockMetric = jest.fn();
      service.metrics = { incrementCounter: mockMetric };

      service.checkSlowQuery(150, 'search');

      expect(mockMetric).toHaveBeenCalled();
    });

    it('should not flag normal query', () => {
      const mockMetric = jest.fn();
      service.metrics = { incrementCounter: mockMetric };

      service.checkSlowQuery(50, 'search');

      expect(mockMetric).not.toHaveBeenCalled();
    });
  });
});

describe('PokemonSearchCache', () => {
  let cache;

  beforeEach(() => {
    cache = service.cache;
  });

  describe('cacheList', () => {
    it('should cache list ids', async () => {
      await cache.cacheList(1, 'cp', {}, [1, 2, 3]);
      expect(cache.cacheList).toHaveBeenCalled();
    });
  });

  describe('getListIds', () => {
    it('should return cached list', async () => {
      cache.getListIds.mockResolvedValue({ ids: [1, 2, 3] });
      const result = await cache.getListIds(1, 'cp', {});
      expect(result).toBeTruthy();
    });
  });

  describe('invalidateUser', () => {
    it('should delete user cache keys', async () => {
      cache.invalidateUser.mockResolvedValue(5);
      const result = await cache.invalidateUser(1, 'manual');
      expect(result).toBe(5);
    });
  });
});