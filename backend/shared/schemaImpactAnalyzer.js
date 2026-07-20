/**
 * Schema Impact Analyzer - 数据库 Schema 变更影响分析器
 * REQ-00601: 数据库 Schema 变更智能影响分析与风险评估系统
 * 
 * 功能：
 * - 分析变更对视图、触发器、存储过程的影响
 * - 查询应用代码中的影响
 * - 生成影响分析报告
 * 
 * @module backend/shared/schemaImpactAnalyzer
 * @version 1.0.0
 */

'use strict';

const logger = require('./logger');

/**
 * 影响级别
 */
const ImpactLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * 影响类型
 */
const ImpactType = {
  DATA_LOSS: 'data_loss',
  PERFORMANCE: 'performance',
  AVAILABILITY: 'availability',
  COMPATIBILITY: 'compatibility',
  INTEGRITY: 'integrity'
};

/**
 * Schema 影响分析器
 */
class SchemaImpactAnalyzer {
  constructor(options = {}) {
    this.options = {
      dbPool: options.dbPool || null,
      analyzeCodeImpact: options.analyzeCodeImpact || true,
      ...options
    };
    
    this.dbPool = options.dbPool;
  }

  /**
   * 分析 schema 变更的影响范围
   * @param {SchemaChange[]} changes - 变更列表
   * @returns {ImpactAnalysis}
   */
  async analyzeImpact(changes) {
    if (!changes || changes.length === 0) {
      return this.createEmptyAnalysis();
    }

    const analysis = {
      timestamp: new Date().toISOString(),
      totalChanges: changes.length,
      directImpact: [],
      indirectImpact: [],
      affectedQueries: [],
      affectedServices: [],
      riskLevel: ImpactLevel.LOW,
      estimatedExecutionTime: 0,
      rollbackComplexity: 'simple',
      summary: '',
      recommendations: []
    };

    // 分析每个变更
    for (const change of changes) {
      await this.analyzeChange(change, analysis);
    }

    // 计算综合风险
    analysis.riskLevel = this.calculateOverallRisk(analysis);
    
    // 估算执行时间
    analysis.estimatedExecutionTime = await this.estimateExecutionTime(changes);
    
    // 计算回滚复杂度
    analysis.rollbackComplexity = this.calculateRollbackComplexity(changes);
    
    // 生成摘要和建议
    analysis.summary = this.generateSummary(analysis);
    analysis.recommendations = this.generateRecommendations(analysis);

    return analysis;
  }

  /**
   * 分析单个变更
   */
  async analyzeChange(change, analysis) {
    const directImpact = this.analyzeDirectImpact(change);
    const indirectImpact = await this.analyzeIndirectImpact(change);
    
    analysis.directImpact.push(...directImpact);
    analysis.indirectImpact.push(...indirectImpact);
    
    // 分析查询影响
    const queryImpact = await this.analyzeQueryImpact(change);
    analysis.affectedQueries.push(...queryImpact);
    
    // 分析应用代码影响
    if (this.options.analyzeCodeImpact) {
      const codeImpact = await this.analyzeCodeImpact(change);
      analysis.affectedServices.push(...codeImpact);
    }
  }

