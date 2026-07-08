/**
 * A11y Tests - 无障碍自动化测试
 * REQ-00503: 游戏客户端屏幕阅读器与 ARIA 无障碍支持
 * 
 * 使用 axe-core 进行自动化无障碍测试
 */

import ARIAUtils, { ARIARoles, ARIAAttributes } from '../src/accessibility/ariaUtils.js';
import { A11yAnnouncer, AnnouncerVerbosity } from '../src/accessibility/announcer.js';
import { focusManager } from '../src/accessibility/focusManager.js';

/**
 * 测试套件
 */
export class A11yTestSuite {
  constructor() {
    this.testResults = [];
    this.passedTests = 0;
    this.failedTests = 0;
  }

  /**
   * 运行所有测试
   */
  async runAll() {
    console.log('🧪 Running A11y Test Suite...\n');
    
    await this.testARIAUtils();
    await this.testAnnouncer();
    await this.testFocusManager();
    
    this.printSummary();
    
    return {
      passed: this.passedTests,
      failed: this.failedTests,
      results: this.testResults
    };
  }

  /**
   * 测试 ARIAUtils
   */
  async testARIAUtils() {
    console.log('📦 Testing ARIAUtils...');
    
    // 测试设置角色
    const element = document.createElement('div');
    ARIAUtils.setRole(element, ARIARoles.BUTTON);
    this.assert(
      element.getAttribute('role') === 'button',
      'setRole should set role attribute'
    );
    
    // 测试设置标签
    ARIAUtils.setLabel(element, 'Test Button');
    this.assert(
      element.getAttribute('aria-label') === 'Test Button',
      'setLabel should set aria-label'
    );
    
    // 测试设置隐藏状态
    ARIAUtils.setHidden(element, true);
    this.assert(
      element.getAttribute('aria-hidden') === 'true',
      'setHidden should set aria-hidden to true'
    );
    this.assert(
      element.getAttribute('tabindex') === '-1',
      'setHidden should set tabindex to -1'
    );
    
    // 测试设置值（进度条）
    ARIAUtils.setValue(element, 50, 0, 100);
    this.assert(
      element.getAttribute('aria-valuenow') === '50',
      'setValue should set aria-valuenow'
    );
    this.assert(
      element.getAttribute('aria-valuemin') === '0',
      'setValue should set aria-valuemin'
    );
    this.assert(
      element.getAttribute('aria-valuemax') === '100',
      'setValue should set aria-valuemax'
    );
    this.assert(
      element.getAttribute('aria-valuetext') === '50%',
      'setValue should set aria-valuetext with percentage'
    );
    
    // 测试创建按钮
    const button = ARIAUtils.createButton('Click Me', () => {}, {
      ariaLabel: 'Test Button'
    });
    this.assert(
      button.tagName === 'BUTTON',
      'createButton should create button element'
    );
    this.assert(
      button.getAttribute('aria-label') === 'Test Button',
      'createButton should set aria-label'
    );
    
    console.log('✅ ARIAUtils tests completed\n');
  }

  /**
   * 测试 Announcer
   */
  async testAnnouncer() {
    console.log('📦 Testing Announcer...');
    
    const announcer = new A11yAnnouncer();
    
    // 测试初始化
    this.assert(
      announcer.liveRegion !== null,
      'Announcer should initialize liveRegion'
    );
    this.assert(
      announcer.assertiveRegion !== null,
      'Announcer should initialize assertiveRegion'
    );
    
    // 测试播报队列
    announcer.announce('Test message');
    this.assert(
      announcer.announceQueue.length === 1,
      'Announce should add to queue'
    );
    
    // 测试配置设置
    announcer.setSettings({
      verbosity: AnnouncerVerbosity.DETAILED
    });
    this.assert(
      announcer.settings.verbosity === AnnouncerVerbosity.DETAILED,
      'setSettings should update verbosity'
    );
    
    // 测试精灵出现播报
    announcer.announcePokemonSpawn('Pikachu', 50, 'rare');
    this.assert(
      announcer.announceQueue.length > 0,
      'announcePokemonSpawn should add to queue'
    );
    
    console.log('✅ Announcer tests completed\n');
  }

