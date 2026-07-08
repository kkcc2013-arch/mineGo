/**
 * PerformanceSampler Unit Tests
 * REQ-00502: 性能分析与深度优化框架设计
 */

const { PerformanceSampler } = require('../PerformanceSampler');

describe('PerformanceSampler', () => {
  let sampler;

  beforeEach(() => {
    sampler = new PerformanceSampler({
      samplingRate: 1, // 测试时全采样
      maxSamples: 100,
      sampleWindowMs: 60000
    });
  });

  describe('采样逻辑', () => {
    test('shouldSample 在采样率 1 时总是返回 true', () => {
      expect(sampler.shouldSample()).toBe(true);
      expect(sampler.shouldSample()).toBe(true);
      expect(sampler.shouldSample()).toBe(true);
    });

    test('采样率统计正确', () => {
      sampler.samplingRate = 0.5;
      sampler.stats = { totalRequests: 0, sampledRequests: 0 };
      
      let sampled = 0;
      let total = 0;
      
      for (let i = 0; i < 1000; i++) {
        total++;
        if (sampler.shouldSample()) sampled++;
      }
      
      // 采样率应该接近 50%
      expect(Math.abs(sampled / total - 0.5)).toBeLessThan(0.05);
    });
  });

  describe('样本追踪', () => {
    test('startSampling 创建正确的追踪对象', () => {
      const req = {
        serviceName: 'test-service',
        path: '/api/test',
        method: 'GET',
        user: { id: 'user123' }
      };

      const sample = sampler.startSampling(req);

      expect(sample.traceId).toBeDefined();
      expect(sample.service).toBe('test-service');
      expect(sample.endpoint).toBe('/api/test');
      expect(sample.method).toBe('GET');
      expect(sample.userId).toBe('user123');
      expect(sample.startTime).toBeDefined();
      expect(sample.phases).toBeDefined();
    });

    test('startPhase 和 endPhase 正确记录阶段耗时', () => {
      const sample = sampler.startSampling({});
      
      sampler.startPhase(sample, 'db');
      
      // 模拟一些耗时
      const start = sample.phases.db.startTime;
      
      sampler.endPhase(sample, 'db');
      
      expect(sample.phases.db.endTime).toBeGreaterThan(start);
      expect(sample.phases.db.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('数据库操作记录', () => {
    test('recordDbOperation 正确记录操作', () => {
      const sample = sampler.startSampling({});
      
      sampler.recordDbOperation(sample, 'SELECT', 'users', 50, 'SELECT * FROM users');
      
      expect(sample.phases.db.operations.length).toBe(1);
      expect(sample.phases.db.operations[0].operation).toBe('SELECT');
      expect(sample.phases.db.operations[0].table).toBe('users');
      expect(sample.phases.db.operations[0].durationMs).toBe(50);
      
      // 统计累加
      expect(sampler.stats.dbTimeMs).toBe(50);
    });
  });

  describe('缓存操作记录', () => {
    test('recordCacheOperation 正确记录缓存命中', () => {
      const sample = sampler.startSampling({});
      
      sampler.recordCacheOperation(sample, 'GET', 'cache:users:123', 5, true);
      
      expect(sample.phases.cache.operations.length).toBe(1);
      expect(sample.phases.cache.operations[0].hit).toBe(true);
    });

    test('recordCacheOperation 正确记录缓存未命中', () => {
      const sample = sampler.startSampling({});
      
      sampler.recordCacheOperation(sample, 'GET', 'cache:users:456', 2, false);
      
      expect(sample.phases.cache.operations[0].hit).toBe(false);
    });
  });

  describe('API 调用记录', () => {
    test('recordApiCall 正确记录外部 API', () => {
      const sample = sampler.startSampling({});
      
      sampler.recordApiCall(sample, 'payment-service', '/api/pay', 200, 200);
      
      expect(sample.phases.api.operations.length).toBe(1);
      expect(sample.phases.api.operations[0].targetService).toBe('payment-service');
      expect(sample.phases.api.operations[0].statusCode).toBe(200);
    });
  });

  describe('结束采样', () => {
    test('endSampling 正确提交样本', () => {
      const sample = sampler.startSampling({});
      
      sampler.endSampling(sample, 200);
      
      expect(sample.statusCode).toBe(200);
      expect(sample.endTime).toBeDefined();
      expect(sample.totalDurationMs).toBeGreaterThan(0);
      
      expect(sampler.samples.length).toBe(1);
      expect(sampler.stats.totalProcessingTimeMs).toBe(sample.totalDurationMs);
    });

    test('endSampling 记录错误信息', () => {
      const sample = sampler.startSampling({});
      
      sampler.endSampling(sample, 500, 'Internal Server Error');
      
      expect(sample.statusCode).toBe(500);
      expect(sample.error).toBe('Internal Server Error');
    });

    test('样本超过限制时自动清理', () => {
      sampler.maxSamples = 10;
      
      for (let i = 0; i < 15; i++) {
        const sample = sampler.startSampling({});
        sampler.endSampling(sample, 200);
      }
      
      expect(sampler.samples.length).toBe(10);
    });
  });

  describe('热点分析', () => {
    test('analyzeHotspots 正确识别慢端点', () => {
      // 创建模拟样本
      for (let i = 0; i < 10; i++) {
        const sample = sampler.startSampling({
          serviceName: 'test-service',
          path: '/api/slow-endpoint',
          method: 'GET'
        });
        
        sample.totalDurationMs = 600; // 超过阈值
        sample.phases.db.durationMs = 400; // 数据库是瓶颈
        sample.phases.db.operations = [{ operation: 'SELECT', table: 'large_table', durationMs: 400 }];
        sample.phases.cache.operations = [];
        sample.phases.api.operations = [];
        
        sampler.endSampling(sample, 200);
      }

      const hotspots = sampler.analyzeHotspots();
      
      expect(hotspots.length).toBeGreaterThan(0);
      expect(hotspots[0].avgMs).toBeGreaterThanOrEqual(500);
      expect(hotspots[0].bottleneckType).toBe('database');
    });

    test('热点按平均耗时排序', () => {
      // 创建不同耗时的样本
      const endpoints = [
        { path: '/api/fast', ms: 100 },
        { path: '/api/medium', ms: 400 },
        { path: '/api/slow', ms: 800 }
      ];

      for (const ep of endpoints) {
        const sample = sampler.startSampling({ path: ep.path });
        sample.totalDurationMs = ep.ms;
        sampler.endSampling(sample, 200);
      }

      const hotspots = sampler.analyzeHotspots();
      
      if (hotspots.length > 1) {
        for (let i = 0; i < hotspots.length - 1; i++) {
          expect(hotspots[i].avgMs).toBeGreaterThanOrEqual(hotspots[i + 1].avgMs);
        }
      }
    });
  });

  describe('报告生成', () => {
    test('generateReport 包含完整信息', () => {
      const sample = sampler.startSampling({});
      sampler.recordDbOperation(sample, 'SELECT', 'users', 150, 'SELECT * FROM users');
      sampler.endSampling(sample, 200);

      const report = sampler.generateReport();
      
      expect(report.generatedAt).toBeDefined();
      expect(report.stats).toBeDefined();
      expect(report.stats.totalRequests).toBeGreaterThan(0);
      expect(report.stats.sampledRequests).toBeGreaterThan(0);
      expect(report.hotspots).toBeDefined();
      expect(report.topSlowOperations).toBeDefined();
      expect(report.recommendations).toBeDefined();
    });

    test('报告包含优化建议', () => {
      const sample = sampler.startSampling({});
      sample.totalDurationMs = 800;
      sample.phases.db.durationMs = 500;
      sampler.endSampling(sample, 200);

      const report = sampler.generateReport();
      
      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations[0].suggestions).toBeDefined();
    });
  });

  describe('配置管理', () => {
    test('setSamplingRate 正确更新采样率', () => {
      sampler.setSamplingRate(0.1);
      expect(sampler.samplingRate).toBe(0.1);
    });

    test('setSamplingRate 拒绝无效值', () => {
      sampler.setSamplingRate(1.5);
      expect(sampler.samplingRate).not.toBe(1.5);
      
      sampler.setSamplingRate(-0.1);
      expect(sampler.samplingRate).not.toBe(-0.1);
    });

    test('resetStats 清空统计', () => {
      sampler.endSampling(sampler.startSampling({}), 200);
      
      sampler.resetStats();
      
      expect(sampler.stats.totalRequests).toBe(0);
      expect(sampler.samples.length).toBe(0);
    });
  });
});