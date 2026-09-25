// E11 战斗扩展接口（挂载在 gym-service /battle，经网关 /v1/battle/* 访问，除公开回放外均需登录）
//
// 能量/冷却/熟练度/装备（REQ-00112 / 00299 / 00311）
//   GET  /battle/pokemon/:id/energy               POST /battle/pokemon/:id/energy/regenerate
//   POST /battle/pokemon/:id/moves/check           GET  /battle/pokemon/:id/cooldowns?mode=PVE|PVP|RAID|TOURNAMENT
//   GET  /battle/pokemon/:id/mastery               GET  /battle/moves/:moveId/energy-info
//   GET  /battle/equipment/catalog | /mine         POST /battle/equipment/:itemId/equip | /unequip
//   POST /battle/equipment/grant（管理员）
// 连击（REQ-00143 / 00288 / 00311 / 00364）
//   GET  /battle/combos  /combos/my/stats  /combos/leaderboard  /combos/logs  /combos/recommend/:pokemonId  /combos/:chainId
//   POST /battle/combos/:chainId/practice
//   GET/POST /battle/combos/presets   PUT/DELETE /battle/combos/presets/:id
// 伤害（REQ-00192 / 00362）
//   POST /battle/damage/simulate   GET /battle/damage/typechart   GET /battle/damage/cache/stats（管理员）   POST /battle/damage/cache/refresh（管理员）
// 技能推荐（REQ-00324）
//   GET /battle/recommendations/:speciesId?scenario&style   GET/PUT /battle/recommendations/preferences   POST /battle/recommendations/aggregate（管理员）
// AI 策略助手（REQ-00357 / 00365）
//   POST /battle/ai/lineup   GET /battle/ai/reviews   GET /battle/ai/review/:battleId   POST /battle/ai/feedback
//   GET/PUT /battle/ai/preferences   GET /battle/ai/quota   GET /battle/ai/stats（管理员）   PUT /battle/ai/experiment（管理员）
// 回放分享（REQ-00379 / 00469）
//   GET /battle/replays/mine | hot | search | :id | :id/comments   POST /battle/replays/:id/share | like | comments
//   PATCH/DELETE /battle/replays/:id   GET /battle/replays/shared/:code（公开，无需登录）
// 竞技联赛（REQ-00487）
//   GET /battle/league/season | me | tiers | leaderboard | matches | rewards | defense-team
//   POST /battle/league/match   POST /battle/league/rewards/:id/claim   PUT /battle/league/defense-team
//   POST /battle/league/admin/end-season（管理员）
// 客户端帧率（REQ-00325）
//   GET /battle/perf/config   POST /battle/perf/report   GET /battle/perf/dashboard（管理员）
'use strict';

const express = require('express');
const { requireAuth, verifyAccess } = require('../../../../shared/auth');
const { query } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { handle, userId, requireAdminRole } = require('../battle/http');
const { BattleError, createBattle } = require('../battle/engine');
const pe = require('../battle/pokemonEnergy');
const combos = require('../battle/comboPresets');
const replay = require('../battle/replay');
const recommend = require('../battle/recommend');
const league = require('../battle/league');
const session = require('../battle/session');
const ai = require('../battle/ai');
const repo = require('../battle/repo');
const deps = require('../battle/deps');
const { TYPE_MATRIX, TYPES } = require('../battle/damage');
const { buildCombatant } = require('../battle/stats');
const battleMetrics = require('../battle/metrics');

session.registerSettler('league', league.settleLeague);

const router = express.Router();
const uid = userId;

