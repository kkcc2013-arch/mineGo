'use strict';

/**
 * 威胁检测路由
 * Gateway 路由定义
 */

module.exports = {
  name: 'threat-detection',
  version: '1.0.0',
  
  routes: [
    // 威胁事件上报
    {
      method: 'POST',
      path: '/api/security/threat/report',
      handler: 'security/threatDetection.report',
      auth: true,
      rateLimit: {
        windowMs: 60000,
        max: 10
      },
      validate: {
        body: {
          eventType: { type: 'string', required: true },
          data: { type: 'object', required: false },
          deviceFingerprint: { type: 'string', required: false },
          timestamp: { type: 'number', required: true }
        }
      },
      description: 'Report security threat event from client'
    },
    
    // 获取威胁检测配置
    {
      method: 'GET',
      path: '/api/security/threat/config',
      handler: 'security/threatDetection.getConfig',
      auth: true,
      cache: {
        ttl: 300
      },
      description: 'Get threat detection configuration'
    },
    
    // 查询威胁事件
    {
      method: 'GET',
      path: '/api/security/threat/events',
      handler: 'security/threatDetection.getEvents',
      auth: true,
      permissions: ['security:read'],
      validate: {
        query: {
          ip: { type: 'string', required: false },
          level: { type: 'string', required: false },
          startDate: { type: 'string', required: false },
          endDate: { type: 'string', required: false },
          limit: { type: 'number', required: false, default: 50 },
          offset: { type: 'number', required: false, default: 0 }
        }
      },
      description: 'Query threat events with filters'
    },
    
    // 提交威胁反馈
    {
      method: 'POST',
      path: '/api/security/threat/feedback',
      handler: 'security/threatDetection.submitFeedback',
      auth: true,
      permissions: ['security:write'],
      validate: {
        body: {
          threatId: { type: 'string', required: true },
          label: { type: 'string', required: true },
          comment: { type: 'string', required: false }
        }
      },
      description: 'Submit feedback for threat detection accuracy improvement'
    },
    
    // 获取 IP 封禁状态
    {
      method: 'GET',
      path: '/api/security/threat/ban/:ip',
      handler: 'security/threatDetection.getBanStatus',
      auth: true,
      permissions: ['security:read'],
      description: 'Check if IP is banned'
    },
    
    // 手动封禁 IP
    {
      method: 'POST',
      path: '/api/security/threat/ban',
      handler: 'security/threatDetection.banIp',
      auth: true,
      permissions: ['security:admin'],
      validate: {
        body: {
          ip: { type: 'string', required: true },
          duration: { type: 'number', required: true },
          reason: { type: 'string', required: true }
        }
      },
      description: 'Manually ban an IP address'
    },
    
    // 解除 IP 封禁
    {
      method: 'DELETE',
      path: '/api/security/threat/ban/:ip',
      handler: 'security/threatDetection.unbanIp',
      auth: true,
      permissions: ['security:admin'],
      description: 'Unban an IP address'
    },
    
    // 获取威胁统计
    {
      method: 'GET',
      path: '/api/security/threat/stats',
      handler: 'security/threatDetection.getStats',
      auth: true,
      permissions: ['security:read'],
      description: 'Get threat detection statistics'
    },
    
    // 验证验证码
    {
      method: 'POST',
      path: '/api/security/captcha/verify',
      handler: 'security/threatDetection.verifyCaptcha',
      auth: false,
      rateLimit: {
        windowMs: 60000,
        max: 5
      },
      validate: {
        body: {
          token: { type: 'string', required: true },
          challengeToken: { type: 'string', required: true }
        }
      },
      description: 'Verify captcha challenge'
    }
  ],
  
  // 中间件配置
  middleware: {
    // 威胁检测中间件会在主应用中注册
    threatDetection: {
      enabled: true,
      skipPaths: ['/health', '/metrics', '/api/auth/captcha', '/api/security/captcha/verify'],
      engine: {
        windowSize: 60000
      }
    }
  }
};