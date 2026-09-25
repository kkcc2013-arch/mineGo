/**
 * REQ-00388：好友联合任务
 *
 * 任务进度全部由服务端根据真实数据计算（不信任客户端上报）：
 *   catch        双方在任务期间合计捕捉数量（pokemon_instances.caught_at）
 *   catch_type   双方合计捕捉指定属性的精灵数量
 *   gift_exchange 双方互相送出的礼物数量（每人至少 each 份）
 * 达成后双方各自领取一次奖励（星尘/道具入账），完成时给这对好友加友情点。
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const inventory = require('../../../../shared/inventory');
const socialEvents = require('../../../../shared/social/socialEvents');
const friendService = require('../friendService');

const bad = (msg, code = 1001, status = 400) => new AppError(code, msg, status);

/** 由原始计数计算进度（纯函数） */
function evaluateProgress(requirements, counts) {
  const req = requirements || {};
  switch (req.type) {
    case 'gift_exchange': {
      const each = Number(req.each) || 1;
      const a = Math.min(counts.giftsUser1 || 0, each);
      const b = Math.min(counts.giftsUser2 || 0, each);
      return { current: a + b, target: each * 2, user1: counts.giftsUser1 || 0, user2: counts.giftsUser2 || 0, done: a + b >= each * 2 };
    }
    case 'catch':
    case 'catch_type': {
      const target = Number(req.count) || 1;
      const u1 = counts.catchUser1 || 0;
      const u2 = counts.catchUser2 || 0;
      return { current: Math.min(u1 + u2, target), target, user1: u1, user2: u2, done: u1 + u2 >= target };
    }
    default:
      return { current: 0, target: 1, user1: 0, user2: 0, done: false };
  }
}

class JointMissionService {
  constructor({ db = dbDefault, events = socialEvents, friends = friendService } = {}) {
    this.db = db;
    this.events = events;
    this.friends = friends;
  }

  async pair(userId, friendId) {
    const { rows: [f] } = await this.db.query(`
      SELECT f.intimacy_level, u.nickname FROM friends f JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = $1 AND f.friend_user_id = $2 AND f.status = 'accepted'`, [userId, friendId]);
    if (!f) throw bad('你们还不是好友', 2006);
    return f;
  }

  async list(userId, friendId) {
    const f = await this.pair(userId, friendId);
    const [u1, u2] = [userId, friendId].sort();
    const { rows: missions } = await this.db.query(`
      SELECT id, code, mission_type, title, description, requirements, rewards, required_intimacy_level,
             time_limit_hours, difficulty FROM joint_missions WHERE is_active ORDER BY required_intimacy_level, id`);
    const { rows: prog } = await this.db.query(`
      SELECT * FROM joint_mission_progress WHERE user1_id = $1 AND user2_id = $2
       ORDER BY started_at DESC LIMIT 50`, [u1, u2]);
    const active = new Map();
    for (const p of prog) if (p.status === 'in_progress' && !active.has(p.mission_id)) active.set(p.mission_id, p);
    return {
      intimacyLevel: f.intimacy_level,
      missions: missions.map((mm) => ({
        ...mm,
        unlocked: f.intimacy_level >= mm.required_intimacy_level,
        activeProgressId: active.get(mm.id)?.id || null,
      })),
      history: await Promise.all(prog.slice(0, 20).map((p) => this.decorate(p, userId))),
    };
  }

  async start(userId, friendId, missionId) {
    const f = await this.pair(userId, friendId);
    const { rows: [mission] } = await this.db.query(
      'SELECT * FROM joint_missions WHERE (id::text = $1 OR code = $1) AND is_active', [String(missionId)]);
    if (!mission) throw bad('任务不存在', 1004, 404);
    if (f.intimacy_level < mission.required_intimacy_level) {
      throw bad(`亲密度达到 ${mission.required_intimacy_level} 级后解锁该任务`, 2018, 403);
    }
    const [u1, u2] = [userId, friendId].sort();
    let row;
    try {
      ({ rows: [row] } = await this.db.query(`
        INSERT INTO joint_mission_progress (mission_id, user1_id, user2_id, initiated_by, expires_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() + make_interval(hours => $5::int) END)
        RETURNING *`, [mission.id, u1, u2, userId, mission.time_limit_hours]));
    } catch (err) {
      if (err.code === '23505') throw bad('该任务正在进行中', 2023, 409);
      throw err;
    }
    const { rows: [me] } = await this.db.query('SELECT nickname FROM users WHERE id = $1', [userId]);
    await this.events.publish([friendId], 'joint_mission_invite', { progressId: row.id, missionTitle: mission.title, from: { id: userId, nickname: me.nickname } });
    await this.events.createReminder(this.db, {
      userId: friendId, type: 'joint_mission_invite', relatedUserId: userId,
      content: { progressId: Number(row.id), title: mission.title, nickname: me.nickname }, dedupeKey: `jm:${row.id}`,
    });
    return this.decorate(row, userId, mission);
  }

