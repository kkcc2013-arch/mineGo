# REQ-00181: 游戏客户端内存完整性保护与篡改检测系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00181 |
| 标题 | 游戏客户端内存完整性保护与篡改检测系统 |
| 类别 | 反作弊 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、catch-service、gym-service、backend/shared |
| 创建时间 | 2026-06-14 04:00 |

## 需求描述

游戏客户端面临内存篡改攻击的严重威胁，恶意玩家通过修改客户端内存中的精灵属性、战斗数值、捕捉概率等关键数据获取不正当优势。本需求实现一套完整的内存完整性保护系统，包括：

1. **关键数据完整性校验**：对精灵属性、战斗数值、捕捉概率等关键数据进行实时完整性验证
2. **内存扫描检测**：检测常见的内存修改工具（如 Cheat Engine、GameGuardian）
3. **代码注入检测**：识别 DLL 注入、代码 Hook 等攻击行为
4. **运行时行为分析**：监测异常的内存访问模式和行为
5. **服务器协同验证**：关键操作在服务器端进行二次验证

## 技术方案

### 1. 客户端内存完整性校验模块

```javascript
// frontend/game-client/src/security/MemoryIntegrityGuard.js

class MemoryIntegrityGuard {
  constructor() {
    this.protectedValues = new Map();
    this.checksums = new Map();
    this.lastValidHash = new Map();
    this.tamperCount = 0;
    this.callbacks = [];
  }

  /**
   * 注册受保护的数值
   * @param {string} key - 数据标识
   * @param {object} value - 数值对象
   * @param {number} criticality - 关键性级别 (1-5)
   */
  registerProtectedValue(key, value, criticality = 3) {
    const serialized = this._serialize(value);
    const checksum = this._computeChecksum(serialized);
    
    this.protectedValues.set(key, {
      value,
      criticality,
      lastChecksum: checksum,
      timestamp: Date.now(),
      accessCount: 0
    });
    
    this.checksums.set(key, checksum);
    this.lastValidHash.set(key, this._computeHash(serialized));
  }

  /**
   * 验证数据完整性
   */
  verifyIntegrity(key) {
    const protectedData = this.protectedValues.get(key);
    if (!protectedData) return { valid: true, reason: 'not_protected' };

    const currentSerialized = this._serialize(protectedData.value);
    const currentChecksum = this._computeChecksum(currentSerialized);
    const currentHash = this._computeHash(currentSerialized);

    const checksumValid = currentChecksum === protectedData.lastChecksum;
    const hashValid = currentHash === this.lastValidHash.get(key);

    if (!checksumValid || !hashValid) {
      this.tamperCount++;
      this._reportTamper(key, {
        expectedChecksum: protectedData.lastChecksum,
        actualChecksum: currentChecksum,
        expectedHash: this.lastValidHash.get(key),
        actualHash: currentHash,
        criticality: protectedData.criticality
      });

      return {
        valid: false,
        reason: 'integrity_violation',
        criticality: protectedData.criticality,
        tamperCount: this.tamperCount
      };
    }

    protectedData.accessCount++;
    return { valid: true };
  }

  /**
   * 批量验证所有受保护数据
   */
  verifyAll() {
    const results = [];
    let violations = 0;

    for (const [key] of this.protectedValues) {
      const result = this.verifyIntegrity(key);
      results.push({ key, ...result });
      if (!result.valid) violations++;
    }

    return {
      totalChecked: this.protectedValues.size,
      violations,
      overallIntegrity: violations === 0,
      results
    };
  }

  /**
   * 计算校验和
   */
  _computeChecksum(data) {
    let hash = 0;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    return hash.toString(16);
  }

  /**
   * 计算 SHA-256 哈希（使用 Web Crypto API）
   */
  async _computeHash(data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(str);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 序列化数据
   */
  _serialize(value) {
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, Object.keys(value).sort());
    }
    return String(value);
  }

  /**
   * 上报篡改事件
   */
  _reportTamper(key, details) {
    const event = {
      type: 'memory_tamper_detected',
      key,
      timestamp: Date.now(),
      details,
      userAgent: navigator.userAgent,
      platform: navigator.platform
    };

    // 触发回调
    this.callbacks.forEach(cb => cb(event));

    // 发送到服务器
    this._sendToServer(event);
  }

  /**
   * 注册篡改回调
   */
  onTamperDetected(callback) {
    this.callbacks.push(callback);
  }

  /**
   * 发送事件到服务器
   */
  async _sendToServer(event) {
    try {
      await fetch('/api/security/tamper-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });
    } catch (error) {
      console.error('Failed to report tamper event:', error);
    }
  }
}

export const memoryGuard = new MemoryIntegrityGuard();
```

