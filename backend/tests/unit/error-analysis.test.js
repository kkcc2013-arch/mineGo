/**
 * Error Analysis Module Unit Tests
 * 
 * Tests for StackFingerprintGenerator, ErrorAggregator, RootCauseAnalyzer
 */

'use strict';

const { StackFingerprintGenerator, ErrorAggregator, RootCauseAnalyzer } = require('../shared/errorAnalysis');

describe('StackFingerprintGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = new StackFingerprintGenerator();
  });

  describe('generate()', () => {
    it('should generate fingerprint from Error object', () => {
      const error = new Error('Test error message');
      error.stack = `Error: Test error message
    at Object.<anonymous> (/app/backend/services/user-service/src/index.js:10:15)
    at Module._compile (node:internal/modules/cjs/loader:1234:56)
    at Function.execute (node:internal/modules/cjs/loader:789:10)`;

      const fingerprint = generator.generate(error);

      expect(fingerprint).toBeDefined();
      expect(fingerprint.fingerprint).toBeDefined();
      expect(fingerprint.errorName).toBe('Error');
      expect(fingerprint.messagePattern).toBe('Test error message');
      expect(fingerprint.keyFrames).toBeDefined();
      expect(fingerprint.keyFrameCount).toBeGreaterThan(0);
    });

    it('should generate same fingerprint for identical stacks', () => {
      const stack = `Error: Test
    at testFunc (backend/services/user-service/src/handlers.js:100:5)
    at processTicksAndRejections (node:internal/process/task_queues.js:95:5)`;

      const fp1 = generator.generate({ stack, message: 'Test', name: 'Error' });
      const fp2 = generator.generate({ stack, message: 'Test', name: 'Error' });

      expect(fp1.fingerprint).toBe(fp2.fingerprint);
    });

    it('should normalize dynamic values in message', () => {
      const error1 = new Error('User 123 not found');
      error1.stack = 'Error: User 123 not found\n    at test.js:1:1';

      const error2 = new Error('User 456 not found');
      error2.stack = 'Error: User 456 not found\n    at test.js:1:1';

      const fp1 = generator.generate(error1);
      const fp2 = generator.generate(error2);

      // 消息模式应该不同（因为数字不同）
      expect(fp1.messagePattern).not.toContain('123');
      expect(fp2.messagePattern).not.toContain('456');
    });

    it('should handle errors without stack', () => {
      const error = { message: 'Stackless error', name: 'Error' };
      const fingerprint = generator.generate(error);

      expect(fingerprint).toBeDefined();
      expect(fingerprint.keyFrames).toEqual([]);
    });

    it('should extract key frames correctly', () => {
      const error = new Error('Test');
      error.stack = `Error: Test
    at nodeFunc (node:internal/test.js:10:5)
    at userFunc (backend/services/user-service/src/handlers/user.js:50:10)
    at anotherNodeFunc (node:internal/module.js:20:5)
    at appFunc (backend/shared/utils.js:100:5)`;

      const fingerprint = generator.generate(error);

      // 应该只包含 backend/ 下的帧，忽略 node:internal
      expect(fingerprint.keyFrames.length).toBeGreaterThan(0);
      expect(fingerprint.keyFrames.some(f => f.file.includes('backend/'))).toBe(true);
    });
  });

  describe('similarity()', () => {
    it('should return 1.0 for identical fingerprints', () => {
      const error = new Error('Test');
      error.stack = 'Error: Test\n    at test.js:1:1';
      
      const fp1 = generator.generate(error);
      const fp2 = generator.generate(error);

      const sim = generator.similarity(fp1, fp2);
      expect(sim).toBe(1.0);
    });

    it('should return high similarity for similar stacks', () => {
      const error1 = { stack: 'Error\n    at func (backend/test.js:10:5)', message: 'Test', name: 'Error' };
      const error2 = { stack: 'Error\n    at func (backend/test.js:20:8)', message: 'Test', name: 'Error' };

      const fp1 = generator.generate(error1);
      const fp2 = generator.generate(error2);

      const sim = generator.similarity(fp1, fp2);
      expect(sim).toBeGreaterThan(0.7);
    });

    it('should return low similarity for different errors', () => {
      const error1 = { stack: 'Error\n    at funcA (backend/test.js:10:5)', message: 'Error A', name: 'Error' };
      const error2 = { stack: 'Error\n    at funcB (backend/other.js:20:8)', message: 'Error B', name: 'Error' };

      const fp1 = generator.generate(error1);
      const fp2 = generator.generate(error2);

      const sim = generator.similarity(fp1, fp2);
      expect(sim).toBeLessThan(0.5);
    });
  });

  describe('generateBatch()', () => {
    it('should process multiple errors', () => {
      const errors = [
        new Error('Error 1'),
        new Error('Error 2'),
        new Error('Error 3')
      ];

      const fingerprints = generator.generateBatch(errors);

      expect(fingerprints.length).toBe(3);
      expect(fingerprints[0].fingerprint).toBeDefined();
    });
  });
});

