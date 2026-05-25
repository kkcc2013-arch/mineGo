// tests/unit/auth.test.js
'use strict';
process.env.JWT_ACCESS_SECRET  = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const jwt = require('jsonwebtoken');

// Mirror auth logic inline (no dep on shared module filesystem)
function signAccess(payload) {
  return jwt.sign(payload, process.env.JWT_ACCESS_SECRET, { expiresIn: '24h', algorithm: 'HS256' });
}
function signRefresh(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d', algorithm: 'HS256' });
}
function verifyAccess(token) {
  return jwt.verify(token, process.env.JWT_ACCESS_SECRET);
}
function verifyRefresh(token) {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
}

// ── Minimal test runner ───────────────────────────────────────
let passed = 0, failed = 0;
function test(desc, fn) {
  try { fn(); console.log(`  ✓ ${desc}`); passed++; }
  catch (e) { console.error(`  ✗ ${desc}\n    ${e.message}`); failed++; }
}
function expect(val) {
  return {
    toBe: (e) => { if (val !== e) throw new Error(`Expected ${e}, got ${val}`); },
    toEqual: (e) => { if (JSON.stringify(val) !== JSON.stringify(e)) throw new Error(`Not equal`); },
    toBeTruthy: () => { if (!val) throw new Error(`Expected truthy, got ${val}`); },
    toBeFalsy:  () => { if (val) throw new Error(`Expected falsy, got ${val}`); },
    toContain: (s) => { if (!val.includes(s)) throw new Error(`"${val}" does not contain "${s}"`); },
    toThrow: () => {
      if (typeof val !== 'function') throw new Error('toThrow requires a function');
      let threw = false;
      try { val(); } catch { threw = true; }
      if (!threw) throw new Error('Expected function to throw');
    },
  };
}

console.log('\n[JWT Auth Tests]');

test('signAccess creates a valid JWT string', () => {
  const token = signAccess({ sub: 'user-123', nickname: 'test', level: 10 });
  expect(typeof token).toBe('string');
  expect(token.split('.').length).toBe(3);
});

test('verifyAccess decodes correct payload', () => {
  const payload = { sub: 'user-abc', nickname: 'trainer', level: 25 };
  const token   = signAccess(payload);
  const decoded = verifyAccess(token);
  expect(decoded.sub).toBe('user-abc');
  expect(decoded.nickname).toBe('trainer');
  expect(decoded.level).toBe(25);
});

test('verifyAccess throws on tampered token', () => {
  const token = signAccess({ sub: 'user-123' });
  const parts = token.split('.');
  // Tamper payload
  const fakePayload = Buffer.from(JSON.stringify({ sub: 'user-HACKED', level: 50 })).toString('base64url');
  const tampered = `${parts[0]}.${fakePayload}.${parts[2]}`;
  expect(() => verifyAccess(tampered)).toThrow();
});

test('verifyAccess throws on wrong secret', () => {
  const token = jwt.sign({ sub: 'user-123' }, 'wrong-secret', { algorithm: 'HS256' });
  expect(() => verifyAccess(token)).toThrow();
});

test('verifyRefresh decodes correct payload', () => {
  const token   = signRefresh({ sub: 'user-xyz' });
  const decoded = verifyRefresh(token);
  expect(decoded.sub).toBe('user-xyz');
});

test('Access token and refresh token are different', () => {
  const payload = { sub: 'user-123' };
  const at = signAccess(payload);
  const rt = signRefresh(payload);
  expect(at === rt).toBe(false);
});

test('Expired token throws TokenExpiredError', () => {
  const token = jwt.sign({ sub: 'user-123' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '0s' });
  let errorName = '';
  try { verifyAccess(token); }
  catch (e) { errorName = e.name; }
  expect(errorName).toBe('TokenExpiredError');
});

test('Token contains issued-at timestamp', () => {
  const token   = signAccess({ sub: 'user-123' });
  const decoded = verifyAccess(token);
  expect(typeof decoded.iat).toBe('number');
  expect(decoded.iat).toBeTruthy();
});

test('Token expiry (exp) is about 24h from now', () => {
  const token   = signAccess({ sub: 'user-123' });
  const decoded = verifyAccess(token);
  const ttl     = decoded.exp - decoded.iat;
  const diff    = Math.abs(ttl - 86400);
  if (diff > 5) throw new Error(`Expected TTL ~86400s, got ${ttl}`);
});

// ── Auth Middleware Simulation ────────────────────────────────
console.log('\n[Auth Middleware Simulation Tests]');

function simulateAuthMiddleware(headerValue) {
  if (!headerValue || !headerValue.startsWith('Bearer ')) {
    return { status: 401, code: 1002, message: '未认证' };
  }
  const token = headerValue.slice(7);
  try {
    const user = verifyAccess(token);
    return { status: 200, user };
  } catch (e) {
    const expired = e.name === 'TokenExpiredError';
    return { status: 401, code: expired ? 1003 : 1002 };
  }
}

test('Valid bearer token is accepted', () => {
  const token  = signAccess({ sub: 'user-1', level: 5 });
  const result = simulateAuthMiddleware(`Bearer ${token}`);
  expect(result.status).toBe(200);
  expect(result.user.sub).toBe('user-1');
});

test('Missing Authorization header is rejected with 401', () => {
  const result = simulateAuthMiddleware(undefined);
  expect(result.status).toBe(401);
  expect(result.code).toBe(1002);
});

test('Non-bearer auth scheme is rejected', () => {
  const result = simulateAuthMiddleware('Basic dXNlcjpwYXNz');
  expect(result.status).toBe(401);
});

test('Expired token returns code 1003', () => {
  const token  = jwt.sign({ sub: 'user-1' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '0s' });
  const result = simulateAuthMiddleware(`Bearer ${token}`);
  expect(result.status).toBe(401);
  expect(result.code).toBe(1003);
});

test('Tampered token is rejected', () => {
  const token  = signAccess({ sub: 'user-1' });
  const tampered = token.slice(0, -5) + 'XXXXX';
  const result = simulateAuthMiddleware(`Bearer ${tampered}`);
  expect(result.status).toBe(401);
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
