#!/usr/bin/env node
/**
 * Database Migration Tool for mineGo
 * 
 * Usage:
 *   node migrate.js up              - Run all pending migrations
 *   node migrate.js down [version]  - Rollback to version (or last migration)
 *   node migrate.js status          - Show migration status
 *   node migrate.js create <desc>   - Create new migration file
 *   node migrate.js verify          - Verify checksums of executed migrations
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const MIGRATIONS_DIR = path.join(__dirname, 'pending');
const LOCK_TIMEOUT_MS = parseInt(process.env.MIGRATION_LOCK_TIMEOUT_MS || '30000', 10);
const AUTO_MIGRATE = process.env.AUTO_MIGRATE === 'true';

// Database connection
let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1, // Single connection for migrations
    });
  }
  return pool;
}

/**
 * Calculate SHA256 checksum of file content
 */
function calculateChecksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Parse migration file to extract up and down sections
 */
function parseMigrationFile(content) {
  const upMatch = content.match(/--\s*migrate:up\s*\n([\s\S]*?)(?=--\s*migrate:down|$)/);
  const downMatch = content.match(/--\s*migrate:down\s*\n([\s\S]*?)$/);
  
  return {
    up: upMatch ? upMatch[1].trim() : '',
    down: downMatch ? downMatch[1].trim() : '',
  };
}

/**
 * Parse migration filename to extract version and description
 */
function parseMigrationFilename(filename) {
  const match = filename.match(/^(\d{8}_\d{6})__(.+)\.sql$/);
  if (!match) {
    return null;
  }
  return {
    version: match[1],
    description: match[2].replace(/_/g, ' '),
    filename,
  };
}

/**
 * Ensure schema_migrations table exists
 */
async function ensureMigrationsTable(client) {
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
}

/**
 * Acquire migration lock to prevent concurrent executions
 */
async function acquireLock(client) {
  // Create lock table if not exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS migration_lock (
      id            INTEGER PRIMARY KEY DEFAULT 1,
      locked_at     TIMESTAMP NOT NULL,
      locked_by     VARCHAR(100) NOT NULL,
      CONSTRAINT    single_row CHECK (id = 1)
    )
  `);
  
  const lockId = process.env.HOSTNAME || require('os').hostname();
  
  // Try to acquire lock
  const result = await client.query(`
    INSERT INTO migration_lock (id, locked_at, locked_by)
    VALUES (1, NOW(), $1)
    ON CONFLICT (id) DO UPDATE
    SET locked_at = NOW(), locked_by = $1
    WHERE migration_lock.locked_at < NOW() - INTERVAL '30 seconds'
    RETURNING locked_by
  `, [lockId]);
  
  if (result.rows.length === 0) {
    throw new Error('Migration is already running. Wait for it to complete or check for stale locks.');
  }
  
  return lockId;
}

/**
 * Release migration lock
 */
async function releaseLock(client) {
  await client.query('DELETE FROM migration_lock WHERE id = 1');
}

/**
 * Get list of executed migrations from database
 */
async function getExecutedMigrations(client) {
  const result = await client.query(`
    SELECT version, description, checksum, executed_at, execution_ms, executed_by
    FROM schema_migrations
    ORDER BY version
  `);
  return result.rows;
}

/**
 * Get list of pending migration files
 */
async function getPendingMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    return [];
  }
  
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  return files.map(f => {
    const parsed = parseMigrationFilename(f);
    if (!parsed) {
      console.warn(`Warning: Invalid migration filename format: ${f}`);
      return null;
    }
    const filePath = path.join(MIGRATIONS_DIR, f);
    const content = fs.readFileSync(filePath, 'utf8');
    return {
      ...parsed,
      filePath,
      content,
      checksum: calculateChecksum(content),
      ...parseMigrationFile(content),
    };
  }).filter(Boolean);
}

/**
 * Verify checksums of already executed migrations
 */
async function verifyChecksums() {
  const client = await getPool().connect();
  try {
    await ensureMigrationsTable(client);
    const executed = await getExecutedMigrations(client);
    const pending = await getPendingMigrationFiles();
    
    const errors = [];
    
    for (const migration of executed) {
      const file = pending.find(p => p.version === migration.version);
      if (!file) {
        // Migration was executed but file is missing - this is OK (might be archived)
        continue;
      }
      
      if (file.checksum !== migration.checksum) {
        errors.push({
          version: migration.version,
          message: `Checksum mismatch! DB: ${migration.checksum}, File: ${file.checksum}`,
        });
      }
    }
    
    return { valid: errors.length === 0, errors };
  } finally {
    client.release();
  }
}

/**
 * Run a single migration
 */
async function runMigration(client, migration, direction = 'up') {
  const sql = direction === 'up' ? migration.up : migration.down;
  
  if (!sql) {
    throw new Error(`No ${direction} migration found for ${migration.version}`);
  }
  
  const start = Date.now();
  
  // Execute migration SQL
  await client.query(sql);
  
  const executionMs = Date.now() - start;
  
  if (direction === 'up') {
    // Record in schema_migrations
    await client.query(`
      INSERT INTO schema_migrations (version, description, checksum, execution_ms, executed_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      migration.version,
      migration.description,
      migration.checksum,
      executionMs,
      process.env.HOSTNAME || require('os').hostname(),
    ]);
  } else {
    // Remove from schema_migrations
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
  }
  
  return executionMs;
}

