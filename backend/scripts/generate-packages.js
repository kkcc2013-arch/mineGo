#!/usr/bin/env node
// generate-package-jsons.js — run once to scaffold package.json for each service
const fs = require('fs');
const path = require('path');

const services = [
  { name: 'location-service', port: 8082, extra: {} },
  { name: 'pokemon-service',  port: 8083, extra: {} },
  { name: 'catch-service',    port: 8084, extra: {} },
  { name: 'gym-service',      port: 8085, extra: { ws: '^8.16.0' } },
  { name: 'social-service',   port: 8086, extra: {} },
  { name: 'reward-service',   port: 8087, extra: {} },
  { name: 'payment-service',  port: 8088, extra: {} },
];

const gatewayPkg = {
  name: '@pmg/api-gateway',
  version: '1.0.0',
  main: 'src/index.js',
  scripts: { dev: 'nodemon src/index.js', start: 'node src/index.js' },
  dependencies: {
    '@pmg/shared': '*',
    express: '^4.18.2',
    cors: '^2.8.5',
    helmet: '^7.1.0',
    'express-rate-limit': '^7.1.5',
    'http-proxy-middleware': '^3.0.0',
  },
};

fs.writeFileSync(
  path.join(__dirname, '../gateway/package.json'),
  JSON.stringify(gatewayPkg, null, 2)
);
console.log('wrote gateway/package.json');

for (const svc of services) {
  const pkg = {
    name: `@pmg/${svc.name}`,
    version: '1.0.0',
    main: 'src/index.js',
    scripts: { dev: 'nodemon src/index.js', start: 'node src/index.js' },
    dependencies: {
      '@pmg/shared': '*',
      express: '^4.18.2',
      cors: '^2.8.5',
      helmet: '^7.1.0',
      zod: '^3.22.4',
      uuid: '^9.0.0',
      ...svc.extra,
    },
  };
  const dir = path.join(__dirname, `../services/${svc.name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log(`wrote ${svc.name}/package.json`);
}
