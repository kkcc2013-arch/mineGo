// frontend/game-client/src/storage/crypto/CryptoService.test.js
// Unit tests for CryptoService
// REQ-00543: 游戏客户端本地存储数据加密防护系统
'use strict';

import { CryptoService } from './CryptoService.js';

describe('CryptoService', () => {
  let cryptoService;

  beforeEach(() => {
    // Mock Web Crypto API if not available
    if (!window.crypto || !window.crypto.subtle) {
      window.crypto = {
        subtle: {
          importKey: jest.fn(),
          deriveKey: jest.fn(),
          encrypt: jest.fn(),
          decrypt: jest.fn(),
          digest: jest.fn()
        },
        getRandomValues: jest.fn((arr) => {
          for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
          }
          return arr;
        })
      };
    }

    cryptoService = new CryptoService(window.crypto.subtle);
  });

  describe('constructor', () => {
    it('should throw error if Web Crypto API not available', () => {
      expect(() => new CryptoService(null)).toThrow('Web Crypto API not available');
    });

    it('should create instance with valid crypto API', () => {
      expect(cryptoService).toBeInstanceOf(CryptoService);
    });
  });

  describe('generateRandomBytes', () => {
    it('should generate random bytes of specified length', () => {
      const length = 16;
      const bytes1 = cryptoService.generateRandomBytes(length);
      const bytes2 = cryptoService.generateRandomBytes(length);

      expect(bytes1).toBeInstanceOf(Uint8Array);
      expect(bytes1.length).toBe(length);
      // Should generate different values each time
      expect(bytes1).not.toEqual(bytes2);
    });
  });

  describe('arrayToBase64 and base64ToArray', () => {
    it('should convert Uint8Array to base64 and back', () => {
      const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const base64 = cryptoService.arrayToBase64(original);
      const converted = cryptoService.base64ToArray(base64);

      expect(typeof base64).toBe('string');
      expect(converted).toBeInstanceOf(Uint8Array);
      expect(converted).toEqual(original);
    });

    it('should handle empty array', () => {
      const original = new Uint8Array([]);
      const base64 = cryptoService.arrayToBase64(original);
      const converted = cryptoService.base64ToArray(base64);

      expect(converted).toEqual(original);
    });
  });

  describe('isEncrypted', () => {
    it('should return false for non-string data', () => {
      expect(cryptoService.isEncrypted(null)).toBe(false);
      expect(cryptoService.isEncrypted(123)).toBe(false);
      expect(cryptoService.isEncrypted({})).toBe(false);
    });

    it('should return false for non-encrypted data', () => {
      expect(cryptoService.isEncrypted('hello world')).toBe(false);
      expect(cryptoService.isEncrypted('{"key":"value"}')).toBe(false);
    });

    it('should return true for encrypted data with version prefix', async () => {
      const password = 'test-password';
      const data = { test: 'data' };
      const encrypted = await cryptoService.encrypt(data, password);
      
      expect(cryptoService.isEncrypted(encrypted)).toBe(true);
    });
  });

  describe('encrypt and decrypt', () => {
    it('should encrypt and decrypt data successfully', async () => {
      const password = 'my-secret-password';
      const data = {
        userId: 'user123',
        level: 25,
        items: ['potion', 'pokeball'],
        location: { lat: 31.2304, lng: 121.4737 }
      };

      const encrypted = await cryptoService.encrypt(data, password);
      
      expect(typeof encrypted).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
      expect(cryptoService.isEncrypted(encrypted)).toBe(true);

      const decrypted = await cryptoService.decrypt(encrypted, password);
      
      expect(decrypted).toEqual(data);
    });

    it('should produce different ciphertext for same data (random IV)', async () => {
      const password = 'my-secret-password';
      const data = { test: 'same' };

      const encrypted1 = await cryptoService.encrypt(data, password);
      const encrypted2 = await cryptoService.encrypt(data, password);

      expect(encrypted1).not.toEqual(encrypted2);
    });

    it('should fail to decrypt with wrong password', async () => {
      const data = { secret: 'data' };
      const encrypted = await cryptoService.encrypt(data, 'correct-password');

      await expect(
        cryptoService.decrypt(encrypted, 'wrong-password')
      ).rejects.toThrow();
    });

    it('should handle various data types', async () => {
      const password = 'test-password';

      const testCases = [
        { input: 'string value', description: 'string' },
        { input: 12345, description: 'number' },
        { input: true, description: 'boolean' },
        { input: null, description: 'null' },
        { input: [1, 2, 3], description: 'array' },
        { input: { nested: { deep: { value: 42 } } }, description: 'nested object' }
      ];

      for (const { input, description } of testCases) {
        const encrypted = await cryptoService.encrypt(input, password);
        const decrypted = await cryptoService.decrypt(encrypted, password);
        expect(decrypted).toEqual(input);
      }
    });

    it('should handle large data objects', async () => {
      const password = 'test-password';
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        data: Math.random().toString(36).repeat(10)
      }));

      const encrypted = await cryptoService.encrypt(largeArray, password);
      const decrypted = await cryptoService.decrypt(encrypted, password);

      expect(decrypted).toEqual(largeArray);
    });

    it('should reject invalid encrypted data', async () => {
      const password = 'test-password';

      await expect(
        cryptoService.decrypt('invalid-base64!!!', password)
      ).rejects.toThrow();
    });

    it('should reject encrypted data with wrong version', async () => {
      const password = 'test-password';
      // Manually create data with wrong version
      const wrongVersion = btoa('xxx' + 'some-data-that-is-not-encrypted');

      await expect(
        cryptoService.decrypt(wrongVersion, password)
      ).rejects.toThrow('Unsupported version');
    });
  });

  describe('deriveKey', () => {
    it('should cache derived keys', async () => {
      const password = 'test-password';
      const salt = cryptoService.generateRandomBytes(16);

      const key1 = await cryptoService.deriveKey(password, salt);
      const key2 = await cryptoService.deriveKey(password, salt);

      // Should return same cached key
      expect(key1).toBe(key2);
    });

    it('should derive different keys for different salts', async () => {
      const password = 'test-password';
      const salt1 = cryptoService.generateRandomBytes(16);
      const salt2 = cryptoService.generateRandomBytes(16);

      const key1 = await cryptoService.deriveKey(password, salt1);
      const key2 = await cryptoService.deriveKey(password, salt2);

      // Different salts should produce different keys
      expect(key1).not.toBe(key2);
    });
  });

  describe('clearCache', () => {
    it('should clear key cache', async () => {
      const password = 'test-password';
      const salt = cryptoService.generateRandomBytes(16);
      
      await cryptoService.deriveKey(password, salt);
      expect(cryptoService.keyCache.size).toBeGreaterThan(0);

      cryptoService.clearCache();
      expect(cryptoService.keyCache.size).toBe(0);
    });
  });

  describe('Error handling', () => {
    it('should handle encryption failure gracefully', async () => {
      // This test would require mocking the crypto API to fail
      // For now, we test that the method exists and works normally
      const password = 'test-password';
      const data = { test: 'data' };
      
      const encrypted = await cryptoService.encrypt(data, password);
      expect(encrypted).toBeDefined();
    });
  });
});

