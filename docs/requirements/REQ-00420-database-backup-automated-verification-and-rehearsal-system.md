# REQ-00420: 数据库备份自动验证与演练系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00420 |
| 标题 | 数据库备份自动验证与演练系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database、backup-service、monitoring、admin-dashboard |
| 创建时间 | 2026-07-02 01:00 |

## 需求描述

建立自动化的数据库备份验证系统，确保备份文件的有效性和可恢复性，并通过定期演练验证灾备流程的可靠性。系统需支持：

1. **备份完整性验证**：自动检测备份文件是否完整、无损坏
2. **数据一致性验证**：验证备份数据的逻辑一致性（外键、索引、约束等）
3. **恢复演练自动化**：定期在隔离环境中执行恢复演练
4. **演练报告生成**：自动生成恢复演练报告，记录恢复时间、数据完整性等指标
5. **异常预警机制**：备份验证失败或恢复演练异常时自动告警

### 背景与价值

- **问题**：备份文件损坏或恢复失败可能导致数据永久丢失
- **现状**：当前仅执行备份，未验证备份的有效性和可恢复性
- **价值**：
  - 确保灾备方案的可信度
  - 及早发现备份问题，避免关键时刻恢复失败
  - 满足合规要求（SOC2、GDPR等）
  - 缩短实际灾难恢复时间（通过演练积累经验）

## 技术方案

### 1. 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│              Backup Verification System                        │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   Backup    │  │  Integrity  │  │  Consistency │          │
│  │   Scanner   │──▶   Checker   │──▶   Validator  │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│         │                                     │                │
│         │                ┌─────────────┐     │                │
│         │                │   Restore   │     │                │
│         └───────────────▶│   Tester    │◀────┘                │
│                          └─────────────┘                       │
│                                 │                               │
│                          ┌──────▼──────┐                       │
│                          │   Report    │                       │
│                          │  Generator  │                       │
│                          └─────────────┘                       │
│                                 │                               │
│                          ┌──────▼──────┐                       │
│                          │   Alerter   │                       │
│                          └─────────────┘                       │
└──────────────────────────────────────────────────────────────┘
```

### 2. 备份完整性检查器（IntegrityChecker）

```javascript
// backend/backup-service/validators/integrity-checker.js

class IntegrityChecker {
  constructor(config) {
    this.config = {
      checksumAlgorithm: 'sha256',
      minBackupSize: 1024 * 1024, // 1MB
      maxBackupAge: 30 * 24 * 60 * 60 * 1000, // 30天
      ...config
    };
  }

  /**
   * 验证备份文件完整性
   * @param {Object} backup - 备份文件元数据
   * @returns {Object} 验证结果
   */
  async verify(backup) {
    const result = {
      backupId: backup.id,
      timestamp: new Date().toISOString(),
      checks: []
    };

    // 1. 文件存在性检查
    const existsCheck = await this.checkFileExists(backup.path);
    result.checks.push({
      name: 'file_exists',
      passed: existsCheck.passed,
      details: existsCheck.details
    });

    if (!existsCheck.passed) {
      result.overall = 'failed';
      return result;
    }

    // 2. 文件大小检查
    const sizeCheck = await this.checkFileSize(backup.path, backup.expectedSize);
    result.checks.push({
      name: 'file_size',
      passed: sizeCheck.passed,
      details: sizeCheck.details
    });

    // 3. 校验和验证
    const checksumCheck = await this.verifyChecksum(backup.path, backup.checksum);
    result.checks.push({
      name: 'checksum',
      passed: checksumCheck.passed,
      details: checksumCheck.details
    });

    // 4. 备份年龄检查
    const ageCheck = await this.checkBackupAge(backup.createdAt);
    result.checks.push({
      name: 'backup_age',
      passed: ageCheck.passed,
      details: ageCheck.details
    });

    // 5. 压缩完整性检查（如果是压缩备份）
    if (backup.compressed) {
      const compressionCheck = await this.verifyCompression(backup.path);
      result.checks.push({
        name: 'compression_integrity',
        passed: compressionCheck.passed,
        details: compressionCheck.details
      });
    }

    result.overall = result.checks.every(c => c.passed) ? 'passed' : 'failed';
    return result;
  }

