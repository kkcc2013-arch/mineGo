// tests/unit/battle-core.test.js
// E11 战斗核心：直接 require gym-service/src/battle/* 真实模块（伤害公式与缓存、冷却、能量、连击、回合引擎）
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const B = '../../services/gym-service/src/battle';
const { DamageService, TYPE_MATRIX, TYPES } = require(`${B}/damage`);
const cooldown = require(`${B}/cooldown`);
const energy = require(`${B}/energy`);
const { ComboDetector, normalizeChain, qualityOf } = require(`${B}/combo`);
const engine = require(`${B}/engine`);
const { normalizeMove, buildCombatant, deriveCpm, buildRaidBoss } = require(`${B}/stats`);
const { createRng } = require(`${B}/rng`);

const constRng = (v) => () => v;

// ── 技能与精灵夹具（数值取自 moves / pokemon_species 种子） ─────────────
const MOVE_ROWS = [
  { id: 'TACKLE', name_zh: '撞击', type: 'NORMAL', category: 'FAST', power: 5, energy_delta: 8, duration_ms: 500, cooldown_ms: 500, accuracy_pct: 100 },
  { id: 'EMBER', name_zh: '火花', type: 'FIRE', category: 'FAST', power: 10, energy_delta: 8, duration_ms: 1000, cooldown_ms: 500, accuracy_pct: 100, effect_type: 'BURN', effect_chance_pct: 10 },
  { id: 'FLAMETHROWER', name_zh: '喷射火焰', type: 'FIRE', category: 'CHARGE', power: 70, energy_delta: -55, energy_cost: 50, duration_ms: 2500, cooldown_ms: 1500, accuracy_pct: 100 },
  { id: 'WATER_GUN', name_zh: '水枪', type: 'WATER', category: 'FAST', power: 5, energy_delta: 8, duration_ms: 1000, cooldown_ms: 500, accuracy_pct: 100 },
  { id: 'HYDRO_PUMP', name_zh: '水炮', type: 'WATER', category: 'CHARGE', power: 90, energy_delta: -75, energy_cost: 80, duration_ms: 3500, cooldown_ms: 2300, accuracy_pct: 85 },
  { id: 'VINE_WHIP', name_zh: '藤鞭', type: 'GRASS', category: 'FAST', power: 7, energy_delta: 8, duration_ms: 800, cooldown_ms: 500, accuracy_pct: 100 },
];
const MOVES = new Map(MOVE_ROWS.map((r) => [r.id, normalizeMove(r)]));
const CHARMANDER = { id: 'p-char', user_id: 'u1', species_id: 4, name_zh: '小火龙', type1: 'FIRE', type2: null, base_attack: 116, base_defense: 93, base_hp: 118, cp: 900, iv_attack: 15, iv_defense: 15, iv_hp: 15, fast_move: 'EMBER', charge_move: 'FLAMETHROWER' };
const BULBASAUR = { id: 'p-bulb', user_id: 'u2', species_id: 1, name_zh: '妙蛙种子', type1: 'GRASS', type2: 'POISON', base_attack: 118, base_defense: 111, base_hp: 128, cp: 300, iv_attack: 5, iv_defense: 5, iv_hp: 5, fast_move: 'VINE_WHIP', charge_move: null };
const SQUIRTLE = { id: 'p-squi', user_id: 'u2', species_id: 7, name_zh: '杰尼龟', type1: 'WATER', type2: null, base_attack: 94, base_defense: 121, base_hp: 127, cp: 300, iv_attack: 5, iv_defense: 5, iv_hp: 5, fast_move: 'WATER_GUN', charge_move: 'HYDRO_PUMP' };

