# REQ-00567: 智能骨架屏加载占位系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00567 |
| 标题 | 智能骨架屏加载占位系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client, frontend/game-client/src/components, frontend/game-client/src/styles |
| 创建时间 | 2026-07-16 03:00 |
| 依赖需求 | 无 |

## 1. 背景与问题

mineGo 游戏客户端是一个移动端 AR 精灵捕捉游戏，在数据加载过程中，用户经常面临以下体验问题：

1. **加载等待感知差**：当前使用简单的 loading spinner 或空白屏幕，用户无法预知内容结构，产生"卡顿"的主观感受
2. **网络波动影响大**：在 4G/5G 弱网环境下，精灵列表、地图数据加载慢，用户需要长时间等待
3. **首屏渲染闪烁**：内容异步加载后突然出现，缺乏过渡动画，造成视觉跳动
4. **移动端体验不佳**：低端设备上骨架屏可以让用户感觉界面"已就绪"，减少焦虑感

竞品分析显示，Pokemon GO、Ingress 等 AR 游戏均使用骨架屏技术改善加载体验。当前 mineGo 缺少完整的骨架屏系统。

## 2. 目标

构建一套智能骨架屏加载占位系统，实现：

- **视觉连续性**：内容加载前后平滑过渡，消除视觉跳动
- **结构预览**：骨架屏准确反映目标内容的布局和结构
- **性能优先**：骨架屏本身轻量、渲染快速，不增加首屏负担
- **动画自然**：脉冲或波浪动画符合现代 UI 设计规范
- **自适应尺寸**：根据容器自动计算骨架尺寸，支持响应式布局
- **可配置性**：支持主题、动画、颜色、圆角等自定义

**量化目标**：
- 首屏感知加载时间减少 30%（主观测试）
- 骨架屏渲染延迟 < 16ms
- 支持 10+ 种预设骨架模板
- 支持 WCAG 2.1 动画减少模式

## 3. 范围

**包含**：
- 骨架屏核心引擎（SkeletonLoader.js）
- 预设骨架组件（精灵卡片、列表项、地图标记、用户面板等）
- 骨架动画系统（脉冲、波浪、闪烁）
- 响应式尺寸计算引擎
- 主题集成（与 HighContrastMode 协作）
- 开发者 API（自动生成、手动配置）
- 无障碍支持（aria-busy、动画减少模式）

**不包含**：
- 服务端渲染（SSR）骨架屏
- 数据预取逻辑
- 离线缓存集成

## 4. 详细需求

### 4.1 骨架屏核心引擎

**4.1.1 基础架构**

```javascript
// SkeletonLoader.js
export class SkeletonLoader {
  constructor(options) {
    this.theme = options.theme || 'default';
    this.animation = options.animation || 'pulse';
    this.borderRadius = options.borderRadius || 8;
    this.baseColor = options.baseColor || 'var(--surface2)';
    this.highlightColor = options.highlightColor || 'var(--surface)';
  }
  
  // 创建骨架元素
  createSkeleton(config) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-wrapper';
    skeleton.setAttribute('aria-busy', 'true');
    skeleton.setAttribute('aria-label', '内容加载中');
    skeleton.style.setProperty('--skeleton-base', this.baseColor);
    skeleton.style.setProperty('--skeleton-highlight', this.highlightColor);
    return this.buildStructure(skeleton, config);
  }
  
  // 构建骨架结构
  buildStructure(container, config) {
    config.elements.forEach(el => {
      const skeletonEl = this.createSkeletonElement(el);
      container.appendChild(skeletonEl);
    });
    return container;
  }
  
  // 创建单个骨架元素
  createSkeletonElement(config) {
    const el = document.createElement('div');
    el.className = `skeleton-element skeleton-${config.type}`;
    
    if (config.width) el.style.width = config.width;
    if (config.height) el.style.height = config.height;
    if (config.borderRadius !== undefined) {
      el.style.borderRadius = `${config.borderRadius}px`;
    }
    
    return el;
  }
}
```

**4.1.2 骨架元素类型**

