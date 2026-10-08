#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const parser = require('../backend/node_modules/@babel/parser');
const traverse = require('../backend/node_modules/@babel/traverse').default;
const ROOT = path.resolve(__dirname, '..');
const METHODS = new Set(['log','info','warn','error','debug','trace']);

function analyze(source) {
  const ast = parser.parse(source, {sourceType:'unambiguous', plugins:['jsx']});
  const calls = [];
  const names = new Set();
  let program;
  traverse(ast, {
    Program(nodePath) { program = nodePath; },
    Identifier(nodePath) {names.add(nodePath.node.name);},
    'CallExpression|OptionalCallExpression'(nodePath) {
      const callee = nodePath.node.callee;
      if (!['MemberExpression','OptionalMemberExpression'].includes(callee.type) ||
          callee.object.type !== 'Identifier' || callee.object.name !== 'console' || nodePath.scope.getBinding('console')) return;
      const method = callee.computed ? (callee.property.type === 'StringLiteral' ? callee.property.value : null) : callee.property.name;
      calls.push({method:method || '<computed>', line:nodePath.node.loc.start.line,
        start:callee.start, end:callee.end,
        supported:METHODS.has(method) && !nodePath.node.optional && !callee.optional,
        fingerprint:crypto.createHash('sha256').update(source.slice(nodePath.node.start,nodePath.node.end)).digest('hex')});
    }
  });
  return {ast, calls, program, names};
}

function transform(source, filename) {
  const {ast, calls, program, names} = analyze(source);
  if (ast.program.sourceType === 'module' && calls.some(call => call.supported)) {
    throw new Error('ES module migration requires a reviewed import change');
  }
  const supported = calls.filter(call => call.supported);
  if (!supported.length) return {source, converted:0, skipped:calls.length};
  let alias = program.scope.generateUidIdentifier('consoleLogger').name;
  while (names.has(alias)) alias = program.scope.generateUidIdentifier('consoleLogger').name;
  const moduleName = path.relative(path.join(ROOT,'backend'),filename).split(path.sep).join('/').replace(/\.js$/, '');
  const relative = target => {
    const result = path.relative(path.dirname(filename),path.join(ROOT,'backend/shared',target)).split(path.sep).join('/');
    return result.startsWith('.') ? result : './'+result;
  };
  const imports = `\nconst ${alias} = new (require(${JSON.stringify(relative('loggingUtils'))})).ConsoleMigrationHelper(\n  require(${JSON.stringify(relative('logger'))}).createLogger(${JSON.stringify(moduleName)}), ${JSON.stringify(moduleName)});\n`;
  const edits = supported.map(call => ({start:call.start,end:call.end,text:`${alias}.${call.method}`}));
  // The parser provides token boundaries after comments, shebang and directives.
  // Preserve use-strict/module directives and every original argument expression.
  const insertion = ast.program.directives.at(-1)?.end ?? ast.program.body[0]?.start ?? ast.program.interpreter?.end ?? source.length;
  edits.push({start:insertion,end:insertion,text:imports});
  let output = source;
  for (const edit of edits.sort((a,b) => b.start-a.start || b.end-a.end)) output = output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  analyze(output); // Reject invalid output before a caller can write it.
  return {source:output, converted:supported.length, skipped:calls.length-supported.length};
}

function sourceFiles(root) {
  const result = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if (['node_modules','tests','__tests__','__mocks__','scripts','cli'].includes(entry.name)) continue;
      const file=path.join(directory,entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js') && entry.name !== 'cli.js' && !/\.(test|spec|cli)\.js$/.test(entry.name)) result.push(file);
    }
  }
  walk(root); return result.sort();
}
function inventory() {
  const records=[];
  for(const folder of ['shared','services','gateway']) for(const file of sourceFiles(path.join(ROOT,'backend',folder))) {
    for(const call of analyze(fs.readFileSync(file,'utf8')).calls) records.push({file:path.relative(ROOT,file).split(path.sep).join('/'),...call});
  }
  return records;
}
function fingerprintCounts(records) {
  const counts={};
  for(const record of records) {
    const key=`${record.file}:${record.method}:${record.fingerprint}`;
    counts[key]=(counts[key]||0)+1;
  }
  return counts;
}
function newCalls(records, baseline) {
  const previous={...baseline};
  return records.filter(record => {
    const key=`${record.file}:${record.method}:${record.fingerprint}`;
    if(previous[key]>0) {previous[key]--;return false;} return true;
  });
}
function main(args=process.argv.slice(2)) {
  if(args.includes('--write')) {
    const index=args.indexOf('--file');
    if(index<0 || !args[index+1]) throw new Error('--write requires one explicit --file');
    const file=path.resolve(args[index+1]);
    if(!file.startsWith(path.join(ROOT,'backend')+path.sep) || !fs.realpathSync(file).startsWith(path.join(ROOT,'backend')+path.sep)) throw new Error('Only backend files may be migrated');
    const original=fs.readFileSync(file,'utf8');
    const result=transform(original,file);
    fs.writeFileSync(file,result.source);
    process.stdout.write(JSON.stringify({file:path.relative(ROOT,file),converted:result.converted,skipped:result.skipped})+'\n');
    return;
  }
  const records=inventory();
  const baselinePath=path.join(ROOT,'backend/logging-console-baseline.json');
  if(args.includes('--baseline')) fs.writeFileSync(baselinePath,JSON.stringify({schemaVersion:1,calls:fingerprintCounts(records)},null,2)+'\n');
  if(args.includes('--check')) {
    const added=newCalls(records,JSON.parse(fs.readFileSync(baselinePath,'utf8')).calls);
    if(added.length) {process.stderr.write(JSON.stringify({newConsoleCalls:added},null,2)+'\n');process.exitCode=1;}
  }
  const outputIndex=args.indexOf('--output');
  const report=JSON.stringify({files:new Set(records.map(record=>record.file)).size,calls:records.length,records},null,2)+'\n';
  if(outputIndex>=0) fs.writeFileSync(args[outputIndex+1],report);
  process.stdout.write(JSON.stringify({files:new Set(records.map(record=>record.file)).size,calls:records.length})+'\n');
}
if(require.main===module) {try {main();} catch(error) {process.stderr.write(error.message+'\n');process.exitCode=1;}}
module.exports={analyze,transform,inventory,newCalls,fingerprintCounts};