  /**
   * 校验和验证
   */
  async verifyChecksum(filePath, expectedChecksum) {
    const crypto = require('crypto');
    const fs = require('fs');
    const { pipeline } = require('stream/promises');

    return new Promise((resolve) => {
      const hash = crypto.createHash(this.config.checksumAlgorithm);
      const stream = fs.createReadStream(filePath);
      
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        const actualChecksum = hash.digest('hex');
        resolve({
          passed: actualChecksum === expectedChecksum,
          details: {
            expected: expectedChecksum,
            actual: actualChecksum,
            algorithm: this.config.checksumAlgorithm
          }
        });
      });
      stream.on('error', (error) => {
        resolve({
          passed: false,
          details: { error: error.message }
        });
      });
    });
  }

  /**
   * 验证压缩文件完整性
   */
  async verifyCompression(filePath) {
    const { exec } = require('child_process');
    const util = require('util');
    const execAsync = util.promisify(exec);

    try {
      // 使用 pg_restore --list 或 gunzip -t 验证
      if (filePath.endsWith('.gz')) {
        await execAsync(`gunzip -t ${filePath}`);
      } else if (filePath.endsWith('.backup') || filePath.endsWith('.dump')) {
        await execAsync(`pg_restore --list ${filePath}`);
      }

      return {
        passed: true,
        details: { message: 'Compression integrity verified' }
      };
    } catch (error) {
      return {
        passed: false,
        details: { error: error.message }
      };
    }
  }

  checkBackupAge(createdAt) {
    const age = Date.now() - new Date(createdAt).getTime();
    return {
      passed: age <= this.config.maxBackupAge,
      details: {
        ageDays: Math.floor(age / (24 * 60 * 60 * 1000)),
        maxAgeDays: Math.floor(this.config.maxBackupAge / (24 * 60 * 60 * 1000))
      }
    };
  }
}

module.exports = IntegrityChecker;
```

### 3. 数据一致性验证器（ConsistencyValidator）

```javascript
// backend/backup-service/validators/consistency-validator.js

class ConsistencyValidator {
  constructor(pgClient) {
    this.pgClient = pgClient;
  }

  /**
   * 在恢复的测试数据库上执行一致性验证
   */
  async validate(testDbConfig) {
    const results = {
      timestamp: new Date().toISOString(),
      checks: []
    };

    try {
      // 连接到测试数据库
      const { Pool } = require('pg');
      const pool = new Pool(testDbConfig);

      // 1. 表存在性检查
      const tableCheck = await this.checkTablesExist(pool);
      results.checks.push(tableCheck);

      // 2. 外键约束检查
      const fkCheck = await this.checkForeignKeys(pool);
      results.checks.push(fkCheck);

      // 3. 索引完整性检查
      const indexCheck = await this.checkIndexes(pool);
      results.checks.push(indexCheck);

      // 4. 数据完整性检查（关键表）
      const dataCheck = await this.checkDataIntegrity(pool);
      results.checks.push(dataCheck);

      // 5. 序列值检查
      const sequenceCheck = await this.checkSequences(pool);
      results.checks.push(sequenceCheck);

      // 6. 触发器状态检查
      const triggerCheck = await this.checkTriggers(pool);
      results.checks.push(triggerCheck);

      await pool.end();

      results.overall = results.checks.every(c => c.passed) ? 'passed' : 'failed';
    } catch (error) {
      results.overall = 'error';
      results.error = error.message;
    }

    return results;
  }

