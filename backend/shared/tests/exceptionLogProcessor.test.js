/**
 * REQ-00555: 异常日志追踪系统单元测试
 */

const { describe, it, beforeEach, afterEach } = require('mocha');
const assert = require('assert');
const ExceptionFingerprintGenerator = require('../ExceptionFingerprintGenerator');
const ExceptionLogClusterer = require('../ExceptionLogClusterer');
const ExceptionAlertAggregator = require('../ExceptionAlertAggregator');
const ExceptionLogProcessor = require('../ExceptionLogProcessor');

describe('ExceptionFingerprintGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = new ExceptionFingerprintGenerator();
  });

  describe('#generateFingerprint', () => {
    it('should generate fingerprint for error log', () => {
      const logEntry = {
        level: 'error',
        message: 'TypeError: Cannot read property "x" of undefined',
        service: 'user-service',
        stack: `TypeError: Cannot read property "x" of undefined
    at UserService.getUser (/app/services/user.js:42:15)
    at Router.handle (/app/router.js:100:10)`
      };

      const fingerprint = generator.generateFingerprint(logEntry);

      assert.ok(fingerprint.fingerprintId);
      assert.strictEqual(fingerprint.exceptionType, 'TypeError');
      assert.ok(fingerprint.normalizedMessage);
      assert.ok(fingerprint.stackSignature);
      assert.ok(fingerprint.codeLocations.length > 0);
    });

    it('should normalize dynamic content in message', () => {
      const log1 = {
        level: 'error',
        message: 'Connection failed to 192.168.1.100:3306',
        service: 'db-service'
      };

      const log2 = {
        level: 'error',
        message: 'Connection failed to 10.0.0.50:3306',
        service: 'db-service'
      };

      const fp1 = generator.generateFingerprint(log1);
      const fp2 = generator.generateFingerprint(log2);

      // 归一化后消息应该相同
      assert.strictEqual(fp1.normalizedMessage, fp2.normalizedMessage);
    });

    it('should extract code locations from stack trace', () => {
      const logEntry = {
        level: 'error',
        message: 'Error',
        stack: `Error
    at foo (/app/bar.js:10:5)
    at baz (/app/qux.js:20:8)`
      };

      const fingerprint = generator.generateFingerprint(logEntry);

      assert.ok(fingerprint.codeLocations.includes('bar.js'));
      assert.ok(fingerprint.codeLocations.includes('qux.js'));
    });
  });

  describe('#calculateSimilarity', () => {
    it('should return high similarity for same exception type', () => {
      const fp1 = generator.generateFingerprint({
        level: 'error',
        message: 'TypeError: Cannot read property "x"',
        stack: 'at foo (/app/test.js:10:5)'
      });

      const fp2 = generator.generateFingerprint({
        level: 'error',
        message: 'TypeError: Cannot read property "y"',
        stack: 'at bar (/app/test.js:20:8)'
      });

      const similarity = generator.calculateSimilarity(fp1, fp2);

      assert.ok(similarity > 0.5, 'Same exception type should have similarity > 0.5');
    });

    it('should return similarity 1 for identical logs', () => {
      const logEntry = {
        level: 'error',
        message: 'Test Error',
        stack: 'at test'
      };

      const fp1 = generator.generateFingerprint(logEntry);
      const fp2 = generator.generateFingerprint(logEntry);

      const similarity = generator.calculateSimilarity(fp1, fp2);

      assert.strictEqual(similarity, 1);
    });
  });
});

