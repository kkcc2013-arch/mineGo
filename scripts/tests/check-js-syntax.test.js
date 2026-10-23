'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkSource } = require('../check-js-syntax');

test('accepts CommonJS, browser ESM, and frontend JSX using their supported grammar', () => {
  assert.doesNotThrow(() => checkSource("module.exports = require('node:fs');", 'backend/module.js'));
  assert.doesNotThrow(() => checkSource('export const value = 1;', 'frontend/module.js'));
  assert.doesNotThrow(() => checkSource('export const view = () => <button>Go</button>;', 'frontend/component.js'));
});

test('rejects JSX in server files and invalid JavaScript in all surfaces', () => {
  assert.throws(() => checkSource('const view = <button />;', 'backend/module.js'));
  assert.throws(() => checkSource('const broken = ;', 'frontend/module.js'));
  assert.throws(() => checkSource('class A { method() { await call(); } }', 'backend/module.js'));
  assert.throws(() => checkSource('const a = 1; const a = 2;', 'frontend/module.js'));
});
