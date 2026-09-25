// frontend/game-client/src/accessibility/motorAssist.js
// REQ-00360 / REQ-00414：动作障碍辅助
//   纯逻辑：预设方案、自动瞄准系数、震颤过滤判定、目标吸附（100px 内最近可交互元素）
//   运行期：点击容错/震颤过滤/双击确认/长按激活、一键投掷（等待最佳时机自动投掷）、投掷轨迹预览（贝塞尔 + 落点）、
//           捕捉窗口音调提示与最佳时机震动、疲劳提醒、单手布局、状态指示
// 隐私：动作辅助设置默认只存 localStorage（prefs.toCloudDoc 会剔除 motor，除非用户开启 cloudSync）。

export const AIM_COEFFICIENTS = { off: 0, low: 0.3, medium: 0.6, high: 0.85 };
export const TREMOR_WINDOW_MS = { off: 0, low: 250, medium: 500, high: 800 };
export const TREMOR_JITTER_PX = { off: Infinity, low: 24, medium: 16, high: 10 };
export const SNAP_RADIUS_PX = 100;

export const MOTOR_PRESETS = {
  light:  { enabled: true, aimAssist: 'low', windowMultiplier: 1.5, tremorFilter: 'off', confirmMode: 'none', oneTapThrow: false, trajectory: true, largeTargets: false, targetSnap: false, holdMs: 0 },
  medium: { enabled: true, aimAssist: 'medium', windowMultiplier: 2, tremorFilter: 'low', confirmMode: 'none', oneTapThrow: false, trajectory: true, largeTargets: true, targetSnap: true, holdMs: 0 },
  heavy:  { enabled: true, aimAssist: 'high', windowMultiplier: 3, tremorFilter: 'medium', confirmMode: 'none', oneTapThrow: true, trajectory: true, largeTargets: true, targetSnap: true, holdMs: 0, audioCue: true, fatigueThrows: 30 },
  'one-handed':    { enabled: true, oneHanded: 'right', largeTargets: true, oneTapThrow: true, targetSnap: true },
  tremor:          { enabled: true, tremorFilter: 'high', confirmMode: 'hold', holdMs: 600, largeTargets: true, targetSnap: true },
  slow:            { enabled: true, windowMultiplier: 2, aimAssist: 'medium', oneTapThrow: false, audioCue: true },
  'limited-range': { enabled: true, oneHanded: 'right', largeTargets: true, targetSnap: true, oneTapThrow: true },
};

export function motorPreset(name) {
  const p = MOTOR_PRESETS[name];
  return p ? { ...p, preset: name } : null;
}

/** 自动瞄准：把圆环缩放向最佳值（最小值）拉近 coefficient 比例 */
export function applyAimAssist(ringScale, coefficient, min = 0.2) {
  const c = Math.max(0, Math.min(1, Number(coefficient) || 0));
  return min + (ringScale - min) * (1 - c);
}

/** 震颤过滤：同一目标在窗口期内的重复点击、或按下/抬起位移过大的点击被丢弃 */
export function tremorAccept({ last, now, sameTarget, movedPx = 0, strength = 'off' }) {
  if (strength === 'off') return true;
  if (movedPx > TREMOR_JITTER_PX[strength]) return false;
  if (last !== null && last !== undefined && sameTarget && now - last < TREMOR_WINDOW_MS[strength]) return false;
  return true;
}

/** 目标吸附：rects=[{x,y,width,height,...}]，返回半径内离点最近的矩形（点在矩形内距离为 0） */
export function nearestTarget(pt, rects, radius = SNAP_RADIUS_PX) {
  let best = null;
  let bestD = Infinity;
  for (const r of rects) {
    const dx = Math.max(r.x - pt.x, 0, pt.x - (r.x + r.width));
    const dy = Math.max(r.y - pt.y, 0, pt.y - (r.y + r.height));
    const d = Math.hypot(dx, dy);
    if (d <= radius && d < bestD) { best = r; bestD = d; }
  }
  return best ? { target: best, distance: bestD } : null;
}

/** 二次贝塞尔轨迹（起点、控制点、终点）→ SVG path */
export function trajectoryPath(from, to, arc = 0.35) {
  const cx = (from.x + to.x) / 2;
  const cy = Math.min(from.y, to.y) - Math.abs(from.y - to.y) * arc;
  return { d: `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`, control: { x: cx, y: cy } };
}