  /**
   * 分析直接影响
   */
  analyzeDirectImpact(change) {
    const impacts = [];

    switch (change.type) {
      case 'DROP_TABLE':
        impacts.push({
          type: ImpactType.DATA_LOSS,
          object: change.objectName,
          objectType: 'table',
          description: `Table '${change.objectName}' will be dropped, all data will be lost`,
          level: ImpactLevel.CRITICAL
        });
        break;

      case 'ALTER_TABLE_DROP_COLUMN':
        impacts.push({
          type: ImpactType.DATA_LOSS,
          object: `${change.tableName}.${change.objectName}`,
          objectType: 'column',
          description: `Column '${change.objectName}' will be dropped, all data in this column will be lost`,
          level: ImpactLevel.CRITICAL
        });
        break;

      case 'ALTER_TABLE_MODIFY_COLUMN':
        impacts.push({
          type: ImpactType.DATA_LOSS,
          object: `${change.tableName}.${change.objectName}`,
          objectType: 'column',
          description: `Column type change may cause data truncation or conversion errors`,
          level: ImpactLevel.HIGH
        });
        break;

      case 'DROP_INDEX':
        impacts.push({
          type: ImpactType.PERFORMANCE,
          object: change.objectName,
          objectType: 'index',
          description: `Index '${change.objectName}' will be dropped, query performance may degrade`,
          level: ImpactLevel.MEDIUM
        });
        break;

      case 'ALTER_TABLE_ADD_COLUMN':
        if (change.details?.isNotNull && !change.details?.hasDefault) {
          impacts.push({
            type: ImpactType.COMPATIBILITY,
            object: `${change.tableName}.${change.objectName}`,
            objectType: 'column',
            description: `Adding NOT NULL column without default may fail for existing rows`,
            level: ImpactLevel.MEDIUM
          });
        }
        break;

      case 'ALTER_TABLE_ADD_CONSTRAINT':
        impacts.push({
          type: ImpactType.INTEGRITY,
          object: change.objectName,
          objectType: 'constraint',
          description: `Adding constraint may fail if existing data violates constraint`,
          level: ImpactLevel.MEDIUM
        });
        break;

      case 'ADD_UNIQUE_INDEX':
        impacts.push({
          type: ImpactType.INTEGRITY,
          object: change.objectName,
          objectType: 'index',
          description: `Creating unique index will fail if duplicates exist`,
          level: ImpactLevel.MEDIUM
        });
        break;
    }

    return impacts;
  }

  /**
   * 分析间接影响（视图、触发器、存储过程）
   */
  async analyzeIndirectImpact(change) {
    const impacts = [];

    if (!this.dbPool) {
      return impacts;
    }

    try {
      // 查询依赖该对象的视图
      const views = await this.findDependentViews(change);
      for (const view of views) {
        impacts.push({
          type: ImpactType.COMPATIBILITY,
          object: view.viewname,
          objectType: 'view',
          description: `View '${view.viewname}' depends on '${change.objectName}'`,
          level: ImpactLevel.HIGH
        });
      }

      // 查询依赖该对象的触发器
      const triggers = await this.findDependentTriggers(change);
      for (const trigger of triggers) {
        impacts.push({
          type: ImpactType.COMPATIBILITY,
          object: trigger.trigger_name,
          objectType: 'trigger',
          description: `Trigger '${trigger.trigger_name}' depends on '${change.objectName}'`,
          level: ImpactLevel.MEDIUM
        });
      }

      // 查询依赖该对象的外键
      if (change.objectType === 'table') {
        const foreignKeys = await this.findDependentForeignKeys(change);
        for (const fk of foreignKeys) {
          impacts.push({
            type: ImpactType.INTEGRITY,
            object: fk.constraint_name,
            objectType: 'foreign_key',
            description: `Foreign key '${fk.constraint_name}' references '${change.objectName}'`,
            level: ImpactLevel.HIGH
          });
        }
      }
    } catch (error) {
      logger.error('Failed to analyze indirect impact', {
        change: change.objectName,
        error: error.message
      });
    }

    return impacts;
  }

  /**
   * 分析查询影响
   */
  async analyzeQueryImpact(change) {
    const impacts = [];

    if (!this.dbPool) {
      return impacts;
    }

    try {
      // 查询涉及该表的常用查询模式（从 pg_stat_statements）
      const queries = await this.findTableQueries(change);
      
      for (const query of queries) {
        impacts.push({
          type: ImpactType.PERFORMANCE,
          object: query.queryid,
          objectType: 'query',
          description: `Query uses '${change.objectName}', may be affected`,
          level: ImpactLevel.MEDIUM,
          details: {
            calls: query.calls,
            meanTime: query.mean_exec_time
          }
        });
      }
    } catch (error) {
      // pg_stat_statements 可能未安装
      logger.debug('Could not analyze query impact', { error: error.message });
    }

    return impacts;
  }

