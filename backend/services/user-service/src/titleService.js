'use strict';

const db = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { getRedis } = require('../../../shared/redis');
const { AppError } = require('../../../shared/auth');
const prom = require('prom-client');
const { register } = require('../../../shared/metrics');
const logger = createLogger('title-service');

function counter(name, help, labelNames = []) {
  return register.getSingleMetric(name) || new prom.Counter({ name, help, labelNames, registers: [register] });
}
const titleMetrics = {
  unlocked: counter('minego_titles_unlocked_total', 'Total titles unlocked', ['rarity', 'category', 'source_type']),
  activated: counter('minego_titles_activated_total', 'Total title activations'),
  expired: counter('minego_titles_expired_total', 'Total active titles expired'),
  leaderboard: counter('minego_title_leaderboard_views_total', 'Total title leaderboard views')
};
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const failure = (code, message, status = 400) => new AppError(code, message, status);
function publicTitle(row) {
  return {
    titleId: row.title_id, name: json(row.name), description: json(row.description),
    category: row.category, rarity: row.rarity, iconUrl: row.icon_url,
    statBonuses: json(row.stat_bonuses) || {}, specialEffects: json(row.special_effects) || {}
  };
}
function pageLimit(value, max = 100) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw failure('TITLE_INVALID_LIMIT', `limit must be between 1 and ${max}`);
  return limit;
}

class TitleService {
  constructor(options = {}) {
    this.db = options.db || db;
    this.cache = options.cache === undefined ? { del: key => getRedis().del(key) } : options.cache;
    this.metrics = options.metrics || titleMetrics;
    this.eventBus = options.eventBus || null;
    this.titleDefinitions = new Map();
    this.initialized = false;
  }

  async initialize() {
    const { rows } = await this.db.query('SELECT * FROM title_definitions WHERE is_active = true ORDER BY display_order, title_id');
    const definitions = new Map(rows.map(title => [title.title_id, {
      ...title, name: json(title.name), description: json(title.description),
      stat_bonuses: json(title.stat_bonuses) || {}, special_effects: json(title.special_effects) || {},
      unlock_criteria: json(title.unlock_criteria) || {}
    }]));
    this.titleDefinitions = definitions;
    this.initialized = true;
    logger.info({ count: definitions.size }, 'Title definitions initialized');
  }