const CHAINS = [
  { chain_id: 'EMBER_BURST', name: '火花爆燃', trigger_sequence: ['EMBER', 'EMBER', 'FLAMETHROWER'], time_window_ms: 5000, element_requirement: 'fire', damage_multiplier: 1.5, bonus_effects: { status: 'BURN' }, cooldown_reduction: 10, combo_points: 2, xp_bonus: 50, min_trainer_level: 1, chain_cooldown_turns: 3, is_active: true },
  { chain_id: 'TACKLE_RUSH', name: '冲撞三连', trigger_sequence: ['TACKLE', 'TACKLE', 'TACKLE'], time_window_ms: 3000, element_requirement: null, damage_multiplier: 1.2, bonus_effects: {}, cooldown_reduction: 5, combo_points: 1, xp_bonus: 20, min_trainer_level: 1, chain_cooldown_turns: 3, is_active: true },
  { chain_id: 'EMBER_DOUBLE', name: '双火花', trigger_sequence: ['EMBER', 'EMBER'], time_window_ms: 2000, element_requirement: 'fire', damage_multiplier: 1.3, bonus_effects: {}, cooldown_reduction: 0, combo_points: 1, xp_bonus: 10, min_trainer_level: 5, chain_cooldown_turns: 3, is_active: true },
  { chain_id: 'OFF', name: '停用', trigger_sequence: ['EMBER', 'TACKLE'], time_window_ms: 2000, damage_multiplier: 9, is_active: false },
];

// ── 属性克制矩阵 ──────────────────────────────────────────────
test('属性克制矩阵：18x18 = 324 种组合全部预计算，使用 GO 倍率', () => {
  assert.equal(TYPES.length, 18);
  let n = 0;
  for (const a of TYPES) for (const d of TYPES) { assert.equal(typeof TYPE_MATRIX[a][d], 'number'); n++; }
  assert.equal(n, 324);
  assert.equal(TYPE_MATRIX.fire.grass, 1.6);
  assert.equal(TYPE_MATRIX.water.fire, 1.6);
  assert.equal(TYPE_MATRIX.fire.water, 0.625);
  assert.equal(TYPE_MATRIX.normal.ghost, 0.390625, '主系列免疫在 GO 中为 0.390625');
  const ds = new DamageService();
  assert.ok(Math.abs(ds.typeMultiplier('fire', ['GRASS', 'STEEL']) - 2.56) < 1e-9, '双属性相乘，大小写无关');
  assert.equal(ds.typeMultiplier('ice', ['grass', 'flying']), 1.6 * 1.6);
  assert.equal(ds.stats().typeHitRate, 1);
});

// ── 伤害公式 ─────────────────────────────────────────────────
test('伤害公式：floor(0.5*P*A/D*STAB*克制*随机)+1，STAB 1.2、暴击 1.5', () => {
  const ds = new DamageService();
  const atk = { attack: 100, types: ['fire'] };
  const def = { defense: 100, types: ['grass'] };
  const move = { id: 'X', power: 70, type: 'fire', critPct: 0 };
  const r = ds.compute(atk, def, move, { rng: constRng(0.999999) });
  // base = 0.5*70*1*1.2*1.6 = 67.2；random≈1 → 68
  assert.equal(r.damage, 68);
  assert.equal(r.stab, true);
  assert.equal(r.effectiveness, 1.6);
  assert.equal(r.effectivenessText, '效果拔群！');
  const low = ds.compute(atk, def, move, { rng: constRng(0) }); // random = 0.85
  assert.equal(low.damage, Math.floor(67.2 * 0.85) + 1);
  const crit = ds.compute(atk, def, { ...move, critPct: 100 }, { rng: constRng(0) });
  assert.equal(crit.isCrit, true);
  assert.equal(crit.damage, Math.floor(67.2 * 0.85 * 1.5) + 1);
  const noStab = ds.compute({ attack: 100, types: ['water'] }, def, move, { rng: constRng(0.999999) });
  assert.equal(noStab.damage, Math.floor(0.5 * 70 * 1.6 * (0.85 + 0.999999 * 0.15)) + 1);
  const boosted = ds.compute(atk, def, move, { rng: constRng(0.999999), weather: 'sunny' });
  assert.equal(boosted.weatherBoosted, true);
  assert.equal(boosted.damage, Math.floor(67.2 * 1.2) + 1);
  const zero = ds.compute(atk, def, { id: 'S', power: 0, type: 'normal' }, { rng: constRng(0.5) });
  assert.equal(zero.damage, 0, '无威力技能不造成伤害');
});

