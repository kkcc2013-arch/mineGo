# REQ-00381：WebSocket 实时通信压力测试与并发安全验证系统

- **编号**：REQ-00381
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、catch-service、gateway、backend/tests/load、backend/shared/websocket、infrastructure/k8s、.github/workflows
- **创建时间**：2026-06-30 06:15 UTC
- **依赖需求**：REQ-00033（API 压力测试）、REQ-00290（WebSocket 连接池优化）、REQ-00329（WebSocket 性能优化）

## 1. 背景与问题

mineGo 项目中 gym-service 和 catch-service 依赖 WebSocket 实现实时对战、精灵捕捉同步等核心功能，但在 WebSocket 压力测试和并发安全验证方面存在以下问题：

### 1.1 压力测试覆盖不足
- 现有压力测试（REQ-00033）主要针对 REST API，缺少 WebSocket 长连接场景测试
- 无法验证高并发下 WebSocket 消息处理的稳定性和延迟表现
- 缺少模拟大规模玩家同时在线的实时对战场景测试

### 1.2 并发安全验证缺失
- WebSocket 消息处理缺少并发安全测试，可能存在竞态条件
- 多房间/多对战同时进行时的状态同步问题未经验证
- 消息顺序性保障机制缺乏压力验证

### 1.3 边界条件测试不完整
- 连接断开重连场景缺乏系统性测试
- 消息积压和背压处理缺少验证
- 心跳超时、网络抖动等异常场景覆盖不足

### 1.4 性能基线缺失
- WebSocket 连接数、消息吞吐量的性能基线未建立
- 不同负载等级下的资源消耗和延迟指标不明确
- 缺少可量化的性能退化检测机制

## 2. 目标

建立 WebSocket 实时通信压力测试与并发安全验证系统：

1. **WebSocket 压力测试框架**：支持大规模并发连接、消息洪泛、混合场景测试
2. **并发安全验证套件**：检测竞态条件、状态同步问题、消息顺序性
3. **异常场景覆盖**：断线重连、网络抖动、消息积压、心跳超时等
4. **性能基线建立**：建立可量化的 WebSocket 性能指标和退化检测

**预期收益：**
- WebSocket 服务稳定性提升 50%
- 并发缺陷发现率提升 80%
- 生产环境 WebSocket 故障率降低 60%
- 建立完善的 WebSocket 性能基线

## 3. 范围

### 包含
- WebSocket 压力测试框架（连接压力、消息压力、混合场景）
- 并发安全测试套件（竞态检测、状态一致性、消息顺序性）
- 异常场景测试（断线重连、网络抖动、背压处理）
- 性能基线建立与回归检测
- CI/CD 集成（夜间压力测试）
- 测试报告与可视化仪表板

### 不包含
- REST API 压力测试（已由 REQ-00033 覆盖）
- 前端 E2E 测试（已由 REQ-00036 覆盖）
- 混沌工程测试（已由 REQ-00292 覆盖）
- 安全渗透测试（作为后续独立需求）

## 4. 详细需求

### 4.1 WebSocket 压力测试框架

**实现位置**：`backend/tests/load/websocket/`

