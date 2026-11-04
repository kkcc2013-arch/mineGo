# REQ-00007：数据库迁移管理与版本控制系统

- **编号**：REQ-00007
- **类别**：数据库/数据治理
- **优先级**：P1
- **状态**：in_progress
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


## 验收复核（2026-10-08）

重新打开旧完成声明。标准仓库命令 node database/migrate.js status 在安装后端
依赖的现有工作区中无法加载 pg。仅为诊断指定后端 NODE_PATH 后，实际 PostGIS15
全 V1 schema 可以创建，但 V2 seed 违反 evolves_to=55 外键，事务回滚。79 个
pending 迁移在 20260605_180000 的 species_id=25 外键失败，迁移事务回滚且新建
历史/锁表不保留。失败后释放锁又访问已回滚的 migration_lock 表，报二次错误。

CLI 的 try 成功分支还引用未定义 err，缺少 catch；已有 migrate.test.js 主要
重演解析正则/模拟查询，没有实际调用生产 CLI 来发现以上问题。下一批修复
真实工具及 fresh seed/migration 路径，保留旧迁移 checksum；并发锁、校验、
回滚/CLI退出码、完整生产迁移和自动初始化仍需逐项实测。此处没有删除生产数据
或执行生产迁移；所有探测只在新建的本地独立 PostGIS 容器中进行。


## 实施进展（2026-10-08）

CLI 现在从声明的后端安装加载 pg，捕获真实错误、设置退出码并自然关闭连接池。
用事务级 advisory lock 替代过期行锁；等待超时可配置，所有待执行 SQL 和历史
同事务提交/回滚。执行和撤销前验证全部已执行源文件，修改/丢失/重复编号都阻断。
空回滚正确结束事务；SQL 分割支持函数体、嵌套注释、标准/转义字符串，外部
事务包装交由 runner 统一持有，拒绝脚本中间提交。旧 pending 文件 checksum 不改。

用户服务和网关启动先校验历史，AUTO_MIGRATE=true 时在监听前应用迁移；并发
初始化只执行一次且关闭迁移连接池。真实核心 unit6、PostgreSQL/CLI10 通过，
包括数据持久化、修改/丢失文件拒绝、回滚、并发、锁等待和中断连接后的恢复。
杀死客户端后先核实它的服务器会话结束，未把观察超时当作锁已释放。现有用户/
网关进程、全 unit619 和业务存储33 回归通过。共享测试扩展改由独立测试数据库
持有并串行初始化，避免多进程创建/删除 uuid-ossp 的竞态。

完整 V1+修复后的 V2 示例种子在实际 PostGIS15 中通过：32 种族、8 成就、5 补给站、
3 道馆，进化引用完整。增加55/75/76/80，保留既有进化规则；基础属性核对固定
游戏数据快照，样例稀有度/捕获率是项目平衡参数。全部79 pending 尚失败：道具
迁移依赖未建立的 items 表。新增全历史 CI 门禁保留失败，不以工具 fixture 替代
全量验收。完整迁移目录/多服务初始化/回滚仍待完成；说明见 DATABASE-MIGRATIONS.md。


## 依赖、修复来源与执行历史（2026-10-08）

新增 dependencies.json 显式声明先决条件，拓扑顺序允许较新 prerequisite 先于
旧版本执行。循环/缺失/非法依赖阻断；历史记录 execution_order，rollback 按
真实执行顺序，依赖内容 hash 防止事后重写。旧记录采用原有时间/版本顺序，
保留原 source hash；没有证据的历史执行 hash 保持 NULL，不伪造。

repairs.json 每项绑定完整原始文件 hash、可审阅的完整修复 SQL 和原因。原始
文件不改；日志标明实际使用的修复。新记录分别校验原始内容、依赖和执行 SQL
hash，拒绝修复文件/路径或原始内容失配。当前修复包括 V1 UUID 外键、PostgreSQL
部分唯一索引、inet_ops、刷新权重精度/VALUES 逗号、道具容量/过期函数；保留
其余 SQL 和所有合法数据。它们以真实规范 V1 UUID 为目标，不证明其它历史
身份 schema 自动升级已完成。

核心unit8、真实CLI13、实际prerequisite/库存2、业务storage33、native进程2
通过；全unit621。原79脚本加2prerequisite共81仍全部纳入 gate；失败已推进到
audit_logs普通表与分区脚本冲突，未降低原始验收。完整历史及回滚仍需继续。


## 审计转换后的全历史边界（2026-10-08）

新增 audit prerequisite，按依赖先于20260610_100000执行，原81个已发布源文件
全部字节不变；当前82个 pending 均纳入 gate。完整绑定修复包含分区函数的实际
父表/边界验证与 DEFAULT 行移动，以及 slow_query_history 中两处 MySQL 风格
内嵌 INDEX 改为 PostgreSQL CREATE INDEX。原始语句/字段均保留。

真实审计转换/五父表存储23、runner/prerequisite15、全unit621及业务storage/
native35通过。V1+V2通过，全部82历史 gate 越过审计阶段，但成就迁移因既有
user_achievements 缺少 completed 字段失败；四个用户外键已按 V1 UUID 修复。
全历史事务回滚，不记录假成功。完整目录、成就跨服务合同、后续分区重复迁移、
全历史回滚及其它服务初始化仍待完成；本需求保持 in_progress。


## 成就先决合同后的历史边界（2026-10-08）

第4个 prerequisite 桥接真实 V1 成就计数/定义与新目录；显式依赖让已有称号
bootstrap 与成就桥接先于旧 consumer。原82个已发布 pending 文件字节不变，
83个当前文件全部保留在 gate。实际成就/HTTP存储41、runner/prerequisite/
审计38通过；V1+V2通过。完整历史越过成就阶段后失败于20260611_020000
statement2 notification_type 缺失，全部 pending 事务回滚。下一步协调真实
notification_history/message-center 合同及后续冲突；全历史和带新数据回滚
依然未完成。
