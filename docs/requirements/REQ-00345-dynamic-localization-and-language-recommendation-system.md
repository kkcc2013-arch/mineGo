# REQ-00345: 游戏内容动态本地化与多语言智能推荐系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00345 |
| 标题 | 游戏内容动态本地化与多语言智能推荐系统 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、pokemon-service、location-service、reward-service、game-client、backend/shared/i18n |
| 创建时间 | 2026-06-27 04:00 UTC |

## 需求描述

### 背景
当前游戏本地化存在以下问题：
1. **静态翻译**：游戏文本硬编码，切换语言需要重启应用
2. **翻译质量参差**：机器翻译不准确，缺乏上下文理解
3. **文化适配不足**：日期、时间、数字格式不统一，缺少本地化习惯
4. **多语言内容管理困难**：缺乏翻译工作流和版本管理
5. **用户语言偏好分散**：无法根据用户行为智能推荐最佳语言

### 目标
实现游戏内容动态本地化与多语言智能推荐系统：
- 支持运行时语言切换，无需重启
- 提供高质量翻译管理平台
- 智能识别用户语言偏好
- 文化适配（日期、时间、货币、数字）
- 翻译工作流自动化

## 技术方案

### 1. 动态本地化引擎

**文件：** `backend/shared/i18n/LocalizationEngine.js`