describe('ExceptionLogClusterer', () => {
  let clusterer;

  beforeEach(() => {
    clusterer = new ExceptionLogClusterer({
      windowSize: 60,
      similarityThreshold: 0.85,
      maxClusters: 100
    });
  });

  afterEach(() => {
    clusterer.stop();
  });

  describe('#processLog', () => {
    it('should cluster error logs', () => {
      const logEntry = {
        level: 'error',
        message: 'TypeError: Test error',
        service: 'test-service',
        timestamp: new Date().toISOString()
      };

      const result = clusterer.processLog(logEntry);

      assert.ok(result);
      assert.ok(result.fingerprint);
      assert.ok(result.cluster);
      assert.ok(result.isNew, 'First log should create new cluster');
    });

    it('should add similar logs to same cluster', () => {
      const log1 = {
        level: 'error',
        message: 'TypeError: Cannot read property "x"',
        service: 'test-service'
      };

      const log2 = {
        level: 'error',
        message: 'TypeError: Cannot read property "y"',
        service: 'test-service'
      };

      const result1 = clusterer.processLog(log1);
      const result2 = clusterer.processLog(log2);

      // 相似错误应该归入同一集群
      assert.strictEqual(result1.cluster.fingerprintId, result2.cluster.fingerprintId);
      assert.strictEqual(result2.cluster.memberCount, 2);
    });

    it('should ignore non-error logs', () => {
      const logEntry = {
        level: 'info',
        message: 'Info message'
      };

      const result = clusterer.processLog(logEntry);

      assert.strictEqual(result, null);
    });
  });

  describe('#processBatch', () => {
    it('should process multiple logs', () => {
      const logs = [
        { level: 'error', message: 'Error 1', service: 's1' },
        { level: 'error', message: 'Error 2', service: 's2' },
        { level: 'info', message: 'Info 1' }
      ];

      const results = clusterer.processBatch(logs);

      assert.strictEqual(results.length, 2); // 只处理错误
    });
  });

  describe('#getClusterStats', () => {
    it('should return cluster statistics', () => {
      clusterer.processLog({ level: 'error', message: 'Error 1' });
      clusterer.processLog({ level: 'error', message: 'Error 2' });

      const stats = clusterer.getClusterStats();

      assert.ok(stats.totalClusters >= 1);
      assert.ok(stats.totalMembers >= 1);
    });
  });
});

describe('ExceptionAlertAggregator', () => {
  let aggregator;

  beforeEach(() => {
    aggregator = new ExceptionAlertAggregator({
      thresholds: {
        critical: { count: 1, windowSeconds: 60 },
        high: { count: 2, windowSeconds: 60 }
      },
      suppression: {
        maxAlertsPerHour: 100,
        duplicateSuppressionMinutes: 1
      }
    });
  });

  describe('#checkAndAlert', () => {
    it('should create alert for critical cluster', () => {
      const clusterInfo = {
        fingerprintId: 'test123',
        memberCount: 10,
        serviceCount: 3,
        services: ['s1', 's2', 's3'],
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };

      const fingerprint = {
        fingerprintId: 'test123',
        exceptionType: 'TypeError',
        normalizedMessage: 'Test error message',
        stackSignature: 'test|signature',
        codeLocations: ['file.js'],
        service: 'test-service'
      };

      const alert = aggregator.checkAndAlert(clusterInfo, fingerprint);

      assert.ok(alert);
      assert.strictEqual(alert.severity, 'critical');
      assert.strictEqual(alert.exceptionType, 'TypeError');
    });

    it('should suppress duplicate alerts', () => {
      const clusterInfo = {
        fingerprintId: 'test456',
        memberCount: 5,
        serviceCount: 1,
        services: ['s1'],
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };

      const fingerprint = {
        fingerprintId: 'test456',
        exceptionType: 'Error',
        normalizedMessage: 'Test',
        service: 'test'
      };

      // 第一次应该触发告警
      const alert1 = aggregator.checkAndAlert(clusterInfo, fingerprint);
      assert.ok(alert1);

      // 第二次应该被抑制
      const alert2 = aggregator.checkAndAlert(clusterInfo, fingerprint);
      assert.strictEqual(alert2, null);
    });
  });

  describe('#getAlertHistory', () => {
    it('should return alert history', () => {
      const clusterInfo = {
        fingerprintId: 'test789',
        memberCount: 10,
        serviceCount: 2,
        services: ['s1', 's2'],
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };

      const fingerprint = {
        fingerprintId: 'test789',
        exceptionType: 'Error',
        normalizedMessage: 'Test',
        service: 'test'
      };

      aggregator.checkAndAlert(clusterInfo, fingerprint);

      const history = aggregator.getAlertHistory();

      assert.ok(history.length > 0);
    });
  });
});