// ── 能量 / 冷却 / 熟练度 / 装备 ─────────────────────────────────
router.get('/pokemon/:id/energy', requireAuth, handle((req) => pe.getEnergy(uid(req), req.params.id)));
router.post('/pokemon/:id/energy/regenerate', requireAuth, handle((req) => pe.regenerate(uid(req), req.params.id)));
router.post('/pokemon/:id/moves/check', requireAuth, handle((req) => pe.checkMove(uid(req), req.params.id, (req.body || {}).moveId)));
router.get('/pokemon/:id/cooldowns', requireAuth, handle((req) => pe.cooldownInfo(uid(req), req.params.id, String(req.query.mode || 'PVE').toUpperCase(), req.query.weather || null)));
router.get('/pokemon/:id/mastery', requireAuth, handle((req) => pe.masteryInfo(uid(req), req.params.id)));
router.get('/moves/:moveId/energy-info', requireAuth, handle(async (req) => {
  const m = (await repo.getMoves()).get(req.params.moveId);
  if (!m) throw new BattleError('MOVE_NOT_FOUND', '技能不存在', 404);
  const cds = Object.fromEntries(Object.keys(require('../battle/cooldown').MODE_STRATEGIES).map((mode) => [mode, require('../battle/cooldown').effectiveCooldown(m, { mode })]));
  return { ...m, cooldownByMode: cds };
}));

router.get('/equipment/catalog', requireAuth, handle(() => pe.equipmentCatalog()));
router.get('/equipment/mine', requireAuth, handle((req) => pe.myEquipment(uid(req))));
router.post('/equipment/grant', requireAuth, handle((req) => { requireAdminRole(req); return pe.grantEquipment((req.body || {}).userId, (req.body || {}).equipmentId); }));
router.post('/equipment/:itemId/equip', requireAuth, handle((req) => pe.equip(uid(req), req.params.itemId, (req.body || {}).pokemonId)));
router.post('/equipment/:itemId/unequip', requireAuth, handle((req) => pe.unequip(uid(req), req.params.itemId)));

// ── 连击 ─────────────────────────────────────────────────────
router.get('/combos', requireAuth, handle(async (req) => ({ chains: await combos.listChains(uid(req)) })));
router.get('/combos/my/stats', requireAuth, handle((req) => combos.myStats(uid(req))));
router.get('/combos/leaderboard', requireAuth, handle(async (req) => ({ leaderboard: await combos.leaderboard({ chainId: req.query.chainId, limit: req.query.limit }) })));
router.get('/combos/logs', requireAuth, handle(async (req) => ({ logs: await combos.comboLogs(uid(req), req.query.limit) })));
router.get('/combos/recommend/:pokemonId', requireAuth, handle((req) => combos.recommendForPokemon(uid(req), req.params.pokemonId)));
router.get('/combos/presets', requireAuth, handle(async (req) => ({ presets: await combos.listPresets(uid(req), req.query.pokemonId) })));
router.post('/combos/presets', requireAuth, handle((req) => combos.createPreset(uid(req), req.body || {})));
router.put('/combos/presets/:id', requireAuth, handle((req) => combos.updatePreset(uid(req), req.params.id, req.body || {})));
router.delete('/combos/presets/:id', requireAuth, handle((req) => combos.deletePreset(uid(req), req.params.id)));
router.get('/combos/:chainId', requireAuth, handle((req) => combos.chainDetail(uid(req), req.params.chainId)));
router.post('/combos/:chainId/practice', requireAuth, handle((req) => combos.practice(uid(req), req.params.chainId, req.body || {})));

// ── 伤害 ─────────────────────────────────────────────────────
router.get('/damage/typechart', requireAuth, handle(() => ({ types: TYPES, matrix: TYPE_MATRIX, size: TYPES.length * TYPES.length })));
router.post('/damage/simulate', requireAuth, handle(async (req) => {
  const b = req.body || {};
  const t0 = process.hrtime.bigint();
  const rows = await repo.getOwnedPokemon(uid(req), [b.attackerPokemonId].filter(repo.isUuid));
  if (!rows.length) throw new BattleError('POKEMON_NOT_FOUND', '攻击方精灵不存在', 404);
  const [att] = await repo.toCombatants(rows);
  const { rows: [sp] } = await query('SELECT id, name_zh, type1::text AS type1, type2::text AS type2, base_attack, base_defense, base_hp FROM pokemon_species WHERE id = $1', [Number(b.defenderSpeciesId) || 0]);
  if (!sp) throw new BattleError('SPECIES_NOT_FOUND', '防守方精灵种类不存在', 404);
  const moves = await repo.getMoves();
  const def = buildCombatant({ ...sp, id: 'sim', species_id: sp.id, cp: Math.max(10, Math.min(5000, Number(b.defenderCp) || 1000)), iv_attack: 10, iv_defense: 10, iv_hp: 10 }, moves);
  const move = att.moves.find((m) => m.id === b.moveId) || att.moves[0];
  const ds = deps.damageService();
  const r = ds.compute(att, def, move, { weather: b.weather || null });
  return { move: { id: move.id, name: move.name }, attacker: { name: att.name, attack: att.attack }, defender: { name: def.name, defense: def.defense, hp: def.maxHp },
    ...r, expected: ds.expected(att, def, move, b.weather || null), latencyMs: Number(process.hrtime.bigint() - t0) / 1e6 };
}));
router.get('/damage/cache/stats', requireAuth, handle((req) => { requireAdminRole(req); return { ...deps.damageService().stats(), ai: ai.cacheStats() }; }));
router.post('/damage/cache/refresh', requireAuth, handle((req) => { requireAdminRole(req); return deps.refreshDamageCache(); }));