### 2. 内存扫描工具检测模块

```javascript
// frontend/game-client/src/security/ScannerDetector.js

class ScannerDetector {
  constructor() {
    this.detectionMethods = [
      this._detectTimingAnomalies.bind(this),
      this._detectMemoryPressure.bind(this),
      this._detectDebuggerPresence.bind(this),
      this._detectDevTools.bind(this)
    ];
    this.scanResults = [];
    this.scanInterval = null;
  }

  /**
   * 启动扫描检测
   */
  startDetection(intervalMs = 5000) {
    this.scanInterval = setInterval(() => {
      this.performScan();
    }, intervalMs);
  }

  /**
   * 执行扫描检测
   */
  async performScan() {
    const results = [];
    
    for (const method of this.detectionMethods) {
      try {
        const result = await method();
        results.push(result);
      } catch (error) {
        results.push({
          method: method.name,
          detected: false,
          error: error.message
        });
      }
    }

    const scanResult = {
      timestamp: Date.now(),
      results,
      threatLevel: this._calculateThreatLevel(results)
    };

    this.scanResults.push(scanResult);
    
    // 保持最近 50 次扫描结果
    if (this.scanResults.length > 50) {
      this.scanResults.shift();
    }

    return scanResult;
  }

  /**
   * 检测时间异常
   */
  async _detectTimingAnomalies() {
    const measurements = [];
    
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      
      // 执行一些简单操作
      let sum = 0;
      for (let j = 0; j < 1000; j++) {
        sum += j;
      }
      
      const elapsed = performance.now() - start;
      measurements.push(elapsed);
    }

    const avgTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
    const variance = measurements.reduce((sum, t) => sum + Math.pow(t - avgTime, 2), 0) / measurements.length;

    // 时间差异常可能表示调试器或内存扫描工具
    const detected = variance > 1 || avgTime > 5;

    return {
      method: 'timing_anomaly',
      detected,
      metrics: { avgTime, variance }
    };
  }

  /**
   * 检测内存压力
   */
  async _detectMemoryPressure() {
    const memoryBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;
    
    // 分配一些内存并立即释放
    const testArray = new Array(100000).fill(0).map((_, i) => ({ index: i, data: Math.random() }));
    const memoryDuring = performance.memory ? performance.memory.usedJSHeapSize : 0;
    
    // 强制 GC（如果可用）
    if (window.gc) window.gc();
    
    const memoryAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;

    // 内存扫描工具可能导致异常的内存使用模式
    const detected = !performance.memory || 
                     (memoryDuring - memoryBefore) > 10000000; // 异常大的内存增长

    return {
      method: 'memory_pressure',
      detected,
      metrics: {
        memoryBefore,
        memoryDuring,
        memoryAfter
      }
    };
  }

  /**
   * 检测调试器存在
   */
  async _detectDebuggerPresence() {
    const start = performance.now();
    
    // 调试器断点会导致显著延迟
    debugger;
    
    const elapsed = performance.now() - start;
    const detected = elapsed > 100; // 超过 100ms 表示可能被调试

    return {
      method: 'debugger_presence',
      detected,
      metrics: { elapsed }
    };
  }

  /**
   * 检测开发者工具
   */
  async _detectDevTools() {
    const threshold = 160;
    
    // 检测窗口尺寸变化
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;
    
    // 检测 console 对象被修改
    const consoleModified = !console.hasOwnProperty('log') ||
                           console.log.toString().includes('native code') === false;

    const detected = widthThreshold || heightThreshold || consoleModified;

    return {
      method: 'devtools_detection',
      detected,
      metrics: {
        widthThreshold,
        heightThreshold,
        consoleModified
      }
    };
  }

  /**
   * 计算威胁级别
   */
  _calculateThreatLevel(results) {
    const detections = results.filter(r => r.detected).length;
    
    if (detections >= 3) return 'critical';
    if (detections >= 2) return 'high';
    if (detections >= 1) return 'medium';
    return 'low';
  }

  /**
   * 获取威胁趋势
   */
  getThreatTrend() {
    const recent = this.scanResults.slice(-10);
    const threats = recent.map(r => r.threatLevel);
    
    const threatScores = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4
    };

    const avgScore = threats.reduce((sum, t) => sum + threatScores[t], 0) / threats.length;
    
    return {
      averageScore: avgScore,
      trend: threats.length > 1 && threatScores[threats[threats.length - 1]] > threatScores[threats[0]] 
             ? 'increasing' 
             : 'stable'
    };
  }

  /**
   * 停止检测
   */
  stopDetection() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
  }
}

export const scannerDetector = new ScannerDetector();
```

