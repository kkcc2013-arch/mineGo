// user-service/src/index.js
'use strict';
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { i18nMiddleware } = require('../../../shared/i18n');

const authRouter  = require('./routes/auth');
const userRouter  = require('./routes/user');
const friendRouter = require('./routes/friend');
const sessionsRouter = require('./routes/sessions');

const logger = createLogger('user-service');
const SERVICE_NAME = 'user-service';

const app  = express();
const PORT = process.env.PORT || 8081;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '1mb' }));

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

// i18n middleware for internationalized error messages
app.use(i18nMiddleware);

// Rate limiting
app.use('/auth', rateLimit({ windowMs: 60_000, max: 20, message: { code: 1007, message: '请求太频繁' } }));
app.use('/users', rateLimit({ windowMs: 60_000, max: 100 }));

// ── Routes ────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'user-service' }));

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Metrics generation failed' });
  }
});

app.use('/auth',   authRouter);
app.use('/users',  userRouter);
app.use('/users',  sessionsRouter); // Session management API
app.use('/friends', friendRouter);

// ── Error Handler ─────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => logger.info({ port: PORT }, 'user-service started'));
module.exports = app;
