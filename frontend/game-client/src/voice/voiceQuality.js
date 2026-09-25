// frontend/game-client/src/voice/voiceQuality.js
// REQ-00558：语音质量采样与自适应码率——纯函数（无 DOM/WebRTC 依赖，node --test 可直接测试）
//
// MOS 与服务端 backend/services/social-service/src/squad/voiceQuality.js 使用同一 E-model 简化算法（单测校验一致）：
//   单向时延 d = RTT/2 + 2·抖动 + 20ms；Id = d/40（d<160）或 (d−120)/10；Ie_eff = 95·Ppl/(Ppl+20)（Opus + FEC）
//   R = 93.2 − Id − Ie_eff；MOS = 1 + 0.035R + 7e-6·R(R−60)(100−R)

export function rFactor({ rttMs = 0, jitterMs = 0, lossPct = 0 } = {}) {
  const d = Math.max(0, rttMs) / 2 + 2 * Math.max(0, jitterMs) + 20;
  const id = d < 160 ? d / 40 : (d - 120) / 10;
  const ppl = Math.max(0, Math.min(100, lossPct));
  const ie = 0 + (95 - 0) * (ppl / (ppl + 20));
  return Math.max(0, Math.min(100, 93.2 - id - ie));
}

export function mosFromR(r) {
  if (r <= 0) return 1;
  if (r >= 100) return 4.5;
  return 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
}

export function estimateMos(sample) {
  return Math.round(mosFromR(rFactor(sample)) * 100) / 100;
}

export function qualityLevel(mos) {
  if (mos >= 4.0) return 'excellent';
  if (mos >= 3.5) return 'good';
  if (mos >= 3.0) return 'fair';
  if (mos >= 2.5) return 'poor';
  return 'bad';
}

export const QUALITY_LABEL = Object.freeze({ excellent: '极佳', good: '良好', fair: '一般', poor: '较差', bad: '很差' });

/**
 * 从一个 RTCPeerConnection 的 getStats() 结果计算本次采样（与上一次计数器做差）
 * @param {Iterable<object>} stats  RTCStatsReport.values()
 * @param {object|null} prev        上一次返回的 state
 * @returns {{ sample: {rttMs, jitterMs, lossPct, inKbps, outKbps, packetsReceived}, state: object }}
 */
export function samplePeerStats(stats, prev = null) {
  let rtt = null;
  let jitter = null;
  let lost = 0;
  let received = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let ts = null;
  let selectedPair = null;
  const pairs = new Map();
  for (const s of stats) {
    if (!s || !s.type) continue;
    if (s.type === 'transport' && s.selectedCandidatePairId) selectedPair = s.selectedCandidatePairId;
    if (s.type === 'candidate-pair') pairs.set(s.id, s);
    if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
      lost += Math.max(0, s.packetsLost || 0);
      received += s.packetsReceived || 0;
      bytesIn += s.bytesReceived || 0;
      if (typeof s.jitter === 'number') jitter = Math.max(jitter ?? 0, s.jitter * 1000);
      ts = s.timestamp ?? ts;
    }
    if (s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
      bytesOut += s.bytesSent || 0;
      ts = ts ?? s.timestamp;
    }
    if (s.type === 'remote-inbound-rtp' && typeof s.roundTripTime === 'number') rtt = s.roundTripTime * 1000;
  }
  let pair = selectedPair ? pairs.get(selectedPair) : null;
  if (!pair) for (const p of pairs.values()) if (p.nominated && p.state === 'succeeded') { pair = p; break; }
  if (rtt === null && pair && typeof pair.currentRoundTripTime === 'number') rtt = pair.currentRoundTripTime * 1000;

  const state = { lost, received, bytesIn, bytesOut, ts };
  let lossPct = 0;
  let inKbps = 0;
  let outKbps = 0;
  if (prev && prev.ts !== null && ts !== null && ts > prev.ts) {
    const dLost = Math.max(0, lost - prev.lost);
    const dRecv = Math.max(0, received - prev.received);
    lossPct = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0;
    const dt = ts - prev.ts;
    inKbps = Math.max(0, ((bytesIn - prev.bytesIn) * 8) / dt);
    outKbps = Math.max(0, ((bytesOut - prev.bytesOut) * 8) / dt);
  }
  return {
    sample: {
      rttMs: rtt === null ? null : Math.round(rtt),
      jitterMs: jitter === null ? null : Math.round(jitter * 10) / 10,
      lossPct: Math.round(lossPct * 100) / 100,
      inKbps: Math.round(inKbps * 10) / 10,
      outKbps: Math.round(outKbps * 10) / 10,
      packetsReceived: received,
    },
    state,
  };
}

