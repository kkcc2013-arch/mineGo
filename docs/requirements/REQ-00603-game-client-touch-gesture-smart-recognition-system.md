# REQ-00603: 游戏客户端触摸手势智能识别与优化系统

- **编号**：REQ-00603
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client, touch-input-handler, gesture-recognizer
- **创建时间**：2026-07-20 04:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 游戏客户端在触摸手势处理方面存在以下问题：

1. **手势识别单一**：仅支持简单的点击和滑动，无法识别复杂手势（如双击、长按、捏合缩放、多指旋转）
2. **误触问题**：快速滑动时容易误判为点击，投球时滑动方向不准确
3. **响应延迟**：触摸事件处理未优化，在低端设备上存在明显延迟
4. **缺乏手感反馈**：成功识别手势后缺乏触觉反馈，用户体验不佳
5. **无手势教学**：新玩家不了解可用手势，缺乏引导

在 AR 捕捉场景中，精准的投球手势直接影响捕捉成功率，当前实现较为粗糙。

## 2. 目标

构建完整的触摸手势智能识别系统，实现：
- 支持 10+ 种手势类型（点击、双击、长按、滑动、捏合、旋转、甩动等）
- 手势识别准确率达到 95% 以上
- 触摸响应延迟控制在 16ms 以内（60fps）
- 集成触觉反馈（Haptic Feedback）
- 提供手势引导与练习模式

## 3. 范围

**包含**：
- 手势识别引擎（Gesture Recognizer）
- 触摸事件优化处理（Passive Event Listeners, Touch Action）
- 手势冲突解决策略
- 触觉反馈集成
- 手势教学 UI 组件
- 手势统计与分析（用于后续 ML 优化）

**不包含**：
- 语音控制（REQ-00536 已覆盖）
- 键盘快捷键（REQ-00180 已覆盖）
- 手柄支持（REQ-00233 已覆盖）

## 4. 详细需求

### 4.1 手势识别引擎

**文件**：`frontend/game-client/src/input/GestureRecognizer.js`

```javascript
/**
 * 手势类型定义
 */
const GestureType = {
  TAP: 'tap',           // 单击
  DOUBLE_TAP: 'double_tap',  // 双击
  LONG_PRESS: 'long_press',  // 长按（>500ms）
  SWIPE: 'swipe',       // 滑动（有方向）
  PINCH: 'pinch',       // 双指捏合缩放
  ROTATE: 'rotate',     // 双指旋转
  FLING: 'fling',       // 快速甩动（投球手势）
  DRAG: 'drag',         // 拖拽
  MULTI_TAP: 'multi_tap', // 多指点击
  EDGE_SWIPE: 'edge_swipe' // 边缘滑动
};

/**
 * 手势识别配置
 */
const GestureConfig = {
  TAP_MAX_DURATION: 200,      // 点击最大持续时间
  DOUBLE_TAP_INTERVAL: 300,   // 双击间隔
  LONG_PRESS_DURATION: 500,   // 长按判定时间
  SWIPE_MIN_DISTANCE: 30,     // 滑动最小距离
  SWIPE_MAX_DURATION: 500,    // 滑动最大时间
  FLING_MIN_VELOCITY: 1000,   // 甩动最小速度
  PINCH_MIN_SCALE: 0.1,       // 捏合最小缩放
  ROTATE_MIN_ANGLE: 15        // 旋转最小角度
};
```

**要求**：
- 基于时间、位置、速度、方向多维度判定
- 支持手势优先级配置（如投球场景优先识别甩动）
- 手势冲突时根据场景自动选择最合适的手势

### 4.2 投球手势专项优化

**文件**：`frontend/game-client/src/input/BallThrowRecognizer.js`

```javascript
/**
 * 投球手势识别器
 * - 分析甩动轨迹
 * - 计算投球力度和方向
 * - 检测曲线球（特殊手势）
 */
class BallThrowRecognizer {
  constructor() {
    this.trajectoryPoints = [];
    this.maxPoints = 60; // 保留最近 60 个点
  }

  /**
   * 分析投球手势
   * @param {Array} points - 轨迹点 [{x, y, timestamp}]
   * @returns {Object} 投球参数 { power, direction, curve, confidence }
   */
  analyze(points) {
    const velocity = this.calculateVelocity(points);
    const direction = this.calculateDirection(points);
    const curve = this.detectCurve(points);
    
    return {
      power: this.calculatePower(velocity),
      direction,
      curve,
      confidence: this.calculateConfidence(points)
    };
  }
}
```

**要求**：
- 投球轨迹平滑处理（去除抖动）
- 支持曲线球手势检测（投球时侧向滑动）
- 实时预览投球轨迹

### 4.3 触觉反馈集成

**文件**：`frontend/game-client/src/input/HapticFeedback.js`