  /**
   * 检查关键表是否存在
   */
  async checkTablesExist(pool) {
    const requiredTables = [
      'users', 'pokemon_instances', 'pokemon_species',
      'gyms', 'friendships', 'trades', 'payments',
      'tasks', 'achievements', 'raids'
    ];

    const result = await pool.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public'
    `);

    const existingTables = result.rows.map(r => r.tablename);
    const missingTables = requiredTables.filter(t => !existingTables.includes(t));

    return {
      name: 'tables_exist',
      passed: missingTables.length === 0,
      details: {
        required: requiredTables.length,
        existing: existingTables.length,
        missing: missingTables
      }
    };
  }

  /**
   * 检查外键约束
   */
  async checkForeignKeys(pool) {
    const result = await pool.query(`
      SELECT
        tc.constraint_name,
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `);

    // 验证外键数据完整性
    const violations = [];
    for (const fk of result.rows) {
      const violationResult = await pool.query(`
        SELECT COUNT(*) as violations
        FROM ${fk.table_name} t
        LEFT JOIN ${fk.foreign_table_name} ft ON t.${fk.column_name} = ft.${fk.foreign_column_name}
        WHERE t.${fk.column_name} IS NOT NULL AND ft.${fk.foreign_column_name} IS NULL
      `);

      if (parseInt(violationResult.rows[0].violations) > 0) {
        violations.push({
          constraint: fk.constraint_name,
          table: fk.table_name,
          violations: parseInt(violationResult.rows[0].violations)
        });
      }
    }

    return {
      name: 'foreign_keys',
      passed: violations.length === 0,
      details: {
        totalConstraints: result.rows.length,
        violations: violations
      }
    };
  }

  /**
   * 检查索引完整性
   */
  async checkIndexes(pool) {
    const result = await pool.query(`
      SELECT indexrelname, relname as tablename
      FROM pg_index
      JOIN pg_class ON pg_class.oid = pg_index.indexrelid
      JOIN pg_class AS t ON t.oid = pg_index.indrelid
      WHERE schemaname = 'public' AND pg_index.indisvalid = false
    `);

    return {
      name: 'indexes',
      passed: result.rows.length === 0,
      details: {
        invalidIndexes: result.rows
      }
    };
  }

  /**
   * 检查数据完整性
   */
  async checkDataIntegrity(pool) {
    const checks = [];

    // 1. 用户数据检查
    const userCount = await pool.query('SELECT COUNT(*) as count FROM users');
    checks.push({
      table: 'users',
      count: parseInt(userCount.rows[0].count)
    });

    // 2. 精灵实例检查
    const pokemonCount = await pool.query('SELECT COUNT(*) as count FROM pokemon_instances');
    checks.push({
      table: 'pokemon_instances',
      count: parseInt(pokemonCount.rows[0].count)
    });

    // 3. 孤儿精灵检查（无用户的精灵）
    const orphanCheck = await pool.query(`
      SELECT COUNT(*) as count 
      FROM pokemon_instances pi
      LEFT JOIN users u ON pi.user_id = u.id
      WHERE u.id IS NULL
    `);

    return {
      name: 'data_integrity',
      passed: parseInt(orphanCheck.rows[0].count) === 0,
      details: {
        tables: checks,
        orphanRecords: parseInt(orphanCheck.rows[0].count)
      }
    };
  }

  /**
   * 检查序列值
   */
  async checkSequences(pool) {
    const result = await pool.query(`
      SELECT 
        sequence_name,
        last_value
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
    `);

    return {
      name: 'sequences',
      passed: result.rows.length > 0,
      details: {
        sequences: result.rows
      }
    };
  }

  /**
   * 检查触发器
   */
  async checkTriggers(pool) {
    const result = await pool.query(`
      SELECT 
        trigger_name,
        event_manipulation,
        event_object_table,
        action_timing
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
    `);

    return {
      name: 'triggers',
      passed: result.rows.length > 0,
      details: {
        triggers: result.rows
      }
    };
  }
}

module.exports = ConsistencyValidator;
```

### 4. 恢复演练执行器（RestoreTester）

```javascript
// backend/backup-service/testers/restore-tester.js

class RestoreTester {
  constructor(config) {
    this.config = {
      testDbPrefix: 'backup_test_',
      maxTestDbs: 5,
      restoreTimeout: 30 * 60 * 1000, // 30分钟
      cleanupTimeout: 5 * 60 * 1000,  // 5分钟
      ...config
    };
  }

  /**
   * 执行恢复演练
   * @param {Object} backup - 备份文件信息
   * @returns {Object} 演练结果
   */
  async executeRehearsal(backup) {
    const rehearsalId = `${this.config.testDbPrefix}${Date.now()}`;
    const result = {
      rehearsalId,
      backupId: backup.id,
      startTime: new Date().toISOString(),
      phases: []
    };

    let testDbConfig = null;

    try {
      // Phase 1: 环境准备
      const prepPhase = await this.prepareEnvironment(backup);
      result.phases.push(prepPhase);

      if (!prepPhase.success) {
        throw new Error('Environment preparation failed');
      }

      testDbConfig = prepPhase.testDbConfig;

      // Phase 2: 执行恢复
      const restorePhase = await this.executeRestore(backup, testDbConfig);
      result.phases.push(restorePhase);

      if (!restorePhase.success) {
        throw new Error('Restore failed');
      }

      result.restoreTime = restorePhase.duration;
      result.restoreSize = backup.size;

      // Phase 3: 数据验证
      const validationPhase = await this.validateRestoredData(testDbConfig);
      result.phases.push(validationPhase);

      // Phase 4: 性能测试
      const perfPhase = await this.performanceTest(testDbConfig);
      result.phases.push(perfPhase);

      result.overall = 'passed';
      result.success = true;

    } catch (error) {
      result.overall = 'failed';
      result.success = false;
      result.error = error.message;
    } finally {
      // Phase 5: 清理环境
      if (testDbConfig) {
        const cleanupPhase = await this.cleanupEnvironment(testDbConfig);
        result.phases.push(cleanupPhase);
      }

      result.endTime = new Date().toISOString();
      result.totalDuration = new Date(result.endTime) - new Date(result.startTime);
    }

    return result;
  }

  /**
   * 准备测试环境
   */
  async prepareEnvironment(backup) {
    const phase = {
      name: 'prepare_environment',
      startTime: new Date().toISOString(),
      success: false
    };

    try {
      const { Pool } = require('pg');
      const adminPool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_ADMIN_USER,
        password: process.env.DB_ADMIN_PASSWORD,
        database: 'postgres'
      });

      const testDbName = `${this.config.testDbPrefix}${backup.id}`;
      
      // 创建测试数据库
      await adminPool.query(`DROP DATABASE IF EXISTS ${testDbName}`);
      await adminPool.query(`CREATE DATABASE ${testDbName}`);

      phase.testDbConfig = {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: testDbName
      };

      await adminPool.end();
      phase.success = true;

    } catch (error) {
      phase.error = error.message;
    }

    phase.endTime = new Date().toISOString();
    phase.duration = new Date(phase.endTime) - new Date(phase.startTime);
    return phase;
  }

  /**
   * 执行数据库恢复
   */
  async executeRestore(backup, testDbConfig) {
    const phase = {
      name: 'execute_restore',
      startTime: new Date().toISOString(),
      success: false
    };

    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // 构建 pg_restore 命令
      const cmd = `pg_restore --host=${testDbConfig.host} ` +
        `--port=${testDbConfig.port} ` +
        `--username=${testDbConfig.user} ` +
        `--dbname=${testDbConfig.database} ` +
        `--no-owner --no-acl ` +
        backup.path;

      // 执行恢复
      await execAsync(cmd, { timeout: this.config.restoreTimeout });

      phase.success = true;

    } catch (error) {
      // pg_restore 可能返回非零退出码但恢复成功
      // 检查是否有致命错误
      if (error.message.includes('FATAL') || error.message.includes('error:')) {
        phase.error = error.message;
      } else {
        phase.warnings = error.message;
        phase.success = true;
      }
    }

    phase.endTime = new Date().toISOString();
    phase.duration = new Date(phase.endTime) - new Date(phase.startTime);
    return phase;
  }

  /**
   * 验证恢复的数据
   */
  async validateRestoredData(testDbConfig) {
    const phase = {
      name: 'validate_data',
      startTime: new Date().toISOString(),
      success: false
    };

    try {
      const ConsistencyValidator = require('../validators/consistency-validator');
      const validator = new ConsistencyValidator();

      const validationResult = await validator.validate(testDbConfig);
      
      phase.success = validationResult.overall === 'passed';
      phase.details = validationResult;

    } catch (error) {
      phase.error = error.message;
    }

    phase.endTime = new Date().toISOString();
    phase.duration = new Date(phase.endTime) - new Date(phase.startTime);
    return phase;
  }

  /**
   * 性能测试
   */
  async performanceTest(testDbConfig) {
    const phase = {
      name: 'performance_test',
      startTime: new Date().toISOString(),
      success: false,
      metrics: {}
    };

    try {
      const { Pool } = require('pg');
      const pool = new Pool(testDbConfig);

      // 1. 简单查询性能
      const simpleQueryStart = Date.now();
      await pool.query('SELECT COUNT(*) FROM users');
      phase.metrics.simpleQueryMs = Date.now() - simpleQueryStart;

      // 2. 复杂查询性能（带地理查询）
      const geoQueryStart = Date.now();
      await pool.query(`
        SELECT * FROM gyms
        WHERE ST_DWithin(
          location,
          ST_MakePoint(121.4737, 31.2304)::geography,
          1000
        )
        LIMIT 10
      `);
      phase.metrics.geoQueryMs = Date.now() - geoQueryStart;

      // 3. 连接查询性能
      const joinQueryStart = Date.now();
      await pool.query(`
        SELECT u.username, COUNT(pi.id) as pokemon_count
        FROM users u
        JOIN pokemon_instances pi ON u.id = pi.user_id
        GROUP BY u.id, u.username
        LIMIT 100
      `);
      phase.metrics.joinQueryMs = Date.now() - joinQueryStart;

      await pool.end();

      phase.success = true;

    } catch (error) {
      phase.error = error.message;
    }

    phase.endTime = new Date().toISOString();
    phase.duration = new Date(phase.endTime) - new Date(phase.startTime);
    return phase;
  }

  /**
   * 清理测试环境
   */
  async cleanupEnvironment(testDbConfig) {
    const phase = {
      name: 'cleanup',
      startTime: new Date().toISOString(),
      success: false
    };

    try {
      const { Pool } = require('pg');
      const adminPool = new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_ADMIN_USER,
        password: process.env.DB_ADMIN_PASSWORD,
        database: 'postgres'
      });

      // 断开所有连接
      await adminPool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = '${testDbConfig.database}'
      `);

