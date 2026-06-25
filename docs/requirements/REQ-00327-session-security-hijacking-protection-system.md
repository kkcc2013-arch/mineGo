# REQ-00327：会话劫持防护与安全会话管理系统

- **编号**：REQ-00327
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared、Redis、database/migrations
- **创建时间**：2026-06-25 04:00 UTC
- **依赖需求**：REQ-00021（JWT 令牌黑名单）

## 1. 背景与问题

当前项目使用 JWT 令牌进行身份认证，但存在以下会话安全风险：

1. **会话劫持风险**：缺乏对用户设备指纹、IP 地址变化的监控，攻击者可能窃取令牌后在其他设备使用
2. **会话固定攻击**：用户登录后未刷新会话标识符，攻击者可能利用此漏洞劫持会话
3. **并发登录控制缺失**：同一账户可在多个设备同时登录，无法限制并发会话数
4. **会话过期管理不足**：缺乏分级会话过期策略（短期访问令牌 vs 长期刷新令牌）
5. **异常行为检测缺失**：无法识别异常会话行为（如突然从不同地理位置登录）

代码现状分析：
- `backend/shared/auth.js` 提供基础 JWT 验证
- `backend/shared/JwtBlacklist.js` 实现令牌黑名单
- `backend/shared/DeviceFingerprint.js` 存在设备指纹功能但未充分利用
- 缺乏会话级别的安全策略和异常检测

## 2. 目标

构建多层级会话安全防护系统，包括：

1. **会话绑定机制**：JWT 令牌绑定设备指纹 + IP 地址，防止令牌被盗用
2. **会话固定防护**：登录成功后自动刷新会话标识符，清除旧会话状态
3. **并发会话控制**：限制单账户最大并发会话数，支持踢出旧会话
4. **异常行为检测**：实时检测地理位置跳变、设备切换等异常行为
5. **分级会话过期**：访问令牌（15分钟）+ 刷新令牌（7天）双令牌机制
6. **会话审计日志**：记录所有会话创建、更新、销毁事件

## 3. 范围

### 包含
- 会话安全中间件（SessionSecurityMiddleware）
- 设备指纹绑定服务（DeviceBindingService）
- 并发会话管理器（ConcurrentSessionManager）
- 会话异常检测引擎（SessionAnomalyDetector）
- 双令牌刷新机制（DualTokenRefresh）
- 会话审计日志（SessionAuditLogger）
- 数据库迁移脚本（session_security 相关表）
- Redis 缓存层（会话状态存储）
- API 接口（会话管理、强制登出）

### 不包含
- 用户密码复杂度策略（已有）
- MFA 多因素认证（REQ-00057 已完成）
- IP 黑名单系统（REQ-00075 已完成）
- 验证码系统（REQ-00064 已完成）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 用户会话表
CREATE TABLE user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_token_hash VARCHAR(64) NOT NULL UNIQUE,
  refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_name VARCHAR(100),
  device_type VARCHAR(20), -- mobile, desktop, tablet
  ip_address INET NOT NULL,
  user_agent TEXT,
  geo_location JSONB, -- {country, city, lat, lng}
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  is_suspicious BOOLEAN DEFAULT false,
  INDEX idx_user_active (user_id, is_active, last_activity_at),
  INDEX idx_session_token (session_token_hash),
  INDEX idx_expires (expires_at)
);

-- 会话审计日志
CREATE TABLE session_audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  session_id INTEGER REFERENCES user_sessions(id),
  action VARCHAR(50) NOT NULL, -- created, refreshed, destroyed, hijacked_detected
  device_fingerprint VARCHAR(255),
  ip_address INET,
  geo_location JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, created_at DESC),
  INDEX idx_action (action, created_at DESC)
);

-- 异常会话事件
CREATE TABLE session_anomaly_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  session_id INTEGER REFERENCES user_sessions(id),
  anomaly_type VARCHAR(50) NOT NULL, -- geo_jump, device_change, concurrent_limit
  severity VARCHAR(20) NOT NULL, -- low, medium, high, critical
  details JSONB,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  action_taken VARCHAR(50), -- none, logged, challenged, terminated
  INDEX idx_user_anomaly (user_id, detected_at DESC),
  INDEX idx_severity (severity, resolved_at)
);
```

### 4.2 会话安全中间件

```javascript
// backend/shared/SessionSecurityMiddleware.js
class SessionSecurityMiddleware {
  constructor() {
    this.deviceBindingService = new DeviceBindingService();
    this.anomalyDetector = new SessionAnomalyDetector();
    this.concurrentManager = new ConcurrentSessionManager();
  }

