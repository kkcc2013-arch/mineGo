// frontend/game-client/src/features/profile-notify/messageCenter.js
// REQ-00099 消息中心 / REQ-00261 实时通知 / REQ-00425 智能推送（客户端）
//
// - 底部导航"消息"🔔 + 未读红色徽章；点击打开消息中心
// - 分类标签页（全部/社交/奖励/活动/精灵/系统/安全）、未读筛选、分页加载 + 虚拟滚动（固定行高，只渲染可见行）
// - 点击消息：标记已读并展开详情，"前往"按钮按 actionUrl 深度链接跳转；全部已读、删除、清空已读（二次确认）
// - 偏好设置：分类开关（系统/安全强制）、免打扰时段、临时静音、推送开关
// - WebSocket 实时推送（/ws/notifications，断线指数退避重连，前台切回时增量同步），新消息 toast（免打扰时静默）
// - IndexedDB 本地缓存（PMG_Messages：notifications / metadata），离线时展示缓存，上线后增量同步
import { http, h, openSheet, timeAgo, wsBase, lang, navigate, emptyState } from './core.js';

const TABS = [
  { key: 'all', label: '全部', icon: '📬' }, { key: 'social', label: '社交', icon: '👥' },
  { key: 'reward', label: '奖励', icon: '🎁' }, { key: 'event', label: '活动', icon: '🎉' },
  { key: 'pokemon', label: '精灵', icon: '🐉' }, { key: 'system', label: '系统', icon: '📢' },
  { key: 'security', label: '安全', icon: '🔒' },
];
const ROW_H = 76;
const PAGE = 20;

