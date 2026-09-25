// frontend/game-client/src/battle/BattleView.js
// 对战场景（道馆挑战 / 联赛对局共用）：服务端计算结果，客户端只提交技能 ID 并按本地节奏播放动画。
//   - HP/能量条用 FrameRateController 补间（与网络延迟无关，200ms RTT 下依然连续）
//   - EnergyBar：能量百分比 + 各蓄力技能的能量刻度（REQ-00112）
//   - MoveCooldownIndicator：技能按钮显示能量消耗/回复、剩余冷却回合、能量不足提示（REQ-00112 / 00299）
//   - 连击提示：下一步技能高亮与剩余时间窗口；触发时连击特效 + 震动反馈（REQ-00143 / 00288 / 00364）
//   - AI 助手：推荐技能与理由、胜率、一键执行、有用/无用反馈；新手模式自动显示（REQ-00357 / 00365）
//   - 一键连招：执行当前精灵的连招预设（REQ-00143）
//   - 结算：奖励、联赛积分、精彩时刻、战后复盘、回放与分享（REQ-00379 / 00469）
'use strict';

import { moveButtonState, energyBarModel, hpColor, describeAction, escapeHtml as esc } from './BattleClient.js';

const EMOJI = { 1: '🌿', 2: '🌿', 3: '🦎', 4: '🔥', 5: '🔥', 6: '🐲', 7: '🐢', 8: '🐢', 9: '🐢', 25: '⚡', 26: '⚡', 39: '🎀', 40: '🎀', 52: '🐱', 53: '🐈', 54: '🦆', 55: '🦆', 74: '🪨', 75: '🪨', 79: '😴', 80: '😴', 94: '👻', 131: '🦕', 133: '🦊', 143: '😪', 144: '🧊', 145: '⚡', 146: '🔥', 150: '🧬', 151: '🧬' };
export const monEmoji = (sid) => EMOJI[sid] || '🐾';
const TYPE_COLOR = { fire: '#ff7a45', water: '#3d8ef8', grass: '#2ecc71', electric: '#f4c430', ice: '#8fe3ff', psychic: '#ff5fa2', ghost: '#9b59b6', dragon: '#7c5cff', dark: '#6b5a4a', fairy: '#ffb3de', fighting: '#d35400', poison: '#a55eea', ground: '#c9a05a', rock: '#a38b5c', steel: '#95a5a6', bug: '#9bbf2f', flying: '#89aaff', normal: '#bbb' };

export class BattleView {
  constructor({ client, frc, toast, onClose, openReplay }) {
    this.client = client;
    this.frc = frc;
    this.toast = toast || (() => {});
    this.onClose = onClose || (() => {});
    this.openReplay = openReplay || (() => {});
    this.root = null;
    this.state = null;
    this.advice = null;
    this.busy = false;
    this.presets = [];
    this.shown = { attacker: { hp: 0, energy: 0 }, defender: { hp: 0 } };
    this.hintTimer = null;
  }

  /** @param start 开战接口返回 { battleId, battle, prediction, advice, gym?, opponent? } */
  open(start, { title = '对战' } = {}) {
    this.close(true);
    this.battleId = start.battleId || start.battle.battleId;
    this.title = title;
    this.prediction = start.prediction || null;
    this.root = document.createElement('div');
    this.root.className = 'bt-arena';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', title);
    this.root.dataset.testid = 'battle-arena';
    document.body.appendChild(this.root);
    this.frc.start(this.battleId);
    this.layout();
    this.apply(start.battle, start.advice, true);
    this.log(`⚔️ ${title} 开始！${this.prediction ? `AI 预测胜率 ${Math.round(this.prediction.winProbability * 100)}%` : ''}`);
    this.loadPresets();
  }

  close(silent = false) {
    if (this.hintTimer) clearInterval(this.hintTimer);
    this.hintTimer = null;
    if (this.root) this.root.remove();
    this.root = null;
    if (!silent) {
      this.frc.flush();
      this.onClose();
    }
  }

