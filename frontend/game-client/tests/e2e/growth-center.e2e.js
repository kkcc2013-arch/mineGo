#!/usr/bin/env node
/**
 * Epic E07 精灵成长页 E2E（真实浏览器 + 真实后端）
 *
 * 前置：网关与各服务已启动；scripts/serve-client.js 提供页面并代理 /v1 到网关；可连数据库造夹具（smoke-helpers 读 .env）。
 * 依赖：playwright-core（NODE_PATH 指向含 playwright-core 的 node_modules），本机 Chrome。
 *
 *   CLIENT_URL=http://127.0.0.1:3000 BASE_URL=http://127.0.0.1:8080 CHROME=/usr/bin/google-chrome \
 *   NODE_PATH=/path/to/node_modules node frontend/game-client/tests/e2e/growth-center.e2e.js
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright-core');
const h = require(path.resolve(__dirname, '../../../../scripts/lib/smoke-helpers.js'));

const CLIENT_URL = process.env.CLIENT_URL || 'http://127.0.0.1:3000';

(async () => {
  const user = await h.newUser('gui');
  const db = h.getDb();
  const { rows: [p] } = await db.query(
    `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, friendship)
     VALUES ($1, 1, 900, 700, 700, 12, 12, 12, 120) RETURNING id`, [user.userId]);
  await db.query(`INSERT INTO candy_inventory (user_id, species_id, amount) VALUES ($1, 1, 30)
                  ON CONFLICT (user_id, species_id) DO UPDATE SET amount = 30`, [user.userId]);

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([a, r]) => {
    localStorage.setItem('pmg_access_token', a);
    localStorage.setItem('pmg_refresh_token', r);
  }, [user.token, user.refreshToken]);
  await page.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.PMG_FEATURES, null, { timeout: 15000 });
  h.record('UI：成长模块装配成功', await page.evaluate(() => !!(window.PMG_FEATURES.growth && window.PMG_FEATURES.growth.enabled)));
  await page.waitForFunction(() => document.querySelector('.screen.active') && document.querySelector('.screen.active').id === 'map', null, { timeout: 15000 }).catch(() => {});

  await page.getByTestId('nav-growth').click();
  const card = page.getByTestId('growth-pokemon').first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  h.record('UI：底部导航「精灵」打开精灵列表', await card.isVisible());
  await card.click();
  await page.getByTestId('growth-head').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('svg.gr-tree').waitFor({ state: 'visible', timeout: 10000 });
  h.record('UI：精灵详情显示等级/体力与进化树', await page.locator('.gr-node').count() === 3);

  const evolveBtn = page.getByTestId('evolve-btn');
  await evolveBtn.waitFor({ state: 'visible', timeout: 10000 });
  await evolveBtn.click();
  await page.waitForFunction(() => /妙蛙草/.test(document.querySelector('[data-testid="growth-head"]')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const { rows: [after] } = await db.query('SELECT species_id FROM pokemon_instances WHERE id = $1', [p.id]);
  h.record('UI：点击进化后精灵变为妙蛙草', after.species_id === 2, `species=${after.species_id}`);

  for (const [tab, sel] of [['成长', 'svg.gr-chart'], ['体力', '.gr-bar.big'], ['觉醒', '.gr-aura-box'], ['特训', '.gr-panel select'], ['训练营', '.gr-panel .gr-sec']]) {
    await page.locator('.gr-tab', { hasText: tab }).click();
    const ok = await page.locator(sel).first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    h.record(`UI：「${tab}」页签可加载`, ok);
  }
  h.record('UI：无页面脚本错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  await browser.close();
  await h.finish();
})().catch(async (err) => {
  h.record('执行异常', false, err.message);
  await h.finish();
});
