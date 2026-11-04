'use strict';

const erasure=require('./dataDeletionProcessor');
async function startErasureJobs(env=process.env) {
  if(env.ERASURE_WORKER_ENABLED!==undefined&&!['true','false'].includes(env.ERASURE_WORKER_ENABLED))throw new TypeError('ERASURE_WORKER_ENABLED must be true or false');
  if(env.ERASURE_WORKER_ENABLED!=='true')return {enabled:false};
  await erasure.start();return {enabled:true};
}
const stopErasureJobs=()=>erasure.stop();
module.exports={startErasureJobs,stopErasureJobs};
