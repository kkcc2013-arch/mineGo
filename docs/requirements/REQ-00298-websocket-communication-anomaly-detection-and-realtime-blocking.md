# REQ-00298：WebSocket 通信异常检测与实时阻断系统

- **编号**：REQ-00298
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、catch-service、gateway、backend/shared、infrastructure/k8s
- **创建时间**：2026-06-23 05:00
- **依赖需求**：无

## 1. 背景与问题

### 现状分析
mineGo 项目使用 WebSocket 进行核心实时通信：
- **道馆战斗**：gym-service 的 `WebSocketServer.js`、`BattleRoomManager.js`
- **团队战斗**：`teamBattleService.js`、`comboService.js`
- **心跳管理**：`HeartbeatManager.js`

### 存在问题
1. **消息伪造风险**：客户端可伪造战斗数据（伤害值、技能释放、移动位置）
2. **重放攻击**：WebSocket 消息无幂等性保护，可被截获后重放
3. **频率滥用**：恶意客户端可高频发送消息，消耗服务器资源
4. **协议漏洞**：缺乏消息签名验证，中间人攻击风险
5. **状态不一致**：客户端与服务器战斗状态可被篡改

### 安全缺口
- 现有反作弊系统仅覆盖 GPS 伪造、交易欺诈、内存篡改
- **WebSocket 通信层面完全暴露**，无实时异常检测
- 无自动阻断机制，依赖人工审计

## 2. 目标

### 主要目标
构建 WebSocket 通信异常检测与实时阻断系统，保障实时战斗的公平性与安全性。

### 量化收益
- 检测并拦截 **95%** 以上的 WebSocket 作弊行为
- 消息伪造检测延迟 < **50ms**
- 重放攻击拦截率 **100%**
- 异常客户端自动阻断响应时间 < **100ms**
- 误判率 < **0.1%**（避免影响正常玩家）

## 3. 范围

### 包含
1. **消息签名验证**：HMAC-SHA256 签名，防伪造
2. **重放攻击防护**：消息 ID + 时间戳 + Nonce，Redis 去重
3. **频率限制**：基于滑动窗口的消息频率限制
4. **行为模式检测**：战斗行为异常检测（伤害异常、移动速度异常、技能冷却违规）
5. **实时阻断**：自动断开恶意连接，记录违规日志
6. **监控告警**：异常行为实时告警，Dashboard 可视化

### 不包含
- 加密通信（TLS/SSL 由基础设施层负责）
- 客户端防护（由 REQ-00163、REQ-00181 负责）
- 事后审计分析（由数据分析系统负责）

## 4. 详细需求

### 4.1 消息签名验证中间件

**位置**：`backend/shared/middleware/websocketSignature.js`

```javascript
/**
 * WebSocket 消息签名验证
 */
class WebSocketSignatureMiddleware {
  constructor() {
    this.secretKey = process.env.WS_SECRET_KEY;
    this.timestampTolerance = 30000; // 30秒
  }

  /**
   * 签名格式：HMAC-SHA256(timestamp + nonce + payload)
   */
  verify(message, signature) {
    const { timestamp, nonce, payload } = message;

    // 1. 时间戳验证
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.timestampTolerance) {
      throw new Error('TIMESTAMP_EXPIRED');
    }

    // 2. Nonce 唯一性检查（Redis）
    const nonceKey = `ws:nonce:${nonce}`;
    const exists = await redis.exists(nonceKey);
    if (exists) {
      throw new Error('NONCE_REUSED');
    }
    await redis.setex(nonceKey, 300, '1'); // 5分钟过期

    // 3. 签名验证
    const data = `${timestamp}:${nonce}:${JSON.stringify(payload)}`;
    const expectedSig = crypto
      .createHmac('sha256', this.secretKey)
      .update(data)
      .digest('hex');

    if (signature !== expectedSig) {
      throw new Error('INVALID_SIGNATURE');
    }

    return true;
  }
}
```

### 4.2 重放攻击防护系统

**位置**：`backend/shared/security/replayProtection.js`

```javascript
/**
 * 重放攻击防护
 */
class ReplayProtection {
  constructor() {
    this.redis = createRedisClient();
    this.windowMs = 60000; // 1分钟窗口
  }

  /**
   * 检查消息是否重复
   */
  async checkReplay(messageId, timestamp) {
    const key = `ws:replay:${messageId}`;

    // 检查是否已存在
    const exists = await this.redis.exists(key);
    if (exists) {
      logger.warn('Replay attack detected', { messageId, timestamp });
      return false; // 拒绝
    }

    // 记录消息 ID
    await this.redis.setex(key, this.windowMs / 1000, Date.now());
    return true; // 通过
  }

  /**
   * 批量清理过期记录
   */
  async cleanup() {
    // Redis TTL 自动清理
  }
}
```

