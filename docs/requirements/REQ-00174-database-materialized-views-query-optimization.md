# REQ-00174: 数据库物化视图与复杂查询优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00174 |
| 标题 | 数据库物化视图与复杂查询优化系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、social-service、gym-service、user-service、database/migrations、backend/shared |
| 创建时间 | 2026-06-13 23:05 |

## 需求描述

当前 mineGo 项目中存在多个高频复杂查询场景，涉及多表 JOIN、聚合计算和统计操作，例如：
- 精灵排行榜查询（pokemon-service）
- 玩家战绩统计（social-service）
- 道馆战斗历史分析（gym-service）
- 用户活跃度统计（user-service）

这些查询在大数据量下性能较差，响应时间经常超过 500ms，严重影响用户体验。需要引入**数据库物化视图（Materialized Views）**和**查询结果缓存**机制，将复杂查询的预计算结果存储，定期刷新，显著提升查询性能。

### 目标
1. 对 Top 10 慢查询进行物化视图优化，将平均响应时间降至 50ms 以下
2. 建立物化视图自动刷新机制，保证数据时效性
3. 实现查询路由智能切换，在物化视图和实时查询间自动选择
4. 提供 Materialized View 管理工具，支持创建、删除、刷新、监控

## 技术方案

### 1. 物化视图设计与实现

#### 1.1 精灵排行榜物化视图

```sql
-- database/migrations/20260613230500_create_pokemon_ranking_mv.sql

CREATE MATERIALIZED VIEW mv_pokemon_ranking AS
SELECT 
    p.id AS pokemon_id,
    p.species_id,
    p.user_id,
    p.level,
    p.combat_power,
    p.created_at,
    u.username,
    ROW_NUMBER() OVER (
        PARTITION BY p.species_id 
        ORDER BY p.combat_power DESC, p.level DESC
    ) AS species_rank,
    ROW_NUMBER() OVER (
        ORDER BY p.combat_power DESC, p.level DESC
    ) AS global_rank
FROM pokemons p
INNER JOIN users u ON p.user_id = u.id
WHERE p.is_deleted = false
ORDER BY p.combat_power DESC;

-- 创建索引
CREATE INDEX idx_mv_pokemon_ranking_species ON mv_pokemon_ranking(species_id, species_rank);
CREATE INDEX idx_mv_pokemon_ranking_global ON mv_pokemon_ranking(global_rank);
CREATE INDEX idx_mv_pokemon_ranking_user ON mv_pokemon_ranking(user_id);

-- 设置刷新策略（每 5 分钟）
COMMENT ON MATERIALIZED VIEW mv_pokemon_ranking IS 
'精灵排行榜物化视图 - 每 5 分钟自动刷新';
```

#### 1.2 玩家统计物化视图

```sql
-- database/migrations/20260613230501_create_user_stats_mv.sql

CREATE MATERIALIZED VIEW mv_user_stats AS
SELECT 
    u.id AS user_id,
    u.username,
    u.level AS user_level,
    COUNT(DISTINCT p.id) AS total_pokemon,
    MAX(p.combat_power) AS max_cp_pokemon,
    COUNT(DISTINCT CASE WHEN p.is_favorite THEN p.id END) AS favorite_count,
    COUNT(DISTINCT b.id) AS total_battles,
    COUNT(DISTINCT CASE WHEN b.result = 'win' THEN b.id END) AS win_count,
    COUNT(DISTINCT CASE WHEN b.result = 'lose' THEN b.id END) AS lose_count,
    COUNT(DISTINCT f.friend_id) AS friend_count,
    SUM(r.coins) AS total_coins,
    u.updated_at
FROM users u
LEFT JOIN pokemons p ON u.id = p.user_id AND p.is_deleted = false
LEFT JOIN battles b ON u.id = b.user_id
LEFT JOIN friendships f ON u.id = f.user_id
LEFT JOIN rewards r ON u.id = r.user_id
WHERE u.is_deleted = false
GROUP BY u.id, u.username, u.level, u.updated_at;

CREATE UNIQUE INDEX idx_mv_user_stats_user_id ON mv_user_stats(user_id);
CREATE INDEX idx_mv_user_stats_level ON mv_user_stats(user_level);
CREATE INDEX idx_mv_user_stats_battles ON mv_user_stats(total_battles DESC);

COMMENT ON MATERIALIZED VIEW mv_user_stats IS 
'玩家统计物化视图 - 每 10 分钟自动刷新';
```

