// user-service/src/index.js - 重构版（使用 ServiceLauncher）
'use strict';

const { ServiceLauncher } = require('../../../shared/ServiceLauncher');
const db = require('../../../shared/db');
const EventBus = require('../../../shared/EventBus');

// Import routes
const authRouter = require('./routes/auth');
const userRouter = require('./routes/user');
const friendRouter = require('./routes/friend');
const sessionsRouter = require('./routes/sessions');
const { router: gdprRouter, initGDPRRoutes } = require('./routes/gdpr');
const notificationsRouter = require('./routes/notifications');
const timezoneRouter = require('./routes/timezone');
const ageVerificationRouter = require('./routes/ageVerification'); // REQ-00034
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
      path: '/users',
      router: timezoneRouter
    },
    {
      path: '/age', // REQ-00034: 年龄验证路由
      router: ageVerificationRouter
    }
  ],
  
  // Service initialization
  onReady: async (app) => {
    // Initialize GDPR routes with db and eventBus
    const eventBus = EventBus.getEventBus();
    initGDPRRoutes(db, eventBus);
    app.use('/gdpr', gdprRouter);
    
    // Initialize notification event handlers - REQ-00026
    initNotificationHandlers(eventBus);
    
    console.log('User service ready');
  }
});

// Start service
service.start().catch(err => {
  console.error('Failed to start user-service:', err);
  process.exit(1);
});

module.exports = service;
