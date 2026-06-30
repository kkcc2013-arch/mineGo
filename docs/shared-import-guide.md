# 共享模块导入路径规范化指南

## 背景

本项目使用 `@shared` 别名系统来统一引用 `backend/shared` 目录中的模块，替代复杂的相对路径引用。

## 使用方法

### 旧方式（相对路径）

```javascript
// 在 catch-service/src/index.js 中
const { query } = require('../../../shared/db');
const { requireAuth } = require('../../../shared/auth');
const { habitatService } = require('../../../shared/habitatService');
```

### 新方式（别名路径）

```javascript
// 使用 @shared 别名
const { query } = require('@shared/db');
const { requireAuth } = require('@shared/auth');
const { habitatService } = require('@shared/habitatService');

// 或使用统一导出入口
const { db, auth, habitatService } = require('@shared');
```

## 配置文件

### 1. Babel 配置 (.babelrc)

```json
{
  "plugins": [
    ["module-resolver", {
      "alias": {
        "@shared": "./backend/shared",
        "@services": "./backend/services"
      }
    }]
  ]
}
```

### 2. IDE 支持 (jsconfig.json)

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["backend/shared/*"],
      "@shared": ["backend/shared/index.js"]
    }
  }
}
```

### 3. ESLint 配置 (.eslintrc.js)

```javascript
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

## 迁移脚本

运行迁移脚本自动转换现有代码：

```bash
# 检查需要迁移的文件（不实际修改）
node scripts/migrate-shared-imports.js --dry-run

# 执行迁移
node scripts/migrate-shared-imports.js

# 只迁移特定服务
node scripts/migrate-shared-imports.js --service=catch-service
```

## 统一导出入口

`backend/shared/index.js` 提供分类导出：

```javascript
// 导入整个 shared 模块
const shared = require('@shared');
const { db, redis, logger, auth } = shared;

// 或导入特定分类
const { query, transaction } = require('@shared').database;
const { CircuitBreaker, DegradationManager } = require('@shared').resilience;

// 或直接导入特定模块
const { query } = require('@shared/db');
```

## 优势

1. **路径一致性**：所有服务使用相同的导入语法
2. **重构友好**：shared 目录结构调整时只需更新 index.js
3. **IDE 支持**：支持智能跳转和代码补全
4. **可读性提升**：一眼识别模块来源

## 注意事项

- 确保所有服务都配置了 babel-plugin-module-resolver
- 迁移前先运行 `--dry-run` 检查影响范围
- 运行测试确保迁移后功能正常
- package.json 中的 workspaces 配置保持不变

## 示例迁移

### catch-service

**Before:**
```javascript
const { query } = require('../../../shared/db');
const { getRedis, getJSON, setJSON } = require('../../../shared/redis');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
```

**After:**
```javascript
const { query } = require('@shared/db');
const { getRedis, getJSON, setJSON } = require('@shared/redis');
const { requireAuth, AppError, successResp } = require('@shared/auth');
```

## 相关需求

- REQ-00385: 共享模块导入路径规范化与别名系统