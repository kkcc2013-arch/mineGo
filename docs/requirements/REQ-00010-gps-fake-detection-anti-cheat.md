# REQ-00010：GPS 伪造检测与速度限制反作弊系统

- **编号**：REQ-00010
- **类别**：反作弊
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：gateway、location-service、catch-service、gym-service、backend/shared/anti-cheat.js
- **创建时间**：2026-06-05 06:00
- **依赖需求**：REQ-00002（结构化日志与指标）

## 1. 背景与问题

当前 mineGo 项目完全依赖客户端上报的 GPS 坐标，存在严重的作弊风险：

1. **GPS 伪造**：玩家可使用虚拟定位软件伪造坐标，在家中即可"瞬移"到稀有精灵或道馆位置
2. **速度作弊**：无速度验证，玩家可在短时间内跨越大范围区域（如北京→上海仅用几秒）
3. **坐标漂移异常**：缺乏对不合理坐标变化的检测
4. **无行为模式分析**：无法识别异常捕捉模式（如每秒捕捉100只精灵）

根据 STATUS.md，安全与合规维度得分仅 13/15，缺少防刷机制是关键缺口。作为真实 GPS 的 AR 游戏，反作弊是核心安全需求。

## 2. 目标

建立多层次反作弊系统，实现：

- **速度检测**：基于用户历史位置计算移动速度，超过合理阈值（步行 5m/s，骑车 15m/s，驾车 50m/s）触发告警
- **GPS 伪造识别**：检测坐标跳变、轨迹不连续、海拔异常等伪造特征
- **行为模式分析**：捕捉频率、道馆挑战频率、移动轨迹合理性
- **可信度评分**：为每个用户维护可信度分数，低分用户限制功能
- **实时拦截**：高风险行为直接拒绝，中风险标记人工审核

预期效果：阻止 95%+ 的 GPS 作弊行为，保护游戏公平性。

## 3. 范围

- **包含**：
  - 速度检测算法与阈值配置
  - GPS 伪造特征检测（坐标跳变、轨迹异常）
  - 用户行为可信度评分系统
  - Redis 存储用户位置历史与可信度
  - Gateway 统一反作弊中间件
  - Prometheus 反作弊指标（拦截次数、可信度分布）
  - 管理后台查看作弊记录与可信度

- **不包含**：
  - 机器学习模型训练（后续需求）
  - 设备指纹识别（后续需求）
  - 第三方反作弊服务集成

## 4. 详细需求

### 4.1 速度检测算法

```javascript
// 速度阈值配置（单位：m/s）
const SPEED_LIMITS = {
  WALK: 5,      // 步行：18km/h
  BIKE: 15,     // 骑行：54km/h
  DRIVE: 50,    // 驾车：180km/h
  TELEPORT: 200 // 瞬移阈值（作弊）
};

// 计算两点间距离（Haversine 公式）
function haversineDistance(lat1, lon1, lat2, lon2) { ... }

// 速度检测
function checkSpeed(userId, newLat, newLon, timestamp) {
  // 1. 从 Redis 获取用户最近位置记录
  // 2. 计算时间差与距离
  // 3. 计算速度 = 距离 / 时间差
  // 4. 返回 { speed, isAnomaly, anomalyType }
}
```

### 4.2 GPS 伪造特征检测

```javascript
// 检测项
const FAKE_GPS_INDICATORS = {
  COORDINATE_JUMP: '坐标跳变（距离 > 1km 且时间 < 1min）',
  TRAJECTORY_BREAK: '轨迹不连续（方向突变 > 90° 且距离 > 500m）',
  ALTITUDE_ANOMALY: '海拔异常（变化 > 100m/s）',
  ACCURACY_SUSPICIOUS: '精度可疑（accuracy < 5m 持续出现）',
  MOCK_LOCATION_FLAG: '系统标记为模拟位置（Android mock_location）'
};
```

### 4.3 可信度评分系统

```javascript
// 用户可信度分数（0-100）
// 初始分数：100
// 作弊行为扣分：
//   - 速度异常：-5 ~ -20（根据严重程度）
//   - GPS 伪造：-30 ~ -50
//   - 行为异常：-10 ~ -30
// 恢复机制：正常行为 +1/小时，上限 100

// 分数影响：
//   - >= 80：正常
//   - 60-79：警告，部分功能限制
//   - 40-59：限制：稀有精灵不可见、道馆不可挑战
//   - < 40：封禁：仅可查看地图，所有交互被拒绝
```