  layout() {
    this.root.innerHTML = `
      <div class="bt-arena-top">
        <button class="bt-btn ghost" data-act="exit" aria-label="离开">←</button>
        <div class="bt-grow"><div class="bt-h" style="margin:0">${esc(this.title)}</div><div class="bt-muted" data-el="turn">第 0 回合</div></div>
        <div class="bt-muted" data-el="winprob"></div>
      </div>
      <div class="bt-side" data-side="defender">
        <div class="bt-mon"><div class="bt-grow">
          <div class="bt-row"><b data-el="def-name"></b><span class="bt-muted" data-el="def-meta"></span></div>
          <div class="bt-hp" role="progressbar" aria-label="对手 HP"><i data-el="def-hp"></i></div>
          <div class="bt-muted" data-el="def-hptext"></div>
        </div><div class="bt-mon-sprite" data-el="def-sprite" aria-hidden="true"></div></div>
      </div>
      <div class="bt-side" data-side="attacker">
        <div class="bt-mon"><div class="bt-mon-sprite" data-el="att-sprite" aria-hidden="true"></div><div class="bt-grow">
          <div class="bt-row"><b data-el="att-name"></b><span class="bt-muted" data-el="att-meta"></span></div>
          <div class="bt-hp" role="progressbar" aria-label="我方 HP"><i data-el="att-hp"></i></div>
          <div class="bt-energy" aria-label="能量" data-el="energy"><i data-el="energy-fill" style="width:0%"></i></div>
          <div class="bt-muted" data-el="att-hptext"></div>
        </div></div>
      </div>
      <div class="bt-hints" data-el="hints" aria-live="polite"></div>
      <div class="bt-moves" data-el="moves"></div>
      <div class="bt-advisor" data-el="advisor" hidden></div>
      <div class="bt-log" data-el="log" aria-live="polite"></div>
      <div class="bt-actions">
        <button class="bt-btn ghost" data-act="advice">🤖 AI 建议</button>
        <button class="bt-btn ghost" data-act="auto">⚡ 一键执行推荐</button>
        <button class="bt-btn ghost" data-act="switch">🔄 换人</button>
        <button class="bt-btn ghost" data-act="combo">🔗 一键连招</button>
        <button class="bt-btn warn" data-act="forfeit">🏳️ 认输</button>
      </div>`;
    this.root.addEventListener('click', (e) => this.onClick(e));
  }

  el(name) { return this.root && this.root.querySelector(`[data-el="${name}"]`); }

  onClick(e) {
    const btn = e.target.closest('[data-act],[data-move],[data-switch],[data-preset],[data-fb]');
    if (!btn || !this.root) return;
    if (btn.dataset.move) return this.act(() => this.client.turn(this.battleId, btn.dataset.move));
    if (btn.dataset.switch) return this.act(() => this.client.switchTo(this.battleId, btn.dataset.switch));
    if (btn.dataset.preset) return this.act(() => this.client.combo(this.battleId, btn.dataset.preset));
    if (btn.dataset.fb) {
      const id = this.advice && this.advice.adviceId;
      if (id) this.client.feedback(id, btn.dataset.fb === 'up').then(() => this.toast('感谢反馈', 'ok')).catch(() => {});
      return;
    }
    switch (btn.dataset.act) {
      case 'exit': return this.confirmExit();
      case 'advice': return this.requestAdvice();
      case 'auto': return this.act(() => this.client.useAdvice(this.battleId));
      case 'switch': return this.showSwitch();
      case 'combo': return this.showPresets();
      case 'forfeit': if (confirm('确定认输？')) this.act(() => this.client.forfeit(this.battleId)); return;
      default:
    }
  }

  confirmExit() {
    if (this.state && this.state.status === 'active' && !confirm('战斗仍在进行，10 分钟内可回来继续。确定离开？')) return;
    this.close();
  }

  async act(fn) {
    if (this.busy) return;
    this.busy = true;
    this.setButtonsDisabled(true);
    try {
      const res = await fn();
      await this.playTurns(res.turns || (res.turn ? [res.turn] : []));
      this.apply(res.battle, res.advice);
      if (res.result) this.showResult(res.result);
      else if (res.stoppedReason && res.stoppedReason !== 'BATTLE_ENDED' && res.executedSteps < res.totalSteps) {
        this.toast(`连招在第 ${res.executedSteps + 1} 步中止（${res.stoppedReason}）`, '');
      }
    } catch (e) {
      this.toast(e.message || '操作失败', 'err');
    } finally {
      this.busy = false;
      this.setButtonsDisabled(false);
    }
  }

  setButtonsDisabled(d) {
    if (!this.root) return;
    const ended = !!(this.state && this.state.status !== 'active');
    this.root.querySelectorAll('.bt-actions button').forEach((b) => { b.disabled = d || ended; });
    if (d) this.root.querySelectorAll('.bt-moves button').forEach((b) => { b.disabled = true; });
    else if (this.state) this.renderMoves();
  }