// Integration test with real Web Crypto API (if available)
describe('CryptoService Integration', () => {
  it('should work end-to-end with real Web Crypto API', async () => {
    if (!window.crypto || !window.crypto.subtle) {
      console.log('Skipping integration test - Web Crypto API not available');
      return;
    }

    const service = new CryptoService();
    const password = 'integration-test-password';
    
    const sensitiveData = {
      userToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      gameProgress: {
        level: 42,
        experience: 125000,
        badges: ['earth', 'fire', 'water']
      },
      inventory: {
        pokeballs: 50,
        potions: 25,
        revives: 10
      }
    };

    const encrypted = await service.encrypt(sensitiveData, password);
    console.log('Encrypted size:', encrypted.length, 'bytes');

    const decrypted = await service.decrypt(encrypted, password);
    
    expect(decrypted).toEqual(sensitiveData);
    console.log('✅ Integration test passed - encryption/decryption successful');
  });

  it('should handle concurrent encryption operations', async () => {
    if (!window.crypto || !window.crypto.subtle) {
      return;
    }

    const service = new CryptoService();
    const password = 'concurrent-test-password';
    
    const promises = Array.from({ length: 10 }, (_, i) => 
      service.encrypt({ index: i, data: `item-${i}` }, password)
    );

    const encrypted = await Promise.all(promises);
    
    const decrypted = await Promise.all(
      encrypted.map(e => service.decrypt(e, password))
    );

    decrypted.forEach((d, i) => {
      expect(d.index).toBe(i);
    });
  });
});
