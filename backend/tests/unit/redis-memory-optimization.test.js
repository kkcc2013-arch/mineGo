/**
 * Redis 内存优化与自动 TTL 策略 - 单元测试
 * REQ-00070
 */

const {
  TTL_STRATEGY,
  TTL_BUCKETS,
  getTTLBucket,
  validateTTL,
  getRecommendedTTL
} = require('../cacheTTLConfig');

const { RedisMemoryAnalyzer } = require('../redisMemoryAnalyzer');
const { RedisCleanupTask, getRedisCleanupTask } = require('../redisCleanupTask');

// Mock dependencies
jest.mock('../logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../metrics', () => ({
  incrementCounter: jest.fn(),
  gauge: jest.fn(),
  observeHistogram: jest.fn()
}));

describe('TTL Strategy Configuration', () => {
  describe('TTL_STRATEGY', () => {
    test('应该定义所有必要的 TTL 类别', () => {
      expect(TTL_STRATEGY.POKEDEX).toBe(86400); // 24 小时
      expect(TTL_STRATEGY.SPECIES_DETAIL).toBe(43200); // 12 小时
      expect(TTL_STRATEGY.USER_PROFILE).toBe(300); // 5 分钟
      expect(TTL_STRATEGY.NEARBY_GYMS).toBe(60); // 1 分钟
      expect(TTL_STRATEGY.JWT_BLACKLIST).toBe(604800); // 7 天
    });

    test('静态数据 TTL 应该 >= 12 小时', () => {
      expect(TTL_STRATEGY.POKEDEX).toBeGreaterThanOrEqual(43200);
      expect(TTL_STRATEGY.SKILLS).toBeGreaterThanOrEqual(43200);
      expect(TTL_STRATEGY.ITEMS).toBeGreaterThanOrEqual(43200);
    });

    test('动态数据 TTL 应该 <= 2 分钟', () => {
      expect(TTL_STRATEGY.NEARBY_GYMS).toBeLessThanOrEqual(120);
      expect(TTL_STRATEGY.NEARBY_RAIDS).toBeLessThanOrEqual(120);
      expect(TTL_STRATEGY.WILD_POKEMON).toBeLessThanOrEqual(120);
    });

    test('用户数据 TTL 应该在 1-10 分钟之间', () => {
      const userTTL = TTL_STRATEGY.USER_PROFILE;
      expect(userTTL).toBeGreaterThanOrEqual(60);
      expect(userTTL).toBeLessThanOrEqual(600);
    });
  });

  describe('TTL_BUCKETS', () => {
    test('应该定义 8 个时间桶', () => {
      expect(TTL_BUCKETS).toHaveLength(8);
    });

    test('时间桶应该覆盖从无 TTL 到 >1 周的范围', () => {
      expect(TTL_BUCKETS[0].label).toBe('no_ttl');
      expect(TTL_BUCKETS[TTL_BUCKETS.length - 1].label).toBe('>1w');
    });
  });

  describe('getTTLBucket', () => {
    test('应该正确识别无 TTL', () => {
      expect(getTTLBucket(null)).toBe('no_ttl');
      expect(getTTLBucket(undefined)).toBe('no_ttl');
      expect(getTTLBucket(-1)).toBe('no_ttl');
    });

    test('应该正确分类 < 1 分钟的 TTL', () => {
      expect(getTTLBucket(30)).toBe('<1m');
      expect(getTTLBucket(59)).toBe('<1m');
    });

    test('应该正确分类 1-5 分钟的 TTL', () => {
      expect(getTTLBucket(60)).toBe('1m-5m');
      expect(getTTLBucket(300)).toBe('1m-5m');
      expect(getTTLBucket(299)).toBe('1m-5m');
    });

    test('应该正确分类 > 1 周的 TTL', () => {
      expect(getTTLBucket(604801)).toBe('>1w');
      expect(getTTLBucket(1000000)).toBe('>1w');
    });
  });

  describe('validateTTL', () => {
    test('应该拒绝未知类别', () => {
      const result = validateTTL('UNKNOWN_CATEGORY', 300);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown category');
    });

    test('应该拒绝无效的 TTL', () => {
      const result = validateTTL('USER_PROFILE', 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be a positive number');
    });

    test('应该接受有效的 TTL', () => {
      const result = validateTTL('USER_PROFILE', 300);
      expect(result.valid).toBe(true);
      expect(result.recommendedTTL).toBe(300);
    });

    test('应该警告偏离推荐值过多的 TTL', () => {
      const result = validateTTL('USER_PROFILE', 1000); // 推荐值是 300
      expect(result.valid).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('deviates');
    });
  });

  describe('getRecommendedTTL', () => {
    test('应该返回推荐的 TTL', () => {
      expect(getRecommendedTTL('USER_PROFILE')).toBe(300);
      expect(getRecommendedTTL('POKEDEX')).toBe(86400);
    });

    test('未知类别应该返回默认 TTL', () => {
      expect(getRecommendedTTL('UNKNOWN')).toBe(300); // API_RESPONSE 默认值
    });
  });
});

describe('Redis Memory Analyzer', () => {
  let analyzer;
  let mockRedis;

  beforeEach(() => {
    // 创建 mock Redis 客户端
    mockRedis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      info: jest.fn().mockResolvedValue(`
used_memory:1000000
used_memory_human:1.00M
maxmemory:2000000
maxmemory_human:2.00M
mem_fragmentation_ratio:1.2
used_memory_peak:1500000
used_memory_peak_human:1.50M
      `),
      scan: jest.fn()
        .mockResolvedValueOnce(['0', ['key1', 'key2', 'key3']])
        .mockResolvedValueOnce(['0', []]),
      type: jest.fn()
        .mockResolvedValueOnce('string')
        .mockResolvedValueOnce('hash')
        .mockResolvedValueOnce('list'),
      ttl: jest.fn()
        .mockResolvedValueOnce(300)
        .mockResolvedValueOnce(-1) // 无 TTL
        .mockResolvedValueOnce(600),
      memory: jest.fn()
        .mockResolvedValueOnce(1000)
        .mockResolvedValueOnce(2000)
        .mockResolvedValueOnce(500),
      object: jest.fn(),
      del: jest.fn(),
      quit: jest.fn(),
      call: jest.fn(),
      pipeline: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          [null, 'string'],
          [null, 'hash'],
          [null, 'list']
        ])
      })
    };

    analyzer = new RedisMemoryAnalyzer({ redisUrl: 'redis://localhost:6379' });
    analyzer.redis = mockRedis;
    analyzer.isInitialized = true;
  });

  afterEach(async () => {
    if (analyzer) {
      await analyzer.close();
    }
  });

  describe('getMemoryInfo', () => {
    test('应该正确解析 Redis 内存信息', async () => {
      const memoryInfo = await analyzer.getMemoryInfo();
      
      expect(memoryInfo.usedMemory).toBe(1000000);
      expect(memoryInfo.maxMemory).toBe(2000000);
      expect(memoryInfo.usagePercent).toBe('50.00');
      expect(memoryInfo.fragmentationRatio).toBe(1.2);
    });

    test('应该正确计算内存使用率', async () => {
      const memoryInfo = await analyzer.getMemoryInfo();
      
      expect(parseFloat(memoryInfo.usagePercent)).toBe(50);
    });
  });

  describe('getKeyTypeDistribution', () => {
    test('应该正确统计 Key 类型分布', async () => {
      const distribution = await analyzer.getKeyTypeDistribution();
      
      expect(distribution.total).toBe(3);
      expect(distribution.types.string).toBe(1);
      expect(distribution.types.hash).toBe(1);
      expect(distribution.types.list).toBe(1);
    });
  });

  describe('countKeysWithoutTTL', () => {
    test('应该正确统计无 TTL 的 Key 数量', async () => {
      mockRedis.pipeline = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          [null, 300],
          [null, -1], // 无 TTL
          [null, 600]
        ])
      });
      
      const count = await analyzer.countKeysWithoutTTL();
      
      expect(count).toBe(1);
    });
  });

  describe('getTopKeys', () => {
    test('应该返回内存占用最高的 Top N Key', async () => {
      const topKeys = await analyzer.getTopKeys(3);
      
      expect(topKeys).toHaveLength(3);
      expect(topKeys[0].memoryBytes).toBeDefined();
      expect(topKeys[0].memoryHuman).toBeDefined();
    });
  });

  describe('generateRecommendations', () => {
    test('应该为高内存使用率生成告警', () => {
      const memoryInfo = {
        usagePercent: '85',
        fragmentationRatio: 1.0
      };
      
      const recommendations = analyzer.generateRecommendations(memoryInfo, 0);
      
      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].severity).toBe('critical');
      expect(recommendations[0].message).toContain('85%');
    });

    test('应该为大量无 TTL Key 生成建议', () => {
      const memoryInfo = {
        usagePercent: '50',
        fragmentationRatio: 1.0
      };
      
      const recommendations = analyzer.generateRecommendations(memoryInfo, 1500);
      
      const ttlRecommendation = recommendations.find(r => r.category === 'ttl');
      expect(ttlRecommendation).toBeDefined();
      expect(ttlRecommendation.message).toContain('1500');
    });

    test('应该为高内存碎片率生成建议', () => {
      const memoryInfo = {
        usagePercent: '50',
        fragmentationRatio: 2.0
      };
      
      const recommendations = analyzer.generateRecommendations(memoryInfo, 0);
      
      const fragRecommendation = recommendations.find(r => r.category === 'fragmentation');
      expect(fragRecommendation).toBeDefined();
      expect(fragRecommendation.message).toContain('2.00');
    });
  });

  describe('analyze', () => {
    test('应该生成完整的内存分析报告', async () => {
      const report = await analyzer.analyze();
      
      expect(report.timestamp).toBeDefined();
      expect(report.duration).toBeDefined();
      expect(report.memory).toBeDefined();
      expect(report.keys).toBeDefined();
      expect(report.topKeys).toBeDefined();
      expect(report.ttlDistribution).toBeDefined();
      expect(report.recommendations).toBeDefined();
    });
  });
});

