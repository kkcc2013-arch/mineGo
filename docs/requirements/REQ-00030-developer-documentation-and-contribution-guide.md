# REQ-00030：开发者贡献指南与项目文档完善

- **编号**：REQ-00030
- **类别**：文档/开发者体验
- **优先级**：P2
- **状态**：done
- **涉及服务/模块**：docs、README.md、CONTRIBUTING.md、ARCHITECTURE.md
- **创建时间**：2026-06-05 22:05 UTC
- **依赖需求**：无

## 1. 背景与问题

mineGo 项目缺少完善的开发者文档，新贡献者上手困难：

### 1.1 当前文档缺失

1. **无贡献指南**：缺少 CONTRIBUTING.md，开发者不知道如何提交代码
2. **无架构文档**：缺少 ARCHITECTURE.md，新开发者难以理解系统设计
3. **API 文档分散**：OpenAPI 规范存在，但缺少统一索引和使用示例
4. **开发环境设置不完整**：README.md 缺少详细的本地开发指南
5. **缺少故障排查文档**：常见问题和解决方案未文档化
6. **缺少性能基准文档**：没有性能指标和优化建议

### 1.2 开发者痛点

| 痛点 | 影响 | 频率 |
|------|------|------|
| 不知道如何运行测试 | 降低贡献意愿 | 高 |
| 不理解服务间依赖 | 难以定位问题 | 高 |
| 缺少代码风格指南 | 代码审查效率低 | 中 |
| 缺少提交规范 | Commit 信息混乱 | 中 |
| 缺少发布流程说明 | 发布风险 | 低 |

### 1.3 与行业标准对比

| 文档类型 | 行业标准 | mineGo 现状 |
|---------|---------|------------|
| README.md | ✅ 项目介绍、快速开始 | ✅ 已有基础版本 |
| CONTRIBUTING.md | ✅ 贡献流程、代码规范 | ❌ 缺失 |
| ARCHITECTURE.md | ✅ 系统设计、技术决策 | ❌ 缺失 |
| CHANGELOG.md | ✅ 版本历史 | ⚠️ 只有 git log |
| CODE_OF_CONDUCT.md | ✅ 社区行为准则 | ❌ 缺失 |
| DEVELOPMENT.md | ✅ 本地开发指南 | ❌ 缺失 |
| TROUBLESHOOTING.md | ✅ 常见问题 | ❌ 缺失 |

## 2. 目标

建立完整的开发者文档体系，降低贡献门槛：

1. **贡献指南**：CONTRIBUTING.md 明确贡献流程和代码规范
2. **架构文档**：ARCHITECTURE.md 说明系统设计和关键决策
3. **开发指南**：DEVELOPMENT.md 详细本地开发环境设置
4. **故障排查**：TROUBLESHOOTING.md 常见问题和解决方案
5. **行为准则**：CODE_OF_CONDUCT.md 社区规范
6. **文档索引**：docs/README.md 统一导航

## 3. 范围

### 包含
- CONTRIBUTING.md（贡献流程、代码规范、提交规范）
- ARCHITECTURE.md（系统架构、技术栈、设计决策）
- DEVELOPMENT.md（本地开发环境、调试技巧）
- TROUBLESHOOTING.md（常见问题、解决方案）
- CODE_OF_CONDUCT.md（社区行为准则）
- docs/README.md（文档导航索引）
- 更新 README.md（补充项目信息）

### 不包含
- API 详细文档（已有 OpenAPI 规范）
- 用户手册（非开发者文档）
- 视频教程（资源密集型）
- 国际化文档（后续需求）

## 4. 详细需求

### 4.1 CONTRIBUTING.md - 贡献指南

