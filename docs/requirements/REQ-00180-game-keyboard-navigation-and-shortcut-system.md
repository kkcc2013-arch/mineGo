# REQ-00180：游戏键盘导航与快捷键系统

- **编号**：REQ-00180
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：implemented
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、frontend/game-client/src/input、frontend/game-client/src/components
- **创建时间**：2026-06-14 03:00
- **依赖需求**：REQ-00017

## 1. 背景与问题

当前 mineGo 游戏客户端主要依赖触摸/鼠标交互，缺乏完整的键盘导航支持。这导致：

1. **运动障碍用户受阻**：无法使用键盘、开关设备等辅助技术进行游戏操作
2. **WCAG 2.1 不合规**：未达到"所有功能可通过键盘访问"(2.1.1) 标准
3. **效率低下**：熟练用户无法通过快捷键快速访问常用功能（背包、图鉴、设置）
4. **焦点管理缺失**：Tab 键导航无视觉反馈，用户不知道当前焦点位置

经代码审查，`game-client/index.html` 缺少：
- 全局键盘事件监听器
- Tab 索引（tabindex）属性
- 焦点样式（focus-visible）
- 快捷键映射配置

## 2. 目标

实现完整的键盘导航与快捷键系统，使：

1. **全键盘可访问**：100% 游戏功能可通过键盘完成（符合 WCAG 2.1 Level AA）
2. **快捷键覆盖核心操作**：至少 15 个快捷键覆盖常用功能
3. **焦点可视**：所有交互元素有明显的焦点指示器（focus-visible）
4. **可自定义**：允许用户重新映射快捷键

## 3. 范围

### 包含
- 全局键盘事件管理器（KeyboardManager.js）
- 焦点陷阱（focus trap）实现，用于模态框
- 快捷键配置系统（可持久化到 localStorage）
- 视觉焦点指示器样式（CSS focus-visible）
- 快捷键帮助面板（按 ? 键显示）
- 地图 WASD 导航支持
- 菜单 Tab/Arrow 键导航

### 不包含
- 游戏手柄支持（另案处理）
- 语音控制（需要语音识别 API 集成）
- 移动端虚拟键盘优化

## 4. 详细需求

### 4.1 键盘事件管理器

```javascript
// frontend/game-client/src/input/KeyboardManager.js
class KeyboardManager {
  constructor() {
    this.shortcuts = new Map(); // 快捷键映射
    this.enabled = true;
    this.init();
  }

  init() {
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
    document.addEventListener('keyup', this.handleKeyUp.bind(this));
  }

  register(key, handler, options = {}) {
    // 注册快捷键
    // key: 'Ctrl+S' | 'Shift+P' | 'Escape' | '?'
    // handler: 回调函数
    // options: { preventDefault: true, allowInInput: false }
  }

  unregister(key) {
    this.shortcuts.delete(key);
  }

  handleKeyDown(event) {
    // 构建 keyCombo 字符串：'Ctrl+Shift+S'
    const keyCombo = this.buildKeyCombo(event);
    
    if (this.shortcuts.has(keyCombo)) {
      const { handler, options } = this.shortcuts.get(keyCombo);
      
      // 忽略输入框内的快捷键（除非 allowInInput: true）
      if (this.isInputFocused() && !options.allowInInput) return;
      
      if (options.preventDefault !== false) {
        event.preventDefault();
      }
      handler(event);
    }
  }
}
```

### 4.2 默认快捷键映射

| 快捷键 | 功能 | 上下文 |
|--------|------|--------|
| `Escape` | 关闭模态框/返回上一级 | 全局 |
| `?` | 显示快捷键帮助面板 | 全局 |
| `Tab` | 焦点移至下一元素 | 全局 |
| `Shift+Tab` | 焦点移至上一元素 | 全局 |
| `W/A/S/D` | 地图移动（上/左/下/右） | 地图页 |
| `B` | 打开背包 | 全局 |
| `P` | 打开图鉴 | 全局 |
| `M` | 打开地图 | 全局 |
| `F` | 打开好友列表 | 全局 |
| `G` | 打开道馆列表 | 全局 |
| `Enter` | 确认/选择 | 全局 |
| `Space` | 捕捉投球 | 捕捉场景 |
| `1-9` | 选择精灵槽位 | 精灵列表 |
| `R` | 刷新附近精灵 | 地图页 |

### 4.3 焦点管理

```javascript
// frontend/game-client/src/accessibility/FocusManager.js
class FocusManager {
  constructor() {
    this.focusStack = []; // 焦点历史栈
    this.trapActive = false;
  }

  // 保存当前焦点（打开模态框时）
  saveFocus() {
    this.focusStack.push(document.activeElement);
  }

  // 恢复上一个焦点（关闭模态框时）
  restoreFocus() {
    const previous = this.focusStack.pop();
    if (previous) previous.focus();
  }

  // 焦点陷阱（模态框内循环）
  trapFocus(container) {
    const focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    });

    firstElement?.focus();
  }
}
```

