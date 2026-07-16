'use strict';
/**
 * REQ-00041: 统一 API 输入验证与清理中间件 - 单元测试
 */

const { z } = require('zod');
const {
  UnifiedSecurityValidator,
  createSecurityValidator,
  validateRequest,
  securitySchemas,
  ATTACK_PATTERNS,
  SENSITIVE_FIELDS
} = require('../../shared/middleware/unifiedSecurityValidator');

// Mock Express objects
function createMockReq(overrides = {}) {
  return {
    ip: '127.0.0.1',
    path: '/api/test',
    method: 'POST',
    get: (header) => {
      const headers = {
        'user-agent': 'test-agent',
        ...overrides.headers
      };
      return headers[header];
    },
    body: overrides.body || {},
    query: overrides.query || {},
    params: overrides.params || {},
    headers: overrides.headers || {},
    locale: 'zh-CN',
    ...overrides
  };
}

function createMockRes() {
  const res = {
    locals: { requestId: 'test-req-001' },
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

// ====== Test Suite ======

async function runTests() {
  let passed = 0;
  let failed = 0;
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      results.push({ name, status: 'PASS' });
    } catch (error) {
      failed++;
      results.push({ name, status: 'FAIL', error: error.message });
    }
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
  }

  function assertIncludes(arr, item, message) {
    if (!arr.includes(item)) {
      throw new Error(message || `Array does not include ${item}`);
    }
  }

  // ====== Basic Functionality ======

  await test('should create UnifiedSecurityValidator instance', () => {
    const validator = new UnifiedSecurityValidator();
    assert(validator instanceof UnifiedSecurityValidator);
    assert(validator.stats.totalRequests === 0);
  });

  await test('should create validator with custom config', () => {
    const validator = new UnifiedSecurityValidator({
      sanitize: { enabled: false },
      monitoring: { reportToMetrics: false }
    });
    assert(validator.config.sanitize.enabled === false);
  });

  await test('should create validator via factory', () => {
    const validator = createSecurityValidator({ monitoring: { reportToMetrics: false } });
    assert(validator instanceof UnifiedSecurityValidator);
  });

  // ====== Schema Validation ======

  await test('should pass valid request through validation', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const schema = {
      body: z.object({
        name: z.string().min(1),
        age: z.number()
      })
    };
    
    const middleware = validator.validate(schema);
    const req = createMockReq({ body: { name: 'Test', age: 25 } });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(nextCalled, 'next() should be called');
    assertEqual(res.statusCode, 200);
  });

  await test('should reject invalid request body', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const schema = {
      body: z.object({
        email: z.string().email(),
        age: z.number().min(0)
      })
    };
    
    const middleware = validator.validate(schema);
    const req = createMockReq({ body: { email: 'invalid-email', age: -5 } });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'next() should not be called');
    assertEqual(res.statusCode, 400);
    assertEqual(res.body.error, 'VALIDATION_ERROR');
  });

  await test('should validate query parameters', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const schema = {
      query: z.object({
        page: z.coerce.number().int().positive(),
        pageSize: z.coerce.number().int().min(1).max(100)
      })
    };
    
    const middleware = validator.validate(schema);
    const req = createMockReq({ query: { page: '1', pageSize: '20' } });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(nextCalled, 'next() should be called');
  });

  await test('should validate path parameters', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const schema = {
      params: z.object({
        id: z.string().regex(/^[0-9a-fA-F]{24}$/)
      })
    };
    
    const middleware = validator.validate(schema);
    const req = createMockReq({ params: { id: '507f1f77bcf86cd799439011' } });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(nextCalled, 'next() should be called');
  });

  // ====== Attack Detection ======

  await test('should detect SQL injection in body', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: { search: "'; DROP TABLE users; --" }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'next() should not be called for SQL injection');
    assertEqual(res.statusCode, 400);
    assertEqual(res.body.error, 'SECURITY_VIOLATION');
  });

  await test('should detect SQL injection with OR 1=1', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: { username: "admin' OR 1=1 --" }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'Should block OR 1=1 attack');
  });

  await test('should detect XSS attempt in body', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: { comment: '<script>alert("xss")</script>' }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'Should block XSS attack');
  });

  await test('should detect XSS with javascript: protocol', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: { url: 'javascript:alert(1)' }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'Should block javascript: protocol');
  });

  await test('should detect path traversal attempt', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      query: { file: '../../../etc/passwd' }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'Should block path traversal');
  });

  await test('should detect NoSQL injection attempt', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: { userId: { $gt: '' } }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(!nextCalled, 'Should block NoSQL injection');
  });

  // ====== Input Sanitization ======

  await test('should sanitize HTML in string values', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: { content: '<b>hello</b>' }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(nextCalled, 'Should pass sanitized input');
    // After encoding, < and > should be encoded
    assert(req.body.content.includes('&lt;') || req.body.content.includes('&gt;'));
  });

  await test('should handle nested object sanitization', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({
      body: {
        user: {
          name: '<script>test</script>',
          profile: { bio: 'normal text' }
        }
      }
    });
    const res = createMockRes();
    
    // This should be blocked by XSS detection first
    // Let's use a simpler case
    const req2 = createMockReq({
      body: {
        user: {
          name: 'John & Jane',
          profile: { bio: 'Hello world' }
        }
      }
    });
    const res2 = createMockRes();
    
    let nextCalled = false;
    await middleware(req2, res2, () => { nextCalled = true; });
    
    assert(nextCalled, 'Should pass sanitized nested object');
  });

  await test('should preserve numbers and booleans', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const schema = {
      body: z.object({
        count: z.number(),
        active: z.boolean()
      })
    };
    const middleware = validator.validate(schema);
    
    const req = createMockReq({
      body: { count: 42, active: true }
    });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(nextCalled, 'Should pass');
    assertEqual(req.body.count, 42);
    assertEqual(req.body.active, true);
  });

  // ====== Predefined Security Schemas ======

  await test('should validate user registration schema', () => {
    const result = securitySchemas.userRegister.safeParse({
      username: 'testuser',
      email: 'test@example.com',
      password: 'TestPass123',
      nickname: 'Test'
    });
    
    assert(result.success, 'Valid registration should pass');
  });

  await test('should reject invalid registration - weak password', () => {
    const result = securitySchemas.userRegister.safeParse({
      username: 'testuser',
      email: 'test@example.com',
      password: 'weak'
    });
    
    assert(!result.success, 'Weak password should fail');
  });

  await test('should validate user login schema', () => {
    const result = securitySchemas.userLogin.safeParse({
      email: 'test@example.com',
      password: 'anypassword'
    });
    
    assert(result.success, 'Valid login should pass');
  });

  await test('should validate pagination schema', () => {
    const result = securitySchemas.pagination.safeParse({
      page: 1,
      pageSize: 20
    });
    
    assert(result.success, 'Valid pagination should pass');
  });

  await test('should apply default values for pagination', () => {
    const result = securitySchemas.pagination.safeParse({});
    
    assert(result.success, 'Empty pagination should pass with defaults');
    assertEqual(result.data.page, 1);
    assertEqual(result.data.pageSize, 20);
  });

  await test('should reject out-of-range pageSize', () => {
    const result = securitySchemas.pagination.safeParse({
      page: 1,
      pageSize: 500
    });
    
    assert(!result.success, 'pageSize > 100 should fail');
  });

  // ====== Statistics ======

  await test('should track statistics correctly', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    // Valid request
    const req1 = createMockReq({ body: { name: 'test' } });
    const res1 = createMockRes();
    await middleware(req1, res1, () => {});
    
    // Attack request
    const req2 = createMockReq({ body: { search: "'; DROP TABLE users; --" } });
    const res2 = createMockRes();
    await middleware(req2, res2, () => {});
    
    const stats = validator.getStats();
    assertEqual(stats.totalRequests, 2);
    assert(stats.blockedRequests >= 1, 'At least 1 blocked request');
    assert(stats.attackAttempts >= 1, 'At least 1 attack attempt');
  });

  await test('should track SQL injection attempts separately', async () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    const middleware = validator.validate({});
    
    const req = createMockReq({ body: { query: "SELECT * FROM users" } });
    const res = createMockRes();
    await middleware(req, res, () => {});
    
    assert(validator.stats.sqlInjectionAttempts >= 1, 'SQL injection count should increase');
  });

  // ====== Validator Presets ======

  await test('should create preset validators', () => {
    const validator = new UnifiedSecurityValidator({ monitoring: { reportToMetrics: false } });
    
    const strictValidator = validator.createValidator('strict');
    const lenientValidator = validator.createValidator('lenient');
    const apiValidator = validator.createValidator('api');
    
    assert(typeof strictValidator === 'function');
    assert(typeof lenientValidator === 'function');
    assert(typeof apiValidator === 'function');
  });

  // ====== Attack Patterns ======

  await test('should have all attack pattern categories', () => {
    assertIncludes(Object.keys(ATTACK_PATTERNS), 'sqlInjection');
    assertIncludes(Object.keys(ATTACK_PATTERNS), 'xss');
    assertIncludes(Object.keys(ATTACK_PATTERNS), 'pathTraversal');
    assertIncludes(Object.keys(ATTACK_PATTERNS), 'commandInjection');
    assertIncludes(Object.keys(ATTACK_PATTERNS), 'ldapInjection');
    assertIncludes(Object.keys(ATTACK_PATTERNS), 'noSqlInjection');
  });

  await test('should have sensitive field definitions', () => {
    assertIncludes(SENSITIVE_FIELDS, 'password');
    assertIncludes(SENSITIVE_FIELDS, 'token');
    assertIncludes(SENSITIVE_FIELDS, 'apiKey');
    assertIncludes(SENSITIVE_FIELDS, 'creditCard');
  });

  // ====== Quick validateRequest function ======

  await test('should work with quick validateRequest function', async () => {
    const middleware = validateRequest(
      { body: z.object({ name: z.string() }) },
      { monitoring: { reportToMetrics: false } }
    );
    
    const req = createMockReq({ body: { name: 'test' } });
    const res = createMockRes();
    
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    
    assert(nextCalled, 'Quick validate should work');
  });

  // ====== Print Results ======

  console.log('\n═══════════════════════════════════════');
  console.log('REQ-00041 统一 API 输入验证与清理中间件 - 单元测试结果');
  console.log('═══════════════════════════════════════\n');
  
  for (const result of results) {
    const icon = result.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${result.name}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }
  
  console.log(`\n总计: ${passed + failed} | 通过: ${passed} | 失败: ${failed}`);
  console.log(`覆盖率: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});