// frontend/game-client/src/accessibility/prefs.js
// Epic E21 无障碍偏好：默认值、规范化（sanitize）、本地持久化（localStorage）与云端同步（/v1/users/me/preferences/a11y）。
// 纯逻辑部分（DEFAULT_PREFS / sanitizePrefs / mergePrefs / getPath / setPath）不依赖 DOM，可在 Node 单测中直接 import。

export const STORAGE_KEY = 'pmg_a11y_prefs_v1';
export const NAMESPACE = 'a11y';
export const PACE_VALUES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export const DEFAULT_PREFS = Object.freeze({
  version: 1,
  // REQ-00108 光敏安全
  photosensitive: { enabled: false, maxFlashHz: 3, reduceMotion: false, tested: false, sensitivity: 'unknown', promptOnRisk: true },
  // REQ-00162 / 00426 / 00503 屏幕阅读器与语音导航
  screenReader: { speech: false, rate: 1, pitch: 1, volume: 1, verbosity: 'full', spatialAudio: false, autoMapSummary: true, readFocus: false },
  // REQ-00180 键盘
  keyboard: { enabled: true, bindings: {} },
  // REQ-00198 / 00263 节奏
  pace: { catch: 1, battle: 1, ui: 1, preset: 'standard' },
  // REQ-00233 手柄
  gamepad: { enabled: true, vibration: true, mapping: {} },
  // REQ-00244 / 00413 文字方向
  direction: { mode: 'auto' },
  // REQ-00281 / 00474 / 00566 色觉与对比
  color: { mode: 'none', filter: false, filterStrength: 1, shapes: false, contrast: 'normal', highContrast: false, palette: {}, simulate: 'none' },
  display: { fontScale: 1, uiScale: 1 },
  // REQ-00286 认知
  cognitive: { simplified: false, dyslexiaFont: false, lineHeight: 1.5, letterSpacing: 0, focusMode: false, readAloud: false, hints: false, changeWarnings: false, breakReminderMin: 0, memory: false },
  // REQ-00316 / 00435 触觉
  haptics: { enabled: true, intensity: 100, enhanced: false, scenes: { catch: true, battle: true, ui: true, navigation: true, special: true } },
  // REQ-00360 / 00414 动作障碍辅助（默认只存本地，cloudSync=true 才上传）
  motor: {
    enabled: false, preset: 'none', aimAssist: 'off', windowMultiplier: 1, oneTapThrow: false, trajectory: false,
    holdMs: 0, confirmMode: 'none', tremorFilter: 'off', targetSnap: false, oneHanded: 'off', largeTargets: false,
    fatigueThrows: 0, audioCue: false, cloudSync: false,
  },
  // REQ-00352 / 00382 听障视觉提示
  hearing: {
    visualCues: false, position: 'top-right', durationMs: 3000, flash: true, intensity: 'medium',
    categories: { spawn: true, catch: true, battle: true, ui: true, social: true, warning: true },
  },
  // REQ-00611 字幕
  subtitles: { enabled: false, size: 'medium', color: '#ffffff', background: 'rgba(0,0,0,0.8)', position: 'bottom', soundCaptions: true },
  // REQ-00536 语音控制
  voiceControl: { enabled: false, lang: 'auto', minConfidence: 0.5, feedback: true, customCommands: [] },
});