      // 删除测试数据库
      await adminPool.query(`DROP DATABASE IF EXISTS ${testDbConfig.database}`);
      await adminPool.end();

      phase.success = true;

    } catch (error) {
      phase.error = error.message;
    }

    phase.endTime = new Date().toISOString();
    phase.duration = new Date(phase.endTime) - new Date(phase.startTime);
    return phase;
  }
}

module.exports = RestoreTester;
```

### 5. 调度器与协调器

```javascript
// backend/backup-service/scheduler/verification-scheduler.js

const { CronJob } = require('cron');

class VerificationScheduler {
  constructor(config) {
    this.config = {
      // 每日凌晨2点执行完整性检查
      integrityCheckCron: '0 2 * * *',
      // 每周日凌晨3点执行恢复演练
      rehearsalCron: '0 3 * * 0',
      // 保留最近4周的演练报告
      reportRetentionDays: 28,
      ...config
    };

    this.jobs = [];
  }

  start() {
    // 备份完整性检查任务
    this.jobs.push(new CronJob(
      this.config.integrityCheckCron,
      () => this.runIntegrityCheck(),
      null,
      true,
      'UTC'
    ));

    // 恢复演练任务
    this.jobs.push(new CronJob(
      this.config.rehearsalCron,
      () => this.runRehearsal(),
      null,
      true,
      'UTC'
    ));

    console.log('Verification scheduler started');
  }

