#!/usr/bin/env node
/**
 * 部署健康验证脚本入口
 * 
 * @module infrastructure/health/verify-deployment
 */

'use strict';

const DeploymentHealthVerifier = require('./DeploymentHealthVerifier');
const AutoRollbackTrigger = require('./AutoRollbackTrigger');
const fs = require('fs');
const path = require('path');

/**
 * 解析命令行参数
 * @returns {Object}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  
  const params = {
    deploymentId: `deploy-${Date.now()}`,
    environment: 'production',
    timeout: 30,
    dryRun: false,
    output: 'verification-result.json'
  };
  
  for (const arg of args) {
    if (arg.startsWith('--deployment-id=')) {
      params.deploymentId = arg.split('=')[1];
    } else if (arg.startsWith('--environment=')) {
      params.environment = arg.split('=')[1];
    } else if (arg.startsWith('--timeout=')) {
      params.timeout = parseInt(arg.split('=')[1]) || 30;
    } else if (arg.startsWith('--output=')) {
      params.output = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      params.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node verify-deployment.js [options]

Options:
  --deployment-id=<id>    Deployment ID (default: deploy-<timestamp>)
  --environment=<env>     Target environment (default: production)
  --timeout=<seconds>     Verification timeout (default: 30)
  --output=<file>         Output file (default: verification-result.json)
  --dry-run               Run in dry-run mode (no actual rollback)
  --help, -h              Show this help message
`);
      process.exit(0);
    }
  }
  
  return params;
}

/**
 * 主函数
 */
async function main() {
  const params = parseArgs();
  
  console.log('========================================');
  console.log('Deployment Health Verification');
  console.log('========================================');
  console.log(`Deployment ID: ${params.deploymentId}`);
  console.log(`Environment: ${params.environment}`);
  console.log(`Timeout: ${params.timeout}s`);
  console.log(`Dry Run: ${params.dryRun}`);
  console.log('========================================');
  console.log('');
  
  const startTime = Date.now();

  try {
    // 1. 创建验证器
    const verifier = new DeploymentHealthVerifier({
      timeout: params.timeout * 1000,
      services: [
        'gateway', 'user-service', 'location-service', 
        'pokemon-service', 'catch-service', 'gym-service',
        'social-service', 'reward-service', 'payment-service'
      ]
    });

    // 2. 执行验证
    console.log('[verify-deployment] Starting health verification...');
    const result = await verifier.verify({
      id: params.deploymentId,
      environment: params.environment
    });

    // 3. 输出验证报告
    const report = verifier.generateReport(result);
    console.log('');
    console.log(report);

    // 4. 写入结果文件
    const outputPath = path.resolve(params.output);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log('');
    console.log(`[verify-deployment] Result saved to: ${outputPath}`);

    // 5. 如果需要回滚，触发回滚流程
    if (result.rollbackRequired && !params.dryRun) {
      console.log('');
      console.log('[verify-deployment] ⚠️ Rollback required! Triggering automatic rollback...');
      
      const rollbackTrigger = new AutoRollbackTrigger({
        namespace: params.environment
      });
      
      const rollbackResult = await rollbackTrigger.trigger(result);
      console.log('');
      console.log('[verify-deployment] Rollback result:', JSON.stringify(rollbackResult, null, 2));
      
      // 更新结果文件
      result.rollbackResult = rollbackResult;
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    } else if (result.rollbackRequired && params.dryRun) {
      console.log('');
      console.log('[verify-deployment] [DRY RUN] Would trigger rollback, but skipped');
    }

    // 6. 输出最终状态
    const totalDuration = Date.now() - startTime;
    console.log('');
    console.log('========================================');
    console.log(`Verification completed in ${totalDuration}ms`);
    console.log(`Overall Status: ${result.overallSuccess ? '✅ PASSED' : '❌ FAILED'}`);
    console.log('========================================');

    // 7. 设置输出（供 GitHub Actions 使用）
    if (process.env.GITHUB_OUTPUT) {
      const outputLines = [
        `success=${result.overallSuccess}`,
        `rollback_required=${result.rollbackRequired}`,
        `issues_count=${result.issues.length}`,
        `duration=${result.duration}`
      ];
      fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines.join('\n') + '\n');
    }

    // 8. 设置退出码
    process.exit(result.overallSuccess ? 0 : 1);
    
  } catch (error) {
    console.error('[verify-deployment] Error:', error.message);
    console.error(error.stack);
    
    // 写入错误结果
    const errorResult = {
      deploymentId: params.deploymentId,
      environment: params.environment,
      overallSuccess: false,
      error: error.message,
      timestamp: Date.now(),
      duration: Date.now() - startTime
    };
    
    fs.writeFileSync(params.output, JSON.stringify(errorResult, null, 2));
    
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'success=false\nrollback_required=true\n');
    }
    
    process.exit(1);
  }
}

// 运行
main();