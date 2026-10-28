'use strict';

const express = require('express');
const {
  ServiceLauncher
} = require('../../../shared/ServiceLauncher');
const db = require('../../../shared/db'),
  redis = require('../../../shared/redis'),
  audit = require('../../../shared/auditLogEncrypted');
const {
  PaymentStore
} = require('./payment/PaymentStore');
const {
  loadSecrets
} = require('./payment/protocol');
const {
  createPaymentRouter
} = require('./routes/payment');
const HealthChecker = require('../../../shared/HealthChecker');
const {
  createHealthRoutes
} = require('../../../shared/healthRoutes');
const {
  getDelayQueue
} = require('../../../shared/DelayQueue');
class PaymentLauncher extends ServiceLauncher {
  createApp(options) {
    const app = express();
    // The signed byte stream must be captured before the shared JSON parser.
    app.use('/payment/webhook', express.raw({
      type: () => true,
      limit: '64kb',
      inflate: false
    }));
    app.use('/payment', express.json({
      limit: '16kb'
    }));
    app.use(super.createApp(options));
    return app;
  }
}
function createPaymentService() {
  const secrets = loadSecrets();
  let store, health, queue, admin;
  const service = new PaymentLauncher({
    serviceName: 'payment-service',
    port: process.env.PORT === undefined ? 8088 : Number(process.env.PORT),
    shutdownTimeout: 15000,
    onInitialize: async app => {
      await db.initializeMigrations();
      store = new PaymentStore();
      await store.ready();
      await redis.getRedis().ping();
      app.use('/payment', createPaymentRouter({
        store,
        secrets
      }));
      // REQ-00131: retain actual public currency and authenticated preference paths.
      app.use(['/currency', '/api/v1/currencies'], require('./routes/currency'));
      queue = getDelayQueue({
        clientId: process.env.PAYMENT_QUEUE_CLIENT_ID || 'payment-service',
        delayTopicPrefix: process.env.PAYMENT_QUEUE_TOPIC_PREFIX || 'delay-queue',
        dlqTopic: (process.env.PAYMENT_QUEUE_TOPIC_PREFIX || 'delay-queue') + '-dlq'
      });
      await require('./handlers/orderTimeoutHandler').initOrderTimeoutHandler();
      admin = queue.kafka.admin();
      await admin.connect();
      health = new HealthChecker({
        serviceName: 'payment-service'
      });
      health.register('database', async () => {
        await db.query('SELECT 1');
        return {
          status: 'healthy'
        };
      }, {
        critical: true
      });
      health.register('redis', async () => {
        await redis.getRedis().ping();
        return {
          status: 'healthy'
        };
      }, {
        critical: true
      });
      health.register('kafka', async () => {
        await admin.listTopics();
        return {
          status: 'healthy'
        };
      }, {
        critical: true
      });
      const healthRoutes = createHealthRoutes({
        serviceName: 'payment-service',
        version: '1.0.0',
        healthChecker: health
      });
      app.use(healthRoutes);
      await health.runAllChecks();
      health.startPeriodicCheck();
    },
    onShutdown: async () => {
      health?.stopPeriodicCheck();
      const transport = await Promise.allSettled([admin?.disconnect(), queue?.disconnect()]);
      const result = [...transport, ...(await Promise.allSettled([audit.closeAuditEncryption(), db.closePools(), redis.closeRedis()]))];
      const failed = result.filter(r => r.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(r => r.reason), 'Payment cleanup failed');
    }
  });
  return service;
}
if (require.main === module) {
  let service;
  try {
    service = createPaymentService();
    service.start().catch(error => {
      service.logger.error({
        code: error.code || 'PAYMENT_STARTUP_FAILED'
      }, 'Payment startup refused');
      process.exitCode = 1;
    });
  } catch {
    process.stderr.write('PAYMENT_STARTUP_REFUSED\n');
    process.exitCode = 1;
  }
}
module.exports = {
  createPaymentService,
  PaymentLauncher
};
