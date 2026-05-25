// shared/auth.js
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || 'pmg-access-secret-change-in-prod';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'pmg-refresh-secret-change-in-prod';
const ACCESS_TTL     = process.env.JWT_ACCESS_TTL  || '24h';
const REFRESH_TTL    = process.env.JWT_REFRESH_TTL || '30d';

function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
}
function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });
}
function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET);
}
function verifyRefresh(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

// Express middleware
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json(errorResp(1002, '未认证，请先登录'));
  }
  try {
    const payload = verifyAccess(header.slice(7));
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json(errorResp(1003, 'Token 已过期，请刷新'));
    }
    return res.status(401).json(errorResp(1002, 'Token 无效'));
  }
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh, requireAuth };

// ----------------------------------------------------------------
// shared/errors.js  (appended to same module for simplicity)
// ----------------------------------------------------------------
class AppError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function errorResp(code, message, traceId) {
  return { code, message, data: null, traceId: traceId || uuidv4() };
}
function successResp(data, message = 'ok') {
  return { code: 0, message, data, traceId: uuidv4() };
}

// Global error handler middleware
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json(errorResp(err.code, err.message));
  }
  console.error('[ERROR]', err);
  res.status(500).json(errorResp(9001, '服务器内部错误'));
}

module.exports = { ...module.exports, AppError, errorResp, successResp, errorHandler };
