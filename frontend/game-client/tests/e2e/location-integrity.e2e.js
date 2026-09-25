#!/usr/bin/env node
/**
 * REQ-00586 浏览器端验证：
 *   1. 客户端定位信号采集（src/security/locationSignals.js）：静态伪造定位 vs 真实抖动
 *   2. LocationManager 上报位置时携带 clientSignals（拦截请求体检查）
 *   3. 管理后台 admin-dashboard/anticheat.html：加载统计、审核申诉
 *
 *   CLIENT_URL=http://127.0.0.1:3000 BASE_URL=http://127.0.0.1:8080 NODE_PATH=... node frontend/game-client/tests/e2e/location-integrity.e2e.js
 */
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright-core');
const h = require(path.resolve(__dirname, '../../../../scripts/lib/smoke-helpers.js'));

const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:3000';
const ADMIN_HTML = path.resolve(__dirname, '../../../../admin-dashboard/anticheat.html');

// 管理后台静态页 + /api 反向代理到网关（与生产 nginx 部署方式一致）
function startAdminServer() {
  const gw = new URL(h.BASE);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const up = http.request({ hostname: gw.hostname, port: gw.port, path: req.url, method: req.method, headers: { ...req.headers, host: gw.host } },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      req.pipe(up);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(ADMIN_HTML).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });

  // 1) 信号采集模块
  const page = await context.newPage();
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  const sig = await page.evaluate(async () => {
    const { LocationSignalCollector } = await import('/src/security/locationSignals.js');
    const spoof = new LocationSignalCollector();
    const real = new LocationSignalCollector();
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      spoof.record({ coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 5 }, timestamp: t0 + i * 1000 });
      real.record({ coords: { latitude: 31.2304 + Math.random() * 1e-4, longitude: 121.4737 + Math.random() * 1e-4, accuracy: 5 + Math.random() * 10 }, timestamp: t0 + i * 1000 });
    }
    real.record({ coords: { latitude: 31.23, longitude: 121.47, accuracy: 8 }, timestamp: t0 - 5000 }); // 时间倒退
    return { spoof: spoof.summary(), real: real.summary() };
  });
  h.record('客户端信号：静态伪造定位（11/12 相同、精度恒定）', sig.spoof.identicalFixes === 11 && sig.spoof.accuracyConstant === true, JSON.stringify(sig.spoof));
  h.record('客户端信号：真实抖动定位不判为静态，时间倒退被计数', sig.real.identicalFixes < 2 && sig.real.accuracyConstant === false && sig.real.nonMonotonicTimestamps === 1);
  h.record('客户端信号：检测到自动化浏览器（webdriver）', sig.spoof.webdriver === true);

  // 2) LocationManager 上报携带 clientSignals：用模拟的地理位置驱动真实客户端
  const user = await h.newUser('lm');
  const p2 = await context.newPage();
  let reported = null;
  await p2.route('**/v1/location', async (route) => {
    if (route.request().method() === 'POST') reported = JSON.parse(route.request().postData() || '{}');
    await route.continue();
  });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 31.2398, longitude: 121.5014, accuracy: 20 });
  await p2.addInitScript(([a, r]) => { localStorage.setItem('pmg_access_token', a); localStorage.setItem('pmg_refresh_token', r); }, [user.token, user.refreshToken]);
  await p2.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40 && !reported; i++) await p2.waitForTimeout(500);
  h.record('客户端：位置上报携带 clientSignals 摘要', reported && reported.clientSignals && typeof reported.clientSignals.samples === 'number',
    reported ? JSON.stringify(reported.clientSignals) : '未捕获到上报');

  // 3) 管理后台：造一条待审核申诉，在页面上审核通过
  const admin = await h.makeAdmin(await h.newUser('adm'));
  const suspect = await h.newUser('sus');
  await h.call('POST', '/v1/location', { token: suspect.token, body: { lat: 31.1, lng: 122.95, accuracy: 10 } }); // 东海水域
  const ap = await h.call('POST', '/v1/location/appeals', { token: suspect.token, body: { reason: '在渡轮上正常游戏，请核实' } });
  const server = await startAdminServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const p3 = await context.newPage();
  const pageErrors = [];
  p3.on('pageerror', (e) => pageErrors.push(e.message));
  await p3.addInitScript(([o, t]) => { localStorage.setItem('ac.base', o); localStorage.setItem('ac.token', t); }, [origin, admin.token]);
  await p3.goto(origin, { waitUntil: 'domcontentloaded' });
  await p3.waitForSelector(`#appeals tr[data-id="${ap.data && ap.data.id}"]`, { timeout: 15000 }).catch(() => {});
  const typesText = await p3.locator('#types').textContent();
  h.record('后台：监控面板展示事件类型与待审核申诉', /TERRAIN_WATER/.test(typesText) && await p3.locator(`#appeals tr[data-id="${ap.data && ap.data.id}"]`).count() === 1, `types=${typesText.slice(0, 80)}`);
  await p3.locator(`#appeals tr[data-id="${ap.data.id}"] button[data-act="APPROVE"]`).click();
  await p3.waitForFunction((id) => !document.querySelector(`#appeals tr[data-id="${id}"]`), ap.data.id, { timeout: 15000 }).catch(() => {});
  const mine = await h.call('GET', '/v1/location/appeals', { token: suspect.token });
  h.record('后台：页面上审核通过后玩家可信度恢复', mine.data && mine.data.appeals[0].status === 'APPROVED' && mine.data.trustScore === 100, `trust=${mine.data && mine.data.trustScore}`);
  h.record('后台：页面无 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));

  server.close();
  await browser.close();
  await h.finish();
})().catch(async (e) => {
  h.record('执行异常', false, e.message);
  await h.finish();
});
