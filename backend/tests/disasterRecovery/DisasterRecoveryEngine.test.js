// backend/tests/disasterRecovery/DisasterRecoveryEngine.test.js
// 灾备引擎核心模块单元测试

const { describe, it, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Mock 依赖
const mockLogger = {
  info: sinon.stub(),
  error: sinon.stub(),
  warn: sinon.stub(),
  debug: sinon.stub()
};

const mockMetrics = {
  gauge: sinon.stub(),
  counter: sinon.stub(),
  histogram: sinon.stub()
};

// Mock 子组件
const mockPgManager = {
  initialize: sinon.stub().resolves(),
  startMonitoring: sinon.stub().resolves(),
  getReplicationLag: sinon.stub().resolves(100),
  promoteToPrimary: sinon.stub().resolves(),
  demoteToSecondary: sinon.stub().resolves()
};

const mockRedisGeo = {
  initialize: sinon.stub().resolves(),
  getSyncStatus: sinon.stub().resolves({ lag: 50, lastSync: Date.now() })
};

const mockGslb = {
  getActiveRegion: sinon.stub().resolves('beijing'),
  switchRegion: sinon.stub().resolves(),
  healthCheck: sinon.stub().resolves({ healthy: true })
};

// 使用 proxyquire 注入 mock
const DisasterRecoveryEngine = proxyquire('../../shared/disasterRecovery/DisasterRecoveryEngine', {
  '../logger': mockLogger,
  '../metrics': { metrics: mockMetrics },
  './PostgreSQLReplicationManager': sinon.stub().returns(mockPgManager),
  './RedisGeoReplication': sinon.stub().returns(mockRedisGeo),
  './GSLBController': sinon.stub().returns(mockGslb)
});

describe('DisasterRecoveryEngine', function() {
  this.timeout(10000);

  let engine;
  let clock;

  beforeEach(() => {
    // 重置所有 stub
    sinon.resetHistory();
    
    // 使用 fake timers
    clock = sinon.useFakeTimers();

    // 创建引擎实例
    engine = new DisasterRecoveryEngine({
      primaryRegion: 'beijing',
      standbyRegion: 'shanghai',
      rtoTarget: 300000,
      rpoTarget: 60000,
      healthCheckInterval: 10000,
      failureThreshold: 3,
      recoveryThreshold: 5
    });
  });

  afterEach(() => {
    clock.restore();
    if (engine) {
      engine.stop();
    }
  });

  describe('constructor', () => {
    it('应正确初始化配置参数', () => {
      expect(engine.primaryRegion).to.equal('beijing');
      expect(engine.standbyRegion).to.equal('shanghai');
      expect(engine.rtoTarget).to.equal(300000);
      expect(engine.rpoTarget).to.equal(60000);
      expect(engine.healthCheckInterval).to.equal(10000);
      expect(engine.failureThreshold).to.equal(3);
      expect(engine.recoveryThreshold).to.equal(5);
    });

    it('应使用默认值初始化可选参数', () => {
      const defaultEngine = new DisasterRecoveryEngine();
      expect(defaultEngine.primaryRegion).to.equal('beijing');
      expect(defaultEngine.rtoTarget).to.equal(300000);
    });

    it('应正确初始化内部状态', () => {
      expect(engine.failureCounts).to.be.instanceOf(Map);
      expect(engine.recoveryCounts).to.be.instanceOf(Map);
      expect(engine.isFailedOver).to.be.false;
      expect(engine.failoverInProgress).to.be.false;
    });
  });

  describe('start', () => {
    it('应成功启动所有子组件', async () => {
      await engine.start();
      
      expect(mockPgManager.initialize.calledOnce).to.be.true;
      expect(mockPgManager.startMonitoring.calledOnce).to.be.true;
      expect(mockRedisGeo.initialize.calledOnce).to.be.true;
    });

    it('应启动健康检查定时器', async () => {
      await engine.start();
      
      // 验证定时器被创建
      expect(engine.monitors.has('healthCheck')).to.be.true;
      expect(engine.monitors.has('rpoCheck')).to.be.true;
      expect(engine.monitors.has('rtoCheck')).to.be.true;
    });

    it('子组件初始化失败时应抛出错误', async () => {
      mockPgManager.initialize.rejects(new Error('初始化失败'));
      
      await expect(engine.start()).to.be.rejectedWith('初始化失败');
    });
  });

  describe('stop', () => {
    it('应停止所有监控定时器', async () => {
      await engine.start();
      await engine.stop();
      
      engine.monitors.forEach((timer) => {
        expect(timer._idleNext).to.be.null; // clearInterval 后应该被清除
      });
    });
  });

  describe('performHealthCheck', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('健康时应增加恢复计数', async () => {
      mockGslb.healthCheck.resolves({ healthy: true });
      mockPgManager.getReplicationLag.resolves(100);
      
      await engine.performHealthCheck();
      
      const recoveryCount = engine.recoveryCounts.get('overall') || 0;
      expect(recoveryCount).to.be.at.least(1);
    });

    it('不健康时应增加失败计数', async () => {
      mockGslb.healthCheck.rejects(new Error('健康检查失败'));
      
      await engine.performHealthCheck();
      
      const failureCount = engine.failureCounts.get('overall') || 0;
      expect(failureCount).to.equal(1);
    });

    it('连续失败达到阈值应触发故障切换', async () => {
      mockGslb.healthCheck.rejects(new Error('服务不可用'));
      
      // 触发足够的失败次数
      for (let i = 0; i < engine.failureThreshold; i++) {
        await engine.performHealthCheck();
      }
      
      expect(engine.failoverInProgress).to.be.true;
    });

    it('健康检查超时应被正确处理', async () => {
      mockGslb.healthCheck.callsFake(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 5000);
        });
      });
      
      await engine.performHealthCheck();
      
      const failureCount = engine.failureCounts.get('overall') || 0;
      expect(failureCount).to.equal(1);
    });
  });

  describe('checkRPO', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('RPO 在目标范围内应记录正常', async () => {
      mockPgManager.getReplicationLag.resolves(50000); // 50 秒，小于目标 60 秒
      mockRedisGeo.getSyncStatus.resolves({ lag: 40000, lastSync: Date.now() });
      
      await engine.checkRPO();
      
      expect(mockLogger.info.calledWithMatch(sinon.match({ rpo: 'ok' }))).to.be.true;
    });

    it('RPO 超出目标应告警', async () => {
      mockPgManager.getReplicationLag.resolves(120000); // 120 秒，超出目标
      mockRedisGeo.getSyncStatus.resolves({ lag: 100000, lastSync: Date.now() });
      
      await engine.checkRPO();
      
      expect(mockLogger.warn.calledWithMatch(sinon.match({ rpo: 'exceeded' }))).to.be.true;
    });

    it('应计算最大复制延迟作为 RPO', async () => {
      mockPgManager.getReplicationLag.resolves(30000);
      mockRedisGeo.getSyncStatus.resolves({ lag: 50000, lastSync: Date.now() });
      
      await engine.checkRPO();
      
      // RPO 应取两者最大值
      const maxLag = Math.max(30000, 50000);
      expect(mockLogger.info.calledWithMatch(sinon.match({ maxLag }))).to.be.true;
    });
  });

  describe('checkRTO', () => {
    it('故障切换中时应跟踪 RTO', async () => {
      engine.failoverInProgress = true;
      engine.failoverStartTime = Date.now() - 60000; // 1 分钟前开始
      
      await engine.checkRTO();
      
      expect(mockLogger.info.calledWithMatch(sinon.match({ 
        rtoElapsed: sinon.match.number 
      }))).to.be.true;
    });

    it('RTO 超出目标应紧急告警', async () => {
      engine.failoverInProgress = true;
      engine.failoverStartTime = Date.now() - 400000; // 超出 5 分钟目标
      
      await engine.checkRTO();
      
      expect(mockLogger.error.calledWithMatch(sinon.match({ 
        rto: 'exceeded' 
      }))).to.be.true;
    });
  });

  describe('initiateFailover', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('应按顺序执行故障切换步骤', async () => {
      await engine.initiateFailover({ trigger: 'test' });
      
      // 验证步骤顺序
      expect(mockGslb.healthCheck.calledBefore(mockGslb.switchRegion)).to.be.true;
      expect(mockGslb.switchRegion.calledBefore(mockPgManager.promoteToPrimary)).to.be.true;
    });

    it('故障切换成功应更新状态', async () => {
      await engine.initiateFailover({ trigger: 'manual' });
      
      expect(engine.isFailedOver).to.be.true;
      expect(engine.failoverInProgress).to.be.false;
    });

    it('故障切换失败应回滚', async () => {
      mockGslb.switchRegion.rejects(new Error('DNS 切换失败'));
      
      await expect(engine.initiateFailover({ trigger: 'test' })).to.be.rejected;
      
      expect(engine.failoverInProgress).to.be.false;
      expect(engine.isFailedOver).to.be.false;
    });

    it('应调用 onFailoverStart 回调', async () => {
      const callback = sinon.stub();
      engine.onFailoverStart = callback;
      
      await engine.initiateFailover({ trigger: 'manual' });
      
      expect(callback.calledOnce).to.be.true;
    });

    it('应调用 onFailoverComplete 回调', async () => {
      const callback = sinon.stub();
      engine.onFailoverComplete = callback;
      
      await engine.initiateFailover({ trigger: 'manual' });
      
      expect(callback.calledOnce).to.be.true;
    });
  });

  describe('getState', () => {
    it('应返回正确的状态对象', async () => {
      await engine.start();
      
      const state = engine.getState();
      
      expect(state).to.have.property('primaryRegion', 'beijing');
      expect(state).to.have.property('standbyRegion', 'shanghai');
      expect(state).to.have.property('isFailedOver', false);
      expect(state).to.have.property('failoverInProgress', false);
      expect(state).to.have.property('rtoTarget', 300000);
      expect(state).to.have.property('rpoTarget', 60000);
    });

    it('故障切换后状态应更新', async () => {
      await engine.start();
      await engine.initiateFailover({ trigger: 'manual' });
      
      const state = engine.getState();
      
      expect(state.isFailedOver).to.be.true;
      expect(state.activeRegion).to.equal('shanghai');
    });
  });

  describe('边界条件测试', () => {
    it('重复启动不应创建多个定时器', async () => {
      await engine.start();
      await engine.start();
      
      expect(engine.monitors.size).to.equal(3); // 只应有 3 个定时器
    });

    it('停止未启动的引擎不应报错', async () => {
      await expect(engine.stop()).to.not.be.rejected;
    });

    it('配置为零的阈值应使用默认值', () => {
      const zeroEngine = new DisasterRecoveryEngine({
        failureThreshold: 0,
        recoveryThreshold: 0
      });
      
      expect(zeroEngine.failureThreshold).to.be.at.least(1);
      expect(zeroEngine.recoveryThreshold).to.be.at.least(1);
    });

    it('RTO/RPO 为零应使用默认值', () => {
      const zeroEngine = new DisasterRecoveryEngine({
        rtoTarget: 0,
        rpoTarget: 0
      });
      
      expect(zeroEngine.rtoTarget).to.be.at.least(60000);
      expect(zeroEngine.rpoTarget).to.be.at.least(10000);
    });
  });

  describe('并发场景测试', () => {
    it('不应允许并发故障切换', async () => {
      await engine.start();
      
      const failover1 = engine.initiateFailover({ trigger: 'test1' });
      const failover2 = engine.initiateFailover({ trigger: 'test2' });
      
      await Promise.allSettled([failover1, failover2]);
      
      // 只应执行一次切换
      expect(mockGslb.switchRegion.calledOnce).to.be.true;
    });
  });
});
