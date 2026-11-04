'use strict';
const express=require('express');
const request=require('supertest');
const {getClientIp,createIpBanMiddleware}=require('../../gateway/src/middleware/ipBan');
const {isIpAppealPath}=require('../../gateway/src/routes/ipAppealProxy');
const {createIpAppealRouter}=require('../../services/user-service/src/routes/ipAppeal');
const {errorHandler}=require('../../shared/auth');

test('resolved socket IP wins over untrusted forwarding headers and mapped IPv4 is normalized',()=>{
  expect(getClientIp({ip:'::ffff:192.0.2.4',headers:{'x-forwarded-for':'198.51.100.2','x-real-ip':'198.51.100.3'}})).toBe('192.0.2.4');
  expect(getClientIp({socket:{remoteAddress:'2001:db8::1'},headers:{'x-forwarded-for':'198.51.100.2'}})).toBe('2001:db8::1');
});
test('missing access-control dependencies block business traffic but preserve health and appeals',async()=>{
  const app=express();app.use(createIpBanMiddleware(()=>null));app.use((req,res)=>res.json({ok:true}));
  expect((await request(app).get('/business')).status).toBe(503);
  expect((await request(app).get('/health')).status).toBe(200);
  expect((await request(app).get('/api/ip-appeal/check')).status).toBe(200);
  expect((await request(app).get('/api/ip-appeal-not-an-appeal')).status).toBe(503);
});
test('appeal exceptions match path boundaries, including root and mounted gateway variants',()=>{
  expect(isIpAppealPath('/api/v1/users/ip-appeal')).toBe(true);
  expect(isIpAppealPath('/v1/users/ip-appeal/status')).toBe(true);
  expect(isIpAppealPath('/v1/users/ip-appeal-other')).toBe(false);
  expect(isIpAppealPath('/unrelated/ip-appeal')).toBe(false);
});
test('a forged pre-attached user identity does not bypass appeal JWT verification',async()=>{
  const getManager=jest.fn();const app=express();app.use((req,res,next)=>{req.user={id:'forged'};next();});
  app.use('/ip-appeal',createIpAppealRouter(getManager));app.use(errorHandler);
  expect((await request(app).post('/ip-appeal').send({appealReason:'Please review this ban'})).status).toBe(401);
  expect(getManager).not.toHaveBeenCalled();
});
test('Express trust-proxy configuration, rather than the header directly, selects trusted peer addresses',async()=>{
  const app=express();app.set('trust proxy','loopback');app.get('/',(req,res)=>res.json({ip:getClientIp(req)}));
  const response=await request(app).get('/').set('X-Forwarded-For','192.0.2.9');
  expect(response.body.ip).toBe('192.0.2.9');
});
