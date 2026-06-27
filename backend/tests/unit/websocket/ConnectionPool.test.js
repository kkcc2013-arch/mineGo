/**
 * ConnectionPool 单元测试
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 */

'use strict';

const { WebSocketConnectionPool } = require('../../../shared/websocket/ConnectionPool');
const WebSocket = require('ws');

// Mock WebSocket
class MockWebSocket {
  constructor() {
    this.readyState = WebSocket.OPEN;
    this.sentMessages = [];
    this.events = {};
    this.pingCount = 0;
  }

  send(data) {
    this.sentMessages.push(data);
  }

  ping() {
    this.pingCount++;
  }

  close(code, reason) {
    this.readyState = WebSocket.CLOSED;
    if (this.events.close) {
      this.events.close(code, reason);
    }
  }

  on(event, handler) {
    this.events[event] = handler;
  }

  emit(event, data) {
    if (this.events[event]) {
      this.events[event](data);
    }
  }
}

describe('WebSocketConnectionPool', () => {
  let connectionPool;

  beforeEach(() => {
    connectionPool = new WebSocketConnectionPool({
      maxConnectionsPerWorker: 100,
      connectionTimeout: 60000,
      heartbeatInterval: 10000
    });
  });

  afterEach(() => {
    // 清理所有连接
    if (connectionPool) {
      connectionPool.connectionContexts.forEach(ctx => {
        if (ctx.heartbeatTimer) {
          clearInterval(ctx.heartbeatTimer);
        }
      });
    }
  });

  describe('registerConnection', () => {
    test('should register connection successfully', () => {
      const ws = new MockWebSocket();
      const userId = 'user123';
      const metadata = { platform: 'ios', version: '1.0.0' };

      const ctx = connectionPool.registerConnection(ws, userId, metadata);

      expect(ctx).toBeDefined();
      expect(ctx.userId).toBe(userId);
      expect(ctx.id).toMatch(/^conn_/);
      expect(ctx.metadata.platform).toBe('ios');
      expect(connectionPool.metrics.activeConnections).toBe(1);
    });

    test('should support multiple connections per user', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      const userId = 'user123';

      connectionPool.registerConnection(ws1, userId);
      connectionPool.registerConnection(ws2, userId);

      const connections = connectionPool.getUserConnections(userId);
      expect(connections.length).toBe(2);
    });
  });

  describe('getUserConnections', () => {
    test('should return empty array for unknown user', () => {
      const connections = connectionPool.getUserConnections('unknown_user');
      expect(connections).toEqual([]);
    });

    test('should return active connections', () => {
      const ws = new MockWebSocket();
      connectionPool.registerConnection(ws, 'user123');

      const connections = connectionPool.getUserConnections('user123');
      expect(connections.length).toBe(1);
    });

    test('should filter closed connections', () => {
      const ws = new MockWebSocket();
      connectionPool.registerConnection(ws, 'user123');

      ws.readyState = WebSocket.CLOSED;

      const connections = connectionPool.getUserConnections('user123');
      expect(connections.length).toBe(0);
    });
  });

  describe('sendToUser', () => {
    test('should send message to user', async () => {
      const ws = new MockWebSocket();
      connectionPool.registerConnection(ws, 'user123');

      const message = { type: 'test', data: 'hello' };
      await connectionPool.sendToUser('user123', message);

      expect(ws.sentMessages.length).toBe(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.messages.length).toBe(1);
      expect(sent.messages[0].type).toBe('test');
    });

    test('should send batch messages', async () => {
      const ws = new MockWebSocket();
      connectionPool.registerConnection(ws, 'user123');

      const messages = [
        { type: 'test1', data: 'a' },
        { type: 'test2', data: 'b' }
      ];
      await connectionPool.sendToUser('user123', messages);

      expect(ws.sentMessages.length).toBe(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.messages.length).toBe(2);
    });

    test('should return 0 for unknown user', async () => {
      const result = await connectionPool.sendToUser('unknown', { type: 'test' });
      expect(result.sent).toBe(0);
      expect(result.connections).toBe(0);
    });
  });

  describe('broadcast', () => {
    test('should broadcast to subscribed users', async () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();

      const ctx1 = connectionPool.registerConnection(ws1, 'user1');
      const ctx2 = connectionPool.registerConnection(ws2, 'user2');

      connectionPool.subscribeChannel(ctx1, 'channel1');
      connectionPool.subscribeChannel(ctx2, 'channel1');

      await connectionPool.broadcast('channel1', { type: 'notification' });

      expect(ws1.sentMessages.length).toBe(1);
      expect(ws2.sentMessages.length).toBe(1);
    });

    test('should return 0 for no subscribers', async () => {
      const result = await connectionPool.broadcast('empty_channel', { type: 'test' });
      expect(result.sent).toBe(0);
    });
  });

  describe('subscribeChannel', () => {
    test('should subscribe to channel', () => {
      const ws = new MockWebSocket();
      const ctx = connectionPool.registerConnection(ws, 'user123');

      connectionPool.subscribeChannel(ctx, 'channel1');

      expect(ctx.subscriptions.has('channel1')).toBe(true);
      expect(connectionPool.channelSubscriptions.get('channel1').has('user123')).toBe(true);
    });

    test('should support multiple subscriptions', () => {
      const ws = new MockWebSocket();
      const ctx = connectionPool.registerConnection(ws, 'user123');

      connectionPool.subscribeChannel(ctx, 'channel1');
      connectionPool.subscribeChannel(ctx, 'channel2');

      expect(ctx.subscriptions.size).toBe(2);
    });
  });

  describe('handleDisconnectedConnection', () => {
    test('should clean up connection', () => {
      const ws = new MockWebSocket();
      const ctx = connectionPool.registerConnection(ws, 'user123');

      connectionPool.handleDisconnectedConnection(ctx);

      expect(connectionPool.metrics.activeConnections).toBe(0);
      expect(connectionPool.connectionContexts.has(ctx.id)).toBe(false);
    });

    test('should clean up subscriptions', () => {
      const ws = new MockWebSocket();
      const ctx = connectionPool.registerConnection(ws, 'user123');

      connectionPool.subscribeChannel(ctx, 'channel1');
      connectionPool.handleDisconnectedConnection(ctx);

      expect(connectionPool.channelSubscriptions.has('channel1')).toBe(false);
    });
  });

  describe('getStats', () => {
    test('should return statistics', () => {
      const ws = new MockWebSocket();
      connectionPool.registerConnection(ws, 'user123');

      const stats = connectionPool.getStats();

      expect(stats.activeConnections).toBe(1);
      expect(stats.uniqueUsers).toBe(1);
      expect(stats.totalConnections).toBe(1);
    });
  });
});

// 运行测试
if (typeof describe !== 'undefined') {
  // Jest/Mocha 环境
} else {
  console.log('Run this test file with Jest or Mocha');
}