  async transaction(fn) {
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { logger.error({ err: rollbackError }, 'Title rollback failed'); }
      throw err;
    } finally { client.release(); }
  }

  async invalidate(userId) {
    // Reads below use authoritative storage: a failed cache cannot change ownership,
    // activation or expiration, nor turn a committed update into a failed response.
    if (!this.cache) return;
    try {
      await Promise.all([`user:active_title:${userId}`, `user:stat_bonuses:${userId}`].map(key => this.cache.del(key)));
    } catch (err) { logger.warn({ err }, 'Title cache invalidation failed'); }
  }

  async unlockTitle(userId, titleId, sourceType, sourceId = null) {
    const title = this.titleDefinitions.get(titleId);
    if (!title) throw failure('TITLE_NOT_FOUND', 'Title not found', 404);
    if (title.is_limited && title.available_until && new Date(title.available_until) <= new Date()) throw failure('TITLE_EXPIRED', 'Title is no longer available');
    if (typeof sourceType !== 'string' || !sourceType.length || sourceType.length > 30 ||
        (sourceId != null && (typeof sourceId !== 'string' || sourceId.length > 100))) throw failure('TITLE_INVALID_SOURCE', 'Invalid title source');
    const inserted = await this.db.query(`INSERT INTO user_titles (user_id,title_id,source_type,source_id,expires_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,title_id) DO NOTHING RETURNING *`,
    [userId, titleId, sourceType, sourceId, title.is_limited ? this.calculateExpiry(title) : null]);
    if (!inserted.rowCount) return { alreadyUnlocked: true, title };
    this.metrics.unlocked.inc({ rarity: title.rarity, category: title.category, source_type: sourceType });
    await this.publishTitleUnlocked(userId, title);
    return { alreadyUnlocked: false, title, userTitle: inserted.rows[0] };
  }

  async setActiveTitle(userId, titleId) {
    const title = this.titleDefinitions.get(titleId);
    if (!title) throw failure('TITLE_NOT_FOUND', 'Title not found', 404);
    await this.transaction(async client => {
      // Lock the user, not only one title, so simultaneous switches serialize.
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!user.rowCount) throw failure('TITLE_USER_NOT_FOUND', 'User not found', 404);
      const owned = await client.query(`SELECT ut.title_id FROM user_titles ut JOIN title_definitions td USING (title_id)
        WHERE ut.user_id=$1 AND ut.title_id=$2 AND td.is_active=true
          AND (ut.expires_at IS NULL OR ut.expires_at > NOW()) FOR UPDATE OF ut`, [userId, titleId]);
      if (!owned.rowCount) throw failure('TITLE_NOT_OWNED', 'Title is not owned or has expired', 403);
      await client.query('UPDATE user_titles SET is_active=false WHERE user_id=$1 AND is_active=true', [userId]);
      await client.query('UPDATE user_titles SET is_active=true WHERE user_id=$1 AND title_id=$2', [userId, titleId]);
    });
    await this.invalidate(userId);
    this.metrics.activated.inc();
    return publicTitle(title);
  }

  async getUserTitles(userId, { category, rarity, includeExpired = false } = {}) {
    if (typeof includeExpired !== 'boolean') throw failure('TITLE_INVALID_EXPIRY_FILTER', 'includeExpired must be a boolean');
    const params = [userId];
    const clauses = ['ut.user_id=$1', 'td.is_active=true'];
    if (!includeExpired) clauses.push('(ut.expires_at IS NULL OR ut.expires_at > NOW())');
    for (const [column, value] of [['category',category],['rarity',rarity]]) {
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 30) throw failure('TITLE_INVALID_FILTER', 'Invalid title filter');
        params.push(value); clauses.push(`td.${column}=$${params.length}`);
      }
    }
    const { rows } = await this.db.query(`SELECT td.*,ut.is_active AS user_active,ut.is_favorite,ut.unlocked_at,
      ut.expires_at,ut.source_type FROM user_titles ut JOIN title_definitions td USING (title_id)
      WHERE ${clauses.join(' AND ')} ORDER BY ut.unlocked_at DESC,ut.title_id`, params);
    return rows.map(row => ({ ...publicTitle(row), isActive: row.user_active, isFavorite: row.is_favorite,
      unlockedAt: row.unlocked_at, expiresAt: row.expires_at, sourceType: row.source_type }));
  }

  async getActiveTitle(userId) {
    const { rows } = await this.db.query(`SELECT td.* FROM user_titles ut JOIN title_definitions td USING (title_id)
      WHERE ut.user_id=$1 AND ut.is_active=true AND td.is_active=true
        AND (ut.expires_at IS NULL OR ut.expires_at > NOW())`, [userId]);
    return rows[0] ? publicTitle(rows[0]) : null;
  }
  async getUserStatBonuses(userId) { return (await this.getActiveTitle(userId))?.statBonuses || {}; }
  getTitleDefinition(titleId) { return this.titleDefinitions.get(titleId); }
  getAllTitleDefinitions({ category, rarity } = {}) {
    return [...this.titleDefinitions.values()].filter(t => (!category || t.category===category) && (!rarity || t.rarity===rarity))
      .sort((a,b) => a.display_order-b.display_order || a.title_id.localeCompare(b.title_id));
  }
  async unlockMatching(userId, predicate, sourceType, sourceId) {
    const unlocked = [];
    for (const [id,title] of this.titleDefinitions) {
      if (predicate(title) && !(await this.unlockTitle(userId,id,sourceType,sourceId)).alreadyUnlocked) unlocked.push(title);
    }
    return unlocked;
  }
  unlockTitleByAchievement(userId,id) { return this.unlockMatching(userId,t=>t.unlock_type==='achievement'&&t.unlock_criteria.achievement_id===id,'achievement',id); }
  unlockTitleByEvent(userId,id) { return this.unlockMatching(userId,t=>t.unlock_type==='event'&&t.unlock_criteria.event_id===id,'event',id); }
  unlockTitleByRank(userId,rank) {
    if (!Number.isSafeInteger(rank) || rank < 1) throw failure('TITLE_INVALID_RANK','Invalid rank');
    return this.unlockMatching(userId,t=>t.unlock_type==='milestone'&&Number.isFinite(t.unlock_criteria.rank_requirement)&&rank<=t.unlock_criteria.rank_requirement,'milestone',`rank_${rank}`);
  }
  async setFavorite(userId,titleId,isFavorite=true) {
    if (typeof isFavorite !== 'boolean') throw failure('TITLE_INVALID_FAVORITE','isFavorite must be a boolean');
    return (await this.db.query('UPDATE user_titles SET is_favorite=$3 WHERE user_id=$1 AND title_id=$2 RETURNING title_id',[userId,titleId,isFavorite])).rowCount>0;
  }
  async processExpiredTitles() {
    const { rows } = await this.db.query('UPDATE user_titles SET is_active=false WHERE is_active=true AND expires_at <= NOW() RETURNING user_id,title_id');
    await Promise.all([...new Set(rows.map(t=>t.user_id))].map(id=>this.invalidate(id)));
    if (rows.length) this.metrics.expired.inc(rows.length);
    return rows.length;
  }
  async getTitleLeaderboard(limit=100) {
    limit=pageLimit(limit);
    const { rows } = await this.db.query(`SELECT u.id AS user_id,u.nickname,u.avatar_url,
      COUNT(ut.id)::int AS total_titles,
      COUNT(ut.id) FILTER (WHERE td.rarity='legendary')::int AS legendary_count,
      COUNT(ut.id) FILTER (WHERE td.rarity='mythic')::int AS mythic_count,
      MAX(ut.title_id) FILTER (WHERE ut.is_active) AS active_title_id
      FROM users u JOIN user_titles ut ON ut.user_id=u.id JOIN title_definitions td USING (title_id)
      WHERE td.is_active=true AND (ut.expires_at IS NULL OR ut.expires_at>NOW())
      GROUP BY u.id ORDER BY mythic_count DESC,legendary_count DESC,total_titles DESC,u.id LIMIT $1`,[limit]);
    this.metrics.leaderboard.inc();
    return rows.map((row,index)=>({rank:index+1,...row}));
  }
  async getUserTitleStats(userId) {
    const { rows } = await this.db.query(`SELECT COUNT(ut.id)::int AS total_titles,
      COUNT(ut.id) FILTER (WHERE td.rarity='legendary')::int AS legendary_count,
      COUNT(ut.id) FILTER (WHERE td.rarity='mythic')::int AS mythic_count,
      MAX(ut.title_id) FILTER (WHERE ut.is_active) AS active_title_id
      FROM user_titles ut JOIN title_definitions td USING (title_id)
      WHERE ut.user_id=$1 AND td.is_active=true AND (ut.expires_at IS NULL OR ut.expires_at>NOW())`,[userId]);
    return { user_id:userId,...rows[0] };
  }
  async getShopTitles({ page=1,limit=20 }={}) {
    limit=pageLimit(limit);
    page=pageLimit(page,1000000);
    const { rows }=await this.db.query(`SELECT * FROM title_definitions WHERE is_active=true AND unlock_type='purchase'
      AND (available_until IS NULL OR available_until>NOW()) ORDER BY display_order,title_id LIMIT $1 OFFSET $2`,[limit,(page-1)*limit]);
    return rows.map(t=>({...publicTitle(t),price:json(t.unlock_criteria).price||0,currency:json(t.unlock_criteria).currency||'coins'}));
  }
  calculateExpiry(title) {
    const days=title.unlock_criteria?.duration_days;
    let expiry=days?new Date(Date.now()+days*86400000):null;
    if (title.available_until && (!expiry || new Date(title.available_until)<expiry)) expiry=new Date(title.available_until);
    return expiry;
  }
  async publishTitleUnlocked(userId,title) {
    // Delivery is optional here; no event is claimed when no bus was configured.
    if (!this.eventBus) return;
    try { await this.eventBus.publish('title.unlocked',{userId,titleId:title.title_id,titleName:title.name,rarity:title.rarity}); }
    catch (err) { logger.error({err,userId,titleId:title.title_id},'Title event delivery failed after persistence'); }
  }
  reload() { return this.initialize(); }
}

module.exports = { TitleService: new TitleService(), TitleServiceClass: TitleService, titleMetrics };
