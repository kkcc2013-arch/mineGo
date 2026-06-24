# REQ-00306：数据库迁移回滚自动化与版本控制系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00306 |
| 标题 | 数据库迁移回滚自动化与版本控制系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database/migrations、所有微服务、backend/shared、infrastructure/k8s、.github/workflows |
| 创建时间 | 2026-06-24 01:00 |

## 需求描述

### 背景
当前数据库迁移管理存在以下问题：
1. **回滚困难**：生产环境迁移失败后，手动回滚耗时且容易出错
2. **版本追踪混乱**：迁移文件缺乏统一的版本控制和依赖管理
3. **环境不一致**：开发、测试、生产环境的数据库 schema 可能不同步
4. **无回滚验证**：回滚脚本未经测试，关键时刻可能失败
5. **迁移审计缺失**：缺乏完整的迁移历史和变更追踪

### 目标
建立一套完整的数据库迁移版本控制和自动化回滚系统，确保：
- 所有迁移操作可追溯、可回滚
- 多环境 schema 保持一致
- 迁移前自动备份，失败自动回滚
- 迁移过程可视化，支持审批流程

## 技术方案

### 1. 迁移版本控制系统

#### 1.1 迁移文件命名规范
```
migrations/
├── 20260624010000_create_pokemon_table.up.sql
├── 20260624010000_create_pokemon_table.down.sql
├── 20260624020000_add_pokemon_level_index.up.sql
└── 20260624020000_add_pokemon_level_index.down.sql
```

#### 1.2 迁移元数据表设计
```sql
-- migrations/schema_migrations
CREATE TABLE schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  checksum VARCHAR(64) NOT NULL,
  rollback_checksum VARCHAR(64),
  execution_time_ms INTEGER,
  applied_by VARCHAR(255),
  status VARCHAR(20) DEFAULT 'applied', -- applied, rolled_back, pending
  previous_version VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE migration_dependencies (
  id SERIAL PRIMARY KEY,
  migration_version VARCHAR(255) NOT NULL,
  depends_on_version VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (migration_version) REFERENCES schema_migrations(version),
  FOREIGN KEY (depends_on_version) REFERENCES schema_migrations(version)
);

CREATE TABLE migration_audit_log (
  id SERIAL PRIMARY KEY,
  version VARCHAR(255) NOT NULL,
  action VARCHAR(20) NOT NULL, -- apply, rollback, dry-run
  status VARCHAR(20) NOT NULL, -- success, failed, skipped
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  execution_time_ms INTEGER,
  triggered_by VARCHAR(255),
  environment VARCHAR(50),
  backup_id VARCHAR(255)
);
```

