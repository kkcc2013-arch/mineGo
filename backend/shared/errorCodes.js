// backend/shared/errorCodes.js - 统一错误码注册表
'use strict';

/**
 * mineGo 错误码注册表
 * 
 * 格式：SX-MMM-EEE
 * S: 服务码 (1=网关, 2=用户, 3=位置, 4=精灵, 5=捕捉, 6=道馆, 7=社交, 8=奖励, 9=支付)
 * X: 子系统码 (0=通用)
 * M: 模块码 (001=认证, 002=用户资料, 003=好友, ...)
 * E: 错误序号 (001-999)
 */

const ERROR_CODES = {
  // ============================================================
  // 网关服务错误 (G1-xxx-xxx)
  // ============================================================
  'G1-001-001': {
    code: 'G1-001-001',
    httpStatus: 401,
    message: 'Invalid access token',
    messageKey: 'error.auth.invalid_token',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '请检查访问令牌是否正确，或重新登录获取新令牌。',
    tags: ['auth', 'token'],
  },
  'G1-001-002': {
    code: 'G1-001-002',
    httpStatus: 401,
    message: 'Access token expired',
    messageKey: 'error.auth.token_expired',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '登录已过期，请重新登录。',
    tags: ['auth', 'token'],
  },
  'G1-001-003': {
    code: 'G1-001-003',
    httpStatus: 401,
    message: 'Missing authorization header',
    messageKey: 'error.auth.missing_header',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '请求缺少 Authorization 头，请添加有效的访问令牌。',
    tags: ['auth', 'header'],
  },
  'G1-001-004': {
    code: 'G1-001-004',
    httpStatus: 403,
    message: 'Insufficient permissions',
    messageKey: 'error.auth.insufficient_permissions',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '您没有权限访问此资源，请联系管理员。',
    tags: ['auth', 'permission'],
  },
  'G1-002-001': {
    code: 'G1-002-001',
    httpStatus: 429,
    message: 'Rate limit exceeded',
    messageKey: 'error.rate_limit.exceeded',
    category: 'rate_limit',
    severity: 'warning',
    retryable: true,
    troubleshooting: '请求过于频繁，请等待 {retryAfter} 秒后重试。',
    tags: ['rate_limit', 'throttle'],
  },
  'G1-002-002': {
    code: 'G1-002-002',
    httpStatus: 503,
    message: 'Service temporarily unavailable',
    messageKey: 'error.service.unavailable',
    category: 'system',
    severity: 'critical',
    retryable: true,
    troubleshooting: '服务暂时不可用，请稍后重试。',
    tags: ['system', 'availability'],
  },
  'G1-003-001': {
    code: 'G1-003-001',
    httpStatus: 400,
    message: 'Invalid request format',
    messageKey: 'error.request.invalid_format',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '请求格式无效，请检查 JSON 格式是否正确。',
    tags: ['validation', 'format'],
  },

  // ============================================================
  // 用户服务错误 (U2-xxx-xxx)
  // ============================================================
  'U2-001-001': {
    code: 'U2-001-001',
    httpStatus: 400,
    message: 'Email already registered',
    messageKey: 'error.user.email_exists',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '该邮箱已被注册，请直接登录或使用其他邮箱。',
    tags: ['user', 'registration'],
  },
  'U2-001-002': {
    code: 'U2-001-002',
    httpStatus: 400,
    message: 'Invalid email format',
    messageKey: 'error.user.invalid_email',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '邮箱格式无效，请输入有效的邮箱地址。',
    tags: ['user', 'validation'],
  },
  'U2-001-003': {
    code: 'U2-001-003',
    httpStatus: 400,
    message: 'Password too weak',
    messageKey: 'error.user.weak_password',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '密码强度不足，请使用至少 8 位字符，包含大小写字母和数字。',
    tags: ['user', 'password'],
  },
  'U2-001-004': {
    code: 'U2-001-004',
    httpStatus: 401,
    message: 'Invalid credentials',
    messageKey: 'error.user.invalid_credentials',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '邮箱或密码错误，请检查后重试。',
    tags: ['user', 'login'],
  },
  'U2-001-005': {
    code: 'U2-001-005',
    httpStatus: 403,
    message: 'Account banned',
    messageKey: 'error.user.account_banned',
    category: 'auth',
    severity: 'critical',
    retryable: false,
    troubleshooting: '您的账号已被封禁，如有疑问请联系客服。',
    tags: ['user', 'ban'],
  },
  'U2-001-006': {
    code: 'U2-001-006',
    httpStatus: 403,
    message: 'Account suspended',
    messageKey: 'error.user.account_suspended',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '您的账号已被暂停，将于 {suspendedUntil} 解封。',
    tags: ['user', 'suspension'],
  },
  'U2-002-001': {
    code: 'U2-002-001',
    httpStatus: 404,
    message: 'User not found',
    messageKey: 'error.user.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '用户不存在，请检查用户 ID 是否正确。',
    tags: ['user', 'not_found'],
  },
  'U2-002-002': {
    code: 'U2-002-002',
    httpStatus: 400,
    message: 'Username already taken',
    messageKey: 'error.user.username_exists',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '该用户名已被使用，请选择其他用户名。',
    tags: ['user', 'profile'],
  },
  'U2-002-003': {
    code: 'U2-002-003',
    httpStatus: 400,
    message: 'Invalid username format',
    messageKey: 'error.user.invalid_username',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '用户名格式无效，只能包含字母、数字和下划线，长度 3-20 位。',
    tags: ['user', 'validation'],
  },
  'U2-003-001': {
    code: 'U2-003-001',
    httpStatus: 404,
    message: 'Friend not found',
    messageKey: 'error.friend.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '好友不存在，请检查好友 ID。',
    tags: ['friend', 'not_found'],
  },
  'U2-003-002': {
    code: 'U2-003-002',
    httpStatus: 400,
    message: 'Already friends',
    messageKey: 'error.friend.already_friends',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '你们已经是好友了。',
    tags: ['friend', 'duplicate'],
  },
  'U2-003-003': {
    code: 'U2-003-003',
    httpStatus: 400,
    message: 'Friend request already sent',
    messageKey: 'error.friend.request_exists',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '已发送好友请求，请等待对方确认。',
    tags: ['friend', 'request'],
  },
  'U2-003-004': {
    code: 'U2-003-004',
    httpStatus: 400,
    message: 'Friend list full',
    messageKey: 'error.friend.list_full',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '好友列表已满（最多 200 人），请删除部分好友后再添加。',
    tags: ['friend', 'limit'],
  },

  // ============================================================
  // 位置服务错误 (L3-xxx-xxx)
  // ============================================================
  'L3-001-001': {
    code: 'L3-001-001',
    httpStatus: 400,
    message: 'Invalid GPS coordinates',
    messageKey: 'error.location.invalid_coordinates',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: 'GPS 坐标无效，经度范围 [-180, 180]，纬度范围 [-90, 90]。',
    tags: ['location', 'validation'],
  },
  'L3-001-002': {
    code: 'L3-001-002',
    httpStatus: 403,
    message: 'GPS spoofing detected',
    messageKey: 'error.location.spoofing_detected',
    category: 'anti_cheat',
    severity: 'critical',
    retryable: false,
    troubleshooting: '检测到 GPS 伪造，您的账号可能被封禁。',
    tags: ['location', 'anti_cheat'],
  },
  'L3-001-003': {
    code: 'L3-001-003',
    httpStatus: 400,
    message: 'Speed limit exceeded',
    messageKey: 'error.location.speed_exceeded',
    category: 'anti_cheat',
    severity: 'warning',
    retryable: false,
    troubleshooting: '移动速度异常（超过 {maxSpeed} m/s），请停止作弊行为。',
    tags: ['location', 'anti_cheat'],
  },
  'L3-001-004': {
    code: 'L3-001-004',
    httpStatus: 404,
    message: 'No nearby pokemon found',
    messageKey: 'error.location.no_nearby_pokemon',
    category: 'resource',
    severity: 'info',
    retryable: true,
    troubleshooting: '附近没有发现精灵，请移动到其他位置或稍后再试。',
    tags: ['location', 'pokemon'],
  },

  // ============================================================
  // 精灵服务错误 (P4-xxx-xxx)
  // ============================================================
  'P4-001-001': {
    code: 'P4-001-001',
    httpStatus: 404,
    message: 'Pokemon not found',
    messageKey: 'error.pokemon.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '精灵不存在，请检查精灵 ID。',
    tags: ['pokemon', 'not_found'],
  },
  'P4-001-002': {
    code: 'P4-001-002',
    httpStatus: 403,
    message: 'Pokemon does not belong to user',
    messageKey: 'error.pokemon.not_owner',
    category: 'auth',
    severity: 'warning',
    retryable: false,
    troubleshooting: '该精灵不属于您，无法执行此操作。',
    tags: ['pokemon', 'ownership'],
  },
  'P4-001-003': {
    code: 'P4-001-003',
    httpStatus: 400,
    message: 'Pokemon already transferred',
    messageKey: 'error.pokemon.already_transferred',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '该精灵已被转移或释放。',
    tags: ['pokemon', 'transfer'],
  },
  'P4-001-004': {
    code: 'P4-001-004',
    httpStatus: 400,
    message: 'Pokemon is favorite',
    messageKey: 'error.pokemon.is_favorite',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '该精灵已标记为收藏，请先取消收藏后再转移。',
    tags: ['pokemon', 'favorite'],
  },
  'P4-001-005': {
    code: 'P4-001-005',
    httpStatus: 400,
    message: 'Pokemon storage full',
    messageKey: 'error.pokemon.storage_full',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '精灵存储已满（最多 {maxPokemon} 只），请升级存储空间或转移精灵。',
    tags: ['pokemon', 'storage'],
  },
  'P4-002-001': {
    code: 'P4-002-001',
    httpStatus: 404,
    message: 'Move not found',
    messageKey: 'error.move.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '技能不存在。',
    tags: ['move', 'not_found'],
  },
  'P4-002-002': {
    code: 'P4-002-002',
    httpStatus: 400,
    message: 'Pokemon cannot learn move',
    messageKey: 'error.move.cannot_learn',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '该精灵无法学习此技能。',
    tags: ['move', 'learn'],
  },

  // ============================================================
  // 捕捉服务错误 (C5-xxx-xxx)
  // ============================================================
  'C5-001-001': {
    code: 'C5-001-001',
    httpStatus: 404,
    message: 'Pokemon escaped',
    messageKey: 'error.catch.pokemon_escaped',
    category: 'business',
    severity: 'info',
    retryable: true,
    troubleshooting: '精灵已逃跑，请尝试使用更高级的精灵球。',
    tags: ['catch', 'escape'],
  },
  'C5-001-002': {
    code: 'C5-001-002',
    httpStatus: 400,
    message: 'No pokeballs available',
    messageKey: 'error.catch.no_pokeballs',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '没有可用的精灵球，请前往商店购买。',
    tags: ['catch', 'item'],
  },
  'C5-001-003': {
    code: 'C5-001-003',
    httpStatus: 400,
    message: 'Pokemon out of range',
    messageKey: 'error.catch.out_of_range',
    category: 'business',
    severity: 'warning',
    retryable: true,
    troubleshooting: '精灵距离太远（超过 {maxDistance} 米），请靠近后再捕捉。',
    tags: ['catch', 'distance'],
  },
  'C5-001-004': {
    code: 'C5-001-004',
    httpStatus: 403,
    message: 'Catch blocked by anti-cheat',
    messageKey: 'error.catch.blocked_anti_cheat',
    category: 'anti_cheat',
    severity: 'critical',
    retryable: false,
    troubleshooting: '捕捉请求被反作弊系统拦截，请遵守游戏规则。',
    tags: ['catch', 'anti_cheat'],
  },
  'C5-001-005': {
    code: 'C5-001-005',
    httpStatus: 400,
    message: 'Invalid catch attempt',
    messageKey: 'error.catch.invalid_attempt',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '捕捉请求无效，请检查请求参数。',
    tags: ['catch', 'validation'],
  },

  // ============================================================
  // 道馆服务错误 (G6-xxx-xxx)
  // ============================================================
  'G6-001-001': {
    code: 'G6-001-001',
    httpStatus: 404,
    message: 'Gym not found',
    messageKey: 'error.gym.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '道馆不存在，请检查道馆 ID。',
    tags: ['gym', 'not_found'],
  },
  'G6-001-002': {
    code: 'G6-001-002',
    httpStatus: 403,
    message: 'Gym too far away',
    messageKey: 'error.gym.too_far',
    category: 'business',
    severity: 'warning',
    retryable: true,
    troubleshooting: '道馆距离太远（超过 {maxDistance} 米），请靠近后再操作。',
    tags: ['gym', 'distance'],
  },
  'G6-001-003': {
    code: 'G6-001-003',
    httpStatus: 400,
    message: 'Gym already owned by your team',
    messageKey: 'error.gym.same_team',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '道馆已被您的队伍占领，无需再次攻击。',
    tags: ['gym', 'team'],
  },
  'G6-001-004': {
    code: 'G6-001-004',
    httpStatus: 400,
    message: 'No eligible pokemon for gym',
    messageKey: 'error.gym.no_eligible_pokemon',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '没有符合条件的精灵可以放入道馆（需满血且非收藏）。',
    tags: ['gym', 'pokemon'],
  },
  'G6-001-005': {
    code: 'G6-001-005',
    httpStatus: 400,
    message: 'Gym battle cooldown active',
    messageKey: 'error.gym.battle_cooldown',
    category: 'business',
    severity: 'info',
    retryable: true,
    troubleshooting: '道馆战斗冷却中，请等待 {cooldownMinutes} 分钟后再试。',
    tags: ['gym', 'cooldown'],
  },
  'G6-002-001': {
    code: 'G6-002-001',
    httpStatus: 404,
    message: 'Raid not found',
    messageKey: 'error.raid.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: 'Raid 不存在或已结束。',
    tags: ['raid', 'not_found'],
  },
  'G6-002-002': {
    code: 'G6-002-002',
    httpStatus: 400,
    message: 'Raid not active',
    messageKey: 'error.raid.not_active',
    category: 'business',
    severity: 'info',
    retryable: true,
    troubleshooting: 'Raid 尚未开始或已结束，请查看 Raid 时间表。',
    tags: ['raid', 'status'],
  },
  'G6-002-003': {
    code: 'G6-002-003',
    httpStatus: 400,
    message: 'Raid lobby full',
    messageKey: 'error.raid.lobby_full',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: 'Raid 大厅已满（最多 20 人），请加入其他 Raid。',
    tags: ['raid', 'capacity'],
  },

  // ============================================================
  // 社交服务错误 (S7-xxx-xxx)
  // ============================================================
  'S7-001-001': {
    code: 'S7-001-001',
    httpStatus: 404,
    message: 'Trade not found',
    messageKey: 'error.trade.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '交易不存在。',
    tags: ['trade', 'not_found'],
  },
  'S7-001-002': {
    code: 'S7-001-002',
    httpStatus: 400,
    message: 'Trade distance too far',
    messageKey: 'error.trade.too_far',
    category: 'business',
    severity: 'warning',
    retryable: true,
    troubleshooting: '交易距离太远（最多 {maxDistance} 米），请靠近好友后再交易。',
    tags: ['trade', 'distance'],
  },
  'S7-001-003': {
    code: 'S7-001-003',
    httpStatus: 400,
    message: 'Insufficient stardust',
    messageKey: 'error.trade.insufficient_stardust',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '星尘不足，交易需要 {requiredStardust} 星尘。',
    tags: ['trade', 'stardust'],
  },
  'S7-001-004': {
    code: 'S7-001-004',
    httpStatus: 400,
    message: 'Trade already completed',
    messageKey: 'error.trade.already_completed',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '交易已完成或已取消。',
    tags: ['trade', 'status'],
  },
  'S7-002-001': {
    code: 'S7-002-001',
    httpStatus: 404,
    message: 'Guild not found',
    messageKey: 'error.guild.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '公会不存在。',
    tags: ['guild', 'not_found'],
  },
  'S7-002-002': {
    code: 'S7-002-002',
    httpStatus: 400,
    message: 'Already in guild',
    messageKey: 'error.guild.already_member',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '您已加入公会，请先退出当前公会。',
    tags: ['guild', 'membership'],
  },
  'S7-002-003': {
    code: 'S7-002-003',
    httpStatus: 400,
    message: 'Guild full',
    messageKey: 'error.guild.full',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '公会成员已满（最多 50 人）。',
    tags: ['guild', 'capacity'],
  },

  // ============================================================
  // 奖励服务错误 (R8-xxx-xxx)
  // ============================================================
  'R8-001-001': {
    code: 'R8-001-001',
    httpStatus: 404,
    message: 'Reward not found',
    messageKey: 'error.reward.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '奖励不存在或已过期。',
    tags: ['reward', 'not_found'],
  },
  'R8-001-002': {
    code: 'R8-001-002',
    httpStatus: 400,
    message: 'Reward already claimed',
    messageKey: 'error.reward.already_claimed',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '奖励已被领取。',
    tags: ['reward', 'duplicate'],
  },
  'R8-001-003': {
    code: 'R8-001-003',
    httpStatus: 400,
    message: 'Reward not yet available',
    messageKey: 'error.reward.not_available',
    category: 'business',
    severity: 'info',
    retryable: true,
    troubleshooting: '奖励尚未解锁，请等待至 {availableAt}。',
    tags: ['reward', 'timing'],
  },
  'R8-002-001': {
    code: 'R8-002-001',
    httpStatus: 404,
    message: 'Item not found',
    messageKey: 'error.item.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '道具不存在。',
    tags: ['item', 'not_found'],
  },
  'R8-002-002': {
    code: 'R8-002-002',
    httpStatus: 400,
    message: 'Item inventory full',
    messageKey: 'error.item.inventory_full',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '道具背包已满（最多 {maxItems} 个），请先使用或丢弃道具。',
    tags: ['item', 'inventory'],
  },
  'R8-002-003': {
    code: 'R8-002-003',
    httpStatus: 400,
    message: 'Insufficient items',
    messageKey: 'error.item.insufficient',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '道具数量不足，需要 {required} 个，当前 {current} 个。',
    tags: ['item', 'quantity'],
  },

  // ============================================================
  // 支付服务错误 (P9-xxx-xxx)
  // ============================================================
  'P9-001-001': {
    code: 'P9-001-001',
    httpStatus: 404,
    message: 'Order not found',
    messageKey: 'error.payment.order_not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '订单不存在，请检查订单号。',
    tags: ['payment', 'order'],
  },
  'P9-001-002': {
    code: 'P9-001-002',
    httpStatus: 400,
    message: 'Order already paid',
    messageKey: 'error.payment.order_paid',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '订单已支付，请勿重复支付。',
    tags: ['payment', 'duplicate'],
  },
  'P9-001-003': {
    code: 'P9-001-003',
    httpStatus: 400,
    message: 'Order expired',
    messageKey: 'error.payment.order_expired',
    category: 'business',
    severity: 'warning',
    retryable: false,
    troubleshooting: '订单已过期，请重新下单。',
    tags: ['payment', 'expiry'],
  },
  'P9-001-004': {
    code: 'P9-001-004',
    httpStatus: 400,
    message: 'Invalid payment amount',
    messageKey: 'error.payment.invalid_amount',
    category: 'validation',
    severity: 'warning',
    retryable: false,
    troubleshooting: '支付金额无效，订单金额与实际支付金额不一致。',
    tags: ['payment', 'validation'],
  },
  'P9-001-005': {
    code: 'P9-001-005',
    httpStatus: 402,
    message: 'Payment failed',
    messageKey: 'error.payment.failed',
    category: 'business',
    severity: 'warning',
    retryable: true,
    troubleshooting: '支付失败，请检查支付方式或稍后重试。错误原因：{reason}',
    tags: ['payment', 'failure'],
  },
  'P9-001-006': {
    code: 'P9-001-006',
    httpStatus: 403,
    message: 'Duplicate order detected',
    messageKey: 'error.payment.duplicate_order',
    category: 'business',
    severity: 'info',
    retryable: false,
    troubleshooting: '检测到重复订单，请勿重复提交。',
    tags: ['payment', 'duplicate'],
  },
  'P9-002-001': {
    code: 'P9-002-001',
    httpStatus: 404,
    message: 'Product not found',
    messageKey: 'error.product.not_found',
    category: 'resource',
    severity: 'warning',
    retryable: false,
    troubleshooting: '商品不存在或已下架。',
    tags: ['product', 'not_found'],
  },
  'P9-002-002': {
    code: 'P9-002-002',
    httpStatus: 400,
    message: 'Product out of stock',
    messageKey: 'error.product.out_of_stock',
    category: 'business',
    severity: 'warning',
    retryable: true,
    troubleshooting: '商品库存不足，请稍后再试。',
    tags: ['product', 'inventory'],
  },
};

