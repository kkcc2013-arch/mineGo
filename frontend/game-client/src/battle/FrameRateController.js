// frontend/game-client/src/battle/FrameRateController.js
// REQ-00325 战斗动画帧率优化：设备分级 → 目标帧率（30/45/60）、按目标帧率节流渲染、
// 实测帧率滑动窗口、特效自动降级/恢复（带滞回与冷却，过渡平滑）、页面隐藏时暂停（省电降温）、
// 与网络无关的补间动画（HP 条等在 200ms 网络延迟下也连续）、性能数据批量上报 /v1/battle/perf/report。
//
// 纯逻辑（detectDeviceTier / FpsMeter / QualityGovernor / easeOutCubic）不访问 window，可在 Node 中单测。
'use strict';

export const TIER_DEFAULTS = {
  tiers: {
    low: { targetFps: 30, effects: 'low', particleLimit: 40, maxMemoryGb: 4 },
    mid: { targetFps: 45, effects: 'medium', particleLimit: 120, maxMemoryGb: 8 },
    high: { targetFps: 60, effects: 'high', particleLimit: 300 },
  },
  degrade: { sampleWindowMs: 2000, downgradeBelowRatio: 0.85, upgradeAboveRatio: 0.98, cooldownMs: 5000 },
  report: { intervalMs: 30000, maxBatch: 20 },
};

export const EFFECT_LEVELS = ['low', 'medium', 'high'];
const FPS_STEPS = [30, 45, 60];

/**
 * 设备分级：内存 < 4GB 低端，4-8GB 中端，> 8GB 高端；浏览器不提供内存时按 CPU 核数估计；
 * 省流量模式 / 系统「减少动态效果」最高按中端处理。
 */
export function detectDeviceTier({ deviceMemory, hardwareConcurrency, saveData = false, reducedMotion = false } = {}) {
  let tier;
  const mem = Number(deviceMemory);
  const cores = Number(hardwareConcurrency);
  if (Number.isFinite(mem) && mem > 0) tier = mem < 4 ? 'low' : mem <= 8 ? 'mid' : 'high';
  else if (Number.isFinite(cores) && cores > 0) tier = cores <= 4 ? 'low' : cores <= 6 ? 'mid' : 'high';
  else tier = 'mid';
  if ((saveData || reducedMotion) && tier === 'high') tier = 'mid';
  return tier;
}

/** 滑动窗口帧率统计 */
export class FpsMeter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.frames = [];
    this.dropped = 0;
  }

  /** @param {number} t 帧时间戳（ms） @param {number} targetFps */
  record(t, targetFps = 60) {
    const last = this.frames[this.frames.length - 1];
    if (last !== undefined) {
      const expected = 1000 / targetFps;
      const gap = t - last;
      if (gap > expected * 1.5) this.dropped += Math.floor(gap / expected) - 1;
    }
    this.frames.push(t);
    while (this.frames.length && t - this.frames[0] > this.windowMs) this.frames.shift();
  }

  fps() {
    const n = this.frames.length;
    if (n < 2) return 0;
    const span = this.frames[n - 1] - this.frames[0];
    return span > 0 ? ((n - 1) * 1000) / span : 0;
  }

  /** 最慢 5% 帧间隔对应的帧率（卡顿指标） */
  p5Fps() {
    const gaps = [];
    for (let i = 1; i < this.frames.length; i++) gaps.push(this.frames[i] - this.frames[i - 1]);
    if (!gaps.length) return 0;
    gaps.sort((a, b) => b - a);
    const g = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.05))];
    return g > 0 ? 1000 / g : 0;
  }

  get span() {
    return this.frames.length > 1 ? this.frames[this.frames.length - 1] - this.frames[0] : 0;
  }

  reset() { this.frames = []; }
}

/**
 * 画质调节：实测帧率持续低于目标×downgradeBelowRatio 时先降特效，特效已最低再降目标帧率；
 * 持续高于目标×upgradeAboveRatio 时逐级恢复（不超过设备档位的上限）。每次调整后冷却 cooldownMs。
 */
export class QualityGovernor {
  constructor({ tier = 'mid', config = TIER_DEFAULTS } = {}) {
    this.config = config;
    this.tier = tier;
    const t = config.tiers[tier] || config.tiers.mid;
    this.maxFps = t.targetFps;
    this.maxEffects = t.effects;
    this.targetFps = t.targetFps;
    this.effects = t.effects;
    this.lastChangeAt = -Infinity;
    this.degradeEvents = 0;
    this.upgradeEvents = 0;
  }

