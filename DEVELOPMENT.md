# 本地开发指南

本指南帮助您在本地搭建 mineGo 开发环境。

## 📋 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [开发工作流](#开发工作流)
- [调试技巧](#调试技巧)
- [常见问题](#常见问题)
- [性能调优](#性能调优)

## 环境要求

### 必需

| 软件 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 20.x | 运行时环境 |
| Docker | >= 24.x | 容器化运行 |
| Docker Compose | >= 2.x | 多容器编排 |
| Git | >= 2.x | 版本控制 |

### 可选

| 软件 | 说明 |
|------|------|
| PostgreSQL 15 | 本地数据库（Docker 包含） |
| Redis 7 | 本地缓存（Docker 包含） |
| VS Code | 推荐 IDE |

### 验证环境

```bash
# 检查 Node.js
node --version  # 应输出 v20.x.x

# 检查 Docker
docker --version  # 应输出 Docker version 24.x.x
docker compose version  # 应输出 Docker Compose version 2.x.x

# 检查 Git
git --version  # 应输出 git version 2.x.x
```

## 快速开始

### 1. Clone 项目

```bash
git clone https://github.com/kkcc2013-arch/mineGo.git
cd mineGo
```

### 2. 启动依赖服务

```bash
# 启动 PostgreSQL、Redis、Kafka
docker compose up -d postgres redis kafka

# 等待服务启动（约 30 秒）
docker compose ps
```

预期输出：
```
NAME                STATUS              PORTS
postgres            running             0.0.0.0:5432->5432/tcp
redis               running             0.0.0.0:6379->6379/tcp
kafka               running             0.0.0.0:9092->9092/tcp
```

### 3. 初始化数据库

```bash
cd database

# 执行迁移
node migrate.js up

# 验证迁移状态
node migrate.js status
```

### 4. 安装依赖

```bash
cd backend
npm install
```

### 5. 配置环境变量

```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件
nano .env
```

关键配置：
```env
# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_NAME=minego
DB_USER=postgres
DB_PASSWORD=your_password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT
JWT_SECRET=your_jwt_secret_here
JWT_EXPIRES_IN=24h

# 服务端口
GATEWAY_PORT=8080
USER_SERVICE_PORT=8081
# ... 其他服务端口
```

### 6. 启动服务

```bash
# 方式一：启动所有服务
npm run dev

# 方式二：启动单个服务
npm run dev:gateway
npm run dev:user
npm run dev:location
npm run dev:catch
# ...

# 方式三：使用 PM2（生产模式）
npm run start:prod
```

### 7. 验证

```bash
# 检查 Gateway 健康
curl http://localhost:8080/health
# 预期: {"status":"ok","timestamp":"..."}

# 检查各服务健康
curl http://localhost:8081/health  # user-service
curl http://localhost:8082/health  # location-service
curl http://localhost:8083/health  # pokemon-service
# ...

# 检查 Swagger UI
open http://localhost:8080/swagger
```

## 开发工作流

### 运行测试

```bash
# 单元测试
npm run test:unit

# 集成测试（需要 Docker）
npm run test:integration

# E2E 测试
npm run test:e2e

# 覆盖率报告
npm run test:coverage

# 监听模式（开发时）
npm run test:watch
```

### 代码检查

```bash
# ESLint 检查
npm run lint

# 自动修复
npm run lint:fix

# Prettier 格式化
npm run format
```

### 数据库迁移

```bash
cd database

# 创建新迁移
node migrate.js create add_new_table

# 执行迁移
node migrate.js up

# 回滚最后一次迁移
node migrate.js down

# 查看迁移状态
node migrate.js status

# 验证迁移文件
node migrate.js verify
```

### Git 工作流

```bash
# 同步上游
git fetch upstream
git checkout main
git merge upstream/main

# 创建功能分支
git checkout -b feature/new-feature

# 开发完成后
git add .
git commit -m "feat: add new feature"
git push origin feature/new-feature

# 创建 Pull Request
# 在 GitHub 上操作
```

## 调试技巧

### VS Code 调试配置

创建 `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Gateway",
      "program": "${workspaceFolder}/backend/gateway/src/index.js",
      "envFile": "${workspaceFolder}/backend/.env",
      "console": "integratedTerminal"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug User Service",
      "program": "${workspaceFolder}/backend/services/user-service/src/index.js",
      "envFile": "${workspaceFolder}/backend/.env"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Catch Service",
      "program": "${workspaceFolder}/backend/services/catch-service/src/index.js",
      "envFile": "${workspaceFolder}/backend/.env"
    },
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Process",
      "port": 9229
    }
  ]
}
```

### 远程调试

```bash
# 启动服务时开启调试端口
node --inspect=0.0.0.0:9229 services/user-service/src/index.js

# 在 VS Code 中附加调试器
# 使用 "Attach to Process" 配置
```

### 查看日志

```bash
# 实时查看所有服务日志
docker compose logs -f

# 查看特定服务日志
docker compose logs -f user-service

# 查看最近 100 行
docker compose logs --tail=100 catch-service

# 查看带时间戳的日志
docker compose logs -f --timestamps
```

### 数据库调试

```bash
# 连接 PostgreSQL
docker compose exec postgres psql -U postgres -d minego

# 常用查询
\dt                           # 列出所有表
SELECT * FROM users LIMIT 10; # 查看用户
SELECT * FROM pokemon_instances WHERE user_id = 1; # 查看用户精灵

# 查看活动查询
SELECT * FROM pg_stat_activity;

# 查看表大小
SELECT 
  relname AS table_name,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

### Redis 调试

```bash
# 连接 Redis
docker compose exec redis redis-cli

# 常用命令
KEYS *                  # 列出所有键
GET user:1:profile      # 获取用户缓存
TTL user:1:profile      # 查看过期时间
DEL user:1:profile      # 删除缓存

# GEO 相关
GEORADIUS nearby:pokemon 121.47 31.23 1 km  # 查询附近精灵
```

### Kafka 调试

```bash
# 列出 Topics
docker compose exec kafka kafka-topics.sh --list --bootstrap-server localhost:9092

# 消费消息
docker compose exec kafka kafka-console-consumer.sh \
  --topic pokemon.caught \
  --bootstrap-server localhost:9092 \
  --from-beginning

# 生产测试消息
docker compose exec kafka kafka-console-producer.sh \
  --topic pokemon.caught \
  --bootstrap-server localhost:9092
```

## 常见问题

### 端口被占用

**症状:**
```
Error: listen EADDRINUSE: address already in use :::8080
```

**解决方案:**
```bash
# 查找占用端口的进程
lsof -i :8080
# 或
netstat -tunlp | grep 8080

# 杀死进程
kill -9 <PID>

# 或修改端口
# 在 .env 中修改 GATEWAY_PORT=8081
```

### 数据库连接失败

**症状:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**解决方案:**
```bash
# 1. 检查 PostgreSQL 是否启动
docker compose ps postgres

# 2. 启动 PostgreSQL
docker compose up -d postgres

# 3. 检查连接配置
cat backend/.env | grep DB_

# 4. 测试连接
docker compose exec postgres psql -U postgres -c "SELECT 1"
```

### Redis 连接失败

**症状:**
```
Error: Redis connection to 127.0.0.1:6379 failed
```

**解决方案:**
```bash
# 1. 检查 Redis 是否启动
docker compose ps redis

# 2. 启动 Redis
docker compose up -d redis

# 3. 测试连接
docker compose exec redis redis-cli ping
# 预期: PONG
```

### Kafka 连接失败

**症状:**
```
Error: Kafka broker not available
```

**解决方案:**
```bash
# 1. 检查 Kafka 是否启动
docker compose ps kafka

# 2. Kafka 启动较慢，等待 30-60 秒
docker compose logs -f kafka

# 3. 重启 Kafka
docker compose restart kafka
```

### 迁移失败

**症状:**
```
Error: relation "users" already exists
```

**解决方案:**
```bash
# 1. 检查迁移状态
cd database
node migrate.js status

# 2. 回滚到之前版本
node migrate.js down

# 3. 重新执行迁移
node migrate.js up

# 4. 如果需要，重置数据库
docker compose down -v  # 删除数据卷
docker compose up -d postgres
node migrate.js up
```

### 测试失败

**症状:**
```
FAIL  tests/unit/catch.test.js
```

**解决方案:**
```bash
# 1. 确保数据库已迁移
cd database && node migrate.js up

# 2. 检查环境变量
cat backend/.env

# 3. 运行单个测试查看详细错误
npm run test:unit -- --verbose catch.test.js

# 4. 清理并重新安装依赖
rm -rf node_modules package-lock.json
npm install
```

### 内存不足

**症状:**
```
FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

**解决方案:**
```bash
# 增加 Node.js 内存限制
export NODE_OPTIONS="--max-old-space-size=4096"
npm run dev

# 或在 package.json 中配置
"scripts": {
  "dev": "node --max-old-space-size=4096 ..."
}
```

## 性能调优

### 数据库优化

```sql
-- 查看慢查询
SELECT * FROM pg_stat_statements 
ORDER BY total_exec_time DESC 
LIMIT 10;

-- 分析查询计划
EXPLAIN ANALYZE 
SELECT * FROM pokemon_instances WHERE user_id = 1;

-- 查看索引使用情况
SELECT 
  schemaname,
  relname,
  indexrelname,
  idx_scan
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC;
```

### Redis 优化

```bash
# 查看内存使用
docker compose exec redis redis-cli INFO memory

# 查看慢查询日志
docker compose exec redis redis-cli SLOWLOG GET 10

# 配置优化（redis.conf）
maxmemory 2gb
maxmemory-policy allkeys-lru
```

### Node.js 优化

```bash
# 1. 使用生产模式
NODE_ENV=production npm start

# 2. 启用集群模式
node -e "require('cluster').isMaster ? require('cluster').fork() : require('./app')"

# 3. 内存分析
node --inspect services/user-service/src/index.js
# 然后在 Chrome DevTools 中连接
# chrome://inspect
```

### 性能测试

```bash
# 使用 autocannon 进行压力测试
npx autocannon -c 100 -d 30 http://localhost:8080/api/pokemon

# 使用 clinic.js 进行性能分析
npx clinic doctor -- node services/user-service/src/index.js
npx clinic flame -- node services/user-service/src/index.js
npx clinic bubbleprof -- node services/user-service/src/index.js
```

## 开发工具推荐

### VS Code 扩展

- **ESLint** - 代码检查
- **Prettier** - 代码格式化
- **Docker** - Docker 管理
- **REST Client** - API 测试
- **GitLens** - Git 增强
- **Thunder Client** - API 测试

### Chrome 扩展

- **React DevTools** - 前端调试
- **Redux DevTools** - 状态调试

### 命令行工具

- **httpie** - HTTP 客户端
- **jq** - JSON 处理
- **htop** - 进程监控
- **tmux** - 终端复用

## 下一步

- 阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献流程
- 阅读 [ARCHITECTURE.md](ARCHITECTURE.md) 了解系统架构
- 查看 [API 文档](http://localhost:8080/swagger) 了解 API 接口
- 加入 [Discord](#) 与社区交流