  /** 按回合依次播放事件动画（本地节奏，与网络往返解耦） */
  async playTurns(turns) {
    for (const t of turns) {
      if (this.el('turn')) this.el('turn').textContent = `第 ${t.turn} 回合`;
      for (const a of t.actions || []) {
        const line = describeAction(a);
        if (line) this.log(line, a.combo ? 'combo' : a.actor === 'defender' ? 'enemy' : '');
        if (a.type === 'attack' && !a.missed) {
          const targetSide = a.actor === 'attacker' ? 'defender' : 'attacker';
          this.hitEffect(targetSide, a.moveType, a.isCritical || !!a.combo);
          if (a.combo) this.comboEffect(a.combo);
          if (a.targetMaxHp) this.animateHp(targetSide, a.targetHp, a.targetMaxHp);
          if (a.actor === 'attacker' && a.energy !== undefined) this.animateEnergy(a.energy);
        }
        if (a.type === 'faint') this.el(a.side === 'attacker' ? 'att-sprite' : 'def-sprite')?.classList.add('faint');
        await wait(this.frc.effects === 'low' ? 150 : 320);
      }
    }
  }

  apply(battle, advice, first = false) {
    if (!battle || !this.root) return;
    this.state = battle;
    if (advice) this.advice = advice;
    const a = battle.attacker.active;
    const d = battle.defender.active;
    this.el('turn').textContent = `第 ${battle.turn} 回合`;
    this.el('att-name').textContent = a.name;
    this.el('att-meta').textContent = ` CP ${a.cp} · ${a.types.join('/')}`;
    this.el('def-name').textContent = d.name;
    this.el('def-meta').textContent = ` CP ${d.cp} · ${d.types.join('/')} · 剩余 ${battle.defender.remaining}/${battle.defender.total}`;
    const as = this.el('att-sprite');
    const ds = this.el('def-sprite');
    as.textContent = monEmoji(a.speciesId);
    ds.textContent = monEmoji(d.speciesId);
    as.classList.toggle('faint', a.fainted);
    ds.classList.toggle('faint', d.fainted);
    if (first || this.shown.attackerId !== a.pokemonId) { this.shown.attacker.hp = a.hp; this.setHp('attacker', a.hp, a.maxHp); }
    else this.animateHp('attacker', a.hp, a.maxHp);
    if (first || this.shown.defenderId !== d.pokemonId) { this.shown.defender.hp = d.hp; this.setHp('defender', d.hp, d.maxHp); }
    else this.animateHp('defender', d.hp, d.maxHp);
    this.shown.attackerId = a.pokemonId;
    this.shown.defenderId = d.pokemonId;
    this.animateEnergy(a.energy, a.maxEnergy);
    this.renderMoves();
    this.renderHints();
    this.renderAdvisor();
    if (this.prediction) this.el('winprob').textContent = `胜率 ${Math.round(this.prediction.winProbability * 100)}%`;
  }

  setHp(side, hp, maxHp) {
    const bar = this.el(side === 'attacker' ? 'att-hp' : 'def-hp');
    const txt = this.el(side === 'attacker' ? 'att-hptext' : 'def-hptext');
    if (!bar) return;
    const r = maxHp > 0 ? Math.max(0, hp) / maxHp : 0;
    bar.style.transform = `scaleX(${r})`;
    bar.style.backgroundColor = hpColor(hp, maxHp);
    bar.parentElement.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    if (txt) txt.textContent = `HP ${Math.max(0, Math.round(hp))}/${maxHp}`;
  }

  animateHp(side, hp, maxHp) {
    const from = this.shown[side].hp;
    this.shown[side].hp = hp;
    if (from === hp) return this.setHp(side, hp, maxHp);
    this.frc.tween(from, hp, this.frc.effects === 'low' ? 200 : 450, (v) => this.setHp(side, v, maxHp));
  }

  animateEnergy(energy, maxEnergy) {
    if (maxEnergy) this.shown.attacker.maxEnergy = maxEnergy;
    const max = this.shown.attacker.maxEnergy || 100;
    const from = this.shown.attacker.energy || 0;
    this.shown.attacker.energy = energy;
    const moves = (this.state && this.state.attacker.active.moves) || [];
    const model = energyBarModel(energy, max, moves);
    const bar = this.el('energy');
    if (!bar) return;
    bar.querySelectorAll('.tick').forEach((t) => t.remove());
    for (const tk of model.ticks) {
      const t = document.createElement('span');
      t.className = `tick${tk.ready ? ' ready' : ''}`;
      t.style.left = `${tk.pct}%`;
      t.title = `${tk.name}：${tk.pct}%`;
      bar.appendChild(t);
    }
    bar.setAttribute('aria-valuenow', String(model.pct));
    bar.title = `能量 ${energy}/${max}`;
    this.frc.tween(from, energy, 300, (v) => { const f = this.el('energy-fill'); if (f) f.style.width = `${Math.min(100, (v / max) * 100)}%`; });
  }

