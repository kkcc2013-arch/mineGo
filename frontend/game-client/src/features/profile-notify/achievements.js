// frontend/game-client/src/features/profile-notify/achievements.js
// REQ-00076 成就面板（分类切换、进度条、领奖、总览、排行榜）+ REQ-00106 称号管理（佩戴/取下/收藏、加成展示）
import { http, h, openSheet, progressBar, emptyState } from './core.js';

const RARITY_LABEL = { common: '普通', uncommon: '少见', rare: '稀有', epic: '史诗', legendary: '传说', mythic: '神话' };

export function openAchievements({ api, toast }, { focusId } = {}) {
  const sheet = openSheet('成就', { id: 'achievement-panel' });
  const state = { category: 'all', status: '' };
  const overviewEl = h('div', { class: 'pn-card', 'data-testid': 'achievement-overview' });
  const tabsEl = h('div', { class: 'pn-tabs', role: 'tablist', 'aria-label': '成就分类' });
  const listEl = h('div', { class: 'pn-grid', role: 'list', 'data-testid': 'achievement-list' });
  const hiddenEl = h('p', { class: 'pn-hint' });
  const statusSel = h('select', { 'aria-label': '筛选', onchange: () => { state.status = statusSel.value; load(); } },
    h('option', { value: '' }, '全部'), h('option', { value: 'claimable' }, '可领取'), h('option', { value: 'in_progress' }, '进行中'),
    h('option', { value: 'completed' }, '已完成'), h('option', { value: 'locked' }, '未完成'));
  sheet.body.append(overviewEl,
    h('div', { class: 'pn-row pn-toolbar' }, statusSel,
      h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': 'achievement-claim-all', onclick: claimAll }, '一键领取'),
      h('button', { type: 'button', class: 'pn-btn', onclick: () => openLeaderboard({ api }) }, '🏅 排行榜'),
      h('button', { type: 'button', class: 'pn-btn', onclick: () => openTitles({ api, toast }) }, '🎖️ 称号')),
    tabsEl, listEl, hiddenEl);

  async function loadOverview() {
    try {
      const o = await http(api, 'GET', '/achievements/my/progress');
      overviewEl.replaceChildren(
        h('div', { class: 'pn-row' }, h('strong', {}, `🏆 ${o.totalPoints} 点`), h('span', {}, `已完成 ${o.completed}/${o.total}`),
          o.rank ? h('span', {}, `全服第 ${o.rank} 名`) : null, o.claimable ? h('span', { class: 'pn-pill' }, `${o.claimable} 个奖励待领取`) : null),
        progressBar(o.completed, o.total, '成就完成度'));
      const cats = await http(api, 'GET', '/achievements/categories');
      tabsEl.replaceChildren(...[{ key: 'all', label: '全部', icon: '✨' }, ...cats].map((c) => {
        const s = o.byCategory[c.key];
        return h('button', { type: 'button', role: 'tab', class: `pn-tab${state.category === c.key ? ' on' : ''}`, 'aria-selected': String(state.category === c.key),
          onclick: () => { state.category = c.key; loadOverview(); load(); } }, `${c.icon} ${c.label}`, s ? h('span', { class: 'pn-tab-count' }, `${s.completed}/${s.total}`) : null);
      }));
    } catch (e) { overviewEl.replaceChildren(emptyState(e.message)); }
  }

  function card(a) {
    const rewardText = [
      ...Object.entries(a.rewards.currencies || {}).map(([k, v]) => `${k} ×${v}`),
      ...(a.rewards.items || []).map((i) => `${i.type} ×${i.qty}`),
      a.rewards.title ? `称号「${a.rewards.title.name}」` : null,
      a.rewards.decoration ? '收藏室装饰' : null,
    ].filter(Boolean).join('、');
    const claimBtn = a.claimable ? h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': `claim-${a.achievementId}`, onclick: async () => {
      claimBtn.disabled = true;
      try { await http(api, 'POST', `/achievements/${a.achievementId}/claim`); if (toast) toast(`已领取「${a.name}」奖励`, 'ok'); load(); loadOverview(); }
      catch (e) { claimBtn.disabled = false; if (toast) toast(e.message, 'err'); }
    } }, '领取') : null;
    return h('div', { class: `pn-ach ${a.completed ? 'done' : ''} r-${a.rarity}`, role: 'listitem', id: `ach-${a.achievementId}`,
      'aria-label': `${a.name}，${a.completed ? '已完成' : `进度 ${a.progress}/${a.target}`}` },
    h('div', { class: 'pn-row' }, h('strong', {}, a.name), h('span', { class: 'pn-pill' }, `${RARITY_LABEL[a.rarity] || a.rarity} · ${a.points} 点`)),
    h('p', { class: 'pn-msg-body' }, a.description),
    progressBar(a.progress, a.target, `${a.name} 进度`),
    h('div', { class: 'pn-row' }, h('small', {}, `${a.progress}/${a.target}`), rewardText ? h('small', {}, `奖励：${rewardText}`) : null,
      a.rewardsClaimed ? h('small', {}, '✔ 已领取') : claimBtn));
  }

  async function load() {
    const q = new URLSearchParams();
    if (state.category !== 'all') q.set('category', state.category);
    if (state.status) q.set('status', state.status);
    try {
      const r = await http(api, 'GET', `/achievements/my?${q}`);
      listEl.replaceChildren(...(r.achievements.length ? r.achievements.map(card) : [emptyState('没有符合条件的成就')]));
      hiddenEl.textContent = r.hiddenLocked ? `还有 ${r.hiddenLocked} 个隐藏成就等待发现……` : '';
      if (focusId) { const el = document.getElementById(`ach-${focusId}`); if (el) el.scrollIntoView({ block: 'center' }); focusId = null; }
    } catch (e) { listEl.replaceChildren(emptyState(e.message)); }
  }

  async function claimAll() {
    try { const r = await http(api, 'POST', '/achievements/claim-all'); if (toast) toast(r.claimed ? `领取了 ${r.claimed} 个成就奖励` : '没有可领取的奖励', 'ok'); load(); loadOverview(); }
    catch (e) { if (toast) toast(e.message, 'err'); }
  }

  loadOverview();
  load();
  return sheet;
}

