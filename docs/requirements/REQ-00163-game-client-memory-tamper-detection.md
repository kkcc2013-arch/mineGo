# REQ-00163: 游戏客户端内存篡改检测与防护系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00163 |
| 标题 | 游戏客户端内存篡改检测与防护系统 |
| 类别 | 反作弊 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、catch-service、gym-service、backend/shared |
| 创建时间 | 2026-06-13 16:00 |

## 需求描述

游戏客户端（尤其是 Unity WebGL）运行在用户浏览器环境中，面临多种内存篡改攻击风险，包括但不限于：
- 通过浏览器开发者工具修改游戏内存变量（如精灵数量、金币、道具）
- 使用 Cheat Engine 等工具修改 WebAssembly 内存
- 注入恶意脚本拦截或篡改网络请求
- 修改本地存储（localStorage/IndexedDB）中的游戏数据

本系统旨在建立多层次的客户端内存篡改检测与防护机制，确保游戏数据的完整性和公平性。

### 核心目标
1. **运行时内存完整性校验**：定期检测关键游戏变量的完整性
2. **服务端数据一致性验证**：客户端状态与服务端记录实时比对
3. **异常行为自动检测**：识别不合理的数值变化模式
4. **防护措施联动**：检测到篡改时自动触发惩罚机制

## 技术方案

### 1. 客户端内存完整性校验模块

