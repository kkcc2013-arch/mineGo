# REQ-00624: Console 调用全面迁移至结构化日志系统

- **编号**：REQ-00624
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：所有后端服务、backend/shared/logger.js、backend/shared/loggingUtils.js
- **创建时间**：2026-07-21 11:00 UTC
- **依赖需求**：REQ-00501（日志输出适配器抽象层已完成）

## 1. 背景与问题

虽然项目已实现结构化日志系统（REQ-00501），但代码库中仍存在大量 `console.log/error/warn` 直接调用：

### 代码现状统计

- **424 个文件** 包含 console 调用
- **2697 处** console 语句散布在各模块中
- 这些调用无法：
  - 统一收集到集中式日志平台
  - 按环境配置日志级别
  - 添加结构化上下文（用户ID、请求ID等）
  - 与现有 Pino 日志系统集成

### 具体问题

1. **日志丢失**：console 输出不会进入日志管道，在生产环境中难以追踪
2. **格式不统一**：console.log 格式随意，无法被日志分析工具解析
3. **性能开销**：console 在生产环境仍有性能开销，无法动态关闭
4. **缺少上下文**：console 调用无法自动注入请求上下文（requestId、userId 等）
5. **分级困难**：无法按环境动态调整日志级别

## 2. 目标

将所有 `console.*` 调用迁移至结构化日志系统，实现：

1. **零 console 调用**：所有日志通过 `backend/shared/logger.js` 输出
2. **自动上下文注入**：所有日志自动携带 requestId、userId、service 等上下文
3. **环境感知**：开发环境保留友好输出，生产环境结构化输出
4. **性能优化**：通过日志级别动态控制，减少不必要的日志开销
5. **向后兼容**：提供迁移工具和代码规范，降低开发人员适应成本

## 3. 范围

- **包含**：
  - 创建 `backend/shared/loggingUtils.js` 迁移工具模块
  - 自动化脚本：扫描并报告所有 console 调用位置
  - 代码转换工具：自动将简单 console 调用转为 logger 调用
  - ESLint 规则：禁止新的 console 调用
  - 重构指南：复杂场景迁移示例
  - 分阶段迁移：优先处理核心服务（gateway/user-service/pokemon-service）
  - 单元测试：验证迁移正确性

- **不包含**：
  - 改变日志格式（已由 REQ-00501 定义）
  - 修改日志基础设施
  - 前端 game-client 的 console 调用（单独处理）
  - node_modules 中的第三方库 console 调用

## 4. 详细需求

### 4.1 迁移工具模块

```javascript
// backend/shared/loggingUtils.js

/**
 * Console 迁移工具
 * 用于临时替代 console，输出警告并转发到 logger
 */
class ConsoleMigrationHelper {
  constructor(logger, serviceName) {
    this.logger = logger;
    this.serviceName = serviceName;
  }
  
  log(...args) {
    this.logger.info({ migration: true, service: this.serviceName }, ...args);
    if (process.env.NODE_ENV === 'development') {
      console.trace('⚠️  请使用 logger.info() 替代 console.log()');
    }
  }
  
  error(...args) {
    this.logger.error({ migration: true, service: this.serviceName }, ...args);
  }
  
  warn(...args) {
    this.logger.warn({ migration: true, service: this.serviceName }, ...args);
  }
  
  info(...args) {
    this.logger.info({ migration: true, service: this.serviceName }, ...args);
  }
}

// 临时替换全局 console（用于渐进迁移）
function replaceConsole(logger, serviceName) {
  const helper = new ConsoleMigrationHelper(logger, serviceName);
  global.console = { ...console, ...helper };
}
```

### 4.2 自动化扫描脚本

```bash
# scripts/scan-console.sh
#!/bin/bash
echo "扫描 console 调用..."
find backend -name "*.js" -type f -exec grep -n "console\." {} + | \
  awk -F: '{print $1 ":" $2 " " $3}' | \
  sort | uniq -c | sort -rn > console-usage-report.txt
  
echo "报告已生成: console-usage-report.txt"
```

### 4.3 迁移规则

