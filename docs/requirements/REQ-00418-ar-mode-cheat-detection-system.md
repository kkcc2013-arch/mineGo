# REQ-00418：AR 模式作弊检测与照片验证系统

- **编号**：REQ-00418
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务**：catch-service、location-service、gateway、shared/anti-cheat、admin-dashboard
- **创建时间**：2026-07-01 20:00
- **依赖需求**：REQ-00010 GPS 伪造检测与速度限制反作弊系统（已完成）

## 1. 背景与问题

AR 模式是 mineGo 的核心玩法，玩家通过设备摄像头捕捉精灵。当前系统存在多种 AR 模式作弊手段：

1. **照片伪造**：使用预存照片或 AI 生成的图片替代实时拍摄
2. **时间篡改**：修改设备时间绕过活动限制或延长捕捉窗口
3. **环境伪造**：使用虚假背景或 AR 模拟器伪造精灵出现场景
4. **EXIF 数据篡改**：修改照片元数据伪造 GPS 位置和时间
5. **客户端修改**：绕过 AR 检测逻辑，直接触发捕捉成功

这些作弊行为严重破坏游戏公平性，让作弊者轻松获得稀有精灵和奖励。

## 2. 目标

建立 AR 模式多层验证系统，检测并拦截照片伪造、时间篡改等作弊行为：
- 照片真实性检测准确率 > 90%
- EXIF 数据验证覆盖率 100%
- 检测延迟 < 500ms，不影响用户体验
- 提供完整的作弊审计追踪

## 3. 范围

- **包含**：照片真实性检测、EXIF 验证、时间戳验证、环境一致性检查、客户端完整性校验
- **不包含**：经济系统风控（REQ-00416 已覆盖）、GPS 伪造检测（REQ-00010 已覆盖）

## 4. 详细需求

### 4.1 照片真实性检测

```javascript
// shared/anti-cheat/ar-photo-validator.js

class ARPhotoValidator {
  constructor() {
    this.config = {
      maxPhotoAge: 30000,           // 照片最大年龄（30秒）
      minResolution: { width: 640, height: 480 },
      requiredExifFields: ['DateTimeOriginal', 'GPSLatitude', 'GPSLongitude'],
      maxFileSize: 10 * 1024 * 1024,  // 10MB
      allowedFormats: ['jpeg', 'png', 'webp']
    };
  }

  async validate(photoData, context) {
    const results = {
      valid: true,
      checks: {},
      riskScore: 0,
      warnings: []
    };

    // 1. EXIF 数据验证
    const exifCheck = await this.validateExifData(photoData, context);
    results.checks.exif = exifCheck;
    if (!exifCheck.valid) {
      results.riskScore += 30;
      results.warnings.push('EXIF 数据异常');
    }

    // 2. 时间戳验证
    const timeCheck = await this.validateTimestamp(photoData, context);
    results.checks.timestamp = timeCheck;
    if (!timeCheck.valid) {
      results.riskScore += 25;
      results.warnings.push('时间戳异常');
    }

    // 3. GPS 位置一致性
    const locationCheck = await this.validateLocationConsistency(photoData, context);
    results.checks.location = locationCheck;
    if (!locationCheck.valid) {
      results.riskScore += 35;
      results.warnings.push('位置数据不一致');
    }

    // 4. 照片新鲜度检查
    const freshnessCheck = await this.checkPhotoFreshness(photoData);
    results.checks.freshness = freshnessCheck;
    if (!freshnessCheck.valid) {
      results.riskScore += 20;
      results.warnings.push('照片非实时拍摄');
    }

    // 5. 图像内容分析
    const contentCheck = await this.analyzeImageContent(photoData);
    results.checks.content = contentCheck;
    if (contentCheck.suspicious) {
      results.riskScore += 40;
      results.warnings.push('图像内容可疑');
    }

    results.valid = results.riskScore < 50;
    return results;
  }

  async validateExifData(photoData, context) {
    const exif = photoData.exif || {};
    const result = { valid: true, missing: [], modified: [] };

    // 检查必需字段
    for (const field of this.config.requiredExifFields) {
      if (!exif[field]) {
        result.missing.push(field);
        result.valid = false;
      }
    }

    // 检查 EXIF 数据是否被篡改
    if (exif.DateTimeOriginal) {
      const photoTime = new Date(exif.DateTimeOriginal);
      const serverTime = new Date(context.serverTime);
      const diff = Math.abs(photoTime - serverTime);
      
      if (diff > 60000) {  // 时间差超过60秒
        result.modified.push('DateTimeOriginal');
        result.timeDiff = diff;
        result.valid = false;
      }
    }

    return result;
  }

  async checkPhotoFreshness(photoData) {
    // 检查照片拍摄时间与上传时间差
    const captureTime = photoData.captureTime || Date.now();
    const uploadTime = photoData.uploadTime || Date.now();
    const age = uploadTime - captureTime;

    return {
      valid: age <= this.config.maxPhotoAge,
      age,
      maxAge: this.config.maxPhotoAge
    };
  }

  async analyzeImageContent(photoData) {
    // 检查图像是否为预存照片或 AI 生成
    // 实际实现需要集成图像分析服务
    return {
      suspicious: false,
      confidence: 0.85,
      analysisType: 'content_fingerprint'
    };
  }
}
```

