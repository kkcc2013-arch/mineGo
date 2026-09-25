#!/usr/bin/env node
/**
 * Epic E21（客户端无障碍）真实浏览器端到端测试：playwright-core + axe-core，驱动 frontend/game-client。
 *
 * 前置：
 *   - 网关 + 客户端开发服务器（scripts/serve-client.js，代理 /v1 到网关）
 *   - playwright-core、axe-core 可被 require（在容器中装在 /data/mineGo-ci-4-e2e，用 NODE_PATH 指定）
 *   - Chrome：/usr/bin/google-chrome
 * 用法：
 *   BASE_URL=http://127.0.0.1:18480 APP_URL=http://127.0.0.1:18490 NODE_PATH=/data/mineGo-ci-4-e2e/node_modules node scripts/e2e-a11y.js
 *
 * 硬件相关能力（振动 / Gamepad / SpeechRecognition / speechSynthesis）用 init script 注入模拟对象测试（⚠️ 真机未验证）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const Redis = require(path.join(ROOT, 'backend', 'node_modules', 'ioredis'));
const { registerUser, call, REDIS_URL } = require('./smoke-a11y');

const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const CENTER = { latitude: 31.2304, longitude: 121.4737 };

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r && typeof r === 'object' && 'ok' in r) record(name, r.ok, r.detail || '');
    else record(name, !!r);
  } catch (e) {
    record(name, false, `异常：${String(e && e.message || e).split('\n')[0].slice(0, 200)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在页面脚本执行前注入：振动/语音合成/语音识别/手柄 的可观测模拟
const INIT = () => {
  window.__vib = [];
  try { Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value(p) { window.__vib.push(p); return true; } }); } catch (e) { /* ignore */ }
  window.__utter = [];
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (u) => { window.__utter.push({ text: u.text, lang: u.lang, rate: u.rate, pitch: u.pitch, volume: u.volume }); };
    window.speechSynthesis.cancel = () => {};
  }
  window.__recs = [];
  class FakeRecognition {
    constructor() { this.started = false; window.__recs.push(this); }
    start() { this.started = true; }
    stop() { this.started = false; }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.__pads = [null, null, null, null];
  try { Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value() { return window.__pads; } }); } catch (e) { /* ignore */ }
  // 可控定位（Chrome 无头模式的定位模拟在容器中不稳定，偶发 POSITION_UNAVAILABLE）
  window.__geo = { latitude: 31.2304, longitude: 121.4737, accuracy: 10 };
  try { const g = JSON.parse(localStorage.getItem('__e2e_geo') || 'null'); if (g) window.__geo = { ...g, accuracy: 10 }; } catch (e) { /* ignore */ }
  window.__geoW = [];
  const pos = () => ({ coords: { ...window.__geo }, timestamp: Date.now() });
  const fakeGeo = {
    getCurrentPosition(ok) { setTimeout(() => ok(pos()), 5); },
    watchPosition(ok) { window.__geoW.push(ok); setTimeout(() => ok(pos()), 5); return window.__geoW.length; },
    clearWatch(id) { window.__geoW[id - 1] = null; },
  };
  try { Object.defineProperty(Navigator.prototype, 'geolocation', { configurable: true, get() { return fakeGeo; } }); } catch (e) { /* ignore */ }
  window.__setGeo = (lat, lng) => { window.__geo = { latitude: lat, longitude: lng, accuracy: 10 }; window.__geoW.forEach((f) => f && f(pos())); };
};

async function axeScan(page, label) {
  const has = await page.evaluate(() => !!window.axe);
  if (!has) await page.addScriptTag({ content: AXE });
  const v = await page.evaluate(async () => {
    const res = await window.axe.run(document, { resultTypes: ['violations'] });
    return res.violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, t: x.nodes.slice(0, 2).map((n) => n.target.join(' ')) }));
  });
  const bad = v.filter((x) => x.impact === 'critical' || x.impact === 'serious');
  record(`axe-core：${label} 无 critical/serious 违规`, bad.length === 0,
    bad.length ? bad.map((x) => `${x.id}(${x.impact})×${x.n} ${x.t.join(' | ')}`).join('; ') : `其余 ${v.length} 项：${v.map((x) => `${x.id}/${x.impact}`).join(',') || '无'}`);
  return v;
}

const A = (page, fn, arg) => page.evaluate(fn, arg);
const prefsOf = (page) => A(page, () => JSON.parse(JSON.stringify(window.PMG_A11Y.store.prefs)));

async function openPanel(page) {
  const open = await A(page, () => !!document.getElementById('a11y-settings'));
  if (!open) await A(page, () => window.showAccessibilitySettings());
  await page.waitForSelector('#a11y-settings [role="dialog"]');
}

/** 通过设置面板的真实控件修改偏好 */
async function panelSet(page, pref, value) {
  await openPanel(page);
  await A(page, (p) => { const el = document.querySelector(`[data-pref="${p}"]`); const d = el && el.closest('details'); if (d) d.open = true; }, pref);
  const loc = page.locator(`#a11y-settings [data-pref="${pref}"]`);
  const type = await loc.evaluate((el) => (el.tagName === 'SELECT' ? 'select' : el.type));
  if (type === 'checkbox') { if (value) await loc.check(); else await loc.uncheck(); }
  else if (type === 'select') await loc.selectOption(String(value));
  else {
    await loc.evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  }
  await sleep(80);
}

async function closePanel(page) {
  if (await A(page, () => !!document.getElementById('a11y-settings'))) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#a11y-settings', { state: 'detached' });
  }
}

