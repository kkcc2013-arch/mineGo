# REQ-00167：游戏内容本地化数据层与动态翻译系统

- **编号**：REQ-00167
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、location-service、reward-service、gateway、database/migrations、backend/shared/i18n.js、game-client
- **创建时间**：2026-06-13 20:05
- **依赖需求**：REQ-00011（多语言国际化支持）、REQ-00155（OpenAPI 文档多语言描述）

## 1. 背景与问题

### 当前现状
项目已实现 UI 层面的国际化（前端 `i18n/index.js` + 后端 `shared/i18n.js`），支持中/英/日三种语言。但游戏核心内容的本地化存在以下缺口：

1. **数据库层面**：`pokemon_species` 表仅有 `name_zh`、`name_en` 字段，缺少日语（`name_ja`）支持，且描述字段仅支持中文
2. **技能系统**：`pokemon_moves` 相关数据缺少多语言字段，技能名称和描述硬编码
3. **道具系统**：道具名称和描述未支持多语言
4. **活动内容**：活动标题和描述仅存储单一语言，无法根据用户语言动态展示
5. **动态内容翻译**：新增游戏内容（精灵、技能、道具）需要手动添加翻译，缺乏管理机制

### 影响
- 日本用户看到精灵名称、技能名称为英文，体验不完整
- 多语言内容维护成本高，需手动修改数据库
- 活动公告无法按用户语言自动展示

## 2. 目标

建立完整的游戏内容本地化数据层，实现：
1. 核心游戏数据（精灵、技能、道具、活动）支持中/英/日三语
2. 提供统一的本地化查询 API，自动根据用户语言返回对应翻译
3. 建立本地化内容管理机制，支持增量更新

## 3. 范围

### 包含
- 数据库表结构扩展：`pokemon_species`、`pokemon_moves`、`items` 表添加多语言字段
- 创建 `content_localizations` 通用翻译表，支持任意内容类型的翻译存储
- 后端 API 改造：pokemon-service、location-service、reward-service 返回本地化内容
- 本地化缓存层：Redis 缓存翻译内容，减少数据库查询
- 前端集成：game-client 自动使用本地化内容

### 不包含
- 翻译管理后台（admin-dashboard 扩展）- 作为后续独立需求
- 自动翻译服务集成（如 Google Translate API）- 作为后续需求
- 语音/音频本地化 - 作为独立需求处理

## 4. 详细需求

### 4.1 数据库迁移

#### 4.1.1 扩展 pokemon_species 表
```sql
ALTER TABLE pokemon_species 
  ADD COLUMN name_ja VARCHAR(50),
  ADD COLUMN description_en TEXT,
  ADD COLUMN description_ja TEXT;

-- 为现有数据添加日语名称（示例数据）
UPDATE pokemon_species SET name_ja = 'フシギダネ' WHERE id = 1;
-- ... 其他精灵日语名称
```

#### 4.1.2 创建 content_localizations 通用翻译表
```sql
CREATE TABLE content_localizations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_type    VARCHAR(50) NOT NULL,  -- 'pokemon', 'move', 'item', 'event'
  content_id      VARCHAR(100) NOT NULL, -- 对应内容ID
  field_name      VARCHAR(50) NOT NULL,  -- 'name', 'description'
  language        VARCHAR(10) NOT NULL,  -- 'zh-CN', 'en-US', 'ja-JP'
  translation     TEXT NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  
  CONSTRAINT uq_content_localization 
    UNIQUE (content_type, content_id, field_name, language)
);

CREATE INDEX idx_localization_content ON content_localizations(content_type, content_id);
CREATE INDEX idx_localization_lang ON content_localizations(language);
```

#### 4.1.3 创建本地化视图
```sql
CREATE VIEW v_pokemon_species_localized AS
SELECT 
  ps.*,
  COALESCE(ps.name_zh, ps.name_en) as name_zh_cn,
  ps.name_en as name_en_us,
  COALESCE(ps.name_ja, ps.name_en) as name_ja_jp
FROM pokemon_species ps;
```

