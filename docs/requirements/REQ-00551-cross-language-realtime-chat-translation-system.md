# REQ-00551：跨语言实时聊天翻译系统

- **编号**：REQ-00551
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：social-service、gateway、game-client、backend/shared/ai、Redis、PostgreSQL
- **创建时间**：2026-07-15 02:00
- **依赖需求**：REQ-00011（多语言支持）、REQ-00116（语音聊天系统）、REQ-00137（翻译管理系统）

## 1. 背景与问题

mineGo 已实现多语言国际化支持（REQ-00011）、语音聊天系统（REQ-00116）、翻译管理系统（REQ-00137），但**跨语言实时聊天翻译仍是一个关键缺口**：

### 1.1 用户痛点
1. **公会国际化**：全球玩家加入同一公会，但语言不通，无法有效沟通
2. **跨区域好友**：玩家添加海外好友后，聊天依赖第三方翻译工具
3. **团队协作障碍**：多国玩家组队打道馆/Raid时，无法实时交流策略
4. **社交活跃度低**：语言壁垒导致跨国社交互动率下降约 40%

### 1.2 数据现状
- 日均跨语言聊天消息：约 50 万条
- 使用第三方翻译工具的玩家占比：约 35%
- 因语言问题放弃跨区域社交的玩家：约 25%
- 公会内多语言混合场景占比：约 15%

### 1.3 风险影响
- 玩家社交圈局限于本地语言群体
- 公会招募难度增加，影响公会生态
- 团队战斗协作效率降低，影响游戏体验
- 全球化运营受限，难以形成跨国社区

## 2. 目标

建立跨语言实时聊天翻译系统，**实现 90%+ 的聊天消息即时翻译**，翻译延迟控制在 500ms 以内，让不同语言玩家可以无障碍交流。

### 2.1 核心收益
1. **实时翻译**：聊天消息自动翻译为接收者语言
2. **多语言消息展示**：同时显示原文和翻译，便于学习
3. **翻译质量优化**：游戏术语专项翻译，保证准确性
4. **隐私保护**：敏感内容不翻译，保护用户隐私
5. **降本增效**：减少第三方工具依赖，提升用户体验

## 3. 范围

### 包含
- 实时文本消息翻译（私聊、公会频道、团队频道）
- 翻译结果缓存与智能复用
- 游戏术语专项词典管理
- 翻译质量反馈与优化
- 多翻译引擎适配（Google、DeepL、Azure、自建）
- 翻译用量监控与成本控制
- 翻译失败降级策略

### 不包含
- 语音消息翻译（后续版本）
- 图片文字识别翻译（OCR）
- 机器翻译模型训练（使用第三方服务）
- 专业人工翻译接口

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 翻译缓存表
CREATE TABLE translation_cache (
  id SERIAL PRIMARY KEY,
  source_text_hash VARCHAR(64) NOT NULL,
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  translated_text TEXT NOT NULL,
  quality_score DECIMAL(3,2), -- 翻译质量评分
  usage_count INT DEFAULT 1,
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_text_hash, source_language, target_language)
);

CREATE INDEX idx_translation_cache_lookup ON translation_cache(source_text_hash, source_language, target_language);
CREATE INDEX idx_translation_cache_lru ON translation_cache(usage_count, last_used_at);

-- 游戏术语词典表
CREATE TABLE game_term_dictionary (
  id SERIAL PRIMARY KEY,
  term_key VARCHAR(128) NOT NULL,
  source_language VARCHAR(10) NOT NULL,
  source_term VARCHAR(256) NOT NULL,
  translations JSONB NOT NULL, -- {"zh-CN": "精灵球", "ja-JP": "モンスターボール"}
  category VARCHAR(50), -- pokemon/item/skill/location/mechanic
  context_hint TEXT,
  is_official BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(term_key, source_language)
);

CREATE INDEX idx_term_lookup ON game_term_dictionary(source_term, source_language);
CREATE INDEX idx_term_category ON game_term_dictionary(category);