async function main() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  const user = await registerUser(redis, '16');
  await redis.quit();
  record('准备：注册测试用户', !!user.token);

  // --disable-dev-shm-usage：容器 /dev/shm 仅 64MB，多个 Chrome 并发时渲染进程会崩溃
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  // serviceWorkers: 'block' —— sw.js 首次 claim 会触发 controllerchange → 整页刷新，干扰测试
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 420, height: 860 }, serviceWorkers: 'block' });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('crash', () => {
    // 高负载下 Chrome 渲染进程偶发崩溃：立即结束并给出已完成项，避免 evaluate 挂起到超时
    console.log('⚠️ 渲染进程崩溃（容器资源竞争），请重跑');
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed（中断）`);
    process.exit(2);
  });
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Service Worker|sw\.js/.test(m.text())) errors.push(m.text()); });

  // ── 1. 登录页：加载、axe、快捷键帮助与焦点陷阱 ───────────────────
  await page.goto(`${APP}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.PMG_FEATURES && window.PMG_FEATURES.a11y);
  await check('装配：features.js → initAccessibility 全部子模块启用', async () => {
    const f = await A(page, () => window.PMG_FEATURES.a11y);
    const need = ['semantics', 'direction', 'pace', 'flashGuard', 'cognitive', 'motor', 'shortcuts', 'gamepad', 'settings'];
    return { ok: need.every((n) => f.enabled.includes(n)) && !f.error, detail: f.enabled.join(',') };
  });
  await check('语义：<main> 地标、表单 label 关联、视口允许缩放', () => A(page, () => !!document.querySelector('main#main-content')
    && document.querySelector('label[for="inp-phone"]') && !/user-scalable=no/.test(document.querySelector('meta[name=viewport]').content)));
  await axeScan(page, '登录页');

  await page.locator('#btn-sms').focus(); // 焦点不在输入框时单键快捷键才生效
  const beforeHelp = await A(page, () => document.activeElement && (document.activeElement.id || document.activeElement.dataset.testid));
  await page.keyboard.press('Shift+Slash');
  await check('键盘：? 打开快捷键帮助（≥15 个快捷键）', async () => {
    await page.waitForSelector('#a11y-help [role="dialog"][aria-modal="true"]', { timeout: 3000 });
    const n = await A(page, () => document.querySelectorAll('#a11y-help tbody tr').length);
    return { ok: n >= 19, detail: `${n} 行（含 Tab/Enter/Esc Esc 说明）` };
  });
  await check('键盘：对话框焦点陷阱（Tab 30 次不离开对话框）', async () => {
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
      const inside = await A(page, () => !!document.activeElement.closest('#a11y-help'));
      if (!inside) return { ok: false, detail: `第 ${i + 1} 次离开` };
    }
    return true;
  });
  await page.keyboard.press('Escape');
  await check('键盘：Esc 关闭对话框并恢复焦点', async () => {
    await page.waitForSelector('#a11y-help', { state: 'detached', timeout: 2000 });
    const now = await A(page, () => document.activeElement && (document.activeElement.id || document.activeElement.dataset.testid));
    return { ok: now === beforeHelp, detail: `before=${beforeHelp} after=${now}` };
  });
  await check('焦点可视：focus-visible 轮廓 ≥ 3px', async () => {
    await page.keyboard.press('Tab');
    const w = await A(page, () => parseFloat(getComputedStyle(document.activeElement).outlineWidth));
    return { ok: w >= 3, detail: `${w}px` };
  });

  // ── 2. 登录后地图：卡片语义、地图播报、键盘导航 ─────────────────
  await A(page, ([a, r]) => { localStorage.setItem('pmg_access_token', a); localStorage.setItem('pmg_refresh_token', r); }, [user.token, user.refreshToken]);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#map.active', { timeout: 15000 });
  await check('地图：精灵卡片为可聚焦按钮，aria-label 含 CP/方向/距离', async () => {
    await page.waitForSelector('#map-body .entity-card.a11y-spawn-card[role="button"][tabindex="0"]', { timeout: 20000 });
    const label = await A(page, () => document.querySelector('#map-body .a11y-spawn-card').getAttribute('aria-label'));
    return { ok: /CP/.test(label) && /方向约 \d+ 米/.test(label), detail: label };
  });
  await check('读屏：地图加载后 aria-live 播报附近摘要（数量/方向/距离）', async () => {
    await page.waitForFunction(() => window.PMG_A11Y.announcer.history.some((h) => /附近有 \d+ 只精灵/.test(h.message)), null, { timeout: 8000 });
    const m = await A(page, () => window.PMG_A11Y.announcer.history.find((h) => /附近有/.test(h.message)).message);
    return { ok: /方向约 \d+ 米/.test(m), detail: m };
  });
  await check('读屏：aria-live 区域（polite/assertive）存在且写入最新播报', async () => {
    await A(page, () => window.PMG_A11Y.announcer.announce('测试播报一二三', { level: 'important' }));
    await sleep(120);
    return A(page, () => document.querySelector('#a11y-live-polite[aria-live="polite"][role="status"]').textContent === '测试播报一二三'
      && !!document.querySelector('#a11y-live-assertive[aria-live="assertive"]'));
  });
  await axeScan(page, '地图页');
  await A(page, () => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await check('键盘：J/K 在精灵卡片间移动焦点', async () => {
    await page.keyboard.press('j');
    const a = await A(page, () => document.activeElement.classList.contains('entity-card'));
    await page.keyboard.press('k');
    const b = await A(page, () => document.activeElement.classList.contains('entity-card'));
    return a && b;
  });
  await check('键盘：WASD 平移地图（滚动地图区域）', async () => {
    await A(page, () => { const b = document.getElementById('map-body'); const pad = document.createElement('div'); pad.style.height = '2000px'; pad.id = 'e2e-pad'; b.appendChild(pad); b.scrollTop = 0; });
    await page.keyboard.press('s'); await page.keyboard.press('s');
    const down = await A(page, () => document.getElementById('map-body').scrollTop);
    await page.keyboard.press('w');
    const up = await A(page, () => document.getElementById('map-body').scrollTop);
    await A(page, () => document.getElementById('e2e-pad')?.remove());
    return { ok: down >= 200 && up < down, detail: `s,s → ${down}px；w → ${up}px` };
  });
  await check('键盘：L 播报附近、I 播报状态、P/M 切换页面（含 aria-current）', async () => {
    await page.keyboard.press('l');
    await page.keyboard.press('i');
    await sleep(300);
    const said = await A(page, () => window.PMG_A11Y.announcer.history.slice(-3).map((h) => h.message).join(' | '));
    await page.keyboard.press('p');
    const prof = await A(page, () => document.getElementById('profile').classList.contains('active') && document.getElementById('tab-profile').getAttribute('aria-current') === 'page');
    await page.keyboard.press('m');
    const map = await A(page, () => document.getElementById('map').classList.contains('active'));
    return { ok: /附近有/.test(said) && /精灵球/.test(said) && prof && map, detail: said.slice(0, 120) };
  });

  // ── 3. 设置面板：各模式生效 ────────────────────────────────
  await page.keyboard.press('p');
  await page.locator('[data-testid="accessibility-settings"]').focus();
  await page.keyboard.press('Enter');
  await check('入口：我的 → 无障碍设置（键盘 Enter 打开，role=dialog）', async () => {
    await page.waitForSelector('#a11y-settings [role="dialog"][aria-modal="true"]', { timeout: 3000 });
    return A(page, () => document.querySelectorAll('#a11y-settings [data-pref]').length >= 60);
  });
  await axeScan(page, '无障碍设置面板');

  await panelSet(page, 'color.highContrast', true);
  await check('高对比度：类名 + 纯黑背景/白字（对比度 21:1）', () => A(page, () => {
    const cs = getComputedStyle(document.documentElement);
    return document.documentElement.classList.contains('a11y-high-contrast') && cs.getPropertyValue('--bg').trim() === '#000000' && cs.getPropertyValue('--text').trim() === '#ffffff';
  }));
  await closePanel(page);
  await axeScan(page, '高对比度模式下的我的页面');
  await panelSet(page, 'color.highContrast', false);

  await panelSet(page, 'color.mode', 'protanopia');
  await panelSet(page, 'color.shapes', true);
  await panelSet(page, 'color.filter', true);
  await check('色盲模式：红色盲调色板替换 + daltonize 滤镜 + 形状标识', () => A(page, () => {
    const cs = getComputedStyle(document.documentElement);
    return document.documentElement.dataset.a11yCvd === 'protanopia' && cs.getPropertyValue('--red').trim() === '#d55e00'
      && /a11y-cvd-correct/.test(document.body.style.filter) && document.documentElement.classList.contains('a11y-shapes')
      && document.querySelector('#a11y-cvd-correct feColorMatrix').getAttribute('values').split(' ').length === 20;
  }));
  await panelSet(page, 'color.simulate', 'deuteranopia');
  await check('色盲模拟预览（开发者）：模拟滤镜叠加', () => A(page, () => /a11y-cvd-sim/.test(document.body.style.filter)));
  await panelSet(page, 'color.simulate', 'none');
  await panelSet(page, 'color.filter', false);
  await check('自定义调色板：对比度检查与自动修正', async () => {
    await panelSet(page, 'color.mode', 'custom');
    await A(page, () => { const el = document.getElementById('a11y-pal-muted'); el.value = '#303030'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await sleep(100);
    const bad = await A(page, () => document.querySelector('[data-testid="contrast-muted"]').classList.contains('bad'));
    await page.locator('#a11y-settings [data-action="palette-fix"]').click();
    await sleep(100);
    const fixed = await A(page, () => ({ ok: document.querySelector('[data-testid="contrast-muted"]').classList.contains('ok'), txt: document.querySelector('[data-testid="palette-issues"]').textContent, muted: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() }));
    return { ok: bad && fixed.ok, detail: `${fixed.txt} muted=${fixed.muted}` };
  });
  await panelSet(page, 'color.mode', 'protanopia');

  await panelSet(page, 'photosensitive.enabled', true);
  await check('光敏安全模式：类名 + 紧急停止按钮', () => A(page, () => document.documentElement.classList.contains('a11y-photosafe') && !!document.querySelector('[data-testid="a11y-emergency-stop"]')));
  await closePanel(page);
  await check('光敏：>3Hz 闪烁动画被自动降频到 ≤3Hz（WCAG 2.3.1）', async () => {
    await A(page, () => {
      const st = document.createElement('style');
      st.textContent = '@keyframes e2eblink{0%,100%{opacity:1}50%{opacity:0}} #e2e-blink{width:40px;height:40px;background:#fff;animation:e2eblink 100ms linear infinite}';
      document.head.appendChild(st);
      const d = document.createElement('div'); d.id = 'e2e-blink'; document.body.appendChild(d);
    });
    await sleep(700);
    const r = await A(page, () => { const a = document.getElementById('e2e-blink').getAnimations()[0]; return a ? { rate: a.playbackRate, state: a.playState } : { rate: 0, state: 'cancelled' }; });
    await A(page, () => document.getElementById('e2e-blink').remove());
    const hz = (1000 / 100) * r.rate;
    return { ok: hz <= 3.0001, detail: `10Hz → playbackRate ${r.rate}（${hz.toFixed(2)}Hz, ${r.state}）` };
  });
  await check('光敏：双击 Esc 紧急停止所有动画，再次双击恢复', async () => {
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const stopped = await A(page, () => document.documentElement.classList.contains('a11y-anim-stopped') && document.getAnimations().every((a) => a.playState !== 'running'));
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    const resumed = await A(page, () => !document.documentElement.classList.contains('a11y-anim-stopped'));
    return stopped && resumed;
  });
  await check('光敏：敏感度测试可随时停止，结果映射为配置', async () => {
    await panelSet(page, 'photosensitive.enabled', false);
    await page.locator('#a11y-settings [data-action="ps-test"]').click();
    await page.waitForSelector('#a11y-ps-test [role="dialog"]');
    const maxHz = await A(page, () => { const d = getComputedStyle(document.querySelector('.a11y-ps-swatch')).animationDuration; return 1000 / (d.endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000); });
    await page.locator('#a11y-ps-test [data-act="ok"]').click();
    await page.locator('#a11y-ps-test [data-act="stop"]').click();
    await page.waitForSelector('#a11y-ps-test', { state: 'detached' });
    const p = await prefsOf(page);
    return { ok: p.photosensitive.tested && p.photosensitive.enabled && p.photosensitive.sensitivity === 'medium' && maxHz <= 3, detail: `第1级 ${maxHz}Hz；停止于 2Hz → ${p.photosensitive.sensitivity}` };
  });
  await openPanel(page);

  await panelSet(page, 'pace.preset', 'accessible');
  await check('慢速模式 0.5x：动画 playbackRate=0.5（时长 ×2）、捕捉 timeScale=0.5、倍率徽章', async () => {
    await A(page, () => { const d = document.createElement('div'); d.id = 'e2e-anim'; d.style.animation = 'bob 3s ease-in-out infinite'; document.body.appendChild(d); });
    await sleep(100);
    const r = await A(page, () => {
      const a = document.getElementById('e2e-anim').getAnimations()[0];
      const eff = a.effect.getComputedTiming().duration / a.playbackRate;
      document.getElementById('e2e-anim').remove();
      return { rate: a.playbackRate, eff, ts: window.PMG_A11Y.pace.catchScale(), engine: window.PMG_A11Y.pace.catchEng.timeScale, badge: (document.querySelector('[data-testid="a11y-speed-badge"]') || {}).textContent };
    });
    return { ok: r.rate === 0.5 && r.eff === 6000 && r.ts === 0.5 && r.engine === 0.5 && /0\.5/.test(r.badge || ''), detail: JSON.stringify(r) };
  });
  await check('慢速模式：提示显示时长 ×2（holdScale）', () => A(page, () => window.PMG_A11Y.holdScale() === 2));

  await panelSet(page, 'hearing.visualCues', true);
  await panelSet(page, 'subtitles.enabled', true);
  await check('听障视觉提示：P0 事件 ≥2 种视觉通道（图标文字 + 边框），光敏模式下为静态', async () => {
    const r = await A(page, () => { const e = window.PMG_A11Y.cues.show('pokemon:spawn', { text: '测试精灵' }); return { e, border: document.getElementById('a11y-cue-border').className, txt: document.querySelector('#a11y-cues .a11y-cue:last-child .a11y-cue-text').textContent, live: document.getElementById('a11y-cues').getAttribute('aria-live') }; });
    return { ok: r.e.channels.length >= 3 && /static/.test(r.border) && /精灵出现/.test(r.txt) && r.e.holdMs >= 2000 && r.live === 'polite', detail: `${r.e.channels.join('+')} ${r.border} hold=${r.e.holdMs}ms` };
  });
  await check('实时字幕：音效描述字幕，延迟 < 200ms，样式可配置', async () => {
    await panelSet(page, 'subtitles.size', 'xlarge');
    const r = await A(page, () => { window.PMG_A11Y.emit('item:pickup', {}); const log = window.PMG_A11Y.subtitles.log; const last = log[log.length - 1]; return { last, size: document.getElementById('a11y-subtitles').dataset.size, fs: getComputedStyle(document.querySelector('.a11y-subtitle-line')).fontSize }; });
    return { ok: r.last && r.last.latencyMs < 200 && r.size === 'xlarge' && r.fs === '26px', detail: `${r.last && r.last.text} ${r.last && r.last.latencyMs}ms ${r.fs}` };
  });

  await panelSet(page, 'haptics.intensity', 150);
  await check('触觉：强度 150% 缩放震动时长，按场景开关', async () => {
    await page.locator('#a11y-settings [data-action="haptic"][data-pattern="catch_success"]').click();
    const on = await A(page, () => window.__vib[window.__vib.length - 1]);
    await panelSet(page, 'haptics.scenes.catch', false);
    const before = await A(page, () => window.__vib.length);
    await page.locator('#a11y-settings [data-action="haptic"][data-pattern="catch_success"]').click();
    const after = await A(page, () => ({ n: window.__vib.length, last: window.PMG_A11Y.haptics.history.slice(-1)[0].reason }));
    await panelSet(page, 'haptics.scenes.catch', true);
    return { ok: JSON.stringify(on) === JSON.stringify([150, 50, 45, 50, 150]) && after.n === before && after.last === 'scene-off', detail: `${JSON.stringify(on)} / 关闭后 ${after.last}` };
  });

  await panelSet(page, 'cognitive.dyslexiaFont', true);
  await panelSet(page, 'cognitive.simplified', true);
  await check('认知：阅读障碍字体（OpenDyslexic 加载）与简化模式', async () => {
    await A(page, () => document.fonts.load('16px OpenDyslexic'));
    return A(page, () => document.fonts.check('16px OpenDyslexic') && /OpenDyslexic/.test(getComputedStyle(document.body).fontFamily) && document.documentElement.classList.contains('a11y-simplified'));
  });
  await panelSet(page, 'cognitive.dyslexiaFont', false);
  await panelSet(page, 'cognitive.simplified', false);

  await panelSet(page, 'motor.preset', 'heavy');
  await check('动作辅助：重度预设（瞄准 0.85、窗口 ×3、一键投掷、放大目标、徽章）', () => A(page, () => {
    const p = window.PMG_A11Y.store.prefs.motor;
    return p.enabled && p.aimAssist === 'high' && p.windowMultiplier === 3 && p.oneTapThrow && window.PMG_A11Y.pace.catchEng.aimAssist === 0.85
      && Math.abs(window.PMG_A11Y.pace.catchScale() - 0.5 / 3) < 1e-3 && document.documentElement.classList.contains('a11y-large-targets')
      && !!document.querySelector('[data-testid="a11y-motor-badge"]');
  }));

  await check('快捷键自定义：重新映射"地图"为 G，保留组合键被拒绝', async () => {
    await A(page, () => { document.querySelector('[data-action="rebind"][data-target="goMap"]').closest('details').open = true; });
    await page.locator('#a11y-settings [data-action="rebind"][data-target="goMap"]').click();
    await page.keyboard.press('g');
    await sleep(100);
    await page.locator('#a11y-settings [data-action="rebind"][data-target="goProfile"]').click();
    await page.keyboard.press('F5'); // 浏览器保留键（捕获时 preventDefault，不会刷新）
    await sleep(100);
    const msg = await A(page, () => document.querySelector('[data-testid="a11y-rebind-msg"]').textContent);
    const b = await A(page, () => window.PMG_A11Y.shortcuts.bindings());
    return { ok: b.goMap === 'g' && b.goProfile === 'p' && /保留/.test(msg), detail: `goMap=${b.goMap} msg=${msg}` };
  });

  // ── 4. 持久化：本地 + 经网关存到服务端 + 跨设备恢复 ─────────────
  await closePanel(page);
  await check('持久化：偏好经网关 PUT /v1/users/me/preferences/a11y 存到服务端（motor 默认不上传）', async () => {
    await A(page, () => window.PMG_A11Y.store.push());
    const r = await call('GET', '/v1/users/me/preferences/a11y', { token: user.token });
    const p = r.data && r.data.prefs;
    return { ok: r.status === 200 && p && p.color.mode === 'protanopia' && p.pace.catch === 0.5 && p.keyboard.bindings.goMap === 'g' && p.motor === undefined,
      detail: `status=${r.status} color=${p && p.color.mode} pace=${p && p.pace.catch} motor=${p && p.motor ? 'uploaded' : 'local-only'}` };
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#map.active', { timeout: 15000 });
  await check('持久化：刷新后设置仍生效（localStorage）', () => A(page, () => document.documentElement.dataset.a11yCvd === 'protanopia'
    && document.documentElement.classList.contains('a11y-photosafe') && window.PMG_A11Y.pace.catchScale() < 0.5));
  await check('持久化：清空本地后从服务端恢复（跨设备）', async () => {
    await A(page, () => localStorage.removeItem('pmg_a11y_prefs_v1'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.PMG_A11Y && document.documentElement.dataset.a11yCvd === 'protanopia', null, { timeout: 8000 });
    const p = await prefsOf(page);
    return { ok: p.pace.catch === 0.5 && p.keyboard.bindings.goMap === 'g' && p.motor.enabled === false, detail: `motor 仅本地 → 新设备为默认 enabled=${p.motor.enabled}` };
  });
  await check('重新映射的快捷键生效：G → 地图', async () => {
    await page.keyboard.press('p');
    await page.keyboard.press('g');
    return A(page, () => document.getElementById('map').classList.contains('active'));
  });

  // ── 5. 捕捉：语音描述、属性形状、精灵球单选、慢速圆环、一键投掷、视觉提示 ──
  await A(page, () => window.PMG_A11Y.store.set({ motor: { enabled: true, preset: 'heavy', aimAssist: 'high', windowMultiplier: 1, oneTapThrow: true, trajectory: true } }));
  // 选离当前位置最近的精灵，并把定位移到它旁边（避免服务端"距离过远"/瞬移判定）
  const near = await call('GET', `/v1/map/nearby?lat=${CENTER.latitude}&lng=${CENTER.longitude}&radius=1000`, { token: user.token });
  const d2 = (p) => (Number(p.lat) - CENTER.latitude) ** 2 + (Number(p.lng) - CENTER.longitude) ** 2;
  const target = near.data && [...(near.data.wildPokemons || [])].sort((a, b) => d2(a) - d2(b))[0];
  if (target) {
    const tp = { latitude: Number(target.lat) + 0.00004, longitude: Number(target.lng) };
    // 服务端先收到目标附近的位置，再以该位置作为首个定位重新加载（客户端 LocationManager 会丢弃 >100km/h 的跳变）
    await call('POST', '/v1/location', { token: user.token, body: { lat: tp.latitude, lng: tp.longitude, accuracy: 10 } });
    await A(page, (g) => localStorage.setItem('__e2e_geo', JSON.stringify(g)), tp);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#map.active', { timeout: 15000 });
    await page.waitForFunction(([la, ln]) => {
      const p = window.PMG_A11Y.locMgr && window.PMG_A11Y.locMgr.currentPosition;
      return p && Math.abs(p.lat - la) < 0.00002 && Math.abs(p.lng - ln) < 0.00002;
    }, [tp.latitude, tp.longitude], { timeout: 15000 }).catch(() => console.log('  (定位未更新)'));
    await page.waitForSelector('#map-body .a11y-spawn-card', { timeout: 15000 });
    await A(page, () => window.PMG_A11Y.store.set({ motor: { enabled: true, preset: 'heavy', aimAssist: 'high', windowMultiplier: 1, oneTapThrow: true, trajectory: true } }));
  }
  const toasts = () => A(page, () => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' / '));
  await A(page, (id) => {
    const card = [...document.querySelectorAll('#map-body .a11y-spawn-card')].find((c) => c.dataset.spawnId === String(id)) || document.querySelector('#map-body .a11y-spawn-card');
    card.focus();
  }, target && target.id);
  await check('读屏：V 键在地图卡片上获取精灵语音描述（经网关 API）', async () => {
    await page.keyboard.press('v');
    await page.waitForFunction(() => window.PMG_A11Y.state.lastDescription, null, { timeout: 5000 });
    const d = await A(page, () => window.PMG_A11Y.state.lastDescription);
    return { ok: /图鉴编号/.test(d.text) && d.sections.length >= 4, detail: d.text.slice(0, 80) };
  });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#catch.active', { timeout: 8000 });
  await check('捕捉：进入时播报精灵与操作提示；属性形状标识', async () => {
    try { await page.waitForSelector('#a11y-type-badges .a11y-type-badge', { timeout: 6000 }); } catch (e) { return { ok: false, detail: `catch=${await A(page, () => document.getElementById('catch').classList.contains('active'))} toasts=${await toasts()}` }; }
    const r = await A(page, () => ({ said: window.PMG_A11Y.announcer.history.map((h) => h.message).find((m) => /遭遇野生/.test(m)), badge: document.querySelector('#a11y-type-badges').textContent }));
    return { ok: !!r.said && r.badge.trim().length > 0, detail: `${r.said} | ${r.badge}` };
  });
  await check('捕捉：投掷轨迹预览（贝塞尔 + 落点）与准确度 progressbar', async () => {
    await sleep(400);
    const r = await A(page, () => {
      const svg = document.getElementById('a11y-trajectory');
      const bar = document.querySelector('[data-testid="accuracy-bar"]');
      return { svg: !!svg, d: svg && svg.querySelector('path') && svg.querySelector('path').getAttribute('d'), target: !!(svg && svg.querySelector('.a11y-traj-target')),
        role: bar.getAttribute('role'), now: bar.getAttribute('aria-valuenow'), text: bar.getAttribute('aria-valuetext'), motor: window.PMG_A11Y.motor.active(), traj: window.PMG_A11Y.store.prefs.motor.trajectory };
    });
    return { ok: r.svg && / Q /.test(r.d || '') && r.target && r.role === 'progressbar' && Number(r.now) > 0 && /%，/.test(r.text || ''), detail: JSON.stringify(r) };
  });
  await check('键盘：数字键选择精灵球，aria-checked 同步', async () => {
    await page.keyboard.press('2');
    await sleep(100);
    return A(page, () => document.getElementById('chip-great').getAttribute('aria-checked') === 'true' && document.getElementById('chip-poke').getAttribute('aria-checked') === 'false');
  });
  await page.keyboard.press('1');
  await axeScan(page, '捕捉页');
  await check('慢速模式：圆环显示步长随倍率变化（0.5x 收缩速度减半）', async () => {
    const w = await A(page, async () => {
      const f = document.getElementById('ring-fill');
      const a = parseFloat(f.style.width); await new Promise((r) => setTimeout(r, 500)); const b = parseFloat(f.style.width);
      return Math.abs(a - b);
    });
    // 0.5x × (1/3 窗口×… 此处 motor.windowMultiplier=1) → 步长 0.25%/帧，500ms ≈ 30 帧 ≈ 7.5%（1.0x 为 15%）
    return { ok: w > 0 && w < 11, detail: `500ms 内变化 ${w.toFixed(2)}%` };
  });
  let thrown = false;
  await check('动作辅助：一键投掷（T）等待最佳时机后自动投出', async () => {
    await page.waitForFunction(() => !document.getElementById('throw-btn').disabled, null, { timeout: 8000 });
    await page.keyboard.press('t');
    await page.waitForFunction(() => window.PMG_A11Y.motor.stats.autoThrows > 0, null, { timeout: 12000 });
    thrown = true;
    return true;
  });
  if (thrown) {
    await check('投掷结果：视觉提示/字幕/震动（CatchEngine 触觉）', async () => {
      await page.waitForFunction(() => window.PMG_A11Y.cues.log.some((c) => /^catch:(success|fled|escape)$/.test(c.type))
        || [...document.querySelectorAll('.toast.err')].some((t) => /投球|捕捉|会话/.test(t.textContent)), null, { timeout: 15000 }).catch(() => {});
      const r = await A(page, () => ({ cues: window.PMG_A11Y.cues.log.map((c) => c.type), subs: window.PMG_A11Y.subtitles.log.map((s) => s.text).slice(-3), hap: window.PMG_A11Y.haptics.history.map((h) => h.pattern).filter((p) => /^catch_|^throw_/.test(p)) }));
      return { ok: r.hap.includes('catch_throw') && (r.cues.some((c) => /^catch:(success|fled|escape)$/.test(c))), detail: `${r.cues.slice(-3).join(',')} | ${r.subs.join(' / ')} | ${r.hap.slice(-3).join(',')} | toasts=${await toasts()}` };
    });
  }
  await page.waitForTimeout(2500);
  if (await A(page, () => document.getElementById('catch').classList.contains('active'))) {
    await page.keyboard.press('Escape');
    await check('键盘：Esc 在捕捉页逃跑返回地图', async () => { await page.waitForSelector('#map.active', { timeout: 5000 }); return true; });
  }

  // ── 6. 手柄（模拟 Gamepad） ─────────────────────────────────
  await check('手柄：连接后 2 秒内提示并识别 Xbox 控制器', async () => {
    const t0 = Date.now();
    await A(page, () => {
      const btn = () => ({ pressed: false, value: 0 });
      window.__pad = { id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn), vibrationActuator: { playEffect: (t, o) => { (window.__rumble = window.__rumble || []).push(o); return Promise.resolve('complete'); } } };
      window.__pads[0] = window.__pad;
      const ev = new Event('gamepadconnected'); ev.gamepad = window.__pad; window.dispatchEvent(ev);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /已连接手柄：Xbox/.test(t.textContent)), null, { timeout: 2000 });
    return { ok: true, detail: `${Date.now() - t0}ms` };
  });
  const press = async (i) => {
    await A(page, (b) => { window.__pad.buttons[b] = { pressed: true, value: 1 }; }, i);
    await sleep(80);
    await A(page, (b) => { window.__pad.buttons[b] = { pressed: false, value: 0 }; }, i);
    await sleep(80);
  };
  await check('手柄：D-Pad 按 Tab 顺序移动焦点，A 激活，B 返回', async () => {
    await A(page, () => document.activeElement && document.activeElement.blur());
    await press(13);
    const f1 = await A(page, () => { window.__f1 = document.activeElement; return document.activeElement !== document.body && (document.activeElement.getAttribute('aria-label') || document.activeElement.className); });
    await press(13);
    const f2 = await A(page, () => (window.__f1 !== document.activeElement && document.activeElement !== document.body ? (document.activeElement.getAttribute('aria-label') || document.activeElement.className) : null));
    await A(page, () => document.getElementById('tab-profile').focus());
    await press(0);
    const prof = await A(page, () => document.getElementById('profile').classList.contains('active'));
    await press(1);
    const back = await A(page, () => document.getElementById('map').classList.contains('active'));
    return { ok: !!f1 && f1 !== f2 && prof && back, detail: `${f1} → ${f2}` };
  });
  await check('手柄：左摇杆平滑滚动地图、振动镜像可关闭', async () => {
    await A(page, () => { const b = document.getElementById('map-body'); const pad = document.createElement('div'); pad.style.height = '2000px'; pad.id = 'e2e-pad'; b.appendChild(pad); b.scrollTop = 0; window.__pad.axes[1] = 0.9; });
    await sleep(400);
    const y = await A(page, () => { window.__pad.axes[1] = 0; return document.getElementById('map-body').scrollTop; });
    await A(page, () => document.getElementById('e2e-pad')?.remove());
    await A(page, () => window.PMG_A11Y.haptics.vibrate('tap'));
    const rumble = await A(page, () => (window.__rumble || []).length);
    await A(page, () => window.PMG_A11Y.store.set('gamepad.vibration', false));
    await A(page, () => window.PMG_A11Y.haptics.vibrate('tap'));
    const rumble2 = await A(page, () => (window.__rumble || []).length);
    return { ok: y > 50 && rumble >= 1 && rumble2 === rumble, detail: `scrollTop=${y} rumble=${rumble}→${rumble2}` };
  });
  await check('手柄：设置面板显示控制器名称，按键映射可自定义并持久化', async () => {
    await openPanel(page);
    await A(page, () => { document.querySelector('[data-render="gamepad"]').closest('details').open = true; document.querySelector('[data-render="gamepad"] details').open = true; });
    const status = await A(page, () => document.querySelector('[data-testid="gamepad-status"]').textContent);
    await page.locator('#a11y-settings [data-action="gp-map"][data-target="throw"]').click();
    await press(3);
    await sleep(100);
    const m = await A(page, () => JSON.parse(localStorage.getItem('pmg_a11y_prefs_v1')).prefs.gamepad.mapping);
    await closePanel(page);
    return { ok: /Xbox/.test(status) && m.throw === 3, detail: `${status} mapping.throw=${m.throw}` };
  });
  await check('手柄：断开后提示且不崩溃', async () => {
    await A(page, () => { window.__pads[0] = null; const ev = new Event('gamepaddisconnected'); ev.gamepad = window.__pad; window.dispatchEvent(ev); });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /手柄已断开/.test(t.textContent)), null, { timeout: 2000 });
    return A(page, () => window.PMG_A11Y.gamepad.pads.size === 0 && document.getElementById('map').classList.contains('active'));
  });

  // ── 6b. 播报级别、空间音频、竞技模式、快捷键切换、性能 ─────────────
  await check('读屏：播报级别 minimal 只播重要事件，critical 只播关键提示', () => A(page, () => {
    const a = window.PMG_A11Y.announcer;
    window.PMG_A11Y.store.set('screenReader.verbosity', 'minimal');
    const r1 = [a.announce('普通信息', { level: 'info' }), a.announce('重要信息', { level: 'important' })];
    window.PMG_A11Y.store.set('screenReader.verbosity', 'critical');
    const r2 = [a.announce('重要信息2', { level: 'important' }), a.announce('关键信息', { level: 'critical' })];
    window.PMG_A11Y.store.set('screenReader.verbosity', 'full');
    return JSON.stringify([r1, r2]) === JSON.stringify([[false, true], [false, true]]);
  }));
  await check('空间音频：聚焦精灵卡片播放距离音调，声像随方位（-1 左 … 1 右）', async () => {
    await A(page, () => window.PMG_A11Y.store.set('screenReader.spatialAudio', true));
    await A(page, () => { document.activeElement && document.activeElement.blur(); });
    const before = await A(page, () => window.PMG_A11Y.announcer.toneLog.length);
    await page.keyboard.press('j');
    await sleep(100);
    const r = await A(page, () => ({ n: window.PMG_A11Y.announcer.toneLog.length, last: window.PMG_A11Y.announcer.toneLog.slice(-1)[0],
      focus: document.activeElement && document.activeElement.className, screen: (document.querySelector('.screen.active') || {}).id,
      dialog: !!document.querySelector('.a11y-dialog-backdrop, #lang-modal'), nearby: !!window.PMG_A11Y.state.nearby }));
    await A(page, () => window.PMG_A11Y.store.set('screenReader.spatialAudio', false));
    return { ok: r.n > before && r.last && r.last.freq >= 220 && r.last.freq <= 880 && Math.abs(r.last.pan) <= 1, detail: JSON.stringify(r) };
  });
  await check('公平性：竞技模式（PVP/团战/排行榜）下节奏与动作辅助自动禁用并显示标识', async () => {
    const r = await A(page, () => {
      const x = window.PMG_A11Y;
      x.store.set({ pace: { catch: 0.5, ui: 0.5 }, motor: { enabled: true } });
      x.setCompetitive('pvp');
      const during = { catch: x.pace.catchScale(), ui: x.pace.uiScale(), motor: x.motor.active(), aim: x.pace.catchEng.aimAssist, badge: !!document.querySelector('[data-testid="a11y-competitive"]') };
      x.setCompetitive(null);
      return { during, after: { catch: x.pace.catchScale(), motor: x.motor.active() } };
    });
    return { ok: r.during.catch === 1 && r.during.ui === 1 && !r.during.motor && r.during.aim === 0 && r.during.badge && r.after.motor && r.after.catch < 1, detail: JSON.stringify(r) };
  });
  await check('快捷键：Ctrl+Shift+M 切换动作辅助', async () => {
    const a = await A(page, () => window.PMG_A11Y.store.prefs.motor.enabled);
    await page.keyboard.press('Control+Shift+M');
    const b = await A(page, () => window.PMG_A11Y.store.prefs.motor.enabled);
    await page.keyboard.press('Control+Shift+M');
    const c = await A(page, () => window.PMG_A11Y.store.prefs.motor.enabled);
    return { ok: a !== b && a === c, detail: `${a}→${b}→${c}` };
  });
  await check('性能：辅助计算 P95 < 50ms、视觉提示渲染 < 5ms、偏好保存 < 100ms（附帧率/初始化耗时）', async () => {
    const r = await A(page, async () => {
      const x = window.PMG_A11Y;
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) x.store.set('screenReader.rate', 1 + (i % 5) / 10, { sync: false });
      const saveMs = (performance.now() - t0) / 20;
      const renders = x.cues.log.map((c) => c.renderMs);
      const fps = await new Promise((res) => { let n = 0; const s = performance.now(); const f = () => { n++; if (performance.now() - s < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); });
      return { p95: x.motor.p95(), maxRender: Math.max(0, ...renders), saveMs: Number(saveMs.toFixed(2)), fps, initMs: x.initMs };
    });
    return { ok: r.p95 < 50 && r.maxRender < 5 && r.saveMs < 100, detail: JSON.stringify(r) };
  });

  // ── 7. 语音控制（模拟 SpeechRecognition）与 TTS ────────────────
  await A(page, () => window.PMG_A11Y.store.set({ voiceControl: { enabled: true, customCommands: [{ phrase: '去背包看看', action: 'goProfile' }] }, screenReader: { speech: true, rate: 1.3 } }));
  const say = (text, conf = 0.9) => A(page, ([tx, c]) => {
    const rec = window.__recs[window.__recs.length - 1];
    const alt = [{ transcript: tx, confidence: c }]; alt.isFinal = true;
    rec.onresult({ resultIndex: 0, results: [alt] });
  }, [text, conf]);
  await check('语音控制：中文命令"打开背包"执行，响应延迟 < 500ms', async () => {
    await say('打开背包');
    await sleep(100);
    const r = await A(page, () => ({ prof: document.getElementById('profile').classList.contains('active'), log: window.PMG_A11Y.voice.log.slice(-1)[0] }));
    return { ok: r.prof && r.log.latencyMs < 500, detail: `${r.log.action} ${r.log.latencyMs}ms` };
  });
  await check('语音控制：英文 "open map"、日文 "マイページ"、自定义命令', async () => {
    await say('open map'); await sleep(50);
    const a = await A(page, () => document.getElementById('map').classList.contains('active'));
    await say('マイページ'); await sleep(50);
    const b = await A(page, () => document.getElementById('profile').classList.contains('active'));
    await say('open map'); await sleep(50);
    await say('去背包看看'); await sleep(50);
    const c = await A(page, () => document.getElementById('profile').classList.contains('active') && window.PMG_A11Y.voice.log.slice(-1)[0].source === 'custom');
    return a && b && c;
  });
  await check('语音控制：低置信度（噪音）被过滤，未识别命令语音反馈', async () => {
    const before = await A(page, () => window.PMG_A11Y.voice.log.length);
    await say('打开地图', 0.2);
    const r = await A(page, () => ({ prof: document.getElementById('profile').classList.contains('active'), last: window.PMG_A11Y.voice.log.slice(-1)[0] }));
    await say('今天天气怎么样');
    const fb = await A(page, () => window.PMG_A11Y.announcer.history.slice(-1)[0].message);
    return { ok: r.prof && r.last.ev === 'unknown' && /没有听懂/.test(fb), detail: fb };
  });
  await check('TTS：语音播报使用设置的语速与界面语言', async () => {
    const u = await A(page, () => window.__utter.slice(-1)[0]);
    return { ok: !!u && Math.abs(u.rate - 1.3) < 0.01 && u.lang === 'zh-CN', detail: JSON.stringify(u) };
  });
  await A(page, () => window.PMG_A11Y.store.set({ voiceControl: { enabled: false }, screenReader: { speech: false } }));

  // ── 8. RTL ────────────────────────────────────────────────
  await check('RTL：切换阿拉伯语后 <html dir="rtl"> 立即生效（< 100ms），刷新后保持', async () => {
    const r = await A(page, async () => {
      const t0 = performance.now();
      window.changeLanguage('ar-SA');
      await new Promise((res) => requestAnimationFrame(res));
      return { dir: document.documentElement.dir, ms: performance.now() - t0, sw: window.PMG_A11Y.direction.lastSwitchMs };
    });
    await page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => window.PMG_A11Y, null, { timeout: 8000 });
    const after = await A(page, () => ({ dir: document.documentElement.dir, lang: document.documentElement.lang }));
    return { ok: r.dir === 'rtl' && r.sw < 100 && after.dir === 'rtl' && after.lang === 'ar-SA', detail: `切换 ${r.sw}ms，刷新后 dir=${after.dir}` };
  });
  await check('RTL：方向性图标镜像（返回箭头），头像/精灵不镜像，名称 dir=auto', async () => {
    await page.waitForSelector('#map.active', { timeout: 10000 });
    await page.waitForSelector('#map-body .a11y-dir-icon', { timeout: 15000 });
    const r = await A(page, () => {
      const arrow = getComputedStyle(document.querySelector('#map-body .a11y-dir-icon')).transform;
      const avatar = getComputedStyle(document.querySelector('.avatar-circle')).transform;
      const dist = getComputedStyle(document.querySelector('#map-body .entity-right')).transform;
      return { arrow, avatar, dist, dir: document.getElementById('map-name').getAttribute('dir'), backRule: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((c) => /\[dir="rtl"\] \.back-btn/.test(c.selectorText || '')); } catch { return false; } }) };
    });
    return { ok: r.arrow.startsWith('matrix(-1') && !r.avatar.startsWith('matrix(-1') && !r.dist.startsWith('matrix(-1') && r.dir === 'auto' && r.backRule, detail: JSON.stringify(r) };
  });
  await axeScan(page, 'RTL 地图页');
  await A(page, () => { localStorage.setItem('pmg_language', 'zh-CN'); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.PMG_A11Y && document.documentElement.dir === 'ltr', null, { timeout: 8000 }).catch(() => {});
  record('RTL：切回中文恢复 LTR', await A(page, () => document.documentElement.dir === 'ltr'));

  record('页面无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('❌ e2e 中断：', e && e.stack || e); process.exit(1); });