### 4.4 焦点视觉样式

```css
/* frontend/game-client/styles/accessibility.css */

/* 全局焦点指示器 */
*:focus-visible {
  outline: 3px solid #4A90E2;
  outline-offset: 2px;
  border-radius: 4px;
}

/* 按钮焦点 */
button:focus-visible {
  box-shadow: 0 0 0 3px rgba(74, 144, 226, 0.5);
}

/* 精灵卡片焦点 */
.pokemon-card:focus-visible {
  outline: 4px solid #FFD700;
  transform: scale(1.02);
}

/* 地图标记焦点 */
.map-marker:focus-visible {
  filter: brightness(1.3);
  outline: 3px dashed #00FF00;
}
```

### 4.5 快捷键帮助面板

```html
<!-- frontend/game-client/src/components/ShortcutHelp.html -->
<div id="shortcut-help" class="modal hidden" role="dialog" aria-labelledby="shortcut-title">
  <div class="modal-content">
    <h2 id="shortcut-title">键盘快捷键</h2>
    <table class="shortcut-table">
      <thead>
        <tr>
          <th>快捷键</th>
          <th>功能</th>
        </tr>
      </thead>
      <tbody>
        <tr><td><kbd>?</kbd></td><td>显示此帮助</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>关闭面板</td></tr>
        <tr><td><kbd>B</kbd></td><td>打开背包</td></tr>
        <tr><td><kbd>P</kbd></td><td>打开图鉴</td></tr>
        <tr><td><kbd>M</kbd></td><td>打开地图</td></tr>
        <!-- 更多快捷键... -->
      </tbody>
    </table>
    <button class="btn-close" aria-label="关闭">关闭</button>
  </div>
</div>
```

### 4.6 快捷键自定义界面

```javascript
// frontend/game-client/src/components/ShortcutCustomizer.js
class ShortcutCustomizer {
  constructor(keyboardManager) {
    this.km = keyboardManager;
    this.customBindings = this.loadFromStorage();
  }

  // 从 localStorage 加载自定义绑定
  loadFromStorage() {
    const stored = localStorage.getItem('minego_shortcuts');
    return stored ? JSON.parse(stored) : {};
  }

  // 保存到 localStorage
  saveToStorage() {
    localStorage.setItem('minego_shortcuts', JSON.stringify(this.customBindings));
  }

  // 重新映射快捷键
  remap(action, newKey) {
    const oldBinding = this.km.shortcuts.get(this.customBindings[action]);
    if (oldBinding) {
      this.km.unregister(this.customBindings[action]);
      this.km.register(newKey, oldBinding.handler, oldBinding.options);
      this.customBindings[action] = newKey;
      this.saveToStorage();
    }
  }
}
```

### 4.7 Tab 索引规范

为所有交互元素添加 `tabindex`：

```html
<!-- 导航按钮 -->
<nav>
  <button tabindex="0" data-action="map">地图</button>
  <button tabindex="0" data-action="bag">背包</button>
  <button tabindex="0" data-action="pokedex">图鉴</button>
</nav>

<!-- 精灵列表 -->
<div class="pokemon-list" role="list">
  <div class="pokemon-card" tabindex="0" role="listitem" aria-label="皮卡丘 CP 1200">
    <!-- 精灵内容 -->
  </div>
</div>

<!-- 跳过链接（页面顶部） -->
<a href="#main-content" class="skip-link">跳转到主要内容</a>
```

## 5. 验收标准

- [ ] **WCAG 2.1.1 合规**：所有游戏功能可通过键盘访问，无键盘陷阱
- [ ] **焦点可视**：所有交互元素有明显的 focus-visible 样式（3px+ outline）
- [ ] **快捷键功能**：至少 15 个快捷键可正常工作
- [ ] **快捷键帮助面板**：按 `?` 键显示所有快捷键列表
- [ ] **焦点恢复**：关闭模态框后焦点返回之前元素
- [ ] **快捷键自定义**：用户可在设置中重新映射快捷键
- [ ] **地图导航**：WASD 键可控制地图平移
- [ ] **菜单导航**：Tab/Arrow 键可在菜单项间导航
- [ ] **屏幕阅读器兼容**：快捷键操作触发正确的 ARIA 通知
- [ ] **无冲突**：快捷键不与浏览器/系统快捷键冲突（允许 preventDefault 覆盖）

## 6. 工作量估算

**L (Large)** - 涉及多个模块：
- 键盘事件管理器（2 天）
- 焦点管理器（1 天）
- CSS 焦点样式（0.5 天）
- 快捷键帮助面板（0.5 天）
- 快捷键自定义界面（1 天）
- Tab 索引添加（1 天）
- 测试与调试（1 天）
- **总计：约 7 天**

