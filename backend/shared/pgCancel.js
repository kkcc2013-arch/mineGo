'use strict';
const {Client}=require('pg');

// Use the driver's PostgreSQL transport, including the original TLS policy.
// This packet targets one backend with its private startup PID/key pair. It is
// started before the failed lease is destroyed, and never reuses a healthy lease.
function requestOwnedCancellation(client,timeout){
  if(!Number.isInteger(client?.processID)||!Number.isInteger(client?.secretKey))return null;
  const pid=client.processID,key=client.secretKey,host=client.host,port=client.port;
  if(typeof host!=='string'||!port)throw new TypeError('Owned PostgreSQL endpoint is required');
  const connection=new Client({host,port,ssl:client.ssl||false}).connection;
  return new Promise((resolve,reject)=>{
    let settled=false,sent=false,timer;
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error)reject(error);else resolve();
    };
    const fail=error=>{finish(error);connection.stream.destroy();};
    connection.on('error',fail);
    connection.once('errorMessage',()=>fail(new Error('Owned cancellation transport rejected')));
    connection.once('end',()=>finish(sent?undefined:new Error('Owned cancellation closed before request')));
    const send=()=>{sent=true;connection.cancel(pid,key);};
    connection.once('connect',()=>{if(client.ssl)connection.requestSsl();else send();});
    connection.once('sslconnect',()=>connection.stream.once('secureConnect',send));
    timer=setTimeout(()=>fail(new Error('Owned cancellation transport timeout')),timeout);
    try{
      if(host.startsWith('/'))connection.connect(host+'/.s.PGSQL.'+port);
      else connection.connect(port,host);
    }catch(error){fail(error);}
  });
}
module.exports={requestOwnedCancellation};
