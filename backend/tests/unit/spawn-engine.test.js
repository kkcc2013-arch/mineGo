// backend/tests/unit/spawn-engine.test.js — Unit Tests for SpawnEngine
'use strict';

const { describe, it, expect, beforeAll, afterAll, beforeEach } = require('@jest/globals');
const SpawnEngine = require('../../shared/SpawnEngine');

// Mock Redis
const mockRedis = {
  hset: jest.fn().mockResolvedValue('OK'),
  hget: jest.fn().mockResolvedValue(null),
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
  expire: jest.fn().mockResolvedValue(1),
  expireat: jest.fn().mockResolvedValue(1),
  geoadd: jest.fn().mockResolvedValue(1),
  georadius: jest.fn().mockResolvedValue([]),
  sadd: jest.fn().mockResolvedValue(1),
  srem: jest.fn().mockResolvedValue(1),
  smembers: jest.fn().mockResolvedValue([]),
  zadd: jest.fn().mockResolvedValue(1),
  zcard: jest.fn().mockResolvedValue(0),
  zremrangebyscore: jest.fn().mockResolvedValue(0),
  zrem: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn().mockResolvedValue({}),
  del: jest.fn().mockResolvedValue(1),
  keys: jest.fn().mockResolvedValue([])
};

// Mock Database
const mockDb = {
  query: jest.fn().mockResolvedValue({ rows: [] })
};

