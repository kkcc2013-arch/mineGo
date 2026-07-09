# REQ-00521：游戏 AR 增强现实捕获模式防作弊与安全防护系统

- **编号**：REQ-00521
- **类别**：反作弊
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：game-client、backend/security、backend/analysis、gateway
- **创建时间**：2026-07-09 09:00
- **依赖需求**：REQ-00494（游戏内行为数据实时风控与反作弊自动化分析系统）

## 1. 背景与问题

### 现状分析
mineGo 是一款基于真实 GPS 的 AR 精灵捕捉手游，核心玩法依赖：
- 真实地理位置（GPS 定位）
- 设备传感器（陀螺仪、加速度计、磁力计）
- 相机实时画面（精灵叠加渲染）

### 作弊风险
常见的 AR 捕获模式作弊手段：
1. **虚拟定位（GPS Spoofing）**：使用 FakeGPS 等工具伪造位置
2. **传感器模拟**：模拟设备传感器数据欺骗 AR 检测
3. **屏幕录制/截图**：通过录屏分析精灵生成算法
4. **自动化脚本**：使用 Auto.js 等工具自动捕捉
5. **内存修改**：修改客户端内存数据（精灵属性、捕捉概率）

### 业务影响
- 作弊用户获取不正当优势，破坏公平性
- 真实用户体验下降，流失率上升
- 游戏经济体系被破坏（稀有精灵泛滥）
- 法律风险（反作弊措施不足导致用户投诉）

## 2. 目标

建立**多层次、纵深防御**的 AR 捕获模式防作弊系统：

1. **客户端检测**：检测虚拟定位、模拟器、Root/越狱
2. **传感器验证**：验证传感器数据真实性（时序分析、物理规律）
3. **行为分析**：实时分析捕捉行为特征（速度、轨迹、频率）
4. **服务器验证**：验证捕捉请求合法性（位置合理性、设备指纹）
5. **响应机制**：自动封禁、降权、人工审核

### 可量化目标
- 作弊检测准确率 ≥ 95%
- 误判率 < 0.1%
- 作弊用户封禁响应时间 < 5 分钟
- 正常用户零感知

## 3. 范围

### 包含
- 客户端环境检测（虚拟定位、模拟器、Root）
- 传感器数据验证引擎
- 捕捉行为实时分析
- 服务器端验证服务
- 风险评分和响应系统
- 管理员审核界面

### 不包含
- 支付反欺诈（已有 REQ-00313）
- 账号盗用检测（已有 REQ-00219）
- 第三方数据处理（REQ-00467）

## 4. 详细需求

### 4.1 客户端环境检测

#### 4.1.1 虚拟定位检测
```javascript
// game-client/src/security/gpsValidator.js

class GPSValidator {
  // 检测 GPS 欺骗特征
  async detectSpoofing() {
    const checks = [];
    
    // 1. 检测 Mock Location 设置
    if (await this.isMockLocationEnabled()) {
      checks.push({ type: 'mock_location_enabled', severity: 'high' });
    }
    
    // 2. 检测位置提供者来源
    const provider = await this.getLocationProvider();
    if (provider === 'mock' || provider.includes('fake')) {
      checks.push({ type: 'mock_provider', severity: 'high' });
    }
    
    // 3. GPS 信号特征分析
    const signal = await this.analyzeGPSSignal();
    if (signal.accuracy === 0 && signal.satellites === 0) {
      checks.push({ type: 'invalid_signal', severity: 'high' });
    }
    
    // 4. Android API 31+ Mock Location 检测
    if (await this.isMockLocationDetected()) {
      checks.push({ type: 'api_mock_detected', severity: 'high' });
    }
    
    return checks;
  }
  
  // 检测位置跳变（瞬移）
  detectTeleportation(history) {
    const jumps = [];
    for (let i = 1; i < history.length; i++) {
      const distance = this.calculateDistance(
        history[i-1], history[i]
      );
      const timeDiff = history[i].timestamp - history[i-1].timestamp;
      const speed = distance / (timeDiff / 1000); // m/s
      
      // 速度超过 200 km/h（飞机速度）视为瞬移
      if (speed > 55.5) {
        jumps.push({
          from: history[i-1],
          to: history[i],
          distance,
          speed,
          timestamp: history[i].timestamp
        });
      }
    }
    return jumps;
  }
}
```

