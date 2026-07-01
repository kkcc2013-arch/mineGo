# REQ-00406: 玩家账号异常登录检测与地理围栏防护系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00406 |
| 标题 | 玩家账号异常登录检测与地理围栏防护系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、backend/shared、Redis、PostgreSQL、admin-dashboard |
| 创建时间 | 2026-07-01 05:00 UTC |

## 需求描述

### 背景
当前系统已有设备绑定和基础异常检测功能，但缺乏细粒度的地理围栏防护和智能异常登录行为分析。需要构建一个多层次的账号安全防护体系，包括：

1. **地理围栏系统**：基于玩家历史登录位置建立信任区域，超出信任区域的登录触发验证
2. **异常登录行为分析**：识别短时间内多地点登录、异常时间段登录、设备切换模式等风险行为
3. **智能风险评分**：结合多种维度进行风险评分，动态调整验证策略
4. **自动化响应机制**：高风险登录自动触发二次验证、临时锁定或管理员审核

### 目标
- 将账号盗用风险降低 90% 以上
- 减少恶意登录尝试的成功率
- 提供可视化监控和告警机制
- 支持玩家自定义地理围栏和白名单

## 技术方案

### 1. 地理围栏引擎（GeofencingEngine.js）

```javascript
// backend/shared/GeofencingEngine.js
const logger = require('./logger');
const redis = require('./redis');

class GeofencingEngine {
  constructor() {
    this.TRUST_RADIUS_KM = 50; // 信任半径（公里）
    this.MIN_HISTORY_POINTS = 3; // 最小历史登录点数
    this.TRUST_DECAY_DAYS = 30; // 信任衰减周期（天）
    this.TRUST_LEVELS = {
      HIGH: 0.8,
      MEDIUM: 0.5,
      LOW: 0.3,
      UNTRUSTED: 0
    };
  }

  /**
   * 计算两点间的 Haversine 距离
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 构建用户信任地理区域
   */
  async buildTrustZones(userId) {
    const cacheKey = `geofence:trust_zones:${userId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 从数据库获取用户历史登录位置
    const loginHistory = await this.getLoginHistory(userId);
    
    if (loginHistory.length < this.MIN_HISTORY_POINTS) {
      return { zones: [], trustLevel: this.TRUST_LEVELS.LOW };
    }

    // 使用聚类算法识别常驻区域
    const zones = this.clusterLocations(loginHistory);
    
    // 计算整体信任级别
    const trustLevel = this.calculateTrustLevel(zones, loginHistory);
    
    const result = { zones, trustLevel, lastUpdated: Date.now() };
    await redis.setex(cacheKey, 3600, JSON.stringify(result)); // 缓存 1 小时
    
    return result;
  }

  /**
   * DBSCAN 聚类算法识别常驻区域
   */
  clusterLocations(loginHistory) {
    const eps = this.TRUST_RADIUS_KM / 111; // 近似转换为经度度数
    const minPts = 2;
    const visited = new Set();
    const clusters = [];

    for (let i = 0; i < loginHistory.length; i++) {
      if (visited.has(i)) continue;
      visited.add(i);

      const neighbors = this.getNeighbors(loginHistory, i, eps);
      if (neighbors.length < minPts) continue;

      const cluster = [loginHistory[i]];
      const queue = [...neighbors];

      while (queue.length > 0) {
        const neighborIdx = queue.shift();
        if (visited.has(neighborIdx)) continue;
        visited.add(neighborIdx);

        const neighborNeighbors = this.getNeighbors(loginHistory, neighborIdx, eps);
        if (neighborNeighbors.length >= minPts) {
          queue.push(...neighborNeighbors.filter(n => !visited.has(n)));
        }

        cluster.push(loginHistory[neighborIdx]);
      }

      // 计算聚类中心点和半径
      const centroid = this.calculateCentroid(cluster);
      const radius = this.calculateClusterRadius(cluster, centroid);
      
      clusters.push({
        centroid,
        radius: Math.max(radius, this.TRUST_RADIUS_KM),
        loginCount: cluster.length,
        lastLogin: Math.max(...cluster.map(p => p.timestamp))
      });
    }

    return clusters;
  }

  /**
   * 检查登录位置是否在信任区域内
   */
  async checkLoginLocation(userId, lat, lon) {
    const { zones, trustLevel } = await this.buildTrustZones(userId);
    
    if (zones.length === 0) {
      return {
        trusted: false,
        reason: 'INSUFFICIENT_HISTORY',
        trustLevel,
        requiredAction: 'TWO_FACTOR_AUTH'
      };
    }

    // 检查是否在任一信任区域内
    for (const zone of zones) {
      const distance = this.calculateDistance(
        zone.centroid.lat, zone.centroid.lon,
        lat, lon
      );

      if (distance <= zone.radius) {
        // 更新信任区域
        await this.updateTrustZone(userId, zone, lat, lon);
        
        return {
          trusted: true,
          zone: zone.centroid,
          distance,
          trustLevel
        };
      }
    }

    // 计算最近信任区域的距离
    const minDistance = Math.min(
      ...zones.map(zone => 
        this.calculateDistance(zone.centroid.lat, zone.centroid.lon, lat, lon)
      )
    );

    return {
      trusted: false,
      reason: 'OUTSIDE_TRUST_ZONE',
      nearestDistance: minDistance,
      trustLevel,
      requiredAction: minDistance > 500 ? 'TEMPORARY_LOCK' : 'TWO_FACTOR_AUTH'
    };
  }

  /**
   * 动态更新信任区域
   */
  async updateTrustZone(userId, zone, lat, lon) {
    // 使用指数移动平均更新聚类中心
    const alpha = 0.1; // 学习率
    zone.centroid.lat = zone.centroid.lat * (1 - alpha) + lat * alpha;
    zone.centroid.lon = zone.centroid.lon * (1 - alpha) + lon * alpha;
    zone.lastLogin = Date.now();
    zone.loginCount++;

    // 更新缓存
    const cacheKey = `geofence:trust_zones:${userId}`;
    await redis.del(cacheKey);
  }
}

