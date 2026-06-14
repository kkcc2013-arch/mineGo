# REQ-00187：数据血缘追踪与变更历史溯源系统

- **编号**：REQ-00187
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/dataLineage.js、所有微服务、database/migrations、gateway、admin-dashboard
- **创建时间**：2026-06-14 07:03
- **依赖需求**：REQ-00038（审计日志）、REQ-00129（精灵数据备份）

## 1. 背景与问题

当前 mineGo 项目在数据变更追踪方面存在以下问题：

1. **缺乏系统级血缘追踪**：仅有 `pokemon_lineage` 表追踪精灵培育血缘，但核心业务数据（用户精灵、背包物品、货币交易）的变更没有血缘关系记录
2. **变更溯源困难**：当用户投诉精灵丢失、道具异常扣减时，运维人员需要手动排查多张表和多条日志，效率低下
3. **数据恢复风险**：数据备份恢复时缺乏变更影响范围分析，可能导致部分关联数据不一致
4. **合规审计需求**：GDPR 和数据保护法规要求数据处理活动可追溯，当前无法满足

经代码审查：
- `pokemon_lineage` 仅用于培育系统，字段固定且不可扩展
- `auditLog.js` 记录操作日志但不记录数据关系血缘
- 各微服务数据变更独立，缺乏统一的血缘追踪基础设施

## 2. 目标

1. 建立统一的数据血缘追踪基础设施，记录实体间的创建、修改、删除关系
2. 提供变更溯源查询 API，快速定位数据异常的根因
3. 支持血缘图可视化，辅助运维人员进行影响范围分析
4. 满足合规审计要求，提供完整的数据处理活动记录

## 3. 范围

### 包含

- 数据血缘追踪核心模块（dataLineage.js）
- 血缘记录数据库表设计与迁移
- 变更溯源查询 API
- 与现有审计日志系统的集成
- 管理后台血缘可视化组件
- 单元测试与集成测试

### 不包含

- 实时血缘图谱流式处理（可用 Kafka 后续扩展）
- 跨区域数据血缘同步
- 自动化数据修复功能

## 4. 详细需求

### 4.1 数据库表设计

```sql
-- database/pending/20260614_070300__add_data_lineage_system.sql

-- 数据血缘记录表
CREATE TABLE IF NOT EXISTS data_lineage (
  id BIGSERIAL PRIMARY KEY,
  lineage_type VARCHAR(20) NOT NULL CHECK (lineage_type IN ('creation', 'mutation', 'deletion', 'transfer', 'split', 'merge')),
  
  -- 源实体
  source_entity_type VARCHAR(50) NOT NULL,  -- 'pokemon', 'item', 'currency', 'user', 'gym', etc.
  source_entity_id VARCHAR(100) NOT NULL,
  source_version INTEGER DEFAULT 1,
  
  -- 目标实体
  target_entity_type VARCHAR(50) NOT NULL,
  target_entity_id VARCHAR(100) NOT NULL,
  target_version INTEGER DEFAULT 1,
  
  -- 变更详情
  operation VARCHAR(100) NOT NULL,  -- 'evolve', 'trade', 'use_item', 'catch', 'release', etc.
  operation_id VARCHAR(100),        -- 关联的业务操作ID（如 trade_id, battle_id）
  
  -- 变更数据快照
  before_snapshot JSONB,
  after_snapshot JSONB,
  delta_fields JSONB,               -- 仅记录变更字段
  
  -- 元数据
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  service_name VARCHAR(50) NOT NULL,
  trace_id VARCHAR(64),             -- OpenTelemetry trace ID
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 性能索引
CREATE INDEX idx_lineage_source ON data_lineage(source_entity_type, source_entity_id);
CREATE INDEX idx_lineage_target ON data_lineage(target_entity_type, target_entity_id);
CREATE INDEX idx_lineage_user ON data_lineage(user_id);
CREATE INDEX idx_lineage_operation ON data_lineage(operation);
CREATE INDEX idx_lineage_time ON data_lineage(created_at);
CREATE INDEX idx_lineage_trace ON data_lineage(trace_id);

-- 血缘关系类型解释
COMMENT ON TABLE data_lineage IS '数据血缘追踪表：记录实体间的创建、变更、转移关系';
COMMENT ON COLUMN data_lineage.lineage_type IS '血缘类型：creation(创建), mutation(变更), deletion(删除), transfer(转移), split(拆分), merge(合并)';
COMMENT ON COLUMN data_lineage.source_entity_type IS '源实体类型';
COMMENT ON COLUMN data_lineage.target_entity_type IS '目标实体类型';
COMMENT ON COLUMN data_lineage.delta_fields IS '仅包含变更字段的差异';

-- 血缘影响范围缓存表（用于快速查询）
CREATE TABLE IF NOT EXISTS lineage_impact_cache (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  impacted_entities JSONB NOT NULL,  -- [{entity_type, entity_id, depth}]
  computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  
  UNIQUE(entity_type, entity_id)
);

CREATE INDEX idx_impact_cache_expire ON lineage_impact_cache(expires_at);
```

