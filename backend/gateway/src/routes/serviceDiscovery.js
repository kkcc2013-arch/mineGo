'use strict';

/**
 * REQ-00508: 服务发现与健康检查管理路由
 */

const express = require('express');
const router = express.Router();

// 假设全局服务发现系统已初始化
let serviceDiscoverySystem = null;

/**
 * 初始化路由
 * @param {Object} system - 服务发现系统实例
 */
function init(system) {
  serviceDiscoverySystem = system;
  return router;
}

/**
 * GET /api/service-discovery/services
 * 获取所有服务状态
 */
router.get('/services', async (req, res) => {
  try {
    if (!serviceDiscoverySystem) {
      return res.status(503).json({ error: 'Service discovery not initialized' });
    }

    const { registry, healthChecker } = serviceDiscoverySystem;
    
    // 获取所有服务
    const services = await registry.getAllServices();
    
    // 获取健康状态
    const healthStatus = healthChecker.getStatus();
    
    // 合并数据
    const result = {};
    for (const [serviceName, instances] of Object.entries(services)) {
      result[serviceName] = instances.map(inst => ({
        ...inst,
        health: healthStatus[inst.id] || { status: 'unknown' }
      }));
    }

    res.json({
      success: true,
      data: result,
      stats: healthChecker.getStats()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/service-discovery/services/:name
 * 获取单个服务详情
 */
router.get('/services/:name', async (req, res) => {
  try {
    const { name } = req.params;
    
    if (!serviceDiscoverySystem) {
      return res.status(503).json({ error: 'Service discovery not initialized' });
    }

    const instances = await serviceDiscoverySystem.registry.discover(name);
    const healthyInstances = serviceDiscoverySystem.healthChecker.getHealthyInstances(name);

    res.json({
      success: true,
      data: {
        name,
        totalInstances: instances.length,
        healthyInstances: healthyInstances.length,
        instances: instances.map(inst => ({
          ...inst,
          health: serviceDiscoverySystem.healthChecker.getStatus(inst.id)
        }))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/service-discovery/register
 * 注册新服务实例
 */
router.post('/register', async (req, res) => {
  try {
    const { name, host, port, protocol, weight, metadata } = req.body;

    if (!name || !host || !port) {
      return res.status(400).json({ error: 'Missing required fields: name, host, port' });
    }

    const instanceId = await serviceDiscoverySystem.registerService({
      name,
      host,
      port,
      protocol: protocol || 'http',
      weight: weight || 100,
      metadata: metadata || {}
    });

    res.json({
      success: true,
      data: { instanceId }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/service-discovery/services/:instanceId
 * 注销服务实例
 */
router.delete('/services/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;
    
    await serviceDiscoverySystem.deregisterService(instanceId);

    res.json({
      success: true,
      message: `Instance ${instanceId} deregistered`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/service-discovery/services/:instanceId/weight
 * 更新实例权重
 */
router.put('/services/:instanceId/weight', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { weight } = req.body;

    if (typeof weight !== 'number' || weight < 0 || weight > 100) {
      return res.status(400).json({ error: 'Invalid weight (0-100)' });
    }

    await serviceDiscoverySystem.registry.updateWeight(instanceId, weight);

    res.json({
      success: true,
      data: { instanceId, weight }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/service-discovery/health
 * 获取健康检查状态
 */
router.get('/health', (req, res) => {
  try {
    const stats = serviceDiscoverySystem.healthChecker.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/service-discovery/health/:instanceId/check
 * 手动触发健康检查
 */
router.post('/health/:instanceId/check', async (req, res) => {
  try {
    const { instanceId } = req.params;
    
    const result = await serviceDiscoverySystem.healthChecker.checkNow(instanceId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/service-discovery/load-balancer/:serviceName
 * 获取负载均衡统计
 */
router.get('/load-balancer/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    
    const stats = await serviceDiscoverySystem.loadBalancer.getLoadStats(serviceName);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = { init, router };