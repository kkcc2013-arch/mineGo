# REQ-00101：后端 API 错误消息国际化系统

- **编号**：REQ-00101
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、frontend/game-client
- **创建时间**：2026-06-11 03:00
- **依赖需求**：REQ-00011 (游戏客户端多语言国际化支持)

## 1. 背景与问题

当前项目国际化存在以下问题：

1. **后端 API 错误消息硬编码**：
   - 所有 API 错误消息都是硬编码的英文，例如 `{ error: 'Privacy policy not found' }`
   - 无法根据用户的语言偏好返回本地化的错误消息
   - 影响非英语用户的使用体验

2. **前后端语言偏好不同步**：
   - 前端已支持中文、英文、日文三种语言
   - 后端未实现错误消息国际化，导致 API 错误与前端语言不一致
   - 用户体验不连贯

3. **错误消息缺少统一管理**：
   - 错误消息分散在各个服务中
   - 缺少统一的错误码和翻译管理
   - 新增语言需要修改多个文件

4. **参数化错误消息缺失**：
   - 不支持动态参数，例如 "User {name} not found"
   - 无法生成上下文相关的错误消息

**业务影响**：
- 非英语用户无法理解 API 错误消息
- 降低国际化产品的用户体验
- 增加客服成本（用户不理解错误含义）

## 2. 目标

1. **实现后端 API 错误消息国际化**，支持中文、英文、日文三种语言
2. **建立统一的错误码系统**，所有 API 错误使用标准化错误码
3. **支持错误消息参数化**，生成上下文相关的本地化错误消息
4. **与前端语言偏好同步**，根据用户设置自动返回对应语言的错误消息

## 3. 范围

- **包含**：
  - 统一的错误码定义和翻译管理
  - API 错误消息中间件（根据 Accept-Language 或用户偏好返回错误消息）
  - 错误消息参数化支持
  - 前端错误消息翻译辅助工具
  - 错误消息管理 API（支持动态添加翻译）
  - Prometheus 指标监控错误消息本地化率

- **不包含**：
  - 数据库数据的国际化（精灵名称、技能名称等）
  - 日志消息的国际化
  - 管理后台的国际化

## 4. 详细需求

### 4.1 统一错误码系统

创建 `backend/shared/errorCodes.js`：

```javascript
/**
 * 错误码定义（标准化）
 * 格式：{服务}_{模块}_{错误类型}
 */
const ERROR_CODES = {
  // 通用错误 (1xxx)
  UNKNOWN_ERROR: { code: 1000, httpStatus: 500 },
  INVALID_REQUEST: { code: 1001, httpStatus: 400 },
  UNAUTHORIZED: { code: 1002, httpStatus: 401 },
  FORBIDDEN: { code: 1003, httpStatus: 403 },
  NOT_FOUND: { code: 1004, httpStatus: 404 },
  RATE_LIMITED: { code: 1005, httpStatus: 429 },
  
  // 用户服务 (2xxx)
  USER_NOT_FOUND: { code: 2001, httpStatus: 404 },
  USER_ALREADY_EXISTS: { code: 2002, httpStatus: 409 },
  INVALID_CREDENTIALS: { code: 2003, httpStatus: 401 },
  EMAIL_NOT_VERIFIED: { code: 2004, httpStatus: 403 },
  ACCOUNT_SUSPENDED: { code: 2005, httpStatus: 403 },
  
  // 精灵服务 (3xxx)
  POKEMON_NOT_FOUND: { code: 3001, httpStatus: 404 },
  POKEMON_ALREADY_CAUGHT: { code: 3002, httpStatus: 409 },
  INSUFFICIENT_RESOURCES: { code: 3003, httpStatus: 400 },
  
  // 捕捉服务 (4xxx)
  CATCH_FAILED: { code: 4001, httpStatus: 500 },
  CATCH_COOLDOWN: { code: 4002, httpStatus: 429 },
  INVALID_THROW: { code: 4003, httpStatus: 400 },
  
  // 道馆服务 (5xxx)
  GYM_NOT_FOUND: { code: 5001, httpStatus: 404 },
  GYM_BATTLE_FAILED: { code: 5002, httpStatus: 500 },
  GYM_COOLDOWN: { code: 5003, httpStatus: 429 },
  
  // 社交服务 (6xxx)
  FRIEND_ALREADY_EXISTS: { code: 6001, httpStatus: 409 },
  FRIEND_LIMIT_REACHED: { code: 6002, httpStatus: 403 },
  TRADE_NOT_ALLOWED: { code: 6003, httpStatus: 403 },
  
  // 支付服务 (7xxx)
  PAYMENT_FAILED: { code: 7001, httpStatus: 500 },
  INSUFFICIENT_BALANCE: { code: 7002, httpStatus: 400 },
  PAYMENT_TIMEOUT: { code: 7003, httpStatus: 408 },
  
  // 奖励服务 (8xxx)
  REWARD_NOT_FOUND: { code: 8001, httpStatus: 404 },
  REWARD_ALREADY_CLAIMED: { code: 8002, httpStatus: 409 },
  
  // GPS 反作弊 (9xxx)
  GPS_SPOOFING_DETECTED: { code: 9001, httpStatus: 403 },
  SPEED_LIMIT_EXCEEDED: { code: 9002, httpStatus: 403 },
  LOCATION_INVALID: { code: 9003, httpStatus: 400 },
  
  // GDPR 合规 (10xxx)
  PRIVACY_POLICY_NOT_FOUND: { code: 10001, httpStatus: 404 },
  CONSENT_REQUIRED: { code: 10002, httpStatus: 403 },
};

/**
 * 获取错误码定义
 */
function getErrorDefinition(errorCode) {
  return ERROR_CODES[errorCode] || ERROR_CODES.UNKNOWN_ERROR;
}

module.exports = { ERROR_CODES, getErrorDefinition };
```

