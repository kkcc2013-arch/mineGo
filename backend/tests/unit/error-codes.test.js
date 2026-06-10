// backend/tests/unit/error-codes.test.js - 错误码系统单元测试
'use strict';

const {
  ERROR_CODES,
  getErrorConfig,
  getErrorsByCategory,
  getErrorsByService,
  getAllErrorCodes,
  isValidErrorCode,
  getErrorStatistics,
} = require('../../shared/errorCodes');

const {
  AppError,
  Errors,
  errorHandlerMiddleware,
  notFoundHandler,
  asyncHandler,
  requestIdMiddleware,
} = require('../../shared/errorHandler');

describe('Error Codes System', () => {
  
  describe('Error Code Registry', () => {
    
    test('should have valid error code format', () => {
      const errorCodes = Object.keys(ERROR_CODES);
      expect(errorCodes.length).toBeGreaterThan(50);
      
      for (const code of errorCodes) {
        // 验证格式：SX-MMM-EEE
        expect(code).toMatch(/^[GULPCGSRP]\d-\d{3}-\d{3}$/);
      }
    });
    
    test('should have all required fields for each error code', () => {
      for (const [code, config] of Object.entries(ERROR_CODES)) {
        expect(config.code).toBe(code);
        expect(config.httpStatus).toBeGreaterThanOrEqual(400);
        expect(config.message).toBeDefined();
        expect(config.messageKey).toBeDefined();
        expect(config.category).toBeDefined();
        expect(config.severity).toMatch(/^(info|warning|critical)$/);
        expect(typeof config.retryable).toBe('boolean');
        expect(config.troubleshooting).toBeDefined();
      }
    });
    
    test('should get error config by code', () => {
      const config = getErrorConfig('G1-001-001');
      expect(config).toBeDefined();
      expect(config.code).toBe('G1-001-001');
      expect(config.httpStatus).toBe(401);
    });
    
    test('should return null for invalid error code', () => {
      const config = getErrorConfig('INVALID');
      expect(config).toBeNull();
    });
    
    test('should get errors by category', () => {
      const authErrors = getErrorsByCategory('auth');
      expect(authErrors.length).toBeGreaterThan(5);
      
      for (const error of authErrors) {
        expect(error.category).toBe('auth');
      }
    });
    
    test('should get errors by service', () => {
      const gatewayErrors = getErrorsByService('G1');
      expect(gatewayErrors.length).toBeGreaterThan(3);
      
      for (const error of gatewayErrors) {
        expect(error.code).toMatch(/^G1-/);
      }
    });
    
    test('should get all error codes', () => {
      const allCodes = getAllErrorCodes();
      expect(allCodes.length).toBeGreaterThan(50);
    });
    
    test('should validate error code existence', () => {
      expect(isValidErrorCode('G1-001-001')).toBe(true);
      expect(isValidErrorCode('INVALID')).toBe(false);
    });
    
    test('should generate correct error statistics', () => {
      const stats = getErrorStatistics();
      
      expect(stats.total).toBeGreaterThan(50);
      expect(stats.byCategory).toBeDefined();
      expect(stats.byService).toBeDefined();
      expect(stats.bySeverity).toBeDefined();
      
      // 验证分类统计
      expect(stats.byCategory.auth).toBeGreaterThan(0);
      expect(stats.byCategory.validation).toBeGreaterThan(0);
      expect(stats.byCategory.business).toBeGreaterThan(0);
      
      // 验证服务统计
      expect(stats.byService.G).toBeGreaterThan(0);
      expect(stats.byService.U).toBeGreaterThan(0);
      
      // 验证严重程度统计
      expect(stats.bySeverity.warning).toBeGreaterThan(0);
    });
    
  });
  
  describe('AppError Class', () => {
    
    test('should create AppError with valid code', () => {
      const error = new AppError('G1-001-001', { reason: 'test' });
      
      expect(error.code).toBe('G1-001-001');
      expect(error.httpStatus).toBe(401);
      expect(error.message).toBe('Invalid access token');
      expect(error.details).toEqual({ reason: 'test' });
      expect(error.retryable).toBe(false);
      expect(error.severity).toBe('warning');
    });
    
    test('should fallback to generic error for unknown code', () => {
      const error = new AppError('UNKNOWN-CODE', { test: true });
      
      expect(error.code).toBe('G1-003-999');
      expect(error.httpStatus).toBe(500);
      expect(error.isUnknown).toBe(true);
    });
    
    test('should override options', () => {
      const error = new AppError('G1-001-001', {}, {
        httpStatus: 403,
        message: 'Custom message',
        retryable: true,
        severity: 'critical',
      });
      
      expect(error.httpStatus).toBe(403);
      expect(error.message).toBe('Custom message');
      expect(error.retryable).toBe(true);
      expect(error.severity).toBe('critical');
    });
    
    test('should convert to JSON', () => {
      const error = new AppError('G1-001-001', { reason: 'test' });
      const json = error.toJSON('req_123');
      
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('G1-001-001');
      expect(json.error.message).toBe('Invalid access token');
      expect(json.error.messageKey).toBe('error.auth.invalid_token');
      expect(json.error.details).toEqual({ reason: 'test' });
      expect(json.error.requestId).toBe('req_123');
      expect(json.error.docUrl).toContain('/errors/G1-001-001');
      expect(json.error.retryable).toBe(false);
      expect(json.error.severity).toBe('warning');
      expect(json.timestamp).toBeDefined();
    });
    
  });
  
  describe('Error Factory Functions', () => {
    
    test('should create authentication errors', () => {
      const error = Errors.invalidToken({ test: true });
      expect(error.code).toBe('G1-001-001');
      expect(error.httpStatus).toBe(401);
    });
    
    test('should create user errors', () => {
      const error = Errors.emailAlreadyRegistered();
      expect(error.code).toBe('U2-001-001');
      expect(error.httpStatus).toBe(400);
    });
    
    test('should create pokemon errors', () => {
      const error = Errors.pokemonNotFound();
      expect(error.code).toBe('P4-001-001');
      expect(error.httpStatus).toBe(404);
    });
    
    test('should create catch errors', () => {
      const error = Errors.pokemonEscaped();
      expect(error.code).toBe('C5-001-001');
    });
    
    test('should create payment errors', () => {
      const error = Errors.paymentFailed('insufficient_balance');
      expect(error.code).toBe('P9-001-005');
      expect(error.details.reason).toBe('insufficient_balance');
    });
    
    test('should create not found error with custom resource', () => {
      const error = Errors.notFound('Pokemon', { id: '123' });
      expect(error.httpStatus).toBe(404);
      expect(error.message).toContain('Pokemon');
      expect(error.details.resource).toBe('Pokemon');
    });
    
    test('should create validation error', () => {
      const error = Errors.validationError('email', 'Invalid format');
      expect(error.httpStatus).toBe(400);
      expect(error.message).toContain('Validation error');
      expect(error.details.field).toBe('email');
    });
    
    test('should create internal error with cause', () => {
      const cause = new Error('Database connection failed');
      const error = Errors.internalError({ query: 'SELECT' }, cause);
      
      expect(error.httpStatus).toBe(500);
      expect(error.severity).toBe('critical');
      expect(error.cause).toBe(cause);
    });
    
  });
  
  describe('Error Handler Middleware', () => {
    
    let req, res, next;
    
    beforeEach(() => {
      req = {
        method: 'GET',
        originalUrl: '/api/v1/test',
        headers: {},
        ip: '127.0.0.1',
        user: { id: 'user_123' },
      };
      
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };
      
      next = jest.fn();
    });
    
    test('should handle AppError correctly', () => {
      const error = Errors.invalidToken();
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'G1-001-001',
          }),
        })
      );
    });
    
    test('should handle validation error', () => {
      const validationError = {
        name: 'ValidationError',
        details: [{ path: ['email'], message: 'Invalid email' }],
        message: 'Validation failed',
      };
      
      errorHandlerMiddleware(validationError, req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            messageKey: 'error.validation.failed',
          }),
        })
      );
    });
    
    test('should handle JWT unauthorized error', () => {
      const jwtError = {
        name: 'UnauthorizedError',
        message: 'jwt expired',
      };
      
      errorHandlerMiddleware(jwtError, req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'G1-001-001',
          }),
        })
      );
    });
    
    test('should handle unknown errors', () => {
      const unknownError = new Error('Something went wrong');
      
      errorHandlerMiddleware(unknownError, req, res, next);
      
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            severity: 'critical',
          }),
        })
      );
    });
    
    test('should include request ID from header', () => {
      req.headers['x-request-id'] = 'req_from_header';
      const error = Errors.invalidToken();
      
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            requestId: 'req_from_header',
          }),
        })
      );
    });
    
  });
  
  describe('Async Handler', () => {
    
    test('should catch async errors', async () => {
      const asyncFn = jest.fn().mockRejectedValue(new Error('Async error'));
      const wrapped = asyncHandler(asyncFn);
      
      const req = {};
      const res = {};
      const next = jest.fn();
      
      await wrapped(req, res, next);
      
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
    
    test('should pass through successful async calls', async () => {
      const asyncFn = jest.fn().mockResolvedValue('success');
      const wrapped = asyncHandler(asyncFn);
      
      const req = {};
      const res = {};
      const next = jest.fn();
      
      await wrapped(req, res, next);
      
      expect(next).not.toHaveBeenCalled();
    });
    
  });
  
  describe('Request ID Middleware', () => {
    
    test('should generate request ID if not present', () => {
      const req = { headers: {} };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();
      
      requestIdMiddleware(req, res, next);
      
      expect(req.id).toBeDefined();
      expect(req.id).toMatch(/^req_/);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
      expect(next).toHaveBeenCalled();
    });
    
    test('should use existing request ID from header', () => {
      const req = { headers: { 'x-request-id': 'existing_id' } };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();
      
      requestIdMiddleware(req, res, next);
      
      expect(req.id).toBe('existing_id');
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'existing_id');
    });
    
  });
  
  describe('Not Found Handler', () => {
    
    test('should create 404 error', () => {
      const req = {
        method: 'GET',
        originalUrl: '/api/v1/nonexistent',
      };
      const res = {};
      const next = jest.fn();
      
      notFoundHandler(req, res, next);
      
      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.httpStatus).toBe(404);
    });
    
  });
  
  describe('Error Code Coverage', () => {
    
    test('should cover all authentication error codes', () => {
      const authCodes = ['G1-001-001', 'G1-001-002', 'G1-001-003', 'G1-001-004'];
      
      for (const code of authCodes) {
        const config = getErrorConfig(code);
        expect(config).toBeDefined();
        expect(config.category).toBe('auth');
      }
    });
    
    test('should cover all payment error codes', () => {
      const paymentCodes = [
        'P9-001-001', 'P9-001-002', 'P9-001-003',
        'P9-001-004', 'P9-001-005', 'P9-001-006',
      ];
      
      for (const code of paymentCodes) {
        const config = getErrorConfig(code);
        expect(config).toBeDefined();
      }
    });
    
    test('should have correct HTTP status codes', () => {
      // 401 错误
      expect(getErrorConfig('G1-001-001').httpStatus).toBe(401);
      expect(getErrorConfig('G1-001-002').httpStatus).toBe(401);
      
      // 403 错误
      expect(getErrorConfig('G1-001-004').httpStatus).toBe(403);
      expect(getErrorConfig('U2-001-005').httpStatus).toBe(403);
      
      // 404 错误
      expect(getErrorConfig('U2-002-001').httpStatus).toBe(404);
      expect(getErrorConfig('P4-001-001').httpStatus).toBe(404);
      
      // 400 错误
      expect(getErrorConfig('U2-001-001').httpStatus).toBe(400);
      expect(getErrorConfig('U2-001-002').httpStatus).toBe(400);
      
      // 429 错误
      expect(getErrorConfig('G1-002-001').httpStatus).toBe(429);
    });
    
  });
  
  describe('Internationalization', () => {
    
    test('should have message keys for all errors', () => {
      for (const [code, config] of Object.entries(ERROR_CODES)) {
        expect(config.messageKey).toBeDefined();
        expect(config.messageKey).toMatch(/^error\./);
      }
    });
    
    test('should have valid message key format', () => {
      for (const config of Object.values(ERROR_CODES)) {
        // messageKey 格式：error.{category}.{specific}
        const parts = config.messageKey.split('.');
        expect(parts.length).toBeGreaterThanOrEqual(3);
      }
    });
    
  });
  
  describe('Troubleshooting Guide', () => {
    
    test('should have troubleshooting text for all errors', () => {
      for (const config of Object.values(ERROR_CODES)) {
        expect(config.troubleshooting).toBeDefined();
        expect(config.troubleshooting.length).toBeGreaterThan(10);
      }
    });
    
    test('should have tags for categorization', () => {
      const taggedErrors = Object.values(ERROR_CODES).filter(e => e.tags);
      expect(taggedErrors.length).toBeGreaterThan(30);
    });
    
  });
  
});
