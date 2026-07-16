# REQ-00586：GPS 位置欺骗检测与虚拟定位防护系统

- **编号**：REQ-00586
- **类别**：反作弊
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：game-client、gateway、location-service、backend/security、backend/analysis、Redis、PostgreSQL
- **创建时间**：2026-07-16 22:00
- **依赖需求**：REQ-00521（AR 捕获防作弊系统）、REQ-00494（行为风控系统）

## 1. 背景与问题

作为基于真实 GPS 的 AR 精灵捕捉手游，mineGo 面临着严峻的位置欺骗攻击威胁：

### 当前安全缺口

1. **虚拟定位软件泛滥**
   - Android/iOS 上存在大量 Fake GPS 应用
   - 玩家可远程捕捉精灵，无需真实移动
   - 可攻击全球任意位置的道馆
   - 访问地理位置锁定的 Pokestop

2. **缺乏多层次防护**
   - 目前仅有设备传感器验证（REQ-00521）
   - 缺少服务端位置可信度验证
   - 缺少行为模式异常检测
   - 缺少实时反制与惩罚机制

3. **业务影响严重**
   - 破坏游戏公平性，正常玩家流失
   - 道馆系统被远程玩家控制
   - 地理位置活动失效
   - 合规风险（某些地区法律要求真实位置）

### 攻击场景分析

- **瞬移攻击**：短时间内位置跳跃数百公里
- **模拟行走**：使用路径模拟软件伪造移动轨迹
- **位置锁定**：固定虚拟位置进行远程挂机
- **多账号协同**：一组账号在相同虚拟位置协同作弊

## 2. 目标

建立多层次的 GPS 位置欺骗检测与防护系统，实现：

1. **设备级防护**：检测虚拟定位应用、开发者模式、系统修改
2. **服务级验证**：分析位置可信度、速度合理性、地形一致性
3. **行为级检测**：识别异常移动模式、不可能的行程
4. **实时反制**：自动降权、封禁、位置锁定失效

**量化目标**：
- 虚拟定位检测准确率 ≥ 95%
- 误封率 < 0.1%
- 检测延迟 < 500ms
- 减少 80% 的位置相关作弊行为

## 3. 范围

### 包含

- **客户端检测模块**：虚拟定位应用检测、开发者模式检测、系统完整性检查
- **服务端验证引擎**：位置可信度评分、速度合理性验证、地形数据校验
- **行为分析系统**：移动模式建模、异常检测算法、历史轨迹分析
- **反制系统**：实时降权、临时封禁、位置功能限制、证据收集
- **管理后台**：可疑玩家看板、审核工具、封禁记录
- **监控告警**：作弊趋势、检测效果、误封申诉

### 不包含

- 本期不涉及 VPN/IP 地址伪装检测（已有 IP 黑名单系统）
- 不涉及设备指纹伪造检测（REQ-00521 已覆盖部分）
- 不涉及第三方反作弊服务集成（预算限制）

## 4. 详细需求

### 4.1 客户端检测模块（game-client）

```javascript
// frontend/game-client/src/security/locationSpoofDetector.js

class LocationSpoofDetector {
  /**
   * 检测虚拟定位应用（Android）
   * 检查已安装应用列表中的已知虚拟定位软件
   */
  async detectMockLocationApps() {
    // 检测列表：Fake GPS Location、GPS Joystick、Mock GPS with Joystick 等
    // 返回：{ detected: boolean, apps: string[], risk: number }
  }

  /**
   * 检测开发者模式与 USB 调试（Android）
   * 开发者模式是虚拟定位的前置条件
   */
  async detectDeveloperMode() {
    // Settings.Global.DEVELOPMENT_SETTINGS_ENABLED
    // Settings.Global.ADB_ENABLED
    // 返回：{ enabled: boolean, risk: number }
  }

  /**
   * 检测 Mock Location 提供者（Android）
   * 检查是否有非系统的位置提供者被启用
   */
  async detectMockLocationProvider() {
    // LocationManager.getProviders(true)
    // 过滤系统提供者：gps, network, passive
    // 返回：{ mockProviders: string[], risk: number }
  }

  /**
   * iOS 设备完整性检查
   * 检测越狱、IPA 注入、系统修改
   */
  async detectIOSIntegrity() {
    // 检测越狱文件路径
    // 检测 DynamicLibraries 注入
    // 返回：{ isJailbroken: boolean, risk: number }
  }

  /**
   * 位置时间戳一致性验证
   * 检测位置报告与系统时间是否匹配
   */
  async validateLocationTimestamp(location) {
    // 比对 GPS 卫星时间 vs 系统时间 vs 网络时间
    // 返回：{ consistent: boolean, deviation: number, risk: number }
  }

  /**
   * 生成综合设备风险评分
   */
  generateDeviceRiskScore() {
    // 综合以上检测结果
    // 返回：{ score: 0-100, flags: string[], evidence: object }
  }
}
```

