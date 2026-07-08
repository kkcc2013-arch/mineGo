// backend/tests/unit/RiskControlEngine.test.js
'use strict';

const { RiskControlEngine, CONFIG } = require('../../shared/RiskControlEngine');
const { expect } = require('chai');
const sinon = require('sinon');

// Mock 数据库和 Redis
const mockDb = {
  query: sinon.stub()
};

const mockRedis = {
  get: sinon.stub(),
  set: sinon.stub(),
  setex: sinon.stub(),
  incr: sinon.stub(),
  expire: sinon.stub()
};

describe('RiskControlEngine', () => {
  let engine;
  
  beforeEach(() => {
    engine = new RiskControlEngine({
      db: mockDb,
      redis: mockRedis
    });
    
    // 重置 stub
    mockDb.query.reset();
    mockRedis.get.reset();
    mockRedis.set.reset();
    mockRedis.setex.reset();
  });
  
  describe('速度异常检测 (SPEED_HACK_001)', () => {
    it('应该检测到瞬移作弊（速度超过 200 m/s）', async () => {
      const events = [
        {
          type: 'location_update',
          latitude: 40.7128,
          longitude: -74.0060,
          timestamp: Date.now() - 1000
        },
        {
          type: 'location_update',
          latitude: 34.0522,
          longitude: -118.2437, // 洛杉矶，距离纽约约 3935 公里
          timestamp: Date.now()
        }
      ];
      
      const rule = engine.rules.find(r => r.id === 'SPEED_HACK_001');
      const result = await rule.check(events, { windowSize: 1 });
      
      expect(result).to.not.be.null;
      expect(result.matched).to.be.true;
      expect(result.severity).to.equal('critical');
      expect(result.score).to.equal(100);
    });
    
    it('应该检测到高速移动（速度超过 50 m/s）', async () => {
      const events = [
        {
          type: 'location_update',
          latitude: 40.7128,
          longitude: -74.0060,
          timestamp: Date.now() - 1000
        },
        {
          type: 'location_update',
          latitude: 40.7200,
          longitude: -74.0060, // 约 800 米
          timestamp: Date.now()
        }
      ];
      
      const rule = engine.rules.find(r => r.id === 'SPEED_HACK_001');
      const result = await rule.check(events, { windowSize: 1 });
      
      expect(result).to.not.be.null;
      expect(result.matched).to.be.true;
      expect(result.severity).to.equal('high');
    });
    
    it('应该允许正常步行速度', async () => {
      const events = [
        {
          type: 'location_update',
          latitude: 40.7128,
          longitude: -74.0060,
          timestamp: Date.now() - 1000
        },
        {
          type: 'location_update',
          latitude: 40.7130,
          longitude: -74.0060, // 约 22 米
          timestamp: Date.now()
        }
      ];
      
      const rule = engine.rules.find(r => r.id === 'SPEED_HACK_001');
      const result = await rule.check(events, { windowSize: 1 });
      
      expect(result).to.be.null;
    });
  });
  
  describe('捕捉频率检测 (CATCH_FREQUENCY_001)', () => {
    it('应该检测到超高频率捕捉（每分钟 > 60 次）', async () => {
      const events = [];
      for (let i = 0; i < 100; i++) {
        events.push({
          type: 'pokemon_catch',
          timestamp: Date.now() - (100 - i) * 600
        });
      }
      
      const rule = engine.rules.find(r => r.id === 'CATCH_FREQUENCY_001');
      const result = await rule.check(events, { windowSize: 3600 });
      
      expect(result).to.not.be.null;
      expect(result.matched).to.be.true;
      expect(result.severity).to.equal('critical');
    });
    
    it('应该检测到高频率捕捉（每分钟 > 30 次）', async () => {
      const events = [];
      for (let i = 0; i < 40; i++) {
        events.push({
          type: 'pokemon_catch',
          timestamp: Date.now() - i * 2000
        });
      }
      
      const rule = engine.rules.find(r => r.id === 'CATCH_FREQUENCY_001');
      const result = await rule.check(events, { windowSize: 60 });
      
      expect(result).to.not.be.null;
      expect(result.matched).to.be.true;
      expect(result.severity).to.equal('high');
    });
    
    it('应该允许正常捕捉频率', async () => {
      const events = [];
      for (let i = 0; i < 15; i++) {
        events.push({
          type: 'pokemon_catch',
          timestamp: Date.now() - i * 4000
        });
      }
      
      const rule = engine.rules.find(r => r.id === 'CATCH_FREQUENCY_001');
      const result = await rule.check(events, { windowSize: 60 });
      
      expect(result).to.be.null;
    });
  });
  
  describe('GPS 伪造检测 (LOCATION_SPOOF_001)', () => {
    it('应该检测到完美直线移动（异常）', async () => {
      const events = [];
      // 创建完美直线轨迹
      for (let i = 0; i < 10; i++) {
        events.push({
          type: 'location_update',
          latitude: 40.7128 + i * 0.001,
          longitude: -74.0060,
          accuracy: 5,
          timestamp: Date.now() - (10 - i) * 1000
        });
      }
      
      const rule = engine.rules.find(r => r.id === 'LOCATION_SPOOF_001');
      const result = await rule.check(events, { windowSize: 60 });
      
      expect(result).to.not.be.null;
      expect(result.matched).to.be.true;
    });
    
    it('应该检测到完美精度（异常）', async () => {
      const events = [];
      for (let i = 0; i < 10; i++) {
        events.push({
          type: 'location_update',
          latitude: 40.7128 + i * 0.0001 + Math.random() * 0.0001,
          longitude: -74.0060 + i * 0.0001 + Math.random() * 0.0001,
          accuracy: 0.5, // 异常完美的精度
          timestamp: Date.now() - i * 1000
        });
      }
      
      const rule = engine.rules.find(r => r.id === 'LOCATION_SPOOF_001');
      const result = await rule.check(events, { windowSize: 60 });
      
      expect(result).to.not.be.null;
    });
  });
  
  describe('综合风险评分', () => {
    it('应该计算综合风险分数', () => {
      const results = [
        { rule_id: 'RULE_1', score: 85, severity: 'high' },
        { rule_id: 'RULE_2', score: 60, severity: 'medium' },
        { rule_id: 'RULE_3', score: 70, severity: 'medium' }
      ];
      
      const score = engine.calculateOverallScore(results);
      
      // 最高分 85 + (60 * 0.1 + 70 * 0.1) = 85 + 13 = 98
      expect(score).to.be.within(85, 100);
    });
    
    it('空结果应该返回 0', () => {
      const score = engine.calculateOverallScore([]);
      expect(score).to.equal(0);
    });
    
    it('单个结果应该返回其分数', () => {
      const results = [{ rule_id: 'RULE_1', score: 75, severity: 'medium' }];
      const score = engine.calculateOverallScore(results);
      expect(score).to.equal(75);
    });
  });
  
  describe('行动决策', () => {
    it('分数 >= 95 应该触发永久封禁', () => {
      const results = [{ rule_id: 'R1', score: 95, severity: 'critical' }];
      const action = engine.decideAction(95, results);
      expect(action).to.equal('perm_ban');
    });
    
    it('分数 >= 85 应该触发临时封禁', () => {
      const results = [{ rule_id: 'R1', score: 85, severity: 'high' }];
      const action = engine.decideAction(85, results);
      expect(action).to.equal('temp_ban');
    });
    
    it('分数 >= 75 应该触发限速', () => {
      const results = [{ rule_id: 'R1', score: 75, severity: 'high' }];
      const action = engine.decideAction(75, results);
      expect(action).to.equal('rate_limit');
    });
    
    it('分数 >= 60 应该触发警告', () => {
      const results = [{ rule_id: 'R1', score: 60, severity: 'medium' }];
      const action = engine.decideAction(60, results);
      expect(action).to.equal('warning');
    });
    
    it('分数 < 60 不应触发任何行动', () => {
      const results = [{ rule_id: 'R1', score: 50, severity: 'low' }];
      const action = engine.decideAction(50, results);
      expect(action).to.be.null;
    });
    
    it('2 个以上严重规则应该触发永久封禁', () => {
      const results = [
        { rule_id: 'R1', score: 80, severity: 'critical' },
        { rule_id: 'R2', score: 85, severity: 'critical' }
      ];
      const action = engine.decideAction(85, results);
      expect(action).to.equal('perm_ban');
    });
  });
  
  describe('数据库操作', () => {
    it('应该正确记录审计日志', async () => {
      mockDb.query.resolves({ rows: [] });
      
      const userId = 123;
      const event = { type: 'location_update', timestamp: Date.now() };
      const results = [{ rule_id: 'R1', score: 75 }];
      
      await engine.recordAuditLog(userId, event, results, 75, 'warning');
      
      expect(mockDb.query.calledOnce).to.be.true;
      const queryArg = mockDb.query.getCall(0).args[0];
      expect(queryArg).to.include('INSERT INTO anti_cheat_audit_logs');
    });
    
    it('应该正确记录封禁', async () => {
      mockDb.query.resolves({ rows: [] });
      
      const userId = 123;
      const result = { rule_id: 'R1', score: 95, message: 'Speed hack detected' };
      
      await engine.auditBan(userId, 'perm_ban', result);
      
      expect(mockDb.query.calledOnce).to.be.true;
      const queryArg = mockDb.query.getCall(0).args[0];
      expect(queryArg).to.include('INSERT INTO user_bans');
    });
  });
  
  describe('手动检测', () => {
    it('应该返回完整的风险分析结果', async () => {
      mockDb.query.resolves({
        rows: [
          {
            event_type: 'location_update',
            event_data: { latitude: 40.7128, longitude: -74.0060 },
            created_at: new Date()
          }
        ]
      });
      
      const result = await engine.manualCheck(123, 3600);
      
      expect(result).to.have.property('userId');
      expect(result).to.have.property('windowSize');
      expect(result).to.have.property('eventCount');
      expect(result).to.have.property('results');
      expect(result).to.have.property('score');
      expect(result).to.have.property('action');
    });
  });
  
  describe('边界情况', () => {
    it('空事件窗口应该返回 0 分', async () => {
      const results = await engine.executeRules([], { windowSize: 60 });
      const score = engine.calculateOverallScore(results);
      
      expect(score).to.equal(0);
    });
    
    it('单个事件不应该触发速度检测', async () => {
      const events = [
        {
          type: 'location_update',
          latitude: 40.7128,
          longitude: -74.0060,
          timestamp: Date.now()
        }
      ];
      
      const rule = engine.rules.find(r => r.id === 'SPEED_HACK_001');
      const result = await rule.check(events, { windowSize: 60 });
      
      expect(result).to.be.null;
    });
    
    it('无效事件类型应该被忽略', async () => {
      const events = [
        { type: 'invalid_type', timestamp: Date.now() },
        { type: 'another_invalid', timestamp: Date.now() }
      ];
      
      const results = await engine.executeRules(events, { windowSize: 60 });
      const score = engine.calculateOverallScore(results);
      
      expect(score).to.equal(0);
    });
  });
});

