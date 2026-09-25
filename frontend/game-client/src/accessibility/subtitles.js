// frontend/game-client/src/accessibility/subtitles.js
// REQ-00611：实时字幕 —— 所有语音播报（TTS）与关键音效都以字幕呈现
//   自动分段（按标点，每段 ≤ maxChars）、显示时长按字数与节奏倍率计算、样式可配置（字号/颜色/背景/位置）
//   支持中/英/日/韩音效字幕（strings.js 的 cap_* 文案）

/** 按标点把长文本切成不超过 maxChars 的段 */
export function segmentText(text, maxChars = 36) {
  const s = String(text || '').trim();
  if (!s) return [];
  const parts = s.split(/(?<=[。！？!?；;，,、.])\s*/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length <= maxChars) { cur += p; continue; }
    if (cur) out.push(cur);
    if (p.length <= maxChars) { cur = p; continue; }
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
    cur = '';
  }
  if (cur) out.push(cur);
  return out;
}

/** 显示时长：约 4 字/秒（英文按词），1.5s–7s，再乘以节奏倍数 */
export function displayDurationMs(text, holdScale = 1) {
  const s = String(text || '');
  const cjk = (s.match(/[぀-ヿ一-鿿가-힯]/g) || []).length;
  const words = s.replace(/[぀-ヿ一-鿿가-힯]/g, ' ').split(/\s+/).filter(Boolean).length;
  const ms = cjk * 250 + words * 380 + 600;
  return Math.round(Math.min(7000, Math.max(1500, ms)) * Math.max(0.5, holdScale));
}

export class SubtitleManager {
  constructor({ getPrefs, holdScale = () => 1 } = {}) {
    this.getPrefs = getPrefs;
    this.holdScale = holdScale;
    this.log = [];
    this._el = null;
    this._queue = [];
    this._busy = false;
  }

  mount() {
    if (this._el) return;
    this._el = document.createElement('div');
    this._el.id = 'a11y-subtitles';
    this._el.className = 'a11y-subtitles a11y-keep-visible';
    // 字幕是语音的可视化副本：屏幕阅读器已通过 live region 获得同一内容，这里不再重复播报
    this._el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this._el);
  }

  applyStyle() {
    if (!this._el) return;
    const s = this.getPrefs().subtitles;
    this._el.dataset.size = s.size;
    this._el.dataset.position = s.position;
    this._el.dataset.font = s.font;
    this._el.style.setProperty('--a11y-sub-color', s.color);
    this._el.style.setProperty('--a11y-sub-bg', s.background);
  }

  /** 显示一条字幕（speaker 可选，如 "[音效]"） */
  show(text, { kind = 'speech', eventAt = performance.now() } = {}) {
    const s = this.getPrefs().subtitles;
    if (!s.enabled || !text) return false;
    if (kind === 'caption' && !s.soundCaptions) return false;
    this.mount();
    this.applyStyle();
    for (const seg of segmentText(text)) this._queue.push({ seg, kind, eventAt });
    if (!this._busy) this._next();
    return true;
  }

  _next() {
    const item = this._queue.shift();
    if (!item) { this._busy = false; return; }
    this._busy = true;
    const line = document.createElement('div');
    line.className = `a11y-subtitle-line a11y-subtitle-${item.kind}`;
    line.setAttribute('dir', 'auto');
    line.textContent = item.seg;
    this._el.replaceChildren(line);
    const latency = Number((performance.now() - item.eventAt).toFixed(2));
    const dur = displayDurationMs(item.seg, this.holdScale());
    this.log.push({ text: item.seg, kind: item.kind, latencyMs: latency, durationMs: dur, t: Date.now() });
    if (this.log.length > 100) this.log.shift();
    // 队列较长时缩短单条显示，避免积压
    const wait = this._queue.length > 3 ? Math.min(dur, 1500) : dur;
    setTimeout(() => { if (line.parentNode) line.remove(); this._next(); }, wait);
  }
}