test('伤害缓存：同一对局命中 L1、数值变化即换键（内容寻址失效）、LRU 上限', () => {
  const ds = new DamageService({ l1Max: 3 });
  const atk = { attack: 120.5, types: ['fire'] };
  const def = { defense: 80, types: ['grass'] };
  const move = { id: 'EMBER', power: 10, type: 'fire' };
  assert.equal(ds.compute(atk, def, move, { rng: constRng(0.5) }).cached, false);
  for (let i = 0; i < 9; i++) assert.equal(ds.compute(atk, def, move, { rng: constRng(0.5) }).cached, true);
  assert.equal(ds.stats().l1HitRate, 0.9);
  // 精灵强化后攻击变化：新键，不会读到旧值
  const stronger = ds.compute({ ...atk, attack: 130 }, def, move, { rng: constRng(0.999999) });
  assert.equal(stronger.cached, false);
  assert.ok(stronger.damage > ds.compute(atk, def, move, { rng: constRng(0.999999) }).damage);
  // 技能数值被调整（威力变化）也换键
  assert.equal(ds.compute(atk, def, { ...move, power: 12 }, { rng: constRng(0.5) }).cached, false);
  ds.compute(atk, { ...def, defense: 81 }, move, { rng: constRng(0.5) });
  assert.ok(ds.stats().l1Entries <= 3, 'LRU 淘汰');
});

test('伤害缓存：warmup 预计算技能系数；命中时单次计算 < 5ms、未命中 < 50ms', async () => {
  const ds = new DamageService();
  const moves = [...MOVES.values()];
  const combos = [['fire'], ['grass', 'poison'], ['water'], ['normal', 'fairy']];
  const w = await ds.warmup(moves, combos, { loadL2: false });
  assert.ok(w.coefficients >= moves.length * combos.length * 2, `系数条目 ${w.coefficients}`);
  assert.ok(w.ms < 30000);
  const a = buildCombatant(CHARMANDER, MOVES);
  const d = buildCombatant(BULBASAUR, MOVES);
  const mv = MOVES.get('FLAMETHROWER');
  let t0 = process.hrtime.bigint();
  ds.compute(a, d, mv, { rng: Math.random });
  const missMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 10000; i++) ds.compute(a, d, mv, { rng: Math.random });
  const hitMs = Number(process.hrtime.bigint() - t0) / 1e6 / 10000;
  assert.ok(missMs < 50, `miss ${missMs}ms`);
  assert.ok(hitMs < 5, `hit ${hitMs}ms`);
  const s = ds.stats();
  assert.ok(s.coefficientHitRate >= 0.95, `系数命中率 ${s.coefficientHitRate}`);
  assert.ok(s.l1HitRate >= 0.8);
  assert.ok(s.l1MemoryBytesEstimate < 100 * 1024 * 1024);
});

test('伤害缓存：1 万条 L1 记录内存估算 < 100MB，invalidate 清空', async () => {
  const ds = new DamageService({ l1Max: 10000 });
  const mv = { id: 'M', power: 50, type: 'fire' };
  for (let i = 0; i < 10000; i++) ds.baseDamage({ attack: 100 + i / 100, types: ['fire'] }, { defense: 90, types: ['grass'] }, mv, null);
  const s = ds.stats();
  assert.equal(s.l1Entries, 10000);
  assert.ok(s.l1MemoryBytesEstimate < 100 * 1024 * 1024, `${s.l1MemoryBytesEstimate}`);
  await ds.invalidate({ l2: false });
  assert.equal(ds.stats().l1Entries, 0);
});

