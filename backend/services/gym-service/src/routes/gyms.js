// 道馆基础路由（经网关 /v1/gyms/* → gym-service /gyms/*）
//   GET  /gyms/nearby?lat&lng&radius   附近道馆（原网关已路由但服务缺实现，命中 /gyms/:id 报 500）
//   GET  /gyms/:id                     道馆详情与驻守精灵
//   POST /gyms/:id/defend              派驻精灵（需在道馆 100 米内；己方或中立道馆；最多 6 只；每人每馆 1 只）
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const { query, transaction } = require('../../../../shared/db');
const { handle, userId } = require('../battle/http');
const { BattleError } = require('../battle/engine');
const repo = require('../battle/repo');
const { RADIUS_M } = require('../battle/gym');
const { battleViews } = require('../../../../shared/social/pokemonPrivacyStore');

const router = express.Router();

router.get('/gyms/nearby', requireAuth, handle(async (req) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new BattleError('BAD_LOCATION', 'lat/lng 无效', 400);
  const radius = Math.max(50, Math.min(20000, Number(req.query.radius) || 2000));
  const { rows } = await query(`
    SELECT g.id, g.name, g.lat, g.lng, g.controlling_team::text AS controlling_team, g.prestige, g.image_url,
           (SELECT COUNT(*)::int FROM gym_defenders gd WHERE gd.gym_id = g.id) AS defender_count,
           r.id AS raid_id, r.raid_level, r.boss_species_id, r.status::text AS raid_status, r.ends_at AS raid_ends_at,
           ST_Distance(g.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_m
      FROM gyms g
      LEFT JOIN LATERAL (
        SELECT id, raid_level, boss_species_id, status, ends_at FROM raids
         WHERE gym_id = g.id AND status IN ('PENDING','ACTIVE') AND ends_at > NOW()
         ORDER BY starts_at DESC LIMIT 1) r ON TRUE
     WHERE g.is_active AND ST_DWithin(g.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
     ORDER BY distance_m LIMIT 50`, [lat, lng, radius]);
  return {
    radius,
    gyms: rows.map((g) => ({
      id: g.id, name: g.name, lat: Number(g.lat), lng: Number(g.lng), controllingTeam: g.controlling_team, prestige: g.prestige,
      imageUrl: g.image_url, defenderCount: g.defender_count, distanceM: Math.round(Number(g.distance_m)),
      raid: g.raid_id ? { id: g.raid_id, level: g.raid_level, bossSpeciesId: g.boss_species_id, status: g.raid_status, endsAt: g.raid_ends_at } : null,
    })),
  };
}));

router.get('/gyms/:id', requireAuth, handle(async (req) => {
  if (!repo.isUuid(req.params.id)) throw new BattleError('INVALID_ID', '道馆 ID 无效', 400);
  const { rows: [gym] } = await query(`
    SELECT g.id, g.name, g.lat, g.lng, g.image_url, g.controlling_team::text AS controlling_team, g.prestige, g.is_active,
      COALESCE(json_agg(json_build_object(
        'id', gd.id, 'userId', gd.user_id, 'pokemonId', gd.pokemon_id,
        'hpCurrent', gd.hp_current, 'hpMax', gd.hp_max, 'assignedAt', gd.assigned_at, 'battlesDefended', gd.battles_defended,
        'cp', pi.cp, 'speciesId', pi.species_id, 'nickname', pi.nickname, 'speciesName', ps.name_zh
      ) ORDER BY gd.assigned_at) FILTER (WHERE gd.id IS NOT NULL), '[]') AS defenders
    FROM gyms g
    LEFT JOIN gym_defenders gd ON gd.gym_id = g.id
    LEFT JOIN pokemon_instances pi ON pi.id = gd.pokemon_id
    LEFT JOIN pokemon_species ps ON ps.id = pi.species_id
    WHERE g.id = $1
    GROUP BY g.id`, [req.params.id]);
  if (!gym) throw new BattleError('GYM_NOT_FOUND', '道馆不存在', 404);
  // REQ-00377 战斗匿名模式（E01）：守护精灵开启匿名时，非主人只看到种类（CP/昵称/HP 隐藏），战斗计算不受影响
  if (Array.isArray(gym.defenders) && gym.defenders.length) {
    const views = await battleViews({ query }, userId(req), gym.defenders.map((d) => ({
      id: d.pokemonId, user_id: d.userId, species_id: d.speciesId, cp: d.cp, nickname: d.nickname,
    })));
    gym.defenders = gym.defenders.map((d, i) => (views[i] && views[i].anonymous
      ? { ...d, cp: null, nickname: null, hpCurrent: null, hpMax: null, anonymous: true }
      : { ...d, anonymous: false }));
  }
  return gym;
}));

