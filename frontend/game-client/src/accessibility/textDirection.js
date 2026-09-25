// frontend/game-client/src/accessibility/textDirection.js
// REQ-00244 / REQ-00413：RTL 语言检测与文本方向自动布局
//   - isRtlLang / directionFor：ar/he/fa/ur 等返回 rtl
//   - detectTextDirection：按首个强方向字符判断任意文本（混合文本用 dir=auto / <bdi> 隔离）
//   - DirectionManager：监听 <html lang> 变化即时切换 <html dir>，动态内容（名称/提示）加 dir=auto

export const RTL_LANGS = ['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ku', 'ckb'];

export function isRtlLang(lang) {
  const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return RTL_LANGS.includes(base);
}

/** 返回 { direction: 'rtl'|'ltr' } */
export function detectLangDirection(lang) {
  return { lang, direction: isRtlLang(lang) ? 'rtl' : 'ltr' };
}

export function directionFor(lang, mode = 'auto') {
  if (mode === 'rtl' || mode === 'ltr') return mode;
  return isRtlLang(lang) ? 'rtl' : 'ltr';
}

const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHARS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿가-힯]/;

/** 首个强方向字符决定方向；无强字符（纯数字/符号）返回 'neutral' */
export function detectTextDirection(text) {
  for (const ch of String(text || '')) {
    if (RTL_CHARS.test(ch)) return 'rtl';
    if (LTR_CHARS.test(ch)) return 'ltr';
  }
  return 'neutral';
}

/** 用 Unicode 隔离符包裹嵌入片段（数字、英文、用户名），避免 RTL 句子中错位 */
export function isolate(fragment) {
  return `⁨${fragment}⁩`;
}

// 需要 dir=auto 的动态文本（用户名、精灵名、提示），以及 RTL 下需要镜像的方向性图标
const AUTO_DIR_SELECTORS = ['#map-name', '#p-name', '#c-name', '#c-title', '.entity-name', '.toast', '.a11y-cue-text', '.a11y-subtitle-line'];

export class DirectionManager {
  constructor({ getPrefs, onChange } = {}) {
    this.getPrefs = getPrefs;
    this.onChange = onChange;
    this.lastSwitchMs = null;
    this._obs = null;
  }

  current() {
    return document.documentElement.getAttribute('dir') || 'ltr';
  }

  apply() {
    const t0 = performance.now();
    const html = document.documentElement;
    let mode = (this.getPrefs().direction || {}).mode || 'auto';
    // 翻译/布局预览：URL 参数 ?dir=rtl|ltr 临时强制方向（REQ-00413，不写入偏好）
    try { const q = new URLSearchParams(location.search).get('dir'); if (q === 'rtl' || q === 'ltr') mode = q; } catch { /* ignore */ }
    const dir = directionFor(html.lang, mode);
    const changed = html.getAttribute('dir') !== dir;
    html.setAttribute('dir', dir);
    html.classList.toggle('a11y-rtl', dir === 'rtl');
    this.markAuto(document);
    this.lastSwitchMs = Number((performance.now() - t0).toFixed(2));
    if (changed && this.onChange) this.onChange(dir);
    return dir;
  }

  markAuto(root) {
    if (!root || !root.querySelectorAll) return;
    for (const sel of AUTO_DIR_SELECTORS) {
      root.querySelectorAll(sel).forEach((el) => { if (!el.hasAttribute('dir')) el.setAttribute('dir', 'auto'); });
    }
  }

  start() {
    this.apply();
    this._obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.target === document.documentElement && m.attributeName === 'lang') this.apply();
        if (m.type === 'childList') m.addedNodes.forEach((n) => { if (n.nodeType === 1) { this.markAuto(n.parentNode || n); } });
      }
    });
    this._obs.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    this._obs.observe(document.body, { childList: true, subtree: true });
  }
}