describe('Redis Cleanup Task', () => {
  let cleanupTask;
  let mockRedis;
  let mockAnalyzer;

  beforeEach(() => {
    mockRedis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      scan: jest.fn()
        .mockResolvedValueOnce(['0', ['key1', 'key2']])
        .mockResolvedValueOnce(['0', []]),
      ttl: jest.fn()
        .mockResolvedValueOnce(-1) // 无 TTL
        .mockResolvedValueOnce(300),
      object: jest.fn()
        .mockResolvedValueOnce(8 * 24 * 60 * 60), // 8 天未访问
      memory: jest.fn()
        .mockResolvedValueOnce(1000),
      del: jest.fn(),
      call: jest.fn(),
      quit: jest.fn()
    };

    mockAnalyzer = {
      init: jest.fn(),
      analyze: jest.fn().mockResolvedValue({
        memory: { usagePercent: '50' },
        recommendations: []
      }),
      close: jest.fn()
    };

    cleanupTask = new RedisCleanupTask({
      redisUrl: 'redis://localhost:6379',
      idleThresholdDays: 7
    });
    cleanupTask.redis = mockRedis;
    cleanupTask.analyzer = mockAnalyzer;
    cleanupTask.isRunning = false;
  });

  afterEach(async () => {
    if (cleanupTask) {
      await cleanupTask.close();
    }
  });

  describe('cleanStaleKeys', () => {
    test('应该删除长时间未访问的无 TTL Key', async () => {
      const result = await cleanupTask.cleanStaleKeys();
      
      expect(result.cleanedCount).toBeGreaterThanOrEqual(0);
      expect(mockRedis.object).toHaveBeenCalledWith('idletime', 'key1');
    });

    test('不应该删除有 TTL 的 Key', async () => {
      mockRedis.ttl = jest.fn()
        .mockResolvedValueOnce(300) // 有 TTL
        .mockResolvedValueOnce(600);
      
      const result = await cleanupTask.cleanStaleKeys();
      
      expect(result.cleanedCount).toBe(0);
    });

    test('不应该删除未超过阈值的 Key', async () => {
      mockRedis.object = jest.fn()
        .mockResolvedValueOnce(5 * 24 * 60 * 60); // 5 天未访问（未超过 7 天阈值）
      
      const result = await cleanupTask.cleanStaleKeys();
      
      expect(result.cleanedCount).toBe(0);
    });
  });

  describe('defragment', () => {
    test('应该触发内存碎片整理', async () => {
      cleanupTask.enableDefrag = true;
      
      const result = await cleanupTask.defragment();
      
      expect(result.enabled).toBe(true);
      expect(mockRedis.call).toHaveBeenCalledWith('MEMORY', 'PURGE');
    });

    test('当禁用时不应该触发整理', async () => {
      cleanupTask.enableDefrag = false;
      
      const result = await cleanupTask.defragment();
      
      expect(result.enabled).toBe(false);
      expect(mockRedis.call).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    test('应该执行完整的清理流程', async () => {
      const result = await cleanupTask.run();
      
      expect(result.success).toBe(true);
      expect(result.duration).toBeDefined();
      expect(result.cleanedKeys).toBeDefined();
    });

    test('应该更新统计信息', async () => {
      await cleanupTask.run();
      
      const stats = cleanupTask.getStats();
      
      expect(stats.lastRun).toBeDefined();
      expect(stats.totalRuns).toBe(1);
    });

    test('当已在运行时应该返回 null', async () => {
      cleanupTask.isRunning = true;
      
      const result = await cleanupTask.run();
      
      expect(result).toBeNull();
    });
  });
});

describe('Cache TTL Enforcement (REQ-00070)', () => {
  let mockRedis;
  let cache;

  beforeEach(() => {
    jest.resetModules();
    
    mockRedis = {
      setex: jest.fn(),
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      ttl: jest.fn(),
      on: jest.fn()
    };

    // Mock Redis
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => mockRedis);
    });

    // 重新加载 cache 模块
    cache = require('../cache');
  });

  describe('set function with TTL enforcement', () => {
    test('应该拒绝无 TTL 的缓存设置', async () => {
      await expect(cache.set('test:key', { data: 'value' }))
        .rejects.toThrow('must have a valid TTL');
    });

    test('应该拒绝 TTL <= 0 的缓存设置', async () => {
      await expect(cache.set('test:key', { data: 'value' }, 0))
        .rejects.toThrow('must have a valid TTL');
    });

    test('应该接受有效的 TTL', async () => {
      await cache.set('test:key', { data: 'value' }, 300);
      
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test:key',
        300,
        JSON.stringify({ data: 'value' })
      );
    });

    test('允许 allowNoTTL 选项', async () => {
      await cache.set('test:key', { data: 'value' }, 0, { allowNoTTL: true });
      
      expect(mockRedis.set).toHaveBeenCalled();
    });
  });
});

