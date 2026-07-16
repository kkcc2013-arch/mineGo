# REQ-00570: 贸易反作弊引擎模块化重构

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00570 |
| 标题 | 贸易反作弊引擎模块化重构 |
| 类别 | 技术债/重构 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | trade-service, anti-cheat-service |
| 创建时间 | 2026-07-16 12:00 |

## 需求描述

当前 `tradeFraudDetection.js` 文件规模庞大（超过1000行），包含复杂的业务逻辑，不仅难以维护且存在代码重构风险。
本项目旨在将其拆分为多个专注于单一功能的子模块：如 `TradeRuleValidator.js`（验证规则）、`RiskScoreCalculator.js`（风险分计算）、`LoggerComponent.js`（日志记录）。

## 技术方案

### 1. 模块拆分
- 创建 `src/services/trade-fraud/` 目录。
- 将 `tradeFraudDetection.js` 拆分为：
  - `BaseValidator.js`: 通用验证逻辑。
  - `TradeRules.js`: 具体贸易欺诈规则定义。
  - `RiskEngine.js`: 整合规则进行评分计算。
  - `Integration.js`: 适配原有接口，实现对原文件的平滑替换。

### 2. 代码示例 (拆分后的结构)
```javascript
// src/services/trade-fraud/RiskEngine.js
export class RiskEngine {
  constructor(rules) { this.rules = rules; }
  calculate(tradeData) {
    return this.rules.reduce((score, rule) => score + rule.evaluate(tradeData), 0);
  }
}
```

## 验收标准

- [ ] `tradeFraudDetection.js` 被成功拆分且逻辑功能未变。
- [ ] 现有单元测试覆盖率不低于 85%。
- [ ] 所有调用原 `tradeFraudDetection.js` 的接口保持兼容。
- [ ] 代码耦合度显著降低，循环复杂度（Cyclomatic Complexity）降低至 15 以下。

## 影响范围

- `src/services/trade-service/`
- `src/services/anti-cheat-service/`

## 参考

- 技术债列表: STATUS.md 第42行
