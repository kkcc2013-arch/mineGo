/**
 * WebSocket 连接池与批处理系统单元测试
 * REQ-00511: WebSocket 长连接连接池管理与高性能消息批处理系统
 */

'use strict';

const { describe, it, expect, beforeEach, afterEach, jest } = require('@jest/globals');
const WebSocketConnectionPool = require('../WebSocketConnectionPool');
const WebSocketBatchSender = require('../WebSocketBatchSender');
const ConnectionRateLimiter = require('../ConnectionRateLimiter');

// Mock WebSocket
class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.isAlive = true;
    this.listeners = {};
    this.sentData = [];
  }
  
  on(event, callback) {
    this.listeners[event] = callback;
  }
  
  send(data) {
    this.sentData.push(data);
  }
  
  ping() {
    // Mock ping
  }
  
  terminate() {
    this.readyState = 3; // CLOSED
  }
  
  close(code, reason) {
    this.readyState = 3;
    if (this.listeners['close']) {
      this.listeners['close']();
    }
  }
  
  // 触发消息事件
  triggerMessage(data) {
    if (this.listeners['message']) {
      this.listeners['message'](data);
    }
  }
  
  // 触发 pong 事件
  triggerPong() {
    if (this.listeners['pong']) {
      this.listeners['pong']();
    }
  }
}

// Mock Redis
const mockRedis = {
  data: new Map(),
  async setex(key, ttl, value) {
    this.data.set(key, { value, ttl });
  },
  async get(key) {
    const entry = this.data.get(key);
    return entry?.value;
  },
  async del(key) {
    this.data.delete(key);
  },
  async keys(pattern) {
    return Array.from(this.data.keys()).filter(k => k.includes(pattern.replace('*', '')));
  }
};

describe('WebSocketConnectionPool', () => {
  let pool;
  
  beforeEach(() => {
    pool = new WebSocketConnectionPool({
      redis: mockRedis,
      maxConnections: 100,
      maxConnectionsPerUser: 5,
      connectionTimeout: 60000
    });
  });
  
  afterEach(() => {
    pool.close();
  });
  
  describe('register', () => {
    it('should register a connection successfully', async () => {
      const ws = new MockWebSocket();
      const result = await pool.register(ws, { userId: 'user1' });
      
      expect(result.success).toBe(true);
      expect(result.connectionId).toBeDefined();
      expect(pool.connections.size).toBe(1);
    });
    
    it('should reject when pool is full', async () => {
      // Fill pool
      for (let i = 0; i < 100; i++) {
        const ws = new MockWebSocket();
        await pool.register(ws, { userId: `user${i}` });
      }
      
      // Try to add another
      const ws = new MockWebSocket();
      await expect(pool.register(ws, { userId: 'extra' }))
        .rejects.toThrow('CONNECTION_POOL_FULL');
    });
    
    it('should reject when user exceeds connection limit', async () => {
      const userId = 'limitedUser';
      
      // Add max connections for same user
      for (let i = 0; i < 5; i++) {
        const ws = new MockWebSocket();
        await pool.register(ws, { userId });
      }
      
      // Try to add another for same user
      const ws = new MockWebSocket();
      await expect(pool.register(ws, { userId }))
        .rejects.toThrow('USER_CONNECTION_LIMIT_EXCEEDED');
    });
    
    it('should track user connections', async () => {
      const userId = 'trackedUser';
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      
      await pool.register(ws1, { userId });
      await pool.register(ws2, { userId });
      
      const connections = pool.getUserConnections(userId);
      expect(connections.length).toBe(2);
    });
  });
  
  describe('unregister', () => {
    it('should unregister connection correctly', async () => {
      const ws = new MockWebSocket();
      const { connectionId } = await pool.register(ws, { userId: 'user1' });
      
      await pool.unregister(connectionId, 'test');
      
      expect(pool.connections.size).toBe(0);
      expect(pool.userConnections.size).toBe(0);
    });
    
    it('should handle invalid connectionId gracefully', async () => {
      await pool.unregister('nonexistent', 'test');
      expect(pool.connections.size).toBe(0);
    });
  });
  
  describe('updateActivity', () => {
    it('should update activity timestamp', async () => {
      const ws = new MockWebSocket();
      const { connectionId } = await pool.register(ws);
      
      const before = pool.get(connectionId).lastActivityAt;
      await new Promise(resolve => setTimeout(resolve, 100));
      pool.updateActivity(connectionId);
      const after = pool.get(connectionId).lastActivityAt;
      
      expect(after).toBeGreaterThan(before);
    });
  });
  
  describe('getStatus', () => {
    it('should return correct status', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      
      await pool.register(ws1, { userId: 'user1' });
      await pool.register(ws2, { userId: 'user2' });
      
      const status = pool.getStatus();
      
      expect(status.currentConnections).toBe(2);
      expect(status.uniqueUsers).toBe(2);
      expect(status.utilization).toBe(0.02);
    });
  });
});

