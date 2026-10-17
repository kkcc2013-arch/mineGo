'use strict';
const {Console}=require('node:console');
const {Writable}=require('node:stream');
const {performance}=require('node:perf_hooks');
const {createLogger}=require('../../shared/logger');
const {ConsoleMigrationHelper}=require('../../shared/loggingUtils');
const sink=()=>new Writable({decodeStrings:false,write(_chunk,_encoding,done){done();}});
const consoleLogger=new Console({stdout:sink(),stderr:sink()});
const structured=new ConsoleMigrationHelper(createLogger('benchmark',{destination:sink()}),'benchmark');
const iterations=20000;
function measure(fn){const start=performance.now();for(let i=0;i<iterations;i++)fn(i);return performance.now()-start;}
function median(values){return [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];}
const cases=[['message',i=>consoleLogger.log('Operation completed'),i=>structured.log('Operation completed')],['printf',i=>consoleLogger.log('value %d',i),i=>structured.log('value %d',i)],['object',i=>consoleLogger.log('data', {value:i}),i=>structured.log('data',{value:i})]];
const results=[];
for(const [name,before,after] of cases){measure(before);measure(after);const oldSamples=[],newSamples=[];for(let n=0;n<7;n++){if(n%2){newSamples.push(measure(after));oldSamples.push(measure(before));}else{oldSamples.push(measure(before));newSamples.push(measure(after));}}const oldMs=median(oldSamples),newMs=median(newSamples);results.push({name,iterations,beforeMs:oldMs,afterMs:newMs,overheadPercent:(newMs/oldMs-1)*100});}
process.stdout.write(JSON.stringify({passed:results.every(result=>result.overheadPercent<=5),thresholdPercent:5,runtime:process.version,scope:'formatting plus writes into synchronous in-memory discard streams; not production disk/network throughput',results},null,2)+'\n');

if(results.some(result=>result.overheadPercent>5)) process.exitCode=1;
