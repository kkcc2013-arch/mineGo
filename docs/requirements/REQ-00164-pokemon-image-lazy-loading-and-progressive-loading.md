# REQ-00164：精灵详情页图片懒加载与渐进式加载系统

- **编号**：REQ-00164
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/components、backend/shared/CDNManager.js、gateway
- **创建时间**：2026-06-13 18:05
- **依赖需求**：REQ-00052（静态资源 CDN 集成与图片优化系统）

## 1. 背景与问题

当前精灵详情页在加载精灵列表时存在明显的性能问题：

1. **全量图片加载**：用户打开精灵列表时，所有可见和不可见精灵的图片都被同时加载，导致大量网络请求和带宽浪费
2. **首屏渲染延迟**：由于需要等待所有图片加载完成，首屏渲染时间（FCP）超过 3 秒，严重影响用户体验
3. **移动端流量消耗**：用户在移动网络下浏览精灵列表时，未优化的图片加载导致大量流量消耗
4. **内存占用过高**：同时加载大量高清精灵图片导致内存占用飙升，低端设备可能出现卡顿或崩溃

代码现状分析：
- `game-client/src/components/PokemonList.js` 直接使用 `<img src>` 加载所有图片
- 没有图片预加载策略，用户快速滚动时图片闪烁严重
- 缺少图片加载优先级控制，关键精灵图片无法优先加载
- CDN 图片没有响应式尺寸适配，移动端也加载高清大图

## 2. 目标

1. **首屏加载时间 < 1.5 秒**：通过懒加载和骨架屏优化，显著提升首屏渲染速度
2. **流量节省 60%+**：只加载用户可视区域的图片，减少不必要的网络请求
3. **渐进式加载体验**：先加载低质量占位图，再逐步加载高清图，避免闪烁
4. **智能预加载**：根据用户滚动方向预测性加载即将可见的图片
5. **响应式图片**：根据设备像素比和屏幕尺寸加载合适尺寸的图片

## 3. 范围

- **包含**：
  - 图片懒加载组件（IntersectionObserver 实现）
  - 渐进式图片加载（LQIP 技术）
  - 骨架屏占位组件
  - 图片预加载策略
  - 响应式图片 srcset 支持
  - 加载状态管理和错误处理
  - 性能监控指标上报

- **不包含**：
  - 图片压缩优化（已在 REQ-00052 实现）
  - 图片格式转换（WebP 支持已在 CDN 配置）
  - 离线图片缓存（PWA 离线支持在 REQ-00009）

## 4. 详细需求

### 4.1 懒加载组件设计

