# REQ-00110：前端资源懒加载与代码分割系统

- **编号**：REQ-00110
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src、frontend/game-client/src/components、frontend/game-client/src/utils
- **创建时间**：2026-06-11 11:35
- **依赖需求**：REQ-00009（PWA 离线支持）

## 1. 背景与问题

当前 game-client 采用单入口打包模式，所有 JavaScript 和 CSS 资源在首屏加载时一次性请求，导致：

1. **首屏加载时间长**：初始 JS bundle 约 800KB（压缩后），移动端 3G 网络下加载需 4-6 秒
2. **非关键资源阻塞**：3D 模型查看器、音效系统、社交模块等非首屏功能在首屏加载时即被请求
3. **内存占用高**：所有模块一次性加载到内存，低端设备内存压力大
4. **流量浪费**：用户可能只使用地图和捕捉功能，但加载了全部模块
5. **TTI（Time to Interactive）延迟**：主线程被大量 JS 解析阻塞，交互响应延迟 2-3 秒

竞品分析显示，Pokemon GO 首屏 TTI < 1.5 秒，而当前 mineGo 首屏 TTI 约 4 秒。

## 2. 目标

实现前端资源懒加载与代码分割系统，达成以下目标：

1. **首屏加载时间降低 60%**：从 4 秒降至 < 1.6 秒（3G 网络）
2. **初始 bundle 体积减少 70%**：从 800KB 降至 < 240KB
3. **TTI 降低 50%**：从 4 秒降至 < 2 秒
4. **按需加载**：用户访问功能时才加载对应模块
5. **预加载策略**：智能预测用户行为，提前加载可能需要的模块

## 3. 范围

- **包含**：
  - 代码分割策略设计（路由级、组件级、功能级）
  - 动态 import() 懒加载实现
  - Chunk 命名与预加载策略
  - 加载状态与错误处理 UI
  - 性能监控与优化指标
  - Webpack/Vite 构建配置优化

- **不包含**：
  - 服务端渲染（SSR）改造
  - 微前端架构改造
  - 图片懒加载（已有 CDN 系统支持）

## 4. 详细需求

### 4.1 代码分割策略

```javascript
// 分割层级设计
const codeSplitStrategy = {
  // 1. 路由级分割（按页面）
  routes: {
    'map': 'chunk-map',           // 地图页（首屏，不分割）
    'catch': 'chunk-catch',       // 捕捉页（首屏，不分割）
    'pokemon-detail': 'chunk-pokemon-detail',  // 精灵详情（懒加载）
    'pokedex': 'chunk-pokedex',   // 图鉴（懒加载）
    'gym': 'chunk-gym',           // 道馆（懒加载）
    'social': 'chunk-social',     // 社交（懒加载）
    'shop': 'chunk-shop',         // 商店（懒加载）
    'settings': 'chunk-settings', // 设置（懒加载）
    'inventory': 'chunk-inventory' // 背包（懒加载）
  },
  
  // 2. 组件级分割（按功能模块）
  components: {
    '3d-viewer': 'chunk-3d',      // 3D 模型查看器（懒加载）
    'audio': 'chunk-audio',       // 音效系统（懒加载）
    'battle': 'chunk-battle',     // 战斗系统（懒加载）
    'trading': 'chunk-trading',   // 交易系统（懒加载）
    'chat': 'chunk-chat',         // 聊天系统（懒加载）
    'leaderboard': 'chunk-leaderboard' // 排行榜（懒加载）
  },
  
  // 3. 第三方库分割
  vendors: {
    'three': 'chunk-three',       // Three.js（懒加载）
    'chart': 'chunk-chart',       // 图表库（懒加载）
    'map-sdk': 'chunk-map-sdk'    // 地图 SDK（首屏必需）
  }
};
```

### 4.2 懒加载实现