describe('WebSocketBatchSender', () => {
  let batchSender;
  
  beforeEach(() => {
    batchSender = new WebSocketBatchSender({
      batchSize: 5,
      batchTimeout: 100,
      maxBufferSize: 100
    });
  });
  
  afterEach(() => {
    batchSender.close();
  });
  
  describe('enqueue', () => {
    it('should enqueue message successfully', () => {
      const ws = new MockWebSocket();
      const message = { type: 'test', data: 'hello' };
      
      const result = batchSender.enqueue(ws, message, 'normal');
      
      expect(result).toBe(true);
      expect(batchSender.buffers.normal.length).toBe(1);
    });
    
    it('should reject when WebSocket is not open', () => {
      const ws = new MockWebSocket();
      ws.readyState = 3; // CLOSED
      
      const result = batchSender.enqueue(ws, { type: 'test' });
      
      expect(result).toBe(false);
    });
    
    it('should reject when buffer is full', () => {
      const ws = new MockWebSocket();
      
      // Fill buffer
      for (let i = 0; i < 100; i++) {
        batchSender.enqueue(ws, { type: 'test', id: i }, 'normal');
      }
      
      // Try to add another
      const result = batchSender.enqueue(ws, { type: 'test' });
      
      expect(result).toBe(false);
    });
    
    it('should prioritize high priority messages', () => {
      const ws = new MockWebSocket();
      
      batchSender.enqueue(ws, { type: 'low' }, 'low');
      batchSender.enqueue(ws, { type: 'normal' }, 'normal');
      batchSender.enqueue(ws, { type: 'high' }, 'high');
      
      expect(batchSender.buffers.high.length).toBe(1);
      expect(batchSender.buffers.normal.length).toBe(1);
      expect(batchSender.buffers.low.length).toBe(1);
    });
  });
  
  describe('enqueueBatch', () => {
    it('should enqueue multiple messages', () => {
      const ws = new MockWebSocket();
      const messages = [
        { type: 'msg1' },
        { type: 'msg2' },
        { type: 'msg3' }
      ];
      
      const count = batchSender.enqueueBatch(ws, messages, 'normal');
      
      expect(count).toBe(3);
      expect(batchSender.buffers.normal.length).toBe(3);
    });
  });
  
  describe('sendImmediate', () => {
    it('should send message immediately', () => {
      const ws = new MockWebSocket();
      const message = { type: 'immediate', data: 'urgent' };
      
      const result = batchSender.sendImmediate(ws, message);
      
      expect(result).toBe(true);
      expect(ws.sentData.length).toBe(1);
    });
    
    it('should not send when WebSocket is closed', () => {
      const ws = new MockWebSocket();
      ws.readyState = 3;
      
      const result = batchSender.sendImmediate(ws, { type: 'test' });
      
      expect(result).toBe(false);
    });
  });
  
  describe('getStatus', () => {
    it('should return correct status', () => {
      const ws = new MockWebSocket();
      
      batchSender.enqueue(ws, { type: 'a' }, 'high');
      batchSender.enqueue(ws, { type: 'b' }, 'normal');
      batchSender.enqueue(ws, { type: 'c' }, 'low');
      
      const status = batchSender.getStatus();
      
      expect(status.bufferSize).toBe(3);
      expect(status.bufferBreakdown.high).toBe(1);
      expect(status.bufferBreakdown.normal).toBe(1);
      expect(status.bufferBreakdown.low).toBe(1);
    });
  });
  
  describe('flush', () => {
    it('should process all buffered messages', async () => {
      const ws = new MockWebSocket();
      
      // Add messages
      for (let i = 0; i < 10; i++) {
        batchSender.enqueue(ws, { type: 'test', id: i }, 'normal');
      }
      
      // Flush
      batchSender.flush();
      
      // All messages should be sent
      expect(ws.sentData.length).toBeGreaterThan(0);
      expect(batchSender._getTotalBufferSize()).toBe(0);
    });
  });
});