```javascript
class LocalizationEngine {
  constructor(options = {}) {
    this.defaultLanguage = options.defaultLanguage || 'en';
    this.supportedLanguages = options.supportedLanguages || ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar'];
    this.fallbackChain = options.fallbackChain || {};
    this.translations = new Map(); // language -> namespace -> key -> translation
    this.pluralRules = new Map(); // language -> plural rule function
    this.formatters = new Map(); // language -> formatters
    
    this.loadTranslations();
    this.initializePluralRules();
    this.initializeFormatters();
  }

  /**
   * 加载翻译文件
   */
  async loadTranslations() {
    const translationDir = path.join(__dirname, '../../../locales');
    
    for (const lang of this.supportedLanguages) {
      const langDir = path.join(translationDir, lang);
      if (!fs.existsSync(langDir)) continue;

      const translations = new Map();
      
      // 加载所有命名空间
      const namespaces = fs.readdirSync(langDir).filter(f => f.endsWith('.json'));
      for (const nsFile of namespaces) {
        const namespace = nsFile.replace('.json', '');
        const content = JSON.parse(fs.readFileSync(path.join(langDir, nsFile), 'utf8'));
        translations.set(namespace, this.flattenObject(content));
      }

      this.translations.set(lang, translations);
    }
  }

  /**
   * 翻译文本
   */
  t(key, options = {}) {
    const {
      language = this.defaultLanguage,
      namespace = 'common',
      count,
      context,
      ...interpolationVars
    } = options;

    // 1. 获取翻译
    let translation = this.getTranslation(language, namespace, key);

    // 2. 处理复数形式
    if (count !== undefined) {
      translation = this.handlePlural(translation, language, count);
    }

    // 3. 处理上下文变体
    if (context) {
      translation = this.handleContext(translation, context);
    }

    // 4. 插值变量替换
    translation = this.interpolate(translation, interpolationVars);

    // 5. 回退机制
    if (!translation) {
      translation = this.getTranslation(this.defaultLanguage, namespace, key);
    }

    return translation || key;
  }

  /**
   * 获取翻译（支持回退链）
   */
  getTranslation(language, namespace, key) {
    const langTranslations = this.translations.get(language);
    if (!langTranslations) return null;

    const namespaceTranslations = langTranslations.get(namespace);
    if (!namespaceTranslations) return null;

    return namespaceTranslations.get(key);
  }

  /**
   * 处理复数形式
   */
  handlePlural(translation, language, count) {
    if (typeof translation === 'string') return translation;

    const pluralRule = this.pluralRules.get(language) || this.pluralRules.get('en');
    const pluralForm = pluralRule(count);

    return translation[pluralForm] || translation.other || translation;
  }

  /**
   * 处理上下文变体
   */
  handleContext(translation, context) {
    if (typeof translation === 'object' && translation[context]) {
      return translation[context];
    }
    return translation;
  }

  /**
   * 插值变量替换
   */
  interpolate(template, variables) {
    if (typeof template !== 'string') return template;

    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] !== undefined ? variables[key] : match;
    });
  }

  /**
   * 初始化复数规则
   */
  initializePluralRules() {
    // 英语复数规则
    this.pluralRules.set('en', (count) => {
      return count === 1 ? 'one' : 'other';
    });

    // 中文（无复数）
    this.pluralRules.set('zh', () => 'other');

    // 日语（无复数）
    this.pluralRules.set('ja', () => 'other');

    // 俄语（复杂复数）
    this.pluralRules.set('ru', (count) => {
      const mod10 = count % 10;
      const mod100 = count % 100;
      
      if (mod10 === 1 && mod100 !== 11) return 'one';
      if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'few';
      return 'many';
    });

    // 阿拉伯语（最复杂的复数）
    this.pluralRules.set('ar', (count) => {
      if (count === 0) return 'zero';
      if (count === 1) return 'one';
      if (count === 2) return 'two';
      if ([3, 4, 5, 6, 7, 8, 9, 10].includes(count % 100)) return 'few';
      return 'many';
    });

    // 其他语言默认规则...
  }

  /**
   * 初始化格式化器
   */
  initializeFormatters() {
    for (const lang of this.supportedLanguages) {
      const formatters = {
        number: this.createNumberFormatter(lang),
        currency: this.createCurrencyFormatter(lang),
        date: this.createDateFormatter(lang),
        time: this.createTimeFormatter(lang),
        dateTime: this.createDateTimeFormatter(lang)
      };
      
      this.formatters.set(lang, formatters);
    }
  }

  /**
   * 数字格式化
   */
  formatNumber(value, language = this.defaultLanguage, options = {}) {
    const formatter = this.formatters.get(language)?.number;
    return formatter?.format(value, options) || value.toString();
  }

  /**
   * 货币格式化
   */
  formatCurrency(value, language = this.defaultLanguage, currency = 'USD') {
    const formatter = this.formatters.get(language)?.currency;
    return formatter?.format(value, { currency }) || `$${value}`;
  }

  /**
   * 日期格式化
   */
  formatDate(date, language = this.defaultLanguage, format = 'medium') {
    const formatter = this.formatters.get(language)?.date;
    return formatter?.format(new Date(date), format) || date.toString();
  }

  /**
   * 时间格式化
   */
  formatTime(time, language = this.defaultLanguage, format = 'short') {
    const formatter = this.formatters.get(language)?.time;
    return formatter?.format(new Date(time), format) || time.toString();
  }

  /**
   * 创建数字格式化器
   */
  createNumberFormatter(language) {
    const localeMap = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-BR',
      'ru': 'ru-RU',
      'ar': 'ar-SA'
    };

    const locale = localeMap[language] || language;

    return {
      format: (value, options = {}) => {
        const formatter = new Intl.NumberFormat(locale, options);
        return formatter.format(value);
      }
    };
  }

  /**
   * 创建货币格式化器
   */
  createCurrencyFormatter(language) {
    const localeMap = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-BR',
      'ru': 'ru-RU',
      'ar': 'ar-SA'
    };

    const locale = localeMap[language] || language;

    return {
      format: (value, options = {}) => {
        const formatter = new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: options.currency || 'USD'
        });
        return formatter.format(value);
      }
    };
  }

  /**
   * 创建日期格式化器
   */
  createDateFormatter(language) {
    const localeMap = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-BR',
      'ru': 'ru-RU',
      'ar': 'ar-SA'
    };

    const locale = localeMap[language] || language;

    const formatMap = {
      short: { year: '2-digit', month: 'numeric', day: 'numeric' },
      medium: { year: 'numeric', month: 'short', day: 'numeric' },
      long: { year: 'numeric', month: 'long', day: 'numeric' },
      full: { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
    };

    return {
      format: (date, format = 'medium') => {
        const options = formatMap[format] || formatMap.medium;
        const formatter = new Intl.DateTimeFormat(locale, options);
        return formatter.format(date);
      }
    };
  }

  /**
   * 创建时间格式化器
   */
  createTimeFormatter(language) {
    const localeMap = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-BR',
      'ru': 'ru-RU',
      'ar': 'ar-SA'
    };

    const locale = localeMap[language] || language;

    const formatMap = {
      short: { hour: 'numeric', minute: '2-digit' },
      medium: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
      long: { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }
    };

    return {
      format: (time, format = 'short') => {
        const options = formatMap[format] || formatMap.short;
        const formatter = new Intl.DateTimeFormat(locale, options);
        return formatter.format(time);
      }
    };
  }

  /**
   * 创建日期时间格式化器
   */
  createDateTimeFormatter(language) {
    const localeMap = {
      'en': 'en-US',
      'zh': 'zh-CN',
      'ja': 'ja-JP',
      'ko': 'ko-KR',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'pt': 'pt-BR',
      'ru': 'ru-RU',
      'ar': 'ar-SA'
    };

    const locale = localeMap[language] || language;

    return {
      format: (dateTime, format = 'medium') => {
        const options = {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        };
        const formatter = new Intl.DateTimeFormat(locale, options);
        return formatter.format(dateTime);
      }
    };
  }

  /**
   * 扁平化对象
   */
  flattenObject(obj, prefix = '') {
    const result = new Map();

    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;

      if (typeof value === 'object' && value !== null) {
        const nested = this.flattenObject(value, newKey);
        for (const [k, v] of nested) {
          result.set(k, v);
        }
      } else {
        result.set(newKey, value);
      }
    }

    return result;
  }
}

module.exports = LocalizationEngine;
```