module.exports = new GeofencingEngine();
```

### 2. 异常登录行为分析器（LoginAnomalyAnalyzer.js）

```javascript
// backend/shared/LoginAnomalyAnalyzer.js
const logger = require('./logger');
const redis = require('./redis');

class LoginAnomalyAnalyzer {
  constructor() {
    this.ANOMALY_TYPES = {
      MULTIPLE_LOCATIONS: 'MULTIPLE_LOCATIONS',
      IMPOSSIBLE_TRAVEL: 'IMPOSSIBLE_TRAVEL',
      NEW_DEVICE: 'NEW_DEVICE',
      UNUSUAL_TIME: 'UNUSUAL_TIME',
      BRUTE_FORCE: 'BRUTE_FORCE',
      CREDENTIAL_STUFFING: 'CREDENTIAL_STUFFING',
      ACCOUNT_TAKEOVER: 'ACCOUNT_TAKEOVER'
    };

    this.TRAVEL_SPEED_THRESHOLD = 800; // km/h（飞机速度）
    this.RAPID_LOGIN_THRESHOLD = 5; // 分钟内登录次数
    this.UNUSUAL_TIME_RANGE = {
      start: 0, // 凌晨 0 点
      end: 5    // 凌晨 5 点
    };
  }

  /**
   * 综合异常检测入口
   */
  async analyzeLoginAttempt(userId, loginData) {
    const { deviceId, ip, lat, lon, timestamp, userAgent } = loginData;

    const anomalies = [];
    let riskScore = 0;

    // 1. 检查多地点登录
    const locationCheck = await this.checkMultipleLocations(userId, lat, lon, timestamp);
    if (locationCheck.anomaly) {
      anomalies.push(locationCheck);
      riskScore += locationCheck.severity;
    }

    // 2. 检查不可能旅行
    const travelCheck = await this.checkImpossibleTravel(userId, lat, lon, timestamp);
    if (travelCheck.anomaly) {
      anomalies.push(travelCheck);
      riskScore += travelCheck.severity;
    }

    // 3. 检查新设备
    const deviceCheck = await this.checkNewDevice(userId, deviceId, userAgent);
    if (deviceCheck.anomaly) {
      anomalies.push(deviceCheck);
      riskScore += deviceCheck.severity;
    }

    // 4. 检查异常时间段
    const timeCheck = this.checkUnusualTime(timestamp, userId);
    if (timeCheck.anomaly) {
      anomalies.push(timeCheck);
      riskScore += timeCheck.severity;
    }

    // 5. 检查暴力破解
    const bruteForceCheck = await this.checkBruteForce(userId, ip);
    if (bruteForceCheck.anomaly) {
      anomalies.push(bruteForceCheck);
      riskScore += bruteForceCheck.severity;
    }

    // 6. 检查撞库攻击
    const stuffingCheck = await this.checkCredentialStuffing(ip, userAgent);
    if (stuffingCheck.anomaly) {
      anomalies.push(stuffingCheck);
      riskScore += stuffingCheck.severity;
    }

    // 风险等级判定
    const riskLevel = this.determineRiskLevel(riskScore);

    // 记录分析结果
    await this.recordAnalysisResult(userId, {
      anomalies,
      riskScore,
      riskLevel,
      timestamp,
      loginData
    });

    return {
      anomalies,
      riskScore,
      riskLevel,
      recommendedAction: this.getRecommendedAction(riskLevel, anomalies)
    };
  }

