'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasHealthRegistration } = require('../check-health-routes');

test('recognizes direct health routes with either quote style', () => {
  assert.equal(hasHealthRegistration('app.get("/health", handler);'), true);
  assert.equal(hasHealthRegistration("app.get('/health', handler);"), true);
});

test('comments and unrelated GET routes do not register health', () => {
  assert.equal(hasHealthRegistration("// app.get('/health', handler);\napp.get('/users', handler);"), false);
});

test('factory defaults register health while explicitly disabled health does not', () => {
  assert.equal(hasHealthRegistration("ServiceFactory.createService({name: 'catch'});"), true);
  assert.equal(hasHealthRegistration("ServiceFactory.createService({options: {healthCheck: false}});"), false);
  assert.equal(hasHealthRegistration('ServiceFactory.createService(dynamicConfig);'), false);
});

test('health router creation requires mounting that router', () => {
  assert.equal(hasHealthRegistration('const routes = createHealthRoutes({}); app.use(routes);'), true);
  assert.equal(hasHealthRegistration('const routes = createHealthRoutes({});'), false);
});