### 2. 用户语言偏好智能推荐

**文件：** `backend/shared/i18n/LanguageRecommender.js`

```javascript
class LanguageRecommender {
  constructor(options = {}) {
    this.supportedLanguages = options.supportedLanguages || ['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar'];
    this.languageScores = new Map(); // userId -> language -> score
    this.browserLanguageCache = new Map(); // deviceId -> language
  }

  /**
   * 推荐用户语言
   */
  async recommendLanguage(userId, context = {}) {
    const {
      deviceId,
      ipAddress,
      userAgent,
      previousLanguages,
      location
    } = context;

    const scores = {};

    // 1. 浏览器语言权重（30%）
    const browserLanguage = this.detectBrowserLanguage(userAgent);
    if (browserLanguage && this.supportedLanguages.includes(browserLanguage)) {
      scores[browserLanguage] = (scores[browserLanguage] || 0) + 0.3;
    }

    // 2. IP 地理位置权重（25%）
    const geoLanguage = await this.detectGeoLanguage(ipAddress);
    if (geoLanguage && this.supportedLanguages.includes(geoLanguage)) {
      scores[geoLanguage] = (scores[geoLanguage] || 0) + 0.25;
    }

    // 3. 用户历史语言权重（25%）
    const historyLanguage = this.analyzeHistoryLanguages(previousLanguages);
    if (historyLanguage && this.supportedLanguages.includes(historyLanguage)) {
      scores[historyLanguage] = (scores[historyLanguage] || 0) + 0.25;
    }

    // 4. 设备语言权重（15%）
    const deviceLanguage = await this.getDeviceLanguage(deviceId);
    if (deviceLanguage && this.supportedLanguages.includes(deviceLanguage)) {
      scores[deviceLanguage] = (scores[deviceLanguage] || 0) + 0.15;
    }

    // 5. 好友语言权重（5%）
    const friendsLanguage = await this.analyzeFriendsLanguages(userId);
    if (friendsLanguage && this.supportedLanguages.includes(friendsLanguage)) {
      scores[friendsLanguage] = (scores[friendsLanguage] || 0) + 0.05;
    }

    // 排序并返回推荐结果
    const recommendations = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([language, score]) => ({
        language,
        score,
        confidence: this.calculateConfidence(score)
      }));

    return {
      recommended: recommendations[0]?.language || 'en',
      alternatives: recommendations.slice(1, 4),
      allScores: recommendations
    };
  }

  /**
   * 检测浏览器语言
   */
  detectBrowserLanguage(userAgent) {
    if (!userAgent) return null;

    // 解析 Accept-Language 头
    const acceptLanguageMatch = userAgent.match(/Accept-Language:\s*([^\n]+)/i);
    if (acceptLanguageMatch) {
      const languages = acceptLanguageMatch[1]
        .split(',')
        .map(lang => {
          const [code, q = '1'] = lang.trim().split(';q=');
          return { code: code.substring(0, 2), quality: parseFloat(q) };
        })
        .sort((a, b) => b.quality - a.quality);

      return languages[0]?.code || null;
    }

    return null;
  }

  /**
   * 检测地理位置语言
   */
  async detectGeoLanguage(ipAddress) {
    if (!ipAddress) return null;

    try {
      // 使用 GeoIP 服务
      const geoInfo = await this.geoIpService.lookup(ipAddress);
      
      const countryToLanguage = {
        'CN': 'zh',
        'TW': 'zh',
        'HK': 'zh',
        'JP': 'ja',
        'KR': 'ko',
        'ES': 'es',
        'MX': 'es',
        'FR': 'fr',
        'DE': 'de',
        'BR': 'pt',
        'RU': 'ru',
        'SA': 'ar',
        'AE': 'ar',
        'EG': 'ar'
      };

      return countryToLanguage[geoInfo.country] || 'en';
    } catch (error) {
      return null;
    }
  }

  /**
   * 分析用户历史语言
   */
  analyzeHistoryLanguages(previousLanguages) {
    if (!previousLanguages || previousLanguages.length === 0) return null;

    // 统计最近使用的语言频率
    const frequency = {};
    const recentWeight = 1.5;

    previousLanguages.forEach((lang, index) => {
      const weight = index < 5 ? recentWeight : 1;
      frequency[lang] = (frequency[lang] || 0) + weight;
    });

    // 返回最常用的语言
    const sorted = Object.entries(frequency).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || null;
  }

  /**
   * 获取设备语言
   */
  async getDeviceLanguage(deviceId) {
    if (!deviceId) return null;

    // 从缓存或数据库获取
    const cached = this.browserLanguageCache.get(deviceId);
    if (cached) return cached;

    const device = await Device.findById(deviceId);
    if (device?.language && this.supportedLanguages.includes(device.language)) {
      this.browserLanguageCache.set(deviceId, device.language);
      return device.language;
    }

    return null;
  }

  /**
   * 分析好友语言偏好
   */
  async analyzeFriendsLanguages(userId) {
    try {
      const friends = await Friendship.find({
        $or: [
          { userId, status: 'accepted' },
          { friendId: userId, status: 'accepted' }
        ]
      }).populate('userId friendId');

      const languageFrequency = {};

      friends.forEach(friendship => {
        const friend = friendship.userId.toString() === userId 
          ? friendship.friendId 
          : friendship.userId;

        if (friend.language) {
          languageFrequency[friend.language] = (languageFrequency[friend.language] || 0) + 1;
        }
      });

      const sorted = Object.entries(languageFrequency).sort((a, b) => b[1] - a[1]);
      return sorted[0]?.[0] || null;

    } catch (error) {
      return null;
    }
  }

  /**
   * 计算置信度
   */
  calculateConfidence(score) {
    if (score >= 0.7) return 'high';
    if (score >= 0.4) return 'medium';
    return 'low';
  }

  /**
   * 更新用户语言偏好
   */
  async updateLanguagePreference(userId, language, context = {}) {
    const { deviceId, sessionId } = context;

    // 更新用户记录
    await User.findByIdAndUpdate(userId, {
      language,
      languageUpdatedAt: new Date()
    });

    // 更新缓存
    if (deviceId) {
      this.browserLanguageCache.set(deviceId, language);
    }

    // 记录语言变更事件
    await Analytics.track('language_changed', {
      userId,
      language,
      deviceId,
      sessionId,
      timestamp: new Date()
    });

    return { success: true, language };
  }
}

module.exports = LanguageRecommender;
```

