'use strict';
process.env.JWT_ACCESS_SECRET='currency-fixture-only';
const {test}=require('node:test');const assert=require('node:assert/strict');
const crypto=require('node:crypto');const fs=require('node:fs/promises');const path=require('node:path');
const {Pool}=require('pg');const express=require('express');const jwt=require('jsonwebtoken');
const {migrationStatements}=require('../../../database/sqlStatements');
const {ExchangeRateService}=require('../../shared/exchangeRateService');
const formatter=require('../../shared/currencyFormatter');
const {createCurrencyRouter}=require('../../services/payment-service/src/routes/currency');
const {errorHandler}=require('../../shared/auth');
const root=path.resolve(__dirname,'../../..');
const file='20260624_133000__add_multi_currency_support.sql';

test('actual currency storage, atomic rates and signed production router contracts',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema=`currency_${crypto.randomBytes(8).toString('hex')}`;
  const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2,options:`-c search_path=${schema},public`});
  const database={query:(...args)=>pool.query(...args),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
  const apply=sql=>database.transaction(async c=>{for(const s of migrationStatements(sql))await c.query(s);});
  const raw=await fs.readFile(path.join(root,'database/pending',file),'utf8');
  const repair=await fs.readFile(path.join(root,'database/pending/repairs',file),'utf8');
  const owner=crypto.randomUUID(),foreign=crypto.randomUUID(),oldOrder=crypto.randomUUID();
  const apiKeys={OER_API_KEY:'',FIXER_API_KEY:'',EXCHANGE_RATE_API_KEY:''};
  const service=new ExchangeRateService({database,apiKeys});let server;
  try{
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    await pool.query('INSERT INTO users(id,nickname) VALUES($1,$2),($3,$4)',[owner,'currency-owner',foreign,'foreign-owner']);
    await pool.query("INSERT INTO orders(id,user_id,idempotency_key,product_id,product_name,amount_fen,currency,status) VALUES($1,$2,'prior-idempotency','coins_60','Original product',600,'CNY','PAID')",[oldOrder,owner]);
    await pool.query('CREATE VIEW retained_orders AS SELECT * FROM orders');await pool.query('CREATE TABLE order_reference(id uuid REFERENCES orders(id))');await pool.query('INSERT INTO order_reference VALUES($1)',[oldOrder]);
    const old=(await pool.query('SELECT * FROM orders')).rows[0];const oid=(await pool.query("SELECT 'orders'::regclass::oid AS oid")).rows[0].oid;
    await t.test('original undefined payment table fails and rolls back all new schema',async()=>{
      await assert.rejects(apply(raw),{code:'42P01'});
      assert.equal((await pool.query("SELECT to_regclass('supported_currencies') AS relation")).rows[0].relation,null);
      assert.deepEqual((await pool.query('SELECT * FROM orders')).rows[0],old);
    });
    await t.test('canonical repair preserves real order identities, money, status, views and references',async()=>{
      await apply(repair);
      assert.equal((await pool.query("SELECT 'orders'::regclass::oid AS oid")).rows[0].oid,oid);
      const after=(await pool.query('SELECT * FROM orders')).rows[0];for(const [key,value]of Object.entries(old))assert.deepEqual(after[key],value);
      for(const key of ['amount_usd','amount_local','local_currency','exchange_rate','rate_lock_id'])assert.equal(after[key],null);
      assert.deepEqual((await pool.query('SELECT * FROM retained_orders')).rows[0],old);assert.equal((await pool.query('SELECT id FROM order_reference')).rows[0].id,oldOrder);
      assert.equal((await pool.query("SELECT to_regclass('payment_orders') AS relation")).rows[0].relation,null);
      assert.equal((await service.getSupportedCurrencies()).length,20);assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_prices')).rows[0].n,20);
    });
    await t.test('parallel order layout refuses adoption and keeps its existing data',async()=>{
      await pool.query('CREATE TABLE payment_orders(important text)');await pool.query("INSERT INTO payment_orders VALUES('preserve')");
      await assert.rejects(apply(repair),/explicit adoption/);assert.deepEqual((await pool.query('SELECT * FROM payment_orders')).rows,[{important:'preserve'}]);
      await pool.query('ALTER TABLE payment_orders RENAME TO operator_payment_layout');
    });
    await t.test('actual rate transaction retains all snapshots and daily open/close/high/low history',async()=>{
      await service.saveRate('USD','EUR','0.9200000000','manual');await service.saveRate('USD','EUR','0.9400000000','manual');await service.saveRate('USD','EUR','0.9000000000','manual');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM exchange_rates WHERE from_currency='USD' AND to_currency='EUR'")).rows[0].n,3);
      assert.equal(await service.getRate('USD','EUR'),0.9);
      const history=(await pool.query("SELECT open_rate,close_rate,high_rate,low_rate FROM exchange_rate_history WHERE from_currency='USD' AND to_currency='EUR'")).rows[0];
      assert.deepEqual(history,{open_rate:'0.9200000000',close_rate:'0.9000000000',high_rate:'0.9400000000',low_rate:'0.9000000000'});
    });
    await t.test('simultaneous publications serialize to one current quote without discarding history',async()=>{
      await Promise.all([service.saveRate('USD','JPY','150','manual'),service.saveRate('USD','JPY','155','manual')]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM exchange_rates WHERE from_currency='USD' AND to_currency='JPY' AND is_current")).rows[0].n,1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM exchange_rates WHERE from_currency='USD' AND to_currency='JPY'")).rows[0].n,2);
    });
    await t.test('database failure rolls back current flag, snapshot, history and cache publication',async()=>{
      const before=(await pool.query("SELECT * FROM exchange_rates WHERE to_currency='EUR' ORDER BY id")).rows;
      await pool.query("CREATE FUNCTION refuse_currency() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.source='fault' THEN RAISE EXCEPTION 'fixture publication fault'; END IF; RETURN NEW; END$$");
      await pool.query('CREATE TRIGGER refuse_currency BEFORE INSERT ON exchange_rates FOR EACH ROW EXECUTE FUNCTION refuse_currency()');
      await assert.rejects(service.saveRate('USD','EUR','0.99','fault'),/publication fault/);
      assert.deepEqual((await pool.query("SELECT * FROM exchange_rates WHERE to_currency='EUR' ORDER BY id")).rows,before);assert.equal(await service.getRate('USD','EUR'),0.9);
    });
    await t.test('cached quotes stop at their real expiry and missing providers never invent a price',async()=>{
      await service.saveRate('USD','GBP','0.8','manual');service.cache.clear();
      let time=Date.now();const clocked=new ExchangeRateService({database,apiKeys,now:()=>time});assert.equal(await clocked.getRate('USD','GBP'),0.8);
      time=clocked.cache.get('USD_GBP').validUntil+1;await assert.rejects(clocked.getRate('USD','GBP'),/Failed to fetch/);
      await assert.rejects(service.getRate('USD','CAD'),/Failed to fetch/);assert.equal((await pool.query("SELECT count(*)::int AS n FROM exchange_rates WHERE to_currency='CAD'")).rows[0].n,0);
      await assert.rejects(service.getRate('USD','constructor'),/Unsupported/);
    });
    await t.test('NUMERIC conversion rounds currency precision and retains exact audit values',async()=>{
      await service.saveRate('USD','CNY','7.2400000000','manual');const cny=await service.convert('0.10','USD','CNY');assert.equal(cny.amountExact,'0.72');assert.equal(cny.convertedAmount,0.72);
      await service.saveRate('USD','JPY','150.5','manual');assert.equal((await service.convert('1.01','USD','JPY')).amountExact,'152');
      assert.equal((await service.convert('1.005','USD','USD')).amountExact,'1.01');assert.equal((await service.convert(0,'USD','USD')).amountExact,'0.00');
      const audit=(await pool.query("SELECT rate,to_amount,input_amount FROM currency_conversion_logs WHERE to_currency='CNY' ORDER BY id DESC LIMIT 1")).rows[0];assert.deepEqual(audit,{rate:'7.2400000000',to_amount:'0.72',input_amount:'0.10'});
      assert.equal((await pool.query("SELECT input_amount FROM currency_conversion_logs WHERE from_currency='USD' AND to_currency='USD' ORDER BY id LIMIT 1")).rows[0].input_amount,'1.005');
      await assert.rejects(service.convert(-1,'USD','CNY'),/Invalid/);await assert.rejects(service.convert(Infinity,'USD','CNY'),/Invalid/);
    });
    await t.test('three actual provider adapters decode declared bases through owned HTTP contracts',async()=>{
      const provider=express();const requests=[];
      provider.get('/oer',(req,res)=>{requests.push(req.query);res.json({base:'USD',rates:{USD:1,EUR:0.8,JPY:160}});});
      provider.get('/fixer',(req,res)=>res.json({success:true,base:'EUR',rates:{USD:1.25,JPY:200}}));
      provider.get('/v6/:key/latest/:base',(req,res)=>res.json({result:'success',base_code:req.params.base,conversion_rates:{CNY:7.2,USD:1}}));
      const listener=await new Promise(resolve=>{const s=provider.listen(0,'127.0.0.1',()=>resolve(s));});
      try{
        const base=`http://127.0.0.1:${listener.address().port}`;
        const contracts=new ExchangeRateService({database,apiKeys:{OER_API_KEY:'fixture-only',FIXER_API_KEY:'',EXCHANGE_RATE_API_KEY:''},providerUrls:{openexchangerates:base+'/oer',fixer:base+'/fixer',exchangerate:base+'/v6'}});
        assert.equal(await contracts.fetchFromOER('EUR','JPY','fixture-only'),200);assert.equal(await contracts.fetchFromFixer('USD','JPY','fixture-only'),160);
        assert.equal(await contracts.fetchFromExchangeRateAPI('USD','CNY','fixture-only'),7.2);
        assert.equal(await contracts.fetchRate('EUR','JPY'),200);
        assert.equal((await pool.query("SELECT rate,source FROM exchange_rates WHERE from_currency='EUR' AND to_currency='JPY' AND is_current")).rows[0].source,'openexchangerates');
        assert.ok(requests.every(query=>query.base===undefined));
        assert.throws(()=>contracts.tableQuote('__proto__',{USD:1,CNY:7},'USD','CNY'),/Invalid/);
        assert.throws(()=>contracts.tableQuote('USD',{CNY:Infinity},'USD','CNY'),/Invalid/);
      }finally{await new Promise(resolve=>listener.close(resolve));}
    });
    let usedLock;
    await t.test('15-minute owned locks preserve frozen prices and consume only once under concurrency',async()=>{
      const before=Date.now();const lock=await service.lockRate('USD','CNY',15,owner);assert.ok(Math.abs(lock.expiresAt.getTime()-before-900000)<1000);
      await service.saveRate('USD','CNY','8','manual');assert.equal((await service.convert(1,'USD','CNY',{lockId:lock.lockId,userId:owner})).amountExact,'7.24');
      await assert.rejects(service.convert(1,'USD','CNY',{lockId:lock.lockId,userId:foreign}),/not found/);
      const results=await Promise.allSettled([service.useLockedRate(lock.lockId,'order',oldOrder,{userId:owner}),service.useLockedRate(lock.lockId,'order',oldOrder,{userId:owner})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);usedLock=lock.lockId;
      await assert.rejects(service.lockRate('USD','CNY',16,owner),/duration/);await assert.rejects(service.lockRate('USD','CNY',15),/owner/);
    });
    await t.test('outer order transaction can roll back lock use and cleanup retains used audit records',async()=>{
      const lock=await service.lockRate('USD','CNY',15,owner);
      await assert.rejects(database.transaction(async client=>{await service.useLockedRate(lock.lockId,'order',oldOrder,{userId:owner,client});throw new Error('order failure');}),/order failure/);
      assert.equal((await pool.query('SELECT used FROM rate_locks WHERE lock_id=$1',[lock.lockId])).rows[0].used,false);
      await pool.query("UPDATE rate_locks SET expires_at=NOW()-INTERVAL '1 day'");
      await assert.rejects(service.useLockedRate(lock.lockId,'order',oldOrder,{userId:owner}),/expired/);assert.equal(await service.cleanupExpiredLocks(),1);
      assert.equal((await pool.query('SELECT used FROM rate_locks WHERE lock_id=$1',[usedLock])).rows[0].used,true);
    });
    const app=express();app.use(express.json());app.use(['/currency','/api/v1/currencies'],createCurrencyRouter(service,database));app.use(errorHandler);
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
    const token=jwt.sign({sub:owner,roles:[]},process.env.JWT_ACCESS_SECRET,{expiresIn:'1h'}),adminToken=jwt.sign({sub:owner,roles:['admin']},process.env.JWT_ACCESS_SECRET,{expiresIn:'1h'});
    const call=async(route,{body,auth,method=body?'POST':'GET'}={})=>{const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
    await t.test('production public currency routes expose actual catalog, rates, prices, conversion and detection',async()=>{
      assert.equal((await call('/api/v1/currencies')).data.data.count,20);assert.equal((await call('/currency')).status,200);
      assert.equal((await call('/api/v1/currencies/rates?from=USD&to=USD,CNY')).data.data.rates.CNY,8);
      assert.equal((await call('/api/v1/currencies/prices/coins_60?currency=CNY')).data.data.source,'localized');
      assert.equal((await call('/api/v1/currencies/prices/coins_60?currency=GBP')).data.data.source,'converted');
      assert.equal((await call('/api/v1/currencies/prices/missing')).status,404);
      assert.equal((await call('/api/v1/currencies/convert',{body:{amount:0,from:'USD',to:'USD'}})).data.data.converted.amountExact,'0.00');
      assert.equal((await call('/api/v1/currencies/detect?country=jp')).data.data.currency,'JPY');assert.equal((await call('/api/v1/currencies/detect',{body:{country:'CN'}})).data.data.currency,'CNY');
      assert.equal((await call('/api/v1/currencies/rates?from=USD&to=CAD')).status,503);assert.equal((await call('/api/v1/currencies/rates?from=USD&to=constructor')).status,400);
    });
    await t.test('signed owner preferences and locks enforce authentication and input types',async()=>{
      assert.equal((await call('/api/v1/currencies/preference')).status,401);assert.equal((await call('/api/v1/currencies/preference',{auth:token,body:{currency:'JPY',autoDetect:false}})).status,200);
      assert.deepEqual((await call('/api/v1/currencies/preference',{auth:token})).data.data,{currency:'JPY',autoDetect:false});
      assert.equal((await call('/api/v1/currencies/preference',{auth:token,body:{currency:'USD',autoDetect:'false'}})).status,400);
      const body={from:'USD',to:'CNY',durationMinutes:15};assert.equal((await call('/api/v1/currencies/lock-rate',{body})).status,401);assert.equal((await call('/api/v1/currencies/lock-rate',{auth:token,body})).status,200);
      assert.equal((await call('/api/v1/currencies/convert',{body:{amount:1,from:'USD',to:'CNY',lockRate:true}})).status,401);
      assert.equal((await call('/api/v1/currencies/convert',{auth:token,body:{amount:1,from:'USD',to:'CNY',lockRate:true}})).status,200);
    });
    await t.test('actual admin routes reject anonymous and ordinary users and preserve validated pricing',async()=>{
      const body={productId:'coins_60',currency:'USD',price:0.29};assert.equal((await call('/api/v1/currencies/admin/set-price',{body})).status,401);assert.equal((await call('/api/v1/currencies/admin/set-price',{auth:token,body})).status,403);
      assert.equal((await call('/api/v1/currencies/admin/set-price',{auth:adminToken,body})).status,200);assert.equal((await pool.query("SELECT price FROM product_prices WHERE product_id='coins_60' AND currency_code='USD'")).rows[0].price,'0.29');
      assert.equal((await call('/api/v1/currencies/admin/set-price',{auth:adminToken,body:{...body,currency:'JPY',price:0.5}})).status,400);
      assert.equal((await call('/api/v1/currencies/admin/cleanup-locks',{auth:adminToken,body:{}})).status,200);
      const refresh=await call('/api/v1/currencies/admin/refresh-rates',{auth:adminToken,body:{}});assert.equal(refresh.status,200);assert.equal(refresh.data.data.refreshed,0);assert.equal(refresh.data.data.failed,19);
      const index=await fs.readFile(path.join(root,'backend/services/payment-service/src/index.js'),'utf8');assert.ok(index.indexOf("app.use(['/currency','/api/v1/currencies']")<index.indexOf('app.use(errorHandler)'));
    });
    await t.test('locale parsing retains decimal meaning and rejects prototype currency aliases',async()=>{
      assert.equal(formatter.parse('1.234,56 €','EUR'),1234.56);assert.equal(formatter.parse('$1,234.56','USD'),1234.56);assert.equal(formatter.detectCurrency('jp'),'JPY');
      assert.equal(formatter.isSupported('constructor'),false);assert.equal(formatter.isSupported('__proto__'),false);assert.throws(()=>formatter.parse('1abc2','USD'),/Invalid/);
    });
    await t.test('owner foreign key must reference actual user identity, refusing an alias-column layout',async()=>{
      await pool.query('ALTER TABLE users ADD COLUMN owner_alias uuid UNIQUE');await pool.query('UPDATE users SET owner_alias=id');
      await pool.query('ALTER TABLE rate_locks DROP CONSTRAINT rate_locks_user_id_fkey');await pool.query('ALTER TABLE rate_locks ADD CONSTRAINT wrong_owner_fk FOREIGN KEY(user_id) REFERENCES users(owner_alias)');
      const before=(await pool.query('SELECT * FROM rate_locks ORDER BY id')).rows;
      await assert.rejects(apply(repair),/owner schema requires explicit adoption/);
      assert.deepEqual((await pool.query('SELECT * FROM rate_locks ORDER BY id')).rows,before);
      await pool.query('ALTER TABLE rate_locks DROP CONSTRAINT wrong_owner_fk');await pool.query('ALTER TABLE rate_locks ADD CONSTRAINT rate_locks_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id)');await pool.query('ALTER TABLE users DROP COLUMN owner_alias');
    });
    await t.test('real registry exposes exercised currency counters without nonexistent helper calls',async()=>{
      const text=await require('../../shared/metrics').register.metrics();
      assert.match(text,/exchange_rate_cache_hit_total \d/);assert.match(text,/currency_conversion_total\{from="USD",to="CNY"\} \d/);
      assert.match(text,/exchange_rate_lock_created_total\{from="USD",to="CNY"\} \d/);assert.match(text,/exchange_rate_fetch_success_total\{source="openexchangerates"\} 1/);
    });
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
