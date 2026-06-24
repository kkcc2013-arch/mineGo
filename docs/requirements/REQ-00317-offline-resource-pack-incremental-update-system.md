# REQ-00317：游戏客户端离线资源包与增量更新系统

- **编号**：REQ-00317
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、gateway、location-service、pokemon-service、cdn、backend/shared/cache
- **创建时间**：2026-06-24 08:00 UTC
- **依赖需求**：无

## 1. 背景与问题

### 当前痛点
1. **弱网环境体验差**：玩家在网络不稳定时（地铁、电梯、偏远地区）经常遇到资源加载失败、白屏等待、游戏卡顿等问题
2. **重复下载浪费流量**：精灵图片、音效、UI 组件等静态资源每次都要重新请求，消耗玩家流量和 CDN 成本
3. **首次启动慢**：新玩家首次打开游戏需要下载大量资源，加载时间过长影响留存率
4. **更新体验差**：每次版本更新都需要重新下载完整资源包，更新时间长、流量消耗大

### 代码现状
- Service Worker 已实现基本的离线缓存（PWA 支持）
- 前端已有 `LazyImage` 组件支持图片懒加载
- CDN 管理模块 `CDNManager.js` 已实现基础资源分发
- 但缺少系统化的离线资源包管理和增量更新机制

## 2. 目标

建立完整的离线资源包管理与增量更新系统，实现：
1. **智能预加载**：根据玩家位置、等级、活跃度预测可能需要的资源，提前下载
2. **增量更新**：只下载变化的资源文件，减少 70%+ 的更新流量
3. **离线可用**：核心游戏功能在离线状态下仍可正常使用
4. **版本回滚**：支持快速回滚到稳定版本，降低更新风险

## 3. 范围

### 包含
- 离线资源包清单管理系统
- 增量差异计算与打包工具
- 客户端资源包下载、解压、验证模块
- Service Worker 智能缓存策略升级
- 资源包版本管理与回滚机制
- 后台静默更新与热修复支持
- 资源使用统计与清理策略

### 不包含
- 游戏逻辑代码的热更新（需要严格审核）
- 动态配置的实时推送（已有配置中心）
- 用户生成内容（UGC）的缓存管理

## 4. 详细需求

### 4.1 资源包清单系统

```javascript
// backend/shared/resourcePack/manifest.js
{
  "version": "1.2.3",
  "buildId": "build_202606240800",
  "releasedAt": "2026-06-24T08:00:00Z",
  "packages": {
    "core": {
      "name": "核心资源包",
      "size": 15728640, // ~15MB
      "hash": "sha256:abc123...",
      "required": true,
      "files": ["index.html", "app.js", "styles.css", "fonts/*"]
    },
    "pokemon-gen1": {
      "name": "第一世代精灵资源",
      "size": 52428800, // ~50MB
      "hash": "sha256:def456...",
      "priority": "high",
      "files": ["sprites/gen1/*", "sounds/pokemon/gen1/*"]
    },
    "pokemon-gen2": {
      "name": "第二世代精灵资源",
      "size": 41943040,
      "hash": "sha256:ghi789...",
      "priority": "medium",
      "trigger": "pokemon-discovered:gen2"
    }
  },
  "delta": {
    "1.2.2->1.2.3": {
      "size": 1048576, // ~1MB
      "hash": "sha256:jkl012...",
      "added": ["sprites/new-pokemon-xyz.png"],
      "modified": ["app.js", "styles.css"],
      "removed": ["deprecated-old.js"]
    }
  }
}
```

### 4.2 增量更新算法

```javascript
// tools/resource-pack/delta-generator.js
class ResourceDeltaGenerator {
  /**
   * 生成两个版本间的差异包
   * 使用 rsync 算法的 rolling hash 实现高效差异计算
   */
  async generateDelta(fromVersion, toVersion) {
    // 1. 比较文件列表
    const added = await this.findAddedFiles(fromVersion, toVersion);
    const removed = await this.findRemovedFiles(fromVersion, toVersion);
    const modified = await this.findModifiedFiles(fromVersion, toVersion);
    
    // 2. 对修改的文件进行二进制差异计算
    const patches = await Promise.all(
      modified.map(file => this.generateBinaryPatch(file, fromVersion, toVersion))
    );
    
    // 3. 打包增量更新
    const deltaPackage = await this.packDelta({
      version: toVersion,
      added,
      patches,
      removed
    });
    
    return deltaPackage;
  }
  
  /**
   * 二进制差异计算（bsdiff 算法）
   */
  async generateBinaryPatch(file, fromVersion, toVersion) {
    const oldData = await this.readFile(file, fromVersion);
    const newData = await this.readFile(file, toVersion);
    
    // 使用 bsdiff 算法生成补丁
    return bsdiff.diff(oldData, newData);
  }
}
```

