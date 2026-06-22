# REQ-00282: 开发者环境一键初始化与智能诊断系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00282 |
| 标题 | 开发者环境一键初始化与智能诊断系统 |
| 类别 | 文档/开发者体验 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | backend, scripts, docs |
| 创建时间 | 2026-06-22 05:00 |
| 依赖需求 | 无 |

## 1. 背景与问题

### 现状
- DEVELOPMENT.md 提供详细步骤，但需要手动执行多个命令
- 新开发者首次环境搭建平均耗时 45-90 分钟
- server-setup.sh 面向生产环境，不适合本地开发
- .env.example 仅列出配置项，无自动校验
- 故障排查依赖文档中的分散信息，查找困难

### 痛点
1. **环境准备繁琐**：需要手动执行 Docker 启动、数据库迁移、依赖安装、种子数据填充等多个步骤
2. **错误定位困难**：当环境配置失败时，缺少自动诊断工具，开发者需要逐项排查
3. **缺少健康检查**：无法一键验证开发环境是否正确配置
4. **重置成本高**：开发环境损坏后，重置需要手动清理多个组件
5. **IDE 配置缺失**：缺少 VS Code 推荐配置，开发者需要自行配置调试、lint 等工具

### 影响
- 新开发者上手时间过长，降低贡献意愿
- 开发环境问题占用大量排查时间
- 团队成员环境不一致导致的问题难以复现

## 2. 目标

实现开发者环境一键初始化与智能诊断系统，达成：

1. **首次环境搭建时间缩短至 15 分钟以内**（从 `git clone` 到可运行）
2. **提供 `npm run setup` 一键命令**完成所有环境准备工作
3. **智能诊断工具**自动检测并提示 95% 以上的环境配置问题
4. **开发环境健康检查命令**，一键验证环境完整性
5. **快速重置功能**，5 分钟内恢复干净的初始环境
6. **VS Code 工作区推荐配置**，统一团队开发环境

## 3. 范围

### 包含
- 一键环境初始化脚本 (`scripts/dev-setup.js`)
- 环境健康检查工具 (`scripts/dev-doctor.js`)
- 开发环境快速重置脚本 (`scripts/dev-reset.js`)
- 种子数据管理命令 (`npm run seed:*`)
- VS Code 工作区配置 (`.vscode/`)
- 开发环境故障排查指南 (`docs/TROUBLESHOOTING.md`)
- npm scripts 扩展

### 不包含
- CI/CD 环境配置（已有独立的 workflow）
- 生产环境部署脚本（已有 server-setup.sh）
- 云端开发环境（如 GitHub Codespaces）
- 远程开发调试配置

## 4. 详细需求

### 4.1 一键环境初始化脚本

**文件**: `scripts/dev-setup.js`

**命令**: `npm run setup` 或 `node scripts/dev-setup.js`

**执行流程**:

```javascript
// scripts/dev-setup.js

async function setup() {
  console.log('🚀 mineGo 开发环境初始化\n');
  
  // 1. 环境检查
  await checkPrerequisites();  // Node.js, Docker, Git 版本
  
  // 2. 依赖安装
  await installDependencies(); // npm install (backend + frontend)
  
  // 3. Docker 服务启动
  await startDockerServices(); // postgres, redis, kafka
  
  // 4. 环境配置生成
  await generateEnvFile();     // 从 .env.example 复制，提示必要配置
  
  // 5. 数据库初始化
  await runMigrations();       // 创建表结构
  
  // 6. 种子数据填充
  await seedData();            // 测试用户、精灵、道具等
  
  // 7. 服务启动验证
  await verifyServices();      // 检查各服务健康状态
  
  // 8. 输出后续步骤指引
  printNextSteps();
}
```

**功能要求**:

1. **前置依赖检查**：
   - Node.js >= 20.0.0
   - Docker >= 24.0.0
   - Docker Compose >= 2.0.0
   - Git >= 2.0.0
   - 可选：PostgreSQL 客户端（psql）

2. **交互式配置**：
   - 提示输入必要的配置项（如 JWT_SECRET）
   - 自动生成安全的默认值（开发环境）
   - 支持非交互模式（`--non-interactive`）

3. **幂等性保证**：
   - 可重复运行，不会重复创建数据
   - 检测已存在的配置和数据库，跳过已完成步骤

