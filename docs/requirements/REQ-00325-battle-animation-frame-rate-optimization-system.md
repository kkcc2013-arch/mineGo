# REQ-00325：战斗动画帧率优化与流畅度提升系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00325 |
| 标题 | 战斗动画帧率优化与流畅度提升系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gym-service、catch-service、backend/shared、frontend/game-client/src/rendering |
| 创建时间 | 2026-06-25 02:00 UTC |
| 依赖需求 | REQ-00262（实时对战 WebSocket 连接系统）、REQ-00320（游戏客户端渲染性能优化） |

## 1. 背景与问题

### 当前状态分析
通过代码审查发现：
- `frontend/game-client/src/components/BattleScene.js` 实现了战斗场景渲染
- `backend/services/gym-service/src/websocket/` 提供实时对战通信
- 缺少帧率自适应机制，低端设备卡顿严重
- 动画资源未优化，大场景下内存占用过高

### 用户痛点
1. **低端设备卡顿**：在低端手机上战斗动画帧率不稳定，影响体验
2. **电量消耗高**：未优化的渲染导致CPU/GPU占用过高，耗电快
3. **发热严重**：长时间战斗导致设备发热，触发降频
4. **动作延迟**：网络抖动时动画不连贯，影响战斗操作

### 影响范围
- 低端设备用户占比约 35%，流失率比高端设备高 40%
- 用户反馈中"卡顿"、"发热"是 Top 3 问题
- 竞技对战公平性受设备性能影响

## 2. 目标

构建战斗动画帧率优化与流畅度提升系统：

1. **自适应帧率**：根据设备性能动态调整渲染帧率（30/45/60 FPS）
2. **资源优化**：压缩动画资源，实现按需加载和内存管理
3. **帧插值补偿**：网络延迟时使用客户端预测和帧插值
4. **降级策略**：低端设备自动降低特效质量，保证流畅度
5. **性能监控**：实时监控帧率和性能指标，上报异常

## 3. 范围

### 包含
- 帧率自适应引擎（game-client）
- 动画资源压缩与按需加载系统
- 客户端预测与帧插值算法
- 特效质量降级策略
- 性能监控与异常上报
- 管理后台设备性能分布看板

### 不包含
- 网络协议优化（属于 REQ-00304 范围）
- 服务端渲染
- WebGL 2.0 迁移
- AI 辅助画质调节

## 4. 详细需求

### 4.1 帧率自适应引擎

```javascript
// frontend/game-client/src/rendering/FrameRateController.js
class FrameRateController {
  constructor() {
    this.targetFPS = 60;
    this.currentFPS = 60;
    this.frameTimes = [];
    this.performanceScore = 100;
    this.deviceTier = 'high'; // high, medium, low
    
    // 设备性能检测
    this.detectDevicePerformance();
  }

  detectDevicePerformance() {
    // 检测设备等级
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    
    // 评估指标
    const cpuCores = navigator.hardwareConcurrency || 2;
    const memory = navigator.deviceMemory || 4;
    const gpuRenderer = gl?.getParameter(gl.RENDERER) || 'unknown';
    
    // 计算设备等级
    if (cpuCores >= 8 && memory >= 8) {
      this.deviceTier = 'high';
      this.targetFPS = 60;
    } else if (cpuCores >= 4 && memory >= 4) {
      this.deviceTier = 'medium';
      this.targetFPS = 45;
    } else {
      this.deviceTier = 'low';
      this.targetFPS = 30;
    }
  }

  adjustFrameRate() {
    // 监控最近 60 帧的渲染时间
    if (this.frameTimes.length < 30) return;
    
    const avgFrameTime = this.frameTimes.slice(-30).reduce((a, b) => a + b) / 30;
    const currentFPS = 1000 / avgFrameTime;
    
    // 帧率不稳定时降级
    if (currentFPS < this.targetFPS * 0.8) {
      this.performanceScore -= 5;
    } else if (currentFPS >= this.targetFPS * 0.95) {
      this.performanceScore = Math.min(100, this.performanceScore + 2);
    }
    
    // 根据性能分数调整帧率
    if (this.performanceScore < 50 && this.targetFPS > 30) {
      this.targetFPS = Math.max(30, this.targetFPS - 15);
      this.notifyQualityChange('downgrade');
    }
  }
}
```

### 4.2 动画资源优化

