/**
 * 玩家资料与资料卡（REQ-00327 / REQ-00387）
 *
 * getProfile：聚合统计（shared/profileStats）+ 称号 + 收藏家等级 + 成就摘要 + 图鉴 + 精选徽章/精灵 + 收藏室摘要，
 *   按查看者身份（本人/好友/公开/受限）过滤；结果按"目标玩家 + 可见范围 + 语言"缓存 120 秒，
 *   目标玩家的资料/称号/成就/收藏室变化时 profileCache.bump 让缓存立即失效。
 * 他人查看写 profile_view_logs（同一查看者 10 分钟内只记一次）。
 * 分享：生成分享码 → 分享链接 + 二维码（qrcode）+ SVG 卡片（/v1/profile-cards/:code.svg，公开资料无需登录）。
 */
'use strict';

const crypto = require('crypto');
const db = require('../../../../shared/db');
const rules = require('../../../../shared/profileRules');
const stats = require('../../../../shared/profileStats');
const titles = require('../../../../shared/titles');
const profileCache = require('../../../../shared/profileCache');
const { localize, normalizeLang } = require('../../../../shared/achievementRules');
const { getRedis } = require('../../../../shared/redis');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_CODE_RE = /^[A-Za-z0-9]{8,16}$/;
const PROFILE_TTL = 120;
const SHARE_BASE = () => (process.env.PUBLIC_WEB_BASE || '').replace(/\/$/, '');

function httpError(status, message, code) {
  const e = new Error(message);
  e.statusCode = status; e.code = code;
  return e;
}

const DEFAULT_CONFIG = Object.freeze({
  avatar_frame_id: 'basic', background_theme_id: 'default', signature: '', visibility: 'public',
  selected_badges: [], selected_pokemon: [], stats_layout: {}, share_code: null,
});

async function loadConfig(userId, q = db) {
  const { rows } = await q.query('SELECT * FROM player_profile_configs WHERE user_id = $1', [userId]);
  return rows[0] || { ...DEFAULT_CONFIG, user_id: userId };
}

async function areFriends(a, b, q = db) {
  if (!a || !b || a === b) return false;
  const { rows: [r] } = await q.query(
    `SELECT EXISTS (SELECT 1 FROM friendships WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1))
         OR EXISTS (SELECT 1 FROM friends WHERE user_id = $1 AND friend_user_id = $2 AND (status IS NULL OR status IN ('accepted', 'active')))
         AS f`, [a, b]);
  return !!r.f;
}

async function completedSet(userId, q = db) {
  const { rows } = await q.query('SELECT achievement_id FROM user_achievements WHERE user_id = $1 AND completed', [userId]);
  return new Set(rows.map((r) => r.achievement_id));
}

