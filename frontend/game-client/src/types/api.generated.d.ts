// 自动生成，请勿手改：node scripts/generate-api-types.js
// 来源：backend/shared/apiStandards/schemas/*.json（REQ-00315 契约）
/* eslint-disable */

export interface Deprecation {
  deprecated: true;
  deprecatedAt?: string;
  sunsetAt?: string | null;
  daysRemaining?: number | null;
  successorApi?: string | null;
  migrationGuide: string;
  breakingChanges?: unknown[];
  [key: string]: unknown;
}

export interface ErrorObject {
  code: number | string;
  name: string;
  message: string;
  httpStatus?: number;
  i18nKey?: string;
  docUrl?: string;
  retryable?: boolean;
  retryAfter?: number;
  details?: unknown;
  [key: string]: unknown;
}

/** 统一错误响应（error 为旧格式字符串时标准对象在 errorInfo） */
export interface ErrorResponse {
  success: false;
  code: number | string;
  message: string;
  error: ErrorObject | string;
  errorInfo?: ErrorObject;
  meta?: Meta;
  [key: string]: unknown;
}

export interface Link {
  href: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  title?: string;
  templated?: boolean;
  [key: string]: unknown;
}

/** HAL 链接集合 */
export interface Links {
  [key: string]: unknown;
}

/** 响应元信息 */
export interface Meta {
  requestId?: string;
  timestamp?: string;
  apiVersion?: number;
  pagination?: Pagination;
  [key: string]: unknown;
}

/** 分页元数据（offset 与 cursor 两种分页的并集） */
export interface Pagination {
  type: "offset" | "cursor";
  page?: number | null;
  pageSize: number;
  limit?: number;
  offset?: number | null;
  total?: number | null;
  totalPages?: number | null;
  hasMore?: boolean;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor?: string | null;
  prevCursor?: string | null;
  [key: string]: unknown;
}

/** 成功响应信封：旧客户端依赖 code=0 与 data */
export interface SuccessEnvelope {
  success: true;
  code: 0;
  message?: string;
  data: unknown;
  meta?: Meta;
  pagination?: Pagination;
  _links?: Links;
  deprecation?: Deprecation;
  timestamp?: string;
  [key: string]: unknown;
}

export interface WildPokemon {
  id: string;
  species_id: number;
  lat: string | number;
  lng: string | number;
  cp?: number;
  is_shiny?: boolean;
  expires_at?: string;
  rarity?: string | null;
  [key: string]: unknown;
}

