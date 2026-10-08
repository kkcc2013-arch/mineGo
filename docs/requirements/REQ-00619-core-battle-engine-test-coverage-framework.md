# REQ-00619: 核心战斗引擎业务测试覆盖框架

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00619 |
| 标题 | 核心战斗引擎业务测试覆盖框架 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | in_progress |
| 涉及服务 | gym-service, battle-engine-module |
| 创建时间 | 2026-07-21 00:00 |

## 需求描述

为了确保核心战斗逻辑的稳定性和正确性，需要建立一套针对核心战斗引擎的业务测试覆盖框架。目前战斗逻辑较为复杂，缺乏细颗粒度的业务集成测试。目标是实现对战斗公式、状态变化、BUFF叠加效果等业务逻辑的自动化验证。

## 技术方案

### 1. 业务逻辑分离与注入
- 将战斗公式计算逻辑解耦，通过依赖注入方式在测试中替换模拟数据。
- 引入战斗上下文模拟器，模拟不同环境条件下的战斗状态。

### 2. 测试场景驱动 (Scenario-Driven Testing)
- 使用 Gherkin 风格定义测试用例（Given/When/Then）。
- 覆盖极端场景：空属性、最大数值溢出、循环状态切换。

## 验收标准

- [x] 实现针对战斗公式的单元测试覆盖率 > 90%
- [x] 完成战斗引擎集成测试套件，涵盖至少 50 个典型业务场景
- [x] 战斗引擎回归测试流水线集成到 CI/CD

### 2026-10-06 本地验收证据

- `cd backend && npm run test:battle`：Node.js 20.20.2 下通过。
- `cd backend && npm run test:battle:coverage`：Node.js 24.19.0 下通过；57 个公式用例、76 个业务场景，共 133 个用例。
- `battleFormulas.js` 行、分支、函数覆盖率均为 100%，CI 门禁均设置为至少 91%。
- `.github/workflows/ci-cd.yml` 新增独立 battle-regression 作业，并加入构建前置条件。
- 按 GUIDELINES.md 完成定义，远程 CI 尚未运行；保留 `in_progress`，未声明整体完成。场景套件使用可注入状态服务边界；数据库、Redis 及生产性能验收不由该套件代替。

## 影响范围

- /data/mineGo/gym-service/battle-engine/
- /data/mineGo/tests/gym-service-integration/

## 参考

- [核心战斗引擎设计规范](/data/mineGo/docs/api-spec/battle-engine-design.md)