| 类型 | 用途 | 默认尺寸 |
|------|------|----------|
| `avatar` | 头像、精灵图标 | 48x48px, 圆形 |
| `card` | 卡片容器 | 100%x120px, 圆角8px |
| `text` | 单行文本 | 100%x16px, 圆角4px |
| `text-multi` | 多行文本 | 100%xN*20px |
| `image` | 图片占位 | 100%x200px |
| `button` | 按钮 | 120x40px, 圆角20px |
| `badge` | 徽章、标签 | 60x24px, 圆角12px |
| `progress` | 进度条 | 100%x8px, 圆角4px |
| `map-marker` | 地图标记 | 40x48px |
| `stat` | 数值统计 | 80x60px |

### 4.2 预设骨架模板

**4.2.1 精灵卡片骨架**

```javascript
// templates/PokemonCardSkeleton.js
export const PokemonCardSkeleton = {
  name: 'pokemon-card',
  elements: [
    { type: 'image', width: '100%', height: '120px', borderRadius: 8 },
    { type: 'avatar', width: '64px', height: '64px', borderRadius: 32, marginTop: '-32px', marginLeft: '16px' },
    { type: 'text', width: '60%', height: '18px', marginTop: '12px', marginLeft: '16px' },
    { type: 'text', width: '40%', height: '14px', marginTop: '8px', marginLeft: '16px', color: 'muted' },
    { type: 'badge', width: '80px', height: '24px', marginTop: '12px', marginLeft: '16px' },
    { type: 'stat', width: '100%', height: '48px', marginTop: '12px', padding: '8px 16px' }
  ]
};
```

**4.2.2 精灵列表项骨架**

```javascript
// templates/PokemonListItemSkeleton.js
export const PokemonListItemSkeleton = {
  name: 'pokemon-list-item',
  elements: [
    { type: 'avatar', width: '48px', height: '48px', borderRadius: 24 },
    { type: 'text', width: '40%', height: '16px', marginLeft: '12px' },
    { type: 'text', width: '30%', height: '14px', marginLeft: '12px', color: 'muted' },
    { type: 'badge', width: '60px', height: '20px', marginLeft: 'auto' }
  ]
};
```

**4.2.3 用户面板骨架**

```javascript
// templates/UserPanelSkeleton.js
export const UserPanelSkeleton = {
  name: 'user-panel',
  elements: [
    { type: 'avatar', width: '64px', height: '64px', borderRadius: 32 },
    { type: 'text', width: '50%', height: '20px', marginTop: '8px' },
    { type: 'text', width: '40%', height: '14px', marginTop: '4px', color: 'muted' },
    { type: 'progress', width: '100%', height: '8px', marginTop: '12px' },
    { type: 'text', width: '30%', height: '12px', marginTop: '4px', color: 'muted' }
  ]
};
```

**4.2.4 地图标记骨架**

```javascript
// templates/MapMarkerSkeleton.js
export const MapMarkerSkeleton = {
  name: 'map-marker',
  elements: [
    { type: 'circle', width: '40px', height: '40px', borderRadius: 20 },
    { type: 'triangle', width: '12px', height: '8px', marginTop: '-4px' }
  ]
};
```

### 4.3 骨架动画系统

**4.3.1 动画类型**

```css
/* styles/skeleton-animations.css */

/* 脉冲动画（默认） */
@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.skeleton-pulse {
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

/* 波浪动画 */
@keyframes skeleton-wave {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.skeleton-wave {
  background: linear-gradient(
    90deg,
    var(--skeleton-base) 25%,
    var(--skeleton-highlight) 50%,
    var(--skeleton-base) 75%
  );
  background-size: 200% 100%;
  animation: skeleton-wave 1.5s ease-in-out infinite;
}

/* 闪烁动画 */
@keyframes skeleton-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.skeleton-shimmer::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255,255,255,0.2),
    transparent
  );
  animation: skeleton-shimmer 2s ease-in-out infinite;
}

/* 减少动画模式 */
@media (prefers-reduced-motion: reduce) {
  .skeleton-pulse,
  .skeleton-wave,
  .skeleton-shimmer::after {
    animation: none;
  }
  
  .skeleton-element {
    opacity: 0.7;
  }
}
```

