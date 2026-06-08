/**
 * E2E 测试：用户认证流程
 * 测试注册、登录、登出等认证相关功能
 */

const { test, expect } = require('@playwright/test');
const {
  TEST_USERS,
  waitForVisible,
  waitForHidden,
  mockSmsApi,
  mockLoginApi,
  mockRegisterApi,
  mockNearbyApi,
  mockUserApi
} = require('./helpers');

test.describe('用户认证流程', () => {
  
  test.beforeEach(async ({ page }) => {
    // 设置基础 Mock
    await mockSmsApi(page);
    await mockNearbyApi(page);
    await mockUserApi(page);
  });

  test('显示登录界面', async ({ page }) => {
    await page.goto('/');
    
    // 验证登录界面元素
    await expect(page.locator('[data-testid="login-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="phone-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="code-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="login-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="sms-btn"]')).toBeVisible();
  });

  test('发送短信验证码', async ({ page }) => {
    await page.goto('/');
    
    // 填写手机号
    await page.fill('[data-testid="phone-input"]', '13800138000');
    
    // 点击发送验证码
    await page.click('[data-testid="sms-btn"]');
    
    // 验证按钮变为倒计时
    await expect(page.locator('[data-testid="sms-btn"]')).toContainText(/\d+s/);
  });

  test('登录成功后跳转到地图页', async ({ page }) => {
    await mockLoginApi(page);
    
    await page.goto('/');
    
    // 填写登录表单
    await page.fill('[data-testid="phone-input"]', TEST_USERS.existing.phone);
    await page.fill('[data-testid="code-input"]', TEST_USERS.existing.code);
    
    // 点击登录
    await page.click('[data-testid="login-btn"]');
    
    // 验证跳转到地图页
    await waitForVisible(page, '[data-testid="map-screen"]');
    await expect(page.locator('[data-testid="map-screen"]')).toBeVisible();
    
    // 验证用户信息显示
    await expect(page.locator('[data-testid="user-name"]')).toContainText('训练师');
  });

  test('新用户自动注册', async ({ page }) => {
    await mockRegisterApi(page);
    
    await page.goto('/');
    
    await page.fill('[data-testid="phone-input"]', TEST_USERS.new.phone);
    await page.fill('[data-testid="code-input"]', TEST_USERS.new.code);
    
    await page.click('[data-testid="login-btn"]');
    
    // 验证跳转到地图页
    await waitForVisible(page, '[data-testid="map-screen"]');
    await expect(page.locator('[data-testid="nav-bar"]')).toBeVisible();
  });

  test('手机号格式验证', async ({ page }) => {
    await page.goto('/');
    
    // 输入无效手机号
    await page.fill('[data-testid="phone-input"]', '12345');
    await page.click('[data-testid="sms-btn"]');
    
    // 验证显示错误提示
    await expect(page.locator('[data-testid="toast-message"]')).toContainText('手机号');
  });

  test('验证码为空提示', async ({ page }) => {
    await page.goto('/');
    
    await page.fill('[data-testid="phone-input"]', '13800138000');
    await page.fill('[data-testid="code-input"]', '');
    
    await page.click('[data-testid="login-btn"]');
    
    // 验证显示错误提示
    await expect(page.locator('[data-testid="toast-message"]')).toContainText('验证码');
  });

  test('登出功能', async ({ page }) => {
    await mockLoginApi(page);
    
    await page.goto('/');
    
    // 登录
    await page.fill('[data-testid="phone-input"]', TEST_USERS.existing.phone);
    await page.fill('[data-testid="code-input"]', TEST_USERS.existing.code);
    await page.click('[data-testid="login-btn"]');
    
    await waitForVisible(page, '[data-testid="map-screen"]');
    
    // 导航到个人页
    await page.click('[data-testid="nav-profile"]');
    await waitForVisible(page, '[data-testid="profile-screen"]');
    
    // 点击登出
    await page.click('[data-testid="logout-btn"]');
    
    // 验证返回登录页
    await expect(page.locator('[data-testid="login-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-bar"]')).not.toBeVisible();
  });

  test('记住登录状态（刷新页面后保持登录）', async ({ page }) => {
    await mockLoginApi(page);
    
    await page.goto('/');
    
    // 登录
    await page.fill('[data-testid="phone-input"]', TEST_USERS.existing.phone);
    await page.fill('[data-testid="code-input"]', TEST_USERS.existing.code);
    await page.click('[data-testid="login-btn"]');
    
    await waitForVisible(page, '[data-testid="map-screen"]');
    
    // 刷新页面
    await page.reload();
    
    // 验证仍然在地图页（已登录状态）
    await expect(page.locator('[data-testid="map-screen"]')).toBeVisible();
  });
});

test.describe('登录界面 - 响应式布局', () => {
  
  test('移动端布局', async ({ page }) => {
    // 设置移动端视口
    await page.setViewportSize({ width: 375, height: 667 });
    
    await page.goto('/');
    
    // 验证登录界面适配移动端
    await expect(page.locator('[data-testid="login-screen"]')).toBeVisible();
    
    // 验证输入框宽度适应屏幕
    const phoneInput = page.locator('[data-testid="phone-input"]');
    const box = await phoneInput.boundingBox();
    expect(box.width).toBeLessThan(375);
  });

  test('桌面端布局', async ({ page }) => {
    // 设置桌面端视口
    await page.setViewportSize({ width: 1920, height: 1080 });
    
    await page.goto('/');
    
    await expect(page.locator('[data-testid="login-screen"]')).toBeVisible();
    
    // 验证输入框居中显示
    const phoneInput = page.locator('[data-testid="phone-input"]');
    const box = await phoneInput.boundingBox();
    expect(box.width).toBeLessThan(400); // 最大宽度限制
  });
});
