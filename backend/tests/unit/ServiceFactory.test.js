'use strict';
/**
 * ServiceFactory 单元测试
 * REQ-00211: 微服务样板代码统一初始化器
 */

const request = require('supertest');
const { ServiceFactory, DEFAULT_OPTIONS, createSimpleService } = require('../../shared/ServiceFactory');

// Mock dependencies
jest.mock('../../shared/db', () => ({
  getPool: jest.fn(() => ({
    query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0
  }))
}));

jest.mock('../../shared/redis', () => ({
  getRedis: jest.fn(() => ({
    ping: jest.fn().mockResolvedValue('PONG')
  }))
}));

describe('ServiceFactory', () => {
  let servers = [];

  afterAll(async () => {
    // Clean up all servers
    for (const server of servers) {
      if (server && server.close) {
        await new Promise(resolve => server.close(resolve));
      }
    }
  });

  describe('createService', () => {
    test('should create service with minimal config', async () => {
      const { app, server, logger } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0 // random port
      });

      servers.push(server);

      expect(app).toBeDefined();
      expect(logger).toBeDefined();
      expect(typeof app).toBe('function');
    });

    test('should create service with default options', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0
      });

      servers.push(server);

      // Test default middleware is applied
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.service).toBe('test-service');
      expect(res.body.status).toBe('ok');
    });

    test('should apply custom middleware via preInit', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        preInit: async (app) => {
          app.use((req, res, next) => {
            req.customHeader = 'test-value';
            next();
          });
        },
        postInit: async (app) => {
          app.get('/test', (req, res) => {
            res.json({ header: req.customHeader });
          });
        }
      });

      servers.push(server);

      const res = await request(app).get('/test');
      expect(res.body.header).toBe('test-value');
    });

    test('should register routes via postInit', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        postInit: async (app) => {
          app.get('/api/test', (req, res) => {
            res.json({ message: 'Hello World' });
          });
        }
      });

      servers.push(server);

      const res = await request(app).get('/api/test');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Hello World');
    });

    test('should return 404 for unknown routes', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0
      });

      servers.push(server);

      const res = await request(app).get('/unknown-route');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(1001);
    });

    test('should handle health check with database', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          checkDb: true
        }
      });

      servers.push(server);

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.database).toBe('connected');
    });

    test('should handle health check with redis', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          checkRedis: true
        }
      });

      servers.push(server);

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.redis).toBe('connected');
      expect(res.body.redisLatency).toBeDefined();
    });

    test('should include memory usage in health check', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0
      });

      servers.push(server);

      const res = await request(app).get('/health');
      expect(res.body.memory).toBeDefined();
      expect(res.body.memory.heapUsed).toBeDefined();
      expect(res.body.memory.heapTotal).toBeDefined();
      expect(res.body.memory.rss).toBeDefined();
    });

    test('should expose /metrics endpoint', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          metricsEnabled: true
        }
      });

      servers.push(server);

      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
    });

    test('should expose /ready endpoint with checks', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          checkDb: true,
          checkRedis: true
        }
      });

      servers.push(server);

      const res = await request(app).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.checks).toBeInstanceOf(Array);
      expect(res.body.checks.length).toBe(2);
    });

    test('should throw error when name is missing', async () => {
      await expect(ServiceFactory.createService({
        port: 8080
      })).rejects.toThrow('Service name is required');
    });

    test('should throw error when port is missing', async () => {
      await expect(ServiceFactory.createService({
        name: 'test-service'
      })).rejects.toThrow('Service port is required');
    });

    test('should create server with createServer option', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          createServer: true
        }
      });

      // Server should not be listening yet
      expect(server.listening).toBe(false);

      // Start server manually
      await new Promise((resolve, reject) => {
        server.listen(0, () => resolve());
        server.on('error', reject);
      });

      servers.push(server);
      expect(server.listening).toBe(true);
    });

    test('should apply custom CORS config', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          cors: {
            origin: 'https://example.com',
            methods: ['GET', 'POST']
          }
        }
      });

      servers.push(server);

      const res = await request(app)
        .options('/health')
        .set('Origin', 'https://example.com');
      
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    });

    test('should set trust proxy when enabled', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        options: {
          trustProxy: true
        }
      });

      servers.push(server);

      expect(app.get('trust proxy')).toBe(1);
    });

    test('should include request ID in responses', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0
      });

      servers.push(server);

      const res = await request(app).get('/health');
      expect(res.headers['x-request-id']).toBeDefined();
    });

    test('should use custom request ID from header', async () => {
      const { app, server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0
      });

      servers.push(server);

      const customId = 'my-custom-request-id';
      const res = await request(app)
        .get('/health')
        .set('X-Request-Id', customId);
      
      expect(res.headers['x-request-id']).toBe(customId);
    });
  });

  describe('createSimpleService', () => {
    test('should create simple service with route setup', async () => {
      const { app, server } = await createSimpleService(
        'simple-service',
        0,
        async (app) => {
          app.get('/hello', (req, res) => {
            res.json({ message: 'Hello!' });
          });
        }
      );

      servers.push(server);

      const res = await request(app).get('/hello');
      expect(res.body.message).toBe('Hello!');
    });
  });

  describe('DEFAULT_OPTIONS', () => {
    test('should have expected default values', () => {
      expect(DEFAULT_OPTIONS.jsonLimit).toBe('10mb');
      expect(DEFAULT_OPTIONS.metricsEnabled).toBe(true);
      expect(DEFAULT_OPTIONS.healthCheck).toBe(true);
      expect(DEFAULT_OPTIONS.gracefulShutdown).toBe(true);
      expect(DEFAULT_OPTIONS.shutdownTimeoutMs).toBe(10000);
    });
  });

  describe('Graceful Shutdown', () => {
    test('should handle SIGTERM signal', async () => {
      const shutdownMock = jest.fn();
      
      const { server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0,
        onShutdown: shutdownMock
      });

      servers.push(server);

      // Verify shutdown handler is registered
      const listeners = process.listeners('SIGTERM');
      expect(listeners.length).toBeGreaterThan(0);
    });

    test('should handle SIGINT signal', async () => {
      const { server } = await ServiceFactory.createService({
        name: 'test-service',
        port: 0
      });

      servers.push(server);

      const listeners = process.listeners('SIGINT');
      expect(listeners.length).toBeGreaterThan(0);
    });
  });
});