#### 1.3 迁移管理器实现
```javascript
// backend/shared/migrationManager.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

class MigrationManager {
  constructor(config) {
    this.pool = new Pool(config.database);
    this.migrationsPath = config.migrationsPath || './migrations';
    this.backupManager = config.backupManager;
  }

  async init() {
    await this.createMigrationTables();
  }

  async createMigrationTables() {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          checksum VARCHAR(64) NOT NULL,
          rollback_checksum VARCHAR(64),
          execution_time_ms INTEGER,
          applied_by VARCHAR(255),
          status VARCHAR(20) DEFAULT 'applied',
          previous_version VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } finally {
      client.release();
    }
  }

  async getAppliedMigrations() {
    const result = await this.pool.query(`
      SELECT * FROM schema_migrations 
      WHERE status = 'applied' 
      ORDER BY applied_at DESC
    `);
    return result.rows;
  }

  async getPendingMigrations() {
    const files = await this.getMigrationFiles();
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map(m => m.version));
    
    const pending = [];
    for (const file of files) {
      const version = this.extractVersion(file);
      if (!appliedVersions.has(version)) {
        pending.push({
          version,
          filename: file,
          checksum: await this.calculateChecksum(file)
        });
      }
    }
    
    return pending.sort((a, b) => a.version.localeCompare(b.version));
  }

  async calculateChecksum(filepath) {
    const content = await fs.readFile(filepath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  async applyMigration(migrationFile, options = {}) {
    const client = await this.pool.connect();
    const startTime = Date.now();
    
    try {
      await client.query('BEGIN');
      
      // 备份当前状态
      const backupId = options.skipBackup ? null : 
        await this.backupManager?.createPreMigrationBackup(migrationFile);
      
      const version = this.extractVersion(migrationFile);
      const sql = await fs.readFile(migrationFile, 'utf8');
      const checksum = await this.calculateChecksum(migrationFile);
      
      // 执行迁移
      await client.query(sql);
      
      // 记录迁移
      const previousVersion = await this.getLatestAppliedVersion(client);
      await client.query(`
        INSERT INTO schema_migrations 
        (version, name, checksum, execution_time_ms, applied_by, status, previous_version)
        VALUES ($1, $2, $3, $4, $5, 'applied', $6)
      `, [
        version,
        path.basename(migrationFile),
        checksum,
        Date.now() - startTime,
        options.user || 'system',
        previousVersion
      ]);
      
      await client.query('COMMIT');
      
      await this.logAudit({
        version,
        action: 'apply',
        status: 'success',
        executionTime: Date.now() - startTime,
        backupId,
        triggeredBy: options.user
      });
      
      return { success: true, version, backupId };
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      await this.logAudit({
        version: this.extractVersion(migrationFile),
        action: 'apply',
        status: 'failed',
        errorMessage: error.message,
        executionTime: Date.now() - startTime,
        triggeredBy: options.user
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  async rollbackMigration(version, options = {}) {
    const client = await this.pool.connect();
    const startTime = Date.now();
    
    try {
      await client.query('BEGIN');
      
      const migration = await this.getMigrationByVersion(client, version);
      if (!migration) {
        throw new Error(`Migration ${version} not found`);
      }
      
      if (migration.status !== 'applied') {
        throw new Error(`Migration ${version} is not in applied state`);
      }
      
      // 查找回滚文件
      const rollbackFile = migration.filename.replace('.up.sql', '.down.sql');
      const sql = await fs.readFile(rollbackFile, 'utf8');
      
      // 验证回滚脚本校验和
      const currentChecksum = await this.calculateChecksum(rollbackFile);
      if (migration.rollback_checksum && migration.rollback_checksum !== currentChecksum) {
        console.warn('Rollback script checksum mismatch, using current version');
      }
      
      // 执行回滚
      await client.query(sql);
      
      // 更新迁移状态
      await client.query(`
        UPDATE schema_migrations 
        SET status = 'rolled_back', 
            applied_at = NULL
        WHERE version = $1
      `, [version]);
      
      await client.query('COMMIT');
      
      await this.logAudit({
        version,
        action: 'rollback',
        status: 'success',
        executionTime: Date.now() - startTime,
        triggeredBy: options.user
      });
      
      return { success: true, version };
      
    } catch (error) {
      await client.query('ROLLBACK');
      
      await this.logAudit({
        version,
        action: 'rollback',
        status: 'failed',
        errorMessage: error.message,
        executionTime: Date.now() - startTime,
        triggeredBy: options.user
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  async dryRun(migrationFile) {
    const sql = await fs.readFile(migrationFile, 'utf8');
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('ROLLBACK');
      
      await this.logAudit({
        version: this.extractVersion(migrationFile),
        action: 'dry-run',
        status: 'success',
        triggeredBy: 'system'
      });
      
      return { success: true, canApply: true };
    } catch (error) {
      await client.query('ROLLBACK');
      
      return { 
        success: false, 
        canApply: false, 
        error: error.message 
      };
    } finally {
      client.release();
    }
  }

  async logAudit(entry) {
    await this.pool.query(`
      INSERT INTO migration_audit_log 
      (version, action, status, started_at, completed_at, error_message, 
       execution_time_ms, triggered_by, environment, backup_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      entry.version,
      entry.action,
      entry.status,
      new Date(Date.now() - (entry.executionTime || 0)),
      new Date(),
      entry.errorMessage,
      entry.executionTime,
      entry.triggeredBy,
      process.env.NODE_ENV || 'development',
      entry.backupId
    ]);
  }

  extractVersion(filename) {
    const match = path.basename(filename).match(/^(\d+)/);
    return match ? match[1] : null;
  }

  async getMigrationFiles() {
    const files = await fs.readdir(this.migrationsPath);
    return files
      .filter(f => f.endsWith('.up.sql'))
      .map(f => path.join(this.migrationsPath, f))
      .sort();
  }

  async getLatestAppliedVersion(client) {
    const result = await client.query(`
      SELECT version FROM schema_migrations 
      WHERE status = 'applied' 
      ORDER BY applied_at DESC 
      LIMIT 1
    `);
    return result.rows[0]?.version || null;
  }

  async getMigrationByVersion(client, version) {
    const result = await client.query(
      'SELECT * FROM schema_migrations WHERE version = $1',
      [version]
    );
    return result.rows[0];
  }
}

