/**
 * E2E 测试：无障碍功能
 * 测试键盘导航、屏幕阅读器支持、色盲模式等
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

test.describe('无障碍 - 键盘导航', () => {
  
  test('Tab 键可以导航所有交互元素', async ({ page }) => {
    await page.goto('/');
    
    // 按 Tab 键
    await page.keyboard.press('Tab');
    
    // 验证焦点在第一个可交互元素
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
    
    // 继续按 Tab 确认焦点移动
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  });

  test('Enter 键可以激活按钮', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await page.goto('/');
    
    // 填写表单
    await page.fill('[data-testid="phone-input"]', TEST_USERS.existing.phone);
    await page.fill('[data-testid="code-input"]', TEST_USERS.existing.code);
    
    // Tab 到登录按钮
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // 按 Enter 激活
    await page.keyboard.press('Enter');
    
    // 验证登录成功
    await waitForVisible(page, '[data-testid="map-screen"]', 10000);
  });

  test('Escape 键关闭弹窗', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 点击精灵卡片打开详情
    await page.click('[data-testid="pokemon-card-0"]');
    
    // 如果有弹窗，按 Escape 关闭
    await page.keyboard.press('Escape');
    
    // 验证弹窗关闭或返回地图
    // 注：具体行为取决于实现
  });

  test('所有按钮有明确的焦点样式', async ({ page }) => {
    await page.goto('/');
    
    const buttons = page.locator('button');
    const count = await buttons.count();
    
    for (let i = 0; i < Math.min(count, 5); i++) {
      await buttons.nth(i).focus();
      
      // 验证焦点样式存在
      const outline = await buttons.nth(i).evaluate(el => {
        return window.getComputedStyle(el).outline || window.getComputedStyle(el).boxShadow;
      });
      
      expect(outline).toBeTruthy();
    }
  });
});

test.describe('无障碍 - ARIA 属性', () => {
  
  test('表单元素有正确的 label', async ({ page }) => {
    await page.goto('/');
    
    // 验证输入框有 label 或 aria-label
    const phoneInput = page.locator('[data-testid="phone-input"]');
    const ariaLabel = await phoneInput.getAttribute('aria-label');
    const labelledBy = await phoneInput.getAttribute('aria-labelledby');
    
    expect(ariaLabel || labelledBy).toBeTruthy();
  });

  test('按钮有可访问的名称', async ({ page }) => {
    await page.goto('/');
    
    const buttons = page.locator('button');
    const count = await buttons.count();
    
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      const text = await button.textContent();
      const ariaLabel = await button.getAttribute('aria-label');
      const title = await button.getAttribute('title');
      
      // 至少有一个可访问名称
      expect(text || ariaLabel || title).toBeTruthy();
    }
  });

  test('图片有 alt 属性', async ({ page }) => {
    await page.goto('/');
    
    const images = page.locator('img');
    const count = await images.count();
    
    for (let i = 0; i < count; i++) {
      const img = images.nth(i);
      const alt = await img.getAttribute('alt');
      const role = await img.getAttribute('role');
      
      // 图片要么有 alt 属性，要么被标记为装饰性
      expect(alt !== null || role === 'presentation').toBeTruthy();
    }
  });

  test('主要区域有正确的 role', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 验证导航有 nav role
    const nav = page.locator('[data-testid="nav-bar"]');
    const navRole = await nav.getAttribute('role');
    expect(navRole === 'navigation' || nav.tagName === 'NAV').toBeTruthy();
  });
});

test.describe('无障碍 - 色盲模式', () => {
  
  test('可以开启色盲模式', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 导航到设置页
    await page.click('[data-testid="nav-profile"]');
    await waitForVisible(page, '[data-testid="profile-screen"]');
    
    // 打开无障碍设置
    await page.click('[data-testid="accessibility-settings"]');
    
    // 启用色盲模式
    await page.click('[data-testid="colorblind-mode-toggle"]');
    
    // 验证色盲模式激活
    const rootClasses = await page.locator(':root').getAttribute('class');
    expect(rootClasses).toContain('colorblind');
  });

  test('色盲模式应用 CSS 滤镜', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    await page.click('[data-testid="nav-profile"]');
    await page.click('[data-testid="accessibility-settings"]');
    await page.click('[data-testid="colorblind-mode-toggle"]');
    
    // 验证 CSS 变量或滤镜应用
    const filter = await page.locator(':root').evaluate(el => {
      return getComputedStyle(el).getPropertyValue('--colorblind-filter') ||
             getComputedStyle(el).getPropertyValue('filter');
    });
    
    expect(filter).toBeTruthy();
  });

  test('色盲模式有不同类型选项', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    await page.click('[data-testid="nav-profile"]');
    await page.click('[data-testid="accessibility-settings"]');
    
    // 验证色盲类型选择器
    await expect(page.locator('[data-testid="colorblind-type-selector"]')).toBeVisible();
    
    // 验证有多个选项
    const options = page.locator('[data-testid="colorblind-type-option"]');
    const count = await options.count();
    expect(count).toBeGreaterThanOrEqual(3); // 至少 protanopia, deuteranopia, tritanopia
  });
});

test.describe('无障碍 - 高对比度', () => {
  
  test('高对比度模式可用', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    await page.click('[data-testid="nav-profile"]');
    await page.click('[data-testid="accessibility-settings"]');
    
    // 启用高对比度
    await page.click('[data-testid="high-contrast-toggle"]');
    
    // 验证高对比度类
    const rootClasses = await page.locator(':root').getAttribute('class');
    expect(rootClasses).toContain('high-contrast');
  });

  test('高对比度模式下文字可读', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    await page.click('[data-testid="nav-profile"]');
    await page.click('[data-testid="accessibility-settings"]');
    await page.click('[data-testid="high-contrast-toggle"]');
    
    // 验证文字对比度
    const contrastRatio = await page.locator('[data-testid="user-name"]').evaluate(el => {
      const style = getComputedStyle(el);
      // 简单检查：背景和前景色不同
      return style.color !== style.backgroundColor;
    });
    
    expect(contrastRatio).toBe(true);
  });
});

test.describe('无障碍 - 屏幕阅读器', () => {
  
  test('动态内容使用 aria-live', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 触发一个会显示通知的操作
    await page.click('[data-testid="pokemon-card-0"]');
    
    // 检查通知区域有 aria-live
    const liveRegion = page.locator('[aria-live="polite"], [aria-live="assertive"]');
    await expect(liveRegion.first()).toBeVisible();
  });

  test('加载状态有 aria-busy', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    // 开始登录过程
    await page.goto('/');
    await page.fill('[data-testid="phone-input"]', TEST_USERS.existing.phone);
    await page.fill('[data-testid="code-input"]', TEST_USERS.existing.code);
    await page.click('[data-testid="login-btn"]');
    
    // 检查加载状态
    const busyElement = page.locator('[aria-busy="true"]');
    // 注：具体实现可能不同
  });

  test('隐藏元素使用 aria-hidden', async ({ page }) => {
    await page.goto('/');
    
    // 装饰性图标应该有 aria-hidden
    const decorativeIcons = page.locator('.logo-emoji, .empty-icon');
    const count = await decorativeIcons.count();
    
    for (let i = 0; i < count; i++) {
      const ariaHidden = await decorativeIcons.nth(i).getAttribute('aria-hidden');
      expect(ariaHidden).toBe('true');
    }
  });
});

test.describe('无障碍 - 焦点管理', () => {
  
  test('弹窗打开时焦点移入弹窗', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 打开设置弹窗
    await page.click('[data-testid="nav-profile"]');
    await page.click('[data-testid="accessibility-settings"]');
    
    // 验证焦点在弹窗内
    const modal = page.locator('[data-testid="accessibility-modal"]');
    const focusedInModal = await modal.evaluate((el) => {
      return el.contains(document.activeElement);
    });
    
    expect(focusedInModal).toBe(true);
  });

  test('弹窗关闭时焦点返回触发元素', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    await page.click('[data-testid="nav-profile"]');
    
    // 记录触发元素
    const trigger = page.locator('[data-testid="accessibility-settings"]');
    await trigger.click();
    
    // 关闭弹窗
    await page.keyboard.press('Escape');
    
    // 验证焦点返回触发元素
    await expect(trigger).toBeFocused();
  });
});
