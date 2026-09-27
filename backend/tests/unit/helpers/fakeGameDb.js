'use strict';

/**
 * 成就引擎 / 消息中心单测用的内存数据库替身：按 SQL 特征分派，模拟真实 SQL 的关键语义
 * （user_achievements upsert 的"已完成不再更新"、notifications 去重键、称号唯一、事件 SKIP LOCKED 等）。
 * 同时把 shared/logger、shared/redis 替换为无依赖桩，使业务模块在没有 node_modules 的宿主机上也能 require。
 */
const path = require('path');

const SHARED = path.resolve(__dirname, '..', '..', '..', 'shared');

function stubSharedModules() {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child() { return logger; } };
  const set = (name, exports) => {
    const file = require.resolve(path.join(SHARED, name));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  set('logger', { createLogger: () => logger, requestLogger: () => (req, res, next) => next() });
  set('redis', { getRedis() { throw new Error('redis disabled in unit test'); } });
}

class FakeGameDb {
  constructor({ achievements = [], titles = [], templates = [], prefs = {}, absolute = {} } = {}) {
    this.achievements = achievements;
    this.titleDefs = titles;
    this.templates = templates;
    this.prefs = prefs;            // userId -> user_push_preferences 行
    this.absolute = absolute;      // metric -> value（pokedex 种类数等）
    this.events = [];              // {id, user_id, event_type, event_data, processed, attempts, dedupe_key}
    this.userAch = new Map();      // `${user}:${ach}` -> {progress, target, completed}
    this.userTitles = [];          // {user_id, title_id, source_type, source_id}
    this.notifications = [];       // {id, user_id, type, category, priority, title, body, dedupe_key, is_read, is_deleted, ...}
    this.notificationEvents = [];
    this.snapshots = 0;
    this.decorations = [];
    this.seq = 1;
    this.log = [];
  }

  addEvent(userId, type, data, dedupe = null) {
    if (dedupe && this.events.some((e) => e.dedupe_key === dedupe)) return;
    this.events.push({ id: this.seq++, user_id: userId, event_type: type, event_data: data, processed: false, attempts: 0,
      dedupe_key: dedupe, created_at: new Date() });
  }

  async transaction(fn) { return fn(this); }

