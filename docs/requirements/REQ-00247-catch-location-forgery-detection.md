# REQ-00247: 精灵捕捉地点伪造检测系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00247 |
| 标题 | 精灵捕捉地点伪造检测系统 |
| 类别 | 反作弊 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | catch-service、location-service、user-service、gateway、backend/shared |
| 创建时间 | 2026-06-16 06:00 |

## 需求描述

精灵捕捉地点伪造是一种高级作弊手段，攻击者通过伪造 GPS 位置或修改客户端请求，在未实际到达的地点捕捉稀有精灵。本系统通过多维度验证机制检测地点伪造行为，保护游戏公平性。

### 核心目标

1. **地点一致性验证**：验证捕捉请求中的地点是否与玩家实际位置一致
2. **移动轨迹分析**：分析玩家移动轨迹，检测不可能的瞬间移动
3. **环境特征验证**：通过 Wi-Fi、基站等环境特征验证位置真实性
4. **历史行为分析**：结合历史行为模式识别异常捕捉模式

## 技术方案

### 1. 地点一致性验证器

```javascript
// backend/shared/LocationConsistencyVerifier.js
class LocationConsistencyVerifier {
  constructor() {
    this.maxDriftMeters = 100; // 最大允许漂移
    this.timeWindowMs = 60000; // 时间窗口
  }

  /**
   * 验证捕捉地点与玩家位置一致性
   */
  async verifyCatchLocation(userId, catchLocation, timestamp) {
    // 获取玩家最近上报的位置
    const recentLocations = await this.getRecentLocations(userId, this.timeWindowMs);
    
    if (recentLocations.length === 0) {
      return { valid: false, reason: 'NO_RECENT_LOCATION' };
    }

    // 计算最近位置与捕捉位置的距离
    const distances = recentLocations.map(loc => ({
      timestamp: loc.timestamp,
      distance: this.calculateDistance(loc, catchLocation),
      accuracy: loc.accuracy
    }));

    // 考虑 GPS 精度的容差
    const validLocations = distances.filter(d => 
      d.distance <= this.maxDriftMeters + d.accuracy
    );

    if (validLocations.length > 0) {
      return { valid: true, confidence: this.calculateConfidence(validLocations) };
    }

    // 检查是否存在合理速度到达的可能
    const speedCheck = await this.checkReachability(userId, catchLocation, timestamp);
    
    return speedCheck;
  }

  /**
   * 检查可达性（是否能在合理时间内到达）
   */
  async checkReachability(userId, targetLocation, timestamp) {
    const lastLocation = await this.getLastLocation(userId);
    
    if (!lastLocation) {
      return { valid: false, reason: 'NO_LAST_LOCATION' };
    }

    const distance = this.calculateDistance(lastLocation, targetLocation);
    const timeDiff = timestamp - lastLocation.timestamp;
    
    // 最大合理移动速度（考虑交通工具）：100 m/s (360 km/h)
    const maxReasonableSpeed = 100;
    const requiredSpeed = distance / (timeDiff / 1000);

    if (requiredSpeed > maxReasonableSpeed) {
      return {
        valid: false,
        reason: 'IMPOSSIBLE_TRAVEL',
        distance,
        timeDiff,
        requiredSpeed
      };
    }

    return { valid: true, confidence: 0.7 };
  }

  /**
   * Haversine 距离计算
   */
  calculateDistance(loc1, loc2) {
    const R = 6371000; // 地球半径（米）
    const dLat = this.toRad(loc2.latitude - loc1.latitude);
    const dLon = this.toRad(loc2.longitude - loc1.longitude);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(loc1.latitude)) * 
              Math.cos(this.toRad(loc2.latitude)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }
}

module.exports = LocationConsistencyVerifier;
```

### 2. 移动轨迹分析器

