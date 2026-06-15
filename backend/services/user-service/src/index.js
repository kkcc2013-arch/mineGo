// user-service/src/index.js - 重构版（使用 ServiceLauncher）
'use strict';

const { ServiceLauncher } = require('../../../shared/ServiceLauncher');
const db = require('../../../shared/db');
const EventBus = require('../../../shared/EventBus');

// REQ-00159: 健康检查与自愈系统
const HealthChecker = require('../../../shared/HealthChecker');
const { createHealthRoutes } = require('../../../shared/healthRoutes');

// Import routes
const authRouter = require('./routes/auth');
const userRouter = require('./routes/user');
const friendRouter = require('./routes/friend');
const sessionsRouter = require('./routes/sessions');
const { router: gdprRouter, initGDPRRoutes } = require('./routes/gdpr');
const notificationsRouter = require('./routes/notifications');
const messageCenterRouter = require('./routes/messageCenter'); // REQ-00120
const mfaRouter = require('./routes/mfa'); // REQ-00057: MFA 路由
const timezoneRouter = require('./routes/timezone');
const ageVerificationRouter = require('./routes/ageVerification'); // REQ-00034
const tutorialRouter = require('./routes/tutorial'); // REQ-00059
const stateRouter = require('./routes/state'); // REQ-00095: 游戏状态持久化
const { router: privacyRouter, initPrivacyRoutes } = require('./routes/privacy'); // REQ-00053: 隐私偏好管理中心
const ipAppealRouter = require('./routes/ipAppeal'); // REQ-00075: IP 封禁申诉路由
const shareRouter = require('./routes/share'); // REQ-00153: 截图分享系统路由
const { router: dataTransferRouter, initDataTransferRoutes } = require('./routes/dataTransferCompliance'); // REQ-00089: 数据跨境传输合规
const { router: dataDeletionRouter, initDataDeletionRoutes } = require('./routes/dataDeletion'); // REQ-00127: 用户数据删除请求管理
const titlesRouter = require('./routes/titles'); // REQ-00106: 称号系统路由
const { initNotificationHandlers } = require('./handlers/notificationHandler');

// Create service launcher
const service = new ServiceLauncher({
  serviceName: 'user-service',
  version: '1.0.0',
  port: 8081,
  
  routes: [
    {
      path: '/auth',
      router: authRouter,
      rateLimit: { windowMs: 60_000, max: 20, message: { code: 1007, message: '请求太频繁' } }
    },
    {
      path: '/users',
      router: userRouter,
      rateLimit: { windowMs: 60_000, max: 100 }
    },
    {
      path: '/users',
      router: sessionsRouter // Session management API
    },
    {
      path: '/friends',
      router: friendRouter
    },
    {
      path: '/notifications',
      router: notificationsRouter
    },
    {
      path: '/notifications', // REQ-00120: 消息中心路由
      router: messageCenterRouter
    },
    {
      path: '/users', // REQ-00057: MFA 路由
      router: mfaRouter
    },
    {
      path: '/users',
      router: timezoneRouter
    },
    {
      path: '/age', // REQ-00034: 年龄验证路由
      router: ageVerificationRouter
    },
    {
      path: '/tutorial', // REQ-00059: 新手引导与教程路由
      router: tutorialRouter
    },
    {
      path: '/users', // REQ-00095: 游戏状态持久化
      router: stateRouter
    },
    {
      path: '/privacy', // REQ-00053: 隐私偏好管理中心
      router: privacyRouter
    },
    {
      path: '/ip-appeal', // REQ-00149: IP 封禁申诉路由
      router: ipAppealRouter,
      rateLimit: { windowMs: 60_000, max: 10, message: { code: 1007, message: '请求太频繁' } }
    },
    {
      path: '/share', // REQ-00153: 截图分享系统路由
      router: shareRouter,
      rateLimit: { windowMs: 60_000, max: 30 }
    },
    {
      path: '/compliance', // REQ-00089: 数据跨境传输合规路由
      router: dataTransferRouter
    },
    {
      path: '/data-deletion', // REQ-00127: 用户数据删除请求管理路由
      router: dataDeletionRouter,
      rateLimit: { windowMs: 60_000, max: 20 }
    },
    {
      path: '/users', // REQ-00106: 称号系统路由
      router: titlesRouter
    }
  ],
  
  // Service initialization
  onReady: async (app) => {
    // REQ-00159: 初始化健康检查系统
    const healthChecker = new HealthChecker({
      serviceName: 'user-service',
      checkInterval: 30000,
      cpuThreshold: 80,
      memoryThreshold: 85
    });
    
    // 注册数据库健康检查
    healthChecker.register('database', async () => {
      const start = Date.now();
      await db.query('SELECT 1');
      const latency = Date.now() - start;
      return { status: 'healthy', latency_ms: latency };
    }, { critical: true });
    
    // 注册资源健康检查
    healthChecker.register('resources', async () => {
      return await healthChecker.checkResources();
    }, { critical: false });
    
    // 启动定期健康检查
    healthChecker.startPeriodicCheck();
    
    // 挂载健康检查路由
    const healthRoutes = createHealthRoutes({
      serviceName: 'user-service',
      version: '1.0.0',
      healthChecker
    });
    app.use(healthRoutes);
    
    // Initialize GDPR routes with db and eventBus
    const eventBus = EventBus.getEventBus();
    initGDPRRoutes(db, eventBus);
    app.use('/gdpr', gdprRouter);
    
    // Initialize privacy preference routes - REQ-00053
    initPrivacyRoutes(db);
    
    // Initialize data transfer compliance routes - REQ-00089
    initDataTransferRoutes(db);
    
    // Initialize data deletion request routes - REQ-00127
    initDataDeletionRoutes(db, eventBus);
    
    // Initialize notification event handlers - REQ-00026
    initNotificationHandlers(eventBus);
    
    // Initialize title service - REQ-00106
    const { TitleService } = require('./titleService');
    await TitleService.initialize();
    console.log('Title service initialized');
    
    console.log('User service ready with health checks enabled');
  }
});

// Start service
service.start().catch(err => {
  console.error('Failed to start user-service:', err);
  process.exit(1);
});

module.exports = service;