// ── 技能推荐 ─────────────────────────────────────────────────
router.get('/recommendations/preferences', requireAuth, handle((req) => recommend.getPreferences(uid(req))));
router.put('/recommendations/preferences', requireAuth, handle((req) => recommend.setPreferences(uid(req), req.body || {})));
router.post('/recommendations/aggregate', requireAuth, handle((req) => { requireAdminRole(req); return recommend.aggregate(); }));
router.get('/recommendations/:speciesId', requireAuth, handle(async (req) => {
  const t0 = Date.now();
  const pref = (req.query.scenario && req.query.style) ? {} : await recommend.getPreferences(uid(req));
  const out = await recommend.recommend(req.params.speciesId, {
    scenario: req.query.scenario || pref.scenario, style: req.query.style || pref.style, limit: Math.min(20, Number(req.query.limit) || 5),
  });
  return { ...out, latencyMs: Date.now() - t0 };
}));

// ── AI 策略助手 ──────────────────────────────────────────────
router.get('/ai/preferences', requireAuth, handle((req) => session.aiPrefs(uid(req))));
router.put('/ai/preferences', requireAuth, handle(async (req) => {
  const b = req.body || {};
  const style = ['balanced', 'aggressive', 'defensive'].includes(b.style) ? b.style : 'balanced';
  const { rows: [p] } = await query(`INSERT INTO battle_ai_preferences (user_id, newbie_mode, auto_advice, style) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id) DO UPDATE SET newbie_mode = EXCLUDED.newbie_mode, auto_advice = EXCLUDED.auto_advice, style = EXCLUDED.style, updated_at = NOW()
      RETURNING newbie_mode, auto_advice, style, updated_at`, [uid(req), b.newbieMode !== false, b.autoAdvice !== false, style]);
  return p;
}));
router.get('/ai/quota', requireAuth, handle(async (req) => {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const used = Number(await getRedis().get(`battle:ai:quota:${uid(req)}:${day}`)) || 0;
  return { used, quota: session.AI_DAILY_QUOTA, remaining: Math.max(0, session.AI_DAILY_QUOTA - used) };
}));