```markdown
# 贡献指南

感谢您考虑为 mineGo 做贡献！

## 贡献流程

### 1. Fork 和 Clone

\`\`\`bash
# Fork 后 clone 你的仓库
git clone https://github.com/YOUR_USERNAME/mineGo.git
cd mineGo
git remote add upstream https://github.com/kkcc2013-arch/mineGo.git
\`\`\`

### 2. 创建分支

\`\`\`bash
git checkout -b feature/your-feature-name
\`\`\`

### 3. 开发和测试

\`\`\`bash
# 安装依赖
npm install

# 运行测试
npm test

# 运行 lint
npm run lint
\`\`\`

### 4. 提交代码

遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

\`\`\`
feat(catch): 添加连续捕捉奖励机制
fix(payment): 修复订单幂等性校验漏洞
docs(readme): 更新本地开发指南
test(gym): 添加道馆战斗集成测试
refactor(auth): 重构 JWT 令牌生成逻辑
\`\`\`

### 5. 创建 Pull Request

- 标题格式：`[类型] 简短描述`
- 填写 PR 模板
- 关联相关 Issue
- 等待 CI 通过和代码审查

## 代码规范

### JavaScript

- 使用 ES6+ 语法
- 使用 const/let，避免 var
- 函数注释使用 JSDoc
- 测试覆盖率 ≥ 80%

### 代码风格

- 使用 Prettier 格式化
- 使用 ESLint 检查
- 提交前运行 `npm run lint:fix`

### Git 规范

- 分支命名：`feature/`, `fix/`, `docs/`, `refactor/`
- Commit 信息清晰、简洁
- 一个 Commit 做一件事

## 测试要求

- 新功能必须有单元测试
- 修复 Bug 必须有回归测试
- 集成测试覆盖关键流程
- 所有测试必须通过

## 代码审查

所有 PR 都需要至少 1 位审查者批准。

审查重点：
- 代码质量
- 测试覆盖
- 性能影响
- 安全风险
- 文档更新
```

### 4.2 ARCHITECTURE.md - 架构文档

