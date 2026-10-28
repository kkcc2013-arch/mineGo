'use strict';
const http = require('node:http');
const request = require('supertest');
const { ServiceLauncher } = require('../../shared/ServiceLauncher');
const HealthChecker = require('../../shared/HealthChecker');
const { createHealthRoutes } = require('../../shared/healthRoutes');
const active = new Set();
function launcher(options = {}) {
  const service = new ServiceLauncher({ serviceName: 'lifecycle-test', port: 0, ...options });
  active.add(service);
  return service;
}
afterEach(async () => { await Promise.all([...active].map(s => s.shutdown())); active.clear(); });
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('initialized health and business routes precede fallbacks; their errors reach error handling', async () => {
  const checker = new HealthChecker();
  checker.register('database', async () => { throw new Error('database unavailable'); }, { critical: true });
  const service = launcher({ onInitialize: async app => {
    app.use(createHealthRoutes({ serviceName: 'initialized-health', healthChecker: checker }));
    app.get('/gdpr/status', (req, res) => res.json({ initialized: true }));
    app.get('/initialized-error', (req, res, next) => next(new Error('private failure')));
  } });
  await service.start();
  expect(service.server.address().port).toBeGreaterThan(0);
  expect((await request(service.server).get('/health')).status).toBe(503);
  expect((await request(service.server).get('/health/ready')).status).toBe(503);
  expect((await request(service.server).get('/health/live')).status).toBe(200);
  expect((await request(service.server).get('/gdpr/status')).body.initialized).toBe(true);
  const failure = await request(service.server).get('/initialized-error');
  expect(failure.status).toBe(500);
  expect(JSON.stringify(failure.body)).not.toContain('private failure');
  expect((await request(service.server).get('/missing')).status).toBe(404);
});

test('pending initialization has no listener and concurrent starts initialize once', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const service = launcher({ onInitialize: async app => {
    calls++; entered.resolve(); await release.promise;
    app.get('/initialized', (req, res) => res.json({ ready: true }));
  } });
  const first = service.start(); await entered.promise;
  expect(service.server).toBeNull();
  expect(service.start()).toBe(first);
  release.resolve(); await first;
  expect(calls).toBe(1);
  expect((await request(service.server).get('/initialized')).status).toBe(200);
});

test('failed initialization cleans resources without opening a port or adding signals', async () => {
  const before = process.listenerCount('SIGTERM'), stop = jest.fn();
  const service = launcher({ onInitialize: async () => { throw new Error('cannot initialize'); }, onShutdown: stop });
  await expect(service.start()).rejects.toThrow('cannot initialize');
  expect(service.server).toBeNull();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGTERM')).toBe(before);
  await service.shutdown(); expect(stop).toHaveBeenCalledTimes(1);
});

test('post-listen failure closes its listener and preserves the original startup error', async () => {
  let server;
  const stop = jest.fn(async () => { throw new Error('cleanup failure'); });
  const service = launcher({ onReady: async () => { server = service.server; throw new Error('ready failure'); }, onShutdown: stop });
  await expect(service.start()).rejects.toThrow('ready failure');
  expect(server.listening).toBe(false);
  expect(service.server).toBeNull(); expect(stop).toHaveBeenCalledTimes(1);
});

