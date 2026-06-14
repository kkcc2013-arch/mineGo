// backend/tests/unit/pokemon-backup.test.js
'use strict';

/**
 * Pokemon Backup Service Unit Tests
 * REQ-00129: 精灵数据备份与恢复系统
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { 
  PokemonBackupService, 
  LocalStorageAdapter,
  BACKUP_TYPES,
  BACKUP_STATUS,
  RESTORE_STATUS,
  RESTORE_MODES
} = require('../../shared/pokemonBackupService');

// Mock database client
function createMockDb() {
  const queries = [];
  let currentResults = [];
  
  return {
    queries,
    setCurrentResults: (results) => { currentResults = results; },
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        const result = currentResults.shift() || { rows: [], rowCount: 0 };
        return result;
      },
      release: () => {}
    }),
    query: async (sql, params) => {
      queries.push({ sql, params });
      const result = currentResults.shift() || { rows: [], rowCount: 0 };
      return result;
    }
  };
}

// Mock Redis
function createMockRedis() {
  const store = new Map();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => { store.set(key, value); return 'OK'; },
    del: async (key) => { store.delete(key); return 1; },
    hset: async (key, obj) => { store.set(key, obj); return 1; },
    hgetall: async (key) => store.get(key) || {},
    keys: async (pattern) => []
  };
}

// Mock storage adapter
function createMockStorage() {
  const store = new Map();
  return {
    store: async (path, data) => { store.set(path, data); },
    load: async (path) => store.get(path),
    delete: async (path) => { store.delete(path); },
    _store: store
  };
}

describe('PokemonBackupService', () => {
  let service;
  let mockDb;
  let mockRedis;
  let mockStorage;

  beforeEach(() => {
    mockDb = createMockDb();
    mockRedis = createMockRedis();
    mockStorage = createMockStorage();
    
    service = new PokemonBackupService(mockDb, mockRedis, {
      storageAdapter: mockStorage,
      encryptionEnabled: false // Disable for testing
    });
  });

  describe('createBackup', () => {
    it('should create a manual backup successfully', async () => {
      // Setup mock results
      mockDb.setCurrentResults([
        { rows: [{ id: 1 }] }, // Create metadata
        { rows: [ // Fetch pokemon data
          { instance_id: 1, species_id: 25, nickname: 'Pikachu', level: 50 },
          { instance_id: 2, species_id: 1, nickname: 'Bulbasaur', level: 30 }
        ]},
        { rows: [] }, // Insert backup content 1
        { rows: [] }, // Insert backup content 2
        { rows: [] }, // Update metadata
        { rows: [] }  // Update quota
      ]);

      const result = await service.createBackup(1, BACKUP_TYPES.MANUAL);

      assert.ok(result.backup_id);
      assert.strictEqual(result.backup_type, BACKUP_TYPES.MANUAL);
      assert.strictEqual(result.pokemon_count, 2);
      assert.ok(result.backup_size_bytes > 0);
    });

    it('should reject backup when quota is exceeded', async () => {
      mockDb.setCurrentResults([
        { rows: [{ current_manual_backups: 5, max_manual_backups: 5 }] } // Quota check
      ]);

      await assert.rejects(
        async () => await service.createBackup(1, BACKUP_TYPES.MANUAL),
        /Backup quota exceeded/
      );
    });

    it('should reject backup when no pokemon data', async () => {
      mockDb.setCurrentResults([
        { rows: [{ id: 1 }] }, // Create metadata
        { rows: [] } // No pokemon
      ]);

      await assert.rejects(
        async () => await service.createBackup(1, BACKUP_TYPES.MANUAL),
        /No Pokemon data to backup/
      );
    });
  });

  describe('restoreFromBackup', () => {
    it('should restore from backup in merge mode', async () => {
      mockDb.setCurrentResults([
        { rows: [{ // Backup check
          id: 1,
          expires_at: new Date(Date.now() + 86400000),
          storage_path: 'backups/1/1-123.bak'
        }]},
        { rows: [{ id: 1 }] }, // Create restore record
        { rows: [] }, // No db contents, will try storage
        { rows: [{ id: 1 }, { id: 2 }] }, // Existing pokemon
        { rows: [] }, // Restore pokemon 1
        { rows: [] }, // Restore pokemon 2
        { rows: [] }, // Update restore record
        { rows: [] }  // Update quota
      ]);

      // Setup mock storage with backup data
      const backupData = {
        version: '1.0',
        pokemon: [
          { instance_id: 3, species_id: 6, nickname: 'Charizard', level: 60 }
        ]
      };
      const zlib = require('zlib');
      const compressed = await require('util').promisify(zlib.gzip)(Buffer.from(JSON.stringify(backupData)));
      mockStorage.store('backups/1/1-123.bak', compressed);

      const result = await service.restoreFromBackup(1, 1, {
        restoreMode: RESTORE_MODES.MERGE
      });

      assert.strictEqual(result.status, RESTORE_STATUS.COMPLETED);
    });

    it('should reject restore for expired backup', async () => {
      mockDb.setCurrentResults([
        { rows: [{ // Expired backup
          id: 1,
          expires_at: new Date(Date.now() - 86400000) // Yesterday
        }]}
      ]);

      await assert.rejects(
        async () => await service.restoreFromBackup(1, 1),
        /Backup has expired/
      );
    });

    it('should reject restore for non-existent backup', async () => {
      mockDb.setCurrentResults([
        { rows: [] } // No backup found
      ]);

      await assert.rejects(
        async () => await service.restoreFromBackup(1, 999),
        /Backup not found/
      );
    });
  });

  describe('getUserBackups', () => {
    it('should return user backup list', async () => {
      mockDb.setCurrentResults([
        { rows: [
          { id: 1, backup_type: 'manual', pokemon_count: 10 },
          { id: 2, backup_type: 'auto_daily', pokemon_count: 10 }
        ]},
        { rows: [{ total: '2' }] }
      ]);

      const result = await service.getUserBackups(1);

      assert.strictEqual(result.backups.length, 2);
      assert.strictEqual(result.total, 2);
    });

    it('should filter by backup type', async () => {
      mockDb.setCurrentResults([
        { rows: [{ id: 1, backup_type: 'manual' }] },
        { rows: [{ total: '1' }] }
      ]);

      const result = await service.getUserBackups(1, { type: 'manual' });

      assert.strictEqual(result.backups.length, 1);
    });
  });

  describe('deleteBackup', () => {
    it('should delete backup successfully', async () => {
      mockDb.setCurrentResults([
        { rows: [{ storage_path: 'backups/1/1.bak' }] },
        { rows: [] }, // Delete metadata
        { rows: [] }  // Update quota
      ]);

      const result = await service.deleteBackup(1, 1);

      assert.strictEqual(result.success, true);
    });

    it('should reject delete for non-owned backup', async () => {
      mockDb.setCurrentResults([
        { rows: [] } // No backup found
      ]);

      await assert.rejects(
        async () => await service.deleteBackup(1, 999),
        /Backup not found/
      );
    });
  });

  describe('setupAutoBackup', () => {
    it('should enable daily auto backup', async () => {
      mockDb.setCurrentResults([
        { rows: [] }, // Insert config
        { rows: [] }  // Update next_run
      ]);

      const result = await service.setupAutoBackup(1, 'daily');

      assert.strictEqual(result.enabled, true);
      assert.strictEqual(result.schedule, 'daily');
    });

    it('should enable weekly auto backup', async () => {
      mockDb.setCurrentResults([
        { rows: [] },
        { rows: [] }
      ]);

      const result = await service.setupAutoBackup(1, 'weekly');

      assert.strictEqual(result.enabled, true);
      assert.strictEqual(result.schedule, 'weekly');
    });
  });

  describe('exportUserData', () => {
    it('should export user data as JSON', async () => {
      mockDb.setCurrentResults([
        { rows: [{ id: 1 }] }, // Create metadata
        { rows: [{ instance_id: 1, species_id: 25 }] }, // Pokemon data
        { rows: [] }, // Insert content
        { rows: [] }, // Update metadata
        { rows: [] }, // Update quota
        { rows: [{ // Get backup with contents
          id: 1,
          pokemon_data: [{ instance_id: 1, species_id: 25 }]
        }]}
      ]);

      const result = await service.exportUserData(1, 'json');

      assert.ok(result);
      const parsed = JSON.parse(result);
      assert.ok(parsed.id);
      assert.ok(parsed.pokemon_data);
    });
  });
});

describe('LocalStorageAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new LocalStorageAdapter('./test-backups');
  });

  it('should store and load data', async () => {
    const testData = Buffer.from('test data');
    
    await adapter.store('test/path.bak', testData);
    const loaded = await adapter.load('test/path.bak');
    
    assert.deepStrictEqual(loaded, testData);
  });

  it('should delete data', async () => {
    const testData = Buffer.from('test data');
    
    await adapter.store('test/delete.bak', testData);
    await adapter.delete('test/delete.bak');
    
    // Should not throw
    await adapter.delete('test/delete.bak');
  });
});

describe('Constants', () => {
  it('should have correct backup types', () => {
    assert.strictEqual(BACKUP_TYPES.MANUAL, 'manual');
    assert.strictEqual(BACKUP_TYPES.AUTO_DAILY, 'auto_daily');
    assert.strictEqual(BACKUP_TYPES.AUTO_WEEKLY, 'auto_weekly');
    assert.strictEqual(BACKUP_TYPES.MIGRATION, 'migration');
  });

  it('should have correct backup statuses', () => {
    assert.strictEqual(BACKUP_STATUS.PENDING, 'pending');
    assert.strictEqual(BACKUP_STATUS.COMPLETED, 'completed');
    assert.strictEqual(BACKUP_STATUS.FAILED, 'failed');
    assert.strictEqual(BACKUP_STATUS.EXPIRED, 'expired');
  });

  it('should have correct restore modes', () => {
    assert.strictEqual(RESTORE_MODES.MERGE, 'merge');
    assert.strictEqual(RESTORE_MODES.REPLACE, 'replace');
    assert.strictEqual(RESTORE_MODES.APPEND, 'append');
  });
});