// ── 数值推导 ─────────────────────────────────────────────────
test('战斗数值：由 CP 反推 CPM，攻击=A*CPM、HP=floor(S*CPM)，能量上限与个体值关联', () => {
  const A = 131; const D = 108; const S = 133; const cpm = 0.6;
  const cp = (A * Math.sqrt(D) * Math.sqrt(S) * cpm * cpm) / 10;
  assert.ok(Math.abs(deriveCpm(cp, A, D, S) - 0.6) < 1e-9);
  assert.equal(deriveCpm(999999, A, D, S), 0.8653, 'CPM 上限');
  const c = buildCombatant(CHARMANDER, MOVES);
  assert.equal(c.types[0], 'fire');
  assert.equal(c.maxEnergy, 120, '满个体 120 能量上限');
  assert.equal(c.maxHp, Math.floor(133 * c.cpm));
  assert.deepEqual(c.moves.map((m) => m.id), ['EMBER', 'FLAMETHROWER']);
  const noMoves = buildCombatant({ ...BULBASAUR, fast_move: null }, MOVES, { learnset: [{ move_id: 'VINE_WHIP', learn_method: 'LEVEL_UP' }] });
  assert.equal(noMoves.moves[0].id, 'VINE_WHIP', '缺技能时按学习表补默认');
  const weak = buildCombatant(BULBASAUR, MOVES, { hpRatio: 0.5 });
  assert.equal(weak.hp, Math.round(weak.maxHp * 0.5), '驻守士气缩放开场 HP');
  const boss = buildRaidBoss({ id: 150, name_zh: '超梦', type1: 'PSYCHIC', base_attack: 300, base_defense: 182, base_hp: 214 }, 5, MOVES);
  assert.equal(boss.maxHp, 15000);
  assert.equal(normalizeMove(MOVE_ROWS[2]).energyCost, 55, '蓄力消耗取 max(energy_cost, -energy_delta)');
});

// ── 冷却 ─────────────────────────────────────────────────────
test('冷却：熟练度 0-100 → 0-15%，连击 3 次后每次 -2% 最多 10%，速度每 10 点 -2%', () => {
  assert.equal(cooldown.masteryReduction(0), 0);
  assert.ok(Math.abs(cooldown.masteryReduction(100) - 0.15) < 1e-12);
  assert.ok(Math.abs(cooldown.masteryReduction(50) - 0.075) < 1e-12);
  assert.equal(cooldown.masteryReduction(500), 0.15);
  assert.equal(cooldown.comboAcceleration(2), 0);
  assert.equal(cooldown.comboAcceleration(3), 0.02);
  assert.ok(Math.abs(cooldown.comboAcceleration(5) - 0.06) < 1e-12);
  assert.equal(cooldown.comboAcceleration(7), 0.1);
  assert.equal(cooldown.comboAcceleration(30), 0.1);
  assert.equal(cooldown.speedReduction(9), 0);
  assert.equal(cooldown.speedReduction(55), 0.1);
  assert.equal(cooldown.speedReduction(500), 0.2);
});

