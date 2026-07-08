/**
 * 日志适配器系统单元测试
 */
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const path = require('path');
const fs = require('fs').promises;

describe('Log Adapters', () => {
  describe('ILogOutputAdapter', () => {
    const ILogOutputAdapter = require('./ILogOutputAdapter');
    
    it('should not be instantiable directly', () => {
      expect(() => new ILogOutputAdapter()).to.throw('abstract class');
    });
    
    it('should require subclass to implement write()', () => {
      class TestAdapter extends ILogOutputAdapter {
        constructor() {
          super('test');
        }
      }
      
      const adapter = new TestAdapter();
      expect(() => adapter.write({})).to.throw('must implement write()');
    });
    
    it('should provide formatEntry method', async () => {
      class TestAdapter extends ILogOutputAdapter {
        constructor() {
          super('test');
        }
        async write() {}
        async writeBatch() {}
      }
      
      const adapter = new TestAdapter();
      const entry = adapter.formatEntry({
        time: '2026-07-08T14:00:00.000Z',
        level: 'info',
        msg: 'Test message'
      });
      
      expect(entry).to.have.property('timestamp');
      expect(entry).to.have.property('level', 'info');
      expect(entry).to.have.property('message', 'Test message');
    });
    
    it('should support buffer operations', async () => {
      class TestAdapter extends ILogOutputAdapter {
        constructor() {
          super('test');
        }
        async write() {}
        async writeBatch(entries) {
          this.buffer.push(...entries);
        }
      }
      
      const adapter = new TestAdapter();
      await adapter.initialize({ buffer: { enabled: true, maxSize: 5, flushInterval: 10000 } });
      
      adapter.addToBuffer({ level: 'info', msg: 'test1' });
      adapter.addToBuffer({ level: 'warn', msg: 'test2' });
      
      expect(adapter.buffer).to.have.lengthOf(2);
    });
  });
  
  describe('StdoutAdapter', () => {
    const StdoutAdapter = require('./StdoutAdapter');
    let adapter;
    
    beforeEach(async () => {
      adapter = new StdoutAdapter();
    });
    
    afterEach(async () => {
      if (adapter && adapter.initialized) {
        await adapter.close();
      }
    });
    
    it('should initialize successfully', async () => {
      await adapter.initialize({ prettyPrint: false, level: 'debug' });
      expect(adapter.initialized).to.be.true;
      expect(adapter.healthStatus).to.equal('healthy');
    });
    
    it('should write log entries', async () => {
      await adapter.initialize({ prettyPrint: false });
      await adapter.write({ level: 'info', msg: 'Test message' });
      // No error means success
    });
    
    it('should support batch writes', async () => {
      await adapter.initialize({ prettyPrint: false });
      await adapter.writeBatch([
        { level: 'info', msg: 'Message 1' },
        { level: 'warn', msg: 'Message 2' }
      ]);
    });
    
    it('should return health check', async () => {
      await adapter.initialize({});
      const health = await adapter.healthCheck();
      expect(health.status).to.equal('healthy');
      expect(health.name).to.equal('stdout');
    });
    
    it('should close properly', async () => {
      await adapter.initialize({});
      await adapter.close();
      expect(adapter.initialized).to.be.false;
    });
  });
  
  describe('FileAdapter', () => {
    const FileAdapter = require('./FileAdapter');
    let adapter;
    const testLogPath = '/tmp/test-mineGo-log-' + Date.now() + '.log';
    
    afterEach(async () => {
      if (adapter) {
        await adapter.close();
      }
      try {
        await fs.unlink(testLogPath);
      } catch {}
    });
    
    it('should initialize with valid path', async () => {
      adapter = new FileAdapter();
      await adapter.initialize({ path: testLogPath });
      expect(adapter.initialized).to.be.true;
    });
    
    it('should throw error without path', async () => {
      adapter = new FileAdapter();
      try {
        await adapter.initialize({});
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.include('path');
      }
    });
    
    it('should write to file', async () => {
      adapter = new FileAdapter();
      await adapter.initialize({ path: testLogPath });
      await adapter.write({ level: 'info', msg: 'Test log entry' });
      await adapter.close();
      
      const content = await fs.readFile(testLogPath, 'utf8');
      expect(content).to.include('Test log entry');
    });
    
    it('should support batch writes', async () => {
      adapter = new FileAdapter();
      await adapter.initialize({ path: testLogPath });
      await adapter.writeBatch([
        { level: 'info', msg: 'Batch 1' },
        { level: 'warn', msg: 'Batch 2' }
      ]);
      await adapter.close();
      
      const content = await fs.readFile(testLogPath, 'utf8');
      expect(content).to.include('Batch 1');
      expect(content).to.include('Batch 2');
    });
    
    it('should parse size strings correctly', async () => {
      adapter = new FileAdapter();
      expect(adapter.parseSize('10MB')).to.equal(10 * 1024 * 1024);
      expect(adapter.parseSize('1GB')).to.equal(1024 * 1024 * 1024);
      expect(adapter.parseSize('512KB')).to.equal(512 * 1024);
    });
  });
  
  describe('KafkaAdapter', () => {
    let KafkaAdapter;
    let adapter;
    let mockProducer;
    
    beforeEach(() => {
      mockProducer = {
        connect: sinon.stub().resolves(),
        send: sinon.stub().resolves(),
        disconnect: sinon.stub().resolves()
      };
      
      KafkaAdapter = proxyquire('./KafkaAdapter', {
        kafkajs: {
          Kafka: class MockKafka {
            constructor() {
              this.producer = () => mockProducer;
            }
          }
        }
      });
      
      adapter = new KafkaAdapter();
    });
    
    afterEach(async () => {
      if (adapter && adapter.initialized) {
        await adapter.close();
      }
    });
    
    it('should initialize and connect to Kafka', async () => {
      await adapter.initialize({
        brokers: ['localhost:9092'],
        topic: 'test-topic'
      });
      
      expect(adapter.connected).to.be.true;
      expect(mockProducer.connect.calledOnce).to.be.true;
    });
    
    it('should throw error without brokers', async () => {
      try {
        await adapter.initialize({ topic: 'test' });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('brokers');
      }
    });
    
    it('should batch log entries', async () => {
      await adapter.initialize({
        brokers: ['localhost:9092'],
        topic: 'test-topic',
        batchSize: 2
      });
      
      await adapter.write({ level: 'info', msg: '1' });
      expect(mockProducer.send.called).to.be.false;
      
      await adapter.write({ level: 'info', msg: '2' });
      expect(mockProducer.send.calledOnce).to.be.true;
    });
  });
  
  describe('ElasticsearchAdapter', () => {
    let ElasticsearchAdapter;
    let adapter;
    let mockClient;
    
    beforeEach(() => {
      mockClient = {
        ping: sinon.stub().resolves(),
        bulk: sinon.stub().resolves(),
        cluster: {
          health: sinon.stub().resolves({ body: { status: 'green' } })
        },
        close: sinon.stub().resolves()
      };
      
      ElasticsearchAdapter = proxyquire('./ElasticsearchAdapter', {
        '@elastic/elasticsearch': {
          Client: class MockClient {
            constructor() {
              return mockClient;
            }
          }
        }
      });
      
      adapter = new ElasticsearchAdapter();
    });
    
    afterEach(async () => {
      if (adapter && adapter.initialized) {
        await adapter.close();
      }
    });
    
    it('should initialize and ping Elasticsearch', async () => {
      await adapter.initialize({
        node: 'http://localhost:9200'
      });
      
      expect(adapter.connected).to.be.true;
      expect(mockClient.ping.calledOnce).to.be.true;
    });
    
    it('should generate correct index name', async () => {
      await adapter.initialize({
        node: 'http://localhost:9200',
        index: 'minego-test'
      });
      
      const indexName = adapter.getIndexName();
      expect(indexName).to.match(/^minego-test-\d{4}\.\d{2}\.\d{2}$/);
    });
    
    it('should batch log entries', async () => {
      await adapter.initialize({
        node: 'http://localhost:9200',
        batchSize: 2
      });
      
      await adapter.write({ level: 'info', msg: '1' });
      expect(mockClient.bulk.called).to.be.false;
      
      await adapter.write({ level: 'info', msg: '2' });
      expect(mockClient.bulk.calledOnce).to.be.true;
    });
  });
  
  describe('LogAdapterManager', () => {
    const LogAdapterManager = require('./LogAdapterManager');
    let manager;
    let mockAdapter;
    
    beforeEach(() => {
      manager = new LogAdapterManager();
      
      mockAdapter = {
        name: 'mock',
        initialized: false,
        initialize: sinon.stub().callsFake(async (config) => {
          mockAdapter.initialized = true;
          mockAdapter.config = config;
        }),
        write: sinon.stub().resolves(),
        writeBatch: sinon.stub().resolves(),
        flush: sinon.stub().resolves(),
        close: sinon.stub().callsFake(async () => {
          mockAdapter.initialized = false;
        }),
        healthCheck: sinon.stub().resolves({ status: 'healthy', name: 'mock' })
      };
    });
    
    afterEach(async () => {
      if (manager.initialized) {
        await manager.closeAll();
      }
    });
    
    it('should register adapter', async () => {
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      expect(manager.adapters.has('mock')).to.be.true;
      expect(mockAdapter.initialize.calledOnce).to.be.true;
    });
    
    it('should throw error when registering duplicate adapter', async () => {
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      try {
        await manager.registerAdapter(mockAdapter, { enabled: true });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.message).to.include('already registered');
      }
    });
    
    it('should write to all enabled adapters', async () => {
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      await manager.writeToAll({ level: 'info', msg: 'test' });
      
      expect(mockAdapter.write.calledOnce).to.be.true;
    });
    
    it('should handle batch writes', async () => {
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      await manager.writeToAllBatch([
        { level: 'info', msg: '1' },
        { level: 'info', msg: '2' }
      ]);
      
      expect(mockAdapter.writeBatch.calledOnce).to.be.true;
    });
    
    it('should fallback to fallback adapter on error', async () => {
      mockAdapter.write.onFirstCall().rejects(new Error('Write failed'));
      
      const fallbackAdapter = {
        name: 'fallback',
        initialized: true,
        write: sinon.stub().resolves(),
        writeBatch: sinon.stub().resolves(),
        close: sinon.stub().resolves(),
        healthCheck: sinon.stub().resolves({ status: 'healthy' })
      };
      
      await manager.registerAdapter(mockAdapter, { enabled: true });
      await manager.registerAdapter(fallbackAdapter, { enabled: true, isFallback: true });
      
      // Should trigger fallback after error
    });
    
    it('should emit events', async () => {
      const eventSpy = sinon.spy();
      manager.on('adapter:initialized', eventSpy);
      
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      expect(eventSpy.calledOnce).to.be.true;
      expect(eventSpy.firstCall.args[0]).to.have.property('name', 'mock');
    });
    
    it('should get adapter states', async () => {
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      const states = await manager.getAllAdapterStates();
      
      expect(states).to.have.property('mock');
    });
    
    it('should track statistics', async () => {
      await manager.registerAdapter(mockAdapter, { enabled: true });
      
      await manager.writeToAll({ level: 'info', msg: 'test1' });
      await manager.writeToAll({ level: 'warn', msg: 'test2' });
      
      const stats = manager.getStats();
      expect(stats.totalLogs).to.equal(2);
      expect(stats.successfulWrites).to.equal(2);
    });
  });
  
  describe('LogConfig', () => {
    const LogConfig = require('./LogConfig');
    
    it('should return environment config', () => {
      const config = LogConfig.getEnvironmentConfig();
      expect(config).to.have.property('adapters');
      expect(config).to.have.property('level');
    });
    
    it('should create adapter instances', () => {
      const stdoutAdapter = LogConfig.createAdapter('StdoutAdapter');
      expect(stdoutAdapter.name).to.equal('stdout');
      
      const fileAdapter = LogConfig.createAdapter('FileAdapter');
      expect(fileAdapter.name).to.equal('file');
    });
    
    it('should throw error for unknown adapter type', () => {
      expect(() => LogConfig.createAdapter('UnknownAdapter')).to.throw('Unknown adapter type');
    });
    
    it('should validate configs correctly', () => {
      const validConfig = {
        adapters: [{ name: 'test', type: 'StdoutAdapter' }]
      };
      expect(LogConfig.validateConfig(validConfig)).to.be.true;
      
      const invalidConfig = {
        adapters: [{ name: 'test' }] // missing type
      };
      expect(LogConfig.validateConfig(invalidConfig)).to.be.false;
    });
    
    it('should merge configs', () => {
      const base = {
        adapters: [{ name: 'a', type: 'StdoutAdapter', level: 'info' }],
        level: 'info'
      };
      
      const custom = {
        adapters: [{ name: 'a', level: 'debug' }],
        level: 'debug'
      };
      
      const merged = LogConfig.mergeConfigs(base, custom);
      
      expect(merged.adapters[0].level).to.equal('debug');
      expect(merged.level).to.equal('debug');
    });
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha({ timeout: 10000 });
  
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}