```javascript
// frontend/game-client/src/utils/lazyLoad.js

/**
 * 懒加载工具类
 */
class LazyLoader {
  constructor() {
    this.loadedChunks = new Set();
    this.loadingChunks = new Map();
    this.prefetchQueue = [];
  }
  
  /**
   * 动态加载模块
   * @param {string} chunkName - Chunk 名称
   * @param {Function} importFn - import() 函数
   * @param {Object} options - 配置选项
   */
  async load(chunkName, importFn, options = {}) {
    // 已加载则直接返回
    if (this.loadedChunks.has(chunkName)) {
      return this.getModule(chunkName);
    }
    
    // 正在加载则等待
    if (this.loadingChunks.has(chunkName)) {
      return this.loadingChunks.get(chunkName);
    }
    
    // 开始加载
    const loadPromise = this.doLoad(chunkName, importFn, options);
    this.loadingChunks.set(chunkName, loadPromise);
    
    try {
      const module = await loadPromise;
      this.loadedChunks.add(chunkName);
      this.loadingChunks.delete(chunkName);
      return module;
    } catch (error) {
      this.loadingChunks.delete(chunkName);
      throw error;
    }
  }
  
  /**
   * 预加载模块（低优先级）
   */
  prefetch(chunkName, importFn) {
    if (!this.loadedChunks.has(chunkName) && !this.loadingChunks.has(chunkName)) {
      this.prefetchQueue.push({ chunkName, importFn });
      this.processPrefetchQueue();
    }
  }
  
  /**
   * 获取加载状态
   */
  getStatus(chunkName) {
    if (this.loadedChunks.has(chunkName)) return 'loaded';
    if (this.loadingChunks.has(chunkName)) return 'loading';
    return 'not-loaded';
  }
}

// 导出单例
export const lazyLoader = new LazyLoader();

/**
 * 创建懒加载组件
 */
export function createLazyComponent(importFn, options = {}) {
  return {
    name: 'LazyComponent',
    props: options.props || [],
    data() {
      return {
        component: null,
        loading: false,
        error: null
      };
    },
    async mounted() {
      this.loading = true;
      try {
        const module = await importFn();
        this.component = module.default || module;
        this.loading = false;
      } catch (err) {
        this.error = err;
        this.loading = false;
        console.error(`Lazy load failed:`, err);
      }
    },
    render(h) {
      if (this.error) {
        return h('div', { class: 'lazy-load-error' }, [
          h('p', '加载失败'),
          h('button', { on: { click: () => this.mounted() } }, '重试')
        ]);
      }
      if (this.loading) {
        return h('div', { class: 'lazy-load-placeholder' }, [
          options.placeholder || h('div', { class: 'loading-spinner' })
        ]);
      }
      if (this.component) {
        return h(this.component, { props: this.$props });
      }
      return null;
    }
  };
}
```

### 4.3 组件懒加载示例

```javascript
// frontend/game-client/src/components/index.js

import { createLazyComponent, lazyLoader } from '../utils/lazyLoad.js';

// 首屏组件（不懒加载）
export { default as MapView } from './MapView.js';
export { default as CatchScene } from './CatchScene.js';
export { default as BottomNav } from './BottomNav.js';

// 懒加载组件
export const Pokemon3DViewer = createLazyComponent(
  () => import('../3d/Pokemon3DViewer.js'),
  { 
    placeholder: '<div class="loading-3d">加载 3D 查看器...</div>',
    props: ['pokemon', 'visible']
  }
);

export const BattleScene = createLazyComponent(
  () => import('./BattleScene.js'),
  { 
    placeholder: '<div class="loading-battle">加载战斗系统...</div>',
    props: ['battle', 'onAction']
  }
);

export const AudioPlayer = createLazyComponent(
  () => import('../audio/AudioPlayer.js'),
  { 
    placeholder: null, // 音效不需要占位符
    props: ['sound', 'volume']
  }
);

export const TradingModal = createLazyComponent(
  () => import('./TradingModal.js'),
  { 
    placeholder: '<div class="loading-modal">加载交易系统...</div>',
    props: ['trade', 'onConfirm']
  }
);

export const LeaderboardPanel = createLazyComponent(
  () => import('./LeaderboardPanel.js'),
  { 
    placeholder: '<div class="loading-leaderboard">加载排行榜...</div>',
    props: ['type', 'limit']
  }
);
```