```javascript
/**
 * WebSocket 压力测试框架
 * 支持 Artillery 和自定义脚本两种模式
 */

// backend/tests/load/websocket/websocketLoadTest.js
const WebSocket = require('ws');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { createLogger } = require('../../../shared/logger');
const { performance } = require('perf_hooks');

const logger = createLogger('ws-load-test');

/**
 * WebSocket 压力测试配置
 */
const LOAD_TEST_CONFIG = {
  // 连接压力测试
  connection: {
    maxConnections: 10000,          // 最大并发连接数
    rampUp: 60,                      // 爬升时间（秒）
    sustain: 300,                    // 持续时间（秒）
    rampDown: 30,                    // 下降时间（秒）
    targetUrl: process.env.WS_URL || 'ws://localhost:8085/ws',
  },
  
  // 消息压力测试
  message: {
    ratePerSecond: 1000,             // 每秒消息数
    messageTypes: ['battle_action', 'position_update', 'chat', 'ping'],
    payloadSize: {
      min: 64,                        // 最小消息大小（字节）
      max: 4096,                      // 最大消息大小（字节）
    },
  },
  
  // 混合场景配置
  mixed: {
    battleRooms: 100,                 // 模拟对战房间数
    playersPerRoom: { min: 2, max: 6 },
    actionsPerSecond: { min: 1, max: 10 },
    duration: 600,                    // 持续时间（秒）
  },
  
  // 异常注入
  chaos: {
    disconnectRate: 0.01,             // 每秒断连率
    reconnectDelay: { min: 100, max: 5000 },
    messageLoss: 0.001,               // 消息丢失率
    latencyInjection: { min: 10, max: 500 },  // 延迟注入
  }
};

/**
 * WebSocket 客户端模拟器
 */
class WebSocketClientSimulator {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.connected = false;
    this.messageQueue = [];
    this.metrics = {
      messagesSent: 0,
      messagesReceived: 0,
      latencySamples: [],
      errors: [],
    };
    this.roomId = null;
    this.playerId = `player-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 建立 WebSocket 连接
   */
  async connect() {
    return new Promise((resolve, reject) => {
      const startTime = performance.now();
      
      this.ws = new WebSocket(this.config.targetUrl, {
        headers: {
          'Authorization': `Bearer ${this.generateTestToken()}`,
          'X-Player-Id': this.playerId,
        },
      });
      
      this.ws.on('open', () => {
        this.connected = true;
        this.metrics.connectionTime = performance.now() - startTime;
        resolve();
      });
      
      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });
      
      this.ws.on('error', (err) => {
        this.metrics.errors.push({
          type: 'connection_error',
          message: err.message,
          timestamp: Date.now(),
        });
        reject(err);
      });
      
      this.ws.on('close', () => {
        this.connected = false;
      });
    });
  }

  /**
   * 处理接收的消息
   */
  handleMessage(data) {
    const receiveTime = performance.now();
    try {
      const message = JSON.parse(data.toString());
      this.metrics.messagesReceived++;
      
      // 计算往返延迟
      if (message.type === 'pong' && message.timestamp) {
        const latency = receiveTime - message.timestamp;
        this.metrics.latencySamples.push(latency);
      }
      
      // 处理房间分配
      if (message.type === 'room_assigned') {
        this.roomId = message.roomId;
      }
    } catch (err) {
      this.metrics.errors.push({
        type: 'parse_error',
        message: err.message,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * 发送消息
   */
  async sendMessage(type, payload = {}) {
    if (!this.connected) {
      throw new Error('WebSocket not connected');
    }
    
    const message = {
      type,
      payload,
      timestamp: performance.now(),
      playerId: this.playerId,
      roomId: this.roomId,
    };
    
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          this.metrics.errors.push({
            type: 'send_error',
            message: err.message,
            timestamp: Date.now(),
          });
          reject(err);
        } else {
          this.metrics.messagesSent++;
          resolve();
        }
      });
    });
  }

  /**
   * 模拟战斗动作
   */
  async sendBattleAction(action) {
    return this.sendMessage('battle_action', {
      action: action.type,
      targetId: action.targetId,
      skillId: action.skillId,
      position: action.position,
      timestamp: Date.now(),
    });
  }

  /**
   * 发送位置更新
   */
  async sendPositionUpdate(lat, lng) {
    return this.sendMessage('position_update', {
      latitude: lat,
      longitude: lng,
      accuracy: Math.random() * 10 + 5,
      timestamp: Date.now(),
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.connected = false;
    }
  }

  /**
   * 生成测试用 JWT Token
   */
  generateTestToken() {
    const jwt = require('jsonwebtoken');
    return jwt.sign(
      { userId: this.playerId, role: 'player' },
      process.env.JWT_SECRET || 'test-secret-key-for-load-testing',
      { expiresIn: '1h' }
    );
  }

  /**
   * 获取指标
   */
  getMetrics() {
    const latencyStats = this.calculateLatencyStats();
    return {
      ...this.metrics,
      ...latencyStats,
    };
  }

  calculateLatencyStats() {
    if (this.metrics.latencySamples.length === 0) {
      return { latency: null };
    }
    
    const samples = this.metrics.latencySamples;
    samples.sort((a, b) => a - b);
    
    return {
      latency: {
        min: samples[0],
        max: samples[samples.length - 1],
        avg: samples.reduce((a, b) => a + b, 0) / samples.length,
        p50: samples[Math.floor(samples.length * 0.5)],
        p90: samples[Math.floor(samples.length * 0.9)],
        p99: samples[Math.floor(samples.length * 0.99)],
      },
    };
  }
}

