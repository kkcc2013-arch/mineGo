// gateway/src/index.js  — lightweight API Gateway
'use strict';
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { verifyAccess } = require('../../shared/auth');

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
  allowedHeaders: ['Content-Type','Authorization','X-Idempotency-Key','X-Request-ID'],
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

// Request ID injection
app.use((req, _res, next) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || `gw-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  next();
});

// Access logger
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on('finish', () => {
    const dur = Date.now() - start;
    if (dur > 1000) console.warn('[GW] SLOW %s %s %dms %d', req.method, req.path, dur, _res.statusCode);
    else console.log('[GW] %s %s %dms %d', req.method, req.path, dur, _res.statusCode);
  });
  next();
});

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

// ── Auth middleware for protected routes ──────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ code: 1002, message: '未认证，请先登录', data: null });
  }
  try {
    req.user = verifyAccess(header.slice(7));
    req.headers['x-user-id']    = req.user.sub;
    req.headers['x-user-level'] = String(req.user.level || 1);
    next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    res.status(401).json({ code: expired ? 1003 : 1002, message: expired ? 'Token已过期' : 'Token无效', data: null });
  }
}

// ── Proxy factory ─────────────────────────────────────────────
function proxy(target, pathRewrite) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite,
    on: {
      error: (err, req, res) => {
        console.error('[GW] Proxy error:', err.message);
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

app.listen(PORT, () => console.log(`[api-gateway] listening on :${PORT}`));
module.exports = app;