```javascript
// frontend/game-client/src/components/LazyImage.js

/**
 * 懒加载图片组件
 * - 使用 IntersectionObserver 检测元素可见性
 * - 支持渐进式加载（LQIP）
 * - 支持骨架屏占位
 * - 支持加载优先级
 */
class LazyImage {
  constructor(options) {
    this.container = options.container;
    this.src = options.src;
    this.placeholder = options.placeholder;
    this.alt = options.alt;
    this.priority = options.priority || 'normal'; // 'high' | 'normal' | 'low'
    this.rootMargin = options.rootMargin || '50px';
    this.threshold = options.threshold || 0.1;
    this.onLoad = options.onLoad;
    this.onError = options.onError;
    
    this.state = {
      loaded: false,
      error: false,
      inView: false
    };
    
    this.init();
  }
  
  init() {
    // 创建容器元素
    this.element = document.createElement('div');
    this.element.className = 'lazy-image-container';
    this.element.setAttribute('data-priority', this.priority);
    
    // 高优先级图片立即加载
    if (this.priority === 'high') {
      this.loadImage();
    } else {
      this.setupObserver();
    }
    
    this.renderPlaceholder();
  }
  
  setupObserver() {
    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersection(entries),
      {
        root: null,
        rootMargin: this.rootMargin,
        threshold: this.threshold
      }
    );
    this.observer.observe(this.element);
  }
  
  handleIntersection(entries) {
    entries.forEach(entry => {
      if (entry.isIntersecting && !this.state.loaded) {
        this.state.inView = true;
        this.loadImage();
        this.observer.unobserve(this.element);
      }
    });
  }
  
  loadImage() {
    if (this.state.loaded || this.state.loading) return;
    
    this.state.loading = true;
    
    // 先加载占位图
    const placeholderImg = new Image();
    placeholderImg.src = this.getThumbnailUrl(this.src, 20);
    placeholderImg.onload = () => {
      this.renderThumbnail(placeholderImg.src);
    };
    
    // 然后加载高清图
    const fullImg = new Image();
    fullImg.src = this.getResponsiveUrl(this.src);
    fullImg.onload = () => {
      this.state.loaded = true;
      this.state.loading = false;
      this.renderFullImage(fullImg.src);
      this.onLoad?.();
    };
    fullImg.onerror = () => {
      this.state.error = true;
      this.state.loading = false;
      this.renderError();
      this.onError?.();
    };
  }
  
  getThumbnailUrl(src, size) {
    // CDN 缩略图 URL（已在 REQ-00052 实现）
    const url = new URL(src);
    url.searchParams.set('w', size);
    url.searchParams.set('q', '30');
    url.searchParams.set('blur', '10');
    return url.toString();
  }
  
  getResponsiveUrl(src) {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(this.container.clientWidth * dpr, 800);
    const url = new URL(src);
    url.searchParams.set('w', Math.round(width));
    url.searchParams.set('q', '85');
    url.searchParams.set('format', 'webp');
    return url.toString();
  }
  
  renderPlaceholder() {
    this.element.innerHTML = `
      <div class="lazy-image-skeleton" role="img" aria-label="${this.alt}">
        <div class="skeleton-animation"></div>
      </div>
    `;
    this.container.appendChild(this.element);
  }
  
  renderThumbnail(src) {
    const img = this.element.querySelector('img') || document.createElement('img');
    img.src = src;
    img.className = 'lazy-image-thumbnail';
    img.alt = this.alt;
    img.style.filter = 'blur(10px)';
    img.style.transform = 'scale(1.1)';
    this.element.querySelector('.lazy-image-skeleton')?.replaceWith(img);
  }
  
  renderFullImage(src) {
    const img = this.element.querySelector('img');
    if (img) {
      img.src = src;
      img.className = 'lazy-image-full';
      img.style.filter = 'none';
      img.style.transform = 'scale(1)';
      img.style.transition = 'filter 0.3s ease, transform 0.3s ease';
    }
    this.element.classList.add('loaded');
  }
  
  renderError() {
    this.element.innerHTML = `
      <div class="lazy-image-error">
        <span class="error-icon">⚠️</span>
        <span class="error-text">加载失败</span>
        <button class="retry-btn" onclick="this.loadImage()">重试</button>
      </div>
    `;
  }
  
  destroy() {
    this.observer?.disconnect();
    this.element?.remove();
  }
}
```

### 4.2 精灵列表图片加载优化

