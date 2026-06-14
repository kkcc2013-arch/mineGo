# REQ-00199: 数据血缘追踪与影响分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00199 |
| 标题 | 数据血缘追踪与影响分析系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、database、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-14 15:00 |

## 需求描述

构建完整的数据血缘追踪系统，实现数据从采集、存储、处理到消费的全链路血缘关系可视化。支持数据影响分析、数据质量溯源、合规审计追踪等场景，为数据治理和合规性提供技术支撑。

### 核心目标

1. **数据血缘图谱构建**：自动捕获数据流转关系，构建数据血缘 DAG 图
2. **影响分析能力**：上游数据变更时，自动分析下游影响范围
3. **数据质量溯源**：数据质量问题时，快速定位问题源头
4. **合规审计追踪**：支持 GDPR、数据跨境传输等合规场景的血缘查询
5. **可视化展示**：提供交互式血缘图谱可视化界面

## 技术方案

### 1. 数据血缘采集层

**血缘元数据捕获**：
```javascript
// backend/shared/dataLineage/LineageCollector.js
class LineageCollector {
  constructor() {
    this.lineageStore = new LineageStore();
    this.captureHooks = new Map();
  }

  // 捕获数据库操作血缘
  captureDatabaseOperation(operation) {
    const lineage = {
      id: uuidv4(),
      timestamp: new Date(),
      operation: operation.type, // SELECT, INSERT, UPDATE, DELETE
      source: {
        service: operation.service,
        table: operation.table,
        columns: operation.columns,
        query: operation.query
      },
      target: operation.targetTable ? {
        service: operation.service,
        table: operation.targetTable,
        columns: operation.targetColumns
      } : null,
      context: {
        userId: operation.userId,
        requestId: operation.requestId,
        traceId: operation.traceId
      }
    };

    this.lineageStore.record(lineage);
    return lineage;
  }

  // 捕获 API 数据流转血缘
  captureAPIDataFlow(apiCall) {
    const lineage = {
      id: uuidv4(),
      timestamp: new Date(),
      type: 'API_DATA_FLOW',
      source: {
        service: apiCall.sourceService,
        endpoint: apiCall.sourceEndpoint,
        dataType: apiCall.responseType
      },
      target: {
        service: apiCall.targetService,
        endpoint: apiCall.targetEndpoint,
        operation: apiCall.operation
      },
      transformation: apiCall.transformation,
      context: apiCall.context
    };

    this.lineageStore.record(lineage);
    return lineage;
  }

  // 捕获事件驱动血缘
  captureEventLineage(event) {
    const lineage = {
      id: uuidv4(),
      timestamp: new Date(),
      type: 'EVENT_LINEAGE',
      source: {
        service: event.producer,
        topic: event.topic,
        eventType: event.type
      },
      target: {
        service: event.consumer,
        topic: event.topic,
        processing: event.processing
      },
      payload: {
        schema: event.schema,
        fields: event.fields
      },
      context: event.context
    };

    this.lineageStore.record(lineage);
    return lineage;
  }
}
```

**数据库中间件集成**：
```javascript
// backend/shared/dataLineage/DatabaseMiddleware.js
class LineageDatabaseMiddleware {
  constructor(lineageCollector) {
    this.collector = lineageCollector;
  }

  // 拦截 Sequelize 查询
  interceptSequelize(sequelize) {
    const originalQuery = sequelize.query.bind(sequelize);
    
    sequelize.query = async (sql, options) => {
      const startTime = Date.now();
      const result = await originalQuery(sql, options);
      
      // 解析 SQL 提取血缘信息
      const parsedSQL = this.parseSQL(sql);
      this.collector.captureDatabaseOperation({
        type: parsedSQL.operation,
        service: process.env.SERVICE_NAME,
        table: parsedSQL.table,
        columns: parsedSQL.columns,
        targetTable: parsedSQL.targetTable,
        targetColumns: parsedSQL.targetColumns,
        query: sql,
        userId: options?.context?.userId,
        requestId: options?.context?.requestId,
        traceId: options?.context?.traceId,
        duration: Date.now() - startTime
      });

      return result;
    };
  }

  parseSQL(sql) {
    // 使用 SQL 解析器提取表名、列名等信息
    const parser = new SQLParser();
    return parser.parse(sql);
  }
}
```

