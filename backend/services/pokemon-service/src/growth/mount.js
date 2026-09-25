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
const staminaRules = require('./staminaRules');

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
  app.use('/pokemon/training-camp', require('../routes/trainingCamp'));
  app.use('/pokemon/breeding', require('../routes/breeding'));
  app.use('/pokemon/merge', require('../routes/merge'));
  app.use('/pokemon', require('../routes/specialTraining'));
  app.use('/pokemon', require('../routes/awakening'));
  app.use('/pokemon', require('../routes/inheritance'));

  every('inheritance-pool-purge', 6 * 3600 * 1000, async () => {
    const n = await require('../inheritanceService').purgeExpired();
    if (n) logger.info({ purged: n }, 'expired inheritance pools purged');
  }, logger);

  every('exp-history-partitions', 24 * 3600 * 1000, async () => {
    await query('SELECT ensure_pokemon_exp_history_partitions(2)');
  }, logger);

  // 体力：疲劳影响经验倍率；自然恢复每 5 分钟落库一次（读接口本身按时间惰性换算，不依赖此任务）
  require('../../../../shared/pokemonExperience').setFatigueResolver((p) => staminaRules.expMultiplier(p));
  // 训练营：到点的训练标记完成并发站内通知
  every('training-camp-ready', 60 * 1000, async () => {
    const n = await require('../trainingCampService').markReady();
    if (n) logger.info({ ready: n }, 'training camp slots ready');
  }, logger);

  every('stamina-natural-recovery', 5 * 60 * 1000, async () => {
    const n = await require('../staminaService').naturalRecoveryTick();
    if (n) logger.info({ updated: n }, 'stamina natural recovery');
  }, logger);
}

function stopGrowthJobs() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
}

module.exports = { mountGrowth, stopGrowthJobs, every };