  async counts(p, mission) {
    const req = mission.requirements || {};
    const end = p.completed_at || p.expires_at || new Date(Date.now() + 1000);
    if (req.type === 'gift_exchange') {
      const { rows: [r] } = await this.db.query(`
        SELECT COUNT(*) FILTER (WHERE from_user_id = $1 AND to_user_id = $2)::int AS g1,
               COUNT(*) FILTER (WHERE from_user_id = $2 AND to_user_id = $1)::int AS g2
          FROM friend_gifts WHERE sent_at >= $3 AND sent_at <= $4
           AND ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`,
      [p.user1_id, p.user2_id, p.started_at, end]);
      return { giftsUser1: r.g1, giftsUser2: r.g2 };
    }
    const params = [[p.user1_id, p.user2_id], p.started_at, end];
    let typeCond = '';
    if (req.type === 'catch_type') {
      params.push(String(req.pokemonType || '').toLowerCase());
      typeCond = `AND EXISTS (SELECT 1 FROM pokemon_species s WHERE s.id = pi.species_id
                    AND (lower(s.type1::text) = $4 OR lower(s.type2::text) = $4))`;
    }
    const { rows } = await this.db.query(`
      SELECT pi.user_id, COUNT(*)::int AS n FROM pokemon_instances pi
       WHERE pi.user_id = ANY($1::uuid[]) AND pi.caught_at >= $2 AND pi.caught_at <= $3 ${typeCond}
       GROUP BY pi.user_id`, params);
    const by = new Map(rows.map((r) => [r.user_id, r.n]));
    return { catchUser1: by.get(p.user1_id) || 0, catchUser2: by.get(p.user2_id) || 0 };
  }

  async decorate(p, userId, mission = null) {
    const mm = mission || (await this.db.query('SELECT * FROM joint_missions WHERE id = $1', [p.mission_id])).rows[0];
    const progress = evaluateProgress(mm.requirements, await this.counts(p, mm));
    return {
      id: Number(p.id), missionId: mm.id, code: mm.code, title: mm.title, description: mm.description,
      difficulty: mm.difficulty, rewards: mm.rewards, status: p.status, progress,
      partnerId: p.user1_id === userId ? p.user2_id : p.user1_id,
      startedAt: p.started_at, expiresAt: p.expires_at, completedAt: p.completed_at,
      rewardClaimed: (p.reward_claimed_by || []).includes(userId),
    };
  }