module.exports = MigrationManager;
```

### 2. 自动化回滚策略

#### 2.1 迁移前自动备份
```javascript
// backend/shared/backupManager.js
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class BackupManager {
  constructor(config) {
    this.backupPath = config.backupPath || '/backups';
    this.retentionDays = config.retentionDays || 30;
    this.s3Bucket = config.s3Bucket;
  }

  async createPreMigrationBackup(migrationFile) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const migrationName = path.basename(migrationFile, '.up.sql');
    const backupId = `pre-migration-${migrationName}-${timestamp}`;
    
    // 创建数据库备份
    const backupFile = `${this.backupPath}/${backupId}.sql`;
    
    await execAsync(`pg_dump -Fc ${process.env.DATABASE_URL} > ${backupFile}`);
    
    // 上传到 S3（如果配置）
    if (this.s3Bucket) {
      await this.uploadToS3(backupFile, backupId);
    }
    
    // 记录备份元数据
    await this.recordBackupMetadata(backupId, backupFile, migrationName);
    
    return backupId;
  }

  async restoreFromBackup(backupId) {
    const backupFile = `${this.backupPath}/${backupId}.sql`;
    
    // 验证备份文件存在
    if (!await fs.access(backupFile).then(() => true).catch(() => false)) {
      throw new Error(`Backup file not found: ${backupId}`);
    }
    
    // 恢复数据库
    await execAsync(`pg_restore -d ${process.env.DATABASE_URL} ${backupFile}`);
    
    return { success: true, backupId };
  }

  async uploadToS3(filePath, backupId) {
    const s3Key = `database-backups/${backupId}.sql`;
    await execAsync(
      `aws s3 cp ${filePath} s3://${this.s3Bucket}/${s3Key}`
    );
  }

  async recordBackupMetadata(backupId, filePath, migrationName) {
    // 记录到数据库或文件系统
    const metadata = {
      backupId,
      migrationName,
      timestamp: new Date().toISOString(),
      filePath,
      s3Path: this.s3Bucket ? `s3://${this.s3Bucket}/database-backups/${backupId}.sql` : null
    };
    
    await fs.writeFile(
      `${this.backupPath}/${backupId}.metadata.json`,
      JSON.stringify(metadata, null, 2)
    );
  }

  async cleanupOldBackups() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
    
    const files = await fs.readdir(this.backupPath);
    
    for (const file of files) {
      const filePath = path.join(this.backupPath, file);
      const stats = await fs.stat(filePath);
      
      if (stats.birthtime < cutoffDate) {
        await fs.unlink(filePath);
        console.log(`Deleted old backup: ${file}`);
      }
    }
  }
}

