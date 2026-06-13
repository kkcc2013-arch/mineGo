// backend/tests/unit/errors.test.js - 统一错误处理系统单元测试
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

// 测试错误类
const {
  BaseError,
  ValidationError,
  BusinessError,
  DatabaseError,
  ExternalServiceError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ERROR_CODES,
  Errors
} = require('../../../shared/errors');

describe('统一错误处理系统', () => {
  
  describe('BaseError', () => {
    it('应该正确创建基础错误', () => {
      const error = new BaseError('TEST-001', 'Test error message', {
        statusCode: 400,
        details: { field: 'test' }
      });
      
      expect(error).to.be.instanceOf(Error);
      expect(error).to.be.instanceOf(BaseError);
      expect(error.code).to.equal('TEST-001');
      expect(error.message).to.equal('Test error message');
      expect(error.statusCode).to.equal(400);
      expect(error.details).to.deep.equal({ field: 'test' });
      expect(error.isOperational).to.be.true;
      expect(error.timestamp).to.exist;
    });
    
    it('应该正确转换为 JSON 格式', () => {
      const error = new BaseError('TEST-001', 'Test error', { statusCode: 400 });
      const json = error.toJSON('req-123', '/api/test');
      
      expect(json.success).to.be.false;
      expect(json.code).to.equal('TEST-001');
      expect(json.message).to.equal('Test error');
      expect(json.requestId).to.equal('req-123');
      expect(json.path).to.equal('/api/test');
      expect(json.timestamp).to.exist;
    });
    
    it('应该在开发环境包含堆栈信息', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      
      const error = new BaseError('TEST-001', 'Test error');
      const json = error.toJSON();
      
      expect(json.stack).to.exist;
      
      process.env.NODE_ENV = originalEnv;
    });
    
    it('应该在生产环境隐藏堆栈信息', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      
      const error = new BaseError('TEST-001', 'Test error');
      const json = error.toJSON();
      
      expect(json.stack).to.be.undefined;
      
      process.env.NODE_ENV = originalEnv;
    });
  });
  
  describe('ValidationError', () => {
    it('应该正确创建验证错误', () => {
      const error = new ValidationError('email', 'Invalid email format');
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error).to.be.instanceOf(ValidationError);
      expect(error.field).to.equal('email');
      expect(error.statusCode).to.equal(400);
      expect(error.category).to.equal('validation');
      expect(error.severity).to.equal('info');
    });
    
    it('应该从 Joi 错误创建验证错误', () => {
      const joiError = {
        details: [
          {
            path: ['email'],
            message: '"email" must be a valid email'
          }
        ]
      };
      
      const error = ValidationError.fromJoiError(joiError);
      
      expect(error.field).to.equal('email');
      expect(error.message).to.equal('"email" must be a valid email');
      expect(error.details.validationErrors).to.deep.equal(joiError.details);
    });
  });
  
  describe('BusinessError', () => {
    it('应该正确创建业务错误', () => {
      const error = new BusinessError(ERROR_CODES.USER_ALREADY_EXISTS, 'User already exists');
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error).to.be.instanceOf(BusinessError);
      expect(error.statusCode).to.equal(400);
      expect(error.isOperational).to.be.true;
      expect(error.category).to.equal('business');
    });
    
    it('应该支持自定义 HTTP 状态码', () => {
      const error = new BusinessError('TEST', 'Test', { statusCode: 403 });
      
      expect(error.statusCode).to.equal(403);
    });
  });
  
  describe('DatabaseError', () => {
    it('应该正确创建数据库错误', () => {
      const cause = new Error('Connection refused');
      const error = new DatabaseError('query', 'Database operation failed', cause);
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error).to.be.instanceOf(DatabaseError);
      expect(error.operation).to.equal('query');
      expect(error.cause).to.equal(cause);
      expect(error.statusCode).to.equal(500);
      expect(error.category).to.equal('database');
      expect(error.severity).to.equal('critical');
    });
    
    it('应该从 PostgreSQL 错误创建数据库错误', () => {
      const pgError = {
        code: '23505',
        message: 'duplicate key value violates unique constraint',
        constraint: 'users_email_key',
        table: 'users'
      };
      
      const error = DatabaseError.fromPostgresError(pgError, 'insert');
      
      expect(error.operation).to.equal('insert');
      expect(error.details.pgCode).to.equal('23505');
      expect(error.details.constraint).to.equal('users_email_key');
    });
  });
  
  describe('ExternalServiceError', () => {
    it('应该正确创建外部服务错误', () => {
      const error = new ExternalServiceError('PaymentGateway', 'Service unavailable');
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error).to.be.instanceOf(ExternalServiceError);
      expect(error.serviceName).to.equal('PaymentGateway');
      expect(error.statusCode).to.equal(502);
      expect(error.category).to.equal('external_service');
    });
    
    it('应该创建超时错误', () => {
      const error = ExternalServiceError.timeout('PaymentGateway', 5000);
      
      expect(error.message).to.include('timeout');
      expect(error.details.timeout).to.be.true;
      expect(error.details.timeoutMs).to.equal(5000);
    });
  });
  
  describe('AuthenticationError', () => {
    it('应该创建无效令牌错误', () => {
      const error = AuthenticationError.invalidToken({ reason: 'expired' });
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error.statusCode).to.equal(401);
      expect(error.details.reason).to.equal('expired');
    });
    
    it('应该创建权限不足错误', () => {
      const error = AuthenticationError.insufficientPermissions('admin');
      
      expect(error.statusCode).to.equal(403);
      expect(error.details.requiredPermission).to.equal('admin');
    });
    
    it('应该创建令牌过期错误', () => {
      const error = AuthenticationError.tokenExpired();
      
      expect(error.statusCode).to.equal(401);
    });
  });
  
  describe('RateLimitError', () => {
    it('应该正确创建限流错误', () => {
      const error = new RateLimitError(60);
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error).to.be.instanceOf(RateLimitError);
      expect(error.retryAfter).to.equal(60);
      expect(error.statusCode).to.equal(429);
      expect(error.category).to.equal('rate_limit');
    });
    
    it('应该在 JSON 中包含 retryAfter', () => {
      const error = new RateLimitError(60);
      const json = error.toJSON('req-123');
      
      expect(json.retryAfter).to.equal(60);
    });
  });
  
  describe('NotFoundError', () => {
    it('应该正确创建资源不存在错误', () => {
      const error = new NotFoundError('User', 'user-123');
      
      expect(error).to.be.instanceOf(BaseError);
      expect(error).to.be.instanceOf(NotFoundError);
      expect(error.resource).to.equal('User');
      expect(error.identifier).to.equal('user-123');
      expect(error.statusCode).to.equal(404);
      expect(error.message).to.equal('User not found');
    });
  });
  
  describe('Errors 工厂函数', () => {
    it('应该创建用户相关错误', () => {
      const error = Errors.userNotFound('user-123');
      
      expect(error).to.be.instanceOf(NotFoundError);
      expect(error.resource).to.equal('User');
    });
    
    it('应该创建精灵相关错误', () => {
      const error = Errors.pokemonNotFound('pokemon-123');
      
      expect(error).to.be.instanceOf(NotFoundError);
      expect(error.resource).to.equal('Pokemon');
    });
    
    it('应该创建验证错误', () => {
      const error = Errors.validationError('email', 'Invalid email');
      
      expect(error).to.be.instanceOf(ValidationError);
      expect(error.field).to.equal('email');
    });
    
    it('应该创建认证错误', () => {
      const error = Errors.invalidToken();
      
      expect(error).to.be.instanceOf(AuthenticationError);
      expect(error.statusCode).to.equal(401);
    });
    
    it('应该创建限流错误', () => {
      const error = Errors.rateLimitExceeded(60);
      
      expect(error).to.be.instanceOf(RateLimitError);
      expect(error.retryAfter).to.equal(60);
    });
    
    it('应该创建业务错误', () => {
      const error = Errors.userAlreadyExists('test@example.com');
      
      expect(error).to.be.instanceOf(BusinessError);
      expect(error.details.email).to.equal('test@example.com');
    });
  });
  
  describe('错误码', () => {
    it('应该定义所有必要的错误码', () => {
      expect(ERROR_CODES.SUCCESS).to.equal(0);
      expect(ERROR_CODES.AUTH_INVALID_TOKEN).to.equal('AUTH-001');
      expect(ERROR_CODES.USER_NOT_FOUND).to.equal('USER-001');
      expect(ERROR_CODES.POKEMON_NOT_FOUND).to.equal('PKMN-001');
      expect(ERROR_CODES.RATE_LIMIT_EXCEEDED).to.equal('RATE-001');
    });
    
    it('错误码应该有对应的消息', () => {
      const { ERROR_MESSAGES, getErrorMessage } = require('../../../shared/errors/errorCodes');
      
      expect(ERROR_MESSAGES[ERROR_CODES.AUTH_INVALID_TOKEN]).to.exist;
      expect(getErrorMessage(ERROR_CODES.AUTH_INVALID_TOKEN)).to.exist;
    });
  });
});