### 4.2 错误消息翻译管理

创建 `backend/shared/errorMessages.js`：

```javascript
const ERROR_MESSAGES = {
  // 通用错误
  UNKNOWN_ERROR: {
    'zh-CN': '发生未知错误',
    'en-US': 'An unknown error occurred',
    'ja-JP': '不明なエラーが発生しました'
  },
  INVALID_REQUEST: {
    'zh-CN': '请求参数无效',
    'en-US': 'Invalid request parameters',
    'ja-JP': 'リクエストパラメータが無効です'
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
    'zh-CN': '请求过于频繁，请稍后再试',
    'en-US': 'Too many requests, please try again later',
    'ja-JP': 'リクエストが多すぎます。後でもう一度お試しください'
  },
  
  // 用户服务错误
  USER_NOT_FOUND: {
    'zh-CN': '用户 {userId} 不存在',
    'en-US': 'User {userId} not found',
    'ja-JP': 'ユーザー {userId} が見つかりません'
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
  
  // 精灵服务错误
  POKEMON_NOT_FOUND: {
    'zh-CN': '精灵 {pokemonId} 不存在',
    'en-US': 'Pokemon {pokemonId} not found',
    'ja-JP': 'ポケモン {pokemonId} が見つかりません'
  },
  POKEMON_ALREADY_CAUGHT: {
    'zh-CN': '精灵 {pokemonId} 已被捕获',
    'en-US': 'Pokemon {pokemonId} already caught',
    'ja-JP': 'ポケモン {pokemonId} は既に捕獲されています'
  },
  INSUFFICIENT_RESOURCES: {
    'zh-CN': '{resource}不足，需要 {required}，当前 {current}',
    'en-US': 'Insufficient {resource}, required: {required}, current: {current}',
    'ja-JP': '{resource}が不足しています。必要：{required}、現在：{current}'
  },
  
  // 捕捉服务错误
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
  
  // 道馆服务错误
  GYM_NOT_FOUND: {
    'zh-CN': '道馆 {gymId} 不存在',
    'en-US': 'Gym {gymId} not found',
    'ja-JP': 'ジム {gymId} が見つかりません'
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
  
  // 社交服务错误
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
  
  // 支付服务错误
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
  
  // 奖励服务错误
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
  
  // GPS 反作弊错误
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
  
  // GDPR 合规错误
  PRIVACY_POLICY_NOT_FOUND: {
    'zh-CN': '隐私政策未找到',
    'en-US': 'Privacy policy not found',
    'ja-JP': 'プライバシーポリシーが見つかりません'
  },
  CONSENT_REQUIRED: {
    'zh-CN': '需要同意隐私政策才能继续',
    'en-US': 'Consent required to proceed',
    'ja-JP': '続行には同意が必要です'
  }
};

/**
 * 获取本地化的错误消息
 * @param {string} errorCode - 错误码
 * @param {string} language - 语言代码
 * @param {Object} params - 参数对象
 * @returns {string} 本地化的错误消息
 */
function getLocalizedErrorMessage(errorCode, language = 'en-US', params = {}) {
  const messages = ERROR_MESSAGES[errorCode];
  
  if (!messages) {
    // 返回通用错误消息
    const fallback = ERROR_MESSAGES.UNKNOWN_ERROR[language] || 
                     ERROR_MESSAGES.UNKNOWN_ERROR['en-US'];
    return interpolate(fallback, params);
  }
  
  const message = messages[language] || messages['en-US'];
  return interpolate(message, params);
}

/**
 * 插值参数到消息模板
 * @param {string} template - 消息模板
 * @param {Object} params - 参数对象
 * @returns {string} 插值后的消息
 */
function interpolate(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? params[key] : match;
  });
}

module.exports = { ERROR_MESSAGES, getLocalizedErrorMessage };
```

