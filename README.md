# 🎮 Pocket Monster Go — 完整项目代码库

[![CI/CD](https://github.com/kkcc2013-arch/mineGo/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/kkcc2013-arch/mineGo/actions/workflows/ci-cd.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/postgresql-15-blue.svg)](https://www.postgresql.org/)
[![Kubernetes](https://img.shields.io/badge/kubernetes-1.28-blue.svg)](https://kubernetes.io/)

基于真实 GPS 的 AR 精灵捕捉手游，完整全栈实现。

## 📋 目录

- [项目概览](#项目概览)
- [快速启动](#快速启动)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [服务端口](#服务端口)
- [测试结果](#测试结果)
- [文档](#文档)
- [贡献](#贡献)
- [许可证](#许可证)

## 项目概览

mineGo 是一款基于真实 GPS 的 AR 精灵捕捉手游，采用微服务架构，支持大规模并发和全球化部署。

### 核心功能

- 🗺️ **GPS 定位**：真实地理位置，精灵刷新算法
- ⚔️ **捕捉系统**：投球物理模拟，概率计算，奖励结算
- 🏛️ **道馆战斗**：道馆占领，Raid 实时战斗，WebSocket 同步
- 👥 **社交系统**：好友，礼物，精灵交易
- 🎁 **奖励系统**：每日任务，成就，排行榜，赛季
- 💳 **支付系统**：内购，精币充值，安全验证

### 特色亮点

- ✅ 完整的微服务架构（9 个服务）
- ✅ 生产级 CI/CD 流水线
- ✅ 完善的可观测性（日志、指标、追踪）
- ✅ 多层安全防护（认证、反作弊、支付安全）
- ✅ PWA 离线支持
- ✅ 多语言国际化（中/英/日）

## 快速启动

### 一键启动（Docker）

```bash
# 启动所有服务
docker compose up -d

# 等待服务就绪（约 30 秒）
docker compose ps

# 检查服务健康
curl http://localhost:8080/health
```

### 本地开发

```bash
# 1. Clone 项目
git clone https://github.com/kkcc2013-arch/mineGo.git
cd mineGo

# 2. 启动依赖服务
docker compose up -d postgres redis kafka

# 3. 初始化数据库
cd database && node migrate.js up

# 4. 安装依赖并启动
cd backend
npm install
npm run dev
```

详见：[DEVELOPMENT.md](DEVELOPMENT.md)

## 技术栈

### 后端

| 技术 | 版本 | 用途 |
|------|------|------|
| Node.js | 20.x | 运行时环境 |
| Express | 4.x | Web 框架 |
| PostgreSQL | 15 | 主数据库 |
| PostGIS | 3.x | 地理空间扩展 |
| Redis | 7.x | 缓存、会话、GEO 缓存 |
| Kafka | 3.x | 事件消息队列 |
| WebSocket | - | 实时通信 |

### 前端

| 技术 | 用途 |
|------|------|
| 原生 JavaScript | 游戏客户端 |
| HTML/CSS | 管理后台 |
| Service Worker | PWA 离线支持 |

### 基础设施

| 技术 | 版本 | 用途 |
|------|------|------|
| Docker | 24.x | 容器化 |
| Kubernetes | 1.28 | 容器编排 |
| Helm | 3.x | K8s 包管理 |
| GitHub Actions | - | CI/CD |
| Prometheus | 2.x | 监控指标 |
| Grafana | 10.x | 监控仪表板 |
| Jaeger | 1.x | 分布式追踪 |

## 目录结构

```
mineGo/
├── .github/workflows/          # GitHub Actions CI/CD
├── backend/
│   ├── gateway/                # API 网关
│   ├── services/               # 微服务
│   │   ├── user-service/       # 用户服务
│   │   ├── location-service/   # 位置服务
│   │   ├── pokemon-service/    # 精灵服务
│   │   ├── catch-service/      # 捕捉服务
│   │   ├── gym-service/        # 道馆服务
│   │   ├── social-service/     # 社交服务
│   │   ├── reward-service/     # 奖励服务
│   │   └── payment-service/    # 支付服务
│   ├── shared/                 # 共享模块
│   └── tests/                  # 测试文件
├── database/
│   ├── migrations/             # 数据库迁移
│   └── seeds/                  # 种子数据
├── frontend/
│   ├── game-client/            # 游戏客户端
│   └── admin-dashboard/        # 管理后台
├── infrastructure/
│   └── k8s/                    # Kubernetes 配置
├── docs/                       # 文档
├── scripts/                    # 脚本工具
└── docker-compose.yml          # Docker Compose 配置
```

## 服务端口

| 服务 | 端口 | 说明 |
|------|------|------|
| API Gateway | 8080 | 统一入口，所有客户端请求 |
| User Service | 8081 | 账号、认证、资料 |
| Location Service | 8082 | GPS、精灵刷新 |
| Pokemon Service | 8083 | 精灵仓库、图鉴 |
| Catch Service | 8084 | 捕捉流程 |
| Gym Service | 8085 | 道馆、Raid、WebSocket |
| Social Service | 8086 | 好友、礼物、交换 |
| Reward Service | 8087 | 任务、成就、排行榜 |
| Payment Service | 8088 | 内购、充值 |
| Admin Dashboard | 3000 | 运营管理后台 |

## 测试结果

```
✅ catch.test.js   — 25/25 passed (捕捉概率、CP计算、奖励结算)
✅ auth.test.js    — 14/14 passed (JWT签发、验证、中间件)
✅ spawn.test.js   — 15/15 passed (稀有度分布、IV生成、反作弊)
─────────────────────────────────
   总计: 54/54 passed
```

运行测试：
```bash
cd backend
npm test                    # 所有测试
npm run test:unit           # 单元测试
npm run test:integration    # 集成测试
npm run test:coverage       # 覆盖率报告
```

## 文档

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统架构和技术决策 |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 本地开发指南 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 故障排查 |
| [docs/README.md](docs/README.md) | 文档索引 |

## 贡献

我们欢迎所有形式的贡献！

### 快速贡献

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add some feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

详见：[CONTRIBUTING.md](CONTRIBUTING.md)

### 行为准则

本项目采用 [贡献者公约](CODE_OF_CONDUCT.md) 作为行为准则。

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

## 联系方式

- **问题反馈**: [GitHub Issues](https://github.com/kkcc2013-arch/mineGo/issues)
- **功能请求**: [GitHub Discussions](https://github.com/kkcc2013-arch/mineGo/discussions)
- **安全问题**: security@minego.example.com

---

⭐ 如果这个项目对你有帮助，请给一个 Star！