module.exports = BackupManager;
```

#### 2.2 迁移失败自动回滚
```javascript
// backend/shared/migrationExecutor.js
class MigrationExecutor {
  constructor(migrationManager, backupManager) {
    this.migrationManager = migrationManager;
    this.backupManager = backupManager;
  }

  async executeWithAutoRollback(migrationFile, options = {}) {
    const version = this.migrationManager.extractVersion(migrationFile);
    
    try {
      // 1. 预检查
      const dryRunResult = await this.migrationManager.dryRun(migrationFile);
      if (!dryRunResult.canApply) {
        throw new Error(`Dry-run failed: ${dryRunResult.error}`);
      }
      
      // 2. 创建备份
      const backupId = await this.backupManager.createPreMigrationBackup(migrationFile);
      
      // 3. 执行迁移
      const result = await this.migrationManager.applyMigration(migrationFile, {
        ...options,
        backupId
      });
      
      // 4. 验证迁移后数据完整性
      await this.verifyMigrationIntegrity(version);
      
      return { success: true, backupId, ...result };
      
    } catch (error) {
      console.error(`Migration ${version} failed, initiating rollback...`);
      
      // 自动回滚
      try {
        await this.migrationManager.rollbackMigration(version);
        console.log(`Migration ${version} rolled back successfully`);
      } catch (rollbackError) {
        console.error(`Rollback also failed:`, rollbackError);
        // 发送严重告警
        await this.sendCriticalAlert(version, error, rollbackError);
      }
      
      throw error;
    }
  }

  async verifyMigrationIntegrity(version) {
    // 执行数据完整性检查
    const checks = [
      this.checkTableIntegrity(),
      this.checkIndexIntegrity(),
      this.checkConstraintIntegrity()
    ];
    
    const results = await Promise.all(checks);
    const failures = results.filter(r => !r.success);
    
    if (failures.length > 0) {
      throw new Error(`Integrity check failed: ${failures.map(f => f.error).join(', ')}`);
    }
  }

  async checkTableIntegrity() {
    // 实现表完整性检查
    return { success: true };
  }

  async checkIndexIntegrity() {
    // 实现索引完整性检查
    return { success: true };
  }

  async checkConstraintIntegrity() {
    // 实现约束完整性检查
    return { success: true };
  }

  async sendCriticalAlert(version, migrationError, rollbackError) {
    // 发送严重告警到 Slack/Email/PagerDuty
    const message = {
      severity: 'critical',
      title: `Migration ${version} failed and rollback also failed`,
      migrationError: migrationError.message,
      rollbackError: rollbackError.message,
      timestamp: new Date().toISOString()
    };
    
    // 实现告警发送逻辑
    console.error('CRITICAL ALERT:', message);
  }
}

module.exports = MigrationExecutor;
```

### 3. CI/CD 集成

#### 3.1 GitHub Actions 工作流
```yaml
# .github/workflows/database-migration.yml
name: Database Migration

on:
  push:
    paths:
      - 'migrations/**'
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        default: 'staging'
        type: choice
        options:
          - staging
          - production
      migration_version:
        description: 'Specific migration version (optional)'
        required: false