describe('ErrorAggregator', () => {
  let aggregator;

  beforeEach(() => {
    aggregator = new ErrorAggregator();
  });

  describe('aggregate()', () => {
    it('should create new group for new error', async () => {
      const errorEvent = {
        error: new Error('New error'),
        service: 'user-service',
        userId: 'user-123',
        timestamp: new Date()
      };

      const result = await aggregator.aggregate(errorEvent);

      expect(result.isNew).toBe(true);
      expect(result.groupId).toBeDefined();
      expect(result.fingerprint).toBeDefined();
    });

    it('should add to existing group for similar error', async () => {
      const error = new Error('Recurring error');
      error.stack = 'Error: Recurring error\n    at func (backend/test.js:10:5)';

      const event1 = {
        error,
        service: 'user-service',
        userId: 'user-123'
      };

      const event2 = {
        error,
        service: 'user-service',
        userId: 'user-456'
      };

      const result1 = await aggregator.aggregate(event1);
      const result2 = await aggregator.aggregate(event2);

      expect(result1.groupId).toBe(result2.groupId);
      expect(result1.isNew).toBe(true);
      expect(result2.isNew).toBe(false);
    });

    it('should track affected users', async () => {
      const error = new Error('User error');
      error.stack = 'Error: User error\n    at test.js:1:1';

      const events = [
        { error, service: 'user-service', userId: 'user-1' },
        { error, service: 'user-service', userId: 'user-2' },
        { error, service: 'user-service', userId: 'user-1' } // 重复用户
      ];

      for (const event of events) {
        await aggregator.aggregate(event);
      }

      const stats = aggregator.getStatistics();
      expect(stats.totalAffectedUsers).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getGroup()', () => {
    it('should return group details', async () => {
      const errorEvent = {
        error: new Error('Test error'),
        service: 'user-service',
        userId: 'user-123'
      };

      const result = await aggregator.aggregate(errorEvent);
      const group = aggregator.getGroup(result.groupId);

      expect(group).toBeDefined();
      expect(group.id).toBe(result.groupId);
      expect(group.service).toBe('user-service');
      expect(group.occurrenceCount).toBeGreaterThan(0);
    });

    it('should return null for unknown group', () => {
      const group = aggregator.getGroup('unknown-id');
      expect(group).toBeNull();
    });
  });

  describe('getActiveGroups()', () => {
    it('should return active groups', async () => {
      // 创建多个错误组
      await aggregator.aggregate({
        error: new Error('Error A'),
        service: 'user-service'
      });
      await aggregator.aggregate({
        error: new Error('Error B'),
        service: 'payment-service'
      });

      const groups = aggregator.getActiveGroups();

      expect(groups.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by service', async () => {
      await aggregator.aggregate({
        error: new Error('Error'),
        service: 'user-service'
      });
      await aggregator.aggregate({
        error: new Error('Error'),
        service: 'payment-service'
      });

      const groups = aggregator.getActiveGroups({ service: 'user-service' });

      expect(groups.every(g => g.service === 'user-service')).toBe(true);
    });
  });

  describe('resolveGroup()', () => {
    it('should mark group as resolved', async () => {
      const result = await aggregator.aggregate({
        error: new Error('Test'),
        service: 'user-service'
      });

      const success = await aggregator.resolveGroup(result.groupId, {
        resolution: 'Fixed in version 1.2.3',
        resolvedBy: 'developer'
      });

      expect(success).toBe(true);
      
      const group = aggregator.getGroup(result.groupId);
      expect(group.status).toBe('resolved');
    });
  });

  describe('getStatistics()', () => {
    it('should return aggregate statistics', async () => {
      // 创建一些错误
      for (let i = 0; i < 5; i++) {
        await aggregator.aggregate({
          error: new Error(`Error ${i}`),
          service: 'user-service',
          userId: `user-${i}`
        });
      }

      const stats = aggregator.getStatistics();

      expect(stats.totalGroups).toBeGreaterThan(0);
      expect(stats.activeGroups).toBeGreaterThan(0);
      expect(stats.totalOccurrences).toBeGreaterThan(0);
    });
  });

  describe('aggregateBatch()', () => {
    it('should process multiple events', async () => {
      const events = [
        { error: new Error('E1'), service: 'user-service' },
        { error: new Error('E2'), service: 'user-service' },
        { error: new Error('E3'), service: 'user-service' }
      ];

      const result = await aggregator.aggregateBatch(events);

      expect(result.totalProcessed).toBe(3);
      expect(result.newGroups).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('RootCauseAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new RootCauseAnalyzer();
  });

  describe('analyze()', () => {
    it('should analyze error group without dependencies', async () => {
      const errorGroup = {
        id: 'test-group',
        errorCode: 'INTERNAL_ERROR',
        errorName: 'Error',
        messagePattern: 'Test error',
        keyFrames: [],
        service: 'user-service',
        firstSeen: new Date(),
        lastSeen: new Date()
      };

      const result = await analyzer.analyze(errorGroup);

      expect(result).toBeDefined();
      expect(result.errorGroup).toBe('test-group');
      expect(result.causes).toBeDefined();
      expect(result.recommendation).toBeDefined();
      expect(result.analyzedAt).toBeDefined();
    });

    it('should return empty causes for unknown error', async () => {
      const errorGroup = {
        id: 'unknown',
        errorCode: 'UNKNOWN',
        service: 'unknown-service',
        firstSeen: new Date(),
        lastSeen: new Date()
      };

      const result = await analyzer.analyze(errorGroup);

      expect(result.causes).toBeDefined();
    });
  });

  describe('_generateRecommendation()', () => {
    it('should generate deployment recommendation', () => {
      const causes = [{
        type: 'deployment',
        confidence: 0.9,
        details: [{ version: 'v1.2.3' }]
      }];

      const recommendation = analyzer._generateRecommendation(causes);

      expect(recommendation.priority).toBe('high');
      expect(recommendation.actions).toContain('回滚到上一版本');
    });

    it('should generate dependency recommendation', () => {
      const causes = [{
        type: 'dependency',
        confidence: 0.95,
        details: [{ service: 'payment-service', status: 'down' }]
      }];

      const recommendation = analyzer._generateRecommendation(causes);

      expect(recommendation.priority).toBe('critical');
      expect(recommendation.affectedServices).toContain('payment-service');
    });

    it('should handle empty causes', () => {
      const recommendation = analyzer._generateRecommendation([]);

      expect(recommendation.priority).toBe('medium');
      expect(recommendation.actions.length).toBeGreaterThan(0);
    });
  });
});

describe('ErrorAnalysis Integration', () => {
  it('should work as a complete system', async () => {
    const { createSystem } = require('../shared/errorAnalysis');
    
    const system = createSystem({}, {});
    
    // 处理错误
    const errorEvent = {
      error: new Error('Integration test error'),
      errorCode: 'TEST_ERROR',
      service: 'test-service',
      userId: 'test-user'
    };

    const result = await system.processError(errorEvent);

    expect(result).toBeDefined();
    expect(result.groupId).toBeDefined();
    expect(result.analysis).toBeDefined();
  });
});
