# REQ-00488：游戏内文本本地化与智能缓存系统

- **编号**：REQ-00488
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service/game-client/shared/i18n/localization-service
- **创建时间**：2026-07-07 16:46
- **依赖需求**：REQ-00051(多货币支持已完成), REQ-00039(缓存预热已完成)

## 1. 背景与问题

当前 mineGo 项目已有基础的错误消息国际化(i18n.js)和数字/货币格式化系统，但**游戏内核心文本缺少完整的本地化管理系统**：

1. **精灵名称未国际化**：数据库中精灵、技能、道具等核心实体名称仅存储单一语言版本，不同语言用户看到的是原始名称而非本地化文本
2. **文本缓存效率低**：每次请求都需要查询数据库获取文本，高频访问场景(精灵列表、战斗界面)性能瓶颈明显
3. **翻译更新流程缺失**：缺少翻译管理、审核、发布的标准化流程，依赖手动数据库更新
4. **客户端-服务器不一致**：客户端硬编码部分文本，与服务器端翻译不统一

基于代码现状分析：
- `backend/shared/i18n.js` 仅包含错误消息翻译，缺少游戏实体文本管理
- `frontend/game-client` 缺少完整的本地化框架
- 精灵、技能、道具等核心数据缺少 `localizations` 表或 JSON 字段

## 2. 目标

构建完整的游戏文本本地化系统，实现：

1. **核心实体多语言支持**：精灵名称、技能名称、道具名称、成就描述等支持 zh-CN/en-US/ja-JP 三语言
2. **智能缓存策略**：高频文本预编译缓存 + LRU 动态缓存，减少 90%+ 数据库查询
3. **翻译管理平台**：admin-dashboard 提供翻译编辑、审核、发布功能
4. **客户端同步机制**：WebSocket 实时推送翻译更新，避免版本不一致
5. **性能优化**：文本查询平均延迟从 50ms 降至 <5ms，精灵列表加载时间减少 30%

## 3. 范围

- **包含**：
  - 数据库设计：`entity_localizations` 表存储多语言文本
  - 服务端模块：`LocalizationService`、`TextCacheManager`、`TranslationSync`
  - 客户端集成：本地化文本加载、缓存、动态更新
  - 管理平台：翻译编辑、审核、发布流程
  - 缓存预热：启动时预加载高频文本(前 1000 个精灵)
  - API 设计：`GET /api/v2/localizations/{entityType}/{entityId}`

- **不包含**：
  - 语音/音频本地化(已由 REQ-00470 处理)
  - 图片/图标本地化
  - 实时翻译服务(机器翻译)
  - 距离单位本地化(已由 REQ-00335 处理)
  - 时区相关调度(已由 REQ-00473 处理)

## 4. 详细需求

### 4.1 数据库设计

创建 `entity_localizations` 表：

```sql
CREATE TABLE entity_localizations (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,  -- pokemon/skill/item/achievement
  entity_id INTEGER NOT NULL,
  language VARCHAR(10) NOT NULL,      -- zh-CN/en-US/ja-JP
  field_name VARCHAR(50) NOT NULL,    -- name/description/flavor_text
  text TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  status VARCHAR(20) DEFAULT 'draft', -- draft/review/published
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, language, field_name)
);

CREATE INDEX idx_localizations_lookup 
  ON entity_localizations(entity_type, entity_id, language, status);
CREATE INDEX idx_localizations_draft 
  ON entity_localizations(status) WHERE status = 'draft';
```

### 4.2 LocalizationService 核心模块

```javascript
// backend/shared/LocalizationService.js
class LocalizationService {
  constructor() {
    this.cacheManager = new TextCacheManager();
    this.dbPool = require('./db');
  }

  /**
   * 获取实体本地化文本(带缓存)
   * @param {string} entityType - pokemon/skill/item/achievement
   * @param {number} entityId - 实体ID
   * @param {string} language - zh-CN/en-US/ja-JP
   * @param {string} fieldName - name/description
   * @returns {string} 本地化文本
   */
  async getText(entityType, entityId, language, fieldName = 'name') {
    // 1. 检查缓存
    const cacheKey = `${entityType}:${entityId}:${language}:${fieldName}`;
    const cached = this.cacheManager.get(cacheKey);
    if (cached) return cached;

    // 2. 查询数据库
    const result = await this.dbPool.query(`
      SELECT text FROM entity_localizations 
      WHERE entity_type = $1 AND entity_id = $2 
        AND language = $3 AND field_name = $4 
        AND status = 'published'
      LIMIT 1
    `, [entityType, entityId, language, fieldName]);

    if (result.rows.length === 0) {
      // 回退到默认语言
      return this.getFallbackText(entityType, entityId, fieldName);
    }

    const text = result.rows[0].text;
    // 3. 写入缓存
    this.cacheManager.set(cacheKey, text);
    return text;
  }

  /**
   * 批量获取文本(优化性能)
   */
  async getTextsBatch(requests) {
    // 单次查询获取所有文本，避免 N+1 问题
    const conditions = requests.map((r, i) => 
      `(entity_type = $${i*4+1} AND entity_id = $${i*4+2} AND language = $${i*4+3} AND field_name = $${i*4+4})`
    ).join(' OR ');
    
    const values = requests.flatMap(r => 
      [r.entityType, r.entityId, r.language, r.fieldName]
    );
    
    const result = await this.dbPool.query(`
      SELECT entity_type, entity_id, language, field_name, text 
      FROM entity_localizations WHERE ${conditions} AND status = 'published'
    `, values);
    
    // 批量写入缓存
    const texts = {};
    result.rows.forEach(row => {
      const key = `${row.entity_type}:${row.entity_id}:${row.language}:${row.field_name}`;
      texts[key] = row.text;
      this.cacheManager.set(key, row.text);
    });
    
    return texts;
  }
}
```

