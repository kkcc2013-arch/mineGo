/**
 * IP 封禁系统单元测试
 * REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const IpBanManager = require('../../shared/IpBanManager');

// Mock 数据库和 Redis
const mockDb = {
  connect: () => ({
    query: sinon.stub().resolves({ rows: [] }),
    release: sinon.stub()
  })
};

const mockRedis = {
  get: sinon.stub().resolves(null),
  setex: sinon.stub().resolves('OK'),
  del: sinon.stub().resolves(1),
  hset: sinon.stub().resolves(1),
  hget: sinon.stub().resolves(null),
  hdel: sinon.stub().resolves(1),
  sadd: sinon.stub().resolves(1),
  srem: sinon.stub().resolves(1),
  sismember: sinon.stub().resolves(0),
  del_key: sinon.stub().resolves(1),
  subscribe: sinon.stub().resolves(),
  on: sinon.stub()
};

const mockPublisher = {
  publish: sinon.stub().resolves()
};

describe('IpBanManager', function() {
  this.timeout(10000);

  let ipBanManager;

  beforeEach(() => {
    ipBanManager = new IpBanManager({
      db: mockDb,
      redis: mockRedis,
      publisher: mockPublisher,
      subscriber: mockRedis
    });
    
    // 重置 stubs
    sinon.resetHistory();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('isWhitelisted', () => {
    it('should return true for whitelisted IP', async () => {
      mockRedis.sismember.resolves(1);
      
      const result = await ipBanManager.isWhitelisted('192.168.1.1');
      
      expect(result).to.be.true;
      expect(mockRedis.sismember.calledOnce).to.be.true;
    });

    it('should return false for non-whitelisted IP', async () => {
      mockRedis.sismember.resolves(0);
      
      const result = await ipBanManager.isWhitelisted('10.0.0.1');
      
      expect(result).to.be.false;
    });
  });

  describe('isBlocked', () => {
    it('should return blocked=false for whitelisted IP', async () => {
      mockRedis.sismember.resolves(1);
      
      const result = await ipBanManager.isBlocked('192.168.1.1');
      
      expect(result.blocked).to.be.false;
      expect(result.reason).to.equal('whitelisted');
    });

    it('should return blocked=true for blacklisted IP', async () => {
      mockRedis.sismember.resolves(0);
      mockRedis.hget.resolves('permanent');
      
      const result = await ipBanManager.isBlocked('10.0.0.1');
      
      expect(result.blocked).to.be.true;
      expect(result.reason).to.equal('blacklist');
    });

    it('should return blocked=false for clean IP', async () => {
      mockRedis.sismember.resolves(0);
      mockRedis.hget.resolves(null);
      
      // Mock database query for geo ban
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.isBlocked('8.8.8.8');
      
      expect(result.blocked).to.be.false;
    });
  });

  describe('addToBlacklist', () => {
    it('should add IP to blacklist with default duration', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.addToBlacklist(
        '10.0.0.1',
        'Test reason',
        'medium'
      );
      
      expect(result.success).to.be.true;
      expect(result.ipAddress).to.equal('10.0.0.1');
      expect(mockClient.query.called).to.be.true;
      expect(mockRedis.hset.called).to.be.true;
      expect(mockPublisher.publish.called).to.be.true;
    });

    it('should add IP to blacklist with custom expiry', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const result = await ipBanManager.addToBlacklist(
        '10.0.0.1',
        'Test reason',
        'high',
        expiresAt
      );
      
      expect(result.success).to.be.true;
      expect(result.expiresAt).to.exist;
    });
  });

  describe('removeFromBlacklist', () => {
    it('should remove IP from blacklist', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.removeFromBlacklist('10.0.0.1');
      
      expect(result.success).to.be.true;
      expect(mockRedis.hdel.calledOnce).to.be.true;
    });
  });

  describe('addToWhitelist', () => {
    it('should add IP to whitelist', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.addToWhitelist('192.168.1.1', 'Trusted IP');
      
      expect(result.success).to.be.true;
      expect(mockRedis.sadd.calledOnce).to.be.true;
    });
  });

  describe('recordTrigger', () => {
    it('should increment trigger count', async () => {
      const mockClient = {
        query: sinon.stub()
          .onFirstCall().resolves({ rows: [{ trigger_count: 1 }] })
          .onSecondCall().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.recordTrigger('10.0.0.1', 'gps_cheat');
      
      expect(result.triggered).to.be.true;
      expect(result.autoBanned).to.be.false;
      expect(result.triggerCount).to.equal(1);
    });

    it('should auto-ban when threshold reached', async () => {
      const mockClient = {
        query: sinon.stub()
          .onFirstCall().resolves({ rows: [{ trigger_count: 5 }] })
          .onSecondCall().resolves({ rows: [] })
          .onThirdCall().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.recordTrigger('10.0.0.1', 'gps_cheat');
      
      expect(result.autoBanned).to.be.true;
    });
  });

  describe('getRiskScore', () => {
    it('should return cached risk score', async () => {
      mockRedis.get.resolves('50');
      
      const score = await ipBanManager.getRiskScore('10.0.0.1');
      
      expect(score).to.equal(50);
      expect(mockRedis.get.calledOnce).to.be.true;
    });

    it('should query database when not cached', async () => {
      mockRedis.get.resolves(null);
      const mockClient = {
        query: sinon.stub().resolves({ rows: [{ risk_score: 30 }] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const score = await ipBanManager.getRiskScore('10.0.0.1');
      
      expect(score).to.equal(30);
    });
  });

  describe('updateRiskScore', () => {
    it('should update risk score and clear cache', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      mockRedis.get.resolves('60');
      
      const newScore = await ipBanManager.updateRiskScore('10.0.0.1', 10, 'test');
      
      expect(mockRedis.del.calledOnce).to.be.true;
    });
  });

  describe('submitAppeal', () => {
    it('should submit appeal successfully', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [{ id: 1 }] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.submitAppeal('10.0.0.1', 1, 'Test appeal');
      
      expect(result.appealId).to.equal(1);
    });
  });

  describe('processAppeal', () => {
    it('should approve appeal and unban IP', async () => {
      const mockClient = {
        query: sinon.stub()
          .onFirstCall().resolves({ rows: [{ ip_address: '10.0.0.1' }] })
          .onSecondCall().resolves({ rows: [] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.processAppeal(1, true, 1, 'Approved');
      
      expect(result.success).to.be.true;
      expect(result.approved).to.be.true;
    });

    it('should reject appeal without unbanning IP', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [{ ip_address: '10.0.0.1' }] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const result = await ipBanManager.processAppeal(1, false, 1, 'Rejected');
      
      expect(result.success).to.be.true;
      expect(result.approved).to.be.false;
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      const mockClient = {
        query: sinon.stub()
          .onFirstCall().resolves({ rows: [{ count: '10' }] })
          .onSecondCall().resolves({ rows: [{ count: '5' }] })
          .onThirdCall().resolves({ rows: [{ count: '3' }] })
          .onCall(3).resolves({ rows: [{ count: '2' }] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const stats = await ipBanManager.getStats();
      
      expect(stats.blacklist).to.equal(10);
      expect(stats.whitelist).to.equal(5);
      expect(stats.pendingAppeals).to.equal(3);
      expect(stats.highRiskIps).to.equal(2);
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired bans', async () => {
      const mockClient = {
        query: sinon.stub().resolves({ rows: [{ ip_address: '10.0.0.1' }] }),
        release: sinon.stub()
      };
      ipBanManager.db.connect = sinon.stub().resolves(mockClient);
      
      const count = await ipBanManager.cleanupExpired();
      
      expect(count).to.equal(1);
      expect(mockRedis.hdel.calledOnce).to.be.true;
    });
  });
});

describe('IP Ban Middleware', () => {
  const { ipBanMiddleware, getClientIp } = require('../../gateway/src/middleware/ipBan');
  
  describe('getClientIp', () => {
    it('should extract IP from x-forwarded-for header', () => {
      const req = {
        headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
        ip: '127.0.0.1'
      };
      
      const ip = getClientIp(req);
      
      expect(ip).to.equal('10.0.0.1');
    });

    it('should extract IP from x-real-ip header', () => {
      const req = {
        headers: { 'x-real-ip': '10.0.0.1' },
        ip: '127.0.0.1'
      };
      
      const ip = getClientIp(req);
      
      expect(ip).to.equal('10.0.0.1');
    });

    it('should fallback to connection remote address', () => {
      const req = {
        headers: {},
        ip: undefined,
        connection: { remoteAddress: '10.0.0.1' }
      };
      
      const ip = getClientIp(req);
      
      expect(ip).to.equal('10.0.0.1');
    });
  });
});

describe('IP Ban Admin API', () => {
  // 这里可以添加 Admin API 的测试
  // 实际项目中应该使用 supertest 进行集成测试
});