```javascript
// frontend/game-client/src/components/PokemonImageManager.js

/**
 * 精灵图片加载管理器
 * - 管理所有精灵图片的懒加载
 * - 智能预加载策略
 * - 加载优先级队列
 * - 性能监控上报
 */
class PokemonImageManager {
  constructor() {
    this.imageMap = new Map(); // pokemonId -> LazyImage
    this.loadQueue = [];
    this.loadingCount = 0;
    this.maxConcurrent = 4;
    this.prefetchCount = 5;
    
    // 性能指标
    this.metrics = {
      totalImages: 0,
      loadedImages: 0,
      cachedImages: 0,
      errors: 0,
      averageLoadTime: 0
    };
    
    // 监听滚动事件
    this.setupScrollListener();
  }
  
  /**
   * 注册精灵图片
   */
  registerPokemonImage(pokemonId, options) {
    if (this.imageMap.has(pokemonId)) {
      return this.imageMap.get(pokemonId);
    }
    
    const lazyImage = new LazyImage({
      ...options,
      priority: options.isFavorite ? 'high' : 'normal',
      onLoad: () => this.handleImageLoad(pokemonId),
      onError: () => this.handleImageError(pokemonId)
    });
    
    this.imageMap.set(pokemonId, lazyImage);
    this.metrics.totalImages++;
    
    return lazyImage;
  }
  
  /**
   * 批量注册精灵图片（用于列表渲染）
   */
  registerBatch(pokemonList, containerSelector) {
    const container = document.querySelector(containerSelector);
    if (!container) return;
    
    pokemonList.forEach((pokemon, index) => {
      const itemContainer = container.children[index];
      if (!itemContainer) return;
      
      const imgContainer = itemContainer.querySelector('.pokemon-image-container');
      if (imgContainer) {
        this.registerPokemonImage(pokemon.id, {
          container: imgContainer,
          src: pokemon.spriteUrl,
          placeholder: pokemon.thumbnailUrl,
          alt: pokemon.name,
          isFavorite: pokemon.isFavorite
        });
      }
    });
    
    // 预加载前 3 个精灵图片
    this.prefetchFirst(pokemonList.slice(0, 3));
  }
  
  /**
   * 预加载首批可见图片
   */
  prefetchFirst(pokemonList) {
    pokemonList.forEach(pokemon => {
      const lazyImage = this.imageMap.get(pokemon.id);
      if (lazyImage && lazyImage.priority === 'high') {
        lazyImage.loadImage();
      }
    });
  }
  
  /**
   * 智能预加载（根据滚动方向）
   */
  setupScrollListener() {
    let lastScrollTop = 0;
    let scrollDirection = 'down';
    
    const scrollHandler = this.debounce(() => {
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      scrollDirection = scrollTop > lastScrollTop ? 'down' : 'up';
      lastScrollTop = scrollTop;
      
      this.prefetchInDirection(scrollDirection);
    }, 100);
    
    window.addEventListener('scroll', scrollHandler, { passive: true });
  }
  
  /**
   * 根据滚动方向预加载
   */
  prefetchInDirection(direction) {
    const viewportHeight = window.innerHeight;
    const prefetchDistance = viewportHeight * 0.5;
    
    this.imageMap.forEach((lazyImage, pokemonId) => {
      if (lazyImage.state.loaded || lazyImage.state.loading) return;
      
      const rect = lazyImage.element.getBoundingClientRect();
      const distanceFromViewport = direction === 'down'
        ? rect.top - viewportHeight
        : -rect.bottom;
      
      if (distanceFromViewport > 0 && distanceFromViewport < prefetchDistance) {
        this.addToQueue(lazyImage, 'low');
      }
    });
    
    this.processQueue();
  }
  
  /**
   * 添加到加载队列
   */
  addToQueue(lazyImage, priority = 'normal') {
    const priorityWeight = { high: 0, normal: 1, low: 2 };
    this.loadQueue.push({
      image: lazyImage,
      priority,
      weight: priorityWeight[priority]
    });
    this.loadQueue.sort((a, b) => a.weight - b.weight);
  }
  
  /**
   * 处理加载队列
   */
  processQueue() {
    while (this.loadingCount < this.maxConcurrent && this.loadQueue.length > 0) {
      const item = this.loadQueue.shift();
      if (!item.image.state.loaded && !item.image.state.loading) {
        this.loadingCount++;
        item.image.loadImage();
      }
    }
  }
  
  /**
   * 处理图片加载完成
   */
  handleImageLoad(pokemonId) {
    this.loadingCount--;
    this.metrics.loadedImages++;
    
    // 上报性能指标
    this.reportMetrics(pokemonId, 'load');
    
    // 继续处理队列
    this.processQueue();
  }
  
  /**
   * 处理图片加载错误
   */
  handleImageError(pokemonId) {
    this.loadingCount--;
    this.metrics.errors++;
    
    this.reportMetrics(pokemonId, 'error');
    
    this.processQueue();
  }
  
  /**
   * 上报性能指标
   */
  reportMetrics(pokemonId, event) {
    const timing = performance.getEntriesByName(`pokemon-image-${pokemonId}`);
    
    if (event === 'load') {
      // 发送到后端
      fetch('/api/metrics/image-load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pokemonId,
          loadTime: timing[0]?.duration || 0,
          cached: timing[0]?.transferSize === 0,
          timestamp: Date.now()
        })
      }).catch(() => {}); // 静默失败
    }
  }
  
  /**
   * 防抖函数
   */
  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.metrics,
      loadRate: this.metrics.totalImages > 0 
        ? (this.metrics.loadedImages / this.metrics.totalImages * 100).toFixed(2) + '%'
        : '0%',
      queueLength: this.loadQueue.length,
      concurrentLoads: this.loadingCount
    };
  }
  
  /**
   * 清理所有图片
   */
  destroy() {
    this.imageMap.forEach(img => img.destroy());
    this.imageMap.clear();
    this.loadQueue = [];
    this.loadingCount = 0;
  }
}

// 导出单例
module.exports = new PokemonImageManager();
```

