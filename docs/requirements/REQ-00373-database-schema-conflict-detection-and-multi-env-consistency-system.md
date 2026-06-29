# REQ-00373：数据库Schema版本冲突检测与多环境一致性验证系统

- **编号**：REQ-00373
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：database/migrations、backend/shared、所有微服务、infrastructure/k8s、admin-dashboard、.github/workflows
- **创建时间**：2026-06-29 21:00 UTC
- **依赖需求**：REQ-00306

## 1. 背景与问题

mineGo 项目采用 PostgreSQL + PostGIS 作为主数据库，目前已有 60+ 个迁移文件。在实际开发过程中，存在以下问题：

1. **Schema 版本冲突风险**：多个开发者同时修改数据库结构时，可能创建相同编号的迁移文件或修改相同表结构，导致冲突和覆盖。
2. **环境不一致问题**：开发、测试、生产环境的数据库 Schema 可能存在差异，缺少自动化的跨环境一致性校验。
3. **迁移顺序混乱**：缺少对迁移文件依赖关系的明确声明，可能导致迁移执行顺序错误。
4. **回滚困难**：部分迁移文件缺少对应的回滚脚本，生产环境出问题时难以快速回退。
5. **缺少变更审计**：数据库 Schema 变更缺少统一的审批流程和变更记录追踪。

## 2. 目标

- 建立自动化的 Schema 版本冲突检测机制，在代码提交前发现问题
- 实现多环境（dev/test/staging/prod）数据库 Schema 一致性验证
- 提供迁移文件依赖声明和拓扑排序机制
- 强制要求迁移文件包含回滚脚本或显式声明 irreversible
- 建立 Schema 变更审批流程与审计日志

## 3. 范围

- **包含**：
  - 迁移文件冲突检测 CI 检查
  - Schema 快照与 Diff 工具
  - 多环境一致性验证脚本
  - 迁移依赖声明格式规范
  - 回滚脚本完整性检查
  - Schema 变更审批 Webhook 集成

- **不包含**：
  - 自动生成回滚脚本（仅检测是否提供）
  - 生产数据库直接操作权限管理
  - 数据库性能监控（已由其他需求覆盖）

## 4. 详细需求

### 4.1 迁移文件冲突检测

```bash
# scripts/check-migration-conflicts.sh
# 检测项：
# 1. 迁移文件编号是否重复
# 2. 同一表是否被多个未合并的迁移修改
# 3. 迁移文件命名是否符合规范
# 4. 是否缺少对应的回滚脚本

#!/bin/bash
set -e

# 检测重复编号
duplicates=$(ls -1 database/migrations/*.{sql,js} 2>/dev/null | \
  xargs -n1 basename | \
  cut -d'_' -f1 | sort | uniq -d)

if [ -n "$duplicates" ]; then
  echo "ERROR: Duplicate migration prefixes found: $duplicates"
  exit 1
fi

# 检测目标表冲突
changed_tables=$(git diff --name-only origin/main -- 'database/migrations/*.sql' | \
  xargs grep -h "ALTER TABLE\|CREATE TABLE" 2>/dev/null | \
  awk '{print $3}' | sort | uniq -d)

if [ -n "$changed_tables" ]; then
  echo "WARNING: Tables modified by multiple pending migrations: $changed_tables"
fi
```

### 4.2 Schema 快照与 Diff

```javascript
// backend/shared/SchemaSnapshot.js

class SchemaSnapshot {
  /**
   * 捕获当前数据库 Schema 快照
   */
  static async capture(pool) {
    const result = await pool.query(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);

    const schema = {};
    for (const row of result.rows) {
      if (!schema[row.table_name]) {
        schema[row.table_name] = {};
      }
      schema[row.table_name][row.column_name] = {
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        default: row.column_default
      };
    }

    return {
      version: Date.now(),
      tables: schema,
      migrations: await this.getAppliedMigrations(pool)
    };
  }

  /**
   * 比较两个 Schema 快照，生成 Diff 报告
   */
  static diff(snapshot1, snapshot2) {
    const changes = {
      added_tables: [],
      dropped_tables: [],
      modified_tables: {},
      added_columns: {},
      dropped_columns: {},
      modified_columns: {}
    };

    const tables1 = Object.keys(snapshot1.tables);
    const tables2 = Object.keys(snapshot2.tables);

    // 检测新增/删除的表
    changes.added_tables = tables2.filter(t => !tables1.includes(t));
    changes.dropped_tables = tables1.filter(t => !tables2.includes(t));

    // 检测列变更
    for (const table of tables1.filter(t => tables2.includes(t))) {
      const cols1 = Object.keys(snapshot1.tables[table]);
      const cols2 = Object.keys(snapshot2.tables[table]);

      const added = cols2.filter(c => !cols1.includes(c));
      const dropped = cols1.filter(c => !cols2.includes(c));

      if (added.length > 0) changes.added_columns[table] = added;
      if (dropped.length > 0) changes.dropped_columns[table] = dropped;

      // 检测类型变更
      for (const col of cols1.filter(c => cols2.includes(c))) {
        const def1 = snapshot1.tables[table][col];
        const def2 = snapshot2.tables[table][col];

        if (def1.type !== def2.type || def1.nullable !== def2.nullable) {
          if (!changes.modified_columns[table]) changes.modified_columns[table] = {};
          changes.modified_columns[table][col] = {
            from: def1,
            to: def2
          };
        }
      }
    }

    return changes;
  }

  /**
   * 获取已应用的迁移列表
   */
  static async getAppliedMigrations(pool) {
    const result = await pool.query(`
      SELECT version, name, applied_at
      FROM schema_migrations
      ORDER BY applied_at
    `);
    return result.rows;
  }
}

module.exports = SchemaSnapshot;
```

