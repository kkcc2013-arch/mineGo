# REQ-00532：API 响应字段投影与动态字段集系统

- **编号**：REQ-00532
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有后端服务、backend/shared/utils/FieldProjection.js、backend/shared/middleware/fieldProjectionMiddleware.js、game-client
- **创建时间**：2026-07-11 06:00 UTC
- **依赖需求**：REQ-00008（OpenAPI 文档标准化）、REQ-00307（API 请求验证与响应格式一致性）

## 1. 背景与问题

当前 mineGo 项目的 API 响应返回完整数据对象，存在以下问题：

### 1.1 过度获取（Over-fetching）
```javascript
// GET /api/pokemon/my/:id
// 返回完整精灵数据（~5KB），但用户可能只需要基本信息
{
  "id": 12345,
  "speciesId": 25,
  "name": "Pikachu",
  "nickname": "Sparky",
  "level": 50,
  "exp": 125000,
  "iv": { "attack": 15, "defense": 14, "stamina": 15 },
  "stats": { "hp": 120, "attack": 112, "defense": 98, ... },
  "moves": [...], // 详细招式列表
  "abilities": [...], // 能力列表
  "heldItem": {...},
  "location": {...}, // 捕捉位置
  "createdAt": "2025-06-15T10:30:00Z",
  "friendship": 220,
  "nature": "Jolly",
  // ... 50+ 字段
}

// 用户列表页只需要：id, speciesId, nickname, level, thumbnail
// 移动端网络传输浪费 ~80%
```

### 1.2 列表接口性能问题
- `/api/pokemon/my` 返回 30 条精灵，每条完整数据 ~5KB，总响应 150KB+
- 移动端带宽有限，大响应体导致加载慢
- 数据库查询冗余字段浪费 CPU 和内存

### 1.3 不同场景需求差异
- **列表页**：仅需 id, name, thumbnail, level
- **详情页**：需要完整数据
- **战斗页**：需要 stats, moves, abilities
- **社交页**：需要 name, level, friendship, location

当前无法根据场景定制返回字段。

### 1.4 缺少 GraphQL 级灵活性
- 项目采用 REST API，无法像 GraphQL 那样按需查询字段
- 多次请求不同接口获取部分数据效率低

## 2. 目标

构建 API 响应字段投影系统，实现类似 GraphQL 的字段选择能力：

1. **按需返回字段**：客户端通过 `fields` 参数指定需要的字段
2. **预定义字段集**：支持场景化字段集（list/detail/battle/social）
3. **嵌套字段投影**：支持关联对象的字段选择
4. **自动裁剪**：中间件自动裁剪响应数据
5. **性能优化**：数据库查询优化，避免查询不需要的字段
6. **向后兼容**：不传 fields 参数时返回完整数据

**可量化目标**：
- 列表接口响应体减少 70%+
- 数据库查询字段减少 50%+
- 接口响应时间减少 30%+
- 移动端流量节省 60%+

## 3. 范围

### 包含
- FieldProjection 核心模块（字段解析、裁剪、验证）
- 预定义字段集管理（list/detail/battle/social 等）
- 字段投影中间件（自动处理响应裁剪）
- 数据库查询优化集成（Sequelize attributes 支持）
- OpenAPI 文档扩展（fields 参数文档）
- 管理员 API（字段集 CRUD）
- 单元测试和集成测试

### 不包含
- GraphQL 迁移（保留 REST 架构）
- 复杂的嵌套字段聚合（跨服务）
- 客户端 SDK 自动生成（后续需求）

## 4. 详细需求

### 4.1 FieldProjection 核心模块

