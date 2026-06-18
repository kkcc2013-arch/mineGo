# REQ-00267: 数据血缘可视化与影响分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00267 |
| 标题 | 数据血缘可视化与影响分析系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、admin-dashboard、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-18 21:00 |

## 需求描述

构建完整的数据血缘追踪系统，实现数据从采集、存储、处理到消费的全链路血缘追踪。支持可视化展示数据流向、依赖关系，提供数据变更影响分析能力，帮助开发者评估数据库 schema 变更、API 修改的影响范围，降低变更风险。

### 核心目标
1. 自动追踪数据血缘关系，构建数据血缘图谱
2. 可视化展示数据流向与依赖关系
3. 支持数据变更影响分析，评估变更风险
4. 提供血缘查询与溯源能力
5. 集成 CI/CD 流水线，变更前自动评估影响

## 技术方案

### 1. 数据血缘采集层

```javascript
// backend/shared/lineage/DataLineageCollector.js

const { Kafka } = require('kafkajs');
const Redis = require('ioredis');
const { logger } = require('../logger');

class DataLineageCollector {
  constructor() {
    this.kafka = new Kafka({
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['kafka:9092']
    });
    this.producer = this.kafka.producer();
    this.redis = new Redis(process.env.REDIS_URL);
    
    // 血缘事件类型
    this.eventTypes = {
      DATA_READ: 'data.read',
      DATA_WRITE: 'data.write',
      DATA_TRANSFORM: 'data.transform',
      DATA_DELETE: 'data.delete',
      DATA_MIGRATE: 'data.migrate'
    };
  }

  /**
   * 记录数据血缘事件
   * @param {Object} event - 血缘事件
   * @param {string} event.source - 数据来源（服务名）
   * @param {string} event.operation - 操作类型
   * @param {Object} event.input - 输入数据描述
   * @param {Object} event.output - 输出数据描述
   * @param {Object} event.context - 操作上下文
   */
  async recordLineage(event) {
    const lineageEvent = {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      source: event.source,
      operation: event.operation,
      
      // 输入数据源
      inputs: event.inputs?.map(input => ({
        type: input.type,           // 'database', 'api', 'cache', 'kafka'
        identifier: input.identifier, // 表名/API路径/Topic名
        fields: input.fields,       // 涉及的字段
        service: input.service      // 所属服务
      })) || [],
      
      // 输出数据目标
      outputs: event.outputs?.map(output => ({
        type: output.type,
        identifier: output.identifier,
        fields: output.fields,
        service: output.service
      })) || [],
      
      // 转换逻辑描述
      transformation: event.transformation ? {
        type: event.transformation.type, // 'merge', 'filter', 'aggregate', 'enrich'
        description: event.transformation.description,
        codeRef: event.transformation.codeRef // 代码引用位置
      } : null,
      
      // 上下文信息
      context: {
        traceId: event.context?.traceId,
        userId: event.context?.userId,
        requestId: event.context?.requestId,
        apiEndpoint: event.context?.apiEndpoint
      }
    };

    // 发送到 Kafka
    await this.producer.send({
      topic: 'data-lineage-events',
      messages: [{
        key: lineageEvent.id,
        value: JSON.stringify(lineageEvent)
      }]
    });

    // 实时更新血缘缓存
    await this.updateLineageCache(lineageEvent);

    logger.info('Data lineage recorded', {
      eventId: lineageEvent.id,
      operation: event.operation
    });

    return lineageEvent.id;
  }

  /**
   * 数据库查询血缘追踪
   */
  async trackDatabaseQuery(service, query, result, context) {
    const parser = new SQLParser();
    const parsedQuery = parser.parse(query);
    
    const inputs = [];
    const outputs = [];
    
    if (parsedQuery.type === 'SELECT') {
      inputs.push({
        type: 'database',
        identifier: `${service}.${parsedQuery.table}`,
        fields: parsedQuery.columns,
        service: service
      });
    } else if (parsedQuery.type === 'INSERT' || parsedQuery.type === 'UPDATE') {
      outputs.push({
        type: 'database',
        identifier: `${service}.${parsedQuery.table}`,
        fields: parsedQuery.columns,
        service: service
      });
      
      // UPDATE/DELETE 可能也有输入
      if (parsedQuery.where) {
        inputs.push({
          type: 'database',
          identifier: `${service}.${parsedQuery.table}`,
          fields: ['*'], // WHERE 条件可能涉及多个字段
          service: service
        });
      }
    }

    await this.recordLineage({
      source: service,
      operation: `database.${parsedQuery.type.toLowerCase()}`,
      inputs,
      outputs,
      context
    });
  }

  /**
   * API 调用血缘追踪
   */
  async trackApiCall(callerService, targetService, endpoint, requestData, responseData, context) {
    const inputs = [{
      type: 'api',
      identifier: `${targetService}${endpoint}`,
      fields: Object.keys(requestData || {}),
      service: targetService
    }];

    const outputs = [{
      type: 'api_response',
      identifier: `${callerService}->${targetService}${endpoint}`,
      fields: Object.keys(responseData || {}),
      service: callerService
    }];

    await this.recordLineage({
      source: callerService,
      operation: 'api.call',
      inputs,
      outputs,
      context
    });
  }

  /**
   * 更新血缘缓存
   */
  async updateLineageCache(event) {
    const cacheKey = `lineage:recent:${event.source}`;
    
    // 存储最近的血缘事件（保留 1000 条）
    await this.redis.lpush(cacheKey, JSON.stringify(event));
    await this.redis.ltrim(cacheKey, 0, 999);
    await this.redis.expire(cacheKey, 86400 * 7); // 7 天过期
  }

  generateEventId() {
    return `lin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// SQL 解析器
