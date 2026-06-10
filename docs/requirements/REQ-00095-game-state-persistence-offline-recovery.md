# REQ-00095：游戏状态持久化与离线状态恢复系统

- **编号**：REQ-00095
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/storage、backend/shared、user-service
- **创建时间**：2026-06-10 22:50
- **依赖需求**：REQ-00009（PWA 离线支持）

## 1. 背景与问题

当前 mineGo 游戏客户端的 GameStore 仅使用内存存储状态，存在以下问题：

1. **状态丢失严重**：用户刷新页面或关闭浏览器后，所有游戏状态（当前位置、精灵列表、库存等）全部丢失
2. **离线体验差**：虽然有 PWA 离线支持，但离线时无法访问之前缓存的游戏数据
3. **重复加载成本**：每次打开应用都需要重新从服务器获取所有数据，增加服务器负载和用户等待时间
4. **用户体验断裂**：用户正在查看的精灵详情、地图位置等上下文信息无法保留

经代码审查，`GameStore.js` 仅维护内存状态 `_state`，没有持久化机制；`sw.js` 虽有 API 缓存，但不支持结构化状态存储。

## 2. 目标

1. 游戏核心状态自动持久化到 IndexedDB，刷新后自动恢复
2. 离线时能访问最近的游戏状态，提供连贯的离线体验
3. 减少重复数据请求，冷启动加载时间降低 50%+
4. 支持多设备状态同步与冲突解决

## 3. 范围

### 包含

- IndexedDB 状态存储层设计
- GameStore 持久化适配器
- 自动保存与增量更新机制
- 离线状态恢复与合并策略
- 状态版本管理与迁移
- 过期数据自动清理

### 不包含

- 跨设备实时同步（需要 WebSocket 服务端支持）
- 敏感数据加密存储（已有 GDPR 合规系统处理）

## 4. 详细需求

### 4.1 状态存储架构

```javascript
// frontend/game-client/src/storage/PersistedStore.js
class PersistedStore {
  constructor(dbName = 'minego-state', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
  }

  // IndexedDB 初始化
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // 核心状态存储
        if (!db.objectStoreNames.contains('state')) {
          const store = db.createObjectStore('state', { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        
        // 精灵缓存
        if (!db.objectStoreNames.contains('pokemon')) {
          const store = db.createObjectStore('pokemon', { keyPath: 'id' });
          store.createIndex('speciesId', 'speciesId');
          store.createIndex('cp', 'cp');
          store.createIndex('updatedAt', 'updatedAt');
        }
        
        // 地图元素缓存
        if (!db.objectStoreNames.contains('mapElements')) {
          const store = db.createObjectStore('mapElements', { keyPath: 'id' });
          store.createIndex('type', 'type'); // 'wild' | 'pokestop' | 'gym'
          store.createIndex('expiresAt', 'expiresAt');
        }
        
        // 操作日志（用于离线操作重放）
        if (!db.objectStoreNames.contains('oplog')) {
          const store = db.createObjectStore('oplog', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp');
          store.createIndex('synced', 'synced');
        }
      };
    });
  }
}
```

### 4.2 GameStore 持久化适配器

```javascript
// frontend/game-client/src/game/PersistedGameStore.js
import { GameStore } from './GameStore.js';
import { PersistedStore } from '../storage/PersistedStore.js';

class PersistedGameStore extends GameStore {
  constructor() {
    super();
    this.persistedStore = new PersistedStore();
    this._saveDebounce = null;
    this._initialized = false;
  }

  async init() {
    await this.persistedStore.init();
    await this.loadPersistedState();
    this._initialized = true;
    
    // 监听状态变化，自动保存
    this.addEventListener('change', (e) => {
      this.debouncedSave(e.detail.changed);
    });
  }

  // 从 IndexedDB 恢复状态
  async loadPersistedState() {
    const persisted = await this.persistedStore.get('gameState');
    if (persisted?.value) {
      const { state, version, savedAt } = persisted.value;
      
      // 版本兼容性检查
      if (this.isCompatibleVersion(version)) {
        // 过滤过期数据
        const validState = this.filterExpiredData(state, savedAt);
        this._state = { ...this._state, ...validState };
        console.log('[PersistedGameStore] Restored state from', new Date(savedAt));
      }
    }
  }

  // 增量保存（只保存变化的字段）
  async saveState(changedKeys) {
    if (!this._initialized) return;
    
    const stateToSave = {
      version: 1,
      savedAt: Date.now(),
      state: {}
    };
    
    // 只保存可持久化的状态
    const persistableKeys = [
      'playerLat', 'playerLng', 'playerAccuracy',
      'pokeballs', 'greatballs', 'ultraballs', 'masterballs',
      'stardust', 'coins', 'activeScreen'
    ];
    
    for (const key of changedKeys) {
      if (persistableKeys.includes(key)) {
        stateToSave.state[key] = this._state[key];
      }
    }
    
    await this.persistedStore.set('gameState', stateToSave);
  }

  debouncedSave(changedKeys) {
    clearTimeout(this._saveDebounce);
    this._saveDebounce = setTimeout(() => {
      this.saveState(changedKeys);
    }, 1000); // 1 秒防抖
  }

  // 过滤过期数据（如已消失的野生精灵）
  filterExpiredData(state, savedAt) {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 分钟
    
    // 如果保存时间超过 5 分钟，清除地图元素
    if (now - savedAt > maxAge) {
      state.wildPokemon = [];
      state.pokestops = [];
      state.gyms = [];
    }
    
    return state;
  }
}
```