```javascript
// backend/shared/utils/FieldProjection.js

'use strict';

const { createLogger } = require('../logger');
const logger = createLogger('field-projection');

/**
 * 字段投影引擎
 */
class FieldProjection {
  constructor(options = {}) {
    // 预定义字段集
    this.fieldsets = options.fieldsets || {};
    
    // 默认字段集
    this.defaultFieldsets = {
      list: ['id', 'name', 'thumbnail', 'level'],
      detail: null, // null 表示完整字段
      summary: ['id', 'name', 'level', 'exp'],
      battle: ['id', 'name', 'level', 'stats', 'moves', 'abilities'],
      social: ['id', 'name', 'level', 'friendship', 'location'],
      minimal: ['id']
    };
    
    // 最大字段深度
    this.maxDepth = options.maxDepth || 5;
    
    // 最大字段数
    this.maxFields = options.maxFields || 50;
    
    // 字段白名单（允许查询的字段）
    this.allowedFields = options.allowedFields || {};
    
    // 敏感字段（禁止投影）
    this.sensitiveFields = options.sensitiveFields || [
      'password', 'token', 'secret', 'apiKey', 'privateKey'
    ];
  }

  /**
   * 解析 fields 查询参数
   * @param {string} fieldsQuery - 如 "id,name,level,stats.hp"
   * @param {string} preset - 预设字段集名称
   * @returns {Object} 解析后的字段树
   */
  parseFields(fieldsQuery, preset = null) {
    // 如果指定了预设，使用预设字段集
    if (preset && (this.fieldsets[preset] || this.defaultFieldsets[preset])) {
      const presetFields = this.fieldsets[preset] || this.defaultFieldsets[preset];
      if (presetFields === null) {
        return null; // 完整字段
      }
      return this.buildFieldTree(presetFields);
    }

    // 未指定 fields，返回完整字段
    if (!fieldsQuery) {
      return null;
    }

    // 解析字段列表
    const fields = fieldsQuery.split(',').map(f => f.trim()).filter(Boolean);

    // 安全检查
    if (fields.length > this.maxFields) {
      throw new Error(`Too many fields requested: ${fields.length} > ${this.maxFields}`);
    }

    // 构建字段树
    return this.buildFieldTree(fields);
  }

  /**
   * 构建字段树结构
   * 支持嵌套字段：stats.hp, moves[].name
   */
  buildFieldTree(fields) {
    const tree = {};

    for (const field of fields) {
      // 检查敏感字段
      if (this.isSensitiveField(field)) {
        logger.warn({ field }, 'Sensitive field requested, skipping');
        continue;
      }

      // 解析嵌套路径
      const parts = field.split('.');
      let current = tree;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        
        // 数组标记 []
        const arrayMatch = part.match(/^(.+)\[\]$/);
        const fieldName = arrayMatch ? arrayMatch[1] : part;
        const isArray = !!arrayMatch;

        if (i === parts.length - 1) {
          // 叶子节点
          current[fieldName] = isArray ? { _isArray: true } : true;
        } else {
          // 中间节点
          if (!current[fieldName]) {
            current[fieldName] = isArray 
              ? { _isArray: true, _children: {} } 
              : {};
          }
          current = isArray 
            ? current[fieldName]._children 
            : current[fieldName];
        }
      }
    }

    return tree;
  }

  /**
   * 裁剪对象到指定字段
   * @param {Object} data - 原始数据
   * @param {Object} fieldTree - 字段树
   * @returns {Object} 裁剪后的数据
   */
  project(data, fieldTree) {
    // null 表示返回完整数据
    if (fieldTree === null) {
      return data;
    }

    // 数组处理
    if (Array.isArray(data)) {
      return data.map(item => this.project(item, fieldTree));
    }

    // 对象裁剪
    const result = {};
    for (const [field, value] of Object.entries(fieldTree)) {
      if (!(field in data)) {
        continue;
      }

      if (value === true) {
        // 叶子字段
        result[field] = data[field];
      } else if (typeof value === 'object' && value !== null) {
        // 嵌套对象
        if (value._isArray) {
          // 数组字段
          const nestedTree = value._children || { id: true };
          result[field] = data[field].map(item => this.project(item, nestedTree));
        } else {
          // 普通嵌套对象
          result[field] = this.project(data[field], value);
        }
      }
    }

    return result;
  }

  /**
   * 检查是否为敏感字段
   */
  isSensitiveField(field) {
    const lowerField = field.toLowerCase();
    return this.sensitiveFields.some(sf => 
      lowerField.includes(sf.toLowerCase())
    );
  }

  /**
   * 转换为数据库查询属性
   * @param {Object} fieldTree - 字段树
   * @param {Array} allFields - 所有可用字段
   * @returns {Array} Sequelize attributes 数组
   */
  toSequelizeAttributes(fieldTree, allFields = null) {
    if (fieldTree === null) {
      return allFields;
    }

    const attributes = [];
    for (const [field, value] of Object.entries(fieldTree)) {
      if (value === true) {
        attributes.push(field);
      }
      // 嵌套字段在 Sequelize 中需要 include 处理
    }

    return attributes.length > 0 ? attributes : allFields;
  }

  /**
   * 注册自定义字段集
   */
  registerFieldset(name, fields) {
    this.fieldsets[name] = fields;
    logger.info({ name, fieldCount: fields?.length || 'full' }, 'Fieldset registered');
  }

  /**
   * 获取可用字段集列表
   */
  getFieldsets() {
    return {
      ...this.defaultFieldsets,
      ...this.fieldsets
    };
  }
}

module.exports = FieldProjection;
```

