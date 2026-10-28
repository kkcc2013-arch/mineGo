'use strict';

const crypto = require('node:crypto');
const {
  requireAuth
} = require('../../../shared/auth');
const mfaService = require('../../../shared/mfaService');
function sessionBinding(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return crypto.createHash('sha256').update(header.slice(7)).digest('hex');
}
function mfaRequired({
  scope = 'sensitive',
  maxAge = 300,
  mandatory = true,
  service = mfaService
} = {}) {
  if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 300) throw new Error('MFA_PROOF_AGE_INVALID');
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    return requireAuth(req, res, error => {
      if (error) return next(error);
      (async () => {
        const userId = req.user.sub || req.user.id;
        if (req.user.jti && (await require('../../../shared/redis').getRedis().exists('blacklist:token:' + req.user.jti))) return res.status(401).json({
          error: 'MFA_SESSION_REVOKED'
        });
        const status = await service.status(userId);
        if (!status.enabled) {
          if (!mandatory) return next();
          return res.status(403).json({
            error: 'MFA_ENROLLMENT_REQUIRED',
            mfaRequired: true
          });
        }
        if (!(await service.verifyProof(userId, req.headers['x-mfa-token'], {
          scope,
          binding: sessionBinding(req),
          maxAge
        }))) return res.status(403).json({
          error: 'MFA_PROOF_REQUIRED',
          mfaRequired: true
        });
        req.mfaVerified = true;
        req.mfaScope = scope;
        next();
      })().catch(() => res.status(503).json({
        error: 'MFA_UNAVAILABLE'
      }));
    });
  };
}
const SENSITIVE_OPERATIONS = Object.freeze({
  CHANGE_PASSWORD: 'change-password',
  BIND_PAYMENT: 'bind-payment',
  UNBIND_PAYMENT: 'unbind-payment',
  LARGE_TRANSACTION: 'large-transaction',
  PAYMENT_PURCHASE: 'payment-purchase',
  DELETE_ACCOUNT: 'delete-account',
  DISABLE_MFA: 'disable-mfa',
  REGENERATE_RECOVERY_CODES: 'regenerate-recovery-codes',
  TRANSFER_POKEMON: 'transfer-pokemon'
});
const sensitiveOperationRequired = operation => mfaRequired({
  scope: operation
});
module.exports = {
  mfaRequired,
  sessionBinding,
  sensitiveOperationRequired,
  SENSITIVE_OPERATIONS
};
