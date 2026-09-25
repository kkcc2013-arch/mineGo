// frontend/game-client/src/accessibility/photosensitive.js
// REQ-00108：光敏性癫痫安全模式
//   - countFlashes / maxFlashesPerSecond：按 WCAG 2.3.1 在 1 秒滑动窗口内统计闪烁次数（纯函数，可单测）
//   - FlashGuard：监视页面上运行的 CSS/WAAPI 动画，闪烁类动画（透明度/亮度/颜色周期变化）频率 > 3Hz 时自动降速或停止
//   - 紧急停止：一键（或双击 Esc）暂停所有动画
//   - 敏感度预测试：低对比度、≤3Hz 的渐进测试，可随时停止，结果映射为安全模式配置
import { openDialog } from './dialog.js';

export const WCAG_MAX_HZ = 3;

/**
 * 统计闪烁：亮度序列中一对"相反方向且幅度 ≥ threshold"的变化计为一次闪烁
 * @param {{t:number, luminance:number}[]} samples 按时间升序
 * @returns {number[]} 每次闪烁完成的时间戳
 */
export function detectFlashes(samples, threshold = 0.1) {
  const flashes = [];
  let pending = null; // 上一次未配对的变化方向
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].luminance - samples[i - 1].luminance;
    if (Math.abs(d) < threshold) continue;
    const dir = Math.sign(d);
    if (pending !== null && dir !== pending) {
      flashes.push(samples[i].t);
      pending = null;
    } else {
      pending = dir;
    }
  }
  return flashes;
}

/** 任意 1 秒窗口内的最大闪烁次数 */
export function maxFlashesPerSecond(samples, threshold = 0.1, windowMs = 1000) {
  const ts = detectFlashes(samples, threshold);
  let max = 0;
  let j = 0;
  for (let i = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= windowMs) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
}

export function isDangerous(samples, maxHz = WCAG_MAX_HZ) {
  return maxFlashesPerSecond(samples) > maxHz;
}

/** 周期动画（每个周期一次亮-暗往返）在给定播放速率下的闪烁频率 */
export function flashHz(iterationMs, playbackRate = 1) {
  if (!iterationMs || iterationMs <= 0) return 0;
  return (1000 / iterationMs) * Math.abs(playbackRate || 0);
}

/** 让闪烁频率不超过 maxHz 所需的最大播放速率 */
export function safePlaybackRate(iterationMs, maxHz = WCAG_MAX_HZ) {
  const hz = flashHz(iterationMs, 1);
  return hz <= maxHz ? 1 : Number((maxHz / hz).toFixed(4));
}

/** 敏感度测试结果 → 安全模式配置 */
export function mapSensitivity(results) {
  // results: [{hz:1, comfortable:true}, ...]；stopped=true 视为不适
  const bad = results.filter((r) => !r.comfortable).map((r) => r.hz);
  const minBad = bad.length ? Math.min(...bad) : null;
  if (minBad !== null && minBad <= 1) return { sensitivity: 'high', enabled: true, reduceMotion: true, maxFlashHz: 1, flashCues: false };
  if (minBad !== null && minBad <= 2) return { sensitivity: 'medium', enabled: true, reduceMotion: false, maxFlashHz: 1, flashCues: false };
  if (minBad !== null) return { sensitivity: 'medium', enabled: true, reduceMotion: false, maxFlashHz: 2, flashCues: false };
  return { sensitivity: 'low', enabled: false, reduceMotion: false, maxFlashHz: 3, flashCues: true };
}

const FLASHY_PROPS = ['opacity', 'filter', 'backgroundColor', 'background-color', 'color', 'borderColor', 'border-color', 'boxShadow', 'box-shadow', 'visibility'];

function isFlashy(anim) {
  try {
    const eff = anim.effect;
    if (!eff || typeof eff.getKeyframes !== 'function') return false;
    const kfs = eff.getKeyframes();
    return kfs.some((kf) => FLASHY_PROPS.some((p) => kf[p] !== undefined));
  } catch { return false; }
}

export class FlashGuard {
  constructor({ getPrefs, getBaseRate } = {}) {
    this.getPrefs = getPrefs || (() => ({}));
    this.getBaseRate = getBaseRate || (() => 1);
    this.stopped = false;
    this.adjusted = [];
    this._timer = null;
    this._onStart = () => this.scan();
  }

  start() {
    if (this._timer) return;
    document.addEventListener('animationstart', this._onStart, true);
    this._timer = setInterval(() => this.scan(), 400);
    this.scan();
  }

