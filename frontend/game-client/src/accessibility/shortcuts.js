// frontend/game-client/src/accessibility/shortcuts.js
// REQ-00180：键盘导航与快捷键系统
//   - ≥15 个默认快捷键（可在设置中重新映射，持久化到 prefs.keyboard.bindings）
//   - 冲突检测：拒绝浏览器/系统保留组合键与重复绑定
//   - 输入框内不触发单键快捷键；? 打开帮助面板；双击 Esc 紧急停止动画
import { openDialog } from './dialog.js';

export const DEFAULT_BINDINGS = {
  help: '?',
  settings: ',',
  goMap: 'm',
  goProfile: 'p',
  refresh: 'r',
  nextCard: 'j',
  prevCard: 'k',
  panUp: 'w',
  panLeft: 'a',
  panDown: 's',
  panRight: 'd',
  readMap: 'l',
  describe: 'v',
  ballPoke: '1',
  ballGreat: '2',
  ballUltra: '3',
  throw: 't',
  flee: 'Escape',
  status: 'i',
  toggleSpeech: 'Alt+s',
  highContrast: 'Alt+h',
  slower: '-',
  faster: '=',
  toggleMotor: 'Ctrl+Shift+m',
  toggleVoice: 'Alt+v',
  readPage: 'Alt+r',
};

// 浏览器/系统保留组合（不允许绑定）
export const RESERVED = [
  'Ctrl+w', 'Ctrl+t', 'Ctrl+n', 'Ctrl+Shift+n', 'Ctrl+Shift+t', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+l', 'Ctrl+r', 'Ctrl+f',
  'Ctrl+p', 'Ctrl+s', 'Ctrl+d', 'Ctrl+h', 'Ctrl+j', 'Ctrl+q', 'Ctrl+Shift+i', 'Ctrl+Shift+j', 'Ctrl+Shift+c', 'Ctrl+u', 'Ctrl+c', 'Ctrl+v', 'Ctrl+x', 'Ctrl+a', 'Ctrl+z',
  'Meta+w', 'Meta+t', 'Meta+q', 'Meta+r', 'Meta+l', 'Alt+F4', 'Alt+Tab', 'F5', 'F11', 'F12', 'Tab', 'Shift+Tab', 'Enter', ' ',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
];

const lower = (s) => String(s).toLowerCase();

/** KeyboardEvent → 规范组合键字符串，例如 'Ctrl+Shift+m'、'?'、'Escape' */
export function normalizeKeyEvent(e) {
  let key = e.key;
  if (!key) return '';
  if (key === 'Esc') key = 'Escape';
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  // 可打印符号（如 ?、=）已隐含 Shift，不再加 Shift 前缀；字母统一小写，Shift 显式记录
  const printable = key.length === 1;
  if (e.shiftKey && (!printable || /[a-zA-Z]/.test(key))) mods.push('Shift');
  if (printable && /[a-zA-Z]/.test(key)) key = key.toLowerCase();
  // Alt+字母在 macOS 会产生特殊字符，用 code 回退
  if (e.altKey && e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  return [...mods, key].join('+');
}

export function isReserved(combo) {
  return RESERVED.some((r) => lower(r) === lower(combo));
}

export function resolveBindings(overrides = {}) {
  const out = { ...DEFAULT_BINDINGS };
  for (const [k, v] of Object.entries(overrides || {})) if (k in DEFAULT_BINDINGS && v) out[k] = v;
  return out;
}

/** 校验新绑定：返回 null 表示可用，否则返回原因 */
export function validateBinding(action, combo, bindings) {
  if (!combo) return '无效按键';
  if (isReserved(combo)) return `${combo} 为浏览器/系统保留快捷键`;
  const other = Object.entries(bindings).find(([a, c]) => a !== action && lower(c) === lower(combo));
  if (other) return `${combo} 已被"${other[0]}"使用`;
  return null;
}

function isTextInput(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'reset'].includes((el.type || '').toLowerCase());
  return false;
}

