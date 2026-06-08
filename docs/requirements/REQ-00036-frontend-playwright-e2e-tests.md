# REQ-00036：前端 Playwright E2E 测试系统

- **编号**：REQ-00036
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：frontend/game-client、backend/tests/e2e、.github/workflows
- **创建时间**：2026-06-08 16:40
- **依赖需求**：无

## 1. 背景与问题

当前项目的 E2E 测试（REQ-00022）仅覆盖后端 API 层面，使用 supertest 进行接口级别的端到端测试。但游戏客户端（game-client）作为前端应用，缺少真实浏览器环境的 E2E 测试：

1. **前端交互未验证**：登录流程、地图交互、捕捉动画等用户界面操作未在真实浏览器中测试
2. **跨浏览器兼容性未知**：未验证 Chrome、Firefox、Safari 等主流浏览器的兼容性
3. **移动端响应式未测试**：游戏主要面向移动端用户，但缺少移动视口下的 UI 测试
4. **PWA 功能未验证**：Service Worker 缓存、离线模式、安装提示等 PWA 特性未经过 E2E 验证
5. **无障碍功能未端到端验证**：REQ-00017 和 REQ-00035 实现的无障碍功能缺少真实用户场景测试

现有 `backend/tests/e2e/user-journey.test.js` 是 API 级别的测试，不是前端 E2E 测试。

## 2. 目标

建立完整的前端 E2E 测试体系：

1. **用户关键旅程覆盖**：注册登录 → 地图浏览 → 精灵捕捉 → 道馆战斗 → 道具购买
2. **跨浏览器支持**：Chrome、Firefox、WebKit（Safari 引擎）
3. **移动端视口测试**：模拟 iPhone、Android 设备
4. **PWA 功能验证**：Service Worker、离线模式、安装提示
5. **无障碍验证**：键盘导航、屏幕阅读器兼容、色盲模式

预期收益：
- 发现 90%+ 的前端 UI 缺陷
- 确保跨浏览器兼容性
- CI/CD 集成，每次提交自动运行

## 3. 范围

### 包含
- Playwright 测试框架搭建
- 5 个核心用户旅程 E2E 测试
- 跨浏览器测试配置（Chrome/Firefox/WebKit）
- 移动端视口模拟
- PWA 功能测试（Service Worker、离线模式）
- 无障碍功能测试
- CI/CD 集成（GitHub Actions）
- 测试报告与截图/视频录制

### 不包含
- 视觉回归测试（需要额外的 Percy/Chromatic 集成）
- 性能测试（已有 REQ-00033 的 k6 压力测试）
- 后端 API 单独测试（已有单元测试和集成测试）

## 4. 详细需求

### 4.1 测试框架搭建

```javascript
// frontend/game-client/playwright.config.js
module.exports = {
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'results.xml' }]
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 12'] } },
  ],
  webServer: {
    command: 'npx serve . -l 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
};
```

### 4.2 核心测试用例

#### 测试 1: 用户注册登录流程
```javascript
// tests/e2e/auth.spec.js
test('新用户注册并登录', async ({ page }) => {
  await page.goto('/');
  
  // 填写注册表单
  await page.fill('[data-testid="email-input"]', 'e2e-test@example.com');
  await page.fill('[data-testid="password-input"]', 'Test123456!');
  await page.click('[data-testid="register-btn"]');
  
  // 验证跳转到地图页
  await expect(page).toHaveURL(/.*map/);
  await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
});
```

#### 测试 2: 地图浏览与精灵查看
```javascript
// tests/e2e/map.spec.js
test('查看附近精灵列表', async ({ page }) => {
  await loginAsExistingUser(page);
  
  // 等待地图加载
  await expect(page.locator('[data-testid="nearby-pokemon-list"]')).toBeVisible();
  
  // 点击精灵卡片
  await page.click('[data-testid="pokemon-card-0"]');
  
  // 验证精灵详情弹窗
  await expect(page.locator('[data-testid="pokemon-detail-modal"]')).toBeVisible();
});
```

#### 测试 3: 精灵捕捉流程
```javascript
// tests/e2e/catch.spec.js
test('捕捉野生精灵', async ({ page }) => {
  await loginAndNavigateToCatch(page, 'pokemon-test-id');
  
  // 验证捕捉界面
  await expect(page.locator('[data-testid="wild-pokemon"]')).toBeVisible();
  
  // 投掷精灵球
  await page.click('[data-testid="throw-ball-btn"]');
  
  // 等待捕捉结果
  await expect(page.locator('[data-testid="catch-result"]')).toBeVisible({ timeout: 10000 });
});
```