describe('SpawnEngine', () => {
  let engine;
  
  beforeAll(() => {
    engine = new SpawnEngine({
      redis: mockRedis,
      db: mockDb
    });
  });
  
  afterAll(() => {
    engine.stop();
  });
  
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('Time Factor', () => {
    it('should return low factor during late night (2 AM)', () => {
      // Mock hour to 2 AM
      const originalGetHours = Date.prototype.getHours;
      Date.prototype.getHours = () => 2;
      
      const factor = engine.getTimeFactor();
      
      expect(factor).toBe(0.3);
      
      Date.prototype.getHours = originalGetHours;
    });
    
    it('should return high factor during evening peak (19:00)', () => {
      const originalGetHours = Date.prototype.getHours;
      Date.prototype.getHours = () => 19;
      
      const factor = engine.getTimeFactor();
      
      expect(factor).toBe(1.6);
      
      Date.prototype.getHours = originalGetHours;
    });
    
    it('should return medium factor during working hours (10:00)', () => {
      const originalGetHours = Date.prototype.getHours;
      Date.prototype.getHours = () => 10;
      
      const factor = engine.getTimeFactor();
      
      expect(factor).toBe(1.0);
      
      Date.prototype.getHours = originalGetHours;
    });
  });
  
  describe('Player Factor', () => {
    it('should return 0.3 for zero players', () => {
      const factor = engine.getPlayerFactor(0);
      expect(factor).toBe(0.3);
    });
    
    it('should return 1.0 for 1-5 players', () => {
      const factor = engine.getPlayerFactor(3);
      expect(factor).toBe(1.0);
    });
    
    it('should return 1.4 for 30 players', () => {
      const factor = engine.getPlayerFactor(30);
      expect(factor).toBe(1.4);
    });
    
    it('should cap at 1.6 for many players', () => {
      const factor = engine.getPlayerFactor(100);
      expect(factor).toBe(1.6);
    });
  });
  
  describe('Weighted Random Select', () => {
    it('should select from pool based on weights', () => {
      const pool = [
        { id: 1, name: 'Pokemon A', weight: 90 },
        { id: 2, name: 'Pokemon B', weight: 10 }
      ];
      
      const selected = engine.weightedRandomSelect(pool);
      
      expect(pool).toContainEqual(selected);
    });
    
    it('should handle empty pool gracefully', () => {
      expect(() => {
        engine.weightedRandomSelect([]);
      }).toThrow('Empty spawn pool');
    });
    
    it('should handle missing weights', () => {
      const pool = [
        { id: 1, name: 'Pokemon A' },
        { id: 2, name: 'Pokemon B' }
      ];
      
      const selected = engine.weightedRandomSelect(pool);
      expect(pool).toContainEqual(selected);
    });
  });
  
  describe('CP Calculation', () => {
    it('should calculate CP from base stats', () => {
      const pokemon = {
        baseAttack: 200,
        baseDefense: 150,
        baseStamina: 180
      };
      
      const cp = engine.calculateCP(pokemon);
      
      expect(cp).toBeGreaterThan(0);
      expect(cp).toBeLessThan(5000);
    });
    
    it('should handle missing stats', () => {
      const pokemon = {};
      const cp = engine.calculateCP(pokemon);
      
      expect(cp).toBeGreaterThan(0);
    });
  });
  
  describe('IV Generation', () => {
    it('should generate valid IV values', () => {
      const iv = engine.generateIV();
      
      expect(iv.attack).toBeGreaterThanOrEqual(0);
      expect(iv.attack).toBeLessThanOrEqual(15);
      expect(iv.defense).toBeGreaterThanOrEqual(0);
      expect(iv.defense).toBeLessThanOrEqual(15);
      expect(iv.stamina).toBeGreaterThanOrEqual(0);
      expect(iv.stamina).toBeLessThanOrEqual(15);
    });
  });
  
  describe('Geohash Conversion', () => {
    it('should convert geohash to approximate coordinates', () => {
      const coord = engine.geohashToCoord('wm4ez');
      
      expect(coord).toHaveProperty('lat');
      expect(coord).toHaveProperty('lng');
      expect(coord.lat).toBeGreaterThanOrEqual(-90);
      expect(coord.lat).toBeLessThanOrEqual(90);
      expect(coord.lng).toBeGreaterThanOrEqual(-180);
      expect(coord.lng).toBeLessThanOrEqual(180);
    });
  });
  
  describe('Random Offset', () => {
    it('should generate offset within range', () => {
      const offset = engine.randomOffset(100, 300);
      
      const distance = Math.sqrt(offset.lat ** 2 + offset.lng ** 2) * 111000;
      
      expect(distance).toBeGreaterThanOrEqual(100);
      expect(distance).toBeLessThanOrEqual(300);
    });
  });
  
  describe('Spawn Creation', () => {
    it('should create spawn with all required fields', async () => {
      const pokemon = {
        id: 25,
        name: 'Pikachu',
        rarity: 'rare',
        baseAttack: 112,
        baseDefense: 101,
        baseStamina: 111,
        biome: 'forest'
      };
      
      const spawn = await engine.createSpawn(pokemon, 'wm4ez');
      
      expect(spawn).toHaveProperty('id');
      expect(spawn).toHaveProperty('pokemonId', 25);
      expect(spawn).toHaveProperty('pokemonName', 'Pikachu');
      expect(spawn).toHaveProperty('rarity', 'rare');
      expect(spawn).toHaveProperty('location');
      expect(spawn).toHaveProperty('geohash', 'wm4ez');
      expect(spawn).toHaveProperty('spawnedAt');
      expect(spawn).toHaveProperty('despawnAt');
      expect(spawn).toHaveProperty('cp');
      expect(spawn).toHaveProperty('iv');
      
      // Check despawn time is 15-60 minutes in future
      const despawnMinutes = (new Date(spawn.despawnAt) - new Date()) / 60000;
      expect(despawnMinutes).toBeGreaterThanOrEqual(15);
      expect(despawnMinutes).toBeLessThanOrEqual(60);
    });
    
    it('should store spawn in Redis', async () => {
      const pokemon = { id: 1, name: 'Bulbasaur', rarity: 'common' };
      
      await engine.createSpawn(pokemon, 'wm4ez');
      
      expect(mockRedis.hset).toHaveBeenCalled();
      expect(mockRedis.geoadd).toHaveBeenCalled();
      expect(mockRedis.sadd).toHaveBeenCalled();
    });
  });
  
  describe('Get Spawn', () => {
    it('should return null for non-existent spawn', async () => {
      mockRedis.hget.mockResolvedValueOnce(null);
      
      const spawn = await engine.getSpawn('non-existent-id');
      
      expect(spawn).toBeNull();
    });
    
    it('should return spawn data for existing spawn', async () => {
      const mockSpawn = {
        id: 'test-id',
        pokemonId: 25,
        pokemonName: 'Pikachu'
      };
      
      mockRedis.hget.mockResolvedValueOnce(JSON.stringify(mockSpawn));
      
      const spawn = await engine.getSpawn('test-id');
      
      expect(spawn).toEqual(mockSpawn);
    });
  });
  
  describe('Get Nearby Spawns', () => {
    it('should return nearby spawns from geo radius', async () => {
      mockRedis.georadius.mockResolvedValueOnce([
        ['spawn-1', 100],
        ['spawn-2', 200]
      ]);
      
      mockRedis.hget
        .mockResolvedValueOnce(JSON.stringify({ id: 'spawn-1', pokemonId: 25 }))
        .mockResolvedValueOnce(JSON.stringify({ id: 'spawn-2', pokemonId: 133 }));
      
      const spawns = await engine.getNearbySpawns(35.68, 139.76, 500);
      
      expect(spawns).toHaveLength(2);
      expect(spawns[0]).toHaveProperty('distance', 100);
      expect(spawns[1]).toHaveProperty('distance', 200);
    });
    
    it('should return empty array on error', async () => {
      mockRedis.georadius.mockRejectedValueOnce(new Error('Redis error'));
      
      const spawns = await engine.getNearbySpawns(35.68, 139.76, 500);
      
      expect(spawns).toEqual([]);
    });
  });
  
  describe('Event Factor', () => {
    it('should return 1.0 when no events', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      
      const factor = await engine.getEventFactor('wm4ez');
      
      expect(factor).toBe(1.0);
    });
    
    it('should return 2.0 for community day event', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify([
        { type: 'community_day' }
      ]));
      
      const factor = await engine.getEventFactor('wm4ez');
      
      expect(factor).toBe(2.0);
    });
    
    it('should cap at 3.0 for multiple events', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify([
        { type: 'community_day' },
        { type: 'spotlight_hour' },
        { multiplier: 2.0 }
      ]));
      
      const factor = await engine.getEventFactor('wm4ez');
      
      expect(factor).toBe(3.0);
    });
  });
  
  describe('Get Cell Config', () => {
    it('should return default config when not found', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockDb.query.mockResolvedValueOnce({ rows: [] });
      
      const config = await engine.getCellConfig('wm4ez');
      
      expect(config).toHaveProperty('baseSpawnCount', 3);
      expect(config).toHaveProperty('minSpawn', 1);
      expect(config).toHaveProperty('maxSpawn', 10);
    });
    
    it('should return cached config', async () => {
      const mockConfig = {
        base_spawn_count: 5,
        min_spawn: 2,
        max_spawn: 15
      };
      
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(mockConfig));
      
      const config = await engine.getCellConfig('wm4ez');
      
      expect(config.base_spawn_count).toBe(5);
    });
  });
  
  describe('Lifecycle', () => {
    it('should start and stop spawn loop', () => {
      const engine2 = new SpawnEngine({ redis: mockRedis, db: mockDb });
      
      engine2.start();
      expect(engine2.isRunning).toBe(true);
      
      engine2.stop();
      expect(engine2.isRunning).toBe(false);
    });
    
    it('should not start twice', () => {
      const engine2 = new SpawnEngine({ redis: mockRedis, db: mockDb });
      
      engine2.start();
      engine2.start();
      
      expect(engine2.isRunning).toBe(true);
      
      engine2.stop();
    });
  });
});

describe('SpawnEngine Integration', () => {
  it('should calculate spawn count correctly', async () => {
    const engine = new SpawnEngine({ redis: mockRedis, db: mockDb });
    
    // Mock heatmap
    mockRedis.hgetall.mockResolvedValueOnce({
      activePlayers: '10',
      lastUpdate: Date.now().toString()
    });
    
    // Mock cell config
    mockRedis.get.mockResolvedValueOnce(JSON.stringify({
      base_spawn_count: 3,
      min_spawn: 1,
      max_spawn: 10
    }));
    
    // Mock event factor
    mockRedis.get.mockResolvedValueOnce(null);
    
    const count = await engine.calculateSpawnForCell('wm4ez');
    
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(10);
  });
});

// Export for running tests
module.exports = {
  SpawnEngine
};
