'use strict';

const {
  test
} = require('node:test');
const {
  spawn
} = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  Pool
} = require('pg');
const {
  migrationStatements
} = require('../../../database/sqlStatements');
const {
  parseMigrationFile
} = require('../../../database/migrate');
const {
  EncryptedAuditStore
} = require('../../shared/audit/EncryptedAuditStore');
const {
  EnvironmentKeyProvider
} = require('../../shared/audit/KeyProviders');
const {
  seal
} = require('../../shared/audit/cryptoPrimitives');
const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFile(path.join(root, file), 'utf8');
async function apply(pool, source) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const sql of migrationStatements(parseMigrationFile(source).up)) await c.query(sql);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
async function fixture(fn) {
  assert.ok(process.env.TEST_DATABASE_URL, 'owned PostGIS required');
  const schema = 'audit_crypto_' + crypto.randomBytes(8).toString('hex');
  const admin = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 1
  });
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = new Pool({
    connectionString: url.toString(),
    max: 3
  });
  const masterA = crypto.randomBytes(32),
    masterB = crypto.randomBytes(32);
  const provider = new EnvironmentKeyProvider({
    keys: {
      a: masterA,
      b: masterB
    },
    activeKeyId: 'a',
    legacyMasterKeyId: 'a',
    nodeEnv: 'test'
  });
  const store = new EncryptedAuditStore({
    pool,
    provider,
    nodeEnv: 'test'
  });
  const second = new EncryptedAuditStore({
    pool,
    provider,
    nodeEnv: 'test'
  });
  const owner = crypto.randomUUID(),
    other = crypto.randomUUID();
  try {
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));
    await pool.query(await read('database/seeds/V2__seed_data.sql'));
    await apply(pool, await read('database/pending/20260608_194800__add_sensitive_data_protection_tables.sql'));
    await apply(pool, await read('database/pending/repairs/20260608_200000__add_sensitive_data_audit_tables.sql'));
    await pool.query("INSERT INTO users(id,nickname) VALUES($1,'crypto-owner'),($2,'crypto-other')", [owner, other]);
    await fn({
      pool,
      store,
      second,
      provider,
      masterA,
      masterB,
      owner,
      other,
      url: url.toString(),
      schema
    });
  } finally {
    await store.close();
    await second.close();
    provider.close();
    masterA.fill(0);
    masterB.fill(0);
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const failure = code => error => error.code === code;
test('production audit crypto persists authenticated canonical history and real rotation across independent clients', async t => fixture(async ({
  pool,
  store,
  second,
  provider,
  masterA,
  masterB,
  owner,
  other,
  url,
  schema
}) => {
  let firstId, firstKey;
  const payload = {
    email: 'fixture-private@example.invalid',
    nested: {
      phone: 'fixture-private-phone'
    },
    number: 0,
    enabled: false
  };
  await t.test('first-use contention creates one durable audit-owned key while preserving other key purposes', async () => {
    await pool.query("INSERT INTO encryption_keys(id,encrypted_key,is_active) VALUES('unrelated-purpose-key',$1,TRUE)", [crypto.randomBytes(64)]);
    const results = await Promise.all([store.encryptAuditLog(payload), second.encryptAuditLog(payload)]);
    assert.equal(results[0].keyId, results[1].keyId);
    firstKey = results[0].keyId;
    assert.deepEqual(await second.decryptAuditLog(results[0].encryptedData, results[0].iv, results[0].authTag, results[0].keyId), payload);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM encryption_keys WHERE id LIKE 'audit1:%' AND is_active")).rows[0].n, 1);
    const wrapped = (await pool.query('SELECT encrypted_key FROM encryption_keys WHERE id=$1', [firstKey])).rows[0].encrypted_key;
    assert.ok(Buffer.isBuffer(wrapped));
    assert.ok(!wrapped.includes(masterA));
    assert.ok(!wrapped.includes(Buffer.from('fixture-private')));
  });
  await t.test('canonical writer persists every tag and keeps all private values out of plaintext columns', async () => {
    firstId = await store.writeEncryptedAuditLog({
      userId: owner,
      action: 'crypto-private',
      resourceType: 'user',
      resourceId: owner,
      actionData: payload,
      ipAddress: '192.0.2.27',
      userAgent: 'fixture-private-agent'
    });
    const row = (await pool.query('SELECT * FROM audit_logs WHERE id=$1', [firstId])).rows[0];
    assert.equal(row.details, null);
    assert.equal(row.ip_addr, null);
    assert.equal(row.ip_address, null);
    assert.equal(row.user_agent, null);
    assert.equal(row.encryption_iv.length, 32);
    assert.equal(row.encryption_auth_tag.length, 32);
    assert.ok(!row.encrypted_data.includes(Buffer.from('fixture-private')));
    const actual = await second.readEncryptedAuditLog(firstId);
    assert.equal(actual.userId, owner);
    assert.deepEqual(actual.data.actionData, payload);
    assert.equal(actual.data.ipAddress, '192.0.2.27');
    assert.equal(actual.data.userAgent, 'fixture-private-agent');
    assert.equal(typeof actual.id, 'string');
  });
  await t.test('fresh nonces and authentication reject changed cipher, tag, IV, key and bound metadata', async () => {
    const nonces = new Set();
    for (let i = 0; i < 32; i++) {
      const envelope = await store.encryptAuditLog({
        i
      });
      nonces.add(envelope.iv);
    }
    assert.equal(nonces.size, 32);
    const e = await store.encryptAuditLog(payload);
    const flip = value => (value[0] === '0' ? '1' : '0') + value.slice(1);
    for (const entry of [{
      ...e,
      encryptedData: flip(e.encryptedData)
    }, {
      ...e,
      authTag: flip(e.authTag)
    }, {
      ...e,
      iv: flip(e.iv)
    }]) await assert.rejects(store.decryptAuditLog(entry.encryptedData, entry.iv, entry.authTag, entry.keyId), failure('AUDIT_AUTHENTICATION_FAILED'));
    await assert.rejects(store.decryptAuditLog(e.encryptedData, e.iv, null, e.keyId), failure('AUDIT_ENVELOPE_INVALID'));
    await assert.rejects(store.decryptAuditLog(e.encryptedData, e.iv, e.authTag, 'not-found'), failure('AUDIT_KEY_UNAVAILABLE'));
    await pool.query("UPDATE audit_logs SET action='altered-binding' WHERE id=$1", [firstId]);
    await assert.rejects(store.readEncryptedAuditLog(firstId), failure('AUDIT_AUTHENTICATION_FAILED'));
    await pool.query("UPDATE audit_logs SET action='crypto-private' WHERE id=$1", [firstId]);
  });
  await t.test('forced and automatic expiry rotation create different keys and retain all old decryptability', async () => {
    const before = (await pool.query('SELECT * FROM encryption_keys WHERE id=$1', [firstKey])).rows[0];
    const rotate = await store.rotateEncryptionKey({
      actor: owner
    });
    assert.notEqual(rotate.newKeyId, firstKey);
    assert.equal((await pool.query('SELECT is_active FROM encryption_keys WHERE id=$1', [firstKey])).rows[0].is_active, false);
    assert.deepEqual((await pool.query('SELECT encrypted_key FROM encryption_keys WHERE id=$1', [firstKey])).rows[0].encrypted_key, before.encrypted_key);
    assert.deepEqual((await second.readEncryptedAuditLog(firstId)).data.actionData, payload);
    await pool.query("UPDATE encryption_keys SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [rotate.newKeyId]);
    const next = await second.encryptAuditLog({
      new: true
    });
    assert.notEqual(next.keyId, rotate.newKeyId);
    const row = (await pool.query('SELECT rotated_from,key_version,expires_at-created_at AS lifetime FROM encryption_keys WHERE id=$1', [next.keyId])).rows[0];
    assert.equal(row.rotated_from, rotate.newKeyId);
    assert.equal(row.key_version, 3);
    assert.equal(row.lifetime.days, 90);
    assert.equal((await pool.query("SELECT is_active FROM encryption_keys WHERE id='unrelated-purpose-key'")).rows[0].is_active, true);
  });
  await t.test('new master selection rotates wrapping while old configured master versions still decrypt', async () => {
    const nextProvider = new EnvironmentKeyProvider({
      keys: {
        a: masterA,
        b: masterB
      },
      activeKeyId: 'b',
      nodeEnv: 'test'
    });
    const next = new EncryptedAuditStore({
      pool,
      provider: nextProvider,
      nodeEnv: 'test'
    });
    try {
      const envelope = await next.encryptAuditLog({
        master: 'b'
      });
      const stored = JSON.parse((await pool.query('SELECT encrypted_key FROM encryption_keys WHERE id=$1', [envelope.keyId])).rows[0].encrypted_key.toString('utf8'));
      assert.equal(stored.masterKeyId, 'b');
      assert.deepEqual((await next.readEncryptedAuditLog(firstId)).data.actionData, payload);
    } finally {
      await next.close();
      nextProvider.close();
    }
  });
  await t.test('query filters use canonical identifiers and report legacy incomplete records without plaintext fallback', async () => {
    await pool.query("INSERT INTO audit_logs(user_id,action,details) VALUES($1,'legacy-plaintext',$2)", [other, {
      mustNotLeak: 'fixture-private-legacy'
    }]);
    const rows = await store.queryDecryptedAuditLogs({
      userId: other
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].error, 'AUDIT_LEGACY_UNENCRYPTED_OR_INCOMPLETE');
    assert.ok(!JSON.stringify(rows).includes('fixture-private-legacy'));
    const own = await store.queryDecryptedAuditLogs({
      userId: owner,
      action: 'crypto-private',
      startDate: '2020-01-01',
      endDate: '2100-01-01'
    }, 1);
    assert.equal(own.length, 1);
    assert.deepEqual(own[0].data.actionData, payload);
    for (const args of [[{}, 0], [{
      unknown: 'no'
    }, 10], [{
      startDate: 'invalid'
    }, 10], [{
      startDate: '2030-01-01',
      endDate: '2020-01-01'
    }, 10]]) await assert.rejects(store.queryDecryptedAuditLogs(...args));
    await assert.rejects(store.readEncryptedAuditLog('9223372036854775808'), failure('AUDIT_ID_INVALID'));
    await assert.rejects(store.readEncryptedAuditLog('99999999'), failure('AUDIT_NOT_FOUND'));
  });
  await t.test('provider refusal and post-insert storage failure roll back new keys and audit rows together', async () => {
    const before = (await pool.query("SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id")).rows;
    const rejecting = {
      kind: 'environment',
      activeKeyId: 'refused-master',
      generate: async () => {
        const e = new Error('AUDIT_KMS_UNAVAILABLE');
        e.code = e.message;
        throw e;
      }
    };
    const denied = new EncryptedAuditStore({
      pool,
      provider: rejecting,
      nodeEnv: 'test'
    });
    await assert.rejects(denied.writeEncryptedAuditLog({
      userId: owner,
      action: 'refused-write',
      actionData: payload
    }), failure('AUDIT_KMS_UNAVAILABLE'));
    await denied.close();
    assert.deepEqual((await pool.query('SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id')).rows, before);
    await pool.query("CREATE FUNCTION refuse_crypto_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'owned fixture update refusal'; END$$");
    await pool.query('CREATE TRIGGER refuse_crypto_update BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION refuse_crypto_update()');
    // Expiry requires a new work key in the same transaction as the failed write.
    await pool.query("UPDATE encryption_keys SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id LIKE 'audit1:%' AND is_active");
    const keys = (await pool.query("SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id")).rows;
    try {
      await assert.rejects(store.writeEncryptedAuditLog({
        userId: owner,
        action: 'refused-write',
        actionData: payload
      }), /owned fixture update refusal/);
    } finally {
      await pool.query('DROP TRIGGER refuse_crypto_update ON audit_logs');
      await pool.query('DROP FUNCTION refuse_crypto_update()');
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='refused-write'")).rows[0].n, 0);
    assert.deepEqual((await pool.query('SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id')).rows, keys);
    assert.deepEqual((await store.readEncryptedAuditLog(firstId)).data.actionData, payload);
  });
  await t.test('failed key insertion retains active history and wipes the actual generated work-key buffer', async () => {
    const before = (await pool.query('SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id')).rows;
    const original = provider.generate.bind(provider);
    let generated;
    provider.generate = async context => {
      const value = await original(context);
      generated = value.key;
      return value;
    };
    try {
      await assert.rejects(store.rotateEncryptionKey({
        actor: 'invalid-uuid'
      }), failure('AUDIT_SUBJECT_INVALID'));
      assert.ok(generated);
      assert.deepEqual(generated, Buffer.alloc(32));
    } finally {
      provider.generate = original;
    }
    assert.deepEqual((await pool.query('SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id')).rows, before);
    assert.deepEqual((await store.readEncryptedAuditLog(firstId)).data.actionData, payload);
  });
  await t.test('malformed wrapped material, conflicting active keys and wrong namespace cannot yield plaintext', async () => {
    const envelope = await store.encryptAuditLog(payload),
      row = (await pool.query('SELECT * FROM encryption_keys WHERE id=$1', [envelope.keyId])).rows[0];
    await pool.query('UPDATE encryption_keys SET encrypted_key=$1 WHERE id=$2', [Buffer.from('not-json'), envelope.keyId]);
    try {
      await assert.rejects(store.encryptAuditLog(payload), failure('AUDIT_KEY_ENVELOPE_INVALID'));
      await assert.rejects(store.decryptAuditLog(envelope.encryptedData, envelope.iv, envelope.authTag, envelope.keyId), failure('AUDIT_KEY_ENVELOPE_INVALID'));
    } finally {
      await pool.query('UPDATE encryption_keys SET encrypted_key=$1 WHERE id=$2', [row.encrypted_key, envelope.keyId]);
    }
    const wrong = new EncryptedAuditStore({
      pool,
      provider,
      nodeEnv: 'test',
      namespace: 'different-deployment'
    });
    try {
      await assert.rejects(wrong.decryptAuditLog(envelope.encryptedData, envelope.iv, envelope.authTag, envelope.keyId), failure('AUDIT_AUTHENTICATION_FAILED'));
    } finally {
      await wrong.close();
    }
    await pool.query("INSERT INTO encryption_keys(id,encrypted_key,is_active) VALUES('audit1:conflicting-fixture',$1,TRUE)", [row.encrypted_key]);
    try {
      await assert.rejects(store.encryptAuditLog(payload), failure('AUDIT_ACTIVE_KEY_CONFLICT'));
    } finally {
      await pool.query("UPDATE encryption_keys SET is_active=FALSE WHERE id='audit1:conflicting-fixture'");
    }
  });
  await t.test('legacy BYTEA wrapping is read only with an explicit retained master and a complete authentic tag', async () => {
    const key = crypto.randomBytes(32),
      keyId = 'legacy-fixture-workkey';
    const wrapped = seal(key, masterA, null),
      cipher = seal(Buffer.from(JSON.stringify(payload)), key, null);
    key.fill(0);
    await pool.query('INSERT INTO encryption_keys(id,encrypted_key,is_active) VALUES($1,$2,FALSE)', [keyId, Buffer.from([wrapped.iv, wrapped.ciphertext, wrapped.tag].join(':'))]);
    assert.deepEqual(await store.decryptAuditLog(cipher.ciphertext, cipher.iv, cipher.tag, keyId), payload);
    const noLegacyProvider = new EnvironmentKeyProvider({
        keys: {
          a: masterA
        },
        activeKeyId: 'a',
        nodeEnv: 'test'
      }),
      noLegacy = new EncryptedAuditStore({
        pool,
        provider: noLegacyProvider,
        nodeEnv: 'test'
      });
    try {
      await assert.rejects(noLegacy.decryptAuditLog(cipher.ciphertext, cipher.iv, cipher.tag, keyId), failure('AUDIT_LEGACY_MASTER_KEY_REQUIRED'));
    } finally {
      await noLegacy.close();
      noLegacyProvider.close();
    }
    await assert.rejects(store.decryptAuditLog(cipher.ciphertext, cipher.iv, null, keyId), failure('AUDIT_ENVELOPE_INVALID'));
  });
  await t.test('real overlapping rotation and writes complete without duplicate active keys or lost decryptability', async () => {
    const jobs = await Promise.all([store.rotateEncryptionKey({
      actor: owner
    }), second.writeEncryptedAuditLog({
      userId: owner,
      action: 'rotation-race',
      actionData: payload
    }), store.rotateEncryptionKey({
      actor: other
    }), second.encryptAuditLog(payload)]);
    assert.notEqual(jobs[0].newKeyId, jobs[2].newKeyId);
    assert.deepEqual((await store.readEncryptedAuditLog(jobs[1])).data.actionData, payload);
    assert.deepEqual(await store.decryptAuditLog(jobs[3].encryptedData, jobs[3].iv, jobs[3].authTag, jobs[3].keyId), payload);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM encryption_keys WHERE id LIKE 'audit1:%' AND is_active")).rows[0].n, 1);
  });
  await t.test('sensitive access retains a full row-bound envelope while reason, field names and IP stay encrypted', async () => {
    const input = {
      userId: owner,
      accessedBy: other,
      resourceType: 'user',
      resourceId: owner,
      accessedFields: ['email', 'phone'],
      accessReason: 'fixture-private-review',
      ipAddress: '192.0.2.99',
      userAgent: 'fixture-private-agent'
    };
    const logId = await store.writeSensitiveDataAccess(input),
      row = (await pool.query('SELECT * FROM sensitive_data_access_logs WHERE id=$1', [logId])).rows[0];
    assert.deepEqual(row.accessed_fields, []);
    assert.equal(row.access_reason, null);
    assert.equal(row.retention_days, 90);
    assert.ok(Buffer.isBuffer(row.encrypted_ip_address));
    assert.ok(!row.encrypted_ip_address.includes(Buffer.from('fixture-private')));
    const envelope = JSON.parse(row.encrypted_ip_address.toString('utf8'));
    assert.equal(envelope.iv.length, 32);
    assert.equal(envelope.tag.length, 32);
    assert.equal(envelope.keyId, row.encryption_key_id);
    const logs = await second.querySensitiveDataAccessLogs({
      userId: owner,
      accessedBy: other,
      startDate: '2020-01-01',
      endDate: '2100-01-01'
    }, 5);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].accessedFields, input.accessedFields);
    assert.equal(logs[0].accessReason, input.accessReason);
    assert.equal(logs[0].ipAddress, input.ipAddress);
    await pool.query("UPDATE sensitive_data_access_logs SET resource_type='altered' WHERE id=$1", [logId]);
    assert.equal((await store.querySensitiveDataAccessLogs({
      userId: owner
    }))[0].error, 'AUDIT_AUTHENTICATION_FAILED');
    await pool.query("UPDATE sensitive_data_access_logs SET resource_type='user' WHERE id=$1", [logId]);
    await pool.query("INSERT INTO sensitive_data_access_logs(user_id,accessed_by,resource_type,resource_id,accessed_fields,access_reason) VALUES($1,$2,'user',$1,ARRAY['legacy-private-field'],'fixture-private-legacy')", [owner, other]);
    const all = await store.querySensitiveDataAccessLogs({
      userId: owner
    });
    assert.equal(all.filter(row => row.error === 'AUDIT_LEGACY_UNENCRYPTED_OR_INCOMPLETE').length, 1);
    assert.ok(!JSON.stringify(all).includes('fixture-private-legacy'));
    for (const [filters, limit] of [[{}, 10], [{
      userId: owner
    }, 0], [{
      userId: owner,
      unknown: true
    }, 10], [{
      userId: owner,
      startDate: 'invalid'
    }, 10]]) await assert.rejects(store.querySensitiveDataAccessLogs(filters, limit));
    await assert.rejects(store.writeSensitiveDataAccess({
      ...input,
      accessedFields: []
    }), failure('AUDIT_INPUT_INVALID'));
  });
  await t.test('a preceding schema cannot silently borrow audit relations or keys from a later search path', async () => {
    const shadow = schema + '_shadow';
    await pool.query('CREATE SCHEMA ' + shadow);
    const source = new URL(url);
    source.searchParams.set('options', '-c search_path=' + shadow + ',' + schema + ',public');
    const shadowPool = new Pool({
      connectionString: source.toString(),
      max: 1
    });
    const shadowStore = new EncryptedAuditStore({
      pool: shadowPool,
      provider,
      nodeEnv: 'test'
    });
    try {
      await assert.rejects(shadowStore.encryptAuditLog(payload), failure('AUDIT_SCHEMA_MISMATCH'));
      assert.equal(shadowStore.namespace, null);
    } finally {
      await shadowStore.close();
      await shadowPool.end();
      await pool.query('DROP SCHEMA ' + shadow);
    }
  });
  await t.test('metadata preserves historical wall clocks and real instants across process/database timezones', async () => {
    const wall = '2020-02-03 04:05:06.123456';
    const legacy = (await pool.query("INSERT INTO audit_logs(user_id,action,created_at,timestamp) VALUES($1,'timezone-legacy',$2,NULL) RETURNING id::text", [owner, wall])).rows[0].id;
    const known = (await pool.query("INSERT INTO audit_logs(user_id,action,created_at,timestamp) VALUES($1,'timezone-known',$2,'2020-02-03T04:05:06.123Z') RETURNING id::text", [owner, wall])).rows[0].id;
    const script = `const common=require('./backend/shared/auditLog');const audit=require('./backend/shared/auditLogEncrypted');const db=require('./backend/shared/db');(async()=>{try{const rows=await common.getUserAuditLogs(process.env.AUDIT_FIXTURE_OWNER,{},db);process.stdout.write(JSON.stringify(rows.filter(row=>row.action.startsWith('timezone-')).map(row=>({id:row.id,wall:row.created_at,instant:row.timestamp}))));}finally{await audit.closeAuditEncryption();await db.closePools();}})().catch(()=>{process.stderr.write('wallclock-query-failed');process.exitCode=1;});`;
    for (const processZone of ['UTC', 'Asia/Shanghai']) for (const databaseZone of ['UTC', 'America/New_York']) {
      const source = new URL(url);
      source.searchParams.set('options', source.searchParams.get('options') + ' -c timezone=' + databaseZone);
      const child = spawn(process.execPath, ['-e', script], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TZ: processZone,
          LOG_LEVEL: 'error',
          DATABASE_URL: source.toString(),
          AUDIT_FIXTURE_OWNER: owner,
          AUDIT_KMS_KEY_ID: '',
          MASTER_ENCRYPTION_KEY: '',
          AUDIT_MASTER_KEY_ID: 'a',
          AUDIT_MASTER_KEYS_JSON: JSON.stringify({
            a: masterA.toString('hex')
          })
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', data => {
        stdout += data;
      });
      child.stderr.on('data', data => {
        stderr += data;
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
      try {
        assert.equal(await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', resolve);
        }), 0, stderr);
        const rows = JSON.parse(stdout);
        assert.deepEqual(rows.find(row => row.id === legacy), {
          id: legacy,
          wall,
          instant: null
        }, processZone + '/' + databaseZone);
        assert.deepEqual(rows.find(row => row.id === known), {
          id: known,
          wall,
          instant: '2020-02-03T04:05:06.123Z'
        }, processZone + '/' + databaseZone);
      } finally {
        clearTimeout(timer);
      }
    }
    assert.equal((await pool.query('SELECT created_at::text AS wall,timestamp FROM audit_logs WHERE id=$1', [legacy])).rows[0].wall, wall);
  });
  await t.test('actual lazy facade and sensitive access module use DATABASE_URL across a new process and close owned providers', async () => {
    const script = `const assert=require('node:assert/strict');const audit=require('./backend/shared/auditLogEncrypted');const access=require('./backend/shared/sensitiveDataAudit');const common=require('./backend/shared/auditLog');const db=require('./backend/shared/db');
      (async()=>{const input=JSON.parse(process.env.AUDIT_FIXTURE_INPUT);try{
        const id=await audit.writeEncryptedAuditLog({userId:input.owner,action:'facade-process',actionData:{value:'fixture-private-child'}});
        assert.equal((await audit.readEncryptedAuditLog(id)).data.actionData.value,'fixture-private-child');
        assert.equal(await access.logSensitiveDataAccess({resourceType:'untracked',accessedFields:['ordinary']}),null);
        const sid=await access.logSensitiveDataAccess({userId:input.owner,accessedBy:input.other,resourceType:'user',resourceId:input.owner,accessedFields:['email'],accessReason:'fixture-private-child-reason',ipAddress:'192.0.2.101'});
        const logs=await access.querySensitiveDataAccessLogs({userId:input.owner});assert.ok(logs.some(row=>row.id===sid&&row.accessReason==='fixture-private-child-reason'));
        const report=await access.generateSensitiveAccessReport({userId:input.owner});assert.ok(report.stats.unavailableAccesses>=1);
        assert.ok((await audit.getEncryptionKeyStatus()).some(row=>row.isActive));await audit.rotateEncryptionKey();
        assert.equal((await audit.readEncryptedAuditLog(id)).data.actionData.value,'fixture-private-child');
        const metadata=await common.getSystemAuditLogs({},db);assert.ok(metadata.length);assert.ok(metadata.every(row=>row.detailsUnavailable));assert.ok(!JSON.stringify(metadata).includes('fixture-private'));
        const express=require('./backend/node_modules/express');const app=express();app.locals.db=db;
        app.get('/common',(req,res,next)=>{req.user={sub:input.owner};next();},common.auditMiddleware('common-http',()=>({value:'fixture-private-common-http'})),(req,res)=>res.json({value:'fixture-private-common-response'}));
        app.get('/fixture/:id',(req,res,next)=>{req.user={sub:input.other};next();},access.sensitiveDataAccessMiddleware({resourceType:'user',sensitiveFields:['email']}),(req,res)=>res.json({email:0}));
        const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        try{const url='http://127.0.0.1:'+server.address().port+'/fixture/'+input.owner;
          const commonUrl='http://127.0.0.1:'+server.address().port+'/common';
          const commonSuccess=await fetch(commonUrl);assert.equal(commonSuccess.status,200);assert.equal((await commonSuccess.json()).value,'fixture-private-common-response');
          const success=await fetch(url);assert.equal(success.status,200);assert.deepEqual(await success.json(),{email:0});
          await audit.closeAuditEncryption();process.env.AUDIT_MASTER_KEYS_JSON='{}';
          const commonRefused=await fetch(commonUrl);assert.equal(commonRefused.status,503);assert.deepEqual(await commonRefused.json(),{error:'AUDIT_WRITE_FAILED'});
          const refused=await fetch(url);assert.equal(refused.status,503);assert.deepEqual(await refused.json(),{error:'SENSITIVE_ACCESS_AUDIT_UNAVAILABLE'});
        }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        process.stdout.write('fixture-facade-complete');
      }finally{await audit.closeAuditEncryption();await audit.closeAuditEncryption();await db.closePools();}})().catch(()=>{process.stderr.write('fixture-facade-failed');process.exitCode=1;});`;
    const child = spawn(process.execPath, ['-e', script], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        SERVICE_NAME: 'audit-crypto-fixture',
        DATABASE_URL: url,
        MASTER_ENCRYPTION_KEY: '',
        AUDIT_KMS_KEY_ID: '',
        AUDIT_MASTER_KEYS_JSON: JSON.stringify({
          a: masterA.toString('hex'),
          b: masterB.toString('hex')
        }),
        AUDIT_MASTER_KEY_ID: 'a',
        AUDIT_KEY_NAMESPACE: '',
        AUDIT_FIXTURE_INPUT: JSON.stringify({
          owner,
          other
        })
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    try {
      assert.equal(await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', resolve);
      }), 0, stderr);
      assert.ok(stdout.includes('fixture-facade-complete'));
      assert.ok(!stdout.includes('fixture-private'));
      assert.ok(!stderr.includes('fixture-private'));
      assert.ok(!stderr.includes(masterA.toString('hex')));
    } finally {
      clearTimeout(timer);
    }
  });
  await t.test('borrowed audit clients never commit business work and savepoint failure leaves caller transaction usable', async () => {
    await pool.query('CREATE TABLE audit_business_fixture(id UUID PRIMARY KEY,value INTEGER NOT NULL)');
    const client = await pool.connect();
    const scoped = new EncryptedAuditStore({
      transactionClient: client,
      provider,
      nodeEnv: 'test'
    });
    const marker = crypto.randomUUID();
    try {
      await assert.rejects(scoped.writeEncryptedAuditLog({
        userId: owner,
        action: 'outside-transaction'
      }), error => error.code === '25P01');
      assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive, 1);
      await client.query('BEGIN');
      await client.query('INSERT INTO audit_business_fixture VALUES($1,1)', [marker]);
      const value = await scoped.writeEncryptedAuditLog({
        userId: owner,
        action: 'caller-rollback',
        actionData: {
          private: 'fixture-private-business'
        }
      });
      assert.equal((await client.query('SELECT count(*)::int AS n FROM audit_logs WHERE id=$1', [value])).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='caller-rollback'")).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_business_fixture')).rows[0].n, 0);
      await client.query('ROLLBACK');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='caller-rollback'")).rows[0].n, 0);
      await client.query('BEGIN');
      await client.query('INSERT INTO audit_business_fixture VALUES($1,2)', [marker]);
      const committed = await scoped.writeEncryptedAuditLog({
        userId: owner,
        action: 'caller-commit',
        actionData: {
          ok: true
        },
        requestId: 'fixture-request'
      });
      await client.query('COMMIT');
      assert.equal((await pool.query('SELECT value FROM audit_business_fixture WHERE id=$1', [marker])).rows[0].value, 2);
      assert.equal((await store.readEncryptedAuditLog(committed)).data.requestId, 'fixture-request');
      await pool.query("ALTER TABLE audit_logs ADD CONSTRAINT refuse_caller_audit CHECK(action<>'caller-refused') NOT VALID");
      const before = (await pool.query('SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id')).rows;
      await client.query('BEGIN');
      await client.query('UPDATE audit_business_fixture SET value=3 WHERE id=$1', [marker]);
      await assert.rejects(scoped.writeEncryptedAuditLog({
        userId: owner,
        action: 'caller-refused'
      }), error => error.code === '23514');
      assert.equal((await client.query('SELECT value FROM audit_business_fixture WHERE id=$1', [marker])).rows[0].value, 3, 'audit savepoint rollback must not abort or commit the caller');
      await client.query('ROLLBACK');
      assert.equal((await pool.query('SELECT value FROM audit_business_fixture WHERE id=$1', [marker])).rows[0].value, 2);
      assert.deepEqual((await pool.query('SELECT id,is_active,encrypted_key FROM encryption_keys ORDER BY id')).rows, before);
      await scoped.close();
      assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive, 1);
    } finally {
      await client.query('ROLLBACK');
      await scoped.close();
      client.release();
      await pool.query('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS refuse_caller_audit');
    }
  });
  await t.test('bounded authenticated service filtering preserves cursor progress and refuses invalid instants and filters',async()=>{
    const first=await store.writeEncryptedAuditLog({userId:owner,action:'page-fixture',service:'chosen',actionData:{number:1}});
    await store.writeEncryptedAuditLog({userId:owner,action:'page-fixture',service:'other',actionData:{number:2}});
    const last=await store.writeEncryptedAuditLog({userId:owner,action:'page-fixture',service:'chosen',actionData:{number:3}});
    const page=await store.queryAuditPage({user_id:owner,action:'page-fixture',service:'chosen',limit:'1',start_date:'2000-01-01T00:00:00Z',end_date:'2099-01-01T00:00:00Z'});
    assert.deepEqual(page.items.map(r=>r.id),[last]);assert.equal(page.complete,false);assert.equal(page.nextCursor,last);assert.equal(page.scanned,1);
    const next=await store.queryAuditPage({user_id:owner,action:'page-fixture',service:'chosen',before_id:page.nextCursor});
    assert.deepEqual(next.items.map(r=>r.id),[first]);assert.equal(next.complete,true);assert.equal(next.nextCursor,null);assert.equal(next.scanned,2);
    const unfiltered=await store.queryAuditPage({action:'page-fixture'});assert.equal(unfiltered.items.length,3);assert.equal(unfiltered.complete,true);
    await pool.query("UPDATE audit_logs SET timestamp='2020-01-01T01:02:03.123456Z' WHERE id=$1",[first]);
    const exact=await store.queryAuditPage({action:'page-fixture',end_date:'2020-01-01T01:02:03.123456Z',start_date:'2020-01-01T01:02:03.123455Z'});assert.deepEqual(exact.items.map(row=>row.id),[first]);assert.equal(exact.items[0].timestamp,'2020-01-01T01:02:03.123456Z');
    await assert.rejects(store.queryAuditPage({start_date:'2020-01-01T01:02:03.123456Z',end_date:'2020-01-01T01:02:03.123455Z'}),error=>error.code==='AUDIT_DATE_INVALID');
    const empty=await store.queryAuditPage({action:'page-fixture',service:'absent'});assert.equal(empty.items.length,0);assert.equal(empty.complete,true);
    for(const filter of [null,[],{unknown:'x'},{limit:'0'},{limit:'51'},{limit:'1abc'},{limit:1},{service:''},{before_id:'0'},{start_date:'2020-01-01'},{start_date:'bad'},{start_date:'2020-02-31T00:00:00Z'},{start_date:'2099-01-01T00:00:00Z',end_date:'2000-01-01T00:00:00Z'}])await assert.rejects(store.queryAuditPage(filter),error=>error.status===400);
  });
  await t.test('genuine timestamp filters preserve microseconds, offsets and the legacy UTC date-only contract',()=>{
    const {instant}=require('../../shared/audit/cryptoPrimitives');
    assert.equal(instant('2020-01-01T01:02:03.123456Z').microseconds,instant('2020-01-01T06:32:03.123456+05:30').microseconds);
    assert.equal(instant('2020-01-01').sql,'2020-01-01T00:00:00.000Z');assert.equal(instant(new Date('2020-01-01T00:00:00Z')).sql,'2020-01-01T00:00:00.000Z');
    for(const input of [null,1,new Date('bad'),'2020-01-01T00:00:00.1234567Z','2020-02-31T00:00:00Z'])assert.throws(()=>instant(input),error=>error.code==='AUDIT_DATE_INVALID');
    assert.throws(()=>instant('2020-01-01',{allowDateOnly:false}),error=>error.code==='AUDIT_DATE_INVALID');
  });
  await t.test('a full candidate page does not lose encrypted service matches in the unscanned tail',async()=>{
    const wanted=await store.writeEncryptedAuditLog({userId:owner,action:'page-scan',service:'tail',actionData:{ok:true}});
    for(let i=0;i<200;i++)await store.writeEncryptedAuditLog({userId:owner,action:'page-scan',service:'noise',actionData:{i}});
    const first=await store.queryAuditPage({action:'page-scan',service:'tail'});assert.equal(first.scanned,200);assert.deepEqual(first.items,[]);assert.equal(first.complete,false);assert.ok(first.nextCursor);
    const next=await store.queryAuditPage({action:'page-scan',service:'tail',before_id:first.nextCursor});assert.deepEqual(next.items.map(row=>row.id),[wanted]);assert.equal(next.complete,true);
  });
  await t.test('bounded plaintext pages keep the first unreturned record available after the byte ceiling',async()=>{
    const ids=[];for(let i=0;i<9;i++)ids.push(await store.writeEncryptedAuditLog({userId:owner,action:'page-bytes',service:'bytes',actionData:{value:'x'.repeat(950000),i}}));
    const first=await store.queryAuditPage({action:'page-bytes'});assert.ok(first.items.length>0&&first.items.length<9);assert.equal(first.complete,false);assert.ok(Buffer.byteLength(JSON.stringify(first))<8*1024*1024);
    const next=await store.queryAuditPage({action:'page-bytes',before_id:first.nextCursor});assert.equal(next.complete,true);assert.deepEqual([...first.items,...next.items].map(row=>row.id),ids.reverse());
  });
  await t.test('canonical partition conversion and int64 IDs preserve authenticated reads and caller-owned pool', async () => {
    await apply(pool, await read('database/pending/20261008_140000__audit_partition_conversion.sql'));
    const sequence = (await pool.query("SELECT pg_get_serial_sequence('audit_logs_default','id') AS name")).rows[0].name;
    assert.ok(sequence, 'the canonical sequence stays owned by retained default storage');
    await pool.query('SELECT setval($1::regclass,9007199254740993,true)', [sequence]);
    const value = await second.writeEncryptedAuditLog({
      userId: owner,
      action: 'partition-crypto',
      actionData: payload
    });
    assert.equal(value, '9007199254740994');
    assert.deepEqual((await store.readEncryptedAuditLog(value)).data.actionData, payload);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log_identity WHERE id=$1", [value])).rows[0].n, 1);
    await second.close();
    await assert.rejects(second.encryptAuditLog(payload), failure('AUDIT_STORE_CLOSED'));
    assert.equal((await pool.query('SELECT 1 AS alive')).rows[0].alive, 1);
    const key = await provider.generate({
      test: 'caller-provider-survives-close'
    });
    key.key.fill(0);
  });
}));
