# REQ-00304: 游戏客户端网络自适应与弱网优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00304 |
| 标题 | 游戏客户端网络自适应与弱网优化系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、catch-service、gym-service、backend/shared、WebSocket |
| 创建时间 | 2026-06-23 09:00 |

## 需求描述

移动端游戏在实际使用中经常遇到网络不稳定的情况（地铁、电梯、偏远地区等弱网环境），导致：
1. 游戏卡顿、操作延迟、精灵捕捉失败
2. WebSocket 连接频繁断开重连
3. 关键操作（如捕捉、战斗）数据丢失
4. 用户流失和负面评价

本需求实现一套完整的网络自适应与弱网优化系统，包括：
- 网络质量实时检测与状态预测
- 弱网环境下的智能降级策略
- 断线重连优化与数据恢复
- 操作请求优先级队列与合并
- 离线操作缓存与同步机制

**目标效果**：
- 弱网环境（延迟 300-1000ms，丢包率 5-20%）下游戏可用性提升 60%+
- 断线重连时间减少 50%+
- 关键操作成功率提升至 95%+

## 技术方案

### 1. 网络质量实时检测系统

#### 1.1 多维度网络质量评估

```javascript
// frontend/game-client/src/network/NetworkQualityMonitor.js
class NetworkQualityMonitor {
  constructor() {
    this.metrics = {
      latency: [],          // 最近 20 次 RTT 记录
      packetLoss: 0,        // 丢包率
      bandwidth: 0,         // 有效带宽
      jitter: 0,            // 抖动
      connectionType: 'unknown' // wifi/4g/3g/2g/unknown
    };
    
    this.qualityScore = 100; // 0-100
    this.qualityLevel = 'excellent'; // excellent/good/fair/poor/critical
    
    this.pingInterval = null;
    this.samples = [];
  }
  
  /**
   * 启动网络质量监控
   */
  start() {
    // 定期发送心跳探测
    this.pingInterval = setInterval(() => {
      this.sendProbe();
    }, 5000); // 每 5 秒探测一次
    
    // 监听网络变化事件
    this.setupNetworkChangeListener();
    
    // 初始化连接类型检测
    this.detectConnectionType();
  }
  
  /**
   * 发送探测包
   */
  async sendProbe() {
    const startTime = Date.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch('/api/network/ping', {
        method: 'POST',
        body: JSON.stringify({ timestamp: startTime }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      const endTime = Date.now();
      const rtt = endTime - startTime;
      
      this.recordSample({
        success: true,
        rtt,
        timestamp: startTime
      });
      
    } catch (error) {
      this.recordSample({
        success: false,
        rtt: null,
        timestamp: startTime
      });
    }
    
    this.updateQualityScore();
  }
  
  /**
   * 记录样本
   */
  recordSample(sample) {
    this.samples.push(sample);
    
    // 保留最近 20 个样本
    if (this.samples.length > 20) {
      this.samples.shift();
    }
    
    // 计算 RTT
    const successSamples = this.samples.filter(s => s.success);
    if (successSamples.length > 0) {
      this.metrics.latency = successSamples.map(s => s.rtt);
    }
    
    // 计算丢包率
    const failedCount = this.samples.filter(s => !s.success).length;
    this.metrics.packetLoss = (failedCount / this.samples.length) * 100;
  }
  
  /**
   * 更新质量评分
   */
  updateQualityScore() {
    let score = 100;
    
    // RTT 评分 (0-40 分)
    if (this.metrics.latency.length > 0) {
      const avgLatency = this.metrics.latency.reduce((a, b) => a + b, 0) / this.metrics.latency.length;
      
      if (avgLatency <= 50) score += 40;
      else if (avgLatency <= 100) score += 35;
      else if (avgLatency <= 200) score += 25;
      else if (avgLatency <= 500) score += 10;
      else score += 0;
    }
    
    // 丢包率评分 (0-30 分)
    if (this.metrics.packetLoss === 0) score += 30;
    else if (this.metrics.packetLoss <= 1) score += 25;
    else if (this.metrics.packetLoss <= 5) score += 15;
    else if (this.metrics.packetLoss <= 10) score += 5;
    else score += 0;
    
    // 连接类型评分 (0-30 分)
    switch (this.metrics.connectionType) {
      case 'wifi': score += 30; break;
      case '4g': score += 25; break;
      case '3g': score += 15; break;
      case '2g': score += 5; break;
      default: score += 10;
    }
    
    this.qualityScore = Math.max(0, Math.min(100, score));
    
    // 确定质量等级
    if (this.qualityScore >= 90) this.qualityLevel = 'excellent';
    else if (this.qualityScore >= 70) this.qualityLevel = 'good';
    else if (this.qualityScore >= 50) this.qualityLevel = 'fair';
    else if (this.qualityScore >= 30) this.qualityLevel = 'poor';
    else this.qualityLevel = 'critical';
    
    // 触发质量变化事件
    this.emit('qualityChange', {
      score: this.qualityScore,
      level: this.qualityLevel,
      metrics: this.metrics
    });
  }
  
  /**
   * 检测连接类型
   */
  detectConnectionType() {
    if ('connection' in navigator) {
      const connection = navigator.connection;
      this.metrics.connectionType = connection.effectiveType || 'unknown';
      
      // 监听连接类型变化
      connection.addEventListener('change', () => {
        this.metrics.connectionType = connection.effectiveType || 'unknown';
        this.updateQualityScore();
      });
    }
  }
  
  /**
   * 网络变化监听
   */
  setupNetworkChangeListener() {
    window.addEventListener('online', () => {
      console.log('[NetworkMonitor] Network online');
      this.emit('networkOnline');
    });
    
    window.addEventListener('offline', () => {
      console.log('[NetworkMonitor] Network offline');
      this.emit('networkOffline');
    });
  }
  
  /**
   * 获取当前网络状态
   */
  getStatus() {
    return {
      qualityScore: this.qualityScore,
      qualityLevel: this.qualityLevel,
      metrics: { ...this.metrics },
      isOnline: navigator.onLine,
      recommendation: this.getRecommendation()
    };
  }
  
  /**
   * 获取优化建议
   */
  getRecommendation() {
    if (this.qualityScore >= 70) {
      return { strategy: 'normal', description: '网络状况良好，正常游戏' };
    } else if (this.qualityScore >= 50) {
      return { strategy: 'light_optimization', description: '网络一般，启用轻量优化' };
    } else if (this.qualityScore >= 30) {
      return { strategy: 'aggressive_optimization', description: '网络较差，启用积极优化' };
    } else {
      return { strategy: 'offline_mode', description: '网络极差，建议离线模式' };
    }
  }
}

export default NetworkQualityMonitor;
```