```javascript
// game-client/src/security/MemoryIntegrityGuard.js

export class MemoryIntegrityGuard {
  constructor() {
    this.checksumMap = new Map(); // 变量校验和映射
    this.honeypotValues = new Map(); // 诱饵值
    this.checkInterval = 30000; // 30秒检查一次
    this.tamperCount = 0;
    this.maxTamperCount = 3;
    
    this.initHoneypots();
    this.startPeriodicCheck();
  }
  
  // 初始化诱饵值（用于检测内存扫描行为）
  initHoneypots() {
    // 伪装成金币的诱饵
    this.honeypotValues.set('fake_gold', 999999);
    // 伪装成精灵数量的诱饵
    this.honeypotValues.set('fake_pokemon_count', 999);
    // 伪装成稀有道具的诱饵
    this.honeypotValues.set('fake_rare_items', 100);
  }
  
  // 注册需要监控的变量
  registerVariable(name, getter, setter) {
    const initialValue = getter();
    const checksum = this.calculateChecksum(initialValue);
    
    this.checksumMap.set(name, {
      getter,
      setter,
      lastChecksum: checksum,
      lastValue: initialValue,
      lastUpdate: Date.now(),
      tamperScore: 0
    });
  }
  
  // 计算校验和（使用简单哈希 + 时间戳混淆）
  calculateChecksum(value) {
    const str = JSON.stringify(value);
    const timeSalt = Math.floor(Date.now() / 60000); // 每分钟变化
    let hash = 0;
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char + timeSalt;
      hash = hash & hash;
    }
    
    return hash;
  }
  
  // 定期完整性检查
  startPeriodicCheck() {
    setInterval(() => {
      this.performIntegrityCheck();
    }, this.checkInterval);
  }
  
  async performIntegrityCheck() {
    const violations = [];
    
    for (const [name, config] of this.checksumMap) {
      const currentValue = config.getter();
      const expectedChecksum = config.lastChecksum;
      const actualChecksum = this.calculateChecksum(currentValue);
      
      // 检测未经授权的变化
      if (actualChecksum !== expectedChecksum) {
        // 检查是否通过正常 API 更新
        const isValidChange = await this.verifyWithServer(name, currentValue);
        
        if (!isValidChange) {
          violations.push({
            variable: name,
            expectedValue: config.lastValue,
            actualValue: currentValue,
            timestamp: Date.now()
          });
          
          config.tamperScore += 1;
        } else {
          // 合法更新，更新校验和
          config.lastChecksum = actualChecksum;
          config.lastValue = currentValue;
        }
      }
    }
    
    // 检查诱饵值是否被修改
    for (const [name, fakeValue] of this.honeypotValues) {
      if (fakeValue !== this.getHoneypotValue(name)) {
        violations.push({
          variable: name,
          type: 'HONEYPOT_MODIFIED',
          severity: 'CRITICAL'
        });
      }
    }
    
    if (violations.length > 0) {
      await this.reportTampering(violations);
    }
  }
  
  // 与服务端验证数据合法性
  async verifyWithServer(variableName, currentValue) {
    try {
      const response = await fetch('/api/security/verify-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variable: variableName,
          value: currentValue,
          timestamp: Date.now()
        })
      });
      
      const result = await response.json();
      return result.valid === true;
    } catch (error) {
      console.error('Server verification failed:', error);
      return false;
    }
  }
  
  // 上报篡改事件
  async reportTampering(violations) {
    this.tamperCount++;
    
    const report = {
      userId: window.gameState?.userId,
      deviceId: window.gameState?.deviceId,
      sessionId: window.gameState?.sessionId,
      violations,
      tamperCount: this.tamperCount,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
      // 收集环境信息
      environment: {
        devToolsOpen: this.detectDevTools(),
        debuggerPresent: this.detectDebugger(),
        webAssemblyModified: await this.checkWebAssemblyIntegrity()
      }
    };
    
    // 发送到服务端
    await fetch('/api/security/report-tamper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    });
    
    // 本地处理
    if (this.tamperCount >= this.maxTamperCount) {
      this.triggerProtection(violations);
    }
  }
  
  // 检测开发者工具
  detectDevTools() {
    const threshold = 160;
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;
    return widthThreshold || heightThreshold;
  }
  
  // 检测调试器
  detectDebugger() {
    const start = performance.now();
    debugger; // 如果调试器开启，这里会暂停
    const end = performance.now();
    return end - start > 100; // 超过100ms说明被调试
  }
  
  // 检查 WebAssembly 完整性
  async checkWebAssemblyIntegrity() {
    try {
      // 获取预期 WASM 哈希
      const response = await fetch('/api/security/wasm-hash');
      const { expectedHash } = await response.json();
      
      // 计算当前 WASM 哈希（简化示例）
      const wasmModule = await WebAssembly.compileStreaming(fetch('/game.wasm'));
      const wasmHash = await this.hashArrayBuffer(wasmModule);
      
      return wasmHash !== expectedHash;
    } catch {
      return false;
    }
  }
  
  // 触发保护措施
  triggerProtection(violations) {
    // 根据严重程度采取不同措施
    const severity = this.calculateSeverity(violations);
    
    if (severity === 'CRITICAL') {
      // 立即断开连接并标记账号
      window.gameState?.forceLogout('SECURITY_VIOLATION');
    } else if (severity === 'HIGH') {
      // 限制游戏功能
      window.gameState?.restrictFeatures(['trade', 'gym', 'pvp']);
    } else {
      // 显示警告
      window.gameState?.showWarning('检测到异常行为，请正常游戏');
    }
  }
  
  calculateSeverity(violations) {
    const criticalTypes = ['HONEYPOT_MODIFIED', 'WASM_MODIFIED'];
    const hasCritical = violations.some(v => criticalTypes.includes(v.type));
    
    if (hasCritical) return 'CRITICAL';
    if (violations.length >= 3) return 'HIGH';
    return 'MEDIUM';
  }
}

// 全局实例
window.memoryGuard = new MemoryIntegrityGuard();
```

### 2. 服务端状态验证服务

