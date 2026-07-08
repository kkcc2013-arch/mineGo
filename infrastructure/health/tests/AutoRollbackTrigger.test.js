/**
 * AutoRollbackTrigger 单元测试
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const AutoRollbackTrigger = require('../AutoRollbackTrigger');

describe('AutoRollbackTrigger', () => {
  let trigger;

  beforeEach(() => {
    trigger = new AutoRollbackTrigger({
      namespace: 'test-namespace',
      timeout: 30,
      maxRetries: 1
    });
  });

  describe('constructor', () => {
    it('should initialize with default namespace', () => {
      const defaultTrigger = new AutoRollbackTrigger();
      assert.strictEqual(defaultTrigger.namespace, 'production');
    });

    it('should use custom namespace from config', () => {
      assert.strictEqual(trigger.namespace, 'test-namespace');
    });

    it('should set default timeout', () => {
      const defaultTrigger = new AutoRollbackTrigger();
      assert.strictEqual(defaultTrigger.timeout, 120);
    });

    it('should initialize empty rollback history', () => {
      assert.deepStrictEqual(trigger.rollbackHistory, []);
    });
  });

  describe('formatReason', () => {
    it('should format issues into readable reason', () => {
      const verificationResult = {
        issues: [
          { type: 'port', severity: 'critical', message: 'Port 8080 unreachable' },
          { type: 'api', severity: 'high', message: 'API returned 500' }
        ]
      };
      
      const reason = trigger.formatReason(verificationResult);
      
      assert.ok(reason.includes('port'));
      assert.ok(reason.includes('Port 8080 unreachable'));
    });

    it('should return default message when no issues', () => {
      const verificationResult = { issues: [] };
      
      const reason = trigger.formatReason(verificationResult);
      
      assert.strictEqual(reason, 'Unknown failure - no issues recorded');
    });
  });

  describe('determineDeploymentsToRollback', () => {
    it('should return critical services by default', () => {
      const verificationResult = {
        issues: [
          { type: 'cache', severity: 'high', message: 'Redis down' }
        ]
      };
      
      const deployments = trigger.determineDeploymentsToRollback(verificationResult);
      
      assert.ok(deployments.includes('gateway'));
      assert.ok(deployments.includes('user-service'));
      assert.ok(deployments.includes('catch-service'));
    });

    it('should return failed critical services when they fail', () => {
      const verificationResult = {
        issues: [
          { service: 'gateway', type: 'port', severity: 'critical', message: 'Port unreachable' }
        ]
      };
      
      const deployments = trigger.determineDeploymentsToRollback(verificationResult);
      
      assert.deepStrictEqual(deployments, ['gateway']);
    });
  });

  describe('getHistory', () => {
    it('should return empty array initially', () => {
      const history = trigger.getHistory();
      assert.deepStrictEqual(history, []);
    });

    it('should limit results', () => {
      trigger.rollbackHistory = [
        { rollbackId: 'r1' },
        { rollbackId: 'r2' },
        { rollbackId: 'r3' }
      ];
      
      const history = trigger.getHistory(2);
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].rollbackId, 'r2');
    });
  });

  describe('getLastRollback', () => {
    it('should return null when no history', () => {
      const last = trigger.getLastRollback();
      assert.strictEqual(last, null);
    });

    it('should return last rollback', () => {
      trigger.rollbackHistory = [
        { rollbackId: 'r1' },
        { rollbackId: 'r2' }
      ];
      
      const last = trigger.getLastRollback();
      assert.strictEqual(last.rollbackId, 'r2');
    });
  });

  describe('cleanupHistory', () => {
    it('should remove old records', () => {
      const oldTimestamp = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
      
      trigger.rollbackHistory = [
        { rollbackId: 'old', timestamp: oldTimestamp },
        { rollbackId: 'new', timestamp: Date.now() }
      ];
      
      trigger.cleanupHistory(30);
      
      assert.strictEqual(trigger.rollbackHistory.length, 1);
      assert.strictEqual(trigger.rollbackHistory[0].rollbackId, 'new');
    });
  });

  describe('trigger', () => {
    it('should execute rollback and return result', async () => {
      const verificationResult = {
        deploymentId: 'test-deploy',
        issues: [
          { service: 'gateway', type: 'port', severity: 'critical', message: 'Port unreachable' }
        ]
      };
      
      const result = await trigger.trigger(verificationResult);
      
      assert.ok(result.rollbackId);
      assert.strictEqual(result.deploymentId, 'test-deploy');
      assert.ok(Array.isArray(result.steps));
      assert.ok(result.duration > 0);
    });

    it('should emit rollback:complete event', async () => {
      const verificationResult = {
        deploymentId: 'event-test',
        issues: [{ type: 'port', severity: 'critical', message: 'Failed' }]
      };
      
      let eventEmitted = false;
      trigger.on('rollback:complete', () => {
        eventEmitted = true;
      });
      
      await trigger.trigger(verificationResult);
      
      assert.strictEqual(eventEmitted, true);
    });

    it('should record rollback in history', async () => {
      const verificationResult = {
        deploymentId: 'history-test',
        issues: [{ type: 'port', severity: 'critical', message: 'Failed' }]
      };
      
      await trigger.trigger(verificationResult);
      
      assert.strictEqual(trigger.rollbackHistory.length, 1);
      assert.strictEqual(trigger.rollbackHistory[0].deploymentId, 'history-test');
    });
  });

  describe('rollbackDeployment', () => {
    it('should return success in mock mode', async () => {
      // Without KUBECTL_ENABLED, it should use mock mode
      const result = await trigger.rollbackDeployment('gateway');
      
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('simulated'));
      assert.ok(result.latency > 0);
    });

    it('should emit deployment:rolledback event', async () => {
      let eventEmitted = false;
      trigger.on('deployment:rolledback', () => {
        eventEmitted = true;
      });
      
      await trigger.rollbackDeployment('user-service');
      
      assert.strictEqual(eventEmitted, true);
    });
  });

  describe('checkDeploymentHealth', () => {
    it('should return health status', async () => {
      const result = await trigger.checkDeploymentHealth('gateway');
      
      assert.ok(result.deployment);
      assert.strictEqual(typeof result.ok, 'boolean');
      assert.ok(result.latency >= 0);
    });
  });
});
