# REQ-00028：玩家行为异常模式智能检测系统

- **编号**：REQ-00028
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、catch-service、gym-service、social-service、backend/shared/anti-cheat.js、database/migrations
- **创建时间**：2026-06-05 20:00
- **依赖需求**：REQ-00010（GPS伪造检测与速度限制）

## 1. 背景与问题

REQ-00010 已实现 GPS 伪造检测和速度限制，但存在以下新型作弊手段无法被当前系统识别：

1. **捕捉成功率异常**：正常玩家稀有精灵捕捉成功率约 5-15%，作弊者通过修改客户端可实现 100% 捕获
2. **行动轨迹模式异常**：作弊者往往呈现不自然的移动模式（直线、完美圆弧、重复路径）
3. **战斗胜率异常**：道馆挑战胜率远超正常范围，可能存在伤害修改
4. **资源获取异常**：星尘、金币等资源增长曲线不符合正常游戏行为
5. **时段行为异常**：24小时不间断游戏、固定间隔执行操作（脚本特征）
6. **设备指纹异常**：多账号共用同一设备刷资源（群控特征）

当前系统仅基于单点位置验证，缺乏对玩家行为的纵向分析和横向对比。

## 2. 目标

构建多层次行为异常检测系统，实现：

- **捕捉行为分析**：基于精灵稀有度、玩家等级、道具使用计算期望成功率，检测异常偏差
- **移动轨迹分析**：识别非人类移动模式（直线度、转向频率、停留时间分布）
- **战斗数据分析**：检测伤害异常、闪避异常、获胜概率异常
- **资源流分析**：追踪资源获取与消耗，识别异常增长
- **时段分析**：识别脚本式固定间隔操作、24小时在线行为
- **设备关联分析**：检测多账号同设备、群控特征

预期效果：识别 REQ-00010 无法检测的新型作弊行为，阻止 90%+ 客户端修改器和脚本作弊。

## 3. 范围

- **包含**：
  - 捕捉成功率统计与异常检测算法
  - 移动轨迹特征提取与分析
  - 战斗数据合理性校验
  - 资源增长曲线监控
  - 时段行为模式识别
  - 设备指纹收集与关联分析
  - 行为基线建模（基于统计分布）
  - 异常告警与自动处置
  - 管理后台行为分析面板

- **不包含**：
  - 机器学习模型训练（需大量标注数据，后续需求）
  - 实时视频流分析
  - 第三方反作弊服务集成
  - 跨游戏数据共享

## 4. 详细需求

### 4.1 捕捉成功率异常检测