test('冷却：装备加成按适用范围累加且上限 30%；天气；四种战斗模式策略', () => {
  const fire = MOVES.get('FLAMETHROWER');
  const eq = [
    { equip_type: 'artifact', reduction_pct: 20, applies_to: 'CHARGE' },
    { equip_type: 'gem', reduction_pct: 10, applies_to: 'ALL', move_type: 'FIRE' },
    { equip_type: 'rune', reduction_pct: 8, applies_to: 'FAST' },
  ];
  assert.ok(Math.abs(cooldown.equipmentReduction(eq, fire) - 0.3) < 1e-12, '20+10=30，快速符文不适用');
  assert.equal(cooldown.equipmentReduction([{ reduction_pct: 25, applies_to: 'ALL' }, { reduction_pct: 25, applies_to: 'ALL' }], fire), 0.3, '上限 30%');
  assert.equal(cooldown.equipmentReduction([{ reduction_pct: 10, applies_to: 'ALL', move_type: 'WATER' }], fire), 0);

  const pve = cooldown.effectiveCooldown(fire, { mode: 'PVE', equipment: eq });
  assert.equal(pve.baseMs, 1500);
  assert.equal(pve.effectiveMs, Math.round(1500 * 0.7));
  const tour = cooldown.effectiveCooldown(fire, { mode: 'TOURNAMENT', equipment: eq, mastery: 100 });
  assert.equal(tour.breakdown.equipment, 0, '锦标赛禁用装备');
  assert.equal(tour.breakdown.mastery, 0, '锦标赛禁用熟练度');
  const pvp = cooldown.effectiveCooldown(fire, { mode: 'PVP', equipment: eq, mastery: 100, speed: 100 });
  assert.equal(pvp.reduction, 0.3, 'PVP 总缩减上限 30%');
  assert.equal(pvp.capped, true);
  assert.equal(pvp.effectiveMs, Math.round(1500 * 1.1 * 0.7));
  const raid = cooldown.effectiveCooldown(fire, { mode: 'RAID' });
  assert.equal(raid.effectiveMs, 1350);
  const sunny = cooldown.effectiveCooldown(fire, { mode: 'PVE', weather: 'sunny' });
  assert.equal(sunny.effectiveMs, 1350, '晴天火系冷却 ×0.9');
  assert.equal(cooldown.effectiveCooldown(MOVES.get('HYDRO_PUMP'), {}).turns, 2, '2300ms → 2 回合');
  const p = cooldown.predict(buildCombatant(CHARMANDER, MOVES), { turn: 0, ctx: { mode: 'PVE' } });
  assert.equal(p.moves.length, 2);
  assert.ok(p.tips.length > 0);
  assert.ok(p.moves.find((m) => m.moveId === 'FLAMETHROWER').energyShort > 0);
});

// ── 能量 ─────────────────────────────────────────────────────
test('能量：上限 100~120、每回合回复（低血量加成/状态修正）、蓄力消耗、不足时拒绝', () => {
  assert.equal(energy.maxEnergyFor(0), 100);
  assert.equal(energy.maxEnergyFor(45), 120);
  const c = buildCombatant(CHARMANDER, MOVES);
  assert.equal(energy.regenAmount(c), 10);
  c.hp = Math.floor(c.maxHp * 0.2);
  assert.equal(energy.regenAmount(c), 15, 'HP ≤ 25% 额外 +5');
  c.status = { code: 'FREEZE', turns: 1 };
  assert.equal(energy.regenAmount(c), 5, '冰冻 -10');
  const rule = energy.normalizeRule({ rule_name: 'x', base_regen: 8, hp_threshold_bonus: '[{"threshold":0.5,"bonus":3}]', status_effect_modifiers: '{}', item_modifiers: '{"energy_charm":5}' });
  c.status = null;
  assert.equal(energy.regenAmount(c, rule, ['energy_charm']), 16);
  c.energy = 0;
  const no = energy.checkMove(c, 'FLAMETHROWER', { turn: 1 });
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'ENERGY');
  assert.equal(energy.checkMove(c, 'SURF', { turn: 1 }).reason, 'UNKNOWN_MOVE');
  assert.equal(energy.applyMoveEnergy(c, MOVES.get('EMBER')), 8);
  c.energy = 60;
  assert.equal(energy.checkMove(c, 'FLAMETHROWER', { turn: 1 }).ok, true);
  assert.equal(energy.applyMoveEnergy(c, MOVES.get('FLAMETHROWER')), -55);
  c.energy = 119;
  energy.applyMoveEnergy(c, MOVES.get('EMBER'));
  assert.equal(c.energy, 120, '不超过上限');
  c.readyTurn = { EMBER: 5 };
  assert.equal(energy.checkMove(c, 'EMBER', { turn: 4 }).reason, 'COOLDOWN');
  assert.equal(energy.checkMove(c, 'EMBER', { turn: 5 }).ok, true);
});

