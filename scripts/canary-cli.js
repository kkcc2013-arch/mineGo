#!/usr/bin/env node
/**
 * 金丝雀发布管理命令行工具
 * 
 * 用法：
 *   node scripts/canary-cli.js create <service> <canary-version> <stable-version>
 *   node scripts/canary-cli.js list
 *   node scripts/canary-cli.js status <deployment-id>
 *   node scripts/canary-cli.js promote <deployment-id>
 *   node scripts/canary-cli.js rollback <deployment-id> <reason>
 *   node scripts/canary-cli.js traffic <deployment-id> <percentage>
 */

const axios = require('axios');
const chalk = require('chalk');
const Table = require('cli-table3');

const API_BASE = process.env.CANARY_API_URL || 'http://localhost:8080/api/canary';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// 配置 axios
const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Authorization': `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

/**
 * 创建金丝雀发布
 */
async function create(serviceName, canaryVersion, stableVersion, options = {}) {
  try {
    console.log(chalk.cyan('🐤 Creating canary deployment...'));
    console.log(chalk.gray(`  Service: ${serviceName}`));
    console.log(chalk.gray(`  Canary: ${canaryVersion}`));
    console.log(chalk.gray(`  Stable: ${stableVersion}`));
    console.log(chalk.gray(`  Initial traffic: ${options.initialTraffic || 5}%`));
    console.log(chalk.gray(`  Strategy: ${options.strategy || 'progressive'}`));
    
    const response = await api.post('/deployments', {
      serviceName,
      canaryVersion,
      stableVersion,
      strategy: options.strategy || 'progressive',
      initialTraffic: options.initialTraffic || 5,
      autoPromote: options.autoPromote !== 'false'
    });
    
    if (response.data.success) {
      const deployment = response.data.deployment;
      console.log(chalk.green('\n✅ Canary deployment created successfully!'));
      console.log(chalk.yellow(`  ID: ${deployment.id}`));
      console.log(chalk.yellow(`  Status: ${deployment.status}`));
      console.log(chalk.yellow(`  Traffic: ${deployment.traffic_split}%`));
    } else {
      console.log(chalk.red('❌ Failed to create deployment:', response.data.error));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 列出所有金丝雀发布
 */
async function list(status = null) {
  try {
    console.log(chalk.cyan('\n🐤 Canary Deployments\n'));
    
    const params = status ? { status } : {};
    const response = await api.get('/deployments', { params });
    
    if (!response.data.success) {
      console.log(chalk.red('❌ Failed:', response.data.error));
      return;
    }
    
    const deployments = response.data.deployments;
    
    if (deployments.length === 0) {
      console.log(chalk.gray('No canary deployments found.'));
      return;
    }
    
    const table = new Table({
      head: ['ID', 'Service', 'Canary', 'Stable', 'Traffic', 'Strategy', 'Status', 'Started'],
      style: { head: ['cyan'] }
    });
    
    for (const d of deployments) {
      const statusColor = 
        d.status === 'active' ? chalk.green :
        d.status === 'promoting' ? chalk.yellow :
        d.status === 'completed' ? chalk.blue :
        d.status === 'rolled_back' ? chalk.red :
        chalk.gray;
      
      table.push([
        d.id,
        d.service_name,
        d.canary_version,
        d.stable_version,
        d.traffic_split + '%',
        d.strategy,
        statusColor(d.status),
        new Date(d.started_at).toLocaleString()
      ]);
    }
    
    console.log(table.toString());
    console.log(chalk.gray(`\nTotal: ${deployments.length} deployments`));
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 查看部署详情
 */
async function status(deploymentId) {
  try {
    console.log(chalk.cyan(`\n🐤 Canary Deployment #${deploymentId}\n`));
    
    const response = await api.get(`/deployments/${deploymentId}`);
    
    if (!response.data.success) {
      console.log(chalk.red('❌ Failed:', response.data.error));
      return;
    }
    
    const { deployment, metrics, history } = response.data;
    
    // 基本信息
    console.log(chalk.bold('Basic Information:'));
    console.log(chalk.gray(`  Service: ${deployment.service_name}`));
    console.log(chalk.gray(`  Canary Version: ${deployment.canary_version}`));
    console.log(chalk.gray(`  Stable Version: ${deployment.stable_version}`));
    console.log(chalk.gray(`  Traffic Split: ${deployment.traffic_split}%`));
    console.log(chalk.gray(`  Strategy: ${deployment.strategy}`));
    console.log(chalk.gray(`  Status: ${deployment.status}`));
    console.log(chalk.gray(`  Auto Promote: ${deployment.auto_promote}`));
    console.log(chalk.gray(`  Started: ${new Date(deployment.started_at).toLocaleString()}`));
    
    // 指标
    console.log(chalk.bold('\nCurrent Metrics:'));
    console.log(chalk.gray(`  Error Rate: ${(metrics.errorRate * 100).toFixed(2)}%`));
    console.log(chalk.gray(`  Latency P95: ${metrics.latencyP95}ms`));
    console.log(chalk.gray(`  Success Rate: ${(metrics.successRate * 100).toFixed(2)}%`));
    
    // 最近历史
    if (history && history.length > 0) {
      console.log(chalk.bold('\nRecent History:'));
      for (const h of history.slice(0, 5)) {
        console.log(chalk.gray(`  [${new Date(h.created_at).toLocaleString()}] ${h.action}`));
      }
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 推进金丝雀发布
 */
async function promote(deploymentId) {
  try {
    console.log(chalk.cyan(`\n🐤 Promoting canary deployment #${deploymentId}...\n`));
    
    const response = await api.post(`/deployments/${deploymentId}/promote`);
    
    if (response.data.success) {
      console.log(chalk.green('✅ Successfully promoted!'));
      console.log(chalk.yellow(`  Status: ${response.data.status}`));
      console.log(chalk.yellow(`  New Traffic: ${response.data.newTraffic}%`));
    } else {
      console.log(chalk.red('❌ Failed:', response.data.error));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 回滚金丝雀发布
 */
async function rollback(deploymentId, reason) {
  try {
    console.log(chalk.cyan(`\n🐤 Rolling back canary deployment #${deploymentId}...\n`));
    console.log(chalk.gray(`  Reason: ${reason || 'Manual rollback'}`));
    
    const response = await api.post(`/deployments/${deploymentId}/rollback`, {
      reason: reason || 'Manual rollback'
    });
    
    if (response.data.success) {
      console.log(chalk.green('✅ Successfully rolled back!'));
      console.log(chalk.yellow(`  Status: ${response.data.status}`));
    } else {
      console.log(chalk.red('❌ Failed:', response.data.error));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 调整流量百分比
 */
async function traffic(deploymentId, percentage) {
  try {
    console.log(chalk.cyan(`\n🐤 Adjusting traffic for #${deploymentId}...\n`));
    console.log(chalk.gray(`  New Traffic: ${percentage}%`));
    
    const response = await api.put(`/deployments/${deploymentId}/traffic`, {
      traffic: parseInt(percentage),
      reason: 'Manual adjustment'
    });
    
    if (response.data.success) {
      console.log(chalk.green('✅ Traffic adjusted successfully!'));
      console.log(chalk.yellow(`  Old: ${response.data.oldTraffic}% → New: ${response.data.newTraffic}%`));
    } else {
      console.log(chalk.red('❌ Failed:', response.data.error));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 验证指标
 */
async function validate(deploymentId) {
  try {
    console.log(chalk.cyan(`\n🐤 Validating metrics for #${deploymentId}...\n`));
    
    const response = await api.post(`/deployments/${deploymentId}/validate`);
    
    if (response.data.valid) {
      console.log(chalk.green('✅ Metrics are valid!'));
      console.log(chalk.yellow('  Metrics:'));
      console.log(chalk.gray(`    Error Rate: ${(response.data.metrics.errorRate * 100).toFixed(2)}%`));
      console.log(chalk.gray(`    Latency P95: ${response.data.metrics.latencyP95}ms`));
      console.log(chalk.gray(`    Success Rate: ${(response.data.metrics.successRate * 100).toFixed(2)}%`));
    } else {
      console.log(chalk.red('❌ Metrics validation failed!'));
      console.log(chalk.yellow(`  Reason: ${response.data.reason}`));
    }
  } catch (error) {
    console.log(chalk.red('❌ Error:', error.response?.data?.error || error.message));
  }
}

/**
 * 主函数
 */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  
  const commands = {
    create: () => {
      const [service, canary, stable] = args;
      const options = {
        initialTraffic: process.env.INITIAL_TRAFFIC || 5,
        strategy: process.env.STRATEGY || 'progressive',
        autoPromote: process.env.AUTO_PROMOTE || 'true'
      };
      create(service, canary, stable, options);
    },
    list: () => list(args[0]),
    status: () => status(args[0]),
    promote: () => promote(args[0]),
    rollback: () => rollback(args[0], args[1]),
    traffic: () => traffic(args[0], args[1]),
    validate: () => validate(args[0]),
    help: () => {
      console.log(chalk.cyan('\n🐤 Canary CLI - Canary Deployment Manager\n'));
      console.log('Usage:');
      console.log(chalk.gray('  create <service> <canary-version> <stable-version>  - Create new deployment'));
      console.log(chalk.gray('  list [status]                                      - List deployments'));
      console.log(chalk.gray('  status <id>                                        - Show deployment details'));
      console.log(chalk.gray('  promote <id>                                       - Promote to next stage'));
      console.log(chalk.gray('  rollback <id> [reason]                             - Rollback deployment'));
      console.log(chalk.gray('  traffic <id> <percentage>                          - Adjust traffic'));
      console.log(chalk.gray('  validate <id>                                      - Validate metrics'));
      console.log(chalk.gray('  help                                               - Show this help'));
      console.log('\nEnvironment:');
      console.log(chalk.gray('  CANARY_API_URL  - API endpoint (default: http://localhost:8080/api/canary)'));
      console.log(chalk.gray('  ADMIN_TOKEN     - Authorization token'));
      console.log(chalk.gray('  INITIAL_TRAFFIC - Initial traffic percentage (default: 5)'));
      console.log(chalk.gray('  STRATEGY        - Deployment strategy (default: progressive)'));
      console.log(chalk.gray('  AUTO_PROMOTE    - Auto promote enabled (default: true)'));
    }
  };
  
  if (!command || !commands[command]) {
    commands.help();
    return;
  }
  
  await commands[command]();
}

main().catch(console.error);