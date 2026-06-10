'use strict';
/**
 * Contract System Unit Tests - 契约系统单元测试
 */

const { ContractSchema } = require('../../shared/contract/ContractSchema');
const ContractRegistry = require('../../shared/contract/ContractRegistry');
const CompatibilityChecker = require('../../shared/contract/CompatibilityChecker');
const Joi = require('joi');

describe('ContractSchema', () => {
  let contract;

  beforeEach(() => {
    contract = new ContractSchema('test-service', '1.0.0');
  });

  describe('constructor', () => {
    test('should create contract with name and version', () => {
      expect(contract.name).toBe('test-service');
      expect(contract.version).toBe('1.0.0');
      expect(contract.endpoints.size).toBe(0);
      expect(contract.schemas.size).toBe(0);
    });
  });

  describe('defineSchema', () => {
    test('should define reusable schema', () => {
      const schema = Joi.string().uuid();
      contract.defineSchema('UserId', schema);
      
      expect(contract.schemas.has('UserId')).toBe(true);
      expect(contract.getSchema('UserId')).toBe(schema);
    });

    test('should return this for chaining', () => {
      const result = contract.defineSchema('Test', Joi.string());
      expect(result).toBe(contract);
    });
  });

  describe('defineEndpoint', () => {
    test('should define endpoint with all options', () => {
      contract.defineEndpoint({
        method: 'GET',
        path: '/api/test',
        description: 'Test endpoint',
        request: Joi.object({ id: Joi.string() }),
        response: Joi.object({ data: Joi.string() }),
        expectedStatus: 200
      });

      const endpoint = contract.getEndpoint('GET', '/api/test');
      expect(endpoint).toBeDefined();
      expect(endpoint.method).toBe('GET');
      expect(endpoint.path).toBe('/api/test');
      expect(endpoint.description).toBe('Test endpoint');
      expect(endpoint.expectedStatus).toBe(200);
    });

    test('should throw error if path is missing', () => {
      expect(() => {
        contract.defineEndpoint({ method: 'GET' });
      }).toThrow('Endpoint path is required');
    });

    test('should use default values for optional fields', () => {
      contract.defineEndpoint({ path: '/api/default' });
      
      const endpoint = contract.getEndpoint('GET', '/api/default');
      expect(endpoint.method).toBe('GET');
      expect(endpoint.expectedStatus).toBe(200);
    });
  });

  describe('defineRequest/defineResponse', () => {
    test('should define request schema separately', () => {
      contract.defineRequest('/api/users', Joi.object({ name: Joi.string() }), 'POST');
      
      const endpoint = contract.getEndpoint('POST', '/api/users');
      expect(endpoint.request).toBeDefined();
    });

    test('should define response schema separately', () => {
      contract.defineResponse('/api/users', Joi.object({ id: Joi.string() }));
      
      const endpoint = contract.getEndpoint('GET', '/api/users');
      expect(endpoint.response).toBeDefined();
    });
  });

  describe('validateRequest', () => {
    beforeEach(() => {
      contract.defineEndpoint({
        method: 'POST',
        path: '/api/users',
        request: Joi.object({
          username: Joi.string().min(3).required(),
          email: Joi.string().email().required()
        })
      });
    });

    test('should validate valid request data', () => {
      const result = contract.validateRequest('POST', '/api/users', {
        username: 'testuser',
        email: 'test@example.com'
      });
      
      expect(result.error).toBeUndefined();
      expect(result.value).toBeDefined();
    });

    test('should return error for invalid request data', () => {
      const result = contract.validateRequest('POST', '/api/users', {
        username: 'ab', // too short
        email: 'invalid-email'
      });
      
      expect(result.error).toBeDefined();
    });

    test('should return error for missing endpoint', () => {
      const result = contract.validateRequest('GET', '/api/nonexistent', {});
      
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('not found');
    });
  });

  describe('validateResponse', () => {
    beforeEach(() => {
      contract.defineEndpoint({
        method: 'GET',
        path: '/api/users/:id',
        response: Joi.object({
          id: Joi.string().uuid().required(),
          username: Joi.string().required()
        })
      });
    });

    test('should validate valid response data', () => {
      const result = contract.validateResponse('GET', '/api/users/:id', {
        id: '123e4567-e89b-12d3-a456-426614174000',
        username: 'testuser'
      });
      
      expect(result.error).toBeUndefined();
    });

    test('should return error for invalid response data', () => {
      const result = contract.validateResponse('GET', '/api/users/:id', {
        id: 'not-a-uuid',
        username: 'testuser'
      });
      
      expect(result.error).toBeDefined();
    });
  });

  describe('getAllEndpoints', () => {
    test('should return all defined endpoints', () => {
      contract.defineEndpoint({ method: 'GET', path: '/api/users' });
      contract.defineEndpoint({ method: 'POST', path: '/api/users' });
      contract.defineEndpoint({ method: 'GET', path: '/api/pokemon' });

      const endpoints = contract.getAllEndpoints();
      expect(endpoints.length).toBe(3);
    });
  });

  describe('toJSON', () => {
    test('should export contract as JSON', () => {
      contract.defineSchema('UserId', Joi.string().uuid());
      contract.defineEndpoint({ method: 'GET', path: '/api/test' });

      const json = contract.toJSON();
      
      expect(json.name).toBe('test-service');
      expect(json.version).toBe('1.0.0');
      expect(json.schemas).toContain('UserId');
      expect(json.endpoints.length).toBe(1);
    });
  });
});