  /** 查询进度；达成则标记完成并给这对好友加友情点（只加一次），超时则标记过期 */
  async get(userId, progressId) {
    const id = parseInt(progressId, 10);
    if (!Number.isInteger(id)) throw bad('progressId 无效');
    const { rows: [p] } = await this.db.query(
      'SELECT * FROM joint_mission_progress WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)', [id, userId]);
    if (!p) throw bad('任务进度不存在', 1004, 404);
    if (p.status !== 'in_progress') return this.decorate(p, userId);
    const { rows: [mission] } = await this.db.query('SELECT * FROM joint_missions WHERE id = $1', [p.mission_id]);
    const progress = evaluateProgress(mission.requirements, await this.counts(p, mission));
    if (progress.done) {
      const lvl = await this.db.transaction(async (c) => {
        const { rows: [upd] } = await c.query(`
          UPDATE joint_mission_progress SET status = 'completed', completed_at = NOW(), progress = $2
           WHERE id = $1 AND status = 'in_progress' RETURNING *`, [id, JSON.stringify(progress)]);
        if (!upd) return null;
        const pts = Number(mission.rewards?.friendship_points) || 50;
        const res = await this.friends.addFriendshipPoints(c, p.user1_id, p.user2_id, pts, 'joint_mission', { missionId: mission.id, progressId: id });
        await c.query(`
          INSERT INTO friend_activities (user_id, activity_type, content, visibility)
          VALUES ($1, 'joint_mission_complete', $3, 'friends'), ($2, 'joint_mission_complete', $3, 'friends')`,
        [p.user1_id, p.user2_id, JSON.stringify({ missionId: mission.id, title: mission.title })]);
        return res;
      });
      if (lvl) {
        await this.friends.emitLevelUps(lvl);
        await this.events.publish([p.user1_id, p.user2_id], 'joint_mission_completed', { progressId: id, title: mission.title });
      }
    } else if (p.expires_at && new Date(p.expires_at).getTime() < Date.now()) {
      await this.db.query("UPDATE joint_mission_progress SET status = 'expired', progress = $2 WHERE id = $1 AND status = 'in_progress'",
        [id, JSON.stringify(progress)]);
    } else {
      await this.db.query('UPDATE joint_mission_progress SET progress = $2 WHERE id = $1', [id, JSON.stringify(progress)]);
    }
    const { rows: [fresh] } = await this.db.query('SELECT * FROM joint_mission_progress WHERE id = $1', [id]);
    return this.decorate(fresh, userId, mission);
  }

  /** 领取奖励：每人一次（行锁 + reward_claimed_by 判重，并发只成功一次） */
  async claim(userId, progressId) {
    const state = await this.get(userId, progressId);
    if (state.status !== 'completed') throw bad('任务尚未完成', 2024, 400);
    const reward = await this.db.transaction(async (c) => {
      const { rows: [p] } = await c.query(
        'SELECT * FROM joint_mission_progress WHERE id = $1 FOR UPDATE', [state.id]);
      if ((p.reward_claimed_by || []).includes(userId)) return null;
      const { rows: [mission] } = await c.query('SELECT rewards FROM joint_missions WHERE id = $1', [p.mission_id]);
      const r = mission.rewards || {};
      const { rows: [fl] } = await c.query(
        'SELECT intimacy_level FROM friends WHERE user_id = $1 AND friend_user_id = $2', [userId, state.partnerId]);
      const { rows: [lv] } = await c.query('SELECT benefits FROM intimacy_levels WHERE level = $1', [fl?.intimacy_level || 1]);
      const bonus = Number(lv?.benefits?.bonus_rewards) || 1;
      const credited = [];
      if (r.stardust) {
        const dust = Math.floor(r.stardust * bonus);
        await c.query('UPDATE users SET stardust = stardust + $2 WHERE id = $1', [userId, dust]);
        credited.push({ type: 'STARDUST', qty: dust });
      }
      if (Array.isArray(r.items) && r.items.length) {
        const res = await inventory.addItems(c, userId, r.items);
        credited.push(...res.credited);
      }
      await c.query(
        'UPDATE joint_mission_progress SET reward_claimed_by = array_append(reward_claimed_by, $2) WHERE id = $1', [state.id, userId]);
      return { credited, bonus };
    });
    if (!reward) throw bad('奖励已领取', 2025, 409);
    return { success: true, progressId: state.id, rewards: reward.credited, bonusMultiplier: reward.bonus };
  }

  /** 到期任务：先按到期前的真实数据判定是否完成，未完成的标记过期 */
  async expireStale() {
    const { rows } = await this.db.query(`
      SELECT id, user1_id FROM joint_mission_progress
       WHERE status = 'in_progress' AND expires_at IS NOT NULL AND expires_at < NOW()
       ORDER BY expires_at LIMIT 200`);
    let n = 0;
    for (const r of rows) {
      try { await this.get(r.user1_id, r.id); n++; } catch { /* 忽略单条失败 */ }
    }
    return n;
  }
}

const instance = new JointMissionService();
module.exports = instance;
module.exports.JointMissionService = JointMissionService;
module.exports.evaluateProgress = evaluateProgress;
