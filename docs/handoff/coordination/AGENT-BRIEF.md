# mineGo 实现批次 —— 工作约定（所有执行代理共用）

## 仓库与分支

- 集成分支：`dev/review-20260924`（主仓库 `/data/workspace/mineGo/repo`，由协调者合并，**你不要改主仓库、不要 push、不要碰 main**）。
- 你的工作区是一个 git worktree（路径和分支见任务说明），在里面改代码并 `git commit`（可多次提交）。
- 提交信息用中文、与现有风格一致（如 `feat(REQ-00048): …` / `fix(db): …`），正文末尾加一行：
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 代码风格与周边代码保持一致（CommonJS、pino logger `require('<shared>/logger')`、Express Router、`pg` 参数化 SQL）。

## 中断保护（重要）

本机环境会不定期重启，你的会话随时可能被中止、之后再被恢复。因此：
- **每完成一个小单元（一个需求、一个迁移、一组测试）就 `git commit`**，不要攒到最后；
- 在 worktree 根目录维护 `PROGRESS.md`（不提交也行）记录：已完成什么、下一步做什么、遇到的坑；恢复时先读它；
- 被中止（主机重启、API 额度用尽）后恢复时，先 `git status` + 读 `PROGRESS.md` 再继续；不需要启动 CI 栈（见"验证方式"）。

## 验证方式（2026-09-25 18:30 起，用户要求）

**不要启动任何服务做验证**——服务级验证由用户另行安排。只写代码、更新需求文档与进度。
- 禁止：`ci-stack.sh sync/start/reset-db/migrate/smoke/test`、PM2、Playwright/浏览器、连接数据库或 Redis 的测试；
- 允许（宿主机即可）：`node --check <文件>`、`node scripts/check-deps.js`、不依赖服务的纯逻辑单测
  （宿主机没有 backend/node_modules 时，只跑不 require 第三方包的测试；跑不了就只写测试不运行）；
- 仍然要写测试（单测/冒烟脚本），供用户验证时运行；在实现记录里写明"未运行，待验证"；
- 迁移 SQL 要仔细自查（幂等、外键类型、依赖顺序），因为不会在库上试跑；
- **不要新增或修改 `.github/workflows/*`**（推送用的 token 没有 workflow 权限，含这类改动的分支推不上 GitHub）；
  CI 工作流模板放 `ci/github-workflows/`，在实现记录里注明需有权限的人拷贝过去。

下面"CI 栈"一节仅供了解，**当前不要使用**。

## （停用）验证环境：本机 docker 容器 `mine` 内的隔离 CI 栈

```bash
export STACK=<你的栈号> REPO=<你的 worktree 绝对路径>
/data/workspace/mineGo/tools/ci-stack.sh sync       # 把 worktree（含未提交改动）同步进容器；依赖变化时自动 npm install
/data/workspace/mineGo/tools/ci-stack.sh reset-db   # 重建数据库 pmg_ci_<N> 并跑全部迁移（bootstrap-dev）+ 刷怪点种子
/data/workspace/mineGo/tools/ci-stack.sh migrate    # 在现有库上重跑迁移（幂等收敛）
/data/workspace/mineGo/tools/ci-stack.sh start      # PM2 启动/重载 ci<N>-* 全部服务并等待网关健康
/data/workspace/mineGo/tools/ci-stack.sh test       # backend 单元测试（npm run test:unit）
/data/workspace/mineGo/tools/ci-stack.sh smoke      # 经网关的端到端冒烟 scripts/smoke-core-flow.js（基线 37/37 必须保持）
/data/workspace/mineGo/tools/ci-stack.sh psql -Atc "\"select 1\""   # 连接你的库
/data/workspace/mineGo/tools/ci-stack.sh logs user  # 看某服务最新日志
/data/workspace/mineGo/tools/ci-stack.sh sh "cd backend && node tests/unit/xxx.test.js"   # 在容器内你的副本里执行任意命令
/data/workspace/mineGo/tools/ci-stack.sh env        # 打印 DATABASE_URL / REDIS_URL / BASE_URL（含密码，勿写入文件或输出到报告）
```