### 4.3 客户端资源管理器

```javascript
// frontend/game-client/src/resourcePack/ResourceManager.js
class ResourceManager {
  constructor() {
    this.cacheVersion = 'v1';
    this.maxCacheSize = 200 * 1024 * 1024; // 200MB
    this.packages = new Map();
    this.downloadQueue = [];
  }
  
  /**
   * 初始化资源管理器
   */
  async init() {
    // 1. 检查本地资源版本
    const localVersion = await this.getLocalVersion();
    
    // 2. 获取最新清单
    const manifest = await this.fetchManifest();
    
    // 3. 比较版本，决定更新策略
    if (this.compareVersions(localVersion, manifest.version) < 0) {
      await this.updatePackages(localVersion, manifest);
    }
    
    // 4. 预加载高优先级资源
    await this.preloadPackages(manifest.packages);
    
    // 5. 注册 Service Worker 更新策略
    this.registerServiceWorkerHooks();
  }
  
  /**
   * 智能更新策略
   */
  async updatePackages(fromVersion, manifest) {
    // 优先尝试增量更新
    const delta = manifest.delta[`${fromVersion}->${manifest.version}`];
    
    if (delta && delta.size < 5 * 1024 * 1024) {
      // 增量包小于 5MB，使用增量更新
      await this.applyDelta(delta);
    } else {
      // 增量包太大或不存在，完整下载核心包
      await this.downloadPackage(manifest.packages.core);
    }
  }
  
  /**
   * 应用增量更新
   */
  async applyDelta(delta) {
    // 1. 下载差异包
    const deltaData = await this.download(delta.url, {
      onProgress: (loaded, total) => {
        this.emit('update-progress', { loaded, total, stage: 'download' });
      }
    });
    
    // 2. 验证完整性
    if (!await this.verifyHash(deltaData, delta.hash)) {
      throw new Error('Delta package corrupted');
    }
    
    // 3. 应用补丁
    await this.applyPatches(deltaData);
    
    // 4. 添加新文件
    await this.addFiles(delta.added);
    
    // 5. 删除废弃文件
    await this.removeFiles(delta.removed);
    
    // 6. 更新本地版本号
    await this.updateLocalVersion(delta.version);
  }
  
  /**
   * 预加载资源包
   */
  async preloadPackages(packages) {
    const priority = { required: 0, high: 1, medium: 2, low: 3 };
    
    const sorted = Object.entries(packages)
      .sort((a, b) => priority[a[1].priority || 'medium'] - priority[b[1].priority || 'medium']);
    
    for (const [name, pack] of sorted) {
      if (!await this.hasPackage(name)) {
        // 后台静默下载
        this.downloadPackageInBackground(name, pack);
      }
    }
  }
  
  /**
   * 触发式下载
   */
  async ensureResource(resourcePath) {
    const packageName = this.findPackageForResource(resourcePath);
    
    if (!await this.hasPackage(packageName)) {
      await this.downloadPackage(packageName, { priority: 'high' });
    }
    
    return this.getResourceUrl(resourcePath);
  }
}
```

### 4.4 Service Worker 智能缓存

```javascript
// frontend/game-client/sw.js
class SmartCacheStrategy {
  constructor() {
    this.strategies = {
      // 核心资源：Cache First，长期缓存
      core: new CacheFirstStrategy({ maxAge: 30 * 24 * 60 * 60 * 1000 }),
      
      // 精灵图片：Stale While Revalidate
      sprites: new StaleWhileRevalidateStrategy({ maxAge: 7 * 24 * 60 * 60 * 1000 }),
      
      // 音效：Cache First，按需加载
      sounds: new CacheFirstStrategy({ maxAge: 14 * 24 * 60 * 60 * 1000 }),
      
      // API 响应：Network First，短时缓存
      api: new NetworkFirstStrategy({ maxAge: 5 * 60 * 1000 })
    };
  }
  
  async handleRequest(request) {
    const url = new URL(request.url);
    const category = this.categorizeResource(url.pathname);
    const strategy = this.strategies[category];
    
    return strategy.handle(request);
  }
  
  categorizeResource(pathname) {
    if (pathname.match(/\.(html|js|css)$/)) return 'core';
    if (pathname.includes('/sprites/')) return 'sprites';
    if (pathname.match(/\.(mp3|ogg|wav)$/)) return 'sounds';
    if (pathname.startsWith('/api/')) return 'api';
    return 'core';
  }
}
```

