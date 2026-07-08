# REQ-00503：游戏客户端屏幕阅读器与 ARIA 无障碍支持

- **编号**：REQ-00503
- **类别**：无障碍(a11y)
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、所有 UI 组件
- **创建时间**：2026-07-08 12:00
- **依赖需求**：无

## 1. 背景与问题

### 当前现状
mineGo 游戏客户端已有 13 个无障碍相关文件（色盲模式、高对比度、键盘导航、动画安全等），形成了完善的无障碍基础设施：
- `ColorBlindMode.js` - 色盲适配
- `HighContrastMode.js` - 高对比度
- `keyboard.js` - 键盘导航
- `announcer.js` - 屏幕阅读器播报（已存在但未完整实现）
- `animation.js` - 动画安全

### 核心问题
通过代码审查发现：
1. **零 ARIA 属性**：整个 `frontend/game-client` 目录中没有使用任何 `aria-*` 属性（grep 结果 0 条）
2. **语义化不足**：UI 组件使用 `<div>` 和 `<span>` 而非语义化标签（`<button>`、`<nav>`、`<main>`）
3. **屏幕阅读器体验缺失**：视障用户无法有效获取游戏状态、精灵信息、战斗状态等关键信息
4. **合规风险**：不符合 WCAG 2.1 AA 标准，可能面临法律合规问题（欧盟 EAA、美国 ADA）
5. **用户群体受限**：无法服务视障玩家群体，损失潜在用户

### 影响范围
- 主界面：地图、精灵列表、背包、道馆
- 战斗系统：捕捉战斗、道馆战
- 社交功能：好友列表、交易
- 支付流程：商品选择、确认

## 2. 目标

### 主要目标
为 mineGo 游戏客户端实现完整的 ARIA 无障碍支持，使视障用户能够通过屏幕阅读器有效游玩游戏。

### 可量化收益
- **合规性**：达到 WCAG 2.1 AA 级标准（法规强制要求）
- **用户覆盖**：服务约 2.85 亿视障用户（WHO 数据）
- **可测试**：所有关键用户路径通过 NVDA、VoiceOver、TalkBack 测试
- **代码质量**：ARIA 属性覆盖率达到核心 UI 组件的 100%

## 3. 范围

### 包含
1. **ARIA 角色与属性**：
   - 所有交互元素添加 `role` 属性（button、navigation、main、article 等）
   - 状态属性（`aria-expanded`、`aria-selected`、`aria-checked` 等）
   - 实时区域（`aria-live`）用于游戏状态播报

2. **语义化 HTML**：
   - 替换通用 `<div>` 为语义化标签（`<nav>`、`<main>`、`<aside>`、`<section>`）
   - 表单控件使用原生 `<button>`、`<input>` 而非模拟

3. **屏幕阅读器播报**：
   - 扩展 `announcer.js` 实现完整的 `aria-live` 区域
   - 精灵出现、捕捉成功/失败、战斗状态变化的语音播报
   - 可配置的播报详细程度（简洁/详细模式）

4. **焦点管理**：
   - 键盘导航时的焦点顺序优化
   - 模态框、弹窗的焦点捕获与恢复
   - `aria-hidden` 正确应用于隐藏内容

5. **测试与验证**：
   - 集成 axe-core 自动化无障碍测试
   - 手动测试 NVDA（Windows）、VoiceOver（macOS/iOS）、TalkBack（Android）

### 不包含
- 第三方 SDK 的无障碍改造（如支付 SDK）
- 音频描述（audio description）功能
- 手语视频内容

## 4. 详细需求

### 4.1 ARIA 角色系统（P0）

#### 4.1.1 主界面结构
```html
<!-- 主布局 -->
<div role="application" aria-label="mineGo 游戏">
  <!-- 地图区域 -->
  <section role="region" aria-label="游戏地图">
    <div role="img" aria-label="当前位置：中央公园"></div>
  </section>
  
  <!-- 导航栏 -->
  <nav role="navigation" aria-label="主菜单">
    <button role="menuitem" aria-label="背包"></button>
    <button role="menuitem" aria-label="精灵列表"></button>
    <button role="menuitem" aria-label="道馆"></button>
  </nav>
  
  <!-- 状态栏 -->
  <aside role="status" aria-live="polite" aria-label="游戏状态"></aside>
</div>
```

