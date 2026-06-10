// frontend/game-client/src/game/PersistedGameStore.js
// GameStore with automatic persistence and offline state recovery
'use strict';

import { GameStore } from './GameStore.js';
import { PersistedStore, persistedStore } from '../storage/PersistedStore.js';
import { PokemonCache } from '../storage/PokemonCache.js';
import { MapElementCache } from '../storage/MapElementCache.js';
import { StateSyncManager } from '../storage/StateSyncManager.js';
import { OplogManager } from '../storage/OplogManager.js';
import { StateMigrator } from '../storage/StateMigrator.js';

/**
 * PersistedGameStore - GameStore with IndexedDB persistence
 * Extends GameStore with automatic save/restore functionality
 */
export class PersistedGameStore extends GameStore {
  constructor() {
    super();
    
    // Initialize storage components
    this.persistedStore = persistedStore;
    this.pokemonCache = new PokemonCache(this.persistedStore);
    this.mapElementCache = new MapElementCache(this.persistedStore);
    this.oplogManager = new OplogManager(this.persistedStore);
    this.syncManager = null; // Initialized with API client
    
    // State
    this._saveDebounce = null;
    this._initialized = false;
    this._initializationPromise = null;
    
    // Metrics
    this._metrics = {
      saves: 0,
      restores: 0,
      lastSaveTime: null,
      lastRestoreTime: null,
      restoreDuration: 0
    };
  }

  /**
   * Initialize the persisted store
   * @param {object} api - Optional API client for sync
   * @returns {Promise<PersistedGameStore>}
   */
  async init(api = null) {
    // Return existing promise if already initializing
    if (this._initializationPromise) {
      return this._initializationPromise;
    }

    // Return immediately if already initialized
    if (this._initialized) {
      return this;
    }

    this._initializationPromise = this._doInit(api);
    return this._initializationPromise;
  }

