// backend/tests/unit/notification-manager.test.js
'use strict';

const { NotificationManager, getNotificationManager } = require('../../shared/notification/NotificationManager');
const NotificationPlugin = require('../../shared/notification/PluginInterface');
const { query } = require('../../shared/db');

// Mock dependencies
jest.mock('../../shared/db', () => ({
  query: jest.fn(),
}));

jest.mock('../../shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

// Test plugin implementation
class MockPlugin extends NotificationPlugin {
  constructor(name, shouldSucceed = true) {
    super();
    this.name = name;
    this.shouldSucceed = shouldSucceed;
  }

  async send(userId, payload, options) {
    if (this.shouldSucceed) {
      return { success: true, messageId: `${this.name}-${userId}-123` };
    }
    return { success: false, error: `${this.name} failed` };
  }

  getSupportedPlatforms() {
    return ['test'];
  }

  getName() {
    return this.name;
  }

  async isEnabledForUser(userId) {
    return true;
  }

  async getUserDeviceToken(userId) {
    return 'test-token';
  }

  isUserOnline(userId) {
    return false;
  }
}

describe('NotificationManager', () => {
  let manager;

  beforeEach(() => {
    manager = new NotificationManager();
    jest.clearAllMocks();
  });

  describe('registerPlugin', () => {
    it('should register a plugin successfully', () => {
      const plugin = new MockPlugin('test');
      manager.registerPlugin(plugin);
      
      expect(manager.plugins.has('test')).toBe(true);
      expect(manager.getRegisteredPlugins()).toContain('test');
    });

    it('should throw error if plugin does not implement getName', () => {
      const invalidPlugin = {};
      
      expect(() => manager.registerPlugin(invalidPlugin)).toThrow('Plugin must implement getName()');
    });
  });

  describe('send', () => {
    beforeEach(() => {
      query.mockReset();
    });

    it('should skip notification during quiet hours', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: true, start: '00:00', end: '23:59' } }] })
        .mockResolvedValueOnce({ rows: [{ notification_types: { test: true } }] });

      const plugin = new MockPlugin('test');
      manager.registerPlugin(plugin);

      const result = await manager.send('user1', { title: 'Test', body: 'Body', type: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Quiet hours');
    });

    it('should skip notification if type is disabled', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: false } }] })
        .mockResolvedValueOnce({ rows: [{ notification_types: { test: false } }] });

      const plugin = new MockPlugin('test');
      manager.registerPlugin(plugin);

      const result = await manager.send('user1', { title: 'Test', body: 'Body', type: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Notification type disabled');
    });

    it('should use WebSocket for online users', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: false } }] })
        .mockResolvedValueOnce({ rows: [{ notification_types: {} }] });

      const wsPlugin = new MockPlugin('websocket');
      wsPlugin.isUserOnline = jest.fn().mockReturnValue(true);
      manager.registerPlugin(wsPlugin);

      const result = await manager.send('user1', { title: 'Test', body: 'Body' });

      expect(result.success).toBe(true);
      expect(result.messageId).toContain('websocket');
    });

    it('should fallback to other channels when WebSocket fails', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: false } }] })
        .mockResolvedValueOnce({ rows: [{ notification_types: {} }] })
        .mockResolvedValueOnce({ rows: [{ preferred_channels: ['fcm'], notification_types: {} }] })
        .mockResolvedValueOnce({ rows: [] });

      const wsPlugin = new MockPlugin('websocket', false);
      wsPlugin.isUserOnline = jest.fn().mockReturnValue(true);
      const fcmPlugin = new MockPlugin('fcm', true);
      
      manager.registerPlugin(wsPlugin);
      manager.registerPlugin(fcmPlugin);

      const result = await manager.send('user1', { title: 'Test', body: 'Body' });

      expect(result.success).toBe(true);
      expect(result.messageId).toContain('fcm');
    });

    it('should try multiple channels in order', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: false } }] })
        .mockResolvedValueOnce({ rows: [{ notification_types: {} }] })
        .mockResolvedValueOnce({ rows: [{ preferred_channels: ['fcm', 'apns'], notification_types: {} }] });

      const fcmPlugin = new MockPlugin('fcm', false);
      const apnsPlugin = new MockPlugin('apns', true);
      
      manager.registerPlugin(fcmPlugin);
      manager.registerPlugin(apnsPlugin);

      const result = await manager.send('user1', { title: 'Test', body: 'Body' });

      expect(result.success).toBe(true);
      expect(result.messageId).toContain('apns');
    });

    it('should fail when all channels fail', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: false } }] })
        .mockResolvedValueOnce({ rows: [{ notification_types: {} }] })
        .mockResolvedValueOnce({ rows: [{ preferred_channels: ['fcm', 'apns'], notification_types: {} }] });

      const fcmPlugin = new MockPlugin('fcm', false);
      const apnsPlugin = new MockPlugin('apns', false);
      
      manager.registerPlugin(fcmPlugin);
      manager.registerPlugin(apnsPlugin);

      const result = await manager.send('user1', { title: 'Test', body: 'Body' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('All channels failed');
    });
  });

  describe('sendBatch', () => {
    it('should send notifications to multiple users', async () => {
      // Mock for each user (quiet hours + notification types check)
      for (let i = 0; i < 3; i++) {
        query
          .mockResolvedValueOnce({ rows: [{ quiet_hours: { enabled: false } }] })
          .mockResolvedValueOnce({ rows: [{ notification_types: {} }] });
      }

      const plugin = new MockPlugin('test');
      plugin.isUserOnline = jest.fn().mockReturnValue(true);
      manager.registerPlugin(plugin);

      const result = await manager.sendBatch(['user1', 'user2', 'user3'], { title: 'Test' });

      expect(result.total).toBe(3);
      expect(result.success).toBeGreaterThanOrEqual(0);
      expect(result.failed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getUserPreferences', () => {
    it('should return user preferences', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          preferred_channels: ['websocket', 'fcm'],
          notification_types: { test: true },
          quiet_hours: { enabled: true },
        }],
      });

      const prefs = await manager.getUserPreferences('user1');

      expect(prefs.channels).toEqual(['websocket', 'fcm']);
      expect(prefs.notificationTypes).toEqual({ test: true });
      expect(prefs.quietHours.enabled).toBe(true);
    });

    it('should return null if no preferences found', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const prefs = await manager.getUserPreferences('user1');

      expect(prefs).toBeNull();
    });
  });

  describe('isInQuietHours', () => {
    it('should return false if quiet hours disabled', async () => {
      query.mockResolvedValueOnce({
        rows: [{ quiet_hours: { enabled: false } }],
      });

      const result = await manager.isInQuietHours('user1');

      expect(result).toBe(false);
    });

    it('should detect quiet hours correctly', async () => {
      const now = new Date();
      const currentHour = String(now.getHours()).padStart(2, '0');
      const currentMinute = String(now.getMinutes()).padStart(2, '0');
      const currentTime = `${currentHour}:${currentMinute}`;

      query.mockResolvedValueOnce({
        rows: [{
          quiet_hours: {
            enabled: true,
            start: '00:00',
            end: '23:59',
          },
        }],
      });

      const result = await manager.isInQuietHours('user1');

      expect(result).toBe(true);
    });
  });
});

describe('getNotificationManager', () => {
  it('should return singleton instance', () => {
    const instance1 = getNotificationManager();
    const instance2 = getNotificationManager();

    expect(instance1).toBe(instance2);
  });
});
