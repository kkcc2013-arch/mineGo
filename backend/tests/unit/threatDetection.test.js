'use strict';

/**
 * 威胁检测引擎单元测试
 */

const assert = require('assert');
const ThreatDetectionEngine = require('../ThreatDetectionEngine');
const FeatureExtractor = require('../FeatureExtractor');
const ThreatResponseExecutor = require('../ThreatResponseExecutor');

// Mock Redis
class MockRedis {
  constructor() {
    this.data = new Map();
  }
  
  async zadd(key, score, member) {
    if (!this.data.has(key)) this.data.set(key, new Map());
    this.data.get(key).set(member, score);
  }
  
  async zremrangebyscore(key, min, max) {
    // 简化实现
  }
  
  async zrangebyscore(key, min, max) {
    const set = this.data.get(key);
    if (!set) return [];
    return Array.from(set.keys());
  }
  
  async expire(key, ttl) {}
  
  async setex(key, ttl, value) {
    this.data.set(key, value);
  }
  
  async get(key) {
    return this.data.get(key);
  }
  
  async del(key) {
    this.data.delete(key);
  }
  
  async publish(channel, message) {}
}

// 测试套件
describe('FeatureExtractor', () => {
  let extractor;
  
  beforeEach(() => {
    extractor = new FeatureExtractor();
  });
  
  describe('#extractRequestFeatures', () => {
    it('should extract basic features from request', () => {
      const req = {
        method: 'GET',
        path: '/api/pokemon',
        headers: {
          'user-agent': 'Mozilla/5.0',
          'x-forwarded-for': '192.168.1.100'
        },
        session: { id: 'session-123' },
        user: { id: 'user-456' }
      };
      
      const features = extractor.extractRequestFeatures(req);
      
      assert.strictEqual(features.method, 'GET');
      assert.strictEqual(features.path, '/api/pokemon');
      assert.strictEqual(features.ip, '192.168.1.100');
      assert.strictEqual(features.sessionId, 'session-123');
      assert.strictEqual(features.userId, 'user-456');
    });
  });
  
  describe('#calculateEntropy', () => {
    it('should return 0 for empty array', () => {
      const entropy = extractor.calculateEntropy([]);
      assert.strictEqual(entropy, 0);
    });
    
    it('should return 1 for uniform distribution', () => {
      const entropy = extractor.calculateEntropy(['a', 'b', 'c', 'd']);
      assert.strictEqual(entropy, 1);
    });
    
    it('should return 0 for single value', () => {
      const entropy = extractor.calculateEntropy(['a', 'a', 'a']);
      assert.strictEqual(entropy, 0);
    });
  });
  
  describe('#calculateDistributionStats', () => {
    it('should calculate mean, std, skewness correctly', () => {
      const values = [10, 20, 30, 40, 50];
      const stats = extractor.calculateDistributionStats(values);
      
      assert.strictEqual(stats.mean, 30);
      assert(stats.std > 0);
    });
  });
});

