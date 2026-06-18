// frontend/game-client/src/components/LazyImage.js
// 图片懒加载与渐进式加载组件
'use strict';

/**
 * 懒加载图片组件
 * - 使用 IntersectionObserver 检测元素可见性
 * - 支持渐进式加载（LQIP - Low Quality Image Placeholder）
 * - 支持骨架屏占位
 * - 支持加载优先级
 * - 支持响应式图片
 */
class LazyImage {
  static observerPool = new Map();
  static loadingCount = 0;
  static maxConcurrent = 6;
  static loadQueue = [];
  
  constructor(options) {
    this.container = options.container;
    this.src = options.src;
    this.placeholder = options.placeholder;
    this.alt = options.alt || '';
    this.priority = options.priority || 'normal'; // 'high' | 'normal' | 'low'
    this.rootMargin = options.rootMargin || '100px 50px';
    this.threshold = options.threshold || 0.01;
    this.fadeDuration = options.fadeDuration || 300;
    this.onLoad = options.onLoad;
    this.onError = options.onError;
    this.onProgress = options.onProgress;
    
    this.state = {
      loaded: false,
      error: false,
      loading: false,
      inView: false,
      loadStartTime: 0
    };
    
    this.element = null;
    this.observer = null;
    
    this.init();
  }
  
  init() {
    // 创建容器元素
    this.element = document.createElement('div');
    this.element.className = 'lazy-image-container';
    this.element.setAttribute('data-priority', this.priority);
    this.element.setAttribute('data-state', 'pending');
    
    // 渲染骨架屏占位
    this.renderPlaceholder();
    
    // 添加到容器
    if (this.container instanceof Element) {
      this.container.appendChild(this.element);
    } else if (typeof this.container === 'string') {
      document.querySelector(this.container)?.appendChild(this.element);
    }
    
    // 高优先级图片立即加载
    if (this.priority === 'high') {
      this.loadImage();
    } else {
      this.setupObserver();
    }
  }
  
  setupObserver() {
    // 复用 IntersectionObserver 实例
    const observerKey = `${this.rootMargin}-${this.threshold}`;
    
    if (!LazyImage.observerPool.has(observerKey)) {
      const observer = new IntersectionObserver(
        (entries) => this.handleIntersection(entries),
        {
          root: null,
          rootMargin: this.rootMargin,
          threshold: [this.threshold]
        }
      );
      LazyImage.observerPool.set(observerKey, observer);
    }
    
    this.observer = LazyImage.observerPool.get(observerKey);
    this.observer.observe(this.element);
  }
  
