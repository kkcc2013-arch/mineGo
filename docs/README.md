# mineGo 文档中心

欢迎来到 mineGo 项目文档中心。这里汇集了所有项目相关文档。

## 📋 快速导航

### 🚀 新手入门

| 文档 | 说明 |
|------|------|
| [README.md](../README.md) | 项目概览和快速开始 |
| [DEVELOPMENT.md](../DEVELOPMENT.md) | 本地开发环境设置 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献指南 |
| [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | 社区行为准则 |

### 🏗️ 架构设计

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](../ARCHITECTURE.md) | 系统架构和技术决策 |
| [数据库设计](#数据库设计) | 数据库 Schema 和迁移 |
| [微服务设计](#微服务设计) | 微服务职责和通信 |

### 📖 API 文档

| 文档 | 说明 |
|------|------|
| [API 设计规范](./api-spec/API-DESIGN-GUIDELINES.md) | RESTful API 设计规范 |
| [错误码定义](./api-spec/error-codes.md) | 统一错误码规范 |
| [Swagger UI](http://localhost:8080/swagger) | 在线 API 文档 |

### 📊 需求管理

| 文档 | 说明 |
|------|------|
| [需求索引](./requirements/INDEX.md) | 所有需求列表 |
| [项目状态](./requirements/STATUS.md) | 项目成熟度评估 |
| [已完成需求](./requirements/DONE.md) | 已完成需求详情 |

### 🧪 测试文档

| 文档 | 说明 |
|------|------|
| [测试指南](../backend/tests/README.md) | 单元测试说明 |
| [集成测试](../backend/tests/INTEGRATION.md) | 集成测试说明 |

### 🔧 故障排查

| 文档 | 说明 |
|------|------|
| [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) | 常见问题和解决方案 |

---

## 数据库设计

### 核心表

| 表名 | 说明 | 主要字段 |
|------|------|----------|
| `users` | 用户信息 | id, username, email, team, level |
| `pokemon_instances` | 精灵实例 | id, user_id, species_id, cp, iv_* |
| `pokemon_species` | 精灵种族 | id, name, type_*, base_* |
| `gyms` | 道馆 | id, location, team, prestige |
| `friendships` | 好友关系 | user_id_1, user_id_2, status |
| `trades` | 交易记录 | initiator_id, recipient_id, status |
| `payments` | 支付订单 | user_id, order_id, amount, status |

### 迁移管理

```bash
# 查看迁移状态
cd database && node migrate.js status

# 执行迁移
node migrate.js up

# 回滚迁移
node migrate.js down
```

详见：[数据库迁移文档](../database/README.md)

---

## 微服务设计

### 服务架构

```
┌─────────────┐
│   Gateway   │  ← API 网关、认证、限流、熔断
└──────┬──────┘
       │
   ┌───┴───┬───────┬───────┬───────┐
   │       │       │       │       │
┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌──▼──┐ ┌──▼──┐
│User │ │Loc  │ │Pkmon│ │Catch│ │Gym  │ ...
└─────┘ └─────┘ └─────┘ └─────┘ └─────┘
```

### 服务职责

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

详见：[ARCHITECTURE.md](../ARCHITECTURE.md)

---

## 文档结构

```
docs/
├── README.md                 # 本文档（文档索引）
├── api-spec/                 # API 规范
│   ├── API-DESIGN-GUIDELINES.md  # API 设计规范
│   └── error-codes.md            # 错误码定义
├── requirements/             # 需求管理
│   ├── INDEX.md              # 需求总索引
│   ├── STATUS.md             # 项目成熟度评估
│   ├── DONE.md               # 完成说明
│   └── REQ-*.md              # 需求文档
└── review/                   # 代码审查
    └── REQ-*-review.md       # 审核文档
```

---

## 文档更新

文档与代码同步更新。如果您发现文档过期或有误，请：

1. 提交 Issue 说明问题
2. 提交 PR 修复文档
3. 在代码审查时指出文档问题

### 文档贡献原则

1. **清晰简洁**：避免冗长，直奔主题
2. **示例代码**：提供可运行的代码示例
3. **保持更新**：代码变更时同步更新文档
4. **格式统一**：遵循 Markdown 规范

---

## 外部资源

- **GitHub**: https://github.com/kkcc2013-arch/mineGo
- **问题反馈**: [GitHub Issues](https://github.com/kkcc2013-arch/mineGo/issues)
- **社区讨论**: [Discord](#) (待建立)

---

## 文档版本

- **最后更新**: 2026-06-05
- **维护者**: mineGo 开发团队

如有疑问，请查阅 [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) 或提交 Issue。
