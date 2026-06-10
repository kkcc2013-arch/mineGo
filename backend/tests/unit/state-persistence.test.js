// backend/tests/unit/state-persistence.test.js
// Unit tests for game state persistence system (REQ-00095)
'use strict';

const { describe, it, beforeEach, afterEach, expect, vi } = require('@jest/globals');

// Mock IndexedDB
const mockIndexedDB = () => {
  const stores = {};
  let dbVersion = 0;

  const mockDB = {
    objectStoreNames: {
      contains: (name) => stores.hasOwnProperty(name)
    },
    createObjectStore: vi.fn((name, options) => {
      const store = {
        data: new Map(),
        indexes: {},
        createIndex: vi.fn((indexName, keyPath, options) => {
          store.indexes[indexName] = { keyPath, data: new Map() };
        }),
        put: vi.fn((value) => {
          const key = value[options?.keyPath || 'id'] || Date.now().toString();
          store.data.set(key, value);
          return key;
        }),
        get: vi.fn((key) => store.data.get(key)),
        delete: vi.fn((key) => store.data.delete(key)),
        getAll: vi.fn(() => Array.from(store.data.values())),
        getAllKeys: vi.fn(() => Array.from(store.data.keys())),
        clear: vi.fn(() => store.data.clear()),
        count: vi.fn(() => store.data.size)
      };
      stores[name] = store;
      return store;
    }),
    transaction: vi.fn((storeNames, mode) => {
      const storeNamesArr = Array.isArray(storeNames) ? storeNames : [storeNames];
      const objectStores = storeNamesArr.map(name => stores[name]).filter(Boolean);
      
      let onComplete = null;
      let onError = null;

      const tx = {
        objectStore: vi.fn((name) => stores[name]),
        oncomplete: null,
        onerror: null,
        error: null
      };

      // Set up setters to capture callbacks
      Object.defineProperty(tx, 'oncomplete', {
        set: (cb) => { onComplete = cb; },
        get: () => onComplete
      });
      Object.defineProperty(tx, 'onerror', {
        set: (cb) => { onError = cb; },
        get: () => onError
      });

      // Simulate async completion
      setTimeout(() => {
        if (onComplete) onComplete();
      }, 0);

      return tx;
    }),
    close: vi.fn()
  };

  return mockDB;
};

// Mock global indexedDB
global.indexedDB = {
  open: vi.fn((dbName, version) => {
    const mockDB = mockIndexedDB();
    const request = {
      result: mockDB,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null
    };

    // Simulate async success
    setTimeout(() => {
      if (request.onupgradeneeded) {
        request.onupgradeneeded({ target: request, oldVersion: 0, newVersion: version });
      }
      if (request.onsuccess) {
        request.onsuccess({ target: request });
      }
    }, 0);

    return request;
  })
};

// Import modules after mocks
const { StateMigrator } = require('../../../frontend/game-client/src/storage/StateMigrator.js');