describe('辅助函数', () => {
  describe('calculateDistance', () => {
    it('应该计算两点之间的距离', () => {
      const distance = calculateDistance(40.7128, -74.0060, 34.0522, -118.2437);
      // 纽约到洛杉矶约 3935 公里
      expect(distance).to.be.within(3900000, 4000000);
    });
    
    it('相同点应该返回 0', () => {
      const distance = calculateDistance(40.7128, -74.0060, 40.7128, -74.0060);
      expect(distance).to.equal(0);
    });
  });
  
  describe('calculateVariance', () => {
    it('应该计算方差', () => {
      const variance = calculateVariance([1, 2, 3, 4, 5]);
      expect(variance).to.equal(2);
    });
    
    it('单个值应该返回 0', () => {
      const variance = calculateVariance([5]);
      expect(variance).to.equal(0);
    });
  });
  
  describe('hasTimeOverlap', () => {
    it('应该检测重叠的时间范围', () => {
      const times1 = [1000, 2000, 3000];
      const times2 = [2500, 3500, 4500];
      
      const overlap = hasTimeOverlap(times1, times2, 1000);
      expect(overlap).to.be.true;
    });
    
    it('应该检测不重叠的时间范围', () => {
      const times1 = [1000, 2000, 3000];
      const times2 = [10000, 11000, 12000];
      
      const overlap = hasTimeOverlap(times1, times2, 1000);
      expect(overlap).to.be.false;
    });
  });
});

// 导入辅助函数用于测试
const { 
  calculateDistance, 
  calculateVariance, 
  hasTimeOverlap 
} = require('../../shared/RiskControlEngine');
