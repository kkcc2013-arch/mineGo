/**
 * 站内消息中心（数据访问层）——REQ-00099 / REQ-00261 / REQ-00425
 *
 * 所有服务生成站内消息都走 notify()：按玩家偏好过滤 → 按模板渲染（默认中文落库，读取时按请求语言重新渲染）
 * → 写 notifications（dedupe_key 去重）→ 记录 notification_events(sent)。插入触发 pg_notify，user-service 实时推送。
 * notify() 可传入事务 client，与业务写入同事务提交/回滚。
 */
'use strict';

const policy = require('./notificationPolicy');
const { normalizeLang } = require('./achievementRules');

const DEFAULT_LANG = 'zh-CN';
const TEMPLATE_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYPE_ICONS = {
  'reward.level_up': '⬆️', 'reward.achievement_unlock': '🏆', 'reward.title_unlock': '🎖️', 'social.friend_request': '👋',
  'social.gift_received': '🎁', 'social.trade_complete': '🔄', 'social.collection_liked': '❤️', 'social.collection_comment': '💬',
  'event.started': '🎉', 'system.announcement': '📢', 'reward.room_level_up': '🏛️', 'reward.decoration_unlock': '🪴',
};

function defaultDb() { return require('./db'); }

// ── 模板缓存 ──────────────────────────────────────────────────
let templateCache = { at: 0, map: null };
async function loadTemplates(q) {
  if (templateCache.map && Date.now() - templateCache.at < TEMPLATE_TTL_MS) return templateCache.map;
  const { rows } = await q.query(
    `SELECT t.template_key, t.category, t.priority, c.language, c.title_template, c.body_template
       FROM notification_templates t JOIN notification_template_contents c ON c.template_id = t.id`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.template_key)) map.set(r.template_key, { category: r.category, priority: r.priority, langs: {} });
    map.get(r.template_key).langs[r.language] = { title: r.title_template, body: r.body_template };
  }
  templateCache = { at: Date.now(), map };
  return map;
}
function resetTemplateCache() { templateCache = { at: 0, map: null }; }

/** 按语言渲染；params._i18n[lang] 可覆盖个别参数（如活动名的英/日文） */
function renderWith(templates, templateKey, params, lang, fallback = {}) {
  const t = templateKey && templates && templates.get(templateKey);
  const l = normalizeLang(lang);
  const p = { ...(params || {}), ...(((params || {})._i18n || {})[l] || {}) };
  delete p._i18n;
  const c = t && (t.langs[l] || t.langs[DEFAULT_LANG]);
  if (!c) return { title: fallback.title || '', body: fallback.body || '' };
  return { title: policy.renderTemplate(c.title, p), body: policy.renderTemplate(c.body, p) };
}

// ── 偏好 ──────────────────────────────────────────────────────
async function loadPreferenceRow(q, userId) {
  const { rows } = await q.query('SELECT * FROM user_push_preferences WHERE user_id = $1', [userId]);
  return rows[0] || null;
}
async function getPreferences(userId, q = defaultDb()) {
  return policy.normalizePreferences(await loadPreferenceRow(q, userId));
}

