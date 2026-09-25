// frontend/game-client/src/accessibility/pace.js
// REQ-00198 / REQ-00263：游戏节奏控制与慢速模式
//   - 捕捉倍率 → CatchEngine.timeScale（圆环收缩速度）与 index.html 圆环显示步长
//   - UI 倍率 → 所有 CSS/WAAPI 动画 playbackRate（0.5x 时动画时长 ×2）、提示显示时长 ÷ 倍率
//   - 战斗倍率 → battleScale()（战斗界面接入点；当前客户端无战斗界面）
//   - PVP / 竞技模式下强制 1.0x（公平性）
// 慢速只影响客户端表现，捕捉/战斗结果仍由服务端判定。

export const PACE_PRESETS = {
  accessible: { catch: 0.5, battle: 0.5, ui: 0.5 },
  easy: { catch: 0.75, battle: 0.75, ui: 0.75 },
  standard: { catch: 1, battle: 1, ui: 1 },
  veteran: { catch: 1.25, battle: 1.25, ui: 1.25 },
};

/** 动作辅助的"捕捉窗口延长"与节奏倍率合成：窗口 ×2 等价于时间流速 ÷2 */
export function effectiveCatchScale(pace, motor) {
  const base = Number(pace && pace.catch) || 1;
  const mult = motor && motor.enabled ? Math.max(1, Number(motor.windowMultiplier) || 1) : 1;
  return Number((base / mult).toFixed(4));
}

export function isSlow(pace) {
  return ['catch', 'battle', 'ui'].some((k) => (pace[k] ?? 1) !== 1);
}

export class PaceController {
  constructor({ getPrefs, catchEng = null } = {}) {
    this.getPrefs = getPrefs;
    this.catchEng = catchEng;
    this.competitive = null; // 'pvp' | 'raid' | 'leaderboard' | null
    this._onAnim = (e) => this._applyTo(e.target);
  }

  get prefs() { return this.getPrefs(); }

  catchScale() {
    if (this.competitive) return 1;
    return effectiveCatchScale(this.prefs.pace, this.prefs.motor);
  }

  battleScale() { return this.competitive ? 1 : (this.prefs.pace.battle || 1); }

  uiScale() { return this.competitive ? 1 : (this.prefs.pace.ui || 1); }

  /** 提示/字幕显示时长倍数（慢速时更长） */
  holdScale() { return Number((1 / this.uiScale()).toFixed(3)); }

  start() {
    document.addEventListener('animationstart', this._onAnim, true);
    document.addEventListener('transitionrun', this._onAnim, true);
    this.apply();
  }

  _applyTo(el) {
    if (!el || typeof el.getAnimations !== 'function') return;
    const rate = this.uiScale();
    for (const a of el.getAnimations()) {
      if (a._a11yFlashLimited) continue; // 光敏限速优先
      a.playbackRate = rate;
    }
  }

  apply() {
    const rate = this.uiScale();
    document.documentElement.style.setProperty('--a11y-anim-scale', String(rate));
    if (typeof document.getAnimations === 'function') {
      for (const a of document.getAnimations()) if (!a._a11yFlashLimited) a.playbackRate = rate;
    }
    if (this.catchEng) this.catchEng.timeScale = this.catchScale();
  }

  /** 进入竞技场景（PVP/团战/排行榜）：节奏控制与辅助禁用 */
  setCompetitive(kind) {
    this.competitive = kind || null;
    this.apply();
  }

  presetValues(name) { return PACE_PRESETS[name] || null; }
}
