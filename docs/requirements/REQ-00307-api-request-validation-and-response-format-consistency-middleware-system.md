# REQ-00307: API 请求参数验证与响应格式一致性中间件系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00307 |
| 标题 | API 请求参数验证与响应格式一致性中间件系统 |
| 类别 | API 设计规范 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gateway、所有微服务、backend/shared/middleware、backend/shared/validators |
| 创建时间 | 2026-06-24 02:00 UTC |
| 依赖需求 | REQ-00157（统一错误处理与 API 响应格式标准化） |

## 1. 背景与问题

### 当前痛点

1. **验证逻辑分散**：各服务的参数验证逻辑散落在路由处理器中，缺乏统一标准
   - pokemon-service 中有的路由使用 `authenticate`，有的使用 `requireAuth`
   - 验证规则不统一，有的手动验证，有的使用 schemaValidator

2. **响应格式不一致**：API 响应格式存在多种模式
   - 模式 1：`{ success: true, data: {...} }`
   - 模式 2：直接返回数据对象
   - 模式 3：`{ error: "...", message: "..." }`
   - 缺乏统一的响应包装器

3. **验证错误信息不规范**：参数验证失败时返回的错误信息格式不一
   - 有的返回字段级别的错误详情
   - 有的只返回通用错误消息
   - 缺乏国际化支持

4. **缺乏请求上下文元数据**：响应中缺少请求 ID、时间戳等标准元数据

### 现有代码示例

```javascript
// pokemon-service/src/routes/pokedex.js - 响应格式不一致
router.get('/progress', authenticate, async (req, res) => {
  res.json({
    success: true,
    data: progress,  // 模式 1
  });
});

// 其他路由可能直接返回
router.get('/list', async (req, res) => {
  res.json(items);  // 模式 2：直接返回数组
});

// 验证逻辑散落
router.post('/create', async (req, res) => {
  if (!req.body.name || !req.body.type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // ... 业务逻辑
});
```

## 2. 目标

1. **统一请求参数验证**：建立基于 Schema 的统一验证中间件
2. **标准化响应格式**：所有 API 响应遵循统一的数据结构
3. **规范化错误信息**：验证错误包含字段级别的详细信息和国际化支持
4. **自动注入元数据**：响应自动包含 requestId、timestamp 等标准字段
5. **提升开发效率**：减少重复代码，提供声明式验证配置

## 3. 范围

### 包含
- 请求参数验证中间件（body、query、params、headers）
- 统一响应格式包装器
- 验证错误格式化与国际化
- 响应元数据注入中间件
- 常用验证规则库（ObjectId、坐标、分页等）
- 开发者友好的错误提示

### 不包含
- 业务逻辑验证（如"精灵是否存在"）
- 权限验证（属于认证/授权范畴）
- 响应数据过滤（已有 responseFilter）

## 4. 详细需求

### 4.1 统一响应格式标准

```typescript
// backend/shared/middleware/responseFormatter.ts

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: ValidationErrorDetail[];
    requestId: string;
  };
  meta: {
    requestId: string;
    timestamp: string;
    duration?: number; // 请求处理时长（毫秒）
  };
}

interface ValidationErrorDetail {
  field: string;
  message: string;
  value?: any;
  constraint: string;
}

// 响应格式化中间件
export function responseFormatter(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || generateRequestId();
  
  // 扩展 res 对象
  res.apiSuccess = (data: any) => {
    const response: ApiResponse = {
      success: true,
      data,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime
      }
    };
    res.json(response);
  };
  
  res.apiError = (code: string, message: string, details?: ValidationErrorDetail[]) => {
    const response: ApiResponse = {
      success: false,
      error: {
        code,
        message,
        details,
        requestId
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime
      }
    };
    res.status(getHttpStatus(code)).json(response);
  };
  
  res.locals.requestId = requestId;
  next();
}
```

### 4.2 统一验证中间件