async function updatePreferences(userId, patch, q = defaultDb()) {
  const v = policy.validatePreferencePatch(patch);
  if (!v.ok) { const e = new Error(v.error); e.statusCode = 400; throw e; }
  const cols = Object.keys(v.value);
  const vals = cols.map((c) => (c === 'notification_types' || c === 'quiet_hours' ? JSON.stringify(v.value[c]) : v.value[c]));
  // notification_types 与已有值合并（只改传入的键）
  const sets = cols.map((c, i) => (c === 'notification_types'
    ? `notification_types = COALESCE(user_push_preferences.notification_types, '{}'::jsonb) || $${i + 2}::jsonb`
    : `${c} = $${i + 2}`));
  await q.query(
    `INSERT INTO user_push_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  await q.query(`UPDATE user_push_preferences SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = $1`, [userId, ...vals]);
  return getPreferences(userId, q);
}

// ── 生成消息 ──────────────────────────────────────────────────
/**
 * @param {object} q        db 模块或事务 client（有 query 方法）
 * @param {string} userId
 * @param {object} note     {type, templateKey, params, category, priority, title, body, data, actionUrl, icon, dedupeKey, expiresInDays}
 * @returns {Promise<{created: boolean, id?: string, reason?: string}>}
 */
async function notify(q, userId, note) {
  if (!userId || !note || !note.type) return { created: false, reason: 'invalid' };
  const templates = await loadTemplates(q);
  const tpl = note.templateKey ? templates.get(note.templateKey) : null;
  const category = policy.CATEGORIES.includes(note.category) ? note.category : policy.categoryOf(note.category || (tpl && tpl.category) || note.type);
  const priority = policy.PRIORITIES.includes(note.priority) ? note.priority : ((tpl && policy.PRIORITIES.includes(tpl.priority)) ? tpl.priority : 'normal');
  const prefs = policy.normalizePreferences(await loadPreferenceRow(q, userId));
  if (!policy.isAllowed(prefs, { type: note.type, category })) return { created: false, reason: 'disabled_by_user' };

  const params = sanitizeParams(note.params || {});
  const { title, body } = renderWith(templates, note.templateKey, params, DEFAULT_LANG, note);
  const days = Number.isFinite(note.expiresInDays) ? Math.min(Math.max(note.expiresInDays, 1), 365) : 30;
  const { rows } = await q.query(
    `INSERT INTO notifications (user_id, type, category, priority, title, body, template_key, params, data, icon, action_url,
                                dedupe_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() + ($13 || ' days')::interval)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, note.type, category, priority, policy.sanitizeText(title || note.title || note.type, 200),
      policy.sanitizeText(body || note.body || '', 1000), note.templateKey || null, JSON.stringify(params),
      JSON.stringify(note.data || {}), note.icon || TYPE_ICONS[note.type] || null, note.actionUrl || null,
      note.dedupeKey || null, String(days)],
  );
  if (!rows.length) return { created: false, reason: 'duplicate' };
  await q.query(
    `INSERT INTO notification_events (notification_id, user_id, event_type, channel, metadata) VALUES ($1, $2, 'sent', 'in_app', $3)`,
    [rows[0].id, userId, JSON.stringify({ type: note.type, priority })],
  );
  return { created: true, id: rows[0].id };
}

function sanitizeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === '_i18n' && v && typeof v === 'object') { out._i18n = v; continue; }
    out[k] = typeof v === 'string' ? policy.sanitizeText(v, 200) : v;
  }
  return out;
}

// ── 全服广播 ──────────────────────────────────────────────────
async function createBroadcast(b, q = defaultDb()) {
  const category = policy.CATEGORIES.includes(b.category) ? b.category : 'system';
  const priority = policy.PRIORITIES.includes(b.priority) ? b.priority : 'normal';
  const { rows } = await q.query(
    `INSERT INTO notification_broadcasts (type, category, priority, template_key, params, title, body, data, action_url, audience,
                                          dedupe_key, starts_at, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, NOW()),
             COALESCE($13::timestamptz, NOW() + INTERVAL '7 days'), $14)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [b.type || 'system.announcement', category, priority, b.templateKey || 'system_announcement',
      JSON.stringify(sanitizeParams(b.params || { title: b.title, body: b.body })),
      policy.sanitizeText(b.title, 200), policy.sanitizeText(b.body || '', 1000), JSON.stringify(b.data || {}),
      b.actionUrl || null, JSON.stringify(b.audience || {}), b.dedupeKey || null, b.startsAt || null, b.expiresAt || null,
      b.createdBy || null],
  );
  return rows[0] || null;
}

/** 把当前有效、符合受众条件、尚未物化的广播写成该玩家的站内消息（被关闭的分类跳过） */
async function materializeBroadcasts(userId, q = defaultDb()) {
  const prefs = await getPreferences(userId, q);
  const disabled = policy.CATEGORIES.filter((c) => !policy.isAllowed(prefs, { category: c }));
  const { rowCount } = await q.query(
    `INSERT INTO notifications (user_id, type, category, priority, title, body, template_key, params, data, action_url, dedupe_key,
                                icon, expires_at, created_at)
     SELECT u.id, b.type, b.category, b.priority, b.title, b.body, b.template_key, b.params, b.data || jsonb_build_object('broadcastId', b.id),
            b.action_url, 'bc:' || b.id, NULL, b.expires_at, GREATEST(b.starts_at, u.created_at)
       FROM notification_broadcasts b
       JOIN users u ON u.id = $1
      WHERE b.starts_at <= NOW() AND b.expires_at > NOW()
        AND NOT (b.category = ANY($2::text[]))
        AND (NOT (b.audience ? 'minLevel') OR u.level >= (b.audience->>'minLevel')::int)
        AND (NOT (b.audience ? 'team') OR u.team::text = b.audience->>'team')
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.dedupe_key = 'bc:' || b.id)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [userId, disabled],
  );
  return rowCount;
}

