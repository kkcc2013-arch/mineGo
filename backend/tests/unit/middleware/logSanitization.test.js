/**
 * LogSanitizer Tests - 日志脱敏模块测试
 */

'use strict';

const assert = require('assert');
const { LogSanitizer, getLogSanitizer } = require('../shared/middleware/logSanitization');

describe('LogSanitizer', function() {
  describe('sanitize', function() {
    let sanitizer;

    before(function() {
      sanitizer = new LogSanitizer();
    });

    it('should sanitize password field', function() {
      const obj = { password: 'secret123', username: 'user' };
      const sanitized = sanitizer.sanitize(obj);
      
      assert.strictEqual(sanitized.password, '[REDACTED]');
      assert.strictEqual(sanitized.username, 'user');
    });

    it('should sanitize apiKey field', function() {
      const obj = { apiKey: 'my-api-key', name: 'test' };
      const sanitized = sanitizer.sanitize(obj);
      
      assert.strictEqual(sanitized.apiKey, '[REDACTED]');
      assert.strictEqual(sanitized.name, 'test');
    });

    it('should sanitize nested objects', function() {
      const obj = {
        user: {
          name: 'John',
          credentials: {
            token: 'secret-token',
            password: 'secret-pass'
          }
        }
      };
      const sanitized = sanitizer.sanitize(obj);
      
      assert.strictEqual(sanitized.user.name, 'John');
      assert.strictEqual(sanitized.user.credentials.token, '[REDACTED]');
      assert.strictEqual(sanitized.user.credentials.password, '[REDACTED]');
    });

    it('should sanitize arrays', function() {
      const obj = {
        users: [
          { name: 'John', password: 'pass1' },
          { name: 'Jane', password: 'pass2' }
        ]
      };
      const sanitized = sanitizer.sanitize(obj);
      
      assert.strictEqual(sanitized.users[0].name, 'John');
      assert.strictEqual(sanitized.users[0].password, '[REDACTED]');
      assert.strictEqual(sanitized.users[1].name, 'Jane');
      assert.strictEqual(sanitized.users[1].password, '[REDACTED]');
    });

    it('should return null unchanged', function() {
      assert.strictEqual(sanitizer.sanitize(null), null);
    });

    it('should return undefined unchanged', function() {
      assert.strictEqual(sanitizer.sanitize(undefined), undefined);
    });

    it('should return primitives unchanged', function() {
      assert.strictEqual(sanitizer.sanitize(123), 123);
      assert.strictEqual(sanitizer.sanitize(true), true);
    });

    it('should limit recursion depth', function() {
      const deep = { a: { b: { c: { d: { e: { f: { g: 'value' } } } } } } };
      const sanitized = sanitizer.sanitize(deep, 5);
      
      assert.strictEqual(sanitized.a.b.c.d.e, '[MAX_DEPTH_REACHED]');
    });
  });

  describe('sanitizeString', function() {
    let sanitizer;

    before(function() {
      sanitizer = new LogSanitizer();
    });

    it('should sanitize Bearer token', function() {
      const str = 'Authorization: Bearer abc123def456ghi789';
      const sanitized = sanitizer.sanitizeString(str);
      
      assert.ok(!sanitized.includes('abc123def456ghi789'));
      assert.ok(sanitized.includes('[REDACTED]'));
    });

    it('should sanitize JWT token', function() {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const sanitized = sanitizer.sanitizeString(jwt);
      
      assert.ok(sanitized.includes('[REDACTED]'));
    });

    it('should sanitize private key', function() {
      const str = '-----BEGIN RSA PRIVATE KEY-----MIIEpAIBAAKCAQEA...-----END RSA PRIVATE KEY-----';
      const sanitized = sanitizer.sanitizeString(str);
      
      assert.ok(sanitized.includes('[REDACTED]'));
    });

    it('should sanitize AWS key', function() {
      const str = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      const sanitized = sanitizer.sanitizeString(str);
      
      assert.ok(!sanitized.includes('AKIAIOSFODNN7EXAMPLE'));
    });

    it('should sanitize long strings (potential keys)', function() {
      const str = 'key: abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const sanitized = sanitizer.sanitizeString(str);
      
      assert.ok(sanitized.includes('[REDACTED]'));
    });

    it('should leave short strings unchanged', function() {
      const str = 'hello world';
      const sanitized = sanitizer.sanitizeString(str);
      
      assert.strictEqual(sanitized, str);
    });
  });

  describe('sanitizeHeaders', function() {
    let sanitizer;

    before(function() {
      sanitizer = new LogSanitizer();
    });

    it('should sanitize authorization header', function() {
      const headers = {
        'Authorization': 'Bearer token123',
        'Content-Type': 'application/json'
      };
      const sanitized = sanitizer.sanitizeHeaders(headers);
      
      assert.strictEqual(sanitized['Authorization'], '[REDACTED]');
      assert.strictEqual(sanitized['Content-Type'], 'application/json');
    });

    it('should sanitize cookie header', function() {
      const headers = {
        'Cookie': 'session=abc123',
        'User-Agent': 'Mozilla/5.0'
      };
      const sanitized = sanitizer.sanitizeHeaders(headers);
      
      assert.strictEqual(sanitized['Cookie'], '[REDACTED]');
      assert.strictEqual(sanitized['User-Agent'], 'Mozilla/5.0');
    });
  });

  describe('detectSensitive', function() {
    let sanitizer;

    before(function() {
      sanitizer = new LogSanitizer();
    });

    it('should detect JWT', function() {
      const str = 'Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const detected = sanitizer.detectSensitive(str);
      
      assert.ok(detected.includes('jwt'));
    });

    it('should detect Bearer token', function() {
      const str = 'Authorization: Bearer abc123';
      const detected = sanitizer.detectSensitive(str);
      
      assert.ok(detected.includes('bearer_token'));
    });

    it('should detect private key', function() {
      const str = '-----BEGIN RSA PRIVATE KEY-----';
      const detected = sanitizer.detectSensitive(str);
      
      assert.ok(detected.includes('private_key'));
    });

    it('should return empty array for clean string', function() {
      const str = 'This is a normal log message';
      const detected = sanitizer.detectSensitive(str);
      
      assert.strictEqual(detected.length, 0);
    });
  });

  describe('disabled sanitizer', function() {
    it('should not sanitize when disabled', function() {
      const sanitizer = new LogSanitizer({ enabled: false });
      
      const obj = { password: 'secret123' };
      const sanitized = sanitizer.sanitize(obj);
      
      assert.strictEqual(sanitized.password, 'secret123');
    });
  });
});

describe('getLogSanitizer singleton', function() {
  it('should return the same instance', function() {
    const instance1 = getLogSanitizer();
    const instance2 = getLogSanitizer();
    
    assert.strictEqual(instance1, instance2);
  });
});
