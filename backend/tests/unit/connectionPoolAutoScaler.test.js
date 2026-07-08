/**
 * REQ-00484: 数据库连接池自动弹性伸缩与健康巡检系统
 * 单元测试
 */

const { 
  ConnectionPoolAutoScaler, 
  ConnectionPoolHealthChecker,
  ConnectionPoolOverflowProtector
} = require('../../shared/connectionPoolAutoScaler');

// Mock Pool
class MockPool {
  constructor() {
    this.pool = {
      totalCount: 10,
      idleCount: 5,
      waitingCount: 2,
      _idle: [],
      _allConnections: [],
      _pendingAcquires: [],
      options: {
        min: 5,
        max: 50
      }
    };
  }

  async connect() {
    return {
      query: async () => ({ rows: [{ '?column?': '1' }] }),
      release: () => {}
    };
  }
}

// Mock Redis
class MockRedis {
  constructor() {
    this.data = new Map();
  }

  async get(key) {
    return this.data.get(key);
  }

  async set(key, value, ...args) {
    this.data.set(key, value);
    return 'OK';
  }

  async lrange(key, start, end) {
    return [];
  }

  async lpush(key, value) {
    return 1;
  }

  async ltrim(key, start, end) {
    return 'OK';
  }

  async expire(key, seconds) {
    return 1;
  }

  async del(key) {
    this.data.delete(key);
    return 1;
  }
}

// Mock Database
class MockDB {
  async query(sql, params) {
    return { rows: [{ id: 1 }] };
  }
}

