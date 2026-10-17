'use strict';
const registry=require('./metrics');
const counter=(name,help,labels)=>registry.register.getSingleMetric(name)||registry.counter(name,help,labels);

// Count actual producer events cheaply and flush their exact deltas through the
// public Counter API when observed. Public inc/get/reset remain usable.
function collectedCounter(name,help,labelNames){
  const metric=counter(name,help,labelNames),rows=new WeakMap(),pending=new Set();
  const increment=metric.inc.bind(metric),reset=metric.reset.bind(metric),previousCollect=metric.collect;
  metric.collect=async function(){
    if(previousCollect)await previousCollect.call(this);
    for(const row of pending){increment(row.labels,row.delta);row.delta=0;}
    pending.clear();
  };
  metric.reset=()=>{for(const row of pending)row.delta=0;pending.clear();reset();};
  const record=labels=>{
    let row=rows.get(labels);
    if(!row){increment(labels,0);row={labels,delta:0};rows.set(labels,row);}
    row.delta++;pending.add(row);
  };
  return {metric,record};
}
const started=collectedCounter('db_transaction_started_total','Transaction operations started',['service','isolation_level']);
const attempts=collectedCounter('db_transaction_attempts_total','Checked-out business transaction attempts',['service','isolation_level']);
const completed=collectedCounter('db_transaction_completed_total','Successfully committed transaction operations',['service','isolation_level']);
const total=collectedCounter('db_transactions_total','Completed transaction operations',['service','status','isolation_level']);
const active=registry.register.getSingleMetric('db_active_transactions')||registry.gauge('db_active_transactions','Checked-out transactions with operation metrics enabled',['service']);
const activeSources=new Set();
active.collect=()=>{
  const totals=new Map();
  for(const source of activeSources)for(const [service,value]of source)totals.set(service,(totals.get(service)||0)+value);
  for(const [service,value]of totals)active.set({service},value);
};
module.exports={
  started:started.metric,recordStarted:started.record,
  attempts:attempts.metric,recordAttempt:attempts.record,
  completed:completed.metric,recordCompleted:completed.record,
  total:total.metric,recordTotal:total.record,
  failed:counter('db_transaction_failed_total','Failed transaction attempts',['service','isolation_level','error_type']),
  legacyRetries:counter('db_transaction_retries_total','Actual checked-out transaction retries',['service','isolation_level']),
  retries:counter('db_deadlock_retries_total','Retries after real database contention',['service','isolation_level']),
  duration:registry.register.getSingleMetric('db_transaction_duration_seconds')||registry.histogram('db_transaction_duration_seconds','Owned transaction duration',['service','isolation_level'],[0.01,0.05,0.1,0.5,1,2,5,10,30]),
  active,registerActiveSource:source=>activeSources.add(source)
};
