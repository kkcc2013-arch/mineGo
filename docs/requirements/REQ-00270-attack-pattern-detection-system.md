# REQ-00270: 攻击模式检测与实时威胁识别系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00270 |
| 标题 | 攻击模式检测与实时威胁识别系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、catch-service、gym-service、social-service、backend/shared、Redis、PostgreSQL、admin-dashboard |
| 创建时间 | 2026-06-18 22:30 |

## 需求描述

当前系统已有基础的 GPS 伪造检测、设备完整性检测和会话异常检测，但缺乏对整体攻击模式的实时分析和威胁识别能力。攻击者可能采用多阶段、分布式的攻击策略，如：

1. **慢速攻击（Slowloris）**：长期低频探测系统弱点
2. **分布式攻击**：多 IP 协同攻击绕过单 IP 限流
3. **凭证填充**：批量尝试泄露的用户名密码组合
4. **API 滥用链**：组合多个合法 API 实现非法目的
5. **时间窗口攻击**：在系统维护、升级时段发起攻击
6. **横向移动**：获取一个账户后尝试提权或访问其他账户

本系统需要实现：

- **实时攻击模式识别**：基于行为序列识别攻击模式
- **威胁情报集成**：对接外部威胁情报源（IP 信誉、恶意域名等）
- **风险评分引擎**：动态计算用户/请求的风险分数
- **自动响应机制**：根据威胁等级自动触发防护措施
- **攻击溯源分析**：提供攻击链路可视化和溯源能力
- **蜜罐诱捕系统**：主动诱导攻击者暴露行为

## 技术方案

### 1. 攻击模式识别引擎

**位置**: `backend/shared/AttackPatternDetector.js`