describe('StateMigrator', () => {
  describe('isCompatibleVersion', () => {
    it('should accept current version', () => {
      expect(StateMigrator.isCompatibleVersion(1)).toBe(true);
    });

    it('should accept older versions', () => {
      expect(StateMigrator.isCompatibleVersion(0)).toBe(true);
    });

    it('should reject future versions', () => {
      expect(StateMigrator.isCompatibleVersion(999)).toBe(false);
    });

    it('should reject non-numeric versions', () => {
      expect(StateMigrator.isCompatibleVersion('1')).toBe(false);
      expect(StateMigrator.isCompatibleVersion(null)).toBe(false);
      expect(StateMigrator.isCompatibleVersion(undefined)).toBe(false);
    });
  });

  describe('migrate', () => {
    it('should return same state for same version', () => {
      const state = { pokeballs: 10, stardust: 100 };
      const result = StateMigrator.migrate(state, 1, 1);
      expect(result).toEqual(state);
    });

    it('should handle backward migration gracefully', () => {
      const state = { pokeballs: 10, stardust: 100 };
      const result = StateMigrator.migrate(state, 2, 1);
      expect(result).toEqual(state);
    });

    it('should migrate through versions', () => {
      const state = { pokeballs: 10, stardust: 100 };
      const result = StateMigrator.migrate(state, 0, 1);
      expect(result).toEqual(state);
    });
  });

  describe('validate', () => {
    it('should validate correct state', () => {
      const state = {
        isLoggedIn: true,
        pokeballs: 10,
        playerLat: 40.7128
      };
      const result = StateMigrator.validate(state);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject null state', () => {
      const result = StateMigrator.validate(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('State must be an object');
    });

    it('should detect invalid types', () => {
      const state = {
        isLoggedIn: 'true', // Should be boolean
        pokeballs: 'ten'    // Should be number
      };
      const result = StateMigrator.validate(state);
      expect(result.valid).toBe(false);
    });

    it('should accept null coordinates', () => {
      const state = {
        isLoggedIn: true,
        playerLat: null,
        playerLng: null
      };
      const result = StateMigrator.validate(state);
      expect(result.valid).toBe(true);
    });
  });

  describe('createDefaultState', () => {
    it('should create default state with all fields', () => {
      const state = StateMigrator.createDefaultState();
      
      expect(state).toHaveProperty('isLoggedIn', false);
      expect(state).toHaveProperty('isOffline');
      expect(state).toHaveProperty('pokeballs', 0);
      expect(state).toHaveProperty('stardust', 0);
      expect(state).toHaveProperty('coins', 0);
      expect(state).toHaveProperty('activeScreen', 'map');
    });

    it('should include version', () => {
      const state = StateMigrator.createDefaultState();
      expect(state.version).toBe(StateMigrator.CURRENT_VERSION);
    });
  });

  describe('sanitizeForPersistence', () => {
    it('should remove non-persistable keys', () => {
      const state = {
        pokeballs: 10,
        nonPersistableKey: 'value',
        wildPokemon: [{ id: 1 }], // Not in persistable list
        activeScreen: 'map'
      };
      
      const sanitized = StateMigrator.sanitizeForPersistence(state);
      
      expect(sanitized).toHaveProperty('pokeballs', 10);
      expect(sanitized).toHaveProperty('activeScreen', 'map');
      expect(sanitized).not.toHaveProperty('nonPersistableKey');
      expect(sanitized).not.toHaveProperty('wildPokemon');
    });

    it('should sanitize user data', () => {
      const state = {
        currentUser: {
          id: 1,
          username: 'test',
          password: 'secret', // Should not be included
          email: 'test@test.com',
          level: 5,
          experience: 100
        }
      };
      
      const sanitized = StateMigrator.sanitizeForPersistence(state);
      
      expect(sanitized.currentUser).toHaveProperty('id', 1);
      expect(sanitized.currentUser).toHaveProperty('username', 'test');
      expect(sanitized.currentUser).not.toHaveProperty('password');
    });

    it('should remove functions', () => {
      const state = {
        pokeballs: 10,
        someFunction: () => {}
      };
      
      const sanitized = StateMigrator.sanitizeForPersistence(state);
      
      expect(sanitized).toHaveProperty('pokeballs', 10);
      expect(sanitized).not.toHaveProperty('someFunction');
    });
  });

  describe('mergeStates', () => {
    const localState = {
      pokeballs: 10,
      stardust: 100,
      activeScreen: 'catch',
      localOnly: 'value'
    };

    const serverState = {
      pokeballs: 20,
      stardust: 200,
      activeScreen: 'map',
      serverOnly: 'value'
    };

    it('should prefer local with "local" strategy', () => {
      const merged = StateMigrator.mergeStates(localState, serverState, 'local');
      expect(merged).toEqual(localState);
    });

    it('should prefer server with "server" strategy', () => {
      const merged = StateMigrator.mergeStates(localState, serverState, 'server');
      expect(merged).toEqual(serverState);
    });

    it('should merge correctly with default strategy', () => {
      const merged = StateMigrator.mergeStates(localState, serverState, 'merge');
      
      // Server wins for inventory
      expect(merged.pokeballs).toBe(20);
      expect(merged.stardust).toBe(200);
      
      // Local wins for UI state
      expect(merged.activeScreen).toBe('catch');
      expect(merged.localOnly).toBe('value');
    });
  });
});

describe('PersistedStore', () => {
  let PersistedStore;

  beforeEach(() => {
    // Re-import for each test
    jest.resetModules();
    PersistedStore = require('../../../frontend/game-client/src/storage/PersistedStore.js').PersistedStore;
  });

  it('should initialize successfully', async () => {
    const store = new PersistedStore('test-db', 1);
    await store.init();
    expect(store.db).not.toBeNull();
  });

  it('should create object stores on init', async () => {
    const store = new PersistedStore('test-db', 1);
    await store.init();
    
    // Verify createObjectStore was called for each store
    expect(store.db.createObjectStore).toHaveBeenCalledWith('state', { keyPath: 'key' });
    expect(store.db.createObjectStore).toHaveBeenCalledWith('pokemon', { keyPath: 'id' });
    expect(store.db.createObjectStore).toHaveBeenCalledWith('mapElements', { keyPath: 'id' });
    expect(store.db.createObjectStore).toHaveBeenCalledWith('oplog', { keyPath: 'id' });
  });

  it('should reuse existing init promise', async () => {
    const store = new PersistedStore('test-db', 1);
    const promise1 = store.init();
    const promise2 = store.init();
    expect(promise1).toBe(promise2);
  });
});

describe('PokemonCache', () => {
  let PokemonCache;
  let mockPersistedStore;

  beforeEach(() => {
    jest.resetModules();
    PokemonCache = require('../../../frontend/game-client/src/storage/PokemonCache.js').PokemonCache;
    
    mockPersistedStore = {
      init: vi.fn().mockResolvedValue(),
      db: mockIndexedDB()
    };
  });

  it('should cache single Pokemon', async () => {
    const cache = new PokemonCache(mockPersistedStore);
    const pokemon = { id: 'pokemon-1', speciesId: 25, cp: 500 };
    
    await cache.cachePokemon(pokemon);
    // Should not throw
  });

  it('should cache multiple Pokemon', async () => {
    const cache = new PokemonCache(mockPersistedStore);
    const pokemonList = [
      { id: 'pokemon-1', speciesId: 25, cp: 500 },
      { id: 'pokemon-2', speciesId: 1, cp: 300 }
    ];
    
    await cache.cachePokemonList(pokemonList);
    // Should not throw
  });
});

describe('MapElementCache', () => {
  let MapElementCache;
  let mockPersistedStore;

  beforeEach(() => {
    jest.resetModules();
    MapElementCache = require('../../../frontend/game-client/src/storage/MapElementCache.js').MapElementCache;
    
    mockPersistedStore = {
      init: vi.fn().mockResolvedValue(),
      db: mockIndexedDB()
    };
  });

  it('should cache wild Pokemon', async () => {
    const cache = new MapElementCache(mockPersistedStore);
    const wildPokemon = [
      { id: 'wild-1', speciesId: 25, lat: 40.7, lng: -74.0 }
    ];
    
    await cache.cacheWildPokemon(wildPokemon);
    // Should not throw
  });

  it('should cache Pokestops', async () => {
    const cache = new MapElementCache(mockPersistedStore);
    const pokestops = [
      { id: 'pokestop-1', name: 'Test Stop', lat: 40.7, lng: -74.0 }
    ];
    
    await cache.cachePokestops(pokestops);
    // Should not throw
  });

  it('should cache Gyms', async () => {
    const cache = new MapElementCache(mockPersistedStore);
    const gyms = [
      { id: 'gym-1', name: 'Test Gym', lat: 40.7, lng: -74.0 }
    ];
    
    await cache.cacheGyms(gyms);
    // Should not throw
  });
});

describe('OplogManager', () => {
  let OplogManager;
  let mockPersistedStore;

  beforeEach(() => {
    jest.resetModules();
    OplogManager = require('../../../frontend/game-client/src/storage/OplogManager.js').OplogManager;
    
    mockPersistedStore = {
      init: vi.fn().mockResolvedValue(),
      db: mockIndexedDB()
    };
  });

  it('should record operation', async () => {
    const manager = new OplogManager(mockPersistedStore);
    const op = {
      type: 'catch',
      data: { pokemonId: 'pokemon-1' }
    };
    
    const opId = await manager.recordOp(op);
    expect(opId).toMatch(/^op_/);
  });
});

describe('StateSyncManager', () => {
  let StateSyncManager;
  let mockPersistedStore;
  let mockApi;

  beforeEach(() => {
    jest.resetModules();
    StateSyncManager = require('../../../frontend/game-client/src/storage/StateSyncManager.js').StateSyncManager;
    
    mockPersistedStore = {
      init: vi.fn().mockResolvedValue(),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue()
    };

    mockApi = {
      get: vi.fn().mockResolvedValue({
        isLoggedIn: true,
        pokeballs: 20,
        stardust: 200
      })
    };
  });

  it('should merge states correctly', async () => {
    const manager = new StateSyncManager(mockPersistedStore, mockApi);
    
    mockPersistedStore.get.mockResolvedValueOnce({
      value: {
        state: { pokeballs: 10, stardust: 100, activeScreen: 'catch' },
        version: 1,
        savedAt: Date.now()
      }
    });
    
    const merged = await manager.mergeWithServer('merge');
    
    expect(merged.pokeballs).toBe(20); // Server wins
    expect(merged.activeScreen).toBe('catch'); // Local wins
  });

  it('should filter expired data', async () => {
    const manager = new StateSyncManager(mockPersistedStore, mockApi);
    
    const oldTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const state = {
      wildPokemon: [{ id: 1 }],
      pokeballs: 10
    };
    
    const filtered = manager.filterExpiredData(state, oldTime);
    
    expect(filtered.wildPokemon).toEqual([]);
    expect(filtered.pokeballs).toBe(10);
  });

  it('should calculate checksum', () => {
    const manager = new StateSyncManager(mockPersistedStore, mockApi);
    const state = { pokeballs: 10, stardust: 100 };
    
    const checksum = manager.calculateChecksum(state);
    
    expect(typeof checksum).toBe('string');
    expect(checksum.length).toBeGreaterThan(0);
  });
});

// Test summary
console.log('[State Persistence Tests] All test modules loaded successfully');
