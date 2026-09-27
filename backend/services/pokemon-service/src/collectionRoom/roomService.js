/**
 * 收藏室服务（数据访问）——REQ-00359 / REQ-00403
 *
 * 所有修改在事务中先锁住收藏室行（FOR UPDATE），摆放校验与容量检查基于锁内读到的布局，并发摆放不会重叠/超额。
 * 变更后：写游戏事件（room_pokemon_changed / room_decorated / room_liked）驱动收藏成就与"被点赞"消息，
 * 并 bump 房主的资料缓存版本（收藏室详情缓存与资料卡共用版本号，读到的缓存立即失效）。
 */
'use strict';

const db = require('../../../../shared/db');
const rules = require('./roomRules');
const { localize, normalizeLang } = require('../../../../shared/achievementRules');
const center = require('../../../../shared/notificationCenter');
const engine = require('../../../../shared/achievementEngine');
const profileCache = require('../../../../shared/profileCache');
const { getRedis } = require('../../../../shared/redis');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z0-9_]{2,100}$/;
const DETAIL_TTL = 120;

function httpError(status, message, code) {
  const e = new Error(message);
  e.statusCode = status; e.code = code;
  return e;
}
function assertUuid(v, name = 'id') { if (!UUID_RE.test(String(v || ''))) throw httpError(400, `${name} 无效`, 'VALIDATION'); }

