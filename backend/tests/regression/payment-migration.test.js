'use strict';

const {
    test
  } = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  {
    Pool
  } = require('pg');
const {
    parseMigrationFile
  } = require('../../../database/migrate'),
  {
    migrationStatements
  } = require('../../../database/sqlStatements');
const root = path.resolve(__dirname, '../../..');
test('payment additive migration preserves retained order history and refuses customized identities', {
  timeout: 60000
}, async t => {
  assert.ok(process.env.TEST_DATABASE_URL);
  const admin = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 1
  });
  const raw = await fs.readFile(path.join(root, 'database/pending/20261025_120000__payment_order_integrity.sql'), 'utf8'),
    parsed = parseMigrationFile(raw);
  const schemas = [];
  const setup = async () => {
    const schema = 'payment_migration_' + crypto.randomBytes(8).toString('hex');
    schemas.push(schema);
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
      options: '-c search_path=' + schema + ',public'
    });
    await pool.query(await fs.readFile(path.join(root, 'database/migrations/V1__initial_schema.sql'), 'utf8'));
    return pool;
  };
  const apply = async (pool, sql) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const statement of migrationStatements(sql)) await c.query(statement);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  };
  try {
    await t.test('UUID order, legacy FAILED state, exact wall microseconds, view, FK and money survive; new owner binding is enforced', async () => {
      const pool = await setup();
      try {
        const owner = crypto.randomUUID(),
          other = crypto.randomUUID(),
          order = crypto.randomUUID();
        await pool.query("INSERT INTO users(id,nickname) VALUES($1,'owned'),($2,'other')", [owner, other]);
        await pool.query("INSERT INTO orders(id,user_id,idempotency_key,product_id,product_name,amount_fen,premium_coins_grant,status,created_at) VALUES($1,$2,'retained-history','coins_60','retained',600,60,'FAILED',TIMESTAMP '2001-02-03 04:05:06.123456')", [order, owner]);
        await pool.query('CREATE VIEW retained_order_view AS SELECT * FROM orders;CREATE TABLE retained_order_reference(id uuid REFERENCES orders(id))');
        await pool.query('INSERT INTO retained_order_reference VALUES($1)', [order]);
        const before = (await pool.query('SELECT row_to_json(o) AS row FROM orders o')).rows[0].row,
          oid = (await pool.query("SELECT 'orders'::regclass::oid AS oid")).rows[0].oid;
        await apply(pool, parsed.up);
        const after = (await pool.query('SELECT row_to_json(o) AS row FROM orders o')).rows[0].row;
        for (const [k, v] of Object.entries(before)) assert.deepEqual(after[k], v);
        assert.equal(after.quantity, null);
        assert.deepEqual((await pool.query('SELECT row_to_json(v) AS row FROM retained_order_view v')).rows[0].row, before);
        assert.equal((await pool.query("SELECT 'orders'::regclass::oid AS oid")).rows[0].oid, oid);
        assert.equal((await pool.query('SELECT id FROM retained_order_reference')).rows[0].id, order);
        await assert.rejects(pool.query("INSERT INTO payment_order_requests(user_id,key_hash,request_hash,order_id) VALUES($1,$2,$3,$4)", [other, 'a'.repeat(64), 'b'.repeat(64), order]), {
          code: '23503'
        });
        await pool.query('INSERT INTO payment_order_requests(user_id,key_hash,request_hash,order_id) VALUES($1,$2,$3,$4)', [owner, 'a'.repeat(64), 'b'.repeat(64), order]);
        assert.equal((await pool.query('SELECT extract(epoch FROM expires_at-created_at)::int AS ttl FROM payment_order_requests')).rows[0].ttl, 86400);
        await assert.rejects(apply(pool, parsed.down), /Retain payment/);
        assert.equal((await pool.query('SELECT status FROM orders')).rows[0].status, 'FAILED');
      } finally {
        await pool.end();
      }
    });
    await t.test('empty reversal removes only new empty structures and retains PostgreSQL enum labels', async () => {
      const pool = await setup();
      try {
        await apply(pool, parsed.up);
        await apply(pool, parsed.down);
        assert.equal((await pool.query("SELECT to_regclass('payment_settlements') AS relation")).rows[0].relation, null);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='orders'::regclass AND attname='quantity' AND NOT attisdropped")).rows[0].n, 0);
        const labels = (await pool.query("SELECT enumlabel FROM pg_enum WHERE enumtypid='order_status_enum'::regtype")).rows.map(x => x.enumlabel);
        for (const label of ['FAILED', 'CANCELLED', 'FULFILLED']) assert.ok(labels.includes(label));
        await apply(pool, parsed.up);
      } finally {
        await pool.end();
      }
    });
    await t.test('a UUID alias foreign key is not the real owner identity and refusal changes no historical schema/data', async () => {
      const pool = await setup();
      try {
        await pool.query('ALTER TABLE users ADD COLUMN alternate_id uuid UNIQUE;ALTER TABLE orders DROP CONSTRAINT orders_user_id_fkey;ALTER TABLE orders ADD CONSTRAINT custom_owner_fk FOREIGN KEY(user_id) REFERENCES users(alternate_id)');
        await assert.rejects(apply(pool, parsed.up), /explicit adoption/);
        assert.equal((await pool.query("SELECT to_regclass('payment_order_requests') AS relation")).rows[0].relation, null);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_enum WHERE enumtypid='order_status_enum'::regtype")).rows[0].n, 4);
      } finally {
        await pool.end();
      }
    });
  } finally {
    for (const schema of schemas) await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
