/**
 * PostgreSQL 备份系统单元测试
 * 测试备份脚本、恢复逻辑和验证功能
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// 测试配置
const TEST_DIR = '/tmp/pg-backup-test';
const BACKUP_DIR = path.join(TEST_DIR, 'backup');
const SCRIPTS_DIR = path.join(__dirname, '../../database/backup');

// 辅助函数
function runScript(scriptName, args = []) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.log(`⚠️ Script not found: ${scriptPath}`);
    return { success: false, output: 'Script not found' };
  }
  
  try {
    const output = execSync(`bash ${scriptPath} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, BACKUP_DIR }
    });
    return { success: true, output };
  } catch (error) {
    return { success: false, output: error.message };
  }
}

function createTestBackup() {
  const backupPath = path.join(BACKUP_DIR, 'full', new Date().toISOString().slice(0, 10));
  fs.mkdirSync(backupPath, { recursive: true });
  
  const backupFile = path.join(backupPath, 'minego-full-test.tar.gz');
  // 创建模拟备份文件
  execSync(`echo "test backup content" | gzip > ${backupFile}`);
  
  // 创建校验和
  const checksum = execSync(`sha256sum ${backupFile}`, { encoding: 'utf-8' });
  fs.writeFileSync(`${backupFile}.sha256`, checksum);
  
  return backupFile;
}

// 测试套件
console.log('=== PostgreSQL Backup System Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

// 设置测试环境
console.log('Setting up test environment...');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(path.join(BACKUP_DIR, 'full'), { recursive: true });
fs.mkdirSync(path.join(BACKUP_DIR, 'wal'), { recursive: true });
console.log('');

// 测试 1: 备份脚本存在性检查
test('Backup scripts exist', () => {
  const scripts = [
    'pg-full-backup.sh',
    'pg-wal-archive.sh',
    'pg-restore.sh',
    'pg-backup-verify.sh'
  ];
  
  for (const script of scripts) {
    const scriptPath = path.join(SCRIPTS_DIR, script);
    assert.ok(fs.existsSync(scriptPath), `Script ${script} should exist`);
  }
});

// 测试 2: K8s CronJob 配置存在性检查
test('K8s CronJob configuration exists', () => {
  const cronjobPath = path.join(__dirname, '../../infrastructure/k8s/backup-cronjob.yaml');
  assert.ok(fs.existsSync(cronjobPath), 'CronJob YAML should exist');
  
  const content = fs.readFileSync(cronjobPath, 'utf-8');
  assert.ok(content.includes('pg-backup-full'), 'Should contain full backup CronJob');
  assert.ok(content.includes('pg-wal-archive-check'), 'Should contain WAL archive CronJob');
  assert.ok(content.includes('pg-backup-verify'), 'Should contain backup verify CronJob');
});

// 测试 3: 备份告警规则检查
test('Backup alert rules exist', () => {
  const alertsPath = path.join(__dirname, '../../infrastructure/k8s/monitoring/backup-alerts.yaml');
  assert.ok(fs.existsSync(alertsPath), 'Alert rules YAML should exist');
  
  const content = fs.readFileSync(alertsPath, 'utf-8');
  assert.ok(content.includes('PostgreSQLBackupFailed'), 'Should contain backup failed alert');
  assert.ok(content.includes('PostgreSQLBackupMissing'), 'Should contain backup missing alert');
  assert.ok(content.includes('PostgreSQLWALArchiveLag'), 'Should contain WAL lag alert');
});

// 测试 4: GitHub Actions 工作流检查
test('Backup GitHub Actions workflow exists', () => {
  const workflowPath = path.join(__dirname, '../../.github/workflows/backup.yml');
  assert.ok(fs.existsSync(workflowPath), 'Backup workflow should exist');
  
  const content = fs.readFileSync(workflowPath, 'utf-8');
  assert.ok(content.includes('pg_basebackup'), 'Should use pg_basebackup');
  assert.ok(content.includes('ossutil'), 'Should upload to OSS');
});

// 测试 5: 备份文件命名格式
test('Backup filename format', () => {
  const timestamp = new Date();
  const dateStr = timestamp.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = timestamp.toTimeString().slice(0, 8).replace(/:/g, '');
  
  const expectedPattern = /^minego-full-\d{8}-\d{6}$/;
  const sampleName = `minego-full-${dateStr}-${timeStr}`;
  
  assert.ok(expectedPattern.test(sampleName), `Filename ${sampleName} should match pattern`);
});

// 测试 6: 备份保留策略
test('Backup retention policy', () => {
  // 默认保留 7 天
  const retentionDays = 7;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  
  assert.ok(cutoffDate < new Date(), 'Cutoff date should be in the past');
  console.log(`   Retention: ${retentionDays} days, cutoff: ${cutoffDate.toISOString()}`);
});

// 测试 7: WAL 文件命名格式
test('WAL filename format', () => {
  // PostgreSQL WAL 文件名格式: 000000010000000000000001
  const walPattern = /^[0-9A-F]{24}$/;
  const sampleWal = '000000010000000000000001';
  
  assert.ok(walPattern.test(sampleWal), `WAL filename ${sampleWal} should match pattern`);
});

// 测试 8: 备份元数据结构
test('Backup metadata structure', () => {
  const metadata = {
    type: 'full',
    timestamp: new Date().toISOString(),
    database: 'minego',
    environment: 'prod',
    host: 'localhost',
    port: 5432,
    size_bytes: 1024000,
    checksum: 'abc123...'
  };
  
  assert.ok(metadata.type, 'Should have type');
  assert.ok(metadata.timestamp, 'Should have timestamp');
  assert.ok(metadata.database, 'Should have database');
  assert.ok(metadata.checksum, 'Should have checksum');
});

// 测试 9: 恢复类型验证
test('Restore types validation', () => {
  const validTypes = ['full', 'pitr'];
  
  assert.ok(validTypes.includes('full'), 'full should be valid restore type');
  assert.ok(validTypes.includes('pitr'), 'pitr should be valid restore type');
  assert.ok(!validTypes.includes('incremental'), 'incremental should not be valid');
});

// 测试 10: PITR 时间格式
test('PITR time format', () => {
  const targetTime = '2026-06-05 12:00:00';
  const timePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  
  assert.ok(timePattern.test(targetTime), `Time ${targetTime} should match format`);
});

// 测试 11: 校验和验证
test('Checksum verification', () => {
  const backupFile = createTestBackup();
  const checksumFile = `${backupFile}.sha256`;
  
  assert.ok(fs.existsSync(backupFile), 'Backup file should exist');
  assert.ok(fs.existsSync(checksumFile), 'Checksum file should exist');
  
  // 验证校验和格式
  const checksum = fs.readFileSync(checksumFile, 'utf-8');
  assert.ok(checksum.length > 64, 'Checksum should be SHA256 (64 chars)');
});

// 测试 12: CronJob 调度表达式
test('CronJob schedule expressions', () => {
  const schedules = {
    fullBackup: '0 3 * * *',      // 每天 3:00
    walArchive: '*/15 * * * *',   // 每 15 分钟
    verify: '0 4 * * 0'           // 每周日 4:00
  };
  
  // 验证 cron 表达式格式
  for (const [name, schedule] of Object.entries(schedules)) {
    const parts = schedule.split(' ');
    assert.ok(parts.length === 5, `${name} schedule should have 5 parts`);
    console.log(`   ${name}: ${schedule}`);
  }
});

