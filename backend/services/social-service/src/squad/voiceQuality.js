/**
 * 语音质量评估（REQ-00558）——纯函数
 *
 * MOS 按 ITU-T G.107 E-model 的简化形式估算（与客户端 frontend/game-client/src/voice/voiceQuality.js 同一算法，
 * 单测校验两端一致）：
 *   单向时延 d = RTT/2 + 2·抖动 + 20ms（Opus 20ms 帧 + 抖动缓冲）
 *   时延损伤 Id = d/40（d < 160ms）或 (d − 120)/10（d ≥ 160ms）
 *   丢包损伤 Ie_eff = Ie + (95 − Ie)·Ppl/(Ppl + Bpl)，Opus 取 Ie = 0、Bpl = 20（开启 in-band FEC）
 *   R = 93.2 − Id − Ie_eff，限制在 [0, 100]
 *   MOS = 1 + 0.035R + 7·10⁻⁶·R(R − 60)(100 − R)，R ≤ 0 → 1，R ≥ 100 → 4.5
 * 服务端不信任客户端上报的 MOS，按上报的 RTT/抖动/丢包重新计算后再计入指标。
 */
'use strict';

const CODEC = Object.freeze({ opus: { ie: 0, bpl: 20, frameMs: 20 } });

function rFactor({ rttMs = 0, jitterMs = 0, lossPct = 0, codec = 'opus' } = {}) {
  const c = CODEC[codec] || CODEC.opus;
  const d = Math.max(0, rttMs) / 2 + 2 * Math.max(0, jitterMs) + c.frameMs;
  const id = d < 160 ? d / 40 : (d - 120) / 10;
  const ppl = Math.max(0, Math.min(100, lossPct));
  const ie = c.ie + (95 - c.ie) * (ppl / (ppl + c.bpl));
  return Math.max(0, Math.min(100, 93.2 - id - ie));
}

function mosFromR(r) {
  if (r <= 0) return 1;
  if (r >= 100) return 4.5;
  return 1 + 0.035 * r + 7e-6 * r * (r - 60) * (100 - r);
}

function estimateMos(sample) {
  return Math.round(mosFromR(rFactor(sample)) * 100) / 100;
}

function qualityLevel(mos) {
  if (mos >= 4.0) return 'excellent';
  if (mos >= 3.5) return 'good';
  if (mos >= 3.0) return 'fair';
  if (mos >= 2.5) return 'poor';
  return 'bad';
}

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/**
 * 校验客户端上报的质量样本；非法字段 → null。服务端重算 MOS（mosServer），保留客户端值（mosClient）用于排查偏差。
 * @returns {object|null}
 */
function validateSample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rttMs = num(raw.rttMs, 0, 10000);
  const jitterMs = num(raw.jitterMs, 0, 5000);
  const lossPct = num(raw.lossPct, 0, 100);
  if (rttMs === null || jitterMs === null || lossPct === null) return null;
  const mode = raw.mode === 'floor' ? 'floor' : 'mesh';
  return {
    rttMs, jitterMs, lossPct, mode,
    bitrateKbps: num(raw.bitrateKbps, 0, 1024),
    peers: Math.floor(num(raw.peers, 0, 32) || 0),
    mosClient: num(raw.mos, 1, 5),
    mosServer: estimateMos({ rttMs, jitterMs, lossPct }),
  };
}

/** 一次语音会话的质量汇总（离开语音时写 voice_sessions） */
class SessionAggregate {
  constructor({ mode = 'mesh', joinedAt = new Date() } = {}) {
    this.mode = mode;
    this.joinedAt = joinedAt;
    this.samples = 0;
    this.sum = { rtt: 0, jitter: 0, loss: 0, mos: 0 };
    this.maxRtt = null;
    this.minMos = null;
    this.reconnectAttempts = 0;
    this.reconnectSuccesses = 0;
  }

  add(s) {
    this.samples++;
    this.mode = s.mode || this.mode;
    this.sum.rtt += s.rttMs;
    this.sum.jitter += s.jitterMs;
    this.sum.loss += s.lossPct;
    this.sum.mos += s.mosServer;
    this.maxRtt = this.maxRtt === null ? s.rttMs : Math.max(this.maxRtt, s.rttMs);
    this.minMos = this.minMos === null ? s.mosServer : Math.min(this.minMos, s.mosServer);
  }

  reconnect(success) {
    this.reconnectAttempts++;
    if (success) this.reconnectSuccesses++;
  }

  summary() {
    const n = this.samples;
    const avg = (v) => (n ? Math.round((v / n) * 100) / 100 : null);
    return {
      mode: this.mode,
      joinedAt: this.joinedAt,
      samples: n,
      avgRttMs: avg(this.sum.rtt),
      maxRttMs: this.maxRtt,
      avgJitterMs: avg(this.sum.jitter),
      avgLossPct: avg(this.sum.loss),
      avgMos: avg(this.sum.mos),
      minMos: this.minMos,
      reconnectAttempts: this.reconnectAttempts,
      reconnectSuccesses: this.reconnectSuccesses,
    };
  }
}

/** UA → 浏览器族（只保留族名，不存完整 UA） */
function browserFamily(ua) {
  const s = String(ua || '');
  if (/Edg\//.test(s)) return 'edge';
  if (/Firefox\//.test(s)) return 'firefox';
  if (/Chrome\//.test(s) || /CriOS\//.test(s)) return 'chrome';
  if (/Safari\//.test(s)) return 'safari';
  return 'other';
}

module.exports = { rFactor, mosFromR, estimateMos, qualityLevel, validateSample, SessionAggregate, browserFamily };
