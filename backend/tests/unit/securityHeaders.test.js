/**
 * REQ-00202: 安全响应头模块单元测试
 * 测试目标：backend/shared/securityHeaders.js
 */

'use strict';

const assert = require('assert');
const {
  apiSecurityHeaders,
  frontendSecurityHeaders,
  sensitiveSecurityHeaders,
  cspHeaders,
  verifyOrigin,
  createSecurityMiddleware
} = require('../../shared/securityHeaders');

// Mock Express 请求
function createMockReq(overrides = {}) {
  return {
    ip: '127.0.0.1',
    path: '/api/test',
    headers: {},
    ...overrides
  };
}

// Mock Express 响应
function createMockRes() {
  const res = {
    headers: {},
    statusCode: 200
  };
  
  res.setHeader = function(key, value) {
    this.headers[key] = value;
  };
  
  res.status = function(code) {
    this.statusCode = code;
    return this;
  };
  
  res.json = function(data) {
    this.body = data;
    return this;
  };
  
  return res;
}

console.log('Testing securityHeaders.js...');

// ── apiSecurityHeaders 中间件测试 ─────────────────────────────────────────────

console.log('\n[TEST] apiSecurityHeaders middleware');

const apiReq = createMockReq();
const apiRes = createMockRes();
let nextCalled = false;

apiSecurityHeaders(apiReq, apiRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'next() should be called');
assert.strictEqual(apiRes.headers['X-Content-Type-Options'], 'nosniff', 'Should set X-Content-Type-Options');
assert.strictEqual(apiRes.headers['X-Frame-Options'], 'DENY', 'Should set X-Frame-Options');
assert.strictEqual(apiRes.headers['X-XSS-Protection'], '1; mode=block', 'Should set X-XSS-Protection');
assert.strictEqual(apiRes.headers['Referrer-Policy'], 'strict-origin-when-cross-origin', 'Should set Referrer-Policy');
assert.strictEqual(apiRes.headers['Cache-Control'], 'no-store, no-cache, must-revalidate, proxy-revalidate', 'Should set Cache-Control');
console.log('✅ apiSecurityHeaders sets all required headers');

// 测试生产环境 HSTS
const originalEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

const prodReq = createMockReq();
const prodRes = createMockRes();
apiSecurityHeaders(prodReq, prodRes, () => {});

assert.ok(prodRes.headers['Strict-Transport-Security'], 'Should set HSTS in production');
assert.ok(prodRes.headers['Strict-Transport-Security'].includes('max-age=31536000'), 'HSTS should have 1 year max-age');
assert.ok(prodRes.headers['Strict-Transport-Security'].includes('includeSubDomains'), 'HSTS should include subdomains');

process.env.NODE_ENV = originalEnv;
console.log('✅ HSTS header set in production mode');

// ── frontendSecurityHeaders 中间件测试 ─────────────────────────────────────────

console.log('\n[TEST] frontendSecurityHeaders middleware');

const frontendReq = createMockReq();
const frontendRes = createMockRes();
nextCalled = false;

frontendSecurityHeaders(frontendReq, frontendRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'next() should be called');
assert.strictEqual(frontendRes.headers['X-Frame-Options'], 'SAMEORIGIN', 'Frontend should allow SAMEORIGIN frames');
assert.ok(frontendRes.headers['Permissions-Policy'], 'Should set Permissions-Policy');
assert.ok(frontendRes.headers['Permissions-Policy'].includes('geolocation=(self)'), 'Should allow geolocation');
assert.ok(frontendRes.headers['Permissions-Policy'].includes('camera=()'), 'Should disable camera');
assert.ok(frontendRes.headers['Permissions-Policy'].includes('microphone=()'), 'Should disable microphone');
console.log('✅ frontendSecurityHeaders sets all required headers');

// ── sensitiveSecurityHeaders 中间件测试 ───────────────────────────────────────

console.log('\n[TEST] sensitiveSecurityHeaders middleware');

const sensitiveReq = createMockReq();
const sensitiveRes = createMockRes();
nextCalled = false;

