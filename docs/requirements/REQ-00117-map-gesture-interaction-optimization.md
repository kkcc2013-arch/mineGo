# REQ-00117: 地图手势交互优化与缩放流畅度提升

- **编号**：REQ-00117
- **类别**：前端体验
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/game、frontend/game-client/index.html
- **创建时间**：2026-06-11 17:05
- **依赖需求**：无

## 1. 背景与问题

当前游戏客户端地图使用简单的 CSS scroll 实现，存在以下用户体验问题：

1. **缩放体验差**：双指缩放响应延迟，缺乏平滑过渡动画，在低端设备上卡顿明显
2. **手势冲突**：双击缩放与捕捉精灵的点击事件冲突，容易误触发
3. **边界处理不足**：地图拖动到边界时没有弹性效果，用户感觉"僵硬"
4. **缺少触觉反馈**：Android 设备上没有振动反馈，交互缺乏"质感"
5. **移动端适配问题**：iOS Safari 下双指缩放会触发页面缩放，破坏游戏体验

这些问题导致移动端用户在地图浏览和精灵捕捉时的操作体验不流畅，特别是在低端 Android 设备上，用户反馈"地图很难操作"。

## 2. 目标

优化地图手势交互体验，实现：
- 流畅的双指缩放（60fps 稳定）
- 智能手势识别与冲突避免
- 自然的边界弹性效果
- 触觉反馈支持
- 完善的移动端兼容性

**预期收益**：地图操作流畅度提升，用户操作错误率降低 50%+（可通过埋点统计手势取消率验证）

## 3. 范围

### 包含
- 自定义手势管理器（GestureManager.js）
- 双指缩放平滑动画（requestAnimationFrame + transform）
- 手势冲突解决策略（优先级队列）
- 地图边界弹性效果（spring 动画）
- Android Vibration API 集成
- iOS 双指缩放阻止（touch-action CSS）
- 地图缩放性能监控指标

### 不包含
- 3D 地图视角（属于 REQ-00027 扩展）
- 地图路径规划（未来需求）
- 离线地图缓存（REQ-00009 已覆盖）

## 4. 详细需求

### 4.1 GestureManager 核心实现

```javascript
// frontend/game-client/src/game/GestureManager.js
class GestureManager {
  constructor(element) {
    this.element = element;
    this.state = {
      scale: 1,
      translateX: 0,
      translateY: 0,
      velocity: { x: 0, y: 0 }
    };
    this.gestureQueue = [];
    this.priorityMap = {
      'catch': 100,      // 捕捉优先级最高
      'zoom': 50,
      'pan': 30,
      'tap': 10
    };
  }

  // 手势识别：区分 tap/double-tap/pan/pinch
  recognizeGesture(touches) { /* ... */ }

  // 冲突解决：同一时间只响应最高优先级手势
  resolveConflict(gestures) { /* ... */ }

  // 平滑缩放：使用 requestAnimationFrame + transform
  smoothZoom(targetScale, duration = 200) { /* ... */ }

  // 边界弹性：spring 动画
  boundSpring(current, min, max, damping = 0.7) { /* ... */ }

  // 触觉反馈
  vibrate(pattern = [10]) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }
}
```

### 4.2 关键性能指标

- 缩放帧率：≥ 55fps（低端设备） / ≥ 60fps（中高端设备）
- 手势响应延迟：< 50ms
- 内存占用增加：< 2MB

### 4.3 API 设计

```javascript
// 初始化手势管理器
const gestureMgr = new GestureManager(mapElement, {
  minScale: 0.5,
  maxScale: 3.0,
  bounds: { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 },
  enableVibration: true,
  enableInertia: true
});

// 事件监听
gestureMgr.on('gesture:zoom', (e) => { /* ... */ });
gestureMgr.on('gesture:pan', (e) => { /* ... */ });
gestureMgr.on('gesture:catch', (e) => { /* 精灵捕捉 */ });
```

### 4.4 iOS 兼容性

```css
/* index.html 内联样式 */
.map-container {
  touch-action: pan-x pan-y;
  -webkit-overflow-scrolling: touch;
  /* 阻止 iOS Safari 双指缩放触发页面缩放 */
}
```

### 4.5 性能监控

新增 3 个 Prometheus 指标：
- `game_map_gesture_fps`：地图手势帧率
- `game_map_gesture_latency_ms`：手势响应延迟
- `game_map_gesture_conflicts_total`：手势冲突次数

## 5. 验收标准（可测试）

- [ ] `node --check frontend/game-client/src/game/GestureManager.js` 通过
- [ ] 双指缩放在 Chrome DevTools 性能面板中达到 55fps+
- [ ] 快速连续点击精灵图标时，捕捉事件触发率 100%（无手势冲突）
- [ ] 地图拖动到边界时有弹性回弹效果
- [ ] Android 设备上双击有振动反馈
- [ ] iOS Safari 下双指缩放不触发页面缩放
- [ ] `curl -sf http://localhost:3000/api/v1/map/gesture-metrics` 返回 Prometheus 指标
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M（中等）**

- GestureManager 核心实现：4-6 小时
- 手势冲突解决：2-3 小时
- 边界弹性动画：2 小时
- 触觉反馈集成：1 小时
- 单元测试：3-4 小时
- 文档与验收：1-2 小时

**总计**：13-18 小时

## 7. 优先级理由

P2（中等优先级）：
- 前端体验优化，不影响核心业务流程
- 用户反馈有改进需求，但不是阻塞问题
- 相比 P0/P1 的安全和稳定性问题，此项可延后
- 但完成后可显著提升用户体验和留存率
