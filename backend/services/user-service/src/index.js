// user-service/src/index.js - 重构版（使用 ServiceLauncher）
'use strict';
const _consoleLogger = new (require("../../../shared/loggingUtils")).ConsoleMigrationHelper(
  require("../../../shared/logger").createLogger("services/user-service/src/index"), "services/user-service/src/index");


const { ServiceLauncher } = require('../../../shared/ServiceLauncher');
const db = require('../../../shared/db');
const redis = require('../../../shared/redis');
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
const deviceManagementRouter = require('./routes/deviceManagement'); // REQ-00250: 设备管理路由
const sessionManagementRouter = require('./routes/sessionManagement'); // REQ-00219: 会话异常检测与自动防护
const languageRouter = require('./routes/language'); // REQ-00393: 动态语言切换无需重新登录
const minorProtectionRouter = require('./routes/minorProtection'); // REQ-00578: 未成年人保护路由
const { initNotificationHandlers } = require('./handlers/notificationHandler');

// Initialize the privacy router before it can receive requests.
initPrivacyRoutes(db);

let healthChecker;
let eventBus;
let ipBanManager;
let notificationWs;

// Create service launcher
const service = new ServiceLauncher({
  serviceName: 'user-service',
  version: '1.0.0',
  port: process.env.PORT === undefined ? 8081 : Number(process.env.PORT),
  
  routes: [
    // These routers own their authentication and expose explicit public paths.
    {
      path: '/users', // REQ-00106: 称号系统路由
      router: titlesRouter
    },
    {
      path: '/users',
      router: timezoneRouter
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
    {path:'/users/me/notification-preferences',router:notificationsRouter.createLegacyPreferenceRouter()},
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
  onInitialize: async (app) => {
    await db.initializeMigrations();
    app.locals.db = db;
    app.set('trust proxy', process.env.USER_SERVICE_TRUST_PROXY ? process.env.USER_SERVICE_TRUST_PROXY.split(',').map(value => value.trim()) : false);
    const IpBanManager = require('../../../shared/IpBanManager');
    ipBanManager = new IpBanManager({ db, redis: redis.getRedis(), autoInitialize: false });
    ipAppealRouter.initIpAppealRoutes(ipBanManager);
    await ipBanManager.init();
    // REQ-00159: 初始化健康检查系统
    healthChecker = new HealthChecker({
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
    
    healthChecker.register('redis', async () => {
      await redis.getRedis().ping();
      return { status: 'healthy' };
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
    eventBus = EventBus.getEventBus({clientId:process.env.EVENT_BUS_CLIENT_ID||'user-service'});
    await eventBus.connect();
    healthChecker.register('kafka', async () => {
      const health = await eventBus.healthCheck();
      if (!health.healthy) throw new Error('Kafka is unavailable');
      return { status: 'healthy' };
    }, { critical: false });
    initGDPRRoutes(db, eventBus);
    app.use('/gdpr', gdprRouter);
    
    // Initialize data transfer compliance routes - REQ-00089
    initDataTransferRoutes(db);
    
    // Initialize data deletion request routes - REQ-00127
    initDataDeletionRoutes(db, eventBus);
    
    // Initialize notification event handlers - REQ-00026
    await initNotificationHandlers(eventBus);
    
    // Initialize title service - REQ-00106
    const { TitleService } = require('./titleService');
    TitleService.eventBus = eventBus;
    await TitleService.initialize();
    _consoleLogger.log('Title service initialized');
    
    await healthChecker.runAllChecks();
    _consoleLogger.log('User service initialized with health checks enabled');
  },
  onReady: async app => {
    const transport=require('../../../shared/NotificationWebSocket');
    const {getUpgradeClientIp}=require('../../../shared/clientIp');
    notificationWs=transport.initNotificationWS(service.server,'/ws/notifications',{authorize:async req=>!(await ipBanManager.isBlocked(getUpgradeClientIp(req,app))).blocked});
    const Plugin=require('../../../shared/notification/plugins/WebSocketPlugin');
    require('../../../shared/notification/NotificationManager').getNotificationManager().registerPlugin(new Plugin(notificationWs,transport));
  },
  onBeforeShutdown: async () => {
    if(notificationWs){for(const client of notificationWs.clients)client.terminate();await new Promise((resolve,reject)=>notificationWs.close(error=>error?reject(error):resolve()));notificationWs=null;}
  },
  onShutdown: async () => {
    healthChecker?.stopPeriodicCheck();
    const results = await Promise.allSettled([
      eventBus ? eventBus.disconnect() : Promise.resolve(),
      ipBanManager ? ipBanManager.close() : Promise.resolve(), db.closePools(), redis.closeRedis()
    ]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'User service cleanup failed');
  }
});

// Start service
service.start().catch(err => {
  _consoleLogger.error('Failed to start user-service:', err);
  process.exit(1);
});

module.exports = service;