  get particleLimit() {
    const base = (this.config.tiers[this.tier] || this.config.tiers.mid).particleLimit;
    return Math.round(base * ({ low: 0.35, medium: 0.7, high: 1 }[this.effects] || 1));
  }

  /**
   * @param {number} measuredFps 窗口内实测帧率
   * @param {number} now ms
   * @param {number} windowFilledMs 统计窗口已覆盖的时长（不足一个窗口不调整）
   * @returns {null | {type:'downgrade'|'upgrade', effects, targetFps}}
   */
  evaluate(measuredFps, now, windowFilledMs = Infinity) {
    const d = this.config.degrade;
    if (windowFilledMs < d.sampleWindowMs * 0.9) return null;
    if (now - this.lastChangeAt < d.cooldownMs) return null;
    const ratio = measuredFps / this.targetFps;
    if (ratio < d.downgradeBelowRatio) {
      const ei = EFFECT_LEVELS.indexOf(this.effects);
      if (ei > 0) this.effects = EFFECT_LEVELS[ei - 1];
      else {
        const fi = FPS_STEPS.indexOf(this.targetFps);
        if (fi > 0) this.targetFps = FPS_STEPS[fi - 1];
        else return null;
      }
      this.lastChangeAt = now;
      this.degradeEvents++;
      return { type: 'downgrade', effects: this.effects, targetFps: this.targetFps };
    }
    if (ratio >= d.upgradeAboveRatio) {
      if (this.targetFps < this.maxFps) {
        this.targetFps = FPS_STEPS[FPS_STEPS.indexOf(this.targetFps) + 1];
      } else if (EFFECT_LEVELS.indexOf(this.effects) < EFFECT_LEVELS.indexOf(this.maxEffects)) {
        this.effects = EFFECT_LEVELS[EFFECT_LEVELS.indexOf(this.effects) + 1];
      } else return null;
      this.lastChangeAt = now;
      this.upgradeEvents++;
      return { type: 'upgrade', effects: this.effects, targetFps: this.targetFps };
    }
    return null;
  }
}

export const easeOutCubic = (x) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;

/** 帧调度判定：距上一次渲染是否已达到目标帧间隔（留 1ms 余量避免 60Hz 屏幕上 45fps 抖动） */
export function shouldRender(now, lastRenderAt, targetFps) {
  return now - lastRenderAt >= 1000 / targetFps - 1;
}

/**
 * 浏览器运行时控制器（依赖 window / requestAnimationFrame）
 */
export class FrameRateController extends EventTarget {
  constructor({ api = null, win = typeof window !== 'undefined' ? window : null } = {}) {
    super();
    this.api = api;
    this.win = win;
    this.config = TIER_DEFAULTS;
    const nav = (win && win.navigator) || {};
    const reduced = !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.tier = detectDeviceTier({
      deviceMemory: nav.deviceMemory, hardwareConcurrency: nav.hardwareConcurrency,
      saveData: !!(nav.connection && nav.connection.saveData), reducedMotion: reduced,
    });
    this.governor = new QualityGovernor({ tier: this.tier, config: this.config });
    this.meter = new FpsMeter(this.config.degrade.sampleWindowMs);
    this.subscribers = new Set();
    this.tweens = new Set();
    this.running = false;
    this.rafId = null;
    this.lastRenderAt = -Infinity;
    this.pending = [];
    this.battleId = null;
    this.session = { frames: 0, fpsSum: 0, samples: 0, minP5: Infinity };
  }

  get targetFps() { return this.governor.targetFps; }
  get effects() { return this.governor.effects; }
  get particleLimit() { return this.governor.particleLimit; }

  async loadConfig() {
    if (!this.api) return this.config;
    try {
      const cfg = await this.api.get('/battle/perf/config');
      if (cfg && cfg.tiers) {
        this.config = cfg;
        this.governor = new QualityGovernor({ tier: this.tier, config: cfg });
        this.meter = new FpsMeter(cfg.degrade.sampleWindowMs);
      }
    } catch { /* 使用内置默认配置 */ }
    this.applyQualityClass();
    return this.config;
  }

  /** 在 <html> 上标记特效等级，CSS 按等级裁剪阴影/模糊/粒子（带过渡，降级平滑） */
  applyQualityClass() {
    const root = this.win && this.win.document && this.win.document.documentElement;
    if (!root) return;
    root.dataset.battleFx = this.governor.effects;
    root.style.setProperty('--battle-fx-duration', this.governor.effects === 'low' ? '120ms' : '240ms');
  }

  /** 订阅渲染帧：fn(now, dtMs)，只在满足目标帧率间隔时调用 */
  subscribe(fn) {
    this.subscribers.add(fn);
    if (!this.running) this.start();
    return () => { this.subscribers.delete(fn); };
  }

