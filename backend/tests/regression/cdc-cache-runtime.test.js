'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const fs=require('node:fs/promises');const path=require('node:path');const {Pool}=require('pg');const {Registry}=require('prom-client');const {performance}=require('node:perf_hooks');
const {migrationStatements}=require('../../../database/sqlStatements');const {parseMigrationFile}=require('../../../database/migrate');
const CacheInvalidationCenter=require('../../shared/cdc/CacheInvalidationCenter');const {CoherentCache}=require('../../shared/cache/CoherentCache');
const root=path.resolve(__dirname,'../../..');const read=f=>fs.readFile(path.join(root,f),'utf8');const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=5000){const start=performance.now();while(performance.now()-start<ms){if(await fn())return;await delay(2);}throw new Error('Actual CDC runtime deadline exceeded');}
async function apply(pool,source){const c=await pool.connect();try{await c.query('BEGIN');for(const sql of migrationStatements(parseMigrationFile(source).up))await c.query(sql);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}

test('actual committed PostgreSQL changes invalidate independent Redis/L1 instances and durable retries recover',async t=>{
  for(const key of ['TEST_DATABASE_URL','TEST_REDIS_URL'])assert.ok(process.env[key],key+' owned fixture required');
  const schema='cdc_runtime_'+crypto.randomBytes(8).toString('hex');const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');await admin.query('CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public');await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);const pool=new Pool({connectionString:url.toString(),max:2});
  const redis=new URL(process.env.TEST_REDIS_URL),namespace='runtime:'+schema+':';const redisConfig={host:redis.hostname,port:Number(redis.port||6379),db:13};
  const a=new CoherentCache(),b=new CoherentCache();
  const first=new CacheInvalidationCenter({pool,cache:a,namespace,redis:redisConfig,registry:new Registry(),pollMs:100});const second=new CacheInvalidationCenter({pool,cache:b,namespace,redis:redisConfig,registry:new Registry(),pollMs:100});
  const owner=crypto.randomUUID(),other=crypto.randomUUID();const key=`api:profile:/v1/users/${owner}/profile:user:${owner}`,foreign=`api:profile:/v1/users/${other}/profile:user:${other}`;
  // Source writes can still be broadcasting a prior invalidation. Establish an
  // actual successful fenced fill before measuring or asserting later behavior.
  const fill=async(cache,key,value)=>until(async()=>{const entry=await cache.readForFill(key);if(entry.disabled)return false;return cache.set(key,value,60,{token:entry.token});});
  try{
    await pool.query(await read('database/migrations/V1__initial_schema.sql'));await pool.query(await read('database/seeds/V2__seed_data.sql'));
    for(const file of ['20261008_140000__audit_partition_conversion.sql','repairs/20260610_100000__add_table_partitioning_system.sql','20261008_130000__item_catalog_prerequisite.sql','repairs/20260609_124500__add_item_inventory_system.sql'])await apply(pool,await read('database/pending/'+file));
    await pool.query("INSERT INTO users(id,nickname) VALUES($1,'runtime-owner'),($2,'runtime-other')",[owner,other]);
    await apply(pool,await read('database/pending/repairs/20260707_100000__cdc_triggers_for_cache_invalidation.sql'));
    await first.start();await second.start();await until(()=>a.available()&&b.available());
    await t.test('source commit clears both actual L1 caches and real Redis within original healthy limits',async()=>{
      const samples=[];
      for(let i=0;i<12;i++){
        await fill(a,key,{nickname:'old',i});assert.deepEqual(await b.get(key),{nickname:'old',i});
        const started=performance.now();await pool.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);
        await until(async()=>!a.memory.has(key)&&!b.memory.has(key)&&await a.client.exists(a.storagePrefix+key)===0);
        const elapsed=performance.now()-started;samples.push(elapsed);
        await until(async()=>Number((await pool.query('SELECT count(*) AS n FROM cache_invalidation_outbox')).rows[0].n)===0);
      }
      const report={date:'2026-10-19',runtime:process.version,scope:'12 sequential real PostgreSQL writer operations through two independent CDC/cache clients, shared actual Redis and both L1 maps; measured from before UPDATE through observed removal, healthy isolated fixture only; no capacity/database-load acceptance',samplesMs:samples,maxMs:Math.max(...samples),originalGatesMs:{REQ00479:100,REQ00523:50},sourceSha256:{}};
      for(const file of ['backend/shared/cache/CoherentCache.js','backend/shared/cdc/CacheInvalidationCenter.js','backend/shared/cdc/PgCDCListener.js','backend/shared/cdc/ChangeToCacheMapper.js','backend/shared/cdc/cache-rules.yml','database/pending/repairs/20260707_100000__cdc_triggers_for_cache_invalidation.sql','backend/tests/regression/cdc-cache-runtime.test.js'])report.sourceSha256[file]=crypto.createHash('sha256').update(await read(file)).digest('hex');
      console.log(JSON.stringify(report));if(process.env.CDC_LATENCY_REPORT_PATH)await fs.writeFile(process.env.CDC_LATENCY_REPORT_PATH,JSON.stringify(report,null,2)+'\n');
      assert.ok(report.maxMs<100,'REQ479100ms gate: '+report.maxMs);assert.ok(report.maxMs<50,'REQ52350ms gate: '+report.maxMs);
      await fill(a,foreign,{retained:true});assert.deepEqual(await b.get(foreign),{retained:true});
    });
    await t.test('actual joined data sources invalidate viewer profiles, species lists, candy and friend joins',async()=>{
      const publicProfile=`api:profile:/v1/users/${owner}/profile:user:${other}:joined`;
      const pokemonList='api:pokemon-list:joined:user:'+owner;
      const pokedex='api:pokedex:joined:user:'+owner;
      const friends='api:friends:joined:user:'+other;
      const gone=async keys=>until(async()=>{for(const key of keys)if(await b.get(key)!==null)return false;return true;});
      for(const key of [publicProfile,pokemonList,pokedex,friends]){await fill(a,key,{old:true});await b.get(key);}
      const pokemon=crypto.randomUUID();await pool.query('INSERT INTO pokemon_instances(id,user_id,species_id,cp,hp_current,hp_max,iv_attack,iv_defense,iv_hp) VALUES($1,$2,1,10,10,10,1,1,1)',[pokemon,owner]);
      await gone([publicProfile,pokemonList]);
      await pool.query('INSERT INTO candy_inventory(user_id,species_id,amount) VALUES($1,1,3)',[owner]);await gone([pokedex]);
      await pool.query('UPDATE users SET xp=xp+1 WHERE id=$1',[owner]);await gone([friends]);
      await fill(a,pokemonList,{old:true});await b.get(pokemonList);
      await pool.query("UPDATE pokemon_species SET name_en=name_en||' fixture' WHERE id=1");await gone([pokemonList]);
    });
    await t.test('rollback does not invalidate or enqueue a successful-looking event',async()=>{
      await fill(a,key,{revision:'retained'});await b.get(key);const c=await pool.connect();try{await c.query('BEGIN');await c.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);await c.query('ROLLBACK');}finally{c.release();}
      await delay(30);assert.deepEqual(await a.get(key),{revision:'retained'});assert.deepEqual(await b.get(key),{revision:'retained'});
    });
    await t.test('a late committing transaction is processed even after a later source transaction was drained',async()=>{
      const heldKey=key+':held-transaction';await fill(a,heldKey,{held:true});assert.deepEqual(await b.get(heldKey),{held:true});
      const held=await pool.connect();
      try{
        await held.query('BEGIN');await held.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);
        await pool.query('UPDATE users SET coins=coins+1 WHERE id=$1',[other]);
        await until(async()=>(await pool.query('SELECT count(*)::int AS n FROM cache_invalidation_outbox')).rows[0].n===0);
        assert.deepEqual(await b.get(heldKey),{held:true});await held.query('COMMIT');
        await until(async()=>await a.get(heldKey)===null&&await b.get(heldKey)===null);
      }finally{await held.query('ROLLBACK');held.release();}
    });
    await t.test('configuration adds glob and bounded regex rules without code edits and preserves built-ins',async()=>{
      const state=await first.getRules();const custom={version:1,customRules:{users:[{type:'glob',pattern:'api:custom:*user:{id}'},{type:'regex',pattern:'^query:custom:.*$'}]}};
      await first.updateRules(custom,state.revision);await until(()=>a.available()&&b.available());
      await fill(a,'api:custom:value:user:'+owner,{old:true});await fill(a,'query:custom:value',{old:true});await fill(a,key,{old:true});await b.get('query:custom:value');
      await pool.query('UPDATE users SET xp=xp+1 WHERE id=$1',[owner]);
      await until(async()=>await a.get('api:custom:value:user:'+owner)===null&&await b.get('query:custom:value')===null&&await a.get(key)===null);
      assert.ok((await first.getRules()).effective.defaults.users.length>0);
    });
    await t.test('concurrent configuration writes retain revision ownership and invalid rules leave active state untouched',async()=>{
      const state=await first.getRules();
      const result=await Promise.allSettled([first.updateRules({version:1,customRules:{}},state.revision),second.updateRules({version:1,customRules:{}},state.revision)]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.status,409);
      const current=await first.getRules();for(const doc of [{version:1,customRules:{users:['*']}},{version:1,customRules:{users:[{type:'regex',pattern:'^(a+)+$'}]}},{version:1,customRules:{users:['api:custom:{password}']}},{version:1,customRules:{unknown:['api:custom:*']}}])await assert.rejects(first.updateRules(doc,current.revision));
      assert.deepEqual((await first.getRules()).document,current.document);
    });
    await t.test('listener connection loss reconnects, replays pending work and drains owned handles',async()=>{
      await second.stop();await first.listener.client.end();await until(()=>!first.listener.isListening);
      await pool.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);
      await until(()=>first.listener.isListening&&a.available());await until(async()=>(await pool.query('SELECT count(*)::int AS n FROM cache_invalidation_outbox')).rows[0].n===0);
      assert.ok(first.listener.stats.reconnects>=1);await second.start();
    });
    await t.test('stopped workers leave durable committed work and startup drains it before enabling cache',async()=>{
      await first.stop();await second.stop();
      await pool.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);
      assert.ok((await pool.query('SELECT count(*)::int AS n FROM cache_invalidation_outbox')).rows[0].n>0);
      await first.start();await until(()=>a.available());assert.equal((await first.getStats()).pendingEvents,'0');
    });
    await t.test('actual Redis failure leaves durable pending work instead of acknowledging deletion',async()=>{
      await second.stop();a.client.disconnect();await until(()=>a.client.status==='end');
      await pool.query('UPDATE users SET coins=coins+1 WHERE id=$1',[owner]);await until(async()=>(await pool.query('SELECT COALESCE(max(attempts),0) AS attempts FROM cache_invalidation_outbox')).rows[0].attempts>0);
      assert.equal(a.available(),false);assert.equal((await first.getStats()).ready,false);
      await a.client.connect();await until(()=>a.client.status==='ready');
      await until(async()=>(await pool.query('SELECT count(*)::int AS n FROM cache_invalidation_outbox')).rows[0].n===0);await until(()=>a.available());assert.equal((await first.getStats()).pendingEvents,'0');
    });
  }finally{await first.stop();await second.stop();await a.close();await b.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
