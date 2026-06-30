/**
 * 统一错误码定义
 * 
 * 格式规范：{模块}_{动作}_{原因}
 * - 模块：USER, POKEMON, CATCH, GYM, SOCIAL, PAYMENT, SYSTEM
 * - 动作：CREATE, UPDATE, DELETE, QUERY, AUTH, VALIDATE
 * - 原因：具体错误原因
 * 
 * 示例：
 * - USER_AUTH_TOKEN_EXPIRED
 * - POKEMON_QUERY_NOT_FOUND
 * - PAYMENT_CREATE_INSUFFICIENT_BALANCE
 */

'use strict';

module.exports = {
  // ==================== 通用错误 (1xxx) ====================
  VALIDATION_ERROR: {
    code: 'VALIDATION_ERROR',
    httpStatus: 400,
    message: 'Request validation failed',
    i18nKey: 'errors.common.validation'
  },
  RESOURCE_NOT_FOUND: {
    code: 'RESOURCE_NOT_FOUND',
    httpStatus: 404,
    message: 'Requested resource not found',
    i18nKey: 'errors.common.not_found'
  },
  RATE_LIMIT_EXCEEDED: {
    code: 'RATE_LIMIT_EXCEEDED',
    httpStatus: 429,
    message: 'Rate limit exceeded',
    i18nKey: 'errors.common.rate_limit'
  },
  INVALID_REQUEST: {
    code: 'INVALID_REQUEST',
    httpStatus: 400,
    message: 'Invalid request format',
    i18nKey: 'errors.common.invalid_request'
  },
  METHOD_NOT_ALLOWED: {
    code: 'METHOD_NOT_ALLOWED',
    httpStatus: 405,
    message: 'HTTP method not allowed',
    i18nKey: 'errors.common.method_not_allowed'
  },
  CONFLICT: {
    code: 'CONFLICT',
    httpStatus: 409,
    message: 'Resource conflict',
    i18nKey: 'errors.common.conflict'
  },
  RESOURCE_ALREADY_EXISTS: {
    code: 'RESOURCE_ALREADY_EXISTS',
    httpStatus: 409,
    message: 'Resource already exists',
    i18nKey: 'errors.common.already_exists'
  },

  // ==================== 用户认证错误 (2xxx) ====================
  USER_AUTH_TOKEN_EXPIRED: {
    code: 'USER_AUTH_TOKEN_EXPIRED',
    httpStatus: 401,
    message: 'Authentication token has expired',
    i18nKey: 'errors.auth.token_expired'
  },
  USER_AUTH_INVALID_TOKEN: {
    code: 'USER_AUTH_INVALID_TOKEN',
    httpStatus: 401,
    message: 'Invalid authentication token',
    i18nKey: 'errors.auth.invalid_token'
  },
  USER_AUTH_UNAUTHORIZED: {
    code: 'USER_AUTH_UNAUTHORIZED',
    httpStatus: 403,
    message: 'You are not authorized to perform this action',
    i18nKey: 'errors.auth.unauthorized'
  },
  USER_AUTH_INVALID_CREDENTIALS: {
    code: 'USER_AUTH_INVALID_CREDENTIALS',
    httpStatus: 401,
    message: 'Invalid email or password',
    i18nKey: 'errors.auth.invalid_credentials'
  },
  USER_AUTH_ACCOUNT_LOCKED: {
    code: 'USER_AUTH_ACCOUNT_LOCKED',
    httpStatus: 403,
    message: 'Account has been locked',
    i18nKey: 'errors.auth.account_locked'
  },
  USER_AUTH_EMAIL_NOT_VERIFIED: {
    code: 'USER_AUTH_EMAIL_NOT_VERIFIED',
    httpStatus: 403,
    message: 'Email address not verified',
    i18nKey: 'errors.auth.email_not_verified'
  },
  USER_CREATE_EMAIL_EXISTS: {
    code: 'USER_CREATE_EMAIL_EXISTS',
    httpStatus: 409,
    message: 'Email already registered',
    i18nKey: 'errors.auth.email_exists'
  },
  USER_QUERY_NOT_FOUND: {
    code: 'USER_QUERY_NOT_FOUND',
    httpStatus: 404,
    message: 'User not found',
    i18nKey: 'errors.user.not_found'
  },

  // ==================== 精灵相关错误 (3xxx) ====================
  POKEMON_QUERY_NOT_FOUND: {
    code: 'POKEMON_QUERY_NOT_FOUND',
    httpStatus: 404,
    message: 'Pokemon not found',
    i18nKey: 'errors.pokemon.not_found'
  },
  POKEMON_VALIDATE_INSUFFICIENT_CANDY: {
    code: 'POKEMON_VALIDATE_INSUFFICIENT_CANDY',
    httpStatus: 400,
    message: 'Insufficient candy to evolve this Pokemon',
    i18nKey: 'errors.pokemon.insufficient_candy'
  },
  POKEMON_UPDATE_MAX_LEVEL: {
    code: 'POKEMON_UPDATE_MAX_LEVEL',
    httpStatus: 400,
    message: 'Pokemon has reached maximum level',
    i18nKey: 'errors.pokemon.max_level'
  },
  POKEMON_VALIDATE_NOT_OWNER: {
    code: 'POKEMON_VALIDATE_NOT_OWNER',
    httpStatus: 403,
    message: 'You do not own this Pokemon',
    i18nKey: 'errors.pokemon.not_owner'
  },
  POKEMON_DELETE_PROTECTED: {
    code: 'POKEMON_DELETE_PROTECTED',
    httpStatus: 403,
    message: 'Cannot delete a protected Pokemon',
    i18nKey: 'errors.pokemon.protected'
  },
  POKEMON_VALIDATE_BAG_FULL: {
    code: 'POKEMON_VALIDATE_BAG_FULL',
    httpStatus: 400,
    message: 'Pokemon bag is full',
    i18nKey: 'errors.pokemon.bag_full'
  },
  POKEMON_QUERY_EVOLUTION_INVALID: {
    code: 'POKEMON_QUERY_EVOLUTION_INVALID',
    httpStatus: 400,
    message: 'Invalid evolution for this Pokemon',
    i18nKey: 'errors.pokemon.evolution_invalid'
  },
  POKEMON_CREATE_DUPLICATE: {
    code: 'POKEMON_CREATE_DUPLICATE',
    httpStatus: 409,
    message: 'Pokemon already exists in collection',
    i18nKey: 'errors.pokemon.duplicate'
  },

  // ==================== 捕捉相关错误 (4xxx) ====================
  CATCH_VALIDATE_OUT_OF_RANGE: {
    code: 'CATCH_VALIDATE_OUT_OF_RANGE',
    httpStatus: 400,
    message: 'You are too far from the Pokemon',
    i18nKey: 'errors.catch.out_of_range'
  },
  CATCH_VALIDATE_ALREADY_CAUGHT: {
    code: 'CATCH_VALIDATE_ALREADY_CAUGHT',
    httpStatus: 409,
    message: 'This Pokemon has already been caught',
    i18nKey: 'errors.catch.already_caught'
  },
  CATCH_VALIDATE_NO_BALLS: {
    code: 'CATCH_VALIDATE_NO_BALLS',
    httpStatus: 400,
    message: 'No Pokeballs available',
    i18nKey: 'errors.catch.no_balls'
  },
  CATCH_VALIDATE_SPAWN_EXPIRED: {
    code: 'CATCH_VALIDATE_SPAWN_EXPIRED',
    httpStatus: 410,
    message: 'Pokemon spawn has expired',
    i18nKey: 'errors.catch.spawn_expired'
  },
  CATCH_VALIDATE_INVALID_BALL: {
    code: 'CATCH_VALIDATE_INVALID_BALL',
    httpStatus: 400,
    message: 'Invalid ball type',
    i18nKey: 'errors.catch.invalid_ball'
  },
  CATCH_VALIDATE_FLED: {
    code: 'CATCH_VALIDATE_FLED',
    httpStatus: 410,
    message: 'Pokemon has fled',
    i18nKey: 'errors.catch.fled'
  },

  // ==================== 道馆相关错误 (5xxx) ====================
  GYM_VALIDATE_TEAM_MISMATCH: {
    code: 'GYM_VALIDATE_TEAM_MISMATCH',
    httpStatus: 403,
    message: 'Cannot battle your own team\'s gym',
    i18nKey: 'errors.gym.team_mismatch'
  },
  GYM_VALIDATE_COOLDOWN: {
    code: 'GYM_VALIDATE_COOLDOWN',
    httpStatus: 429,
    message: 'You must wait before battling again',
    i18nKey: 'errors.gym.cooldown'
  },
  GYM_QUERY_NOT_FOUND: {
    code: 'GYM_QUERY_NOT_FOUND',
    httpStatus: 404,
    message: 'Gym not found',
    i18nKey: 'errors.gym.not_found'
  },
  GYM_VALIDATE_NO_POKEMON: {
    code: 'GYM_VALIDATE_NO_POKEMON',
    httpStatus: 400,
    message: 'No Pokemon available for battle',
    i18nKey: 'errors.gym.no_pokemon'
  },
  GYM_VALIDATE_TOO_WEAK: {
    code: 'GYM_VALIDATE_TOO_WEAK',
    httpStatus: 400,
    message: 'Your Pokemon are too weak to battle',
    i18nKey: 'errors.gym.too_weak'
  },
  GYM_CREATE_RAID_FULL: {
    code: 'GYM_CREATE_RAID_FULL',
    httpStatus: 409,
    message: 'Raid lobby is full',
    i18nKey: 'errors.gym.raid_full'
  },
  GYM_VALIDATE_RAID_EXPIRED: {
    code: 'GYM_VALIDATE_RAID_EXPIRED',
    httpStatus: 410,
    message: 'Raid has expired',
    i18nKey: 'errors.gym.raid_expired'
  },

  // ==================== 社交相关错误 (6xxx) ====================
  SOCIAL_CREATE_FRIEND_EXISTS: {
    code: 'SOCIAL_CREATE_FRIEND_EXISTS',
    httpStatus: 409,
    message: 'Already friends with this user',
    i18nKey: 'errors.social.friend_exists'
  },
  SOCIAL_VALIDATE_FRIEND_LIMIT: {
    code: 'SOCIAL_VALIDATE_FRIEND_LIMIT',
    httpStatus: 400,
    message: 'Maximum number of friends reached',
    i18nKey: 'errors.social.friend_limit'
  },
  SOCIAL_QUERY_NOT_FOUND: {
    code: 'SOCIAL_QUERY_NOT_FOUND',
    httpStatus: 404,
    message: 'Friend request not found',
    i18nKey: 'errors.social.request_not_found'
  },
  SOCIAL_VALIDATE_CANNOT_SELF: {
    code: 'SOCIAL_VALIDATE_CANNOT_SELF',
    httpStatus: 400,
    message: 'Cannot perform this action on yourself',
    i18nKey: 'errors.social.cannot_self'
  },
  SOCIAL_VALIDATE_BLOCKED: {
    code: 'SOCIAL_VALIDATE_BLOCKED',
    httpStatus: 403,
    message: 'User has blocked you',
    i18nKey: 'errors.social.blocked'
  },
  SOCIAL_VALIDATE_TRADE_PENDING: {
    code: 'SOCIAL_VALIDATE_TRADE_PENDING',
    httpStatus: 409,
    message: 'A trade is already pending',
    i18nKey: 'errors.social.trade_pending'
  },

  // ==================== 支付相关错误 (7xxx) ====================
  PAYMENT_CREATE_INSUFFICIENT_BALANCE: {
    code: 'PAYMENT_CREATE_INSUFFICIENT_BALANCE',
    httpStatus: 402,
    message: 'Insufficient balance',
    i18nKey: 'errors.payment.insufficient_balance'
  },
  PAYMENT_VALIDATE_PRODUCT_NOT_FOUND: {
    code: 'PAYMENT_VALIDATE_PRODUCT_NOT_FOUND',
    httpStatus: 404,
    message: 'Product not found',
    i18nKey: 'errors.payment.product_not_found'
  },
  PAYMENT_CREATE_DUPLICATE_ORDER: {
    code: 'PAYMENT_CREATE_DUPLICATE_ORDER',
    httpStatus: 409,
    message: 'Duplicate order detected',
    i18nKey: 'errors.payment.duplicate_order'
  },
  PAYMENT_VALIDATE_PAYMENT_FAILED: {
    code: 'PAYMENT_VALIDATE_PAYMENT_FAILED',
    httpStatus: 402,
    message: 'Payment processing failed',
    i18nKey: 'errors.payment.payment_failed'
  },
  PAYMENT_VALIDATE_REFUND_FAILED: {
    code: 'PAYMENT_VALIDATE_REFUND_FAILED',
    httpStatus: 400,
    message: 'Refund failed',
    i18nKey: 'errors.payment.refund_failed'
  },
  PAYMENT_QUERY_ORDER_NOT_FOUND: {
    code: 'PAYMENT_QUERY_ORDER_NOT_FOUND',
    httpStatus: 404,
    message: 'Order not found',
    i18nKey: 'errors.payment.order_not_found'
  },

  // ==================== 系统错误 (9xxx) ====================
  SYSTEM_DATABASE_ERROR: {
    code: 'SYSTEM_DATABASE_ERROR',
    httpStatus: 500,
    message: 'Database operation failed',
    i18nKey: 'errors.system.database'
  },
  SYSTEM_EXTERNAL_SERVICE_ERROR: {
    code: 'SYSTEM_EXTERNAL_SERVICE_ERROR',
    httpStatus: 502,
    message: 'External service unavailable',
    i18nKey: 'errors.system.external_service'
  },
  SYSTEM_INTERNAL_ERROR: {
    code: 'SYSTEM_INTERNAL_ERROR',
    httpStatus: 500,
    message: 'Internal server error',
    i18nKey: 'errors.system.internal'
  },
  SYSTEM_REDIS_ERROR: {
    code: 'SYSTEM_REDIS_ERROR',
    httpStatus: 500,
    message: 'Redis operation failed',
    i18nKey: 'errors.system.redis'
  },
  SYSTEM_KAFKA_ERROR: {
    code: 'SYSTEM_KAFKA_ERROR',
    httpStatus: 500,
    message: 'Message queue operation failed',
    i18nKey: 'errors.system.kafka'
  },
  SYSTEM_TIMEOUT: {
    code: 'SYSTEM_TIMEOUT',
    httpStatus: 504,
    message: 'Request timeout',
    i18nKey: 'errors.system.timeout'
  },
  SYSTEM_MAINTENANCE: {
    code: 'SYSTEM_MAINTENANCE',
    httpStatus: 503,
    message: 'System under maintenance',
    i18nKey: 'errors.system.maintenance'
  }
};
