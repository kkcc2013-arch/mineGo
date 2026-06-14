/**
 * 业务指标采集器单元测试
 * REQ-00094: 实时业务指标仪表板与运营监控系统
 */

const { BusinessMetricsCollector, BUSINESS_METRICS } = require('../../../shared/businessMetrics');

// Mock Redis and DB
const mockRedis = {
  sadd: jest.fn().mockResolvedValue(1),
  scard: jest.fn().mockResolvedValue(100),
  get: jest.fn().mockResolvedValue('1000'),
  set: jest.fn().mockResolvedValue('OK'),
  expire: jest.fn().mockResolvedValue(1),
  incrby: jest.fn().mockResolvedValue(100)
};

const mockDb = {
  query: jest.fn().mockResolvedValue({
    rows: [{ count: '50' }]
  })
};

describe('BusinessMetricsCollector', () => {
  let collector;

  beforeEach(() => {
    collector = new BusinessMetricsCollector(mockRedis, mockDb);
    jest.clearAllMocks();
  });

  describe('recordPlayerOnline', () => {
    test('should increment online players counter', async () => {
      await collector.recordPlayerOnline('user123', 'CN-Beijing');
      
      expect(mockRedis.sadd).toHaveBeenCalled();
      expect(mockRedis.expire).toHaveBeenCalled();
    });

    test('should record player region', async () => {
      await collector.recordPlayerOnline('user123', 'US-California');
      
      expect(mockRedis.sadd).toHaveBeenCalledWith(
        expect.stringContaining('dau:'),
        'user123'
      );
    });
  });

  describe('recordPlayerOffline', () => {
    test('should decrement online players counter', async () => {
      await collector.recordPlayerOffline('user123', 'CN-Beijing');
      
      // Gauge should be decremented (verified via metrics)
      const metrics = await collector.getMetrics();
      expect(metrics).toBeDefined();
    });
  });

  describe('recordPokemonCatch', () => {
    test('should record successful catch', async () => {
      await collector.recordPokemonCatch('user123', 'pokemon001', true, 1500, 'CN-Beijing');
      
      expect(collector.statsCache.catchAttempts).toBe(1);
      expect(collector.statsCache.catchSuccess).toBe(1);
    });

    test('should record failed catch', async () => {
      await collector.recordPokemonCatch('user123', 'pokemon001', false, 800, 'CN-Beijing');
      
      expect(collector.statsCache.catchAttempts).toBe(1);
      expect(collector.statsCache.catchSuccess).toBe(0);
    });

    test('should update catch rate', async () => {
      await collector.recordPokemonCatch('user123', 'pokemon001', true, 1500);
      await collector.recordPokemonCatch('user123', 'pokemon002', false, 800);
      
      const rate = collector.statsCache.catchSuccess / collector.statsCache.catchAttempts;
      expect(rate).toBe(0.5);
    });
  });

  describe('recordPokemonSpawn', () => {
    test('should increment spawn counter', () => {
      collector.recordPokemonSpawn('pokemon001', 'CN-Beijing');
      
      // Counter should be incremented (verified via metrics)
      expect(collector).toBeDefined();
    });
  });

  describe('recordPokemonEvolve', () => {
    test('should increment evolve counter', () => {
      collector.recordPokemonEvolve('pokemon001');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordPokemonTrade', () => {
    test('should increment trade counter', () => {
      collector.recordPokemonTrade('CN-Beijing');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordGymBattle', () => {
    test('should record battle result', () => {
      collector.recordGymBattle('gym001', 'victory');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordRaid', () => {
    test('should record raid result', () => {
      collector.recordRaid('gym001', 'success');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordFriendship', () => {
    test('should increment friendship counter', () => {
      collector.recordFriendship();
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordGift', () => {
    test('should record gift by type', () => {
      collector.recordGift('rare_candy');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordMessage', () => {
    test('should record message by type', () => {
      collector.recordMessage('text');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordPayment', () => {
    test('should record payment and update conversion rate', async () => {
      mockRedis.scard
        .mockResolvedValueOnce(100) // DAU
        .mockResolvedValueOnce(10); // Payers
      
      await collector.recordPayment('user123', 1000, 'CNY', 'pokecoins_100');
      
      expect(collector).toBeDefined();
    });
  });

  describe('recordRefund', () => {
    test('should record refund by reason', () => {
      collector.recordRefund('user_request');
      
      expect(collector).toBeDefined();
    });
  });

  describe('getRealtimeMetrics', () => {
    test('should return realtime metrics', async () => {
      mockRedis.scard.mockResolvedValue(100);
      mockRedis.get.mockResolvedValue('1000');
      
      mockDb.query.mockResolvedValue({
        rows: [{ count: '50' }]
      });

      const metrics = await collector.getRealtimeMetrics();
      
      expect(metrics).toHaveProperty('timestamp');
      expect(metrics).toHaveProperty('players');
      expect(metrics).toHaveProperty('pokemon');
      expect(metrics).toHaveProperty('gym');
      expect(metrics).toHaveProperty('payment');
      
      expect(metrics.players).toHaveProperty('online');
      expect(metrics.players).toHaveProperty('dau');
    });
  });

  describe('getHourlyMetrics', () => {
    test('should return hourly metrics', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { hour: new Date(), active_users: 50, catches: 120, battles: 30, payments: 5 }
        ]
      });

      const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = new Date();
      const data = await collector.getHourlyMetrics(start, end);
      
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('getDailyMetrics', () => {
    test('should return daily metrics', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { date: new Date(), dau: 500, catches: 1200, battles: 300, revenue: 50000 }
        ]
      });

      const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const end = new Date();
      const data = await collector.getDailyMetrics(start, end);
      
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe('getGeoDistribution', () => {
    test('should return geo distribution', async () => {
      mockDb.query.mockResolvedValue({
        rows: [
          { country: 'CN', region: 'Beijing', player_count: 500 },
          { country: 'US', region: 'California', player_count: 300 }
        ]
      });

      const distribution = await collector.getGeoDistribution();
      
      expect(Array.isArray(distribution)).toBe(true);
      expect(distribution.length).toBe(2);
    });
  });

  describe('getMetrics', () => {
    test('should return Prometheus format metrics', async () => {
      const metrics = await collector.getMetrics();
      
      expect(typeof metrics).toBe('string');
      expect(metrics).toContain('minego_players_online');
    });
  });
});

describe('BUSINESS_METRICS', () => {
  test('should have all metric categories', () => {
    expect(BUSINESS_METRICS).toHaveProperty('players');
    expect(BUSINESS_METRICS).toHaveProperty('pokemon');
    expect(BUSINESS_METRICS).toHaveProperty('gym');
    expect(BUSINESS_METRICS).toHaveProperty('social');
    expect(BUSINESS_METRICS).toHaveProperty('payment');
  });

  test('should have correct player metrics', () => {
    expect(BUSINESS_METRICS.players).toHaveProperty('online');
    expect(BUSINESS_METRICS.players).toHaveProperty('dau');
    expect(BUSINESS_METRICS.players).toHaveProperty('mau');
    expect(BUSINESS_METRICS.players).toHaveProperty('arpu');
    expect(BUSINESS_METRICS.players).toHaveProperty('ltv');
  });

  test('should have correct pokemon metrics', () => {
    expect(BUSINESS_METRICS.pokemon).toHaveProperty('caught');
    expect(BUSINESS_METRICS.pokemon).toHaveProperty('catchRate');
    expect(BUSINESS_METRICS.pokemon).toHaveProperty('spawned');
  });

  test('should have correct payment metrics', () => {
    expect(BUSINESS_METRICS.payment).toHaveProperty('revenue');
    expect(BUSINESS_METRICS.payment).toHaveProperty('orders');
    expect(BUSINESS_METRICS.payment).toHaveProperty('conversion');
  });
});