### 4.3 骨架屏组件

```css
/* frontend/game-client/src/styles/lazy-image.css */

.lazy-image-container {
  position: relative;
  overflow: hidden;
  background-color: var(--color-skeleton-bg, #f0f0f0);
  border-radius: 8px;
}

.lazy-image-skeleton {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.skeleton-animation {
  width: 60%;
  height: 60%;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.1) 0%,
    rgba(255, 255, 255, 0.3) 50%,
    rgba(255, 255, 255, 0.1) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  border-radius: 50%;
}

@keyframes skeleton-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.lazy-image-thumbnail,
.lazy-image-full {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.lazy-image-thumbnail {
  opacity: 1;
}

.lazy-image-full {
  position: absolute;
  top: 0;
  left: 0;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.lazy-image-container.loaded .lazy-image-full {
  opacity: 1;
}

.lazy-image-container.loaded .lazy-image-thumbnail {
  opacity: 0;
}

.lazy-image-error {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--color-error, #ff4444);
  gap: 8px;
}

.lazy-image-error .error-icon {
  font-size: 32px;
}

.lazy-image-error .retry-btn {
  padding: 4px 12px;
  background: var(--color-primary, #0066cc);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

/* 高优先级图片样式 */
.lazy-image-container[data-priority="high"] {
  background-color: var(--color-skeleton-bg-highlight, #e8f4ff);
}

/* 精灵列表项样式 */
.pokemon-list-item .pokemon-image-container {
  width: 96px;
  height: 96px;
  flex-shrink: 0;
}

/* 详情页大图样式 */
.pokemon-detail .pokemon-image-container {
  width: 200px;
  height: 200px;
  margin: 0 auto;
}
```

### 4.4 后端图片加载统计 API

```javascript
// backend/gateway/src/routes/imageMetrics.js

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('image-metrics');

/**
 * 图片加载统计上报
 */
router.post('/api/metrics/image-load', async (req, res) => {
  try {
    const { pokemonId, loadTime, cached, timestamp } = req.body;
    const userId = req.user?.sub;
    
    // 记录到数据库
    await query(`
      INSERT INTO image_load_metrics 
      (pokemon_id, user_id, load_time_ms, was_cached, created_at)
      VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
    `, [pokemonId, userId, loadTime, cached, timestamp]);
    
    // 更新 Prometheus 指标
    metrics.histogram('image_load_time_ms', loadTime, {
      pokemon_id: pokemonId.toString(),
      cached: cached.toString()
    });
    
    metrics.increment('image_loads_total', 1, {
      cached: cached.toString()
    });
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to record image metrics');
    res.status(500).json({ error: 'Failed to record metrics' });
  }
});

/**
 * 获取图片加载统计
 */
router.get('/api/metrics/image-stats', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    const periodHours = {
      '1h': 1,
      '24h': 24,
      '7d': 168,
      '30d': 720
    };
    
    const hours = periodHours[period] || 24;
    
    const { rows } = await query(`
      SELECT 
        COUNT(*) as total_loads,
        AVG(load_time_ms) as avg_load_time,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
        SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count,
        COUNT(DISTINCT pokemon_id) as unique_pokemon
      FROM image_load_metrics
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
    `);
    
    res.json({
      success: true,
      data: {
        period,
        ...rows[0],
        cacheHitRate: rows[0].total_loads > 0 
          ? (rows[0].cached_count / rows[0].total_loads * 100).toFixed(2) + '%'
          : '0%'
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get image stats');
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
```

