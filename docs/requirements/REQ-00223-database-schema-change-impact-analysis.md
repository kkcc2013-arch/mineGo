# REQ-00223：数据库表结构变更影响分析与自动化迁移验证系统

- **编号**：REQ-00223
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/SchemaChangeAnalyzer.js、backend/shared/MigrationValidator.js、database/migrations、所有微服务、admin-dashboard
- **创建时间**：2026-06-15 16:00
- **依赖需求**：REQ-00007（数据库迁移管理系统）、REQ-00008（OpenAPI 文档与 API 设计规范统一）

## 1. 背景与问题

mineGo 项目采用 PostgreSQL 作为主数据库，已有 12 个迁移文件，涉及用户、精灵、道馆、社交、支付等核心业务表。随着项目迭代，数据库表结构变更频繁，存在以下问题：

**问题 1：变更影响范围不明确**
- 修改表结构时，难以快速识别受影响的外键关系和下游服务
- 缺乏对 ALTER TABLE、DROP COLUMN 等操作的影响评估
- 可能导致生产环境迁移失败或数据丢失

**问题 2：迁移脚本验证不足**
- 迁移脚本缺乏自动化验证，依赖人工测试
- 未检查迁移脚本的幂等性和可回滚性
- 无法预测迁移对数据库性能的影响（锁表时间、IO 压力）

**问题 3：缺乏变更审计**
- 数据库变更历史分散，缺乏统一的变更记录
- 无法追溯某个表字段的历史变更原因
- 合规审计时难以快速定位变更记录

## 2. 目标

建立一个数据库表结构变更影响分析与自动化迁移验证系统，实现：

1. **影响分析自动化**：分析表结构变更的影响范围，识别受影响的外键、索引、视图、下游服务
2. **迁移脚本验证**：自动检查迁移脚本的语法正确性、幂等性、可回滚性
3. **性能影响评估**：预测迁移操作对数据库性能的影响（锁表时间、IO 估算）
4. **变更审计追踪**：建立完整的数据库变更历史记录，支持合规审计

预期收益：
- 减少 80% 的数据库迁移失败率
- 降低 70% 的数据库变更风险
- 提升数据库变更效率 50%

## 3. 范围

### 包含
- 表结构变更影响分析器（SchemaChangeAnalyzer）
- 迁移脚本验证器（MigrationValidator）
- 数据库变更历史追踪系统
- 影响报告生成器
- 管理后台集成（变更影响可视化）

### 不包含
- 自动生成迁移脚本（人工编写为主）
- 数据库性能优化建议（已有 REQ-00063）
- 数据血缘追踪（已有 REQ-00199）

## 4. 详细需求

### 4.1 表结构变更影响分析

**功能点 1：变更类型识别**
- 支持 ALTER TABLE（ADD/DROP/MODIFY COLUMN）
- 支持 CREATE/DROP INDEX
- 支持 CREATE/DROP TABLE
- 支持 ADD/DROP CONSTRAINT（外键、唯一约束、检查约束）

**功能点 2：外键影响分析**
```javascript
// 示例：分析删除字段的影响
{
  "change": "DROP COLUMN users.email",
  "affectedForeignKeys": [
    {
      "table": "pokemon_instances",
      "column": "owner_email",
      "constraint": "fk_owner_email",
      "cascade": "NO ACTION",
      "impact": "constraint_violation"
    }
  ],
  "affectedViews": ["v_user_pokemon_summary"],
  "affectedIndexes": ["idx_users_email"]
}
```

**功能点 3：下游服务影响分析**
- 分析哪些微服务依赖该表/字段
- 通过代码扫描识别 Model/Repository 层引用
- 生成影响范围报告

### 4.2 迁移脚本验证

**功能点 4：语法正确性检查**
- 使用 PostgreSQL 语法解析器验证 SQL 语法
- 检查表名、字段名是否正确
- 验证约束名称唯一性