#### 1.2 网络状态预测

```javascript
// frontend/game-client/src/network/NetworkPredictor.js
class NetworkPredictor {
  constructor() {
    this.history = [];
    this.model = null;
  }
  
  /**
   * 记录网络状态历史
   */
  recordState(state) {
    this.history.push({
      timestamp: Date.now(),
      qualityScore: state.qualityScore,
      latency: state.metrics.latency.slice(-1)[0] || 0,
      packetLoss: state.metrics.packetLoss
    });
    
    // 保留最近 100 条记录
    if (this.history.length > 100) {
      this.history.shift();
    }
  }
  
  /**
   * 预测未来 10 秒的网络状态
   */
  predict(duration = 10000) {
    if (this.history.length < 5) {
      return { confidence: 0, prediction: 'unknown' };
    }
    
    // 简单的线性趋势预测
    const recentScores = this.history.slice(-10).map(h => h.qualityScore);
    const trend = this.calculateTrend(recentScores);
    
    const lastScore = recentScores[recentScores.length - 1];
    const predictedScore = lastScore + trend * (duration / 5000);
    
    let prediction = 'stable';
    if (predictedScore < lastScore - 20) prediction = 'degrading';
    else if (predictedScore > lastScore + 20) prediction = 'improving';
    
    return {
      confidence: Math.min(0.9, this.history.length / 100),
      prediction,
      predictedScore: Math.max(0, Math.min(100, predictedScore))
    };
  }
  
  /**
   * 计算趋势
   */
  calculateTrend(values) {
    if (values.length < 2) return 0;
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = values.length;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }
}

export default NetworkPredictor;
```

