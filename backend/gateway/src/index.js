// gateway/src/index.js  — lightweight API Gateway
'use strict';
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { createProxyMiddleware } = require('http-proxy-middleware');
const swaggerUi    = require('swagger-ui-express');
const YAML         = require('yamljs');
const path         = require('path');
const { verifyAccess } = require('../../shared/auth');
const { createLogger, requestLogger } = require('../../shared/logger');
const metrics = require('../../shared/metrics');
const { authWithBlacklistMiddleware } = require('./middleware/jwtBlacklist');

const logger = createLogger('gateway');
const SERVICE_NAME = 'gateway';

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Service registry ─────────────────────────────────────────
const SERVICES = {
  user:     process.env.USER_SERVICE_URL     || 'http://localhost:8081',
  location: process.env.LOCATION_SERVICE_URL || 'http://localhost:8082',
  pokemon:  process.env.POKEMON_SERVICE_URL  || 'http://localhost:8083',
  catch:    process.env.CATCH_SERVICE_URL    || 'http://localhost:8084',
  gym:      process.env.GYM_SERVICE_URL      || 'http://localhost:8085',
  social:   process.env.SOCIAL_SERVICE_URL   || 'http://localhost:8086',
  reward:   process.env.REWARD_SERVICE_URL   || 'http://localhost:8087',
  payment:  process.env.PAYMENT_SERVICE_URL  || 'http://localhost:8088',
};

// ── Middleware ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Idempotency-Key','X-Request-ID','X-Trace-ID'],
}));

// Global rate limit
app.use(rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 1007, message: '请求过于频繁，请稍后重试' },
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
}));

// Request ID & Trace ID injection
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || uuidv4();
  const spanId = uuidv4();
  req.headers['x-request-id'] = req.headers['x-request-id'] || `gw-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.headers['x-trace-id'] = traceId;
  req.headers['x-span-id'] = spanId;
  res.setHeader('X-Trace-Id', traceId);
  next();
});

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

// ── Health ────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const checks = await Promise.allSettled(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return { name, status: r.ok ? 'up' : 'down' };
    })
  );
  const services = checks.map(r => r.status === 'fulfilled' ? r.value : { name: '?', status: 'down' });
  const allUp = services.every(s => s.status === 'up');
  res.status(allUp ? 200 : 503).json({ gateway: 'ok', services });
});

// ── Metrics ────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Metrics generation failed' });
  }
});

// ── API Documentation (Swagger UI) ─────────────────────────────
try {
  const openapiPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const swaggerDocument = YAML.load(openapiPath);
  
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'mineGo API Documentation',
    customfavIcon: '/favicon.ico',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      syntaxHighlight: {
        activate: true,
        theme: 'monokai'
      }
    }
  }));
  
  logger.info('Swagger UI available at /api-docs');
} catch (err) {
  logger.warn({ err }, 'Swagger UI not available (OpenAPI spec not found)');
}

// ── Auth middleware for protected routes ──────────────────────
// Uses authWithBlacklistMiddleware which includes JWT blacklist check
const authMiddleware = authWithBlacklistMiddleware;

// ── Proxy factory ─────────────────────────────────────────────
function proxy(target, pathRewrite) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite,
    on: {
      error: (err, req, res) => {
        logger.error({ err, reqId: req.headers['x-request-id'], path: req.path }, 'Proxy error');
        if (!res.headersSent) {
          res.status(502).json({ code: 9002, message: '下游服务暂时不可用', data: null });
        }
      },
    },
  });
}

// ── Route table ───────────────────────────────────────────────
// Public (no auth)
app.use('/v1/auth',     proxy(SERVICES.user, { '^/': '/auth/' }));

// Protected
app.use('/v1/users',
  authMiddleware,
  proxy(SERVICES.user, { '^/': '/users/' })
);

app.use('/v1/friends',
  authMiddleware,
  proxy(SERVICES.social, { '^/': '/friends/' })
);

app.use('/v1/trades',
  authMiddleware,
  proxy(SERVICES.social, { '^/': '/trades/' })
);

app.use('/v1/map',
  authMiddleware,
  proxy(SERVICES.location, { '^/': '/map/' })
);

app.use('/v1/location',
  authMiddleware,
  proxy(SERVICES.location, { '^/': '/location/' })
);

app.use('/v1/pokemon',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/pokemon/' })
);

app.use('/v1/pokestops',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/pokestops/' })
);

app.use('/v1/catch',
  authMiddleware,
  rateLimit({ windowMs: 60_000, max: 120 }),
  proxy(SERVICES.catch, { '^/': '/catch/' })
);

app.use('/v1/gyms',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/gyms/' })
);

app.use('/v1/raids',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/raids/' })
);

app.use('/v1/payment',
  authMiddleware,
  proxy(SERVICES.payment, { '^/': '/payment/' })
);

// Payment webhook (no auth — signed by channel)
app.use('/v1/payment/webhook',
  proxy(SERVICES.payment, { '^/': '/payment/webhook/' })
);

// 404 fallback
app.use((req, res) => res.status(404).json({ code: 1005, message: `路由不存在: ${req.method} ${req.path}`, data: null }));

app.listen(PORT, () => logger.info({ port: PORT }, 'API Gateway started'));
module.exports = app;
