'use strict';

const crypto = require('node:crypto');
const {
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  AppError
} = require('../../../shared/auth');
async function issueTokens(user, deviceInfo = {}, credentialEpoch = null, {mfaAuthenticated = false} = {}) {
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
  const refreshExpiresAt = verifyRefresh(refreshToken).exp;
  try {
    await require('../../../shared/JwtBlacklist').getJwtBlacklist().registerSession(jti, user.id, expiresAt, {...deviceInfo, refreshExpiresAt, mfaEpoch: credentialEpoch, mfaAuthenticated: Boolean(mfaAuthenticated && credentialEpoch)});
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
