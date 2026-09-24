#!/usr/bin/env node
/**
 * Database Migration Tool for mineGo
 * 
 * Usage:
 *   node migrate.js up              - Run all pending migrations
 *   node migrate.js up --from 20260924_000000 - Run only pending migrations with version >= given
 *   node migrate.js baseline --until 20260924   - 已有库：把该日期之前的迁移记为已执行（不运行）
 *   node migrate.js baseline --all              - 同上，全部迁移（含无日期前缀的历史文件）
 *   node migrate.js baseline <version> [...]    - 只标记指定版本（up 报"已存在"且确认对象已在库中时使用）
 *   node migrate.js down [version]  - Rollback to version (or last migration)
 *   node migrate.js status          - Show migration status
 *   node migrate.js create <desc>   - Create new migration file
 *   node migrate.js verify          - Verify checksums of executed migrations
 */

// pg 安装在 backend/node_modules（database/ 目录下没有 node_modules，原实现从任何位置运行都会 MODULE_NOT_FOUND）
let Pool;
try { ({ Pool } = require('pg')); }
catch { ({ Pool } = require(require('path').join(__dirname, '..', 'backend', 'node_modules', 'pg'))); }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
// 新迁移写入 pending/；历史迁移分散在 pending/ 与 migrations/ 两个目录，两处都读取
const MIGRATIONS_DIR = path.join(__dirname, 'pending');
const LEGACY_DIR = path.join(__dirname, 'migrations');
// V1 基线由初始化脚本（docker-entrypoint / bootstrap-dev）建立，不作为增量迁移执行
const BASELINE_FILES = new Set(['V1__initial_schema.sql']);
const MAX_PASSES = parseInt(process.env.MIGRATION_MAX_PASSES || '6', 10);
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
  const hasUpTag = /--\s*migrate:up/.test(content);
  const hasDownTag = /--\s*migrate:down/.test(content);
  
  if (!hasUpTag && !hasDownTag) {
    return {
      up: content.trim(),
      down: '',
    };
  }
  
  let up = '';
  let down = '';
  
  if (hasUpTag) {
    const upMatch = content.match(/--\s*migrate:up\s*\n([\s\S]*?)(?=--\s*migrate:down|$)/);
    up = upMatch ? upMatch[1].trim() : '';
  } else {
    const beforeDownMatch = content.match(/^([\s\S]*?)(?=--\s*migrate:down)/);
    up = beforeDownMatch ? beforeDownMatch[1].trim() : '';
  }
  
  if (hasDownTag) {
    const downMatch = content.match(/--\s*migrate:down\s*\n([\s\S]*?)$/);
    down = downMatch ? downMatch[1].trim() : '';
  }
  
  return { up, down };
}

/**
 * Parse migration filename to extract version and description
 */