#### 4.1.2 模拟器检测
```javascript
// game-client/src/security/emulatorDetector.js

class EmulatorDetector {
  async detect() {
    const signals = [];
    
    // 1. 检测模拟器特征文件
    const emulatorFiles = [
      '/dev/socket/qemud',
      '/dev/qemu_pipe',
      '/system/lib/libc_malloc_debug_qemu.so',
      '/sys/qemu_trace'
    ];
    
    for (const file of emulatorFiles) {
      if (await this.fileExists(file)) {
        signals.push({ type: 'emulator_file', file });
      }
    }
    
    // 2. 检测模拟器属性
    const props = await this.getSystemProperties();
    if (props['ro.product.model']?.includes('sdk') ||
        props['ro.product.model']?.includes('emulator')) {
      signals.push({ type: 'emulator_property', prop: 'model' });
    }
    
    // 3. 检测传感器真实性
    const sensors = await this.getSensorList();
    if (sensors.length < 3) { // 真实设备至少有加速度、陀螺仪、磁力计
      signals.push({ type: 'insufficient_sensors', count: sensors.length });
    }
    
    // 4. 检测电池信息
    const battery = await this.getBatteryInfo();
    if (!battery.present || battery.health === 'unknown') {
      signals.push({ type: 'invalid_battery' });
    }
    
    return {
      isEmulator: signals.length >= 2,
      signals,
      confidence: this.calculateConfidence(signals)
    };
  }
}
```

#### 4.1.3 Root/越狱检测
```javascript
// game-client/src/security/rootDetector.js

class RootDetector {
  async detectRoot() {
    const indicators = [];
    
    // 1. 检测 Root 管理应用
    const rootApps = [
      'com.koushikdutta.superuser',
      'com.thirdparty.superuser',
      'eu.chainfire.supersu',
      'com.noshufou.android.su'
    ];
    
    for (const pkg of rootApps) {
      if (await this.isPackageInstalled(pkg)) {
        indicators.push({ type: 'root_app_installed', package: pkg });
      }
    }
    
    // 2. 检测 su 二进制文件
    const suPaths = [
      '/system/bin/su',
      '/system/xbin/su',
      '/sbin/su',
      '/system/su',
      '/data/local/xbin/su'
    ];
    
    for (const path of suPaths) {
      if (await this.fileExists(path)) {
        indicators.push({ type: 'su_binary', path });
      }
    }
    
    // 3. 检测可写系统分区
    if (await this.isSystemWritable()) {
      indicators.push({ type: 'writable_system' });
    }
    
    return {
      isRooted: indicators.length > 0,
      indicators,
      riskLevel: indicators.length >= 3 ? 'high' : 'medium'
    };
  }
}
```

### 4.2 传感器数据验证

#### 4.2.1 传感器验证引擎
```javascript
// backend/security/src/sensorValidator.js

class SensorValidator {
  // 验证陀螺仪数据真实性
  validateGyroscope(data) {
    const anomalies = [];
    
    // 1. 检测数据平滑度（模拟数据通常过于平滑）
    const smoothness = this.calculateSmoothness(data);
    if (smoothness > 0.95) {
      anomalies.push({ type: 'too_smooth', value: smoothness });
    }
    
    // 2. 检测噪声特征（真实传感器有自然噪声）
    const noise = this.calculateNoise(data);
    if (noise < 0.001) {
      anomalies.push({ type: 'insufficient_noise', value: noise });
    }
    
    // 3. 检测数据连续性
    const gaps = this.detectGaps(data);
    if (gaps.length > 0) {
      anomalies.push({ type: 'data_gaps', count: gaps.length });
    }
    
    // 4. 物理规律验证（角速度限制）
    const maxAngularVelocity = Math.max(...data.map(d => Math.abs(d.angularVelocity)));
    if (maxAngularVelocity > 50) { // 人类操作极限约 10-20 rad/s
      anomalies.push({ type: 'unrealistic_velocity', value: maxAngularVelocity });
    }
    
    return {
      isValid: anomalies.length === 0,
      anomalies,
      confidence: 1 - (anomalies.length * 0.2)
    };
  }
  
  // 验证加速度计数据
  validateAccelerometer(data) {
    const anomalies = [];
    
    // 1. 重力加速度检测（真实设备应始终有约 9.8 m/s²）
    const avgMagnitude = this.calculateAverageMagnitude(data);
    if (Math.abs(avgMagnitude - 9.8) > 0.5) {
      anomalies.push({ type: 'invalid_gravity', value: avgMagnitude });
    }
    
    // 2. 数据一致性（静止状态数据应稳定）
    const variance = this.calculateVariance(data);
    if (data.state === 'stationary' && variance > 0.1) {
      anomalies.push({ type: 'unstable_stationary', variance });
    }
    
    return {
      isValid: anomalies.length === 0,
      anomalies
    };
  }
}
```

