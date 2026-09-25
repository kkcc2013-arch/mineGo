// REQ-00369 捕捉连击：纯规则 + 服务（内存假 DB，无需 pg/Redis）
// 运行：node --test backend/tests/unit/catch-combo.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/catch-service/src/combo/comboRules');
const { CatchComboService } = require('../../services/catch-service/src/combo/CatchComboService');

const T0 = new Date('2026-09-25T10:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

// ── 纯规则 ─────────────────────────────────────────────────────
test('成功递增、30 分钟内保持、超时后从 1 重新计数并归档 timeout', () => {
  let s = rules.emptyState();
  let r = rules.applyCatchSuccess(s, { now: at(0) });
  assert.equal(r.combo, 1);
  assert.equal(r.isNewRecord, true);
  r = rules.applyCatchSuccess(r.state, { now: at(29) });
  assert.equal(r.combo, 2);
  assert.equal(r.archived, null);
  r = rules.applyCatchSuccess(r.state, { now: at(29 + 31) });
  assert.equal(r.combo, 1, '超时后重新计数');
  assert.equal(r.archived.endReason, 'timeout');
  assert.equal(r.archived.comboCount, 2);
  assert.equal(r.state.maxCombo, 2);
});

test('失败（逃跑）中断连击并归档；无连击时失败不产生历史', () => {
  let r = rules.applyCatchSuccess(rules.emptyState(), { now: at(0), pokemonId: '11111111-1111-1111-1111-111111111111' });
  r = rules.applyCatchSuccess(r.state, { now: at(1) });
  const f = rules.applyCatchFailure(r.state, { now: at(2), reason: 'failed' });
  assert.equal(f.broken, true);
  assert.equal(f.previousCombo, 2);
  assert.equal(f.state.currentCombo, 0);
  assert.equal(f.state.maxCombo, 2, '最高纪录保留');
  assert.equal(f.archived.endReason, 'failed');
  assert.deepEqual(f.archived.pokemonIds, ['11111111-1111-1111-1111-111111111111']);
  const f2 = rules.applyCatchFailure(f.state, { now: at(3) });
  assert.equal(f2.broken, false);
  assert.equal(f2.archived, null);
});

test('保护道具：失败时消耗 1 次保护，连击保留；手动重置（force）忽略保护；保护过期无效', () => {
  let s = rules.applyCatchSuccess(rules.emptyState(), { now: at(0) }).state;
  s = rules.applyCatchSuccess(s, { now: at(1) }).state;
  const p = rules.applyProtection(s, { now: at(1) });
  assert.equal(p.applied, true);
  assert.equal(p.state.protectionCharges, 1);
  const f = rules.applyCatchFailure(p.state, { now: at(2) });
  assert.equal(f.broken, false);
  assert.equal(f.protectedUsed, true);
  assert.equal(f.state.currentCombo, 2);
  assert.equal(f.state.protectionCharges, 0);
  const f2 = rules.applyCatchFailure(f.state, { now: at(3) });
  assert.equal(f2.broken, true, '保护用完后再失败就中断');

  const p2 = rules.applyProtection(s, { now: at(1) }).state;
  const forced = rules.applyCatchFailure(p2, { now: at(2), reason: 'manual_reset', force: true });
  assert.equal(forced.broken, true);
  assert.equal(forced.archived.endReason, 'manual_reset');

  const expiredProt = rules.applyCatchFailure(p2, { now: at(1 + 61) });
  assert.equal(expiredProt.broken, true, '保护 60 分钟后过期（此时连击也已超时，按 timeout 归档）');
  assert.equal(expiredProt.archived.endReason, 'timeout');
});

test('保护次数上限', () => {
  let s = rules.applyCatchSuccess(rules.emptyState(), { now: at(0) }).state;
  for (let i = 0; i < 3; i++) s = rules.applyProtection(s, { now: at(0) }).state;
  const r = rules.applyProtection(s, { now: at(0) });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'max_charges');
});

