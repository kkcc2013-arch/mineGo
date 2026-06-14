# REQ-00205：开发者环境自动化配置工具

- **编号**：REQ-00205
- **类别**：文档/开发者体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：scripts/setup-dev.js、backend/shared/config、.env.example、Dockerfile.dev、docs
- **创建时间**：2026-06-14 18:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目虽然有 DEVELOPMENT.md 和 CONTRIBUTING.md，但新开发者仍需要手动完成大量配置工作：

1. **环境配置繁琐**：需要手动创建 `.env` 文件、配置数据库连接、设置 Redis、配置 Kafka 等
2. **依赖安装分散**：各微服务需要分别安装依赖，容易遗漏
3. **开发工具不统一**：缺少统一的代码格式化、Linting、Git Hooks 配置
4. **本地服务启动复杂**：需要记住各服务端口和启动顺序
5. **缺少环境验证**：新开发者难以快速验证环境是否正确配置

根据 README.md，项目有 9 个微服务，每个服务都有独立的配置，新开发者从 clone 到能运行第一个 API 请求通常需要 30-60 分钟。

## 2. 目标

提供一键式开发环境配置工具，将新开发者从 clone 到能运行第一个请求的时间缩短到 5 分钟以内：

- 自动检测并安装所需依赖
- 自动生成配置文件（.env、docker-compose.override.yml）
- 提供交互式配置向导
- 内置环境健康检查
- 集成常用开发工具配置（prettier、eslint、husky）

## 3. 范围

### 包含
- `scripts/setup-dev.js` - 交互式环境配置脚本
- `scripts/verify-env.js` - 环境健康检查脚本
- `scripts/dev-start.js` - 一键启动所有开发服务
- `.env.template` - 完整的环境变量模板（带注释）
- `docker-compose.dev.yml` - 开发环境专用 Docker Compose
- `.prettierrc` 和 `.eslintrc.js` - 统一的代码风格配置
- `.husky/` - Git hooks 自动化
- `package.json` 根目录 scripts 扩展
- DEVELOPMENT.md 更新 - 添加快速配置章节

### 不包含
- CI/CD 环境配置（已有 GitHub Actions）
- 生产环境部署脚本（已有 K8s 配置）
- IDE 特定配置（仅提供通用配置）

## 4. 详细需求

### 4.1 环境自动检测脚本（scripts/setup-dev.js）

```javascript
// 功能要求：
// 1. 检测系统环境：Node.js 版本、Docker、Docker Compose、Git
// 2. 交互式询问：数据库配置、Redis 配置、Kafka 配置、端口偏好
// 3. 生成 .env 文件（基于 .env.template）
// 4. 生成 docker-compose.override.yml（开发环境定制）
// 5. 安装所有微服务依赖（并行安装）
// 6. 初始化数据库（运行迁移脚本）
// 7. 配置 Git hooks（husky）
```

**交互流程示例**：
```
🎮 mineGo 开发环境配置向导

✓ 检测到 Node.js v20.11.0
✓ 检测到 Docker 24.0.7
✓ 检测到 Docker Compose 2.23.0

请选择配置模式：
  1. 快速配置（推荐，使用默认值）
  2. 自定义配置（手动设置各项参数）
  3. 仅检查环境（不修改文件）

> 1

正在配置...
✓ 生成 .env 文件
✓ 生成 docker-compose.override.yml
✓ 安装根目录依赖
✓ 安装 backend 依赖
✓ 安装 gateway 依赖
✓ 安装 9 个微服务依赖
✓ 配置 Git hooks
✓ 初始化数据库

环境配置完成！🎉
运行 'npm run dev' 启动所有服务
运行 'npm run verify' 检查环境状态
```

### 4.2 环境健康检查脚本（scripts/verify-env.js）

