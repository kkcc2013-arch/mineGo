# REQ-00137：游戏内容本地化内容管理与翻译工作流系统

- **编号**：REQ-00137
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、reward-service、backend/shared、admin-dashboard、database/migrations
- **创建时间**：2026-06-12 00:35
- **依赖需求**：REQ-00011（游戏客户端多语言国际化支持）

## 1. 背景与问题

当前项目已实现客户端多语言支持（REQ-00011），支持中文、英文、日文三种语言。但存在以下问题：

1. **翻译内容分散**：精灵名称、技能描述、道具说明、成就文本等内容硬编码在各服务中，缺乏统一管理
2. **翻译工作流缺失**：没有翻译管理工具，新增内容需要手动编辑多个语言包文件，容易遗漏或出错
3. **翻译进度不透明**：无法查看各语言的翻译完成度，难以追踪缺失的翻译
4. **版本管理困难**：翻译更新时无法回滚，缺少翻译历史记录
5. **协作效率低**：缺少翻译审核流程，无法多人协作翻译

## 2. 目标

建立完整的游戏内容本地化管理系统，实现：
- 统一管理所有游戏文本的翻译内容
- 提供翻译管理工具和工作流
- 实时追踪翻译进度和完成度
- 支持翻译审核和协作
- 翻译版本控制和回滚

## 3. 范围

### 包含
- 数据库表设计（翻译键、翻译内容、翻译历史）
- 翻译管理 API（CRUD、导入导出、审核）
- 翻译进度追踪系统
- 翻译工作流管理（提交、审核、发布）
- 管理后台翻译界面
- 客户端翻译加载优化

### 不包含
- 自动机器翻译（可后期扩展）
- 专业翻译服务集成（如 CrowdIn）
- 实时翻译编辑协作（WebSocket）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 翻译键表
CREATE TABLE translation_keys (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    category VARCHAR(50) NOT NULL, -- pokemon/skill/item/achievement/ui/system
    description TEXT,
    context TEXT, -- 翻译上下文说明
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_translation_keys_category (category),
    INDEX idx_translation_keys_active (is_active)
);

-- 翻译内容表
CREATE TABLE translations (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL, -- zh-CN/en-US/ja-JP
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
    translated_by INTEGER REFERENCES users(id),
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(key_id, language, version),
    INDEX idx_translations_key (key_id),
    INDEX idx_translations_language (language),
    INDEX idx_translations_status (status)
);

-- 翻译历史表
CREATE TABLE translation_history (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    old_content TEXT,
    new_content TEXT NOT NULL,
    changed_by INTEGER REFERENCES users(id),
    change_reason TEXT,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_translation_history_key (key_id),
    INDEX idx_translation_history_language (language),
    INDEX idx_translation_history_time (changed_at)
);