### 4.2 设备时间戳验证

```javascript
// shared/anti-cheat/time-tampering-detector.js

class TimeTamperingDetector {
  constructor(redis) {
    this.redis = redis;
    this.windowSize = 60000;  // 60秒窗口
  }

  async validateDeviceTime(userId, deviceTime, serverTime) {
    const result = {
      valid: true,
      deviation: 0,
      pattern: 'normal'
    };

    const deviation = Math.abs(deviceTime - serverTime);
    result.deviation = deviation;

    // 记录时间偏差历史
    await this.recordTimeDeviation(userId, deviation);

    // 检查时间篡改模式
    const pattern = await this.analyzeTimePattern(userId);
    result.pattern = pattern;

    if (deviation > 30000) {  // 超过30秒偏差
      result.valid = false;
      result.reason = 'large_time_deviation';
    }

    if (pattern === 'manipulated') {
      result.valid = false;
      result.reason = 'time_manipulation_detected';
    }

    return result;
  }

  async recordTimeDeviation(userId, deviation) {
    const key = `time_deviation:${userId}`;
    await this.redis.lpush(key, deviation);
    await this.redis.ltrim(key, 0, 99);  // 保留最近100条
    await this.redis.expire(key, 3600);  // 1小时过期
  }

  async analyzeTimePattern(userId) {
    const key = `time_deviation:${userId}`;
    const deviations = await this.redis.lrange(key, 0, -1);

    if (deviations.length < 10) {
      return 'insufficient_data';
    }

    const values = deviations.map(Number);
    
    // 检查是否存在人为调整模式（如突然大偏差）
    const maxDev = Math.max(...values);
    const avgDev = values.reduce((a, b) => a + b, 0) / values.length;

    // 如果最大偏差远大于平均偏差，可能是人为调整
    if (maxDev > avgDev * 5 && maxDev > 30000) {
      return 'manipulated';
    }

    // 如果偏差持续稳定且较大，可能是设备时间错误设置
    if (avgDev > 20000 && Math.max(...values) - Math.min(...values) < 5000) {
      return 'systematic_error';
    }

    return 'normal';
  }
}
```

### 4.3 AR 模式完整性校验

```javascript
// catch-service/src/middleware/ar-integrity-check.js

class ARIntegrityMiddleware {
  constructor(photoValidator, timeDetector) {
    this.photoValidator = photoValidator;
    this.timeDetector = timeDetector;
  }

  async validate(req, res, next) {
    const { photo, arSession } = req.body;
    const userId = req.user.sub;
    const serverTime = Date.now();

    // 1. 检查 AR 会话是否有效
    const sessionValid = await this.validateARSession(arSession, userId);
    if (!sessionValid.valid) {
      return res.status(400).json({
        code: 8001,
        message: 'AR 会话无效',
        data: sessionValid
      });
    }

    // 2. 验证照片真实性
    const photoResult = await this.photoValidator.validate(photo, {
      userId,
      serverTime,
      location: req.body.location
    });

    if (!photoResult.valid) {
      await this.logARCheating(userId, photoResult, 'photo_validation_failed');
      
      return res.status(403).json({
        code: 8002,
        message: '照片验证失败',
        data: {
          warnings: photoResult.warnings,
          riskScore: photoResult.riskScore
        }
      });
    }

    // 3. 设备时间验证
    const deviceTime = req.body.deviceTime || Date.now();
    const timeResult = await this.timeDetector.validateDeviceTime(
      userId, deviceTime, serverTime
    );

    if (!timeResult.valid) {
      await this.logARCheating(userId, timeResult, 'time_tampering');
      
      return res.status(403).json({
        code: 8003,
        message: '设备时间异常',
        data: timeResult
      });
    }

    // 记录风险分数
    req.arValidation = {
      photoResult,
      timeResult,
      sessionValid,
      totalRiskScore: photoResult.riskScore + (timeResult.valid ? 0 : 25)
    };

    next();
  }

  async validateARSession(session, userId) {
    // 验证 AR 会话是否由服务器发起
    const sessionKey = `ar_session:${userId}:${session.id}`;
    const storedSession = await this.redis.get(sessionKey);

    if (!storedSession) {
      return { valid: false, reason: 'session_not_found' };
    }

    const parsed = JSON.parse(storedSession);
    const age = Date.now() - parsed.createdAt;

    if (age > 120000) {  // AR 会话最长120秒
      return { valid: false, reason: 'session_expired' };
    }

    // 验证精灵 ID 是否匹配
    if (session.pokemonId !== parsed.pokemonId) {
      return { valid: false, reason: 'pokemon_mismatch' };
    }

    return { valid: true, session: parsed };
  }
}
```