```markdown
# 系统架构

## 技术栈

### 后端
- **Node.js 20**: 运行时环境
- **Express**: Web 框架
- **PostgreSQL 15 + PostGIS**: 主数据库，支持地理查询
- **Redis 7**: 缓存、会话、GEO 缓存
- **Kafka**: 事件驱动消息队列
- **WebSocket**: 实时通信（Raid 战斗）

### 前端
- **原生 JavaScript**: 游戏客户端
- **HTML/CSS**: 管理后台

### 基础设施
- **Docker**: 容器化
- **Kubernetes 1.28**: 容器编排
- **Helm**: K8s 包管理
- **GitHub Actions**: CI/CD
- **Prometheus + Grafana**: 监控告警
- **Jaeger**: 分布式追踪

## 系统架构图

\`\`\`
┌─────────────────────────────────────────────────┐
│                   Game Client                    │
│              (Native JavaScript)                 │
└─────────────────────┬───────────────────────────┘
                      │ HTTPS
┌─────────────────────▼───────────────────────────┐
│              API Gateway (8080)                  │
│  • JWT 认证  • 限流  • 路由  • 熔断              │
└─────────────────────┬───────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
┌───────▼──────┐ ┌───▼──────┐ ┌────▼─────┐
│ User Service │ │ Location │ │  Catch   │
│    (8081)    │ │  (8082)  │ │  (8084)  │
└──────┬───────┘ └────┬─────┘ └────┬─────┘
       │              │            │
┌──────▼──────┐ ┌─────▼────┐ ┌────▼─────┐
│  Pokemon    │ │   Gym    │ │  Social  │
│   (8083)    │ │  (8085)  │ │  (8086)  │
└──────┬──────┘ └────┬─────┘ └────┬─────┘
       │              │            │
┌──────▼──────┐ ┌─────▼────┐ ┌────▼─────┐
│   Reward    │ │ Payment  │ │  Redis   │
│   (8087)    │ │  (8088)  │ │  Cache   │
└─────────────┘ └──────────┘ └──────────┘
                      │
              ┌───────▼────────┐
              │  PostgreSQL    │
              │   + PostGIS    │
              └────────────────┘
\`\`\`

## 微服务职责

| 服务 | 端口 | 职责 |
|------|------|------|
| gateway | 8080 | API 网关、认证、限流、熔断 |
| user-service | 8081 | 用户注册、登录、资料、时区 |
| location-service | 8082 | GPS 上报、精灵刷新、附近查询 |
| pokemon-service | 8083 | 精灵仓库、图鉴、技能、进化 |
| catch-service | 8084 | 捕捉流程、投球物理、结算 |
| gym-service | 8085 | 道馆占领、Raid 战斗、WebSocket |
| social-service | 8086 | 好友、礼物、精灵交易 |
| reward-service | 8087 | 任务、成就、排行榜、赛季 |
| payment-service | 8088 | 内购、充值、订单管理 |

## 数据库设计

### 核心表

- `users`: 用户信息、队伍、时区
- `pokemon`: 精灵实例、CP、IV
- `pokemon_species`: 精灵种族数据
- `gyms`: 道馆位置、归属
- `raids`: Raid 活动信息
- `friends`: 好友关系
- `trades`: 交易记录
- `payments`: 支付订单

### 地理查询

使用 PostGIS 扩展：
- `ST_DWithin`: 附近精灵查询
- `ST_Distance`: 距离计算
- `ST_MakePoint`: GPS 坐标存储

## 事件驱动架构

### Kafka Topics

- `pokemon.caught`: 精灵捕捉事件
- `gym.battle`: 道馆战斗事件
- `user.level_up`: 用户升级事件
- `reward.claimed`: 奖励领取事件

### 事件生产者

- catch-service → `pokemon.caught`
- gym-service → `gym.battle`
- reward-service → `reward.claimed`

### 事件消费者

- user-service ← `pokemon.caught`（更新统计数据）
- social-service ← `pokemon.caught`（通知好友）
- reward-service ← `gym.battle`（发放奖励）

## 设计决策

### 为什么选择微服务架构？

**优点**：
- 独立部署和扩展
- 技术栈灵活
- 故障隔离
- 团队协作友好

**代价**：
- 运维复杂度高
- 分布式事务挑战
- 服务间通信延迟

### 为什么选择 PostgreSQL + PostGIS？

**理由**：
- 强大的地理查询能力
- ACID 事务保证
- 成熟的生态系统
- 与 Node.js 集成良好

### 为什么选择 Kafka？

**理由**：
- 高吞吐量
- 消息持久化
- 支持事件回放
- 解耦服务依赖

## 性能优化策略

1. **Redis GEO 缓存**：附近精灵查询延迟降低 80%
2. **数据库连接池**：复用连接，减少开销
3. **事件驱动**：异步处理，降低延迟
4. **熔断降级**：防止级联故障
5. **水平扩展**：HPA 自动扩容

## 安全机制

1. **JWT 认证**：无状态会话
2. **JWT 黑名单**：支持强制登出
3. **GPS 反作弊**：速度检测、伪造检测
4. **支付幂等性**：防止重复扣款
5. **GDPR 合规**：数据加密、用户权利

## 可观测性

### 日志

- 结构化 JSON 格式
- Pino 日志库
- 关联 traceId

### 指标

- Prometheus 指标
- `/metrics` 端点
- Grafana 仪表板

### 追踪

- OpenTelemetry 集成
- Jaeger 链路追踪
- 端到端请求追踪
```

### 4.3 DEVELOPMENT.md - 开发指南

