/**
 * E2E：E05（成就/称号/资料卡/收藏室）+ E13（消息中心）客户端（接口全部 Mock，验证页面装配与交互）
 * 运行：cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');
const { loginAsExistingUser } = require('./helpers');

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, code: 0, message: 'ok', data }) });
const now = new Date().toISOString();
const NOTES = [
  { id: '00000000-0000-4000-8000-000000000001', type: 'social.friend_request', category: 'social', categoryLabel: '社交', priority: 'high', icon: '👋',
    title: '好友请求', body: '小智 想和你成为好友', data: { fromUserId: 'u2' }, actionUrl: '/friends/requests', isRead: false, createdAt: now },
  { id: '00000000-0000-4000-8000-000000000002', type: 'reward.achievement_unlock', category: 'reward', categoryLabel: '奖励', priority: 'high', icon: '🏆',
    title: '成就解锁', body: '恭喜解锁成就：初次捕捉', data: { achievementId: 'first_catch' }, actionUrl: '/achievements/first_catch', isRead: false, createdAt: now },
  { id: '00000000-0000-4000-8000-000000000003', type: 'event.started', category: 'event', categoryLabel: '活动', priority: 'normal', icon: '🎉',
    title: '活动开始', body: '夏日祭 已开始！', data: {}, actionUrl: '/events/1', isRead: false, createdAt: now },
];

async function mockProfileNotify(page, calls) {
  let unread = 3;
  await page.route('**/v1/notifications/unread-count', (r) => r.fulfill(ok({ total: unread, byCategory: { social: 1, reward: 1, event: 1 } })));
  await page.route('**/v1/notifications?*', (r) => r.fulfill(ok({ notifications: NOTES, pagination: { total: 3, page: 1, limit: 20, totalPages: 1 }, unreadCount: unread })));
  await page.route('**/v1/notifications/*/read', (r) => { calls.push(['read', r.request().url()]); unread -= 1; return r.fulfill(ok({ isRead: true })); });
  await page.route('**/v1/notifications/preferences', (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill(ok({ enablePush: true, notificationTypes: { system: true, social: true, event: true, reward: true, pokemon: true, security: true },
        mandatoryCategories: ['system', 'security'], quietHours: { enabled: false, start: '22:00', end: '08:00' }, pushProviders: { fcm: false, apns: false } }));
    }
    calls.push(['prefs', r.request().postDataJSON()]);
    return r.fulfill(ok({ updated: true }));
  });
  await page.route('**/v1/achievements/categories', (r) => r.fulfill(ok([{ key: 'catch', label: '捕捉', icon: '🎯' }])));
  await page.route('**/v1/achievements/my/progress', (r) => r.fulfill(ok({ totalPoints: 10, completed: 1, total: 40, claimable: 1, rank: 7,
    byCategory: { catch: { completed: 1, total: 10 } }, recent: [] })));
  await page.route('**/v1/achievements/my?*', (r) => r.fulfill(ok({ hiddenLocked: 2, total: 1, achievements: [{ achievementId: 'first_catch', category: 'catch',
    name: '初次捕捉', description: '捕捉你的第一只精灵', rarity: 'common', points: 10, target: 1, progress: 1, percent: 100, completed: true, claimable: true,
    rewardsClaimed: false, rewards: { currencies: { coins: 100 }, items: [], title: null, decoration: null } }] })));
  await page.route('**/v1/achievements/first_catch/claim', (r) => { calls.push(['claim']); return r.fulfill(ok({ granted: { coins: 100 } })); });
  await page.route('**/v1/collection-room', (r) => r.fulfill(ok({ isOwner: true, unlockedThemes: ['default'], unlockedBackgrounds: ['classic'],
    room: { id: 'r1', roomName: '测试展馆', level: 2, experience: 120, nextLevelExp: 250, levelProgress: 0.13, capacity: { pokemon: 25, decorations: 15 },
      theme: { id: 'default', name: '默认', palette: { floor: '#E8E1D5', wall: '#FAF7F2', accent: '#5C6BC0' } },
      background: { id: 'classic', name: '经典', cssGradient: 'linear-gradient(#FAF7F2,#E8E1D5)' }, layout: { gridSize: { width: 10, height: 8 } },
      likeCount: 3, visitorCount: 5, commentCount: 1, isPublic: true },
    pokemon: [{ pokemonId: 'p1', name: '皮卡丘', cp: 500, isShiny: false, x: 1, y: 1, z: 0, scale: 1, rotation: 0, displayMode: 'idle', pedestalType: 'basic' }],
    decorations: [{ id: 'd1', itemCode: 'chair_wood', name: '木质椅子', category: 'furniture', rarity: 'common', icon: '🪑', width: 1, height: 1, x: 3, y: 3, rotation: 0, scale: 1, zIndex: 0 }] })));
  await page.route('**/v1/collection-room/decorations/inventory', (r) => r.fulfill(ok([])));
  await page.route('**/v1/pokemon/my?*', (r) => r.fulfill(ok({ pokemon: [] })));
}

test.describe('成长与消息中心（E05/E13）', () => {
  test('导航栏消息图标显示未读数，打开消息中心、点击标记已读、保存偏好', async ({ page }) => {
    const calls = [];
    await mockProfileNotify(page, calls);
    await loginAsExistingUser(page);
    const badge = page.locator('[data-testid="message-badge"]');
    await expect(badge).toHaveText('3');
    await page.click('[data-testid="nav-messages"]');
    await expect(page.locator('[data-testid="message-center"]')).toBeVisible();
    const items = page.locator('[data-testid="message-item"]');
    await expect(items).toHaveCount(3);
    await items.first().click();
    await expect(badge).toHaveText('2');
    expect(calls.some(([k, url]) => k === 'read' && url.includes('000000000001'))).toBeTruthy();
    await page.click('[data-testid="message-preferences"]');
    await page.uncheck('[data-testid="pref-social"]');
    await expect(page.locator('[data-testid="pref-system"]')).toBeDisabled();
    await page.click('[data-testid="pref-save"]');
    await expect.poll(() => calls.find(([k]) => k === 'prefs')).toBeTruthy();
    expect(calls.find(([k]) => k === 'prefs')[1].notificationTypes.social).toBe(false);
  });

  test('"我的"页成长卡片：成就面板领取奖励、收藏室网格渲染', async ({ page }) => {
    const calls = [];
    await mockProfileNotify(page, calls);
    await loginAsExistingUser(page);
    await page.click('[data-testid="nav-profile"]');
    await expect(page.locator('[data-testid="growth-card"]')).toBeVisible();
    await page.click('[data-testid="open-achievements"]');
    await expect(page.locator('[data-testid="achievement-list"]')).toContainText('初次捕捉');
    await expect(page.locator('#achievement-panel')).toContainText('还有 2 个隐藏成就');
    await page.click('[data-testid="claim-first_catch"]');
    await expect.poll(() => calls.some(([k]) => k === 'claim')).toBeTruthy();
    await page.keyboard.press('Escape');
    await page.click('[data-testid="open-collection-room"]');
    await expect(page.locator('[data-testid="room-info"]')).toContainText('测试展馆');
    await expect(page.locator('.pn-room-item')).toHaveCount(2);
  });
});
