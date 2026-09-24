// frontend/game-client/src/accessibility/dialog.js
// 可访问的模态对话框：role=dialog + aria-modal + 焦点陷阱 + Esc 关闭 + 关闭后焦点恢复（REQ-00180 / REQ-00503）

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

export function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.closest('[hidden],[inert]')) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    // details 内未展开部分不可聚焦（summary 除外）
    const det = el.parentElement && el.parentElement.closest('details:not([open])');
    if (det && el.tagName !== 'SUMMARY') return false;
    return el.getClientRects().length > 0;
  });
}

const stack = [];

/** 为已存在的元素加上焦点陷阱；返回 release()（恢复焦点） */
export function trapFocus(container, { onEscape, initialFocus, restoreTo } = {}) {
  const previous = restoreTo || document.activeElement;
  const onKey = (e) => {
    if (stack[stack.length - 1] !== entry) return;
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault();
      e.stopPropagation();
      onEscape(e);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusableIn(container);
    if (!items.length) { e.preventDefault(); container.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  };
  const entry = { container, onKey, previous };
  stack.push(entry);
  document.addEventListener('keydown', onKey, true);
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
  requestAnimationFrame(() => {
    const target = (initialFocus && container.querySelector(initialFocus)) || focusableIn(container)[0] || container;
    try { target.focus({ preventScroll: false }); } catch { /* ignore */ }
  });
  return function release() {
    document.removeEventListener('keydown', onKey, true);
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (previous && document.contains(previous) && typeof previous.focus === 'function') {
      try { previous.focus(); } catch { /* ignore */ }
    }
  };
}

export function isDialogOpen() { return stack.length > 0; }

/**
 * 打开一个模态对话框
 * @returns {{ el: HTMLElement, body: HTMLElement, close: Function }}
 */
export function openDialog({ id, title, className = '', content, onClose, initialFocus, describedBy, closeLabel = '关闭' } = {}) {
  const existing = id && document.getElementById(id);
  if (existing && existing._a11yClose) existing._a11yClose();
  const backdrop = document.createElement('div');
  backdrop.className = `a11y-dialog-backdrop ${className}`.trim();
  if (id) backdrop.id = id;
  const dlg = document.createElement('div');
  dlg.className = 'a11y-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  const titleId = `${id || 'a11y-dlg'}-title`;
  dlg.setAttribute('aria-labelledby', titleId);
  if (describedBy) dlg.setAttribute('aria-describedby', describedBy);
  const head = document.createElement('div');
  head.className = 'a11y-dialog-head';
  const h = document.createElement('h2');
  h.id = titleId;
  h.className = 'a11y-dialog-title';
  h.textContent = title;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'a11y-dialog-x';
  x.setAttribute('aria-label', closeLabel);
  x.textContent = '×';
  head.append(h, x);
  const body = document.createElement('div');
  body.className = 'a11y-dialog-body';
  if (typeof content === 'string') body.innerHTML = content;
  else if (content) body.appendChild(content);
  dlg.append(head, body);
  backdrop.appendChild(dlg);
  document.body.appendChild(backdrop);
  // 背景内容对辅助技术隐藏
  const hidden = [];
  for (const el of document.body.children) {
    if (el === backdrop || el.classList.contains('a11y-keep-visible') || el.getAttribute('aria-live') || el.tagName === 'SCRIPT') continue;
    if (!el.hasAttribute('inert')) { el.setAttribute('inert', ''); hidden.push(el); }
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    hidden.forEach((el) => el.removeAttribute('inert'));
    release();
    backdrop.remove();
    if (onClose) onClose();
  };
  const release = trapFocus(dlg, { onEscape: close, initialFocus });
  x.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop._a11yClose = close;
  return { el: backdrop, dialog: dlg, body, close };
}
