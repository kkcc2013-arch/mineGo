'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {splitStatements,parseMigrationFile,parseMigrationFilename,calculateChecksum}=require('../../../database/migrate');
const {migrationStatements}=require('../../../database/sqlStatements');

test('actual SQL lexer preserves string semicolons, doubled quotes, identifiers and dollar bodies',()=>{
  const script=String.raw`SELECT 'a;it''s'; SELECT "semi;""colon"; DO $fn$ BEGIN PERFORM 'inside;'; END $fn$; SELECT E'escaped\';still quoted';`;
  assert.equal(splitStatements(script).length,4);
});
test('nested comments and line comments do not create SQL boundaries',()=>{
  assert.deepEqual(splitStatements('/* outer; /* nested; */ end; */ SELECT 1; -- ignored;\nSELECT 2; -- trailing only;'),['/* outer; /* nested; */ end; */ SELECT 1','-- ignored;\nSELECT 2']);
  assert.deepEqual(splitStatements('-- comment only'),[]);
});
test('unterminated SQL cannot be recorded as a completed migration',()=>{
  for(const sql of ["SELECT 'unclosed",'SELECT "unclosed','DO $$ BEGIN NULL;','/* unclosed'])assert.throws(()=>splitStatements(sql),/Unterminated/);
});
test('section markers inside quoted function bodies and inline strings are data',()=>{
  const up=`DO $fn$ BEGIN\n-- migrate:down\nPERFORM '-- migrate:up'; END $fn$;`;
  const parts=parseMigrationFile(`-- migrate:up\n${up}\n-- migrate:down\nSELECT 2;`);
  assert.equal(parts.up,up);assert.equal(parts.down,'SELECT 2;');
  assert.throws(()=>parseMigrationFile('-- migrate:up\nSELECT 1;\n-- migrate:up\nSELECT 2;'),/directives/);
});
test('legacy outer transactions stay under runner ownership; internal commits are rejected',()=>{
  assert.deepEqual(migrationStatements('BEGIN; CREATE TABLE fixture(id integer); COMMIT;'),['CREATE TABLE fixture(id integer)']);
  assert.deepEqual(migrationStatements('CREATE TABLE fixture(id integer); COMMIT;'),['CREATE TABLE fixture(id integer)']);
  assert.throws(()=>migrationStatements('INSERT INTO fixture VALUES(1); COMMIT; INSERT INTO fixture VALUES(2);'),/runner transaction/);
  assert.throws(()=>migrationStatements('BEGIN; SELECT 1;'),/runner transaction/);
  assert.throws(()=>migrationStatements('-- TODO'),/no executable/);
});
test('actual migration identities and checksums distinguish changed SQL',()=>{
  assert.equal(parseMigrationFilename('20261008_120000__example.sql').version,'20261008_120000');
  assert.equal(parseMigrationFilename('example.sql'),null);
  assert.equal(calculateChecksum('SELECT 1;'),calculateChecksum('SELECT 1;'));
  assert.notEqual(calculateChecksum('SELECT 1;'),calculateChecksum('SELECT 2;'));
});