### 2. 智能降级策略系统

#### 2.1 降级策略配置

```javascript
// frontend/game-client/src/network/DegradationStrategy.js
class DegradationStrategy {
  constructor() {
    this.strategies = {
      excellent: {
        mapUpdateInterval: 1000,      // 地图更新间隔
        spriteQuality: 'high',         // 精灵画质
        animationEnabled: true,        // 动画开启
        prefetchDistance: 500,         // 预取距离（米）
        backgroundSync: true,          // 后台同步
        requestTimeout: 5000           // 请求超时
      },
      good: {
        mapUpdateInterval: 2000,
        spriteQuality: 'high',
        animationEnabled: true,
        prefetchDistance: 300,
        backgroundSync: true,
        requestTimeout: 8000
      },
      fair: {
        mapUpdateInterval: 3000,
        spriteQuality: 'medium',
        animationEnabled: true,
        prefetchDistance: 200,
        backgroundSync: false,
        requestTimeout: 10000
      },
      poor: {
        mapUpdateInterval: 5000,
        spriteQuality: 'low',
        animationEnabled: false,
        prefetchDistance: 100,
        backgroundSync: false,
        requestTimeout: 15000
      },
      critical: {
        mapUpdateInterval: 10000,
        spriteQuality: 'low',
        animationEnabled: false,
        prefetchDistance: 50,
        backgroundSync: false,
        requestTimeout: 20000,
        offlineMode: true
      }
    };
    
    this.currentStrategy = 'excellent';
  }
  
  /**
   * 应用降级策略
   */
  applyStrategy(qualityLevel) {
    const strategy = this.strategies[qualityLevel];
    if (!strategy) return;
    
    this.currentStrategy = qualityLevel;
    
    // 应用各项策略
    this.applyMapSettings(strategy);
    this.applySpriteQuality(strategy.spriteQuality);
    this.applyAnimationSettings(strategy.animationEnabled);
    this.applyPrefetchSettings(strategy.prefetchDistance);
    this.applySyncSettings(strategy.backgroundSync);
    this.applyTimeoutSettings(strategy.requestTimeout);
    
    // 离线模式
    if (strategy.offlineMode) {
      this.enableOfflineMode();
    }
    
    console.log(`[DegradationStrategy] Applied ${qualityLevel} strategy`, strategy);
  }
  
  /**
   * 应用地图设置
   */
  applyMapSettings(strategy) {
    // 更新地图刷新频率
    window.dispatchEvent(new CustomEvent('mapUpdateIntervalChange', {
      detail: { interval: strategy.mapUpdateInterval }
    }));
  }
  
  /**
   * 应用精灵画质
   */
  applySpriteQuality(quality) {
    window.dispatchEvent(new CustomEvent('spriteQualityChange', {
      detail: { quality }
    }));
  }
  
  /**
   * 应用动画设置
   */
  applyAnimationSettings(enabled) {
    window.dispatchEvent(new CustomEvent('animationToggle', {
      detail: { enabled }
    }));
  }
  
  /**
   * 获取当前策略
   */
  getCurrentStrategy() {
    return {
      level: this.currentStrategy,
      config: this.strategies[this.currentStrategy]
    };
  }
}

export default DegradationStrategy;
```

### 3. 请求优先级队列与合并

#### 3.1 智能请求队列