/** 构建完整资料（未过滤） */
async function buildFull(userId, lang) {
  const l = normalizeLang(lang);
  const k = l.slice(0, 2);
  const agg = await stats.aggregate(userId);
  if (!agg) throw httpError(404, '用户不存在', 'USER_NOT_FOUND');
  const u = agg.u;
  const collectorRow = await stats.refreshCollectorScore(userId, db, agg); // 顺带刷新排行榜积分
  const collector = rules.collectorLevel(collectorRow.score, l);
  const config = await loadConfig(userId);
  const [activeTitle, { rows: [frame] }, { rows: [theme] }, { rows: recent }, { rows: badges }, { rows: featured }, { rows: [room] }, { rows: [snap] }] = await Promise.all([
    titles.getActiveTitle(userId, l),
    db.query('SELECT id, name, style, rarity FROM avatar_frames WHERE id = $1', [config.avatar_frame_id]),
    db.query('SELECT id, name, style, theme_type, full_url FROM profile_themes WHERE id = $1', [config.background_theme_id]),
    db.query(`SELECT ua.achievement_id, a.name, a.rarity, a.points, ua.completed_at FROM user_achievements ua
                JOIN achievements a ON a.achievement_id = ua.achievement_id
               WHERE ua.user_id = $1 AND ua.completed ORDER BY ua.completed_at DESC LIMIT 5`, [userId]),
    db.query(`SELECT a.achievement_id, a.name, a.rarity, a.category, a.icon_url, ua.completed_at
                FROM achievements a JOIN user_achievements ua ON ua.achievement_id = a.achievement_id AND ua.user_id = $1 AND ua.completed
               WHERE a.achievement_id = ANY($2::text[])`, [userId, config.selected_badges || []]),
    db.query(`SELECT pi.id, pi.species_id, pi.cp, pi.is_shiny, pi.nickname, pi.iv_attack, pi.iv_defense, pi.iv_hp,
                     ps.name_zh, ps.name_en, ps.name_ja, ps.rarity::text AS rarity, ps.sprite_url, ps.sprite_shiny_url
                FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
               WHERE pi.user_id = $1 AND pi.id = ANY($2::uuid[]) AND NOT COALESCE(pi.is_released, FALSE)`, [userId, config.selected_pokemon || []]),
    db.query(`SELECT r.id, r.room_name, r.level, r.like_count, r.visitor_count, r.is_public,
                     (SELECT COUNT(*)::int FROM collection_room_pokemon p WHERE p.room_id = r.id) AS pokemon_count
                FROM collection_rooms r WHERE r.user_id = $1`, [userId]),
    db.query('SELECT total_points FROM achievement_progress_snapshots WHERE user_id = $1', [userId]),
  ]);
  const CATEGORY_ICON = { catch: '🎯', breed: '🥚', battle: '⚔️', social: '🤝', explore: '🧭', growth: '📈', collection: '🏛️', event: '🎉' };
  const badgeOrder = new Map((config.selected_badges || []).map((id, i) => [id, i]));
  const featuredOrder = new Map((config.selected_pokemon || []).map((id, i) => [id, i]));
  const nameOf = (r) => r[`name_${k}`] || r.name_zh;
  return {
    player: {
      id: u.id, nickname: u.nickname, avatar: u.avatar_url, level: u.level, xp: Number(u.xp), team: u.team,
      joinedAt: u.created_at, lastActiveAt: u.last_active_at,
      title: activeTitle, collector: { ...collector, breakdown: collectorRow.breakdown },
      frame: frame ? { id: frame.id, name: localize(frame.name, l), style: frame.style, rarity: frame.rarity } : null,
      theme: theme ? { id: theme.id, name: localize(theme.name, l), style: theme.style, type: theme.theme_type, imageUrl: theme.full_url } : null,
    },
    signature: config.signature || '',
    stats: {
      pokemon: {
        totalCaught: u.total_caught, uniqueSpecies: u.unique_species, shinyCount: u.shiny_count, perfectIV: u.perfect_iv,
        highestCP: u.highest_cp,
        favoriteSpecies: u.favorite_species ? { id: u.favorite_species.id, name: u.favorite_species[k] || u.favorite_species.zh, count: u.favorite_species.count } : null,
      },
      battle: { gymBattles: u.gym_battles, gymWins: u.gym_wins, raidParticipated: u.raid_participated, raidWins: u.raid_wins,
        currentGymDefenders: u.current_gym_defenders, pvpWins: u.pvp_wins },
      social: { friendsCount: u.friends_count, giftsSent: u.gifts_sent, giftsReceived: u.gifts_received, tradesCompleted: u.trades_completed },
      exploration: { pokeStopsVisited: u.pokestops_visited, kmWalked: Math.round(u.km_walked * 10) / 10,
        regionsExplored: u.regions_explored, rareEncounters: u.rare_encounters },
    },
    statsLayout: config.stats_layout || {},
    achievements: {
      unlocked: agg.achievements.unlocked, total: agg.achievements.total, points: snap ? snap.total_points : agg.achievements.points,
      byRarity: agg.achievements.byRarity,
      recent: recent.map((r) => ({ id: r.achievement_id, name: localize(r.name, l), rarity: r.rarity, points: r.points, unlockedAt: r.completed_at })),
    },
    pokedex: { seen: u.seen_species, caught: u.unique_species, total: u.total_species,
      completionRate: u.total_species ? +(u.unique_species / u.total_species).toFixed(4) : 0 },
    badges: badges.sort((a, b) => badgeOrder.get(a.achievement_id) - badgeOrder.get(b.achievement_id)).map((b) => ({
      id: b.achievement_id, name: localize(b.name, l), rarity: b.rarity, category: b.category, iconUrl: b.icon_url,
      icon: CATEGORY_ICON[b.category] || '🏅', unlockedAt: b.completed_at })),
    featuredPokemon: featured.sort((a, b) => featuredOrder.get(a.id) - featuredOrder.get(b.id)).map((p) => ({
      id: p.id, speciesId: p.species_id, name: p.nickname || nameOf(p), cp: p.cp, isShiny: p.is_shiny, rarity: p.rarity,
      ivPercent: Math.round(((p.iv_attack + p.iv_defense + p.iv_hp) / 45) * 100),
      spriteUrl: (p.is_shiny && p.sprite_shiny_url) || p.sprite_url || null })),
    room: room ? { id: room.id, name: room.room_name, level: room.level, likeCount: room.like_count, visitorCount: room.visitor_count,
      pokemonCount: room.pokemon_count, isPublic: room.is_public } : null,
    config: {
      avatarFrameId: config.avatar_frame_id, backgroundThemeId: config.background_theme_id, visibility: config.visibility,
      selectedBadges: config.selected_badges || [], selectedPokemon: config.selected_pokemon || [], shareCode: config.share_code || null,
      featuredLimit: rules.featuredPokemonLimit(collector.level),
    },
    visibility: config.visibility,
    generatedAt: new Date().toISOString(),
  };
}

