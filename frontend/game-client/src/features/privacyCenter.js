// frontend/game-client/src/features/privacyCenter.js
// REQ-00044：个人数据导出与账号删除（GDPR）客户端入口
//
// 在"我的"页追加"隐私与数据"卡片：
//   - 导出我的数据：GET /v1/gdpr/export → 下载 JSON 文件（服务端每小时限 3 次）
//   - 申请删除账号：需输入确认语，DELETE /v1/gdpr/delete → 进入 30 天冷却期
//   - 冷却期内撤销：POST /v1/gdpr/delete/cancel
//   - 状态：GET /v1/gdpr/status
// GDPR 接口返回的不是 { code, data } 包装，这里直接用 fetch（带 token，401 时刷新一次再重试）。

const CONFIRM_PHRASE = 'DELETE MY ACCOUNT';

function apiBase() {
  return (window.PMG_CONFIG && window.PMG_CONFIG.apiBase) || `${location.origin}/v1`;
}

async function gdprFetch(api, method, path, body) {
  const doFetch = () => fetch(`${apiBase()}/gdpr${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(api && api._accessToken ? { Authorization: `Bearer ${api._accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401 && api && api._refreshToken) {
    try { await api.refreshAccessToken(); res = await doFetch(); } catch { /* 保持 401 */ }
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, ok: res.ok, data };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch { return iso; }
}

export function initPrivacyCenter(ctx = {}) {
  const { api, toast = (m) => console.log(m) } = ctx;
  const profile = document.getElementById('profile');
  if (!profile || document.getElementById('privacy-card')) return { enabled: false };

  const statusLine = el('p', { id: 'privacy-status', class: 'privacy-status', role: 'status', 'aria-live': 'polite' });
  const exportBtn = el('button', { type: 'button', id: 'privacy-export', 'data-testid': 'privacy-export' }, '导出我的数据');
  const deleteBtn = el('button', { type: 'button', id: 'privacy-delete', 'data-testid': 'privacy-delete', class: 'danger' }, '申请删除账号');
  const cancelBtn = el('button', { type: 'button', id: 'privacy-cancel', 'data-testid': 'privacy-cancel', hidden: '' }, '撤销删除申请');

  const card = el('section', { id: 'privacy-card', class: 'inv-card privacy-card', 'aria-labelledby': 'privacy-title', 'data-testid': 'privacy-card' },
    el('h2', { id: 'privacy-title', class: 'inv-header' }, '隐私与数据'),
    el('p', { class: 'privacy-desc' }, '你可以随时导出游戏保存的个人数据，或申请删除账号（30 天冷却期内可撤销）。'),
    el('div', { class: 'privacy-actions' }, exportBtn, deleteBtn, cancelBtn),
    statusLine);
  profile.append(card);

  async function refreshStatus() {
    const r = await gdprFetch(api, 'GET', '/status');
    const latest = r.ok && r.data && r.data.latest;
    const pending = latest && String(latest.status).toUpperCase() === 'PENDING'; // 服务端状态为大写 PENDING/PROCESSING/CANCELLED…
    cancelBtn.hidden = !pending;
    deleteBtn.hidden = !!pending;
    statusLine.textContent = pending
      ? `账号将于 ${formatDate(latest.scheduled_for || latest.scheduledFor)} 删除；在此之前可撤销。`
      : '';
    return latest;
  }

  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    statusLine.textContent = '正在准备导出…';
    try {
      const r = await gdprFetch(api, 'GET', '/export');
      if (r.status === 429) { statusLine.textContent = '导出过于频繁，请一小时后再试。'; return; }
      if (!r.ok) { statusLine.textContent = '导出失败，请稍后重试。'; return; }
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `minego-data-export-${new Date().toISOString().slice(0, 10)}.json`, 'data-testid': 'privacy-export-link' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      window.PMG_LAST_EXPORT = r.data; // 供测试与"查看导出内容"使用
      statusLine.textContent = '导出完成，文件已开始下载。';
    } finally {
      exportBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', () => openDeleteDialog());

  cancelBtn.addEventListener('click', async () => {
    const r = await gdprFetch(api, 'POST', '/delete/cancel');
    toast(r.ok ? '已撤销删除申请' : '撤销失败，请稍后重试', r.ok ? 'ok' : '');
    await refreshStatus();
    deleteBtn.focus();
  });

  function openDeleteDialog() {
    const opener = document.activeElement;
    const input = el('input', { id: 'privacy-confirm-input', type: 'text', autocomplete: 'off', 'data-testid': 'privacy-confirm-input', 'aria-describedby': 'privacy-confirm-help' });
    const reason = el('textarea', { id: 'privacy-reason', rows: '2', 'aria-label': '删除原因（可选）' });
    const error = el('p', { id: 'privacy-confirm-error', role: 'alert', class: 'privacy-error' });
    const submit = el('button', { type: 'submit', class: 'danger', 'data-testid': 'privacy-confirm-submit' }, '确认删除');
    const cancel = el('button', { type: 'button' }, '取消');
    const form = el('form', {},
      el('h2', { id: 'privacy-dialog-title' }, '删除账号'),
      el('p', { id: 'privacy-confirm-help' }, `账号及关联数据将在 30 天冷却期后永久删除，期间可随时撤销。请输入 "${CONFIRM_PHRASE}" 确认。`),
      el('label', { for: 'privacy-confirm-input' }, '确认语'), input,
      reason, error,
      el('div', { class: 'privacy-actions' }, cancel, submit));
    const dialog = el('div', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'privacy-dialog-title', class: 'privacy-dialog', 'data-testid': 'privacy-dialog' }, form);
    const close = () => { dialog.remove(); document.removeEventListener('keydown', onKey); if (opener && opener.focus) opener.focus(); };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') { // 焦点限制在对话框内
        const f = [...dialog.querySelectorAll('input,textarea,button')];
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (input.value.trim() !== CONFIRM_PHRASE) {
        error.textContent = `请准确输入 "${CONFIRM_PHRASE}"`;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      submit.disabled = true;
      const r = await gdprFetch(api, 'DELETE', '/delete', { confirmation: CONFIRM_PHRASE, reason: reason.value || undefined });
      submit.disabled = false;
      if (!r.ok) { error.textContent = (r.data && r.data.error) || '申请失败，请稍后重试'; return; }
      close();
      toast(r.data.message || '已提交删除申请', 'ok');
      await refreshStatus();
      cancelBtn.focus();
    });
    document.addEventListener('keydown', onKey);
    document.body.append(dialog);
    input.focus();
  }

  const style = el('style', { id: 'privacy-center-style' }, `
    .privacy-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .privacy-actions button { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border, #444); background: transparent; color: inherit; cursor: pointer; }
    .privacy-actions button.danger { border-color: #e5484d; color: #e5484d; }
    .privacy-desc, .privacy-status { font-size: 13px; opacity: .85; margin: 6px 0; }
    .privacy-dialog { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .privacy-dialog form { background: var(--card, #1c1c24); color: inherit; padding: 16px; border-radius: 12px; width: min(92vw, 420px); display: grid; gap: 8px; }
    .privacy-dialog input, .privacy-dialog textarea { padding: 8px; border-radius: 8px; border: 1px solid var(--border, #444); background: transparent; color: inherit; }
    .privacy-error { color: #e5484d; font-size: 13px; min-height: 1em; }
  `);
  document.head.append(style);

  refreshStatus().catch(() => {});
  window.addEventListener('pmg:screen', (e) => { if (e.detail === 'profile') refreshStatus().catch(() => {}); });
  return { enabled: true, refreshStatus };
}