### 4.2 后端共享模块

#### 4.2.1 创建 backend/shared/contentLocalizer.js
```javascript
// 本地化内容服务
class ContentLocalizer {
  constructor(cache) {
    this.cache = cache;
  }
  
  // 获取本地化内容
  async getLocalized(contentType, contentId, fieldName, language) {
    // 1. 检查缓存
    const cacheKey = `loc:${contentType}:${contentId}:${fieldName}:${language}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;
    
    // 2. 查询数据库
    const translation = await this.db.query(`
      SELECT translation FROM content_localizations
      WHERE content_type = $1 AND content_id = $2 
        AND field_name = $3 AND language = $4
    `, [contentType, contentId, fieldName, language]);
    
    // 3. 缓存结果（24小时）
    if (translation) {
      await this.cache.set(cacheKey, translation, 86400);
    }
    
    return translation;
  }
  
  // 批量获取本地化内容
  async getLocalizedBatch(items, language) {
    // 批量查询优化
  }
}
```

#### 4.2.2 扩展 backend/shared/i18n.js
- 添加 `getGameContentLocale()` 方法
- 集成 ContentLocalizer 服务

### 4.3 API 改造

#### 4.3.1 pokemon-service 端点改造
- `GET /api/pokemon/:id` - 返回本地化精灵名称和描述
- `GET /api/pokemon/nearby` - 返回本地化精灵名称列表
- `GET /api/pokedex` - 返回本地化图鉴信息

响应示例：
```json
{
  "id": 25,
  "name": "ピカチュウ",
  "description": "電気ネズミポケモン...",
  "type": ["ELECTRIC"],
  "_locale": "ja-JP"
}
```

#### 4.3.2 reward-service 活动本地化
- `GET /api/events` - 返回本地化活动标题和描述
- 活动创建时支持多语言标题/描述

#### 4.3.3 新增本地化管理端点
- `GET /api/localizations/:contentType/:contentId` - 获取内容的所有翻译
- `PUT /api/localizations/:contentType/:contentId` - 更新翻译（需要管理权限）

### 4.4 前端集成

#### 4.4.1 game-client 修改
- 捕捉界面显示本地化精灵名称
- 图鉴页显示本地化描述
- 活动公告显示本地化内容

#### 4.4.2 缓存策略
- Service Worker 缓存本地化内容
- 语言切换时刷新缓存

### 4.5 种子数据

创建 `database/seeds/localizations.sql`：
- 精灵名称翻译（日语补充）
- 技能名称翻译
- 道具名称翻译
- 基础活动模板翻译

## 5. 验收标准（可测试）

- [ ] `pokemon_species` 表包含 `name_ja`、`description_en`、`description_ja` 字段
- [ ] `content_localizations` 表创建成功，支持任意内容类型翻译存储
- [ ] `GET /api/pokemon/:id` 返回根据用户语言本地化的内容
- [ ] 日语用户能看到日语精灵名称（如 "ピカチュウ"）
- [ ] Redis 缓存本地化内容，TTL=24小时
- [ ] 前端图鉴页显示对应语言的内容
- [ ] 单元测试覆盖 ContentLocalizer 类，覆盖率 ≥ 80%
- [ ] 性能测试：批量获取 100 个精灵本地化信息 < 200ms

## 6. 工作量估算

**L（Large）**

理由：
- 涉及数据库迁移、后端服务改造、前端集成
- 需要准备大量翻译种子数据
- 需要测试多语言场景

预计工时：8-12 小时

## 7. 优先级理由

P1 理由：
1. 国际化完整性：当前仅有 UI 国际化，游戏核心内容缺失本地化，影响海外用户体验
2. 依赖关系：后续翻译管理后台、自动翻译集成依赖此基础设施
3. 用户价值：日本市场是重要目标市场，完整的本地化体验直接影响用户留存
