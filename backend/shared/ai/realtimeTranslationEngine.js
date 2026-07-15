'use strict';

/**
 * 实时翻译引擎
 * REQ-00551: 跨语言实时聊天翻译系统
 * 
 * 功能:
 * - 多翻译引擎支持 (Google/DeepL/Azure)
 * - 双层缓存 (Redis + PostgreSQL)
 * - 游戏术语专项翻译
 * - 翻译质量反馈
 * - Prometheus 指标监控
 */

const crypto = require('crypto');
const { createLogger } = require('../logger');
const promClient = require('prom-client');

const logger = createLogger('realtime-translation');

// Prometheus 指标定义
const translationRequestsTotal = new promClient.Counter({
  name: 'minego_translation_requests_total',
  help: 'Total translation requests',
  labelNames: ['source_lang', 'target_lang', 'engine']
});

const translationLatency = new promClient.Histogram({
  name: 'minego_translation_latency_ms',
  help: 'Translation latency in milliseconds',
  labelNames: ['engine', 'cached'],
  buckets: [50, 100, 200, 500, 1000, 2000]
});

const translationCacheHits = new promClient.Counter({
  name: 'minego_translation_cache_hits_total',
  help: 'Translation cache hits',
  labelNames: ['hit']
});

const translationErrors = new promClient.Counter({
  name: 'minego_translation_errors_total',
  help: 'Translation errors',
  labelNames: ['engine', 'error_type']
});

const translationCharacters = new promClient.Counter({
  name: 'minego_translation_characters_total',
  help: 'Total characters translated',
  labelNames: ['source_lang', 'target_lang']
});

/**
 * 实时翻译引擎主类
 */