### 4.3 多环境一致性验证

```javascript
// backend/jobs/verifySchemaConsistency.js

const SchemaSnapshot = require('../shared/SchemaSnapshot');
const { Pool } = require('pg');

async function verifySchemaConsistency() {
  const envs = ['dev', 'test', 'staging', 'prod'];
  const snapshots = {};

  // 捕获各环境 Schema
  for (const env of envs) {
    const pool = new Pool({
      connectionString: process.env[`DATABASE_URL_${env.toUpperCase()}`]
    });

    try {
      snapshots[env] = await SchemaSnapshot.capture(pool);
    } catch (err) {
      console.error(`Failed to capture ${env} schema:`, err.message);
      snapshots[env] = null;
    } finally {
      await pool.end();
    }
  }

  // 与生产环境对比
  const baseline = snapshots.prod;
  const report = {
    timestamp: new Date().toISOString(),
    baseline: 'prod',
    comparisons: {}
  };

  for (const env of envs.filter(e => e !== 'prod' && snapshots[e])) {
    const diff = SchemaSnapshot.diff(baseline, snapshots[env]);
    report.comparisons[env] = {
      in_sync: Object.values(diff).every(v => 
        Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0
      ),
      diff
    };
  }

  // 输出报告
  console.log(JSON.stringify(report, null, 2));

  // 检查是否所有环境一致
  const allInSync = Object.values(report.comparisons)
    .every(c => c.in_sync);

  if (!allInSync) {
    console.error('Schema inconsistency detected!');
    process.exit(1);
  }

  console.log('All environments are in sync.');
}

verifySchemaConsistency().catch(console.error);
```

### 4.4 迁移依赖声明规范

```yaml
# database/migrations/metadata.yaml
# 迁移文件元数据声明

migrations:
  - file: "20260629_200100__add_ip_ban_system.sql"
    depends_on: "20260626010000_session_security_system.sql"
    rollback: "20260629_200100__add_ip_ban_system_rollback.sql"
    description: "添加 IP 封禁系统表和索引"
    author: "security-team"
    reviewers:
      - "dba-team"
      - "security-lead"

  - file: "20260629_150500__day_night_cycle_system.sql"
    depends_on: "V1__initial_schema.sql"
    rollback: null  # irreversible - 需显式声明
    irreversible_reason: "核心功能表，回滚将导致数据丢失"
    description: "昼夜循环系统"
```

### 4.5 CI/CD 集成

```yaml
# .github/workflows/database-schema-check.yml
name: Database Schema Check

on:
  pull_request:
    paths:
      - 'database/migrations/**'
      - 'backend/**/models/**'

jobs:
  check-conflicts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check migration file conflicts
        run: |
          chmod +x scripts/check-migration-conflicts.sh
          ./scripts/check-migration-conflicts.sh

      - name: Validate migration metadata
        run: |
          node scripts/validate-migration-metadata.js

      - name: Check rollback scripts
        run: |
          node scripts/check-rollback-scripts.js

      - name: Run schema diff analysis
        run: |
          # 对比 PR 分支与主分支的 Schema 差异
          node scripts/analyze-schema-changes.js \
            --base origin/main \
            --head HEAD

  verify-test-env:
    runs-on: ubuntu-latest
    needs: check-conflicts
    steps:
      - name: Verify test environment schema
        run: |
          node backend/jobs/verifySchemaConsistency.js \
            --environments dev,test
        env:
          DATABASE_URL_DEV: ${{ secrets.DATABASE_URL_DEV }}
          DATABASE_URL_TEST: ${{ secrets.DATABASE_URL_TEST }}
```

