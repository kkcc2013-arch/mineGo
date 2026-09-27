// 路由辅助：统一成功响应（successResp 格式）与 BattleError → HTTP 状态码映射
'use strict';

const { successResp } = require('../../../../shared/auth');
const { BattleError } = require('./engine');

function sendError(res, e) {
  return res.status(e.status || 400).json({
    success: false, code: e.code, message: e.message, details: e.details || {}, timestamp: new Date().toISOString(),
  });
}

/** 包装异步处理函数：返回值作为 data 输出；BattleError 按其状态码返回 */
function handle(fn) {
  return async (req, res, next) => {
    try {
      const data = await fn(req, res);
      if (!res.headersSent) res.json(successResp(data));
    } catch (e) {
      if (e instanceof BattleError) return sendError(res, e);
      return next(e);
    }
  };
}

function userId(req) {
  return req.user && (req.user.sub || req.user.id);
}

function isAdmin(req) {
  return !!(req.user && Array.isArray(req.user.roles) && req.user.roles.includes('admin'));
}

function requireAdminRole(req) {
  if (!isAdmin(req)) throw new BattleError('FORBIDDEN', '需要管理员权限', 403);
}

module.exports = { handle, sendError, userId, isAdmin, requireAdminRole };
