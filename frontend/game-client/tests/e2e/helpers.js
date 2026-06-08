/**
 * Playwright E2E 测试辅助函数
 * 提供登录、导航、Mock 等通用功能
 */

const { expect } = require('@playwright/test');

/**
 * 测试用户凭证
 */
const TEST_USERS = {
  existing: {
    phone: '13800138000',
    code: '123456',
    nickname: '测试训练师',
    level: 5
  },
  new: {
    phone: '13900139000',
    code: '654321',
    nickname: undefined // 将自动生成
  }
};

/**
 * 等待元素可见
 * @param {import('@playwright/test').Page} page 
 * @param {string} selector 
 * @param {number} timeout 
 */
async function waitForVisible(page, selector, timeout = 10000) {
  await page.locator(selector).waitFor({ state: 'visible', timeout });
}

/**
 * 等待元素隐藏
 * @param {import('@playwright/test').Page} page 
 * @param {string} selector 
 * @param {number} timeout 
 */
async function waitForHidden(page, selector, timeout = 5000) {
  await page.locator(selector).waitFor({ state: 'hidden', timeout });
}

/**
 * 等待页面加载完成
 * @param {import('@playwright/test').Page} page 
 */
async function waitForPageLoad(page) {
  await page.waitForLoadState('networkidle');
}

/**
 * 模拟 API 响应
 * @param {import('@playwright/test').Page} page 
 * @param {string} url 
 * @param {object} response 
 * @param {number} status 
 */
async function mockApiResponse(page, url, response, status = 200) {
  await page.route(url, route => {
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(response)
    });
  });
}

/**
 * Mock 登录 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockLoginApi(page) {
  await mockApiResponse(page, '**/v1/auth/login', {
    code: 0,
    message: '登录成功',
    data: {
      user: {
        id: 'test-user-001',
        phone: '13800138000',
        nickname: '测试训练师',
        level: 5,
        total_xp: 2500,
        total_caught: 42,
        team: 'blue',
        pokeball_count: 50,
        greatball_count: 10,
        ultraball_count: 5,
        stardust: 5000,
        coins: 100
      },
      access_token: 'test-access-token-' + Date.now(),
      refresh_token: 'test-refresh-token-' + Date.now()
    }
  });
}

/**
 * Mock 注册 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockRegisterApi(page) {
  await mockApiResponse(page, '**/v1/auth/register', {
    code: 0,
    message: '注册成功',
    data: {
      user: {
        id: 'test-user-new-' + Date.now(),
        phone: '13900139000',
        nickname: '训练师' + Math.floor(Math.random() * 9000 + 1000),
        level: 1,
        total_xp: 0,
        total_caught: 0,
        team: null,
        pokeball_count: 20,
        greatball_count: 0,
        ultraball_count: 0,
        stardust: 0,
        coins: 0
      },
      access_token: 'test-access-token-new-' + Date.now(),
      refresh_token: 'test-refresh-token-new-' + Date.now()
    }
  });
}

/**
 * Mock 短信验证码 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockSmsApi(page) {
  await mockApiResponse(page, '**/v1/auth/sms/send', {
    code: 0,
    message: '验证码已发送',
    data: {
      dev_code: '123456' // 测试环境自动返回验证码
    }
  });
}

/**
 * Mock 附近精灵 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockNearbyApi(page) {
  await mockApiResponse(page, '**/v1/location/nearby*', {
    code: 0,
    message: '成功',
    data: {
      wild_pokemons: [
        {
          id: 'pokemon-test-001',
          species_id: 25,
          species_name: '皮卡丘',
          lat: 31.2314,
          lng: 121.4747,
          cp: 450,
          iv: 15,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        },
        {
          id: 'pokemon-test-002',
          species_id: 1,
          species_name: '妙蛙种子',
          lat: 31.2294,
          lng: 121.4727,
          cp: 200,
          iv: 12,
          expires_at: new Date(Date.now() + 45 * 60 * 1000).toISOString()
        },
        {
          id: 'pokemon-test-003',
          species_id: 133,
          species_name: '伊布',
          lat: 31.2310,
          lng: 121.4740,
          cp: 350,
          iv: 14,
          expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
        }
      ],
      pokestops: [
        {
          id: 'pokestop-test-001',
          name: '人民广场补给站',
          lat: 31.2305,
          lng: 121.4735
        }
      ],
      gyms: [
        {
          id: 'gym-test-001',
          name: '人民广场道馆',
          lat: 31.2300,
          lng: 121.4730,
          team: 'blue'
        }
      ]
    }
  });
}