### 4.3 捕捉行为分析

#### 4.3.1 捕捉行为分析引擎
```javascript
// backend/analysis/src/captureBehaviorAnalyzer.js

class CaptureBehaviorAnalyzer {
  // 分析捕捉行为特征
  async analyzeCapture(userId, captureData) {
    const features = await this.extractFeatures(userId, captureData);
    const riskScore = this.calculateRiskScore(features);
    
    return {
      riskScore,
      riskLevel: this.classifyRisk(riskScore),
      features,
      flags: this.generateFlags(features),
      recommendation: this.generateRecommendation(riskScore)
    };
  }
  
  // 提取特征
  async extractFeatures(userId, captureData) {
    return {
      // 位置相关
      locationEntropy: await this.calculateLocationEntropy(userId),
      locationJumpCount: await this.countLocationJumps(userId, { hours: 24 }),
      impossibleTravel: await this.detectImpossibleTravel(userId),
      
      // 捕捉行为
      captureSuccessRate: await this.calculateSuccessRate(userId),
      captureSpeed: this.calculateCaptureSpeed(captureData),
      capturePattern: await this.analyzeCapturePattern(userId),
      
      // 设备特征
      deviceChanges: await this.countDeviceChanges(userId),
      deviceFingerprint: captureData.deviceFingerprint,
      
      // 时间特征
      playTimePattern: await this.analyzePlayTimePattern(userId),
      captureIntervals: await this.analyzeCaptureIntervals(userId)
    };
  }
  
  // 计算风险分数
  calculateRiskScore(features) {
    let score = 0;
    
    // 位置风险（权重 30%）
    if (features.locationEntropy < 0.3) score += 20; // 位置过于集中
    if (features.locationJumpCount > 5) score += 15; // 频繁瞬移
    if (features.impossibleTravel) score += 30; // 不可能的位置移动
    
    // 捕捉成功率（权重 20%）
    if (features.captureSuccessRate > 0.95) score += 15; // 异常高成功率
    
    // 设备风险（权重 25%）
    if (features.deviceChanges > 3) score += 10;
    if (!features.deviceFingerprint.valid) score += 20;
    
    // 时间模式（权重 25%）
    if (features.captureIntervals.variance < 0.1) score += 15; // 自动化脚本特征
    
    return Math.min(100, score);
  }
}
```

### 4.4 服务器端验证

#### 4.4.1 捕捉请求验证服务
```javascript
// backend/security/src/captureValidator.js

class CaptureValidator {
  async validateCaptureRequest(userId, requestData) {
    const validations = [];
    
    // 1. 位置合理性验证
    const locationValid = await this.validateLocation(
      userId,
      requestData.location,
      requestData.timestamp
    );
    validations.push(locationValid);
    
    // 2. 设备指纹验证
    const deviceValid = await this.validateDevice(
      userId,
      requestData.deviceFingerprint
    );
    validations.push(deviceValid);
    
    // 3. 传感器数据验证
    const sensorValid = await this.validateSensors(
      requestData.sensorData
    );
    validations.push(sensorValid);
    
    // 4. 捕捉窗口验证
    const windowValid = await this.validateCaptureWindow(
      userId,
      requestData.pokemonId,
      requestData.captureSessionId
    );
    validations.push(windowValid);
    
    // 5. 客户端检测结果验证
    const clientChecksValid = await this.validateClientChecks(
      requestData.clientSecurityChecks
    );
    validations.push(clientChecksValid);
    
    const overallValid = validations.every(v => v.valid);
    const riskLevel = this.calculateOverallRisk(validations);
    
    return {
      valid: overallValid,
      riskLevel,
      validations,
      action: this.determineAction(riskLevel)
    };
  }
  
  determineAction(riskLevel) {
    switch (riskLevel) {
      case 'critical':
        return { type: 'reject', reason: 'security_violation', log: true };
      case 'high':
        return { type: 'flag', reason: 'suspicious_activity', review: true };
      case 'medium':
        return { type: 'monitor', reason: 'anomaly_detected', track: true };
      case 'low':
      default:
        return { type: 'allow', reason: 'normal' };
    }
  }
}
```