  /**
   * 检查多地点同时登录
   */
  async checkMultipleLocations(userId, lat, lon, timestamp) {
    const activeSessions = await redis.get(`sessions:active:${userId}`);
    if (!activeSessions) {
      return { anomaly: false };
    }

    const sessions = JSON.parse(activeSessions);
    const recentSessions = sessions.filter(
      s => timestamp - s.timestamp < 3600000 // 1 小时内
    );

    for (const session of recentSessions) {
      if (session.lat && session.lon) {
        const distance = this.calculateDistance(lat, lon, session.lat, session.lon);
        
        // 短时间内超过 500km 的登录
        if (distance > 500 && timestamp - session.timestamp < 1800000) {
          return {
            anomaly: true,
            type: this.ANOMALY_TYPES.MULTIPLE_LOCATIONS,
            severity: 30,
            details: {
              previousLocation: { lat: session.lat, lon: session.lon },
              currentLocation: { lat, lon },
              distance,
              timeDiff: timestamp - session.timestamp
            }
          };
        }
      }
    }

    return { anomaly: false };
  }

  /**
   * 检查不可能旅行
   */
  async checkImpossibleTravel(userId, lat, lon, timestamp) {
    const lastLogin = await this.getLastLoginLocation(userId);
    if (!lastLogin) {
      return { anomaly: false };
    }

    const distance = this.calculateDistance(
      lastLogin.lat, lastLogin.lon,
      lat, lon
    );

    const timeDiff = timestamp - lastLogin.timestamp; // 毫秒
    const hours = timeDiff / 3600000;

    if (hours > 0) {
      const speed = distance / hours; // km/h
      
      if (speed > this.TRAVEL_SPEED_THRESHOLD) {
        return {
          anomaly: true,
          type: this.ANOMALY_TYPES.IMPOSSIBLE_TRAVEL,
          severity: 50,
          details: {
            distance,
            timeDiff: hours,
            speed,
            threshold: this.TRAVEL_SPEED_THRESHOLD
          }
        };
      }
    }

    return { anomaly: false };
  }

  /**
   * 检查新设备
   */
  async checkNewDevice(userId, deviceId, userAgent) {
    const knownDevices = await redis.get(`devices:known:${userId}`);
    if (!knownDevices) {
      return {
        anomaly: true,
        type: this.ANOMALY_TYPES.NEW_DEVICE,
        severity: 10,
        details: { deviceId, userAgent, isFirstDevice: true }
      };
    }

    const devices = JSON.parse(knownDevices);
    const isKnown = devices.some(d => d.deviceId === deviceId);

    if (!isKnown) {
      return {
        anomaly: true,
        type: this.ANOMALY_TYPES.NEW_DEVICE,
        severity: 15,
        details: { deviceId, userAgent, knownDeviceCount: devices.length }
      };
    }

    return { anomaly: false };
  }