  handleIntersection(entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting && !this.state.loaded && !this.state.loading) {
        this.state.inView = true;
        this.element.setAttribute('data-state', 'in-view');
        
        // 加入加载队列
        this.queueLoad();
        
        // 停止观察
        if (this.observer) {
          this.observer.unobserve(this.element);
        }
      }
    });
  }
  
  queueLoad() {
    const priorityWeight = { high: 0, normal: 1, low: 2 };
    
    LazyImage.loadQueue.push({
      image: this,
      weight: priorityWeight[this.priority] || 1
    });
    
    // 按优先级排序
    LazyImage.loadQueue.sort((a, b) => a.weight - b.weight);
    
    // 处理队列
    this.processQueue();
  }
  
  processQueue() {
    while (
      LazyImage.loadingCount < LazyImage.maxConcurrent &&
      LazyImage.loadQueue.length > 0
    ) {
      const item = LazyImage.loadQueue.shift();
      if (!item.image.state.loaded && !item.image.state.loading) {
        item.image.loadImage();
      }
    }
  }
  
  loadImage() {
    if (this.state.loaded || this.state.loading) return;
    
    this.state.loading = true;
    this.state.loadStartTime = performance.now();
    this.element.setAttribute('data-state', 'loading');
    LazyImage.loadingCount++;
    
    // 渐进式加载：先加载缩略图
    const thumbnailUrl = this.getThumbnailUrl(this.src);
    
    const thumbnailImg = new Image();
    thumbnailImg.src = thumbnailUrl;
    
    thumbnailImg.onload = () => {
      this.renderThumbnail(thumbnailImg.src);
      this.onProgress?.(0.5);
      
      // 然后加载高清图
      this.loadFullImage();
    };
    
    thumbnailImg.onerror = () => {
      // 缩略图加载失败，直接加载原图
      this.loadFullImage();
    };
  }
  
  loadFullImage() {
    const fullImg = new Image();
    fullImg.src = this.getResponsiveUrl(this.src);
    
    fullImg.onload = () => {
      this.state.loaded = true;
      this.state.loading = false;
      LazyImage.loadingCount--;
      
      const loadTime = performance.now() - this.state.loadStartTime;
      
      this.renderFullImage(fullImg.src);
      this.onProgress?.(1);
      this.onLoad?.(loadTime);
      
      // 继续处理队列
      this.processQueue();
    };
    
    fullImg.onerror = () => {
      this.state.error = true;
      this.state.loading = false;
      LazyImage.loadingCount--;
      
      this.renderError();
      this.onError?.(new Error('Image load failed'));
      
      // 继续处理队列
      this.processQueue();
    };
  }
  
  getThumbnailUrl(src) {
    if (!src) return src;
    
    try {
      const url = new URL(src, window.location.origin);
      // CDN 缩略图参数（20px 宽度，低质量，模糊效果）
      url.searchParams.set('w', '20');
      url.searchParams.set('q', '30');
      url.searchParams.set('blur', '10');
      url.searchParams.set('auto', 'format');
      return url.toString();
    } catch (e) {
      return src;
    }
  }
  
  getResponsiveUrl(src) {
    if (!src) return src;
    
    try {
      const url = new URL(src, window.location.origin);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const containerWidth = this.element?.clientWidth || 200;
      const width = Math.min(Math.round(containerWidth * dpr), 800);
      
      // 响应式图片参数
      url.searchParams.set('w', width.toString());
      url.searchParams.set('q', '85');
      url.searchParams.set('auto', 'format');
      
      return url.toString();
    } catch (e) {
      return src;
    }
  }
  
  renderPlaceholder() {
    this.element.innerHTML = `
      <div class="lazy-image-skeleton" role="img" aria-label="${this.escapeHtml(this.alt)}">
        <div class="skeleton-animation"></div>
      </div>
    `;
  }
  
  renderThumbnail(src) {
    const existingImg = this.element.querySelector('img');
    
    if (existingImg) {
      existingImg.src = src;
    } else {
      const img = document.createElement('img');
      img.src = src;
      img.className = 'lazy-image-thumbnail';
      img.alt = this.alt;
      img.loading = 'eager';
      img.decoding = 'async';
      
      const skeleton = this.element.querySelector('.lazy-image-skeleton');
      if (skeleton) {
        skeleton.replaceWith(img);
      } else {
        this.element.appendChild(img);
      }
    }
    
    this.element.setAttribute('data-state', 'thumbnail');
  }
  
  renderFullImage(src) {
    const container = document.createElement('div');
    container.className = 'lazy-image-full-container';
    
    const img = document.createElement('img');
    img.src = src;
    img.className = 'lazy-image-full';
    img.alt = this.alt;
    img.loading = 'eager';
    img.decoding = 'async';
    
    container.appendChild(img);
    
    // 添加淡入效果
    container.style.opacity = '0';
    this.element.appendChild(container);
    
    // 触发重排后应用透明度变化
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.style.transition = `opacity ${this.fadeDuration}ms ease`;
        container.style.opacity = '1';
        
        // 移除缩略图
        setTimeout(() => {
          const thumbnail = this.element.querySelector('.lazy-image-thumbnail');
          if (thumbnail) {
            thumbnail.style.opacity = '0';
            setTimeout(() => thumbnail.remove(), this.fadeDuration);
          }
        }, this.fadeDuration);
      });
    });
    
    this.element.classList.add('loaded');
    this.element.setAttribute('data-state', 'loaded');
  }
  
  renderError() {
    this.element.innerHTML = `
      <div class="lazy-image-error" role="alert">
        <span class="error-icon" aria-hidden="true">⚠️</span>
        <span class="error-text">加载失败</span>
        <button class="retry-btn" type="button" aria-label="重新加载图片">重试</button>
      </div>
    `;
    
    this.element.classList.add('error');
    this.element.setAttribute('data-state', 'error');
    
    // 绑定重试按钮
    const retryBtn = this.element.querySelector('.retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        this.state.error = false;
        this.state.loaded = false;
        this.state.loading = false;
        this.renderPlaceholder();
        this.loadImage();
      });
    }
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * 强制加载（跳过懒加载）
   */
  forceLoad() {
    if (!this.state.loaded && !this.state.loading) {
      this.loadImage();
    }
  }
  
  /**
   * 更新图片源
   */
  updateSrc(newSrc) {
    if (this.src === newSrc) return;
    
    this.src = newSrc;
    this.state.loaded = false;
    this.state.loading = false;
    this.state.error = false;
    
    this.renderPlaceholder();
    
    if (this.priority === 'high' || this.state.inView) {
      this.loadImage();
    }
  }
  
  /**
   * 销毁组件
   */
  destroy() {
    if (this.observer) {
      this.observer.unobserve(this.element);
    }
    
    if (this.element) {
      this.element.remove();
    }
    
    // 从队列中移除
    const queueIndex = LazyImage.loadQueue.findIndex(item => item.image === this);
    if (queueIndex > -1) {
      LazyImage.loadQueue.splice(queueIndex, 1);
    }
    
    if (this.state.loading) {
      LazyImage.loadingCount--;
    }
  }
  
  /**
   * 获取加载状态
   */
  getState() {
    return { ...this.state };
  }
}

