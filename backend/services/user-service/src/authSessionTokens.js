'use strict';

const crypto = require('node:crypto');
const {
  signAccess,
  signRefresh,
  verifyAccess,
  AppError
} = require('../../../shared/auth');
async function issueTokens(user, deviceInfo = {}, credentialEpoch = null) {
  const jti = crypto.randomUUID(),
    now = Math.floor(Date.now() / 1000);
  const epoch = credentialEpoch ? {
    mfa_epoch: credentialEpoch
  } : {};
  const accessToken = signAccess({
    sub: user.id,
    nickname: user.nickname,
    level: user.level,
    jti,
    iat: now,
    ...epoch
  });
  const refreshToken = signRefresh({
    sub: user.id,
    jti,
    ...epoch
  });
  const expiresAt = verifyAccess(accessToken).exp;
  try {
    await require('../../../shared/JwtBlacklist').getJwtBlacklist().registerSession(jti, user.id, expiresAt, deviceInfo);
  } catch {
    throw new AppError(9002, 'AUTH_SESSION_UNAVAILABLE', 503);
  }
  return {
    accessToken,
    refreshToken,
    tokenExpireAt: expiresAt,
    jti
  };
}
module.exports = {
  issueTokens
};