#### 1.3 道馆活跃度物化视图

```sql
-- database/migrations/20260613230502_create_gym_activity_mv.sql

CREATE MATERIALIZED VIEW mv_gym_activity AS
SELECT 
    g.id AS gym_id,
    g.name AS gym_name,
    g.latitude,
    g.longitude,
    g.team_id,
    COUNT(DISTINCT b.id) AS total_battles_last_7d,
    COUNT(DISTINCT CASE WHEN b.created_at > NOW() - INTERVAL '24 hours' THEN b.id END) AS battles_last_24h,
    COUNT(DISTINCT CASE WHEN b.result = 'win' THEN b.user_id END) AS unique_winners,
    MAX(b.created_at) AS last_battle_time,
    COUNT(DISTINCT v.user_id) AS total_visitors,
    g.updated_at
FROM gyms g
LEFT JOIN battles b ON g.id = b.gym_id AND b.created_at > NOW() - INTERVAL '7 days'
LEFT JOIN gym_visits v ON g.id = v.gym_id AND v.created_at > NOW() - INTERVAL '7 days'
WHERE g.is_deleted = false
GROUP BY g.id, g.name, g.latitude, g.longitude, g.team_id, g.updated_at;

CREATE UNIQUE INDEX idx_mv_gym_activity_gym_id ON mv_gym_activity(gym_id);
CREATE INDEX idx_mv_gym_activity_location ON mv_gym_activity USING GIST(ll_to_earth(latitude, longitude));
CREATE INDEX idx_mv_gym_activity_team ON mv_gym_activity(team_id);
CREATE INDEX idx_mv_gym_activity_popularity ON mv_gym_activity(total_battles_last_7d DESC);

COMMENT ON MATERIALIZED VIEW mv_gym_activity IS 
'道馆活跃度物化视图 - 每 15 分钟自动刷新';
```

### 2. 物化视图管理工具