### 4.2 字段投影中间件

```javascript
// backend/shared/middleware/fieldProjectionMiddleware.js

'use strict';

const FieldProjection = require('../utils/FieldProjection');
const { createLogger } = require('../logger');
const { query } = require('../db');

const logger = createLogger('field-projection-middleware');

// 全局字段投影实例
const fieldProjection = new FieldProjection();

/**
 * 字段投影中间件工厂
 * @param {Object} options - 配置选项
 * @param {Object} options.allowedFields - 允许的字段映射 {资源类型: [字段列表]}
 * @param {Object} options.defaultFieldset - 默认字段集
 */
function createFieldProjectionMiddleware(options = {}) {
  return (req, res, next) => {
    // 获取 fields 参数
    const fieldsQuery = req.query.fields;
    const fieldset = req.query.fieldset || req.query.preset;

    try {
      // 解析字段树
      const fieldTree = fieldProjection.parseFields(fieldsQuery, fieldset);

      // 保存到请求上下文
      req.fieldProjection = {
        tree: fieldTree,
        raw: fieldsQuery,
        preset: fieldset
      };

      // 重写 res.json 以自动裁剪响应
      const originalJson = res.json.bind(res);
      res.json = function(data) {
        // 只处理成功的 API 响应
        if (data && typeof data === 'object' && fieldTree !== null) {
          // 处理统一响应格式
          if (data.data !== undefined) {
            data.data = fieldProjection.project(data.data, fieldTree);
          } else if (data.success === true) {
            // 单个对象或数组
            data.data = fieldProjection.project(data.data, fieldTree);
          } else {
            // 直接裁剪
            data = fieldProjection.project(data, fieldTree);
          }
        }

        // 添加字段集信息到响应头
        if (fieldset) {
          res.set('X-Fieldset', fieldset);
        }
        if (fieldsQuery) {
          res.set('X-Fields-Applied', 'true');
        }

        return originalJson(data);
      };

      next();
    } catch (error) {
      logger.error({ error: error.message, fieldsQuery }, 'Field projection error');
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FIELDS',
          message: error.message
        }
      });
    }
  };
}

/**
 * 数据库查询优化中间件
 * 将字段投影转换为 Sequelize attributes
 */
function createQueryOptimizationMiddleware(options = {}) {
  return async (req, res, next) => {
    // 如果有字段投影，优化数据库查询
    if (req.fieldProjection && req.fieldProjection.tree && options.model) {
      const model = options.model;
      const allFields = Object.keys(model.rawAttributes);
      const attributes = fieldProjection.toSequelizeAttributes(
        req.fieldProjection.tree,
        allFields
      );

      // 挂载到请求上下文
      req.queryAttributes = attributes;

      logger.debug({ 
        fieldCount: attributes?.length || 'all',
        fields: req.fieldProjection.raw 
      }, 'Query attributes optimized');
    }

    next();
  };
}

/**
 * 验证字段有效性中间件
 */
function createFieldValidationMiddleware(allowedFields) {
  return (req, res, next) => {
    const fieldsQuery = req.query.fields;

    if (!fieldsQuery || !allowedFields) {
      return next();
    }

    const requestedFields = fieldsQuery.split(',').map(f => f.trim().split('.')[0]);
    const invalidFields = requestedFields.filter(f => !allowedFields.includes(f));

    if (invalidFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_FIELD',
          message: `Invalid fields: ${invalidFields.join(', ')}`,
          allowedFields
        }
      });
    }

    next();
  };
}

module.exports = {
  createFieldProjectionMiddleware,
  createQueryOptimizationMiddleware,
  createFieldValidationMiddleware,
  fieldProjection
};
```

### 4.3 服务集成示例

