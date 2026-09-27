// backend/shared/security/settings.js
// Epic E17 安全加固：安全配置的薄适配层。
//
// 读取顺序（先命中者生效）：
//   1. 动态来源（useSource 注册；默认是 security_settings 表的轮询快照，之后可改接 E15 配置中心）
//   2. 环境变量：键 'signing.mode' → SECURITY_SIGNING_MODE（值按 JSON 解析，失败按字符串）
//   3. 代码默认值 DEFAULTS
//
// 所有阻断型检查都有 <feature>.mode：'off' | 'monitor'（只记录/告警，不拦截）| 'enforce'（拦截）。
// 上线顺序见 docs/security/E17-rollout.md：默认 monitor，观察误报后逐项切到 enforce。
//
// 本模块只依赖 Node 内置模块，可在没有 node_modules 的宿主机上单测。
'use strict';

const MODES = ['off', 'monitor', 'enforce'];

const DEFAULTS = Object.freeze({
  // ── 请求签名 / 防重放（REQ-00215/00363/00548）──
  'signing.mode': 'monitor',              // enforce 时 L3/L4 端点缺签名/签名错误/重放一律 401
  'signing.clockSkewMs': 300000,          // L3 默认 ±5 分钟（REQ-00363/00548）；L4 见 signing.l4ClockSkewMs
  'signing.l4ClockSkewMs': 120000,        // L4 高危 ±2 分钟（REQ-00215 为 2 分钟）
  'signing.nonceTtlMs': 600000,           // nonce 记录保留 = 2 × 时间窗
  'signing.enforcedEndpoints': [],        // 额外强制签名的端点（'POST /v1/foo/*'），管理后台可配置
  'signing.exemptEndpoints': [],          // 额外豁免（运维脚本等）
  'signing.logSampleRate': 1,             // 失败必记，成功按比例写 signature_verification_logs

  // ── 敏感操作二次验证（REQ-00200/00214/00561）──
  'stepUp.mode': 'monitor',
  'stepUp.maxAttempts': 5,                // 单个挑战最多尝试次数，超过锁定
  'stepUp.lockSeconds': 900,
  'stepUp.challengeTtlSeconds': 300,
  'stepUp.highRiskScore': 50,             // 用户风险 ≥ 50 强制追加 TOTP（已开启 MFA 时）
  'stepUp.operationOverrides': {},        // { 'payment:purchase': { level:'HIGH', ttl:600, methods:[...] } }

  // ── 会话安全（REQ-00219/00327）──
  'session.mode': 'monitor',
  'session.maxConcurrent': 5,
  'session.bindDevice': true,             // 访问令牌携带设备指纹哈希（dfp），请求设备不一致计入风险
  'session.geoJumpKm': 500,
  'session.geoJumpWindowMs': 3600000,
  'session.maxActiveDevices': 3,
  'session.refreshDeviceCheck': 'monitor', // enforce：刷新令牌跨设备使用 → 全账户登出

  // ── 异常登录 / 地理围栏（REQ-00344/00406）──
  'loginRisk.mode': 'monitor',
  'loginRisk.maxSpeedKmh': 800,
  'loginRisk.tempLockMinutes': 30,
  'loginRisk.maxGeofences': 5,
  'loginRisk.historyRetentionDays': 180,

  // ── 威胁检测 / 关联 / 自动响应（REQ-00270/00399/00597）──
  'threat.mode': 'monitor',
  'threat.ipBanSeconds': 900,
  'autoResponse.mode': 'monitor',         // enforce 时才真正执行封禁/撤销/锁定动作
  'autoResponse.notifyWebhook': '',       // Slack/企业微信 webhook（告警通知）

  // ── 参数校验 / 注入防护（REQ-00622）──
  'injection.mode': 'monitor',
  'injection.maxDepth': 8,
  'injection.maxStringScan': 4096,

  // ── 限流绕过检测（REQ-00389，只检测，限流由 E18 的限流器执行）──
  'bypass.mode': 'monitor',
  'bypass.distributedIpThreshold': 5,     // 同账号 1 分钟内 ≥5 个不同 IP
  'bypass.tokenRotationThreshold': 4,     // 同设备/IP 1 分钟内 ≥4 个不同令牌
  'bypass.penaltySeconds': 300,

  // ── 日志脱敏 / 密钥泄露（REQ-00394/00328）──
  'masking.enabled': true,
  'leakage.scanResponses': 'monitor',     // 网关抽样扫描下游响应中的密钥
  'leakage.responseSampleRate': 0.05,

  // ── 密码策略（REQ-00507）──
  'password.minLength': 10,
  'password.requireUpper': true,
  'password.requireLower': true,
  'password.requireDigit': true,
  'password.requireSymbol': true,
  'password.minScore': 3,
  'password.breachCheck': true,
  'password.breachTimeoutMs': 2500,

  // ── 截图内容安全（REQ-00218）──
  'contentSafety.mode': 'enforce',        // 截图分享是新接口，直接启用审核
  'contentSafety.maxImageBytes': 655360,
  'contentSafety.extraWords': [],

  // ── WebSocket 消息完整性（REQ-00328 WS）──
  'wsIntegrity.mode': 'monitor',
});