#### 测试 4: PWA 离线功能
```javascript
// tests/e2e/pwa.spec.js
test('离线模式下仍可查看已缓存数据', async ({ page, context }) => {
  await page.goto('/');
  await loginAsExistingUser(page);
  
  // 等待数据缓存
  await page.waitForTimeout(2000);
  
  // 模拟离线
  await context.setOffline(true);
  
  // 验证离线提示
  await expect(page.locator('[data-testid="offline-banner"]')).toBeVisible();
  
  // 验证缓存数据仍可访问
  await expect(page.locator('[data-testid="user-name"]')).toBeVisible();
});
```

#### 测试 5: 无障碍功能
```javascript
// tests/e2e/accessibility.spec.js
test('色盲模式切换', async ({ page }) => {
  await loginAsExistingUser(page);
  
  // 打开设置
  await page.click('[data-testid="settings-btn"]');
  
  // 启用色盲模式
  await page.click('[data-testid="colorblind-toggle"]');
  
  // 验证 CSS 变量变化
  const root = page.locator(':root');
  const filter = await root.evaluate(el => 
    getComputedStyle(el).getPropertyValue('--colorblind-filter')
  );
  expect(filter).toBeTruthy();
});
```

### 4.3 CI/CD 集成

```yaml
# .github/workflows/e2e-tests.yml
name: E2E Tests
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: frontend/game-client/package-lock.json
      
      - name: Install Playwright
        run: |
          cd frontend/game-client
          npm ci
          npx playwright install --with-deps
      
      - name: Run E2E tests
        run: |
          cd frontend/game-client
          npx playwright test
      
      - name: Upload test artifacts
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: frontend/game-client/playwright-report/
          retention-days: 30
```

### 4.4 data-testid 属性添加

需要为关键 UI 元素添加 `data-testid` 属性：

- `[data-testid="email-input"]` - 邮箱输入框
- `[data-testid="password-input"]` - 密码输入框
- `[data-testid="register-btn"]` - 注册按钮
- `[data-testid="login-btn"]` - 登录按钮
- `[data-testid="user-name"]` - 用户名显示
- `[data-testid="nearby-pokemon-list"]` - 附近精灵列表
- `[data-testid="pokemon-card-{i}"]` - 精灵卡片
- `[data-testid="throw-ball-btn"]` - 投掷精灵球按钮
- `[data-testid="catch-result"]` - 捕捉结果显示
- `[data-testid="offline-banner"]` - 离线提示横幅
- `[data-testid="settings-btn"]` - 设置按钮
- `[data-testid="colorblind-toggle"]` - 色盲模式开关

## 5. 验收标准（可测试）

- [ ] Playwright 配置文件创建，支持 5 个项目（chromium/firefox/webkit/mobile-chrome/mobile-safari）
- [ ] 至少 15 个 E2E 测试用例覆盖 5 个核心用户旅程
- [ ] 所有测试在本地通过：`npx playwright test`
- [ ] GitHub Actions 工作流创建，测试在 CI 中通过
- [ ] 关键 UI 元素添加 data-testid 属性
- [ ] 测试失败时自动截图和录制视频
- [ ] HTML 测试报告生成
- [ ] PWA 离线测试通过
- [ ] 无障碍测试通过（键盘导航、色盲模式）

## 6. 工作量估算

**M（中等）**

理由：
- Playwright 框架搭建：2-3 小时
- 测试用例编写：4-5 小时
- data-testid 属性添加：1-2 小时
- CI/CD 集成：1 小时
- 调试与修复：2-3 小时

总计约 10-14 小时。

## 7. 优先级理由

**P1 理由**：
1. **测试覆盖关键缺口**：STATUS.md 明确指出"缺少 Playwright/Cypress 前端测试"为高价值缺口
2. **对项目可用性贡献大**：前端 E2E 测试是发现 UI 缺陷的最后一道防线
3. **支撑未来维护**：有 E2E 测试保护，未来前端重构风险大幅降低
4. **用户真实体验验证**：API 测试无法验证用户在浏览器中的真实体验
