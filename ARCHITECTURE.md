# 系统架构

本文档描述 mineGo 的系统架构、技术栈和关键设计决策。

## 📋 目录

- [技术栈](#技术栈)
- [系统架构图](#系统架构图)
- [微服务职责](#微服务职责)
- [数据流](#数据流)
- [数据库设计](#数据库设计)
- [事件驱动架构](#事件驱动架构)
- [安全机制](#安全机制)
- [可观测性](#可观测性)
- [设计决策](#设计决策)
- [性能优化](#性能优化)

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
| WebSocket | - | 实时通信（Raid 战斗） |

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
| Alertmanager | - | 告警管理 |
| Jaeger | 1.x | 分布式追踪 |

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        Game Client                               │
│                   (Native JavaScript + PWA)                      │
└─────────────────────────────┬───────────────────────────────────┘
                              │ HTTPS / WebSocket
┌─────────────────────────────▼───────────────────────────────────┐
│                      API Gateway (8080)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ JWT 认证  │ │   限流   │ │   路由   │ │   熔断   │           │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼──────┐      ┌───────▼──────┐      ┌───────▼──────┐
│ User Service │      │   Location   │      │    Catch     │
│    (8081)    │      │   (8082)     │      │   (8084)     │
│              │      │              │      │              │
│ • 注册登录   │      │ • GPS 上报   │      │ • 捕捉流程   │
│ • 用户资料   │      │ • 精灵刷新   │      │ • 投球物理   │
│ • 时区管理   │      │ • 附近查询   │      │ • 概率计算   │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │
┌──────▼──────┐      ┌───────▼──────┐      ┌───────▼──────┐
│   Pokemon   │      │     Gym      │      │   Social     │
│   (8083)    │      │   (8085)     │      │   (8086)     │
│             │      │              │      │              │
│ • 精灵仓库  │      │ • 道馆占领   │      │ • 好友系统   │
│ • 图鉴数据  │      │ • Raid 战斗  │      │ • 精灵交易   │
│ • 技能管理  │      │ • WebSocket  │      │ • 礼物系统   │
└──────┬──────┘      └──────┬───────┘      └──────┬───────┘
       │                    │                     │
┌──────▼──────┐      ┌──────▼──────┐      ┌───────▼──────┐
│   Reward    │      │   Payment   │      │    Redis     │
│   (8087)    │      │   (8088)    │      │    Cache     │
│             │      │             │      │              │
│ • 任务系统  │      │ • 内购订单  │      │ • GEO 缓存   │
│ • 成就系统  │      │ • 精币充值  │      │ • 会话存储   │
│ • 排行榜    │      │ • 支付验证  │      │ • 黑名单     │
└─────────────┘      └─────────────┘      └──────────────┘
                              │
              ┌───────────────▼───────────────┐
              │         PostgreSQL            │
              │          + PostGIS            │
              │                               │
              │  • 用户数据                    │
              │  • 精灵实例                    │
              │  • 道馆数据                    │
              │  • 交易记录                    │
              └───────────────────────────────┘
                              │
              ┌───────────────▼───────────────┐
              │            Kafka              │
              │                               │
              │  • pokemon.caught             │
              │  • gym.battle                 │
              │  • user.level_up              │
              │  • reward.claimed             │
              └───────────────────────────────┘
```

## 微服务职责

| 服务 | 端口 | 职责 | 关键 API |
|------|------|------|----------|
| **gateway** | 8080 | API 网关、认证、限流、熔断 | `/auth/*`, `/api/*` |
| **user-service** | 8081 | 用户注册、登录、资料、时区 | `/users/*`, `/auth/*` |
| **location-service** | 8082 | GPS 上报、精灵刷新、附近查询 | `/location/*`, `/nearby/*` |
| **pokemon-service** | 8083 | 精灵仓库、图鉴、技能、进化 | `/pokemon/*`, `/pokedex/*` |
| **catch-service** | 8084 | 捕捉流程、投球物理、结算 | `/catch/*` |
| **gym-service** | 8085 | 道馆占领、Raid 战斗、WebSocket | `/gyms/*`, `/raids/*` |
| **social-service** | 8086 | 好友、礼物、精灵交易 | `/friends/*`, `/trades/*` |
| **reward-service** | 8087 | 任务、成就、排行榜、赛季 | `/tasks/*`, `/achievements/*` |
| **payment-service** | 8088 | 内购、充值、订单管理 | `/payments/*`, `/orders/*` |

## 数据流

### 捕捉流程

```
1. 客户端上报 GPS → location-service
2. location-service 返回附近精灵列表
3. 客户端选择精灵发起捕捉 → catch-service
4. catch-service:
   a. 验证 GPS 合法性（反作弊）
   b. 计算捕捉概率
   c. 执行捕捉逻辑
   d. 发布 pokemon.caught 事件
5. user-service 消费事件 → 更新用户统计
6. social-service 消费事件 → 通知好友
```

### Raid 战斗流程

```
1. 客户端加入 Raid → gym-service (WebSocket)
2. gym-service 创建战斗房间
3. 实时同步战斗状态（WebSocket）
4. 战斗结束:
   a. 计算奖励
   b. 发布 gym.battle 事件
   c. reward-service 发放奖励
```

### 支付流程

```
1. 客户端发起支付 → payment-service
2. payment-service:
   a. 生成幂等键
   b. 创建待支付订单
   c. 调用支付渠道
3. 支付回调:
   a. 验证签名
   b. 更新订单状态
   c. 发放虚拟商品
```

## 数据库设计

### 核心表

```sql
-- 用户表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  team VARCHAR(10), -- 'valor', 'mystic', 'instinct'
  level INTEGER DEFAULT 1,
  experience INTEGER DEFAULT 0,
  timezone VARCHAR(50) DEFAULT 'UTC',
  language VARCHAR(10) DEFAULT 'zh-CN',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 精灵实例表
CREATE TABLE pokemon_instances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  species_id INTEGER NOT NULL,
  cp INTEGER NOT NULL,
  iv_attack INTEGER CHECK (iv_attack BETWEEN 0 AND 15),
  iv_defense INTEGER CHECK (iv_defense BETWEEN 0 AND 15),
  iv_stamina INTEGER CHECK (iv_stamina BETWEEN 0 AND 15),
  learned_fast_moves INTEGER[],
  learned_charge_moves INTEGER[],
  caught_at TIMESTAMP DEFAULT NOW(),
  caught_location GEOGRAPHY(POINT)
);

-- 精灵种族表
CREATE TABLE pokemon_species (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  type_primary VARCHAR(20),
  type_secondary VARCHAR(20),
  base_attack INTEGER,
  base_defense INTEGER,
  base_stamina INTEGER,
  rarity VARCHAR(20) -- 'common', 'uncommon', 'rare', 'epic', 'legendary'
);

-- 道馆表
CREATE TABLE gyms (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  team VARCHAR(10),
  prestige INTEGER DEFAULT 0,
  raid_active BOOLEAN DEFAULT FALSE,
  raid_end_time TIMESTAMP
);

-- 好友关系表
CREATE TABLE friendships (
  id SERIAL PRIMARY KEY,
  user_id_1 INTEGER REFERENCES users(id),
  user_id_2 INTEGER REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'blocked'
  friendship_level INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id_1, user_id_2)
);

-- 交易记录表
CREATE TABLE trades (
  id SERIAL PRIMARY KEY,
  initiator_id INTEGER REFERENCES users(id),
  recipient_id INTEGER REFERENCES users(id),
  initiator_pokemon_id INTEGER,
  recipient_pokemon_id INTEGER,
  stardust_cost INTEGER,
  status VARCHAR(20), -- 'pending', 'completed', 'cancelled'
  created_at TIMESTAMP DEFAULT NOW()
);

-- 支付订单表
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  order_id VARCHAR(100) UNIQUE NOT NULL,
  idempotency_key VARCHAR(100) UNIQUE,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'CNY',
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'paid', 'failed', 'refunded'
  payment_provider VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 地理查询

使用 PostGIS 扩展进行地理查询：

```sql
-- 查询附近精灵
SELECT * FROM wild_pokemon
WHERE ST_DWithin(
  location,
  ST_MakePoint(:lng, :lat)::geography,
  :radius
)
ORDER BY ST_Distance(location, ST_MakePoint(:lng, :lat))
LIMIT 50;

-- 查询附近道馆
SELECT * FROM gyms
WHERE ST_DWithin(
  location,
  ST_MakePoint(:lng, :lat)::geography,
  :radius
);
```

### 索引设计

```sql
-- 用户查询索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);

-- 精灵查询复合索引
CREATE INDEX idx_pokemon_user_species ON pokemon_instances(user_id, species_id);
CREATE INDEX idx_pokemon_user_cp ON pokemon_instances(user_id, cp DESC);

-- 地理位置索引
CREATE INDEX idx_gyms_location ON gyms USING GIST(location);
CREATE INDEX idx_wild_pokemon_location ON wild_pokemon USING GIST(location);

-- 支付订单索引
CREATE INDEX idx_payments_user_status ON payments(user_id, status);
CREATE INDEX idx_payments_idempotency ON payments(idempotency_key);
```

## 事件驱动架构

### Kafka Topics

| Topic | 生产者 | 消费者 | 说明 |
|-------|--------|--------|------|
| `pokemon.caught` | catch-service | user-service, social-service | 精灵捕捉事件 |
| `gym.battle` | gym-service | reward-service | 道馆战斗事件 |
| `user.level_up` | user-service | reward-service | 用户升级事件 |
| `reward.claimed` | reward-service | user-service | 奖励领取事件 |
| `trade.completed` | social-service | user-service, pokemon-service | 交易完成事件 |

### 事件格式

```json
{
  "eventId": "uuid-v4",
  "eventType": "pokemon.caught",
  "timestamp": "2026-06-05T23:00:00Z",
  "source": "catch-service",
  "data": {
    "userId": 123,
    "pokemonId": 456,
    "speciesId": 25,
    "cp": 1500,
    "location": { "lat": 31.2304, "lng": 121.4737 }
  },
  "metadata": {
    "traceId": "trace-uuid",
    "spanId": "span-uuid"
  }
}
```

### 事件处理示例

```javascript
// catch-service 发布事件
await eventBus.publish('pokemon.caught', {
  userId,
  pokemonId,
  speciesId,
  cp,
  location
});

// user-service 消费事件
eventBus.subscribe('pokemon.caught', async (event) => {
  await updateUserStats(event.userId, {
    totalCaught: { $inc: 1 },
    lastCatchAt: event.timestamp
  });
});

// social-service 消费事件
eventBus.subscribe('pokemon.caught', async (event) => {
  const friends = await getFriends(event.userId);
  for (const friend of friends) {
    await notifyFriend(friend.id, {
      type: 'friend_caught',
      data: event
    });
  }
});
```

## 安全机制

### 认证授权

```
1. 用户登录 → JWT Token 签发
2. 请求携带 Token → Gateway 验证
3. Token 解析 → 用户信息注入请求
4. 服务处理 → 业务逻辑执行
```

**JWT Payload:**
```json
{
  "sub": "user-123",
  "username": "player1",
  "team": "valor",
  "level": 30,
  "iat": 1717632000,
  "exp": 1717718400
}
```

### GPS 反作弊

```javascript
// 速度检测
function validateMovement(lastLocation, newLocation, timeDiff) {
  const distance = calculateDistance(lastLocation, newLocation);
  const speed = distance / timeDiff; // m/s
  
  // 人类移动速度上限约 50 m/s (180 km/h)
  if (speed > 50) {
    throw new Error('Movement speed exceeds limit');
  }
  
  // 检测瞬移
  if (distance > 1000 && timeDiff < 60) {
    throw new Error('Possible teleport detected');
  }
}
```

### 支付安全

1. **幂等性保证**: 使用 Redis SETNX 原子操作
2. **签名验证**: HMAC-SHA256 验证支付回调
3. **状态机**: 严格的状态转换验证
4. **金额校验**: 服务端重新计算金额

### 数据保护

- **敏感数据加密**: AES-256-GCM
- **数据脱敏**: 日志中隐藏敏感信息
- **GDPR 合规**: 支持数据导出和删除

## 可观测性

### 日志

```javascript
// 结构化日志
logger.info({
  userId: 123,
  action: 'catch_pokemon',
  pokemonId: 456,
  duration: 150,
  traceId: 'trace-uuid'
}, 'Pokemon caught successfully');
```

### 指标

```
# Prometheus 指标示例

# 请求计数
http_requests_total{method="GET", path="/api/pokemon", status="200"} 1234

# 请求延迟
http_request_duration_seconds{method="GET", path="/api/pokemon"} 0.045

# 缓存命中率
cache_hits_total{layer="redis"} 5678
cache_misses_total 123

# 数据库连接池
db_pool_active_connections 15
db_pool_idle_connections 5
```

### 链路追踪

```
Trace: trace-uuid
├── Span: gateway (10ms)
│   ├── Span: auth-middleware (2ms)
│   └── Span: proxy-to-service (5ms)
│       └── Span: catch-service (150ms)
│           ├── Span: validate-gps (5ms)
│           ├── Span: calculate-probability (1ms)
│           ├── Span: db-query (50ms)
│           └── Span: publish-event (10ms)
```

### 告警规则

```yaml
# 关键告警规则
- alert: HighErrorRate
  expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: High error rate detected

- alert: DatabaseConnectionPoolExhausted
  expr: db_pool_active_connections / db_pool_max_connections > 0.9
  for: 2m
  labels:
    severity: warning
```

## 设计决策

### 为什么选择微服务架构？

**优点:**
- 独立部署和扩展
- 技术栈灵活
- 故障隔离
- 团队协作友好

**代价:**
- 运维复杂度高
- 分布式事务挑战
- 服务间通信延迟

**决策:** 对于游戏后端，微服务的优势大于代价。

### 为什么选择 PostgreSQL + PostGIS？

**理由:**
- 强大的地理查询能力
- ACID 事务保证
- 成熟的生态系统
- 与 Node.js 集成良好

**替代方案:** MongoDB + geo queries
**决策:** PostgreSQL 更适合复杂查询和事务场景。

### 为什么选择 Kafka？

**理由:**
- 高吞吐量
- 消息持久化
- 支持事件回放
- 解耦服务依赖

**替代方案:** RabbitMQ
**决策:** Kafka 更适合事件驱动架构。

### 为什么选择原生 JavaScript？

**理由:**
- 无构建步骤，部署简单
- 性能足够
- 团队熟悉

**替代方案:** React/Vue
**决策:** 游戏客户端交互复杂，原生 JS 更灵活。

## 性能优化

### 缓存策略

| 数据类型 | 缓存层 | TTL | 说明 |
|---------|--------|-----|------|
| 精灵图鉴 | Redis | 1h | 静态数据 |
| 用户资料 | Redis | 5min | 频繁访问 |
| 附近精灵 | Redis GEO | 30s | 实时性要求高 |
| 好友列表 | Redis | 3min | 中等频率 |

### 数据库优化

1. **连接池**: 复用连接，减少开销
2. **复合索引**: 优化查询性能
3. **读写分离**: 未来扩展
4. **分库分表**: 未来扩展

### 服务优化

1. **异步处理**: Kafka 事件驱动
2. **熔断降级**: 防止级联故障
3. **限流保护**: 防止过载
4. **水平扩展**: HPA 自动扩容

### 性能基准

| API | P50 | P95 | P99 | 目标 |
|-----|-----|-----|-----|------|
| GET /nearby | 50ms | 100ms | 200ms | < 100ms |
| POST /catch | 100ms | 200ms | 500ms | < 200ms |
| GET /pokedex | 5ms | 10ms | 20ms | < 10ms |
| GET /profile | 10ms | 30ms | 50ms | < 30ms |
