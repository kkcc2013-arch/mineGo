/**
 * Schema Change Analyzer - 数据库 Schema 变更解析器
 * REQ-00601: 数据库 Schema 变更智能影响分析与风险评估系统
 * 
 * 功能：
 * - 解析 PostgreSQL DDL 语句
 * - 提取变更类型和目标对象
 * - 识别变更操作（CREATE/ALTER/DROP）
 * 
 * @module backend/shared/schemaChangeAnalyzer
 * @version 1.0.0
 */

'use strict';

const logger = require('./logger');

/**
 * Schema 变更类型枚举
 */
const ChangeType = {
  CREATE_TABLE: 'CREATE_TABLE',
  DROP_TABLE: 'DROP_TABLE',
  ALTER_TABLE_ADD_COLUMN: 'ALTER_TABLE_ADD_COLUMN',
  ALTER_TABLE_DROP_COLUMN: 'ALTER_TABLE_DROP_COLUMN',
  ALTER_TABLE_MODIFY_COLUMN: 'ALTER_TABLE_MODIFY_COLUMN',
  ALTER_TABLE_RENAME_COLUMN: 'ALTER_TABLE_RENAME_COLUMN',
  ALTER_TABLE_ADD_CONSTRAINT: 'ALTER_TABLE_ADD_CONSTRAINT',
  ALTER_TABLE_DROP_CONSTRAINT: 'ALTER_TABLE_DROP_CONSTRAINT',
  ADD_INDEX: 'ADD_INDEX',
  DROP_INDEX: 'DROP_INDEX',
  ADD_UNIQUE_INDEX: 'ADD_UNIQUE_INDEX',
  CREATE_VIEW: 'CREATE_VIEW',
  DROP_VIEW: 'DROP_VIEW',
  CREATE_TRIGGER: 'CREATE_TRIGGER',
  DROP_TRIGGER: 'DROP_TRIGGER',
  CREATE_FUNCTION: 'CREATE_FUNCTION',
  DROP_FUNCTION: 'DROP_FUNCTION',
  UNKNOWN: 'UNKNOWN'
};

/**
 * 变更类型分类
 */
const ChangeCategory = {
  DESTRUCTIVE: 'destructive',   // 数据丢失风险
  STRUCTURAL: 'structural',     // 结构变更
  PERFORMANCE: 'performance',  // 性能相关
  SAFE: 'safe'                  // 安全变更
};

/**
 * Schema 变更解析器
 */
class SchemaChangeAnalyzer {
  constructor(options = {}) {
    this.options = {
      strictMode: options.strictMode || false,
      ...options
    };
    
    this.stats = {
      totalAnalyzed: 0,
      successfulParses: 0,
      failedParses: 0
    };
  }

  /**
   * 解析迁移文件内容
   * @param {string} migrationSql - 迁移 SQL 内容
   * @returns {SchemaChange[]} - 变更列表
   */
  parseMigration(migrationSql) {
    if (!migrationSql || typeof migrationSql !== 'string') {
      return [];
    }

    this.stats.totalAnalyzed++;
    
    // 移除注释
    const cleanSql = this.removeComments(migrationSql);
    
    // 分割语句
    const statements = this.splitStatements(cleanSql);
    
    // 解析每个语句
    const changes = [];
    for (const stmt of statements) {
      try {
        const change = this.parseStatement(stmt.trim());
        if (change && change.type !== ChangeType.UNKNOWN) {
          changes.push(change);
          this.stats.successfulParses++;
        }
      } catch (error) {
        logger.warn('Failed to parse statement', { 
          statement: stmt.substring(0, 100),
          error: error.message 
        });
        this.stats.failedParses++;
        
        if (this.options.strictMode) {
          throw error;
        }
      }
    }
    
    return changes;
  }

