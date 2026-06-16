/**
 * MemoryGuard 单元测试
 * 
 * @module backend/tests/unit/memory-guard.test.js
 */

const { MemoryGuard } = require('../../../frontend/game-client/src/security/MemoryGuard');

// Mock fetch
global.fetch = jest.fn();

// Mock localStorage
const localStorageMock = {
  store: {},
  getItem: jest.fn((key) => localStorageMock.store[key]),
  setItem: jest.fn((key, value) => { localStorageMock.store[key] = value; }),
  removeItem: jest.fn((key) => { delete localStorageMock.store[key]; }),
  clear: jest.fn(() => { localStorageMock.store = {}; })
};
global.localStorage = localStorageMock;

// Mock crypto.randomUUID
global.crypto = {
  getRandomValues: (arr) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  },
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  subtle: {
    importKey: jest.fn(),
    deriveKey: jest.fn(),
    encrypt: jest.fn(),
    decrypt: jest.fn(),
    sign: jest.fn()
  }
};

describe('MemoryGuard', () => {
  let memoryGuard;

  beforeEach(() => {
    memoryGuard = new MemoryGuard();
    fetch.mockClear();
    localStorageMock.clear();
  });

  describe('getDeviceId', () => {
    it('should generate a device ID on first call', () => {
      const deviceId = memoryGuard.getDeviceId();
      
      expect(deviceId).toBeDefined();
      expect(typeof deviceId).toBe('string');
      expect(deviceId.length).toBeGreaterThan(0);
    });

    it('should return the same device ID on subsequent calls', () => {
      const id1 = memoryGuard.getDeviceId();
      const id2 = memoryGuard.getDeviceId();
      
      expect(id1).toBe(id2);
    });

    it('should store device ID in localStorage', () => {
      memoryGuard.getDeviceId();
      
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'mg_device_id',
        expect.any(String)
      );
    });
  });

  describe('init', () => {
    it('should initialize session successfully', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: 'test-session-id',
          encryptedKey: 'dGVzdC1rZXk=', // base64 'test-key'
          expiresIn: 3600
        })
      });

      const result = await memoryGuard.init();
      
      expect(result.sessionId).toBe('test-session-id');
      expect(memoryGuard.initialized).toBe(true);
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/security/init-session',
        expect.objectContaining({
          method: 'POST'
        })
      );
    });

    it('should throw error on failed init', async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 500
      });

      await expect(memoryGuard.init()).rejects.toThrow();
    });

    it('should not re-initialize if already initialized', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionId: 'test-session-id',
          encryptedKey: 'dGVzdC1rZXk=',
          expiresIn: 3600
        })
      });

      await memoryGuard.init();
      await memoryGuard.init();
      
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateChecksum', () => {
    beforeEach(() => {
      memoryGuard.secretKey = 'test-secret-key';
    });

    it('should generate a checksum for data', () => {
      const data = { cp: 100, iv: 15 };
      const checksum = memoryGuard.generateChecksum(data, 'pokemon:test:cp');
      
      expect(checksum).toBeDefined();
      expect(typeof checksum).toBe('string');
      expect(checksum.length).toBeGreaterThan(0);
    });

    it('should store checksum in checksums map', () => {
      const data = { cp: 100 };
      memoryGuard.generateChecksum(data, 'test-key');
      
      expect(memoryGuard.checksums.has('test-key')).toBe(true);
    });

    it('should generate different checksums for different data', () => {
      const checksum1 = memoryGuard.generateChecksum({ cp: 100 }, 'key1');
      const checksum2 = memoryGuard.generateChecksum({ cp: 200 }, 'key2');
      
      expect(checksum1).not.toBe(checksum2);
    });

    it('should generate same checksum for same data', () => {
      const data = { cp: 100, iv: 15 };
      const checksum1 = memoryGuard.generateChecksum(data, 'key1');
      const checksum2 = memoryGuard.generateChecksum(data, 'key2');
      
      expect(checksum1).toBe(checksum2);
    });
  });

  describe('verifyChecksum', () => {
    beforeEach(() => {
      memoryGuard.secretKey = 'test-secret-key';
    });

    it('should return true for valid data', () => {
      const data = { cp: 100 };
      memoryGuard.generateChecksum(data, 'test-key');
      
      const result = memoryGuard.verifyChecksum(data, 'test-key');
      
      expect(result).toBe(true);
    });

    it('should return false for tampered data', async () => {
      const data = { cp: 100 };
      memoryGuard.generateChecksum(data, 'test-key');
      
      // Tamper with data
      data.cp = 999;
      
      const result = memoryGuard.verifyChecksum(data, 'test-key');
      
      expect(result).toBe(false);
    });

    it('should return true if no checksum exists', () => {
      const result = memoryGuard.verifyChecksum({ data: 'test' }, 'nonexistent-key');
      
      expect(result).toBe(true);
    });

    it('should increment tamper count on failure', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ action: 'warn' })
      });

      const data = { cp: 100 };
      memoryGuard.generateChecksum(data, 'test-key');
      data.cp = 999;
      
      await memoryGuard.verifyChecksum(data, 'test-key');
      
      expect(memoryGuard.tamperCount).toBe(1);
    });
  });

  describe('wrapSecureData', () => {
    beforeEach(() => {
      memoryGuard.secretKey = 'test-secret-key';
    });

    it('should wrap data with verification method', () => {
      const data = { cp: 100, iv: 15 };
      const wrapped = memoryGuard.wrapSecureData(data, 'pokemon:test');
      
      expect(wrapped.data).toEqual(data);
      expect(wrapped._checksum).toBeDefined();
      expect(typeof wrapped._verify).toBe('function');
    });

    it('should verify wrapped data successfully', () => {
      const data = { cp: 100 };
      const wrapped = memoryGuard.wrapSecureData(data, 'test-key');
      
      const result = wrapped._verify();
      
      expect(result).toBe(true);
    });

    it('should fail verification if data is tampered', () => {
      const data = { cp: 100 };
      const wrapped = memoryGuard.wrapSecureData(data, 'test-key');
      
      // Tamper
      wrapped.data.cp = 999;
      
      const result = wrapped._verify();
      
      expect(result).toBe(false);
    });
  });

  describe('hmacSha256', () => {
    it('should generate consistent hash for same input', () => {
      memoryGuard.secretKey = 'test-key';
      
      const hash1 = memoryGuard.hmacSha256('test message', 'test-key');
      const hash2 = memoryGuard.hmacSha256('test message', 'test-key');
      
      expect(hash1).toBe(hash2);
    });

    it('should generate different hash for different input', () => {
      const hash1 = memoryGuard.hmacSha256('message1', 'key');
      const hash2 = memoryGuard.hmacSha256('message2', 'key');
      
      expect(hash1).not.toBe(hash2);
    });

    it('should return hex string', () => {
      const hash = memoryGuard.hmacSha256('test', 'key');
      
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });
  });

  describe('sortObject', () => {
    it('should sort object keys alphabetically', () => {
      const obj = { c: 1, a: 2, b: 3 };
      const sorted = memoryGuard.sortObject(obj);
      
      expect(Object.keys(sorted)).toEqual(['a', 'b', 'c']);
    });

    it('should recursively sort nested objects', () => {
      const obj = { z: 1, a: { y: 2, x: 3 } };
      const sorted = memoryGuard.sortObject(obj);
      
      expect(Object.keys(sorted)).toEqual(['a', 'z']);
      expect(Object.keys(sorted.a)).toEqual(['x', 'y']);
    });

    it('should handle arrays without sorting elements', () => {
      const arr = [{ b: 1 }, { a: 2 }];
      const sorted = memoryGuard.sortObject(arr);
      
      expect(sorted).toEqual([{ b: 1 }, { a: 2 }]);
    });

    it('should return primitives unchanged', () => {
      expect(memoryGuard.sortObject('string')).toBe('string');
      expect(memoryGuard.sortObject(123)).toBe(123);
      expect(memoryGuard.sortObject(null)).toBe(null);
    });
  });

  describe('isProtectedKey', () => {
    it('should return true for protected keys', () => {
      expect(memoryGuard.isProtectedKey('player:currency')).toBe(true);
      expect(memoryGuard.isProtectedKey('player:inventory')).toBe(true);
      expect(memoryGuard.isProtectedKey('battle:state')).toBe(true);
    });

    it('should return true for pokemon CP/IV keys', () => {
      expect(memoryGuard.isProtectedKey('pokemon:123:cp')).toBe(true);
      expect(memoryGuard.isProtectedKey('pokemon:456:iv')).toBe(true);
    });

    it('should return false for unprotected keys', () => {
      expect(memoryGuard.isProtectedKey('settings:volume')).toBe(false);
      expect(memoryGuard.isProtectedKey('cache:temp')).toBe(false);
    });
  });

  describe('getSecureHeaders', () => {
    it('should return headers with session info', () => {
      memoryGuard.sessionId = 'test-session';
      memoryGuard.deviceId = 'test-device';
      
      const headers = memoryGuard.getSecureHeaders();
      
      expect(headers['X-Session-Id']).toBe('test-session');
      expect(headers['X-Device-Id']).toBe('test-device');
      expect(headers['X-Request-Timestamp']).toBeDefined();
      expect(headers['X-Request-Nonce']).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      memoryGuard.sessionId = 'test-session';
      memoryGuard.initialized = true;
      memoryGuard.tamperCount = 2;
      
      const status = memoryGuard.getStatus();
      
      expect(status.sessionId).toBe('test-session');
      expect(status.initialized).toBe(true);
      expect(status.tamperCount).toBe(2);
    });
  });

  describe('destroy', () => {
    it('should clear all state', () => {
      memoryGuard.sessionId = 'test';
      memoryGuard.secretKey = 'key';
      memoryGuard.checksums.set('test', {});
      
      memoryGuard.destroy();
      
      expect(memoryGuard.sessionId).toBeNull();
      expect(memoryGuard.secretKey).toBeNull();
      expect(memoryGuard.checksums.size).toBe(0);
      expect(memoryGuard.initialized).toBe(false);
    });
  });

  describe('tamper handling', () => {
    it('should report tamper events to server', async () => {
      memoryGuard.sessionId = 'test-session';
      memoryGuard.secretKey = 'test-key';
      
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ action: 'warn' })
      });

      await memoryGuard.onTamperDetected('test-key', 'expected', 'actual');
      
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/security/report-tamper',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('test-key')
        })
      );
    });

    it('should trigger ban when exceeding max count', async () => {
      memoryGuard.sessionId = 'test-session';
      memoryGuard.secretKey = 'test-key';
      memoryGuard.tamperCount = 2;
      
      // Mock window.location
      delete window.location;
      window.location = { href: '' };
      
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ action: 'warn' })
      });

      await memoryGuard.onTamperDetected('test-key', 'expected', 'actual');
      
      expect(memoryGuard.tamperCount).toBe(3);
    });
  });
});

describe('MemoryGuard Integration', () => {
  it('should handle full workflow', async () => {
    const guard = new MemoryGuard();
    
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessionId: 'integration-session',
        encryptedKey: 'aW50ZWdyYXRpb24ta2V5',
        expiresIn: 3600
      })
    });

    // Init
    await guard.init();
    expect(guard.initialized).toBe(true);
    
    // Protect data
    const pokemon = { id: 1, cp: 100, iv: 15 };
    const wrapped = guard.wrapSecureData(pokemon, 'pokemon:1');
    
    // Verify
    expect(wrapped._verify()).toBe(true);
    
    // Tamper
    wrapped.data.cp = 9999;
    
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ action: 'warn' })
    });
    
    // Should detect tampering
    expect(wrapped._verify()).toBe(false);
    
    // Cleanup
    guard.destroy();
    expect(guard.initialized).toBe(false);
  });
});
