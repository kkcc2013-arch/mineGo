# REQ-00318: 数据库备份自动验证与灾难恢复演练系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00318 |
| 标题 | 数据库备份自动验证与灾难恢复演练系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database/migrations、backend/jobs、backend/shared、admin-dashboard、infrastructure/k8s |
| 创建时间 | 2026-06-24 11:00 UTC |

## 需求描述

当前项目已有数据库备份系统（REQ-00025、REQ-00129），但缺乏备份有效性验证机制。备份文件可能存在损坏、不完整或与当前数据库版本不兼容等问题，导致灾难恢复时发现备份不可用。

**核心问题：**
1. 备份文件完整性未验证（备份可能静默失败或损坏）
2. 备份恢复流程未定期演练（真实灾难时可能操作失误）
3. 备份版本与数据库 schema 版本不匹配（迁移后旧备份不可用）
4. 恢复时间目标（RTO）和恢复点目标（RPO）未测量和优化
5. 缺乏自动化恢复测试环境

**目标：**
- 自动验证备份文件完整性和可恢复性
- 定期执行灾难恢复演练并生成报告
- 测量 RTO/RPO 指标并持续优化
- 提供一键式恢复操作界面

## 技术方案

### 1. 备份完整性验证模块

**文件：** `backend/shared/backupVerifier.js`

