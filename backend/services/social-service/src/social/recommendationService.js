/**
 * REQ-00388：智能好友推荐（位置、等级、共同好友、精灵类型偏好四维度）
 *
 * 候选来源：好友的好友（共同好友）、附近 5km 内近期活跃玩家、等级相近的近期活跃玩家；
 * 对候选统一计算四维分数并加权排序，排除自己、已是好友、待处理申请、拉黑关系、关闭搜索与已忽略的用户。
 * 结果按用户缓存 10 分钟（Redis），忽略推荐或好友关系变化时失效。
 */
'use strict';

const dbDefault = require('../../../../shared/db');
const { AppError } = require('../../../../shared/auth');
const { haversineKm } = require('../../../../shared/social/intimacyCalculator');

const CACHE_TTL = 600;
const NEARBY_KM = 5;
const WEIGHTS = Object.freeze({ mutual: 0.35, location: 0.3, level: 0.15, types: 0.2 });
const REASON_BY_DIM = Object.freeze({
  mutual: 'mutual_friends', location: 'location_nearby', level: 'similar_level', types: 'similar_pokemon_types',
});

/**
 * 四维打分（纯函数）
 * @param {object} me   { level, lat, lng, types: string[] }
 * @param {object} c    { level, lat, lng, types: string[], mutual: number, activeDaysAgo }
 */
function scoreCandidate(me, c) {
  const dims = {};
  dims.mutual = Math.min(Number(c.mutual) || 0, 5) / 5;
  const d = haversineKm(me.lat, me.lng, c.lat, c.lng);
  dims.location = d === null ? 0 : Math.max(0, 1 - d / NEARBY_KM);
  const dl = Math.abs((Number(me.level) || 1) - (Number(c.level) || 1));
  dims.level = Math.max(0, 1 - dl / 5);
  const mine = new Set(me.types || []);
  const theirs = c.types || [];
  dims.types = mine.size && theirs.length ? theirs.filter((t) => mine.has(t)).length / Math.max(mine.size, theirs.length) : 0;
  let score = 0;
  for (const k of Object.keys(WEIGHTS)) score += WEIGHTS[k] * dims[k];
  if (c.activeDaysAgo != null && c.activeDaysAgo <= 1) score += 0.05;
  const reasons = Object.keys(dims)
    .filter((k) => dims[k] >= 0.2)
    .sort((a, b) => WEIGHTS[b] * dims[b] - WEIGHTS[a] * dims[a])
    .map((k) => REASON_BY_DIM[k]);
  if (!reasons.length && c.activeDaysAgo != null && c.activeDaysAgo <= 1) reasons.push('active_recently');
  return {
    score: Math.round(score * 1000) / 1000,
    dimensions: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    distanceKm: d === null ? null : Math.round(d * 10) / 10,
    reasons,
  };
}

class RecommendationService {
  constructor({ db = dbDefault, redisFactory } = {}) {
    this.db = db;
    this.redisFactory = redisFactory || (() => require('../../../../shared/redis').getRedis());
  }

  cacheKey(userId) { return `friend_rec:${userId}`; }

  async invalidate(userIds) {
    try { await this.redisFactory().del(...userIds.map((id) => this.cacheKey(id))); } catch { /* ignore */ }
  }

  async topTypes(userIds) {
    if (!userIds.length) return new Map();
    const { rows } = await this.db.query(`
      SELECT user_id, array_agg(ty ORDER BY n DESC) AS types FROM (
        SELECT p.user_id, x.ty, COUNT(*) AS n,
               ROW_NUMBER() OVER (PARTITION BY p.user_id ORDER BY COUNT(*) DESC, x.ty) AS rk
          FROM pokemon_instances p
          JOIN pokemon_species s ON s.id = p.species_id
          CROSS JOIN LATERAL unnest(ARRAY[s.type1::text, s.type2::text]) AS x(ty)
         WHERE p.user_id = ANY($1::uuid[]) AND x.ty IS NOT NULL
         GROUP BY p.user_id, x.ty
      ) z WHERE rk <= 3 GROUP BY user_id`, [userIds]);
    return new Map(rows.map((r) => [r.user_id, r.types]));
  }

