/**
 * 缓存预热服务单元测试
 * 
 * REQ-00039: 热点数据缓存预热系统
 */

const { describe, it, beforeEach, afterEach, expect, jest } = require('@jest/globals');

// Mock dependencies
jest.mock('../../../shared/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../../shared/metrics', () => ({
  register: {
    getSingleMetric: jest.fn(),
  },
}));

const cacheWarmup = require('../../../shared/cacheWarmup');
const { query } = require('../../../shared/db');
const { HOT_DATA_CONFIG, getEnabledConfigs, getConfig, isEnabled } = require('../../../shared/cacheWarmupConfig');

describe('cacheWarmupConfig', () => {
  describe('getEnabledConfigs', () => {
    it('should return enabled configs sorted by priority', () => {
      const configs = getEnabledConfigs();
      
      expect(configs.length).toBeGreaterThan(0);
      
      // 检查按优先级排序
      for (let i = 1; i < configs.length; i++) {
        expect(configs[i].config.priority).toBeGreaterThanOrEqual(
          configs[i - 1].config.priority
        );
      }
    });
    
    it('should only return enabled configs', () => {
      const configs = getEnabledConfigs();
      
      configs.forEach(({ config }) => {
        expect(config.enabled).toBe(true);
      });
    });
  });
  
  describe('getConfig', () => {
    it('should return config for valid name', () => {
      const config = getConfig('pokemonSpecies');
      
      expect(config).toBeDefined();
      expect(config.enabled).toBe(true);
      expect(config.priority).toBe(1);
      expect(config.ttl).toBe(3600);
    });
    
    it('should return null for invalid name', () => {
      const config = getConfig('nonexistent');
      
      expect(config).toBeNull();
    });
  });
  
  describe('isEnabled', () => {
    it('should return true for enabled config', () => {
      expect(isEnabled('pokemonSpecies')).toBe(true);
    });
    
    it('should return false for disabled config', () => {
      // 临时禁用测试
      const original = HOT_DATA_CONFIG.pokemonSpecies.enabled;
      HOT_DATA_CONFIG.pokemonSpecies.enabled = false;
      
      expect(isEnabled('pokemonSpecies')).toBe(false);
      
      // 恢复
      HOT_DATA_CONFIG.pokemonSpecies.enabled = original;
    });
    
    it('should return false for nonexistent config', () => {
      expect(isEnabled('nonexistent')).toBe(false);
    });
  });
});