jobs:
  validate-migration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Validate migration files
        run: |
          node backend/scripts/validateMigrations.js
      
      - name: Check migration dependencies
        run: |
          node backend/scripts/checkMigrationDeps.js

  dry-run:
    needs: validate-migration
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run dry-run
        run: |
          node backend/scripts/migrate.js dry-run
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}

  apply-staging:
    needs: dry-run
    runs-on: ubuntu-latest
    environment: staging
    if: github.event.inputs.environment == 'staging' || github.event_name == 'push'
    steps:
      - uses: actions/checkout@v3
      
      - name: Apply migrations to staging
        run: |
          node backend/scripts/migrate.js apply --env staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          S3_BACKUP_BUCKET: ${{ secrets.S3_BACKUP_BUCKET }}

  request-production-approval:
    needs: apply-staging
    runs-on: ubuntu-latest
    if: github.event.inputs.environment == 'production'
    steps:
      - name: Create approval request
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: 'Production Migration Approval Required',
              body: `
                ## Migration Approval Request
                
                **Environment**: Production
                **Triggered by**: ${{ github.actor }}
                **Migration files**: ${changed_files}
                
                ### Pre-flight checks
                - [x] Staging migration successful
                - [x] Dry-run passed
                - [x] Backup created
                
                ### Action required
                Please review and approve this issue to proceed with production migration.
              `,
              labels: ['migration-approval', 'production']
            })

  apply-production:
    needs: request-production-approval
    runs-on: ubuntu-latest
    environment: production
    if: github.event.inputs.environment == 'production'
    steps:
      - uses: actions/checkout@v3
      
      - name: Create production backup
        run: |
          node backend/scripts/backup.js --full
        env:
          DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}
          S3_BACKUP_BUCKET: ${{ secrets.S3_BACKUP_BUCKET }}
      
      - name: Apply migrations to production
        run: |
          node backend/scripts/migrate.js apply --env production --auto-rollback
        env:
          DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          S3_BACKUP_BUCKET: ${{ secrets.S3_BACKUP_BUCKET }}
      
      - name: Verify migration
        run: |
          node backend/scripts/verifyMigration.js --env production
        env:
          DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}

  notify-status:
    needs: [apply-staging, apply-production]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - name: Send notification
        uses: 8398a7/action-slack@v3
        with:
          status: ${{ job.status }}
          fields: repo,message,commit,author,action,eventName,ref,workflow
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

### 4. 迁移脚本工具

#### 4.1 迁移 CLI 工具
```javascript
// backend/scripts/migrate.js
#!/usr/bin/env node
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const MigrationManager = require('../shared/migrationManager');
const BackupManager = require('../shared/backupManager');
const MigrationExecutor = require('../shared/migrationExecutor');

const argv = yargs(hideBin(process.argv))
  .command('status', 'Show migration status', {}, async () => {
    const manager = new MigrationManager(getConfig());
    await manager.init();
    
    const applied = await manager.getAppliedMigrations();
    const pending = await manager.getPendingMigrations();
    
    console.log('\n=== Applied Migrations ===');
    applied.forEach(m => {
      console.log(`  ✓ ${m.version} - ${m.name} (${m.applied_at})`);
    });
    
    console.log('\n=== Pending Migrations ===');
    pending.forEach(m => {
      console.log(`  ○ ${m.version} - ${m.filename}`);
    });
  })
  .command('apply', 'Apply pending migrations', {
    version: {
      alias: 'v',
      type: 'string',
      describe: 'Specific version to apply'
    },
    'auto-rollback': {
      type: 'boolean',
      default: false,
      describe: 'Auto rollback on failure'
    }
  }, async (argv) => {
    const manager = new MigrationManager(getConfig());
    const backup = new BackupManager(getConfig());
    const executor = new MigrationExecutor(manager, backup);
    
    await manager.init();
    
    if (argv.version) {
      const file = await manager.findMigrationFile(argv.version);
      await executor.executeWithAutoRollback(file);
    } else {
      const pending = await manager.getPendingMigrations();
      for (const migration of pending) {
        await executor.executeWithAutoRollback(migration.filename);
      }
    }
  })
  .command('rollback', 'Rollback migration', {
    version: {
      alias: 'v',
      type: 'string',
      demandOption: true,
      describe: 'Version to rollback'
    }
  }, async (argv) => {
    const manager = new MigrationManager(getConfig());
    await manager.init();
    
    await manager.rollbackMigration(argv.version);
    console.log(`Migration ${argv.version} rolled back successfully`);
  })
  .command('dry-run', 'Test migration without applying', {}, async () => {
    const manager = new MigrationManager(getConfig());
    await manager.init();
    
    const pending = await manager.getPendingMigrations();
    for (const migration of pending) {
      const result = await manager.dryRun(migration.filename);
      console.log(`${migration.version}: ${result.canApply ? '✓ OK' : '✗ ' + result.error}`);
    }
  })
  .command('create', 'Create new migration', {
    name: {
      alias: 'n',
      type: 'string',
      demandOption: true,
      describe: 'Migration name'
    }
  }, async (argv) => {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `${timestamp}_${argv.name.replace(/\s+/g, '_')}`;
    
    await fs.writeFile(
      `migrations/${filename}.up.sql`,
      '-- Migration: ' + argv.name + '\n-- Created at: ' + new Date().toISOString() + '\n\n'
    );
    
    await fs.writeFile(
      `migrations/${filename}.down.sql`,
      '-- Rollback: ' + argv.name + '\n\n'
    );
    
    console.log(`Created migration files:\n  - ${filename}.up.sql\n  - ${filename}.down.sql`);
  })
  .argv;

function getConfig() {
  return {
    database: process.env.DATABASE_URL,
    migrationsPath: './migrations',
    backupPath: '/backups',
    s3Bucket: process.env.S3_BACKUP_BUCKET
  };
}
```

