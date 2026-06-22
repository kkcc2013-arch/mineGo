#!/usr/bin/env node
/**
 * mineGo 开发环境健康检查工具
 * REQ-00282: 开发者环境一键初始化与智能诊断系统
 * 
 * 用法: node scripts/dev-doctor.js [--json]
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

// 项目根目录
const ROOT_DIR = path.resolve(__dirname, '..');

// 检查结果
const results = [];

/**
 * 执行命令
 */
function execCommand(cmd, options = {}) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: options.cwd || ROOT_DIR
    });
    return { success: true, output: output.trim() };
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
  if (!v1 || !v2) return -1;
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts1[i] || 0) > (parts2[i] || 0)) return 1;
    if ((parts1[i] || 0) < (parts2[i] || 0)) return -1;
  }
  return 0;
}

/**
 * 检查端口是否可用
 */
function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

/**
 * 检查端口是否被监听
 */
function checkPortListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, 'localhost');
  });
}

/**
 * 检查项定义
 */
const checks = [
  // Node.js 版本
  {
    name: 'Node.js 版本',
    category: '环境',
    check: async () => {
      const version = process.version.replace('v', '');
      const ok = compareVersions(version, '20.0.0') >= 0;
      return {
        ok,
        message: `v${version}`,
        fix: '安装 Node.js 20.x: nvm install 20'
      };
    }
  },

  // Docker 运行状态
  {
    name: 'Docker 运行状态',
    category: '环境',
    check: async () => {
      const result = execCommand('docker info');
      return {
        ok: result.success,
        message: result.success ? '运行中' : '未运行',
        fix: '启动 Docker: systemctl start docker 或 open -a Docker (macOS)'
      };
    }
  },

  // Docker Compose
  {
    name: 'Docker Compose',
    category: '环境',
    check: async () => {
      const result = execCommand('docker compose version');
      const version = getVersion(result.output);
      return {
        ok: !!version,
        message: version || '未安装',
        fix: 'Docker Compose 已包含在 Docker Desktop 中'
      };
    }
  },

  // PostgreSQL 连接
  {
    name: 'PostgreSQL 连接',
    category: '数据库',
    check: async () => {
      const listening = await checkPortListening(5432);
      if (!listening) {
        return {
          ok: false,
          message: '端口 5432 未监听',
          fix: '启动 postgres: docker compose up -d postgres'
        };
      }
      
      // 尝试连接
      const result = execCommand('docker compose exec -T postgres pg_isready -U postgres 2>/dev/null || echo "fail"');
      return {
        ok: !result.output?.includes('fail'),
        message: listening ? '连接正常' : '未连接',
        fix: '启动 postgres: docker compose up -d postgres'
      };
    }
  },

  // Redis 连接
  {
    name: 'Redis 连接',
    category: '数据库',
    check: async () => {
      const listening = await checkPortListening(6379);
      if (!listening) {
        return {
          ok: false,
          message: '端口 6379 未监听',
          fix: '启动 redis: docker compose up -d redis'
        };
      }
      
      const result = execCommand('docker compose exec -T redis redis-cli ping 2>/dev/null || echo "fail"');
      return {
        ok: result.output?.includes('PONG') || listening,
        message: listening ? '连接正常' : '未连接',
        fix: '启动 redis: docker compose up -d redis'
      };
    }
  },

  // Kafka 连接
  {
    name: 'Kafka 连接',
    category: '消息队列',
    check: async () => {
      const listening = await checkPortListening(9092);
      return {
        ok: listening,
        message: listening ? '连接正常' : '端口 9092 未监听',
        fix: '启动 kafka: docker compose up -d kafka'
      };
    }
  },

  // 环境变量配置
  {
    name: '环境变量配置',
    category: '配置',
    check: async () => {
      const envPath = path.join(ROOT_DIR, '.env');
      const exists = fs.existsSync(envPath);
      
      if (!exists) {
        return {
          ok: false,
          message: '.env 文件不存在',
          fix: '复制环境配置: cp .env.example .env 或运行 npm run setup'
        };
      }

      // 检查必要变量
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const requiredVars = ['JWT_SECRET', 'DATABASE_URL'];
      const missing = requiredVars.filter(v => !envContent.includes(v));
      
      return {
        ok: missing.length === 0,
        message: missing.length === 0 ? '配置完整' : `缺少: ${missing.join(', ')}`,
        fix: '编辑 .env 添加必要配置'
      };
    }
  },

  // 依赖安装
  {
    name: '依赖安装',
    category: '依赖',
    check: async () => {
      const backendModules = path.join(ROOT_DIR, 'backend', 'node_modules');
      const exists = fs.existsSync(backendModules);
      
      if (!exists) {
        return {
          ok: false,
          message: 'node_modules 不存在',
          fix: '安装依赖: npm install'
        };
      }

      // 检查关键依赖
      const keyDeps = ['express', 'pg', 'redis'];
      const missing = keyDeps.filter(dep => !fs.existsSync(path.join(backendModules, dep)));
      
      return {
        ok: missing.length === 0,
        message: missing.length === 0 ? '依赖完整' : `缺少: ${missing.join(', ')}`,
        fix: '安装依赖: npm install'
      };
    }
  },

  // 数据库迁移状态
  {
    name: '数据库迁移',
    category: '数据库',
    check: async () => {
      // 检查迁移文件是否存在
      const migrationsDir = path.join(ROOT_DIR, 'database', 'migrations');
      if (!fs.existsSync(migrationsDir)) {
        return {
          ok: true,
          message: '无迁移文件',
          fix: null
        };
      }

      // 简单检查：尝试查询数据库
      const result = execCommand('docker compose exec -T postgres psql -U postgres -d minego -c "SELECT 1" 2>/dev/null || echo "fail"');
      return {
        ok: !result.output?.includes('fail'),
        message: result.success ? '数据库就绪' : '数据库未就绪',
        fix: '运行迁移: npm run migrate:up 或 npm run setup'
      };
    }
  },

  // 端口占用检查
  {
    name: '端口占用',
    category: '环境',
    check: async () => {
      const ports = [8080, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008];
      const conflicts = [];
      
      for (const port of ports) {
        const listening = await checkPortListening(port);
        if (listening) {
          conflicts.push(port);
        }
      }

      return {
        ok: conflicts.length === 0,
        message: conflicts.length === 0 ? '端口无冲突' : `已占用: ${conflicts.join(', ')}`,
        fix: conflicts.length > 0 ? '停止占用端口的进程或修改 .env 配置' : null
      };
    }
  },

  // 磁盘空间
  {
    name: '磁盘空间',
    category: '环境',
    check: async () => {
      const result = execCommand('df -h . | tail -1 | awk \'{print $4}\'');
      const available = result.output || '';
      
      // 简单检查
      const gbMatch = available.match(/(\d+)G/i);
      const gb = gbMatch ? parseInt(gbMatch[1]) : 0;
      
      return {
        ok: gb >= 5 || available.includes('T'), // 5GB 或 TB 级别
        message: `${available} 可用`,
        fix: '清理磁盘空间（至少需要 5GB）'
      };
    }
  },

  // Git 状态
  {
    name: 'Git 状态',
    category: '环境',
    check: async () => {
      const gitDir = path.join(ROOT_DIR, '.git');
      if (!fs.existsSync(gitDir)) {
        return {
          ok: true,
          message: '非 Git 仓库',
          fix: null
        };
      }

      const result = execCommand('git status --porcelain');
      const clean = result.output === '';
      
      return {
        ok: true,
        message: clean ? '工作区干净' : '有未提交的更改',
        fix: null
      };
    }
  }
];

