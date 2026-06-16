/**
 * TrafficAnalyzer 单元测试
 * REQ-00161: 低峰期服务自动休眠与智能唤醒系统
 */

const TrafficAnalyzer = require('../../shared/TrafficAnalyzer');

// Mock Kafka 和 Redis
jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: jest.fn().mockReturnValue({
      connect: jest.fn(),
      subscribe: jest.fn(),
      run: jest.fn()
    }),
    producer: jest.fn().mockReturnValue({
      connect: jest.fn(),
      send: jest.fn()
    })
  }))
}));

jest.mock('../../shared/redis', () => ({
  get: jest.fn(),
  setex: jest.fn(),
  sadd: jest.fn(),
  srem: jest.fn(),
  smembers: jest.fn().mockResolvedValue([])
}));

jest.mock('../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

describe('TrafficAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new TrafficAnalyzer({
      kafkaBrokers: ['localhost:9092']
    });
  });

  describe('recordRequest', () => {
    it('应该正确记录请求', () => {
      analyzer.recordRequest('user-service', 'user1', '/api/users/profile');

      const minuteKey = Math.floor(Date.now() / 60000);
      const key = `user-service:${minuteKey}`;
      const window = analyzer.windows.minute.get(key);

      expect(window).toBeDefined();
      expect(window.count).toBe(1);
      expect(window.uniqueUsers.has('user1')).toBe(true);
      expect(window.endpoints.get('/api/users/profile')).toBe(1);
    });

    it('应该正确累计多个请求', () => {
      analyzer.recordRequest('pokemon-service', 'user1', '/api/pokemon/list');
      analyzer.recordRequest('pokemon-service', 'user2', '/api/pokemon/list');
      analyzer.recordRequest('pokemon-service', 'user1', '/api/pokemon/detail');

      const minuteKey = Math.floor(Date.now() / 60000);
      const key = `pokemon-service:${minuteKey}`;
      const window = analyzer.windows.minute.get(key);

      expect(window.count).toBe(3);
      expect(window.uniqueUsers.size).toBe(2);
    });
  });

  describe('recordMetrics', () => {
    it('应该正确记录服务指标', () => {
      analyzer.recordMetrics('user-service', {
        cpu: 25.5,
        memory: 512,
        latency: 45
      });

      const minuteKey = Math.floor(Date.now() / 60000);
      const key = `user-service:${minuteKey}`;
      const window = analyzer.windows.minute.get(key);

      expect(window.cpu).toBe(25.5);
      expect(window.memory).toBe(512);
      expect(window.latency).toBe(45);
    });
  });

  describe('getServiceStats', () => {
    it('应该正确计算服务统计', () => {
      // 模拟多个分钟的窗口
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const minuteKey = Math.floor((now - i * 60000) / 60000);
        const key = `pokemon-service:${minuteKey}`;
        analyzer.windows.minute.set(key, {
          count: 10 * (i + 1),
          uniqueUsers: new Set(['user1', 'user2']),
          endpoints: new Map(),
          cpu: 15,
          memory: 256
        });
      }

      const stats = analyzer.getServiceStats('pokemon-service');

      expect(stats.rpm).toBeGreaterThan(0);
      expect(stats.avgCpu).toBe(15);
      expect(stats.sustainedLowCount).toBeGreaterThan(0);
    });

    it('没有数据时应返回默认值', () => {
      const stats = analyzer.getServiceStats('nonexistent-service');

      expect(stats.rpm).toBe(0);
      expect(stats.avgCpu).toBe(0);
      expect(stats.isSleeping).toBe(true);
    });
  });

  describe('getMinReplicas', () => {
    it('核心服务应返回 1', () => {
      expect(analyzer.getMinReplicas('user-service')).toBe(1);
      expect(analyzer.getMinReplicas('gateway')).toBe(1);
    });

    it('非核心服务应返回 0', () => {
      expect(analyzer.getMinReplicas('pokemon-service')).toBe(0);
      expect(analyzer.getMinReplicas('catch-service')).toBe(0);
    });
  });

  describe('getHourlyStats', () => {
    it('应该正确计算小时统计', () => {
      const now = Date.now();
      const minuteKey = Math.floor(now / 60000);

      // 添加一些窗口数据
      analyzer.windows.minute.set(`pokemon-service:${minuteKey}`, {
        count: 100,
        uniqueUsers: new Set(['u1', 'u2', 'u3']),
        endpoints: new Map(),
        cpu: 20,
        memory: 256
      });

      const hourlyStats = analyzer.getHourlyStats();

      expect(hourlyStats).toBeDefined();
      expect(typeof hourlyStats).toBe('object');
    });
  });

  describe('getServiceTrafficHistory', () => {
    it('应该返回服务流量历史', async () => {
      const now = Date.now();
      const minuteKey = Math.floor(now / 60000);

      analyzer.windows.minute.set(`user-service:${minuteKey}`, {
        count: 50,
        uniqueUsers: new Set(['u1']),
        endpoints: new Map(),
        cpu: 10,
        memory: 128
      });

      const history = await analyzer.getServiceTrafficHistory('user-service', 1);

      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('thresholds', () => {
    it('应该有所有服务的阈值配置', () => {
      const services = [
        'user-service',
        'location-service',
        'pokemon-service',
        'catch-service',
        'gym-service',
        'social-service',
        'reward-service',
        'payment-service'
      ];

      services.forEach(service => {
        expect(analyzer.thresholds[service]).toBeDefined();
        expect(analyzer.thresholds[service].lowRpm).toBeDefined();
        expect(analyzer.thresholds[service].lowCpu).toBeDefined();
        expect(analyzer.thresholds[service].wakeRpm).toBeDefined();
      });
    });
  });
});