/**
 * 汇总各对端采样：RTT/抖动取平均，丢包取最差，MOS 用汇总值计算，另给出最差对端 MOS
 * @param {Array<{rttMs, jitterMs, lossPct, inKbps, outKbps}>} samples
 */
export function aggregateSamples(samples) {
  const valid = (samples || []).filter((s) => s && s.rttMs !== null);
  if (!valid.length) return null;
  const avg = (k) => valid.reduce((a, s) => a + (s[k] || 0), 0) / valid.length;
  const rttMs = Math.round(avg('rttMs'));
  const jitterMs = Math.round(avg('jitterMs') * 10) / 10;
  const lossPct = Math.max(...valid.map((s) => s.lossPct || 0));
  const worstMos = Math.min(...valid.map((s) => estimateMos({ rttMs: s.rttMs, jitterMs: s.jitterMs || 0, lossPct: s.lossPct || 0 })));
  return {
    rttMs, jitterMs, lossPct,
    mos: estimateMos({ rttMs, jitterMs, lossPct }),
    worstMos,
    bitrateKbps: Math.round(valid.reduce((a, s) => a + (s.outKbps || 0), 0) * 10) / 10,
    peers: valid.length,
  };
}

export const MIN_KBPS = 8;
export const MAX_KBPS = 128;

/**
 * 每条发送流的目标码率（kbps）
 *   mesh：对端越多单路越低（上行总量受控）；floor 发言者：上行预算 320kbps 均分给所有听众；质量差时再降
 */
export function targetBitrateKbps({ mode = 'mesh', peers = 1, mos = null } = {}) {
  const n = Math.max(1, peers);
  let base;
  if (mode === 'floor') base = Math.min(24, 320 / n);
  else base = n <= 1 ? 40 : n <= 2 ? 32 : n <= 4 ? 24 : 20;
  if (mos !== null && mos < 3.0) base *= 0.5;
  else if (mos !== null && mos < 3.5) base *= 0.75;
  return Math.max(MIN_KBPS, Math.min(MAX_KBPS, Math.round(base)));
}

/** 码率调整：下降立即生效，上升每次最多 +25%（避免网络恢复瞬间拥塞） */
export function nextBitrate(current, target) {
  if (!current || target <= current) return target;
  return Math.min(target, Math.round(current * 1.25));
}

/**
 * 质量调控：连续 3 次 MOS < 2.5 建议降级为"仅收听"，之后连续 3 次 MOS ≥ 3.2 恢复发送
 */
export class QualityGovernor {
  constructor({ degradeBelow = 2.5, recoverAbove = 3.2, window = 3 } = {}) {
    this.degradeBelow = degradeBelow;
    this.recoverAbove = recoverAbove;
    this.window = window;
    this.history = [];
    this.listenOnly = false;
  }

  /** @returns {'degrade'|'recover'|null} 状态变化 */
  push(mos) {
    if (!Number.isFinite(mos)) return null;
    this.history.push(mos);
    if (this.history.length > this.window) this.history.shift();
    if (this.history.length < this.window) return null;
    if (!this.listenOnly && this.history.every((m) => m < this.degradeBelow)) { this.listenOnly = true; this.history = []; return 'degrade'; }
    if (this.listenOnly && this.history.every((m) => m >= this.recoverAbove)) { this.listenOnly = false; this.history = []; return 'recover'; }
    return null;
  }
}

/** 从 RTCRtpReceiver.getSynchronizationSources() 的 audioLevel 判断是否在说话（带保持时间，避免闪烁） */
export class SpeakingDetector {
  constructor({ threshold = 0.04, holdMs = 400 } = {}) {
    this.threshold = threshold;
    this.holdMs = holdMs;
    this.lastLoud = -Infinity;
    this.speaking = false;
  }

  /** @returns {boolean|null} 状态变化时返回新状态，否则 null */
  update(level, now) {
    if (typeof level === 'number' && level >= this.threshold) this.lastLoud = now;
    const s = now - this.lastLoud <= this.holdMs;
    if (s === this.speaking) return null;
    this.speaking = s;
    return s;
  }
}