  /**
   * Internal initialization
   * @private
   */
  async _doInit(api) {
    const startTime = Date.now();

    try {
      // Initialize IndexedDB
      await this.persistedStore.init();
      console.log('[PersistedGameStore] IndexedDB initialized');

      // Load persisted state
      await this.loadPersistedState();

      // Initialize sync manager if API provided
      if (api) {
        this.syncManager = new StateSyncManager(this.persistedStore, api);
        await this.syncManager.sync(this);
      }

      // Set up auto-save listener
      this.addEventListener('change', (e) => {
        this.debouncedSave(e.detail.changed);
      });

      // Start periodic sync if API provided
      if (api && this.syncManager) {
        this.syncManager.startPeriodicSync(this);
      }

      // Schedule periodic cleanup
      this._scheduleCleanup();

      this._initialized = true;
      this._metrics.restoreDuration = Date.now() - startTime;

      console.log(`[PersistedGameStore] Initialized in ${this._metrics.restoreDuration}ms`);
      return this;
    } catch (error) {
      console.error('[PersistedGameStore] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load persisted state from IndexedDB
   */
  async loadPersistedState() {
    try {
      const persisted = await this.persistedStore.get('gameState');
      
      if (persisted?.value) {
        const { state, version, savedAt } = persisted.value;

        // Check version compatibility
        if (StateMigrator.isCompatibleVersion(version)) {
          // Migrate if needed
          const migrated = StateMigrator.migrate(state, version, StateMigrator.CURRENT_VERSION);
          
          // Filter expired data
          const validState = this.filterExpiredData(migrated, savedAt);
          
          // Merge with default state
          this._state = { ...this._state, ...validState };
          
          this._metrics.restores++;
          this._metrics.lastRestoreTime = savedAt;
          
          console.log('[PersistedGameStore] Restored state from', new Date(savedAt).toISOString());
        } else {
          console.warn('[PersistedGameStore] Incompatible version, using default state');
        }
      }

      // Load cached map elements
      const mapElements = await this.mapElementCache.getAll();
      if (mapElements.wild.length > 0 || mapElements.pokestops.length > 0 || mapElements.gyms.length > 0) {
        this._state.wildPokemon = mapElements.wild;
        this._state.pokestops = mapElements.pokestops;
        this._state.gyms = mapElements.gyms;
        console.log('[PersistedGameStore] Restored cached map elements');
      }
    } catch (error) {
      console.error('[PersistedGameStore] Failed to load persisted state:', error);
    }
  }

  /**
   * Save state to IndexedDB
   * @param {string[]} changedKeys - Keys that changed
   */
  async saveState(changedKeys = null) {
    if (!this._initialized) return;

    try {
      // Sanitize and save core state
      const sanitized = StateMigrator.sanitizeForPersistence(this._state);
      const stateData = {
        version: StateMigrator.CURRENT_VERSION,
        savedAt: Date.now(),
        state: sanitized
      };

      await this.persistedStore.set('gameState', stateData);

      this._metrics.saves++;
      this._metrics.lastSaveTime = Date.now();

      console.log('[PersistedGameStore] State saved');
    } catch (error) {
      console.error('[PersistedGameStore] Failed to save state:', error);
    }
  }

  /**
   * Debounced save (1 second delay)
   * @param {string[]} changedKeys 
   */
  debouncedSave(changedKeys) {
    clearTimeout(this._saveDebounce);
    this._saveDebounce = setTimeout(() => {
      this.saveState(changedKeys);
    }, 1000);
  }

  /**
   * Force immediate save
   */
  async forceSave() {
    clearTimeout(this._saveDebounce);
    await this.saveState();
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
      console.log('[PersistedGameStore] Clearing expired map data');
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

  // ── Override GameStore methods for caching ────────────────────────

  /**
   * Override updateMapElements to cache to IndexedDB
   */
  async updateMapElements({ wildPokemons, pokestops, gyms }) {
    // Call parent method
    super.updateMapElements({ wildPokemons, pokestops, gyms });

    // Cache to IndexedDB
    if (this._initialized) {
      try {
        await this.mapElementCache.cacheAll({
          wildPokemon: wildPokemons,
          pokestops,
          gyms
        });
      } catch (error) {
        console.error('[PersistedGameStore] Failed to cache map elements:', error);
      }
    }
  }

  /**
   * Override removePokemon to update cache
   */
  async removePokemon(spawnId) {
    super.removePokemon(spawnId);
    
    if (this._initialized) {
      try {
        await this.mapElementCache.remove(spawnId);
      } catch (error) {
        console.error('[PersistedGameStore] Failed to remove cached Pokemon:', error);
      }
    }
  }

  // ── Pokemon cache methods ────────────────────────────────────────

  /**
   * Cache Pokemon list
   * @param {object[]} pokemonList 
   */
  async cachePokemon(pokemonList) {
    if (this._initialized) {
      await this.pokemonCache.cachePokemonList(pokemonList);
    }
  }

  /**
   * Get cached Pokemon
   * @returns {Promise<object[]>}
   */
  async getCachedPokemon() {
    if (this._initialized) {
      return await this.pokemonCache.getCachedPokemon();
    }
    return [];
  }

  // ── Operation log methods ────────────────────────────────────────

  /**
   * Record an operation for offline tracking
   * @param {string} type 
   * @param {object} data 
   * @returns {Promise<string>}
   */
  async recordOp(type, data) {
    if (this._initialized) {
      return await this.oplogManager.recordOp({ type, data });
    }
    return null;
  }

  /**
   * Get pending operations
   * @returns {Promise<object[]>}
   */
  async getPendingOps() {
    if (this._initialized) {
      return await this.oplogManager.getPendingOps();
    }
    return [];
  }

  // ── Sync methods ──────────────────────────────────────────────────

  /**
   * Force sync with server
   */
  async forceSync() {
    if (this.syncManager) {
      return await this.syncManager.forceSync(this);
    }
    return { success: false, error: 'Sync manager not initialized' };
  }

  /**
   * Get sync status
   */
  getSyncStatus() {
    if (this.syncManager) {
      return this.syncManager.getStatus();
    }
    return { isSyncing: false, lastSyncTime: null };
  }

  // ── Metrics ───────────────────────────────────────────────────────

  /**
   * Get storage metrics
   * @returns {Promise<object>}
   */
  async getMetrics() {
    const stats = this._initialized ? await this.persistedStore.getStats() : { storeCounts: {}, totalSize: 0 };
    
    return {
      ...this._metrics,
      ...stats,
      initialized: this._initialized
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  /**
   * Schedule periodic cleanup
   * @private
   */
  _scheduleCleanup() {
    // Clean expired data every 30 minutes
    setInterval(async () => {
      if (this._initialized) {
        try {
          await Promise.all([
            this.pokemonCache.cleanExpired(),
            this.mapElementCache.cleanExpired(),
            this.oplogManager.cleanSyncedOps()
          ]);
        } catch (error) {
          console.error('[PersistedGameStore] Cleanup failed:', error);
        }
      }
    }, 30 * 60 * 1000);
  }

  /**
   * Clear all persisted data
   */
  async clearAll() {
    if (this._initialized) {
      await this.persistedStore.clearAll();
      console.log('[PersistedGameStore] All data cleared');
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    clearTimeout(this._saveDebounce);
    
    if (this.syncManager) {
      this.syncManager.stopPeriodicSync();
    }
    
    this.persistedStore.close();
    this._initialized = false;
  }
}

// Singleton instance
export const persistedGameStore = new PersistedGameStore();
