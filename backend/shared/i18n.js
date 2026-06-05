// backend/shared/i18n.js
// Server-side internationalization middleware and utilities
'use strict';

const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const DEFAULT_LANGUAGE = 'zh-CN';

// ── Error message translations ─────────────────────────────────
const errorMessages = {
  'zh-CN': {
    // Auth errors
    'AUTH_TOKEN_EXPIRED': '登录已过期，请重新登录',
    'AUTH_TOKEN_INVALID': '无效的认证令牌',
    'AUTH_UNAUTHORIZED': '未授权访问',
    'AUTH_FORBIDDEN': '没有权限执行此操作',
    
    // Catch errors
    'CATCH_OUT_OF_RANGE': '距离精灵太远，请靠近后再试',
    'CATCH_NOT_FOUND': '精灵不存在或已消失',
    'CATCH_ALREADY_CAUGHT': '该精灵已被捕获',
    'CATCH_NO_POKEBALLS': '没有精灵球了',
    
    // Gym errors
    'GYM_COOLDOWN': '道馆冷却中，请稍后再试',
    'GYM_NOT_FOUND': '道馆不存在',
    'GYM_TEAM_MISMATCH': '队伍不匹配',
    'GYM_FULL': '道馆已满',
    
    // Pokestop errors
    'POKESTOP_OUT_OF_RANGE': '距离补给站太远，请靠近后再试',
    'POKESTOP_COOLDOWN': '补给站冷却中，请稍后再试',
    'POKESTOP_NOT_FOUND': '补给站不存在',
    
    // Generic errors
    'RATE_LIMIT_EXCEEDED': '请求太频繁，请稍后再试',
    'VALIDATION_ERROR': '请求参数无效',
    'NOT_FOUND': '资源不存在',
    'INTERNAL_ERROR': '服务器内部错误',
    'NETWORK_ERROR': '网络连接失败',
    'INVALID_REQUEST': '无效请求',
    'INSUFFICIENT_RESOURCES': '资源不足',
    'ALREADY_EXISTS': '已存在',
    
    // GPS/Anti-cheat
    'GPS_INVALID': 'GPS位置信息无效',
    'GPS_SPEED_ANOMALY': '移动速度异常，请正常移动',
    'GPS_TELEPORT_DETECTED': '检测到瞬移行为',
    'GPS_SPOOFING_DETECTED': '检测到GPS伪造'
  },
  'en-US': {
    // Auth errors
    'AUTH_TOKEN_EXPIRED': 'Session expired, please login again',
    'AUTH_TOKEN_INVALID': 'Invalid authentication token',
    'AUTH_UNAUTHORIZED': 'Unauthorized access',
    'AUTH_FORBIDDEN': 'No permission to perform this action',
    
    // Catch errors
    'CATCH_OUT_OF_RANGE': 'Too far from Pokémon, please get closer',
    'CATCH_NOT_FOUND': 'Pokémon not found or has disappeared',
    'CATCH_ALREADY_CAUGHT': 'This Pokémon has already been caught',
    'CATCH_NO_POKEBALLS': 'No Pokéballs left',
    
    // Gym errors
    'GYM_COOLDOWN': 'Gym is cooling down, please try again later',
    'GYM_NOT_FOUND': 'Gym not found',
    'GYM_TEAM_MISMATCH': 'Team mismatch',
    'GYM_FULL': 'Gym is full',
    
    // Pokestop errors
    'POKESTOP_OUT_OF_RANGE': 'Too far from Pokéstop, please get closer',
    'POKESTOP_COOLDOWN': 'Pokéstop is cooling down, please try again later',
    'POKESTOP_NOT_FOUND': 'Pokéstop not found',
    
    // Generic errors
    'RATE_LIMIT_EXCEEDED': 'Too many requests, please wait',
    'VALIDATION_ERROR': 'Invalid request parameters',
    'NOT_FOUND': 'Resource not found',
    'INTERNAL_ERROR': 'Internal server error',
    'NETWORK_ERROR': 'Network connection failed',
    'INVALID_REQUEST': 'Invalid request',
    'INSUFFICIENT_RESOURCES': 'Insufficient resources',
    'ALREADY_EXISTS': 'Already exists',
    
    // GPS/Anti-cheat
    'GPS_INVALID': 'Invalid GPS location',
    'GPS_SPEED_ANOMALY': 'Speed anomaly detected, please move normally',
    'GPS_TELEPORT_DETECTED': 'Teleport detected',
    'GPS_SPOOFING_DETECTED': 'GPS spoofing detected'
  },
  'ja-JP': {
    // Auth errors
    'AUTH_TOKEN_EXPIRED': 'ログインの有効期限が切れました',
    'AUTH_TOKEN_INVALID': '無効な認証トークン',
    'AUTH_UNAUTHORIZED': '認証されていません',
    'AUTH_FORBIDDEN': 'この操作の権限がありません',
    
    // Catch errors
    'CATCH_OUT_OF_RANGE': 'ポケモンから遠すぎます、近づいてください',
    'CATCH_NOT_FOUND': 'ポケモンが見つからないか消えました',
    'CATCH_ALREADY_CAUGHT': 'このポケモンは既に捕獲されています',
    'CATCH_NO_POKEBALLS': 'モンスターボールがありません',
    
    // Gym errors
    'GYM_COOLDOWN': 'ジムはクールダウン中、後でお試しください',
    'GYM_NOT_FOUND': 'ジムが見つかりません',
    'GYM_TEAM_MISMATCH': 'チームが一致しません',
    'GYM_FULL': 'ジムがいっぱいです',
    
    // Pokestop errors
    'POKESTOP_OUT_OF_RANGE': 'ポケストップから遠すぎます、近づいてください',
    'POKESTOP_COOLDOWN': 'ポケストップはクールダウン中',
    'POKESTOP_NOT_FOUND': 'ポケストップが見つかりません',
    
    // Generic errors
    'RATE_LIMIT_EXCEEDED': 'リクエストが多すぎます',
    'VALIDATION_ERROR': 'リクエストパラメータが無効です',
    'NOT_FOUND': 'リソースが見つかりません',
    'INTERNAL_ERROR': 'サーバー内部エラー',
    'NETWORK_ERROR': 'ネットワーク接続エラー',
    'INVALID_REQUEST': '無効なリクエスト',
    'INSUFFICIENT_RESOURCES': 'リソース不足',
    'ALREADY_EXISTS': '既に存在します',
    
    // GPS/Anti-cheat
    'GPS_INVALID': 'GPS位置情報が無効です',
    'GPS_SPEED_ANOMALY': '速度異常が検出されました',
    'GPS_TELEPORT_DETECTED': 'テレポートが検出されました',
    'GPS_SPOOFING_DETECTED': 'GPS偽装が検出されました'
  }
};