// 取值约束：enum 列表或 [min, max]
const ENUMS = {
  'photosensitive.sensitivity': ['unknown', 'low', 'medium', 'high'],
  'screenReader.verbosity': ['full', 'minimal', 'critical'],
  'pace.preset': ['accessible', 'easy', 'standard', 'veteran', 'custom'],
  'direction.mode': ['auto', 'ltr', 'rtl'],
  'color.mode': ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'custom'],
  'color.contrast': ['normal', 'enhanced', 'high', 'max'],
  'color.simulate': ['none', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'],
  'motor.preset': ['none', 'light', 'medium', 'heavy', 'one-handed', 'tremor', 'slow', 'limited-range', 'custom'],
  'motor.aimAssist': ['off', 'low', 'medium', 'high'],
  'motor.confirmMode': ['none', 'double', 'hold'],
  'motor.tremorFilter': ['off', 'low', 'medium', 'high'],
  'motor.oneHanded': ['off', 'left', 'right'],
  'hearing.position': ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'],
  'hearing.intensity': ['low', 'medium', 'high'],
  'subtitles.size': ['small', 'medium', 'large', 'xlarge'],
  'subtitles.position': ['top', 'bottom'],
  'voiceControl.lang': ['auto', 'zh-CN', 'en-US', 'ja-JP'],
};
const RANGES = {
  'photosensitive.maxFlashHz': [1, 3],
  'screenReader.rate': [0.5, 2],
  'screenReader.pitch': [0.5, 2],
  'screenReader.volume': [0, 1],
  'color.filterStrength': [0, 1],
  'display.fontScale': [0.8, 2],
  'display.uiScale': [0.8, 1.6],
  'cognitive.lineHeight': [1.2, 2.5],
  'cognitive.letterSpacing': [0, 0.3],
  'cognitive.breakReminderMin': [0, 120],
  'haptics.intensity': [0, 200],
  'motor.windowMultiplier': [1, 3],
  'motor.fatigueThrows': [0, 200],
  'hearing.durationMs': [2000, 10000],
  'voiceControl.minConfidence': [0, 1],
};
const PACE_KEYS = ['pace.catch', 'pace.battle', 'pace.ui'];
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/;

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
  return obj;
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function coerce(path, def, value) {
  if (value === undefined) return def;
  if (typeof def === 'boolean') return typeof value === 'boolean' ? value : def;
  if (typeof def === 'number') {
    let n = Number(value);
    if (!Number.isFinite(n)) return def;
    if (PACE_KEYS.includes(path)) {
      // 取最接近的合法倍率
      return PACE_VALUES.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), 1);
    }
    const r = RANGES[path];
    if (r) n = Math.min(r[1], Math.max(r[0], n));
    if (path === 'motor.holdMs') return n <= 0 ? 0 : Math.min(3000, Math.max(100, Math.round(n)));
    return n;
  }
  if (typeof def === 'string') {
    if (typeof value !== 'string') return def;
    const e = ENUMS[path];
    if (e) return e.includes(value) ? value : def;
    if (path.startsWith('subtitles.color') || path.startsWith('subtitles.background')) return COLOR_RE.test(value) ? value : def;
    return value.slice(0, 64);
  }
  return def;
}

function sanitizeNode(path, def, value) {
  if (isObj(def)) {
    const out = {};
    const src = isObj(value) ? value : {};
    // 自由字典（用户自定义映射/调色板）：保留合法键值
    if (path === 'keyboard.bindings') {
      for (const [k, v] of Object.entries(src)) if (/^[a-zA-Z][\w.-]{0,40}$/.test(k) && typeof v === 'string' && v.length <= 40) out[k] = v;
      return out;
    }
    if (path === 'gamepad.mapping') {
      for (const [k, v] of Object.entries(src)) if (/^[a-zA-Z][\w-]{0,40}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 32) out[k] = v;
      return out;
    }
    if (path === 'color.palette') {
      for (const [k, v] of Object.entries(src)) if (/^[a-z][a-z0-9-]{0,20}$/.test(k) && typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) out[k] = v.toLowerCase();
      return out;
    }
    for (const key of Object.keys(def)) out[key] = sanitizeNode(path ? `${path}.${key}` : key, def[key], src[key]);
    return out;
  }
  if (Array.isArray(def)) {
    if (path === 'voiceControl.customCommands') {
      const list = Array.isArray(value) ? value : [];
      return list
        .filter((c) => isObj(c) && typeof c.phrase === 'string' && typeof c.action === 'string' && c.phrase.trim())
        .slice(0, 30)
        .map((c) => ({ phrase: c.phrase.trim().slice(0, 40), action: c.action.slice(0, 40) }));
    }
    return Array.isArray(value) ? value.slice(0, 50) : clone(def);
  }
  return coerce(path, def, value);
}

/** 把任意输入规范化为完整、合法的偏好对象（未知字段丢弃，越界值夹取，非法枚举回退默认） */
export function sanitizePrefs(input) {
  return sanitizeNode('', DEFAULT_PREFS, input);
}

/** 深合并 patch 后再规范化 */
export function mergePrefs(base, patch) {
  const out = clone(base || DEFAULT_PREFS);
  const walk = (dst, src) => {
    for (const [k, v] of Object.entries(src || {})) {
      if (isObj(v) && isObj(dst[k]) && !['palette', 'bindings', 'mapping'].includes(k)) walk(dst[k], v);
      else dst[k] = clone(v);
    }
  };
  walk(out, patch);
  return sanitizePrefs(out);
}

/** 上传云端前剔除仅本地的数据（REQ-00360：动作辅助设置默认不上传服务器） */
export function toCloudDoc(prefs) {
  const doc = clone(prefs);
  if (!prefs.motor.cloudSync) delete doc.motor;
  return doc;
}

/** 列出与默认值不同的叶子路径（用于状态徽章/调试） */
export function diffFromDefaults(prefs, base = DEFAULT_PREFS, prefix = '') {
  const out = [];
  for (const k of Object.keys(base)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(base[k]) && !['palette', 'bindings', 'mapping'].includes(k)) out.push(...diffFromDefaults(prefs[k] || {}, base[k], p));
    else if (JSON.stringify(prefs[k]) !== JSON.stringify(base[k])) out.push(p);
  }
  return out;
}