检查项：
- [ ] Node.js 版本 >= 20.0.0
- [ ] Docker 运行状态
- [ ] PostgreSQL 连接
- [ ] Redis 连接
- [ ] Kafka 连接
- [ ] 端口占用检测（3000-3010, 5432, 6379, 9092）
- [ ] 环境变量完整性
- [ ] 必要文件存在（.env、证书文件等）

输出格式：
```
✓ Node.js: v20.11.0 (符合要求)
✓ Docker: 运行中
✓ PostgreSQL: 连接正常 (localhost:5432)
✓ Redis: 连接正常 (localhost:6379)
⚠ Kafka: 未运行，使用 Docker 启动: docker-compose up -d kafka
✓ 端口: 无冲突
✓ 环境变量: 完整

健康度: 92% - 可正常开发
```

### 4.3 一键启动脚本（scripts/dev-start.js）

```javascript
// 功能：
// 1. 启动 Docker 服务（PostgreSQL、Redis、Kafka）
// 2. 等待依赖服务就绪
// 3. 并行启动所有微服务（使用 concurrently）
// 4. 实时显示所有服务日志
// 5. 支持 --only=<service> 参数单独启动某个服务
// 6. 支持 --logs=<service> 参数查看特定服务日志
```

### 4.4 环境变量模板（.env.template）

```bash
# ===========================================
# mineGo 开发环境配置模板
# ===========================================
# 说明：运行 npm run setup 自动生成 .env 文件
# 或手动复制此文件为 .env 并填写值

# ---------- 核心配置 ----------
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# ---------- 数据库配置 ----------
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=minego
DATABASE_USER=minego
DATABASE_PASSWORD=minego_dev_2024
# 提示：开发环境使用默认密码，生产环境必须修改

# ---------- Redis 配置 ----------
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# ---------- Kafka 配置 ----------
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=minego-dev
KAFKA_GROUP_ID=minego-dev-group

# ---------- JWT 配置 ----------
JWT_SECRET=dev-secret-change-in-production
JWT_EXPIRES_IN=7d

# ---------- 微服务端口 ----------
GATEWAY_PORT=3000
USER_SERVICE_PORT=3001
LOCATION_SERVICE_PORT=3002
POKEMON_SERVICE_PORT=3003
CATCH_SERVICE_PORT=3004
GYM_SERVICE_PORT=3005
SOCIAL_SERVICE_PORT=3006
REWARD_SERVICE_PORT=3007
PAYMENT_SERVICE_PORT=3008

# ---------- 第三方服务（可选）----------
# GOOGLE_MAPS_API_KEY=your-key-here
# FIREBASE_PROJECT_ID=your-project-id
# STRIPE_SECRET_KEY=sk_test_xxx

# ---------- 开发工具配置 ----------
ENABLE_SWAGGER=true
ENABLE_GRAPHIQL=true
CORS_ORIGIN=http://localhost:8080
```

### 4.5 开发环境 Docker Compose（docker-compose.dev.yml）

```yaml
version: '3.8'

services:
  # PostgreSQL - 开发环境配置
  postgres:
    extends:
      file: docker-compose.yml
      service: postgres
    ports:
      - "5432:5432"
    volumes:
      - postgres_dev_data:/var/lib/postgresql/data
      - ./backend/database/init:/docker-entrypoint-initdb.d
    environment:
      POSTGRES_PASSWORD: minego_dev_2024

  # Redis - 开发环境配置
  redis:
    extends:
      file: docker-compose.yml
      service: redis
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes

  # Kafka - 开发环境配置
  kafka:
    extends:
      file: docker-compose.yml
      service: kafka
    ports:
      - "9092:9092"
    environment:
      KAFKA_CREATE_TOPICS: >
        pokemon-events:3:1,
        user-events:3:1,
        gym-events:3:1,
        payment-events:3:1

  # Kafka UI（可选，开发工具）
  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    ports:
      - "9000:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: minego-dev
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:9092

volumes:
  postgres_dev_data:
```