describe('Integration Tests', () => {
  test('TTL 策略应该与缓存设置一致', () => {
    // 验证所有 TTL_STRATEGY 中定义的类别都有合理的值
    const categories = Object.keys(TTL_STRATEGY);
    
    categories.forEach(category => {
      const ttl = TTL_STRATEGY[category];
      
      // TTL 应该是正数
      expect(ttl).toBeGreaterThan(0);
      
      // TTL 应该合理（1 秒 - 30 天）
      expect(ttl).toBeGreaterThanOrEqual(1);
      expect(ttl).toBeLessThanOrEqual(2592000);
    });
  });

  test('TTL 桶应该覆盖所有可能的 TTL 范围', () => {
    const testCases = [
      { ttl: -1, expected: 'no_ttl' },
      { ttl: 30, expected: '<1m' },
      { ttl: 120, expected: '1m-5m' },
      { ttl: 600, expected: '5m-30m' },
      { ttl: 2000, expected: '30m-1h' },
      { ttl: 10000, expected: '1h-1d' },
      { ttl: 100000, expected: '1d-1w' },
      { ttl: 1000000, expected: '>1w' }
    ];
    
    testCases.forEach(({ ttl, expected }) => {
      expect(getTTLBucket(ttl)).toBe(expected);
    });
  });
});