### 4.3 频率限制器

**位置**：`backend/shared/security/websocketRateLimiter.js`

```javascript
/**
 * WebSocket 频率限制
 */
class WebSocketRateLimiter {
  constructor() {
    this.limits = {
      'battle:move': { max: 30, window: 1000 },      // 移动：30次/秒
      'battle:skill': { max: 10, window: 1000 },     // 技能：10次/秒
      'battle:chat': { max: 5, window: 1000 },       // 聊天：5次/秒
      'heartbeat': { max: 2, window: 1000 }          // 心跳：2次/秒
    };
  }

  /**
   * 滑动窗口频率检查
   */
  async checkLimit(userId, messageType) {
    const limit = this.limits[messageType];
    if (!limit) return true;

    const key = `ws:rate:${userId}:${messageType}`;
    const now = Date.now();
    const windowStart = now - limit.window;

    // 使用 Redis ZSET 实现滑动窗口
    const count = await this.redis.zcount(key, windowStart, now);

    if (count >= limit.max) {
      logger.warn('Rate limit exceeded', {
        userId,
        messageType,
        count,
        limit: limit.max
      });
      return false; // 超限
    }

    // 记录本次请求
    await this.redis.zadd(key, now, `${now}:${Math.random()}`);
    await this.redis.expire(key, limit.window / 1000);

    return true; // 通过
  }
}
```

### 4.4 行为模式异常检测器

**位置**：`backend/shared/security/behaviorAnomalyDetector.js`

```javascript
/**
 * 战斗行为异常检测
 */
class BehaviorAnomalyDetector {
  constructor() {
    this.rules = {
      // 移动速度检测（最大：100米/秒）
      maxMoveSpeed: 100,

      // 伤害异常阈值（单次伤害不超过精灵攻击力 10 倍）
      maxDamageMultiplier: 10,

      // 技能冷却违规检测
      skillCooldowns: new Map(),

      // 连续相同操作检测
      repeatedActionThreshold: 10
    };
  }

  /**
   * 检测移动异常
   */
  detectMoveAnomaly(userId, from, to, timeDiff) {
    const distance = this.calculateDistance(from, to);
    const speed = distance / timeDiff; // 米/秒

    if (speed > this.rules.maxMoveSpeed) {
      return {
        type: 'MOVE_SPEED_ANOMALY',
        severity: 'HIGH',
        details: { speed, maxSpeed: this.rules.maxMoveSpeed }
      };
    }

    return null;
  }

  /**
   * 检测伤害异常
   */
  detectDamageAnomaly(userId, pokemon, damage) {
    const maxDamage = pokemon.attack * this.rules.maxDamageMultiplier;

    if (damage > maxDamage) {
      return {
        type: 'DAMAGE_ANOMALY',
        severity: 'CRITICAL',
        details: { damage, maxDamage, ratio: damage / maxDamage }
      };
    }

    return null;
  }

  /**
   * 检测技能冷却违规
   */
  detectCooldownViolation(userId, skillId, actualCooldown) {
    const lastUse = this.rules.skillCooldowns.get(`${userId}:${skillId}`);
    const expectedCooldown = SKILL_DATA[skillId]?.cooldown || 0;

    if (lastUse && (Date.now() - lastUse) < expectedCooldown * 1000) {
      return {
        type: 'COOLDOWN_VIOLATION',
        severity: 'HIGH',
        details: {
          skillId,
          expectedCooldown,
          actualInterval: Date.now() - lastUse
        }
      };
    }

    this.rules.skillCooldowns.set(`${userId}:${skillId}`, Date.now());
    return null;
  }

  /**
   * 计算地理距离
   */
  calculateDistance(from, to) {
    const R = 6371000; // 地球半径（米）
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLng = (to.lng - from.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(from.lat * Math.PI / 180) *
              Math.cos(to.lat * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}
```

### 4.5 实时阻断引擎

**位置**：`backend/shared/security/websocketBlocker.js`

