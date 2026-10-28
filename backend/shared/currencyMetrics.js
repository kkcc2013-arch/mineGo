'use strict';
const metrics=require('./metrics');
const counter=(name,help,labels=[])=>metrics.register.getSingleMetric(name)||metrics.counter(name,help,labels);
module.exports={
  cacheHit:counter('exchange_rate_cache_hit_total','Valid exchange quote cache hits'),
  cacheMiss:counter('exchange_rate_cache_miss_total','Exchange quote cache misses'),
  fetchSuccess:counter('exchange_rate_fetch_success_total','Durably published provider quotes',['source']),
  fetchFailure:counter('exchange_rate_fetch_failure_total','Rejected provider quote attempts',['source']),
  lockCreated:counter('exchange_rate_lock_created_total','Committed owned quote locks',['from','to']),
  lockUsed:counter('exchange_rate_lock_used_total','Autocommit quote lock consumption'),
  conversion:counter('currency_conversion_total','Audited currency display conversions',['from','to'])
};
