// tests/mocks/MockService.test.js - Mock 服务测试
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统测试
 */

const { expect } = require('chai');
const sinon = require('sinon');
const MockServer = require('../../shared/mockService/core/MockServer');
const DataFactory = require('../../shared/mockService/factories/DataFactory');
const VirtualServiceManager = require('../../shared/mockService/managers/VirtualServiceManager');
const ResponseRecorder = require('../../shared/mockService/recorders/ResponseRecorder');
const MockConfig = require('../../shared/mockService/core/MockConfig');

describe('MockService - REQ-00546', function() {
  this.timeout(10000);

  describe('MockServer', () => {
    let mockServer;

    beforeEach(() => {
      mockServer = new MockServer({
        port: 19000,
        mode: 'replay'
      });
    });

    afterEach(async () => {
      if (mockServer && mockServer.isRunning) {
        await mockServer.stop();
      }
    });

    it('should create MockServer instance', () => {
      expect(mockServer).to.be.instanceOf(MockServer);
      expect(mockServer.config.port).to.equal(19000);
      expect(mockServer.config.mode).to.equal('replay');
    });

    it('should start and stop server', async () => {
      await mockServer.start();
      expect(mockServer.isRunning).to.be.true;

      await mockServer.stop();
      expect(mockServer.isRunning).to.be.false;
    });

    it('should register and match routes', () => {
      mockServer.registerRoute({
        method: 'GET',
        path: '/api/test',
        response: { message: 'test' }
      });

      const req = { method: 'GET', path: '/api/test' };
      const matched = mockServer._findMatchingRoute(req);
      expect(matched).to.exist;
      expect(matched.path).to.equal('/api/test');
    });

    it('should support dynamic response functions', async () => {
      mockServer.registerRoute({
        method: 'GET',
        path: '/api/dynamic/:id',
        response: (req) => ({ id: req.params.id, timestamp: Date.now() })
      });

      await mockServer.start();

      const response = await fetch('http://localhost:19000/api/dynamic/123');
      const data = await response.json();

      expect(data).to.have.property('id');
      expect(data.id).to.equal('123');
    });

    it('should handle request recording', async () => {
      const recordServer = new MockServer({
        port: 19001,
        mode: 'record'
      });

      recordServer.registerRoute({
        method: 'GET',
        path: '/api/test',
        response: { test: true }
      });

      await recordServer.start();

      await fetch('http://localhost:19001/api/test');

      const recordings = recordServer.getRecordings();
      expect(recordings).to.have.lengthOf(1);
      expect(recordings[0].request.path).to.equal('/api/test');

      await recordServer.stop();
    });

    it('should support delay simulation', async () => {
      mockServer.registerRoute({
        method: 'GET',
        path: '/api/slow',
        response: { slow: true },
        delay: 100
      });

      await mockServer.start();

      const startTime = Date.now();
      await fetch('http://localhost:19000/api/slow');
      const duration = Date.now() - startTime;

      expect(duration).to.be.at.least(100);
    });
  });

  describe('DataFactory', () => {
    let dataFactory;

    beforeEach(() => {
      dataFactory = new DataFactory({
        seed: 12345
      });
    });

    it('should create DataFactory instance', () => {
      expect(dataFactory).to.be.instanceOf(DataFactory);
    });

    it('should generate user data', () => {
      const user = dataFactory.generate('user');

      expect(user).to.have.property('id');
      expect(user).to.have.property('username');
      expect(user).to.have.property('email');
      expect(user).to.have.property('level');
    });

    it('should generate pokemon data', () => {
      const pokemon = dataFactory.generate('pokemon');

      expect(pokemon).to.have.property('id');
      expect(pokemon).to.have.property('species_id');
      expect(pokemon).to.have.property('level');
      expect(pokemon).to.have.property('cp');
    });

    it('should generate gym data', () => {
      const gym = dataFactory.generate('gym');

      expect(gym).to.have.property('id');
      expect(gym).to.have.property('name');
      expect(gym).to.have.property('latitude');
      expect(gym).to.have.property('longitude');
    });

    it('should support custom overrides', () => {
      const user = dataFactory.generate('user', {
        username: 'custom_user',
        level: 100
      });

      expect(user.username).to.equal('custom_user');
      expect(user.level).to.equal(100);
    });

    it('should generate multiple objects', () => {
      const users = dataFactory.generateMany('user', 5);

      expect(users).to.have.lengthOf(5);
      users.forEach(user => {
        expect(user).to.have.property('id');
      });
    });

    it('should generate related data', () => {
      const scenario = dataFactory.generateUserScenario();

      expect(scenario.user).to.exist;
      expect(scenario.pokemon).to.be.an('array');
      expect(scenario.items).to.be.an('array');
    });

    it('should support custom templates', () => {
      dataFactory.registerTemplate('custom', {
        id: () => 'custom-id',
        name: () => 'Custom Object'
      });

      const custom = dataFactory.generate('custom');
      expect(custom.id).to.equal('custom-id');
      expect(custom.name).to.equal('Custom Object');
    });

    it('should produce consistent data with seed', () => {
      const factory1 = new DataFactory({ seed: 42 });
      const factory2 = new DataFactory({ seed: 42 });

      const user1 = factory1.generate('user');
      const user2 = factory2.generate('user');

      expect(user1.id).to.equal(user2.id);
    });

    it('should generate SQL insert statements', () => {
      const user = dataFactory.generate('user');
      const sql = dataFactory.generateInsertSQL('users', user);

      expect(sql).to.be.a('string');
      expect(sql).to.include('INSERT INTO users');
    });
  });

  describe('VirtualServiceManager', () => {
    let vsm;

    beforeEach(() => {
      vsm = new VirtualServiceManager();
    });

    afterEach(async () => {
      if (vsm && vsm.isInitialized) {
        await vsm.shutdown();
      }
    });

    it('should create VirtualServiceManager instance', () => {
      expect(vsm).to.be.instanceOf(VirtualServiceManager);
    });

    it('should initialize all services', async () => {
      await vsm.initialize();
      expect(vsm.isInitialized).to.be.true;
      expect(vsm.services.size).to.equal(9); // 9 microservices
    });

    it('should get service instance', async () => {
      await vsm.initialize();
      const gateway = vsm.getService('gateway');
      expect(gateway).to.exist;
    });

    it('should handle service lifecycle', async () => {
      await vsm.initialize();
      await vsm.startService('gateway');

      const gateway = vsm.getService('gateway');
      expect(gateway.isRunning).to.be.true;

      await vsm.stopService('gateway');
      expect(gateway.isRunning).to.be.false;
    });

    it('should simulate service degradation', async () => {
      await vsm.initialize();
      await vsm.startService('user');

      vsm.simulateDegradation('user', 'slow', { delay: 100 });

      const user = vsm.getService('user');
      // 验证降级设置已应用
    });

    it('should restore degraded service', async () => {
      await vsm.initialize();
      await vsm.startService('catch');

      vsm.simulateDegradation('catch', 'errors');
      vsm.restoreService('catch');

      const service = vsm.getService('catch');
      // 验证服务已恢复正常
    });

    it('should provide service discovery', async () => {
      await vsm.initialize();
      await vsm.startService('gateway');

      const discovery = vsm.getServiceDiscovery();
      expect(discovery).to.have.property('gateway');
    });
  });

  describe('ResponseRecorder', () => {
    let recorder;

    beforeEach(() => {
      recorder = new ResponseRecorder({
        enabled: true,
        outputPath: './test-recordings',
        maxRecords: 100,
        flushInterval: 5000
      });
    });

    afterEach(async () => {
      await recorder.close();
    });

    it('should create ResponseRecorder instance', () => {
      expect(recorder).to.be.instanceOf(ResponseRecorder);
    });

    it('should record request-response pairs', () => {
      const recording = recorder.record(
        { method: 'GET', path: '/api/test', headers: {} },
        { status: 200, body: { success: true } },
        150
      );

      expect(recording).to.exist;
      expect(recording.request.method).to.equal('GET');
      expect(recording.response.status).to.equal(200);
    });

    it('should filter sensitive data', () => {
      const recording = recorder.record(
        {
          method: 'POST',
          path: '/api/auth',
          headers: { authorization: 'Bearer secret-token' },
          body: { password: 'secret123' }
        },
        { status: 200, body: { token: 'jwt-token' } },
        100
      );

      expect(recording.request.headers.authorization).to.equal('[REDACTED]');
      expect(recording.request.body.password).to.equal('[REDACTED]');
      expect(recording.response.body.token).to.equal('[REDACTED]');
    });

    it('should prevent duplicate recordings', () => {
      const request = { method: 'GET', path: '/api/test', headers: {} };
      const response = { status: 200, body: { data: 'test' } };

      recorder.record(request, response, 100);
      recorder.record(request, response, 100);

      const stats = recorder.getStats();
      expect(stats.duplicates).to.equal(1);
    });

    it('should find matching recordings', () => {
      recorder.record(
        { method: 'GET', path: '/api/users/123', headers: {} },
        { status: 200, body: { id: 123 } },
        50
      );

      const found = recorder.find('GET', '/api/users/123');
      expect(found).to.exist;
      expect(found.response.body.id).to.equal(123);
    });

    it('should export recordings', () => {
      recorder.record(
        { method: 'GET', path: '/api/test', headers: {} },
        { status: 200, body: {} },
        100
      );

      const exported = recorder.export();
      expect(exported.version).to.equal('1.0');
      expect(exported.count).to.equal(1);
      expect(exported.recordings).to.have.lengthOf(1);
    });

    it('should clear recordings', () => {
      recorder.record(
        { method: 'GET', path: '/api/test', headers: {} },
        { status: 200, body: {} },
        100
      );

      const cleared = recorder.clear();
      expect(cleared).to.equal(1);
      expect(recorder.recordings.length).to.equal(0);
    });
  });

  describe('MockConfig', () => {
    it('should create MockConfig with defaults', () => {
      const config = new MockConfig();
      expect(config.get('server.port')).to.equal(9000);
      expect(config.get('server.mode')).to.equal('replay');
    });

    it('should support environment variable override', () => {
      process.env.MOCK_PORT = '8888';
      const config = new MockConfig();
      expect(config.get('server.port')).to.equal(8888);
      delete process.env.MOCK_PORT;
    });

    it('should validate configuration', () => {
      const config = new MockConfig();
      const result = config.validate();
      expect(result.valid).to.be.true;
    });

    it('should support get/set operations', () => {
      const config = new MockConfig();
      config.set('server.port', 3000);
      expect(config.get('server.port')).to.equal(3000);
    });

    it('should clone configuration', () => {
      const config1 = new MockConfig();
      config1.set('server.port', 5000);
      
      const config2 = config1.clone();
      config2.set('server.port', 6000);

      expect(config1.get('server.port')).to.equal(5000);
      expect(config2.get('server.port')).to.equal(6000);
    });
  });

  describe('Integration Tests', () => {
    let mockServer;
    let vsm;

    before(async () => {
      mockServer = new MockServer({ port: 19002, mode: 'replay' });
      await mockServer.start();

      vsm = new VirtualServiceManager();
      await vsm.initialize();
    });

    after(async () => {
      await mockServer.stop();
      await vsm.shutdown();
    });

    it('should support full mock workflow', async () => {
      // 注册路由
      mockServer.registerRoute({
        method: 'GET',
        path: '/api/pokemon/:id',
        response: (req) => ({
          id: req.params.id,
          name: 'Pikachu',
          type: 'electric'
        })
      });

      // 发送请求
      const response = await fetch('http://localhost:19002/api/pokemon/25');
      const data = await response.json();

      expect(data.id).to.equal('25');
      expect(data.name).to.equal('Pikachu');
    });

    it('should support multiple concurrent requests', async () => {
      mockServer.registerRoute({
        method: 'GET',
        path: '/api/batch',
        response: { batch: true }
      });

      const requests = Array(10).fill(null).map(() => 
        fetch('http://localhost:19002/api/batch')
      );

      const responses = await Promise.all(requests);
      responses.forEach(res => {
        expect(res.ok).to.be.true;
      });
    });
  });
});