```javascript
/**
 * WebSocket 连接阻断器
 */
class WebSocketBlocker {
  constructor() {
    this.violationThresholds = {
      LOW: 3,       // 3次低风险违规
      MEDIUM: 2,    // 2次中等风险违规
      HIGH: 1,      // 1次高风险违规
      CRITICAL: 1   // 1次严重违规
    };

    this.blockDuration = {
      LOW: 300000,       // 5分钟
      MEDIUM: 3600000,   // 1小时
      HIGH: 86400000,    // 24小时
      CRITICAL: 604800000 // 7天
    };

    this.userViolations = new Map(); // userId -> violations[]
  }

  /**
   * 记录违规并判断是否阻断
   */
  async recordViolation(ws, userId, anomaly) {
    const violations = this.userViolations.get(userId) || [];
    violations.push({
      type: anomaly.type,
      severity: anomaly.severity,
      timestamp: Date.now()
    });

    this.userViolations.set(userId, violations);

    // 检查是否达到阻断阈值
    const threshold = this.violationThresholds[anomaly.severity];
    const severityCount = violations.filter(v => v.severity === anomaly.severity).length;

    if (severityCount >= threshold) {
      await this.blockConnection(ws, userId, anomaly.severity);
      return true;
    }

    return false;
  }

  /**
   * 阻断连接
   */
  async blockConnection(ws, userId, severity) {
    const duration = this.blockDuration[severity];
    const blockUntil = Date.now() + duration;

    // 1. Redis 记录阻断状态
    await redis.setex(`ws:block:${userId}`, duration / 1000, JSON.stringify({
      severity,
      blockedAt: Date.now(),
      blockedUntil: blockUntil
    }));

    // 2. 断开 WebSocket 连接
    ws.close(1008, `Security violation: ${severity}`);

    // 3. 记录日志
    logger.security('WebSocket connection blocked', {
      userId,
      severity,
      duration,
      blockedUntil: new Date(blockUntil).toISOString()
    });

    // 4. 发送告警
    await this.sendAlert(userId, severity, duration);
  }

  /**
   * 检查用户是否被阻断
   */
  async isBlocked(userId) {
    const blockData = await redis.get(`ws:block:${userId}`);
    if (!blockData) return false;

    const block = JSON.parse(blockData);
    return {
      blocked: true,
      severity: block.severity,
      blockedUntil: block.blockedUntil
    };
  }

  /**
   * 发送告警
   */
  async sendAlert(userId, severity, duration) {
    // 发送到监控系统
    await kafkaProducer.send({
      topic: 'security-alerts',
      messages: [{
        key: userId,
        value: JSON.stringify({
          type: 'WEBSOCKET_BLOCK',
          userId,
          severity,
          duration,
          timestamp: Date.now()
        })
      }]
    });
  }
}
```

### 4.6 集成到现有 WebSocket 服务

**修改**：`backend/services/gym-service/src/websocket/WebSocketServer.js`

```javascript
const { WebSocketSignatureMiddleware } = require('../../../../shared/middleware/websocketSignature');
const { ReplayProtection } = require('../../../../shared/security/replayProtection');
const { WebSocketRateLimiter } = require('../../../../shared/security/websocketRateLimiter');
const { BehaviorAnomalyDetector } = require('../../../../shared/security/behaviorAnomalyDetector');
const { WebSocketBlocker } = require('../../../../shared/security/websocketBlocker');

class WebSocketServer {
  constructor() {
    this.signature = new WebSocketSignatureMiddleware();
    this.replayProtection = new ReplayProtection();
    this.rateLimiter = new WebSocketRateLimiter();
    this.anomalyDetector = new BehaviorAnomalyDetector();
    this.blocker = new WebSocketBlocker();
  }

  async handleMessage(ws, data) {
    const { userId, message } = data;

    // 1. 检查是否被阻断
    const blockStatus = await this.blocker.isBlocked(userId);
    if (blockStatus.blocked) {
      ws.close(1008, `Blocked until ${new Date(blockStatus.blockedUntil).toISOString()}`);
      return;
    }

    // 2. 签名验证
    try {
      await this.signature.verify(message, message.signature);
    } catch (error) {
      logger.warn('Signature verification failed', { userId, error: error.message });
      ws.close(1008, 'Invalid signature');
      return;
    }

    // 3. 重放攻击检查
    const isReplay = await this.replayProtection.checkReplay(message.id, message.timestamp);
    if (!isReplay) {
      ws.close(1008, 'Replay attack detected');
      return;
    }

    // 4. 频率限制
    const rateLimitOk = await this.rateLimiter.checkLimit(userId, message.type);
    if (!rateLimitOk) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    // 5. 行为异常检测
    const anomaly = this.detectAnomaly(userId, message);
    if (anomaly) {
      const shouldBlock = await this.blocker.recordViolation(ws, userId, anomaly);
      if (shouldBlock) return;
    }

    // 6. 正常处理消息
    await this.processMessage(ws, message);
  }

  detectAnomaly(userId, message) {
    switch (message.type) {
      case 'battle:move':
        return this.anomalyDetector.detectMoveAnomaly(
          userId,
          message.payload.from,
          message.payload.to,
          message.payload.timeDiff
        );

      case 'battle:skill':
        return this.anomalyDetector.detectDamageAnomaly(
          userId,
          message.payload.pokemon,
          message.payload.damage
        ) || this.anomalyDetector.detectCooldownViolation(
          userId,
          message.payload.skillId,
          message.payload.cooldown
        );

      default:
        return null;
    }
  }
}
```