### 4.4 客户端完整性签名

```javascript
// gateway/src/middleware/client-integrity.js

class ClientIntegrityMiddleware {
  constructor() {
    this.requiredSignatureFields = [
      'deviceId', 'timestamp', 'nonce', 'sessionId'
    ];
  }

  async verify(req, res, next) {
    const signature = req.headers['x-client-signature'];
    const payload = req.body;

    if (!signature) {
      return res.status(401).json({
        code: 8004,
        message: '缺少客户端签名'
      });
    }

    // 验证签名完整性
    const integrity = await this.verifySignature(signature, payload, req.user.sub);

    if (!integrity.valid) {
      await this.logIntegrityViolation(req.user.sub, integrity);
      
      return res.status(403).json({
        code: 8005,
        message: '客户端完整性验证失败',
        data: integrity
      });
    }

    req.clientIntegrity = integrity;
    next();
  }

  async verifySignature(signature, payload, userId) {
    // 解析签名
    const decoded = this.decodeSignature(signature);
    
    // 检查必需字段
    const missing = this.requiredSignatureFields.filter(
      f => !decoded[f]
    );

    if (missing.length > 0) {
      return {
        valid: false,
        reason: 'missing_fields',
        missing
      };
    }

    // 验证时间戳
    const timestampAge = Date.now() - decoded.timestamp;
    if (timestampAge > 30000) {
      return {
        valid: false,
        reason: 'signature_expired',
        age: timestampAge
      };
    }

    // 验证 nonce（防止重放）
    const nonceKey = `nonce:${userId}:${decoded.nonce}`;
    const exists = await this.redis.exists(nonceKey);
    if (exists) {
      return {
        valid: false,
        reason: 'nonce_reused'
      };
    }
    await this.redis.setex(nonceKey, 60, '1');

    return { valid: true, decoded };
  }
}
```

### 4.5 数据库 Schema

```sql
-- AR 捕捉验证记录
CREATE TABLE ar_capture_validations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  pokemon_id INTEGER NOT NULL,
  photo_hash VARCHAR(64),
  exif_data JSONB,
  validation_result JSONB,
  risk_score INTEGER,
  warnings TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ar_validation_user ON ar_capture_validations(user_id, created_at DESC);

-- AR 作弊事件表
CREATE TABLE ar_cheat_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  event_type VARCHAR(50) NOT NULL,  -- 'photo_fake', 'time_tampering', 'exif_modified'
  detection_method VARCHAR(50),
  evidence JSONB,
  action_taken VARCHAR(50),  -- 'warned', 'blocked', 'banned'
  reviewed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ar_cheat_user ON ar_cheat_events(user_id, created_at DESC);
CREATE INDEX idx_ar_cheat_type ON ar_cheat_events(event_type, created_at DESC);
```

### 4.6 Prometheus 指标

```javascript
const arMetrics = {
  validationsTotal: new Counter({
    name: 'minego_ar_validations_total',
    help: 'Total AR photo validations',
    labelNames: ['result']  // 'valid', 'invalid', 'blocked'
  }),

  cheatDetectionsTotal: new Counter({
    name: 'minego_ar_cheat_detections_total',
    help: 'AR cheating detections by type',
    labelNames: ['type']  // 'photo_fake', 'time_tampering', 'exif_modified'
  }),

  validationLatency: new Histogram({
    name: 'minego_ar_validation_latency_ms',
    help: 'AR validation latency',
    buckets: [50, 100, 200, 500, 1000]
  }),

  riskScoreDistribution: new Histogram({
    name: 'minego_ar_risk_score',
    help: 'AR capture risk score distribution',
    buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  })
};
```

## 5. 验收标准

- [ ] 照片真实性检测：EXIF 数据验证、时间戳验证、GPS 位置一致性检查全部生效
- [ ] 设备时间篡改检测：偏差超过 30 秒触发警告，模式分析识别人为调整
- [ ] AR 会话完整性校验：会话 ID、精灵 ID、创建时间验证全部生效
- [ ] 客户端签名验证：必需字段、时间戳过期、 nonce 重放检测全部生效
- [ ] 检测延迟 < 500ms，不影响正常捕捉流程
- [ ] 数据库表创建完成，索引优化查询性能
- [ ] Prometheus 指标可查询：validations_total、cheat_detections_total 等
- [ ] 管理后台可查看 AR 作弊事件统计和详情
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

L - 需要实现多个验证模块、数据库表、API 接口、管理界面

## 7. 优先级理由

P1 - AR 模式是核心玩法，作弊行为严重影响游戏公平性和玩家体验，需要优先防护。