### 3. 翻译管理平台

**文件：** `backend/shared/i18n/TranslationManager.js`

```javascript
class TranslationManager {
  constructor(options = {}) {
    this.translationProvider = options.translationProvider || 'google'; // google, deepl, manual
    this.translationQueue = [];
    this.translationCache = new Map(); // key -> translation
  }

  /**
   * 添加待翻译文本
   */
  async addTranslationRequest(request) {
    const {
      key,
      sourceLanguage,
      targetLanguages,
      context,
      namespace
    } = request;

    // 检查是否已存在
    const existing = await Translation.findOne({ key, namespace });
    if (existing) {
      return { status: 'exists', translation: existing };
    }

    // 创建翻译任务
    const translation = new Translation({
      key,
      namespace,
      sourceLanguage,
      targetLanguages,
      context,
      status: 'pending',
      createdAt: new Date()
    });

    await translation.save();

    // 加入队列
    this.translationQueue.push(translation._id);

    return { status: 'queued', translationId: translation._id };
  }

  /**
   * 执行翻译
   */
  async executeTranslation(translationId) {
    const translation = await Translation.findById(translationId);
    if (!translation) {
      throw new Error('Translation not found');
    }

    const results = {};

    for (const targetLang of translation.targetLanguages) {
      try {
        let translatedText;

        if (this.translationProvider === 'google') {
          translatedText = await this.googleTranslate(
            translation.key,
            translation.sourceLanguage,
            targetLang
          );
        } else if (this.translationProvider === 'deepl') {
          translatedText = await this.deeplTranslate(
            translation.key,
            translation.sourceLanguage,
            targetLang
          );
        }

        results[targetLang] = {
          text: translatedText,
          status: 'machine_translated',
          needsReview: true
        };

      } catch (error) {
        results[targetLang] = {
          text: null,
          status: 'error',
          error: error.message
        };
      }
    }

    // 更新翻译记录
    translation.results = results;
    translation.status = 'translated';
    translation.translatedAt = new Date();
    await translation.save();

    return results;
  }

  /**
   * Google Translate API
   */
  async googleTranslate(text, sourceLang, targetLang) {
    const response = await axios.post(
      `https://translation.googleapis.com/language/translate/v2`,
      {
        q: text,
        source: sourceLang,
        target: targetLang,
        format: 'text'
      },
      {
        params: { key: process.env.GOOGLE_TRANSLATE_API_KEY }
      }
    );

    return response.data.data.translations[0].translatedText;
  }

  /**
   * DeepL API
   */
  async deeplTranslate(text, sourceLang, targetLang) {
    const response = await axios.post(
      `https://api-free.deepl.com/v2/translate`,
      {
        text: [text],
        source_lang: sourceLang.toUpperCase(),
        target_lang: targetLang.toUpperCase()
      },
      {
        headers: {
          'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`
        }
      }
    );

    return response.data.translations[0].text;
  }

  /**
   * 提交人工翻译
   */
  async submitManualTranslation(translationId, language, translatedText, translatorId) {
    const translation = await Translation.findById(translationId);
    if (!translation) {
      throw new Error('Translation not found');
    }

    translation.results[language] = {
      text: translatedText,
      status: 'manual_translated',
      translatorId,
      translatedAt: new Date(),
      needsReview: false
    };

    await translation.save();

    return { success: true, language };
  }

  /**
   * 审核翻译
   */
  async reviewTranslation(translationId, language, approved, reviewerId, feedback) {
    const translation = await Translation.findById(translationId);
    if (!translation) {
      throw new Error('Translation not found');
    }

    translation.results[language].review = {
      approved,
      reviewerId,
      feedback,
      reviewedAt: new Date()
    };

    if (approved) {
      translation.results[language].needsReview = false;
    }

    await translation.save();

    // 如果所有翻译都审核通过，更新语言文件
    const allApproved = Object.values(translation.results).every(r => 
      r.review && r.review.approved
    );

    if (allApproved) {
      await this.updateLanguageFiles(translation);
    }

    return { success: true, allApproved };
  }

  /**
   * 更新语言文件
   */
  async updateLanguageFiles(translation) {
    for (const [lang, result] of Object.entries(translation.results)) {
      if (!result.review?.approved) continue;

      const langDir = path.join(__dirname, '../../../locales', lang);
      const filePath = path.join(langDir, `${translation.namespace}.json`);

      // 读取现有文件
      let content = {};
      if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }

      // 更新翻译
      this.setNestedValue(content, translation.key, result.text);

      // 写回文件
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
    }

    // 通知本地化引擎重新加载
    localizationEngine.loadTranslations();
  }

  /**
   * 设置嵌套对象值
   */
  setNestedValue(obj, key, value) {
    const keys = key.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }

    current[keys[keys.length - 1]] = value;
  }

  /**
   * 导出翻译文件
   */
  async exportTranslations(format = 'json') {
    const translations = await Translation.find({ status: 'translated' });
    const exportData = {};

    for (const translation of translations) {
      exportData[translation.namespace] = exportData[translation.namespace] || {};
      exportData[translation.namespace][translation.key] = {};

      for (const [lang, result] of Object.entries(translation.results)) {
        if (result.review?.approved) {
          exportData[translation.namespace][translation.key][lang] = result.text;
        }
      }
    }

    if (format === 'json') {
      return JSON.stringify(exportData, null, 2);
    } else if (format === 'csv') {
      return this.convertToCSV(exportData);
    } else if (format === 'xliff') {
      return this.convertToXLIFF(exportData);
    }

    return exportData;
  }

  /**
   * 导入翻译文件
   */
  async importTranslations(file, format = 'json') {
    let data;

    if (format === 'json') {
      data = JSON.parse(file);
    } else if (format === 'csv') {
      data = this.parseCSV(file);
    } else if (format === 'xliff') {
      data = this.parseXLIFF(file);
    }

    // 批量导入
    for (const [namespace, keys] of Object.entries(data)) {
      for (const [key, translations] of Object.entries(keys)) {
        await this.addTranslationRequest({
          key,
          namespace,
          sourceLanguage: 'en',
          targetLanguages: Object.keys(translations),
          context: ''
        });

        // 直接提交翻译
        const translation = await Translation.findOne({ key, namespace });
        for (const [lang, text] of Object.entries(translations)) {
          await this.submitManualTranslation(translation._id, lang, text, 'system');
        }
      }
    }

    return { success: true, imported: Object.keys(data).length };
  }
}