### 4.4 预加载策略

```javascript
// frontend/game-client/src/utils/prefetchStrategy.js

/**
 * 智能预加载策略
 * 根据用户行为预测可能需要的模块
 */
class PrefetchStrategy {
  constructor() {
    this.userBehavior = [];
    this.prefetchRules = this.initRules();
  }
  
  initRules() {
    return [
      // 规则1：用户进入地图后，预加载捕捉和道馆
      {
        trigger: 'map:enter',
        prefetch: ['chunk-catch', 'chunk-gym'],
        delay: 2000
      },
      // 规则2：用户查看精灵详情时，预加载 3D 查看器
      {
        trigger: 'pokemon:detail',
        prefetch: ['chunk-3d'],
        delay: 500
      },
      // 规则3：用户进入战斗时，预加载音效
      {
        trigger: 'battle:start',
        prefetch: ['chunk-audio'],
        delay: 0
      },
      // 规则4：用户打开社交页时，预加载聊天和交易
      {
        trigger: 'social:enter',
        prefetch: ['chunk-chat', 'chunk-trading'],
        delay: 1000
      },
      // 规则5：用户接近道馆时，预加载战斗系统
      {
        trigger: 'gym:nearby',
        prefetch: ['chunk-battle'],
        delay: 0
      }
    ];
  }
  
  /**
   * 记录用户行为
   */
  recordBehavior(event) {
    this.userBehavior.push({
      event,
      timestamp: Date.now()
    });
    
    // 保留最近 50 条行为
    if (this.userBehavior.length > 50) {
      this.userBehavior.shift();
    }
    
    // 触发预加载
    this.checkPrefetch(event);
  }
  
  /**
   * 检查是否需要预加载
   */
  checkPrefetch(event) {
    for (const rule of this.prefetchRules) {
      if (rule.trigger === event) {
        setTimeout(() => {
          rule.prefetch.forEach(chunk => {
            lazyLoader.prefetch(chunk, this.getImportFn(chunk));
          });
        }, rule.delay);
      }
    }
  }
  
  /**
   * 获取 import 函数
   */
  getImportFn(chunkName) {
    const importMap = {
      'chunk-3d': () => import('../3d/Pokemon3DViewer.js'),
      'chunk-audio': () => import('../audio/AudioPlayer.js'),
      'chunk-battle': () => import('../components/BattleScene.js'),
      'chunk-chat': () => import('../components/ChatPanel.js'),
      'chunk-trading': () => import('../components/TradingModal.js'),
      'chunk-gym': () => import('../components/GymDetail.js'),
      'chunk-catch': () => import('../components/CatchScene.js')
    };
    return importMap[chunkName] || (() => Promise.resolve());
  }
}

export const prefetchStrategy = new PrefetchStrategy();
```

### 4.5 构建配置

```javascript
// frontend/game-client/webpack.config.js (或 vite.config.js)

module.exports = {
  // 代码分割配置
  optimization: {
    splitChunks: {
      chunks: 'all',
      minSize: 20000,
      minChunks: 1,
      maxAsyncRequests: 30,
      maxInitialRequests: 10,
      automaticNameDelimiter: '-',
      cacheGroups: {
        // 第三方库
        vendors: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          chunks: 'all',
          priority: 100
        },
        // Three.js 单独分割
        three: {
          test: /[\\/]node_modules[\\/]three/,
          name: 'chunk-three',
          chunks: 'async',
          priority: 90
        },
        // 公共模块
        common: {
          minChunks: 2,
          name: 'common',
          chunks: 'all',
          priority: 50
        }
      }
    }
  },
  
  // 入口配置
  entry: {
    main: './src/main.js'
  },
  
  // 输出配置
  output: {
    filename: '[name].[contenthash:8].js',
    chunkFilename: 'chunks/[name].[contenthash:8].js',
    path: path.resolve(__dirname, 'dist')
  }
};
```

