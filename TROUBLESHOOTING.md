# 故障排查指南

本指南帮助您诊断和解决 mineGo 常见问题。

## 📋 目录

- [服务启动问题](#服务启动问题)
- [数据库问题](#数据库问题)
- [Redis 问题](#redis-问题)
- [Kafka 问题](#kafka-问题)
- [性能问题](#性能问题)
- [认证问题](#认证问题)
- [支付问题](#支付问题)
- [反作弊问题](#反作弊问题)
- [监控问题](#监控问题)
- [日志问题](#日志问题)

## 服务启动问题

### 问题：服务启动失败

**症状:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**原因:** PostgreSQL 未启动或连接配置错误

**解决方案:**
```bash
# 1. 检查 PostgreSQL 状态
docker compose ps postgres

# 2. 启动 PostgreSQL
docker compose up -d postgres

# 3. 检查连接配置
cat backend/.env | grep DB_

# 4. 测试连接
docker compose exec postgres psql -U postgres -c "SELECT 1"
```

---

### 问题：端口被占用

**症状:**
```
Error: listen EADDRINUSE: address already in use :::8080
```

**解决方案:**
```bash
# 查找占用端口的进程
lsof -i :8080

# 杀死进程
kill -9 <PID>

# 或修改端口配置
# 在 .env 中修改相应端口
```

---

### 问题：服务健康检查失败

**症状:**
```
curl http://localhost:8080/health
# 返回 502 或超时
```

**解决方案:**
```bash
# 1. 检查服务是否运行
docker compose ps

# 2. 查看服务日志
docker compose logs user-service

# 3. 检查依赖服务
docker compose ps postgres redis

# 4. 重启服务
docker compose restart user-service
```

---

## 数据库问题

### 问题：迁移失败

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
```

---

### 问题：PostGIS 扩展未安装

**症状:**
```
ERROR: function st_dwithin(geometry, geometry, double precision) does not exist
```

**解决方案:**
```sql
-- 连接数据库
docker compose exec postgres psql -U postgres -d minego

-- 安装 PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- 验证
SELECT PostGIS_Version();
```

---

### 问题：数据库连接池耗尽

**症状:**
```
Error: remaining connection slots are reserved for non-replication superuser connections
```

**解决方案:**
```bash
# 1. 检查当前连接数
docker compose exec postgres psql -U postgres -c \
  "SELECT count(*) FROM pg_stat_activity;"

# 2. 查看连接来源
docker compose exec postgres psql -U postgres -c \
  "SELECT client_addr, count(*) FROM pg_stat_activity GROUP BY client_addr;"

# 3. 增加最大连接数
# postgresql.conf: max_connections = 200

# 4. 或优化应用连接池配置
# db.js: max: 20, min: 5
```

---

### 问题：慢查询

**症状:** API 响应时间 > 1s

**解决方案:**
```sql
-- 1. 查看慢查询
SELECT * FROM pg_stat_statements 
ORDER BY total_exec_time DESC 
LIMIT 10;

-- 2. 分析查询计划
EXPLAIN ANALYZE 
SELECT * FROM pokemon_instances WHERE user_id = 1;

-- 3. 添加索引
CREATE INDEX idx_pokemon_user ON pokemon_instances(user_id);

-- 4. 更新统计信息
ANALYZE pokemon_instances;
```

---

## Redis 问题

### 问题：Redis 连接超时

**症状:**
```
Error: Redis connection timeout
```

**解决方案:**
```bash
# 1. 检查 Redis 状态
docker compose ps redis

# 2. 重启 Redis
docker compose restart redis

# 3. 检查 Redis 日志
docker compose logs redis

# 4. 测试连接
docker compose exec redis redis-cli ping
```

---

### 问题：Redis 内存不足

**症状:**
```
OOM command not allowed when used memory > 'maxmemory'
```

**解决方案:**
```bash
# 1. 查看内存使用
docker compose exec redis redis-cli INFO memory

# 2. 查看大键
docker compose exec redis redis-cli --bigkeys

# 3. 设置内存策略
docker compose exec redis redis-cli CONFIG SET maxmemory-policy allkeys-lru

# 4. 增加内存限制
# redis.conf: maxmemory 2gb
```

---

### 问题：缓存穿透

**症状:** 数据库负载突然升高

**解决方案:**
```javascript
// 实现空值缓存
async function getWithCache(key, fetchFn, ttl = 300) {
  const cached = await redis.get(key);
  
  if (cached !== null) {
    // 空值也缓存
    return cached === 'NULL' ? null : JSON.parse(cached);
  }
  
  const value = await fetchFn();
  
  // 缓存空值，使用较短 TTL
  await redis.setex(
    key, 
    value === null ? 60 : ttl,  // 空值缓存 60 秒
    value === null ? 'NULL' : JSON.stringify(value)
  );
  
  return value;
}
```

---

## Kafka 问题

### 问题：Kafka 连接失败

**症状:**
```
Error: Kafka broker not available
```

**解决方案:**
```bash
# 1. 检查 Kafka 状态
docker compose ps kafka

# 2. Kafka 启动较慢，等待 30-60 秒
docker compose logs -f kafka

# 3. 重启 Kafka
docker compose restart kafka

# 4. 检查 Zookeeper
docker compose ps zookeeper
docker compose restart zookeeper
```

---

### 问题：消息堆积

**症状:** 消息消费延迟持续增加

**解决方案:**
```bash
# 1. 查看消费者组状态
docker compose exec kafka kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --group user-service

# 2. 增加消费者数量
# 调整服务实例数

# 3. 检查死信队列
docker compose exec kafka kafka-console-consumer.sh \
  --topic pokemon.caught.dlq \
  --bootstrap-server localhost:9092
```

---

## 性能问题

### 问题：附近精灵查询慢

**症状:** 查询延迟 > 500ms

**解决方案:**
```bash
# 1. 检查 Redis GEO 缓存是否启用
docker compose exec redis redis-cli KEYS "nearby:*"

# 2. 检查 PostGIS 索引
docker compose exec postgres psql -U postgres -d minego -c \
  "SELECT indexname FROM pg_indexes WHERE tablename = 'wild_pokemon';"

# 3. 分析查询计划
docker compose exec postgres psql -U postgres -d minego -c \
  "EXPLAIN ANALYZE SELECT * FROM wild_pokemon WHERE ST_DWithin(location, ST_MakePoint(121.47, 31.23)::geography, 1000);"
```

---

### 问题：服务内存占用高

**症状:** Node.js 进程内存 > 500MB

**解决方案:**
```bash
# 1. 生成堆快照
kill -USR2 <PID>

# 2. 使用 Chrome DevTools 分析
# chrome://inspect

# 3. 检查内存泄漏
node --inspect services/user-service/src/index.js

# 4. 增加内存限制
export NODE_OPTIONS="--max-old-space-size=4096"
```

---

### 问题：CPU 使用率高

**症状:** CPU 使用率持续 > 80%

**解决方案:**
```bash
# 1. 使用 clinic.js 分析
npx clinic doctor -- node services/user-service/src/index.js

# 2. 检查热点函数
npx clinic flame -- node services/user-service/src/index.js

# 3. 查看事件循环延迟
# 在代码中添加:
const { monitorEventLoopDelay } = require('perf_hooks');
const h = monitorEventLoopDelay();
h.enable();
```

---

## 认证问题

### 问题：JWT 验证失败

**症状:**
```
Error: invalid signature
```

**解决方案:**
```bash
# 1. 检查 JWT_SECRET 环境变量
cat backend/.env | grep JWT_SECRET

# 2. 确保 Gateway 和 User Service 使用相同密钥

# 3. 检查 token 是否过期
# 解码 JWT 查看 payload
echo "eyJhbGc..." | base64 -d

# 4. 清除浏览器缓存重新登录
```

---

### 问题：用户被强制登出

**症状:** 频繁需要重新登录

**原因:** JWT 黑名单或 token 过期

**解决方案:**
```bash
# 1. 检查 Redis 黑名单
docker compose exec redis redis-cli KEYS "jwt:blacklist:*"

# 2. 查看黑名单原因
docker compose exec redis redis-cli GET "jwt:blacklist:<token-hash>"

# 3. 清除黑名单（谨慎操作）
docker compose exec redis redis-cli DEL "jwt:blacklist:*"

# 4. 检查 token 过期时间配置
cat backend/.env | grep JWT_EXPIRES_IN
```

---

### 问题：权限不足

**症状:**
```
Error: Insufficient permissions
```

**解决方案:**
```bash
# 1. 检查用户角色
docker compose exec postgres psql -U postgres -d minego -c \
  "SELECT id, username, role FROM users WHERE id = <USER_ID>;"

# 2. 检查 API 权限配置
# 在路由中检查权限中间件

# 3. 更新用户角色（管理员操作）
docker compose exec postgres psql -U postgres -d minego -c \
  "UPDATE users SET role = 'admin' WHERE id = <USER_ID>;"
```

---

## 支付问题

### 问题：订单重复扣款

**症状:** 用户报告重复扣款

**解决方案:**
```bash
# 1. 查看订单状态
docker compose exec postgres psql -U postgres -d minego -c \
  "SELECT * FROM payments WHERE user_id = <USER_ID> ORDER BY created_at DESC;"

# 2. 检查幂等性键
docker compose exec postgres psql -U postgres -d minego -c \
  "SELECT idempotency_key, count(*) FROM payments GROUP BY idempotency_key HAVING count(*) > 1;"

# 3. 检查 Redis 幂等性缓存
docker compose exec redis redis-cli KEYS "payment:idempotency:*"

# 4. 处理重复订单
# 退款或合并订单
```

---

### 问题：支付回调验证失败

**症状:**
```
Error: Invalid payment signature
```

**解决方案:**
```bash
# 1. 检查支付密钥配置
cat backend/.env | grep PAYMENT_

# 2. 查看回调日志
docker compose logs payment-service | grep "callback"

# 3. 验证签名算法
# 确保与支付渠道文档一致

# 4. 测试回调
curl -X POST http://localhost:8088/payment/callback \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
```

---

## 反作弊问题

### 问题：正常用户被误判为作弊

**症状:** 用户报告捕捉失败

**解决方案:**
```bash
# 1. 查看反作弊记录
docker compose exec postgres psql -U postgres -d minego -c \
  "SELECT * FROM anti_cheat_events WHERE user_id = <USER_ID> ORDER BY created_at DESC;"

# 2. 检查 GPS 速度检测阈值
cat backend/.env | grep ANTI_CHEAT_

# 3. 查看用户移动历史
docker compose exec postgres psql -U postgres -d minego -c \
  "SELECT * FROM location_history WHERE user_id = <USER_ID> ORDER BY timestamp DESC LIMIT 20;"

# 4. 解除封禁（管理员操作）
curl -X DELETE http://localhost:8080/admin/anti-cheat/ban/<USER_ID> \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

---

### 问题：作弊检测不生效

**症状:** 明显作弊行为未被检测

**解决方案:**
```bash
# 1. 检查反作弊中间件是否启用
grep -r "anti-cheat" backend/services/*/src/index.js

# 2. 查看反作弊配置
cat backend/.env | grep ANTI_CHEAT_

# 3. 测试反作弊逻辑
curl -X POST http://localhost:8084/catch \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"lat": 31.2304, "lng": 121.4737, "pokemonId": 1}'

# 4. 调整检测阈值
# ANTI_CHEAT_SPEED_LIMIT=50  # m/s
# ANTI_CHEAT_TELEPORT_DISTANCE=1000  # meters
```

---

## 监控问题

### 问题：Prometheus 指标不显示

**症状:** Grafana 无数据

**解决方案:**
```bash
# 1. 检查 Prometheus 配置
kubectl get configmap -n monitoring prometheus-config

# 2. 检查服务 /metrics 端点
curl http://localhost:8080/metrics

# 3. 检查 Prometheus targets
curl http://localhost:9090/api/v1/targets

# 4. 重启 Prometheus
kubectl rollout restart deployment/prometheus -n monitoring
```

---

### 问题：告警不触发

**症状:** 服务异常但无告警

**解决方案:**
```bash
# 1. 检查告警规则配置
cat infrastructure/k8s/monitoring/prometheus-rules.yml

# 2. 检查 Alertmanager 配置
cat infrastructure/k8s/monitoring/alertmanager.yml

# 3. 查看告警状态
curl http://localhost:9093/api/v1/alerts

# 4. 测试告警通道
curl -X POST http://localhost:9093/api/v1/alerts \
  -H "Content-Type: application/json" \
  -d '[{"labels":{"alertname":"TestAlert"},"annotations":{"summary":"Test alert"}}]'
```

---

### 问题：链路追踪不完整

**症状:** Jaeger 中缺少某些服务的 trace

**解决方案:**
```bash
# 1. 检查 OpenTelemetry 配置
cat backend/.env | grep OTEL_

# 2. 检查 Jaeger Agent
docker compose ps jaeger

# 3. 确保所有服务集成 tracing
grep -r "tracing" backend/services/*/src/index.js

# 4. 检查 trace context 传递
# 确保跨服务调用传递 trace headers
```

---

## 日志问题

### 问题：日志丢失或格式错误

**症状:** 日志不完整或非 JSON 格式

**解决方案:**
```bash
# 1. 检查 Pino 日志配置
cat backend/.env | grep LOG_

# 2. 检查日志级别
cat backend/.env | grep LOG_LEVEL

# 3. 测试日志输出
curl http://localhost:8080/test/log
docker compose logs user-service | grep "test"

# 4. 检查日志输出目标
# 确保日志正确输出到 stdout/stderr
```

---

### 问题：日志量过大

**症状:** 磁盘空间不足

**解决方案:**
```bash
# 1. 调整日志级别
# LOG_LEVEL=warn  # 只记录 warn 及以上

# 2. 配置日志轮转
# 使用 logrotate 或 Docker 日志配置

# 3. 减少敏感日志
# 避免记录大量请求体

# 4. 使用日志聚合
# ELK / Loki 等
```

---

## 快速诊断命令

```bash
# 一键健康检查
./scripts/health-check.sh

# 查看所有服务状态
docker compose ps

# 查看所有服务日志
docker compose logs --tail=50

# 检查系统资源
docker stats

# 检查网络连接
docker network inspect minego_default

# 数据库连接测试
docker compose exec postgres psql -U postgres -c "SELECT 1"

# Redis 连接测试
docker compose exec redis redis-cli ping

# Kafka 连接测试
docker compose exec kafka kafka-broker-api-versions.sh --bootstrap-server localhost:9092
```

---

## 获取帮助

如果以上方案都无法解决问题：

1. **查看文档**: [ARCHITECTURE.md](ARCHITECTURE.md), [DEVELOPMENT.md](DEVELOPMENT.md)
2. **搜索 Issues**: [GitHub Issues](https://github.com/kkcc2013-arch/mineGo/issues)
3. **创建 Issue**: 提供详细的错误信息和复现步骤
4. **社区支持**: 加入 [Discord](#) 寻求帮助