describe('ExceptionLogProcessor', () => {
  let processor;

  beforeEach(() => {
    processor = new ExceptionLogProcessor({
      clusterer: {
        windowSize: 60,
        maxClusters: 100
      },
      alertAggregator: {
        thresholds: {
          critical: { count: 1, windowSeconds: 60 }
        }
      }
    });
  });

  afterEach(() => {
    processor.stop();
  });

  describe('#processLog', () => {
    it('should process error log and trigger alert', () => {
      const logEntry = {
        level: 'error',
        message: 'TypeError: Test error',
        service: 'test-service'
      };

      const result = processor.processLog(logEntry);

      assert.ok(result);
      assert.ok(result.fingerprint);
      assert.ok(result.cluster);
    });
  });

  describe('#getProcessingStats', () => {
    it('should return processing statistics', () => {
      processor.processLog({ level: 'error', message: 'Error 1' });
      processor.processLog({ level: 'error', message: 'Error 2' });

      const stats = processor.getProcessingStats();

      assert.strictEqual(stats.logsProcessed, 2);
      assert.strictEqual(stats.errorsProcessed, 2);
    });
  });

  describe('#healthCheck', () => {
    it('should return health status', () => {
      const health = processor.healthCheck();

      assert.strictEqual(health.healthy, true);
      assert.ok(typeof health.uptime === 'number');
    });
  });
});

describe('Integration Tests', () => {
  let processor;

  beforeEach(() => {
    processor = new ExceptionLogProcessor();
  });

  afterEach(() => {
    processor.stop();
  });

  it('should handle realistic log flow', () => {
    // 模拟真实日志流
    const logs = [
      {
        level: 'error',
        message: 'TypeError: Cannot read property "data" of undefined',
        service: 'user-service',
        stack: `TypeError: Cannot read property "data" of undefined
    at UserService.fetchUser (/app/services/user.js:42:15)
    at Router.handle (/app/router.js:100:10)`
      },
      {
        level: 'error',
        message: 'TypeError: Cannot read property "data" of null',
        service: 'user-service',
        stack: `TypeError: Cannot read property "data" of null
    at UserService.fetchUser (/app/services/user.js:50:20)`
      },
      {
        level: 'error',
        message: 'DatabaseError: Connection refused',
        service: 'db-service'
      },
      {
        level: 'info',
        message: 'Request processed'
      }
    ];

    const results = processor.processBatch(logs);

    // 应该处理3个错误日志
    assert.strictEqual(results.results.length, 3);

    // 获取统计
    const stats = processor.getProcessingStats();
    assert.ok(stats.clusters.total >= 1);

    // 获取集群统计
    const clusterStats = processor.getClusterStats();
    assert.ok(clusterStats.totalClusters >= 1);
  });

  it('should achieve >90% clustering accuracy', () => {
    const generator = new ExceptionFingerprintGenerator();
    
    // 生成10个相似的TypeError
    const similarErrors = [];
    for (let i = 0; i < 10; i++) {
      similarErrors.push({
        level: 'error',
        message: `TypeError: Cannot read property "field${i}" of undefined`,
        service: 'test-service',
        stack: `TypeError: Cannot read property
    at TestService.method (/app/test.js:${10 + i}:5)`
      });
    }

    // 生成指纹并聚类
    const fingerprints = generator.generateBatchFingerprints(similarErrors);
    const clusters = generator.clusterExceptions(
      fingerprints.map(f => f.fingerprint),
      0.80
    );

    // 应该合并为少数几个集群
    const clusteringAccuracy = 1 - (clusters.length - 1) / similarErrors.length;
    
    assert.ok(clusteringAccuracy >= 0.9, 
      `Clustering accuracy ${clusteringAccuracy.toFixed(2)} should be >= 0.9`);
  });
});