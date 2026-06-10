/**
 * Schema Validator 单元测试
 * 
 * 测试覆盖：
 * - Schema 加载与解析
 * - 请求验证
 * - 响应验证
 * - 错误格式化
 * - 自定义格式验证
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { SchemaValidator, getSchemaValidator } = require('../schemaValidator');

// Mock logger
jest.mock('../logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('SchemaValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new SchemaValidator();
  });

  afterEach(() => {
    validator.clear();
  });

  describe('Schema 加载', () => {
    test('应该成功加载 JSON 格式的 OpenAPI 文档', async () => {
      // 创建测试用的 OpenAPI 文档
      const testSchema = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              operationId: 'getTest',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      // 写入临时文件
      const tempPath = '/tmp/test-schema.json';
      fs.writeFileSync(tempPath, JSON.stringify(testSchema));

      await validator.loadSchema('v1', tempPath);

      expect(validator.openapiDocs.has('v1')).toBe(true);
      expect(validator.validators.has('v1:getTest:request')).toBe(true);

      // 清理
      fs.unlinkSync(tempPath);
    });

    test('应该成功加载 YAML 格式的 OpenAPI 文档', async () => {
      const yamlContent = `
openapi: "3.0.0"
info:
  title: Test API
  version: "1.0.0"
paths:
  /users:
    get:
      operationId: getUsers
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
      responses:
        "200":
          description: OK
`;

      const tempPath = '/tmp/test-schema.yaml';
      fs.writeFileSync(tempPath, yamlContent);

      await validator.loadSchema('v1', tempPath);

      expect(validator.openapiDocs.has('v1')).toBe(true);

      fs.unlinkSync(tempPath);
    });

    test('应该拒绝不支持的格式', async () => {
      const tempPath = '/tmp/test-schema.txt';
      fs.writeFileSync(tempPath, 'invalid content');

      await expect(validator.loadSchema('v1', tempPath))
        .rejects.toThrow('Unsupported schema format: .txt');

      fs.unlinkSync(tempPath);
    });
  });

  describe('请求验证', () => {
    beforeEach(async () => {
      const schema = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUserById',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', pattern: '^[a-f0-9]{24}$' },
                },
                {
                  name: 'fields',
                  in: 'query',
                  schema: { type: 'string' },
                },
              ],
              responses: { '200': { description: 'OK' } },
            },
          },
          '/users': {
            post: {
              operationId: 'createUser',
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['name', 'email'],
                      properties: {
                        name: { type: 'string', minLength: 2 },
                        email: { type: 'string', format: 'email' },
                        age: { type: 'integer', minimum: 0, maximum: 150 },
                      },
                    },
                  },
                },
              },
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };

      const tempPath = '/tmp/test-validate.json';
      fs.writeFileSync(tempPath, JSON.stringify(schema));
      await validator.loadSchema('v1', tempPath);
      fs.unlinkSync(tempPath);
    });

    test('应该通过有效的请求', () => {
      const result = validator.validateRequest('v1', 'getUserById', {
        params: { id: '507f1f77bcf86cd799439011' },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('应该拒绝无效的 path 参数', () => {
      const result = validator.validateRequest('v1', 'getUserById', {
        params: { id: 'invalid-id' },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].keyword).toBe('pattern');
    });

    test('应该拒绝缺少必填字段', () => {
      const result = validator.validateRequest('v1', 'createUser', {
        body: { name: 'A' }, // 缺少 email，name 过短
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.keyword === 'required')).toBe(true);
      expect(result.errors.some(e => e.keyword === 'minLength')).toBe(true);
    });

    test('应该拒绝超出范围的数值', () => {
      const result = validator.validateRequest('v1', 'createUser', {
        body: {
          name: 'Test User',
          email: 'test@example.com',
          age: 200, // 超过最大值
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.keyword === 'maximum')).toBe(true);
    });

    test('应该跳过没有 Schema 的 operationId', () => {
      const result = validator.validateRequest('v1', 'unknownOperation', {});

      expect(result.valid).toBe(true);
    });
  });

  describe('响应验证', () => {
    beforeEach(async () => {
      const schema = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['code', 'data'],
                        properties: {
                          code: { type: 'integer' },
                          message: { type: 'string' },
                          data: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const tempPath = '/tmp/test-response.json';
      fs.writeFileSync(tempPath, JSON.stringify(schema));
      await validator.loadSchema('v1', tempPath);
      fs.unlinkSync(tempPath);
    });

    test('应该通过有效的响应', () => {
      const result = validator.validateResponse('v1', 'getUsers', '200', {
        code: 0,
        data: [{ id: '123', name: 'Test' }],
      });

      expect(result.valid).toBe(true);
    });

    test('应该拒绝缺少必填字段的响应', () => {
      const result = validator.validateResponse('v1', 'getUsers', '200', {
        message: 'Success',
        // 缺少 code 和 data
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.keyword === 'required')).toBe(true);
    });

    test('应该拒绝类型错误的响应', () => {
      const result = validator.validateResponse('v1', 'getUsers', '200', {
        code: '0', // 应该是 integer
        data: 'not an array', // 应该是 array
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('自定义格式验证', () => {
    beforeEach(async () => {
      const schema = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/location': {
            post: {
              operationId: 'updateLocation',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        lat: { type: 'number', format: 'lat' },
                        lng: { type: 'number', format: 'lng' },
                        phone: { type: 'string', format: 'phone-cn' },
                      },
                    },
                  },
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const tempPath = '/tmp/test-formats.json';
      fs.writeFileSync(tempPath, JSON.stringify(schema));
      await validator.loadSchema('v1', tempPath);
      fs.unlinkSync(tempPath);
    });

    test('应该验证有效的纬度', () => {
      const result = validator.validateRequest('v1', 'updateLocation', {
        body: { lat: 45.5, lng: -73.5 },
      });

      expect(result.valid).toBe(true);
    });

    test('应该拒绝无效的纬度', () => {
      const result = validator.validateRequest('v1', 'updateLocation', {
        body: { lat: 100, lng: -73.5 }, // 纬度超出范围
      });

      expect(result.valid).toBe(false);
    });

    test('应该验证有效的中国手机号', () => {
      const result = validator.validateRequest('v1', 'updateLocation', {
        body: { phone: '13800138000' },
      });

      expect(result.valid).toBe(true);
    });

    test('应该拒绝无效的手机号', () => {
      const result = validator.validateRequest('v1', 'updateLocation', {
        body: { phone: '1234567890' }, // 不符合中国手机号格式
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('辅助方法', () => {
    test('应该返回所有 operationId', async () => {
      const schema = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: { operationId: 'getUsers', responses: { '200': { description: 'OK' } } },
            post: { operationId: 'createUser', responses: { '201': { description: 'Created' } } },
          },
        },
      };

      const tempPath = '/tmp/test-ops.json';
      fs.writeFileSync(tempPath, JSON.stringify(schema));
      await validator.loadSchema('v1', tempPath);
      fs.unlinkSync(tempPath);

      const ops = validator.getOperationIds('v1');
      expect(ops).toContain('getUsers');
      expect(ops).toContain('createUser');
    });

    test('应该返回 Schema 加载状态', async () => {
      const schema = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {},
      };

      const tempPath = '/tmp/test-status.json';
      fs.writeFileSync(tempPath, JSON.stringify(schema));
      await validator.loadSchema('v1', tempPath);
      fs.unlinkSync(tempPath);

      const status = validator.getStatus();
      expect(status.v1).toBeDefined();
      expect(status.v1.loaded).toBe(true);
    });
  });
});

describe('getSchemaValidator', () => {
  test('应该返回单例实例', () => {
    const v1 = getSchemaValidator();
    const v2 = getSchemaValidator();
    expect(v1).toBe(v2);
  });
});