describe('ContractRegistry', () => {
  let registry;
  let testContract;

  beforeEach(() => {
    registry = new ContractRegistry();
    testContract = new ContractSchema('user-service', '1.0.0');
    testContract.defineEndpoint({ method: 'GET', path: '/api/users/me' });
  });

  describe('registerProvider', () => {
    test('should register provider contract', () => {
      registry.registerProvider('user-service', testContract);
      
      expect(registry.getProvider('user-service')).toBe(testContract);
    });

    test('should store provider metadata', () => {
      registry.registerProvider('user-service', testContract);
      
      const providers = registry.getAllProviders();
      expect(providers).toContain('user-service');
    });

    test('should store contract history when re-registering', () => {
      registry.registerProvider('user-service', testContract);
      
      const newContract = new ContractSchema('user-service', '1.1.0');
      registry.registerProvider('user-service', newContract);
      
      const history = registry.getContractHistory('user-service');
      expect(history.length).toBe(1);
      expect(history[0].version).toBe('1.0.0');
    });
  });

  describe('registerConsumer', () => {
    test('should register consumer expectations', () => {
      registry.registerProvider('user-service', testContract);
      registry.registerConsumer('social-service', 'user-service', [
        { path: '/api/users/me', responseSchema: Joi.object({ id: Joi.string() }) }
      ]);

      const consumerContract = registry.getConsumerContract('social-service', 'user-service');
      expect(consumerContract).toBeDefined();
      expect(consumerContract.consumer).toBe('social-service');
      expect(consumerContract.provider).toBe('user-service');
    });
  });

  describe('verifyProvider', () => {
    test('should return results for provider verification', async () => {
      registry.registerProvider('user-service', testContract);
      
      const results = await registry.verifyProvider('user-service');
      
      expect(results.provider).toBe('user-service');
      expect(results.total).toBe(1);
    });

    test('should throw error for unknown provider', async () => {
      await expect(registry.verifyProvider('unknown-service')).rejects.toThrow('No contract found');
    });
  });

  describe('verifyConsumerExpectations', () => {
    beforeEach(() => {
      testContract.defineEndpoint({
        method: 'GET',
        path: '/api/users/me',
        response: Joi.object({
          id: Joi.string().uuid().required(),
          username: Joi.string().required()
        })
      });
      registry.registerProvider('user-service', testContract);
    });

    test('should verify matching expectations', async () => {
      registry.registerConsumer('social-service', 'user-service', [
        {
          path: '/api/users/me',
          responseSchema: Joi.object({ id: Joi.string().required() })
        }
      ]);

      const results = await registry.verifyConsumerExpectations('social-service', 'user-service');
      
      expect(results.passed).toBe(true);
      expect(results.matched).toBe(1);
    });

    test('should detect missing endpoint', async () => {
      registry.registerConsumer('social-service', 'user-service', [
        { path: '/api/users/nonexistent' }
      ]);

      const results = await registry.verifyConsumerExpectations('social-service', 'user-service');
      
      expect(results.passed).toBe(false);
      expect(results.mismatches.length).toBeGreaterThan(0);
      expect(results.mismatches[0].type).toBe('missing_endpoint');
    });
  });

  describe('checkCompatibility', () => {
    test('should return compatible for new provider', () => {
      const newContract = new ContractSchema('new-service', '1.0.0');
      
      const result = registry.checkCompatibility('new-service', newContract);
      
      expect(result.compatible).toBe(true);
      expect(result.isNew).toBe(true);
    });

    test('should detect breaking changes', () => {
      registry.registerProvider('user-service', testContract);
      
      const newContract = new ContractSchema('user-service', '1.1.0');
      // 不包含原来的端点，这是破坏性变更
      
      const result = registry.checkCompatibility('user-service', newContract);
      
      expect(result.compatible).toBe(false);
      expect(result.breakingChanges.length).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    test('should clear all contracts', () => {
      registry.registerProvider('user-service', testContract);
      registry.clear();
      
      expect(registry.getAllProviders().length).toBe(0);
    });
  });
});

describe('CompatibilityChecker', () => {
  let checker;

  beforeEach(() => {
    checker = new CompatibilityChecker();
  });

  describe('checkCompatibility', () => {
    test('should return compatible for identical contracts', () => {
      const contract1 = new ContractSchema('test', '1.0.0');
      const contract2 = new ContractSchema('test', '1.0.0');
      
      contract1.defineEndpoint({ method: 'GET', path: '/api/test' });
      contract2.defineEndpoint({ method: 'GET', path: '/api/test' });

      const result = checker.checkCompatibility(contract1, contract2);
      
      expect(result.compatible).toBe(true);
    });

    test('should detect endpoint removal as breaking change', () => {
      const oldContract = new ContractSchema('test', '1.0.0');
      const newContract = new ContractSchema('test', '1.1.0');
      
      oldContract.defineEndpoint({ method: 'GET', path: '/api/old' });
      newContract.defineEndpoint({ method: 'GET', path: '/api/new' });

      const result = checker.checkCompatibility(oldContract, newContract);
      
      expect(result.compatible).toBe(false);
      expect(result.breakingChanges.some(c => c.type === 'endpoint_removed')).toBe(true);
    });

    test('should detect new endpoint as non-breaking change', () => {
      const oldContract = new ContractSchema('test', '1.0.0');
      const newContract = new ContractSchema('test', '1.1.0');
      
      oldContract.defineEndpoint({ method: 'GET', path: '/api/existing' });
      newContract.defineEndpoint({ method: 'GET', path: '/api/existing' });
      newContract.defineEndpoint({ method: 'GET', path: '/api/new' });

      const result = checker.checkCompatibility(oldContract, newContract);
      
      expect(result.compatible).toBe(true);
      expect(result.nonBreakingChanges.some(c => c.type === 'endpoint_added')).toBe(true);
    });
  });

  describe('checkSchemaCompatibility', () => {
    test('should return compatible when provider has all required fields', () => {
      const consumerSchema = Joi.object({
        id: Joi.string().required(),
        name: Joi.string().required()
      });

      const providerSchema = Joi.object({
        id: Joi.string().required(),
        name: Joi.string().required(),
        email: Joi.string() // extra field is OK
      });

      const result = checker.checkSchemaCompatibility(consumerSchema, providerSchema);
      
      expect(result.compatible).toBe(true);
    });

    test('should detect missing field', () => {
      const consumerSchema = Joi.object({
        id: Joi.string().required(),
        name: Joi.string().required(),
        email: Joi.string().required()
      });

      const providerSchema = Joi.object({
        id: Joi.string().required(),
        name: Joi.string().required()
        // missing email
      });

      const result = checker.checkSchemaCompatibility(consumerSchema, providerSchema);
      
      expect(result.compatible).toBe(false);
      expect(result.issues.some(i => i.type === 'missing_field')).toBe(true);
    });
  });

  describe('extractKeys', () => {
    test('should extract keys from Joi object schema', () => {
      const schema = Joi.object({
        id: Joi.string(),
        name: Joi.string(),
        email: Joi.string()
      });

      const keys = checker.extractKeys(schema);
      
      expect(keys.has('id')).toBe(true);
      expect(keys.has('name')).toBe(true);
      expect(keys.has('email')).toBe(true);
    });

    test('should return empty set for null schema', () => {
      const keys = checker.extractKeys(null);
      expect(keys.size).toBe(0);
    });
  });
});