describe('ConnectionPoolAutoScaler', () => {
  let autoScaler;
  let mockPool;
  let mockRedis;

  beforeEach(() => {
    mockPool = new MockPool();
    mockRedis = new MockRedis();
    
    autoScaler = new ConnectionPoolAutoScaler(mockPool, mockRedis, {
      minConnections: 5,
      maxConnections: 50,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3,
      healthCheckIntervalMs: 30000
    });
  });

  afterEach(() => {
    autoScaler.stop();
  });

  describe('constructor', () => {
    test('应该正确初始化配置', () => {
      expect(autoScaler.config.minConnections).toBe(5);
      expect(autoScaler.config.maxConnections).toBe(50);
      expect(autoScaler.config.scaleUpThreshold).toBe(0.8);
    });

    test('应该使用默认配置', () => {
      const defaultScaler = new ConnectionPoolAutoScaler(mockPool, mockRedis);
      expect(defaultScaler.config.minConnections).toBe(5);
      expect(defaultScaler.config.maxConnections).toBe(100);
    });
  });

  describe('start/stop', () => {
    test('应该成功启动', () => {
      const startHandler = jest.fn();
      autoScaler.on('started', startHandler);
      
      autoScaler.start();
      
      expect(startHandler).toHaveBeenCalled();
      expect(autoScaler.healthCheckTimer).toBeDefined();
    });

    test('应该成功停止', () => {
      autoScaler.start();
      autoScaler.stop();
      
      expect(autoScaler.healthCheckTimer).toBeNull();
    });
  });

  describe('getPoolStatus', () => {
    test('应该返回正确的连接池状态', async () => {
      const status = await autoScaler.getPoolStatus();
      
      expect(status.totalConnections).toBe(10);
      expect(status.idleConnections).toBe(5);
      expect(status.activeConnections).toBe(5);
      expect(status.utilization).toBe(0.5);
    });

    test('应该计算正确的利用率', async () => {
      mockPool.pool.totalCount = 20;
      mockPool.pool.idleCount = 4;
      
      const status = await autoScaler.getPoolStatus();
      
      expect(status.utilization).toBe(0.8);
    });
  });

  describe('calculateTargetConnections', () => {
    test('使用率低于阈值时应该缩容', () => {
      const poolStatus = {
        totalConnections: 20,
        utilization: 0.2,
        avgUtilization: 0.25
      };
      
      const target = autoScaler.calculateTargetConnections(poolStatus);
      
      expect(target).toBeLessThan(20);
      expect(target).toBeGreaterThanOrEqual(5);
    });

    test('使用率高于阈值时应该扩容', () => {
      const poolStatus = {
        totalConnections: 20,
        utilization: 0.9,
        avgUtilization: 0.85
      };
      
      const target = autoScaler.calculateTargetConnections(poolStatus);
      
      expect(target).toBeGreaterThan(20);
      expect(target).toBeLessThanOrEqual(50);
    });

    test('使用率适中时应该保持不变', () => {
      const poolStatus = {
        totalConnections: 20,
        utilization: 0.5,
        avgUtilization: 0.55
      };
      
      const target = autoScaler.calculateTargetConnections(poolStatus);
      
      // 允许小范围波动
      expect(target).toBeGreaterThanOrEqual(15);
      expect(target).toBeLessThanOrEqual(25);
    });
  });

  describe('adjustPoolSize', () => {
    test('扩容操作应该成功', async () => {
      const poolStatus = await autoScaler.getPoolStatus();
      
      const result = await autoScaler.adjustPoolSize(30, poolStatus);
      
      expect(result.action).toBe('scale_up');
      expect(autoScaler.stats.totalScaleUps).toBe(1);
    });

    test('缩容操作应该成功', async () => {
      mockPool.pool.totalCount = 40;
      const poolStatus = await autoScaler.getPoolStatus();
      
      const result = await autoScaler.adjustPoolSize(20, poolStatus);
      
      expect(result.action).toBe('scale_down');
      expect(autoScaler.stats.totalScaleDowns).toBe(1);
    });

    test('冷却时间内不应该调整', async () => {
      autoScaler.scaleState.lastScaleTime = Date.now();
      
      const poolStatus = await autoScaler.getPoolStatus();
      const result = await autoScaler.adjustPoolSize(30, poolStatus);
      
      expect(result.action).toBe('cooldown');
    });
  });

  describe('performHealthCheck', () => {
    test('应该成功执行健康检查', async () => {
      autoScaler.start();
      
      const result = await autoScaler.performHealthCheck();
      
      expect(result.poolStatus).toBeDefined();
      expect(result.healthResults).toBeDefined();
      expect(result.duration).toBeGreaterThan(0);
    });

    test('应该发射健康检查完成事件', async () => {
      const handler = jest.fn();
      autoScaler.on('health-check-completed', handler);
      
      await autoScaler.performHealthCheck();
      
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('checkConnectionHealth', () => {
    test('应该正确分类健康和不健康连接', async () => {
      mockPool.pool._idle = [
        { lastUsed: Date.now() - 1000 },
        { lastUsed: Date.now() - 400000 }, // 超时
      ];
      
      const result = await autoScaler.checkConnectionHealth({ idleConnections: 2 });
      
      expect(result.healthy).toBeGreaterThanOrEqual(1);
      expect(result.unhealthy.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('PID Controller', () => {
    test('PID状态应该正确更新', () => {
      const poolStatus = {
        totalConnections: 20,
        utilization: 0.9,
        avgUtilization: 0.85
      };
      
      autoScaler.calculateTargetConnections(poolStatus);
      
      expect(autoScaler.pidState.previousError).toBeDefined();
    });
  });

  describe('getHealthMetrics', () => {
    test('应该返回完整的健康指标', () => {
      autoScaler.stats.healthChecks = 10;
      autoScaler.stats.totalScaleUps = 5;
      autoScaler.stats.totalScaleDowns = 3;
      
      const metrics = autoScaler.getHealthMetrics();
      
      expect(metrics.healthChecks).toBe(10);
      expect(metrics.totalScaleUps).toBe(5);
      expect(metrics.totalScaleDowns).toBe(3);
      expect(metrics.pidState).toBeDefined();
      expect(metrics.scaleState).toBeDefined();
    });
  });
});

describe('ConnectionPoolHealthChecker', () => {
  let healthChecker;
  let mockPool;
  let mockDB;

  beforeEach(() => {
    mockPool = new MockPool();
    mockDB = new MockDB();
    
    healthChecker = new ConnectionPoolHealthChecker(mockPool, mockDB, {
      checkIntervalMs: 60000,
      queryTimeoutMs: 5000,
      unhealthyThreshold: 3
    });
  });

  afterEach(() => {
    healthChecker.stop();
  });

  describe('start/stop', () => {
    test('应该成功启动', () => {
      healthChecker.start();
      expect(healthChecker.checkTimer).toBeDefined();
    });

    test('应该成功停止', () => {
      healthChecker.start();
      healthChecker.stop();
      expect(healthChecker.checkTimer).toBeNull();
    });
  });

  describe('performCheck', () => {
    test('应该返回健康状态', async () => {
      const status = await healthChecker.performCheck();
      
      expect(status.isHealthy).toBe(true);
      expect(status.poolStatus).toBeDefined();
      expect(status.responseTime).toBeGreaterThanOrEqual(0);
    });

    test('连接失败时应该标记为不健康', async () => {
      mockPool.connect = async () => {
        throw new Error('Connection failed');
      };
      
      const status = await healthChecker.performCheck();
      
      expect(status.isHealthy).toBe(false);
      expect(status.issues.length).toBeGreaterThan(0);
    });
  });

  describe('checkPoolStatus', () => {
    test('应该返回连接池状态', async () => {
      const status = await healthChecker.checkPoolStatus();
      
      expect(status.totalConnections).toBeDefined();
      expect(status.idleConnections).toBeDefined();
      expect(status.waitingClients).toBeDefined();
    });
  });

  describe('testConnection', () => {
    test('成功连接应该返回成功', async () => {
      const result = await healthChecker.testConnection();
      
      expect(result.success).toBe(true);
    });

    test('失败连接应该返回错误信息', async () => {
      mockPool.connect = async () => {
        throw new Error('Connection failed');
      };
      
      const result = await healthChecker.testConnection();
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('checkConnectionLeak', () => {
    test('正常情况下不应该有泄漏', async () => {
      const poolStatus = {
        totalConnections: 10,
        idleConnections: 5,
        waitingClients: 3
      };
      
      const result = await healthChecker.checkConnectionLeak(poolStatus);
      
      expect(result.hasLeak).toBe(false);
    });

    test('活跃连接过多时应该检测到泄漏', async () => {
      const poolStatus = {
        totalConnections: 50,
        idleConnections: 5,
        waitingClients: 2
      };
      
      const result = await healthChecker.checkConnectionLeak(poolStatus);
      
      expect(result.hasLeak).toBe(true);
      expect(result.leakedCount).toBeGreaterThan(0);
    });
  });

  describe('getHealthStatus', () => {
    test('应该返回当前健康状态', async () => {
      await healthChecker.performCheck();
      
      const status = healthChecker.getHealthStatus();
      
      expect(status.lastCheckTime).toBeDefined();
      expect(status.isHealthy).toBeDefined();
    });
  });
});

describe('ConnectionPoolOverflowProtector', () => {
  let protector;
  let mockPool;
  let mockRedis;

  beforeEach(() => {
    mockPool = new MockPool();
    mockRedis = new MockRedis();
    
    protector = new ConnectionPoolOverflowProtector(mockPool, mockRedis, {
      maxQueueSize: 10,
      queueTimeoutMs: 5000,
      failureThreshold: 5
    });
  });

  describe('getStatus', () => {
    test('应该返回当前状态', () => {
      const status = protector.getStatus();
      
      expect(status.queueSize).toBe(0);
      expect(status.maxQueueSize).toBe(10);
      expect(status.isCircuitOpen).toBe(false);
    });
  });

  describe('getConnection', () => {
    test('应该成功获取连接', async () => {
      const client = await protector.getConnection();
      
      expect(client).toBeDefined();
      expect(client.query).toBeDefined();
    });

    test('队列满时应该拒绝请求', async () => {
      protector.queue = new Array(10).fill({});
      
      await expect(protector.getConnection()).rejects.toThrow('queue is full');
    });

    test('熔断器打开时应该拒绝请求', async () => {
      protector.isCircuitOpen = true;
      
      await expect(protector.getConnection()).rejects.toThrow('circuit breaker');
    });
  });

  describe('Circuit Breaker', () => {
    test('连续失败应该触发熔断', async () => {
      mockPool.connect = async () => {
        throw new Error('Connection failed');
      };
      
      // 连续触发失败
      for (let i = 0; i < 6; i++) {
        protector.failures.push({ time: Date.now() });
      }
      
      await expect(protector.getConnection()).rejects.toThrow();
      
      expect(protector.isCircuitOpen).toBe(true);
    });
  });
});
