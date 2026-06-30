# REQ-00391：console.log 替换与结构化日志强制使用系统

- **编号**：REQ-00391
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared（190 个模块）、所有微服务、gateway、CI/CD 检查规则
- **创建时间**：2026-06-30 17:00 UTC
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标集成）

## 1. 背景与问题

当前项目已实现完善的结构化日志系统（backend/shared/logger.js，基于 pino），支持：
- JSON 格式输出、多级别日志、请求追踪注入
- 敏感信息红action（authorization、password、token）
- OpenTelemetry traceId/spanId 自动注入
- 子日志器上下文预设

**然而**，代码分析发现 backend/shared 目录 190 个模块中存在 **62 处** console.log/console.error/console.warn 调用：
- 这些 console 调用无法关联 traceId，导致分布式追踪断裂
- 生产环境日志无法聚合分析，排查问题困难
- 缺乏结构化元数据（service、level、timestamp）
- CI/CD 流程无检测规则，新代码仍可能引入 console 调用

## 2. 目标

1. 消除所有 backend/shared 模块中的 console.log/console.error/console.warn 调用
2. 强制所有微服务使用 createLogger 创建的结构化日志实例
3. 建立 CI/CD lint 规则，阻止新代码引入 console 直接调用
4. 提供迁移指南和最佳实践文档

## 3. 范围

- **包含**：
  - 扫描并替换 backend/shared/*.js 中所有 console 调用
  - 为每个模块注入 logger 实例或使用 module-level logger
  - 添加 ESLint 规则 `no-console` 并配置例外场景
  - 更新 CONTRIBUTING.md 日志使用规范
  - 添加迁移脚本和自动化检测

- **不包含**：
  - frontend 目录的 console 调用（浏览器环境需要 console）
  - 数据库迁移脚本中的 console（一次性运行脚本）
  - CLI 工具脚本中的 console（用户交互需要）

## 4. 详细需求

### 4.1 日志替换策略

每个 shared 模块应采用以下模式：

```javascript
// 模式 A：已有 logger 参数的模块（推荐）
module.exports = function someService(logger = defaultLogger) {
  logger.info({ module: 'someService' }, 'Service initialized');
  // ...
};

// 模式 B：模块级 logger（无依赖注入）
const { createLogger } = require('./logger');
const moduleLogger = createLogger('shared/someService');
module.exports = { someFunction() { moduleLogger.info(...); } };

// 模式 C：获取调用方 logger（需要上下文）
// 通过函数参数传递 logger，避免全局状态
```

### 4.2 ESLint 规则配置

```json
// .eslintrc.json
{
  "rules": {
    "no-console": ["error", { "allow": ["warn", "time", "timeEnd"] }],
    "no-restricted-syntax": [
      "error",
      {
        "selector": "CallExpression[callee.object.name='console'][callee.property.name='log']",
        "message": "使用 logger.info/debug 代替 console.log"
      },
      {
        "selector": "CallExpression[callee.object.name='console'][callee.property.name='error']",
        "message": "使用 logger.error 代替 console.error"
      }
    ]
  },
  "overrides": [
    {
      "files": ["frontend/**", "database/migrations/**", "scripts/cli/**"],
      "rules": { "no-console": "off" }
    }
  ]
}
```

### 4.3 迁移检测脚本

```bash
# scripts/check-console-usage.sh
#!/bin/bash
# 检测 backend 目录中的 console 调用（排除允许的例外）

find backend/shared -name "*.js" -exec grep -l "console\\.log\\|console\\.error" {} \; | \
  grep -v "__mocks__" | \
  wc -l

# 输出 > 0 时 CI 失败
```

### 4.4 日志上下文规范

所有日志调用必须包含：
- `module` 字段：模块标识
- `action` 字段（可选）：操作类型
- 业务相关元数据（userId、pokemonId 等）

示例：
```javascript
logger.info({ module: 'CircuitBreaker', action: 'open', serviceName: 'payment' }, 
  'Circuit breaker opened for payment-service');
```

## 5. 验收标准（可测试）

- [ ] backend/shared 目录所有 .js 文件无 console.log/console.error 调用（检测脚本输出 0）
- [ ] ESLint 配置添加 no-console 规则且 CI 通过
- [ ] 所有替换后的日志包含 module 字段
- [ ] 迁移后现有测试全部通过
- [ ] CONTRIBUTING.md 包含日志使用规范章节
- [ ] CI/CD 流程包含 console 调用检测步骤

## 6. 工作量估算

**L** - 需要替换 62+ 处调用，涉及 190 个模块扫描，ESLint 配置，文档更新，测试验证

## 7. 优先级理由

P1 级别理由：
- 日志是可观测性核心组件，console.log 破坏了分布式追踪的完整性
- 生产问题排查依赖结构化日志，当前状态导致排查效率低下
- 技术债积累会随着模块增加而恶化，需尽快治理
- 相比其他 P1 需求，此需求是基础架构改进，影响所有后续功能开发