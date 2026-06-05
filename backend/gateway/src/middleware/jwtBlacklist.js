// gateway/src/middleware/jwtBlacklist.js - JWT Blacklist Check Middleware
'use strict';

const { getJwtBlacklist } = require('../../../shared/JwtBlacklist');
const { createLogger } = require('../../../shared/logger');
const { errorResp } = require('../../../shared/auth');

const logger = createLogger('gateway:blacklist');

/**
 * Middleware to check if JWT is blacklisted
 * Must be placed after authMiddleware (requires req.user)
 */
function blacklistCheckMiddleware(req, res, next) {
  // Skip if no user (unauthenticated route)
  if (!req.user) {
    return next();
  }
  
  const jti = req.user.jti;
  
  // Skip if no JTI (legacy token)
  if (!jti) {
    return next();
  }
  
  const blacklist = getJwtBlacklist();
  
  blacklist.isBlacklisted(jti)
    .then(isBlacklisted => {
      if (isBlacklisted) {
        logger.warn({
          jti,
          userId: req.user.sub,
          ip: req.ip,
          path: req.path
        }, 'Blacklisted token used');
        
        return res.status(401).json(errorResp(
          1003,
          'Token已失效，请重新登录',
          req.headers['x-trace-id']
        ));
      }
      
      // Update session activity (async, don't wait)
      blacklist.updateSessionActivity(jti, req.user.sub).catch(() => {});
      
      next();
    })
    .catch(err => {
      logger.error({ err, jti }, 'Blacklist check failed');
      // Fail-open: proceed on error to avoid blocking all requests
      next();
    });
}

/**
 * Extended auth middleware with blacklist check
 * Combines auth verification + blacklist check
 */
function authWithBlacklistMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json(errorResp(1002, '未认证，请先登录'));
  }
  
  const token = header.slice(7);
  
  try {
    // Verify JWT
    const { verifyAccess } = require('../../../shared/auth');
    const payload = verifyAccess(token);
    req.user = payload;
    
    // Set user headers for downstream services
    req.headers['x-user-id'] = payload.sub;
    req.headers['x-user-level'] = String(payload.level || 1);
    req.headers['x-user-jti'] = payload.jti || '';
    
    // Check blacklist
    const jti = payload.jti;
    if (!jti) {
      // Legacy token without JTI, proceed
      return next();
    }
    
    const blacklist = getJwtBlacklist();
    
    blacklist.isBlacklisted(jti)
      .then(isBlacklisted => {
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
        
        // Update session activity (async)
        blacklist.updateSessionActivity(jti, payload.sub).catch(() => {});
        
        next();
      })
      .catch(err => {
        logger.error({ err, jti }, 'Blacklist check failed');
        // Fail-open on error
        next();
      });
    
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json(errorResp(
      expired ? 1003 : 1002,
      expired ? 'Token已过期' : 'Token无效'
    ));
  }
}

module.exports = {
  blacklistCheckMiddleware,
  authWithBlacklistMiddleware
};