```markdown
# 本地开发指南

## 环境要求

- **Node.js** >= 20.x
- **Docker** >= 24.x
- **Docker Compose** >= 2.x
- **PostgreSQL** >= 15（可选，Docker 包含）
- **Redis** >= 7（可选，Docker 包含）

## 快速开始

### 1. Clone 项目

\`\`\`bash
git clone https://github.com/kkcc2013-arch/mineGo.git
cd mineGo
\`\`\`

### 2. 启动依赖服务

\`\`\`bash
docker compose up -d postgres redis kafka
\`\`\`

等待服务启动（约 30 秒）。

### 3. 初始化数据库

\`\`\`bash
cd database
node migrate.js up
\`\`\`

### 4. 安装依赖

\`\`\`bash
cd backend
npm install
\`\`\`

### 5. 配置环境变量

\`\`\`bash
cp .env.example .env
# 编辑 .env 文件，填入必要配置
\`\`\`

### 6. 启动服务

\`\`\`bash
# 启动所有服务
npm run dev

# 或启动单个服务
npm run dev:user
npm run dev:catch
# ...
\`\`\`

### 7. 验证

\`\`\`bash
curl http://localhost:8080/health
# 应返回 { "status": "ok" }
\`\`\`

## 开发工作流

### 运行测试

\`\`\`bash
# 单元测试
npm run test:unit

# 集成测试
npm run test:integration

# 覆盖率报告
npm run test:coverage
\`\`\`

### 代码检查

\`\`\`bash
# 检查代码风格
npm run lint

# 自动修复
npm run lint:fix
\`\`\`

### 数据库迁移

\`\`\`bash
# 创建新迁移
node database/migrate.js create migration_name

# 执行迁移
node database/migrate.js up

# 回滚迁移
node database/migrate.js down
\`\`\`

## 调试技巧

### VS Code 调试配置

\`\`\`json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug User Service",
      "program": "${workspaceFolder}/backend/services/user-service/src/index.js",
      "envFile": "${workspaceFolder}/backend/.env"
    }
  ]
}
\`\`\`

### 查看日志

\`\`\`bash
# 实时日志
docker compose logs -f user-service

# 最近 100 行
docker compose logs --tail=100 catch-service
\`\`\`

### 数据库查询

\`\`\`bash
# 连接 PostgreSQL
docker compose exec postgres psql -U postgres -d minego

# 常用查询
SELECT * FROM users LIMIT 10;
SELECT * FROM pokemon WHERE user_id = 1;
\`\`\`

### Redis 调试

\`\`\`bash
# 连接 Redis
docker compose exec redis redis-cli

# 查看缓存键
KEYS *
GET user:1:profile
\`\`\`

## 常见问题

### 端口被占用

\`\`\`bash
# 查找占用端口的进程
lsof -i :8080

# 杀死进程
kill -9 <PID>
\`\`\`

### 数据库连接失败

1. 检查 PostgreSQL 是否启动：`docker compose ps`
2. 检查环境变量配置：`backend/.env`
3. 检查数据库是否存在：`docker compose exec postgres psql -l`

### Redis 连接失败

1. 检查 Redis 是否启动：`docker compose ps redis`
2. 测试连接：`docker compose exec redis redis-cli ping`

### 测试失败

1. 确保数据库已迁移
2. 检查环境变量
3. 查看错误日志：`npm run test -- --verbose`

## 性能调优

### 数据库优化

\`\`\`sql
-- 查看慢查询
SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10;

-- 分析查询计划
EXPLAIN ANALYZE SELECT * FROM pokemon WHERE user_id = 1;
\`\`\`

### 内存分析

\`\`\`bash
# Node.js 内存堆快照
node --inspect services/user-service/src/index.js
# 然后在 Chrome DevTools 中连接
\`\`\`
```

### 4.4 TROUBLESHOOTING.md - 故障排查