```javascript
// backend/pokemon-service/src/routes/my-pokemon.js

const express = require('express');
const router = express.Router();
const { MyPokemon } = require('../models');
const { createFieldProjectionMiddleware, createQueryOptimizationMiddleware } = require('../../shared/middleware/fieldProjectionMiddleware');

// 精灵可投影字段
const POKEMON_FIELDS = [
  'id', 'speciesId', 'nickname', 'name', 'level', 'exp',
  'thumbnail', 'stats', 'moves', 'abilities', 'nature',
  'friendship', 'location', 'createdAt', 'updatedAt',
  'iv', 'heldItem', 'isShiny', 'gender'
];

// 列表接口 - 使用 list 字段集优化
router.get('/',
  createFieldProjectionMiddleware(),
  createQueryValidationMiddleware(POKEMON_FIELDS),
  async (req, res) => {
    const { page = 1, limit = 30, fieldset } = req.query;
    
    // 构建查询
    const query = {
      where: { userId: req.user.id },
      offset: (page - 1) * limit,
      limit: parseInt(limit),
      order: [['createdAt', 'DESC']]
    };

    // 字段优化
    if (req.queryAttributes) {
      query.attributes = req.queryAttributes;
    }

    const { count, rows } = await MyPokemon.findAndCountAll(query);

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  }
);

// 详情接口 - 支持自定义字段
router.get('/:id',
  createFieldProjectionMiddleware(),
  async (req, res) => {
    const pokemon = await MyPokemon.findOne({
      where: { id: req.params.id, userId: req.user.id }
    });

    if (!pokemon) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Pokemon not found' }
      });
    }

    res.json({
      success: true,
      data: pokemon
    });
  }
);

// API 文档注解
/**
 * @openapi
 * /api/pokemon/my:
 *   get:
 *     parameters:
 *       - name: fields
 *         in: query
 *         schema:
 *           type: string
 *         description: 字段投影，如 id,name,level,stats.hp
 *         example: id,nickname,level,thumbnail
 *       - name: fieldset
 *         in: query
 *         schema:
 *           type: string
 *           enum: [list, detail, summary, battle, social, minimal]
 *         description: 预定义字段集
 */
```

### 4.4 前端使用示例

```javascript
// frontend/game-client/src/api/PokemonApi.js

class PokemonApi {
  /**
   * 获取精灵列表（使用字段集）
   */
  async getMyPokemonList(page = 1, options = {}) {
    const params = new URLSearchParams({
      page,
      limit: options.limit || 30,
      fieldset: options.fieldset || 'list' // 使用列表字段集
    });

    const response = await fetch(`/api/pokemon/my?${params}`);
    return response.json();
  }

  /**
   * 获取精灵详情（自定义字段）
   */
  async getPokemonDetail(id, fields = null) {
    const params = new URLSearchParams();
    
    if (fields) {
      // 按需请求字段
      params.set('fields', fields.join(','));
    }

    const response = await fetch(`/api/pokemon/my/${id}?${params}`);
    return response.json();
  }

  /**
   * 获取战斗所需数据
   */
  async getPokemonForBattle(id) {
    const params = new URLSearchParams({
      fieldset: 'battle'
    });

    const response = await fetch(`/api/pokemon/my/${id}?${params}`);
    return response.json();
  }
}

// 使用示例
const api = new PokemonApi();

// 列表页 - 只返回基本信息，响应体减少 70%
const list = await api.getMyPokemonList(1);
// { data: [{ id, name, thumbnail, level }, ...], pagination: {...} }

// 详情页 - 完整数据
const detail = await api.getPokemonDetail(12345);
// { data: { id, name, level, stats, moves, ...所有字段 } }

// 自定义字段
const custom = await api.getPokemonDetail(12345, ['id', 'name', 'level', 'stats.hp']);
// { data: { id, name, level, stats: { hp: 120 } } }

// 战斗页面
const battle = await api.getPokemonForBattle(12345);
// { data: { id, name, level, stats, moves, abilities } }
```

### 4.5 数据库迁移