// ── 基础 ──────────────────────────────────────────────────────
async function ensureRoom(q, userId) {
  await q.query(
    `INSERT INTO collection_rooms (user_id, room_name)
     SELECT id, LEFT(COALESCE(nickname, '训练师') || '的收藏室', 100) FROM users WHERE id = $1
     ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const { rows } = await q.query('SELECT * FROM collection_rooms WHERE user_id = $1', [userId]);
  if (!rows.length) throw httpError(404, '用户不存在', 'USER_NOT_FOUND');
  return rows[0];
}

async function lockRoom(client, userId) {
  await ensureRoom(client, userId);
  const { rows: [room] } = await client.query('SELECT * FROM collection_rooms WHERE user_id = $1 FOR UPDATE', [userId]);
  return room;
}

function grid(room) {
  const gs = room.layout_config && room.layout_config.gridSize;
  return gs && gs.width && gs.height ? { width: gs.width, height: gs.height } : { ...rules.DEFAULT_GRID };
}

/** 当前占用（不含 excludeKey），key：d:<装饰id> / p:<精灵实例id> */
async function occupied(client, roomId, excludeKey) {
  const [{ rows: decos }, { rows: mons }] = await Promise.all([
    client.query(`SELECT rd.id, rd.position_x, rd.position_y, rd.rotation, di.width, di.height, di.category
                    FROM room_decorations rd JOIN decoration_items di ON di.id = rd.item_id WHERE rd.room_id = $1`, [roomId]),
    client.query('SELECT pokemon_instance_id, position_x, position_y FROM collection_room_pokemon WHERE room_id = $1', [roomId]),
  ]);
  const out = [];
  for (const d of decos) {
    const key = `d:${d.id}`;
    if (key === excludeKey) continue;
    out.push({ key, ...rules.footprint(d, { x: d.position_x, y: d.position_y, rotation: d.rotation }), layer: rules.layerOf(d) });
  }
  for (const p of mons) {
    const key = `p:${p.pokemon_instance_id}`;
    if (key === excludeKey) continue;
    out.push({ key, x: p.position_x, y: p.position_y, w: 1, h: 1, layer: 'object' });
  }
  return out;
}

async function completedAchievements(q, userId) {
  const { rows } = await q.query('SELECT achievement_id FROM user_achievements WHERE user_id = $1 AND completed', [userId]);
  return new Set(rows.map((r) => r.achievement_id));
}
async function purchasedSet(q, userId, kind) {
  const { rows } = await q.query('SELECT ref_id FROM user_room_unlocks WHERE user_id = $1 AND kind = $2', [userId, kind]);
  return new Set(rows.map((r) => r.ref_id));
}

// ── 经验与等级 ────────────────────────────────────────────────
/**
 * 发放收藏室经验（同一原因+对象只发一次）；升级时发放等级奖励物品并通知房主
 * @returns {Promise<null|{amount:number, level:number, leveledUp:boolean}>}
 */
async function grantExp(client, roomId, reason, refKey) {
  const amount = rules.EXP_TABLE[reason];
  if (!amount) return null;
  const ins = await client.query(
    `INSERT INTO room_exp_log (room_id, reason, ref_key, amount) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING amount`, [roomId, reason, String(refKey).slice(0, 120), amount]);
  if (!ins.rowCount) return null;
  const { rows: [r] } = await client.query(
    `UPDATE collection_rooms SET experience = experience + $2, updated_at = NOW() WHERE id = $1
     RETURNING user_id, experience, level`, [roomId, amount]);
  const newLevel = rules.levelForExp(r.experience);
  if (newLevel <= r.level) return { amount, level: r.level, leveledUp: false };
  await client.query('UPDATE collection_rooms SET level = $2 WHERE id = $1', [roomId, newLevel]);
  for (const reward of rules.levelRewards(r.level, newLevel)) {
    await client.query(
      `INSERT INTO user_decorations (user_id, item_id, quantity, obtained_from)
       SELECT $1, id, 1, 'level' FROM decoration_items WHERE item_code = $2
       ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_decorations.quantity + 1`, [r.user_id, reward.itemCode]);
  }
  await center.notify(client, r.user_id, {
    type: 'reward.room_level_up', templateKey: 'room_level_up', category: 'reward', priority: 'normal',
    params: { new_level: newLevel }, data: { roomId, fromLevel: r.level, toLevel: newLevel, capacity: rules.capacity(newLevel) },
    actionUrl: '/collection-room', dedupeKey: `roomlvl:${roomId}:${newLevel}`,
  });
  return { amount, level: newLevel, leveledUp: true };
}

// ── 详情 ──────────────────────────────────────────────────────
async function loadDetail(roomId, lang) {
  const l = normalizeLang(lang);
  const { rows: [room] } = await db.query(
    `SELECT r.*, u.nickname AS owner_nickname, u.avatar_url AS owner_avatar, u.level AS owner_level, u.team AS owner_team,
            t.name_i18n AS theme_name, t.palette, b.name_i18n AS background_name, b.css_gradient, b.background_image
       FROM collection_rooms r JOIN users u ON u.id = r.user_id
       JOIN collection_themes t ON t.id = r.theme_id JOIN collection_backgrounds b ON b.id = r.background_id
      WHERE r.id = $1`, [roomId]);
  if (!room) return null;
  const [{ rows: mons }, { rows: decos }] = await Promise.all([
    db.query(
      `SELECT crp.*, pi.species_id, pi.cp, pi.is_shiny, pi.nickname AS pokemon_nickname, pi.iv_attack, pi.iv_defense, pi.iv_hp,
              ps.name_zh, ps.name_en, ps.name_ja, ps.rarity, ps.sprite_url, ps.sprite_shiny_url
         FROM collection_room_pokemon crp JOIN pokemon_instances pi ON pi.id = crp.pokemon_instance_id
         JOIN pokemon_species ps ON ps.id = pi.species_id
        WHERE crp.room_id = $1 ORDER BY crp.sort_order, crp.added_at`, [roomId]),
    db.query(
      `SELECT rd.*, di.item_code, di.name_i18n, di.category, di.rarity, di.icon, di.width, di.height, di.image_url, di.interaction_type
         FROM room_decorations rd JOIN decoration_items di ON di.id = rd.item_id
        WHERE rd.room_id = $1 ORDER BY rd.z_index, rd.placed_at`, [roomId]),
  ]);
  const nameCol = l === 'en-US' ? 'name_en' : l === 'ja-JP' ? 'name_ja' : 'name_zh';
  const info = rules.levelInfo(room.experience);
  return {
    room: {
      id: room.id, ownerId: room.user_id, ownerNickname: room.owner_nickname, ownerAvatar: room.owner_avatar,
      ownerLevel: room.owner_level, ownerTeam: room.owner_team, roomName: room.room_name,
      theme: { id: room.theme_id, name: localize(room.theme_name, l), palette: room.palette || {} },
      background: { id: room.background_id, name: localize(room.background_name, l), cssGradient: room.css_gradient,
        imageUrl: room.background_image_url || room.background_image || null },
      layout: { gridSize: grid(room) },
      level: room.level, experience: room.experience, nextLevelExp: info.nextLevelExp, levelProgress: info.progress,
      capacity: rules.capacity(room.level),
      visitorCount: room.visitor_count, likeCount: room.like_count, commentCount: room.comment_count,
      isPublic: room.is_public, updatedAt: room.updated_at,
    },
    pokemon: mons.map((m) => ({
      pokemonId: m.pokemon_instance_id, speciesId: m.species_id, name: m.pokemon_nickname || m[nameCol] || m.name_zh,
      cp: m.cp, isShiny: m.is_shiny, rarity: m.rarity, ivPercent: Math.round(((m.iv_attack + m.iv_defense + m.iv_hp) / 45) * 100),
      spriteUrl: (m.is_shiny && m.sprite_shiny_url) || m.sprite_url || null,
      x: m.position_x, y: m.position_y, z: m.position_z, scale: Number(m.scale), rotation: m.rotation,
      displayMode: m.display_mode, pedestalType: m.pedestal_type, animationSpeed: Number(m.animation_speed), label: m.custom_label,
    })),
    decorations: decos.map((d) => ({
      id: d.id, itemCode: d.item_code, name: localize(d.name_i18n, l), category: d.category, rarity: d.rarity, icon: d.icon,
      width: d.width, height: d.height, imageUrl: d.image_url, interactionType: d.interaction_type,
      x: d.position_x, y: d.position_y, rotation: d.rotation, scale: Number(d.scale), zIndex: d.z_index,
    })),
  };
}

async function detailCached(room, lang) {
  const { value } = await profileCache.cached(`room:detail:${room.id}:${normalizeLang(lang)}`, room.user_id, DETAIL_TTL,
    () => loadDetail(room.id, lang));
  return value;
}

async function getMyRoom(userId, lang) {
  const room = await ensureRoom(db, userId);
  const detail = await detailCached(room, lang);
  const [achievements, themes, bgs] = await Promise.all([
    completedAchievements(db, userId), purchasedSet(db, userId, 'theme'), purchasedSet(db, userId, 'background')]);
  const { rows: tdefs } = await db.query('SELECT id, unlock_condition, is_premium FROM collection_themes');
  const { rows: bdefs } = await db.query('SELECT id, unlock_condition, is_premium FROM collection_backgrounds');
  const ctx = { roomLevel: room.level, achievements };
  return {
    ...detail, isOwner: true,
    unlockedThemes: tdefs.filter((t) => rules.isUnlocked(t, ctx, themes)).map((t) => t.id),
    unlockedBackgrounds: bdefs.filter((b) => rules.isUnlocked(b, ctx, bgs)).map((b) => b.id),
    customBackgroundAllowed: room.level >= rules.CUSTOM_BACKGROUND_MIN_LEVEL,
  };
}

async function updateRoom(userId, body) {
  const out = await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const v = rules.validateRoomPatch(body, { level: room.level });
    if (!v.ok) throw httpError(400, v.error, 'VALIDATION');
    const patch = v.value;
    const ctx = { roomLevel: room.level, achievements: await completedAchievements(client, userId) };
    if (patch.theme_id) {
      const { rows: [t] } = await client.query('SELECT id, unlock_condition, is_premium FROM collection_themes WHERE id = $1', [patch.theme_id]);
      if (!t) throw httpError(404, '主题不存在', 'THEME_NOT_FOUND');
      if (!rules.isUnlocked(t, ctx, await purchasedSet(client, userId, 'theme'))) throw httpError(403, '主题尚未解锁', 'THEME_LOCKED');
    }
    if (patch.background_id) {
      const { rows: [b] } = await client.query('SELECT id, unlock_condition, is_premium FROM collection_backgrounds WHERE id = $1', [patch.background_id]);
      if (!b) throw httpError(404, '背景不存在', 'BACKGROUND_NOT_FOUND');
      if (!rules.isUnlocked(b, ctx, await purchasedSet(client, userId, 'background'))) throw httpError(403, '背景尚未解锁', 'BACKGROUND_LOCKED');
    }
    if (patch.layout_config) {
      // 缩小网格时，已有摆放必须仍在范围内
      const occ = await occupied(client, room.id, null);
      const g = patch.layout_config.gridSize;
      if (occ.some((o) => o.x + o.w > g.width || o.y + o.h > g.height)) throw httpError(409, '有物品在新网格范围之外，请先移动', 'LAYOUT_CONFLICT');
    }
    const cols = Object.keys(patch);
    const vals = cols.map((c) => (c === 'layout_config' ? JSON.stringify(patch[c]) : patch[c]));
    await client.query(`UPDATE collection_rooms SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
      [room.id, ...vals]);
    return room;
  });
  await profileCache.bump(userId);
  return out;
}