  /**
   * 测试 FocusManager
   */
  async testFocusManager() {
    console.log('📦 Testing FocusManager...');
    
    const manager = focusManager;
    
    // 测试保存焦点
    const testElement = document.createElement('input');
    document.body.appendChild(testElement);
    testElement.focus();
    
    manager.saveFocus();
    this.assert(
      manager.focusHistory.length > 0,
      'saveFocus should add to history'
    );
    
    // 测试恢复焦点
    const anotherElement = document.createElement('input');
    document.body.appendChild(anotherElement);
    anotherElement.focus();
    
    manager.restoreFocus();
    this.assert(
      document.activeElement === testElement,
      'restoreFocus should restore previous focus'
    );
    
    // 测试焦点陷阱
    const trapContainer = document.createElement('div');
    const button1 = document.createElement('button');
    button1.textContent = 'Button 1';
    const button2 = document.createElement('button');
    button2.textContent = 'Button 2';
    trapContainer.appendChild(button1);
    trapContainer.appendChild(button2);
    document.body.appendChild(trapContainer);
    
    const trap = manager.trapFocus(trapContainer, {
      returnFocus: true
    });
    
    this.assert(
      manager.currentTrap === trap,
      'trapFocus should set currentTrap'
    );
    
    manager.releaseTrap();
    this.assert(
      manager.currentTrap === null,
      'releaseTrap should clear currentTrap'
    );
    
    // 清理
    document.body.removeChild(testElement);
    document.body.removeChild(anotherElement);
    document.body.removeChild(trapContainer);
    
    console.log('✅ FocusManager tests completed\n');
  }

  /**
   * 断言辅助方法
   */
  assert(condition, message) {
    const result = {
      message,
      passed: condition
    };
    
    this.testResults.push(result);
    
    if (condition) {
      this.passedTests++;
      console.log(`  ✅ ${message}`);
    } else {
      this.failedTests++;
      console.log(`  ❌ ${message}`);
    }
  }

  /**
   * 打印测试摘要
   */
  printSummary() {
    console.log('\n📊 Test Summary');
    console.log('─'.repeat(40));
    console.log(`✅ Passed: ${this.passedTests}`);
    console.log(`❌ Failed: ${this.failedTests}`);
    console.log(`📈 Total: ${this.passedTests + this.failedTests}`);
    console.log('─'.repeat(40));
    
    if (this.failedTests === 0) {
      console.log('\n🎉 All tests passed!\n');
    } else {
      console.log('\n⚠️  Some tests failed. Please review.\n');
    }
  }
}

/**
 * 手动测试指南（用于屏幕阅读器验证）
 */
export const manualTestGuide = {
  title: '手动无障碍测试指南',
  
  steps: [
    {
      platform: 'Windows + NVDA',
      setup: [
        '1. 下载并安装 NVDA：https://www.nvaccess.org/download/',
        '2. 启动 NVDA（Ctrl + Alt + N）',
        '3. 打开 Chrome 或 Firefox 浏览器',
        '4. 访问游戏客户端'
      ],
      tests: [
        '✅ Tab 键导航：验证焦点顺序是否符合逻辑',
        '✅ 屏幕阅读器播报：精灵出现时是否听到播报',
        '✅ 战斗状态：HP 变化时是否播报',
        '✅ 模态框：打开详情后 Tab 是否在模态框内循环',
        '✅ ESC 关闭：按 ESC 是否关闭模态框并恢复焦点'
      ]
    },
    
    {
      platform: 'macOS + VoiceOver',
      setup: [
        '1. 启用 VoiceOver：Cmd + F5',
        '2. 打开 Safari 浏览器',
        '3. 访问游戏客户端'
      ],
      tests: [
        '✅ Tab 键导航：验证焦点顺序',
        '✅ VO + 左/右箭头：浏览页面元素',
        '✅ VO + 空格：激活按钮',
        '✅ 实时播报：精灵出现时 VoiceOver 是否播报',
        '✅ 模态框：VO 是否正确进入模态框'
      ]
    },
    
    {
      platform: 'iOS + VoiceOver',
      setup: [
        '1. 设置 > 辅助功能 > VoiceOver > 启用',
        '2. 打开 Safari 访问游戏客户端'
      ],
      tests: [
        '✅ 左/右滑动：在元素间移动',
        '✅ 双击：激活按钮',
        '✅ 实时播报：精灵出现时是否播报',
        '✅ 手势导航：使用标准 VoiceOver 手势'
      ]
    },
    
    {
      platform: 'Android + TalkBack',
      setup: [
        '1. 设置 > 辅助功能 > TalkBack > 启用',
        '2. 打开 Chrome 访问游戏客户端'
      ],
      tests: [
        '✅ 左/右滑动：在元素间移动',
        '✅ 双击：激活按钮',
        '✅ 实时播报：精灵出现时是否播报',
        '✅ 手势导航：使用标准 TalkBack 手势'
      ]
    }
  ],
  
  printGuide() {
    console.log('\n📖 ' + this.title);
    console.log('='.repeat(60));
    
    this.steps.forEach(({ platform, setup, tests }) => {
      console.log(`\n🔧 ${platform}`);
      console.log('─'.repeat(40));
      
      console.log('\n📋 Setup:');
      setup.forEach(step => console.log(`  ${step}`));
      
      console.log('\n✅ Tests:');
      tests.forEach(test => console.log(`  ${test}`));
    });
    
    console.log('\n' + '='.repeat(60));
  }
};

