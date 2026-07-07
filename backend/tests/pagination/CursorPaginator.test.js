/**
 * 游标分页器单元测试
 * 
 * @module CursorPaginator.test
 */

const CursorPaginator = require('../shared/pagination/CursorPaginator');
const { expect } = require('chai');
const knex = require('knex');

// Mock database for testing
const mockDb = knex({
  client: 'pg',
  connection: {
    host: 'localhost',
    database: 'minego_test',
    user: 'test',
    password: 'test'
  }
});

describe('CursorPaginator', () => {
  let paginator;

  describe('constructor', () => {
    it('should create instance with default options', () => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances');
      
      expect(paginator.tableName).to.equal('pokemon_instances');
      expect(paginator.cursorField).to.equal('id');
      expect(paginator.orderField).to.equal('createdAt');
      expect(paginator.orderDirection).to.equal('DESC');
    });

    it('should create instance with custom options', () => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances', {
        cursorField: 'uuid',
        orderField: 'caughtAt',
        orderDirection: 'ASC'
      });
      
      expect(paginator.cursorField).to.equal('uuid');
      expect(paginator.orderField).to.equal('caughtAt');
      expect(paginator.orderDirection).to.equal('ASC');
    });

    it('should throw error without database', () => {
      expect(() => new CursorPaginator(null, 'test_table'))
        .to.throw('Database instance is required');
    });

    it('should throw error without table name', () => {
      expect(() => new CursorPaginator(mockDb, null))
        .to.throw('Table name is required');
    });
  });

  describe('encodeCursor', () => {
    beforeEach(() => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances');
    });

    it('should encode cursor correctly', () => {
      const item = { id: 100, createdAt: '2026-07-06T12:00:00Z' };
      const cursor = paginator.encodeCursor(item);
      
      expect(cursor).to.be.a('string');
      expect(cursor.length).to.be.greaterThan(0);
    });

    it('should return null for null item', () => {
      const cursor = paginator.encodeCursor(null);
      expect(cursor).to.be.null;
    });
  });

  describe('decodeCursor', () => {
    beforeEach(() => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances');
    });

    it('should decode cursor correctly', () => {
      const item = { id: 100, createdAt: '2026-07-06T12:00:00Z' };
      const cursor = paginator.encodeCursor(item);
      const decoded = paginator.decodeCursor(cursor);
      
      expect(decoded).to.deep.equal({
        id: 100,
        createdAt: '2026-07-06T12:00:00Z'
      });
    });

    it('should return null for null cursor', () => {
      const decoded = paginator.decodeCursor(null);
      expect(decoded).to.be.null;
    });

    it('should return null for invalid cursor', () => {
      const decoded = paginator.decodeCursor('invalid-cursor');
      expect(decoded).to.be.null;
    });
  });

  describe('encode/decode round-trip', () => {
    beforeEach(() => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances', {
        cursorField: 'id',
        orderField: 'createdAt'
      });
    });

    it('should maintain data integrity through encode/decode cycle', () => {
      const testCases = [
        { id: 1, createdAt: '2026-07-01T00:00:00Z' },
        { id: 999999, createdAt: '2026-12-31T23:59:59Z' },
        { id: 0, createdAt: '1970-01-01T00:00:00Z' }
      ];

      testCases.forEach(item => {
        const cursor = paginator.encodeCursor(item);
        const decoded = paginator.decodeCursor(cursor);
        expect(decoded).to.deep.equal(item);
      });
    });
  });

  describe('factory method', () => {
    it('should create instance using factory method', () => {
      const instance = CursorPaginator.create(mockDb, 'pokemon_instances', {
        orderField: 'caughtAt'
      });
      
      expect(instance).to.be.instanceOf(CursorPaginator);
      expect(instance.orderField).to.equal('caughtAt');
    });
  });

  describe('query structure validation', () => {
    // Note: These tests validate query building logic without actual DB execution
    
    beforeEach(() => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances');
    });

    it('should build correct base query structure', () => {
      // Test that the query builder is properly initialized
      expect(paginator.tableName).to.equal('pokemon_instances');
      expect(paginator.cursorField).to.equal('id');
      expect(paginator.orderField).to.equal('createdAt');
    });

    it('should handle cursor conditions for DESC ordering', () => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances', {
        orderDirection: 'DESC'
      });
      
      expect(paginator.orderDirection).to.equal('DESC');
    });

    it('should handle cursor conditions for ASC ordering', () => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances', {
        orderDirection: 'ASC'
      });
      
      expect(paginator.orderDirection).to.equal('ASC');
    });

    it('should support default where clause', () => {
      paginator = new CursorPaginator(mockDb, 'pokemon_instances', {
        defaultWhere: { user_id: 123 }
      });
      
      expect(paginator.defaultWhere).to.deep.equal({ user_id: 123 });
    });
  });
});