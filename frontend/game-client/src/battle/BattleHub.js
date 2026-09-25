// frontend/game-client/src/battle/BattleHub.js
// 「对战」页：道馆挑战入口、团战（实时 WebSocket）、竞技联赛、战斗回放、连击（图鉴/练习/连招预设）、技能推荐、AI/画质设置
'use strict';

import { BattleClient, TEAM_LABEL, LEAGUE_LABEL, escapeHtml as esc } from './BattleClient.js';
import { BattleView, monEmoji, renderShare } from './BattleView.js';
import { ReplayPlayer } from './ReplayPlayer.js';

const TABS = [
  ['gyms', '🏟️ 道馆'], ['raids', '👹 团战'], ['league', '🏅 联赛'], ['replays', '🎬 回放'],
  ['combos', '🔗 连击'], ['moves', '📘 技能'], ['settings', '⚙️ 设置'],
];
const DEFAULT_POS = { lat: 31.2304, lng: 121.4737 };

export class BattleHub {
  constructor({ api, frc, toast, locMgr }) {
    this.client = new BattleClient(api);
    this.frc = frc;
    this.toast = toast || (() => {});
    this.locMgr = locMgr || null;
    this.tab = 'gyms';
    this.view = new BattleView({ client: this.client, frc, toast: this.toast, onClose: () => this.refresh(), openReplay: (id) => this.openReplay(id) });
    this.raidWs = null;
    this.myPokemonCache = null;
  }

