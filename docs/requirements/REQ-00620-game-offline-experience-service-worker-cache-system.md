# REQ-00620: 游戏离线体验与 Service Worker 智能缓存管理系统

- **编号**：REQ-00620
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：frontend/game-client、service-worker、backend/gateway、游戏资源管理
- **创建时间**：2026-07-20 21:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 游戏客户端存在以下离线体验问题：

1. **网络依赖性强**：游戏在网络不稳定或断网情况下无法使用，用户流失严重。移动网络环境下（地铁、电梯、偏远地区）用户体验差。

2. **缓存策略缺失**：当前没有 Service Worker 实现离线缓存，游戏资源（精灵图片、音效、地图瓦片）每次都要重新加载，浪费流量和加载时间。

3. **离线功能空白**：用户无法在离线状态下查看已捕捉的精灵、背包物品、成就等本地数据，错失游戏粘性机会。

4. **网络恢复处理不当**：网络从离线恢复到在线时，缺乏智能重连机制，用户需要手动刷新页面，可能导致游戏状态丢失。

5. **流量消耗大**：游戏资源（3D模型、音频、高清图片）频繁重新下载，用户流量消耗高，特别是移动网络环境下。

这些问题会导致：
- 移动场景下用户流失率高
- 加载时间长，影响首次体验
- 流量成本高，用户不愿意使用
- 离线场景无法留存用户

## 2. 目标

构建完整的离线优先体验系统，实现：

1. **智能缓存策略**：Service Worker 管理游戏资源缓存，实现离线可用
2. **离线功能支持**：离线查看本地数据（精灵、背包、成就），离线游戏进度保存
3. **智能网络恢复**：网络恢复时自动重连、同步离线操作
4. **流量优化**：资源预缓存、增量更新，减少 70% 流量消耗
5. **降级体验**：网络差时自动降级到离线模式，保证基本可用性
6. **性能提升**：首屏加载时间减少 50%

## 3. 范围

- **包含**：
  - Service Worker 实现与缓存策略配置
  - 离线数据存储与同步机制（IndexedDB + LocalStorage）
  - 游戏资源预缓存系统（精灵图片、音效、地图瓦片）
  - 网络状态监控与智能重连
  - 离线操作队列与冲突解决
  - 降级体验 UI（离线提示、离线模式切换）
  - 缓存管理界面（清除缓存、更新资源）
  - 性能监控与统计

- **不包含**：
  - 离线战斗系统（需要服务器同步）
  - 离线交易系统（需要防作弊验证）
  - 完整的 PWA 功能（推送通知独立需求）
  - 后端数据库同步逻辑修改

## 4. 详细需求

### 4.1 Service Worker 架构

```javascript
// frontend/game-client/sw.js
class GameServiceWorker {
  // 缓存策略
  cacheStrategies = {
    // 精灵图片：Cache-First，缓存 30 天
    sprites: { strategy: 'cache-first', maxAge: 30 * 24 * 3600 },
    
    // 音效文件：Cache-First，缓存 30 天
    audio: { strategy: 'cache-first', maxAge: 30 * 24 * 3600 },
    
    // 地图瓦片：Cache-First，缓存 7 天
    mapTiles: { strategy: 'cache-first', maxAge: 7 * 24 * 3600 },
    
    // API 请求：Network-First，超时 fallback 到缓存
    api: { strategy: 'network-first', timeout: 3000, fallback: true },
    
    // 静态资源：Stale-While-Revalidate
    static: { strategy: 'stale-while-revalidate' }
  };
  
  // 预缓存资源列表
  precacheList = [
    '/', '/index.html', '/manifest.json',
    '/sprites/common/', '/audio/effects/',
    '/styles/main.css', '/js/main.js'
  ];
}
```

### 4.2 离线数据管理

```javascript
// frontend/game-client/src/offline/OfflineDataManager.js
class OfflineDataManager {
  // IndexedDB 数据库
  dbName = 'MineGoOffline';
  dbVersion = 1;
  
  // 存储的数据表
  stores = {
    pokemon: '已捕捉精灵数据',
    inventory: '背包物品数据',
    achievements: '成就进度数据',
    settings: '游戏设置',
    pendingOps: '离线操作队列'
  };
  
  // 同步策略
  async syncPendingOperations() {
    const ops = await this.getPendingOps();
    for (const op of ops) {
      try {
        await this.executeOperation(op);
        await this.removePendingOp(op.id);
      } catch (err) {
        // 保留失败操作，等待下次同步
        op.retryCount++;
        if (op.retryCount < 5) {
          await this.updatePendingOp(op);
        }
      }
    }
  }
}
```

### 4.3 网络状态监控

