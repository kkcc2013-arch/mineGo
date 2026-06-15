// frontend/game-client/src/utils/lazyLoad.js
// Lazy loading utility for code splitting and dynamic imports
'use strict';

/**
 * 懒加载工具类
 * 支持动态导入、缓存、预加载、错误处理
 */
class LazyLoader {
  constructor() {
    this.loadedChunks = new Map(); // chunkName -> module
    this.loadingChunks = new Map(); // chunkName -> Promise
    this.prefetchQueue = [];
    this.isProcessingPrefetch = false;
    this.metrics = {
      chunkLoadTimes: {},
      totalLoadTime: 0,
      chunksLoaded: 0,
      cacheHits: 0,
      errors: 0
    };
  }

  /**
   * 动态加载模块
   * @param {string} chunkName - Chunk 名称
   * @param {Function} importFn - import() 函数
   * @param {Object} options - 配置选项
   */
  async load(chunkName, importFn, options = {}) {
    const startTime = performance.now();

    // 已加载则直接返回
    if (this.loadedChunks.has(chunkName)) {
      this.metrics.cacheHits++;
      if (options.onLoad) options.onLoad(chunkName, true);
      return this.loadedChunks.get(chunkName);
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
      const loadTime = performance.now() - startTime;

      this.loadedChunks.set(chunkName, module);
      this.loadingChunks.delete(chunkName);

      // 记录指标
      this.recordLoad(chunkName, loadTime);

      if (options.onLoad) options.onLoad(chunkName, false, loadTime);

      return module;
    } catch (error) {
      this.loadingChunks.delete(chunkName);
      this.metrics.errors++;

      if (options.onError) {
        options.onError(chunkName, error);
      } else {
        console.error(`[LazyLoader] Failed to load ${chunkName}:`, error);
      }

      throw error;
    }
  }

