/**
 * 反作弊规则动态更新与灰度测试系统单元测试
 * REQ-00608
 */

'use strict';

const assert = require('assert');
const { DynamicRuleLoader } = require('../../../shared/risk-engine/DynamicRuleLoader');

// Mock database and redis
const mockDb = {
  query: async (sql, params) => {
    if (sql.includes('SELECT * FROM anti_cheat_rules')) {
      return {
        rows: [
          {
            rule_id: 'SPEED_HACK_001',
            rule_name: '速度异常检测',
            category: 'location',
            config: { thresholds: { maxSpeed: 100 }, enabled: true },
            rollout_strategy: 'instant',
            rollout_percentage: 100,
            ab_test_enabled: false,
            stats: { totalChecks: 1000, matchedCount: 50 }
          }
        ]
      };
    }
    return { rows: [] };
  }
};

const mockRedis = {
  get: async (key) => null,
  setex: async (key, ttl, value) => true,
  del: async (key) => true,
  subscribe: async (channel, callback) => {},
  on: (event, callback) => {},
  publish: async (channel, message) => true
};

describe('DynamicRuleLoader', () => {
  let loader;

  beforeEach(() => {
    loader = new DynamicRuleLoader(mockDb, mockRedis);
  });

  describe('hashUserId', () => {
    it('should return consistent hash for same user ID', () => {
      const hash1 = loader.hashUserId(12345);
      const hash2 = loader.hashUserId(12345);
      assert.strictEqual(hash1, hash2);
    });

    it('should return different hashes for different user IDs', () => {
      const hash1 = loader.hashUserId(12345);
      const hash2 = loader.hashUserId(67890);
      assert.notStrictEqual(hash1, hash2);
    });

    it('should return value between 0-99', () => {
      for (let i = 0; i < 100; i++) {
        const hash = loader.hashUserId(i);
        assert(hash >= 0 && hash < 100, `Hash ${hash} out of range`);
      }
    });
  });

  describe('selectVariant', () => {
    it('should select control for low hash values', () => {
      const variants = [
        { id: 'control', config: {}, percentage: 50 },
        { id: 'treatment', config: {}, percentage: 50 }
      ];

      // Mock hash to return 20
      loader.hashUserId = () => 20;
      const variant = loader.selectVariant(123, variants);
      assert.strictEqual(variant.id, 'control');
    });

    it('should select treatment for high hash values', () => {
      const variants = [
        { id: 'control', config: {}, percentage: 50 },
        { id: 'treatment', config: {}, percentage: 50 }
      ];

      // Mock hash to return 80
      loader.hashUserId = () => 80;
      const variant = loader.selectVariant(123, variants);
      assert.strictEqual(variant.id, 'treatment');
    });
  });

  describe('loadActiveRules', () => {
    it('should load rules from database', async () => {
      const rules = await loader.loadActiveRules();
      assert(Array.isArray(rules));
      assert.strictEqual(rules.length, 1);
      assert.strictEqual(rules[0].rule_id, 'SPEED_HACK_001');
    });
  });

  describe('getRuleForUser', () => {
    it('should return rule for user not in A/B test', async () => {
      await loader.loadActiveRules();
      const rule = await loader.getRuleForUser('SPEED_HACK_001', 12345);
      assert(rule);
      assert.strictEqual(rule.rule_id, 'SPEED_HACK_001');
    });

    it('should return null for non-existent rule', async () => {
      const rule = await loader.getRuleForUser('NON_EXISTENT_RULE', 12345);
      assert.strictEqual(rule, null);
    });
  });
});

// Run tests if executed directly
if (require.main === module) {
  const mocha = require('mocha');
  const runner = new mocha({ timeout: 5000 });
  runner.addFile(__filename);
  runner.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}