  renderMoves() {
    const box = this.el('moves');
    if (!box || !this.state) return;
    const moves = this.state.attacker.active.moves || [];
    const hints = (this.state.combo && this.state.combo.hints) || [];
    const bestId = this.advice && this.advice.best && this.advice.best.moveId;
    const ended = this.state.status !== 'active';
    box.innerHTML = moves.map((m) => {
      const st = moveButtonState(m);
      const next = hints.some((h) => h.nextMove === m.id);
      return `<button class="bt-move ${m.category === 'CHARGE' ? 'charge' : ''} ${next ? 'next' : ''} ${m.id === bestId ? 'best' : ''}"
          data-move="${esc(m.id)}" ${st.disabled || ended || this.busy ? 'disabled' : ''} aria-label="${esc(m.name)} ${esc(st.label)}"
          style="border-left:4px solid ${TYPE_COLOR[m.type] || '#888'}">
        <div class="nm">${esc(m.name)}</div>
        <div class="meta">${m.category === 'CHARGE' ? '蓄力' : '快速'} · 威力 ${m.power} · ${esc(st.label)}${m.cooldownTurns ? ` · 冷却 ${m.cooldownTurns} 回合` : ''}</div>
        ${m.cooldownLeft > 0 ? `<div class="cd" aria-hidden="true">${m.cooldownLeft}</div>` : ''}
      </button>`;
    }).join('');
    const energyShort = moves.find((m) => m.category === 'CHARGE' && !m.energyOk);
    if (energyShort && this.state.attacker.active.energy < energyShort.energyCost) {
      box.title = `能量不足：${energyShort.name} 需要 ${energyShort.energyCost}，先用快速技能蓄能`;
    }
  }

  renderHints() {
    const el = this.el('hints');
    if (this.hintTimer) clearInterval(this.hintTimer);
    const hints = (this.state && this.state.combo && this.state.combo.hints) || [];
    if (!hints.length) { el.textContent = this.state && this.state.combo.count ? `本场连击 ${this.state.combo.count} 次 · 连击点 ${this.state.combo.points}` : ''; return; }
    const until = Date.now();
    const draw = () => {
      const h = hints[0];
      const left = Math.max(0, h.remainingMs - (Date.now() - until));
      el.textContent = left > 0
        ? `🔗 ${h.name} ${h.matched}/${h.total}：下一步「${h.nextMove}」，剩余 ${(left / 1000).toFixed(1)}s（×${h.damageMultiplier}）`
        : '';
      if (!left) clearInterval(this.hintTimer);
    };
    draw();
    this.hintTimer = setInterval(draw, 100);
  }

  renderAdvisor() {
    const box = this.el('advisor');
    const a = this.advice;
    if (!a || !a.best) { box.hidden = true; return; }
    box.hidden = false;
    const best = a.best;
    const title = best.action === 'switch' ? `建议换上 ${esc(best.name)}` : `建议使用 ${esc(best.name)}${best.expectedDamage !== undefined ? `（约 ${best.expectedDamage} 伤害）` : ''}`;
    const weak = a.defender && a.defender.weakTo ? a.defender.weakTo.map((w) => `${w.type}×${w.multiplier.toFixed(2)}`).join(' ') : '';
    box.innerHTML = `<b>🤖 ${title}</b>
      <div class="bt-muted">${(best.reasons || []).map(esc).join('；')}</div>
      ${weak ? `<div class="bt-muted">对手弱点：${esc(weak)}</div>` : ''}
      ${a.prediction ? `<div class="bt-muted">预测胜率 ${Math.round(a.prediction.winProbability * 100)}% · 约 ${a.prediction.expectedTurns} 回合 · 今日剩余 ${a.quota ? a.quota.remaining : '-'} 次</div>` : ''}
      ${a.adviceId ? '<div class="bt-row" style="margin-top:4px"><span class="bt-muted">建议有帮助吗？</span><button class="bt-btn ghost" data-fb="up">👍</button><button class="bt-btn ghost" data-fb="down">👎</button></div>' : ''}`;
  }

