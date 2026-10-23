'use strict';
// REQ-00060 / REQ-00626: actual canonical creation and observed statistics.
const {Gauge,Counter,Histogram}=require('prom-client');
const sharedMetrics=require('./metrics');
const TABLES=Object.freeze(['catch_records','location_updates','audit_logs','event_logs','payment_transactions']);
class PartitionMaintenance {
  constructor({database=require('./db'),registry=sharedMetrics.register}={}){
    this.database=database;this.registry=registry;
    const metric=(Type,name,help,labelNames)=>registry.getSingleMetric(name)||new Type({name,help,labelNames,registers:[registry]});
    this.rows=metric(Gauge,'minego_partition_managed_rows','Observed rows in each actual partition',['table','partition']);
    this.bytes=metric(Gauge,'minego_partition_managed_bytes','Actual total relation size including indexes',['table','partition']);
    this.created=metric(Counter,'minego_partition_managed_created_total','Successfully created actual child partitions',['table']);
    this.operations=metric(Histogram,'minego_partition_management_duration_seconds','Actual management operation latency',['table','operation']);
    this.failures=metric(Counter,'minego_partition_management_failures_total','Failed actual management operations',['table','operation']);
    this.timer=null;this.running=null;this.stopped=true;this.observedPartitions=new Map();
  }
  table(name){if(!TABLES.includes(name))throw Object.assign(new Error('Unknown managed partition table'),{status:400});return name;}
  months(value){if(!Number.isInteger(value)||value<1||value>12)throw Object.assign(new Error('months must be an integer from 1 to 12'),{status:400});return value;}
  async operation(table,operation,fn){
    const end=this.operations.startTimer({table,operation});
    try{return await fn();}catch(error){this.failures.inc({table,operation});throw error;}finally{end();}
  }
  async ensureFuturePartitions(table,months=3){
    this.table(table);this.months(months);
    return this.operation(table,'precreate',async()=>{
      const result=await this.database.query('SELECT minego_ensure_partition_horizon($1,$2) AS created',[table,months]);
      const created=result.rows[0].created;this.created.inc({table},created.length);return created;
    });
  }
  async getPartitionStats(table){
    this.table(table);
    return this.operation(table,'stats',async()=>{
      const result=await this.database.query('SELECT * FROM minego_partition_live_stats($1)',[table]);
      // API values remain exact decimal strings; Prometheus represents numbers as floats.
      const current=new Set(result.rows.map(row=>row.partition_name));
      for(const previous of this.observedPartitions.get(table)||[])if(!current.has(previous)){this.rows.remove(table,previous);this.bytes.remove(table,previous);}
      this.observedPartitions.set(table,current);
      for(const row of result.rows){this.rows.set({table,partition:row.partition_name},Number(row.row_count));this.bytes.set({table,partition:row.partition_name},Number(row.size_bytes));}
      return result.rows.map(row=>({name:row.partition_name,bound:row.partition_bound,isDefault:row.is_default,rowCount:String(row.row_count),sizeBytes:String(row.size_bytes),estimatedRows:String(row.estimated_rows),start:row.start_at,end:row.end_at}));
    });
  }
  async healthCheck(table,months=3){
    this.table(table);this.months(months);
    const result=await this.database.query('SELECT minego_partition_live_health($1,$2) AS health',[table,months]);return result.rows[0].health;
  }
  async getOverview(){
    const overview={};
    for(const table of TABLES){
      const partitions=await this.getPartitionStats(table);
      overview[table]={partitionCount:partitions.length,totalRows:partitions.reduce((sum,p)=>sum+BigInt(p.rowCount),0n).toString(),totalSizeBytes:partitions.reduce((sum,p)=>sum+BigInt(p.sizeBytes),0n).toString(),partitions,health:await this.healthCheck(table)};
    }
    return overview;
  }
  async precreateAll(){const result={};for(const table of TABLES)result[table]=await this.ensureFuturePartitions(table,3);return result;}
  async start({intervalMs=86400000,onError=()=>{}}={}){
    if(!Number.isInteger(intervalMs)||intervalMs<1000)throw new Error('Invalid partition refresh interval');
    if(!this.stopped)return;
    this.stopped=false;
    this.running=this.precreateAll();
    try{await this.running;}catch(error){this.stopped=true;throw error;}finally{this.running=null;}
    const tick=async()=>{
      if(this.stopped)return;
      this.running=this.precreateAll();
      try{await this.running;}catch(error){try{onError(error);}catch{}}finally{this.running=null;if(!this.stopped)this.timer=setTimeout(tick,intervalMs);}
    };
    if(!this.stopped)this.timer=setTimeout(tick,intervalMs);
  }
  async stop(){this.stopped=true;clearTimeout(this.timer);this.timer=null;if(this.running)await this.running.catch(()=>{});}
}
const partitionMaintenance=new PartitionMaintenance();
module.exports={PartitionMaintenance,partitionMaintenance,TABLES};
