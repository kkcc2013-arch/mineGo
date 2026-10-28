'use strict';

const crypto = require('node:crypto');
const protocol = require('./protocol');
const db = require('../../../../shared/db');
const redis = require('../../../../shared/redis');
const audit = require('../../../../shared/auditLogEncrypted');
const {
  createLogger
} = require('../../../../shared/logger');
const logger = createLogger('payment-store');
class PaymentStore {
  constructor({
    database = db,
    cache = redis.getRedis(),
    auditWrite = (client, params) => audit.useAuditStore({
      transactionClient: client
    }, store => store.writeEncryptedAuditLog(params))
  } = {}) {
    this.db = database;
    this.cache = cache;
    this.auditWrite = auditWrite;
  }
  transaction(fn) {
    return this.db.transaction(fn, {
      isolationLevel: 'READ COMMITTED',
      transactionName: 'payment-integrity'
    });
  }
  async ready() {
    await this.db.query('SELECT order_id,key_hash,request_hash,expires_at FROM payment_order_requests LIMIT 0');
    await this.db.query('SELECT order_id,channel_transaction_id FROM payment_settlements LIMIT 0');
    await this.db.query('SELECT quantity FROM orders LIMIT 0');
    await this.db.query('SELECT age_bracket,monthly_spend_limit_cents,features_disabled FROM user_age_profiles LIMIT 0');
    await this.db.query('SELECT user_id,year_month,total_cents FROM user_monthly_spend LIMIT 0');
    await audit.useAuditStore({}, store => store.initialize());
  }
  async record(client, action, userId, orderId, details, context = {}) {
    return this.auditWrite(client, {
      userId,
      action,
      resourceType: 'payment-order',
      resourceId: orderId,
      actionData: details,
      service: 'payment-service',
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null
    });
  }
  async create(userId, input, context) {
    const owner = protocol.identity(userId),
      keyHash = protocol.digest(input.key),
      lock = crypto.createHash('sha256').update(owner + ':' + keyHash).digest();
    const result = await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [lock.readInt32BE(0), lock.readInt32BE(4)]);
      const user = (await client.query('SELECT is_banned FROM users WHERE id=$1 FOR UPDATE', [owner])).rows[0];
      if (!user || user.is_banned) throw protocol.fail('PAYMENT_SUBJECT_BLOCKED', 403);
      const previous = (await client.query('SELECT r.*,r.expires_at>clock_timestamp() AS live FROM payment_order_requests r WHERE user_id=$1 AND key_hash=$2 FOR UPDATE', [owner, keyHash])).rows[0];
      if (previous?.live) {
        if (previous.request_hash !== input.requestHash) throw protocol.fail('PAYMENT_IDEMPOTENCY_CONFLICT', 409);
        const order = (await client.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [previous.order_id, owner])).rows[0];
        if (!order) throw protocol.fail('PAYMENT_REQUEST_INCOMPLETE', 503);
        await this.record(client, 'PAYMENT_ORDER_REPLAY', owner, order.id, {
          status: order.status,
          keyHash,
          requestHash: input.requestHash
        }, context);
        return {
          order,
          replayed: true,
          expiresAt: previous.expires_at
        };
      }
      const legacy = (await client.query('SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2', [owner, input.key])).rows[0];
      if (legacy) throw protocol.fail('PAYMENT_LEGACY_REQUEST_REVIEW_REQUIRED', 409);
      await this.spendGuard(client, owner, input.amountFen, false);
      const order = (await client.query("INSERT INTO orders(user_id,idempotency_key,product_id,product_name,amount_fen,premium_coins_grant,payment_channel,quantity,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp() AT TIME ZONE 'UTC') RETURNING *", [owner, crypto.randomUUID(), input.productId, input.name, input.amountFen, input.coinsGrant, input.channel, input.quantity])).rows[0];
      // One clock value preserves the exact absolute24h bound and never extends on replay.
      const request = (await client.query("WITH now AS(SELECT clock_timestamp() AS t) INSERT INTO payment_order_requests(user_id,key_hash,request_hash,order_id,created_at,expires_at) SELECT $1,$2,$3,$4,t,t+INTERVAL '24 hours' FROM now ON CONFLICT(user_id,key_hash) DO UPDATE SET request_hash=EXCLUDED.request_hash,order_id=EXCLUDED.order_id,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at RETURNING expires_at", [owner, keyHash, input.requestHash, order.id])).rows[0];
      await this.record(client, 'PAYMENT_ORDER_CREATED', owner, order.id, {
        productId: order.product_id,
        amountFen: order.amount_fen,
        currency: order.currency,
        quantity: order.quantity,
        keyHash,
        requestHash: input.requestHash,
        expiresAt: request.expires_at
      }, context);
      return {
        order,
        replayed: false,
        expiresAt: request.expires_at
      };
    });
    // Redis is a24h mirror, never the authorization/order source. Its loss cannot
    // duplicate a durable request or turn a committed order into an HTTP failure.
    try {
      const ttl = (await this.db.query('SELECT GREATEST(0,CEIL(EXTRACT(EPOCH FROM expires_at-clock_timestamp())))::int AS ttl FROM payment_order_requests WHERE user_id=$1 AND key_hash=$2', [owner, keyHash])).rows[0]?.ttl;
      if (ttl > 0) await this.cache.set('payment:create:' + owner + ':' + input.key, JSON.stringify({
        orderId: result.order.id,
        status: result.order.status,
        createdAt: result.order.created_at
      }), 'EX', Math.min(ttl, 86400));
    } catch {
      logger.warn({
        code: 'PAYMENT_CACHE_MIRROR_UNAVAILABLE'
      }, 'Payment cache mirror unavailable');
    }
    return result;
  }
  async spendGuard(client, owner, amountFen, commit) {
    const profile = (await client.query('SELECT age_bracket,parent_consent_status,features_disabled,monthly_spend_limit_cents FROM user_age_profiles WHERE user_id=$1 FOR UPDATE', [owner])).rows[0];
    if (profile?.features_disabled?.includes('payment') || profile?.age_bracket === 'under_13' && profile.parent_consent_status !== 'verified') throw protocol.fail('PAYMENT_AGE_RESTRICTED', 403);
    const month = (await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS month")).rows[0].month;
    if (profile && ['under_13', '13_17'].includes(profile.age_bracket)) {
      const spent = (await client.query('SELECT total_cents FROM user_monthly_spend WHERE user_id=$1 AND year_month=$2', [owner, month])).rows[0]?.total_cents ?? '0';
      if (BigInt(spent) + BigInt(amountFen) > BigInt(profile.monthly_spend_limit_cents ?? 0)) throw protocol.fail('PAYMENT_SPEND_LIMIT', 403);
    }
    if (commit) await client.query('INSERT INTO user_monthly_spend(user_id,year_month,total_cents,transaction_count) VALUES($1,$2,$3,1) ON CONFLICT(user_id,year_month) DO UPDATE SET total_cents=user_monthly_spend.total_cents+EXCLUDED.total_cents,transaction_count=user_monthly_spend.transaction_count+1,updated_at=NOW()', [owner, month, amountFen]);
  }
  async list(userId) {
    return (await this.db.query('SELECT id,product_id,product_name,quantity,amount_fen,currency,premium_coins_grant,status,payment_channel,paid_at,created_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 20', [protocol.identity(userId)])).rows;
  }
  async settle({
    orderId,
    userId,
    channel,
    channelOrderId,
    amountFen,
    currency,
    payloadHash,
    verify
  }, context) {
    protocol.identity(orderId);
    if (channel !== undefined) protocol.channel(channel);
    protocol.transactionId(channelOrderId);
    try {
      return await this.transaction(async client => {
        const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
        if (!order || userId && order.user_id !== protocol.identity(userId)) throw protocol.fail('PAYMENT_ORDER_NOT_FOUND', 404);
        if (channel === undefined) channel = protocol.channel(order.payment_channel);
        if (order.payment_channel !== channel || amountFen !== undefined && order.amount_fen !== amountFen || currency !== undefined && order.currency !== currency || verify && !verify(order)) throw protocol.fail('PAYMENT_SIGNATURE_INVALID', 401);
        const prior = (await client.query('SELECT channel,channel_transaction_id FROM payment_settlements WHERE order_id=$1', [order.id])).rows[0];
        if (prior && (prior.channel !== channel || prior.channel_transaction_id !== channelOrderId)) throw protocol.fail('PAYMENT_SETTLEMENT_CONFLICT', 409);
        if (['PAID', 'FULFILLED', 'REFUNDED'].includes(order.status)) {
          await this.record(client, 'PAYMENT_SETTLEMENT_REPLAY', order.user_id, order.id, {
            status: order.status
          }, context);
          return {
            order,
            replayed: true
          };
        }
        if (!protocol.canTransition(order.status, 'PAID')) throw protocol.fail('PAYMENT_STATE_INVALID');
        const user = (await client.query('SELECT is_banned FROM users WHERE id=$1 FOR UPDATE', [order.user_id])).rows[0];
        if (!user || user.is_banned) throw protocol.fail('PAYMENT_SUBJECT_BLOCKED', 403);
        await this.spendGuard(client, order.user_id, order.amount_fen, true);
        await client.query('INSERT INTO payment_settlements(order_id,channel,channel_transaction_id,payload_sha256) VALUES($1,$2,$3,$4)', [order.id, channel, channelOrderId, payloadHash]);
        const updated = (await client.query("UPDATE orders SET status='PAID',channel_order_id=$2,paid_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='PENDING' RETURNING *", [order.id, channelOrderId])).rows[0];
        if (!updated) throw protocol.fail('PAYMENT_STATE_INVALID');
        const credited = await client.query('UPDATE users SET premium_coins=premium_coins+$2 WHERE id=$1', [order.user_id, order.premium_coins_grant]);
        if (credited.rowCount !== 1) throw protocol.fail('PAYMENT_SUBJECT_BLOCKED', 403);
        await this.record(client, 'PAYMENT_SETTLED', order.user_id, order.id, {
          from: 'PENDING',
          to: 'PAID',
          channel,
          amountFen: order.amount_fen,
          currency: order.currency,
          coinsGranted: order.premium_coins_grant,
          payloadSha256: payloadHash
        }, context);
        return {
          order: updated,
          replayed: false
        };
      });
    } catch (error) {
      if (error.code === '23505') throw protocol.fail('PAYMENT_TRANSACTION_REUSED', 409);
      throw error;
    }
  }
  async cancelExpired(orderId) {
    protocol.identity(orderId);
    return this.transaction(async client => {
      const order = (await client.query("SELECT *,quantity IS NOT NULL AND created_at<=NOW() AT TIME ZONE 'UTC'-INTERVAL '30 minutes' AS expired FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
      if (!order) return {
        cancelled: false,
        reason: 'not_found'
      };
      if (order.status !== 'PENDING' || !order.expired) return {
        cancelled: false,
        reason: order.status !== 'PENDING' ? 'already_processed' : 'not_expired'
      };
      await client.query("UPDATE orders SET status='CANCELLED',updated_at=NOW() WHERE id=$1", [orderId]);
      await this.record(client, 'PAYMENT_ORDER_CANCELLED', order.user_id, order.id, {
        from: 'PENDING',
        to: 'CANCELLED',
        reason: 'timeout'
      });
      return {
        cancelled: true,
        orderId
      };
    });
  }
  async denied(reason, context = {}) {
    await this.transaction(client => this.record(client, 'PAYMENT_CALLBACK_REJECTED', null, null, {
      reason
    }, context));
  }
}
module.exports = {
  PaymentStore
};
