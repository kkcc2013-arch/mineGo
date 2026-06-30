# REQ-00385：共享模块导入路径规范化与别名系统

- **编号**：REQ-00385
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared、所有微服务、babel/config、package.json、.eslintrc
- **创建时间**：2026-06-30 11:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前 backend/shared 目录包含超过 150 个共享模块文件，但各微服务引用这些模块时存在以下问题：

1. **路径混乱**：使用多层级相对路径 `require('../../../shared/xxx')`，在不同服务、不同目录层级中路径长度不一
2. **重构困难**：当 shared 模块内部结构调整时，需要修改数百处引用路径
3. **可读性差**：难以一眼识别模块来源，`../../` 层级堆叠影响代码可读性
4. **符号链接不一致**：部分服务使用符号链接 `backend/services/xxx/shared -> backend/shared`，但并非统一规范
5. **IDE 支持弱**：相对路径难以支持智能跳转和重构工具

当前代码示例：
```javascript
// catch-service/src/index.js
const { query } = require('../../../shared/db');
const { requireAuth } = require('../../../shared/auth');
const { habitatService } = require('../../../shared/habitatService');

// gateway/src/routes/businessMetrics.js
const { authenticate } = require('../../../../shared/middleware/auth');
```

## 2. 目标

1. 建立统一的模块别名系统，使用 `@shared/` 前缀引用共享模块
2. 支持所有微服务使用一致的导入语法：`require('@shared/db')`
3. 提升代码可读性和重构便利性
4. 支持 IDE 智能提示和跳转
5. 为未来 TypeScript 迁移做准备

## 3. 范围

- **包含**：
  - 配置 Node.js 模块别名（package.json subpath imports 或 babel-plugin-module-resolver）
  - 迁移所有 `require('../../../shared/xxx')` 为 `require('@shared/xxx')`
  - 更新 backend/shared/index.js 统一导出入口
  - 配置 ESLint 和 IDE 支持
  - 更新测试文件中的引用路径

- **不包含**：
  - TypeScript 迁移（后续需求）
  - ES Module 迁移（后续需求）
  - 前端代码路径别名（不同构建工具）

## 4. 详细需求

### 4.1 别名配置方案

采用 Node.js 原生 subpath imports（Node.js 12.7.0+ 支持）：

```json
// package.json
{
  "imports": {
    "@shared/*": "./shared/*.js",
    "@shared": "./shared/index.js"
  }
}
```

或使用 babel-plugin-module-resolver 作为兼容方案：

```javascript
// .babelrc
{
  "plugins": [
    ["module-resolver", {
      "alias": {
        "@shared": "./shared"
      }
    }]
  ]
}
```

### 4.2 导入路径迁移

将所有相对路径引用迁移为别名路径：

**Before:**
```javascript
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { requireAuth } = require('../../../shared/auth');
```

**After:**
```javascript
const { query } = require('@shared/db');
const { createLogger } = require('@shared/logger');
const { requireAuth } = require('@shared/auth');
```

### 4.3 统一导出入口优化

优化 `backend/shared/index.js`，分类导出常用模块：

```javascript
// backend/shared/index.js
module.exports = {
  // 核心基础设施
  db: require('./db'),
  redis: require('./redis'),
  logger: require('./logger'),
  metrics: require('./metrics'),
  
  // 中间件
  middleware: {
    auth: require('./middleware/auth'),
    errorHandler: require('./middleware/errorHandler'),
    requestId: require('./middleware/requestId'),
    // ...
  },
  
  // 工具类
  utils: {
    cache: require('./cache'),
    i18n: require('./i18n'),
    // ...
  },
  
  // 服务类
  services: {
    habitatService: require('./habitatService'),
    weatherService: require('./weatherService'),
    // ...
  }
};
```

### 4.4 ESLint 配置支持

```javascript
// .eslintrc.js
module.exports = {
  settings: {
    'import/resolver': {
      alias: {
        map: [['@shared', './backend/shared']],
        extensions: ['.js']
      }
    }
  }
};
```

### 4.5 jsconfig.json 配置（IDE 支持）

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["backend/shared/*"]
    }
  }
}
```

### 4.6 迁移脚本

创建迁移脚本 `scripts/migrate-shared-imports.js`：
- 扫描所有 `require('../../../shared/xxx')` 模式
- 自动替换为 `require('@shared/xxx')`
- 生成迁移报告
- 支持回滚

## 5. 验收标准（可测试）

- [ ] 所有微服务代码中不再存在 `require('../../../*shared` 相对路径引用
- [ ] 使用 `require('@shared/xxx')` 可以正常导入共享模块
- [ ] 运行 `npm test` 所有测试通过
- [ ] ESLint 无 `import/no-unresolved` 错误
- [ ] VSCode/WebStorm 可以 Ctrl+点击跳转到 `@shared/` 模块定义
- [ ] 迁移脚本可重复执行且幂等
- [ ] 文档更新：开发者指南中添加别名使用说明

## 6. 工作量估算

**L (Large)**
- 需要扫描和修改约 500+ 个文件引用
- 配置和测试多种环境兼容性
- 迁移脚本开发和验证
- 文档更新

## 7. 优先级理由

**P1 理由**：
1. 影响所有服务的开发效率和代码可维护性
2. 为后续 TypeScript 迁移奠定基础
3. 降低新开发者的上手成本
4. 减少因路径错误导致的 bug
5. 虽非紧急，但对长期代码质量影响显著