  /**
   * 检查暴力破解
   */
  async checkBruteForce(userId, ip) {
    const key = `login:attempts:${userId}:${ip}`;
    const attempts = await redis.incr(key);
    await redis.expire(key, 300); // 5 分钟窗口

    if (attempts > 5) {
      return {
        anomaly: true,
        type: this.ANOMALY_TYPES.BRUTE_FORCE,
        severity: 40,
        details: { attempts, ip, window: '5min' }
      };
    }

    return { anomaly: false };
  }

  /**
   * 检查撞库攻击
   */
  async checkCredentialStuffing(ip, userAgent) {
    const key = `login:stuffing:${ip}`;
    const attempts = await redis.incr(key);
    await redis.expire(key, 60); // 1 分钟窗口

    // 同一 IP 在短时间内尝试多个账号
    if (attempts > 10) {
      return {
        anomaly: true,
        type: this.ANOMALY_TYPES.CREDENTIAL_STUFFING,
        severity: 45,
        details: { attempts, ip, userAgent }
      };
    }

    return { anomaly: false };
  }

  /**
   * 确定风险等级
   */
  determineRiskLevel(riskScore) {
    if (riskScore >= 70) return 'CRITICAL';
    if (riskScore >= 50) return 'HIGH';
    if (riskScore >= 30) return 'MEDIUM';
    if (riskScore >= 10) return 'LOW';
    return 'MINIMAL';
  }

