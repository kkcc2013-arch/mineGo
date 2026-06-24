# REQ-00321：API 熔断器仪表板可视化与实时状态监控

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00321 |
| 标题 | API 熔断器仪表板可视化与实时状态监控 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、admin-dashboard、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-24 13:30 UTC |
| 依赖需求 | REQ-00014（服务熔断与降级机制） |

## 1. 背景与问题

当前项目已实现熔断器机制（CircuitBreaker.js），但缺乏直观的可视化仪表板来监控各服务的熔断状态。运维人员需要：

1. **实时查看各服务的熔断器状态**（关闭/打开/半开）
2. **追踪熔断触发历史和原因**
3. **监控失败率和响应时间趋势**
4. **手动控制熔断器状态**（强制打开/关闭）
5. **配置熔断器参数**（阈值、超时时间等）

现有问题：
- 熔断器状态分散在各服务日志中，难以全局查看
- 无法快速定位哪个服务的熔断器被触发
- 缺乏历史数据来分析熔断触发模式
- 无法远程调整熔断器配置

## 2. 目标

构建一个统一的熔断器监控仪表板，提供：

- 实时展示所有服务的熔断器状态
- 熔断事件的实时推送和历史查询
- 可视化的失败率、响应时间、请求量趋势图
- 远程控制熔断器状态和配置的能力
- 告警规则配置和通知集成

## 3. 范围

### 包含
- 熔断器状态聚合 API（gateway 层）
- WebSocket 实时状态推送
- Admin Dashboard 熔断器监控页面
- Prometheus 指标导出
- Grafana 预置仪表板模板
- 熔断器配置热更新接口

### 不包含
- 自动熔断策略优化（机器学习）
- 跨区域熔断器同步
- 多集群熔断器聚合

## 4. 详细需求

### 4.1 数据模型

```sql
-- 熔断器状态快照表
CREATE TABLE circuit_breaker_snapshots (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(50) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    state VARCHAR(20) NOT NULL,  -- 'closed', 'open', 'half-open'
    failure_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failure_rate DECIMAL(5, 4),
    avg_response_time_ms INTEGER,
    last_failure_at TIMESTAMP,
    last_success_at TIMESTAMP,
    state_changed_at TIMESTAMP,
    snapshot_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_name, endpoint, snapshot_at)
);

CREATE INDEX idx_cb_snapshots_service ON circuit_breaker_snapshots(service_name, snapshot_at DESC);

-- 熔断器事件历史表
CREATE TABLE circuit_breaker_events (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(50) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    event_type VARCHAR(30) NOT NULL,  -- 'state_change', 'config_update', 'manual_override'
    previous_state VARCHAR(20),
    new_state VARCHAR(20),
    reason TEXT,
    triggered_by VARCHAR(50),  -- 'system', 'admin_user_id', 'threshold_exceeded'
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cb_events_service ON circuit_breaker_events(service_name, created_at DESC);

-- 熔断器配置表
CREATE TABLE circuit_breaker_configs (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(50) NOT NULL,
    endpoint VARCHAR(100) NOT NULL,
    failure_threshold INTEGER DEFAULT 5,
    success_threshold INTEGER DEFAULT 3,
    timeout_ms INTEGER DEFAULT 60000,
    half_open_max_calls INTEGER DEFAULT 5,
    sliding_window_size INTEGER DEFAULT 100,
    enabled BOOLEAN DEFAULT true,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(50),
    UNIQUE(service_name, endpoint)
);
```

### 4.2 熔断器状态聚合服务