### 2. 血缘存储与索引层

**血缘图谱存储**：
```javascript
// backend/shared/dataLineage/LineageStore.js
class LineageStore {
  constructor() {
    // 使用图数据库存储血缘关系（Neo4j 或 PostgreSQL + 邻接表）
    this.graphStore = new GraphStore({
      type: process.env.LINEAGE_STORE_TYPE || 'postgresql'
    });
  }

  async record(lineage) {
    // 存储血缘节点
    await this.graphStore.addNode({
      id: lineage.id,
      type: lineage.type,
      data: lineage,
      timestamp: lineage.timestamp
    });

    // 创建血缘边
    if (lineage.source && lineage.target) {
      await this.graphStore.addEdge({
        from: this.getNodeId(lineage.source),
        to: this.getNodeId(lineage.target),
        type: 'FLOWS_TO',
        metadata: {
          operation: lineage.operation,
          transformation: lineage.transformation
        }
      });
    }
  }

  // 查询上游血缘
  async getUpstream(nodeId, depth = 5) {
    const query = `
      MATCH path = (target:Node {id: $nodeId})<-[:FLOWS_TO*1..${depth}]-(source:Node)
      RETURN path
    `;
    return await this.graphStore.query(query, { nodeId });
  }

  // 查询下游血缘
  async getDownstream(nodeId, depth = 5) {
    const query = `
      MATCH path = (source:Node {id: $nodeId})-[:FLOWS_TO*1..${depth}]->(target:Node)
      RETURN path
    `;
    return await this.graphStore.query(query, { nodeId });
  }

  // 获取完整血缘图谱
  async getLineageGraph(nodeId, options = {}) {
    const upstream = await this.getUpstream(nodeId, options.upstreamDepth || 5);
    const downstream = await this.getDownstream(nodeId, options.downstreamDepth || 5);
    
    return {
      nodeId,
      upstream: this.buildGraph(upstream),
      downstream: this.buildGraph(downstream)
    };
  }
}
```

**血缘索引优化**：
```sql
-- database/migrations/20260614_add_lineage_indexes.sql
CREATE TABLE data_lineage_nodes (
  id UUID PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  service VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL, -- table, api, event
  resource_name VARCHAR(255) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE data_lineage_edges (
  id UUID PRIMARY KEY,
  source_node_id UUID NOT NULL REFERENCES data_lineage_nodes(id),
  target_node_id UUID NOT NULL REFERENCES data_lineage_nodes(id),
  edge_type VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 血缘查询索引
CREATE INDEX idx_lineage_nodes_service ON data_lineage_nodes(service);
CREATE INDEX idx_lineage_nodes_resource ON data_lineage_nodes(resource_type, resource_name);
CREATE INDEX idx_lineage_edges_source ON data_lineage_edges(source_node_id);
CREATE INDEX idx_lineage_edges_target ON data_lineage_edges(target_node_id);

-- 血缘路径查询优化（使用递归 CTE）
CREATE MATERIALIZED VIEW lineage_summary AS
WITH RECURSIVE upstream AS (
  SELECT source_node_id, target_node_id, 1 as depth
  FROM data_lineage_edges
  WHERE target_node_id = :nodeId
  
  UNION ALL
  
  SELECT e.source_node_id, e.target_node_id, up.depth + 1
  FROM data_lineage_edges e
  JOIN upstream up ON e.target_node_id = up.source_node_id
  WHERE up.depth < 10
)
SELECT * FROM upstream;
```

### 3. 影响分析引擎

