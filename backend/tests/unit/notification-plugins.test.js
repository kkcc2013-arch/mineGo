// backend/tests/unit/notification-plugins.test.js
'use strict';

const WebSocketPlugin = require('../../shared/notification/plugins/WebSocketPlugin');
const FCMPlugin = require('../../shared/notification/plugins/FCMPlugin');
const APNsPlugin = require('../../shared/notification/plugins/APNsPlugin');

// Mock dependencies
jest.mock('../../shared/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('WebSocketPlugin', () => {
  let plugin;
  let mockWs;

  beforeEach(() => {
    plugin = new WebSocketPlugin();
    mockWs = {
      readyState: 1, // WebSocket.OPEN
      send: jest.fn(),
    };
    jest.clearAllMocks();
  });

  describe('registerConnection', () => {
    it('should register user connection', () => {
      plugin.registerConnection('user1', mockWs);
      
      expect(plugin.connections.has('user1')).toBe(true);
    });
  });

  describe('unregisterConnection', () => {
    it('should unregister user connection', () => {
      plugin.registerConnection('user1', mockWs);
      plugin.unregisterConnection('user1');
      
      expect(plugin.connections.has('user1')).toBe(false);
    });
  });

  describe('send', () => {
    it('should send message to connected user', async () => {
      plugin.registerConnection('user1', mockWs);
      
      const result = await plugin.send('user1', {
        title: 'Test',
        body: 'Message',
        type: 'test',
      });

      expect(result.success).toBe(true);
      expect(mockWs.send).toHaveBeenCalled();
    });

    it('should fail if user not connected', async () => {
      const result = await plugin.send('user1', {
        title: 'Test',
        body: 'Message',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('User not connected');
    });

    it('should fail if WebSocket not open', async () => {
      mockWs.readyState = 3; // WebSocket.CLOSED
      plugin.registerConnection('user1', mockWs);
      
      const result = await plugin.send('user1', {
        title: 'Test',
        body: 'Message',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('isUserOnline', () => {
    it('should return true for online user', () => {
      plugin.registerConnection('user1', mockWs);
      
      expect(plugin.isUserOnline('user1')).toBe(true);
    });

    it('should return false for offline user', () => {
      expect(plugin.isUserOnline('user1')).toBeFalsy();
    });
  });

  describe('getSupportedPlatforms', () => {
    it('should return web platform', () => {
      expect(plugin.getSupportedPlatforms()).toEqual(['web']);
    });
  });

  describe('getName', () => {
    it('should return websocket', () => {
      expect(plugin.getName()).toBe('websocket');
    });
  });
});

describe('FCMPlugin', () => {
  let plugin;
  const { query } = require('../../shared/db');

  beforeEach(() => {
    plugin = new FCMPlugin();
    jest.clearAllMocks();
  });

  describe('send', () => {
    it('should fail if FCM not initialized', async () => {
      const result = await plugin.send('user1', { title: 'Test', body: 'Body' });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('FCM not initialized');
    });
  });

  describe('getUserDeviceToken', () => {
    it('should return FCM token if exists', async () => {
      query.mockResolvedValueOnce({
        rows: [{ fcm_token: 'test-fcm-token' }],
      });

      const token = await plugin.getUserDeviceToken('user1');
      
      expect(token).toBe('test-fcm-token');
    });

    it('should return null if no token', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const token = await plugin.getUserDeviceToken('user1');
      
      expect(token).toBeNull();
    });
  });

  describe('isEnabledForUser', () => {
    it('should return true if FCM in preferred channels', async () => {
      query.mockResolvedValueOnce({
        rows: [{ preferred_channels: ['websocket', 'fcm'] }],
      });

      const result = await plugin.isEnabledForUser('user1');
      
      expect(result).toBe(true);
    });

    it('should return false if FCM not in preferred channels', async () => {
      query.mockResolvedValueOnce({
        rows: [{ preferred_channels: ['apns'] }],
      });

      const result = await plugin.isEnabledForUser('user1');
      
      expect(result).toBe(false);
    });
  });

  describe('getSupportedPlatforms', () => {
    it('should return android, ios, web', () => {
      expect(plugin.getSupportedPlatforms()).toEqual(['android', 'ios', 'web']);
    });
  });

  describe('getName', () => {
    it('should return fcm', () => {
      expect(plugin.getName()).toBe('fcm');
    });
  });
});

describe('APNsPlugin', () => {
  let plugin;
  const { query } = require('../../shared/db');

  beforeEach(() => {
    plugin = new APNsPlugin();
    jest.clearAllMocks();
  });

  describe('send', () => {
    it('should fail if APNs not initialized', async () => {
      const result = await plugin.send('user1', { title: 'Test', body: 'Body' });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('APNs not initialized');
    });
  });

  describe('getUserDeviceToken', () => {
    it('should return APNs token if exists', async () => {
      query.mockResolvedValueOnce({
        rows: [{ apns_token: 'test-apns-token' }],
      });

      const token = await plugin.getUserDeviceToken('user1');
      
      expect(token).toBe('test-apns-token');
    });
  });

  describe('isEnabledForUser', () => {
    it('should return true if APNs in preferred channels', async () => {
      query.mockResolvedValueOnce({
        rows: [{ preferred_channels: ['websocket', 'apns'] }],
      });

      const result = await plugin.isEnabledForUser('user1');
      
      expect(result).toBe(true);
    });
  });

  describe('getSupportedPlatforms', () => {
    it('should return ios', () => {
      expect(plugin.getSupportedPlatforms()).toEqual(['ios']);
    });
  });

  describe('getName', () => {
    it('should return apns', () => {
      expect(plugin.getName()).toBe('apns');
    });
  });
});
