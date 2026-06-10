// frontend/game-client/src/storage/StateSyncManager.js
// Manages state synchronization between local storage and server
'use strict';

import { StateMigrator } from './StateMigrator.js';

/**
 * StateSyncManager - Handles state sync, conflict resolution, and merge
 */
export class StateSyncManager {
  /**
   * @param {import('./PersistedStore').PersistedStore} persistedStore 
   * @param {object} api - API client instance
   */
  constructor(persistedStore, api) {
    this.persistedStore = persistedStore;
    this.api = api;
    this.syncInterval = 5 * 60 * 1000; // 5 minutes
    this._syncTimer = null;
    this._isSyncing = false;
    this._lastSyncTime = null;
  }

  /**
   * Ensure store is initialized
   */
  async ensureInitialized() {
    await this.persistedStore.init();
  }

  /**
   * Get local state
   * @returns {Promise<object|null>}
   */
  async getLocalState() {
    await this.ensureInitialized();
    return await this.persistedStore.get('gameState');
  }

  /**
   * Get server state
   * @returns {Promise<object>}
   */
  async getServerState() {
    try {
      const response = await this.api.get('/users/me/state');
      return response.data || response;
    } catch (error) {
      console.error('[StateSyncManager] Failed to get server state:', error);
      throw error;
    }
  }

  /**
   * Get state checksum from server (lightweight sync check)
   * @returns {Promise<string|null>}
   */
  async getServerChecksum() {
    try {
      const response = await this.api.get('/users/me/state/checksum');
      return response.checksum || response.data?.checksum || null;
    } catch (error) {
      console.warn('[StateSyncManager] Failed to get checksum:', error);
      return null;
    }
  }

  /**
   * Merge local state with server state
   * @param {'local'|'server'|'merge'} strategy 
   * @returns {Promise<object>}
   */
  async mergeWithServer(strategy = 'merge') {
    await this.ensureInitialized();

    const localData = await this.getLocalState();
    const localState = localData?.value?.state || {};
    const localVersion = localData?.value?.version || 1;
    const savedAt = localData?.value?.savedAt;

    try {
      const serverState = await this.getServerState();
      
      // Check if we need migration
      const migratedLocal = StateMigrator.migrate(
        localState, 
        localVersion, 
        StateMigrator.CURRENT_VERSION
      );

      // Filter expired local data before merge
      const filteredLocal = this.filterExpiredData(migratedLocal, savedAt);

      // Merge states
      const merged = StateMigrator.mergeStates(filteredLocal, serverState, strategy);

      console.log('[StateSyncManager] Merged state from server');
      return merged;
    } catch (error) {
      console.warn('[StateSyncManager] Merge failed, using local state:', error);
      return localState;
    }
  }

  /**
   * Filter expired data from state
   * @param {object} state 
   * @param {number} savedAt 
   * @returns {object}
   */
  filterExpiredData(state, savedAt) {
    if (!savedAt) return state;

    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    // If saved time exceeds max age, clear time-sensitive data
    if (now - savedAt > maxAge) {
      return {
        ...state,
        wildPokemon: [],
        pokestops: [],
        gyms: [],
        activeCatch: null
      };
    }

    return state;
  }

  /**
   * Perform a full sync with server
   * @param {object} store - GameStore instance
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sync(store) {
    if (this._isSyncing) {
      return { success: false, error: 'Sync already in progress' };
    }

    this._isSyncing = true;

    try {
      const merged = await this.mergeWithServer('merge');
      store.set(merged);
      this._lastSyncTime = Date.now();

      // Update local cache
      await this.saveLocalState(merged);

      console.log('[StateSyncManager] Sync completed successfully');
      return { success: true };
    } catch (error) {
      console.error('[StateSyncManager] Sync failed:', error);
      return { success: false, error: error.message };
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Save local state to persisted storage
   * @param {object} state 
   * @returns {Promise<void>}
   */
  async saveLocalState(state) {
    await this.ensureInitialized();

    const sanitized = StateMigrator.sanitizeForPersistence(state);
    const stateData = {
      version: StateMigrator.CURRENT_VERSION,
      savedAt: Date.now(),
      state: sanitized
    };

    await this.persistedStore.set('gameState', stateData);
  }

  /**
   * Start periodic sync
   * @param {object} store - GameStore instance
   */
  startPeriodicSync(store) {
    if (this._syncTimer) {
      this.stopPeriodicSync();
    }

    // Initial sync
    this.sync(store).catch(err => {
      console.warn('[StateSyncManager] Initial sync failed:', err);
    });

    // Set up periodic sync
    this._syncTimer = setInterval(async () => {
      if (navigator.onLine) {
        await this.sync(store);
      }
    }, this.syncInterval);

    // Also sync when coming back online
    window.addEventListener('online', () => {
      console.log('[StateSyncManager] Back online, triggering sync');
      this.sync(store);
    });

    console.log('[StateSyncManager] Started periodic sync');
  }

  /**
   * Stop periodic sync
   */
  stopPeriodicSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    console.log('[StateSyncManager] Stopped periodic sync');
  }

  /**
   * Get sync status
   * @returns {{isSyncing: boolean, lastSyncTime: number|null}}
   */
  getStatus() {
    return {
      isSyncing: this._isSyncing,
      lastSyncTime: this._lastSyncTime
    };
  }

  /**
   * Force sync (for user-initiated sync)
   * @param {object} store - GameStore instance
   */
  async forceSync(store) {
    console.log('[StateSyncManager] Force sync triggered');
    return await this.sync(store);
  }

  /**
   * Handle conflict between local and server state
   * @param {object} localState 
   * @param {object} serverState 
   * @returns {object}
   */
  resolveConflict(localState, serverState) {
    // Default: server wins for inventory, local wins for UI state
    return StateMigrator.mergeStates(localState, serverState, 'merge');
  }

  /**
   * Calculate state checksum
   * @param {object} state 
   * @returns {string}
   */
  calculateChecksum(state) {
    // Simple checksum based on key values
    const str = JSON.stringify(StateMigrator.sanitizeForPersistence(state));
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }
}
