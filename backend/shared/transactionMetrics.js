'use strict';
const registry=require('./metrics');
const counter=(name,help,labels)=>registry.register.getSingleMetric(name)||registry.counter(name,help,labels);
module.exports={
  started:counter('db_transaction_started_total','Transaction operations started',['service','isolation_level']),
  attempts:counter('db_transaction_attempts_total','Checked-out business transaction attempts',['service','isolation_level']),
  completed:counter('db_transaction_completed_total','Successfully committed transaction operations',['service','isolation_level']),
  failed:counter('db_transaction_failed_total','Failed transaction attempts',['service','isolation_level','error_type']),
  legacyRetries:counter('db_transaction_retries_total','Actual checked-out transaction retries',['service','isolation_level']),
  total:counter('db_transactions_total','Completed transaction operations',['service','status','isolation_level']),
  retries:counter('db_deadlock_retries_total','Retries after real database contention',['service','isolation_level']),
  duration:registry.register.getSingleMetric('db_transaction_duration_seconds')||registry.histogram('db_transaction_duration_seconds','Owned transaction duration',['service','isolation_level'],[0.01,0.05,0.1,0.5,1,2,5,10,30]),
  active:registry.register.getSingleMetric('db_active_transactions')||registry.gauge('db_active_transactions','Checked-out owned transactions',['service'])
};