  /**
   * 解析单个 SQL 语句
   * @param {string} statement - SQL 语句
   * @returns {SchemaChange|null}
   */
  parseStatement(statement) {
    if (!statement || statement.length === 0) {
      return null;
    }

    const upperStmt = statement.toUpperCase();
    
    // CREATE TABLE
    if (upperStmt.startsWith('CREATE TABLE')) {
      return this.parseCreateTable(statement);
    }
    
    // DROP TABLE
    if (upperStmt.startsWith('DROP TABLE')) {
      return this.parseDropTable(statement);
    }
    
    // ALTER TABLE
    if (upperStmt.startsWith('ALTER TABLE')) {
      return this.parseAlterTable(statement);
    }
    
    // CREATE INDEX
    if (upperStmt.startsWith('CREATE INDEX')) {
      return this.parseCreateIndex(statement);
    }
    
    // CREATE UNIQUE INDEX
    if (upperStmt.startsWith('CREATE UNIQUE INDEX')) {
      return this.parseCreateUniqueIndex(statement);
    }
    
    // DROP INDEX
    if (upperStmt.startsWith('DROP INDEX')) {
      return this.parseDropIndex(statement);
    }
    
    // CREATE VIEW
    if (upperStmt.startsWith('CREATE VIEW') || upperStmt.startsWith('CREATE OR REPLACE VIEW')) {
      return this.parseCreateView(statement);
    }
    
    // DROP VIEW
    if (upperStmt.startsWith('DROP VIEW')) {
      return this.parseDropView(statement);
    }
    
    // CREATE TRIGGER
    if (upperStmt.startsWith('CREATE TRIGGER')) {
      return this.parseCreateTrigger(statement);
    }
    
    // CREATE FUNCTION
    if (upperStmt.startsWith('CREATE FUNCTION') || upperStmt.startsWith('CREATE OR REPLACE FUNCTION')) {
      return this.parseCreateFunction(statement);
    }

    return { type: ChangeType.UNKNOWN, statement };
  }

  /**
   * 解析 CREATE TABLE
   */
  parseCreateTable(statement) {
    const match = statement.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/i);
    if (!match) return null;

    const tableName = this.normalizeIdentifier(match[1]);
    const columns = this.extractColumns(statement);