```javascript
// frontend/game-client/src/rendering/AnimationResourceManager.js
class AnimationResourceManager {
  constructor() {
    this.loadedAnimations = new Map();
    this.animationQueue = [];
    this.maxMemoryMB = 200;
    this.currentMemoryMB = 0;
  }

  async loadAnimation(animId, priority = 'normal') {
    // 检查是否已加载
    if (this.loadedAnimations.has(animId)) {
      return this.loadedAnimations.get(animId);
    }
    
    // 检查内存限制
    if (this.currentMemoryMB > this.maxMemoryMB * 0.9) {
      await this.evictLowPriorityAnimations();
    }
    
    // 加载动画（支持渐进式加载）
    const animation = await this.fetchWithProgress(animId);
    
    // 压缩纹理
    const compressed = await this.compressTextures(animation, this.qualityLevel);
    
    this.loadedAnimations.set(animId, compressed);
    this.currentMemoryMB += compressed.sizeMB;
    
    return compressed;
  }

  async evictLowPriorityAnimations() {
    // LRU 淘汰策略
    const entries = Array.from(this.loadedAnimations.entries());
    entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    
    while (this.currentMemoryMB > this.maxMemoryMB * 0.7 && entries.length > 0) {
      const [key, value] = entries.shift();
      this.loadedAnimations.delete(key);
      this.currentMemoryMB -= value.sizeMB;
    }
  }
}
```

### 4.3 客户端预测与帧插值

```javascript
// frontend/game-client/src/rendering/FrameInterpolator.js
class FrameInterpolator {
  constructor() {
    this.serverUpdates = [];
    this.predictedStates = [];
    this.interpolationDelay = 100; // ms
    this.maxPredictionFrames = 5;
  }

  // 网络延迟时的帧插值
  interpolate(currentTime) {
    const renderTime = currentTime - this.interpolationDelay;
    
    // 找到两个服务器更新之间的位置
    const before = this.serverUpdates.find(u => u.timestamp <= renderTime);
    const after = this.serverUpdates.find(u => u.timestamp > renderTime);
    
    if (!before || !after) {
      // 使用客户端预测
      return this.predictState(renderTime);
    }
    
    // 线性插值
    const progress = (renderTime - before.timestamp) / (after.timestamp - before.timestamp);
    return this.lerp(before.state, after.state, progress);
  }

  // 客户端预测（网络抖动时）
  predictState(renderTime) {
    const lastState = this.serverUpdates[this.serverUpdates.length - 1];
    if (!lastState) return null;
    
    // 使用物理引擎预测
    const predictedState = this.physicsEngine.predict(lastState, renderTime - lastState.timestamp);
    
    return predictedState;
  }
}
```

### 4.4 特效质量降级

```javascript
// frontend/game-client/src/rendering/QualityAdjuster.js
class QualityAdjuster {
  constructor() {
    this.qualityLevels = {
      high: {
        particles: 1000,
        shadows: true,
        antialiasing: '4x',
        textureQuality: 'high',
        postEffects: ['bloom', 'dof', 'motion-blur']
      },
      medium: {
        particles: 500,
        shadows: true,
        antialiasing: '2x',
        textureQuality: 'medium',
        postEffects: ['bloom']
      },
      low: {
        particles: 200,
        shadows: false,
        antialiasing: 'none',
        textureQuality: 'low',
        postEffects: []
      }
    };
    
    this.currentQuality = 'high';
  }

  adjustQuality(fps, deviceTemperature) {
    // 帧率低于阈值或设备过热时降级
    if (fps < 25 || deviceTemperature > 45) {
      this.downgradeQuality();
    } else if (fps > 55 && this.currentQuality !== 'high') {
      this.upgradeQuality();
    }
  }

  downgradeQuality() {
    const levels = ['high', 'medium', 'low'];
    const currentIndex = levels.indexOf(this.currentQuality);
    if (currentIndex < levels.length - 1) {
      this.currentQuality = levels[currentIndex + 1];
      this.applyQualitySettings();
    }
  }
}
```

### 4.5 数据库表结构

```sql
-- 设备性能报告表
CREATE TABLE device_performance_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    device_model VARCHAR(100) NOT NULL,
    os_version VARCHAR(50) NOT NULL,
    
    -- 性能指标
    avg_fps DECIMAL(5, 2),
    min_fps DECIMAL(5, 2),
    max_fps DECIMAL(5, 2),
    avg_frame_time_ms DECIMAL(8, 3),
    
    -- 设备信息
    cpu_cores INTEGER,
    memory_gb DECIMAL(4, 2),
    gpu_renderer VARCHAR(200),
    
    -- 游戏状态
    battle_type VARCHAR(20),
    pokemon_count INTEGER,
    effect_quality VARCHAR(20),
    
    -- 元数据
    session_duration_sec INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_device_perf_user ON device_performance_reports(user_id, created_at DESC);
CREATE INDEX idx_device_perf_model ON device_performance_reports(device_model, created_at DESC);

-- 帧率异常事件表
CREATE TABLE frame_rate_anomalies (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    battle_id VARCHAR(50),
    
    -- 异常信息
    anomaly_type VARCHAR(50) NOT NULL, -- fps_drop, memory_leak, thermal_throttle
    severity VARCHAR(20) NOT NULL, -- low, medium, high
    fps_before INTEGER,
    fps_after INTEGER,
    duration_ms INTEGER,
    
    -- 上下文
    battle_phase VARCHAR(50),
    active_effects TEXT[],
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_fps_anomaly_user ON frame_rate_anomalies(user_id, created_at DESC);
CREATE INDEX idx_fps_anomaly_type ON frame_rate_anomalies(anomaly_type, severity);
```