### 4.3 API 错误消息中间件

创建 `backend/shared/errorHandler.js`：

```javascript
const { ERROR_CODES, getErrorDefinition } = require('./errorCodes');
const { getLocalizedErrorMessage } = require('./errorMessages');
const logger = require('./logger');
const { incrementCounter } = require('./metrics');

/**
 * API 错误处理中间件
 * 自动根据用户的语言偏好返回本地化的错误消息
 */
function errorHandler(err, req, res, next) {
  // 获取用户语言偏好
  const language = getUserLanguage(req);
  
  // 解析错误
  const errorCode = err.code || 'UNKNOWN_ERROR';
  const errorDef = getErrorDefinition(errorCode);
  const httpStatus = err.httpStatus || errorDef.httpStatus || 500;
  
  // 获取本地化错误消息
  const localizedMessage = getLocalizedErrorMessage(
    errorCode, 
    language, 
    err.params || {}
  );
  
  // 记录错误日志
  logger.error({
    errorCode,
    httpStatus,
    message: localizedMessage,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.user?.id
  });
  
  // Prometheus 指标
  incrementCounter('api_errors_total', {
    error_code: errorCode,
    service: process.env.SERVICE_NAME || 'unknown'
  });
  
  // 返回错误响应
  res.status(httpStatus).json({
    success: false,
    error: {
      code: errorDef.code,
      message: localizedMessage,
      details: err.details || null
    }
  });
}

/**
 * 获取用户语言偏好
 * 优先级：用户设置 > Accept-Language > 默认语言
 */
function getUserLanguage(req) {
  // 1. 用户设置的语言偏好
  if (req.user?.language) {
    return req.user.language;
  }
  
  // 2. Accept-Language 头
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage) {
    // 解析 Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
    const languages = acceptLanguage.split(',').map(lang => {
      const [code] = lang.trim().split(';');
      return code.trim();
    });
    
    // 匹配支持的语言
    const supportedLanguages = ['zh-CN', 'en-US', 'ja-JP'];
    for (const lang of languages) {
      const matched = supportedLanguages.find(s => 
        s === lang || s.startsWith(lang.split('-')[0])
      );
      if (matched) return matched;
    }
  }
  
  // 3. 默认语言
  return 'en-US';
}

/**
 * 创建应用错误
 */
class AppError extends Error {
  constructor(errorCode, params = {}, details = null) {
    super(errorCode);
    this.code = errorCode;
    this.params = params;
    this.details = details;
    this.httpStatus = getErrorDefinition(errorCode).httpStatus;
  }
}

module.exports = { errorHandler, AppError, getUserLanguage };
```

