// backend/shared/i18n/localeMiddleware.js
// REQ-00294: 动态语言切换中间件

'use strict';

const Redis = require('ioredis');
const { createLogger } = require('../logger');
const TranslationCache = require('./translationCache');
const RegionalAdapter = require('./regionalAdapter');

const logger = createLogger('locale-middleware');

const SUPPORTED_LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja-JP'];
const DEFAULT_LOCALE = 'en-US';

class LocaleMiddleware {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.translationCache = new TranslationCache();
    this.regionalAdapter = new RegionalAdapter();
  }

  /**
   * 主中间件函数
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // 1. 检测用户语言偏好
        const locale = await this.detectLocale(req);
        
        // 2. 设置请求语言上下文
        req.locale = locale;
        req.t = (key, params = {}) => this.translate(key, locale, params);
        req.regional = this.regionalAdapter.getAdapter(locale);
        
        // 3. 设置响应头
        res.setHeader('Content-Language', locale);
        res.setHeader('X-Supported-Locales', SUPPORTED_LOCALES.join(','));
        
        // 4. 处理语言切换请求
        if (req.path === '/api/v1/user/locale' && req.method === 'PUT') {
          await this.handleLocaleChange(req, res);
          return;
        }
        
        // 5. 注入区域化适配器
        res.formatDateTime = (date, options = {}) => 
          this.regionalAdapter.formatDateTime(date, locale, options);
        res.formatNumber = (number, options = {}) => 
          this.regionalAdapter.formatNumber(number, locale, options);
        res.formatCurrency = (amount, options = {}) => 
          this.regionalAdapter.formatCurrency(amount, locale, options);
        
        next();
      } catch (err) {
        logger.error({ err }, 'Locale middleware error');
        req.locale = DEFAULT_LOCALE;
        req.t = (key) => key;
        next();
      }
    };
  }

  /**
   * 检测用户语言偏好
   * 优先级：查询参数 > Accept-Language Header > 用户设置 > IP 地区 > 默认
   */
  async detectLocale(req) {
    // 1. 查询参数（最高优先级，用于测试）
    if (req.query.locale && this.isValidLocale(req.query.locale)) {
      return req.query.locale;
    }
    
    // 2. Accept-Language Header
    const headerLocale = this.parseAcceptLanguage(req.headers['accept-language']);
    if (headerLocale && this.isValidLocale(headerLocale)) {
      return headerLocale;
    }
    
    // 3. 自定义 Header
    if (req.headers['x-locale'] && this.isValidLocale(req.headers['x-locale'])) {
      return req.headers['x-locale'];
    }
    
    // 4. 用户设置（需登录）
    if (req.user?.id) {
      const userLocale = await this.getUserLocale(req.user.id);
      if (userLocale && this.isValidLocale(userLocale)) {
        return userLocale;
      }
    }
    
    // 5. IP 地区检测
    const ipLocale = await this.detectLocaleByIP(req.ip || req.connection?.remoteAddress);
    if (ipLocale && this.isValidLocale(ipLocale)) {
      return ipLocale;
    }
    
    // 6. 默认语言
    return DEFAULT_LOCALE;
  }

  /**
   * 解析 Accept-Language Header
   */
  parseAcceptLanguage(header) {
    if (!header) return null;
    
    // 解析 Accept-Language: "en-US,en;q=0.9,zh-CN;q=0.8"
    const languages = header.split(',').map(lang => {
      const [code, qStr] = lang.trim().split(';');
      const q = qStr ? parseFloat(qStr.split('=')[1]) : 1;
      return { code: code.trim(), q };
    }).sort((a, b) => b.q - a.q);
    
    for (const lang of languages) {
      // 精确匹配
      if (SUPPORTED_LOCALES.includes(lang.code)) {
        return lang.code;
      }
      
      // 部分匹配
      const base = lang.code.split('-')[0];
      if (base === 'zh') return 'zh-CN';
      if (base === 'en') return 'en-US';
      if (base === 'ja') return 'ja-JP';
    }
    
    return null;
  }

  /**
   * 获取用户语言偏好
   */
  async getUserLocale(userId) {
    try {
      const locale = await this.redis.get(`user:${userId}:locale`);
      return locale;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to get user locale');
      return null;
    }
  }

  /**
   * 设置用户语言偏好
   */
  async setUserLocale(userId, locale) {
    try {
      await this.redis.set(`user:${userId}:locale`, locale);
      logger.info({ userId, locale }, 'User locale updated');
    } catch (err) {
      logger.error({ err, userId, locale }, 'Failed to set user locale');
      throw err;
    }
  }

  /**
   * 通过 IP 检测地区
   */
  async detectLocaleByIP(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1') {
      return null;
    }
    
    try {
      // 简化实现：基于 IP 段判断
      // 实际应集成 GeoIP 服务
      const ipToLocale = {
        'CN': 'zh-CN',
        'TW': 'zh-TW',
        'US': 'en-US',
        'GB': 'en-GB',
        'JP': 'ja-JP'
      };
      
      // 这里应该调用 GeoIP 服务
      // 暂时返回 null
      return null;
    } catch (err) {
      logger.error({ err, ip }, 'Failed to detect locale by IP');
      return null;
    }
  }

  /**
   * 处理语言切换请求
   */
  async handleLocaleChange(req, res) {
    const { locale } = req.body;
    
    // 验证语言代码
    if (!this.isValidLocale(locale)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LOCALE',
          message: `Invalid locale: ${locale}`,
          supportedLocales: SUPPORTED_LOCALES
        }
      });
    }
    
    // 更新用户语言偏好
    if (req.user?.id) {
      await this.setUserLocale(req.user.id, locale);
    }
    
    // 返回新的翻译数据
    const translations = await this.translationCache.loadTranslations(locale);
    
    res.json({
      success: true,
      locale,
      translations: translations.data,
      cacheKey: `${locale}:${translations.version}`
    });
  }

  /**
   * 翻译函数
   */
  async translate(key, locale, params = {}) {
    const translation = await this.translationCache.get(key, locale);
    
    if (!translation) {
      return key;
    }
    
    // 替换参数
    let result = translation;
    for (const [param, value] of Object.entries(params)) {
      result = result.replace(new RegExp(`{${param}}`, 'g'), value);
    }
    
    return result;
  }

  /**
   * 验证语言代码
   */
  isValidLocale(locale) {
    return SUPPORTED_LOCALES.includes(locale);
  }
}

// 导出单例
const localeMiddleware = new LocaleMiddleware();

module.exports = {
  localeMiddleware: localeMiddleware.middleware(),
  LocaleMiddleware,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE
};
