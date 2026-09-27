// frontend/game-client/src/features/profile-notify/core.js
// E05/E13 客户端公共工具：带 token 的请求（401 刷新一次）、DOM 构建、底部弹出面板、语言
//
// 服务端错误有两种包装：{ code, message } 与 { success:false, error:{ code, message } }，这里统一取出 message。

export function apiBase() {
  return (window.PMG_CONFIG && window.PMG_CONFIG.apiBase) || `${location.origin}/v1`;
}

export function wsBase() {
  return (window.PMG_CONFIG && window.PMG_CONFIG.wsBase)
    || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

export function lang() {
  try { return localStorage.getItem('pmg_language') || navigator.language || 'zh-CN'; } catch { return 'zh-CN'; }
}

export class HttpError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

/** 请求 /v1 接口，返回 data 字段；失败抛出 HttpError（带服务端 message） */
export async function http(api, method, path, body, { raw = false, timeout = 10000 } = {}) {
  const doFetch = () => fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Language': lang(),
      ...(api && api._accessToken ? { Authorization: `Bearer ${api._accessToken}` } : {}),
    },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  let res = await doFetch();
  if (res.status === 401 && api && api._refreshToken) {
    try { await api.refreshAccessToken(); res = await doFetch(); } catch { /* 保持 401 */ }
  }
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || (data && data.success === false) || (data && typeof data.code === 'number' && data.code !== 0)) {
    const msg = (data && ((data.error && data.error.message) || data.message)) || `请求失败（${res.status}）`;
    throw new HttpError(msg, res.status, data && ((data.error && data.error.code) || data.code));
  }
  return data && Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
}

/** h('div', {class:'x', onclick: fn, 'aria-label': 'y'}, child1, 'text') —— 文本一律 textContent，避免注入 */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, sv); else node.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString();
}

let sheetStack = [];

/**
 * 底部弹出面板（全屏 sheet）：Esc / 关闭按钮关闭，打开时焦点移入，关闭后焦点还原
 * @returns {{ el: HTMLElement, body: HTMLElement, close: () => void, setTitle: (t:string) => void }}
 */
export function openSheet(title, { id, onClose } = {}) {
  const prevFocus = document.activeElement;
  const titleId = `pn-sheet-title-${Date.now()}`;
  const titleEl = h('h2', { id: titleId, class: 'pn-sheet-title' }, title);
  const body = h('div', { class: 'pn-sheet-body' });
  const close = () => {
    el.remove();
    sheetStack = sheetStack.filter((s) => s !== api);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const closeBtn = h('button', { type: 'button', class: 'pn-icon-btn', 'aria-label': '关闭', onclick: close }, '✕');
  const el = h('div', { class: 'pn-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, id, 'data-testid': id },
    h('div', { class: 'pn-sheet-head' }, titleEl, closeBtn), body);
  const onKey = (e) => { if (e.key === 'Escape' && sheetStack[sheetStack.length - 1] === api) close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  const api = { el, body, close, setTitle: (t) => { titleEl.textContent = t; } };
  sheetStack.push(api);
  setTimeout(() => closeBtn.focus(), 0);
  return api;
}

export function emptyState(text) { return h('p', { class: 'pn-empty' }, text); }

export function progressBar(value, max, label) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return h('div', { class: 'pn-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max),
    'aria-valuenow': String(value), 'aria-label': label || `${value}/${max}` },
  h('div', { class: 'pn-progress-fill', style: { width: `${pct}%` } }));
}

export function loadStyles() {
  if (document.getElementById('pn-styles')) return;
  document.head.append(h('link', { id: 'pn-styles', rel: 'stylesheet', href: new URL('./profileNotify.css', import.meta.url).href }));
}

/** 应用内跳转（消息深度链接）：派发 pmg:navigate，由各面板监听处理 */
export function navigate(actionUrl, data) {
  window.dispatchEvent(new CustomEvent('pmg:navigate', { detail: { actionUrl, data } }));
}