```typescript
// backend/shared/middleware/requestValidator.ts

import { z } from 'zod';
import { ValidationErrorDetail } from './responseFormatter';

export function validateBody(schema: z.ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = await schema.parseAsync(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error);
        return res.apiError('VALIDATION_ERROR', '请求参数验证失败', details);
      }
      next(error);
    }
  };
}

export function validateQuery(schema: z.ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.query = await schema.parseAsync(req.query);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error);
        return res.apiError('VALIDATION_ERROR', '查询参数验证失败', details);
      }
      next(error);
    }
  };
}

export function validateParams(schema: z.ZodSchema) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      req.params = await schema.parseAsync(req.params);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error);
        return res.apiError('VALIDATION_ERROR', '路径参数验证失败', details);
      }
      next(error);
    }
  };
}

function formatZodErrors(error: z.ZodError): ValidationErrorDetail[] {
  return error.errors.map(err => ({
    field: err.path.join('.'),
    message: getLocalizedMessage(err.message, err.code),
    value: err.path.reduce((obj, key) => obj?.[key], error.data),
    constraint: err.code
  }));
}

function getLocalizedMessage(message: string, code: string): string {
  // 国际化消息映射
  const messages = {
    'invalid_type': '字段类型无效',
    'too_small': '值太小',
    'too_big': '值太大',
    'invalid_string': '字符串格式无效',
    'invalid_format': '格式无效',
    // ... 更多映射
  };
  return messages[code] || message;
}
```

### 4.3 常用验证规则库

```typescript
// backend/shared/validators/commonSchemas.ts

import { z } from 'zod';

// ObjectId 验证
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, {
  message: '无效的 ObjectId 格式'
});

// 坐标验证
export const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180)
});

// 分页参数验证
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc')
});

// 游标分页验证
export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

// 时间范围验证
export const timeRangeSchema = z.object({
  startTime: z.string().datetime().or(z.coerce.date()),
  endTime: z.string().datetime().or(z.coerce.date())
}).refine(data => data.endTime > data.startTime, {
  message: '结束时间必须晚于开始时间'
});

// 精灵 ID 验证
export const pokemonIdSchema = z.string().regex(/^pokemon_[a-z0-9]+$/, {
  message: '无效的精灵 ID 格式'
});

// 用户 ID 验证
export const userIdSchema = z.string().regex(/^user_[a-z0-9]+$/, {
  message: '无效的用户 ID 格式'
});

// 创建精灵验证 Schema
export const createPokemonSchema = z.object({
  speciesId: objectIdSchema,
  nickname: z.string().min(1).max(20).optional(),
  level: z.number().int().min(1).max(100).default(1),
  coordinates: coordinateSchema
});

// 更新精灵验证 Schema
export const updatePokemonSchema = z.object({
  nickname: z.string().min(1).max(20).optional(),
  isFavorite: z.boolean().optional()
}).partial();
```

### 4.4 使用示例

```javascript
// backend/services/pokemon-service/src/routes/pokemon.js

const express = require('express');
const router = express.Router();
const { validateBody, validateQuery, validateParams } = require('../../../shared/middleware/requestValidator');
const { responseFormatter } = require('../../../shared/middleware/responseFormatter');
const { 
  objectIdSchema, 
  paginationSchema, 
  createPokemonSchema,
  updatePokemonSchema 
} = require('../../../shared/validators/commonSchemas');

// 应用响应格式化中间件
router.use(responseFormatter);

/**
 * GET /api/pokemon
 * 获取精灵列表（分页）
 */
router.get('/',
  validateQuery(paginationSchema),
  async (req, res) => {
    const { page, pageSize, sortBy, sortOrder } = req.query;
    const result = await pokemonService.getList({ page, pageSize, sortBy, sortOrder });
    
    res.apiSuccess({
      items: result.items,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize)
      }
    });
  }
);

/**
 * GET /api/pokemon/:id
 * 获取精灵详情
 */
router.get('/:id',
  validateParams(z.object({ id: objectIdSchema })),
  async (req, res) => {
    const pokemon = await pokemonService.getById(req.params.id);
    
    if (!pokemon) {
      return res.apiError('NOT_FOUND', '精灵不存在');
    }
    
    res.apiSuccess(pokemon);
  }
);

/**
 * POST /api/pokemon
 * 创建精灵
 */
router.post('/',
  validateBody(createPokemonSchema),
  async (req, res) => {
    const pokemon = await pokemonService.create(req.body);
    res.status(201).apiSuccess(pokemon);
  }
);

/**
 * PATCH /api/pokemon/:id
 * 更新精灵
 */
router.patch('/:id',
  validateParams(z.object({ id: objectIdSchema })),
  validateBody(updatePokemonSchema),
  async (req, res) => {
    const pokemon = await pokemonService.update(req.params.id, req.body);
    res.apiSuccess(pokemon);
  }
);

module.exports = router;
```

