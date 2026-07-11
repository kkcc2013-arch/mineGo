# REQ-00539: 数据库慢查询自动调优建议与索引推荐系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00539 |
| 标题 | 数据库慢查询自动调优建议与索引推荐系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/shared/database, infrastructure/monitoring, admin-dashboard |
| 创建时间 | 2026-07-11 17:00 |

## 需求描述

为了解决数据库运行过程中出现的慢查询瓶颈，减少人工排查成本，开发一套自动化慢查询分析与调优建议系统。系统将监控慢查询日志，提取 SQL 执行计划 (Explain)，结合当前的表结构与索引情况，自动生成优化方案（如：添加索引、重写 SQL、调整连接池参数）。

## 技术方案

### 1. 监控与捕获
- 集成现有的 `backend/shared/database` 慢查询审计接口。
- 定期从 `infrastructure/monitoring` 获取慢查询日志。

### 2. 分析引擎
- 解析 SQL 结构，提取表名、条件、排序字段。
- 使用 `EXPLAIN ANALYZE` 检查执行计划的扫描类型（全表扫描 vs 索引扫描）。
- 结合表字段统计信息（使用 `pg_stats`）评估是否缺少索引。

### 3. 建议生成
- 自动生成 ALTER TABLE 指令。
- 提供建议理由（如：减少 I/O 消耗、降低 CPU 使用率）。

### 4. 前端集成
- 在 `admin-dashboard` 中展示待处理的优化建议列表。
- 支持一键批准执行建议（触发对应的 Migration 脚本）。

## 验收标准

- [ ] 慢查询日志能够自动关联到分析引擎。
- [ ] 系统能够为符合条件的慢查询生成准确的索引建议。
- [ ] 管理员能在 `admin-dashboard` 查看建议并执行操作。
- [ ] 优化建议历史记录能够被审计。

## 影响范围

- `backend/shared/database`
- `infrastructure/monitoring`
- `admin-dashboard`

## 参考

- [Database Optimization Guidelines](/docs/performance/db-optimization.md)