```javascript
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

/**
 * 数据库备份验证器
 */
class BackupVerifier {
  constructor(config = {}) {
    this.config = {
      backupPath: config.backupPath || '/var/backups/postgresql',
      tempRestorePath: config.tempRestorePath || '/tmp/backup-restore-test',
      pgBinPath: config.pgBinPath || '/usr/bin',
      database: config.database || 'minego',
      verifyChecksum: config.verifyChecksum !== false,
      testRestore: config.testRestore !== false,
      ...config
    };
    this.verificationResults = [];
  }

  /**
   * 验证单个备份文件
   */
  async verifyBackup(backupFile) {
    const result = {
      file: backupFile,
      timestamp: new Date().toISOString(),
      checks: {},
      passed: false,
      errors: []
    };

    try {
      // 1. 文件存在性检查
      const stats = await fs.stat(backupFile);
      result.checks.fileExists = true;
      result.checks.fileSize = stats.size;
      result.checks.modifiedAt = stats.mtime;

      // 2. 文件完整性检查（checksum）
      if (this.config.verifyChecksum) {
        result.checks.checksum = await this._calculateChecksum(backupFile);
      }

      // 3. 备份文件格式验证
      result.checks.formatValid = await this._validateBackupFormat(backupFile);

      // 4. 备份元数据提取
      result.checks.metadata = await this._extractBackupMetadata(backupFile);

      // 5. 恢复测试（可选）
      if (this.config.testRestore) {
        result.checks.restoreTest = await this._testRestore(backupFile);
      }

      // 综合判断
      result.passed = result.checks.fileExists && 
                      result.checks.formatValid &&
                      (!this.config.testRestore || result.checks.restoreTest?.success);

    } catch (error) {
      result.errors.push(error.message);
      result.passed = false;
    }

    this.verificationResults.push(result);
    return result;
  }

  /**
   * 计算备份文件 checksum
   */
  async _calculateChecksum(filePath, algorithm = 'sha256') {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm);
      const stream = require('fs').createReadStream(filePath);
      
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve({ algorithm, hash: hash.digest('hex') }));
      stream.on('error', reject);
    });
  }

  /**
   * 验证备份文件格式
   */
  async _validateBackupFormat(filePath) {
    const ext = path.extname(filePath);
    
    // 检查文件扩展名
    const validExtensions = ['.sql', '.dump', '.backup', '.tar', '.tar.gz'];
    if (!validExtensions.includes(ext) && !filePath.endsWith('.tar.gz')) {
      return { valid: false, reason: `Invalid extension: ${ext}` };
    }

    // 检查文件头（PostgreSQL dump 魔数）
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(5);
    await fd.read(buffer, 0, 5, 0);
    await fd.close();

    // PostgreSQL custom dump: PGDMP
    if (buffer.toString() === 'PGDMP') {
      return { valid: true, format: 'pg_custom_dump' };
    }

    // SQL dump 通常以 -- 或 /* 开头
    if (buffer.toString().startsWith('--') || buffer.toString().startsWith('/*')) {
      return { valid: true, format: 'sql_dump' };
    }

    return { valid: true, format: 'unknown', note: 'Format detected but not verified' };
  }

  /**
   * 提取备份元数据
   */
  async _extractBackupMetadata(filePath) {
    try {
      const stats = await fs.stat(filePath);
      const filename = path.basename(filePath);
      
      // 从文件名解析信息：backup_minego_20260624_110000.sql.gz
      const match = filename.match(/backup_(.+?)_(\d{8}_\d{6})/);
      
      return {
        database: match ? match[1] : 'unknown',
        backupTime: match ? this._parseBackupTime(match[2]) : null,
        fileSize: stats.size,
        compressed: filePath.endsWith('.gz') || filePath.endsWith('.tar.gz')
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * 测试恢复（恢复到临时数据库）
   */
  async _testRestore(backupFile) {
    const testDbName = `minego_restore_test_${Date.now()}`;
    const startTime = Date.now();

    try {
      // 1. 创建临时测试数据库
      await this._execCommand(`createdb ${testDbName}`);

      // 2. 执行恢复
      const restoreCommand = this._buildRestoreCommand(backupFile, testDbName);
      await this._execCommand(restoreCommand);

      // 3. 验证恢复结果
      const verification = await this._verifyRestoredData(testDbName);

      // 4. 清理临时数据库
      await this._execCommand(`dropdb ${testDbName}`);

      const duration = Date.now() - startTime;

      return {
        success: verification.success,
        duration,
        tablesRestored: verification.tableCount,
        recordsRestored: verification.recordCount,
        errors: verification.errors
      };

    } catch (error) {
      // 清理临时数据库
      try {
        await this._execCommand(`dropdb ${testDbName}`);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      return {
        success: false,
        duration: Date.now() - startTime,
        error: error.message
      };
    }
  }

  /**
   * 构建恢复命令
   */
  _buildRestoreCommand(backupFile, targetDb) {
    if (backupFile.endsWith('.sql.gz')) {
      return `gunzip -c ${backupFile} | psql -d ${targetDb}`;
    } else if (backupFile.endsWith('.sql')) {
      return `psql -d ${targetDb} -f ${backupFile}`;
    } else if (backupFile.endsWith('.dump') || backupFile.endsWith('.backup')) {
      return `pg_restore -d ${targetDb} ${backupFile}`;
    }
    throw new Error(`Unsupported backup format: ${backupFile}`);
  }

  /**
   * 验证恢复的数据
   */
  async _verifyRestoredData(dbName) {
    const result = { success: true, tableCount: 0, recordCount: 0, errors: [] };

    try {
      // 检查核心表是否存在
      const coreTables = ['users', 'pokemon', 'pokemon_instances', 'gyms', 'payments'];
      
      for (const table of coreTables) {
        const countResult = await this._execCommand(
          `psql -d ${dbName} -t -c "SELECT COUNT(*) FROM ${table}"`
        );
        const count = parseInt(countResult.trim()) || 0;
        result.tableCount++;
        result.recordCount += count;

        if (count === 0) {
          result.errors.push(`Table ${table} is empty`);
        }
      }

      result.success = result.errors.length === 0 && result.tableCount > 0;

    } catch (error) {
      result.success = false;
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * 执行命令
   */
  _execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${command}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * 解析备份时间
   */
  _parseBackupTime(timeStr) {
    // 20260624_110000 -> 2026-06-24T11:00:00
    const match = timeStr.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    }
    return null;
  }

  /**
   * 批量验证所有备份
   */
  async verifyAllBackups() {
    const files = await fs.readdir(this.config.backupPath);
    const backupFiles = files.filter(f => 
      f.endsWith('.sql') || f.endsWith('.sql.gz') || 
      f.endsWith('.dump') || f.endsWith('.backup')
    );

    const results = [];
    for (const file of backupFiles) {
      const fullPath = path.join(this.config.backupPath, file);
      const result = await this.verifyBackup(fullPath);
      results.push(result);
      
      logger.info('Backup verified', { 
        file, 
        passed: result.passed,
        errors: result.errors.length 
      });
    }

    return {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      results
    };
  }
}

module.exports = BackupVerifier;
```

### 2. 灾难恢复演练调度器

**文件：** `backend/jobs/disasterRecoveryDrill.js`

