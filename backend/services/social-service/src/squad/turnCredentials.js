/**
 * 语音 ICE 服务器配置与 TURN 临时凭证（REQ-00558）——纯函数
 *
 * 采用 coturn 的 TURN REST API 方案（`use-auth-secret` + `static-auth-secret`）：
 *   username   = "<过期 Unix 秒>:<userId>"
 *   credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
 * coturn 用同一密钥校验，过期后拒绝分配。密钥只在服务端与 coturn 之间共享，客户端拿到的是限时凭证。
 *
 * 环境变量：
 *   TURN_SECRET          与 coturn static-auth-secret 一致；未配置时不下发 TURN（只有 STUN / 主机候选）
 *   TURN_URLS            逗号分隔，如 "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp"
 *   VOICE_STUN_URLS      逗号分隔；未配置时从第一个 turn: 地址推导 stun:<host>:<port>
 *   TURN_TTL_SECONDS     凭证有效期，默认 3600，限制在 300–86400
 */
'use strict';

const crypto = require('crypto');

const URL_RE = /^(stun|stuns|turn|turns):[A-Za-z0-9.\-[\]:]+(\?transport=(udp|tcp))?$/;

function parseUrlList(value) {
  if (!value || typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((s) => s.trim()).filter((s) => URL_RE.test(s)))];
}

function clampTtl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3600;
  return Math.max(300, Math.min(86400, Math.floor(n)));
}

/**
 * 生成 coturn REST API 临时凭证
 * @param {{secret: string, userId: string, ttlSeconds?: number, now?: number}} p
 */
function turnCredentials({ secret, userId, ttlSeconds = 3600, now = Date.now() }) {
  if (!secret) throw new Error('TURN secret not configured');
  if (!userId || /[:\s]/.test(String(userId))) throw new Error('invalid userId for TURN username');
  const ttl = clampTtl(ttlSeconds);
  const expiry = Math.floor(now / 1000) + ttl;
  const username = `${expiry}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, ttl, expiresAt: new Date(expiry * 1000).toISOString() };
}

/** coturn 侧的校验算法（测试与排障用）：凭证匹配且未过期 */
function verifyTurnCredentials({ secret, username, credential, now = Date.now() }) {
  const expiry = Number(String(username).split(':')[0]);
  if (!Number.isFinite(expiry) || expiry * 1000 < now) return false;
  const expected = crypto.createHmac('sha1', secret).update(String(username)).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(credential));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deriveStun(turnUrls) {
  const first = turnUrls.find((u) => u.startsWith('turn:'));
  if (!first) return [];
  const hostPort = first.slice('turn:'.length).split('?')[0];
  return [`stun:${hostPort}`];
}

/**
 * 客户端 RTCPeerConnection 的 iceServers 配置
 * @returns {{ iceServers: object[], ttl: number|null, expiresAt: string|null, relayAvailable: boolean }}
 */
function iceConfigFor(userId, env = process.env, now = Date.now()) {
  const turnUrls = parseUrlList(env.TURN_URLS);
  let stunUrls = parseUrlList(env.VOICE_STUN_URLS).filter((u) => u.startsWith('stun'));
  if (!stunUrls.length) stunUrls = deriveStun(turnUrls);
  const iceServers = [];
  if (stunUrls.length) iceServers.push({ urls: stunUrls });
  let ttl = null;
  let expiresAt = null;
  let relayAvailable = false;
  const turnOnly = turnUrls.filter((u) => u.startsWith('turn'));
  if (env.TURN_SECRET && turnOnly.length) {
    const c = turnCredentials({ secret: env.TURN_SECRET, userId, ttlSeconds: env.TURN_TTL_SECONDS || 3600, now });
    iceServers.push({ urls: turnOnly, username: c.username, credential: c.credential });
    ttl = c.ttl;
    expiresAt = c.expiresAt;
    relayAvailable = true;
  }
  return { iceServers, ttl, expiresAt, relayAvailable };
}

module.exports = { parseUrlList, turnCredentials, verifyTurnCredentials, iceConfigFor, clampTtl };
