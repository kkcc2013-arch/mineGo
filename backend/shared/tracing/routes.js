/**
 * 采样率管理API路由
 * 
 * REQ-00582: 采样率配置与管理API
 */

'use strict';

const express = require('express');
const { SamplingRateManager } = require('../SamplingRateManager');
const { createLogger } = require('../logging');

const logger = createLogger('sampling-api');

/**
 * 创建采样率管理路由
 */
function createSamplingRoutes(manager) {
  const router = express.Router();

  /**
   * 获取所有服务采样率
   * GET /api/admin/tracing/sampling
   */
  router.get('/sampling', async (req, res) => {
    try {
      const rates = manager.getAllRates();
      
      res.json({
        success: true,
        data: rates
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get sampling rates');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 获取单个服务采样率
   * GET /api/admin/tracing/sampling/:serviceName
   */
  router.get('/sampling/:serviceName', async (req, res) => {
    try {
      const { serviceName } = req.params;
      const rate = manager.getServiceRate(serviceName);
      
      if (!rate) {
        return res.status(404).json({ 
          success: false, 
          error: 'service_not_found' 
        });
      }
      
      res.json({
        success: true,
        data: rate
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get service rate');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 更新服务采样配置
   * POST /api/admin/tracing/sampling/:serviceName
   */
  router.post('/sampling/:serviceName', async (req, res) => {
    try {
      const { serviceName } = req.params;
      const newConfig = req.body;
      
      // 验证配置
      const validationErrors = validateConfig(newConfig);
      if (validationErrors.length > 0) {
        return res.status(400).json({ 
          success: false, 
          errors: validationErrors 
        });
      }
      
      const result = await manager.updateServiceConfig(serviceName, newConfig);
      
      res.json({
        success: true,
        data: result
      });
    } catch (err) {
      logger.error({ err }, 'Failed to update config');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 批量更新采样配置
   * POST /api/admin/tracing/sampling/bulk
   */
  router.post('/sampling/bulk', async (req, res) => {
    try {
      const { configs } = req.body; // [{ serviceName, config }]
      
      if (!Array.isArray(configs)) {
        return res.status(400).json({ 
          success: false, 
          error: 'configs must be an array' 
        });
      }
      
      const results = [];
      
      for (const item of configs) {
        const { serviceName, config } = item;
        const result = await manager.updateServiceConfig(serviceName, config);
        results.push({ serviceName, ...result });
      }
      
      res.json({
        success: true,
        data: results
      });
    } catch (err) {
      logger.error({ err }, 'Failed to bulk update configs');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 获取采样历史趋势
   * GET /api/admin/tracing/sampling/history
   */
  router.get('/sampling/history', async (req, res) => {
    try {
      const { serviceName, hours = 1 } = req.query;
      
      const history = manager.getHistory(serviceName, parseInt(hours));
      
      res.json({
        success: true,
        data: history
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get history');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * 获取采样统计
   * GET /api/admin/tracing/sampling/stats
   */
  router.get('/sampling/stats', async (req, res) => {
    try {
      const stats = {};
      
      for (const [serviceName] of manager.samplers) {
        stats[serviceName] = manager.getServiceRate(serviceName);
      }
      
      res.json({
        success: true,
        data: {
          services: stats,
          summary: {
            totalServices: manager.samplers.size,
            timestamp: Date.now()
          }
        }
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get stats');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

/**
 * 验证配置
 */
function validateConfig(config) {
  const errors = [];
  
  if (config.baseRate !== undefined) {
    if (config.baseRate < 0 || config.baseRate > 1) {
      errors.push('baseRate must be between 0 and 1');
    }
  }
  
  if (config.minRate !== undefined) {
    if (config.minRate < 0 || config.minRate > 1) {
      errors.push('minRate must be between 0 and 1');
    }
  }
  
  if (config.maxRate !== undefined) {
    if (config.maxRate < 0 || config.maxRate > 1) {
      errors.push('maxRate must be between 0 and 1');
    }
  }
  
  if (config.minRate !== undefined && config.maxRate !== undefined) {
    if (config.minRate > config.maxRate) {
      errors.push('minRate cannot be greater than maxRate');
    }
  }
  
  if (config.slowThresholdMs !== undefined) {
    if (config.slowThresholdMs < 0) {
      errors.push('slowThresholdMs must be non-negative');
    }
  }
  
  return errors;
}

module.exports = {
  createSamplingRoutes,
  validateConfig
};