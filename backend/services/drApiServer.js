// backend/services/drApiServer.js
// 灾备管理 API 服务
'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const logger = require('../shared/logger')('dr-api-server');
const { router: drRoutes, initialize: initDrRoutes } = require('../shared/routes/drRoutes');
const { DisasterRecoveryEngine } = require('../shared/disasterRecovery');

// 创建 Express 应用
const app = express();

// 中间件
app.use(helmet());
app.use(cors({
  origin: process.env.ADMIN_DASHBOARD_ORIGIN || '*',
  credentials: true
}));
app.use(compression());
app.use(express.json());

// 请求日志
app.use((req, res, next) => {
  logger.info({
    method: req.method,
    path: req.path,
    ip: req.ip
  }, 'API 请求');
  next();
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'dr-api-server' });
});

app.get('/ready', async (req, res) => {
  try {
    // 检查灾备引擎是否就绪
    const engine = app.get('drEngine');
    if (!engine) {
      return res.status(503).json({ ready: false, reason: '灾备引擎未初始化' });
    }
    
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({ ready: false, reason: error.message });
  }
});

// 灾备管理路由
app.use('/api/admin/dr', drRoutes);

// 静态文件服务（灾备管理界面）
const path = require('path');
app.use('/dr-dashboard', express.static(
  path.join(__dirname, '../../frontend/admin-dashboard/disaster-recovery.html')
));

// 错误处理
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path
  }, 'API 错误');
  
  res.status(err.status || 500).json({
    error: err.message || '内部服务器错误',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// 404 处理
app.use((req, res) => {
  res.status(404).json({ error: '资源不存在' });
});

/**
 * 启动服务
 */
async function start(port = 3002) {
  try {
    logger.info('启动灾备 API 服务...');
    
    // 创建灾备引擎
    const drEngine = new DisasterRecoveryEngine({
      primaryRegion: process.env.PRIMARY_REGION || 'beijing',
      standbyRegion: process.env.STANDBY_REGION || 'shanghai',
      rtoTarget: parseInt(process.env.RTO_TARGET_MS) || 300000,
      rpoTarget: parseInt(process.env.RPO_TARGET_MS) || 60000,
      healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 10000,
      failureThreshold: parseInt(process.env.FAILURE_THRESHOLD) || 3,
      recoveryThreshold: parseInt(process.env.RECOVERY_THRESHOLD) || 5,
      
      // 回调函数
      onFailoverStart: async (data) => {
        logger.critical('故障切换开始', data);
        await sendEmergencyAlert('failover_start', data);
      },
      
      onFailoverComplete: async (data) => {
        logger.info('故障切换完成', data);
        await sendEmergencyAlert('failover_complete', data);
      },
      
      onFailoverFailed: async (data) => {
        logger.critical('故障切换失败', data);
        await sendEmergencyAlert('failover_failed', data);
      }
    });
    
    // 启动灾备引擎
    await drEngine.start();
    
    // 保存到 app
    app.set('drEngine', drEngine);
    
    // 初始化路由
    initDrRoutes(drEngine);
    
    // 启动 HTTP 服务
    const server = app.listen(port, () => {
      logger.info({ port }, '灾备 API 服务已启动');
    });
    
    // 优雅关闭
    const shutdown = async () => {
      logger.info('开始优雅关闭...');
      
      server.close(async () => {
        logger.info('HTTP 服务已关闭');
        
        try {
          await drEngine.stop();
          logger.info('灾备引擎已停止');
        } catch (error) {
          logger.error({ error: error.message }, '停止灾备引擎失败');
        }
        
        process.exit(0);
      });
      
      // 强制关闭超时
      setTimeout(() => {
        logger.warn('强制关闭超时，退出');
        process.exit(1);
      }, 10000);
    };
    
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    
    return { app, server, drEngine };
    
  } catch (error) {
    logger.critical({ error: error.message }, '启动灾备 API 服务失败');
    throw error;
  }
}

/**
 * 发送紧急告警
 */
async function sendEmergencyAlert(event, data) {
  logger.info({ event, data }, '发送紧急告警');
  
  try {
    const webhookUrl = process.env.DR_ALERT_WEBHOOK;
    
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          data,
          timestamp: new Date().toISOString(),
          severity: 'critical'
        })
      });
    }
  } catch (error) {
    logger.error({ error: error.message }, '发送紧急告警失败');
  }
}

// 导出
module.exports = { app, start };

// 如果直接运行
if (require.main === module) {
  const port = parseInt(process.env.PORT) || 3002;
  start(port).catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}