  /** 补间：与网络无关的平滑过渡（HP/能量条），返回取消函数 */
  tween(from, to, durationMs, onUpdate, ease = easeOutCubic) {
    const t = { from, to, durationMs: Math.max(1, durationMs), onUpdate, ease, start: null };
    this.tweens.add(t);
    if (!this.running) this.start();
    return () => this.tweens.delete(t);
  }

  start(battleId = this.battleId) {
    this.battleId = battleId;
    if (this.running || !this.win || !this.win.requestAnimationFrame) return;
    this.running = true;
    this.meter.reset();
    const loop = (now) => {
      if (!this.running) return;
      this.rafId = this.win.requestAnimationFrame(loop);
      if (this.win.document && this.win.document.hidden) return; // 后台不渲染
      if (!shouldRender(now, this.lastRenderAt, this.governor.targetFps)) return;
      const dt = this.lastRenderAt === -Infinity ? 0 : now - this.lastRenderAt;
      this.lastRenderAt = now;
      this.meter.record(now, this.governor.targetFps);
      this.session.frames++;
      for (const t of [...this.tweens]) {
        if (t.start === null) t.start = now;
        const k = t.ease((now - t.start) / t.durationMs);
        t.onUpdate(t.from + (t.to - t.from) * k);
        if (k >= 1) this.tweens.delete(t);
      }
      for (const fn of this.subscribers) {
        try { fn(now, dt); } catch (e) { console.warn('[FrameRate] render error', e); }
      }
      this.evaluate(now);
      if (!this.subscribers.size && !this.tweens.size) this.stop();
    };
    this.rafId = this.win.requestAnimationFrame(loop);
    if (!this.reportTimer) {
      this.reportTimer = this.win.setInterval(() => this.flush(), this.config.report.intervalMs);
      this.win.addEventListener('pagehide', () => this.flush(true));
    }
  }

  stop() {
    this.running = false;
    if (this.rafId && this.win) this.win.cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  evaluate(now) {
    const fps = this.meter.fps();
    if (fps > 0) {
      this.session.fpsSum += fps;
      this.session.samples++;
      this.session.minP5 = Math.min(this.session.minP5, this.meter.p5Fps());
    }
    const change = this.governor.evaluate(fps, now, this.meter.span);
    if (change) {
      this.applyQualityClass();
      this.meter.reset();
      this.dispatchEvent(new CustomEvent('quality', { detail: { ...change, measuredFps: Math.round(fps) } }));
    }
  }

  /** 结束一段战斗时生成一条上报 */
  snapshot() {
    const s = this.session;
    if (!s.samples) return null;
    const nav = (this.win && this.win.navigator) || {};
    const perfMem = this.win && this.win.performance && this.win.performance.memory;
    const rep = {
      battleId: this.battleId || undefined,
      deviceTier: this.tier,
      deviceMemoryGb: nav.deviceMemory,
      cpuCores: nav.hardwareConcurrency,
      targetFps: this.governor.targetFps,
      avgFps: Number((s.fpsSum / s.samples).toFixed(2)),
      p5Fps: Number.isFinite(s.minP5) ? Number(s.minP5.toFixed(2)) : undefined,
      droppedFrames: this.meter.dropped,
      effectsLevel: this.governor.effects,
      degradeEvents: this.governor.degradeEvents,
      networkRttMs: nav.connection && nav.connection.rtt,
      jsHeapMb: perfMem ? Number((perfMem.usedJSHeapSize / 1048576).toFixed(1)) : undefined,
    };
    this.session = { frames: 0, fpsSum: 0, samples: 0, minP5: Infinity };
    this.meter.dropped = 0;
    return rep;
  }

  /** 批量上报（失败保留到下次）；页面关闭时用 keepalive */
  async flush(keepalive = false) {
    const snap = this.snapshot();
    if (snap) this.pending.push(snap);
    if (!this.pending.length || !this.api) return;
    const batch = this.pending.splice(0, this.config.report.maxBatch);
    try {
      if (keepalive && this.win && this.win.fetch) {
        const token = this.win.localStorage && this.win.localStorage.getItem('pmg_access_token');
        const base = (this.win.PMG_CONFIG && this.win.PMG_CONFIG.apiBase) || '/v1';
        await this.win.fetch(`${base}/battle/perf/report`, {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ reports: batch }),
        });
      } else {
        await this.api.post('/battle/perf/report', { reports: batch });
      }
    } catch {
      this.pending.unshift(...batch.slice(0, this.config.report.maxBatch));
    }
  }
}
