// frontend/game-client/src/accessibility/soundCues.js
// REQ-00352 / REQ-00382 / REQ-00611：音效可视化（听障视觉提示）
//   每个"有声事件"映射为：分类、优先级（P0 关键 / P1 重要 / P2 氛围）、图标、文字标签、字幕描述、震动模式、提示音。
//   P0 事件至少 2 种视觉提示：边框高亮/闪烁（光敏或减少动画时改为静态高亮）+ 图标文字标签（≥2s，位置可配）+ 震动。
import { t } from './strings.js';

export const CUE_DEFS = {
  'pokemon:spawn':  { category: 'spawn',   priority: 'P0', icon: '🐾', label: 'cue_spawn',         caption: 'cap_spawn',         haptic: 'pokemon_spawn_nearby', earcon: 'spawn' },
  'catch:success':  { category: 'catch',   priority: 'P0', icon: '🎉', label: 'cue_catch_success', caption: 'cap_catch_success', haptic: 'catch_success', earcon: 'success' },
  'catch:fled':     { category: 'catch',   priority: 'P0', icon: '💨', label: 'cue_catch_fail',    caption: 'cap_catch_fail',    haptic: 'catch_fled', earcon: 'fail' },
  'catch:escape':   { category: 'catch',   priority: 'P1', icon: '⚠️', label: 'cue_catch_escape',  caption: 'cap_catch_escape',  haptic: 'catch_escape', earcon: 'escape' },
  'catch:throw':    { category: 'catch',   priority: 'P2', icon: '⚾', label: 'cue_throw',         caption: 'cap_throw',         haptic: null, earcon: 'tick' },
  'battle:start':   { category: 'battle',  priority: 'P0', icon: '⚔️', label: 'cue_battle',        caption: 'cap_battle',        haptic: 'battle_start', earcon: 'warning' },
  'battle:action':  { category: 'battle',  priority: 'P2', icon: '⚔️', label: 'cue_battle_action', caption: 'cap_battle_action', haptic: 'battle_attack', earcon: 'tick' },
  'battle:hit':     { category: 'battle',  priority: 'P1', icon: '💥', label: 'cue_battle_hit',    caption: 'cap_battle_hit',    haptic: 'battle_hit', earcon: 'escape' },
  'battle:faint':   { category: 'battle',  priority: 'P0', icon: '💫', label: 'cue_battle_faint',  caption: 'cap_battle_faint',  haptic: 'battle_lose', earcon: 'fail' },
  'battle:win':     { category: 'battle',  priority: 'P0', icon: '🏆', label: 'cue_battle_win',    caption: 'cap_battle_win',    haptic: 'battle_win', earcon: 'success' },
  'battle:lose':    { category: 'battle',  priority: 'P0', icon: '🏳️', label: 'cue_battle_lose',   caption: 'cap_battle_lose',   haptic: 'battle_lose', earcon: 'fail' },
  'item:pickup':    { category: 'ui',      priority: 'P1', icon: '🎁', label: 'cue_item',          caption: 'cap_item',          haptic: 'item_pickup', earcon: 'success' },
  'warning':        { category: 'warning', priority: 'P0', icon: '⛔', label: 'cue_warning',       caption: 'cap_warning',       haptic: 'error', earcon: 'warning' },
  'notice':         { category: 'ui',      priority: 'P2', icon: '🔔', label: 'cue_ui',            caption: 'cap_ui',            haptic: 'tap', earcon: 'tick' },
  'social:message': { category: 'social',  priority: 'P1', icon: '💬', label: 'cue_social',        caption: 'cap_social',        haptic: 'friend_request', earcon: 'spawn' },
};

export const PRIORITY_COLORS = { P0: '#ff4d4f', P1: '#ffb020', P2: '#4da3ff' };

/** 纯函数：根据配置决定某事件要呈现哪些视觉通道 */
export function planCue(type, hearing, { reduceMotion = false, photosafe = false } = {}) {
  const def = CUE_DEFS[type];
  if (!def || !hearing.visualCues) return null;
  if (hearing.categories && hearing.categories[def.category] === false) return null;
  const channels = ['badge'];
  if (def.priority !== 'P2') channels.push(hearing.flash && !photosafe && !reduceMotion ? 'border-flash' : 'border-static');
  if (def.priority === 'P0') channels.push('vibrate');
  const durationMs = Math.max(2000, hearing.durationMs || 3000);
  return { ...def, type, channels, durationMs, color: PRIORITY_COLORS[def.priority], position: hearing.position };
}

export class VisualCueManager {
  constructor({ getPrefs, holdScale = () => 1 } = {}) {
    this.getPrefs = getPrefs;
    this.holdScale = holdScale;
    this.log = [];
    this._root = null;
    this._border = null;
  }

  mount() {
    if (this._root) return;
    this._root = document.createElement('div');
    this._root.id = 'a11y-cues';
    this._root.className = 'a11y-cues a11y-keep-visible';
    this._root.setAttribute('role', 'log');
    this._root.setAttribute('aria-live', 'polite');
    this._root.setAttribute('aria-label', '声音提示');
    document.body.appendChild(this._root);
    this._border = document.createElement('div');
    this._border.id = 'a11y-cue-border';
    this._border.className = 'a11y-cue-border';
    this._border.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this._border);
  }

  show(type, { text, lang } = {}) {
    const p = this.getPrefs();
    const html = document.documentElement;
    const plan = planCue(type, p.hearing, {
      reduceMotion: html.classList.contains('a11y-reduce-motion'),
      photosafe: html.classList.contains('a11y-photosafe'),
    });
    if (!plan) return null;
    this.mount();
    const t0 = performance.now();
    const label = t(plan.label, lang);
    this._root.dataset.position = plan.position;
    const item = document.createElement('div');
    item.className = `a11y-cue a11y-cue-${plan.priority.toLowerCase()} a11y-cue-${p.hearing.intensity}`;
    item.style.setProperty('--a11y-cue-color', plan.color);
    item.innerHTML = '<span class="a11y-cue-icon" aria-hidden="true"></span><span class="a11y-cue-text"></span>';
    item.querySelector('.a11y-cue-icon').textContent = plan.icon;
    item.querySelector('.a11y-cue-text').textContent = text ? `${label}：${text}` : label;
    this._root.appendChild(item);
    while (this._root.children.length > 4) this._root.firstChild.remove();
    const hold = plan.durationMs * this.holdScale();
    setTimeout(() => item.remove(), hold);
    if (plan.channels.includes('border-flash') || plan.channels.includes('border-static')) {
      const b = this._border;
      b.style.setProperty('--a11y-cue-color', plan.color);
      b.className = `a11y-cue-border on ${plan.channels.includes('border-flash') ? 'flash' : 'static'}`;
      clearTimeout(this._bt);
      this._bt = setTimeout(() => { b.className = 'a11y-cue-border'; }, Math.min(1500, hold));
    }
    // 'vibrate' 通道由游戏事件中心统一触发（CatchEngine 自身已对捕捉结果震动，避免重复）
    const entry = { type, priority: plan.priority, channels: plan.channels, label, holdMs: hold, renderMs: Number((performance.now() - t0).toFixed(2)), t: Date.now() };
    this.log.push(entry);
    if (this.log.length > 100) this.log.shift();
    return entry;
  }
}