/**
 * Run all pending migrations
 */
async function runPendingMigrations() {
  const client = await getPool().connect();
  
  try {
    await client.query('BEGIN');
    
    // Ensure migrations table exists
    await ensureMigrationsTable(client);
    
    // Acquire lock
    const lockId = await acquireLock(client);
    console.log(`Migration lock acquired by: ${lockId}`);
    
    try {
      // Get executed and pending migrations
      const executed = await getExecutedMigrations(client);
      const pending = await getPendingMigrationFiles();
      
      // Filter out already executed
      const toRun = pending.filter(p => !executed.find(e => e.version === p.version));
      
      if (toRun.length === 0) {
        console.log('No pending migrations to run.');
        return { ran: 0, migrations: [] };
      }
      
      console.log(`Found ${toRun.length} pending migration(s) to run.`);
      
      const results = [];
      
      for (const migration of toRun) {
        console.log(`Running migration: ${migration.version} - ${migration.description}`);
        const executionMs = await runMigration(client, migration, 'up');
        console.log(`  ✓ Completed in ${executionMs}ms`);
        results.push({ version: migration.version, executionMs });
      }
      
      await client.query('COMMIT');
      console.log(`Successfully ran ${toRun.length} migration(s).`);
      
      return { ran: toRun.length, migrations: results };
      
    } finally {
      await releaseLock(client);
      console.log('Migration lock released.');
    }
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Rollback migrations
 */
async function rollbackTo(targetVersion) {
  const client = await getPool().connect();
  
  try {
    await client.query('BEGIN');
    
    await ensureMigrationsTable(client);
    
    const lockId = await acquireLock(client);
    console.log(`Migration lock acquired by: ${lockId}`);
    
    try {
      const executed = await getExecutedMigrations(client);
      const pending = await getPendingMigrationFiles();
      
      if (executed.length === 0) {
        console.log('No migrations to rollback.');
        return { rolledBack: 0, migrations: [] };
      }
      
      // Determine which migrations to rollback
      let toRollback;
      if (targetVersion) {
        const idx = executed.findIndex(e => e.version === targetVersion);
        if (idx === -1) {
          throw new Error(`Target version ${targetVersion} not found in executed migrations`);
        }
        toRollback = executed.slice(idx + 1).reverse();
      } else {
        // Rollback last migration
        toRollback = [executed[executed.length - 1]];
      }
      
      console.log(`Rolling back ${toRollback.length} migration(s).`);
      
      const results = [];
      
      for (const migration of toRollback) {
        const file = pending.find(p => p.version === migration.version);
        if (!file) {
          throw new Error(`Migration file not found for version ${migration.version}`);
        }
        
        console.log(`Rolling back: ${migration.version} - ${migration.description}`);
        const executionMs = await runMigration(client, file, 'down');
        console.log(`  ✓ Rolled back in ${executionMs}ms`);
        results.push({ version: migration.version, executionMs });
      }
      
      await client.query('COMMIT');
      console.log(`Successfully rolled back ${toRollback.length} migration(s).`);
      
      return { rolledBack: toRollback.length, migrations: results };
      
    } finally {
      await releaseLock(client);
      console.log('Migration lock released.');
    }
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get migration status
 */
async function status() {
  const client = await getPool().connect();
  try {
    await ensureMigrationsTable(client);
    
    const executed = await getExecutedMigrations(client);
    const pending = await getPendingMigrationFiles();
    
    console.log('\n=== Migration Status ===\n');
    
    console.log('Executed Migrations:');
    if (executed.length === 0) {
      console.log('  (none)');
    } else {
      for (const m of executed) {
        console.log(`  ✓ ${m.version} - ${m.description}`);
        console.log(`    Executed: ${m.executed_at.toISOString()} (${m.execution_ms}ms)`);
        console.log(`    Checksum: ${m.checksum.substring(0, 16)}...`);
      }
    }
    
    console.log('\nPending Migrations:');
    const pendingNotExecuted = pending.filter(p => !executed.find(e => e.version === p.version));
    if (pendingNotExecuted.length === 0) {
      console.log('  (none)');
    } else {
      for (const m of pendingNotExecuted) {
        console.log(`  ○ ${m.version} - ${m.description}`);
      }
    }
    
    console.log(`\nTotal: ${executed.length} executed, ${pendingNotExecuted.length} pending\n`);
    
    return { executed: executed.length, pending: pendingNotExecuted.length };
    
  } finally {
    client.release();
  }
}

/**
 * Create a new migration file
 */
function createMigration(description) {
  if (!description) {
    throw new Error('Description is required');
  }
  
  // Ensure pending directory exists
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
  }
  
  // Generate timestamp
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .substring(0, 15);
  
  // Format description
  const slug = description.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  
  const filename = `${timestamp}__${slug}.sql`;
  const filePath = path.join(MIGRATIONS_DIR, filename);
  
  // Template content
  const content = `-- migrate:up
-- TODO: Add your migration SQL here

-- migrate:down
-- TODO: Add your rollback SQL here
`;
  
  fs.writeFileSync(filePath, content);
  console.log(`Created migration file: ${filePath}`);
  
  return { filename, filePath };
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  
  try {
    switch (command) {
      case 'up':
        await runPendingMigrations();
        break;
        
      case 'down':
        const targetVersion = args[1];
        await rollbackTo(targetVersion);
        break;
        
      case 'status':
        await status();
        break;
        
      case 'create':
        const description = args.slice(1).join(' ');
        createMigration(description);
        break;
        
      case 'verify':
        const result = await verifyChecksums();
        if (result.valid) {
          console.log('✓ All migration checksums are valid.');
        } else {
          console.error('✗ Checksum verification failed:');
          for (const err of result.errors) {
            console.error(`  ${err.version}: ${err.message}`);
          }
          process.exit(1);
        }
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: node migrate.js [up|down|status|create|verify]');
        process.exit(1);
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

// Export for programmatic use
module.exports = {
  runPendingMigrations,
  rollbackTo,
  status,
  createMigration,
  verifyChecksums,
  getExecutedMigrations,
  getPendingMigrationFiles,
};

// Run CLI if executed directly
if (require.main === module) {
  main();
}