  async validateSession(req, res, next) {
    const token = extractToken(req);
    const deviceFingerprint = req.headers['x-device-fingerprint'];
    const ipAddress = getClientIp(req);
    
    // 1. 验证 JWT 令牌
    const decoded = await verifyToken(token);
    
    // 2. 检查会话是否存在且活跃
    const session = await getSession(decoded.sessionId);
    if (!session || !session.is_active) {
      throw new SessionExpiredError('Session expired or revoked');
    }
    
    // 3. 验证设备指纹
    if (!this.deviceBindingService.validate(session, deviceFingerprint)) {
      await logAnomaly(session, 'device_change');
      throw new SessionHijackingError('Device fingerprint mismatch');
    }
    
    // 4. 验证 IP 地址（可选，根据配置）
    if (config.session.strictIpCheck && session.ip_address !== ipAddress) {
      // 检查是否在同一地理位置（允许小范围移动）
      const geoValid = await this.anomalyDetector.checkGeoConsistency(session, ipAddress);
      if (!geoValid) {
        await logAnomaly(session, 'ip_change');
        throw new SessionHijackingError('IP address changed unexpectedly');
      }
    }
    
    // 5. 更新最后活动时间
    await updateLastActivity(session.id);
    
    req.session = session;
    next();
  }
}
```

### 4.3 并发会话管理

```javascript
// backend/shared/ConcurrentSessionManager.js
class ConcurrentSessionManager {
  constructor() {
    this.maxConcurrentSessions = config.session.maxConcurrent || 5;
    this.redisClient = redis.createClient();
  }

  async createSession(userId, deviceInfo, ipAddress) {
    // 检查当前活跃会话数
    const activeSessions = await this.getActiveSessions(userId);
    
    if (activeSessions.length >= this.maxConcurrentSessions) {
      // 踢出最旧的会话
      const oldestSession = activeSessions[activeSessions.length - 1];
      await this.terminateSession(oldestSession.id, 'concurrent_limit_exceeded');
      
      // 记录事件
      await auditLog({
        userId,
        sessionId: oldestSession.id,
        action: 'terminated',
        reason: 'concurrent_limit_exceeded'
      });
    }
    
    // 创建新会话
    const session = await this.createSessionRecord(userId, deviceInfo, ipAddress);
    
    // 更新 Redis 缓存
    await this.cacheSession(session);
    
    return session;
  }

  async getActiveSessions(userId) {
    const cacheKey = `user:sessions:${userId}`;
    let sessions = await this.redisClient.get(cacheKey);
    
    if (!sessions) {
      sessions = await db.query(
        'SELECT * FROM user_sessions WHERE user_id = $1 AND is_active = true ORDER BY last_activity_at DESC',
        [userId]
      );
      await this.redisClient.setex(cacheKey, 300, JSON.stringify(sessions));
    }
    
    return JSON.parse(sessions);
  }
}
```

### 4.4 会话异常检测

```javascript
// backend/shared/SessionAnomalyDetector.js
class SessionAnomalyDetector {
  constructor() {
    this.geoService = new GeoLocationService();
    this.thresholds = {
      geoJumpDistance: 500, // km
      maxDeviceChanges: 3, // per hour
      maxIpChanges: 5, // per hour
      suspiciousCountries: config.security.suspiciousCountries || []
    };
  }

  async detectAnomalies(session, newIp, newDeviceFingerprint) {
    const anomalies = [];
    
    // 1. 检测地理位置跳变
    if (session.geo_location) {
      const newGeo = await this.geoService.locate(newIp);
      const distance = this.calculateDistance(session.geo_location, newGeo);
      
      if (distance > this.thresholds.geoJumpDistance) {
        anomalies.push({
          type: 'geo_jump',
          severity: 'high',
          details: {
            previousLocation: session.geo_location,
            newLocation: newGeo,
            distance
          }
        });
      }
    }
    
    // 2. 检测设备切换频率
    const recentDeviceChanges = await this.getRecentDeviceChanges(session.user_id, 3600);
    if (recentDeviceChanges >= this.thresholds.maxDeviceChanges) {
      anomalies.push({
        type: 'frequent_device_change',
        severity: 'medium',
        details: {
          changeCount: recentDeviceChanges,
          threshold: this.thresholds.maxDeviceChanges
        }
      });
    }
    
    // 3. 检测可疑国家/地区
    const country = newGeo?.country;
    if (country && this.thresholds.suspiciousCountries.includes(country)) {
      anomalies.push({
        type: 'suspicious_location',
        severity: 'high',
        details: { country }
      });
    }
    
    return anomalies;
  }