  /**
   * 分析应用代码影响
   */
  async analyzeCodeImpact(change) {
    const impacts = [];

    // 基于表名映射到服务
    const tableServiceMap = {
      'users': ['user-service', 'gateway'],
      'pokemon': ['pokemon-service', 'catch-service'],
      'gyms': ['gym-service'],
      'friendships': ['social-service'],
      'transactions': ['payment-service', 'reward-service'],
      'catches': ['catch-service'],
      'locations': ['location-service']
    };

    if (change.tableName) {
      const baseTable = change.tableName.replace(/_.+$/, '').toLowerCase();
      const services = tableServiceMap[baseTable] || [];
      
      for (const service of services) {
        impacts.push({
          type: ImpactType.COMPATIBILITY,
          object: service,
          objectType: 'service',
          description: `Service '${service}' may reference '${change.tableName}'`,
          level: ImpactLevel.MEDIUM
        });
      }
    }

    return impacts;
  }

  /**
   * 查找依赖该对象的视图
   */
  async findDependentViews(change) {
    const query = `
      SELECT DISTINCT viewname, definition
      FROM pg_views v
      JOIN pg_depend d ON d.objid = (
        SELECT oid FROM pg_class WHERE relname = v.viewname
      )
      WHERE v.schemaname = 'public'
        AND d.refobjid = (
          SELECT oid FROM pg_class 
          WHERE relname = $1 AND relkind = 'r'
        )
    `;
    
    try {
      const result = await this.dbPool.query(query, [change.objectName]);
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * 查找依赖该对象的触发器
   */
  async findDependentTriggers(change) {
    const query = `
      SELECT trigger_name, event_object_table
      FROM information_schema.triggers
      WHERE event_object_table = $1
    `;
    
    try {
      const result = await this.dbPool.query(query, [change.objectName]);
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * 查找依赖该表的外键
   */
  async findDependentForeignKeys(change) {
    const query = `
      SELECT 
        tc.constraint_name,
        tc.table_name,
        kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND kcu.table_name = $1
    `;
    
    try {
      const result = await this.dbPool.query(query, [change.objectName]);
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * 查找涉及该表的查询
   */
  async findTableQueries(change) {
    const query = `
      SELECT queryid, query, calls, mean_exec_time
      FROM pg_stat_statements
      WHERE query LIKE $1
      ORDER BY calls DESC
      LIMIT 10
    `;
    
    try {
      const result = await this.dbPool.query(query, [`%${change.objectName}%`]);
      return result.rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * 计算综合风险等级
   */
  calculateOverallRisk(analysis) {
    const levels = {
      [ImpactLevel.LOW]: 1,
      [ImpactLevel.MEDIUM]: 2,
      [ImpactLevel.HIGH]: 3,
      [ImpactLevel.CRITICAL]: 4
    };

    let maxRisk = ImpactLevel.LOW;
    let criticalCount = 0;
    let highCount = 0;

    for (const impact of [...analysis.directImpact, ...analysis.indirectImpact]) {
      const level = impact.level;
      if (levels[level] > levels[maxRisk]) {
        maxRisk = level;
      }
      if (level === ImpactLevel.CRITICAL) criticalCount++;
      if (level === ImpactLevel.HIGH) highCount++;
    }

    // 如果有多个高风险，升级风险等级
    if (criticalCount > 0) return ImpactLevel.CRITICAL;
    if (criticalCount > 1 || highCount > 3) return ImpactLevel.CRITICAL;
    if (highCount > 0) return ImpactLevel.HIGH;
    if (analysis.indirectImpact.length > 5) return ImpactLevel.HIGH;
    
    return maxRisk;
  }

  /**
   * 估算执行时间
   */
  async estimateExecutionTime(changes) {
    let totalTime = 0;

    for (const change of changes) {
      switch (change.type) {
        case 'CREATE_TABLE':
          totalTime += 100; // 100ms 创建空表
          break;
        case 'DROP_TABLE':
          totalTime += 200; // 200ms 删除表
          break;
        case 'ALTER_TABLE_ADD_COLUMN':
          totalTime += 50; // 50ms 添加列（空表）
          break;
        case 'ALTER_TABLE_DROP_COLUMN':
          totalTime += 100; // 100ms 删除列
          break;
        case 'ALTER_TABLE_MODIFY_COLUMN':
          totalTime += 5000; // 5s 修改列类型（全表扫描）
          break;
        case 'ADD_INDEX':
          totalTime += 10000; // 10s 创建索引（需要实际数据量）
          break;
        case 'DROP_INDEX':
          totalTime += 100; // 100ms 删除索引
          break;
        case 'ALTER_TABLE_ADD_CONSTRAINT':
          totalTime += 1000; // 1s 添加约束（需要验证）
          break;
        default:
          totalTime += 100;
      }
    }

    return totalTime;
  }

  /**
   * 计算回滚复杂度
   */
  calculateRollbackComplexity(changes) {
    let complexity = 0;

    for (const change of changes) {
      if (!change.isReversible) {
        complexity += 3;
      } else if (change.rollbackStatement && change.rollbackStatement.includes('<')) {
        complexity += 2; // 需要填充参数
      } else if (change.rollbackStatement) {
        complexity += 1;
      }
    }

    if (complexity >= 5) return 'complex';
    if (complexity >= 3) return 'moderate';
    return 'simple';
  }

  /**
   * 生成摘要
   */
  generateSummary(analysis) {
    const parts = [];
    
    parts.push(`Analysis of ${analysis.totalChanges} schema changes:`);
    parts.push(`- ${analysis.directImpact.length} direct impact(s)`);
    parts.push(`- ${analysis.indirectImpact.length} indirect impact(s)`);
    parts.push(`- Risk level: ${analysis.riskLevel.toUpperCase()}`);
    parts.push(`- Estimated execution time: ${analysis.estimatedExecutionTime}ms`);
    
    if (analysis.rollbackComplexity !== 'simple') {
      parts.push(`- Rollback complexity: ${analysis.rollbackComplexity}`);
    }

    return parts.join('\n');
  }

  /**
   * 生成建议
   */
  generateRecommendations(analysis) {
    const recommendations = [];

    if (analysis.riskLevel === ImpactLevel.CRITICAL) {
      recommendations.push({
        priority: 'high',
        action: 'Review and approve',
        description: 'Critical risk changes require manual review before execution'
      });
    }

    if (analysis.directImpact.some(i => i.type === ImpactType.DATA_LOSS)) {
      recommendations.push({
        priority: 'high',
        action: 'Backup data',
        description: 'Create a backup before executing destructive changes'
      });
    }

    if (analysis.indirectImpact.length > 5) {
      recommendations.push({
        priority: 'medium',
        action: 'Test dependencies',
        description: 'Multiple dependent objects require thorough testing'
      });
    }

    if (analysis.rollbackComplexity === 'complex') {
      recommendations.push({
        priority: 'medium',
        action: 'Prepare rollback script',
        description: 'Complex rollback requires manual script preparation'
      });
    }

    if (analysis.estimatedExecutionTime > 30000) {
      recommendations.push({
        priority: 'low',
        action: 'Schedule maintenance',
        description: 'Long execution time, schedule during maintenance window'
      });
    }

    return recommendations;
  }

  /**
   * 创建空分析结果
   */
  createEmptyAnalysis() {
    return {
      timestamp: new Date().toISOString(),
      totalChanges: 0,
      directImpact: [],
      indirectImpact: [],
      affectedQueries: [],
      affectedServices: [],
      riskLevel: ImpactLevel.LOW,
      estimatedExecutionTime: 0,
      rollbackComplexity: 'simple',
      summary: 'No schema changes to analyze',
      recommendations: []
    };
  }
}

module.exports = {
  SchemaImpactAnalyzer,
  ImpactLevel,
  ImpactType
};