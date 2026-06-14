// shared/errorMessages.js - 错误消息国际化翻译
'use strict';

/**
 * 支持的语言列表
 */
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const DEFAULT_LANGUAGE = 'en-US';

/**
 * 错误消息翻译表
 * 支持参数插值，格式：{paramName}
 */
const ERROR_MESSAGES = {
  // ── 通用错误 (1xxx) ─────────────────────────────────────────
  UNKNOWN_ERROR: {
    'zh-CN': '发生未知错误',
    'en-US': 'An unknown error occurred',
    'ja-JP': '不明なエラーが発生しました'
  },
  INVALID_REQUEST: {
    'zh-CN': '请求参数无效：{details}',
    'en-US': 'Invalid request parameters: {details}',
    'ja-JP': 'リクエストパラメータが無効です：{details}'
  },
  UNAUTHORIZED: {
    'zh-CN': '未授权，请先登录',
    'en-US': 'Unauthorized, please login first',
    'ja-JP': '認証されていません。ログインしてください'
  },
  FORBIDDEN: {
    'zh-CN': '没有权限执行此操作',
    'en-US': 'Permission denied',
    'ja-JP': 'この操作を実行する権限がありません'
  },
  NOT_FOUND: {
    'zh-CN': '请求的资源不存在',
    'en-US': 'Resource not found',
    'ja-JP': 'リソースが見つかりません'
  },
  RATE_LIMITED: {
    'zh-CN': '请求过于频繁，请 {retryAfter} 秒后再试',
    'en-US': 'Too many requests, please retry after {retryAfter} seconds',
    'ja-JP': 'リクエストが多すぎます。{retryAfter}秒後にお試しください'
  },
  INTERNAL_ERROR: {
    'zh-CN': '服务器内部错误',
    'en-US': 'Internal server error',
    'ja-JP': 'サーバー内部エラー'
  },
  SERVICE_UNAVAILABLE: {
    'zh-CN': '服务暂时不可用，请稍后再试',
    'en-US': 'Service temporarily unavailable',
    'ja-JP': 'サービスは一時的に利用できません'
  },
  VALIDATION_ERROR: {
    'zh-CN': '数据验证失败：{field} {reason}',
    'en-US': 'Validation failed: {field} {reason}',
    'ja-JP': '検証に失敗しました：{field} {reason}'
  },
  CONFLICT: {
    'zh-CN': '资源冲突：{resource} 已被修改',
    'en-US': 'Resource conflict: {resource} has been modified',
    'ja-JP': 'リソースの競合：{resource} は変更されています'
  },
  
  // ── 用户服务 (2xxx) ─────────────────────────────────────────
  USER_NOT_FOUND: {
    'zh-CN': '用户不存在',
    'en-US': 'User not found',
    'ja-JP': 'ユーザーが見つかりません'
  },
  USER_ALREADY_EXISTS: {
    'zh-CN': '用户 {email} 已存在',
    'en-US': 'User {email} already exists',
    'ja-JP': 'ユーザー {email} は既に存在します'
  },
  INVALID_CREDENTIALS: {
    'zh-CN': '邮箱或密码错误',
    'en-US': 'Invalid email or password',
    'ja-JP': 'メールアドレスまたはパスワードが正しくありません'
  },
  EMAIL_NOT_VERIFIED: {
    'zh-CN': '请先验证邮箱',
    'en-US': 'Please verify your email first',
    'ja-JP': 'まずメールアドレスを確認してください'
  },
  ACCOUNT_SUSPENDED: {
    'zh-CN': '账号已被停用，原因：{reason}',
    'en-US': 'Account suspended, reason: {reason}',
    'ja-JP': 'アカウントが停止されています。理由：{reason}'
  },
  PHONE_NOT_VERIFIED: {
    'zh-CN': '请先验证手机号',
    'en-US': 'Please verify your phone number first',
    'ja-JP': 'まず電話番号を確認してください'
  },
  INVALID_VERIFICATION_CODE: {
    'zh-CN': '验证码无效或已过期',
    'en-US': 'Invalid or expired verification code',
    'ja-JP': '確認コードが無効または期限切れです'
  },
  PASSWORD_TOO_WEAK: {
    'zh-CN': '密码强度不足，请包含大小写字母、数字和特殊字符',
    'en-US': 'Password too weak, please include uppercase, lowercase, numbers and special characters',
    'ja-JP': 'パスワードが弱すぎます。大文字、小文字、数字、特殊文字を含めてください'
  },
  PROFILE_UPDATE_FAILED: {
    'zh-CN': '资料更新失败',
    'en-US': 'Profile update failed',
    'ja-JP': 'プロフィールの更新に失敗しました'
  },
  MFA_REQUIRED: {
    'zh-CN': '需要进行二次验证',
    'en-US': 'Multi-factor authentication required',
    'ja-JP': '多要素認証が必要です'
  },
  MFA_INVALID_CODE: {
    'zh-CN': '二次验证码无效',
    'en-US': 'Invalid MFA code',
    'ja-JP': 'MFAコードが無効です'
  },
  SESSION_EXPIRED: {
    'zh-CN': '会话已过期，请重新登录',
    'en-US': 'Session expired, please login again',
    'ja-JP': 'セッションが期限切れです。再ログインしてください'
  },
  
  // ── 精灵服务 (3xxx) ─────────────────────────────────────────
  POKEMON_NOT_FOUND: {
    'zh-CN': '精灵不存在',
    'en-US': 'Pokemon not found',
    'ja-JP': 'ポケモンが見つかりません'
  },
  POKEMON_ALREADY_CAUGHT: {
    'zh-CN': '该精灵已被捕获',
    'en-US': 'Pokemon already caught',
    'ja-JP': 'ポケモンは既に捕獲されています'
  },
  INSUFFICIENT_RESOURCES: {
    'zh-CN': '{resource}不足，需要 {required}，当前 {current}',
    'en-US': 'Insufficient {resource}, required: {required}, current: {current}',
    'ja-JP': '{resource}が不足しています。必要：{required}、現在：{current}'
  },
  POKEMON_EVOLUTION_FAILED: {
    'zh-CN': '进化失败：{reason}',
    'en-US': 'Evolution failed: {reason}',
    'ja-JP': '進化に失敗しました：{reason}'
  },
  POKEMON_TRANSFER_FAILED: {
    'zh-CN': '传送失败',
    'en-US': 'Transfer failed',
    'ja-JP': '転送に失敗しました'
  },
  POKEMON_FAVORITE_FAILED: {
    'zh-CN': '收藏操作失败',
    'en-US': 'Favorite operation failed',
    'ja-JP': 'お気に入り操作に失敗しました'
  },
  POKEMON_POWER_UP_FAILED: {
    'zh-CN': '强化失败：{reason}',
    'en-US': 'Power up failed: {reason}',
    'ja-JP': '強化に失敗しました：{reason}'
  },
  POKEMON_NOT_ELIGIBLE: {
    'zh-CN': '精灵不符合条件：{reason}',
    'en-US': 'Pokemon not eligible: {reason}',
    'ja-JP': 'ポケモンは条件を満たしていません：{reason}'
  },
  BAG_FULL: {
    'zh-CN': '背包已满，请先清理空间',
    'en-US': 'Bag is full, please free up space',
    'ja-JP': 'バッグがいっぱいです。スペースを解放してください'
  },
  ITEM_NOT_FOUND: {
    'zh-CN': '道具不存在',
    'en-US': 'Item not found',
    'ja-JP': 'アイテムが見つかりません'
  },
  
  // ── 捕捉服务 (4xxx) ─────────────────────────────────────────
  CATCH_FAILED: {
    'zh-CN': '捕捉失败，精灵逃跑了',
    'en-US': 'Catch failed, Pokemon escaped',
    'ja-JP': '捕獲に失敗しました。ポケモンが逃げました'
  },
  CATCH_COOLDOWN: {
    'zh-CN': '捕捉冷却中，请等待 {seconds} 秒',
    'en-US': 'Catch cooldown, please wait {seconds} seconds',
    'ja-JP': '捕獲クールダウン中。{seconds}秒お待ちください'
  },
  INVALID_THROW: {
    'zh-CN': '投掷无效，请重试',
    'en-US': 'Invalid throw, please try again',
    'ja-JP': '無効なスローです。もう一度お試しください'
  },
  NO_POKEBALLS: {
    'zh-CN': '没有精灵球了',
    'en-US': 'No Pokeballs available',
    'ja-JP': 'モンスターボールがありません'
  },
  POKEMON_TOO_FAR: {
    'zh-CN': '精灵距离太远，请靠近后再尝试',
    'en-US': 'Pokemon is too far, please get closer',
    'ja-JP': 'ポケモンが遠すぎます。近づいてから再試行してください'
  },
  CATCH_SESSION_EXPIRED: {
    'zh-CN': '捕捉会话已过期',
    'en-US': 'Catch session expired',
    'ja-JP': '捕獲セッションが期限切れです'
  },
  
  // ── 道馆服务 (5xxx) ─────────────────────────────────────────
  GYM_NOT_FOUND: {
    'zh-CN': '道馆不存在',
    'en-US': 'Gym not found',
    'ja-JP': 'ジムが見つかりません'
  },
  GYM_BATTLE_FAILED: {
    'zh-CN': '道馆战斗失败：{reason}',
    'en-US': 'Gym battle failed: {reason}',
    'ja-JP': 'ジムバトルに失敗しました：{reason}'
  },
  GYM_COOLDOWN: {
    'zh-CN': '道馆冷却中，请等待 {minutes} 分钟',
    'en-US': 'Gym cooldown, please wait {minutes} minutes',
    'ja-JP': 'ジムクールダウン中。{minutes}分お待ちください'
  },
  GYM_ALREADY_DEFENDED: {
    'zh-CN': '已在道馆中驻守',
    'en-US': 'Already defending this gym',
    'ja-JP': '既にこのジムを防衛しています'
  },
  GYM_TEAM_MISMATCH: {
    'zh-CN': '道馆属于其他队伍',
    'en-US': 'Gym belongs to another team',
    'ja-JP': 'ジムは他のチームのものです'
  },
  GYM_NOT_ELIGIBLE: {
    'zh-CN': '不符合道馆挑战条件：{reason}',
    'en-US': 'Not eligible for gym battle: {reason}',
    'ja-JP': 'ジムバトルの条件を満たしていません：{reason}'
  },
  RAID_NOT_FOUND: {
    'zh-CN': '团战不存在',
    'en-US': 'Raid not found',
    'ja-JP': 'レイドが見つかりません'
  },
  RAID_NOT_ACTIVE: {
    'zh-CN': '团战未激活或已结束',
    'en-US': 'Raid not active or has ended',
    'ja-JP': 'レイドはアクティブでないか終了しています'
  },
  RAID_LOBBY_FULL: {
    'zh-CN': '团战大厅已满',
    'en-US': 'Raid lobby is full',
    'ja-JP': 'レイドロビーが満員です'
  },
  
  // ── 社交服务 (6xxx) ─────────────────────────────────────────
  FRIEND_ALREADY_EXISTS: {
    'zh-CN': '已是好友',
    'en-US': 'Already friends',
    'ja-JP': '既にフレンドです'
  },
  FRIEND_LIMIT_REACHED: {
    'zh-CN': '好友数量已达上限（{limit}）',
    'en-US': 'Friend limit reached ({limit})',
    'ja-JP': 'フレンド数が上限に達しました（{limit}）'
  },
  TRADE_NOT_ALLOWED: {
    'zh-CN': '交易不允许：{reason}',
    'en-US': 'Trade not allowed: {reason}',
    'ja-JP': '取引が許可されていません：{reason}'
  },
  FRIEND_REQUEST_NOT_FOUND: {
    'zh-CN': '好友请求不存在',
    'en-US': 'Friend request not found',
    'ja-JP': 'フレンドリクエストが見つかりません'
  },
  TRADE_ALREADY_PENDING: {
    'zh-CN': '已有待处理的交易',
    'en-US': 'Trade already pending',
    'ja-JP': '既に保留中の取引があります'
  },
  GIFT_NOT_FOUND: {
    'zh-CN': '礼物不存在',
    'en-US': 'Gift not found',
    'ja-JP': 'ギフトが見つかりません'
  },
  GIFT_ALREADY_OPENED: {
    'zh-CN': '礼物已打开',
    'en-US': 'Gift already opened',
    'ja-JP': 'ギフトは既に開封されています'
  },
  NICKNAME_INVALID: {
    'zh-CN': '昵称无效：{reason}',
    'en-US': 'Invalid nickname: {reason}',
    'ja-JP': '無効なニックネーム：{reason}'
  },
  
  // ── 支付服务 (7xxx) ─────────────────────────────────────────
  PAYMENT_FAILED: {
    'zh-CN': '支付失败：{reason}',
    'en-US': 'Payment failed: {reason}',
    'ja-JP': '支払いに失敗しました：{reason}'
  },
  INSUFFICIENT_BALANCE: {
    'zh-CN': '余额不足，需要 {required} 精币，当前 {current} 精币',
    'en-US': 'Insufficient balance, required: {required} coins, current: {current} coins',
    'ja-JP': '残高不足です。必要：{required}コイン、現在：{current}コイン'
  },
  PAYMENT_TIMEOUT: {
    'zh-CN': '支付超时，请重试',
    'en-US': 'Payment timeout, please retry',
    'ja-JP': '支払いがタイムアウトしました。再試行してください'
  },
  PAYMENT_CANCELLED: {
    'zh-CN': '支付已取消',
    'en-US': 'Payment cancelled',
    'ja-JP': '支払いがキャンセルされました'
  },
  PAYMENT_ALREADY_PROCESSED: {
    'zh-CN': '订单已处理',
    'en-US': 'Payment already processed',
    'ja-JP': '支払いは既に処理されています'
  },
  REFUND_NOT_ALLOWED: {
    'zh-CN': '不允许退款：{reason}',
    'en-US': 'Refund not allowed: {reason}',
    'ja-JP': '返金が許可されていません：{reason}'
  },
  SUBSCRIPTION_NOT_FOUND: {
    'zh-CN': '订阅不存在',
    'en-US': 'Subscription not found',
    'ja-JP': 'サブスクリプションが見つかりません'
  },
  
  // ── 奖励服务 (8xxx) ─────────────────────────────────────────
  REWARD_NOT_FOUND: {
    'zh-CN': '奖励不存在',
    'en-US': 'Reward not found',
    'ja-JP': '報酬が見つかりません'
  },
  REWARD_ALREADY_CLAIMED: {
    'zh-CN': '奖励已领取',
    'en-US': 'Reward already claimed',
    'ja-JP': '報酬は既に受け取っています'
  },
  QUEST_NOT_FOUND: {
    'zh-CN': '任务不存在',
    'en-US': 'Quest not found',
    'ja-JP': 'クエストが見つかりません'
  },
  QUEST_NOT_COMPLETE: {
    'zh-CN': '任务未完成',
    'en-US': 'Quest not complete',
    'ja-JP': 'クエストが完了していません'
  },
  ACHIEVEMENT_NOT_FOUND: {
    'zh-CN': '成就不存在',
    'en-US': 'Achievement not found',
    'ja-JP': '実績が見つかりません'
  },
  ACHIEVEMENT_ALREADY_CLAIMED: {
    'zh-CN': '成就奖励已领取',
    'en-US': 'Achievement reward already claimed',
    'ja-JP': '実績報酬は既に受け取っています'
  },
  EVENT_NOT_FOUND: {
    'zh-CN': '活动不存在',
    'en-US': 'Event not found',
    'ja-JP': 'イベントが見つかりません'
  },
  EVENT_NOT_ACTIVE: {
    'zh-CN': '活动未开始或已结束',
    'en-US': 'Event not active or has ended',
    'ja-JP': 'イベントは開始されていないか終了しています'
  },
  
  // ── GPS 反作弊 (9xxx) ─────────────────────────────────────────
  GPS_SPOOFING_DETECTED: {
    'zh-CN': '检测到 GPS 伪造，游戏功能已限制',
    'en-US': 'GPS spoofing detected, game features restricted',
    'ja-JP': 'GPSスプーフィングが検出されました。ゲーム機能が制限されています'
  },
  SPEED_LIMIT_EXCEEDED: {
    'zh-CN': '移动速度过快（{speed} km/h），游戏功能已限制',
    'en-US': 'Speed limit exceeded ({speed} km/h), game features restricted',
    'ja-JP': '移動速度が速すぎます（{speed} km/h）。ゲーム機能が制限されています'
  },
  LOCATION_INVALID: {
    'zh-CN': '位置信息无效',
    'en-US': 'Invalid location',
    'ja-JP': '位置情報が無効です'
  },
  TELEPORT_DETECTED: {
    'zh-CN': '检测到瞬间移动，距离 {distance} 米',
    'en-US': 'Teleport detected, distance: {distance} meters',
    'ja-JP': 'テレポートが検出されました。距離：{distance}メートル'
  },
  EMULATOR_DETECTED: {
    'zh-CN': '检测到模拟器，游戏功能已限制',
    'en-US': 'Emulator detected, game features restricted',
    'ja-JP': 'エミュレーターが検出されました。ゲーム機能が制限されています'
  },
  ROOT_DETECTED: {
    'zh-CN': '检测到设备已 Root，游戏功能已限制',
    'en-US': 'Root detected, game features restricted',
    'ja-JP': 'ルート化が検出されました。ゲーム機能が制限されています'
  },
  MACRO_DETECTED: {
    'zh-CN': '检测到自动化脚本，游戏功能已限制',
    'en-US': 'Macro/automation detected, game features restricted',
    'ja-JP': 'マクロ/自動化が検出されました。ゲーム機能が制限されています'
  },
  
  // ── GDPR 合规 (10xxx) ─────────────────────────────────────────
  PRIVACY_POLICY_NOT_FOUND: {
    'zh-CN': '隐私政策未找到',
    'en-US': 'Privacy policy not found',
    'ja-JP': 'プライバシーポリシーが見つかりません'
  },
  CONSENT_REQUIRED: {
    'zh-CN': '需要同意隐私政策才能继续',
    'en-US': 'Consent required to proceed',
    'ja-JP': '続行には同意が必要です'
  },
  DATA_EXPORT_FAILED: {
    'zh-CN': '数据导出失败',
    'en-US': 'Data export failed',
    'ja-JP': 'データエクスポートに失敗しました'
  },
  DATA_DELETION_FAILED: {
    'zh-CN': '数据删除失败',
    'en-US': 'Data deletion failed',
    'ja-JP': 'データ削除に失敗しました'
  },
  CONSENT_WITHDRAWN: {
    'zh-CN': '用户已撤回同意',
    'en-US': 'Consent withdrawn by user',
    'ja-JP': 'ユーザーが同意を撤回しました'
  },
  
  // ── 位置服务 (11xxx) ─────────────────────────────────────────
  LOCATION_SERVICE_UNAVAILABLE: {
    'zh-CN': '位置服务不可用',
    'en-US': 'Location service unavailable',
    'ja-JP': '位置情報サービスが利用できません'
  },
  SPAWN_NOT_FOUND: {
    'zh-CN': '精灵刷新点不存在',
    'en-US': 'Spawn point not found',
    'ja-JP': 'スポーンポイントが見つかりません'
  },
  POKESTOP_NOT_FOUND: {
    'zh-CN': '补给站不存在',
    'en-US': 'Pokestop not found',
    'ja-JP': 'ポケストップが見つかりません'
  },
  POKESTOP_COOLDOWN: {
    'zh-CN': '补给站冷却中，请等待 {minutes} 分钟',
    'en-US': 'Pokestop cooldown, please wait {minutes} minutes',
    'ja-JP': 'ポケストップクールダウン中。{minutes}分お待ちください'
  },
  WEATHER_UNAVAILABLE: {
    'zh-CN': '天气信息不可用',
    'en-US': 'Weather information unavailable',
    'ja-JP': '天気情報が利用できません'
  },
  
  // ── 网关错误 (12xxx) ─────────────────────────────────────────
  GATEWAY_TIMEOUT: {
    'zh-CN': '网关超时',
    'en-US': 'Gateway timeout',
    'ja-JP': 'ゲートウェイタイムアウト'
  },
  SERVICE_CONNECTION_FAILED: {
    'zh-CN': '服务连接失败：{service}',
    'en-US': 'Service connection failed: {service}',
    'ja-JP': 'サービス接続に失敗しました：{service}'
  },
  CIRCUIT_BREAKER_OPEN: {
    'zh-CN': '服务熔断保护已触发：{service}',
    'en-US': 'Circuit breaker open: {service}',
    'ja-JP': 'サーキットブレーカーが開いています：{service}'
  },
  RATE_LIMIT_EXCEEDED: {
    'zh-CN': '请求频率超限',
    'en-US': 'Rate limit exceeded',
    'ja-JP': 'レート制限を超過しました'
  }
};

