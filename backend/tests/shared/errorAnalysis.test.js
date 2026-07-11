/**
 * 错误智能分析系统单元测试
 */

const { expect } = require('chai');
const StackFingerprintGenerator = require('../../shared/errorAnalysis/StackFingerprintGenerator');
const ErrorAggregator = require('../../shared/errorAnalysis/ErrorAggregator');
const RootCauseAnalyzer = require('../../shared/errorAnalysis/RootCauseAnalyzer');
const ErrorTrendAnalyzer = require('../../shared/errorAnalysis/ErrorTrendAnalyzer');
const ErrorContextSnapshot = require('../../shared/errorAnalysis/ErrorContextSnapshot');
const IntelligentAlerting = require('../../shared/errorAnalysis/IntelligentAlerting');

describe('StackFingerprintGenerator', () => {
  let generator;
  
  beforeEach(() => {
    generator = new StackFingerprintGenerator();
  });
  
  describe('#generate()', () => {
    it('should generate fingerprint for error with stack trace', () => {
      const error = new Error('Test error');
      error.stack = `Error: Test error
    at Object.<anonymous> (/app/backend/services/user-service/src/handlers.js:123:45)
    at Module._compile (internal/modules/cjs/loader.js:1085:14)
    at Object.Module._extensions..js (internal/modules/cjs/loader.js:1114:10)`;
      
      const fingerprint = generator.generate(error);
      
      expect(fingerprint).to.have.property('fingerprint');
      expect(fingerprint).to.have.property('keyFrames');
      expect(fingerprint).to.have.property('messagePattern');
      expect(fingerprint).to.have.property('errorName', 'Error');
      expect(fingerprint.fingerprint).to.match(/^[a-f0-9]{16}$/);
    });
    
    it('should normalize error message', () => {
      const error = new Error('Cannot read property "id" of undefined');
      error.stack = 'Error: Cannot read property "id" of undefined\n    at test.js:10:20';
      
      const fingerprint = generator.generate(error);
      
      expect(fingerprint.messagePattern).to.include('cannot read property');
    });
    
    it('should ignore node_modules frames', () => {
      const error = new Error('Test');
      error.stack = `Error: Test
    at handler (/app/services/user-service/handler.js:10:20)
    at node_modules/express/lib/router.js:100:10
    at node_modules/express/lib/application.js:200:10`;
      
      const fingerprint = generator.generate(error);
      
      const hasNodeModules = fingerprint.keyFrames.some(f => 
        f.file.includes('node_modules')
      );
      
      expect(hasNodeModules).to.be.false;
    });
  });
  
  describe('#similarity()', () => {
    it('should return 1.0 for identical fingerprints', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:10:20';
      
      const fp1 = generator.generate(error);
      const fp2 = generator.generate(error);
      
      const similarity = generator.similarity(fp1, fp2);
      
      expect(similarity).to.equal(1.0);
    });
    
    it('should return 0 for different error types', () => {
      const fp1 = generator.generate(new Error('Error 1'));
      const fp2 = generator.generate({ name: 'TypeError', message: 'Error 2', stack: '' });
      
      const similarity = generator.similarity(fp1, fp2);
      
      expect(similarity).to.equal(0);
    });
  });
});

describe('ErrorAggregator', () => {
  let aggregator;
  
  beforeEach(() => {
    // 使用模拟的 Redis 客户端
    const mockRedis = {
      get: () => Promise.resolve(null),
      setex: () => Promise.resolve('OK'),
      zadd: () => Promise.resolve(1),
      zrangebyscore: () => Promise.resolve([]),
      lpush: () => Promise.resolve(1),
      ltrim: () => Promise.resolve('OK'),
      multi: () => ({
        hincrby: () => ({ exec: () => Promise.resolve([]) }),
        exec: () => Promise.resolve([])
      }),
      hget: () => Promise.resolve(null),
      sadd: () => Promise.resolve(1)
    };
    
    aggregator = new ErrorAggregator();
    // 注入模拟 Redis（实际项目中应使用依赖注入）
  });
  
  describe('#_generateGroupId()', () => {
    it('should generate unique group IDs', () => {
      const id1 = aggregator._generateGroupId();
      const id2 = aggregator._generateGroupId();
      
      expect(id1).to.not.equal(id2);
      expect(id1).to.match(/^eg-\d+-[a-z0-9]+$/);
    });
  });
  
  describe('#_generateEventId()', () => {
    it('should generate unique event IDs', () => {
      const id1 = aggregator._generateEventId();
      const id2 = aggregator._generateEventId();
      
      expect(id1).to.not.equal(id2);
      expect(id1).to.match(/^ev-\d+-[a-z0-9]+$/);
    });
  });
});