// ── 连击 ─────────────────────────────────────────────────────
test('连击：窗口内按顺序连续释放触发；超时/不连续/属性或等级不符/停用链不触发', () => {
  const cd = new ComboDetector(CHAINS);
  assert.equal(cd.chains.length, 3, '停用链被过滤');
  const t0 = 1_000_000;
  const hist = [{ moveId: 'EMBER', at: t0, seq: 0 }, { moveId: 'EMBER', at: t0 + 1000, seq: 1 }];
  const hit = cd.detect(hist, 'FLAMETHROWER', { now: t0 + 2000, seq: 2, attackerTypes: ['fire'], trainerLevel: 1 });
  assert.equal(hit.chain.chainId, 'EMBER_BURST');
  assert.equal(hit.quality, 'perfect');
  assert.equal(hit.multiplier, 1.875, '1.5 × 完美 1.25');
  assert.equal(hit.effects.status, 'BURN');
  assert.equal(cd.detect(hist, 'FLAMETHROWER', { now: t0 + 5001, seq: 2, attackerTypes: ['fire'] }), null, '超出 5 秒窗口');
  assert.equal(cd.detect([{ moveId: 'EMBER', at: t0, seq: 0 }, { moveId: 'EMBER', at: t0, seq: 2 }], 'FLAMETHROWER', { now: t0 + 100, seq: 3, attackerTypes: ['fire'] }), null, '中间插入其他行动');
  assert.equal(cd.detect(hist, 'FLAMETHROWER', { now: t0 + 2000, seq: 2, attackerTypes: ['water'] }), null, '属性要求');
  assert.equal(cd.detect([{ moveId: 'EMBER', at: t0, seq: 0 }], 'EMBER', { now: t0 + 100, seq: 1, attackerTypes: ['fire'], trainerLevel: 1 }), null, '等级不足（需 5 级）');
  assert.equal(cd.detect([{ moveId: 'EMBER', at: t0, seq: 0 }], 'EMBER', { now: t0 + 100, seq: 1, attackerTypes: ['fire'], trainerLevel: 5 }).chain.chainId, 'EMBER_DOUBLE');
  assert.equal(cd.detect(hist, 'FLAMETHROWER', { now: t0 + 2000, seq: 2, attackerTypes: ['fire'], lastTriggered: { EMBER_BURST: -2 } }), null, '连击冷却');
  assert.ok(cd.detect(hist, 'FLAMETHROWER', { now: t0 + 2000, seq: 2, attackerTypes: ['fire'], lastTriggered: { EMBER_BURST: -4 } }));
});