```javascript
// backend/shared/MovementTrajectoryAnalyzer.js
class MovementTrajectoryAnalyzer {
  constructor() {
    this.minPointsForAnalysis = 5;
    this.maxSpeedOnFoot = 10; // 步行最大速度 m/s
    this.maxSpeedVehicle = 33; // 车辆最大速度 m/s
  }

  /**
   * 分析移动轨迹，检测异常模式
   */
  async analyzeTrajectory(userId, timeWindow = 3600000) {
    const locations = await this.getLocationsInWindow(userId, timeWindow);
    
    if (locations.length < this.minPointsForAnalysis) {
      return { anomaly: false, reason: 'INSUFFICIENT_DATA' };
    }

    // 按时间排序
    const sorted = locations.sort((a, b) => a.timestamp - b.timestamp);
    
    // 计算移动统计
    const movements = this.calculateMovements(sorted);
    
    // 检测瞬移
    const teleports = movements.filter(m => m.speed > this.maxSpeedVehicle);
    
    if (teleports.length > 0) {
      return {
        anomaly: true,
        type: 'TELEPORT_DETECTED',
        count: teleports.length,
        details: teleports.map(t => ({
          from: t.from,
          to: t.to,
          distance: t.distance,
          speed: t.speed,
          timeDiff: t.timeDiff
        }))
      };
    }

    // 检测速度模式异常（人类不可能的移动模式）
    const speedPatternAnomaly = this.detectSpeedPatternAnomaly(movements);
    
    if (speedPatternAnomaly) {
      return {
        anomaly: true,
        type: 'SPEED_PATTERN_ANOMALY',
        details: speedPatternAnomaly
      };
    }

    // 检测 GPS 漂移模式（伪造位置常见特征）
    const driftAnomaly = this.detectDriftAnomaly(sorted);
    
    if (driftAnomaly) {
      return {
        anomaly: true,
        type: 'GPS_DRIFT_ANOMALY',
        details: driftAnomaly
      };
    }

    return { anomaly: false };
  }

  /**
   * 计算移动序列
   */
  calculateMovements(locations) {
    const movements = [];
    
    for (let i = 1; i < locations.length; i++) {
      const prev = locations[i - 1];
      const curr = locations[i];
      
      const distance = this.calculateDistance(prev, curr);
      const timeDiff = (curr.timestamp - prev.timestamp) / 1000;
      const speed = distance / timeDiff;
      
      movements.push({
        from: { lat: prev.latitude, lon: prev.longitude, time: prev.timestamp },
        to: { lat: curr.latitude, lon: curr.longitude, time: curr.timestamp },
        distance,
        timeDiff,
        speed
      });
    }
    
    return movements;
  }

  /**
   * 检测 GPS 漂移异常（伪造位置特征）
   */
  detectDriftAnomaly(locations) {
    // 真实 GPS 应有微小随机漂移，伪造位置往往过于稳定
    const accuracyValues = locations.map(l => l.accuracy);
    const avgAccuracy = accuracyValues.reduce((a, b) => a + b) / accuracyValues.length;
    
    // 异常高的精度可能表示伪造
    if (avgAccuracy < 1) {
      return { reason: 'UNNATURALLY_HIGH_ACCURACY', avgAccuracy };
    }

    // 异常稳定的精度值
    const accuracyVariance = this.calculateVariance(accuracyValues);
    if (accuracyVariance < 0.1) {
      return { reason: 'UNIFORM_ACCURACY_DISTRIBUTION', variance: accuracyVariance };
    }

    return null;
  }

  calculateVariance(arr) {
    const mean = arr.reduce((a, b) => a + b) / arr.length;
    return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
  }
}

module.exports = MovementTrajectoryAnalyzer;
```

### 3. 环境特征验证器

