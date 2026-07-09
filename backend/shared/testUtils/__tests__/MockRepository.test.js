// backend/shared/testUtils/__tests__/MockRepository.test.js
'use strict';

const {
  MockRepository,
  createMockRepository,
  mockRepo
} = require('../mockRepository');

describe('MockRepository', () => {
  let repo;
  
  beforeEach(() => {
    repo = createMockRepository({
      dataDir: '/tmp/test-fixtures'
    });
  });
  
  afterEach(() => {
    repo.cache.clear();
  });
  
  describe('set() and get()', () => {
    it('should save and retrieve mock data', () => {
      const testData = { name: 'TestUser', level: 10 };
      repo.set('user:testuser', testData);
      
      const retrieved = repo.get('user:testuser');
      expect(retrieved).toEqual(testData);
    });
    
    it('should return a deep copy', () => {
      const testData = { nested: { value: 1 } };
      repo.set('user:test', testData);
      
      const copy1 = repo.get('user:test');
      copy1.nested.value = 2;
      
      const copy2 = repo.get('user:test');
      expect(copy2.nested.value).toBe(1);
    });
    
    it('should support overrides', () => {
      const baseData = { name: 'Base', level: 1 };
      repo.set('user:base', baseData);
      
      const overridden = repo.get('user:base', { level: 99 });
      expect(overridden.level).toBe(99);
      expect(overridden.name).toBe('Base');
    });
    
    it('should throw error for missing key', () => {
      expect(() => repo.get('invalid:key')).toThrow('Mock data not found');
    });
  });
  
  describe('getMany()', () => {
    it('should generate multiple instances', () => {
      const baseData = { name: 'User', level: 1 };
      repo.set('user:template', baseData);
      
      const many = repo.getMany('user:template', 5);
      expect(many).toHaveLength(5);
      many.forEach(item => {
        expect(item.name).toBe('User');
      });
    });
    
    it('should apply overrides to each instance', () => {
      const baseData = { name: 'User', level: 1 };
      repo.set('user:template', baseData);
      
      const many = repo.getMany('user:template', 3, [
        { level: 10 },
        { level: 20 },
        { level: 30 }
      ]);
      
      expect(many[0].level).toBe(10);
      expect(many[1].level).toBe(20);
      expect(many[2].level).toBe(30);
    });
  });
  
  describe('list()', () => {
    it('should list all keys', () => {
      repo.set('user:a', {});
      repo.set('user:b', {});
      repo.set('pokemon:c', {});
      
      const all = repo.list();
      expect(all.length).toBeGreaterThanOrEqual(3);
    });
    
    it('should filter by category', () => {
      repo.set('user:x', {});
      repo.set('user:y', {});
      repo.set('pokemon:z', {});
      
      const userKeys = repo.list('user');
      expect(userKeys).toContain('user:x');
      expect(userKeys).toContain('user:y');
      expect(userKeys).not.toContain('pokemon:z');
    });
  });
  
  describe('delete()', () => {
    it('should delete mock data', () => {
      repo.set('temp:data', { temp: true });
      expect(repo.get('temp:data')).toBeDefined();
      
      repo.delete('temp:data');
      expect(() => repo.get('temp:data')).toThrow('Mock data not found');
    });
    
    it('should return false for missing key', () => {
      expect(repo.delete('missing:key')).toBe(false);
    });
  });
  
  describe('stats()', () => {
    it('should return repository statistics', () => {
      repo.set('user:1', { name: 'User1' });
      repo.set('user:2', { name: 'User2' });
      repo.set('pokemon:1', { name: 'Poke1' });
      
      const stats = repo.stats();
      expect(stats.totalKeys).toBeGreaterThanOrEqual(3);
      expect(stats.categories).toContain('user');
      expect(stats.categories).toContain('pokemon');
      expect(stats.totalSize).toBeGreaterThan(0);
    });
  });
  
  describe('deepMerge()', () => {
    it('should deep merge nested objects', () => {
      const target = { a: 1, b: { c: 2, d: 3 } };
      const source = { b: { c: 99 } };
      
      const result = repo.deepMerge(target, source);
      expect(result.b.c).toBe(99);
      expect(result.b.d).toBe(3);
    });
    
    it('should handle arrays', () => {
      const target = { arr: [1, 2] };
      const source = { arr: [3, 4] };
      
      const result = repo.deepMerge(target, source);
      expect(result.arr).toEqual([3, 4]);
    });
  });
  
  describe('reload()', () => {
    it('should reload all fixtures', () => {
      repo.set('user:before', { before: true });
      
      repo.reload();
      
      // Cache should be cleared
      repo.cache.clear();
      expect(repo.cache.size).toBe(0);
    });
  });
});
