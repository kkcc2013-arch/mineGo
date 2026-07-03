# REQ-00432: 数据库模式变更影响分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00432 |
| 标题 | 数据库模式变更影响分析系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database-service、cicd-pipeline、shared/analyzer、admin-dashboard |
| 创建时间 | 2026-07-03 11:00 |

## 需求描述

随着数据库表结构变更频繁，缺乏自动化手段评估变更对现有查询（特别是复杂 Join 和存储过程）及应用代码的影响。本项目旨在构建一套自动化分析工具，在执行 SQL 迁移脚本前，识别潜在的查询中断、性能下降或兼容性冲突，确保数据治理合规性与变更安全性。

## 技术方案

### 1. 静态 SQL 分析引擎
- 解析数据库的 `schema` 变更（DDL）
- 利用 SQL 解析器（如 `sqlparse` 或 `libpg_query`）扫描项目中的代码库（Go/SQL），识别受影响的表和字段的查询。
- 构建 SQL 依赖图（SQL Dependency Graph），记录每个 API 接口对应的数据库表调用链。

### 2. 变更预检查与风险分析
- 在 CI/CD 阶段集成 `schema-diff-checker`，对比 `target` 环境与 `migration` 脚本。
- 分析变更的影响度：
    - `破坏性变更`（如重命名/删除字段）-> 输出错误并阻断 CI
    - `性能敏感变更`（如大表新增索引缺失、数据类型转换）-> 触发告警并推荐优化方案
    - `合规变更`（如新增字段未打隐私标签）-> 发送安全审查提醒

### 3. 可视化报告生成
- 提供 Admin-Dashboard 视图，列出每一条迁移脚本的影响范围。
- 集成自动化测试用例推荐，根据变更范围标记需要重跑的集成测试。

## 验收标准

- [ ] 实现针对 DDL 的自动化风险等级评估（破坏性/性能/安全）
- [ ] 在 CI/CD 流水线集成扫描工具，失败时自动阻断部署
- [ ] Admin-Dashboard 能展示 SQL 迁移的影响范围分析结果
- [ ] 覆盖核心业务表（`pokemon`, `user`, `trade`）的变更检测
- [ ] 对未标记隐私属性的新增字段能触发自动化安全审查告警

## 影响范围

- `database-service`：新增预扫描 API
- `cicd-pipeline`：新增分析步骤
- `shared/analyzer`：新增 SQL 分析核心逻辑

## 参考

- [数据库 Schema 版本控制与管理规范](/docs/db-governance.md)
- [REQ-00007: 数据库迁移管理系统](/docs/requirements/REQ-00007-database-migration-management.md)
