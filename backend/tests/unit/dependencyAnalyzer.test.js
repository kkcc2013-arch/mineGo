/**
 * DependencyAnalyzer 单元测试
 */

const assert = require('assert');
const path = require('path');
const { DependencyAnalyzer } = require('../shared/dependencyAnalyzer');

describe('DependencyAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new DependencyAnalyzer();
  });

  describe('normalizeServiceName', () => {
    it('should normalize "user" to "user-service"', () => {
      const result = analyzer.normalizeServiceName('user');
      assert.strictEqual(result, 'user-service');
    });

    it('should normalize "user-service" to "user-service"', () => {
      const result = analyzer.normalizeServiceName('user-service');
      assert.strictEqual(result, 'user-service');
    });

    it('should normalize "USER" to "user-service" (case insensitive)', () => {
      const result = analyzer.normalizeServiceName('USER');
      assert.strictEqual(result, 'user-service');
    });

    it('should normalize "user:8081" to "user-service"', () => {
      const result = analyzer.normalizeServiceName('user:8081');
      assert.strictEqual(result, 'user-service');
    });

    it('should return null for unknown service', () => {
      const result = analyzer.normalizeServiceName('unknown-service');
      assert.strictEqual(result, null);
    });
  });

  describe('envToServiceName', () => {
    it('should convert USER_SERVICE_URL to user-service', () => {
      const result = analyzer.envToServiceName('USER_SERVICE_URL');
      assert.strictEqual(result, 'user-service');
    });

    it('should convert LOCATION_SERVICE_URL to location-service', () => {
      const result = analyzer.envToServiceName('LOCATION_SERVICE_URL');
      assert.strictEqual(result, 'location-service');
    });

    it('should return null for unknown env var', () => {
      const result = analyzer.envToServiceName('UNKNOWN_URL');
      assert.strictEqual(result, null);
    });
  });

  describe('gatewayKeyToService', () => {
    it('should convert "user" to "user-service"', () => {
      const result = analyzer.gatewayKeyToService('user');
      assert.strictEqual(result, 'user-service');
    });

    it('should return null for unknown key', () => {
      const result = analyzer.gatewayKeyToService('unknown');
      assert.strictEqual(result, null);
    });
  });

  describe('addDependency', () => {
    it('should add a new dependency', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test/file.js');
      
      assert.strictEqual(analyzer.dependencies.length, 1);
      assert.strictEqual(analyzer.dependencies[0].from, 'gateway');
      assert.strictEqual(analyzer.dependencies[0].to, 'user-service');
      assert.strictEqual(analyzer.dependencies[0].type, 'sync_http');
      assert.strictEqual(analyzer.dependencies[0].count, 1);
    });

    it('should increment count for duplicate dependencies', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test/file1.js');
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test/file2.js');
      
      assert.strictEqual(analyzer.dependencies.length, 1);
      assert.strictEqual(analyzer.dependencies[0].count, 2);
    });
  });

  describe('detectCycles', () => {
    it('should detect no cycles when none exist', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      analyzer.addDependency('gateway', 'pokemon-service', 'sync_http', '/test');
      
      const cycles = analyzer.detectCycles();
      assert.strictEqual(cycles.length, 0);
    });

    it('should detect a simple cycle', () => {
      analyzer.addDependency('user-service', 'social-service', 'sync_http', '/test');
      analyzer.addDependency('social-service', 'user-service', 'sync_http', '/test');
      
      const cycles = analyzer.detectCycles();
      assert.ok(cycles.length > 0, 'Should detect at least one cycle');
    });

    it('should detect a longer cycle', () => {
      analyzer.addDependency('user-service', 'social-service', 'sync_http', '/test');
      analyzer.addDependency('social-service', 'pokemon-service', 'sync_http', '/test');
      analyzer.addDependency('pokemon-service', 'user-service', 'sync_http', '/test');
      
      const cycles = analyzer.detectCycles();
      assert.ok(cycles.length > 0, 'Should detect at least one cycle');
    });
  });

  describe('getStartupOrder', () => {
    it('should return services in dependency order', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      analyzer.addDependency('gateway', 'pokemon-service', 'sync_http', '/test');
      analyzer.addDependency('pokemon-service', 'user-service', 'sync_http', '/test');
      
      const order = analyzer.getStartupOrder();
      
      // user-service should come before pokemon-service
      const userIndex = order.indexOf('user-service');
      const pokemonIndex = order.indexOf('pokemon-service');
      
      assert.ok(userIndex < pokemonIndex, 'user-service should start before pokemon-service');
    });

    it('should include all services', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      
      const order = analyzer.getStartupOrder();
      
      assert.strictEqual(order.length, analyzer.services.length);
    });
  });

  describe('generateMermaidGraph', () => {
    it('should generate valid Mermaid syntax', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      
      const graph = analyzer.generateMermaidGraph();
      
      assert.ok(graph.includes('graph TD'), 'Should include graph TD header');
      assert.ok(graph.includes('GATEWAY'), 'Should include GATEWAY node');
      assert.ok(graph.includes('USER'), 'Should include USER node');
    });
  });

  describe('generateDotGraph', () => {
    it('should generate valid GraphViz DOT syntax', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      
      const graph = analyzer.generateDotGraph();
      
      assert.ok(graph.includes('digraph Dependencies'), 'Should include digraph header');
      assert.ok(graph.includes('"gateway"'), 'Should include gateway node');
      assert.ok(graph.includes('"user-service"'), 'Should include user-service node');
    });
  });

  describe('getServiceDependencies', () => {
    it('should return service dependency details', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      analyzer.addDependency('social-service', 'user-service', 'sync_http', '/test');
      
      const deps = analyzer.getServiceDependencies('user-service');
      
      assert.strictEqual(deps.service, 'user-service');
      assert.ok(deps.dependencies.upstream.includes('gateway'));
      assert.ok(deps.dependencies.upstream.includes('social-service'));
      assert.ok(Array.isArray(deps.dependencies.downstream));
      assert.ok(typeof deps.health_score === 'number');
    });
  });

  describe('analyzeImpact', () => {
    it('should identify affected services', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      analyzer.addDependency('social-service', 'user-service', 'sync_http', '/test');
      
      const impact = analyzer.analyzeImpact('user-service');
      
      assert.strictEqual(impact.failed_service, 'user-service');
      assert.ok(impact.affected_services.includes('gateway'));
      assert.ok(impact.affected_services.includes('social-service'));
      assert.ok(typeof impact.impact_score === 'number');
    });

    it('should handle cascading failures', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      analyzer.addDependency('catch-service', 'gateway', 'sync_http', '/test');
      
      const impact = analyzer.analyzeImpact('user-service');
      
      // gateway depends on user-service
      // catch-service depends on gateway
      // So if user-service fails, both gateway and catch-service are affected
      assert.ok(impact.affected_services.includes('gateway'));
    });
  });

  describe('calculateHealthScores', () => {
    it('should calculate health scores for all services', () => {
      analyzer.addDependency('gateway', 'user-service', 'sync_http', '/test');
      
      const scores = analyzer.calculateHealthScores();
      
      assert.strictEqual(scores.size, analyzer.services.length);
      scores.forEach(score => {
        assert.ok(score >= 0 && score <= 100, 'Score should be between 0 and 100');
      });
    });

    it('should penalize services with too many dependencies', () => {
      // Add many dependencies to gateway
      for (let i = 0; i < 7; i++) {
        analyzer.addDependency('gateway', `service-${i}`, 'sync_http', '/test');
      }
      
      const scores = analyzer.calculateHealthScores();
      const gatewayScore = scores.get('gateway');
      
      assert.ok(gatewayScore < 100, 'Gateway should be penalized for too many dependencies');
    });
  });
});

// 运行测试
if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha();
  
  mocha.addFile(__filename);
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}
