# REQ-00553：微服务共享模块拆分与职责边界重构

- **编号**：REQ-00553
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、所有微服务
- **创建时间**：2026-07-15 03:00
- **依赖需求**：无

## 1. 背景与问题

当前 `backend/shared` 目录包含 100+ 个模块文件，总计近 10 万行代码，存在以下问题：

1. **文件过大**：多个核心文件超过 800 行（RiskControlEngine.js 1032行、tradeFraudDetection.js 1032行、deviceIntegrity.js 1019行），违反单一职责原则
2. **命名不一致**：混合使用驼峰命名（`distributedLock.js`）和短横线命名（`ar-sensor-validator.js`）
3. **职责混乱**：部分文件承担多个不相关职责，如 `metrics.js` 既包含业务指标又包含系统指标
4. **循环依赖风险**：随着文件增长，模块间依赖关系复杂化，存在潜在循环依赖

## 2. 目标

- 将所有超过 500 行的共享模块拆分为单一职责的小模块
- 统一文件命名规范为 kebab-case
- 建立清晰的模块边界和依赖图
- 提升代码可维护性和可测试性

## 3. 范围

- **包含**：
  - 分析并拆分 15 个超过 500 行的共享模块
  - 统一命名规范并迁移文件
  - 创建模块依赖图文档
  - 更新所有引用路径
  - 添加模块级单元测试

- **不包含**：
  - 业务逻辑修改
  - 接口变更
  - 性能优化

## 4. 详细需求

### 4.1 模块拆分规则

按职责拆分超 500 行文件：

```
RiskControlEngine.js (1032行) → 
  - risk-engine/risk-calculator.js (风险评估算法)
  - risk-engine/risk-decision-maker.js (决策逻辑)
  - risk-engine/rule-loader.js (规则加载)
  - risk-engine/risk-cache.js (风险缓存)

tradeFraudDetection.js (1032行) →
  - fraud/trade-pattern-analyzer.js (模式分析)
  - fraud/trade-risk-scorer.js (风险评分)
  - fraud/trade-alert-generator.js (告警生成)
  - fraud/trade-evidence-collector.js (证据收集)

deviceIntegrity.js (1019行) →
  - device/integrity-validator.js (完整性验证)
  - device/fingerprint-analyzer.js (指纹分析)
  - device/device-trust-scorer.js (信任评分)
  - device/device-history-tracker.js (历史追踪)
```

### 4.2 命名规范化

- 所有新文件使用 kebab-case
- 创建迁移脚本自动重命名旧文件
- 维护向后兼容的导出代理文件

### 4.3 依赖关系

- 使用 `madge` 工具生成依赖图
- 检测并消除循环依赖
- 文档化模块边界

## 5. 验收标准（可测试）

- [ ] 所有超过 500 行的共享模块拆分完成，单文件不超过 500 行
- [ ] 所有文件命名符合 kebab-case 规范
- [ ] 运行 `madge --circular backend/shared` 无循环依赖
- [ ] 所有现有测试通过（npm test）
- [ ] 新增模块级单元测试，覆盖率 > 80%
- [ ] 更新 API 文档，说明模块结构变化
- [ ] 提交 git commit，包含详细的重构说明

## 6. 工作量估算

**L (Large)** - 涉及 15+ 个文件拆分、命名迁移、依赖修复、测试补充，预计 2-3 天

## 7. 优先级理由

P1 理由：技术债累积会严重影响后续开发效率，拆分后可显著提升代码可维护性和团队协作效率，为后续功能开发打下良好基础。
