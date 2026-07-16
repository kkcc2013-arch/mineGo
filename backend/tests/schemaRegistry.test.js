'use strict';
/**
 * Schema Registry Unit Tests
 * REQ-00547: API 响应 Schema 强制执行与合约测试自动化系统
 */

const { expect } = require('chai');
const { SchemaRegistry } = require('../../shared/schemaRegistry/SchemaRegistry');

// Mock dependencies
const mockRedis = {
  get: async () => null,
  setex: async () => true,
  del: async () => true,
  lpush: async () => true,
  ltrim: async () => true,
  expire: async () => true,
  keys: async () => [],
  publish: async () => true
};

const mockDbPool = {
  query: async () => ({ rows: [] })
};

describe('SchemaRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new SchemaRegistry({
      redisClient: mockRedis,
      dbPool: mockDbPool,
      enableCache: false,
      enablePostgresPersistence: false
    });
  });

  describe('validateSchemaDefinition', () => {
    it('should validate a correct schema', () => {
      const schema = {
        '$schema': 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      };

      const result = registry.validateSchemaDefinition(schema);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should reject schema without $schema', () => {
      const schema = {
        type: 'object'
      };

      const result = registry.validateSchemaDefinition(schema);
      expect(result.valid).to.be.false;
      expect(result.errors).to.include('Missing $schema field');
    });

    it('should reject schema without type', () => {
      const schema = {
        '$schema': 'http://json-schema.org/draft-07/schema#'
      };

      const result = registry.validateSchemaDefinition(schema);
      expect(result.valid).to.be.false;
      expect(result.errors).to.include('Missing type field');
    });
  });

  describe('validateAgainstSchema', () => {
    it('should validate correct data', async () => {
      const schema = {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' }
        }
      };

      const data = {
        name: 'John',
        age: 30
      };

      const result = await registry.validateAgainstSchema(data, schema);
      expect(result.valid).to.be.true;
      expect(result.errors).to.be.empty;
    });

    it('should reject data with missing required field', async () => {
      const schema = {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' }
        }
      };

      const data = {
        age: 30
      };

      const result = await registry.validateAgainstSchema(data, schema);
      expect(result.valid).to.be.false;
      expect(result.errors).to.have.length.greaterThan(0);
    });

    it('should reject data with wrong type', async () => {
      const schema = {
        type: 'object',
        properties: {
          age: { type: 'integer' }
        }
      };

      const data = {
        age: 'thirty'
      };

      const result = await registry.validateAgainstSchema(data, schema);
      expect(result.valid).to.be.false;
      expect(result.errors).to.have.length.greaterThan(0);
    });
  });

  describe('compareSchemas', () => {
    it('should detect added required field as breaking change', () => {
      const schema1 = {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' }
        }
      };

      const schema2 = {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: { type: 'string' },
          email: { type: 'string' }
        }
      };

      const differences = registry.compareSchemas(schema1, schema2);
      
      const breakingChanges = differences.filter(d => d.breaking);
      expect(breakingChanges).to.have.length.greaterThan(0);
      expect(breakingChanges[0].type).to.equal('required_added');
      expect(breakingChanges[0].fields).to.include('email');
    });

    it('should detect removed property as breaking change', () => {
      const schema1 = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' }
        }
      };

      const schema2 = {
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      };

      const differences = registry.compareSchemas(schema1, schema2);
      
      const breakingChanges = differences.filter(d => d.breaking);
      expect(breakingChanges).to.have.length.greaterThan(0);
      expect(breakingChanges[0].type).to.equal('property_removed');
      expect(breakingChanges[0].field).to.equal('email');
    });

    it('should detect type change as breaking change', () => {
      const schema1 = {
        type: 'object',
        properties: {
          age: { type: 'integer' }
        }
      };

      const schema2 = {
        type: 'object',
        properties: {
          age: { type: 'string' }
        }
      };

      const differences = registry.compareSchemas(schema1, schema2);
      
      const breakingChanges = differences.filter(d => d.breaking);
      expect(breakingChanges).to.have.length.greaterThan(0);
      expect(breakingChanges[0].type).to.equal('type_changed');
      expect(breakingChanges[0].from).to.equal('integer');
      expect(breakingChanges[0].to).to.equal('string');
    });
  });
});

describe('SchemaDiffDetector', () => {
  let detector;

  beforeEach(() => {
    const SchemaDiffDetector = require('../../shared/schemaRegistry/SchemaDiffDetector');
    detector = new SchemaDiffDetector();
  });

  describe('detectDifferences', () => {
    it('should detect type mismatch', () => {
      const schema = {
        properties: {
          age: { type: 'integer' }
        }
      };

      const data = {
        age: 'thirty'
      };

      const differences = detector.detectDifferences(schema, data);
      
      expect(differences).to.have.length.greaterThan(0);
      expect(differences[0].type).to.equal('type_mismatch');
      expect(differences[0].expected).to.equal('integer');
      expect(differences[0].actual).to.equal('string');
    });

    it('should detect missing required field', () => {
      const schema = {
        required: ['name', 'email'],
        properties: {
          name: { type: 'string' },
          email: { type: 'string' }
        }
      };

      const data = {
        name: 'John'
      };

      const differences = detector.detectDifferences(schema, data);
      
      const missingRequired = differences.find(d => d.type === 'missing_required_field');
      expect(missingRequired).to.exist;
      expect(missingRequired.fields).to.include('email');
    });

    it('should detect extra field', () => {
      const schema = {
        properties: {
          name: { type: 'string' }
        }
      };

      const data = {
        name: 'John',
        age: 30
      };

      const differences = detector.detectDifferences(schema, data);
      
      const extraField = differences.find(d => d.type === 'extra_field');
      expect(extraField).to.exist;
      expect(extraField.fields).to.include('age');
    });

    it('should detect enum mismatch', () => {
      const schema = {
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'inactive']
          }
        }
      };

      const data = {
        status: 'pending'
      };

      const differences = detector.detectDifferences(schema, data);
      
      const enumMismatch = differences.find(d => d.type === 'enum_mismatch');
      expect(enumMismatch).to.exist;
      expect(enumMismatch.value).to.equal('pending');
      expect(enumMismatch.allowed).to.deep.equal(['active', 'inactive']);
    });
  });

  describe('suggestFixes', () => {
    it('should suggest fixes for type mismatch', () => {
      const differences = [
        {
          type: 'type_mismatch',
          path: 'age',
          expected: 'integer',
          actual: 'string',
          breaking: true
        }
      ];

      const fixes = detector.suggestFixes(differences);
      
      expect(fixes).to.have.length(1);
      expect(fixes[0].type).to.equal('fix_type');
      expect(fixes[0].suggestion).to.include('Convert value to integer');
    });

    it('should suggest fixes for missing required field', () => {
      const differences = [
        {
          type: 'missing_required_field',
          fields: ['email'],
          breaking: true
        }
      ];

      const fixes = detector.suggestFixes(differences);
      
      expect(fixes).to.have.length(1);
      expect(fixes[0].type).to.equal('add_field');
      expect(fixes[0].fields).to.include('email');
    });
  });
});