```javascript
// frontend/game-client/src/network/RequestQueue.js
class RequestQueue {
  constructor() {
    this.queues = {
      critical: [],   // 关键操作：捕捉、战斗
      high: [],       // 高优先级：精灵数据同步
      normal: [],     // 普通操作：地图更新
      low: []         // 低优先级：统计、日志
    };
    
    this.maxRetries = 3;
    this.processing = false;
    this.networkMonitor = null;
  }
  
  /**
   * 添加请求到队列
   */
  enqueue(request) {
    const priority = request.priority || 'normal';
    
    const queueItem = {
      id: `${Date.now()}_${Math.random()}`,
      request,
      retries: 0,
      timestamp: Date.now(),
      status: 'pending'
    };
    
    this.queues[priority].push(queueItem);
    this.process();
    
    return queueItem.id;
  }
  
  /**
   * 处理队列
   */
  async process() {
    if (this.processing) return;
    
    this.processing = true;
    
    // 按优先级处理
    const priorities = ['critical', 'high', 'normal', 'low'];
    
    for (const priority of priorities) {
      const queue = this.queues[priority];
      
      while (queue.length > 0) {
        const item = queue.shift();
        
        // 弱网环境下跳过低优先级请求
        if (this.shouldSkipInWeakNetwork(priority)) {
          item.status = 'skipped';
          continue;
        }
        
        try {
          await this.executeRequest(item);
          item.status = 'completed';
        } catch (error) {
          item.retries++;
          
          if (item.retries < this.maxRetries) {
            // 重试
            queue.unshift(item);
          } else {
            item.status = 'failed';
            console.error(`[RequestQueue] Request failed after ${this.maxRetries} retries`, item);
          }
        }
      }
    }
    
    this.processing = false;
  }
  
  /**
   * 执行请求
   */
  async executeRequest(item) {
    const { request } = item;
    
    const response = await fetch(request.url, {
      method: request.method || 'GET',
      headers: request.headers || {},
      body: request.body ? JSON.stringify(request.body) : undefined
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    return response.json();
  }
  
  /**
   * 弱网环境下是否跳过
   */
  shouldSkipInWeakNetwork(priority) {
    if (!this.networkMonitor) return false;
    
    const qualityScore = this.networkMonitor.qualityScore;
    
    // 网络极差时跳过低优先级请求
    if (qualityScore < 30 && (priority === 'low' || priority === 'normal')) {
      return true;
    }
    
    // 网络较差时跳过低优先级请求
    if (qualityScore < 50 && priority === 'low') {
      return true;
    }
    
    return false;
  }
}

export default RequestQueue;
```

#### 3.2 请求合并优化

```javascript
// frontend/game-client/src/network/RequestBatcher.js
class RequestBatcher {
  constructor() {
    this.batches = new Map();
    this.batchWindow = 100; // 合并窗口 100ms
  }
  
  /**
   * 添加请求到批处理
   */
  addToBatch(key, request) {
    if (!this.batches.has(key)) {
      this.batches.set(key, {
        requests: [],
        timer: null
      });
    }
    
    const batch = this.batches.get(key);
    batch.requests.push(request);
    
    // 清除旧的定时器
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    
    // 设置新的定时器
    batch.timer = setTimeout(() => {
      this.flushBatch(key);
    }, this.batchWindow);
  }
  
  /**
   * 执行批处理
   */
  async flushBatch(key) {
    const batch = this.batches.get(key);
    if (!batch || batch.requests.length === 0) return;
    
    const requests = batch.requests.splice(0);
    
    // 合并请求
    const mergedRequest = {
      operations: requests.map(r => ({
        type: r.type,
        data: r.data
      }))
    };
    
    try {
      const response = await fetch(`/api/batch/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mergedRequest)
      });
      
      const result = await response.json();
      
      // 分发结果
      requests.forEach((req, index) => {
        if (req.callback) {
          req.callback(result.results[index]);
        }
      });
      
    } catch (error) {
      console.error('[RequestBatcher] Batch request failed', error);
      
      requests.forEach(req => {
        if (req.errorCallback) {
          req.errorCallback(error);
        }
      });
    }
  }
}

export default RequestBatcher;
```

### 4. 离线操作缓存与同步

#### 4.1 离线操作管理器

```javascript
// frontend/game-client/src/network/OfflineOperationManager.js
import { openDB } from 'idb';

class OfflineOperationManager {
  constructor() {
    this.db = null;
    this.syncInProgress = false;
  }
  