// ============================================================
// 辅助函数
// ============================================================

/**
 * 根据 code 获取错误配置
 */
function getErrorConfig(code) {
  return ERROR_CODES[code] || null;
}

/**
 * 根据分类获取所有错误码
 */
function getErrorsByCategory(category) {
  return Object.values(ERROR_CODES).filter(err => err.category === category);
}

/**
 * 根据服务码获取所有错误码
 */
function getErrorsByService(serviceCode) {
  const prefix = serviceCode.toUpperCase();
  return Object.values(ERROR_CODES).filter(err => err.code.startsWith(prefix));
}

/**
 * 获取所有错误码列表
 */
function getAllErrorCodes() {
  return Object.values(ERROR_CODES);
}

/**
 * 验证错误码是否存在
 */
function isValidErrorCode(code) {
  return code in ERROR_CODES;
}

/**
 * 获取错误码统计信息
 */
function getErrorStatistics() {
  const stats = {
    total: Object.keys(ERROR_CODES).length,
    byCategory: {},
    byService: {},
    bySeverity: {},
  };

  for (const error of Object.values(ERROR_CODES)) {
    // 按分类统计
    stats.byCategory[error.category] = (stats.byCategory[error.category] || 0) + 1;
    
    // 按服务统计
    const serviceCode = error.code.split('-')[0];
    stats.byService[serviceCode] = (stats.byService[serviceCode] || 0) + 1;
    
    // 按严重程度统计
    stats.bySeverity[error.severity] = (stats.bySeverity[error.severity] || 0) + 1;
  }

  return stats;
}

module.exports = {
  ERROR_CODES,
  getErrorConfig,
  getErrorsByCategory,
  getErrorsByService,
  getAllErrorCodes,
  isValidErrorCode,
  getErrorStatistics,
};