/**
 * 精灵图片加载管理器
 * - 管理所有精灵图片的懒加载
 * - 智能预加载策略
 * - 性能监控上报
 */
class PokemonImageManager {
  static instance = null;
  
  constructor() {
    this.imageMap = new Map(); // pokemonId -> LazyImage
    this.metrics = {
      totalImages: 0,
      loadedImages: 0,
      cachedImages: 0,
      errors: 0,
      totalLoadTime: 0
    };
    
    this.lastScrollTop = 0;
    this.scrollDirection = 'down';
    this.prefetchDistance = 500;
    
    this.setupScrollListener();
    this.setupVisibilityListener();
  }
  
  static getInstance() {
    if (!PokemonImageManager.instance) {
      PokemonImageManager.instance = new PokemonImageManager();
    }
    return PokemonImageManager.instance;
  }
  
  setupScrollListener() {
    let scrollTimer = null;
    
    const handleScroll = () => {
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      this.scrollDirection = scrollTop > this.lastScrollTop ? 'down' : 'up';
      this.lastScrollTop = scrollTop;
      
      // 防抖预加载
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        this.prefetchInDirection();
      }, 150);
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
  }
  
  setupVisibilityListener() {
    // 页面可见性变化时暂停/恢复加载
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // 页面隐藏时，降低并发数
        LazyImage.maxConcurrent = 2;
      } else {
        // 页面可见时，恢复正常并发
        LazyImage.maxConcurrent = 6;
        LazyImage.loadQueue.length > 0 && this.processQueue();
      }
    });
  }
  
  /**
   * 注册精灵图片
   */
  register(pokemonId, options) {
    if (this.imageMap.has(pokemonId)) {
      return this.imageMap.get(pokemonId);
    }
    
    const lazyImage = new LazyImage({
      ...options,
      priority: options.isFavorite ? 'high' : 'normal',
      onLoad: (loadTime) => {
        this.handleImageLoad(pokemonId, loadTime);
        options.onLoad?.(loadTime);
      },
      onError: (error) => {
        this.handleImageError(pokemonId);
        options.onError?.(error);
      }
    });
    
    this.imageMap.set(pokemonId, lazyImage);
    this.metrics.totalImages++;
    
    return lazyImage;
  }
  
  /**
   * 批量注册精灵图片
   */
  registerBatch(pokemonList, containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return [];
    
    const images = [];
    
    pokemonList.forEach((pokemon, index) => {
      const itemContainer = container.children[index];
      if (!itemContainer) return;
      
      const imgContainer = itemContainer.querySelector('.pokemon-image-container');
      if (imgContainer) {
        const lazyImage = this.register(pokemon.id, {
          container: imgContainer,
          src: pokemon.spriteUrl || pokemon.imageUrl,
          placeholder: pokemon.thumbnailUrl,
          alt: pokemon.name || `Pokemon ${pokemon.id}`,
          isFavorite: pokemon.isFavorite
        });
        
        images.push(lazyImage);
      }
    });
    
    // 预加载前 3 个（高优先级）
    pokemonList.slice(0, 3).forEach(pokemon => {
      const lazyImage = this.imageMap.get(pokemon.id);
      if (lazyImage && lazyImage.priority === 'high') {
        lazyImage.forceLoad();
      }
    });
    
    return images;
  }
  
  /**
   * 根据滚动方向预加载
   */
  prefetchInDirection() {
    const viewportHeight = window.innerHeight;
    const prefetchDistance = viewportHeight * 0.5;
    
    this.imageMap.forEach((lazyImage, pokemonId) => {
      if (lazyImage.state.loaded || lazyImage.state.loading) return;
      
      const rect = lazyImage.element?.getBoundingClientRect();
      if (!rect) return;
      
      const distanceFromViewport = this.scrollDirection === 'down'
        ? rect.top - viewportHeight
        : -rect.bottom;
      
      if (distanceFromViewport > 0 && distanceFromViewport < prefetchDistance) {
        lazyImage.queueLoad();
      }
    });
  }
  
  /**
   * 处理图片加载完成
   */
  handleImageLoad(pokemonId, loadTime) {
    this.metrics.loadedImages++;
    this.metrics.totalLoadTime += loadTime;
    
    // 检测是否缓存命中
    const entries = performance.getEntriesByName(`pokemon-image-${pokemonId}`, 'resource');
    if (entries.length > 0 && entries[0].transferSize === 0) {
      this.metrics.cachedImages++;
    }
    
    // 上报性能指标
    this.reportMetrics(pokemonId, loadTime);
  }
  
  /**
   * 处理图片加载错误
   */
  handleImageError(pokemonId) {
    this.metrics.errors++;
  }
  
  /**
   * 上报性能指标
   */
  async reportMetrics(pokemonId, loadTime) {
    try {
      const cached = performance.getEntriesByName(`pokemon-image-${pokemonId}`, 'resource')
        .some(entry => entry.transferSize === 0);
      
      await fetch('/api/metrics/image-load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pokemonId,
          loadTime: Math.round(loadTime),
          cached,
          timestamp: Date.now(),
          userAgent: navigator.userAgent,
          connection: navigator.connection?.effectiveType
        }),
        keepalive: true
      });
    } catch (e) {
      // 静默失败
    }
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.metrics,
      loadRate: this.metrics.totalImages > 0
        ? ((this.metrics.loadedImages / this.metrics.totalImages) * 100).toFixed(2) + '%'
        : '0%',
      cacheHitRate: this.metrics.loadedImages > 0
        ? ((this.metrics.cachedImages / this.metrics.loadedImages) * 100).toFixed(2) + '%'
        : '0%',
      avgLoadTime: this.metrics.loadedImages > 0
        ? Math.round(this.metrics.totalLoadTime / this.metrics.loadedImages) + 'ms'
        : '0ms',
      queueLength: LazyImage.loadQueue.length,
      concurrentLoads: LazyImage.loadingCount
    };
  }
  
  /**
   * 清理所有图片
   */
  destroy() {
    this.imageMap.forEach(img => img.destroy());
    this.imageMap.clear();
    this.metrics = {
      totalImages: 0,
      loadedImages: 0,
      cachedImages: 0,
      errors: 0,
      totalLoadTime: 0
    };
  }
}

// 导出
export { LazyImage, PokemonImageManager };
export default PokemonImageManager.getInstance();