// ── 主题 / 背景 ───────────────────────────────────────────────
async function listThemes(userId, kind, lang) {
  const table = kind === 'background' ? 'collection_backgrounds' : 'collection_themes';
  const room = await ensureRoom(db, userId);
  const [{ rows }, achievements, purchased] = await Promise.all([
    db.query(`SELECT * FROM ${table} ORDER BY sort_order, id`), completedAchievements(db, userId), purchasedSet(db, userId, kind)]);
  const ctx = { roomLevel: room.level, achievements };
  return rows.map((r) => ({
    id: r.id, name: localize(r.name_i18n, lang), description: localize(r.description_i18n, lang),
    palette: r.palette, cssGradient: r.css_gradient, previewImage: r.preview_image,
    unlockCondition: r.unlock_condition, isPremium: r.is_premium, priceCoins: r.price_coins,
    unlocked: rules.isUnlocked(r, ctx, purchased), purchased: purchased.has(r.id),
  }));
}

async function deductCoins(client, userId, amount) {
  const { rowCount } = await client.query('UPDATE users SET coins = coins - $2 WHERE id = $1 AND coins >= $2', [userId, amount]);
  if (!rowCount) throw httpError(400, '金币不足', 'INSUFFICIENT_COINS');
}

async function purchaseTheme(userId, kind, id) {
  if (!/^[a-z0-9_]{2,50}$/.test(String(id || ''))) throw httpError(400, 'ID 无效', 'VALIDATION');
  const table = kind === 'background' ? 'collection_backgrounds' : 'collection_themes';
  return db.transaction(async (client) => {
    const { rows: [def] } = await client.query(`SELECT id, is_premium, price_coins FROM ${table} WHERE id = $1`, [id]);
    if (!def) throw httpError(404, '不存在', 'NOT_FOUND');
    if (!def.is_premium || !def.price_coins) throw httpError(400, '该项不需要购买', 'NOT_PURCHASABLE');
    const ins = await client.query(
      `INSERT INTO user_room_unlocks (user_id, kind, ref_id, price_paid) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING ref_id`,
      [userId, kind, id, def.price_coins]);
    if (!ins.rowCount) throw httpError(409, '已拥有', 'ALREADY_OWNED');
    await deductCoins(client, userId, def.price_coins);
    return { kind, id, pricePaid: def.price_coins };
  });
}

// ── 装饰 ──────────────────────────────────────────────────────
function decorationView(r, lang) {
  return {
    id: r.id, itemCode: r.item_code, name: localize(r.name_i18n, lang), description: localize(r.description_i18n, lang),
    category: r.category, rarity: r.rarity, width: r.width, height: r.height, icon: r.icon, imageUrl: r.image_url,
    interactionType: r.interaction_type, source: r.source, priceCoins: r.price_coins, unlockRequirements: r.unlock_requirements,
  };
}

async function catalog({ category, rarity, lang } = {}) {
  const params = []; const where = [];
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  if (rarity) { params.push(rarity); where.push(`rarity = $${params.length}`); }
  const { rows } = await db.query(
    `SELECT * FROM decoration_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3 WHEN 'epic' THEN 4 ELSE 5 END, category, item_code`, params);
  return rows.map((r) => decorationView(r, lang));
}

async function inventory(userId, lang) {
  const room = await ensureRoom(db, userId);
  const { rows } = await db.query(
    `SELECT di.*, ud.quantity, ud.obtained_from, ud.obtained_at,
            (SELECT COUNT(*)::int FROM room_decorations rd WHERE rd.room_id = $2 AND rd.item_id = di.id) AS placed
       FROM user_decorations ud JOIN decoration_items di ON di.id = ud.item_id
      WHERE ud.user_id = $1 AND ud.quantity > 0 ORDER BY ud.obtained_at DESC`, [userId, room.id]);
  return rows.map((r) => ({ ...decorationView(r, lang), quantity: r.quantity, placed: r.placed,
    available: Math.max(0, r.quantity - r.placed), obtainedFrom: r.obtained_from, obtainedAt: r.obtained_at }));
}

