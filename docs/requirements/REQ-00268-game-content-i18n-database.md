# REQ-00268：游戏内容数据库多语言支持与本地化表结构设计

- **编号**：REQ-00268
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、location-service、reward-service、gateway、backend/shared、database/migrations、game-client
- **创建时间**：2026-06-18 21:00
- **依赖需求**：REQ-00011（游戏客户端多语言国际化支持）

## 1. 背景与问题

当前 mineGo 项目的国际化实现存在以下关键缺口：

**数据库层面问题：**
1. `pokemon_species` 表只包含 `name_zh`、`name_en` 和 `description_zh`，缺少日语支持和其他语言字段
2. `achievement_definitions` 表仅包含 `name_zh` 和 `description_zh`，无法支持国际化成就系统
3. 缺少技能（Skills）、道具（Items）、特性（Abilities）等游戏内容的多语言表结构
4. 没有 `game_content_translations` 或类似的统一翻译表

**影响范围：**
- 前端 i18n 系统已支持 zh-CN、en-US、ja-JP 三种语言，但数据库内容无法提供对应的翻译数据
- 游戏内容（精灵名称、技能描述、成就文本等）在不同语言环境下显示不完整或缺失
- 新增游戏内容时缺乏统一的本地化流程和数据模型

## 2. 目标

建立完整的游戏内容多语言数据库支持体系，实现：
- 所有游戏内容实体支持至少 3 种语言（zh-CN、en-US、ja-JP）
- 提供统一的本地化内容查询 API
- 支持增量更新和翻译内容版本管理
- 为运营团队提供翻译内容管理接口

**可量化目标：**
- 数据库支持 100% 的游戏内容多语言字段
- 翻译内容查询延迟 < 50ms（P95）
- 支持按语言动态切换游戏内容展示

## 3. 范围

**包含：**
- 扩展现有表的多语言字段（pokemon_species, achievement_definitions）
- 创建统一的游戏内容翻译表 `game_content_translations`
- 创建游戏内容本地化查询中间件和缓存层
- 数据迁移脚本：为现有数据添加翻译内容
- API 端点：获取多语言游戏内容
- admin-dashboard 翻译管理界面基础框架

**不包含：**
- 自动翻译服务集成（可作为后续需求）
- 翻译内容审核工作流
- 用户自定义翻译功能

## 4. 详细需求

### 4.1 数据库表结构扩展

#### 4.1.1 扩展 pokemon_species 表

```sql
ALTER TABLE pokemon_species 
ADD COLUMN name_ja VARCHAR(50),
ADD COLUMN description_en TEXT,
ADD COLUMN description_ja TEXT;

CREATE INDEX idx_pokemon_species_name_en ON pokemon_species(name_en);
CREATE INDEX idx_pokemon_species_name_ja ON pokemon_species(name_ja);
```

#### 4.1.2 扩展 achievement_definitions 表

```sql
ALTER TABLE achievement_definitions
ADD COLUMN name_en VARCHAR(100),
ADD COLUMN name_ja VARCHAR(100),
ADD COLUMN description_en TEXT,
ADD COLUMN description_ja TEXT;
```

#### 4.1.3 创建统一游戏内容翻译表

```sql
CREATE TABLE game_content_translations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_type    VARCHAR(50) NOT NULL,  -- 'pokemon', 'skill', 'item', 'achievement', 'ability'
  content_id      VARCHAR(50) NOT NULL,  -- 对应实体的 ID
  field_name      VARCHAR(50) NOT NULL,  -- 'name', 'description', 'flavor_text'
  language_code   VARCHAR(10) NOT NULL,  -- 'zh-CN', 'en-US', 'ja-JP'
  translated_text TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  updated_by      VARCHAR(100),          -- 翻译者/审核者
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(content_type, content_id, field_name, language_code)
);

CREATE INDEX idx_translations_content ON game_content_translations(content_type, content_id);
CREATE INDEX idx_translations_lang ON game_content_translations(language_code);
CREATE INDEX idx_translations_version ON game_content_translations(content_type, content_id, version DESC);
```

#### 4.1.4 创建新表支持多语言游戏内容

**技能表：**
```sql
CREATE TABLE skills (
  id              VARCHAR(50) PRIMARY KEY,
  type            pokemon_type_enum,
  power           SMALLINT,
  accuracy        DECIMAL(5,2),
  pp              SMALLINT NOT NULL,
  damage_class    VARCHAR(20) NOT NULL, -- 'physical', 'special', 'status'
  effect_type     VARCHAR(50),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE skill_translations (
  skill_id        VARCHAR(50) NOT NULL REFERENCES skills(id),
  language_code   VARCHAR(10) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  description     TEXT NOT NULL,
  PRIMARY KEY (skill_id, language_code)
);
```