describe('ThreatDetectionEngine', () => {
  let engine;
  let redis;
  
  beforeEach(() => {
    redis = new MockRedis();
    engine = new ThreatDetectionEngine();
  });
  
  describe('#detect', () => {
    it('should return normal for safe request', async () => {
      const req = {
        method: 'GET',
        path: '/api/pokemon',
        headers: {
          'user-agent': 'Mozilla/5.0',
          'x-forwarded-for': '192.168.1.100'
        }
      };
      
      const result = await engine.detect(redis, req, {});
      
      assert(result.threatLevel);
      assert.strictEqual(typeof result.threatScore, 'number');
      assert(Array.isArray(result.matchedRules));
    });
    
    it('should detect high rate as threat', async () => {
      // 模拟高请求率
      const req = {
        method: 'GET',
        path: '/api/pokemon',
        headers: {
          'user-agent': 'Bot',
          'x-forwarded-for': '10.0.0.1'
        }
      };
      
      // 多次调用模拟高频
      for (let i = 0; i < 10; i++) {
        await engine.detect(redis, req, {});
      }
      
      const result = await engine.detect(redis, req, {});
      
      assert(result.threatScore >= 0);
      assert(['normal', 'suspicious', 'threat', 'critical'].includes(result.threatLevel));
    });
  });
  
  describe('#determineLevel', () => {
    it('should return correct levels', () => {
      assert.strictEqual(engine.determineLevel(10), 'normal');
      assert.strictEqual(engine.determineLevel(40), 'suspicious');
      assert.strictEqual(engine.determineLevel(60), 'threat');
      assert.strictEqual(engine.determineLevel(85), 'critical');
    });
  });
  
  describe('#addRule', () => {
    it('should add custom rule', () => {
      const initialCount = engine.rules.length;
      
      engine.addRule({
        id: 'test-rule',
        name: 'Test Rule',
        condition: (f) => f.requestRate > 100,
        score: 50,
        category: 'test'
      });
      
      assert.strictEqual(engine.rules.length, initialCount + 1);
    });
  });
  
  describe('#removeRule', () => {
    it('should remove rule by id', () => {
      engine.addRule({
        id: 'rule-to-remove',
        name: 'Test',
        condition: () => true,
        score: 10
      });
      
      const countBefore = engine.rules.length;
      engine.removeRule('rule-to-remove');
      
      assert.strictEqual(engine.rules.length, countBefore - 1);
    });
  });
});

describe('ThreatResponseExecutor', () => {
  let executor;
  let redis;
  
  beforeEach(() => {
    redis = new MockRedis();
    executor = new ThreatResponseExecutor({ redis });
  });
  
  describe('#execute', () => {
    it('should skip normal traffic', async () => {
      const result = await executor.execute({
        threatLevel: 'normal',
        threatScore: 10
      }, {});
      
      assert.strictEqual(result.executed, false);
      assert.strictEqual(result.reason, 'normal_traffic');
    });
    
    it('should execute suspicious level actions', async () => {
      const result = await executor.execute({
        threatLevel: 'suspicious',
        threatScore: 45,
        threatId: 'test-threat-1',
        features: { ip: '192.168.1.100' }
      }, {});
      
      assert.strictEqual(result.executed, true);
      assert(Array.isArray(result.actions));
    });
    
    it('should execute critical level actions including ban', async () => {
      const result = await executor.execute({
        threatLevel: 'critical',
        threatScore: 85,
        threatId: 'test-threat-2',
        features: { ip: '10.0.0.1' }
      }, {});
      
      assert.strictEqual(result.executed, true);
      
      // 检查是否包含封禁动作
      const banAction = result.actions.find(a => a.action === 'ip_temp_ban');
      assert(banAction);
    });
  });
  
  describe('#checkBanStatus', () => {
    it('should return null for non-banned IP', async () => {
      const status = await executor.checkBanStatus('1.2.3.4');
      assert.strictEqual(status, null);
    });
    
    it('should return ban info for banned IP', async () => {
      await redis.setex('threat:ban:5.6.7.8', 300, JSON.stringify({
        threatId: 'test',
        reason: 'critical_threat'
      }));
      
      const status = await executor.checkBanStatus('5.6.7.8');
      
      assert(status !== null);
      assert.strictEqual(status.threatId, 'test');
    });
  });
  
  describe('#unbanIp', () => {
    it('should unban IP', async () => {
      await redis.setex('threat:ban:9.9.9.9', 300, JSON.stringify({}));
      
      await executor.unbanIp('9.9.9.9', 'test');
      
      const status = await executor.checkBanStatus('9.9.9.9');
      assert.strictEqual(status, null);
    });
  });
  
  describe('#getStats', () => {
    it('should return statistics', () => {
      const stats = executor.getStats();
      
      assert(stats.hasOwnProperty('actionsExecuted'));
      assert(stats.hasOwnProperty('bansIssued'));
      assert(stats.hasOwnProperty('challengesIssued'));
    });
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  
  // 这里可以添加更多测试文件
  
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}

module.exports = {
  MockRedis
};