// ── 查询与管理 ────────────────────────────────────────────────
function view(row, templates, lang) {
  const l = normalizeLang(lang);
  const text = l === DEFAULT_LANG ? { title: row.title, body: row.body }
    : renderWith(templates, row.template_key, row.params, l, { title: row.title, body: row.body });
  const label = policy.CATEGORY_LABELS[row.category] || policy.CATEGORY_LABELS.system;
  return {
    id: row.id, type: row.type, category: row.category, categoryLabel: label[l] || label['zh-CN'],
    priority: row.priority, icon: row.icon || label.icon,
    title: text.title || row.title, body: text.body || row.body,
    data: row.data || {}, actionUrl: row.action_url,
    isRead: row.is_read, readAt: row.read_at, clickedAt: row.clicked_at,
    createdAt: row.created_at, expiresAt: row.expires_at,
  };
}

const LIVE = 'NOT is_deleted AND expires_at > NOW()';

async function list(userId, opts = {}, q = defaultDb()) {
  if (opts.category && opts.category !== 'all' && !policy.CATEGORIES.includes(opts.category)) {
    const e = new Error('category 无效'); e.statusCode = 400; throw e;
  }
  await materializeBroadcasts(userId, q);
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 100);
  const where = ['user_id = $1', LIVE];
  const params = [userId];
  if (opts.status === 'unread') where.push('NOT is_read');
  else if (opts.status === 'read') where.push('is_read');
  if (opts.category && opts.category !== 'all') {
    if (!policy.CATEGORIES.includes(opts.category)) { const e = new Error('category 无效'); e.statusCode = 400; throw e; }
    params.push(opts.category); where.push(`category = $${params.length}`);
  }
  if (opts.type) { params.push(String(opts.type).slice(0, 60)); where.push(`type = $${params.length}`); }
  if (opts.since) {
    const d = new Date(opts.since);
    if (!Number.isNaN(d.getTime())) { params.push(d); where.push(`created_at > $${params.length}`); }
  }
  const w = where.join(' AND ');
  const [{ rows }, { rows: [cnt] }, unread, templates] = await Promise.all([
    q.query(`SELECT * FROM notifications WHERE ${w}
              ORDER BY (priority = 'urgent' AND NOT is_read) DESC, created_at DESC
              LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params),
    q.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE ${w}`, params),
    unreadCount(userId, q, { skipMaterialize: true }),
    loadTemplates(q),
  ]);
  return {
    notifications: rows.map((r) => view(r, templates, opts.lang)),
    pagination: { total: cnt.n, page, limit, totalPages: Math.max(1, Math.ceil(cnt.n / limit)) },
    unreadCount: unread.total,
  };
}

async function unreadCount(userId, q = defaultDb(), { skipMaterialize = false } = {}) {
  if (!skipMaterialize) await materializeBroadcasts(userId, q);
  const { rows } = await q.query(
    `SELECT category, type, COUNT(*)::int AS n FROM notifications
      WHERE user_id = $1 AND NOT is_read AND ${LIVE} GROUP BY category, type`, [userId]);
  const byCategory = Object.fromEntries(policy.CATEGORIES.map((c) => [c, 0]));
  const byType = {};
  let total = 0;
  for (const r of rows) {
    byCategory[r.category] = (byCategory[r.category] || 0) + r.n;
    byType[r.type] = (byType[r.type] || 0) + r.n;
    total += r.n;
  }
  return { total, byCategory, byType };
}