export interface BatchResponse {
  responses: {
    id: string;
    status: number;
    data?: unknown;
    error?: unknown;
    cached?: boolean;
    duration: number;
    priority?: string;
    [key: string]: unknown;
  }[];
  summary: {
    total: number;
    success: number;
    failed: number;
    cached: number;
    totalDuration: number;
    costSaved: number;
    failedFast?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface BatchDetails {
  results: {
    [key: string]: unknown;
  };
  errors: {
    [key: string]: unknown;
  };
  metadata: {
    requested: number;
    found: number;
    failed: number;
    cached: number;
    queryTime: number;
    dbQueries?: number;
    partial?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type PokemonDetail = PokemonSummary & {
  user_id: string;
  candy_count?: number;
  candy_to_evolve?: number | null;
  evolves_to?: number | null;
  base_attack?: number | null;
  base_defense?: number | null;
  base_hp?: number | null;
  [key: string]: unknown;
};

export interface PokemonSummary {
  id: string;
  species_id: number;
  nickname?: string | null;
  cp: number;
  hp_current?: number | null;
  hp_max?: number | null;
  iv_attack?: number;
  iv_defense?: number;
  iv_hp?: number;
  iv_pct?: string | number;
  is_shiny?: boolean;
  is_lucky?: boolean | null;
  is_favorite?: boolean | null;
  fast_move?: string | null;
  charge_move?: string | null;
  caught_at?: string | null;
  name_zh?: string | null;
  name_en?: string | null;
  type1?: string | null;
  type2?: string | null;
  sprite_url?: string | null;
  rarity?: string | null;
  _links?: Links;
  power_up_count?: number | null;
  sprite_shiny_url?: string | null;
  defending_gym_id?: string | null;
  [key: string]: unknown;
}

export interface Species {
  id: number;
  name: string | null;
  description?: string | null;
  type1: string;
  type2?: string | null;
  rarity: "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY" | "MYTHICAL";
  base_attack?: number;
  base_defense?: number;
  base_hp?: number;
  candy_to_evolve?: number | null;
  evolves_to?: number | null;
  sprite_url?: string | null;
  sprite_shiny_url?: string | null;
  _links?: Links;
  _locale?: string;
  [key: string]: unknown;
}

export interface Inventory {
  pokeball_count: number;
  greatball_count?: number;
  ultraball_count?: number;
  masterball_count?: number;
  stardust: number;
  coins?: number;
  [key: string]: unknown;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  tokenExpireAt?: number;
  userId?: string;
  nickname?: string;
  [key: string]: unknown;
}

export interface User {
  id: string;
  nickname: string;
  avatar_url?: string | null;
  team?: string | null;
  level: number;
  xp?: string | number;
  stardust?: number;
  coins?: number;
  pokemon_count?: number;
  created_at?: string;
  [key: string]: unknown;
}

/** POST /v1/auth/login — 短信验证码登录 */
export type AuthLoginResponse = SuccessEnvelope & {
  data?: Tokens;
  [key: string]: unknown;
};
export type AuthLoginRequest = {
  phone: string;
  smsCode: string;
  [key: string]: unknown;
};

/** POST /v1/auth/refresh — 刷新令牌 */
export type AuthRefreshResponse = SuccessEnvelope & {
  data?: {
    accessToken: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type AuthRefreshRequest = {
  refreshToken: string;
  [key: string]: unknown;
};

/** POST /v1/catch/session — 创建捕捉会话 */
export type CatchSessionResponse = SuccessEnvelope & {
  data?: {
    sessionId: string;
    pokemon?: {
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** POST /v1/catch/throw — 投掷精灵球 */
export type CatchThrowResponse = SuccessEnvelope & {
  data?: {
    result: "CAUGHT" | "FLED" | "MISS" | "BALL_USED";
    catchProb?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** * * — 所有错误响应（REQ-00386） */
export type ErrorAnyResponse = ErrorResponse;

/** POST /api/v1/batch — 批量请求（REQ-00308） */
export type GatewayBatchResponse = SuccessEnvelope & {
  data?: BatchResponse;
  [key: string]: unknown;
};
export type GatewayBatchRequest = {
  requests: unknown[];
  options?: {
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /api/discover — 资源发现（REQ-00518） */
export type GatewayDiscoverResponse = {
  _links: Links;
  _meta: {
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /api/version — 版本信息（REQ-00201） */
export type GatewayVersionResponse = {
  data: {
    currentVersion: number;
    supportedVersions: number[];
    versions: {
      version: number;
      status: string;
      [key: string]: unknown;
    }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** POST /v1/location — 上报位置 */
export type LocationUpdateResponse = SuccessEnvelope & {
  data?: {
    nearbyAlert: boolean;
    riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    warning?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type LocationUpdateRequest = {
  lat: number;
  lng: number;
  accuracy?: number;
  [key: string]: unknown;
};

/** GET /v1/map/nearby — 附近的野生精灵 / 补给站 / 道馆 */
export type MapNearbyResponse = SuccessEnvelope & {
  data?: {
    wildPokemons: WildPokemon[];
    pokestops: {
      [key: string]: unknown;
    }[];
    gyms?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /v1/payment/products — 商品列表 */
export type PaymentProductsResponse = SuccessEnvelope & {
  data?: {
    id: string;
    name: string;
    amountFen: number;
    coinsGrant?: number;
    [key: string]: unknown;
  }[];
  [key: string]: unknown;
};

/** POST /v1/pokemon/batch/details — 精灵详情批量查询（REQ-00350） */
export type PokemonBatchDetailsResponse = SuccessEnvelope & {
  data?: BatchDetails;
  [key: string]: unknown;
};
export type PokemonBatchDetailsRequest = {
  ids: string[];
  include?: Array<"skills" | "equipment" | "effects" | "battle" | "history">;
  [key: string]: unknown;
};

/** GET /v1/pokemon/my/:id — 我的精灵详情 */
export type PokemonMyDetailResponse = SuccessEnvelope & {
  data?: PokemonDetail;
  [key: string]: unknown;
};

/** GET /v1/pokemon/my — 我的精灵列表（分页） */
export type PokemonMyListResponse = SuccessEnvelope & {
  pagination: Pagination;
  data?: {
    pokemon: PokemonSummary[];
    total: number;
    limit?: number;
    offset?: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /v1/pokemon/pokedex — 个人图鉴 */
export type PokemonPokedexResponse = SuccessEnvelope & {
  data?: {
    entries: {
      id: number;
      caught_count: number;
      seen_count?: number;
      [key: string]: unknown;
    }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /v1/pokemon/species/:id — 图鉴种类详情 */
export type PokemonSpeciesDetailResponse = SuccessEnvelope & {
  data?: Species;
  [key: string]: unknown;
};

/** GET /v1/pokemon/species — 图鉴种类列表 */
export type PokemonSpeciesListResponse = SuccessEnvelope & {
  data?: Species[];
  [key: string]: unknown;
};

/** GET /v1/rewards/daily — 每日签到状态 */
export type RewardsDailyResponse = SuccessEnvelope & {
  data?: {
    claimed: boolean;
    streak: number;
    reward?: {
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /v1/rewards/leaderboard — 排行榜 */
export type RewardsLeaderboardResponse = SuccessEnvelope & {
  data?: {
    leaderboard: unknown[];
    myRank?: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /v1/friends — 好友列表（E01：data.friends + data.pagination，按对方隐私设置过滤） */
export type SocialFriendsResponse = SuccessEnvelope & {
  data?: {
    friends: Array<{
      id: string;
      nickname: string | null;
      level?: number | null;
      friendship_level?: number | string | null;
      friendship_points?: number | null;
      online_status?: string;
      favorite?: boolean | null;
      pending_gifts?: number | null;
      [key: string]: unknown;
    }>;
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages?: number;
      [key: string]: unknown;
    };
    limits?: {
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** GET /v1/users/me/inventory — 背包道具 */
export type UsersInventoryResponse = SuccessEnvelope & {
  data?: Inventory;
  [key: string]: unknown;
};

/** GET /v1/users/me — 当前用户资料 */
export type UsersMeResponse = SuccessEnvelope & {
  data?: User;
  [key: string]: unknown;
};

/** 路由 → 请求/响应类型索引 */
export interface ApiContracts {
  "POST /v1/auth/login": { response: AuthLoginResponse; request: AuthLoginRequest };
  "POST /v1/auth/refresh": { response: AuthRefreshResponse; request: AuthRefreshRequest };
  "POST /v1/catch/session": { response: CatchSessionResponse };
  "POST /v1/catch/throw": { response: CatchThrowResponse };
  "POST /api/v1/batch": { response: GatewayBatchResponse; request: GatewayBatchRequest };
  "GET /api/discover": { response: GatewayDiscoverResponse };
  "GET /api/version": { response: GatewayVersionResponse };
  "POST /v1/location": { response: LocationUpdateResponse; request: LocationUpdateRequest };
  "GET /v1/map/nearby": { response: MapNearbyResponse };
  "GET /v1/payment/products": { response: PaymentProductsResponse };
  "POST /v1/pokemon/batch/details": { response: PokemonBatchDetailsResponse; request: PokemonBatchDetailsRequest };
  "GET /v1/pokemon/my/:id": { response: PokemonMyDetailResponse };
  "GET /v1/pokemon/my": { response: PokemonMyListResponse };
  "GET /v1/pokemon/pokedex": { response: PokemonPokedexResponse };
  "GET /v1/pokemon/species/:id": { response: PokemonSpeciesDetailResponse };
  "GET /v1/pokemon/species": { response: PokemonSpeciesListResponse };
  "GET /v1/rewards/daily": { response: RewardsDailyResponse };
  "GET /v1/rewards/leaderboard": { response: RewardsLeaderboardResponse };
  "GET /v1/friends": { response: SocialFriendsResponse };
  "GET /v1/users/me/inventory": { response: UsersInventoryResponse };
  "GET /v1/users/me": { response: UsersMeResponse };
}
