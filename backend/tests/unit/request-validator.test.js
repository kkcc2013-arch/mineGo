/**
 * Request Validator Middleware 单元测试
 */

'use strict';

const { requestValidatorMiddleware, formatValidationErrors } = require('../../shared/middleware/requestValidator');

// Mock dependencies
jest.mock('../../shared/schemaValidator', () => ({
  getSchemaValidator: () => ({
    validateRequest: jest.fn((version, operationId, data) => {
      if (operationId === 'validOperation') {
        return { valid: true, errors: [] };
      }
      if (operationId === 'invalidOperation') {
        return {
          valid: false,
          errors: [
            {
              path: '/body/name',
              message: 'should NOT be shorter than 2 characters',
              keyword: 'minLength',
              params: { limit: 2 },
            },
            {
              path: '/body/email',
              message: 'should have required property',
              keyword: 'required',
              params: { missingProperty: 'email' },
            },
          ],
        };
      }
      return { valid: true, errors: [] };
    }),
  }),
}));

jest.mock('../../shared/logger', () => ({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../../shared/metrics', () => ({
  apiValidationErrors: { inc: jest.fn() },
  apiValidationDuration: { observe: jest.fn() },
}));

describe('requestValidatorMiddleware', () => {
  let middleware;
  let req, res, next;

  beforeEach(() => {
    middleware = requestValidatorMiddleware({ version: 'v1' });
    
    req = {
      method: 'POST',
      path: '/test',
      params: {},
      query: {},
      headers: { 'x-trace-id': 'test-trace' },
      body: {},
    };
    
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    
    next = jest.fn();
  });

  test('应该跳过没有 operationId 的请求', async () => {
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('应该通过有效的请求', async () => {
    req.operationId = 'validOperation';
    req.body = { name: 'Test', email: 'test@example.com' };
    
    await middleware(req, res, next);
    
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('应该拒绝无效的请求', async () => {
    req.operationId = 'invalidOperation';
    req.body = { name: 'A' }; // name 过短，缺少 email
    
    await middleware(req, res, next);
    
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 1001,
        message: '请求参数不符合规范',
      })
    );
  });

  test('应该记录验证错误指标', async () => {
    const metrics = require('../../shared/metrics');
    req.operationId = 'invalidOperation';
    
    await middleware(req, res, next);
    
    expect(metrics.apiValidationErrors.inc).toHaveBeenCalledWith({
      operationId: 'invalidOperation',
      type: 'request',
    });
  });
});

describe('formatValidationErrors', () => {
  test('应该格式化 required 错误', () => {
    const errors = [
      {
        keyword: 'required',
        params: { missingProperty: 'email' },
        message: 'should have required property',
      },
    ];
    
    const formatted = formatValidationErrors(errors);
    
    expect(formatted[0].message).toBe('缺少必填字段: email');
    expect(formatted[0].suggestion).toBe('请确保该字段已填写');
  });

  test('应该格式化 minLength 错误', () => {
    const errors = [
      {
        path: '/name',
        keyword: 'minLength',
        params: { limit: 2 },
        message: 'should NOT be shorter than 2 characters',
      },
    ];
    
    const formatted = formatValidationErrors(errors);
    
    expect(formatted[0].message).toBe('字符串过短: 最小长度 2');
    expect(formatted[0].suggestion).toBe('请增加字段内容长度');
  });

  test('应该格式化 type 错误', () => {
    const errors = [
      {
        path: '/age',
        keyword: 'type',
        params: { type: 'integer' },
        message: 'should be integer',
      },
    ];
    
    const formatted = formatValidationErrors(errors);
    
    expect(formatted[0].message).toBe('字段类型错误: 期望 integer, 实际值不符合');
    expect(formatted[0].suggestion).toBe('请检查字段类型是否正确');
  });

  test('应该格式化 enum 错误', () => {
    const errors = [
      {
        keyword: 'enum',
        params: { allowedValues: ['red', 'green', 'blue'] },
        message: 'should be equal to one of the allowed values',
      },
    ];
    
    const formatted = formatValidationErrors(errors);
    
    expect(formatted[0].message).toBe('值不在允许范围内: 允许值 [red, green, blue]');
  });

  test('应该格式化 additionalProperties 错误', () => {
    const errors = [
      {
        keyword: 'additionalProperties',
        params: { additionalProperty: 'extraField' },
        message: 'should NOT have additional properties',
      },
    ];
    
    const formatted = formatValidationErrors(errors);
    
    expect(formatted[0].message).toBe('不允许的字段: extraField');
    expect(formatted[0].suggestion).toBe('请删除该字段');
  });
});
