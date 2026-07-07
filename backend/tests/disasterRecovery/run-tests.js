// backend/tests/disasterRecovery/run-tests.js
// 灾备模块测试运行脚本

const Mocha = require('mocha');
const path = require('path');
const fs = require('fs');

// 创建 Mocha 实例
const mocha = new Mocha({
  timeout: 15000,
  reporter: 'spec',
  bail: false,
  retries: 1
});

// 获取测试目录
const testDir = __dirname;

// 添加所有测试文件
const testFiles = fs.readdirSync(testDir)
  .filter(file => file.endsWith('.test.js') && file !== 'run-tests.js')
  .map(file => path.join(testDir, file));

console.log(`\n📋 灾备模块单元测试覆盖`);
console.log(`   测试文件数：${testFiles.length}`);
console.log(`   测试目录：${testDir}\n`);

testFiles.forEach(file => {
  mocha.addFile(file);
  console.log(`   ✅ ${path.basename(file)}`);
});

// 运行测试
mocha.run(failures => {
  process.exitCode = failures ? 1 : 0;
  
  if (failures) {
    console.log(`\n❌ ${failures} 个测试失败`);
  } else {
    console.log(`\n✅ 所有测试通过！`);
  }
}).on('test end', test => {
  if (test.state === 'passed') {
    console.log(`     ✓ ${test.fullTitle()}`);
  } else if (test.state === 'failed') {
    console.log(`     ✗ ${test.fullTitle()}`);
    console.log(`       ${test.err.message}`);
  }
}).on('end', () => {
  console.log('\n📊 测试统计');
  console.log(`   总测试数：${mocha.stats.tests}`);
  console.log(`   通过：${mocha.stats.passes}`);
  console.log(`   失败：${mocha.stats.failures}`);
  console.log(`   耗时：${mocha.stats.duration}ms`);
});