```javascript
// backend/shared/EnvironmentFeatureVerifier.js
class EnvironmentFeatureVerifier {
  constructor() {
    this.cache = new RedisCache();
    this.cacheTTl = 300; // 5分钟
  }

  /**
   * 验证环境特征与位置的一致性
   */
  async verifyEnvironment(userId, reportedLocation, environmentData) {
    const results = {
      wifiMatch: null,
      cellTowerMatch: null,
      ipGeolocationMatch: null,
      overallScore: 0
    };

    // Wi-Fi 定位验证
    if (environmentData.wifiNetworks) {
      results.wifiMatch = await this.verifyWifiLocation(
        environmentData.wifiNetworks,
        reportedLocation
      );
    }

    // 基站定位验证
    if (environmentData.cellTowers) {
      results.cellTowerMatch = await this.verifyCellTowerLocation(
        environmentData.cellTowers,
        reportedLocation
      );
    }

    // IP 地理位置验证
    if (environmentData.ipAddress) {
      results.ipGeolocationMatch = await this.verifyIpGeolocation(
        environmentData.ipAddress,
        reportedLocation
      );
    }

    // 计算综合得分
    results.overallScore = this.calculateOverallScore(results);
    
    // 判断是否通过验证
    results.passed = results.overallScore >= 0.6;
    
    return results;
  }

  /**
   * Wi-Fi 定位验证
   */
  async verifyWifiLocation(wifiNetworks, reportedLocation) {
    // 提取 BSSID 并查询 Wi-Fi 位置数据库
    const wifiLocations = await this.queryWifiDatabase(wifiNetworks);
    
    if (wifiLocations.length === 0) {
      return { matched: false, reason: 'NO_WIFI_DATA' };
    }

    // 计算距离
    const distances = wifiLocations.map(wifi => ({
      bssid: wifi.bssid,
      distance: this.calculateDistance(wifi.location, reportedLocation)
    }));

    // 至少有一个 Wi-Fi 在合理范围内
    const nearWifis = distances.filter(d => d.distance < 200);
    
    if (nearWifis.length > 0) {
      return { 
        matched: true, 
        confidence: nearWifis.length / wifiNetworks.length 
      };
    }

    return { matched: false, reason: 'NO_NEARBY_WIFI' };
  }

  /**
   * 基站定位验证
   */
  async verifyCellTowerLocation(cellTowers, reportedLocation) {
    // 查询基站数据库
    const towerLocations = await this.queryCellTowerDatabase(cellTowers);
    
    if (towerLocations.length === 0) {
      return { matched: false, reason: 'NO_TOWER_DATA' };
    }

    // 基站覆盖范围通常较大（1-10km）
    const distances = towerLocations.map(tower => ({
      cellId: tower.cellId,
      distance: this.calculateDistance(tower.location, reportedLocation)
    }));

    const inRangeTowers = distances.filter(d => d.distance < 10000);
    
    if (inRangeTowers.length > 0) {
      return { 
        matched: true, 
        confidence: inRangeTowers.length / cellTowers.length 
      };
    }

    return { matched: false, reason: 'NO_IN_RANGE_TOWER' };
  }

  /**
   * IP 地理位置验证
   */
  async verifyIpGeolocation(ipAddress, reportedLocation) {
    const ipLocation = await this.getIpGeolocation(ipAddress);
    
    if (!ipLocation) {
      return { matched: false, reason: 'NO_IP_DATA' };
    }

    const distance = this.calculateDistance(ipLocation, reportedLocation);
    
    // IP 定位精度较低，允许较大误差（100km）
    if (distance < 100000) {
      return { matched: true, confidence: 0.5, distance };
    }

    return { matched: false, reason: 'IP_LOCATION_MISMATCH', distance };
  }

  /**
   * 计算综合得分
   */
  calculateOverallScore(results) {
    let totalScore = 0;
    let totalWeight = 0;

    const weights = {
      wifiMatch: 0.4,
      cellTowerMatch: 0.3,
      ipGeolocationMatch: 0.3
    };

    for (const [key, weight] of Object.entries(weights)) {
      if (results[key] !== null) {
        totalWeight += weight;
        if (results[key].matched) {
          totalScore += weight * results[key].confidence;
        }
      }
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0.5;
  }
}

module.exports = EnvironmentFeatureVerifier;
```

### 4. 捕捉地点验证中间件