  stop() {
    this.jobs.forEach(job => job.stop());
    this.jobs = [];
  }

  /**
   * 执行备份完整性检查
   */
  async runIntegrityCheck() {
    console.log('Starting backup integrity check...');

    const IntegrityChecker = require('../validators/integrity-checker');
    const BackupRepository = require('../repositories/backup-repository');
    const ReportGenerator = require('../reports/report-generator');
    const Alerter = require('../alerts/alerter');

    const checker = new IntegrityChecker();
    const backupRepo = new BackupRepository();
    const reporter = new ReportGenerator();
    const alerter = new Alerter();

    try {
      // 获取最近的备份文件
      const backups = await backupRepo.getRecentBackups(7);

      const results = [];
      for (const backup of backups) {
        const result = await checker.verify(backup);
        results.push(result);

        // 验证失败时发送告警
        if (result.overall === 'failed') {
          await alerter.sendBackupAlert({
            type: 'integrity_check_failed',
            backup: backup,
            result: result
          });
        }
      }

      // 生成完整性检查报告
      await reporter.generateIntegrityReport(results);

      console.log(`Integrity check completed. ${results.length} backups checked.`);

    } catch (error) {
      console.error('Integrity check failed:', error);
      await alerter.sendSystemAlert({
        type: 'verification_system_error',
        error: error.message
      });
    }
  }