class SQLParser {
  parse(query) {
    const normalizedQuery = query.trim().toUpperCase();
    
    if (normalizedQuery.startsWith('SELECT')) {
      return this.parseSelect(query);
    } else if (normalizedQuery.startsWith('INSERT')) {
      return this.parseInsert(query);
    } else if (normalizedQuery.startsWith('UPDATE')) {
      return this.parseUpdate(query);
    } else if (normalizedQuery.startsWith('DELETE')) {
      return this.parseDelete(query);
    }
    
    return { type: 'UNKNOWN', table: null, columns: [] };
  }

  parseSelect(query) {
    const tableMatch = query.match(/FROM\s+(\w+)/i);
    const columnsMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
    
    return {
      type: 'SELECT',
      table: tableMatch?.[1] || null,
      columns: this.parseColumns(columnsMatch?.[1] || '*')
    };
  }

  parseInsert(query) {
    const tableMatch = query.match(/INSERT\s+INTO\s+(\w+)/i);
    const columnsMatch = query.match(/\(([^)]+)\)\s*VALUES/i);
    
    return {
      type: 'INSERT',
      table: tableMatch?.[1] || null,
      columns: this.parseColumns(columnsMatch?.[1] || '')
    };
  }

  parseUpdate(query) {
    const tableMatch = query.match(/UPDATE\s+(\w+)/i);
    const setMatch = query.match(/SET\s+(.+?)(?:\s+WHERE|$)/i);
    const whereMatch = query.match(/WHERE\s+(.+)/i);
    
    return {
      type: 'UPDATE',
      table: tableMatch?.[1] || null,
      columns: this.parseColumns(setMatch?.[1] || ''),
      where: whereMatch?.[1] || null
    };
  }

  parseDelete(query) {
    const tableMatch = query.match(/FROM\s+(\w+)/i);
    const whereMatch = query.match(/WHERE\s+(.+)/i);
    
    return {
      type: 'DELETE',
      table: tableMatch?.[1] || null,
      columns: [],
      where: whereMatch?.[1] || null
    };
  }

  parseColumns(columnStr) {
    if (columnStr === '*') return ['*'];
    
    return columnStr
      .split(',')
      .map(col => col.trim().split(/\s+as\s+/i).pop())
      .map(col => col.replace(/[\'"`]/g, '').trim())
      .filter(col => col && col !== '*');
  }
}

module.exports = DataLineageCollector;
```

### 2. 数据血缘图谱构建

```javascript
// backend/shared/lineage/DataLineageGraph.js

const { Neo4jDriver } = require('neo4j-driver');
const { logger } = require('../logger');

class DataLineageGraph {
  constructor() {
    this.driver = Neo4jDriver.driver(
      process.env.NEO4J_URI || 'bolt://neo4j:7687',
      Neo4jDriver.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || 'password'
      )
    );
  }

  /**
   * 构建血缘关系节点
   */
  async buildLineageNode(nodeData) {
    const session = this.driver.session();
    
    try {
      // 创建或更新数据节点
      const cypher = `
        MERGE (n:DataNode {identifier: $identifier})
        SET n += {
          type: $type,
          service: $service,
          fields: $fields,
          lastUpdated: datetime(),
          accessCount: COALESCE(n.accessCount, 0) + 1
        }
        RETURN n
      `;

      await session.run(cypher, {
        identifier: nodeData.identifier,
        type: nodeData.type,
        service: nodeData.service,
        fields: nodeData.fields
      });

    } finally {
      await session.close();
    }
  }

  /**
   * 构建血缘关系边
   */
  async buildLineageEdge(sourceNode, targetNode, relationship) {
    const session = this.driver.session();
    
    try {
      const cypher = `
        MATCH (source:DataNode {identifier: $sourceId})
        MATCH (target:DataNode {identifier: $targetId})
        MERGE (source)-[r:FLOWS_TO {
          operation: $operation,
          transformation: $transformation
        }]->(target)
        SET r.lastSeen = datetime(),
            r.frequency = COALESCE(r.frequency, 0) + 1
      `;

      await session.run(cypher, {
        sourceId: sourceNode.identifier,
        targetId: targetNode.identifier,
        operation: relationship.operation,
        transformation: relationship.transformation
      });

    } finally {
      await session.close();
    }
  }

  /**
   * 从血缘事件构建图谱
   */
  async buildFromEvent(event) {
    // 构建输入节点
    for (const input of event.inputs || []) {
      await this.buildLineageNode({
        identifier: input.identifier,
        type: input.type,
        service: input.service,
        fields: input.fields
      });
    }

    // 构建输出节点
    for (const output of event.outputs || []) {
      await this.buildLineageNode({
        identifier: output.identifier,
        type: output.type,
        service: output.service,
        fields: output.fields
      });
    }

    // 构建关系边：输入 -> 输出
    for (const input of event.inputs || []) {
      for (const output of event.outputs || []) {
        await this.buildLineageEdge(input, output, {
          operation: event.operation,
          transformation: event.transformation?.type || null
        });
      }
    }
  }

  /**
   * 查询数据血缘（上游溯源）
   */
  async traceUpstream(identifier, depth = 5) {
    const session = this.driver.session();
    
    try {
      const cypher = `
        MATCH path = (target:DataNode {identifier: $identifier})<-[:FLOWS_TO*1..${depth}]-(source)
        RETURN 
          target.identifier as target,
          [node in nodes(path) | {
            identifier: node.identifier,
            type: node.type,
            service: node.service,
            fields: node.fields
          }] as pathNodes,
          [rel in relationships(path) | {
            operation: rel.operation,
            transformation: rel.transformation,
            frequency: rel.frequency
          }] as pathRels
        ORDER BY length(path)
      `;

      const result = await session.run(cypher, { identifier });
      
      return result.records.map(record => ({
        target: record.get('target'),
        nodes: record.get('pathNodes'),
        relationships: record.get('pathRels')
      }));

    } finally {
      await session.close();
    }
  }

  /**
   * 查询数据血缘（下游影响）
   */
  async traceDownstream(identifier, depth = 5) {
    const session = this.driver.session();
    
    try {
      const cypher = `
        MATCH path = (source:DataNode {identifier: $identifier})-[:FLOWS_TO*1..${depth}]->(target)
        RETURN 
          source.identifier as source,
          [node in nodes(path) | {
            identifier: node.identifier,
            type: node.type,
            service: node.service,
            fields: node.fields
          }] as pathNodes,
          [rel in relationships(path) | {
            operation: rel.operation,
            transformation: rel.transformation,
            frequency: rel.frequency
          }] as pathRels
        ORDER BY length(path)
      `;

      const result = await session.run(cypher, { identifier });
      
      return result.records.map(record => ({
        source: record.get('source'),
        nodes: record.get('pathNodes'),
        relationships: record.get('pathRels')
      }));

    } finally {
      await session.close();
    }
  }

  /**
   * 获取完整血缘图谱
   */
  async getFullGraph(limit = 500) {
    const session = this.driver.session();
    
    try {
      const cypher = `
        MATCH (n:DataNode)
        OPTIONAL MATCH (n)-[r:FLOWS_TO]->(m:DataNode)
        RETURN 
          collect(DISTINCT {
            id: n.identifier,
            type: n.type,
            service: n.service,
            fields: n.fields
          }) as nodes,
          collect(DISTINCT {
            source: n.identifier,
            target: m.identifier,
            operation: r.operation
          }) as edges
        LIMIT $limit
      `;

      const result = await session.run(cypher, { limit });
      const record = result.records[0];
      
      return {
        nodes: record.get('nodes').filter(n => n.id),
        edges: record.get('edges').filter(e => e.source && e.target)
      };

    } finally {
      await session.close();
    }
  }

  /**
   * 获取节点统计信息
   */
  async getNodeStats(identifier) {
    const session = this.driver.session();
    
    try {
      const cypher = `
        MATCH (n:DataNode {identifier: $identifier})
        OPTIONAL MATCH (n)<-[in:FLOWS_TO]-()
        OPTIONAL MATCH (n)-[out:FLOWS_TO]->()
        RETURN 
          n.identifier as identifier,
          n.type as type,
          n.service as service,
          n.fields as fields,
          n.accessCount as accessCount,
          count(DISTINCT in) as upstreamCount,
          count(DISTINCT out) as downstreamCount
      `;

      const result = await session.run(cypher, { identifier });
      const record = result.records[0];
      
      if (!record) return null;
      
      return {
        identifier: record.get('identifier'),
        type: record.get('type'),
        service: record.get('service'),
        fields: record.get('fields'),
        accessCount: record.get('accessCount').toNumber(),
        upstreamCount: record.get('upstreamCount').toNumber(),
        downstreamCount: record.get('downstreamCount').toNumber()
      };

    } finally {
      await session.close();
    }
  }
}

module.exports = DataLineageGraph;
```

### 3. 影响分析引擎

```javascript
// backend/shared/lineage/ImpactAnalyzer.js

const DataLineageGraph = require('./DataLineageGraph');
const { logger } = require('../logger');

class ImpactAnalyzer {
  constructor() {
    this.graph = new DataLineageGraph();
  }

  /**
   * 分析数据变更影响
   * @param {Object} change - 变更描述
   */
  async analyzeChangeImpact(change) {
    const {
      type,           // 'schema', 'api', 'field'
      target,         // 目标标识符
      changeType,     // 'add', 'modify', 'remove'
      details         // 变更详情
    } = change;

    const impactReport = {
      changeId: this.generateChangeId(),
      timestamp: new Date().toISOString(),
      change,
      impacts: {
        direct: [],
        indirect: [],
        potential: []
      },
      riskLevel: 'low',
      recommendations: [],
      affectedServices: new Set(),
      affectedApis: new Set(),
      affectedConsumers: new Set()
    };

    switch (type) {
      case 'schema':
        await this.analyzeSchemaChange(change, impactReport);
        break;
      case 'api':
        await this.analyzeApiChange(change, impactReport);
        break;
      case 'field':
        await this.analyzeFieldChange(change, impactReport);
        break;
    }

    // 计算风险等级
    impactReport.riskLevel = this.calculateRiskLevel(impactReport);
    
    // 生成建议
    impactReport.recommendations = this.generateRecommendations(impactReport);

    // 转换 Set 为数组
    impactReport.affectedServices = Array.from(impactReport.affectedServices);
    impactReport.affectedApis = Array.from(impactReport.affectedApis);
    impactReport.affectedConsumers = Array.from(impactReport.affectedConsumers);

    return impactReport;
  }

  /**
   * 分析 Schema 变更影响
   */
  async analyzeSchemaChange(change, report) {
    const { target, changeType, details } = change;
    
    // 查找下游依赖
    const downstream = await this.graph.traceDownstream(target, 3);
    
    for (const path of downstream) {
      const impact = {
        target: path.nodes[path.nodes.length - 1],
        path: path.nodes,
        impactType: this.determineImpactType(changeType, path),
        confidence: this.calculateConfidence(path)
      };

      if (path.nodes.length <= 2) {
        report.impacts.direct.push(impact);
      } else if (impact.confidence > 0.7) {
        report.impacts.indirect.push(impact);
      } else {
        report.impacts.potential.push(impact);
      }

      // 收集受影响的服务和 API
      for (const node of path.nodes) {
        report.affectedServices.add(node.service);
        if (node.type === 'api' || node.type === 'api_response') {
          report.affectedApis.add(node.identifier);
        }
      }
    }

    // 检查字段变更
    if (changeType === 'remove' && details?.fields) {
      for (const field of details.fields) {
        await this.checkFieldUsage(target, field, report);
      }
    }
  }

  /**
   * 分析 API 变更影响
   */
  async analyzeApiChange(change, report) {
    const { target, changeType, details } = change;
    
    // 查找下游依赖
    const downstream = await this.graph.traceDownstream(target, 4);
    
    for (const path of downstream) {
      const impact = {
        target: path.nodes[path.nodes.length - 1],
        path: path.nodes,
        impactType: changeType === 'remove' ? 'breaking' : 'compatible',
        confidence: 0.9
      };

      if (path.nodes.length <= 2) {
        report.impacts.direct.push(impact);
      } else {
        report.impacts.indirect.push(impact);
      }

      // 收集消费者
      const lastNode = path.nodes[path.nodes.length - 1];
      report.affectedConsumers.add(lastNode.service);
    }

    // 检查 API 兼容性
    if (changeType === 'modify' && details?.breakingChanges) {
      report.riskLevel = 'high';
      report.recommendations.push({
        type: 'versioning',
        message: '建议使用 API 版本控制，保留旧版本端点'
      });
    }
  }

  /**
   * 分析字段变更影响
   */
  async analyzeFieldChange(change, report) {
    const { target, changeType, details } = change;
    const field = details?.field;
    
    if (!field) return;

    // 查找使用该字段的所有节点
    const downstream = await this.graph.traceDownstream(target, 3);
    
    for (const path of downstream) {
      const lastNode = path.nodes[path.nodes.length - 1];
      
      // 检查该节点是否使用了目标字段
      if (lastNode.fields?.includes(field) || lastNode.fields?.includes('*')) {
        const impact = {
          target: lastNode,
          field,
          impactType: changeType === 'remove' ? 'breaking' : 'warning',
          confidence: 0.85
        };

        report.impacts.direct.push(impact);
        report.affectedServices.add(lastNode.service);
      }
    }
  }

  /**
   * 检查字段使用情况
   */
  async checkFieldUsage(identifier, field, report) {
    const stats = await this.graph.getNodeStats(identifier);
    
    if (stats?.downstreamCount > 0) {
      report.recommendations.push({
        type: 'field_deprecation',
        message: `字段 ${field} 被 ${stats.downstreamCount} 个下游节点引用，建议先标记为废弃`
      });
    }
  }

  /**
   * 计算风险等级
   */
  calculateRiskLevel(report) {
    const directCount = report.impacts.direct.length;
    const breakingCount = report.impacts.direct.filter(
      i => i.impactType === 'breaking'
    ).length;

    if (breakingCount > 0) return 'critical';
    if (directCount > 10) return 'high';
    if (directCount > 5) return 'medium';
    return 'low';
  }

  /**
   * 计算置信度
   */
  calculateConfidence(path) {
    // 路径越短，置信度越高
    const pathLength = path.nodes.length;
    if (pathLength <= 2) return 0.95;
    if (pathLength <= 4) return 0.85;
    if (pathLength <= 6) return 0.7;
    return 0.5;
  }

  /**
   * 确定影响类型
   */
  determineImpactType(changeType, path) {
    if (changeType === 'remove') return 'breaking';
    if (changeType === 'modify') return 'warning';
    return 'info';
  }

  /**
   * 生成建议
   */
  generateRecommendations(report) {
    const recommendations = [];

    if (report.impacts.direct.length > 5) {
      recommendations.push({
        type: 'phased_rollout',
        message: '影响范围较大，建议分阶段推出变更'
      });
    }

    if (report.riskLevel === 'critical') {
      recommendations.push({
        type: 'approval',
        message: '存在破坏性变更，需要技术负责人审批'
      });
    }

    if (report.affectedApis.size > 0) {
      recommendations.push({
        type: 'communication',
        message: `影响 ${report.affectedApis.size} 个 API，需要通知下游消费者`
      });
    }

    return recommendations;
  }

  generateChangeId() {
    return `chg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = ImpactAnalyzer;
```

### 4. 可视化 API 端点

```javascript
// backend/services/admin-dashboard/src/routes/lineage.js

const express = require('express');
const router = express.Router();
const DataLineageGraph = require('../../../shared/lineage/DataLineageGraph');
const ImpactAnalyzer = require('../../../shared/lineage/ImpactAnalyzer');
const DataLineageCollector = require('../../../shared/lineage/DataLineageCollector');

const graph = new DataLineageGraph();
const analyzer = new ImpactAnalyzer();
const collector = new DataLineageCollector();

/**
 * 获取完整血缘图谱
 */
router.get('/graph', async (req, res) => {
  try {
    const { limit = 500 } = req.query;
    const graphData = await graph.getFullGraph(parseInt(limit));
    
    res.json({
      success: true,
      data: graphData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 查询上游血缘
 */
router.get('/upstream/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { depth = 5 } = req.query;
    
    const upstream = await graph.traceUpstream(
      decodeURIComponent(identifier),
      parseInt(depth)
    );
    
    res.json({
      success: true,
      data: upstream
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 查询下游血缘
 */
router.get('/downstream/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const { depth = 5 } = req.query;
    
    const downstream = await graph.traceDownstream(
      decodeURIComponent(identifier),
      parseInt(depth)
    );
    
    res.json({
      success: true,
      data: downstream
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取节点统计
 */
router.get('/stats/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const stats = await graph.getNodeStats(decodeURIComponent(identifier));
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 分析变更影响
 */
router.post('/impact/analyze', async (req, res) => {
  try {
    const change = req.body;
    
    // 验证请求
    if (!change.type || !change.target || !change.changeType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: type, target, changeType'
      });
    }

    const report = await analyzer.analyzeChangeImpact(change);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 记录血缘事件
 */
router.post('/record', async (req, res) => {
  try {
    const event = req.body;
    const eventId = await collector.recordLineage(event);
    
    res.json({
      success: true,
      data: { eventId }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 5. 数据库集成中间件

```javascript
// backend/shared/lineage/LineageMiddleware.js

const DataLineageCollector = require('./DataLineageCollector');

/**
 * 数据库查询血缘追踪中间件
 */
function createLineageMiddleware(serviceName) {
  const collector = new DataLineageCollector();

  return async function lineageMiddleware(ctx, next) {
    // 在请求上下文中注入 collector
    ctx.lineageCollector = collector;
    ctx.serviceName = serviceName;

    await next();

    // 如果有数据库操作，记录血缘
    if (ctx.dbQueries && ctx.dbQueries.length > 0) {
      for (const query of ctx.dbQueries) {
        await collector.trackDatabaseQuery(
          serviceName,
          query.sql,
          query.result,
          {
            traceId: ctx.traceId,
            userId: ctx.userId,
            requestId: ctx.requestId,
            apiEndpoint: ctx.path
          }
        );
      }
    }
  };
}

/**
 * Knex 查询追踪插件
 */
function setupKnexLineage(knex, serviceName, collector) {
  knex.on('query', (query) => {
    query.__startTime = Date.now();
  });

  knex.on('query-response', async (response, query) => {
    const duration = Date.now() - query.__startTime;
    
    // 记录血缘（异步，不阻塞响应）
    collector.trackDatabaseQuery(
      serviceName,
      query.sql,
      response,
      {
        duration,
        bindings: query.bindings
      }
    ).catch(err => {
      console.error('Failed to track lineage:', err);
    });
  });
}

module.exports = {
  createLineageMiddleware,
  setupKnexLineage
};
```

### 6. CI/CD 集成

```yaml
# .github/workflows/impact-analysis.yml
name: Impact Analysis

on:
  pull_request:
    branches: [main, develop]
    paths:
      - 'backend/**/migrations/**'
      - 'backend/**/routes/**'
      - 'docs/api-spec/**'

jobs:
  analyze-impact:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Detect Changes
        id: changes
        run: |
          # 检测迁移文件变更
          MIGRATION_FILES=$(git diff --name-only origin/main...HEAD -- 'backend/**/migrations/*.sql')
          echo "migrations<<EOF" >> $GITHUB_OUTPUT
          echo "$MIGRATION_FILES" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT
          
          # 检测 API 变更
          API_FILES=$(git diff --name-only origin/main...HEAD -- 'docs/api-spec/*.yaml')
          echo "apis<<EOF" >> $GITHUB_OUTPUT
          echo "$API_FILES" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Analyze Schema Changes
        if: steps.changes.outputs.migrations != ''
        run: |
          for file in ${{ steps.changes.outputs.migrations }}; do
            echo "Analyzing migration: $file"
            
            # 提取表名和变更类型
            python3 scripts/analyze_migration.py "$file" > impact_report.json
            
            # 调用影响分析 API
            curl -X POST "${{ secrets.ADMIN_DASHBOARD_URL }}/api/lineage/impact/analyze" \
              -H "Authorization: Bearer ${{ secrets.ADMIN_TOKEN }}" \
              -H "Content-Type: application/json" \
              -d @impact_report.json
          done

      - name: Analyze API Changes
        if: steps.changes.outputs.apis != ''
        run: |
          for file in ${{ steps.changes.outputs.apis }}; do
            echo "Analyzing API spec: $file"
            
            # 比较新旧 API 规范
            python3 scripts/detect_api_changes.py "$file" > api_changes.json
            
            # 调用影响分析 API
            curl -X POST "${{ secrets.ADMIN_DASHBOARD_URL }}/api/lineage/impact/analyze" \
              -H "Authorization: Bearer ${{ secrets.ADMIN_TOKEN }}" \
              -H "Content-Type: application/json" \
              -d @api_changes.json
          done

      - name: Comment on PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            
            let comment = '## 🔍 影响分析报告\n\n';
            
            // 读取分析结果
            try {
              const report = JSON.parse(fs.readFileSync('impact_report.json', 'utf8'));
              
              comment += `### 变更概要\n`;
              comment += `- **风险等级**: ${report.riskLevel}\n`;
              comment += `- **直接影响**: ${report.impacts.direct.length} 个\n`;
              comment += `- **间接影响**: ${report.impacts.indirect.length} 个\n`;
              comment += `- **受影响服务**: ${report.affectedServices.join(', ')}\n\n`;
              
              if (report.recommendations.length > 0) {
                comment += `### 建议\n`;
                for (const rec of report.recommendations) {
                  comment += `- ${rec.message}\n`;
                }
              }
              
              if (report.riskLevel === 'critical') {
                comment += '\n⚠️ **此变更存在破坏性影响，需要技术负责人审批！**\n';
              }
            } catch (e) {
              comment += '未能生成影响分析报告\n';
            }
            
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: comment
            });
```

## 验收标准

- [ ] 数据血缘自动追踪覆盖所有数据库查询
- [ ] 数据血缘自动追踪覆盖所有服务间 API 调用
- [ ] 血缘图谱可视化展示，支持缩放、搜索、过滤
- [ ] 上游溯源功能支持追溯数据来源
- [ ] 下游影响分析功能支持评估变更影响
- [ ] Schema 变更影响分析自动识别受影响服务
- [ ] API 变更影响分析自动识别受影响消费者
- [ ] 影响分析结果集成到 PR 评论
- [ ] 风险等级自动计算（low/medium/high/critical）
- [ ] 变更建议自动生成
- [ ] Neo4j 图数据库部署完成
- [ ] 血缘数据保留策略（热数据 30 天，冷数据 1 年）
- [ ] 血缘查询 API 响应时间 < 500ms
- [ ] 大规模图谱（10000+ 节点）渲染性能优化

## 影响范围

### 新增文件
- `backend/shared/lineage/DataLineageCollector.js` - 血缘采集器
- `backend/shared/lineage/DataLineageGraph.js` - 血缘图谱
- `backend/shared/lineage/ImpactAnalyzer.js` - 影响分析引擎
- `backend/shared/lineage/LineageMiddleware.js` - 中间件
- `backend/services/admin-dashboard/src/routes/lineage.js` - API 端点
- `.github/workflows/impact-analysis.yml` - CI/CD 集成
- `scripts/analyze_migration.py` - 迁移分析脚本
- `scripts/detect_api_changes.py` - API 变更检测脚本

### 修改文件
- `backend/shared/db.js` - 集成查询追踪
- `backend/shared/logger.js` - 添加血缘日志类型
- `backend/services/admin-dashboard/src/index.js` - 挂载血缘路由
- `infrastructure/k8s/monitoring/` - Neo4j 部署配置
- `docs/api-spec/openapi.yaml` - 添加血缘 API 文档

### 基础设施
- 部署 Neo4j 图数据库
- 配置 Kafka Topic: `data-lineage-events`
- 创建血缘数据存储策略

## 参考

- [Apache Atlas - Data Governance](https://atlas.apache.org/)
- [OpenLineage - Open Standard for Data Lineage](https://openlineage.io/)
- [Neo4j Graph Database](https://neo4j.com/)
- [Data Catalog Best Practices](https://cloud.google.com/data-catalog/docs)
- [Impact Analysis Patterns](https://martinfowler.com/articles/patterns-legacy-displacement/)