// ── Parse accept-language header ──────────────────────────────
function parseAcceptLanguage(header) {
  if (!header) return DEFAULT_LANGUAGE;
  
  // Parse Accept-Language header (e.g., "en-US,en;q=0.9,zh-CN;q=0.8")
  const languages = header.split(',').map(lang => {
    const [code, qStr] = lang.trim().split(';');
    const q = qStr ? parseFloat(qStr.split('=')[1]) : 1;
    return { code: code.trim(), q };
  }).sort((a, b) => b.q - a.q);
  
  for (const lang of languages) {
    // Exact match
    if (SUPPORTED_LANGUAGES.includes(lang.code)) {
      return lang.code;
    }
    // Partial match
    const base = lang.code.split('-')[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en') return 'en-US';
    if (base === 'ja') return 'ja-JP';
  }
  
  return DEFAULT_LANGUAGE;
}

// ── Get language from request ─────────────────────────────────
function getLanguageFromRequest(req) {
  // Priority: user preference > header > default
  if (req.user?.language_preference && SUPPORTED_LANGUAGES.includes(req.user.language_preference)) {
    return req.user.language_preference;
  }
  
  if (req.headers['accept-language']) {
    return parseAcceptLanguage(req.headers['accept-language']);
  }
  
  if (req.headers['x-language'] && SUPPORTED_LANGUAGES.includes(req.headers['x-language'])) {
    return req.headers['x-language'];
  }
  
  return DEFAULT_LANGUAGE;
}

// ── Translation function ──────────────────────────────────────
function translate(key, lang = DEFAULT_LANGUAGE) {
  const messages = errorMessages[lang] || errorMessages[DEFAULT_LANGUAGE];
  return messages[key] || errorMessages[DEFAULT_LANGUAGE][key] || key;
}

// ── i18n Middleware ────────────────────────────────────────────
function i18nMiddleware(req, res, next) {
  const lang = getLanguageFromRequest(req);
  
  // Attach translation function to request
  req.t = (key) => translate(key, lang);
  req.language = lang;
  
  // Override res.json to auto-translate error responses
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // Auto-translate if it's an error response with a code
    if (data && !data.success && data.error?.code && !data.error._translated) {
      data.error.message = translate(data.error.code, lang);
      data.error._translated = true;
    }
    return originalJson(data);
  };
  
  next();
}

// ── Create i18n error response ─────────────────────────────────
function createI18nError(code, details = {}) {
  return {
    success: false,
    error: {
      code,
      message: null, // Will be filled by middleware
      ...details
    }
  };
}

// ── Validate language code ─────────────────────────────────────
function isValidLanguage(lang) {
  return SUPPORTED_LANGUAGES.includes(lang);
}

// ── Export ────────────────────────────────────────────────────
module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  i18nMiddleware,
  translate,
  getLanguageFromRequest,
  parseAcceptLanguage,
  createI18nError,
  isValidLanguage,
  errorMessages
};
