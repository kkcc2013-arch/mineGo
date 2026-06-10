// frontend/game-client/src/storage/OplogManager.js
// Operation log manager for offline operation tracking and replay
'use strict';

/**
 * OplogManager - Manages operation log for offline operations
 * Supports operation recording, replay, and sync status tracking
 */
export class OplogManager {
  /**
   * @param {import('./PersistedStore').PersistedStore} persistedStore 
   */
  constructor(persistedStore) {
    this.persistedStore = persistedStore;
    this.maxOps = 1000; // Maximum operations to keep
    this.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  /**
   * Ensure store is initialized
   */
  async ensureInitialized() {
    await this.persistedStore.init();
  }

  /**
   * Record an operation
   * @param {object} op - Operation object
   * @param {string} op.type - Operation type (e.g., 'catch', 'spin_pokestop', 'battle')
   * @param {object} op.data - Operation data
   * @param {number} op.timestamp - Operation timestamp
   * @returns {Promise<string>} Operation ID
   */
  async recordOp(op) {
    await this.ensureInitialized();

    const id = `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const record = {
      id,
      type: op.type,
      data: op.data,
      timestamp: op.timestamp || Date.now(),
      synced: false,
      retryCount: 0
    };

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readwrite');
      const store = tx.objectStore('oplog');

      store.add(record);

      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get all pending (unsynced) operations
   * @returns {Promise<object[]>}
   */
  async getPendingOps() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readonly');
      const store = tx.objectStore('oplog');
      const index = store.index('synced');
      const request = index.getAll(false);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get operations by type
   * @param {string} type 
   * @returns {Promise<object[]>}
   */
  async getOpsByType(type) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readonly');
      const store = tx.objectStore('oplog');
      const index = store.index('type');
      const request = index.getAll(type);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Mark an operation as synced
   * @param {string} opId 
   * @returns {Promise<void>}
   */
  async markSynced(opId) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readwrite');
      const store = tx.objectStore('oplog');
      const request = store.get(opId);

      request.onsuccess = () => {
        const record = request.result;
        if (record) {
          record.synced = true;
          record.syncedAt = Date.now();
          store.put(record);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Increment retry count for an operation
   * @param {string} opId 
   * @param {string} error - Error message
   * @returns {Promise<void>}
   */
  async incrementRetry(opId, error) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readwrite');
      const store = tx.objectStore('oplog');
      const request = store.get(opId);

      request.onsuccess = () => {
        const record = request.result;
        if (record) {
          record.retryCount = (record.retryCount || 0) + 1;
          record.lastError = error;
          record.lastRetryAt = Date.now();
          store.put(record);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Delete an operation
   * @param {string} opId 
   * @returns {Promise<void>}
   */
  async deleteOp(opId) {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readwrite');
      const store = tx.objectStore('oplog');
      store.delete(opId);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get all operations (for debugging)
   * @returns {Promise<object[]>}
   */
  async getAllOps() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readonly');
      const store = tx.objectStore('oplog');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clean old synced operations
   * @returns {Promise<number>} Number of deleted operations
   */
  async cleanSyncedOps() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readwrite');
      const store = tx.objectStore('oplog');
      const index = store.index('synced');
      const request = index.openCursor(true); // synced = true

      const cutoff = Date.now() - this.maxAge;
      let deletedCount = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const record = cursor.value;
          if (record.timestamp < cutoff) {
            cursor.delete();
            deletedCount++;
          }
          cursor.continue();
        } else {
          console.log(`[OplogManager] Cleaned ${deletedCount} old synced operations`);
          resolve(deletedCount);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clean operations exceeding max count
   * @returns {Promise<number>} Number of deleted operations
   */
  async cleanExcessOps() {
    await this.ensureInitialized();

    const allOps = await this.getAllOps();
    if (allOps.length <= this.maxOps) {
      return 0;
    }

    // Sort by timestamp and delete oldest synced operations
    const sorted = allOps.sort((a, b) => b.timestamp - a.timestamp);
    const toDelete = sorted
      .filter(op => op.synced)
      .slice(this.maxOps);

    let deletedCount = 0;
    for (const op of toDelete) {
      await this.deleteOp(op.id);
      deletedCount++;
    }

    console.log(`[OplogManager] Cleaned ${deletedCount} excess operations`);
    return deletedCount;
  }

  /**
   * Get oplog statistics
   * @returns {Promise<{total: number, pending: number, synced: number, byType: object}>}
   */
  async getStats() {
    await this.ensureInitialized();

    const allOps = await this.getAllOps();

    const stats = {
      total: allOps.length,
      pending: 0,
      synced: 0,
      byType: {}
    };

    for (const op of allOps) {
      if (op.synced) {
        stats.synced++;
      } else {
        stats.pending++;
      }

      stats.byType[op.type] = (stats.byType[op.type] || 0) + 1;
    }

    return stats;
  }

  /**
   * Clear all operations
   * @returns {Promise<void>}
   */
  async clear() {
    await this.ensureInitialized();

    return new Promise((resolve, reject) => {
      const db = this.persistedStore.db;
      const tx = db.transaction('oplog', 'readwrite');
      const store = tx.objectStore('oplog');
      store.clear();

      tx.oncomplete = () => {
        console.log('[OplogManager] Oplog cleared');
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Replay pending operations through API
   * @param {object} api - API client
   * @param {object} handlers - Map of operation types to handler functions
   * @returns {Promise<{success: number, failed: number, errors: string[]}>}
   */
  async replayPendingOps(api, handlers) {
    const pendingOps = await this.getPendingOps();
    const result = {
      success: 0,
      failed: 0,
      errors: []
    };

    for (const op of pendingOps) {
      const handler = handlers[op.type];
      if (!handler) {
        console.warn(`[OplogManager] No handler for operation type: ${op.type}`);
        continue;
      }

      try {
        await handler(op.data, api);
        await this.markSynced(op.id);
        result.success++;
      } catch (error) {
        await this.incrementRetry(op.id, error.message);
        result.failed++;
        result.errors.push(`${op.id}: ${error.message}`);
      }
    }

    console.log(`[OplogManager] Replay complete: ${result.success} success, ${result.failed} failed`);
    return result;
  }
}