/** 阵容优化：针对道馆（gymId）或联赛（target=league，按自己段位的典型对手）从自己精灵中选队 */
router.post('/ai/lineup', requireAuth, handle(async (req) => {
  const t0 = Date.now();
  const me = uid(req);
  const b = req.body || {};
  const quota = await session.consumeQuota(me);
  const d = await deps.getDeps();
  const { rows: cand } = await query(`SELECT ${repo.POKEMON_COLUMNS} FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
      WHERE pi.user_id = $1 AND ${repo.ACTIVE_POKEMON} AND pi.defending_gym_id IS NULL ORDER BY pi.cp DESC LIMIT 40`, [me]);
  if (!cand.length) throw new BattleError('NO_POKEMON', '没有可出战的精灵', 400);
  const candidates = await repo.toCombatants(cand);
  let defenders;
  let size = 6;
  if (b.gymId) {
    const rows = await repo.getGymDefenders((await repo.getGym(b.gymId)).id);
    if (!rows.length) throw new BattleError('GYM_EMPTY', '道馆无人驻守', 400);
    defenders = await repo.toCombatants(rows, { hpRatios: new Map(rows.map((r) => [r.id, r.gd_hp_max > 0 ? r.gd_hp_current / r.gd_hp_max : 1])) });
  } else if (Array.isArray(b.opponentSpeciesIds) && b.opponentSpeciesIds.length) {
    const { rows } = await query('SELECT id, name_zh, type1::text AS type1, type2::text AS type2, base_attack, base_defense, base_hp FROM pokemon_species WHERE id = ANY($1::int[])', [b.opponentSpeciesIds.slice(0, 6).map(Number)]);
    const moves = await repo.getMoves();
    const learn = await repo.getLearnsets(rows.map((r) => r.id));
    defenders = rows.map((s) => buildCombatant({ ...s, id: `opp-${s.id}`, species_id: s.id, cp: Number(b.opponentCp) || 1500, iv_attack: 10, iv_defense: 10, iv_hp: 10 }, moves, { learnset: learn.get(s.id) || [] }));
    size = Math.min(6, Number(b.size) || 3);
  } else {
    throw new BattleError('BAD_REQUEST', '请提供 gymId 或 opponentSpeciesIds', 400);
  }
  const result = ai.optimizeLineup(candidates, defenders, d, { size });
  // 预测所选阵容的胜率
  const picked = result.team.map((t) => candidates.find((c) => c.pokemonId === t.pokemonId));
  const sim = createBattle({ id: `lineup-${me}`, type: 'sim', mode: b.gymId ? 'PVE' : 'TOURNAMENT', userId: me, attackerTeam: JSON.parse(JSON.stringify(picked)), defenderTeam: JSON.parse(JSON.stringify(defenders)), seed: 1 });
  const p = ai.predict(sim, d, { simulations: 24 });
  const variant = ai.variantFor(me, await session.variantPercent());
  await session.logAdvice(me, null, 'lineup', { variant, action: { team: result.team.map((t) => t.pokemonId) }, winProbability: p.winProbability, latencyMs: Date.now() - t0 });
  battleMetrics.aiRequests.inc({ type: 'lineup', variant, cache: 'false' });
  battleMetrics.aiLatency.observe({ type: 'lineup' }, (Date.now() - t0) / 1000);
  return { ...result, prediction: { winProbability: p.winProbability, expectedTurns: p.expectedTurns }, pokemonIds: result.team.map((t) => t.pokemonId), quota, latencyMs: Date.now() - t0 };
}));

