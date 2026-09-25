'use strict';

// REQ-00425：新设备登录安全通知
const test = require('node:test');
const assert = require('node:assert/strict');
const sec = require('../../shared/securityNotifier');

function fakeRedis() {
  const sets = new Map();
  return {
    async scard(k) { return (sets.get(k) || new Set()).size; },
    async sadd(k, v) { const s = sets.get(k) || new Set(); const had = s.has(v); s.add(v); sets.set(k, s); return had ? 0 : 1; },
    async expire() { return 1; },
  };
}

test('首次登录只记录设备；同一设备再次登录不提醒；新设备登录生成安全消息（IP 打码）', async () => {
  const notes = [];
  const deps = { redis: fakeRedis(), db: {}, center: { notify: async (q, userId, n) => { notes.push({ userId, n }); return { created: true }; } } };
  const phone = { userAgent: 'iPhone Safari', deviceType: 'ios', deviceName: 'Ash 的 iPhone', ip: '::ffff:10.1.2.3' };
  assert.deepEqual(await sec.onLogin('u1', phone, deps), { notified: false, firstDevice: true });
  assert.deepEqual(await sec.onLogin('u1', phone, deps), { notified: false, firstDevice: false });
  const r = await sec.onLogin('u1', { userAgent: 'Android Chrome', deviceType: 'android', ip: '203.0.113.9' }, deps);
  assert.equal(r.notified, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].n.category, 'security');
  assert.equal(notes[0].n.type, 'security.login_new_device');
  assert.equal(notes[0].n.params.location, '203.0.113.*');
  assert.equal(notes[0].n.params.device_name, 'Android Chrome');
});

test('IP 打码与设备指纹', () => {
  assert.equal(sec.maskIp('192.168.1.20'), '192.168.1.*');
  assert.equal(sec.maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:*');
  assert.equal(sec.maskIp(''), '未知位置');
  assert.equal(sec.deviceKey({ userAgent: 'a' }), sec.deviceKey({ userAgent: 'a' }));
  assert.notEqual(sec.deviceKey({ userAgent: 'a' }), sec.deviceKey({ userAgent: 'b' }));
});
