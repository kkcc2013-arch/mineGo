// backend/gateway/src/routes/autoscaling.js
// 扩缩容管理 API 路由
'use strict';

const express = require('express');
const router = express.Router();
const { PredictiveScalingEngine } = require('../../shared/predictiveScaling');
const logger = require('../../shared/logger');

const scalingEngine = new PredictiveScalingEngine();

/**
 * GET /api/v1/autoscaling/status
 * 获取预测性扩容引擎状态
 */
router.get('/status', async (req, res) => {
  try {
    const status = scalingEngine.getStatus();
    const serviceConfigs = scalingEngine.getServiceConfigs();
    
    res.json({
      success: true,
      data: {
        engine: status,
        services: Object.keys(serviceConfigs).map(name => ({
          name,
          hpaMin: serviceConfigs[name].hpaMin,
          hpaMax: serviceConfigs[name].hpaMax,
          targetPerPod: serviceConfigs[name].targetPerPod,
          scaleThreshold: serviceConfigs[name].scaleThreshold
        }))
      }
    });
  } catch (error) {
    logger.error('Failed to get autoscaling status', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get autoscaling status'
    });
  }
});

/**
 * GET /api/v1/autoscaling/predictions
 * 获取预测性扩容建议
 */
router.get('/predictions', async (req, res) => {
  try {
    const recommendations = await scalingEngine.generateScalingRecommendations();
    
    res.json({
      success: true,
      data: {
        recommendations,
        count: recommendations.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get scaling predictions', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to generate predictions'
    });
  }
});

/**
 * POST /api/v1/autoscaling/execute
 * 手动执行预测性扩容
 */
router.post('/execute', async (req, res) => {
  try {
    const { autoExecute = false } = req.body;
    const results = await scalingEngine.executePredictiveScaling(autoExecute);
    
    res.json({
      success: true,
      data: {
        results,
        executed: results.filter(r => r.status === 'executed').length,
        pending: results.filter(r => r.status === 'pending_approval').length
      },
      message: `Generated ${results.length} scaling recommendations`
    });
  } catch (error) {
    logger.error('Failed to execute predictive scaling', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to execute scaling'
    });
  }
});

/**
 * GET /api/v1/autoscaling/services/:serviceName/prediction
 * 获取单个服务的预测结果
 */
router.get('/services/:serviceName/prediction', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { predictionWindow } = req.query;
    
    const serviceConfig = scalingEngine.getServiceConfigs()[serviceName];
    if (!serviceConfig) {
      return res.status(404).json({
        success: false,
        error: `Service ${serviceName} not configured for predictive scaling`
      });
    }
    
    const prediction = await scalingEngine.predictFutureLoad(
      serviceName,
      parseInt(predictionWindow) || scalingEngine.config.predictionWindow
    );
    
    if (!prediction) {
      return res.status(503).json({
        success: false,
        error: 'Insufficient data for prediction'
      });
    }
    
    res.json({
      success: true,
      data: prediction
    });
  } catch (error) {
    logger.error('Failed to get service prediction', { 
      service: req.params.serviceName,
      error: error.message 
    });
    res.status(500).json({
      success: false,
      error: 'Failed to generate prediction'
    });
  }
});

/**
 * GET /api/v1/autoscaling/efficiency
 * 获取资源利用效率报告
 */
router.get('/efficiency', async (req, res) => {
  try {
    const { timeRange = '24h' } = req.query;
    
    // 生成效率报告（简化版，生产环境应从 Prometheus 查询真实数据）
    const services = Object.keys(scalingEngine.getServiceConfigs());
    const report = {
      timeRange,
      services: [],
      summary: {
        averageEfficiency: 0,
        overProvisioned: 0,
        underProvisioned: 0,
        optimal: 0
      }
    };
    
    for (const service of services) {
      // 模拟效率数据
      const cpuUtil = 0.5 + Math.random() * 0.4; // 50%-90%
      const memUtil = 0.6 + Math.random() * 0.3; // 60%-90%
      const avgUtil = (cpuUtil + memUtil) / 2;
      
      let efficiency = 'optimal';
      if (avgUtil < 0.6) {
        efficiency = 'over-provisioned';
        report.summary.overProvisioned++;
      } else if (avgUtil > 0.9) {
        efficiency = 'under-provisioned';
        report.summary.underProvisioned++;
      } else {
        report.summary.optimal++;
      }
      
      report.services.push({
        name: service,
        cpuUtilization: (cpuUtil * 100).toFixed(1) + '%',
        memoryUtilization: (memUtil * 100).toFixed(1) + '%',
        efficiency,
        potentialSavings: avgUtil < 0.6 ? ((0.6 - avgUtil) * 100).toFixed(0) + '%' : '0%'
      });
    }
    
    report.summary.averageEfficiency = (
      report.services.reduce((sum, s) => sum + parseFloat(s.cpuUtilization), 0) / services.length
    ).toFixed(1) + '%';
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Failed to generate efficiency report', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to generate report'
    });
  }
});

module.exports = router;