  async getRecommendations(userId, { limit = 10, refresh = false } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
    if (!refresh) {
      try {
        const cached = await this.redisFactory().get(this.cacheKey(userId));
        if (cached) {
          const data = JSON.parse(cached);
          return { ...data, cached: true, recommendations: data.recommendations.slice(0, lim) };
        }
      } catch { /* ignore */ }
    }
    const { rows: [me] } = await this.db.query(
      'SELECT id, level, last_lat, last_lng FROM users WHERE id = $1', [userId]);
    if (!me) throw new AppError(2001, '用户不存在', 404);
    const lat = me.last_lat == null ? null : Number(me.last_lat);
    const lng = me.last_lng == null ? null : Number(me.last_lng);
    const dLat = NEARBY_KM / 111;
    const dLng = lat == null ? 0 : NEARBY_KM / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));

    const { rows: cands } = await this.db.query(`
      WITH excluded AS (
        SELECT $1::uuid AS id
        UNION SELECT friend_user_id FROM friends WHERE user_id = $1
        UNION SELECT blocked_user_id FROM blocked_users WHERE user_id = $1
        UNION SELECT user_id FROM blocked_users WHERE blocked_user_id = $1
        UNION SELECT recommended_user_id FROM friend_recommendations WHERE user_id = $1 AND is_dismissed
        UNION SELECT CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END
                FROM friend_requests WHERE status = 'pending' AND (from_user_id = $1 OR to_user_id = $1)
      ),
      mutual AS (
        SELECT f2.friend_user_id AS id, COUNT(*)::int AS mutual
          FROM friends f1 JOIN friends f2 ON f2.user_id = f1.friend_user_id AND f2.status = 'accepted'
         WHERE f1.user_id = $1 AND f1.status = 'accepted'
         GROUP BY f2.friend_user_id ORDER BY COUNT(*) DESC LIMIT 100
      ),
      nearby AS (
        -- 附近推荐只包含开启了位置共享的玩家
        SELECT nu.id FROM users nu
          JOIN privacy_settings nps ON nps.user_id = nu.id AND nps.allow_location_sharing
         WHERE $2::numeric IS NOT NULL AND nu.last_lat BETWEEN $2::numeric - $4 AND $2::numeric + $4
           AND nu.last_lng BETWEEN $3::numeric - $5 AND $3::numeric + $5
           AND COALESCE(nu.last_active_at, nu.last_login_at) > NOW() - INTERVAL '7 days'
         LIMIT 100
      ),
      same_level AS (
        SELECT id FROM users
         WHERE level BETWEEN $6::int - 2 AND $6::int + 2
           AND COALESCE(last_active_at, last_login_at) > NOW() - INTERVAL '7 days'
         ORDER BY COALESCE(last_active_at, last_login_at) DESC NULLS LAST LIMIT 100
      ),
      pool AS (SELECT id FROM mutual UNION SELECT id FROM nearby UNION SELECT id FROM same_level)
      SELECT u.id, u.nickname, u.avatar_url, u.level, u.team, u.last_lat, u.last_lng,
             COALESCE(m.mutual, 0) AS mutual, COALESCE(ps.allow_location_sharing, false) AS shares_location,
             EXTRACT(EPOCH FROM (NOW() - COALESCE(u.last_active_at, u.last_login_at))) / 86400 AS active_days_ago
        FROM pool p
        JOIN users u ON u.id = p.id AND u.deleted_at IS NULL AND NOT COALESCE(u.is_banned, false)
        LEFT JOIN mutual m ON m.id = u.id
        LEFT JOIN privacy_settings ps ON ps.user_id = u.id
       WHERE p.id NOT IN (SELECT id FROM excluded)
         AND COALESCE(ps.searchable, true) AND COALESCE(ps.allow_friend_requests, true)`,
    [userId, lat, lng, dLat, dLng, me.level || 1]);

    const types = await this.topTypes([userId, ...cands.map((c) => c.id)]);
    const meInfo = { level: me.level, lat, lng, types: types.get(userId) || [] };
    const scored = cands.map((c) => {
      // 只对开启位置共享的玩家使用位置维度；不返回坐标，距离按 0.5km 粒度模糊化
      const useLoc = c.shares_location && c.last_lat != null;
      const s = scoreCandidate(meInfo, {
        level: c.level, lat: useLoc ? Number(c.last_lat) : null, lng: useLoc ? Number(c.last_lng) : null,
        types: types.get(c.id) || [], mutual: c.mutual, activeDaysAgo: c.active_days_ago == null ? null : Number(c.active_days_ago),
      });
      return {
        userId: c.id, nickname: c.nickname, avatar_url: c.avatar_url, level: c.level, team: c.team,
        mutualFriends: Number(c.mutual), distanceKm: s.distanceKm == null ? null : Math.max(0.5, Math.round(s.distanceKm * 2) / 2),
        score: s.score, reasons: s.reasons, dimensions: s.dimensions,
      };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 30);

    if (scored.length) {
      await this.db.query(`
        INSERT INTO friend_recommendations (user_id, recommended_user_id, recommendation_reason, score, expires_at)
        SELECT $1, x.id, x.reason, x.score, NOW() + INTERVAL '30 days'
          FROM unnest($2::uuid[], $3::text[], $4::float8[]) AS x(id, reason, score)
        ON CONFLICT (user_id, recommended_user_id) DO UPDATE
           SET recommendation_reason = EXCLUDED.recommendation_reason, score = EXCLUDED.score, created_at = NOW()
         WHERE NOT friend_recommendations.is_dismissed`,
      [userId, scored.map((s) => s.userId), scored.map((s) => s.reasons[0] || 'active_recently'), scored.map((s) => s.score)]);
    }
    const out = { recommendations: scored, generatedAt: new Date().toISOString() };
    try { await this.redisFactory().setex(this.cacheKey(userId), CACHE_TTL, JSON.stringify(out)); } catch { /* ignore */ }
    return { ...out, cached: false, recommendations: scored.slice(0, lim) };
  }

  async dismiss(userId, targetId) {
    await this.db.query(`
      INSERT INTO friend_recommendations (user_id, recommended_user_id, recommendation_reason, score, is_dismissed)
      VALUES ($1, $2, 'active_recently', 0, true)
      ON CONFLICT (user_id, recommended_user_id) DO UPDATE SET is_dismissed = true`, [userId, targetId]);
    await this.invalidate([userId]);
    return { success: true };
  }
}

const instance = new RecommendationService();
module.exports = instance;
module.exports.RecommendationService = RecommendationService;
module.exports.scoreCandidate = scoreCandidate;
module.exports.WEIGHTS = WEIGHTS;