module.exports = TranslationManager;
```

### 4. API 网关集成

**文件：** `gateway/src/middleware/i18nMiddleware.js`

```javascript
const LocalizationEngine = require('../../shared/i18n/LocalizationEngine');
const LanguageRecommender = require('../../shared/i18n/LanguageRecommender');

const localizationEngine = new LocalizationEngine();
const languageRecommender = new LanguageRecommender();

/**
 * 本地化中间件
 */
async function i18nMiddleware(ctx, next) {
  const userId = ctx.state.user?.id;
  const deviceId = ctx.headers['x-device-id'];
  const acceptLanguage = ctx.headers['accept-language'];

  // 1. 确定用户语言
  let language = ctx.headers['x-language'] || ctx.query.lang;

  if (!language && userId) {
    // 从用户记录获取
    const user = await User.findById(userId);
    language = user?.language;
  }

  if (!language) {
    // 智能推荐
    const recommendation = await languageRecommender.recommendLanguage(userId, {
      deviceId,
      ipAddress: ctx.ip,
      userAgent: ctx.headers['user-agent'],
      location: ctx.state.location
    });

    language = recommendation.recommended;
  }

  // 2. 挂载到上下文
  ctx.state.language = language;
  ctx.state.i18n = localizationEngine;
  ctx.state.t = (key, options = {}) => {
    return localizationEngine.t(key, { ...options, language });
  };

  // 3. 添加格式化方法
  ctx.state.formatNumber = (value, options = {}) => {
    return localizationEngine.formatNumber(value, language, options);
  };

  ctx.state.formatCurrency = (value, currency = 'USD') => {
    return localizationEngine.formatCurrency(value, language, currency);
  };

  ctx.state.formatDate = (date, format = 'medium') => {
    return localizationEngine.formatDate(date, language, format);
  };

  ctx.state.formatTime = (time, format = 'short') => {
    return localizationEngine.formatTime(time, language, format);
  };

  // 4. 响应头设置
  ctx.set('Content-Language', language);

  await next();

  // 5. 响应本地化处理
  if (ctx.body && typeof ctx.body === 'object') {
    ctx.body = await localizeResponse(ctx.body, language);
  }
}