### 4.5 后台更新与热修复

```javascript
// backend/shared/resourcePack/hotfix.js
class HotfixManager {
  /**
   * 发布热修复补丁
   */
  async publishHotfix(hotfix) {
    // 1. 验证补丁完整性
    await this.validateHotfix(hotfix);
    
    // 2. 生成增量包
    const delta = await this.generateDelta(hotfix.baseVersion, hotfix.targetVersion);
    
    // 3. 推送到 CDN
    await this.pushToCDN(delta);
    
    // 4. 通知客户端（通过 WebSocket）
    await this.notifyClients({
      type: 'hotfix-available',
      version: hotfix.targetVersion,
      critical: hotfix.critical,
      size: delta.size
    });
    
    // 5. 记录发布日志
    await this.logRelease(hotfix);
  }
  
  /**
   * 灰度发布
   */
  async canaryRelease(release, percentage = 5) {
    const canaryConfig = {
      version: release.version,
      percentage,
      criteria: {
        userLevel: release.targetLevel || null,
        region: release.targetRegion || null,
        deviceId: release.targetDevices || null
      }
    };
    
    await this.setCanaryConfig(canaryConfig);
    await this.monitorCanaryMetrics(release.version);
  }
}
```

### 4.6 资源清理策略

```javascript
// frontend/game-client/src/resourcePack/CacheCleaner.js
class CacheCleaner {
  /**
   * 智能清理缓存
   */
  async cleanup() {
    const stats = await this.getCacheStats();
    
    if (stats.totalSize > this.maxSize) {
      // 1. 清理过期资源
      await this.removeExpiredResources();
      
      // 2. 清理未使用资源（LRU）
      const unused = await this.findUnusedResources(stats.usageLog);
      await this.removeResources(unused);
      
      // 3. 压缩资源包
      await this.compactPackages();
    }
    
    return this.getCacheStats();
  }
  
  /**
   * 获取缓存统计
   */
  async getCacheStats() {
    const caches = await caches.keys();
    let totalSize = 0;
    const usageLog = [];
    
    for (const cacheName of caches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      
      for (const request of keys) {
        const response = await cache.match(request);
        const blob = await response.blob();
        totalSize += blob.size;
        
        usageLog.push({
          url: request.url,
          size: blob.size,
          lastAccessed: await this.getLastAccessTime(request.url),
          accessCount: await this.getAccessCount(request.url)
        });
      }
    }
    
    return { totalSize, usageLog };
  }
}
```

## 5. 验收标准（可测试）

- [ ] 离线模式下核心游戏功能（地图查看、背包、图鉴）可用
- [ ] 增量更新流量减少 ≥ 70%（相比完整下载）
- [ ] 首次启动时间减少 ≥ 40%（智能预加载）
- [ ] 资源包下载支持断点续传
- [ ] 支持版本回滚，回滚时间 < 5 秒
- [ ] 后台更新不影响游戏进行中的体验
- [ ] 资源包完整性校验通过率 100%
- [ ] 缓存清理后核心功能正常
- [ ] 弱网环境（2G）下资源加载成功率 ≥ 95%
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖完整更新流程

## 6. 工作量估算

**L**（大型）

- 后端资源包管理系统：2 天
- 增量差异算法实现：2 天
- 客户端资源管理器：3 天
- Service Worker 升级：1 天
- 热修复与灰度发布：2 天
- 测试与优化：2 天

**总计：约 12 个工作日**

## 7. 优先级理由

1. **用户体验关键**：直接影响玩家在弱网环境的游戏体验，是留存率的关键因素
2. **成本节约**：减少 CDN 流量消耗，降低运营成本
3. **技术依赖**：为后续离线战斗、离线探索等高级功能提供基础设施
4. **成熟度提升**：项目已进入成熟阶段（总分 89/100），用户体验优化成为重点