let dynamicSource = null;   // (key) => value | undefined
const listeners = new Set();

function envName(key) {
  return 'SECURITY_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[.\-]/g, '_').toUpperCase();
}

function parseEnv(raw) {
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  if (s === '') return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * 读取配置
 * @param {string} key 如 'signing.mode'
 * @param {*} [fallback] 未配置且无默认值时返回
 */
function get(key, fallback) {
  if (dynamicSource) {
    try {
      const v = dynamicSource(key);
      if (v !== undefined && v !== null) return v;
    } catch { /* 动态来源异常时退回环境变量/默认值 */ }
  }
  const env = parseEnv(process.env[envName(key)]);
  if (env !== undefined) return env;
  if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return DEFAULTS[key];
  return fallback;
}

function num(key, fallback) {
  const n = Number(get(key, fallback));
  return Number.isFinite(n) ? n : fallback;
}

function bool(key, fallback = false) {
  const v = get(key, fallback);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return Boolean(v);
}

function list(key) {
  const v = get(key, []);
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** 功能模式：off / monitor / enforce（非法值按 monitor 处理，宁可只记录也不误拦） */
function mode(feature) {
  const v = String(get(`${feature}.mode`, 'monitor')).toLowerCase();
  return MODES.includes(v) ? v : 'monitor';
}

function isEnforced(feature) { return mode(feature) === 'enforce'; }
function isActive(feature) { return mode(feature) !== 'off'; }

/**
 * 注册动态来源（配置中心 / security_settings 快照）
 * @param {(key:string)=>*} fn 返回 undefined 表示该键未配置
 */
function useSource(fn) {
  dynamicSource = typeof fn === 'function' ? fn : null;
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** 快照：当前所有已知键的生效值（管理接口展示用） */
function snapshot() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = get(k);
  return out;
}

/**
 * 基于 security_settings 表的轮询来源（配置中心接入前的过渡存储）。
 * @param {{ query: Function, intervalMs?: number, logger?: object }} deps
 * @returns {{ refresh: Function, stop: Function, set: Function }}
 */
function createTableSource({ query, intervalMs = 30000, logger } = {}) {
  let cache = new Map();
  let timer = null;
  async function refresh() {
    try {
      const { rows } = await query('SELECT key, value FROM security_settings');
      const next = new Map();
      for (const r of rows) next.set(r.key, r.value);
      cache = next;
      for (const l of listeners) { try { l(); } catch { /* ignore */ } }
    } catch (err) {
      // 表不存在（迁移未跑）或数据库不可用：保留上一次快照
      if (logger) logger.debug({ err: err.message }, 'security_settings refresh failed');
    }
    return cache.size;
  }
  async function set(key, value, updatedBy) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw Object.assign(new Error(`未知配置项: ${key}`), { statusCode: 400 });
    await query(
      `INSERT INTO security_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, JSON.stringify(value), updatedBy || null]
    );
    cache.set(key, value);
    for (const l of listeners) { try { l(); } catch { /* ignore */ } }
  }
  useSource((key) => cache.get(key));
  refresh();
  timer = setInterval(refresh, intervalMs);
  if (timer.unref) timer.unref();
  return { refresh, set, stop: () => clearInterval(timer), get: (k) => cache.get(k) };
}

module.exports = {
  DEFAULTS,
  MODES,
  get,
  num,
  bool,
  list,
  mode,
  isEnforced,
  isActive,
  useSource,
  onChange,
  snapshot,
  envName,
  createTableSource,
};