  // eslint-disable-next-line complexity
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    this.log.push(s.slice(0, 80));
    const res = (rows) => ({ rows, rowCount: rows.length });

    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(s)) return res([]);
    if (/FROM achievements WHERE is_active/.test(s)) return res(this.achievements.map((a) => ({ ...a })));
    if (/FROM achievement_events WHERE user_id = \$1 AND NOT processed/.test(s)) {
      return res(this.events.filter((e) => e.user_id === params[0] && !e.processed).slice(0, params[1]).map((e) => ({ ...e })));
    }
    if (/^SELECT id, nickname FROM users/.test(s)) return res(params[0].map((id) => ({ id, nickname: `nick-${id}` })));
    if (/^INSERT INTO user_achievements AS ua/.test(s)) {
      const [user, ach, value, target, isInc] = params;
      const key = `${user}:${ach}`;
      const cur = this.userAch.get(key);
      if (cur && cur.completed) return res([]);
      const base = cur ? cur.progress : 0;
      const raw = cur ? (isInc ? base + value : Math.max(base, value)) : value;
      const row = { progress: Math.min(raw, target), target, completed: raw >= target };
      this.userAch.set(key, row);
      return res([{ completed: row.completed }]);
    }
    if (/^SELECT completed FROM user_achievements/.test(s)) {
      const r = this.userAch.get(`${params[0]}:${params[1]}`);
      return res(r ? [{ completed: r.completed }] : []);
    }
    if (/^INSERT INTO user_titles/.test(s)) {
      const [user, sourceType, sourceId, ...extra] = params;
      const matched = this.titleDefs.filter((t) => {
        if (sourceType === 'achievement') {
          return t.title_id === extra[0] || (t.unlock_type === 'achievement' && t.unlock_criteria.achievement_id === sourceId);
        }
        return t.unlock_type === 'event' && t.unlock_criteria.event_id === sourceId;
      });
      const inserted = [];
      for (const t of matched) {
        if (this.userTitles.some((u) => u.user_id === user && u.title_id === t.title_id)) continue;
        this.userTitles.push({ user_id: user, title_id: t.title_id, source_type: sourceType, source_id: sourceId });
        inserted.push({ title_id: t.title_id });
      }
      return res(inserted);
    }
    if (/^SELECT title_id, name, rarity FROM title_definitions WHERE title_id = ANY/.test(s)) {
      return res(this.titleDefs.filter((t) => params[0].includes(t.title_id)));
    }
    if (/FROM notification_templates t JOIN notification_template_contents/.test(s)) return res(this.templates);
    if (/^SELECT \* FROM user_push_preferences WHERE user_id/.test(s)) return res(this.prefs[params[0]] ? [this.prefs[params[0]]] : []);
    if (/^INSERT INTO notifications .*VALUES/.test(s)) {
      const [user, type, category, priority, title, body, templateKey, paramsJson, dataJson, icon, actionUrl, dedupe] = params;
      if (dedupe && this.notifications.some((n) => n.user_id === user && n.dedupe_key === dedupe)) return res([]);
      const n = { id: `00000000-0000-4000-8000-${String(this.seq++).padStart(12, '0')}`, user_id: user, type, category, priority, title, body,
        template_key: templateKey, params: JSON.parse(paramsJson), data: JSON.parse(dataJson), icon, action_url: actionUrl,
        dedupe_key: dedupe, is_read: false, is_deleted: false, created_at: new Date() };
      this.notifications.push(n);
      return res([{ id: n.id }]);
    }
    if (/^INSERT INTO notification_events/.test(s)) { this.notificationEvents.push(params); return res([]); }
    if (/^UPDATE achievement_events SET processed = TRUE/.test(s)) {
      for (const e of this.events) if (params[0].includes(e.id)) { e.processed = true; e.attempts++; }
      return res([]);
    }
    if (/^UPDATE achievement_events SET attempts = attempts \+ 1, last_error/.test(s)) {
      const e = this.events.find((x) => x.id === params[0]);
      e.attempts++; e.last_error = params[1]; if (e.attempts >= params[2]) e.processed = true;
      return res([]);
    }
    if (/achievement_refresh_snapshot/.test(s)) { this.snapshots++; return res([]); }
    if (/^SELECT game_event_emit\(\$1, \$2/.test(s)) { this.addEvent(params[0], params[1], JSON.parse(params[2]), params[3] || null); return res([]); }
    if (/^SELECT game_event_emit/.test(s)) { this.addEvent(params[0], 'achievement_unlocked', JSON.parse(params[1]), params[2] || null); return res([]); }
    if (/FROM pokedex_entries WHERE user_id = \$1 AND caught_count > 0/.test(s)) return res([{ v: this.absolute.catch_species || 0 }]);
    if (/FROM user_achievements WHERE user_id = \$1 AND completed$/.test(s) && /COUNT/.test(s)) {
      const n = [...this.userAch.entries()].filter(([k, v]) => k.startsWith(`${params[0]}:`) && v.completed).length;
      return res([{ v: n }]);
    }
    if (/FROM decoration_items WHERE item_code/.test(s)) {
      const d = this.decorations.find((x) => x.item_code === params[0]);
      return res(d ? [d] : []);
    }
    if (/^INSERT INTO user_decorations/.test(s)) return res([]);
    if (/^SELECT rewards FROM events/.test(s)) return res([]);
    if (/FROM users u WHERE u.id = \$1/.test(s)) return res([]); // profileStats：测试中不聚合
    return res([]);
  }
}

module.exports = { FakeGameDb, stubSharedModules };