```javascript
// backend/shared/CircuitBreakerRegistry.js

const EventEmitter = require('events');
const WebSocket = require('ws');
const { logger, metrics } = require('./index');
const db = require('./db');

class CircuitBreakerRegistry extends EventEmitter {
  constructor() {
    super();
    this.breakers = new Map(); // service:endpoint -> CircuitBreaker
    this.stateCache = new Map();
    this.wsClients = new Set();
  }

  /**
   * 注册熔断器实例
   */
  register(serviceName, endpoint, breaker) {
    const key = `${serviceName}:${endpoint}`;
    this.breakers.set(key, breaker);
    
    // 监听状态变化
    breaker.on('stateChange', (from, to) => {
      this.handleStateChange(serviceName, endpoint, from, to);
    });
    
    // 定期上报状态
    breaker.on('statsUpdate', (stats) => {
      this.handleStatsUpdate(serviceName, endpoint, stats);
    });
    
    logger.info('Circuit breaker registered', { serviceName, endpoint });
  }

  /**
   * 处理状态变化
   */
  async handleStateChange(serviceName, endpoint, fromState, toState) {
    const key = `${serviceName}:${endpoint}`;
    
    logger.warn('Circuit breaker state changed', {
      serviceName,
      endpoint,
      from: fromState,
      to: toState
    });
    
    // 更新缓存
    this.stateCache.set(key, {
      serviceName,
      endpoint,
      state: toState,
      stateChangedAt: new Date()
    });
    
    // 记录事件
    await db.query(`
      INSERT INTO circuit_breaker_events 
      (service_name, endpoint, event_type, previous_state, new_state, triggered_by)
      VALUES ($1, $2, 'state_change', $3, $4, 'system')
    `, [serviceName, endpoint, fromState, toState]);
    
    // 更新指标
    metrics.gauge('circuit_breaker_state', toState === 'open' ? 1 : 0, {
      service: serviceName,
      endpoint
    });
    
    // 推送 WebSocket 通知
    this.broadcast({
      type: 'state_change',
      serviceName,
      endpoint,
      fromState,
      toState,
      timestamp: new Date().toISOString()
    });
    
    // 触发事件
    this.emit('stateChange', { serviceName, endpoint, fromState, toState });
  }

  /**
   * 处理统计更新
   */
  async handleStatsUpdate(serviceName, endpoint, stats) {
    const key = `${serviceName}:${endpoint}`;
    
    // 更新缓存
    const cached = this.stateCache.get(key) || {};
    this.stateCache.set(key, {
      ...cached,
      serviceName,
      endpoint,
      ...stats,
      updatedAt: new Date()
    });
    
    // 记录快照（每分钟一次）
    const now = new Date();
    const minuteKey = `${key}:${now.getMinutes()}`;
    
    if (!this.lastSnapshot || Date.now() - this.lastSnapshot > 60000) {
      await this.saveSnapshot(serviceName, endpoint, stats);
      this.lastSnapshot = Date.now();
    }
  }

  /**
   * 保存状态快照
   */
  async saveSnapshot(serviceName, endpoint, stats) {
    try {
      await db.query(`
        INSERT INTO circuit_breaker_snapshots
        (service_name, endpoint, state, failure_count, success_count, 
         failure_rate, avg_response_time_ms, last_failure_at, last_success_at, 
         state_changed_at, snapshot_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      `, [
        serviceName,
        endpoint,
        stats.state,
        stats.failureCount,
        stats.successCount,
        stats.failureRate,
        stats.avgResponseTime,
        stats.lastFailureAt,
        stats.lastSuccessAt,
        stats.stateChangedAt
      ]);
    } catch (error) {
      logger.error('Failed to save circuit breaker snapshot', {
        error: error.message,
        serviceName,
        endpoint
      });
    }
  }

  /**
   * 获取所有熔断器状态
   */
  getAllStates() {
    const result = [];
    for (const [key, breaker] of this.breakers) {
      const [serviceName, endpoint] = key.split(':');
      result.push({
        serviceName,
        endpoint,
        ...breaker.getStats()
      });
    }
    return result;
  }

  /**
   * 获取特定服务的熔断器状态
   */
  getServiceStates(serviceName) {
    const result = [];
    for (const [key, breaker] of this.breakers) {
      if (key.startsWith(`${serviceName}:`)) {
        const [, endpoint] = key.split(':');
        result.push({
          serviceName,
          endpoint,
          ...breaker.getStats()
        });
      }
    }
    return result;
  }

  /**
   * 手动打开熔断器
   */
  async forceOpen(serviceName, endpoint, reason, userId) {
    const key = `${serviceName}:${endpoint}`;
    const breaker = this.breakers.get(key);
    
    if (!breaker) {
      throw new Error(`Circuit breaker not found: ${key}`);
    }
    
    await breaker.forceOpen(reason);
    
    await db.query(`
      INSERT INTO circuit_breaker_events
      (service_name, endpoint, event_type, previous_state, new_state, reason, triggered_by)
      VALUES ($1, $2, 'manual_override', $3, 'open', $4, $5)
    `, [serviceName, endpoint, breaker.getPreviousState(), reason, userId]);
    
    logger.info('Circuit breaker manually opened', {
      serviceName,
      endpoint,
      reason,
      userId
    });
  }

  /**
   * 手动关闭熔断器
   */
  async forceClose(serviceName, endpoint, reason, userId) {
    const key = `${serviceName}:${endpoint}`;
    const breaker = this.breakers.get(key);
    
    if (!breaker) {
      throw new Error(`Circuit breaker not found: ${key}`);
    }
    
    await breaker.forceClose(reason);
    
    await db.query(`
      INSERT INTO circuit_breaker_events
      (service_name, endpoint, event_type, previous_state, new_state, reason, triggered_by)
      VALUES ($1, $2, 'manual_override', $3, 'closed', $4, $5)
    `, [serviceName, endpoint, breaker.getPreviousState(), reason, userId]);
    
    logger.info('Circuit breaker manually closed', {
      serviceName,
      endpoint,
      reason,
      userId
    });
  }

  /**
   * 更新熔断器配置
   */
  async updateConfig(serviceName, endpoint, config, userId) {
    const key = `${serviceName}:${endpoint}`;
    const breaker = this.breakers.get(key);
    
    if (!breaker) {
      throw new Error(`Circuit breaker not found: ${key}`);
    }
    
    await breaker.updateConfig(config);
    
    await db.query(`
      UPDATE circuit_breaker_configs
      SET failure_threshold = $3,
          success_threshold = $4,
          timeout_ms = $5,
          half_open_max_calls = $6,
          sliding_window_size = $7,
          updated_at = NOW(),
          updated_by = $8
      WHERE service_name = $1 AND endpoint = $2
    `, [serviceName, endpoint, config.failureThreshold, config.successThreshold,
        config.timeoutMs, config.halfOpenMaxCalls, config.slidingWindowSize, userId]);
    
    await db.query(`
      INSERT INTO circuit_breaker_events
      (service_name, endpoint, event_type, reason, triggered_by, metadata)
      VALUES ($1, $2, 'config_update', $3, $4, $5)
    `, [serviceName, endpoint, 'Configuration updated', userId, JSON.stringify(config)]);
    
    logger.info('Circuit breaker config updated', {
      serviceName,
      endpoint,
      config,
      userId
    });
  }

  /**
   * WebSocket 广播
   */
  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * 添加 WebSocket 客户端
   */
  addWsClient(client) {
    this.wsClients.add(client);
    client.on('close', () => this.wsClients.delete(client));
  }

  /**
   * 获取熔断器事件历史
   */
  async getEventHistory(serviceName, options = {}) {
    const { limit = 100, offset = 0, eventType } = options;
    
    let query = `
      SELECT * FROM circuit_breaker_events
      WHERE service_name = $1
    `;
    const params = [serviceName];
    
    if (eventType) {
      query += ` AND event_type = $${params.length + 1}`;
      params.push(eventType);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * 获取熔断器状态趋势
   */
  async getStateTrends(serviceName, hours = 24) {
    const result = await db.query(`
      SELECT 
        DATE_TRUNC('hour', snapshot_at) as hour,
        endpoint,
        state,
        AVG(failure_rate) as avg_failure_rate,
        AVG(avg_response_time_ms) as avg_response_time,
        SUM(failure_count) as total_failures,
        SUM(success_count) as total_successes
      FROM circuit_breaker_snapshots
      WHERE service_name = $1
        AND snapshot_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY hour, endpoint, state
      ORDER BY hour DESC, endpoint
    `, [serviceName]);
    
    return result.rows;
  }
}

// 单例
const registry = new CircuitBreakerRegistry();

module.exports = registry;
```

### 4.3 Gateway API 端点

```javascript
// backend/services/gateway/src/routes/circuitBreaker.js

const express = require('express');
const router = express.Router();
const registry = require('../../../shared/CircuitBreakerRegistry');
const { logger } = require('../../../shared/index');
const authMiddleware = require('../../../shared/middleware/auth');

/**
 * 获取所有熔断器状态
 * GET /api/v1/circuit-breakers
 */
router.get('/', async (req, res) => {
  try {
    const states = registry.getAllStates();
    
    // 按服务分组
    const grouped = states.reduce((acc, state) => {
      if (!acc[state.serviceName]) {
        acc[state.serviceName] = [];
      }
      acc[state.serviceName].push(state);
      return acc;
    }, {});
    
    res.json({
      success: true,
      data: grouped,
      summary: {
        total: states.length,
        open: states.filter(s => s.state === 'open').length,
        halfOpen: states.filter(s => s.state === 'half-open').length,
        closed: states.filter(s => s.state === 'closed').length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get circuit breaker states', { error: error.message });
    res.status(500).json({ error: 'Failed to get circuit breaker states' });
  }
});

/**
 * 获取特定服务的熔断器状态
 * GET /api/v1/circuit-breakers/:serviceName
 */
router.get('/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const states = registry.getServiceStates(serviceName);
    
    if (states.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    res.json({
      success: true,
      serviceName,
      data: states,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get service circuit breaker states', { error: error.message });
    res.status(500).json({ error: 'Failed to get service states' });
  }
});

/**
 * 获取熔断器事件历史
 * GET /api/v1/circuit-breakers/:serviceName/events
 */
router.get('/:serviceName/events', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { limit, offset, eventType } = req.query;
    
    const events = await registry.getEventHistory(serviceName, {
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0,
      eventType
    });
    
    res.json({
      success: true,
      serviceName,
      events,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get circuit breaker events', { error: error.message });
    res.status(500).json({ error: 'Failed to get events' });
  }
});

/**
 * 获取熔断器状态趋势
 * GET /api/v1/circuit-breakers/:serviceName/trends
 */
router.get('/:serviceName/trends', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { hours } = req.query;
    
    const trends = await registry.getStateTrends(serviceName, parseInt(hours) || 24);
    
    res.json({
      success: true,
      serviceName,
      trends,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get circuit breaker trends', { error: error.message });
    res.status(500).json({ error: 'Failed to get trends' });
  }
});

/**
 * 手动打开熔断器（管理员）
 * POST /api/v1/circuit-breakers/:serviceName/:endpoint/open
 */
router.post('/:serviceName/:endpoint/open', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { serviceName, endpoint } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;
    
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }
    
    await registry.forceOpen(serviceName, endpoint, reason, userId);
    
    res.json({
      success: true,
      message: `Circuit breaker ${serviceName}:${endpoint} opened`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to open circuit breaker', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动关闭熔断器（管理员）
 * POST /api/v1/circuit-breakers/:serviceName/:endpoint/close
 */
router.post('/:serviceName/:endpoint/close', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { serviceName, endpoint } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;
    
    if (!reason) {
      return res.status(400).json({ error: 'Reason is required' });
    }
    
    await registry.forceClose(serviceName, endpoint, reason, userId);
    
    res.json({
      success: true,
      message: `Circuit breaker ${serviceName}:${endpoint} closed`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to close circuit breaker', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新熔断器配置（管理员）
 * PUT /api/v1/circuit-breakers/:serviceName/:endpoint/config
 */
router.put('/:serviceName/:endpoint/config', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { serviceName, endpoint } = req.params;
    const config = req.body;
    const userId = req.user.id;
    
    await registry.updateConfig(serviceName, endpoint, config, userId);
    
    res.json({
      success: true,
      message: `Circuit breaker ${serviceName}:${endpoint} config updated`,
      config,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to update circuit breaker config', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * WebSocket 实时状态推送
 * WebSocket /api/v1/circuit-breakers/ws
 */
router.setupWebSocket = (server) => {
  const WebSocket = require('ws');
  const wss = new WebSocket.Server({ server, path: '/api/v1/circuit-breakers/ws' });
  
  wss.on('connection', (ws) => {
    registry.addWsClient(ws);
    
    // 发送初始状态
    ws.send(JSON.stringify({
      type: 'initial_state',
      data: registry.getAllStates(),
      timestamp: new Date().toISOString()
    }));
    
    ws.on('error', (error) => {
      logger.error('WebSocket error', { error: error.message });
    });
  });
};

module.exports = router;
```

### 4.4 Admin Dashboard 页面

```html
<!-- frontend/admin-dashboard/circuit-breakers.html -->

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Circuit Breaker Dashboard - mineGo Admin</title>
    <link href="/css/admin.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <div class="admin-container">
        <nav class="admin-nav">
            <h1>⚡ Circuit Breaker Dashboard</h1>
            <div class="nav-actions">
                <span id="connection-status" class="status-indicator disconnected">Disconnected</span>
                <button onclick="refreshAll()" class="btn btn-secondary">Refresh</button>
            </div>
        </nav>

        <!-- Summary Cards -->
        <div class="summary-cards">
            <div class="card status-closed">
                <h3>Closed (Healthy)</h3>
                <span id="closed-count" class="count">0</span>
            </div>
            <div class="card status-half-open">
                <h3>Half-Open (Recovering)</h3>
                <span id="halfopen-count" class="count">0</span>
            </div>
            <div class="card status-open">
                <h3>Open (Failed)</h3>
                <span id="open-count" class="count">0</span>
            </div>
        </div>

        <!-- Service Grid -->
        <div class="service-grid" id="service-grid">
            <!-- Dynamically populated -->
        </div>

        <!-- Event Log -->
        <div class="event-log">
            <h2>Recent Events</h2>
            <div id="event-list" class="event-list">
                <!-- Dynamically populated -->
            </div>
        </div>

        <!-- Trend Chart -->
        <div class="chart-container">
            <h2>Failure Rate Trend (24h)</h2>
            <canvas id="trend-chart"></canvas>
        </div>
    </div>

    <script>
        let ws;
        let trendChart;
        const services = {};

        // Initialize WebSocket
        function initWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(`${protocol}//${window.location.host}/api/v1/circuit-breakers/ws`);
            
            ws.onopen = () => {
                document.getElementById('connection-status').className = 'status-indicator connected';
                document.getElementById('connection-status').textContent = 'Connected';
            };
            
            ws.onclose = () => {
                document.getElementById('connection-status').className = 'status-indicator disconnected';
                document.getElementById('connection-status').textContent = 'Disconnected';
                setTimeout(initWebSocket, 5000);
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleMessage(message);
            };
        }

        // Handle WebSocket messages
        function handleMessage(message) {
            switch (message.type) {
                case 'initial_state':
                    renderAllStates(message.data);
                    break;
                case 'state_change':
                    updateState(message);
                    break;
                case 'stats_update':
                    updateStats(message);
                    break;
            }
        }

        // Render all circuit breaker states
        function renderAllStates(data) {
            const grid = document.getElementById('service-grid');
            grid.innerHTML = '';
            
            const summary = { closed: 0, halfOpen: 0, open: 0 };
            
            for (const [serviceName, breakers] of Object.entries(data)) {
                const serviceCard = document.createElement('div');
                serviceCard.className = 'service-card';
                serviceCard.id = `service-${serviceName}`;
                
                let breakersHtml = '';
                for (const breaker of breakers) {
                    summary[breaker.state === 'half-open' ? 'halfOpen' : breaker.state]++;
                    
                    breakersHtml += `
                        <div class="breaker-item ${breaker.state}" id="breaker-${serviceName}-${breaker.endpoint}">
                            <div class="breaker-header">
                                <span class="endpoint">${breaker.endpoint}</span>
                                <span class="state-badge ${breaker.state}">${breaker.state}</span>
                            </div>
                            <div class="breaker-stats">
                                <div class="stat">
                                    <label>Failure Rate</label>
                                    <span>${(breaker.failureRate * 100).toFixed(1)}%</span>
                                </div>
                                <div class="stat">
                                    <label>Avg Response</label>
                                    <span>${breaker.avgResponseTime || 0}ms</span>
                                </div>
                                <div class="stat">
                                    <label>Failures</label>
                                    <span>${breaker.failureCount}</span>
                                </div>
                            </div>
                            <div class="breaker-actions">
                                ${breaker.state === 'open' ? 
                                    `<button onclick="forceClose('${serviceName}', '${breaker.endpoint}')" class="btn btn-sm btn-success">Force Close</button>` :
                                    `<button onclick="forceOpen('${serviceName}', '${breaker.endpoint}')" class="btn btn-sm btn-danger">Force Open</button>`
                                }
                                <button onclick="showConfig('${serviceName}', '${breaker.endpoint}')" class="btn btn-sm btn-secondary">Config</button>
                            </div>
                        </div>
                    `;
                }
                
                serviceCard.innerHTML = `
                    <h3 class="service-name">${serviceName}</h3>
                    <div class="breakers-list">${breakersHtml}</div>
                `;
                
                grid.appendChild(serviceCard);
            }
            
            // Update summary
            document.getElementById('closed-count').textContent = summary.closed;
            document.getElementById('halfopen-count').textContent = summary.halfOpen;
            document.getElementById('open-count').textContent = summary.open;
        }

        // Update single breaker state
        function updateState(message) {
            const breakerEl = document.getElementById(`breaker-${message.serviceName}-${message.endpoint}`);
            if (breakerEl) {
                breakerEl.className = `breaker-item ${message.toState}`;
                breakerEl.querySelector('.state-badge').textContent = message.toState;
                addEventLog(message);
            }
        }

        // Add event to log
        function addEventLog(event) {
            const eventList = document.getElementById('event-list');
            const eventEl = document.createElement('div');
            eventEl.className = `event-item ${event.toState || event.eventType}`;
            
            eventEl.innerHTML = `
                <span class="event-time">${new Date().toLocaleTimeString()}</span>
                <span class="event-service">${event.serviceName}:${event.endpoint}</span>
                <span class="event-type">${event.toState ? `${event.fromState} → ${event.toState}` : event.eventType}</span>
            `;
            
            eventList.insertBefore(eventEl, eventList.firstChild);
            
            // Keep only last 50 events
            while (eventList.children.length > 50) {
                eventList.removeChild(eventList.lastChild);
            }
        }

        // Force open circuit breaker
        async function forceOpen(serviceName, endpoint) {
            const reason = prompt('Enter reason for opening:');
            if (!reason) return;
            
            try {
                const response = await fetch(`/api/v1/circuit-breakers/${serviceName}/${endpoint}/open`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason })
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('Circuit breaker opened successfully');
                }
            } catch (error) {
                alert('Failed to open circuit breaker: ' + error.message);
            }
        }

        // Force close circuit breaker
        async function forceClose(serviceName, endpoint) {
            const reason = prompt('Enter reason for closing:');
            if (!reason) return;
            
            try {
                const response = await fetch(`/api/v1/circuit-breakers/${serviceName}/${endpoint}/close`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason })
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('Circuit breaker closed successfully');
                }
            } catch (error) {
                alert('Failed to close circuit breaker: ' + error.message);
            }
        }

        // Initialize on load
        document.addEventListener('DOMContentLoaded', () => {
            initWebSocket();
            initTrendChart();
        });
    </script>
