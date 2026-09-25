// shared/anti-cheat.js - GPS 伪造检测与速度限制反作弊系统
'use strict';

const { query } = require('./db');
const { getRedis, getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('anti-cheat');

// ============================================================
// 配置常量
// ============================================================

// 速度阈值（单位：m/s）
const SPEED_LIMITS = {
  WALK: 5,        // 步行：18km/h
  BIKE: 15,       // 骑行：54km/h
  DRIVE: 50,      // 驾车：180km/h
  TELEPORT: 200,  // 瞬移阈值（明显作弊）
  IMPOSSIBLE: 1000 / 3.6, // REQ-00586: 超过 1000 km/h 视为不可能行程
};

// REQ-00586: 位置历史保留 24 小时（原为 1 小时，停止上报 1 小时后再"瞬移"不会被发现）
const LOCATION_HISTORY_TTL_SEC = 24 * 3600;
// REQ-00586: 多账号协同作弊——完全相同的坐标（~1cm）10 分钟内出现 3 个及以上账号
const COLOCATION_WINDOW_SEC = 600;
const COLOCATION_ACCOUNT_THRESHOLD = 3;
// 瞬移后重新建立轨迹基线：候选位置 300 米内连续 3 次、至少跨 2 分钟
const REBASE_RADIUS_M = 300;
const REBASE_MIN_REPORTS = 3;
const REBASE_MIN_SPAN_MS = 2 * 60 * 1000;
// 同一"事件"只扣一次分：30 分钟内的重复严重异常只阻断不重复扣分
const INCIDENT_DEDUP_SEC = 1800;

// 可信度分数配置
const TRUST_SCORE = {
  INITIAL: 100,
  MIN: 0,
  MAX: 100,
  RECOVERY_PER_HOUR: 1,
  PENALTY: {
    SPEED_LOW: 5,        // 轻微速度异常
    SPEED_MEDIUM: 10,    // 中等速度异常
    SPEED_HIGH: 20,      // 严重速度异常
    GPS_FAKE_SUSPECT: 20, // GPS 伪造嫌疑
    GPS_FAKE_CONFIRM: 40, // GPS 伪造确认
    BEHAVIOR_ANOMALY: 15, // 行为异常
  },
  THRESHOLD: {
    NORMAL: 80,      // >= 80：正常
    WARNING: 60,     // >= 60：警告
    RESTRICTED: 40,  // >= 40：功能限制
    BANNED: 0,       // < 40：封禁
  }
};

// 行为频率限制
const ACTION_LIMITS = {
  CATCH: { maxPerMinute: 30, maxPerHour: 500 },
  GYM_BATTLE: { maxPerMinute: 10, maxPerHour: 100 },
  ITEM_USE: { maxPerMinute: 60, maxPerHour: 1000 },
  LOCATION_REPORT: { maxPerMinute: 120, maxPerHour: 7200 },
};

// ============================================================
// Prometheus 指标
// ============================================================

const register = new promClient.Registry();

const metrics = {
  blockedAttempts: new promClient.Counter({
    name: 'minego_anticheat_blocked_total',
    help: 'Total blocked attempts by type and severity',
    labelNames: ['type', 'severity'],
    registers: [register],
  }),

  trustScoreHistogram: new promClient.Histogram({
    name: 'minego_anticheat_trust_score',
    help: 'User trust score distribution',
    buckets: [0, 20, 40, 60, 80, 100],
    registers: [register],
  }),

  speedAnomalyCounter: new promClient.Counter({
    name: 'minego_anticheat_speed_anomaly_total',
    help: 'Speed anomaly detections by severity',
    labelNames: ['severity'],
    registers: [register],
  }),

  locationReportCounter: new promClient.Counter({
    name: 'minego_anticheat_location_report_total',
    help: 'Total location reports',
    labelNames: ['status'], // 'valid', 'anomaly', 'blocked'
    registers: [register],
  }),

  trustScoreAdjustment: new promClient.Counter({
    name: 'minego_anticheat_trust_adjustment_total',
    help: 'Trust score adjustments',
    labelNames: ['direction', 'reason'], // 'up', 'down'
    registers: [register],
  }),
};

// ============================================================
// 工具函数
// ============================================================

/**
 * Haversine 公式计算两点间距离（单位：米）
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 地球半径（米）
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * 计算速度（单位：m/s）
 */
function calculateSpeed(lat1, lon1, t1, lat2, lon2, t2) {
  const distance = haversineDistance(lat1, lon1, lat2, lon2);
  const timeDiff = Math.abs(t2 - t1) / 1000; // 转换为秒
  if (timeDiff < 0.001) return distance > 10 ? Infinity : 0; // 防止除零
  return distance / timeDiff;
}

/**
 * 判断速度异常级别
 */
function getSpeedAnomalyLevel(speed) {
  if (speed > SPEED_LIMITS.TELEPORT) return 'CRITICAL';
  if (speed > SPEED_LIMITS.DRIVE) return 'HIGH';
  if (speed > SPEED_LIMITS.BIKE) return 'MEDIUM';
  if (speed > SPEED_LIMITS.WALK) return 'LOW';
  return null;
}

/**
 * 获取速度异常对应的惩罚分数
 */
function getSpeedPenalty(level) {
  switch (level) {
    case 'CRITICAL': return TRUST_SCORE.PENALTY.SPEED_HIGH * 2;
    case 'HIGH': return TRUST_SCORE.PENALTY.SPEED_HIGH;
    case 'MEDIUM': return TRUST_SCORE.PENALTY.SPEED_MEDIUM;
    case 'LOW': return TRUST_SCORE.PENALTY.SPEED_LOW;
    default: return 0;
  }
}

// ============================================================
// 核心检测函数
// ============================================================

/**
 * 检测速度异常
 * @param {number} userId - 用户ID
 * @param {number} lat - 新纬度
 * @param {number} lng - 新经度
 * @param {number} timestamp - 时间戳（毫秒）
 * @returns {Promise<Object>} 检测结果
 */
async function checkSpeedAnomaly(userId, lat, lng, timestamp = Date.now()) {
  const redis = getRedis();
  const historyKey = `anticheat:location:${userId}`;

  // 获取最近位置记录
  const history = await getJSON(historyKey) || [];

  if (history.length === 0) {
    // 首次记录，无异常
    await setJSON(historyKey, [{ lat, lng, timestamp }], LOCATION_HISTORY_TTL_SEC);
    return { isAnomaly: false, speed: 0, level: null };
  }

  // 取最近一条记录
  const last = history[history.length - 1];
  const speed = calculateSpeed(last.lat, last.lng, last.timestamp, lat, lng, timestamp);
  const distance = haversineDistance(last.lat, last.lng, lat, lng);
  const level = getSpeedAnomalyLevel(speed);

  // 更新历史记录（保留最近 20 条）。瞬移/不可能行程的点先不写入可信轨迹（避免伪造点污染轨迹），
  // 而是记为"候选新位置"：同一位置附近连续 REBASE_MIN_REPORTS 次、跨度 ≥ REBASE_MIN_SPAN_MS 的上报
  // （例如乘飞机落地后）会被接受为新的轨迹起点，不再持续判为瞬移。
  const severe = level === 'CRITICAL' || speed > SPEED_LIMITS.IMPOSSIBLE;
  if (!severe) {
    const newHistory = [...history, { lat, lng, timestamp }].slice(-20);
    await setJSON(historyKey, newHistory, LOCATION_HISTORY_TTL_SEC);
    await redis.del(`anticheat:candidate:${userId}`);
  } else {
    const candKey = `anticheat:candidate:${userId}`;
    const cand = await getJSON(candKey);
    if (cand && haversineDistance(cand.lat, cand.lng, lat, lng) <= REBASE_RADIUS_M) {
      cand.count += 1;
      cand.lat = lat; cand.lng = lng;
      if (cand.count >= REBASE_MIN_REPORTS && timestamp - cand.firstTs >= REBASE_MIN_SPAN_MS) {
        await setJSON(historyKey, [{ lat, lng, timestamp }], LOCATION_HISTORY_TTL_SEC);
        await redis.del(candKey);
        logger.info({ userId, lat, lng, reports: cand.count }, 'Location trajectory re-baselined');
        return { isAnomaly: false, speed: 0, level: null, rebased: true };
      }
      await setJSON(candKey, cand, 1800);
    } else {
      await setJSON(candKey, { lat, lng, firstTs: timestamp, count: 1 }, 1800);
    }
  }

  const result = {
    isAnomaly: !!level,
    speed: Math.round(speed * 100) / 100,
    speedKmh: Math.round(speed * 3.6),
    distance: Math.round(distance),
    level,
    impossible: speed > SPEED_LIMITS.IMPOSSIBLE, // REQ-00586: 不可能行程
    timeDiff: Math.round((timestamp - last.timestamp) / 1000),
  };

  if (level) {
    metrics.speedAnomalyCounter.inc({ severity: level });
    logger.warn({ userId, ...result }, 'Speed anomaly detected');
  }

  return result;
}

/**
 * 检测 GPS 伪造特征
 * @param {Object} locationData - 位置数据
 * @returns {Object} 检测结果
 */
function detectFakeGPS(locationData) {
  const { accuracy, altitude, isMock, speedHistory = [], clientSignals } = locationData;
  const indicators = [];

  // 1. 系统标记为模拟位置
  if (isMock) {
    indicators.push({ type: 'MOCK_LOCATION_FLAG', severity: 'CRITICAL' });
  }

  // 2. 精度可疑（过于精确可能是伪造）
  if (accuracy && accuracy < 3) {
    indicators.push({ type: 'ACCURACY_SUSPICIOUS', severity: 'LOW', detail: `accuracy=${accuracy}m` });
  }

  // 3. 速度历史异常（连续高速移动）
  if (speedHistory.length >= 3) {
    const highSpeedCount = speedHistory.filter(s => s > SPEED_LIMITS.DRIVE).length;
    if (highSpeedCount >= 2) {
      indicators.push({ type: 'CONTINUOUS_HIGH_SPEED', severity: 'HIGH', detail: `${highSpeedCount} high speed records` });
    }
  }

  // 4. 客户端采集的定位信号（REQ-00586，Web 客户端 LocationManager 上报；原生客户端可额外上报系统 mock 标记）
  const cs = clientSignals && typeof clientSignals === 'object' ? clientSignals : null;
  if (cs) {
    if (cs.webdriver === true) {
      indicators.push({ type: 'AUTOMATION_DETECTED', severity: 'HIGH', detail: 'navigator.webdriver' });
    }
    // 真实 GPS 有米级抖动：连续大量样本坐标完全不变且精度恒定，是模拟定位/传感器覆盖的典型特征
    const samples = Number(cs.samples) || 0;
    if (samples >= 10 && Number(cs.identicalFixes) >= samples - 1 && cs.accuracyConstant === true) {
      indicators.push({ type: 'STATIC_SPOOFED_FIXES', severity: 'MEDIUM', detail: `${cs.identicalFixes}/${samples} identical fixes` });
    }
    if (Number(cs.nonMonotonicTimestamps) > 0) {
      indicators.push({ type: 'TIMESTAMP_ANOMALY', severity: 'MEDIUM', detail: `${cs.nonMonotonicTimestamps} non-monotonic` });
    }
    if (cs.accuracyZero === true) {
      indicators.push({ type: 'ACCURACY_ZERO', severity: 'MEDIUM' });
    }
  }

  const RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  return {
    isFake: indicators.length > 0,
    indicators,
    severity: indicators.length > 0
      ? indicators.reduce((max, i) => (RANK[i.severity] > RANK[max] ? i.severity : max), 'LOW')
      : null,
  };
}

/**
 * 地形校验（REQ-00586）：坐标是否落在水域/禁入区域（geo_restricted_zones）
 * 结果按约 100m 网格缓存 10 分钟；表不存在或查询失败时视为未命中（不影响主流程）
 * @returns {Promise<{kind: string, name: string}|null>}
 */
async function checkTerrain(lat, lng) {
  const cell = `${lat.toFixed(3)}:${lng.toFixed(3)}`;
  const redis = getRedis();
  const cacheKey = `anticheat:terrain:${cell}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return cached === '' ? null : JSON.parse(cached);
    const { rows } = await query(
      `SELECT kind, name FROM geo_restricted_zones
        WHERE active AND ST_Intersects(area, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)
        ORDER BY CASE kind WHEN 'restricted' THEN 0 ELSE 1 END LIMIT 1`, [lat, lng]);
    const hit = rows[0] ? { kind: rows[0].kind, name: rows[0].name } : null;
    await redis.set(cacheKey, hit ? JSON.stringify(hit) : '', 'EX', 600);
    return hit;
  } catch (err) {
    logger.warn({ err: err.message }, 'terrain check failed');
    return null;
  }
}

/** 申诉通过后恢复可信度到初始值（记录调整原因） */
async function restoreTrustScore(userId, reason = 'APPEAL_APPROVED') {
  const current = await getTrustScore(userId);
  if (current >= TRUST_SCORE.INITIAL) return current;
  return updateTrustScore(userId, TRUST_SCORE.INITIAL - current, reason);
}

/**
 * 获取用户可信度分数
 * @param {number} userId - 用户ID
 * @returns {Promise<number>} 可信度分数
 */
async function getTrustScore(userId) {
  const redis = getRedis();
  const key = `anticheat:trust:${userId}`;
  const score = await redis.get(key);

  if (score === null) {
    // 初始化分数
    await redis.set(key, TRUST_SCORE.INITIAL);
    return TRUST_SCORE.INITIAL;
  }

  return parseInt(score, 10);
}

/**
 * 更新用户可信度分数
 * @param {number} userId - 用户ID
 * @param {number} delta - 变化量（正数增加，负数减少）
 * @param {string} reason - 原因
 * @returns {Promise<number>} 新分数
 */
async function updateTrustScore(userId, delta, reason) {
  const redis = getRedis();
  const key = `anticheat:trust:${userId}`;

  const current = await getTrustScore(userId);
  const newScore = Math.max(TRUST_SCORE.MIN, Math.min(TRUST_SCORE.MAX, current + delta));

  await redis.set(key, newScore);

  // 记录调整
  const direction = delta > 0 ? 'up' : 'down';
  metrics.trustScoreAdjustment.inc({ direction, reason });
  metrics.trustScoreHistogram.observe(newScore);

  // 记录到数据库
  try {
    await query(`
      INSERT INTO anti_cheat_records (user_id, type, severity, details, trust_score_before, trust_score_after)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      userId,
      delta < 0 ? 'TRUST_DECREASE' : 'TRUST_INCREASE',
      Math.abs(delta) >= 20 ? 'HIGH' : Math.abs(delta) >= 10 ? 'MEDIUM' : 'LOW',
      JSON.stringify({ reason, delta }),
      current,
      newScore,
    ]);
  } catch (err) {
    logger.error({ err, userId }, 'Failed to record trust score change');
  }

  logger.info({ userId, current, newScore, delta, reason }, 'Trust score updated');

  return newScore;
}