### 4.3 离线精灵缓存

```javascript
// frontend/game-client/src/storage/PokemonCache.js
class PokemonCache {
  constructor(persistedStore) {
    this.persistedStore = persistedStore;
    this.maxAge = 24 * 60 * 60 * 1000; // 24 小时
  }

  // 缓存用户的精灵列表
  async cachePokemon(pokemon) {
    const tx = this.persistedStore.db.transaction('pokemon', 'readwrite');
    const store = tx.objectStore('pokemon');
    
    const record = {
      ...pokemon,
      updatedAt: Date.now()
    };
    
    await store.put(record);
  }

  // 批量缓存
  async cachePokemonList(pokemonList) {
    const tx = this.persistedStore.db.transaction('pokemon', 'readwrite');
    const store = tx.objectStore('pokemon');
    
    for (const pokemon of pokemonList) {
      store.put({ ...pokemon, updatedAt: Date.now() });
    }
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // 获取缓存的精灵
  async getCachedPokemon() {
    const tx = this.persistedStore.db.transaction('pokemon', 'readonly');
    const store = tx.objectStore('pokemon');
    
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        // 过滤过期数据
        const now = Date.now();
        const valid = request.result.filter(p => 
          now - p.updatedAt < this.maxAge
        );
        resolve(valid);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // 清理过期缓存
  async cleanExpired() {
    const tx = this.persistedStore.db.transaction('pokemon', 'readwrite');
    const store = tx.objectStore('pokemon');
    const index = store.index('updatedAt');
    
    const cutoff = Date.now() - this.maxAge;
    const range = IDBKeyRange.upperBound(cutoff);
    
    return new Promise((resolve, reject) => {
      const request = index.openCursor(range);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
}
```

### 4.4 状态同步与冲突解决

```javascript
// frontend/game-client/src/storage/StateSyncManager.js
class StateSyncManager {
  constructor(persistedStore, api) {
    this.persistedStore = persistedStore;
    this.api = api;
    this.syncInterval = 5 * 60 * 1000; // 5 分钟
  }

  // 离线后重新上线，合并本地与服务端状态
  async mergeWithServer() {
    const localState = await this.persistedStore.get('gameState');
    const serverState = await this.api.getMe();
    
    if (!localState?.value) return serverState;
    
    const merged = {
      // 服务端数据优先（权威）
      ...localState.value.state,
      ...serverState
    };
    
    // 处理冲突的库存数据
    merged.pokeballs = serverState.pokeball_count;
    merged.greatballs = serverState.greatball_count;
    merged.ultraballs = serverState.ultraball_count;
    merged.masterballs = serverState.masterball_count;
    merged.stardust = serverState.stardust;
    merged.coins = serverState.coins;
    
    return merged;
  }

  // 定期同步
  startPeriodicSync(store) {
    setInterval(async () => {
      if (navigator.onLine) {
        try {
          const merged = await this.mergeWithServer();
          store.set(merged);
        } catch (err) {
          console.warn('[StateSyncManager] Sync failed:', err);
        }
      }
    }, this.syncInterval);
  }
}
```

### 4.5 迁移机制

```javascript
// frontend/game-client/src/storage/StateMigrator.js
class StateMigrator {
  static CURRENT_VERSION = 1;
  
  static migrations = {
    // 未来版本迁移示例
    // 2: (state) => { ... }
  };

  static isCompatibleVersion(version) {
    return version <= this.CURRENT_VERSION;
  }

  static migrate(state, fromVersion, toVersion) {
    let migrated = { ...state };
    
    for (let v = fromVersion + 1; v <= toVersion; v++) {
      if (this.migrations[v]) {
        migrated = this.migrations[v](migrated);
      }
    }
    
    return migrated;
  }
}
```

### 4.6 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/users/me/state` | GET | 获取用户完整状态（用于同步） |
| `/users/me/state/checksum` | GET | 获取状态校验和（快速检测变化） |

## 5. 验收标准（可测试）

- [ ] IndexedDB 数据库正常创建，包含 4 个对象存储
- [ ] 页面刷新后，核心状态（位置、库存、界面状态）自动恢复
- [ ] 离线时能访问缓存的精灵列表
- [ ] 自动保存功能正常，防抖机制生效（1 秒延迟）
- [ ] 过期数据自动清理（野生精灵 5 分钟过期，精灵缓存 24 小时过期）
- [ ] 上线后自动合并本地与服务端状态，库存数据以服务端为准
- [ ] 状态版本迁移机制正常工作
- [ ] 性能：状态恢复时间 < 100ms
- [ ] Prometheus 指标：缓存命中率、状态恢复次数、同步成功率
- [ ] 单元测试覆盖核心逻辑（25+ 测试用例）

## 6. 工作量估算

**L** - 需要设计 IndexedDB 架构、改造 GameStore、实现缓存与同步机制、测试

## 7. 优先级理由

前端体验的关键需求，直接影响用户留存。状态持久化是 PWA 的核心特性之一，能显著改善用户体验，减少数据重复加载，降低服务器压力。作为 REQ-00009（PWA 离线支持）的自然延伸，补全了离线体验的关键拼图。
