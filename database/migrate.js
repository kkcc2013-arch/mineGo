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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { orderMigrations } = require('./migrationGraph');
// The database CLI shares the backend's declared dependency installation.
const { Pool } = require(require.resolve('pg', { paths: [path.join(__dirname, '../backend')] }));

// Configuration
const MIGRATIONS_DIR = path.resolve(process.env.MINEGO_MIGRATIONS_DIR || path.join(__dirname, 'pending'));
const LOCK_TIMEOUT_MS = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS || '30000');
if (!Number.isSafeInteger(LOCK_TIMEOUT_MS) || LOCK_TIMEOUT_MS <= 0) throw new Error('MIGRATION_LOCK_TIMEOUT_MS must be a positive integer');

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
  const directives = [];
  splitStatements(content, (direction, start, end) => directives.push({ direction, start, end }));
  if (!directives.length) return { up: content.trim(), down: '' };
  const up = directives.filter(section => section.direction === 'up');
  const down = directives.filter(section => section.direction === 'down');
  if (up.length > 1 || down.length > 1 || (up.length && down.length && down[0].start < up[0].start)) {
    throw new Error('Migration directives must contain at most one up followed by one down');
  }
  return {
    up: content.slice(up[0]?.end || 0, down[0]?.start ?? content.length).trim(),
    down: down.length ? content.slice(down[0].end).trim() : ''
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
      executed_by   VARCHAR(100),
      execution_order BIGSERIAL UNIQUE NOT NULL,
      dependency_checksum VARCHAR(64),
      execution_checksum VARCHAR(64)
    )
  `);
  const columns = await client.query("SELECT attname FROM pg_attribute WHERE attrelid='schema_migrations'::regclass AND attnum>0 AND NOT attisdropped");
  const names = new Set(columns.rows.map(row => row.attname));
  if (!names.has('execution_order')) {
    await client.query('ALTER TABLE schema_migrations ADD COLUMN execution_order BIGSERIAL NOT NULL');
    // Old runner always applied timestamp order. Preserve that historical order
    // when adopting its rows; new rows track actual dependency execution order.
    await client.query(`WITH ranked AS (SELECT version, row_number() OVER (ORDER BY executed_at, version) AS n FROM schema_migrations)
      UPDATE schema_migrations m SET execution_order=ranked.n FROM ranked WHERE m.version=ranked.version`);
    await client.query('CREATE UNIQUE INDEX schema_migrations_execution_order_key ON schema_migrations(execution_order)');
    await client.query("SELECT setval(pg_get_serial_sequence('schema_migrations','execution_order'), COALESCE((SELECT max(execution_order) FROM schema_migrations),1), EXISTS(SELECT 1 FROM schema_migrations))");
  }
  if (!names.has('dependency_checksum')) await client.query('ALTER TABLE schema_migrations ADD COLUMN dependency_checksum VARCHAR(64)');
  if (!names.has('execution_checksum')) await client.query('ALTER TABLE schema_migrations ADD COLUMN execution_checksum VARCHAR(64)');
}

/**
 * Acquire migration lock to prevent concurrent executions
 */
async function acquireLock(client) {
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${LOCK_TIMEOUT_MS}ms`]);
  // Transaction-held locks are released by COMMIT, ROLLBACK or connection loss.
  // Include the schema so isolated environments do not contend with each other.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_database() || ':' || current_schema() || ':minego:migrations', 0))");
}

async function withMigrationTransaction(operation) {
  const client = await getPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await acquireLock(client);
    await ensureMigrationsTable(client);
    const result = await operation(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Migration failed and rollback failed'); }
    }
    throw error;
  } finally { client.release(); }
}

/**
 * Get list of executed migrations from database
 */
async function getExecutedMigrations(client) {
  const result = await client.query(`
    SELECT version, description, checksum, executed_at, execution_ms, executed_by, execution_order, dependency_checksum, execution_checksum
    FROM schema_migrations
    ORDER BY execution_order
  `);
  return result.rows;
}

/**
 * Get list of pending migration files
 */
async function getPendingMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort();
  const versions = new Set();
  const migrations = files.map(filename => {
    const parsed = parseMigrationFilename(filename);
    if (!parsed) throw new Error(`Invalid migration filename: ${filename}`);
    if (versions.has(parsed.version)) throw new Error(`Duplicate migration version: ${parsed.version}`);
    versions.add(parsed.version);
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    return { ...parsed, filePath, content, checksum: calculateChecksum(content), ...parseMigrationFile(content) };
  });
  const manifestPath = path.join(MIGRATIONS_DIR, 'dependencies.json');
  const document = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : undefined;
  const repairPath = path.join(MIGRATIONS_DIR, 'repairs.json');
  const repairs = fs.existsSync(repairPath) ? JSON.parse(fs.readFileSync(repairPath, 'utf8')) : { schemaVersion: 1, repairs: {} };
  if (repairs.schemaVersion !== 1 || !repairs.repairs || typeof repairs.repairs !== 'object' || Array.isArray(repairs.repairs)) throw new Error('Invalid migration repair manifest');
  const byVersion = new Map(migrations.map(file => [file.version, file]));
  for (const [version, repair] of Object.entries(repairs.repairs)) {
    const source = byVersion.get(version);
    if (!source) throw new Error(`Repair references missing migration ${version}`);
    if (!repair || !/^[a-f0-9]{64}$/.test(repair.sourceSha256) || repair.sourceSha256 !== source.checksum || typeof repair.file !== 'string' || !repair.file.endsWith('.sql') || typeof repair.reason !== 'string' || !repair.reason.trim()) {
      throw new Error(`Invalid or mismatched repair source for migration ${version}`);
    }
    const target = fs.realpathSync(path.resolve(MIGRATIONS_DIR, repair.file));
    if (!target.startsWith(fs.realpathSync(MIGRATIONS_DIR) + path.sep)) throw new Error(`Repair path leaves migration directory for ${version}`);
    const content = fs.readFileSync(target, 'utf8');
    Object.assign(source, parseMigrationFile(content), { repairFile: repair.file, repairReason: repair.reason });
  }
  return orderMigrations(migrations, document).map(file => ({ ...file,
    dependencyChecksum: calculateChecksum(JSON.stringify(file.dependencies)),
    executionChecksum: calculateChecksum(JSON.stringify({ up: file.up, down: file.down })) }));
}