```javascript
// backend/shared/CatchLocationVerifier.js
class CatchLocationVerifier {
  constructor() {
    this.consistencyVerifier = new LocationConsistencyVerifier();
    this.trajectoryAnalyzer = new MovementTrajectoryAnalyzer();
    this.environmentVerifier = new EnvironmentFeatureVerifier();
  }

  /**
   * 综合验证捕捉地点
   */
  async verify(userId, catchData) {
    const { location, timestamp, environment } = catchData;
    
    // 并行执行多个验证
    const [
      consistencyResult,
      trajectoryResult,
      environmentResult
    ] = await Promise.all([
      this.consistencyVerifier.verifyCatchLocation(userId, location, timestamp),
      this.trajectoryAnalyzer.analyzeTrajectory(userId),
      this.environmentVerifier.verifyEnvironment(userId, location, environment || {})
    ]);

    // 综合判断
    const fraudIndicators = [];
    let riskScore = 0;

    // 地点一致性验证失败
    if (!consistencyResult.valid) {
      fraudIndicators.push({
        type: 'LOCATION_INCONSISTENCY',
        details: consistencyResult.reason
      });
      riskScore += 40;
    }

    // 轨迹异常
    if (trajectoryResult.anomaly) {
      fraudIndicators.push({
        type: 'TRAJECTORY_ANOMALY',
        details: trajectoryResult.type
      });
      riskScore += 30;
    }

    // 环境特征不匹配
    if (!environmentResult.passed) {
      fraudIndicators.push({
        type: 'ENVIRONMENT_MISMATCH',
        score: environmentResult.overallScore
      });
      riskScore += 20;
    }

    return {
      valid: riskScore < 50,
      riskScore,
      fraudIndicators,
      details: {
        consistency: consistencyResult,
        trajectory: trajectoryResult,
        environment: environmentResult
      }
    };
  }
}

module.exports = CatchLocationVerifier;
```

### 5. 捕捉服务集成

```javascript
// catch-service 捕捉请求处理
const CatchLocationVerifier = require('../shared/CatchLocationVerifier');
const verifier = new CatchLocationVerifier();

router.post('/catch', async (req, res) => {
  const { pokemonId, location, timestamp, environment } = req.body;
  const userId = req.user.id;

  // 验证捕捉地点
  const verification = await verifier.verify(userId, {
    location,
    timestamp,
    environment
  });

  if (!verification.valid) {
    // 记录可疑行为
    await recordSuspiciousActivity(userId, {
      type: 'CATCH_LOCATION_FORGERY',
      riskScore: verification.riskScore,
      indicators: verification.fraudIndicators,
      timestamp: Date.now()
    });

    // 根据风险分数决定处理方式
    if (verification.riskScore >= 80) {
      // 高风险：拒绝捕捉并记录
      return res.status(403).json({
        error: 'LOCATION_VERIFICATION_FAILED',
        message: 'Unable to verify catch location'
      });
    } else {
      // 中风险：允许但标记
      await flagCatchForReview(pokemonId, userId, verification);
    }
  }

  // 正常捕捉流程
  const result = await processCatch(pokemonId, userId, location);
  
  res.json(result);
});
```

## 验收标准

- [ ] 地点一致性验证功能实现并测试通过
- [ ] 移动轨迹分析器能检测瞬移异常
- [ ] 环境特征验证器支持 Wi-Fi、基站、IP 验证
- [ ] 验证中间件集成到 catch-service
- [ ] 高风险捕捉请求（riskScore >= 80）被拒绝
- [ ] 可疑行为记录到数据库
- [ ] 单元测试覆盖率 >= 80%
- [ ] 集成测试验证端到端流程
- [ ] 误判率 < 5%（通过 A/B 测试验证）

## 影响范围

- `backend/services/catch-service/src/routes/catch.js` - 捕捉路由集成验证
- `backend/shared/LocationConsistencyVerifier.js` - 新增
- `backend/shared/MovementTrajectoryAnalyzer.js` - 新增
- `backend/shared/EnvironmentFeatureVerifier.js` - 新增
- `backend/shared/CatchLocationVerifier.js` - 新增
- `backend/shared/antiCheat.js` - 添加新检测器
- `database/migrations/` - 添加可疑活动记录表

## 参考

- [GPS Spoofing Detection Techniques](https://www.example.com/gps-spoofing)
- [Wi-Fi Positioning System](https://www.example.com/wps)
- [Cell Tower Triangulation](https://www.example.com/cell-tower)
- [Haversine Formula](https://en.wikipedia.org/wiki/Haversine_formula)