### 4.5 错误码标准化

```typescript
// backend/shared/validators/errorCodes.ts

export const ValidationErrorCodes = {
  // 通用验证错误 (1000-1099)
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', http: 400, message: '请求参数验证失败' },
  MISSING_REQUIRED_FIELD: { code: 'MISSING_REQUIRED_FIELD', http: 400, message: '缺少必填字段' },
  INVALID_FORMAT: { code: 'INVALID_FORMAT', http: 400, message: '格式无效' },
  VALUE_OUT_OF_RANGE: { code: 'VALUE_OUT_OF_RANGE', http: 400, message: '值超出范围' },
  
  // 类型错误 (1100-1199)
  INVALID_TYPE: { code: 'INVALID_TYPE', http: 400, message: '字段类型无效' },
  INVALID_NUMBER: { code: 'INVALID_NUMBER', http: 400, message: '数字格式无效' },
  INVALID_DATE: { code: 'INVALID_DATE', http: 400, message: '日期格式无效' },
  
  // 业务实体错误 (1200-1299)
  INVALID_OBJECT_ID: { code: 'INVALID_OBJECT_ID', http: 400, message: '无效的 ObjectId' },
  INVALID_POKEMON_ID: { code: 'INVALID_POKEMON_ID', http: 400, message: '无效的精灵 ID' },
  INVALID_USER_ID: { code: 'INVALID_USER_ID', http: 400, message: '无效的用户 ID' },
  INVALID_COORDINATES: { code: 'INVALID_COORDINATES', http: 400, message: '坐标格式无效' },
  
  // 分页错误 (1300-1399)
  INVALID_PAGINATION: { code: 'INVALID_PAGINATION', http: 400, message: '分页参数无效' },
  PAGE_OUT_OF_RANGE: { code: 'PAGE_OUT_OF_RANGE', http: 400, message: '页码超出范围' }
} as const;

export function getHttpStatus(errorCode: string): number {
  const error = Object.values(ValidationErrorCodes).find(e => e.code === errorCode);
  return error?.http || 400;
}
```

### 4.6 国际化支持

```typescript
// backend/shared/validators/messages/zh-CN.ts

export const validationMessages = {
  // 类型错误
  'invalid_type': ({ expected, received }) => `期望类型 ${expected}，但收到 ${received}`,
  'invalid_literal': ({ expected }) => `期望值 ${expected}`,
  
  // 字符串错误
  'invalid_string': ({ validation }) => `字符串格式无效（${validation}）`,
  'too_small': ({ minimum, type }) => {
    if (type === 'string') return `字符串长度至少 ${minimum} 个字符`;
    if (type === 'number') return `数值必须 >= ${minimum}`;
    return `值太小`;
  },
  'too_big': ({ maximum, type }) => {
    if (type === 'string') return `字符串长度最多 ${maximum} 个字符`;
    if (type === 'number') return `数值必须 <= ${maximum}`;
    return `值太大`;
  },
  
  // 自定义验证
  'invalid_object_id': '无效的 ObjectId 格式',
  'invalid_pokemon_id': '无效的精灵 ID 格式',
  'invalid_coordinates': '坐标格式无效（纬度: -90~90，经度: -180~180）',
  'invalid_date_range': '时间范围无效',
  
  // 分页
  'invalid_page': '页码必须是正整数',
  'invalid_page_size': '每页数量必须在 1-100 之间'
};

// backend/shared/validators/messages/en-US.ts
export const validationMessages = {
  'invalid_type': ({ expected, received }) => `Expected ${expected}, received ${received}`,
  'invalid_string': ({ validation }) => `Invalid string format (${validation})`,
  'too_small': ({ minimum, type }) => {
    if (type === 'string') return `String must be at least ${minimum} characters`;
    if (type === 'number') return `Number must be >= ${minimum}`;
    return `Value too small`;
  },
  // ... 更多翻译
};
```