-- 翻译质量反馈表
CREATE TABLE translation_feedback (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  source_text TEXT NOT NULL,
  original_translation TEXT NOT NULL,
  suggested_translation TEXT,
  source_language VARCHAR(10),
  target_language VARCHAR(10),
  rating INT, -- 1-5
  issue_type VARCHAR(50), -- accuracy/context/terminology/grammar
  status VARCHAR(20) DEFAULT 'pending', -- pending/reviewed/applied/ignored
  reviewed_at TIMESTAMPTZ,
  reviewer_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_translation_feedback_pending ON translation_feedback(status, created_at);
CREATE INDEX idx_translation_feedback_user ON translation_feedback(user_id);

-- 翻译用量统计表
CREATE TABLE translation_usage_stats (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  source_language VARCHAR(10),
  target_language VARCHAR(10),
  message_count INT DEFAULT 0,
  character_count BIGINT DEFAULT 0,
  api_calls INT DEFAULT 0,
  cache_hits INT DEFAULT 0,
  errors INT DEFAULT 0,
  avg_latency_ms INT,
  cost_usd DECIMAL(10,4),
  UNIQUE(date, source_language, target_language)
);

CREATE INDEX idx_translation_usage_date ON translation_usage_stats(date);
```

### 4.2 核心翻译引擎

```javascript
// backend/shared/ai/realtimeTranslationEngine.js

const crypto = require('crypto');
const { createLogger } = require('../logger');
const Redis = require('ioredis');
const { Pool } = require('pg');

const logger = createLogger('realtime-translation');

class RealtimeTranslationEngine {
  constructor(config = {}) {
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.db = new Pool({ connectionString: config.dbUrl || process.env.DATABASE_URL });
    
    // 翻译引擎配置
    this.engines = {
      google: new GoogleTranslateEngine(config.google),
      deepl: new DeepLEngine(config.deepl),
      azure: new AzureTranslateEngine(config.azure),
      local: new LocalTermEngine(this.db)
    };
    
    // 默认引擎优先级
    this.enginePriority = ['deepl', 'google', 'azure'];
    this.cacheTTLMs = 24 * 60 * 60 * 1000; // 24小时
    this.maxRetries = 2;
    this.timeoutMs = 3000;
  }

  /**
   * 翻译消息
   * @param {string} text - 原文
   * @param {string} targetLang - 目标语言
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 翻译结果
   */
  async translate(text, targetLang, options = {}) {
    const startTime = Date.now();
    const sourceLang = options.sourceLang || await this.detectLanguage(text);
    
    // 相同语言不翻译
    if (sourceLang === targetLang) {
      return {
        translatedText: text,
        sourceLanguage: sourceLang,
        cached: false,
        latencyMs: 0
      };
    }

    // 1. 检查缓存
    const cacheKey = this.getCacheKey(text, sourceLang, targetLang);
    const cached = await this.checkCache(cacheKey);
    if (cached) {
      await this.recordCacheHit(cacheKey);
      return {
        translatedText: cached.translated_text,
        sourceLanguage: sourceLang,
        cached: true,
        latencyMs: Date.now() - startTime
      };
    }

    // 2. 预处理：游戏术语识别与替换
    const { processedText, termMap } = await this.preprocessGameTerms(text, sourceLang);
    
    // 3. 调用翻译引擎
    let translatedText = null;
    let engineUsed = null;
    
    for (const engineName of this.enginePriority) {
      try {
        const engine = this.engines[engineName];
        if (!engine) continue;
        
        translatedText = await this.translateWithEngine(
          engine, 
          processedText, 
          sourceLang, 
          targetLang
        );
        engineUsed = engineName;
        break;
      } catch (error) {
        logger.warn({ engine: engineName, error: error.message }, 'Translation engine failed');
      }
    }

    if (!translatedText) {
      // 降级：返回原文
      logger.error({ text, sourceLang, targetLang }, 'All translation engines failed');
      return {
        translatedText: text,
        sourceLanguage: sourceLang,
        cached: false,
        error: 'TRANSLATION_FAILED',
        latencyMs: Date.now() - startTime
      };
    }

    // 4. 后处理：术语还原
    translatedText = this.postprocessGameTerms(translatedText, termMap, targetLang);

    // 5. 缓存结果
    await this.saveToCache(cacheKey, {
      source_text: text,
      translated_text: translatedText,
      source_language: sourceLang,
      target_language: targetLang
    });

    // 6. 记录统计
    await this.recordTranslation(sourceLang, targetLang, text.length, Date.now() - startTime);

    return {
      translatedText,
      sourceLanguage: sourceLang,
      cached: false,
      engine: engineUsed,
      latencyMs: Date.now() - startTime
    };
  }

  /**
   * 批量翻译
   */
  async batchTranslate(messages, targetLang, options = {}) {
    const results = [];
    const batchSize = 10;
    
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const translations = await Promise.all(
        batch.map(msg => this.translate(msg.text, targetLang, { ...options, sourceLang: msg.sourceLang }))
      );
      results.push(...translations);
    }
    
    return results;
  }

  /**
   * 获取缓存键
   */
  getCacheKey(text, sourceLang, targetLang) {
    const hash = crypto.createHash('md5').update(text).digest('hex');
    return `translation:${sourceLang}:${targetLang}:${hash}`;
  }

  /**
   * 检查缓存
   */
  async checkCache(cacheKey) {
    // 先查 Redis
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 再查数据库
    const result = await this.db.query(`
      SELECT translated_text, quality_score 
      FROM translation_cache 
      WHERE source_text_hash = $1 
        AND source_language = $2 
        AND target_language = $3
    `, [cacheKey.split(':')[3], cacheKey.split(':')[1], cacheKey.split(':')[2]]);

    if (result.rows.length > 0) {
      return result.rows[0];
    }

    return null;
  }

  /**
   * 保存到缓存
   */
  async saveToCache(cacheKey, data) {
    // Redis 缓存
    await this.redis.setex(
      cacheKey, 
      this.cacheTTLMs / 1000, 
      JSON.stringify(data)
    );

    // 数据库缓存（异步）
    this.db.query(`
      INSERT INTO translation_cache (source_text_hash, source_language, target_language, translated_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (source_text_hash, source_language, target_language) 
      DO UPDATE SET usage_count = translation_cache.usage_count + 1, last_used_at = NOW()
    `, [cacheKey.split(':')[3], data.source_language, data.target_language, data.translated_text])
      .catch(err => logger.error({ err }, 'Failed to save translation cache'));
  }

  /**
   * 预处理游戏术语
   */
  async preprocessGameTerms(text, sourceLang) {
    const result = await this.db.query(`
      SELECT term_key, source_term, translations
      FROM game_term_dictionary
      WHERE source_language = $1
    `, [sourceLang]);

    const termMap = new Map();
    let processedText = text;

    for (const row of result.rows) {
      const regex = new RegExp(row.source_term, 'gi');
      processedText = processedText.replace(regex, `{{TERM:${row.term_key}}}`);
      termMap.set(row.term_key, row.translations);
    }

    return { processedText, termMap };
  }

  /**
   * 后处理游戏术语
   */
  postprocessGameTerms(text, termMap, targetLang) {
    let result = text;
    for (const [termKey, translations] of termMap) {
      const translated = translations[targetLang] || translations['en-US'] || termKey;
      result = result.replace(`{{TERM:${termKey}}}`, translated);
    }
    return result;
  }

  /**
   * 语言检测
   */
  async detectLanguage(text) {
    // 使用第一个可用的引擎检测
    for (const engineName of this.enginePriority) {
      const engine = this.engines[engineName];
      if (engine && engine.detectLanguage) {
        return engine.detectLanguage(text);
      }
    }
    return 'en-US';
  }

  /**
   * 记录缓存命中
   */
  async recordCacheHit(cacheKey) {
    await this.redis.incr(`${cacheKey}:hits`);
    await this.db.query(`
      UPDATE translation_cache 
      SET usage_count = usage_count + 1, last_used_at = NOW()
      WHERE source_text_hash = $1
    `, [cacheKey.split(':')[3]]);
  }

  /**
   * 记录翻译统计
   */
  async recordTranslation(sourceLang, targetLang, charCount, latencyMs) {
    const today = new Date().toISOString().split('T')[0];
    await this.db.query(`
      INSERT INTO translation_usage_stats (date, source_language, target_language, message_count, character_count, avg_latency_ms)
      VALUES ($1, $2, $3, 1, $4, $5)
      ON CONFLICT (date, source_language, target_language)
      DO UPDATE SET 
        message_count = translation_usage_stats.message_count + 1,
        character_count = translation_usage_stats.character_count + $4,
        avg_latency_ms = (translation_usage_stats.avg_latency_ms + $5) / 2
    `, [today, sourceLang, targetLang, charCount, latencyMs]);
  }
}