/**
 * WebSocket 压力测试运行器
 */
class WebSocketLoadTestRunner {
  constructor(config) {
    this.config = { ...LOAD_TEST_CONFIG, ...config };
    this.clients = [];
    this.metrics = {
      startTime: null,
      endTime: null,
      totalConnections: 0,
      activeConnections: 0,
      messagesSent: 0,
      messagesReceived: 0,
      errors: [],
      latencyDistribution: [],
    };
  }

  /**
   * 运行连接压力测试
   */
  async runConnectionTest() {
    logger.info('Starting WebSocket connection pressure test...');
    this.metrics.startTime = Date.now();
    
    const { maxConnections, rampUp, sustain, rampDown } = this.config.connection;
    
    // 爬升阶段 - 逐步增加连接
    logger.info(`Ramp-up phase: creating ${maxConnections} connections over ${rampUp}s`);
    for (let i = 0; i < maxConnections; i++) {
      const client = new WebSocketClientSimulator(this.config.connection);
      
      try {
        await client.connect();
        this.clients.push(client);
        this.metrics.totalConnections++;
        this.metrics.activeConnections++;
        
        // 间隔创建，模拟真实爬升
        await this.sleep(rampUp * 1000 / maxConnections);
        
        // 每 100 个连接打印进度
        if ((i + 1) % 100 === 0) {
          logger.info(`Created ${i + 1}/${maxConnections} connections`);
        }
      } catch (err) {
        this.metrics.errors.push({
          phase: 'ramp_up',
          connectionIndex: i,
          error: err.message,
        });
      }
    }
    
    // 持续阶段 - 保持连接活跃
    logger.info(`Sustain phase: maintaining connections for ${sustain}s`);
    const sustainStart = Date.now();
    while (Date.now() - sustainStart < sustain * 1000) {
      // 每秒发送心跳
      for (const client of this.clients) {
        if (client.connected) {
          try {
            await client.sendMessage('ping');
          } catch (err) {
            // 忽略发送错误
          }
        }
      }
      await this.sleep(1000);
      
      // 注入随机断连（混沌测试）
      this.injectRandomDisconnects();
    }
    
    // 下降阶段 - 逐步断开连接
    logger.info(`Ramp-down phase: closing connections over ${rampDown}s`);
    const disconnectInterval = rampDown * 1000 / this.clients.length;
    for (const client of this.clients) {
      client.disconnect();
      this.metrics.activeConnections--;
      await this.sleep(disconnectInterval);
    }
    
    this.metrics.endTime = Date.now();
    return this.generateReport();
  }

  /**
   * 运行消息压力测试
   */
  async runMessageTest() {
    logger.info('Starting WebSocket message pressure test...');
    
    // 先建立基础连接
    await this.establishBaselineConnections(1000);
    
    const { ratePerSecond, duration: 60 } = { ...this.config.message, duration: 60 };
    const totalMessages = ratePerSecond * 60;
    
    logger.info(`Sending ${totalMessages} messages at ${ratePerSecond} msg/s`);
    
    const startTime = Date.now();
    let messagesSent = 0;
    
    while (messagesSent < totalMessages) {
      const batchStartTime = Date.now();
      
      // 发送一批消息
      const batchSize = Math.min(ratePerSecond, totalMessages - messagesSent);
      const promises = [];
      
      for (let i = 0; i < batchSize; i++) {
        const client = this.clients[Math.floor(Math.random() * this.clients.length)];
        if (client.connected) {
          const messageType = this.config.message.messageTypes[
            Math.floor(Math.random() * this.config.message.messageTypes.length)
          ];
          promises.push(this.sendRandomMessage(client, messageType));
        }
      }
      
      await Promise.allSettled(promises);
      messagesSent += batchSize;
      
      // 控制发送速率
      const elapsed = Date.now() - batchStartTime;
      if (elapsed < 1000) {
        await this.sleep(1000 - elapsed);
      }
      
      // 每秒打印进度
      if (messagesSent % ratePerSecond === 0) {
        logger.info(`Sent ${messagesSent}/${totalMessages} messages`);
      }
    }
    
    return this.generateReport();
  }