```markdown
# 故障排查指南

## 服务启动问题

### 问题：服务启动失败

**症状**：
\`\`\`
Error: connect ECONNREFUSED 127.0.0.1:5432
\`\`\`

**原因**：PostgreSQL 未启动或连接配置错误

**解决方案**：
\`\`\`bash
# 检查 PostgreSQL 状态
docker compose ps postgres

# 启动 PostgreSQL
docker compose up -d postgres

# 检查连接配置
cat backend/.env | grep DB_
\`\`\`

### 问题：Redis 连接超时

**症状**：
\`\`\`
Error: Redis connection timeout
\`\`\`

**解决方案**：
\`\`\`bash
# 重启 Redis
docker compose restart redis

# 检查 Redis 日志
docker compose logs redis
\`\`\`

### 问题：Kafka 连接失败

**症状**：
\`\`\`
Error: Kafka broker not available
\`\`\`

**解决方案**：
\`\`\`bash
# 等待 Kafka 完全启动（约 30 秒）
docker compose logs -f kafka

# 重启 Kafka
docker compose restart kafka
\`\`\`

## 数据库问题

### 问题：迁移失败

**症状**：
\`\`\`
Error: relation "users" already exists
\`\`\`

**解决方案**：
\`\`\`bash
# 检查迁移状态
node database/migrate.js status

# 回滚到之前版本
node database/migrate.js down

# 重新执行迁移
node database/migrate.js up
\`\`\`

### 问题：PostGIS 扩展未安装

**症状**：
\`\`\`
ERROR: function st_dwithin(geometry, geometry, double precision) does not exist
\`\`\`

**解决方案**：
\`\`\`sql
-- 连接数据库
docker compose exec postgres psql -U postgres -d minego

-- 安装 PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- 验证
SELECT PostGIS_Version();
\`\`\`

## 性能问题

### 问题：附近精灵查询慢

**症状**：查询延迟 > 500ms

**解决方案**：
1. 检查 Redis GEO 缓存是否启用
2. 检查 PostGIS 索引是否存在
3. 分析查询计划

\`\`\`bash
# 检查 Redis 缓存
docker compose exec redis redis-cli
> KEYS nearby:*
\`\`\`

### 问题：服务内存占用高

**症状**：Node.js 进程内存 > 500MB

**解决方案**：
\`\`\`bash
# 生成堆快照
kill -USR2 <PID>

# 使用 Chrome DevTools 分析
\`\`\`

### 问题：数据库连接池耗尽

**症状**：
\`\`\`
Error: remaining connection slots are reserved for non-replication superuser connections
\`\`\`

**解决方案**：
\`\`\`bash
# 检查当前连接数
docker compose exec postgres psql -U postgres -c "SELECT count(*) FROM pg_stat_activity;"

# 增加最大连接数
# postgresql.conf: max_connections = 200
\`\`\`

## 认证问题

### 问题：JWT 验证失败

**症状**：
\`\`\`
Error: invalid signature
\`\`\`

**解决方案**：
1. 检查 JWT_SECRET 环境变量
2. 确保 Gateway 和 User Service 使用相同密钥
3. 检查 token 是否过期

\`\`\`bash
# 解码 JWT 查看 payload
echo "eyJhbGc..." | base64 -d
\`\`\`

### 问题：用户被强制登出

**症状**：频繁需要重新登录

**原因**：JWT 黑名单或 token 过期

**解决方案**：
\`\`\`bash
# 检查 Redis 黑名单
docker compose exec redis redis-cli
> KEYS jwt:blacklist:*

# 清除黑名单（谨慎操作）
> DEL jwt:blacklist:*
\`\`\`

## 支付问题

### 问题：订单重复扣款

**症状**：用户报告重复扣款

**解决方案**：
1. 检查幂等性键是否正确生成
2. 检查订单状态机
3. 查看支付日志

\`\`\`bash
# 查看订单状态
docker compose exec postgres psql -U postgres -d minego -c "SELECT * FROM payments WHERE user_id = <USER_ID> ORDER BY created_at DESC;"
\`\`\`

## 反作弊问题

### 问题：正常用户被误判为作弊

**症状**：用户报告捕捉失败

**解决方案**：
1. 检查 GPS 速度检测阈值
2. 查看反作弊日志
3. 手动解除封禁

\`\`\`bash
# 查看反作弊记录
docker compose exec postgres psql -U postgres -d minego -c "SELECT * FROM anti_cheat_events WHERE user_id = <USER_ID>;"

# 解除封禁（管理员操作）
curl -X DELETE http://localhost:8080/admin/anti-cheat/ban/<USER_ID> -H "Authorization: Bearer <ADMIN_TOKEN>"
\`\`\`

## 监控问题

### 问题：Prometheus 指标不显示

**症状**：Grafana 无数据

**解决方案**：
\`\`\`bash
# 检查 Prometheus 配置
kubectl get configmap -n monitoring prometheus-config

# 检查服务 /metrics 端点
curl http://localhost:8080/metrics

# 重启 Prometheus
kubectl rollout restart deployment/prometheus -n monitoring
\`\`\`

### 问题：告警不触发

**症状**：服务异常但无告警

**解决方案**：
1. 检查告警规则配置
2. 检查 Alertmanager 配置
3. 测试告警通道

\`\`\`bash
# 测试告警
curl -X POST http://localhost:9093/api/v1/alerts -d '[{"labels":{"alertname":"TestAlert"},"annotations":{"summary":"Test alert"}}]'
\`\`\`

## 日志问题

### 问题：日志丢失或格式错误

**症状**：日志不完整或非 JSON 格式

**解决方案**：
1. 检查 Pino 日志配置
2. 检查日志级别
3. 检查日志输出目标

\`\`\`bash
# 检查日志级别
cat backend/.env | grep LOG_LEVEL

# 测试日志输出
curl http://localhost:8080/test/log
docker compose logs user-service | grep "test"
\`\`\`
```