#### 4.1.2 精灵列表
```html
<div role="list" aria-label="我的精灵，共 25 只">
  <article role="listitem" aria-posinset="1" aria-setsize="25">
    <h3>Pikachu</h3>
    <p role="status">CP 450, 生命值 120/150</p>
    <button aria-label="查看详情">详情</button>
  </article>
</div>
```

#### 4.1.3 战斗界面
```html
<div role="region" aria-label="战斗：Pikachu vs Weedle">
  <div role="status" aria-live="assertive">
    <!-- 实时播报战斗状态 -->
  </div>
  
  <div role="meter" 
       aria-label="我方生命值" 
       aria-valuenow="120" 
       aria-valuemin="0" 
       aria-valuemax="150">
    <div style="width: 80%"></div>
  </div>
  
  <button role="button" aria-label="投掷精灵球">投球</button>
</div>
```

### 4.2 实时播报系统（P0）

#### 4.2.1 Announcer 扩展
```javascript
// src/accessibility/announcer.js 增强版
export class GameAnnouncer {
  constructor() {
    this.liveRegions = {
      polite: document.getElementById('aria-live-polite'),
      assertive: document.getElementById('aria-live-assertive')
    };
  }
  
  // 精灵出现
  announcePokemonSpawn(pokemon, distance) {
    this.announce(
      `${pokemon.name} 出现在 ${distance} 米外`,
      'polite'
    );
  }
  
  // 捕捉结果
  announceCatchResult(success, pokemon, xpGained) {
    const message = success 
      ? `成功捕捉 ${pokemon.name}！获得 ${xpGained} 经验值`
      : `${pokemon.name} 逃跑了`;
    this.announce(message, 'assertive');
  }
  
  // 战斗状态
  announceBattleState(state) {
    this.announce(state, 'assertive');
  }
  
  // 焦点变化
  announceFocus(element, description) {
    this.announce(description, 'polite');
  }
}
```

#### 4.2.2 播报配置
```javascript
// 用户可配置播报详细程度
const announcerSettings = {
  verbosity: 'detailed', // 'minimal' | 'normal' | 'detailed'
  announceDistance: true,
  announceStats: true,
  announceBattle: true
};
```

### 4.3 焦点管理（P1）

#### 4.3.1 焦点顺序
```javascript
// src/accessibility/focusManager.js
export class FocusManager {
  constructor() {
    this.focusHistory = [];
  }
  
  // 保存当前焦点
  saveFocus() {
    this.focusHistory.push(document.activeElement);
  }
  
  // 恢复焦点（用于模态框关闭后）
  restoreFocus() {
    const previous = this.focusHistory.pop();
    if (previous) {
      previous.focus();
    }
  }
  
  // 设置焦点并播报
  setFocusWithAnnouncement(element, message) {
    element.focus();
    announcer.announce(message, 'polite');
  }
  
  // 焦点陷阱（模态框）
  trapFocus(container) {
    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    
    container.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    });
  }
}
```

### 4.4 语义化改造（P1）

#### 4.4.1 导航改造
```html
<!-- 改造前 -->
<div class="nav-menu">
  <div class="nav-item" onclick="openBag()">背包</div>
  <div class="nav-item" onclick="openPokedex()">图鉴</div>
</div>

<!-- 改造后 -->
<nav class="nav-menu" aria-label="主菜单">
  <button class="nav-item" aria-label="背包，10 个物品">背包</button>
  <button class="nav-item" aria-label="图鉴，已收集 25/151">图鉴</button>
</nav>
```

#### 4.4.2 精灵详情改造
```html
<!-- 改造前 -->
<div class="pokemon-card">
  <img src="pikachu.png">
  <div class="name">Pikachu</div>
  <div class="cp">CP 450</div>
</div>

<!-- 改造后 -->
<article class="pokemon-card" role="article" aria-label="精灵：Pikachu">
  <img src="pikachu.png" alt="Pikachu 立绘">
  <h3 class="name">Pikachu</h3>
  <p class="cp" role="status">CP 450</p>
  <dl>
    <dt>属性</dt><dd>电系</dd>
    <dt>生命值</dt><dd>120/150</dd>
    <dt>技能</dt><dd>十万伏特、电光一闪</dd>
  </dl>
</article>
```

### 4.5 自动化测试（P1）

#### 4.5.1 axe-core 集成
```javascript
// tests/accessibility/axe.test.js
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

describe('无障碍测试', () => {
  test('主界面无障碍', async () => {
    const { container } = render(<GameMap />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
  
  test('精灵列表无障碍', async () => {
    const { container } = render(<PokemonList />);
    const results = await axe(container, {
      rules: {
        'color-contrast': { enabled: false } // 色盲模式单独测试
      }
    });
    expect(results).toHaveNoViolations();
  });
});
```