**功能点 5：幂等性检查**
- 检查 IF NOT EXISTS / IF EXISTS 子句
- 验证迁移可重复执行不报错
- 生成幂等性评分（A/B/C/D）

**功能点 6：可回滚性检查**
- 验证是否有对应的 down 迁移
- 检查 down 迁移的逻辑正确性
- 生成回滚风险评估

**功能点 7：性能影响评估**
- 预估锁表时间（基于表大小和变更类型）
- 估算 IO 影响（全表扫描 vs 索引扫描）
- 生成性能影响评分（Low/Medium/High/Critical）

### 4.3 变更历史追踪

**功能点 8：变更记录存储**
```sql
CREATE TABLE schema_change_history (
  id SERIAL PRIMARY KEY,
  change_type VARCHAR(50) NOT NULL,
  table_name VARCHAR(100),
  column_name VARCHAR(100),
  migration_file VARCHAR(255) NOT NULL,
  impact_analysis JSONB,
  executed_at TIMESTAMP NOT NULL,
  executed_by VARCHAR(100),
  execution_time_ms INTEGER,
  rollback_available BOOLEAN DEFAULT false,
  notes TEXT
);
```

**功能点 9：变更历史查询 API**
- 按表名查询变更历史
- 按时间范围查询变更
- 按变更类型查询
- 支持变更回滚标记

### 4.4 影响报告生成

**功能点 10：变更影响报告**
```markdown
# 数据库变更影响报告

## 变更概览
- 变更类型：ALTER TABLE
- 受影响表：users
- 预估风险等级：Medium

## 影响范围
### 外键影响
- pokemon_instances.fk_user_id → users.id

### 索引影响
- idx_users_email（将被删除）

### 下游服务影响
- user-service：高影响（5 处代码引用）
- pokemon-service：中影响（2 处代码引用）

## 性能影响
- 预估锁表时间：2-5 秒
- IO 影响：Medium（需更新 10,000+ 行）
- 建议执行时间：低峰期（02:00-04:00 UTC）

## 验证结果
- 语法正确性：✅ 通过
- 幂等性：✅ A级
- 可回滚性：✅ 已提供 down 迁移
```

### 4.5 管理后台集成

**功能点 11：变更影响可视化**
- 数据库表关系图（ER 图）
- 变更影响高亮显示
- 依赖关系连线展示

**功能点 12：变更审批工作流**
- Low 风险：自动批准
- Medium 风险：需要技术负责人审批
- High/Critical 风险：需要 DBA 审批

## 5. 验收标准（可测试）

- [ ] 分析 ALTER TABLE DROP COLUMN 变更时，能正确识别所有受影响的外键（至少 3 层深度）
- [ ] 迁移脚本验证器能检测出 95% 以上的语法错误
- [ ] 幂等性检查能识别出缺少 IF NOT EXISTS 的迁移脚本
- [ ] 性能影响评估误差不超过 30%（与实际执行时间对比）
- [ ] 变更历史查询响应时间 < 500ms
- [ ] 影响报告生成时间 < 5 秒（针对单表变更）
- [ ] 管理后台能展示数据库表关系图，并高亮显示变更影响
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**L（Large）**
- 表结构变更影响分析器：复杂度高，需处理多种变更类型和复杂的依赖关系
- 迁移脚本验证器：需要集成 PostgreSQL 语法解析器，实现难度较大
- 变更历史追踪系统：需要设计数据库表结构和查询优化
- 管理后台集成：需要前端可视化和工作流集成
- 预计工作量：5-7 人天

## 7. 优先级理由

**P1 理由**：
1. **高价值**：mineGo 项目已有 222 个需求，数据库迁移频率高，变更风险大
2. **避免生产事故**：能显著降低数据库迁移失败率，避免生产事故
3. **提升开发效率**：自动化分析和验证能节省大量人工测试时间
4. **支持合规审计**：变更历史追踪是数据治理的重要组成部分
5. **依赖已就绪**：REQ-00007（数据库迁移管理系统）已完成，有良好基础