class RealtimeTranslationEngine {
  constructor(config = {}) {
    this.config = {
      redis: config.redis || null,
      db: config.db || null,
      cacheTTLMs: 24 * 60 * 60 * 1000, // 24小时
      maxRetries: 2,
      timeoutMs: 3000,
      enginePriority: ['local', 'google', 'deepl', 'azure'],
      ...config
    };

    // 翻译引擎实例化
    this.engines = {};
    
    if (config.google?.apiKey) {
      this.engines.google = new GoogleTranslateEngine(config.google);
    }
    
    if (config.deepl?.apiKey) {
      this.engines.deepl = new DeepLEngine(config.deepl);
    }
    
    if (config.azure?.apiKey) {
      this.engines.azure = new AzureTranslateEngine(config.azure);
    }

    // 本地术语引擎始终启用
    this.engines.local = new LocalTermEngine(this.config.db);

    logger.info('RealtimeTranslationEngine initialized', {
      engines: Object.keys(this.engines),
      cacheTTL: this.config.cacheTTLMs
    });
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
    const sourceLang = options.sourceLang || 'auto';

    try {
      // 相同语言不翻译
      if (sourceLang !== 'auto' && sourceLang === targetLang) {
        return {
          translatedText: text,
          sourceLanguage: sourceLang,
          cached: false,
          latencyMs: 0
        };
      }

      // 检测语言
      const detectedLang = sourceLang === 'auto' 
        ? await this.detectLanguage(text)
        : sourceLang;

      if (detectedLang === targetLang) {
        return {
          translatedText: text,
          sourceLanguage: detectedLang,
          cached: false,
          latencyMs: 0
        };
      }

      // 1. 检查缓存
      const cacheKey = this.getCacheKey(text, detectedLang, targetLang);
      const cached = await this.checkCache(cacheKey);
      
      if (cached) {
        const latencyMs = Date.now() - startTime;
        translationCacheHits.inc({ hit: 'true' });
        translationLatency.observe({ engine: 'cache', cached: 'true' }, latencyMs);
        
        await this.recordCacheHit(cacheKey);
        
        return {
          translatedText: cached.translated_text,
          sourceLanguage: detectedLang,
          cached: true,
          latencyMs
        };
      }

      // 2. 预处理：游戏术语识别与替换
      const { processedText, termMap } = await this.preprocessGameTerms(text, detectedLang);

      // 3. 调用翻译引擎
      let translatedText = null;
      let engineUsed = null;

      for (const engineName of this.config.enginePriority) {
        const engine = this.engines[engineName];
        if (!engine) continue;

        try {
          translatedText = await this.translateWithTimeout(
            engine,
            processedText,
            detectedLang,
            targetLang
          );
          engineUsed = engineName;
          break;
        } catch (error) {
          logger.warn({ engine: engineName, error: error.message }, 'Translation engine failed');
          translationErrors.inc({ engine: engineName, error_type: error.code || 'unknown' });
        }
      }

      if (!translatedText) {
        logger.error({ text, detectedLang, targetLang }, 'All translation engines failed');
        return {
          translatedText: text,
          sourceLanguage: detectedLang,
          cached: false,
          error: 'TRANSLATION_FAILED',
          latencyMs: Date.now() - startTime
        };
      }

      // 4. 后处理：术语还原
      translatedText = this.postprocessGameTerms(translatedText, termMap, targetLang);

      // 5. 缓存结果
      const latencyMs = Date.now() - startTime;
      await this.saveToCache(cacheKey, {
        source_text: text,
        translated_text: translatedText,
        source_language: detectedLang,
        target_language: targetLang
      });

      // 6. 记录统计
      await this.recordTranslation(detectedLang, targetLang, text.length, latencyMs, engineUsed);

      // Prometheus 指标
      translationRequestsTotal.inc({
        source_lang: detectedLang,
        target_lang: targetLang,
        engine: engineUsed
      });
      translationLatency.observe({ engine: engineUsed, cached: 'false' }, latencyMs);
      translationCharacters.inc({ source_lang: detectedLang, target_lang: targetLang }, text.length);

      return {
        translatedText,
        sourceLanguage: detectedLang,
        cached: false,
        engine: engineUsed,
        latencyMs
      };

    } catch (error) {
      logger.error({ error: error.message, text, targetLang }, 'Translation error');
      translationErrors.inc({ engine: 'unknown', error_type: error.code || 'system' });
      
      // 降级：返回原文
      return {
        translatedText: text,
        sourceLanguage: options.sourceLang || 'unknown',
        cached: false,
        error: 'SYSTEM_ERROR',
        latencyMs: Date.now() - startTime
      };
    }
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
        batch.map(msg => this.translate(msg.text, targetLang, {
          ...options,
          sourceLang: msg.sourceLang
        }))
      );
      results.push(...translations);
    }

    return results;
  }

  /**
   * 带超时的翻译
   */
  async translateWithTimeout(engine, text, sourceLang, targetLang) {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Translation timeout'));
      }, this.config.timeoutMs);

      try {
        const result = await engine.translate(text, sourceLang, targetLang);
        clearTimeout(timeout);
        resolve(result);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * 语言检测
   */
  async detectLanguage(text) {
    // 简单启发式检测（实际项目中应使用专业语言检测）
    const chineseRegex = /[\u4e00-\u9fa5]/;
    const japaneseRegex = /[\u3040-\u309f\u30a0-\u30ff]/;
    const koreanRegex = /[\uac00-\ud7af]/;
    
    if (chineseRegex.test(text)) return 'zh-CN';
    if (japaneseRegex.test(text)) return 'ja-JP';
    if (koreanRegex.test(text)) return 'ko-KR';
    
    return 'en-US';
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
    // Redis 缓存
    if (this.config.redis) {
      try {
        const cached = await this.config.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (error) {
        logger.warn({ error: error.message }, 'Redis cache check failed');
      }
    }

    // 数据库缓存
    if (this.config.db) {
      try {
        const result = await this.config.db.query(`
          SELECT translated_text, quality_score 
          FROM translation_cache 
          WHERE source_text_hash = $1 
            AND source_language = $2 
            AND target_language = $3
        `, [cacheKey.split(':')[3], cacheKey.split(':')[1], cacheKey.split(':')[2]]);

        if (result.rows.length > 0) {
          return result.rows[0];
        }
      } catch (error) {
        logger.warn({ error: error.message }, 'Database cache check failed');
      }
    }

    return null;
  }

  /**
   * 保存到缓存
   */
  async saveToCache(cacheKey, data) {
    // Redis 缓存
    if (this.config.redis) {
      try {
        await this.config.redis.setex(
          cacheKey,
          this.config.cacheTTLMs / 1000,
          JSON.stringify(data)
        );
      } catch (error) {
        logger.warn({ error: error.message }, 'Redis cache save failed');
      }
    }

    // 数据库缓存（异步）
    if (this.config.db) {
      this.config.db.query(`
        INSERT INTO translation_cache (source_text_hash, source_language, target_language, translated_text)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (source_text_hash, source_language, target_language) 
        DO UPDATE SET usage_count = translation_cache.usage_count + 1, last_used_at = NOW()
      `, [cacheKey.split(':')[3], data.source_language, data.target_language, data.translated_text])
        .catch(err => logger.error({ err }, 'Failed to save translation cache'));
    }
  }

  /**
   * 记录缓存命中
   */
  async recordCacheHit(cacheKey) {
    if (this.config.redis) {
      await this.config.redis.incr(`${cacheKey}:hits`);
    }

    if (this.config.db) {
      await this.config.db.query(`
        UPDATE translation_cache 
        SET usage_count = usage_count + 1, last_used_at = NOW()
        WHERE source_text_hash = $1
      `, [cacheKey.split(':')[3]]);
    }
  }

  /**
   * 预处理游戏术语
   */
  async preprocessGameTerms(text, sourceLang) {
    if (!this.config.db) {
      return { processedText: text, termMap: new Map() };
    }

    try {
      const result = await this.config.db.query(`
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
    } catch (error) {
      logger.warn({ error: error.message }, 'Game term preprocessing failed');
      return { processedText: text, termMap: new Map() };
    }
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
   * 记录翻译统计
   */
  async recordTranslation(sourceLang, targetLang, charCount, latencyMs, engine) {
    if (!this.config.db) return;

    const today = new Date().toISOString().split('T')[0];
    
    try {
      await this.config.db.query(`
        INSERT INTO translation_usage_stats 
          (date, source_language, target_language, message_count, character_count, avg_latency_ms, api_calls)
        VALUES ($1, $2, $3, 1, $4, $5, 1)
        ON CONFLICT (date, source_language, target_language)
        DO UPDATE SET 
          message_count = translation_usage_stats.message_count + 1,
          character_count = translation_usage_stats.character_count + $4,
          avg_latency_ms = (translation_usage_stats.avg_latency_ms + $5) / 2,
          api_calls = translation_usage_stats.api_calls + 1
      `, [today, sourceLang, targetLang, charCount, latencyMs]);
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to record translation stats');
    }
  }
}

/**
 * Google 翻译引擎适配器
 */
class GoogleTranslateEngine {
  constructor(config) {
    this.apiKey = config.apiKey;
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
    this.apiKey = config.apiKey;
    this.endpoint = config.pro 
      ? 'https://api.deepl.com/v2/translate' 
      : 'https://api-free.deepl.com/v2/translate';
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
 * Azure 翻译引擎适配器
 */
class AzureTranslateEngine {
  constructor(config) {
    this.apiKey = config.apiKey;
    this.region = config.region || 'global';
    this.endpoint = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0';
  }

  async translate(text, sourceLang, targetLang) {
    const url = `${this.endpoint}&to=${targetLang.split('-')[0]}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.apiKey,
        'Ocp-Apim-Subscription-Region': this.region,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{ text }])
    });

    if (!response.ok) {
      throw new Error(`Azure Translate API error: ${response.status}`);
    }

    const data = await response.json();
    return data[0].translations[0].text;
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
    if (!this.db) {
      return text;
    }

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