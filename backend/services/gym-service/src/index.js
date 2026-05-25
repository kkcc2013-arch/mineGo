// gym-service/src/index.js
'use strict';
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const helmet    = require('helmet');
const { query, transaction } = require('../../../shared/db');
const { getRedis, getJSON, setJSON } = require('../../../shared/redis');
const { requireAuth, verifyAccess, AppError, successResp, errorHandler } = require('../../../shared/auth');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 8085;

app.use(helmet()); app.use(cors()); app.use(express.json());
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'gym-service' }));

// ============================================================
// WEBSOCKET — Real-time Raid sync
// ============================================================
const wss = new WebSocket.Server({ server, path: '/ws/raid' });
const raidRooms = new Map(); // raidId → Set<ws>

wss.on('connection', (ws, req) => {
  // Expect ?token=...&raidId=...
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token  = params.get('token');
  const raidId = params.get('raidId');

  let userId;
  try {
    const payload = verifyAccess(token);
    userId = payload.sub;
  } catch {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.userId = userId;
  ws.raidId = raidId;

  if (!raidRooms.has(raidId)) raidRooms.set(raidId, new Set());
  raidRooms.get(raidId).add(ws);

  console.log(`[Raid WS] User ${userId} joined raid ${raidId}`);
  broadcastToRaid(raidId, { type: 'PLAYER_JOINED', userId, participants: raidRooms.get(raidId).size });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ATTACK') {
        await handleRaidAttack(ws.userId, ws.raidId, msg.moveId, msg.damage);
      }
    } catch (e) { console.error('[Raid WS] Message error', e); }
  });

  ws.on('close', () => {
    raidRooms.get(raidId)?.delete(ws);
    broadcastToRaid(raidId, { type: 'PLAYER_LEFT', userId, participants: raidRooms.get(raidId)?.size || 0 });
  });
});

