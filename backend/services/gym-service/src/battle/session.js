// 进行中战斗的通用操作（道馆 / 联赛共用）：开始、回合、换人、一键连招、认输、AI 建议与预测、结算分派
'use strict';

const { query } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { createLogger } = require('../../../../shared/logger');
const engine = require('./engine');
const store = require('./store');
const ai = require('./ai');
const { getDeps } = require('./deps');
const { afterSettle } = require('./settle');
const battleMetrics = require('./metrics');

const { BattleError } = engine;
const logger = createLogger('battle-session');
const AI_DAILY_QUOTA = Number(process.env.AI_DAILY_QUOTA || 200);
const settlers = {};

/** 注册各战斗类型的结算函数：(state) => { sum, settlement, replayOpts } */
function registerSettler(type, fn) { settlers[type] = fn; }

async function aiPrefs(userId) {
  const { rows: [p] } = await query('SELECT newbie_mode, auto_advice, style FROM battle_ai_preferences WHERE user_id = $1', [userId]);
  return p || { newbie_mode: true, auto_advice: true, style: 'balanced' };
}

async function variantPercent() {
  try {
    const v = await getRedis().get('battle:ai:variant_b_percent');
    if (v !== null && v !== undefined && v !== '') return Math.max(0, Math.min(100, Number(v)));
  } catch { /* ignore */ }
  return Number(process.env.AI_VARIANT_B_PERCENT || 50);
}