**4.3.2 动画配置 API**

```javascript
// 动画配置
const animationConfig = {
  type: 'wave',        // 'pulse' | 'wave' | 'shimmer' | 'none'
  duration: 1500,      // 持续时间 (ms)
  timingFunction: 'ease-in-out',
  delay: 0,            // 延迟 (ms)
  stagger: 100         // 元素间错开延迟 (ms)
};
```

### 4.4 响应式尺寸计算

```javascript
// utils/SkeletonSizer.js
export class SkeletonSizer {
  constructor() {
    this.baseUnit = 16; // 基准单位 (px)
    this.breakpoints = {
      sm: 375,
      md: 768,
      lg: 1024,
      xl: 1440
    };
  }
  
  // 根据容器计算骨架尺寸
  calculateSize(container, config) {
    const containerWidth = container.offsetWidth;
    const breakpoint = this.getBreakpoint(containerWidth);
    
    return this.applyBreakpoint(config, breakpoint);
  }
  
  getBreakpoint(width) {
    if (width < this.breakpoints.sm) return 'xs';
    if (width < this.breakpoints.md) return 'sm';
    if (width < this.breakpoints.lg) return 'md';
    if (width < this.breakpoints.xl) return 'lg';
    return 'xl';
  }
  
  applyBreakpoint(config, breakpoint) {
    const scaleFactor = this.getScaleFactor(breakpoint);
    
    return {
      ...config,
      elements: config.elements.map(el => ({
        ...el,
        width: this.scaleValue(el.width, scaleFactor),
        height: this.scaleValue(el.height, scaleFactor)
      }))
    };
  }
  
  getScaleFactor(breakpoint) {
    const factors = { xs: 0.85, sm: 0.9, md: 1, lg: 1.1, xl: 1.2 };
    return factors[breakpoint] || 1;
  }
  
  scaleValue(value, factor) {
    if (typeof value === 'number') {
      return `${Math.round(value * factor)}px`;
    }
    if (value.endsWith('px')) {
      const num = parseFloat(value);
      return `${Math.round(num * factor)}px`;
    }
    return value; // 保持百分比等相对单位
  }
}
```

### 4.5 高对比度模式集成

```javascript
// integration/HighContrastSkeleton.js
export class HighContrastSkeleton {
  constructor(skeletonLoader, highContrastMode) {
    this.loader = skeletonLoader;
    this.hcMode = highContrastMode;
    
    // 监听高对比度模式变化
    window.addEventListener('high-contrast-change', (e) => {
      this.updateSkeletonTheme(e.detail.mode);
    });
  }
  
  updateSkeletonTheme(mode) {
    const root = document.documentElement;
    
    if (mode === 'high-contrast' || mode === 'black-white') {
      // 高对比度骨架配色
      root.style.setProperty('--skeleton-base', '#333333');
      root.style.setProperty('--skeleton-highlight', '#555555');
    } else {
      // 标准配色
      root.style.setProperty('--skeleton-base', 'var(--surface2)');
      root.style.setProperty('--skeleton-highlight', 'var(--surface)');
    }
    
    // 重新渲染现有骨架
    document.querySelectorAll('.skeleton-wrapper').forEach(el => {
      el.style.setProperty('--skeleton-base', root.style.getPropertyValue('--skeleton-base'));
      el.style.setProperty('--skeleton-highlight', root.style.getPropertyValue('--skeleton-highlight'));
    });
  }
}
```

### 4.6 开发者 API

**4.6.1 声明式使用**

```javascript
// 自动生成骨架屏
import { createSkeleton } from './SkeletonLoader';

// 方式1: 基于配置对象
const skeleton = createSkeleton({
  template: 'pokemon-card',
  animation: 'wave',
  count: 3
});

container.appendChild(skeleton);

// 方式2: 基于现有元素自动推断
const skeleton = createSkeleton({
  target: document.querySelector('.pokemon-card'),
  animation: 'pulse'
});
```