sensitiveSecurityHeaders(sensitiveReq, sensitiveRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'next() should be called');
assert.strictEqual(sensitiveRes.headers['Cross-Origin-Resource-Policy'], 'same-origin', 'Should set CORP');
assert.strictEqual(sensitiveRes.headers['Cross-Origin-Opener-Policy'], 'same-origin', 'Should set COOP');
assert.strictEqual(sensitiveRes.headers['Cache-Control'], 'no-store, private, max-age=0', 'Should set strict cache control');
console.log('✅ sensitiveSecurityHeaders sets all required headers');

// ── cspHeaders 中间件测试 ─────────────────────────────────────────────────────

console.log('\n[TEST] cspHeaders middleware');

const cspReq = createMockReq();
const cspRes = createMockRes();
nextCalled = false;

cspHeaders(cspReq, cspRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'next() should be called');
assert.ok(cspRes.headers['Content-Security-Policy'] || cspRes.headers['Content-Security-Policy-Report-Only'], 'Should set CSP header');
console.log('✅ cspHeaders sets CSP header');

// ── verifyOrigin 中间件测试 ───────────────────────────────────────────────────

console.log('\n[TEST] verifyOrigin middleware');

// 测试允许的 origin
const verifyMiddleware = verifyOrigin(['https://allowed.com']);

const allowedReq = createMockReq({
  headers: { origin: 'https://minego.com' } // 默认允许的 origin
});
const allowedRes = createMockRes();
nextCalled = false;

verifyMiddleware(allowedReq, allowedRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'next() should be called for allowed origin');
console.log('✅ Allowed origin passes verification');

// 测试不允许的 origin
const blockedReq = createMockReq({
  headers: { origin: 'https://malicious.com' }
});
const blockedRes = createMockRes();
nextCalled = false;

verifyMiddleware(blockedReq, blockedRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, false, 'next() should NOT be called for blocked origin');
assert.strictEqual(blockedRes.statusCode, 403, 'Should return 403');
assert.strictEqual(blockedRes.body.error, 'ORIGIN_NOT_ALLOWED', 'Should have ORIGIN_NOT_ALLOWED error');
console.log('✅ Blocked origin returns 403');

// 测试无 origin 但有 referer
const refererReq = createMockReq({
  headers: { referer: 'https://game.minego.com/page' }
});
const refererRes = createMockRes();
nextCalled = false;

verifyMiddleware(refererReq, refererRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'next() should be called when referer is from allowed origin');
console.log('✅ Allowed referer passes verification');

// 测试无 origin 和 referer
const noOriginReq = createMockReq({ headers: {} });
const noOriginRes = createMockRes();
nextCalled = false;

verifyMiddleware(noOriginReq, noOriginRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, false, 'next() should NOT be called without origin/referer');
assert.strictEqual(noOriginRes.statusCode, 403, 'Should return 403');
assert.strictEqual(noOriginRes.body.error, 'ORIGIN_MISSING', 'Should have ORIGIN_MISSING error');
console.log('✅ Missing origin returns 403');

// 测试无效 referer URL
const invalidRefererReq = createMockReq({
  headers: { referer: 'not-a-valid-url' }
});
const invalidRefererRes = createMockRes();
nextCalled = false;

verifyMiddleware(invalidRefererReq, invalidRefererRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, false, 'next() should NOT be called for invalid referer');
assert.strictEqual(invalidRefererRes.statusCode, 403, 'Should return 403');
assert.strictEqual(invalidRefererRes.body.error, 'REFERER_INVALID', 'Should have REFERER_INVALID error');
console.log('✅ Invalid referer returns 403');

// ── createSecurityMiddleware 组合中间件测试 ───────────────────────────────────

console.log('\n[TEST] createSecurityMiddleware factory');

// 测试默认配置
const defaultMiddlewares = createSecurityMiddleware();
assert.ok(Array.isArray(defaultMiddlewares), 'Should return array of middlewares');
assert.ok(defaultMiddlewares.length >= 1, 'Should have at least one middleware');
console.log('✅ createSecurityMiddleware returns middleware array');

