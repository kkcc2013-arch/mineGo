// backend/shared/contentLocalizer.js
// Content Localization Service for REQ-00167
// Provides unified localization for game content (pokemon, moves, items, events)
'use strict';
const { createLogger } = require('./logger');
const logger = createLogger('contentLocalizer');

const { Pool } = require('pg');
const { getCached, setCached } = require('./cache');

// Supported languages
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const DEFAULT_LANGUAGE = 'zh-CN';

// Language code mapping for database columns
const LANG_COLUMN_MAP = {
  'zh-CN': { suffix: 'zh', fallback: 'zh' },
  'en-US': { suffix: 'en', fallback: 'en' },
  'ja-JP': { suffix: 'ja', fallback: 'en' } // Fallback to English if Japanese missing
};

// Cache configuration
const CACHE_TTL = 86400; // 24 hours
const CACHE_PREFIX = 'loc:';

// ── ContentLocalizer Class ─────────────────────────────────────
class ContentLocalizer {
  /**
   * @param {Pool} db - PostgreSQL connection pool
   * @param {Object} cache - Redis cache instance (optional)
   */
  constructor(db, cache = null) {
    this.db = db;
    this.cache = cache;
  }

  // ── Get Localized Field Value ───────────────────────────────
  /**
   * Get localized value for a specific field
   * @param {string} contentType - 'pokemon', 'move', 'item', 'event'
   * @param {string} contentId - Content ID
   * @param {string} fieldName - 'name', 'description'
   * @param {string} language - Target language code
   * @returns {Promise<string|null>}
   */
  async getLocalized(contentType, contentId, fieldName, language) {
    const lang = this.normalizeLanguage(language);
    
    // 1. Check cache
    if (this.cache) {
      const cacheKey = `${CACHE_PREFIX}${contentType}:${contentId}:${fieldName}:${lang}`;
      const cached = await getCached(this.cache, cacheKey);
      if (cached) return cached;
    }

    // 2. Query database
    const query = `
      SELECT translation 
      FROM content_localizations
      WHERE content_type = $1 AND content_id = $2 
        AND field_name = $3 AND language = $4
    `;
    
    try {
      const result = await this.db.query(query, [contentType, contentId, fieldName, lang]);
      
      if (result.rows.length > 0) {
        const translation = result.rows[0].translation;
        
        // Cache the result
        if (this.cache) {
          const cacheKey = `${CACHE_PREFIX}${contentType}:${contentId}:${fieldName}:${lang}`;
          await setCached(this.cache, cacheKey, translation, CACHE_TTL);
        }
        
        return translation;
      }
      
      return null;
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error fetching localization', error: error.message }, 'ContentLocalizer] Error fetching localization error');;
      return null;
    }
  }

  // ── Get Localized Pokemon ───────────────────────────────────
  /**
   * Get localized Pokemon species data
   * @param {number} speciesId - Pokemon species ID
   * @param {string} language - Target language
   * @returns {Promise<Object>}
   */
  async getLocalizedPokemon(speciesId, language) {
    const lang = this.normalizeLanguage(language);
    const langInfo = LANG_COLUMN_MAP[lang];
    
    // Query the localized view
    const query = `
      SELECT 
        id,
        name_${langInfo.suffix}${lang === 'zh-CN' ? ' as name_zh_cn' : lang === 'en-US' ? ' as name_en_us' : ' as name_ja_jp'} as name,
        description_${langInfo.suffix} as description,
        type1, type2, rarity,
        base_attack, base_defense, base_hp,
        sprite_url, sprite_shiny_url
      FROM v_pokemon_species_localized
      WHERE id = $1
    `;
    
    try {
      const result = await this.db.query(query, [speciesId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        
        // Apply fallback for missing name
        if (!row.name) {
          row.name = await this.getLocalizedWithFallback('pokemon', speciesId, 'name', lang);
        }
        
        // Add locale info
        row._locale = lang;
        
        return row;
      }
      
      return null;
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error fetching localized Pokemon', error: error.message }, 'ContentLocalizer] Error fetching localized Pokemon error');;
      return null;
    }
  }

  // ── Get Localized with Fallback ─────────────────────────────
  /**
   * Get localized content with fallback to default language
   */
  async getLocalizedWithFallback(contentType, contentId, fieldName, language) {
    const lang = this.normalizeLanguage(language);
    
    // Try primary language
    let result = await this.getLocalized(contentType, contentId, fieldName, lang);
    
    // Fallback to default language
    if (!result && lang !== DEFAULT_LANGUAGE) {
      result = await this.getLocalized(contentType, contentId, fieldName, DEFAULT_LANGUAGE);
    }
    
    // Fallback to English
    if (!result && lang !== 'en-US') {
      result = await this.getLocalized(contentType, contentId, fieldName, 'en-US');
    }
    
    return result;
  }

  // ── Batch Localize Pokemon List ─────────────────────────────
  /**
   * Localize a list of Pokemon species efficiently
   * @param {Array<number>} speciesIds - Array of species IDs
   * @param {string} language - Target language
   * @returns {Promise<Map<number, Object>>}
   */
  async batchLocalizePokemon(speciesIds, language) {
    if (!speciesIds || speciesIds.length === 0) {
      return new Map();
    }

    const lang = this.normalizeLanguage(language);
    const langInfo = LANG_COLUMN_MAP[lang];
    
    // Single query for all species
    const query = `
      SELECT 
        id,
        name_${langInfo.suffix} as name,
        description_${langInfo.suffix} as description,
        type1, type2, rarity,
        sprite_url
      FROM v_pokemon_species_localized
      WHERE id = ANY($1)
    `;
    
    try {
      const result = await this.db.query(query, [speciesIds]);
      const map = new Map();
      
      for (const row of result.rows) {
        row._locale = lang;
        map.set(row.id, row);
      }
      
      return map;
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error batch localizing Pokemon', error: error.message }, 'ContentLocalizer] Error batch localizing Pokemon error');;
      return new Map();
    }
  }

  // ── Get Localized Item ──────────────────────────────────────
  /**
   * Get localized item data
   * @param {string} itemId - Item ID
   * @param {string} language - Target language
   * @returns {Promise<Object>}
   */
  async getLocalizedItem(itemId, language) {
    const lang = this.normalizeLanguage(language);
    const langInfo = LANG_COLUMN_MAP[lang];
    
    const query = `
      SELECT 
        id,
        name_${langInfo.suffix} as name,
        description_${langInfo.suffix} as description,
        category, effect_type, effect_value,
        shop_price, is_premium, sprite_url
      FROM items
      WHERE id = $1
    `;
    
    try {
      const result = await this.db.query(query, [itemId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        row._locale = lang;
        return row;
      }
      
      return null;
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error fetching localized item', error: error.message }, 'ContentLocalizer] Error fetching localized item error');;
      return null;
    }
  }

  // ── Get Localized Move ──────────────────────────────────────
  /**
   * Get localized move data
   * @param {string} moveId - Move ID
   * @param {string} language - Target language
   * @returns {Promise<Object>}
   */
  async getLocalizedMove(moveId, language) {
    const lang = this.normalizeLanguage(language);
    const langInfo = LANG_COLUMN_MAP[lang];
    
    const query = `
      SELECT 
        id,
        name_${langInfo.suffix} as name,
        description_${langInfo.suffix} as description,
        move_type, category, power,
        energy_cost, energy_gain,
        cooldown_ms, accuracy
      FROM pokemon_moves
      WHERE id = $1
    `;
    
    try {
      const result = await this.db.query(query, [moveId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        row._locale = lang;
        return row;
      }
      
      return null;
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error fetching localized move', error: error.message }, 'ContentLocalizer] Error fetching localized move error');;
      return null;
    }
  }

  // ── Set Localization ────────────────────────────────────────
  /**
   * Set or update a localization
   * @param {string} contentType - Content type
   * @param {string} contentId - Content ID
   * @param {string} fieldName - Field name
   * @param {string} language - Language code
   * @param {string} translation - Translation text
   * @returns {Promise<boolean>}
   */
  async setLocalization(contentType, contentId, fieldName, language, translation) {
    const lang = this.normalizeLanguage(language);
    
    const query = `
      INSERT INTO content_localizations (content_type, content_id, field_name, language, translation)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (content_type, content_id, field_name, language)
      DO UPDATE SET translation = $5, updated_at = NOW()
    `;
    
    try {
      await this.db.query(query, [contentType, contentId, fieldName, lang, translation]);
      
      // Invalidate cache
      if (this.cache) {
        const cacheKey = `${CACHE_PREFIX}${contentType}:${contentId}:${fieldName}:${lang}`;
        await this.cache.del(cacheKey);
      }
      
      return true;
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error setting localization', error: error.message }, 'ContentLocalizer] Error setting localization error');;
      return false;
    }
  }

  // ── Normalize Language Code ────────────────────────────────
  normalizeLanguage(language) {
    if (!language) return DEFAULT_LANGUAGE;
    
    // Normalize language code
    const normalized = language.toUpperCase();
    
    // Handle common variants
    if (normalized.startsWith('ZH')) return 'zh-CN';
    if (normalized.startsWith('EN')) return 'en-US';
    if (normalized.startsWith('JA')) return 'ja-JP';
    
    // Return as-is if supported
    if (SUPPORTED_LANGUAGES.includes(language)) {
      return language;
    }
    
    return DEFAULT_LANGUAGE;
  }

  // ── Get Supported Languages ─────────────────────────────────
  getSupportedLanguages() {
    return [...SUPPORTED_LANGUAGES];
  }

  // ── Invalidate Cache for Content ────────────────────────────
  /**
   * Invalidate all cached localizations for a content item
   */
  async invalidateCache(contentType, contentId) {
    if (!this.cache) return;
    
    const pattern = `${CACHE_PREFIX}${contentType}:${contentId}:*`;
    
    try {
      // Scan and delete matching keys
      const keys = await this.scanKeys(pattern);
      if (keys.length > 0) {
        await this.cache.del(keys);
      }
    } catch (error) {
      logger.error({ module: 'ContentLocalizer] Error invalidating cache', error: error.message }, 'ContentLocalizer] Error invalidating cache error');;
    }
  }

  // ── Scan Keys Helper ────────────────────────────────────────
  async scanKeys(pattern) {
    if (!this.cache || typeof this.cache.scan !== 'function') {
      return [];
    }
    
    const keys = [];
    let cursor = '0';
    
    do {
      const result = await this.cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    
    return keys;
  }
}

// ── Factory Function ───────────────────────────────────────────
function createContentLocalizer(db, cache = null) {
  return new ContentLocalizer(db, cache);
}

// ── Helper: Add Localized Response Middleware ──────────────────
function localizedResponseMiddleware(localizer) {
  return async (req, res, next) => {
    // Get language from request
    const language = req.language || req.headers['x-language'] || DEFAULT_LANGUAGE;
    
    // Attach localizer to request
    req.localizer = localizer;
    req.contentLang = language;
    
    // Helper function for response
    res.localized = async (contentType, contentId) => {
      return localizer.getLocalized(contentType, contentId, 'name', language);
    };
    
    next();
  };
}

// ── Export ────────────────────────────────────────────────────
module.exports = {
  ContentLocalizer,
  createContentLocalizer,
  localizedResponseMiddleware,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE
};