- 网关地址 `http://127.0.0.1:(18080+100N)`，只在容器内可访问（用 `ci-stack.sh sh "curl ..."`）。
- 宿主机没有 backend/node_modules，测试都在容器里跑。
- **禁止**操作容器内原有的 `pmg-*` 进程、`pmg` 数据库、6379 端口的 Redis、`/data/mineGo` 目录；只用你自己的栈号。
- 不要把任何密码/密钥写进仓库或输出到最终报告。

## API 规范门禁（E25 已合并，2026-09-25 起）

在仓库根目录运行（宿主机即可，不需要服务）：
- `node scripts/api-lint.js`：路由命名规范，必须 0 error；新增/修改路由后再跑 `node scripts/api-lint.js --docs` 重新生成路由文档并一起提交；
- `node scripts/contract-snapshot.js --check`：契约快照门禁，必须"未审批 0"。
  改了已有契约的接口（契约在 `backend/shared/apiStandards/schemas`）的响应结构时，同步修改契约并 `--update` 快照；
  破坏性变更要在 `docs/api-spec/contracts/approved-breaking-changes.json` 登记原因；
- 注意：非生产环境下，响应不符合契约的接口会返回 500（用于发现契约漂移），所以改响应结构时务必同步契约。
- 规范说明见 `docs/api-guidelines.md`、`docs/api-standards/`。

## "完成"的定义（每个需求逐条核对）

1. 代码从服务入口可达（不是孤立模块）；对外接口经网关可访问并有鉴权（网关 `backend/gateway/src/index.js`）。
2. 依赖的表由迁移创建，且在全新库上可执行（逐条自查：依赖的表/列在更早的迁移中已存在）。新迁移放 `database/migrations/`，文件名 `YYYYMMDD_HHMMSS__描述.sql`，用 `IF NOT EXISTS` 保持幂等；外键类型与被引用列一致（`users.id` 是 UUID）。
3. 有覆盖真实代码的测试：单元测试直接 require 业务模块（`node --test` 风格，放 `backend/tests/unit/`，并加进 `backend/package.json` 的 `test:unit`），和/或集成测试经网关打到运行中的服务（可扩展 `scripts/smoke-core-flow.js` 或新增 `scripts/smoke-<主题>.js`）。
4. 前端需求在 `frontend/game-client` 实现，能在浏览器加载。
5. 生产未使用的基础设施（K8s/Jaeger/Grafana 等）交付配置 + 静态校验，在实现记录中注明"未在生产环境验证"。
6. 在该需求文档中：把元信息里的状态改为 `implemented`（代码全部完成、未运行验证；`done` 留给用户验证通过后再改）或 `partial`（仍有未实现项）；文末追加

   ```markdown
   ## 实现记录（2026-09-24）

   | 验收标准 | 结果 | 说明 |
   |---|---|---|
   | …原文… | ✅/⚠️/❌ | 对应代码/测试/偏差原因（✅ = 代码已实现，待验证） |

   - 入口：…（服务/路由/网关路径）
   - 迁移：…
   - 测试：…（文件与运行命令；注明"未运行，待验证"）
   - 待验证：…（用户验证时要重点看的点）
   ```

   性能类指标（P95、QPS、50 万用户等）不实测，标 ⚠️ 并写明建议的压测方法（脚本放 `scripts/bench-*.js`）。

## 效率要求

- 需求文档很长，先读"需求描述/验收标准/影响范围"，不要逐字照抄技术方案；优先复用仓库里已有但未接入的模块（`backend/shared` 里很多），质量太差就重写。
- 用 `grep`/`sed -n` 定位，避免整文件读取大文件。
- 同类需求合并实现，一个实现可以满足多个需求文件（在每个需求文档里都写实现记录）。

## 完成后回报（你的最终消息）

- 提交列表（hash + 标题）；每个需求的最终状态（implemented/partial）与未完成项原因；
- 已做的静态检查（node --check、check-deps、可在宿主机跑的纯逻辑单测）与新增的待运行测试清单；
- 需要协调者注意的冲突/风险（改了哪些公共文件，如 gateway/src/index.js、shared/*、package.json）。
- 如果之前启动过自己的 CI 栈，结束前 `ci-stack.sh stop` 停掉。
