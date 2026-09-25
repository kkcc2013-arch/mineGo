/**
 * Epic E07 精灵成长：路由挂载与后台任务（index.js 只调用 mountGrowth 一处）
 *
 * 所有路由挂在 /pokemon 下，网关 /v1/pokemon/* 已统一代理并做 JWT 鉴权与用户级限流。
 * 后台任务（多实例部署时用 Redis 锁保证同一时刻只有一个实例执行）：
 *   - 每天预建经验历史的月分区
 */
'use strict';

const { query } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const evolutionService = require('../evolutionService');
const tracker = require('./growthTracker');

const timers = [];

/** 带 Redis 互斥锁的周期任务 */
function every(name, ms, fn, logger) {
  const run = async () => {
    try {
      const ok = await getRedis().set(`growth:job:${name}`, String(process.pid), 'PX', Math.max(1000, ms - 500), 'NX');
      if (!ok) return;
      await fn();
    } catch (err) {
      logger.warn({ job: name, err: err.message }, 'growth job failed');
    }
  };
  const t = setInterval(run, ms);
  t.unref();
  timers.push(t);
  setTimeout(run, 5000).unref();
}

function mountGrowth(app, logger) {
  evolutionService.onEvolved(tracker.onEvolvedMilestone);

  app.use('/pokemon', require('../routes/growth'));

  every('exp-history-partitions', 24 * 3600 * 1000, async () => {
    await query('SELECT ensure_pokemon_exp_history_partitions(2)');
  }, logger);
}

function stopGrowthJobs() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { mountGrowth, stopGrowthJobs, every };