  /**
   * 执行加载
   */
  async doLoad(chunkName, importFn, options) {
    try {
      const module = await importFn();
      return module.default || module;
    } catch (error) {
      // 重试逻辑
      if (options.retryCount > 0) {
        console.warn(`[LazyLoader] Retrying ${chunkName}... (${options.retryCount} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, options.retryDelay || 1000));
        return this.doLoad(chunkName, importFn, { ...options, retryCount: options.retryCount - 1 });
      }
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
   * 处理预加载队列
   */
  async processPrefetchQueue() {
    if (this.isProcessingPrefetch || this.prefetchQueue.length === 0) {
      return;
    }

    this.isProcessingPrefetch = true;

    while (this.prefetchQueue.length > 0) {
      const { chunkName, importFn } = this.prefetchQueue.shift();

      // 使用 requestIdleCallback 在浏览器空闲时加载
      if ('requestIdleCallback' in window) {
        await new Promise(resolve => {
          requestIdleCallback(async () => {
            try {
              await this.load(chunkName, importFn);
            } catch (err) {
              console.debug(`[LazyLoader] Prefetch failed for ${chunkName}:`, err);
            }
            resolve();
          }, { timeout: 5000 });
        });
      } else {
        // 降级：使用 setTimeout
        await new Promise(resolve => {
          setTimeout(async () => {
            try {
              await this.load(chunkName, importFn);
            } catch (err) {
              console.debug(`[LazyLoader] Prefetch failed for ${chunkName}:`, err);
            }
            resolve();
          }, 100);
        });
      }
    }

    this.isProcessingPrefetch = false;
  }

  /**
   * 获取加载状态
   */
  getStatus(chunkName) {
    if (this.loadedChunks.has(chunkName)) return 'loaded';
    if (this.loadingChunks.has(chunkName)) return 'loading';
    return 'not-loaded';
  }

  /**
   * 检查模块是否已加载
   */
  isLoaded(chunkName) {
    return this.loadedChunks.has(chunkName);
  }

  /**
   * 清除缓存
   */
  clearCache(chunkName) {
    if (chunkName) {
      this.loadedChunks.delete(chunkName);
    } else {
      this.loadedChunks.clear();
    }
  }

  /**
   * 记录加载指标
   */
  recordLoad(chunkName, loadTime) {
    this.metrics.chunkLoadTimes[chunkName] = loadTime;
    this.metrics.totalLoadTime += loadTime;
    this.metrics.chunksLoaded++;

    // 上报到监控
    this.reportMetrics();
  }

  /**
   * 上报指标
   */
  reportMetrics() {
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

// 导出单例
export const lazyLoader = new LazyLoader();

/**
 * 创建懒加载组件工厂
 */
export function createLazyComponent(importFn, options = {}) {
  const {
    placeholder = null,
    errorComponent = null,
    retryCount = 1,
    retryDelay = 1000,
    preload = false,
    onError = null
  } = options;

  // 懒加载组件类
  return class LazyComponent {
    constructor(props = {}) {
      this.props = props;
      this.state = {
        component: null,
        loading: !lazyLoader.isLoaded(options.chunkName),
        error: null
      };
      this.element = null;
      this.childComponent = null;
    }

    async mount(container) {
      this.container = container;

      // 显示占位符
      if (this.state.loading && placeholder) {
        this.renderPlaceholder();
      }

      // 加载组件
      try {
        const module = await lazyLoader.load(
          options.chunkName || 'anonymous',
          importFn,
          { retryCount, retryDelay, onError }
        );

        this.state.component = module;
        this.state.loading = false;

        // 渲染真实组件
        this.renderComponent();
      } catch (err) {
        this.state.error = err;
        this.state.loading = false;

        if (onError) {
          onError(err);
        }

        this.renderError();
      }
    }

    renderPlaceholder() {
      if (!this.container) return;

      if (typeof placeholder === 'string') {
        this.container.innerHTML = `<div class="lazy-load-placeholder">${placeholder}</div>`;
      } else if (placeholder instanceof HTMLElement) {
        this.container.innerHTML = '';
        this.container.appendChild(placeholder.cloneNode(true));
      }

      this.element = this.container.firstElementChild;
    }

    renderComponent() {
      if (!this.container || !this.state.component) return;

      // 清空容器
      this.container.innerHTML = '';

      // 实例化真实组件
      const ComponentClass = this.state.component;
      this.childComponent = new ComponentClass(this.props);

      if (typeof this.childComponent.mount === 'function') {
        this.childComponent.mount(this.container);
      }

      this.element = this.container.firstElementChild;
    }

    renderError() {
      if (!this.container) return;

      if (errorComponent) {
        if (typeof errorComponent === 'function') {
          this.container.innerHTML = errorComponent(this.state.error);
        } else {
          this.container.innerHTML = errorComponent;
        }
      } else {
        this.container.innerHTML = `
          <div class="lazy-load-error">
            <p>⚠️ 加载失败</p>
            <button class="retry-btn">重试</button>
          </div>
        `;

        const retryBtn = this.container.querySelector('.retry-btn');
        if (retryBtn) {
          retryBtn.addEventListener('click', () => {
            this.state = { component: null, loading: true, error: null };
            this.mount(this.container);
          });
        }
      }

      this.element = this.container.firstElementChild;
    }

    update(newProps) {
      this.props = { ...this.props, ...newProps };

      if (this.childComponent && typeof this.childComponent.update === 'function') {
        this.childComponent.update(this.props);
      }
    }

    unmount() {
      if (this.childComponent && typeof this.childComponent.unmount === 'function') {
        this.childComponent.unmount();
      }

      if (this.container) {
        this.container.innerHTML = '';
      }
    }
  };
}

/**
 * 懒加载函数（简化版）
 */
export async function lazyImport(importFn, chunkName) {
  return lazyLoader.load(chunkName || 'anonymous', importFn);
}

/**
 * 批量预加载
 */
export function prefetchAll(importMap) {
  Object.entries(importMap).forEach(([chunkName, importFn]) => {
    lazyLoader.prefetch(chunkName, importFn);
  });
}

/**
 * 代码分割策略配置
 */
export const CODE_SPLIT_STRATEGY = {
  // 首屏必需（不懒加载）
  critical: ['main', 'map', 'catch'],

  // 高优先级懒加载
  high: ['pokemon-detail', 'pokedex', 'gym'],

  // 中优先级懒加载
  medium: ['social', 'shop', 'inventory', 'settings'],

  // 低优先级懒加载
  low: ['3d-viewer', 'audio', 'chat', 'trading', 'leaderboard'],

  // 第三方库
  vendors: {
    'three': 'chunk-three',
    'chart': 'chunk-chart'
  }
};