  /**
   * 执行恢复演练
   */
  async runRehearsal() {
    console.log('Starting backup restoration rehearsal...');

    const RestoreTester = require('../testers/restore-tester');
    const BackupRepository = require('../repositories/backup-repository');
    const ReportGenerator = require('../reports/report-generator');
    const Alerter = require('../alerts/alerter');

    const tester = new RestoreTester();
    const backupRepo = new BackupRepository();
    const reporter = new ReportGenerator();
    const alerter = new Alerter();

    try {
      // 获取最近的完整备份
      const latestBackup = await backupRepo.getLatestFullBackup();

      if (!latestBackup) {
        throw new Error('No full backup found');
      }

      // 执行恢复演练
      const result = await tester.executeRehearsal(latestBackup);

      // 生成演练报告
      await reporter.generateRehearsalReport(result);

      // 演练失败时发送告警
      if (!result.success) {
        await alerter.sendBackupAlert({
          type: 'rehearsal_failed',
          backup: latestBackup,
          result: result
        });
      }

      console.log(`Rehearsal completed. Status: ${result.overall}`);
      console.log(`Restore time: ${result.restoreTime}ms`);

    } catch (error) {
      console.error('Rehearsal failed:', error);
      await alerter.sendSystemAlert({
        type: 'rehearsal_system_error',
        error: error.message
      });
    }
  }
}

module.exports = VerificationScheduler;
```

### 6. 报告生成器

```javascript
// backend/backup-service/reports/report-generator.js

class ReportGenerator {
  constructor(config) {
    this.config = {
      reportDir: '/var/log/backup-reports',
      reportFormat: 'html', // html, json, pdf
      ...config
    };
  }

  /**
   * 生成完整性检查报告
   */
  async generateIntegrityReport(results) {
    const fs = require('fs').promises;
    const path = require('path');

    const report = {
      title: 'Backup Integrity Check Report',
      generatedAt: new Date().toISOString(),
      summary: {
        total: results.length,
        passed: results.filter(r => r.overall === 'passed').length,
        failed: results.filter(r => r.overall === 'failed').length
      },
      details: results
    };

    const filename = `integrity-check-${Date.now()}.json`;
    const filepath = path.join(this.config.reportDir, filename);

    await fs.mkdir(this.config.reportDir, { recursive: true });
    await fs.writeFile(filepath, JSON.stringify(report, null, 2));

    // 同时生成HTML版本
    await this.generateHtmlReport(report, filepath.replace('.json', '.html'));

    return filepath;
  }

  /**
   * 生成恢复演练报告
   */
  async generateRehearsalReport(result) {
    const fs = require('fs').promises;
    const path = require('path');

    const report = {
      title: 'Backup Restoration Rehearsal Report',
      rehearsalId: result.rehearsalId,
      generatedAt: new Date().toISOString(),
      summary: {
        overall: result.overall,
        success: result.success,
        restoreTimeMs: result.restoreTime,
        totalDurationMs: result.totalDuration
      },
      phases: result.phases,
      errors: result.error ? [result.error] : []
    };

    const filename = `rehearsal-${result.rehearsalId}.json`;
    const filepath = path.join(this.config.reportDir, filename);

    await fs.mkdir(this.config.reportDir, { recursive: true });
    await fs.writeFile(filepath, JSON.stringify(report, null, 2));

    // 同时生成HTML版本
    await this.generateHtmlReport(report, filepath.replace('.json', '.html'));

    return filepath;
  }

