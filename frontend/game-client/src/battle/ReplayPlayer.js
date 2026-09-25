// frontend/game-client/src/battle/ReplayPlayer.js
// 战斗回放播放器（REQ-00379 / REQ-00469）：通过 Replay-ID 或分享码拿到服务端录制的事件流，
// 在客户端逐回合重现（播放/暂停/倍速 0.5-4x/上一回合/下一回合/拖动时间轴/精彩时刻跳转）。
'use strict';

import { describeAction, hpColor, turnIntervalMs, escapeHtml as esc } from './BattleClient.js';

/**
 * 纯函数：把回放载荷转换为逐回合画面帧（第 0 帧为开场）
 * @param {object} replay 服务端 replay 载荷 { attackerTeam, defenderTeam, turns: [{turn, actions, hp}] }
 */
export function buildReplayFrames(replay) {
  const aTeam = replay.attackerTeam || [];
  const dTeam = replay.defenderTeam || [];
  const byId = new Map([...aTeam, ...dTeam].map((c) => [c.pokemonId, c]));
  const side = (c) => ({ pokemonId: c ? c.pokemonId : null, name: c ? c.name : '?', speciesId: c ? c.speciesId : null, hp: c ? c.maxHp : 0, maxHp: c ? c.maxHp : 1 });
  let att = side(aTeam[0]);
  let def = side(dTeam[0]);
  const frames = [{ turn: 0, attacker: { ...att }, defender: { ...def }, lines: ['战斗开始'] }];
  for (const t of replay.turns || []) {
    const lines = [];
    for (const a of t.actions || []) {
      const line = describeAction(a);
      if (line) lines.push(line);
      if (a.type === 'switch') {
        const c = byId.get(a.pokemonId);
        const s = { pokemonId: a.pokemonId, name: a.name || (c && c.name), speciesId: c && c.speciesId, hp: a.hp !== undefined ? a.hp : (c ? c.maxHp : 0), maxHp: a.maxHp || (c ? c.maxHp : 1) };
        if (a.side === 'attacker') att = s; else def = s;
      }
      if (a.type === 'attack') {
        const target = a.actor === 'attacker' ? def : att;
        if (a.targetId && target.pokemonId !== a.targetId) {
          const c = byId.get(a.targetId);
          Object.assign(target, { pokemonId: a.targetId, name: c ? c.name : target.name, speciesId: c ? c.speciesId : target.speciesId });
        }
        if (a.targetHp !== undefined) target.hp = a.targetHp;
        if (a.targetMaxHp) target.maxHp = a.targetMaxHp;
      }
      if (a.type === 'faint') {
        if (a.side === 'attacker') att.hp = 0; else def.hp = 0;
      }
    }
    // 回合末 HP 以服务端记录为准（包含状态伤害等）
    if (t.hp) {
      if (t.hp.attacker !== undefined) att.hp = t.hp.attacker;
      if (t.hp.defender !== undefined) def.hp = t.hp.defender;
    }
    frames.push({ turn: t.turn, attacker: { ...att }, defender: { ...def }, lines, combo: (t.actions || []).some((a) => a.combo) });
  }
  return frames;
}

export class ReplayPlayer {
  /**
   * @param {HTMLElement} container
   * @param {object} data 服务端 getReplay / viewShared 返回（含 replay、highlights、summary）
   * @param {object} opts { frc, emoji }
   */
  constructor(container, data, { frc = null, emoji = () => '🐾' } = {}) {
    this.container = container;
    this.data = data;
    this.frc = frc;
    this.emoji = emoji;
    this.frames = buildReplayFrames(data.replay || {});
    this.index = 0;
    this.speed = 1;
    this.timer = null;
    this.render();
  }

