// tests/unit/battle-features.test.js
// E11：直接 require gym-service 业务模块的纯逻辑（联赛积分/段位、技能推荐评分、回放精彩时刻与分享密码、AI 策略助手）
// 这些模块不依赖数据库/Redis/第三方包，宿主机无 node_modules 也可运行：node --test tests/unit/battle-features.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const B = '../../services/gym-service/src/battle';
const league = require(`${B}/leagueRules`);
const recommend = require(`${B}/recommendScore`);
const replay = require(`${B}/replayFormat`);
const ai = require(`${B}/ai`);
const engine = require(`${B}/engine`);
const { DamageService } = require(`${B}/damage`);
const { ComboDetector } = require(`${B}/combo`);
const { normalizeMove, buildCombatant } = require(`${B}/stats`);

const MOVES = new Map([
  { id: 'TACKLE', name_zh: '撞击', type: 'NORMAL', category: 'FAST', power: 5, energy_delta: 8, duration_ms: 500, cooldown_ms: 500 },
  { id: 'EMBER', name_zh: '火花', type: 'FIRE', category: 'FAST', power: 10, energy_delta: 8, duration_ms: 1000, cooldown_ms: 500 },
  { id: 'FLAMETHROWER', name_zh: '喷射火焰', type: 'FIRE', category: 'CHARGE', power: 70, energy_delta: -55, duration_ms: 2500, cooldown_ms: 1500 },
  { id: 'WATER_GUN', name_zh: '水枪', type: 'WATER', category: 'FAST', power: 5, energy_delta: 8, duration_ms: 1000, cooldown_ms: 500 },
  { id: 'HYDRO_PUMP', name_zh: '水炮', type: 'WATER', category: 'CHARGE', power: 90, energy_delta: -75, duration_ms: 3500, cooldown_ms: 2300 },
  { id: 'VINE_WHIP', name_zh: '藤鞭', type: 'GRASS', category: 'FAST', power: 7, energy_delta: 8, duration_ms: 800, cooldown_ms: 500 },
  { id: 'SOLAR_BEAM', name_zh: '阳光烈焰', type: 'GRASS', category: 'CHARGE', power: 100, energy_delta: -100, duration_ms: 4000, cooldown_ms: 3000 },
  { id: 'THUNDER_SHOCK', name_zh: '电击', type: 'ELECTRIC', category: 'FAST', power: 6, energy_delta: 8, duration_ms: 900, cooldown_ms: 500 },
].map((r) => [r.id, normalizeMove(r)]));

const mon = (id, species, type1, cp, fast, charge, base = [120, 110, 120]) => buildCombatant({
  id, user_id: 'u', species_id: species, name_zh: id, type1, type2: null, base_attack: base[0], base_defense: base[1], base_hp: base[2],
  cp, iv_attack: 15, iv_defense: 15, iv_hp: 15, fast_move: fast, charge_move: charge,
}, MOVES);

// ── 联赛 ─────────────────────────────────────────────────────
test('联赛：胜 25 + 评分差奖励 + 连胜奖励（上限 25），负 15 且连胜 ≥3 保护减半', () => {
  assert.equal(league.winPoints(1000, 1000, 0), 25);
  assert.equal(league.winPoints(1000, 1250, 0), 27, '对手高 250 分 → +2');
  assert.equal(league.winPoints(1200, 1000, 0), 25, '赢低分对手无额外奖励');
  assert.equal(league.winPoints(1000, 1000, 2), 35, '连胜 2 → +10');
  assert.equal(league.winPoints(1000, 1000, 9), 50, '连胜奖励上限 25');
  assert.equal(league.lossPoints(0), 15);
  assert.equal(league.lossPoints(2), 15);
  assert.equal(league.lossPoints(3), 7, '连胜保护');
});

test('联赛：ELO 评分（K=32）', () => {
  assert.equal(league.elo(1000, 1000, true), 1016);
  assert.equal(league.elo(1000, 1000, false), 984);
  assert.ok(league.elo(1000, 1400, true) - 1000 > 16, '爆冷获胜加分更多');
  assert.ok(1400 - league.elo(1400, 1000, false) > 16, '高分输给低分扣分更多');
});