    return {
      type: ChangeType.CREATE_TABLE,
      category: ChangeCategory.SAFE,
      objectType: 'table',
      objectName: tableName,
      schema: this.extractSchema(tableName),
      details: {
        columns,
        constraints: this.extractConstraints(statement)
      },
      statement,
      isReversible: true,
      rollbackStatement: `DROP TABLE IF EXISTS ${tableName};`
    };
  }

  /**
   * 解析 DROP TABLE
   */
  parseDropTable(statement) {
    const match = statement.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i);
    if (!match) return null;

    const tableName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.DROP_TABLE,
      category: ChangeCategory.DESTRUCTIVE,
      objectType: 'table',
      objectName: tableName,
      schema: this.extractSchema(tableName),
      details: {},
      statement,
      isReversible: false, // 需要备份才能恢复
      rollbackStatement: null,
      warning: 'This operation will permanently delete all data in the table'
    };
  }

  /**
   * 解析 ALTER TABLE
   */
  parseAlterTable(statement) {
    const tableMatch = statement.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s]+)\s+(.*)$/is);
    if (!tableMatch) return null;

    const tableName = this.normalizeIdentifier(tableMatch[1]);
    const alterAction = tableMatch[2].trim().toUpperCase();

    // ADD COLUMN
    if (alterAction.startsWith('ADD COLUMN') || alterAction.startsWith('ADD')) {
      return this.parseAddColumn(tableName, statement, alterAction);
    }
    
    // DROP COLUMN
    if (alterAction.startsWith('DROP COLUMN') || alterAction.startsWith('DROP')) {
      return this.parseDropColumn(tableName, statement, alterAction);
    }
    
    // ALTER COLUMN (类型修改)
    if (alterAction.startsWith('ALTER COLUMN')) {
      return this.parseModifyColumn(tableName, statement, alterAction);
    }
    
    // RENAME COLUMN
    if (alterAction.includes('RENAME COLUMN')) {
      return this.parseRenameColumn(tableName, statement, alterAction);
    }
    
    // ADD CONSTRAINT
    if (alterAction.startsWith('ADD CONSTRAINT')) {
      return this.parseAddConstraint(tableName, statement, alterAction);
    }
    
    // DROP CONSTRAINT
    if (alterAction.startsWith('DROP CONSTRAINT')) {
      return this.parseDropConstraint(tableName, statement, alterAction);
    }

    return {
      type: ChangeType.UNKNOWN,
      objectType: 'table',
      objectName: tableName,
      statement
    };
  }

  /**
   * 解析 ADD COLUMN
   */
  parseAddColumn(tableName, statement, alterAction) {
    const match = alterAction.match(/ADD\s+(?:COLUMN\s+)?([^\s]+)\s+([^\s,]+)(.*)$/is);
    if (!match) return null;

    const columnName = this.normalizeIdentifier(match[1]);
    const dataType = match[2];
    const constraints = match[3].trim();

    const isNotNull = constraints.toUpperCase().includes('NOT NULL');
    const hasDefault = constraints.toUpperCase().includes('DEFAULT');

    return {
      type: ChangeType.ALTER_TABLE_ADD_COLUMN,
      category: (isNotNull && !hasDefault) ? ChangeCategory.STRUCTURAL : ChangeCategory.SAFE,
      objectType: 'column',
      objectName: columnName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {
        dataType,
        constraints,
        isNotNull,
        hasDefault
      },
      statement,
      isReversible: true,
      rollbackStatement: `ALTER TABLE ${tableName} DROP COLUMN IF EXISTS ${columnName};`,
      warning: isNotNull && !hasDefault ? 
        'Adding NOT NULL column without default may fail for non-empty tables' : null
    };
  }

  /**
   * 解析 DROP COLUMN
   */
  parseDropColumn(tableName, statement, alterAction) {
    const match = alterAction.match(/DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([^\s,;]+)/i);
    if (!match) return null;

    const columnName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.ALTER_TABLE_DROP_COLUMN,
      category: ChangeCategory.DESTRUCTIVE,
      objectType: 'column',
      objectName: columnName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {},
      statement,
      isReversible: false,
      rollbackStatement: null,
      warning: 'This operation will permanently delete all data in this column'
    };
  }

  /**
   * 解析 MODIFY COLUMN
   */
  parseModifyColumn(tableName, statement, alterAction) {
    const match = alterAction.match(/ALTER\s+COLUMN\s+([^\s]+)\s+TYPE\s+([^\s,]+)/i);
    if (!match) return null;

    const columnName = this.normalizeIdentifier(match[1]);
    const newType = match[2];

    return {
      type: ChangeType.ALTER_TABLE_MODIFY_COLUMN,
      category: ChangeCategory.DESTRUCTIVE,
      objectType: 'column',
      objectName: columnName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {
        newType,
        oldType: 'unknown' // 需要从数据库获取
      },
      statement,
      isReversible: true, // 可以回滚，但可能丢失精度
      rollbackStatement: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE <old_type>;`,
      warning: 'Type modification may cause data truncation or conversion errors'
    };
  }

  /**
   * 解析 RENAME COLUMN
   */
  parseRenameColumn(tableName, statement, alterAction) {
    const match = alterAction.match(/RENAME\s+COLUMN\s+([^\s]+)\s+TO\s+([^\s;]+)/i);
    if (!match) return null;

    const oldName = this.normalizeIdentifier(match[1]);
    const newName = this.normalizeIdentifier(match[2]);

    return {
      type: ChangeType.ALTER_TABLE_RENAME_COLUMN,
      category: ChangeCategory.STRUCTURAL,
      objectType: 'column',
      objectName: oldName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {
        oldName,
        newName
      },
      statement,
      isReversible: true,
      rollbackStatement: `ALTER TABLE ${tableName} RENAME COLUMN ${newName} TO ${oldName};`
    };
  }

  /**
   * 解析 ADD CONSTRAINT
   */
  parseAddConstraint(tableName, statement, alterAction) {
    const match = alterAction.match(/ADD\s+CONSTRAINT\s+([^\s]+)\s+(.*)$/is);
    if (!match) return null;

    const constraintName = this.normalizeIdentifier(match[1]);
    const constraintDef = match[2].trim();

    // 判断约束类型
    let constraintType = 'unknown';
    if (constraintDef.toUpperCase().startsWith('PRIMARY KEY')) {
      constraintType = 'PRIMARY KEY';
    } else if (constraintDef.toUpperCase().startsWith('FOREIGN KEY')) {
      constraintType = 'FOREIGN KEY';
    } else if (constraintDef.toUpperCase().startsWith('UNIQUE')) {
      constraintType = 'UNIQUE';
    } else if (constraintDef.toUpperCase().startsWith('CHECK')) {
      constraintType = 'CHECK';
    }

    return {
      type: ChangeType.ALTER_TABLE_ADD_CONSTRAINT,
      category: constraintType === 'FOREIGN KEY' ? ChangeCategory.STRUCTURAL : ChangeCategory.SAFE,
      objectType: 'constraint',
      objectName: constraintName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {
        constraintType,
        constraintDef
      },
      statement,
      isReversible: true,
      rollbackStatement: `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${constraintName};`,
      warning: constraintType === 'FOREIGN KEY' ? 
        'Adding foreign key constraint may fail if referential integrity is violated' : null
    };
  }

  /**
   * 解析 DROP CONSTRAINT
   */
  parseDropConstraint(tableName, statement, alterAction) {
    const match = alterAction.match(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i);
    if (!match) return null;

    const constraintName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.ALTER_TABLE_DROP_CONSTRAINT,
      category: ChangeCategory.STRUCTURAL,
      objectType: 'constraint',
      objectName: constraintName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {},
      statement,
      isReversible: true,
      rollbackStatement: `-- Need original constraint definition to restore`
    };
  }

  /**
   * 解析 CREATE INDEX
   */
  parseCreateIndex(statement) {
    const match = statement.match(/CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s]+)\s+ON\s+([^\s(]+)/i);
    if (!match) return null;

    const indexName = this.normalizeIdentifier(match[1]);
    const tableName = this.normalizeIdentifier(match[2]);
    const columns = this.extractIndexColumns(statement);

    return {
      type: ChangeType.ADD_INDEX,
      category: ChangeCategory.PERFORMANCE,
      objectType: 'index',
      objectName: indexName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {
        columns,
        isUnique: false
      },
      statement,
      isReversible: true,
      rollbackStatement: `DROP INDEX IF EXISTS ${indexName};`
    };
  }

  /**
   * 解析 CREATE UNIQUE INDEX
   */
  parseCreateUniqueIndex(statement) {
    const match = statement.match(/CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s]+)\s+ON\s+([^\s(]+)/i);
    if (!match) return null;

    const indexName = this.normalizeIdentifier(match[1]);
    const tableName = this.normalizeIdentifier(match[2]);
    const columns = this.extractIndexColumns(statement);

    return {
      type: ChangeType.ADD_UNIQUE_INDEX,
      category: ChangeCategory.PERFORMANCE,
      objectType: 'index',
      objectName: indexName,
      tableName,
      schema: this.extractSchema(tableName),
      details: {
        columns,
        isUnique: true
      },
      statement,
      isReversible: true,
      rollbackStatement: `DROP INDEX IF EXISTS ${indexName};`,
      warning: 'Creating unique index may fail if duplicates exist'
    };
  }

  /**
   * 解析 DROP INDEX
   */
  parseDropIndex(statement) {
    const match = statement.match(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i);
    if (!match) return null;

    const indexName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.DROP_INDEX,
      category: ChangeCategory.PERFORMANCE,
      objectType: 'index',
      objectName: indexName,
      schema: 'public',
      details: {},
      statement,
      isReversible: false, // 需要 index 定义才能恢复
      rollbackStatement: null,
      warning: 'Dropping index may impact query performance'
    };
  }

  /**
   * 解析 CREATE VIEW
   */
  parseCreateView(statement) {
    const match = statement.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([^\s]+)\s+AS\s+(.*)$/is);
    if (!match) return null;

    const viewName = this.normalizeIdentifier(match[1]);
    const viewDef = match[2].trim();

    return {
      type: ChangeType.CREATE_VIEW,
      category: ChangeCategory.SAFE,
      objectType: 'view',
      objectName: viewName,
      schema: this.extractSchema(viewName),
      details: {
        definition: viewDef
      },
      statement,
      isReversible: true,
      rollbackStatement: `DROP VIEW IF EXISTS ${viewName};`
    };
  }

  /**
   * 解析 DROP VIEW
   */
  parseDropView(statement) {
    const match = statement.match(/DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/i);
    if (!match) return null;

    const viewName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.DROP_VIEW,
      category: ChangeCategory.STRUCTURAL,
      objectType: 'view',
      objectName: viewName,
      schema: this.extractSchema(viewName),
      details: {},
      statement,
      isReversible: false,
      rollbackStatement: null
    };
  }

  /**
   * 解析 CREATE TRIGGER
   */
  parseCreateTrigger(statement) {
    const match = statement.match(/CREATE\s+TRIGGER\s+([^\s]+)/i);
    if (!match) return null;

    const triggerName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.CREATE_TRIGGER,
      category: ChangeCategory.STRUCTURAL,
      objectType: 'trigger',
      objectName: triggerName,
      schema: 'public',
      details: {},
      statement,
      isReversible: true,
      rollbackStatement: `DROP TRIGGER IF EXISTS ${triggerName} ON <table>;`
    };
  }

  /**
   * 解析 CREATE FUNCTION
   */
  parseCreateFunction(statement) {
    const match = statement.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([^\s(]+)/i);
    if (!match) return null;

    const funcName = this.normalizeIdentifier(match[1]);

    return {
      type: ChangeType.CREATE_FUNCTION,
      category: ChangeCategory.SAFE,
      objectType: 'function',
      objectName: funcName,
      schema: this.extractSchema(funcName),
      details: {},
      statement,
      isReversible: true,
      rollbackStatement: `DROP FUNCTION IF EXISTS ${funcName};`
    };
  }

  /**
   * 移除 SQL 注释
   */
  removeComments(sql) {
    // 移除单行注释
    sql = sql.replace(/--[^\n]*/g, '');
    // 移除多行注释
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    return sql;
  }

  /**
   * 分割 SQL 语句
   */
  splitStatements(sql) {
    // 简单按分号分割（不处理函数/存储过程中的分号）
    return sql.split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /**
   * 规范化标识符（移除引号）
   */
  normalizeIdentifier(identifier) {
    if (!identifier) return '';
    return identifier.replace(/^["']|["']$/g, '').toLowerCase();
  }

  /**
   * 提取 schema
   */
  extractSchema(objectName) {
    if (!objectName) return 'public';
    if (objectName.includes('.')) {
      return objectName.split('.')[0];
    }
    return 'public';
  }

  /**
   * 提取列定义
   */
  extractColumns(statement) {
    const match = statement.match(/\(([\s\S]*)\)/);
    if (!match) return [];

    const columnsStr = match[1];
    const columns = [];
    
    // 简单解析（不处理嵌套括号）
    const parts = columnsStr.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        const colMatch = trimmed.match(/^([^\s]+)/);
        if (colMatch) {
          columns.push({
            name: this.normalizeIdentifier(colMatch[1]),
            definition: trimmed
          });
        }
      }
    }

    return columns;
  }

  /**
   * 提取约束
   */
  extractConstraints(statement) {
    const upperStatement = statement.toUpperCase();
    const constraints = [];

    if (upperStatement.includes('PRIMARY KEY')) {
      constraints.push({ type: 'PRIMARY KEY' });
    }
    if (upperStatement.includes('FOREIGN KEY')) {
      constraints.push({ type: 'FOREIGN KEY' });
    }
    if (upperStatement.includes('UNIQUE')) {
      constraints.push({ type: 'UNIQUE' });
    }
    if (upperStatement.includes('CHECK')) {
      constraints.push({ type: 'CHECK' });
    }

    return constraints;
  }

  /**
   * 提取索引列
   */
  extractIndexColumns(statement) {
    const match = statement.match(/\(([^)]+)\)/);
    if (!match) return [];

    return match[1].split(',')
      .map(col => this.normalizeIdentifier(col.trim()))
      .filter(col => col.length > 0);
  }

  /**
   * 获取解析统计
   */
  getStats() {
    return { ...this.stats };
  }
}

module.exports = {
  SchemaChangeAnalyzer,
  ChangeType,
  ChangeCategory
};