  stop() {
    document.removeEventListener('animationstart', this._onStart, true);
    clearInterval(this._timer);
    this._timer = null;
  }

  /** 扫描运行中的动画：闪烁类动画频率 > maxFlashHz 时降速（安全模式开启时一律限制到上限） */
  scan() {
    if (typeof document.getAnimations !== 'function') return;
    const ps = this.getPrefs().photosensitive || {};
    const maxHz = Math.min(WCAG_MAX_HZ, ps.maxFlashHz || WCAG_MAX_HZ);
    for (const a of document.getAnimations()) {
      if (this.stopped) { if (a.playState === 'running') a.pause(); continue; }
      if (!isFlashy(a)) continue;
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      const dur = timing ? Number(timing.duration) : 0;
      if (!dur) continue;
      const iterations = timing.iterations;
      if (iterations !== Infinity && iterations < 2) continue; // 单次过渡不算闪烁
      const hz = flashHz(dur, a.playbackRate);
      if (hz > maxHz) {
        const rate = safePlaybackRate(dur, maxHz);
        if (ps.enabled && ps.reduceMotion) { a.cancel(); } else { a.playbackRate = rate; }
        a._a11yFlashLimited = true;
        this.adjusted.push({ name: a.animationName || a.id || 'anim', fromHz: Number(hz.toFixed(2)), toRate: rate, t: Date.now() });
        if (this.adjusted.length > 50) this.adjusted.shift();
      }
    }
  }

  /** 紧急停止：暂停所有动画并加 CSS 类；再次调用恢复 */
  setStopped(stopped) {
    this.stopped = !!stopped;
    document.documentElement.classList.toggle('a11y-anim-stopped', this.stopped);
    if (typeof document.getAnimations !== 'function') return;
    for (const a of document.getAnimations()) {
      try {
        if (this.stopped) a.pause();
        else if (a.playState === 'paused') a.play();
      } catch { /* ignore */ }
    }
  }
}

/**
 * 敏感度预测试（低对比度 1/2/3Hz 渐进，永不超过 WCAG 上限，可随时停止）
 * @param {{ onDone: (result) => void, announce?: Function }} opts
 */
export function runSensitivityTest({ onDone, announce } = {}) {
  const steps = [1, 2, 3];
  const results = [];
  let idx = 0;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p id="a11y-ps-desc">本测试以低对比度、不超过每秒 3 次的频率逐级闪动一个色块，用于推荐光敏安全设置。
    任何时候感到不适请立即点击"停止测试"或按 Esc。本测试不是医疗诊断。</p>
    <div class="a11y-ps-stage" aria-hidden="true"><div class="a11y-ps-swatch"></div></div>
    <p class="a11y-ps-step" aria-live="polite"></p>
    <div class="a11y-row">
      <button type="button" class="a11y-btn" data-act="ok">舒适，继续</button>
      <button type="button" class="a11y-btn" data-act="bad">感到不适</button>
      <button type="button" class="a11y-btn a11y-btn-danger" data-act="stop">停止测试</button>
    </div>`;
  let finished = false;
  const finish = (stopped) => {
    if (finished) return;
    finished = true;
    if (stopped && idx < steps.length) results.push({ hz: steps[idx], comfortable: false, stopped: true });
    const cfg = mapSensitivity(results);
    dlg.close();
    if (onDone) onDone({ results, config: cfg, stopped: !!stopped });
  };
  const dlg = openDialog({
    id: 'a11y-ps-test', title: '光敏敏感度测试', content: wrap, describedBy: 'a11y-ps-desc',
    onClose: () => finish(true), initialFocus: '[data-act="stop"]',
  });
  const swatch = wrap.querySelector('.a11y-ps-swatch');
  const stepEl = wrap.querySelector('.a11y-ps-step');
  const show = () => {
    const hz = steps[idx];
    swatch.style.animation = 'none';
    void swatch.offsetWidth;
    swatch.style.animation = `a11y-ps-pulse ${Math.round(1000 / hz)}ms ease-in-out infinite`;
    stepEl.textContent = `第 ${idx + 1}/${steps.length} 级：每秒 ${hz} 次`;
    if (announce) announce(stepEl.textContent);
  };
  wrap.addEventListener('click', (e) => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (!act) return;
    if (act === 'stop') { finish(true); return; }
    results.push({ hz: steps[idx], comfortable: act === 'ok' });
    if (act === 'bad') { idx = steps.length; finish(false); return; }
    idx += 1;
    if (idx >= steps.length) finish(false); else show();
  });
  show();
  return dlg;
}