```javascript
// backend/shared/MaterializedViewManager.js

const { Pool } = require('pg');
const logger = require('./logger');
const metrics = require('./metrics');

class MaterializedViewManager {
  constructor(pool) {
    this.pool = pool;
    this.views = new Map();
    this.refreshIntervals = new Map();
  }

  /**
   * 注册物化视图
   */
  registerView(config) {
    const {
      name,
      tableName,
      refreshInterval, // 刷新间隔（毫秒）
      refreshStrategy = 'CONCURRENT', // CONCURRENT | FULL
      indexes = [],
      dependencies = []
    } = config;

    this.views.set(name, {
      tableName,
      refreshInterval,
      refreshStrategy,
      indexes,
      dependencies,
      lastRefresh: null,
      isRefreshing: false
    });

    logger.info(`Registered materialized view: ${name}`, {
      refreshInterval,
      refreshStrategy
    });
  }

  /**
   * 刷新物化视图
   */
  async refreshView(name, options = {}) {
    const view = this.views.get(name);
    if (!view) {
      throw new Error(`Materialized view not found: ${name}`);
    }

    if (view.isRefreshing && !options.force) {
      logger.warn(`View ${name} is already refreshing, skipping`);
      return false;
    }

    const startTime = Date.now();
    view.isRefreshing = true;

    try {
      const strategy = options.strategy || view.refreshStrategy;
      let query;

      if (strategy === 'CONCURRENT') {
        // 并发刷新，不阻塞查询
        query = `REFRESH MATERIALIZED VIEW CONCURRENTLY ${view.tableName}`;
      } else {
        // 完全刷新，会短暂阻塞查询
        query = `REFRESH MATERIALIZED VIEW ${view.tableName}`;
      }

      await this.pool.query(query);

      const duration = Date.now() - startTime;
      view.lastRefresh = new Date();
      view.isRefreshing = false;

      // 记录指标
      metrics.histogram('materialized_view_refresh_duration_ms', duration, {
        view: name,
        strategy
      });

      logger.info(`Refreshed materialized view: ${name}`, {
        duration,
        strategy
      });

      return true;
    } catch (error) {
      view.isRefreshing = false;

      metrics.increment('materialized_view_refresh_errors', {
        view: name
      });

      logger.error(`Failed to refresh materialized view: ${name}`, {
        error: error.message,
        stack: error.stack
      });

      throw error;
    }
  }

  /**
   * 启动自动刷新
   */
  startAutoRefresh() {
    for (const [name, view] of this.views) {
      if (view.refreshInterval > 0) {
        const interval = setInterval(async () => {
          try {
            await this.refreshView(name);
          } catch (error) {
            logger.error(`Auto-refresh failed for ${name}`, {
              error: error.message
            });
          }
        }, view.refreshInterval);

        this.refreshIntervals.set(name, interval);
        logger.info(`Started auto-refresh for ${name} every ${view.refreshInterval}ms`);
      }
    }
  }

  /**
   * 停止所有自动刷新
   */
  stopAutoRefresh() {
    for (const [name, interval] of this.refreshIntervals) {
      clearInterval(interval);
      logger.info(`Stopped auto-refresh for ${name}`);
    }
    this.refreshIntervals.clear();
  }

  /**
   * 查询物化视图状态
   */
  async getViewStatus(name) {
    const view = this.views.get(name);
    if (!view) {
      throw new Error(`Materialized view not found: ${name}`);
    }

    const result = await this.pool.query(`
      SELECT 
        schemaname,
        matviewname,
        matviewowner,
        tablespace,
        hasindexes,
        ispopulated,
        definition
      FROM pg_matviews
      WHERE matviewname = $1
    `, [view.tableName]);

    if (result.rows.length === 0) {
      return null;
    }

    const stats = await this.pool.query(`
      SELECT 
        COUNT(*) AS row_count,
        pg_size_pretty(pg_total_relation_size($1)) AS size
      FROM ${view.tableName}
    `, [view.tableName]);

    return {
      ...result.rows[0],
      rowCount: stats.rows[0].row_count,
      size: stats.rows[0].size,
      lastRefresh: view.lastRefresh,
      isRefreshing: view.isRefreshing
    };
  }

  /**
   * 手动刷新所有视图
   */
  async refreshAll(options = {}) {
    const results = [];
    const { parallel = false, strategy = 'CONCURRENT' } = options;

    if (parallel) {
      // 并行刷新所有视图
      const promises = Array.from(this.views.keys()).map(name =>
        this.refreshView(name, { strategy }).catch(err => ({
          name,
          error: err.message
        }))
      );
      const settled = await Promise.allSettled(promises);
      return settled.map((s, i) => ({
        name: Array.from(this.views.keys())[i],
        ...s
      }));
    } else {
      // 顺序刷新，考虑依赖关系
      for (const [name, view] of this.views) {
        // 先刷新依赖项
        for (const dep of view.dependencies) {
          await this.refreshView(dep, { strategy });
        }
        
        const result = await this.refreshView(name, { strategy });
        results.push({ name, success: result });
      }
    }

    return results;
  }

  /**
   * 清理过期数据
   */
  async cleanupOldData() {
    // 删除超过 30 天未刷新的物化视图
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    for (const [name, view] of this.views) {
      if (view.lastRefresh && view.lastRefresh < thirtyDaysAgo) {
        logger.warn(`Materialized view ${name} hasn't been refreshed in 30 days`);
      }
    }
  }
}

// 单例实例
let instance = null;

function getMaterializedViewManager(pool) {
  if (!instance) {
    instance = new MaterializedViewManager(pool);
  }
  return instance;
}

module.exports = {
  MaterializedViewManager,
  getMaterializedViewManager
};
```

### 3. 查询路由器（智能切换）

```javascript
// backend/shared/QueryRouter.js

const logger = require('./logger');
const metrics = require('./metrics');