/**
 * Google 翻译引擎适配器
 */
class GoogleTranslateEngine {
  constructor(config) {
    this.apiKey = config?.apiKey;
    this.endpoint = 'https://translation.googleapis.com/language/translate/v2';
  }

  async translate(text, sourceLang, targetLang) {
    const response = await fetch(`${this.endpoint}?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        source: sourceLang.split('-')[0],
        target: targetLang.split('-')[0],
        format: 'text'
      })
    });

    if (!response.ok) {
      throw new Error(`Google Translate API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data.translations[0].translatedText;
  }

  async detectLanguage(text) {
    const response = await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text })
    });

    const data = await response.json();
    return data.data.detections[0][0].language;
  }
}

/**
 * DeepL 翻译引擎适配器
 */
class DeepLEngine {
  constructor(config) {
    this.apiKey = config?.apiKey;
    this.endpoint = config?.pro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
  }

  async translate(text, sourceLang, targetLang) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        text: text,
        source_lang: sourceLang.split('-')[0].toUpperCase(),
        target_lang: targetLang.split('-')[0].toUpperCase()
      })
    });

    if (!response.ok) {
      throw new Error(`DeepL API error: ${response.status}`);
    }

    const data = await response.json();
    return data.translations[0].text;
  }
}

/**
 * 本地术语引擎（降级方案）
 */
