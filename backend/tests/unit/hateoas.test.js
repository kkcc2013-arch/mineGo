/**
 * HATEOAS 单元测试
 * REQ-00518: API 超媒体链接（HATEOAS）与资源发现系统
 */

'use strict';

const assert = require('assert');
const { LinkBuilder } = require('../../../shared/utils/LinkBuilder');
const { HalFormatter } = require('../../../shared/utils/HalFormatter');
const { ResourceDiscoverer } = require('../../../shared/utils/ResourceDiscoverer');
const ApiResponse = require('../../../shared/utils/ApiResponse');

describe('REQ-00518 HATEOAS Tests', () => {
  
  // ==================== LinkBuilder Tests ====================
  describe('LinkBuilder', () => {
    let linkBuilder;
    
    beforeEach(() => {
      linkBuilder = new LinkBuilder({
        baseUrl: 'http://localhost:3000',
        apiVersion: 'v1'
      });
    });
    
    it('should build self link correctly', () => {
      const link = linkBuilder.buildSelfLink('pokemon', '123');
      
      assert.strictEqual(link.href, 'http://localhost:3000/api/v1/pokemon/123');
      assert.strictEqual(link.method, 'GET');
      assert.ok(link.title.includes('pokemon'));
    });
    
    it('should build collection link correctly', () => {
      const link = linkBuilder.buildCollectionLink('pokemon');
      
      assert.strictEqual(link.href, 'http://localhost:3000/api/v1/pokemon');
      assert.strictEqual(link.method, 'GET');
    });
    
    it('should build collection link with query parameters', () => {
      const link = linkBuilder.buildCollectionLink('pokemon', { type: 'fire', limit: 20 });
      
      assert.ok(link.href.includes('type=fire'));
      assert.ok(link.href.includes('limit=20'));
    });
    
    it('should build pagination links correctly', () => {
      const links = linkBuilder.buildPaginationLinks(
        'http://localhost:3000/api/v1/pokemon',
        { page: 2, limit: 10, totalPages: 5 },
        {}
      );
      
      assert.ok(links.first, 'Should have first link');
      assert.ok(links.prev, 'Should have prev link');
      assert.ok(links.next, 'Should have next link');
      assert.ok(links.last, 'Should have last link');
      
      assert.ok(links.prev.href.includes('page=1'));
      assert.ok(links.next.href.includes('page=3'));
    });
    
    it('should not include prev link on first page', () => {
      const links = linkBuilder.buildPaginationLinks(
        'http://localhost:3000/api/v1/pokemon',
        { page: 1, limit: 10, totalPages: 5 },
        {}
      );
      
      assert.ok(!links.prev, 'Should not have prev link on first page');
    });
    
    it('should not include next link on last page', () => {
      const links = linkBuilder.buildPaginationLinks(
        'http://localhost:3000/api/v1/pokemon',
        { page: 5, limit: 10, totalPages: 5 },
        {}
      );
      
      assert.ok(!links.next, 'Should not have next link on last page');
    });
    
    it('should build related link correctly', () => {
      const link = linkBuilder.buildRelatedLink('pokemon', '123', 'user');
      
      assert.strictEqual(link.href, 'http://localhost:3000/api/v1/pokemon/123/users');
      assert.strictEqual(link.method, 'GET');
    });
    
    it('should build action link correctly', () => {
      const link = linkBuilder.buildActionLink('pokemon', '123', 'catch');
      
      assert.strictEqual(link.href, 'http://localhost:3000/api/v1/pokemon/123/catch');
      assert.strictEqual(link.method, 'POST');
    });
    
    it('should build all resource links', () => {
      const links = linkBuilder.buildResourceLinks('pokemon', '123');
      
      assert.ok(links.self, 'Should have self link');
      assert.ok(links.collection, 'Should have collection link');
      assert.ok(links.catch, 'Should have catch action');
      assert.ok(links.evolve, 'Should have evolve action');
    });
    
    it('should register custom template', () => {
      linkBuilder.registerTemplate('custom-search', (params) => ({
        href: `/api/v1/${params.resource}/search?q=${params.query}`,
        method: 'GET'
      }));
      
      const link = linkBuilder.buildFromTemplate('custom-search', {
        resource: 'pokemon',
        query: 'pikachu'
      });
      
      assert.ok(link.href.includes('search?q=pikachu'));
    });
    
    it('should register custom relationships', () => {
      linkBuilder.registerRelationships('custom', {
        owner: { resource: 'user', type: 'belongsTo' }
      });
      
      const relationships = linkBuilder.getRelationships();
      assert.ok(relationships.has('custom'));
    });
  });
  
  // ==================== HalFormatter Tests ====================
  describe('HalFormatter', () => {
    let formatter;
    let linkBuilder;
    
    beforeEach(() => {
      linkBuilder = new LinkBuilder({
        baseUrl: 'http://localhost:3000',
        apiVersion: 'v1'
      });
      formatter = new HalFormatter({ linkBuilder });
    });
    
    it('should format single resource correctly', () => {
      const data = { id: '123', name: 'Pikachu', cp: 500 };
      const hal = formatter.formatResource(data, 'pokemon');
      
      assert.ok(hal._links, 'Should have _links');
      assert.ok(hal._links.self, 'Should have self link');
      assert.strictEqual(hal.id, '123');
      assert.strictEqual(hal.name, 'Pikachu');
    });
    
    it('should format collection correctly', () => {
      const items = [
        { id: '1', name: 'Pikachu' },
        { id: '2', name: 'Charizard' }
      ];
      
      const hal = formatter.formatCollection(items, 'pokemon', {
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1
      });
      
      assert.ok(hal._links, 'Should have _links');
      assert.ok(hal._embedded, 'Should have _embedded');
      assert.ok(Array.isArray(hal._embedded.items));
      assert.strictEqual(hal._embedded.items.length, 2);
      assert.strictEqual(hal.total, 2);
    });
    
    it('should add pagination links in collection', () => {
      const items = [{ id: '1', name: 'Pikachu' }];
      
      const hal = formatter.formatCollection(items, 'pokemon', {
        page: 1,
        limit: 1,
        total: 5,
        totalPages: 5
      });
      
      assert.ok(hal._links.first, 'Should have first link');
      assert.ok(hal._links.next, 'Should have next link');
      assert.ok(hal._links.last, 'Should have last link');
    });
    
    it('should format discovery response', () => {
      const endpoints = {
        pokemon: { href: '/api/v1/pokemon', title: 'Pokemon Collection' },
        users: { href: '/api/v1/users', title: 'User Collection' }
      };
      
      const hal = formatter.formatDiscoveryResponse(endpoints, {
        apiVersion: '1.0.0'
      });
      
      assert.ok(hal._links, 'Should have _links');
      assert.ok(hal._links.self, 'Should have self link');
      assert.ok(hal._links.pokemon, 'Should have pokemon link');
      assert.ok(hal._meta, 'Should have _meta');
      assert.strictEqual(hal._meta.api_version, '1.0.0');
    });
    
    it('should format error response', () => {
      const error = new Error('Not found');
      error.code = 'NOT_FOUND';
      
      const hal = formatter.formatError(error, {
        requestUrl: '/api/v1/pokemon/999',
        method: 'GET'
      });
      
      assert.ok(hal._links, 'Should have _links');
      assert.ok(hal.error, 'Should have error object');
      assert.strictEqual(hal.error.code, 'NOT_FOUND');
    });
    
    it('should validate HAL structure correctly', () => {
      const validHal = {
        _links: {
          self: { href: '/api/v1/pokemon/123' }
        },
        id: '123',
        name: 'Pikachu'
      };
      
      const invalidHal = {
        id: '123',
        name: 'Pikachu'
      };
      
      const validResult = formatter.validate(validHal);
      const invalidResult = formatter.validate(invalidHal);
      
      assert.strictEqual(validResult.valid, true);
      assert.strictEqual(invalidResult.valid, false);
      assert.ok(invalidResult.errors.length > 0);
    });
    
    it('should handle null data gracefully', () => {
      const hal = formatter.formatResource(null, 'pokemon');
      assert.strictEqual(hal, null);
    });
    
    it('should serialize to JSON correctly', () => {
      const data = { id: '123', name: 'Pikachu' };
      const hal = formatter.formatResource(data, 'pokemon');
      
      const json = formatter.toJson(hal);
      const parsed = JSON.parse(json);
      
      assert.ok(parsed._links);
      assert.strictEqual(parsed.id, '123');
    });
  });
  
  // ==================== ResourceDiscoverer Tests ====================
  describe('ResourceDiscoverer', () => {
    let discoverer;
    
    beforeEach(() => {
      discoverer = new ResourceDiscoverer({
        cacheTTL: 1000 // 1 second for testing
      });
    });
    
    it('should discover all resources', async () => {
      const discovery = await discoverer.discoverAll();
      
      assert.ok(discovery._links, 'Should have _links');
      assert.ok(discovery._links.self, 'Should have self link');
      assert.ok(discovery._links.pokemon, 'Should have pokemon link');
      assert.ok(discovery._links.user, 'Should have user link');
      assert.ok(discovery._meta, 'Should have _meta');
    });
    
    it('should discover single resource', async () => {
      const resource = await discoverer.discoverResource('pokemon');
      
      assert.ok(resource, 'Should return resource');
      assert.strictEqual(resource.name, 'pokemon');
      assert.ok(Array.isArray(resource.methods));
      assert.ok(Array.isArray(resource.actions));
      assert.ok(resource.schema, 'Should have schema');
    });
    
    it('should return null for unknown resource', async () => {
      const resource = await discoverer.discoverResource('unknown');
      assert.strictEqual(resource, null);
    });
    
    it('should get resource schema', () => {
      const schema = discoverer.getResourceSchema('pokemon');
      
      assert.ok(schema, 'Should have schema');
      assert.ok(schema.id, 'Should have id field');
      assert.ok(schema.name, 'Should have name field');
    });
    
    it('should get resource actions', () => {
      const actions = discoverer.getResourceActions('pokemon');
      
      assert.ok(Array.isArray(actions));
      assert.ok(actions.includes('catch'));
      assert.ok(actions.includes('evolve'));
    });
    
    it('should get resource relationships', () => {
      const relationships = discoverer.getResourceRelationships('pokemon');
      
      assert.ok(relationships, 'Should have relationships');
      assert.ok(relationships.owner, 'Should have owner relationship');
    });
    
    it('should cache discovery results', async () => {
      // First call
      const discovery1 = await discoverer.discoverAll();
      
      // Second call (should use cache)
      const discovery2 = await discoverer.discoverAll();
      
      assert.strictEqual(discovery1, discovery2, 'Should return cached result');
    });
    
    it('should clear cache', async () => {
      await discoverer.discoverAll();
      
      discoverer.clearCache();
      
      const stats = discoverer.getStats();
      assert.strictEqual(stats.cacheSize, 0);
    });
    
    it('should register custom resource', () => {
      discoverer.registerResource('custom', {
        path: 'custom',
        description: 'Custom resource',
        methods: ['GET'],
        actions: ['custom-action'],
        relationships: {},
        schema: { id: { type: 'string' } }
      });
      
      assert.ok(discoverer.hasResource('custom'));
      
      const allResources = discoverer.getAllResources();
      assert.ok(allResources.find(r => r.name === 'custom'));
    });
    
    it('should return stats', () => {
      const stats = discoverer.getStats();
      
      assert.ok(typeof stats.resourceCount === 'number');
      assert.ok(typeof stats.cacheSize === 'number');
      assert.ok(typeof stats.cacheTTL === 'number');
    });
  });
  
  // ==================== ApiResponse Tests ====================
  describe('ApiResponse HATEOAS Support', () => {
    // Mock response object
    const mockRes = () => {
      const res = {
        locals: { requestId: 'test-123' },
        statusCode: null,
        jsonData: null,
        status: function(code) {
          this.statusCode = code;
          return this;
        },
        json: function(data) {
          this.jsonData = data;
          return this;
        }
      };
      return res;
    };
    
    it('should add HATEOAS links when resourceType is specified', () => {
      const res = mockRes();
      const data = { id: '123', name: 'Pikachu' };
      
      ApiResponse.success(res, data, { resourceType: 'pokemon' });
      
      assert.ok(res.jsonData._links, 'Should have _links');
      assert.ok(res.jsonData._links.self, 'Should have self link');
    });
    
    it('should not add HATEOAS links when resourceType is not specified', () => {
      const res = mockRes();
      const data = { id: '123', name: 'Pikachu' };
      
      ApiResponse.success(res, data, {});
      
      assert.ok(!res.jsonData._links, 'Should not have _links');
    });
    
    it('should add pagination links in paginated response', () => {
      const res = mockRes();
      const items = [{ id: '1', name: 'Pikachu' }];
      
      ApiResponse.paginated(res, items, { page: 1, limit: 10, total: 25 }, { resourceType: 'pokemon' });
      
      assert.ok(res.jsonData._links, 'Should have _links');
      assert.ok(res.jsonData._links.self, 'Should have self link');
      assert.ok(res.jsonData._links.next, 'Should have next link');
    });
    
    it('should support HAL format response', () => {
      const res = mockRes();
      const data = { id: '123', name: 'Pikachu', cp: 500 };
      
      ApiResponse.hal(res, data, 'pokemon');
      
      assert.ok(res.jsonData._links, 'Should have _links');
      assert.ok(res.jsonData._meta, 'Should have _meta');
    });
    
    it('should support HAL paginated response', () => {
      const res = mockRes();
      const items = [{ id: '1', name: 'Pikachu' }];
      
      ApiResponse.halPaginated(res, items, 'pokemon', { page: 1, limit: 10, total: 25 });
      
      assert.ok(res.jsonData._links, 'Should have _links');
      assert.ok(res.jsonData._embedded, 'Should have _embedded');
      assert.ok(res.jsonData._meta, 'Should have _meta');
    });
    
    it('should enable/disable HATEOAS globally', () => {
      ApiResponse.setHateoasEnabled(false);
      
      const res = mockRes();
      const data = { id: '123', name: 'Pikachu' };
      
      ApiResponse.success(res, data, { resourceType: 'pokemon' });
      
      assert.ok(!res.jsonData._links, 'Should not have _links when disabled');
      
      // Re-enable
      ApiResponse.setHateoasEnabled(true);
    });
  });
  
  // ==================== Integration Tests ====================
  describe('Integration Tests', () => {
    it('should build complete HAL structure with all components', () => {
      const linkBuilder = new LinkBuilder({
        baseUrl: 'http://localhost:3000',
        apiVersion: 'v1'
      });
      
      const formatter = new HalFormatter({ linkBuilder });
      
      const pokemon = {
        id: '123',
        speciesId: '25',
        name: 'Pikachu',
        cp: 500,
        hp: 100,
        level: 20,
        stats: { attack: 112, defense: 101, stamina: 128 },
        moves: [
          { id: 'm1', name: 'Thunder Shock', type: 'electric' }
        ]
      };
      
      const hal = formatter.formatResource(pokemon, 'pokemon');
      
      // Validate structure
      assert.ok(hal._links.self);
      assert.ok(hal._links.collection);
      assert.ok(hal._links.catch);
      assert.ok(hal._links.evolve);
      
      // Validate embedded resources
      if (hal._embedded) {
        assert.ok(hal._embedded.stats || hal._embedded.moves, 'Should have embedded resources');
      }
      
      // Validate core data
      assert.strictEqual(hal.id, '123');
      assert.strictEqual(hal.name, 'Pikachu');
    });
    
    it('should handle complete discovery workflow', async () => {
      const discoverer = new ResourceDiscoverer();
      
      // Get all resources
      const allResources = await discoverer.discoverAll();
      assert.ok(allResources._links.pokemon);
      
      // Get specific resource
      const pokemonResource = await discoverer.discoverResource('pokemon');
      assert.ok(pokemonResource.schema);
      
      // Get actions
      const actions = discoverer.getResourceActions('pokemon');
      assert.ok(actions.includes('catch'));
      
      // Get schema
      const schema = discoverer.getResourceSchema('pokemon');
      assert.ok(schema.id);
    });
  });
  
});

// Run tests if executed directly
if (require.main === module) {
  console.log('Running REQ-00518 HATEOAS Tests...\n');
  
  // Simple test runner
  let passed = 0;
  let failed = 0;
  
  const originalDescribe = describe;
  const originalIt = it;
  
  global.describe = (name, fn) => {
    console.log(`\n${name}`);
    fn();
  };
  
  global.it = (name, fn) => {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (error) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${error.message}`);
      failed++;
    }
  };
  
  // Re-run with custom runner
  require(__filename);
  
  console.log(`\n\nTest Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}