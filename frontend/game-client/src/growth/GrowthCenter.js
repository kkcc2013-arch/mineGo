// frontend/game-client/src/growth/GrowthCenter.js
// Epic E07 精灵成长：「精灵」页（背包列表 → 精灵详情，分页签展示进化树/成长轨迹/体力/羁绊技能/觉醒/特训/训练营/培育/传承/合并）
// 后端接口均在 /v1/pokemon/*（pokemon-service），见 backend/services/pokemon-service/src/growth/mount.js
'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${Math.max(0, Math.min(100, Number(v) || 0))}%`;
const lang = () => (window.i18n && window.i18n.getLanguage && window.i18n.getLanguage()) || navigator.language || 'zh-CN';

const TABS = [
  ['evolution', '进化'], ['growth', '成长'], ['stamina', '体力'], ['bond', '羁绊'], ['awakening', '觉醒'],
  ['special', '特训'], ['camp', '训练营'], ['breeding', '培育'], ['legacy', '传承'], ['merge', '合并'],
];
const FATIGUE_COLORS = { fresh: '#4CAF50', normal: '#8BC34A', tired: '#FF9800', exhausted: '#F44336' };
const ATTR_NAMES = { attack: '攻击', defense: '防御', speed: '速度', critical: '暴击', dodge: '闪避', energy: '能量' };

export class GrowthCenter {
  constructor({ api, toast }) {
    this.api = api;
    this.toast = toast || ((m) => console.log(m));
    this.el = null;
    this.current = null; // 当前精灵 id
    this.tab = 'evolution';
    this.pokemon = [];
  }

  mount() {
    if (document.getElementById('growth')) { this.el = document.getElementById('growth'); return; }
    const s = document.createElement('div');
    s.className = 'screen growth-screen';
    s.id = 'growth';
    s.dataset.testid = 'growth-screen';
    s.innerHTML = `
      <div class="gr-top"><div class="gr-back" data-act="back" role="button" tabindex="0" aria-label="返回">←</div>
        <div class="gr-title">我的精灵</div><div class="gr-sub" data-ref="sub"></div></div>
      <div class="gr-body" data-ref="body"><div class="spin"></div></div>`;
    document.body.insertBefore(s, document.getElementById('nav'));
    this.el = s;
    s.addEventListener('click', (e) => this.onClick(e));
    s.addEventListener('change', (e) => this.onChange(e));
  }

  $(ref) { return this.el.querySelector(`[data-ref="${ref}"]`); }

  async call(method, path, body) {
    try {
      return await this.api.request(method, path, body);
    } catch (err) {
      this.toast(`❌ ${err.message || '请求失败'}`, 'err');
      throw err;
    }
  }