test('联赛：积分 → 段位/分组，晋级、分组晋升、降级判定', () => {
  assert.deepEqual(league.tierFor(0), { level: 'BRONZE', group: 'III' });
  assert.deepEqual(league.tierFor(340), { level: 'BRONZE', group: 'II' });
  assert.deepEqual(league.tierFor(700), { level: 'BRONZE', group: 'I' });
  assert.deepEqual(league.tierFor(1000), { level: 'SILVER', group: 'III' });
  assert.deepEqual(league.tierFor(4999), { level: 'DIAMOND', group: 'I' });
  assert.deepEqual(league.tierFor(9000), { level: 'MASTER', group: 'I' });
  assert.equal(league.tierChange({ level: 'BRONZE', group: 'I' }, { level: 'SILVER', group: 'III' }), 'promote');
  assert.equal(league.tierChange({ level: 'SILVER', group: 'III' }, { level: 'BRONZE', group: 'I' }), 'demote');
  assert.equal(league.tierChange({ level: 'BRONZE', group: 'III' }, { level: 'BRONZE', group: 'II' }), 'groupPromote');
  assert.equal(league.tierChange({ level: 'BRONZE', group: 'II' }, { level: 'BRONZE', group: 'III' }), 'groupDemote');
  assert.deepEqual(league.adjacentGroups('GOLD', 'II'), ['III', 'II', 'I']);
  assert.deepEqual(league.adjacentGroups('GOLD', 'III'), ['III', 'II']);
  assert.deepEqual(league.adjacentGroups('MASTER', 'I'), ['I']);
});

test('联赛：一场对局后的积分/评分/段位/连胜结算', () => {
  const m = { league_points: 990, league_rating: 1000, consecutive_wins: 2, wins: 5, losses: 1, league_level: 'BRONZE', league_group: 'I' };
  const w = league.applyResult(m, 1000, true);
  assert.equal(w.pointsChange, 35);
  assert.equal(w.level, 'SILVER');
  assert.equal(w.change, 'promote');
  assert.equal(w.consecutiveWins, 3);
  assert.equal(w.wins, 6);
  const l = league.applyResult({ ...m, league_points: 1005, league_level: 'SILVER', league_group: 'III', consecutive_wins: 0 }, 1000, false);
  assert.equal(l.pointsChange, -15);
  assert.equal(l.change, 'demote');
  assert.equal(l.consecutiveWins, 0);
  const floor = league.applyResult({ ...m, league_points: 5, consecutive_wins: 0, league_group: 'III' }, 1000, false);
  assert.equal(floor.points, 0, '积分不为负');
  assert.equal(league.tiers().length, 6);
});

// ── 技能推荐 ─────────────────────────────────────────────────
test('技能推荐：PVE 按循环 DPS、PVP 按回能与每能量伤害评分，本系/覆盖加成，分级与数据修正', () => {
  // 快速技能出手时长相近时，本系（火花）应优于非本系（电击）
  const fast = ['EMBER', 'THUNDER_SHOCK'].map((id) => MOVES.get(id));
  const charge = ['FLAMETHROWER', 'SOLAR_BEAM'].map((id) => MOVES.get(id));
  const pve = recommend.scorePairs(['fire'], fast, charge, { scenario: 'pve' });
  assert.equal(pve.length, 4);
  assert.equal(pve[0].fast.id, 'EMBER', '本系快速技能优先');
  assert.equal(pve[0].grade, 'S');
  assert.ok(pve.every((x, i) => i === 0 || x.score <= pve[i - 1].score), '按得分降序');
  assert.ok(pve[0].coverage.includes('grass'));
  const pvp = recommend.scorePairs(['fire'], fast, charge, { scenario: 'pvp' });
  assert.equal(pvp[0].charge.id, 'FLAMETHROWER', 'PVP 偏好低消耗蓄力技能');
  // 胜率数据修正：样本 ≥5 场时按胜率 ±20%
  const stats = new Map([['THUNDER_SHOCK|SOLAR_BEAM', { battles: 20, wins: 20 }], ['EMBER|FLAMETHROWER', { battles: 20, wins: 0 }]]);
  const withData = recommend.scorePairs(['fire'], fast, charge, { scenario: 'pve', stats });
  const top = withData.find((x) => x.fast.id === 'EMBER' && x.charge.id === 'FLAMETHROWER');
  assert.equal(top.winRate, 0);
  assert.ok(top.score < pve.find((x) => x.fast.id === 'EMBER' && x.charge.id === 'FLAMETHROWER').score);
  assert.equal(recommend.grade(0.96), 'S');
  assert.equal(recommend.grade(0.7), 'B');
  assert.equal(recommend.grade(0.3), 'D');
  const noCharge = recommend.scorePairs(['normal'], [MOVES.get('TACKLE')], [], { scenario: 'pve' });
  assert.equal(noCharge[0].charge, null, '没有蓄力技能时只评快速技能');
});

