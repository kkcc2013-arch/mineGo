/**
 * IntelligentSampler 测试
 * 
 * REQ-00582: 微服务链路追踪采样率智能自适应与成本优化系统
 */

'use strict';

const { IntelligentSampler, PriorityRules, TrafficZones } = require('../IntelligentSampler');
const assert = require('assert');

describe('IntelligentSampler', () => {
  let sampler;

  beforeEach(() => {
    sampler = new IntelligentSampler({
      baseRate: 0.01,
      minRate: 0.001,
      maxRate: 1.0,
      adaptiveEnabled: true
    });
  });

  describe('calculateSamplingRate', () => {
    it('should return base rate when adaptive is disabled', () => {
      sampler.config.adaptiveEnabled = false;
      
      const rate = sampler.calculateSamplingRate({
        qps: 1000,
        errorRate: 0.1,
        slowRequestRatio: 0.2
      });
      
      assert.strictEqual(rate, sampler.config.baseRate);
    });

    it('should use low traffic rate for QPS < 100', () => {
      const rate = sampler.calculateSamplingRate({
        qps: 50,
        errorRate: 0,
        slowRequestRatio: 0
      });
      
      assert.strictEqual(rate, TrafficZones.LOW.rate);
    });

    it('should use normal traffic rate for 100 < QPS < 1000', () => {
      const rate = sampler.calculateSamplingRate({
        qps: 500,
        errorRate: 0,
        slowRequestRatio: 0
      });
      
      assert.strictEqual(rate, TrafficZones.NORMAL.rate);
    });

    it('should use high traffic rate for 1000 < QPS < 5000', () => {
      const rate = sampler.calculateSamplingRate({
        qps: 2000,
        errorRate: 0,
        slowRequestRatio: 0
      });
      
      assert.strictEqual(rate, TrafficZones.HIGH.rate);
    });

    it('should use peak traffic rate for QPS > 5000', () => {
      const rate = sampler.calculateSamplingRate({
        qps: 8000,
        errorRate: 0,
        slowRequestRatio: 0
      });
      
      assert.strictEqual(rate, TrafficZones.PEAK.rate);
    });

    it('should increase rate when error rate > 5%', () => {
      const rate = sampler.calculateSamplingRate({
        qps: 500,
        errorRate: 0.1,
        slowRequestRatio: 0
      });
      
      assert.ok(rate > TrafficZones.NORMAL.rate);
    });

    it('should increase rate when slow request ratio > 10%', () => {
      const rate = sampler.calculateSamplingRate({
        qps: 500,
        errorRate: 0,
        slowRequestRatio: 0.2
      });
      
      assert.ok(rate > TrafficZones.NORMAL.rate);
    });

    it('should respect min and max bounds', () => {
      let rate;
      
      // 测试最小值
      rate = sampler.calculateSamplingRate({ qps: 0, errorRate: 0, slowRequestRatio: 0 });
      assert.ok(rate >= sampler.config.minRate);
      
      // 测试最大值
      rate = sampler.calculateSamplingRate({ qps: 10000, errorRate: 0.5, slowRequestRatio: 0.5 });
      assert.ok(rate <= sampler.config.maxRate);
    });
  });

  describe('shouldSample', () => {
    it('should always sample error requests', () => {
      const span = {
        statusCode: 500,
        duration: 100
      };
      
      const result = sampler.shouldSample(span, { qps: 1000, errorRate: 0.01 });
      
      assert.strictEqual(result.sampled, true);
      assert.ok(result.reason.includes('error'));
    });

    it('should always sample slow requests', () => {
      const span = {
        statusCode: 200,
        duration: 2000 // 2秒，超过默认慢阈值1秒
      };
      
      const result = sampler.shouldSample(span, { qps: 1000, errorRate: 0.01 });
      
      assert.strictEqual(result.sampled, true);
      assert.ok(result.reason.includes('slow'));
    });

    it('should always sample payment requests', () => {
      const span = {
        name: 'payment-process',
        statusCode: 200,
        duration: 100
      };
      
      const result = sampler.shouldSample(span, { qps: 1000, errorRate: 0.01 });
      
      assert.strictEqual(result.sampled, true);
      assert.ok(result.reason.includes('payment'));
    });

    it('should always sample auth requests', () => {
      const span = {
        name: 'auth-login',
        statusCode: 200,
        duration: 100
      };
      
      const result = sampler.shouldSample(span, { qps: 1000, errorRate: 0.01 });
      
      assert.strictEqual(result.sampled, true);
      assert.ok(result.reason.includes('auth'));
    });

    it('should use random sampling for normal requests', () => {
      const results = [];
      
      for (let i = 0; i < 1000; i++) {
        const span = {
          statusCode: 200,
          duration: 100
        };
        
        const result = sampler.shouldSample(span, { qps: 500, errorRate: 0.01 });
        results.push(result);
      }
      
      // 统计采样数
      const sampledCount = results.filter(r => r.sampled).length;
      
      // 应该接近正常期的采样率（1%），允许一定偏差
      const expectedRate = TrafficZones.NORMAL.rate;
      const tolerance = 0.5; // 允许±0.5%偏差
      
      assert.ok(
        sampledCount / 1000 >= expectedRate - tolerance,
        `Sampled ratio ${sampledCount / 1000} should be >= ${expectedRate - tolerance}`
      );
    });
  });

  describe('checkPrioritySampling', () => {
    it('should detect HTTP 4xx errors', () => {
      const span = { statusCode: 400 };
      const result = sampler.checkPrioritySampling(span);
      
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.rule, PriorityRules.ERROR);
    });

    it('should detect HTTP 5xx errors', () => {
      const span = { statusCode: 500 };
      const result = sampler.checkPrioritySampling(span);
      
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.rule, PriorityRules.ERROR);
    });

    it('should detect slow requests', () => {
      const span = { duration: 2000 };
      const result = sampler.checkPrioritySampling(span);
      
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.rule, PriorityRules.SLOW);
    });

    it('should detect payment spans', () => {
      const span = { name: 'payment-checkout' };
      const result = sampler.checkPrioritySampling(span);
      
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.rule, PriorityRules.PAYMENT);
    });

    it('should detect auth spans', () => {
      const span = { name: 'auth-token' };
      const result = sampler.checkPrioritySampling(span);
      
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.rule, PriorityRules.AUTH);
    });

    it('should not match normal requests', () => {
      const span = { statusCode: 200, duration: 100, name: 'normal-request' };
      const result = sampler.checkPrioritySampling(span);
      
      assert.strictEqual(result.matched, false);
    });
  });

  describe('updateConfig', () => {
    it('should update config', () => {
      const result = sampler.updateConfig({
        baseRate: 0.05,
        slowThresholdMs: 2000
      });
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(sampler.config.baseRate, 0.05);
      assert.strictEqual(sampler.config.slowThresholdMs, 2000);
    });

    it('should preserve old config', () => {
      const oldBaseRate = sampler.config.baseRate;
      
      sampler.updateConfig({ slowThresholdMs: 2000 });
      
      // baseRate 应该保持不变
      assert.strictEqual(sampler.config.baseRate, oldBaseRate);
    });
  });

  describe('getStats', () => {
    it('should return statistics', () => {
      // 模拟一些采样
      for (let i = 0; i < 100; i++) {
        const span = {
          statusCode: 200,
          duration: Math.random() * 100
        };
        sampler.shouldSample(span, { qps: 500, errorRate: 0.01 });
      }
      
      const stats = sampler.getStats();
      
      assert.ok(stats.currentRate !== undefined);
      assert.ok(stats.metrics.total > 0);
      assert.ok(stats.metrics.sampleRatio >= 0);
      assert.ok(stats.metrics.sampleRatio <= 1);
    });
  });

  describe('estimateStorageBytes', () => {
    it('should estimate storage for span', () => {
      const span = {
        attributes: new Map([['key1', 'value1'], ['key2', 'value2']]),
        events: [{}, {}]
      };
      
      const bytes = sampler.estimateStorageBytes(span);
      
      // 基础大小1024 + 属性大小 + 事件大小
      assert.ok(bytes > 1024);
    });
  });
});

describe('TrafficZones', () => {
  it('should have correct zone definitions', () => {
    assert.strictEqual(TrafficZones.LOW.rate, 0.001);
    assert.strictEqual(TrafficZones.NORMAL.rate, 0.01);
    assert.strictEqual(TrafficZones.HIGH.rate, 0.05);
    assert.strictEqual(TrafficZones.PEAK.rate, 0.1);
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}

module.exports = {
  // 导出用于集成测试
};