  // ───────────────────────── 列表 ─────────────────────────
  async show() {
    this.current = null;
    this.$('sub').textContent = '';
    const body = this.$('body');
    body.innerHTML = '<div class="spin"></div>';
    try {
      const d = await this.api.get('/pokemon/my?limit=60&sort=cp');
      this.pokemon = (d && d.pokemon) || [];
      body.innerHTML = `
        <div class="gr-toolbar"><button class="gr-btn" data-act="boosts">经验加成</button><button class="gr-btn" data-act="shop">成长商店</button>
          <button class="gr-btn" data-act="camps">训练营</button><button class="gr-btn" data-act="breed-center">培育屋</button>
          <button class="gr-btn" data-act="merge-center">合并</button><button class="gr-btn" data-act="pools">传承池</button></div>
        <div class="gr-list">${this.pokemon.map((p) => `
          <div class="gr-card" data-act="open" data-id="${esc(p.id)}" role="button" tabindex="0" data-testid="growth-pokemon">
            <div class="gr-name">${esc(p.nickname || p.name_zh)}${p.is_shiny ? ' ✨' : ''}</div>
            <div class="gr-meta">CP ${esc(p.cp)} · IV ${esc(p.iv_pct)}%</div></div>`).join('') || '<div class="gr-empty">还没有精灵，去地图上捕捉吧</div>'}</div>`;
    } catch (err) {
      body.innerHTML = `<div class="gr-empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  async open(id, tab) {
    this.current = id;
    if (tab) this.tab = tab;
    const body = this.$('body');
    body.innerHTML = '<div class="spin"></div>';
    const [g, st, aw] = await Promise.all([
      this.api.get(`/pokemon/${id}/growth`).catch(() => null),
      this.api.get(`/pokemon/${id}/stamina`).catch(() => null),
      this.api.get(`/pokemon/${id}/awakening`).catch(() => null),
    ]);
    if (!g) { body.innerHTML = '<div class="gr-empty">精灵不存在</div>'; return; }
    this.detail = { g, st, aw };
    this.$('sub').textContent = `${g.speciesName} · Lv.${g.level}`;
    body.innerHTML = `
      <div class="gr-head ${aw && aw.aura ? `gr-${esc(aw.aura)}` : ''}" data-testid="growth-head">
        <div class="gr-hname">${esc(g.speciesName)} <span class="gr-cp">CP ${esc(g.cp)}</span></div>
        <div class="gr-row"><span>Lv.${g.level}/${g.levelCap}</span><div class="gr-bar"><i style="width:${pct(g.progressPercent)}"></i></div><span>${g.expToNextLevel} 升级</span></div>
        ${st ? `<div class="gr-row"><span>体力</span><div class="gr-bar"><i style="width:${pct(st.staminaPercentage)};background:${FATIGUE_COLORS[st.fatigueLevel]}"></i></div><span>${st.currentStamina}/${st.maxStamina} ${esc(st.fatigueLabel)}</span></div>` : ''}
        <div class="gr-row gr-small">亲密度 ${g.friendship} · 觉醒 ${g.awakeningStage} 阶</div>
      </div>
      <div class="gr-tabs" role="tablist">${TABS.map(([k, n]) => `<div class="gr-tab ${k === this.tab ? 'on' : ''}" data-act="tab" data-tab="${k}" role="tab">${n}</div>`).join('')}</div>
      <div class="gr-panel" data-ref="panel"><div class="spin"></div></div>`;
    await this.renderTab();
  }

  async renderTab() {
    const panel = this.$('panel');
    if (!panel) return;
    panel.innerHTML = '<div class="spin"></div>';
    const id = this.current;
    try {
      const fn = {
        evolution: () => this.tabEvolution(id), growth: () => this.tabGrowth(id), stamina: () => this.tabStamina(id),
        bond: () => this.tabBond(id), awakening: () => this.tabAwakening(id), special: () => this.tabSpecial(id),
        camp: () => this.tabCamp(id), breeding: () => this.tabBreeding(id), legacy: () => this.tabLegacy(id), merge: () => this.tabMerge(id),
      }[this.tab];
      panel.innerHTML = await fn();
    } catch (err) {
      panel.innerHTML = `<div class="gr-empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  // ───────────────────────── 进化（进化树 + 条件 + 执行） ─────────────────────────
  async tabEvolution(id) {
    const chk = await this.api.get(`/pokemon/${id}/evolution/check`);
    const tree = await this.api.get(`/pokemon/species/${chk.pokemon.speciesId}/evolution-chain?lang=${encodeURIComponent(lang())}`);
    const opts = chk.options.map((o) => `
      <div class="gr-opt ${o.met ? 'ok' : ''}">
        <div><b>${esc(o.toSpeciesName)}</b> <span class="gr-tag">${esc(o.evolutionType)}</span>${o.hidden ? ' <span class="gr-tag gr-hidden">隐藏</span>' : ''}</div>
        ${o.hint ? `<div class="gr-hint">💡 ${esc(o.hint.zh || o.hint.en || '')}</div>` : ''}
        <ul>${o.checks.map((c) => `<li class="${c.met ? 'ok' : 'no'}">${c.met ? '✔' : '✘'} ${esc(c.type)}：${esc(c.current)} / ${esc(c.required)}</li>`).join('')}</ul>
        ${o.preview ? `<div class="gr-small">CP ${chk.pokemon.cp} → ${o.preview.cp}（+${o.preview.cpChange}）</div>` : ''}
        ${o.met && o.toSpeciesId ? `<button class="gr-btn primary" data-act="evolve" data-target="${o.toSpeciesId}" data-testid="evolve-btn">进化</button>` : ''}
      </div>`).join('');
    return `${this.renderTree(tree)}<div class="gr-sec">进化路径（${chk.phase === 'day' ? '白天' : '夜晚'}）· 糖果 ${chk.pokemon.candy}</div>
      ${opts || '<div class="gr-empty">该精灵没有进化形态</div>'}`;
  }

  /** 进化树 SVG：节点按布局坐标、边标注条件；隐藏路径为虚线 */
  renderTree(t) {
    if (!t || !t.nodes) return '';
    const W = 320;
    const H = Math.max(90, t.stages * 80);
    const pos = (n) => ({ x: 20 + n.position.x * (W - 40), y: 24 + n.position.y * (H - 48) });
    const nodes = t.nodes.map((n, i) => ({ ...n, i, p: pos(n) }));
    // 服务端按先序遍历输出：nodes[j]（j ≥ 1）的入边是 edges[j-1]，父节点是它之前最近的上一阶段节点
    const lines = [];
    for (let j = 1; j < nodes.length; j++) {
      const child = nodes[j];
      const e = t.edges[j - 1] || {};
      let parent = null;
      for (let k = j - 1; k >= 0; k--) if (nodes[k].stage === child.stage - 1) { parent = nodes[k]; break; }
      if (!parent) continue;
      lines.push(`<line x1="${parent.p.x}" y1="${parent.p.y}" x2="${child.p.x}" y2="${child.p.y}" class="gr-edge ${e.hidden ? 'hidden' : ''}"><title>${esc(e.conditionText || e.hint || '')}</title></line>`);
    }
    const circles = nodes.map((n) => `<g class="gr-node ${n.focus ? 'focus' : ''}"><circle cx="${n.p.x}" cy="${n.p.y}" r="14"/>
      <text x="${n.p.x}" y="${n.p.y + 28}" text-anchor="middle">${esc(n.name)}</text></g>`).join('');
    return `<svg class="gr-tree" viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="进化树">${lines.join('')}${circles}</svg>`;
  }

  // ───────────────────────── 成长轨迹 ─────────────────────────
  async tabGrowth(id) {
    const [traj, src, ms, pred] = await Promise.all([
      this.api.get(`/pokemon/${id}/growth/trajectory?days=30`),
      this.api.get(`/pokemon/${id}/growth/sources`),
      this.api.get(`/pokemon/${id}/growth/milestones`),
      this.api.get(`/pokemon/${id}/growth/prediction`),
    ]);
    const pts = traj.points;
    const max = Math.max(1, ...pts.map((p) => p.cumulativeExp));
    const W = 300; const H = 90;
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * W},${H - (p.cumulativeExp / max) * H}`).join(' ');
    return `
      <div class="gr-sec">30 天成长曲线</div>
      <svg class="gr-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="累计经验曲线"><path d="${path}"/></svg>
      <div class="gr-sec">经验来源</div>
      ${src.sources.map((s) => `<div class="gr-row"><span class="gr-w80">${esc(s.source)}</span><div class="gr-bar"><i style="width:${pct(s.percentage)}"></i></div><span>${s.percentage}%</span></div>`).join('') || '<div class="gr-empty">暂无经验记录</div>'}
      <div class="gr-sec">预测</div>
      <div class="gr-small">${pred.nextLevel ? `下一级还需 ${pred.nextLevel.expNeeded} 经验${pred.nextLevel.days != null ? `，约 ${pred.nextLevel.days} 天` : ''}` : '已达等级上限'} · 日均 ${pred.avgDailyExp} · 置信度 ${Math.round(pred.confidence * 100)}%</div>
      <div class="gr-sec">使用经验糖果</div>
      <div class="gr-actions">${['S', 'M', 'L'].map((k) => `<button class="gr-btn" data-act="exp-item" data-item="EXP_CANDY_${k}">经验糖果${k}</button>`).join('')}</div>
      <div class="gr-sec">里程碑</div>
      <ul class="gr-ms">${ms.milestones.map((m) => `<li>🏅 ${esc(m.name)} <span class="gr-small">${new Date(m.achievedAt).toLocaleDateString()}</span></li>`).join('') || '<li class="gr-small">暂无</li>'}</ul>`;
  }

  // ───────────────────────── 体力 ─────────────────────────
  async tabStamina(id) {
    const [st, cfg, hist] = await Promise.all([
      this.api.get(`/pokemon/${id}/stamina`), this.api.get('/pokemon/stamina/config'), this.api.get(`/pokemon/${id}/stamina/history?limit=10`),
    ]);
    return `
      <div class="gr-row"><div class="gr-bar big"><i style="width:${pct(st.staminaPercentage)};background:${FATIGUE_COLORS[st.fatigueLevel]}"></i></div></div>
      <div class="gr-small">${st.currentStamina}/${st.maxStamina} · ${esc(st.fatigueLabel)} · 战斗 ×${st.effects.battleBonus} 经验 ×${st.effects.expBonus} · 每分钟恢复 ${st.naturalRecoveryPerMinute}，${st.minutesToFull} 分钟回满</div>
      ${st.resting ? `<div class="gr-small">休息中（预计额外恢复 ${st.resting.projectedRecovery}）<button class="gr-btn" data-act="rest-end">结束休息</button></div>` : ''}
      <div class="gr-sec">恢复道具</div>
      <div class="gr-actions">${cfg.recoveryItems.map((i) => `<button class="gr-btn" data-act="stamina-item" data-item="${esc(i.itemId)}">${esc(i.name)} +${i.amount}</button>`).join('')}</div>
      <div class="gr-sec">活动消耗</div>
      <div class="gr-small">${cfg.activityCosts.map((c) => `${esc(c.activityType)} −${c.cost}`).join(' · ')}</div>
      <div class="gr-sec">最近变化</div>
      <ul class="gr-ms">${hist.map((h) => `<li>${h.change > 0 ? '+' : ''}${h.change} ${esc(h.source === 'activity' ? h.activityType : h.source)}</li>`).join('') || '<li class="gr-small">暂无</li>'}</ul>`;
  }

  // ───────────────────────── 羁绊技能 ─────────────────────────
  async tabBond(id) {
    const b = await this.api.get(`/pokemon/${id}/bond-skills`);
    return `<div class="gr-small">羁绊等级 ${b.bondLevel}/100（亲密度 ${b.friendship}）· 解锁 20/50/90</div>
      ${b.skills.map((s) => `<div class="gr-opt ${s.isUnlocked ? 'ok' : ''}">
        <div><b>${esc(s.name)}</b> <span class="gr-tag">${esc(s.type)}</span> 第${s.slot || '-'}槽 · 威力 ${s.effect.power}${s.effect.effectValue != null ? ` · 效果 ${s.effect.effectValue}` : ''}</div>
        <div class="gr-small">${esc(s.effectDescription || '')}${s.isUnlocked ? '' : ` · 还需亲密度 ${s.friendshipGap}`}</div>
        <div class="gr-actions">${!s.isLearned && s.isUnlocked ? `<button class="gr-btn primary" data-act="bond-learn" data-skill="${s.id}">学习</button>` : ''}
          ${s.isLearned && !s.isActive ? `<button class="gr-btn" data-act="bond-activate" data-skill="${s.id}">激活</button>` : ''}
          ${s.isActive ? '<span class="gr-tag">已激活</span>' : ''}
          ${s.isLearned ? `<button class="gr-btn" data-act="bond-forget" data-skill="${s.id}">遗忘</button>` : ''}</div></div>`).join('') || '<div class="gr-empty">该物种没有羁绊技能</div>'}`;
  }

  // ───────────────────────── 觉醒 ─────────────────────────
  async tabAwakening(id) {
    const a = await this.api.get(`/pokemon/${id}/awakening?lang=${encodeURIComponent(lang())}`);
    const b = a.bonuses || {};
    return `<div class="gr-aura-box ${a.aura ? `gr-${esc(a.aura)}` : ''}">觉醒 ${a.stage}/${a.maxStage} 阶${a.awakeningSkill ? ` · 觉醒技能 ${esc(a.awakeningSkill.name)}（威力 ${a.awakeningSkill.power}）` : ''}</div>
      <div class="gr-small">加成：${Object.entries(b).filter(([, v]) => v).map(([k, v]) => `${esc(k)} +${Math.round(v * 1000) / 10}%`).join(' · ') || '无'}</div>
      ${a.stages.map((s) => `<div class="gr-opt ok"><b>第 ${s.stage} 阶</b> ${s.potentials.map((p) => `<span class="gr-tag gr-${esc(p.rarity)}">${esc(p.name)}</span>`).join(' ')}
        <button class="gr-btn" data-act="reroll" data-stage="${s.stage}">重洗（精华×${s.nextRerollCost.items[0].count}）</button></div>`).join('')}
      ${a.next ? `<div class="gr-sec">下一阶段</div><ul>${a.next.checks.map((c) => `<li class="${c.met ? 'ok' : 'no'}">${c.met ? '✔' : '✘'} ${esc(c.label)} ${c.current}/${c.required}</li>`).join('')}</ul>
        <button class="gr-btn primary" data-act="awaken" ${a.next.met ? '' : 'disabled'}>觉醒</button>` : '<div class="gr-small">已达最高阶段</div>'}`;
  }

  // ───────────────────────── 特训 ─────────────────────────
  async tabSpecial(id) {
    const [t, fac, q] = await Promise.all([
      this.api.get(`/pokemon/${id}/training`), this.api.get('/pokemon/special-training/facilities'), this.api.get('/pokemon/special-training/queue'),
    ]);
    const cur = t.currentTraining;
    return `${Object.entries(t.attributes).map(([k, a]) => `<div class="gr-row"><span class="gr-w80">${ATTR_NAMES[k]} Lv.${a.level}</span>
        <div class="gr-bar"><i style="width:${pct((a.level / a.maxLevel) * 100)}"></i></div><span>/${a.maxLevel}</span></div>`).join('')}
      <div class="gr-small">队列 ${q.slots.used}/${q.slots.max} · 今日 ${q.daily.used}/${q.daily.max}</div>
      ${cur ? `<div class="gr-opt">训练中：${ATTR_NAMES[cur.attribute]}（剩余 ${Math.ceil(cur.remainingSeconds / 60)} 分钟）
        ${cur.ready ? `<button class="gr-btn primary" data-act="st-complete" data-training="${cur.trainingId}">完成</button>` : `<button class="gr-btn" data-act="st-accel" data-training="${cur.trainingId}">加速 1 小时</button>`}
        <button class="gr-btn" data-act="st-cancel" data-training="${cur.trainingId}">取消</button></div>`
      : `<div class="gr-sec">开始特训</div>
        <select data-ref="st-attr">${Object.keys(ATTR_NAMES).map((k) => `<option value="${k}">${ATTR_NAMES[k]}</option>`).join('')}</select>
        <select data-ref="st-fac">${fac.map((f) => `<option value="${esc(f.facilityId)}" ${f.unlocked ? '' : 'disabled'}>${esc(f.name)}${f.unlocked ? '' : `（训练师 ${f.unlockRequirement.trainerLevel} 级）`}</option>`).join('')}</select>
        <label class="gr-small"><input type="checkbox" data-ref="st-apple"> 使用金苹果</label>
        <button class="gr-btn primary" data-act="st-start">开始（60 分钟）</button>`}`;
  }

  // ───────────────────────── 训练营 ─────────────────────────
  async tabCamp(id) {
    const camps = await this.api.get('/pokemon/training-camp/camps');
    const mine = camps.flatMap((c) => c.slots).find((s) => s.pokemonId === id);
    const courses = await Promise.all(camps.map((c) => this.api.get(`/pokemon/training-camp/camps/${c.campId}/courses`)));
    return `${mine ? `<div class="gr-opt">正在「${esc(mine.courseName)}」训练：${mine.progressPercent}%（剩余 ${mine.remainingMinutes} 分钟）
        ${mine.status === 'ready' ? `<button class="gr-btn primary" data-act="camp-complete" data-slot="${mine.slotId}">领取奖励</button>` : `<button class="gr-btn" data-act="camp-boost" data-slot="${mine.slotId}">训练加速器</button>`}
        <button class="gr-btn" data-act="camp-cancel" data-slot="${mine.slotId}">取消</button></div>` : ''}
      ${camps.map((c, i) => `<div class="gr-sec">${esc(c.name)} Lv.${c.level}（${c.usedSlots}/${c.capacity}）</div>
        ${courses[i].map((co) => `<div class="gr-row gr-small"><span class="gr-w80">${esc(co.name)}</span><span>${co.durationMinutes} 分钟 · ${co.cost ? `${co.cost.amount} ${esc(co.cost.currency)}` : '免费'}</span>
          ${!mine && co.unlocked ? `<button class="gr-btn" data-act="camp-start" data-camp="${c.campId}" data-course="${co.courseId}">训练</button>` : ''}</div>`).join('')}`).join('')}`;
  }

  // ───────────────────────── 培育 ─────────────────────────
  async tabBreeding(id) {
    const center = await this.api.get('/pokemon/breeding/center');
    const others = this.pokemon.filter((p) => p.id !== id);
    return `<div class="gr-sec">与另一只精灵培育（本精灵为母方）</div>
      <select data-ref="br-father">${others.map((p) => `<option value="${esc(p.id)}">${esc(p.nickname || p.name_zh)} CP${p.cp}</option>`).join('')}</select>
      <label class="gr-small"><input type="checkbox" data-ref="br-knot"> 使用命运红线</label>
      <button class="gr-btn" data-act="br-check">检查配对</button><button class="gr-btn primary" data-act="br-start">开始培育</button>
      <div data-ref="br-result" class="gr-small"></div>
      <div class="gr-sec">培育屋（${center.usedSlots}/${center.slots}）</div>
      ${center.pairs.map((p) => `<div class="gr-opt">后代物种 #${p.offspringSpeciesId} · ${p.status === 'ready' ? '可领取' : `剩余 ${p.remainingMinutes} 分钟`}
        ${p.status === 'ready' ? `<button class="gr-btn primary" data-act="br-collect" data-pair="${p.pairId}">领取蛋</button>` : ''}</div>`).join('') || '<div class="gr-small">空</div>'}
      <div class="gr-sec">精灵蛋</div>
      ${center.eggs.map((e) => `<div class="gr-opt">🥚 #${e.speciesId} 第${e.generation}代 · ${e.incubating ? `${e.walkedKm}/${e.requiredKm} km` : `需 ${e.requiredKm} km`}
        ${!e.incubating ? `<button class="gr-btn" data-act="br-incubate" data-egg="${e.eggId}">放入孵化器</button>` : ''}
        ${e.ready ? `<button class="gr-btn primary" data-act="br-hatch" data-egg="${e.eggId}">孵化</button>` : ''}</div>`).join('') || '<div class="gr-small">没有蛋</div>'}`;
  }

  // ───────────────────────── 传承 ─────────────────────────
  async tabLegacy() {
    const pools = await this.api.get('/pokemon/inheritance/pool');
    return `<div class="gr-small">放生后本精灵的 IV 与部分 CP 会存入同家族的传承池（30 天有效、逐日衰减），之后捕捉同家族精灵自动继承。</div>
      <select data-ref="lg-stone"><option value="">不使用传承石</option><option value="LEGACY_STONE_NORMAL">传承石 +10%</option>
        <option value="LEGACY_STONE_ADVANCED">高级传承石 +20%</option><option value="LEGACY_STONE_PERFECT">完美传承石（全部）</option></select>
      <button class="gr-btn danger" data-act="release">放生并传承</button>
      <div class="gr-sec">我的传承池</div>
      ${pools.map((p) => `<div class="gr-opt">${esc(p.speciesName)} · 传承率 ${Math.round(p.inheritanceRate * 100)}% · 当前加成 IV +${p.currentBonus.ivAttack}/${p.currentBonus.ivDefense}/${p.currentBonus.ivHp} CP +${p.currentBonus.cpBonus}
        <span class="gr-small">到期 ${new Date(p.expiresAt).toLocaleDateString()}</span></div>`).join('') || '<div class="gr-small">暂无</div>'}`;
  }

  // ───────────────────────── 合并 ─────────────────────────
  async tabMerge(id) {
    const recipes = await this.api.get(`/pokemon/merge/recipes?lang=${encodeURIComponent(lang())}`);
    const me = this.pokemon.find((p) => p.id === id);
    const usable = recipes.filter((r) => me && r.requiredPokemon.some((x) => Number(x.species_id) === Number(me.species_id)));
    return `${usable.map((r) => {
      const need = r.requiredPokemon.map((x) => `#${x.species_id}×${x.count}`).join(' + ');
      return `<div class="gr-opt"><b>${esc(r.name)}</b> ${need}${r.requiredItems.length ? ` + ${r.requiredItems.map((i) => esc(i.item_id)).join(',')}` : ''} → ${esc(r.output.name)}（${r.baseSuccessRate}%）
        ${r.variant ? `<span class="gr-small">变异 ${esc(r.variant.name)} ${r.variant.rate}%</span>` : ''}
        <button class="gr-btn" data-act="merge-preview" data-recipe="${r.recipeId}">预览</button>
        <button class="gr-btn danger" data-act="merge-exec" data-recipe="${r.recipeId}">合并</button></div>`;
    }).join('') || '<div class="gr-empty">没有包含该物种的合并配方</div>'}<div data-ref="merge-result" class="gr-small"></div>`;
  }

  /** 按配方自动挑选同物种精灵（本精灵优先、CP 低的先用） */
  pickForRecipe(recipe) {
    const ids = [];
    for (const req of recipe.requiredPokemon) {
      const pool = this.pokemon.filter((p) => Number(p.species_id) === Number(req.species_id) && !p.is_favorite)
        .sort((a, b) => (a.id === this.current ? -1 : b.id === this.current ? 1 : a.cp - b.cp));
      ids.push(...pool.slice(0, req.count).map((p) => p.id));
    }
    return ids;
  }

  // ───────────────────────── 全局面板 ─────────────────────────
  async showBoosts() {
    const b = await this.api.get('/pokemon/experience/boosts');
    const s = await this.api.get('/pokemon/experience/stats?period=week');
    this.$('body').innerHTML = `<div class="gr-sec">当前经验倍率 ×${b.multiplier}</div>
      <div class="gr-small">${b.breakdown.map((x) => `${esc(x.source)} ×${x.multiplier}`).join(' · ') || '无加成'}</div>
      <div class="gr-actions">${['LUCKY_EGG', 'EXP_CARD_24H', 'EXP_CARD_PERMANENT'].map((i) => `<button class="gr-btn" data-act="boost-use" data-item="${i}">${i}</button>`).join('')}</div>
      <div class="gr-sec">本周经验 ${s.totalExp}（升级 ${s.levelUps} 次）</div>
      ${s.sources.map((x) => `<div class="gr-row"><span class="gr-w80">${esc(x.source)}</span><div class="gr-bar"><i style="width:${pct(x.percentage)}"></i></div><span>${x.percentage}%</span></div>`).join('')}`;
  }

  async showShop() {
    const items = await this.api.get('/pokemon/growth-shop/items');
    this.$('body').innerHTML = `<div class="gr-sec">成长商店（金币）</div>${items.map((i) => `<div class="gr-row gr-small"><span class="gr-w120">${esc(i.name)}</span>
      <span>拥有 ${i.owned}</span>${i.forSale ? `<button class="gr-btn" data-act="buy" data-item="${esc(i.itemId)}">${i.price} 金币</button>` : '<span class="gr-tag">非卖品</span>'}</div>`).join('')}`;
  }

  async showPools() { this.current = null; this.$('body').innerHTML = `<div class="gr-panel">${await this.tabLegacy()}</div>`; }

  // ───────────────────────── 事件 ─────────────────────────
  val(ref) { const n = this.el.querySelector(`[data-ref="${ref}"]`); return n ? (n.type === 'checkbox' ? n.checked : n.value) : null; }

  async onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const act = t.dataset.act;
    const id = this.current;
    const done = async (msg, tab) => { if (msg) this.toast(msg, 'ok'); if (id) await this.open(id, tab); else await this.show(); };
    try {
      switch (act) {
        case 'back': return this.current ? this.show() : window.goScreen('map');
        case 'open': return this.open(t.dataset.id);
        case 'tab': this.tab = t.dataset.tab; this.el.querySelectorAll('.gr-tab').forEach((x) => x.classList.toggle('on', x === t)); return this.renderTab();
        case 'boosts': return this.showBoosts();
        case 'shop': return this.showShop();
        case 'pools': return this.showPools();
        case 'camps': if (this.pokemon[0]) return this.open(this.pokemon[0].id, 'camp'); return;
        case 'breed-center': if (this.pokemon[0]) return this.open(this.pokemon[0].id, 'breeding'); return;
        case 'merge-center': if (this.pokemon[0]) return this.open(this.pokemon[0].id, 'merge'); return;
        case 'evolve': {
          const r = await this.call('POST', `/pokemon/${id}/evolution/execute`, { targetSpeciesId: Number(t.dataset.target) });
          this.celebrate(r.toSpecies.name, r.animation && r.animation.duration);
          return done(`🎉 进化为 ${r.toSpecies.name}！CP ${r.before.cp} → ${r.after.cp}`, 'evolution');
        }
        case 'exp-item': { const r = await this.call('POST', `/pokemon/${id}/experience/use-item`, { itemId: t.dataset.item, quantity: 1 }); return done(`+${r.gainedExp} 经验${r.levelUp ? `，升到 ${r.newLevel} 级` : ''}`, 'growth'); }
        case 'stamina-item': { const r = await this.call('POST', `/pokemon/${id}/stamina/use-item`, { itemId: t.dataset.item }); return done(`体力 +${r.recovered}`, 'stamina'); }
        case 'rest-end': { const r = await this.call('POST', `/pokemon/${id}/stamina/rest/end`); return done(`休息 ${r.minutes} 分钟，体力 +${r.recovered}`, 'stamina'); }
        case 'bond-learn': await this.call('POST', `/pokemon/${id}/bond-skills/${t.dataset.skill}/learn`); return done('学会了羁绊技能', 'bond');
        case 'bond-activate': await this.call('POST', `/pokemon/${id}/bond-skills/${t.dataset.skill}/activate`); return done('已激活', 'bond');
        case 'bond-forget': await this.call('DELETE', `/pokemon/${id}/bond-skills/${t.dataset.skill}`); return done('已遗忘', 'bond');
        case 'awaken': { const r = await this.call('POST', `/pokemon/${id}/awakening/awaken`); this.celebrate(`觉醒 ${r.stage} 阶`); return done(`✨ 觉醒成功：${r.potentials.map((p) => p.name).join('、')}`, 'awakening'); }
        case 'reroll': { const r = await this.call('POST', `/pokemon/${id}/awakening/reroll`, { stage: Number(t.dataset.stage) }); return done(`潜能：${r.potentials.map((p) => p.name).join('、')}`, 'awakening'); }
        case 'st-start': await this.call('POST', `/pokemon/${id}/training/start`, { trainingType: this.val('st-attr'), facilityId: this.val('st-fac'), useGoldenApple: this.val('st-apple') }); return done('开始特训', 'special');
        case 'st-complete': { const r = await this.call('POST', `/pokemon/${id}/training/${t.dataset.training}/complete`); return done(`${r.success ? '特训成功' : '效果不佳'}：${ATTR_NAMES[r.attribute]} Lv.${r.newLevel}`, 'special'); }
        case 'st-accel': await this.call('POST', '/pokemon/special-training/items/use', { itemId: 'TRAINING_ACCELERATOR_1H', trainingId: t.dataset.training }); return done('已加速', 'special');
        case 'st-cancel': await this.call('POST', `/pokemon/${id}/training/${t.dataset.training}/cancel`); return done('已取消', 'special');
        case 'camp-start': await this.call('POST', '/pokemon/training-camp/start', { campId: Number(t.dataset.camp), courseId: Number(t.dataset.course), pokemonId: id }); return done('开始训练', 'camp');
        case 'camp-complete': { const r = await this.call('POST', `/pokemon/training-camp/slots/${t.dataset.slot}/complete`); return done(`训练完成：经验 +${r.rewards.exp}${r.rewards.friendship ? `，亲密度 +${r.rewards.friendship.gained}` : ''}${r.rewards.skillLearned ? `，学会 ${r.rewards.skillLearned.name}` : ''}`, 'camp'); }
        case 'camp-boost': await this.call('POST', `/pokemon/training-camp/slots/${t.dataset.slot}/boost`, { itemId: 'TRAINING_TIMER_HALF' }); return done('剩余时间减半', 'camp');
        case 'camp-cancel': await this.call('POST', `/pokemon/training-camp/slots/${t.dataset.slot}/cancel`); return done('已取消', 'camp');
        case 'br-check': {
          const r = await this.call('POST', '/pokemon/breeding/check', { motherId: id, fatherId: this.val('br-father'), useDestinyKnot: this.val('br-knot') });
          this.$('br-result').textContent = r.compatible ? `可以配对：后代 ${r.offspring.name}，${r.breedingMinutes} 分钟，${r.cost.stardust} 星尘，IV 遗传率 ${r.inheritance.ivInheritanceRate * 100}%` : `不能配对：${r.reason}`;
          return;
        }
        case 'br-start': await this.call('POST', '/pokemon/breeding/start', { motherId: id, fatherId: this.val('br-father'), useDestinyKnot: this.val('br-knot') }); return done('开始培育', 'breeding');
        case 'br-collect': await this.call('POST', `/pokemon/breeding/pairs/${t.dataset.pair}/collect`); return done('获得精灵蛋', 'breeding');
        case 'br-incubate': await this.call('POST', `/pokemon/breeding/eggs/${t.dataset.egg}/incubate`, { incubator: 'basic' }); return done('开始孵化，走路即可累计距离', 'breeding');
        case 'br-hatch': { const r = await this.call('POST', `/pokemon/breeding/eggs/${t.dataset.egg}/hatch`); this.celebrate(r.name); return done(`🐣 孵化出 ${r.name}（第 ${r.generation} 代）`, 'breeding'); }
        case 'release': {
          if (!window.confirm('确定放生这只精灵？放生后不可恢复。')) return;
          const stone = this.val('lg-stone');
          const r = await this.call('POST', `/pokemon/${id}/release-with-inheritance`, { inherit: true, ...(stone ? { inheritanceItem: stone } : {}) });
          this.toast(`已放生，传承率 ${Math.round(r.pool.inheritanceRate * 100)}%`, 'ok');
          return this.show();
        }
        case 'merge-preview': case 'merge-exec': {
          const recipes = await this.api.get('/pokemon/merge/recipes');
          const recipe = recipes.find((r) => r.recipeId === Number(t.dataset.recipe));
          const body = { recipeId: recipe.recipeId, pokemonIds: this.pickForRecipe(recipe) };
          if (act === 'merge-preview') {
            const r = await this.call('POST', '/pokemon/merge/preview', body);
            this.$('merge-result').textContent = r.valid ? `成功率 ${r.successRate.total}%（${r.consumes.length} 只精灵参与）` : r.errors.join('；');
            return;
          }
          if (!window.confirm('合并失败时参与的精灵同样会被消耗，确定合并？')) return;
          const r = await this.call('POST', '/pokemon/merge/execute', body);
          if (r.success) this.celebrate(r.output.name);
          this.toast(r.success ? `合并成功：${r.output.name}${r.isVariant ? '（变异！）' : ''}` : '合并失败', r.success ? 'ok' : 'err');
          return this.show();
        }
        case 'boost-use': await this.call('POST', '/pokemon/experience/boosts', { itemId: t.dataset.item }); this.toast('经验加成已生效', 'ok'); return this.showBoosts();
        case 'buy': await this.call('POST', '/pokemon/growth-shop/buy', { itemId: t.dataset.item, quantity: 1 }); this.toast('购买成功', 'ok'); return this.showShop();
        default: return undefined;
      }
    } catch { /* toast 已提示 */ }
    return undefined;
  }

  onChange() {}

  /** 进化/觉醒/孵化动画（纯 CSS，尊重 prefers-reduced-motion） */
  celebrate(text, duration = 2500) {
    const fx = document.createElement('div');
    fx.className = 'gr-fx';
    fx.setAttribute('role', 'status');
    fx.innerHTML = `<div class="gr-fx-orb"></div><div class="gr-fx-text">${esc(text)}</div>`;
    document.body.appendChild(fx);
    setTimeout(() => fx.remove(), Math.min(6000, Number(duration) || 2500));
  }
}