test('奖励：按最高档位 × 倍率（上限 5x），到达档位时发特殊道具，里程碑', () => {
  assert.deepEqual(rules.computeRewards(2).xp, 0, '低于最低档无奖励');
  const r3 = rules.computeRewards(3);
  assert.equal(r3.tier, 3);
  assert.equal(r3.xp, Math.floor(20 * 1.3));
  assert.equal(r3.items.length, 0);
  const r5 = rules.computeRewards(5);
  assert.equal(r5.xp, Math.floor(50 * 1.5));
  assert.deepEqual(r5.items, [{ item: 'POKE_BALL', amount: 5 }]);
  const r6 = rules.computeRewards(6);
  assert.equal(r6.items.length, 0, '只在到达档位时发道具');
  const r10 = rules.computeRewards(10);
  assert.equal(r10.coins, Math.floor(10 * Math.min(1.2 * 2, 5)));
  assert.equal(r10.milestone, 10);
  assert.deepEqual(r10.items, [{ item: 'LUCKY_EGG', amount: 1 }]);
  const r100 = rules.computeRewards(100);
  assert.equal(r100.multiplier, 5, '倍率封顶 5');
  assert.equal(r100.coins, 500);
  assert.equal(rules.computeRewards(11).milestone, null);
});

test('自定义档位（DB 行 snake_case）与 items 型档位每次都发', () => {
  const tiers = [{ combo_threshold: 2, reward_type: 'items', reward_amount: 0, bonus_multiplier: 1, special_rewards: '[{"item":"razz_berry","amount":1}]' }];
  const r = rules.computeRewards(4, tiers);
  assert.deepEqual(r.items, [{ item: 'RAZZ_BERRY', amount: 1 }]);
});

test('档位校验', () => {
  assert.equal(rules.validateTierInput([]).ok, false);
  assert.equal(rules.validateTierInput([{ threshold: 5, rewardType: 'gold', rewardAmount: 1 }]).ok, false);
  assert.equal(rules.validateTierInput([{ threshold: 5, rewardType: 'coins', rewardAmount: 1 }, { threshold: 5, rewardType: 'coins' }]).ok, false);
  const ok = rules.validateTierInput([{ threshold: 10, rewardType: 'coins', rewardAmount: 5 }, { threshold: 3, rewardType: 'experience', rewardAmount: 1 }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tiers.map((t) => t.threshold), [3, 10]);
});

test('effectiveStatus：超时后展示为 0，给出过期时间', () => {
  const s = rules.applyCatchSuccess(rules.emptyState(), { now: at(0) }).state;
  const live = rules.effectiveStatus(s, at(10));
  assert.equal(live.currentCombo, 1);
  assert.equal(live.expiresAt, at(30).toISOString());
  const dead = rules.effectiveStatus(s, at(31));
  assert.equal(dead.currentCombo, 0);
  assert.equal(dead.expired, true);
  assert.equal(dead.maxCombo, 1);
});

// ── 服务（内存假 DB）────────────────────────────────────────────
function fakeDb() {
  const db = { combos: new Map(), events: new Map(), history: [], users: new Map(), items: [], consumed: [], shields: 0 };
  const client = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO catch_combo_events')) {
        if (db.events.has(params[0])) return { rows: [] };
        db.events.set(params[0], { user: params[1] });
        return { rows: [{ session_id: params[0] }] };
      }
      if (s.startsWith('UPDATE catch_combo_events')) return { rows: [] };
      if (s.startsWith('INSERT INTO catch_combos')) { if (!db.combos.has(params[0])) db.combos.set(params[0], { user_id: params[0], current_combo: 0, max_combo: 0 }); return { rows: [] }; }
      if (s.startsWith('SELECT * FROM catch_combos')) { const r = db.combos.get(params[0]); return { rows: r ? [{ ...r }] : [] }; }
      if (s.startsWith('UPDATE catch_combos SET')) {
        const [uid, cur, max, started, last, charges, prot, ids, rewards] = params;
        db.combos.set(uid, { user_id: uid, current_combo: cur, max_combo: max, combo_started_at: started, last_catch_time: last,
          protection_charges: charges, protected_until: prot, pokemon_ids: ids, combo_rewards: JSON.parse(rewards) });
        return { rows: [] };
      }
      if (s.startsWith('INSERT INTO catch_combo_history')) { db.history.push({ user: params[0], count: params[1], reason: params[6] }); return { rows: [] }; }
      if (s.startsWith('UPDATE users SET')) { db.users.set(params[0], [...(db.users.get(params[0]) || []), { sql: s, params }]); return { rows: [] }; }
      if (s.startsWith('SELECT combo_threshold')) return { rows: [] };
      throw new Error('unexpected SQL in fake: ' + s.slice(0, 80));
    },
  };
  let clock = T0;
  const svc = new CatchComboService({
    query: (sql, p) => client.query(sql, p),
    transaction: async (fn) => fn(client),
    redis: () => null,
    addItems: async (c, uid, items) => { db.items.push(...items); return { credited: items, skipped: [] }; },
    consumeItem: async (c, uid, item) => { if (db.shields > 0) { db.shields--; db.consumed.push(item); return true; } return false; },
    now: () => clock,
    logger: { info() {}, warn() {} },
  });
  return { db, svc, setClock: (d) => { clock = d; } };
}

