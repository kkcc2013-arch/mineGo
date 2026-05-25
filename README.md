# 🎮 Pocket Monster Go — 完整项目代码库

## 项目概览

基于真实 GPS 的 AR 精灵捕捉手游，完整全栈实现。

## 目录结构

```
pmg/
├── .github/workflows/ci-cd.yml        # GitHub Actions CI/CD（测试→构建→灰度→全量部署）
├── backend/
│   ├── Dockerfile                     # 通用多服务 Dockerfile（BUILD_ARG选择服务）
│   ├── package.json                   # Monorepo 根配置
│   ├── shared/                        # 共享模块
│   │   ├── auth.js                    # JWT签发/验证/Express中间件
│   │   ├── db.js                      # PostgreSQL连接池+事务
│   │   └── redis.js                   # Redis客户端+GEO工具
│   ├── gateway/src/index.js           # API网关（路由/限流/鉴权/代理）
│   ├── services/
│   │   ├── user-service/              # 注册/登录/资料/队伍/每日任务
│   │   ├── location-service/          # GPS上报/精灵刷新算法/附近查询
│   │   ├── pokemon-service/           # 精灵仓库/图鉴/进化/强化/补给站
│   │   ├── catch-service/             # 捕捉会话/投球物理/概率计算/结算
│   │   ├── gym-service/               # 道馆占领/战斗/Raid/WebSocket实时
│   │   ├── social-service/            # 好友/礼物/精灵交换
│   │   ├── reward-service/            # 签到奖励/每日任务/成就/排行榜/赛季
│   │   └── payment-service/           # 内购订单/精币充值/支付验证
│   └── tests/unit/
│       ├── catch.test.js              # 25个捕捉逻辑测试（全部通过✅）
│       ├── auth.test.js               # 14个JWT认证测试（全部通过✅）
│       └── spawn.test.js              # 15个刷新/反作弊测试（全部通过✅）
├── database/
│   ├── migrations/V1__initial_schema.sql  # 完整DB Schema（23张表，PostGIS）
│   └── seeds/V2__seed_data.sql            # 精灵种族数据+上海POI数据
├── frontend/
│   ├── admin-dashboard/index.html     # 运营管理后台（单文件，无需构建）
│   └── game-client/src/
│       ├── api/client.js              # 统一API客户端（自动刷新Token）
│       ├── game/LocationManager.js    # GPS追踪+速度反作弊+服务器同步
│       ├── game/CatchEngine.js        # 投球物理+抛物线动画+捕捉状态机
│       ├── game/RaidManager.js        # Raid WebSocket+断线重连+战斗同步
│       ├── game/GameStore.js          # 响应式全局状态管理
│       └── main.js                   # 主入口，串联所有模块
├── infrastructure/
│   └── k8s/base/
│       ├── 00-namespace-config.yaml   # Namespace/ConfigMap/Secret
│       └── 01-deployments.yaml        # 9个服务Deployment+Service+HPA+Ingress+PDB
└── docker-compose.yml                 # 一键本地开发环境（全服务+DB+Redis+Kafka）
```

## 快速启动

```bash
# 一键启动所有服务
docker compose up -d

# 检查服务健康
curl http://localhost:8080/health

# 运行所有单元测试
cd backend
node tests/unit/catch.test.js   # 25 tests
node tests/unit/auth.test.js    # 14 tests  
node tests/unit/spawn.test.js   # 15 tests
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

## 技术栈

- **后端**: Node.js 20 + Express, PostgreSQL 15 + PostGIS, Redis 7, Kafka, WebSocket
- **前端**: 原生 JS (game client) + 纯 HTML (admin dashboard)
- **基础设施**: Docker + Kubernetes 1.28 + Helm, 阿里云 ACK
- **CI/CD**: GitHub Actions (测试→构建→Canary 5%→全量部署)

## 测试结果

```
✅ catch.test.js   — 25/25 passed (捕捉概率、CP计算、奖励结算)
✅ auth.test.js    — 14/14 passed (JWT签发、验证、中间件)
✅ spawn.test.js   — 15/15 passed (稀有度分布、IV生成、反作弊)
─────────────────────────────────
   总计: 54/54 passed
```