#### 4.5.2 测试覆盖率要求
- 核心 UI 组件：100% 通过 axe-core 测试
- 关键用户路径：100% 通过手动屏幕阅读器测试
- ARIA 属性使用：所有交互元素必须有适当的 `role` 和 `aria-*` 属性

## 5. 验收标准（可测试）

- [ ] **ARIA 角色覆盖**：所有交互元素（按钮、导航、列表、表单）拥有正确的 `role` 属性
- [ ] **实时播报功能**：精灵出现、捕捉结果、战斗状态变化时屏幕阅读器正确播报
- [ ] **焦点管理**：Tab 键导航顺序符合逻辑，模态框焦点陷阱正常工作
- [ ] **语义化 HTML**：使用语义化标签（`<nav>`、`<main>`、`<button>` 等）替代通用 `<div>`
- [ ] **NVDA 测试通过**：在 Windows 10/11 + Chrome/Firefox + NVDA 环境下完成核心用户路径测试
- [ ] **VoiceOver 测试通过**：在 macOS/iOS + Safari + VoiceOver 环境下完成核心用户路径测试
- [ ] **TalkBack 测试通过**：在 Android + Chrome + TalkBack 环境下完成核心用户路径测试
- [ ] **axe-core 测试通过**：所有核心 UI 组件无 axe-core 违规
- [ ] **WCAG 2.1 AA 合规**：通过 W3C 无障碍评估工具验证达到 AA 级标准
- [ ] **焦点可见性**：所有可聚焦元素有清晰的焦点指示器（已有，但需验证与 ARIA 结合）

## 6. 工作量估算

**规模：L（大）**

### 理由
1. **范围广**：涉及整个游戏客户端（地图、战斗、社交、支付等所有界面）
2. **测试复杂**：需要 3 个屏幕阅读器（NVDA、VoiceOver、TalkBack）的手动测试
3. **设计决策**：需要权衡播报频率（太频繁会干扰，太少会遗漏关键信息）
4. **用户研究**：建议邀请视障用户进行可用性测试（可选但推荐）
5. **培训成本**：开发团队需要学习 ARIA 规范和最佳实践

### 预估时间
- ARIA 角色系统：2 天
- 实时播报系统：1 天
- 焦点管理：1 天
- 语义化改造：2 天
- 测试与验证：2 天
- **总计：约 8 个工作日**

## 7. 优先级理由

### P1 理由（非 P0）
1. **法规合规压力**：欧盟无障碍法案（EAA）2025 年 6 月强制生效，美国 ADA 也要求数字服务无障碍
2. **用户群体**：WHO 数据显示全球有 2.85 亿视障人士，其中 3600 万全盲用户依赖屏幕阅读器
3. **品牌形象**：无障碍是社会责任和包容性设计的重要体现，影响品牌声誉
4. **技术债务**：早期未考虑无障碍，现在改造成本比从头设计高 2-3 倍

### 为何不是 P0
- P0 需求通常是核心功能缺失或严重安全问题
- 视障用户目前虽无法游玩，但非核心功能缺失（如支付失败、战斗无法进行）
- 有 1 年以上的合规缓冲期（EAA 2025 年 6 月生效）

### 依赖关系
- 可与 REQ-00501（日志抽象层）并行开发，无技术依赖
- 建议在前端测试框架完善后实施（当前测试覆盖率 70%）

## 8. 实施计划（可选）

### 阶段 1：基础设施（P0，1 天）
- [ ] 创建 ARIA 工具库（`src/accessibility/ariaUtils.js`）
- [ ] 集成 axe-core 到测试框架
- [ ] 搭建屏幕阅读器测试环境

### 阶段 2：核心界面（P0，3 天）
- [ ] 主界面（地图、导航栏）
- [ ] 精灵列表和详情
- [ ] 捕捉战斗界面

### 阶段 3：次要界面（P1，2 天）
- [ ] 社交功能（好友、交易）
- [ ] 支付流程
- [ ] 设置页面

### 阶段 4：测试与优化（P1，2 天）
- [ ] NVDA/VoiceOver/TalkBack 手动测试
- [ ] 视障用户可用性测试（可选）
- [ ] WCAG 2.1 AA 合规验证