### 4.5 CODE_OF_CONDUCT.md - 行为准则

```markdown
# 贡献者行为准则

## 我们的承诺

为了营造一个开放和包容的环境，我们作为贡献者和维护者承诺：无论年龄、体型、残疾、种族、性别认同和表达、经验水平、教育程度、社会经济地位、国籍、外貌、种族、宗教或性取向如何，参与我们的项目和社区都将为每个人提供无骚扰的体验。

## 我们的标准

有助于创造积极环境的行为示例包括：

- 使用友好和包容的语言
- 尊重不同的观点和经验
- 优雅地接受建设性批评
- 关注对社区最有利的事情
- 对其他社区成员表示同理心

参与者不可接受的行为示例包括：

- 使用性化的语言或图像，以及不受欢迎的性关注或性骚扰
- 捣乱、侮辱/贬损评论以及人身或政治攻击
- 公开或私下骚扰
- 未经明确许可，发布他人的私人信息，例如物理地址或电子地址
- 在专业环境中可能被合理认为不适当的其他行为

## 我们的责任

项目维护者负责阐明可接受行为的标准，并期望对任何不可接受行为采取适当和公平的纠正措施。

项目维护者有权和责任删除、编辑或拒绝与本行为准则不符的评论、提交、代码、wiki 编辑、问题和其他贡献，或暂时或永久禁止任何他们认为有不适当、威胁、冒犯或有害行为的贡献者。

## 适用范围

本行为准则适用于项目空间和公共空间，当个人代表项目或其社区时。代表项目或社区的示例包括使用官方项目电子邮件地址、通过官方社交媒体帐户发布信息或在线上或线下活动中担任指定代表。项目的代表可由项目维护者进一步定义和阐明。

## 执行

可以通过 [联系邮箱] 向项目团队报告辱骂、骚扰或其他不可接受的行为。所有投诉都将被审查和调查，并将做出被认为必要和适当的回应。项目团队有义务对事件报告者保密。具体执行政策的更多详细信息可能会单独发布。

不真诚地遵守或执行本行为准则的项目维护者可能会面临由项目领导层其他成员确定的临时或永久影响。

## 归属

本行为准则改编自[贡献者公约][homepage]，版本 1.4，可在 https://www.contributor-covenant.org/zh-cn/version/1/4/code-of-conduct.html 获得

[homepage]: https://www.contributor-covenant.org

有关此行为准则的常见问题的答案，请参阅 https://www.contributor-covenant.org/faq
```

