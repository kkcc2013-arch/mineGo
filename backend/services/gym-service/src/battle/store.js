// 进行中战斗的状态存储：Redis JSON（TTL 10 分钟，每回合续期），多实例共享；
// 回合互斥锁防止同一场战斗被并发提交（重复点击/脚本并发刷回合）。
'use strict';

const crypto = require('crypto');
const { getRedis } = require('../../../../shared/redis');
const { BattleError } = require('./engine');

const TTL_SEC = Number(process.env.BATTLE_TTL_SEC || 600);
const LOCK_MS = 5000;
const key = (id) => `battle:state:${id}`;
const activeKey = (userId) => `battle:active:${userId}`;

async function save(state) {
  const r = getRedis();
  await r.multi()
    .set(key(state.id), JSON.stringify(state), 'EX', TTL_SEC)
    .set(activeKey(state.userId), state.id, 'EX', TTL_SEC)
    .exec();
}

async function load(id) {
  const raw = await getRedis().get(key(id));
  return raw ? JSON.parse(raw) : null;
}

async function remove(state) {
  const r = getRedis();
  await r.del(key(state.id));
  // 只删除仍指向本场的 active 指针
  const cur = await r.get(activeKey(state.userId));
  if (cur === state.id) await r.del(activeKey(state.userId));
}

async function activeBattleId(userId) {
  return getRedis().get(activeKey(userId));
}

/** 获取战斗锁并执行 fn；锁被占用时返回 409 */
async function withLock(id, fn) {
  const r = getRedis();
  const token = crypto.randomBytes(8).toString('hex');
  const lk = `battle:lock:${id}`;
  const ok = await r.set(lk, token, 'PX', LOCK_MS, 'NX');
  if (!ok) throw new BattleError('BATTLE_BUSY', '上一个操作仍在处理中', 409);
  try {
    return await fn();
  } finally {
    // 仅释放自己持有的锁
    await r.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lk, token).catch(() => {});
  }
}

module.exports = { save, load, remove, activeBattleId, withLock, TTL_SEC };