```javascript
const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { logger } = require('./logger');
const { metrics } = require('./metrics');

/**
 * 攻击模式定义
 */
const ATTACK_PATTERNS = {
  // 凭证填充攻击
  CREDENTIAL_STUFFING: {
    id: 'credential_stuffing',
    name: '凭证填充攻击',
    description: '批量尝试泄露的用户名密码组合',
    indicators: [
      { type: 'failed_login', threshold: 5, window: 300, weight: 0.3 },
      { type: 'different_ip_login', threshold: 3, window: 3600, weight: 0.2 },
      { type: 'different_device_login', threshold: 3, window: 3600, weight: 0.2 },
      { type: 'breached_password_usage', threshold: 1, window: 86400, weight: 0.4 }
    ],
    severity: 'high',
    autoActions: ['force_mfa', 'account_lockout', 'ip_blacklist']
  },
  
  // 分布式攻击
  DISTRIBUTED_ATTACK: {
    id: 'distributed_attack',
    name: '分布式攻击',
    description: '多 IP 协同攻击绕过限流',
    indicators: [
      { type: 'coordinated_requests', threshold: 10, window: 60, weight: 0.4 },
      { type: 'similar_behavior_pattern', threshold: 5, window: 300, weight: 0.3 },
      { type: 'geographic_impossibility', threshold: 1, window: 600, weight: 0.5 }
    ],
    severity: 'critical',
    autoActions: ['rate_limit_increase', 'captcha_required', 'account_review']
  },
  
  // API 滥用链攻击
  API_ABUSE_CHAIN: {
    id: 'api_abuse_chain',
    description: '组合多个合法 API 实现非法目的',
    indicators: [
      { type: 'suspicious_api_sequence', threshold: 1, window: 1800, weight: 0.5 },
      { type: 'abnormal_resource_access', threshold: 3, window: 600, weight: 0.3 },
      { type: 'data_harvesting_pattern', threshold: 1, window: 3600, weight: 0.4 }
    ],
    severity: 'high',
    autoActions: ['api_throttle', 'session_terminate', 'manual_review']
  },
  
  // 慢速攻击
  SLOWLORIS: {
    id: 'slowloris',
    name: '慢速攻击',
    description: '长期低频探测系统弱点',
    indicators: [
      { type: 'persistent_scanning', threshold: 20, window: 86400, weight: 0.3 },
      { type: 'endpoint_enumeration', threshold: 50, window: 86400, weight: 0.4 },
      { type: 'delayed_response_exploit', threshold: 5, window: 3600, weight: 0.3 }
    ],
    severity: 'medium',
    autoActions: ['progressive_delay', 'connection_throttle', 'ip_monitoring']
  },
  
  // 时间窗口攻击
  TIME_WINDOW_ATTACK: {
    id: 'time_window_attack',
    name: '时间窗口攻击',
    description: '在系统维护/升级时段发起攻击',
    indicators: [
      { type: 'maintenance_period_activity', threshold: 10, window: 1800, weight: 0.5 },
      { type: 'deployment_window_exploit', threshold: 1, window: 3600, weight: 0.6 },
      { type: 'backup_timing_attack', threshold: 1, window: 3600, weight: 0.5 }
    ],
    severity: 'critical',
    autoActions: ['enhanced_monitoring', 'rate_limit_strict', 'alert_security_team']
  },
  
  // 横向移动攻击
  LATERAL_MOVEMENT: {
    id: 'lateral_movement',
    name: '横向移动攻击',
    description: '获取账户后尝试提权或访问其他账户',
    indicators: [
      { type: 'privilege_escalation_attempt', threshold: 1, window: 600, weight: 0.7 },
      { type: 'multiple_account_access', threshold: 3, window: 3600, weight: 0.5 },
      { type: 'suspicious_data_access', threshold: 5, window: 1800, weight: 0.4 }
    ],
    severity: 'critical',
    autoActions: ['account_freeze', 'force_logout', 'security_audit']
  }
};

/**
 * 攻击模式检测器
 */
class AttackPatternDetector extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.config = {
      detectionWindow: config.detectionWindow || 3600, // 1小时
      riskThreshold: config.riskThreshold || 0.7, // 70% 风险阈值
      cooldownPeriod: config.cooldownPeriod || 300, // 5分钟冷却期
      maxAlertsPerHour: config.maxAlertsPerHour || 100,
      ...config
    };
    
    this.patterns = ATTACK_PATTERNS;
    this.activeAttacks = new Map(); // 活跃攻击追踪
    this.threatScores = new Map(); // 威胁评分缓存
    
    // 启动定期清理
    this._startCleanupTask();
  }
  
  /**
   * 分析请求并检测攻击模式
   */
  async analyzeRequest(userId, request) {
    const startTime = Date.now();
    
    try {
      // 1. 收集用户行为上下文
      const context = await this._collectUserContext(userId, request);
      
      // 2. 更新行为指标
      await this._updateBehaviorIndicators(userId, request, context);
      
      // 3. 检测攻击模式
      const detectedPatterns = await this._detectPatterns(userId, context);
      
      // 4. 计算风险评分
      const riskScore = this._calculateRiskScore(detectedPatterns, context);
      
      // 5. 触发自动响应
      if (riskScore >= this.config.riskThreshold) {
        await this._triggerAutoResponse(userId, detectedPatterns, riskScore);
      }
      
      // 6. 记录分析结果
      await this._recordAnalysisResult(userId, {
        patterns: detectedPatterns,
        riskScore,
        context: context.summary,
        timestamp: Date.now()
      });
      
      // 监控指标
      metrics.histogram('attack_detection_duration_ms', Date.now() - startTime);
      metrics.increment('attack_detection_requests_total');
      
      if (riskScore >= 0.7) {
        metrics.increment('high_risk_requests_total');
      }
      
      return {
        riskScore,
        detectedPatterns: detectedPatterns.map(p => ({
          id: p.id,
          name: p.name,
          severity: p.severity,
          confidence: p.confidence
        })),
        actions: riskScore >= this.config.riskThreshold ? ['auto_response_triggered'] : []
      };
      
    } catch (error) {
      logger.error('攻击检测失败', {
        userId,
        error: error.message,
        stack: error.stack
      });
      
      // 失败时保守处理，允许请求继续但记录异常
      return {
        riskScore: 0.5,
        detectedPatterns: [],
        actions: [],
        error: true
      };
    }
  }
  
  /**
   * 收集用户行为上下文
   */
  async _collectUserContext(userId, request) {
    const [
      recentLogins,
      recentActions,
      deviceHistory,
      ipHistory,
      breachStatus
    ] = await Promise.all([
      this.redis.lrange(`user:${userId}:logins`, 0, 50),
      this.redis.lrange(`user:${userId}:actions`, 0, 100),
      this.redis.hgetall(`user:${userId}:devices`),
      this.redis.hgetall(`user:${userId}:ips`),
      this.redis.get(`user:${userId}:breach_status`)
    ]);
    
    return {
      userId,
      currentIp: request.ip,
      currentDevice: request.deviceId,
      userAgent: request.userAgent,
      endpoint: request.path,
      method: request.method,
      timestamp: Date.now(),
      recentLogins: recentLogins.map(l => JSON.parse(l)),
      recentActions: recentActions.map(a => JSON.parse(a)),
      deviceHistory,
      ipHistory,
      breachStatus: breachStatus ? JSON.parse(breachStatus) : null,
      summary: {
        loginCount24h: recentLogins.length,
        uniqueIps: Object.keys(ipHistory).length,
        uniqueDevices: Object.keys(deviceHistory).length
      }
    };
  }
  
  /**
   * 更新行为指标
   */
  async _updateBehaviorIndicators(userId, request, context) {
    const now = Date.now();
    const windowKey = Math.floor(now / 60000); // 每分钟窗口
    
    // 1. 记录失败登录
    if (request.eventType === 'login_failed') {
      await this.redis.lpush(`user:${userId}:logins`, JSON.stringify({
        ip: request.ip,
        deviceId: request.deviceId,
        timestamp: now,
        success: false
      }));
      await this.redis.ltrim(`user:${userId}:logins`, 0, 99);
      
      await this.redis.incr(`indicator:${userId}:failed_login:${windowKey}`);
      await this.redis.expire(`indicator:${userId}:failed_login:${windowKey}`, 3600);
    }
    
    // 2. 记录不同 IP 登录
    if (request.eventType === 'login_success') {
      const newIp = !context.ipHistory[request.ip];
      if (newIp) {
        await this.redis.hset(`user:${userId}:ips`, request.ip, now);
        await this.redis.incr(`indicator:${userId}:different_ip_login:${windowKey}`);
        await this.redis.expire(`indicator:${userId}:different_ip_login:${windowKey}`, 86400);
      }
    }
    
    // 3. 记录 API 序列
    const sequenceKey = `user:${userId}:api_sequence`;
    await this.redis.lpush(sequenceKey, JSON.stringify({
      endpoint: request.path,
      method: request.method,
      timestamp: now
    }));
    await this.redis.ltrim(sequenceKey, 0, 199);
    
    // 4. 检测可疑 API 序列
    const suspiciousSequence = await this._detectSuspiciousSequence(userId);
    if (suspiciousSequence) {
      await this.redis.incr(`indicator:${userId}:suspicious_api_sequence:${windowKey}`);
      await this.redis.expire(`indicator:${userId}:suspicious_api_sequence:${windowKey}`, 3600);
    }
    
    // 5. 记录行为指纹
    const behaviorFingerprint = this._generateBehaviorFingerprint(request);
    await this.redis.lpush(`user:${userId}:behavior_fingerprints`, behaviorFingerprint);
    await this.redis.ltrim(`user:${userId}:behavior_fingerprints`, 0, 99);
  }
  
  /**
   * 检测攻击模式
   */
  async _detectPatterns(userId, context) {
    const detectedPatterns = [];
    
    for (const [patternId, pattern] of Object.entries(this.patterns)) {
      let confidence = 0;
      let indicatorCount = 0;
      
      for (const indicator of pattern.indicators) {
        const indicatorValue = await this._getIndicatorValue(
          userId,
          indicator.type,
          indicator.window
        );
        
        if (indicatorValue >= indicator.threshold) {
          confidence += indicator.weight;
          indicatorCount++;
        }
      }
      
      // 至少触发 2 个指标才认为模式匹配
      if (indicatorCount >= 2) {
        confidence = Math.min(confidence, 1.0);
        
        detectedPatterns.push({
          ...pattern,
          confidence,
          matchedIndicators: indicatorCount,
          timestamp: Date.now()
        });
      }
    }
    
    return detectedPatterns.sort((a, b) => b.confidence - a.confidence);
  }
  
  /**
   * 获取指标值
   */
  async _getIndicatorValue(userId, indicatorType, windowSeconds) {
    const now = Date.now();
    const windowStart = Math.floor((now - windowSeconds * 1000) / 60000);
    const windowEnd = Math.floor(now / 60000);
    
    let total = 0;
    for (let w = windowStart; w <= windowEnd; w++) {
      const value = await this.redis.get(`indicator:${userId}:${indicatorType}:${w}`);
      total += parseInt(value || 0);
    }
    
    return total;
  }
  
  /**
   * 计算风险评分
   */
  _calculateRiskScore(detectedPatterns, context) {
    if (detectedPatterns.length === 0) {
      return this._calculateBaseRisk(context);
    }
    
    let riskScore = 0;
    const severityWeights = {
      critical: 1.0,
      high: 0.8,
      medium: 0.5,
      low: 0.3
    };
    
    for (const pattern of detectedPatterns) {
      const severityWeight = severityWeights[pattern.severity] || 0.5;
      riskScore += pattern.confidence * severityWeight;
    }
    
    // 归一化到 0-1 范围
    riskScore = Math.min(riskScore / detectedPatterns.length, 1.0);
    
    // 叠加基础风险
    riskScore += this._calculateBaseRisk(context) * 0.3;
    
    return Math.min(riskScore, 1.0);
  }
  
  /**
   * 计算基础风险
   */
  _calculateBaseRisk(context) {
    let baseRisk = 0;
    
    // 多 IP 登录
    if (context.summary.uniqueIps > 5) baseRisk += 0.2;
    if (context.summary.uniqueIps > 10) baseRisk += 0.3;
    
    // 多设备登录
    if (context.summary.uniqueDevices > 3) baseRisk += 0.15;
    
    // 泄露密码使用
    if (context.breachStatus?.breachedPassword) baseRisk += 0.3;
    
    // 24小时登录次数异常
    if (context.summary.loginCount24h > 20) baseRisk += 0.2;
    
    return Math.min(baseRisk, 0.5);
  }
  
  /**
   * 触发自动响应
   */
  async _triggerAutoResponse(userId, detectedPatterns, riskScore) {
    const actions = new Set();
    
    // 收集所有模式的自动动作
    for (const pattern of detectedPatterns) {
      for (const action of pattern.autoActions) {
        actions.add(action);
      }
    }
    
    // 按优先级执行动作
    const actionPriority = [
      'account_freeze',
      'account_lockout',
      'force_logout',
      'force_mfa',
      'ip_blacklist',
      'session_terminate',
      'rate_limit_strict',
      'captcha_required',
      'rate_limit_increase',
      'api_throttle',
      'enhanced_monitoring',
      'connection_throttle',
      'progressive_delay',
      'ip_monitoring',
      'manual_review',
      'account_review',
      'alert_security_team'
    ];
    
    for (const action of actionPriority) {
      if (actions.has(action)) {
        await this._executeAction(userId, action, {
          patterns: detectedPatterns,
          riskScore,
          timestamp: Date.now()
        });
      }
    }
    
    // 发出攻击告警
    this.emit('attack_detected', {
      userId,
      patterns: detectedPatterns,
      riskScore,
      actions: Array.from(actions),
      timestamp: Date.now()
    });
    
    // 记录到攻击日志
    await this.redis.lpush('security:attack_log', JSON.stringify({
      userId,
      patterns: detectedPatterns.map(p => p.id),
      riskScore,
      actions: Array.from(actions),
      timestamp: Date.now()
    }));
    await this.redis.ltrim('security:attack_log', 0, 999);
  }
  
  /**
   * 执行响应动作
   */
  async _executeAction(userId, action, context) {
    logger.warn('执行安全响应动作', {
      userId,
      action,
      riskScore: context.riskScore
    });
    
    switch (action) {
      case 'account_freeze':
        await this.redis.set(`user:${userId}:frozen`, Date.now());
        await this.redis.expire(`user:${userId}:frozen`, 86400);
        metrics.increment('security_actions_account_freeze_total');
        break;
        
      case 'account_lockout':
        await this.redis.set(`user:${userId}:lockout`, Date.now());
        await this.redis.expire(`user:${userId}:lockout`, 3600);
        metrics.increment('security_actions_account_lockout_total');
        break;
        
      case 'force_logout':
        await this.redis.del(`user:${userId}:sessions`);
        metrics.increment('security_actions_force_logout_total');
        break;
        
      case 'force_mfa':
        await this.redis.set(`user:${userId}:mfa_required`, Date.now());
        await this.redis.expire(`user:${userId}:mfa_required`, 86400);
        metrics.increment('security_actions_force_mfa_total');
        break;
        
      case 'ip_blacklist':
        // 由 IP 黑名单服务处理
        await this.redis.lpush('security:ip_blacklist_queue', JSON.stringify({
          ip: context.patterns[0]?.ip,
          reason: 'attack_pattern_detected',
          riskScore: context.riskScore
        }));
        metrics.increment('security_actions_ip_blacklist_total');
        break;
        
      case 'captcha_required':
        await this.redis.set(`user:${userId}:captcha_required`, Date.now());
        await this.redis.expire(`user:${userId}:captcha_required`, 3600);
        metrics.increment('security_actions_captcha_required_total');
        break;
        
      case 'rate_limit_strict':
        await this.redis.set(`user:${userId}:rate_limit_multiplier`, 0.2);
        await this.redis.expire(`user:${userId}:rate_limit_multiplier`, 86400);
        metrics.increment('security_actions_rate_limit_strict_total');
        break;
        
      default:
        logger.debug('未知安全动作', { action });
    }
  }
  
  /**
   * 检测可疑 API 序列
   */
  async _detectSuspiciousSequence(userId) {
    const sequence = await this.redis.lrange(`user:${userId}:api_sequence`, 0, 19);
    const actions = sequence.map(s => JSON.parse(s));
    
    // 定义可疑序列模式
    const suspiciousPatterns = [
      // 数据收割模式
      ['/api/pokemon/list', '/api/pokemon/export', '/api/user/data'],
      // 提权尝试
      ['/api/user/profile', '/api/admin/panel', '/api/system/config'],
      // 批量操作
      ['/api/pokemon/catch', '/api/pokemon/catch', '/api/pokemon/catch', '/api/pokemon/catch']
    ];
    
    for (const pattern of suspiciousPatterns) {
      let matchCount = 0;
      for (let i = 0; i <= actions.length - pattern.length; i++) {
        let patternMatch = true;
        for (let j = 0; j < pattern.length; j++) {
          if (!actions[i + j]?.endpoint?.includes(pattern[j])) {
            patternMatch = false;
            break;
          }
        }
        if (patternMatch) matchCount++;
      }
      if (matchCount > 0) return true;
    }
    
    return false;
  }
  
  /**
   * 生成行为指纹
   */
  _generateBehaviorFingerprint(request) {
    const features = [
      request.method,
      request.path?.split('?')[0],
      request.userAgent?.substring(0, 20),
      Math.floor(Date.now() / 60000) // 分钟窗口
    ];
    
    return features.join('|');
  }
  
  /**
   * 记录分析结果
   */
  async _recordAnalysisResult(userId, result) {
    await this.redis.lpush(
      `user:${userId}:security_analysis`,
      JSON.stringify(result)
    );
    await this.redis.ltrim(`user:${userId}:security_analysis`, 0, 99);
  }
  
  /**
   * 定期清理任务
   */
  _startCleanupTask() {
    setInterval(async () => {
      try {
        // 清理过期的活跃攻击记录
        const now = Date.now();
        for (const [attackId, attack] of this.activeAttacks.entries()) {
          if (now - attack.timestamp > 86400000) { // 24小时
            this.activeAttacks.delete(attackId);
          }
        }
        
        // 清理威胁评分缓存
        for (const [userId, score] of this.threatScores.entries()) {
          if (now - score.timestamp > 3600000) { // 1小时
            this.threatScores.delete(userId);
          }
        }
      } catch (error) {
        logger.error('清理任务失败', { error: error.message });
      }
    }, 300000); // 5分钟
  }
  
  /**
   * 获取活跃攻击列表
   */
  getActiveAttacks() {
    return Array.from(this.activeAttacks.values());
  }
  
  /**
   * 获取用户威胁评分
   */
  getUserThreatScore(userId) {
    return this.threatScores.get(userId);
  }
}

module.exports = { AttackPatternDetector, ATTACK_PATTERNS };
```

