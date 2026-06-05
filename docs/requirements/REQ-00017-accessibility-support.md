# REQ-00017：游戏客户端无障碍访问支持

- **编号**：REQ-00017
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend
- **创建时间**：2026-06-05 09:45
- **依赖需求**：无

## 1. 背景与问题

mineGo 游戏客户端缺少无障碍支持，导致残障用户无法正常使用：

### 1.1 当前无障碍问题

1. **缺少键盘导航**：所有操作依赖鼠标/触摸，键盘用户无法使用
2. **无屏幕阅读器支持**：视障用户使用屏幕阅读器无法理解界面
3. **颜色对比度不足**：色盲用户难以区分游戏元素
4. **缺少 ARIA 标签**：辅助技术无法识别界面元素
5. **动画无法关闭**：动画可能引发癫痫用户不适
6. **字体大小固定**：低视力用户无法调整字体大小

### 1.2 用户群体影响

| 残障类型 | 占人口比例 | 当前可用性 |
|---------|-----------|-----------|
| 视力障碍 | 2.2% | ❌ 不可用 |
| 色盲 | 8% 男、0.5% 女 | ⚠️ 部分可用 |
| 运动障碍 | 1% | ❌ 不可用 |
| 听力障碍 | 5% | ✅ 可用（无音频依赖） |
| 认知障碍 | 3% | ⚠️ 部分可用 |

**总计约 15% 用户受影响**，即每 7 个用户就有 1 个无法正常使用。

## 2. 目标

建立完整的无障碍支持：

1. **键盘导航**：所有功能可通过键盘操作
2. **屏幕阅读器支持**：ARIA 标签完整，语义化 HTML
3. **颜色对比度**：符合 WCAG 2.1 AA 标准（对比度 ≥ 4.5:1）
4. **动画控制**：用户可关闭动画
5. **字体调整**：支持用户调整字体大小
6. **无障碍测试**：自动化无障碍测试集成

## 3. 范围

### 包含
- 键盘导航实现
- ARIA 标签添加
- 颜色对比度优化
- 动画控制设置
- 字体大小调整
- 无障碍测试工具集成

### 不包含
- 手语视频支持
- 语音控制
- 高对比度主题（可在后续需求处理）

## 4. 详细需求

### 4.1 键盘导航

#### 4.1.1 全局键盘快捷键
```javascript
// frontend/game-client/src/accessibility/keyboard.js
const KeyboardShortcuts = {
  // 导航
  'Tab': '下一个可聚焦元素',
  'Shift+Tab': '上一个可聚焦元素',
  'Arrow Keys': '地图导航',
  'Enter/Space': '激活当前元素',
  'Escape': '关闭弹窗/取消',
  
  // 游戏操作
  'C': '打开捕捉界面',
  'M': '打开地图',
  'P': '打开背包',
  'G': '打开道馆列表',
  'S': '打开设置',
  'H': '打开帮助',
  
  // 地图操作
  '+/=': '放大地图',
  '-': '缩小地图',
  'R': '重置地图视图'
};

class KeyboardNavigator {
  constructor() {
    this.focusedElement = null;
    this.focusableElements = [];
    this.init();
  }

  init() {
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.updateFocusableElements();
  }

  handleKeyDown(e) {
    // 跳过输入框
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    const handler = this.getHandler(e);
    if (handler) {
      e.preventDefault();
      handler();
    }
  }

  getHandler(e) {
    const key = this.normalizeKey(e);
    return this.handlers[key];
  }

  normalizeKey(e) {
    let key = e.key;
    if (e.shiftKey && key !== 'Shift') key = `Shift+${key}`;
    if (e.ctrlKey && key !== 'Control') key = `Ctrl+${key}`;
    return key;
  }

  // 焦点管理
  setFocus(element) {
    if (element && element.focus) {
      element.focus();
      this.focusedElement = element;
      this.announce(`已聚焦: ${element.getAttribute('aria-label') || element.textContent}`);
    }
  }

  // 焦点陷阱（模态框）
  trapFocus(container) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    container.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }
}
```

#### 4.1.2 地图键盘导航
```javascript
// frontend/game-client/src/game/MapKeyboardControl.js
class MapKeyboardControl {
  constructor(map) {
    this.map = map;
    this.step = 0.001; // 每次移动的经纬度步长
    this.init();
  }

  init() {
    document.addEventListener('keydown', (e) => {
      const center = this.map.getCenter();
      
      switch(e.key) {
        case 'ArrowUp':
          this.map.panTo([center.lat + this.step, center.lng]);
          break;
        case 'ArrowDown':
          this.map.panTo([center.lat - this.step, center.lng]);
          break;
        case 'ArrowLeft':
          this.map.panTo([center.lat, center.lng - this.step]);
          break;
        case 'ArrowRight':
          this.map.panTo([center.lat, center.lng + this.step]);
          break;
        case '+':
        case '=':
          this.map.zoomIn();
          break;
        case '-':
          this.map.zoomOut();
          break;
      }
    });
  }
}
```

