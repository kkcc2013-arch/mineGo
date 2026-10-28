'use strict';

const {
    test
  } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  http = require('node:http'),
  {
    spawn
  } = require('node:child_process');
const {
    Pool
  } = require('pg'),
  jwt = require('jsonwebtoken'),
  {
    Kafka
  } = require('kafkajs');
const {ensureStorageExtensions}=require('./storageSetup');
const root = path.resolve(__dirname, '../../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const s = http.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}
function launch(file, env, args = []) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root,
    env: {
      ...process.env,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({
    code,
    signal
  })));
  child.stdout.on('data', b => log = (log + b).slice(-18000));
  child.stderr.on('data', b => log = (log + b).slice(-18000));
  return {
    child,
    exit,
    log: () => log
  };
}
async function ended(proc, ms = 60000) {
  let timer;
  try {
    return await Promise.race([proc.exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Owned process did not exit within observation')), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
const fetchBounded = (url, options = {}) => fetch(url, {
  signal: AbortSignal.timeout(10000),
  ...options
});
async function ready(proc, base) {
  for (let n = 0; n < 300; n++) {
    if (proc.child.exitCode !== null || proc.child.signalCode) throw Error('Native process exited: ' + proc.log());
    try {
      const r = await fetchBounded(base + '/health/live', {
        signal: AbortSignal.timeout(300)
      });
      if (r.status === 200) return;
    } catch {}
    await pause(100);
  }
  throw Error('Native listener unavailable: ' + proc.log());
}
async function stop(proc) {
  if (!proc || proc.child.exitCode !== null || proc.child.signalCode) return;
  proc.child.kill('SIGTERM');
  let timer;
  try {
    assert.deepEqual(await Promise.race([proc.exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Native natural shutdown timed out')), 20000);
    })]), {
      code: 0,
      signal: null
    });
  } finally {
    clearTimeout(timer);
  }
}
async function cleanup(proc) {
  if (proc && proc.child.exitCode === null && !proc.child.signalCode) {
    proc.child.kill('SIGKILL');
    await proc.exit;
  }
}
test('actual payment and gateway entry points preserve signed raw bytes, once-only credit, currency, readiness and natural shutdown', {
  timeout: 180000
}, async () => {
  assert.ok(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL && process.env.TEST_KAFKA_BROKERS);
  const admin = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1
    }),
    schema = 'payment_native_' + crypto.randomBytes(8).toString('hex');
  await ensureStorageExtensions(admin);
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
    options: '-c search_path=' + schema + ',public'
  });
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const owner = crypto.randomUUID(),
    secret = crypto.randomBytes(32).toString('hex'),
    master = crypto.randomBytes(32).toString('hex'),
    access = 'native-payment-access-fixture-only';
  const redisUrl = new URL(process.env.TEST_REDIS_URL);
  const Redis = require('ioredis'),
    r = new Redis(process.env.TEST_REDIS_URL);
  let payment, gateway, migration, kafka, topicAdmin;
  let createdTopic = false;
  const queueTopic = schema + '-ready';
  const dlqTopic = schema + '-dlq';
  const cacheKeys = [];
  const env = {
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    SERVICE_NAME: 'payment-service',
    REDIS_URL: process.env.TEST_REDIS_URL,
    REDIS_HOST: redisUrl.hostname,
    REDIS_PORT: redisUrl.port,
    JWT_ACCESS_SECRET: access,
    JWT_REFRESH_SECRET: 'native-payment-refresh-fixture-only',
    WECHAT_SECRET: secret,
    ALIPAY_SECRET: secret,
    APPLE_SHARED_SECRET: secret,
    MASTER_ENCRYPTION_KEY: master,
    AUDIT_KMS_KEY_ID: '',
    AUDIT_MASTER_KEYS_JSON: '',
    AUDIT_MASTER_KEY_ID: 'payment-native',
    AUDIT_KEY_NAMESPACE: schema,
    KAFKA_BROKERS: process.env.TEST_KAFKA_BROKERS,
    PAYMENT_QUEUE_CLIENT_ID: schema,
    PAYMENT_QUEUE_TOPIC_PREFIX: schema,
    SERVICE_TRUST_PROXY: 'loopback',
    LOG_LEVEL: 'error',
    UV_THREADPOOL_SIZE: '2',
    OER_API_KEY: '',
    FIXER_API_KEY: '',
    EXCHANGE_RATE_API_KEY: ''
  };
  try {
    await pool.query(await fs.readFile(path.join(root, 'database/migrations/V1__initial_schema.sql'), 'utf8'));
    await pool.query(await fs.readFile(path.join(root, 'database/seeds/V2__seed_data.sql'), 'utf8'));
    migration = launch(path.join(root, 'database/migrate.js'), env, ['up']);
    assert.deepEqual(await ended(migration), {
      code: 0,
      signal: null
    }, migration.log());
    migration = null;
    const applied = (await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
    const raw = (await fs.readdir(path.join(root, 'database/pending'))).filter(f => f.endsWith('.sql')).length;
    assert.equal(applied, raw);
    await pool.query('INSERT INTO users(id,nickname,premium_coins) VALUES($1,$2,0)', [owner, 'native-payment-owner']);
    const refused = launch(path.join(root, 'backend/services/payment-service/src/index.js'), {
      ...env,
      NODE_ENV: 'production',
      PORT: '0'
    });
    try {
      assert.deepEqual(await ended(refused, 10000), {
        code: 1,
        signal: null
      });
      assert.match(refused.log(), /AUDIT_KMS_CONFIGURATION/);
      assert.ok(!refused.log().includes(master) && !refused.log().includes(secret));
    } finally {
      await cleanup(refused);
    }
    const queuedBeforeStart = crypto.randomUUID(), unrelatedTaskOrder = crypto.randomUUID();
    for (const id of [queuedBeforeStart, unrelatedTaskOrder]) {
      await pool.query("INSERT INTO orders(id,user_id,idempotency_key,product_id,product_name,amount_fen,premium_coins_grant,payment_channel,quantity,created_at) VALUES($1,$2,$3,'coins_60','owned preexisting queue fixture',600,60,'WECHAT',1,NOW() AT TIME ZONE 'UTC'-INTERVAL '31 minutes')", [id, owner, crypto.randomUUID()]);
    }
    const broker = new Kafka({clientId: schema + '-fixture', brokers: process.env.TEST_KAFKA_BROKERS.split(',')});
    topicAdmin = broker.admin();
    await topicAdmin.connect();
    await topicAdmin.createTopics({waitForLeaders: true, topics: [queueTopic, dlqTopic].map(topic => ({topic, numPartitions: 1, replicationFactor: 1}))});
    createdTopic = true;
    kafka = broker.producer();
    await kafka.connect();
    // A new consumer group must retain work queued before the service starts.
    await kafka.send({topic: queueTopic, messages: [
      ['other.fixture', unrelatedTaskOrder], ['order.timeout', queuedBeforeStart]
    ].map(([type, id]) => ({key: 'owned-' + id, value: JSON.stringify({
      id: 'owned-' + id, type, payload: {orderId: id}, createdAt: new Date().toISOString(), retries: 0, maxRetries: 1
    })}))});
    const pp = await port(),
      pb = 'http://127.0.0.1:' + pp;
    payment = launch(path.join(root, 'backend/services/payment-service/src/index.js'), {
      ...env,
      PORT: String(pp)
    });
    await ready(payment, pb);
    assert.equal((await fetchBounded(pb + '/health/ready')).status, 200);
    let backlogCancelled = false;
    for (let n = 0; n < 100; n++) {
      backlogCancelled = (await pool.query('SELECT status FROM orders WHERE id=$1', [queuedBeforeStart])).rows[0].status === 'CANCELLED';
      if (backlogCancelled) break;
      await pause(50);
    }
    assert.equal(backlogCancelled, true, 'task queued before the actual consumer starts must not be skipped');
    assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [unrelatedTaskOrder])).rows[0].status, 'PENDING', 'another task type must not reach the order-timeout handler');

    const catalog = await (await fetchBounded(pb + '/api/v1/currencies')).json();
    assert.equal(catalog.data.count, 20);
    const conversion = await fetchBounded(pb + '/currency/convert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: '1.005',
        from: 'USD',
        to: 'USD'
      })
    });
    assert.equal((await conversion.json()).data.converted.amountExact, '1.01');
    const gp = await port(),
      gb = 'http://127.0.0.1:' + gp;
    const peers = Object.fromEntries(['USER', 'LOCATION', 'POKEMON', 'CATCH', 'GYM', 'SOCIAL', 'REWARD', 'PAYMENT'].map(k => [k + '_SERVICE_URL', pb]));
    gateway = launch(path.join(root, 'backend/gateway/src/index.js'), {
      ...env,
      ...peers,
      SERVICE_NAME: 'gateway',
      PORT: String(gp)
    });
    await ready(gateway, gb);
    assert.equal((await fetchBounded(gb + '/v1/payment/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    })).status, 401);
    const token = jwt.sign({
      sub: owner,
      jti: crypto.randomUUID()
    }, access, {
      expiresIn: '5m'
    });
    const claims = jwt.decode(token);
    await r.hset('sessions:user:' + owner, claims.jti, JSON.stringify({jti: claims.jti, createdAt: claims.iat, expiresAt: claims.exp, ip: '127.0.0.1', userAgent: 'node', mfaEpoch: null}));
    cacheKeys.push('sessions:user:' + owner);
    const riskNamespace = 'risk:v1:' + crypto.createHash('sha256').update(JSON.stringify([(await pool.query('SELECT current_database() AS name')).rows[0].name, schema])).digest('hex') + ':';
    for (const [kind, value] of [['ip', '127.0.0.1'], ['user', owner], ['failures', owner]]) cacheKeys.push(riskNamespace + kind + ':' + crypto.createHash('sha256').update(value).digest('hex'));
    const key = crypto.randomUUID();
    cacheKeys.push('payment:create:' + owner + ':' + key);
    const create = await fetchBounded(gb + '/v1/payment/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': key,
        'X-Forwarded-For': '198.51.100.42'
      },
      body: JSON.stringify({
        productId: 'coins_60',
        channel: 'WECHAT'
      })
    });
    assert.equal(create.status, 201);
    const order = (await create.json()).data;
    const rawBody = JSON.stringify({
      orderId: order.orderId,
      channelOrderId: 'native-' + crypto.randomUUID(),
      amountFen: 600,
      currency: 'CNY',
      status: 'PAID'
    }, null, 2);
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const webhook = () => fetch(gb + '/v1/payment/webhook/WECHAT', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature
      },
      body: rawBody
    });
    assert.equal((await fetchBounded(gb + '/v1/payment/webhook/WECHAT', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    })).status, 401);
    const callbacks = await Promise.all([webhook(), webhook()]);
    assert.ok(callbacks.every(x => x.status === 200));
    assert.equal((await pool.query('SELECT premium_coins FROM users WHERE id=$1', [owner])).rows[0].premium_coins, 60);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_settlements WHERE order_id=$1', [order.orderId])).rows[0].n, 1);
    const legacyKey = crypto.randomUUID();
    cacheKeys.push('payment:create:' + owner + ':' + legacyKey);
    const legacyCreate = await fetchBounded(gb + '/v1/payment/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': legacyKey
      },
      body: JSON.stringify({
        productId: 'coins_60',
        channel: 'ALIPAY'
      })
    });
    assert.equal(legacyCreate.status, 201);
    const legacyOrder = (await legacyCreate.json()).data;
    const legacyBody = new URLSearchParams({
      out_trade_no: legacyOrder.orderId,
      trade_no: 'native-form-' + legacyOrder.orderId,
      total_amount: '6.00',
      currency: 'CNY',
      trade_status: 'TRADE_SUCCESS'
    }).toString();
    const legacySign = crypto.createHmac('sha256', secret).update(legacyBody).digest('hex');
    const legacyCallback = await fetchBounded(gb + '/v1/payment/webhook/ALIPAY', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Pay-Signature': legacySign
      },
      body: legacyBody
    });
    assert.equal(legacyCallback.status, 200);
    assert.equal((await pool.query('SELECT premium_coins FROM users WHERE id=$1', [owner])).rows[0].premium_coins, 120);
    const timeoutKey = crypto.randomUUID();
    cacheKeys.push('payment:create:' + owner + ':' + timeoutKey);
    const pending = await fetchBounded(pb + '/payment/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': timeoutKey
      },
      body: JSON.stringify({
        productId: 'coins_60',
        channel: 'WECHAT'
      })
    });
    assert.equal(pending.status, 201);
    const timed = (await pending.json()).data;
    await pool.query("UPDATE orders SET created_at=NOW() AT TIME ZONE 'UTC'-INTERVAL '31 minutes' WHERE id=$1", [timed.orderId]);
    await kafka.send({
      topic: queueTopic,
      messages: [{
        key: 'owned-' + timed.orderId,
        value: JSON.stringify({
          id: 'owned-' + timed.orderId,
          type: 'order.timeout',
          payload: {
            orderId: timed.orderId
          },
          createdAt: new Date().toISOString(),
          retries: 0,
          maxRetries: 1
        })
      }]
    });
    let cancelled = false;
    for (let n = 0; n < 100; n++) {
      cancelled = (await pool.query('SELECT status FROM orders WHERE id=$1', [timed.orderId])).rows[0].status === 'CANCELLED';
      if (cancelled) break;
      await pause(50);
    }
    assert.equal(cancelled, true, 'real registered Kafka timeout handler must change the owned row');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='PAYMENT_ORDER_CANCELLED'")).rows[0].n, 2);
    const begin = performance.now();
    await stop(gateway);
    const gatewayMs = performance.now() - begin;
    const payStart = performance.now();
    await stop(payment);
    const paymentMs = performance.now() - payStart;
    for (const proc of [payment, gateway]) assert.ok(!proc.log().includes(secret) && !proc.log().includes(master) && !proc.log().includes(signature));
    console.log(JSON.stringify({
      pendingMigrations: applied,
      gatewayShutdownMs: gatewayMs,
      paymentShutdownMs: paymentMs,
      scope: 'Actual payment+gateway OS entry points, canonical full history, signed spaced JSON bytes through gateway without userJWT, SQL/Redis/Kafka/encrypted receipts and actual timeout consumer; other gateway peers alias payment fixture, no provider/liveAWS/capacity acceptance.'
    }));
  } finally {
    await cleanup(gateway);
    await cleanup(payment);
    await cleanup(migration);
    if (kafka) await kafka.disconnect();
    if (topicAdmin) {
      try {
        if (createdTopic) await topicAdmin.deleteTopics({topics: [queueTopic, dlqTopic]});
      } finally {
        await topicAdmin.disconnect();
      }
    }
    for (const key of cacheKeys) await r.del(key).catch(() => {});
    await r.quit();
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
test('actual payment entry refuses missing channel secrets before binding or opening storage', {
  timeout: 10000
}, async () => {
  const refused = launch(path.join(root, 'backend/services/payment-service/src/index.js'), {
    NODE_ENV: 'test',
    PORT: '0',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
    WECHAT_SECRET: '',
    ALIPAY_SECRET: '',
    APPLE_SHARED_SECRET: ''
  });
  try {
    assert.deepEqual(await ended(refused, 10000), {
      code: 1,
      signal: null
    });
    assert.match(refused.log(), /PAYMENT_STARTUP_REFUSED/);
  } finally {
    await cleanup(refused);
  }
});