async function purchaseDecoration(userId, itemCode, quantity = 1) {
  if (!CODE_RE.test(String(itemCode || ''))) throw httpError(400, 'itemCode 无效', 'VALIDATION');
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw httpError(400, 'quantity 应为 1~10', 'VALIDATION');
  const res = await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const { rows: [item] } = await client.query('SELECT * FROM decoration_items WHERE item_code = $1', [itemCode]);
    if (!item) throw httpError(404, '装饰不存在', 'ITEM_NOT_FOUND');
    if (!item.price_coins || item.source !== 'shop') throw httpError(400, '该装饰不在商店出售', 'NOT_PURCHASABLE');
    if (!rules.meetsCondition(item.unlock_requirements, { roomLevel: room.level })) throw httpError(403, '收藏室等级不足', 'ROOM_LEVEL_TOO_LOW');
    const cost = item.price_coins * qty;
    await deductCoins(client, userId, cost);
    const { rows: [ud] } = await client.query(
      `INSERT INTO user_decorations (user_id, item_id, quantity, obtained_from) VALUES ($1, $2, $3, 'shop')
       ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = user_decorations.quantity + EXCLUDED.quantity
       RETURNING quantity`, [userId, item.id, qty]);
    return { itemCode, quantity: ud.quantity, coinsSpent: cost };
  });
  return res;
}

async function placeDecoration(userId, body) {
  const b = body || {};
  const out = await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const { rows: [item] } = await client.query(
      `SELECT di.*, COALESCE(ud.quantity, 0) AS owned,
              (SELECT COUNT(*)::int FROM room_decorations rd WHERE rd.room_id = $2 AND rd.item_id = di.id) AS placed
         FROM decoration_items di LEFT JOIN user_decorations ud ON ud.item_id = di.id AND ud.user_id = $1
        WHERE ${UUID_RE.test(String(b.itemId || '')) ? 'di.id = $3::uuid' : 'di.item_code = $3'}`, [userId, room.id, String(b.itemId || b.itemCode || '')]);
    if (!item) throw httpError(404, '装饰不存在', 'ITEM_NOT_FOUND');
    if (item.owned <= item.placed) throw httpError(400, '没有可摆放的该装饰（请先获得或购买）', 'NOT_OWNED');
    if (!rules.meetsCondition(item.unlock_requirements, { roomLevel: room.level })) throw httpError(403, '收藏室等级不足', 'ROOM_LEVEL_TOO_LOW');
    const { rows: [cnt] } = await client.query('SELECT COUNT(*)::int AS n FROM room_decorations WHERE room_id = $1', [room.id]);
    if (cnt.n >= rules.capacity(room.level).decorations) throw httpError(409, '装饰位已满，提升收藏室等级可解锁更多', 'CAPACITY_FULL');
    const pos = { x: b.x, y: b.y, rotation: b.rotation ?? 0 };
    const v = rules.validatePlacement(item, pos, grid(room), await occupied(client, room.id, null));
    if (!v.ok) throw httpError(409, v.error, 'PLACEMENT_INVALID');
    const { rows: [rd] } = await client.query(
      `INSERT INTO room_decorations (room_id, item_id, position_x, position_y, rotation, scale, z_index, custom_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [room.id, item.id, Number(b.x), Number(b.y), Number(pos.rotation), rules.clampScale(b.scale), Number.isInteger(b.zIndex) ? b.zIndex : 0,
        JSON.stringify(b.customConfig && typeof b.customConfig === 'object' ? b.customConfig : {})]);
    const exp = await grantExp(client, room.id, 'decoration_placed', item.id);
    await engine.recordEvent(client, userId, 'room_decorated', { roomId: room.id, itemCode: item.item_code });
    return { id: rd.id, itemCode: item.item_code, exp };
  });
  await profileCache.bump(userId);
  return out;
}

async function moveDecoration(userId, decorationId, body) {
  assertUuid(decorationId, 'decorationId');
  const b = body || {};
  await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const { rows: [d] } = await client.query(
      `SELECT rd.*, di.width, di.height, di.category FROM room_decorations rd JOIN decoration_items di ON di.id = rd.item_id
        WHERE rd.id = $1 AND rd.room_id = $2`, [decorationId, room.id]);
    if (!d) throw httpError(404, '装饰不存在', 'NOT_FOUND');
    const pos = { x: b.x ?? d.position_x, y: b.y ?? d.position_y, rotation: b.rotation ?? d.rotation };
    const v = rules.validatePlacement(d, pos, grid(room), await occupied(client, room.id, `d:${d.id}`));
    if (!v.ok) throw httpError(409, v.error, 'PLACEMENT_INVALID');
    await client.query(
      `UPDATE room_decorations SET position_x = $2, position_y = $3, rotation = $4, scale = $5, z_index = $6 WHERE id = $1`,
      [d.id, Number(pos.x), Number(pos.y), Number(pos.rotation), b.scale !== undefined ? rules.clampScale(b.scale) : d.scale,
        Number.isInteger(b.zIndex) ? b.zIndex : d.z_index]);
    await client.query('UPDATE collection_rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
  });
  await profileCache.bump(userId);
  return { id: decorationId, moved: true };
}

async function removeDecoration(userId, decorationId) {
  assertUuid(decorationId, 'decorationId');
  const { rowCount } = await db.query(
    `DELETE FROM room_decorations WHERE id = $1 AND room_id = (SELECT id FROM collection_rooms WHERE user_id = $2)`, [decorationId, userId]);
  if (!rowCount) throw httpError(404, '装饰不存在', 'NOT_FOUND');
  await profileCache.bump(userId);
  return { removed: true };
}

// ── 展示精灵 ──────────────────────────────────────────────────
async function displayPokemon(userId, body) {
  const b = body || {};
  assertUuid(b.pokemonId, 'pokemonId');
  const out = await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const { rows: [p] } = await client.query(
      `SELECT id, is_shiny FROM pokemon_instances
        WHERE id = $1 AND user_id = $2 AND NOT COALESCE(is_released, FALSE) AND NOT COALESCE(is_deleted, FALSE)`, [b.pokemonId, userId]);
    if (!p) throw httpError(404, '精灵不存在或不属于你', 'POKEMON_NOT_FOUND');
    const { rows: [cnt] } = await client.query('SELECT COUNT(*)::int AS n FROM collection_room_pokemon WHERE room_id = $1', [room.id]);
    if (cnt.n >= rules.capacity(room.level).pokemon) throw httpError(409, '展示位已满，提升收藏室等级可解锁更多（最多 50 只）', 'CAPACITY_FULL');
    const displayMode = b.displayMode || (p.is_shiny ? 'shiny' : 'idle');
    if (!rules.DISPLAY_MODES.includes(displayMode)) throw httpError(400, `displayMode 必须是 ${rules.DISPLAY_MODES.join('/')}`, 'VALIDATION');
    if (displayMode === 'shiny' && !p.is_shiny) throw httpError(400, '只有闪光精灵可以使用闪光展示', 'VALIDATION');
    const pedestal = b.pedestalType || 'basic';
    if (!rules.pedestalAllowed(pedestal, room.level)) throw httpError(403, '收藏室等级不足，不能使用该展示台', 'ROOM_LEVEL_TOO_LOW');
    let pos = { x: b.x, y: b.y };
    const occ = await occupied(client, room.id, null);
    if (pos.x === undefined || pos.y === undefined) pos = firstFreeCell(grid(room), occ) || { x: -1, y: -1 };
    const v = rules.validatePlacement({ width: 1, height: 1, category: 'pokemon' }, pos, grid(room), occ);
    if (!v.ok) throw httpError(409, v.error, 'PLACEMENT_INVALID');
    try {
      await client.query(
        `INSERT INTO collection_room_pokemon (room_id, pokemon_instance_id, position_x, position_y, position_z, scale, rotation,
                                              display_mode, pedestal_type, animation_speed, custom_label, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [room.id, p.id, Number(pos.x), Number(pos.y), Number.isInteger(b.z) ? b.z : 0, rules.clampScale(b.scale),
          Math.abs(Number(b.rotation) || 0) % 360, displayMode, pedestal,
          Math.min(3, Math.max(0.25, Number(b.animationSpeed) || 1)), b.label ? String(b.label).replace(/[<>]/g, '').slice(0, 100) : null,
          cnt.n]);
    } catch (err) {
      if (err.code === '23505') throw httpError(409, '这只精灵已经在展示中', 'ALREADY_DISPLAYED');
      throw err;
    }
    const exp = await grantExp(client, room.id, 'pokemon_displayed', p.id);
    await engine.recordEvent(client, userId, 'room_pokemon_changed', { roomId: room.id, pokemonId: p.id, isShiny: p.is_shiny });
    return { pokemonId: p.id, x: Number(pos.x), y: Number(pos.y), exp };
  });
  await profileCache.bump(userId);
  return out;
}