```javascript
// frontend/game-client/src/network/NetworkMonitor.js
class NetworkMonitor {
  // 状态：online / offline / slow
  currentStatus = 'online';
  
  // 监听网络变化
  setupListeners() {
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
    
    // 定期检测网络质量
    setInterval(() => this.checkNetworkQuality(), 10000);
  }
  
  // 网络恢复处理
  async handleOnline() {
    this.currentStatus = 'online';
    
    // 1. 显示网络恢复提示
    this.showNetworkToast('网络已恢复');
    
    // 2. 同步离线操作
    await offlineDataManager.syncPendingOperations();
    
    // 3. 刷新关键数据
    await this.refreshCriticalData();
    
    // 4. 恢复在线功能
    this.enableOnlineFeatures();
  }
  
  // 网络断开处理
  handleOffline() {
    this.currentStatus = 'offline';
    
    // 1. 显示离线提示
    this.showNetworkToast('已进入离线模式');
    
    // 2. 切换到离线 UI
    this.switchToOfflineUI();
    
    // 3. 启用离线功能
    this.enableOfflineFeatures();
  }
}
```

### 4.4 缓存更新策略

```javascript
// frontend/game-client/src/cache/CacheManager.js
class CacheManager {
  // 检查资源更新
  async checkUpdates() {
    const manifest = await fetch('/api/cache-manifest').then(r => r.json());
    const localManifest = await this.getLocalManifest();
    
    const updates = this.diffManifests(manifest, localManifest);
    
    if (updates.length > 0) {
      // 显示更新提示
      this.showUpdateNotification(updates);
    }
  }
  
  // 增量更新
  async performDeltaUpdate(updates) {
    for (const resource of updates) {
      if (resource.delta) {
        // 增量更新
        await this.applyDelta(resource);
      } else {
        // 完整更新
        await this.downloadResource(resource);
      }
    }
  }
}
```

### 4.5 降级体验 UI

```html
<!-- 离线模式提示组件 -->
<div id="offline-banner" class="hidden">
  <div class="offline-icon">📵</div>
  <div class="offline-text">离线模式</div>
  <div class="offline-actions">
    <button onclick="showOfflineFeatures()">查看离线功能</button>
    <button onclick="retryConnection()">重试连接</button>
  </div>
</div>

<!-- 离线可用功能列表 -->
<div id="offline-features">
  <h3>离线可用功能</h3>
  <ul>
    <li>✅ 查看已捕捉精灵</li>
    <li>✅ 查看背包物品</li>
    <li>✅ 查看成就进度</li>
    <li>✅ 修改游戏设置</li>
    <li>❌ 捕捉新精灵</li>
    <li>❌ 道馆战斗</li>
    <li>❌ 精灵交易</li>
  </ul>
</div>
```

### 4.6 性能指标

```javascript
// 缓存命中率监控
metrics: {
  cacheHitRate: 0,          // 缓存命中率
  avgLoadTime: 0,           // 平均加载时间
  offlineSessions: 0,       // 离线会话次数
  bytesSaved: 0,            // 节省流量（字节）
  syncSuccessRate: 0        // 离线操作同步成功率
}
```

## 5. 验收标准（可测试）

- [ ] 实现 Service Worker，支持至少 5 种缓存策略（cache-first / network-first / stale-while-revalidate 等）
- [ ] 预缓存至少 50 个核心游戏资源（精灵图片、音效、UI 组件）
- [ ] 离线状态下可以查看已捕捉精灵、背包物品、成就列表
- [ ] 离线操作（如修改设置）在网络恢复后自动同步
- [ ] 网络从离线恢复到在线时，自动重连并同步数据，无需手动刷新
- [ ] 缓存命中率 >= 80%，首屏加载时间减少 >= 40%
- [ ] 流量消耗减少 >= 60%（通过性能测试验证）
- [ ] 提供缓存管理界面，支持清除缓存、手动更新资源
- [ ] 单元测试覆盖率 >= 85%
- [ ] 支持 IndexedDB 数据库存储，容量 >= 50MB
- [ ] 离线操作队列支持冲突检测和解决机制

## 6. 工作量估算

**XL** - 需要实现完整的 Service Worker 系统、离线数据管理、网络监控、降级 UI 等多个模块，涉及前端架构调整和后端 API 适配。预计 7-10 天完成。

## 7. 优先级理由

P1 优先级，理由如下：

1. **用户体验关键**：移动场景下网络不稳定是常态，离线体验直接影响用户留存
2. **流量成本优化**：游戏资源体积大，智能缓存可显著降低用户流量成本
3. **性能提升明显**：首屏加载时间减少 50%，显著改善用户体验
4. **竞品差异化**：优秀的离线体验是游戏产品的竞争优势
5. **技术基础**：为后续 PWA 功能（推送通知、后台同步）奠定基础