/**
 * 记录作弊行为
 * @param {number} userId - 用户ID
 * @param {string} type - 作弊类型
 * @param {string} severity - 严重程度
 * @param {Object} details - 详细信息
 * @returns {Promise<void>}
 */
async function recordCheatAttempt(userId, type, severity, details = {}) {
  const penalty = type === 'SPEED_ANOMALY'
    ? getSpeedPenalty(severity)
    : type === 'IMPOSSIBLE_TRAVEL'
      ? TRUST_SCORE.PENALTY.SPEED_HIGH * 2
      : type === 'GPS_FAKE'
        ? TRUST_SCORE.PENALTY.GPS_FAKE_CONFIRM
        : type === 'GPS_FAKE_SUSPECT'
          ? TRUST_SCORE.PENALTY.GPS_FAKE_SUSPECT
          : ['TERRAIN_WATER', 'TERRAIN_RESTRICTED', 'CLIENT_SIGNAL_ANOMALY'].includes(type)
            ? TRUST_SCORE.PENALTY.SPEED_LOW
            : TRUST_SCORE.PENALTY.BEHAVIOR_ANOMALY;

  const scoreBefore = await getTrustScore(userId);
  const scoreAfter = await updateTrustScore(userId, -penalty, type);

  metrics.blockedAttempts.inc({ type, severity });

  try {
    await query(`
      INSERT INTO anti_cheat_records (user_id, type, severity, details, trust_score_before, trust_score_after, action_taken)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      userId,
      type,
      severity,
      JSON.stringify(details),
      scoreBefore,
      scoreAfter,
      scoreAfter < TRUST_SCORE.THRESHOLD.RESTRICTED ? 'BAN' : scoreAfter < TRUST_SCORE.THRESHOLD.WARNING ? 'THROTTLE' : 'WARN',
    ]);
  } catch (err) {
    logger.error({ err, userId, type }, 'Failed to record cheat attempt');
  }

  logger.warn({ userId, type, severity, penalty, scoreAfter }, 'Cheat attempt recorded');
}

/**
 * 检查行为频率
 * @param {number} userId - 用户ID
 * @param {string} actionType - 行为类型
 * @returns {Promise<Object>} 检查结果
 */
async function checkActionRate(userId, actionType) {
  const redis = getRedis();
  const limits = ACTION_LIMITS[actionType];

  if (!limits) return { allowed: true };

  const now = Date.now();
  const minuteKey = `anticheat:rate:${actionType}:${userId}:minute`;
  const hourKey = `anticheat:rate:${actionType}:${userId}:hour`;

  // 获取当前计数
  const [minuteCount, hourCount] = await Promise.all([
    redis.get(minuteKey),
    redis.get(hourKey),
  ]);

  const minuteNum = parseInt(minuteCount || '0', 10);
  const hourNum = parseInt(hourCount || '0', 10);

  // 检查是否超限
  if (minuteNum >= limits.maxPerMinute || hourNum >= limits.maxPerHour) {
    return {
      allowed: false,
      reason: minuteNum >= limits.maxPerMinute ? 'RATE_LIMIT_MINUTE' : 'RATE_LIMIT_HOUR',
      current: { minute: minuteNum, hour: hourNum },
      limit: limits,
    };
  }

  // 增加计数
  const pipeline = redis.pipeline();
  pipeline.incr(minuteKey);
  pipeline.expire(minuteKey, 60);
  pipeline.incr(hourKey);
  pipeline.expire(hourKey, 3600);
  await pipeline.exec();

  return { allowed: true };
}

// ============================================================
// Express 中间件
// ============================================================

/**
 * 位置验证中间件
 * 验证用户位置是否合理，检测速度异常和 GPS 伪造
 */
/**
 * REQ-00586: 多账号同坐标检测
 * 真实 GPS 存在抖动，多个不同账号在 10 分钟内上报完全相同的坐标（7 位小数 ≈ 1 厘米）是虚拟定位/多开的典型特征。
 * @returns {Promise<{flagged: boolean, accounts: number}>}
 */
async function checkColocation(userId, lat, lng) {
  const redis = getRedis();
  // 7 位小数 ≈ 1 厘米：不同设备的真实 GPS 几乎不可能给出完全相同的坐标，而虚拟定位常复用同一组数值；
  // 用 5 位（≈1 米）会误伤聚集在热门补给站/道馆的真实玩家
  const key = `anticheat:coloc:${lat.toFixed(7)}:${lng.toFixed(7)}`;
  await redis.sadd(key, String(userId));
  await redis.expire(key, COLOCATION_WINDOW_SEC);
  const accounts = await redis.scard(key);
  return { flagged: accounts >= COLOCATION_ACCOUNT_THRESHOLD, accounts };
}

/**
 * REQ-00586: 按可信度分数给出风险等级，供业务侧降级使用
 */
function getRiskLevel(score) {
  if (score >= TRUST_SCORE.THRESHOLD.NORMAL) return 'LOW';
  if (score >= TRUST_SCORE.THRESHOLD.WARNING) return 'MEDIUM';
  if (score >= TRUST_SCORE.THRESHOLD.RESTRICTED) return 'HIGH';
  return 'CRITICAL';
}

function validateLocation(req, res, next) {
  return (async () => {
    const body = req.body || {};
    const { accuracy, altitude, isMock, clientSignals } = body;
    // 兼容捕捉接口的 playerLat/playerLng（原实现只读 lat/lng，捕捉时从未执行反作弊校验）。
    // 两组坐标同时出现时必须一致，否则可以"用一组坐标过风控、另一组坐标做业务"。
    const pick = (a, b) => (a !== undefined && a !== null ? a : b);
    const rawLat = pick(body.playerLat, body.lat);
    const rawLng = pick(body.playerLng, body.lng);

    // 如果没有位置信息，跳过验证（坐标必填与否由业务接口决定）
    if (rawLat === undefined || rawLat === null || rawLng === undefined || rawLng === null) {
      return next();
    }
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    const conflict = (body.lat != null && body.playerLat != null && Number(body.lat) !== lat) ||
                     (body.lng != null && body.playerLng != null && Number(body.lng) !== lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || conflict) {
      return res.status(400).json({ code: 1001, message: '位置坐标无效', data: null });
    }

    const userId = req.user?.sub;
    if (!userId) {
      return next(); // 无用户信息，跳过
    }

    try {
      // 1. 检测速度异常
      const speedResult = await checkSpeedAnomaly(userId, lat, lng, Date.now());

      // 2. 检测 GPS 伪造
      const fakeResult = detectFakeGPS({ accuracy, altitude, isMock, clientSignals });

      // 3. 获取可信度分数
      const trustScore = await getTrustScore(userId);

      // 4. 判断是否需要阻止
      let blocked = false;
      let blockedReason = null;

      // 可信度过低直接阻止
      if (trustScore < TRUST_SCORE.THRESHOLD.RESTRICTED) {
        blocked = true;
        blockedReason = 'LOW_TRUST_SCORE';
      }

      // 严重速度异常 / 不可能行程（REQ-00586）。同一事件 30 分钟内只扣一次分，之后仅阻断
      const redis = getRedis();
      const firstInIncident = async (kind) =>
        !!(await redis.set(`anticheat:incident:${userId}:${kind}`, '1', 'EX', INCIDENT_DEDUP_SEC, 'NX'));
      if (speedResult.impossible) {
        if (await firstInIncident('travel')) await recordCheatAttempt(userId, 'IMPOSSIBLE_TRAVEL', 'CRITICAL', speedResult);
        blocked = true;
        blockedReason = 'IMPOSSIBLE_TRAVEL';
      } else if (speedResult.level === 'CRITICAL' || speedResult.level === 'HIGH') {
        if (await firstInIncident(`speed-${speedResult.level}`)) {
          await recordCheatAttempt(userId, 'SPEED_ANOMALY', speedResult.level, speedResult);
        }
        if (speedResult.level === 'CRITICAL') {
          blocked = true;
          blockedReason = 'SPEED_ANOMALY_CRITICAL';
        }
      }

      // 多账号同坐标（REQ-00586）：只记录并扣分，不直接阻断（避免误伤同一地点的真实玩家）；同一坐标只记一次
      const coloc = await checkColocation(userId, lat, lng);
      if (coloc.flagged && await firstInIncident(`coloc:${lat.toFixed(7)}:${lng.toFixed(7)}`)) {
        await recordCheatAttempt(userId, 'MULTI_ACCOUNT_COLOCATION', 'MEDIUM', { lat, lng, accounts: coloc.accounts });
      }

      // GPS 伪造检测：CRITICAL（系统 mock 标记）阻断；HIGH（自动化工具等）记录扣分但不阻断；同类事件 30 分钟只记一次
      if (fakeResult.isFake && fakeResult.severity === 'CRITICAL') {
        await recordCheatAttempt(userId, 'GPS_FAKE', 'HIGH', fakeResult);
        blocked = true;
        blockedReason = 'GPS_FAKE_DETECTED';
      } else if (fakeResult.isFake && fakeResult.severity === 'HIGH' && await firstInIncident('fake-high')) {
        await recordCheatAttempt(userId, 'GPS_FAKE_SUSPECT', 'HIGH', fakeResult);
      } else if (fakeResult.isFake && fakeResult.severity === 'MEDIUM' && await firstInIncident('fake-medium')) {
        await recordCheatAttempt(userId, 'CLIENT_SIGNAL_ANOMALY', 'MEDIUM', fakeResult);
      }

      // 地形校验：落在水域/禁入区域 → 记录（同一区域 30 分钟一次），不直接阻断
      const terrain = await checkTerrain(lat, lng);
      if (terrain && await firstInIncident(`terrain:${terrain.name}`)) {
        await recordCheatAttempt(userId, terrain.kind === 'water' ? 'TERRAIN_WATER' : 'TERRAIN_RESTRICTED', 'MEDIUM', { lat, lng, zone: terrain.name });
      }

      // 记录位置到数据库（异步；user_id 为 UUID，见迁移 20260924_110000）
      query(`
        INSERT INTO user_location_history (user_id, lat, lng, accuracy, altitude, is_mock, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [userId, lat, lng, accuracy || null, altitude || null, isMock || false]).catch(() => {});

      // 更新指标
      metrics.locationReportCounter.inc({ status: blocked ? 'blocked' : speedResult.isAnomaly ? 'anomaly' : 'valid' });

      // 设置结果到请求对象
      req.antiCheat = {
        trustScore,
        riskLevel: getRiskLevel(trustScore),
        speedResult,
        fakeResult,
        terrain,
        blocked,
        blockedReason,
      };

      // 设置响应头警告
      if (speedResult.isAnomaly && !blocked) {
        res.setHeader('X-Anti-Cheat-Warning', `Speed anomaly: ${speedResult.speed}m/s`);
      }

      if (blocked) {
        return res.status(403).json({
          code: 6001,
          message: '位置验证失败，请确保使用真实GPS',
          data: { reason: blockedReason, trustScore },
        });
      }

      next();
    } catch (err) {
      logger.error({ err, userId }, 'Anti-cheat validation failed');
      next(); // 出错时不阻止请求
    }
  })();
}