router.get('/ai/reviews', requireAuth, handle(async (req) => {
  const { rows } = await query('SELECT battle_id, battle_type, result, score, review->>\'grade\' AS grade, created_at FROM battle_ai_reviews WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [uid(req)]);
  return { reviews: rows };
}));
router.get('/ai/review/:battleId', requireAuth, handle(async (req) => {
  if (!repo.isUuid(req.params.battleId)) throw new BattleError('INVALID_ID', '战斗 ID 无效', 400);
  const { rows: [r] } = await query('SELECT battle_id, battle_type, result, score, review, created_at FROM battle_ai_reviews WHERE battle_id = $1 AND user_id = $2', [req.params.battleId, uid(req)]);
  if (!r) throw new BattleError('REVIEW_NOT_FOUND', '复盘不存在', 404);
  return r;
}));
router.post('/ai/feedback', requireAuth, handle(async (req) => {
  const b = req.body || {};
  const id = Number(b.adviceId);
  if (!Number.isInteger(id) || id <= 0) throw new BattleError('INVALID_ID', 'adviceId 无效', 400);
  const { rowCount } = await query('UPDATE battle_ai_advice_logs SET helpful = $3 WHERE id = $1 AND user_id = $2', [id, uid(req), !!b.helpful]);
  if (!rowCount) throw new BattleError('ADVICE_NOT_FOUND', '建议记录不存在', 404);
  return { adviceId: id, helpful: !!b.helpful };
}));

/** 运营看板：各实验组采纳率、满意度、预测准确率（胜率预测偏差）、时延、缓存命中 */
router.get('/ai/stats', requireAuth, handle(async (req) => {
  requireAdminRole(req);
  const days = Math.min(90, Number(req.query.days) || 7);
  const { rows: byVariant } = await query(`
    SELECT variant, advice_type, COUNT(*)::int AS requests,
           ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
           ROUND(AVG(CASE WHEN cache_hit THEN 1 ELSE 0 END)::numeric, 4) AS cache_hit_rate,
           COUNT(*) FILTER (WHERE followed IS NOT NULL)::int AS follow_samples,
           ROUND(AVG(CASE WHEN followed THEN 1 WHEN followed = FALSE THEN 0 END)::numeric, 4) AS follow_rate,
           COUNT(*) FILTER (WHERE helpful IS NOT NULL)::int AS feedback_samples,
           ROUND(AVG(CASE WHEN helpful THEN 1 WHEN helpful = FALSE THEN 0 END)::numeric, 4) AS satisfaction
      FROM battle_ai_advice_logs WHERE created_at > NOW() - make_interval(days => $1)
     GROUP BY variant, advice_type ORDER BY variant, advice_type`, [days]);
  // 预测校准：开战时的胜率预测 vs 实际结果
  const { rows: [cal] } = await query(`
    SELECT COUNT(*)::int AS samples,
           ROUND(AVG(CASE WHEN (predicted_win_prob >= 0.5) = (actual_result = 'win') THEN 1 ELSE 0 END)::numeric, 4) AS accuracy,
           ROUND(AVG(POWER(predicted_win_prob - CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END, 2))::numeric, 4) AS brier,
           ROUND(AVG(predicted_win_prob)::numeric, 4) AS mean_predicted,
           ROUND(AVG(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END)::numeric, 4) AS actual_win_rate
      FROM battle_ai_advice_logs
     WHERE advice_type = 'predict' AND turn = 0 AND actual_result IS NOT NULL AND actual_result <> 'forfeit'
       AND created_at > NOW() - make_interval(days => $1)`, [days]);
  const { rows: [rv] } = await query(`SELECT COUNT(*)::int AS reviews, ROUND(AVG(score)::numeric, 1) AS avg_score FROM battle_ai_reviews WHERE created_at > NOW() - make_interval(days => $1)`, [days]);
  const finished = await query(`SELECT COUNT(*)::int AS n FROM (SELECT id FROM gym_battles WHERE battled_at > NOW() - make_interval(days => $1)
      UNION ALL SELECT battle_id FROM league_matches WHERE match_time > NOW() - make_interval(days => $1) AND battle_id IS NOT NULL) x`, [days]);
  return {
    days, variantBPercent: await session.variantPercent(), dailyQuota: session.AI_DAILY_QUOTA, byVariant,
    prediction: { ...cal, calibrationGap: cal && cal.mean_predicted !== null ? Number(Math.abs(cal.mean_predicted - cal.actual_win_rate).toFixed(4)) : null },
    reviews: { ...rv, finishedBattles: finished.rows[0].n, coverage: finished.rows[0].n ? Number((rv.reviews / finished.rows[0].n).toFixed(4)) : null },
    cache: ai.cacheStats(),
  };
}));
router.put('/ai/experiment', requireAuth, handle(async (req) => {
  requireAdminRole(req);
  const pct = Math.max(0, Math.min(100, Number((req.body || {}).variantBPercent)));
  if (!Number.isFinite(pct)) throw new BattleError('BAD_REQUEST', 'variantBPercent 需为 0-100', 400);
  await getRedis().set('battle:ai:variant_b_percent', String(pct));
  return { variantBPercent: pct };
}));

// ── 回放分享 ─────────────────────────────────────────────────
function optionalUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { return verifyAccess(h.slice(7)).sub; } catch { return null; }
}
router.get('/replays/shared/:code', handle((req) => replay.viewShared(String(req.params.code || '').toUpperCase(), { password: req.query.password || req.headers['x-replay-password'], viewerId: optionalUser(req) })));
router.get('/replays/mine', requireAuth, handle(async (req) => ({ replays: await replay.listMine(uid(req), req.query) })));
router.get('/replays/hot', requireAuth, handle(async (req) => ({ replays: await replay.listHot({ sort: req.query.sort, limit: req.query.limit, days: req.query.days }) })));
router.get('/replays/search', requireAuth, handle(async (req) => ({
  replays: await replay.search({
    userId: repo.isUuid(req.query.userId) ? req.query.userId : undefined, nickname: req.query.nickname, speciesId: req.query.speciesId,
    battleType: req.query.type, result: req.query.result, limit: req.query.limit, offset: req.query.offset,
  }),
})));
router.get('/replays/:id', requireAuth, handle((req) => replay.getReplay(req.params.id, uid(req))));
router.get('/replays/:id/comments', requireAuth, handle(async (req) => ({ comments: await replay.listComments(req.params.id) })));
router.post('/replays/:id/comments', requireAuth, handle((req) => replay.addComment(req.params.id, uid(req), (req.body || {}).comment, (req.body || {}).parentId)));
router.post('/replays/:id/like', requireAuth, handle((req) => replay.toggleLike(req.params.id, uid(req))));
router.post('/replays/:id/share', requireAuth, handle((req) => replay.createShare(req.params.id, uid(req), req.body || {})));
router.patch('/replays/:id', requireAuth, handle((req) => replay.setVisibility(req.params.id, uid(req), (req.body || {}).isPublic)));
router.delete('/replays/:id', requireAuth, handle((req) => replay.removeReplay(req.params.id, uid(req))));

