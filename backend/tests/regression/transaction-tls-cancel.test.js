'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const net=require('node:net');
const {Pool}=require('pg');
const {TransactionManager}=require('../../shared/TransactionManager');
const {requestOwnedCancellation}=require('../../shared/pgCancel');

// This byte-forwarding observer records only the public first-packet code, never
// the cancellation PID/key or TLS application data. All SQL reaches PostgreSQL.
test('actual verified-TLS cancellation and refusal of an encryption downgrade',async t=>{
  assert.ok(process.env.TEST_SSL_DATABASE_URL,'TEST_SSL_DATABASE_URL must identify an isolated TLS-enabled PostgreSQL fixture');
  assert.ok(process.env.TEST_DATABASE_SSL_CA,'TEST_DATABASE_SSL_CA must identify its public test certificate');
  const target=new URL(process.env.TEST_SSL_DATABASE_URL);
  const schema='tls_owner_'+crypto.randomBytes(8).toString('hex');
  const admin=new Pool({connectionString:target.toString(),max:1});
  const packets=[],sockets=new Set();let refuseSSL=false,securePool;
  const proxy=net.createServer(front=>{
    sockets.add(front);front.once('close',()=>sockets.delete(front));front.on('error',()=>front.destroy());
    let initial=Buffer.alloc(0);
    const first=chunk=>{
      initial=Buffer.concat([initial,chunk]);if(initial.length<8)return;
      front.pause();front.removeListener('data',first);
      const code=initial.readInt32BE(4);packets.push(code);
      if(refuseSSL&&code===80877103){front.end('N');return;}
      const back=net.connect({host:target.hostname,port:Number(target.port||5432)});
      sockets.add(back);back.once('close',()=>sockets.delete(back));back.on('error',()=>{front.destroy();back.destroy();});
      front.once('close',()=>back.destroy());back.once('close',()=>front.destroy());
      back.pipe(front);back.once('connect',()=>{back.write(initial);initial=Buffer.alloc(0);front.pipe(back);front.resume();});
    };
    front.on('data',first);
  });
  try{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.protected_resource(id integer PRIMARY KEY,value integer NOT NULL)`);
    await admin.query(`INSERT INTO ${schema}.protected_resource VALUES(1,100)`);
    await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
    const clientURL=new URL(target);clientURL.hostname='127.0.0.1';clientURL.port=String(proxy.address().port);
    for(const key of ['ssl','sslmode','sslcert','sslkey','sslrootcert'])clientURL.searchParams.delete(key);
    securePool=new Pool({connectionString:clientURL.toString(),max:1,ssl:{ca:await fs.readFile(process.env.TEST_DATABASE_SSL_CA,'utf8'),rejectUnauthorized:true},options:`-c search_path=${schema},public`});
    // Establish verified TLS before measuring cancellation of the blocked query.
    // Checkout/connection deadlines are exercised separately in transaction-storage.
    await securePool.query('SELECT 1');
    const manager=new TransactionManager(securePool);
    await t.test('deadline cancels the owned encrypted query, releases its actual row lock and leaves a different backend alive',async()=>{
      const witness=(await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await assert.rejects(manager.execute(async c=>{
        assert.equal(c.secretKey,undefined);assert.notEqual(c.processID,witness);
        await c.query("SET LOCAL statement_timeout='0'");
        await c.query('UPDATE protected_resource SET value=999 WHERE id=1');
        await c.query('SELECT pg_sleep(5)');
      },{timeout:100}),{code:'57014'});
      await admin.query("SET statement_timeout='800ms'");
      await admin.query(`SELECT id FROM ${schema}.protected_resource WHERE id=1 FOR UPDATE`);
      assert.equal((await admin.query(`SELECT value FROM ${schema}.protected_resource`)).rows[0].value,100);
      assert.equal((await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,witness);
      assert.ok(packets.filter(code=>code===80877103).length>=2,'Both original and cancellation connections must negotiate TLS');
      assert.equal(packets.includes(80877102),false,'The cancellation secret must not be sent in a plaintext startup packet');
      assert.equal(manager.getActiveTransactionCount(),0);
      await admin.query("SET statement_timeout='0'");
    });
    await t.test('a server refusing TLS cannot trigger a plaintext cancellation fallback',async()=>{
      const client=await securePool.connect();
      try{
        assert.equal(client.connection.stream.encrypted,true);assert.equal(client.connection.stream.authorized,true);
        refuseSSL=true;const before=packets.length;
        await assert.rejects(requestOwnedCancellation(client,800),/SSL/);
        assert.deepEqual(packets.slice(before),[80877103]);
      }finally{refuseSSL=false;client.release(true);}
    });
  }finally{
    if(securePool)await securePool.end();
    for(const socket of sockets)socket.destroy();
    if(proxy.listening)await new Promise(resolve=>proxy.close(resolve));
    try{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await admin.end();}
  }
});