function firstFreeCell(g, occ) {
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!occ.some((o) => o.layer === 'object' && rules.overlaps({ x, y, w: 1, h: 1 }, o))) return { x, y };
    }
  }
  return null;
}

async function updateDisplayedPokemon(userId, pokemonId, body) {
  assertUuid(pokemonId, 'pokemonId');
  const b = body || {};
  await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const { rows: [m] } = await client.query(
      `SELECT crp.*, pi.is_shiny FROM collection_room_pokemon crp JOIN pokemon_instances pi ON pi.id = crp.pokemon_instance_id
        WHERE crp.room_id = $1 AND crp.pokemon_instance_id = $2`, [room.id, pokemonId]);
    if (!m) throw httpError(404, '该精灵不在收藏室中', 'NOT_FOUND');
    const pos = { x: b.x ?? m.position_x, y: b.y ?? m.position_y };
    const v = rules.validatePlacement({ width: 1, height: 1, category: 'pokemon' }, pos, grid(room), await occupied(client, room.id, `p:${pokemonId}`));
    if (!v.ok) throw httpError(409, v.error, 'PLACEMENT_INVALID');
    const mode = b.displayMode ?? m.display_mode;
    if (!rules.DISPLAY_MODES.includes(mode)) throw httpError(400, 'displayMode 无效', 'VALIDATION');
    if (mode === 'shiny' && !m.is_shiny) throw httpError(400, '只有闪光精灵可以使用闪光展示', 'VALIDATION');
    const pedestal = b.pedestalType ?? m.pedestal_type;
    if (!rules.pedestalAllowed(pedestal, room.level)) throw httpError(403, '收藏室等级不足，不能使用该展示台', 'ROOM_LEVEL_TOO_LOW');
    await client.query(
      `UPDATE collection_room_pokemon SET position_x = $3, position_y = $4, position_z = $5, scale = $6, rotation = $7,
              display_mode = $8, pedestal_type = $9, animation_speed = $10, custom_label = $11
        WHERE room_id = $1 AND pokemon_instance_id = $2`,
      [room.id, pokemonId, Number(pos.x), Number(pos.y), Number.isInteger(b.z) ? b.z : m.position_z,
        b.scale !== undefined ? rules.clampScale(b.scale) : m.scale, b.rotation !== undefined ? Math.abs(Number(b.rotation) || 0) % 360 : m.rotation,
        mode, pedestal, b.animationSpeed !== undefined ? Math.min(3, Math.max(0.25, Number(b.animationSpeed) || 1)) : m.animation_speed,
        b.label !== undefined ? (b.label ? String(b.label).replace(/[<>]/g, '').slice(0, 100) : null) : m.custom_label]);
    await client.query('UPDATE collection_rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
  });
  await profileCache.bump(userId);
  return { pokemonId, updated: true };
}