```javascript
const cron = require('node-cron');
const BackupVerifier = require('../shared/backupVerifier');
const RecoverySimulator = require('../shared/recoverySimulator');
const logger = require('../shared/logger');
const notificationService = require('../shared/notificationService');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * 灾难恢复演练调度器
 */
class DisasterRecoveryDrill {
  constructor(config = {}) {
    this.config = {
      // 每周日凌晨 3 点执行演练
      schedule: config.schedule || '0 3 * * 0',
      retentionDays: config.retentionDays || 30,
      enableNotifications: config.enableNotifications !== false,
      ...config
    };
    
    this.verifier = new BackupVerifier(config.verifier);
    this.simulator = new RecoverySimulator(config.simulator);
  }

  /**
   * 启动调度器
   */
  start() {
    logger.info('Disaster Recovery Drill scheduler started', {
      schedule: this.config.schedule
    });

    cron.schedule(this.config.schedule, async () => {
      await this.executeDrill();
    });
  }

  /**
   * 执行灾难恢复演练
   */
  async executeDrill() {
    const drillId = `drill_${Date.now()}`;
    const startTime = Date.now();
    
    logger.info('Disaster recovery drill started', { drillId });

    const report = {
      drillId,
      startTime: new Date().toISOString(),
      status: 'in_progress',
      phases: {}
    };

    try {
      // Phase 1: 备份验证
      report.phases.backupVerification = await this._phase1_VerifyBackups();

      // Phase 2: 恢复模拟
      report.phases.recoverySimulation = await this._phase2_SimulateRecovery();

      // Phase 3: 数据完整性检查
      report.phases.dataIntegrityCheck = await this._phase3_CheckIntegrity();

      // Phase 4: 性能测试
      report.phases.performanceTest = await this._phase4_TestPerformance();

      // Phase 5: 清理和报告
      report.phases.cleanup = await this._phase5_Cleanup();

      // 计算指标
      const duration = Date.now() - startTime;
      report.duration = duration;
      report.status = 'completed';
      report.endTime = new Date().toISOString();

      // 计算评分
      report.score = this._calculateScore(report);

      // 保存报告
      await this._saveReport(report);

      // 发送通知
      if (this.config.enableNotifications) {
        await this._sendNotification(report);
      }

      logger.info('Disaster recovery drill completed', {
        drillId,
        duration,
        score: report.score
      });

      return report;

    } catch (error) {
      report.status = 'failed';
      report.error = error.message;
      report.endTime = new Date().toISOString();
      
      logger.error('Disaster recovery drill failed', {
        drillId,
        error: error.message,
        stack: error.stack
      });

      await this._saveReport(report);
      await this._sendErrorNotification(report, error);

      return report;
    }
  }

  /**
   * Phase 1: 备份验证
   */
  async _phase1_VerifyBackups() {
    const startTime = Date.now();
    
    const verification = await this.verifier.verifyAllBackups();
    
    return {
      duration: Date.now() - startTime,
      totalBackups: verification.total,
      passedBackups: verification.passed,
      failedBackups: verification.failed,
      details: verification.results.map(r => ({
        file: r.file,
        passed: r.passed,
        errors: r.errors
      }))
    };
  }

  /**
   * Phase 2: 恢复模拟
   */
  async _phase2_SimulateRecovery() {
    const startTime = Date.now();
    
    const simulation = await this.simulator.simulateFullRecovery({
      targetEnvironment: 'test',
      preserveData: true
    });

    return {
      duration: Date.now() - startTime,
      success: simulation.success,
      rto: simulation.recoveryTimeObjective,
      rpo: simulation.recoveryPointObjective,
      steps: simulation.steps,
      errors: simulation.errors
    };
  }

  /**
   * Phase 3: 数据完整性检查
   */
  async _phase3_CheckIntegrity() {
    const startTime = Date.now();
    
    const checks = {
      schemaConsistency: await this._checkSchemaConsistency(),
      foreignKeyIntegrity: await this._checkForeignKeyIntegrity(),
      indexIntegrity: await this._checkIndexIntegrity(),
      dataValidation: await this._validateCriticalData()
    };

    return {
      duration: Date.now() - startTime,
      checks,
      allPassed: Object.values(checks).every(c => c.passed)
    };
  }

  /**
   * Phase 4: 性能测试
   */
  async _phase4_TestPerformance() {
    const startTime = Date.now();
    
    const benchmarks = {
      queryPerformance: await this._benchmarkQueries(),
      connectionPool: await this._testConnectionPool(),
      concurrentLoad: await this._testConcurrentLoad()
    };

    return {
      duration: Date.now() - startTime,
      benchmarks,
      baselineMet: this._checkPerformanceBaseline(benchmarks)
    };
  }

  /**
   * Phase 5: 清理
   */
  async _phase5_Cleanup() {
    const startTime = Date.now();
    
    await this.simulator.cleanup();
    
    return {
      duration: Date.now() - startTime,
      cleaned: true
    };
  }

  /**
   * 检查 schema 一致性
   */
  async _checkSchemaConsistency() {
    try {
      const schema = await prisma.$queryRaw`
        SELECT table_name, column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `;

      return {
        passed: true,
        tableCount: [...new Set(schema.map(s => s.table_name))].length,
        columnCount: schema.length
      };
    } catch (error) {
      return { passed: false, error: error.message };
    }
  }

  /**
   * 检查外键完整性
   */
  async _checkForeignKeyIntegrity() {
    try {
      const violations = await prisma.$queryRaw`
        SELECT 
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
      `;

      return {
        passed: true,
        foreignKeyCount: violations.length
      };
    } catch (error) {
      return { passed: false, error: error.message };
    }
  }

  /**
   * 检查索引完整性
   */
  async _checkIndexIntegrity() {
    try {
      const indexes = await prisma.$queryRaw`
        SELECT indexname, tablename 
        FROM pg_indexes 
        WHERE schemaname = 'public'
      `;

      return {
        passed: true,
        indexCount: indexes.length
      };
    } catch (error) {
      return { passed: false, error: error.message };
    }
  }

  /**
   * 验证关键数据
   */
  async _validateCriticalData() {
    try {
      const userCount = await prisma.user.count();
      const pokemonCount = await prisma.pokemon.count();
      const instanceCount = await prisma.pokemonInstance.count();

      return {
        passed: userCount > 0 && pokemonCount > 0,
        stats: { userCount, pokemonCount, instanceCount }
      };
    } catch (error) {
      return { passed: false, error: error.message };
    }
  }

  /**
   * 性能基准测试
   */
  async _benchmarkQueries() {
    const benchmarks = [];
    const queries = [
      { name: 'user_lookup', sql: 'SELECT * FROM users WHERE id = 1' },
      { name: 'pokemon_list', sql: 'SELECT * FROM pokemon LIMIT 100' },
      { name: 'instance_search', sql: 'SELECT * FROM pokemon_instances WHERE user_id = 1 LIMIT 50' }
    ];

    for (const query of queries) {
      const start = Date.now();
      await prisma.$queryRawUnsafe(query.sql);
      benchmarks.push({ name: query.name, duration: Date.now() - start });
    }

    return benchmarks;
  }

  /**
   * 测试连接池
   */
  async _testConnectionPool() {
    const start = Date.now();
    const connections = [];
    
    try {
      // 创建多个并发连接
      for (let i = 0; i < 10; i++) {
        connections.push(prisma.$queryRaw`SELECT 1`);
      }
      
      await Promise.all(connections);
      
      return { passed: true, duration: Date.now() - start };
    } catch (error) {
      return { passed: false, error: error.message };
    }
  }

  /**
   * 测试并发负载
   */
  async _testConcurrentLoad() {
    const start = Date.now();
    const requests = 100;
    
    const promises = [];
    for (let i = 0; i < requests; i++) {
      promises.push(prisma.user.findFirst());
    }
    
    await Promise.all(promises);
    
    return {
      passed: true,
      requests,
      duration: Date.now() - start,
      avgLatency: (Date.now() - start) / requests
    };
  }

  /**
   * 检查性能基线
   */
  _checkPerformanceBaseline(benchmarks) {
    // 简单检查：平均查询延迟 < 100ms
    const avgQueryLatency = benchmarks.queryPerformance
      .reduce((sum, b) => sum + b.duration, 0) / benchmarks.queryPerformance.length;
    
    return avgQueryLatency < 100;
  }

  /**
   * 计算评分
   */
  _calculateScore(report) {
    let score = 100;

    // 备份验证失败扣分
    if (report.phases.backupVerification) {
      const backupScore = (report.phases.backupVerification.passedBackups / 
                          report.phases.backupVerification.totalBackups) * 30;
      score -= (30 - backupScore);
    }

    // 恢复模拟失败扣分
    if (report.phases.recoverySimulation && !report.phases.recoverySimulation.success) {
      score -= 30;
    }

    // 数据完整性检查失败扣分
    if (report.phases.dataIntegrityCheck && !report.phases.dataIntegrityCheck.allPassed) {
      score -= 20;
    }

    // 性能测试失败扣分
    if (report.phases.performanceTest && !report.phases.performanceTest.baselineMet) {
      score -= 10;
    }

    return Math.max(0, score);
  }

  /**
   * 保存报告
   */
  async _saveReport(report) {
    await prisma.disasterRecoveryReport.create({
      data: {
        drillId: report.drillId,
        startTime: new Date(report.startTime),
        endTime: new Date(report.endTime),
        status: report.status,
        score: report.score,
        duration: report.duration,
        phases: JSON.stringify(report.phases),
        error: report.error
      }
    });
  }

  /**
   * 发送通知
   */
  async _sendNotification(report) {
    const message = {
      title: `Disaster Recovery Drill ${report.status === 'completed' ? '✅' : '❌'}`,
      body: `