function broadcastToRaid(raidId, data) {
  const room = raidRooms.get(raidId);
  if (!room) return;
  const msg = JSON.stringify(data);
  for (const ws of room) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

async function handleRaidAttack(userId, raidId, moveId, clientDamage) {
  const raidKey = `raid:${raidId}`;
  const raid    = await getJSON(raidKey);
  if (!raid || raid.status !== 'ACTIVE') return;

  // Server-side damage validation (simplified)
  const damage = Math.min(clientDamage || 50, 500); // cap per hit

  // Atomic decrement HP in Redis
  const redis = getRedis();
  const newHp = await redis.decrby(`raid:${raidId}:hp`, damage);

  // Record damage for participant
  await query(`
    UPDATE raid_participants SET damage_dealt = damage_dealt + $1
    WHERE raid_id=$2 AND user_id=$3
  `, [damage, raidId, userId]);

  const bossDefeated = newHp <= 0;

  broadcastToRaid(raidId, {
    type: 'RAID_ATTACK',
    attackerId: userId,
    damage,
    bossHpRemaining: Math.max(0, newHp),
    bossDefeated,
  });

  if (bossDefeated) {
    await query(`UPDATE raids SET status='COMPLETED', updated_at=NOW() WHERE id=$1`, [raidId]);
    await redis.del(`raid:${raidId}:hp`);
    broadcastToRaid(raidId, { type: 'RAID_COMPLETED', raidId });
  }
}

// ============================================================
// GYM REST ROUTES
// ============================================================

// GET /gyms/:id
app.get('/gyms/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [gym] } = await query(`
      SELECT g.*, 
        json_agg(json_build_object(
          'id', gd.id, 'userId', gd.user_id, 'pokemonId', gd.pokemon_id,
          'hpCurrent', gd.hp_current, 'hpMax', gd.hp_max, 'assignedAt', gd.assigned_at,
          'cp', pi.cp, 'speciesId', pi.species_id, 'nickname', pi.nickname
        ) ORDER BY gd.assigned_at) FILTER (WHERE gd.id IS NOT NULL) AS defenders
      FROM gyms g
      LEFT JOIN gym_defenders gd ON gd.gym_id = g.id
      LEFT JOIN pokemon_instances pi ON pi.id = gd.pokemon_id
      WHERE g.id = $1
      GROUP BY g.id
    `, [req.params.id]);

    if (!gym) throw new AppError(4001, '道馆不存在', 404);
    res.json(successResp(gym));
  } catch (err) { next(err); }
});

// POST /gyms/:id/defend  — assign pokemon to gym
app.post('/gyms/:id/defend', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId } = req.body;
    const userId = req.user.sub;
    const gymId  = req.params.id;

    const { rows: [user] } = await query('SELECT team FROM users WHERE id=$1', [userId]);
    const { rows: [gym]  } = await query('SELECT controlling_team FROM gyms WHERE id=$1', [gymId]);

    if (!gym) throw new AppError(4001, '道馆不存在', 404);
    if (gym.controlling_team && gym.controlling_team !== user.team) {
      throw new AppError(4002, '道馆不属于你的队伍，请先挑战', 400);
    }

    // Max 6 defenders
    const { rows: [cnt] } = await query(
      'SELECT COUNT(*)::int AS n FROM gym_defenders WHERE gym_id=$1', [gymId]
    );
    if (cnt.n >= 6) throw new AppError(4003, '道馆已满（最多6只精灵）', 400);

    // Can't place if already defending another gym
    const { rows: [pi] } = await query(
      'SELECT id, cp, hp_max, defending_gym_id FROM pokemon_instances WHERE id=$1 AND user_id=$2',
      [pokemonId, userId]
    );
    if (!pi) throw new AppError(3001, '精灵不存在', 404);
    if (pi.defending_gym_id) throw new AppError(4004, '该精灵已在其他道馆驻守', 400);

    await transaction(async (client) => {
      // Update gym team
      if (!gym.controlling_team) {
        await client.query('UPDATE gyms SET controlling_team=$1, updated_at=NOW() WHERE id=$2',
          [user.team, gymId]);
      }
      // Place defender
      await client.query(`
        INSERT INTO gym_defenders (gym_id, user_id, pokemon_id, hp_current, hp_max)
        VALUES ($1,$2,$3,$4,$4)
      `, [gymId, userId, pokemonId, pi.hp_max]);

      await client.query('UPDATE pokemon_instances SET defending_gym_id=$1 WHERE id=$2', [gymId, pokemonId]);
    });

    res.json(successResp({ message: '精灵已驻守道馆' }));
  } catch (err) { next(err); }
});

// POST /gyms/:id/battle
app.post('/gyms/:id/battle', requireAuth, async (req, res, next) => {
  try {
    const { attackerPokemons } = req.body; // array of pokemon instance IDs
    const userId = req.user.sub;
    const gymId  = req.params.id;

    if (!Array.isArray(attackerPokemons) || attackerPokemons.length === 0) {
      throw new AppError(1001, '请选择出战精灵', 400);
    }

    const { rows: [user] } = await query('SELECT team FROM users WHERE id=$1', [userId]);
    const { rows: [gym]  } = await query('SELECT controlling_team FROM gyms WHERE id=$1', [gymId]);
    if (!gym) throw new AppError(4001, '道馆不存在', 404);
    if (gym.controlling_team === user.team) {
      throw new AppError(4005, '不能攻击己方道馆', 400);
    }

    // Get defenders
    const { rows: defenders } = await query(`
      SELECT gd.id, gd.hp_current, gd.hp_max, pi.cp, pi.species_id
      FROM gym_defenders gd JOIN pokemon_instances pi ON pi.id = gd.pokemon_id
      WHERE gd.gym_id=$1 ORDER BY gd.assigned_at
    `, [gymId]);

    if (defenders.length === 0) {
      // Empty gym: just take it
      await query('UPDATE gyms SET controlling_team=$1, updated_at=NOW() WHERE id=$2', [user.team, gymId]);
      return res.json(successResp({ result: 'WIN', gymCaptured: true }));
    }

    // Simplified battle simulation
    const { rows: attPokemon } = await query(`
      SELECT id, cp, species_id FROM pokemon_instances
      WHERE id = ANY($1) AND user_id=$2
    `, [attackerPokemons, userId]);

    const attackerTotalCp = attPokemon.reduce((s, p) => s + p.cp, 0);
    const defenderTotalCp = defenders.reduce((s, d) => s + d.cp, 0);

    const attackerWin = attackerTotalCp * (1 + Math.random() * 0.2) >
                        defenderTotalCp * (1 + Math.random() * 0.3);

    const damageToDef = Math.floor(attackerTotalCp * 0.15 * (0.8 + Math.random() * 0.4));

    const result = await transaction(async (client) => {
      await client.query(`
        INSERT INTO gym_battles (gym_id, attacker_id, defender_team, attacker_team, result, damage_dealt)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [gymId, userId, gym.controlling_team, user.team,
          attackerWin ? 'WIN' : 'LOSE', damageToDef]);

      if (attackerWin) {
        // Reduce defender HP
        for (const def of defenders) {
          const newHp = Math.max(0, def.hp_current - Math.floor(damageToDef / defenders.length));
          await client.query('UPDATE gym_defenders SET hp_current=$1 WHERE id=$2', [newHp, def.id]);
          if (newHp <= 0) {
            // Remove defender
            await client.query('DELETE FROM gym_defenders WHERE id=$1', [def.id]);
            await client.query('UPDATE pokemon_instances SET defending_gym_id=NULL WHERE id=(SELECT pokemon_id FROM gym_defenders WHERE id=$1 LIMIT 1)', [def.id]);
          }
        }

        // Check if all defenders defeated
        const { rows: [remCount] } = await client.query(
          'SELECT COUNT(*)::int AS n FROM gym_defenders WHERE gym_id=$1', [gymId]
        );
        if (remCount.n === 0) {
          await client.query('UPDATE gyms SET controlling_team=$1, updated_at=NOW() WHERE id=$2',
            [user.team, gymId]);
        }

        // Award XP
        const xp = 100 + defenders.length * 50;
        await client.query('UPDATE users SET xp=xp+$1 WHERE id=$2', [xp, userId]);
        return { result: 'WIN', gymCaptured: remCount.n === 0, xpEarned: xp };
      }

      return { result: 'LOSE', gymCaptured: false, xpEarned: 25 };
    });

    res.json(successResp(result));
  } catch (err) { next(err); }
});

