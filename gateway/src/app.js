/**
 * Gateway Service 主入口
 * mineGo API Gateway
 * 
 * @module gateway/src/app
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { logger } = require('../../shared/logger');
const { metricsMiddleware, metricsEndpoint } = require('../../shared/metrics');
const { errorHandler } = require('../../shared/errorHandler');
const { rateLimiter } = require('../../shared/middleware/rateLimiter');

// 路由导入
const securityRoutes = require('./routes/security');
// 其他路由可以在这里导入
// const userRoutes = require('./routes/user');
// const pokemonRoutes = require('./routes/pokemon');

// 创建 Express 应用
const app = express();

// ==================== 中间件配置 ====================

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));

// CORS 配置
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-ID', 'X-User-ID', 'X-Client-Version']
}));

// 压缩响应
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  threshold: 1024
}));

// 请求日志
app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

// Prometheus 指标
app.use(metricsMiddleware);

// 请求体解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==================== 路由配置 ====================

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Prometheus 指标端点
app.get('/metrics', metricsEndpoint);

// API 路由（带速率限制）
const apiRouter = express.Router();

// 应用速率限制到所有 API 路由
apiRouter.use(rateLimiter);

// 注册安全路由
apiRouter.use('/v1/security', securityRoutes);

// 其他路由（示例）
// apiRouter.use('/v1/user', userRoutes);
// apiRouter.use('/v1/pokemon', pokemonRoutes);
// apiRouter.use('/v1/catch', catchRoutes);
// apiRouter.use('/v1/gym', gymRoutes);
// apiRouter.use('/v1/social', socialRoutes);
// apiRouter.use('/v1/reward', rewardRoutes);
// apiRouter.use('/v1/payment', paymentRoutes);

// 挂载 API 路由
app.use('/api', apiRouter);

// ==================== 错误处理 ====================

// 404 处理
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method
  });
});

// 全局错误处理
app.use(errorHandler);

// ==================== 优雅关闭 ====================

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  logger.info('[Gateway] Received shutdown signal, closing connections...');
  
  // 关闭数据库连接
  const { closePool } = require('../../shared/db');
  closePool().then(() => {
    logger.info('[Gateway] Database pool closed');
  }).catch(err => {
    logger.error('[Gateway] Error closing database pool:', err);
  });
  
  // 关闭 Redis 连接
  const redis = require('../../shared/redis');
  if (redis.quit) {
    redis.quit();
  }
  
  logger.info('[Gateway] Graceful shutdown complete');
  process.exit(0);
}

// ==================== 导出 ====================

module.exports = app;

// 如果直接运行此文件，启动服务器
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  
  app.listen(PORT, () => {
    logger.info(`[Gateway] Server running on port ${PORT}`);
    logger.info(`[Gateway] Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}