### 4.2 ARIA 标签

#### 4.2.1 语义化 HTML
```html
<!-- frontend/game-client/index.html -->
<main role="main" aria-label="游戏主界面">
  <!-- 地图区域 -->
  <section id="map-container" role="application" aria-label="游戏地图">
    <div id="map" aria-live="polite"></div>
  </section>

  <!-- 精灵列表 -->
  <section id="pokemon-list" role="region" aria-label="附近精灵列表">
    <h2>附近精灵</h2>
    <ul role="list" aria-label="精灵列表">
      <li role="listitem" aria-label="皮卡丘，距离 50 米">
        <button aria-label="捕捉皮卡丘">捕捉</button>
      </li>
    </ul>
  </section>

  <!-- 背包 -->
  <section id="inventory" role="region" aria-label="我的背包">
    <h2>背包</h2>
    <div role="tablist" aria-label="背包分类">
      <button role="tab" aria-selected="true" aria-controls="pokemon-tab">精灵</button>
      <button role="tab" aria-selected="false" aria-controls="items-tab">道具</button>
    </div>
    <div id="pokemon-tab" role="tabpanel" aria-label="精灵列表">
      <!-- 精灵卡片 -->
    </div>
  </section>
</main>

<!-- 捕捉弹窗 -->
<div id="catch-modal" role="dialog" aria-modal="true" aria-labelledby="catch-title">
  <h2 id="catch-title">捕捉精灵</h2>
  <p aria-live="assertive">正在投掷精灵球...</p>
  <button aria-label="取消捕捉">取消</button>
</div>
```

#### 4.2.2 动态内容通知
```javascript
// frontend/game-client/src/accessibility/announcer.js
class A11yAnnouncer {
  constructor() {
    // 创建实时区域
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.className = 'sr-only'; // 屏幕阅读器可见，视觉隐藏
    document.body.appendChild(this.liveRegion);
  }

  announce(message, priority = 'polite') {
    this.liveRegion.setAttribute('aria-live', priority);
    this.liveRegion.textContent = '';
    // 延迟设置，确保屏幕阅读器捕获
    setTimeout(() => {
      this.liveRegion.textContent = message;
    }, 100);
  }
}

// 使用示例
const announcer = new A11yAnnouncer();

// 捕捉成功
announcer.announce('捕捉成功！你获得了一只皮卡丘');

// 精灵出现
announcer.announce('附近出现了一只杰尼龟，距离 30 米');
```

### 4.3 颜色对比度

#### 4.3.1 对比度优化
```css
/* frontend/game-client/styles/a11y.css */

/* 确保对比度 ≥ 4.5:1 (WCAG AA) */
:root {
  /* 主要文本 */
  --text-primary: #1a1a1a;      /* 对比度 16:1 */
  --text-secondary: #4a4a4a;    /* 对比度 7:1 */
  
  /* 背景 */
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  
  /* 强调色 */
  --accent-primary: #0052cc;    /* 对比度 7:1 */
  --accent-secondary: #0066cc;  /* 对比度 6:1 */
  
  /* 状态色 */
  --success: #0a6000;           /* 对比度 5:1 */
  --warning: #b55800;           /* 对比度 4.5:1 */
  --error: #c41e00;             /* 对比度 5:1 */
  
  /* 精灵类型色（确保对比度） */
  --type-fire: #c41e00;
  --type-water: #0052cc;
  --type-grass: #0a6000;
  --type-electric: #b55800;
}

/* 焦点指示器 */
*:focus {
  outline: 3px solid var(--accent-primary);
  outline-offset: 2px;
}

/* 跳过链接 */
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: var(--accent-primary);
  color: white;
  padding: 8px;
  z-index: 100;
}

.skip-link:focus {
  top: 0;
}

/* 屏幕阅读器专用样式 */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

#### 4.3.2 色盲友好设计
```javascript
// frontend/game-client/src/accessibility/colorBlind.js
const ColorBlindFriendly = {
  // 使用图标 + 颜色双重编码
  pokemonTypes: {
    fire: { color: '#c41e00', icon: '🔥', pattern: 'stripes' },
    water: { color: '#0052cc', icon: '💧', pattern: 'dots' },
    grass: { color: '#0a6000', icon: '🌿', pattern: 'crosses' },
    electric: { color: '#b55800', icon: '⚡', pattern: 'waves' }
  },

  // 渲染精灵类型标签
  renderTypeTag(type) {
    const config = this.pokemonTypes[type];
    return `
      <span 
        class="type-tag type-${type}" 
        style="background: ${config.color}"
        aria-label="${type} type"
      >
        <span aria-hidden="true">${config.icon}</span>
        ${type}
      </span>
    `;
  }
};
```

### 4.4 动画控制

#### 4.4.1 动画设置
```javascript
// frontend/game-client/src/settings/accessibility.js
class AnimationSettings {
  constructor() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.userPreference = localStorage.getItem('reduced-motion') === 'true';
  }

  shouldAnimate() {
    return !this.reducedMotion && !this.userPreference;
  }

  enableReducedMotion() {
    this.userPreference = true;
    localStorage.setItem('reduced-motion', 'true');
    document.body.classList.add('reduced-motion');
  }

  disableReducedMotion() {
    this.userPreference = false;
    localStorage.setItem('reduced-motion', 'false');
    document.body.classList.remove('reduced-motion');
  }
}

