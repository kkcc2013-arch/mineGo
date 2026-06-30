/**
 * API 响应格式标准化测试
 */

'use strict';

const request = require('supertest');
const express = require('express');
const ApiResponse = require('../utils/ApiResponse');
const { errorHandler, notFoundHandler, asyncHandler, AppError } = require('../middleware/errorHandler');
const ErrorCodes = require('../errors/ErrorCodes');

// 创建测试应用
function createTestApp() {
  const app = express();
  app.use(express.json());

  // 添加 requestId
  app.use((req, res, next) => {
    res.locals.requestId = 'test-req-123';
    next();
  });

  // 成功响应路由
  app.get('/test/success', (req, res) => {
    ApiResponse.success(res, { id: '123', name: 'Test' });
  });

  // 创建响应路由
  app.post('/test/created', (req, res) => {
    ApiResponse.created(res, { id: '456', name: 'Created' });
  });

  // 分页响应路由
  app.get('/test/paginated', (req, res) => {
    const items = [{ id: '1', name: 'Item1' }, { id: '2', name: 'Item2' }];
    ApiResponse.paginated(res, items, { page: 1, limit: 20, total: 100 });
  });

  // 列表响应路由
  app.get('/test/list', (req, res) => {
    ApiResponse.list(res, [{ id: '1' }, { id: '2' }]);
  });

  // 无内容响应路由
  app.delete('/test/no-content', (req, res) => {
    ApiResponse.noContent(res);
  });

  // 删除成功响应路由
  app.delete('/test/deleted', (req, res) => {
    ApiResponse.deleted(res, 3);
  });

  // 错误路由
  app.get('/test/error/business', asyncHandler(async (req, res) => {
    throw new AppError('POKEMON_QUERY_NOT_FOUND', { pokemonId: 'pk-001' });
  }));

  app.get('/test/error/validation', asyncHandler(async (req, res) => {
    throw new AppError('VALIDATION_ERROR', [{ field: 'email', message: 'Invalid email' }]);
  }));

  app.get('/test/error/auth', asyncHandler(async (req, res) => {
    throw new AppError('USER_AUTH_TOKEN_EXPIRED');
  }));

  // 404 处理
  app.use(notFoundHandler);

  // 错误处理
  app.use(errorHandler);

  return app;
}

describe('ApiResponse Tests', () => {
  let app;

  beforeEach(() => {
    app = createTestApp();
  });

  describe('成功响应格式', () => {
    it('should return standardized success response', async () => {
      const res = await request(app).get('/test/success');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: { id: '123', name: 'Test' },
        meta: {
          requestId: 'test-req-123',
          timestamp: expect.any(String)
        }
      });
    });

    it('should return created response with 201 status', async () => {
      const res = await request(app).post('/test/created');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ id: '456', name: 'Created' });
    });

    it('should return paginated response with pagination info', async () => {
      const res = await request(app).get('/test/paginated');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.any(Array),
        pagination: {
          page: 1,
          limit: 20,
          total: 100,
          totalPages: 5,
          hasMore: true
        },
        meta: expect.any(Object)
      });
    });

    it('should return list response', async () => {
      const res = await request(app).get('/test/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });

    it('should return 204 no content', async () => {
      const res = await request(app).delete('/test/no-content');

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
    });

    it('should return deleted response with affected count', async () => {
      const res = await request(app).delete('/test/deleted');

      expect(res.status).toBe(200);
      expect(res.body.data.affected).toBe(3);
      expect(res.body.data.message).toContain('Successfully deleted');
    });
  });

  describe('错误响应格式', () => {
    it('should return standardized error response for business error', async () => {
      const res = await request(app).get('/test/error/business');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        error: {
          code: 'POKEMON_QUERY_NOT_FOUND',
          message: 'Pokemon not found',
          details: { pokemonId: 'pk-001' },
          i18nKey: 'errors.pokemon.not_found',
          docUrl: expect.any(String)
        },
        meta: expect.any(Object)
      });
    });

    it('should return validation error with details', async () => {
      const res = await request(app).get('/test/error/validation');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toHaveLength(1);
    });

    it('should return auth error with 401 status', async () => {
      const res = await request(app).get('/test/error/auth');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('USER_AUTH_TOKEN_EXPIRED');
      expect(res.body.error.i18nKey).toBe('errors.auth.token_expired');
    });

    it('should return 404 for unknown route', async () => {
      const res = await request(app).get('/unknown-route');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });
});

describe('ErrorCodes Tests', () => {
  it('should have all required fields for error codes', () => {
    const requiredFields = ['code', 'httpStatus', 'message', 'i18nKey'];

    Object.keys(ErrorCodes).forEach(key => {
      const errorDef = ErrorCodes[key];
      requiredFields.forEach(field => {
        expect(errorDef[field]).toBeDefined();
        expect(errorDef[field]).not.toBe('');
      });
    });
  });

  it('should have at least 20 error codes defined', () => {
    const errorCount = Object.keys(ErrorCodes).length;
    expect(errorCount).toBeGreaterThanOrEqual(20);
  });

  it('should have unique error codes', () => {
    const codes = Object.values(ErrorCodes).map(e => e.code);
    const uniqueCodes = new Set(codes);
    expect(codes.length).toBe(uniqueCodes.size);
  });

  it('should have valid HTTP status codes', () => {
    const validStatusCodes = [400, 401, 402, 403, 404, 405, 409, 410, 429, 500, 502, 503, 504];

    Object.values(ErrorCodes).forEach(errorDef => {
      expect(validStatusCodes).toContain(errorDef.httpStatus);
    });
  });
});

describe('AppError Tests', () => {
  it('should create AppError with correct properties', () => {
    const error = new AppError('POKEMON_QUERY_NOT_FOUND', { id: '123' });

    expect(error.code).toBe('POKEMON_QUERY_NOT_FOUND');
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe('Pokemon not found');
    expect(error.i18nKey).toBe('errors.pokemon.not_found');
    expect(error.details).toEqual({ id: '123' });
    expect(error.isOperational).toBe(true);
  });

  it('should throw error for unknown error code', () => {
    expect(() => {
      new AppError('UNKNOWN_ERROR_CODE');
    }).toThrow('Unknown error code');
  });

  it('should convert to JSON correctly', () => {
    const error = new AppError('VALIDATION_ERROR', [{ field: 'name' }]);
    const json = error.toJSON();

    expect(json).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ field: 'name' }],
      i18nKey: 'errors.common.validation'
    });
  });
});