function compareChecksums(executed, files) {
  const byVersion = new Map(files.map(file => [file.version, file]));
  const errors = [];
  for (const migration of executed) {
    const file = byVersion.get(migration.version);
    if (!file) errors.push({ version: migration.version, message: 'Executed migration file is missing' });
    else if (file.checksum !== migration.checksum) errors.push({ version: migration.version, message: 'Executed migration checksum mismatch' });
    else if (migration.dependency_checksum && file.dependencyChecksum !== migration.dependency_checksum) errors.push({ version: migration.version, message: 'Executed migration dependency checksum mismatch' });
    else if (migration.execution_checksum && file.executionChecksum !== migration.execution_checksum) errors.push({ version: migration.version, message: 'Executed migration SQL checksum mismatch' });
  }
  return { valid: errors.length === 0, errors };
}

function requireValidChecksums(executed, files) {
  const result = compareChecksums(executed, files);
  if (!result.valid) throw new Error(result.errors.map(error => `${error.version}: ${error.message}`).join('; '));
}

async function verifyChecksums() {
  return withMigrationTransaction(async client => compareChecksums(await getExecutedMigrations(client), await getPendingMigrationFiles()));
}

const { splitStatements, migrationStatements } = require('./sqlStatements');

/**
 * Run a single migration
 */
async function runMigration(client, migration, direction = 'up') {
  const sql = direction === 'up' ? migration.up : migration.down;
  
  if (!sql) {
    throw new Error(`No ${direction} migration found for ${migration.version}`);
  }
  
  const start = Date.now();
  
  // Execute migration SQL statements sequentially
  const statements = migrationStatements(sql);
  for (const [index, statement] of statements.entries()) {
    if (statement.trim()) {
      try { await client.query(statement); }
      catch (error) {
        error.message = `Migration ${migration.version} statement ${index + 1}: ${error.message}${error.position ? ` (position ${error.position})` : ''}`;
        throw error;
      }
    }
  }
  
  const executionMs = Date.now() - start;
  
  if (direction === 'up') {
    // Record in schema_migrations
    await client.query(`
      INSERT INTO schema_migrations (version, description, checksum, execution_ms, executed_by, dependency_checksum, execution_checksum)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      migration.version,
      migration.description,
      migration.checksum,
      executionMs,
      process.env.HOSTNAME || require('os').hostname(),
      migration.dependencyChecksum,
      migration.executionChecksum,
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
  return withMigrationTransaction(async client => {
    const executed = await getExecutedMigrations(client);
    const files = await getPendingMigrationFiles();
    requireValidChecksums(executed, files);
    const versions = new Set(executed.map(migration => migration.version));
    const pending = files.filter(file => !versions.has(file.version));
    console.log(`Found ${pending.length} pending migration(s) to run.`);
    const results = [];
    for (const file of pending) {
      console.log(`Running migration: ${file.version} - ${file.description}`);
      if (file.repairFile) console.log(`  Using checksummed repair ${file.repairFile}: ${file.repairReason}`);
      const executionMs = await runMigration(client, file, 'up');
      results.push({ version: file.version, executionMs });
    }
    return { ran: results.length, migrations: results };
  });
}

/**
 * Roll back the last migration, or all migrations newer than a retained target.
 */
async function rollbackTo(targetVersion) {
  return withMigrationTransaction(async client => {
    const executed = await getExecutedMigrations(client);
    const files = await getPendingMigrationFiles();
    requireValidChecksums(executed, files);
    if (!executed.length) return { rolledBack: 0, migrations: [] };
    let migrations;
    if (targetVersion) {
      const index = executed.findIndex(migration => migration.version === targetVersion);
      if (index < 0) throw new Error(`Target version ${targetVersion} not found in executed migrations`);
      migrations = executed.slice(index + 1).reverse();
    } else migrations = [executed[executed.length - 1]];
    const byVersion = new Map(files.map(file => [file.version, file]));
    // Reject missing rollback code before changing any data.
    for (const migration of migrations) if (!byVersion.get(migration.version).down) throw new Error(`No down migration found for ${migration.version}`);
    const results = [];
    for (const migration of migrations) {
      console.log(`Rolling back: ${migration.version} - ${migration.description}`);
      const executionMs = await runMigration(client, byVersion.get(migration.version), 'down');
      results.push({ version: migration.version, executionMs });
    }
    return { rolledBack: results.length, migrations: results };
  });
}

/**
 * Get migration status
 */
async function status() {
  return withMigrationTransaction(async client => {
    
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
    
  });
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
  
  if (!slug) throw new Error('Description must contain letters or numbers');
  fs.writeFileSync(filePath, content, { flag: 'wx' });
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
          throw new Error('Migration checksum verification failed');
        }
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Usage: node migrate.js [up|down|status|create|verify]');
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally { await closePool(); }
}

async function closePool() {
  const current = pool; pool = null;
  if (current) await current.end();
}

// Export for programmatic use
module.exports = {
  closePool, parseMigrationFile, parseMigrationFilename, calculateChecksum, splitStatements,
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