### 5. 监控与告警

#### 5.1 Prometheus 指标
```javascript
// backend/shared/migrationMetrics.js
const client = require('prom-client');

const migrationMetrics = {
  migrationsApplied: new client.Counter({
    name: 'migration_applied_total',
    help: 'Total number of migrations applied',
    labelNames: ['version', 'status']
  }),
  
  migrationDuration: new client.Histogram({
    name: 'migration_duration_seconds',
    help: 'Duration of migration operations',
    labelNames: ['version', 'operation'],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60]
  }),
  
  rollbackCount: new client.Counter({
    name: 'migration_rollback_total',
    help: 'Total number of migration rollbacks',
    labelNames: ['version', 'reason']
  }),
  
  pendingMigrations: new client.Gauge({
    name: 'migration_pending_count',
    help: 'Number of pending migrations'
  }),
  
  backupSize: new client.Gauge({
    name: 'migration_backup_size_bytes',
    help: 'Size of migration backups',
    labelNames: ['backup_id']
  })
};

module.exports = migrationMetrics;
```

## 验收标准

- [ ] 迁移管理器支持版本控制、校验和验证
- [ ] 所有迁移文件包含 `.up.sql` 和 `.down.sql` 配对
- [ ] 迁移前自动创建数据库备份
- [ ] 迁移失败时自动回滚，支持手动回滚
- [ ] 提供 `migrate status/apply/rollback/dry-run/create` CLI 命令
- [ ] CI/CD 集成：staging 自动执行，production 需审批
- [ ] 迁移审计日志完整记录所有操作
- [ ] 监控指标暴露：迁移次数、耗时、回滚次数
- [ ] 备份保留策略可配置，支持 S3 存储
- [ ] 支持迁移依赖声明和验证
- [ ] 提供 Web UI 查看迁移历史和状态（可选）

## 影响范围

- `backend/shared/migrationManager.js` - 新建迁移管理器
- `backend/shared/backupManager.js` - 新建备份管理器
- `backend/shared/migrationExecutor.js` - 新建执行器
- `backend/scripts/migrate.js` - 新建 CLI 工具
- `migrations/` - 迁移文件目录
- `.github/workflows/database-migration.yml` - CI/CD 工作流
- `backend/shared/migrationMetrics.js` - 监控指标
- 所有微服务 - 集成迁移管理器

## 参考

- [Flyway Database Migrations](https://flywaydb.org/)
- [Database Migration Best Practices](https://github.com/golang-migrate/migrate)
- [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [GitHub Actions Manual Approval](https://docs.github.com/en/actions/managing-workflow-runs/reviewing-deployments)
