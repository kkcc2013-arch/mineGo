'use strict';

const {
    test
  } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http');
const {
    Pool
  } = require('pg'),
  express = require('express'),
  jwt = require('jsonwebtoken');
const {
    parseMigrationFile
  } = require('../../../database/migrate'),
  {
    migrationStatements
  } = require('../../../database/sqlStatements');
const {ensureStorageExtensions}=require('./storageSetup');
const root = path.resolve(__dirname, '../../..');
test('actual payment routes, PostgreSQL, Redis, byte signatures and encrypted audit commit once', {
  timeout: 120000
}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
  const schema = 'payment_' + crypto.randomBytes(8).toString('hex');
  const admin = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 1
  });
  await ensureStorageExtensions(admin);
  await admin.query('CREATE SCHEMA ' + schema);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const pool = new Pool({
    connectionString: url.toString(),
    max: 4
  });
  const master = crypto.randomBytes(32),
    secret = 'owned-fixture-channel-' + crypto.randomBytes(24).toString('hex');
  const names = ['NODE_ENV', 'DATABASE_URL', 'SERVICE_NAME', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'AUDIT_KMS_KEY_ID', 'MASTER_ENCRYPTION_KEY', 'AUDIT_MASTER_KEYS_JSON', 'AUDIT_MASTER_KEY_ID', 'AUDIT_KEY_NAMESPACE'];
  const prior = Object.fromEntries(names.map(k => [k, process.env[k]]));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    SERVICE_NAME: schema,
    REDIS_URL: process.env.TEST_REDIS_URL,
    JWT_ACCESS_SECRET: 'owned-payment-access-fixture',
    AUDIT_KMS_KEY_ID: '',
    MASTER_ENCRYPTION_KEY: master.toString('hex'),
    AUDIT_MASTER_KEYS_JSON: '',
    AUDIT_MASTER_KEY_ID: 'payment-fixture',
    AUDIT_KEY_NAMESPACE: schema
  });
  const db = require('../../shared/db'),
    redis = require('../../shared/redis'),
    audit = require('../../shared/auditLogEncrypted'),
    r = redis.getRedis();
  const {
      PaymentStore
    } = require('../../services/payment-service/src/payment/PaymentStore'),
    p = require('../../services/payment-service/src/payment/protocol'),
    {
      createPaymentRouter
    } = require('../../services/payment-service/src/routes/payment');
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID(),
    teen = crypto.randomUUID(),
    blocked = crypto.randomUUID();
  const cacheKeys = new Set();
  let server, store;
  const records = [];
  const apply = async (file, down = false) => {
    const text = await fs.readFile(path.join(root, 'database/pending', file), 'utf8'),
      parsed = parseMigrationFile(text);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const sql of migrationStatements(down ? parsed.down : parsed.up)) await c.query(sql);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  };
  try {
    await pool.query(await fs.readFile(path.join(root, 'database/migrations/V1__initial_schema.sql'), 'utf8'));
    for (const file of ['20260608_194800__add_sensitive_data_protection_tables.sql', 'repairs/20260608_200000__add_sensitive_data_audit_tables.sql', '20260607_211500__add_age_verification_coppa_tables.sql', '20261025_120000__payment_order_integrity.sql', '20260610_000000__add_mfa_system.sql', '20261020_120000__mfa_verification_state.sql']) await apply(file);
    await pool.query('INSERT INTO users(id,nickname,premium_coins,is_banned) VALUES($1,$2,0,false),($3,$4,0,false),($5,$6,0,false),($7,$8,0,true)', [owner, 'owned-payment', other, 'other-payment', teen, 'teen-payment', blocked, 'blocked-payment']);
    store = new PaymentStore();
    await store.ready();
    const {RiskVerifier} = require('../../shared/riskVerifier');
    const risk = new RiskVerifier();
    await risk.ready();
    const blacklist = new (require('../../shared/JwtBlacklist').JwtBlacklist)(r);
    const tokens = new Map();
    for (const id of [owner, other, teen, blocked]) {
      const jti = crypto.randomUUID();
      const signed = jwt.sign({sub: id, jti}, process.env.JWT_ACCESS_SECRET, {expiresIn: '5m'});
      await blacklist.registerSession(jti, id, jwt.decode(signed).exp, {ip: '127.0.0.1', userAgent: 'node', mfaEpoch: null});
      tokens.set(id, signed);
      cacheKeys.add('sessions:user:' + id); cacheKeys.add('blacklist:user:' + id);
      for (const key of Object.values(risk.keys(id, '127.0.0.1'))) cacheKeys.add(key);
    }
    const app = express();
    app.use('/payment', createPaymentRouter({
      store,
      risk,
      secrets: {
        WECHAT: secret,
        ALIPAY: secret,
        APPLE: secret
      }
    }));
    app.use(require('../../shared/auth').errorHandler);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const token = id => tokens.get(id);
    const call = async (route, {
      body,
      raw,
      auth = owner,
      headers = {},
      method = body !== undefined || raw !== undefined ? 'POST' : 'GET'
    } = {}) => {
      const response = await fetch(base + '/payment' + route, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? {
            Authorization: 'Bearer ' + token(auth)
          } : {}),
          ...headers
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
      });
      const data = await response.json();
      return {
        status: response.status,
        data
      };
    };
    const create = async ({
      id = owner,
      key = crypto.randomUUID(),
      productId = 'coins_60',
      quantity = 1,
      channel = 'WECHAT'
    } = {}) => {
      cacheKeys.add('payment:create:' + id + ':' + key);
      const result = await call('/orders', {
        auth: id,
        headers: {
          'X-Idempotency-Key': key
        },
        body: {
          productId,
          quantity,
          channel
        }
      });
      return {
        ...result,
        key
      };
    };
    const callbackBody = (order, extra = {}) => ({
      orderId: order.orderId,
      channelOrderId: 'owned-' + crypto.randomUUID(),
      amountFen: order.amountFen,
      currency: 'CNY',
      status: 'PAID',
      ...extra
    });
    const webhook = async (body, {
      channel = 'WECHAT',
      signature,
      space = false,
      header = 'X-Signature'
    } = {}) => {
      const raw = JSON.stringify(body, null, space ? 2 : 0);
      const sign = signature ?? crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return call('/webhook/' + channel, {
        raw,
        auth: null,
        headers: {
          [header]: sign
        }
      });
    };
    await t.test('actual mounted auth, product catalog, required header and input contracts refuse unsafe requests', async () => {
      assert.equal((await call('/products', {
        auth: null
      })).status, 401);
      assert.equal((await call('/products')).data.data.length, 5);
      assert.equal((await call('/orders', {
        body: {
          productId: 'coins_60',
          channel: 'WECHAT'
        }
      })).status, 400);
      assert.equal((await create({
        id: blocked
      })).status, 403);
      assert.equal((await call('/orders', {
        headers: {
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: {
          productId: 'constructor',
          channel: 'WECHAT'
        }
      })).status, 404);
    });
    let order, mainKey;
    await t.test('simultaneous same-owner requests create one durable order and a real24h Redis mirror', async () => {
      mainKey = crypto.randomUUID();
      const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
      const both = await Promise.all([create({
        key: mainKey,
        quantity: 2
      }), create({
        key: mainKey,
        quantity: 2
      }), create({
        key: mainKey,
        quantity: 2
      })]);
      assert.deepEqual(both.map(x => x.status).sort(), [200, 200, 201]);
      assert.equal(new Set(both.map(x => x.data.data.orderId)).size, 1);
      order = both[0].data.data;
      records.push(order);
      assert.equal(order.amountFen, 1200);
      assert.equal(order.quantity, 2);
      assert.equal(order.payParams, null);
      assert.equal(order.providerReady, false);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before + 1);
      const key = 'payment:create:' + owner + ':' + mainKey;
      assert.equal(JSON.parse(await r.get(key)).orderId, order.orderId);
      const ttl = await r.ttl(key);
      assert.ok(ttl >= 86390 && ttl <= 86400);
      assert.equal((await pool.query('SELECT extract(epoch FROM expires_at-created_at)::int AS ttl FROM payment_order_requests WHERE order_id=$1', [order.orderId])).rows[0].ttl, 86400);
    });
    await t.test('changed payload conflicts, different owner keys stay independent and cache poison/loss cannot redirect orders', async () => {
      assert.equal((await create({
        key: mainKey,
        quantity: 3
      })).status, 409);
      assert.equal((await create({
        id: other,
        key: mainKey,
        quantity: 2
      })).status, 201);
      const key = 'payment:create:' + owner + ':' + mainKey;
      await r.set(key, JSON.stringify({
        orderId: crypto.randomUUID(),
        status: 'PAID'
      }), 'EX', 86400);
      assert.equal((await create({
        key: mainKey,
        quantity: 2
      })).data.data.orderId, order.orderId);
      await r.del(key);
      assert.equal((await create({
        key: mainKey,
        quantity: 2
      })).data.data.orderId, order.orderId);
    });
    await t.test('a disconnected real Redis mirror cannot duplicate or hide a committed SQL order', async () => {
      const ClosedRedis = require('ioredis'),
        closed = new ClosedRedis(process.env.TEST_REDIS_URL, {
          retryStrategy: () => null
        });
      await closed.ping();
      await closed.quit();
      const resilient = new PaymentStore({
        cache: closed
      });
      const key = crypto.randomUUID(),
        input = p.requestInput({
          productId: 'coins_60',
          channel: 'WECHAT'
        }, key);
      const a = await resilient.create(owner, input);
      const b = await resilient.create(owner, input);
      assert.equal(a.order.id, b.order.id);
      assert.equal(a.replayed, false);
      assert.equal(b.replayed, true);
    });
    await t.test('expired request creates a new order while replay never extends its original deadline', async () => {
      const initial = await create();
      const old = initial.data.data.orderId;
      const before = (await pool.query('SELECT expires_at::text FROM payment_order_requests WHERE order_id=$1', [old])).rows[0].expires_at;
      await create({
        key: initial.key
      });
      assert.equal((await pool.query('SELECT expires_at::text FROM payment_order_requests WHERE order_id=$1', [old])).rows[0].expires_at, before);
      await pool.query("UPDATE payment_order_requests SET created_at=statement_timestamp()-INTERVAL '25 hours',expires_at=statement_timestamp()-INTERVAL '1 hour' WHERE order_id=$1", [old]);
      const next = await create({
        key: initial.key
      });
      assert.equal(next.status, 201);
      assert.notEqual(next.data.data.orderId, old);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE id=$1', [old])).rows[0].n, 1);
    });
    await t.test('unknown historical raw-key requests refuse automatic adoption and retain every old field', async () => {
      const key = crypto.randomUUID();
      await pool.query("INSERT INTO orders(user_id,idempotency_key,product_id,product_name,amount_fen,payment_channel) VALUES($1,$2,'coins_60','historical',600,'WECHAT')", [owner, key]);
      const before = (await pool.query('SELECT * FROM orders WHERE idempotency_key=$1', [key])).rows[0];
      assert.equal((await create({
        key
      })).status, 409);
      assert.deepEqual((await pool.query('SELECT * FROM orders WHERE idempotency_key=$1', [key])).rows[0], before);
    });
    await t.test('no signature, wrong bytes, conflicting headers and malformed authenticated callbacks cannot credit coins', async () => {
      assert.equal((await call('/webhook/WECHAT', {
        raw: '{}',
        auth: null
      })).status, 401);
      assert.equal((await webhook(callbackBody(order), {
        signature: 'x'
      })).status, 401);
      const body = callbackBody(order),
        raw = JSON.stringify(body, null, 2),
        sign = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
      assert.equal((await call('/webhook/WECHAT', {
        raw,
        auth: null,
        headers: {
          'X-Signature': sign
        }
      })).status, 401);
      assert.equal((await call('/webhook/WECHAT', {
        raw: '{}',
        auth: null,
        headers: {
          'X-Signature': crypto.createHmac('sha256', secret).update('{}').digest('hex'),
          'X-Pay-Signature': 'f'.repeat(64)
        }
      })).status, 401);
      assert.equal((await webhook({
        ...body,
        status: 'FAILED'
      })).status, 400);
      assert.equal((await webhook({
        ...body,
        amountFen: 1
      })).status, 401);
      assert.equal((await webhook(body, {
        channel: 'APPLE'
      })).status, 401);
      assert.equal((await webhook(body, {
        channel: 'BAD'
      })).status, 400);
      assert.equal((await pool.query('SELECT premium_coins FROM users WHERE id=$1', [owner])).rows[0].premium_coins, 0);
    });
    let settlement;
    await t.test('parallel byte-authenticated callbacks settle exactly once with one provider receipt and one spend update', async () => {
      settlement = callbackBody(order);
      const responses = await Promise.all([webhook(settlement, {
        space: true
      }), webhook(settlement, {
        space: true
      }), webhook(settlement, {
        space: true
      })]);
      assert.ok(responses.every(x => x.status === 200));
      assert.equal(responses.filter(x => !x.data.data.alreadyPaid).length, 1);
      assert.equal((await pool.query('SELECT premium_coins FROM users WHERE id=$1', [owner])).rows[0].premium_coins, 120);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_settlements WHERE order_id=$1', [order.orderId])).rows[0].n, 1);
      const spend = (await pool.query('SELECT total_cents,transaction_count FROM user_monthly_spend WHERE user_id=$1', [owner])).rows[0];
      assert.equal(spend.total_cents, '1200');
      assert.equal(spend.transaction_count, 1);
      assert.equal((await create({
        key: mainKey,
        quantity: 2
      })).data.data.status, 'PAID');
    });
    await t.test('provider transaction cannot be reassigned or reused and ownership is checked on verification', async () => {
      assert.equal((await webhook({
        ...settlement,
        channelOrderId: 'different-transaction'
      })).status, 409);
      const next = (await create()).data.data;
      assert.equal((await webhook(callbackBody(next, {
        channelOrderId: settlement.channelOrderId
      }))).status, 409);
      const channelOrderId = 'verified-' + crypto.randomUUID();
      const channelSign = crypto.createHmac('sha256', secret).update(`${next.orderId}|${next.amountFen}|${next.productId}|${channelOrderId}`).digest('hex');
      assert.equal((await call('/orders/' + next.orderId + '/verify', {
        auth: other,
        body: {
          channelOrderId,
          channelSign
        }
      })).status, 404);
      assert.equal((await call('/orders/' + next.orderId + '/verify', {
        body: {
          channelOrderId,
          channelSign: 'f'.repeat(64)
        }
      })).status, 401);
      const result = await call('/orders/' + next.orderId + '/verify', {
        body: {
          channelOrderId,
          channelSign
        }
      });
      assert.equal(result.status, 200);
      assert.equal(result.data.data.coinsGranted, 60);
      assert.equal((await call('/orders/' + next.orderId + '/verify', {
        body: {
          channelOrderId,
          channelSign
        }
      })).data.data.coinsGranted, 0);
    });
    await t.test('all declared channels authenticate the exact repository HMAC JSON contract', async () => {
      for (const channel of ['ALIPAY', 'APPLE']) {
        const next = (await create({
          channel
        })).data.data;
        assert.equal((await webhook(callbackBody(next), {
          channel,
          header: 'X-Pay-Signature',
          space: true
        })).status, 200);
      }
    });
    await t.test('actual legacy XML and form HTTP callbacks retain their signed bytes and cannot turn failure states into payment', async () => {
      for (const channel of ['WECHAT', 'ALIPAY']) {
        const next = (await create({
          channel
        })).data.data;
        const raw = channel === 'WECHAT' ? `<xml><out_trade_no>${next.orderId}</out_trade_no><transaction_id>owned-xml-${next.orderId}</transaction_id><total_fee>600</total_fee><fee_type>CNY</fee_type><return_code>SUCCESS</return_code><result_code>SUCCESS</result_code></xml>` : new URLSearchParams({
          out_trade_no: next.orderId,
          trade_no: 'owned-form-' + next.orderId,
          total_amount: '6.00',
          currency: 'CNY',
          trade_status: 'TRADE_SUCCESS'
        }).toString();
        const sign = crypto.createHmac('sha256', secret).update(raw).digest('hex');
        const result = await call('/webhook/' + channel, {
          raw,
          auth: null,
          headers: {
            'Content-Type': channel === 'WECHAT' ? 'application/xml' : 'application/x-www-form-urlencoded',
            'X-Signature': sign
          }
        });
        assert.equal(result.status, 200);
        assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [next.orderId])).rows[0].status, 'PAID');
      }
    });
    await t.test('receipt/audit failure rolls back order creation and settlement, coins, requests and spend', async () => {
      await pool.query("CREATE FUNCTION payment_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action IN ('PAYMENT_ORDER_CREATED','PAYMENT_SETTLED') THEN RAISE EXCEPTION 'owned payment audit fault'; END IF; RETURN NEW; END$$");
      await pool.query('CREATE TRIGGER payment_audit_fault BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION payment_audit_fault()');
      const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
      assert.equal((await create()).status, 500);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
      await pool.query('DROP TRIGGER payment_audit_fault ON audit_logs');
      const next = (await create()).data.data;
      const balance = (await pool.query('SELECT premium_coins FROM users WHERE id=$1', [owner])).rows[0].premium_coins;
      await pool.query('CREATE TRIGGER payment_audit_fault BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION payment_audit_fault()');
      assert.equal((await webhook(callbackBody(next))).status, 500);
      assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [next.orderId])).rows[0].status, 'PENDING');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_settlements WHERE order_id=$1', [next.orderId])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT premium_coins FROM users WHERE id=$1', [owner])).rows[0].premium_coins, balance);
      await pool.query('DROP TRIGGER payment_audit_fault ON audit_logs');
    });
    await t.test('age and spend checks fail closed, settlement reserves the limit atomically and bans cannot credit', async () => {
      await pool.query("INSERT INTO user_age_profiles(user_id,age_bracket,monthly_spend_limit_cents) VALUES($1,'13_17',600)", [teen]);
      const a = (await create({
          id: teen
        })).data.data,
        b = (await create({
          id: teen
        })).data.data;
      const results = await Promise.all([webhook(callbackBody(a)), webhook(callbackBody(b))]);
      assert.deepEqual(results.map(x => x.status).sort(), [200, 403]);
      assert.equal((await pool.query('SELECT premium_coins FROM users WHERE id=$1', [teen])).rows[0].premium_coins, 60);
      assert.equal((await create({
        id: teen
      })).status, 403);
      await pool.query("UPDATE user_age_profiles SET age_bracket='under_13',monthly_spend_limit_cents=10000,parent_consent_status='pending' WHERE user_id=$1", [teen]);
      assert.equal((await create({
        id: teen
      })).status, 403);
      await pool.query("UPDATE user_age_profiles SET age_bracket='18_plus',features_disabled=ARRAY['payment'] WHERE user_id=$1", [teen]);
      assert.equal((await create({
        id: teen
      })).status, 403);
      const next = (await create({
        id: other
      })).data.data;
      await pool.query('UPDATE users SET is_banned=true WHERE id=$1', [other]);
      assert.equal((await webhook(callbackBody(next))).status, 403);
      await pool.query('UPDATE users SET is_banned=false WHERE id=$1', [other]);
    });
    await t.test('timeout cancellation uses actual rows, refuses processed/fresh orders and cannot be paid afterwards', async () => {
      const next = (await create()).data.data;
      assert.equal((await store.cancelExpired(next.orderId)).reason, 'not_expired');
      assert.equal((await store.cancelExpired(crypto.randomUUID())).reason, 'not_found');
      assert.equal((await store.cancelExpired(order.orderId)).reason, 'already_processed');
      await pool.query("UPDATE orders SET created_at=NOW() AT TIME ZONE 'UTC'-INTERVAL '31 minutes' WHERE id=$1", [next.orderId]);
      assert.equal((await store.cancelExpired(next.orderId)).cancelled, true);
      assert.equal((await webhook(callbackBody(next))).status, 400);
    });
    await t.test('order projections are owned and receipts decrypt without raw signatures/callbacks or plaintext audit fallbacks', async () => {
      const results = await call('/orders');
      assert.equal(results.status, 200);
      assert.ok(results.data.data.every(row => !['channel_response', 'rawCallback', 'signature', 'channelOrderId'].some(k => Object.hasOwn(row, k))));
      assert.ok(!(await call('/orders', {
        auth: other
      })).data.data.some(row => row.orderId === order.orderId));
      const audits = (await pool.query("SELECT id::text,details,encrypted_data FROM audit_logs WHERE action LIKE 'PAYMENT_%' ORDER BY id")).rows;
      assert.ok(audits.length >= 15);
      assert.ok(audits.every(row => row.details === null && Buffer.isBuffer(row.encrypted_data)));
      const settled = (await pool.query("SELECT id::text FROM audit_logs WHERE action='PAYMENT_SETTLED' LIMIT 1")).rows[0];
      const read = await audit.readEncryptedAuditLog(settled.id);
      assert.equal(read.data.actionData.to, 'PAID');
      assert.ok(!JSON.stringify(read).includes(secret));
      await assert.rejects(apply('20261025_120000__payment_order_integrity.sql', true), /Retain payment/);
    });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    for (const key of cacheKeys) await r.del(key).catch(() => {});
    await audit.closeAuditEncryption();
    await db.closePools();
    await redis.closeRedis();
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];else process.env[k] = v;
    }
    master.fill(0);
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
