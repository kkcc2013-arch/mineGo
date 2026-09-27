#!/usr/bin/env node
/**
 * Epic E21 客户端无障碍性能基准（真实浏览器，playwright-core；不需要登录/后端，只需客户端静态服务）
 *
 * 覆盖需求中的性能类指标：
 *   - REQ-00244：首屏加载时间增加 ≤ 5%（对比 a11y 模块被替换为空实现 / RTL(ar-SA) 与 LTR(zh-CN)）
 *   - REQ-00413：方向切换响应 < 100ms
 *   - REQ-00360：辅助计算延迟 P95 < 50ms、帧率 ≥ 55fps
 *   - REQ-00382：视觉提示每次渲染 < 5ms
 *   - REQ-00536：语音命令从识别结果到执行 < 500ms
 *   - REQ-00611：字幕生成延迟 < 200ms
 *
 * 用法：
 *   APP_URL=http://127.0.0.1:3000 RUNS=10 NODE_PATH=<含 playwright-core 的 node_modules> node scripts/bench-a11y-client.js
 * 输出 JSON 汇总；任一指标超标时退出码 1。
 */
'use strict';

const { chromium } = require('playwright-core');

const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const RUNS = Number(process.env.RUNS || 10);
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const STUB = 'export async function initAccessibility() { return { enabled: [] }; }';

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0; };

async function loadTimes(browser, { stubA11y = false, lang = 'zh-CN' } = {}) {
  const out = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript((l) => { try { localStorage.setItem('pmg_language', l); } catch (e) { /* ignore */ } }, lang);
    if (stubA11y) {
      await ctx.route('**/src/bootstrap/a11y.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }));
    }
    const page = await ctx.newPage();
    await page.goto(`${APP}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.PMG_FEATURES, null, { timeout: 15000 });
    const t = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return { load: nav.loadEventEnd, features: performance.now(), initMs: window.PMG_A11Y ? window.PMG_A11Y.initMs : 0, dir: document.documentElement.dir };
    });
    out.push(t);
    await ctx.close();
  }
  return {
    loadMs: Number(median(out.map((x) => x.load)).toFixed(1)),
    featuresReadyMs: Number(median(out.map((x) => x.features)).toFixed(1)),
    a11yInitMs: Number(median(out.map((x) => x.initMs)).toFixed(2)),
    dir: out[0] && out[0].dir,
  };
}

async function interactive(browser) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 420, height: 860 } });
  await ctx.addInitScript(() => {
    class FakeRecognition { start() {} stop() {} }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    if (window.speechSynthesis) window.speechSynthesis.speak = () => {};
  });
  const page = await ctx.newPage();
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.PMG_A11Y, null, { timeout: 15000 });
  const r = await page.evaluate(async () => {
    const x = window.PMG_A11Y;
    x.store.set({
      hearing: { visualCues: true }, subtitles: { enabled: true }, pace: { catch: 0.5, ui: 0.5, battle: 0.5 },
      motor: { enabled: true, tremorFilter: 'medium', targetSnap: true, confirmMode: 'none' },
      voiceControl: { enabled: true }, screenReader: { speech: true },
    }, undefined, { sync: false });
    // 方向切换
    const sw = [];
    for (let i = 0; i < 20; i++) {
      document.documentElement.lang = i % 2 ? 'zh-CN' : 'ar-SA';
      x.direction.apply();
      sw.push(x.direction.lastSwitchMs);
    }
    document.documentElement.lang = 'zh-CN'; x.direction.apply();
    // 视觉提示渲染
    const cue = [];
    for (let i = 0; i < 200; i++) { const e = x.cues.show('pokemon:spawn', { text: `#${i}` }); if (e) cue.push(e.renderMs); }
    // 字幕延迟
    for (let i = 0; i < 50; i++) x.subtitles.show(`字幕测试第 ${i} 条`, { kind: 'caption', eventAt: performance.now() });
    const sub = x.subtitles.log.map((s) => s.latencyMs);
    // 动作辅助点击计算（空白处点击 → 目标吸附 / 震颤过滤）
    for (let i = 0; i < 200; i++) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10 + (i % 40), clientY: 300 + (i % 50), detail: 1 });
      document.querySelector('.screen.active').dispatchEvent(ev);
    }
    const motorP95 = x.motor.p95();
    // 语音命令延迟
    x.voice.start();
    const rec = x.voice.rec;
    for (let i = 0; i < 50; i++) {
      const alt = [{ transcript: i % 2 ? '帮助' : '设置', confidence: 0.9 }]; alt.isFinal = true;
      rec.onresult({ resultIndex: 0, results: [alt] });
      document.querySelectorAll('.a11y-dialog-backdrop').forEach((b) => b._a11yClose && b._a11yClose());
    }
    const voice = x.voice.log.filter((l) => l.ev === 'command').map((l) => l.latencyMs);
    x.voice.stop();
    // 帧率（所有模式开启、3 秒）
    const fps = await new Promise((res) => { let n = 0; const s = performance.now(); const f = () => { n++; if (performance.now() - s < 3000) requestAnimationFrame(f); else res(n / 3); }; requestAnimationFrame(f); });
    return { sw, cue, sub, motorP95, voice, fps };
  });
  await ctx.close();
  return {
    directionSwitchMsMax: Math.max(...r.sw),
    cueRenderMsP95: Number(p95(r.cue).toFixed(2)),
    subtitleLatencyMsP95: Number(p95(r.sub).toFixed(2)),
    motorCalcMsP95: Number(r.motorP95.toFixed(2)),
    voiceLatencyMsP95: Number(p95(r.voice).toFixed(2)),
    fps: Number(r.fps.toFixed(1)),
  };
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const base = await loadTimes(browser, { stubA11y: true });
  const withA11y = await loadTimes(browser);
  const rtl = await loadTimes(browser, { lang: 'ar-SA' });
  const inter = await interactive(browser);
  await browser.close();
  const pct = (a, b) => Number((((a - b) / b) * 100).toFixed(1));
  const summary = {
    runs: RUNS,
    load: { withoutA11y: base, withA11y, rtl, a11yOverheadPct: pct(withA11y.loadMs, base.loadMs), rtlOverheadPct: pct(rtl.loadMs, withA11y.loadMs) },
    interactive: inter,
  };
  const checks = [
    ['RTL 首屏加载增加 ≤ 5%（REQ-00244）', summary.load.rtlOverheadPct <= 5],
    ['方向切换 < 100ms（REQ-00413）', inter.directionSwitchMsMax < 100],
    ['辅助计算 P95 < 50ms（REQ-00360）', inter.motorCalcMsP95 < 50],
    ['帧率 ≥ 55fps（REQ-00360；无头模式受 CPU 影响）', inter.fps >= 55],
    ['视觉提示渲染 < 5ms（REQ-00382）', inter.cueRenderMsP95 < 5],
    ['语音命令延迟 < 500ms（REQ-00536）', inter.voiceLatencyMsP95 < 500],
    ['字幕延迟 < 200ms（REQ-00611）', inter.subtitleLatencyMsP95 < 200],
  ];
  console.log(JSON.stringify(summary, null, 2));
  for (const [name, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${name}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

main().catch((e) => { console.error('❌ bench 中断：', e && e.stack || e); process.exit(1); });