```javascript
// 捕捉成功率模型
const CATCH_RATE_MODEL = {
  // 基础捕获率（按稀有度）
  BASE_RATES: {
    COMMON: 0.50,      // 常见
    UNCOMMON: 0.30,    // 较少见
    RARE: 0.15,        // 稀有
    EPIC: 0.08,        // 史诗
    LEGENDARY: 0.03,   // 传说
  },
  
  // 道具加成
  ITEM_BONUS: {
    GREAT_BALL: 1.5,
    ULTRA_BALL: 2.0,
    RAZZ_BERRY: 1.5,
    GOLDEN_RAZZ: 2.5,
  },
  
  // 技术加成（曲线球、精准投掷）
  TECHNIQUE_BONUS: {
    CURVEBALL: 1.7,
    NICE: 1.0,
    GREAT: 1.3,
    EXCELLENT: 1.7,
  },
  
  // 等级修正（高级玩家有轻微加成）
  LEVEL_BONUS: (level) => Math.min(1 + level * 0.005, 1.2),
};

// 计算期望捕获率
function calculateExpectedCatchRate(pokemon, player, items, technique) {
  let rate = CATCH_RATE_MODEL.BASE_RATES[pokemon.rarity];
  rate *= CATCH_RATE_MODEL.LEVEL_BONUS(player.level);
  
  items.forEach(item => {
    rate *= CATCH_RATE_MODEL.ITEM_BONUS[item] || 1;
  });
  
  rate *= CATCH_RATE_MODEL.TECHNIQUE_BONUS[technique] || 1;
  
  return Math.min(rate, 0.95); // 最大 95%
}

// 异常检测：实际成功率 vs 期望成功率
async function analyzeCatchAnomaly(userId, period = '24h') {
  const stats = await query(`
    SELECT 
      COUNT(*) as total_attempts,
      SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
      AVG(expected_rate) as avg_expected_rate,
      p.rarity
    FROM catch_attempts ca
    JOIN pokemons p ON ca.pokemon_id = p.id
    WHERE ca.user_id = $1 AND ca.created_at > NOW() - INTERVAL '${period}'
    GROUP BY p.rarity
  `, [userId]);
  
  const anomalies = [];
  
  for (const stat of stats) {
    const actualRate = stat.successful / stat.total_attempts;
    const expectedRate = stat.avg_expected_rate;
    
    // 计算偏差
    const deviation = (actualRate - expectedRate) / expectedRate;
    
    // 统计显著性检验（二项分布）
    const zScore = (stat.successful - stat.total_attempts * expectedRate) 
      / Math.sqrt(stat.total_attempts * expectedRate * (1 - expectedRate));
    
    if (zScore > 3.0 && deviation > 0.5) { // 99.7% 置信度，偏差 > 50%
      anomalies.push({
        type: 'CATCH_RATE_ANOMALY',
        rarity: stat.rarity,
        actualRate,
        expectedRate,
        deviation,
        zScore,
        severity: deviation > 1.0 ? 'HIGH' : 'MEDIUM',
      });
    }
  }
  
  return anomalies;
}
```

### 4.2 移动轨迹分析

```javascript
// 轨迹特征提取
function extractTrajectoryFeatures(locations) {
  if (locations.length < 3) return null;
  
  const features = {
    avgSpeed: 0,
    maxSpeed: 0,
    avgTurnAngle: 0,
    straightnessRatio: 0,  // 直线度（0-1，越接近1越直）
    revisitCount: 0,        // 重访位置数
    avgStayDuration: 0,     // 平均停留时长
    pathEfficiency: 0,      // 路径效率（实际距离/直线距离）
  };
  
  // 计算速度
  const speeds = [];
  for (let i = 1; i < locations.length; i++) {
    const speed = calculateSpeed(
      locations[i-1].lat, locations[i-1].lng, locations[i-1].timestamp,
      locations[i].lat, locations[i].lng, locations[i].timestamp
    );
    speeds.push(speed);
  }
  features.avgSpeed = average(speeds);
  features.maxSpeed = Math.max(...speeds);
  
  // 计算转向角度
  const turnAngles = [];
  for (let i = 2; i < locations.length; i++) {
    const angle = calculateTurnAngle(
      locations[i-2], locations[i-1], locations[i]
    );
    turnAngles.push(angle);
  }
  features.avgTurnAngle = average(turnAngles);
  
  // 直线度（路径长度 / 起终点直线距离）
  const totalDistance = calculatePathLength(locations);
  const directDistance = haversineDistance(
    locations[0].lat, locations[0].lng,
    locations[locations.length-1].lat, locations[locations.length-1].lng
  );
  features.straightnessRatio = directDistance / totalDistance;
  
  // 重访位置（500米范围内）
  features.revisitCount = countRevisits(locations, 500);
  
  return features;
}

// 异常检测
function detectTrajectoryAnomaly(features) {
  const anomalies = [];
  
  // 过于笔直的路径（脚本特征）
  if (features.straightnessRatio > 0.95 && totalDistance > 1000) {
    anomalies.push({
      type: 'TOO_STRAIGHT_PATH',
      severity: 'MEDIUM',
      detail: `Straightness ratio: ${features.straightnessRatio}`,
    });
  }
  
  // 转向角度异常均匀（脚本特征）
  const turnAngleVariance = variance(turnAngles);
  if (turnAngleVariance < 0.1) {
    anomalies.push({
      type: 'UNIFORM_TURN_ANGLES',
      severity: 'HIGH',
      detail: 'Turn angles suspiciously uniform',
    });
  }
  
  // 频繁重访同一位置（挂机刷怪点）
  if (features.revisitCount > 10) {
    anomalies.push({
      type: 'FREQUENT_REVISITS',
      severity: 'HIGH',
      detail: `Revisited ${features.revisitCount} locations`,
    });
  }
  
  return anomalies;
}
```