  render() {
    const d = this.data;
    const s = d.summary || {};
    const total = this.frames.length - 1;
    this.container.innerHTML = `
      <div class="bt-card" data-testid="replay-player">
        <div class="bt-h">${d.result === 'win' ? '🏆' : '⚔️'} ${esc(s.gymName || s.opponentName || d.battleType || '对战')} 回放</div>
        <div class="bt-muted">${esc(d.attackerNickname || '')} · ${d.turns} 回合 · ${Math.round((d.durationMs || 0) / 1000)} 秒 · 👁 ${d.viewCount || 0} · ❤ ${d.likeCount || 0} · ${(d.sizeBytes / 1024).toFixed(1)}KB</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
          ${['attacker', 'defender'].map((k) => `<div>
            <div class="bt-row"><span style="font-size:30px" data-rp="${k}-sprite"></span><b class="bt-grow" data-rp="${k}-name"></b></div>
            <div class="bt-hp"><i data-rp="${k}-hp"></i></div><div class="bt-muted" data-rp="${k}-hptext"></div></div>`).join('')}
        </div>
        <div class="rp-timeline" data-rp="timeline" role="slider" aria-label="回放进度" aria-valuemin="0" aria-valuemax="${total}" tabindex="0">
          <i data-rp="progress" style="width:0%"></i>
          ${(d.highlights || []).map((h) => `<span class="rp-marker ${h.severity === 'high' ? 'high' : ''}" style="left:calc(${total ? (Math.min(total, h.start_turn) / total) * 100 : 0}% - 4px)" data-turn="${h.start_turn}" title="${esc(h.title)}"></span>`).join('')}
        </div>
        <div class="rp-controls">
          <button class="bt-btn ghost" data-rp-act="prev" aria-label="上一回合">⏮</button>
          <button class="bt-btn" data-rp-act="play" aria-label="播放/暂停">▶</button>
          <button class="bt-btn ghost" data-rp-act="next" aria-label="下一回合">⏭</button>
          ${[0.5, 1, 2, 4].map((x) => `<button class="bt-btn ghost" data-rp-speed="${x}">${x}x</button>`).join('')}
          <span class="bt-muted" data-rp="turn"></span>
        </div>
        <div class="bt-log" data-rp="log" style="max-height:180px"></div>
        ${(d.highlights || []).length ? `<div class="bt-h" style="margin-top:8px">精彩时刻</div>${d.highlights.map((h) => `<div class="bt-muted" style="cursor:pointer" data-turn="${h.start_turn}">▸ 第 ${h.start_turn} 回合 · ${esc(h.title)}：${esc(h.description || '')}</div>`).join('')}` : ''}
      </div>`;
    this.container.onclick = (e) => {
      const t = e.target.closest('[data-turn]');
      if (t) return this.seek(Number(t.dataset.turn));
      const a = e.target.closest('[data-rp-act]');
      if (a) {
        if (a.dataset.rpAct === 'play') this.toggle();
        if (a.dataset.rpAct === 'prev') { this.pause(); this.seek(this.index - 1); }
        if (a.dataset.rpAct === 'next') { this.pause(); this.seek(this.index + 1); }
        return;
      }
      const sp = e.target.closest('[data-rp-speed]');
      if (sp) { this.speed = Number(sp.dataset.rpSpeed); if (this.timer) { this.pause(); this.play(); } this.markSpeed(); return; }
      const tl = e.target.closest('[data-rp="timeline"]');
      if (tl) {
        const r = tl.getBoundingClientRect();
        this.seek(Math.round(((e.clientX - r.left) / r.width) * total));
      }
    };
    this.markSpeed();
    this.show(0);
  }

  q(k) { return this.container.querySelector(`[data-rp="${k}"]`); }

  markSpeed() {
    this.container.querySelectorAll('[data-rp-speed]').forEach((b) => { b.classList.toggle('ghost', Number(b.dataset.rpSpeed) !== this.speed); });
  }

  show(i, animate = false) {
    const prev = this.frames[this.index];
    this.index = Math.max(0, Math.min(this.frames.length - 1, i));
    const f = this.frames[this.index];
    for (const k of ['attacker', 'defender']) {
      const c = f[k];
      this.q(`${k}-sprite`).textContent = this.emoji(c.speciesId);
      this.q(`${k}-name`).textContent = c.name;
      const draw = (hp) => {
        const bar = this.q(`${k}-hp`);
        if (!bar) return;
        bar.style.transform = `scaleX(${Math.max(0, hp) / Math.max(1, c.maxHp)})`;
        bar.style.backgroundColor = hpColor(hp, c.maxHp);
        this.q(`${k}-hptext`).textContent = `HP ${Math.max(0, Math.round(hp))}/${c.maxHp}`;
      };
      if (animate && this.frc && prev && prev[k].pokemonId === c.pokemonId) this.frc.tween(prev[k].hp, c.hp, Math.min(400, turnIntervalMs(this.speed) * 0.6), draw);
      else draw(c.hp);
    }
    const total = this.frames.length - 1;
    this.q('progress').style.width = `${total ? (this.index / total) * 100 : 0}%`;
    this.q('timeline').setAttribute('aria-valuenow', String(this.index));
    this.q('turn').textContent = `第 ${f.turn}/${total} 回合`;
    const log = this.q('log');
    log.innerHTML = this.frames.slice(Math.max(0, this.index - 6), this.index + 1)
      .map((fr) => fr.lines.map((l) => `<div${fr.combo ? ' style="color:var(--yellow)"' : ''}>${fr.turn ? `[${fr.turn}] ` : ''}${esc(l)}</div>`).join('')).join('');
    log.scrollTop = log.scrollHeight;
  }

  seek(i) { this.show(i); }

  play() {
    if (this.index >= this.frames.length - 1) this.show(0);
    this.container.querySelector('[data-rp-act="play"]').textContent = '⏸';
    this.timer = setInterval(() => {
      if (this.index >= this.frames.length - 1) return this.pause();
      this.show(this.index + 1, true);
    }, turnIntervalMs(this.speed));
  }

  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const b = this.container.querySelector('[data-rp-act="play"]');
    if (b) b.textContent = '▶';
  }

  toggle() { if (this.timer) this.pause(); else this.play(); }

  destroy() { this.pause(); this.container.innerHTML = ''; }
}