### 4.5 数据库迁移

```sql
-- database/pending/20260613_180000__add_image_load_metrics.sql

-- 图片加载指标表
CREATE TABLE image_load_metrics (
    id SERIAL PRIMARY KEY,
    pokemon_id INTEGER NOT NULL,
    user_id VARCHAR(64),
    load_time_ms INTEGER NOT NULL,
    was_cached BOOLEAN NOT NULL DEFAULT false,
    device_type VARCHAR(20),
    connection_type VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_image_metrics_created ON image_load_metrics(created_at DESC);
CREATE INDEX idx_image_metrics_pokemon ON image_load_metrics(pokemon_id);
CREATE INDEX idx_image_metrics_user ON image_load_metrics(user_id);

-- 分区（按月）
CREATE TABLE image_load_metrics_y2026m06 PARTITION OF image_load_metrics
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE image_load_metrics_y2026m07 PARTITION OF image_load_metrics
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- 清理策略（保留 90 天）
CREATE OR REPLACE FUNCTION cleanup_image_metrics()
RETURNS void AS $$
BEGIN
    DELETE FROM image_load_metrics WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- 定时清理（每天凌晨 3 点执行）
-- 需要配合 pg_cron 扩展
-- SELECT cron.schedule('cleanup_image_metrics', '0 3 * * *', 'SELECT cleanup_image_metrics()');

-- 统计视图
CREATE VIEW image_load_stats_daily AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_loads,
    AVG(load_time_ms) as avg_load_time,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
    SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count,
    COUNT(DISTINCT pokemon_id) as unique_pokemon,
    COUNT(DISTINCT user_id) as unique_users
FROM image_load_metrics
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

## 5. 验收标准（可测试）

- [ ] 首屏精灵列表加载时间 < 1.5 秒（测试 50 个精灵列表）
- [ ] 可视区域外图片不发起网络请求（开发者工具 Network 面板验证）
- [ ] 渐进式加载效果正常：先显示模糊缩略图，再显示清晰大图
- [ ] 滚动时智能预加载正常工作，向上/向下滚动都能预加载
- [ ] 收藏精灵图片优先加载（高优先级标记生效）
- [ ] 图片加载错误时显示重试按钮，点击可重新加载
- [ ] 响应式图片 URL 正确生成（根据 DPR 和容器宽度）
- [ ] 性能指标正确上报到后端（数据库有记录）
- [ ] 移动端流量节省 > 60%（对比优化前后 Network 传输大小）
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现前端懒加载组件、骨架屏、预加载策略
- 需要修改精灵列表和详情页组件
- 需要新增后端 API 和数据库表
- 需要编写完整测试用例
- 预计 2-3 天完成

## 7. 优先级理由

**P1 理由**：

1. **用户体验关键路径**：精灵列表是用户最频繁访问的页面，加载性能直接影响用户体验
2. **移动端体验优化**：大量用户使用移动网络，图片懒加载可显著节省流量
3. **性能指标改进**：首屏加载时间是核心性能指标，对应用商店评分和用户留存有直接影响
4. **技术债务**：当前图片加载未优化，是性能优化的高价值目标
5. **依赖已就绪**：REQ-00052 已实现 CDN 和图片优化，本需求可在此基础上快速推进

## 8. 相关需求

- REQ-00052：静态资源 CDN 集成与图片优化系统（已完成）
- REQ-00009：PWA 离线支持与 Service Worker 缓存策略（已完成）
- REQ-00110：前端资源懒加载与代码分割系统（new）
