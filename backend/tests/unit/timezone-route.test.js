'use strict';
jest.mock('../../shared/db',()=>({query:jest.fn()}));
const express=require('express');
const request=require('supertest');
const db=require('../../shared/db');
const router=require('../../services/user-service/src/routes/timezone');
const {signAccess,errorHandler}=require('../../shared/auth');
const app=express();app.use(express.json());app.use('/users',router);app.use(errorHandler);
const signed=(method,url)=>request(app)[method](url).set('Authorization',`Bearer ${signAccess({sub:'user'})}`);
beforeEach(()=>db.query.mockReset());
test('all private timezone paths verify identity and ownership before querying',async()=>{
  for(const [method,path] of [['get',''],['put',''],['post','/auto-detect']]){
    expect((await request(app)[method](`/users/user/timezone${path}`)).status).toBe(401);
    expect((await signed(method,`/users/other/timezone${path}`)).status).toBe(403);
  }
  expect(db.query).not.toHaveBeenCalled();
});
test('own missing preference returns the declared default without writing consent',async()=>{
  db.query.mockResolvedValue({rows:[]});const response=await signed('get','/users/user/timezone');
  expect(response.status).toBe(200);expect(response.body.timezone).toBe('UTC');expect(db.query).toHaveBeenCalledTimes(1);
});
test('invalid values fail before writes; an explicit false flag is preserved',async()=>{
  for(const body of [{timezone:'bad'},{timezone:{value:'UTC'}},{timezone:'UTC',autoDetect:'false'}])expect((await signed('put','/users/user/timezone').send(body)).status).toBe(400);
  expect(db.query).not.toHaveBeenCalled();
  db.query.mockResolvedValue({rows:[{user_id:'user',timezone:'Asia/Tokyo',auto_detect:false}]});
  expect((await signed('put','/users/user/timezone').send({timezone:'Asia/Tokyo',autoDetect:false})).body.autoDetect).toBe(false);
  expect(db.query.mock.calls[0][1]).toEqual(['user','Asia/Tokyo',false]);
});
test('auto-detection uses an actual client timezone and never guesses UTC from an arbitrary IP',async()=>{
  expect((await signed('post','/users/user/timezone/auto-detect').set('x-forwarded-for','203.0.113.1')).status).toBe(400);
  expect(db.query).not.toHaveBeenCalled();
  db.query.mockResolvedValue({rows:[{user_id:'user',timezone:'Asia/Shanghai'}]});
  const response=await signed('post','/users/user/timezone/auto-detect').set('Time-Zone','Asia/Shanghai');
  expect(response.status).toBe(200);expect(response.body.detectedFrom).toBe('Time-Zone');expect(response.body.detectedFromIP).toBeUndefined();
});