describe('RootCauseAnalyzer', () => {
  let analyzer;
  
  beforeEach(() => {
    analyzer = new RootCauseAnalyzer();
  });
  
  describe('#_generateRecommendation()', () => {
    it('should generate recommendation for deployment cause', () => {
      const causes = [{
        type: 'deployment',
        confidence: 0.9,
        suggestion: '考虑回滚'
      }];
      
      const recommendation = analyzer._generateRecommendation(causes, {});
      
      expect(recommendation).to.include('部署');
      expect(recommendation).to.include('回滚');
    });
    
    it('should return default message for no causes', () => {
      const recommendation = analyzer._generateRecommendation([], {});
      
      expect(recommendation).to.include('手动排查');
    });
  });
  
  describe('#_getServiceDependencies()', () => {
    it('should return dependencies for gateway', async () => {
      const deps = await analyzer._getServiceDependencies('gateway');
      
      expect(deps).to.be.an('array');
      expect(deps).to.have.length.greaterThan(0);
      expect(deps[0]).to.have.property('name');
    });
    
    it('should return empty array for unknown service', async () => {
      const deps = await analyzer._getServiceDependencies('unknown-service');
      
      expect(deps).to.be.an('array');
      expect(deps).to.have.length(0);
    });
  });
});

describe('ErrorTrendAnalyzer', () => {
  let analyzer;
  
  beforeEach(() => {
    analyzer = new ErrorTrendAnalyzer();
  });
  
  describe('#_calculateStatistics()', () => {
    it('should calculate correct statistics', () => {
      const values = [10, 20, 30, 40, 50];
      
      const stats = analyzer._calculateStatistics(values);
      
      expect(stats.mean).to.equal(30);
      expect(stats.min).to.equal(10);
      expect(stats.max).to.equal(50);
      expect(stats.sampleSize).to.equal(5);
      expect(stats.stdDev).to.be.greaterThan(0);
    });
  });
  
  describe('#_calculateSeverity()', () => {
    it('should return critical for high error rate', () => {
      const severity = analyzer._calculateSeverity(5.5, 150);
      
      expect(severity).to.equal('critical');
    });
    
    it('should return high for medium error rate', () => {
      const severity = analyzer._calculateSeverity(4.0, 60);
      
      expect(severity).to.equal('high');
    });
    
    it('should return medium for low error rate', () => {
      const severity = analyzer._calculateSeverity(3.2, 25);
      
      expect(severity).to.equal('medium');
    });
    
    it('should return low for normal error rate', () => {
      const severity = analyzer._calculateSeverity(1.5, 10);
      
      expect(severity).to.equal('low');
    });
  });
  
  describe('#_simpleLinearRegression()', () => {
    it('should predict increasing trend', () => {
      const series = [];
      for (let i = 0; i < 20; i++) {
        series.push({ timestamp: i, value: i * 2 });
      }
      
      const prediction = analyzer._simpleLinearRegression(series, 30);
      
      expect(prediction.trend).to.equal('increasing');
      expect(prediction.rate).to.be.greaterThan(0);
    });
    
    it('should predict stable trend for constant values', () => {
      const series = [];
      for (let i = 0; i < 20; i++) {
        series.push({ timestamp: i, value: 50 });
      }
      
      const prediction = analyzer._simpleLinearRegression(series, 30);
      
      expect(prediction.trend).to.equal('stable');
    });
  });
});

describe('ErrorContextSnapshot', () => {
  let snapshotManager;
  
  beforeEach(() => {
    snapshotManager = new ErrorContextSnapshot();
  });
  
  describe('#_sanitizeObject()', () => {
    it('should redact sensitive fields', () => {
      const obj = {
        username: 'test',
        password: 'secret123',
        email: 'test@example.com',
        token: 'abc123'
      };
      
      const sanitized = snapshotManager._sanitizeObject(obj);
      
      expect(sanitized.username).to.equal('test');
      expect(sanitized.password).to.equal('***REDACTED***');
      expect(sanitized.token).to.equal('***REDACTED***');
    });
    
    it('should handle nested objects', () => {
      const obj = {
        user: {
          name: 'Test',
          password: 'secret'
        }
      };
      
      const sanitized = snapshotManager._sanitizeObject(obj);
      
      expect(sanitized.user.name).to.equal('Test');
      expect(sanitized.user.password).to.equal('***REDACTED***');
    });
  });
  
  describe('#_sanitizeHeaders()', () => {
    it('should redact authorization header', () => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123',
        'X-API-Key': 'key123'
      };
      
      const sanitized = snapshotManager._sanitizeHeaders(headers);
      
      expect(sanitized['Content-Type']).to.equal('application/json');
      expect(sanitized['Authorization']).to.equal('***REDACTED***');
      expect(sanitized['X-API-Key']).to.equal('***REDACTED***');
    });
  });
  
  describe('#_sanitizeIp()', () => {
    it('should mask IPv4 address', () => {
      const ip = '192.168.1.100';
      const sanitized = snapshotManager._sanitizeIp(ip);
      
      expect(sanitized).to.equal('192.168.1.***');
    });
    
    it('should mask IPv6 address', () => {
      const ip = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      const sanitized = snapshotManager._sanitizeIp(ip);
      
      expect(sanitized).to.include('***');
    });
  });
  
  describe('#_sanitizeEmail()', () => {
    it('should mask email address', () => {
      const email = 'test@example.com';
      const sanitized = snapshotManager._sanitizeEmail(email);
      
      expect(sanitized).to.match(/^te\*\*\*@example\.com$/);
    });
  });
  
  describe('#_generateId()', () => {
    it('should generate unique snapshot IDs', () => {
      const id1 = snapshotManager._generateId();
      const id2 = snapshotManager._generateId();
      
      expect(id1).to.not.equal(id2);
      expect(id1).to.match(/^snap-\d+-[a-f0-9]+$/);
    });
  });
});

