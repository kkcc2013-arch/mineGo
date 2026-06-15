# REQ-00233：游戏控制器与手柄输入支持系统

- **编号**：REQ-00233
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/input、frontend/game-client/src/accessibility、frontend/game-client/src/game
- **创建时间**：2026-06-15 21:05
- **依赖需求**：REQ-00017（基础无障碍支持）

## 1. 背景与问题

当前 mineGo 游戏客户端仅支持触摸屏和键盘/鼠标输入，缺少对游戏控制器（手柄）的支持。这对于以下用户群体造成障碍：

1. **运动障碍用户**：部分玩家无法精确使用触摸屏或鼠标，但能通过游戏手柄进行输入
2. **桌面玩家**：在 PC 端使用浏览器的玩家可能更习惯使用游戏手柄
3. **视力障碍用户**：游戏手柄提供更直观的触觉反馈，配合键盘导航可增强操作体验

现有 `keyboard.js` 已实现键盘导航框架，但未集成 Gamepad API 标准，无法识别和处理游戏控制器输入事件。

## 2. 目标

实现完整的游戏控制器支持，包括：

1. 自动检测连接/断开的控制器设备
2. 映射标准游戏手柄按钮到游戏内操作（移动、选择、确认、取消等）
3. 提供可视化控制器设置界面，允许用户自定义按键映射
4. 支持主流控制器布局（Xbox、PlayStation、Nintendo Switch Pro）
5. 与现有键盘导航系统无缝集成

## 3. 范围

- **包含**：
  - Gamepad API 集成与按钮事件处理
  - 控制器连接状态检测与提示
  - 可配置的按键映射系统
  - 控制器振动反馈支持（如设备支持）
  - 设置界面中的控制器配置面板

- **不包含**：
  - 自定义第三方控制器驱动
  - 蓝牙/USB 底层设备管理
  - 移动端外接手柄的特殊处理

## 4. 详细需求

### 4.1 控制器检测模块 (`gamepadManager.js`)

```javascript
// 位于 frontend/game-client/src/input/gamepadManager.js

class GamepadManager {
  constructor() {
    this.connectedGamepads = new Map();
    this.buttonMappings = this.getDefaultMappings();
    this.onButtonPress = null;
    this.onAxisMove = null;
  }
  
  // Gamepad API 标准按钮索引
  static BUTTONS = {
    A: 0,          // Xbox A / PS Cross
    B: 1,          // Xbox B / PS Circle  
    X: 2,          // Xbox X / PS Square
    Y: 3,          // Xbox Y / PS Triangle
    LB: 4,         // Left bumper
    RB: 5,         // Right bumper
    LT: 6,         // Left trigger
    RT: 7,         // Right trigger
    SELECT: 8,     // Back / Share
    START: 9,      // Start / Options
    L3: 10,        // Left stick press
    R3: 11,        // Right stick press
    DPAD_UP: 12,
    DPAD_DOWN: 13,
    DPAD_LEFT: 14,
    DPAD_RIGHT: 15
  };
  
  getDefaultMappings() {
    return {
      'confirm': [0],           // A/Cross
      'cancel': [1],            // B/Circle
      'menu': [9],              // Start/Options
      'back': [8],              // Back/Share
      'map': [3],               // Y/Triangle
      'bag': [2],               // X/Square
      'tab_left': [4],          // LB
      'tab_right': [5],         // RB
      'zoom_in': [7],           // RT
      'zoom_out': [6]           // LT
    };
  }
  
  startPolling() {
    // 使用 requestAnimationFrame 轮询游戏手柄状态
  }
  
  getControllerType(gamepad) {
    // 根据gamepad.id识别控制器类型
  }
}
```

### 4.2 轴向输入处理（摇杆）

- 左摇杆：控制地图平移、菜单导航
- 右摇杆：控制地图缩放（上下）、旋转（左右）
- 死区设置：默认 0.15，可配置范围 0.05-0.30
- 轴向事件防抖：避免摇杆抖动导致的误操作

### 4.3 与现有系统集成

```javascript
// 集成到 keyboardNavigator
import { gamepadManager } from './gamepadManager.js';

keyboardNavigator.setGamepadManager(gamepadManager);

// 控制器按钮映射到键盘导航动作
gamepadManager.on('buttonPress', (action) => {
  switch(action) {
    case 'confirm':
      keyboardNavigator.handleEnter();
      break;
    case 'cancel':
      keyboardNavigator.handleEscape();
      break;
    case 'tab_right':
      keyboardNavigator.focusNext();
      break;
    case 'tab_left':
      keyboardNavigator.focusPrevious();
      break;
  }
});
```

### 4.4 设置界面

在无障碍设置面板中添加"控制器设置"分组：

- 控制器连接状态指示器
- 按键映射自定义（点击按钮后按下控制器按钮进行绑定）
- 振动强度调节（0-100%）
- 摇杆灵敏度/死区调节
- 重置为默认设置按钮

### 4.5 振动反馈（可选）

对于支持振动功能的控制器：

- 捕捉精灵成功时轻振动
- 战斗受到伤害时中等振动
- 重要事件通知时脉冲振动

## 5. 验收标准（可测试）

- [ ] 连接 Xbox/PlayStation/Nintendo Pro 控制器后，游戏在 2 秒内显示连接提示
- [ ] 使用 D-Pad 可在菜单项之间导航，焦点顺序与 Tab 键一致
- [ ] 按下 A/Confirm 按钮可激活当前焦点元素
- [ ] 按下 B/Cancel 按钮可关闭弹窗或返回上一级
- [ ] 左摇杆可平滑移动地图视图
- [ ] 设置界面可显示当前连接的控制器名称和类型
- [ ] 用户可自定义按键映射，重启后保持设置
- [ ] 断开控制器后显示断开提示，游戏不会卡死或崩溃
- [ ] 振动功能在支持的设备上正常工作，可关闭

## 6. 工作量估算

**M（中等）**

理由：
- Gamepad API 是标准 Web API，浏览器兼容性良好
- 核心功能可复用现有键盘导航架构
- 主要工作量在 UI 设置界面和多种控制器布局适配

## 7. 优先级理由

P2 优先级：
- 属于无障碍增强，非核心功能阻塞项
- 可显著提升特定用户群体的游戏体验
- 与现有键盘导航系统协同，扩展性强
- 实现成本可控，不影响主线开发进度
