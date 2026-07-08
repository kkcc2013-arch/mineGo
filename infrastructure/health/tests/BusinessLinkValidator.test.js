/**
 * BusinessLinkValidator 单元测试
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const BusinessLinkValidator = require('../BusinessLinkValidator');

describe('BusinessLinkValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new BusinessLinkValidator({
      timeout: 5000,
      servicePorts: {
        'gateway': 8080,
        'user-service': 8081,
        'catch-service': 8084
      }
    });
  });

  describe('constructor', () => {
    it('should initialize with default timeout', () => {
      const defaultValidator = new BusinessLinkValidator();
      assert.strictEqual(defaultValidator.timeout, 15000);
    });

    it('should use custom timeout from config', () => {
      assert.strictEqual(validator.timeout, 5000);
    });

    it('should set default service ports', () => {
      const defaultValidator = new BusinessLinkValidator();
      assert.strictEqual(defaultValidator.servicePorts['gateway'], 8080);
      assert.strictEqual(defaultValidator.servicePorts['user-service'], 8081);
    });
  });

  describe('validateLink', () => {
    it('should validate a complete link', async () => {
      const link = {
        name: 'test-link',
        steps: ['gateway', 'user-service', 'redis']
      };
      
      const result = await validator.validateLink(link);
      
      assert.strictEqual(result.name, 'test-link');
      assert.strictEqual(typeof result.success, 'boolean');
      assert.ok(Array.isArray(result.steps));
      assert.ok(result.duration >= 0);
    });

    it('should return error for invalid step', async () => {
      const link = {
        name: 'invalid-link',
        steps: ['unknown-step']
      };
      
      const result = await validator.validateLink(link);
      
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('Unknown step type'));
    });

    it('should emit link:validated event', async () => {
      let eventEmitted = false;
      validator.on('link:validated', () => {
        eventEmitted = true;
      });
      
      const link = {
        name: 'event-test',
        steps: ['gateway']
      };
      
      await validator.validateLink(link);
      
      assert.strictEqual(eventEmitted, true);
    });
  });

  describe('validateStep', () => {
    it('should validate service step', async () => {
      const result = await validator.validateStep('gateway', 'test', 0);
      
      assert.strictEqual(result.step, 'gateway');
      assert.strictEqual(typeof result.success, 'boolean');
      assert.ok(result.details);
      assert.strictEqual(result.details.type, 'service');
    });

    it('should validate database step', async () => {
      const result = await validator.validateStep('database', 'login', 1);
      
      assert.strictEqual(result.step, 'database');
      assert.strictEqual(typeof result.success, 'boolean');
      assert.ok(result.details);
      assert.strictEqual(result.details.type, 'database');
    });

    it('should validate redis step', async () => {
      const result = await validator.validateStep('redis', 'login', 1);
      
      assert.strictEqual(result.step, 'redis');
      assert.strictEqual(typeof result.success, 'boolean');
      assert.ok(result.details);
      assert.strictEqual(result.details.type, 'redis');
    });

    it('should validate kafka step', async () => {
      const result = await validator.validateStep('kafka', 'battle', 1);
      
      assert.strictEqual(result.step, 'kafka');
      assert.strictEqual(typeof result.success, 'boolean');
      assert.ok(result.details);
      assert.strictEqual(result.details.type, 'kafka');
    });
  });

  describe('validateMultiple', () => {
    it('should validate multiple links', async () => {
      const links = [
        { name: 'link1', steps: ['gateway'] },
        { name: 'link2', steps: ['user-service'] }
      ];
      
      const result = await validator.validateMultiple(links);
      
      assert.strictEqual(result.total, 2);
      assert.ok(result.passed >= 0);
      assert.ok(result.failed >= 0);
      assert.strictEqual(result.passed + result.failed, result.total);
      assert.ok(result.duration > 0);
    });
  });
});
