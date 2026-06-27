# REQ-00346: 数据血缘追踪与影响分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00346 |
| 标题 | 数据血缘追踪与影响分析系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、admin-dashboard、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-27 05:00 UTC |

## 需求描述

### 背景
当前数据治理存在以下问题：
1. **数据关系不透明**：不知道数据从哪里来、到哪里去
2. **变更影响难评估**：修改表结构时无法评估影响范围
3. **数据质量问题难追溯**：出现数据问题时无法快速定位根源
4. **合规审计困难**：无法提供完整的数据流转记录
5. **数据依赖关系复杂**：微服务间数据调用关系不清晰

### 目标
实现数据血缘追踪与影响分析系统：
- 自动追踪数据血缘关系
- 可视化数据流转路径
- 变更影响分析（Breaking Change 检测）
- 数据质量根因分析
- 合规审计支持（数据访问记录）

## 技术方案

### 1. 数据血缘采集器

**文件：** `backend/shared/dataLineage/LineageCollector.js`

```javascript
class LineageCollector {
  constructor(options = {}) {
    this.kafka = options.kafka;
    this.storage = options.storage; // PostgreSQL for lineage data
    this.collectors = new Map(); // service -> collector instance
    this.enabledEvents = [
      'db_query',
      'db_insert',
      'db_update',
      'db_delete',
      'api_call',
      'cache_read',
      'cache_write',
      'message_publish',
      'message_consume'
    ];
  }

  /**
   * 启动采集器
   */
  async start() {
    // 订阅所有微服务的数据事件
    await this.subscribeToDataEvents();
    
    // 初始化数据库表
    await this.initializeDatabase();
    
    // 启动血缘分析任务
    this.startLineageAnalysis();
  }

  /**
   * 订阅数据事件
   */
  async subscribeToDataEvents() {
    const consumer = this.kafka.consumer({ groupId: 'lineage-collector' });
    await consumer.connect();
    await consumer.subscribe({ topic: 'data-events', fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const event = JSON.parse(message.value.toString());
        await this.processDataEvent(event);
      }
    });
  }

  /**
   * 处理数据事件
   */
  async processDataEvent(event) {
    const {
      eventId,
      eventType,
      timestamp,
      service,
      operation,
      source,
      target,
      metadata
    } = event;

    // 验证事件类型
    if (!this.enabledEvents.includes(eventType)) {
      return;
    }

    // 提取血缘关系
    const lineage = this.extractLineage(event);

    // 存储血缘记录
    await this.storeLineage(lineage);

    // 更新血缘图谱
    await this.updateLineageGraph(lineage);
  }

  /**
   * 提取血缘关系
   */
  extractLineage(event) {
    const { eventType, service, operation, source, target, metadata } = event;

    switch (eventType) {
      case 'db_query':
        return this.extractDatabaseLineage(event);

      case 'api_call':
        return this.extractAPILineage(event);

      case 'message_publish':
        return this.extractMessageLineage(event);

      case 'cache_read':
      case 'cache_write':
        return this.extractCacheLineage(event);

      default:
        return null;
    }
  }

  /**
   * 提取数据库血缘
   */
  extractDatabaseLineage(event) {
    const { service, operation, metadata } = event;

    return {
      lineageType: 'database',
      sourceNode: {
        type: 'service',
        id: service,
        name: service
      },
      targetNode: {
        type: 'table',
        id: `${metadata.database}.${metadata.table}`,
        database: metadata.database,
        table: metadata.table
      },
      operation: operation, // SELECT, INSERT, UPDATE, DELETE
      columns: metadata.columns || [],
      rowCount: metadata.rowCount,
      timestamp: event.timestamp,
      queryHash: this.hashQuery(metadata.query),
      traceId: metadata.traceId
    };
  }

  /**
   * 提取 API 血缘
   */
  extractAPILineage(event) {
    const { service, operation, metadata } = event;

    return {
      lineageType: 'api',
      sourceNode: {
        type: 'service',
        id: service,
        name: service
      },
      targetNode: {
        type: 'service',
        id: metadata.targetService,
        name: metadata.targetService
      },
      operation: operation, // GET, POST, PUT, DELETE
      endpoint: metadata.endpoint,
      requestBody: metadata.requestBody,
      responseBody: metadata.responseBody,
      timestamp: event.timestamp,
      traceId: metadata.traceId
    };
  }

  /**
   * 提取消息队列血缘
   */
  extractMessageLineage(event) {
    const { service, operation, metadata } = event;

    return {
      lineageType: 'message',
      sourceNode: {
        type: 'service',
        id: service,
        name: service
      },
      targetNode: {
        type: 'topic',
        id: metadata.topic,
        name: metadata.topic
      },
      operation: operation, // PUBLISH, CONSUME
      messageKey: metadata.key,
      messageValue: metadata.value,
      timestamp: event.timestamp,
      traceId: metadata.traceId
    };
  }

  /**
   * 提取缓存血缘
   */
  extractCacheLineage(event) {
    const { service, operation, metadata } = event;

    return {
      lineageType: 'cache',
      sourceNode: {
        type: 'service',
        id: service,
        name: service
      },
      targetNode: {
        type: 'cache',
        id: metadata.cacheKey,
        key: metadata.cacheKey
      },
      operation: operation, // READ, WRITE, DELETE
      ttl: metadata.ttl,
      timestamp: event.timestamp,
      traceId: metadata.traceId
    };
  }

  /**
   * 存储血缘记录
   */
  async storeLineage(lineage) {
    if (!lineage) return;

    const query = `
      INSERT INTO data_lineage (
        lineage_type,
        source_type,
        source_id,
        source_name,
        target_type,
        target_id,
        target_name,
        operation,
        columns,
        row_count,
        query_hash,
        trace_id,
        timestamp,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `;

    await this.storage.query(query, [
      lineage.lineageType,
      lineage.sourceNode.type,
      lineage.sourceNode.id,
      lineage.sourceNode.name,
      lineage.targetNode.type,
      lineage.targetNode.id,
      lineage.targetNode.name,
      lineage.operation,
      JSON.stringify(lineage.columns || []),
      lineage.rowCount || 0,
      lineage.queryHash || null,
      lineage.traceId || null,
      lineage.timestamp,
      JSON.stringify(lineage)
    ]);
  }

  /**
   * 更新血缘图谱
   */
  async updateLineageGraph(lineage) {
    // 使用 Neo4j 或 PostgreSQL 存储图谱
    // 这里使用 PostgreSQL 的递归查询模拟图结构

    // 添加节点
    await this.upsertNode(lineage.sourceNode);
    await this.upsertNode(lineage.targetNode);

    // 添加边
    await this.upsertEdge({
      sourceId: lineage.sourceNode.id,
      targetId: lineage.targetNode.id,
      type: lineage.lineageType,
      operation: lineage.operation,
      lastSeen: lineage.timestamp
    });
  }

  /**
   * 插入或更新节点
   */
  async upsertNode(node) {
    const query = `
      INSERT INTO lineage_nodes (node_type, node_id, node_name, metadata, last_seen)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (node_type, node_id)
      DO UPDATE SET
        last_seen = EXCLUDED.last_seen,
        metadata = EXCLUDED.metadata
    `;

    await this.storage.query(query, [
      node.type,
      node.id,
      node.name,
      JSON.stringify(node),
      new Date()
    ]);
  }

  /**
   * 插入或更新边
   */
  async upsertEdge(edge) {
    const query = `
      INSERT INTO lineage_edges (
        source_node_type,
        source_node_id,
        target_node_type,
        target_node_id,
        edge_type,
        operation,
        last_seen,
        occurrence_count
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
      ON CONFLICT (source_node_type, source_node_id, target_node_type, target_node_id, edge_type)
      DO UPDATE SET
        last_seen = EXCLUDED.last_seen,
        occurrence_count = lineage_edges.occurrence_count + 1
    `;

    await this.storage.query(query, [
      edge.sourceId.split('/')[0],
      edge.sourceId,
      edge.targetId.split('/')[0],
      edge.targetId,
      edge.type,
      edge.operation,
      edge.lastSeen
    ]);
  }

  /**
   * 生成查询哈希
   */
  hashQuery(query) {
    if (!query) return null;
    
    const crypto = require('crypto');
    return crypto.createHash('md5').update(query).digest('hex');
  }

  /**
   * 初始化数据库
   */
  async initializeDatabase() {
    const createTables = `
      -- 节点表
      CREATE TABLE IF NOT EXISTS lineage_nodes (
        node_type VARCHAR(50) NOT NULL,
        node_id VARCHAR(255) NOT NULL,
        node_name VARCHAR(255),
        metadata JSONB,
        last_seen TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (node_type, node_id)
      );

      -- 边表
      CREATE TABLE IF NOT EXISTS lineage_edges (
        id SERIAL PRIMARY KEY,
        source_node_type VARCHAR(50) NOT NULL,
        source_node_id VARCHAR(255) NOT NULL,
        target_node_type VARCHAR(50) NOT NULL,
        target_node_id VARCHAR(255) NOT NULL,
        edge_type VARCHAR(50) NOT NULL,
        operation VARCHAR(20),
        last_seen TIMESTAMP,
        occurrence_count INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (source_node_type, source_node_id, target_node_type, target_node_id, edge_type)
      );

      -- 血缘详情表
      CREATE TABLE IF NOT EXISTS data_lineage (
        id SERIAL PRIMARY KEY,
        lineage_type VARCHAR(50) NOT NULL,
        source_type VARCHAR(50) NOT NULL,
        source_id VARCHAR(255) NOT NULL,
        source_name VARCHAR(255),
        target_type VARCHAR(50) NOT NULL,
        target_id VARCHAR(255) NOT NULL,
        target_name VARCHAR(255),
        operation VARCHAR(20),
        columns JSONB,
        row_count INTEGER,
        query_hash VARCHAR(32),
        trace_id VARCHAR(255),
        timestamp TIMESTAMP NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- 索引
      CREATE INDEX IF NOT EXISTS idx_lineage_nodes_type ON lineage_nodes(node_type);
      CREATE INDEX IF NOT NOT EXISTS idx_lineage_edges_source ON lineage_edges(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_lineage_edges_target ON lineage_edges(target_node_id);
      CREATE INDEX IF NOT EXISTS idx_data_lineage_timestamp ON data_lineage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_data_lineage_source ON data_lineage(source_id);
      CREATE INDEX IF NOT EXISTS idx_data_lineage_target ON data_lineage(target_id);
    `;

    await this.storage.query(createTables);
  }
}

module.exports = LineageCollector;
```

### 2. 血缘查询与可视化

**文件：** `backend/shared/dataLineage/LineageQuery.js`

```javascript
class LineageQuery {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * 查询上游血缘（数据来源）
   */
  async queryUpstream(nodeId, depth = 5) {
    const query = `
      WITH RECURSIVE upstream AS (
        -- 初始节点
        SELECT 
          source_node_type as node_type,
          source_node_id as node_id,
          target_node_type as parent_type,
          target_node_id as parent_id,
          edge_type,
          operation,
          1 as depth
        FROM lineage_edges
        WHERE target_node_id = $1
        
        UNION ALL
        
        -- 递归查询上游
        SELECT 
          e.source_node_type,
          e.source_node_id,
          e.target_node_type,
          e.target_node_id,
          e.edge_type,
          e.operation,
          u.depth + 1
        FROM lineage_edges e
        INNER JOIN upstream u ON e.target_node_id = u.node_id
        WHERE u.depth < $2
      )
      SELECT * FROM upstream
      ORDER BY depth, node_id
    `;

    const result = await this.storage.query(query, [nodeId, depth]);
    return this.formatLineageTree(result.rows, 'upstream');
  }

  /**
   * 查询下游血缘（数据去向）
   */
  async queryDownstream(nodeId, depth = 5) {
    const query = `
      WITH RECURSIVE downstream AS (
        -- 初始节点
        SELECT 
          source_node_type as parent_type,
          source_node_id as parent_id,
          target_node_type as node_type,
          target_node_id as node_id,
          edge_type,
          operation,
          1 as depth
        FROM lineage_edges
        WHERE source_node_id = $1
        
        UNION ALL
        
        -- 递归查询下游
        SELECT 
          d.node_type as parent_type,
          d.node_id as parent_id,
          e.target_node_type,
          e.target_node_id,
          e.edge_type,
          e.operation,
          d.depth + 1
        FROM lineage_edges e
        INNER JOIN downstream d ON e.source_node_id = d.node_id
        WHERE d.depth < $2
      )
      SELECT * FROM downstream
      ORDER BY depth, node_id
    `;

    const result = await this.storage.query(query, [nodeId, depth]);
    return this.formatLineageTree(result.rows, 'downstream');
  }

  /**
   * 查询完整血缘图谱
   */
  async queryFullLineage(nodeId, depth = 3) {
    const [upstream, downstream] = await Promise.all([
      this.queryUpstream(nodeId, depth),
      this.queryDownstream(nodeId, depth)
    ]);

    return {
      root: nodeId,
      upstream,
      downstream,
      graph: this.mergeLineageGraphs(upstream, downstream)
    };
  }

  /**
   * 影响分析（下游影响评估）
   */
  async analyzeImpact(nodeId, changeType = 'schema_change') {
    // 查询所有下游节点
    const downstream = await this.queryDownstream(nodeId, 10);

    // 分析影响级别
    const impactAnalysis = {
      nodeId,
      changeType,
      impactLevel: this.calculateImpactLevel(downstream),
      affectedServices: this.extractAffectedServices(downstream),
      affectedTables: this.extractAffectedTables(downstream),
      affectedAPIs: this.extractAffectedAPIs(downstream),
      riskAssessment: this.assessRisk(downstream),
      recommendations: this.generateRecommendations(downstream, changeType)
    };

    return impactAnalysis;
  }

  /**
   * 根因分析（数据质量问题追溯）
   */
  async analyzeRootCause(nodeId, issueType = 'data_quality') {
    // 查询所有上游节点
    const upstream = await this.queryUpstream(nodeId, 10);

    // 分析潜在根因
    const rootCauseAnalysis = {
      nodeId,
      issueType,
      potentialSources: this.identifyPotentialSources(upstream),
      dataFlow: this.traceDataFlow(upstream),
      suspiciousNodes: this.identifySuspiciousNodes(upstream),
      verificationSteps: this.generateVerificationSteps(upstream),
      mitigationPlan: this.generateMitigationPlan(upstream, issueType)
    };

    return rootCauseAnalysis;
  }

  /**
   * 计算影响级别
   */
  calculateImpactLevel(downstream) {
    const nodeCount = downstream.length;

    if (nodeCount === 0) return 'low';
    if (nodeCount < 5) return 'medium';
    if (nodeCount < 20) return 'high';
    return 'critical';
  }

  /**
   * 提取受影响的服务
   */
  extractAffectedServices(downstream) {
    const services = new Set();

    downstream.forEach(node => {
      if (node.node_type === 'service') {
        services.add(node.node_id);
      }
    });

    return Array.from(services);
  }

  /**
   * 提取受影响的表
   */
  extractAffectedTables(downstream) {
    const tables = new Set();

    downstream.forEach(node => {
      if (node.node_type === 'table') {
        tables.add(node.node_id);
      }
    });

    return Array.from(tables);
  }

  /**
   * 提取受影响的 API
   */
  extractAffectedAPIs(downstream) {
    const apis = new Set();

    downstream.forEach(node => {
      if (node.node_type === 'api') {
        apis.add(node.node_id);
      }
    });

    return Array.from(apis);
  }

  /**
   * 风险评估
   */
  assessRisk(downstream) {
    const riskFactors = [];

    // 检查是否有关键服务
    const criticalServices = ['payment-service', 'user-service', 'auth-service'];
    const affectedServices = this.extractAffectedServices(downstream);

    criticalServices.forEach(service => {
      if (affectedServices.includes(service)) {
        riskFactors.push({
          type: 'critical_service',
          service,
          severity: 'high',
          description: `${service} 是关键服务，需要特别注意`
        });
      }
    });

    // 检查影响范围
    if (downstream.length > 50) {
      riskFactors.push({
        type: 'wide_impact',
        severity: 'high',
        description: '影响范围较广，需要充分测试'
      });
    }

    return riskFactors;
  }

  /**
   * 生成建议
   */
  generateRecommendations(downstream, changeType) {
    const recommendations = [];

    if (downstream.length > 10) {
      recommendations.push({
        type: 'gradual_rollout',
        priority: 'high',
        description: '建议分阶段发布，先在测试环境验证'
      });
    }

    if (this.extractAffectedServices(downstream).length > 3) {
      recommendations.push({
        type: 'communication',
        priority: 'medium',
        description: '建议通知相关服务负责人进行协调'
      });
    }

    recommendations.push({
      type: 'testing',
      priority: 'high',
      description: '建议进行集成测试和回归测试'
    });

    return recommendations;
  }

  /**
   * 识别潜在数据源
   */
  identifyPotentialSources(upstream) {
    const sources = [];

    upstream.forEach(node => {
      if (node.node_type === 'table') {
        sources.push({
          type: 'database',
          id: node.node_id,
          confidence: this.calculateConfidence(node)
        });
      } else if (node.node_type === 'service') {
        sources.push({
          type: 'service',
          id: node.node_id,
          confidence: this.calculateConfidence(node)
        });
      }
    });

    return sources;
  }

  /**
   * 追踪数据流
   */
  traceDataFlow(upstream) {
    return upstream.map(node => ({
      node: node.node_id,
      type: node.node_type,
      operation: node.operation,
      timestamp: node.last_seen
    }));
  }

  /**
   * 识别可疑节点
   */
  identifySuspiciousNodes(upstream) {
    const suspicious = [];

    // 检查最近变更的节点
    upstream.forEach(node => {
      const timeSinceLastSeen = Date.now() - new Date(node.last_seen).getTime();
      const hoursSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60);

      if (hoursSinceLastSeen < 24) {
        suspicious.push({
          nodeId: node.node_id,
          reason: 'recent_change',
          description: '节点最近有数据变更'
        });
      }
    });

    return suspicious;
  }

  /**
   * 生成验证步骤
   */
  generateVerificationSteps(upstream) {
    return [
      {
        step: 1,
        action: '检查上游数据源',
        description: '验证上游数据源的完整性和正确性'
      },
      {
        step: 2,
        action: '检查数据转换逻辑',
        description: '审查数据处理和转换的代码逻辑'
      },
      {
        step: 3,
        action: '检查数据同步状态',
        description: '确认数据同步任务是否正常运行'
      },
      {
        step: 4,
        action: '对比历史数据',
        description: '与历史数据进行对比，识别异常'
      }
    ];
  }

  /**
   * 生成缓解计划
   */
  generateMitigationPlan(upstream, issueType) {
    return {
      immediate: [
        '暂停相关数据处理任务',
        '备份当前数据状态'
      ],
      shortTerm: [
        '定位并修复数据问题',
        '重新处理受影响的数据'
      ],
      longTerm: [
        '增加数据质量检查机制',
        '优化数据血缘监控'
      ]
    };
  }

  /**
   * 格式化血缘树
   */
  formatLineageTree(rows, direction) {
    const tree = {
      nodes: [],
      edges: []
    };

    rows.forEach(row => {
      // 添加节点
      if (!tree.nodes.find(n => n.id === row.node_id)) {
        tree.nodes.push({
          id: row.node_id,
          type: row.node_type,
          depth: row.depth
        });
      }

      // 添加边
      tree.edges.push({
        source: direction === 'upstream' ? row.parent_id : row.node_id,
        target: direction === 'upstream' ? row.node_id : row.parent_id,
        type: row.edge_type,
        operation: row.operation
      });
    });

    return tree;
  }

  /**
   * 合并血缘图谱
   */
  mergeLineageGraphs(upstream, downstream) {
    const graph = {
      nodes: [...upstream.nodes, ...downstream.nodes],
      edges: [...upstream.edges, ...downstream.edges]
    };

    // 去重
    graph.nodes = this.uniqueBy(graph.nodes, 'id');
    graph.edges = this.uniqueBy(graph.edges, e => `${e.source}-${e.target}`);

    return graph;
  }

  /**
   * 数组去重
   */
  uniqueBy(array, keyFn) {
    const seen = new Set();
    return array.filter(item => {
      const key = typeof keyFn === 'function' ? keyFn(item) : item[keyFn];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 计算置信度
   */
  calculateConfidence(node) {
    // 基于节点类型、距离、频率等计算置信度
    let confidence = 0.5;

    if (node.node_type === 'table') confidence += 0.2;
    if (node.occurrence_count > 100) confidence += 0.2;
    if (node.depth === 1) confidence += 0.1;

    return Math.min(confidence, 1.0);
  }
}

module.exports = LineageQuery;
```

### 3. 数据血缘中间件

**文件：** `backend/shared/dataLineage/LineageMiddleware.js`

```javascript
class LineageMiddleware {
  constructor(lineageCollector) {
    this.collector = lineageCollector;
  }

  /**
   * 数据库查询中间件
   */
  databaseMiddleware() {
    return async (ctx, next) => {
      const startTime = Date.now();

      await next();

      const duration = Date.now() - startTime;

      // 收集血缘信息
      if (ctx.state.dbQuery) {
        await this.collector.processDataEvent({
          eventId: this.generateEventId(),
          eventType: 'db_query',
          timestamp: new Date(),
          service: ctx.state.serviceName,
          operation: ctx.state.dbQuery.operation,
          source: ctx.state.serviceName,
          target: ctx.state.dbQuery.table,
          metadata: {
            database: ctx.state.dbQuery.database,
            table: ctx.state.dbQuery.table,
            columns: ctx.state.dbQuery.columns,
            rowCount: ctx.state.dbQuery.rowCount,
            query: ctx.state.dbQuery.query,
            duration,
            traceId: ctx.state.traceId
          }
        });
      }
    };
  }

  /**
   * API 调用中间件
   */
  apiMiddleware() {
    return async (ctx, next) => {
      const startTime = Date.now();

      await next();

      // 收集 API 调用血缘
      if (ctx.state.apiCall) {
        await this.collector.processDataEvent({
          eventId: this.generateEventId(),
          eventType: 'api_call',
          timestamp: new Date(),
          service: ctx.state.serviceName,
          operation: ctx.method,
          source: ctx.state.serviceName,
          target: ctx.state.apiCall.targetService,
          metadata: {
            targetService: ctx.state.apiCall.targetService,
            endpoint: ctx.path,
            requestBody: ctx.request.body,
            responseBody: ctx.body,
            duration: Date.now() - startTime,
            traceId: ctx.state.traceId
          }
        });
      }
    };
  }

  /**
   * 生成事件 ID
   */
  generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

module.exports = LineageMiddleware;
```

### 4. 管理后台 API

**文件：** `admin-dashboard/src/api/lineage.js`

```javascript
const express = require('express');
const router = express.Router();
const LineageQuery = require('../../../shared/dataLineage/LineageQuery');

const lineageQuery = new LineageQuery(db);

/**
 * 查询节点上游血缘
 */
router.get('/nodes/:nodeId/upstream', async (req, res) => {
  const { nodeId } = req.params;
  const { depth = 5 } = req.query;

  try {
    const upstream = await lineageQuery.queryUpstream(nodeId, parseInt(depth));
    res.json({ success: true, data: upstream });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 查询节点下游血缘
 */
router.get('/nodes/:nodeId/downstream', async (req, res) => {
  const { nodeId } = req.params;
  const { depth = 5 } = req.query;

  try {
    const downstream = await lineageQuery.queryDownstream(nodeId, parseInt(depth));
    res.json({ success: true, data: downstream });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 查询完整血缘图谱
 */
router.get('/nodes/:nodeId/graph', async (req, res) => {
  const { nodeId } = req.params;
  const { depth = 3 } = req.query;

  try {
    const lineage = await lineageQuery.queryFullLineage(nodeId, parseInt(depth));
    res.json({ success: true, data: lineage });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 影响分析
 */
router.post('/nodes/:nodeId/impact-analysis', async (req, res) => {
  const { nodeId } = req.params;
  const { changeType } = req.body;

  try {
    const analysis = await lineageQuery.analyzeImpact(nodeId, changeType);
    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 根因分析
 */
router.post('/nodes/:nodeId/root-cause-analysis', async (req, res) => {
  const { nodeId } = req.params;
  const { issueType } = req.body;

  try {
    const analysis = await lineageQuery.analyzeRootCause(nodeId, issueType);
    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 5. 前端可视化组件

**文件：** `admin-dashboard/src/components/LineageGraph.vue`

```vue
<template>
  <div class="lineage-graph">
    <div class="controls">
      <el-input
        v-model="searchNode"
        placeholder="搜索节点"
        style="width: 300px; margin-right: 10px;"
      />
      <el-slider
        v-model="depth"
        :min="1"
        :max="10"
        :step="1"
        style="width: 200px;"
      />
      <span style="margin-left: 10px;">深度: {{ depth }}</span>
    </div>

    <div ref="graphContainer" class="graph-container"></div>

    <div class="node-details" v-if="selectedNode">
      <h3>{{ selectedNode.id }}</h3>
      <p><strong>类型:</strong> {{ selectedNode.type }}</p>
      <p><strong>深度:</strong> {{ selectedNode.depth }}</p>
      
      <el-button @click="showUpstream">查看上游</el-button>
      <el-button @click="showDownstream">查看下游</el-button>
      <el-button @click="analyzeImpact" type="warning">影响分析</el-button>
      <el-button @click="analyzeRootCause" type="danger">根因分析</el-button>
    </div>

    <el-dialog
      v-model="impactDialogVisible"
      title="影响分析"
      width="60%"
    >
      <div v-if="impactAnalysis">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="影响级别">
            <el-tag :type="getImpactTag(impactAnalysis.impactLevel)">
              {{ impactAnalysis.impactLevel }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="受影响服务数">
            {{ impactAnalysis.affectedServices.length }}
          </el-descriptions-item>
          <el-descriptions-item label="受影响表数">
            {{ impactAnalysis.affectedTables.length }}
          </el-descriptions-item>
          <el-descriptions-item label="受影响 API 数">
            {{ impactAnalysis.affectedAPIs.length }}
          </el-descriptions-item>
        </el-descriptions>

        <div style="margin-top: 20px;">
          <h4>风险因素</h4>
          <el-table :data="impactAnalysis.riskAssessment">
            <el-table-column prop="type" label="类型" />
            <el-table-column prop="severity" label="严重性">
              <template #default="{ row }">
                <el-tag :type="getSeverityTag(row.severity)">
                  {{ row.severity }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="描述" />
          </el-table>
        </div>

        <div style="margin-top: 20px;">
          <h4>建议措施</h4>
          <el-table :data="impactAnalysis.recommendations">
            <el-table-column prop="type" label="类型" />
            <el-table-column prop="priority" label="优先级" />
            <el-table-column prop="description" label="描述" />
          </el-table>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import * as d3 from 'd3';
import axios from 'axios';

export default {
  name: 'LineageGraph',
  data() {
    return {
      searchNode: '',
      depth: 3,
      selectedNode: null,
      impactDialogVisible: false,
      impactAnalysis: null,
      graphData: null
    };
  },
  async mounted() {
    await this.loadGraph();
    this.renderGraph();
  },
  methods: {
    async loadGraph() {
      const response = await axios.get('/api/lineage/nodes/pokemon-service/graph', {
        params: { depth: this.depth }
      });
      this.graphData = response.data.data;
    },
    renderGraph() {
      const container = this.$refs.graphContainer;
      const width = container.clientWidth;
      const height = 600;

      // 清除现有图形
      d3.select(container).selectAll('*').remove();

      // 创建 SVG
      const svg = d3.select(container)
        .append('svg')
        .attr('width', width)
        .attr('height', height);

      // 创建力导向图
      const simulation = d3.forceSimulation(this.graphData.graph.nodes)
        .force('link', d3.forceLink(this.graphData.graph.edges).id(d => d.id))
        .force('charge', d3.forceManyBody().strength(-400))
        .force('center', d3.forceCenter(width / 2, height / 2));

      // 绘制边
      const link = svg.append('g')
        .selectAll('line')
        .data(this.graphData.graph.edges)
        .enter().append('line')
        .attr('stroke', '#999')
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 2);

      // 绘制节点
      const node = svg.append('g')
        .selectAll('g')
        .data(this.graphData.graph.nodes)
        .enter().append('g')
        .call(d3.drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended));

      // 节点圆圈
      node.append('circle')
        .attr('r', 20)
        .attr('fill', d => this.getNodeColor(d.type))
        .on('click', (event, d) => {
          this.selectedNode = d;
        });

      // 节点标签
      node.append('text')
        .text(d => d.id)
        .attr('x', 25)
        .attr('y', 5)
        .style('font-size', '12px');

      // 更新位置
      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        node.attr('transform', d => `translate(${d.x},${d.y})`);
      });

      // 拖拽函数
      function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }
    },
    getNodeColor(type) {
      const colors = {
        service: '#4CAF50',
        table: '#2196F3',
        api: '#FF9800',
        topic: '#9C27B0',
        cache: '#F44336'
      };
      return colors[type] || '#666';
    },
    async showUpstream() {
      const response = await axios.get(`/api/lineage/nodes/${this.selectedNode.id}/upstream`, {
        params: { depth: this.depth }
      });
      this.graphData.graph = response.data.data;
      this.renderGraph();
    },
    async showDownstream() {
      const response = await axios.get(`/api/lineage/nodes/${this.selectedNode.id}/downstream`, {
        params: { depth: this.depth }
      });
      this.graphData.graph = response.data.data;
      this.renderGraph();
    },
    async analyzeImpact() {
      const response = await axios.post(`/api/lineage/nodes/${this.selectedNode.id}/impact-analysis`, {
        changeType: 'schema_change'
      });
      this.impactAnalysis = response.data.data;
      this.impactDialogVisible = true;
    },
    async analyzeRootCause() {
      const response = await axios.post(`/api/lineage/nodes/${this.selectedNode.id}/root-cause-analysis`, {
        issueType: 'data_quality'
      });
      // 显示根因分析结果
    },
    getImpactTag(level) {
      const tags = {
        low: 'success',
        medium: 'info',
        high: 'warning',
        critical: 'danger'
      };
      return tags[level] || 'info';
    },
    getSeverityTag(severity) {
      const tags = {
        low: 'success',
        medium: 'warning',
        high: 'danger'
      };
      return tags[severity] || 'info';
    }
  }
};
</script>

<style scoped>
.lineage-graph {
  padding: 20px;
}

.graph-container {
  width: 100%;
  height: 600px;
  border: 1px solid #ddd;
  margin-top: 20px;
}

.node-details {
  margin-top: 20px;
  padding: 20px;
  background: #f5f5f5;
  border-radius: 4px;
}

.controls {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
}
</style>
```

## 验收标准

- [ ] 数据血缘采集器实现完成，支持数据库、API、消息队列、缓存血缘追踪
- [ ] 血缘查询系统实现完成，支持上下游查询、完整图谱查询
- [ ] 影响分析功能实现完成，支持变更影响评估
- [ ] 根因分析功能实现完成，支持数据质量问题追溯
- [ ] 管理后台 API 实现完成，提供血缘查询接口
- [ ] 前端可视化组件实现完成，支持 D3.js 力导向图展示
- [ ] 血缘中间件实现完成，自动采集血缘信息
- [ ] 数据库表结构创建完成，支持节点、边、血缘记录存储
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 性能测试：血缘查询响应时间 < 500ms（深度 5）
- [ ] 准确性测试：血缘关系准确率 ≥ 95%
- [ ] 可视化测试：支持 500+ 节点流畅渲染

## 影响范围

- **新建文件：**
  - `backend/shared/dataLineage/LineageCollector.js`
  - `backend/shared/dataLineage/LineageQuery.js`
  - `backend/shared/dataLineage/LineageMiddleware.js`
  - `admin-dashboard/src/api/lineage.js`
  - `admin-dashboard/src/components/LineageGraph.vue`
  - `backend/tests/unit/dataLineage/LineageCollector.test.js`
  - `backend/tests/unit/dataLineage/LineageQuery.test.js`
  - `database/migrations/XXXX_create_lineage_tables.sql`

- **修改文件：**
  - `所有微服务/index.js`（集成血缘中间件）
  - `gateway/src/index.js`（注册血缘路由）
  - `backend/shared/index.js`（导出数据血缘模块）
  - `Kafka 消费者配置`（订阅 data-events 主题）

- **依赖：**
  - `d3`（前端可视化）
  - `pg`（PostgreSQL 客户端）
  - `kafkajs`（Kafka 客户端）

## 参考

- [Apache Atlas](https://atlas.apache.org/)
- [DataHub](https://datahubproject.io/)
- [Amundsen](https://www.amundsen.io/)
- [D3.js Force-Directed Graph](https://github.com/d3/d3-force)
- [PostgreSQL Recursive Queries](https://www.postgresql.org/docs/current/queries-with.html)
