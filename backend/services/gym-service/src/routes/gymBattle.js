// 道馆对战路由（替换原 routes/battle.js：原实现查询不存在的 pokemon / gym_pokemon 表且无网关入口）
//
// 经网关 /v1/gyms/* → gym-service /gyms/*：
//   POST /gyms/:gymId/battle/start          开始挑战（body: { pokemonIds: [1-6 个精灵 ID] }）
//   GET  /gyms/battles/history              我的道馆对战记录
//   GET  /gyms/battles/:battleId            当前战斗状态
//   POST /gyms/battles/:battleId/turn       出招（body: { moveId } 或 { useAdvice: true }）；伤害由服务端计算
//   POST /gyms/battles/:battleId/switch     换人（body: { pokemonId }）
//   POST /gyms/battles/:battleId/combo      一键释放连招预设（body: { presetId }）
//   POST /gyms/battles/:battleId/forfeit    认输
//   GET  /gyms/battles/:battleId/advice     AI 实时建议（计每日配额）
//   GET  /gyms/battles/:battleId/predict    胜率预测
//   GET  /gyms/battles/:battleId/replay     战斗回放
// 同样的回合接口也以 /battle/sessions/:battleId/* 暴露（联赛等其他战斗类型共用）。
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const { query } = require('../../../../shared/db');
const { handle, userId } = require('../battle/http');
const session = require('../battle/session');
const gym = require('../battle/gym');
const replay = require('../battle/replay');
const combos = require('../battle/comboPresets');
const { getDeps } = require('../battle/deps');

session.registerSettler('gym', gym.settleGym);

const router = express.Router();

async function startGym(req) {
  const deps = await getDeps();
  const { state, gym: g } = await gym.prepareGymBattle(userId(req), req.params.gymId, req.body || {});
  const out = await session.begin(state, deps);
  return { ...out, battleId: state.id, gym: { id: g.id, name: g.name, controllingTeam: g.controlling_team, prestige: g.prestige } };
}

router.post('/gyms/:gymId/battle/start', requireAuth, handle(startGym));
router.post('/gyms/:gymId/battle', requireAuth, handle(startGym));

router.get('/gyms/battles/history', requireAuth, handle(async (req) => {
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const { rows } = await query(`
    SELECT gb.id AS battle_id, gb.gym_id, g.name AS gym_name, gb.result, gb.turns_played, gb.defenders_defeated, gb.defenders_total,
           gb.experience_gained, gb.stardust_gained, gb.combos_triggered, gb.battle_duration_ms, gb.battled_at,
           r.id AS replay_id
      FROM gym_battles gb
      JOIN gyms g ON g.id = gb.gym_id
      LEFT JOIN battle_replay_records r ON r.battle_id = gb.id
     WHERE gb.attacker_id = $1
     ORDER BY gb.battled_at DESC LIMIT $2`, [userId(req), limit]);
  return { battles: rows };
}));

function sessionRoutes(prefix) {
  router.get(`${prefix}/:battleId`, requireAuth, handle((req) => session.getBattle(userId(req), req.params.battleId)));
  router.post(`${prefix}/:battleId/turn`, requireAuth, handle((req) => session.takeTurn(userId(req), req.params.battleId, req.body || {})));
  router.post(`${prefix}/:battleId/switch`, requireAuth, handle((req) => session.switchPokemon(userId(req), req.params.battleId, (req.body || {}).pokemonId)));
  router.post(`${prefix}/:battleId/combo`, requireAuth, handle((req) => combos.executePreset(userId(req), req.params.battleId, (req.body || {}).presetId)));
  router.post(`${prefix}/:battleId/forfeit`, requireAuth, handle((req) => session.forfeit(userId(req), req.params.battleId)));
  router.get(`${prefix}/:battleId/advice`, requireAuth, handle((req) => session.advice(userId(req), req.params.battleId)));
  router.get(`${prefix}/:battleId/predict`, requireAuth, handle((req) => session.predictBattle(userId(req), req.params.battleId)));
  router.get(`${prefix}/:battleId/replay`, requireAuth, handle((req) => replay.getReplayByBattle(req.params.battleId, userId(req))));
}
sessionRoutes('/gyms/battles');
sessionRoutes('/battle/sessions');

module.exports = router;
