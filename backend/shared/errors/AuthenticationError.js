const BaseError = require('./BaseError');

/**
 * AuthenticationError - 认证授权错误
 * 用于用户身份验证和权限校验失败的情况
 */
class AuthenticationError extends BaseError {
  constructor(code, message, details = {}) {
    super(code, message, {
      statusCode: 401,
      details,
      isOperational: true
    });
  }
}

/**
 * 创建未登录错误
 */
AuthenticationError.notLoggedIn = () => {
  return new AuthenticationError(401, 'Authentication required', {
    reason: 'not_logged_in'
  });
};

/**
 * 创建无效凭证错误
 */
AuthenticationError.invalidCredentials = () => {
  return new AuthenticationError(1001, 'Invalid email or password', {
    reason: 'invalid_credentials'
  });
};

/**
 * 创建 Token 无效错误
 */
AuthenticationError.invalidToken = (reason = 'invalid') => {
  return new AuthenticationError(1004, `Invalid token: ${reason}`, {
    reason: 'invalid_token',
    detail: reason
  });
};

/**
 * 创建 Token 过期错误
 */
AuthenticationError.tokenExpired = () => {
  return new AuthenticationError(1004, 'Token has expired', {
    reason: 'token_expired'
  });
};

/**
 * 创建权限不足错误
 */
AuthenticationError.insufficientPermissions = (requiredPermission = null) => {
  const message = requiredPermission
    ? `Insufficient permissions: requires '${requiredPermission}'`
    : 'Insufficient permissions';
  
  return new AuthenticationError(403, message, {
    reason: 'insufficient_permissions',
    requiredPermission
  });
};

/**
 * 创建 MFA 需要错误
 */
AuthenticationError.mfaRequired = () => {
  return new AuthenticationError(1005, 'Multi-factor authentication required', {
    reason: 'mfa_required'
  });
};

/**
 * 创建账户被锁定错误
 */
AuthenticationError.accountLocked = (unlockTime = null) => {
  const message = unlockTime
    ? `Account locked until ${unlockTime}`
    : 'Account is locked';
  
  return new AuthenticationError(403, message, {
    reason: 'account_locked',
    unlockTime
  });
};

/**
 * 创建账户被禁用错误
 */
AuthenticationError.accountDisabled = () => {
  return new AuthenticationError(403, 'Account is disabled', {
    reason: 'account_disabled'
  });
};

module.exports = AuthenticationError;
