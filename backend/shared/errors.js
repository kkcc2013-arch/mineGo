// backend/shared/errors.js — Unified Error Code Registry
'use strict';

/**
 * mineGo 统一错误码注册表
 * 
 * 错误码范围：
 * - 1000-1999: 通用错误
 * - 2000-2999: 用户相关
 * - 3000-3999: 精灵/捕捉
 * - 4000-4999: 道馆/社交
 * - 5000-5999: 支付
 * - 9000-9999: 系统错误
 */

const ERROR_CODES = {
  // ── 通用错误 1000-1999 ─────────────────────────────────
  1001: { message: '参数错误', httpStatus: 400 },
  1002: { message: '未认证，请先登录', httpStatus: 401 },
  1003: { message: 'Token 无效或已过期', httpStatus: 401 },
  1004: { message: '权限不足', httpStatus: 403 },
  1005: { message: '资源不存在', httpStatus: 404 },
  1006: { message: '方法不允许', httpStatus: 405 },
  1007: { message: '请求过于频繁，请稍后重试', httpStatus: 429 },
  1008: { message: '验证码错误或已过期', httpStatus: 400 },
  1009: { message: '请求超时', httpStatus: 408 },
  1010: { message: '内容类型不支持', httpStatus: 415 },
  
  // ── 用户相关 2000-2999 ─────────────────────────────────
  2001: { message: '该手机号已注册', httpStatus: 409 },
  2002: { message: '昵称已被使用', httpStatus: 409 },
  2003: { message: '账号不存在，请先注册', httpStatus: 404 },
  2004: { message: '账号已封禁', httpStatus: 403 },
  2005: { message: '用户资料不存在', httpStatus: 404 },
  2006: { message: '密码错误', httpStatus: 401 },
  2007: { message: '设备已达上限', httpStatus: 403 },
  2008: { message: '用户等级不足', httpStatus: 403 },
  2009: { message: '金币不足', httpStatus: 400 },
  2010: { message: '星尘不足', httpStatus: 400 },
  
  // ── 精灵/捕捉 3000-3999 ─────────────────────────────────
  3001: { message: '精灵不存在', httpStatus: 404 },
  3002: { message: '捕捉距离过远', httpStatus: 400 },
  3003: { message: '精灵球不足', httpStatus: 400 },
  3004: { message: '捕捉会话已结束', httpStatus: 400 },
  3005: { message: '精灵已逃走', httpStatus: 400 },
  3006: { message: '精灵仓库已满', httpStatus: 400 },
  3007: { message: '精灵状态异常', httpStatus: 400 },
  3008: { message: '补给站不存在', httpStatus: 404 },
  3009: { message: '补给站冷却中', httpStatus: 400 },
  3010: { message: '精灵种类不存在', httpStatus: 404 },
  
  // ── 道馆/社交 4000-4999 ─────────────────────────────────
  4001: { message: '道馆不存在', httpStatus: 404 },
  4002: { message: '道馆已被占领', httpStatus: 409 },
  4003: { message: '道馆战斗进行中', httpStatus: 409 },
  4004: { message: '未加入队伍', httpStatus: 403 },
  4005: { message: '好友已存在', httpStatus: 409 },
  4006: { message: '好友不存在', httpStatus: 404 },
  4007: { message: '好友请求已发送', httpStatus: 409 },
  4008: { message: '不能添加自己为好友', httpStatus: 400 },
  4009: { message: '好友数量已达上限', httpStatus: 400 },
  4010: { message: '礼物已领取', httpStatus: 400 },
  4011: { message: '交换请求无效', httpStatus: 400 },
  4012: { message: 'Raid 不存在', httpStatus: 404 },
  4013: { message: 'Raid 已结束', httpStatus: 400 },
  
  // ── 支付 5000-5999 ─────────────────────────────────────
  5001: { message: '订单不存在', httpStatus: 404 },
  5002: { message: '订单已支付', httpStatus: 409 },
  5003: { message: '签名验证失败', httpStatus: 400 },
  5004: { message: '订单已取消', httpStatus: 400 },
  5005: { message: '订单已过期', httpStatus: 400 },
  5006: { message: '支付金额不匹配', httpStatus: 400 },
  5007: { message: '商品不存在', httpStatus: 404 },
  5008: { message: '商品已下架', httpStatus: 400 },
  5009: { message: '重复订单', httpStatus: 409 },
  
  // ── 系统错误 9000-9999 ─────────────────────────────────
  9001: { message: '服务内部错误', httpStatus: 500 },
  9002: { message: '下游服务暂时不可用', httpStatus: 502 },
  9003: { message: '数据库错误', httpStatus: 500 },
  9004: { message: '缓存服务错误', httpStatus: 500 },
  9005: { message: '消息队列错误', httpStatus: 500 },
  9006: { message: '配置错误', httpStatus: 500 },
};

/**
 * 获取错误码信息
 * @param {number} code 错误码
 * @returns {{ message: string, httpStatus: number }}
 */
function getErrorInfo(code) {
  return ERROR_CODES[code] || { message: '未知错误', httpStatus: 500 };
}

/**
 * 检查错误码是否存在
 * @param {number} code 错误码
 * @returns {boolean}
 */
function isValidErrorCode(code) {
  return code in ERROR_CODES;
}

/**
 * 获取所有错误码（用于文档生成）
 * @returns {Object}
 */
function getAllErrorCodes() {
  return { ...ERROR_CODES };
}

/**
 * 按类别获取错误码
 * @param {number} categoryStart 起始错误码
 * @param {number} categoryEnd 结束错误码
 * @returns {Object}
 */
function getErrorCodesByRange(categoryStart, categoryEnd) {
  const result = {};
  for (const [code, info] of Object.entries(ERROR_CODES)) {
    const codeNum = parseInt(code);
    if (codeNum >= categoryStart && codeNum <= categoryEnd) {
      result[code] = info;
    }
  }
  return result;
}

module.exports = {
  ERROR_CODES,
  getErrorInfo,
  isValidErrorCode,
  getAllErrorCodes,
  getErrorCodesByRange,
};