## 7. 优先级理由

P2 理由：
1. **合规需求**：WCAG 2.1 是无障碍标准，不合规可能影响市场准入
2. **用户群体**：约 15% 人口有某种形式的残疾，键盘导航是核心需求
3. **间接收益**：快捷键也提升普通用户的操作效率
4. **依赖关系**：基于 REQ-00017 基础无障碍支持扩展

## 实现记录（2026-09-25）

> 按 2026-09-25 起的验证方式：只写代码与测试，未启动服务做验证；✅ = 代码已实现、待验证。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| **WCAG 2.1.1 合规**：所有游戏功能可通过键盘访问，无键盘陷阱 | ✅ | 所有操作可键盘完成（带 onclick 的 div 补 Enter/Space，精灵球/底部导航方向键漫游），模态框外无陷阱 |
| **焦点可视**：所有交互元素有明显的 focus-visible 样式（3px+ outline） | ✅ | `accessibility/a11y.css` `:focus-visible` 3px 轮廓 + 2px 偏移（手柄模式下 `:focus` 同样显示） |
| **快捷键功能**：至少 15 个快捷键可正常工作 | ✅ | `shortcuts.DEFAULT_BINDINGS` 26 个：? , M P R J K W A S D L V 1 2 3 T Esc I Alt+S Alt+H - = Ctrl+Shift+M Alt+V Alt+R，另 Alt+1…9 执行宏 |
| **快捷键帮助面板**：按 `?` 键显示所有快捷键列表 | ✅ | `?` 打开快捷键帮助对话框（表格，含 Tab/Enter/方向键/Esc Esc 说明） |
| **焦点恢复**：关闭模态框后焦点返回之前元素 | ✅ | `accessibility/dialog.js` 关闭时焦点回到触发元素（设置、帮助、语言弹窗均适用） |
| **快捷键自定义**：用户可在设置中重新映射快捷键 | ✅ | 设置 → 键盘：点"修改"后按新键录制，重复/浏览器保留键被拒绝并提示，持久化 `keyboard.bindings` |
| **地图导航**：WASD 键可控制地图平移 | ✅ | WASD 平移地图区域。说明：当前客户端"地图"是列表视图，平移即滚动；另有 J/K 在精灵间移动焦点 |
| **菜单导航**：Tab/Arrow 键可在菜单项间导航 | ✅ | Tab 顺序导航；方向键在精灵球 radiogroup 与底部导航间移动（RTL 下左右反向） |
| **屏幕阅读器兼容**：快捷键操作触发正确的 ARIA 通知 | ✅ | 快捷键执行后 aria-live 播报动作名称 |
| **无冲突**：快捷键不与浏览器/系统快捷键冲突（允许 preventDefault 覆盖） | ✅ | RESERVED（Ctrl+W/T/N/L/R/F…、F5、F11、F12、Alt+F4、Tab 等）禁止绑定；输入框内不触发单键快捷键 |

- 入口：`frontend/game-client/index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility(ctx)`；设置入口「我的 → 无障碍设置」（`window.showAccessibilitySettings`，或按 `,`），模块在 `src/accessibility/`
- 迁移：`database/migrations/20260925_010000__user_preferences.sql`（`user_preferences`：user_id UUID → users(id) ON DELETE CASCADE、namespace、prefs JSONB，主键 (user_id, namespace)，全部 IF NOT EXISTS）；偏好云端同步：user-service `GET/PUT/DELETE /users/me/preferences/:namespace`（`src/routes/preferences.js` + `src/services/userPreferences.js` 校验），经网关 `/v1/users/me/preferences/a11y`（网关已有 `/v1/users` 鉴权代理，未改网关）
- 测试：前端纯逻辑单测 `node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs`（宿主机已运行 63/63 通过）；后端单测 `cd backend && node --test tests/unit/a11y-backend.test.js`（宿主机已运行 9/9，已加入 `npm run test:unit`）；服务冒烟 `BASE_URL=<网关> node scripts/smoke-a11y.js`；浏览器 e2e `BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<playwright-core+axe-core> node scripts/e2e-a11y.js`；性能 `scripts/bench-a11y-client.js`。验证方式调整前曾在 CI 栈跑过一次：smoke-a11y 17/17、e2e 60/60（之后新增的用例未运行，**待验证**）
- 待验证：在真实键盘 + 屏幕阅读器（NVDA 浏览模式下单键快捷键会被读屏拦截，需切换焦点模式）中试用；硬件相关（振动/手柄/Web Speech）以模拟对象测试，⚠️ 真机未验证
- 使用与接入文档：`docs/accessibility/a11y-guide.md`