**道具表：**
```sql
CREATE TABLE items (
  id              VARCHAR(50) PRIMARY KEY,
  category        VARCHAR(50) NOT NULL, -- 'pokeball', 'potion', 'berry', 'evolution'
  rarity          rarity_enum NOT NULL DEFAULT 'COMMON',
  effect_data     JSONB,
  sprite_url      VARCHAR(500),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE item_translations (
  item_id         VARCHAR(50) NOT NULL REFERENCES items(id),
  language_code   VARCHAR(10) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  description     TEXT NOT NULL,
  PRIMARY KEY (item_id, language_code)
);
```

### 4.2 后端 API 实现

#### 4.2.1 创建本地化查询中间件

**文件：** `backend/shared/LocalizedContentMiddleware.js`

```javascript
class LocalizedContentMiddleware {
  constructor(cacheClient) {
    this.cache = cacheClient;
    this.supportedLanguages = ['zh-CN', 'en-US', 'ja-JP'];
    this.defaultLanguage = 'zh-CN';
  }

  // 从请求头或 query 参数获取用户语言偏好
  getPreferredLanguage(req) {
    return req.query.lang || 
           req.headers['accept-language']?.split(',')[0] || 
           this.defaultLanguage;
  }

  // 为游戏内容添加本地化字段
  async localizeContent(contentType, contentArray, language) {
    // 实现：查询 game_content_translations 表
    // 使用 Redis 缓存优化性能
    // 返回带有多语言字段的内容数组
  }
}
```

#### 4.2.2 扩展 pokemon-service API

**新增端点：**
- `GET /pokemon/species/:id?lang=en-US` - 获取指定语言的精灵详情
- `GET /pokemon/species?lang=ja-JP` - 获取精灵列表（带本地化）
- `GET /pokemon/skills/:id?lang=zh-CN` - 获取技能详情（多语言）

**响应格式示例：**
```json
{
  "id": 25,
  "name": "Pikachu",
  "name_zh": "皮卡丘",
  "name_ja": "ピカチュウ",
  "description": "When several of these Pokémon gather...",
  "description_zh": "好几只这种宝可梦聚集在一起时...",
  "description_ja": "このポケモンが数匹集まると...",
  "type1": "ELECTRIC",
  "sprite_url": "https://cdn.example.com/pokemon/25.png"
}
```

### 4.3 数据迁移

**文件：** `database/migrations/V10__add_i18n_game_content.sql`

迁移内容：
1. 为现有 pokemon_species 数据添加日语名称和描述（初始数据）
2. 为现有 achievement_definitions 添加英语和日语翻译
3. 创建并填充 skills、items 基础数据及翻译
4. 初始化 game_content_translations 表数据

### 4.4 缓存策略

**Redis 缓存设计：**
```
Key: game_content:{content_type}:{content_id}:{language}
TTL: 3600 秒（1小时）
Value: JSON 格式的翻译内容
```

**缓存失效机制：**
- 翻译内容更新时主动失效缓存
- 通过版本号控制缓存更新

### 4.5 admin-dashboard 翻译管理基础

**新增页面：**
- 翻译内容列表页（按内容类型筛选）
- 翻译编辑表单（支持多语言并行编辑）
- 翻译版本历史查看

## 5. 验收标准（可测试）

- [ ] pokemon_species 表包含 name_zh, name_en, name_ja 字段，数据完整
- [ ] achievement_definitions 表包含完整的多语言字段
- [ ] game_content_translations 表创建成功，索引正确
- [ ] skills 和 items 表创建并填充初始数据
- [ ] GET /pokemon/species/:id?lang=en-US 返回英文内容
- [ ] GET /pokemon/species/:id?lang=ja-JP 返回日文内容
- [ ] 缓存命中率 > 80%，查询延迟 < 50ms（P95）
- [ ] 数据迁移脚本可重复执行，无数据丢失
- [ ] admin-dashboard 可查看和编辑翻译内容

## 6. 工作量估算

**估算：** M（中等）

**理由：**
- 数据库表结构扩展：2-3 小时
- 迁移脚本编写和初始数据准备：4-5 小时
- 后端中间件和 API 实现：5-6 小时
- 缓存层实现：2-3 小时
- admin-dashboard 基础功能：3-4 小时
- 测试和验证：2-3 小时
- **总计：18-24 小时**

## 7. 优先级理由

**P1 理由：**

1. **基础设施重要性**：游戏内容多语言支持是国际化功能的核心基础设施，直接影响用户体验
2. **阻塞后续需求**：多个国际化相关需求（如 REQ-00244 RTL 布局、REQ-00252 日期本地化）依赖此基础
3. **用户可见性强**：玩家在不同语言环境下看到的精灵名称、技能描述等核心内容，影响游戏可玩性
4. **技术债务清理**：解决当前数据库设计不完整的问题，避免后期更大规模重构
5. **对项目成熟度贡献**：显著提升"国际化/本地化"维度评分，当前得分较低，此需求可提升 2-3 分

**对"项目可用"的贡献：**
- 使游戏在 zh-CN、en-US、ja-JP 三个语言环境下完全可用
- 为后续扩展更多语言提供标准化的数据模型和 API
- 完善国际化基础设施，提升产品全球化能力