class LocalTermEngine {
  constructor(db) {
    this.db = db;
  }

  async translate(text, sourceLang, targetLang) {
    // 仅支持术语翻译，作为降级方案
    const result = await this.db.query(`
      SELECT term_key, source_term, translations
      FROM game_term_dictionary
      WHERE source_language = $1
    `, [sourceLang]);

    let translated = text;
    for (const row of result.rows) {
      const regex = new RegExp(row.source_term, 'gi');
      translated = translated.replace(regex, row.translations[targetLang] || row.source_term);
    }

    return translated;
  }
}

module.exports = RealtimeTranslationEngine;
```

### 4.3 WebSocket 消息翻译中间件

```javascript
// backend/services/social-service/src/middleware/chatTranslation.js

const RealtimeTranslationEngine = require('../../../shared/ai/realtimeTranslationEngine');

class ChatTranslationMiddleware {
  constructor() {
    this.engine = new RealtimeTranslationEngine();
  }

  /**
   * 处理聊天消息翻译
   */
  async handleChatMessage(ws, message, next) {
    try {
      // 跳过非聊天消息
      if (message.type !== 'chat' && message.type !== 'group_chat') {
        return next();
      }

      // 获取接收者语言偏好
      const recipientLang = await this.getRecipientLanguage(ws, message);
      const senderLang = message.senderLanguage || 'en-US';

      // 相同语言不翻译
      if (senderLang === recipientLang) {
        return next();
      }

      // 执行翻译
      const translation = await this.engine.translate(
        message.content,
        recipientLang,
        { sourceLang: senderLang }
      );

      // 添加翻译结果到消息
      message.translation = {
        translatedText: translation.translatedText,
        sourceLanguage: translation.sourceLanguage,
        targetLanguage: recipientLang,
        cached: translation.cached,
        latencyMs: translation.latencyMs
      };

      // 保留原文
      message.originalContent = message.content;
      
      next();
    } catch (error) {
      // 翻译失败不影响消息发送
      console.error('Chat translation error:', error);
      next();
    }
  }

