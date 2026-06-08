// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright E2E 测试配置
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  // Test directory
  testDir: './tests/e2e',
  
  // Run tests in parallel
  fullyParallel: true,
  
  // Fail build on CI if you accidentally left test.only in source code
  forbidOnly: !!process.env.CI,
  
  // Retry failed tests on CI
  retries: process.env.CI ? 2 : 0,
  
  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : undefined,
  
  // Reporter configuration
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['list']
  ],
  
  // Shared settings for all tests
  use: {
    // Base URL for tests
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    
    // Collect trace on retry
    trace: 'on-first-retry',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
    
    // Video on failure
    video: 'retain-on-failure',
    
    // Browser context options
    contextOptions: {
      // Ignore HTTPS errors for local testing
      ignoreHTTPSErrors: true,
    },
    
    // Action timeout
    actionTimeout: 10000,
    
    // Navigation timeout
    navigationTimeout: 30000,
  },

  // Configure projects for major browsers and mobile viewports
  projects: [
    {
      name: 'chromium',
      use: { 
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 }
      },
    },
    {
      name: 'firefox',
      use: { 
        browserName: 'firefox',
        viewport: { width: 1280, height: 720 }
      },
    },
    {
      name: 'webkit',
      use: { 
        browserName: 'webkit',
        viewport: { width: 1280, height: 720 }
      },
    },
    // Mobile Chrome (Android)
    {
      name: 'mobile-chrome',
      use: {
        browserName: 'chromium',
        ...devices['Pixel 5'],
      },
    },
    // Mobile Safari (iOS)
    {
      name: 'mobile-safari',
      use: {
        browserName: 'webkit',
        ...devices['iPhone 12'],
      },
    },
  ],

  // Run local dev server before tests
  webServer: {
    command: 'npx serve . -l 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
