'use strict';

/**
 * 威胁检测中间件
 * 在网关层拦截和检测威胁流量
 */

const ThreatDetectionEngine = require('./ThreatDetectionEngine');
const ThreatResponseExecutor = require('./ThreatResponseExecutor');

class ThreatDetectionMiddleware {
  constructor(config = {}) {
    this.engine = new ThreatDetectionEngine(config.engine);
    this.executor = new ThreatResponseExecutor({ 
      redis: config.redis,
      logger: config.logger || console
    });
    
    this.redis = config.redis;
    this.logger = config.logger || console;
    
    // 配置
    this.enabled = config.enabled !== false;
    this.skipPaths = config.skipPaths || ['/health', '/metrics', '/api/auth/captcha'];
    this.skipIps = new Set(config.skipIps || []);
    
    // Prometheus 指标（如果配置了）
    this.metrics = config.metrics || null;
  }

  /**
   * Express 中间件入口
   */
  middleware() {
    return async (req, res, next) => {
      if (!this.enabled) {
        return next();
      }
      
      // 跳过健康检查等路径
      if (this.skipPaths.some(p => req.path.startsWith(p))) {
        return next();
      }
      
      const ip = this.getClientIp(req);
      
      // 跳过白名单 IP
      if (this.skipIps.has(ip)) {
        return next();
      }
      
      try {
        // 1. 检查是否已被封禁
        const banStatus = await this.executor.checkBanStatus(ip);
        
        if (banStatus) {
          return this.respondBlocked(res, banStatus);
        }
        
        // 2. 检查是否需要验证码挑战
        const challengeRequired = await this.executor.checkChallengeRequired(ip);
        
        if (challengeRequired && !req.path.includes('/captcha/verify')) {
          return this.respondChallengeRequired(res, challengeRequired, ip);
        }
        
        // 3. 执行威胁检测
        const startTime = Date.now();
        const threatResult = await this.engine.detect(this.redis, req, {
          sessionAge: this.getSessionAge(req),
          authAttempts: this.getAuthAttempts(req),
          statusCode: null, // 将在响应后更新
          responseTime: null
        });
        
        // 附加威胁信息到请求对象
        req.threatDetection = {
          result: threatResult,
          startTime
        };
        
        // 4. 如果检测到威胁，执行响应
        if (threatResult.threatLevel !== 'normal') {
          const responseResult = await this.executor.execute(threatResult, req);
          
          // 如果需要阻止请求
          const blockAction = responseResult.actions?.find(a => 
            a.action === 'block_request' && a.success
          );
          
          if (blockAction) {
            this.recordMetrics(threatResult, 'blocked');
            return this.respondBlocked(res, {
              threatId: threatResult.threatId,
              reason: 'critical_threat'
            });
          }
          
          // 如果需要验证码
          const challengeAction = responseResult.actions?.find(a => 
            a.action === 'challenge_captcha' && a.success
          );
          
          if (challengeAction && challengeAction.challengeRequired) {
            this.recordMetrics(threatResult, 'challenged');
            return this.respondChallengeRequired(res, {
              ...challengeAction,
              threatId: threatResult.threatId
            }, ip);
          }
          
          // 记录指标
          this.recordMetrics(threatResult, 'detected');
        }
        
        // 继续请求处理
        next();
        
      } catch (error) {
        this.logger.error('[ThreatDetectionMiddleware] Error:', error);
        
        // 检测失败不影响正常请求
        next();
      }
    };
  }

  /**
   * 响应拦截器 - 在响应发送后更新统计
   */
  responseInterceptor() {
    return (req, res, next) => {
      const originalEnd = res.end;
      const originalJson = res.json;
      const startTime = Date.now();
      
      // 拦截响应结束
      res.end = function(...args) {
        this.updateRequestStats(req, res, startTime);
        originalEnd.apply(this, args);
      };
      
      res.json = function(data) {
        this.updateRequestStats(req, res, startTime);
        return originalJson.call(this, data);
      };
      
      next();
    };
  }

  /**
   * 更新请求统计
   */
  async updateRequestStats(req, res, startTime) {
    if (!req.threatDetection) return;
    
    const responseTime = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    // 更新窗口统计
    try {
      const ip = this.getClientIp(req);
      const key = `threat:features:${ip}`;
      
      await this.engine.featureExtractor.updateWindowStats(this.redis, ip, {
        timestamp: Date.now(),
        path: req.path,
        method: req.method,
        statusCode,
        responseTime
      });
    } catch (err) {
      // 静默失败
    }
  }

  /**
   * 返回封禁响应
   */
  respondBlocked(res, banStatus) {
    return res.status(403).json({
      error: 'Access Denied',
      message: 'Your access has been temporarily restricted due to security policy violation',
      reason: banStatus.reason || 'security_policy_violation',
      threatId: banStatus.threatId,
      expiresAt: banStatus.expiresAt,
      retryAfter: banStatus.expiresAt ? 
        Math.max(0, Math.ceil((banStatus.expiresAt - Date.now()) / 1000)) : 
        null
    });
  }

  /**
   * 返回验证码挑战响应
   */
  respondChallengeRequired(res, challenge, ip) {
    return res.status(429).json({
      error: 'Verification Required',
      message: 'Additional verification is required to continue',
      challengeType: 'captcha',
      challengeToken: challenge.challengeToken || challenge.token,
      threatId: challenge.threatId,
      verifyUrl: `/api/security/captcha/verify?token=${challenge.challengeToken || challenge.token}`,
      attemptsRemaining: challenge.attemptsRemaining || 3
    });
  }

  /**
   * 记录 Prometheus 指标
   */
  recordMetrics(threatResult, action) {
    if (!this.metrics) return;
    
    const { threatLevel, threatScore, inferenceTime } = threatResult;
    
    // 威胁检测计数
    if (this.metrics.threatDetected) {
      this.metrics.threatDetected.inc({ level: threatLevel });
    }
    
    // 响应动作计数
    if (this.metrics.responseAction) {
      this.metrics.responseAction.inc({ action });
    }
    
    // 推理延迟
    if (this.metrics.inferenceLatency) {
      this.metrics.inferenceLatency.observe(inferenceTime);
    }
  }

  /**
   * 获取客户端 IP
   */
  getClientIp(req) {
    return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers?.['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.ip ||
           'unknown';
  }

  /**
   * 获取会话年龄（秒）
   */
  getSessionAge(req) {
    const sessionStart = req.session?.createdAt || req.headers?.['x-session-start'];
    
    if (sessionStart) {
      return Math.floor((Date.now() - new Date(sessionStart).getTime()) / 1000);
    }
    
    return 0;
  }

  /**
   * 获取认证尝试次数
   */
  getAuthAttempts(req) {
    // 从会话或请求上下文获取
    return req.session?.authAttempts || 0;
  }

  /**
   * 获取引擎统计
   */
  getEngineStats() {
    return this.engine.getStats();
  }

  /**
   * 获取执行器统计
   */
  getExecutorStats() {
    return this.executor.getStats();
  }
}

module.exports = ThreatDetectionMiddleware;