test('连击：质量评估、熟练度加成、倍率上限 3.0、提示/可达/练习', () => {
  assert.equal(qualityOf(1000, 5000).name, 'perfect');
  assert.equal(qualityOf(3000, 5000).name, 'excellent');
  assert.equal(qualityOf(4500, 5000).name, 'normal');
  const cd = new ComboDetector(CHAINS);
  const t0 = 5_000_000;
  const hist = [{ moveId: 'EMBER', at: t0, seq: 0 }, { moveId: 'EMBER', at: t0 + 1500, seq: 1 }];
  const normal = cd.detect(hist, 'FLAMETHROWER', { now: t0 + 4500, seq: 2, attackerTypes: ['fire'], masteryCounts: { EMBER_BURST: 10 } });
  assert.equal(normal.quality, 'normal');
  assert.equal(normal.masteryBonus, 0.1);
  assert.equal(normal.multiplier, 1.65);
  const big = new ComboDetector([{ ...CHAINS[0], chain_id: 'BIG', damage_multiplier: 3.5 }]);
  assert.equal(big.detect(hist, 'FLAMETHROWER', { now: t0 + 100, seq: 2, attackerTypes: ['fire'] }).multiplier, 3.0);
  const hints = cd.progress([{ moveId: 'EMBER', at: Date.now(), seq: 0 }], ['EMBER', 'FLAMETHROWER'], { now: Date.now() });
  assert.ok(hints.some((h) => h.chainId === 'EMBER_BURST' && h.nextMove === 'EMBER' && h.matched === 1));
  const ach = cd.achievable(['EMBER', 'FLAMETHROWER'], { types: ['fire'], trainerLevel: 10 });
  assert.equal(ach[0].ready, true);
  assert.ok(ach.find((a) => a.chainId === 'TACKLE_RUSH').missing.includes('TACKLE'));
  const pr = cd.practice([{ moveId: 'TACKLE', atMs: 0 }, { moveId: 'TACKLE', atMs: 400 }, { moveId: 'TACKLE', atMs: 800 }], { attackerTypes: ['normal'] });
  assert.equal(pr[2].combo.chainId, 'TACKLE_RUSH');
  const slow = cd.practice([{ moveId: 'TACKLE', atMs: 0 }, { moveId: 'TACKLE', atMs: 2000 }, { moveId: 'TACKLE', atMs: 4000 }], {});
  assert.equal(slow[2].combo, null);
  assert.equal(normalizeChain({ chain_id: 'A', trigger_sequence: '["X","Y"]', bonus_effects: '{"burn":true}' }).sequence[1], 'Y');
});

// ── 回合引擎 ─────────────────────────────────────────────────
function newBattle(seed = 42, extra = {}) {
  const deps = { damage: new DamageService(), combos: new ComboDetector(CHAINS) };
  const state = engine.createBattle({
    id: 'b1', type: 'gym', mode: 'PVE', userId: 'u1', trainerLevel: 10, seed,
    attackerTeam: [buildCombatant(CHARMANDER, MOVES), buildCombatant({ ...CHARMANDER, id: 'p-char2' }, MOVES)],
    defenderTeam: [buildCombatant(BULBASAUR, MOVES), buildCombatant(SQUIRTLE, MOVES, { hpRatio: 0.5 })],
    ...extra,
  });
  return { state, deps };
}

test('回合引擎：技能校验（未学会/冷却/能量不足）不消耗回合', () => {
  const { state, deps } = newBattle();
  assert.throws(() => engine.playTurn(state, { moveId: 'HYDRO_PUMP' }, deps), (e) => e.code === 'INVALID_MOVE' && e.status === 400);
  assert.throws(() => engine.playTurn(state, { moveId: 'FLAMETHROWER' }, deps), (e) => e.code === 'INSUFFICIENT_ENERGY');
  assert.equal(state.turn, 0);
  // 攒能量后放蓄力技能，下一回合处于冷却
  let now = 1_000_000;
  while (engine.activeOf(state, 'attacker').energy < 55) engine.playTurn(state, { moveId: 'EMBER', now: (now += 3000) }, deps);
  engine.playTurn(state, { moveId: 'FLAMETHROWER', now: (now += 3000) }, deps);
  if (state.status === 'active' && engine.activeOf(state, 'attacker').pokemonId === 'p-char') {
    assert.throws(() => engine.playTurn(state, { moveId: 'FLAMETHROWER', now: (now += 3000) }, deps), (e) => ['MOVE_COOLDOWN', 'INSUFFICIENT_ENERGY'].includes(e.code));
  }
});

