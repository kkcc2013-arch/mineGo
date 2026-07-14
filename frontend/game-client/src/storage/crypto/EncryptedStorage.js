// frontend/game-client/src/storage/crypto/EncryptedStorage.js
// Encrypted storage wrapper for IndexedDB with automatic encryption/decryption
// REQ-00543: 游戏客户端本地存储数据加密防护系统
'use strict';

import { CryptoService } from './CryptoService.js';
import { KeyManager } from './KeyManager.js';

/**
 * EncryptedStorage - Wrapper that automatically encrypts data before storage
 * 
 * Features:
 * - Transparent encryption/decryption for application layer
 * - Automatic key management
 * - Migration support for unencrypted legacy data
 * - Atomic writes with rollback on failure
 */
export class EncryptedStorage {
  static DB_NAME = 'minego-encrypted';
  static DB_VERSION = 2;
  static STORE_NAME = 'encrypted-data';
  static MIGRATION_FLAG_KEY = '__migration_complete__';

  /**
   * @param {boolean} autoMigrate - Automatically migrate unencrypted data
   */
  constructor(autoMigrate = true) {
    this.db = null;
    this.cryptoService = new CryptoService();
    this.keyManager = new KeyManager();
    this.autoMigrate = autoMigrate;
    this.encryptionKey = null;
    this.initialized = false;
  }

  /**
   * Initialize encrypted storage
   * @returns {Promise<EncryptedStorage>}
   */
  async init() {
    if (this.initialized) {
      return this;
    }

    // Initialize key manager and get encryption key
    this.encryptionKey = await this.keyManager.initialize();

    // Open or create IndexedDB
    await this.ensureDB();

    // Migrate unencrypted data if needed
    if (this.autoMigrate) {
      await this.migrateUnencryptedData();
    }

    this.initialized = true;
    console.log('[EncryptedStorage] Initialized successfully');
    
    return this;
  }

