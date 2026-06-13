// backend/shared/errors/errorCodes.js - 统一错误码定义
'use strict';

/**
 * mineGo 统一错误码体系
 * 
 * 错误码格式：XXX-NNN
 * XXX: 错误类别
 * NNN: 具体错误编号
 */

const ERROR_CODES = {
  // ============================================================
  // 通用错误 (GEN-xxx)
  // ============================================================
  SUCCESS: 0,
  UNKNOWN_ERROR: 'GEN-001',
  VALIDATION_ERROR: 'GEN-002',
  NOT_FOUND: 'GEN-003',
  INTERNAL_ERROR: 'GEN-004',
  
  // ============================================================
  // 认证授权错误 (AUTH-xxx)
  // ============================================================
  AUTH_INVALID_TOKEN: 'AUTH-001',
  AUTH_TOKEN_EXPIRED: 'AUTH-002',
  AUTH_MISSING_HEADER: 'AUTH-003',
  AUTH_FORBIDDEN: 'AUTH-004',
  AUTH_INVALID_CREDENTIALS: 'AUTH-005',
  AUTH_ACCOUNT_DISABLED: 'AUTH-006',
  AUTH_MFA_REQUIRED: 'AUTH-007',
  AUTH_SESSION_EXPIRED: 'AUTH-008',
  
  // ============================================================
  // 限流错误 (RATE-xxx)
  // ============================================================
  RATE_LIMIT_EXCEEDED: 'RATE-001',
  RATE_LIMIT_QUOTA_EXCEEDED: 'RATE-002',
  
  // ============================================================
  // 数据库错误 (DB-xxx)
  // ============================================================
  DATABASE_ERROR: 'DB-001',
  DATABASE_CONNECTION_FAILED: 'DB-002',
  DATABASE_POOL_EXHAUSTED: 'DB-003',
  DATABASE_DEADLOCK: 'DB-004',
  DATABASE_TIMEOUT: 'DB-005',
  
  // ============================================================
  // 外部服务错误 (EXT-xxx)
  // ============================================================
  EXTERNAL_SERVICE_ERROR: 'EXT-001',
  EXTERNAL_SERVICE_TIMEOUT: 'EXT-002',
  EXTERNAL_SERVICE_UNAVAILABLE: 'EXT-003',
  
  // ============================================================
  // 用户服务错误 (USER-xxx)
  // ============================================================
  USER_NOT_FOUND: 'USER-001',
  USER_ALREADY_EXISTS: 'USER-002',
  USER_INVALID_EMAIL: 'USER-003',
  USER_WEAK_PASSWORD: 'USER-004',
  USER_USERNAME_TAKEN: 'USER-005',
  USER_INVALID_USERNAME: 'USER-006',
  USER_BANNED: 'USER-007',
  USER_SUSPENDED: 'USER-008',
  USER_FRIEND_LIST_FULL: 'USER-009',
  USER_ALREADY_FRIENDS: 'USER-010',
  USER_FRIEND_REQUEST_EXISTS: 'USER-011',
  
  // ============================================================
  // 精灵服务错误 (PKMN-xxx)
  // ============================================================
  POKEMON_NOT_FOUND: 'PKMN-001',
  POKEMON_NOT_OWNER: 'PKMN-002',
  POKEMON_ALREADY_TRANSFERRED: 'PKMN-003',
  POKEMON_IS_FAVORITE: 'PKMN-004',
  POKEMON_STORAGE_FULL: 'PKMN-005',
  POKEMON_MOVE_NOT_FOUND: 'PKMN-006',
  POKEMON_CANNOT_LEARN_MOVE: 'PKMN-007',
  POKEMON_EVOLUTION_FAILED: 'PKMN-008',
  POKEMON_INVALID_TRADE: 'PKMN-009',
  POKEMON_NOT_AVAILABLE: 'PKMN-010',
  
  // ============================================================
  // 位置服务错误 (LOC-xxx)
  // ============================================================
  LOCATION_INVALID_COORDINATES: 'LOC-001',
  LOCATION_GPS_SPOOFING: 'LOC-002',
  LOCATION_SPEED_EXCEEDED: 'LOC-003',
  LOCATION_OUT_OF_RANGE: 'LOC-004',
  LOCATION_NO_NEARBY_POKEMON: 'LOC-005',
  
  // ============================================================
  // 捕捉服务错误 (CATCH-xxx)
  // ============================================================
  CATCH_FAILED: 'CATCH-001',
  CATCH_NO_BALLS: 'CATCH-002',
  CATCH_DISTANCE_TOO_FAR: 'CATCH-003',
  CATCH_BLOCKED_ANTICHEAT: 'CATCH-004',
  CATCH_INVALID_ATTEMPT: 'CATCH-005',
  CATCH_POKEMON_ESCAPED: 'CATCH-006',
  
  // ============================================================
  // 道馆服务错误 (GYM-xxx)
  // ============================================================
  GYM_NOT_FOUND: 'GYM-001',
  GYM_TOO_FAR: 'GYM-002',
  GYM_SAME_TEAM: 'GYM-003',
  GYM_NO_ELIGIBLE_POKEMON: 'GYM-004',
  GYM_BATTLE_COOLDOWN: 'GYM-005',
  GYM_RAID_NOT_FOUND: 'GYM-006',
  GYM_RAID_NOT_ACTIVE: 'GYM-007',
  GYM_RAID_LOBBY_FULL: 'GYM-008',
  GYM_BATTLE_FAILED: 'GYM-009',
  
  // ============================================================
  // 社交服务错误 (SCL-xxx)
  // ============================================================
  SOCIAL_TRADE_NOT_FOUND: 'SCL-001',
  SOCIAL_TRADE_TOO_FAR: 'SCL-002',
  SOCIAL_INSUFFICIENT_STARDUST: 'SCL-003',
  SOCIAL_TRADE_COMPLETED: 'SCL-004',
  SOCIAL_GUILD_NOT_FOUND: 'SCL-005',
  SOCIAL_ALREADY_IN_GUILD: 'SCL-006',
  SOCIAL_GUILD_FULL: 'SCL-007',
  
  // ============================================================
  // 奖励服务错误 (RWD-xxx)
  // ============================================================
  REWARD_NOT_FOUND: 'RWD-001',
  REWARD_ALREADY_CLAIMED: 'RWD-002',
  REWARD_NOT_AVAILABLE: 'RWD-003',
  REWARD_ITEM_NOT_FOUND: 'RWD-004',
  REWARD_INVENTORY_FULL: 'RWD-005',
  REWARD_INSUFFICIENT_ITEMS: 'RWD-006',
  
  // ============================================================
  // 支付服务错误 (PAY-xxx)
  // ============================================================
  PAYMENT_ORDER_NOT_FOUND: 'PAY-001',
  PAYMENT_ORDER_ALREADY_PAID: 'PAY-002',
  PAYMENT_ORDER_EXPIRED: 'PAY-003',
  PAYMENT_INVALID_AMOUNT: 'PAY-004',
  PAYMENT_FAILED: 'PAY-005',
  PAYMENT_DUPLICATE_ORDER: 'PAY-006',
  PAYMENT_PRODUCT_NOT_FOUND: 'PAY-007',
  PAYMENT_PRODUCT_OUT_OF_STOCK: 'PAY-008',
  PAYMENT_INSUFFICIENT_BALANCE: 'PAY-009',
};