/**
 * 本地化响应
 */
async function localizeResponse(data, language) {
  // 递归处理对象
  if (Array.isArray(data)) {
    return data.map(item => localizeResponse(item, language));
  }

  if (typeof data === 'object' && data !== null) {
    const localized = {};

    for (const [key, value] of Object.entries(data)) {
      // 特殊字段处理
      if (key === '_i18n' && typeof value === 'object') {
        // 多语言字段
        localized[key.replace('_i18n', '')] = value[language] || value['en'] || value;
      } else if (key.endsWith('_localized')) {
        // 已本地化字段，保持不变
        localized[key] = value;
      } else {
        localized[key] = localizeResponse(value, language);
      }
    }

    return localized;
  }

  return data;
}

module.exports = i18nMiddleware;
```

### 5. 游戏客户端集成

**文件：** `game-client/src/i18n/I18nManager.js`

```javascript
class I18nManager {
  constructor() {
    this.currentLanguage = 'en';
    this.translations = new Map();
    this.formatters = new Map();
    this.fallbackLanguage = 'en';
    this.onChangeCallbacks = [];
  }

  /**
   * 初始化
   */
  async init(language = 'en') {
    this.currentLanguage = language;
    
    // 加载翻译文件
    await this.loadTranslations(language);
    
    // 加载格式化器
    this.loadFormatters(language);
  }