function parseMigrationFilename(filename, dir = MIGRATIONS_DIR) {
  const stem = filename.replace(/\.(sql|js)$/, '');
  const match = filename.match(/^(\d{8}_\d{6})__(.+)\.sql$/);
  // 执行顺序与 bootstrap-dev 一致：先 pending/ 再 migrations/，目录内按文件名（migrations/ 里有
  // 00521-、015_ 这类非日期前缀，按日期交错排序反而会先于其依赖执行）
  const sortKey = `${dir === MIGRATIONS_DIR ? 0 : 1}|${filename}`;
  // --from 按文件名开头的日期数字过滤
  const digits = (stem.match(/^\d[\d_]*/) || [''])[0].replace(/_/g, '');
  const dateKey = digits.length >= 8 ? digits.padEnd(14, '0').slice(0, 14) : '';
  if (match && dir === MIGRATIONS_DIR) {
    return { version: match[1], description: match[2].replace(/_/g, ' '), filename, sortKey, dateKey };
  }
  const prefix = dir === MIGRATIONS_DIR ? 'pending' : 'migrations';
  return {
    version: `${prefix}/${stem}`.slice(0, 200),
    description: stem.replace(/^[\d_-]+/, '').replace(/[_-]+/g, ' ').trim() || stem,
    filename,
    sortKey,
    dateKey,
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
  // 历史目录的迁移以"目录/文件名"作版本号，超过原来的 20 字符
  await client.query(`ALTER TABLE schema_migrations ALTER COLUMN version TYPE VARCHAR(200)`);
  await client.query(`ALTER TABLE schema_migrations ALTER COLUMN description TYPE VARCHAR(500)`);
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
  }
  const list = [];
  for (const dir of [MIGRATIONS_DIR, LEGACY_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!(f.endsWith('.sql') || f.endsWith('.js')) || BASELINE_FILES.has(f)) continue;
      const parsed = parseMigrationFilename(f, dir);
      const filePath = path.join(dir, f);
      const content = fs.readFileSync(filePath, 'utf8');
      list.push({
        ...parsed,
        filePath,
        content,
        isJs: f.endsWith('.js'),
        checksum: calculateChecksum(content),
        ...(f.endsWith('.js') ? { up: true, down: true } : parseMigrationFile(content)),
      });
    }
  }
  return list.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
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

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let inDoubleQuote = false;
  let dollarTag = null;
  
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const nextChar = i < sql.length - 1 ? sql[i + 1] : '';
    const prev = i > 0 ? sql[i - 1] : '';
    
    // Check for single line comment: --
    if (char === '-' && nextChar === '-' && !inString && !inDoubleQuote && !dollarTag) {
      while (i < sql.length && sql[i] !== '\n') {
        current += sql[i];
        i++;
      }
      if (i < sql.length) {
        current += sql[i];
      }
      continue;
    }
    
    // Check for multi line comment: /*
    if (char === '/' && nextChar === '*' && !inString && !inDoubleQuote && !dollarTag) {
      current += '/*';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i+1] === '/')) {
        current += sql[i];
        i++;
      }
      if (i < sql.length) {
        current += '*/';
        i++;
      }
      continue;
    }
    
    if (char === "'" && prev !== '\\' && !inDoubleQuote && !dollarTag) {
      inString = !inString;
    } else if (char === '"' && prev !== '\\' && !inString && !dollarTag) {
      inDoubleQuote = !inDoubleQuote;
    } else if (char === '$' && !inString && !inDoubleQuote) {
      if (dollarTag) {
        const potentialEnd = sql.substring(i, i + dollarTag.length);
        if (potentialEnd === dollarTag) {
          i += dollarTag.length - 1;
          dollarTag = null;
          current += potentialEnd;
          continue;
        }
      } else {
        const match = sql.substring(i).match(/^\$[a-zA-Z0-9_]*\$/);
        if (match) {
          dollarTag = match[0];
          i += dollarTag.length - 1;
          current += dollarTag;
          continue;
        }
      }
    }
    
    if (char === ';' && !inString && !inDoubleQuote && !dollarTag) {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  
  if (current.trim()) {
    statements.push(current.trim());
  }
  
  return statements;
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
  
  if (migration.isJs) {
    // JS 迁移：导出 up(client) / down(client)
    const mod = require(migration.filePath);
    const fn = mod[direction] || (mod.default && mod.default[direction]);
    if (typeof fn !== 'function') throw new Error(`${migration.filename} 没有导出 ${direction}(client)`);
    await fn(client, client);
  } else {
    // Execute migration SQL statements sequentially
    const statements = splitStatements(sql);
    for (const statement of statements) {
      if (statement.trim()) {
        await client.query(statement);
      }
    }
  }
  
  const executionMs = Date.now() - start;
  
  if (direction === 'up') {
    // Record in schema_migrations
    await client.query(`
      INSERT INTO schema_migrations (version, description, checksum, execution_ms, executed_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      migration.version,
      String(migration.description).slice(0, 500),
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
async function runPendingMigrations({ fromVersion = null } = {}) {
  const client = await getPool().connect();
  const LOCK_KEY = 727001; // pg_advisory_lock 键（全库唯一即可）
  let locked = false;
  try {
    await ensureMigrationsTable(client);
    const got = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0].ok) {
      throw new Error('Migration is already running (advisory lock held). Wait for it to complete.');
    }
    locked = true;

    const executed = new Set((await getExecutedMigrations(client)).map((e) => e.version));
    // --from：只运行排序键（文件名日期）>= fromVersion 的迁移
    const fromKey = fromVersion ? fromVersion.replace(/_/g, '').padEnd(14, '0').slice(0, 14) : null;
    let toRun = (await getPendingMigrationFiles())
      .filter((m) => !executed.has(m.version))
      .filter((m) => !fromKey || m.dateKey >= fromKey);

    if (toRun.length === 0) {
      console.log('No pending migrations to run.');
      return { ran: 0, migrations: [], failed: [] };
    }
    console.log(`Found ${toRun.length} pending migration(s) to run.`);

    // 每个迁移独立事务：成功的立即提交并记录；失败的回滚后在下一轮重试
    // （历史迁移之间存在未声明的依赖，按文件名顺序一次跑不完，多轮收敛与 bootstrap-dev 一致）
    const results = [];
    let failures = new Map();
    for (let pass = 1; pass <= MAX_PASSES && toRun.length; pass++) {
      const next = [];
      failures = new Map();
      for (const migration of toRun) {
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL lock_timeout = '10s'");
          const executionMs = await runMigration(client, migration, 'up');
          await client.query('COMMIT');
          console.log(`  ✓ ${migration.version} (${executionMs}ms)`);
          results.push({ version: migration.version, executionMs });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          next.push(migration);
          failures.set(migration.version, err.message.split('\n')[0]);
        }
      }
      console.log(`pass ${pass}: applied ${toRun.length - next.length}, remaining ${next.length}`);
      if (next.length === toRun.length) break;
      toRun = next;
    }

    const failed = [...failures].map(([version, error]) => ({ version, error }));
    console.log(`Successfully ran ${results.length} migration(s).`);
    if (failed.length) {
      for (const f of failed) console.error(`  ✗ ${f.version}: ${f.error}`);
      const err = new Error(`${failed.length} migration(s) failed (see above); successful ones were committed.`);
      err.failed = failed;
      err.ran = results;
      throw err;
    }
    return { ran: results.length, migrations: results, failed };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
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
 * 把迁移标记为已执行而不实际运行（用于已有库：对象早已存在但 schema_migrations 没有记录）
 * --until <YYYYMMDD[_HHMMSS]>：只标记文件名日期早于该值的迁移（不含无日期前缀的文件时需显式 --all）
 */
async function baseline({ until = null, all = false, versions = [] } = {}) {
  const client = await getPool().connect();
  try {
    await ensureMigrationsTable(client);
    const executed = new Set((await getExecutedMigrations(client)).map((e) => e.version));
    const untilKey = until ? until.replace(/_/g, '').padEnd(14, '0').slice(0, 14) : null;
    const files = (await getPendingMigrationFiles()).filter((m) => !executed.has(m.version)).filter((m) => {
      if (all) return true;
      if (versions.length) return versions.includes(m.version);
      if (!untilKey) return false;
      return m.dateKey && m.dateKey < untilKey;
    });
    for (const m of files) {
      await client.query(
        `INSERT INTO schema_migrations (version, description, checksum, execution_ms, executed_by)
         VALUES ($1, $2, $3, 0, $4) ON CONFLICT (version) DO NOTHING`,
        [m.version, `[baseline] ${String(m.description).slice(0, 480)}`, m.checksum, 'baseline'],
      );
      console.log(`  ⊙ ${m.version}`);
    }
    console.log(`Baselined ${files.length} migration(s).`);
    return { baselined: files.length };
  } finally {
    client.release();
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  
  try {
    switch (command) {
      case 'up': {
        const fromIdx = args.indexOf('--from');
        await runPendingMigrations({ fromVersion: fromIdx > 0 ? args[fromIdx + 1] : null });
        break;
      }
        
      case 'down':
        const targetVersion = args[1];
        await rollbackTo(targetVersion);
        break;
        
      case 'status':
        await status();
        break;

      case 'baseline': {
        const untilIdx = args.indexOf('--until');
        const versions = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--until');
        await baseline({ until: untilIdx > 0 ? args[untilIdx + 1] : null, all: args.includes('--all'), versions });
        break;
      }
        
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
    // 原实现缺少 catch，成功执行后也会因引用未定义的 err 而崩溃
    console.error('Migration failed:', err);
    process.exitCode = 1;
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
  baseline,
  getExecutedMigrations,
  getPendingMigrationFiles,
};

// Run CLI if executed directly
if (require.main === module) {
  // 个别 JS 迁移会 require 共享模块（连接池/定时器），完成后显式退出，避免进程挂起阻塞部署脚本
  main().then(() => process.exit(process.exitCode || 0));
}
