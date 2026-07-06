# REQ-00433: 游戏界面转场动画与微交互体验优化系统

- **编号**: REQ-00433
- **类别**: 前端体验
- **优先级**: P2
- **状态**: new
- **涉及服务/模块**: game-client/src/transitions, game-client/src/components, game-client/styles
- **创建时间**: 2026-07-06 05:15
- **依赖需求**: REQ-00009 (PWA离线支持), REQ-00117 (地图手势交互优化)

## 1. 背景与问题

当前游戏客户端在不同界面切换时缺乏统一的转场动画系统：

1. **生硬的界面切换**：从地图到捕捉、从捕捉到背包等场景切换时，界面瞬间替换，缺乏过渡效果，用户体验不够流畅
2. **缺乏微交互反馈**：按钮点击、列表滚动、卡片展开等操作缺乏细腻的动画反馈，用户难以感知操作已被识别
3. **动画性能不一致**：部分动画实现分散在各个组件中，缺乏统一管理，低端设备可能出现卡顿
4. **无障碍访问不足**：当前动画未充分考虑光敏性癫痫用户和动画偏好设置（prefers-reduced-motion）

## 2. 目标

构建一套统一的转场动画与微交互系统，实现：

1. 流畅自然的界面转场动画，提升用户沉浸感
2. 统一的微交互组件库，为常见交互提供标准化动画反馈
3. 智能动画降级机制，在低端设备上自动简化动画
4. 完整的无障碍支持，尊重用户动画偏好设置

## 3. 范围

### 包含
- 屏幕转场动画系统（滑动、淡入淡出、缩放等）
- 微交互组件库（按钮涟漪、加载骨架屏、卡片翻转等）
- 动画编排引擎（串行/并行动画队列）
- 性能监控与自适应降级
- CSS变量驱动的动画主题系统
- prefers-reduced-motion媒体查询支持

### 不包含
- 3D模型动画（已有REQ-00027处理）
- 战斗动画帧率优化（已有REQ-00325处理）
- 粒子特效系统（已有ParticleSystem.js实现）

## 4. 详细需求

### 4.1 转场动画系统

```javascript
// game-client/src/transitions/TransitionManager.js
class TransitionManager {
  // 预定义转场类型
  static TRANSITIONS = {
    SLIDE_LEFT: 'slide-left',
    SLIDE_RIGHT: 'slide-right',
    SLIDE_UP: 'slide-up',
    SLIDE_DOWN: 'slide-down',
    FADE: 'fade',
    SCALE: 'scale',
    FLIP: 'flip',
    NONE: 'none'
  };

  // 执行转场
  async transition(fromScreen, toScreen, type, options = {}) {
    const duration = options.duration || this.getAdaptiveDuration(300);
    const easing = options.easing || 'cubic-bezier(0.4, 0, 0.2, 1)';
    
    // 并行执行出场和入场动画
    await Promise.all([
      this.animateOut(fromScreen, type, duration, easing),
      this.animateIn(toScreen, type, duration, easing)
    ]);
  }

  // 自适应动画时长（根据设备性能）
  getAdaptiveDuration(baseDuration) {
    const performanceScore = PerformanceMonitor.getScore();
    if (performanceScore < 30) return baseDuration * 0.3; // 低端设备快速完成
    if (performanceScore < 60) return baseDuration * 0.6;
    return baseDuration;
  }
}
```

### 4.2 微交互组件库

```javascript
// game-client/src/transitions/MicroInteractions.js

// 按钮涟漪效果
class RippleEffect {
  create(element, event) {
    const rect = element.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    element.appendChild(ripple);
    
    // 动画结束后移除
    ripple.addEventListener('animationend', () => ripple.remove());
  }
}

// 骨架屏加载效果
class SkeletonLoader {
  static render(container, config = {}) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-container';
    skeleton.innerHTML = config.template || this.getDefaultTemplate(config.type);
    container.appendChild(skeleton);
    return () => skeleton.remove(); // 返回清理函数
  }
}

// 卡片翻转效果
class CardFlip {
  static flip(cardElement, frontContent, backContent) {
    cardElement.classList.add('flipping');
    // 180度翻转动画
  }
}
```

### 4.3 动画编排引擎

```javascript
// game-client/src/transitions/AnimationOrchestrator.js
class AnimationOrchestrator {
  constructor() {
    this.queue = [];
    this.running = false;
  }

  // 串行动画
  serial(...animations) {
    return animations.reduce((chain, anim) => 
      chain.then(() => this.execute(anim)), 
      Promise.resolve()
    );
  }

  // 并行动画
  parallel(...animations) {
    return Promise.all(animations.map(anim => this.execute(anim)));
  }

  // 交错动画（列表项依次入场）
  stagger(elements, animation, delay = 50) {
    return Promise.all(
      elements.map((el, index) => 
        this.delay(index * delay).then(() => animation(el))
      )
    );
  }
}
```

### 4.4 CSS变量驱动的主题系统

```css
/* game-client/styles/transitions.css */
:root {
  /* 动画时长变量 */
  --transition-fast: 150ms;
  --transition-normal: 300ms;
  --transition-slow: 500ms;
  
  /* 缓动函数 */
  --ease-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
  
  /* 微交互 */
  --ripple-duration: 600ms;
  --skeleton-pulse-duration: 1.5s;
}

/* 无障碍：尊重用户偏好 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* 低性能设备降级 */
.low-performance {
  --transition-fast: 50ms;
  --transition-normal: 100ms;
  --transition-slow: 150ms;
}
```

### 4.5 性能监控与自适应降级

```javascript
// game-client/src/transitions/PerformanceMonitor.js
class PerformanceMonitor {
  static getScore() {
    // 综合评估：设备内存、CPU核心数、FPS历史
    const memory = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 2;
    const fps = this.getRecentFPS();
    
    return (memory * 10 + cores * 5 + fps * 0.5) / 2;
  }

  static shouldReduceMotion() {
    // 用户偏好 + 设备性能
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lowPerformance = this.getScore() < 40;
    return prefersReduced || lowPerformance;
  }
}
```

## 5. 验收标准

- [ ] 实现至少6种转场动画类型（滑动、淡入淡出、缩放、翻转、无动画、自适应）
- [ ] 实现至少5种微交互效果（涟漪、骨架屏、卡片翻转、列表交错入场、加载进度条）
- [ ] 所有转场动画支持`prefers-reduced-motion`媒体查询，自动禁用或简化
- [ ] 低端设备（DeviceMemory < 2GB）自动降级动画时长至50%
- [ ] 转场动画帧率保持在55fps以上（中端设备测试）
- [ ] 提供AnimationOrchestrator API支持串行/并行/交错动画编排
- [ ] 集成到至少4个核心界面切换场景（地图→捕捉、捕捉→背包、地图→好友、背包→详情）
- [ ] 添加开发者文档和示例代码

## 6. 工作量估算

**M (3-5天)**

理由：
- 转场动画系统核心逻辑相对成熟，可参考现有方案
- 微交互组件库需要逐一实现但复杂度不高
- 性能监控和自适应降级需要测试验证
- CSS变量系统设计简单，但需要与现有样式整合

## 7. 优先级理由

**P2** - 体验优化但不影响核心功能

1. **用户体验提升**：流畅的转场和细腻的微交互显著提升应用品质感
2. **差异化竞争优势**：优秀的动画体验是优秀应用的重要标志
3. **技术基础建设**：统一的动画系统为后续更多交互优化打下基础
4. **不影响核心功能**：即使没有此系统，游戏核心玩法仍可正常运行
5. **成熟度贡献**：提升"前端体验"维度评分，助力项目达到生产可用标准
