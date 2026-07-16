# REQ-00571: tradeFraudDetection.js 服务代码拆分与模块化重构

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00571 |
| 标题 | tradeFraudDetection.js 服务代码拆分与模块化重构 |
| 类别 | 技术债/重构 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | trade-service, anti-cheat-service |
| 创建时间 | 2026-07-16 13:00 |

## 需求描述

目前 `tradeFraudDetection.js` 代码库已达到 1032 行，职责过于庞大，包含交易规则校验、行为分析、异常评分和联动阻断。为了提高代码可维护性、降低测试难度，需将其拆分为多个独立职责模块。

## 技术方案

### 1. 职责拆分
- `TradeValidator.js`: 处理基础交易规则校验
- `BehaviorAnalyzer.js`: 处理用户交易行为轨迹分析
- `AnomalyScorer.js`: 处理多因子异常分数计算
- `InterventionEngine.js`: 处理联动阻断与风险触发

### 2. 重构路径
- 将现有逻辑迁移至上述模块
- 在原 `tradeFraudDetection.js` 中保留 facade 接口，逐步向新模块迁移流量
- 增加新模块的单元测试覆盖率

## 验收标准

- [ ] 完成代码拆分，原文件大小降至 200 行以内
- [ ] 确保拆分后的模块具备独立的单元测试覆盖率达到 80% 以上
- [ ] 系统运行性能未发生退化（压测对比）
- [ ] 所有旧的集成测试用例均通过

## 影响范围

- `/src/services/trade/tradeFraudDetection.js`
- `/src/services/trade/modules/*` (新建目录)

## 参考

- [技术债清理清单](/data/mineGo/docs/requirements/STATUS.md)