### 4.3 战斗数据分析

```javascript
// 战斗异常检测
async function analyzeBattleAnomaly(userId) {
  const battleStats = await query(`
    SELECT 
      COUNT(*) as total_battles,
      SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END) as wins,
      AVG(player_power) as avg_player_power,
      AVG(enemy_power) as avg_enemy_power,
      AVG(CASE WHEN result = 'WIN' THEN damage_dealt ELSE NULL END) as avg_damage_when_win,
      AVG(CASE WHEN result = 'WIN' THEN battle_duration ELSE NULL END) as avg_duration_when_win
    FROM gym_battles
    WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
  `, [userId]);
  
  const anomalies = [];
  
  // 胜率异常
  const winRate = battleStats.wins / battleStats.total_battles;
  if (winRate > 0.85 && battleStats.total_battles > 50) {
    // 检查是否有足够实力支撑高胜率
    const powerRatio = battleStats.avg_player_power / battleStats.avg_enemy_power;
    if (powerRatio < 1.2) {
      anomalies.push({
        type: 'SUSPICIOUS_WIN_RATE',
        severity: 'HIGH',
        detail: `Win rate ${winRate} with power ratio ${powerRatio}`,
      });
    }
  }
  
  // 伤害异常
  const expectedDamage = battleStats.avg_player_power * 1.5; // 期望伤害约为战力1.5倍
  const damageRatio = battleStats.avg_damage_when_win / expectedDamage;
  if (damageRatio > 2.0) {
    anomalies.push({
      type: 'DAMAGE_HACK_SUSPECTED',
      severity: 'CRITICAL',
      detail: `Damage ${damageRatio}x expected`,
    });
  }
  
  // 战斗时长异常（过短可能是秒杀作弊）
  if (battleStats.avg_duration_when_win < 5 && battleStats.wins > 20) {
    anomalies.push({
      type: 'INSTANT_WIN_SUSPECTED',
      severity: 'HIGH',
      detail: `Avg win duration: ${battleStats.avg_duration_when_win}s`,
    });
  }
  
  return anomalies;
}
```

### 4.4 资源流分析

```javascript
// 资源增长监控
async function analyzeResourceAnomaly(userId) {
  // 获取资源变化历史
  const resourceHistory = await query(`
    SELECT 
      resource_type,
      change_amount,
      change_reason,
      balance_after,
      created_at
    FROM resource_transactions
    WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
    ORDER BY created_at
  `, [userId]);
  
  const anomalies = [];
  
  // 按资源类型分组分析
  const byType = groupBy(resourceHistory, 'resource_type');
  
  for (const [type, transactions] of Object.entries(byType)) {
    // 计算日增长率
    const dailyGrowth = calculateDailyGrowth(transactions);
    
    // 与全局统计对比
    const globalStats = await getGlobalResourceStats(type);
    
    if (dailyGrowth.mean > globalStats.p95) {
      anomalies.push({
        type: 'ABNORMAL_RESOURCE_GROWTH',
        resource: type,
        severity: dailyGrowth.mean > globalStats.p99 ? 'CRITICAL' : 'HIGH',
        detail: `Daily growth ${dailyGrowth.mean} vs p95 ${globalStats.p95}`,
      });
    }
  }
  
  // 检测异常资源流入（可能是刷资源）
  const largeInflows = transactions.filter(t => 
    t.change_amount > 10000 && t.change_reason === 'CATCH'
  );
  
  if (largeInflows.length > 5) {
    anomalies.push({
      type: 'SUSPICIOUS_LARGE_INFLOWS',
      severity: 'MEDIUM',
      detail: `${largeInflows.length} suspicious large inflows`,
    });
  }
  
  return anomalies;
}
```