test('回合引擎：服务端计算伤害，打完全部守方获胜；摘要统计正确；同种子可复现', () => {
  const run = (seed) => {
    const { state, deps } = newBattle(seed);
    let now = 2_000_000;
    let guard = 0;
    while (state.status === 'active' && guard++ < 200) {
      const moves = engine.availableMoves(state);
      const pick = moves.find((m) => m.category === 'CHARGE' && m.ready) || moves.find((m) => m.ready);
      engine.playTurn(state, { moveId: pick.id, now: (now += 3000) }, deps);
    }
    return state;
  };
  const s1 = run(7);
  assert.equal(s1.status, 'ended');
  assert.equal(s1.result, 'win', '高 CP 火系打草/水');
  const sum = engine.summarize(s1);
  assert.equal(sum.defendersDefeated.length, 2);
  assert.ok(sum.damageDealt > 0);
  assert.equal(sum.attacks.length, s1.seq);
  const s2 = run(7);
  assert.deepEqual(s2.log.map((t) => t.hp), s1.log.map((t) => t.hp), '同种子同操作序列结果一致');
  assert.throws(() => engine.playTurn(s1, { moveId: 'EMBER' }, newBattle().deps), (e) => e.code === 'BATTLE_ENDED' && e.status === 409);
});

test('回合引擎：连击在对战中触发（倍率/状态/连击点/XP），换人打断连击', () => {
  const { state, deps } = newBattle(3);
  const att = engine.activeOf(state, 'attacker');
  att.energy = 100;
  let now = 3_000_000;
  engine.playTurn(state, { moveId: 'EMBER', now: (now += 500) }, deps);
  engine.playTurn(state, { moveId: 'EMBER', now: (now += 500) }, deps);
  const t = engine.playTurn(state, { moveId: 'FLAMETHROWER', now: (now += 500) }, deps);
  const hit = t.actions.find((a) => a.type === 'attack' && a.actor === 'attacker');
  // 第二下 EMBER 可能先触发 EMBER_DOUBLE（10 级满足），任一连击都应记录
  assert.ok(state.comboState.count >= 1, JSON.stringify(state.comboState));
  assert.ok(state.comboState.points >= 1);
  assert.ok(state.comboState.xpBonus > 0);
  assert.ok(hit);
  const view = engine.publicView(state, deps);
  assert.equal(view.combo.count, state.comboState.count);
  assert.ok(Array.isArray(view.attacker.active.moves));
  // 换人：清空连击历史，守方获得一次行动
  if (state.status === 'active') {
    const before = state.turn;
    const sw = engine.switchActive(state, 'p-char2', { now: now + 100 }, deps);
    assert.equal(state.turn, before + 1);
    assert.equal(state.history.length, 0);
    assert.ok(sw.actions.some((a) => a.type === 'switch'));
    assert.throws(() => engine.switchActive(state, 'p-char2', {}, deps), (e) => e.code === 'ALREADY_ACTIVE');
    assert.throws(() => engine.switchActive(state, 'nope', {}, deps), (e) => e.code === 'NOT_IN_TEAM');
  }
});

test('回合引擎：连击窗口超时不触发；认输结束', () => {
  const { state, deps } = newBattle(5, { trainerLevel: 1 });
  engine.activeOf(state, 'attacker').energy = 100;
  let now = 4_000_000;
  engine.playTurn(state, { moveId: 'EMBER', now: (now += 3000) }, deps);
  engine.playTurn(state, { moveId: 'EMBER', now: (now += 3000) }, deps);
  if (state.status === 'active') engine.playTurn(state, { moveId: 'FLAMETHROWER', now: (now += 3000) }, deps);
  assert.equal(state.comboState.count, 0, '6 秒 > 5 秒窗口');
  if (state.status === 'active') {
    engine.forfeit(state);
    assert.equal(state.result, 'forfeit');
  }
});

test('随机数：可序列化状态续接', () => {
  const r1 = createRng(123);
  const a = [r1(), r1()];
  const r2 = createRng(r1.state());
  const r3 = createRng(123);
  r3(); r3();
  assert.equal(r2(), r3());
  assert.notEqual(a[0], a[1]);
});