/**
 * 可信度检查中间件
 * @param {number} minScore - 最低可信度分数
 */
function requireTrustScore(minScore) {
  return async (req, res, next) => {
    const userId = req.user?.sub;
    if (!userId) return next();

    try {
      const score = await getTrustScore(userId);

      if (score < minScore) {
        return res.status(403).json({
          code: 6002,
          message: `可信度过低（当前：${score}，需要：${minScore}），功能受限`,
          data: { trustScore: score, required: minScore },
        });
      }

      req.trustScore = score;
      next();
    } catch (err) {
      logger.error({ err, userId }, 'Trust score check failed');
      next();
    }
  };
}

/**
 * 行为频率检查中间件
 * @param {string} actionType - 行为类型
 */
function checkRateLimit(actionType) {
  return async (req, res, next) => {
    const userId = req.user?.sub;
    if (!userId) return next();

    try {
      const result = await checkActionRate(userId, actionType);

      if (!result.allowed) {
        return res.status(429).json({
          code: 6003,
          message: '操作过于频繁，请稍后再试',
          data: { reason: result.reason, current: result.current, limit: result.limit },
        });
      }

      next();
    } catch (err) {
      logger.error({ err, userId, actionType }, 'Rate limit check failed');
      next();
    }
  };
}

// ============================================================
// 可信度恢复任务（定时任务调用）
// ============================================================

