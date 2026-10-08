'use strict';

const express = require('express');
const request = require('supertest');
const { ServiceFactory } = require('../../shared/ServiceFactory');
const { createHealthRoutes } = require('../../shared/healthRoutes');

test('ServiceFactory registers usable health and readiness routes by default', async () => {
  const { app } = await ServiceFactory.createService({ name: 'factory-test', port: 0, options: { createServer: true, gracefulShutdown: false, metricsEnabled: false } });
  const health = await request(app).get('/health');
  expect(health.status).toBe(200);
  expect(health.body.service).toBe('factory-test');
  expect((await request(app).get('/ready')).status).toBe(200);
});

test('disabled factory health checks do not expose an accidental success endpoint', async () => {
  const { app } = await ServiceFactory.createService({ name: 'disabled-test', port: 0, options: { createServer: true, gracefulShutdown: false, metricsEnabled: false, healthCheck: false } });
  expect((await request(app).get('/health')).status).toBe(404);
});

test('mounted shared health routers expose health, liveness, and readiness', async () => {
  const app = express();
  app.use(createHealthRoutes({ serviceName: 'router-test' }));
  for (const route of ['/health', '/health/live', '/health/ready']) expect((await request(app).get(route)).status).toBe(200);
});

test('unhealthy dependency reports fail readiness instead of returning success', async () => {
  const app = express();
  app.use(createHealthRoutes({ healthChecker: { readinessCheck: async () => ({ status: 'not_ready' }), runAllChecks: async () => ({ status: 'unhealthy' }) } }));
  expect((await request(app).get('/health/ready')).status).toBe(503);
  expect((await request(app).get('/health')).status).toBe(503);
});