  async requestAdvice() {
    try {
      const a = await this.client.advice(this.battleId);
      this.advice = a;
      if (a.prediction) this.prediction = a.prediction;
      this.renderAdvisor();
      this.renderMoves();
      if (this.el('winprob') && this.prediction) this.el('winprob').textContent = `胜率 ${Math.round(this.prediction.winProbability * 100)}%`;
    } catch (e) { this.toast(e.message || 'AI 建议暂不可用', 'err'); }
  }

  showSwitch() {
    const team = (this.state && this.state.attacker.team) || [];
    const cur = this.state.attacker.active.pokemonId;
    this.sheet('换人（消耗一回合）', team.map((c) => `<button class="bt-btn ghost" style="width:100%;margin-bottom:6px" data-switch="${esc(c.pokemonId)}" ${c.fainted || c.pokemonId === cur ? 'disabled' : ''}>
      ${monEmoji(c.speciesId)} ${esc(c.name)} · HP ${c.hp}/${c.maxHp}${c.pokemonId === cur ? '（场上）' : c.fainted ? '（倒下）' : ''}</button>`).join(''));
  }

  async loadPresets() {
    try { this.presets = (await this.client.presets()).presets || []; } catch { this.presets = []; }
  }

  showPresets() {
    const cur = this.state.attacker.active.pokemonId;
    const list = this.presets.filter((p) => p.pokemonId === cur);
    this.sheet('一键连招', list.length
      ? list.map((p) => `<button class="bt-btn ghost" style="width:100%;margin-bottom:6px;text-align:left" data-preset="${esc(p.id)}">${p.isDefault ? '⭐ ' : ''}${esc(p.name)}<div class="bt-muted">${p.steps.map((s) => esc(s.moveId)).join(' → ')}</div></button>`).join('')
      : '<div class="bt-muted">当前精灵还没有连招预设，可在「对战 → 连击」中创建</div>');
  }

  sheet(title, html) {
    const s = document.createElement('div');
    s.className = 'bt-result';
    s.innerHTML = `<div class="bt-card"><div class="bt-h">${esc(title)}</div>${html}<button class="bt-btn ghost" style="width:100%;margin-top:6px" data-close>关闭</button></div>`;
    s.addEventListener('click', (e) => {
      if (e.target === s || e.target.closest('[data-close]')) { s.remove(); return; }
      const b = e.target.closest('[data-switch],[data-preset]');
      if (b) { s.remove(); this.onClick({ target: b }); }
    });
    document.body.appendChild(s);
  }

  log(text, kind = '') {
    const box = this.el('log');
    if (!box || !text) return;
    const line = document.createElement('div');
    line.textContent = text;
    if (kind === 'combo') line.style.color = 'var(--yellow)';
    if (kind === 'enemy') line.style.color = '#ff9aa2';
    box.appendChild(line);
    while (box.childElementCount > 80) box.firstElementChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  hitEffect(side, moveType, strong) {
    const sprite = this.el(side === 'attacker' ? 'att-sprite' : 'def-sprite');
    if (sprite) { sprite.classList.remove('hit'); void sprite.offsetWidth; sprite.classList.add('hit'); }
    if (this.frc.effects === 'low' || !sprite) return;
    const n = Math.min(this.frc.particleLimit, strong ? 24 : 10);
    const rect = sprite.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = 'bt-particles';
    document.body.appendChild(layer);
    const parts = [];
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i');
      p.className = 'bt-particle';
      p.style.background = TYPE_COLOR[moveType] || '#fff';
      layer.appendChild(p);
      const ang = Math.random() * Math.PI * 2;
      parts.push({ el: p, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, vx: Math.cos(ang) * (1 + Math.random() * 3), vy: Math.sin(ang) * (1 + Math.random() * 3) });
    }
    const start = performance.now();
    const unsub = this.frc.subscribe((now) => {
      const k = (now - start) / 600;
      for (const p of parts) {
        p.el.style.transform = `translate(${p.x + p.vx * k * 60}px, ${p.y + p.vy * k * 60}px)`;
        p.el.style.opacity = String(Math.max(0, 1 - k));
      }
      if (k >= 1) { unsub(); layer.remove(); }
    });
  }