class QueryRouter {
  constructor(pool, mvManager) {
    this.pool = pool;
    this.mvManager = mvManager;
    this.queryThresholds = new Map();
  }

  /**
   * 设置查询阈值（超过该值则使用物化视图）
   */
  setThreshold(queryName, threshold) {
    this.queryThresholds.set(queryName, threshold);
  }

  /**
   * 执行查询，自动选择实时表或物化视图
   */
  async executeQuery(options) {
    const {
      name,
      realtimeQuery,
      mvQuery,
      params = [],
      threshold = 100, // 行数阈值
      maxAge = 5 * 60 * 1000, // 数据最大年龄（毫秒）
      forceRealtime = false
    } = options;

    const startTime = Date.now();

    try {
      // 强制实时查询
      if (forceRealtime) {
        const result = await this.pool.query(realtimeQuery, params);
        metrics.histogram('query_duration_ms', Date.now() - startTime, {
          name,
          type: 'realtime',
          forced: true
        });
        return { data: result.rows, source: 'realtime' };
      }

      // 估算实时查询成本
      const explainResult = await this.pool.query(
        `EXPLAIN (FORMAT JSON) ${realtimeQuery}`,
        params
      );
      const estimatedCost = explainResult.rows[0]['QUERY PLAN'][0].Plan['Total Cost'];
      const estimatedRows = explainResult.rows[0]['QUERY PLAN'][0].Plan['Plan Rows'];

      // 决策：使用物化视图还是实时查询
      const shouldUseMV = 
        estimatedRows > threshold ||
        estimatedCost > 1000;

      if (shouldUseMV && mvQuery) {
        // 使用物化视图
        const result = await this.pool.query(mvQuery, params);
        const duration = Date.now() - startTime;

        metrics.histogram('query_duration_ms', duration, {
          name,
          type: 'materialized_view'
        });

        logger.debug(`Used materialized view for ${name}`, {
          estimatedCost,
          estimatedRows,
          duration
        });

        return { data: result.rows, source: 'materialized_view' };
      } else {
        // 使用实时查询
        const result = await this.pool.query(realtimeQuery, params);
        const duration = Date.now() - startTime;

        metrics.histogram('query_duration_ms', duration, {
          name,
          type: 'realtime'
        });

        logger.debug(`Used realtime query for ${name}`, {
          estimatedCost,
          estimatedRows,
          duration
        });

        return { data: result.rows, source: 'realtime' };
      }
    } catch (error) {
      metrics.increment('query_errors', { name });

      logger.error(`Query execution failed for ${name}`, {
        error: error.message
      });

      throw error;
    }
  }

  /**
   * 批量查询（自动合并）
   */
  async executeBatch(queries) {
    // 使用 WITH 子句合并多个查询
    const cteParts = queries.map((q, i) => {
      if (q.mvQuery) {
        return `q${i} AS (${q.mvQuery})`;
      }
      return `q${i} AS (${q.realtimeQuery})`;
    }).join(',\n');

    const query = `WITH ${cteParts} SELECT ${queries.map((_, i) => `(SELECT * FROM q${i}) AS result${i}`).join(',\n')}`;

    // 注意：这里简化了实现，实际需要更复杂的参数处理
    const result = await this.pool.query(query);
    return result.rows;
  }
}

module.exports = QueryRouter;
```

### 4. 服务层集成示例

```javascript
// backend/services/social-service/src/routes/ranking.js

const Router = require('koa-router');
const router = new Router();
const { getMaterializedViewManager } = require('../../../shared/MaterializedViewManager');
const QueryRouter = require('../../../shared/QueryRouter');

// 初始化查询路由器
const queryRouter = new QueryRouter(pool, getMaterializedViewManager(pool));

