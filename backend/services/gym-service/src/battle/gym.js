// 道馆对战：开战校验、阵容构建、胜负结算（gym_defenders / gyms.controlling_team / gym_battles / 奖励）
'use strict';

const { transaction } = require('../../../../shared/db');
const repo = require('./repo');
const { BattleError, createBattle, summarize } = require('./engine');
const { randomSeed } = require('./rng');
const { persistBattleStats } = require('./settle');

const RADIUS_M = Number(process.env.GYM_INTERACT_RADIUS_M || 100);
const MAX_TEAM = 6;

function parseTeamIds(body = {}) {
  const ids = body.pokemonIds || body.teamIds || body.attackerPokemons;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TEAM) {
    throw new BattleError('BAD_TEAM', `请选择 1-${MAX_TEAM} 只精灵组成战斗队伍`, 400);
  }
  if (!ids.every(repo.isUuid)) throw new BattleError('BAD_TEAM', '精灵 ID 无效', 400);
  if (new Set(ids).size !== ids.length) throw new BattleError('BAD_TEAM', '队伍中有重复的精灵', 400);
  return ids;
}

/** 校验出战精灵：属于本人、未放生、未驻守道馆 */
async function loadAttackers(userId, ids) {
  const rows = await repo.getOwnedPokemon(userId, ids);
  if (rows.length !== ids.length) throw new BattleError('POKEMON_UNAVAILABLE', '部分精灵不存在或不属于你', 400);
  const defending = rows.filter((r) => r.defending_gym_id);
  if (defending.length) throw new BattleError('POKEMON_DEFENDING', '驻守道馆中的精灵不能出战', 400, { pokemonIds: defending.map((r) => r.id) });
  return repo.toCombatants(rows);
}

/**
 * 构建道馆战斗状态（未保存）
 */
async function prepareGymBattle(userId, gymId, body) {
  const ids = parseTeamIds(body);
  const [user, gym] = await Promise.all([repo.getUser(userId), repo.getGym(gymId)]);
  if (!gym.is_active) throw new BattleError('GYM_INACTIVE', '道馆暂不可用', 400);
  if (!user.team) throw new BattleError('TEAM_REQUIRED', '请先加入一个队伍', 400);
  if (gym.controlling_team && gym.controlling_team === user.team) throw new BattleError('GYM_OWN_TEAM', '不能挑战己方队伍的道馆', 400);
  await repo.assertNear(userId, gym.lat, gym.lng, RADIUS_M, '道馆');
  const defenderRows = await repo.getGymDefenders(gymId);
  if (!defenderRows.length) throw new BattleError('GYM_EMPTY', '道馆无人驻守，可直接派驻精灵占领', 400);

  const attackers = await loadAttackers(userId, ids);
  const hpRatios = new Map(defenderRows.map((r) => [r.id, r.gd_hp_max > 0 ? r.gd_hp_current / r.gd_hp_max : 1]));
  const extra = new Map(defenderRows.map((r) => [r.id, { gymDefenderId: r.gym_defender_id, ownerId: r.defender_user_id }]));
  const defenders = await repo.toCombatants(defenderRows, { hpRatios, extra });

  const state = createBattle({
    id: require('crypto').randomUUID(), type: 'gym', mode: 'PVE', userId, trainerLevel: Number(user.level) || 1,
    attackerTeam: attackers, defenderTeam: defenders, seed: randomSeed(), weather: process.env.BATTLE_WEATHER || null,
    meta: {
      gymId: gym.id, gymName: gym.name, userTeam: user.team, defenderTeam: gym.controlling_team,
      nickname: user.nickname, pokemonIds: ids,
      defenders: defenderRows.map((r) => ({ gymDefenderId: r.gym_defender_id, ownerId: r.defender_user_id, pokemonId: r.id, assignedAt: r.assigned_at })),
    },
  });
  return { state, gym };
}

/**
 * 结算（单事务）：写 gym_battles、移除被击倒的驻守精灵并给主人发放驻守金币、更新存活驻守精灵士气、
 * 道馆无人驻守时变为中立、发放攻方奖励、战绩/熟练度/连击/技能日志。重复结算（同 battleId）直接跳过。
 */