### 2. 威胁情报集成服务

**位置**: `backend/shared/ThreatIntelligenceService.js`

```javascript
const axios = require('axios');
const Redis = require('ioredis');
const { logger } = require('./logger');

/**
 * 威胁情报源配置
 */
const THREAT_SOURCES = {
  // IP 信誉服务
  ABUSE_IPDB: {
    name: 'AbuseIPDB',
    type: 'ip_reputation',
    url: 'https://api.abuseipdb.com/api/v2/check',
    apiKey: process.env.ABUSEIPDB_API_KEY,
    cacheTTL: 86400, // 24小时
    rateLimit: 1000 // 每天 1000 次
  },
  
  // 病毒总数
  VIRUS_TOTAL: {
    name: 'VirusTotal',
    type: 'malware_domain',
    url: 'https://www.virustotal.com/api/v3',
    apiKey: process.env.VIRUSTOTAL_API_KEY,
    cacheTTL: 86400,
    rateLimit: 500
  },
  
  // IP 位置与代理检测
  IP_QUALITY_SCORE: {
    name: 'IPQualityScore',
    type: 'ip_quality',
    url: 'https://ipqualityscore.com/api/json/ip',
    apiKey: process.env.IPQS_API_KEY,
    cacheTTL: 3600,
    rateLimit: 5000
  },
  
  // 恶意域名列表
  MALWARE_DOMAINS: {
    name: 'MalwareDomains',
    type: 'domain_blacklist',
    url: 'https://mirror1.malwaredomains.com/files/justdomains',
    apiKey: null,
    cacheTTL: 86400,
    rateLimit: 10
  }
};

/**
 * 威胁情报服务
 */
class ThreatIntelligenceService {
  constructor(config = {}) {
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.sources = THREAT_SOURCES;
    this.requestCounts = new Map();
    
    this._startRateLimitReset();
  }
  
  /**
   * 查询 IP 信誉
   */
  async checkIPReputation(ip) {
    // 1. 检查缓存
    const cacheKey = `threat:ip:${ip}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 2. 查询 AbuseIPDB
    const abuseResult = await this._queryAbuseIPDB(ip);
    
    // 3. 查询 IPQualityScore
    const qualityResult = await this._queryIPQualityScore(ip);
    
    // 4. 合并结果
    const result = {
      ip,
      reputation: this._calculateIPReputation(abuseResult, qualityResult),
      details: {
        abuseConfidence: abuseResult?.abuseConfidenceScore || 0,
        isProxy: qualityResult?.proxy || false,
        isVpn: qualityResult?.vpn || false,
        isTor: qualityResult?.tor || false,
        isBot: qualityResult?.bot || false,
        fraudScore: qualityResult?.fraud_score || 0,
        countryCode: qualityResult?.country_code || 'Unknown',
        isp: qualityResult?.ISP || 'Unknown'
      },
      sources: ['AbuseIPDB', 'IPQualityScore'],
      timestamp: Date.now()
    };
    
    // 5. 缓存结果
    await this.redis.setex(
      cacheKey,
      this.sources.ABUSE_IPDB.cacheTTL,
      JSON.stringify(result)
    );
    
    return result;
  }
  
  /**
   * 查询 AbuseIPDB
   */
  async _queryAbuseIPDB(ip) {
    const source = this.sources.ABUSE_IPDB;
    
    // 检查速率限制
    if (!this._checkRateLimit('ABUSE_IPDB')) {
      logger.warn('AbuseIPDB 速率限制已达上限');
      return null;
    }
    
    try {
      const response = await axios.get(source.url, {
        params: {
          ipAddress: ip,
          maxAgeInDays: 90
        },
        headers: {
          'Key': source.apiKey,
          'Accept': 'application/json'
        },
        timeout: 5000
      });
      
      return response.data.data;
    } catch (error) {
      logger.error('AbuseIPDB 查询失败', {
        ip,
        error: error.message
      });
      return null;
    }
  }
  
  /**
   * 查询 IPQualityScore
   */
  async _queryIPQualityScore(ip) {
    const source = this.sources.IP_QUALITY_SCORE;
    
    if (!this._checkRateLimit('IP_QUALITY_SCORE')) {
      logger.warn('IPQualityScore 速率限制已达上限');
      return null;
    }
    
    try {
      const response = await axios.get(`${source.url}/${source.apiKey}/${ip}`, {
        timeout: 5000
      });
      
      return response.data;
    } catch (error) {
      logger.error('IPQualityScore 查询失败', {
        ip,
        error: error.message
      });
      return null;
    }
  }
  
  /**
   * 计算 IP 信誉分数
   */
  _calculateIPReputation(abuseResult, qualityResult) {
    let score = 100; // 初始满分
    
    // AbuseIPDB 扣分
    if (abuseResult) {
      const abuseScore = abuseResult.abuseConfidenceScore || 0;
      score -= abuseScore * 0.5;
    }
    
    // IPQualityScore 扣分
    if (qualityResult) {
      if (qualityResult.proxy) score -= 30;
      if (qualityResult.vpn) score -= 20;
      if (qualityResult.tor) score -= 50;
      if (qualityResult.bot) score -= 40;
      
      score -= (qualityResult.fraud_score || 0) * 0.3;
    }
    
    return Math.max(0, Math.min(100, score));
  }
  
  /**
   * 检查域名是否恶意
   */
  async checkDomainReputation(domain) {
    const cacheKey = `threat:domain:${domain}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 查询 VirusTotal
    const result = await this._queryVirusTotal(domain);
    
    await this.redis.setex(
      cacheKey,
      this.sources.VIRUS_TOTAL.cacheTTL,
      JSON.stringify(result)
    );
    
    return result;
  }
  
  /**
   * 查询 VirusTotal
   */
  async _queryVirusTotal(domain) {
    const source = this.sources.VIRUS_TOTAL;
    
    if (!this._checkRateLimit('VIRUS_TOTAL')) {
      return { safe: null, error: 'rate_limit' };
    }
    
    try {
      const response = await axios.get(`${source.url}/domains/${domain}`, {
        headers: {
          'x-apikey': source.apiKey
        },
        timeout: 10000
      });
      
      const stats = response.data.data.attributes.last_analysis_stats;
      const isMalicious = stats.malicious > 0 || stats.suspicious > 3;
      
      return {
        domain,
        safe: !isMalicious,
        stats,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('VirusTotal 查询失败', {
        domain,
        error: error.message
      });
      
      return { safe: null, error: error.message };
    }
  }
  
  /**
   * 批量检查 IP 列表
   */
  async batchCheckIPs(ips) {
    const results = {};
    
    await Promise.all(
      ips.map(async ip => {
        results[ip] = await this.checkIPReputation(ip);
      })
    );
    
    return results;
  }
  
  /**
   * 检查速率限制
   */
  _checkRateLimit(sourceName) {
    const count = this.requestCounts.get(sourceName) || 0;
    const limit = this.sources[sourceName]?.rateLimit || 1000;
    
    return count < limit;
  }
  
  /**
   * 启动速率限制重置
   */
  _startRateLimitReset() {
    setInterval(() => {
      this.requestCounts.clear();
    }, 86400000); // 每天
  }
}

module.exports = { ThreatIntelligenceService, THREAT_SOURCES };
```

### 3. 蜜罐诱捕系统

**位置**: `backend/shared/HoneypotService.js`

```javascript
const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { logger } = require('./logger');
const { metrics } = require('./metrics');

/**
 * 蜜罐类型定义
 */
const HONEYPOT_TYPES = {
  // 虚假管理面板
  ADMIN_PANEL: {
    id: 'admin_panel',
    path: '/admin',
    responseDelay: 2000,
    response: {
      status: 200,
      body: '<html><body>Admin Login</body></html>'
    }
  },
  
  // 虚假 API 端点
  FAKE_API: {
    id: 'fake_api',
    path: '/api/internal',
    responseDelay: 1000,
    response: {
      status: 200,
      body: { success: true, data: 'internal_access' }
    }
  },
  
  // 虚假数据库端点
  FAKE_DB: {
    id: 'fake_db',
    path: '/db/admin',
    responseDelay: 3000,
    response: {
      status: 403,
      body: 'Access Denied'
    }
  }
};

/**
 * 蜜罐服务
 */
class HoneypotService extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.honeypots = HONEYPOT_TYPES;
    this.trappedAttackers = new Map();
  }
  
  /**
   * 检查请求是否命中蜜罐
   */
  async checkRequest(request) {
    for (const [typeId, honeypot] of Object.entries(this.honeypots)) {
      if (request.path.startsWith(honeypot.path)) {
        await this._trapAttacker(request, honeypot);
        return {
          trapped: true,
          honeypot: typeId,
          response: honeypot.response
        };
      }
    }
    
    return { trapped: false };
  }
  
  /**
   * 捕获攻击者
   */
  async _trapAttacker(request, honeypot) {
    const attackerId = this._generateAttackerId(request);
    
    // 记录攻击者信息
    const trapData = {
      id: attackerId,
      ip: request.ip,
      userAgent: request.userAgent,
      path: request.path,
      method: request.method,
      headers: request.headers,
      honeypot: honeypot.id,
      timestamp: Date.now()
    };
    
    await this.redis.lpush(
      `honeypot:trapped:${attackerId}`,
      JSON.stringify(trapData)
    );
    
    // 记录全局蜜罐日志
    await this.redis.lpush('honeypot:log', JSON.stringify(trapData));
    await this.redis.ltrim('honeypot:log', 0, 999);
    
    // 更新攻击者档案
    await this._updateAttackerProfile(attackerId, trapData);
    
    // 自动加入监控列表
    await this.redis.sadd('security:watchlist:ips', request.ip);
    
    // 发出告警
    this.emit('attacker_trapped', trapData);
    
    logger.warn('蜜罐捕获攻击者', trapData);
    metrics.increment('honeypot_traps_total', { type: honeypot.id });
  }
  
  /**
   * 更新攻击者档案
   */
  async _updateAttackerProfile(attackerId, trapData) {
    const profile = await this.redis.hgetall(`honeypot:profile:${attackerId}`);
    
    const updatedProfile = {
      ip: trapData.ip,
      firstSeen: profile.firstSeen || trapData.timestamp,
      lastSeen: trapData.timestamp,
      trapCount: parseInt(profile.trapCount || 0) + 1,
      honeypotsHit: [...new Set([...(profile.honeypotsHit || '').split(','), trapData.honeypot])].join(',')
    };
    
    await this.redis.hmset(`honeypot:profile:${attackerId}`, updatedProfile);
    await this.redis.expire(`honeypot:profile:${attackerId}`, 2592000); // 30天
  }
  
  /**
   * 生成攻击者 ID
   */
  _generateAttackerId(request) {
    const crypto = require('crypto');
    const data = `${request.ip}:${request.userAgent}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }
  
  /**
   * 获取蜜罐统计
   */
  async getStats() {
    const totalTraps = await this.redis.llen('honeypot:log');
    
    const stats = {
      totalTraps,
      byType: {}
    };
    
    for (const typeId of Object.keys(this.honeypots)) {
      const count = await this.redis.get(`honeypot:count:${typeId}`);
      stats.byType[typeId] = parseInt(count || 0);
    }
    
    return stats;
  }
}