const INTERACTIVE = 'button, [role="button"], [role="radio"], [role="link"], [role="tab"], a[href], input, select, .entity-card, .ball-chip, .nav-tab';
const CONFIRM_TARGETS = '#throw-btn, [data-testid="flee-btn"], [data-testid="logout-btn"], .entity-card';

export class MotorAssist {
  constructor({ getPrefs, announcer, haptics, catchEng = null, isCompetitive = () => false } = {}) {
    this.getPrefs = getPrefs;
    this.announcer = announcer;
    this.haptics = haptics;
    this.catchEng = catchEng;
    this.isCompetitive = isCompetitive;
    this.stats = { filtered: 0, snapped: 0, confirmed: 0, autoThrows: 0, throws: 0, fatigueShown: 0, calcMs: [] };
    this._last = { t: null, target: null };
    this._down = null;
    this._pendingConfirm = null;
    this._waitingThrow = false;
    this._bypass = false;
    this._wasBest = false;
  }

  get m() { return this.getPrefs().motor; }
  active() { return this.m.enabled && !this.isCompetitive(); }

  start() {
    document.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY, t: performance.now(), target: e.target }; }, true);
    document.addEventListener('click', (e) => this._onClick(e), true);
    if (this.catchEng) {
      this.catchEng.addEventListener('frame', (e) => this._onFrame(e.detail));
      this.catchEng.addEventListener('throwPending', () => this._countThrow());
      this.catchEng.addEventListener('sessionStarted', () => { this._wasBest = false; this.updateTrajectory(); });
    }
    window.addEventListener('resize', () => this.updateTrajectory());
    this.apply();
  }

  apply() {
    const on = this.active();
    const m = this.m;
    const html = document.documentElement;
    html.classList.toggle('a11y-motor', on);
    html.classList.toggle('a11y-large-targets', on && m.largeTargets);
    html.classList.toggle('a11y-one-hand-left', on && m.oneHanded === 'left');
    html.classList.toggle('a11y-one-hand-right', on && m.oneHanded === 'right');
    if (this.catchEng) this.catchEng.aimAssist = on ? AIM_COEFFICIENTS[m.aimAssist] || 0 : 0;
    this.updateTrajectory();
  }

  /** 以编程方式点击时跳过过滤（一键投掷、吸附转发） */
  _dispatch(el) {
    this._bypass = true;
    try { el.click(); } finally { this._bypass = false; }
  }

  _onClick(e) {
    if (this._bypass || !this.active()) return;
    const t0 = performance.now();
    const m = this.m;
    const keyboard = e.detail === 0; // 键盘/辅助技术触发的点击不做指针类过滤
    let target = e.target.closest ? e.target.closest(INTERACTIVE) : null;

    // 1. 目标吸附：点击落在空白处时，吸附到 100px 内最近的可交互元素
    if (!target && !keyboard && m.targetSnap && !e.target.closest('.a11y-dialog-backdrop')) {
      const screen = document.querySelector('.screen.active') || document.body;
      const cands = [...screen.querySelectorAll(INTERACTIVE), ...document.querySelectorAll('#nav.show .nav-tab')]
        .filter((el) => el.getClientRects().length && !el.disabled)
        .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, el }; });
      const hit = nearestTarget({ x: e.clientX, y: e.clientY }, cands);
      if (hit) {
        e.preventDefault(); e.stopPropagation();
        this.stats.snapped++;
        this._record(t0);
        this._dispatch(hit.target.el);
        return;
      }
    }
    if (!target) return;

    // 2. 震颤过滤
    if (!keyboard && m.tremorFilter !== 'off') {
      const moved = this._down ? Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) : 0;
      const ok = tremorAccept({ last: this._last.t, now: performance.now(), sameTarget: this._last.target === target, movedPx: moved, strength: m.tremorFilter });
      if (!ok) { e.preventDefault(); e.stopPropagation(); this.stats.filtered++; this._record(t0); return; }
      this._last = { t: performance.now(), target };
    }

    // 3. 误触防护：长按激活 / 双击确认（仅对关键操作）
    if (!keyboard && target.matches(CONFIRM_TARGETS)) {
      if (m.confirmMode === 'hold' && m.holdMs > 0) {
        const held = this._down && this._down.target && target.contains(this._down.target) ? performance.now() - this._down.t : 0;
        if (held < m.holdMs) {
          e.preventDefault(); e.stopPropagation();
          this._hint(target, `请按住 ${(m.holdMs / 1000).toFixed(1)} 秒以确认`);
          this._record(t0);
          return;
        }
        this.stats.confirmed++;
        if (this.haptics) this.haptics.vibrate('long_press');
      } else if (m.confirmMode === 'double') {
        const p = this._pendingConfirm;
        if (!p || p.target !== target || performance.now() - p.t > 1500) {
          e.preventDefault(); e.stopPropagation();
          this._pendingConfirm = { target, t: performance.now() };
          this._hint(target, '再次点击以确认');
          this._record(t0);
          return;
        }
        this._pendingConfirm = null;
        this.stats.confirmed++;
      }
    }

    // 4. 一键投掷：点击投球后等待最佳时机自动投出
    if (target.id === 'throw-btn' && m.oneTapThrow && this.catchEng && !target.disabled) {
      e.preventDefault(); e.stopPropagation();
      this._record(t0);
      this.oneTapThrow();
    }
  }

  _record(t0) {
    const ms = performance.now() - t0;
    this.stats.calcMs.push(ms);
    if (this.stats.calcMs.length > 200) this.stats.calcMs.shift();
  }

  _hint(target, msg) {
    target.setAttribute('data-a11y-hint', msg);
    setTimeout(() => target.removeAttribute('data-a11y-hint'), 1600);
    if (this.announcer) this.announcer.announce(msg, { level: 'important' });
  }

  /** 等待圆环进入最佳区间（或超时 4s）后执行投掷 */
  oneTapThrow() {
    if (this._waitingThrow || !this.catchEng) return;
    const btn = document.getElementById('throw-btn');
    this._waitingThrow = true;
    if (btn) btn.setAttribute('aria-busy', 'true');
    const start = performance.now();
    const check = () => {
      const scale = this.catchEng.ringScale;
      if (scale < 0.3 || performance.now() - start > 4000 || !this.catchEng.session) {
        this._waitingThrow = false;
        if (btn) btn.removeAttribute('aria-busy');
        if (this.catchEng.session && typeof window.doThrow === 'function') {
          this.stats.autoThrows++;
          window.doThrow();
        }
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  _onFrame(detail) {
    if (!this.active()) return;
    const m = this.m;
    const scale = detail && detail.ring ? detail.ring.scale : 1;
    const best = scale < 0.3;
    if (best && !this._wasBest) {
      if (m.audioCue && this.announcer) this.announcer.tone(1046, { ms: 120 });
      if (this.haptics) this.haptics.vibrate('throw_excellent', { scene: 'catch' });
    }
    this._wasBest = best;
  }

  _countThrow() {
    this.stats.throws++;
    const n = this.m.fatigueThrows;
    if (this.active() && n > 0 && this.stats.throws % n === 0) {
      this.stats.fatigueShown++;
      document.dispatchEvent(new CustomEvent('pmg:a11y-fatigue', { detail: { throws: this.stats.throws } }));
    }
  }

  /** 投掷轨迹预览：从投球按钮到精灵的二次贝塞尔曲线 + 落点标记 */
  updateTrajectory() {
    const zone = document.querySelector('#catch .wild-zone');
    let svg = document.getElementById('a11y-trajectory');
    const show = this.active() && this.m.trajectory && document.getElementById('catch')?.classList.contains('active');
    if (!show || !zone) { if (svg) svg.remove(); return; }
    const icon = document.getElementById('c-icon');
    const btn = document.getElementById('throw-btn');
    const screen = document.getElementById('catch');
    if (!icon || !btn || !screen) return;
    const sr = screen.getBoundingClientRect();
    const ir = icon.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const from = { x: br.left + br.width / 2 - sr.left, y: br.top - sr.top };
    const to = { x: ir.left + ir.width / 2 - sr.left, y: ir.top + ir.height / 2 - sr.top };
    const { d } = trajectoryPath(from, to);
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'a11y-trajectory';
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', 'a11y-trajectory');
      screen.appendChild(svg);
    }
    svg.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);
    svg.innerHTML = `<path d="${d}" class="a11y-traj-path"/><circle cx="${to.x}" cy="${to.y}" r="18" class="a11y-traj-target"/><circle cx="${to.x}" cy="${to.y}" r="4" class="a11y-traj-dot"/>`;
  }

  p95() {
    const a = [...this.stats.calcMs].sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0;
  }
}