router.post('/gyms/:id/defend', requireAuth, handle(async (req) => {
  const uid = userId(req);
  const gymId = req.params.id;
  const pokemonId = (req.body || {}).pokemonId;
  if (!repo.isUuid(gymId) || !repo.isUuid(pokemonId)) throw new BattleError('INVALID_ID', 'ID 无效', 400);
  const user = await repo.getUser(uid);
  if (!user.team) throw new BattleError('TEAM_REQUIRED', '请先加入一个队伍', 400);
  const gym = await repo.getGym(gymId);
  if (!gym.is_active) throw new BattleError('GYM_INACTIVE', '道馆暂不可用', 400);
  await repo.assertNear(uid, gym.lat, gym.lng, RADIUS_M, '道馆');

  return transaction(async (client) => {
    const { rows: [g] } = await client.query('SELECT controlling_team::text AS controlling_team FROM gyms WHERE id = $1 FOR UPDATE', [gymId]);
    if (g.controlling_team && g.controlling_team !== user.team) throw new BattleError('GYM_ENEMY', '道馆不属于你的队伍，请先挑战', 400);
    const { rows: [cnt] } = await client.query('SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE user_id = $2)::int AS mine FROM gym_defenders WHERE gym_id = $1', [gymId, uid]);
    if (cnt.n >= 6) throw new BattleError('GYM_FULL', '道馆已满（最多 6 只精灵）', 400);
    if (cnt.mine > 0) throw new BattleError('ALREADY_DEFENDING', '你已在该道馆派驻了精灵', 400);
    const { rows: [pi] } = await client.query(`SELECT pi.id, pi.hp_max, pi.defending_gym_id FROM pokemon_instances pi
        WHERE pi.id = $1 AND pi.user_id = $2 AND ${repo.ACTIVE_POKEMON} FOR UPDATE`, [pokemonId, uid]);
    if (!pi) throw new BattleError('POKEMON_NOT_FOUND', '精灵不存在', 404);
    if (pi.defending_gym_id) throw new BattleError('POKEMON_DEFENDING', '该精灵已在其他道馆驻守', 400);
    if (!g.controlling_team) await client.query('UPDATE gyms SET controlling_team = $1::team_enum, updated_at = NOW() WHERE id = $2', [user.team, gymId]);
    await client.query('INSERT INTO gym_defenders (gym_id, user_id, pokemon_id, hp_current, hp_max) VALUES ($1,$2,$3,$4,$4)', [gymId, uid, pokemonId, Math.max(1, pi.hp_max)]);
    await client.query('UPDATE pokemon_instances SET defending_gym_id = $1, updated_at = NOW() WHERE id = $2', [gymId, pokemonId]);
    await client.query('UPDATE gyms SET prestige = prestige + 1000, updated_at = NOW() WHERE id = $1', [gymId]);
    return { message: '精灵已驻守道馆', gymId, pokemonId, controllingTeam: g.controlling_team || user.team, defenders: cnt.n + 1 };
  });
}));

module.exports = router;
