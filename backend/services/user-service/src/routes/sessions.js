// user-service/src/routes/sessions.js - Session Management API
'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('../../../../shared/db');
const { requireAuth, AppError, successResp, errorResp } = require('../../../../shared/auth');
const { getJwtBlacklist } = require('../../../../shared/JwtBlacklist');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('user-service:sessions');
const router = express.Router();

router.use(requireAuth);

// ── GET /users/me/sessions - Get all active sessions ───────────
router.get('/me/sessions', async (req, res, next) => {
  try {
    const blacklist = getJwtBlacklist();
    const sessions = await blacklist.getActiveSessions(req.user.sub);
    
    // Add current session indicator
    const currentJti = req.user.jti;
    const sessionsWithCurrent = sessions.map(s => ({
      ...s,
      isCurrent: s.jti === currentJti,
      // Format timestamps for display
      createdAtFormatted: formatTimestamp(s.createdAt),
      lastActiveAtFormatted: formatTimestamp(s.lastActiveAt)
    }));
    
    res.json(successResp({
      total: sessionsWithCurrent.length,
      sessions: sessionsWithCurrent
    }));
  } catch (err) {
    next(err);
  }
});

// ── POST /users/me/sessions/logout - Logout current session ─────
router.post('/me/sessions/logout', async (req, res, next) => {
  try {
    const jti = req.user.jti;
    const userId = req.user.sub;
    
    if (!jti) {
      throw new AppError(1001, '无效的会话', 400);
    }
    
    const blacklist = getJwtBlacklist();
    
    // Get token expiration from JWT
    const expiresAt = req.user.exp || Math.floor(Date.now() / 1000) + 86400;
    
    // Revoke current token
    await blacklist.revokeToken(jti, userId, expiresAt, {
      reason: 'logout',
      deviceInfo: {
        deviceName: req.headers['x-device-name'] || 'Unknown',
        deviceType: req.headers['x-device-type'] || 'unknown',
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent']
      }
    });
    
    logger.info({ userId, jti }, 'User logged out');
    
    res.json(successResp(null, '已退出登录'));
  } catch (err) {
    next(err);
  }
});

// ── POST /users/me/sessions/logout-all - Logout all other sessions ─
router.post('/me/sessions/logout-all', async (req, res, next) => {
  try {
    const currentJti = req.user.jti;
    const userId = req.user.sub;
    
    const blacklist = getJwtBlacklist();
    
    // Revoke all tokens except current
    const revokedCount = await blacklist.revokeAllTokens(
      userId,
      currentJti,
      'force_logout_all'
    );
    
    logger.info({ userId, currentJti, revokedCount }, 'All other sessions logged out');
    
    res.json(successResp({
      revokedCount,
      message: `已登出 ${revokedCount} 个其他设备`
    }));
  } catch (err) {
    next(err);
  }
});

// ── DELETE /users/me/sessions/:jti - Force logout specific session ─
router.delete('/me/sessions/:jti', async (req, res, next) => {
  try {
    const { jti } = z.object({ jti: z.string().uuid() }).parse(req.params);
    const userId = req.user.sub;
    
    // Cannot revoke current session this way
    if (jti === req.user.jti) {
      throw new AppError(1001, '请使用退出登录接口登出当前设备', 400);
    }
    
    const blacklist = getJwtBlacklist();
    
    // Check if session exists
    const sessions = await blacklist.getActiveSessions(userId);
    const targetSession = sessions.find(s => s.jti === jti);
    
    if (!targetSession) {
      throw new AppError(2008, '会话不存在或已失效', 404);
    }
    
    // Revoke the session
    await blacklist.revokeSession(jti, userId, 'force_logout');
    
    logger.info({ userId, jti }, 'Session force logged out');
    
    res.json(successResp({
      jti,
      deviceName: targetSession.deviceName,
      message: '已强制登出该设备'
    }));
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json(errorResp(1001, '无效的会话ID'));
    }
    next(err);
  }
});

// ── PUT /users/me/password - Change password (revoke all tokens) ─
router.put('/me/password', async (req, res, next) => {
  try {
    const schema = z.object({
      currentPassword: z.string().min(6),
      newPassword: z.string().min(6).max(128)
        .regex(/^(?=.*[a-zA-Z])(?=.*\d).+$/, '密码必须包含字母和数字')
    });
    
    const { currentPassword, newPassword } = schema.parse(req.body);
    const userId = req.user.sub;
    
    // Verify current password (if user has password auth)
    // Note: SMS-only auth users won't have a password
    const { rows: [user] } = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId]
    );
    
    if (user?.password_hash) {
      const bcrypt = require('bcryptjs');
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        throw new AppError(1010, '当前密码错误', 401);
      }
    }
    
    // Hash new password
    const bcrypt = require('bcryptjs');
    const newPasswordHash = await bcrypt.hash(newPassword, 12);
    
    // Update password
    await query(
      'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2',
      [newPasswordHash, userId]
    );
    
    // Revoke ALL tokens (including current)
    const blacklist = getJwtBlacklist();
    const revokedCount = await blacklist.revokeAllTokens(userId, null, 'password_change');
    
    logger.info({ userId, revokedCount }, 'Password changed, all tokens revoked');
    
    res.json(successResp({
      revokedCount,
      message: '密码已修改，所有设备已登出，请重新登录'
    }));
  } catch (err) {
    if (err.name === 'ZodError') {
      return res.status(400).json(errorResp(1001, '密码格式不正确'));
    }
    next(err);
  }
});

// ── Helper Functions ────────────────────────────────────────────
function formatTimestamp(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp * 1000);
  return date.toISOString();
}

module.exports = router;
