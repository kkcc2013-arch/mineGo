#!/usr/bin/env node
/**
 * REQ-00044 客户端隐私中心 E2E（真实浏览器 + 真实后端）
 *
 * 前置：网关与各服务已启动；scripts/serve-client.js 提供页面并代理 /v1 到网关。
 * 依赖：playwright-core（NODE_PATH 指向含 playwright-core/axe-core 的 node_modules），本机 Chrome。
 *
 *   CLIENT_URL=http://127.0.0.1:3000 BASE_URL=http://127.0.0.1:8080 CHROME=/usr/bin/google-chrome \
 *   NODE_PATH=/path/to/node_modules node frontend/game-client/tests/e2e/privacy-center.e2e.js
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright-core');
const h = require(path.resolve(__dirname, '../../../../scripts/lib/smoke-helpers.js'));

const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:3000';

(async () => {
  const user = await h.newUser('ui');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  // 屏蔽 Service Worker：注册后会触发一次整页重载，打断测试中的页面状态（PWA 行为由 E22 单独测试）
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([a, r]) => {
    localStorage.setItem('pmg_access_token', a);
    localStorage.setItem('pmg_refresh_token', r);
  }, [user.token, user.refreshToken]);
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.PMG_FEATURES, null, { timeout: 15000 });
  // 客户端启动时校验 token 后会异步切到地图页；等它完成再进入"我的"页，避免被切走
  await page.waitForFunction(() => document.querySelector('.screen.active') && document.querySelector('.screen.active').id === 'map', null, { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => window.goScreen && window.goScreen('profile'));

  const card = page.getByTestId('privacy-card');
  await card.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  h.record('UI：我的页显示"隐私与数据"卡片', await card.isVisible());

  // 导出
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.getByTestId('privacy-export').click(),
  ]);
  const exported = await page.evaluate(() => window.PMG_LAST_EXPORT);
  h.record('UI：导出我的数据下载 JSON 文件', /minego-data-export-\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()) && exported && exported.userId === user.userId,
    `file=${download.suggestedFilename()}`);

  // 删除：确认语错误被拒绝，正确后进入冷却期
  await page.getByTestId('privacy-delete').click();
  const dialog = page.getByTestId('privacy-dialog');
  h.record('UI：删除对话框为可访问的模态框且焦点在输入框', await dialog.getAttribute('aria-modal') === 'true' &&
    await page.evaluate(() => document.activeElement && document.activeElement.id === 'privacy-confirm-input'));
  await page.getByTestId('privacy-confirm-input').fill('delete');
  await page.getByTestId('privacy-confirm-submit').click();
  h.record('UI：确认语不正确时拒绝并提示', (await page.locator('#privacy-confirm-error').textContent()).includes('DELETE MY ACCOUNT'));
  await page.getByTestId('privacy-confirm-input').fill('DELETE MY ACCOUNT');
  await page.getByTestId('privacy-confirm-submit').click();
  await page.getByTestId('privacy-cancel').waitFor({ state: 'visible', timeout: 10000 });
  const statusText = await page.locator('#privacy-status').textContent();
  const st = await h.call('GET', '/v1/gdpr/status', { token: user.token });
  h.record('UI：提交删除后进入 30 天冷却期（服务端状态 pending）', st.body && st.body.latest && String(st.body.latest.status).toUpperCase() === 'PENDING' && /删除/.test(statusText), `status=${statusText}`);

  // 撤销
  await page.getByTestId('privacy-cancel').click();
  await page.getByTestId('privacy-delete').waitFor({ state: 'visible', timeout: 10000 });
  const st2 = await h.call('GET', '/v1/gdpr/status', { token: user.token });
  h.record('UI：冷却期内撤销删除', st2.body && st2.body.latest && String(st2.body.latest.status).toUpperCase() === 'CANCELLED', `status=${st2.body && st2.body.latest && st2.body.latest.status}`);

  // 无障碍扫描（隐私卡片区域）
  try {
    const axeSource = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => window.axe.run('#privacy-card', { resultTypes: ['violations'] }));
    const serious = res.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    h.record('UI：隐私卡片无严重无障碍问题（axe）', serious.length === 0, serious.map((v) => v.id).join(','));
  } catch (e) {
    h.record('UI：axe 扫描可执行', false, e.message);
  }

  h.record('UI：页面无 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  await h.finish();
})().catch(async (e) => {
  h.record('执行异常', false, e.message);
  await h.finish();
});
