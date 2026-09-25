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
const profileRouter = require('./routes/profile'); // REQ-00327/REQ-00387: 玩家资料与资料卡
const deviceManagementRouter = require('./routes/deviceManagement'); // REQ-00250: 设备管理路由
const sessionManagementRouter = require('./routes/sessionManagement'); // REQ-00219: 会话异常检测与自动防护
const languageRouter = require('./routes/language'); // REQ-00393: 动态语言切换无需重新登录
const minorProtectionRouter = require('./routes/minorProtection'); // REQ-00578: 未成年人保护路由
const { initNotificationHandlers } = require('./handlers/notificationHandler');

// Create service launcher
const service = new ServiceLauncher({
  serviceName: 'user-service',
  version: '1.0.0',
  port: Number(process.env.PORT) || 8081,
  
  routes: [
    {
      // REQ-00106 称号、REQ-00327/00387 资料卡：挂在 user.js 之前（user.js 的 GET /users/:id 会吞掉 /users/titles 这类单段路径），
      // 且不计入 /users 的 100 次/分钟限流
      path: '/users',
      router: titlesRouter,
      rateLimit: { windowMs: 60_000, max: 300 }
    },
    {
      path: '/users', // REQ-00327/REQ-00387: 资料卡、统计摘要、收藏家排行（同样挂在 user.js 之前）
      router: profileRouter,
      rateLimit: { windowMs: 60_000, max: 300 }
    },
    {
      path: '/profile-cards', // REQ-00387: 分享卡片（公开资料，无需登录）
      router: profileRouter.publicRouter,
      rateLimit: { windowMs: 60_000, max: 120 }
    },
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
      path: '/notifications', // REQ-00099/00261/00425: 消息中心（优先于旧的推送偏好/设备令牌路由）
      router: messageCenterRouter,
      rateLimit: { windowMs: 60_000, max: 300 }
    },
    {
      path: '/notifications', // 设备令牌注册、推送日志（旧接口）
      router: notificationsRouter
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
      path: '/devices', // REQ-00250: 设备管理路由
      router: deviceManagementRouter
    },
    {
      path: '/sessions', // REQ-00219: 会话异常检测与自动防护路由
      router: sessionManagementRouter
    },
    {
      path: '/users', // REQ-00393: 语言切换路由
      router: languageRouter
    },
    {
      path: '/minor-protection', // REQ-00578: 未成年人保护路由
      router: minorProtectionRouter
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
    // REQ-00044: 冷却期到期的账号删除申请自动清理
    require('./gdpr/accountData').startDeletionScheduler();
    
    // Initialize privacy preference routes - REQ-00053
    initPrivacyRoutes(db);
    
    // Initialize data transfer compliance routes - REQ-00089
    initDataTransferRoutes(db);
    
    // Initialize data deletion request routes - REQ-00127
    initDataDeletionRoutes(db, eventBus);
    
    // Initialize notification event handlers - REQ-00026
    initNotificationHandlers(eventBus);
    
    // REQ-00076/00106/00261: 游戏事件消费者（成就进度、称号、事件消息）；LISTEN 实时 + 10 秒兜底扫描
    require('../../../shared/achievementEngine').startConsumer();

    // REQ-00261/00425: 消息实时推送（/ws/notifications，网关代理升级请求）+ 投递分发（WS / APNs / FCM，未配置时降级站内）
    const realtime = require('../../../shared/notificationRealtime');
    realtime.attach(service.server);
    realtime.startDispatcher();

    // REQ-00106: 限时称号过期自动取消佩戴
    const titles = require('../../../shared/titles');
    setInterval(() => titles.expireTitles().catch(() => {}), 10 * 60 * 1000).unref();
    
    console.log('User service ready with health checks enabled');
  }
});

// Start service
service.start().catch(err => {
  console.error('Failed to start user-service:', err);
  process.exit(1);
});

module.exports = service;