</body>
</html>
```

### 4.5 Prometheus 指标

```yaml
# infrastructure/k8s/monitoring/circuit-breaker-alerts.yaml

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: circuit-breaker-alerts
  namespace: monitoring
spec:
  groups:
    - name: circuit_breaker.rules
      rules:
        - alert: CircuitBreakerOpen
          expr: circuit_breaker_state == 1
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Circuit breaker is open for {{ $labels.service }}:{{ $labels.endpoint }}"
            description: "Circuit breaker has been open for more than 1 minute"
        
        - alert: CircuitBreakerHighFailureRate
          expr: circuit_breaker_failure_rate > 0.5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High failure rate for {{ $labels.service }}:{{ $labels.endpoint }}"
            description: "Failure rate is {{ $value }}%, threshold is 50%"
        
        - alert: CircuitBreakerFrequentStateChanges
          expr: increase(circuit_breaker_state_changes_total[1h]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Circuit breaker {{ $labels.service }}:{{ $labels.endpoint }} is unstable"
            description: "State changed {{ $value }} times in the last hour"
```

## 5. 验收标准（可测试）

- [ ] 仪表板实时显示所有服务的熔断器状态
- [ ] WebSocket 连接状态正确指示（连接/断开）
- [ ] 状态变化时，WebSocket 推送延迟 < 1 秒
- [ ] 支持手动打开/关闭熔断器（需管理员权限）
- [ ] 支持熔断器配置热更新
- [ ] 事件历史可查询最近 1000 条记录
- [ ] 趋势图正确展示 24 小时内的失败率变化
- [ ] Prometheus 指标正确导出
- [ ] 告警规则在熔断器打开时触发
- [ ] API 响应时间 < 200ms

## 6. 工作量估算

**M（中等）** - 约 2-3 天

理由：
- 核心逻辑（Registry）较简单
- API 端点标准化，开发快速
- Dashboard 前端需要一定工作量
- 需要与现有 CircuitBreaker.js 集成

## 7. 优先级理由

**P1** - 对运维和稳定性至关重要：

1. **故障快速定位**：熔断器打开通常意味着服务不可用，需要立即知道
2. **减少 MTTR**：可视化仪表板大大缩短故障发现和响应时间
3. **预防连锁故障**：及时发现熔断触发，防止故障扩散
4. **配置灵活性**：远程调整熔断参数，无需重启服务