/**
 * 错误码消息映射
 */
const ERROR_MESSAGES = {
  // 通用
  [ERROR_CODES.SUCCESS]: 'Success',
  [ERROR_CODES.UNKNOWN_ERROR]: 'Unknown error',
  [ERROR_CODES.VALIDATION_ERROR]: 'Validation error',
  [ERROR_CODES.NOT_FOUND]: 'Resource not found',
  [ERROR_CODES.INTERNAL_ERROR]: 'Internal server error',
  
  // 认证
  [ERROR_CODES.AUTH_INVALID_TOKEN]: 'Invalid access token',
  [ERROR_CODES.AUTH_TOKEN_EXPIRED]: 'Access token expired',
  [ERROR_CODES.AUTH_MISSING_HEADER]: 'Missing authorization header',
  [ERROR_CODES.AUTH_FORBIDDEN]: 'Insufficient permissions',
  [ERROR_CODES.AUTH_INVALID_CREDENTIALS]: 'Invalid username or password',
  [ERROR_CODES.AUTH_ACCOUNT_DISABLED]: 'Account has been disabled',
  [ERROR_CODES.AUTH_MFA_REQUIRED]: 'Multi-factor authentication required',
  [ERROR_CODES.AUTH_SESSION_EXPIRED]: 'Session expired',
  
  // 限流
  [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 'Rate limit exceeded',
  [ERROR_CODES.RATE_LIMIT_QUOTA_EXCEEDED]: 'Quota exceeded',
  
  // 数据库
  [ERROR_CODES.DATABASE_ERROR]: 'Database operation failed',
  [ERROR_CODES.DATABASE_CONNECTION_FAILED]: 'Database connection failed',
  [ERROR_CODES.DATABASE_POOL_EXHAUSTED]: 'Connection pool exhausted',
  [ERROR_CODES.DATABASE_DEADLOCK]: 'Deadlock detected',
  [ERROR_CODES.DATABASE_TIMEOUT]: 'Database operation timeout',
  
  // 外部服务
  [ERROR_CODES.EXTERNAL_SERVICE_ERROR]: 'External service error',
  [ERROR_CODES.EXTERNAL_SERVICE_TIMEOUT]: 'External service timeout',
  [ERROR_CODES.EXTERNAL_SERVICE_UNAVAILABLE]: 'External service unavailable',
  
  // 用户
  [ERROR_CODES.USER_NOT_FOUND]: 'User not found',
  [ERROR_CODES.USER_ALREADY_EXISTS]: 'User already exists',
  [ERROR_CODES.USER_INVALID_EMAIL]: 'Invalid email address',
  [ERROR_CODES.USER_WEAK_PASSWORD]: 'Password is too weak',
  [ERROR_CODES.USER_USERNAME_TAKEN]: 'Username is already taken',
  [ERROR_CODES.USER_INVALID_USERNAME]: 'Invalid username',
  [ERROR_CODES.USER_BANNED]: 'User account has been banned',
  [ERROR_CODES.USER_SUSPENDED]: 'User account has been suspended',
  [ERROR_CODES.USER_FRIEND_LIST_FULL]: 'Friend list is full',
  [ERROR_CODES.USER_ALREADY_FRIENDS]: 'Already friends',
  [ERROR_CODES.USER_FRIEND_REQUEST_EXISTS]: 'Friend request already exists',
  
  // 精灵
  [ERROR_CODES.POKEMON_NOT_FOUND]: 'Pokemon not found',
  [ERROR_CODES.POKEMON_NOT_OWNER]: 'You do not own this Pokemon',
  [ERROR_CODES.POKEMON_ALREADY_TRANSFERRED]: 'Pokemon has already been transferred',
  [ERROR_CODES.POKEMON_IS_FAVORITE]: 'Cannot transfer favorite Pokemon',
  [ERROR_CODES.POKEMON_STORAGE_FULL]: 'Pokemon storage is full',
  [ERROR_CODES.POKEMON_MOVE_NOT_FOUND]: 'Move not found',
  [ERROR_CODES.POKEMON_CANNOT_LEARN_MOVE]: 'This Pokemon cannot learn this move',
  [ERROR_CODES.POKEMON_EVOLUTION_FAILED]: 'Evolution failed',
  [ERROR_CODES.POKEMON_INVALID_TRADE]: 'Invalid trade',
  [ERROR_CODES.POKEMON_NOT_AVAILABLE]: 'Pokemon is not available',
  
  // 位置
  [ERROR_CODES.LOCATION_INVALID_COORDINATES]: 'Invalid coordinates',
  [ERROR_CODES.LOCATION_GPS_SPOOFING]: 'GPS spoofing detected',
  [ERROR_CODES.LOCATION_SPEED_EXCEEDED]: 'Movement speed exceeded limit',
  [ERROR_CODES.LOCATION_OUT_OF_RANGE]: 'Location out of range',
  [ERROR_CODES.LOCATION_NO_NEARBY_POKEMON]: 'No nearby Pokemon found',
  
  // 捕捉
  [ERROR_CODES.CATCH_FAILED]: 'Catch failed',
  [ERROR_CODES.CATCH_NO_BALLS]: 'No Pokeballs available',
  [ERROR_CODES.CATCH_DISTANCE_TOO_FAR]: 'Pokemon is too far away',
  [ERROR_CODES.CATCH_BLOCKED_ANTICHEAT]: 'Catch blocked by anti-cheat',
  [ERROR_CODES.CATCH_INVALID_ATTEMPT]: 'Invalid catch attempt',
  [ERROR_CODES.CATCH_POKEMON_ESCAPED]: 'Pokemon escaped',
  
  // 道馆
  [ERROR_CODES.GYM_NOT_FOUND]: 'Gym not found',
  [ERROR_CODES.GYM_TOO_FAR]: 'Gym is too far away',
  [ERROR_CODES.GYM_SAME_TEAM]: 'Gym belongs to your team',
  [ERROR_CODES.GYM_NO_ELIGIBLE_POKEMON]: 'No eligible Pokemon for battle',
  [ERROR_CODES.GYM_BATTLE_COOLDOWN]: 'Battle cooldown in effect',
  [ERROR_CODES.GYM_RAID_NOT_FOUND]: 'Raid not found',
  [ERROR_CODES.GYM_RAID_NOT_ACTIVE]: 'Raid is not active',
  [ERROR_CODES.GYM_RAID_LOBBY_FULL]: 'Raid lobby is full',
  [ERROR_CODES.GYM_BATTLE_FAILED]: 'Battle failed',
  
  // 社交
  [ERROR_CODES.SOCIAL_TRADE_NOT_FOUND]: 'Trade not found',
  [ERROR_CODES.SOCIAL_TRADE_TOO_FAR]: 'Trade partner is too far away',
  [ERROR_CODES.SOCIAL_INSUFFICIENT_STARDUST]: 'Insufficient stardust',
  [ERROR_CODES.SOCIAL_TRADE_COMPLETED]: 'Trade already completed',
  [ERROR_CODES.SOCIAL_GUILD_NOT_FOUND]: 'Guild not found',
  [ERROR_CODES.SOCIAL_ALREADY_IN_GUILD]: 'Already in a guild',
  [ERROR_CODES.SOCIAL_GUILD_FULL]: 'Guild is full',
  
  // 奖励
  [ERROR_CODES.REWARD_NOT_FOUND]: 'Reward not found',
  [ERROR_CODES.REWARD_ALREADY_CLAIMED]: 'Reward already claimed',
  [ERROR_CODES.REWARD_NOT_AVAILABLE]: 'Reward not available',
  [ERROR_CODES.REWARD_ITEM_NOT_FOUND]: 'Item not found',
  [ERROR_CODES.REWARD_INVENTORY_FULL]: 'Inventory is full',
  [ERROR_CODES.REWARD_INSUFFICIENT_ITEMS]: 'Insufficient items',
  
  // 支付
  [ERROR_CODES.PAYMENT_ORDER_NOT_FOUND]: 'Order not found',
  [ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID]: 'Order already paid',
  [ERROR_CODES.PAYMENT_ORDER_EXPIRED]: 'Order has expired',
  [ERROR_CODES.PAYMENT_INVALID_AMOUNT]: 'Invalid payment amount',
  [ERROR_CODES.PAYMENT_FAILED]: 'Payment failed',
  [ERROR_CODES.PAYMENT_DUPLICATE_ORDER]: 'Duplicate order',
  [ERROR_CODES.PAYMENT_PRODUCT_NOT_FOUND]: 'Product not found',
  [ERROR_CODES.PAYMENT_PRODUCT_OUT_OF_STOCK]: 'Product out of stock',
  [ERROR_CODES.PAYMENT_INSUFFICIENT_BALANCE]: 'Insufficient balance',
};

/**
 * 获取错误消息
 */
function getErrorMessage(code) {
  return ERROR_MESSAGES[code] || 'Unknown error';
}

module.exports = {
  ERROR_CODES,
  ERROR_MESSAGES,
  getErrorMessage,
};