  /**
   * 加载翻译
   */
  async loadTranslations(language) {
    try {
      // 从 API 加载
      const response = await fetch(`/api/i18n/${language}`);
      const data = await response.json();
      
      this.translations.set(language, data);
    } catch (error) {
      console.error('Failed to load translations', error);
      
      // 回退到内置翻译
      const fallback = require(`../../locales/${language}.json`);
      this.translations.set(language, fallback);
    }
  }

  /**
   * 翻译文本
   */
  t(key, options = {}) {
    const { count, context, ...vars } = options;

    let translation = this.getTranslation(key);

    // 处理复数
    if (count !== undefined && typeof translation === 'object') {
      translation = this.handlePlural(translation, count);
    }

    // 处理上下文
    if (context && typeof translation === 'object') {
      translation = translation[context] || translation;
    }

    // 插值
    if (typeof translation === 'string') {
      translation = this.interpolate(translation, vars);
    }

    return translation || key;
  }

  /**
   * 获取翻译
   */
  getTranslation(key) {
    const translations = this.translations.get(this.currentLanguage);
    if (translations) {
      const keys = key.split('.');
      let result = translations;
      
      for (const k of keys) {
        result = result?.[k];
      }
      
      if (result) return result;
    }

    // 回退到默认语言
    const fallback = this.translations.get(this.fallbackLanguage);
    if (fallback) {
      const keys = key.split('.');
      let result = fallback;
      
      for (const k of keys) {
        result = result?.[k];
      }
      
      return result;
    }

    return null;
  }

  /**
   * 切换语言
   */
  async changeLanguage(newLanguage) {
    if (this.currentLanguage === newLanguage) return;

    const oldLanguage = this.currentLanguage;
    
    // 加载新语言
    await this.loadTranslations(newLanguage);
    this.loadFormatters(newLanguage);
    
    // 更新当前语言
    this.currentLanguage = newLanguage;

    // 通知服务器
    await fetch('/api/user/language', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: newLanguage })
    });

    // 触发回调
    this.onChangeCallbacks.forEach(callback => {
      callback(newLanguage, oldLanguage);
    });
  }

  /**
   * 注册语言变更回调
   */
  onLanguageChange(callback) {
    this.onChangeCallbacks.push(callback);
  }

  /**
   * 格式化数字
   */
  formatNumber(value, options = {}) {
    const formatter = this.formatters.get('number');
    return formatter?.format(value) || value.toString();
  }

  /**
   * 格式化货币
   */
  formatCurrency(value, currency = 'USD') {
    const formatter = this.formatters.get('currency');
    return formatter?.format(value, { currency }) || `$${value}`;
  }

  /**
   * 格式化日期
   */
  formatDate(date, format = 'medium') {
    const formatter = this.formatters.get('date');
    return formatter?.format(new Date(date), format) || date.toString();
  }

  /**
   * 加载格式化器
   */
  loadFormatters(language) {
    this.formatters.set('number', new Intl.NumberFormat(language));
    this.formatters.set('currency', new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }));
    this.formatters.set('date', new Intl.DateTimeFormat(language));
  }

  /**
   * 处理复数
   */
  handlePlural(translation, count) {
    const rules = new Intl.PluralRules(this.currentLanguage);
    const form = rules.select(count);
    
    return translation[form] || translation.other || translation;
  }

  /**
   * 插值
   */
  interpolate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return vars[key] !== undefined ? vars[key] : match;
    });
  }
}

