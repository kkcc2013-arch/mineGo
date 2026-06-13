// backend/shared/errors/factory.js - 错误工厂函数
'use strict';

const ValidationError = require('./ValidationError');
const BusinessError = require('./BusinessError');
const DatabaseError = require('./DatabaseError');
const ExternalServiceError = require('./ExternalServiceError');
const AuthenticationError = require('./AuthenticationError');
const RateLimitError = require('./RateLimitError');
const NotFoundError = require('./NotFoundError');
const ERROR_CODES = require('./errorCodes');

/**
 * 错误工厂函数集合
 * 提供便捷的错误创建方法
 */
const Errors = {
  // ============================================================
  // 认证错误
  // ============================================================
  invalidToken: (details = {}) => AuthenticationError.invalidToken(details),
  tokenExpired: (details = {}) => AuthenticationError.tokenExpired(details),
  missingAuthHeader: () => AuthenticationError.missingAuthHeader(),
  insufficientPermissions: (requiredPermission = null) => 
    AuthenticationError.insufficientPermissions(requiredPermission),
  invalidCredentials: () => AuthenticationError.invalidCredentials(),
  accountDisabled: (reason = null) => AuthenticationError.accountDisabled(reason),
  mfaRequired: (details = {}) => new AuthenticationError(
    ERROR_CODES.AUTH_MFA_REQUIRED,
    'Multi-factor authentication required',
    { details }
  ),
  
  // ============================================================
  // 限流错误
  // ============================================================
  rateLimitExceeded: (retryAfter, details = {}) => 
    new RateLimitError(retryAfter, { details }),
  quotaExceeded: (quotaType, limit, details = {}) => 
    new RateLimitError(3600, {
      details: { quotaType, limit, ...details }
    }),
  
  // ============================================================
  // 验证错误
  // ============================================================
  validationError: (field, message, details = {}) => 
    new ValidationError(field, message, { details }),
  fromJoiError: (joiError) => ValidationError.fromJoiError(joiError),
  
  // ============================================================
  // 资源不存在错误
  // ============================================================
  notFound: (resource, identifier = null, details = {}) => 
    new NotFoundError(resource, identifier, { details }),
  userNotFound: (userId = null) => new NotFoundError('User', userId),
  pokemonNotFound: (pokemonId = null) => new NotFoundError('Pokemon', pokemonId),
  gymNotFound: (gymId = null) => new NotFoundError('Gym', gymId),
  orderNotFound: (orderId = null) => new NotFoundError('Order', orderId),
  rewardNotFound: (rewardId = null) => new NotFoundError('Reward', rewardId),
  tradeNotFound: (tradeId = null) => new NotFoundError('Trade', tradeId),
  guildNotFound: (guildId = null) => new NotFoundError('Guild', guildId),
  
  // ============================================================
  // 用户服务错误
  // ============================================================
  userAlreadyExists: (email = null) => new BusinessError(
    ERROR_CODES.USER_ALREADY_EXISTS,
    'User already exists',
    { details: email ? { email } : {} }
  ),
  invalidEmail: (email) => new BusinessError(
    ERROR_CODES.USER_INVALID_EMAIL,
    'Invalid email address',
    { details: { email } }
  ),
  weakPassword: (requirements) => new BusinessError(
    ERROR_CODES.USER_WEAK_PASSWORD,
    'Password is too weak',
    { details: { requirements } }
  ),
  usernameTaken: (username) => new BusinessError(
    ERROR_CODES.USER_USERNAME_TAKEN,
    'Username is already taken',
    { details: { username } }
  ),
  invalidUsername: (username, reason) => new BusinessError(
    ERROR_CODES.USER_INVALID_USERNAME,
    'Invalid username',
    { details: { username, reason } }
  ),
  userBanned: (reason, expiresAt = null) => new BusinessError(
    ERROR_CODES.USER_BANNED,
    'User account has been banned',
    { details: { reason, expiresAt } }
  ),
  userSuspended: (suspendedUntil, reason) => new BusinessError(
    ERROR_CODES.USER_SUSPENDED,
    'User account has been suspended',
    { details: { suspendedUntil, reason } }
  ),
  friendListFull: (maxFriends = 200) => new BusinessError(
    ERROR_CODES.USER_FRIEND_LIST_FULL,
    'Friend list is full',
    { details: { maxFriends } }
  ),
  alreadyFriends: (userId) => new BusinessError(
    ERROR_CODES.USER_ALREADY_FRIENDS,
    'Already friends',
    { details: { userId } }
  ),
  friendRequestExists: (userId) => new BusinessError(
    ERROR_CODES.USER_FRIEND_REQUEST_EXISTS,
    'Friend request already exists',
    { details: { userId } }
  ),
  
  // ============================================================
  // 精灵服务错误
  // ============================================================
  pokemonNotOwner: (pokemonId) => new BusinessError(
    ERROR_CODES.POKEMON_NOT_OWNER,
    'You do not own this Pokemon',
    { details: { pokemonId } }
  ),
  pokemonAlreadyTransferred: (pokemonId) => new BusinessError(
    ERROR_CODES.POKEMON_ALREADY_TRANSFERRED,
    'Pokemon has already been transferred',
    { details: { pokemonId } }
  ),
  pokemonIsFavorite: (pokemonId) => new BusinessError(
    ERROR_CODES.POKEMON_IS_FAVORITE,
    'Cannot transfer favorite Pokemon',
    { details: { pokemonId } }
  ),
  pokemonStorageFull: (maxPokemon = 500) => new BusinessError(
    ERROR_CODES.POKEMON_STORAGE_FULL,
    'Pokemon storage is full',
    { details: { maxPokemon } }
  ),
  moveNotFound: (moveId) => new BusinessError(
    ERROR_CODES.POKEMON_MOVE_NOT_FOUND,
    'Move not found',
    { details: { moveId } }
  ),
  cannotLearnMove: (pokemonId, moveId) => new BusinessError(
    ERROR_CODES.POKEMON_CANNOT_LEARN_MOVE,
    'This Pokemon cannot learn this move',
    { details: { pokemonId, moveId } }
  ),
  evolutionFailed: (pokemonId, reason) => new BusinessError(
    ERROR_CODES.POKEMON_EVOLUTION_FAILED,
    'Evolution failed',
    { details: { pokemonId, reason } }
  ),
  invalidTrade: (reason) => new BusinessError(
    ERROR_CODES.POKEMON_INVALID_TRADE,
    'Invalid trade',
    { details: { reason } }
  ),
  
  // ============================================================
  // 位置服务错误
  // ============================================================
  invalidCoordinates: (lat, lng) => new BusinessError(
    ERROR_CODES.LOCATION_INVALID_COORDINATES,
    'Invalid coordinates',
    { details: { lat, lng } }
  ),
  gpsSpoofing: (details = {}) => new BusinessError(
    ERROR_CODES.LOCATION_GPS_SPOOFING,
    'GPS spoofing detected',
    { details, statusCode: 403 }
  ),
  speedExceeded: (maxSpeed, currentSpeed) => new BusinessError(
    ERROR_CODES.LOCATION_SPEED_EXCEEDED,
    'Movement speed exceeded limit',
    { details: { maxSpeed, currentSpeed } }
  ),
  outOfRange: (maxDistance, currentDistance) => new BusinessError(
    ERROR_CODES.LOCATION_OUT_OF_RANGE,
    'Location out of range',
    { details: { maxDistance, currentDistance } }
  ),
  noNearbyPokemon: () => new BusinessError(
    ERROR_CODES.LOCATION_NO_NEARBY_POKEMON,
    'No nearby Pokemon found',
    { statusCode: 200 }
  ),
  
  // ============================================================
  // 捕捉服务错误
  // ============================================================
  catchFailed: (reason) => new BusinessError(
    ERROR_CODES.CATCH_FAILED,
    'Catch failed',
    { details: { reason } }
  ),
  noPokeballs: (ballType = 'pokeball') => new BusinessError(
    ERROR_CODES.CATCH_NO_BALLS,
    'No Pokeballs available',
    { details: { ballType } }
  ),
  catchDistanceTooFar: (maxDistance, actualDistance) => new BusinessError(
    ERROR_CODES.CATCH_DISTANCE_TOO_FAR,
    'Pokemon is too far away',
    { details: { maxDistance, actualDistance } }
  ),
  catchBlockedAntiCheat: (reason) => new BusinessError(
    ERROR_CODES.CATCH_BLOCKED_ANTICHEAT,
    'Catch blocked by anti-cheat',
    { details: { reason }, statusCode: 403 }
  ),
  invalidCatchAttempt: (reason) => new BusinessError(
    ERROR_CODES.CATCH_INVALID_ATTEMPT,
    'Invalid catch attempt',
    { details: { reason } }
  ),
  pokemonEscaped: (pokemonId) => new BusinessError(
    ERROR_CODES.CATCH_POKEMON_ESCAPED,
    'Pokemon escaped',
    { details: { pokemonId } }
  ),
  
  // ============================================================
  // 道馆服务错误
  // ============================================================
  gymTooFar: (maxDistance, actualDistance) => new BusinessError(
    ERROR_CODES.GYM_TOO_FAR,
    'Gym is too far away',
    { details: { maxDistance, actualDistance } }
  ),
  gymSameTeam: (teamId) => new BusinessError(
    ERROR_CODES.GYM_SAME_TEAM,
    'Gym belongs to your team',
    { details: { teamId } }
  ),
  noEligiblePokemon: (reason) => new BusinessError(
    ERROR_CODES.GYM_NO_ELIGIBLE_POKEMON,
    'No eligible Pokemon for battle',
    { details: { reason } }
  ),
  gymBattleCooldown: (cooldownMinutes, remainingSeconds) => new BusinessError(
    ERROR_CODES.GYM_BATTLE_COOLDOWN,
    'Battle cooldown in effect',
    { details: { cooldownMinutes, remainingSeconds } }
  ),
  raidNotFound: (raidId) => new BusinessError(
    ERROR_CODES.GYM_RAID_NOT_FOUND,
    'Raid not found',
    { details: { raidId } }
  ),
  raidNotActive: (raidId) => new BusinessError(
    ERROR_CODES.GYM_RAID_NOT_ACTIVE,
    'Raid is not active',
    { details: { raidId } }
  ),
  raidLobbyFull: (maxPlayers, currentPlayers) => new BusinessError(
    ERROR_CODES.GYM_RAID_LOBBY_FULL,
    'Raid lobby is full',
    { details: { maxPlayers, currentPlayers } }
  ),
  gymBattleFailed: (reason) => new BusinessError(
    ERROR_CODES.GYM_BATTLE_FAILED,
    'Battle failed',
    { details: { reason } }
  ),
  
  // ============================================================
  // 社交服务错误
  // ============================================================
  tradeTooFar: (maxDistance) => new BusinessError(
    ERROR_CODES.SOCIAL_TRADE_TOO_FAR,
    'Trade partner is too far away',
    { details: { maxDistance } }
  ),
  insufficientStardust: (required, current) => new BusinessError(
    ERROR_CODES.SOCIAL_INSUFFICIENT_STARDUST,
    'Insufficient stardust',
    { details: { required, current } }
  ),
  tradeCompleted: (tradeId) => new BusinessError(
    ERROR_CODES.SOCIAL_TRADE_COMPLETED,
    'Trade already completed',
    { details: { tradeId } }
  ),
  alreadyInGuild: (guildId) => new BusinessError(
    ERROR_CODES.SOCIAL_ALREADY_IN_GUILD,
    'Already in a guild',
    { details: { guildId } }
  ),
  guildFull: (maxMembers) => new BusinessError(
    ERROR_CODES.SOCIAL_GUILD_FULL,
    'Guild is full',
    { details: { maxMembers } }
  ),
  
  // ============================================================
  // 奖励服务错误
  // ============================================================
  rewardAlreadyClaimed: (rewardId) => new BusinessError(
    ERROR_CODES.REWARD_ALREADY_CLAIMED,
    'Reward already claimed',
    { details: { rewardId } }
  ),
  rewardNotAvailable: (availableAt) => new BusinessError(
    ERROR_CODES.REWARD_NOT_AVAILABLE,
    'Reward not available',
    { details: { availableAt } }
  ),
  itemNotFound: (itemId) => new BusinessError(
    ERROR_CODES.REWARD_ITEM_NOT_FOUND,
    'Item not found',
    { details: { itemId } }
  ),
  inventoryFull: (maxItems = 500) => new BusinessError(
    ERROR_CODES.REWARD_INVENTORY_FULL,
    'Inventory is full',
    { details: { maxItems } }
  ),
  insufficientItems: (itemId, required, current) => new BusinessError(
    ERROR_CODES.REWARD_INSUFFICIENT_ITEMS,
    'Insufficient items',
    { details: { itemId, required, current } }
  ),
  
  // ============================================================
  // 支付服务错误
  // ============================================================
  orderAlreadyPaid: (orderId) => new BusinessError(
    ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID,
    'Order already paid',
    { details: { orderId } }
  ),
  orderExpired: (orderId) => new BusinessError(
    ERROR_CODES.PAYMENT_ORDER_EXPIRED,
    'Order has expired',
    { details: { orderId } }
  ),
  invalidPaymentAmount: (expected, actual) => new BusinessError(
    ERROR_CODES.PAYMENT_INVALID_AMOUNT,
    'Invalid payment amount',
    { details: { expected, actual } }
  ),
  paymentFailed: (reason, orderId) => new BusinessError(
    ERROR_CODES.PAYMENT_FAILED,
    'Payment failed',
    { details: { reason, orderId } }
  ),
  duplicateOrder: (existingOrderId) => new BusinessError(
    ERROR_CODES.PAYMENT_DUPLICATE_ORDER,
    'Duplicate order',
    { details: { existingOrderId } }
  ),
  productNotFound: (productId) => new BusinessError(
    ERROR_CODES.PAYMENT_PRODUCT_NOT_FOUND,
    'Product not found',
    { details: { productId } }
  ),
  productOutOfStock: (productId) => new BusinessError(
    ERROR_CODES.PAYMENT_PRODUCT_OUT_OF_STOCK,
    'Product out of stock',
    { details: { productId } }
  ),
  insufficientBalance: (required, current) => new BusinessError(
    ERROR_CODES.PAYMENT_INSUFFICIENT_BALANCE,
    'Insufficient balance',
    { details: { required, current } }
  ),
  
  // ============================================================
  // 数据库错误
  // ============================================================
  databaseError: (operation, cause) => new DatabaseError(operation, cause?.message, cause),
  fromPostgresError: (error, operation = 'query') => 
    DatabaseError.fromPostgresError(error, operation),
  
  // ============================================================
  // 外部服务错误
  // ============================================================
  externalServiceError: (serviceName, cause) => 
    new ExternalServiceError(serviceName, cause?.message, cause),
  externalServiceTimeout: (serviceName, timeoutMs) => 
    ExternalServiceError.timeout(serviceName, timeoutMs),
  externalServiceUnavailable: (serviceName) => 
    ExternalServiceError.connectionFailed(serviceName, null),
  
  // ============================================================
  // 通用错误
  // ============================================================
  internalError: (message = 'Internal server error', details = {}) => 
    new BusinessError(ERROR_CODES.INTERNAL_ERROR, message, { 
      details, 
      statusCode: 500 
    }),
};

module.exports = Errors;
