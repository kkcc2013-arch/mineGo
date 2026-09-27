/**
 * REQ-00383：捕捉奖励 outbox 行 → 批量写入参数（纯函数）
 *
 * 与同步路径 handleCatch 的逐条语句逐项等价（同一批 N 次捕捉聚合后的最终状态相同）：
 *   users:            xp += Σxp, stardust += Σstardust
 *   candy_inventory:  (user, species) amount += Σcandy（不存在则插入）
 *   pokedex_entries:  不存在则插入 seen=1, caught=n, first_caught_at=最早捕捉时间, best_cp=max, has_shiny=any；
 *                     存在则 caught += n, best_cp = GREATEST, has_shiny = OR（seen 不变，与同步路径一致）
 *   user_achievements catch_total: current_value += n（仅当 outbox 行 achievement=true，见 catchPersistence 的对齐说明）
 * 输出按 user_id / species_id 排序，保证多个 applier 并发时加锁顺序一致（避免死锁）。
 */
'use strict';

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function aggregateRewardRows(rows) {
  const users = new Map();
  const candy = new Map();
  const dex = new Map();
  const ach = new Map();
  for (const r of rows || []) {
    const userId = String(r.user_id ?? r.userId);
    const speciesId = Number(r.species_id ?? r.speciesId);
    const xp = Number(r.xp || 0);
    const stardust = Number(r.stardust || 0);
    const c = Number(r.candy || 0);
    const cp = Number(r.cp || 0);
    const shiny = r.is_shiny === true || r.isShiny === true;
    const caughtAt = new Date(r.caught_at ?? r.caughtAt ?? r.created_at ?? Date.now());

    const u = users.get(userId) || { userId, xp: 0, stardust: 0 };
    u.xp += xp; u.stardust += stardust;
    users.set(userId, u);

    if (Number.isInteger(speciesId)) {
      const k = `${userId}:${speciesId}`;
      if (c > 0) {
        const cc = candy.get(k) || { userId, speciesId, amount: 0 };
        cc.amount += c;
        candy.set(k, cc);
      }
      const d = dex.get(k) || { userId, speciesId, count: 0, bestCp: 0, shiny: false, firstCaughtAt: caughtAt };
      d.count += 1;
      d.bestCp = Math.max(d.bestCp, cp);
      d.shiny = d.shiny || shiny;
      if (caughtAt < d.firstCaughtAt) d.firstCaughtAt = caughtAt;
      dex.set(k, d);
    }

    if (r.achievement !== false && r.count_achievement !== false) {
      ach.set(userId, (ach.get(userId) || 0) + 1);
    }
  }
  const byUser = (a, b) => cmp(a.userId, b.userId);
  const byUserSpecies = (a, b) => cmp(a.userId, b.userId) || (a.speciesId - b.speciesId);
  return {
    users: [...users.values()].filter((u) => u.xp || u.stardust).sort(byUser),
    candy: [...candy.values()].sort(byUserSpecies),
    pokedex: [...dex.values()].sort(byUserSpecies),
    achievements: [...ach.entries()].map(([userId, count]) => ({ userId, count })).sort(byUser),
  };
}

/** 转为 UNNEST 数组参数 */
function toUnnestParams(agg) {
  return {
    users: [agg.users.map((u) => u.userId), agg.users.map((u) => u.xp), agg.users.map((u) => u.stardust)],
    candy: [agg.candy.map((c) => c.userId), agg.candy.map((c) => c.speciesId), agg.candy.map((c) => c.amount)],
    pokedex: [agg.pokedex.map((d) => d.userId), agg.pokedex.map((d) => d.speciesId), agg.pokedex.map((d) => d.count),
      agg.pokedex.map((d) => d.bestCp), agg.pokedex.map((d) => d.shiny), agg.pokedex.map((d) => d.firstCaughtAt.toISOString())],
    achievements: [agg.achievements.map((a) => a.userId), agg.achievements.map((a) => a.count)],
  };
}

module.exports = { aggregateRewardRows, toUnnestParams };
