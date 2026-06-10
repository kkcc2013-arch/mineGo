#!/usr/bin/env node
'use strict';
/**
 * Contract Test Runner Script
 * 运行契约测试的主脚本
 */

const path = require('path');
const ContractTestRunner = require('./ContractTestRunner');
const ContractReportGenerator = require('./ContractReportGenerator');
const ContractRegistry = require('../../shared/contract/ContractRegistry');

// 加载所有服务契约
const userContract = require('../../services/user-service/contracts/user.contract');
const pokemonContract = require('../../services/pokemon-service/contracts/pokemon.contract');
const socialContract = require('../../services/social-service/contracts/social.contract');

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
  const reportDir = path.join(__dirname, 'reports');

  console.log('='.repeat(60));
  console.log('API Contract Tests');
  console.log('='.repeat(60));
  console.log(`Base URL: ${baseUrl}`);
  console.log('');

  // 创建测试运行器
  const runner = new ContractTestRunner({
    baseUrl,
    timeout: 30000
  });

  // 注册所有契约
  runner.registerContract(userContract);
  runner.registerContract(pokemonContract);
  runner.registerContract(socialContract);

  try {
    // 运行所有测试
    const results = await runner.runAll();

    // 生成报告
    const generator = new ContractReportGenerator();
    
    // 创建报告目录
    const fs = require('fs');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    // 生成各种格式报告
    await generator.generateMarkdownReport(
      results,
      path.join(reportDir, 'contract-test-report.md')
    );

    await generator.generateHtmlReport(
      results,
      path.join(reportDir, 'contract-test-report.html')
    );

    await generator.generateJUnitReport(
      results,
      path.join(reportDir, 'junit-contract-tests.xml')
    );

    // 输出结果
    console.log('\n' + '='.repeat(60));
    console.log('Reports generated:');
    console.log(`  - ${path.join(reportDir, 'contract-test-report.md')}`);
    console.log(`  - ${path.join(reportDir, 'contract-test-report.html')}`);
    console.log(`  - ${path.join(reportDir, 'junit-contract-tests.xml')}`);
    console.log('='.repeat(60));

    // 退出码
    process.exit(results.failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('Contract test execution failed:', error.message);
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = main;
