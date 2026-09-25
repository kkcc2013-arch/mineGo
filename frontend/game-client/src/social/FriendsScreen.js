/**
 * 好友与社交互动界面（REQ-00048 / REQ-00228 / REQ-00326 / REQ-00377 / REQ-00388）
 *
 * 挂载到 index.html 的 #friends 屏幕（底部导航“好友”）。标签页：
 *   好友（列表/在线状态/友情等级/排行榜/详情与送礼/联合任务） 请求（好友码/搜索/审批） 礼物
 *   动态  发现（推荐）  提醒  精灵（精灵隐私设置/精灵好友互动）  隐私（可见性/分组/黑名单/生日）
 * 实时：/ws/friends（好友请求、礼物、升级、在线、隐私变化等推送后自动刷新当前页并提示）
 */
import { api } from '../api/client.js';

const WS_BASE = window.PMG_CONFIG?.wsBase || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const TABS = [
  ['friends', '好友'], ['requests', '请求'], ['gifts', '礼物'], ['feed', '动态'],
  ['discover', '发现'], ['reminders', '提醒'], ['pokemon', '精灵'], ['privacy', '隐私'],
];
const VIS_LABEL = { public: '所有人', friends: '好友', close_friends: '密友', family: '家人', custom: '自定义分组', private: '仅自己' };
const DATA_TYPE_LABEL = {
  profile: '个人资料', online_status: '在线状态', location: '位置', pokemon_collection: '精灵收藏',
  pokemon_stats: '精灵数值', pokemon_shinies: '闪光精灵', friend_list: '好友列表', battle_history: '对战记录',
  achievements: '成就', activity: '动态',
};
const DATA_TYPE_COLUMN = {
  profile: 'profile_visibility', online_status: 'online_status_visibility', location: 'location_visibility',
  pokemon_collection: 'pokemon_collection_visibility', pokemon_stats: 'pokemon_stats_visibility',
  pokemon_shinies: 'pokemon_shinies_visibility', friend_list: 'friend_list_visibility',
  battle_history: 'battle_history_visibility', achievements: 'achievements_visibility', activity: 'activity_visibility',
};
const TOGGLES = {
  allow_friend_requests: '接受好友申请', allow_gifts: '接收礼物', allow_trade_requests: '接受交易请求',
  allow_battle_requests: '接受对战邀请', allow_location_sharing: '共享位置（附近推荐）', searchable: '允许按昵称搜索到我',
  notify_friend_online: '好友上线提醒',
};
const PERM_LABEL = { regular: '普通好友', close_friends: '密友', family: '家人' };
const ONLINE = { online: ['🟢', '在线'], away: ['🟡', '离开'], offline: ['⚪', '离线'], hidden: ['🔒', '已隐藏'] };
const POKEMON_VIS = { public: '公开', friends: '好友可见', private: '仅自己（他人只见外观）', hidden: '完全隐藏' };
const POKEMON_FLAGS = { show_cp: 'CP', show_level: '等级', show_iv: 'IV', show_nature: '性格', show_moves: '招式', show_skills: '技能' };
const INTERACTIONS = { visit: ['🏠', '拜访'], gift: ['🎁', '送礼'], adventure: ['🗺️', '探险'], photo: ['📸', '合影'], training: ['💪', '训练'] };
const REMINDER_TEXT = {
  friend_online: (r) => `${r.related_nickname || r.content.nickname} 上线了`,
  birthday: (r) => `今天是 ${r.related_nickname || r.content.nickname} 的生日 🎂`,
  achievement_unlocked: (r) => `${r.content.nickname} 解锁了成就`,
  gym_invite: (r) => `${r.content.nickname} 邀请你去道馆${r.content.gymName ? `「${r.content.gymName}」` : ''}`,
  gift_received: (r) => `收到 ${r.content.nickname} 的${r.content.giftName || '礼物'}`,
  joint_mission_invite: (r) => `${r.content.nickname} 邀请你一起完成「${r.content.title}」`,
  intimacy_level_up: (r) => `与 ${r.content.nickname} 的${r.content.kind === 'friendship' ? '友情' : '亲密度'}升到 ${r.content.level} 级（${r.content.name}）`,
  long_time_no_see: (r) => `好久没和 ${r.content.nickname} 互动了`,
  friend_request: (r) => `${r.content.nickname} 请求加你为好友`,
  friend_accepted: (r) => `${r.content.nickname} 接受了你的好友请求`,
  pokemon_friend_request: () => '有精灵想和你的精灵做朋友',
  pokemon_friendship_level_up: (r) => `精灵好友升到 ${r.content.level} 级`,
};
const EVENT_TOAST = {
  friend_request_received: (p) => `${p.from?.nickname} 请求加你为好友`,
  friend_request_accepted: (p) => `${p.friend?.nickname} 接受了你的好友请求`,
  gift_received: (p) => `收到${p.from ? ` ${p.from.nickname} 的` : '神秘'}礼物`,
  friendship_level_up: (p) => `与 ${p.nickname} 的友情升到 ${p.level} 级（${p.name}）！`,
  intimacy_level_up: (p) => `与 ${p.nickname} 的亲密度升到 ${p.level} 级`,
  friend_online: (p) => `${p.nickname} 上线了`,
  gym_invite: (p) => `${p.from?.nickname} 邀请你去道馆`,
  joint_mission_invite: (p) => `${p.from?.nickname} 邀请你完成「${p.missionTitle}」`,
  joint_mission_completed: (p) => `联合任务「${p.title}」完成！`,
  pokemon_friend_request: () => '有精灵想和你的精灵做朋友',
  pokemon_friendship_level_up: (p) => `精灵好友升到 ${p.newLevel} 级！`,
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hearts = (lvl) => '❤️'.repeat(Math.max(1, Math.min(5, lvl || 1)));
const fmtTime = (t) => (t ? new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const fmtCd = (s) => (s <= 0 ? '' : s >= 86400 ? `${Math.ceil(s / 86400)}天` : s >= 3600 ? `${Math.ceil(s / 3600)}小时` : `${Math.ceil(s / 60)}分`);

const CSS = `
#friends{padding-bottom:64px}
#friends .fr-top{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
#friends .fr-code{flex:1;min-width:0}
#friends .fr-code b{font-size:16px;letter-spacing:1px}
#friends .fr-code small{display:block;color:var(--muted);font-size:11px}
#friends .fr-bell{position:relative;font-size:22px;cursor:pointer}
#friends .fr-badge{position:absolute;top:-4px;right:-8px;background:var(--red);color:#fff;font-size:10px;border-radius:8px;padding:0 5px;min-width:16px;text-align:center}
#friends .fr-tabs{display:flex;overflow-x:auto;gap:6px;padding:8px 12px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;scrollbar-width:none}
#friends .fr-tab{padding:6px 12px;border-radius:16px;font-size:13px;font-weight:600;color:var(--muted);background:var(--surface2);cursor:pointer;white-space:nowrap;border:none}
#friends .fr-tab.on{background:var(--blue);color:#fff}
#friends .fr-row{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
#friends .fr-input,#friends select,#friends textarea{background:var(--surface);border:1.5px solid var(--border);color:var(--text);padding:9px 12px;border-radius:10px;font-size:14px;outline:none}
#friends .fr-input{flex:1;min-width:120px}
#friends .fr-btn{padding:8px 12px;border-radius:10px;border:none;cursor:pointer;font-size:13px;font-weight:700;background:var(--blue);color:#fff;white-space:nowrap}
#friends .fr-btn.ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
#friends .fr-btn.danger{background:var(--red)}
#friends .fr-btn:disabled{opacity:.45}
#friends .fr-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:8px}
#friends .fr-card h4{font-size:15px;margin-bottom:4px}
#friends .fr-meta{font-size:12px;color:var(--muted);margin-top:2px}
#friends .fr-flex{display:flex;align-items:center;gap:10px}
#friends .fr-grow{flex:1;min-width:0}
#friends .fr-bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px}
#friends .fr-bar i{display:block;height:100%;background:var(--green)}
#friends .fr-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;margin:8px 0}
#friends .fr-kv span:nth-child(odd){color:var(--muted)}
#friends .fr-sec{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin:14px 0 8px}
#friends .fr-toggle{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
#friends .fr-chip{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--surface2);color:var(--muted);margin:2px 4px 0 0}
#friends .fr-empty{text-align:center;color:var(--muted);padding:32px 8px;font-size:14px}
`;

class FriendsScreen {
  constructor(root, toast) {
    this.root = root;
    this.toast = toast || ((m) => console.log(m));
    this.tab = 'friends';
    this.ws = null;
    this.wsRetry = 0;
    this.me = null;
    this.state = {};
    this.render();
  }

  // ── 基础 ────────────────────────────────────────────────────
  async call(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) this.toast(okMsg, 'ok');
      return r;
    } catch (e) {
      this.toast(e.message || '操作失败', 'err');
      return undefined;
    }
  }

  render() {
    if (!document.getElementById('friends-css')) {
      const st = document.createElement('style');
      st.id = 'friends-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root.innerHTML = `
      <div class="fr-top">
        <div class="avatar-circle" aria-hidden="true">🤝</div>
        <div class="fr-code"><small>我的好友码</small><b data-testid="friend-code" id="fr-code">…</b></div>
        <button class="fr-btn ghost" id="fr-copy" aria-label="复制好友码">复制</button>
        <div class="fr-bell" id="fr-bell" role="button" aria-label="提醒" data-testid="friend-reminders-bell">🔔<span class="fr-badge" id="fr-badge" hidden>0</span></div>
      </div>
      <div class="fr-tabs" role="tablist">${TABS.map(([k, v]) => `<button class="fr-tab" role="tab" data-tab="${k}" data-testid="friends-tab-${k}">${v}</button>`).join('')}</div>
      <div class="scroll-area" id="fr-body" data-testid="friends-body"></div>`;
    this.body = this.root.querySelector('#fr-body');
    this.root.querySelectorAll('.fr-tab').forEach((b) => { b.onclick = () => this.show(b.dataset.tab); });
    this.root.querySelector('#fr-bell').onclick = () => this.show('reminders');
    this.root.querySelector('#fr-copy').onclick = () => {
      const code = this.state.code?.friendCode;
      if (code && navigator.clipboard) navigator.clipboard.writeText(code).then(() => this.toast('好友码已复制', 'ok'));
    };
    this.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (el) this.onAction(el.dataset.act, el.dataset, el);
    });
  }

  async open() {
    this.connectWs();
    const code = await this.call(() => api.get('/friends/my-code'));
    if (code) {
      this.state.code = code;
      this.root.querySelector('#fr-code').textContent = code.formatted;
    }
    this.refreshBadge();
    this.show(this.tab);
  }

  async refreshBadge() {
    const r = await api.get('/friends/reminders?unread=true&limit=1').catch(() => null);
    this.setBadge(r ? r.unread : 0);
  }

  setBadge(n) {
    const b = this.root.querySelector('#fr-badge');
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
  }

  show(tab) {
    this.tab = tab;
    this.root.querySelectorAll('.fr-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const fn = {
      friends: () => this.renderFriends(), requests: () => this.renderRequests(), gifts: () => this.renderGifts(),
      feed: () => this.renderFeed(), discover: () => this.renderDiscover(), reminders: () => this.renderReminders(),
      pokemon: () => this.renderPokemon(), privacy: () => this.renderPrivacy(),
    }[tab];
    this.body.innerHTML = '<div class="fr-empty">加载中…</div>';
    return fn && fn();
  }

  // ── WebSocket ───────────────────────────────────────────────
  connectWs() {
    if (this.ws && this.ws.readyState <= 1) return;
    const token = api._accessToken;
    if (!token || typeof WebSocket === 'undefined') return;
    const ws = new WebSocket(`${WS_BASE}/ws/friends?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.wsRetry = 0;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'PING' })); }, 25000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.onEvent(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (!api._accessToken) return;
      const delay = Math.min(30000, 1000 * 2 ** this.wsRetry++);
      setTimeout(() => this.connectWs(), delay);
    };
  }

  onEvent({ type, payload = {} }) {
    if (type === 'connected') { this.setBadge(payload.unreadReminders || 0); return; }
    if (type === 'reminder') { this.refreshBadge(); if (this.tab === 'reminders') this.renderReminders(); return; }
    const text = EVENT_TOAST[type] && EVENT_TOAST[type](payload);
    if (text) this.toast(text, 'ok');
    const refresh = {
      friend_request_received: ['requests'], friend_request_accepted: ['friends', 'requests'], friend_added: ['friends'],
      friend_removed: ['friends'], gift_received: ['gifts', 'friends'], gift_claimed: ['friends'],
      friendship_level_up: ['friends'], intimacy_level_up: ['friends'], friend_online: ['friends'],
      friend_privacy_changed: ['friends', 'feed'], privacy_updated: ['privacy'], pokemon_friend_request: ['pokemon'],
      pokemon_friend_accepted: ['pokemon'], pokemon_friendship_level_up: ['pokemon'],
    }[type] || [];
    if (refresh.includes(this.tab)) this.show(this.tab);
  }

  // ── 好友 ────────────────────────────────────────────────────
  async renderFriends() {
    const sortBy = this.state.sortBy || 'online';
    const lbType = this.state.lbType || 'friendship';
    const [list, lb] = await Promise.all([
      this.call(() => api.get(`/friends?sortBy=${sortBy}&limit=400`)),
      this.call(() => api.get(`/friends/leaderboard?type=${lbType}&limit=10`)),
    ]);
    if (!list) return;
    const opt = (v, t, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`;
    this.body.innerHTML = `
      <div class="fr-row">
        <select data-testid="friend-sort" id="fr-sort">${[['online', '在线优先'], ['last_interaction', '最近互动'], ['friendship_level', '友情等级'], ['name', '名字'], ['level', '训练师等级'], ['favorite', '收藏']].map(([v, t]) => opt(v, t, sortBy)).join('')}</select>
        <span class="fr-meta">${list.pagination.total} / ${list.limits.maxFriends} 位好友</span>
      </div>
      ${list.friends.length ? list.friends.map((f) => {
    const [dot, st] = ONLINE[f.online_status] || ONLINE.offline;
    const pct = f.points_to_next_level ? Math.round(100 * (1 - f.points_to_next_level / (f.points_to_next_level + f.friendship_points))) : 100;
    return `<div class="fr-card" data-testid="friend-item">
          <div class="fr-flex">
            <div class="fr-grow">
              <h4>${f.favorite ? '⭐ ' : ''}${esc(f.remark || f.nickname)} <span class="fr-meta">Lv.${esc(f.level)}</span></h4>
              <div class="fr-meta" title="${st}">${dot} ${st} · ${hearts(f.friendship_level)} ${esc(f.friendship_level_name)} · 亲密度 ${f.intimacy_level} 级（${esc(f.intimacy_level_name)}）${f.pending_gifts ? ` · 🎁×${f.pending_gifts}` : ''}</div>
              <div class="fr-bar" title="距下一级 ${f.points_to_next_level} 点"><i style="width:${pct}%"></i></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <button class="fr-btn" data-act="quick-gift" data-id="${f.id}" ${f.can_send_gift ? '' : 'disabled'} data-testid="friend-gift-btn">送礼</button>
              <button class="fr-btn ghost" data-act="detail" data-id="${f.id}">详情</button>
            </div>
          </div>
        </div>`;
  }).join('') : '<div class="fr-empty">还没有好友，去「请求」页用好友码添加吧</div>'}
      <div class="fr-sec">排行榜</div>
      <div class="fr-row"><select id="fr-lb">${[['friendship', '友情点'], ['level', '训练师等级'], ['xp', '经验'], ['catches', '本周捕捉'], ['global', '全服社交榜']].map(([v, t]) => opt(v, t, lbType)).join('')}</select></div>
      ${(lb?.entries || []).map((e) => `<div class="fr-card fr-flex"><b style="width:28px">#${e.rank}</b><div class="fr-grow">${esc(e.nickname)}${e.is_me ? '（我）' : ''}</div><b>${e.score}</b></div>`).join('') || '<div class="fr-empty">暂无数据</div>'}`;
    this.body.querySelector('#fr-sort').onchange = (e) => { this.state.sortBy = e.target.value; this.renderFriends(); };
    this.body.querySelector('#fr-lb').onchange = (e) => { this.state.lbType = e.target.value; this.renderFriends(); };
  }

  async renderDetail(id) {
    const [d, groups, types, missions] = await Promise.all([
      this.call(() => api.get(`/friends/${id}`)),
      api.get('/privacy/groups').catch(() => []),
      api.get('/friends/gifts/types').catch(() => []),
      api.get(`/friends/${id}/joint-missions`).catch(() => null),
    ]);
    if (!d) return;
    const [dot, st] = ONLINE[d.online_status] || ONLINE.offline;
    const hiddenTxt = '<span class="fr-meta">🔒 未公开</span>';
    this.body.innerHTML = `
      <button class="fr-btn ghost" data-act="back">← 返回</button>
      <div class="fr-card" style="margin-top:10px" data-testid="friend-detail">
        <h4>${esc(d.remark || d.nickname)} ${d.remark ? `<span class="fr-meta">(${esc(d.nickname)})</span>` : ''}</h4>
        <div class="fr-meta">${dot} ${st} · 好友码 ${esc(d.friend_code)}</div>
        <div class="fr-kv">
          <span>友情</span><span>${hearts(d.friendship.level)} ${esc(d.friendship.name)}（${d.friendship.points} 点，距下一级 ${d.friendship.pointsToNext}）</span>
          <span>亲密度</span><span>${d.intimacy.level} 级 ${esc(d.intimacy.name)}</span>
          <span>训练师等级</span><span>${d.level ?? hiddenTxt}</span>
          <span>精灵数</span><span>${d.pokemon_count ?? hiddenTxt}</span>
          <span>成就数</span><span>${d.achievement_count ?? hiddenTxt}</span>
          <span>好友数</span><span>${d.friend_count ?? hiddenTxt}</span>
          <span>位置</span><span>${d.location ? `${d.location.lat.toFixed(3)}, ${d.location.lng.toFixed(3)}` : hiddenTxt}</span>
          <span>生日</span><span>${d.birthday ?? hiddenTxt}</span>
          <span>成为好友</span><span>${fmtTime(d.friends_since)}</span>
        </div>
      </div>
      <div class="fr-sec">送礼</div>
      <div class="fr-card">
        <div class="fr-row">
          <select id="fr-gtype">${types.map((t) => `<option value="${t.code}" ${d.intimacy.level < t.required_intimacy_level ? 'disabled' : ''}>${esc(t.name)}${d.intimacy.level < t.required_intimacy_level ? `（亲密度 ${t.required_intimacy_level} 级解锁）` : ''}</option>`).join('')}</select>
          <input class="fr-input" id="fr-gid" placeholder="道具 ID / 精灵种类 ID（道具、糖果需要）">
          <input class="fr-input" id="fr-gqty" type="number" min="1" value="1" style="max-width:80px">
        </div>
        <div class="fr-row"><input class="fr-input" id="fr-gmsg" maxlength="200" placeholder="祝福语（可选）">
          <label class="fr-meta"><input type="checkbox" id="fr-ganon"> 匿名</label>
          <button class="fr-btn" data-act="send-gift" data-id="${d.id}">赠送</button></div>
      </div>
      <div class="fr-sec">我对 TA 的设置</div>
      <div class="fr-card">
        <div class="fr-row">
          <input class="fr-input" id="fr-remark" maxlength="50" placeholder="备注名" value="${esc(d.remark || '')}">
          <select id="fr-perm">${Object.entries(PERM_LABEL).map(([k, v]) => `<option value="${k}" ${k === d.permission_level ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <select id="fr-group"><option value="">不分组</option>${groups.map((g) => `<option value="${g.id}" ${g.id === d.group_id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
          <label class="fr-meta"><input type="checkbox" id="fr-fav" ${d.favorite ? 'checked' : ''}> 收藏</label>
          <button class="fr-btn" data-act="save-friend" data-id="${d.id}">保存</button>
        </div>
      </div>
      ${missions ? `<div class="fr-sec">联合任务</div>
      ${missions.missions.map((m) => `<div class="fr-card"><div class="fr-flex"><div class="fr-grow"><h4>${esc(m.title)} <span class="fr-chip">${esc(m.difficulty)}</span></h4>
        <div class="fr-meta">${esc(m.description)} · 奖励 ${m.rewards.stardust || 0} 星尘${m.unlocked ? '' : ` · 亲密度 ${m.required_intimacy_level} 级解锁`}</div></div>
        ${m.activeProgressId ? `<button class="fr-btn ghost" data-act="mission-progress" data-id="${m.activeProgressId}" data-friend="${d.id}">查看进度</button>`
    : `<button class="fr-btn" data-act="mission-start" data-id="${m.code}" data-friend="${d.id}" ${m.unlocked ? '' : 'disabled'}>开始</button>`}</div></div>`).join('')}
      ${missions.history.filter((h) => h.status === 'completed' && !h.rewardClaimed).map((h) => `<div class="fr-card fr-flex"><div class="fr-grow">✅ ${esc(h.title)} 已完成</div><button class="fr-btn" data-act="mission-claim" data-id="${h.id}" data-friend="${d.id}">领取奖励</button></div>`).join('')}` : ''}
      <div class="fr-sec">其他</div>
      <div class="fr-row">
        <button class="fr-btn ghost" data-act="invite-gym" data-id="${d.id}">邀请去道馆</button>
        <button class="fr-btn danger" data-act="remove" data-id="${d.id}">删除好友</button>
        <button class="fr-btn danger" data-act="block" data-id="${d.id}">拉黑</button>
      </div>`;
  }

  // ── 请求 / 搜索 ─────────────────────────────────────────────
  async renderRequests() {
    const [pending, sent] = await Promise.all([this.call(() => api.get('/friends/requests/pending')), this.call(() => api.get('/friends/requests/sent'))]);
    this.body.innerHTML = `
      <div class="fr-sec">添加好友</div>
      <div class="fr-row"><input class="fr-input" id="fr-addcode" placeholder="输入 12 位好友码" data-testid="add-friend-code"><button class="fr-btn" data-act="add-code">发送请求</button></div>
      <div class="fr-row"><input class="fr-input" id="fr-search" placeholder="按昵称搜索训练师"><button class="fr-btn ghost" data-act="search">搜索</button></div>
      <div id="fr-search-res"></div>
      <div class="fr-sec">收到的请求（7 天内有效）</div>
      ${(pending?.requests || []).map((r) => `<div class="fr-card" data-testid="friend-request-item"><div class="fr-flex"><div class="fr-grow"><h4>${esc(r.nickname)} <span class="fr-meta">Lv.${esc(r.level)}</span></h4>
        <div class="fr-meta">${esc(r.message || '')} · ${fmtTime(r.created_at)} · ${fmtTime(r.expires_at)} 过期</div></div>
        <button class="fr-btn" data-act="accept" data-id="${r.id}" data-testid="accept-request">接受</button>
        <button class="fr-btn ghost" data-act="reject" data-id="${r.id}">拒绝</button>
        <button class="fr-btn ghost" data-act="ignore" data-id="${r.id}">忽略</button></div></div>`).join('') || '<div class="fr-empty">没有待处理的请求</div>'}
      <div class="fr-sec">我发出的请求</div>
      ${(sent || []).map((r) => `<div class="fr-card fr-flex"><div class="fr-grow">${esc(r.nickname)} <span class="fr-meta">${fmtTime(r.expires_at)} 过期</span></div><button class="fr-btn ghost" data-act="cancel" data-id="${r.id}">撤回</button></div>`).join('') || '<div class="fr-empty">无</div>'}`;
  }

  async doSearch() {
    const q = this.body.querySelector('#fr-search').value.trim();
    const res = await this.call(() => api.get(`/friends/search?q=${encodeURIComponent(q)}`));
    const box = this.body.querySelector('#fr-search-res');
    if (!res) return;
    box.innerHTML = res.map((u) => `<div class="fr-card fr-flex"><div class="fr-grow">${esc(u.nickname)} <span class="fr-meta">Lv.${esc(u.level)}</span></div>
      ${u.is_friend ? '<span class="fr-meta">已是好友</span>' : u.request_status === 'outgoing' ? '<span class="fr-meta">已申请</span>'
    : `<button class="fr-btn" data-act="request" data-id="${u.id}" ${u.accepts_requests ? '' : 'disabled'}>${u.request_status === 'incoming' ? '同意' : '加好友'}</button>`}</div>`).join('') || '<div class="fr-empty">没有找到</div>';
  }

  // ── 礼物 ────────────────────────────────────────────────────
  async renderGifts() {
    const r = await this.call(() => api.get('/friends/gifts/pending?limit=50'));
    if (!r) return;
    this.body.innerHTML = `
      <div class="fr-row"><span class="fr-meta fr-grow">今日已送 ${r.quota.sentToday}/${r.quota.limit}，礼物 30 天内有效</span>
        <button class="fr-btn" data-act="claim-all" ${r.gifts.length ? '' : 'disabled'}>全部打开</button></div>
      ${r.gifts.map((g) => `<div class="fr-card" data-testid="gift-item"><div class="fr-flex"><div class="fr-grow"><h4>🎁 ${esc(g.gift_name || '礼物')}</h4>
        <div class="fr-meta">来自 ${esc(g.from_nickname)}${g.message ? ` ·「${esc(g.message)}」` : ''} · ${fmtTime(g.expires_at)} 过期</div></div>
        <button class="fr-btn" data-act="claim" data-id="${g.id}" data-testid="open-gift">打开</button></div></div>`).join('') || '<div class="fr-empty">没有待打开的礼物</div>'}`;
  }

  // ── 动态 / 发现 / 提醒 ──────────────────────────────────────
  async renderFeed() {
    const r = await this.call(() => api.get('/friends/activities?limit=50'));
    if (!r) return;
    const text = (i) => ({
      catch_pokemon: `捕捉了 ${esc(i.content.name)}${i.content.is_shiny ? ' ✨' : ''}${i.content.cp != null ? `（CP ${i.content.cp}）` : ''}`,
      achievement_unlock: `解锁了成就 ${esc(i.content.name?.zh || i.content.name?.['zh-CN'] || i.content.achievementId)}`,
      friend_add: `和 ${esc(i.content.nickname)} 成为了好友`,
      gift_receive: `收到了${i.content.anonymous ? '神秘' : ''}礼物 ${esc(i.content.giftName || '')}`,
      friendship_level_up: `和 ${esc(i.content.nickname)} 的友情升到 ${i.content.level} 级`,
      joint_mission_complete: `完成了联合任务「${esc(i.content.title)}」`,
    }[i.type] || esc(i.type));
    this.body.innerHTML = r.items.map((i) => `<div class="fr-card fr-flex"><div class="fr-grow"><b>${esc(i.user.nickname)}</b> ${text(i)}
      <div class="fr-meta">${fmtTime(i.createdAt)}</div></div>
      ${i.likable ? `<button class="fr-btn ${i.liked ? '' : 'ghost'}" data-act="like" data-id="${i.activityId}">👍 ${i.likeCount}</button>` : ''}</div>`).join('')
      || '<div class="fr-empty">好友最近没有动态</div>';
  }

  async renderDiscover() {
    const r = await this.call(() => api.get('/friends/recommendations?limit=20'));
    if (!r) return;
    const reason = { mutual_friends: '共同好友', location_nearby: '在你附近', similar_level: '等级相近', similar_pokemon_types: '喜欢同类精灵', active_recently: '最近活跃' };
    this.body.innerHTML = `<div class="fr-row"><span class="fr-meta fr-grow">根据共同好友、位置、等级与精灵偏好推荐</span><button class="fr-btn ghost" data-act="rec-refresh">换一批</button></div>
      ${r.recommendations.map((u) => `<div class="fr-card fr-flex" data-testid="recommendation-item"><div class="fr-grow"><h4>${esc(u.nickname)} <span class="fr-meta">Lv.${esc(u.level)}</span></h4>
        <div>${u.reasons.map((x) => `<span class="fr-chip">${reason[x] || x}</span>`).join('')}${u.mutualFriends ? `<span class="fr-chip">${u.mutualFriends} 位共同好友</span>` : ''}${u.distanceKm != null ? `<span class="fr-chip">约 ${u.distanceKm} km</span>` : ''}</div></div>
        <button class="fr-btn" data-act="request" data-id="${u.userId}" data-source="recommendation">加好友</button>
        <button class="fr-btn ghost" data-act="dismiss" data-id="${u.userId}">✕</button></div>`).join('') || '<div class="fr-empty">暂时没有推荐</div>'}`;
  }

  async renderReminders() {
    const r = await this.call(() => api.get('/friends/reminders?limit=100'));
    if (!r) return;
    this.setBadge(r.unread);
    this.body.innerHTML = `<div class="fr-row"><span class="fr-meta fr-grow">${r.unread} 条未读</span><button class="fr-btn ghost" data-act="read-all">全部已读</button></div>
      ${r.reminders.map((x) => `<div class="fr-card" style="${x.is_read ? 'opacity:.6' : ''}">${esc((REMINDER_TEXT[x.reminder_type] || (() => x.reminder_type))(x))}
        <div class="fr-meta">${fmtTime(x.created_at)}</div></div>`).join('') || '<div class="fr-empty">没有提醒</div>'}`;
  }

  // ── 精灵：隐私 + 精灵好友 ────────────────────────────────────
  async renderPokemon() {
    const [mine, defaults, incoming, friends] = await Promise.all([
      this.call(() => api.get('/pokemon/my?limit=100')),
      api.get('/pokemon/privacy/defaults').catch(() => null),
      api.get('/pokemon/friendships/requests').catch(() => []),
      api.get('/friends?limit=400').catch(() => ({ friends: [] })),
    ]);
    const list = mine?.pokemon || [];
    this.state.myPokemon = list;
    this.state.friendList = friends.friends;
    const sel = this.state.pokemonId && list.some((p) => p.id === this.state.pokemonId) ? this.state.pokemonId : list[0]?.id;
    this.state.pokemonId = sel;
    this.body.innerHTML = `
      ${incoming.length ? `<div class="fr-sec">精灵好友申请</div>${incoming.map((r) => `<div class="fr-card fr-flex"><div class="fr-grow">${esc(r.requester_nickname)} 的 ${esc(r.from_nickname || r.from_species_name)} 想和你的精灵做朋友</div>
        <button class="fr-btn" data-act="pf-accept" data-id="${r.friendship_id}">接受</button><button class="fr-btn ghost" data-act="pf-reject" data-id="${r.friendship_id}">拒绝</button></div>`).join('')}` : ''}
      <div class="fr-sec">默认隐私（新捕捉的精灵自动继承）</div>
      <div class="fr-card" id="fr-pdef">${defaults ? this.pokemonPrivacyForm(defaults, 'def') : '加载失败'}
        <div class="fr-row"><label class="fr-meta"><input type="checkbox" id="fr-def-apply"> 同时应用到我现有的全部精灵</label>
        <button class="fr-btn" data-act="save-defaults">保存默认</button></div></div>
      <div class="fr-sec">我的精灵</div>
      ${list.length ? `<div class="fr-row"><select id="fr-psel">${list.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.nickname || p.name_zh)} CP${p.cp}</option>`).join('')}</select></div>
      <div id="fr-pdetail"><div class="fr-empty">加载中…</div></div>` : '<div class="fr-empty">还没有精灵</div>'}`;
    const s = this.body.querySelector('#fr-psel');
    if (s) s.onchange = (e) => { this.state.pokemonId = e.target.value; this.renderPokemonDetail(); };
    if (sel) this.renderPokemonDetail();
  }

  pokemonPrivacyForm(p, prefix) {
    return `<div class="fr-row"><select id="fr-${prefix}-vis">${Object.entries(POKEMON_VIS).map(([k, v]) => `<option value="${k}" ${k === p.overall_visibility ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label class="fr-meta">好友等级≥<input type="number" min="1" max="5" id="fr-${prefix}-thr" value="${p.friend_level_threshold}" style="width:48px" class="fr-input">可见详情</label></div>
      <div class="fr-row">${Object.entries(POKEMON_FLAGS).map(([k, v]) => `<label class="fr-chip"><input type="checkbox" id="fr-${prefix}-${k}" ${p[k] ? 'checked' : ''}> ${v}</label>`).join('')}
      <label class="fr-chip"><input type="checkbox" id="fr-${prefix}-anon" ${p.battle_anonymous ? 'checked' : ''}> 战斗匿名</label></div>`;
  }

  readPrivacyForm(prefix) {
    const q = (id) => this.body.querySelector(`#fr-${prefix}-${id}`);
    const out = { overall_visibility: q('vis').value, friend_level_threshold: Math.min(5, Math.max(1, parseInt(q('thr').value, 10) || 1)), battle_anonymous: q('anon').checked };
    for (const k of Object.keys(POKEMON_FLAGS)) out[k] = q(k).checked;
    return out;
  }

  async renderPokemonDetail() {
    const id = this.state.pokemonId;
    const box = this.body.querySelector('#fr-pdetail');
    const [priv, pf] = await Promise.all([this.call(() => api.get(`/pokemon/${id}/privacy`)), api.get(`/pokemon/${id}/friends?sortBy=intimacy`).catch(() => null)]);
    if (!priv || !box) return;
    const friendOpts = (this.state.friendList || []).map((f) => `<option value="${f.id}">${esc(f.remark || f.nickname)}</option>`).join('');
    box.innerHTML = `
      <div class="fr-card">${this.pokemonPrivacyForm(priv, 'pk')}
        <div class="fr-row"><span class="fr-meta fr-grow">来源：${{ pokemon: '单独设置', user_default: '默认配置', system_default: '系统默认' }[priv.source]}</span>
          <button class="fr-btn ghost" data-act="batch-privacy">应用到全部精灵</button><button class="fr-btn" data-act="save-pk-privacy">保存</button></div></div>
      <div class="fr-sec">精灵好友</div>
      ${(pf?.friends || []).map((f) => `<div class="fr-card"><div class="fr-flex"><div class="fr-grow"><h4>${esc(f.friendPokemon.nickname || f.friendPokemon.name || '精灵')} <span class="fr-chip">Lv.${f.friendshipLevel}</span></h4>
          <div class="fr-meta">亲密度 ${f.intimacyScore}${f.nextLevelScore ? ` / ${f.nextLevelScore}` : '（满级）'} · 互动 ${f.interactionCount} 次</div>
          <div class="fr-bar"><i style="width:${f.nextLevelScore ? Math.min(100, Math.round(100 * f.intimacyScore / f.nextLevelScore)) : 100}%"></i></div></div>
          <button class="fr-btn ghost" data-act="keepsakes" data-id="${f.friendshipId}">纪念品</button></div>
        <div class="fr-row" style="margin-top:8px">${Object.entries(INTERACTIONS).map(([k, [ic, t]]) => {
    const cd = f.cooldowns ? f.cooldowns[k] : 0;
    return `<button class="fr-btn ${cd ? 'ghost' : ''}" data-act="interact" data-id="${f.friendshipId}" data-type="${k}" ${cd ? 'disabled' : ''}>${ic} ${t}${cd ? ` ${fmtCd(cd)}` : ''}</button>`;
  }).join('')}</div><div id="fr-ks-${f.friendshipId}"></div></div>`).join('') || '<div class="fr-empty">这只精灵还没有朋友</div>'}
      <div class="fr-sec">给这只精灵找朋友</div>
      <div class="fr-row"><select id="fr-pf-friend"><option value="">选择好友</option>${friendOpts}</select><button class="fr-btn ghost" data-act="load-collection">查看 TA 的精灵</button></div>
      <div id="fr-pf-coll"></div>`;
  }

  // ── 隐私 ────────────────────────────────────────────────────
  async renderPrivacy() {
    const [s, groups, blocked] = await Promise.all([
      this.call(() => api.get('/privacy/settings')), api.get('/privacy/groups').catch(() => []), api.get('/privacy/blocked').catch(() => []),
    ]);
    if (!s) return;
    const levels = Object.keys(VIS_LABEL);
    this.body.innerHTML = `
      <div class="fr-sec">谁可以看到</div>
      <div class="fr-card">${Object.entries(DATA_TYPE_LABEL).map(([dt, label]) => `<div class="fr-toggle"><span>${label}</span>
        <select data-col="${DATA_TYPE_COLUMN[dt]}" data-testid="privacy-${dt}">${levels.map((l) => `<option value="${l}" ${s[DATA_TYPE_COLUMN[dt]] === l ? 'selected' : ''}>${VIS_LABEL[l]}</option>`).join('')}</select></div>`).join('')}
        ${groups.length ? `<div class="fr-meta" style="margin-top:8px">选择「自定义分组」时可见的分组：${groups.map((g) => `<label class="fr-chip"><input type="checkbox" class="fr-cg" value="${g.id}" ${Object.values(s.custom_groups || {}).flat().includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('')}</div>` : ''}
      </div>
      <div class="fr-sec">互动开关</div>
      <div class="fr-card">${Object.entries(TOGGLES).map(([k, v]) => `<div class="fr-toggle"><span>${v}</span><input type="checkbox" data-bool="${k}" ${s[k] ? 'checked' : ''}></div>`).join('')}</div>
      <div class="fr-row" style="margin-top:10px"><button class="fr-btn" data-act="save-privacy" data-testid="save-privacy">保存隐私设置</button><span class="fr-meta">修改立即生效，好友端实时刷新</span></div>
      <div class="fr-sec">好友分组</div>
      ${groups.map((g) => `<div class="fr-card fr-flex"><span style="color:${esc(g.color)}">●</span><div class="fr-grow">${esc(g.icon || '')} ${esc(g.name)} <span class="fr-meta">${PERM_LABEL[g.permission_level]} · ${g.member_count} 人</span></div>
        <button class="fr-btn ghost" data-act="del-group" data-id="${g.id}">删除</button></div>`).join('')}
      <div class="fr-row"><input class="fr-input" id="fr-gname" maxlength="50" placeholder="新分组名称"><select id="fr-gperm">${Object.entries(PERM_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <input type="color" id="fr-gcolor" value="#4CAF50"><input class="fr-input" id="fr-gicon" maxlength="10" placeholder="图标" style="max-width:70px"><button class="fr-btn" data-act="add-group">新建</button></div>
      <div class="fr-sec">黑名单</div>
      ${blocked.map((b) => `<div class="fr-card fr-flex"><div class="fr-grow">${esc(b.nickname)}</div><button class="fr-btn ghost" data-act="unblock" data-id="${b.user_id}">解除</button></div>`).join('') || '<div class="fr-empty">黑名单为空</div>'}
      <div class="fr-sec">生日（好友会收到生日提醒）</div>
      <div class="fr-row"><input class="fr-input" type="date" id="fr-bday"><button class="fr-btn ghost" data-act="save-bday">保存</button></div>`;
  }

  // ── 操作 ────────────────────────────────────────────────────
  async onAction(act, ds) {
    const v = (id) => this.body.querySelector(id)?.value;
    switch (act) {
      case 'back': return this.show('friends');
      case 'detail': return this.renderDetail(ds.id);
      case 'quick-gift':
        if (await this.call(() => api.post(`/friends/${ds.id}/gift`, {}), '礼物已送出')) this.renderFriends();
        return undefined;
      case 'send-gift': {
        const body = { giftType: v('#fr-gtype'), giftId: v('#fr-gid') || undefined, quantity: parseInt(v('#fr-gqty'), 10) || 1, message: v('#fr-gmsg') || undefined, anonymous: this.body.querySelector('#fr-ganon').checked };
        return this.call(() => api.post(`/friends/${ds.id}/gift`, body), '礼物已送出');
      }
      case 'save-friend': {
        const gid = v('#fr-group');
        const body = { nickname: v('#fr-remark') || null, permissionLevel: v('#fr-perm'), groupId: gid ? parseInt(gid, 10) : null, favorite: this.body.querySelector('#fr-fav').checked };
        return this.call(() => api.patch(`/friends/${ds.id}`, body), '已保存');
      }
      case 'remove':
        if (!confirm('确定删除该好友？友情等级将清零')) return undefined;
        if (await this.call(() => api.del(`/friends/${ds.id}`), '已删除好友')) this.show('friends');
        return undefined;
      case 'block':
        if (!confirm('拉黑后将解除好友关系，对方无法再向你发送请求，确定？')) return undefined;
        if (await this.call(() => api.post(`/privacy/block/${ds.id}`, {}), '已拉黑')) this.show('friends');
        return undefined;
      case 'invite-gym': return this.call(() => api.post(`/friends/${ds.id}/invite`, { type: 'gym' }), '邀请已发送');
      case 'mission-start':
        if (await this.call(() => api.post(`/friends/${ds.friend}/joint-missions`, { missionId: ds.id }), '任务已开始，已邀请好友')) this.renderDetail(ds.friend);
        return undefined;
      case 'mission-progress': {
        const p = await this.call(() => api.get(`/friends/joint-missions/${ds.id}`));
        if (p) this.toast(`${p.title}：${p.progress.current}/${p.progress.target}（${p.status === 'completed' ? '已完成' : '进行中'}）`, 'ok');
        if (p && p.status === 'completed') this.renderDetail(ds.friend);
        return undefined;
      }
      case 'mission-claim':
        if (await this.call(() => api.post(`/friends/joint-missions/${ds.id}/claim`), '奖励已领取')) this.renderDetail(ds.friend);
        return undefined;
      case 'add-code': {
        const code = v('#fr-addcode').trim();
        if (await this.call(() => api.post('/friends/add-by-code', { friendCode: code }), '好友请求已发送')) this.renderRequests();
        return undefined;
      }
      case 'search': return this.doSearch();
      case 'request': {
        const r = await this.call(() => api.post('/friends/request', { toUserId: ds.id, source: ds.source || 'search' }));
        if (r) this.toast(r.autoAccepted ? '你们已成为好友' : '好友请求已发送', 'ok');
        return this.tab === 'discover' ? this.renderDiscover() : this.doSearch();
      }
      case 'accept': case 'reject': case 'ignore':
        if (await this.call(() => api.post(`/friends/request/${ds.id}/${act}`), { accept: '已成为好友', reject: '已拒绝', ignore: '已忽略' }[act])) this.renderRequests();
        return undefined;
      case 'cancel':
        if (await this.call(() => api.del(`/friends/request/${ds.id}`), '已撤回')) this.renderRequests();
        return undefined;
      case 'claim': {
        const r = await this.call(() => api.post(`/friends/gifts/${ds.id}/claim`));
        if (r) this.toast(`获得 ${r.items.map((i) => `${i.type}×${i.qty}`).join('、')}，友情点 +${r.pointsEarned}`, 'ok');
        return this.renderGifts();
      }
      case 'claim-all': {
        const r = await this.call(() => api.post('/friends/gifts/claim-all'));
        if (r) this.toast(`打开了 ${r.claimed} 个礼物`, 'ok');
        return this.renderGifts();
      }
      case 'like':
        await this.call(() => api.post(`/friends/activities/${ds.id}/like`));
        return this.renderFeed();
      case 'rec-refresh': {
        const r = await this.call(() => api.get('/friends/recommendations?refresh=true&limit=20'));
        return r && this.renderDiscover();
      }
      case 'dismiss':
        await this.call(() => api.post(`/friends/recommendations/${ds.id}/dismiss`));
        return this.renderDiscover();
      case 'read-all':
        await this.call(() => api.post('/friends/reminders/read', {}));
        return this.renderReminders();
      case 'save-privacy': {
        const body = {};
        this.body.querySelectorAll('select[data-col]').forEach((s) => { body[s.dataset.col] = s.value; });
        this.body.querySelectorAll('input[data-bool]').forEach((c) => { body[c.dataset.bool] = c.checked; });
        const groups = [...this.body.querySelectorAll('.fr-cg:checked')].map((c) => parseInt(c.value, 10));
        body.custom_groups = {};
        for (const [dt, col] of Object.entries(DATA_TYPE_COLUMN)) if (body[col] === 'custom') body.custom_groups[dt] = groups;
        if (await this.call(() => api.patch('/privacy/settings', body), '隐私设置已生效')) this.renderPrivacy();
        return undefined;
      }
      case 'add-group': {
        const body = { name: v('#fr-gname'), permissionLevel: v('#fr-gperm'), color: v('#fr-gcolor'), icon: v('#fr-gicon') || undefined };
        if (await this.call(() => api.post('/privacy/groups', body), '分组已创建')) this.renderPrivacy();
        return undefined;
      }
      case 'del-group':
        if (await this.call(() => api.del(`/privacy/groups/${ds.id}`), '分组已删除')) this.renderPrivacy();
        return undefined;
      case 'unblock':
        if (await this.call(() => api.del(`/privacy/block/${ds.id}`), '已解除拉黑')) this.renderPrivacy();
        return undefined;
      case 'save-bday': return this.call(() => api.request('PUT', '/friends/me/profile', { birthday: v('#fr-bday') || null }), '生日已保存');
      case 'save-defaults': {
        const body = { ...this.readPrivacyForm('def'), applyToExisting: this.body.querySelector('#fr-def-apply').checked };
        return this.call(() => api.request('PUT', '/pokemon/privacy/defaults', body), '默认隐私已保存');
      }
      case 'save-pk-privacy':
        if (await this.call(() => api.request('PUT', `/pokemon/${this.state.pokemonId}/privacy`, this.readPrivacyForm('pk')), '精灵隐私已保存')) this.renderPokemonDetail();
        return undefined;
      case 'batch-privacy': {
        const ids = (this.state.myPokemon || []).map((p) => p.id);
        const r = await this.call(() => api.post('/pokemon/privacy/batch', { pokemon_ids: ids, settings: this.readPrivacyForm('pk') }));
        if (r) this.toast(`已更新 ${r.updated_count} 只精灵`, 'ok');
        return undefined;
      }
      case 'interact': {
        const r = await this.call(() => api.post(`/pokemon/friendships/${ds.id}/interact`, { type: ds.type }));
        if (r) this.toast(`亲密度 +${r.intimacyGained}${r.levelsGained.length ? `，升到 ${r.friendshipLevel} 级！` : ''}${r.keepsake ? '，获得纪念品' : ''}`, 'ok');
        return this.renderPokemonDetail();
      }
      case 'keepsakes': {
        const r = await this.call(() => api.get(`/pokemon/friendships/${ds.id}/keepsakes`));
        const box = this.body.querySelector(`#fr-ks-${ds.id}`);
        if (r && box) box.innerHTML = r.keepsakes.map((k) => `<span class="fr-chip">${esc(k.keepsake_data?.title || k.keepsake_type)} · ${esc(k.rarity)}</span>`).join('') || '<span class="fr-meta">暂无纪念品</span>';
        return undefined;
      }
      case 'pf-accept': case 'pf-reject':
        if (await this.call(() => api.request('PUT', `/pokemon/friendships/${ds.id}/status`, { action: act === 'pf-accept' ? 'accept' : 'reject' }), act === 'pf-accept' ? '它们成为朋友了' : '已拒绝')) this.renderPokemon();
        return undefined;
      case 'load-collection': {
        const fid = v('#fr-pf-friend');
        if (!fid) return undefined;
        const r = await this.call(() => api.get(`/pokemon/users/${fid}/collection?limit=50`));
        const box = this.body.querySelector('#fr-pf-coll');
        if (r && box) {
          box.innerHTML = r.pokemon.map((p) => `<div class="fr-card fr-flex"><div class="fr-grow">${esc(p.nickname || p.name)} ${p.cp != null ? `CP${p.cp}` : '<span class="fr-meta">🔒</span>'}</div>
            <button class="fr-btn" data-act="pf-request" data-id="${p.id}">做朋友</button></div>`).join('') || '<div class="fr-empty">TA 没有公开的精灵</div>';
        }
        return undefined;
      }
      case 'pf-request':
        return this.call(() => api.post(`/pokemon/${this.state.pokemonId}/friend-request`, { friendPokemonId: ds.id }), '申请已发送');
      default: return undefined;
    }
  }
}

let instance = null;

/** 显示好友界面（首次调用时创建） */
export function showFriends(toast) {
  const root = document.getElementById('friends');
  if (!root) return null;
  if (!instance) instance = new FriendsScreen(root, toast);
  instance.open();
  return instance;
}

export { FriendsScreen };