  // ── 页面骨架 ────────────────────────────────────────────────
  mount() {
    if (document.getElementById('battle')) return;
    const s = document.createElement('div');
    s.className = 'screen';
    s.id = 'battle';
    s.dataset.testid = 'battle-screen';
    s.innerHTML = `<div class="topbar"><div class="avatar-circle" aria-hidden="true">⚔️</div>
        <div class="user-info"><div class="user-name">对战</div><div class="user-lvl" data-hub="sub">道馆 · 团战 · 联赛</div></div></div>
      <div class="bt-tabs" role="tablist">${TABS.map(([k, n]) => `<div class="bt-tab ${k === this.tab ? 'on' : ''}" role="tab" tabindex="0" data-tab="${k}">${n}</div>`).join('')}</div>
      <div class="bt-body" data-hub="body"></div>`;
    s.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { this.tab = t.dataset.tab; this.refresh(); }
    });
    document.body.insertBefore(s, document.getElementById('nav'));
    this.root = s;
  }

  body() { return this.root.querySelector('[data-hub="body"]'); }

  pos() {
    const p = this.locMgr && this.locMgr.currentPosition;
    return p && Number.isFinite(p.lat) ? { lat: p.lat, lng: p.lng } : DEFAULT_POS;
  }

  show(tab) { if (tab) this.tab = tab; this.refresh(); }

  async refresh() {
    if (!this.root) return;
    this.root.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('on', t.dataset.tab === this.tab));
    const body = this.body();
    body.innerHTML = '<div class="spin"></div>';
    try {
      await this[`render_${this.tab}`](body);
    } catch (e) {
      body.innerHTML = `<div class="empty-box"><div class="empty-icon">⚠️</div><div class="empty-txt">${esc(e.message || '加载失败')}</div></div>`;
    }
  }

  async myPokemon(force = false) {
    if (!this.myPokemonCache || force) this.myPokemonCache = ((await this.client.myPokemon(60)) || {}).pokemon || [];
    return this.myPokemonCache;
  }

  sheet(html, onClick) {
    const s = document.createElement('div');
    s.className = 'bt-result';
    s.innerHTML = `<div class="bt-card">${html}<button class="bt-btn ghost" style="width:100%;margin-top:8px" data-close>关闭</button></div>`;
    s.addEventListener('click', (e) => {
      if (e.target === s || e.target.closest('[data-close]')) { s.remove(); if (s.onClose) s.onClose(); return; }
      if (onClick) onClick(e, s);
    });
    document.body.appendChild(s);
    return s;
  }

  pokemonPicker(list, { max = 6, selected = [] } = {}) {
    return `<div class="bt-muted" style="margin:6px 0">选择出战精灵（最多 ${max} 只，按点选顺序出场）</div>
      <div class="bt-pick">${list.map((p) => `<div class="bt-card ${selected.includes(p.id) ? 'sel' : ''}" data-pick="${esc(p.id)}" ${p.defending_gym_id ? 'aria-disabled="true" style="opacity:.4"' : ''}>
        <div>${monEmoji(p.species_id)} <b>${esc(p.nickname || p.name_zh)}</b></div>
        <div class="bt-muted">CP ${p.cp} · ${esc([p.type1, p.type2].filter(Boolean).join('/'))}${p.defending_gym_id ? ' · 驻守中' : ''}</div></div>`).join('')}</div>`;
  }

  bindPicker(sheet, selected, max) {
    sheet.addEventListener('click', (e) => {
      const c = e.target.closest('[data-pick]');
      if (!c || c.getAttribute('aria-disabled')) return;
      const id = c.dataset.pick;
      const i = selected.indexOf(id);
      if (i >= 0) selected.splice(i, 1);
      else if (selected.length < max) selected.push(id);
      else { this.toast(`最多选择 ${max} 只`, 'err'); return; }
      c.classList.toggle('sel', selected.includes(id));
    });
  }

  // ── 道馆 ───────────────────────────────────────────────────
  async render_gyms(body) {
    const { lat, lng } = this.pos();
    const [data, hist] = await Promise.all([this.client.nearbyGyms(lat, lng, 3000), this.client.gymHistory().catch(() => ({ battles: [] }))]);
    const gyms = data.gyms || [];
    body.innerHTML = `<div class="sec-title">附近道馆（${gyms.length}）</div>
      ${gyms.map((g) => `<div class="entity-card" data-gym="${esc(g.id)}"><div class="entity-icon">🏟️</div>
        <div class="entity-info"><div class="entity-name">${esc(g.name)}</div>
        <div class="entity-meta">${TEAM_LABEL[g.controllingTeam] || '⚪ 无人占领'} · ${g.defenderCount} 只驻守 · ${g.distanceM}m${g.raid ? ` · 👹 团战 Lv.${g.raid.level}` : ''}</div></div>
        <div class="entity-right">›</div></div>`).join('') || '<div class="bt-muted">附近 3 公里内没有道馆</div>'}
      <div class="sec-title" style="margin-top:16px">我的道馆对战</div>
      ${(hist.battles || []).slice(0, 10).map((b) => `<div class="bt-card bt-row"><div class="bt-grow"><b>${esc(b.gym_name)}</b>
        <div class="bt-muted">${b.result === 'WIN' ? '胜' : '负'} · ${b.turns_played} 回合 · 击败 ${b.defenders_defeated}/${b.defenders_total} · +${b.experience_gained} XP</div></div>
        ${b.replay_id ? `<button class="bt-btn ghost" data-replay="${b.replay_id}">回放</button>` : ''}</div>`).join('') || '<div class="bt-muted">还没有对战记录</div>'}`;
    body.onclick = (e) => {
      const g = e.target.closest('[data-gym]');
      if (g) return this.openGym(g.dataset.gym);
      const r = e.target.closest('[data-replay]');
      if (r) this.openReplay(r.dataset.replay);
    };
  }

  async openGym(gymId) {
    try {
      const [gym, mine] = await Promise.all([this.client.gym(gymId), this.myPokemon(true)]);
      const selected = [];
      const s = this.sheet(`<div class="bt-h">🏟️ ${esc(gym.name)}</div>
        <div class="bt-muted">${TEAM_LABEL[gym.controlling_team] || '⚪ 无人占领'} · 声望 ${gym.prestige}</div>
        <div style="margin:8px 0">${(gym.defenders || []).map((d) => `<span class="bt-chip">${monEmoji(d.speciesId)} ${esc(d.nickname || d.speciesName)} CP${d.cp} · 士气 ${Math.round((d.hpCurrent / Math.max(1, d.hpMax)) * 100)}%</span>`).join('') || '<span class="bt-muted">无人驻守</span>'}</div>
        ${this.pokemonPicker(mine, { max: 6 })}
        <div class="bt-row" style="margin-top:8px;flex-wrap:wrap">
          <button class="bt-btn" data-g="start">⚔️ 开始挑战</button>
          <button class="bt-btn ghost" data-g="lineup">🤖 AI 推荐阵容</button>
          <button class="bt-btn ghost" data-g="defend">🛡️ 派驻所选第 1 只</button>
        </div><div class="bt-muted" data-g-info></div>`, async (e, sh) => {
        const b = e.target.closest('[data-g]');
        if (!b) return;
        try {
          if (b.dataset.g === 'lineup') {
            const lu = await this.client.lineup({ gymId });
            selected.splice(0, selected.length, ...lu.pokemonIds);
            sh.querySelectorAll('[data-pick]').forEach((c) => c.classList.toggle('sel', selected.includes(c.dataset.pick)));
            sh.querySelector('[data-g-info]').textContent = `AI 阵容预测胜率 ${Math.round(lu.prediction.winProbability * 100)}%：${lu.team.map((t) => `${t.order}.${t.name}（${t.reasons[0]}）`).join('；')}`;
          } else if (b.dataset.g === 'defend') {
            if (!selected.length) return this.toast('请先选择一只精灵', 'err');
            const r = await this.client.defend(gymId, selected[0]);
            this.toast(`✅ ${r.message}`, 'ok');
            sh.remove();
            this.refresh();
          } else if (b.dataset.g === 'start') {
            if (!selected.length) return this.toast('请至少选择一只精灵', 'err');
            const start = await this.client.startGymBattle(gymId, selected);
            sh.remove();
            this.view.open(start, { title: `挑战 ${gym.name}` });
          }
        } catch (err) {
          if (err.code === 'BATTLE_IN_PROGRESS') this.toast('你有一场未结束的战斗，10 分钟内可继续或认输', 'err');
          else this.toast(err.message || '操作失败', 'err');
        }
      });
      this.bindPicker(s, selected, 6);
    } catch (e) { this.toast(e.message || '道馆加载失败', 'err'); }
  }

  // ── 团战 ───────────────────────────────────────────────────
  async render_raids(body) {
    const { lat, lng } = this.pos();
    const data = await this.client.nearbyRaids(lat, lng, 5000);
    const raids = data.raids || [];
    body.innerHTML = `<div class="sec-title">附近团战（${raids.length}）</div>
      ${raids.map((r) => `<div class="entity-card" data-raid="${esc(r.id)}"><div class="entity-icon">${monEmoji(r.boss.speciesId)}</div>
        <div class="entity-info"><div class="entity-name">Lv.${r.level} ${esc(r.boss.name)} · ${esc(r.gymName)}</div>
        <div class="entity-meta">${r.status === 'ACTIVE' ? `HP ${r.bossHpCurrent}/${r.bossHpMax}` : '即将开始'} · ${r.participantCount} 人 · ${r.distanceM}m · 剩余 ${Math.max(0, Math.round((new Date(r.endsAt) - Date.now()) / 60000))} 分钟</div></div>
        <div class="entity-right">›</div></div>`).join('') || '<div class="bt-muted">附近 5 公里内暂无团战</div>'}`;
    body.onclick = (e) => { const r = e.target.closest('[data-raid]'); if (r) this.openRaid(r.dataset.raid); };
  }

  async openRaid(raidId) {
    let raid;
    try { raid = await this.client.raid(raidId); } catch (e) { this.toast(e.message, 'err'); return; }
    const s = this.sheet(`<div class="bt-h">👹 Lv.${raid.level} ${esc(raid.boss.name)}</div>
      <div class="bt-muted">${esc(raid.gymName)} · CP ${raid.boss.cp} · 弱点：${(raid.boss.weakTo || []).map((w) => `${w.type}×${w.multiplier.toFixed(2)}`).join(' ')}</div>
      <div class="bt-hp" style="margin:8px 0"><i data-raid-hp style="transform:scaleX(${raid.bossHpCurrent / Math.max(1, raid.bossHpMax)});background:var(--red)"></i></div>
      <div class="bt-muted" data-raid-hptext>HP ${raid.bossHpCurrent}/${raid.bossHpMax}</div>
      <div data-raid-main></div><div class="bt-log" data-raid-log style="max-height:140px"></div>`);
    s.onClose = () => this.closeRaidWs();
    const main = s.querySelector('[data-raid-main]');
    const log = (t) => { const l = s.querySelector('[data-raid-log]'); if (!l) return; const d = document.createElement('div'); d.textContent = t; l.appendChild(d); l.scrollTop = l.scrollHeight; };
    const setHp = (hp) => { const b = s.querySelector('[data-raid-hp]'); if (b) b.style.transform = `scaleX(${Math.max(0, hp) / Math.max(1, raid.bossHpMax)})`; const t = s.querySelector('[data-raid-hptext]'); if (t) t.textContent = `HP ${Math.max(0, hp)}/${raid.bossHpMax}`; };

    const enterFight = async (activePokemonId) => {
      const en = await this.client.energy(activePokemonId);
      let energy = 0;
      let readyAt = 0;
      main.innerHTML = `<div class="bt-muted">出战：${esc(en.name)} · 能量 <b data-raid-energy>0</b>/${en.maxEnergy}</div>
        <div class="bt-moves" style="padding:6px 0">${en.moves.map((m) => `<button class="bt-move ${m.category === 'CHARGE' ? 'charge' : ''}" data-raid-move="${esc(m.id)}" data-cost="${m.energyCost}">
          <div class="nm">${esc(m.name)}</div><div class="meta">${m.category === 'CHARGE' ? `-${m.energyCost}⚡` : `+${m.energyGain}⚡`}</div></button>`).join('')}</div>`;
      const refreshButtons = () => {
        main.querySelectorAll('[data-raid-move]').forEach((b) => { b.disabled = Date.now() < readyAt || energy < Number(b.dataset.cost); });
        const e = main.querySelector('[data-raid-energy]'); if (e) e.textContent = String(energy);
      };
      refreshButtons();
      const onResult = (r) => {
        energy = r.energy;
        readyAt = Date.now() + (r.nextAttackInMs || 500);
        setTimeout(refreshButtons, (r.nextAttackInMs || 500) + 20);
        refreshButtons();
        log(`你造成 ${r.damage} 伤害${r.effectivenessText ? `（${r.effectivenessText}）` : ''}${r.isCritical ? ' 会心一击' : ''}${r.combo ? ` 🔗${r.combo.name}` : ''}`);
        if (r.combo) this.view.comboEffect(r.combo);
      };
      const ws = this.connectRaidWs(raidId, {
        onResult,
        onBroadcast: (m) => {
          if (m.type === 'RAID_ATTACK') { setHp(m.bossHpRemaining); }
          if (m.type === 'RAID_COMPLETED') { log('🎉 Boss 已被击败！'); this.showRaidResult(raidId, main); }
        },
        onError: (m) => this.toast(m.message, 'err'),
      });
      main.onclick = async (e) => {
        const b = e.target.closest('[data-raid-move]');
        if (!b || b.disabled) return;
        readyAt = Date.now() + 400; refreshButtons();
        try {
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ATTACK', moveId: b.dataset.raidMove, requestId: String(Date.now()) }));
          else { const r = await this.client.raidAttack(raidId, b.dataset.raidMove); onResult(r); setHp(r.bossHpRemaining); if (r.bossDefeated) this.showRaidResult(raidId, main); }
        } catch (err) { this.toast(err.message, 'err'); readyAt = 0; refreshButtons(); }
      };
    };

    if (raid.me && raid.me.joined) return enterFight(raid.me.activePokemonId);
    main.innerHTML = '<button class="bt-btn" data-join style="width:100%">加入团战（自动选择 CP 最高的 6 只）</button>';
    main.onclick = async (e) => {
      if (!e.target.closest('[data-join]')) return;
      try {
        const j = await this.client.joinRaid(raidId);
        log(`已加入，出战队伍：${j.team.map((t) => t.name).join('、')}`);
        enterFight(j.activePokemonId);
      } catch (err) { this.toast(err.message, 'err'); }
    };
  }

  connectRaidWs(raidId, { onResult, onBroadcast, onError }) {
    this.closeRaidWs();
    const token = localStorage.getItem('pmg_access_token');
    const base = (window.PMG_CONFIG && window.PMG_CONFIG.wsBase) || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    try {
      const ws = new WebSocket(`${base}/ws/raid?token=${encodeURIComponent(token || '')}&raidId=${encodeURIComponent(raidId)}`);
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'ATTACK_RESULT') onResult(m);
        else if (m.type === 'ERROR') onError(m);
        else onBroadcast(m);
      };
      this.raidWs = ws;
      return ws;
    } catch { return null; }
  }

  closeRaidWs() { if (this.raidWs) { try { this.raidWs.close(1000); } catch { /* ignore */ } this.raidWs = null; } }

  async showRaidResult(raidId, el) {
    try {
      const r = await this.client.raidResult(raidId);
      el.innerHTML = `<div class="bt-h">伤害排行</div>${r.participants.map((p) => `<div class="bt-muted">${p.rank}. ${esc(p.nickname)} ${p.damage} 伤害${p.rewards ? ` · +${p.rewards.xp}XP +${p.rewards.stardust}星尘` : ''}${p.me ? '（我）' : ''}</div>`).join('')}`;
    } catch { /* 结算尚未完成 */ }
  }

  // ── 联赛 ───────────────────────────────────────────────────
  async render_league(body) {
    const [me, rewards, matches] = await Promise.all([this.client.leagueMe(), this.client.leagueRewards(), this.client.leagueMatches()]);
    const board = await this.client.leagueBoard(me.level, me.group);
    const days = Math.floor(me.season.remainingMs / 86400e3);
    const hours = Math.floor((me.season.remainingMs % 86400e3) / 3600e3);
    const pending = (rewards.rewards || []).filter((r) => !r.claimed);
    body.innerHTML = `<div class="bt-card"><div class="bt-h">🏅 ${esc(LEAGUE_LABEL[me.level] || me.level)} ${esc(me.group)} · ${me.points} 分</div>
        <div class="bt-muted">评分 ${me.rating} · ${me.wins} 胜 ${me.losses} 负 · 连胜 ${me.consecutiveWins}${me.nextTier ? ` · 距 ${LEAGUE_LABEL[me.nextTier.level]} ${me.nextTier.group} 还差 ${me.nextTier.pointsNeeded} 分` : ''}</div>
        <div class="bt-muted">第 ${me.season.number} 赛季 · 剩余 ${days} 天 ${hours} 小时</div>
        <div class="bt-row" style="margin-top:8px"><button class="bt-btn" data-l="match">⚔️ 开始匹配</button><button class="bt-btn ghost" data-l="defense">🛡️ 设置防守队伍</button></div></div>
      ${pending.length ? `<div class="bt-card"><div class="bt-h">待领取奖励</div>${pending.map((r) => `<div class="bt-row"><span class="bt-grow">${esc(r.reward_type)} · ${r.reward_data.coins || 0} 金币 ${r.reward_data.stardust || 0} 星尘${r.reward_data.equipment ? ` · 装备 ${esc(r.reward_data.equipment)}` : ''}</span><button class="bt-btn" data-claim="${r.id}">领取</button></div>`).join('')}</div>` : ''}
      <div class="sec-title">排行榜 · ${esc(LEAGUE_LABEL[board.level])} ${esc(board.group)}</div>
      <div class="bt-card">${board.players.slice(0, 100).map((p) => `<div class="bt-row"><span style="width:28px">${p.rank}</span><span class="bt-grow">${esc(p.nickname)}</span><span class="bt-muted">${p.points} 分 · ${p.rating}</span></div>`).join('') || '<span class="bt-muted">暂无</span>'}</div>
      <div class="sec-title">最近对局</div>
      ${(matches.matches || []).slice(0, 10).map((m) => `<div class="bt-card bt-row"><div class="bt-grow">${m.result === 'win' ? '胜' : '负'} vs ${esc(m.opponent || '')} <span class="bt-muted">${m.pointsChange >= 0 ? '+' : ''}${m.pointsChange} 分 · 评分 ${m.ratingChange >= 0 ? '+' : ''}${m.ratingChange}</span></div>${m.replayId ? `<button class="bt-btn ghost" data-replay="${m.replayId}">回放</button>` : ''}</div>`).join('') || '<div class="bt-muted">还没有对局</div>'}`;
    body.onclick = async (e) => {
      const b = e.target.closest('[data-l],[data-claim],[data-replay]');
      if (!b) return;
      try {
        if (b.dataset.replay) return this.openReplay(b.dataset.replay);
        if (b.dataset.claim) { const r = await this.client.claimLeagueReward(b.dataset.claim); this.toast(`🎁 +${r.granted.coins} 金币 +${r.granted.stardust} 星尘`, 'ok'); return this.refresh(); }
        if (b.dataset.l === 'match') {
          const m = await this.client.leagueMatch();
          this.view.open(m, { title: `联赛 vs ${m.opponent.name}（评分 ${m.opponent.rating}）` });
        }
        if (b.dataset.l === 'defense') {
          const mine = await this.myPokemon(true);
          const sel = [];
          const s = this.sheet(`<div class="bt-h">联赛防守队伍（1-3 只）</div>${this.pokemonPicker(mine, { max: 3 })}<button class="bt-btn" style="width:100%;margin-top:8px" data-save>保存</button>`, async (ev, sh) => {
            if (!ev.target.closest('[data-save]')) return;
            try { await this.client.setDefenseTeam(sel); this.toast('已保存防守队伍', 'ok'); sh.remove(); } catch (err) { this.toast(err.message, 'err'); }
          });
          this.bindPicker(s, sel, 3);
        }
      } catch (err) {
        if (err.code === 'BATTLE_IN_PROGRESS') this.toast('你有一场未结束的战斗', 'err'); else this.toast(err.message || '操作失败', 'err');
      }
    };
  }

  // ── 回放 ───────────────────────────────────────────────────
  async render_replays(body) {
    const [mine, hot] = await Promise.all([this.client.myReplays(), this.client.hotReplays('views')]);
    const row = (r) => `<div class="bt-card bt-row" data-replay="${r.replayId}"><div class="bt-grow"><b>${r.result === 'win' ? '🏆' : '⚔️'} ${esc((r.summary && (r.summary.gymName || r.summary.opponentName)) || r.battleType)}</b>
      <div class="bt-muted">${esc(r.attackerNickname || '')} · ${r.turns} 回合 · 👁 ${r.viewCount} ❤ ${r.likeCount}</div></div><span>›</span></div>`;
    body.innerHTML = `<div class="bt-row" style="margin-bottom:10px"><input class="form-input bt-grow" data-q placeholder="按玩家昵称搜索" style="padding:9px 12px"><button class="bt-btn" data-search>搜索</button></div>
      <div data-results></div>
      <div class="sec-title">我的回放</div>${(mine.replays || []).map(row).join('') || '<div class="bt-muted">暂无</div>'}
      <div class="sec-title" style="margin-top:14px">热门回放</div>${(hot.replays || []).map(row).join('') || '<div class="bt-muted">暂无</div>'}`;
    body.onclick = async (e) => {
      if (e.target.closest('[data-search]')) {
        const q = body.querySelector('[data-q]').value.trim();
        const r = await this.client.searchReplays({ nickname: q }).catch((err) => { this.toast(err.message, 'err'); return { replays: [] }; });
        body.querySelector('[data-results]').innerHTML = `<div class="sec-title">搜索结果</div>${(r.replays || []).map(row).join('') || '<div class="bt-muted">没有找到</div>'}`;
        return;
      }
      const r = e.target.closest('[data-replay]');
      if (r) this.openReplay(r.dataset.replay);
    };
  }

  async openReplay(replayId) {
    try {
      const data = await this.client.replay(replayId);
      const s = this.sheet('<div data-player></div><div class="bt-row" style="flex-wrap:wrap"><button class="bt-btn ghost" data-like>❤ 点赞</button><button class="bt-btn ghost" data-share>分享</button></div><div data-share-box></div><div data-comments></div>', async (e, sh) => {
        try {
          if (e.target.closest('[data-like]')) { const r = await this.client.like(replayId); this.toast(r.liked ? `已点赞（${r.likeCount}）` : '已取消点赞', 'ok'); }
          if (e.target.closest('[data-share]')) sh.querySelector('[data-share-box]').innerHTML = renderShare(await this.client.share(replayId, { platform: 'link' }));
          if (e.target.closest('[data-send]')) {
            const inp = sh.querySelector('[data-comment]');
            await this.client.comment(replayId, inp.value);
            inp.value = '';
            loadComments();
          }
        } catch (err) { this.toast(err.message, 'err'); }
      });
      const player = new ReplayPlayer(s.querySelector('[data-player]'), data, { frc: this.frc, emoji: monEmoji });
      const prevClose = s.onClose;
      s.onClose = () => { player.destroy(); if (prevClose) prevClose(); };
      const loadComments = async () => {
        const c = await this.client.comments(replayId).catch(() => ({ comments: [] }));
        s.querySelector('[data-comments]').innerHTML = `<div class="sec-title" style="margin-top:10px">评论</div>${(c.comments || []).map((x) => `<div class="bt-muted">${esc(x.nickname)}：${esc(x.comment)}</div>`).join('')}
          <div class="bt-row" style="margin-top:6px"><input class="form-input bt-grow" data-comment maxlength="500" placeholder="说点什么" style="padding:8px 10px"><button class="bt-btn" data-send>发送</button></div>`;
      };
      loadComments();
    } catch (e) { this.toast(e.message || '回放加载失败', 'err'); }
  }

  // ── 连击 ───────────────────────────────────────────────────
  async render_combos(body) {
    const [chains, stats, board, presets] = await Promise.all([this.client.chains(), this.client.comboStats(), this.client.comboLeaderboard(), this.client.presets()]);
    body.innerHTML = `<div class="bt-card"><div class="bt-h">我的连击</div><div class="bt-muted">共 ${stats.totals.combos} 次 · 完美 ${stats.totals.perfect} · 连击点 ${stats.totals.points}</div></div>
      <div class="sec-title">我的连招预设</div>
      ${(presets.presets || []).map((p) => `<div class="bt-card bt-row"><div class="bt-grow"><b>${p.isDefault ? '⭐ ' : ''}${esc(p.name)}</b><div class="bt-muted">${p.steps.map((s) => esc(s.moveId)).join(' → ')} · 使用 ${p.stats.uses} 次 · 触发连击 ${p.stats.combosTriggered}</div></div><button class="bt-btn ghost" data-del-preset="${esc(p.id)}">删除</button></div>`).join('') || '<div class="bt-muted">还没有连招预设</div>'}
      <button class="bt-btn ghost" data-new-preset style="margin:6px 0 12px">＋ 为精灵创建连招</button>
      <div class="sec-title">连击图鉴（${chains.chains.length}）</div>
      ${chains.chains.map((c) => `<div class="bt-card"><div class="bt-row"><b class="bt-grow">${esc(c.name)} ×${c.damageMultiplier}</b>${c.unlocked ? `<button class="bt-btn ghost" data-practice="${esc(c.chainId)}">练习</button>` : `<span class="bt-chip">Lv.${c.minTrainerLevel} 解锁</span>`}</div>
        <div class="bt-muted">${c.sequence.map((s) => esc(s.name)).join(' → ')} · ${c.timeWindowMs / 1000}s 内${c.element ? ` · 需 ${esc(c.element)} 属性` : ''} · ${esc(c.description)}</div></div>`).join('')}
      <div class="sec-title">连击排行</div><div class="bt-card">${board.leaderboard.slice(0, 20).map((r) => `<div class="bt-row"><span style="width:28px">${r.rank}</span><span class="bt-grow">${esc(r.nickname)}</span><span class="bt-muted">${r.points} 点 · 完美 ${r.perfect}</span></div>`).join('') || '<span class="bt-muted">暂无</span>'}</div>`;
    body.onclick = async (e) => {
      const pr = e.target.closest('[data-practice]');
      if (pr) return this.practice(chains.chains.find((c) => c.chainId === pr.dataset.practice));
      const del = e.target.closest('[data-del-preset]');
      if (del) { await this.client.deletePreset(del.dataset.delPreset).catch((err) => this.toast(err.message, 'err')); return this.refresh(); }
      if (e.target.closest('[data-new-preset]')) this.newPreset();
    };
  }

  /** 练习模式：按顺序点击技能，客户端记录点击时刻，服务端按时间窗口判定 */
  practice(chain) {
    const steps = [];
    let t0 = 0;
    const s = this.sheet(`<div class="bt-h">练习：${esc(chain.name)}</div><div class="bt-muted">在 ${chain.timeWindowMs / 1000} 秒内依次点击：${chain.sequence.map((x) => esc(x.name)).join(' → ')}</div>
      <div class="bt-moves" style="padding:8px 0">${[...new Map(chain.sequence.map((x) => [x.moveId, x])).values()].map((x) => `<button class="bt-move" data-pm="${esc(x.moveId)}"><div class="nm">${esc(x.name)}</div></button>`).join('')}</div>
      <div data-pr></div>`, async (e, sh) => {
      const b = e.target.closest('[data-pm]');
      if (!b) return;
      if (!steps.length) t0 = performance.now();
      steps.push({ moveId: b.dataset.pm, atMs: Math.round(performance.now() - t0) });
      if (steps.length < chain.sequence.length) return;
      try {
        const r = await this.client.practice(chain.chainId, steps);
        sh.querySelector('[data-pr]').innerHTML = r.success ? `<b style="color:var(--yellow)">成功！质量 ${esc(r.quality)} · 倍率 ×${r.multiplier}</b>` : '<b>未触发，注意顺序和时间窗口</b>';
        if (r.success) this.view.comboEffect({ name: chain.name, multiplier: r.multiplier, quality: r.quality });
      } catch (err) { this.toast(err.message, 'err'); }
      steps.length = 0;
    });
    return s;
  }

  async newPreset() {
    const mine = await this.myPokemon();
    const s = this.sheet(`<div class="bt-h">创建连招（2-5 步）</div>
      <select class="form-input" data-pp style="margin-bottom:8px">${mine.map((p) => `<option value="${esc(p.id)}">${esc(p.nickname || p.name_zh)} CP${p.cp}</option>`).join('')}</select>
      <div data-pmoves></div><div class="bt-muted" data-psteps>步骤：</div>
      <input class="form-input" data-pname maxlength="30" placeholder="连招名称" style="margin:8px 0">
      <button class="bt-btn" data-psave style="width:100%">保存</button>`, async (e, sh) => {
      const add = e.target.closest('[data-padd]');
      if (add && steps.length < 5) { steps.push({ moveId: add.dataset.padd, delayMs: steps.length ? 300 : 0 }); drawSteps(); }
      if (e.target.closest('[data-psave]')) {
        try {
          await this.client.createPreset({ pokemonId: sh.querySelector('[data-pp]').value, name: sh.querySelector('[data-pname]').value || '我的连招', steps });
          this.toast('已保存', 'ok'); sh.remove(); this.refresh();
        } catch (err) { this.toast(err.message, 'err'); }
      }
    });
    const steps = [];
    const drawSteps = () => { s.querySelector('[data-psteps]').textContent = `步骤：${steps.map((x) => x.moveId).join(' → ')}`; };
    const loadMoves = async () => {
      steps.length = 0; drawSteps();
      const en = await this.client.energy(s.querySelector('[data-pp]').value).catch(() => ({ moves: [] }));
      s.querySelector('[data-pmoves]').innerHTML = en.moves.map((m) => `<button class="bt-btn ghost" data-padd="${esc(m.id)}" style="margin:2px">${esc(m.name)}</button>`).join('');
    };
    s.querySelector('[data-pp]').addEventListener('change', loadMoves);
    loadMoves();
  }

  // ── 技能推荐 / 冷却 / 装备 ────────────────────────────────────
  async render_moves(body) {
    const [mine, prefs] = await Promise.all([this.myPokemon(), this.client.recoPrefs()]);
    body.innerHTML = `<div class="bt-row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <select class="form-input bt-grow" data-mp style="padding:8px">${mine.map((p) => `<option value="${esc(p.id)}" data-species="${p.species_id}">${esc(p.nickname || p.name_zh)} CP${p.cp}</option>`).join('')}</select>
        <select class="form-input" data-sc style="padding:8px;width:auto">${['pve', 'pvp', 'gym', 'raid'].map((x) => `<option ${x === prefs.scenario ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <select class="form-input" data-st style="padding:8px;width:auto">${['balanced', 'dps', 'tank', 'energy'].map((x) => `<option ${x === prefs.style ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </div><div data-reco></div><div data-cd></div>`;
    const load = async () => {
      const sel = body.querySelector('[data-mp]');
      if (!sel || !sel.value) { body.querySelector('[data-reco]').innerHTML = '<div class="bt-muted">还没有精灵</div>'; return; }
      const species = sel.selectedOptions[0].dataset.species;
      const scenario = body.querySelector('[data-sc]').value;
      const style = body.querySelector('[data-st]').value;
      this.client.saveRecoPrefs({ scenario, style }).catch(() => {});
      const [reco, cds, eq, combos] = await Promise.all([
        this.client.recommendations(species, scenario, style), this.client.cooldowns(sel.value, scenario === 'pvp' ? 'PVP' : scenario === 'raid' ? 'RAID' : 'PVE'),
        this.client.equipment(), this.client.comboRecommend(sel.value).catch(() => ({ ready: [], nearlyReady: [] })),
      ]);
      body.querySelector('[data-reco]').innerHTML = `<div class="sec-title">推荐技能组合（${esc(reco.scenario)} · 样本 ${reco.dataSamples}）</div>
        ${reco.recommendations.map((r) => `<div class="bt-card"><div class="bt-row"><span class="bt-chip">${esc(r.grade)}</span><b class="bt-grow">${esc(r.fastMove.name)} + ${esc(r.chargeMove ? r.chargeMove.name : '—')}</b><span class="bt-muted">${r.score}</span></div>
          <div class="bt-muted">${r.reasons.map(esc).join('；')}</div></div>`).join('')}
        ${combos.ready.length || combos.nearlyReady.length ? `<div class="sec-title">可用连击</div>${combos.ready.map((c) => `<span class="bt-chip">✅ ${esc(c.name)}</span>`).join('')}${combos.nearlyReady.map((c) => `<div class="bt-muted">· ${esc(c.suggestion)}</div>`).join('')}` : ''}`;
      body.querySelector('[data-cd]').innerHTML = `<div class="sec-title">冷却（${esc(cds.mode)}，缩减上限 ${Math.round(cds.maxReduction * 100)}%）</div>
        ${cds.moves.map((m) => `<div class="bt-card"><b>${esc(m.name)}</b> <span class="bt-muted">${m.baseCooldownMs}ms → ${m.cooldownMs}ms（${m.cooldownTurns} 回合，-${Math.round(m.reduction * 100)}%）</span>
          <div class="bt-muted">熟练度 -${Math.round(m.breakdown.mastery * 100)}% · 速度 -${Math.round(m.breakdown.speed * 100)}% · 装备 -${Math.round(m.breakdown.equipment * 100)}% · 天气 ×${m.breakdown.weatherFactor}</div></div>`).join('')}
        ${cds.tips.map((t) => `<div class="bt-muted">💡 ${esc(t)}</div>`).join('')}
        <div class="sec-title" style="margin-top:10px">冷却装备</div>
        ${(eq.items || []).map((it) => `<div class="bt-card bt-row"><span class="bt-grow">${esc(it.name_zh)} <span class="bt-muted">-${it.reduction_pct}% ${esc(it.applies_to)}${it.move_type ? ` ${esc(it.move_type)}` : ''}${it.pokemon_id ? ' · 已装备' : ''}</span></span><button class="bt-btn ghost" data-equip="${esc(it.id)}">装备到当前精灵</button></div>`).join('') || '<div class="bt-muted">暂无装备（联赛晋级与赛季奖励可获得）</div>'}`;
    };
    body.onchange = () => load().catch((e) => this.toast(e.message, 'err'));
    body.onclick = async (e) => {
      const b = e.target.closest('[data-equip]');
      if (!b) return;
      try { await this.client.equip(b.dataset.equip, body.querySelector('[data-mp]').value); this.toast('已装备', 'ok'); load(); } catch (err) { this.toast(err.message, 'err'); }
    };
    await load();
  }

  // ── 设置 ───────────────────────────────────────────────────
  async render_settings(body) {
    const p = await this.client.aiPrefs();
    const f = this.frc;
    body.innerHTML = `<div class="bt-card"><div class="bt-h">🤖 AI 策略助手</div>
        <label class="bt-row"><input type="checkbox" data-ai="newbieMode" ${p.newbie_mode ? 'checked' : ''}> 新手引导模式（战斗中自动显示建议）</label>
        <label class="bt-row"><input type="checkbox" data-ai="autoAdvice" ${p.auto_advice ? 'checked' : ''}> 自动建议</label>
        <label class="bt-row">风格 <select data-ai="style" class="form-input" style="width:auto;padding:6px">${['balanced', 'aggressive', 'defensive'].map((x) => `<option ${x === p.style ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <button class="bt-btn" data-ai-save style="margin-top:8px">保存</button></div>
      <div class="bt-card"><div class="bt-h">🎞️ 战斗画质</div>
        <div class="bt-muted">设备档位：${esc(f.tier)} · 目标帧率 ${f.targetFps} FPS · 特效 ${esc(f.effects)} · 粒子上限 ${f.particleLimit}</div>
        <div class="bt-muted">画质会根据实测帧率自动升降（低端 30 / 中端 45 / 高端 60 FPS），性能数据匿名上报用于优化。</div></div>`;
    body.onclick = async (e) => {
      if (!e.target.closest('[data-ai-save]')) return;
      const q = (k) => body.querySelector(`[data-ai="${k}"]`);
      try {
        await this.client.saveAiPrefs({ newbieMode: q('newbieMode').checked, autoAdvice: q('autoAdvice').checked, style: q('style').value });
        this.toast('已保存', 'ok');
      } catch (err) { this.toast(err.message, 'err'); }
    };
  }
}