### 4.4 数据库迁移脚本

```sql
-- database/pending/20260611_030000__add_api_error_i18n_tables.sql

-- API 错误日志表
CREATE TABLE IF NOT EXISTS api_error_logs (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(50) NOT NULL,
  http_status INTEGER NOT NULL,
  message TEXT NOT NULL,
  language VARCHAR(10) NOT NULL,
  user_id VARCHAR(50),
  path VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  details JSONB,
  stack_trace TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_error_logs_error_code ON api_error_logs(error_code);
CREATE INDEX idx_error_logs_created_at ON api_error_logs(created_at);
CREATE INDEX idx_error_logs_user_id ON api_error_logs(user_id);

-- 错误消息翻译表（支持动态添加）
CREATE TABLE IF NOT EXISTS error_message_translations (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(50) NOT NULL,
  language VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(error_code, language)
);

CREATE INDEX idx_error_translations_code ON error_message_translations(error_code);

-- 插入默认翻译数据
INSERT INTO error_message_translations (error_code, language, message) VALUES
-- 用户服务错误
('USER_NOT_FOUND', 'zh-CN', '用户 {userId} 不存在'),
('USER_NOT_FOUND', 'en-US', 'User {userId} not found'),
('USER_NOT_FOUND', 'ja-JP', 'ユーザー {userId} が見つかりません'),
('USER_ALREADY_EXISTS', 'zh-CN', '用户 {email} 已存在'),
('USER_ALREADY_EXISTS', 'en-US', 'User {email} already exists'),
('USER_ALREADY_EXISTS', 'ja-JP', 'ユーザー {email} は既に存在します'),
-- 更多错误消息...

-- 分区表（按日期分区）
CREATE TABLE IF NOT EXISTS api_error_logs_partitioned (
  LIKE api_error_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (created_at);

-- 创建初始分区
CREATE TABLE api_error_logs_202606 PARTITION OF api_error_logs_partitioned
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- 注释
COMMENT ON TABLE api_error_logs IS 'API 错误日志，用于分析和监控';
COMMENT ON TABLE error_message_translations IS '错误消息翻译表，支持动态添加翻译';
```

### 4.5 Prometheus 指标

```javascript
// backend/shared/metrics.js 扩展

// API 错误相关指标
const apiErrorsTotal = new Counter({
  name: 'api_errors_total',
  help: 'Total number of API errors',
  labelNames: ['error_code', 'service', 'language']
});

const apiErrorI18nRate = new Gauge({
  name: 'api_error_i18n_rate',
  help: 'Rate of localized error messages',
  labelNames: ['service']
});

const errorMessageLanguages = new Counter({
  name: 'error_message_languages_total',
  help: 'Total error messages by language',
  labelNames: ['language', 'service']
});
```

## 5. 验收标准（可测试）

- [ ] 创建统一的错误码系统，定义 30+ 标准化错误码
- [ ] 实现错误消息翻译管理，支持中文、英文、日文三种语言
- [ ] 实现 API 错误处理中间件，根据用户语言偏好返回本地化错误消息
- [ ] 支持错误消息参数化，至少 10 种错误消息包含动态参数
- [ ] 数据库迁移脚本创建错误日志和翻译表
- [ ] 新增 3 个 Prometheus 指标监控错误消息本地化
- [ ] 单元测试覆盖率达到 80% 以上
- [ ] 在测试环境验证错误消息本地化功能正常
- [ ] 更新相关服务的错误处理代码，至少 3 个服务完成迁移

## 6. 工作量估算

**M (Medium)** - 需要创建错误码系统、翻译管理、中间件和数据库表，涉及多个服务但逻辑相对独立。

## 7. 优先级理由

**P1 理由**：
1. 直接影响国际化产品的用户体验，非英语用户无法理解错误消息
2. 与 REQ-00011（前端多语言国际化）形成闭环，完善国际化体系
3. 降低客服成本，减少因错误消息不明确导致的用户咨询
4. 为后续支持更多语言奠定基础，提升产品全球竞争力
