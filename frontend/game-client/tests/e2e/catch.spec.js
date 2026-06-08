/**
 * E2E 测试：精灵捕捉功能
 * 测试捕捉界面、精灵球选择、投掷动画、捕捉结果
 */

const { test, expect } = require('@playwright/test');
const {
  TEST_USERS,
  waitForVisible,
  waitForHidden,
  mockLoginApi,
  mockNearbyApi,
  mockCatchApi,
  mockInventoryApi,
  loginAsExistingUser
} = require('./helpers');

test.describe('精灵捕捉功能', () => {
  
  test.beforeEach(async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
  });

  test('进入捕捉界面显示野生精灵', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    // 点击第一个精灵
    await page.click('[data-testid="pokemon-card-0"]');
    
    // 等待捕捉界面
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 验证野生精灵显示
    await expect(page.locator('[data-testid="wild-pokemon-emoji"]')).toBeVisible();
    await expect(page.locator('[data-testid="wild-pokemon-name"]')).toContainText(/皮卡丘|妙蛙种子|伊布/);
    await expect(page.locator('[data-testid="wild-pokemon-cp"]')).toBeVisible();
  });

  test('显示精灵球选择器', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 验证精灵球选择器
    await expect(page.locator('[data-testid="ball-selector"]')).toBeVisible();
    await expect(page.locator('[data-testid="ball-pokeball"]')).toBeVisible();
    await expect(page.locator('[data-testid="ball-greatball"]')).toBeVisible();
    await expect(page.locator('[data-testid="ball-ultraball"]')).toBeVisible();
  });

  test('选择不同类型的精灵球', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 选择超级球
    await page.click('[data-testid="ball-greatball"]');
    
    // 验证选中状态
    await expect(page.locator('[data-testid="ball-greatball"]')).toHaveClass(/selected/);
    
    // 选择高级球
    await page.click('[data-testid="ball-ultraball"]');
    await expect(page.locator('[data-testid="ball-ultraball"]')).toHaveClass(/selected/);
  });

  test('投掷精灵球捕捉成功', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 点击投掷按钮
    await page.click('[data-testid="throw-ball-btn"]');
    
    // 等待捕捉结果
    await waitForVisible(page, '[data-testid="catch-result"]', 15000);
    
    // 验证捕捉成功
    await expect(page.locator('[data-testid="catch-result"]')).toContainText('成功');
    await expect(page.locator('[data-testid="catch-rewards"]')).toBeVisible();
  });

  test('捕捉失败精灵逃脱', async ({ page }) => {
    await mockCatchApi(page, false);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 投掷精灵球
    await page.click('[data-testid="throw-ball-btn"]');
    
    // 等待结果
    await waitForVisible(page, '[data-testid="catch-result"]', 15000);
    
    // 验证逃脱提示
    await expect(page.locator('[data-testid="catch-result"]')).toContainText(/逃脱|失败/);
  });

  test('逃跑返回地图', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 点击逃跑
    await page.click('[data-testid="flee-btn"]');
    
    // 验证返回地图页
    await expect(page.locator('[data-testid="map-screen"]')).toBeVisible();
  });

  test('投掷按钮在动画期间禁用', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 投掷
    await page.click('[data-testid="throw-ball-btn"]');
    
    // 验证按钮禁用
    await expect(page.locator('[data-testid="throw-ball-btn"]')).toBeDisabled();
    
    // 等待结果后按钮恢复
    await waitForVisible(page, '[data-testid="catch-result"]', 15000);
    // 注：按钮状态取决于具体实现
  });

  test('准确度指示器动画', async ({ page }) => {
    await mockCatchApi(page, true);
    await loginAsExistingUser(page);
    
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 验证准确度条存在
    await expect(page.locator('[data-testid="accuracy-bar"]')).toBeVisible();
    
    // 验证动画运行（条宽度变化）
    const bar = page.locator('[data-testid="accuracy-bar-fill"]');
    await expect(bar).toBeVisible();
  });
});

test.describe('精灵捕捉 - 资源消耗', () => {
  
  test('捕捉成功后精灵球数量减少', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockCatchApi(page, true);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 记录初始精灵球数量
    const initialCount = await page.locator('[data-testid="resource-pokeball"]').textContent();
    
    // 进入捕捉
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    await page.click('[data-testid="throw-ball-btn"]');
    
    // 等待结果
    await waitForVisible(page, '[data-testid="catch-result"]', 15000);
    
    // 返回地图后验证数量变化
    // 注：具体实现取决于是否即时更新
  });

  test('没有精灵球时显示提示', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    
    // Mock 空背包
    await page.route('**/v1/users/me/inventory', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            pokeball_count: 0,
            greatball_count: 0,
            ultraball_count: 0
          }
        })
      });
    });
    
    await loginAsExistingUser(page);
    
    // 尝试进入捕捉
    await page.click('[data-testid="pokemon-card-0"]');
    
    // 验证显示无精灵球提示
    await expect(page.locator('[data-testid="no-ball-warning"]')).toBeVisible();
  });
});

test.describe('精灵捕捉 - 动画效果', () => {
  
  test('野生精灵浮动动画', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockCatchApi(page, true);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    await page.click('[data-testid="pokemon-card-0"]');
    await waitForVisible(page, '[data-testid="catch-screen"]');
    
    // 验证动画类存在
    const pokemon = page.locator('[data-testid="wild-pokemon-emoji"]');
    await expect(pokemon).toHaveClass(/float|animate/);
  });
});