**数据变更影响分析**：
```javascript
// backend/shared/dataLineage/ImpactAnalyzer.js
class ImpactAnalyzer {
  constructor(lineageStore) {
    this.store = lineageStore;
  }

  // 分析表结构变更影响
  async analyzeSchemaChange(change) {
    const nodeId = this.getNodeId(change.table, change.service);
    const downstream = await this.store.getDownstream(nodeId, 10);
    
    const impacts = {
      direct: [],
      indirect: [],
      critical: []
    };

    for (const edge of downstream.edges) {
      const impact = {
        service: edge.target.service,
        resource: edge.target.resource,
        type: edge.target.type,
        risk: this.assessRisk(edge, change)
      };

      if (edge.depth === 1) {
        impacts.direct.push(impact);
      } else {
        impacts.indirect.push(impact);
      }

      if (impact.risk === 'HIGH') {
        impacts.critical.push(impact);
      }
    }

    return impacts;
  }

  // 评估变更风险
  assessRisk(edge, change) {
    const criticalServices = ['payment-service', 'user-service'];
    
    if (criticalServices.includes(edge.target.service)) {
      return 'HIGH';
    }

    if (change.type === 'DROP_COLUMN' && edge.metadata.columns?.includes(change.column)) {
      return 'HIGH';
    }

    if (change.type === 'RENAME_COLUMN') {
      return 'MEDIUM';
    }

    return 'LOW';
  }

  // 数据质量问题溯源
  async traceQualityIssue(issue) {
    const nodeId = this.getNodeId(issue.table, issue.service);
    const upstream = await this.store.getUpstream(nodeId, 10);
    
    const sources = [];
    for (const edge of upstream.edges) {
      sources.push({
        service: edge.source.service,
        resource: edge.source.resource,
        type: edge.source.type,
        contribution: this.calculateContribution(edge, issue)
      });
    }

    return {
      issue,
      sources: sources.sort((a, b) => b.contribution - a.contribution),
      rootCause: sources[0]
    };
  }
}
```

### 4. 合规审计追踪

**GDPR 数据血缘查询**：
```javascript
// backend/shared/dataLineage/ComplianceAuditor.js
class ComplianceAuditor {
  constructor(lineageStore) {
    this.store = lineageStore;
  }

  // GDPR 数据删除影响分析
  async analyzeGDPRDeletion(userId) {
    // 查找所有包含用户数据的节点
    const userNodes = await this.store.query(`
      MATCH (n:Node)
      WHERE n.metadata->>'userId' = $userId
         OR n.metadata->>'user_id' = $userId
      RETURN n
    `, { userId });

    // 对每个节点分析下游影响
    const impacts = [];
    for (const node of userNodes) {
      const downstream = await this.store.getDownstream(node.id, 5);
      impacts.push({
        source: node,
        affectedServices: this.extractServices(downstream),
        requiresManualReview: this.requiresManualReview(downstream)
      });
    }

    return {
      userId,
      dataLocations: userNodes.length,
      impacts,
      summary: this.generateDeletionPlan(impacts)
    };
  }

  // 数据跨境传输血缘追踪
  async traceCrossBorderTransfer(dataId) {
    const lineage = await this.store.getLineageGraph(dataId);
    
    const transfers = [];
    for (const edge of lineage.downstream.edges) {
      const sourceRegion = await this.getServiceRegion(edge.source.service);
      const targetRegion = await this.getServiceRegion(edge.target.service);
      
      if (sourceRegion !== targetRegion) {
        transfers.push({
          from: { service: edge.source.service, region: sourceRegion },
          to: { service: edge.target.service, region: targetRegion },
          timestamp: edge.timestamp,
          dataTypes: edge.metadata.dataTypes
        });
      }
    }

    return {
      dataId,
      transfers,
      compliance: this.checkCompliance(transfers)
    };
  }
}
```

### 5. 可视化服务

