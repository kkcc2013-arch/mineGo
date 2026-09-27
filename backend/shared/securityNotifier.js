/**
 * 安全通知（REQ-00425 安全类消息：新设备登录）
 *
 * 登录成功后调用：以 User-Agent + 设备类型的哈希识别设备，Redis 记录该玩家见过的设备（180 天）；
 * 已有登录记录的玩家在新设备登录时生成 security.login_new_device 站内消息（安全类为强制接收，不受偏好关闭影响）。
 * 首次登录（没有任何已知设备）只记录不提醒。Redis 不可用时跳过，不影响登录。
 */
'use strict';

const crypto = require('crypto');

function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/\.\d+$/, '.*');
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}:*`;
  return '未知位置';
}

function deviceKey({ userAgent, deviceType, deviceName }) {
  return crypto.createHash('sha256').update(`${deviceType || ''}|${deviceName || ''}|${userAgent || ''}`).digest('hex').slice(0, 32);
}

async function onLogin(userId, { userAgent, deviceType, deviceName, ip } = {}, deps = {}) {
  const redis = deps.redis || require('./redis').getRedis();
  const center = deps.center || require('./notificationCenter');
  const db = deps.db || require('./db');
  const key = `security:devices:${userId}`;
  const dev = deviceKey({ userAgent, deviceType, deviceName });
  const known = await redis.scard(key);
  const added = await redis.sadd(key, dev);
  await redis.expire(key, 180 * 86400);
  if (!known || !added) return { notified: false, firstDevice: !known };
  const name = String(deviceName && deviceName !== 'Unknown' ? deviceName : (userAgent || '未知设备')).slice(0, 60);
  await center.notify(db, userId, {
    type: 'security.login_new_device', templateKey: 'new_device_login', category: 'security', priority: 'high',
    params: { device_name: name, location: maskIp(ip) }, data: { device: dev, at: new Date().toISOString() },
    actionUrl: '/sessions', dedupeKey: `newdev:${dev}`,
  });
  return { notified: true };
}

module.exports = { onLogin, maskIp, deviceKey };
