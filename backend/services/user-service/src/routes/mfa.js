'use strict';

const express = require('express');
const {
  requireAuth
} = require('../../../../shared/auth');
const mfaService = require('../../../../shared/mfaService');
const {
  mfaRequired,
  sessionBinding,
  SENSITIVE_OPERATIONS
} = require('../../../../gateway/src/middleware/mfaRequired');
const {
  AuditCryptoError
} = require('../../../../shared/audit/cryptoPrimitives');
const SCOPES = new Set(['sensitive', 'mfa-manage', 'audit-read',...Object.values(SENSITIVE_OPERATIONS)]);
function respond(handler) {
  return async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        data: await handler(req)
      });
    } catch (error) {
      const known = error instanceof AuditCryptoError;
      res.status(known ? error.status : 503).json({
        error: known ? error.code : 'MFA_UNAVAILABLE'
      });
    }
  };
}
function factor(req, recoveryOnly = false) {
  const code = req.body?.code;
  if (typeof code !== 'string' || !(recoveryOnly ? /^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/ : /^(?:\d{6}|[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4})$/).test(code)) throw new AuditCryptoError('MFA_FACTOR_INVALID', 400);
  return code;
}
function createMfaRouter(service = mfaService) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAuth);
  router.use(async (req,res,next)=>{
    try{
      if(req.user.jti&&await require('../../../../shared/redis').getRedis().exists('blacklist:token:'+req.user.jti))return res.status(401).json({error:'MFA_SESSION_REVOKED'});
      next();
    }catch{res.status(503).json({error:'MFA_UNAVAILABLE'});}
  });
  const user = req => req.user.sub || req.user.id;
  router.get(['/', '/status'], respond(req => service.status(user(req))));
  router.post('/setup', respond(req => service.setup(user(req), {
    req
  })));
  router.post(['/enable', '/verify'], respond(req => service.enable(user(req), factor(req), {
    req
  })));
  router.post(['/step-up', '/recovery', '/verify-backup-code'], respond(req => {
    const scope = req.body?.scope || 'sensitive';
    if (!SCOPES.has(scope)) throw new AuditCryptoError('MFA_SCOPE_INVALID', 400);
    return service.verify(user(req), factor(req, req.path !== '/step-up'), {
      scope,
      binding: sessionBinding(req),
      req
    }).then(result => ({
      verified: true,
      mfaToken: result.token,
      expiresAt: result.expiresAt
    }));
  }));
  router.post('/disable', respond(req => service.disable(user(req), factor(req), {
    req
  })));
  router.post(['/recovery-codes/regenerate', '/regenerate-backup-codes'], respond(req => service.regenerate(user(req), factor(req), {
    req
  })));
  router.get(['/recovery-codes', '/backup-codes'], mfaRequired({
    service,
    scope: 'mfa-manage'
  }), respond(async req => (await service.status(user(req))).recoveryCodes));
  return router;
}
function createLoginRouter(service = mfaService, {
  issueTokens
} = {}) {
  const router = express.Router();
  router.post(['/verify', '/recovery'], respond(async req => {
    if (req.body?.userId !== undefined) throw new AuditCryptoError('MFA_LOGIN_CHALLENGE_REQUIRED', 400);
    if (req.body?.rememberDevice) throw new AuditCryptoError('MFA_TRUSTED_DEVICE_NOT_READY', 400);
    const result = await service.completeLogin(req.body?.challenge || req.body?.tempToken, factor(req, req.path === '/recovery'), {
      req
    });
    if (typeof issueTokens !== 'function') throw new AuditCryptoError('MFA_TOKEN_ISSUER_UNAVAILABLE');
    return {
      ...(await issueTokens(result.user, {
        ip: req.ip,
        userAgent: req.headers['user-agent']
      }, result.credentialEpoch, {mfaAuthenticated:true})),
      userId: result.user.id
    };
  }));
  router.use(createMfaRouter(service));
  return router;
}
module.exports = createMfaRouter();
module.exports.createMfaRouter = createMfaRouter;
module.exports.createLoginRouter = createLoginRouter;
