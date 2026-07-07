// backend/tests/disasterRecovery/HealthChecker.test.js
// 健康检查器单元测试

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
  counter: sinon.stub(),
  histogram: sinon.stub()
};

const HealthChecker = proxyquire('../../shared/disasterRecovery/HealthChecker', {
  '../logging': { logger: mockLogger, metrics: mockMetrics }
});

describe('HealthChecker', function() {
  this.timeout(10000);

  let checker;
  let clock;

  const mockServices = [
    { name: 'postgres', type: 'tcp', host: 'localhost', port: 5432 },
    { name: 'redis', type: 'tcp', host: 'localhost', port: 6379 },
    { name: 'api', type: 'http', url: 'http://localhost:8080/health' }
  ];

  beforeEach(() => {
    sinon.resetHistory();
    clock = sinon.useFakeTimers();
    
    checker = new HealthChecker({
      checkInterval: 5000,
      timeout: 3000,
      failureThreshold: 3,
      recoveryThreshold: 2,
      services: mockServices
    });
  });

  afterEach(() => {
    clock.restore();
    if (checker && checker.isRunning) {
      checker.stop();
    }
  });

  describe('constructor', () => {
    it('应正确初始化配置', () => {
      expect(checker.config.checkInterval).to.equal(5000);
      expect(checker.config.timeout).to.equal(3000);
      expect(checker.config.failureThreshold).to.equal(3);
      expect(checker.config.recoveryThreshold).to.equal(2);
      expect(checker.config.services).to.deep.equal(mockServices);
    });

    it('应初始化内部状态', () => {
      expect(checker.healthStatus).to.be.instanceOf(Map);
      expect(checker.failureCounts).to.be.instanceOf(Map);
      expect(checker.recoveryCounts).to.be.instanceOf(Map);
      expect(checker.isRunning).to.be.false;
    });

    it('应使用默认配置', () => {
      const defaultChecker = new HealthChecker();
      expect(defaultChecker.config.checkInterval).to.equal(5000);
      expect(defaultChecker.config.timeout).to.equal(3000);
    });

    it('应注册监控指标', () => {
      expect(mockMetrics.gauge.called).to.be.true;
      expect(mockMetrics.counter.called).to.be.true;
      expect(mockMetrics.histogram.called).to.be.true;
    });
  });

  describe('start/stop', () => {
    it('应成功启动健康检查', async () => {
      // Mock checkService 方法
      checker.checkService = sinon.stub().resolves({ healthy: true, latency: 10 });
      
      await checker.start();
      
      expect(checker.isRunning).to.be.true;
      expect(checker.timer).to.not.be.null;
    });

    it('不应重复启动', async () => {
      checker.checkService = sinon.stub().resolves({ healthy: true });
      
      await checker.start();
      await checker.start();
      
      expect(checker.checkService.callCount).to.equal(mockServices.length);
    });

    it('应成功停止健康检查', async () => {
      checker.checkService = sinon.stub().resolves({ healthy: true });
      
      await checker.start();
      await checker.stop();
      
      expect(checker.isRunning).to.be.false;
      expect(checker.timer).to.be.null;
    });

    it('停止未启动的检查器不应报错', async () => {
      await expect(checker.stop()).to.not.be.rejected;
    });
  });

  describe('checkService', () => {
    it('TCP 服务健康时应返回成功', async () => {
      const service = { name: 'postgres', type: 'tcp', host: 'localhost', port: 5432 };
      
      // Mock net.connect
      const mockSocket = {
        on: sinon.stub(),
        destroy: sinon.stub()
      };
      
      const result = await checker.checkService(service);
      
      expect(result).to.have.property('healthy');
      expect(result).to.have.property('latency');
    });

    it('HTTP 服务健康时应返回成功', async () => {
      const service = { 
        name: 'api', 
        type: 'http', 
        url: 'http://localhost:8080/health' 
      };
      
      // 需要 mock axios
      const result = await checker.checkService(service);
      
      expect(result).to.have.property('healthy');
    });

    it('连接超时应返回失败', async () => {
      const service = { 
        name: 'timeout-service', 
        type: 'tcp', 
        host: '10.255.255.1', // 不可达IP
        port: 9999 
      };
      
      const result = await checker.checkService(service);
      
      expect(result.healthy).to.be.false;
      expect(result).to.have.property('error');
    });

    it('连接拒绝应返回失败', async () => {
      const service = { 
        name: 'refused-service', 
        type: 'tcp', 
        host: 'localhost', 
        port: 9999 // 未监听的端口
      };
      
      const result = await checker.checkService(service);
      
      expect(result.healthy).to.be.false;
    });
  });

  describe('runHealthChecks', () => {
    it('应检查所有配置的服务', async () => {
      checker.checkService = sinon.stub().resolves({ healthy: true, latency: 10 });
      
      await checker.runHealthChecks();
      
      expect(checker.checkService.callCount).to.equal(mockServices.length);
    });

    it('健康服务应增加恢复计数', async () => {
      checker.checkService = sinon.stub().resolves({ healthy: true, latency: 10 });
      checker.handleHealthy = sinon.stub();
      
      await checker.runHealthChecks();
      
      expect(checker.handleHealthy.callCount).to.equal(mockServices.length);
    });

    it('不健康服务应增加失败计数', async () => {
      checker.checkService = sinon.stub().rejects(new Error('服务不可用'));
      checker.handleUnhealthy = sinon.stub();
      
      await checker.runHealthChecks();
      
      expect(checker.handleUnhealthy.callCount).to.equal(mockServices.length);
    });

    it('应触发健康状态变更事件', async () => {
      checker.checkService = sinon.stub().resolves({ healthy: true, latency: 10 });
      
      const eventSpy = sinon.spy();
      checker.on('health-status-change', eventSpy);
      
      await checker.runHealthChecks();
      
      expect(eventSpy.calledOnce).to.be.true;
      expect(eventSpy.firstCall.args[0]).to.have.property('healthy', true);
    });
  });

  describe('handleHealthy', () => {
    it('健康服务应重置失败计数', () => {
      const service = mockServices[0];
      checker.failureCounts.set('postgres:primary', 2);
      
      checker.handleHealthy(service, { healthy: true, latency: 10 });
      
      expect(checker.failureCounts.get('postgres:primary')).to.equal(0);
    });

    it('连续恢复达到阈值应触发恢复事件', () => {
      const service = mockServices[0];
      
      for (let i = 0; i < checker.config.recoveryThreshold; i++) {
        checker.handleHealthy(service, { healthy: true, latency: 10 });
      }
      
      const recoveryCount = checker.recoveryCounts.get('postgres:primary') || 0;
      expect(recoveryCount).to.be.at.least(checker.config.recoveryThreshold);
    });
  });

  describe('handleUnhealthy', () => {
    it('不健康服务应增加失败计数', () => {
      const service = mockServices[0];
      
      checker.handleUnhealthy(service, new Error('连接失败'));
      
      expect(checker.failureCounts.get('postgres:primary')).to.equal(1);
    });

    it('连续失败达到阈值应触发故障事件', () => {
      const service = mockServices[0];
      const eventSpy = sinon.spy();
      checker.on('service-failed', eventSpy);
      
      for (let i = 0; i < checker.config.failureThreshold; i++) {
        checker.handleUnhealthy(service, new Error('连接失败'));
      }
      
      expect(eventSpy.calledOnce).to.be.true;
    });

    it('应记录失败原因', () => {
      const service = mockServices[0];
      const error = new Error('连接超时');
      
      checker.handleUnhealthy(service, error);
      
      const status = checker.healthStatus.get('postgres:primary');
      expect(status).to.have.property('error', '连接超时');
    });
  });

  describe('getOverallHealth', () => {
    it('所有服务健康应返回 true', () => {
      mockServices.forEach(s => {
        checker.healthStatus.set(`${s.name}:primary`, { healthy: true });
      });
      
      const overall = checker.getOverallHealth();
      expect(overall).to.be.true;
    });

    it('任一服务不健康应返回 false', () => {
      checker.healthStatus.set('postgres:primary', { healthy: true });
      checker.healthStatus.set('redis:primary', { healthy: false });
      checker.healthStatus.set('api:primary', { healthy: true });
      
      const overall = checker.getOverallHealth();
      expect(overall).to.be.false;
    });

    it('无服务状态应返回 false', () => {
      const overall = checker.getOverallHealth();
      expect(overall).to.be.false;
    });
  });

  describe('getServiceHealth', () => {
    it('应返回指定服务的健康状态', () => {
      checker.healthStatus.set('postgres:primary', { healthy: true, latency: 10 });
      
      const health = checker.getServiceHealth('postgres', 'primary');
      
      expect(health).to.deep.equal({ healthy: true, latency: 10 });
    });

    it('不存在的服务应返回 undefined', () => {
      const health = checker.getServiceHealth('nonexistent', 'primary');
      expect(health).to.be.undefined;
    });
  });

  describe('边界条件测试', () => {
    it('空服务列表不应报错', async () => {
      const emptyChecker = new HealthChecker({ services: [] });
      emptyChecker.checkService = sinon.stub().resolves({ healthy: true });
      
      await emptyChecker.runHealthChecks();
      
      expect(emptyChecker.checkService.called).to.be.false;
    });

    it('超时配置为零应使用默认值', () => {
      const zeroChecker = new HealthChecker({ timeout: 0 });
      expect(zeroChecker.config.timeout).to.be.at.least(1000);
    });

    it('检查间隔为零应使用默认值', () => {
      const zeroChecker = new HealthChecker({ checkInterval: 0 });
      expect(zeroChecker.config.checkInterval).to.be.at.least(1000);
    });
  });

  describe('并发场景测试', () => {
    it('并发检查同一服务应正确处理', async () => {
      checker.checkService = sinon.stub().callsFake(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { healthy: true, latency: 100 };
      });
      
      const checks = await Promise.all([
        checker.checkService(mockServices[0]),
        checker.checkService(mockServices[0]),
        checker.checkService(mockServices[0])
      ]);
      
      checks.forEach(result => {
        expect(result).to.have.property('healthy');
      });
    });
  });
});