const i18n = new I18nManager();
export default i18n;
```

### 6. 数据库模型

**文件：** `backend/models/Translation.js`

```javascript
const mongoose = require('mongoose');

const TranslationSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    index: true
  },
  namespace: {
    type: String,
    required: true,
    default: 'common'
  },
  sourceLanguage: {
    type: String,
    required: true,
    default: 'en'
  },
  targetLanguages: [{
    type: String
  }],
  context: {
    type: String
  },
  results: {
    type: Map,
    of: {
      text: String,
      status: {
        type: String,
        enum: ['pending', 'machine_translated', 'manual_translated', 'error']
      },
      translatorId: mongoose.Schema.Types.ObjectId,
      translatedAt: Date,
      needsReview: {
        type: Boolean,
        default: true
      },
      review: {
        approved: Boolean,
        reviewerId: mongoose.Schema.Types.ObjectId,
        feedback: String,
        reviewedAt: Date
      }
    }
  },
  status: {
    type: String,
    enum: ['pending', 'translated', 'approved'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// 复合索引
TranslationSchema.index({ key: 1, namespace: 1 }, { unique: true });

module.exports = mongoose.model('Translation', TranslationSchema);
```

## 验收标准

- [ ] 动态本地化引擎实现完成，支持运行时语言切换
- [ ] 用户语言偏好智能推荐系统实现完成，准确率 ≥ 80%
- [ ] 翻译管理平台实现完成，支持机器翻译和人工翻译
- [ ] API 网关集成完成，自动本地化响应
- [ ] 游戏客户端集成完成，支持实时语言切换
- [ ] 支持 10 种语言（en, zh, ja, ko, es, fr, de, pt, ru, ar）
- [ ] 复数形式支持完成（英语、俄语、阿拉伯语等复杂复数）
- [ ] 文化适配完成（日期、时间、货币、数字格式化）
- [ ] 翻译文件管理完成（导入、导出、版本管理）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 性能测试：语言切换响应时间 < 100ms
- [ ] 用户测试：语言推荐满意度 ≥ 85%

## 影响范围

- **新建文件：**
  - `backend/shared/i18n/LocalizationEngine.js`
  - `backend/shared/i18n/LanguageRecommender.js`
  - `backend/shared/i18n/TranslationManager.js`
  - `backend/models/Translation.js`
  - `gateway/src/middleware/i18nMiddleware.js`
  - `game-client/src/i18n/I18nManager.js`
  - `locales/*/`（10 种语言的翻译文件）
  - `backend/tests/unit/i18n/LocalizationEngine.test.js`
  - `backend/tests/unit/i18n/LanguageRecommender.test.js`

- **修改文件：**
  - `gateway/src/index.js`（注册 i18n 中间件）
  - `backend/shared/index.js`（导出 i18n 模块）
  - `game-client/src/index.js`（初始化 i18n）
  - `database/migrations/`（翻译表迁移）

- **依赖：**
  - `@google-cloud/translate`（Google Translate API）
  - `deepl`（DeepL API）
  - `intl`（国际化 API）

## 参考

- [ICU Message Format](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
- [i18next Framework](https://www.i18next.com/)
- [Google Cloud Translation API](https://cloud.google.com/translate)
- [DeepL API Documentation](https://www.deepl.com/docs-api)
- [Unicode CLDR](https://cldr.unicode.org/)