async function ownerViews(userId) {
  const { rows: [v] } = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(DISTINCT viewer_id) FILTER (WHERE viewed_at > NOW() - INTERVAL '7 days')::int AS unique_7d,
            COUNT(*) FILTER (WHERE view_source <> 'in_app')::int AS via_share
       FROM profile_view_logs WHERE profile_user_id = $1`, [userId]);
  return { total: v.total, uniqueVisitors7d: v.unique_7d, viaShare: v.via_share };
}

async function logView(targetId, viewerId, source, ip) {
  try {
    const key = `profile:viewlog:${targetId}:${viewerId || ip || 'anon'}`;
    let fresh = true;
    try { fresh = (await getRedis().set(key, '1', 'EX', 600, 'NX')) === 'OK'; } catch { /* Redis 不可用时每次都记 */ }
    if (!fresh) return;
    const ipHash = ip ? crypto.createHash('sha256').update(`${process.env.FIELD_HASH_KEY || 'pmg'}:${ip}`).digest('hex') : null;
    await db.query('INSERT INTO profile_view_logs (profile_user_id, viewer_id, view_source, ip_hash) VALUES ($1, $2, $3, $4)',
      [targetId, viewerId || null, source, ipHash]);
  } catch { /* 访问日志失败不影响查看 */ }
}

/**
 * @param {string|null} viewerId  null = 匿名（分享链接）
 * @param {string} targetId
 * @param {{lang?:string, source?:string, ip?:string}} opts
 */
async function getProfile(viewerId, targetId, { lang, source = 'in_app', ip } = {}) {
  if (!UUID_RE.test(String(targetId || ''))) throw httpError(400, '用户 ID 无效', 'VALIDATION');
  const isOwner = viewerId === targetId;
  const { rows: [cfg] } = await db.query(
    `SELECT u.id, COALESCE(c.visibility, 'public') AS visibility FROM users u
       LEFT JOIN player_profile_configs c ON c.user_id = u.id WHERE u.id = $1 AND u.deleted_at IS NULL`, [targetId]);
  if (!cfg) throw httpError(404, '用户不存在', 'USER_NOT_FOUND');
  const isFriend = !isOwner && viewerId ? await areFriends(viewerId, targetId) : false;
  const audience = rules.audienceFor({ isOwner, isFriend, visibility: cfg.visibility });
  const l = normalizeLang(lang);
  const t0 = Date.now();
  const { value, hit } = await profileCache.cached(`profile:view:${targetId}:${audience}:${l}`, targetId, PROFILE_TTL,
    async () => rules.filterProfile(await buildFull(targetId, l), audience));
  const out = { ...value, isFriend, cache: { hit, ms: Date.now() - t0 } };
  if (isOwner) out.views = await ownerViews(targetId);
  else logView(targetId, viewerId, source, ip);
  return out;
}

async function updateProfile(userId, body) {
  const agg = await db.query('SELECT rank FROM collector_scores WHERE user_id = $1', [userId]);
  const collectorLvl = agg.rows[0] ? agg.rows[0].rank : 1;
  const v = rules.validateProfilePatch(body, { featuredLimit: rules.featuredPokemonLimit(collectorLvl) });
  if (!v.ok) throw httpError(400, v.error, 'VALIDATION');
  const patch = v.value;
  const { rows: [u] } = await db.query('SELECT level FROM users WHERE id = $1', [userId]);
  if (!u) throw httpError(404, '用户不存在', 'USER_NOT_FOUND');
  const ctx = { level: u.level, collectorLevel: collectorLvl, achievements: await completedSet(userId) };
  if (patch.avatar_frame_id) {
    const { rows: [f] } = await db.query('SELECT unlock_condition FROM avatar_frames WHERE id = $1 AND is_active', [patch.avatar_frame_id]);
    if (!f) throw httpError(404, '头像框不存在', 'FRAME_NOT_FOUND');
    if (!rules.meetsUnlock(f.unlock_condition, ctx)) throw httpError(403, '头像框尚未解锁', 'FRAME_LOCKED');
  }
  if (patch.background_theme_id) {
    const { rows: [t] } = await db.query('SELECT unlock_condition FROM profile_themes WHERE id = $1 AND is_active', [patch.background_theme_id]);
    if (!t) throw httpError(404, '背景主题不存在', 'THEME_NOT_FOUND');
    if (!rules.meetsUnlock(t.unlock_condition, ctx)) throw httpError(403, '背景主题尚未解锁', 'THEME_LOCKED');
  }
  if (patch.selected_badges) {
    const missing = patch.selected_badges.filter((id) => !ctx.achievements.has(id));
    if (missing.length) throw httpError(400, `只能展示已解锁的成就：${missing.join(',')}`, 'BADGE_LOCKED');
  }
  if (patch.selected_pokemon && patch.selected_pokemon.length) {
    const { rows } = await db.query(
      `SELECT id FROM pokemon_instances WHERE user_id = $1 AND id = ANY($2::uuid[]) AND NOT COALESCE(is_released, FALSE)`,
      [userId, patch.selected_pokemon]);
    if (rows.length !== patch.selected_pokemon.length) throw httpError(400, '精选精灵必须是自己拥有的精灵', 'POKEMON_NOT_OWNED');
  }
  const cols = Object.keys(patch);
  const vals = cols.map((c) => (c === 'stats_layout' ? JSON.stringify(patch[c]) : patch[c]));
  await db.query(
    `INSERT INTO player_profile_configs (user_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (user_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()`,
    [userId, ...vals]);
  await profileCache.bump(userId);
  return getProfile(userId, userId, {});
}

async function customization(userId, lang) {
  const [{ rows: frames }, { rows: themes }, { rows: [u] }, { rows: [cs] }, achievements, config] = await Promise.all([
    db.query('SELECT * FROM avatar_frames WHERE is_active ORDER BY sort_order'),
    db.query('SELECT * FROM profile_themes WHERE is_active ORDER BY sort_order'),
    db.query('SELECT level FROM users WHERE id = $1', [userId]),
    db.query('SELECT rank FROM collector_scores WHERE user_id = $1', [userId]),
    completedSet(userId), loadConfig(userId),
  ]);
  const ctx = { level: u ? u.level : 1, collectorLevel: cs ? cs.rank : 1, achievements };
  const view = (r, selected) => ({ id: r.id, name: localize(r.name, lang), description: localize(r.description, lang), rarity: r.rarity,
    style: r.style, imageUrl: r.image_url || r.full_url, previewUrl: r.preview_url || r.image_url,
    unlockCondition: r.unlock_condition, unlocked: rules.meetsUnlock(r.unlock_condition, ctx), selected });
  return {
    frames: frames.map((f) => view(f, f.id === config.avatar_frame_id)),
    themes: themes.map((t) => view(t, t.id === config.background_theme_id)),
    featuredLimit: rules.featuredPokemonLimit(ctx.collectorLevel), maxBadges: rules.MAX_BADGES,
  };
}

async function availableBadges(userId, lang) {
  const config = await loadConfig(userId);
  const { rows } = await db.query(
    `SELECT a.achievement_id, a.name, a.description, a.rarity, a.category, a.points, ua.completed_at
       FROM user_achievements ua JOIN achievements a ON a.achievement_id = ua.achievement_id
      WHERE ua.user_id = $1 AND ua.completed ORDER BY ua.completed_at DESC`, [userId]);
  const selected = new Set(config.selected_badges || []);
  return rows.map((r) => ({ id: r.achievement_id, name: localize(r.name, lang), description: localize(r.description, lang),
    rarity: r.rarity, category: r.category, points: r.points, unlockedAt: r.completed_at, selected: selected.has(r.achievement_id) }));
}

function shareUrls(code) {
  const base = SHARE_BASE();
  return { shareUrl: `${base}/p/${code}`, cardImageUrl: `${base}/v1/profile-cards/${code}.svg`, qrTargetUrl: `${base}/p/${code}?src=qr` };
}

async function share(userId) {
  let code = (await loadConfig(userId)).share_code;
  if (!code) {
    for (let i = 0; i < 3 && !code; i++) {
      const c = crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
      if (c.length < 8) continue;
      try {
        await db.query(
          `INSERT INTO player_profile_configs (user_id, share_code, share_created_at) VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET share_code = COALESCE(player_profile_configs.share_code, EXCLUDED.share_code),
             share_created_at = COALESCE(player_profile_configs.share_created_at, NOW()), updated_at = NOW()`, [userId, c]);
        code = (await loadConfig(userId)).share_code;
      } catch (err) { if (err.code !== '23505') throw err; }
    }
  }
  if (!code) throw httpError(500, '生成分享码失败', 'SHARE_FAILED');
  const urls = shareUrls(code);
  let qrCode = null;
  try { qrCode = await require('qrcode').toDataURL(urls.qrTargetUrl, { margin: 1, width: 256 }); } catch { /* qrcode 不可用时只返回链接 */ }
  const { rows: [c] } = await db.query('SELECT visibility FROM player_profile_configs WHERE user_id = $1', [userId]);
  return { shareCode: code, ...urls, qrCode, publicCardAvailable: !c || c.visibility === 'public' };
}

/** 资料卡 SVG（查看者可见范围内的数据） */
async function cardSvg(viewerId, targetId, lang) {
  const p = await getProfile(viewerId, targetId, { lang });
  if (p.restricted) throw httpError(403, '该玩家资料未公开', 'PROFILE_PRIVATE');
  const code = p.config && p.config.shareCode;
  return rules.renderCardSvg(p, { lang, shareUrl: code ? shareUrls(code).shareUrl : '' });
}

/** 分享链接打开：仅公开资料可匿名查看 */
async function byShareCode(code, { lang, source = 'share_link', ip } = {}) {
  if (!SHARE_CODE_RE.test(String(code || ''))) throw httpError(400, '分享码无效', 'VALIDATION');
  const { rows: [c] } = await db.query('SELECT user_id, visibility FROM player_profile_configs WHERE share_code = $1', [code]);
  if (!c) throw httpError(404, '分享链接不存在', 'SHARE_NOT_FOUND');
  if (c.visibility !== 'public') throw httpError(403, '该玩家资料未公开', 'PROFILE_PRIVATE');
  const p = await getProfile(null, c.user_id, { lang, source, ip });
  return { profile: p, svg: rules.renderCardSvg(p, { lang, shareUrl: shareUrls(code).shareUrl }) };
}

async function statsSummary(userId, lang) {
  const p = await getProfile(userId, userId, { lang });
  return { player: p.player, stats: p.stats, achievements: p.achievements, pokedex: p.pokedex, collector: p.player.collector };
}

/** 收藏家积分排行（缓存 60 秒） */
async function collectorsLeaderboard({ limit = 50, lang, userId } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const l = normalizeLang(lang);
  const key = `profile:collectors:${n}:${l}`;
  let board = null;
  try { const raw = await getRedis().get(key); if (raw) board = JSON.parse(raw); } catch { /* 缓存不可用 */ }
  if (!board) {
    const { rows } = await db.query(
      `SELECT cs.user_id, cs.score, cs.rank, u.nickname, u.avatar_url, u.level, u.team::text AS team
         FROM collector_scores cs JOIN users u ON u.id = cs.user_id
        WHERE NOT COALESCE(u.is_banned, FALSE) AND u.deleted_at IS NULL AND cs.score > 0
        ORDER BY cs.score DESC, cs.last_updated ASC LIMIT ${n}`);
    const active = await titles.getActiveTitles(rows.map((r) => r.user_id), l);
    board = rows.map((r, i) => ({ rank: i + 1, userId: r.user_id, nickname: r.nickname, avatarUrl: r.avatar_url, level: r.level, team: r.team,
      score: r.score, collector: rules.collectorLevel(r.score, l), activeTitle: active.get(String(r.user_id)) || null }));
    try { await getRedis().setex(key, 60, JSON.stringify(board)); } catch { /* 忽略 */ }
  }
  let me = null;
  if (userId) {
    const { rows: [s] } = await db.query('SELECT score FROM collector_scores WHERE user_id = $1', [userId]);
    if (s) {
      const { rows: [r] } = await db.query('SELECT COUNT(*)::int + 1 AS rank FROM collector_scores WHERE score > $1', [s.score]);
      me = { rank: r.rank, score: s.score, collector: rules.collectorLevel(s.score, l) };
    }
  }
  return { leaderboard: board, me };
}

module.exports = {
  getProfile, updateProfile, customization, availableBadges, share, cardSvg, byShareCode, statsSummary, collectorsLeaderboard,
  areFriends, buildFull,
};