### 4.2 服务端验证引擎（location-service）

```javascript
// backend/services/location-service/src/locationTrustEngine.js

class LocationTrustEngine {
  /**
   * 位置可信度评分（0-100）
   * 综合多个维度计算位置可信度
   */
  async calculateLocationTrustScore(userId, location, deviceRisk, context) {
    const scores = {
      velocity: await this.validateVelocity(userId, location),        // 速度合理性
      terrain: await this.validateTerrain(location),                  // 地形一致性
      network: await this.validateNetworkConsistency(userId, location), // 网络位置一致性
      history: await this.analyzeMovementPattern(userId, location),   // 历史行为模式
      device: deviceRisk.score                                         // 设备风险
    };
    
    return {
      trustScore: this.weightedAverage(scores),
      details: scores,
      recommendation: this.getRecommendation(scores)
    };
  }

  /**
   * 速度合理性验证
   * 检测不可能的移动速度
   */
  async validateVelocity(userId, newLocation) {
    const lastLocation = await this.getLastLocation(userId);
    const timeDiff = Date.now() - lastLocation.timestamp;
    const distance = this.calculateDistance(lastLocation, newLocation);
    const velocity = distance / timeDiff; // m/s
    
    // 合理速度阈值：
    // - 步行：≤ 2 m/s (7.2 km/h)
    // - 骑行：≤ 10 m/s (36 km/h)
    // - 驾驶：≤ 40 m/s (144 km/h)
    // - 飞机：≤ 250 m/s (900 km/h)
    // 超过阈值则可疑
    
    return {
      score: this.calculateVelocityScore(velocity),
      velocity,
      isImpossible: velocity > 250 // 超过飞机速度
    };
  }

  /**
   * 地形一致性验证
   * 检测位置是否在合理地形（道路、建筑、公园）
   */
  async validateTerrain(location) {
    // 使用 OpenStreetMap / PostGIS 查询地形类型
    // 检测：
    // - 是否在海洋/湖泊中央（无船只是作弊）
    // - 是否在山区/森林（无道路则可疑）
    // - 是否在机场禁区（玩家不应进入）
    
    const terrainType = await this.getTerrainType(location);
    const accessible = await this.isAccessibleArea(location);
    
    return {
      score: accessible ? 100 : 30,
      terrainType,
      accessible
    };
  }

  /**
   * 网络位置一致性验证
   * 对比 GPS 位置与 IP 地理位置
   */
  async validateNetworkConsistency(userId, location) {
    const ipLocation = await this.getIPLocation(userId);
    const distance = this.calculateDistance(location, ipLocation);
    
    // 如果 GPS 与 IP 位置相差超过 1000km，高度可疑
    // 注意：VPN 用户可能有差异，需综合判断
    
    return {
      score: distance < 1000 ? 100 : 50,
      distance,
      ipLocation
    };
  }

  /**
   * 移动模式分析
   * 使用历史轨迹建模，检测异常模式
   */
  async analyzeMovementPattern(userId, location) {
    const history = await this.getLocationHistory(userId, { hours: 24 });
    
    // 特征提取：
    // - 平均速度、速度方差
    // - 移动距离分布
    // - 活跃时间段
    // - 常去地点
    
    const model = await this.buildMovementModel(history);
    const anomalyScore = await this.detectAnomaly(model, location);
    
    return {
      score: 100 - anomalyScore * 100,
      anomalyScore,
      modelFeatures: model.features
    };
  }
}
```

### 4.3 行为分析系统（backend/analysis）

