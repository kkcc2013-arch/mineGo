// frontend/game-client/src/i18n/index.js
// i18n (internationalization) module for multi-language support
'use strict';

const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const DEFAULT_LANGUAGE = 'zh-CN';
const STORAGE_KEY = 'pmg_language';

// Translation resources (loaded from locale files)
let translations = {};
let currentLanguage = DEFAULT_LANGUAGE;

// ── Load locale files ─────────────────────────────────────────
async function loadTranslations() {
  const locales = ['zh-CN', 'en-US', 'ja-JP'];
  for (const locale of locales) {
    try {
      const response = await fetch(`/i18n/locales/${locale}.json`);
      if (response.ok) {
        translations[locale] = await response.json();
      }
    } catch (err) {
      console.warn(`[i18n] Failed to load ${locale}:`, err);
    }
  }
  
  // Fallback: embed minimal translations if fetch failed
  if (Object.keys(translations).length === 0) {
    translations = getEmbeddedTranslations();
  }
}

function getEmbeddedTranslations() {
  return {
    'zh-CN': {
      common: {
        confirm: '确认',
        cancel: '取消',
        loading: '加载中...',
        retry: '重试',
        close: '关闭',
        save: '保存',
        back: '返回',
        settings: '设置',
        logout: '退出登录',
        login: '登录',
        register: '注册'
      },
      game: {
        catch: {
          success: '捕捉成功！',
          failed: '捕捉失败，精灵逃跑了',
          throw: '投掷精灵球',
          escaped: '精灵逃脱了！'
        },
        gym: {
          battle: '挑战道馆',
          defeat: '击败道馆',
          reward: '获得奖励',
          cooldown: '道馆冷却中'
        },
        pokestop: {
          spin: '旋转补给站',
          tooFar: '请靠近补给站再旋转',
          items: '获得道具'
        },
        pokemon: {
          nearby: '附近精灵',
          wild: '野生精灵',
          caught: '已捕获'
        }
      },
      error: {
        network: '网络连接失败',
        auth: '登录已过期，请重新登录',
        permission: '没有权限执行此操作',
        rateLimit: '请求太频繁，请稍后再试',
        unknown: '发生未知错误',
        gps: 'GPS定位失败',
        speedWarning: '移动速度过快，游戏功能已暂时限制'
      },
      login: {
        title: '口袋精灵 Go',
        subtitle: '开启你的冒险之旅',
        phone: '手机号',
        smsCode: '验证码',
        sendSms: '发送验证码',
        nickname: '昵称',
        loginBtn: '登录',
        registerBtn: '注册',
        smsSent: '验证码已发送',
        invalidPhone: '请输入正确的手机号'
      },
      map: {
        title: '地图',
        refresh: '刷新',
        noPokemon: '附近没有精灵',
        noPokestops: '附近没有补给站',
        noGyms: '附近没有道馆'
      },
      settings: {
        title: '设置',
        language: '语言',
        languageDesc: '选择界面语言',
        notifications: '通知',
        sound: '音效',
        about: '关于'
      },
      language: {
        title: '语言设置',
        zhCN: '简体中文',
        enUS: 'English',
        jaJP: '日本語',
        auto: '自动检测'
      }
    },
    'en-US': {
      common: {
        confirm: 'Confirm',
        cancel: 'Cancel',
        loading: 'Loading...',
        retry: 'Retry',
        close: 'Close',
        save: 'Save',
        back: 'Back',
        settings: 'Settings',
        logout: 'Logout',
        login: 'Login',
        register: 'Register'
      },
      game: {
        catch: {
          success: 'Caught successfully!',
          failed: 'Catch failed, Pokémon fled',
          throw: 'Throw Pokéball',
          escaped: 'Pokémon escaped!'
        },
        gym: {
          battle: 'Challenge Gym',
          defeat: 'Defeat Gym',
          reward: 'Reward',
          cooldown: 'Gym is cooling down'
        },
        pokestop: {
          spin: 'Spin Pokéstop',
          tooFar: 'Get closer to spin',
          items: 'Items obtained'
        },
        pokemon: {
          nearby: 'Nearby Pokémon',
          wild: 'Wild Pokémon',
          caught: 'Caught'
        }
      },
      error: {
        network: 'Network connection failed',
        auth: 'Session expired, please login again',
        permission: 'No permission to perform this action',
        rateLimit: 'Too many requests, please wait',
        unknown: 'An unknown error occurred',
        gps: 'GPS location failed',
        speedWarning: 'Moving too fast, features temporarily limited'
      },
      login: {
        title: 'Pocket Monster Go',
        subtitle: 'Start your adventure',
        phone: 'Phone',
        smsCode: 'Code',
        sendSms: 'Send Code',
        nickname: 'Nickname',
        loginBtn: 'Login',
        registerBtn: 'Register',
        smsSent: 'Code sent',
        invalidPhone: 'Please enter a valid phone number'
      },
      map: {
        title: 'Map',
        refresh: 'Refresh',
        noPokemon: 'No Pokémon nearby',
        noPokestops: 'No Pokéstops nearby',
        noGyms: 'No Gyms nearby'
      },
      settings: {
        title: 'Settings',
        language: 'Language',
        languageDesc: 'Select interface language',
        notifications: 'Notifications',
        sound: 'Sound',
        about: 'About'
      },
      language: {
        title: 'Language Settings',
        zhCN: '简体中文',
        enUS: 'English',
        jaJP: '日本語',
        auto: 'Auto Detect'
      }
    },
    'ja-JP': {
      common: {
        confirm: '確認',
        cancel: 'キャンセル',
        loading: '読み込み中...',
        retry: '再試行',
        close: '閉じる',
        save: '保存',
        back: '戻る',
        settings: '設定',
        logout: 'ログアウト',
        login: 'ログイン',
        register: '登録'
      },
      game: {
        catch: {
          success: '捕獲成功！',
          failed: '捕獲失敗、ポケモンが逃げた',
          throw: 'モンスターボールを投げる',
          escaped: 'ポケモンが逃げた！'
        },
        gym: {
          battle: 'ジムバトル',
          defeat: 'ジム攻略',
          reward: '報酬',
          cooldown: 'ジムはクールダウン中'
        },
        pokestop: {
          spin: 'ポケストップを回す',
          tooFar: '近づいてから回してください',
          items: 'アイテム獲得'
        },
        pokemon: {
          nearby: '近くのポケモン',
          wild: '野生ポケモン',
          caught: '捕獲済み'
        }
      },
      error: {
        network: 'ネットワーク接続エラー',
        auth: 'ログイン期限切れ、再度ログインしてください',
        permission: 'この操作の権限がありません',
        rateLimit: 'リクエストが多すぎます',
        unknown: '不明なエラーが発生しました',
        gps: 'GPS位置情報エラー',
        speedWarning: '移動速度が速すぎます、機能が一時制限されています'
      },
      login: {
        title: 'ポケットモンスター Go',
        subtitle: '冒険の旅へ',
        phone: '電話番号',
        smsCode: '認証コード',
        sendSms: 'コード送信',
        nickname: 'ニックネーム',
        loginBtn: 'ログイン',
        registerBtn: '登録',
        smsSent: 'コードを送信しました',
        invalidPhone: '正しい電話番号を入力してください'
      },
      map: {
        title: 'マップ',
        refresh: '更新',
        noPokemon: '近くにポケモンがいません',
        noPokestops: '近くにポケストップがありません',
        noGyms: '近くにジムがありません'
      },
      settings: {
        title: '設定',
        language: '言語',
        languageDesc: 'インターフェース言語を選択',
        notifications: '通知',
        sound: 'サウンド',
        about: 'について'
      },
      language: {
        title: '言語設定',
        zhCN: '简体中文',
        enUS: 'English',
        jaJP: '日本語',
        auto: '自動検出'
      }
    }
  };
}