```javascript
// backend/shared/security/StateVerificationService.js

const redis = require('../redis');
const db = require('../db');
const { v4: uuidv4 } = require('crypto');

class StateVerificationService {
  constructor() {
    this.verificationWindow = 60000; // 1分钟验证窗口
    this.toleranceThreshold = 0.1; // 10% 容差
  }
  
  /**
   * 验证客户端状态是否合法
   */
  async verifyClientState(userId, variableName, clientValue) {
    // 获取服务端记录的真实值
    const serverValue = await this.getServerValue(userId, variableName);
    
    if (serverValue === null) {
      return { valid: false, reason: 'VARIABLE_NOT_FOUND' };
    }
    
    // 对于数值类型，检查是否在合理范围内
    if (typeof serverValue === 'number') {
      const isWithinTolerance = this.isWithinTolerance(
        clientValue, 
        serverValue, 
        this.toleranceThreshold
      );
      
      // 检查是否有缓存操作待确认
      const pendingOps = await this.getPendingOperations(userId, variableName);
      const pendingDelta = this.calculatePendingDelta(pendingOps);
      
      const expectedClientValue = serverValue + pendingDelta;
      const isValid = Math.abs(clientValue - expectedClientValue) <= 1;
      
      return { 
        valid: isValid,
        serverValue,
        pendingDelta,
        reason: isValid ? null : 'VALUE_MISMATCH'
      };
    }
    
    // 对于对象类型，深度比较
    return {
      valid: JSON.stringify(clientValue) === JSON.stringify(serverValue),
      reason: 'OBJECT_MISMATCH'
    };
  }
  
  /**
   * 获取服务端记录的值
   */
  async getServerValue(userId, variableName) {
    const valueMap = {
      'gold': async () => {
        const user = await db.query(
          'SELECT gold FROM users WHERE id = $1',
          [userId]
        );
        return user.rows[0]?.gold;
      },
      'pokemon_count': async () => {
        const result = await db.query(
          'SELECT COUNT(*) as count FROM user_pokemon WHERE user_id = $1',
          [userId]
        );
        return parseInt(result.rows[0].count);
      },
      'items': async () => {
        const result = await db.query(
          'SELECT item_id, quantity FROM user_items WHERE user_id = $1',
          [userId]
        );
        return result.rows;
      },
      'stardust': async () => {
        const user = await db.query(
          'SELECT stardust FROM users WHERE id = $1',
          [userId]
        );
        return user.rows[0]?.stardust;
      }
    };
    
    const getter = valueMap[variableName];
    if (!getter) return null;
    
    // 先检查 Redis 缓存
    const cacheKey = `state:${userId}:${variableName}`;
    const cached = await redis.get(cacheKey);
    
    if (cached !== null) {
      return JSON.parse(cached);
    }
    
    const value = await getter();
    
    // 缓存 30 秒
    await redis.setex(cacheKey, 30, JSON.stringify(value));
    
    return value;
  }
  
  /**
   * 获取待确认的操作
   */
  async getPendingOperations(userId, variableName) {
    const key = `pending_ops:${userId}:${variableName}`;
    const ops = await redis.lrange(key, 0, -1);
    return ops.map(op => JSON.parse(op));
  }
  
  /**
   * 计算待确认操作的累计变化量
   */
  calculatePendingDelta(operations) {
    return operations.reduce((sum, op) => {
      if (op.type === 'add') return sum + op.amount;
      if (op.type === 'subtract') return sum - op.amount;
      return sum;
    }, 0);
  }
  
  /**
   * 记录篡改事件
   */
  async recordTamperEvent(report) {
    const {
      userId,
      deviceId,
      sessionId,
      violations,
      tamperCount,
      environment
    } = report;
    
    // 存储到数据库
    await db.query(`
      INSERT INTO security_incidents (
        user_id, device_id, session_id, incident_type, 
        severity, details, environment_info, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [
      userId,
      deviceId,
      sessionId,
      'MEMORY_TAMPER',
      this.calculateIncidentSeverity(violations),
      JSON.stringify(violations),
      JSON.stringify(environment)
    ]);
    
    // 更新用户风险评分
    await this.updateRiskScore(userId, violations);
    
    // 检查是否需要自动封禁
    await this.checkAutoBan(userId, tamperCount);
    
    // 发送告警
    await this.sendSecurityAlert(userId, violations);
  }
  
  /**
   * 更新用户风险评分
   */
  async updateRiskScore(userId, violations) {
    const key = `risk_score:${userId}`;
    const currentScore = parseInt(await redis.get(key) || '0');
    
    // 每次篡改事件增加风险分
    const scoreIncrease = violations.reduce((sum, v) => {
      if (v.severity === 'CRITICAL') return sum + 50;
      if (v.type === 'HONEYPOT_MODIFIED') return sum + 30;
      return sum + 10;
    }, 0);
    
    const newScore = Math.min(currentScore + scoreIncrease, 100);
    
    // 缓存 24 小时
    await redis.setex(key, 86400, newScore.toString());
    
    // 持久化到数据库
    await db.query(
      'UPDATE users SET risk_score = $1 WHERE id = $2',
      [newScore, userId]
    );
  }
  
  /**
   * 检查自动封禁
   */
  async checkAutoBan(userId, tamperCount) {
    // 3 次篡改事件自动封禁 24 小时
    if (tamperCount >= 3) {
      await this.banUser(userId, 24 * 60 * 60, 'MEMORY_TAMPER_DETECTED');
    }
    
    // 检查风险评分
    const riskScore = await redis.get(`risk_score:${userId}`);
    if (parseInt(riskScore) >= 80) {
      await this.banUser(userId, 7 * 24 * 60 * 60, 'HIGH_RISK_SCORE');
    }
  }
  
  /**
   * 封禁用户
   */
  async banUser(userId, durationSeconds, reason) {
    const banUntil = new Date(Date.now() + durationSeconds * 1000);
    
    await db.query(`
      UPDATE users 
      SET status = 'banned', 
          ban_until = $1, 
          ban_reason = $2 
      WHERE id = $3
    `, [banUntil, reason, userId]);
    
    // 使所有会话失效
    await redis.del(`session:${userId}`);
    
    // 记录封禁日志
    await db.query(`
      INSERT INTO ban_history (user_id, reason, duration, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [userId, reason, durationSeconds]);
  }
  
  /**
   * 发送安全告警
   */
  async sendSecurityAlert(userId, violations) {
    // 发送到告警系统
    await redis.publish('security:alerts', JSON.stringify({
      type: 'MEMORY_TAMPER',
      userId,
      severity: this.calculateIncidentSeverity(violations),
      timestamp: Date.now()
    }));
  }
  
  calculateIncidentSeverity(violations) {
    const hasCritical = violations.some(v => 
      v.severity === 'CRITICAL' || v.type === 'HONEYPOT_MODIFIED'
    );
    
    if (hasCritical) return 'CRITICAL';
    if (violations.length >= 3) return 'HIGH';
    if (violations.length >= 1) return 'MEDIUM';
    return 'LOW';
  }
  
  isWithinTolerance(value, expected, tolerance) {
    if (expected === 0) return value === 0;
    return Math.abs(value - expected) / expected <= tolerance;
  }
}

module.exports = new StateVerificationService();
```

### 3. 网关层安全拦截中间件

```javascript
// gateway/src/middleware/memoryTamperGuard.js

const stateVerification = require('../../shared/security/StateVerificationService');

class MemoryTamperGuard {
  constructor() {
    this.suspiciousPatterns = new Map();
    this.checkThresholds = {
      goldChange: 10000,      // 单次金币变化超过 10000
      pokemonChange: 50,      // 单次精灵变化超过 50
      itemChange: 100,        // 单次道具变化超过 100
      rapidActions: 20        // 1分钟内操作超过 20 次
    };
  }
  
  /**
   * 中间件入口
   */
  middleware() {
    return async (req, res, next) => {
      const userId = req.user?.id;
      if (!userId) return next();
      
      // 检查用户风险评分
      const riskScore = await this.getUserRiskScore(userId);
      if (riskScore >= 90) {
        return res.status(403).json({
          error: 'ACCOUNT_SUSPENDED',
          message: '账号因安全原因被暂停，请联系客服'
        });
      }
      
      // 对关键操作进行额外验证
      if (this.isCriticalOperation(req)) {
        const isValid = await this.verifyCriticalOperation(req);
        if (!isValid) {
          return res.status(400).json({
            error: 'STATE_VERIFICATION_FAILED',
            message: '状态验证失败，请刷新页面重试'
          });
        }
      }
      
      // 检测可疑模式
      await this.detectSuspiciousPattern(userId, req);
      
      next();
    };
  }
  
  /**
   * 判断是否为关键操作
   */
  isCriticalOperation(req) {
    const criticalPaths = [
      '/api/pokemon/catch',
      '/api/pokemon/evolve',
      '/api/pokemon/trade',
      '/api/gym/battle',
      '/api/shop/purchase',
      '/api/items/use'
    ];
    
    return criticalPaths.some(path => req.path.startsWith(path));
  }
  
  /**
   * 验证关键操作的合法性
   */
  async verifyCriticalOperation(req) {
    const userId = req.user.id;
    const body = req.body;
    
    // 检查请求中的客户端状态是否与服务端一致
    if (body.clientState) {
      for (const [key, value] of Object.entries(body.clientState)) {
        const result = await stateVerification.verifyClientState(userId, key, value);
        if (!result.valid) {
          await this.recordVerificationFailure(userId, key, result);
          return false;
        }
      }
    }
    
    return true;
  }
  
  /**
   * 检测可疑操作模式
   */
  async detectSuspiciousPattern(userId, req) {
    const key = `suspicious:${userId}`;
    const now = Date.now();
    
    // 获取最近的操作记录
    const recentActions = await this.getRecentActions(userId);
    
    // 检测高频操作
    if (recentActions.length >= this.checkThresholds.rapidActions) {
      await this.flagSuspiciousActivity(userId, 'RAPID_ACTIONS', {
        actionCount: recentActions.length,
        timeWindow: 60000
      });
    }
    
    // 检测异常数值变化
    if (req.body.goldChange && Math.abs(req.body.goldChange) > this.checkThresholds.goldChange) {
      await this.flagSuspiciousActivity(userId, 'ABNORMAL_GOLD_CHANGE', {
        change: req.body.goldChange
      });
    }
    
    // 记录本次操作
    await this.recordAction(userId, req.path, now);
  }
  
  /**
   * 记录验证失败
   */
  async recordVerificationFailure(userId, variable, result) {
    const key = `verification_failures:${userId}`;
    const failures = JSON.parse(await redis.get(key) || '[]');
    
    failures.push({
      variable,
      reason: result.reason,
      timestamp: Date.now()
    });
    
    // 保留最近 10 次失败记录
    if (failures.length > 10) {
      failures.shift();
    }
    
    await redis.setex(key, 3600, JSON.stringify(failures));
    
    // 多次验证失败增加风险评分
    if (failures.length >= 3) {
      await this.increaseRiskScore(userId, 20);
    }
  }
  
  /**
   * 标记可疑活动
   */
  async flagSuspiciousActivity(userId, type, details) {
    await db.query(`
      INSERT INTO suspicious_activities (
        user_id, activity_type, details, created_at
      ) VALUES ($1, $2, $3, NOW())
    `, [userId, type, JSON.stringify(details)]);
    
    await this.increaseRiskScore(userId, 10);
  }
  
  async getUserRiskScore(userId) {
    const score = await redis.get(`risk_score:${userId}`);
    return parseInt(score || '0');
  }
  
  async increaseRiskScore(userId, amount) {
    const key = `risk_score:${userId}`;
    const current = parseInt(await redis.get(key) || '0');
    const newScore = Math.min(current + amount, 100);
    await redis.setex(key, 86400, newScore.toString());
  }
  
  async getRecentActions(userId) {
    const key = `recent_actions:${userId}`;
    const actions = await redis.lrange(key, 0, -1);
    return actions.map(a => JSON.parse(a));
  }
  
  async recordAction(userId, path, timestamp) {
    const key = `recent_actions:${userId}`;
    await redis.lpush(key, JSON.stringify({ path, timestamp }));
    await redis.ltrim(key, 0, 99); // 保留最近 100 条
    await redis.expire(key, 300); // 5 分钟过期
  }
}

module.exports = new MemoryTamperGuard();
```

### 4. 数据库迁移脚本

```sql
-- database/migrations/034_create_security_tables.sql

-- 安全事件表
CREATE TABLE IF NOT EXISTS security_incidents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id VARCHAR(255),
  session_id VARCHAR(255),
  incident_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  details JSONB NOT NULL DEFAULT '{}',
  environment_info JSONB DEFAULT '{}',
  resolved BOOLEAN DEFAULT FALSE,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_security_incidents_user_id ON security_incidents(user_id);
CREATE INDEX idx_security_incidents_type ON security_incidents(incident_type);
CREATE INDEX idx_security_incidents_severity ON security_incidents(severity);
CREATE INDEX idx_security_incidents_created_at ON security_incidents(created_at);

-- 可疑活动表
CREATE TABLE IF NOT EXISTS suspicious_activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  activity_type VARCHAR(100) NOT NULL,
  details JSONB DEFAULT '{}',
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_suspicious_activities_user_id ON suspicious_activities(user_id);
CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(activity_type);
CREATE INDEX idx_suspicious_activities_created_at ON suspicious_activities(created_at);

-- 封禁历史表
CREATE TABLE IF NOT EXISTS ban_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason VARCHAR(255) NOT NULL,
  duration INTEGER NOT NULL, -- 秒
  unbanned_at TIMESTAMP,
  unbanned_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ban_history_user_id ON ban_history(user_id);

-- 用户表增加风险评分字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until TIMESTAMP;

CREATE INDEX idx_users_risk_score ON users(risk_score);

-- 待确认操作队列表（可选，也可仅用 Redis）
CREATE TABLE IF NOT EXISTS pending_operations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  variable_name VARCHAR(100) NOT NULL,
  operation_type VARCHAR(20) NOT NULL CHECK (operation_type IN ('add', 'subtract', 'set')),
  amount INTEGER,
  value JSONB,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired')),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_pending_operations_user_var ON pending_operations(user_id, variable_name);
CREATE INDEX idx_pending_operations_status ON pending_operations(status);
```

### 5. 管理后台接口

```javascript
// backend/services/admin-service/src/routes/security.js

const express = require('express');
const router = express.Router();
const db = require('../../../shared/db');

/**
 * 获取安全事件列表
 */
router.get('/incidents', async (req, res) => {
  const { 
    page = 1, 
    limit = 20, 
    severity, 
    incidentType,
    userId 
  } = req.query;
  
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM security_incidents WHERE 1=1';
  const params = [];
  
  if (severity) {
    params.push(severity);
    query += ` AND severity = $${params.length}`;
  }
  
  if (incidentType) {
    params.push(incidentType);
    query += ` AND incident_type = $${params.length}`;
  }
  
  if (userId) {
    params.push(userId);
    query += ` AND user_id = $${params.length}`;
  }
  
  params.push(limit, offset);
  query += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  
  const result = await db.query(query, params);
  
  res.json({
    incidents: result.rows,
    page: parseInt(page),
    limit: parseInt(limit)
  });
});

/**
 * 获取用户安全画像
 */
router.get('/users/:userId/profile', async (req, res) => {
  const { userId } = req.params;
  
  const [
    userResult,
    incidentsResult,
    activitiesResult,
    bansResult
  ] = await Promise.all([
    db.query('SELECT id, username, risk_score, status, ban_until, ban_reason FROM users WHERE id = $1', [userId]),
    db.query('SELECT COUNT(*) as count, severity FROM security_incidents WHERE user_id = $1 GROUP BY severity', [userId]),
    db.query('SELECT COUNT(*) as count, activity_type FROM suspicious_activities WHERE user_id = $1 GROUP BY activity_type', [userId]),
    db.query('SELECT * FROM ban_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [userId])
  ]);
  
  res.json({
    user: userResult.rows[0],
    incidentSummary: incidentsResult.rows,
    activitySummary: activitiesResult.rows,
    banHistory: bansResult.rows
  });
});

/**
 * 手动封禁/解封用户
 */
router.post('/users/:userId/ban', async (req, res) => {
  const { userId } = req.params;
  const { duration, reason } = req.body;
  const adminId = req.user.id;
  
  const banUntil = duration ? new Date(Date.now() + duration * 1000) : null;
  
  await db.query(`
    UPDATE users 
    SET status = 'banned', ban_until = $1, ban_reason = $2 
    WHERE id = $3
  `, [banUntil, reason, userId]);
  
  await db.query(`
    INSERT INTO ban_history (user_id, reason, duration)
    VALUES ($1, $2, $3)
  `, [userId, reason, duration]);
  
  res.json({ success: true, banUntil });
});

/**
 * 解封用户
 */
router.post('/users/:userId/unban', async (req, res) => {
  const { userId } = req.params;
  const adminId = req.user.id;
  
  await db.query(`
    UPDATE users 
    SET status = 'active', ban_until = NULL, ban_reason = NULL, risk_score = 0
    WHERE id = $1
  `, [userId]);
  
  await db.query(`
    UPDATE ban_history 
    SET unbanned_at = NOW(), unbanned_by = $1 
    WHERE user_id = $2 AND unbanned_at IS NULL
  `, [adminId, userId]);
  
  res.json({ success: true });
});

/**
 * 标记事件已处理
 */
router.post('/incidents/:incidentId/resolve', async (req, res) => {
  const { incidentId } = req.params;
  const adminId = req.user.id;
  
  await db.query(`
    UPDATE security_incidents 
    SET resolved = TRUE, resolved_by = $1, resolved_at = NOW()
    WHERE id = $2
  `, [adminId, incidentId]);
  
  res.json({ success: true });
});

module.exports = router;
```

### 6. WebAssembly 完整性校验服务

```javascript
// backend/shared/security/WasmIntegrityService.js

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class WasmIntegrityService {
  constructor() {
    this.wasmHashes = new Map();
    this.lastUpdate = 0;
    this.updateInterval = 3600000; // 1小时更新一次
  }
  
  /**
   * 初始化：计算所有 WASM 文件的哈希
   */
  async init() {
    const wasmDir = path.join(__dirname, '../../../game-client/public');
    const wasmFiles = await this.findWasmFiles(wasmDir);
    
    for (const file of wasmFiles) {
      const hash = await this.calculateFileHash(file);
      this.wasmHashes.set(path.basename(file), hash);
    }
    
    this.lastUpdate = Date.now();
  }
  
  /**
   * 查找所有 WASM 文件
   */
  async findWasmFiles(dir) {
    const files = [];
    
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          files.push(...await this.findWasmFiles(fullPath));
        } else if (entry.name.endsWith('.wasm')) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      console.error('Error finding WASM files:', err);
    }
    
    return files;
  }
  
  /**
   * 计算文件 SHA256 哈希
   */
  async calculateFileHash(filePath) {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * 获取指定 WASM 文件的预期哈希
   */
  async getWasmHash(filename) {
    // 定期更新哈希
    if (Date.now() - this.lastUpdate > this.updateInterval) {
      await this.init();
    }
    
    return this.wasmHashes.get(filename) || null;
  }
  
  /**
   * 验证客户端提交的 WASM 哈希
   */
  async verifyWasmIntegrity(filename, clientHash) {
    const expectedHash = await this.getWasmHash(filename);
    
    if (!expectedHash) {
      return { valid: false, reason: 'WASM_NOT_FOUND' };
    }
    
    return {
      valid: clientHash === expectedHash,
      reason: clientHash === expectedHash ? null : 'HASH_MISMATCH'
    };
  }
}

// 单例
const instance = new WasmIntegrityService();
instance.init().catch(console.error);

module.exports = instance;
```

## 验收标准

- [ ] 客户端内存完整性校验模块已实现并集成到游戏主循环
- [ ] 诱饵值（honeypot）机制已部署，能检测内存扫描行为
- [ ] 服务端状态验证服务已实现，支持金币、精灵数量、道具等关键数据验证
- [ ] 网关层安全拦截中间件已部署，能拦截状态不一致的请求
- [ ] 数据库迁移脚本已执行，security_incidents、suspicious_activities、ban_history 表已创建
- [ ] 用户风险评分系统已实现，评分范围 0-100
- [ ] 自动封禁机制已实现，3 次篡改事件自动封禁 24 小时
- [ ] 管理后台安全事件查看接口已实现
- [ ] WebAssembly 完整性校验服务已实现，能检测 WASM 文件被篡改
- [ ] 安全事件能正确记录并触发告警
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试：模拟内存篡改攻击，验证检测和封禁流程

## 影响范围

- **game-client**: 新增 `src/security/MemoryIntegrityGuard.js`
- **gateway**: 新增 `src/middleware/memoryTamperGuard.js`
- **backend/shared**: 新增 `security/StateVerificationService.js`、`security/WasmIntegrityService.js`
- **backend/services/admin-service**: 新增 `src/routes/security.js`
- **database/migrations**: 新增 `034_create_security_tables.sql`
- **所有微服务**: 需要配合提供状态查询接口

## 参考

- [OWASP Cheat Sheet Series - Browser Security](https://cheatsheetseries.owasp.org/cheatsheets/Browser_Security_Cheat_Sheet.html)
- [WebAssembly Security](https://webassembly.org/docs/security/)
- [Unity WebGL Security Best Practices](https://docs.unity3d.com/Manual/webgl-security.html)
- [Anti-Cheat Systems Design Patterns](https://www.gamedeveloper.com/business/anti-cheat-systems-design-patterns)
