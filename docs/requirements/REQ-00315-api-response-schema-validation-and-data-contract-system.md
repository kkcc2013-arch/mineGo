# REQ-00315: API 响应 Schema 验证与数据契约系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00315 |
| 标题 | API 响应 Schema 验证与数据契约系统 |
| 类别 | API 设计规范 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、docs/api-spec |
| 创建时间 | 2026-06-24 09:00 UTC |

## 需求描述

实现 API 响应 Schema 验证与数据契约系统，确保所有 API 返回的数据结构符合预定义的契约规范，防止接口变更导致前端解析错误，提高系统稳定性和开发协作效率。

### 核心功能

1. **Schema 定义与管理**
   - JSON Schema 规范定义
   - 版本化 Schema 管理
   - Schema 继承与复用
   - 自动生成 TypeScript 类型

2. **运行时验证**
   - 响应数据实时验证
   - 开发环境严格验证
   - 生产环境降级验证
   - 验证错误日志与告警

3. **契约测试**
   - 契约快照测试
   - Breaking Change 检测
   - 自动化回归测试
   - 文档一致性验证

4. **开发者体验**
   - 类型自动生成
   - IDE 自动补全
   - 文档自动同步
   - Mock 数据生成

## 技术方案

### 1. Schema 定义系统

```javascript
// backend/shared/schemas/definitions/pokemon.js
const { SchemaRegistry } = require('../registry');

// 精灵基础信息 Schema
const PokemonBaseSchema = {
    $id: 'https://minego.api/schemas/pokemon/base.json',
    type: 'object',
    required: ['id', 'speciesId', 'level', 'cp', 'hp'],
    properties: {
        id: { type: 'string', format: 'uuid' },
        speciesId: { type: 'string', pattern: '^pokemon_\\d+$' },
        nickname: { type: 'string', maxLength: 20 },
        level: { type: 'integer', minimum: 1, maximum: 100 },
        cp: { type: 'integer', minimum: 10 },
        hp: {
            type: 'object',
            required: ['current', 'max'],
            properties: {
                current: { type: 'integer', minimum: 0 },
                max: { type: 'integer', minimum: 1 }
            }
        },
        types: {
            type: 'array',
            items: { type: 'string', enum: ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'] },
            minItems: 1,
            maxItems: 2
        },
        stats: {
            type: 'object',
            required: ['attack', 'defense', 'stamina'],
            properties: {
                attack: { type: 'integer', minimum: 0 },
                defense: { type: 'integer', minimum: 0 },
                stamina: { type: 'integer', minimum: 0 }
            }
        },
        moves: {
            type: 'object',
            properties: {
                fast: { $ref: 'https://minego.api/schemas/move/base.json' },
                charged: {
                    type: 'array',
                    items: { $ref: 'https://minego.api/schemas/move/base.json' },
                    maxItems: 2
                }
            }
        },
        caughtAt: { type: 'string', format: 'date-time' },
        location: {
            type: 'object',
            properties: {
                latitude: { type: 'number', minimum: -90, maximum: 90 },
                longitude: { type: 'number', minimum: -180, maximum: 180 }
            }
        }
    },
    additionalProperties: false
};

// 注册 Schema
SchemaRegistry.register('pokemon/base', PokemonBaseSchema);

// 精灵详情 Schema（继承基础信息）
const PokemonDetailSchema = {
    $id: 'https://minego.api/schemas/pokemon/detail.json',
    allOf: [
        { $ref: 'https://minego.api/schemas/pokemon/base.json' },
        {
            type: 'object',
            properties: {
                iv: {
                    type: 'object',
                    required: ['attack', 'defense', 'stamina'],
                    properties: {
                        attack: { type: 'integer', minimum: 0, maximum: 15 },
                        defense: { type: 'integer', minimum: 0, maximum: 15 },
                        stamina: { type: 'integer', minimum: 0, maximum: 15 }
                    }
                },
                evolution: {
                    type: 'object',
                    properties: {
                        canEvolve: { type: 'boolean' },
                        nextStage: { type: 'string' },
                        requirements: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string', enum: ['candy', 'item', 'level', 'time', 'location'] },
                                    value: { type: ['string', 'integer'] }
                                }
                            }
                        }
                    }
                },
                sprites: {
                    type: 'object',
                    properties: {
                        default: { type: 'string', format: 'uri' },
                        shiny: { type: 'string', format: 'uri' },
                        animated: { type: 'string', format: 'uri' }
                    }
                }
            }
        }
    ]
};

SchemaRegistry.register('pokemon/detail', PokemonDetailSchema);

module.exports = { PokemonBaseSchema, PokemonDetailSchema };
```