// ── 回放 ─────────────────────────────────────────────────────
function battle(seed = 11) {
  const deps = { damage: new DamageService(), combos: new ComboDetector([{ chain_id: 'EB', name: '火花连击', trigger_sequence: ['EMBER', 'EMBER'], time_window_ms: 5000, damage_multiplier: 1.5, combo_points: 1, xp_bonus: 10, min_trainer_level: 1, is_active: true }]) };
  const state = engine.createBattle({
    id: '00000000-0000-4000-8000-000000000001', type: 'gym', mode: 'PVE', userId: 'u1', trainerLevel: 10, seed,
    attackerTeam: [mon('c1', 6, 'FIRE', 2500, 'EMBER', 'FLAMETHROWER', [223, 173, 186])],
    defenderTeam: [mon('b1', 1, 'GRASS', 300, 'VINE_WHIP', 'SOLAR_BEAM'), mon('b2', 1, 'GRASS', 300, 'VINE_WHIP', 'SOLAR_BEAM')],
  });
  return { state, deps };
}

test('回放：精彩时刻识别（连击/效果拔群/击倒/无伤通关/一穿多…）与载荷', () => {
  const { state, deps } = battle();
  let now = 1_000_000;
  while (state.status === 'active') {
    const mv = engine.availableMoves(state).find((m) => m.ready && m.category === 'CHARGE') || engine.availableMoves(state).find((m) => m.ready);
    engine.playTurn(state, { moveId: mv.id, now: (now += 800) }, deps);
  }
  const sum = engine.summarize(state);
  assert.equal(sum.result, 'win');
  const hl = replay.extractHighlights(state, sum);
  const types = new Set(hl.map((h) => h.highlightType));
  for (const t of ['super_effective', 'knockout', 'sweep', 'flawless', 'combo']) assert.ok(types.has(t), `缺少 ${t}：${[...types]}`);
  assert.ok(replay.HIGHLIGHT_TYPES.length >= 6);
  assert.ok(hl.length <= 12);
  const payload = replay.buildPayload(state);
  assert.equal(payload.turns.length, state.turn);
  assert.equal(payload.seed, state.seed, '回放带随机种子，可复现');
  const size = require('zlib').gzipSync(JSON.stringify(payload)).length;
  assert.ok(size < 500 * 1024, `压缩后 ${size}B`);
});

test('回放：分享密码 scrypt 加盐校验、分享码字符集', () => {
  const h = replay.hashPassword('secret');
  assert.ok(h.startsWith('scrypt$'));
  assert.notEqual(h, replay.hashPassword('secret'), '随机盐');
  assert.equal(replay.verifyPassword('secret', h), true);
  assert.equal(replay.verifyPassword('wrong', h), false);
  assert.equal(replay.verifyPassword('secret', null), false);
  const codes = new Set(Array.from({ length: 200 }, () => replay.genShareCode()));
  assert.equal(codes.size, 200);
  for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
});

// ── AI 策略助手 ──────────────────────────────────────────────
test('AI：技能建议优先克制/可击倒，给出理由；能量不足/冷却的技能标记不可用', () => {
  const { state, deps } = battle(5);
  const a = ai.adviseMove(state, deps, { variant: 'A' });
  assert.equal(a.best.moveId, 'EMBER', '开局没有能量，只能用快速技能');
  const charge = a.recommendations.find((r) => r.moveId === 'FLAMETHROWER');
  assert.equal(charge.ready, false);
  assert.match(charge.reasons[0], /能量不足/);
  assert.ok(a.recommendations[0].reasons.some((r) => r.includes('属性克制')));
  engine.activeOf(state, 'attacker').energy = 100;
  const b = ai.adviseMove(state, deps, { variant: 'A' });
  assert.equal(b.best.moveId, 'FLAMETHROWER');
  assert.equal(b.best.knockout, true);
  assert.ok(b.best.reasons.some((r) => r.includes('击倒')));
  assert.equal(b.defender.weakTo[0].type, 'fire');
  const again = ai.adviseMove(state, deps, { variant: 'A' });
  assert.equal(again.cacheHit, true, '同一状态命中策略缓存');
});

