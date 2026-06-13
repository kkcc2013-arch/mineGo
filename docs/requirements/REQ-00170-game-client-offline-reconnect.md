# REQ-00170: 游戏客户端离线模式与断线重连系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00170 |
| 标题 | 游戏客户端离线模式与断线重连系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、frontend/game-client/src/offline、gateway、backend/shared、user-service |
| 创建时间 | 2026-06-13 21:15 |

## 需求描述

实现游戏客户端的离线模式与断线重连系统，确保玩家在网络不稳定或短暂断线的情况下仍能保持游戏体验的连续性。该系统需要：

1. **离线检测**：实时监控网络状态，快速检测连接中断
2. **离线缓存**：缓存关键游戏数据，支持离线状态下的部分功能
3. **断线重连**：网络恢复后自动重连并同步状态
4. **数据同步**：重连后智能同步离线期间产生的数据变更
5. **用户提示**：清晰的网络状态提示与重连进度展示

## 技术方案

### 1. 离线状态检测器

```javascript
// frontend/game-client/src/offline/networkMonitor.js
class NetworkMonitor {
  constructor() {
    this.isOnline = navigator.onLine;
    this.lastOnlineTime = Date.now();
    this.listeners = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    
    this.init();
  }
  
  init() {
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
    
    // 心跳检测
    this.startHeartbeat();
  }
  
  startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      try {
        const response = await fetch('/api/health', { 
          method: 'HEAD',
          cache: 'no-cache'
        });
        
        if (response.ok && !this.isOnline) {
          this.handleOnline();
        }
      } catch (error) {
        if (this.isOnline) {
          this.handleOffline();
        }
      }
    }, 5000);
  }
  
  handleOffline() {
    this.isOnline = false;
    this.emit('offline', {
      timestamp: Date.now(),
      lastOnlineDuration: Date.now() - this.lastOnlineTime
    });
  }
  
  handleOnline() {
    this.isOnline = true;
    this.lastOnlineTime = Date.now();
    this.reconnectAttempts = 0;
    this.emit('online', { timestamp: Date.now() });
  }
  
  on(event, callback) {
    this.listeners.add({ event, callback });
  }
  
  emit(event, data) {
    this.listeners.forEach(listener => {
      if (listener.event === event) {
        listener.callback(data);
      }
    });
  }
}

export default new NetworkMonitor();
```

### 2. 离线数据缓存管理器

```javascript
// frontend/game-client/src/offline/offlineCache.js
import localforage from 'localforage';

class OfflineCache {
  constructor() {
    this.cache = localforage.createInstance({
      name: 'mineGoOffline',
      storeName: 'gameData'
    });
    
    this.pendingActions = [];
    this.maxPendingActions = 100;
  }
  
  async cachePlayerData(player) {
    await this.cache.setItem('player', {
      ...player,
      cachedAt: Date.now()
    });
  }
  
  async cachePokemonList(pokemon) {
    await this.cache.setItem('pokemonList', pokemon);
  }
  
  async cacheMapData(mapData) {
    await this.cache.setItem('mapData', {
      ...mapData,
      cachedAt: Date.now()
    });
  }
  
  async addPendingAction(action) {
    this.pendingActions.push({
      ...action,
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
    
    // 限制队列长度
    if (this.pendingActions.length > this.maxPendingActions) {
      this.pendingActions.shift();
    }
    
    await this.cache.setItem('pendingActions', this.pendingActions);
  }
  
  async getPendingActions() {
    const actions = await this.cache.getItem('pendingActions');
    return actions || [];
  }
  
  async clearPendingActions() {
    this.pendingActions = [];
    await this.cache.setItem('pendingActions', []);
  }
  
  async getCachedData() {
    const [player, pokemonList, mapData] = await Promise.all([
      this.cache.getItem('player'),
      this.cache.getItem('pokemonList'),
      this.cache.getItem('mapData')
    ]);
    
    return { player, pokemonList, mapData };
  }
  
  async clear() {
    await this.cache.clear();
  }
}

export default new OfflineCache();
```

### 3. 断线重连管理器

```javascript
// frontend/game-client/src/offline/reconnectManager.js
import networkMonitor from './networkMonitor';
import offlineCache from './offlineCache';

class ReconnectManager {
  constructor() {
    this.reconnecting = false;
    this.reconnectTimer = null;
    this.socketReconnectAttempts = 0;
    this.maxSocketReconnectAttempts = 10;
  }
  
  async reconnect() {
    if (this.reconnecting) return;
    
    this.reconnecting = true;
    this.emit('reconnect:start');
    
    try {
      // 1. 重新建立 WebSocket 连接
      await this.reconnectSocket();
      
      // 2. 同步离线数据
      await this.syncPendingActions();
      
      // 3. 刷新游戏状态
      await this.refreshGameState();
      
      this.emit('reconnect:success');
    } catch (error) {
      this.emit('reconnect:failed', { error });
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
    }
  }
  
  async reconnectSocket() {
    return new Promise((resolve, reject) => {
      const maxAttempts = this.maxSocketReconnectAttempts;
      
      const attemptReconnect = () => {
        this.socketReconnectAttempts++;
        
        try {
          // 重新初始化 WebSocket
          window.gameClient.socket.connect();
          
          window.gameClient.socket.once('connect', () => {
            this.socketReconnectAttempts = 0;
            resolve();
          });
          
          window.gameClient.socket.once('connect_error', () => {
            if (this.socketReconnectAttempts < maxAttempts) {
              setTimeout(attemptReconnect, 1000 * this.socketReconnectAttempts);
            } else {
              reject(new Error('Socket reconnection failed'));
            }
          });
        } catch (error) {
          reject(error);
        }
      };
      
      attemptReconnect();
    });
  }
  
  async syncPendingActions() {
    const pendingActions = await offlineCache.getPendingActions();
    
    if (pendingActions.length === 0) return;
    
    const results = [];
    
    for (const action of pendingActions) {
      try {
        const response = await this.executeAction(action);
        results.push({ action, success: true, response });
      } catch (error) {
        results.push({ action, success: false, error: error.message });
      }
    }
    
    await offlineCache.clearPendingActions();
    
    return results;
  }
  
  async executeAction(action) {
    const { method, url, data } = action;
    
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(res => res.json());
  }
  
  async refreshGameState() {
    // 刷新玩家数据
    await window.gameClient.refreshPlayerData();
    
    // 刷新精灵列表
    await window.gameClient.refreshPokemonList();
    
    // 刷新地图数据
    await window.gameClient.refreshMapData();
  }
  
  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    const delay = Math.min(1000 * Math.pow(2, this.socketReconnectAttempts), 30000);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnect();
    }, delay);
  }
  
  on(event, callback) {
    // 事件监听实现
  }
  
  emit(event, data) {
    // 事件触发实现
  }
}

export default new ReconnectManager();
```