async function removeDisplayedPokemon(userId, pokemonId) {
  assertUuid(pokemonId, 'pokemonId');
  const { rowCount } = await db.query(
    `DELETE FROM collection_room_pokemon WHERE pokemon_instance_id = $1 AND room_id = (SELECT id FROM collection_rooms WHERE user_id = $2)`,
    [pokemonId, userId]);
  if (!rowCount) throw httpError(404, '该精灵不在收藏室中', 'NOT_FOUND');
  await profileCache.bump(userId);
  return { removed: true };
}

/**
 * 批量保存布局（拖拽编辑器"保存"）：整体校验后一次更新
 * body: { pokemon: [{pokemonId, x, y, z?, scale?, rotation?}], decorations: [{id, x, y, rotation?, scale?, zIndex?}] }
 */
async function saveLayout(userId, body) {
  const b = body || {};
  const mons = Array.isArray(b.pokemon) ? b.pokemon : [];
  const decos = Array.isArray(b.decorations) ? b.decorations : [];
  if (mons.length + decos.length === 0 || mons.length + decos.length > 200) throw httpError(400, '布局为空或过大', 'VALIDATION');
  await db.transaction(async (client) => {
    const room = await lockRoom(client, userId);
    const { rows: curD } = await client.query(
      `SELECT rd.*, di.width, di.height, di.category FROM room_decorations rd JOIN decoration_items di ON di.id = rd.item_id WHERE rd.room_id = $1`, [room.id]);
    const { rows: curP } = await client.query('SELECT * FROM collection_room_pokemon WHERE room_id = $1', [room.id]);
    const dMap = new Map(decos.map((d) => [String(d.id), d]));
    const pMap = new Map(mons.map((p) => [String(p.pokemonId), p]));
    for (const id of dMap.keys()) if (!curD.some((d) => d.id === id)) throw httpError(404, `装饰 ${id} 不在收藏室中`, 'NOT_FOUND');
    for (const id of pMap.keys()) if (!curP.some((p) => p.pokemon_instance_id === id)) throw httpError(404, `精灵 ${id} 不在收藏室中`, 'NOT_FOUND');
    const entries = [
      ...curD.map((d) => { const n = dMap.get(d.id) || {}; return { key: `d:${d.id}`, item: d,
        pos: { x: n.x ?? d.position_x, y: n.y ?? d.position_y, rotation: n.rotation ?? d.rotation } }; }),
      ...curP.map((p) => { const n = pMap.get(p.pokemon_instance_id) || {}; return { key: `p:${p.pokemon_instance_id}`,
        item: { width: 1, height: 1, category: 'pokemon' }, pos: { x: n.x ?? p.position_x, y: n.y ?? p.position_y } }; }),
    ];
    const v = rules.validateLayout(entries, grid(room));
    if (!v.ok) throw httpError(409, v.error, 'PLACEMENT_INVALID');
    for (const d of curD) {
      const n = dMap.get(d.id);
      if (!n) continue;
      await client.query('UPDATE room_decorations SET position_x = $2, position_y = $3, rotation = $4, scale = $5, z_index = $6 WHERE id = $1',
        [d.id, Number(n.x ?? d.position_x), Number(n.y ?? d.position_y), Number(n.rotation ?? d.rotation),
          n.scale !== undefined ? rules.clampScale(n.scale) : d.scale, Number.isInteger(n.zIndex) ? n.zIndex : d.z_index]);
    }
    for (const p of curP) {
      const n = pMap.get(p.pokemon_instance_id);
      if (!n) continue;
      await client.query(
        `UPDATE collection_room_pokemon SET position_x = $2, position_y = $3, position_z = $4, scale = $5, rotation = $6 WHERE id = $1`,
        [p.id, Number(n.x ?? p.position_x), Number(n.y ?? p.position_y), Number.isInteger(n.z) ? n.z : p.position_z,
          n.scale !== undefined ? rules.clampScale(n.scale) : p.scale, n.rotation !== undefined ? Math.abs(Number(n.rotation) || 0) % 360 : p.rotation]);
    }
    await client.query('UPDATE collection_rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
  });
  await profileCache.bump(userId);
  return { saved: true, pokemon: mons.length, decorations: decos.length };
}

// ── 访问 / 点赞 / 留言 ────────────────────────────────────────
async function roomById(roomId) {
  assertUuid(roomId, 'roomId');
  const { rows } = await db.query('SELECT * FROM collection_rooms WHERE id = $1', [roomId]);
  if (!rows.length) throw httpError(404, '收藏室不存在', 'ROOM_NOT_FOUND');
  return rows[0];
}

async function roomByUser(userId) {
  assertUuid(userId, 'userId');
  const { rows } = await db.query('SELECT * FROM collection_rooms WHERE user_id = $1', [userId]);
  if (!rows.length) throw httpError(404, '该玩家还没有收藏室', 'ROOM_NOT_FOUND');
  return rows[0];
}

async function assertVisible(room, viewerId) {
  if (room.user_id === viewerId) return;
  if (!room.is_public) throw httpError(403, '该收藏室未公开', 'ROOM_PRIVATE');
  // E01 黑名单：被房主拉黑的玩家不能参观/点赞/留言
  const { rows: [b] } = await db.query('SELECT 1 FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2', [room.user_id, viewerId]);
  if (b) throw httpError(403, '无法访问该收藏室', 'ROOM_BLOCKED');
}

/** 访问（记录每人每天一次的访客数与经验）；返回完整房间内容 + 本人点赞状态 + 最近留言 */
async function visit(viewerId, room, lang) {
  await assertVisible(room, viewerId);
  const isOwner = room.user_id === viewerId;
  if (!isOwner) {
    await db.transaction(async (client) => {
      const { rows: [v] } = await client.query(
        `INSERT INTO room_visits (room_id, visitor_id) VALUES ($1, $2)
         ON CONFLICT (room_id, visitor_id, visit_date) DO UPDATE SET visit_count = room_visits.visit_count + 1, last_visited_at = NOW()
         RETURNING (xmax = 0) AS first_today, visit_date::text AS visit_date`, [room.id, viewerId]);
      if (v.first_today) {
        await client.query('UPDATE collection_rooms SET visitor_count = visitor_count + 1 WHERE id = $1', [room.id]);
        await grantExp(client, room.id, 'visitor_came', `${viewerId}:${v.visit_date}`);
      }
      return v.first_today;
    }).then(async (first) => { if (first) await profileCache.bump(room.user_id); }); // 同一访客当天重复访问不使缓存失效
  }
  const fresh = (await db.query('SELECT * FROM collection_rooms WHERE id = $1', [room.id])).rows[0];
  const detail = await detailCached(fresh, lang);
  const [{ rows: [like] }, comments] = await Promise.all([
    db.query('SELECT active FROM room_likes WHERE room_id = $1 AND user_id = $2', [room.id, viewerId]),
    listComments(viewerId, room.id, { limit: 10 }),
  ]);
  return { ...detail, isOwner, likedByMe: !!(like && like.active), comments: comments.comments };
}

async function endVisit(viewerId, roomId, durationSeconds) {
  assertUuid(roomId, 'roomId');
  const d = Math.floor(Number(durationSeconds));
  if (!Number.isFinite(d) || d < 0) throw httpError(400, 'durationSeconds 无效', 'VALIDATION');
  const { rowCount } = await db.query(
    `UPDATE room_visits SET duration_seconds = duration_seconds + LEAST($3, 3600), last_visited_at = NOW()
      WHERE room_id = $1 AND visitor_id = $2 AND visit_date = CURRENT_DATE`, [roomId, viewerId, d]);
  if (!rowCount) throw httpError(404, '没有进行中的访问', 'VISIT_NOT_FOUND');
  return { recorded: true, durationSeconds: Math.min(d, 3600) };
}

async function like(userId, roomId) {
  const room = await roomById(roomId);
  await assertVisible(room, userId);
  if (room.user_id === userId) throw httpError(400, '不能给自己的收藏室点赞', 'SELF_LIKE');
  const res = await db.transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO room_likes (room_id, user_id) VALUES ($1, $2)
       ON CONFLICT (room_id, user_id) DO UPDATE SET active = TRUE, updated_at = NOW() WHERE NOT room_likes.active
       RETURNING (xmax = 0) AS first_time`, [roomId, userId]);
    if (!rows.length) return { liked: true, changed: false };
    const { rows: [r] } = await client.query('UPDATE collection_rooms SET like_count = like_count + 1 WHERE id = $1 RETURNING like_count', [roomId]);
    if (rows[0].first_time) await grantExp(client, roomId, 'visitor_liked', userId);
    await engine.recordEvent(client, room.user_id, 'room_liked', { roomId, likerId: userId, likeCount: r.like_count });
    return { liked: true, changed: true, likeCount: r.like_count };
  });
  if (res.changed) await profileCache.bump(room.user_id);
  if (res.likeCount === undefined) res.likeCount = (await db.query('SELECT like_count FROM collection_rooms WHERE id = $1', [roomId])).rows[0].like_count;
  return res;
}

async function unlike(userId, roomId) {
  assertUuid(roomId, 'roomId');
  const res = await db.transaction(async (client) => {
    const { rowCount } = await client.query(
      'UPDATE room_likes SET active = FALSE, updated_at = NOW() WHERE room_id = $1 AND user_id = $2 AND active', [roomId, userId]);
    if (!rowCount) return { liked: false, changed: false };
    const { rows: [r] } = await client.query(
      'UPDATE collection_rooms SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1 RETURNING like_count, user_id', [roomId]);
    return { liked: false, changed: true, likeCount: r.like_count, ownerId: r.user_id };
  });
  if (res.ownerId) await profileCache.bump(res.ownerId);
  delete res.ownerId;
  return res;
}

async function listComments(viewerId, roomId, { limit = 20, before } = {}) {
  assertUuid(roomId, 'roomId');
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const params = [roomId];
  let extra = '';
  if (before) { const d = new Date(before); if (!Number.isNaN(d.getTime())) { params.push(d); extra = ` AND c.created_at < $${params.length}`; } }
  const { rows } = await db.query(
    `SELECT c.id, c.user_id, c.content, c.created_at, u.nickname, u.avatar_url
       FROM room_comments c JOIN users u ON u.id = c.user_id
      WHERE c.room_id = $1 AND NOT c.is_deleted${extra} ORDER BY c.created_at DESC LIMIT ${n}`, params);
  return { comments: rows.map((r) => ({ id: r.id, userId: r.user_id, nickname: r.nickname, avatarUrl: r.avatar_url,
    content: r.content, createdAt: r.created_at, mine: r.user_id === viewerId })) };
}

async function addComment(userId, roomId, content) {
  const room = await roomById(roomId);
  await assertVisible(room, userId);
  const v = rules.sanitizeComment(content);
  if (!v.ok) throw httpError(400, v.error, 'VALIDATION');
  const out = await db.transaction(async (client) => {
    const { rows: [today] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM room_comments WHERE room_id = $1 AND user_id = $2 AND created_at > NOW() - INTERVAL '1 day'`, [roomId, userId]);
    if (today.n >= 10) throw httpError(429, '今天在这个收藏室的留言次数已达上限', 'COMMENT_LIMIT');
    const { rows: [c] } = await client.query(
      'INSERT INTO room_comments (room_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, created_at', [roomId, userId, v.value]);
    await client.query('UPDATE collection_rooms SET comment_count = comment_count + 1 WHERE id = $1', [roomId]);
    if (room.user_id !== userId) {
      const day = new Date().toISOString().slice(0, 10);
      await grantExp(client, roomId, 'visitor_commented', `${userId}:${day}`);
      const { rows: [u] } = await client.query('SELECT nickname FROM users WHERE id = $1', [userId]);
      await center.notify(client, room.user_id, {
        type: 'social.collection_comment', templateKey: 'collection_comment', category: 'social', priority: 'low',
        params: { commenter_name: (u && u.nickname) || '训练师', comment: v.value.slice(0, 60) },
        data: { roomId, commentId: c.id, commenterId: userId }, actionUrl: '/collection-room', dedupeKey: `comment:${c.id}`,
      });
    }
    return { id: c.id, content: v.value, createdAt: c.created_at };
  });
  await profileCache.bump(room.user_id);
  return out;
}

