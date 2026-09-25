/**
 * 站内消息与推送策略（纯函数，无 I/O）——REQ-00099 / REQ-00261 / REQ-00425
 *
 * 分类：system 系统、social 社交、event 活动、reward 奖励、pokemon 精灵、security 安全
 *   system/security 为强制类，玩家不能关闭站内消息（仍可关闭推送）。
 * 偏好：user_push_preferences.notification_types 以分类键（及可选的具体类型键）为开关；
 *   quiet_hours {enabled, start "HH:MM", end "HH:MM"} 按玩家时区判断，可跨午夜；mute_until 临时免打扰。
 * 投递：站内消息总是落库；在线 → WebSocket 实时（免打扰时段标记 silent，不弹提示）；
 *   离线 → 推送（APNs/FCM）需满足：开启推送、有设备令牌、渠道已配置、不在免打扰（urgent 除外）、优先级 ≥ normal、
 *   未超出每小时推送上限；否则记录原因并降级为仅站内。
 */
'use strict';

const CATEGORIES = Object.freeze(['system', 'social', 'event', 'reward', 'pokemon', 'security']);
const MANDATORY = new Set(['system', 'security']);
const PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
const PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

const CATEGORY_LABELS = {
  system: { 'zh-CN': '系统', 'en-US': 'System', 'ja-JP': 'システム', icon: '📢' },
  social: { 'zh-CN': '社交', 'en-US': 'Social', 'ja-JP': 'ソーシャル', icon: '👥' },
  event: { 'zh-CN': '活动', 'en-US': 'Events', 'ja-JP': 'イベント', icon: '🎉' },
  reward: { 'zh-CN': '奖励', 'en-US': 'Rewards', 'ja-JP': '報酬', icon: '🎁' },
  pokemon: { 'zh-CN': '精灵', 'en-US': 'Pokémon', 'ja-JP': 'ポケモン', icon: '🐉' },
  security: { 'zh-CN': '安全', 'en-US': 'Security', 'ja-JP': 'セキュリティ', icon: '🔒' },
};

// 旧偏好键（user_push_preferences 默认值 / REQ-00099 前端）→ 分类
const LEGACY_KEY_CATEGORY = {
  friend_request: 'social', trade_request: 'social', gift_received: 'social', gym_raid: 'event', raid_started: 'event',
  rare_spawn: 'pokemon', quest_complete: 'reward',
};

/** 模板分类（notification_templates.category）/ 类型前缀 → 消息分类 */
function categoryOf(typeOrCategory) {
  const s = String(typeOrCategory || '').toLowerCase();
  const head = s.split('.')[0];
  if (CATEGORIES.includes(head)) return head;
  if (head === 'activity' || head === 'raid' || head === 'events') return 'event';
  if (head === 'friend' || head === 'trade' || head === 'gift') return 'social';
  if (head === 'spawn' || head === 'rare_spawn') return 'pokemon';
  if (LEGACY_KEY_CATEGORY[s]) return LEGACY_KEY_CATEGORY[s];
  return 'system';
}