### 4.7 监控告警与可视化

**位置**：`infrastructure/k8s/monitoring/websocket-security-dashboard.json`

```json
{
  "dashboard": {
    "title": "WebSocket Security Dashboard",
    "panels": [
      {
        "title": "Blocked Connections",
        "type": "graph",
        "targets": [{
          "expr": "rate(ws_blocked_total[5m])",
          "legendFormat": "{{severity}}"
        }]
      },
      {
        "title": "Violation Distribution",
        "type": "piechart",
        "targets": [{
          "expr": "sum by (type)(ws_violations_total)",
          "legendFormat": "{{type}}"
        }]
      },
      {
        "title": "Top Blocked Users",
        "type": "table",
        "targets": [{
          "expr": "topk(10, ws_user_violations_total)",
          "legendFormat": "{{userId}}"
        }]
      }
    ]
  }
}
```

**告警规则**：`infrastructure/k8s/monitoring/websocket-alerts.yml`

```yaml
groups:
  - name: websocket-security
    rules:
      - alert: HighBlockRate
        expr: rate(ws_blocked_total[5m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High WebSocket block rate detected"
          description: "{{ $value }} connections blocked per second"

      - alert: CriticalViolation
        expr: increase(ws_violations_total{severity="CRITICAL"}[1h]) > 5
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Critical WebSocket violations detected"
          description: "{{ $value }} critical violations in the last hour"
```

## 5. 验收标准（可测试）

- [ ] **签名验证测试**：伪造签名被拦截，合法签名通过
- [ ] **重放攻击测试**：重复消息 ID 被拦截，新消息 ID 通过
- [ ] **频率限制测试**：超限消息被拒绝，正常频率通过
- [ ] **移动异常检测测试**：超速移动被标记，正常移动通过
- [ ] **伤害异常检测测试**：超常伤害被标记，正常伤害通过
- [ ] **技能冷却违规测试**：违规使用技能被标记，正常使用通过
- [ ] **自动阻断测试**：达到阈值后自动断开连接
- [ ] **阻断持久化测试**：被阻断用户无法立即重连
- [ ] **监控告警测试**：异常行为触发告警，Dashboard 数据正确
- [ ] **性能测试**：消息处理延迟 < 50ms，吞吐量 > 10000 msg/s
- [ ] **误判率测试**：正常玩家误判率 < 0.1%

## 6. 工作量估算

**估算：XL（3-5人周）**

### 理由
1. **签名验证中间件**：0.5人周（HMAC 签名 + Nonce 管理）
2. **重放攻击防护**：0.5人周（Redis 去重 + 清理机制）
3. **频率限制器**：0.5人周（滑动窗口 + Redis ZSET）
4. **行为异常检测器**：1人周（多种检测规则 + 调优）
5. **实时阻断引擎**：0.5人周（阈值判断 + 阻断逻辑）
6. **集成到现有服务**：1人周（修改 gym-service、catch-service）
7. **监控告警**：0.5人周（Dashboard + Alert rules）
8. **单元测试 + 集成测试**：1人周（覆盖率 > 80%）

**总计：约 4 人周**

## 7. 优先级理由

### 为什么是 P1？

1. **安全风险高**：WebSocket 是游戏核心战斗系统的通信通道，攻击可直接影响游戏公平性
2. **影响范围大**：涉及所有实时战斗场景（道馆战、团队战、PVP）
3. **无现有防护**：当前完全暴露，无任何防护机制
4. **容易实施攻击**：WebSocket 消息可被轻易截获和伪造
5. **影响用户体验**：作弊行为会严重破坏正常玩家的游戏体验

### 对"项目可用"的贡献
- 保障实时战斗的公平性，维护游戏生态健康
- 降低安全运营成本，自动化阻断恶意行为
- 提升玩家信任度，减少投诉和流失