### 4.6 加载状态 UI

```css
/* frontend/game-client/src/styles/lazy-load.css */

.lazy-load-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #e0e0e0;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.lazy-load-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px;
  color: #ef4444;
}

.lazy-load-error button {
  margin-top: 10px;
  padding: 8px 16px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
```

### 4.7 性能监控

```javascript
// frontend/game-client/src/utils/lazyLoadMetrics.js

/**
 * 懒加载性能监控
 */
class LazyLoadMetrics {
  constructor() {
    this.metrics = {
      chunkLoadTimes: {},
      totalLoadTime: 0,
      chunksLoaded: 0,
      cacheHits: 0,
      errors: 0
    };
  }
  
  /**
   * 记录 chunk 加载
   */
  recordLoad(chunkName, loadTime, fromCache = false) {
    this.metrics.chunkLoadTimes[chunkName] = loadTime;
    this.metrics.totalLoadTime += loadTime;
    this.metrics.chunksLoaded++;
    
    if (fromCache) {
      this.metrics.cacheHits++;
    }
    
    // 上报指标
    this.reportMetrics();
  }
  
  /**
   * 记录加载错误
   */
  recordError(chunkName, error) {
    this.metrics.errors++;
    console.error(`Chunk load error: ${chunkName}`, error);
    this.reportMetrics();
  }
  
  /**
   * 上报指标
   */
  reportMetrics() {
    // 发送到 Prometheus
    if (window.__METRICS__) {
      window.__METRICS__.gauge('lazy_load_chunks_total', this.metrics.chunksLoaded);
      window.__METRICS__.gauge('lazy_load_cache_hits', this.metrics.cacheHits);
      window.__METRICS__.gauge('lazy_load_errors', this.metrics.errors);
      window.__METRICS__.gauge('lazy_load_total_time_ms', this.metrics.totalLoadTime);
    }
  }
  
  /**
   * 获取性能报告
   */
  getReport() {
    return {
      ...this.metrics,
      averageLoadTime: this.metrics.chunksLoaded > 0 
        ? this.metrics.totalLoadTime / this.metrics.chunksLoaded 
        : 0,
      cacheHitRate: this.metrics.chunksLoaded > 0 
        ? this.metrics.cacheHits / this.metrics.chunksLoaded 
        : 0
    };
  }
}

export const lazyLoadMetrics = new LazyLoadMetrics();
```

## 5. 验收标准（可测试）

- [ ] 首屏 JS bundle 体积 < 240KB（gzip 压缩后）
- [ ] 首屏 TTI < 2 秒（3G 网络）
- [ ] 懒加载组件在首次访问时正确加载
- [ ] 已加载组件再次访问时从缓存读取，不重复请求
- [ ] 预加载策略正确触发，预加载的 chunk 在用户访问时立即可用
- [ ] 加载失败时显示错误 UI 并提供重试按钮
- [ ] 所有懒加载 chunk 有正确的加载状态占位符
- [ ] 性能指标正确上报到 Prometheus
- [ ] 单元测试覆盖核心逻辑，覆盖率 > 80%
- [ ] 构建产物中 chunk 文件命名包含 contenthash

## 6. 工作量估算

**M（中等）**

理由：
- 主要是构建配置和工具类实现，不涉及复杂业务逻辑
- 需要改造部分组件的导入方式
- 预加载策略需要与业务逻辑结合
- 预计 2-3 天完成

## 7. 优先级理由

**P1 理由**：
1. 首屏性能直接影响用户留存率，是移动端应用的关键指标
2. 当前首屏加载时间 4 秒远超行业标准（< 2 秒），用户体验差
3. 按需加载可显著降低移动端流量消耗，提升用户满意度
4. 为后续功能扩展提供基础，避免 bundle 体积无限增长