// CSS
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

body.reduced-motion *,
body.reduced-motion *::before,
body.reduced-motion *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
}
```

### 4.5 字体大小调整

#### 4.5.1 字体缩放
```javascript
// frontend/game-client/src/settings/fontSize.js
class FontSizeManager {
  constructor() {
    this.sizes = ['small', 'medium', 'large', 'x-large'];
    this.currentSize = localStorage.getItem('font-size') || 'medium';
    this.apply();
  }

  setSize(size) {
    if (this.sizes.includes(size)) {
      this.currentSize = size;
      localStorage.setItem('font-size', size);
      this.apply();
    }
  }

  apply() {
    const root = document.documentElement;
    const sizeMap = {
      'small': '14px',
      'medium': '16px',
      'large': '18px',
      'x-large': '20px'
    };
    
    root.style.fontSize = sizeMap[this.currentSize];
  }

  increase() {
    const index = this.sizes.indexOf(this.currentSize);
    if (index < this.sizes.length - 1) {
      this.setSize(this.sizes[index + 1]);
    }
  }

  decrease() {
    const index = this.sizes.indexOf(this.currentSize);
    if (index > 0) {
      this.setSize(this.sizes[index - 1]);
    }
  }
}
```

### 4.6 无障碍测试

#### 4.6.1 自动化测试
```javascript
// frontend/game-client/tests/a11y.test.js
const { axe, toHaveNoViolations } = require('jest-axe');

expect.extend(toHaveNoViolations);

describe('Accessibility', () => {
  test('首页无无障碍违规', async () => {
    const { container } = render(<HomePage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('捕捉弹窗无无障碍违规', async () => {
    const { container } = render(<CatchModal pokemon={mockPokemon} />);
    const results = await axe(container, {
      rules: {
        'aria-dialog-name': { enabled: true }
      }
    });
    expect(results).toHaveNoViolations();
  });

  test('键盘导航完整', () => {
    const { getByRole } = render(<GameMap />);
    
    // Tab 导航
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(getByRole('button', { name: /捕捉/i })).toHaveFocus();
    
    // Enter 激活
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(getByRole('dialog')).toBeVisible();
  });
});
```

#### 4.6.2 CI 集成
```yaml
# .github/workflows/a11y-test.yml
name: Accessibility Tests

on: [push, pull_request]

jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: npm run test:a11y
      - name: Upload report
        uses: actions/upload-artifact@v3
        with:
          name: a11y-report
          path: a11y-report.html
```

## 5. 验收标准（可测试）

- [ ] 所有功能可通过键盘操作（Tab、Enter、Escape、方向键）
- [ ] 键盘快捷键正常工作（C、M、P、G、S、H）
- [ ] 焦点指示器清晰可见（3px 蓝色轮廓）
- [ ] 所有交互元素有 ARIA 标签
- [ ] 屏幕阅读器可正确读取界面（NVDA、JAWS 测试通过）
- [ ] 颜色对比度 ≥ 4.5:1（WCAG AA）
- [ ] 色盲友好：图标 + 颜色双重编码
- [ ] 动画可通过设置关闭
- [ ] 尊重系统 `prefers-reduced-motion` 设置
- [ ] 字体大小可调整（4 档：小、中、大、特大）
- [ ] 自动化无障碍测试通过（无 axe-core 违规）
- [ ] 手动测试通过（键盘导航、屏幕阅读器）
- [ ] 无障碍声明页面可访问

## 6. 工作量估算

**M (Medium)**

- 键盘导航实现：1.5 天
- ARIA 标签添加：1 天
- 颜色对比度优化：0.5 天
- 动画和字体设置：0.5 天
- 无障碍测试：1 天

**总计：4.5 天**

## 7. 优先级理由

**P2** 理由：

1. **用户包容性**：15% 用户受影响，无障碍支持让更多人能使用
2. **法律要求**：许多国家要求公共服务无障碍（如美国 ADA）
3. **道德责任**：残障用户同样有权享受游戏乐趣
4. **SEO 优化**：语义化 HTML 对 SEO 也有帮助
5. **代码质量**：无障碍实践通常提升整体代码质量

虽然不影响核心游戏功能，但这是负责任产品的基本要求。