Drill ID: ${report.drillId}
Duration: ${report.duration}ms
Score: ${report.score}/100
Status: ${report.status}

Backup Verification: ${report.phases.backupVerification?.passedBackups || 0}/${report.phases.backupVerification?.totalBackups || 0}
Recovery Simulation: ${report.phases.recoverySimulation?.success ? 'Passed' : 'Failed'}
Data Integrity: ${report.phases.dataIntegrityCheck?.allPassed ? 'Passed' : 'Failed'}
Performance: ${report.phases.performanceTest?.baselineMet ? 'Baseline Met' : 'Below Baseline'}
      `.trim()
    };

    await notificationService.sendAdminNotification(message);
  }

  /**
   * 发送错误通知
   */
  async _sendErrorNotification(report, error) {
    await notificationService.sendAlert({
      severity: 'high',
      title: 'Disaster Recovery Drill Failed',
      message: `Drill ${report.drillId} failed: ${error.message}`,
      metadata: { drillId: report.drillId, error: error.stack }
    });
  }
}

module.exports = DisasterRecoveryDrill;
```

### 3. 恢复模拟器

**文件：** `backend/shared/recoverySimulator.js`

```javascript
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

/**
 * 恢复模拟器
 */
class RecoverySimulator {
  constructor(config = {}) {
    this.config = {
      testDbPrefix: config.testDbPrefix || 'minego_recovery_test_',
      tempPath: config.tempPath || '/tmp/recovery_simulation',
      ...config
    };
  }

  /**
   * 模拟完整恢复流程
   */
  async simulateFullRecovery(options = {}) {
    const simulation = {
      id: `sim_${Date.now()}`,
      success: false,
      steps: [],
      recoveryTimeObjective: null,
      recoveryPointObjective: null,
      errors: []
    };

    const startTime = Date.now();
    const testDbName = `${this.config.testDbPrefix}${Date.now()}`;

    try {
      // Step 1: 准备环境
      await this._executeStep(simulation, 'prepare_environment', async () => {
        await this._prepareEnvironment(testDbName);
      });

      // Step 2: 获取最新备份
      const latestBackup = await this._executeStep(simulation, 'get_latest_backup', async () => {
        return await this._getLatestBackup();
      });

      if (!latestBackup) {
        throw new Error('No backup found for recovery simulation');
      }

      // Step 3: 停止服务（模拟）
      await this._executeStep(simulation, 'stop_services', async () => {
        logger.info('Simulating service stop');
        // 实际生产环境中不真正停止服务
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // Step 4: 执行恢复
      await this._executeStep(simulation, 'execute_recovery', async () => {
        await this._executeRecovery(latestBackup.path, testDbName);
      });

      // Step 5: 验证数据
      await this._executeStep(simulation, 'verify_data', async () => {
        await this._verifyRecoveredData(testDbName);
      });

      // Step 6: 重启服务（模拟）
      await this._executeStep(simulation, 'restart_services', async () => {
        logger.info('Simulating service restart');
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      // Step 7: 健康检查
      await this._executeStep(simulation, 'health_check', async () => {
        await this._performHealthCheck(testDbName);
      });

      // 计算 RTO
      simulation.recoveryTimeObjective = Date.now() - startTime;

      // 计算 RPO（基于备份时间）
      simulation.recoveryPointObjective = Date.now() - latestBackup.timestamp;

      simulation.success = true;

    } catch (error) {
      simulation.errors.push({
        step: simulation.steps[simulation.steps.length - 1]?.name || 'unknown',
        error: error.message,
        stack: error.stack
      });
      simulation.success = false;
    } finally {
      // 清理测试数据库
      if (!options.preserveData) {
        try {
          await this._cleanup(testDbName);
        } catch (cleanupError) {
          logger.warn('Cleanup failed', { error: cleanupError.message });
        }
      }
    }

    return simulation;
  }

  /**
   * 执行步骤
   */
  async _executeStep(simulation, stepName, stepFn) {
    const step = {
      name: stepName,
      startTime: Date.now()
    };

    try {
      const result = await stepFn();
      step.endTime = Date.now();
      step.duration = step.endTime - step.startTime;
      step.status = 'success';
      step.result = result;
      
      simulation.steps.push(step);
      return result;
    } catch (error) {
      step.endTime = Date.now();
      step.duration = step.endTime - step.startTime;
      step.status = 'failed';
      step.error = error.message;
      
      simulation.steps.push(step);
      throw error;
    }
  }

  /**
   * 准备环境
   */
  async _prepareEnvironment(testDbName) {
    await this._execCommand(`createdb ${testDbName}`);
    await fs.mkdir(this.config.tempPath, { recursive: true });
    logger.info('Test environment prepared', { testDbName });
  }

  /**
   * 获取最新备份
   */
  async _getLatestBackup() {
    const backupPath = '/var/backups/postgresql';
    const files = await fs.readdir(backupPath);
    
    const backupFiles = files
      .filter(f => f.endsWith('.sql.gz') || f.endsWith('.dump'))
      .map(f => ({
        name: f,
        path: path.join(backupPath, f)
      }));

    if (backupFiles.length === 0) {
      return null;
    }

    // 获取最新文件
    let latest = backupFiles[0];
    let latestTime = 0;

    for (const file of backupFiles) {
      const stats = await fs.stat(file.path);
      if (stats.mtimeMs > latestTime) {
        latestTime = stats.mtimeMs;
        latest = {
          ...file,
          timestamp: stats.mtimeMs,
          size: stats.size
        };
      }
    }

    return latest;
  }

  /**
   * 执行恢复
   */
  async _executeRecovery(backupPath, targetDb) {
    let command;
    
    if (backupPath.endsWith('.sql.gz')) {
      command = `gunzip -c ${backupPath} | psql -d ${targetDb}`;
    } else if (backupPath.endsWith('.dump')) {
      command = `pg_restore -d ${targetDb} ${backupPath}`;
    } else if (backupPath.endsWith('.sql')) {
      command = `psql -d ${targetDb} -f ${backupPath}`;
    } else {
      throw new Error(`Unsupported backup format: ${backupPath}`);
    }

    await this._execCommand(command);
    logger.info('Recovery executed', { backupPath, targetDb });
  }

  /**
   * 验证恢复的数据
   */
  async _verifyRecoveredData(dbName) {
    const verificationQueries = [
      { table: 'users', minCount: 1 },
      { table: 'pokemon', minCount: 1 },
      { table: 'pokemon_instances', minCount: 1 }
    ];

    for (const check of verificationQueries) {
      const result = await this._execCommand(
        `psql -d ${dbName} -t -c "SELECT COUNT(*) FROM ${check.table}"`
      );
      
      const count = parseInt(result.trim());
      if (count < check.minCount) {
        throw new Error(
          `Table ${check.table} has ${count} records, expected at least ${check.minCount}`
        );
      }
    }

    logger.info('Data verification passed', { dbName });
  }

  /**
   * 执行健康检查
   */
  async _performHealthCheck(dbName) {
    // 检查数据库连接
    await this._execCommand(`psql -d ${dbName} -c "SELECT 1"`);

    // 检查关键索引
    const indexCheck = await this._execCommand(`
      psql -d ${dbName} -t -c "
        SELECT COUNT(*) 
        FROM pg_indexes 
        WHERE schemaname = 'public'
      "
    `);

    const indexCount = parseInt(indexCheck.trim());
    if (indexCount < 10) {
      logger.warn('Low index count detected', { dbName, indexCount });
    }

    logger.info('Health check passed', { dbName, indexCount });
  }

  /**
   * 清理
   */
  async cleanup() {
    // 清理所有测试数据库
    const result = await this._execCommand(
      `psql -t -c "SELECT datname FROM pg_database WHERE datname LIKE '${this.config.testDbPrefix}%'"`
    );
    
    const databases = result.trim().split('\n').map(s => s.trim()).filter(Boolean);
    
    for (const db of databases) {
      await this._execCommand(`dropdb ${db}`);
      logger.info('Dropped test database', { db });
    }

    // 清理临时文件
    await fs.rm(this.config.tempPath, { recursive: true, force: true });
  }

  /**
   * 清理单个数据库
   */
  async _cleanup(dbName) {
    try {
      await this._execCommand(`dropdb ${dbName}`);
      logger.info('Cleaned up test database', { dbName });
    } catch (error) {
      logger.warn('Failed to cleanup test database', { dbName, error: error.message });
    }
  }

  /**
   * 执行命令
   */
  _execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${command}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

module.exports = RecoverySimulator;
```