```sql
-- database/migrations/20260711_00_field_projection.sql
-- API 字段投影系统

-- 字段集配置表
CREATE TABLE IF NOT EXISTS fieldset_configs (
  id SERIAL PRIMARY KEY,
  resource_type VARCHAR(100) NOT NULL,
  fieldset_name VARCHAR(50) NOT NULL,
  fields JSONB NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(resource_type, fieldset_name)
);

CREATE INDEX idx_fieldset_resource ON fieldset_configs(resource_type);
CREATE INDEX idx_fieldset_default ON fieldset_configs(resource_type, is_default);

-- 字段使用统计表（分析字段热度）
CREATE TABLE IF NOT EXISTS field_usage_stats (
  id SERIAL PRIMARY KEY,
  resource_type VARCHAR(100) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  request_count BIGINT DEFAULT 0,
  last_requested_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(resource_type, field_name)
);

CREATE INDEX idx_field_usage_resource ON field_usage_stats(resource_type);
CREATE INDEX idx_field_usage_count ON field_usage_stats(request_count DESC);

-- 插入默认字段集配置
INSERT INTO fieldset_configs (resource_type, fieldset_name, fields, description, is_default) VALUES
('pokemon', 'list', '["id", "speciesId", "nickname", "thumbnail", "level"]', '精灵列表基础字段', true),
('pokemon', 'detail', 'null', '精灵完整信息', false),
('pokemon', 'battle', '["id", "speciesId", "nickname", "level", "stats", "moves", "abilities", "nature"]', '战斗所需字段', false),
('pokemon', 'social', '["id", "speciesId", "nickname", "level", "friendship", "location", "createdAt"]', '社交展示字段', false),
('user', 'profile', '["id", "username", "avatar", "level", "exp", "createdAt"]', '用户档案字段', true),
('user', 'minimal', '["id", "username", "avatar"]', '最小用户信息', false),
('gym', 'list', '["id", "name", "thumbnail", "level", "teamId", "latitude", "longitude"]', '道馆列表字段', true),
('gym', 'detail', 'null', '道馆完整信息', false)
ON CONFLICT (resource_type, fieldset_name) DO NOTHING;

COMMENT ON TABLE fieldset_configs IS '字段集配置表';
COMMENT ON TABLE field_usage_stats IS '字段使用统计表';
```

### 4.6 管理员 API

```javascript
// backend/admin/src/routes/fieldset.js

const express = require('express');
const router = express.Router();
const { query } = require('../../shared/db');
const { fieldProjection } = require('../../shared/middleware/fieldProjectionMiddleware');

/**
 * 获取所有字段集配置
 */
router.get('/fieldsets', async (req, res) => {
  const result = await query(`
    SELECT resource_type, fieldset_name, fields, description, is_default
    FROM fieldset_configs
    ORDER BY resource_type, fieldset_name
  `);

  const grouped = {};
  for (const row of result.rows) {
    if (!grouped[row.resource_type]) {
      grouped[row.resource_type] = {};
    }
    grouped[row.resource_type][row.fieldset_name] = {
      fields: row.fields,
      description: row.description,
      isDefault: row.is_default
    };
  }

  res.json({ success: true, data: grouped });
});

/**
 * 创建/更新字段集
 */
router.post('/fieldsets', async (req, res) => {
  const { resourceType, fieldsetName, fields, description, isDefault } = req.body;

  await query(`
    INSERT INTO fieldset_configs (resource_type, fieldset_name, fields, description, is_default)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (resource_type, fieldset_name) 
    DO UPDATE SET fields = $3, description = $4, is_default = $5, updated_at = NOW()
  `, [resourceType, fieldsetName, JSON.stringify(fields), description, isDefault]);

  // 注册到运行时
  fieldProjection.registerFieldset(fieldsetName, fields);

  res.json({ success: true, message: 'Fieldset saved' });
});

/**
 * 字段使用统计
 */
router.get('/field-usage/:resourceType', async (req, res) => {
  const result = await query(`
    SELECT field_name, request_count, last_requested_at
    FROM field_usage_stats
    WHERE resource_type = $1
    ORDER BY request_count DESC
    LIMIT 50
  `, [req.params.resourceType]);

  res.json({ success: true, data: result.rows });
});

module.exports = router;
```

## 5. 验收标准（可测试）

- [ ] FieldProjection 支持解析逗号分隔字段、嵌套字段（`stats.hp`）、数组字段（`moves[].name`）
- [ ] 预定义字段集正确工作，`?fieldset=list` 返回最小字段集
- [ ] 中间件自动裁剪响应数据，不影响原有响应格式
- [ ] 敏感字段（password、token）被过滤，不返回给客户端
- [ ] 数据库查询优化生效，Sequelize attributes 只查询需要的字段
- [ ] 无效字段返回 400 错误，包含允许字段列表
- [ ] 字段数限制生效（默认最大 50 个字段）
- [ ] Prometheus 指标记录字段投影使用情况
- [ ] 单元测试覆盖率 > 85%

## 6. 工作量估算

**L（Large）** - 需要实现核心模块、中间件、数据库迁移、前端集成和完整测试。预计 2-3 天。

## 7. 优先级理由

**P1** - 字段投影是 API 性能优化的重要手段，直接影响移动端用户体验：
- 减少 70%+ 的响应体大小，节省带宽成本
- 降低数据库查询负载，提升服务器吞吐量
- 类似 GraphQL 的灵活性，保留 REST API 的简洁性
- 对移动端弱网环境优化明显

该需求是实现"生产可用"目标的关键性能优化组件。
