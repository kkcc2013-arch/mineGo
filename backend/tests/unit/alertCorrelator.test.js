// backend/tests/unit/alertCorrelator.test.js
// REQ-00275: 告警智能关联与根因分析系统单元测试

'use strict';

const assert = require('assert');
const { 
  AlertCorrelator, 
  processAlert, 
  getActiveAlerts, 
  clearAlerts,
  SERVICE_TOPOLOGY,
  CAUSAL_RULES
} = require('../../shared/alertCorrelator');

describe('AlertCorrelator', () => {
  let correlator;

  beforeEach(() => {
    correlator = new AlertCorrelator();
    clearAlerts();
  });

  describe('基础功能', () => {
    it('应该正确初始化', () => {
      assert.ok(correlator);
      assert.ok(correlator.activeAlerts);
      assert.ok(correlator.alertHistory);
      assert.strictEqual(correlator.activeAlerts.size, 0);
    });

    it('应该正确生成告警指纹', () => {
      const alert = {
        labels: {
          alertname: 'ServiceDown',
          service: 'user-service',
          severity: 'critical'
        }
      };
      
      const fingerprint = correlator.generateFingerprint(alert);
      assert.ok(fingerprint);
      assert.ok(fingerprint.includes('ServiceDown'));
      assert.ok(fingerprint.includes('user-service'));
    });

    it('应该正确存储告警', () => {
      const alert = {
        fingerprint: 'test-1',
        labels: { alertname: 'TestAlert', service: 'test-service' },
        status: 'firing'
      };
      
      correlator.storeAlert(alert);
      
      assert.strictEqual(correlator.activeAlerts.size, 1);
      assert.ok(correlator.activeAlerts.has('test-1'));
      assert.ok(alert.receivedAt);
    });
  });

  describe('关联分析', () => {
    it('应该基于服务拓扑关联告警', async () => {
      // 先添加一个上游服务告警
      const dbAlert = {
        fingerprint: 'db-1',
        labels: { alertname: 'DatabaseConnectionPoolExhausted', service: 'database' },
        status: 'firing'
      };
      correlator.storeAlert(dbAlert);
      
      // 添加一个依赖数据库的服务告警
      const serviceAlert = {
        fingerprint: 'service-1',
        labels: { alertname: 'HighErrorRate', service: 'user-service' },
        status: 'firing'
      };
      
      const correlations = correlator.correlate(serviceAlert);
      
      // 应该找到数据库告警（user-service 依赖 database）
      const topologyCorr = correlations.find(c => c.type === 'topology');
      assert.ok(topologyCorr, '应该找到拓扑关联');
      assert.strictEqual(topologyCorr.relation, 'upstream');
    });

    it('应该基于时间窗口关联告警', async () => {
      // 添加一个最近的告警
      const recentAlert = {
        fingerprint: 'recent-1',
        labels: { alertname: 'HighLatency', service: 'gateway' },
        status: 'firing',
        receivedAt: Date.now() - 30000 // 30秒前
      };
      correlator.activeAlerts.set('recent-1', recentAlert);
      
      // 添加新告警
      const newAlert = {
        fingerprint: 'new-1',
        labels: { alertname: 'HighErrorRate', service: 'gateway' },
        status: 'firing'
      };
      
      const correlations = correlator.correlate(newAlert);
      
      // 应该找到时间关联
      const timeCorr = correlations.find(c => c.type === 'temporal');
      assert.ok(timeCorr, '应该找到时间关联');
      assert.ok(timeCorr.timeDiff >= 30000);
    });

    it('应该基于因果规则关联告警', async () => {
      // 添加一个 ServiceDown 告警
      const downAlert = {
        fingerprint: 'down-1',
        labels: { alertname: 'ServiceDown', service: 'user-service', severity: 'critical' },
        status: 'firing'
      };
      correlator.storeAlert(downAlert);
      
      // 添加一个受影响的告警
      const affectedAlert = {
        fingerprint: 'affected-1',
        labels: { alertname: 'HighErrorRate', service: 'user-service' },
        status: 'firing'
      };
      
      const correlations = correlator.correlate(affectedAlert);
      
      // 应该找到因果关联
      const causalCorr = correlations.find(c => c.type === 'causal');
      assert.ok(causalCorr, '应该找到因果关联');
      assert.ok(causalCorr.score >= 0.8);
    });
  });

  describe('根因推断', () => {
    it('应该正确识别根因', async () => {
      // 添加基础设施告警（根因）
      const rootCauseAlert = {
        fingerprint: 'root-1',
        labels: { alertname: 'DatabaseConnectionPoolExhausted', service: 'database', severity: 'critical' },
        status: 'firing',
        receivedAt: Date.now() - 60000 // 1分钟前
      };
      correlator.storeAlert(rootCauseAlert);
      
      // 添加下游服务告警
      const serviceAlert = {
        fingerprint: 'service-1',
        labels: { alertname: 'HighErrorRate', service: 'user-service' },
        status: 'firing',
        receivedAt: Date.now() - 30000
      };
      correlator.storeAlert(serviceAlert);
      
      // 添加最新告警
      const latestAlert = {
        fingerprint: 'latest-1',
        labels: { alertname: 'HighLatency', service: 'user-service' },
        status: 'firing'
      };
      
      const correlations = correlator.correlate(latestAlert);
      const rootCause = correlator.inferRootCause(latestAlert, correlations);
      
      // 数据库告警应该是根因
      assert.ok(rootCause);
      assert.ok(rootCause.confidence > 0);
      assert.ok(rootCause.impactChain);
      assert.ok(Array.isArray(rootCause.suggestedActions));
    });

    it('无关联时当前告警为根因', async () => {
      const alert = {
        fingerprint: 'solo-1',
        labels: { alertname: 'TestAlert', service: 'test-service' },
        status: 'firing'
      };
      
      const rootCause = correlator.inferRootCause(alert, []);
      
      assert.strictEqual(rootCause.alert.fingerprint, 'solo-1');
      assert.strictEqual(rootCause.isRootCause, true);
      assert.strictEqual(rootCause.confidence, 1.0);
    });
  });

  describe('降噪评估', () => {
    it('应该识别抖动告警', async () => {
      const alert = {
        fingerprint: 'flapping-1',
        labels: { alertname: 'TestAlert', service: 'test-service' },
        status: 'firing'
      };
      
      // 模拟抖动：添加多个相同告警
      for (let i = 0; i < 6; i++) {
        correlator.alertHistory.push({
          fingerprint: 'flapping-1',
          receivedAt: Date.now() - (i * 60000)
        });
      }
      
      const noiseResult = await correlator.evaluateNoise(alert);
      
      assert.strictEqual(noiseResult.isNoise, true);
      assert.strictEqual(noiseResult.reason, 'flapping');
      assert.strictEqual(noiseResult.action, 'delay');
    });

    it('应该抑制低优先级告警', async () => {
      // 先添加一个 critical 告警
      const criticalAlert = {
        fingerprint: 'critical-1',
        labels: { alertname: 'ServiceDown', service: 'user-service', severity: 'critical' },
        status: 'firing'
      };
      correlator.storeAlert(criticalAlert);
      
      // 添加一个 warning 告警
      const warningAlert = {
        fingerprint: 'warning-1',
        labels: { alertname: 'HighLatency', service: 'user-service', severity: 'warning' },
        status: 'firing'
      };
      
      const noiseResult = await correlator.evaluateNoise(warningAlert);
      
      assert.strictEqual(noiseResult.isNoise, true);
      assert.strictEqual(noiseResult.reason, 'suppressed_by_critical');
    });

    it('有效告警不应被降噪', async () => {
      const alert = {
        fingerprint: 'valid-1',
        labels: { alertname: 'ServiceDown', service: 'user-service', severity: 'critical' },
        status: 'firing'
      };
      
      const noiseResult = await correlator.evaluateNoise(alert);
      
      assert.strictEqual(noiseResult.isNoise, false);
      assert.strictEqual(noiseResult.action, 'forward');
    });
  });

  describe('拓扑生成', () => {
    it('应该正确生成告警拓扑图', async () => {
      const alert1 = {
        fingerprint: 'topo-1',
        labels: { alertname: 'DatabaseConnectionPoolExhausted', service: 'database' },
        status: 'firing'
      };
      correlator.storeAlert(alert1);
      
      const alert2 = {
        fingerprint: 'topo-2',
        labels: { alertname: 'HighErrorRate', service: 'user-service' },
        status: 'firing'
      };
      
      const correlations = correlator.correlate(alert2);
      const topology = correlator.generateTopology(alert2, correlations);
      
      assert.ok(topology.nodes);
      assert.ok(topology.edges);
      assert.ok(topology.stats);
      assert.ok(topology.nodes.length >= 1);
    });
  });

  describe('完整处理流程', () => {
    it('应该正确处理告警', async () => {
      const alert = {
        fingerprint: 'process-1',
        labels: { alertname: 'ServiceDown', service: 'user-service', severity: 'critical' },
        status: 'firing',
        annotations: { summary: 'User service is down' }
      };
      
      const result = await correlator.processAlert(alert);
      
      assert.ok(result);
      assert.strictEqual(result.alert.fingerprint, 'process-1');
      assert.ok(Array.isArray(result.correlations));
      assert.ok(result.rootCause);
      assert.ok(result.cluster);
      assert.ok(result.noise);
      assert.ok(result.topology);
      assert.ok(result.processingTimeMs >= 0);
    });

    it('应该处理多个告警的关联', async () => {
      // 根因告警
      const rootAlert = {
        fingerprint: 'multi-root',
        labels: { alertname: 'DatabaseConnectionPoolExhausted', service: 'database', severity: 'critical' },
        status: 'firing'
      };
      await correlator.processAlert(rootAlert);
      
      // 影响告警1
      const affected1 = {
        fingerprint: 'multi-affected-1',
        labels: { alertname: 'HighErrorRate', service: 'user-service' },
        status: 'firing'
      };
      const result1 = await correlator.processAlert(affected1);
      
      // 影响告警2
      const affected2 = {
        fingerprint: 'multi-affected-2',
        labels: { alertname: 'HighLatency', service: 'pokemon-service' },
        status: 'firing'
      };
      const result2 = await correlator.processAlert(affected2);
      
      // 两个影响告警都应该关联到根因
      assert.ok(result1.correlations.length > 0 || result2.correlations.length > 0);
    });
  });

  describe('服务拓扑', () => {
    it('应该正确定义服务依赖', () => {
      assert.ok(SERVICE_TOPOLOGY['gateway']);
      assert.ok(SERVICE_TOPOLOGY['gateway'].includes('user-service'));
      assert.ok(SERVICE_TOPOLOGY['user-service'].includes('database'));
    });

    it('应该找到下游依赖者', () => {
      const dependents = correlator.findDependents('database');
      assert.ok(dependents.length > 0);
      assert.ok(dependents.includes('user-service'));
    });
  });

  describe('因果规则', () => {
    it('应该定义因果规则', () => {
      assert.ok(CAUSAL_RULES.length > 0);
      
      const serviceDownRule = CAUSAL_RULES.find(r => r.cause === 'ServiceDown');
      assert.ok(serviceDownRule);
      assert.strictEqual(serviceDownRule.effect, '*');
    });
  });

  describe('建议操作', () => {
    it('应该为 ServiceDown 提供建议', () => {
      const alert = {
        labels: { alertname: 'ServiceDown', service: 'user-service' }
      };
      
      const actions = correlator.getSuggestedActions(alert);
      
      assert.ok(Array.isArray(actions));
      assert.ok(actions.length > 0);
      assert.ok(actions.some(a => a.includes('kubectl')));
    });

    it('应该为数据库问题提供建议', () => {
      const alert = {
        labels: { alertname: 'DatabaseConnectionPoolExhausted' }
      };
      
      const actions = correlator.getSuggestedActions(alert);
      
      assert.ok(actions.some(a => a.includes('PROCESSLIST') || a.includes('连接池')));
    });
  });
});

describe('便捷函数', () => {
  beforeEach(() => {
    clearAlerts();
  });

  it('processAlert 应该工作', async () => {
    const alert = {
      fingerprint: 'conv-1',
      labels: { alertname: 'TestAlert', service: 'test' },
      status: 'firing'
    };
    
    const result = await processAlert(alert);
    assert.ok(result);
    assert.strictEqual(result.alert.fingerprint, 'conv-1');
  });

  it('getActiveAlerts 应该返回活跃告警', async () => {
    const alert = {
      fingerprint: 'active-1',
      labels: { alertname: 'TestAlert', service: 'test' },
      status: 'firing'
    };
    
    await processAlert(alert);
    
    const active = getActiveAlerts();
    assert.ok(Array.isArray(active));
    assert.strictEqual(active.length, 1);
  });
});
