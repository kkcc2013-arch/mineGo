// user-service/src/index.js
'use strict';
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('../../shared/auth');

const authRouter  = require('./routes/auth');
const userRouter  = require('./routes/user');
const friendRouter = require('./routes/friend');

const app  = express();
const PORT = process.env.PORT || 8081;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '1mb' }));

// Rate limiting
app.use('/auth', rateLimit({ windowMs: 60_000, max: 20, message: { code: 1007, message: '请求太频繁' } }));
app.use('/users', rateLimit({ windowMs: 60_000, max: 100 }));

// ── Routes ────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'user-service' }));
app.use('/auth',   authRouter);
app.use('/users',  userRouter);
app.use('/friends', friendRouter);

// ── Error Handler ─────────────────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => console.log(`[user-service] listening on :${PORT}`));
module.exports = app;
