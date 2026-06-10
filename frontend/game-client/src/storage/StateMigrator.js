// frontend/game-client/src/storage/StateMigrator.js
// State version migration system for backward compatibility
'use strict';

/**
 * StateMigrator - Handles state schema migrations
 * Ensures backward compatibility when state structure changes
 */
export class StateMigrator {
  static CURRENT_VERSION = 1;

  // Migration functions indexed by target version
  static migrations = {
    // Example for future versions:
    // 2: (state) => {
    //   // Migrate from v1 to v2
    //   return {
    //     ...state,
    //     newField: state.oldField ? transform(state.oldField) : defaultValue
    //   };
    // }
  };

  /**
   * Check if a state version is compatible with current version
   * @param {number} version 
   * @returns {boolean}
   */
  static isCompatibleVersion(version) {
    return typeof version === 'number' && version <= this.CURRENT_VERSION;
  }

  /**
   * Migrate state from one version to another
   * @param {object} state 
   * @param {number} fromVersion 
   * @param {number} toVersion 
   * @returns {object}
   */
  static migrate(state, fromVersion, toVersion) {
    if (fromVersion === toVersion) {
      return state;
    }

    if (fromVersion > toVersion) {
      console.warn('[StateMigrator] Cannot migrate backwards, using current state');
      return state;
    }

    let migrated = { ...state };

    for (let v = fromVersion + 1; v <= toVersion; v++) {
      if (this.migrations[v]) {
        console.log(`[StateMigrator] Migrating to version ${v}`);
        migrated = this.migrations[v](migrated);
      }
    }

    return migrated;
  }

  /**
   * Validate state structure
   * @param {object} state 
   * @returns {{valid: boolean, errors: string[]}}
   */
  static validate(state) {
    const errors = [];

    if (!state || typeof state !== 'object') {
      errors.push('State must be an object');
      return { valid: false, errors };
    }

    // Check for required fields
    const validFields = [
      'playerLat', 'playerLng', 'playerAccuracy',
      'pokeballs', 'greatballs', 'ultraballs', 'masterballs',
      'stardust', 'coins', 'activeScreen',
      'isLoggedIn', 'isOffline', 'canInstallPwa', 'pwaInstalled'
    ];

    // Check for invalid field types
    if (state.playerLat !== null && typeof state.playerLat !== 'number') {
      errors.push('playerLat must be a number or null');
    }
    if (state.playerLng !== null && typeof state.playerLng !== 'number') {
      errors.push('playerLng must be a number or null');
    }
    if (state.pokeballs !== undefined && typeof state.pokeballs !== 'number') {
      errors.push('pokeballs must be a number');
    }
    if (typeof state.isLoggedIn !== 'boolean') {
      errors.push('isLoggedIn must be a boolean');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get the current schema version
   * @returns {number}
   */
  static getCurrentVersion() {
    return this.CURRENT_VERSION;
  }

  /**
   * Add a migration function for a specific version
   * @param {number} version 
   * @param {function} migrationFn 
   */
  static addMigration(version, migrationFn) {
    if (typeof migrationFn !== 'function') {
      throw new Error('Migration must be a function');
    }
    this.migrations[version] = migrationFn;
    
    // Update current version if needed
    if (version > this.CURRENT_VERSION) {
      this.CURRENT_VERSION = version;
    }
  }

  /**
   * Create a default state object
   * @returns {object}
   */
  static createDefaultState() {
    return {
      version: this.CURRENT_VERSION,
      
      // Auth
      isLoggedIn: false,
      currentUser: null,

      // Connectivity
      isOffline: !navigator.onLine,
      canInstallPwa: false,
      pwaInstalled: false,

      // Location
      playerLat: null,
      playerLng: null,
      playerAccuracy: null,

      // Map elements (stored separately but referenced here)
      wildPokemon: [],
      pokestops: [],
      gyms: [],

      // Catch
      activeCatch: null,

      // Inventory
      pokeballs: 0,
      greatballs: 0,
      ultraballs: 0,
      masterballs: 0,
      stardust: 0,
      coins: 0,

      // UI
      activeScreen: 'map',
      notifications: [],
      loading: false
    };
  }

  /**
   * Sanitize state for persistence (remove non-serializable values)
   * @param {object} state 
   * @returns {object}
   */
  static sanitizeForPersistence(state) {
    const sanitized = {};
    const persistableKeys = [
      'playerLat', 'playerLng', 'playerAccuracy',
      'pokeballs', 'greatballs', 'ultraballs', 'masterballs',
      'stardust', 'coins', 'activeScreen',
      'isLoggedIn', 'isOffline', 'canInstallPwa', 'pwaInstalled',
      'currentUser'
    ];

    for (const key of persistableKeys) {
      if (state.hasOwnProperty(key)) {
        const value = state[key];
        
        // Handle special cases
        if (key === 'currentUser' && value) {
          // Only store essential user data
          sanitized[key] = {
            id: value.id,
            username: value.username,
            email: value.email,
            level: value.level,
            experience: value.experience
          };
        } else if (typeof value !== 'function') {
          sanitized[key] = value;
        }
      }
    }

    return sanitized;
  }

  /**
   * Merge states (for conflict resolution)
   * @param {object} localState 
   * @param {object} serverState 
   * @param {'local'|'server'|'merge'} strategy 
   * @returns {object}
   */
  static mergeStates(localState, serverState, strategy = 'merge') {
    switch (strategy) {
      case 'local':
        return localState;
      case 'server':
        return serverState;
      case 'merge':
      default:
        // Server is authoritative for inventory and user data
        // Local is authoritative for UI state
        return {
          ...localState,
          // Server-authorized fields
          pokeballs: serverState.pokeballs ?? localState.pokeballs,
          greatballs: serverState.greatballs ?? localState.greatballs,
          ultraballs: serverState.ultraballs ?? localState.ultraballs,
          masterballs: serverState.masterballs ?? localState.masterballs,
          stardust: serverState.stardust ?? localState.stardust,
          coins: serverState.coins ?? localState.coins,
          currentUser: serverState.currentUser ?? localState.currentUser,
          isLoggedIn: serverState.isLoggedIn ?? localState.isLoggedIn
        };
    }
  }
}