const U = '22222222-2222-2222-2222-222222222222';

test('服务：同一会话重复记录只计一次（幂等）', async () => {
  const { db, svc } = fakeDb();
  const a = await svc.recordCatchSuccess(U, { sessionId: 's1', pokemonInstanceId: '33333333-3333-3333-3333-333333333333' });
  assert.equal(a.currentCombo, 1);
  assert.equal(a.duplicate, false);
  const b = await svc.recordCatchSuccess(U, { sessionId: 's1' });
  assert.equal(b.duplicate, true);
  assert.equal(b.currentCombo, 1, '重复请求不递增');
  assert.equal(db.combos.get(U).current_combo, 1);
});

test('服务：连击到 5 发经验与道具；逃跑中断写历史', async () => {
  const { db, svc, setClock } = fakeDb();
  let last;
  for (let i = 1; i <= 5; i++) { setClock(at(i)); last = await svc.recordCatchSuccess(U, { sessionId: `s${i}` }); }
  assert.equal(last.currentCombo, 5);
  assert.equal(last.rewards.xp, Math.floor(50 * 1.5));
  assert.deepEqual(db.items, [{ type: 'POKE_BALL', qty: 5 }]);
  const xpUpdates = (db.users.get(U) || []).filter((u) => u.sql.includes('xp = xp +'));
  assert.equal(xpUpdates.length, 3, '第 3/4/5 连有经验奖励');
  setClock(at(6));
  const f = await svc.recordCatchFailure(U, { sessionId: 'fled-1', reason: 'failed' });
  assert.equal(f.broken, true);
  assert.equal(f.previousCombo, 5);
  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].reason, 'failed');
  const again = await svc.recordCatchFailure(U, { sessionId: 'fled-1' });
  assert.equal(again.duplicate, true, '同一逃跑会话不重复处理');
});

test('服务：保护道具不足报错；有道具时消耗并保护一次中断', async () => {
  const { db, svc, setClock } = fakeDb();
  await svc.recordCatchSuccess(U, { sessionId: 'a' });
  await assert.rejects(() => svc.useProtection(U), /道具不足/);
  db.shields = 1;
  const p = await svc.useProtection(U);
  assert.equal(p.protectionCharges, 1);
  setClock(at(1));
  const f = await svc.recordCatchFailure(U, { sessionId: 'b' });
  assert.equal(f.broken, false);
  assert.equal(f.protectedUsed, true);
  assert.equal(f.currentCombo, 1);
  await assert.rejects(() => svc.useProtection(U, 'POTION'), /不能用于连击保护/);
});

test('服务：查询时超时连击自动归档为 timeout（30 分钟无捕捉自动重置）', async () => {
  const { db, svc, setClock } = fakeDb();
  await svc.recordCatchSuccess(U, { sessionId: 'a' });
  await svc.recordCatchSuccess(U, { sessionId: 'b' });
  setClock(at(45));
  const st = await svc.getStatus(U);
  assert.equal(st.currentCombo, 0);
  assert.equal(db.history.at(-1).reason, 'timeout');
  assert.equal(db.combos.get(U).max_combo, 2);
});