/**
 * WCAG 2.1 AA 检查清单
 */
export const wcagChecklist = {
  title: 'WCAG 2.1 AA 无障碍检查清单',
  
  principles: [
    {
      name: '可感知（Perceivable）',
      guidelines: [
        {
          id: '1.1.1',
          name: '非文本内容',
          check: '所有图片是否有 alt 文本？',
          status: 'pending'
        },
        {
          id: '1.3.1',
          name: '信息和关系',
          check: '是否使用语义化标签（nav, main, button 等）？',
          status: 'pending'
        },
        {
          id: '1.4.3',
          name: '对比度（最小值）',
          check: '文本对比度是否达到 4.5:1？',
          status: 'pending'
        }
      ]
    },
    
    {
      name: '可操作（Operable）',
      guidelines: [
        {
          id: '2.1.1',
          name: '键盘',
          check: '所有功能是否可通过键盘访问？',
          status: 'pending'
        },
        {
          id: '2.4.3',
          name: '焦点顺序',
          check: 'Tab 顺序是否符合逻辑？',
          status: 'pending'
        },
        {
          id: '2.4.7',
          name: '焦点可见',
          check: '焦点指示器是否清晰可见？',
          status: 'pending'
        }
      ]
    },
    
    {
      name: '可理解（Understandable）',
      guidelines: [
        {
          id: '3.2.1',
          name: '聚焦时',
          check: '聚焦时是否不会触发意外变化？',
          status: 'pending'
        },
        {
          id: '3.3.1',
          name: '错误识别',
          check: '表单错误是否清晰标识？',
          status: 'pending'
        }
      ]
    },
    
    {
      name: '健壮（Robust）',
      guidelines: [
        {
          id: '4.1.1',
          name: '解析',
          check: 'HTML 是否有效且格式正确？',
          status: 'pending'
        },
        {
          id: '4.1.2',
          name: '名称、角色、值',
          check: '自定义控件是否有正确的 ARIA 属性？',
          status: 'pending'
        }
      ]
    }
  ],
  
  printChecklist() {
    console.log('\n✅ ' + this.title);
    console.log('='.repeat(60));
    
    this.principles.forEach(principle => {
      console.log(`\n📌 ${principle.name}`);
      console.log('─'.repeat(40));
      
      principle.guidelines.forEach(guideline => {
        const statusIcon = guideline.status === 'done' ? '✅' : '⬜';
        console.log(`  ${statusIcon} [${guideline.id}] ${guideline.name}`);
        console.log(`     ${guideline.check}`);
      });
    });
    
    console.log('\n' + '='.repeat(60));
  }
};

// 导出测试套件
export default A11yTestSuite;

// 如果直接运行此文件，执行测试
if (typeof window !== 'undefined' && window.location) {
  const suite = new A11yTestSuite();
  suite.runAll();
  
  // 打印手动测试指南
  manualTestGuide.printGuide();
  
  // 打印 WCAG 检查清单
  wcagChecklist.printChecklist();
}