  /**
   * 运行混合场景测试
   */
  async runMixedScenarioTest() {
    logger.info('Starting WebSocket mixed scenario test...');
    
    const { battleRooms, playersPerRoom, actionsPerSecond, duration } = this.config.mixed;
    
    // 创建多个对战房间
    const rooms = [];
    for (let i = 0; i < battleRooms; i++) {
      const roomId = `room-${i}`;
      const playerCount = Math.floor(
        Math.random() * (playersPerRoom.max - playersPerRoom.min + 1)
      ) + playersPerRoom.min;
      
      // 为每个房间创建玩家
      const roomClients = [];
      for (let j = 0; j < playerCount; j++) {
        const client = new WebSocketClientSimulator(this.config.connection);
        await client.connect();
        client.roomId = roomId;
        roomClients.push(client);
        this.clients.push(client);
        this.metrics.totalConnections++;
      }
      
      rooms.push({
        roomId,
        clients: roomClients,
        phase: 'waiting',
        battleStartTime: null,
      });
    }
    
    logger.info(`Created ${battleRooms} battle rooms with ${this.clients.length} total players`);
    
    // 运行模拟对战
    const testDuration = duration * 1000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < testDuration) {
      for (const room of rooms) {
        await this.simulateBattleTurn(room);
      }
      await this.sleep(100);  // 每 100ms 处理一轮
    }
    