### 4.5 时段行为分析

```javascript
// 检测脚本特征
async function analyzeTimePatternAnomaly(userId) {
  const actions = await query(`
    SELECT 
      action_type,
      created_at,
      EXTRACT(HOUR FROM created_at) as hour,
      EXTRACT(MINUTE FROM created_at) as minute
    FROM user_actions
    WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at
  `, [userId]);
  
  const anomalies = [];
  
  // 24小时活跃检测
  const hourlyDistribution = new Array(24).fill(0);
  actions.forEach(a => hourlyDistribution[a.hour]++);
  
  const activeHours = hourlyDistribution.filter(h => h > 0).length;
  if (activeHours >= 23 && actions.length > 500) {
    anomalies.push({
      type: '24H_CONTINUOUS_ACTIVITY',
      severity: 'HIGH',
      detail: `Active in ${activeHours} hours`,
    });
  }
  
  // 固定间隔检测（脚本特征）
  const intervals = [];
  for (let i = 1; i < actions.length; i++) {
    intervals.push(
      (actions[i].created_at - actions[i-1].created_at) / 1000 // 秒
    );
  }
  
  const intervalVariance = variance(intervals);
  const intervalMean = average(intervals);
  
  // 间隔过于规律（标准差 < 5% 均值）
  if (intervalVariance < intervalMean * 0.05 && actions.length > 100) {
    anomalies.push({
      type: 'REGULAR_INTERVAL_PATTERN',
      severity: 'CRITICAL',
      detail: `Interval std dev: ${Math.sqrt(intervalVariance)}s`,
    });
  }
  
  // 固定分钟执行（如每小时的第 15 分钟）
  const minuteDistribution = new Array(60).fill(0);
  actions.forEach(a => minuteDistribution[a.minute]++);
  
  const maxMinuteCount = Math.max(...minuteDistribution);
  const avgMinuteCount = average(minuteDistribution);
  
  if (maxMinuteCount > avgMinuteCount * 10) {
    anomalies.push({
      type: 'FIXED_MINUTE_EXECUTION',
      severity: 'HIGH',
      detail: 'Actions concentrated at specific minute',
    });
  }
  
  return anomalies;
}
```

### 4.6 设备关联分析

```javascript
// 设备指纹收集
const deviceFingerprint = {
  collect: (req) => ({
    deviceId: req.headers['x-device-id'],
    userAgent: req.headers['user-agent'],
    screenWidth: req.headers['x-screen-width'],
    screenHeight: req.headers['x-screen-height'],
    timezone: req.headers['x-timezone'],
    language: req.headers['accept-language'],
    platform: req.headers['x-platform'],
    osVersion: req.headers['x-os-version'],
    appVersion: req.headers['x-app-version'],
    ipHash: hashIP(req.ip),
  }),
  
  hash: (fingerprint) => {
    // 生成设备唯一标识
    const data = `${fingerprint.deviceId}|${fingerprint.screenWidth}x${fingerprint.screenHeight}|${fingerprint.platform}|${fingerprint.osVersion}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  },
};

