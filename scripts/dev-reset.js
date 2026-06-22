#!/usr/bin/env node
/**
 * mineGo 开发环境快速重置脚本
 * REQ-00282: 开发者环境一键初始化与智能诊断系统
 * 
 * 用法: node scripts/dev-reset.js [--full] [--db] [--deps] [--docker] [--yes]
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  step: (current, total, msg) => console.log(`[${current}/${total}] ${msg}`)
};

// 项目根目录
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * 执行命令
 */
function execCommand(cmd, options = {}) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit',
      cwd: options.cwd || ROOT_DIR
    });
    return { success: true, output: output?.trim() || '' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 询问确认
 */
function askConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

/**
 * 停止服务
 */
async function stopServices() {
  log.info('停止 Docker 服务...');
  execCommand('docker compose down', { silent: true });
  log.success('服务已停止');
}

/**
 * 清理 Docker
 */
async function cleanDocker() {
  log.info('清理 Docker 容器和卷...');
  
  // 停止所有容器
  execCommand('docker compose down -v --remove-orphans', { silent: true });
  
  // 清理悬空资源
  execCommand('docker system prune -f', { silent: true });
  
  log.success('Docker 清理完成');
}

/**
 * 清理依赖
 */
async function cleanDependencies() {
  log.info('清理 node_modules...');
  
  const dirs = [
    path.join(ROOT_DIR, 'node_modules'),
    path.join(ROOT_DIR, 'backend', 'node_modules'),
    path.join(ROOT_DIR, 'frontend', 'node_modules')
  ];

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log.success(`已删除: ${path.relative(ROOT_DIR, dir)}`);
    }
  }

  // 清理 lock 文件
  const lockFiles = [
    path.join(ROOT_DIR, 'package-lock.json'),
    path.join(ROOT_DIR, 'backend', 'package-lock.json')
  ];

  for (const file of lockFiles) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

/**
 * 清理数据库
 */
async function cleanDatabase() {
  log.info('清理数据库...');
  
  // Docker 卷已在 cleanDocker 中清理
  // 本地数据库文件
  const dbFiles = [
    path.join(ROOT_DIR, 'data', 'postgres'),
    path.join(ROOT_DIR, 'data', 'redis')
  ];

  for (const file of dbFiles) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { recursive: true, force: true });
    }
  }

  log.success('数据库清理完成');
}

/**
 * 重置环境配置
 */
async function resetEnvFile() {
  log.info('重置环境配置...');
  
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) {
    // 备份
    const backupPath = path.join(ROOT_DIR, '.env.backup');
    fs.copyFileSync(envPath, backupPath);
    log.success('已备份 .env 到 .env.backup');
    
    // 删除
    fs.unlinkSync(envPath);
    log.success('.env 已删除');
  }
}

/**
 * 清理日志
 */
async function cleanLogs() {
  log.info('清理日志文件...');
  
  const logDir = path.join(ROOT_DIR, 'logs');
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir);
    for (const file of files) {
      if (file.endsWith('.log')) {
        fs.unlinkSync(path.join(logDir, file));
      }
    }
  }
  
  // 清理 setup.log
  const setupLog = path.join(ROOT_DIR, 'setup.log');
  if (fs.existsSync(setupLog)) {
    fs.unlinkSync(setupLog);
  }

  log.success('日志清理完成');
}

/**
 * 仅重置数据库
 */
async function resetDatabaseOnly() {
  log.info('重置数据库...');
  
  // 停止数据库
  execCommand('docker compose stop postgres redis kafka', { silent: true });
  
  // 删除卷
  execCommand('docker compose down -v postgres redis kafka', { silent: true });
  
  // 重新启动
  execCommand('docker compose up -d postgres redis kafka');
  
  log.success('数据库已重置');
  log.info('请运行: npm run migrate:up && npm run seed');
}

/**
 * 仅重置依赖
 */
async function resetDepsOnly() {
  await cleanDependencies();
  log.info('重新安装依赖...');
  execCommand('npm install', { cwd: path.join(ROOT_DIR, 'backend') });
  log.success('依赖重置完成');
}

/**
 * 仅重置 Docker
 */
async function resetDockerOnly() {
  await stopServices();
  await cleanDocker();
  execCommand('docker compose up -d postgres redis kafka');
  log.success('Docker 服务已重启');
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const dbOnly = args.includes('--db');
  const depsOnly = args.includes('--deps');
  const dockerOnly = args.includes('--docker');
  const skipConfirm = args.includes('--yes') || args.includes('-y');

  console.log(`${colors.cyan}🔄 mineGo 开发环境重置${colors.reset}\n`);

  // 确定模式
  const mode = full ? 'full' : dbOnly ? 'db' : depsOnly ? 'deps' : dockerOnly ? 'docker' : 'full';

  if (mode === 'full') {
    console.log(`${colors.yellow}⚠️  警告: 此操作将删除所有开发数据！${colors.reset}\n`);
    console.log('将删除：');
    console.log('  - 数据库所有表和数据');
    console.log('  - Docker 卷（postgres、redis、kafka 数据）');
    console.log('  - node_modules 目录');
    console.log('  - 本地日志文件');
    console.log('  - .env 配置文件（备份到 .env.backup）\n');

    if (!skipConfirm) {
      const confirmed = await askConfirm('是否继续？(yes/no): ');
      if (!confirmed) {
        console.log('已取消');
        process.exit(0);
      }
    }

    const steps = [
      { name: '停止服务', fn: stopServices },
      { name: '清理 Docker', fn: cleanDocker },
      { name: '清理依赖', fn: cleanDependencies },
      { name: '清理数据库', fn: cleanDatabase },
      { name: '重置配置', fn: resetEnvFile },
      { name: '清理日志', fn: cleanLogs }
    ];

    for (let i = 0; i < steps.length; i++) {
      log.step(i + 1, steps.length, steps[i].name);
      await steps[i].fn();
    }

    console.log(`\n${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.green}✓ 环境已重置${colors.reset}`);
    console.log(`\n请运行: ${colors.cyan}npm run setup${colors.reset}`);

  } else if (mode === 'db') {
    console.log('模式: 仅重置数据库\n');
    await resetDatabaseOnly();

  } else if (mode === 'deps') {
    console.log('模式: 仅重置依赖\n');
    await resetDepsOnly();

  } else if (mode === 'docker') {
    console.log('模式: 仅重置 Docker\n');
    await resetDockerOnly();
  }
}

main().catch(error => {
  log.error(error.message);
  process.exit(1);
});