module.exports = { HoneypotService, HONEYPOT_TYPES };
```

### 4. 网关中间件集成

**位置**: `gateway/src/middleware/attackDetection.js`

```javascript
const { AttackPatternDetector } = require('../../shared/AttackPatternDetector');
const { ThreatIntelligenceService } = require('../../shared/ThreatIntelligenceService');
const { HoneypotService } = require('../../shared/HoneypotService');

/**
 * 攻击检测中间件
 */
function createAttackDetectionMiddleware(config = {}) {
  const detector = new AttackPatternDetector(config);
  const threatIntel = new ThreatIntelligenceService(config);
  const honeypot = new HoneypotService(config);
  
  return async (req, res, next) => {
    const startTime = Date.now();
    
    try {
      // 1. 检查蜜罐
      const honeypotResult = await honeypot.checkRequest(req);
      if (honeypotResult.trapped) {
        // 延迟响应增加攻击者时间成本
        setTimeout(() => {
          res.status(honeypotResult.response.status).send(honeypotResult.response.body);
        }, 2000);
        return;
      }
      
      // 2. 检查 IP 信誉
      const ipReputation = await threatIntel.checkIPReputation(req.ip);
      if (ipReputation.reputation < 30) {
        logger.warn('低信誉 IP 访问被拒绝', {
          ip: req.ip,
          reputation: ipReputation.reputation
        });
        
        return res.status(403).json({
          error: 'Access Denied',
          code: 'LOW_IP_REPUTATION'
        });
      }
      
      // 3. 攻击模式检测
      if (req.user?.id) {
        const analysis = await detector.analyzeRequest(req.user.id, {
          ip: req.ip,
          deviceId: req.deviceId,
          userAgent: req.headers['user-agent'],
          path: req.path,
          method: req.method,
          eventType: req.eventType
        });
        
        // 高风险请求处理
        if (analysis.riskScore >= 0.9) {
          return res.status(403).json({
            error: 'Account Security Alert',
            code: 'HIGH_RISK_DETECTED',
            action: 'Please contact support'
          });
        }
        
        // 中等风险要求验证
        if (analysis.riskScore >= 0.7) {
          req.securityAction = 'captcha_required';
        }
        
        // 添加风险评分到请求上下文
        req.riskScore = analysis.riskScore;
        req.detectedPatterns = analysis.detectedPatterns;
      }
      
      next();
      
    } catch (error) {
      logger.error('攻击检测中间件错误', {
        error: error.message,
        path: req.path,
        ip: req.ip
      });
      
      // 失败时允许请求继续，避免影响正常用户
      next();
    }
  };
}