4. **进度反馈**：
   - 每个步骤显示进度和状态
   - 失败时显示详细错误和解决方案
   - 支持断点续传（记录已完成的步骤）

5. **日志记录**：
   - 生成 `setup.log` 记录完整过程
   - 失败时自动保存诊断信息

**示例输出**:

```
🚀 mineGo 开发环境初始化

[1/8] ✓ 环境检查
  Node.js: v20.11.0 ✓
  Docker: 24.0.7 ✓
  Docker Compose: v2.23.0 ✓
  Git: 2.43.0 ✓

[2/8] ✓ 依赖安装 (45s)
  backend: 245 packages installed
  frontend: 128 packages installed

[3/8] ✓ Docker 服务启动 (18s)
  postgres: running on port 5432 ✓
  redis: running on port 6379 ✓
  kafka: running on port 9092 ✓

[4/8] ✓ 环境配置生成
  .env file created with defaults

[5/8] ✓ 数据库迁移 (5s)
  42 migrations applied

[6/8] ✓ 种子数据填充 (3s)
  10 test users created
  50 pokemon spawned
  100 items added

[7/8] ✓ 服务验证
  All services healthy ✓

[8/8] 完成！
```

### 4.2 环境健康检查工具

**文件**: `scripts/dev-doctor.js`

**命令**: `npm run doctor` 或 `node scripts/dev-doctor.js`

**检查项目**:

```javascript
const CHECKS = [
  {
    name: 'Node.js 版本',
    check: () => checkNodeVersion(),
    fix: '安装 Node.js 20.x: nvm install 20'
  },
  {
    name: 'Docker 运行状态',
    check: () => checkDockerRunning(),
    fix: '启动 Docker: systemctl start docker'
  },
  {
    name: 'PostgreSQL 连接',
    check: () => checkPostgresConnection(),
    fix: '启动 postgres: docker compose up -d postgres'
  },
  {
    name: 'Redis 连接',
    check: () => checkRedisConnection(),
    fix: '启动 redis: docker compose up -d redis'
  },
  {
    name: 'Kafka 连接',
    check: () => checkKafkaConnection(),
    fix: '启动 kafka: docker compose up -d kafka'
  },
  {
    name: '数据库迁移状态',
    check: () => checkMigrations(),
    fix: '运行迁移: npm run migrate:up'
  },
  {
    name: '环境变量配置',
    check: () => checkEnvFile(),
    fix: '复制环境配置: cp .env.example .env'
  },
  {
    name: '依赖完整性',
    check: () => checkDependencies(),
    fix: '安装依赖: npm install'
  },
  {
    name: '端口占用检查',
    check: () => checkPorts(),
    fix: '释放端口或修改 .env 中的端口配置'
  },
  {
    name: '磁盘空间',
    check: () => checkDiskSpace(),
    fix: '清理磁盘空间（至少需要 5GB）'
  }
];
```

**输出格式**:

```
🔍 mineGo 开发环境诊断

环境检查：
  ✓ Node.js v20.11.0
  ✓ Docker 运行中
  ✓ PostgreSQL 连接正常
  ✓ Redis 连接正常
  ✗ Kafka 连接失败
    └─ 错误: Connection refused
    └─ 解决: docker compose up -d kafka

  ✓ 数据库迁移完整
  ✓ 环境变量已配置
  ✓ 依赖安装完整
  ✓ 端口无冲突
  ✓ 磁盘空间充足 (23GB 可用)

总结: 9/10 检查通过
⚠️  存在 1 个问题需要修复
```

### 4.3 开发环境快速重置

**文件**: `scripts/dev-reset.js`

**命令**: `npm run reset` 或 `node scripts/dev-reset.js`

**选项**:

- `--full`: 完全重置（删除所有数据、依赖、Docker 卷）
- `--db`: 仅重置数据库
- `--deps`: 仅重新安装依赖
- `--docker`: 仅重启 Docker 服务

**重置流程** (full 模式):

```javascript
async function fullReset() {
  // 1. 停止所有服务
  await stopServices();
  
  // 2. 清理 Docker 容器和卷
  await cleanDocker();
  
  // 3. 删除 node_modules
  await cleanDependencies();
  
  // 4. 删除数据库文件（如果使用本地数据库）
  await cleanDatabase();
  
  // 5. 重置环境配置
  await resetEnvFile();
  
  // 6. 提示重新运行 setup
  console.log('✓ 环境已重置，请运行: npm run setup');
}
```