// 检测多账号同设备
async function analyzeDeviceAnomaly(deviceHash) {
  const accountsOnDevice = await query(`
    SELECT DISTINCT user_id
    FROM device_fingerprints
    WHERE device_hash = $1 AND created_at > NOW() - INTERVAL '30 days'
  `, [deviceHash]);
  
  if (accountsOnDevice.length > 3) {
    // 检测群控特征
    const accounts = accountsOnDevice.map(a => a.user_id);
    
    // 检查这些账号是否有资源转移（交易、赠送）
    const transfers = await query(`
      SELECT COUNT(*) as count
      FROM pokemon_trades
      WHERE 
        (sender_id = ANY($1) AND receiver_id = ANY($1))
        AND created_at > NOW() - INTERVAL '30 days'
    `, [accounts]);
    
    if (transfers.count > 10) {
      return {
        type: 'DEVICE_CLUSTER_CHEAT',
        severity: 'CRITICAL',
        detail: `${accounts.length} accounts on device with ${transfers.count} internal transfers`,
        affectedAccounts: accounts,
      };
    }
    
    return {
      type: 'MULTI_ACCOUNT_DEVICE',
      severity: 'HIGH',
      detail: `${accounts.length} accounts on single device`,
      affectedAccounts: accounts,
    };
  }
  
  return null;
}
```

### 4.7 综合行为评分

```javascript
// 行为可信度综合评分
async function calculateBehaviorTrustScore(userId) {
  const [
    catchAnomalies,
    trajectoryAnomalies,
    battleAnomalies,
    resourceAnomalies,
    timeAnomalies,
  ] = await Promise.all([
    analyzeCatchAnomaly(userId),
    analyzeTrajectoryAnomaly(userId),
    analyzeBattleAnomaly(userId),
    analyzeResourceAnomaly(userId),
    analyzeTimePatternAnomaly(userId),
  ]);
  
  const allAnomalies = [
    ...catchAnomalies,
    ...trajectoryAnomalies,
    ...battleAnomalies,
    ...resourceAnomalies,
    ...timeAnomalies,
  ];
  
  // 计算行为评分
  let behaviorScore = 100;
  
  for (const anomaly of allAnomalies) {
    const penalty = {
      CRITICAL: 40,
      HIGH: 20,
      MEDIUM: 10,
      LOW: 5,
    }[anomaly.severity];
    
    behaviorScore -= penalty;
  }
  
  behaviorScore = Math.max(0, behaviorScore);
  
  // 与 GPS 可信度加权
  const gpsTrustScore = await getTrustScore(userId);
  const finalScore = behaviorScore * 0.5 + gpsTrustScore * 0.5;
  
  return {
    behaviorScore,
    gpsTrustScore,
    finalScore,
    anomalies: allAnomalies,
  };
}
```

### 4.8 数据库表设计

```sql
-- 设备指纹表
CREATE TABLE device_fingerprints (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_hash VARCHAR(64) NOT NULL,
  device_info JSONB NOT NULL,
  ip_hash VARCHAR(64),
  first_seen TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, device_hash)
);

CREATE INDEX idx_device_hash ON device_fingerprints(device_hash);
CREATE INDEX idx_device_user ON device_fingerprints(user_id);

-- 捕捉尝试记录表（用于成功率分析）
CREATE TABLE catch_attempts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  pokemon_id INTEGER NOT NULL,
  pokemon_rarity VARCHAR(20) NOT NULL,
  success BOOLEAN NOT NULL,
  expected_rate DOUBLE PRECISION,
  items_used JSONB,
  technique VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_catch_attempts_user_time ON catch_attempts(user_id, created_at DESC);

-- 用户行为统计快照表（每小时更新）
CREATE TABLE user_behavior_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  stat_type VARCHAR(50) NOT NULL,
  stat_value DOUBLE PRECISION,
  percentile_rank DOUBLE PRECISION,
  is_anomaly BOOLEAN DEFAULT FALSE,
  anomaly_details JSONB,
  snapshot_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, stat_type, snapshot_at)
);

CREATE INDEX idx_behavior_stats_user ON user_behavior_stats(user_id, snapshot_at DESC);

-- 行为异常记录表
CREATE TABLE behavior_anomaly_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  anomaly_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  details JSONB,
  behavior_score_before INTEGER,
  behavior_score_after INTEGER,
  action_taken VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_anomaly_records_user ON behavior_anomaly_records(user_id, created_at DESC);
