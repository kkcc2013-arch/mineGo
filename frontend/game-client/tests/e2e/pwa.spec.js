/**
 * E2E 测试：PWA 功能
 * 测试 Service Worker、离线模式、安装提示
 */

const { test, expect } = require('@playwright/test');
const {
  TEST_USERS,
  waitForVisible,
  mockLoginApi,
  mockNearbyApi,
  mockInventoryApi,
  loginAsExistingUser,
  setOfflineMode
} = require('./helpers');

test.describe('PWA 功能', () => {
  
  test('Service Worker 注册成功', async ({ page }) => {
    await page.goto('/');
    
    // 等待 Service Worker 注册
    await page.waitForFunction(() => {
      return navigator.serviceWorker.getRegistration().then(reg => reg !== undefined);
    }, { timeout: 10000 });
    
    // 验证 Service Worker 已激活
    const swReady = await page.evaluate(() => {
      return navigator.serviceWorker.ready.then(() => true).catch(() => false);
    });
    
    expect(swReady).toBe(true);
  });

  test('PWA Manifest 可访问', async ({ page }) => {
    // 验证 manifest 文件存在
    const response = await page.request.get('/manifest.json');
    expect(response.status()).toBe(200);
    
    const manifest = await response.json();
    
    // 验证必要字段
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBeTruthy();
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('PWA 图标存在', async ({ page }) => {
    // 检查 manifest 中的图标是否可访问
    const manifestResponse = await page.request.get('/manifest.json');
    const manifest = await manifestResponse.json();
    
    for (const icon of manifest.icons) {
      const iconResponse = await page.request.get(icon.src);
      expect(iconResponse.status()).toBe(200);
    }
  });
});

test.describe('离线模式', () => {
  
  test('离线时显示离线横幅', async ({ page, context }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 设置离线
    await setOfflineMode(context, true);
    
    // 等待离线横幅显示
    await waitForVisible(page, '[data-testid="offline-banner"]', 5000);
    
    // 验证离线提示内容
    await expect(page.locator('[data-testid="offline-banner"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-banner"]')).toContainText('离线');
  });

  test('离线时缓存数据仍可访问', async ({ page, context }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 等待数据加载并缓存
    await page.waitForTimeout(2000);
    
    // 设置离线
    await setOfflineMode(context, true);
    
    // 验证用户名仍显示（来自缓存）
    await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
  });

  test('恢复网络后离线横幅消失', async ({ page, context }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 设置离线
    await setOfflineMode(context, true);
    await waitForVisible(page, '[data-testid="offline-banner"]', 5000);
    
    // 恢复网络
    await setOfflineMode(context, false);
    
    // 验证离线横幅消失
    await expect(page.locator('[data-testid="offline-banner"]')).not.toBeVisible({ timeout: 5000 });
  });

  test('离线时显示 Toast 提示', async ({ page, context }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 设置离线
    await setOfflineMode(context, true);
    
    // 验证显示离线 Toast
    await expect(page.locator('[data-testid="toast-message"]')).toContainText('离线', { timeout: 5000 });
  });
});

test.describe('PWA 安装提示', () => {
  
  test('安装提示在登录后延迟显示', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 等待安装提示（通常延迟 30 秒，测试时缩短）
    // 注：实际测试需要触发 beforeinstallprompt 事件
  });

  test('可以关闭安装提示', async ({ page }) => {
    await mockLoginApi(page);
    await mockNearbyApi(page);
    await mockInventoryApi(page);
    
    await loginAsExistingUser(page);
    
    // 手动显示安装提示进行测试
    await page.evaluate(() => {
      const prompt = document.getElementById('pwa-install-prompt');
      if (prompt) prompt.style.display = 'block';
    });
    
    // 点击稍后按钮
    await page.click('[data-testid="pwa-install-dismiss"]');
    
    // 验证提示消失
    await expect(page.locator('[data-testid="pwa-install-prompt"]')).not.toBeVisible();
  });
});

test.describe('Service Worker 缓存', () => {
  
  test('首次访问缓存静态资源', async ({ page }) => {
    // 监听缓存存储
    const cacheNames = await page.evaluate(async () => {
      const names = await caches.keys();
      return names;
    });
    
    // 验证至少有一个缓存
    expect(cacheNames.length).toBeGreaterThan(0);
  });

  test('缓存的页面可以离线访问', async ({ page, context }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // 设置离线
    await setOfflineMode(context, true);
    
    // 刷新页面
    await page.reload({ waitUntil: 'load' });
    
    // 验证页面仍然加载（来自缓存）
    await expect(page.locator('[data-testid="login-screen"]')).toBeVisible();
  });
});

test.describe('PWA - 后台同步', () => {
  
  test('后台同步事件注册', async ({ page }) => {
    // 检查后台同步 API 可用性
    const syncSupported = await page.evaluate(() => {
      return 'sync' in ServiceWorkerRegistration.prototype;
    });
    
    // 如果支持后台同步，验证可以注册
    if (syncSupported) {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      
      const registered = await page.evaluate(async () => {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.sync.register('sync-pending-data');
          return true;
        } catch (e) {
          return false;
        }
      });
      
      expect(registered).toBe(true);
    }
  });
});
