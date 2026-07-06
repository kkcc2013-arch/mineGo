/**
 * WebSocket 安全中间件
 * REQ-00434: WebSocket 消息完整性与防重放攻击保护系统
 * 
 * 功能：
 * - 消息签名验证
 * - Challenge-Response 身份验证
 * - 异常行为检测
 * - 自动断开高风险连接
 * - Prometheus 指标收集
 */

const WebSocketMessageSecurity = require('./WebSocketMessageSecurity');
const WebSocketChallengeAuth = require('./WebSocketChallengeAuth');
const WebSocketAnomalyDetector = require('./WebSocketAnomalyDetector');
const { logger, metrics } = require('../../index');
const { v4: uuidv4 } = require('uuid');

class WebSocketSecurityMiddleware {
  constructor(options = {}) {
    this.redis = options.redis;
    this.secretKey = options.secretKey || process.env.WS_SECRET_KEY;
    
    if (!this.secretKey) {
      throw new Error('WebSocket secret key is required');
    }
    
    // 初始化安全组件
    this.messageSecurity = new WebSocketMessageSecurity({
      redis: this.redis,
      secretKey: this.secretKey,
      ...options.messageSecurity
    });
    
    this.challengeAuth = new WebSocketChallengeAuth({
      redis: this.redis,
      secretKey: this.secretKey,
      ...options.challengeAuth
    });
    
    this.anomalyDetector = new WebSocketAnomalyDetector({
      redis: this.redis,
      ...options.anomalyDetector
    });
    
    // 配置
    this.enableChallenge = options.enableChallenge !== false; // 默认启用
    this.enableSigning = options.enableSigning !== false; // 默认启用
    this.enableAnomalyDetection = options.enableAnomalyDetection !== false; // 默认启用
    
    // 设置 Prometheus 指标
    this.setupMetrics();
    
    logger.info('WebSocket security middleware initialized');
  }

  setupMetrics() {
    this.metrics = {
      // 消息验证指标
      messageVerifications: metrics.counter('ws_message_verifications_total', 'Total WebSocket message verifications', ['result', 'reason']),
      
      // Challenge 认证指标
      challengeAuth: metrics.counter('ws_challenge_auth_total', 'Total challenge authentications', ['result']),
      
      // 安全违规指标
      securityViolations: metrics.counter('ws_security_violations_total', 'Total security violations', ['reason']),
      
      // 安全断开连接指标
      securityDisconnects: metrics.counter('ws_security_disconnects_total', 'Total WebSocket disconnections due to security', ['reason']),
      
      // Nonce 操作指标
      nonceOperations: metrics.counter('ws_nonce_operations_total', 'Total nonce operations', ['operation']),
      
      // 签名延迟
      signatureDuration: metrics.histogram('ws_signature_duration_seconds', 'WebSocket message signing duration', [], [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]),
      
      // 验证延迟
      verificationDuration: metrics.histogram('ws_verification_duration_seconds', 'WebSocket message verification duration', [], [0.001, 0.005, 0.01, 0.025, 0.05, 0.1])
    };
  }