// ============================================================
// RAID ROUTES
// ============================================================

// GET /raids/:id
app.get('/raids/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [raid] } = await query(`
      SELECT r.*, g.name AS gym_name, g.lat, g.lng,
             ps.name_zh AS boss_name, ps.sprite_url AS boss_sprite,
             COUNT(rp.id)::int AS participant_count
      FROM raids r
      JOIN gyms g ON g.id = r.gym_id
      JOIN pokemon_species ps ON ps.id = r.boss_species_id
      LEFT JOIN raid_participants rp ON rp.raid_id = r.id
      WHERE r.id=$1 GROUP BY r.id,g.name,g.lat,g.lng,ps.name_zh,ps.sprite_url
    `, [req.params.id]);
    if (!raid) throw new AppError(4006, 'Raid 不存在', 404);
    res.json(successResp(raid));
  } catch (err) { next(err); }
});

// POST /raids/:id/join
app.post('/raids/:id/join', requireAuth, async (req, res, next) => {
  try {
    const raidId = req.params.id;
    const userId = req.user.sub;

    const { rows: [raid] } = await query(
      "SELECT * FROM raids WHERE id=$1 AND status='ACTIVE' AND ends_at > NOW()", [raidId]
    );
    if (!raid) throw new AppError(4006, 'Raid 不存在或已结束', 404);

    const { rows: [cnt] } = await query(
      'SELECT COUNT(*)::int AS n FROM raid_participants WHERE raid_id=$1', [raidId]
    );
    if (cnt.n >= raid.max_participants) throw new AppError(4007, 'Raid 人数已满', 400);

    await query(`
      INSERT INTO raid_participants (raid_id, user_id) VALUES ($1,$2)
      ON CONFLICT (raid_id, user_id) DO NOTHING
    `, [raidId, userId]);

    // Set boss HP in Redis if not yet
    const redis = getRedis();
    const hpKey = `raid:${raidId}:hp`;
    const exists = await redis.exists(hpKey);
    if (!exists) {
      const ttl = Math.floor((new Date(raid.ends_at) - Date.now()) / 1000);
      await redis.setex(hpKey, ttl, raid.boss_hp_max.toString());
    }

    broadcastToRaid(raidId, { type: 'PLAYER_JOINED', userId });

    res.json(successResp({
      raidId, bossSpeciesId: raid.boss_species_id,
      bossHpMax: raid.boss_hp_max, raidLevel: raid.raid_level,
      endsAt: raid.ends_at, ballsGranted: 6,
    }));
  } catch (err) { next(err); }
});

app.use(errorHandler);
server.listen(PORT, () => console.log(`[gym-service] listening on :${PORT}`));
module.exports = app;
