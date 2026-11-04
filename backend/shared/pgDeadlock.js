'use strict';
const ERROR_CODES=Object.freeze({DEADLOCK_DETECTED:'40P01',SERIALIZATION_FAILURE:'40001',LOCK_NOT_AVAILABLE:'55P03',QUERY_CANCELED:'57014'});
const isDeadlockError=e=>!!e&&['40P01','40001'].includes(e.code);
function parseDeadlockDetail(e){
  if(typeof e?.detail!=='string'||!e.detail)return null;
  return {code:e.code,message:e.message,detail:e.detail,processes:[...new Set([...e.detail.matchAll(/[Pp]rocess (\d+)/g)].map(m=>Number(m[1])))],timestamp:Date.now()};
}
function logDeadlock(queryable,info,context={}){
  return queryable.query(`INSERT INTO deadlock_log(code,message,detail,processes,transaction_name,retry_count,context)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[info.code,info.message,info.detail??null,JSON.stringify(info.processes??[]),context.transactionName??'unknown',context.retryCount??0,JSON.stringify(context)]);
}
module.exports={ERROR_CODES,isDeadlockError,parseDeadlockDetail,logDeadlock};