async function logAdvice(userId, state, type, payload) {
  try {
    const { rows: [r] } = await query(`INSERT INTO battle_ai_advice_logs (user_id, battle_id, advice_type, variant, turn, recommended_action, predicted_win_prob, latency_ms, cache_hit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [userId, state ? state.id : null, type, payload.variant || 'A', state ? state.turn : null,
      payload.action ? JSON.stringify(payload.action) : null, payload.winProbability ?? null, payload.latencyMs ?? null, !!payload.cacheHit]);
    return r.id;
  } catch (err) {
    logger.warn({ err }, 'advice log failed');
    return null;
  }
}

/** AI 每日配额（显式请求才计数；自动建议不计） */
async function consumeQuota(userId) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `battle:ai:quota:${userId}:${day}`;
  const r = getRedis();
  const used = await r.incr(key);
  if (used === 1) await r.expire(key, 2 * 86400);
  if (used > AI_DAILY_QUOTA) throw new BattleError('AI_QUOTA_EXCEEDED', `今日 AI 建议次数已用完（${AI_DAILY_QUOTA} 次）`, 429, { quota: AI_DAILY_QUOTA });
  return { used, quota: AI_DAILY_QUOTA, remaining: AI_DAILY_QUOTA - used };
}

/** 新开战斗：保存状态、初始化 AI 设置与赛前胜率预测 */
async function begin(state, deps) {
  const existing = await store.activeBattleId(state.userId);
  if (existing) {
    const s = await store.load(existing);
    if (s && s.status === 'active') throw new BattleError('BATTLE_IN_PROGRESS', '你有一场未结束的战斗', 409, { battleId: existing });
  }
  state.comboState.mastery = await require('./repo').getComboMastery(state.userId).catch(() => ({}));
  const prefs = await aiPrefs(state.userId);
  const variant = ai.variantFor(state.userId, await variantPercent());
  state.meta.ai = { variant, style: prefs.style, auto: !!(prefs.auto_advice && (prefs.newbie_mode || state.trainerLevel < 10)), trace: [], lastAdvice: null };
  const t0 = Date.now();
  const prediction = ai.predict(state, deps);
  state.meta.ai.initialWinProbability = prediction.winProbability;
  await logAdvice(state.userId, state, 'predict', { variant, winProbability: prediction.winProbability, latencyMs: Date.now() - t0 });
  await store.save(state);
  battleMetrics.battlesStarted.inc({ type: state.type });
  const view = engine.publicView(state, deps);
  const out = { battle: view, prediction: { winProbability: prediction.winProbability, expectedTurns: prediction.expectedTurns } };
  if (state.meta.ai.auto) out.advice = slimAdvice(ai.adviseMove(state, deps, { variant, style: prefs.style }));
  return out;
}

function slimAdvice(a) {
  return { best: a.best, recommendations: a.recommendations.slice(0, 3), switchSuggestion: a.switchSuggestion, comboHints: a.comboHints, defender: a.defender, variant: a.variant };
}

async function loadOwned(userId, battleId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(battleId))) throw new BattleError('INVALID_ID', '战斗 ID 无效', 400);
  const state = await store.load(battleId);
  if (!state) throw new BattleError('BATTLE_NOT_FOUND', '战斗不存在或已过期', 404);
  if (state.userId !== userId) throw new BattleError('FORBIDDEN', '无权操作此战斗', 403);
  return state;
}

async function finalize(state) {
  const settle = settlers[state.type];
  if (!settle) throw new Error(`no settler for ${state.type}`);
  const { sum, settlement, replayOpts } = await settle(state);
  await store.remove(state);
  const post = settlement.duplicate ? {} : await afterSettle(state, sum, replayOpts);
  return { ...settlement, replayId: post.replayId || null, highlights: post.highlights || [], review: post.review || null };
}

/** 记录 AI 轨迹（战后复盘用）：本回合推荐 vs 实际选择 */
function traceTurn(state, deps, chosen) {
  try {
    const a = ai.adviseMove(state, deps, { variant: state.meta.ai.variant, style: state.meta.ai.style });
    const ko = a.recommendations.find((r) => r.ready && r.knockout && r.category === 'CHARGE');
    state.meta.ai.trace.push({ turn: state.turn + 1, recommended: a.best ? (a.best.moveId || `switch:${a.best.pokemonId}`) : null, chosen, koAvailable: ko ? ko.moveId : null });
    if (state.meta.ai.trace.length > 300) state.meta.ai.trace.shift();
    return a;
  } catch (err) {
    logger.warn({ err }, 'ai trace failed');
    return null;
  }
}

async function markFollowed(state, chosen, preTurn) {
  const last = state.meta.ai && state.meta.ai.lastAdvice;
  if (!last || last.turn !== preTurn || !last.id) return;
  const followed = last.action === chosen;
  await query('UPDATE battle_ai_advice_logs SET followed = $2 WHERE id = $1', [last.id, followed]).catch(() => {});
  state.meta.ai.lastAdvice = null;
}

async function respond(state, deps, turnEvent) {
  const out = { turn: turnEvent };
  if (state.status !== 'active') {
    out.result = await finalize(state);
    out.battle = engine.publicView(state, deps);
    return out;
  }
  await store.save(state);
  out.battle = engine.publicView(state, deps);
  if (state.meta.ai && state.meta.ai.auto) out.advice = slimAdvice(ai.adviseMove(state, deps, { variant: state.meta.ai.variant, style: state.meta.ai.style }));
  return out;
}

/**
 * 执行回合。body: { moveId } 或 { useAdvice: true }（一键执行 AI 推荐动作）
 */
async function takeTurn(userId, battleId, body = {}) {
  const timer = battleMetrics.turnDuration.startTimer();
  try {
    return await store.withLock(battleId, async () => {
      const state = await loadOwned(userId, battleId);
      if (state.status !== 'active') throw new BattleError('BATTLE_ENDED', '战斗已结束', 409);
      const deps = await getDeps();
      let moveId = body.moveId;
      if (body.useAdvice) {
        const a = ai.adviseMove(state, deps, { variant: state.meta.ai.variant, style: state.meta.ai.style });
        if (a.best && a.best.action === 'switch') return doSwitch(state, deps, a.best.pokemonId, 'advice');
        if (!a.best) throw new BattleError('NO_ADVICE', '当前没有可执行的建议', 400);
        moveId = a.best.moveId;
      }
      if (typeof moveId !== 'string' || !moveId) throw new BattleError('INVALID_MOVE', '缺少技能 moveId', 400);
      const preTurn = state.turn;
      traceTurn(state, deps, moveId);
      let turnEvent;
      try {
        // 单调时钟：一键连招的步骤延迟可能把时间推到未来，后续回合不能早于它
        const now = Math.max(Date.now(), (state.lastActionAt || 0) + 1);
        turnEvent = engine.playTurn(state, { moveId, now }, deps);
        state.lastActionAt = now;
      } catch (err) {
        state.meta.ai.trace.pop();
        if (err instanceof BattleError && ['MOVE_COOLDOWN', 'INSUFFICIENT_ENERGY'].includes(err.code)) {
          battleMetrics.cooldownRejects.inc({ reason: err.code, mode: state.mode });
        }
        throw err;
      }
      await markFollowed(state, moveId, preTurn);
      return respond(state, deps, turnEvent);
    });
  } finally {
    timer({ type: 'turn' });
  }
}

async function doSwitch(state, deps, pokemonId, source = 'user') {
  const preTurn = state.turn;
  traceTurn(state, deps, `switch:${pokemonId}`);
  let turnEvent;
  try {
    const now = Math.max(Date.now(), (state.lastActionAt || 0) + 1);
    turnEvent = engine.switchActive(state, pokemonId, { now }, deps);
    state.lastActionAt = now;
  } catch (err) {
    state.meta.ai.trace.pop();
    throw err;
  }
  await markFollowed(state, `switch:${pokemonId}`, preTurn);
  turnEvent.source = source;
  return respond(state, deps, turnEvent);
}

async function switchPokemon(userId, battleId, pokemonId) {
  return store.withLock(battleId, async () => {
    const state = await loadOwned(userId, battleId);
    return doSwitch(state, await getDeps(), pokemonId);
  });
}

async function forfeit(userId, battleId) {
  return store.withLock(battleId, async () => {
    const state = await loadOwned(userId, battleId);
    const deps = await getDeps();
    const ev = engine.forfeit(state);
    return respond(state, deps, ev);
  });
}

async function getBattle(userId, battleId) {
  const state = await loadOwned(userId, battleId);
  const deps = await getDeps();
  return { battle: engine.publicView(state, deps), log: state.log.slice(-10) };
}

/** 显式 AI 建议（计配额、写日志、带胜率预测） */
async function advice(userId, battleId) {
  const t0 = Date.now();
  const state = await loadOwned(userId, battleId);
  if (state.status !== 'active') throw new BattleError('BATTLE_ENDED', '战斗已结束', 409);
  const quota = await consumeQuota(userId);
  const deps = await getDeps();
  const a = ai.adviseMove(state, deps, { variant: state.meta.ai.variant, style: state.meta.ai.style });
  const p = ai.predict(state, deps);
  const latencyMs = Date.now() - t0;
  const action = a.best ? (a.best.moveId || `switch:${a.best.pokemonId}`) : null;
  const id = await logAdvice(userId, state, 'move', { variant: a.variant, action, winProbability: p.winProbability, latencyMs, cacheHit: a.cacheHit });
  // 记录本回合建议以便下一回合判定是否采纳（最佳努力，不抢战斗锁）
  try {
    const fresh = await store.load(battleId);
    if (fresh && fresh.turn === state.turn) {
      fresh.meta.ai.lastAdvice = { id, turn: state.turn, action };
      await store.save(fresh);
    }
  } catch { /* ignore */ }
  battleMetrics.aiRequests.inc({ type: 'move', variant: a.variant, cache: String(!!a.cacheHit) });
  battleMetrics.aiLatency.observe({ type: 'move' }, latencyMs / 1000);
  return {
    adviceId: id, ...slimAdvice(a), recommendations: a.recommendations,
    prediction: { winProbability: p.winProbability, expectedTurns: p.expectedTurns, simulations: p.simulations },
    execute: a.best ? (a.best.action === 'switch' ? { endpoint: 'switch', body: { pokemonId: a.best.pokemonId } } : { endpoint: 'turn', body: { moveId: a.best.moveId } }) : null,
    quota, latencyMs, cacheHit: !!a.cacheHit,
  };
}

async function predictBattle(userId, battleId) {
  const t0 = Date.now();
  const state = await loadOwned(userId, battleId);
  const deps = await getDeps();
  const p = ai.predict(state, deps, { simulations: 48 });
  battleMetrics.aiRequests.inc({ type: 'predict', variant: state.meta.ai.variant, cache: String(!!p.cacheHit) });
  await logAdvice(userId, state, 'predict', { variant: state.meta.ai.variant, winProbability: p.winProbability, latencyMs: Date.now() - t0, cacheHit: p.cacheHit });
  return p;
}

module.exports = {
  registerSettler, begin, takeTurn, switchPokemon, forfeit, getBattle, advice, predictBattle,
  loadOwned, respond, consumeQuota, logAdvice, aiPrefs, slimAdvice, variantPercent, AI_DAILY_QUOTA,
};
