'use strict';
const {createProxyMiddleware}=require('../proxy');
const prefixes=['/api/notifications','/api/v1/notifications','/api/v2/notifications','/v1/notifications','/notifications'];
function mountNotificationProxy(app,target){
  const forward=(outgoing,req)=>{outgoing.removeHeader('x-forwarded-for');outgoing.removeHeader('x-real-ip');outgoing.setHeader('X-Forwarded-For',req.ip?require('../../../shared/clientIp').getClientIp(req):require('../../../shared/clientIp').getUpgradeClientIp(req,app));};
  const proxy=createProxyMiddleware({target,changeOrigin:true,pathRewrite:{'^/':'/notifications/'},on:{proxyReq:forward}});
  app.use(prefixes,proxy);
  const websocket=createProxyMiddleware({target,changeOrigin:true,on:{proxyReqWs:forward}});const sockets=new Set();let ownerServer,upgrade;
  return {attach(server,authorize){ownerServer=server;upgrade=async(req,socket,head)=>{
    if(new URL(req.url,'http://localhost').pathname!=='/ws/notifications'){if(server.listenerCount('upgrade')===1)socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');return;}
    try{
      if(authorize&&!await authorize(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
      sockets.add(socket);socket.once('close',()=>sockets.delete(socket));websocket.upgrade(req,socket,head);
    }catch{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');}
  };server.on('upgrade',upgrade);},close(){if(upgrade)ownerServer.removeListener('upgrade',upgrade);for(const socket of sockets)socket.destroy();sockets.clear();proxy.close();websocket.close();}};
}
module.exports={mountNotificationProxy,prefixes};