  /**
   * 获取推荐操作
   */
  getRecommendedAction(riskLevel, anomalies) {
    const actions = {
      CRITICAL: {
        primary: 'BLOCK_AND_ALERT',
        secondary: ['require_admin_approval', 'temporary_lock'],
        notification: ['user', 'admin', 'security_team']
      },
      HIGH: {
        primary: 'TWO_FACTOR_AUTH',
        secondary: ['security_questions', 'email_verification'],
        notification: ['user', 'admin']
      },
      MEDIUM: {
        primary: 'TWO_FACTOR_AUTH',
        secondary: ['trust_verification'],
        notification: ['user']
      },
      LOW: {
        primary: 'TRUST_VERIFICATION',
        secondary: [],
        notification: ['user']
      },
      MINIMAL: {
        primary: 'ALLOW',
        secondary: [],
        notification: []
      }
    };

    return actions[riskLevel];
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

module.exports = new LoginAnomalyAnalyzer();
```

### 3. 自动响应处理器（AutoResponseHandler.js）

```javascript
// backend/shared/AutoResponseHandler.js
const logger = require('./logger');
const redis = require('./redis');
const { sendEmail, sendSMS } = require('./notification');
const GeofencingEngine = require('./GeofencingEngine');
const LoginAnomalyAnalyzer = require('./LoginAnomalyAnalyzer');

class AutoResponseHandler {
  constructor() {
    this.responseActions = {
      BLOCK_AND_ALERT: this.blockAndAlert.bind(this),
      TWO_FACTOR_AUTH: this.requireTwoFactorAuth.bind(this),
      TRUST_VERIFICATION: this.trustVerification.bind(this),
      TEMPORARY_LOCK: this.temporaryLock.bind(this),
      ALLOW: this.allowLogin.bind(this)
    };
  }

  /**
   * 处理登录响应
   */
  async handleLoginResponse(userId, loginData, analysisResult) {
    const { recommendedAction, riskLevel, anomalies } = analysisResult;

    // 记录事件
    await this.logSecurityEvent(userId, 'LOGIN_ATTEMPT', {
      riskLevel,
      anomalies,
      loginData,
      action: recommendedAction.primary
    });

    // 执行主要响应动作
    const handler = this.responseActions[recommendedAction.primary];
    if (!handler) {
      logger.error('Unknown response action', { action: recommendedAction.primary });
      return { success: false, error: 'UNKNOWN_ACTION' };
    }

    const result = await handler(userId, loginData, analysisResult);

    // 执行次要动作
    for (const secondaryAction of recommendedAction.secondary) {
      await this.executeSecondaryAction(userId, secondaryAction, analysisResult);
    }

    // 发送通知
    await this.sendNotifications(userId, recommendedAction.notification, analysisResult);

    return result;
  }

  /**
   * 阻止登录并告警
   */
  async blockAndAlert(userId, loginData, analysisResult) {
    logger.warn('Blocking suspicious login', { userId, analysisResult });

    // 记录阻止事件
    await redis.setex(`login:blocked:${userId}`, 3600, JSON.stringify({
      reason: analysisResult.anomalies,
      timestamp: Date.now(),
      ip: loginData.ip
    }));

    // 创建安全事件记录
    await this.createSecurityIncident(userId, analysisResult);

    return {
      success: false,
      action: 'BLOCKED',
      message: 'Login blocked due to suspicious activity. Please contact support.',
      supportTicket: await this.createSupportTicket(userId, analysisResult)
    };
  }

  /**
   * 要求二次验证
   */
  async requireTwoFactorAuth(userId, loginData, analysisResult) {
    const code = this.generateVerificationCode();
    
    // 存储验证码（5 分钟有效）
    await redis.setex(`login:2fa:${userId}`, 300, JSON.stringify({
      code,
      loginData,
      analysisResult
    }));

    // 发送验证码
    await sendSMS(userId, `Your verification code is: ${code}`);
    await sendEmail(userId, {
      subject: 'Login Verification Required',
      template: 'login-verification',
      data: { code, reason: analysisResult.anomalies }
    });

    return {
      success: false,
      action: 'TWO_FACTOR_REQUIRED',
      message: 'Additional verification required. Check your email/SMS.',
      verificationId: await this.generateVerificationId(userId)
    };
  }

  /**
   * 信任验证
   */
  async trustVerification(userId, loginData, analysisResult) {
    const { geofenceResult } = analysisResult;
    
    // 如果在信任区域内，允许登录
    if (geofenceResult && geofenceResult.trusted) {
      return await this.allowLogin(userId, loginData, analysisResult);
    }

    // 否则需要额外验证
    return await this.requireTwoFactorAuth(userId, loginData, analysisResult);
  }

  /**
   * 临时锁定
   */
  async temporaryLock(userId, loginData, analysisResult) {
    const lockDuration = 3600; // 1 小时

    await redis.setex(`account:locked:${userId}`, lockDuration, JSON.stringify({
      reason: analysisResult.anomalies,
      lockedAt: Date.now(),
      lockedUntil: Date.now() + lockDuration * 1000
    }));

    await sendEmail(userId, {
      subject: 'Account Temporarily Locked',
      template: 'account-locked',
      data: {
        reason: 'Suspicious login activity detected',
        unlockTime: new Date(Date.now() + lockDuration * 1000)
      }
    });

    return {
      success: false,
      action: 'TEMPORARY_LOCK',
      message: 'Account temporarily locked. Check your email for details.',
      unlockIn: lockDuration
    };
  }

  /**
   * 允许登录
   */
  async allowLogin(userId, loginData, analysisResult) {
    // 更新活跃会话
    await this.updateActiveSession(userId, loginData);

    // 更新信任区域
    await GeofencingEngine.buildTrustZones(userId);

    return {
      success: true,
      action: 'ALLOWED',
      message: 'Login successful',
      warnings: analysisResult.anomalies.length > 0 ? analysisResult.anomalies : null
    };
  }

  /**
   * 生成验证码
   */
  generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * 记录安全事件
   */
  async logSecurityEvent(userId, eventType, data) {
    const event = {
      userId,
      eventType,
      data,
      timestamp: Date.now()
    };

    await redis.lpush('security:events', JSON.stringify(event));
    await redis.ltrim('security:events', 0, 9999); // 保留最近 10000 条

    logger.info('Security event logged', { userId, eventType, riskLevel: data.riskLevel });
  }

  /**
   * 发送通知
   */
  async sendNotifications(userId, recipients, analysisResult) {
    for (const recipient of recipients) {
      switch (recipient) {
        case 'user':
          await sendEmail(userId, {
            subject: 'Security Alert',
            template: 'security-alert',
            data: { anomalies: analysisResult.anomalies }
          });
          break;
        case 'admin':
          await this.notifyAdmin(userId, analysisResult);
          break;
        case 'security_team':
          await this.notifySecurityTeam(userId, analysisResult);
          break;
      }
    }
  }
}

module.exports = new AutoResponseHandler();
```

### 4. 登录中间件集成

```javascript
// backend/shared/middleware/loginSecurityMiddleware.js
const GeofencingEngine = require('../GeofencingEngine');
const LoginAnomalyAnalyzer = require('../LoginAnomalyAnalyzer');
const AutoResponseHandler = require('../AutoResponseHandler');

async function loginSecurityMiddleware(req, res, next) {
  const { userId } = req.body;
  const loginData = {
    userId,
    deviceId: req.headers['x-device-id'],
    ip: req.ip || req.connection.remoteAddress,
    lat: parseFloat(req.headers['x-lat']),
    lon: parseFloat(req.headers['x-lon']),
    userAgent: req.headers['user-agent'],
    timestamp: Date.now()
  };

  try {
    // 1. 地理围栏检查
    const geofenceResult = await GeofencingEngine.checkLoginLocation(
      userId,
      loginData.lat,
      loginData.lon
    );

    // 2. 异常行为分析
    const analysisResult = await LoginAnomalyAnalyzer.analyzeLoginAttempt(
      userId,
      loginData
    );

    analysisResult.geofenceResult = geofenceResult;

    // 3. 自动响应
    const response = await AutoResponseHandler.handleLoginResponse(
      userId,
      loginData,
      analysisResult
    );

    if (!response.success) {
      return res.status(403).json({
        error: 'LOGIN_SECURITY_CHECK_FAILED',
        message: response.message,
        action: response.action,
        verificationId: response.verificationId
      });
    }

    req.loginSecurity = {
      analysisResult,
      response
    };

    next();
  } catch (error) {
    console.error('Login security middleware error:', error);
    // 安全检查失败时，默认允许登录但记录警告
    next();
  }
}

module.exports = loginSecurityMiddleware;
```

### 5. 数据库迁移

```sql
-- database/migrations/20260701_02_geofencing_system.sql

-- 用户地理围栏信任区域表
CREATE TABLE user_trust_zones (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  zone_name VARCHAR(100),
  centroid_lat DECIMAL(10, 8) NOT NULL,
  centroid_lon DECIMAL(11, 8) NOT NULL,
  radius_km DECIMAL(10, 2) NOT NULL DEFAULT 50.0,
  login_count INTEGER DEFAULT 0,
  last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_id (user_id),
  INDEX idx_last_login (last_login_at)
);

-- 用户登录历史表
CREATE TABLE user_login_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  device_id VARCHAR(100),
  ip_address VARCHAR(45),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  user_agent TEXT,
  login_result VARCHAR(20), -- 'SUCCESS', 'BLOCKED', '2FA_REQUIRED', 'FAILED'
  risk_score INTEGER,
  risk_level VARCHAR(20),
  anomalies JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_ip_address (ip_address),
  INDEX idx_login_result (login_result)
);

-- 安全事件表
CREATE TABLE security_events (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50),
  event_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL, -- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  event_data JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  handled BOOLEAN DEFAULT FALSE,
  handled_by VARCHAR(50),
  handled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_severity (user_id, severity),
  INDEX idx_created_at (created_at DESC),
  INDEX idx_event_type (event_type)
);