### 3. 服务器端验证模块

```javascript
// backend/shared/security/ServerIntegrityVerifier.js

class ServerIntegrityVerifier {
  constructor() {
    this.clientReports = new Map(); // userId -> reports
    this.suspicionScores = new Map(); // userId -> score
  }

  /**
   * 验证战斗结果
   */
  async verifyBattleResult(userId, battleData) {
    const suspiciousIndicators = [];
    const pokemon = battleData.pokemon;
    const opponent = battleData.opponent;

    // 1. 验证精灵属性是否在合理范围内
    if (pokemon.hp > pokemon.maxHp) {
      suspiciousIndicators.push({
        type: 'invalid_hp',
        value: pokemon.hp,
        expected: pokemon.maxHp
      });
    }

    // 2. 验证伤害计算
    const calculatedDamage = this._calculateExpectedDamage(pokemon, opponent, battleData.move);
    if (Math.abs(battleData.damageDealt - calculatedDamage) > calculatedDamage * 0.5) {
      suspiciousIndicators.push({
        type: 'damage_anomaly',
        reported: battleData.damageDealt,
        expected: calculatedDamage,
        deviation: Math.abs(battleData.damageDealt - calculatedDamage) / calculatedDamage
      });
    }

    // 3. 验证战斗时长
    const battleDuration = battleData.endTime - battleData.startTime;
    if (battleDuration < 1000) { // 少于 1 秒的战斗
      suspiciousIndicators.push({
        type: 'suspicious_battle_duration',
        duration: battleDuration
      });
    }

    // 4. 检查历史模式
    const userHistory = await this._getUserBattleHistory(userId);
    const anomalyScore = this._calculateAnomalyScore(battleData, userHistory);

    return {
      valid: suspiciousIndicators.length === 0 && anomalyScore < 0.7,
      suspiciousIndicators,
      anomalyScore,
      action: this._determineAction(suspiciousIndicators, anomalyScore)
    };
  }

  /**
   * 验证捕捉结果
   */
  async verifyCatchResult(userId, catchData) {
    const suspiciousIndicators = [];

    // 1. 验证捕捉概率
    const catchRate = this._calculateCatchRate(
      catchData.pokemon,
      catchData.ballType,
      catchData.bonusModifiers
    );

    if (catchData.caught && catchRate < 0.01) {
      suspiciousIndicators.push({
        type: 'improbable_catch',
        catchRate,
        caught: catchData.caught
      });
    }

    // 2. 验证连续捕捉
    const recentCatches = await this._getRecentCatches(userId, 10);
    const catchStreak = this._calculateCatchStreak(recentCatches);
    
    if (catchStreak > 15) {
      suspiciousIndicators.push({
        type: 'suspicious_catch_streak',
        streak: catchStreak
      });
    }

    // 3. 验证稀有精灵出现频率
    const rarePokemonCount = recentCatches.filter(c => c.rarity === 'legendary').length;
    if (rarePokemonCount > 3) {
      suspiciousIndicators.push({
        type: 'rare_pokemon_frequency',
        count: rarePokemonCount
      });
    }

    return {
      valid: suspiciousIndicators.length === 0,
      suspiciousIndicators,
      catchRate,
      action: this._determineAction(suspiciousIndicators, 0)
    };
  }

  /**
   * 处理篡改报告
   */
  async handleTamperReport(userId, report) {
    if (!this.clientReports.has(userId)) {
      this.clientReports.set(userId, []);
    }

    const reports = this.clientReports.get(userId);
    reports.push({
      ...report,
      processedAt: Date.now()
    });

    // 保持最近 100 条报告
    if (reports.length > 100) {
      reports.shift();
    }

    // 更新怀疑分数
    const currentScore = this.suspicionScores.get(userId) || 0;
    const increment = this._calculateSuspicionIncrement(report);
    this.suspicionScores.set(userId, Math.min(currentScore + increment, 100));

    return {
      suspicionScore: this.suspicionScores.get(userId),
      action: this._getActionForScore(this.suspicionScores.get(userId))
    };
  }

  /**
   * 计算预期伤害
   */
  _calculateExpectedDamage(attacker, defender, move) {
    // 基础伤害公式
    const basePower = move.power || 40;
    const attack = attacker.stats.attack;
    const defense = defender.stats.defense;
    const level = attacker.level;

    const baseDamage = ((2 * level / 5 + 2) * basePower * attack / defense / 50 + 2);
    
    // 随机因子 (0.85 - 1.0)
    const randomFactor = 0.925;
    
    return Math.floor(baseDamage * randomFactor);
  }

  /**
   * 计算捕捉概率
   */
  _calculateCatchRate(pokemon, ballType, modifiers) {
    const baseRates = {
      pokeball: 1,
      greatball: 1.5,
      ultraball: 2,
      masterball: 255
    };

    const baseRate = pokemon.catchRate;
    const ballModifier = baseRates[ballType] || 1;
    const statusModifier = modifiers.statusSleep ? 2 : modifiers.statusParalyze ? 1.5 : 1;
    const hpModifier = 1 - (pokemon.currentHp / pokemon.maxHp) * 0.5;

    return Math.min(1, (baseRate * ballModifier * statusModifier * hpModifier) / 255);
  }

  /**
   * 计算怀疑分数增量
   */
  _calculateSuspicionIncrement(report) {
    const criticalityWeight = {
      5: 30, // 最高关键性
      4: 20,
      3: 10,
      2: 5,
      1: 2
    };

    return criticalityWeight[report.details?.criticality || 3] || 10;
  }

  /**
   * 根据分数确定动作
   */
  _getActionForScore(score) {
    if (score >= 80) return 'ban';
    if (score >= 60) return 'shadowban';
    if (score >= 40) return 'flag';
    if (score >= 20) return 'monitor';
    return 'none';
  }

  /**
   * 确定处理动作
   */
  _determineAction(indicators, anomalyScore) {
    if (indicators.length >= 3 || anomalyScore > 0.8) {
      return 'reject_and_flag';
    }
    if (indicators.length >= 1 || anomalyScore > 0.5) {
      return 'flag';
    }
    return 'accept';
  }

  /**
   * 获取用户战斗历史
   */
  async _getUserBattleHistory(userId) {
    // 实际实现应从数据库查询
    return [];
  }

  /**
   * 计算异常分数
   */
  _calculateAnomalyScore(currentBattle, history) {
    // 基于历史数据计算当前战斗的异常程度
    return 0;
  }

  /**
   * 获取最近捕捉记录
   */
  async _getRecentCatches(userId, limit) {
    // 实际实现应从数据库查询
    return [];
  }

  /**
   * 计算连续捕捉
   */
  _calculateCatchStreak(catches) {
    let streak = 0;
    for (const c of catches) {
      if (c.caught) streak++;
      else break;
    }
    return streak;
  }
}

export const serverVerifier = new ServerIntegrityVerifier();
```

