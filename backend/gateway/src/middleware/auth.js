// gateway/src/middleware/auth.js - Authentication Middleware
'use strict';

const { verifyAccess, errorResp } = require('../../../shared/auth');
const { getJwtBlacklist } = require('../../../shared/JwtBlacklist');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('gateway:auth');

/**
 * Authentication middleware
 * Verifies JWT token and sets req.user
 */
function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  
  if (!header?.startsWith('Bearer ')) {
    // No token provided - allow anonymous access
    req.user = null;
    return next();
  }
  
  const token = header.slice(7);
  
  try {
    // Verify JWT
    const payload = verifyAccess(token);
    req.user = payload;
    
    // Set user headers for downstream services
    req.headers['x-user-id'] = payload.sub;
    req.headers['x-user-level'] = String(payload.level || 1);
    req.headers['x-user-jti'] = payload.jti || '';
    
    next();
    
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    
    // Log the error
    logger.warn({
      error: err.message,
      expired,
      ip: req.ip,
      path: req.path
    }, 'Token verification failed');
    
    // For optional auth, set user to null and continue
    req.user = null;
    next();
  }
}

/**
 * Require authentication middleware
 * Returns 401 if no valid token is provided
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json(errorResp(1002, '未认证，请先登录'));
  }
  next();
}

/**
 * Authentication middleware with blacklist check
 */
async function authenticateWithBlacklist(req, res, next) {
  const header = req.headers['authorization'];
  
  if (!header?.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  
  const token = header.slice(7);
  
  try {
    const payload = verifyAccess(token);
    req.user = payload;
    
    const jti = payload.jti;
    
    if (jti) {
      const blacklist = getJwtBlacklist();
      const isBlacklisted = await blacklist.isBlacklisted(jti);
      
      if (isBlacklisted) {
        logger.warn({
          jti,
          userId: payload.sub,
          ip: req.ip,
          path: req.path
        }, 'Blacklisted token used');
        
        return res.status(401).json(errorResp(
          1003,
          'Token已失效，请重新登录',
          req.headers['x-trace-id']
        ));
      }
      
      // Update session activity
      blacklist.updateSessionActivity(jti, payload.sub).catch(() => {});
    }
    
    // Set user headers for downstream
    req.headers['x-user-id'] = payload.sub;
    req.headers['x-user-level'] = String(payload.level || 1);
    req.headers['x-user-jti'] = payload.jti || '';
    
    next();
    
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    
    logger.warn({
      error: err.message,
      expired,
      ip: req.ip,
      path: req.path
    }, 'Token verification failed');
    
    return res.status(401).json(errorResp(
      expired ? 1003 : 1002,
      expired ? 'Token已过期' : 'Token无效'
    ));
  }
}

module.exports = {
  authenticate,
  requireAuth,
  authenticateWithBlacklist
};