  /**
   * Store data with encryption
   * @param {string} key - Storage key
   * @param {any} value - Value to store (will be JSON stringified and encrypted)
   * @param {object} options - Optional metadata
   * @returns {Promise<void>}
   */
  async set(key, value, options = {}) {
    await this.ensureInitialized();

    try {
      // Encrypt the data
      const encrypted = await this.cryptoService.encrypt(value, this.encryptionKey);

      const record = {
        key,
        data: encrypted,
        encrypted: true,
        contentType: 'application/json',
        createdAt: options.createdAt || Date.now(),
        updatedAt: Date.now(),
        ttl: options.ttl || null, // Time-to-live in milliseconds
        metadata: options.metadata || {}
      };

      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readwrite');
        const store = tx.objectStore(EncryptedStorage.STORE_NAME);
        store.put(record);

        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          console.error('[EncryptedStorage] Store failed:', tx.error);
          reject(tx.error);
        };
      });
    } catch (error) {
      console.error('[EncryptedStorage] Encryption failed for key:', key, error);
      throw new Error(`Failed to store encrypted data: ${error.message}`);
    }
  }

  /**
   * Retrieve and decrypt data
   * @param {string} key - Storage key
   * @returns {Promise<any|null>} - Decrypted value or null if not found
   */
  async get(key) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readonly');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      const request = store.get(key);

      request.onsuccess = async () => {
        const record = request.result;

        if (!record) {
          resolve(null);
          return;
        }

        // Check TTL expiration
        if (record.ttl && Date.now() > record.createdAt + record.ttl) {
          await this.delete(key);
          resolve(null);
          return;
        }

        // Decrypt if encrypted
        if (record.encrypted) {
          try {
            const decrypted = await this.cryptoService.decrypt(record.data, this.encryptionKey);
            resolve(decrypted);
          } catch (error) {
            console.error('[EncryptedStorage] Decryption failed for key:', key, error);
            // Return null instead of throwing - data may be corrupted
            resolve(null);
          }
        } else {
          // Legacy unencrypted data
          resolve(record.data);
        }
      };

      request.onerror = () => {
        console.error('[EncryptedStorage] Get failed:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Delete a key
   * @param {string} key 
   * @returns {Promise<void>}
   */
  async delete(key) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readwrite');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      store.delete(key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Check if key exists
   * @param {string} key 
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readonly');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          resolve(false);
          return;
        }
        // Check TTL
        if (record.ttl && Date.now() > record.createdAt + record.ttl) {
          resolve(false);
        } else {
          resolve(true);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all keys
   * @returns {Promise<string[]>}
   */
  async keys() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readonly');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      const request = store.getAllKeys();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all encrypted data
   * @returns {Promise<void>}
   */
  async clear() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readwrite');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      store.clear();

      tx.oncomplete = () => {
        console.log('[EncryptedStorage] All data cleared');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get storage statistics
   * @returns {Promise<object>}
   */
  async getStats() {
    await this.ensureInitialized();

    const allKeys = await this.keys();
    let totalSize = 0;
    let encryptedCount = 0;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readonly');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const records = request.result;
        
        for (const record of records) {
          if (record.encrypted) encryptedCount++;
          if (typeof record.data === 'string') {
            totalSize += record.data.length * 2; // UTF-16
          }
        }

        resolve({
          totalKeys: allKeys.length,
          encryptedKeys: encryptedCount,
          unencryptedKeys: allKeys.length - encryptedCount,
          estimatedSizeBytes: totalSize,
          estimatedSizeKB: Math.round(totalSize / 1024)
        });
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Migrate unencrypted legacy data
   */
  async migrateUnencryptedData() {
    // Check if migration already done
    const migrationFlag = await this.get(EncryptedStorage.MIGRATION_FLAG_KEY);
    if (migrationFlag === true) {
      console.log('[EncryptedStorage] Migration already complete');
      return;
    }

    console.log('[EncryptedStorage] Checking for unencrypted data to migrate...');

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(EncryptedStorage.STORE_NAME, 'readwrite');
      const store = tx.objectStore(EncryptedStorage.STORE_NAME);
      const request = store.getAll();

      request.onsuccess = async () => {
        const records = request.result;
        let migratedCount = 0;

        for (const record of records) {
          // Skip if already encrypted or internal key
          if (record.encrypted || record.key === EncryptedStorage.MIGRATION_FLAG_KEY) {
            continue;
          }

          // Re-encrypt unencrypted data
          try {
            const encrypted = await this.cryptoService.encrypt(record.data, this.encryptionKey);
            record.data = encrypted;
            record.encrypted = true;
            record.updatedAt = Date.now();
            
            store.put(record);
            migratedCount++;
          } catch (error) {
            console.warn('[EncryptedStorage] Failed to migrate key:', record.key, error);
          }
        }

        // Mark migration as complete
        await this.set(EncryptedStorage.MIGRATION_FLAG_KEY, true);
        
        console.log(`[EncryptedStorage] Migrated ${migratedCount} records to encrypted format`);
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Ensure IndexedDB is initialized
   */
  async ensureDB() {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(EncryptedStorage.DB_NAME, EncryptedStorage.DB_VERSION);

      request.onerror = () => {
        console.error('[EncryptedStorage] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains(EncryptedStorage.STORE_NAME)) {
          const store = db.createObjectStore(EncryptedStorage.STORE_NAME, { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
          store.createIndex('encrypted', 'encrypted', { unique: false });
        }
      };
    });
  }

  /**
   * Ensure storage is initialized
   */
  async ensureInitialized() {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * Rotate encryption key and re-encrypt all data
   * @returns {Promise<void>}
   */
  async rotateEncryptionKey() {
    await this.ensureInitialized();

    console.log('[EncryptedStorage] Starting encryption key rotation...');

    // Generate new key
    const newKey = await this.keyManager.rotateKey();
    
    // Get all data
    const keys = await this.keys();
    let reEncryptedCount = 0;

    for (const key of keys) {
      if (key === EncryptedStorage.MIGRATION_FLAG_KEY) continue;

      // Decrypt with old key
      const data = await this.get(key);
      if (data === null) continue;

      // Re-encrypt with new key
      await this.set(key, data);
      reEncryptedCount++;
    }

    this.encryptionKey = newKey;
    
    console.log(`[EncryptedStorage] Re-encrypted ${reEncryptedCount} records with new key`);
  }
}

export default EncryptedStorage;