describe('IntelligentAlerting', () => {
  let alerting;
  
  beforeEach(() => {
    alerting = new IntelligentAlerting({
      channels: {
        slack: { enabled: true, webhook: 'https://hooks.slack.com/test' },
        email: { enabled: false, recipients: [] }
      }
    });
  });
  
  describe('#_calculateSeverity()', () => {
    it('should return critical for payment service errors', () => {
      const group = {
        service: 'payment-service',
        affectedUsers: 5,
        occurrenceCount: 2
      };
      
      const severity = alerting._calculateSeverity(group, null);
      
      expect(severity).to.equal('critical');
    });
    
    it('should return critical for high affected users', () => {
      const group = {
        service: 'user-service',
        affectedUsers: 1500,
        occurrenceCount: 50
      };
      
      const severity = alerting._calculateSeverity(group, null);
      
      expect(severity).to.equal('critical');
    });
    
    it('should return high for medium affected users', () => {
      const group = {
        service: 'catch-service',
        affectedUsers: 150,
        occurrenceCount: 20
      };
      
      const severity = alerting._calculateSeverity(group, null);
      
      expect(severity).to.equal('high');
    });
    
    it('should downgrade severity for known issues', () => {
      const group = {
        service: 'pokemon-service',
        affectedUsers: 50,
        occurrenceCount: 10,
        status: 'known'
      };
      
      const severity = alerting._calculateSeverity(group, null);
      
      expect(severity).to.equal('low');
    });
  });
  
  describe('#_buildAlert()', () => {
    it('should build alert with all required fields', () => {
      const group = {
        id: 'eg-123',
        service: 'user-service',
        errorCode: 'AUTH_001',
        errorName: 'AuthenticationError',
        sampleError: { message: 'Token expired' },
        occurrenceCount: 10,
        affectedUsers: 5,
        firstSeen: '2026-07-11T00:00:00Z',
        lastSeen: '2026-07-11T01:00:00Z'
      };
      
      const rootCause = {
        causes: [{
          type: 'dependency',
          confidence: 0.9,
          details: { dependency: 'redis' },
          suggestion: 'Check Redis connection'
        }],
        recommendation: 'Check Redis'
      };
      
      const alert = alerting._buildAlert(group, rootCause, 'high');
      
      expect(alert).to.have.property('id');
      expect(alert).to.have.property('severity', 'high');
      expect(alert).to.have.property('title');
      expect(alert).to.have.property('summary');
      expect(alert).to.have.property('rootCause');
      expect(alert).to.have.property('recommendation');
      expect(alert).to.have.property('links');
    });
  });
  
  describe('#_generateAlertId()', () => {
    it('should generate unique alert IDs', () => {
      const id1 = alerting._generateAlertId();
      const id2 = alerting._generateAlertId();
      
      expect(id1).to.not.equal(id2);
      expect(id1).to.match(/^alert-\d+-[a-z0-9]+$/);
    });
  });
});

describe('ErrorAnalysisManager', () => {
  const { ErrorAnalysisManager } = require('../../shared/errorAnalysis');
  let manager;
  
  beforeEach(() => {
    manager = new ErrorAnalysisManager();
  });
  
  describe('#_shouldAlert()', () => {
    it('should alert for new error group', () => {
      const shouldAlert = manager._shouldAlert({ isNew: true }, null, null);
      
      expect(shouldAlert).to.be.true;
    });
    
    it('should alert for anomaly with high severity', () => {
      const shouldAlert = manager._shouldAlert(
        { isNew: false },
        { isAnomaly: true, severity: 'high' },
        null
      );
      
      expect(shouldAlert).to.be.true;
    });
    
    it('should not alert for low severity anomaly', () => {
      const shouldAlert = manager._shouldAlert(
        { isNew: false },
        { isAnomaly: true, severity: 'low' },
        null
      );
      
      expect(shouldAlert).to.be.false;
    });
    
    it('should alert for high confidence root cause', () => {
      const shouldAlert = manager._shouldAlert(
        { isNew: false },
        null,
        { causes: [{ confidence: 0.95, type: 'deployment' }] }
      );
      
      expect(shouldAlert).to.be.true;
    });
    
    it('should not alert for known issue', () => {
      const shouldAlert = manager._shouldAlert(
        { isNew: false },
        null,
        { causes: [{ confidence: 0.95, type: 'known_issue' }] }
      );
      
      expect(shouldAlert).to.be.false;
    });
  });
});