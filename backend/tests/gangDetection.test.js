/**
 * 团伙检测引擎单元测试
 * REQ-00550: 协同作弊团伙检测系统
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const GangDetectionEngine = require('../GangDetectionEngine');

describe('GangDetectionEngine', () => {
  let engine;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    mockDb = {
      query: sinon.stub(),
      end: sinon.stub().resolves()
    };
    mockRedis = {
      get: sinon.stub(),
      set: sinon.stub(),
      quit: sinon.stub().resolves()
    };
    
    engine = new GangDetectionEngine({ dbUrl: 'test', redisUrl: 'test' });
    engine.db = mockDb;
    engine.redis = mockRedis;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('calculateGangRiskScore', () => {
    it('should return 0 for empty gang', () => {
      const gang = { members: [], density: 0, collabEvents: [] };
      const score = engine.calculateGangRiskScore(gang);
      expect(score).to.equal(0);
    });

    it('should increase score with member count', () => {
      const gang1 = { members: ['a', 'b'], density: 0, collabEvents: [] };
      const gang2 = { members: ['a', 'b', 'c', 'd'], density: 0, collabEvents: [] };
      
      const score1 = engine.calculateGangRiskScore(gang1);
      const score2 = engine.calculateGangRiskScore(gang2);
      
      expect(score2).to.be.greaterThan(score1);
    });

    it('should increase score with density', () => {
      const gang1 = { members: ['a', 'b'], density: 0.5, collabEvents: [] };
      const gang2 = { members: ['a', 'b'], density: 0.9, collabEvents: [] };
      
      const score1 = engine.calculateGangRiskScore(gang1);
      const score2 = engine.calculateGangRiskScore(gang2);
      
      expect(score2).to.be.greaterThan(score1);
    });

    it('should cap score at 100', () => {
      const gang = {
        members: Array(50).fill('user'),
        density: 1,
        collabEvents: Array(100).fill({ detected_at: new Date().toISOString(), value_score: 10000 })
      };
      
      const score = engine.calculateGangRiskScore(gang);
      expect(score).to.be.at.most(100);
    });
  });

  describe('determineRiskLevel', () => {
    it('should return critical for score >= 85', () => {
      expect(engine.determineRiskLevel(85)).to.equal('critical');
      expect(engine.determineRiskLevel(100)).to.equal('critical');
    });

    it('should return high for score >= 70', () => {
      expect(engine.determineRiskLevel(70)).to.equal('high');
      expect(engine.determineRiskLevel(84)).to.equal('high');
    });

    it('should return medium for score >= 40', () => {
      expect(engine.determineRiskLevel(40)).to.equal('medium');
      expect(engine.determineRiskLevel(69)).to.equal('medium');
    });

    it('should return low for score < 40', () => {
      expect(engine.determineRiskLevel(0)).to.equal('low');
      expect(engine.determineRiskLevel(39)).to.equal('low');
    });
  });

  describe('detectGangs', () => {
    it('should return empty array for empty graph', async () => {
      const graph = new Map();
      const gangs = await engine.detectGangs(graph);
      expect(gangs).to.deep.equal([]);
    });

    it('should detect connected components as gangs', async () => {
      const graph = new Map([
        ['user1:user2', 5],
        ['user2:user3', 3],
        ['user1:user3', 2]
      ]);
      
      const gangs = await engine.detectGangs(graph);
      expect(gangs.length).to.be.greaterThan(0);
      expect(gangs[0].members).to.include('user1');
    });
  });

  describe('clusterByTime', () => {
    it('should return empty array for empty items', () => {
      const clusters = engine.clusterByTime([], 1000);
      expect(clusters).to.deep.equal([]);
    });

    it('should cluster items within time window', () => {
      const now = Date.now();
      const items = [
        { catch_timestamp: now },
        { catch_timestamp: now + 1000 },
        { catch_timestamp: now + 2000 }
      ];
      
      const clusters = engine.clusterByTime(items, 5000);
      expect(clusters.length).to.equal(1);
      expect(clusters[0].length).to.equal(3);
    });

    it('should separate items beyond time window', () => {
      const now = Date.now();
      const items = [
        { catch_timestamp: now },
        { catch_timestamp: now + 10000 } // 10秒后
      ];
      
      const clusters = engine.clusterByTime(items, 5000);
      expect(clusters.length).to.equal(0); // 单项不形成聚类
    });
  });

  describe('computeCentroid', () => {
    it('should return zero for empty locations', () => {
      const centroid = engine.computeCentroid([]);
      expect(centroid.lat).to.equal(0);
      expect(centroid.lng).to.equal(0);
    });

    it('should compute average position', () => {
      const locations = [
        { lat: 0, lng: 0 },
        { lat: 2, lng: 4 }
      ];
      
      const centroid = engine.computeCentroid(locations);
      expect(centroid.lat).to.equal(1);
      expect(centroid.lng).to.equal(2);
    });
  });

  describe('distance', () => {
    it('should return 0 for same point', () => {
      const point = { lat: 31.2304, lng: 121.4737 };
      expect(engine.distance(point, point)).to.equal(0);
    });

    it('should calculate distance correctly', () => {
      // 上海到北京约 1200km
      const shanghai = { lat: 31.2304, lng: 121.4737 };
      const beijing = { lat: 39.9042, lng: 116.4074 };
      
      const distance = engine.distance(shanghai, beijing);
      expect(distance).to.be.approximately(1200000, 50000); // 1200km ± 50km
    });
  });

  describe('getUserGangInfo', () => {
    it('should return null for user not in any gang', async () => {
      mockDb.query.resolves({ rows: [] });
      
      const info = await engine.getUserGangInfo('unknown_user');
      expect(info).to.be.null;
    });

    it('should return gang info for gang member', async () => {
      mockDb.query.resolves({
        rows: [{
          gang_id: 'gang_123',
          user_id: 'user_456',
          role: 'core',
          risk_score: 75,
          risk_level: 'high'
        }]
      });
      
      const info = await engine.getUserGangInfo('user_456');
      expect(info).to.not.be.null;
      expect(info.gang_id).to.equal('gang_123');
    });
  });

  describe('createGang', () => {
    it('should create gang with auto-generated ID', async () => {
      mockDb.query.resolves({
        rows: [{
          gang_id: 'gang_123',
          name: 'Test Gang',
          risk_score: 0
        }]
      });
      
      const gang = await engine.createGang({ members: ['user1'] });
      expect(gang).to.not.be.undefined;
      expect(gang.gang_id).to.match(/^gang_/);
    });
  });

  describe('addGangMember', () => {
    it('should add member to gang', async () => {
      mockDb.query.resolves({
        rows: [{
          gang_id: 'gang_123',
          user_id: 'user_456',
          role: 'member'
        }]
      });
      
      const member = await engine.addGangMember('gang_123', 'user_456');
      expect(member).to.not.be.undefined;
    });
  });
});

describe('GangActionEngine', () => {
  let actionEngine;
  let mockDb;

  beforeEach(() => {
    mockDb = {
      query: sinon.stub(),
      end: sinon.stub().resolves()
    };
    
    const GangActionEngine = require('../GangActionEngine');
    actionEngine = new GangActionEngine({ dbUrl: 'test' });
    actionEngine.db = mockDb;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('determineAction', () => {
    it('should return monitor for low risk score', () => {
      expect(actionEngine.determineAction(0)).to.equal('monitor');
      expect(actionEngine.determineAction(39)).to.equal('monitor');
    });

    it('should return restrict for medium risk score', () => {
      expect(actionEngine.determineAction(40)).to.equal('restrict');
      expect(actionEngine.determineAction(69)).to.equal('restrict');
    });

    it('should return restrict_hard for high risk score', () => {
      expect(actionEngine.determineAction(70)).to.equal('restrict_hard');
      expect(actionEngine.determineAction(84)).to.equal('restrict_hard');
    });

    it('should return ban for critical risk score', () => {
      expect(actionEngine.determineAction(85)).to.equal('ban');
      expect(actionEngine.determineAction(100)).to.equal('ban');
    });
  });

  describe('parseDuration', () => {
    it('should parse days', () => {
      expect(actionEngine.parseDuration('30d')).to.equal(30 * 24 * 60 * 60 * 1000);
    });

    it('should parse hours', () => {
      expect(actionEngine.parseDuration('24h')).to.equal(24 * 60 * 60 * 1000);
    });

    it('should parse minutes', () => {
      expect(actionEngine.parseDuration('60m')).to.equal(60 * 60 * 1000);
    });

    it('should return default for invalid format', () => {
      expect(actionEngine.parseDuration('invalid')).to.equal(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe('executeAction', () => {
    it('should log activity for monitor action', async () => {
      mockDb.query.resolves({ rowCount: 1 });
      
      const gang = { gang_id: 'gang_123', members: [] };
      const result = await actionEngine.executeAction(gang, 'monitor');
      
      expect(result.success).to.be.true;
      expect(result.action).to.equal('monitor');
    });
  });
});