'use strict';

/**
 * REQ-00584: API 超时策略标准化与分级超时治理系统
 * 网关层超时中间件
 */

const { createLogger } = require('../../shared/logger');
const { timeoutPolicyManager } = require('../../shared/TimeoutPolicyManager');

const logger = createLogger('timeout-middleware');

/**
 * 超时中间件工厂函数
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function timeoutMiddleware(options = {}) {
  const policyManager = options.policyManager || timeoutPolicyManager;
  
  return async (req, res, next) => {
    // 跳过健康检查和内部端点
    if (req.path === '/health' || req.path === '/ready' || req.path.startsWith('/metrics')) {
      return next();
    }
    
    try {
      // 获取路由路径（Express 会在 req.route.path 中存储匹配的模式）
      const routePath = req.route?.path || req.path;
      const method = req.method;
      
      // 客户端超时协商
      const clientTimeout = parseInt(req.headers['x-client-timeout'], 10);
      const negotiation = policyManager.negotiateTimeout(routePath, method, clientTimeout);
      
      // 设置响应头，告知客户端实际超时值
      res.setHeader('X-Server-Timeout', negotiation.effectiveTimeout);
      res.setHeader('X-Timeout-Level', negotiation.level);
      
      if (negotiation.negotiated) {
        res.setHeader('X-Timeout-Negotiated', negotiation.result);
      }
      
      // 设置请求超时
      req.setTimeout(negotiation.effectiveTimeout, () => {
        // 记录超时事件
        policyManager.recordTimeout(routePath, method);
        
        // 发送超时响应
        if (!res.headersSent) {
          res.status(408).json({
            success: false,
            error: {
              code: 1009,
              message: '请求超时',
              timeout_ms: negotiation.effectiveTimeout,
              level: negotiation.level
            }
          });
        }
      });
      
      // 监听响应完成，清理超时
      res.on('finish', () => {
        // 清理超时处理
        if (req.timeout) {
          clearTimeout(req.timeout);
        }
      });
      
      // 暴露超时信息给后续中间件
      req.timeoutPolicy = negotiation;
      
      next();
    } catch (error) {
      logger.error('Timeout middleware error', { 
        error: error.message, 
        path: req.path,
        method: req.method 
      });
      
      // 出错时使用默认超时继续处理
      req.timeoutPolicy = {
        effectiveTimeout: 10000,
        level: 'L2',
        negotiated: false,
        result: 'error'
      };
      next();
    }
  };
}

/**
 * Admin API 超时策略管理路由
 */
function createTimeoutAdminRoutes(policyManager) {
  const router = require('express').Router();
  const manager = policyManager || timeoutPolicyManager;
  
  // 获取所有超时策略
  router.get('/timeout-policies', async (req, res) => {
    try {
      const policies = manager.getAllPolicies();
      const stats = manager.getStats();
      
      res.json({
        success: true,
        data: policies,
        stats
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 1500, message: error.message }
      });
    }
  });
  
  // 获取单个策略
  router.get('/timeout-policies/:route(*)', async (req, res) => {
    try {
      const { route } = req.params;
      const policy = manager.policies.get(decodeURIComponent(route));
      
      if (!policy) {
        return res.status(404).json({
          success: false,
          error: { code: 1404, message: '策略不存在' }
        });
      }
      
      res.json({ success: true, data: policy });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 1500, message: error.message }
      });
    }
  });
  
  // 更新超时策略
  router.put('/timeout-policies/:route(*)', async (req, res) => {
    try {
      const { route } = req.params;
      const { timeoutMs, userId } = req.body;
      
      await manager.updateTimeout(decodeURIComponent(route), timeoutMs, userId || 'admin');
      
      res.json({
        success: true,
        message: '超时策略已更新',
        route: decodeURIComponent(route),
        newTimeout: timeoutMs
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: { code: 1400, message: error.message }
      });
    }
  });
  
  // 删除超时策略
  router.delete('/timeout-policies/:route(*)', async (req, res) => {
    try {
      const { route } = req.params;
      const deleted = await manager.deletePolicy(decodeURIComponent(route));
      
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: { code: 1404, message: '策略不存在' }
        });
      }
      
      res.json({
        success: true,
        message: '超时策略已删除'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 1500, message: error.message }
      });
    }
  });
  
  // 热更新重新加载
  router.post('/timeout-policies/reload', async (req, res) => {
    try {
      await manager.reload();
      
      res.json({
        success: true,
        message: '超时策略已重新加载',
        stats: manager.getStats()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: { code: 1500, message: error.message }
      });
    }
  });
  
  return router;
}

module.exports = {
  timeoutMiddleware,
  createTimeoutAdminRoutes
};