**安全确认**:

```bash
$ npm run reset -- --full

⚠️  警告: 此操作将删除所有开发数据！

将删除：
  - 数据库所有表和数据
  - Docker 卷（postgres、redis、kafka 数据）
  - node_modules 目录
  - 本地日志文件

是否继续？(yes/no): yes

[1/5] 停止服务...
[2/5] 清理 Docker...
[3/5] 清理依赖...
[4/5] 清理数据库...
[5/5] 重置配置...

✓ 环境已重置
请运行: npm run setup
```

### 4.4 种子数据管理

**文件**: `database/seeds/`

**命令**:

```bash
npm run seed          # 填充所有种子数据
npm run seed:clean    # 清理种子数据
npm run seed:refresh  # 重新填充（清理+填充）
npm run seed:users    # 仅填充测试用户
npm run seed:pokemon  # 仅填充精灵数据
npm run seed:items    # 仅填充道具数据
```

**种子数据内容**:

```javascript
// database/seeds/users.js
module.exports = {
  users: [
    {
      id: 'test-user-1',
      username: 'player1',
      email: 'player1@test.com',
      password: 'hashed_password', // 默认: password123
      level: 10,
      coins: 1000,
      role: 'player'
    },
    {
      id: 'test-admin',
      username: 'admin',
      email: 'admin@test.com',
      password: 'hashed_password',
      role: 'admin'
    }
  ]
};

// database/seeds/pokemon.js
module.exports = {
  pokemon: [
    { id: 'pokemon-1', species: 'pikachu', cp: 500, lat: 39.9, lng: 116.4 },
    { id: 'pokemon-2', species: 'charmander', cp: 300, lat: 39.91, lng: 116.41 },
    // ... 50 个精灵
  ]
};
```

### 4.5 VS Code 工作区配置

**文件**: `.vscode/`

**推荐扩展** (`.vscode/extensions.json`):

```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "ms-azuretools.vscode-docker",
    "ckolkman.vscode-postgres",
    "cweijan.vscode-redis-client",
    "humao.rest-client",
    "orta.vscode-jest",
    "ms-vscode-remote.remote-containers",
    "yzhang.markdown-all-in-one",
    "bierner.markdown-mermaid"
  ]
}
```

**调试配置** (`.vscode/launch.json`):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug: Gateway",
      "program": "${workspaceFolder}/backend/gateway/src/index.js",
      "envFile": "${workspaceFolder}/.env",
      "console": "integratedTerminal"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug: Catch Service",
      "program": "${workspaceFolder}/backend/services/catch-service/src/index.js",
      "envFile": "${workspaceFolder}/.env"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug: All Tests",
      "program": "${workspaceFolder}/backend/node_modules/.bin/jest",
      "args": ["--runInBand", "--no-cache"],
      "cwd": "${workspaceFolder}/backend"
    },
    {
      "type": "node",
      "request": "attach",
      "name": "Attach: Remote Debug",
      "port": 9229,
      "remoteRoot": "/app"
    }
  ]
}
```

**任务配置** (`.vscode/tasks.json`):

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Dev: Start All Services",
      "type": "npm",
      "script": "dev",
      "problemMatcher": []
    },
    {
      "label": "Dev: Run Tests",
      "type": "npm",
      "script": "test",
      "problemMatcher": []
    },
    {
      "label": "Dev: Run Linter",
      "type": "npm",
      "script": "lint",
      "problemMatcher": []
    },
    {
      "label": "Dev: Doctor",
      "type": "shell",
      "command": "node scripts/dev-doctor.js",
      "problemMatcher": []
    }
  ]
}
```

**工作区设置** (`.vscode/settings.json`):

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "javascript.preferences.quoteStyle": "single",
  "files.associations": {
    ".env": "dotenv",
    "*.test.js": "javascript"
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/coverage": true,
    "**/.git": true
  },
  "files.watcherExclude": {
    "**/node_modules/**": true
  },
  "docker.showStartPage": false
}
```

### 4.6 故障排查指南

**文件**: `docs/TROUBLESHOOTING.md`

**内容结构**:

```markdown
# 故障排查指南

## 快速诊断

