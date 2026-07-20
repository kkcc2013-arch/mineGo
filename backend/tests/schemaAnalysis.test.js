/**
 * REQ-00601: 数据库 Schema 变更智能影响分析与风险评估系统
 * 单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const {
  SchemaChangeAnalyzer,
  ChangeType,
  ChangeCategory
} = require('../shared/schemaChangeAnalyzer');
const {
  SchemaImpactAnalyzer,
  ImpactLevel,
  ImpactType
} = require('../shared/schemaImpactAnalyzer');
const {
  SchemaRiskAssessor,
  RiskLevel,
  RiskFactor
} = require('../shared/schemaRiskAssessor');

describe('REQ-00601: Schema Change Analysis System', () => {
  describe('SchemaChangeAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
      analyzer = new SchemaChangeAnalyzer();
    });

    describe('parseMigration', () => {
      it('should parse CREATE TABLE statement', () => {
        const sql = `
          CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(255) UNIQUE
          );
        `;

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.CREATE_TABLE);
        expect(changes[0].objectName).to.equal('users');
        expect(changes[0].category).to.equal(ChangeCategory.SAFE);
        expect(changes[0].isReversible).to.be.true;
        expect(changes[0].rollbackStatement).to.include('DROP TABLE');
      });

      it('should parse DROP TABLE statement', () => {
        const sql = 'DROP TABLE IF EXISTS old_data;';

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.DROP_TABLE);
        expect(changes[0].objectName).to.equal('old_data');
        expect(changes[0].category).to.equal(ChangeCategory.DESTRUCTIVE);
        expect(changes[0].isReversible).to.be.false;
        expect(changes[0].warning).to.include('permanently delete');
      });

      it('should parse ALTER TABLE ADD COLUMN statement', () => {
        const sql = 'ALTER TABLE users ADD COLUMN age INTEGER DEFAULT 0;';

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.ALTER_TABLE_ADD_COLUMN);
        expect(changes[0].objectName).to.equal('age');
        expect(changes[0].tableName).to.equal('users');
        expect(changes[0].isReversible).to.be.true;
      });

      it('should parse ALTER TABLE DROP COLUMN statement', () => {
        const sql = 'ALTER TABLE users DROP COLUMN IF EXISTS old_field;';

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.ALTER_TABLE_DROP_COLUMN);
        expect(changes[0].category).to.equal(ChangeCategory.DESTRUCTIVE);
        expect(changes[0].isReversible).to.be.false;
      });

      it('should parse CREATE INDEX statement', () => {
        const sql = 'CREATE INDEX idx_users_email ON users(email);';

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.ADD_INDEX);
        expect(changes[0].objectName).to.equal('idx_users_email');
        expect(changes[0].tableName).to.equal('users');
        expect(changes[0].details.columns).to.include('email');
      });

      it('should parse CREATE UNIQUE INDEX statement', () => {
        const sql = 'CREATE UNIQUE INDEX idx_users_username ON users(username);';

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.ADD_UNIQUE_INDEX);
        expect(changes[0].details.isUnique).to.be.true;
        expect(changes[0].warning).to.include('duplicates exist');
      });

      it('should parse DROP INDEX statement', () => {
        const sql = 'DROP INDEX IF EXISTS idx_old;';

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.DROP_INDEX);
        expect(changes[0].category).to.equal(ChangeCategory.PERFORMANCE);
      });

      it('should parse ALTER TABLE ADD CONSTRAINT (FOREIGN KEY)', () => {
        const sql = `
          ALTER TABLE orders
          ADD CONSTRAINT fk_user_id
          FOREIGN KEY (user_id) REFERENCES users(id);
        `;

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.ALTER_TABLE_ADD_CONSTRAINT);
        expect(changes[0].details.constraintType).to.equal('FOREIGN KEY');
        expect(changes[0].category).to.equal(ChangeCategory.STRUCTURAL);
      });

      it('should parse ALTER TABLE ADD CONSTRAINT (CHECK)', () => {
        const sql = `
          ALTER TABLE products
          ADD CONSTRAINT chk_price
          CHECK (price > 0);
        `;

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].details.constraintType).to.equal('CHECK');
      });

      it('should parse CREATE VIEW statement', () => {
        const sql = `
          CREATE VIEW active_users AS
          SELECT id, name FROM users WHERE active = true;
        `;

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.CREATE_VIEW);
        expect(changes[0].objectName).to.equal('active_users');
        expect(changes[0].category).to.equal(ChangeCategory.SAFE);
      });

      it('should parse multiple statements', () => {
        const sql = `
          CREATE TABLE posts (id SERIAL, title VARCHAR(200));
          CREATE INDEX idx_posts_title ON posts(title);
          ALTER TABLE posts ADD COLUMN content TEXT;
        `;

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(3);
        expect(changes[0].type).to.equal(ChangeType.CREATE_TABLE);
        expect(changes[1].type).to.equal(ChangeType.ADD_INDEX);
        expect(changes[2].type).to.equal(ChangeType.ALTER_TABLE_ADD_COLUMN);
      });

      it('should handle empty input', () => {
        expect(analyzer.parseMigration('')).to.deep.equal([]);
        expect(analyzer.parseMigration(null)).to.deep.equal([]);
        expect(analyzer.parseMigration('   ')).to.deep.equal([]);
      });

      it('should remove comments', () => {
        const sql = `
          -- This is a comment
          CREATE TABLE test (id INT);
          /* Multi-line
             comment */
        `;

        const changes = analyzer.parseMigration(sql);

        expect(changes).to.have.lengthOf(1);
        expect(changes[0].type).to.equal(ChangeType.CREATE_TABLE);
      });

      it('should detect NOT NULL constraint without DEFAULT as high risk', () => {
        const sql = 'ALTER TABLE users ADD COLUMN phone VARCHAR(20) NOT NULL;';

        const changes = analyzer.parseMigration(sql);

        expect(changes[0].category).to.equal(ChangeCategory.STRUCTURAL);
        expect(changes[0].warning).to.include('may fail');
      });
    });

    describe('getStats', () => {
      it('should return parsing statistics', () => {
        analyzer.parseMigration('CREATE TABLE test (id INT);');
        analyzer.parseMigration('DROP TABLE test;');

        const stats = analyzer.getStats();

        expect(stats.totalAnalyzed).to.equal(2);
        expect(stats.successfulParses).to.equal(2);
      });
    });
  });

  describe('SchemaImpactAnalyzer', () => {
    let analyzer;
    let mockDbPool;

    beforeEach(() => {
      mockDbPool = {
        query: sinon.stub().resolves({ rows: [] })
      };
      analyzer = new SchemaImpactAnalyzer({ dbPool: mockDbPool });
    });

    describe('analyzeImpact', () => {
      it('should return empty analysis for no changes', async () => {
        const analysis = await analyzer.analyzeImpact([]);

        expect(analysis.totalChanges).to.equal(0);
        expect(analysis.riskLevel).to.equal(ImpactLevel.LOW);
        expect(analysis.directImpact).to.deep.equal([]);
      });

      it('should analyze DROP TABLE as critical', async () => {
        const changes = [{
          type: ChangeType.DROP_TABLE,
          objectName: 'users',
          objectType: 'table',
          tableName: null,
          details: {},
          isReversible: false
        }];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.directImpact).to.have.lengthOf(1);
        expect(analysis.directImpact[0].type).to.equal(ImpactType.DATA_LOSS);
        expect(analysis.directImpact[0].level).to.equal(ImpactLevel.CRITICAL);
      });

      it('should analyze DROP COLUMN as critical', async () => {
        const changes = [{
          type: ChangeType.ALTER_TABLE_DROP_COLUMN,
          objectName: 'email',
          objectType: 'column',
          tableName: 'users',
          details: {},
          isReversible: false
        }];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.directImpact[0].type).to.equal(ImpactType.DATA_LOSS);
        expect(analysis.directImpact[0].level).to.equal(ImpactLevel.CRITICAL);
      });

      it('should analyze DROP INDEX as performance impact', async () => {
        const changes = [{
          type: ChangeType.DROP_INDEX,
          objectName: 'idx_users_email',
          objectType: 'index',
          tableName: null,
          details: {},
          isReversible: false
        }];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.directImpact[0].type).to.equal(ImpactType.PERFORMANCE);
        expect(analysis.directImpact[0].level).to.equal(ImpactLevel.MEDIUM);
      });

      it('should estimate execution time', async () => {
        const changes = [
          { type: ChangeType.CREATE_TABLE, objectName: 'test' },
          { type: ChangeType.ADD_INDEX, objectName: 'idx' }
        ];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.estimatedExecutionTime).to.be.a('number');
        expect(analysis.estimatedExecutionTime).to.be.greaterThan(0);
      });

      it('should calculate rollback complexity', async () => {
        const changes = [
          { type: ChangeType.DROP_TABLE, objectName: 'test', isReversible: false }
        ];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.rollbackComplexity).to.equal('complex');
      });

      it('should generate recommendations', async () => {
        const changes = [{
          type: ChangeType.DROP_TABLE,
          objectName: 'users',
          objectType: 'table',
          tableName: null,
          details: {},
          isReversible: false
        }];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.recommendations).to.have.length.greaterThan(0);
        expect(analysis.recommendations[0].action).to.equal('Backup data');
      });

      it('should query dependent views', async () => {
        mockDbPool.query.resolves({
          rows: [
            { viewname: 'active_users', definition: 'SELECT * FROM users' }
          ]
        });

        const changes = [{
          type: ChangeType.ALTER_TABLE_DROP_COLUMN,
          objectName: 'email',
          objectType: 'column',
          tableName: 'users',
          details: {},
          isReversible: false
        }];

        const analysis = await analyzer.analyzeImpact(changes);

        expect(analysis.indirectImpact.length).to.be.greaterThan(0);
      });
    });
  });

  describe('SchemaRiskAssessor', () => {
    let assessor;
    let mockImpactAnalysis;

    beforeEach(() => {
      assessor = new SchemaRiskAssessor();
      mockImpactAnalysis = {
        directImpact: [],
        indirectImpact: [],
        affectedQueries: [],
        affectedServices: []
      };
    });

    describe('assessRisk', () => {
      it('should assess DROP_TABLE as critical risk', () => {
        const changes = [{
          type: ChangeType.DROP_TABLE,
          objectName: 'users',
          objectType: 'table',
          isReversible: false,
          details: {}
        }];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.overallRisk).to.equal(RiskLevel.CRITICAL);
        expect(assessment.riskScore).to.be.greaterThan(80);
        expect(assessment.blockers).to.have.length.greaterThan(0);
        expect(assessment.canProceed).to.be.false;
      });

      it('should assess CREATE_TABLE as low risk', () => {
        const changes = [{
          type: ChangeType.CREATE_TABLE,
          objectName: 'new_table',
          objectType: 'table',
          isReversible: true,
          rollbackStatement: 'DROP TABLE new_table;',
          details: {}
        }];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.overallRisk).to.equal(RiskLevel.LOW);
        expect(assessment.canProceed).to.be.true;
        expect(assessment.requiresApproval).to.be.false;
      });

      it('should assess ADD_INDEX as low risk', () => {
        const changes = [{
          type: ChangeType.ADD_INDEX,
          objectName: 'idx_test',
          objectType: 'index',
          tableName: 'test',
          isReversible: true,
          rollbackStatement: 'DROP INDEX idx_test;',
          details: { columns: ['id'] }
        }];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.overallRisk).to.equal(RiskLevel.LOW);
      });

      it('should assess DROP_COLUMN as critical risk', () => {
        const changes = [{
          type: ChangeType.ALTER_TABLE_DROP_COLUMN,
          objectName: 'email',
          objectType: 'column',
          tableName: 'users',
          isReversible: false,
          details: {}
        }];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.overallRisk).to.equal(RiskLevel.CRITICAL);
        expect(assessment.riskFactors).to.include.deep.members([
          { factor: RiskFactor.IRREVERSIBLE, count: 1 }
        ]);
      });

      it('should require approval for high risk changes', () => {
        const changes = [{
          type: ChangeType.ALTER_TABLE_MODIFY_COLUMN,
          objectName: 'age',
          objectType: 'column',
          tableName: 'users',
          isReversible: true,
          details: { newType: 'BIGINT', oldType: 'INTEGER' }
        }];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.requiresApproval).to.be.true;
      });

      it('should generate warnings for NOT NULL without DEFAULT', () => {
        const changes = [{
          type: ChangeType.ALTER_TABLE_ADD_COLUMN,
          objectName: 'phone',
          objectType: 'column',
          tableName: 'users',
          isReversible: true,
          details: { isNotNull: true, hasDefault: false }
        }];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.warnings.length).to.be.greaterThan(0);
      });

      it('should calculate risk score correctly', () => {
        const changes = [
          { type: ChangeType.CREATE_TABLE, objectName: 't1', objectType: 'table', isReversible: true, details: {} },
          { type: ChangeType.ADD_INDEX, objectName: 'idx1', objectType: 'index', tableName: 't1', isReversible: true, details: {} }
        ];

        const assessment = assessor.assessRisk(changes, mockImpactAnalysis);

        expect(assessment.riskScore).to.be.a('number');
        expect(assessment.riskScore).to.be.greaterThan(0);
        expect(assessment.riskScore).to.be.lessThan(100);
      });

      it('should track statistics', () => {
        assessor.assessRisk([{ type: ChangeType.CREATE_TABLE, objectName: 't1', objectType: 'table', isReversible: true, details: {} }], mockImpactAnalysis);
        assessor.assessRisk([{ type: ChangeType.DROP_TABLE, objectName: 't2', objectType: 'table', isReversible: false, details: {} }], mockImpactAnalysis);

        const stats = assessor.getStats();

        expect(stats.totalAssessments).to.equal(2);
        expect(stats.riskDistribution[RiskLevel.LOW]).to.equal(1);
        expect(stats.riskDistribution[RiskLevel.CRITICAL]).to.equal(1);
      });
    });
  });

  describe('Integration Tests', () => {
    it('should analyze and assess a complete migration', () => {
      const analyzer = new SchemaChangeAnalyzer();
      const assessor = new SchemaRiskAssessor();

      const sql = `
        -- Migration: Add orders table
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          total DECIMAL(10, 2) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        
        CREATE INDEX idx_orders_user ON orders(user_id);
        CREATE INDEX idx_orders_created ON orders(created_at);
        
        ALTER TABLE users ADD COLUMN last_order_id INTEGER;
      `;

      // 解析变更
      const changes = analyzer.parseMigration(sql);
      expect(changes).to.have.lengthOf(3);

      // 评估风险
      const mockImpact = {
        directImpact: [],
        indirectImpact: [],
        affectedQueries: [],
        affectedServices: []
      };
      const assessment = assessor.assessRisk(changes, mockImpact);

      expect(assessment.overallRisk).to.equal(RiskLevel.LOW);
      expect(assessment.canProceed).to.be.true;
      expect(assessment.changeRisks).to.have.lengthOf(3);
    });

    it('should detect critical risk migration', () => {
      const analyzer = new SchemaChangeAnalyzer();
      const assessor = new SchemaRiskAssessor();

      const sql = `
        DROP TABLE IF EXISTS legacy_data;
        ALTER TABLE users DROP COLUMN deprecated_field;
        DROP INDEX idx_old;
      `;

      const changes = analyzer.parseMigration(sql);
      const mockImpact = {
        directImpact: [],
        indirectImpact: [],
        affectedQueries: [],
        affectedServices: []
      };
      const assessment = assessor.assessRisk(changes, mockImpact);

      expect(assessment.overallRisk).to.equal(RiskLevel.CRITICAL);
      expect(assessment.canProceed).to.be.false;
      expect(assessment.blockers.length).to.be.greaterThan(0);
    });
  });
});