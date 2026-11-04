'use strict';

// REQ-00638: canonical factor state; public HTTP authorization is a separate boundary.
const crypto = require('node:crypto');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const {
  providerFromEnvironment
} = require('../audit/KeyProviders');
const {
  seal,
  open,
  fail
} = require('../audit/cryptoPrimitives');
const {
  auditLog
} = require('../auditLog');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function subject(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('MFA_SUBJECT_INVALID', 400);
  return value.toLowerCase();
}
function scope(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw fail('MFA_SCOPE_INVALID', 400);
  return value;
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function binding(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw fail('MFA_BINDING_INVALID', 400);
  return value;
}
function recoveryCodes() {
  const codes = new Set();
  while (codes.size < 8) {
    const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.add(hex.slice(0, 4) + '-' + hex.slice(4));
  }
  return [...codes];
}
function counterFor(secret, code, epoch) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) throw fail('MFA_SECRET_INVALID');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  if (!Number.isFinite(epoch) || epoch < 0) throw fail('MFA_CLOCK_INVALID');
  const base = Math.floor(epoch / 30);
  let matched = null;
  for (let offset = -2; offset <= 2; offset++) {
    const counter = base + offset;
    if (counter < 0) continue;
    const expected = speakeasy.hotp({
      secret,
      encoding: 'base32',
      counter,
      digits: 6,
      algorithm: 'sha1'
    });
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) matched = counter;
  }
  return matched;
}
class MFAStore {
  constructor({
    pool,
    provider,
    env = process.env,
    namespace = env.MFA_KEY_NAMESPACE,
    registry,
    timeout = 10000
  } = {}) {
    if (!Number.isInteger(timeout) || timeout < 50 || timeout > 30000) throw fail('MFA_TIMEOUT_INVALID', 400);
    this.timeout = timeout;
    this.pool = pool || null;
    this.provider = provider || null;
    this.ownsProvider = !provider;
    this.env = env;
    this.namespaceInput = namespace ?? '';
    this.namespace = null;
    this.closed = false;
    this.operations = new Set();
    this.closePromise = null;
    if (typeof this.namespaceInput !== 'string' || this.namespaceInput.length > 100 || env.NODE_ENV === 'production' && !this.namespaceInput) throw fail('MFA_KEY_CONFIGURATION');
    const prom = require('prom-client');
    registry = registry || require('../metrics').register;
    const metric = (Type, name, help, labelNames = []) => {
      const existing = registry.getSingleMetric(name);
      if (existing) {
        if (existing.help !== help || !(existing instanceof Type) || JSON.stringify(existing.labelNames)!==JSON.stringify(labelNames)) throw fail('MFA_METRICS_CONFLICT');
        return existing;
      }
      return new Type({
        name,
        help,
        labelNames,
        registers: [registry]
      });
    };
    this.metrics = {
      setup: metric(prom.Counter, 'mfa_setup_total', 'MFA setup outcomes', ['status']),
      verify: metric(prom.Counter, 'mfa_verification_total', 'MFA factor verification outcomes', ['type', 'status']),
      recovery: metric(prom.Counter, 'mfa_recovery_codes_used_total', 'Single-use recovery codes consumed'),
      enabled: metric(prom.Gauge, 'mfa_enabled_users_gauge', 'Actual enabled canonical MFA profiles')
    };
  }
  keyProvider() {
    if(this.closed&&this.operations.size===0)throw fail('MFA_STORE_CLOSED');
    if (!this.provider) {
      const e = this.env;
      this.provider = providerFromEnvironment({
        NODE_ENV: e.NODE_ENV,
        AWS_REGION: e.AWS_REGION,
        AUDIT_KMS_KEY_ID: e.MFA_KMS_KEY_ID,
        AUDIT_KMS_DECRYPT_KEY_IDS: e.MFA_KMS_DECRYPT_KEY_IDS,
        AUDIT_MASTER_KEYS_JSON: e.MFA_MASTER_KEYS_JSON,
        AUDIT_MASTER_KEY_ID: e.MFA_MASTER_KEY_ID,
        MASTER_ENCRYPTION_KEY: e.MFA_MASTER_ENCRYPTION_KEY
      });
    }
    if (this.env.NODE_ENV === 'production' && this.provider.kind !== 'aws-kms') throw fail('MFA_KEY_CONFIGURATION');
    return this.provider;
  }
  async initialize(client) {
    if (this.closed) throw fail('MFA_STORE_CLOSED');
    if (this.namespace) return;
    const identity = (await client.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0];
    for (const name of ['users', 'user_mfa', 'mfa_recovery_codes', 'mfa_verification_logs', 'mfa_security_state', 'mfa_auth_proofs']) {
      const found = (await client.query('SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)', [name])).rows[0];
      if (found?.nspname !== identity.schema) throw fail('MFA_SCHEMA_MISMATCH');
    }
    await client.query('SELECT credential_epoch,last_totp_counter,failed_attempts,locked_until FROM mfa_security_state LIMIT 0');
    this.namespace = digest(JSON.stringify([this.namespaceInput, identity.database, identity.schema]));
  }
  async transaction(work) {
    if (this.closed) throw fail('MFA_STORE_CLOSED');
    this.pool = this.pool || require('../db').getPool();
    const operation = require('../TransactionManager').getManager(this.pool).execute(async client => {
      await this.initialize(client);
      const result = await work(client);
      const count = Number((await client.query('SELECT count(*) AS n FROM user_mfa WHERE is_enabled=TRUE')).rows[0].n);
      if (!Number.isSafeInteger(count) || count < 0) throw fail('MFA_COUNT_INVALID');
      return {
        result,
        count
      };
    }, {
      timeout: this.timeout,
      maxRetries: 0,
      retryOnDeadlock: false,
      transactionName: 'mfa'
    });
    this.operations.add(operation);
    try {
      const completed = await operation;
      this.metrics.enabled.set(completed.count);
      return completed.result;
    } finally {
      this.operations.delete(operation);
    }
  }
  context(userId, epoch) {
    return {
      purpose: 'minego-mfa-v1',
      namespace: this.namespace,
      subject: digest(userId),
      epoch
    };
  }
  async encryptSecret(secret, userId, epoch) {
    const provider = this.keyProvider(),
      generated = await provider.generate(this.context(userId, epoch));
    const bytes = Buffer.from(secret);
    try {
      return {
        v: 1,
        epoch,
        wrapped: generated.wrapped,
        ...seal(bytes, generated.key, {
          ...this.context(userId, epoch),
          kind: 'totp-secret'
        })
      };
    } finally {
      bytes.fill(0);
      generated.key.fill(0);
    }
  }
  async decryptSecret(profile, state) {
    let envelope;
    try {
      envelope = JSON.parse(profile.secret_encrypted);
    } catch {
      throw fail('MFA_LEGACY_PROFILE_REVIEW');
    }
    if (envelope?.v !== 1 || envelope.epoch !== state.credential_epoch || envelope.iv !== profile.secret_iv) throw fail('MFA_SECRET_INVALID');
    const key = await this.keyProvider().unwrap(envelope.wrapped, this.context(profile.user_id, envelope.epoch));
    try {
      const bytes = open(envelope, key, {
        ...this.context(profile.user_id, envelope.epoch),
        kind: 'totp-secret'
      });
      try {
        return bytes.toString('utf8');
      } finally {
        bytes.fill(0);
      }
    } finally {
      key.fill(0);
    }
  }
  async locked(client, userId) {
    // NO KEY UPDATE serializes enrollment but permits the audit FK's KEY SHARE.
    const owner = (await client.query('SELECT id,nickname,is_banned FROM users WHERE id=$1 FOR NO KEY UPDATE', [subject(userId)])).rows[0];
    if (!owner) throw fail('MFA_SUBJECT_NOT_FOUND', 404);
    if (owner.is_banned) throw fail('MFA_SUBJECT_BLOCKED', 403);
    const profile = (await client.query('SELECT * FROM user_mfa WHERE user_id=$1 FOR UPDATE', [owner.id])).rows[0];
    const state = (await client.query('SELECT *,extract(epoch FROM clock_timestamp())::double precision AS clock,locked_until>clock_timestamp() AS locked FROM mfa_security_state WHERE user_id=$1 FOR UPDATE', [owner.id])).rows[0];
    return {
      owner,
      profile,
      state
    };
  }
  async audit(client, userId, action, context = {}, details = {}) {
    if (!(await auditLog({
      userId,
      action,
      details,
      req: context.req,
      service: 'user-service',
      transactionClient: client
    }))) throw fail('MFA_AUDIT_UNAVAILABLE');
  }
  async replaceRecovery(client, userId) {
    const codes = recoveryCodes();
    await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [userId]);
    for (const code of codes) await client.query('INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES($1,$2)', [userId, digest(code)]);
    return codes;
  }
  async setup(userId, context = {}) {
    const result = await this.transaction(async client => {
      const {
        owner,
        profile,
        state
      } = await this.locked(client, userId);
      if(state?.locked)throw fail('MFA_LOCKED',429);
      if(profile&&!state)throw fail('MFA_LEGACY_PROFILE_REVIEW');
      if (profile?.is_enabled) throw fail('MFA_ALREADY_ENABLED', 409);
      const epoch = crypto.randomUUID(),
        generated = speakeasy.generateSecret({
          length: 20,
          name: 'mineGo:' + owner.nickname,
          issuer: 'mineGo'
        });
      const otpUrl = new URL(generated.otpauth_url);
      otpUrl.searchParams.set('issuer', 'mineGo');
      otpUrl.searchParams.set('algorithm', 'SHA1');
      otpUrl.searchParams.set('digits', '6');
      otpUrl.searchParams.set('period', '30');
      generated.otpauth_url = otpUrl.toString();
      const envelope = await this.encryptSecret(generated.base32, owner.id, epoch);
      const qrCodeDataUrl = await QRCode.toDataURL(generated.otpauth_url, {
        width: 300,
        margin: 2
      });
      await client.query('INSERT INTO user_mfa(user_id,secret_encrypted,secret_iv) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=EXCLUDED.secret_encrypted,secret_iv=EXCLUDED.secret_iv,is_enabled=FALSE,verified_at=NULL,failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp() AT TIME ZONE \'UTC\'', [owner.id, JSON.stringify(envelope), envelope.iv]);
      await client.query('INSERT INTO mfa_security_state(user_id,credential_epoch) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET credential_epoch=EXCLUDED.credential_epoch,last_totp_counter=NULL,failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp()', [owner.id, epoch]);
      const codes = await this.replaceRecovery(client, owner.id);
      await client.query('DELETE FROM mfa_trusted_devices WHERE user_id=$1', [owner.id]);
      await this.audit(client, owner.id, 'mfa_setup', context);
      return {
        secret: generated.base32,
        otpauthUrl: generated.otpauth_url,
        qrCodeDataUrl,
        recoveryCodes: codes
      };
    });
    this.metrics.setup.inc({
      status: 'initiated'
    });
    return result;
  }
  async factor(client, record, code, {
    pending = false
  } = {}) {
    const {
      profile,
      state,
      owner
    } = record;
    if (!profile || !pending && !profile.is_enabled) return {
      ok: false,
      error: 'MFA_NOT_ENABLED',
      status: 403
    };
    if (!state) throw fail('MFA_LEGACY_PROFILE_REVIEW');
    if (state.locked) return {
      ok: false,
      error: 'MFA_LOCKED',
      status: 429
    };
    let type = 'totp',
      valid = false,
      counter = null;
    if (!pending && typeof code === 'string' && /^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/.test(code)) {
      type = 'recovery';
      const rows = (await client.query('SELECT id FROM mfa_recovery_codes WHERE user_id=$1 AND code_hash=$2 AND is_used=FALSE FOR UPDATE', [owner.id, digest(code.toUpperCase())])).rows;
      if (rows.length > 1) throw fail('MFA_RECOVERY_CONFLICT');
      if (rows.length === 1) {
        await client.query('UPDATE mfa_recovery_codes SET is_used=TRUE,used_at=clock_timestamp() AT TIME ZONE \'UTC\' WHERE id=$1', [rows[0].id]);
        valid = true;
      }
    } else if (typeof code === 'string' && /^\d{6}$/.test(code)) {
      counter = counterFor(await this.decryptSecret(profile, state), code, state.clock);
      valid = counter !== null && (state.last_totp_counter === null || BigInt(counter) > BigInt(state.last_totp_counter));
    }
    if (!valid) {
      await client.query("UPDATE mfa_security_state SET failed_attempts=CASE WHEN locked_until IS NOT NULL AND locked_until<=clock_timestamp() THEN 1 ELSE failed_attempts+1 END,locked_until=CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until<=clock_timestamp() THEN 1 ELSE failed_attempts+1 END)>=5 THEN clock_timestamp()+INTERVAL '15 minutes' ELSE NULL END,updated_at=clock_timestamp() WHERE user_id=$1", [owner.id]);
    } else await client.query('UPDATE mfa_security_state SET failed_attempts=0,locked_until=NULL,last_totp_counter=COALESCE($2,last_totp_counter),updated_at=clock_timestamp() WHERE user_id=$1', [owner.id, counter]);
    await client.query('INSERT INTO mfa_verification_logs(user_id,mfa_type,success,failure_reason,ip_address,user_agent,created_at) VALUES($1,$2,$3,$4,NULL,NULL,clock_timestamp() AT TIME ZONE \'UTC\')', [owner.id, type, valid, valid ? null : 'invalid-or-replayed']);
    return {
      ok: valid,
      type,
      error: valid ? null : 'MFA_INVALID_FACTOR',
      status: 401
    };
  }
  outcome(result) {
    if (!result.ok) throw fail(result.error, result.status);
    return result;
  }
  async enable(userId, code, context = {}) {
    const result = await this.transaction(async client => {
      const record = await this.locked(client, userId);
      if (record.profile?.is_enabled) throw fail('MFA_ALREADY_ENABLED', 409);
      if (record.profile?.verified_at) throw fail('MFA_SETUP_REQUIRED', 409);
      const outcome = await this.factor(client, record, code, {
        pending: true
      });
      await this.audit(client, record.owner.id, outcome.ok ? 'mfa_enabled' : 'mfa_enable_denied', context, {
        factor: outcome.type
      });
      if (outcome.ok) await client.query("UPDATE user_mfa SET is_enabled=TRUE,verified_at=clock_timestamp() AT TIME ZONE 'UTC',backup_codes_generated_at=clock_timestamp() AT TIME ZONE 'UTC',updated_at=clock_timestamp() AT TIME ZONE 'UTC' WHERE user_id=$1", [record.owner.id]);
      return outcome;
    });
    this.metrics.setup.inc({
      status: result.ok ? 'success' : 'failed'
    });
    return this.outcome(result);
  }
  async issueProof(client, record, proofScope, subjectBinding) {
    scope(proofScope);
    binding(subjectBinding);
    const token = crypto.randomBytes(32).toString('base64url');
    const row = (await client.query("INSERT INTO mfa_auth_proofs(proof_hash,user_id,credential_epoch,proof_kind,scope,subject_binding,created_at,expires_at) VALUES($1,$2,$3,'step-up',$4,$5,statement_timestamp(),statement_timestamp()+INTERVAL '5 minutes') RETURNING expires_at", [digest(token), record.owner.id, record.state.credential_epoch, proofScope, subjectBinding])).rows[0];
    return {
      token,
      expiresAt: row.expires_at
    };
  }
  async verify(userId, code, {
    scope: proofScope = 'sensitive',
    binding: subjectBinding,
    ...context
  } = {}) {
    scope(proofScope);
    binding(subjectBinding);
    const result = await this.transaction(async client => {
      const record = await this.locked(client, userId),
        outcome = await this.factor(client, record, code);
      await this.audit(client, record.owner.id, outcome.ok ? 'mfa_verified' : 'mfa_denied', context, {
        factor: outcome.type,
        scope: proofScope
      });
      return outcome.ok ? {
        ...outcome,
        ...(await this.issueProof(client, record, proofScope, subjectBinding))
      } : outcome;
    });
    if (result.type) this.metrics.verify.inc({
      type: result.type,
      status: result.ok ? 'success' : 'failed'
    });
    if (result.ok && result.type === 'recovery') this.metrics.recovery.inc();
    return this.outcome(result);
  }
  async change(userId, code, context, regenerate) {
    const result = await this.transaction(async client => {
      const record = await this.locked(client, userId);
      const outcome = await this.factor(client, record, code);
      if (!outcome.ok) {
        await this.audit(client, record.owner.id, 'mfa_change_denied', context, {
          factor: outcome.type
        });
        return outcome;
      }
      const epoch = crypto.randomUUID();
      let codes;
      if (regenerate) {
        const secret = await this.decryptSecret(record.profile, record.state);
        const envelope = await this.encryptSecret(secret, record.owner.id, epoch);
        await client.query("UPDATE user_mfa SET secret_encrypted=$2,secret_iv=$3,backup_codes_generated_at=clock_timestamp() AT TIME ZONE 'UTC',updated_at=clock_timestamp() AT TIME ZONE 'UTC' WHERE user_id=$1", [record.owner.id, JSON.stringify(envelope), envelope.iv]);
        codes = await this.replaceRecovery(client, record.owner.id);
      } else {
        await client.query("UPDATE user_mfa SET is_enabled=FALSE,updated_at=clock_timestamp() AT TIME ZONE 'UTC' WHERE user_id=$1", [record.owner.id]);
        await client.query('DELETE FROM mfa_recovery_codes WHERE user_id=$1', [record.owner.id]);
      }
      await client.query('UPDATE mfa_security_state SET credential_epoch=$2,failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp() WHERE user_id=$1', [record.owner.id, epoch]);
      await client.query('DELETE FROM mfa_trusted_devices WHERE user_id=$1', [record.owner.id]);
      await this.audit(client, record.owner.id, regenerate ? 'mfa_recovery_regenerated' : 'mfa_disabled', context, {
        factor: outcome.type
      });
      return {
        ...outcome,
        recoveryCodes: codes
      };
    });
    return this.outcome(result);
  }
  async disable(userId, code, context = {}) {
    return this.change(userId, code, context, false);
  }
  async regenerate(userId, code, context = {}) {
    return this.change(userId, code, context, true);
  }
  async beginLogin(userId) {
    return this.transaction(async client => {
      const record = await this.locked(client, userId);
      if (!record.profile?.is_enabled) return {
        required: false,
        credentialEpoch: record.state?.credential_epoch ?? null
      };
      if (!record.state) throw fail('MFA_LEGACY_PROFILE_REVIEW');
      const token = crypto.randomBytes(32).toString('base64url');
      const row = (await client.query("INSERT INTO mfa_auth_proofs(proof_hash,user_id,credential_epoch,proof_kind,scope,subject_binding,created_at,expires_at) VALUES($1,$2,$3,'login','login','',statement_timestamp(),statement_timestamp()+INTERVAL '5 minutes') RETURNING expires_at", [digest(token), record.owner.id, record.state.credential_epoch])).rows[0];
      return {
        required: true,
        challenge: token,
        expiresAt: row.expires_at
      };
    });
  }
  async completeLogin(token, code, context = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw fail('MFA_CHALLENGE_INVALID', 401);
    const result = await this.transaction(async client => {
      const proof = (await client.query("SELECT *,expires_at>clock_timestamp() AS valid FROM mfa_auth_proofs WHERE proof_hash=$1 AND proof_kind='login' FOR UPDATE", [digest(token)])).rows[0];
      if (!proof || !proof.valid || proof.consumed_at) throw fail('MFA_CHALLENGE_INVALID', 401);
      const record = await this.locked(client, proof.user_id);
      if (record.state?.credential_epoch !== proof.credential_epoch) throw fail('MFA_CHALLENGE_INVALID', 401);
      const outcome = await this.factor(client, record, code);
      await this.audit(client, record.owner.id, outcome.ok ? 'mfa_login_verified' : 'mfa_login_denied', context, {
        factor: outcome.type
      });
      if (!outcome.ok) return outcome;
      await client.query("UPDATE users SET last_login_at=clock_timestamp() AT TIME ZONE 'UTC' WHERE id=$1", [record.owner.id]);
      await client.query('UPDATE mfa_auth_proofs SET consumed_at=clock_timestamp() WHERE proof_hash=$1', [proof.proof_hash]);
      const user = (await client.query('SELECT id,nickname,level,team FROM users WHERE id=$1', [record.owner.id])).rows[0];
      return {
        ...outcome,
        user,
        credentialEpoch: record.state.credential_epoch
      };
    });
    if (result.type) this.metrics.verify.inc({
      type: result.type,
      status: result.ok ? 'success' : 'failed'
    });
    if (result.ok && result.type === 'recovery') this.metrics.recovery.inc();
    return this.outcome(result);
  }
  async verifyProof(userId, token, {
    scope: proofScope = 'sensitive',
    binding: subjectBinding,
    maxAge = 300
  } = {}) {
    if (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 300) throw fail('MFA_PROOF_AGE_INVALID', 400);
    subject(userId);
    scope(proofScope);
    binding(subjectBinding);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return false;
    return this.transaction(async client => (await client.query("SELECT 1 FROM mfa_auth_proofs p JOIN mfa_security_state s ON s.user_id=p.user_id AND s.credential_epoch=p.credential_epoch JOIN user_mfa m ON m.user_id=s.user_id JOIN users u ON u.id=s.user_id WHERE p.proof_hash=$1 AND p.user_id=$2 AND p.proof_kind='step-up' AND p.scope=$3 AND p.subject_binding=$4 AND p.consumed_at IS NULL AND p.expires_at>clock_timestamp() AND p.created_at<=clock_timestamp() AND p.created_at>=clock_timestamp()-$5*INTERVAL '1 second' AND m.is_enabled=TRUE AND u.is_banned=FALSE", [digest(token), userId, proofScope, subjectBinding, maxAge])).rowCount === 1);
  }
  async status(userId) {
    return this.transaction(async client => {
      const owner=(await client.query('SELECT id,is_banned FROM users WHERE id=$1',[subject(userId)])).rows[0];
      if(!owner)throw fail('MFA_SUBJECT_NOT_FOUND',404);if(owner.is_banned)throw fail('MFA_SUBJECT_BLOCKED',403);
      const row = (await client.query('SELECT m.is_enabled,m.verified_at::text,m.created_at::text,s.credential_epoch,s.locked_until,COUNT(r.id)::int AS total,COUNT(r.id) FILTER(WHERE NOT r.is_used)::int AS remaining FROM user_mfa m LEFT JOIN mfa_security_state s ON s.user_id=m.user_id LEFT JOIN mfa_recovery_codes r ON r.user_id=m.user_id WHERE m.user_id=$1 GROUP BY m.user_id,m.is_enabled,m.verified_at,m.created_at,s.credential_epoch,s.locked_until', [subject(userId)])).rows[0];
      return row ? {
        enabled: row.is_enabled,
        requiresMigration: !row.credential_epoch,
        credentialEpoch: row.credential_epoch,
        pending: !row.is_enabled && !row.verified_at,
        verifiedAt: row.verified_at,
        createdAt: row.created_at,
        lockedUntil: row.locked_until,
        recoveryCodes: {
          total: row.total,
          remaining: row.remaining
        }
      } : {
        enabled: false
      };
    });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.operations]);
      if (this.ownsProvider && this.provider) await this.provider.close();
    })();
    return this.closePromise;
  }
}
module.exports = {
  MFAStore,
  counterFor,
  recoveryCodes,
  digest
};
