#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require(require.resolve('@babel/parser', { paths: [path.join(__dirname, '../backend')] }));

function checkSource(source, file) {
  // Browser modules and k6 scripts use ESM. Some frontend components contain
  // JSX, so Node's CommonJS-only --check is not their parser.
  parser.parse(source, {
    sourceType: 'unambiguous',
    plugins: file.startsWith('frontend/') ? ['jsx'] : [],
    allowReturnOutsideFunction: true
  });
}

function sourceFiles(root, folder) {
  const absolute = path.join(root, folder);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const file = path.posix.join(folder, entry.name);
    if (['node_modules', 'coverage', 'dist', 'build'].includes(entry.name)) return [];
    return entry.isDirectory() ? sourceFiles(root, file) : entry.name.endsWith('.js') ? [file] : [];
  });
}

function main() {
  const root = path.resolve(__dirname, '..');
  const files = ['backend', 'frontend', 'scripts', 'infrastructure', 'database'].flatMap(folder => sourceFiles(root, folder)).sort();
  let failures = 0;
  for (const file of files) {
    try { checkSource(fs.readFileSync(path.join(root, file), 'utf8'), file); }
    catch (error) {
      failures++;
      console.error(`${file}:${error.loc?.line || 1}: ${error.message}`);
    }
  }
  console.log(`Checked ${files.length} JavaScript files; ${failures} syntax errors.`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { checkSource };
