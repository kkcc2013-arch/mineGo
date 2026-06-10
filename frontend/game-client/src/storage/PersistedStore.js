// frontend/game-client/src/storage/PersistedStore.js
// IndexedDB-based persistent storage layer for game state
// Provides structured storage with versioning and expiration support
'use strict';

/**
 * PersistedStore - IndexedDB wrapper for game state persistence
 * 
 * Object stores:
 * - state: Key-value state storage
 * - pokemon: Cached pokemon data
 * - mapElements: Cached map elements (wild pokemon, pokestops, gyms)
 * - oplog: Operation log for offline operations
 */
export class PersistedStore {
  constructor(dbName = 'minego-state', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this._initPromise = null;
  }

  /**
   * Initialize the IndexedDB database
   * @returns {Promise<PersistedStore>}
   */
  async init() {
    // Return existing promise if already initializing
    if (this._initPromise) {
      return this._initPromise;
    }

    // Return immediately if already initialized
    if (this.db) {
      return this;
    }

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => {
        console.error('[PersistedStore] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('[PersistedStore] Database opened successfully');
        resolve(this);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log('[PersistedStore] Upgrading database from version', event.oldVersion, 'to', event.newVersion);

        // Core state storage (key-value pairs)
        if (!db.objectStoreNames.contains('state')) {
          const store = db.createObjectStore('state', { keyPath: 'key' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Pokemon cache
        if (!db.objectStoreNames.contains('pokemon')) {
          const store = db.createObjectStore('pokemon', { keyPath: 'id' });
          store.createIndex('speciesId', 'speciesId', { unique: false });
          store.createIndex('cp', 'cp', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Map elements cache
        if (!db.objectStoreNames.contains('mapElements')) {
          const store = db.createObjectStore('mapElements', { keyPath: 'id' });
          store.createIndex('type', 'type', { unique: false }); // 'wild' | 'pokestop' | 'gym'
          store.createIndex('expiresAt', 'expiresAt', { unique: false });
        }

        // Operation log for offline operations
        if (!db.objectStoreNames.contains('oplog')) {
          const store = db.createObjectStore('oplog', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('synced', 'synced', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });

    return this._initPromise;
  }

  /**
   * Get a value from the state store
   * @param {string} key 
   * @returns {Promise<any>}
   */
  async get(key) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readonly');
      const store = tx.objectStore('state');
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Set a value in the state store
   * @param {string} key 
   * @param {any} value 
   * @returns {Promise<void>}
   */
  async set(key, value) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const request = store.put({
        key,
        value,
        updatedAt: Date.now()
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete a key from the state store
   * @param {string} key 
   * @returns {Promise<void>}
   */
  async delete(key) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readwrite');
      const store = tx.objectStore('state');
      const request = store.delete(key);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get all keys from the state store
   * @returns {Promise<string[]>}
   */
  async keys() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readonly');
      const store = tx.objectStore('state');
      const request = store.getAllKeys();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all data from a specific store
   * @param {string} storeName 
   * @returns {Promise<void>}
   */
  async clearStore(storeName) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clear all stores
   * @returns {Promise<void>}
   */
  async clearAll() {
    const storeNames = ['state', 'pokemon', 'mapElements', 'oplog'];
    for (const name of storeNames) {
      await this.clearStore(name);
    }
  }

  /**
   * Get the database instance (for advanced operations)
   * @returns {Promise<IDBDatabase>}
   */
  async getDb() {
    await this.ensureInitialized();
    return this.db;
  }

  /**
   * Ensure database is initialized
   * @private
   */
  async ensureInitialized() {
    if (!this.db) {
      await this.init();
    }
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this._initPromise = null;
    }
  }

  /**
   * Get storage statistics
   * @returns {Promise<{storeCounts: object, totalSize: number}>}
   */
  async getStats() {
    await this.ensureInitialized();

    const storeNames = ['state', 'pokemon', 'mapElements', 'oplog'];
    const storeCounts = {};

    for (const name of storeNames) {
      storeCounts[name] = await this.count(name);
    }

    // Estimate total size (rough approximation)
    const totalSize = Object.values(storeCounts).reduce((a, b) => a + b, 0);

    return { storeCounts, totalSize };
  }

  /**
   * Count records in a store
   * @param {string} storeName 
   * @returns {Promise<number>}
   */
  async count(storeName) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.count();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Singleton instance
export const persistedStore = new PersistedStore();
