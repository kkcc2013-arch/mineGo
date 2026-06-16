// backend/tests/unit/rateLimitMonitor.test.js
// REQ-00147: 限流绕过检测系统单元测试

'use strict';

const {
  IPRotationDetector,
  AccountDistributionDetector,
  WindowBoundaryDetector,
  RateLimitIntegrityValidator,
  BypassHandler,
  RateLimitMonitor,
} = require('../../shared/rateLimitMonitor');

// Mock Redis
const mockRedis = {
  data: {},
  async zadd(key, score, member) {
    if (!this.data[key]) this.data[key] = [];
    this.data[key].push({ score, member });
  },
  async zrange(key, start, end, withScores) {
    if (!this.data[key]) return [];
    const sorted = this.data[key].sort((a, b) => a.score - b.score);
    if (withScores) {
      return sorted.flatMap(item => [item.member, item.score.toString()]);
    }
    return sorted.map(item => item.member);
  },
  async zremrangebyscore(key, min, max) {
    if (!this.data[key]) return;
    this.data[key] = this.data[key].filter(item => {
      if (min === '-inf') return item.score > max;
      if (max === 'inf') return item.score < min;
      return item.score > min && item.score < max;
    });
  },
  async expire(key, seconds) {},
  async get(key) {
    return this.data[key] || null;
  },
  async set(key, value, mode, duration) {
    this.data[key] = value;
  },
  async del(key) {
    delete this.data[key];
  },
  async hincrby(key, field, value) {
    if (!this.data[key]) this.data[key] = {};
    this.data[key][field] = (this.data[key][field] || 0) + value;
    return this.data[key][field];
  },
  async hget(key, field) {
    return this.data[key]?.[field] || null;
  },
};

// Mock DB
const mockDb = {
  data: { attempts: [], blocks: [] },
  async query(sql, params) {
    if (sql.includes('INSERT INTO rate_limit_bypass_attempts')) {
      const id = this.data.attempts.length + 1;
      this.data.attempts.push({ id, ...params });
      return { rows: [{ id }] };
    }
    if (sql.includes('INSERT INTO rate_limit_blocks')) {
      this.data.blocks.push(params);
      return { rows: [] };
    }
    if (sql.includes('SELECT') && sql.includes('rate_limit_bypass_attempts')) {
      return { rows: [] };
    }
    return { rows: [] };
  },
};

describe('IPRotationDetector', () => {
  let detector;
  
  beforeEach(() => {
    mockRedis.data = {};
    detector = new IPRotationDetector(mockRedis);
  });
  
  test('should detect IP rotation with multiple IPs', async () => {
    const userId = 'user123';
    
    // 模拟多个 IP 访问
    await detector.recordIPAccess(userId, '192.168.1.1');
    await detector.recordIPAccess(userId, '192.168.1.2');
    await detector.recordIPAccess(userId, '192.168.1.3');
    await detector.recordIPAccess(userId, '10.0.0.1');
    
    const result = await detector.detectIPRotation(userId, '10.0.0.2');
    
    expect(result.isRotation).toBe(true);
    expect(result.uniqueIPCount).toBeGreaterThanOrEqual(4);
    expect(result.riskScore).toBeGreaterThan(0);
  });
  
  test('should not detect rotation with few IPs', async () => {
    const userId = 'user456';
    
    await detector.recordIPAccess(userId, '192.168.1.1');
    await detector.recordIPAccess(userId, '192.168.1.1');
    
    const result = await detector.detectIPRotation(userId, '192.168.1.1');
    
    expect(result.uniqueIPCount).toBe(1);
    expect(result.riskScore).toBe(0);
  });
  
  test('should calculate geo spread correctly', () => {
    const ips = ['192.168.1.1', '192.168.1.2', '10.0.0.1'];
    const spread = detector.calculateGeoSpread(ips);
    
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThanOrEqual(1);
  });
});

describe('AccountDistributionDetector', () => {
  let detector;
  
  beforeEach(() => {
    mockRedis.data = {};
    detector = new AccountDistributionDetector(mockRedis);
  });
  
  test('should detect account distribution', async () => {
    const ip = '192.168.1.100';
    
    // 模拟多账号访问
    await detector.recordAccountAccess(ip, 'user1', '/api/catch');
    await detector.recordAccountAccess(ip, 'user2', '/api/catch');
    await detector.recordAccountAccess(ip, 'user3', '/api/catch');
    await detector.recordAccountAccess(ip, 'user4', '/api/catch');
    
    const result = await detector.detectAccountDistribution(ip);
    
    expect(result.accountCount).toBeGreaterThanOrEqual(4);
  });
  
  test('should calculate time correlation', () => {
    // 高度同步的请求
    const timestamps1 = [1000, 1010, 1020, 1030, 1040];
    const correlation1 = detector.calculateTimeCorrelation(timestamps1);
    expect(correlation1).toBeGreaterThan(0.5);
    
    // 随机分布的请求
    const timestamps2 = [1000, 2000, 5000, 8000, 15000];
    const correlation2 = detector.calculateTimeCorrelation(timestamps2);
    expect(correlation2).toBeLessThan(correlation1);
  });
});

