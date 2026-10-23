'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const request = require('supertest');
const { createRewardApp } = require('../../services/reward-service/src');
const { signAccess } = require('../../shared/auth');
const { parseMigrationFile } = require('../../../database/migrate');
const { migrationStatements } = require('../../../database/sqlStatements');
const root = path.resolve(__dirname, '../../..');
const repair = 'database/pending/repairs/20260614_090500__add_daily_quest_system.sql';

async function fixture(fn) {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema = `daily_quest_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, max: 15 });
  const db = {
    query: pool.query.bind(pool),
    transaction: async fn => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  };
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  try {
    await pool.query(await fs.readFile(path.join(root, 'database/migrations/V1__initial_schema.sql'), 'utf8'));
    await pool.query(await fs.readFile(path.join(root, 'database/seeds/V2__seed_data.sql'), 'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)', [owner,'quest-owner',other,'quest-other']);
    await fn({ pool, db, owner, other, app: createRewardApp({ db }), token: signAccess({ id: owner }), foreignToken: signAccess({ id: other }) });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}

async function apply(db) {
  const parsed = parseMigrationFile(await fs.readFile(path.join(root, repair), 'utf8'));
  await db.transaction(async client => { for (const sql of migrationStatements(parsed.up)) await client.query(sql); });
}

test('quest repair preserves canonical daily history and implements exact date indexes', async t => fixture(async ({ pool, db, owner, other }) => {
  await pool.query(`INSERT INTO daily_quests(user_id,quest_date,catch_current,completed_at)
    VALUES($1,'2020-01-01',3,'2020-01-01')`, [owner]);
  const before = (await pool.query('SELECT * FROM daily_quests')).rows;
  const oid = (await pool.query("SELECT 'daily_quests'::regclass::oid AS id")).rows[0].id;
  await apply(db);
  await t.test('original IDs, progress, dates, relation and exact seed catalog survive', async () => {
    assert.deepEqual((await pool.query('SELECT * FROM daily_quests')).rows, before);
    assert.equal((await pool.query("SELECT 'daily_quests'::regclass::oid AS id")).rows[0].id, oid);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM quest_definitions')).rows[0].n, 22);
    assert.equal((await pool.query('SELECT count(DISTINCT quest_type)::int AS n FROM quest_definitions')).rows[0].n, 7);
    const raw = await fs.readFile(path.join(root,'database/pending/20260614_090500__add_daily_quest_system.sql'),'utf8');
    const repaired = await fs.readFile(path.join(root,repair),'utf8');
    assert.equal(repaired.slice(repaired.indexOf('-- 种子数据')), raw.slice(raw.indexOf('-- 种子数据')));
  });
  const definition = (await pool.query('SELECT id FROM quest_definitions LIMIT 1')).rows[0].id;
  const insert = (user,date) => pool.query(`INSERT INTO player_quests(user_id,quest_definition_id,quest_pool,progress_target,assigned_at,expires_at)
    VALUES($1,$2,'daily',5,$3,'2020-01-04')`, [user,definition,date]);
  await insert(owner,'2020-01-01 00:01');
  await t.test('two assignment times on the same calendar date conflict', async () => {
    await assert.rejects(insert(owner,'2020-01-01 23:59'), /unique_user_quest/);
  });
  await t.test('another owner or another date remains a distinct assignment', async () => {
    await insert(other,'2020-01-01'); await insert(owner,'2020-01-02');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM player_quests')).rows[0].n,3);
  });
  await t.test('calendar cast is valid for both lookup indexes and UUID ownership is enforced', async () => {
    const indexes = (await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN('idx_quest_completion_user_date','idx_player_quests_assigned')")).rows;
    assert.equal(indexes.length,2); assert.ok(indexes.every(row => row.indexdef.includes('::date')));
    await assert.rejects(insert(crypto.randomUUID(),'2020-01-03'), /foreign key/);
  });
}));

test('mounted reward daily quest API commits actual balances once and refuses unsafe claims', async t => fixture(async ({ pool, owner, other, app, token, foreignToken }) => {
  const read = () => request(app).get('/rewards/quests').set('Authorization',`Bearer ${token}`);
  const claim = (access = token) => request(app).post('/rewards/quests/claim').set('Authorization',`Bearer ${access}`);
  const balances = async () => (await pool.query('SELECT pokeball_count,stardust,xp,coins FROM users WHERE id=$1',[owner])).rows[0];
  const quest = async () => (await pool.query('SELECT * FROM daily_quests WHERE user_id=$1 AND quest_date=CURRENT_DATE',[owner])).rows[0];
  await t.test('anonymous and forged identity headers cannot read or claim', async () => {
    await request(app).get('/rewards/quests').set('X-User-Id',owner).expect(401);
    await request(app).post('/rewards/quests/claim').set('X-User-Id',owner).expect(401);
    await request(app).get('/rewards/quests').set('Authorization','Bearer invalid').expect(401);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM daily_quests')).rows[0].n,0);
  });
  await t.test('concurrent reads assign one canonical row and report real zero progress', async () => {
    const responses = await Promise.all(Array.from({ length: 8 },read));
    for (const response of responses) { assert.equal(response.status,200); assert.deepEqual(response.body.data.progress,{catch:0,spin:0,walk:0}); assert.equal(response.body.data.allDone,false); }
    assert.equal(new Set(responses.map(response=>response.body.data.id)).size,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM daily_quests WHERE user_id=$1',[owner])).rows[0].n,1);
  });
  await t.test('missing and unfinished quests leave resources unchanged', async () => {
    const before = await balances(); await claim(foreignToken).expect(404); await claim().expect(400);
    assert.deepEqual(await balances(),before); assert.equal((await quest()).reward_claimed,false);
  });
  await t.test('fractional distance is checked against the actual numeric target', async () => {
    await pool.query('UPDATE daily_quests SET catch_current=catch_target,spin_current=spin_target,walk_current_km=1.9 WHERE user_id=$1',[owner]);
    await claim().expect(400); const response = await read().expect(200);
    assert.equal(response.body.data.progress.walk,95); assert.equal(response.body.data.allDone,false);
  });
  await t.test('invalid zero targets cannot be used to claim a reward', async () => {
    await pool.query('UPDATE daily_quests SET catch_target=0,spin_target=0,walk_target_km=0 WHERE user_id=$1',[owner]);
    await claim().expect(400);
    await pool.query('UPDATE daily_quests SET catch_target=5,spin_target=3,walk_target_km=2 WHERE user_id=$1',[owner]);
  });
  await pool.query("UPDATE daily_quests SET walk_current_km=walk_target_km,completed_at='2020-01-01' WHERE user_id=$1",[owner]);
  await t.test('a progress edit while claim waits is checked after the row lock', async () => {
    const editor = await pool.connect(); let claiming;
    try {
      await editor.query('BEGIN');
      await editor.query('SELECT id FROM daily_quests WHERE user_id=$1 FOR UPDATE',[owner]);
      const pid = (await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      claiming = claim().then(response=>response);
      const deadline = Date.now()+3000; let blocked = false;
      while (Date.now()<deadline) {
        blocked = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%daily_quests%'",[pid])).rowCount>0;
        if (blocked) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'actual quest selection must wait for the row lock');
      await editor.query('UPDATE daily_quests SET catch_current=0 WHERE user_id=$1',[owner]);
      await editor.query('COMMIT'); assert.equal((await claiming).status,400);
      assert.equal((await quest()).reward_claimed,false);
    } finally { await editor.query('ROLLBACK'); editor.release(); if (claiming) await claiming; }
    await pool.query('UPDATE daily_quests SET catch_current=catch_target WHERE user_id=$1',[owner]);
  });
  await t.test('claim marker failure rolls back all four real resource grants', async () => {
    await pool.query(`CREATE FUNCTION refuse_quest_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.reward_claimed THEN RAISE EXCEPTION 'isolated claim failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER refuse_quest_claim BEFORE UPDATE ON daily_quests FOR EACH ROW EXECUTE FUNCTION refuse_quest_claim()`);
    const before = await balances(); await claim().expect(500); assert.deepEqual(await balances(),before);
    assert.equal((await quest()).reward_claimed,false); await pool.query('DROP TRIGGER refuse_quest_claim ON daily_quests; DROP FUNCTION refuse_quest_claim()');
  });
  await t.test('a foreign JWT and request-body user ID cannot claim another player quest', async () => {
    await claim(foreignToken).send({userId:owner}).expect(404); assert.equal((await quest()).reward_claimed,false);
  });
  await t.test('24 simultaneous actual HTTP claims grant once, preserve completion date and set completion marker', async () => {
    const before = await balances(); const responses = await Promise.all(Array.from({length:24},()=>claim()));
    assert.equal(responses.filter(response=>response.status===200).length,1);
    assert.equal(responses.filter(response=>response.status===400&&response.body.code===2022).length,23);
    const after = await balances(); assert.deepEqual(after,{pokeball_count:before.pokeball_count+10,stardust:before.stardust+1000,xp:(BigInt(before.xp)+500n).toString(),coins:before.coins+5});
    const row = await quest(); assert.equal(row.reward_claimed,true); assert.equal(row.completed,true);
    assert.equal((await pool.query('SELECT completed_at::text AS value FROM daily_quests WHERE id=$1',[row.id])).rows[0].value,'2020-01-01 00:00:00');
  });
  await t.test('replayed claim changes neither balances nor historical quests', async () => {
    const before = await balances(); await claim().expect(400); assert.deepEqual(await balances(),before);
    await pool.query("INSERT INTO daily_quests(user_id,quest_date,catch_current,spin_current,walk_current_km) VALUES($1,CURRENT_DATE-1,5,3,2)",[other]);
    await claim(foreignToken).expect(404);
  });
  await t.test('a deleted player cannot receive rewards', async () => {
    await pool.query('DELETE FROM users WHERE id=$1',[other]); await claim(foreignToken).expect(404);
  });
  await t.test('real service mount is reachable with curl and ignores query-string owner substitution', async () => {
    const server = await new Promise(resolve => { const running=app.listen(0,'127.0.0.1',()=>resolve(running)); });
    try {
      const {stdout} = await promisify(execFile)('curl',['--silent','--show-error','--fail','--max-time','5','-H',`Authorization: Bearer ${token}`,`http://127.0.0.1:${server.address().port}/rewards/quests?userId=${other}`]);
      const response=JSON.parse(stdout); assert.equal(response.data.user_id,owner); assert.equal(response.data.reward_claimed,true);
    } finally { await new Promise(resolve=>server.close(resolve)); }
  });
}));