function assertId(id) {
  if (!UUID_RE.test(String(id || ''))) { const e = new Error('通知 ID 无效'); e.statusCode = 400; throw e; }
}

async function markRead(userId, id, q = defaultDb()) {
  assertId(id);
  const { rows } = await q.query(
    `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2 AND NOT is_deleted RETURNING id, (xmax = 0) AS fresh, read_at`, [id, userId]);
  if (!rows.length) { const e = new Error('通知不存在'); e.statusCode = 404; throw e; }
  await q.query(
    `INSERT INTO notification_events (notification_id, user_id, event_type, channel)
     SELECT $1, $2, 'opened', 'in_app' WHERE NOT EXISTS (
       SELECT 1 FROM notification_events WHERE notification_id = $1 AND event_type = 'opened')`, [id, userId]);
  return { id, isRead: true, readAt: rows[0].read_at };
}

async function batchRead(userId, { ids, all, category } = {}, q = defaultDb()) {
  if (all || category) {
    const params = [userId];
    let extra = '';
    if (category && category !== 'all') {
      if (!policy.CATEGORIES.includes(category)) { const e = new Error('category 无效'); e.statusCode = 400; throw e; }
      params.push(category); extra = ` AND category = $2`;
    }
    const { rowCount } = await q.query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = $1 AND NOT is_read AND NOT is_deleted${extra}`, params);
    return { updatedCount: rowCount };
  }
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) { const e = new Error('ids 必须是 1~200 个通知 ID'); e.statusCode = 400; throw e; }
  ids.forEach(assertId);
  const { rowCount } = await q.query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW()
      WHERE user_id = $1 AND id = ANY($2::uuid[]) AND NOT is_read AND NOT is_deleted`, [userId, ids]);
  return { updatedCount: rowCount };
}

async function remove(userId, id, q = defaultDb()) {
  assertId(id);
  const { rowCount } = await q.query(
    `UPDATE notifications SET is_deleted = TRUE, deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND NOT is_deleted`, [id, userId]);
  if (!rowCount) { const e = new Error('通知不存在'); e.statusCode = 404; throw e; }
  await q.query(`INSERT INTO notification_events (notification_id, user_id, event_type, channel) VALUES ($1, $2, 'dismissed', 'in_app')`, [id, userId]);
  return { deleted: true };
}

async function batchDelete(userId, ids, q = defaultDb()) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) { const e = new Error('ids 必须是 1~200 个通知 ID'); e.statusCode = 400; throw e; }
  ids.forEach(assertId);
  const { rowCount } = await q.query(
    `UPDATE notifications SET is_deleted = TRUE, deleted_at = NOW() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND NOT is_deleted`,
    [userId, ids]);
  return { deletedCount: rowCount };
}

async function clearRead(userId, { before } = {}, q = defaultDb()) {
  const params = [userId];
  let extra = '';
  if (before) {
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) { const e = new Error('before 无效'); e.statusCode = 400; throw e; }
    params.push(d); extra = ' AND created_at < $2';
  }
  const { rowCount } = await q.query(
    `UPDATE notifications SET is_deleted = TRUE, deleted_at = NOW() WHERE user_id = $1 AND is_read AND NOT is_deleted${extra}`, params);
  return { deletedCount: rowCount };
}

async function markClicked(userId, id, q = defaultDb()) {
  assertId(id);
  const { rows } = await q.query(
    `UPDATE notifications SET clicked_at = COALESCE(clicked_at, NOW()), is_read = TRUE, read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND user_id = $2 AND NOT is_deleted RETURNING action_url, data`, [id, userId]);
  if (!rows.length) { const e = new Error('通知不存在'); e.statusCode = 404; throw e; }
  await q.query(`INSERT INTO notification_events (notification_id, user_id, event_type, channel) VALUES ($1, $2, 'clicked', 'in_app')`, [id, userId]);
  return { actionUrl: rows[0].action_url, data: rows[0].data };
}

