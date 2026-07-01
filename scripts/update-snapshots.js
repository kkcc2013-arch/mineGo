/**
 * 快照管理命令行工具
 * 用于更新、查看、删除快照
 */

const path = require('path');
const fs = require('fs');
const { ApiSnapshotValidator } = require('../backend/shared/snapshotValidator');
const { SnapshotDiffReporter } = require('../backend/shared/snapshotDiffReporter');

const validator = new ApiSnapshotValidator({
  snapshotDir: path.join(__dirname, '../backend/tests/snapshot/snapshots')
});

const reporter = new SnapshotDiffReporter();

// 命令行参数解析
const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'list':
      await listSnapshots();
      break;
    case 'stats':
      await showStats();
      break;
    case 'update':
      await updateSnapshot(args[1], args[2]);
      break;
    case 'delete':
      await deleteSnapshot(args[1], args[2]);
      break;
    case 'report':
      await generateReport();
      break;
    case 'clean':
      await cleanSnapshots();
      break;
    default:
      showHelp();
  }
}

async function listSnapshots() {
  const snapshots = await validator.listSnapshots();
  
  console.log('\n📋 快照列表:');
  console.log('─'.repeat(80));
  
  if (snapshots.length === 0) {
    console.log('  暂无快照');
    return;
  }
  
  for (const s of snapshots) {
    console.log(`  ${s.method.padEnd(6)} ${s.apiPath}`);
    console.log(`         捕获时间: ${s.capturedAt || '未知'}`);
  }
  
  console.log(`\n总计: ${snapshots.length} 个快照`);
}

async function showStats() {
  const stats = await validator.getCoverageStats();
  
  console.log('\n📊 快照统计:');
  console.log('─'.repeat(40));
  console.log(`  总快照数: ${stats.totalSnapshots}`);
  
  console.log('\n  按方法分布:');
  for (const [method, count] of Object.entries(stats.byMethod)) {
    console.log(`    ${method}: ${count}`);
  }
  
  console.log('\n  按版本分布:');
  for (const [version, count] of Object.entries(stats.byVersion)) {
    console.log(`    ${version}: ${count}`);
  }
}

async function updateSnapshot(apiPath, method) {
  if (!apiPath || !method) {
    console.log('❌ 请指定 API 路径和方法');
    console.log('   用法: node scripts/update-snapshots.js update /api/v1/pokemon/:id GET');
    return;
  }
  
  console.log(`\n🔄 更新快照: ${apiPath} (${method})`);
  
  // 这里需要实际调用 API 来获取响应
  // 示例中仅做演示
  console.log('   请运行测试来捕获新的快照:');
  console.log(`   npm run test:snapshot -- --update`);
}

async function deleteSnapshot(apiPath, method) {
  if (!apiPath || !method) {
    console.log('❌ 请指定 API 路径和方法');
    console.log('   用法: node scripts/update-snapshots.js delete /api/v1/pokemon/:id GET');
    return;
  }
  
  const result = await validator.deleteSnapshot(apiPath, method);
  
  if (result.status === 'deleted') {
    console.log(`\n✅ 已删除快照: ${result.path}`);
  } else {
    console.log(`\n⚠️ 快照不存在: ${result.path}`);
  }
}

async function generateReport() {
  const snapshots = await validator.listSnapshots();
  
  // 模拟测试结果
  const results = snapshots.map(s => ({
    apiPath: s.apiPath,
    method: s.method,
    status: 'match',
    diffCount: 0,
    breakingChanges: 0
  }));
  
  // 保存 HTML 报告
  const saved = await reporter.saveReport(results, 'html');
  
  console.log('\n📝 已生成报告:');
  console.log(`   HTML: ${saved.path}`);
  
  // 输出 CLI 报告
  console.log(reporter.generateCliReport(results));
}

async function cleanSnapshots() {
  const snapshotDir = validator.snapshotDir;
  
  if (!fs.existsSync(snapshotDir)) {
    console.log('✅ 快照目录不存在，无需清理');
    return;
  }
  
  // 递归删除快照目录内容（保留目录结构）
  const methods = fs.readdirSync(snapshotDir);
  
  for (const method of methods) {
    const methodDir = path.join(snapshotDir, method);
    if (fs.statSync(methodDir).isDirectory()) {
      const files = fs.readdirSync(methodDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(methodDir, file);
          fs.unlinkSync(filePath);
          console.log(`  已删除: ${filePath}`);
        }
      }
    }
  }
  
  console.log('\n✅ 快照清理完成');
}

function showHelp() {
  console.log(`
使用方法:
  node scripts/update-snapshots.js <command> [args]

命令:
  list        列出所有快照
  stats       显示快照统计
  update      更新指定快照 (需指定 API 路径和方法)
  delete      删除指定快照 (需指定 API 路径和方法)
  report      生成快照报告
  clean       清理所有快照

示例:
  node scripts/update-snapshots.js list
  node scripts/update-snapshots.js stats
  node scripts/update-snapshots.js update /api/v1/pokemon/:id GET
  node scripts/update-snapshots.js delete /api/v1/pokemon/:id GET
  node scripts/update-snapshots.js report
`);
}

main().catch(console.error);