CREATE INDEX idx_anomaly_records_type ON behavior_anomaly_records(anomaly_type, severity);
```

### 4.9 Prometheus 指标

```javascript
const behaviorMetrics = {
  // 行为异常检测计数
  behaviorAnomalyDetected: new Counter({
    name: 'minego_anticheat_behavior_anomaly_total',
    help: 'Behavior anomalies detected by type',
    labelNames: ['type', 'severity'],
  }),
  
  // 行为评分分布
  behaviorScoreHistogram: new Histogram({
    name: 'minego_anticheat_behavior_score',
    help: 'User behavior score distribution',
    buckets: [0, 20, 40, 60, 80, 100],
  }),
  
  // 设备关联检测
  multiAccountDeviceDetected: new Counter({
    name: 'minego_anticheat_multi_account_device_total',
    help: 'Multi-account on same device detected',
  }),
  
  // 分析耗时
  analysisDuration: new Histogram({
    name: 'minego_anticheat_analysis_duration_seconds',
    help: 'Time spent on behavior analysis',
    labelNames: ['analysis_type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  }),
};
```

### 4.10 API 端点

```
POST /internal/anticheat/behavior/analyze
  - 触发用户行为分析
  - 返回异常列表和行为评分

GET /internal/anticheat/behavior/score/:userId
  - 查询用户行为评分

GET /admin/anticheat/behavior/anomalies
  - 管理员查看行为异常记录
  - 支持按类型、严重程度筛选

GET /admin/anticheat/device/:deviceHash/accounts
  - 查询设备关联的所有账号

POST /internal/anticheat/device/fingerprint
  - 上报设备指纹

POST /internal/anticheat/catch/record
  - 记录捕捉尝试（用于成功率分析）
```

## 5. 验收标准（可测试）

- [ ] 捕捉成功率分析：实际成功率超过期望值 50% 且统计显著（z > 3）触发 MEDIUM/HIGH 异常
- [ ] 轨迹分析：直线度 > 0.95 且距离 > 1km 触发异常；转向角度方差 < 0.1 触发异常
- [ ] 战斗分析：胜率 > 85% 且战力比 < 1.2 触发异常；伤害倍数 > 2.0 触发 CRITICAL 异常
- [ ] 资源分析：日增长率超过全局 P95 触发 HIGH 异常，超过 P99 触发 CRITICAL
- [ ] 时段分析：24小时活跃且操作数 > 500 触发异常；间隔标准差 < 均值 5% 触发 CRITICAL
- [ ] 设备分析：单设备 > 3 账号触发异常；存在内部资源转移触发 CRITICAL
- [ ] 行为评分：综合评分算法正确，各项异常惩罚累加正确
- [ ] 数据库表：所有表创建成功，索引生效，写入性能符合要求
- [ ] Prometheus 指标：所有指标可查询，数值正确
- [ ] 单元测试：覆盖核心算法，覆盖率 > 85%
- [ ] 集成测试：模拟各类作弊行为被正确检测

## 6. 工作量估算

**XL（Extra Large）**

理由：
- 涉及 6 个维度的分析算法，每个都需要深入设计
- 需要新建 4 个数据库表，涉及历史数据迁移
- 需要收集和存储设备指纹
- 算法调参需要大量真实数据验证
- 与现有反作弊系统（REQ-00010）深度集成
- 需要完整的测试覆盖和性能优化
- 预计 5-7 天完成

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **补全反作弊体系**：REQ-00010 解决了 GPS 伪造，但无法检测客户端修改器、脚本等新型作弊
2. **保护游戏公平性**：作弊行为若不遏制，将导致正常用户流失
3. **技术可行**：基于统计分析的方法成熟，无需机器学习即可实现较高检测率
4. **数据积累**：越早实现，越能积累正常用户行为基线，提升检测准确率
5. **安全维度缺口**：STATUS.md 指出安全与合规仍有提升空间