test('AI：劣势时建议换上克制对手的队友', () => {
  const deps = { damage: new DamageService() };
  const state = engine.createBattle({
    id: 'b-switch', type: 'gym', userId: 'u', seed: 3,
    attackerTeam: [mon('weak', 1, 'GRASS', 200, 'VINE_WHIP', null), mon('strong', 7, 'WATER', 2500, 'WATER_GUN', 'HYDRO_PUMP')],
    defenderTeam: [mon('fire', 6, 'FIRE', 2500, 'EMBER', 'FLAMETHROWER', [223, 173, 186])],
  });
  engine.activeOf(state, 'defender').energy = 100;
  const a = ai.adviseMove(state, deps, {});
  assert.ok(a.switchSuggestion, JSON.stringify(a.best));
  assert.equal(a.switchSuggestion.pokemonId, 'strong');
  assert.equal(a.best.action, 'switch');
});

test('AI：蒙特卡洛胜率预测（强弱对位结论正确）、阵容优化挑出克制精灵并排序', () => {
  const { state, deps } = battle(9);
  const p = ai.predict(state, deps, { simulations: 16 });
  assert.ok(p.winProbability >= 0.9, `p=${p.winProbability}`);
  assert.equal(p.simulations, 16);
  const weak = engine.createBattle({
    id: 'b-weak', type: 'gym', userId: 'u', seed: 2,
    attackerTeam: [mon('g', 1, 'GRASS', 150, 'VINE_WHIP', null)],
    defenderTeam: [mon('f', 6, 'FIRE', 2500, 'EMBER', 'FLAMETHROWER', [223, 173, 186])],
  });
  assert.ok(ai.predict(weak, deps, { simulations: 16 }).winProbability <= 0.1);
  const cands = [mon('grass', 1, 'GRASS', 1500, 'VINE_WHIP', 'SOLAR_BEAM'), mon('water', 7, 'WATER', 1500, 'WATER_GUN', 'HYDRO_PUMP'), mon('normal', 52, 'NORMAL', 1500, 'TACKLE', null)];
  const defs = [mon('fire1', 6, 'FIRE', 1500, 'EMBER', 'FLAMETHROWER'), mon('fire2', 4, 'FIRE', 1200, 'EMBER', 'FLAMETHROWER')];
  const t0 = Date.now();
  const lu = ai.optimizeLineup(cands, defs, deps, { size: 2 });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(lu.team[0].pokemonId, 'water', '水克火排第一');
  const grass = ai.optimizeLineup(cands, defs, deps, { size: 3 }).team.find((t) => t.pokemonId === 'grass');
  assert.ok(grass.score < lu.team[0].score, '被克制的草系评分低于水系');
  assert.ok(grass.matchups.every((m) => m.typeMultiplier < 1), '草系技能对火系全部被抵抗');
  const one = ai.optimizeLineup(cands, defs, deps, { size: 1 });
  assert.deepEqual(one.team.map((t) => t.pokemonId), ['water']);
  assert.ok(lu.analysis.typeCoverage >= 1);
  assert.ok(lu.team[0].reasons.some((r) => r.includes('克制')));
});

test('AI：战后复盘评分与建议；A/B 分组稳定可配置', () => {
  const { state, deps } = battle(4);
  let now = 2_000_000;
  const trace = [];
  while (state.status === 'active') {
    const mv = engine.availableMoves(state).find((m) => m.ready && m.category === 'FAST');
    trace.push({ turn: state.turn + 1, recommended: 'FLAMETHROWER', chosen: mv.id, koAvailable: engine.availableMoves(state).find((m) => m.ready && m.category === 'CHARGE') ? 'FLAMETHROWER' : null });
    engine.playTurn(state, { moveId: mv.id, now: (now += 9000) }, deps);
  }
  const r = ai.reviewBattle(state, engine.summarize(state), trace);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(r.grade));
  assert.ok(r.suggestions.length >= 1);
  assert.equal(typeof r.stats.adviceFollowRate, 'number');
  assert.equal(ai.variantFor('user-1', 50), ai.variantFor('user-1', 50));
  assert.equal(ai.variantFor('user-1', 0), 'A');
  assert.equal(ai.variantFor('user-1', 100), 'B');
  const ids = Array.from({ length: 400 }, (_, i) => `u${i}`);
  const bShare = ids.filter((id) => ai.variantFor(id, 30) === 'B').length / ids.length;
  assert.ok(bShare > 0.2 && bShare < 0.4, `B 组占比 ${bShare}`);
});