### 4.6 代码格式化和 Lint 配置

**.prettierrc**:
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "arrowParens": "always"
}
```

**.eslintrc.js**:
```javascript
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    jest: true
  },
  extends: [
    'eslint:recommended',
    'plugin:node/recommended',
    'plugin:promise/recommended'
  ],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'node/no-unpublished-require': 'off',
    'promise/always-return': 'error',
    'promise/catch-or-return': 'error'
  }
}
```

### 4.7 Git Hooks（.husky/）

**pre-commit**:
```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npm run lint
npm run test:unit
```

**commit-msg**:
```bash
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx --no -- commitlint --edit "$1"
```

### 4.8 根目录 package.json scripts 扩展

```json
{
  "scripts": {
    "setup": "node scripts/setup-dev.js",
    "verify": "node scripts/verify-env.js",
    "dev": "node scripts/dev-start.js",
    "dev:services": "concurrently -n gateway,user,location,pokemon,catch,gym,social,reward,payment -c blue,green,yellow,red,magenta,cyan,white,gray,blueBright \"npm run dev:gateway\" \"npm run dev:user\" ...",
    "lint": "eslint backend/**/*.js --fix",
    "format": "prettier --write \"**/*.js\"",
    "test:unit": "jest backend/tests/unit",
    "test:integration": "jest backend/tests/integration",
    "prepare": "husky install"
  }
}
```

### 4.9 DEVELOPMENT.md 更新

在文件开头添加"快速开始"章节：

```markdown
## 🚀 快速开始（5 分钟配置）

### 方式一：自动配置（推荐）

```bash
# 1. Clone 项目
git clone https://github.com/kkcc2013-arch/mineGo.git
cd mineGo

# 2. 运行配置向导
npm run setup

# 3. 启动所有服务
npm run dev

# 4. 访问 API 文档
open http://localhost:3000/api-docs
```

### 方式二：手动配置

参见下方详细配置章节...

### 验证环境

```bash
npm run verify
```

看到"健康度: 100%"即表示环境配置成功。
```

## 5. 验收标准（可测试）

- [ ] 运行 `npm run setup` 能在 5 分钟内完成环境配置（首次运行）
- [ ] 生成的 `.env` 文件包含所有必需的环境变量且格式正确
- [ ] 运行 `npm run verify` 能正确检测环境状态，输出健康度评分
- [ ] 运行 `npm run dev` 能成功启动所有 9 个微服务
- [ ] 新开发者从 clone 到运行第一个 API 请求时间 < 5 分钟
- [ ] 所有微服务代码格式统一（prettier 检查通过）
- [ ] Git commit 时自动运行 lint 和单元测试（husky 生效）
- [ ] 配置脚本支持 Windows、macOS、Linux 三大平台
- [ ] 脚本包含错误处理和友好的错误提示
- [ ] 文档更新后，新开发者能在不看源码的情况下完成环境配置

## 6. 工作量估算

**规模：M（中等）**

**理由**：
- 需要编写 3 个主要脚本（setup、verify、dev-start）
- 需要创建多个配置文件（env 模板、docker-compose、prettier、eslint、husky）
- 需要更新文档
- 需要测试跨平台兼容性
- 预计工作量：2-3 天

## 7. 优先级理由

**P1 理由**：

1. **开发者体验直接影响贡献者增长**：降低参与门槛是开源项目发展的关键
2. **减少团队新人上手时间**：每个新开发者节省 30-60 分钟配置时间
3. **减少环境问题导致的 bug**：统一的配置和检查能避免大量环境相关问题
4. **提升代码质量**：统一的 lint 和 format 配置能保证代码风格一致性
5. **与项目成熟度目标一致**：文档与开发者体验维度当前得分 4/5，本需求能显著提升

此需求解决的是"如何让开发者更快上手"的核心问题，对项目长期发展有重要意义，因此定为 P1。