-- 翻译进度表
CREATE TABLE translation_progress (
    id SERIAL PRIMARY KEY,
    language VARCHAR(10) UNIQUE NOT NULL,
    total_keys INTEGER DEFAULT 0,
    translated_keys INTEGER DEFAULT 0,
    approved_keys INTEGER DEFAULT 0,
    completion_pct DECIMAL(5,2) DEFAULT 0.00,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 翻译任务表
CREATE TABLE translation_tasks (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    assigned_to INTEGER REFERENCES users(id),
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
    due_date TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(key_id, language),
    INDEX idx_translation_tasks_assigned (assigned_to),
    INDEX idx_translation_tasks_status (status)
);

-- 翻译评论表（用于翻译讨论）
CREATE TABLE translation_comments (
    id SERIAL PRIMARY KEY,
    key_id INTEGER NOT NULL REFERENCES translation_keys(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    comment TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    INDEX idx_translation_comments_key (key_id)
);
```

### 4.2 API 端点

#### 翻译键管理
- `GET /api/translations/keys` - 获取翻译键列表（支持分类过滤、搜索）
- `GET /api/translations/keys/:id` - 获取翻译键详情
- `POST /api/translations/keys` - 创建翻译键
- `PUT /api/translations/keys/:id` - 更新翻译键
- `DELETE /api/translations/keys/:id` - 删除翻译键
- `POST /api/translations/keys/import` - 批量导入翻译键

#### 翻译内容管理
- `GET /api/translations/content` - 获取翻译内容（支持语言、状态过滤）
- `GET /api/translations/content/:keyId/:language` - 获取单个翻译
- `POST /api/translations/content` - 提交翻译
- `PUT /api/translations/content/:id` - 更新翻译
- `POST /api/translations/content/:id/approve` - 审核通过
- `POST /api/translations/content/:id/reject` - 审核拒绝

#### 翻译进度
- `GET /api/translations/progress` - 获取翻译进度概览
- `GET /api/translations/progress/:language` - 获取特定语言进度
- `GET /api/translations/missing` - 获取缺失翻译列表

#### 翻译导出
- `GET /api/translations/export/:language` - 导出语言包（JSON格式）
- `POST /api/translations/import` - 批量导入翻译内容

#### 翻译历史
- `GET /api/translations/history/:keyId` - 获取翻译历史
- `POST /api/translations/rollback/:keyId/:language/:version` - 回滚到指定版本

#### 翻译任务
- `GET /api/translations/tasks` - 获取翻译任务列表
- `POST /api/translations/tasks` - 创建翻译任务
- `PUT /api/translations/tasks/:id` - 更新任务状态
- `GET /api/translations/tasks/my` - 获取我的翻译任务

#### 翻译评论
- `GET /api/translations/comments/:keyId` - 获取翻译评论
- `POST /api/translations/comments` - 添加翻译评论

### 4.3 翻译管理核心模块

```javascript
// backend/shared/translationManager.js

const { getClient } = require('./db');
const { getRedisClient } = require('./redis');
const logger = require('./logger');

class TranslationManager {
    constructor() {
        this.cachePrefix = 'translation:';
        this.cacheTTL = 3600; // 1小时
    }

    /**
     * 获取翻译内容（带缓存）
     */
    async getTranslation(key, language) {
        const redis = getRedisClient();
        const cacheKey = `${this.cachePrefix}${language}:${key}`;
        
        // 尝试从缓存获取
        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }
        
        const client = await getClient();
        try {
            const result = await client.query(`
                SELECT t.content, t.status, t.version
                FROM translations t
                JOIN translation_keys tk ON tk.id = t.key_id
                WHERE tk.key = $1 AND t.language = $2 AND t.status = 'approved'
                ORDER BY t.version DESC
                LIMIT 1
            `, [key, language]);
            
            if (result.rows.length === 0) {
                // 尝试回退到默认语言
                const fallback = await this.getFallbackTranslation(key, language);
                return fallback;
            }
            
            const translation = result.rows[0];
            
            // 缓存结果
            await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(translation));
            
            return translation;
        } finally {
            client.release();
        }
    }

    /**
     * 批量获取翻译（用于客户端加载）
     */
    async getTranslationsByCategory(category, language) {
        const redis = getRedisClient();
        const cacheKey = `${this.cachePrefix}category:${language}:${category}`;
        
        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }
        
        const client = await getClient();
        try {
            const result = await client.query(`
                SELECT tk.key, t.content
                FROM translation_keys tk
                JOIN translations t ON t.key_id = tk.id
                WHERE tk.category = $1 
                  AND t.language = $2 
                  AND t.status = 'approved'
                  AND tk.is_active = true
            `, [category, language]);
            
            const translations = {};
            result.rows.forEach(row => {
                translations[row.key] = row.content;
            });
            
            await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(translations));
            
            return translations;
        } finally {
            client.release();
        }
    }

    /**
     * 获取所有翻译（客户端初始化）
     */
    async getAllTranslations(language) {
        const client = await getClient();
        try {
            const result = await client.query(`
                SELECT tk.key, tk.category, t.content
                FROM translation_keys tk
                LEFT JOIN translations t ON t.key_id = tk.id AND t.language = $1 AND t.status = 'approved'
                WHERE tk.is_active = true
            `, [language]);
            
            const translations = {
                pokemon: {},
                skill: {},
                item: {},
                achievement: {},
                ui: {},
                system: {}
            };
            
            result.rows.forEach(row => {
                if (row.content && translations[row.category]) {
                    translations[row.category][row.key] = row.content;
                }
            });
            
            return translations;
        } finally {
            client.release();
        }
    }

    /**
     * 提交翻译
     */
    async submitTranslation(params) {
        const { keyId, language, content, translatedBy } = params;
        const client = await getClient();
        
        try {
            await client.query('BEGIN');
            
            // 获取当前版本
            const current = await client.query(`
                SELECT version, content FROM translations
                WHERE key_id = $1 AND language = $2
                ORDER BY version DESC LIMIT 1
            `, [keyId, language]);
            
            const newVersion = current.rows.length > 0 ? current.rows[0].version + 1 : 1;
            
            // 插入新翻译
            const result = await client.query(`
                INSERT INTO translations (key_id, language, content, status, translated_by, version)
                VALUES ($1, $2, $3, 'pending', $4, $5)
                RETURNING *
            `, [keyId, language, content, translatedBy, newVersion]);
            
            // 记录历史
            if (current.rows.length > 0) {
                await client.query(`
                    INSERT INTO translation_history (key_id, language, old_content, new_content, changed_by)
                    VALUES ($1, $2, $3, $4, $5)
                `, [keyId, language, current.rows[0].content, content, translatedBy]);
            }
            
            // 清除缓存
            await this.clearTranslationCache(keyId, language);
            
            await client.query('COMMIT');
            
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 审核翻译
     */
    async reviewTranslation(translationId, status, reviewedBy, reason = null) {
        const client = await getClient();
        
        try {
            await client.query('BEGIN');
            
            const result = await client.query(`
                UPDATE translations 
                SET status = $1, reviewed_by = $2, reviewed_at = NOW()
                WHERE id = $3
                RETURNING *
            `, [status, reviewedBy, translationId]);
            
            if (result.rows.length === 0) {
                throw new Error('Translation not found');
            }
            
            // 更新进度
            await this.updateProgress(result.rows[0].language);
            
            // 清除缓存
            await this.clearTranslationCache(result.rows[0].key_id, result.rows[0].language);
            
            await client.query('COMMIT');
            
            return result.rows[0];
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 更新翻译进度
     */
    async updateProgress(language) {
        const client = await getClient();
        
        try {
            const stats = await client.query(`
                SELECT 
                    COUNT(DISTINCT tk.id) as total_keys,
                    COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN tk.id END) as translated_keys,
                    COUNT(DISTINCT CASE WHEN t.status = 'approved' THEN tk.id END) as approved_keys
                FROM translation_keys tk
                LEFT JOIN translations t ON t.key_id = tk.id AND t.language = $1
                WHERE tk.is_active = true
            `, [language]);
            
            const { total_keys, translated_keys, approved_keys } = stats.rows[0];
            const completionPct = total_keys > 0 ? (approved_keys / total_keys * 100) : 0;
            
            await client.query(`
                INSERT INTO translation_progress (language, total_keys, translated_keys, approved_keys, completion_pct)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (language) DO UPDATE SET
                    total_keys = EXCLUDED.total_keys,
                    translated_keys = EXCLUDED.translated_keys,
                    approved_keys = EXCLUDED.approved_keys,
                    completion_pct = EXCLUDED.completion_pct,
                    last_updated = NOW()
            `, [language, total_keys, translated_keys, approved_keys, completionPct]);
        } finally {
            client.release();
        }
    }

    /**
     * 获取翻译进度
     */
    async getProgress() {
        const client = await getClient();
        
        try {
            const result = await client.query(`
                SELECT language, total_keys, translated_keys, approved_keys, completion_pct, last_updated
                FROM translation_progress
                ORDER BY language
            `);
            
            return result.rows;
        } finally {
            client.release();
        }
    }

    /**
     * 获取缺失翻译
     */
    async getMissingTranslations(language) {
        const client = await getClient();
        
        try {
            const result = await client.query(`
                SELECT tk.id, tk.key, tk.category, tk.description
                FROM translation_keys tk
                LEFT JOIN translations t ON t.key_id = tk.id AND t.language = $1
                WHERE tk.is_active = true
                  AND (t.id IS NULL OR t.status != 'approved')
                ORDER BY tk.category, tk.key
            `, [language]);
            
            return result.rows;
        } finally {
            client.release();
        }
    }

    /**
     * 导出语言包
     */
    async exportLanguagePack(language) {
        const client = await getClient();
        
        try {
            const result = await client.query(`
                SELECT tk.key, tk.category, t.content
                FROM translation_keys tk
                JOIN translations t ON t.key_id = tk.id
                WHERE t.language = $1 AND t.status = 'approved' AND tk.is_active = true
                ORDER BY tk.category, tk.key
            `, [language]);
            
            const languagePack = {
                language,
                exportedAt: new Date().toISOString(),
                version: '1.0.0',
                translations: {}
            };
            
            result.rows.forEach(row => {
                if (!languagePack.translations[row.category]) {
                    languagePack.translations[row.category] = {};
                }
                languagePack.translations[row.category][row.key] = row.content;
            });
            
            return languagePack;
        } finally {
            client.release();
        }
    }

    /**
     * 清除翻译缓存
     */
    async clearTranslationCache(keyId, language) {
        const redis = getRedisClient();
        const client = await getClient();
        
        try {
            // 获取翻译键
            const keyResult = await client.query(
                'SELECT key, category FROM translation_keys WHERE id = $1',
                [keyId]
            );
            
            if (keyResult.rows.length > 0) {
                const { key, category } = keyResult.rows[0];
                
                // 清除单个翻译缓存
                await redis.del(`${this.cachePrefix}${language}:${key}`);
                
                // 清除分类缓存
                await redis.del(`${this.cachePrefix}category:${language}:${category}`);
            }
        } finally {
            client.release();
        }
    }

    /**
     * 回滚翻译版本
     */
    async rollbackTranslation(keyId, language, version, rolledBackBy) {
        const client = await getClient();
        
        try {
            await client.query('BEGIN');
            
            // 获取目标版本
            const target = await client.query(`
                SELECT content FROM translations
                WHERE key_id = $1 AND language = $2 AND version = $3
            `, [keyId, language, version]);
            
            if (target.rows.length === 0) {
                throw new Error('Target version not found');
            }
            
            // 提交新版本（内容为旧版本）
            const result = await this.submitTranslation({
                keyId,
                language,
                content: target.rows[0].content,
                translatedBy: rolledBackBy
            });
            
            await client.query('COMMIT');
            
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

module.exports = new TranslationManager();
```

### 4.4 客户端集成

```javascript
// frontend/game-client/src/services/TranslationService.js

class TranslationService {
    constructor() {
        this.translations = {};
        this.currentLanguage = 'zh-CN';
        this.loadedCategories = new Set();
    }

    /**
     * 初始化翻译服务
     */
    async initialize(language) {
        this.currentLanguage = language;
        
        // 加载所有翻译
        const response = await fetch(`/api/translations/load/${language}`);
        this.translations = await response.json();
        
        // 保存到 localStorage
        localStorage.setItem('translations', JSON.stringify(this.translations));
        localStorage.setItem('translationLang', language);
        localStorage.setItem('translationTime', Date.now());
    }

    /**
     * 按需加载分类翻译
     */
    async loadCategory(category) {
        if (this.loadedCategories.has(category)) {
            return;
        }
        
        const response = await fetch(
            `/api/translations/category/${this.currentLanguage}/${category}`
        );
        const translations = await response.json();
        
        this.translations[category] = translations;
        this.loadedCategories.add(category);
    }

    /**
     * 获取翻译
     */
    t(key, params = {}) {
        const parts = key.split('.');
        let value = this.translations;
        
        for (const part of parts) {
            if (!value[part]) {
                console.warn(`Translation missing: ${key}`);
                return key;
            }
            value = value[part];
        }
        
        // 替换参数
        if (typeof value === 'string') {
            return value.replace(/\{\{(\w+)\}\}/g, (match, param) => {
                return params[param] !== undefined ? params[param] : match;
            });
        }
        
        return value;
    }

    /**
     * 获取精灵名称
     */
    getPokemonName(speciesId) {
        return this.t(`pokemon.${speciesId}.name`);
    }

    /**
     * 获取技能名称
     */
    getSkillName(skillId) {
        return this.t(`skill.${skillId}.name`);
    }

    /**
     * 获取道具名称
     */
    getItemName(itemId) {
        return this.t(`item.${itemId}.name`);
    }

    /**
     * 获取成就名称
     */
    getAchievementName(achievementId) {
        return this.t(`achievement.${achievementId}.name`);
    }
}

export default new TranslationService();
```

## 5. 验收标准（可测试）

- [ ] 数据库迁移成功创建 6 张表
- [ ] 翻译键 CRUD API 功能正常
- [ ] 翻译内容提交和审核功能正常
- [ ] 翻译进度统计准确
- [ ] 缺失翻译列表查询正常
- [ ] 语言包导出功能正常（JSON格式）
- [ ] 翻译历史记录完整
- [ ] 翻译版本回滚功能正常
- [ ] 翻译缓存机制正常工作
- [ ] 客户端翻译加载优化（按需加载）
- [ ] 翻译任务管理功能正常
- [ ] 翻译评论功能正常
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**L** - 大型需求

理由：
- 需要创建 6 张数据库表
- 实现翻译管理核心模块
- 开发 20+ 个 API 端点
- 客户端集成和优化
- 管理后台翻译界面
- 预计工作量：5-7 人天

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **全球化支撑**：多语言游戏必备的基础设施
2. **运营效率**：提升翻译管理和内容更新效率
3. **质量保障**：翻译审核流程确保内容质量
4. **扩展基础**：为未来支持更多语言打下基础
5. **依赖性强**：后续国际化功能都依赖此系统