```javascript
// backend/analysis/src/locationAnomalyDetector.js

class LocationAnomalyDetector {
  /**
   * 检测不可能的行程
   * 例如：1 分钟内从北京瞬移到上海
   */
  async detectImpossibleTravel(userId, locations) {
    for (let i = 1; i < locations.length; i++) {
      const prev = locations[i - 1];
      const curr = locations[i];
      const timeDiff = (curr.timestamp - prev.timestamp) / 1000; // 秒
      const distance = this.haversineDistance(prev, curr); // 公里
      
      // 不可能的行程阈值：
      // - 5 分钟内移动 > 500km（飞机都不可能）
      // - 1 小时内移动 > 2000km（洲际飞行）
      // - 24 小时内移动 > 地球半周长（20000km）
      
      if (this.isImpossibleTrip(timeDiff, distance)) {
        await this.flagSuspiciousMovement(userId, {
          type: 'impossible_travel',
          prevLocation: prev,
          currLocation: curr,
          velocity: distance / timeDiff * 3600, // km/h
          risk: 100
        });
      }
    }
  }

  /**
   * 检测瞬移模式
   * 连续的瞬移行为模式
   */
  async detectTeleportPattern(userId, timeWindow = { hours: 6 }) {
    const locations = await this.getLocations(userId, timeWindow);
    
    // 检测：
    // - 多次瞬移（速度 > 1000 km/h）
    // - 位置跳跃后快速返回
    // - 虚拟位置的重复出现（同一虚拟位置被多个账号使用）
    
    const teleports = locations.filter((loc, i) => {
      if (i === 0) return false;
      const velocity = this.calculateVelocity(locations[i - 1], loc);
      return velocity > 1000; // km/h
    });
    
    if (teleports.length > 3) {
      await this.flagSuspiciousMovement(userId, {
        type: 'teleport_pattern',
        teleports,
        risk: 80
      });
    }
  }

  /**
   * 检测位置锁定作弊
   * 长时间停留在某位置但该位置不应有玩家
   */
  async detectLocationLocking(userId) {
    const recentLocations = await this.getLocations(userId, { hours: 1 });
    
    // 如果 90% 的时间停留在 < 100m 范围内
    const cluster = this.clusterLocations(recentLocations);
    
    if (cluster.stayRatio > 0.9) {
      // 检查该位置是否合理：
      // - 是否在海洋中央？
      // - 是否在无人区？
      // - 是否有 Pokestop/道馆？
      
      const terrain = await this.getTerrainType(cluster.center);
      const nearbyPOI = await this.getNearbyPOI(cluster.center);
      
      if (terrain.isWater || terrain.isRemote || nearbyPOI.length === 0) {
        await this.flagSuspiciousMovement(userId, {
          type: 'location_locking',
          location: cluster.center,
          stayRatio: cluster.stayRatio,
          terrain,
          risk: 70
        });
      }
    }
  }

  /**
   * 多账号协同作弊检测
   * 多个账号在相同虚拟位置协同行动
   */
  async detectCoordinatedSpoofing(location) {
    // 查询在相同位置（半径 50m）内的活跃玩家
    const nearbyUsers = await this.getUsersNearLocation(location, { radius: 50 });
    
    // 检测：
    // - 相同设备指纹（多开）
    // - 相同 IP 段（代理 IP）
    // - 相同行为模式（同步移动）
    // - 高频交互（互相赠送、交易）
    
    const clusters = this.detectUserClusters(nearbyUsers);
    
    for (const cluster of clusters) {
      if (cluster.users.length >= 3 && cluster.similarityScore > 0.8) {
        await this.flagCoordinatedSpoofing(cluster.users, location);
      }
    }
  }
}
```

### 4.4 实时反制系统（backend/security）