  /**
   * 获取接收者语言偏好
   */
  async getRecipientLanguage(ws, message) {
    // 私聊：获取对方语言
    if (message.type === 'chat') {
      const recipient = await this.getUserPreferences(message.recipientId);
      return recipient?.language || 'en-US';
    }

    // 群聊：获取用户自己的语言（客户端处理显示）
    if (message.type === 'group_chat') {
      return ws.userLanguage || 'en-US';
    }

    return 'en-US';
  }
}

module.exports = ChatTranslationMiddleware;
```

### 4.4 API 端点设计

```
POST /api/v1/translation/translate
  - 功能：翻译文本
  - 请求体：{ text, targetLanguage, sourceLanguage? }
  - 响应：{ translatedText, sourceLanguage, cached, latencyMs }

POST /api/v1/translation/batch
  - 功能：批量翻译
  - 请求体：{ messages: [{ text, sourceLanguage? }], targetLanguage }
  - 响应：{ translations: [...] }

GET /api/v1/translation/terms
  - 功能：获取游戏术语词典
  - 参数：?category=pokemon&language=zh-CN
  - 响应：{ terms: [{ key, term, translations }] }

POST /api/v1/translation/feedback
  - 功能：提交翻译质量反馈
  - 请求体：{ messageId, rating, suggestedTranslation?, issueType? }
  - 响应：{ success: true }

GET /api/v1/translation/stats
  - 功能：获取翻译用量统计（Admin）
  - 参数：?date=2026-07-15
  - 响应：{ dailyStats, topLanguages, cacheHitRate }
```

### 4.5 Prometheus 指标

```javascript
const metrics = {
  // 翻译请求总数
  translationRequestsTotal: new promClient.Counter({
    name: 'minego_translation_requests_total',
    help: 'Total translation requests',
    labelNames: ['source_lang', 'target_lang', 'engine']
  }),

  // 翻译延迟
  translationLatency: new promClient.Histogram({
    name: 'minego_translation_latency_ms',
    help: 'Translation latency in milliseconds',
    labelNames: ['engine', 'cached'],
    buckets: [50, 100, 200, 500, 1000, 2000]
  }),

  // 缓存命中率
  translationCacheHits: new promClient.Counter({
    name: 'minego_translation_cache_hits_total',
    help: 'Translation cache hits',
    labelNames: ['hit'] // hit=true/false
  }),

  // 翻译错误
  translationErrors: new promClient.Counter({
    name: 'minego_translation_errors_total',
    help: 'Translation errors',
    labelNames: ['engine', 'error_type']
  }),

  // 字符统计
  translationCharacters: new promClient.Counter({
    name: 'minego_translation_characters_total',
    help: 'Total characters translated',
    labelNames: ['source_lang', 'target_lang']
  })
};
```

## 5. 验收标准（可测试）

- [ ] 实时翻译引擎实现，支持至少 3 种翻译 API（Google/DeepL/Azure）
- [ ] 翻译缓存系统实现，Redis + PostgreSQL 双层缓存
- [ ] 游戏术语词典表创建，初始数据至少 500 条术语
- [ ] 翻译质量反馈表创建，支持用户评分和建议
- [ ] WebSocket 聊天消息翻译中间件实现
- [ ] 4 个 API 端点实现，返回格式符合规范
- [ ] 单元测试覆盖率 ≥ 80%，包含至少 30 个测试用例
- [ ] Prometheus 指标集成，5 个指标正常上报
- [ ] 翻译延迟 P95 < 500ms
- [ ] 缓存命中率 ≥ 60%（24 小时内）
- [ ] 翻译准确率 ≥ 90%（用户反馈评分）

## 6. 工作量估算

**L** - 预计 2-3 天

理由：
- 需要集成多个第三方翻译 API
- 双层缓存系统设计较复杂
- WebSocket 中间件需要与现有聊天系统集成
- 游戏术语词典需要整理初始数据

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **用户需求强烈**：35% 玩家依赖第三方翻译工具，体验割裂
2. **社交生态关键**：语言壁垒是跨区域社交的最大障碍
3. **技术可行**：翻译 API 成熟，集成风险低
4. **成本可控**：通过缓存可大幅降低 API 调用成本
5. **收益明显**：可提升跨区域社交活跃度 30%+