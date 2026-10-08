'use strict';
function getClientIp(req) {
  // Express resolves forwarded addresses according to the configured trusted peers.
  // Direct reads of caller-provided forwarding headers would bypass that boundary.
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
  return typeof ip === 'string' ? ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1') : ip;
}
function getUpgradeClientIp(req,app){
  const address=require('proxy-addr')(req,app.get('trust proxy fn')||(()=>false));
  return typeof address==='string'?address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i,'$1'):address;
}
module.exports = {getClientIp,getUpgradeClientIp};