```javascript
// backend/security/src/locationSpoofResponse.js

class LocationSpoofResponse {
  /**
   * 根据风险等级执行反制措施
   */
  async executeCountermeasure(userId, riskScore, evidence) {
    const level = this.getRiskLevel(riskScore);
    
    switch (level) {
      case 'LOW': // 30-50
        return await this.lowRiskResponse(userId, evidence);
      case 'MEDIUM': // 50-70
        return await this.mediumRiskResponse(userId, evidence);
      case 'HIGH': // 70-90
        return await this.highRiskResponse(userId, evidence);
      case 'CRITICAL': // 90-100
        return await this.criticalRiskResponse(userId, evidence);
    }
  }

  /**
   * 低风险响应：监控与记录
   */
  async lowRiskResponse(userId, evidence) {
    await this.addToWatchlist(userId, evidence);
    await this.logSuspiciousActivity(userId, 'location_spoofing_low', evidence);
    return { action: 'monitor', duration: null };
  }

  /**
   * 中风险响应：位置功能降级
   */
  async mediumRiskResponse(userId, evidence) {
    // 降级措施：
    // - 禁止捕捉稀有精灵（概率降低）
    // - 禁止攻击道馆
    // - Pokestop 奖励减少 50%
    
    await this.applyLocationRestrictions(userId, {
      rareSpawnPenalty: 0.5,
      gymAccess: false,
      pokestopBonus: 0.5
    });
    
    await this.sendWarningNotification(userId, 'location_verification_required');
    
    return { action: 'restrict', duration: 24 * 60 * 60 * 1000 };
  }

  /**
   * 高风险响应：临时封禁
   */
  async highRiskResponse(userId, evidence) {
    // 封禁措施：
    // - 禁止所有位置相关功能
    // - 捕捉的精灵被标记为可疑（无法交易/战斗）
    // - 社交功能受限
    
    await this.applyTemporaryBan(userId, {
      duration: 7 * 24 * 60 * 60 * 1000, // 7 天
      restrictions: {
        catch: false,
        gym: false,
        trade: false,
        social: 'limited'
      },
      reason: 'suspected_location_spoofing'
    });
    
    await this.requestManualReview(userId, evidence);
    
    return { action: 'suspend', duration: 7 * 24 * 60 * 60 * 1000 };
  }

  /**
   * 极高风险响应：永久封禁
   */
  async criticalRiskResponse(userId, evidence) {
    // 收集完整证据链
    const fullEvidence = await this.collectFullEvidence(userId, evidence);
    
    // 多次违规直接永久封禁
    const violations = await this.getViolationHistory(userId);
    
    if (violations.count >= 3) {
      await this.applyPermanentBan(userId, {
        reason: 'repeated_location_spoofing',
        evidence: fullEvidence,
        appealable: true
      });
      
      return { action: 'ban', duration: 'permanent' };
    }
    
    // 首次极高风险，先临时封禁
    return await this.highRiskResponse(userId, evidence);
  }

  /**
   * 证据收集
   */
  async collectFullEvidence(userId, initialEvidence) {
    return {
      deviceRisk: await this.getDeviceRiskRecord(userId),
      locationHistory: await this.getLocationHistory(userId, { hours: 72 }),
      networkData: await this.getNetworkData(userId),
      behaviorPattern: await this.getBehaviorPattern(userId),
      screenshots: await this.requestClientScreenshot(userId),
      timestamps: {
        detected: Date.now(),
        collected: Date.now()
      }
    };
  }
}
```

### 4.5 数据库设计

```sql
-- 位置可信度记录表
CREATE TABLE location_trust_records (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  location GEOMETRY(POINT, 4326) NOT NULL,
  trust_score INT NOT NULL, -- 0-100
  risk_level VARCHAR(20) NOT NULL, -- LOW/MEDIUM/HIGH/CRITICAL
  device_risk_score INT,
  velocity_score INT,
  terrain_score INT,
  network_score INT,
  pattern_score INT,
  evidence JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_user_id (user_id),
  INDEX idx_trust_score (trust_score),
  INDEX idx_created_at (created_at),
  INDEX idx_location (location)
);

-- 可疑移动记录表
CREATE TABLE suspicious_movements (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  movement_type VARCHAR(50) NOT NULL, -- impossible_travel, teleport_pattern, location_locking
  prev_location GEOMETRY(POINT, 4326),
  curr_location GEOMETRY(POINT, 4326),
  velocity FLOAT, -- km/h
  risk_score INT,
  evidence JSONB,
  status VARCHAR(20) DEFAULT 'pending', -- pending, confirmed, dismissed
  reviewed_by VARCHAR(64),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_user_id (user_id),
  INDEX idx_movement_type (movement_type),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
);

-- 位置作弊封禁记录表
CREATE TABLE location_spoof_bans (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  ban_type VARCHAR(20) NOT NULL, -- restrict, suspend, ban
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  duration_ms BIGINT, -- null 表示永久
  start_at TIMESTAMPTZ DEFAULT NOW(),
  end_at TIMESTAMPTZ,
  lifted_at TIMESTAMPTZ,
  lifted_by VARCHAR(64),
  appeal_status VARCHAR(20), -- pending, approved, rejected
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_user_id (user_id),
  INDEX idx_ban_type (ban_type),
  INDEX idx_start_at (start_at),
  INDEX idx_end_at (end_at)
);
```

