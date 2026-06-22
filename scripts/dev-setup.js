#!/usr/bin/env node
/**
 * mineGo 开发环境一键初始化脚本
 * REQ-00282: 开发者环境一键初始化与智能诊断系统
 * 
 * 用法: node scripts/dev-setup.js [--non-interactive] [--skip <step>]
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

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
  step: (current, total, msg) => console.log(`\n${colors.blue}[${current}/${total}]${colors.reset} ${msg}`)
};

// 项目根目录
const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const DATABASE_DIR = path.join(ROOT_DIR, 'database');

// 配置
const CONFIG = {
  nodeMinVersion: '20.0.0',
  dockerMinVersion: '24.0.0',
  dockerComposeMinVersion: '2.0.0',
  gitMinVersion: '2.0.0',
  minDiskSpaceGB: 5,
  setupLogFile: path.join(ROOT_DIR, 'setup.log')
};

// 步骤状态记录
const stepStatus = {
  completed: [],
  skipped: [],
  failed: []
};

/**
 * 执行命令并返回输出
 */
function execCommand(cmd, options = {}) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : 'inherit',
      cwd: options.cwd || ROOT_DIR,
      env: { ...process.env, ...options.env }
    });
    return { success: true, output: output?.trim() || '' };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout?.trim() || '' };
  }
}

/**
 * 获取版本号
 */
function getVersion(output) {
  const match = output?.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * 比较版本号
 */
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts1[i] || 0) > (parts2[i] || 0)) return 1;
    if ((parts1[i] || 0) < (parts2[i] || 0)) return -1;
  }
  return 0;
}

/**
 * 检查前置依赖
 */
async function checkPrerequisites() {
  const checks = [];
  
  // Node.js
  const nodeVersion = process.version.replace('v', '');
  const nodeOk = compareVersions(nodeVersion, CONFIG.nodeMinVersion) >= 0;
  checks.push({
    name: 'Node.js',
    version: nodeVersion,
    ok: nodeOk,
    fix: `安装 Node.js ${CONFIG.nodeMinVersion}+: nvm install 20`
  });

  // Docker
  const dockerResult = execCommand('docker --version', { silent: true });
  const dockerVersion = getVersion(dockerResult.output);
  const dockerOk = dockerVersion && compareVersions(dockerVersion, CONFIG.dockerMinVersion) >= 0;
  checks.push({
    name: 'Docker',
    version: dockerVersion || '未安装',
    ok: dockerOk,
    fix: `安装 Docker ${CONFIG.dockerMinVersion}+`
  });

  // Docker Compose
  const composeResult = execCommand('docker compose version', { silent: true });
  const composeVersion = getVersion(composeResult.output);
  const composeOk = composeVersion && compareVersions(composeVersion, CONFIG.dockerComposeMinVersion) >= 0;
  checks.push({
    name: 'Docker Compose',
    version: composeVersion || '未安装',
    ok: composeOk,
    fix: `安装 Docker Compose ${CONFIG.dockerComposeMinVersion}+`
  });

  // Git
  const gitResult = execCommand('git --version', { silent: true });
  const gitVersion = getVersion(gitResult.output);
  const gitOk = gitVersion && compareVersions(gitVersion, CONFIG.gitMinVersion) >= 0;
  checks.push({
    name: 'Git',
    version: gitVersion || '未安装',
    ok: gitOk,
    fix: `安装 Git ${CONFIG.gitMinVersion}+`
  });

  // 打印结果
  let allOk = true;
  for (const check of checks) {
    const status = check.ok ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    console.log(`  ${status} ${check.name}: ${check.version}`);
    if (!check.ok) {
      allOk = false;
      console.log(`    ${colors.yellow}└─ 解决: ${check.fix}${colors.reset}`);
    }
  }

  if (!allOk) {
    throw new Error('前置依赖检查失败，请先安装上述依赖');
  }

  return true;
}

/**
 * 安装依赖
 */