export async function openLeaderboard({ api }) {
  const sheet = openSheet('成就排行榜', { id: 'achievement-leaderboard' });
  try {
    const r = await http(api, 'GET', '/achievements/leaderboard?limit=50');
    if (r.me) sheet.body.append(h('p', { class: 'pn-card' }, `我的排名：第 ${r.me.rank} 名 · ${r.me.totalPoints} 点`));
    sheet.body.append(h('ol', { class: 'pn-rank' }, ...r.leaderboard.map((x) => h('li', {},
      h('strong', {}, `#${x.rank} ${x.nickname}`), x.activeTitle ? h('span', { class: 'pn-title-tag' }, x.activeTitle.name) : null,
      h('span', {}, ` Lv.${x.level} · ${x.totalPoints} 点 · ${x.achievementsCompleted} 个成就`)))));
  } catch (e) { sheet.body.append(emptyState(e.message)); }
}

export function openTitles({ api, toast }) {
  const sheet = openSheet('我的称号', { id: 'title-manager' });
  const activeEl = h('div', { class: 'pn-card', 'data-testid': 'active-title' });
  const listEl = h('div', { class: 'pn-grid', role: 'list' });
  const catalogEl = h('details', { class: 'pn-card' }, h('summary', {}, '全部称号与获取方式'));
  sheet.body.append(activeEl, listEl, catalogEl);

  async function load() {
    try {
      const [mine, active, bonuses, catalog] = await Promise.all([
        http(api, 'GET', '/users/me/titles'), http(api, 'GET', '/users/me/titles/active'),
        http(api, 'GET', '/users/me/titles/bonuses'), http(api, 'GET', '/users/titles')]);
      const bonusText = Object.entries(bonuses || {}).map(([k, v]) => `${k} +${Math.round(v * 100)}%`).join('、');
      activeEl.replaceChildren(active
        ? h('div', {}, h('span', { class: 'pn-title-tag', style: { color: (active.specialEffects && active.specialEffects.color) || '' } }, active.name),
          ' 佩戴中', bonusText ? h('p', { class: 'pn-hint' }, `加成：${bonusText}`) : null,
          h('button', { type: 'button', class: 'pn-btn', onclick: async () => { await act(() => http(api, 'DELETE', '/users/me/titles/active'), '已取下称号'); } }, '取下'))
        : h('p', {}, '当前没有佩戴称号'));
      listEl.replaceChildren(...(mine.length ? mine.map((t) => h('div', { class: `pn-ach r-${t.rarity}`, role: 'listitem' },
        h('div', { class: 'pn-row' }, h('strong', {}, t.name), h('span', { class: 'pn-pill' }, RARITY_LABEL[t.rarity] || t.rarity)),
        h('p', { class: 'pn-msg-body' }, t.description),
        t.expiresAt ? h('small', {}, `有效期至 ${new Date(t.expiresAt).toLocaleDateString()}`) : null,
        h('div', { class: 'pn-row' },
          t.isActive ? h('small', {}, '✔ 佩戴中') : h('button', { type: 'button', class: 'pn-btn primary', 'data-testid': `wear-${t.titleId}`,
            onclick: () => act(() => http(api, 'PUT', `/users/me/titles/${t.titleId}/activate`), `已佩戴「${t.name}」`) }, '佩戴'),
          h('button', { type: 'button', class: 'pn-btn', 'aria-pressed': String(t.isFavorite),
            onclick: () => act(() => http(api, 'PUT', `/users/me/titles/${t.titleId}/favorite`, { isFavorite: !t.isFavorite })) }, t.isFavorite ? '★' : '☆'))))
        : [emptyState('还没有称号，完成成就即可解锁')]));
      catalogEl.replaceChildren(catalogEl.firstChild, h('ul', {}, ...catalog.map((t) => h('li', {},
        `${t.owned ? '✔ ' : ''}${t.name}（${RARITY_LABEL[t.rarity] || t.rarity}）— ${t.description}`))));
    } catch (e) { listEl.replaceChildren(emptyState(e.message)); }
  }
  async function act(fn, ok) {
    try { await fn(); if (ok && toast) toast(ok, 'ok'); load(); } catch (e) { if (toast) toast(e.message, 'err'); }
  }
  load();
  return sheet;
}
