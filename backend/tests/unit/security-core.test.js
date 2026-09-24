// tests/unit/security-core.test.js
// 直接测试真实模块（不是把逻辑复制进测试文件）：shared/fieldCrypto、shared/auth
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const hex = () => crypto.randomBytes(32).toString('hex');
process.env.JWT_ACCESS_SECRET = 'unit-access-secret';
process.env.JWT_REFRESH_SECRET = 'unit-refresh-secret';

const fieldCrypto = require('../../shared/fieldCrypto');
const auth = require('../../shared/auth');

test('fieldCrypto: 未配置密钥时 isEnabled 为 false', () => {
  delete process.env.FIELD_ENCRYPTION_KEYS;
  delete process.env.FIELD_ENCRYPTION_ACTIVE_KID;
  delete process.env.FIELD_HASH_KEY;
  assert.equal(fieldCrypto.isEnabled(), false);
  assert.equal(fieldCrypto.decrypt('13800000000', 'users.phone'), '13800000000', '明文原样返回');
});

test('fieldCrypto: 加密/解密往返，密文随机，AAD 绑定上下文', () => {
  process.env.FIELD_ENCRYPTION_KEYS = `k1:${hex()}`;
  process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k1';
  process.env.FIELD_HASH_KEY = hex();
  assert.equal(fieldCrypto.isEnabled(), true);
  const a = fieldCrypto.encrypt('13800138000', 'users.phone');
  const b = fieldCrypto.encrypt('13800138000', 'users.phone');
  assert.ok(a.startsWith('enc:v1:k1:'));
  assert.notEqual(a, b, '非确定性加密');
  assert.ok(!a.includes('13800138000'));
  assert.equal(fieldCrypto.decrypt(a, 'users.phone'), '13800138000');
  assert.throws(() => fieldCrypto.decrypt(a, 'users.email'), '错误上下文无法解密');
});

test('fieldCrypto: 篡改密文会被 GCM 认证标签拒绝', () => {
  const c = fieldCrypto.encrypt('13800138000', 'users.phone');
  const raw = Buffer.from(c.split(':')[3], 'base64');
  raw[raw.length - 1] ^= 1;
  const tampered = `enc:v1:k1:${raw.toString('base64')}`;
  assert.throws(() => fieldCrypto.decrypt(tampered, 'users.phone'));
});

test('fieldCrypto: 盲索引确定性、区分上下文、64 位 hex', () => {
  const h1 = fieldCrypto.blindIndex('13800138000', 'users.phone');
  assert.equal(h1, fieldCrypto.blindIndex(' 13800138000 ', 'users.phone'));
  assert.notEqual(h1, fieldCrypto.blindIndex('13800138000', 'users.other'));
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('fieldCrypto: 密钥轮换后旧密文仍可解密，新密文使用新 kid', () => {
  const k1 = process.env.FIELD_ENCRYPTION_KEYS;
  const old = fieldCrypto.encrypt('13900000000', 'users.phone');
  process.env.FIELD_ENCRYPTION_KEYS = `${k1},k2:${hex()}`;
  process.env.FIELD_ENCRYPTION_ACTIVE_KID = 'k2';
  assert.equal(fieldCrypto.decrypt(old, 'users.phone'), '13900000000');
  const fresh = fieldCrypto.encrypt('13900000000', 'users.phone');
  assert.equal(fieldCrypto.keyIdOf(fresh), 'k2');
  assert.equal(fieldCrypto.keyIdOf(old), 'k1');
});

test('auth: payload 自带 exp/iat 时签发不再抛错（原注册/登录 500 的根因）', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = auth.signAccess({ sub: 'u-1', iat: now, exp: now + 60, jti: 'j' });
  const p = auth.verifyAccess(token);
  assert.equal(p.sub, 'u-1');
  assert.ok(p.exp > now + 3600, 'exp 由 JWT_ACCESS_TTL 决定');
});

test('auth: requireAuth 注入 req.user.id = sub', () => {
  const token = auth.signAccess({ sub: 'user-42' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  let err;
  auth.requireAuth(req, {}, (e) => { err = e; });
  assert.equal(err, undefined);
  assert.equal(req.user.id, 'user-42');
});

test('auth: requireAdmin 仅放行 roles 含 admin 的用户', () => {
  const run = (roles) => {
    let passedErr = 'not-called';
    auth.requireAdmin({ user: { sub: 'x', roles } }, {}, (e) => { passedErr = e; });
    return passedErr;
  };
  assert.equal(run(['admin']), undefined);
  assert.ok(run([]) instanceof Error);
  assert.ok(run(undefined) instanceof Error);
});

test('auth: 旧版 errorHandler 保留 4xx 状态码，Zod 错误返回 400', () => {
  const mkRes = () => {
    const r = { code: null, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };
  const r1 = mkRes();
  auth.errorHandler(Object.assign(new Error('too far'), { statusCode: 409, code: 'X' }), {}, r1, () => {});
  assert.equal(r1.code, 409);
  const r2 = mkRes();
  auth.errorHandler(Object.assign(new Error('bad'), { name: 'ZodError', issues: [] }), {}, r2, () => {});
  assert.equal(r2.code, 400);
});

// ── REQ-00042: trace id 解析与清洗 ─────────────────────────────
const traceContext = require('../../shared/traceContext');

test('traceContext: 解析 traceparent / x-trace-id，拒绝非法值', () => {
  const tid = 'a'.repeat(32);
  assert.equal(traceContext.traceIdFromHeaders({ traceparent: `00-${tid}-${'b'.repeat(16)}-01` }), tid);
  assert.equal(traceContext.traceIdFromHeaders({ 'x-trace-id': '0af76519-16cd-43dd-8448-eb211c80319c' }), '0af7651916cd43dd8448eb211c80319c');
  assert.equal(traceContext.traceIdFromHeaders({ 'x-trace-id': 'bad\nvalue"{}' }), null);
  assert.equal(traceContext.traceIdFromHeaders({ traceparent: `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01` }), null);
  assert.match(traceContext.newTraceId(), /^[0-9a-f]{32}$/);
});

test('traceContext: AsyncLocalStorage 在异步链路中保持上下文', async () => {
  const seen = await traceContext.als.run({ traceId: 't-1', requestId: 'r-1' }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return traceContext.current();
  });
  assert.deepEqual(seen, { traceId: 't-1', requestId: 'r-1' });
  assert.equal(traceContext.current(), null);
});