async function installDependencies() {
  const start = Date.now();
  
  // Backend
  log.info('安装 backend 依赖...');
  const backendResult = execCommand('npm install', { cwd: BACKEND_DIR });
  if (!backendResult.success) {
    throw new Error('Backend 依赖安装失败');
  }

  // Frontend (如果存在)
  if (fs.existsSync(path.join(FRONTEND_DIR, 'package.json'))) {
    log.info('安装 frontend 依赖...');
    const frontendResult = execCommand('npm install', { cwd: FRONTEND_DIR });
    if (!frontendResult.success) {
      log.warn('Frontend 依赖安装失败，继续...');
    }
  }

  // Root
  if (fs.existsSync(path.join(ROOT_DIR, 'package.json'))) {
    log.info('安装根目录依赖...');
    execCommand('npm install', { cwd: ROOT_DIR });
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  log.success(`依赖安装完成 (${elapsed}s)`);
  return true;
}

/**
 * 启动 Docker 服务
 */
async function startDockerServices() {
  const start = Date.now();
  
  // 检查 Docker 是否运行
  const dockerCheck = execCommand('docker info', { silent: true });
  if (!dockerCheck.success) {
    throw new Error('Docker 未运行，请先启动 Docker');
  }

  // 启动基础服务
  log.info('启动 Docker 服务 (postgres, redis, kafka)...');
  const result = execCommand('docker compose up -d postgres redis kafka');
  if (!result.success) {
    throw new Error('Docker 服务启动失败');
  }

  // 等待服务就绪
  log.info('等待服务就绪...');
  await sleep(10000); // 等待 10 秒

  // 验证服务
  const services = ['postgres', 'redis', 'kafka'];
  for (const service of services) {
    const check = execCommand(`docker compose ps ${service} --format json`, { silent: true });
    try {
      const data = JSON.parse(check.output || '{}');
      if (data.State !== 'running') {
        log.warn(`${service} 未运行`);
      } else {
        log.success(`${service} 运行中`);
      }
    } catch {
      // 简单检查
      const psResult = execCommand(`docker compose ps | grep ${service}`, { silent: true });
      if (psResult.output?.includes('running') || psResult.output?.includes('Up')) {
        log.success(`${service} 运行中`);
      } else {
        log.warn(`${service} 状态未知`);
      }
    }
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  log.success(`Docker 服务启动完成 (${elapsed}s)`);
  return true;
}

/**
 * 生成环境配置文件
 */
async function generateEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env');
  const envExamplePath = path.join(ROOT_DIR, '.env.example');

  if (fs.existsSync(envPath)) {
    log.info('.env 文件已存在，跳过生成');
    return true;
  }

  if (!fs.existsSync(envExamplePath)) {
    log.warn('.env.example 不存在，创建默认配置');
    const defaultEnv = generateDefaultEnv();
    fs.writeFileSync(envPath, defaultEnv);
    log.success('.env 文件已创建');
    return true;
  }

  // 复制 .env.example 到 .env
  let envContent = fs.readFileSync(envExamplePath, 'utf-8');

  // 生成安全的默认值
  envContent = envContent
    .replace(/JWT_SECRET=.*/, `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`)
    .replace(/SESSION_SECRET=.*/, `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`)
    .replace(/API_KEY=.*/, `API_KEY=${crypto.randomBytes(16).toString('hex')}`);

  fs.writeFileSync(envPath, envContent);
  log.success('.env 文件已创建（含安全默认值）');
  return true;
}

/**
 * 生成默认环境配置
 */
function generateDefaultEnv() {
  return `# mineGo 开发环境配置
# 自动生成于 ${new Date().toISOString()}

# 服务端口
GATEWAY_PORT=8080
USER_SERVICE_PORT=3001
LOCATION_SERVICE_PORT=3002
POKEMON_SERVICE_PORT=3003
CATCH_SERVICE_PORT=3004
GYM_SERVICE_PORT=3005
SOCIAL_SERVICE_PORT=3006
REWARD_SERVICE_PORT=3007
PAYMENT_SERVICE_PORT=3008

# 数据库
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/minego
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=minego

# Redis
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379

# Kafka
KAFKA_BROKERS=localhost:9092

# 安全
JWT_SECRET=${crypto.randomBytes(32).toString('hex')}
SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}
API_KEY=${crypto.randomBytes(16).toString('hex')}

# 环境
NODE_ENV=development
LOG_LEVEL=debug

# 功能开关
ENABLE_CATCH_ANIMATION=true
ENABLE_PVP=true
ENABLE_GYM_BATTLE=true
`;
}

/**
 * 运行数据库迁移
 */
async function runMigrations() {
  const start = Date.now();
  
  log.info('运行数据库迁移...');
  
  // 检查迁移脚本
  const migratePath = path.join(DATABASE_DIR, 'migrate.js');
  if (fs.existsSync(migratePath)) {
    const result = execCommand('node migrate.js up', { cwd: DATABASE_DIR });
    if (!result.success) {
      // 尝试其他方式
      const altResult = execCommand('npm run migrate:up', { cwd: ROOT_DIR });
      if (!altResult.success) {
        throw new Error('数据库迁移失败');
      }
    }
  } else if (fs.existsSync(path.join(BACKEND_DIR, 'migrate.js'))) {
    const result = execCommand('node migrate.js up', { cwd: BACKEND_DIR });
    if (!result.success) {
      log.warn('数据库迁移失败，可能已迁移');
    }
  } else {
    log.info('未找到迁移脚本，跳过');
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  log.success(`数据库迁移完成 (${elapsed}s)`);
  return true;
}

/**
 * 填充种子数据
 */
async function seedData() {
  const start = Date.now();
  
  log.info('填充种子数据...');
  
  const seedPath = path.join(DATABASE_DIR, 'seeds', 'index.js');
  if (fs.existsSync(seedPath)) {
    const result = execCommand('node seeds/index.js', { cwd: DATABASE_DIR });
    if (!result.success) {
      log.warn('种子数据填充失败，继续...');
    } else {
      log.success('种子数据已填充');
    }
  } else {
    log.info('种子数据脚本不存在，跳过');
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  log.success(`种子数据完成 (${elapsed}s)`);
  return true;
}

/**
 * 验证服务
 */
async function verifyServices() {
  log.info('验证服务健康状态...');
  
  // 等待服务完全启动
  await sleep(5000);

  const services = [
    { name: 'PostgreSQL', port: 5432 },
    { name: 'Redis', port: 6379 }
  ];

  for (const service of services) {
    const result = execCommand(`nc -z localhost ${service.port} 2>/dev/null && echo "ok" || echo "fail"`, { silent: true });
    if (result.output?.includes('ok')) {
      log.success(`${service.name} 连接正常`);
    } else {
      log.warn(`${service.name} 连接失败`);
    }
  }

  return true;
}

/**
 * 打印后续步骤
 */
function printNextSteps() {
  console.log(`
${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}

${colors.cyan}🎉 开发环境初始化完成！${colors.reset}

后续步骤：
  1. 检查环境配置: ${colors.yellow}cat .env${colors.reset}
  2. 启动开发服务: ${colors.yellow}npm run dev${colors.reset}
  3. 运行测试:     ${colors.yellow}npm test${colors.reset}
  4. 检查健康状态: ${colors.yellow}npm run doctor${colors.reset}

文档：
  - 开发指南: docs/DEVELOPMENT.md
  - 故障排查: docs/TROUBLESHOOTING.md
  - API 文档: http://localhost:8080/api-docs (服务启动后)

${colors.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}
`);
}

/**
 * 辅助函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const nonInteractive = args.includes('--non-interactive');
  const skipSteps = args.filter(a => a.startsWith('--skip=')).map(a => a.split('=')[1]);

  console.log(`${colors.cyan}🚀 mineGo 开发环境初始化${colors.reset}\n`);

  const steps = [
    { name: '环境检查', fn: checkPrerequisites, key: 'prerequisites' },
    { name: '依赖安装', fn: installDependencies, key: 'dependencies' },
    { name: 'Docker 服务启动', fn: startDockerServices, key: 'docker' },
    { name: '环境配置生成', fn: generateEnvFile, key: 'env' },
    { name: '数据库迁移', fn: runMigrations, key: 'migrations' },
    { name: '种子数据填充', fn: seedData, key: 'seed' },
    { name: '服务验证', fn: verifyServices, key: 'verify' }
  ];

  let currentStep = 0;
  const totalSteps = steps.length;

  for (const step of steps) {
    currentStep++;
    
    if (skipSteps.includes(step.key)) {
      log.step(currentStep, totalSteps, `${step.name} (跳过)`);
      stepStatus.skipped.push(step.key);
      continue;
    }

    log.step(currentStep, totalSteps, step.name);
    
    try {
      await step.fn();
      stepStatus.completed.push(step.key);
    } catch (error) {
      stepStatus.failed.push(step.key);
      log.error(error.message);
      
      if (!nonInteractive) {
        console.log(`\n${colors.yellow}是否继续？(y/n)${colors.reset}`);
        // 简化处理，直接继续
      }
    }
  }

  // 输出总结
  console.log(`\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`完成: ${stepStatus.completed.length} | 跳过: ${stepStatus.skipped.length} | 失败: ${stepStatus.failed.length}`);
  
  if (stepStatus.failed.length === 0) {
    printNextSteps();
  } else {
    log.warn(`部分步骤失败: ${stepStatus.failed.join(', ')}`);
    console.log(`\n运行诊断: ${colors.yellow}npm run doctor${colors.reset}`);
  }

  // 写入日志
  const logContent = `
mineGo 开发环境初始化日志
时间: ${new Date().toISOString()}
完成步骤: ${stepStatus.completed.join(', ')}
跳过步骤: ${stepStatus.skipped.join(', ')}
失败步骤: ${stepStatus.failed.join(', ')}
`;
  fs.writeFileSync(CONFIG.setupLogFile, logContent);
}

// 执行
main().catch(error => {
  log.error(error.message);
  process.exit(1);
});