**4.6.2 组件封装**

```javascript
// components/SkeletonWrapper.js
export class SkeletonWrapper {
  constructor(container, config) {
    this.container = container;
    this.config = config;
    this.skeleton = null;
    this.content = null;
  }
  
  // 显示骨架屏
  show() {
    this.skeleton = createSkeleton(this.config);
    this.container.innerHTML = '';
    this.container.appendChild(this.skeleton);
    this.container.setAttribute('aria-busy', 'true');
  }
  
  // 隐藏骨架屏，显示内容
  hide(content) {
    this.content = content;
    this.container.innerHTML = '';
    this.container.appendChild(content);
    this.container.setAttribute('aria-busy', 'false');
    
    // 添加淡入动画
    content.style.opacity = '0';
    content.style.transition = 'opacity 0.3s ease';
    requestAnimationFrame(() => {
      content.style.opacity = '1';
    });
  }
  
  // 带加载状态的自动切换
  async load(loader) {
    this.show();
    try {
      const data = await loader();
      const content = this.renderContent(data);
      this.hide(content);
      return data;
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }
}
```

### 4.7 无障碍支持

```javascript
// accessibility/SkeletonA11y.js
export class SkeletonA11y {
  static setup(skeleton) {
    // 设置 ARIA 属性
    skeleton.setAttribute('role', 'status');
    skeleton.setAttribute('aria-busy', 'true');
    skeleton.setAttribute('aria-label', '内容加载中');
    
    // 添加屏幕阅读器公告
    this.announce('加载中，请稍候');
    
    return skeleton;
  }
  
  static announce(message) {
    const announcer = document.getElementById('sr-announcer') || 
      this.createAnnouncer();
    
    announcer.textContent = message;
    
    // 3秒后清除
    setTimeout(() => {
      announcer.textContent = '';
    }, 3000);
  }
  
  static createAnnouncer() {
    const announcer = document.createElement('div');
    announcer.id = 'sr-announcer';
    announcer.setAttribute('aria-live', 'polite');
    announcer.setAttribute('aria-atomic', 'true');
    announcer.className = 'sr-only';
    announcer.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)';
    document.body.appendChild(announcer);
    return announcer;
  }
}
```

## 5. 验收标准（可测试）

- [ ] 骨架屏在数据加载前正确显示，结构与目标内容匹配
- [ ] 脉冲、波浪、闪烁三种动画均可正常工作且流畅（60fps）
- [ ] 在 `prefers-reduced-motion: reduce` 环境下自动禁用动画
- [ ] 高对比度模式下骨架屏配色正确切换
- [ ] 响应式布局下骨架屏尺寸自动适配（xs/sm/md/lg/xl 断点）
- [ ] 骨架屏包含正确的 ARIA 属性（aria-busy、aria-label）
- [ ] 内容加载完成后骨架屏平滑过渡消失，内容淡入
- [ ] 预设模板 ≥ 10 种（精灵卡片、列表项、用户面板、地图标记等）
- [ ] 骨架屏渲染时间 < 16ms（性能测试）
- [ ] 用户主观测试：首屏感知加载时间减少 ≥ 30%

## 6. 工作量估算

**L（大）** - 约 3-5 个工作日

理由：
- 核心引擎开发：1 天
- 预设模板设计实现：1 天
- 动画系统 + 响应式：1 天
- 高对比度集成 + 无障碍：0.5 天
- 测试 + 文档：0.5 天

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **用户体验关键**：骨架屏直接影响用户对加载性能的主观感知，是移动端 AR 游戏的核心体验要素
2. **竞品标配**：Pokemon GO 等竞品均已实现，缺少此功能会影响产品竞争力
3. **成本低收益高**：开发成本可控（3-5天），但能显著改善弱网、低端设备场景的用户体验
4. **与现有系统集成**：与已有的 HighContrastMode、LazyComponents 等模块良好协作
5. **无障碍合规**：符合 WCAG 2.1 对加载状态的可访问性要求
