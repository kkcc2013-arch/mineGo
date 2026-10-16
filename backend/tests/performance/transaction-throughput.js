'use strict';
// Real V1 resource transfers, two owned connections, unchanged published predecessor.
const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const Module=require('node:module');const {execFileSync}=require('node:child_process');const assert=require('node:assert/strict');
const {Pool}=require('pg');const {TransactionManager}=require('../../shared/TransactionManager');
const root=path.resolve(__dirname,'../../..');const baselineCommit='43c6b148ccdba62f76af415927f2a86676feaa18';
const iterations=200,rounds=7,warmup=50,concurrency=2;
const currentPaths=['backend/shared/TransactionManager.js','backend/shared/transactionManager.js','backend/shared/transactionMetrics.js','backend/shared/pgDeadlock.js','backend/shared/db.js','database/sqlStatements.js','backend/tests/performance/transaction-throughput.js'];
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL must identify isolated PostGIS');
  const schema='tx_throughput_'+crypto.randomBytes(8).toString('hex');const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:concurrency,options:`-c search_path=${schema},public`});
  const source=execFileSync('git',['show',baselineCommit+':backend/shared/transactionManager.js'],{cwd:root,encoding:'utf8'});
  const filename=path.join(root,'backend/shared/transaction-throughput-baseline.js');
  const previous=new Module(filename,module);previous.filename=filename;previous.paths=Module._nodeModulePaths(path.dirname(filename));
  const originalRequire=previous.require.bind(previous);previous.require=id=>id==='./db'?{getPool:()=>pool}:originalRequire(id);previous._compile(source,filename);
  const digest=async()=>Object.fromEntries(await Promise.all(currentPaths.map(async name=>[name,crypto.createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')])));
  const currentSourceSha256=await digest();
  const manager=new TransactionManager(pool);const owners=Array.from({length:concurrency},()=>[crypto.randomUUID(),crypto.randomUUID()]);
  const legacy=fn=>previous.exports.transactionReadCommitted(fn);const current=fn=>manager.execute(fn);
  const run=async(api,count)=>{
    const start=performance.now();await Promise.all(owners.map(async([from,to])=>{for(let i=0;i<count;i++)await api(async c=>{
      const rows=(await c.query('SELECT id,stardust FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[from,to]])).rows;
      const debit=rows.find(row=>row.id===from),credit=rows.find(row=>row.id===to);
      await c.query('UPDATE users SET stardust=$1 WHERE id=$2',[debit.stardust-1,from]);await c.query('UPDATE users SET stardust=$1 WHERE id=$2',[credit.stardust+1,to]);
    });}));return {milliseconds:performance.now()-start,transactions:count*concurrency};
  };
  try{
    const environment={node:process.version,platform:process.platform,architecture:process.arch,database:(await pool.query("SELECT current_setting('server_version') AS version,current_setting('synchronous_commit') AS synchronous_commit,current_setting('shared_preload_libraries') AS shared_preload_libraries")).rows[0]};
    await pool.query(await fs.readFile(path.join(root,'database/migrations/V1__initial_schema.sql'),'utf8'));
    for(const [i,pair]of owners.entries())for(const [j,id]of pair.entries())await pool.query('INSERT INTO users(id,nickname,stardust) VALUES($1,$2,1000000)',[id,`benchmark-${i}-${j}`]);
    await run(legacy,warmup);await run(current,warmup);const results=[];
    for(let i=0;i<rounds;i++){
      let before,after;if(i%2===0){before=await run(legacy,iterations);after=await run(current,iterations);}else{after=await run(current,iterations);before=await run(legacy,iterations);}
      const baselineTps=before.transactions/(before.milliseconds/1000),currentTps=after.transactions/(after.milliseconds/1000);
      results.push({round:i+1,baselineTps,currentTps,changePercent:(currentTps/baselineTps-1)*100});
    }
    const moved=2*(warmup+rounds*iterations);
    for(const [from,to]of owners){assert.equal((await pool.query('SELECT stardust FROM users WHERE id=$1',[from])).rows[0].stardust,1000000-moved);assert.equal((await pool.query('SELECT stardust FROM users WHERE id=$1',[to])).rows[0].stardust,1000000+moved);}
    assert.deepEqual(await digest(),currentSourceSha256,'Measured sources changed during the run');
    const changePercent=median(results.map(r=>r.changePercent));const report={environment,currentSourceSha256,baselineCommit,baselineSourceSha256:crypto.createHash('sha256').update(source).digest('hex'),method:'Alternating paired rounds; median paired throughput change; exact same V1 resource transfer and owned pool; both default metrics enabled',concurrency,iterationsPerWorker:iterations,rounds,warmupPerWorker:warmup,results,medianChangePercent:changePercent,requiredMinimumChangePercent:-5,dataIntegrity:'all resource deltas exact',passed:changePercent>=-5};
    console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