  /**
   * 初始化 IndexedDB
   */
  async init() {
    this.db = await openDB('minego-offline', 1, {
      upgrade(db) {
        // 离线操作存储
        if (!db.objectStoreNames.contains('operations')) {
          const store = db.createObjectStore('operations', { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp');
          store.createIndex('type', 'type');
        }
        
        // 精灵数据缓存
        if (!db.objectStoreNames.contains('pokemon-cache')) {
          db.createObjectStore('pokemon-cache', { keyPath: 'id' });
        }
      }
    });
  }
  
  /**
   * 保存离线操作
   */
  async saveOperation(operation) {
    const record = {
      ...operation,
      timestamp: Date.now(),
      synced: false,
      retryCount: 0
    };
    
    await this.db.add('operations', record);
    
    console.log('[OfflineManager] Saved offline operation', operation.type);
    
    return record.id;
  }
  
  /**
   * 同步离线操作
   */
  async syncOperations() {
    if (this.syncInProgress) return;
    if (!navigator.onLine) return;
    
    this.syncInProgress = true;
    
    try {
      const operations = await this.db.getAll('operations');
      const unsynced = operations.filter(op => !op.synced);
      
      console.log(`[OfflineManager] Syncing ${unsynced.length} offline operations`);
      
      for (const operation of unsynced) {
        try {
          await this.syncOperation(operation);
          operation.synced = true;
          await this.db.put('operations', operation);
        } catch (error) {
          operation.retryCount++;
          
          if (operation.retryCount >= 5) {
            // 超过重试次数，标记为失败
            operation.failed = true;
            await this.db.put('operations', operation);
          }
        }
      }
      
    } finally {
      this.syncInProgress = false;
    }
  }
  
  /**
   * 同步单个操作
   */
  async syncOperation(operation) {
    const response = await fetch(operation.url, {
      method: operation.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation.data)
    });
    
    if (!response.ok) {
      throw new Error(`Sync failed: ${response.status}`);
    }
    
    return response.json();
  }
  
  /**
   * 获取未同步操作数量
   */
  async getPendingCount() {
    const operations = await this.db.getAll('operations');
    return operations.filter(op => !op.synced && !op.failed).length;
  }
}

export default OfflineOperationManager;
```

### 5. 断线重连优化

#### 5.1 WebSocket 连接管理器

```javascript
// frontend/game-client/src/network/WebSocketManager.js
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.url = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.heartbeatInterval = null;
    this.messageQueue = [];
    this.listeners = new Map();
    
    this.networkMonitor = null;
  }
  
  /**
   * 连接 WebSocket
   */
  connect(url) {
    this.url = url;
    this.createConnection();
  }
  
  /**
   * 创建连接
   */
  createConnection() {
    if (this.ws) {
      this.ws.close();
    }
    
    this.ws = new WebSocket(this.url);
    
    this.ws.onopen = () => {
      console.log('[WebSocket] Connected');
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushMessageQueue();
      this.emit('connected');
    };
    
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        console.error('[WebSocket] Parse error', error);
      }
    };
    
    this.ws.onclose = (event) => {
      console.log('[WebSocket] Disconnected', event.code);
      this.stopHeartbeat();
      this.emit('disconnected', { code: event.code });
      
      // 自动重连
      this.scheduleReconnect();
    };
    
    this.ws.onerror = (error) => {
      console.error('[WebSocket] Error', error);
      this.emit('error', error);
    };
  }
  
  /**
   * 调度重连
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WebSocket] Max reconnect attempts reached');
      this.emit('reconnectFailed');
      return;
    }
    
    // 根据网络状况调整重连延迟
    let delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    
    if (this.networkMonitor && this.networkMonitor.qualityScore < 50) {
      // 弱网环境下增加延迟
      delay *= 1.5;
    }
    
    delay = Math.min(delay, 30000); // 最大 30 秒
    
    console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
    
    setTimeout(() => {
      this.reconnectAttempts++;
      this.createConnection();
    }, delay);
  }
  
  /**
   * 发送消息（支持队列）
   */
  send(data, options = {}) {
    const message = {
      id: `${Date.now()}_${Math.random()}`,
      data,
      priority: options.priority || 'normal',
      timestamp: Date.now()
    };
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // 连接断开时加入队列
      if (options.queue !== false) {
        this.messageQueue.push(message);
      }
    }
  }
  
  /**
   * 刷新消息队列
   */
  flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.ws.send(JSON.stringify(message));
    }
  }
  
  /**
   * 启动心跳
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000); // 30 秒心跳
  }
  
  /**
   * 停止心跳
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * 处理消息
   */
  handleMessage(data) {
    this.emit('message', data);
  }
  
  /**
   * 事件监听
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }
  
  /**
   * 触发事件
   */
  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => cb(data));
  }
}