// ── 竞技联赛 ─────────────────────────────────────────────────
router.get('/league/season', requireAuth, handle(async () => league.seasonView(await league.ensureSeason())));
router.get('/league/tiers', requireAuth, handle(() => ({ tiers: league.tiers() })));
router.get('/league/me', requireAuth, handle(async (req) => {
  const s = await league.ensureSeason();
  return league.memberView(await league.getMember(uid(req), s), s);
}));
router.get('/league/leaderboard', requireAuth, handle((req) => league.leaderboard({ level: String(req.query.level || 'BRONZE').toUpperCase(), group: String(req.query.group || 'III').toUpperCase(), limit: req.query.limit })));
router.get('/league/matches', requireAuth, handle(async (req) => ({ matches: await league.matches(uid(req), req.query.limit) })));
router.get('/league/rewards', requireAuth, handle(async (req) => ({ rewards: await league.rewards(uid(req)) })));
router.post('/league/rewards/:id/claim', requireAuth, handle((req) => league.claimReward(uid(req), req.params.id)));
router.get('/league/defense-team', requireAuth, handle((req) => league.getDefenseTeam(uid(req))));
router.put('/league/defense-team', requireAuth, handle((req) => league.setDefenseTeam(uid(req), (req.body || {}).pokemonIds)));
router.post('/league/match', requireAuth, handle(async (req) => {
  const d = await deps.getDeps();
  const { state, member, season, opponent } = await league.prepareMatch(uid(req), req.body || {});
  const out = await session.begin(state, d);
  return { ...out, battleId: state.id, opponent, me: league.memberView(member, season) };
}));
router.post('/league/admin/end-season', requireAuth, handle(async (req) => {
  requireAdminRole(req);
  const { rows: [s] } = await query("UPDATE league_seasons SET end_time = NOW() WHERE status = 'active' RETURNING id, season_number");
  const next = await league.ensureSeason({ force: true });
  return { ended: s || null, current: league.seasonView(next) };
}));

// ── 客户端战斗帧率（REQ-00325） ───────────────────────────────
const PERF_CONFIG = {
  tiers: {
    low: { targetFps: 30, effects: 'low', particleLimit: 40, maxMemoryGb: 4 },
    mid: { targetFps: 45, effects: 'medium', particleLimit: 120, maxMemoryGb: 8 },
    high: { targetFps: 60, effects: 'high', particleLimit: 300 },
  },
  degrade: { sampleWindowMs: 2000, downgradeBelowRatio: 0.85, upgradeAboveRatio: 0.98, cooldownMs: 5000 },
  report: { intervalMs: 30000, maxBatch: 20 },
};
router.get('/perf/config', requireAuth, handle(() => PERF_CONFIG));

