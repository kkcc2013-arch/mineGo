# 数据库慢查询分析与自动优化建议系统

> REQ-00063: 数据库慢查询分析与自动优化建议系统
> 
> 创建时间：2026-06-09 22:00

## 系统概述

本系统提供完整的数据库慢查询监控、分析和优化建议功能，帮助开发团队主动发现和解决数据库性能问题。

### 核心功能

1. **慢查询采集**：实时采集执行时间超过阈值的查询
2. **智能分析**：识别 10+ 种查询问题类型
3. **优化建议**：自动生成索引、SQL 重写等建议
4. **可视化仪表板**：提供查询性能趋势和统计
5. **一键应用**：支持建议的自动应用和回滚

## 快速开始

### 1. 启动慢查询采集器

```bash
# 通过 API 启动
curl -X POST http://localhost:8080/api/query-performance/collector/start \
  -H "x-admin-key: your-admin-key"

# 或在代码中启动
const { getCollector } = require('./shared/slowQueryCollector');

const collector = getCollector({
  dbConfig: {
    host: 'localhost',
    database: 'minego',
    user: 'postgres',
    password: 'postgres'
  },
  slowThreshold: 1000 // 1秒
});

await collector.start();
```

### 2. 查看慢查询列表

```bash
curl http://localhost:8080/api/query-performance/slow-queries?minTime=1000 \
  -H "x-admin-key: your-admin-key"
```

### 3. 分析特定查询

```bash
curl -X POST http://localhost:8080/api/query-performance/analyze/{queryId} \
  -H "x-admin-key: your-admin-key"
```

### 4. 应用优化建议

```bash
curl -X POST http://localhost:8080/api/query-performance/recommendations/{id}/apply \
  -H "x-admin-key: your-admin-key"
```

## API 文档

### GET /api/query-performance/overview

获取性能概览报告。

**响应示例：**

```json
{
  "success": true,
  "data": {
    "period": "7 days",
    "slowQueryStats": [
      {
        "date": "2026-06-26",
        "total_slow_queries": 150,
        "avg_query_time": 2500,
        "max_query_time": 15000,
        "unique_queries": 25
      }
    ],
    "recommendationStats": [
      {
        "type": "create_index",
        "severity": "high",
        "total": 10,
        "applied": 5,
        "pending": 5
      }
    ],
    "topSlowQueries": [
      {
        "query_id": "abc123",
        "query_text": "SELECT * FROM pokemon...",
        "avg_time": 5000,
        "total_calls": 1000,
        "avg_cache_hit": 0.85
      }
    ]
  }
}
```

### GET /api/query-performance/slow-queries

获取慢查询列表。

**查询参数：**

- `limit` (number, 默认 50) - 返回数量
- `offset` (number, 默认 0) - 偏移量
- `minTime` (number, 默认 0) - 最小执行时间(ms)
- `startDate` (string, ISO 8601) - 开始日期
- `endDate` (string, ISO 8601) - 结束日期

### GET /api/query-performance/recommendations

获取优化建议列表。

**查询参数：**

- `status` (string) - 筛选状态：pending/applied/failed/dismissed
- `severity` (string) - 筛选严重程度：critical/high/medium/low
- `limit` (number, 默认 50) - 返回数量

### POST /api/query-performance/recommendations/:id/apply

应用优化建议。

**响应示例：**

```json
{
  "success": true,
  "data": {
    "success": true,
    "recommendationId": 123
  }
}
```

### POST /api/query-performance/analyze/:queryId

分析特定查询。

**响应示例：**

```json
{
  "success": true,
  "data": {
    "query": { ... },
    "explainPlan": { ... },
    "analysis": {
      "queryId": "abc123",
      "issues": [
        {
          "type": "missing_index",
          "severity": "high",
          "table": "pokemon",
          "columns": ["trainer_id"],
          "impact": "Sequential scan on pokemon"
        }
      ],
      "suggestions": [
        {
          "type": "create_index",
          "sql": "CREATE INDEX idx_pokemon_trainer_id ON pokemon (trainer_id)",
          "reason": "Add index to avoid full table scan",
          "estimatedImprovement": "70-90% query time reduction"
        }
      ]
    }
  }
}
```

## 配置

### 环境变量

```bash
# 慢查询阈值（毫秒）
SLOW_QUERY_THRESHOLD=1000

# 数据库连接
DB_HOST=localhost
DB_PORT=5432
DB_NAME=minego
DB_USER=postgres
DB_PASSWORD=postgres

# 管理员密钥（生产环境必需）
ADMIN_KEY=your-secure-admin-key
```

### 数据库配置