const DEFAULT_PREFS = Object.freeze({
  inApp: true, push: true, email: false,
  categories: Object.freeze(Object.fromEntries(CATEGORIES.map((c) => [c, true]))),
  types: Object.freeze({}),
  quietHours: Object.freeze({ enabled: false, start: '22:00', end: '08:00' }),
  timezone: 'Asia/Shanghai', muteUntil: null, maxPushPerHour: 6,
  channels: Object.freeze(['websocket', 'fcm', 'apns']),
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** user_push_preferences 行 → 规范化偏好 */
function normalizePreferences(row) {
  if (!row) return { ...DEFAULT_PREFS, categories: { ...DEFAULT_PREFS.categories }, types: {} };
  const nt = (row.notification_types && typeof row.notification_types === 'object') ? row.notification_types : {};
  const categories = { ...DEFAULT_PREFS.categories };
  const types = {};
  for (const [k, v] of Object.entries(nt)) {
    if (typeof v !== 'boolean') continue;
    if (CATEGORIES.includes(k)) categories[k] = v;
    else if (k.includes('.')) types[k] = v;
    else if (LEGACY_KEY_CATEGORY[k]) types[k] = v;
  }
  for (const c of MANDATORY) categories[c] = true;
  const qh = row.quiet_hours && typeof row.quiet_hours === 'object' ? row.quiet_hours : {};
  return {
    inApp: row.enable_in_app !== false,
    push: row.enable_push !== false,
    email: row.enable_email === true,
    categories, types,
    quietHours: {
      enabled: qh.enabled === true,
      start: HHMM.test(qh.start || '') ? qh.start : DEFAULT_PREFS.quietHours.start,
      end: HHMM.test(qh.end || '') ? qh.end : DEFAULT_PREFS.quietHours.end,
    },
    timezone: row.timezone || DEFAULT_PREFS.timezone,
    muteUntil: row.mute_until ? new Date(row.mute_until) : null,
    maxPushPerHour: Number.isInteger(row.max_push_per_hour) ? row.max_push_per_hour : DEFAULT_PREFS.maxPushPerHour,
    channels: Array.isArray(row.preferred_channels) ? row.preferred_channels : [...DEFAULT_PREFS.channels],
    hasFcm: !!row.fcm_token, hasApns: !!row.apns_token,
  };
}

/** 该消息是否应当生成（被关闭的分类/类型不生成；强制类总是生成） */
function isAllowed(prefs, { type, category }) {
  const cat = category || categoryOf(type);
  if (MANDATORY.has(cat)) return true;
  if (prefs.inApp === false) return false;
  if (prefs.categories[cat] === false) return false;
  if (type && prefs.types[type] === false) return false;
  // 兼容旧键：social.friend_request ↔ friend_request
  const short = type && type.includes('.') ? type.split('.').slice(1).join('.') : null;
  if (short && prefs.types[short] === false) return false;
  return true;
}

function minutesOf(hhmm) {
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 某时刻在玩家时区的"分钟数"（0..1439） */
function localMinutes(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

/** 是否处于免打扰（含 mute_until 临时静音；时段可跨午夜，如 22:00-08:00） */
function inQuietHours(prefs, now = new Date()) {
  if (prefs.muteUntil && prefs.muteUntil > now) return true;
  const qh = prefs.quietHours || {};
  if (!qh.enabled) return false;
  const s = minutesOf(qh.start); const e = minutesOf(qh.end);
  if (s == null || e == null || s === e) return false;
  const t = localMinutes(now, prefs.timezone);
  return s < e ? (t >= s && t < e) : (t >= s || t < e);
}

/**
 * 投递计划
 * @param {object} p
 * @param {{priority: string}} p.notification
 * @param {object} p.prefs          normalizePreferences 结果
 * @param {boolean} p.online        玩家是否有在线 WebSocket 连接
 * @param {{fcm: boolean, apns: boolean}} p.providers  推送渠道是否已配置凭据
 * @param {number} p.recentPushCount  最近一小时已推送条数
 * @returns {{inApp: true, ws: boolean, silent: boolean, push: string|null, reasons: string[]}}
 */
function planDelivery({ notification, prefs, online, providers = {}, recentPushCount = 0, now = new Date() }) {
  const pr = PRIORITY_RANK[notification.priority] ?? 1;
  const quiet = inQuietHours(prefs, now) && pr < PRIORITY_RANK.urgent;
  const reasons = [];
  const plan = { inApp: true, ws: false, silent: false, push: null, reasons };
  if (online) {
    plan.ws = true;
    plan.silent = quiet;
    if (quiet) reasons.push('quiet_hours_silent');
    return plan; // 在线玩家不再重复推送
  }
  if (!prefs.push) { reasons.push('push_disabled'); return plan; }
  if (pr < PRIORITY_RANK.normal) { reasons.push('low_priority_in_app_only'); return plan; }
  if (quiet) { reasons.push('quiet_hours'); return plan; }
  if (pr < PRIORITY_RANK.urgent && recentPushCount >= prefs.maxPushPerHour) { reasons.push('rate_limited'); return plan; }
  const channels = prefs.channels || [];
  const candidates = [];
  if (prefs.hasFcm && channels.includes('fcm')) candidates.push('fcm');
  if (prefs.hasApns && channels.includes('apns')) candidates.push('apns');
  if (!candidates.length) { reasons.push('no_device_token'); return plan; }
  const usable = candidates.find((c) => providers[c]);
  if (!usable) { reasons.push('push_provider_unconfigured'); return plan; }
  plan.push = usable;
  return plan;
}

/**
 * 校验并转换偏好更新请求（REQ-00099 PATCH /preferences 与 REQ-00425 渠道/时段/类型）
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function validatePreferencePatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const types = b.notificationTypes || b.categories || b.types;
  if (types !== undefined) {
    if (!types || typeof types !== 'object' || Array.isArray(types)) return { ok: false, error: 'notificationTypes 必须是对象' };
    const clean = {};
    for (const [k, v] of Object.entries(types)) {
      if (typeof v !== 'boolean') return { ok: false, error: `notificationTypes.${k} 必须是布尔值` };
      if (!/^[a-z_]{2,40}(\.[a-z_]{2,40})?$/.test(k)) return { ok: false, error: `未知通知类型 ${k}` };
      clean[k] = MANDATORY.has(k) ? true : v;
    }
    out.notification_types = clean;
  }
  if (b.quietHours !== undefined) {
    const q = b.quietHours;
    if (!q || typeof q !== 'object') return { ok: false, error: 'quietHours 必须是对象' };
    if (q.start !== undefined && !HHMM.test(q.start)) return { ok: false, error: 'quietHours.start 格式应为 HH:MM' };
    if (q.end !== undefined && !HHMM.test(q.end)) return { ok: false, error: 'quietHours.end 格式应为 HH:MM' };
    out.quiet_hours = { enabled: q.enabled === true, start: q.start || '22:00', end: q.end || '08:00' };
  }
  for (const [src, dst] of [['enableInApp', 'enable_in_app'], ['enablePush', 'enable_push'], ['enableEmail', 'enable_email']]) {
    if (b[src] !== undefined) {
      if (typeof b[src] !== 'boolean') return { ok: false, error: `${src} 必须是布尔值` };
      out[dst] = b[src];
    }
  }
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: String(b.timezone) }); } catch { return { ok: false, error: 'timezone 无效' }; }
    out.timezone = String(b.timezone);
  }
  if (b.muteForMinutes !== undefined) {
    const m = Number(b.muteForMinutes);
    if (!Number.isInteger(m) || m < 0 || m > 7 * 24 * 60) return { ok: false, error: 'muteForMinutes 应为 0~10080 的整数' };
    out.mute_until = m === 0 ? null : new Date(Date.now() + m * 60000);
  }
  if (b.maxPushPerHour !== undefined) {
    const n = Number(b.maxPushPerHour);
    if (!Number.isInteger(n) || n < 0 || n > 60) return { ok: false, error: 'maxPushPerHour 应为 0~60 的整数' };
    out.max_push_per_hour = n;
  }
  if (b.channels !== undefined) {
    if (!Array.isArray(b.channels) || b.channels.some((c) => !['websocket', 'fcm', 'apns', 'email'].includes(c))) {
      return { ok: false, error: 'channels 只能包含 websocket/fcm/apns/email' };
    }
    out.preferred_channels = [...new Set(b.channels)];
  }
  if (!Object.keys(out).length) return { ok: false, error: '没有可更新的偏好' };
  return { ok: true, value: out };
}

/** 偏好 → 对外响应 */
function preferencesView(prefs) {
  return {
    enableInApp: prefs.inApp, enablePush: prefs.push, enableEmail: prefs.email,
    notificationTypes: { ...prefs.categories, ...prefs.types },
    mandatoryCategories: [...MANDATORY],
    quietHours: { ...prefs.quietHours }, timezone: prefs.timezone,
    muteUntil: prefs.muteUntil ? prefs.muteUntil.toISOString() : null,
    maxPushPerHour: prefs.maxPushPerHour, channels: prefs.channels,
    devices: { fcm: !!prefs.hasFcm, apns: !!prefs.hasApns },
  };
}

// ── 模板 ──────────────────────────────────────────────────────
/** 模板变量替换；变量值去掉尖括号，防止通知注入 HTML（前端也按纯文本渲染） */
function renderTemplate(tpl, params) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = params && params[k];
    return v === undefined || v === null ? '' : sanitizeText(String(v));
  });
}

function sanitizeText(s, max = 500) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[<>]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
}

module.exports = {
  CATEGORIES, MANDATORY, PRIORITIES, PRIORITY_RANK, CATEGORY_LABELS, DEFAULT_PREFS,
  categoryOf, normalizePreferences, isAllowed, inQuietHours, localMinutes, planDelivery,
  validatePreferencePatch, preferencesView, renderTemplate, sanitizeText,
};