  /**
   * 消息验证中间件
   * @returns {Function} Express 中间件函数
   */
  verify() {
    return async (ws, message, next) => {
      const startTime = Date.now();
      const sessionId = ws.sessionId || uuidv4();
      
      try {
        // 解析消息
        let parsedMessage;
        try {
          parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
        } catch (error) {
          logger.warn({ sessionId }, 'Failed to parse WebSocket message');
          this.metrics.messageVerifications.inc({ result: 'failed', reason: 'PARSE_ERROR' });
          ws.send(JSON.stringify({
            type: 'error',
            code: 'MESSAGE_PARSE_ERROR',
            message: 'Invalid message format'
          }));
          return;
        }
        
        // 跳过心跳消息
        if (parsedMessage.type === 'ping' || parsedMessage.type === 'pong' || parsedMessage.type === 'heartbeat') {
          return next();
        }
        
        // 跳过认证挑战消息
        if (parsedMessage.type === 'auth_challenge' || parsedMessage.type === 'auth_response') {
          return next();
        }
        
        // 检查是否需要挑战认证
        if (this.enableChallenge && await this.challengeAuth.shouldChallenge(sessionId)) {
          const challengeMessage = await this.challengeAuth.sendChallenge(ws, sessionId);
          ws.send(JSON.stringify(challengeMessage));
          // 暂停处理，等待挑战响应
          return;
        }
        
        // 验证消息签名和完整性
        if (this.enableSigning) {
          const result = await this.messageSecurity.verifyMessage(parsedMessage, sessionId);
          
          if (!result.valid) {
            // 记录异常
            await this.anomalyDetector.recordViolation(ws, result.reason, result.details);
            
            // 更新指标
            this.metrics.messageVerifications.inc({ result: 'failed', reason: result.reason });
            this.metrics.securityViolations.inc({ reason: result.reason });
            
            // 发送错误响应
            ws.send(JSON.stringify({
              type: 'error',
              code: 'SECURITY_VIOLATION',
              reason: result.reason,
              details: result.details
            }));
            
            // 检查是否应该断开连接
            const { shouldDisconnect, reason } = await this.anomalyDetector.shouldDisconnect(ws);
            if (shouldDisconnect) {
              this.metrics.securityDisconnects.inc({ reason: result.reason });
              this.anomalyDetector.recordDisconnection(sessionId, reason);
              ws.close(1008, `Security violation: ${reason}`);
            }
            
            return;
          }
        }
        
        // 检测重放攻击模式
        if (this.enableAnomalyDetection) {
          const replayResult = await this.anomalyDetector.detectReplayPattern(ws, parsedMessage);
          if (replayResult.detected) {
            await this.anomalyDetector.recordViolation(ws, 'REPLAY_ATTACK_DETECTED', replayResult.details);
            this.metrics.securityViolations.inc({ reason: 'REPLAY_ATTACK' });
            
            ws.send(JSON.stringify({
              type: 'error',
              code: 'REPLAY_ATTACK_DETECTED',
              message: 'Potential replay attack detected'
            }));
            
            return;
          }
        }
        
        // 消息验证通过，继续处理
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.verificationDuration.observe(duration);
        this.metrics.messageVerifications.inc({ result: 'success', reason: 'none' });
        
        // 将解析后的消息附加到请求
        ws.parsedMessage = parsedMessage;
        
        next();
      } catch (error) {
        logger.error({ error: error.message, sessionId }, 'WebSocket security middleware error');
        this.metrics.messageVerifications.inc({ result: 'failed', reason: 'INTERNAL_ERROR' });
        
        ws.send(JSON.stringify({
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: 'Internal security validation error'
        }));
      }
    };
  }

  /**
   * 消息签名中间件（用于发送消息）
   * @returns {Function} Express 中间件函数
   */
  sign() {
    return async (ws, message, next) => {
      if (!this.enableSigning) {
        return next(message);
      }
      
      const startTime = Date.now();
      const sessionId = ws.sessionId || uuidv4();
      
      try {
        const signedMessage = this.messageSecurity.signMessage(message, sessionId);
        
        const duration = (Date.now() - startTime) / 1000;
        this.metrics.signatureDuration.observe(duration);
        
        next(signedMessage);
      } catch (error) {
        logger.error({ error: error.message, sessionId }, 'Failed to sign message');
        next(message); // 发送未签名的消息作为降级
      }
    };
  }

  /**
   * 处理认证挑战响应
   * @param {object} ws - WebSocket 连接
   * @param {object} response - 挑战响应
   * @returns {Promise<{valid: boolean}>}
   */
  async handleChallengeResponse(ws, response) {
    const sessionId = ws.sessionId || uuidv4();
    
    const result = await this.challengeAuth.verifyChallengeResponse(sessionId, response);
    
    if (result.valid) {
      this.metrics.challengeAuth.inc({ result: 'success' });
      
      ws.send(JSON.stringify({
        type: 'auth_success',
        message: 'Authentication successful'
      }));
      
      return { valid: true };
    } else {
      this.metrics.challengeAuth.inc({ result: 'failed' });
      
      ws.send(JSON.stringify({
        type: 'auth_failed',
        code: result.reason,
        message: 'Authentication failed'
      }));
      
      // 检查是否应该断开
      if (await this.challengeAuth.shouldDisconnect(sessionId)) {
        this.metrics.securityDisconnects.inc({ reason: 'CHALLENGE_FAILED' });
        ws.close(1008, 'Too many authentication failures');
      }
      
      return { valid: false };
    }
  }

  /**
   * 获取统计信息
   * @returns {object}
   */
  getStats() {
    return {
      messageSecurity: this.messageSecurity.getStats(),
      challengeAuth: this.challengeAuth.getStats(),
      anomalyDetector: this.anomalyDetector.getStats(),
      config: {
        enableChallenge: this.enableChallenge,
        enableSigning: this.enableSigning,
        enableAnomalyDetection: this.enableAnomalyDetection
      }
    };
  }

  /**
   * 清理资源（定时任务调用）
   */
  async cleanup() {
    await Promise.all([
      this.messageSecurity.cleanup(),
      this.challengeAuth.cleanup(),
      this.anomalyDetector.cleanup()
    ]);
    
    logger.debug('WebSocket security middleware cleanup completed');
  }
}

module.exports = WebSocketSecurityMiddleware;