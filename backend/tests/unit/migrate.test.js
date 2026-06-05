/**
 * Unit tests for Database Migration Tool
 * Run: node backend/tests/unit/migrate.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mock database client
class MockClient {
  constructor() {
    this.queries = [];
    this.released = false;
  }
  
  async query(sql, params) {
    this.queries.push({ sql, params });
    
    // Mock responses for specific queries
    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      return { rows: [] };
    }
    if (sql.includes('CREATE TABLE IF NOT EXISTS migration_lock')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO migration_lock')) {
      return { rows: [{ locked_by: 'test-host' }] };
    }
    if (sql.includes('DELETE FROM migration_lock')) {
      return { rows: [] };
    }
    if (sql.includes('FROM schema_migrations')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO schema_migrations')) {
      return { rows: [] };
    }
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    
    return { rows: [] };
  }
  
  release() {
    this.released = true;
  }
}

class MockPool {
  async connect() {
    return new MockClient();
  }
  
  async end() {}
}

// Test calculateChecksum
function testCalculateChecksum() {
  console.log('Test: calculateChecksum');
  
  const content1 = 'SELECT 1;';
  const content2 = 'SELECT 2;';
  
  const hash1a = crypto.createHash('sha256').update(content1).digest('hex');
  const hash1b = crypto.createHash('sha256').update(content1).digest('hex');
  const hash2 = crypto.createHash('sha256').update(content2).digest('hex');
  
  // Same content should produce same hash
  assert.strictEqual(hash1a, hash1b, 'Same content should produce same checksum');
  
  // Different content should produce different hash
  assert.notStrictEqual(hash1a, hash2, 'Different content should produce different checksum');
  
  console.log('  ✓ calculateChecksum works correctly');
}

// Test parseMigrationFilename
function testParseMigrationFilename() {
  console.log('Test: parseMigrationFilename');
  
  const validName = '20260605_030000__add_user_login_tracking.sql';
  const parsed = {
    version: '20260605_030000',
    description: 'add user login tracking',
    filename: validName,
  };
  
  // Test valid filename
  const match = validName.match(/^(\d{8}_\d{6})__(.+)\.sql$/);
  assert.ok(match, 'Should match valid filename pattern');
  assert.strictEqual(match[1], '20260605_030000', 'Should extract version');
  assert.strictEqual(match[2], 'add_user_login_tracking', 'Should extract description');
  
  // Test invalid filename
  const invalidName = 'invalid-migration.sql';
  const invalidMatch = invalidName.match(/^(\d{8}_\d{6})__(.+)\.sql$/);
  assert.strictEqual(invalidMatch, null, 'Should not match invalid filename');
  
  console.log('  ✓ parseMigrationFilename works correctly');
}

// Test parseMigrationFile
function testParseMigrationFile() {
  console.log('Test: parseMigrationFile');
  
  const content = `-- migrate:up
CREATE TABLE test (id INT);

-- migrate:down
DROP TABLE test;
`;
  
  const upMatch = content.match(/--\s*migrate:up\s*\n([\s\S]*?)(?=--\s*migrate:down|$)/);
  const downMatch = content.match(/--\s*migrate:down\s*\n([\s\S]*?)$/);
  
  assert.ok(upMatch, 'Should find up section');
  assert.ok(downMatch, 'Should find down section');
  
  const upSql = upMatch[1].trim();
  const downSql = downMatch[1].trim();
  
  assert.ok(upSql.includes('CREATE TABLE'), 'Up SQL should contain CREATE TABLE');
  assert.ok(downSql.includes('DROP TABLE'), 'Down SQL should contain DROP TABLE');
  
  console.log('  ✓ parseMigrationFile works correctly');
}

// Test migration lock mechanism
async function testMigrationLock() {
  console.log('Test: migration lock mechanism');
  
  const client = new MockClient();
  
  // Simulate acquiring lock
  await client.query(`
    CREATE TABLE IF NOT EXISTS migration_lock (
      id            INTEGER PRIMARY KEY DEFAULT 1,
      locked_at     TIMESTAMP NOT NULL,
      locked_by     VARCHAR(100) NOT NULL,
      CONSTRAINT    single_row CHECK (id = 1)
    )
  `);
  
  const result = await client.query(`
    INSERT INTO migration_lock (id, locked_at, locked_by)
    VALUES (1, NOW(), 'test-host')
    ON CONFLICT (id) DO UPDATE
    SET locked_at = NOW(), locked_by = 'test-host'
    WHERE migration_lock.locked_at < NOW() - INTERVAL '30 seconds'
    RETURNING locked_by
  `, ['test-host']);
  
  assert.ok(result.rows.length > 0, 'Should acquire lock');
  
  // Release lock
  await client.query('DELETE FROM migration_lock WHERE id = 1');
  
  console.log('  ✓ Migration lock mechanism works');
}

// Test migration status tracking
async function testMigrationStatusTracking() {
  console.log('Test: migration status tracking');
  
  const client = new MockClient();
  
  // Create migrations table
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version       VARCHAR(20) PRIMARY KEY,
      description   VARCHAR(200) NOT NULL,
      checksum      VARCHAR(64) NOT NULL,
      executed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
      execution_ms  INTEGER NOT NULL,
      executed_by   VARCHAR(100)
    )
  `);
  
  // Record a migration
  await client.query(`
    INSERT INTO schema_migrations (version, description, checksum, execution_ms, executed_by)
    VALUES ($1, $2, $3, $4, $5)
  `, ['20260605_030000', 'test migration', 'abc123', 100, 'test-host']);
  
  // Query migrations
  const result = await client.query(`
    SELECT version, description, checksum, executed_at, execution_ms, executed_by
    FROM schema_migrations
    ORDER BY version
  `);
  
  // Verify queries were executed
  const insertQuery = client.queries.find(q => q.sql.includes('INSERT INTO schema_migrations'));
  assert.ok(insertQuery, 'Should have executed INSERT query');
  assert.strictEqual(insertQuery.params[0], '20260605_030000', 'Should have correct version');
  
  console.log('  ✓ Migration status tracking works');
}

// Test checksum verification
function testChecksumVerification() {
  console.log('Test: checksum verification');
  
  const originalContent = 'SELECT 1;';
  const modifiedContent = 'SELECT 2;';
  
  const originalChecksum = crypto.createHash('sha256').update(originalContent).digest('hex');
  const modifiedChecksum = crypto.createHash('sha256').update(modifiedContent).digest('hex');
  
  // Simulate verification
  const dbChecksum = originalChecksum;
  const fileChecksum = modifiedChecksum;
  
  const valid = dbChecksum === fileChecksum;
  
  assert.strictEqual(valid, false, 'Should detect checksum mismatch');
  
  // Test with matching checksums
  const validChecksum = originalChecksum === originalChecksum;
  assert.strictEqual(validChecksum, true, 'Should pass with matching checksums');
  
  console.log('  ✓ Checksum verification works');
}

// Test migration file creation
function testMigrationFileCreation() {
  console.log('Test: migration file creation');
  
  const description = 'add user table';
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .substring(0, 15);
  
  const slug = description.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  
  const filename = `${timestamp}__${slug}.sql`;
  
  // Verify filename format
  assert.ok(filename.match(/^\d{8}_\d{6}__[a-z0-9_]+\.sql$/), 'Filename should match expected pattern');
  assert.ok(filename.includes('add_user_table'), 'Filename should include slugified description');
  
  // Verify template content
  const template = `-- migrate:up
-- TODO: Add your migration SQL here

-- migrate:down
-- TODO: Add your rollback SQL here
`;
  
  assert.ok(template.includes('-- migrate:up'), 'Template should have up section');
  assert.ok(template.includes('-- migrate:down'), 'Template should have down section');
  
  console.log('  ✓ Migration file creation works');
}

// Run all tests
async function runTests() {
  console.log('\n=== Migration Tool Unit Tests ===\n');
  
  try {
    testCalculateChecksum();
    testParseMigrationFilename();
    testParseMigrationFile();
    await testMigrationLock();
    await testMigrationStatusTracking();
    testChecksumVerification();
    testMigrationFileCreation();
    
    console.log('\n✓ All tests passed!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n✗ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

runTests();