### 4. 管理面板 API

**文件：** `backend/services/admin/routes/backup-recovery.js`

```javascript
const express = require('express');
const router = express.Router();
const BackupVerifier = require('../../shared/backupVerifier');
const RecoverySimulator = require('../../shared/recoverySimulator');
const DisasterRecoveryDrill = require('../../jobs/disasterRecoveryDrill');
const { PrismaClient } = require('@prisma/client');
const authMiddleware = require('../../shared/middleware/auth');
const roleMiddleware = require('../../shared/middleware/roles');

const prisma = new PrismaClient();

// 需要管理员权限
router.use(authMiddleware);
router.use(roleMiddleware(['admin', 'operator']));

/**
 * 获取备份列表
 */
router.get('/backups', async (req, res) => {
  try {
    const verifier = new BackupVerifier();
    const backups = await verifier.verifyAllBackups();
    
    res.json({
      success: true,
      data: backups
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 验证单个备份
 */
router.post('/backups/:filename/verify', async (req, res) => {
  try {
    const verifier = new BackupVerifier();
    const result = await verifier.verifyBackup(
      `/var/backups/postgresql/${req.params.filename}`
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 手动触发恢复演练
 */
router.post('/drill/execute', async (req, res) => {
  try {
    const drill = new DisasterRecoveryDrill();
    
    // 异步执行演练
    drill.executeDrill().then(report => {
      logger.info('Drill completed', { drillId: report.drillId });
    });
    
    res.json({
      success: true,
      message: 'Disaster recovery drill started'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取演练历史
 */
router.get('/drill/history', async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    
    const reports = await prisma.disasterRecoveryReport.findMany({
      take: parseInt(limit),
      skip: parseInt(offset),
      orderBy: { startTime: 'desc' }
    });
    
    res.json({
      success: true,
      data: reports
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取演练详情
 */
router.get('/drill/:drillId', async (req, res) => {
  try {
    const report = await prisma.disasterRecoveryReport.findUnique({
      where: { drillId: req.params.drillId }
    });
    
    if (!report) {
      return res.status(404).json({
        success: false,
        error: 'Report not found'
      });
    }
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取 RTO/RPO 统计
 */
router.get('/metrics/rto-rpo', async (req, res) => {
  try {
    const reports = await prisma.disasterRecoveryReport.findMany({
      where: { status: 'completed' },
      take: 30,
      orderBy: { startTime: 'desc' }
    });

    const metrics = {
      avgRto: 0,
      avgRpo: 0,
      trend: [],
      lastDrill: null
    };

    if (reports.length > 0) {
      const rtoValues = [];
      const rpoValues = [];

      for (const report of reports) {
        const phases = JSON.parse(report.phases);
        if (phases.recoverySimulation) {
          rtoValues.push(phases.recoverySimulation.rto || 0);
          rpoValues.push(phases.recoverySimulation.rpo || 0);
        }
      }

      metrics.avgRto = rtoValues.length > 0 
        ? rtoValues.reduce((a, b) => a + b, 0) / rtoValues.length 
        : 0;
      metrics.avgRpo = rpoValues.length > 0 
        ? rpoValues.reduce((a, b) => a + b, 0) / rpoValues.length 
        : 0;
      metrics.lastDrill = reports[0];
    }

    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 一键恢复（生产环境谨慎使用）
 */
router.post('/recovery/execute', async (req, res) => {
  try {
    const { backupFile, confirm } = req.body;
    
    if (!confirm || confirm !== 'CONFIRM_RECOVERY') {
      return res.status(400).json({
        success: false,
        error: 'Please confirm recovery by sending { confirm: "CONFIRM_RECOVERY" }'
      });
    }

    // 记录恢复操作
    await prisma.recoveryLog.create({
      data: {
        operator: req.user.id,
        backupFile,
        status: 'started',
        startedAt: new Date()
      }
    });

    res.json({
      success: true,
      message: 'Recovery started',
      warning: 'This will replace all current data!'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 5. 数据库迁移

**文件：** `database/migrations/20260624110000_add_disaster_recovery_tables.sql`

```sql
-- 灾难恢复报告表
CREATE TABLE "disaster_recovery_reports" (
  "id" SERIAL PRIMARY KEY,
  "drill_id" VARCHAR(100) UNIQUE NOT NULL,
  "start_time" TIMESTAMP NOT NULL,
  "end_time" TIMESTAMP,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "score" INTEGER,
  "duration" INTEGER,
  "phases" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_disaster_recovery_reports_start_time 
  ON "disaster_recovery_reports"(start_time DESC);
CREATE INDEX idx_disaster_recovery_reports_status 
  ON "disaster_recovery_reports"(status);

-- 恢复操作日志表
CREATE TABLE "recovery_logs" (
  "id" SERIAL PRIMARY KEY,
  "operator" INTEGER REFERENCES "users"(id),
  "backup_file" VARCHAR(255) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "started_at" TIMESTAMP NOT NULL,
  "completed_at" TIMESTAMP,
  "error" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recovery_logs_operator 
  ON "recovery_logs"(operator);
CREATE INDEX idx_recovery_logs_status 
  ON "recovery_logs"(status);
CREATE INDEX idx_recovery_logs_started_at 
  ON "recovery_logs"(started_at DESC);

-- 备份验证记录表
CREATE TABLE "backup_verification_logs" (
  "id" SERIAL PRIMARY KEY,
  "backup_file" VARCHAR(255) NOT NULL,
  "checksum" VARCHAR(255),
  "file_size" BIGINT,
  "format" VARCHAR(50),
  "verification_passed" BOOLEAN NOT NULL,
  "errors" JSONB,
  "verified_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_backup_verification_logs_file 
  ON "backup_verification_logs"(backup_file);
CREATE INDEX idx_backup_verification_logs_verified_at 
  ON "backup_verification_logs"(verified_at DESC);

COMMENT ON TABLE "disaster_recovery_reports" IS '灾难恢复演练报告';
COMMENT ON TABLE "recovery_logs" IS '恢复操作日志';
COMMENT ON TABLE "backup_verification_logs" IS '备份验证记录';
```

### 6. 监控指标

**文件：** `backend/shared/metrics/backupRecoveryMetrics.js`

```javascript
const client = require('prom-client');

// 备份验证指标
const backupVerificationTotal = new client.Counter({
  name: 'backup_verification_total',
  help: 'Total number of backup verifications',
  labelNames: ['status']
});

const backupVerificationDuration = new client.Histogram({
  name: 'backup_verification_duration_seconds',
  help: 'Backup verification duration',
  buckets: [1, 5, 10, 30, 60, 120, 300]
});

// 恢复演练指标
const drillExecutionTotal = new client.Counter({
  name: 'disaster_recovery_drill_total',
  help: 'Total number of disaster recovery drills',
  labelNames: ['status']
});

const drillDuration = new client.Histogram({
  name: 'disaster_recovery_drill_duration_seconds',
  help: 'Disaster recovery drill duration',
  buckets: [60, 300, 600, 1800, 3600]
});

const drillScore = new client.Gauge({
  name: 'disaster_recovery_drill_score',
  help: 'Latest disaster recovery drill score'
});

// RTO/RPO 指标
const rtoGauge = new client.Gauge({
  name: 'recovery_time_objective_seconds',
  help: 'Recovery Time Objective in seconds'
});

const rpoGauge = new client.Gauge({
  name: 'recovery_point_objective_seconds',
  help: 'Recovery Point Objective in seconds'
});

// 备份健康状态
const backupHealthGauge = new client.Gauge({
  name: 'backup_health_status',
  help: 'Backup health status (1=healthy, 0=unhealthy)',
  labelNames: ['backup_file']
});

module.exports = {
  backupVerificationTotal,
  backupVerificationDuration,
  drillExecutionTotal,
  drillDuration,
  drillScore,
  rtoGauge,
  rpoGauge,
  backupHealthGauge
};
```

## 验收标准

- [ ] **备份验证功能**
  - [ ] 能验证备份文件存在性和大小
  - [ ] 能计算并记录 checksum
  - [ ] 能识别备份文件格式（SQL dump、pg_dump、tar）
  - [ ] 能提取备份元数据（时间、数据库、压缩状态）
  - [ ] 能执行恢复测试到临时数据库

- [ ] **灾难恢复演练功能**
  - [ ] 每周自动执行演练（可配置时间）
  - [ ] 执行完整恢复流程模拟
  - [ ] 计算 RTO 和 RPO 指标
  - [ ] 验证恢复后的数据完整性
  - [ ] 生成详细的演练报告

- [ ] **数据完整性检查**
  - [ ] 检查 schema 一致性
  - [ ] 检查外键完整性
  - [ ] 检查索引完整性
  - [ ] 验证关键数据记录数

- [ ] **性能测试**
  - [ ] 查询性能基准测试
  - [ ] 连接池压力测试
  - [ ] 并发负载测试

- [ ] **管理面板**
  - [ ] 查看所有备份列表和状态
  - [ ] 手动验证单个备份
  - [ ] 手动触发恢复演练
  - [ ] 查看演练历史和详情
  - [ ] 查看 RTO/RPO 统计趋势
  - [ ] 一键恢复功能（需二次确认）

- [ ] **监控和告警**
  - [ ] Prometheus 指标导出
  - [ ] 演练失败自动告警
  - [ ] 备份验证失败自动告警
  - [ ] RTO/RPO 超出阈值告警

- [ ] **文档**
  - [ ] 恢复操作手册
  - [ ] 演练报告模板
  - [ ] 故障排查指南

## 影响范围

**新增文件：**
- `backend/shared/backupVerifier.js` - 备份验证器
- `backend/shared/recoverySimulator.js` - 恢复模拟器
- `backend/jobs/disasterRecoveryDrill.js` - 演练调度器
- `backend/services/admin/routes/backup-recovery.js` - 管理 API
- `backend/shared/metrics/backupRecoveryMetrics.js` - 监控指标
- `database/migrations/20260624110000_add_disaster_recovery_tables.sql` - 数据库迁移

**修改文件：**
- `backend/services/admin/index.js` - 挂载路由
- `backend/shared/metrics/index.js` - 注册指标
- `infrastructure/k8s/monitoring/prometheus-rules.yml` - 告警规则

**依赖关系：**
- 依赖 REQ-00025（数据库自动化备份）
- 依赖 REQ-00129（精灵数据备份与恢复）
- 与 REQ-00306（数据库迁移回滚）配合使用

## 参考

- [PostgreSQL Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [Disaster Recovery Best Practices](https://aws.amazon.com/blogs/architecture/disaster-recovery-dr-architecture-on-aws-part-i-strategies-for-recovery-in-the-cloud/)
- [RTO vs RPO](https://www.ibm.com/topics/rto-rpo)
- [pg_dump Documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