  /**
   * 生成HTML报告
   */
  async generateHtmlReport(data, filepath) {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>${data.title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }
    .summary-card { padding: 20px; border-radius: 8px; text-align: center; }
    .summary-card.passed { background: #e8f5e9; border: 1px solid #4CAF50; }
    .summary-card.failed { background: #ffebee; border: 1px solid #f44336; }
    .summary-card.total { background: #e3f2fd; border: 1px solid #2196F3; }
    .summary-card h3 { margin: 0 0 10px 0; color: #666; }
    .summary-card .value { font-size: 2em; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #4CAF50; color: white; }
    .status-passed { color: #4CAF50; font-weight: bold; }
    .status-failed { color: #f44336; font-weight: bold; }
    .timestamp { color: #666; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${data.title}</h1>
    <p class="timestamp">Generated: ${data.generatedAt}</p>
    
    ${data.summary ? `
    <div class="summary">
      <div class="summary-card total">
        <h3>Total</h3>
        <div class="value">${data.summary.total || data.phases?.length || 0}</div>
      </div>
      <div class="summary-card passed">
        <h3>Passed</h3>
        <div class="value">${data.summary.passed || (data.summary.success ? 1 : 0)}</div>
      </div>
      <div class="summary-card failed">
        <h3>Failed</h3>
        <div class="value">${data.summary.failed || (data.summary.success ? 0 : 1)}</div>
      </div>
    </div>
    ` : ''}
    
    <h2>Details</h2>
    <pre>${JSON.stringify(data.details || data.phases, null, 2)}</pre>
  </div>
</body>
</html>
    `;

    await require('fs').promises.writeFile(filepath, html);
  }
}

module.exports = ReportGenerator;
```

### 7. 告警处理器

```javascript
// backend/backup-service/alerts/alerter.js

class Alerter {
  constructor(config) {
    this.config = {
      alertChannels: ['slack', 'email', 'pagerduty'],
      slackWebhook: process.env.SLACK_WEBHOOK_URL,
      emailRecipients: ['ops-team@example.com'],
      pagerdutyServiceKey: process.env.PAGERDUTY_SERVICE_KEY,
      ...config
    };
  }

  /**
   * 发送备份验证告警
   */
  async sendBackupAlert(alert) {
    const severity = this.determineSeverity(alert);
    
    const message = {
      title: `Backup Alert: ${alert.type}`,
      severity: severity,
      timestamp: new Date().toISOString(),
      details: {
        backupId: alert.backup?.id,
        backupPath: alert.backup?.path,
        result: alert.result?.overall
      }
    };

    // 并行发送到所有渠道
    await Promise.all([
      this.sendSlackAlert(message),
      this.sendEmailAlert(message),
      severity === 'critical' ? this.sendPagerDutyAlert(message) : Promise.resolve()
    ]);
  }

  /**
   * 发送系统告警
   */
  async sendSystemAlert(alert) {
    const message = {
      title: `Verification System Alert: ${alert.type}`,
      severity: 'high',
      timestamp: new Date().toISOString(),
      error: alert.error
    };

    await Promise.all([
      this.sendSlackAlert(message),
      this.sendEmailAlert(message)
    ]);
  }

  determineSeverity(alert) {
    if (alert.type === 'rehearsal_failed') return 'critical';
    if (alert.type === 'integrity_check_failed') return 'high';
    return 'medium';
  }

  async sendSlackAlert(message) {
    if (!this.config.slackWebhook) return;

    const color = message.severity === 'critical' ? 'danger' : 
                  message.severity === 'high' ? 'warning' : '#439FE0';

    const payload = {
      attachments: [{
        color: color,
        title: message.title,
        fields: [
          { title: 'Severity', value: message.severity, short: true },
          { title: 'Timestamp', value: message.timestamp, short: true },
          { title: 'Details', value: '```' + JSON.stringify(message.details || message.error, null, 2) + '```', short: false }
        ]
      }]
    };

    await fetch(this.config.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async sendEmailAlert(message) {
    // 实际实现中使用 nodemailer 或类似库
    console.log('Email alert:', message.title);
  }

  async sendPagerDutyAlert(message) {
    // 实际实现中使用 PagerDuty API
    console.log('PagerDuty alert:', message.title);
  }
}

module.exports = Alerter;
```

### 8. Prometheus 监控指标

```javascript
// backend/backup-service/metrics/backup-metrics.js

const client = require('prom-client');

// 备份验证相关指标
const backupVerificationMetrics = {
  // 备份完整性检查总数
  integrityChecksTotal: new client.Counter({
    name: 'backup_integrity_checks_total',
    help: 'Total number of backup integrity checks',
    labelNames: ['status']
  }),

  // 备份验证耗时
  verificationDurationSeconds: new client.Histogram({
    name: 'backup_verification_duration_seconds',
    help: 'Duration of backup verification in seconds',
    labelNames: ['backup_type'],
    buckets: [1, 5, 10, 30, 60, 120, 300]
  }),

  // 恢复演练总数
  rehearsalTotal: new client.Counter({
    name: 'backup_rehearsal_total',
    help: 'Total number of backup restoration rehearsals',
    labelNames: ['status']
  }),

  // 恢复演练耗时
  rehearsalDurationSeconds: new client.Histogram({
    name: 'backup_rehearsal_duration_seconds',
    help: 'Duration of restoration rehearsal in seconds',
    labelNames: ['phase'],
    buckets: [10, 30, 60, 120, 300, 600, 1800]
  }),

  // 恢复时间（核心指标）
  restoreTimeSeconds: new client.Gauge({
    name: 'backup_restore_time_seconds',
    help: 'Time taken to restore backup in seconds'
  }),

  // 备份年龄
  backupAgeDays: new client.Gauge({
    name: 'backup_age_days',
    help: 'Age of the backup in days',
    labelNames: ['backup_id']
  }),

  // 备份大小
  backupSizeBytes: new client.Gauge({
    name: 'backup_size_bytes',
    help: 'Size of backup file in bytes',
    labelNames: ['backup_id', 'backup_type']
  })
};

module.exports = backupVerificationMetrics;
```

### 9. Grafana 仪表板配置

```json
{
  "dashboard": {
    "title": "Backup Verification Dashboard",
    "panels": [
      {
        "title": "Backup Integrity Status",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(backup_integrity_checks_total{status=\"passed\"}) / sum(backup_integrity_checks_total)"
          }
        ],
        "thresholds": {
          "mode": "absolute",
          "steps": [
            { "color": "red", "value": 0 },
            { "color": "yellow", "value": 0.9 },
            { "color": "green", "value": 0.95 }
          ]
        }
      },
      {
        "title": "Restore Time Trend",
        "type": "graph",
        "targets": [
          {
            "expr": "backup_restore_time_seconds",
            "legendFormat": "Restore Time"
          }
        ]
      },
      {
        "title": "Rehearsal Success Rate",
        "type": "piechart",
        "targets": [
          {
            "expr": "sum(backup_rehearsal_total{status=\"passed\"})",
            "legendFormat": "Passed"
          },
          {
            "expr": "sum(backup_rehearsal_total{status=\"failed\"})",
            "legendFormat": "Failed"
          }
        ]
      },
      {
        "title": "Verification Duration by Phase",
        "type": "heatmap",
        "targets": [
          {
            "expr": "rate(backup_rehearsal_duration_seconds_bucket[5m])",
            "legendFormat": "{{phase}}"
          }
        ]
      }
    ]
  }
}
```

### 10. API 接口

```javascript
// backend/backup-service/routes/verification-routes.js

const express = require('express');
const router = express.Router();

router.get('/status', async (req, res) => {
  const status = {
    lastIntegrityCheck: await getLastIntegrityCheck(),
    lastRehearsal: await getLastRehearsal(),
    nextScheduled: await getNextScheduled(),
    backupStats: await getBackupStats()
  };
  res.json(status);
});

router.post('/verify/:backupId', async (req, res) => {
  const { backupId } = req.params;
  const IntegrityChecker = require('../validators/integrity-checker');
  const checker = new IntegrityChecker();
  const backup = await getBackupById(backupId);
  const result = await checker.verify(backup);
  res.json(result);
});

router.post('/rehearsal', async (req, res) => {
  const RestoreTester = require('../testers/restore-tester');
  const tester = new RestoreTester();
  const backup = await getLatestFullBackup();
  
  // 异步执行演练
  const rehearsalId = await queueRehearsal(backup);
  res.json({ 
    rehearsalId, 
    message: 'Rehearsal queued',
    statusUrl: `/api/backup/rehearsal/${rehearsalId}/status`
  });
});

router.get('/rehearsal/:id/status', async (req, res) => {
  const status = await getRehearsalStatus(req.params.id);
  res.json(status);
});

router.get('/reports', async (req, res) => {
  const reports = await getReports(req.query);
  res.json(reports);
});

module.exports = router;
```

## 验收标准

- [ ] 每日自动执行备份完整性检查，成功率 ≥ 99%
- [ ] 每周自动执行恢复演练，成功率 ≥ 95%
- [ ] 备份验证失败时 5 分钟内发送告警
- [ ] 恢复演练报告自动生成并归档
- [ ] 恢复时间指标可在 Grafana 中可视化
- [ ] 支持 PostgreSQL 和 Redis 两种数据库的验证
- [ ] 测试环境自动创建和清理，无残留资源
- [ ] 验证报告保留 28 天可追溯
- [ ] API 接口支持手动触发验证和演练
- [ ] 监控指标正确上报到 Prometheus

## 影响范围

- **新增服务**：backup-service（验证子系统）
- **新增数据库表**：backup_verifications、rehearsal_reports
- **新增配置**：验证规则、调度时间、告警渠道
- **新增监控**：Grafana 仪表板、Prometheus 指标
- **依赖服务**：PostgreSQL、Redis、Kafka（可选）

## 参考

- PostgreSQL 备份与恢复最佳实践：https://www.postgresql.org/docs/current/backup.html
- SOC2 合规要求：备份验证与演练
- AWS RDS 备份验证指南：https://aws.amazon.com/blogs/database/
- Google Cloud SQL 灾备演练实践