module.exports = { createAttackDetectionMiddleware };
```

### 5. 数据库迁移

**位置**: `database/migrations/20260618223000_create_attack_detection_tables.sql`

```sql
-- 攻击事件表
CREATE TABLE attack_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  ip_address VARCHAR(45) NOT NULL,
  attack_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  risk_score DECIMAL(3,2) NOT NULL,
  indicators JSONB,
  actions_taken TEXT[],
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attack_events_user_id ON attack_events(user_id);
CREATE INDEX idx_attack_events_ip_address ON attack_events(ip_address);
CREATE INDEX idx_attack_events_created_at ON attack_events(created_at);
CREATE INDEX idx_attack_events_type_severity ON attack_events(attack_type, severity);

-- 攻击者档案表
CREATE TABLE attacker_profiles (
  id SERIAL PRIMARY KEY,
  attacker_fingerprint VARCHAR(64) UNIQUE NOT NULL,
  ip_addresses TEXT[],
  user_agents TEXT[],
  attack_count INTEGER DEFAULT 0,
  first_seen TIMESTAMP NOT NULL,
  last_seen TIMESTAMP NOT NULL,
  attack_types TEXT[],
  risk_level VARCHAR(20),
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attacker_profiles_fingerprint ON attacker_profiles(attacker_fingerprint);
CREATE INDEX idx_attacker_profiles_risk_level ON attacker_profiles(risk_level);

-- 威胁情报缓存表
CREATE TABLE threat_intel_cache (
  id SERIAL PRIMARY KEY,
  resource_type VARCHAR(20) NOT NULL, -- 'ip' or 'domain'
  resource_value VARCHAR(255) NOT NULL,
  reputation_score INTEGER,
  is_malicious BOOLEAN DEFAULT FALSE,
  details JSONB,
  source VARCHAR(50) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_threat_intel_cache_unique ON threat_intel_cache(resource_type, resource_value);
CREATE INDEX idx_threat_intel_cache_expires ON threat_intel_cache(expires_at);

-- 安全响应动作日志表
CREATE TABLE security_action_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action_type VARCHAR(50) NOT NULL,
  trigger_reason TEXT NOT NULL,
  risk_score DECIMAL(3,2),
  metadata JSONB,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  executed_by VARCHAR(50) DEFAULT 'system'
);

CREATE INDEX idx_security_action_logs_user_id ON security_action_logs(user_id);
CREATE INDEX idx_security_action_logs_executed_at ON security_action_logs(executed_at);

-- 蜜罐事件表
CREATE TABLE honeypot_events (
  id SERIAL PRIMARY KEY,
  attacker_fingerprint VARCHAR(64),
  ip_address VARCHAR(45) NOT NULL,
  user_agent TEXT,
  honeypot_type VARCHAR(50) NOT NULL,
  request_path TEXT NOT NULL,
  request_method VARCHAR(10),
  headers JSONB,
  trapped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_honeypot_events_ip ON honeypot_events(ip_address);
CREATE INDEX idx_honeypot_events_type ON honeypot_events(honeypot_type);
CREATE INDEX idx_honeypot_events_trapped_at ON honeypot_events(trapped_at);
```

### 6. 管理后台仪表板

**位置**: `admin-dashboard/src/pages/SecurityDashboard.jsx`

```jsx
import React, { useState, useEffect } from 'react';
import { Line, Bar, Pie } from 'react-chartjs-2';
import { Grid, Card, CardContent, Typography, Chip, Table, TableHead, TableRow, TableCell, TableBody } from '@material-ui/core';

function SecurityDashboard() {
  const [stats, setStats] = useState({
    activeAttacks: [],
    threatScores: [],
    honeypotStats: {},
    recentEvents: []
  });
  
  useEffect(() => {
    fetchSecurityStats();
    const interval = setInterval(fetchSecurityStats, 30000); // 30秒刷新
    return () => clearInterval(interval);
  }, []);
  
  const fetchSecurityStats = async () => {
    const response = await fetch('/api/admin/security/stats');
    const data = await response.json();
    setStats(data);
  };
  
  return (
    <div className="security-dashboard">
      <Typography variant="h4" gutterBottom>
        安全监控中心
      </Typography>
      
      {/* 攻击概览 */}
      <Grid container spacing={3}>
        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                今日攻击次数
              </Typography>
              <Typography variant="h3">
                {stats.todayAttackCount || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                高风险用户
              </Typography>
              <Typography variant="h3" color="error">
                {stats.highRiskUsers || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                蜜罐捕获
              </Typography>
              <Typography variant="h3">
                {stats.honeypotStats?.totalTraps || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} md={3}>
          <Card>
            <CardContent>
              <Typography color="textSecondary" gutterBottom>
                已拦截 IP
              </Typography>
              <Typography variant="h3">
                {stats.blockedIPs || 0}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
      
      {/* 攻击类型分布 */}
      <Grid container spacing={3} style={{ marginTop: 20 }}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                攻击类型分布
              </Typography>
              <Pie data={getAttackTypeChartData(stats)} />
            </CardContent>
          </Card>
        </Grid>
        
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                24小时攻击趋势
              </Typography>
              <Line data={getAttackTrendData(stats)} />
            </CardContent>
          </Card>
        </Grid>
      </Grid>
      
      {/* 实时攻击事件 */}
      <Card style={{ marginTop: 20 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            实时攻击事件
          </Typography>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>时间</TableCell>
                <TableCell>用户</TableCell>
                <TableCell>IP</TableCell>
                <TableCell>攻击类型</TableCell>
                <TableCell>风险评分</TableCell>
                <TableCell>状态</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {stats.recentEvents.map((event, index) => (
                <TableRow key={index}>
                  <TableCell>{new Date(event.timestamp).toLocaleString()}</TableCell>
                  <TableCell>{event.userId}</TableCell>
                  <TableCell>{event.ip}</TableCell>
                  <TableCell>{event.attackType}</TableCell>
                  <TableCell>
                    <Chip
                      label={`${(event.riskScore * 100).toFixed(0)}%`}
                      color={event.riskScore >= 0.7 ? 'secondary' : 'primary'}
                    />
                  </TableCell>
                  <TableCell>
                    <Chip label={event.status} color="primary" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function getAttackTypeChartData(stats) {
  return {
    labels: ['凭证填充', '分布式攻击', 'API滥用', '慢速攻击', '横向移动'],
    datasets: [{
      data: [
        stats.attackTypes?.credential_stuffing || 0,
        stats.attackTypes?.distributed_attack || 0,
        stats.attackTypes?.api_abuse_chain || 0,
        stats.attackTypes?.slowloris || 0,
        stats.attackTypes?.lateral_movement || 0
      ],
      backgroundColor: ['#f44336', '#ff9800', '#ffc107', '#4caf50', '#2196f3']
    }]
  };
}

function getAttackTrendData(stats) {
  return {
    labels: stats.trendLabels || [],
    datasets: [{
      label: '攻击次数',
      data: stats.trendData || [],
      borderColor: '#f44336',
      fill: false
    }]
  };
}

export default SecurityDashboard;
```

### 7. Prometheus 指标

**位置**: `backend/shared/metrics.js` (扩展)

```javascript
// 攻击检测相关指标
const attackMetrics = {
  // 攻击检测请求总数
  attack_detection_requests_total: new Counter({
    name: 'attack_detection_requests_total',
    help: 'Total number of attack detection requests'
  }),
  
  // 高风险请求总数
  high_risk_requests_total: new Counter({
    name: 'high_risk_requests_total',
    help: 'Total number of high risk requests detected'
  }),
  
  // 攻击检测耗时
  attack_detection_duration_ms: new Histogram({
    name: 'attack_detection_duration_ms',
    help: 'Duration of attack detection in milliseconds',
    buckets: [10, 50, 100, 200, 500, 1000]
  }),
  
  // 按类型的攻击次数
  attacks_by_type_total: new Counter({
    name: 'attacks_by_type_total',
    help: 'Total number of attacks by type',
    labelNames: ['attack_type', 'severity']
  }),
  
  // 安全动作执行次数
  security_actions_total: new Counter({
    name: 'security_actions_total',
    help: 'Total number of security actions executed',
    labelNames: ['action_type']
  }),
  
  // 蜜罐捕获次数
  honeypot_traps_total: new Counter({
    name: 'honeypot_traps_total',
    help: 'Total number of honeypot traps triggered',
    labelNames: ['type']
  }),
  
  // 威胁情报查询次数
  threat_intel_queries_total: new Counter({
    name: 'threat_intel_queries_total',
    help: 'Total number of threat intelligence queries',
    labelNames: ['source', 'resource_type']
  }),
  
  // 低信誉 IP 拦截次数
  low_reputation_ip_blocked_total: new Counter({
    name: 'low_reputation_ip_blocked_total',
    help: 'Total number of low reputation IPs blocked'
  })
};
```

## 验收标准

- [ ] 攻击模式检测器能识别 6 种主要攻击模式
- [ ] 每次请求检测耗时 < 50ms (P95)
- [ ] 风险评分准确率 > 85% (人工验证)
- [ ] 威胁情报服务集成至少 3 个外部源
- [ ] 蜜罐系统捕获攻击者并记录完整信息
- [ ] 自动响应机制能正确触发安全动作
- [ ] 管理后台展示实时攻击监控仪表板
- [ ] 所有安全事件记录到数据库供审计
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试验证完整攻击检测流程
- [ ] 性能测试验证对正常请求无显著影响 (< 5% 延迟增加)

## 影响范围

### 新增文件
- `backend/shared/AttackPatternDetector.js` - 攻击模式检测引擎
- `backend/shared/ThreatIntelligenceService.js` - 威胁情报集成
- `backend/shared/HoneypotService.js` - 蜜罐诱捕系统
- `gateway/src/middleware/attackDetection.js` - 网关中间件
- `database/migrations/20260618223000_create_attack_detection_tables.sql` - 数据库迁移
- `admin-dashboard/src/pages/SecurityDashboard.jsx` - 管理后台

### 修改文件
- `gateway/src/index.js` - 注册攻击检测中间件
- `backend/shared/metrics.js` - 新增安全相关指标
- `infrastructure/k8s/monitoring/prometheus.yml` - 新增告警规则

### 外部依赖
- AbuseIPDB API Key
- VirusTotal API Key
- IPQualityScore API Key

## 参考

- [OWASP Automated Threat Handbook](https://owasp.org/www-project-automated-threats-to-web-applications/)
- [MITRE ATT&CK Framework](https://attack.mitre.org/)
- [AbuseIPDB API Documentation](https://docs.abuseipdb.com/)
- [IPQualityScore Documentation](https://www.ipqualityscore.com/documentation)
- [VirusTotal API v3](https://developers.virustotal.com/reference/overview)
