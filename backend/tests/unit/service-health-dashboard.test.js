/**
 * REQ-00061 测试文件
 * 服务健康仪表板与自动恢复系统测试
 */

const { expect } = require('chai');
const sinon = require('sinon');
const ServiceHealthDashboard = require('../shared/ServiceHealthDashboard');
const HealthScorer = require('../shared/healthScorer');

describe('REQ-00061: 服务健康仪表板与自动恢复系统', () => {
  
  describe('HealthScorer - 健康评分引擎', () => {
    let healthScorer;
    
    beforeEach(() => {
      healthScorer = new HealthScorer();
    });
    
    it('应该正确计算健康服务的评分（所有指标正常）', () => {
      const metrics = {
        cpu: 40,
        memory: 50,
        errorRate: 0.005,
        responseTime: 80,
        connectionPool: 50,
        eventLag: 10
      };
      
      const result = healthScorer.calculateHealthScore('test-service', metrics);
      
      expect(result.serviceName).to.equal('test-service');
      expect(result.totalScore).to.be.at.least(80);
      expect(result.status).to.equal('healthy');
      expect(result.trend).to.exist;
      expect(result.recommendations).to.be.an('array');
    });
    
    it('应该正确识别警告状态服务', () => {
      const metrics = {
        cpu: 75,
        memory: 80,
        errorRate: 0.03,
        responseTime: 400,
        connectionPool: 85,
        eventLag: 50
      };
      
      const result = healthScorer.calculateHealthScore('warning-service', metrics);
      
      expect(result.totalScore).to.be.within(50, 79);
      expect(result.status).to.equal('warning');
    });
    
    it('应该正确识别降级状态服务', () => {
      const metrics = {
        cpu: 85,
        memory: 90,
        errorRate: 0.08,
        responseTime: 800,
        connectionPool: 95,
        eventLag: 100
      };
      
      const result = healthScorer.calculateHealthScore('degraded-service', metrics);
      
      expect(result.totalScore).to.be.within(40, 59);
      expect(result.status).to.equal('degraded');
    });
    
    it('应该正确识别故障状态服务', () => {
      const metrics = {
        cpu: 95,
        memory: 98,
        errorRate: 0.15,
        responseTime: 2000,
        connectionPool: 100,
        eventLag: 500
      };
      
      const result = healthScorer.calculateHealthScore('critical-service', metrics);
      
      expect(result.totalScore).to.be.below(40);
      expect(result.status).to.equal('critical');
    });
    
    it('应该计算历史趋势', () => {
      // 第一次评分
      healthScorer.calculateHealthScore('trend-service', {
        cpu: 40,
        memory: 50,
        errorRate: 0.01,
        responseTime: 100,
        connectionPool: 50,
        eventLag: 10
      });
      
      // 第二次评分（略有下降）
      const result = healthScorer.calculateHealthScore('trend-service', {
        cpu: 50,
        memory: 60,
        errorRate: 0.02,
        responseTime: 150,
        connectionPool: 60,
        eventLag: 20
      });
      
      expect(result.trend).to.exist;
    });
    
    it('应该生成合理的建议', () => {
      const metrics = {
        cpu: 90,
        memory: 95,
        errorRate: 0.10,
        responseTime: 1500,
        connectionPool: 98,
        eventLag: 200
      };
      
      const result = healthScorer.calculateHealthScore('problem-service', metrics);
      
      expect(result.recommendations).to.be.an('array');
      expect(result.recommendations.length).to.be.at.least(1);
    });
    
    it('应该支持批量计算', () => {
      const services = [
        {
          serviceName: 'service-1',
          metrics: { cpu: 40, memory: 50, errorRate: 0.01, responseTime: 100, connectionPool: 50, eventLag: 10 }
        },
        {
          serviceName: 'service-2',
          metrics: { cpu: 60, memory: 70, errorRate: 0.02, responseTime: 200, connectionPool: 60, eventLag: 20 }
        }
      ];
      
      const results = healthScorer.calculateBatch(services);
      
      expect(results).to.be.an('array');
      expect(results.length).to.equal(2);
      expect(results[0].serviceName).to.equal('service-1');
      expect(results[1].serviceName).to.equal('service-2');
    });
  });
  
  describe('ServiceHealthDashboard - 服务健康仪表板', () => {
    let dashboard;
    
    beforeEach(() => {
      dashboard = new ServiceHealthDashboard({
        updateInterval: 1000,
        autoRecoveryEnabled: true
      });
    });
    
    afterEach(async () => {
      if (dashboard) {
        await dashboard.stop();
      }
    });
    
    it('应该正确初始化', () => {
      expect(dashboard.healthScorer).to.exist;
      expect(dashboard.selfHealingEngine).to.exist;
      expect(dashboard.serviceRegistry).to.exist;
    });
    
    it('应该正确启动和停止', async () => {
      await dashboard.start();
      expect(dashboard.updateTimer).to.exist;
      
      await dashboard.stop();
      expect(dashboard.updateTimer).to.be.null;
    });
    
    it('应该正确加载服务注册信息', async () => {
      await dashboard._loadServiceRegistry();
      
      expect(dashboard.serviceRegistry.getAll().length).to.be.at.least(9);
    });
    
    it('应该正确分析问题原因', () => {
      const health = {
        scores: {
          cpu: { score: 40 },
          memory: { score: 30 },
          errorRate: { score: 45 },
          responseTime: { score: 50 },
          connectionPool: { score: 35 }
        }
      };
      
      const problems = dashboard._analyzeProblems(health);
      
      expect(problems).to.be.an('array');
      expect(problems.length).to.be.at.least(1);
    });
    
    it('应该正确选择恢复策略', () => {
      const problems = [
        { type: 'memory_high', severity: 'critical' }
      ];
      
      const strategy = dashboard._selectRecoveryStrategy(problems);
      expect(strategy).to.equal('restart_with_memory_limit');
    });
    
    it('应该正确确定整体状态', () => {
      expect(dashboard._determineOverallStatus({ critical: 1, degraded: 0, warning: 0, healthy: 0 })).to.equal('critical');
      expect(dashboard._determineOverallStatus({ critical: 0, degraded: 1, warning: 0, healthy: 0 })).to.equal('degraded');
      expect(dashboard._determineOverallStatus({ critical: 0, degraded: 0, warning: 1, healthy: 0 })).to.equal('warning');
      expect(dashboard._determineOverallStatus({ critical: 0, degraded: 0, warning: 0, healthy: 5 })).to.equal('healthy');
    });
    
    it('应该正确保存历史数据', () => {
      const health = {
        timestamp: new Date().toISOString(),
        totalScore: 85,
        status: 'healthy'
      };
      
      dashboard._saveHistory('test-service', health);
      
      const history = dashboard.serviceHistory.get('test-service');
      expect(history).to.be.an('array');
      expect(history.length).to.equal(1);
    });
    
    it('应该限制历史记录大小', () => {
      const health = {
        timestamp: new Date().toISOString(),
        totalScore: 85,
        status: 'healthy'
      };
      
      // 添加 250 条记录
      for (let i = 0; i < 250; i++) {
        dashboard._saveHistory('test-service', health);
      }
      
      const history = dashboard.serviceHistory.get('test-service');
      expect(history.length).to.be.at.most(200);
    });
    
    it('应该正确构建依赖关系图', async () => {
      await dashboard._loadServiceRegistry();
      
      // 添加一些服务状态
      dashboard.serviceStates.set('gateway', { serviceName: 'gateway', status: 'healthy', totalScore: 90 });
      dashboard.serviceStates.set('user-service', { serviceName: 'user-service', status: 'healthy', totalScore: 88 });
      
      const graph = dashboard._getDependencyGraph();
      
      expect(graph.nodes).to.be.an('array');
      expect(graph.edges).to.be.an('array');
      expect(graph.nodes.length).to.be.at.least(2);
    });
  });
  
  describe('API 接口测试', () => {
    // 这里可以添加 HTTP 接口的集成测试
    // 需要使用 supertest 或类似的工具
  });
  
  describe('性能测试', () => {
    it('应该支持大规模服务评分', () => {
      const healthScorer = new HealthScorer();
      
      const start = Date.now();
      
      for (let i = 0; i < 1000; i++) {
        healthScorer.calculateHealthScore(`service-${i}`, {
          cpu: Math.random() * 100,
          memory: Math.random() * 100,
          errorRate: Math.random() * 0.2,
          responseTime: Math.random() * 2000,
          connectionPool: Math.random() * 100,
          eventLag: Math.random() * 200
        });
      }
      
      const duration = Date.now() - start;
      expect(duration).to.be.below(1000); // 1000 次评分应该在 1 秒内完成
    });
  });
});