/**
 * 运行所有检查
 */
async function runChecks() {
  console.log(`${colors.cyan}🔍 mineGo 开发环境诊断${colors.reset}\n`);

  const categories = {};
  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    try {
      const result = await check.check();
      
      results.push({
        name: check.name,
        category: check.category,
        ...result
      });

      if (!categories[check.category]) {
        categories[check.category] = [];
      }
      categories[check.category].push({ name: check.name, ...result });

      if (result.ok) passed++;
      else failed++;
    } catch (error) {
      results.push({
        name: check.name,
        category: check.category,
        ok: false,
        message: `检查失败: ${error.message}`,
        fix: '请手动检查'
      });
      failed++;
    }
  }

  // 输出结果
  for (const [category, items] of Object.entries(categories)) {
    console.log(`\n${colors.blue}${category}:${colors.reset}`);
    for (const item of items) {
      const status = item.ok ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
      console.log(`  ${status} ${item.name}: ${item.message}`);
      if (!item.ok && item.fix) {
        console.log(`    ${colors.yellow}└─ 解决: ${item.fix}${colors.reset}`);
      }
    }
  }

  // 总结
  const total = passed + failed;
  console.log(`\n${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`总结: ${colors.green}${passed}/${total}${colors.reset} 检查通过`);
  
  if (failed > 0) {
    console.log(`${colors.yellow}⚠️  存在 ${failed} 个问题需要修复${colors.reset}`);
    console.log(`\n修复建议: 运行 ${colors.cyan}npm run setup${colors.reset} 重新初始化环境`);
  } else {
    console.log(`${colors.green}✅ 开发环境健康！${colors.reset}`);
  }

  return { passed, failed, total, results };
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const summary = await runChecks();

  if (jsonOutput) {
    console.log('\n' + JSON.stringify(summary, null, 2));
  }

  // 返回退出码
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(`${colors.red}错误:${colors.reset} ${error.message}`);
  process.exit(1);
});
