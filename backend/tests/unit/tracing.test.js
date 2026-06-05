// tests/unit/tracing.test.js - 分布式追踪单元测试
'use strict';

const { initTracing, getTracer, shutdownTracing, isTracingInitialized } = require('../../backend/shared/tracing');
const { tracingMiddleware, injectTraceContext, startChildSpan, traceAsync } = require('../../backend/shared/tracingMiddleware');

// Mock OpenTelemetry
jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: jest.fn(() => ({
      startSpan: jest.fn(() => ({
        setAttributes: jest.fn(),
        setStatus: jest.fn(),
        end: jest.fn(),
        spanContext: jest.fn(() => ({
          traceId: 'test-trace-id',
          spanId: 'test-span-id',
        })),
        addEvent: jest.fn(),
        recordException: jest.fn(),
      })),
    })),
    getSpan: jest.fn(() => null),
    setSpan: jest.fn(),
  },
  context: {
    active: jest.fn(() => ({})),
    with: jest.fn((ctx, fn) => fn()),
  },
  propagation: {
    extract: jest.fn(() => ({})),
    inject: jest.fn(),
  },
}));

jest.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: jest.fn(() => ({
    addSpanProcessor: jest.fn(),
    register: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

jest.mock('@opentelemetry/exporter-jaeger', () => ({
  JaegerExporter: jest.fn(),
}));

jest.mock('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: jest.fn(),
}));

jest.mock('@opentelemetry/resources', () => ({
  Resource: jest.fn(),
}));

jest.mock('@opentelemetry/semantic-conventions', () => ({
  SemanticResourceAttributes: {
    SERVICE_NAME: 'service.name',
    SERVICE_VERSION: 'service.version',
    DEPLOYMENT_ENVIRONMENT: 'deployment.environment',
  },
}));

describe('Tracing Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (isTracingInitialized()) {
      await shutdownTracing();
    }
  });

  describe('initTracing', () => {
    it('should initialize tracing with default options', () => {
      const provider = initTracing('test-service');
      expect(provider).toBeDefined();
      expect(isTracingInitialized()).toBe(true);
    });

    it('should not initialize twice', () => {
      initTracing('test-service');
      const provider2 = initTracing('test-service');
      expect(provider2).toBeDefined();
    });

    it('should use custom Jaeger endpoint from environment', () => {
      process.env.JAEGER_ENDPOINT = 'http://custom-jaeger:14268/api/traces';
      const provider = initTracing('test-service');
      expect(provider).toBeDefined();
      delete process.env.JAEGER_ENDPOINT;
    });
  });

  describe('getTracer', () => {
    it('should return a tracer instance', () => {
      const tracer = getTracer('test-tracer');
      expect(tracer).toBeDefined();
    });
  });

  describe('shutdownTracing', () => {
    it('should shutdown tracing gracefully', async () => {
      initTracing('test-service');
      await shutdownTracing();
      expect(isTracingInitialized()).toBe(false);
    });

    it('should handle shutdown when not initialized', async () => {
      await shutdownTracing();
      expect(isTracingInitialized()).toBe(false);
    });
  });
});

describe('Tracing Middleware', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockReq = {
      method: 'GET',
      path: '/api/test',
      originalUrl: '/api/test?query=value',
      route: { path: '/api/test' },
      headers: {},
      get: jest.fn((key) => mockReq.headers[key.toLowerCase()]),
    };

    mockRes = {
      on: jest.fn((event, callback) => {
        if (event === 'finish') {
          // Simulate response finish
          setTimeout(() => callback(), 0);
        }
      }),
      statusCode: 200,
      get: jest.fn((key) => '100'),
    };

    mockNext = jest.fn();
  });

  describe('tracingMiddleware', () => {
    it('should create middleware function', () => {
      const middleware = tracingMiddleware('test-service');
      expect(typeof middleware).toBe('function');
    });

    it('should call next() after creating span', (done) => {
      const middleware = tracingMiddleware('test-service');
      middleware(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      done();
    });

    it('should handle error status codes', (done) => {
      mockRes.statusCode = 500;
      const middleware = tracingMiddleware('test-service');
      middleware(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      done();
    });
  });

  describe('injectTraceContext', () => {
    it('should inject trace context into headers', () => {
      const headers = { 'content-type': 'application/json' };
      const result = injectTraceContext(headers);
      expect(result).toBeDefined();
    });

    it('should handle empty headers', () => {
      const result = injectTraceContext();
      expect(result).toBeDefined();
    });
  });

  describe('startChildSpan', () => {
    it('should return null when no active span', () => {
      const span = startChildSpan('test-operation');
      expect(span).toBeNull();
    });
  });

  describe('traceAsync', () => {
    it('should trace async operation', async () => {
      const result = await traceAsync('test-operation', async () => {
        return 'success';
      });
      expect(result).toBe('success');
    });

    it('should trace async operation with attributes', async () => {
      const result = await traceAsync('test-operation', async () => {
        return 'success';
      }, { key: 'value' });
      expect(result).toBe('success');
    });

    it('should handle errors in async operation', async () => {
      await expect(traceAsync('test-operation', async () => {
        throw new Error('Test error');
      })).rejects.toThrow('Test error');
    });
  });
});
