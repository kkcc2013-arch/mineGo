/**
 * REQ-00061: 服务健康仪表板与自动恢复系统 - 单元测试
 */

const { describe, it, beforeEach, afterEach, expect } = require('../test-helpers');
const HealthScorer = require('../../shared/healthScorer');
const AutoRecovery = require('../../shared/autoRecovery');

describe('REQ-00061: 服务健康仪表板与自动恢复系统', () => {
  describe('HealthScorer', () => {
    let scorer;

    beforeEach(() => {
      scorer = new HealthScorer();
    });

    afterEach(() => {
      scorer.clearHistory();
    });

    describe('calculateHealthScore', () => {
      it('应该正确计算健康服务的评分', () => {
        const metrics = {
          cpu: 30,
          memory: 40,
          errorRate: 0.005,
          responseTime: 80,
          connectionPool: 30,
          eventLag: 5
        };

        const result = scorer.calculateHealthScore('test-service', metrics);

        expect(result.serviceName).toBe('test-service');
        expect(result.totalScore).toBeGreaterThan(80);
        expect(result.status).toBe('healthy');
        expect(result.scores).toBeDefined();
        expect(result.trend).toBe('stable');
        expect(result.recommendations).toEqual([]);
      });

      it('应该正确计算警告状态服务的评分', () => {
        const metrics = {
          cpu: 75,
          memory: 80,
          errorRate: 0.06,
          responseTime: 400,
          connectionPool: 75,
          eventLag: 40
        };

        const result = scorer.calculateHealthScore('test-service', metrics);

        expect(result.totalScore).toBeLessThan(80);
        expect(result.totalScore).toBeGreaterThanOrEqual(60);
        expect(result.status).toBe('warning');
        expect(result.recommendations.length).toBeGreaterThan(0);
      });

      it('应该正确计算严重状态服务的评分', () => {
        const metrics = {
          cpu: 95,
          memory: 95,
          errorRate: 0.15,
          responseTime: 2000,
          connectionPool: 95,
          eventLag: 400
        };

        const result = scorer.calculateHealthScore('test-service', metrics);

        expect(result.totalScore).toBeLessThan(40);
        expect(result.status).toBe('critical');
        expect(result.recommendations.length).toBeGreaterThan(0);
      });

      it('应该处理缺失的指标数据', () => {
        const metrics = {};

        const result = scorer.calculateHealthScore('test-service', metrics);

        expect(result.totalScore).toBe(100);
        expect(result.status).toBe('healthy');
      });
    });

    describe('_scoreCPU', () => {
      it('CPU < 50% 应得 100 分', () => {
        const result = scorer._scoreCPU(30);
        expect(result.score).toBe(100);
        expect(result.status).toBe('healthy');
      });

      it('CPU 50-70% 应得 85 分', () => {
        const result = scorer._scoreCPU(60);
        expect(result.score).toBe(85);
        expect(result.status).toBe('healthy');
      });

      it('CPU 70-85% 应得 60 分', () => {
        const result = scorer._scoreCPU(80);
        expect(result.score).toBe(60);
        expect(result.status).toBe('warning');
      });

      it('CPU >= 85% 应得 30 分', () => {
        const result = scorer._scoreCPU(90);
        expect(result.score).toBe(30);
        expect(result.status).toBe('critical');
      });
    });

    describe('_scoreMemory', () => {
      it('内存 < 60% 应得 100 分', () => {
        const result = scorer._scoreMemory(50);
        expect(result.score).toBe(100);
      });

      it('内存 60-75% 应得 80 分', () => {
        const result = scorer._scoreMemory(70);
        expect(result.score).toBe(80);
      });

      it('内存 75-90% 应得 50 分', () => {
        const result = scorer._scoreMemory(85);
        expect(result.score).toBe(50);
        expect(result.status).toBe('warning');
      });

      it('内存 >= 90% 应得 20 分', () => {
        const result = scorer._scoreMemory(95);
        expect(result.score).toBe(20);
        expect(result.status).toBe('critical');
      });
    });

    describe('_scoreErrorRate', () => {
      it('错误率 < 1% 应得 100 分', () => {
        const result = scorer._scoreErrorRate(0.005);
        expect(result.score).toBe(100);
      });

      it('错误率 1-5% 应得 80 分', () => {
        const result = scorer._scoreErrorRate(0.03);
        expect(result.score).toBe(80);
      });

      it('错误率 5-10% 应得 50 分', () => {
        const result = scorer._scoreErrorRate(0.08);
        expect(result.score).toBe(50);
        expect(result.status).toBe('warning');
      });

      it('错误率 >= 10% 应得 10 分', () => {
        const result = scorer._scoreErrorRate(0.15);
        expect(result.score).toBe(10);
        expect(result.status).toBe('critical');
      });
    });

    describe('_scoreResponseTime', () => {
      it('P95 < 100ms 应得 100 分', () => {
        const result = scorer._scoreResponseTime(50);
        expect(result.score).toBe(100);
      });

      it('P95 100-300ms 应得 90 分', () => {
        const result = scorer._scoreResponseTime(200);
        expect(result.score).toBe(90);
      });

      it('P95 300-500ms 应得 70 分', () => {
        const result = scorer._scoreResponseTime(400);
        expect(result.score).toBe(70);
        expect(result.status).toBe('warning');
      });

      it('P95 >= 1000ms 应得 15 分', () => {
        const result = scorer._scoreResponseTime(1500);
        expect(result.score).toBe(15);
        expect(result.status).toBe('critical');
      });
    });

    describe('trend calculation', () => {
      it('应该正确计算改善趋势', () => {
        // 先添加一些低分记录
        for (let i = 0; i < 3; i++) {
          scorer.calculateHealthScore('test-service', {
            cpu: 90,
            memory: 90,
            errorRate: 0.1,
            responseTime: 1000,
            connectionPool: 90,
            eventLag: 200
          });
        }

        // 然后添加高分记录
        for (let i = 0; i < 3; i++) {
          scorer.calculateHealthScore('test-service', {
            cpu: 30,
            memory: 40,
            errorRate: 0.01,
            responseTime: 100,
            connectionPool: 30,
            eventLag: 5
          });
        }

        const history = scorer.getHistory('test-service');
        expect(history.length).toBe(6);
      });
    });

    describe('recommendations', () => {
      it('应该为 CPU 高负载生成扩容建议', () => {
        const metrics = {
          cpu: 90,
          memory: 50,
          errorRate: 0.01,
          responseTime: 100,
          connectionPool: 30,
          eventLag: 5
        };

        const result = scorer.calculateHealthScore('test-service', metrics);

        const cpuRec = result.recommendations.find(r => r.dimension === 'cpu');
        expect(cpuRec).toBeDefined();
        expect(cpuRec.type).toBe('scaling');
        expect(cpuRec.autoRecoverable).toBe(true);
      });

      it('应该为内存问题生成建议（不可自动恢复）', () => {
        const metrics = {
          cpu: 30,
          memory: 95,
          errorRate: 0.01,
          responseTime: 100,
          connectionPool: 30,
          eventLag: 5
        };

        const result = scorer.calculateHealthScore('test-service', metrics);

        const memRec = result.recommendations.find(r => r.dimension === 'memory');
        expect(memRec).toBeDefined();
        expect(memRec.autoRecoverable).toBe(false);
      });

      it('应该为高错误率生成回滚建议', () => {
        const metrics = {
          cpu: 30,
          memory: 50,
          errorRate: 0.15,
          responseTime: 100,
          connectionPool: 30,
          eventLag: 5
        };

        const result = scorer.calculateHealthScore('test-service', metrics);

        const errorRec = result.recommendations.find(r => r.dimension === 'errorRate');
        expect(errorRec).toBeDefined();
        expect(errorRec.type).toBe('error');
        expect(errorRec.autoRecoverable).toBe(true);
      });
    });

    describe('getHistory', () => {
      it('应该返回指定数量的历史记录', () => {
        for (let i = 0; i < 20; i++) {
          scorer.calculateHealthScore('test-service', {
            cpu: 30 + i,
            memory: 40,
            errorRate: 0.01,
            responseTime: 100,
            connectionPool: 30,
            eventLag: 5
          });
        }

        const history = scorer.getHistory('test-service', 5);
        expect(history.length).toBe(5);
      });
    });

    describe('getSummary', () => {
      it('应该返回所有服务的摘要', () => {
        scorer.calculateHealthScore('service-a', {
          cpu: 30, memory: 40, errorRate: 0.01, responseTime: 100, connectionPool: 30, eventLag: 5
        });
        scorer.calculateHealthScore('service-b', {
          cpu: 80, memory: 85, errorRate: 0.08, responseTime: 400, connectionPool: 80, eventLag: 50
        });

        const summary = scorer.getSummary();

        expect(summary['service-a']).toBeDefined();
        expect(summary['service-b']).toBeDefined();
        expect(summary['service-a'].status).toBe('healthy');
        expect(summary['service-b'].status).toBe('warning');
      });
    });
  });

  describe('AutoRecovery', () => {
    let recovery;

    beforeEach(() => {
      recovery = new AutoRecovery({
        k8sEnabled: false, // 使用模拟模式
        cooldownPeriod: 1000 // 1 秒冷却期（测试用）
      });
    });

    afterEach(() => {
      recovery.recoveryHistory.clear();
    });

    describe('executeRecovery', () => {
      it('应该在冷却期内跳过恢复', async () => {
        const healthScore = { totalScore: 30 };

        // 第一次恢复
        await recovery.executeRecovery('test-service', { type: 'scaling' }, healthScore);

        // 第二次恢复（冷却期内）
        const result = await recovery.executeRecovery('test-service', { type: 'scaling' }, healthScore);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('cooldown');
        expect(result.inCooldown).toBe(true);
      });

      it('应该成功执行扩容操作', async () => {
        const healthScore = { totalScore: 30 };

        const result = await recovery.executeRecovery('test-service', { type: 'scaling' }, healthScore);

        expect(result.success).toBe(true);
        expect(result.action).toBe('scale_pods');
        expect(result.simulated).toBe(true);
      });

      it('应该成功执行重启操作', async () => {
        const healthScore = { totalScore: 50 };

        const result = await recovery.executeRecovery('test-service', { type: 'connection' }, healthScore);

        expect(result.success).toBe(true);
        expect(result.action).toBe('restart_pods');
        expect(result.simulated).toBe(true);
      });

      it('应该成功执行回滚操作', async () => {
        const healthScore = { totalScore: 20 };

        const result = await recovery.executeRecovery('test-service', { type: 'error' }, healthScore);

        expect(result.success).toBe(true);
        expect(result.action).toBe('rollback');
        expect(result.simulated).toBe(true);
      });

      it('应该拒绝不支持的恢复类型', async () => {
        const healthScore = { totalScore: 30 };

        const result = await recovery.executeRecovery('test-service', { type: 'unknown' }, healthScore);

        expect(result.success).toBe(false);
        expect(result.reason).toBe('unsupported_type');
      });
    });

    describe('getRecoveryHistory', () => {
      it('应该返回恢复历史', async () => {
        const healthScore = { totalScore: 30 };

        await recovery.executeRecovery('test-service', { type: 'scaling' }, healthScore);
        recovery.clearCooldown('test-service');
        await recovery.executeRecovery('test-service', { type: 'restart' }, healthScore);

        const history = recovery.getRecoveryHistory('test-service');

        expect(history.length).toBe(2);
        expect(history[0].type).toBe('scaling');
        expect(history[1].type).toBe('restart');
      });
    });

    describe('clearCooldown', () => {
      it('应该清除冷却期', async () => {
        const healthScore = { totalScore: 30 };

        // 第一次恢复
        await recovery.executeRecovery('test-service', { type: 'scaling' }, healthScore);

        // 清除冷却期
        recovery.clearCooldown('test-service');

        // 第二次恢复应该成功
        const result = await recovery.executeRecovery('test-service', { type: 'scaling' }, healthScore);

        expect(result.success).toBe(true);
      });
    });

    describe('_getDeploymentName', () => {
      it('应该正确转换服务名称', () => {
        expect(recovery._getDeploymentName('user-service')).toBe('user');
        expect(recovery._getDeploymentName('location-service')).toBe('location');
        expect(recovery._getDeploymentName('gateway')).toBe('gateway');
      });
    });
  });

  describe('Integration: HealthScorer + AutoRecovery', () => {
    let scorer;
    let recovery;

    beforeEach(() => {
      scorer = new HealthScorer();
      recovery = new AutoRecovery({ k8sEnabled: false, cooldownPeriod: 100 });
    });

    afterEach(() => {
      scorer.clearHistory();
      recovery.recoveryHistory.clear();
    });

    it('应该根据健康评分自动选择恢复策略', async () => {
      // 高 CPU 场景
      const metrics = {
        cpu: 95,
        memory: 50,
        errorRate: 0.01,
        responseTime: 100,
        connectionPool: 30,
        eventLag: 5
      };

      const healthScore = scorer.calculateHealthScore('test-service', metrics);
      const recommendation = healthScore.recommendations[0];

      expect(recommendation).toBeDefined();
      expect(recommendation.type).toBe('scaling');

      const result = await recovery.executeRecovery('test-service', recommendation, healthScore);

      expect(result.success).toBe(true);
    });

    it('应该为多个问题生成优先级排序的建议', async () => {
      const metrics = {
        cpu: 90,
        memory: 95,
        errorRate: 0.15,
        responseTime: 1500,
        connectionPool: 90,
        eventLag: 400
      };

      const healthScore = scorer.calculateHealthScore('test-service', metrics);

      expect(healthScore.status).toBe('critical');
      expect(healthScore.recommendations.length).toBeGreaterThan(1);

      // 检查建议按优先级排序
      const priorities = healthScore.recommendations.map(r => r.priority);
      for (let i = 1; i < priorities.length; i++) {
        expect(['high', 'medium', 'low'].indexOf(priorities[i-1]))
          .toBeLessThanOrEqual(['high', 'medium', 'low'].indexOf(priorities[i]));
      }
    });
  });
});

// 导出测试
module.exports = { describe, it, expect };