### 4.5 响应机制

#### 4.5.1 反作弊响应引擎
```javascript
// backend/security/src/antiCheatResponse.js

class AntiCheatResponse {
  async handleViolation(userId, violation) {
    const response = await this.determineResponse(userId, violation);
    
    switch (response.type) {
      case 'ban':
        await this.banUser(userId, response);
        break;
      case 'suspend':
        await this.suspendUser(userId, response);
        break;
      case 'shadow_ban':
        await this.shadowBanUser(userId, response);
        break;
      case 'warn':
        await this.warnUser(userId, response);
        break;
      case 'flag':
        await this.flagForReview(userId, violation);
        break;
    }
    
    await this.logResponse(userId, violation, response);
    return response;
  }
  
  async determineResponse(userId, violation) {
    const history = await this.getViolationHistory(userId);
    const severity = this.calculateSeverity(violation, history);
    
    // 响应策略
    if (severity >= 90) {
      return {
        type: 'ban',
        duration: 'permanent',
        reason: violation.type,
        appealable: true
      };
    } else if (severity >= 70) {
      return {
        type: 'suspend',
        duration: '7_days',
        reason: violation.type,
        appealable: true
      };
    } else if (severity >= 50) {
      return {
        type: 'shadow_ban',
        duration: '30_days',
        effects: ['reduced_spawn_rate', 'increased_flee_rate']
      };
    } else if (severity >= 30) {
      return {
        type: 'warn',
        message: 'suspicious_activity_detected',
        strike: true
      };
    } else {
      return {
        type: 'flag',
        reason: 'minor_anomaly'
      };
    }
  }
}
```

### 4.6 API 设计

```
POST /api/v1/security/capture/validate
     验证捕捉请求（内部调用）

POST /api/v1/security/device/register
     注册设备指纹

GET  /api/v1/security/device/verify
     验证设备状态

POST /api/v1/admin/security/violations
     查询违规记录（管理员）

POST /api/v1/admin/security/respond
     执行反作弊响应（管理员）
```

### 4.7 数据库设计

```sql
-- 设备指纹表
CREATE TABLE device_fingerprints (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id VARCHAR(100) NOT NULL,
  fingerprint_hash VARCHAR(64) NOT NULL,
  device_info JSONB NOT NULL,
  security_flags JSONB,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_trusted BOOLEAN DEFAULT false,
  UNIQUE(device_id, fingerprint_hash)
);

CREATE INDEX idx_device_fingerprints_user ON device_fingerprints(user_id, last_seen DESC);

-- 捕捉验证记录表
CREATE TABLE capture_validations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  pokemon_id INTEGER NOT NULL,
  capture_session_id VARCHAR(100) NOT NULL,
  validation_result JSONB NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  action_taken VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_capture_validations_user ON capture_validations(user_id, created_at DESC);
CREATE INDEX idx_capture_validations_risk ON capture_validations(risk_level, created_at);

-- 违规记录表
CREATE TABLE security_violations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  violation_type VARCHAR(50) NOT NULL,
  severity INTEGER NOT NULL,
  evidence JSONB NOT NULL,
  response_type VARCHAR(50),
  response_details JSONB,
  status VARCHAR(50) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id)
);

CREATE INDEX idx_security_violations_user ON security_violations(user_id, created_at DESC);
CREATE INDEX idx_security_violations_status ON security_violations(status, created_at);
```