describe('ConnectionRateLimiter', () => {
  let limiter;
  
  beforeEach(() => {
    limiter = new ConnectionRateLimiter({
      globalMaxConnections: 1000,
      globalConnectionsPerSecond: 50,
      ipMaxConnections: 50,
      ipConnectionsPerSecond: 10,
      userMaxConnections: 10,
      userConnectionsPerSecond: 5,
      circuitBreakerThreshold: 0.8
    });
  });
  
  afterEach(() => {
    limiter.close();
  });
  
  describe('check', () => {
    it('should allow connection under limits', async () => {
      const result = await limiter.check({
        ip: '192.168.1.1',
        userId: 'user1'
      });
      
      expect(result.allowed).toBe(true);
    });
    
    it('should reject when global limit exceeded', async () => {
      // Fill global limit
      for (let i = 0; i < 1000; i++) {
        limiter.state.currentConnections++;
      }
      
      const result = await limiter.check({
        ip: '192.168.1.1',
        userId: 'user1'
      });
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('GLOBAL_CONNECTION_LIMIT');
    });
    
    it('should reject when IP connection limit exceeded', async () => {
      const ip = '192.168.1.100';
      
      // Simulate IP reaching limit
      for (let i = 0; i < 50; i++) {
        limiter._recordConnection('ip', ip);
      }
      
      const result = await limiter.check({ ip });
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('IP_CONNECTION_LIMIT');
    });
    
    it('should reject when user connection limit exceeded', async () => {
      const userId = 'limitedUser';
      
      // Simulate user reaching limit
      for (let i = 0; i < 10; i++) {
        limiter._recordConnection('user', userId);
      }
      
      const result = await limiter.check({ userId });
      
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('USER_CONNECTION_LIMIT');
    });
    
    it('should trigger circuit breaker at threshold', async () => {
      // Reach threshold
      limiter.state.currentConnections = 800; // 80% of 1000
      
      await limiter.check({ ip: '192.168.1.1' });
      
      expect(limiter.state.circuitBreakerActive).toBe(true);
    });
    
    it('should ban IP on rate violation', async () => {
      const ip = '192.168.1.200';
      
      // Simulate rapid connections (rate violation)
      const counter = limiter._getCounter('ip', ip);
      for (let i = 0; i < 15; i++) {
        counter.connections.push(Date.now() - i * 50);
      }
      
      const result = await limiter.check({ ip });
      
      expect(result.allowed).toBe(false);
      expect(limiter.state.ipBans.has(ip)).toBe(true);
    });
  });
  
  describe('recordDisconnect', () => {
    it('should decrease connection count', () => {
      limiter.state.currentConnections = 10;
      
      limiter.recordDisconnect('192.168.1.1', 'user1');
      
      expect(limiter.state.currentConnections).toBe(9);
    });
    
    it('should not go below zero', () => {
      limiter.state.currentConnections = 0;
      
      limiter.recordDisconnect('192.168.1.1', 'user1');
      
      expect(limiter.state.currentConnections).toBe(0);
    });
  });
  
  describe('_isIpBanned', () => {
    it('should detect banned IP', () => {
      const ip = '192.168.1.99';
      limiter._banIp(ip);
      
      expect(limiter._isIpBanned(ip)).toBe(true);
    });
    
    it('should allow after ban expires', async () => {
      const ip = '192.168.1.99';
      
      // Set short ban
      limiter.state.ipBans.set(ip, Date.now() + 100);
      
      expect(limiter._isIpBanned(ip)).toBe(true);
      
      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(limiter._isIpBanned(ip)).toBe(false);
    });
  });
  
  describe('getStatus', () => {
    it('should return correct status', async () => {
      await limiter.check({ ip: '192.168.1.1', userId: 'user1' });
      await limiter.check({ ip: '192.168.1.2', userId: 'user2' });
      
      const status = limiter.getStatus();
      
      expect(status.currentConnections).toBe(2);
      expect(status.stats.allowed).toBe(2);
    });
  });
  
  describe('reset', () => {
    it('should reset all state', async () => {
      // Add connections and bans
      await limiter.check({ ip: '192.168.1.1' });
      limiter._banIp('192.168.1.99');
      
      limiter.reset();
      
      expect(limiter.state.currentConnections).toBe(0);
      expect(limiter.state.ipBans.size).toBe(0);
      expect(limiter.state.circuitBreakerActive).toBe(false);
    });
  });
});