### 4.6 Schema 变更审批流程

```javascript
// backend/shared/SchemaApprovalWorkflow.js

class SchemaApprovalWorkflow {
  constructor({ slack, email }) {
    this.slack = slack;
    this.email = email;
  }

  /**
   * 提交 Schema 变更请求
   */
  async submitChangeRequest(change) {
    const requestId = `schema-${Date.now()}`;

    // 记录变更请求
    await this.logChangeRequest({
      id: requestId,
      type: change.type,
      description: change.description,
      migration_file: change.migrationFile,
      submitted_by: change.submittedBy,
      status: 'pending_review',
      created_at: new Date()
    });

    // 通知审核人
    await this.notifyReviewers({
      requestId,
      change,
      reviewers: this.getReviewers(change)
    });

    return requestId;
  }

  /**
   * 获取变更审核人
   */
  getReviewers(change) {
    const reviewers = [];

    // 所有 Schema 变更需要 DBA 审核
    reviewers.push('dba-team');

    // 敏感表变更需要安全团队审核
    const sensitiveTables = ['users', 'payments', 'sessions', 'api_keys'];
    if (change.tables.some(t => sensitiveTables.includes(t))) {
      reviewers.push('security-team');
    }

    // 生产环境变更需要 Tech Lead 审核
    if (change.environment === 'prod') {
      reviewers.push('tech-lead');
    }

    return reviewers;
  }

  /**
   * 审批变更请求
   */
  async approveChange(requestId, approver, comment) {
    const request = await this.getChangeRequest(requestId);

    // 记录审批
    await this.recordApproval({
      request_id: requestId,
      approver,
      comment,
      approved_at: new Date()
    });

    // 检查是否所有审核人都已批准
    const approvals = await this.getApprovals(requestId);
    const requiredReviewers = this.getReviewers(request);

    const allApproved = requiredReviewers.every(reviewer =>
      approvals.some(a => a.approver === reviewer)
    );

    if (allApproved) {
      await this.markAsApproved(requestId);
      await this.notifySubmitter({
        requestId,
        status: 'approved',
        message: 'Schema change has been approved. You may now apply it.'
      });
    }
  }

  /**
   * 应用变更到目标环境
   */
  async applyChange(requestId, environment) {
    const request = await this.getChangeRequest(requestId);

    if (request.status !== 'approved') {
      throw new Error('Change request must be approved before applying');
    }

    // 执行迁移
    const result = await this.executeMigration({
      migrationFile: request.migration_file,
      environment
    });

    // 记录应用结果
    await this.recordApplication({
      request_id: requestId,
      environment,
      applied_at: new Date(),
      success: result.success,
      error: result.error
    });

    if (result.success) {
      await this.updateRequestStatus(requestId, 'applied');
      await this.notifySubmitter({
        requestId,
        status: 'applied',
        message: `Schema change applied to ${environment} successfully.`
      });
    }

    return result;
  }
}

module.exports = SchemaApprovalWorkflow;
```

## 5. 验收标准（可测试）

- [ ] 迁移文件编号重复时 CI 检查失败并明确提示冲突文件
- [ ] Schema Diff 工具能准确识别新增表、删除表、新增列、删除列、类型变更
- [ ] 多环境一致性验证脚本能检测 dev/test/staging 与 prod 的 Schema 差异并生成报告
- [ ] 迁移元数据文件缺少依赖声明或回滚脚本时验证失败
- [ ] 审批流程集成 Slack 通知，审批通过前阻止生产环境迁移执行
- [ ] 所有 Schema 变更记录在审计日志中，包含提交人、审核人、时间、变更详情
- [ ] Schema 快照每日备份至对象存储，保留 30 天

## 6. 工作量估算

**规模：M**

- 迁移冲突检测脚本：0.5 天
- Schema 快照与 Diff 工具：1 天
- 多环境验证脚本：1 天
- 迁移元数据规范与验证：0.5 天
- 审批流程集成：1 天
- CI/CD 集成与测试：0.5 天
- 文档与培训：0.5 天

**总计：约 5 天**

## 7. 优先级理由

1. **数据安全关键**：数据库 Schema 变更是高风险操作，缺少冲突检测可能导致生产事故
2. **当前缺失**：项目已有 60+ 迁移文件，但缺少系统化的冲突检测和一致性验证
3. **团队协作必需**：多人同时修改数据库时需要明确的协作规范
4. **依赖关系**：与 REQ-00306（数据库迁移回滚自动化）相辅相成，共同构成完整的迁移管理体系