// ───────────────────────── 运行期存储（浏览器） ─────────────────────────

export class A11yPrefsStore extends EventTarget {
  constructor({ api = null, storage = (typeof localStorage !== 'undefined' ? localStorage : null) } = {}) {
    super();
    this.api = api;
    this.storage = storage;
    this.updatedAt = 0;
    this.syncState = { lastPull: null, lastPush: null, error: null, pending: false };
    this.prefs = this._loadLocal();
    this._pushTimer = null;
  }

  _loadLocal() {
    try {
      const raw = this.storage && this.storage.getItem(STORAGE_KEY);
      if (raw) {
        const doc = JSON.parse(raw);
        this.updatedAt = Number(doc.updatedAt) || 0;
        return sanitizePrefs(doc.prefs);
      }
    } catch { /* 损坏的本地数据回退默认 */ }
    return sanitizePrefs({});
  }

  _saveLocal() {
    try {
      this.storage && this.storage.setItem(STORAGE_KEY, JSON.stringify({ updatedAt: this.updatedAt, prefs: this.prefs }));
    } catch { /* 隐私模式等写入失败时忽略 */ }
  }

  get(path) { return path ? getPath(this.prefs, path) : this.prefs; }

  /** 更新一个或多个路径：set('color.mode', 'protanopia') 或 set({ color: { mode: 'protanopia' } }) */
  set(pathOrPatch, value, { source = 'user', sync = true } = {}) {
    const patch = typeof pathOrPatch === 'string' ? setPath({}, pathOrPatch, value) : pathOrPatch;
    const prev = this.prefs;
    this.prefs = mergePrefs(prev, patch);
    this.updatedAt = Date.now();
    this._saveLocal();
    this.dispatchEvent(new CustomEvent('change', { detail: { prefs: this.prefs, prev, patch, source } }));
    if (sync) this.schedulePush();
    return this.prefs;
  }

  reset() {
    const prev = this.prefs;
    this.prefs = sanitizePrefs({});
    this.updatedAt = Date.now();
    this._saveLocal();
    this.dispatchEvent(new CustomEvent('change', { detail: { prefs: this.prefs, prev, patch: null, source: 'reset' } }));
    this.schedulePush();
  }

  _hasToken() {
    try { return !!(this.storage && this.storage.getItem('pmg_access_token')); } catch { return false; }
  }

  schedulePush(delay = 600) {
    if (!this.api || !this._hasToken()) return;
    clearTimeout(this._pushTimer);
    this.syncState.pending = true;
    this._pushTimer = setTimeout(() => { this.push().catch(() => {}); }, delay);
  }

  async push() {
    if (!this.api || !this._hasToken()) return null;
    clearTimeout(this._pushTimer);
    try {
      const doc = toCloudDoc(this.prefs);
      if (typeof this.deviceInfo === 'function') { try { doc.device = this.deviceInfo(); } catch { /* ignore */ } }
      const res = await this.api.request('PUT', `/users/me/preferences/${NAMESPACE}`, {
        prefs: doc,
        clientUpdatedAt: new Date(this.updatedAt || Date.now()).toISOString(),
      });
      this.syncState = { ...this.syncState, lastPush: Date.now(), error: null, pending: false, version: res && res.version };
      this.dispatchEvent(new CustomEvent('synced', { detail: { direction: 'push', res } }));
      return res;
    } catch (err) {
      this.syncState = { ...this.syncState, error: String(err && err.message || err), pending: false };
      return null;
    }
  }

  /** 拉取云端：云端较新则覆盖本地（本地仅有的 motor 设置保留），本地较新则回推 */
  async pull() {
    if (!this.api || !this._hasToken()) return null;
    try {
      const res = await this.api.request('GET', `/users/me/preferences/${NAMESPACE}`);
      this.syncState = { ...this.syncState, lastPull: Date.now(), error: null };
      const remoteAt = res && res.clientUpdatedAt ? Date.parse(res.clientUpdatedAt) : 0;
      if (res && res.prefs && remoteAt > this.updatedAt) {
        const localMotor = this.prefs.motor;
        const next = sanitizePrefs(res.prefs);
        if (!res.prefs.motor) next.motor = localMotor;
        const prev = this.prefs;
        this.prefs = next;
        this.updatedAt = remoteAt;
        this._saveLocal();
        this.dispatchEvent(new CustomEvent('change', { detail: { prefs: this.prefs, prev, patch: null, source: 'cloud' } }));
      } else if (this.updatedAt > remoteAt) {
        await this.push();
      }
      this.dispatchEvent(new CustomEvent('synced', { detail: { direction: 'pull', res } }));
      return res;
    } catch (err) {
      this.syncState = { ...this.syncState, error: String(err && err.message || err) };
      return null;
    }
  }
}