  comboEffect(combo) {
    const b = document.createElement('div');
    b.className = 'bt-combo-burst';
    b.textContent = `${combo.name} ×${combo.multiplier} ${combo.quality === 'perfect' ? 'PERFECT!' : combo.quality === 'excellent' ? 'GREAT!' : ''}`;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1000);
    try { if (navigator.vibrate) navigator.vibrate(combo.quality === 'perfect' ? [40, 30, 80] : [40]); } catch { /* 不支持震动 */ }
  }

  showResult(r) {
    this.frc.flush();
    const win = r.result === 'win';
    const lg = r.league;
    const hl = (r.highlights || []).slice(0, 5);
    const rv = r.review;
    const s = document.createElement('div');
    s.className = 'bt-result';
    s.dataset.testid = 'battle-result';
    s.innerHTML = `<div class="bt-card">
      <div class="bt-h" style="font-size:20px">${win ? '🏆 胜利！' : r.result === 'forfeit' ? '🏳️ 已认输' : '💥 战败'}</div>
      <div class="bt-muted">${r.turns} 回合${r.defendersDefeated !== undefined ? ` · 击败 ${r.defendersDefeated}/${r.defendersTotal} 只驻守精灵` : ''}${r.gymNeutral ? ' · 道馆已无人驻守，快去派驻精灵占领！' : ''}</div>
      ${r.rewards && !Array.isArray(r.rewards) ? `<div style="margin:8px 0">✨ 经验 +${r.rewards.xp} · ⭐ 星尘 +${r.rewards.stardust}${r.rewards.comboXp ? `（连击 +${r.rewards.comboXp}）` : ''}</div>` : ''}
      ${r.xp ? `<div style="margin:8px 0">✨ 经验 +${r.xp}</div>` : ''}
      ${lg ? `<div style="margin:8px 0">🏅 联赛积分 ${lg.pointsChange >= 0 ? '+' : ''}${lg.pointsChange}（${lg.points}）· 评分 ${lg.ratingChange >= 0 ? '+' : ''}${lg.ratingChange} · ${esc(lg.levelName)} ${esc(lg.group)}${lg.change === 'promote' ? ' · 晋级！' : lg.change === 'demote' ? ' · 降级' : ''}</div>` : ''}
      ${(r.rewards && Array.isArray(r.rewards) ? r.rewards : []).map((x) => `<span class="bt-chip">🎁 ${esc(x.type)}</span>`).join('')}
      ${hl.length ? `<div class="bt-h" style="margin-top:10px">精彩时刻</div>${hl.map((h) => `<div class="bt-muted">第 ${h.turn} 回合 · ${esc(h.title)}</div>`).join('')}` : ''}
      ${rv ? `<div class="bt-h" style="margin-top:10px">AI 复盘：${esc(rv.grade)}（${rv.score} 分）</div>${(rv.suggestions || []).slice(0, 4).map((x) => `<div class="bt-muted">· ${esc(x)}</div>`).join('')}` : ''}
      <div class="bt-row" style="margin-top:12px;flex-wrap:wrap">
        ${r.replayId ? '<button class="bt-btn" data-r="replay">▶ 回放</button><button class="bt-btn ghost" data-r="share">分享</button>' : ''}
        <button class="bt-btn ghost" data-r="close">关闭</button>
      </div>
      <div data-el="share"></div>
    </div>`;
    s.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === 'close') { s.remove(); this.close(); }
      if (b.dataset.r === 'replay') { s.remove(); this.close(); this.openReplay(r.replayId); }
      if (b.dataset.r === 'share') {
        try {
          const sh = await this.client.share(r.replayId, { platform: 'link' });
          s.querySelector('[data-el="share"]').innerHTML = renderShare(sh);
        } catch (err) { this.toast(err.message || '分享失败', 'err'); }
      }
    });
    document.body.appendChild(s);
  }
}

export function renderShare(sh) {
  return `<div class="bt-card" style="margin-top:10px">
    <div class="bt-muted">分享链接（分享码 ${esc(sh.shareCode)}）</div>
    <input class="form-input" style="width:100%;font-size:12px" readonly value="${esc(sh.shareUrl)}" onclick="this.select()">
    ${sh.qrCodeSvg ? `<div style="background:#fff;border-radius:8px;padding:6px;width:180px;margin:8px auto">${sh.qrCodeSvg}</div>` : ''}
    <div class="bt-row" style="flex-wrap:wrap">
      <a class="bt-btn ghost" href="${esc(sh.social.twitter)}" target="_blank" rel="noopener">Twitter</a>
      <a class="bt-btn ghost" href="${esc(sh.social.qq)}" target="_blank" rel="noopener">QQ</a>
      <span class="bt-muted">微信：${esc(sh.social.wechat.hint)}</span>
    </div></div>`;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
