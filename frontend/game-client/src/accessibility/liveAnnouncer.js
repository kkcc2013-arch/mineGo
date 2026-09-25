// frontend/game-client/src/accessibility/liveAnnouncer.js
// REQ-00162 / REQ-00426 / REQ-00503：aria-live 播报 + Web Speech 语音合成 + WebAudio 空间提示音
// 播报级别：full（全部）/ minimal（important 及以上）/ critical（仅 critical）
import { resolveLang } from './strings.js';

const LEVEL_RANK = { info: 0, important: 1, critical: 2 };
const VERBOSITY_MIN = { full: 0, minimal: 1, critical: 2 };

/** 纯函数：该级别的消息在当前播报级别下是否应播报 */
export function shouldAnnounce(level, verbosity) {
  return (LEVEL_RANK[level] ?? 0) >= (VERBOSITY_MIN[verbosity] ?? 0);
}

export class LiveAnnouncer {
  constructor({ getPrefs, onSpeak } = {}) {
    this.getPrefs = getPrefs || (() => ({}));
    this.onSpeak = onSpeak || null;
    this.history = [];
    this.spoken = [];
    this._regions = null;
    this._audio = null;
    this.toneLog = [];
    this.speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  }

  mount() {
    if (this._regions) return;
    const mk = (id, politeness, role) => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = 'a11y-sr-only';
        el.setAttribute('aria-live', politeness);
        el.setAttribute('aria-atomic', 'true');
        el.setAttribute('role', role);
        document.body.appendChild(el);
      }
      return el;
    };
    this._regions = {
      polite: mk('a11y-live-polite', 'polite', 'status'),
      assertive: mk('a11y-live-assertive', 'assertive', 'alert'),
    };
  }

  /**
   * @param {string} message
   * @param {{level?: 'info'|'important'|'critical', priority?: 'polite'|'assertive', speak?: boolean, lang?: string, category?: string}} opts
   */
  announce(message, opts = {}) {
    if (!message) return false;
    const prefs = this.getPrefs();
    const sr = prefs.screenReader || {};
    const level = opts.level || 'info';
    const catOff = opts.category && level !== 'critical' && sr.categories && sr.categories[opts.category] === false;
    if (catOff || !shouldAnnounce(level, sr.verbosity || 'full')) {
      this.history.push({ message, level, skipped: true, t: Date.now() });
      return false;
    }
    this.mount();
    const priority = opts.priority || (level === 'critical' ? 'assertive' : 'polite');
    const region = this._regions[priority];
    // 先清空再写入，保证相同文本也会被重复播报
    region.textContent = '';
    setTimeout(() => { region.textContent = message; }, 30);
    this.history.push({ message, level, priority, category: opts.category || null, t: Date.now() });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    if (opts.speak !== false && sr.speech) this.speak(message, { lang: opts.lang, interrupt: level === 'critical' });
    return true;
  }

  /** Web Speech API 语音合成（⚠️ 发音效果依赖系统语音包，真机未验证） */
  speak(text, { lang, interrupt = false } = {}) {
    const prefs = this.getPrefs();
    const sr = prefs.screenReader || {};
    const L = resolveLang(lang || (typeof document !== 'undefined' && document.documentElement.lang) || 'zh-CN');
    const entry = { text, lang: L, rate: sr.rate ?? 1, pitch: sr.pitch ?? 1, volume: sr.volume ?? 1, t: performance.now() };
    this.spoken.push(entry);
    if (this.spoken.length > 100) this.spoken.shift();
    if (this.onSpeak) { try { this.onSpeak(entry); } catch { /* 字幕等回调失败不影响播报 */ } }
    if (!this.speechSupported) return false;
    try {
      if (interrupt) window.speechSynthesis.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      u.lang = L; u.rate = entry.rate; u.pitch = entry.pitch; u.volume = entry.volume;
      window.speechSynthesis.speak(u);
      return true;
    } catch { return false; }
  }

  stopSpeech() {
    if (this.speechSupported) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
  }

  _ctx() {
    if (this._audio) return this._audio;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try { this._audio = new AC(); } catch { this._audio = null; }
    return this._audio;
  }

  /** 提示音：freq 赫兹，pan -1(左)…1(右)，ms 时长（空间音频 / 距离音调 / 捕捉结果音效） */
  tone(freq, { pan = 0, ms = 160, type = 'sine', gain = 0.12 } = {}) {
    this.toneLog.push({ freq, pan, ms, type, t: Date.now() });
    if (this.toneLog.length > 100) this.toneLog.shift();
    const ctx = this._ctx();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gain;
      let node = osc.connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        node = node.connect(p);
      }
      node.connect(ctx.destination);
      const now = ctx.currentTime;
      g.gain.setValueAtTime(gain, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);
      osc.start(now);
      osc.stop(now + ms / 1000 + 0.02);
      return true;
    } catch { return false; }
  }

  /** 预设音效 */
  earcon(name, opts = {}) {
    const seq = {
      success: [[660, 90], [880, 140]],
      fail: [[440, 120], [330, 200]],
      escape: [[520, 80], [520, 80]],
      spawn: [[740, 90]],
      warning: [[300, 220]],
      tick: [[1000, 30]],
    }[name] || [[600, 100]];
    let delay = 0;
    for (const [f, ms] of seq) {
      setTimeout(() => this.tone(f, { ...opts, ms }), delay);
      delay += ms + 30;
    }
  }
}