### 4.8 监控指标

```javascript
// Prometheus 指标
capture_validation_total                  // 捕捉验证总数（按风险等级分组）
capture_validation_blocked_total          // 被阻止的捕捉请求数
device_fingerprint_registered_total       // 注册的设备指纹数
security_violation_detected_total         // 检测到的违规数（按类型分组）
anti_cheat_action_taken_total             // 执行的反作弊响应数（按类型分组）
sensor_validation_failed_total            // 传感器验证失败数
gps_spoofing_detected_total               // 检测到的 GPS 欺骗数
emulator_detected_total                   // 检测到的模拟器数
```

## 5. 验收标准（可测试）

### 5.1 客户端检测验收
- [ ] 能检测到 Mock Location 开启状态
- [ ] 能检测到常见虚拟定位应用（FakeGPS、GPS Joystick 等）
- [ ] 能检测到模拟器环境（BlueStacks、Nox、Genymotion）
- [ ] 能检测到 Root/越狱状态
- [ ] 能检测到 Frida/Xposed 注入框架

### 5.2 传感器验证验收
- [ ] 能识别伪造的陀螺仪数据（过于平滑）
- [ ] 能识别伪造的加速度计数据（重力异常）
- [ ] 能检测传感器数据缺失/不连续

### 5.3 行为分析验收
- [ ] 能检测瞬移行为（位置跳变）
- [ ] 能检测异常高的捕捉成功率
- [ ] 能检测自动化脚本特征（规律性操作）
- [ ] 能检测多设备登录

### 5.4 响应机制验收
- [ ] 严重违规自动封禁
- [ ] 可疑行为自动降权
- [ ] 轻微异常自动标记审核
- [] 所有响应记录审计日志
- [ ] 支持用户申诉流程

### 5.5 性能验收
- [ ] 捕捉验证响应时间 < 100ms
- [ ] 客户端检测不影响帧率
- [ ] 行为分析延迟 < 500ms

### 5.6 测试覆盖
- [ ] 检测模块单元测试覆盖率 ≥ 80%
- [ ] 验证服务集成测试覆盖率 ≥ 90%
- [ ] 端到端安全测试覆盖主要攻击场景

## 6. 工作量估算

**XL（Extra Large）**

**理由**：
这是一个多层次的纵深防御系统，涉及客户端、服务端、数据分析多个层面，工作量大。

1. **客户端开发**（3 天）：
   - GPS 欺骗检测（1 天）
   - 模拟器检测（0.5 天）
   - Root 检测（0.5 天）
   - 传感器数据采集（0.5 天）
   - 设备指纹生成（0.5 天）

2. **服务端开发**（3 天）：
   - 传感器验证引擎（1 天）
   - 捕捉行为分析（1 天）
   - 反作弊响应引擎（0.5 天）
   - API 开发（0.5 天）

3. **数据分析**（2 天）：
   - 行为特征提取（1 天）
   - 风险评分模型（0.5 天）
   - 规则引擎配置（0.5 天）

4. **管理界面**（1 天）：
   - 违规记录查询（0.5 天）
   - 审核操作界面（0.5 天）

5. **测试和优化**（2 天）：
   - 单元测试（1 天）
   - 集成测试（0.5 天）
   - 端到端安全测试（0.5 天）

**总计**：11 人天

## 7. 优先级理由

**P0（最高优先级）**

**理由**：
1. **核心玩法保护**：AR 捕捉是游戏核心玩法，作弊会直接破坏游戏体验
2. **公平性保障**：作弊用户获取不正当优势，导致正常用户流失
3. **经济系统保护**：稀有精灵是游戏核心经济，作弊会导致通货膨胀
4. **合规要求**：反作弊措施不足可能面临用户投诉和法律风险
5. **紧急性**：作为上线前的核心安全需求，必须优先实现

**对"项目可用"的贡献**：
- 保护核心玩法，确保游戏公平性
- 防止作弊破坏游戏经济系统
- 提升正常用户体验，降低流失率
- 满足上线前的安全合规要求
- 建立完善的反作弊纵深防御体系