export class ShortcutManager {
  /**
   * @param {{ getPrefs, setPref, actions: Record<string,{label:string, run:Function}>, announcer, onEmergency }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.log = [];
    this._lastEsc = 0;
    this._help = null;
  }

  bindings() { return resolveBindings(this.getPrefs().keyboard.bindings); }

  start() {
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  onKey(e) {
    if (e.defaultPrevented) return;
    const combo = normalizeKeyEvent(e);
    // 双击 Esc：紧急停止所有动画（REQ-00108），任何上下文都生效
    if (combo === 'Escape') {
      const now = performance.now();
      if (now - this._lastEsc < 500) {
        this._lastEsc = 0;
        e.preventDefault();
        if (this.onEmergency) this.onEmergency();
        this.log.push({ combo: 'Escape Escape', action: 'emergencyStop', t: Date.now() });
        return;
      }
      this._lastEsc = now;
    }
    if (!this.getPrefs().keyboard.enabled) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain && isTextInput(e.target) && combo !== 'Escape') return;
    // 对话框打开时只处理帮助/Esc（由对话框自身处理）
    if (document.querySelector('.a11y-dialog-backdrop, #lang-modal') && combo !== '?') return;
    const b = this.bindings();
    const action = Object.keys(b).find((a) => lower(b[a]) === lower(combo));
    if (!action) return;
    const def = this.actions[action];
    if (!def) return;
    const handled = def.run(e) !== false;
    if (handled) {
      e.preventDefault();
      this.log.push({ combo, action, t: Date.now() });
      if (this.log.length > 200) this.log.splice(0, 50);
      if (def.announce !== false && this.announcer) this.announcer.announce(def.label, { level: 'info', speak: false });
    }
  }

  /** 录制一个新组合键（设置面板用） */
  captureCombo() {
    return new Promise((resolve) => {
      const onKey = (e) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        document.removeEventListener('keydown', onKey, true);
        resolve(e.key === 'Escape' && !e.shiftKey ? null : normalizeKeyEvent(e));
      };
      document.addEventListener('keydown', onKey, true);
    });
  }

  rebind(action, combo) {
    const b = this.bindings();
    const err = validateBinding(action, combo, b);
    if (err) return err;
    const overrides = { ...(this.getPrefs().keyboard.bindings || {}), [action]: combo };
    this.setPref('keyboard.bindings', overrides);
    return null;
  }

  showHelp() {
    if (this._help) { this._help.close(); return; }
    const b = this.bindings();
    const rows = Object.keys(b).filter((a) => this.actions[a]).map((a) =>
      `<tr><th scope="row"><kbd>${escapeHtml(b[a] === ' ' ? 'Space' : b[a])}</kbd></th><td>${escapeHtml(this.actions[a].label)}</td></tr>`).join('');
    const html = `<p>在任意页面按下列按键（输入框中不生效）。可在"无障碍设置 → 键盘"中重新映射。</p>
      <table class="a11y-table"><caption class="a11y-sr-only">快捷键列表</caption>
      <thead><tr><th scope="col">按键</th><th scope="col">功能</th></tr></thead><tbody>${rows}
      <tr><th scope="row"><kbd>Esc Esc</kbd></th><td>紧急停止所有动画</td></tr>
      <tr><th scope="row"><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd></th><td>在可交互元素间移动焦点</td></tr>
      <tr><th scope="row"><kbd>←</kbd><kbd>→</kbd></th><td>在精灵球/导航栏内移动</td></tr>
      <tr><th scope="row"><kbd>Enter</kbd> / <kbd>Space</kbd></th><td>激活当前元素</td></tr></tbody></table>`;
    this._help = openDialog({ id: 'a11y-help', title: '键盘快捷键', content: html, onClose: () => { this._help = null; } });
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