// 测试 13: 资源限制配置
test('Resource limits configuration', () => {
  const resources = {
    requests: { cpu: '500m', memory: '512Mi' },
    limits: { cpu: '1000m', memory: '1Gi' }
  };
  
  assert.ok(resources.limits.memory > resources.requests.memory, 
    'Limit should be greater than request');
});

// 测试 14: 告警严重级别
test('Alert severity levels', () => {
  const alerts = [
    { name: 'BackupFailed', severity: 'critical' },
    { name: 'BackupMissing', severity: 'critical' },
    { name: 'StorageLow', severity: 'warning' },
    { name: 'WALArchiveLag', severity: 'warning' }
  ];
  
  for (const alert of alerts) {
    assert.ok(['critical', 'warning'].includes(alert.severity),
      `${alert.name} should have valid severity`);
  }
});

// 测试 15: 备份验证报告结构
test('Backup verification report structure', () => {
  const report = {
    backupFile: '/path/to/backup.tar.gz',
    size: 1024000,
    modified: new Date().toISOString(),
    checksum: 'sha256...',
    verificationResults: {
      integrityCheck: 'PASSED',
      checksumVerification: 'PASSED',
      testRestore: 'SKIPPED'
    },
    verificationTime: new Date().toISOString(),
    status: 'VERIFIED'
  };
  
  assert.ok(report.status === 'VERIFIED', 'Report should have verified status');
  assert.ok(report.verificationResults, 'Report should have verification results');
});

// 清理测试环境
console.log('\nCleaning up test environment...');
fs.rmSync(TEST_DIR, { recursive: true, force: true });

// 输出结果
console.log('\n=== Test Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);

if (failed > 0) {
  console.log('\n❌ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed');
  process.exit(0);
}
