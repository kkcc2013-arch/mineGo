// 战斗依赖单例：伤害服务（进程内 L1 + Redis L2）、连击判定器、能量规则
'use strict';

const { DamageService } = require('./damage');
const repo = require('./repo');
const { query } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('battle-deps');
let damage = null;
let exportTimer = null;
let subscriber = null;
const INVALIDATE_CHANNEL = 'battle:damage:invalidate';

function damageService() {
  if (!damage) {
    let redis = null;
    try { redis = getRedis(); } catch { redis = null; }
    damage = new DamageService({ redis, l1Max: Number(process.env.DAMAGE_CACHE_L1_MAX || 10000), redisTtlSec: Number(process.env.DAMAGE_CACHE_TTL_SEC || 3600) });
  }
  return damage;
}

async function getDeps(ruleName = 'standard') {
  const [combos, energyRule] = await Promise.all([repo.getComboDetector(), repo.getEnergyRule(ruleName)]);
  return { damage: damageService(), combos, energyRule };
}

/** 启动预热：技能系数 + L2 热点；并订阅跨实例的手动失效广播 */
async function warmup() {
  const ds = damageService();
  const moves = [...(await repo.getMoves()).values()];
  const { rows } = await query("SELECT DISTINCT lower(type1::text) AS t1, lower(type2::text) AS t2 FROM pokemon_species");
  const combos = rows.map((r) => [r.t1, r.t2].filter(Boolean));
  const result = await ds.warmup(moves, combos);
  if (!exportTimer) {
    exportTimer = setInterval(() => { try { ds.exportCounters(); } catch { /* ignore */ } }, 15000);
    exportTimer.unref();
  }
  if (!subscriber) {
    try {
      subscriber = getRedis().duplicate();
      await subscriber.subscribe(INVALIDATE_CHANNEL);
      subscriber.on('message', (ch) => {
        if (ch !== INVALIDATE_CHANNEL) return;
        ds.invalidate({ l2: false }).then(() => warmupCoefficientsOnly()).catch(() => {});
        repo.invalidateStaticCache();
      });
    } catch (err) {
      logger.warn({ err }, 'damage cache invalidation subscribe failed');
    }
  }
  logger.info(result, 'battle damage cache warmed up');
  return result;
}

async function warmupCoefficientsOnly() {
  const moves = [...(await repo.getMoves()).values()];
  const { rows } = await query("SELECT DISTINCT lower(type1::text) AS t1, lower(type2::text) AS t2 FROM pokemon_species");
  return damageService().warmup(moves, rows.map((r) => [r.t1, r.t2].filter(Boolean)), { loadL2: false });
}

/** 手动刷新（管理员）：清空本实例 + Redis L2，广播其他实例清空 L1，然后重新预热系数 */
async function refreshDamageCache() {
  const ds = damageService();
  repo.invalidateStaticCache();
  const r = await ds.invalidate({ l2: true });
  try { await getRedis().publish(INVALIDATE_CHANNEL, String(Date.now())); } catch { /* ignore */ }
  const w = await warmupCoefficientsOnly();
  return { ...r, rewarmed: w };
}

module.exports = { damageService, getDeps, warmup, refreshDamageCache };