test('a bind collision cleans up without closing the existing owner', async () => {
  const owner = launcher(); await owner.start();
  const stop = jest.fn(), blocked = launcher({ port: owner.server.address().port, onShutdown: stop });
  await expect(blocked.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(stop).toHaveBeenCalledTimes(1);
  expect((await request(owner.server).get('/health')).status).toBe(200);
});

test('shutdown drains requests, cleans up once, and removes signal handlers', async () => {
  const before = process.listenerCount('SIGTERM'), entered = deferred(), release = deferred(), stop = jest.fn();
  const service = launcher({ onInitialize: app => {
    app.get('/slow', async (req, res) => { entered.resolve(); await release.promise; res.json({ finished: true }); });
  }, onShutdown: stop });
  await service.start(); const server = service.server;
  expect(process.listenerCount('SIGTERM')).toBe(before + 1);
  const response = request(server).get('/slow').then(r => r); await entered.promise;
  const closing = service.shutdown(); expect(service.shutdown()).toBe(closing);
  expect(stop).not.toHaveBeenCalled(); release.resolve();
  expect((await response).body.finished).toBe(true); await closing;
  expect(server.listening).toBe(false); expect(stop).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGTERM')).toBe(before);
  await service.shutdown(); expect(stop).toHaveBeenCalledTimes(1);
});

test('shutdown bounds stalled HTTP connections without exiting the process', async () => {
  const entered = deferred(), stop = jest.fn();
  const service = launcher({ shutdownTimeout: 30, onInitialize: app => { app.get('/stalled', () => entered.resolve()); }, onShutdown: stop });
  await service.start(); const server = service.server;
  const failure = new Promise(resolve => { http.get({ host: '127.0.0.1', port: server.address().port, path: '/stalled' }).on('error', resolve); });
  await entered.promise; await service.shutdown();
  expect((await failure).code).toBe('ECONNRESET'); expect(server.listening).toBe(false); expect(stop).toHaveBeenCalledTimes(1);
});

test('shutdown during initialization closes the eventual listener and rejects a new start', async () => {
  const entered = deferred(), release = deferred(), stop = jest.fn();
  const service = launcher({ onInitialize: async () => { entered.resolve(); await release.promise; }, onShutdown: stop });
  const starting = service.start(); await entered.promise; const stopping = service.shutdown();
  await expect(service.start()).rejects.toThrow('shutting down'); release.resolve();
  await starting; await stopping;
  expect(service.server).toBeNull(); expect(stop).toHaveBeenCalledTimes(1);
});

test('restart initializes fresh resources and adds exactly one pair of signals', async () => {
  const before = process.listenerCount('SIGINT'), init = jest.fn(), stop = jest.fn();
  const service = launcher({ onInitialize: init, onShutdown: stop });
  await service.start(); await service.shutdown(); await service.start();
  expect(init).toHaveBeenCalledTimes(2); expect(process.listenerCount('SIGINT')).toBe(before + 1);
  expect((await request(service.server).get('/health')).status).toBe(200);
  await service.shutdown(); expect(stop).toHaveBeenCalledTimes(2); expect(process.listenerCount('SIGINT')).toBe(before);
});


test('successful health checks cancel their deadline and a custom critical check blocks readiness', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const checker = new HealthChecker({ criticalChecks: [] });
    checker.register('custom-dependency', async () => ({ status: 'unhealthy' }), { critical: true });
    expect((await checker.runAllChecks()).status).toBe('unhealthy');
    expect((await checker.readinessCheck()).status).toBe('not_ready');
    expect(jest.getTimerCount()).toBe(0);
    checker.register('custom-dependency', async () => ({ status: 'healthy' }), { critical: true });
    expect((await checker.runAllChecks()).status).toBe('healthy');
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('a stalled critical health check times out and leaves no live deadline', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const checker = new HealthChecker({ timeout: 50 });
    checker.register('custom-dependency', () => new Promise(() => {}), { critical: true });
    const result = checker.runAllChecks();
    await jest.advanceTimersByTimeAsync(50);
    expect((await result).status).toBe('unhealthy');
    expect((await result).checks['custom-dependency'].error).toContain('timeout');
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});


test('owned upgraded resources close before listener drain', async()=>{
  const order=[];let service;
  service=launcher({onBeforeShutdown:()=>{order.push('upgrade');expect(service.server.listening).toBe(true);},onShutdown:()=>order.push('resources')});
  await service.start();await service.shutdown();expect(order).toEqual(['upgrade','resources']);
});
test('pre-shutdown hook failures still close the listener and owned resources', async()=>{
  const stopped=jest.fn();const service=launcher({onBeforeShutdown:()=>{throw new Error('upgrade cleanup failed');},onShutdown:stopped});
  await service.start();const server=service.server;await expect(service.shutdown()).rejects.toThrow('upgrade cleanup failed');expect(server.listening).toBe(false);expect(stopped).toHaveBeenCalledTimes(1);
});