// ── Language detection ───────────────────────────────────────
function detectLanguage() {
  // 1. Check localStorage
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
    return stored;
  }
  
  // 2. Check navigator language
  const browserLang = navigator.language || navigator.userLanguage;
  if (browserLang) {
    // Exact match
    if (SUPPORTED_LANGUAGES.includes(browserLang)) {
      return browserLang;
    }
    // Partial match (e.g., 'zh' -> 'zh-CN', 'en' -> 'en-US')
    const baseLang = browserLang.split('-')[0];
    if (baseLang === 'zh') return 'zh-CN';
    if (baseLang === 'en') return 'en-US';
    if (baseLang === 'ja') return 'ja-JP';
  }
  
  // 3. Check HTML lang attribute
  const htmlLang = document.documentElement.lang;
  if (htmlLang && SUPPORTED_LANGUAGES.includes(htmlLang)) {
    return htmlLang;
  }
  
  return DEFAULT_LANGUAGE;
}

// ── Translation function ──────────────────────────────────────
function t(key, params = {}) {
  const keys = key.split('.');
  let value = translations[currentLanguage];
  
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      // Fallback to default language
      value = translations[DEFAULT_LANGUAGE];
      for (const k2 of keys) {
        if (value && typeof value === 'object' && k2 in value) {
          value = value[k2];
        } else {
          console.warn(`[i18n] Missing translation: ${key}`);
          return key; // Return key if not found
        }
      }
      break;
    }
  }
  
  if (typeof value !== 'string') {
    return key;
  }
  
  // Interpolate parameters
  return value.replace(/\{\{(\w+)\}\}/g, (_, paramKey) => {
    return params[paramKey] !== undefined ? params[paramKey] : `{{${paramKey}}}`;
  });
}