function perfRow(r) {
  const tier = ['low', 'mid', 'high'].includes(r.deviceTier) ? r.deviceTier : null;
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : null);
  const avg = num(r.avgFps, 0, 240);
  const target = num(r.targetFps, 1, 240);
  if (!tier || avg === null || target === null) return null;
  return [tier, num(r.deviceMemoryGb, 0, 64), num(r.cpuCores, 0, 128), Math.round(target), avg, num(r.p5Fps, 0, 240),
    Math.round(num(r.droppedFrames, 0, 1e7) || 0), ['low', 'medium', 'high'].includes(r.effectsLevel) ? r.effectsLevel : null,
    Math.round(num(r.degradeEvents, 0, 1e5) || 0), num(r.networkRttMs, 0, 60000), num(r.jsHeapMb, 0, 1e5),
    repo.isUuid(r.battleId) ? r.battleId : null];
}
router.post('/perf/report', requireAuth, handle(async (req, res) => {
  const b = req.body || {};
  const list = (Array.isArray(b.reports) ? b.reports : [b]).slice(0, PERF_CONFIG.report.maxBatch);
  const rows = list.map(perfRow).filter(Boolean);
  if (!rows.length) throw new BattleError('BAD_REPORT', '上报数据无效（需要 deviceTier/targetFps/avgFps）', 400);
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  const vals = [];
  const params = [];
  for (const r of rows) {
    const base = params.length;
    vals.push(`(${[...Array(14)].map((_, i) => `$${base + i + 1}`).join(',')})`);
    params.push(uid(req), ...r, ua);
    battleMetrics.clientFps.observe({ tier: r[0] }, r[4]);
  }
  await query(`INSERT INTO client_battle_perf_reports (user_id, device_tier, device_memory_gb, cpu_cores, target_fps, avg_fps, p5_fps, dropped_frames,
      effects_level, degrade_events, network_rtt_ms, js_heap_mb, battle_id, user_agent) VALUES ${vals.join(',')}`, params);
  res.status(202);
  return { accepted: rows.length, rejected: list.length - rows.length };
}));
router.get('/perf/dashboard', requireAuth, handle(async (req) => {
  requireAdminRole(req);
  const hours = Math.min(24 * 30, Number(req.query.hours) || 24);
  const { rows } = await query(`
    SELECT device_tier, COUNT(*)::int AS reports, ROUND(AVG(avg_fps)::numeric, 2) AS avg_fps,
           ROUND(AVG(p5_fps)::numeric, 2) AS avg_p5_fps,
           ROUND(AVG(CASE WHEN avg_fps >= target_fps * 0.95 THEN 1 ELSE 0 END)::numeric, 4) AS on_target_rate,
           ROUND(AVG(CASE WHEN avg_fps >= CASE device_tier WHEN 'low' THEN 30 WHEN 'mid' THEN 45 ELSE 60 END * 0.95 THEN 1 ELSE 0 END)::numeric, 4) AS meets_tier_goal_rate,
           ROUND(AVG(degrade_events)::numeric, 2) AS avg_degrade_events, ROUND(AVG(js_heap_mb)::numeric, 1) AS avg_heap_mb,
           ROUND(AVG(network_rtt_ms)::numeric, 0) AS avg_rtt_ms
      FROM client_battle_perf_reports WHERE created_at > NOW() - make_interval(hours => $1)
     GROUP BY device_tier ORDER BY CASE device_tier WHEN 'low' THEN 1 WHEN 'mid' THEN 2 ELSE 3 END`, [hours]);
  const { rows: effects } = await query(`SELECT effects_level, COUNT(*)::int AS reports FROM client_battle_perf_reports
      WHERE created_at > NOW() - make_interval(hours => $1) GROUP BY effects_level`, [hours]);
  return { hours, goals: { low: 30, mid: 45, high: 60 }, tiers: rows, effects };
}));

module.exports = router;
