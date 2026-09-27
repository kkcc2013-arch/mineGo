/**
 * 解析 TRUST_PROXY 环境变量为 Express 'trust proxy' 设置。
 * 'true'/'false' → 布尔（true 会信任任意 X-Forwarded-For，仅在确有外层代理且端口不对外时使用）；
 * 纯数字 → 代理跳数；其它（如 'loopback'、'10.0.0.0/8,loopback'）原样传给 Express。
 * 默认 'loopback'：只信任本机反向代理/网关转发的头。
 */
'use strict';

function parseTrustProxy(value, fallback = 'loopback') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const v = String(value).trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

module.exports = { parseTrustProxy };
