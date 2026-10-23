'use strict';
const {Writable} = require('node:stream');
const express = require('express');
const request = require('supertest');
const path = require('node:path');
const vm = require('node:vm');
const {ConsoleMigrationHelper, replaceConsole} = require('../../shared/loggingUtils');
const {createLogger, requestLogger} = require('../../shared/logger');
const {analyze,transform,fingerprintCounts,newCalls} = require('../../../scripts/replace-console-with-logger');

test('migration preserves argument evaluation, interpolation, directives, comments and hashbang', () => {
  const source = '#!/usr/bin/env node\n/** console.log("comment"); */\n"use strict";\nlet _consoleLogger=1;\nconst nested=()=>{count++;return "nested"};\nconsole.log(`value ${nested()}`, {value:nested()}, nested());';
  const file=path.resolve(__dirname,'../../shared/test-fixture.js');
  const transformed=transform(source,file);
  expect(transformed.converted).toBe(1);
  expect(transformed.source.startsWith('#!/usr/bin/env node')).toBe(true);
  expect(transformed.source).toContain('/** console.log("comment"); */');
  expect(analyze(transformed.source).calls).toHaveLength(0);
  const records=[];
  const logger={info:(details,message)=>records.push({details,message})};
  const context={count:0,require:name=>name.includes('loggingUtils')?{ConsoleMigrationHelper}:{createLogger:()=>logger}};
  vm.runInNewContext(transformed.source,context);
  expect(context.count).toBe(3);
  expect(records[0].message).toBe("value nested { value: 'nested' } nested");
});

test('new module logger names cannot be shadowed by nested parameters', () => {
  const source='function call(_consoleLogger){console.log(_consoleLogger);} call("value");';
  const result=transform(source,path.resolve(__dirname,'../../shared/fixture.js'));
  const logger={info:jest.fn()};
  vm.runInNewContext(result.source,{require:name=>name.includes('loggingUtils')?{ConsoleMigrationHelper}:{createLogger:()=>logger}});
  expect(logger.info.mock.calls[0][1]).toBe('value');
});

test('scanner distinguishes strings and comments, shadowed console and computed methods', () => {
  const source='// console.error("comment")\nconst text="console.log()";\nfunction local(console){console.log("local")}\nconsole["warn"]("actual");\nconsole?.log("optional");';
  const calls=analyze(source).calls;
  expect(calls.map(call=>call.method)).toEqual(['warn','log']);
  expect(calls.map(call=>call.supported)).toEqual([true,false]);
  expect(transform(source,path.resolve(__dirname,'../../shared/fixture.js')).converted).toBe(1);
});

test('does not insert an import inside a leading multiline comment', () => {
  const transformed=transform('/**\n * header\n */\nconsole.error(new Error("failure"));',path.resolve(__dirname,'../../shared/fixture.js'));
  expect(transformed.source.indexOf('require(')).toBeGreaterThan(transformed.source.indexOf('*/'));
  expect(() => analyze(transformed.source)).not.toThrow();
});

test('refuses unsupported module rewrites and leaves timer operations for review', () => {
  const file=path.resolve(__dirname,'../../shared/fixture.js');
  expect(() => transform('export const test=()=>console.log("x");',file)).toThrow('reviewed import');
  expect(transform('console.time("label");',file).converted).toBe(0);
});

test('baseline rejects new calls and duplicates while allowing line shifts and removal', () => {
  const calls=analyze('console.log("old");').calls.map(call=>({file:'test.js',...call}));
  const baseline=fingerprintCounts(calls);
  expect(newCalls([{...calls[0],line:50}],baseline)).toHaveLength(0);
  expect(newCalls([calls[0],calls[0]],baseline)).toHaveLength(1);
  expect(newCalls([],baseline)).toHaveLength(0);
  expect(newCalls(analyze('console.log("new");').calls.map(call=>({file:'test.js',...call})),baseline)).toHaveLength(1);
});

test('helper levels, objects, printf and errors produce structured records with redacted secrets', () => {
  const records=[];
  const logger=Object.fromEntries(['info','warn','error','debug','trace'].map(level=>[level,(details,message)=>records.push({level,details,message})]));
  const helper=new ConsoleMigrationHelper(logger,'test-module');
  helper.log('number %d',42);
  helper.info({password:'never-log-me',nested:{token:'also-secret'}});
  helper.warn('warning'); helper.debug('debug'); helper.trace('trace');
  const error=new Error('failure'); error.config={headers:{authorization:'private-error-header'}}; helper.error(error);
  helper.log();
  expect(records[0].message).toBe('number 42');
  expect(JSON.stringify(records)).not.toContain('never-log-me');
  expect(JSON.stringify(records)).not.toContain('also-secret');
  expect(records[1].details.data[0].password).toBe('[REDACTED]');
  expect(records.find(record=>record.level==='error').details.err.message).toBe(error.message);
  expect(JSON.stringify(records)).not.toContain('private-error-header');
  expect(records.find(record=>record.level==='trace').details.stack).toContain('Log call site');
});

