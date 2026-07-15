// frontend/game-client/src/storage/OfflineSyncEngine.js
// Advanced offline synchronization engine with conflict resolution
'use strict';

import { StateSyncManager } from './StateSyncManager.js';
import { OplogManager } from './OplogManager.js';
import { networkMonitor } from '../network/NetworkMonitor.js';

/**
 * OfflineSyncEngine - Advanced offline synchronization with:
 * - Exponential backoff retry
 * - Conflict resolution strategies
 * - Batch synchronization
 * - Progress tracking
 */
export class OfflineSyncEngine {
  /**
   * @param {import('./PersistedStore').PersistedStore} persistedStore 
   * @param {object} api - API client instance
   * @param {object} options - Configuration options
   */
  constructor(persistedStore, api, options = {}) {
    this.persistedStore = persistedStore;
    this.api = api;
    this.stateSyncManager = new StateSyncManager(persistedStore, api);
    this.oplogManager = new OplogManager(persistedStore);
    
    this.options = {
      maxRetries: options.maxRetries || 5,
      batchSize: options.batchSize || 10,
      syncInterval: options.syncInterval || 60000, // 1 minute
      conflictStrategy: options.conflictStrategy || 'server-wins',
      ...options
    };

    this._syncTimer = null;
    this._isSyncing = false;
    this._lastSyncResult = null;
    this._syncProgress = null;
    this._listeners = new Map();
  }

  /**
   * Initialize the sync engine
   */
  async init() {
    await this.persistedStore.init();

    // Listen to network events
    networkMonitor.on('online', () => this._handleOnline());
    networkMonitor.on('offline', () => this._handleOffline());

    // Start periodic sync
    this.startPeriodicSync();

    // Sync pending operations if online
    if (networkMonitor.isOnline()) {
      await this.syncPendingOperations();
    }

    console.log('[OfflineSyncEngine] Initialized');
  }

  /**
   * Record an offline operation
   * @param {string} type - Operation type
   * @param {object} data - Operation data
   * @returns {Promise<string>} Operation ID
   */
  async recordOfflineOperation(type, data) {
    const opId = await this.oplogManager.recordOp({ type, data });
    
    console.log(`[OfflineSyncEngine] Recorded offline operation: ${type}`);
    
    // Try to sync immediately if online
    if (networkMonitor.isOnline()) {
      this.syncPendingOperations().catch(err => {
        console.warn('[OfflineSyncEngine] Immediate sync failed:', err);
      });
    }
    
    return opId;
  }