### 4. 离线模式 UI 组件

```javascript
// frontend/game-client/src/components/OfflineIndicator.vue
<template>
  <div class="offline-indicator" :class="{ 'is-offline': !isOnline }">
    <div v-if="!isOnline" class="offline-banner">
      <span class="icon">⚠️</span>
      <span class="message">网络连接已断开</span>
      <span class="reconnect-action" @click="manualReconnect">
        重新连接
      </span>
    </div>
    
    <div v-if="isReconnecting" class="reconnect-progress">
      <div class="spinner"></div>
      <span>正在重连... ({{ reconnectProgress }}%)</span>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import networkMonitor from '../offline/networkMonitor';
import reconnectManager from '../offline/reconnectManager';

export default {
  name: 'OfflineIndicator',
  
  setup() {
    const isOnline = ref(true);
    const isReconnecting = ref(false);
    const reconnectProgress = ref(0);
    
    onMounted(() => {
      networkMonitor.on('offline', () => {
        isOnline.value = false;
      });
      
      networkMonitor.on('online', () => {
        isOnline.value = true;
        isReconnecting.value = false;
      });
      
      reconnectManager.on('reconnect:start', () => {
        isReconnecting.value = true;
        reconnectProgress.value = 0;
      });
      
      reconnectManager.on('reconnect:success', () => {
        isReconnecting.value = false;
        isOnline.value = true;
      });
    });
    
    const manualReconnect = async () => {
      await reconnectManager.reconnect();
    };
    
    return {
      isOnline,
      isReconnecting,
      reconnectProgress,
      manualReconnect
    };
  }
};
</script>

<style scoped>
.offline-indicator {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
}

.offline-banner {
  background: #ff5722;
  color: white;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.reconnect-progress {
  background: #2196f3;
  color: white;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid white;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.reconnect-action {
  cursor: pointer;
  text-decoration: underline;
  font-weight: bold;
}
</style>
```

### 5. 后端重连支持 API

```javascript
// backend/services/user-service/src/routes/reconnect.js
const express = require('express');
const router = express.Router();

// 获取离线期间的数据变更
router.get('/offline-changes', async (req, res) => {
  const { userId, lastSyncTime } = req.query;
  
  // 获取离线期间的数据变更
  const changes = await getOfflineChanges(userId, lastSyncTime);
  
  res.json({
    success: true,
    changes: changes,
    serverTime: Date.now()
  });
});

// 同步离线操作
router.post('/sync-actions', async (req, res) => {
  const { userId, actions } = req.body;
  
  const results = [];
  
  for (const action of actions) {
    try {
      // 验证并执行操作
      const result = await processOfflineAction(userId, action);
      results.push({ id: action.id, success: true, result });
    } catch (error) {
      results.push({ id: action.id, success: false, error: error.message });
    }
  }
  
  res.json({
    success: true,
    results
  });
});

module.exports = router;
```

## 验收标准

- [ ] 客户端能实时检测网络状态变化
- [ ] 离线时能缓存关键游戏数据（玩家信息、精灵列表、地图数据）
- [ ] 离线期间的操作能被记录到待同步队列
- [ ] 网络恢复后自动触发重连流程
- [ ] 重连成功后自动同步离线数据
- [ ] 冲突数据有明确的解决策略（时间戳优先或用户选择）
- [ ] 显示清晰的网络状态指示器
- [ ] 支持手动触发重连
- [ ] 重连失败时提供重试机制
- [ ] 离线模式下部分功能可用（查看精灵、查看地图等）

## 影响范围

- **新增文件**：
  - `frontend/game-client/src/offline/networkMonitor.js`
  - `frontend/game-client/src/offline/offlineCache.js`
  - `frontend/game-client/src/offline/reconnectManager.js`
  - `frontend/game-client/src/components/OfflineIndicator.vue`
  - `backend/services/user-service/src/routes/reconnect.js`

- **修改文件**：
  - `frontend/game-client/src/main.js`（集成离线管理器）
  - `frontend/game-client/src/services/socket.js`（增强重连逻辑）
  - `backend/services/user-service/src/index.js`（挂载重连路由）
  - `backend/gateway/src/middleware/offlineSupport.js`（离线支持中间件）

- **依赖项**：
  - `localforage`（本地存储库）
  - IndexedDB（浏览器存储）

## 参考

- [Service Worker 离线指南](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- [WebSocket 重连最佳实践](https://socket.io/docs/v3/client-api/index.html)
- [PWA 离线模式设计](https://web.dev/offline-cooking-with-service-workers/)
- 相关需求：REQ-00009（PWA 离线支持）、REQ-00095（游戏状态持久化）