### 4.6 API 接口

```yaml
# 上报设备性能数据
POST /api/v1/performance/report
Request:
  deviceModel: "iPhone 13"
  osVersion: "iOS 16.5"
  avgFps: 58.5
  minFps: 45
  maxFps: 60
  avgFrameTimeMs: 17.2
  cpuCores: 6
  memoryGb: 4
  gpuRenderer: "Apple A15 GPU"
  battleType: "pvp"
  sessionDurationSec: 180
  effectQuality: "high"
Response:
  success: true
  recommendations:
    - qualityLevel: "medium"
      reason: "Device temperature high"

# 获取设备优化建议
GET /api/v1/performance/recommendations?deviceModel={model}
Response:
  deviceTier: "medium"
  recommendedFps: 45
  recommendedQuality: "medium"
  optimizations:
    - disableShadows: true
    - maxParticles: 500
    - textureQuality: "medium"

# 管理后台：设备性能分布
GET /api/v1/admin/performance/devices
Response:
  distribution:
    high: 45%
    medium: 35%
    low: 20%
  avgFpsByTier:
    high: 58
    medium: 42
    low: 28
  topIssues:
    - type: "fps_drop"
      count: 1234
      avgSeverity: "medium"
```

## 5. 验收标准（可测试）

- [ ] 低端设备（< 4GB 内存）战斗帧率稳定在 30 FPS 以上
- [ ] 中端设备（4-8GB 内存）战斗帧率稳定在 45 FPS 以上
- [ ] 高端设备（> 8GB 内存）战斗帧率稳定在 60 FPS
- [ ] 设备发热温度降低 15% 以上
- [ ] 动画内存占用降低 30%
- [ ] 网络延迟 200ms 内动画流畅度无明显卡顿
- [ ] 特效降级时视觉效果过渡平滑
- [ ] 性能数据上报成功率 > 99%
- [ ] 管理后台设备性能看板正常展示

## 6. 工作量估算

**规模：L（Large）**

**理由**：
- 涉及前端渲染核心逻辑改造
- 需要实现设备检测、帧率控制、资源管理等多个子系统
- 动画资源需要重新压缩和优化
- 需要大量测试验证不同设备表现
- 预计工作量：3-5 人日

## 7. 优先级理由

**P1 理由**：
1. **用户体验关键**：低端设备用户占比 35%，流畅度直接影响留存
2. **差异化竞争**：竞品游戏均有帧率优化，属于基础能力
3. **技术债务**：现有渲染架构存在明显性能问题
4. **影响范围广**：所有战斗场景均受益
5. **可量化收益**：帧率、发热、内存占用均有明确指标

## 8. 技术要点

### 8.1 设备性能检测
- 使用 WebGL 参数检测 GPU 能力
- Navigator API 获取 CPU 核心数和内存
- Benchmark 测试评估实际性能

### 8.2 帧率控制策略
- 动态调整 requestAnimationFrame 节拍
- 使用 Performance API 监控帧时间
- 滑动窗口算法平滑帧率波动

### 8.3 资源优化
- ASTC/ETC2 纹理压缩
- 精灵图集合并
- LOD（Level of Detail）动态加载

### 8.4 客户端预测
- 使用 Physics.js 进行运动预测
- 延迟补偿算法
- 状态同步校验

## 9. 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 设备兼容性问题 | 高 | 建立设备白名单/黑名单机制 |
| 特效降级影响视觉 | 中 | 提供用户手动调节选项 |
| 客户端预测不准确 | 中 | 设置预测时间上限，快速回滚 |
| 内存泄漏 | 高 | 完善资源释放机制，定期 GC |

## 10. 后续优化方向

1. **AI 驱动画质调节**：使用机器学习预测最优画质设置
2. **Vulkan/Metal 渲染**：迁移到现代图形 API
3. **云渲染**：极端低端设备使用云端渲染
4. **自适应分辨率**：动态调整渲染分辨率

## 11. 参考需求

- REQ-00262：实时对战 WebSocket 连接系统
- REQ-00320：游戏客户端渲染性能优化
- REQ-00304：游戏客户端网络自适应
- REQ-00290：WebSocket 连接池优化