    return this.generateReport();
  }

  /**
   * 模拟对战回合
   */
  async simulateBattleTurn(room) {
    const { actionsPerSecond } = this.config.mixed;
    const actionCount = Math.floor(
      Math.random() * (actionsPerSecond.max - actionsPerSecond.min + 1)
    ) + actionsPerSecond.min;
    
    // 随机选择玩家发送动作
    const shuffled = room.clients.sort(() => Math.random() - 0.5);
    
    for (let i = 0; i < Math.min(actionCount, shuffled.length); i++) {
      const client = shuffled[i];
      if (client.connected && Math.random() > 0.3) {  // 70% 概率发送动作
        try {
          const action = this.generateRandomBattleAction();
          await client.sendBattleAction(action);
          this.metrics.messagesSent++;
        } catch (err) {
          this.metrics.errors.push({
            roomId: room.roomId,
            playerId: client.playerId,
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * 生成随机战斗动作
   */
  generateRandomBattleAction() {
    const actions = ['attack', 'defend', 'dodge', 'use_skill', 'switch_pokemon'];
    const action = actions[Math.floor(Math.random() * actions.length)];
    
    return {
      type: action,
      targetId: `target-${Math.floor(Math.random() * 10)}`,
      skillId: action === 'use_skill' ? `skill-${Math.floor(Math.random() * 100)}` : null,
      position: {
        x: Math.random() * 100,
        y: Math.random() * 100,
      },
    };
  }

  /**
   * 注入随机断连（混沌测试）
   */
  injectRandomDisconnects() {
    const { disconnectRate, reconnectDelay } = this.config.chaos;
    
    for (const client of this.clients) {
      if (client.connected && Math.random() < disconnectRate) {
        // 模拟断连
        client.disconnect();
        
        // 异步重连
        setTimeout(async () => {
          const delay = Math.random() * (reconnectDelay.max - reconnectDelay.min) + reconnectDelay.min;
          await this.sleep(delay);
          try {
            await client.connect();
          } catch (err) {
            // 重连失败
          }
        }, 0);
      }
    }
  }

  /**
   * 建立基准连接
   */
  async establishBaselineConnections(count) {
    logger.info(`Establishing ${count} baseline connections...`);
    
    for (let i = 0; i < count; i++) {
      const client = new WebSocketClientSimulator(this.config.connection);
      try {
        await client.connect();
        this.clients.push(client);
        this.metrics.totalConnections++;
      } catch (err) {
        this.metrics.errors.push({
          phase: 'baseline_connection',
          error: err.message,
        });
      }
    }
  }

  /**
   * 发送随机消息
   */
  async sendRandomMessage(client, type) {
    const payload = this.generateRandomPayload(type);
    await client.sendMessage(type, payload);
    this.metrics.messagesSent++;
  }

  /**
   * 生成随机负载
   */
  generateRandomPayload(type) {
    const { min, max } = this.config.message.payloadSize;
    const size = Math.floor(Math.random() * (max - min + 1)) + min;
    
    switch (type) {
      case 'battle_action':
        return this.generateRandomBattleAction();
      case 'position_update':
        return {
          latitude: Math.random() * 180 - 90,
          longitude: Math.random() * 360 - 180,
        };
      case 'chat':
        return {
          message: 'x'.repeat(size - 50),
          channel: 'global',
        };
      default:
        return { data: 'x'.repeat(size) };
    }
  }

  /**
   * 生成测试报告
   */
  generateReport() {
    const clientMetrics = this.clients.map(c => c.getMetrics());
    
    const aggregatedLatency = this.aggregateLatency(clientMetrics);
    
    return {
      testDuration: (this.metrics.endTime - this.metrics.startTime) / 1000,
      connections: {
        total: this.metrics.totalConnections,
        peak: Math.max(...this.clients.map((_, i) => i + 1)),
        errors: this.metrics.errors.filter(e => e.phase?.includes('connection')).length,
      },
      messages: {
        sent: this.metrics.messagesSent,
        received: clientMetrics.reduce((sum, c) => sum + c.messagesReceived, 0),
        errors: this.metrics.errors.filter(e => e.type?.includes('message')).length,
      },
      latency: aggregatedLatency,
      errors: this.metrics.errors.slice(0, 100),  // 只保留前 100 个错误
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 聚合延迟数据
   */
  aggregateLatency(clientMetrics) {
    const allSamples = clientMetrics
      .filter(c => c.latency)
      .flatMap(c => c.latencySamples);
    
    if (allSamples.length === 0) {
      return null;
    }
    
    allSamples.sort((a, b) => a - b);
    
    return {
      min: allSamples[0],
      max: allSamples[allSamples.length - 1],
      avg: allSamples.reduce((a, b) => a + b, 0) / allSamples.length,
      p50: allSamples[Math.floor(allSamples.length * 0.5)],
      p90: allSamples[Math.floor(allSamples.length * 0.9)],
      p99: allSamples[Math.floor(allSamples.length * 0.99)],
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = {
  WebSocketClientSimulator,
  WebSocketLoadTestRunner,
  LOAD_TEST_CONFIG,
};
```

### 4.2 并发安全测试套件

**实现位置**：`backend/tests/concurrency/websocketConcurrency.test.js`

```javascript
/**
 * WebSocket 并发安全测试套件
 * 检测竞态条件、状态同步问题、消息顺序性
 */

const { WebSocketClientSimulator } = require('../load/websocket/websocketLoadTest');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('ws-concurrency-test');

describe('WebSocket Concurrency Safety Tests', () => {
  let clients = [];
  const baseUrl = process.env.WS_URL || 'ws://localhost:8085/ws';
  
  beforeEach(async () => {
    clients = [];
  });
  
  afterEach(async () => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  describe('Race Condition Detection', () => {
    
    test('should handle concurrent battle actions without race conditions', async () => {
      // 创建两个玩家同时攻击同一目标
      const attacker1 = new WebSocketClientSimulator({ targetUrl: baseUrl });
      const attacker2 = new WebSocketClientSimulator({ targetUrl: baseUrl });
      
      await attacker1.connect();
      await attacker2.connect();
      
      clients.push(attacker1, attacker2);
      
      // 同时发送攻击动作
      const targetId = 'target-123';
      const battleActions = [
        attacker1.sendBattleAction({ type: 'attack', targetId, skillId: 'skill-1' }),
        attacker2.sendBattleAction({ type: 'attack', targetId, skillId: 'skill-2' }),
      ];
      
      await Promise.allSettled(battleActions);
      
      // 等待服务器处理
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 验证目标只受到一次伤害（或按预期顺序）
      const metrics1 = attacker1.getMetrics();
      const metrics2 = attacker2.getMetrics();
      
      // 检查是否有重复处理或丢失
      expect(metrics1.errors.filter(e => e.type === 'race_condition')).toHaveLength(0);
      expect(metrics2.errors.filter(e => e.type === 'race_condition')).toHaveLength(0);
    });
    
    test('should handle concurrent position updates correctly', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      await client.connect();
      clients.push(client);
      
      // 快速发送 100 个位置更新
      const updates = [];
      for (let i = 0; i < 100; i++) {
        updates.push(client.sendPositionUpdate(
          39.9 + Math.random() * 0.01,
          116.4 + Math.random() * 0.01
        ));
      }
      
      await Promise.allSettled(updates);
      
      // 验证最终位置是最新的
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const metrics = client.getMetrics();
      expect(metrics.errors.filter(e => e.type === 'order_violation')).toHaveLength(0);
    });
    
    test('should maintain room state consistency under concurrent joins/leaves', async () => {
      const roomId = 'room-concurrent-test';
      const playerCount = 10;
      
      // 创建多个玩家
      for (let i = 0; i < playerCount; i++) {
        const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
        await client.connect();
        clients.push(client);
      }
      
      // 同时加入房间
      const joinPromises = clients.map(c => c.sendMessage('join_room', { roomId }));
      await Promise.allSettled(joinPromises);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 随机离开
      const leavePromises = clients
        .filter(() => Math.random() > 0.5)
        .map(c => c.sendMessage('leave_room', { roomId }));
      await Promise.allSettled(leavePromises);
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 验证房间状态一致性
      const errors = clients.flatMap(c => c.getMetrics().errors);
      expect(errors.filter(e => e.type === 'state_inconsistency')).toHaveLength(0);
    });
  });

  describe('Message Order Verification', () => {
    
    test('should preserve message order within a connection', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      await client.connect();
      clients.push(client);
      
      // 发送带有序号的消息
      const sequence = [];
      for (let i = 0; i < 50; i++) {
        sequence.push(i);
        await client.sendMessage('test_sequence', { sequence: i });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 验证接收顺序
      const metrics = client.getMetrics();
      // 服务端应返回确认，确认顺序应与发送顺序一致
      expect(metrics.messagesReceived).toBeGreaterThanOrEqual(50);
    });
    
    test('should handle out-of-order delivery detection', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      await client.connect();
      clients.push(client);
      
      // 模拟网络延迟导致的乱序
      const messages = [];
      for (let i = 0; i < 10; i++) {
        const delay = Math.random() * 100;
        messages.push(
          new Promise(resolve => setTimeout(resolve, delay))
            .then(() => client.sendMessage('ordered_test', { index: i, sentAt: Date.now() }))
        );
      }
      
      await Promise.all(messages);
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 验证服务端是否正确处理乱序消息
      const metrics = client.getMetrics();
      expect(metrics.errors.filter(e => e.type === 'sequence_error')).toHaveLength(0);
    });
  });

  describe('Connection Resilience Tests', () => {
    
    test('should handle graceful reconnection', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      await client.connect();
      clients.push(client);
      
      // 建立一些状态
      await client.sendMessage('join_room', { roomId: 'reconnect-test' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // 断开连接
      client.disconnect();
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 重新连接
      await client.connect();
      
      // 验证状态恢复
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const metrics = client.getMetrics();
      expect(metrics.connectionTime).toBeDefined();
      expect(metrics.connectionTime).toBeLessThan(2000);  // 重连应在 2 秒内完成
    });
    
    test('should handle multiple rapid reconnections', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      
      for (let i = 0; i < 5; i++) {
        await client.connect();
        await new Promise(resolve => setTimeout(resolve, 100));
        client.disconnect();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // 最后保持连接
      await client.connect();
      clients.push(client);
      
      const metrics = client.getMetrics();
      expect(metrics.errors.filter(e => e.type === 'connection_leak')).toHaveLength(0);
    });
    
    test('should handle heartbeat timeout gracefully', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      await client.connect();
      clients.push(client);
      
      // 模拟心跳超时（不发送心跳）
      await new Promise(resolve => setTimeout(resolve, 35000));  // 假设心跳超时为 30 秒
      
      // 验证连接被正确关闭
      expect(client.connected).toBe(false);
      
      // 验证重连机制
      await new Promise(resolve => setTimeout(resolve, 5000));
      // 应该自动重连
      // expect(client.connected).toBe(true);  // 取决于实现
    });
  });

  describe('Backpressure Handling Tests', () => {
    
    test('should handle message queue overflow', async () => {
      const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
      await client.connect();
      clients.push(client);
      
      // 快速发送大量消息，超过处理能力
      const messageCount = 10000;
      const promises = [];
      
      for (let i = 0; i < messageCount; i++) {
        promises.push(client.sendMessage('stress_test', { index: i }));
      }
      
      const results = await Promise.allSettled(promises);
      const rejected = results.filter(r => r.status === 'rejected');
      
      // 应该有背压机制，而不是直接崩溃
      const metrics = client.getMetrics();
      expect(metrics.errors.filter(e => e.type === 'queue_overflow')).toHaveLength(0);
    });
    
    test('should handle slow consumer scenario', async () => {
      const clients = [];
      for (let i = 0; i < 100; i++) {
        const client = new WebSocketClientSimulator({ targetUrl: baseUrl });
        await client.connect();
        clients.push(client);
      }
      
      // 每个客户端发送消息，但处理速度不同
      const promises = clients.map(async (client, index) => {
        // 随机延迟模拟不同的处理速度
        const delay = Math.random() * 100;
        await new Promise(resolve => setTimeout(resolve, delay));
        
        for (let i = 0; i < 10; i++) {
          await client.sendMessage('slow_consumer_test', { clientId: index, msgIndex: i });
        }
      });
      
      await Promise.allSettled(promises);
      
      // 验证没有客户端被不公平对待
      const metrics = clients.map(c => c.getMetrics());
      const avgReceived = metrics.reduce((sum, m) => sum + m.messagesReceived, 0) / metrics.length;
      
      // 所有客户端应该都能收到消息
      expect(avgReceived).toBeGreaterThan(0);
    });
  });
});
```

### 4.3 Artillery WebSocket 测试配置

**实现位置**：`backend/tests/load/websocket/artillery-websocket.yml`

```yaml
config:
  target: 'ws://localhost:8085'
  phases:
    # 连接压力测试
    - name: 'Connection Ramp-up'
      duration: 60
      arrivalRate: 50
      rampTo: 500
      ws:
        headers:
          Authorization: 'Bearer {{ $jwtToken }}'
    
    # 消息压力测试
    - name: 'Message Flood'
      duration: 120
      arrivalRate: 100
      engine: 'ws'
      
    # 持续负载
    - name: 'Sustained Load'
      duration: 300
      arrivalRate: 200
      
  variables:
    jwtToken: '{{ $processEnvironment.JWT_TOKEN }}'
    
  engines:
    ws:
      # WebSocket 配置
      pingInterval: 30
      pongTimeout: 10000

scenarios:
  # 对战场景
  - name: 'Battle Arena'
    engine: ws
    flow:
      - emit:
          channel: 'battle:join'
          payload:
            roomId: 'arena-{{ $randomNumber }}'
      - think: 1
      - loop:
          - emit:
              channel: 'battle:action'
              payload:
                action: 'attack'
                targetId: 'opponent-1'
                skillId: 'skill-{{ $randomNumber }}'
          - think: 0.5
        count: 100
      - emit:
          channel: 'battle:leave'
          
  # 实时位置同步
  - name: 'Location Sync'
    engine: ws
    flow:
      - emit:
          channel: 'location:update'
          payload:
            latitude: '{{ $randomLatitude }}'
            longitude: '{{ $randomLongitude }}'
            accuracy: 10
      - think: 1
      - loop:
          - emit:
              channel: 'location:update'
              payload:
                latitude: '{{ $randomLatitude }}'
                longitude: '{{ $randomLongitude }}'
          - think: 0.5
        count: 50
        
  # 混合场景
  - name: 'Mixed Activity'
    engine: ws
    weight: 40
    flow:
      - emit:
          channel: 'room:join'
          payload:
            type: 'battle'
      - think: 2
      - emit:
          channel: 'message:send'
          payload:
            content: 'Hello from load test'
      - think: 1
      - emit:
          channel: 'battle:action'
          payload:
            action: 'defend'
      - think: 3
```

### 4.4 CI/CD 夜间压力测试

**实现位置**：`.github/workflows/websocket-load-test.yml`

```yaml
name: WebSocket Nightly Load Test

on:
  schedule:
    - cron: '0 2 * * *'  # 每天凌晨 2 点（UTC）
  workflow_dispatch:
    inputs:
      test_type:
        description: 'Test type'
        required: true
        default: 'all'
        type: choice
        options:
          - all
          - connection
          - message
          - mixed

jobs:
  websocket-load-test:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: minego_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s

    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
        working-directory: backend
      
      - name: Generate test JWT tokens
        run: |
          node -e "
          const jwt = require('jsonwebtoken');
          const token = jwt.sign(
            { userId: 'load-test-user', role: 'player' },
            process.env.JWT_SECRET || 'test-secret',
            { expiresIn: '24h' }
          );
          console.log('JWT_TOKEN=' + token);
          " >> $GITHUB_ENV
      
      - name: Run WebSocket connection test
        if: inputs.test_type == 'connection' || inputs.test_type == 'all'
        run: |
          node backend/tests/load/websocket/websocketLoadTest.js --type=connection --output=connection-report.json
      
      - name: Run WebSocket message test
        if: inputs.test_type == 'message' || inputs.test_type == 'all'
        run: |
          node backend/tests/load/websocket/websocketLoadTest.js --type=message --output=message-report.json
      
      - name: Run mixed scenario test
        if: inputs.test_type == 'mixed' || inputs.test_type == 'all'
        run: |
          node backend/tests/load/websocket/websocketLoadTest.js --type=mixed --output=mixed-report.json
      
      - name: Upload test reports
        uses: actions/upload-artifact@v4
        with:
          name: websocket-load-test-reports
          path: |
            *-report.json
            *.log
      
      - name: Check performance baselines
        run: |
          node backend/tests/load/websocket/checkBaselines.js --reports=*-report.json
      
      - name: Notify on failure
        if: failure()
        uses: slackapi/slack-github-action@v1.25.0
        with:
          payload: |
            {
              "text": "🔴 WebSocket 压力测试失败",
              "blocks": [
                {
                  "type": "section",
                  "text": {
                    "type": "mrkdwn",
                    "text": "*WebSocket Nightly Load Test Failed*\n分支: ${{ github.ref }}\n提交: ${{ github.sha }}"
                  }
                }
              ]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### 4.5 性能基线与回归检测

**实现位置**：`backend/tests/load/websocket/baselines.json`

```json
{
  "connection": {
    "maxConnections": 10000,
    "connectionTime": {
      "p50": 100,
      "p90": 500,
      "p99": 2000
    },
    "errorRate": 0.001
  },
  "message": {
    "throughput": 10000,
    "latency": {
      "p50": 10,
      "p90": 50,
      "p99": 200
    },
    "dropRate": 0.0001
  },
  "battle": {
    "roomCapacity": 6,
    "actionLatency": {
      "p50": 20,
      "p90": 100,
      "p99": 300
    },
    "syncDelay": 50
  },
  "resources": {
    "cpu": {
      "max": 80,
      "avg": 40
    },
    "memory": {
      "max": 2048,
      "avg": 512
    },
    "connections": {
      "max": 15000
    }
  }
}
```

## 5. 验收标准

- [ ] **压力测试框架完整**
  - [ ] 支持 10000+ 并发连接测试
  - [ ] 支持消息洪泛测试（1000 msg/s）
  - [ ] 支持混合场景测试（对战+位置+聊天）
  - [ ] 支持混沌注入（随机断连、延迟、丢包）

- [ ] **并发安全测试覆盖**
  - [ ] 竞态条件检测测试通过
  - [ ] 消息顺序性验证测试通过
  - [ ] 状态一致性测试通过
  - [ ] 背压处理测试通过

- [ ] **异常场景覆盖**
  - [ ] 断线重连测试通过
  - [ ] 心跳超时测试通过
  - [ ] 消息队列溢出测试通过
  - [ ] 慢消费者场景测试通过

- [ ] **性能基线建立**
  - [ ] 连接延迟基线（P50/P90/P99）
  - [ ] 消息吞吐量基线
  - [ ] 资源消耗基线（CPU/内存/连接数）
  - [ ] 回归检测脚本可用

- [ ] **CI/CD 集成**
  - [ ] 夜间压力测试定时运行
  - [ ] 测试报告自动生成
  - [ ] 性能退化自动告警
  - [ ] Slack 失败通知

- [ ] **测试覆盖**
  - [ ] 单元测试覆盖率 >= 85%
  - [ ] 并发测试稳定性 >= 99%
  - [ ] 压力测试通过率 100%

## 6. 工作量估算

**L (Large)**

**理由**：
- 需要开发完整的 WebSocket 压力测试框架
- 实现并发安全测试套件需要深入理解竞态条件
- 建立性能基线需要大量测试数据
- CI/CD 集成和自动化报告
- 预估工时：20-24 小时

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **核心功能验证**：WebSocket 是 gym-service 和 catch-service 的核心通信方式
2. **生产风险**：高并发场景下的 WebSocket 问题可能导致生产故障
3. **测试覆盖缺口**：现有压力测试不覆盖 WebSocket 长连接场景
4. **依赖需求**：为 REQ-00380（安全基线检查）和后续安全自动化测试奠定基础
5. **成熟度提升**：当前成熟度 95/100，完善测试覆盖有助于达成生产可用标准

此需求完成后，项目将具备完善的 WebSocket 实时通信压力测试能力，大幅提升生产环境稳定性。