### 2. Schema 注册中心

```javascript
// backend/shared/schemas/registry.js
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const Logger = require('../logger');
const fs = require('fs').promises;
const path = require('path');

class SchemaRegistry {
    constructor() {
        this.ajv = new Ajv({
            allErrors: true,
            strict: true,
            removeAdditional: false,
            useDefaults: true,
            coerceTypes: false
        });
        
        addFormats(this.ajv);
        
        this.schemas = new Map();
        this.validators = new Map();
        this.compiledPromises = new Map();
    }

    static instance = null;

    static getInstance() {
        if (!SchemaRegistry.instance) {
            SchemaRegistry.instance = new SchemaRegistry();
        }
        return SchemaRegistry.instance;
    }

    static register(name, schema) {
        const instance = SchemaRegistry.getInstance();
        instance.schemas.set(name, schema);
        
        try {
            instance.ajv.addSchema(schema, schema.$id || name);
            const validator = instance.ajv.compile(schema);
            instance.validators.set(name, validator);
            Logger.debug(`Schema registered: ${name}`);
        } catch (error) {
            Logger.error(`Failed to register schema ${name}:`, error);
            throw error;
        }
    }

    static validate(schemaName, data) {
        const instance = SchemaRegistry.getInstance();
        const validator = instance.validators.get(schemaName);
        
        if (!validator) {
            throw new Error(`Schema not found: ${schemaName}`);
        }

        const valid = validator(data);
        
        if (!valid) {
            const errors = validator.errors.map(err => ({
                path: err.instancePath,
                message: err.message,
                params: err.params
            }));
            
            return { valid: false, errors };
        }
        
        return { valid: true, errors: [] };
    }

    static getSchema(name) {
        const instance = SchemaRegistry.getInstance();
        return instance.schemas.get(name);
    }

    static async loadSchemas(schemaDir) {
        const instance = SchemaRegistry.getInstance();
        const files = await fs.readdir(schemaDir, { withFileTypes: true });
        
        for (const file of files) {
            const filePath = path.join(schemaDir, file.name);
            
            if (file.isDirectory()) {
                await this.loadSchemas(filePath);
            } else if (file.name.endsWith('.json')) {
                const content = await fs.readFile(filePath, 'utf8');
                const schema = JSON.parse(content);
                const name = path.basename(file.name, '.json');
                this.register(name, schema);
            }
        }
    }

    // 生成 TypeScript 类型
    static generateTypeScript(schemaName) {
        const schema = this.getSchema(schemaName);
        if (!schema) {
            throw new Error(`Schema not found: ${schemaName}`);
        }
        
        return this._schemaToTypeScript(schema, schemaName);
    }

    static _schemaToTypeScript(schema, name) {
        let ts = `export interface ${this._toPascalCase(name)} {\n`;
        
        if (schema.properties) {
            for (const [prop, propSchema] of Object.entries(schema.properties)) {
                const optional = schema.required?.includes(prop) ? '' : '?';
                const type = this._propertyToType(propSchema);
                ts += `    ${prop}${optional}: ${type};\n`;
            }
        }
        
        ts += '}\n';
        return ts;
    }

    static _propertyToType(schema) {
        if (schema.$ref) {
            const refName = schema.$ref.split('/').pop();
            return this._toPascalCase(refName);
        }
        
        switch (schema.type) {
            case 'string':
                if (schema.enum) {
                    return schema.enum.map(v => `'${v}'`).join(' | ');
                }
                if (schema.format === 'date-time') return 'Date | string';
                if (schema.format === 'uuid') return 'string';
                return 'string';
            
            case 'integer':
            case 'number':
                return 'number';
            
            case 'boolean':
                return 'boolean';
            
            case 'array':
                const itemType = this._propertyToType(schema.items);
                return `${itemType}[]`;
            
            case 'object':
                if (!schema.properties) return 'Record<string, any>';
                let obj = '{\n';
                for (const [prop, propSchema] of Object.entries(schema.properties)) {
                    const optional = schema.required?.includes(prop) ? '' : '?';
                    const type = this._propertyToType(propSchema);
                    obj += `        ${prop}${optional}: ${type};\n`;
                }
                obj += '    }';
                return obj;
            
            default:
                return 'any';
        }
    }

    static _toPascalCase(str) {
        return str
            .split(/[-_/]/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }
}

module.exports = SchemaRegistry;
```

### 3. 响应验证中间件

```javascript
// backend/shared/middleware/responseValidator.js
const SchemaRegistry = require('../schemas/registry');
const Logger = require('../logger');
const config = require('../config');

class ResponseValidator {
    constructor(options = {}) {
        this.strictMode = options.strictMode ?? (config.nodeEnv === 'development');
        this.logErrors = options.logErrors ?? true;
        this.throwOnError = options.throwOnError ?? false;
        this.schemaMap = new Map();
    }

    // 注册路由 Schema 映射
    registerSchema(route, method, schemaName) {
        const key = `${method.toUpperCase()}:${route}`;
        this.schemaMap.set(key, schemaName);
    }

    // Express 中间件
    middleware() {
        return (req, res, next) => {
            const key = `${req.method}:${req.route?.path || req.path}`;
            const schemaName = this.schemaMap.get(key);
            
            if (!schemaName) {
                return next();
            }

            // 包装 res.json
            const originalJson = res.json.bind(res);
            
            res.json = (data) => {
                const result = SchemaRegistry.validate(schemaName, data);
                
                if (!result.valid) {
                    const errorInfo = {
                        route: key,
                        schema: schemaName,
                        errors: result.errors,
                        data: this.strictMode ? data : undefined
                    };

                    if (this.logErrors) {
                        Logger.error('Response schema validation failed', errorInfo);
                    }

                    // 开发环境抛出错误
                    if (this.throwOnError || this.strictMode) {
                        const error = new Error('Response schema validation failed');
                        error.details = errorInfo;
                        throw error;
                    }

                    // 生产环境记录但继续
                    res.setHeader('X-Schema-Validation', 'failed');
                } else {
                    res.setHeader('X-Schema-Validation', 'passed');
                }

                return originalJson(data);
            };

            next();
        };
    }
}

// 装饰器方式（用于控制器）
function ValidateResponse(schemaName) {
    return function (target, propertyKey, descriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function (...args) {
            const result = await originalMethod.apply(this, args);
            
            const validation = SchemaRegistry.validate(schemaName, result);
            
            if (!validation.valid) {
                Logger.error('Response validation failed', {
                    method: propertyKey,
                    schema: schemaName,
                    errors: validation.errors
                });
                
                if (config.nodeEnv === 'development') {
                    const error = new Error('Response schema validation failed');
                    error.details = validation.errors;
                    throw error;
                }
            }
            
            return result;
        };
        
        return descriptor;
    };
}

module.exports = { ResponseValidator, ValidateResponse };
```

### 4. 契约测试系统

```javascript
// backend/tests/contract/schemaContract.test.js
const { describe, it, expect, beforeAll } = require('@jest/globals');
const SchemaRegistry = require('../../shared/schemas/registry');
const fs = require('fs').promises;
const path = require('path');
const Ajv = require('ajv');

describe('API Schema Contract Tests', () => {
    const snapshotsDir = path.join(__dirname, '__snapshots__');
    
    beforeAll(async () => {
        // 加载所有 Schema
        await SchemaRegistry.loadSchemas(path.join(__dirname, '../../shared/schemas/definitions'));
    });

    // 测试 Schema 结构完整性
    describe('Schema Structure', () => {
        it('should have all required fields in pokemon/base schema', () => {
            const schema = SchemaRegistry.getSchema('pokemon/base');
            
            expect(schema).toBeDefined();
            expect(schema.required).toContain('id');
            expect(schema.required).toContain('speciesId');
            expect(schema.required).toContain('level');
            expect(schema.required).toContain('cp');
            expect(schema.required).toContain('hp');
        });

        it('should have valid type definitions', () => {
            const schema = SchemaRegistry.getSchema('pokemon/base');
            
            // 验证 types 枚举
            const typesProperty = schema.properties.types;
            expect(typesProperty.type).toBe('array');
            expect(typesProperty.items.enum).toBeDefined();
            expect(typesProperty.items.enum.length).toBeGreaterThan(0);
        });
    });

    // 测试 Schema 兼容性（防止 Breaking Change）
    describe('Schema Compatibility', () => {
        it('should not break existing fields', async () => {
            const currentSchema = SchemaRegistry.getSchema('pokemon/base');
            const snapshotPath = path.join(snapshotsDir, 'pokemon-base.snapshot.json');
            
            let previousSchema;
            try {
                const content = await fs.readFile(snapshotPath, 'utf8');
                previousSchema = JSON.parse(content);
            } catch {
                // 首次运行，创建快照
                await fs.mkdir(snapshotsDir, { recursive: true });
                await fs.writeFile(snapshotPath, JSON.stringify(currentSchema, null, 2));
                return;
            }

            // 检查必需字段是否被删除
            for (const requiredField of previousSchema.required || []) {
                expect(currentSchema.properties[requiredField]).toBeDefined();
            }

            // 检查字段类型是否改变
            for (const [field, prevProp] of Object.entries(previousSchema.properties || {})) {
                const currProp = currentSchema.properties[field];
                if (currProp) {
                    expect(currProp.type).toBe(prevProp.type);
                }
            }
        });

        it('should update snapshot if schema changes intentionally', async () => {
            const schema = SchemaRegistry.getSchema('pokemon/base');
            const snapshotPath = path.join(snapshotsDir, 'pokemon-base.snapshot.json');
            
            // 如果环境变量 UPDATE_SNAPSHOTS=true，更新快照
            if (process.env.UPDATE_SNAPSHOTS === 'true') {
                await fs.writeFile(snapshotPath, JSON.stringify(schema, null, 2));
            }
        });
    });

    // 测试验证逻辑
    describe('Validation Logic', () => {
        it('should validate correct pokemon data', () => {
            const validData = {
                id: '123e4567-e89b-12d3-a456-426614174000',
                speciesId: 'pokemon_25',
                nickname: 'Pikachu',
                level: 50,
                cp: 1500,
                hp: { current: 100, max: 120 },
                types: ['electric'],
                stats: { attack: 100, defense: 80, stamina: 120 }
            };

            const result = SchemaRegistry.validate('pokemon/base', validData);
            expect(result.valid).toBe(true);
        });

        it('should reject invalid pokemon data', () => {
            const invalidData = {
                id: 'invalid-uuid',
                speciesId: 'pokemon_25',
                level: 150, // 超过最大值
                cp: 'not-a-number',
                hp: { current: -10 } // 缺少 max，current 为负
            };

            const result = SchemaRegistry.validate('pokemon/base', invalidData);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should reject additional properties in strict mode', () => {
            const dataWithExtra = {
                id: '123e4567-e89b-12d3-a456-426614174000',
                speciesId: 'pokemon_25',
                level: 50,
                cp: 1500,
                hp: { current: 100, max: 120 },
                unknownField: 'should-be-rejected'
            };

            const result = SchemaRegistry.validate('pokemon/base', dataWithExtra);
            expect(result.valid).toBe(false);
        });
    });
});

// 自动化 Breaking Change 检测
describe('Breaking Change Detection', () => {
    it('should detect removed required fields', () => {
        const oldSchema = {
            type: 'object',
            required: ['id', 'name', 'email'],
            properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                email: { type: 'string' }
            }
        };

        const newSchema = {
            type: 'object',
            required: ['id', 'name'], // email 被移除
            properties: {
                id: { type: 'string' },
                name: { type: 'string' }
            }
        };

        const changes = detectBreakingChanges(oldSchema, newSchema);
        expect(changes).toContainEqual({
            type: 'REQUIRED_FIELD_REMOVED',
            field: 'email'
        });
    });

    it('should detect type changes', () => {
        const oldSchema = {
            type: 'object',
            properties: {
                count: { type: 'integer' }
            }
        };

        const newSchema = {
            type: 'object',
            properties: {
                count: { type: 'string' } // 类型改变
            }
        };

        const changes = detectBreakingChanges(oldSchema, newSchema);
        expect(changes).toContainEqual({
            type: 'FIELD_TYPE_CHANGED',
            field: 'count',
            from: 'integer',
            to: 'string'
        });
    });
});

function detectBreakingChanges(oldSchema, newSchema) {
    const changes = [];

    // 检查必需字段
    const oldRequired = new Set(oldSchema.required || []);
    const newRequired = new Set(newSchema.required || []);

    for (const field of oldRequired) {
        if (!newRequired.has(field)) {
            changes.push({
                type: 'REQUIRED_FIELD_REMOVED',
                field
            });
        }
    }

    // 检查字段类型
    for (const [field, oldProp] of Object.entries(oldSchema.properties || {})) {
        const newProp = newSchema.properties?.[field];
        if (newProp && oldProp.type !== newProp.type) {
            changes.push({
                type: 'FIELD_TYPE_CHANGED',
                field,
                from: oldProp.type,
                to: newProp.type
            });
        }
    }

    return changes;
}
```

### 5. TypeScript 类型生成脚本

```javascript
// scripts/generateTypes.js
const SchemaRegistry = require('../backend/shared/schemas/registry');
const fs = require('fs').promises;
const path = require('path');

async function generateTypeScriptTypes() {
    // 加载所有 Schema
    await SchemaRegistry.loadSchemas(
        path.join(__dirname, '../backend/shared/schemas/definitions')
    );

    const schemas = [
        'pokemon/base',
        'pokemon/detail',
        'user/profile',
        'battle/result',
        'item/inventory'
    ];

    let output = `// Auto-generated TypeScript types
// Do not edit manually - run 'npm run generate:types' to update

`;

    for (const schemaName of schemas) {
        try {
            const ts = SchemaRegistry.generateTypeScript(schemaName);
            output += ts + '\n\n';
        } catch (error) {
            console.error(`Failed to generate type for ${schemaName}:`, error);
        }
    }

    const outputPath = path.join(__dirname, '../frontend/game-client/src/types/api.ts');
    await fs.writeFile(outputPath, output);
    
    console.log('TypeScript types generated successfully!');
}

generateTypeScriptTypes().catch(console.error);
```

### 6. OpenAPI 集成

```javascript
// backend/shared/schemas/openapiGenerator.js
const SwaggerJsdoc = require('swagger-jsdoc');

class OpenAPIGenerator {
    static generateFromSchemas(schemas) {
        const components = {
            schemas: {}
        };

        for (const [name, schema] of schemas) {
            components.schemas[name] = this._convertSchema(schema);
        }

        return {
            openapi: '3.0.3',
            info: {
                title: 'mineGo API',
                version: '1.0.0',
                description: 'mineGo 游戏 API 文档'
            },
            components
        };
    }

    static _convertSchema(jsonSchema) {
        // 转换 JSON Schema 到 OpenAPI Schema
        const openapiSchema = { ...jsonSchema };
        
        // 移除 JSON Schema 特有的字段
        delete openapiSchema.$id;
        
        return openapiSchema;
    }
}

module.exports = OpenAPIGenerator;
```

## 验收标准

- [ ] 所有 API 响应有对应的 JSON Schema 定义
- [ ] 开发环境下响应验证失败抛出错误
- [ ] 生产环境响应验证失败记录日志但不阻塞请求
- [ ] Schema 版本化管理，支持多版本共存
- [ ] 契约快照测试自动检测 Breaking Change
- [ ] TypeScript 类型自动生成并保持同步
- [ ] OpenAPI 文档自动生成
- [ ] Schema 验证性能开销 < 5ms
- [ ] IDE 自动补全和类型提示正常工作
- [ ] Mock 数据可从 Schema 自动生成

## 影响范围

- **backend/shared/schemas**：新增 Schema 定义目录
- **gateway**：集成响应验证中间件
- **所有微服务**：为每个 API 定义响应 Schema
- **docs/api-spec**：OpenAPI 文档更新
- **frontend/game-client/src/types**：自动生成的 TypeScript 类型
- **CI/CD**：新增契约测试阶段

## 参考

- [JSON Schema Specification](https://json-schema.org/)
- [OpenAPI 3.0 Specification](https://swagger.io/specification/)
- [Ajv JSON Schema Validator](https://ajv.js.org/)
- [Pact Contract Testing](https://docs.pact.io/)
- [TypeScript Declaration Files](https://www.typescriptlang.org/docs/handbook/declaration-files/)