export default WebSocketManager;
```

### 6. 后端支持 API

#### 6.1 网络探测端点

```javascript
// backend/services/gateway/routes/network.js
const express = require('express');
const router = express.Router();

/**
 * 网络探测端点
 */
router.post('/ping', async (req, res) => {
  const { timestamp } = req.body;
  
  res.json({
    pong: true,
    serverTime: Date.now(),
    clientTime: timestamp
  });
});

/**
 * 批量请求端点
 */
router.post('/batch/:type', async (req, res) => {
  const { type } = req.params;
  const { operations } = req.body;
  
  const results = [];
  
  for (const operation of operations) {
    try {
      // 根据类型处理不同操作
      const result = await processOperation(type, operation);
      results.push({ success: true, data: result });
    } catch (error) {
      results.push({ success: false, error: error.message });
    }
  }
  
  res.json({ results });
});

/**
 * 处理批量操作
 */
async function processOperation(type, operation) {
  switch (type) {
    case 'pokemon':
      return await processPokemonOperation(operation);
    case 'user':
      return await processUserOperation(operation);
    default:
      throw new Error(`Unknown operation type: ${type}`);
  }
}

module.exports = router;
```

## 验收标准

- [ ] 网络质量监控系统能够实时检测 RTT、丢包率、带宽等指标
- [ ] 质量评分算法准确，能在 3 秒内检测到网络质量变化
- [ ] 网络预测功能能够预测未来 10 秒的网络趋势（准确率 > 70%）
- [ ] 降级策略在弱网环境下自动启用，不影响基本游戏功能
- [ ] 地图更新频率、精灵画质、动画等根据网络状况自动调整
- [ ] 请求优先级队列正常工作，关键操作优先处理
- [ ] 弱网环境下（延迟 500ms+，丢包 10%+）关键操作成功率 > 95%
- [ ] 请求合并功能将多个请求合并为批量请求，减少 40%+ 网络请求
- [ ] 离线操作能够在断网时缓存，网络恢复后自动同步
- [ ] WebSocket 断线重连时间 < 5 秒（正常网络）
- [ ] 弱网环境下断线重连成功率 > 90%
- [ ] 重连后消息队列自动发送，不丢失数据
- [ ] 弱网环境（延迟 300-1000ms，丢包 5-20%）下游戏可用性提升 60%+
- [ ] 断线重连时间减少 50%+
- [ ] 用户感知的网络延迟降低 30%+
- [ ] 完整的单元测试和集成测试
- [ ] 性能测试：网络监控开销 < 5% CPU，< 10MB 内存

## 影响范围

### 前端
- `frontend/game-client/src/network/` - 新增网络管理模块
- `frontend/game-client/src/game/` - 游戏逻辑适配降级策略
- `frontend/game-client/src/components/` - UI 组件适配画质降级

### 后端
- `backend/services/gateway/routes/network.js` - 新增网络探测 API
- `backend/services/gateway/routes/batch.js` - 批量请求处理
- `backend/shared/middleware/requestPriority.js` - 请求优先级中间件

### 数据库
- 新增 `offline_operations` 表（客户端 IndexedDB）
- 新增 `pokemon_cache` 表（客户端 IndexedDB）

## 参考

- [WebRTC Network Quality](https://webrtc.org/)
- [Service Worker Offline Strategies](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [WebSocket Reconnection Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [Network Information API](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation)
- [IndexedDB for Offline Storage](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
