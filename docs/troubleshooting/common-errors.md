# mineGo 常见错误故障排查手册

> 本手册帮助开发者和运维人员快速定位和解决常见问题。

## 目录

1. [认证问题](#认证问题)
2. [网络问题](#网络问题)
3. [捕捉问题](#捕捉问题)
4. [支付问题](#支付问题)
5. [性能问题](#性能问题)
6. [反作弊问题](#反作弊问题)

---

## 认证问题

### 问题 1：用户登录后提示"无效的访问令牌"（G1-001-001）

**症状**：
- 用户登录成功，但后续请求返回 401 错误
- 错误码：G1-001-001

**可能原因**：
1. Token 格式错误（缺少 Bearer 前缀）
2. Token 已过期
3. Token 签名验证失败
4. Redis 黑名单中有该 Token

**排查步骤**：

```bash
# 1. 检查 Token 格式
curl -H "Authorization: Bearer <token>" https://api.minego.app/api/v1/user/profile

# 2. 解码 JWT 检查过期时间
echo "<token>" | cut -d'.' -f2 | base64 -d | jq .

# 3. 检查 Redis 黑名单
redis-cli GET "jwt:blacklist:<token_hash>"

# 4. 查看网关日志
kubectl logs -l app=gateway --since=5m | grep "G1-001-001"
```

**解决方案**：
1. 确保请求头包含 `Authorization: Bearer <token>`
2. 检查客户端时间是否正确
3. 清除本地 Token，重新登录

---

### 问题 2：频繁提示"登录已过期"（G1-001-002）

**症状**：
- 用户频繁需要重新登录
- Token 过期时间很短

**可能原因**：
1. Token 有效期配置过短
2. 客户端时间不同步
3. 刷新 Token 机制未生效

**排查步骤**：

```bash
# 1. 检查 Token 有效期配置
kubectl get configmap gateway-config -o yaml | grep JWT_EXPIRES_IN

# 2. 检查刷新 Token 是否正常工作
curl -X POST https://api.minego.app/api/v1/auth/refresh \
  -H "Refresh-Token: <refresh_token>"

# 3. 检查客户端时间
# 前端代码
console.log('Local time:', new Date());
console.log('Token exp:', new Date(decoded.exp * 1000));
```

**解决方案**：
1. 调整 Token 有效期（建议：access token 2小时，refresh token 7天）
2. 实现自动刷新机制：

```javascript
// 前端自动刷新示例
axios.interceptors.response.use(
  response => response,
  async error => {
    if (error.response?.data?.error?.code === 'G1-001-002') {
      const newToken = await refreshToken();
      error.config.headers.Authorization = `Bearer ${newToken}`;
      return axios(error.config);
    }
    return Promise.reject(error);
  }
);
```

---

## 网络问题

### 问题 3：请求频繁返回"请求过于频繁"（G1-002-001）

**症状**：
- API 请求被限流
- 错误码：G1-002-001

**可能原因**：
1. 客户端请求频率超过限制
2. 限流配置过于严格
3. 多个请求并发

**排查步骤**：

```bash
# 1. 查看限流配置
kubectl get configmap gateway-config -o yaml | grep -A 20 RATE_LIMIT

# 2. 检查用户请求频率
redis-cli GET "rate_limit:user:<user_id>:minute"

# 3. 查看限流日志
kubectl logs -l app=gateway --since=10m | grep "G1-002-001"
```

**解决方案**：
1. 客户端实现请求节流：

```javascript
// 前端节流示例
const throttledApiCall = throttle(api.pokemonCatch, 1000); // 1秒最多1次
```

2. 服务端调整限流配置：

```yaml
# gateway-config.yaml
RATE_LIMIT:
  WINDOW_MS: 60000  # 1分钟窗口
  MAX_REQUESTS: 100 # 每分钟最多100次
```

---

### 问题 4：服务暂时不可用（G1-002-002）

**症状**：
- 随机出现 503 错误
- 错误码：G1-002-002

**可能原因**：
1. 服务健康检查失败
2. Pod 重启或部署中
3. 资源不足（CPU/内存）

**排查步骤**：

```bash
# 1. 检查服务状态
kubectl get pods -l app=<service-name>

# 2. 查看资源使用
kubectl top pods -l app=<service-name>

# 3. 查看服务日志
kubectl logs -l app=<service-name> --tail=100

# 4. 检查健康检查
kubectl describe pod <pod-name> | grep -A 10 "Liveness\|Readiness"
```

**解决方案**：
1. 增加副本数：

```bash
kubectl scale deployment <service-name> --replicas=3
```

2. 优化健康检查配置：

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

---

## 捕捉问题

### 问题 5：捕捉请求被反作弊系统拦截（C5-001-004）

**症状**：
- 捕捉请求返回 403
- 错误码：C5-001-004

**可能原因**：
1. GPS 伪造被检测
2. 移动速度异常
3. 捕捉成功率异常
4. 设备完整性检测失败

**排查步骤**：

```bash
# 1. 查看反作弊日志
kubectl logs -l app=catch-service --since=30m | grep "C5-001-004"

# 2. 检查用户信任评分
redis-cli GET "user:trust_score:<user_id>"

# 3. 查看设备完整性报告
curl https://api.minego.app/api/v1/device/integrity/<device_id>
```

**解决方案**：
1. 教育用户遵守游戏规则
2. 优化误判处理机制：

```javascript
// 允许用户申诉
app.post('/api/v1/anticheat/appeal', async (req, res) => {
  const { userId, requestId, reason } = req.body;
  // 创建申诉工单
  await createSupportTicket({ userId, requestId, reason, type: 'anticheat' });
  res.json({ success: true, message: '申诉已提交，将在24小时内处理' });
});
```

---

### 问题 6：精灵总是逃跑（C5-001-001）

**症状**：
- 精灵捕捉成功率异常低
- 频繁出现精灵逃跑

**可能原因**：
1. 精灵稀有度高，基础捕捉率低
2. 未使用正确的道具和技巧
3. 客户端与服务器状态不一致

**排查步骤**：

```bash
# 1. 检查精灵基础捕捉率
SELECT pokemon_id, base_catch_rate FROM pokemon WHERE pokemon_id = '<pokemon_id>';

# 2. 查看用户捕捉历史
SELECT 
  pokemon_id,
  COUNT(*) as attempts,
  SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as successes,
  AVG(expected_rate) as avg_expected_rate
FROM catch_sessions 
WHERE user_id = '<user_id>' 
  AND catch_timestamp > NOW() - INTERVAL '24 hours'
GROUP BY pokemon_id;

# 3. 检查道具加成是否生效
kubectl logs -l app=catch-service --since=1h | grep "modifier"
```

**解决方案**：
1. 教育用户捕捉技巧：
   - 使用高级精灵球
   - 投掷 Great/Excellent 球
   - 使用 Curveball
   - 使用树果增加捕捉率

2. 前端提供捕捉建议：

```javascript
// 显示捕捉概率
function showCatchProbability(pokemon, ballType, throwType, curveball) {
  const probability = calculateCatchRate(pokemon, ballType, throwType, curveball);
  showTooltip(`捕捉概率：${(probability * 100).toFixed(1)}%`);
}
```

---

## 支付问题

### 问题 7：支付失败（P9-001-005）

**症状**：
- 支付请求失败
- 错误码：P9-001-005

**可能原因**：
1. 支付网关错误
2. 银行卡信息错误
3. 账户余额不足
4. 支付金额不一致

**排查步骤**：

```bash
# 1. 查看支付订单状态
SELECT * FROM payment_orders WHERE order_id = '<order_id>';

# 2. 检查支付网关日志
kubectl logs -l app=payment-service --since=1h | grep "<order_id>"

# 3. 验证签名
node -e "
const crypto = require('crypto');
const payload = '<payload>';
const signature = '<signature>';
const expected = crypto.createHmac('sha256', process.env.PAYMENT_SECRET)
  .update(payload)
  .digest('hex');
console.log('Signature valid:', signature === expected);
"
```

**解决方案**：
1. 实现支付重试机制：

```javascript
async function processPayment(order, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await paymentGateway.charge(order);
      return result;
    } catch (error) {
      if (error.code === 'P9-001-005' && i < retries - 1) {
        await sleep(2000);
        continue;
      }
      throw error;
    }
  }
}
```

2. 提供多种支付方式：

```javascript
const paymentMethods = [
  { id: 'alipay', name: '支付宝', icon: 'alipay.png' },
  { id: 'wechat', name: '微信支付', icon: 'wechat.png' },
  { id: 'apple_pay', name: 'Apple Pay', icon: 'apple-pay.png' },
  { id: 'google_pay', name: 'Google Pay', icon: 'google-pay.png' },
];
```

---

### 问题 8：订单重复支付（P9-001-006）

**症状**：
- 用户支付成功但提示重复订单
- 错误码：P9-001-006

**可能原因**：
1. 网络重试导致重复提交
2. 幂等性检查失败
3. 订单状态更新延迟

**排查步骤**：

```bash
# 1. 检查订单状态
SELECT order_id, status, idempotency_key, created_at, updated_at 
FROM payment_orders 
WHERE order_id = '<order_id>';

# 2. 检查幂等性记录
SELECT * FROM payment_idempotency 
WHERE idempotency_key = '<idempotency_key>';

# 3. 查看支付回调日志
kubectl logs -l app=payment-service --since=2h | grep "webhook"
```

**解决方案**：
1. 前端实现防重复提交：

```javascript
let isProcessing = false;

async function submitPayment(order) {
  if (isProcessing) {
    return showError('支付处理中，请勿重复提交');
  }
  
  isProcessing = true;
  try {
    const result = await api.createPayment(order);
    return result;
  } finally {
    setTimeout(() => { isProcessing = false; }, 3000);
  }
}
```

2. 后端幂等性检查：

```javascript
async function createPaymentOrder(orderData) {
  const idempotencyKey = orderData.idempotencyKey || generateUUID();
  
  // 检查是否已存在
  const existing = await db.query(
    'SELECT * FROM payment_orders WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  
  if (existing.rows.length > 0) {
    return existing.rows[0]; // 返回已存在的订单
  }
  
  // 创建新订单
  const order = await db.query(
    'INSERT INTO payment_orders (...) VALUES (...) RETURNING *',
    [...]
  );
  
  return order.rows[0];
}
```

---

## 性能问题

### 问题 9：API 响应缓慢

**症状**：
- API 响应时间超过 1 秒
- 频繁超时

**可能原因**：
1. 数据库查询慢
2. 缓存失效
3. 网络延迟
4. 服务资源不足

**排查步骤**：

```bash
# 1. 查看 API 延迟分布
curl https://api.minego.app/metrics | grep http_request_duration_seconds

# 2. 检查慢查询
SELECT query, mean_time, calls 
FROM pg_stat_statements 
ORDER BY mean_time DESC 
LIMIT 10;

# 3. 检查缓存命中率
redis-cli INFO stats | grep keyspace_hits,keyspace_misses

# 4. 查看服务资源
kubectl top pods -l app=gateway
kubectl top pods -l app=user-service
```

**解决方案**：
1. 添加数据库索引：

```sql
CREATE INDEX idx_user_email ON users(email);
CREATE INDEX idx_pokemon_user ON pokemons(user_id, created_at DESC);
```

2. 启用缓存：

```javascript
// Redis 缓存中间件
app.use(cacheMiddleware({
  ttl: 300, // 5分钟
  key: (req) => `cache:${req.originalUrl}`,
}));
```

3. 优化数据库查询：

```javascript
// 使用批量查询替代循环查询
const userIds = friends.map(f => f.id);
const users = await db.query(
  'SELECT * FROM users WHERE id = ANY($1)',
  [userIds]
);
```

---

## 反作弊问题

### 问题 10：正常玩家被误判为作弊

**症状**：
- 用户投诉被错误封禁
- 信任评分异常降低

**可能原因**：
1. 网络波动导致位置跳跃
2. 乘坐高铁/飞机
3. GPS 定位漂移

**排查步骤**：

```bash
# 1. 查看用户信任评分历史
SELECT * FROM trust_score_history 
WHERE user_id = '<user_id>' 
ORDER BY created_at DESC 
LIMIT 20;

# 2. 检查反作弊日志
kubectl logs -l app=catch-service --since=24h | grep "user_id=<user_id>"

# 3. 分析位置轨迹
SELECT location, timestamp, speed 
FROM location_reports 
WHERE user_id = '<user_id>' 
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp;
```

**解决方案**：
1. 调整反作弊阈值：

```javascript
// 增加容忍度
const SPEED_THRESHOLDS = {
  WARNING: 80,   // 提高到 80 m/s（考虑高铁场景）
  BLOCK: 200,    // 提高到 200 m/s
};

// 增加缓冲期
const TRUST_SCORE = {
  RECOVERY_DELAY: 3600,  // 1小时后开始恢复
  RECOVERY_RATE: 2,       // 每小时恢复 2 分
};
```

2. 提供申诉渠道：

```javascript
// 用户申诉接口
app.post('/api/v1/appeal', async (req, res) => {
  const { userId, type, evidence } = req.body;
  
  // 创建申诉工单
  const ticket = await createAppealTicket({
    userId,
    type,
    evidence,
    status: 'pending',
    createdAt: new Date(),
  });
  
  // 通知客服团队
  await notifySupportTeam(ticket);
  
  res.json({
    success: true,
    ticketId: ticket.id,
    message: '申诉已提交，我们将在24小时内处理',
  });
});
```

---

## 快速参考

### 错误码查询表

| 错误码 | 问题 | 快速解决 |
|--------|------|---------|
| G1-001-001 | Token 无效 | 重新登录 |
| G1-001-002 | Token 过期 | 刷新 Token |
| G1-002-001 | 限流 | 降低请求频率 |
| C5-001-004 | 反作弊拦截 | 检查是否作弊，申诉 |
| P9-001-005 | 支付失败 | 重试或更换支付方式 |

### 常用命令

```bash
# 查看服务日志
kubectl logs -l app=<service-name> --tail=100 -f

# 检查服务状态
kubectl get pods -l app=<service-name>

# 查看 Prometheus 指标
curl https://api.minego.app/metrics | grep error

# Redis 查询
redis-cli GET "key"
redis-cli DEL "key"

# 数据库查询
psql -h <host> -U <user> -d minego -c "SELECT ..."
```

---

## 联系支持

- **技术支持**：tech-support@minego.app
- **紧急问题**：+86 400-xxx-xxxx
- **GitHub Issues**：https://github.com/kkcc2013-arch/mineGo/issues

---

**更新日志**：
- 2026-06-10：初始版本，包含 10 个常见问题