### 4. 防篡改 API 中间件

```javascript
// backend/shared/middleware/integrityMiddleware.js

import { serverVerifier } from '../security/ServerIntegrityVerifier.js';

export function createIntegrityMiddleware() {
  return async (req, res, next) => {
    const userId = req.user?.id;
    const path = req.path;

    // 请求完整性头
    const integrityHeader = req.headers['x-game-integrity'];
    const clientTimestamp = req.headers['x-client-timestamp'];
    const nonce = req.headers['x-request-nonce'];

    // 1. 验证时间戳（防重放攻击）
    if (clientTimestamp) {
      const now = Date.now();
      const timestamp = parseInt(clientTimestamp);
      
      if (Math.abs(now - timestamp) > 30000) { // 30秒容忍
        return res.status(400).json({
          error: 'REQUEST_EXPIRED',
          message: 'Request timestamp too old or in future'
        });
      }
    }

    // 2. 验证 Nonce（防重放攻击）
    if (nonce) {
      const isUsed = await checkNonceUsed(nonce, userId);
      if (isUsed) {
        await flagSuspiciousActivity(userId, 'nonce_reuse', { nonce });
        return res.status(400).json({
          error: 'NONCE_REUSE',
          message: 'Request nonce already used'
        });
      }
      await markNonceUsed(nonce, userId);
    }

    // 3. 对关键操作进行服务器端验证
    if (path.includes('/battle/') && req.method === 'POST') {
      const verification = await serverVerifier.verifyBattleResult(userId, req.body);
      
      if (verification.action === 'reject_and_flag') {
        await flagSuspiciousActivity(userId, 'battle_integrity_violation', verification);
        return res.status(400).json({
          error: 'INTEGRITY_VIOLATION',
          message: 'Battle result integrity check failed'
        });
      }
      
      req.verification = verification;
    }

    if (path.includes('/catch/') && req.method === 'POST') {
      const verification = await serverVerifier.verifyCatchResult(userId, req.body);
      
      if (verification.action === 'reject_and_flag') {
        await flagSuspiciousActivity(userId, 'catch_integrity_violation', verification);
        return res.status(400).json({
          error: 'INTEGRITY_VIOLATION',
          message: 'Catch result integrity check failed'
        });
      }
      
      req.verification = verification;
    }

    next();
  };
}

// Redis 辅助函数
async function checkNonceUsed(nonce, userId) {
  // 实际实现使用 Redis
  return false;
}

async function markNonceUsed(nonce, userId) {
  // 实际实现使用 Redis
}

async function flagSuspiciousActivity(userId, type, details) {
  // 记录到数据库并可能触发告警
  console.log(`[SECURITY] Flagging user ${userId}: ${type}`, details);
}
```