test('object formatting neither invokes getters nor mutates original data, and tolerates cycles', () => {
  const original={password:'secret'};original.self=original;
  Object.defineProperty(original,'computed',{enumerable:true,get(){throw new Error('Getter must not run');}});
  const logger={info:jest.fn()};
  const helper=new ConsoleMigrationHelper(logger,'test-module');
  expect(()=>helper.log(original)).not.toThrow();
  expect(original.password).toBe('secret');
  expect(logger.info.mock.calls[0][0].data[0].computed).toBe('[Getter]');
});

test('preserves dates, buffers and collection values when normalizing structured data', () => {
  const logger={info:jest.fn()};const helper=new ConsoleMigrationHelper(logger,'test');
  const value={date:new Date('2020-01-01T00:00:00Z'),bytes:Buffer.from('abc'),map:new Map([['value',42],['token','hidden']]),set:new Set([1,2]),pattern:/test/g};
  helper.log(value);
  const data=logger.info.mock.calls[0][0].data[0];
  expect(data.date.toISOString()).toBe(value.date.toISOString());
  expect(data.bytes.toString()).toBe('abc');
  expect(data.map.get('value')).toBe(42);expect(data.map.get('token')).toBe('[REDACTED]');
  expect([...data.set]).toEqual([1,2]);expect(data.pattern.toString()).toBe('/test/g');
  expect(value.map.get('token')).toBe('hidden');
});

test('disabled levels do not serialize objects', () => {
  const object={};Object.defineProperty(object,'message',{enumerable:true,get(){throw new Error('Disabled log must not evaluate getters');}});
  const logger={isLevelEnabled:()=>false,debug:jest.fn()};
  expect(()=>new ConsoleMigrationHelper(logger,'test').debug(object)).not.toThrow();
  expect(logger.debug).not.toHaveBeenCalled();
});

test('global replacement is explicit, retains console methods and can be restored', () => {
  const original=global.console;
  const logger={info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn(),trace:jest.fn()};
  const restore=replaceConsole(logger,'test');
  try {global.console.log('message');expect(logger.info).toHaveBeenCalled();expect(typeof global.console.time).toBe('function');}
  finally {restore();}
  expect(global.console).toBe(original);
});

test('request context is automatic and isolated across concurrent real HTTP requests', async () => {
  const records=[];
  const destination=new Writable({write(chunk,_encoding,done){for(const line of chunk.toString().trim().split('\n')) records.push(JSON.parse(line));done();}});
  const logger=createLogger('logging-test',{destination});
  const app=express();app.use(requestLogger(logger));
  app.get('/:id',async(req,res)=>{
    req.user={id:req.params.id};
    await new Promise(resolve=>setTimeout(resolve,req.params.id==='one'?10:1));
    logger.info({marker:req.params.id},'Business action');res.json({ok:true});
  });
  await Promise.all(['one','two'].map(id=>request(app).get(`/${id}`).set('x-request-id',`request-${id}`)));
  const business=records.filter(record=>record.msg==='Business action');
  expect(business).toHaveLength(2);
  for(const record of business){expect(record.userId).toBe(record.marker);expect(record.requestId).toBe(`request-${record.marker}`);}
  logger.info({outside:true},'Outside request');
  expect(records.find(record=>record.outside).requestId).toBeUndefined();
});

test('monitoring error paths log their actual failure instead of throwing an undefined logger error', async () => {
  expect(() => new (require('../../shared/ImageProcessor').ImageProcessor)()).not.toThrow();
  const {BusinessMetricsCollector}=require('../../shared/businessMetrics');
  const collector=new BusinessMetricsCollector({}, {query:async()=>{throw new Error('test database unavailable');}});
  await expect(collector.getStatsFromDB()).resolves.toEqual({});
  await expect(require('../../shared/spawnMetrics').updateActiveSpawns({keys:async()=>{throw new Error('test cache unavailable');}})).resolves.toBeUndefined();
});