/**
 * 获取本地化的错误消息
 * @param {string} errorCode - 错误码名称
 * @param {string} language - 语言代码
 * @param {Object} params - 参数对象
 * @returns {string} 本地化的错误消息
 */
function getLocalizedErrorMessage(errorCode, language = DEFAULT_LANGUAGE, params = {}) {
  const messages = ERROR_MESSAGES[errorCode];
  
  if (!messages) {
    // 返回通用错误消息
    const fallback = ERROR_MESSAGES.UNKNOWN_ERROR[language] || 
                     ERROR_MESSAGES.UNKNOWN_ERROR[DEFAULT_LANGUAGE];
    return interpolate(fallback, params);
  }
  
  // 获取指定语言的消息，回退到默认语言
  const message = messages[language] || messages[DEFAULT_LANGUAGE];
  return interpolate(message, params);
}

/**
 * 插值参数到消息模板
 * @param {string} template - 消息模板
 * @param {Object} params - 参数对象
 * @returns {string} 插值后的消息
 */
function interpolate(template, params) {
  if (!params || Object.keys(params).length === 0) {
    return template;
  }
  
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? String(params[key]) : match;
  });
}

/**
 * 获取所有支持的语言
 * @returns {string[]} 语言列表
 */
function getSupportedLanguages() {
  return [...SUPPORTED_LANGUAGES];
}

/**
 * 检查语言是否支持
 * @param {string} language - 语言代码
 * @returns {boolean} 是否支持
 */
function isLanguageSupported(language) {
  return SUPPORTED_LANGUAGES.includes(language);
}

/**
 * 获取默认语言
 * @returns {string} 默认语言
 */
function getDefaultLanguage() {
  return DEFAULT_LANGUAGE;
}

/**
 * 获取所有错误消息（用于文档生成或前端预加载）
 * @param {string} language - 语言代码
 * @returns {Object} 该语言的所有错误消息
 */
function getAllErrorMessages(language = DEFAULT_LANGUAGE) {
  const result = {};
  for (const [code, messages] of Object.entries(ERROR_MESSAGES)) {
    result[code] = messages[language] || messages[DEFAULT_LANGUAGE];
  }
  return result;
}

module.exports = {
  ERROR_MESSAGES,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  getLocalizedErrorMessage,
  interpolate,
  getSupportedLanguages,
  isLanguageSupported,
  getDefaultLanguage,
  getAllErrorMessages
};
