// frontend/game-client/src/storage/OfflineSyncEngine.test.js
// Unit tests for OfflineSyncEngine
'use strict';

import { OfflineSyncEngine } from './OfflineSyncEngine.js';
import { PersistedStore } from './PersistedStore.js';
import { networkMonitor } from '../network/NetworkMonitor.js';

// Mock API client
const createMockApi = () => ({
  post: jest.fn().mockResolvedValue({ success: true }),
  get: jest.fn().mockResolvedValue({})
});

// Mock IndexedDB
const mockIndexedDB = () => {
  const stores = {};
  return {
    open: jest.fn().mockImplementation((dbName, version) => {
      return {
        result: {
          createObjectStore: jest.fn((name) => {
            stores[name] = {};
            return {
              createIndex: jest.fn()
            };
          }),
          objectStoreNames: {
            contains: jest.fn((name) => !!stores[name])
          }
        },
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };
    })
  };
};

describe('OfflineSyncEngine', () => {
  let engine;
  let persistedStore;
  let mockApi;

  beforeEach(async () => {
    // Mock IndexedDB
    global.indexedDB = mockIndexedDB();

    mockApi = createMockApi();
    persistedStore = new PersistedStore('test-db');
    await persistedStore.init();

    engine = new OfflineSyncEngine(persistedStore, mockApi);
  });

  afterEach(() => {
    engine.destroy();
    persistedStore.close();
  });

  describe('recordOfflineOperation', () => {
    test('should record operation in oplog', async () => {
      const opId = await engine.recordOfflineOperation('catch', {
        pokemonId: 'p001',
        cp: 500
      });

      expect(opId).toMatch(/^op_\d+_/);
    });
  });

  describe('syncPendingOperations', () => {
    test('should sync pending operations when online', async () => {
      // Mock online status
      networkMonitor._isOnline = true;

      // Record operation
      await engine.recordOfflineOperation('catch', {
        pokemonId: 'p001',
        cp: 500
      });

      // Sync
      const result = await engine.syncPendingOperations();

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockApi.post).toHaveBeenCalledWith('/catch', {
        pokemonId: 'p001',
        cp: 500
      });
    });

    test('should handle sync conflicts', async () => {
      networkMonitor._isOnline = true;
      mockApi.post.mockResolvedValueOnce({
        success: false,
        conflict: { type: 'already_caught' }
      });

      await engine.recordOfflineOperation('catch', { pokemonId: 'p001' });
      const result = await engine.syncPendingOperations();

      expect(result.conflicts).toBe(1);
    });
  });

  describe('conflict resolution', () => {
    test('should use server-wins strategy', async () => {
      networkMonitor._isOnline = true;
      mockApi.post.mockResolvedValueOnce({
        success: false,
        conflict: { type: 'version_mismatch' }
      });

      engine.options.conflictStrategy = 'server-wins';
      
      await engine.recordOfflineOperation('catch', { pokemonId: 'p001' });
      const result = await engine.syncPendingOperations();

      expect(result.success).toBe(1);
    });
  });

  describe('retry logic', () => {
    test('should retry on transient failures', async () => {
      networkMonitor._isOnline = true;
      networkMonitor._connectionQuality = 'good';

      // First two calls fail, third succeeds
      mockApi.post
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ success: true });

      await engine.recordOfflineOperation('catch', { pokemonId: 'p001' });
      const result = await engine.syncPendingOperations();

      expect(result.success).toBe(1);
      expect(mockApi.post).toHaveBeenCalledTimes(3);
    });
  });

  describe('sync progress', () => {
    test('should emit sync progress events', async () => {
      networkMonitor._isOnline = true;

      const progressEvents = [];
      engine.on('sync-progress', (progress) => {
        progressEvents.push(progress);
      });

      await engine.recordOfflineOperation('catch', { pokemonId: 'p001' });
      await engine.syncPendingOperations();

      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents[progressEvents.length - 1].phase).toBe('complete');
    });
  });
});

describe('NetworkMonitor', () => {
  beforeEach(() => {
    networkMonitor.init();
  });

  afterEach(() => {
    networkMonitor.destroy();
  });

  describe('isOnline', () => {
    test('should return navigator.onLine status', () => {
      expect(networkMonitor.isOnline()).toBe(navigator.onLine);
    });
  });

  describe('checkConnectionQuality', () => {
    test('should return quality and RTT', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      
      const result = await networkMonitor.checkConnectionQuality();

      expect(result.quality).toBeDefined();
      expect(result.rtt).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getRetryDelay', () => {
    test('should implement exponential backoff', () => {
      const delay0 = networkMonitor.getRetryDelay(0);
      const delay1 = networkMonitor.getRetryDelay(1);
      const delay2 = networkMonitor.getRetryDelay(2);

      expect(delay1).toBeGreaterThan(delay0);
      expect(delay2).toBeGreaterThan(delay1);
    });

    test('should respect max delay', () => {
      const delay = networkMonitor.getRetryDelay(100, { maxDelay: 60000 });
      expect(delay).toBeLessThanOrEqual(60000);
    });
  });

  describe('withRetry', () => {
    test('should retry on retryable errors', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success');

      const result = await networkMonitor.withRetry(fn, { maxRetries: 3 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('should throw after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(networkMonitor.withRetry(fn, { maxRetries: 2 }))
        .rejects.toThrow('Network error');
    });
  });
});

console.log('[OfflineSyncEngine.test.js] Test suite loaded');