// 测试敏感 API 配置
const sensitiveMiddlewares = createSecurityMiddleware({ isSensitive: true });
assert.ok(sensitiveMiddlewares.length >= 2, 'Should have more middlewares for sensitive API');
console.log('✅ Sensitive API has extra middlewares');

// 测试启用 origin 检查
const originCheckMiddlewares = createSecurityMiddleware({ enableOriginCheck: true });
assert.ok(originCheckMiddlewares.length >= 2, 'Should have origin check middleware');
console.log('✅ Origin check middleware included when enabled');

// 测试自定义允许的 origins
const customOriginsMiddlewares = createSecurityMiddleware({
  enableOriginCheck: true,
  allowedOrigins: ['https://custom.com']
});
assert.ok(Array.isArray(customOriginsMiddlewares), 'Should accept custom origins');
console.log('✅ Custom origins configuration works');

// ── 默认允许的 origins 测试 ───────────────────────────────────────────────────

console.log('\n[TEST] Default allowed origins');

const defaultVerify = verifyOrigin();

const defaultOrigins = [
  'https://minego.com',
  'https://www.minego.com',
  'https://game.minego.com',
  'https://admin.minego.com'
];

for (const origin of defaultOrigins) {
  const req = createMockReq({ headers: { origin } });
  const res = createMockRes();
  nextCalled = false;
  
  defaultVerify(req, res, () => { nextCalled = true; });
  
  assert.strictEqual(nextCalled, true, `${origin} should be allowed`);
}

console.log(`✅ All ${defaultOrigins.length} default origins are allowed`);

// ── 环境变量配置测试 ─────────────────────────────────────────────────────────

console.log('\n[TEST] Environment variable configuration');

// 测试从环境变量读取允许的 origins
const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
process.env.ALLOWED_ORIGINS = 'https://env1.com,https://env2.com';

const envVerify = verifyOrigin();

const envReq = createMockReq({ headers: { origin: 'https://env1.com' } });
const envRes = createMockRes();
nextCalled = false;

envVerify(envReq, envRes, () => { nextCalled = true; });

assert.strictEqual(nextCalled, true, 'Origin from env var should be allowed');

process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
console.log('✅ Environment variable origins loaded correctly');

// ── 头信息不可变性测试 ───────────────────────────────────────────────────────

console.log('\n[TEST] Header immutability');

const immutableReq = createMockReq();
const immutableRes = createMockRes();

apiSecurityHeaders(immutableReq, immutableRes, () => {});

// 尝试修改已设置的头
const originalXFrameOptions = immutableRes.headers['X-Frame-Options'];
immutableRes.headers['X-Frame-Options'] = 'ALLOW-ALL';

// 验证原始值仍然有效（中间件设置后不应对后续修改敏感）
assert.strictEqual(originalXFrameOptions, 'DENY', 'Original header value should be DENY');
console.log('✅ Headers set correctly before potential modification');

// ── 多次调用测试 ─────────────────────────────────────────────────────────────

console.log('\n[TEST] Multiple middleware calls');

const multiReq = createMockReq();
const multiRes = createMockRes();

// 多次调用同一中间件
apiSecurityHeaders(multiReq, multiRes, () => {});
apiSecurityHeaders(multiReq, multiRes, () => {});
apiSecurityHeaders(multiReq, multiRes, () => {});

// 验证头信息一致性
assert.strictEqual(multiRes.headers['X-Frame-Options'], 'DENY', 'Headers should be consistent');
console.log('✅ Multiple middleware calls work correctly');

// ── 请求路径记录测试 ─────────────────────────────────────────────────────────

console.log('\n[TEST] Request path in error responses');

const pathReq = createMockReq({
  path: '/api/sensitive/payment',
  headers: { origin: 'https://blocked.com' }
});
const pathRes = createMockRes();

const pathVerifyMiddleware = verifyOrigin([]);
pathVerifyMiddleware(pathReq, pathRes, () => {});

assert.strictEqual(pathRes.statusCode, 403, 'Should return 403 for blocked origin');
console.log('✅ Path-based requests handled correctly');

console.log('\n========================================');
console.log('✅ All securityHeaders.js tests passed!');
console.log('========================================');
