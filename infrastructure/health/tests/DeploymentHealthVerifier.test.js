/**
 * DeploymentHealthVerifier 单元测试
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const DeploymentHealthVerifier = require('../DeploymentHealthVerifier');

describe('DeploymentHealthVerifier', () => {
  let verifier;

  beforeEach(() => {
    verifier = new DeploymentHealthVerifier({
      timeout: 5000,
      services: ['gateway', 'user-service', 'catch-service']
    });
  });

  describe('constructor', () => {
    it('should initialize with default services', () => {
      const defaultVerifier = new DeploymentHealthVerifier();
      assert.ok(Array.isArray(defaultVerifier.services));
      assert.ok(defaultVerifier.services.includes('gateway'));
      assert.ok(defaultVerifier.services.includes('user-service'));
    });

    it('should use custom services from config', () => {
      assert.deepStrictEqual(verifier.services, ['gateway', 'user-service', 'catch-service']);
    });

    it('should set default timeout', () => {
      const defaultVerifier = new DeploymentHealthVerifier();
      assert.strictEqual(defaultVerifier.timeout, 30000);
    });

    it('should use custom timeout from config', () => {
      assert.strictEqual(verifier.timeout, 5000);
    });
  });

  describe('getServicePort', () => {
    it('should return correct port for gateway', () => {
      assert.strictEqual(verifier.getServicePort('gateway'), 8080);
    });

    it('should return correct port for user-service', () => {
      assert.strictEqual(verifier.getServicePort('user-service'), 8081);
    });

    it('should return default port for unknown service', () => {
      assert.strictEqual(verifier.getServicePort('unknown-service'), 8080);
    });
  });

  describe('calculateSeverity', () => {
    it('should return critical for 7+ affected services', () => {
      assert.strictEqual(verifier.calculateSeverity(7), 'critical');
      assert.strictEqual(verifier.calculateSeverity(10), 'critical');
    });

    it('should return high for 5-6 affected services', () => {
      assert.strictEqual(verifier.calculateSeverity(5), 'high');
      assert.strictEqual(verifier.calculateSeverity(6), 'high');
    });

    it('should return medium for 3-4 affected services', () => {
      assert.strictEqual(verifier.calculateSeverity(3), 'medium');
      assert.strictEqual(verifier.calculateSeverity(4), 'medium');
    });

    it('should return low for 1-2 affected services', () => {
      assert.strictEqual(verifier.calculateSeverity(1), 'low');
      assert.strictEqual(verifier.calculateSeverity(2), 'low');
    });

    it('should return none for 0 affected services', () => {
      assert.strictEqual(verifier.calculateSeverity(0), 'none');
    });
  });

  describe('determineOverallSuccess', () => {
    it('should return false when critical service port is down', () => {
      const results = {
        services: {
          'gateway': { port: { status: 'failed' }, api: { status: 'ok' } },
          'user-service': { port: { status: 'ok' }, api: { status: 'ok' } },
          'catch-service': { port: { status: 'ok' }, api: { status: 'ok' } }
        },
        dependencies: { redis: { status: 'ok' } },
        businessLinks: {
          'login': { success: true }
        },
        issues: []
      };
      
      assert.strictEqual(verifier.determineOverallSuccess(results), false);
    });

    it('should return false when redis is down', () => {
      const results = {
        services: {
          'gateway': { port: { status: 'ok' }, api: { status: 'ok' } },
          'user-service': { port: { status: 'ok' }, api: { status: 'ok' } },
          'catch-service': { port: { status: 'ok' }, api: { status: 'ok' } }
        },
        dependencies: { redis: { status: 'failed' } },
        businessLinks: {
          'login': { success: true }
        },
        issues: []
      };
      
      assert.strictEqual(verifier.determineOverallSuccess(results), false);
    });

    it('should return true when all critical components are healthy', () => {
      const results = {
        services: {
          'gateway': { port: { status: 'ok' }, api: { status: 'ok' } },
          'user-service': { port: { status: 'ok' }, api: { status: 'ok' } },
          'catch-service': { port: { status: 'ok' }, api: { status: 'ok' } }
        },
        dependencies: { redis: { status: 'ok' } },
        businessLinks: {
          'login': { success: true },
          'catch': { success: true },
          'registration': { success: true }
        },
        issues: []
      };
      
      assert.strictEqual(verifier.determineOverallSuccess(results), true);
    });
  });

  describe('shouldTriggerRollback', () => {
    it('should return true when critical service port is down', () => {
      const results = {
        services: {
          'gateway': { port: { status: 'failed' } },
          'user-service': { port: { status: 'ok' } },
          'catch-service': { port: { status: 'ok' } }
        },
        businessLinks: {},
        issues: []
      };
      
      assert.strictEqual(verifier.shouldTriggerRollback(results), true);
    });

    it('should return true when all business links fail', () => {
      const results = {
        services: {
          'gateway': { port: { status: 'ok' }, api: { status: 'ok' } },
          'user-service': { port: { status: 'ok' }, api: { status: 'ok' } },
          'catch-service': { port: { status: 'ok' }, api: { status: 'ok' } }
        },
        businessLinks: {
          'login': { success: false },
          'catch': { success: false },
          'registration': { success: false }
        },
        issues: []
      };
      
      assert.strictEqual(verifier.shouldTriggerRollback(results), true);
    });

    it('should return false when everything is healthy', () => {
      const results = {
        services: {
          'gateway': { port: { status: 'ok' }, api: { status: 'ok' } },
          'user-service': { port: { status: 'ok' }, api: { status: 'ok' }, database: { status: 'ok' } },
          'catch-service': { port: { status: 'ok' }, api: { status: 'ok' } }
        },
        businessLinks: {
          'login': { success: true },
          'catch': { success: true }
        },
        issues: []
      };
      
      assert.strictEqual(verifier.shouldTriggerRollback(results), false);
    });
  });

  describe('generateReport', () => {
    it('should generate a readable report', () => {
      const results = {
        deploymentId: 'test-123',
        environment: 'production',
        timestamp: Date.now(),
        overallSuccess: true,
        rollbackRequired: false,
        duration: 1234,
        services: {
          'gateway': { port: { status: 'ok' }, api: { status: 'ok' } }
        },
        dependencies: {
          redis: { status: 'ok' },
          kafka: { status: 'ok' }
        },
        businessLinks: {
          'login': { success: true, description: 'User login link' }
        },
        issues: []
      };
      
      const report = verifier.generateReport(results);
      
      assert.ok(report.includes('Deployment Health Verification Report'));
      assert.ok(report.includes('test-123'));
      assert.ok(report.includes('PASSED'));
    });
  });

  describe('verify', () => {
    it('should return verification results', async () => {
      const deploymentInfo = {
        id: 'deploy-test',
        environment: 'staging',
        version: '1.0.0'
      };
      
      const result = await verifier.verify(deploymentInfo);
      
      assert.ok(result.deploymentId);
      assert.strictEqual(typeof result.overallSuccess, 'boolean');
      assert.strictEqual(typeof result.rollbackRequired, 'boolean');
      assert.ok(Array.isArray(result.issues));
      assert.ok(result.duration > 0);
    });

    it('should emit verification:complete event', async () => {
      const deploymentInfo = {
        id: 'deploy-event-test',
        environment: 'production'
      };
      
      let eventEmitted = false;
      verifier.on('verification:complete', () => {
        eventEmitted = true;
      });
      
      await verifier.verify(deploymentInfo);
      
      assert.strictEqual(eventEmitted, true);
    });
  });
});