// 获取精灵排行榜（使用物化视图）
router.get('/pokemon/ranking', async (ctx) => {
  const { speciesId, limit = 100, offset = 0 } = ctx.query;

  const result = await queryRouter.executeQuery({
    name: 'pokemon_ranking',
    realtimeQuery: `
      SELECT 
        p.id, p.species_id, p.combat_power, p.level,
        u.username, 
        ROW_NUMBER() OVER (ORDER BY p.combat_power DESC) AS rank
      FROM pokemons p
      INNER JOIN users u ON p.user_id = u.id
      WHERE ($1::int IS NULL OR p.species_id = $1)
        AND p.is_deleted = false
      ORDER BY p.combat_power DESC
      LIMIT $2 OFFSET $3
    `,
    mvQuery: `
      SELECT 
        pokemon_id AS id, species_id, combat_power, level,
        username, global_rank AS rank
      FROM mv_pokemon_ranking
      WHERE ($1::int IS NULL OR species_id = $1)
      ORDER BY global_rank
      LIMIT $2 OFFSET $3
    `,
    params: [speciesId ? parseInt(speciesId) : null, limit, offset],
    threshold: 50
  });

  ctx.body = {
    success: true,
    data: result.data,
    meta: {
      source: result.source,
      count: result.data.length
    }
  };
});

// 获取玩家统计（使用物化视图）
router.get('/users/:userId/stats', async (ctx) => {
  const { userId } = ctx.params;

  const result = await queryRouter.executeQuery({
    name: 'user_stats',
    realtimeQuery: `
      SELECT 
        u.id, u.username, u.level,
        COUNT(DISTINCT p.id) AS total_pokemon,
        MAX(p.combat_power) AS max_cp_pokemon,
        COUNT(DISTINCT b.id) AS total_battles
      FROM users u
      LEFT JOIN pokemons p ON u.id = p.user_id
      LEFT JOIN battles b ON u.id = b.user_id
      WHERE u.id = $1
      GROUP BY u.id
    `,
    mvQuery: `
      SELECT * FROM mv_user_stats WHERE user_id = $1
    `,
    params: [userId],
    threshold: 10
  });

  ctx.body = {
    success: true,
    data: result.data[0] || null,
    meta: {
      source: result.source
    }
  };
});

module.exports = router;
```

### 5. 刷新任务调度器

```javascript
// backend/jobs/materializedViewRefresh.js

const cron = require('node-cron');
const { Pool } = require('pg');
const { getMaterializedViewManager } = require('../shared/MaterializedViewManager');
const logger = require('../shared/logger');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const mvManager = getMaterializedViewManager(pool);

// 注册物化视图配置
function initializeViews() {
  mvManager.registerView({
    name: 'pokemon_ranking',
    tableName: 'mv_pokemon_ranking',
    refreshInterval: 5 * 60 * 1000, // 5 分钟
    refreshStrategy: 'CONCURRENT',
    indexes: [
      'idx_mv_pokemon_ranking_species',
      'idx_mv_pokemon_ranking_global'
    ]
  });

  mvManager.registerView({
    name: 'user_stats',
    tableName: 'mv_user_stats',
    refreshInterval: 10 * 60 * 1000, // 10 分钟
    refreshStrategy: 'CONCURRENT',
    indexes: [
      'idx_mv_user_stats_user_id',
      'idx_mv_user_stats_level'
    ]
  });

  mvManager.registerView({
    name: 'gym_activity',
    tableName: 'mv_gym_activity',
    refreshInterval: 15 * 60 * 1000, // 15 分钟
    refreshStrategy: 'CONCURRENT',
    indexes: [
      'idx_mv_gym_activity_gym_id',
      'idx_mv_gym_activity_popularity'
    ]
  });
}

// 启动定时刷新
function startRefreshScheduler() {
  // 每小时全量刷新一次
  cron.schedule('0 * * * *', async () => {
    logger.info('Starting hourly materialized view refresh');
    
    try {
      await mvManager.refreshAll({ strategy: 'CONCURRENT' });
      logger.info('Hourly refresh completed');
    } catch (error) {
      logger.error('Hourly refresh failed', { error: error.message });
    }
  });

  // 每天凌晨 3 点完全刷新（重建索引）
  cron.schedule('0 3 * * *', async () => {
    logger.info('Starting daily full refresh');
    
    try {
      await mvManager.refreshAll({ strategy: 'FULL' });
      logger.info('Daily full refresh completed');
    } catch (error) {
      logger.error('Daily full refresh failed', { error: error.message });
    }
  });

  // 启动自动刷新
  mvManager.startAutoRefresh();
}

