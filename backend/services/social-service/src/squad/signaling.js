/**
 * 小队实时通道（/ws/squad）消息协议——纯函数与小型状态机，无 I/O
 *
 * 客户端 → 服务端：
 *   ping                                  心跳
 *   status        { status }              ready | in_battle | away
 *   location      { lat, lng, accuracy }  每 5 秒一次（服务端最短间隔 4 秒），仅当本人开启了位置共享才转发
 *   voice_join    { muted }               加入小队语音；voice_leave 离开
 *   voice_state   { muted, speaking }     静音/说话状态（说话指示器）
 *   signal        { to, description?, candidate? }   WebRTC 信令（offer/answer/ICE），to = 对方 peerId
 *   floor_request / floor_release         floor 模式下申请/释放发言席位
 *   voice_quality { rttMs, jitterMs, lossPct, mos, bitrateKbps, peers, mode }   每 10 秒一次
 *   voice_reconnect { result: success|failure, reason, durationMs }
 *   raid_call     { raidId, gymId? }      队长发起 Raid 集结
 * 服务端 → 客户端：hello、member_online/offline、member_status、member_location、member_location_hidden、
 *   voice_peers、voice_state、signal、floor、raid_call、squad_updated、error、pong
 *
 * peerId 是每条 WebSocket 连接的随机 ID（同一用户多标签页时互不干扰）；一个用户同一时间只有一个语音会话。
 */
'use strict';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SDP = 16 * 1024;
const MAX_CANDIDATE = 1024;
const PEER_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_TYPES = new Set([
  'ping', 'status', 'location', 'voice_join', 'voice_leave', 'voice_state', 'signal',
  'floor_request', 'floor_release', 'voice_quality', 'voice_reconnect', 'raid_call',
]);
const STATUSES = new Set(['ready', 'in_battle', 'away']);
const LOCATION_MIN_INTERVAL_MS = 4000;

/**
 * 解析客户端消息
 * @returns {{ ok: true, msg: object } | { ok: false, code: string }}
 */
function parseClientMessage(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) return { ok: false, code: 'TOO_LARGE' };
  let msg;
  try { msg = JSON.parse(text); } catch { return { ok: false, code: 'BAD_JSON' }; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !CLIENT_TYPES.has(msg.type)) return { ok: false, code: 'BAD_TYPE' };
  return { ok: true, msg };
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/**
 * 校验并清洗 signal 消息，返回转发给对端的 payload（不透传任何其他字段）
 * @returns {{ to: string, description?: {type, sdp}, candidate?: object|null } | null}
 */
function sanitizeSignal(msg) {
  if (!msg || !PEER_ID_RE.test(String(msg.to || ''))) return null;
  const out = { to: msg.to };
  if (msg.description !== undefined) {
    const d = msg.description;
    if (!d || !['offer', 'answer'].includes(d.type)) return null;
    const sdp = str(d.sdp, MAX_SDP);
    if (!sdp || !sdp.startsWith('v=0')) return null;
    out.description = { type: d.type, sdp };
  }
  if (msg.candidate !== undefined) {
    const c = msg.candidate;
    if (c === null) out.candidate = null; // 候选收集结束
    else {
      if (typeof c !== 'object') return null;
      const cand = str(c.candidate, MAX_CANDIDATE);
      if (cand === null) return null;
      const mid = c.sdpMid === undefined || c.sdpMid === null ? null : str(c.sdpMid, 64);
      if (c.sdpMid !== undefined && c.sdpMid !== null && mid === null) return null;
      const idx = c.sdpMLineIndex === undefined || c.sdpMLineIndex === null ? null : Number(c.sdpMLineIndex);
      if (idx !== null && !(Number.isInteger(idx) && idx >= 0 && idx < 16)) return null;
      const ufrag = c.usernameFragment === undefined || c.usernameFragment === null ? null : str(c.usernameFragment, 256);
      out.candidate = { candidate: cand, sdpMid: mid, sdpMLineIndex: idx, usernameFragment: ufrag };
    }
  }
  if (!out.description && out.candidate === undefined) return null;
  return out;
}

/** 位置：校验范围并保留 4 位小数（约 11 米），accuracy 取整并限制 0–5000 米 */
function sanitizeLocation(msg) {
  const lat = Number(msg && msg.lat);
  const lng = Number(msg && msg.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const acc = Number(msg.accuracy);
  return {
    lat: Math.round(lat * 1e4) / 1e4,
    lng: Math.round(lng * 1e4) / 1e4,
    accuracy: Number.isFinite(acc) && acc >= 0 ? Math.min(5000, Math.round(acc)) : null,
  };
}

function sanitizeStatus(msg) {
  return msg && STATUSES.has(msg.status) ? msg.status : null;
}

function sanitizeRaidCall(msg) {
  if (!msg || !UUID_RE.test(String(msg.raidId || ''))) return null;
  const gymId = msg.gymId && UUID_RE.test(String(msg.gymId)) ? String(msg.gymId) : null;
  return { raidId: String(msg.raidId), gymId };
}

/** 每个成员的位置转发节流（最短间隔 intervalMs，超频的更新直接丢弃，客户端 5 秒后会再发） */
class LocationThrottle {
  constructor(intervalMs = LOCATION_MIN_INTERVAL_MS) {
    this.intervalMs = intervalMs;
    this.last = new Map();
  }

  accept(key, now = Date.now()) {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.set(key, now);
    return true;
  }

  forget(key) { this.last.delete(key); }
}

/** 令牌桶：每条连接的消息限速（默认 30 条/秒，突发 60） */
class TokenBucket {
  constructor({ rate = 30, burst = 60 } = {}) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.at = null;
  }

  take(now = Date.now()) {
    if (this.at !== null) this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * 发言席位（floor 模式）：最多 maxSpeakers 人同时发言，单次最长 holdMs，超时自动释放
 */
class FloorControl {
  constructor({ maxSpeakers = 4, holdMs = 60000 } = {}) {
    this.maxSpeakers = maxSpeakers;
    this.holdMs = holdMs;
    this.holders = new Map(); // peerId -> grantedAt
  }

  request(peerId, now = Date.now()) {
    this.expire(now);
    if (this.holders.has(peerId)) {
      this.holders.set(peerId, now); // 续期
      return { granted: true, renewed: true };
    }
    if (this.holders.size >= this.maxSpeakers) return { granted: false };
    this.holders.set(peerId, now);
    return { granted: true };
  }

  release(peerId) { return this.holders.delete(peerId); }

  /** @returns {string[]} 超时被释放的 peerId */
  expire(now = Date.now()) {
    const out = [];
    for (const [p, at] of this.holders) if (now - at >= this.holdMs) { this.holders.delete(p); out.push(p); }
    return out;
  }

  speakers() { return [...this.holders.keys()]; }

  clear() { this.holders.clear(); }
}

/** perfect negotiation 的礼让方：peerId 字典序较大的一方礼让（两端计算结果相反且确定） */
function isPolite(selfPeerId, otherPeerId) {
  return String(selfPeerId) > String(otherPeerId);
}

module.exports = {
  MAX_MESSAGE_BYTES, PEER_ID_RE, UUID_RE, CLIENT_TYPES, STATUSES, LOCATION_MIN_INTERVAL_MS,
  parseClientMessage, sanitizeSignal, sanitizeLocation, sanitizeStatus, sanitizeRaidCall,
  LocationThrottle, TokenBucket, FloorControl, isPolite,
};
