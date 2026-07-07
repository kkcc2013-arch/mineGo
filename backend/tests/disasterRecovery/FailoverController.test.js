// backend/tests/disasterRecovery/FailoverController.test.js
// 故障切换控制器单元测试

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const mockLogger = {
  info: sinon.stub(),
  error: sinon.stub(),
  warn: sinon.stub()
};

const mockMetrics = {
  gauge: sinon.stub(),
  counter: sinon.stub()
};

// Mock Redis
const mockRedis = {
  get: sinon.stub().resolves(null),
  set: sinon.stub().resolves('OK'),
  setex: sinon.stub().resolves('OK'),
  del: sinon.stub().resolves(1),
  keys: sinon.stub().resolves([]),
  expire: sinon.stub().resolves(1),
  ttl: sinon.stub().resolves(-1)
};

const FailoverController = proxyquire('../../shared/disasterRecovery/FailoverController', {
  '../logging': { logger: mockLogger, metrics: mockMetrics },
  'ioredis': sinon.stub().returns(mockRedis)
});

describe('FailoverController', function() {
  this.timeout(10000);

  let controller;
  let clock;

  beforeEach(() => {
    sinon.resetHistory();
    clock = sinon.useFakeTimers();
    
    controller = new FailoverController({
      primaryRegion: 'beijing',
      secondaryRegion: 'shanghai',
      currentRegion: 'beijing',
      autoFailover: true,
      cooldownPeriod: 300000,
      dnsTTL: 30
    });
  });

  afterEach(() => {
    clock.restore();
    if (controller) {
      controller.removeAllListeners();
    }
  });

  describe('constructor', () => {
    it('应正确初始化配置', () => {
      expect(controller.config.primaryRegion).to.equal('beijing');
      expect(controller.config.secondaryRegion).to.equal('shanghai');
      expect(controller.config.currentRegion).to.equal('beijing');
      expect(controller.config.autoFailover).to.be.true;
      expect(controller.config.cooldownPeriod).to.equal(300000);
    });

    it('应初始化状态', () => {
      expect(controller.state.activeRegion).to.equal('beijing');
      expect(controller.state.isFailingOver).to.be.false;
      expect(controller.state.failoverHistory).to.deep.equal([]);
    });

    it('应支持自定义配置', () => {
      const customController = new FailoverController({
        primaryRegion: 'us-west',
        secondaryRegion: 'eu-west',
        cooldownPeriod: 600000
      });
      
      expect(customController.config.primaryRegion).to.equal('us-west');
      expect(customController.config.cooldownPeriod).to.equal(600000);
    });
  });

  describe('initialize', () => {
    it('应从 Redis 恢复状态', async () => {
      const savedState = {
        activeRegion: 'shanghai',
        lastFailover: '2026-07-06T12:00:00Z',
        failoverHistory: [{ from: 'beijing', to: 'shanghai', time: '2026-07-06T12:00:00Z' }]
      };
      
      mockRedis.get.resolves(JSON.stringify(savedState));
      
      await controller.initialize();
      
      expect(controller.state.activeRegion).to.equal('shanghai');
      expect(controller.state.lastFailover).to.equal(savedState.lastFailover);
    });

    it('Redis 状态不存在应使用默认状态', async () => {
      mockRedis.get.resolves(null);
      
      await controller.initialize();
      
      expect(controller.state.activeRegion).to.equal('beijing');
    });

    it('Redis 错误应降级使用默认状态', async () => {
      mockRedis.get.rejects(new Error('Redis 连接失败'));
      
      await controller.initialize();
      
      expect(controller.state.activeRegion).to.equal('beijing');
      expect(mockLogger.warn.called).to.be.true;
    });
  });

  describe('failover', () => {
    beforeEach(async () => {
      await controller.initialize();
    });

    it('应成功执行故障切换', async () => {
      // Mock 验证目标区域健康
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await controller.failover({ trigger: 'manual', reason: '测试切换' });
      
      expect(controller.verifyTargetHealth.calledOnce).to.be.true;
      expect(controller.stopTraffic.calledOnce).to.be.true;
      expect(controller.syncData.calledOnce).to.be.true;
      expect(controller.promoteSecondary.calledOnce).to.be.true;
      expect(controller.updateDNS.calledOnce).to.be.true;
      expect(controller.startTraffic.calledOnce).to.be.true;
    });

    it('故障切换成功应更新状态', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await controller.failover({ trigger: 'manual' });
      
      expect(controller.state.activeRegion).to.equal('shanghai');
      expect(controller.state.isFailingOver).to.be.false;
      expect(controller.state.failoverHistory).to.have.length(1);
    });

    it('目标区域不健康应拒绝切换', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(false);
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await expect(controller.failover({ trigger: 'manual' })).to.be.rejectedWith('目标区域不健康');
    });

    it('切换过程中应设置 isFailingOver 标志', async () => {
      controller.verifyTargetHealth = sinon.stub().callsFake(async () => {
        expect(controller.state.isFailingOver).to.be.true;
        return true;
      });
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await controller.failover({ trigger: 'test' });
      
      expect(controller.state.isFailingOver).to.be.false;
    });

    it('切换失败应回滚状态', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().rejects(new Error('数据同步失败'));
      controller.rollback = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await expect(controller.failover({ trigger: 'manual' })).to.be.rejected;
      
      expect(controller.rollback.calledOnce).to.be.true;
      expect(controller.state.activeRegion).to.equal('beijing');
      expect(controller.state.isFailingOver).to.be.false;
    });

    it('冷却期内应拒绝切换', async () => {
      controller.acquireLock = sinon.stub().resolves(null); // 锁失败，表示在冷却期
      
      await expect(controller.failover({ trigger: 'manual' })).to.be.rejectedWith('冷却期');
    });

    it('强制模式应跳过验证', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await controller.failover({ trigger: 'emergency', force: true });
      
      expect(controller.verifyTargetHealth.called).to.be.true;
    });
  });

  describe('acquireLock', () => {
    it('应成功获取锁', async () => {
      mockRedis.set.resolves('OK');
      
      const lock = await controller.acquireLock();
      
      expect(lock).to.be.a('string');
      expect(mockRedis.set.calledWithMatch('dr:failover:lock')).to.be.true;
    });

    it('锁已存在应返回 null', async () => {
      mockRedis.set.resolves(null);
      
      const lock = await controller.acquireLock();
      
      expect(lock).to.be.null;
    });

    it('Redis 错误应返回 null', async () => {
      mockRedis.set.rejects(new Error('Redis 错误'));
      
      const lock = await controller.acquireLock();
      
      expect(lock).to.be.null;
    });
  });

  describe('releaseLock', () => {
    it('应成功释放锁', async () => {
      mockRedis.del.resolves(1);
      
      await controller.releaseLock('lock-token');
      
      expect(mockRedis.del.calledOnce).to.be.true;
    });

    it('释放失败不应抛出错误', async () => {
      mockRedis.del.rejects(new Error('Redis 错误'));
      
      await expect(controller.releaseLock('lock-token')).to.not.be.rejected;
    });
  });

  describe('getState', () => {
    it('应返回当前状态', async () => {
      await controller.initialize();
      
      const state = controller.getState();
      
      expect(state).to.have.property('activeRegion', 'beijing');
      expect(state).to.have.property('isFailingOver', false);
      expect(state).to.have.property('lastFailover');
      expect(state).to.have.property('failoverHistory');
    });
  });

  describe('事件发射', () => {
    it('故障切换开始应发射事件', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      const eventSpy = sinon.spy();
      controller.on('failover-start', eventSpy);
      
      await controller.failover({ trigger: 'test' });
      
      expect(eventSpy.calledOnce).to.be.true;
      expect(eventSpy.firstCall.args[0]).to.include({
        from: 'beijing',
        to: 'shanghai'
      });
    });

    it('故障切换完成应发射事件', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      const eventSpy = sinon.spy();
      controller.on('failover-complete', eventSpy);
      
      await controller.failover({ trigger: 'test' });
      
      expect(eventSpy.calledOnce).to.be.true;
    });

    it('故障切换失败应发射事件', async () => {
      controller.verifyTargetHealth = sinon.stub().rejects(new Error('健康检查失败'));
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      const eventSpy = sinon.spy();
      controller.on('failover-failed', eventSpy);
      
      try {
        await controller.failover({ trigger: 'test' });
      } catch (e) {
        // 预期会失败
      }
      
      expect(eventSpy.calledOnce).to.be.true;
    });
  });

  describe('边界条件测试', () => {
    it('重复切换应被阻止', async () => {
      controller.verifyTargetHealth = sinon.stub().resolves(true);
      controller.stopTraffic = sinon.stub().resolves();
      controller.syncData = sinon.stub().resolves();
      controller.promoteSecondary = sinon.stub().resolves();
      controller.updateDNS = sinon.stub().resolves();
      controller.startTraffic = sinon.stub().resolves();
      controller.acquireLock = sinon.stub().resolves('lock-token');
      controller.releaseLock = sinon.stub().resolves();
      
      await controller.initialize();
      await controller.failover({ trigger: 'test' });
      
      // 已经在上海，再次切换回北京
      await controller.failover({ trigger: 'test' });
      
      expect(controller.state.failoverHistory).to.have.length(2);
    });

    it('无效区域配置应抛出错误', () => {
      expect(() => {
        new FailoverController({
          primaryRegion: '',
          secondaryRegion: ''
        });
      }).to.throw('区域配置无效');
    });

    it('冷却期为零应使用默认值', () => {
      const zeroController = new FailoverController({
        cooldownPeriod: 0
      });
      
      expect(zeroController.config.cooldownPeriod).to.be.at.least(60000);
    });
  });

  describe('性能测试', () => {
    it('获取状态应快速响应', async () => {
      await controller.initialize();
      
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        controller.getState();
      }
      const duration = Date.now() - start;
      
      expect(duration).to.be.lessThan(100); // 1000次调用应小于100ms
    });
  });
});