  calculateDistance(loc1, loc2) {
    // Haversine 公式计算两点间距离
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(loc2.lat - loc1.lat);
    const dLng = this.toRad(loc2.lng - loc1.lng);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this.toRad(loc1.lat)) * Math.cos(this.toRad(loc2.lat)) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}
```

### 4.5 双令牌刷新机制

```javascript
// backend/services/user-service/src/routes/auth.js
router.post('/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  const deviceFingerprint = req.headers['x-device-fingerprint'];
  
  try {
    // 1. 验证刷新令牌
    const decoded = await verifyRefreshToken(refreshToken);
    
    // 2. 获取会话信息
    const session = await getSession(decoded.sessionId);
    
    // 3. 验证设备指纹
    if (session.device_fingerprint !== deviceFingerprint) {
      await terminateAllSessions(session.user_id);
      throw new Error('Device mismatch - all sessions terminated');
    }
    
    // 4. 生成新的访问令牌（15分钟）
    const newAccessToken = generateAccessToken({
      userId: session.user_id,
      sessionId: session.id
    }, 900); // 15 minutes
    
    // 5. 更新会话活动时间
    await updateLastActivity(session.id);
    
    // 6. 记录审计日志
    await auditLog({
      userId: session.user_id,
      sessionId: session.id,
      action: 'token_refreshed'
    });
    
    res.json({
      accessToken: newAccessToken,
      expiresIn: 900
    });
    
  } catch (error) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});
```

### 4.6 API 接口

```yaml
# 会话管理接口
GET /api/v1/user/sessions
  - 获取当前用户所有活跃会话
  - 响应：会话列表（设备、位置、最后活动时间）

DELETE /api/v1/user/sessions/:sessionId
  - 终止指定会话（强制登出）
  - 权限：会话所有者或管理员

DELETE /api/v1/user/sessions
  - 终止所有其他会话
  - 保留当前会话

POST /api/v1/auth/login
  - 新增字段：device_fingerprint, device_name
  - 登录成功返回：access_token + refresh_token

POST /api/v1/auth/refresh
  - 使用 refresh_token 获取新的 access_token
  - 验证设备指纹

POST /api/v1/auth/logout-all
  - 强制登出所有设备
  - 用于用户发现账户被盗时使用
```

## 5. 验收标准（可测试）

- [ ] JWT 令牌包含 sessionId，且绑定设备指纹，无法在不同设备使用
- [ ] 登录成功后，旧的未过期会话被清除（会话固定防护）
- [ ] 单账户最大并发会话数可配置，默认 5 个
- [ ] 超过并发限制时，自动踢出最旧会话并记录日志
- [ ] 检测到地理位置跳变（>500km）时，触发异常告警
- [ ] 访问令牌有效期 15 分钟，刷新令牌有效期 7 天
- [ ] 刷新令牌仅限同一设备使用，跨设备使用触发全账户登出
- [ ] 所有会话操作记录审计日志（创建、刷新、销毁、异常检测）
- [ ] 提供 API 查询当前活跃会话列表
- [ ] 提供 API 强制登出指定会话或所有会话
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 集成测试覆盖主要会话安全场景

## 6. 工作量估算

**L（Large）** - 预计 5-7 个工作日

理由：
- 涉及多个模块（中间件、服务、数据库、Redis）
- 需要设计复杂的异常检测算法
- 需要处理大量边缘情况（网络切换、VPN、移动漫游等）
- 需要充分的测试和安全审计

## 7. 优先级理由

**P1（高优先级）**：

1. **安全核心能力**：会话安全是 Web 应用的基础安全能力，缺失将导致严重安全风险
2. **生产环境必需**：当前项目已达到 90/100 成熟度，需要补齐此安全短板才能进入生产
3. **用户数据保护**：防止用户账户被盗用，保护游戏资产和支付安全
4. **符合合规要求**：GDPR、PCI-DSS 等合规标准要求会话安全控制
5. **关联影响大**：影响所有需要认证的 API 接口（100+ 接口）
