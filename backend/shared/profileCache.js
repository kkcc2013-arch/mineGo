/**
 * 玩家资料相关缓存的版本号（REQ-00327 / REQ-00387："资料数据变更后缓存正确更新"）
 *
 * 资料卡、统计摘要等缓存键里带上 profile:ver:<userId>；资料配置/称号/成就/收藏室变化时 bump，
 * 所有查看者（包括他人）读到的旧缓存立即失效，无需逐键删除。Redis 不可用时降级为不缓存。
 */
'use strict';

const { getRedis } = require('./redis');

const VERSION_TTL = 30 * 86400;

async function bump(userId) {
  if (!userId) return;
  try {
    const r = getRedis();
    await r.incr(`profile:ver:${userId}`);
    await r.expire(`profile:ver:${userId}`, VERSION_TTL);
  } catch { /* Redis 不可用：缓存条目随 TTL 过期 */ }
}

async function version(userId) {
  try { return (await getRedis().get(`profile:ver:${userId}`)) || '0'; } catch { return null; }
}

/**
 * 读缓存，未命中时计算并写入
 * @param {string} key   不含版本号的键
 * @param {string} userId  版本归属玩家
 * @param {number} ttlSec
 * @param {() => Promise<any>} compute
 * @returns {Promise<{value: any, hit: boolean}>}
 */
async function cached(key, userId, ttlSec, compute) {
  const ver = await version(userId);
  if (ver === null) return { value: await compute(), hit: false };
  const fullKey = `${key}:v${ver}`;
  try {
    const raw = await getRedis().get(fullKey);
    if (raw) return { value: JSON.parse(raw), hit: true };
  } catch { /* 读失败按未命中处理 */ }
  const value = await compute();
  try { await getRedis().setex(fullKey, ttlSec, JSON.stringify(value)); } catch { /* 忽略 */ }
  return { value, hit: false };
}

module.exports = { bump, version, cached };
