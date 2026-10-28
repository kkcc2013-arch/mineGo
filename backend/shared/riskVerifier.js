'use strict';

// REQ-00588: server-derived context and canonical, session-scoped MFA proofs.
// REQ-00200's additional password/PIN/SMS/email flows remain separate work.
const crypto = require('node:crypto');
const net = require('node:net');
const {AppError} = require('./auth');
const {sessionBinding} = require('../gateway/src/middleware/mfaRequired');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const SAMPLE = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local counts={}
for i=1,2 do
 redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-60000)
 redis.call('ZADD',KEYS[i],now,ARGV[1])
 redis.call('PEXPIRE',KEYS[i],61000)
 counts[i]=redis.call('ZCARD',KEYS[i])
end
redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now-3600000)
return {now,counts[1],counts[2],redis.call('ZCARD',KEYS[3])}`;
const FAILURE = `
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-3600000)
redis.call('ZADD',KEYS[1],now,ARGV[1])
redis.call('PEXPIRE',KEYS[1],3600001)
return 1`;

class RiskError extends AppError {
  constructor(code, status, details = {}) {
    super(code, code, status);
    this.details = details;
  }
}
function factorsFor({trustedDevice, sameAddress, requests, failures, ageSeconds}) {
  if (typeof trustedDevice !== 'boolean' || typeof sameAddress !== 'boolean' ||
      ![requests, failures, ageSeconds].every(n => Number.isFinite(n) && n >= 0)) {
    throw new RiskError('RISK_CONTEXT_INVALID', 503);
  }
  const factors = {
    device_trust: trustedDevice ? 0 : 30,
    location_risk: sameAddress ? 0 : 25,
    behavior_risk: requests > 120 ? 20 : requests > 60 ? 10 : 0,
    history_risk: Math.min(15, failures * 5),
    session_age: ageSeconds > 43200 ? 10 : ageSeconds > 3600 ? 6 : ageSeconds > 300 ? 3 : 0
  };
  const score = Object.values(factors).reduce((a, b) => a + b, 0);
  return {factors, score, level: score >= 80 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low'};
}
function paymentPolicy(amountFen, largeFen = 10000) {
  if (!Number.isSafeInteger(amountFen) || amountFen < 1 || !Number.isSafeInteger(largeFen) || largeFen < 1) {
    throw new RiskError('RISK_POLICY_INVALID', 503);
  }
  const large = amountFen >= largeFen;
  return {operation: large ? 'payment.purchase.large' : 'payment.purchase.normal', scope: large ? 'large-transaction' : 'payment-purchase', mandatory: large};
}
class RiskVerifier {
  constructor({database, cache, mfa, auditWrite, largeTransactionFen = Number(process.env.PAYMENT_LARGE_TRANSACTION_FEN || 10000)} = {}) {
    paymentPolicy(1, largeTransactionFen);
    this.database = database || require('./db');
    this.cache = cache || require('./redis').getRedis();
    this.mfa = mfa || require('./mfaService');
    this.auditWrite = auditWrite || require('./auditLog').auditLog;
    this.largeTransactionFen = largeTransactionFen;
  }
  async ready() {
    const {rows} = await this.database.query('SELECT current_database() AS database,current_schema() AS schema');
    const identity = rows[0];
    if (!identity?.database || !identity.schema) throw new RiskError('RISK_SCHEMA_INVALID', 503);
    for (const name of ['users', 'user_mfa', 'mfa_security_state']) {
      const relation = (await this.database.query('SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)', [name])).rows[0];
      if (relation?.nspname !== identity.schema) throw new RiskError('RISK_SCHEMA_INVALID', 503);
    }
    await this.database.query('SELECT credential_epoch FROM mfa_security_state LIMIT 0');
    await this.database.query('SELECT is_enabled FROM user_mfa LIMIT 0');
    this.namespace = 'risk:v1:' + digest(JSON.stringify([identity.database, identity.schema])) + ':';
  }
  keys(owner, ip) {
    return {ip: this.namespace + 'ip:' + digest(ip), user: this.namespace + 'user:' + digest(owner), failures: this.namespace + 'failures:' + digest(owner)};
  }
  async session(req) {
    const user = req.user;
    if (!user || !UUID.test(user.sub || '') || !UUID.test(user.jti || '') ||
        !Number.isSafeInteger(user.iat) || !Number.isSafeInteger(user.exp)) {
      throw new RiskError('RISK_SESSION_INVALID', 401);
    }
    if (!this.namespace) await this.ready();
    const raw = await this.cache.hget('sessions:user:' + user.sub, user.jti);
    const revoked = await this.cache.exists('blacklist:token:' + user.jti);
    if (!raw || revoked) throw new RiskError('RISK_SESSION_REVOKED', 401);
    let session;
    try {session = JSON.parse(raw);} catch {throw new RiskError('RISK_SESSION_INVALID', 401);}
    const {rows} = await this.database.query('SELECT u.is_banned,m.is_enabled,s.credential_epoch FROM users u LEFT JOIN user_mfa m ON m.user_id=u.id LEFT JOIN mfa_security_state s ON s.user_id=u.id WHERE u.id=$1', [user.sub]);
    const state = rows[0];
    if (!state || state.is_banned) throw new RiskError('RISK_SUBJECT_BLOCKED', 403);
    if (!session || typeof session !== 'object' || session.jti !== user.jti || session.revokedAt || !Number.isSafeInteger(session.createdAt) ||
        session.expiresAt !== user.exp || Math.abs(session.createdAt - user.iat) > 30 ||
        (session.mfaEpoch ?? null) !== (user.mfa_epoch ?? null) ||
        (state.credential_epoch ?? null) !== (user.mfa_epoch ?? null)) {
      throw new RiskError('RISK_SESSION_CHANGED', 401);
    }
    if (state.is_enabled !== null && !state.credential_epoch) throw new RiskError('RISK_MFA_REVIEW_REQUIRED', 503);
    if (state.is_enabled && session.mfaAuthenticated !== true) throw new RiskError('RISK_SESSION_CHANGED', 401);
    const ip = req.ip?.replace(/^::ffff:/, '');
    if (!net.isIP(ip || '')) throw new RiskError('RISK_CONTEXT_INVALID', 503);
    const agent = req.headers['user-agent'];
    return {owner: user.sub, ip, state, session, user, binding: sessionBinding(req), agent: typeof agent === 'string' && agent.length <= 2048 ? agent : ''};
  }
  async authorize(req, policy) {
    if (!policy || typeof policy.operation !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(policy.scope) || typeof policy.mandatory !== 'boolean') {
      throw new RiskError('RISK_POLICY_INVALID', 503);
    }
    const ctx = req.riskSession || await this.session(req);
    const keys = this.keys(ctx.owner, ctx.ip);
    const traceId = crypto.randomUUID();
    const sample = await this.cache.eval(SAMPLE, 3, keys.ip, keys.user, keys.failures, traceId);
    const [now, ipRequests, userRequests, failures] = sample.map(Number);
    if (ctx.user.iat * 1000 > now || ctx.user.exp * 1000 <= now) throw new RiskError('RISK_SESSION_INVALID', 401);
    const evaluation = factorsFor({
      trustedDevice: Boolean(ctx.state.is_enabled && ctx.session.mfaAuthenticated === true && ctx.user.mfa_epoch && ctx.agent && ctx.session.userAgent === ctx.agent),
      sameAddress: ctx.session.ip === ctx.ip,
      requests: Math.max(ipRequests, userRequests), failures, ageSeconds: now / 1000 - ctx.user.iat
    });
    const required = policy.mandatory || evaluation.score >= 50;
    let decision = 'allow';
    if (evaluation.score >= 80) decision = 'block';
    else if (required && !ctx.state.is_enabled) decision = 'enroll';
    else if (required && !await this.mfa.verifyProof(ctx.owner, req.headers['x-mfa-token'], {scope: policy.scope, binding: ctx.binding, maxAge: 300})) decision = 'verify';
    if (!await this.auditWrite({userId: ctx.owner, action: 'SENSITIVE_OPERATION_EVALUATED', service: 'risk-verifier', resourceType: 'risk-evaluation', resourceId: traceId, db: this.database,
      details: {traceId, operation: policy.operation, scope: policy.scope, ...evaluation, decision, sessionHash: ctx.binding, ipHash: digest(ctx.ip), agentHash: digest(ctx.agent)}})) {
      throw new RiskError('RISK_AUDIT_UNAVAILABLE', 503);
    }
    if (decision !== 'allow') {
      await this.cache.eval(FAILURE, 1, keys.failures, traceId);
      const code = decision === 'block' ? 'RISK_LIMIT_EXCEEDED' : decision === 'enroll' ? 'MFA_ENROLLMENT_REQUIRED' : 'MFA_PROOF_REQUIRED';
      throw new RiskError(code, 403, {traceId, operation: policy.operation, scope: policy.scope, riskLevel: evaluation.level, riskScore: evaluation.score,
        mfaRequired: decision !== 'block', verificationEndpoint: '/v1/users/me/mfa/step-up'});
    }
    req.riskEvaluation = {traceId, operation: policy.operation, ...evaluation};
    return req.riskEvaluation;
  }
  middleware(policyForRequest) {
    return async (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      try {
        if (!req.riskSession) req.riskSession = await this.session(req);
        if (policyForRequest) await this.authorize(req, await policyForRequest(req));
        next();
      } catch (error) {
        if (error instanceof RiskError) return res.status(error.httpStatus).json({success: false, code: error.code, message: error.code, data: error.details});
        if (error instanceof AppError) return next(error);
        // Dependency failure must never authorize a sensitive operation.
        res.status(503).json({success: false, code: 'RISK_UNAVAILABLE', message: 'RISK_UNAVAILABLE'});
      }
    };
  }
}
module.exports = {RiskVerifier, RiskError, factorsFor, paymentPolicy};