// 监控脚本
async function monitorViews() {
  for (const [name] of mvManager.views) {
    try {
      const status = await mvManager.getViewStatus(name);
      logger.info(`View status: ${name}`, {
        rowCount: status.rowCount,
        size: status.size,
        lastRefresh: status.lastRefresh
      });
    } catch (error) {
      logger.error(`Failed to get status for ${name}`, {
        error: error.message
      });
    }
  }
}

// 主入口
async function main() {
  initializeViews();
  startRefreshScheduler();
  
  // 每 5 分钟监控一次
  setInterval(monitorViews, 5 * 60 * 1000);
  
  logger.info('Materialized view refresh scheduler started');
}

if (require.main === module) {
  main().catch(err => {
    logger.error('Scheduler crashed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { initializeViews, startRefreshScheduler };
```

### 6. 监控指标

```javascript
// backend/shared/metrics/materializedViewMetrics.js

const promClient = require('prom-client');

// 刷新持续时间
const refreshDuration = new promClient.Histogram({
  name: 'materialized_view_refresh_duration_ms',
  help: 'Duration of materialized view refresh in milliseconds',
  labelNames: ['view', 'strategy'],
  buckets: [100, 500, 1000, 2000, 5000, 10000]
});

// 刷新错误计数
const refreshErrors = new promClient.Counter({
  name: 'materialized_view_refresh_errors_total',
  help: 'Total number of materialized view refresh errors',
  labelNames: ['view']
});

// 查询来源分布
const querySource = new promClient.Counter({
  name: 'query_source_total',
  help: 'Total queries by source (realtime or materialized_view)',
  labelNames: ['query_name', 'source']
});

// 物化视图行数
const viewRowCount = new promClient.Gauge({
  name: 'materialized_view_row_count',
  help: 'Number of rows in materialized view',
  labelNames: ['view']
});

// 物化视图大小
const viewSizeBytes = new promClient.Gauge({
  name: 'materialized_view_size_bytes',
  help: 'Size of materialized view in bytes',
  labelNames: ['view']
});

module.exports = {
  refreshDuration,
  refreshErrors,
  querySource,
  viewRowCount,
  viewSizeBytes
};
```

## 验收标准

- [ ] 完成 Top 10 慢查询的物化视图创建
- [ ] 物化视图查询平均响应时间 < 50ms
- [ ] 实现自动刷新机制，数据延迟 < 15 分钟
- [ ] 查询路由器正确选择查询方式（覆盖率 > 95%）
- [ ] 提供完整的管理 API（创建、删除、刷新、监控）
- [ ] Grafana 监控面板展示物化视图状态
- [ ] 添加单元测试和集成测试（覆盖率 > 80%）
- [ ] 完成性能基准测试文档
- [ ] 数据库迁移脚本可回滚

## 影响范围

### 数据库变更
- `database/migrations/` - 新增 3 个物化视图迁移文件
- PostgreSQL 需要启用 `CONCURRENT REFRESH` 功能

### 服务变更
- `backend/shared/MaterializedViewManager.js` - 新增管理工具
- `backend/shared/QueryRouter.js` - 新增查询路由器
- `backend/jobs/materializedViewRefresh.js` - 新增刷新任务
- `backend/shared/metrics/` - 新增监控指标
- `pokemon-service` - 集成物化视图查询
- `social-service` - 排行榜查询优化
- `gym-service` - 道馆活跃度查询优化
- `user-service` - 用户统计查询优化

### 监控变更
- Grafana 面板新增物化视图监控
- Prometheus 新增 5 个指标

### 文档变更
- 性能优化最佳实践文档
- 物化视图使用指南

## 参考

- [PostgreSQL Materialized Views 官方文档](https://www.postgresql.org/docs/current/rules-materializedviews.html)
- [数据库查询优化最佳实践](https://use-the-index-luke.com/)
- [PostgreSQL CONCURRENT REFRESH 性能分析](https://www.cybertec-postgresql.com/en/materialized-views-postgresql-9-4-updatable-views/)