### 4.2 血缘追踪核心模块

```javascript
// backend/shared/dataLineage.js
'use strict';

const { createLogger } = require('./logger');
const { getTracer } = require('./tracing');
const { context, trace } = require('@opentelemetry/api');

const logger = createLogger('data-lineage');
const tracer = getTracer('data-lineage');

const LINEAGE_TYPES = {
  CREATION: 'creation',
  MUTATION: 'mutation',
  DELETION: 'deletion',
  TRANSFER: 'transfer',
  SPLIT: 'split',
  MERGE: 'merge'
};

/**
 * Data Lineage Tracker
 * 记录实体间的血缘关系
 */
class DataLineageTracker {
  constructor(db) {
    this.db = db;
  }

  /**
   * 记录实体创建血缘
   */
  async recordCreation(params) {
    return this._recordLineage({
      lineageType: LINEAGE_TYPES.CREATION,
      ...params
    });
  }

  /**
   * 记录实体变更血缘
   */
  async recordMutation(params) {
    return this._recordLineage({
      lineageType: LINEAGE_TYPES.MUTATION,
      ...params
    });
  }

  /**
   * 记录实体删除血缘
   */
  async recordDeletion(params) {
    return this._recordLineage({
      lineageType: LINEAGE_TYPES.DELETION,
      ...params
    });
  }

  /**
   * 记录实体转移血缘（如交易、赠送）
   */
  async recordTransfer(params) {
    return this._recordLineage({
      lineageType: LINEAGE_TYPES.TRANSFER,
      ...params
    });
  }

  /**
   * 核心血缘记录方法
   */
  async _recordLineage(params) {
    const {
      lineageType,
      sourceType = null,
      sourceId = null,
      sourceVersion = 1,
      targetType,
      targetId,
      targetVersion = 1,
      operation,
      operationId = null,
      beforeSnapshot = null,
      afterSnapshot = null,
      deltaFields = null,
      userId = null,
      serviceName
    } = params;

    // 获取当前 trace ID
    const currentSpan = trace.getSpan(context.active());
    const traceId = currentSpan?.spanContext()?.traceId || null;

    const result = await this.db.query(`
      INSERT INTO data_lineage (
        lineage_type,
        source_entity_type, source_entity_id, source_version,
        target_entity_type, target_entity_id, target_version,
        operation, operation_id,
        before_snapshot, after_snapshot, delta_fields,
        user_id, service_name, trace_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
    `, [
      lineageType,
      sourceType, sourceId, sourceVersion,
      targetType, targetId, targetVersion,
      operation, operationId,
      JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot), JSON.stringify(deltaFields),
      userId, serviceName, traceId
    ]);

    logger.info('Data lineage recorded', {
      lineageId: result.rows[0].id,
      lineageType,
      operation,
      targetType,
      targetId
    });

    return result.rows[0].id;
  }

  /**
   * 查询实体的完整血缘链（向上追溯）
   */
  async traceUpstream(entityType, entityId, maxDepth = 10) {
    const result = await this.db.query(`
      WITH RECURSIVE upstream AS (
        SELECT 
          id, lineage_type, 
          source_entity_type, source_entity_id,
          target_entity_type, target_entity_id,
          operation, operation_id,
          before_snapshot, after_snapshot, delta_fields,
          user_id, created_at,
          1 as depth
        FROM data_lineage
        WHERE target_entity_type = $1 AND target_entity_id = $2
        
        UNION ALL
        
        SELECT 
          dl.id, dl.lineage_type,
          dl.source_entity_type, dl.source_entity_id,
          dl.target_entity_type, dl.target_entity_id,
          dl.operation, dl.operation_id,
          dl.before_snapshot, dl.after_snapshot, dl.delta_fields,
          dl.user_id, dl.created_at,
          u.depth + 1
        FROM data_lineage dl
        JOIN upstream u ON dl.target_entity_type = u.source_entity_type 
                       AND dl.target_entity_id = u.source_entity_id
        WHERE u.depth < $3
      )
      SELECT * FROM upstream ORDER BY depth, created_at
    `, [entityType, entityId, maxDepth]);

    return result.rows;
  }

  /**
   * 查询实体的影响范围（向下追溯）
   */
  async traceDownstream(entityType, entityId, maxDepth = 10) {
    const result = await this.db.query(`
      WITH RECURSIVE downstream AS (
        SELECT 
          id, lineage_type,
          source_entity_type, source_entity_id,
          target_entity_type, target_entity_id,
          operation, operation_id,
          before_snapshot, after_snapshot, delta_fields,
          user_id, created_at,
          1 as depth
        FROM data_lineage
        WHERE source_entity_type = $1 AND source_entity_id = $2
        
        UNION ALL
        
        SELECT 
          dl.id, dl.lineage_type,
          dl.source_entity_type, dl.source_entity_id,
          dl.target_entity_type, dl.target_entity_id,
          dl.operation, dl.operation_id,
          dl.before_snapshot, dl.after_snapshot, dl.delta_fields,
          dl.user_id, dl.created_at,
          d.depth + 1
        FROM data_lineage dl
        JOIN downstream d ON dl.source_entity_type = d.target_entity_type 
                         AND dl.source_entity_id = d.target_entity_id
        WHERE d.depth < $3
      )
      SELECT * FROM downstream ORDER BY depth, created_at
    `, [entityType, entityId, maxDepth]);

    return result.rows;
  }

  /**
   * 获取实体变更历史
   */
  async getChangeHistory(entityType, entityId, options = {}) {
    const { limit = 50, offset = 0, operation = null } = options;
    
    let query = `
      SELECT 
        id, lineage_type, operation, operation_id,
        before_snapshot, after_snapshot, delta_fields,
        user_id, service_name, trace_id, created_at
      FROM data_lineage
      WHERE target_entity_type = $1 AND target_entity_id = $2
    `;
    const params = [entityType, entityId];
    
    if (operation) {
      query += ` AND operation = $${params.length + 1}`;
      params.push(operation);
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 获取血缘图数据（用于可视化）
   */
  async getLineageGraph(entityType, entityId, depth = 3) {
    const upstream = await this.traceUpstream(entityType, entityId, depth);
    const downstream = await this.traceDownstream(entityType, entityId, depth);

    const nodes = new Map();
    const edges = [];

    // 添加目标实体节点
    nodes.set(`${entityType}:${entityId}`, {
      id: `${entityType}:${entityId}`,
      type: entityType,
      entityId,
      isRoot: true
    });

    // 处理上游血缘
    for (const lineage of upstream) {
      const sourceKey = `${lineage.source_entity_type}:${lineage.source_entity_id}`;
      const targetKey = `${lineage.target_entity_type}:${lineage.target_entity_id}`;

      if (lineage.source_entity_id) {
        nodes.set(sourceKey, {
          id: sourceKey,
          type: lineage.source_entity_type,
          entityId: lineage.source_entity_id
        });
      }

      nodes.set(targetKey, {
        id: targetKey,
        type: lineage.target_entity_type,
        entityId: lineage.target_entity_id
      });

      edges.push({
        source: sourceKey,
        target: targetKey,
        operation: lineage.operation,
        lineageType: lineage.lineage_type,
        timestamp: lineage.created_at
      });
    }

    // 处理下游血缘
    for (const lineage of downstream) {
      const sourceKey = `${lineage.source_entity_type}:${lineage.source_entity_id}`;
      const targetKey = `${lineage.target_entity_type}:${lineage.target_entity_id}`;

      nodes.set(sourceKey, {
        id: sourceKey,
        type: lineage.source_entity_type,
        entityId: lineage.source_entity_id
      });

      if (lineage.target_entity_id) {
        nodes.set(targetKey, {
          id: targetKey,
          type: lineage.target_entity_type,
          entityId: lineage.target_entity_id
        });
      }

      edges.push({
        source: sourceKey,
        target: targetKey,
        operation: lineage.operation,
        lineageType: lineage.lineage_type,
        timestamp: lineage.created_at
      });
    }

    return {
      nodes: Array.from(nodes.values()),
      edges
    };
  }
}

let lineageTracker = null;

function getLineageTracker(db) {
  if (!lineageTracker) {
    lineageTracker = new DataLineageTracker(db);
  }
  return lineageTracker;
}

module.exports = {
  DataLineageTracker,
  getLineageTracker,
  LINEAGE_TYPES
};
```

### 4.3 微服务集成示例

```javascript
// pokemon-service 精灵进化血缘追踪
const { getLineageTracker, LINEAGE_TYPES } = require('../../shared/dataLineage');

async function evolvePokemon(pokemonId, targetSpeciesId) {
  const lineageTracker = getLineageTracker(db);
  
  const beforeSnapshot = await getPokemonSnapshot(pokemonId);
  
  const evolvedPokemon = await db.query(`
    UPDATE user_pokemon 
    SET species_id = $1, evolved_at = NOW()
    WHERE id = $2
    RETURNING *
  `, [targetSpeciesId, pokemonId]);

  await lineageTracker.recordMutation({
    sourceType: 'pokemon',
    sourceId: String(pokemonId),
    targetType: 'pokemon',
    targetId: String(pokemonId),
    targetVersion: beforeSnapshot.version + 1,
    operation: 'evolve',
    operationId: `evolve_${pokemonId}_${Date.now()}`,
    beforeSnapshot,
    afterSnapshot: evolvedPokemon.rows[0],
    deltaFields: {
      species_id: { from: beforeSnapshot.species_id, to: targetSpeciesId },
      evolved_at: { from: null, to: new Date().toISOString() }
    },
    userId: beforeSnapshot.user_id,
    serviceName: 'pokemon-service'
  });

  return evolvedPokemon.rows[0];
}
```

### 4.4 查询 API

```javascript
// gateway/routes/lineage.js

/**
 * GET /api/admin/lineage/upstream/:entityType/:entityId
 * 查询实体上游血缘链
 */
router.get('/upstream/:entityType/:entityId', requireAdmin, async (req, res) => {
  const { entityType, entityId } = req.params;
  const { depth = 10 } = req.query;
  
  const lineageTracker = getLineageTracker(db);
  const result = await lineageTracker.traceUpstream(entityType, entityId, parseInt(depth));
  
  res.json({ success: true, data: result });
});

/**
 * GET /api/admin/lineage/graph/:entityType/:entityId
 * 获取血缘图数据（用于可视化）
 */
router.get('/graph/:entityType/:entityId', requireAdmin, async (req, res) => {
  const { entityType, entityId } = req.params;
  const { depth = 3 } = req.query;
  
  const lineageTracker = getLineageTracker(db);
  const graph = await lineageTracker.getLineageGraph(entityType, entityId, parseInt(depth));
  
  res.json({ success: true, data: graph });
});
```

## 5. 验收标准（可测试）

- [ ] `data_lineage` 表正确创建，包含所有必要字段和索引
- [ ] `DataLineageTracker` 类支持 6 种血缘类型记录
- [ ] `traceUpstream()` 方法能正确追溯实体上游血缘（最大深度 10）
- [ ] `traceDownstream()` 方法能正确追踪实体下游影响范围
- [ ] `getLineageGraph()` 返回的图数据格式符合可视化要求
- [ ] `getChangeHistory()` 能分页查询实体变更历史
- [ ] 血缘记录与 OpenTelemetry trace ID 正确关联
- [ ] 管理后台血缘查询 API 正常工作
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 性能测试：血缘查询响应时间 < 500ms（深度 5 以内）

## 6. 工作量估算

**L** - 需要设计数据库表、实现核心模块、集成多个微服务、创建管理后台 API、编写测试

## 7. 优先级理由

数据血缘追踪是数据治理的核心能力，对运维效率、合规审计、数据恢复至关重要：

1. **运维效率**：用户投诉数据异常时，可快速定位根因
2. **合规审计**：满足 GDPR 等法规对数据处理活动可追溯的要求
3. **数据恢复**：提供基于快照的数据恢复能力
4. **影响分析**：评估数据变更的波及范围，降低操作风险

P1 优先级是因为这是系统稳定性和合规性的重要保障，应尽早建设。
