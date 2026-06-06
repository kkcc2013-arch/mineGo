# REQ-00007：数据库迁移管理与版本控制系统

- **编号**：REQ-00007
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：database/migrations、backend/shared/db.js、所有微服务、CI/CD
- **创建时间**：2026-06-05 03:00
- **依赖需求**：无

## 1. 背景与问题

当前项目数据库管理存在以下问题：

1. **缺乏版本控制**：只有一个初始 schema 文件 `V1__initial_schema.sql`，后续所有数据库变更都没有版本追踪
2. **无法回滚**：没有 down migration，一旦执行错误的 schema 变更，只能手动修复或重建数据库
3. **环境不一致风险**：开发、测试、生产环境的数据库结构可能不一致，导致难以排查的问题
4. **团队协作困难**：多人开发时，数据库变更容易冲突，没有统一的变更流程
5. **部署风险高**：每次部署涉及数据库变更时，无法验证变更是否安全，缺少变更前的 checksum 校验

当前 `docker-compose.yml` 只在容器启动时执行初始 schema，后续变更不会自动应用。

## 2. 目标

建立完整的数据库迁移管理系统：

1. **版本化迁移**：每个数据库变更都有独立的迁移文件，包含 up 和 down 脚本
2. **自动执行**：服务启动时自动应用待执行的迁移
3. **回滚能力**：支持回滚到任意版本
4. **环境一致性**：确保所有环境数据库结构一致
5. **安全校验**：执行前校验已执行迁移的 checksum，防止手动修改导致不一致

## 3. 范围

- **包含**：
  - 实现基于 Node.js 的轻量级迁移工具（不引入重型依赖如 Prisma）
  - 创建迁移文件命名规范和目录结构
  - 实现 up/down 迁移执行器
  - 添加迁移状态追踪表 `schema_migrations`
  - 集成到服务启动流程
  - 添加 CLI 命令：`npm run migrate:up`、`migrate:down`、`migrate:status`、`migrate:create`
  - 添加 CI/CD 检查：验证迁移文件 checksum

- **不包含**：
  - 数据库备份策略（单独需求）
  - 数据归档策略（单独需求）
  - 多租户 schema 管理

## 4. 详细需求

### 4.1 迁移文件规范

```
database/
├── migrations/
│   ├── V1__initial_schema.sql          # 已有
│   ├── V2__seed_data.sql               # 已有（改为 seed）
│   └── pending/                         # 新增：待执行迁移
│       ├── 20260605_030000__add_user_last_login_ip.sql
│       └── ...
├── seeds/
│   └── V2__seed_data.sql               # 移动到这里
└── migrate.js                          # 迁移工具
```

迁移文件命名：`{timestamp}__{description}.sql`
- timestamp：UTC 时间戳，格式 `YYYYMMDD_HHMMSS`
- description：小写 + 下划线，描述变更内容

每个迁移文件包含：
```sql
-- migrate:up
CREATE TABLE example (...);

-- migrate:down
DROP TABLE example;
```

### 4.2 迁移状态表

```sql
CREATE TABLE schema_migrations (
  version       VARCHAR(20) PRIMARY KEY,    -- '20260605_030000'
  description   VARCHAR(200) NOT NULL,
  checksum      VARCHAR(64) NOT NULL,       -- SHA256 of file content
  executed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  execution_ms  INTEGER NOT NULL,
  executed_by   VARCHAR(100)                -- hostname/container id
);
```

### 4.3 迁移执行器 (database/migrate.js)

```javascript
// 核心功能
class MigrationRunner {
  // 获取已执行迁移列表
  async getExecutedMigrations()
  
  // 获取待执行迁移文件
  async getPendingMigrations()
  
  // 计算文件 checksum
  calculateChecksum(filePath)
  
  // 校验已执行迁移的 checksum（防止手动修改）
  async verifyChecksums()
  
  // 执行单个迁移
  async runMigration(migrationFile, direction = 'up')
  
  // 执行所有待执行迁移
  async runPendingMigrations()
  
  // 回滚到指定版本
  async rollbackTo(version)
  
  // 创建新迁移文件
  async createMigration(description)
  
  // 获取迁移状态
  async status()
}
```

### 4.4 服务启动集成

修改 `backend/shared/db.js`：
```javascript
const { runPendingMigrations, verifyChecksums } = require('../../database/migrate');

async function initializeDatabase() {
  // 1. 验证已执行迁移的 checksum
  await verifyChecksums();
  
  // 2. 执行待执行迁移
  if (process.env.AUTO_MIGRATE === 'true') {
    await runPendingMigrations();
  }
}
```

### 4.5 CLI 命令

在 `backend/package.json` 添加：
```json
{
  "scripts": {
    "migrate:up": "node database/migrate.js up",
    "migrate:down": "node database/migrate.js down",
    "migrate:status": "node database/migrate.js status",
    "migrate:create": "node database/migrate.js create",
    "migrate:verify": "node database/migrate.js verify"
  }
}
```

### 4.6 CI/CD 集成

在 GitHub Actions 添加检查步骤：
```yaml
- name: Verify Migration Checksums
  run: npm run migrate:verify
  env:
    DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
```

### 4.7 环境变量

```env
# 是否自动执行迁移（生产环境建议 false，手动执行）
AUTO_MIGRATE=false

# 迁移锁定超时（防止并发执行）
MIGRATION_LOCK_TIMEOUT_MS=30000
```

## 5. 验收标准（可测试）

- [ ] 迁移工具 `migrate.js` 实现，支持 up/down/status/create/verify 命令
- [ ] `schema_migrations` 表创建成功，能正确记录迁移历史
- [ ] 执行迁移后，`migrate:status` 显示正确状态（已执行/待执行）
- [ ] 迁移文件 checksum 校验正常，手动修改文件后 `migrate:verify` 报错
- [ ] 回滚功能正常，`migrate:down` 能正确撤销最后一个迁移
- [ ] 服务启动时能自动执行待执行迁移（AUTO_MIGRATE=true）
- [ ] CI/CD 中添加迁移校验步骤
- [ ] 编写迁移工具单元测试，覆盖核心场景
- [ ] 文档更新：README 添加迁移使用说明

## 6. 工作量估算

**M (Medium)**

理由：
- 核心逻辑相对简单（文件扫描、SQL 执行、状态记录）
- 需要考虑并发安全（迁移锁）
- 需要集成到现有启动流程
- 预计 1-2 天完成

## 7. 优先级理由

**P1 理由**：

1. **数据安全基础**：没有迁移管理，数据库变更风险高，可能导致数据丢失或服务不可用
2. **团队协作必需**：多人开发时，数据库变更冲突会导致严重问题
3. **生产部署保障**：生产环境数据库变更需要可追溯、可回滚
4. **阻塞后续需求**：后续很多需求涉及数据库变更（索引优化、新功能），需要迁移系统支持

虽然不是 P0（核心功能已可用），但是是 P1 高优先级，应尽快实现。