describe('WindowBoundaryDetector', () => {
  let detector;
  
  beforeEach(() => {
    mockRedis.data = {};
    detector = new WindowBoundaryDetector(mockRedis);
  });
  
  test('should detect boundary attack', async () => {
    const userId = 'user789';
    const endpoint = '/api/catch';
    
    // 模拟窗口边界集中请求
    const now = Date.now();
    const windowStart = Math.floor(now / 60000) * 60000;
    
    // 在窗口末尾添加多个请求
    for (let i = 0; i < 10; i++) {
      await mockRedis.zadd(
        `ratelimit:requests:${userId}:${endpoint}`,
        windowStart + 59000 - i * 100,
        (windowStart + 59000 - i * 100).toString()
      );
    }
    
    const result = await detector.detectBoundaryAttack(userId, endpoint);
    
    expect(result.boundaryRatio).toBeGreaterThan(0);
  });
  
  test('should not detect attack with normal distribution', async () => {
    const userId = 'user-normal';
    const endpoint = '/api/catch';
    
    // 正常分布的请求
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await mockRedis.zadd(
        `ratelimit:requests:${userId}:${endpoint}`,
        now - i * 10000,
        (now - i * 10000).toString()
      );
    }
    
    const result = await detector.detectBoundaryAttack(userId, endpoint);
    
    expect(result.totalCount).toBeGreaterThanOrEqual(5);
  });
});

describe('RateLimitIntegrityValidator', () => {
  let validator;
  
  beforeEach(() => {
    mockRedis.data = {};
    validator = new RateLimitIntegrityValidator(mockRedis);
  });
  
  test('should validate correct state', async () => {
    mockRedis.data['ratelimit:test'] = '100';
    
    const result = await validator.validateRateLimitState('ratelimit:test', 100);
    
    expect(result.valid).toBe(true);
    expect(result.tampered).toBe(false);
  });
  
  test('should detect tampered state', async () => {
    mockRedis.data['ratelimit:test'] = '50'; // 被篡改为较低的值
    
    const result = await validator.validateRateLimitState('ratelimit:test', 100);
    
    expect(result.valid).toBe(false);
    expect(result.tampered).toBe(true);
    expect(result.discrepancyRatio).toBeGreaterThan(0.1);
  });
  
  test('should reset tampered state', async () => {
    mockRedis.data['ratelimit:test'] = '50';
    
    await validator.resetTamperedState('ratelimit:test', 100);
    
    expect(mockRedis.data['ratelimit:test']).toBe('100');
  });
});

describe('BypassHandler', () => {
  let handler;
  
  beforeEach(() => {
    mockRedis.data = {};
    mockDb.data = { attempts: [], blocks: [] };
    handler = new BypassHandler(mockDb, mockRedis);
  });
  
  test('should record bypass attempt', async () => {
    const attempt = {
      userId: 'user123',
      ip: '192.168.1.1',
      type: 'ip_rotation',
      riskScore: 80,
      details: { uniqueIPCount: 5 },
      blocked: true,
    };
    
    const id = await handler.recordBypassAttempt(attempt);
    
    expect(id).toBeDefined();
    expect(mockDb.data.attempts.length).toBe(1);
  });
  
  test('should block user with high risk score', async () => {
    const detection = {
      type: 'ip_rotation',
      riskScore: 90,
      uniqueIPCount: 10,
    };
    
    const result = await handler.handleBypass(detection, 'user123', '192.168.1.1');
    
    expect(result.blocked).toBe(true);
    expect(result.riskScore).toBe(90);
  });
  
  test('should not block user with low risk score', async () => {
    const detection = {
      type: 'ip_rotation',
      riskScore: 30,
      uniqueIPCount: 2,
    };
    
    const result = await handler.handleBypass(detection, 'user456', '192.168.1.1');
    
    expect(result.blocked).toBe(false);
  });
  
  test('should check blocked status', async () => {
    await handler.blockUser('user-blocked', 'test', 100);
    
    const blocked = await handler.checkBlocked('user-blocked');
    
    expect(blocked).toBeDefined();
    expect(blocked.reason).toBe('test');
  });
});

describe('RateLimitMonitor', () => {
  let monitor;
  
  beforeEach(() => {
    mockRedis.data = {};
    mockDb.data = { attempts: [], blocks: [] };
    monitor = new RateLimitMonitor({
      redis: mockRedis,
      db: mockDb,
    });
  });
  
  test('should perform comprehensive check', async () => {
    const result = await monitor.comprehensiveCheck(
      'user123',
      '192.168.1.1',
      '/api/catch'
    );
    
    expect(result).toHaveProperty('ipRotation');
    expect(result).toHaveProperty('accountDistribution');
    expect(result).toHaveProperty('boundaryAttack');
    expect(result).toHaveProperty('riskScore');
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
  });
  
  test('should return early if blocked', async () => {
    // 先封禁用户
    await monitor.bypassHandler.blockUser('user-blocked', 'test', 100);
    
    const result = await monitor.comprehensiveCheck(
      'user-blocked',
      '192.168.1.1',
      '/api/catch'
    );
    
    expect(result.blocked).toBe(true);
    expect(result.riskScore).toBe(100);
  });
  
  test('should get stats', async () => {
    const stats = await monitor.getStats();
    
    expect(stats).toHaveProperty('realtime');
    expect(stats).toHaveProperty('historical');
  });
  
  test('should respect enabled flag', async () => {
    const disabledMonitor = new RateLimitMonitor({
      redis: mockRedis,
      db: mockDb,
      enabled: false,
    });
    
    const result = await disabledMonitor.comprehensiveCheck(
      'user123',
      '192.168.1.1',
      '/api/catch'
    );
    
    expect(result.enabled).toBe(false);
  });
});