运行诊断工具：
\`\`\`bash
npm run doctor
\`\`\`

## 常见问题

### 1. Docker 相关

#### 问题：Docker 服务无法启动
**症状**：
\`\`\`
Error: Cannot connect to the Docker daemon
\`\`\`

**原因**：Docker 服务未运行

**解决方案**：
\`\`\`bash
# Linux
sudo systemctl start docker

# macOS
open -a Docker

# Windows
net start com.docker.service
\`\`\`

#### 问题：端口冲突
**症状**：
\`\`\`
Error: port is already allocated
\`\`\`

**解决方案**：
\`\`\`bash
# 查找占用端口的进程
lsof -i :5432

# 修改 .env 中的端口
POSTGRES_PORT=5433
\`\`\`

### 2. 数据库相关

#### 问题：数据库迁移失败
**症状**：
\`\`\`
Error: relation "users" does not exist
\`\`\`

**解决方案**：
\`\`\`bash
# 重置数据库
npm run reset -- --db
npm run migrate:up
\`\`\`

### 3. 依赖相关

#### 问题：npm install 失败
**症状**：
\`\`\`
npm ERR! EACCES: permission denied
\`\`\`

**解决方案**：
\`\`\`bash
# 修复 npm 权限
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /usr/local/lib/node_modules
\`\`\`

...
```

### 4.7 npm scripts 扩展

**文件**: `backend/package.json`

**新增脚本**:

```json
{
  "scripts": {
    "setup": "node ../scripts/dev-setup.js",
    "doctor": "node ../scripts/dev-doctor.js",
    "reset": "node ../scripts/dev-reset.js",
    "seed": "node ../database/seeds/index.js",
    "seed:clean": "node ../database/seeds/index.js --clean",
    "seed:refresh": "node ../database/seeds/index.js --refresh",
    "seed:users": "node ../database/seeds/users.js",
    "seed:pokemon": "node ../database/seeds/pokemon.js",
    "seed:items": "node ../database/seeds/items.js",
    "clean": "rm -rf node_modules coverage .nyc_output",
    "reinstall": "npm run clean && npm install"
  }
}
```

## 5. 验收标准（可测试）

- [ ] **环境初始化**
  - 运行 `npm run setup` 可在 15 分钟内完成所有环境准备
  - 脚本具备幂等性，可重复运行
  - 失败时显示详细错误和解决方案

- [ ] **健康检查**
  - `npm run doctor` 可检测所有环境问题
  - 检测覆盖率 ≥ 95%（10 个检查项中至少 9 个通过）
  - 每个检查项提供明确的修复建议

- [ ] **快速重置**
  - `npm run reset -- --full` 可在 5 分钟内完成环境重置
  - 重置后可重新运行 setup 恢复环境

- [ ] **种子数据**
  - `npm run seed` 可填充测试数据
  - 支持分类填充（用户、精灵、道具）
  - 支持清理和刷新

- [ ] **VS Code 集成**
  - 打开项目时自动推荐扩展
  - 调试配置可正常启动各服务
  - 任务配置可快速执行常用命令

- [ ] **文档完整性**
  - TROUBLESHOOTING.md 覆盖至少 20 个常见问题
  - 每个问题包含症状、原因、解决方案

- [ ] **脚本测试**
  - 所有脚本通过单元测试
  - 集成测试验证完整流程

## 6. 工作量估算

**规模**: L (Large)

**工时分解**:
- 环境初始化脚本：8 小时
- 健康检查工具：4 小时
- 重置脚本：3 小时
- 种子数据管理：4 小时
- VS Code 配置：2 小时
- 故障排查文档：4 小时
- 测试编写：6 小时
- 文档更新：2 小时

**总计**: 约 33 小时（4-5 个工作日）

## 7. 优先级理由

**P1 理由**:

1. **直接影响开发者效率**：环境问题是新贡献者的主要障碍，影响项目社区发展
2. **减少支持成本**：自动化诊断可减少 50% 以上的环境相关问答
3. **提升代码质量**：统一开发环境减少"我这没问题"的情况
4. **成熟度提升**：完善开发者体验是项目成熟度的重要指标
5. **快速回报**：一次开发，长期受益，所有后续开发者都能节省时间

当前项目成熟度评分中"文档与开发者体验"仅得 3/5 分，本需求可直接提升至 4-5 分。