describe('错误处理中间件', () => {
  const { errorHandlerMiddleware, notFoundHandler, asyncHandler } = require('../../../shared/middleware/errorHandler');
  
  let req, res, next;
  
  beforeEach(() => {
    req = {
      headers: {},
      method: 'GET',
      originalUrl: '/api/test',
      ip: '127.0.0.1'
    };
    
    res = {
      status: sinon.stub().returnsThis(),
      json: sinon.stub().returnsThis(),
      setHeader: sinon.stub()
    };
    
    next = sinon.stub();
  });
  
  describe('errorHandlerMiddleware', () => {
    it('应该处理 BaseError', () => {
      const error = new BusinessError('TEST-001', 'Test error');
      
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.status.calledWith(400)).to.be.true;
      expect(res.json.calledOnce).to.be.true;
      
      const response = res.json.firstCall.args[0];
      expect(response.success).to.be.false;
      expect(response.code).to.equal('TEST-001');
      expect(response.message).to.equal('Test error');
      expect(response.requestId).to.exist;
    });
    
    it('应该处理 ValidationError', () => {
      const error = new ValidationError('email', 'Invalid email');
      
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.status.calledWith(400)).to.be.true;
      
      const response = res.json.firstCall.args[0];
      expect(response.details.field).to.equal('email');
    });
    
    it('应该处理 RateLimitError 并设置 Retry-After 头', () => {
      const error = new RateLimitError(60);
      
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.status.calledWith(429)).to.be.true;
      expect(res.setHeader.calledWith('Retry-After', 60)).to.be.true;
    });
    
    it('应该处理未知错误', () => {
      const error = new Error('Unknown error');
      
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.status.calledWith(500)).to.be.true;
      
      const response = res.json.firstCall.args[0];
      expect(response.code).to.equal('GEN-004');
    });
    
    it('应该为请求生成 requestId', () => {
      const error = new Error('Test');
      
      errorHandlerMiddleware(error, req, res, next);
      
      expect(res.setHeader.calledWith('X-Request-Id')).to.be.true;
    });
    
    it('应该使用请求头中的 requestId', () => {
      req.headers['x-request-id'] = 'custom-request-id';
      const error = new Error('Test');
      
      errorHandlerMiddleware(error, req, res, next);
      
      const response = res.json.firstCall.args[0];
      expect(response.requestId).to.equal('custom-request-id');
    });
  });
  
  describe('notFoundHandler', () => {
    it('应该创建 NotFoundError 并传递给下一个中间件', () => {
      notFoundHandler(req, res, next);
      
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args[0]).to.be.instanceOf(NotFoundError);
    });
  });
  
  describe('asyncHandler', () => {
    it('应该捕获异步错误并传递给下一个中间件', async () => {
      const asyncFn = async (req, res, next) => {
        throw new Error('Async error');
      };
      
      const wrapped = asyncHandler(asyncFn);
      await wrapped(req, res, next);
      
      expect(next.calledOnce).to.be.true;
      expect(next.firstCall.args[0]).to.be.instanceOf(Error);
    });
    
    it('应该正确执行异步函数', async () => {
      const asyncFn = async (req, res, next) => {
        res.json({ success: true });
      };
      
      const wrapped = asyncHandler(asyncFn);
      await wrapped(req, res, next);
      
      expect(res.json.calledOnce).to.be.true;
      expect(next.called).to.be.false;
    });
  });
});
