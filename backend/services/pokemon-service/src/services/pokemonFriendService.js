/**
 * REQ-00326：精灵好友互动系统
 *
 * - 精灵好友申请：只能向好友（玩家好友关系）的精灵发起；对方精灵主人接受/拒绝/屏蔽
 * - 五种互动（拜访/送礼/共同探险/合影/训练）：按类型冷却（每个主人独立计时），亲密度 = 基础值 × 等级倍率 × 加成
 *   加成：同种 ×1.5、属性相合 ×1.2、跨区域（捕获地相距 ≥100km）×1.3、等级奖励加成（3 级 ×1.1 / 9 级 ×1.3）
 * - 亲密度 1-10 级，升级时为双方精灵发放等级奖励（徽章/纪念品/加成/功能解锁），并经 WebSocket 通知双方主人
 * - 纪念品：合影必得、探险 30% 概率、等级奖励中的丝带/奖章/王冠
 * 并发：互动在事务内对好友关系行 FOR UPDATE，冷却判断与写入串行，重复点击只成功一次。
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const socialEvents = require('../../../../shared/social/socialEvents');
const relationship = require('../../../../shared/social/relationship');
const store = require('../../../../shared/social/pokemonPrivacyStore');
const {
  IntimacyCalculator, FRIENDSHIP_REWARDS, INTERACTION_TYPES, activeBoost, pairBonuses,
} = require('../../../../shared/social/intimacyCalculator');
const { POKEMON_COLUMNS } = require('./pokemonPrivacyService');

const calc = new IntimacyCalculator();
const MAX_FRIENDS_PER_POKEMON = 50;
const MAX_PENDING_PER_POKEMON = 20;

const bad = (msg, code = 1001, status = 400) => new AppError(code, msg, status);
const notFound = (what = '精灵好友关系') => new AppError(3001, `${what}不存在`, 404);

class PokemonFriendService {
  constructor({ db = dbDefault, events = socialEvents, rng = Math.random } = {}) {
    this.db = db;
    this.events = events;
    this.rng = rng;
  }

  async pokemonRows(q, ids) {
    const { rows } = await q.query(`
      SELECT ${POKEMON_COLUMNS}
        FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
       WHERE pi.id = ANY($1::uuid[]) AND NOT COALESCE(pi.is_released, false) AND NOT COALESCE(pi.is_deleted, false)`, [ids]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async sendRequest(userId, pokemonId, friendPokemonId, message = '') {
    if (!relationship.isUuid(pokemonId) || !relationship.isUuid(friendPokemonId)) throw bad('精灵 ID 无效');
    if (pokemonId === friendPokemonId) throw bad('不能和自己成为朋友');
    const pm = await this.pokemonRows(this.db, [pokemonId, friendPokemonId]);
    const mine = pm.get(pokemonId);
    const target = pm.get(friendPokemonId);
    if (!mine || mine.user_id !== userId) throw notFound('你的精灵');
    if (!target) throw notFound('对方精灵');
    if (target.user_id === userId) throw bad('请选择好友的精灵');
    const [view] = await store.visibleViews(this.db, userId, [target]);
    if (!view) throw notFound('对方精灵');
    const rel = await relationship.getRelationship(this.db, userId, target.user_id);
    if (rel.blocked) throw notFound('对方精灵');
    if (!rel.isFriend) throw bad('只能与好友的精灵成为朋友', 2006, 403);

    const row = await this.db.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`pkfriend:${pokemonId}`]);
      const { rows: [cnt] } = await c.query(`
        SELECT COUNT(*) FILTER (WHERE status = 'accepted')::int AS friends,
               COUNT(*) FILTER (WHERE status = 'pending' AND pokemon_id = $1)::int AS pending
          FROM pokemon_friendships WHERE pokemon_id = $1 OR friend_pokemon_id = $1`, [pokemonId]);
      if (cnt.friends >= MAX_FRIENDS_PER_POKEMON) throw bad(`每只精灵最多 ${MAX_FRIENDS_PER_POKEMON} 个精灵好友`);
      if (cnt.pending >= MAX_PENDING_PER_POKEMON) throw bad(`待处理的精灵好友申请已达上限（${MAX_PENDING_PER_POKEMON}）`);
      const { rows: [existing] } = await c.query(`
        SELECT * FROM pokemon_friendships
         WHERE LEAST(pokemon_id, friend_pokemon_id) = LEAST($1::uuid, $2::uuid)
           AND GREATEST(pokemon_id, friend_pokemon_id) = GREATEST($1::uuid, $2::uuid) FOR UPDATE`, [pokemonId, friendPokemonId]);
      if (existing) {
        if (existing.status === 'accepted') throw bad('它们已经是朋友了', 2002, 409);
        if (existing.status === 'blocked') throw notFound('对方精灵');
        if (existing.status === 'pending') {
          if (existing.pokemon_id === friendPokemonId) {
            // 对方已先发起：直接接受
            return { autoAccept: existing.id };
          }
          throw bad('已发送过申请，等待对方处理', 2014, 409);
        }
        const { rows: [upd] } = await c.query(`
          UPDATE pokemon_friendships SET pokemon_id = $2, friend_pokemon_id = $3, requester_user_id = $4,
                 addressee_user_id = $5, message = $6, status = 'pending', created_at = NOW(), responded_at = NULL
           WHERE id = $1 RETURNING *`, [existing.id, pokemonId, friendPokemonId, userId, target.user_id, message || null]);
        return upd;
      }
      const { rows: [ins] } = await c.query(`
        INSERT INTO pokemon_friendships (pokemon_id, friend_pokemon_id, requester_user_id, addressee_user_id, message)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [pokemonId, friendPokemonId, userId, target.user_id, message ? String(message).slice(0, 200) : null]);
      return ins;
    });
    if (row.autoAccept) return this.respond(userId, row.autoAccept, 'accept');

    const fromPokemon = { id: mine.id, speciesId: mine.species_id, name: mine.nickname || mine.name_zh };
    await this.events.publish([target.user_id], 'pokemon_friend_request', {
      friendshipId: row.id, fromPokemon, toPokemonId: target.id, message: row.message,
    });
    await this.events.createReminder(this.db, {
      userId: target.user_id, type: 'pokemon_friend_request', relatedUserId: userId,
      content: { friendshipId: row.id, fromPokemon, toPokemonId: target.id }, dedupeKey: `pkreq:${row.id}:${new Date(row.created_at).getTime()}`,
    });
    return { friendshipId: row.id, status: 'pending' };
  }

  async respond(userId, friendshipId, action) {
    if (!relationship.isUuid(friendshipId)) throw notFound();
    if (!['accept', 'reject', 'block'].includes(action)) throw bad('action 必须是 accept/reject/block');
    const result = await this.db.transaction(async (c) => {
      const { rows: [f] } = await c.query('SELECT * FROM pokemon_friendships WHERE id = $1 FOR UPDATE', [friendshipId]);
      if (!f || (f.addressee_user_id !== userId && f.requester_user_id !== userId)) throw notFound();
      if (action === 'block') {
        await c.query("UPDATE pokemon_friendships SET status = 'blocked', responded_at = NOW() WHERE id = $1", [f.id]);
        return { f, status: 'blocked' };
      }
      if (f.addressee_user_id !== userId) throw bad('只有对方精灵的主人可以处理申请', 1003, 403);
      if (f.status !== 'pending') throw bad('申请已处理', 2005, 409);
      if (action === 'reject') {
        await c.query("UPDATE pokemon_friendships SET status = 'rejected', responded_at = NOW() WHERE id = $1", [f.id]);
        return { f, status: 'rejected' };
      }
      const { rows: [cnt] } = await c.query(`
        SELECT COUNT(*)::int AS n FROM pokemon_friendships
         WHERE status = 'accepted' AND (pokemon_id = $1 OR friend_pokemon_id = $1)`, [f.friend_pokemon_id]);
      if (cnt.n >= MAX_FRIENDS_PER_POKEMON) throw bad(`每只精灵最多 ${MAX_FRIENDS_PER_POKEMON} 个精灵好友`);
      const { rows: [acc] } = await c.query(`
        UPDATE pokemon_friendships SET status = 'accepted', responded_at = NOW(), accepted_at = NOW(),
               friendship_level = 1, intimacy_score = 0, last_interaction_at = NOW()
         WHERE id = $1 RETURNING *`, [f.id]);
      const rewards = await this.grantLevelRewards(c, acc, [1]);
      return { f: acc, status: 'accepted', rewards };
    });
    if (result.status === 'accepted') {
      await this.events.publish([result.f.requester_user_id], 'pokemon_friend_accepted', {
        friendshipId: result.f.id, pokemonId: result.f.pokemon_id, friendPokemonId: result.f.friend_pokemon_id,
      });
    }
    return { friendshipId: result.f.id, status: result.status, rewards: result.rewards || [] };
  }

  /** 为双方精灵发放等级奖励（幂等：UNIQUE(friendship_id, pokemon_id, level)） */
  async grantLevelRewards(c, f, levels) {
    const pm = await this.pokemonRows(c, [f.pokemon_id, f.friend_pokemon_id]);
    const granted = [];
    for (const level of levels) {
      const reward = FRIENDSHIP_REWARDS[level];
      if (!reward) continue;
      for (const pid of [f.pokemon_id, f.friend_pokemon_id]) {
        const owner = pm.get(pid)?.user_id || (pid === f.pokemon_id ? f.requester_user_id : f.addressee_user_id);
        const { rowCount } = await c.query(`
          INSERT INTO pokemon_friendship_rewards (friendship_id, pokemon_id, owner_user_id, level, reward_type, reward, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $7::int) END)
          ON CONFLICT (friendship_id, pokemon_id, level) DO NOTHING`,
        [f.id, pid, owner, level, reward.type, JSON.stringify(reward), reward.days || null]);
        if (rowCount) granted.push({ level, pokemonId: pid, ...reward });
      }
      if (reward.type === 'keepsake') {
        await c.query(`
          INSERT INTO pokemon_keepsakes (friendship_id, keepsake_type, keepsake_data, rarity)
          VALUES ($1, $2, $3, $4)`, [f.id, reward.itemId, JSON.stringify({ level, title: reward.title, source: 'level_reward' }), reward.rarity]);
      }
    }
    return granted;
  }

  async lastInteractions(q, friendshipId, userId) {
    const { rows } = await q.query(`
      SELECT interaction_type, MAX(created_at) AS last_at FROM pokemon_interactions
       WHERE friendship_id = $1 AND actor_user_id = $2 GROUP BY interaction_type`, [friendshipId, userId]);
    return new Map(rows.map((r) => [r.interaction_type, r.last_at]));
  }

  cooldowns(lastMap) {
    const out = {};
    for (const t of Object.keys(INTERACTION_TYPES)) out[t] = calc.cooldownRemaining(t, lastMap.get(t));
    return out;
  }

  async interact(userId, friendshipId, type, data = {}) {
    if (!relationship.isUuid(friendshipId)) throw notFound();
    if (!calc.isValidType(type)) throw bad(`type 必须是 ${Object.keys(INTERACTION_TYPES).join('/')}`);
    const res = await this.db.transaction(async (c) => {
      const { rows: [f] } = await c.query('SELECT * FROM pokemon_friendships WHERE id = $1 FOR UPDATE', [friendshipId]);
      if (!f || (f.requester_user_id !== userId && f.addressee_user_id !== userId)) throw notFound();
      if (f.status !== 'accepted') throw bad('精灵还不是朋友', 2006, 400);
      const pm = await this.pokemonRows(c, [f.pokemon_id, f.friend_pokemon_id]);
      const a = pm.get(f.pokemon_id);
      const b = pm.get(f.friend_pokemon_id);
      if (!a || !b) throw notFound('精灵');
      if (a.user_id !== userId && b.user_id !== userId) throw notFound();

      const last = await this.lastInteractions(c, f.id, userId);
      const remain = calc.cooldownRemaining(type, last.get(type));
      if (remain > 0) {
        const err = new AppError(3029, `${INTERACTION_TYPES[type].name}冷却中，${remain} 秒后可再次互动`, 429);
        err.retryAfter = remain;
        throw err;
      }
      const bonuses = { ...pairBonuses(a, b), boost: activeBoost(f.friendship_level) };
      const gain = calc.calculateGain(type, f.friendship_level, bonuses);
      const applied = calc.applyGain(f.intimacy_score, f.friendship_level, gain);
      const actualGain = applied.score - f.intimacy_score;
      const { rows: [upd] } = await c.query(`
        UPDATE pokemon_friendships SET intimacy_score = $2, friendship_level = $3, interaction_count = interaction_count + 1,
               last_interaction_at = NOW() WHERE id = $1 RETURNING *`, [f.id, applied.score, applied.level]);
      const interactionData = { ...(data && typeof data === 'object' ? data : {}), bonuses };
      await c.query(`
        INSERT INTO pokemon_interactions (friendship_id, actor_user_id, interaction_type, interaction_data, intimacy_gained)
        VALUES ($1, $2, $3, $4, $5)`, [f.id, userId, type, JSON.stringify(interactionData), actualGain]);

      let keepsake = null;
      if (type === 'photo' || (type === 'adventure' && this.rng() < 0.3)) {
        const kType = type === 'photo' ? 'photo' : 'adventure_souvenir';
        const rarity = type === 'photo' ? (applied.level >= 5 ? 'rare' : 'common') : 'rare';
        const { rows: [k] } = await c.query(`
          INSERT INTO pokemon_keepsakes (friendship_id, keepsake_type, keepsake_data, rarity)
          VALUES ($1, $2, $3, $4) RETURNING *`,
        [f.id, kType, JSON.stringify({ species: [a.species_id, b.species_id], level: applied.level, by: userId }), rarity]);
        keepsake = k;
      }
      const rewards = applied.levelsGained.length ? await this.grantLevelRewards(c, upd, applied.levelsGained) : [];
      return { f: upd, gain: actualGain, applied, bonuses, keepsake, rewards, owners: [a.user_id, b.user_id] };
    });

    if (res.applied.levelsGained.length) {
      await this.events.publish(res.owners, 'pokemon_friendship_level_up', {
        friendshipId: res.f.id, newLevel: res.applied.level, rewards: res.rewards,
        pokemonIds: [res.f.pokemon_id, res.f.friend_pokemon_id],
      });
      for (const owner of new Set(res.owners)) {
        await this.events.createReminder(this.db, {
          userId: owner, type: 'pokemon_friendship_level_up', relatedUserId: null,
          content: { friendshipId: res.f.id, level: res.applied.level },
          dedupeKey: `pklvl:${res.f.id}:${res.applied.level}`,
        });
      }
    }
    return {
      success: true,
      type,
      intimacyGained: res.gain,
      intimacyScore: res.f.intimacy_score,
      friendshipLevel: res.f.friendship_level,
      levelsGained: res.applied.levelsGained,
      rewards: res.rewards,
      keepsake: res.keepsake,
      bonuses: res.bonuses,
      cooldownSeconds: calc.cooldownSeconds(type),
    };
  }

  async list(viewerId, pokemonId, { page = 1, limit = 20, sortBy = 'intimacy' } = {}) {
    if (!relationship.isUuid(pokemonId)) throw notFound('精灵');
    const pm = await this.pokemonRows(this.db, [pokemonId]);
    const p = pm.get(pokemonId);
    if (!p) throw notFound('精灵');
    const [selfView] = await store.visibleViews(this.db, viewerId, [p]);
    if (!selfView) throw notFound('精灵');
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;
    const order = { intimacy: 'f.intimacy_score DESC', level: 'f.friendship_level DESC, f.intimacy_score DESC', recent: 'f.last_interaction_at DESC NULLS LAST' }[sortBy]
      || 'f.intimacy_score DESC';
    const { rows } = await this.db.query(`
      SELECT f.*, CASE WHEN f.pokemon_id = $1 THEN f.friend_pokemon_id ELSE f.pokemon_id END AS other_id,
             COUNT(*) OVER()::int AS total
        FROM pokemon_friendships f
       WHERE (f.pokemon_id = $1 OR f.friend_pokemon_id = $1) AND f.status = 'accepted'
       ORDER BY ${order}, f.id LIMIT $2 OFFSET $3`, [pokemonId, lim, off]);
    const others = await this.pokemonRows(this.db, rows.map((r) => r.other_id));
    const otherList = rows.map((r) => others.get(r.other_id)).filter(Boolean);
    const views = await store.visibleViews(this.db, viewerId, otherList);
    const viewById = new Map(otherList.map((o, i) => [o.id, views[i]]));
    const isOwner = p.user_id === viewerId;
    const friends = [];
    for (const r of rows) {
      const item = {
        friendshipId: r.id,
        friendPokemon: viewById.get(r.other_id) || { id: r.other_id, hidden: true },
        friendshipLevel: r.friendship_level,
        intimacyScore: r.intimacy_score,
        nextLevelScore: r.friendship_level < 10 ? calc.thresholds[r.friendship_level] : null,
        interactionCount: r.interaction_count,
        lastInteraction: r.last_interaction_at,
      };
      if (isOwner) item.cooldowns = this.cooldowns(await this.lastInteractions(this.db, r.id, viewerId));
      friends.push(item);
    }
    return { pokemonId, friends, total: rows.length ? rows[0].total : 0, page: Math.floor(off / lim) + 1, limit: lim };
  }

  async pendingRequests(userId) {
    const { rows } = await this.db.query(`
      SELECT f.id AS friendship_id, f.message, f.created_at, f.pokemon_id AS from_pokemon_id, f.friend_pokemon_id AS to_pokemon_id,
             f.requester_user_id, u.nickname AS requester_nickname,
             ps.name_zh AS from_species_name, pi.species_id AS from_species_id, pi.nickname AS from_nickname
        FROM pokemon_friendships f
        JOIN users u ON u.id = f.requester_user_id
        JOIN pokemon_instances pi ON pi.id = f.pokemon_id
        JOIN pokemon_species ps ON ps.id = pi.species_id
       WHERE f.addressee_user_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC LIMIT 100`, [userId]);
    return rows;
  }

  async detail(userId, friendshipId) {
    if (!relationship.isUuid(friendshipId)) throw notFound();
    const { rows: [f] } = await this.db.query('SELECT * FROM pokemon_friendships WHERE id = $1', [friendshipId]);
    if (!f || (f.requester_user_id !== userId && f.addressee_user_id !== userId)) throw notFound();
    const pm = await this.pokemonRows(this.db, [f.pokemon_id, f.friend_pokemon_id]);
    const list = [pm.get(f.pokemon_id), pm.get(f.friend_pokemon_id)].filter(Boolean);
    const views = await store.visibleViews(this.db, userId, list);
    const { rows: rewards } = await this.db.query(`
      SELECT level, pokemon_id, reward_type, reward, expires_at, granted_at FROM pokemon_friendship_rewards
       WHERE friendship_id = $1 ORDER BY level, pokemon_id`, [f.id]);
    return {
      friendshipId: f.id,
      status: f.status,
      friendshipLevel: f.friendship_level,
      intimacyScore: f.intimacy_score,
      nextLevelScore: f.friendship_level < 10 ? calc.thresholds[f.friendship_level] : null,
      interactionCount: f.interaction_count,
      lastInteraction: f.last_interaction_at,
      pokemon: views.filter(Boolean),
      cooldowns: this.cooldowns(await this.lastInteractions(this.db, f.id, userId)),
      rewards,
      interactionTypes: INTERACTION_TYPES,
    };
  }

  async keepsakes(userId, friendshipId) {
    if (!relationship.isUuid(friendshipId)) throw notFound();
    const { rows: [f] } = await this.db.query(
      'SELECT id, requester_user_id, addressee_user_id FROM pokemon_friendships WHERE id = $1', [friendshipId]);
    if (!f || (f.requester_user_id !== userId && f.addressee_user_id !== userId)) throw notFound();
    const { rows } = await this.db.query(`
      SELECT id, keepsake_type, keepsake_data, rarity, created_at FROM pokemon_keepsakes
       WHERE friendship_id = $1 ORDER BY created_at DESC LIMIT 200`, [f.id]);
    return { friendshipId: f.id, keepsakes: rows };
  }
}

const instance = new PokemonFriendService();
module.exports = instance;
module.exports.PokemonFriendService = PokemonFriendService;
module.exports.calc = calc;