-- 用户设备白名单表
CREATE TABLE user_device_whitelist (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  device_id VARCHAR(100) NOT NULL,
  device_name VARCHAR(100),
  device_type VARCHAR(50), -- 'MOBILE', 'TABLET', 'DESKTOP'
  user_agent TEXT,
  trust_level VARCHAR(20) DEFAULT 'MEDIUM',
  last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE INDEX idx_user_device (user_id, device_id),
  INDEX idx_trust_level (trust_level)
);

-- 用户自定义地理围栏表
CREATE TABLE user_custom_geofences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  center_lat DECIMAL(10, 8) NOT NULL,
  center_lon DECIMAL(11, 8) NOT NULL,
  radius_km DECIMAL(10, 2) NOT NULL,
  fence_type VARCHAR(20) NOT NULL, -- 'ALLOW', 'DENY', 'VERIFY'
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_fence (user_id, is_active)
);

-- 插入触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_trust_zones_updated_at
  BEFORE UPDATE ON user_trust_zones
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_custom_geofences_updated_at
  BEFORE UPDATE ON user_custom_geofences
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

### 6. 用户自定义地理围栏 API

```javascript
// user-service/src/routes/geofenceRoutes.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const GeofencingEngine = require('../../../shared/GeofencingEngine');

/**
 * 获取用户信任区域
 */
router.get('/trust-zones', auth, async (req, res) => {
  try {
    const zones = await GeofencingEngine.buildTrustZones(req.user.id);
    res.json({ success: true, zones });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get trust zones' });
  }
});

/**
 * 添加自定义地理围栏
 */
router.post('/custom', auth, async (req, res) => {
  const { name, centerLat, centerLon, radiusKm, fenceType } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO user_custom_geofences 
       (user_id, name, center_lat, center_lon, radius_km, fence_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.id, name, centerLat, centerLon, radiusKm, fenceType]
    );

    res.json({ success: true, geofence: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create custom geofence' });
  }
});

/**
 * 删除自定义地理围栏
 */
router.delete('/custom/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_custom_geofences 
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete custom geofence' });
  }
});

/**
 * 获取登录历史
 */
router.get('/login-history', auth, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  try {
    const result = await pool.query(
      `SELECT * FROM user_login_history 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    res.json({ success: true, history: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get login history' });
  }
});

