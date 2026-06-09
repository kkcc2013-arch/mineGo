# REQ-00052：静态资源 CDN 集成与图片优化系统

- **编号**：REQ-00052
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、gateway、infrastructure/k8s、backend/shared
- **创建时间**：2026-06-09 14:05
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 游戏客户端加载大量静态资源（精灵图片、UI素材、动画帧等），存在以下问题：

1. **加载性能差**：所有静态资源直接从服务器加载，无 CDN 加速，全球用户加载延迟高
2. **带宽成本高**：图片未压缩优化，单张精灵图片平均 200-500KB，带宽消耗大
3. **缓存策略缺失**：缺乏有效的缓存策略，用户每次访问都重新下载资源
4. **无响应式适配**：未针对不同设备和网络条件提供适配的图片尺寸

## 2. 目标

1. 静态资源 CDN 分发，全球访问延迟降低 60%+
2. 图片自动优化（WebP/AVIF 格式），体积减小 50%+
3. 智能缓存策略，重复访问加载时间降低 80%+
4. 响应式图片适配，移动端流量节省 40%+

## 3. 范围

### 包含

- CDN 服务集成（Cloudflare/阿里云 CDN）
- 图片格式自动转换（WebP/AVIF）
- 图片压缩优化（质量/尺寸）
- 响应式图片生成（多尺寸）
- 缓存策略配置（Cache-Control、ETag）
- 静态资源版本管理

### 不包含

- CDN 厂商选择（使用现有云服务）
- 图片上传管理后台（已有管理后台）

## 4. 详细需求

### 4.1 CDN 集成架构

```javascript
// backend/shared/CDNManager.js
class CDNManager {
  constructor(config) {
    this.provider = config.provider; // 'cloudflare' | 'aliyun'
    this.domain = config.domain;
    this.enabled = config.enabled !== false;
  }

  // 获取 CDN URL
  getResourceUrl(path, options = {}) {
    if (!this.enabled) return `${this.originUrl}${path}`;
    
    const { width, height, format, quality } = options;
    const params = new URLSearchParams();
    
    if (width) params.set('w', width);
    if (height) params.set('h', height);
    if (format) params.set('f', format);
    if (quality) params.set('q', quality);
    
    return `${this.domain}${path}?${params.toString()}`;
  }
  
  // 清除缓存
  async purgeCache(paths) {
    // 实现 CDN 缓存清除
  }
}
```

### 4.2 图片优化中间件

```javascript
// backend/gateway/src/middleware/imageOptimization.js
const imageOptimization = (options) => {
  return async (req, res, next) => {
    // 检测客户端支持的图片格式
    const acceptHeader = req.headers.accept || '';
    const supportsWebP = acceptHeader.includes('image/webp');
    const supportsAVIF = acceptHeader.includes('image/avif');
    
    // 设置响应头
    res.locals.imageFormat = supportsAVIF ? 'avif' : 
                              supportsWebP ? 'webp' : 'original';
    res.locals.imageQuality = req.query.q || 85;
    
    next();
  };
};
```

### 4.3 响应式图片生成

```javascript
// backend/shared/ImageProcessor.js
class ImageProcessor {
  // 预设尺寸
  static PRESETS = {
    thumbnail: { width: 64, height: 64 },
    small: { width: 128, height: 128 },
    medium: { width: 256, height: 256 },
    large: { width: 512, height: 512 },
    original: null
  };

  // 生成多尺寸图片
  async generateResponsiveImages(imagePath) {
    const results = {};
    for (const [name, size] of Object.entries(ImageProcessor.PRESETS)) {
      if (size) {
        results[name] = await this.resize(imagePath, size);
      }
    }
    return results;
  }
}
```

### 4.4 缓存策略

```javascript
// 静态资源缓存配置
const CACHE_CONFIG = {
  // 精灵图片 - 长期缓存
  pokemon_images: {
    maxAge: 31536000, // 1 年
    immutable: true,
    etag: true
  },
  // UI 素材 - 中期缓存
  ui_assets: {
    maxAge: 86400 * 30, // 30 天
    etag: true
  },
  // 动态图片 - 短期缓存
  dynamic_images: {
    maxAge: 3600, // 1 小时
    etag: true
  }
};
```

### 4.5 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/cdn/resource` | GET | 获取 CDN 资源 URL |
| `/cdn/purge` | POST | 清除 CDN 缓存 |
| `/cdn/stats` | GET | 获取 CDN 统计数据 |
| `/images/upload` | POST | 上传图片并自动优化 |
| `/images/optimize` | POST | 优化现有图片 |

### 4.6 K8s 配置

```yaml
# infrastructure/k8s/cdn-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cdn-config
data:
  CDN_ENABLED: "true"
  CDN_DOMAIN: "https://cdn.minego.example.com"
  CDN_PROVIDER: "cloudflare"
  IMAGE_QUALITY: "85"
  WEBP_ENABLED: "true"
  AVIF_ENABLED: "true"
```

## 5. 验收标准（可测试）

- [ ] CDN 集成完成，所有静态资源通过 CDN 分发
- [ ] 图片自动转换为 WebP/AVIF 格式（客户端支持时）
- [ ] 图片体积平均减小 50%+
- [ ] 响应式图片生成正常，4 种尺寸可用
- [ ] 缓存策略生效，Cache-Control 头正确设置
- [ ] ETag 和 Last-Modified 正常工作
- [ ] CDN 缓存清除 API 可用
- [ ] Prometheus 指标：CDN 请求数、缓存命中率、图片优化率
- [ ] 单元测试覆盖核心逻辑（20+ 测试用例）

## 6. 工作量估算

**L** - 需要集成 CDN 服务、图片处理、缓存策略、API 开发、测试

## 7. 优先级理由

性能优化的关键需求，直接影响用户体验和运营成本。静态资源加载是游戏客户端性能瓶颈之一，优化后可显著提升用户留存和降低带宽成本。