  /**
   * Sync all pending operations
   * @returns {Promise<{success: number, failed: number, conflicts: number, errors: string[]}>}
   */
  async syncPendingOperations() {
    if (this._isSyncing) {
      console.log('[OfflineSyncEngine] Sync already in progress');
      return this._lastSyncResult || { success: 0, failed: 0, conflicts: 0, errors: [] };
    }

    this._isSyncing = true;
    this._emitSyncProgress({ phase: 'starting', progress: 0 });

    try {
      const pendingOps = await this.oplogManager.getPendingOps();
      
      if (pendingOps.length === 0) {
        this._emitSyncProgress({ phase: 'complete', progress: 100 });
        return { success: 0, failed: 0, conflicts: 0, errors: [] };
      }

      console.log(`[OfflineSyncEngine] Syncing ${pendingOps.length} pending operations`);

      const result = {
        success: 0,
        failed: 0,
        conflicts: 0,
        errors: []
      };

      // Process in batches
      const batches = this._chunkArray(pendingOps, this.options.batchSize);
      let processed = 0;

      for (const batch of batches) {
        for (const op of batch) {
          try {
            const syncResult = await this._syncSingleOperation(op);
            
            if (syncResult.conflict) {
              result.conflicts++;
              const resolved = await this._resolveConflict(op, syncResult);
              if (resolved) {
                result.success++;
              } else {
                result.failed++;
                result.errors.push(`Conflict resolution failed: ${op.id}`);
              }
            } else {
              await this.oplogManager.markSynced(op.id);
              result.success++;
            }
          } catch (error) {
            result.failed++;
            result.errors.push(`${op.id}: ${error.message}`);
            await this.oplogManager.incrementRetry(op.id, error.message);
          }

          processed++;
          this._emitSyncProgress({
            phase: 'syncing',
            progress: Math.round((processed / pendingOps.length) * 100),
            current: processed,
            total: pendingOps.length
          });

          // Add small delay between operations to avoid rate limiting
          await this._sleep(50);
        }
      }

      this._lastSyncResult = result;
      this._emitSyncProgress({ phase: 'complete', progress: 100, result });
      
      console.log(`[OfflineSyncEngine] Sync complete: ${result.success} success, ${result.failed} failed, ${result.conflicts} conflicts`);
      
      return result;
    } catch (error) {
      console.error('[OfflineSyncEngine] Sync failed:', error);
      this._emitSyncProgress({ phase: 'error', error: error.message });
      throw error;
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Sync a single operation
   * @param {object} op - Operation object
   * @returns {Promise<{success: boolean, conflict?: object}>}
   */
  async _syncSingleOperation(op) {
    const handlers = {
      'catch': this._syncCatchOperation.bind(this),
      'spin_pokestop': this._spinPokestopOperation.bind(this),
      'battle': this._syncBattleOperation.bind(this),
      'trade': this._syncTradeOperation.bind(this),
      'use_item': this._syncUseItemOperation.bind(this)
    };

    const handler = handlers[op.type];
    if (!handler) {
      throw new Error(`Unknown operation type: ${op.type}`);
    }

    return handler(op);
  }

  /**
   * Sync catch operation
   */
  async _syncCatchOperation(op) {
    const response = await networkMonitor.withRetry(
      () => this.api.post('/catch', op.data),
      { maxRetries: this.options.maxRetries }
    );

    // Check for conflict (e.g., pokemon already caught by another player)
    if (response.conflict) {
      return { success: false, conflict: response.conflict };
    }

    return { success: true };
  }

  /**
   * Sync pokestop spin operation
   */
  async _spinPokestopOperation(op) {
    const response = await networkMonitor.withRetry(
      () => this.api.post('/pokestop/spin', op.data),
      { maxRetries: this.options.maxRetries }
    );

    if (response.conflict) {
      return { success: false, conflict: response.conflict };
    }

    return { success: true };
  }

  /**
   * Sync battle operation
   */
  async _syncBattleOperation(op) {
    const response = await networkMonitor.withRetry(
      () => this.api.post('/gym/battle', op.data),
      { maxRetries: this.options.maxRetries }
    );

    if (response.conflict) {
      return { success: false, conflict: response.conflict };
    }

    return { success: true };
  }

  /**
   * Sync trade operation
   */
  async _syncTradeOperation(op) {
    const response = await networkMonitor.withRetry(
      () => this.api.post('/trade/execute', op.data),
      { maxRetries: this.options.maxRetries }
    );

    if (response.conflict) {
      return { success: false, conflict: response.conflict };
    }

    return { success: true };
  }

  /**
   * Sync use item operation
   */
  async _syncUseItemOperation(op) {
    const response = await networkMonitor.withRetry(
      () => this.api.post('/items/use', op.data),
      { maxRetries: this.options.maxRetries }
    );

    if (response.conflict) {
      return { success: false, conflict: response.conflict };
    }

    return { success: true };
  }

  /**
   * Resolve conflict based on strategy
   * @param {object} op - Original operation
   * @param {object} syncResult - Sync result with conflict info
   * @returns {Promise<boolean>} Whether conflict was resolved
   */
  async _resolveConflict(op, syncResult) {
    const conflict = syncResult.conflict;
    
    console.log(`[OfflineSyncEngine] Resolving conflict for ${op.id}:`, conflict.type);

    switch (this.options.conflictStrategy) {
      case 'server-wins':
        // Accept server state, mark operation as resolved
        await this.oplogManager.markSynced(op.id);
        return true;

      case 'client-wins':
        // Retry with client data (may fail again)
        try {
          await this._syncSingleOperation(op);
          await this.oplogManager.markSynced(op.id);
          return true;
        } catch {
          return false;
        }

      case 'merge':
        // Attempt to merge changes
        const mergedData = await this._mergeConflictData(op.data, conflict);
        if (mergedData) {
          try {
            await this.api.post(`/${op.type}`, mergedData);
            await this.oplogManager.markSynced(op.id);
            return true;
          } catch {
            return false;
          }
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Merge conflict data
   */
  async _mergeConflictData(localData, conflict) {
    // Simple merge: prefer local non-conflicting values
    if (conflict.type === 'version_mismatch') {
      return {
        ...conflict.serverData,
        ...localData,
        _baseVersion: conflict.serverVersion
      };
    }
    return null;
  }

  /**
   * Handle coming online
   */
  async _handleOnline() {
    console.log('[OfflineSyncEngine] Network online, starting sync');
    
    // Sync state first
    try {
      const store = await this.persistedStore.get('gameState');
      if (store) {
        await this.stateSyncManager.sync(store);
      }
    } catch (err) {
      console.warn('[OfflineSyncEngine] State sync failed:', err);
    }

    // Sync pending operations
    await this.syncPendingOperations();
  }

  /**
   * Handle going offline
   */
  _handleOffline() {
    console.log('[OfflineSyncEngine] Network offline, switching to offline mode');
    this._emit('offline');
  }

  /**
   * Start periodic synchronization
   */
  startPeriodicSync() {
    if (this._syncTimer) {
      this.stopPeriodicSync();
    }

    this._syncTimer = setInterval(() => {
      if (networkMonitor.isOnline()) {
        this.syncPendingOperations().catch(err => {
          console.warn('[OfflineSyncEngine] Periodic sync failed:', err);
        });
      }
    }, this.options.syncInterval);

    console.log('[OfflineSyncEngine] Started periodic sync');
  }

  /**
   * Stop periodic synchronization
   */
  stopPeriodicSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  /**
   * Get sync status
   */
  getSyncStatus() {
    return {
      isSyncing: this._isSyncing,
      lastSyncResult: this._lastSyncResult,
      progress: this._syncProgress
    };
  }

  /**
   * Emit sync progress event
   */
  _emitSyncProgress(progress) {
    this._syncProgress = progress;
    this._emit('sync-progress', progress);
  }

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    if (!this._listeners.has(event)) return;
    const listeners = this._listeners.get(event);
    const index = listeners.indexOf(callback);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Emit event
   */
  _emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach(callback => callback(data));
    }
  }

  /**
   * Chunk array helper
   */
  _chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Sleep helper
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.stopPeriodicSync();
    this._listeners.clear();
  }
}