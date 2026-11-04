#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require(require.resolve('@babel/parser', { paths: [path.join(__dirname, '../backend')] }));

function hasHealthRegistration(source) {
  const ast = parser.parse(source, { sourceType: 'unambiguous' });
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type) nodes.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  const property = (object, name) => object?.properties?.find(p => (p.key.name || p.key.value) === name)?.value;
  const routers = new Set(nodes.filter(node => node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression' && node.init.callee.name === 'createHealthRoutes').map(node => node.id.name));
  return nodes.some(node => {
    if (node.type !== 'CallExpression') return false;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression') return false;
    if (callee.object.name === 'app' && callee.property.name === 'get' && node.arguments[0]?.value === '/health') return true;
    if (callee.object.name === 'app' && callee.property.name === 'use' && routers.has(node.arguments[0]?.name)) return true;
    if (callee.object.name === 'ServiceFactory' && callee.property.name === 'createService') {
      const config = node.arguments[0];
      if (config?.type !== 'ObjectExpression') return false;
      const options = property(config, 'options');
      if (options && options.type !== 'ObjectExpression') return false;
      const enabled = property(options, 'healthCheck');
      return !enabled || (enabled.type === 'BooleanLiteral' && enabled.value === true);
    }
    return false;
  });
}

function main() {
  const root = path.resolve(__dirname, '..');
  const services = fs.readdirSync(path.join(root, 'backend/services')).map(name => `backend/services/${name}/src/index.js`).filter(file => fs.existsSync(path.join(root, file)));
  services.push('backend/gateway/src/index.js');
  const missing = services.filter(file => !hasHealthRegistration(fs.readFileSync(path.join(root, file), 'utf8')));
  for (const file of missing) console.error(`Missing health route registration: ${file}`);
  console.log(`Checked ${services.length} service entry points; ${missing.length} missing health registrations.`);
  if (missing.length) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { hasHealthRegistration };