/**
 * 获取设备列表
 */
router.get('/devices', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM user_device_whitelist 
       WHERE user_id = $1 
       ORDER BY last_used_at DESC`,
      [req.user.id]
    );

    res.json({ success: true, devices: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

/**
 * 移除设备
 */
router.delete('/devices/:id', auth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM user_device_whitelist 
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 实现地理围栏引擎，支持自动构建信任区域和动态更新
- [ ] 实现异常登录行为分析器，识别 6 种以上异常类型
- [ ] 实现自动响应处理器，支持 5 种响应动作
- [ ] 集成登录安全中间件到 user-service
- [ ] 完成数据库迁移，创建相关表结构
- [ ] 实现用户自定义地理围栏 API（增删查）
- [ ] 实现设备白名单管理功能
- [ ] 添加单元测试，覆盖率 > 80%
- [ ] 性能测试：登录检查延迟 < 100ms
- [ ] 安全测试：通过 OWASP 认证测试
- [ ] 文档完善：API 文档、运维手册

## 影响范围

- **新增文件**：
  - `backend/shared/GeofencingEngine.js`
  - `backend/shared/LoginAnomalyAnalyzer.js`
  - `backend/shared/AutoResponseHandler.js`
  - `backend/shared/middleware/loginSecurityMiddleware.js`
  - `database/migrations/20260701_02_geofencing_system.sql`
  - `user-service/src/routes/geofenceRoutes.js`

- **修改文件**：
  - `user-service/src/index.js`（挂载路由）
  - `backend/shared/notification.js`（添加安全通知方法）

- **依赖服务**：
  - Redis（存储会话、信任区域、验证码）
  - PostgreSQL（持久化登录历史、安全事件）
  - 通知服务（SMS、Email）

## 参考

- [OWASP Authentication Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [NIST Digital Identity Guidelines](https://pages.nist.gov/800-63-3/)
- [DBSCAN Clustering Algorithm](https://www.kdnuggets.com/2020/04/dbscan-clustering-algorithm-machine-learning.html)
- GeoJSON Specification (RFC 7946)