async function deleteComment(userId, roomId, commentId) {
  assertUuid(roomId, 'roomId'); assertUuid(commentId, 'commentId');
  const out = await db.transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE room_comments c SET is_deleted = TRUE FROM collection_rooms r
        WHERE c.id = $1 AND c.room_id = $2 AND r.id = c.room_id AND NOT c.is_deleted AND (c.user_id = $3 OR r.user_id = $3)
        RETURNING r.user_id`, [commentId, roomId, userId]);
    if (!rows.length) throw httpError(404, '留言不存在或无权删除', 'NOT_FOUND');
    await client.query('UPDATE collection_rooms SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [roomId]);
    return rows[0].user_id;
  });
  await profileCache.bump(out);
  return { deleted: true };
}

// ── 排行 / 统计 ───────────────────────────────────────────────
const SORTS = { likes: 'r.like_count DESC, r.visitor_count DESC', visitors: 'r.visitor_count DESC, r.like_count DESC',
  level: 'r.level DESC, r.experience DESC', recent: 'r.updated_at DESC' };

async function popular({ sort = 'likes', limit = 20 } = {}) {
  const s = SORTS[sort] ? sort : 'likes';
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const key = `room:popular:${s}:${n}`;
  try { const raw = await getRedis().get(key); if (raw) return JSON.parse(raw); } catch { /* 缓存不可用 */ }
  const { rows } = await db.query(
    `SELECT r.id, r.user_id, r.room_name, r.theme_id, r.level, r.like_count, r.visitor_count, r.comment_count, u.nickname,
            (SELECT COUNT(*)::int FROM collection_room_pokemon p WHERE p.room_id = r.id) AS pokemon_count
       FROM collection_rooms r JOIN users u ON u.id = r.user_id
      WHERE r.is_public AND NOT COALESCE(u.is_banned, FALSE)
      ORDER BY ${SORTS[s]} LIMIT ${n}`);
  const out = rows.map((r, i) => ({ rank: i + 1, roomId: r.id, ownerId: r.user_id, ownerNickname: r.nickname, roomName: r.room_name,
    themeId: r.theme_id, level: r.level, likeCount: r.like_count, visitorCount: r.visitor_count, commentCount: r.comment_count,
    pokemonCount: r.pokemon_count }));
  try { await getRedis().setex(key, 60, JSON.stringify(out)); } catch { /* 忽略 */ }
  return out;
}

/** 收藏统计（REQ-00403）：展示数量、稀有度分布、闪光数、图鉴完成度、访客/点赞趋势 */
async function stats(userId) {
  const room = await ensureRoom(db, userId);
  const [{ rows: dist }, { rows: [c] }, { rows: [dex] }, { rows: visits }] = await Promise.all([
    db.query(`SELECT ps.rarity::text AS rarity, COUNT(*)::int AS count FROM collection_room_pokemon p
                JOIN pokemon_instances pi ON pi.id = p.pokemon_instance_id JOIN pokemon_species ps ON ps.id = pi.species_id
               WHERE p.room_id = $1 GROUP BY ps.rarity`, [room.id]),
    db.query(`SELECT COUNT(*)::int AS displayed, COUNT(*) FILTER (WHERE pi.is_shiny)::int AS shiny,
                     COUNT(DISTINCT pi.species_id)::int AS species, COALESCE(MAX(pi.cp), 0) AS max_cp
                FROM collection_room_pokemon p JOIN pokemon_instances pi ON pi.id = p.pokemon_instance_id WHERE p.room_id = $1`, [room.id]),
    db.query(`SELECT (SELECT COUNT(*)::int FROM pokedex_entries WHERE user_id = $1 AND caught_count > 0) AS caught,
                     (SELECT COUNT(*)::int FROM pokemon_species) AS total`, [userId]),
    db.query(`SELECT visit_date, COUNT(*)::int AS visitors, SUM(duration_seconds)::int AS duration
                FROM room_visits WHERE room_id = $1 AND visit_date > CURRENT_DATE - 7 GROUP BY visit_date ORDER BY visit_date`, [room.id]),
  ]);
  return {
    roomId: room.id, level: room.level, capacity: rules.capacity(room.level),
    displayed: c.displayed, shiny: c.shiny, species: c.species, maxCp: c.max_cp,
    rarityDistribution: rules.rarityDistribution(dist),
    pokedex: { caught: dex.caught, total: dex.total, completionRate: dex.total ? +(dex.caught / dex.total).toFixed(4) : 0 },
    visitorCount: room.visitor_count, likeCount: room.like_count, commentCount: room.comment_count, last7Days: visits,
  };
}

module.exports = {
  ensureRoom, getMyRoom, updateRoom, listThemes, purchaseTheme, catalog, inventory, purchaseDecoration,
  placeDecoration, moveDecoration, removeDecoration, displayPokemon, updateDisplayedPokemon, removeDisplayedPokemon, saveLayout,
  roomById, roomByUser, visit, endVisit, like, unlike, listComments, addComment, deleteComment, popular, stats, grantExp, loadDetail,
};