/**
 * Mock 捕捉 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockCatchApi(page, success = true) {
  await mockApiResponse(page, '**/v1/catch*', success ? {
    code: 0,
    message: '捕捉成功',
    data: {
      caught: true,
      pokemon: {
        id: 'caught-pokemon-001',
        species_id: 25,
        species_name: '皮卡丘',
        cp: 450,
        iv: 15
      },
      rewards: {
        xp: 100,
        stardust: 100,
        candy: 3
      }
    }
  } : {
    code: 0,
    message: '精灵逃脱了',
    data: {
      caught: false,
      fled: true
    }
  });
}

/**
 * Mock 用户信息 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockUserApi(page) {
  await mockApiResponse(page, '**/v1/users/me', {
    code: 0,
    message: '成功',
    data: {
      id: 'test-user-001',
      phone: '13800138000',
      nickname: '测试训练师',
      level: 5,
      total_xp: 2500,
      total_caught: 42,
      team: 'blue'
    }
  });
}

/**
 * Mock 背包 API
 * @param {import('@playwright/test').Page} page 
 */
async function mockInventoryApi(page) {
  await mockApiResponse(page, '**/v1/users/me/inventory', {
    code: 0,
    message: '成功',
    data: {
      pokeball_count: 50,
      greatball_count: 10,
      ultraball_count: 5,
      stardust: 5000,
      coins: 100
    }
  });
}

/**
 * 设置所有基础 Mock
 * @param {import('@playwright/test').Page} page 
 */
async function setupAllMocks(page) {
  await mockSmsApi(page);
  await mockLoginApi(page);
  await mockNearbyApi(page);
  await mockCatchApi(page);
  await mockUserApi(page);
  await mockInventoryApi(page);
}

/**
 * 以已登录用户身份开始测试
 * @param {import('@playwright/test').Page} page 
 */
async function loginAsExistingUser(page) {
  // 设置 Mock
  await setupAllMocks(page);
  
  // 导航到首页
  await page.goto('/');
  
  // 填写登录表单
  await page.fill('[data-testid="phone-input"]', TEST_USERS.existing.phone);
  await page.fill('[data-testid="code-input"]', TEST_USERS.existing.code);
  
  // 点击登录按钮
  await page.click('[data-testid="login-btn"]');
  
  // 等待导航到地图页
  await waitForVisible(page, '[data-testid="map-screen"]');
}

/**
 * 注册新用户
 * @param {import('@playwright/test').Page} page 
 */
async function registerNewUser(page) {
  await mockSmsApi(page);
  await mockRegisterApi(page);
  await mockNearbyApi(page);
  
  await page.goto('/');
  
  await page.fill('[data-testid="phone-input"]', TEST_USERS.new.phone);
  await page.fill('[data-testid="code-input"]', TEST_USERS.new.code);
  
  await page.click('[data-testid="login-btn"]');
  
  await waitForVisible(page, '[data-testid="map-screen"]');
}

/**
 * 导航到捕捉界面
 * @param {import('@playwright/test').Page} page 
 * @param {string} pokemonId 
 */
async function navigateToCatch(page, pokemonId = 'pokemon-test-001') {
  await loginAsExistingUser(page);
  
  // 点击第一个精灵卡片
  await page.click('[data-testid="pokemon-card-0"]');
  
  // 等待捕捉界面
  await waitForVisible(page, '[data-testid="catch-screen"]');
}

/**
 * 检查无障碍性
 * @param {import('@playwright/test').Page} page 
 */
async function checkAccessibility(page) {
  // 检查所有交互元素可通过 Tab 访问
  const focusableElements = await page.locator('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])').count();
  return focusableElements;
}

/**
 * 设置离线模式
 * @param {import('@playwright/test').Page} page 
 * @param {import('@playwright/test').BrowserContext} context 
 * @param {boolean} offline 
 */
async function setOfflineMode(context, offline = true) {
  await context.setOffline(offline);
}

module.exports = {
  TEST_USERS,
  waitForVisible,
  waitForHidden,
  waitForPageLoad,
  mockApiResponse,
  mockLoginApi,
  mockRegisterApi,
  mockSmsApi,
  mockNearbyApi,
  mockCatchApi,
  mockUserApi,
  mockInventoryApi,
  setupAllMocks,
  loginAsExistingUser,
  registerNewUser,
  navigateToCatch,
  checkAccessibility,
  setOfflineMode
};