// ── Change language ───────────────────────────────────────────
async function changeLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    console.warn(`[i18n] Unsupported language: ${lang}`);
    return false;
  }
  
  currentLanguage = lang;
  localStorage.setItem(STORAGE_KEY, lang);
  
  // Update HTML lang attribute
  document.documentElement.lang = lang;
  
  // Sync to server if logged in
  const token = localStorage.getItem('pmg_access_token');
  if (token) {
    try {
      await fetch('/api/users/language', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ language: lang })
      });
    } catch (err) {
      console.warn('[i18n] Failed to sync language preference:', err);
    }
  }
  
  // Dispatch event for UI update
  window.dispatchEvent(new CustomEvent('i18n:languageChanged', { detail: { language: lang } }));
  
  return true;
}

// ── Get current language ──────────────────────────────────────
function getLanguage() {
  return currentLanguage;
}

// ── Get supported languages ───────────────────────────────────
function getSupportedLanguages() {
  return [
    { code: 'zh-CN', name: '简体中文', flag: '🇨🇳' },
    { code: 'en-US', name: 'English', flag: '🇺🇸' },
    { code: 'ja-JP', name: '日本語', flag: '🇯🇵' }
  ];
}

// ── Initialize ────────────────────────────────────────────────
async function init(userLanguage = null) {
  await loadTranslations();
  
  // Priority: user preference > stored > detect
  if (userLanguage && SUPPORTED_LANGUAGES.includes(userLanguage)) {
    currentLanguage = userLanguage;
  } else {
    currentLanguage = detectLanguage();
  }
  
  document.documentElement.lang = currentLanguage;
  
  console.log(`[i18n] Initialized with language: ${currentLanguage}`);
  
  return currentLanguage;
}

// ── Export ────────────────────────────────────────────────────
export const i18n = {
  init,
  t,
  changeLanguage,
  getLanguage,
  getSupportedLanguages,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE
};

// Also expose globally for non-module usage
window.i18n = i18n;
window.t = t;