### 4.6 docs/README.md - 文档索引

```markdown
# mineGo 文档中心

欢迎来到 mineGo 项目文档中心。这里汇集了所有项目相关文档。

## 快速导航

### 新手入门

- [README.md](../README.md) - 项目概览和快速开始
- [DEVELOPMENT.md](../DEVELOPMENT.md) - 本地开发环境设置
- [CONTRIBUTING.md](../CONTRIBUTING.md) - 贡献指南

### 架构设计

- [ARCHITECTURE.md](../ARCHITECTURE.md) - 系统架构和技术决策
- [数据库设计](./database/README.md) - 数据库 Schema 和迁移
- [微服务设计](./services/README.md) - 微服务职责和通信

### API 文档

- [API 设计规范](./api-spec/API-DESIGN-GUIDELINES.md) - RESTful API 设计规范
- [错误码定义](./api-spec/error-codes.md) - 统一错误码规范
- [Swagger UI](http://localhost:8080/swagger) - 在线 API 文档

### 需求管理

- [需求索引](./requirements/INDEX.md) - 所有需求列表
- [项目状态](./requirements/STATUS.md) - 项目成熟度评估
- [已完成需求](./requirements/DONE.md) - 已完成需求详情

### 测试文档

- [测试指南](../backend/tests/README.md) - 单元测试说明
- [集成测试](../backend/tests/INTEGRATION.md) - 集成测试说明

### 故障排查

- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) - 常见问题和解决方案

### 其他

- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) - 社区行为准则

## 文档更新

文档与代码同步更新。如果您发现文档过期或有误，请：

1. 提交 Issue 说明问题
2. 提交 PR 修复文档
3. 在代码审查时指出文档问题

## 文档结构

\`\`\`
docs/
├── README.md                 # 本文档
├── api-spec/                 # API 规范
│   ├── API-DESIGN-GUIDELINES.md
│   └── error-codes.md
├── requirements/             # 需求管理
│   ├── INDEX.md
│   ├── STATUS.md
│   └── REQ-*.md
└── review/                   # 代码审查
    └── REQ-*-review.md
\`\`\`

## 文档贡献

欢迎贡献文档！请遵循以下原则：

1. **清晰简洁**：避免冗长，直奔主题
2. **示例代码**：提供可运行的代码示例
3. **保持更新**：代码变更时同步更新文档
4. **格式统一**：遵循 Markdown 规范
```

## 5. 验收标准（可测试）

- [ ] CONTRIBUTING.md 存在且包含完整的贡献流程
- [ ] ARCHITECTURE.md 存在且说明系统架构和设计决策
- [ ] DEVELOPMENT.md 存在且包含详细的本地开发指南
- [ ] TROUBLESHOOTING.md 存在且包含至少 10 个常见问题
- [ ] CODE_OF_CONDUCT.md 存在且符合行业标准
- [ ] docs/README.md 存在且提供清晰的文档导航
- [ ] README.md 已更新，包含项目徽章和完整信息
- [ ] 所有文档使用 Markdown 格式
- [ ] 所有文档链接有效
- [ ] 新开发者能在 30 分钟内完成环境搭建

## 6. 工作量估算

**M (Medium)**

- CONTRIBUTING.md：0.5 天
- ARCHITECTURE.md：1 天
- DEVELOPMENT.md：1 天
- TROUBLESHOOTING.md：1 天
- CODE_OF_CONDUCT.md：0.5 天
- docs/README.md：0.5 天
- README.md 更新：0.5 天

**总计：5 天**

## 7. 优先级理由

**P2** 理由：

1. **降低贡献门槛**：完善的文档让新开发者更容易参与
2. **提高代码质量**：清晰的规范减少代码审查成本
3. **减少重复问题**：故障排查文档减少支持负担
4. **项目专业性**：完善文档体现项目成熟度
5. **长期收益**：一次投入，长期受益

虽然不影响核心功能，但对项目长期健康发展至关重要。