```javascript
/**
 * 触觉反馈管理器
 */
class HapticFeedback {
  // 反馈类型
  static FEEDBACK_TYPES = {
    LIGHT: 'light',
    MEDIUM: 'medium',
    HEAVY: 'heavy',
    SUCCESS: 'success',
    WARNING: 'warning',
    ERROR: 'error'
  };

  /**
   * 触发触觉反馈
   * @param {string} type - 反馈类型
   */
  static trigger(type) {
    if ('vibrate' in navigator) {
      const pattern = this.getPattern(type);
      navigator.vibrate(pattern);
    }
    
    // iOS Haptic Feedback
    if (window.Haptic && window.Haptic.selection) {
      window.Haptic.selection();
    }
  }

  static getPattern(type) {
    const patterns = {
      light: [10],
      medium: [20],
      heavy: [30],
      success: [10, 50, 10],
      warning: [30, 50, 30],
      error: [50, 100, 50]
    };
    return patterns[type] || [10];
  }
}
```

**要求**：
- Android 使用 Vibration API
- iOS 使用 Haptic Feedback（需要 WKWebView 支持）
- 手势识别成功时自动触发反馈

### 4.4 手势教学系统

**文件**：`frontend/game-client/src/ui/GestureTutorial.js`

```javascript
/**
 * 手势教学内容
 */
const GESTURE_TUTORIALS = [
  {
    id: 'throw',
    name: '投球',
    description: '快速向上滑动投出精灵球',
    icon: 'throw-icon.png',
    demo: 'tutorials/throw-demo.gif',
    practice: true
  },
  {
    id: 'curve-ball',
    name: '曲线球',
    description: '投球时向左或向右滑动',
    icon: 'curve-icon.png',
    demo: 'tutorials/curve-demo.gif',
    practice: true
  },
  {
    id: 'map-zoom',
    name: '地图缩放',
    description: '双指捏合放大或缩小地图',
    icon: 'zoom-icon.png',
    demo: 'tutorials/zoom-demo.gif',
    practice: true
  }
];
```

**要求**：
- 首次进入游戏时显示手势教学
- 支持练习模式（引导玩家正确手势）
- 教学完成后给予奖励

### 4.5 手势统计分析

**文件**：`frontend/game-client/src/input/GestureAnalytics.js`

```javascript
/**
 * 手势统计收集器
 */
class GestureAnalytics {
  constructor() {
    this.stats = {
      totalGestures: 0,
      gesturesByType: {},
      avgResponseTime: 0,
      recognitionRate: 0,
      errors: []
    };
  }

  /**
   * 记录手势识别结果
   * @param {string} type - 手势类型
   * @param {number} responseTime - 响应时间
   * @param {boolean} success - 是否成功
   */
  record(type, responseTime, success) {
    this.stats.totalGestures++;
    this.stats.gesturesByType[type] = (this.stats.gesturesByType[type] || 0) + 1;
    
    // 更新平均响应时间
    const prevAvg = this.stats.avgResponseTime;
    this.stats.avgResponseTime = 
      (prevAvg * (this.stats.totalGestures - 1) + responseTime) / this.stats.totalGestures;
    
    if (!success) {
      this.stats.errors.push({
        type,
        timestamp: Date.now()
      });
    }
  }
}
```

**要求**：
- 收集手势识别统计数据
- 上报至后端用于后续 ML 优化
- 支持 A/B 测试不同的手势阈值

## 5. 验收标准

- [ ] GestureRecognizer 支持 10 种以上手势类型识别
- [ ] 手势识别准确率在测试集上达到 95% 以上
- [ ] 触摸响应延迟低于 16ms（使用 Performance API 测量）
- [ ] 投球手势识别支持力度、方向、曲线球检测
- [ ] Android 和 iOS 设备上触觉反馈正常工作
- [ ] 手势教学系统包含至少 5 种常用手势教程
- [ ] 手势统计数据正确上报至后端
- [ ] 单元测试覆盖核心手势识别逻辑

## 6. 工作量估算

**L (Large)**

- 理由：涉及手势识别引擎开发、投球专项优化、触觉反馈集成、教学 UI、统计分析等多个模块，预计需要 5-7 个工作日。

## 7. 优先级理由

**P1（高优先级）**

- 触摸手势是 AR 游戏的核心交互方式，直接影响投球捕捉体验
- 当前手势识别粗糙，误触问题影响游戏体验和留存率
- 属于"前端体验"类别，是提升游戏品质的关键需求
- 与核心玩法（捕捉精灵）紧密相关，应优先实现

---

## 8. 技术依赖

- **Touch Events API**：`touchstart`, `touchmove`, `touchend`
- **Pointer Events API**：统一触摸和鼠标事件
- **Vibration API**：`navigator.vibrate()`
- **Performance API**：`performance.now()` 用于延迟测量

## 9. 后续需求

- REQ-00604：基于 ML 的手势预测与预加载
- REQ-00605：自定义手势配置系统
- REQ-00606：手势操作回放与分析系统