async function settleGym(state) {
  const sum = summarize(state);
  const gymId = state.meta.gymId;
  const won = sum.result === 'win';
  const defeated = sum.defendersDefeated.length;
  const xp = (won ? 150 + 50 * defeated : 25 * defeated) + (sum.comboXp || 0);
  const stardust = won ? 500 : 100 * defeated;

  const outcome = await transaction(async (client) => {
    const ins = await client.query(`
      INSERT INTO gym_battles (id, gym_id, attacker_id, attacker_user_id, defender_team, attacker_team, result, damage_dealt,
         duration_sec, battle_duration_ms, turns_played, defenders_defeated, defenders_total, attacker_pokemon_ids,
         prestige_gained, experience_gained, stardust_gained, coins_gained, combos_triggered, completed_at, created_at)
      VALUES ($1,$2,$3,$3,$4::team_enum,$5::team_enum,$6::gym_battle_result_enum,$7,$8,$9,$10,$11,$12,$13::uuid[],$14,$15,$16,0,$17,NOW(),NOW())
      ON CONFLICT (id) DO NOTHING RETURNING id`,
    [state.id, gymId, state.userId, state.meta.defenderTeam || state.meta.userTeam, state.meta.userTeam, won ? 'WIN' : 'LOSE',
      sum.damageDealt, Math.round(sum.durationMs / 1000), sum.durationMs, sum.turns, defeated, state.defender.team.length,
      state.meta.pokemonIds, -500 * defeated, xp, stardust, sum.combos.length]);
    if (!ins.rowCount) return { duplicate: true };

    await client.query('SELECT id FROM gyms WHERE id = $1 FOR UPDATE', [gymId]);

    // 被击倒的驻守精灵离开道馆，按驻守时长给主人金币（每 10 分钟 1 枚，上限 50）
    const koIds = sum.defendersDefeated.map((c) => c.gymDefenderId).filter(Boolean);
    const { rows: removed } = koIds.length ? await client.query(`
      DELETE FROM gym_defenders WHERE gym_id = $1 AND id = ANY($2::uuid[])
      RETURNING id, user_id, pokemon_id, assigned_at`, [gymId, koIds]) : { rows: [] };
    const coinsByOwner = new Map();
    for (const r of removed) {
      const minutes = (Date.now() - new Date(r.assigned_at).getTime()) / 60000;
      const coins = Math.max(0, Math.min(50, Math.floor(minutes / 10)));
      coinsByOwner.set(r.user_id, (coinsByOwner.get(r.user_id) || 0) + coins);
    }
    if (removed.length) {
      await client.query('UPDATE pokemon_instances SET defending_gym_id = NULL, updated_at = NOW() WHERE id = ANY($1::uuid[])', [removed.map((r) => r.pokemon_id)]);
    }
    for (const [owner, coins] of coinsByOwner) {
      if (coins > 0) await client.query('UPDATE users SET coins = coins + $2 WHERE id = $1', [owner, coins]);
    }

    // 存活的驻守精灵：士气（hp_current）按剩余 HP 比例下降，驻守场次 +1
    for (const c of sum.defendersRemaining) {
      if (!c.gymDefenderId) continue;
      await client.query(`UPDATE gym_defenders SET hp_current = GREATEST(1, ROUND(hp_max * $2::numeric)), battles_defended = battles_defended + 1
         WHERE id = $1 AND gym_id = $3`, [c.gymDefenderId, c.hp / c.maxHp, gymId]);
    }

    const { rows: [{ n }] } = await client.query('SELECT COUNT(*)::int AS n FROM gym_defenders WHERE gym_id = $1', [gymId]);
    let gymNeutral = false;
    if (n === 0) {
      await client.query('UPDATE gyms SET controlling_team = NULL, prestige = 0, updated_at = NOW() WHERE id = $1', [gymId]);
      gymNeutral = true;
    } else if (defeated) {
      await client.query('UPDATE gyms SET prestige = GREATEST(0, prestige - $2), updated_at = NOW() WHERE id = $1', [gymId, 500 * defeated]);
    }

    await client.query('UPDATE users SET xp = xp + $2, stardust = stardust + $3, updated_at = NOW() WHERE id = $1', [state.userId, xp, stardust]);
    await persistBattleStats(client, state, sum);
    return { duplicate: false, removedDefenders: removed.length, remainingDefenders: n, gymNeutral, ownerCoins: Object.fromEntries(coinsByOwner) };
  });

  return {
    sum,
    settlement: {
      result: sum.result, turns: sum.turns, defendersDefeated: defeated, defendersTotal: state.defender.team.length,
      gymNeutral: !!outcome.gymNeutral, remainingDefenders: outcome.remainingDefenders,
      rewards: outcome.duplicate ? null : { xp, stardust, comboXp: sum.comboXp || 0 },
      combos: sum.combos.length, comboPoints: sum.comboPoints, duplicate: !!outcome.duplicate,
    },
    replayOpts: { gymId, labels: { gymName: state.meta.gymName, attackerNickname: state.meta.nickname } },
  };
}

module.exports = { prepareGymBattle, settleGym, parseTeamIds, loadAttackers, RADIUS_M };