### 4.6 API 接口设计

```yaml
# 位置可信度验证接口
POST /api/v1/location/verify
Request:
  location:
    latitude: number
    longitude: number
    accuracy: number
    altitude: number
    timestamp: number
  deviceRisk:
    score: number
    flags: string[]
    mockProviders: string[]
    developerMode: boolean
  context:
    action: 'catch' | 'gym' | 'pokestop' | 'trade'
    targetId: string

Response:
  trustScore: number (0-100)
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  recommendation: 'allow' | 'restrict' | 'deny'
  restrictions: object (optional)
  requestId: string

# 可疑移动上报接口（内部）
POST /internal/v1/location/report-suspicious
Request:
  userId: string
  movementType: string
  prevLocation: object
  currLocation: object
  velocity: number
  evidence: object

# 管理后台接口
GET /admin/v1/location-spoof/suspects
  ?riskLevel=HIGH
  &timeRange=24h
  &page=1

GET /admin/v1/location-spoof/users/:userId/evidence
POST /admin/v1/location-spoof/users/:userId/action
  action: 'dismiss' | 'warn' | 'restrict' | 'suspend' | 'ban'
  reason: string
  duration: number (optional)
```

### 4.7 监控指标

```javascript
// Prometheus 指标
const metrics = {
  // 检测统计
  'location_spoof_checks_total': Counter,
  'location_spoof_detected_total': Counter,
  'location_spoof_risk_level': Gauge, // 按风险等级分组
  
  // 响应统计
  'location_spoof_actions_total': Counter, // 按动作类型分组
  'location_spoof_bans_total': Counter,
  
  // 性能指标
  'location_trust_calculation_duration_seconds': Histogram,
  'location_validation_latency_seconds': Histogram,
  
  // 准确率指标
  'location_spoof_false_positive_rate': Gauge,
  'location_spoof_detection_accuracy': Gauge,
  
  // 申诉统计
  'location_spoof_appeals_total': Counter,
  'location_spoof_appeals_approved_total': Counter
};
```

## 5. 验收标准（可测试）

- [ ] 客户端能检测出 95% 以上的已知虚拟定位应用
- [ ] 服务端能识别速度超过 1000 km/h 的瞬移行为
- [ ] 不可能行程检测准确率 ≥ 98%（检测 1 分钟内移动 >500km）
- [ ] 地形验证能识别海洋/湖泊中央的异常位置
- [ ] 多账号协同作弊检测能识别 3+ 账号在同一虚拟位置的行为
- [ ] 风险评分延迟 < 500ms（P95）
- [ ] 中高风险用户的位置功能自动降级
- [ ] 管理后台可查看可疑玩家列表和证据
- [ ] 监控面板显示作弊趋势和检测效果
- [ ] 申诉流程可用，误封率 < 0.1%

## 6. 工作量估算

**估算：XL（2-3 周）**

理由：
- 客户端检测模块：3 天（Android/iOS 双平台）
- 服务端验证引擎：5 天（多个验证维度）
- 行为分析系统：4 天（异常检测算法）
- 反制系统：3 天（多层响应机制）
- 数据库与管理后台：2 天
- 测试与调优：3 天

## 7. 优先级理由

**P0（最高优先级）**

理由：
1. **核心安全需求**：GPS 位置是 AR 游戏的核心机制，位置欺骗直接破坏游戏根本
2. **业务影响严重**：影响游戏公平性、玩家留存、收入
3. **合规风险**：某些地区法律要求真实位置数据
4. **已有基础**：REQ-00521 和 REQ-00494 已建立部分反作弊基础设施，可复用
5. **用户呼声强烈**：公平性是玩家最关注的问题之一
6. **技术可行**：成熟的多层防护方案，已有成功案例参考