### 5. 数据库迁移

```sql
-- database/migrations/20260614_create_integrity_tables.sql

-- 篡改报告表
CREATE TABLE tamper_reports (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  report_type VARCHAR(50) NOT NULL,
  key VARCHAR(100),
  details JSONB,
  client_timestamp BIGINT,
  server_timestamp TIMESTAMPTZ DEFAULT NOW(),
  user_agent TEXT,
  platform VARCHAR(50),
  suspicion_score INTEGER,
  action_taken VARCHAR(20)
);

CREATE INDEX idx_tamper_reports_user_id ON tamper_reports(user_id);
CREATE INDEX idx_tamper_reports_timestamp ON tamper_reports(server_timestamp);
CREATE INDEX idx_tamper_reports_type ON tamper_reports(report_type);

-- 请求 Nonce 表（防重放攻击）
CREATE TABLE request_nonces (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  nonce VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_request_nonces_user_nonce ON request_nonces(user_id, nonce);
CREATE INDEX idx_request_nonces_expires ON request_nonces(expires_at);

-- 用户怀疑分数表
CREATE TABLE user_suspicion_scores (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL UNIQUE REFERENCES users(id),
  score INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  flags JSONB DEFAULT '{}',
  action VARCHAR(20) DEFAULT 'none'
);

CREATE INDEX idx_suspicion_scores_user ON user_suspicion_scores(user_id);
CREATE INDEX idx_suspicion_scores_action ON user_suspicion_scores(action);

-- 审计日志表
CREATE TABLE integrity_audit_log (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(36),
  event_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON integrity_audit_log(user_id);
CREATE INDEX idx_audit_log_event ON integrity_audit_log(event_type);
CREATE INDEX idx_audit_log_created ON integrity_audit_log(created_at);
```

## 验收标准

- [ ] 内存完整性校验模块能够检测并报告精灵属性篡改
- [ ] 扫描工具检测能够识别常见内存修改工具的运行
- [ ] 服务器端验证能够检测异常的战斗结果和捕捉概率
- [ ] 防重放攻击机制能够阻止请求重放攻击
- [ ] 怀疑分数机制能够准确评估用户风险等级
- [ ] 篡改报告和审计日志能够持久化存储
- [ ] 检测不影响游戏正常性能（延迟增加 < 50ms）
- [ ] 误报率 < 1%

## 影响范围

- frontend/game-client/src/security/ - 新增安全模块
- frontend/game-client/src/game/ - 集成完整性校验
- backend/shared/security/ - 服务器端验证逻辑
- backend/shared/middleware/integrityMiddleware.js - API 保护中间件
- database/migrations/ - 数据库迁移脚本
- gateway - 添加完整性验证中间件
- catch-service, gym-service - 集成服务器端验证

## 参考

- [OWASP Mobile Security Testing Guide](https://owasp.org/www-project-mobile-security-testing-guide/)
- [Cheat Engine Detection Techniques](https://www.unknowncheats.me/)
- [Web Crypto API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [Anti-Cheat Systems Architecture](https://www.gamedeveloper.com/programming/anti-cheat-systems)