/**
 * 恢复用户可信度（每小时调用一次）
 * 正常用户分数 +1，上限 100
 */
async function recoverTrustScores() {
  const redis = getRedis();

  try {
    // 获取所有可信度键（SCAN，避免 KEYS 阻塞 Redis）
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'anticheat:trust:*', 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    for (const key of keys) {
      const score = parseInt(await redis.get(key), 10);
      if (score < TRUST_SCORE.MAX) {
        const newScore = Math.min(TRUST_SCORE.MAX, score + TRUST_SCORE.RECOVERY_PER_HOUR);
        await redis.set(key, newScore);
        logger.debug({ key, score, newScore }, 'Trust score recovered');
      }
    }

    logger.info({ count: keys.length }, 'Trust score recovery completed');
  } catch (err) {
    logger.error({ err }, 'Trust score recovery failed');
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  checkTerrain,
  restoreTrustScore,
  // 配置
  SPEED_LIMITS,
  TRUST_SCORE,
  ACTION_LIMITS,

  // 核心函数
  haversineDistance,
  calculateSpeed,
  checkSpeedAnomaly,
  detectFakeGPS,
  getTrustScore,
  updateTrustScore,
  recordCheatAttempt,
  checkActionRate,
  checkColocation,
  getRiskLevel,

  // 中间件
  validateLocation,
  requireTrustScore,
  checkRateLimit,

  // 定时任务
  recoverTrustScores,

  // 指标
  metrics,
  metricsRegister: register,
};