| 原 console 调用 | 目标 logger 调用 | 说明 |
|----------------|-----------------|------|
| `console.log('msg')` | `logger.info('msg')` | 一般信息 |
| `console.log('data:', obj)` | `logger.info({ data: obj }, 'msg')` | 带数据对象 |
| `console.error('err')` | `logger.error('err')` | 错误日志 |
| `console.warn('warn')` | `logger.warn('warn')` | 警告日志 |
| `console.error(err.stack)` | `logger.error({ err }, 'Error occurred')` | 错误堆栈 |
| `console.time('label')` | `logger.debug({ label }, 'Timer started')` | 计时器 |
| `console.timeEnd('label')` | `logger.debug({ label }, 'Timer ended')` | 计时结束 |

### 4.4 ESLint 规则

```javascript
// .eslintrc.js
module.exports = {
  rules: {
    'no-console': 'error',
    'no-restricted-syntax': [
      'error',
      {
        selector: 'CallExpression[callee.object.name="console"]',
        message: '请使用 backend/shared/logger.js 替代 console 调用'
      }
    ]
  }
};
```

### 4.5 分阶段迁移计划

**阶段 1（第 1-2 天）**：
- gateway 服务（约 50 文件）
- user-service（约 30 文件）

**阶段 2（第 3-4 天）**：
- pokemon-service（约 40 文件）
- catch-service（约 30 文件）

**阶段 3（第 5-6 天）**：
- location-service、gym-service（约 60 文件）

**阶段 4（第 7 天）**：
- social-service、reward-service、payment-service（约 50 文件）
- backend/shared/ 共享模块（约 40 文件）

### 4.6 迁移示例

**迁移前**：
```javascript
// 错误示例
app.get('/api/pokemon/:id', async (req, res) => {
  console.log('Fetching pokemon:', req.params.id);
  try {
    const pokemon = await db.query('...');
    console.log('Pokemon found:', pokemon.name);
    res.json(pokemon);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});
```

**迁移后**：
```javascript
// 正确示例
const logger = require('../shared/logger');

app.get('/api/pokemon/:id', async (req, res) => {
  logger.info({ pokemonId: req.params.id, requestId: req.id }, 'Fetching pokemon');
  try {
    const pokemon = await db.query('...');
    logger.info({ pokemonId: pokemon.id, name: pokemon.name }, 'Pokemon found');
    res.json(pokemon);
  } catch (err) {
    logger.error({ err, pokemonId: req.params.id }, 'Error fetching pokemon');
    res.status(500).json({ error: 'Internal error' });
  }
});
```

## 5. 验收标准（可测试）

- [ ] 创建 ConsoleMigrationHelper 工具类，支持渐进迁移
- [ ] 创建自动化扫描脚本，生成 console 使用报告
- [ ] 添加 ESLint 规则，禁止新的 console 调用
- [ ] **阶段 1 完成**：gateway 和 user-service 中 console 调用减少至 0
- [ ] **阶段 2 完成**：pokemon-service 和 catch-service 中 console 调用减少至 0
- [ ] 所有日志调用携带 requestId 上下文（通过中间件自动注入）
- [ ] 单元测试覆盖率 >= 85%
- [ ] 性能测试：迁移后日志开销不超过迁移前的 5%
- [ ] 文档：提供迁移指南和最佳实践示例
- [ ] CI/CD 集成：CI 中运行扫描脚本，发现新 console 调用则失败

## 6. 工作量估算

**XL（Extra Large）** - 预计 7-10 个工作日

- 迁移工具开发：1 天
- gateway + user-service 迁移：2 天
- pokemon + catch-service 迁移：2 天
- 其他服务迁移：2 天
- ESLint 规则 + CI 集成：1 天
- 文档与测试：2 天

## 7. 优先级理由

**P1（高优先级）**：

1. **日志完整性关键**：console 调用导致日志丢失，影响生产环境问题排查
2. **技术债积累严重**：2697 处 console 调用已形成严重技术债
3. **已有基础设施**：REQ-00501 已完成结构化日志系统，迁移成本低
4. **性能优化机会**：结构化日志可通过级别控制减少生产环境开销
5. **监控集成前提**：为后续日志分析、告警系统奠定基础

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 大量文件修改可能引入 bug | 分阶段迁移，每阶段后运行完整测试套件 |
| 开发人员习惯 console 调用 | ESLint 强制规则 + 代码审查 |
| 第三方库仍使用 console | 白名单机制，允许第三方库 console 调用 |
| 日志量大幅增加 | 配置合理的日志级别，生产环境减少 DEBUG 日志 |
