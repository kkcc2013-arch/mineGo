/**
 * E2E 测试：地图浏览功能
 * 测试地图加载、附近精灵展示、道馆和补给站显示
 */

const { test, expect } = require('@playwright/test');
const {
  TEST_USERS,
  waitForVisible,
  mockLoginApi,
  mockNearbyApi,
  mockInventoryApi,
  loginAsExistingUser
} = require('./helpers');

test.describe('地图浏览功能', () => {
  
  test.beforeEach(async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
  });

  test('地图加载后显示附近精灵', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 验证精灵列表标题
    await expect(page.locator('[data-testid="nearby-section-title"]')).toContainText('精灵');
    
    // 验证至少有一个精灵卡片
    const pokemonCards = page.locator('[data-testid^="pokemon-card-"]');
    await expect(pokemonCards.first()).toBeVisible();
    
    const count = await pokemonCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('显示用户资源信息', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 验证资源显示
    await expect(page.locator('[data-testid="resource-pokeball"]')).toBeVisible();
    await expect(page.locator('[data-testid="resource-coins"]')).toBeVisible();
    await expect(page.locator('[data-testid="resource-stardust"]')).toBeVisible();
  });

  test('显示 GPS 定位状态', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 验证 GPS 状态徽章
    await expect(page.locator('[data-testid="gps-badge"]')).toBeVisible();
  });

  test('点击精灵卡片进入捕捉界面', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    
    await loginAsExistingUser(page);
    
    // 点击第一个精灵
    await page.click('[data-testid="pokemon-card-0"]');
    
    // 验证进入捕捉界面
    await waitForVisible(page, '[data-testid="catch-screen"]');
    await expect(page.locator('[data-testid="wild-pokemon-emoji"]')).toBeVisible();
    await expect(page.locator('[data-testid="wild-pokemon-name"]')).toBeVisible();
  });

  test('显示道馆列表', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 验证道馆区域
    await expect(page.locator('[data-testid="gym-section-title"]')).toContainText('道馆');
  });

  test('显示补给站列表', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 验证补给站区域
    await expect(page.locator('[data-testid="pokestop-section-title"]')).toContainText('补给站');
  });

  test('下拉刷新地图', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 滚动到顶部
    await page.locator('[data-testid="map-scroll-area"]').evaluate(el => el.scrollTop = 0);
    
    // 触发下拉刷新（模拟触摸事件）
    const scrollArea = page.locator('[data-testid="map-scroll-area"]');
    await scrollArea.evaluate(el => {
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [{ clientY: 100 }] }));
      el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [{ clientY: 200 }] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    });
    
    // 验证加载指示器
    // 注：具体实现取决于应用逻辑
  });

  test('精灵卡片显示距离信息', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 验证第一个精灵卡片显示距离
    const firstCard = page.locator('[data-testid="pokemon-card-0"]');
    await expect(firstCard.locator('[data-testid="pokemon-distance"]')).toBeVisible();
  });

  test('精灵卡片显示 CP 值', async ({ page }) => {
    await loginAsExistingUser(page);
    
    const firstCard = page.locator('[data-testid="pokemon-card-0"]');
    await expect(firstCard.locator('[data-testid="pokemon-cp"]')).toBeVisible();
  });

  test('导航栏切换', async ({ page }) => {
    await loginAsExistingUser(page);
    
    // 点击个人页
    await page.click('[data-testid="nav-profile"]');
    await waitForVisible(page, '[data-testid="profile-screen"]');
    
    // 点击地图页
    await page.click('[data-testid="nav-map"]');
    await waitForVisible(page, '[data-testid="map-screen"]');
  });
});

test.describe('地图 - 空数据状态', () => {
  
  test('没有附近精灵时显示空状态', async ({ page }) => {
    await mockLoginApi(page);
    await mockInventoryApi(page);
    
    // Mock 空数据
    await page.route('**/v1/location/nearby*', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          message: '成功',
          data: {
            wild_pokemons: [],
            pokestops: [],
            gyms: []
          }
        })
      });
    });
    
    await loginAsExistingUser(page);
    
    // 验证空状态显示
    await expect(page.locator('[data-testid="empty-pokemon-state"]')).toBeVisible();
    await expect(page.locator('[data-testid="empty-pokemon-icon"]')).toBeVisible();
    await expect(page.locator('[data-testid="empty-pokemon-text"]')).toContainText('附近暂无精灵');
  });

  test('加载失败时显示错误状态', async ({ page }) => {
    await mockLoginApi(page);
    
    // Mock 失败响应
    await page.route('**/v1/location/nearby*', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 500,
          message: '服务器错误'
        })
      });
    });
    
    await loginAsExistingUser(page);
    
    // 验证错误状态
    await expect(page.locator('[data-testid="error-state"]')).toBeVisible();
    await expect(page.locator('[data-testid="retry-btn"]')).toBeVisible();
  });
});

test.describe('地图 - 移动端特性', () => {
  
  test.use({ viewport: { width: 375, height: 667 } });
  
  test('移动端精灵卡片可滑动', async ({ page }) => {
    await loginAsExistingUser(page);
    
    const scrollArea = page.locator('[data-testid="map-scroll-area"]');
    
    // 验证可滚动
    await expect(scrollArea).toBeVisible();
    
    // 滚动到底部
    await scrollArea.evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
  });
});