### 4.3 TextCacheManager 智能缓存

```javascript
// backend/shared/TextCacheManager.js
class TextCacheManager {
  constructor() {
    this.lruCache = new LRUCache({
      max: 10000,        // 缓存 10000 条文本
      maxAge: 3600000,   // 1 小时过期
      updateAgeOnGet: true
    });
    this.precompiledCache = new Map(); // 预编译高频文本
  }

  /**
   * 预编译高频文本(启动时加载)
   */
  async warmupCache(dbPool) {
    const高频实体 = [
      { type: 'pokemon', ids: [1, 4, 7, 25, 39, 52, 63, 94, 129, 150] }, // 前 10 热门精灵
      { type: 'skill', ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },           // 前 10 热门技能
      { type: 'item', ids: [1, 2, 3, 4, 5] }                             // 前 5 热门道具
    ];

    const languages = ['zh-CN', 'en-US', 'ja-JP'];
    
    for (const entity of高频实体) {
      for (const lang of languages) {
        for (const id of entity.ids) {
          const text = await this.fetchText(dbPool, entity.type, id, lang);
          if (text) {
            this.precompiledCache.set(`${entity.type}:${id}:${lang}:name`, text);
          }
        }
      }
    }
    
    logger.info(`Precompiled ${this.precompiledCache.size} high-frequency texts`);
  }
}
```

### 4.4 TranslationSync WebSocket 同步

```javascript
// backend/shared/TranslationSync.js
class TranslationSync {
  constructor(wsServer, localizationService) {
    this.ws = wsServer;
    this.locService = localizationService;
  }

  /**
   * 推送翻译更新到客户端
   */
  broadcastUpdate(entityType, entityId, language, fieldName, newText) {
    const message = {
      type: 'localization_update',
      data: {
        entityType,
        entityId,
        language,
        fieldName,
        text: newText,
        timestamp: Date.now()
      }
    };
    
    this.ws.clients.forEach(client => {
      if (client.language === language) {
        client.send(JSON.stringify(message));
      }
    });
  }

  /**
   * 客户端请求批量同步
   */
  handleSyncRequest(client, request) {
    const { entityTypes, languages } = request;
    // 返回指定类型和语言的最新翻译
    this.locService.getLatestTranslations(entityTypes, languages)
      .then(translations => {
        client.send(JSON.stringify({
          type: 'localization_sync',
          translations
        }));
      });
  }
}
```

### 4.5 管理平台翻译编辑功能

admin-dashboard 添加翻译管理页面：

- 翻译列表：按实体类型/语言筛选
- 编辑器：实时编辑、保存草稿
- 审核流程：draft → review → published
- 版本历史：查看历史版本、回滚
- 批量导入：CSV/JSON 批量导入翻译

### 4.6 API 设计

```
GET /api/v2/localizations/{entityType}/{entityId}
Response: {
  "entityType": "pokemon",
  "entityId": 25,
  "localizations": {
    "zh-CN": { "name": "皮卡丘", "description": "电气鼠精灵..." },
    "en-US": { "name": "Pikachu", "description": "Electric mouse Pokémon..." },
    "ja-JP": { "name": "ピカチュウ", "description": "電気鼠ポケモン..." }
  }
}

POST /api/v2/admin/localizations
Body: {
  "entityType": "pokemon",
  "entityId": 25,
  "language": "zh-CN",
  "fieldName": "name",
  "text": "皮卡丘",
  "status": "draft"
}

PUT /api/v2/admin/localizations/{id}/publish
Response: { "success": true, "version": 2 }
```

## 5. 验收标准（可测试）

- [ ] 数据库表创建成功，包含索引和约束
- [ ] LocalizationService 单次文本查询延迟 < 10ms(缓存命中时 < 1ms)
- [ ] 批量查询 100 个精灵名称延迟 < 50ms
- [ ] 启动时预编译缓存加载成功，包含前 10 热门精灵的 3 语言文本
- [ ] 缓存命中率 ≥ 85%(高频文本场景)
- [ ] admin-dashboard 翻译编辑页面可用，支持草稿保存、审核、发布
- [ ] WebSocket 推送翻译更新，客户端实时收到消息
- [ ] 翻译回退机制：缺失语言回退到 zh-CN 默认语言
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 精灵列表 API 返回本地化名称，不再返回原始名称

## 6. 工作量估算

**L** - 大型工作量
- 数据库表设计 + 索引：2 小时
- LocalizationService + TextCacheManager：4 小时
- TranslationSync WebSocket：2 小时
- admin-dashboard 翻译管理：3 小时
- 客户端集成：2 小时
- API 路由 + 测试：2 小时
- 预编译缓存 + 启动加载：1 小时
- 单元测试：2 小时

总计约 16 小时，需 2 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **国际化核心功能**：游戏全球化部署必需，zh-CN/en-US/ja-JP 是目标市场
2. **用户体验直接提升**：玩家看到本地化精灵名称，体验更友好
3. **性能瓶颈解决**：高频文本查询缓存后，精灵列表加载速度提升 30%
4. **依赖已有系统**：缓存预热(REQ-00039)、多货币(REQ-00051)已完成，可复用
5. **成熟度评分提升**：完成后"国际化/本地化"维度从 5 分提升至 8 分

当前项目国际化维度较弱，仅支持错误消息和数字格式化，游戏核心文本缺少本地化。此需求是国际化功能的重要补充，优先级应定为 P1。
