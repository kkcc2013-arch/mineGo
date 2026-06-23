// backend/shared/i18n/machineTranslation.js
// REQ-00294: 机器翻译集成服务

'use strict';

const axios = require('axios');
const { createLogger } = require('../logger');

const logger = createLogger('machine-translation');

class MachineTranslationService {
  constructor() {
    this.providers = {
      google: {
        url: 'https://translation.googleapis.com/language/translate/v2',
        apiKey: process.env.GOOGLE_TRANSLATE_API_KEY || ''
      },
      deepl: {
        url: 'https://api-free.deepl.com/v2/translate',
        apiKey: process.env.DEEPL_API_KEY || ''
      }
    };
    
    this.cache = new Map();
    this.enableCache = true;
    this.maxCacheSize = 5000;
    
    // 质量优先级：DeepL > Google
    this.providerPriority = ['deepl', 'google'];
  }

  /**
   * 翻译文本
   */
  async translate(text, sourceLocale, targetLocale, options = {}) {
    // 1. 检查缓存
    const cacheKey = `${sourceLocale}:${targetLocale}:${text}`;
    if (this.enableCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    // 2. 检查是否需要翻译（相同语言）
    if (sourceLocale === targetLocale) {
      return {
        translatedText: text,
        provider: 'none',
        confidence: 1.0
      };
    }
    
    // 3. 选择翻译提供商
    const provider = options.provider || this.selectProvider(sourceLocale, targetLocale);
    
    // 4. 调用翻译 API
    try {
      const result = await this.callProvider(provider, text, sourceLocale, targetLocale);
      
      // 5. 缓存结果
      if (this.enableCache) {
        this.cache.set(cacheKey, result);
        this.clearCacheIfNeeded();
      }
      
      logger.info({ 
        provider, 
        sourceLocale, 
        targetLocale, 
        confidence: result.confidence 
      }, 'Translation completed');
      
      return result;
    } catch (error) {
      logger.error({ 
        error: error.message, 
        provider, 
        sourceLocale, 
        targetLocale 
      }, 'Translation failed');
      
      // Fallback: 返回原文
      return {
        translatedText: text,
        provider: 'fallback',
        confidence: 0,
        error: error.message
      };
    }
  }

  /**
   * 选择最优翻译提供商
   */
  selectProvider(sourceLocale, targetLocale) {
    // DeepL 对欧洲语言质量更好
    const deeplLanguages = ['en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'pl', 'ru'];
    const sourceBase = sourceLocale.split('-')[0];
    const targetBase = targetLocale.split('-')[0];
    
    if (deeplLanguages.includes(sourceBase) && deeplLanguages.includes(targetBase)) {
      if (this.providers.deepl.apiKey) {
        return 'deepl';
      }
    }
    
    // 默认使用 Google
    if (this.providers.google.apiKey) {
      return 'google';
    }
    
    // 无可用提供商
    throw new Error('No translation provider available');
  }

  /**
   * 调用翻译提供商 API
   */
  async callProvider(provider, text, sourceLocale, targetLocale) {
    const config = this.providers[provider];
    
    if (!config.apiKey) {
      throw new Error(`API key not configured for provider: ${provider}`);
    }
    
    switch (provider) {
      case 'google':
        return this.callGoogle(config, text, sourceLocale, targetLocale);
      case 'deepl':
        return this.callDeepL(config, text, sourceLocale, targetLocale);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * 调用 Google Translate API
   */
  async callGoogle(config, text, sourceLocale, targetLocale) {
    try {
      const response = await axios.post(config.url, {
        q: text,
        source: sourceLocale.split('-')[0],
        target: targetLocale.split('-')[0],
        format: 'text'
      }, {
        params: { key: config.apiKey },
        timeout: 10000
      });
      
      return {
        translatedText: response.data.data.translations[0].translatedText,
        provider: 'google',
        confidence: 0.85,
        detectedLanguage: response.data.data.translations[0].detectedSourceLanguage
      };
    } catch (error) {
      throw new Error(`Google Translate API error: ${error.message}`);
    }
  }

  /**
   * 调用 DeepL API
   */
  async callDeepL(config, text, sourceLocale, targetLocale) {
    try {
      const response = await axios.post(config.url, null, {
        params: {
          auth_key: config.apiKey,
          text: text,
          source_lang: sourceLocale.split('-')[0].toUpperCase(),
          target_lang: targetLocale.split('-')[0].toUpperCase()
        },
        timeout: 10000
      });
      
      return {
        translatedText: response.data.translations[0].text,
        provider: 'deepl',
        confidence: 0.95,
        detectedLanguage: response.data.translations[0].detected_source_language
      };
    } catch (error) {
      throw new Error(`DeepL API error: ${error.message}`);
    }
  }

  /**
   * 批量翻译
   */
  async batchTranslate(texts, sourceLocale, targetLocale) {
    const results = [];
    const batchSize = 50; // API 批量限制
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const translations = await Promise.all(
        batch.map(text => this.translate(text, sourceLocale, targetLocale))
      );
      results.push(...translations);
    }
    
    return results;
  }

  /**
   * 翻译动态内容（活动公告等）
   */
  async translateDynamicContent(content, targetLocale, options = {}) {
    const sourceLocale = options.sourceLocale || 'en-US';
    
    // 支持不同内容类型
    if (typeof content === 'string') {
      return this.translate(content, sourceLocale, targetLocale, options);
    }
    
    if (typeof content === 'object') {
      const translated = {};
      for (const [key, value] of Object.entries(content)) {
        if (typeof value === 'string') {
          translated[key] = await this.translate(value, sourceLocale, targetLocale, options);
        } else {
          translated[key] = value;
        }
      }
      return translated;
    }
    
    return content;
  }

  /**
   * 清理缓存
   */
  clearCacheIfNeeded() {
    if (this.cache.size > this.maxCacheSize) {
      // 删除一半缓存
      const entries = Array.from(this.cache.entries());
      const toKeep = entries.slice(this.maxCacheSize / 2);
      this.cache = new Map(toKeep);
      logger.info('Translation cache cleared');
    }
  }

  /**
   * 获取提供商状态
   */
  getProviderStatus() {
    return {
      google: {
        available: !!this.providers.google.apiKey,
        url: this.providers.google.url
      },
      deepl: {
        available: !!this.providers.deepl.apiKey,
        url: this.providers.deepl.url
      }
    };
  }
}

module.exports = new MachineTranslationService();