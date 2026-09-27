// frontend/game-client/src/features/profileNotify.js
// Epic E05（成就/称号/资料卡/收藏室）+ E13（消息中心/实时通知）客户端入口，由 src/bootstrap/features.js 注册。
//
// - 底部导航追加"消息"🔔（未读徽章），登录后建立 WebSocket 实时通知
// - "我的"页追加"成长与收藏"卡片：成就、称号、资料卡、收藏室、热门收藏室、消息设置
// - 消息深度链接（pmg:navigate）→ 打开对应面板
// - window.PMG_PROFILE：供其他模块（好友列表、排行榜）打开玩家资料/参观收藏室
import { h, loadStyles, http } from './profile-notify/core.js';
import { createMessageCenter } from './profile-notify/messageCenter.js';
import { openAchievements, openTitles } from './profile-notify/achievements.js';
import { openMyProfile, openPlayerProfile, openCollectors } from './profile-notify/profileCard.js';
import { openMyRoom, openVisit, openPopularRooms } from './profile-notify/collectionRoom.js';

export function initProfileNotify(ctx = {}) {
  const { api } = ctx;
  const toast = ctx.toast || window.toast || ((m) => console.log(m));
  if (!api || document.getElementById('growth-card')) return { enabled: false };
  loadStyles();
  const c = { api, toast };
  const messages = createMessageCenter(c);

  // ── "我的"页入口 ────────────────────────────────────────────
  const profile = document.getElementById('profile');
  if (profile) {
    const row = (icon, label, onclick, testid) => h('div', { class: 'inv-row pn-entry', role: 'button', tabindex: '0', 'data-testid': testid, onclick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } } },
    h('div', { class: 'inv-icon', 'aria-hidden': 'true' }, icon), h('div', { class: 'inv-name' }, label), h('div', { class: 'inv-qty' }, '›'));
    const card = h('section', { id: 'growth-card', class: 'inv-card', 'aria-labelledby': 'growth-title', 'data-testid': 'growth-card' },
      h('h2', { id: 'growth-title', class: 'inv-header' }, '成长与收藏'),
      row('🏆', '成就', () => openAchievements(c), 'open-achievements'),
      row('🎖️', '称号', () => openTitles(c), 'open-titles'),
      row('🪪', '资料卡', () => openMyProfile(c), 'open-profile-card'),
      row('🏛️', '我的收藏室', () => openMyRoom(c), 'open-collection-room'),
      row('🌟', '热门收藏室', () => openPopularRooms(c), 'open-popular-rooms'),
      row('📊', '收藏家排行', () => openCollectors(c), 'open-collectors'),
      row('🔔', '消息与通知设置', () => messages.openPreferences(), 'open-notification-settings'));
    const logout = profile.querySelector('.logout-wrap');
    if (logout) profile.insertBefore(card, logout); else profile.append(card);
  }

  // ── 登录状态：导航栏出现即视为已登录 ───────────────────────
  const nav = document.getElementById('nav');
  const sync = () => { if (nav && nav.classList.contains('show') && api._accessToken) messages.start(); };
  if (nav) new MutationObserver(sync).observe(nav, { attributes: true, attributeFilter: ['class'] });
  sync();
  window.addEventListener('pmg:logout', () => messages.stop());

  // ── 深度链接 ────────────────────────────────────────────────
  window.addEventListener('pmg:navigate', async (e) => {
    const url = String((e.detail && e.detail.actionUrl) || '');
    const data = (e.detail && e.detail.data) || {};
    if (url.startsWith('/achievements')) openAchievements(c, { focusId: url.split('/')[2] });
    else if (url.startsWith('/titles')) openTitles(c);
    else if (url.startsWith('/collection-room')) openMyRoom(c); // 被点赞/留言/升级/获得装饰：都是自己的收藏室
    else if (url.startsWith('/rewards/level-ups')) {
      try { await http(api, 'POST', '/rewards/level-ups/claim'); toast('升级奖励已领取', 'ok'); } catch (err) { toast(err.message, 'err'); }
    } else if (url.startsWith('/map') && window.goScreen) window.goScreen('map');
    else if (url.startsWith('/friends') || url.startsWith('/trades')) {
      if (data.fromUserId) openPlayerProfile(c, data.fromUserId);
      else if (window.goScreen) window.goScreen('profile');
    } else if (url.startsWith('/events')) toast('活动进行中，快去地图上参与吧！', 'ok');
    else if (url.startsWith('/profile/')) openPlayerProfile(c, url.split('/')[2]);
  });

  window.PMG_PROFILE = {
    openPlayerProfile: (userId) => openPlayerProfile(c, userId),
    visitRoom: (userId) => openVisit(c, { userId }),
    openMessages: (tab) => messages.open(tab),
  };
  return { enabled: true, features: ['achievements', 'titles', 'profile-card', 'collection-room', 'message-center'] };
}