### 4.4 位置历史存储

```sql
-- 用户位置历史表
CREATE TABLE user_location_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  altitude DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  is_mock BOOLEAN DEFAULT FALSE,
  recorded_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引：按用户和时间查询
CREATE INDEX idx_location_history_user_time 
ON user_location_history(user_id, recorded_at DESC);

-- 作弊记录表
CREATE TABLE anti_cheat_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'SPEED_ANOMALY', 'GPS_FAKE', 'BEHAVIOR_ANOMALY'
  severity VARCHAR(20) NOT NULL, -- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  details JSONB,
  trust_score_before INTEGER,
  trust_score_after INTEGER,
  action_taken VARCHAR(50), -- 'WARN', 'THROTTLE', 'BLOCK', 'BAN'
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.5 Gateway 反作弊中间件

```javascript
// backend/shared/anti-cheat.js
module.exports = {
  // 位置验证中间件
  validateLocation: async (req, res, next) => {
    const { lat, lng } = req.body;
    const userId = req.user.sub;
    
    const result = await checkUserLocation(userId, lat, lng);
    
    if (result.blocked) {
      return res.status(403).json({
        code: 6001,
        message: '位置验证失败，请确保使用真实GPS',
        data: { reason: result.reason }
      });
    }
    
    if (result.warning) {
      res.setHeader('X-Anti-Cheat-Warning', result.warning);
    }
    
    req.antiCheat = result;
    next();
  },
  
  // 行为频率检查
  checkActionRate: (actionType, maxPerMinute) => { ... },
  
  // 可信度检查
  requireTrustScore: (minScore) => { ... }
};
```

### 4.6 Prometheus 指标

```javascript
// 反作弊指标
const antiCheatMetrics = {
  // 拦截次数计数器
  blockedAttempts: new Counter({
    name: 'minego_anticheat_blocked_total',
    help: 'Total blocked attempts by type',
    labelNames: ['type', 'severity']
  }),
  
  // 可信度分布直方图
  trustScoreHistogram: new Histogram({
    name: 'minego_anticheat_trust_score',
    help: 'User trust score distribution',
    buckets: [0, 20, 40, 60, 80, 100]
  }),
  
  // 速度异常计数
  speedAnomalyCounter: new Counter({
    name: 'minego_anticheat_speed_anomaly_total',
    help: 'Speed anomaly detections',
    labelNames: ['severity']
  })
};
```

### 4.7 API 端点

```
POST /internal/anticheat/location
  - 上报位置并验证
  - 返回可信度与警告

GET /internal/anticheat/trust-score/:userId
  - 查询用户可信度分数

GET /admin/anticheat/records
  - 管理员查看作弊记录
  - 支持分页、筛选

POST /admin/anticheat/trust-score/:userId/adjust
  - 管理员调整可信度分数
  - 记录调整原因
```

## 5. 验收标准（可测试）

- [ ] 速度检测：用户在 1 秒内移动超过 1km，触发 HIGH 级别异常，可信度 -20
- [ ] GPS 伪造检测：坐标跳变检测准确率 > 90%，误报率 < 5%
- [ ] 可信度系统：初始分数 100，作弊扣分正确，正常恢复 +1/小时
- [ ] 可信度限制：分数 < 40 用户，捕捉/道馆接口返回 403
- [ ] 位置历史：每次位置上报存储到数据库，保留最近 100 条
- [ ] Prometheus 指标：blocked_attempts、trust_score、speed_anomaly 指标可查询
- [ ] 单元测试：覆盖速度计算、距离计算、可信度计算，覆盖率 > 80%
- [ ] 集成测试：模拟作弊行为被正确拦截

## 6. 工作量估算

**L（Large）**

理由：
- 涉及多个服务改造（gateway、location、catch、gym）
- 需要新建数据库表与索引
- 算法实现需要仔细调参（速度阈值、可信度权重）
- 需要完整的测试覆盖
- 预计 2-3 天完成

## 7. 优先级理由

**P0（最高优先级）**

理由：
1. **安全核心**：作为真实 GPS 的 AR 游戏，反作弊是核心安全能力，直接影响游戏公平性
2. **影响面广**：所有依赖位置的功能（捕捉、道馆、附近精灵）都受影响
3. **成熟度缺口**：STATUS.md 明确指出"缺少防刷机制"是安全维度的关键缺口
4. **用户信任**：作弊泛滥将导致正常用户流失，影响产品生存
5. **技术债**：越晚实现，积累的作弊数据越多，清理成本越高
