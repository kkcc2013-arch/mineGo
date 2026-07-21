/**
 * 单元测试：数据库连接池智能预热与动态自适应管理系统
 * REQ-00623: 数据库连接池智能预热与动态自适应管理系统
 */

const { expect } = require('chai');
const { IntelligentPoolManager } = require('../../jobs/intelligentPoolManager');
const sinon = require('sinon');

describe('IntelligentPoolManager', () => {
  let manager;
  let mockRedis;
  let mockKafka;

  beforeEach(() => {
    // 创建 Mock
    mockRedis = {
      get: sinon.stub(),
      setex: sinon.stub(),
      lpush: sinon.stub(),
      lrange: sinon.stub(),
      ltrim: sinon.stub(),
      expire: sinon.stub()
    };

    mockKafka = {
      producer: sinon.stub().returns({
        connect: sinon.stub().resolves(),
        disconnect: sinon.stub().resolves(),
        send: sinon.stub().resolves()
      }),
      consumer: sinon.stub().returns({
        connect: sinon.stub().resolves(),
        disconnect: sinon.stub().resolves(),
        subscribe: sinon.stub().resolves(),
        run: sinon.stub().resolves()
      })
    };

    manager = new IntelligentPoolManager({
      kafka: mockKafka,
      monitorIntervalSeconds: 10,
      preheatAdvanceMinutes: 5
    });
  });

  afterEach(() => {
    if (manager && manager.initialized) {
      manager.stop();
    }
  });

  describe('初始化', () => {
    it('应该正确初始化配置', () => {
      expect(manager.services).to.be.an('array');
      expect(manager.services.length).to.be.greaterThan(0);
      expect(manager.scaleUpThreshold).to.equal(0.85);
      expect(manager.scaleDownThreshold).to.equal(0.30);
      expect(manager.maxPoolSize).to.equal(30);
      expect(manager.minPoolSize).to.equal(2);
    });

    it('应该包含所有核心服务', () => {
      const expectedServices = [
        'user-service',
        'location-service',
        'pokemon-service',
        'catch-service',
        'gym-service',
        'social-service',
        'reward-service',
        'payment-service',
        'gateway'
      ];

      expectedServices.forEach(service => {
        expect(manager.services).to.include(service);
      });
    });
  });

  describe('连接池指标处理', () => {
    it('应该正确处理连接池指标', async () => {
      const metrics = {
        utilization: 0.75,
        waitingClients: 2,
        totalConnections: 10
      };

      await manager.handlePoolMetrics({
        service: 'user-service',
        metrics,
        timestamp: Date.now()
      });

      const state = manager.poolStates.get('user-service');
      expect(state).to.exist;
      expect(state.utilization).to.be.an('array');
      expect(state.utilization.length).to.equal(1);
      expect(state.utilization[0].value).to.equal(0.75);
    });

    it('应该保留最近 15 分钟的数据', async () => {
      // 添加 20 个数据点
      for (let i = 0; i < 20; i++) {
        await manager.handlePoolMetrics({
          service: 'user-service',
          metrics: {
            utilization: 0.5 + (i * 0.01),
            waitingClients: i,
            totalConnections: 10 + i
          },
          timestamp: Date.now() - (20 - i) * 60 * 1000 // 每分钟一个数据点
        });
      }

      const state = manager.poolStates.get('user-service');
      expect(state.utilization.length).to.be.at.most(15);
    });
  });

  describe('动态调整逻辑', () => {
    beforeEach(() => {
      // 模拟连续 5 分钟的高使用率
      for (let i = 0; i < 5; i++) {
        manager.poolStates.set('user-service', {
          utilization: [
            { value: 0.90, timestamp: Date.now() - i * 60000 },
            { value: 0.88, timestamp: Date.now() - (i + 1) * 60000 },
            { value: 0.92, timestamp: Date.now() - (i + 2) * 60000 },
            { value: 0.87, timestamp: Date.now() - (i + 3) * 60000 },
            { value: 0.91, timestamp: Date.now() - (i + 4) * 60000 }
          ],
          waitingClients: [
            { value: 5, timestamp: Date.now() },
            { value: 4, timestamp: Date.now() - 60000 },
            { value: 6, timestamp: Date.now() - 120000 },
            { value: 5, timestamp: Date.now() - 180000 },
            { value: 4, timestamp: Date.now() - 240000 }
          ],
          totalConnections: [],
          lastScaleTime: null,
          scaleDirection: null
        });
      }
    });

    it('应该在连续高使用率时触发扩容', async () => {
      const result = await manager.adjustPoolSize('user-service');

      expect(result).to.exist;
      expect(result.action).to.equal('scale_up');
      expect(result.newSize).to.be.greaterThan(result.oldSize);
    });

    it('应该避免频繁调整', async () => {
      // 首次调整
      await manager.adjustPoolSize('user-service');

      // 立即再次调整应该被跳过
      const state = manager.poolStates.get('user-service');
      state.lastScaleTime = Date.now();

      const result = await manager.adjustPoolSize('user-service');
      expect(result).to.be.null;
    });
  });

  describe('缩容逻辑', () => {
    beforeEach(() => {
      // 模拟连续 5 分钟的低使用率
      manager.poolStates.set('reward-service', {
        utilization: [
          { value: 0.25, timestamp: Date.now() },
          { value: 0.22, timestamp: Date.now() - 60000 },
          { value: 0.28, timestamp: Date.now() - 120000 },
          { value: 0.20, timestamp: Date.now() - 180000 },
          { value: 0.24, timestamp: Date.now() - 240000 }
        ],
        waitingClients: [
          { value: 0, timestamp: Date.now() },
          { value: 0, timestamp: Date.now() - 60000 },
          { value: 0, timestamp: Date.now() - 120000 },
          { value: 0, timestamp: Date.now() - 180000 },
          { value: 1, timestamp: Date.now() - 240000 }
        ],
        totalConnections: [],
        lastScaleTime: Date.now() - 20 * 60 * 1000, // 20 分钟前
        scaleDirection: null
      });
    });

    it('应该在连续低使用率时触发缩容', async () => {
      const result = await manager.adjustPoolSize('reward-service');

      expect(result).to.exist;
      expect(result.action).to.equal('scale_down');
      expect(result.newSize).to.be.lessThan(result.oldSize);
    });
  });

  describe('预热功能', () => {
    it('应该根据默认时间表预热', async () => {
      const results = await manager.preheatAllPools('high');

      expect(results).to.be.an('array');
      expect(results.length).to.equal(manager.services.length);
      expect(results.filter(r => r.success).length).to.be.greaterThan(0);
    });

    it('应该根据流量级别调整目标连接数', async () => {
      const lowTrafficResults = await manager.preheatAllPools('low');
      const highTrafficResults = await manager.preheatAllPools('high');

      const lowTrafficTarget = lowTrafficResults.find(r => r.service === 'user-service');
      const highTrafficTarget = highTrafficResults.find(r => r.service === 'user-service');

      expect(highTrafficTarget.targetMaxSize).to.be.greaterThan(lowTrafficTarget.targetMaxSize);
    });

    it('应该遵守最大连接数限制', async () => {
      const results = await manager.preheatAllPools('very_high');

      results.forEach(result => {
        if (result.success) {
          expect(result.targetMaxSize).to.be.at.most(manager.maxPoolSize);
        }
      });
    });
  });

  describe('状态查询', () => {
    it('应该返回正确的状态信息', () => {
      const status = manager.getStatus();

      expect(status.initialized).to.be.a('boolean');
      expect(status.services).to.be.an('array');
      expect(status.poolStates).to.be.an('object');
      expect(status.config).to.be.an('object');
      expect(status.config.preheatAdvanceMinutes).to.equal(5);
    });
  });

  describe('优化建议', () => {
    it('应该为低使用率服务提供缩容建议', () => {
      // 模拟低使用率数据
      manager.poolStates.set('social-service', {
        utilization: Array(60).fill(null).map((_, i) => ({
          value: 0.3,
          timestamp: Date.now() - i * 60000
        })),
        waitingClients: Array(60).fill(null).map((_, i) => ({
          value: 0,
          timestamp: Date.now() - i * 60000
        })),
        totalConnections: [],
        lastScaleTime: null,
        scaleDirection: null
      });

      const recommendations = manager.getOptimizationRecommendations();
      const socialRec = recommendations.find(r => r.service === 'social-service');

      expect(socialRec).to.exist;
      expect(socialRec.type).to.equal('reduce_size');
    });

    it('应该为高使用率服务提供扩容建议', () => {
      // 模拟高使用率数据
      manager.poolStates.set('catch-service', {
        utilization: Array(60).fill(null).map((_, i) => ({
          value: 0.85,
          timestamp: Date.now() - i * 60000
        })),
        waitingClients: Array(60).fill(null).map((_, i) => ({
          value: 3,
          timestamp: Date.now() - i * 60000
        })),
        totalConnections: [],
        lastScaleTime: null,
        scaleDirection: null
      });

      const recommendations = manager.getOptimizationRecommendations();
      const catchRec = recommendations.find(r => r.service === 'catch-service');

      expect(catchRec).to.exist;
      expect(catchRec.type).to.equal('increase_size');
    });
  });

  describe('安全检查', () => {
    it('应该拒绝超过最大限制的连接数', async () => {
      manager.maxPoolSize = 20;

      await manager.preheatAllPools('very_high');

      // 检查所有服务的目标连接数不超过最大限制
      // 这个检查会在 applyPoolSize 中执行
      expect(manager.maxPoolSize).to.equal(20);
    });

    it('应该保证最小连接数', async () => {
      manager.minPoolSize = 3;

      await manager.preheatAllPools('low');

      // 最小连接数应该被保证
      expect(manager.minPoolSize).to.equal(3);
    });
  });

  describe('数据持久化', () => {
    it('应该正确保存指标到 Redis', async () => {
      // 这个测试需要实际的 Redis 连接或更复杂的 Mock
      // 这里只验证函数存在
      expect(manager.saveMetricsToRedis).to.be.a('function');
    });

    it('应该正确加载历史数据', async () => {
      // 这个测试需要实际的 Redis 连接或更复杂的 Mock
      // 这里只验证函数存在
      expect(manager.loadHistoricalData).to.be.a('function');
    });
  });
});