**血缘图谱可视化 API**：
```javascript
// backend/services/data-lineage-service/src/routes/visualization.js
const express = require('express');
const router = express.Router();

// 获取血缘图谱
router.get('/graph/:nodeId', async (req, res) => {
  const { nodeId } = req.params;
  const { upstreamDepth = 5, downstreamDepth = 5 } = req.query;

  const graph = await lineageStore.getLineageGraph(nodeId, {
    upstreamDepth: parseInt(upstreamDepth),
    downstreamDepth: parseInt(downstreamDepth)
  });

  // 转换为前端可视化格式（D3.js 或 Cytoscape.js）
  const visualization = {
    nodes: this.convertNodes(graph),
    edges: this.convertEdges(graph),
    layout: 'hierarchical'
  };

  res.json(visualization);
});

// 影响分析接口
router.post('/impact-analysis', async (req, res) => {
  const { change } = req.body;
  
  const analysis = await impactAnalyzer.analyzeSchemaChange(change);
  
  res.json({
    change,
    impacts: analysis,
    recommendations: generateRecommendations(analysis)
  });
});

// 合规审计接口
router.get('/compliance/gdpr/:userId', async (req, res) => {
  const { userId } = req.params;
  
  const audit = await complianceAuditor.analyzeGDPRDeletion(userId);
  
  res.json(audit);
});
```

### 6. 监控与告警

**血缘质量监控**：
```javascript
// backend/shared/dataLineage/LineageMonitor.js
class LineageMonitor {
  constructor() {
    this.metrics = {
      lineageCaptureTotal: new Counter({
        name: 'lineage_capture_total',
        help: 'Total number of lineage captures',
        labelNames: ['service', 'type']
      }),
      lineageQueryDuration: new Histogram({
        name: 'lineage_query_duration_seconds',
        help: 'Lineage query duration',
        labelNames: ['query_type']
      }),
      brokenLineageEdges: new Gauge({
        name: 'lineage_broken_edges',
        help: 'Number of broken lineage edges'
      })
    };
  }

  // 检测断裂的血缘链路
  async detectBrokenLineages() {
    const broken = await this.store.query(`
      MATCH (n:Node)-[e:FLOWS_TO]->(m:Node)
      WHERE NOT (m)-[:FLOWS_TO]->()
        AND m.type = 'TABLE'
        AND m.metadata->>'is_active' = 'true'
      RETURN n, e, m
    `);

    this.metrics.brokenLineageEdges.set(broken.length);

    if (broken.length > 10) {
      await alertManager.sendAlert({
        severity: 'WARNING',
        message: `Detected ${broken.length} broken lineage edges`,
        details: broken
      });
    }
  }
}
```

## 验收标准

- [ ] 数据血缘采集层完成，支持数据库、API、事件三种血缘捕获
- [ ] 血缘图谱存储完成，支持 PostgreSQL 和 Neo4j 两种存储后端
- [ ] 影响分析引擎完成，支持表结构变更影响分析
- [ ] 数据质量溯源功能完成，支持问题源头定位
- [ ] GDPR 数据删除影响分析完成，支持合规审计
- [ ] 数据跨境传输血缘追踪完成
- [ ] 血缘图谱可视化 API 完成，支持交互式展示
- [ ] 血缘质量监控完成，支持断裂链路检测和告警
- [ ] 性能达标：血缘查询响应时间 < 500ms（深度 ≤ 5）
- [ ] 测试覆盖：核心模块单元测试覆盖率 ≥ 80%

## 影响范围

- **新增服务**：data-lineage-service（可选，可集成到现有服务）
- **新增模块**：backend/shared/dataLineage/
- **数据库变更**：新增 data_lineage_nodes、data_lineage_edges 表
- **中间件集成**：所有微服务的数据库中间件需集成血缘捕获
- **监控集成**：新增血缘相关 Prometheus 指标
- **文档更新**：新增数据血缘使用指南和最佳实践文档

## 参考

- [Apache Atlas - Data Governance](https://atlas.apache.org/)
- [Data Lineage Best Practices](https://www.dataversity.net/data-lineage-best-practices/)
- [GDPR Compliance and Data Lineage](https://gdpr.eu/data-lineage/)
- [Neo4j Graph Database](https://neo4j.com/)
- [SQL Parser Library](https://github.com/taozhi8833998/node-sql-parser)