// ── IndexedDB 缓存 ────────────────────────────────────────────
const idb = {
  db: null,
  async open() {
    if (this.db || !('indexedDB' in window)) return this.db;
    this.db = await new Promise((resolve) => {
      const req = indexedDB.open('PMG_Messages', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('notifications')) d.createObjectStore('notifications', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        if (!d.objectStoreNames.contains('metadata')) d.createObjectStore('metadata', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return this.db;
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    if (!d) return null;
    return new Promise((resolve) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : null);
      t.onerror = () => resolve(null);
    });
  },
  put(list) { return this.tx('notifications', 'readwrite', (s) => { for (const n of list) s.put(n); }); },
  remove(id) { return this.tx('notifications', 'readwrite', (s) => s.delete(id)); },
  all() { return this.tx('notifications', 'readonly', (s) => s.getAll()); },
  clear() { return this.tx('notifications', 'readwrite', (s) => s.clear()); },
  meta(key, value) {
    if (value === undefined) return this.tx('metadata', 'readonly', (s) => s.get(key)).then((r) => (r ? r.value : null));
    return this.tx('metadata', 'readwrite', (s) => s.put({ key, value }));
  },
};

export function createMessageCenter({ api, toast }) {
  const state = { unread: 0, byCategory: {}, items: [], tab: 'all', unreadOnly: false, page: 0, total: 0, loading: false,
    offline: false, ws: null, wsRetry: 0, wsTimer: null, poll: null, sheet: null, expanded: null, started: false };

  // ── 导航栏图标 ──────────────────────────────────────────────
  const badge = h('span', { class: 'pn-badge', hidden: true, 'data-testid': 'message-badge', 'aria-hidden': 'true' });
  const navTab = h('div', { class: 'nav-tab', id: 'tab-messages', role: 'button', tabindex: '0', 'data-testid': 'nav-messages',
    'aria-label': '消息中心', onclick: () => open(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
  h('div', { class: 'nav-icon pn-bell', 'aria-hidden': 'true' }, '🔔', badge), h('span', {}, '消息'));

  function mountNav() {
    const nav = document.getElementById('nav');
    if (nav && !document.getElementById('tab-messages')) nav.append(navTab);
  }

  function setUnread(n, byCategory) {
    state.unread = Math.max(0, n | 0);
    if (byCategory) state.byCategory = byCategory;
    badge.hidden = state.unread === 0;
    badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
    navTab.setAttribute('aria-label', state.unread ? `消息中心，${state.unread} 条未读` : '消息中心');
    if (state.sheet) renderTabs();
  }

  async function refreshUnread() {
    try {
      const r = await http(api, 'GET', '/notifications/unread-count');
      setUnread(r.total, r.byCategory);
      state.offline = false;
    } catch (e) { if (!e.status || e.code === 9999) state.offline = true; }
  }

  // ── WebSocket ───────────────────────────────────────────────
  async function connect() {
    if (!api._accessToken || (state.ws && state.ws.readyState <= 1)) return;
    const since = await idb.meta('lastSyncTime');
    const url = `${wsBase()}/ws/notifications?token=${encodeURIComponent(api._accessToken)}&lang=${encodeURIComponent(lang())}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return scheduleReconnect(); }
    state.ws = ws;
    ws.onopen = () => { state.wsRetry = 0; };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello' || msg.type === 'unread') setUnread(msg.unreadCount, msg.byCategory);
      if (msg.type === 'notification' && msg.notification) onIncoming(msg.notification, msg);
    };
    ws.onclose = (ev) => {
      state.ws = null;
      if (ev.code === 4001 || !api._accessToken) return; // 未授权 / 已登出
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function scheduleReconnect() {
    if (!state.started) return;
    clearTimeout(state.wsTimer);
    const delay = Math.min(30000, 1000 * 2 ** state.wsRetry++) + Math.random() * 500;
    state.wsTimer = setTimeout(() => { refreshAccess().then(connect); }, delay);
  }
  async function refreshAccess() { try { await http(api, 'GET', '/notifications/unread-count'); } catch { /* 刷新 token 失败时下次再试 */ } }

  function onIncoming(n, msg) {
    const exists = state.items.findIndex((x) => x.id === n.id);
    if (exists >= 0) state.items[exists] = n; else if (state.tab === 'all' || state.tab === n.category) state.items.unshift(n);
    idb.put([n]);
    idb.meta('lastSyncTime', n.createdAt);
    if (msg.unreadCount !== undefined) setUnread(msg.unreadCount);
    else if (!n.isRead) setUnread(state.unread + 1);
    if (!msg.replay && !msg.silent && toast) toast(`${n.icon || '🔔'} ${n.title}：${n.body}`, n.priority === 'urgent' ? 'err' : 'ok');
    if (state.sheet) renderList();
  }

  // ── 列表 ────────────────────────────────────────────────────
  async function loadPage(reset) {
    if (state.loading) return;
    if (reset) { state.page = 0; state.items = []; state.total = 0; }
    if (!reset && state.items.length >= state.total && state.page > 0) return;
    state.loading = true;
    const q = new URLSearchParams({ page: String(state.page + 1), limit: String(PAGE), lang: lang() });
    if (state.tab !== 'all') q.set('category', state.tab);
    if (state.unreadOnly) q.set('status', 'unread');
    try {
      const r = await http(api, 'GET', `/notifications?${q}`);
      state.page += 1;
      state.total = r.pagination.total;
      state.items.push(...r.notifications.filter((n) => !state.items.some((x) => x.id === n.id)));
      setUnread(r.unreadCount);
      state.offline = false;
      idb.put(r.notifications);
      if (state.page === 1 && r.notifications[0]) idb.meta('lastSyncTime', r.notifications[0].createdAt);
    } catch (e) {
      if (!e.status || e.code === 9999) { // 网络不可用（含 Service Worker 离线响应）：展示本地缓存
        state.offline = true;
        const cached = (await idb.all()) || [];
        state.items = cached.filter((n) => (state.tab === 'all' || n.category === state.tab) && (!state.unreadOnly || !n.isRead))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        state.total = state.items.length;
      } else if (toast) toast(e.message, 'err');
    } finally { state.loading = false; }
    renderList();
  }

  let listEl; let spacer; let windowEl; let tabsEl; let statusEl;

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.replaceChildren(...TABS.map((t) => {
      const n = t.key === 'all' ? state.unread : (state.byCategory[t.key] || 0);
      return h('button', { type: 'button', role: 'tab', class: `pn-tab${state.tab === t.key ? ' on' : ''}`, 'aria-selected': String(state.tab === t.key),
        'data-testid': `msg-tab-${t.key}`, onclick: () => { state.tab = t.key; renderTabs(); loadPage(true); } },
      `${t.icon} ${t.label}`, n ? h('span', { class: 'pn-tab-count' }, String(n)) : null);
    }));
  }

  function row(n, index) {
    const expanded = state.expanded === n.id;
    const item = h('div', { class: `pn-msg${n.isRead ? '' : ' unread'}${expanded ? ' expanded' : ''}`, role: 'listitem', tabindex: '0',
      'data-testid': 'message-item', 'data-id': n.id, style: { top: `${index * ROW_H}px` },
      'aria-label': `${n.isRead ? '' : '未读，'}${n.title}，${n.body}，${timeAgo(n.createdAt)}`,
      onclick: () => onClickItem(n), onkeydown: (e) => onItemKey(e, n) },
    h('div', { class: 'pn-msg-icon', 'aria-hidden': 'true' }, n.icon || '📬'),
    h('div', { class: 'pn-msg-main' },
      h('div', { class: 'pn-msg-title' }, n.title, n.isRead ? null : h('span', { class: 'pn-dot', 'aria-hidden': 'true' })),
      h('div', { class: 'pn-msg-body' }, n.body),
      h('div', { class: 'pn-msg-time' }, `${n.categoryLabel || ''} · ${timeAgo(n.createdAt)}`)),
    h('button', { type: 'button', class: 'pn-icon-btn', 'aria-label': '删除这条消息', 'data-testid': 'message-delete',
      onclick: (e) => { e.stopPropagation(); remove(n); } }, '🗑'));
    return item;
  }

  function renderList() {
    if (!listEl) return;
    statusEl.textContent = state.offline ? '离线模式：显示本地缓存的消息' : '';
    if (!state.items.length) {
      spacer.style.height = '0px';
      windowEl.replaceChildren(emptyState(state.loading ? '加载中…' : '暂无消息'));
      return;
    }
    spacer.style.height = `${state.items.length * ROW_H}px`;
    const first = Math.max(0, Math.floor(listEl.scrollTop / ROW_H) - 5);
    const last = Math.min(state.items.length, first + Math.ceil(listEl.clientHeight / ROW_H) + 10);
    const nodes = [];
    for (let i = first; i < last; i++) nodes.push(row(state.items[i], i));
    windowEl.replaceChildren(...nodes);
    if (state.expanded) renderDetail();
  }

  function onItemKey(e, n) {
    const idx = state.items.indexOf(n);
    if (e.key === 'Enter') { e.preventDefault(); onClickItem(n); }
    else if (e.key === 'Delete') { e.preventDefault(); remove(n); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = idx + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0 || next >= state.items.length) return;
      listEl.scrollTop = Math.max(0, next * ROW_H - listEl.clientHeight / 2);
      renderList();
      const elNext = windowEl.querySelector(`[data-id="${state.items[next].id}"]`);
      if (elNext) elNext.focus();
    }
  }

  async function onClickItem(n) {
    state.expanded = state.expanded === n.id ? null : n.id;
    if (!n.isRead) {
      n.isRead = true;
      setUnread(state.unread - 1);
      idb.put([n]);
      http(api, 'PATCH', `/notifications/${n.id}/read`).catch(() => { /* 离线时下次同步 */ });
    }
    renderList();
  }

  function renderDetail() {
    const n = state.items.find((x) => x.id === state.expanded);
    const old = document.getElementById('pn-msg-detail');
    if (old) old.remove();
    if (!n || !state.sheet) return;
    const actions = [];
    if (n.actionUrl) {
      actions.push(h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': 'message-go', onclick: async () => {
        try { await http(api, 'POST', `/notifications/${n.id}/click`); } catch { /* 统计失败不影响跳转 */ }
        state.sheet.close();
        navigate(n.actionUrl, n.data);
      } }, '前往'));
    }
    const detail = h('div', { id: 'pn-msg-detail', class: 'pn-msg-detail', role: 'region', 'aria-label': '消息详情' },
      h('strong', {}, n.title), h('p', {}, n.body), h('small', {}, new Date(n.createdAt).toLocaleString()),
      h('div', { class: 'pn-row' }, ...actions));
    state.sheet.body.append(detail);
  }

  async function remove(n) {
    try {
      await http(api, 'DELETE', `/notifications/${n.id}`);
      state.items = state.items.filter((x) => x.id !== n.id);
      state.total = Math.max(0, state.total - 1);
      if (!n.isRead) setUnread(state.unread - 1);
      idb.remove(n.id);
      renderList();
    } catch (e) { if (toast) toast(e.message, 'err'); }
  }

  async function readAll() {
    try {
      const r = await http(api, 'POST', '/notifications/batch-read', state.tab === 'all' ? { all: true } : { category: state.tab });
      for (const n of state.items) n.isRead = true;
      idb.put(state.items);
      await refreshUnread();
      renderList();
      if (toast) toast(`已将 ${r.updatedCount} 条标记为已读`, 'ok');
    } catch (e) { if (toast) toast(e.message, 'err'); }
  }

  async function clearRead() {
    if (!window.confirm('确定删除所有已读消息吗？')) return;
    try {
      const r = await http(api, 'POST', '/notifications/clear-read');
      for (const n of state.items.filter((x) => x.isRead)) idb.remove(n.id);
      if (toast) toast(`已删除 ${r.deletedCount} 条已读消息`, 'ok');
      loadPage(true);
    } catch (e) { if (toast) toast(e.message, 'err'); }
  }

  // ── 偏好设置 ────────────────────────────────────────────────
  async function openPreferences() {
    const sheet = openSheet('通知偏好', { id: 'notification-preferences' });
    let prefs;
    try { prefs = await http(api, 'GET', '/notifications/preferences'); } catch (e) { sheet.body.append(emptyState(e.message)); return; }
    const toggles = {};
    const catRows = TABS.filter((t) => t.key !== 'all').map((t) => {
      const mandatory = (prefs.mandatoryCategories || []).includes(t.key);
      const input = h('input', { type: 'checkbox', id: `pref-${t.key}`, 'data-testid': `pref-${t.key}` });
      input.checked = prefs.notificationTypes[t.key] !== false;
      input.disabled = mandatory;
      toggles[t.key] = input;
      return h('label', { class: 'pn-pref-row', for: `pref-${t.key}` }, `${t.icon} ${t.label}${mandatory ? '（必须接收）' : ''}`, input);
    });
    const push = h('input', { type: 'checkbox', id: 'pref-push' }); push.checked = prefs.enablePush;
    const qhOn = h('input', { type: 'checkbox', id: 'pref-qh', 'data-testid': 'pref-quiet-enabled' }); qhOn.checked = prefs.quietHours.enabled;
    const qhStart = h('input', { type: 'time', value: prefs.quietHours.start, 'aria-label': '免打扰开始', 'data-testid': 'pref-quiet-start' });
    const qhEnd = h('input', { type: 'time', value: prefs.quietHours.end, 'aria-label': '免打扰结束', 'data-testid': 'pref-quiet-end' });
    const mute = h('select', { 'aria-label': '临时静音' },
      h('option', { value: '' }, '不静音'), h('option', { value: '60' }, '静音 1 小时'), h('option', { value: '480' }, '静音 8 小时'),
      h('option', { value: '0' }, '取消静音'));
    const providers = prefs.pushProviders || {};
    const note = (!providers.fcm && !providers.apns)
      ? h('p', { class: 'pn-hint' }, '系统推送（APNs/FCM）尚未开通，离线期间的消息会保存在消息中心，上线后可查看。') : null;
    const save = h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': 'pref-save', onclick: async () => {
      const body = {
        notificationTypes: Object.fromEntries(Object.entries(toggles).map(([k, i]) => [k, i.checked])),
        quietHours: { enabled: qhOn.checked, start: qhStart.value || '22:00', end: qhEnd.value || '08:00' },
        enablePush: push.checked,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (mute.value !== '') body.muteForMinutes = Number(mute.value);
      try { await http(api, 'PATCH', '/notifications/preferences', body); if (toast) toast('通知偏好已保存', 'ok'); sheet.close(); }
      catch (e) { if (toast) toast(e.message, 'err'); }
    } }, '保存');
    sheet.body.append(
      h('fieldset', { class: 'pn-card' }, h('legend', {}, '接收哪些消息'), ...catRows),
      h('fieldset', { class: 'pn-card' }, h('legend', {}, '免打扰'),
        h('label', { class: 'pn-pref-row', for: 'pref-qh' }, '开启免打扰时段', qhOn),
        h('div', { class: 'pn-row' }, qhStart, h('span', {}, '至'), qhEnd), mute,
        h('p', { class: 'pn-hint' }, '免打扰期间消息照常进入消息中心，但不弹出提醒（紧急消息除外）。')),
      h('fieldset', { class: 'pn-card' }, h('legend', {}, '推送'), h('label', { class: 'pn-pref-row', for: 'pref-push' }, '离线时推送到手机', push), note),
      save);
  }

  // ── 面板 ────────────────────────────────────────────────────
  function open(tab) {
    if (state.sheet) return;
    if (tab) state.tab = tab;
    state.sheet = openSheet('消息中心', { id: 'message-center', onClose: () => { state.sheet = null; listEl = null; } });
    tabsEl = h('div', { class: 'pn-tabs', role: 'tablist', 'aria-label': '消息分类' });
    statusEl = h('p', { class: 'pn-hint', role: 'status', 'aria-live': 'polite' });
    const unreadOnly = h('input', { type: 'checkbox', id: 'pn-unread-only' });
    unreadOnly.checked = state.unreadOnly;
    unreadOnly.addEventListener('change', () => { state.unreadOnly = unreadOnly.checked; loadPage(true); });
    spacer = h('div', { class: 'pn-spacer' });
    windowEl = h('div', { class: 'pn-window', role: 'list', 'aria-label': '消息列表' });
    listEl = h('div', { class: 'pn-list', 'data-testid': 'message-list' }, spacer, windowEl);
    listEl.addEventListener('scroll', () => {
      renderList();
      if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - ROW_H * 3) loadPage(false);
    });
    // 下拉刷新：在顶部继续下拉
    let startY = null;
    listEl.addEventListener('touchstart', (e) => { startY = listEl.scrollTop === 0 ? e.touches[0].clientY : null; }, { passive: true });
    listEl.addEventListener('touchend', (e) => { if (startY !== null && e.changedTouches[0].clientY - startY > 80) loadPage(true); startY = null; });
    state.sheet.body.append(
      tabsEl,
      h('div', { class: 'pn-row pn-toolbar' },
        h('label', { for: 'pn-unread-only' }, unreadOnly, ' 只看未读'),
        h('button', { type: 'button', class: 'pn-btn', 'data-testid': 'message-read-all', onclick: readAll }, '全部已读'),
        h('button', { type: 'button', class: 'pn-btn', 'data-testid': 'message-clear-read', onclick: clearRead }, '清空已读'),
        h('button', { type: 'button', class: 'pn-btn', 'data-testid': 'message-preferences', onclick: openPreferences }, '⚙ 设置'),
        h('button', { type: 'button', class: 'pn-btn', 'aria-label': '刷新', onclick: () => loadPage(true) }, '⟳')),
      statusEl, listEl);
    renderTabs();
    loadPage(true);
  }

  // ── 生命周期 ────────────────────────────────────────────────
  function start() {
    if (state.started) return;
    state.started = true;
    mountNav();
    refreshUnread();
    connect();
    state.poll = setInterval(() => { refreshUnread(); if (!state.ws) connect(); }, 5 * 60 * 1000);
  }
  function stop() {
    state.started = false;
    clearInterval(state.poll); clearTimeout(state.wsTimer);
    if (state.ws) { try { state.ws.close(); } catch { /* ignore */ } state.ws = null; }
    setUnread(0);
    idb.clear();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.started) { refreshUnread(); connect(); } });
  window.addEventListener('online', () => { if (state.started) { state.offline = false; refreshUnread(); connect(); if (state.sheet) loadPage(true); } });

  mountNav();
  return { start, stop, open, openPreferences, refreshUnread, get unread() { return state.unread; } };
}