async function getOne(userId, id, lang, q = defaultDb()) {
  assertId(id);
  const { rows } = await q.query(`SELECT * FROM notifications WHERE id = $1 AND user_id = $2 AND ${LIVE}`, [id, userId]);
  if (!rows.length) return null;
  return view(rows[0], await loadTemplates(q), lang);
}

async function userStats(userId, q = defaultDb()) {
  const { rows: [s] } = await q.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT is_read)::int AS unread,
            COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked, MAX(created_at) AS last_notification_at
       FROM notifications WHERE user_id = $1 AND ${LIVE}`, [userId]);
  return s;
}

/** 管理端分析：送达/打开/点击率（按渠道、按类型） */
async function analytics({ days = 7 } = {}, q = defaultDb()) {
  const d = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const { rows: byChannel } = await q.query(
    `SELECT channel, event_type, COUNT(*)::int AS n FROM notification_events
      WHERE occurred_at > NOW() - ($1 || ' days')::interval GROUP BY channel, event_type`, [String(d)]);
  const { rows: byType } = await q.query(
    `SELECT type, COUNT(*)::int AS sent, COUNT(*) FILTER (WHERE is_read)::int AS opened,
            COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
       FROM notifications WHERE created_at > NOW() - ($1 || ' days')::interval GROUP BY type ORDER BY sent DESC LIMIT 50`, [String(d)]);
  const sum = (t, c) => byChannel.filter((r) => r.event_type === t && (!c || r.channel === c)).reduce((a, r) => a + r.n, 0);
  const sent = sum('sent', 'in_app');
  return {
    days: d,
    totals: { sent, deliveredRealtime: sum('delivered', 'ws'), pushed: sum('delivered', 'fcm') + sum('delivered', 'apns'),
      opened: sum('opened'), clicked: sum('clicked'), deferred: sum('deferred'), suppressed: sum('suppressed'), failed: sum('failed') },
    openRate: sent ? +(sum('opened') / sent).toFixed(4) : 0,
    clickRate: sent ? +(sum('clicked') / sent).toFixed(4) : 0,
    byChannel, byType: byType.map((r) => ({ ...r, openRate: r.sent ? +(r.opened / r.sent).toFixed(4) : 0 })),
  };
}

/** 过期清理（默认 30 天过期）：删除过期消息、已软删除超过 7 天的消息、90 天前的投递分析记录 */
async function cleanupExpired(q = defaultDb(), { batch = 5000 } = {}) {
  const a = await q.query(
    `DELETE FROM notifications WHERE id IN (
       SELECT id FROM notifications WHERE expires_at < NOW() OR (is_deleted AND deleted_at < NOW() - INTERVAL '7 days') LIMIT ${batch})`);
  const b = await q.query(
    `DELETE FROM notification_events WHERE id IN (
       SELECT id FROM notification_events WHERE occurred_at < NOW() - INTERVAL '90 days' LIMIT ${batch})`);
  await q.query(`DELETE FROM notification_broadcasts WHERE expires_at < NOW() - INTERVAL '30 days'`);
  return { notifications: a.rowCount, events: b.rowCount };
}

async function recordDelivery(q, { notificationId, userId, eventType, channel, metadata }) {
  await q.query(
    `INSERT INTO notification_events (notification_id, user_id, event_type, channel, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [notificationId || null, userId, eventType, channel, metadata ? JSON.stringify(metadata) : null]);
}

module.exports = {
  notify, list, unreadCount, markRead, batchRead, remove, batchDelete, clearRead, markClicked, getOne, userStats,
  getPreferences, updatePreferences, createBroadcast, materializeBroadcasts, analytics, cleanupExpired, recordDelivery,
  loadTemplates, resetTemplateCache, renderWith, view, UUID_RE,
};
