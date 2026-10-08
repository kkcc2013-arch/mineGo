'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {Pool}=require('pg');const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');

test('actual catalog and identity prerequisites preserve data and support inventory SQL with UUID owners',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`prerequisites_${crypto.randomBytes(8).toString('hex')}`;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'minego-prerequisites-'));
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);
  let child;
  try{
    await fixture.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    const filenames=['20261008_130000__item_catalog_prerequisite.sql','20260609_124500__add_item_inventory_system.sql','20261008_131000__pokedex_identity_prerequisite.sql'];
    for(const file of filenames)await fs.copyFile(path.join(root,'database/pending',file),path.join(directory,file));
    const repairs=JSON.parse(await fs.readFile(path.join(root,'database/pending/repairs.json'),'utf8'));
    const entry=repairs.repairs['20260609_124500'];await fs.mkdir(path.join(directory,'repairs'));
    await fs.copyFile(path.join(root,'database/pending',entry.file),path.join(directory,entry.file));
    await fs.writeFile(path.join(directory,'repairs.json'),JSON.stringify({schemaVersion:1,repairs:{'20260609_124500':entry}}));
    await fs.writeFile(path.join(directory,'dependencies.json'),JSON.stringify({schemaVersion:1,dependencies:{'20260609_124500':['20261008_130000']}}));
    child=spawn(process.execPath,[path.join(root,'database/migrate.js'),'up'],{env:{...process.env,DATABASE_URL:url.toString(),MINEGO_MIGRATIONS_DIR:directory},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});child=null;assert.equal(code,0,output);
    const owner=crypto.randomUUID();await fixture.query('INSERT INTO users(id,nickname) VALUES($1,$2)',[owner,'inventory-owner']);
    assert.ok((await fixture.query('SELECT count(*)::int AS n FROM items')).rows[0].n>=20);
    const defaults=(await fixture.query("SELECT * FROM check_inventory_capacity($1::uuid,'pokeball',1)",[owner])).rows[0];
    assert.deepEqual(defaults,{can_add:true,current_count:'0',slot_limit:100,remaining:100});
    await assert.rejects(fixture.query("SELECT * FROM check_inventory_capacity($1::uuid,'pokeball',0)",[owner]),/positive/);
    await fixture.query("INSERT INTO inventory_capacity(user_id) VALUES($1)",[owner]);
    await fixture.query("INSERT INTO player_inventory(user_id,item_id,quantity,expires_at) VALUES($1,'POKE_BALL',95,NULL),($1,'POTION',2,NOW()-INTERVAL '1 minute')",[owner]);
    assert.equal((await fixture.query("SELECT * FROM check_inventory_capacity($1::uuid,'pokeball',6)",[owner])).rows[0].can_add,false);
    assert.equal((await fixture.query('SELECT cleanup_expired_inventory() AS n')).rows[0].n,1);
    assert.equal((await fixture.query('SELECT quantity FROM player_inventory WHERE user_id=$1',[owner])).rows[0].quantity,95);
    assert.equal((await fixture.query('SELECT total_used FROM inventory_capacity WHERE user_id=$1',[owner])).rows[0].total_used,95);
    await assert.rejects(fixture.query("INSERT INTO player_inventory(user_id,item_id,quantity) VALUES($1,'POKE_BALL',0)",[owner]),/chk_quantity_positive/);
    await fixture.query('INSERT INTO pokedex_stats_cache(user_id,caught_count) VALUES($1,1)',[owner]);
    assert.equal((await fixture.query('SELECT user_id FROM pokedex_stats_cache')).rows[0].user_id,owner);
    await assert.rejects(fixture.query('INSERT INTO pokedex_stats_cache(user_id) VALUES($1)',[crypto.randomUUID()]),/foreign key/);
  }finally{
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;}
    await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await fs.rm(directory,{recursive:true,force:true});
  }
});

test('catalog prerequisite rollback preserves a preexisting catalog, and removes only its own created relation',async()=>{
  assert.ok(process.env.TEST_DATABASE_URL);
  const schema=`catalog_rollback_${crypto.randomBytes(8).toString('hex')}`;const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
  const fixture=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  const {parseMigrationFile}=require('../../../database/migrate');const {migrationStatements}=require('../../../database/sqlStatements');
  const sql=parseMigrationFile(await fs.readFile(path.join(root,'database/pending/20261008_130000__item_catalog_prerequisite.sql'),'utf8'));
  const client=await fixture.connect();
  const apply=async direction=>{await client.query('BEGIN');try{for(const statement of migrationStatements(sql[direction]))await client.query(statement);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}};
  try{
    await apply('up');await apply('down');assert.equal((await fixture.query("SELECT to_regclass('items') AS name")).rows[0].name,null);
    await fixture.query('CREATE TABLE items(id text PRIMARY KEY,category text,name_zh text,name_en text,name_ja text)');
    await fixture.query("INSERT INTO items VALUES('existing','special','已存在','Existing',NULL)");
    await apply('up');await apply('down');assert.equal((await fixture.query('SELECT id FROM items')).rows[0].id,'existing');
  }finally{client.release();await fixture.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