### 4.7 迁移工具

```typescript
// backend/shared/middleware/migrationHelper.ts

/**
 * 兼容旧响应格式的适配器
 * 用于渐进式迁移
 */
export function legacyResponseAdapter(req: Request, res: Response, next: NextFunction) {
  // 保存原始 res.json
  const originalJson = res.json.bind(res);
  
  // 拦截 res.json
  res.json = (data: any) => {
    // 如果响应已经是标准格式，直接返回
    if (data && typeof data === 'object' && 'success' in data && 'meta' in data) {
      return originalJson(data);
    }
    
    // 否则自动包装
    return res.apiSuccess(data);
  };
  
  next();
}

/**
 * 路由迁移脚本
 * 自动检测并提示需要迁移的路由
 */
export async function detectNonCompliantRoutes(servicesDir: string): Promise<string[]> {
  const nonCompliant: string[] = [];
  const files = await glob(`${servicesDir}/**/routes/*.js`);
  
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    
    // 检测不符合规范的响应
    if (content.includes('res.json({') && !content.includes('res.apiSuccess')) {
      nonCompliant.push(file);
    }
    
    // 检测手动验证
    if (content.includes('if (!req.body.') && !content.includes('validateBody')) {
      nonCompliant.push(file);
    }
  }
  
  return nonCompliant;
}
```

## 5. 验收标准

- [ ] 所有微服务路由使用统一验证中间件
- [ ] 响应格式符合 ApiResponse 标准定义
- [ ] 验证错误包含字段级别的详细信息和国际化支持
- [ ] 常用验证规则库覆盖 90% 以上场景
- [ ] 响应元数据包含 requestId、timestamp、duration
- [ ] 提供 Swagger/OpenAPI 自动生成 schema 支持
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 性能测试：中间件开销 < 5ms P95
- [ ] 文档包含完整的迁移指南和最佳实践
- [ ] 集成测试验证所有服务的响应格式一致性

## 6. 工作量估算

**L (Large)** - 预计 18-22 小时

理由：
- 需要设计和实现多个中间件（验证、响应格式化、国际化）
- 需要建立完整的验证规则库
- 需要迁移现有路由（9 个微服务）
- 需要编写迁移工具和文档
- 测试工作量较大

## 7. 优先级理由

**P1 理由：**

1. **用户体验**：一致的 API 响应格式提升前端开发体验
2. **开发效率**：声明式验证减少重复代码，提升开发速度
3. **错误排查**：标准化的错误信息包含 requestId，便于日志追踪
4. **国际化基础**：验证错误信息国际化是全球化产品的必需功能
5. **代码质量**：统一规范减少 bug，提升代码可维护性
6. **技术债**：当前代码存在多种响应格式，属于需要清理的技术债

## 8. 影响范围

### 新增文件
- `backend/shared/middleware/responseFormatter.ts`
- `backend/shared/middleware/requestValidator.ts`
- `backend/shared/validators/commonSchemas.ts`
- `backend/shared/validators/errorCodes.ts`
- `backend/shared/validators/messages/*.ts`
- `backend/tests/unit/response-formatter.test.ts`
- `backend/tests/unit/request-validator.test.ts`

### 修改文件
- 所有服务的路由文件（渐进式迁移）
- `backend/shared/middleware/index.ts`
- API 文档

### 依赖
- zod（已有依赖）
- i18next（用于国际化消息）

## 9. 参考

- [Zod Documentation](https://zod.dev/)
- [JSON Schema Specification](https://json-schema.org/)
- [API Design Guide - Microsoft](https://github.com/microsoft/api-guidelines)
- [Google API Design Guide](https://cloud.google.com/apis/design)
- REQ-00157：统一错误处理与 API 响应格式标准化
