'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {SENSITIVITY_LEVELS,redactP0}=require('../../shared/sensitiveFields');
test('original P0 fields and credential aliases are removed at every structured depth',()=>{
 const input={email:'allowed@example.invalid',nested:[{card_number:'card',cardNumber:'card',password:'secret',refreshToken:'secret',note:'keep'}]};
 for(const key of SENSITIVITY_LEVELS.P0)input[key]='private';
 assert.deepEqual(redactP0(input),{email:'allowed@example.invalid',nested:[{note:'keep'}]});assert.equal(input.nested[0].password,'secret');
});
test('JSON prototype-like keys cannot survive privileged projection',()=>{
 const input=JSON.parse('{"__proto__":{"polluted":true},"constructor":"unsafe","prototype":"unsafe","value":1}');
 assert.deepEqual(redactP0(input),{value:1});assert.equal({}.polluted,undefined);
});
test('genuine timestamps and primitive values retain their representation',()=>{
 assert.deepEqual(redactP0({timestamp:new Date('2020-01-02T03:04:05.000Z'),value:[null,0,false,'text']}),{timestamp:'2020-01-02T03:04:05.000Z',value:[null,0,false,'text']});
});
test('excessive or cyclic structures refuse a response with a fixed error',()=>{
 const cyclic={};cyclic.loop=cyclic;assert.throws(()=>redactP0(cyclic),/Sensitive payload depth exceeded/);
});