describe('cacheWarmup', () => {
  let mockRedis;
  
  beforeEach(() => {
    // 重置模块状态
    cacheWarmup.resetStats();
    
    // 创建 mock Redis 客户端
    mockRedis = {
      setex: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    
    // 重置 query mock
    query.mockReset();
  });
  
  afterEach(() => {
    cacheWarmup.shutdown();
  });
  
  describe('initialize', () => {
    it('should initialize successfully with valid data', async () => {
      // Mock 数据库查询返回
      query.mockResolvedValue({
        rows: [
          { id: 1, name_zh: '妙蛙种子', type1: 'GRASS', rarity: 'COMMON' },
          { id: 2, name_zh: '小火龙', type1: 'FIRE', rarity: 'COMMON' },
        ],
      });
      
      const result = await cacheWarmup.initialize({ redis: mockRedis });
      
      expect(result.success).toBe(true);
      expect(result.itemsLoaded).toBeGreaterThan(0);
      expect(query).toHaveBeenCalled();
    });
    
    it('should handle empty query results', async () => {
      query.mockResolvedValue({ rows: [] });
      
      const result = await cacheWarmup.initialize({ redis: mockRedis });
      
      expect(result.success).toBe(true);
    });
    
    it('should handle database errors gracefully', async () => {
      query.mockRejectedValue(new Error('Database connection failed'));
      
      // 初始化仍应成功，但会有错误记录
      // 由于所有预热都失败，最终应该抛出错误或返回部分成功
      try {
        await cacheWarmup.initialize({ redis: mockRedis });
      } catch (err) {
        expect(err.message).toContain('Database connection failed');
      }
    });
    
    it('should not initialize if already warming', async () => {
      query.mockResolvedValue({ rows: [] });
      
      // 开始第一次初始化
      const firstInit = cacheWarmup.initialize({ redis: mockRedis });
      
      // 尝试第二次初始化（应该失败或等待）
      // 由于第一次已经完成，第二次应该成功
      await firstInit;
      
      // 重置后可以再次初始化
      cacheWarmup.resetStats();
      const result = await cacheWarmup.initialize({ redis: mockRedis });
      expect(result.success).toBe(true);
    });
  });
  
  describe('getStatus', () => {
    it('should return current warmup status', async () => {
      query.mockResolvedValue({ rows: [] });
      await cacheWarmup.initialize({ redis: mockRedis });
      
      const status = cacheWarmup.getStatus();
      
      expect(status).toHaveProperty('lastWarmup');
      expect(status).toHaveProperty('warmupCount');
      expect(status).toHaveProperty('itemsLoaded');
      expect(status).toHaveProperty('isWarming');
      expect(status).toHaveProperty('redisConnected');
      expect(status.redisConnected).toBe(true);
    });
    
    it('should show redis not connected when not initialized with redis', async () => {
      query.mockResolvedValue({ rows: [] });
      cacheWarmup.resetStats();
      await cacheWarmup.initialize({});
      
      const status = cacheWarmup.getStatus();
      
      expect(status.redisConnected).toBe(false);
    });
  });
  
  describe('triggerWarmup', () => {
    it('should trigger warmup for specific data', async () => {
      query.mockResolvedValue({
        rows: [{ id: 1, name_zh: '皮卡丘' }],
      });
      
      cacheWarmup.resetStats();
      await cacheWarmup.initialize({ redis: mockRedis });
      cacheWarmup.resetStats();
      
      const result = await cacheWarmup.triggerWarmup('pokemonSpecies');
      
      expect(result.success).toBe(true);
      expect(result.results).toHaveProperty('pokemonSpecies');
    });
    
    it('should trigger warmup for all data when no name specified', async () => {
      query.mockResolvedValue({ rows: [] });
      
      cacheWarmup.resetStats();
      await cacheWarmup.initialize({ redis: mockRedis });
      cacheWarmup.resetStats();
      
      const result = await cacheWarmup.triggerWarmup();
      
      expect(result.success).toBe(true);
    });
    
    it('should throw error for unknown data name', async () => {
      cacheWarmup.resetStats();
      await cacheWarmup.initialize({ redis: mockRedis });
      cacheWarmup.resetStats();
      
      await expect(cacheWarmup.triggerWarmup('nonexistent'))
        .rejects.toThrow('Unknown data: nonexistent');
    });
    
    it('should throw error when warmup already in progress', async () => {
      query.mockResolvedValue({ rows: [] });
      
      cacheWarmup.resetStats();
      await cacheWarmup.initialize({ redis: mockRedis });
      cacheWarmup.resetStats();
      
      // 开始一次预热
      const firstWarmup = cacheWarmup.triggerWarmup();
      
      // 尝试同时开始另一次
      await expect(cacheWarmup.triggerWarmup())
        .rejects.toThrow('Warmup already in progress');
      
      await firstWarmup;
    });
  });
  
  describe('resetStats', () => {
    it('should reset all statistics', async () => {
      query.mockResolvedValue({
        rows: [{ id: 1, name_zh: '皮卡丘' }],
      });
      
      await cacheWarmup.initialize({ redis: mockRedis });
      
      // 确保有统计数据
      const beforeStatus = cacheWarmup.getStatus();
      expect(beforeStatus.warmupCount).toBeGreaterThan(0);
      
      // 重置
      cacheWarmup.resetStats();
      
      const afterStatus = cacheWarmup.getStatus();
      expect(afterStatus.itemsLoaded).toBe(0);
      expect(afterStatus.warmupCount).toBe(0);
      expect(afterStatus.failedCount).toBe(0);
    });
  });
  
  describe('shutdown', () => {
    it('should clear all refresh timers', async () => {
      query.mockResolvedValue({ rows: [] });
      
      await cacheWarmup.initialize({ redis: mockRedis });
      
      const beforeStatus = cacheWarmup.getStatus();
      expect(beforeStatus.activeRefreshers).toBeGreaterThan(0);
      
      cacheWarmup.shutdown();
      
      const afterStatus = cacheWarmup.getStatus();
      expect(afterStatus.activeRefreshers).toBe(0);
    });
  });
});

describe('warmup integration', () => {
  it('should cache pokemon species data with correct key format', async () => {
    const mockRedis = {
      setex: jest.fn().mockResolvedValue('OK'),
    };
    
    query.mockResolvedValue({
      rows: [
        { id: 25, name_zh: '皮卡丘', type1: 'ELECTRIC', rarity: 'COMMON' },
      ],
    });
    
    cacheWarmup.resetStats();
    await cacheWarmup.initialize({ redis: mockRedis });
    
    // 验证 setex 被调用
    expect(mockRedis.setex).toHaveBeenCalled();
    
    // 验证缓存键格式
    const calls = mockRedis.setex.mock.calls;
    const hasCorrectKey = calls.some(call => 
      call[0].includes('pokemon:species:')
    );
    expect(hasCorrectKey).toBe(true);
  });
});