确保 PostgreSQL 启用了 `pg_stat_statements` 扩展：

```sql
-- 在 postgresql.conf 中添加
shared_preload_libraries = 'pg_stat_statements'

-- 创建扩展
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## 问题类型

系统可以识别以下查询问题类型：

| 类型 | 严重程度 | 说明 |
|------|----------|------|
| missing_index | high | 缺少索引导致全表扫描 |
| full_table_scan | critical | 大表全表扫描 |
| inefficient_join | medium | 低效的 JOIN 操作 |
| missing_where_clause | high | 缺少 WHERE 条件 |
| select_star | medium | 使用 SELECT * |
| or_condition | medium | OR 条件导致索引失效 |
| leading_wildcard | medium | LIKE 前导通配符 |
| orderby_without_index | medium | ORDER BY 无索引 |
| subquery | medium | 嵌套子查询 |
| distinct_overhead | low | DISTINCT 性能开销 |

## 监控指标

### Prometheus 指标

```
# 慢查询总数
slow_query_total{query_id="...", service="database"}

# 查询执行时间
query_duration_seconds{query_id="..."}

# 缓存命中率
query_cache_hit_ratio{query_id="..."}

# 优化建议应用次数
query_optimization_applied_total

# 采集器错误次数
slow_query_collector_errors_total{service="..."}
```

### Grafana 仪表板

导入 `infrastructure/k8s/monitoring/grafana-dashboards/query-performance.json` 查看：

- 慢查询趋势图
- 查询性能分布
- Top 慢查询
- 优化建议统计
- 缓存命中率趋势

## 最佳实践

### 1. 设置合理的阈值

```javascript
// 根据业务特点设置阈值
const collector = getCollector({
  slowThreshold: 1000,      // 1秒 - 大多数查询
  verySlowThreshold: 5000   // 5秒 - 需要立即关注
});
```

### 2. 定期审查建议

```bash
# 每周查看未处理的建议
curl http://localhost:8080/api/query-performance/recommendations?status=pending
```

### 3. 测试建议 SQL

在生产环境应用前，先在测试环境验证：

```sql
-- 使用 EXPLAIN ANALYZE 验证索引效果
EXPLAIN ANALYZE SELECT * FROM pokemon WHERE trainer_id = 123;

-- 创建索引
CREATE INDEX idx_pokemon_trainer_id ON pokemon (trainer_id);

-- 再次验证
EXPLAIN ANALYZE SELECT * FROM pokemon WHERE trainer_id = 123;
```

### 4. 监控缓存命中率

```bash
# 查看缓存命中率
curl http://localhost:8080/api/query-performance/slow-queries?minTime=100
```

缓存命中率低于 80% 通常表示内存不足或索引问题。

## 故障排查

### 问题：采集器无法启动

**可能原因：**
- `pg_stat_statements` 扩展未启用
- 数据库权限不足

**解决方案：**

```sql
-- 检查扩展是否启用
SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';

-- 如果未启用
CREATE EXTENSION pg_stat_statements;
```

### 问题：建议应用失败

**可能原因：**
- SQL 语法错误
- 索引已存在
- 表被锁定

**解决方案：**

```bash
# 查看错误信息
curl http://localhost:8080/api/query-performance/recommendations?status=failed

# 手动执行 SQL 并查看详细错误
psql -d minego -c "CREATE INDEX ..."
```

### 问题：查询分析超时

**可能原因：**
- 查询太复杂
- 数据量太大

**解决方案：**

```javascript
// 增加超时时间
const client = new Client({
  ...dbConfig,
  statement_timeout: 30000 // 30秒
});
```

## 性能影响

### 采集器开销

- **CPU**: < 1% (每分钟采集一次)
- **内存**: < 50MB
- **数据库连接**: 1 个连接 (采集时临时使用)

### 建议

- 在低峰期启动采集器
- 使用合理的采集间隔（默认 1 分钟）
- 监控采集器自身的性能指标

## 安全考虑

### 访问控制

- 所有 API 需要管理员权限
- 生产环境必须配置 `ADMIN_KEY`
- 使用 HTTPS 传输

### 数据安全

- 查询文本可能包含敏感信息，限制访问
- 建议日志定期清理
- 遵守数据保留政策

## 相关文档

- [PostgreSQL Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)
- [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [Database Index Design](https://use-the-index-luke.com/)

## 更新日志

### 2026-06-09
- 初始版本发布
- 支持慢查询采集和分析
- 支持 10+ 种问题类型识别
- 支持优化建议生成和应用

## 联系方式

如有问题或建议，请联系数据库团队或创建 GitHub Issue。
