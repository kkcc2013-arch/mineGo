# REQ-00356：游戏光敏性癫痫防护与运动敏感性设置系统

- **编号**：REQ-00356
- **类别**：无障碍(a11y)
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、gateway、user-service、backend/shared、database/migrations
- **创建时间**：2026-06-29 06:05 UTC
- **依赖需求**：REQ-00017（基础无障碍支持）、REQ-00352（音效可视化）

## 1. 背景与问题

### 1.1 光敏性癫痫风险

当前 mineGo 游戏包含多种可能触发光敏性癫痫的视觉元素：
- **进化动画**：强烈的白色闪光、颜色快速交替
- **战斗技能特效**：高频闪烁、快速颜色切换
- **捕捉成功动画**：爆炸效果、星星散射
- **道馆战斗**：激光束、能量波、连续闪光
- **天气效果**：雷电、暴风雪、阳光

**数据**：
- 约 **3%** 的癫痫患者具有光敏性（约 1/4000 人口）
- 闪光频率 **5-30 Hz** 最易诱发癫痫发作
- 红-蓝交替、高对比度闪烁风险最高

### 1.2 运动敏感性影响

部分玩家对快速运动、旋转、缩放效果敏感，可能导致：
- **眩晕**：快速镜头移动、旋转动画
- **恶心**：第一人称视角的快速移动
- **视觉疲劳**：持续闪烁、高频动画

### 1.3 当前实现缺失

**已有功能**：
- REQ-00017：基础无障碍（色盲模式、高对比度）
- REQ-00352：音效可视化（听障玩家支持）

**缺失功能**：
- 无癫痫防护模式（减少闪烁、移除闪光）
- 无运动敏感性设置（减少动画、禁用旋转）
- 无闪光频率限制机制
- 无动画替代方案（静态图像替代动画）

## 2. 目标

为光敏性和运动敏感玩家提供安全、可定制的游戏体验，实现：
1. **癫痫防护模式**：禁用高风险视觉元素，降低闪光频率至安全阈值
2. **运动敏感性设置**：减少或禁用快速运动、旋转、缩放动画
3. **实时闪光检测与限制**：检测动画中的危险闪烁，自动降级
4. **动画替代方案**：高风险动画替换为静态图像或简化版本
5. **医疗安全合规**：符合 WCAG 2.3（癫痫发作和身体反应）标准

## 3. 范围

### 3.1 包含

- **前端视觉安全层**：
  - AnimationSafeRenderer（动画安全渲染器）
  - FlashFrequencyLimiter（闪光频率限制器）
  - MotionSensitivityController（运动敏感性控制器）
  - SafeAnimationAlternatives（安全动画替代方案）

- **用户偏好设置**：
  - 癫痫防护模式开关（强/中/弱三级）
  - 运动敏感性设置面板
  - 动画速度调节（正常/减慢/禁用）
  - 自定义安全阈值

- **后端支持**：
  - 用户安全偏好存储
  - 动画安全评分系统
  - 实时安全检查中间件

- **数据库设计**：
  - `user_safety_preferences` 表
  - `animation_safety_rules` 表
  - `flash_event_log` 表

### 3.2 不包含

- 医疗诊断功能（仅提供安全设置）
- 自定义动画上传（安全风险）
- VR/AR 设备的专项优化（需单独需求）

## 4. 详细需求

### 4.1 癫痫防护模式

#### 4.1.1 三级防护强度

```javascript
const EPILEPSY_PROTECTION_LEVELS = {
  off: {
    name: '关闭',
    description: '无任何限制',
    flashLimit: null,
    contrastLimit: null,
    animationRestriction: 'none'
  },
  moderate: {
    name: '中等防护',
    description: '减少闪烁，限制对比度',
    flashLimit: { maxHz: 3, maxBrightness: 0.7 },
    contrastLimit: { maxRatio: 4.5 },
    animationRestriction: 'reduce_flashes'
  },
  strong: {
    name: '强防护',
    description: '禁用所有闪烁和快速动画',
    flashLimit: { maxHz: 0, maxBrightness: 0.5 },
    contrastLimit: { maxRatio: 2.0 },
    animationRestriction: 'disable_flashes',
    alternatives: 'static_images'
  }
};
```

#### 4.1.2 闪光频率检测算法

```javascript
class FlashFrequencyAnalyzer {
  constructor() {
    this.history = [];
    this.maxHistoryLength = 60; // 1秒@60fps
  }

  analyze(frame) {
    // 计算当前帧亮度变化率
    const brightness = this.calculateBrightness(frame);
    const previousBrightness = this.history[this.history.length - 1];
    
    if (previousBrightness) {
      const delta = Math.abs(brightness - previousBrightness);
      this.history.push(delta);
      
      // 检测闪光频率
      const flashCount = this.detectFlashes(this.history);
      const frequency = flashCount; // flashes per second
      
      return {
        isDangerous: frequency > 3, // > 3 Hz
        frequency,
        recommendation: this.getRecommendation(frequency)
      };
    }
    
    this.history.push(brightness);
    return { isDangerous: false, frequency: 0 };
  }

  detectFlashes(history) {
    const threshold = 0.2; // 20% brightness change = flash
    let flashCount = 0;
    let prevSign = null;
    
    for (let i = 1; i < history.length; i++) {
      const sign = history[i] > history[i-1] ? 1 : -1;
      if (prevSign && sign !== prevSign && history[i] > threshold) {
        flashCount++;
      }
      prevSign = sign;
    }
    
    return flashCount;
  }
}
```

#### 4.1.3 高风险动画降级策略

```javascript
const ANIMATION_DOWNGRADE_RULES = {
  // 进化动画
  evolution_flash: {
    dangerLevel: 'critical',
    original: { type: 'flash', duration: 2000, intensity: 1.0 },
    moderate: { type: 'glow', duration: 3000, intensity: 0.5 },
    strong: { type: 'static', image: 'evolution_success.png' }
  },
  
  // 战斗技能
  battle_beam: {
    dangerLevel: 'high',
    original: { type: 'laser', flickerRate: 10, colors: ['red', 'blue'] },
    moderate: { type: 'laser', flickerRate: 2, colors: ['white'] },
    strong: { type: 'static', image: 'beam_hit.png' }
  },
  
  // 捕捉成功
  catch_explosion: {
    dangerLevel: 'high',
    original: { type: 'particles', count: 100, sparkle: true },
    moderate: { type: 'particles', count: 20, sparkle: false },
    strong: { type: 'fade', duration: 500 }
  },
  
  // 天气效果
  lightning: {
    dangerLevel: 'critical',
    original: { type: 'flash', randomInterval: true },
    moderate: { type: 'dim_flash', maxIntensity: 0.3 },
    strong: { type: 'static_overlay', image: 'clouds.png' }
  }
};
```

### 4.2 运动敏感性设置

#### 4.2.1 运动类型分类

```javascript
const MOTION_SENSITIVITY_TYPES = {
  rotation: {
    name: '旋转运动',
    examples: ['精灵选择转盘', '物品轮盘', '3D模型旋转'],
    defaultReduction: 0.5
  },
  translation: {
    name: '快速移动',
    examples: ['镜头快速切换', '地图滚动', '滑动捕捉'],
    defaultReduction: 0.3
  },
  scaling: {
    name: '缩放动画',
    examples: ['精灵放大详情', 'UI 弹窗缩放', '地图缩放'],
    defaultReduction: 0.4
  },
  parallax: {
    name: '视差效果',
    examples: ['地图背景层', '3D场景深度', 'UI 浮动效果'],
    defaultReduction: 0.6
  },
  particles: {
    name: '粒子效果',
    examples: ['星星散射', '技能粒子', '天气粒子'],
    defaultReduction: 0.5
  }
};
```

#### 4.2.2 运动限制器

```javascript
class MotionLimiter {
  constructor(preferences) {
    this.preferences = preferences;
  }

  applyMotionReduction(animation) {
    const type = this.classifyMotion(animation);
    const reduction = this.preferences[type] || 0;
    
    if (reduction >= 1.0) {
      return this.getStaticAlternative(animation);
    }
    
    return {
      ...animation,
      duration: animation.duration * (1 + reduction),
      speed: animation.speed * (1 - reduction),
      amplitude: animation.amplitude * (1 - reduction)
    };
  }

  getStaticAlternative(animation) {
    return {
      type: 'static',
      image: animation.staticFallback || 'placeholder.png',
      duration: 100
    };
  }
}
```

### 4.3 实时安全监控

#### 4.3.1 帧级安全检查

```javascript
class AnimationSafetyMonitor {
  constructor() {
    this.flashAnalyzer = new FlashFrequencyAnalyzer();
    this.motionAnalyzer = new MotionAnalyzer();
    this.violations = [];
  }

  checkFrame(frame, preferences) {
    const violations = [];
    
    // 闪光检查
    if (preferences.epilepsyProtection !== 'off') {
      const flashResult = this.flashAnalyzer.analyze(frame);
      if (flashResult.isDangerous) {
        violations.push({
          type: 'flash_danger',
          severity: 'high',
          details: flashResult
        });
      }
    }
    
    // 运动检查
    if (preferences.motionSensitivityEnabled) {
      const motionResult = this.motionAnalyzer.analyze(frame);
      if (motionResult.isDangerous) {
        violations.push({
          type: 'motion_danger',
          severity: 'medium',
          details: motionResult
        });
      }
    }
    
    if (violations.length > 0) {
      this.violations.push({
        timestamp: Date.now(),
        violations,
        frame: frame.id
      });
      
      // 自动降级
      return {
        safe: false,
        action: 'downgrade',
        alternative: this.getSafeAlternative(frame, preferences)
      };
    }
    
    return { safe: true };
  }
}
```

### 4.4 用户界面设计

#### 4.4.1 安全设置面板

```html
<!-- frontend/game-client/src/components/SafetySettingsPanel.html -->
<div id="safety-settings-panel" class="settings-panel">
  <h2>无障碍安全设置</h2>
  
  <!-- 癫痫防护 -->
  <section class="safety-section">
    <h3>⚡ 癫痫防护模式</h3>
    <div class="protection-levels">
      <label>
        <input type="radio" name="epilepsy-protection" value="off">
        <span class="level-label">关闭</span>
        <span class="level-desc">无任何限制</span>
      </label>
      <label>
        <input type="radio" name="epilepsy-protection" value="moderate" checked>
        <span class="level-label">中等防护</span>
        <span class="level-desc">减少闪烁，限制对比度</span>
      </label>
      <label>
        <input type="radio" name="epilepsy-protection" value="strong">
        <span class="level-label">强防护</span>
        <span class="level-desc">禁用所有闪烁和快速动画</span>
      </label>
    </div>
  </section>
  
  <!-- 运动敏感性 -->
  <section class="safety-section">
    <h3>🎭 运动敏感性设置</h3>
    <div class="motion-settings">
      <div class="motion-slider">
        <label>旋转动画</label>
        <input type="range" min="0" max="100" value="50" data-motion="rotation">
        <span class="slider-value">50%</span>
      </div>
      <div class="motion-slider">
        <label>快速移动</label>
        <input type="range" min="0" max="100" value="30" data-motion="translation">
        <span class="slider-value">30%</span>
      </div>
      <div class="motion-slider">
        <label>缩放动画</label>
        <input type="range" min="0" max="100" value="40" data-motion="scaling">
        <span class="slider-value">40%</span>
      </div>
      <div class="motion-slider">
        <label>粒子效果</label>
        <input type="range" min="0" max="100" value="50" data-motion="particles">
        <span class="slider-value">50%</span>
      </div>
    </div>
    
    <button class="disable-all-motion">禁用所有动画</button>
  </section>
  
  <!-- 高风险场景提示 -->
  <section class="safety-section">
    <h3>⚠️ 高风险场景</h3>
    <ul class="risk-list">
      <li><input type="checkbox" checked> 精灵进化动画</li>
      <li><input type="checkbox" checked> 战斗技能特效</li>
      <li><input type="checkbox" checked> 天气效果（雷电）</li>
      <li><input type="checkbox" checked> 道馆战斗闪光</li>
    </ul>
    <p class="risk-note">选中项将自动应用安全替代方案</p>
  </section>
  
  <!-- 保存按钮 -->
  <button class="save-safety-settings">保存设置</button>
</div>
```

### 4.5 数据库设计

#### 4.5.1 用户安全偏好表

```sql
-- 用户安全偏好表
CREATE TABLE IF NOT EXISTS user_safety_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- 癫痫防护
  epilepsy_protection VARCHAR(20) DEFAULT 'moderate' CHECK (epilepsy_protection IN ('off', 'moderate', 'strong')),
  max_flash_hz REAL DEFAULT 3.0,
  max_contrast_ratio REAL DEFAULT 4.5,
  
  -- 运动敏感性
  motion_sensitivity_enabled BOOLEAN DEFAULT false,
  rotation_reduction REAL DEFAULT 0.5 CHECK (rotation_reduction BETWEEN 0 AND 1),
  translation_reduction REAL DEFAULT 0.3 CHECK (translation_reduction BETWEEN 0 AND 1),
  scaling_reduction REAL DEFAULT 0.4 CHECK (scaling_reduction BETWEEN 0 AND 1),
  parallax_reduction REAL DEFAULT 0.6 CHECK (parallax_reduction BETWEEN 0 AND 1),
  particles_reduction REAL DEFAULT 0.5 CHECK (particles_reduction BETWEEN 0 AND 1),
  
  -- 高风险场景
  safe_evolution BOOLEAN DEFAULT true,
  safe_battle_effects BOOLEAN DEFAULT true,
  safe_weather_effects BOOLEAN DEFAULT true,
  safe_gym_flashes BOOLEAN DEFAULT true,
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_safety_prefs_user ON user_safety_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_safety_prefs_epilepsy ON user_safety_preferences(epilepsy_protection);
```

#### 4.5.2 动画安全规则表

```sql
-- 动画安全规则表
CREATE TABLE IF NOT EXISTS animation_safety_rules (
  id SERIAL PRIMARY KEY,
  animation_id VARCHAR(100) NOT NULL UNIQUE,
  animation_name VARCHAR(200) NOT NULL,
  category VARCHAR(50) NOT NULL,
  
  -- 风险评估
  danger_level VARCHAR(20) NOT NULL CHECK (danger_level IN ('low', 'medium', 'high', 'critical')),
  flash_frequency REAL,
  contrast_ratio REAL,
  motion_intensity REAL,
  
  -- 替代方案
  moderate_alternative JSONB,
  strong_alternative JSONB,
  static_fallback VARCHAR(200),
  
  -- 元数据
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 插入常见高风险动画规则
INSERT INTO animation_safety_rules (animation_id, animation_name, category, danger_level, flash_frequency, contrast_ratio, motion_intensity) VALUES
('evolution_flash', '精灵进化闪光', 'evolution', 'critical', 8.0, 10.0, 0.8),
('battle_beam', '战斗激光束', 'battle', 'high', 12.0, 7.5, 0.6),
('catch_explosion', '捕捉爆炸效果', 'catch', 'high', 15.0, 6.0, 0.7),
('lightning', '雷电天气效果', 'weather', 'critical', 20.0, 12.0, 0.9),
('gym_flash', '道馆战斗闪光', 'gym', 'high', 10.0, 8.0, 0.5),
('skill_particles', '技能粒子效果', 'battle', 'medium', 5.0, 4.0, 0.6),
('catch_stars', '捕捉星星散射', 'catch', 'medium', 6.0, 5.0, 0.4),
('weather_snow', '暴风雪效果', 'weather', 'medium', 3.0, 3.0, 0.7)
ON CONFLICT (animation_id) DO NOTHING;
```

#### 4.5.3 安全事件日志表

```sql
-- 安全事件日志表
CREATE TABLE IF NOT EXISTS safety_event_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_type VARCHAR(50) NOT NULL,
  animation_id VARCHAR(100),
  
  -- 事件详情
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warning', 'danger', 'critical')),
  flash_frequency REAL,
  motion_intensity REAL,
  
  -- 处理结果
  action_taken VARCHAR(50),
  alternative_applied VARCHAR(100),
  
  -- 上下文
  game_context JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_safety_log_user ON safety_event_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_log_severity ON safety_event_log(severity, created_at);
CREATE INDEX IF NOT EXISTS idx_safety_log_animation ON safety_event_log(animation_id);
```

### 4.6 API 设计

#### 4.6.1 用户安全偏好 API

```javascript
// GET /api/safety/preferences
router.get('/preferences', requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const { rows: [prefs] } = await query(
    `SELECT * FROM user_safety_preferences WHERE user_id = $1`,
    [userId]
  );
  
  res.json({
    success: true,
    data: prefs || {
      epilepsy_protection: 'moderate',
      motion_sensitivity_enabled: false,
      rotation_reduction: 0.5,
      translation_reduction: 0.3,
      scaling_reduction: 0.4,
      parallax_reduction: 0.6,
      particles_reduction: 0.5
    }
  });
});

// PUT /api/safety/preferences
router.put('/preferences', requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const {
    epilepsy_protection,
    motion_sensitivity_enabled,
    rotation_reduction,
    translation_reduction,
    scaling_reduction,
    parallax_reduction,
    particles_reduction,
    safe_evolution,
    safe_battle_effects,
    safe_weather_effects,
    safe_gym_flashes
  } = req.body;
  
  const { rows: [prefs] } = await query(
    `INSERT INTO user_safety_preferences (
      user_id, epilepsy_protection, motion_sensitivity_enabled,
      rotation_reduction, translation_reduction, scaling_reduction,
      parallax_reduction, particles_reduction,
      safe_evolution, safe_battle_effects, safe_weather_effects, safe_gym_flashes,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      epilepsy_protection = EXCLUDED.epilepsy_protection,
      motion_sensitivity_enabled = EXCLUDED.motion_sensitivity_enabled,
      rotation_reduction = EXCLUDED.rotation_reduction,
      translation_reduction = EXCLUDED.translation_reduction,
      scaling_reduction = EXCLUDED.scaling_reduction,
      parallax_reduction = EXCLUDED.parallax_reduction,
      particles_reduction = EXCLUDED.particles_reduction,
      safe_evolution = EXCLUDED.safe_evolution,
      safe_battle_effects = EXCLUDED.safe_battle_effects,
      safe_weather_effects = EXCLUDED.safe_weather_effects,
      safe_gym_flashes = EXCLUDED.safe_gym_flashes,
      updated_at = NOW()
    RETURNING *`,
    [userId, epilepsy_protection, motion_sensitivity_enabled,
     rotation_reduction, translation_reduction, scaling_reduction,
     parallax_reduction, particles_reduction,
     safe_evolution, safe_battle_effects, safe_weather_effects, safe_gym_flashes]
  );
  
  // 记录偏好变更
  logger.info('Safety preferences updated', { userId, prefs });
  
  res.json({
    success: true,
    data: prefs
  });
});
```

#### 4.6.2 动画安全检查 API

```javascript
// POST /api/safety/check-animation
router.post('/check-animation', async (req, res) => {
  const { animation_id, frames } = req.body;
  
  // 获取动画规则
  const { rows: [rule] } = await query(
    `SELECT * FROM animation_safety_rules WHERE animation_id = $1`,
    [animation_id]
  );
  
  if (!rule) {
    return res.json({
      success: true,
      data: { safe: true, risk_level: 'unknown' }
    });
  }
  
  // 分析帧数据
  const analyzer = new FlashFrequencyAnalyzer();
  const analysis = analyzer.analyzeFrames(frames);
  
  res.json({
    success: true,
    data: {
      safe: analysis.isDangerous === false,
      risk_level: rule.danger_level,
      flash_frequency: analysis.frequency,
      recommendation: analysis.recommendation,
      alternatives: {
        moderate: rule.moderate_alternative,
        strong: rule.strong_alternative,
        static: rule.static_fallback
      }
    }
  });
});
```

### 4.7 前端集成

#### 4.7.1 安全渲染管理器

```javascript
// frontend/game-client/src/accessibility/SafeAnimationRenderer.js
export class SafeAnimationRenderer {
  constructor(userPreferences) {
    this.preferences = userPreferences;
    this.flashLimiter = new FlashFrequencyLimiter();
    this.motionLimiter = new MotionLimiter(userPreferences);
    this.safetyMonitor = new AnimationSafetyMonitor();
  }

  async renderAnimation(animation) {
    // 获取安全规则
    const rule = await this.getSafetyRule(animation.id);
    
    // 应用安全设置
    const safeAnimation = this.applySafetySettings(animation, rule);
    
    // 渲染前检查
    const safetyCheck = this.safetyMonitor.preCheck(safeAnimation);
    
    if (!safetyCheck.safe) {
      // 使用替代方案
      return this.renderAlternative(safeAnimation, safetyCheck.alternative);
    }
    
    // 正常渲染
    return this.render(safeAnimation);
  }

  applySafetySettings(animation, rule) {
    const protectionLevel = this.preferences.epilepsy_protection;
    
    if (protectionLevel === 'off') {
      return animation;
    }
    
    if (protectionLevel === 'strong') {
      return {
        type: 'static',
        image: rule.static_fallback,
        duration: 100
      };
    }
    
    // 中等防护：应用规则
    return {
      ...animation,
      ...rule.moderate_alternative,
      flashLimiter: this.flashLimiter
    };
  }
}
```

#### 4.7.2 Vue/React 组件示例

```vue
<!-- SafetySettings.vue -->
<template>
  <div class="safety-settings">
    <h2>无障碍安全设置</h2>
    
    <section class="epilepsy-protection">
      <h3>⚡ 癫痫防护模式</h3>
      <div class="protection-levels">
        <label v-for="level in protectionLevels" :key="level.value">
          <input 
            type="radio" 
            :value="level.value"
            v-model="preferences.epilepsy_protection"
          >
          <span class="level-label">{{ level.name }}</span>
          <span class="level-desc">{{ level.description }}</span>
        </label>
      </div>
    </section>
    
    <section class="motion-sensitivity">
      <h3>🎭 运动敏感性</h3>
      <div class="motion-controls">
        <div v-for="motion in motionTypes" :key="motion.type" class="motion-slider">
          <label>{{ motion.name }}</label>
          <input 
            type="range" 
            min="0" 
            max="100" 
            v-model="preferences[motion.type + '_reduction']"
          >
          <span>{{ preferences[motion.type + '_reduction'] }}%</span>
        </div>
      </div>
    </section>
    
    <button @click="savePreferences" class="save-btn">
      保存设置
    </button>
  </div>
</template>

<script>
export default {
  data() {
    return {
      preferences: {
        epilepsy_protection: 'moderate',
        motion_sensitivity_enabled: false,
        rotation_reduction: 50,
        translation_reduction: 30,
        scaling_reduction: 40,
        particles_reduction: 50
      },
      protectionLevels: [
        { value: 'off', name: '关闭', description: '无任何限制' },
        { value: 'moderate', name: '中等防护', description: '减少闪烁，限制对比度' },
        { value: 'strong', name: '强防护', description: '禁用所有闪烁和快速动画' }
      ],
      motionTypes: [
        { type: 'rotation', name: '旋转动画' },
        { type: 'translation', name: '快速移动' },
        { type: 'scaling', name: '缩放动画' },
        { type: 'particles', name: '粒子效果' }
      ]
    };
  },
  methods: {
    async savePreferences() {
      try {
        const response = await fetch('/api/safety/preferences', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.$auth.token}`
          },
          body: JSON.stringify(this.preferences)
        });
        
        const data = await response.json();
        
        if (data.success) {
          this.$toast.success('安全设置已保存');
          this.$emit('saved', this.preferences);
        }
      } catch (error) {
        this.$toast.error('保存失败：' + error.message);
      }
    }
  }
};
</script>

<style scoped>
.safety-settings {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
}

.protection-levels label {
  display: flex;
  flex-direction: column;
  padding: 15px;
  margin: 10px 0;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  cursor: pointer;
}

.protection-levels input:checked + .level-label {
  color: #4CAF50;
  font-weight: bold;
}

.motion-slider {
  display: flex;
  align-items: center;
  gap: 15px;
  margin: 15px 0;
}

.motion-slider input[type="range"] {
  flex: 1;
  height: 8px;
}

.save-btn {
  width: 100%;
  padding: 15px;
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;
  margin-top: 20px;
}

.save-btn:hover {
  background: #45a049;
}
</style>
```

### 4.8 性能优化

#### 4.8.1 预计算安全评分

```javascript
// 后台任务：预计算动画安全评分
class AnimationSafetyScorer {
  async scoreAnimation(animationId) {
    const { rows: [rule] } = await query(
      `SELECT * FROM animation_safety_rules WHERE animation_id = $1`,
      [animationId]
    );
    
    if (!rule) return { score: 100 };
    
    // 计算综合安全评分（0-100，越高越安全）
    let score = 100;
    
    // 闪光频率扣分
    if (rule.flash_frequency > 3) score -= (rule.flash_frequency - 3) * 5;
    if (rule.flash_frequency > 10) score -= 20; // 额外惩罚
    
    // 对比度扣分
    if (rule.contrast_ratio > 4.5) score -= (rule.contrast_ratio - 4.5) * 3;
    
    // 运动强度扣分
    if (rule.motion_intensity > 0.5) score -= (rule.motion_intensity - 0.5) * 30;
    
    // 危险等级扣分
    const dangerPenalties = { low: 0, medium: 10, high: 25, critical: 50 };
    score -= dangerPenalties[rule.danger_level] || 0;
    
    return {
      score: Math.max(0, Math.min(100, score)),
      risk_factors: {
        flash: rule.flash_frequency > 3,
        contrast: rule.contrast_ratio > 4.5,
        motion: rule.motion_intensity > 0.5
      }
    };
  }
}
```

### 4.9 监控与告警

#### 4.9.1 Prometheus 指标

```javascript
const safetyMetrics = {
  animationSafetyChecks: new promClient.Counter({
    name: 'safety_animation_checks_total',
    help: 'Total animation safety checks',
    labelNames: ['animation_id', 'risk_level']
  }),
  
  safetyViolations: new promClient.Counter({
    name: 'safety_violations_total',
    help: 'Total safety violations detected',
    labelNames: ['violation_type', 'severity']
  }),
  
  preferencesUpdates: new promClient.Counter({
    name: 'safety_preferences_updates_total',
    help: 'Total safety preferences updates',
    labelNames: ['protection_level']
  })
};
```

## 5. 验收标准（可测试）

- [ ] **癫痫防护模式**：三级防护（关闭/中等/强）全部生效，中等模式下闪光频率不超过 3 Hz
- [ ] **闪光检测算法**：实时检测准确率 > 95%，误报率 < 5%，检测延迟 < 16ms（1帧@60fps）
- [ ] **运动敏感性设置**：5种运动类型（旋转/移动/缩放/视差/粒子）可独立调节 0-100%
- [ ] **动画降级策略**：所有高风险动画（进化/战斗/天气）均有静态替代方案，切换延迟 < 100ms
- [ ] **用户偏好持久化**：设置保存成功，下次登录自动加载，响应时间 < 200ms
- [ ] **实时安全监控**：帧级安全检查，危险帧自动降级，日志记录完整
- [ ] **API 可用性**：所有 API 响应时间 P95 < 200ms，错误率 < 0.1%
- [ ] **数据库完整性**：三张表（user_safety_preferences, animation_safety_rules, safety_event_log）创建成功，索引优化
- [ ] **前端 UI 可用性**：设置面板可访问，响应式设计，符合 WCAG 2.1 AA 标准
- [ ] **性能无退化**：开启安全模式后，帧率不低于 30fps，内存增长 < 50MB

## 6. 工作量估算

**等级**：L（大型需求）

**理由**：
- 前端：安全渲染器、闪光检测算法、运动限制器、设置 UI（预计 3-4 天）
- 后端：用户偏好 API、安全检查 API、数据库设计（预计 2 天）
- 测试：单元测试、集成测试、E2E 测试、安全验证（预计 2 天）
- 文档：API 文档、用户指南、安全白皮书（预计 1 天）

**总计**：约 8-9 个工作日（1-1.5 周）

## 7. 优先级理由

**P0（最高优先级）**：
1. **安全关键**：直接关系到玩家健康和生命安全，属于强制性无障碍需求
2. **法律合规**：符合 WCAG 2.3（癫痫发作和身体反应）要求，避免法律风险
3. **社会责任**：体现游戏公司对弱势群体的关怀，提升品牌形象
4. **用户基数**：全球约 1/4000 人口受光敏性癫痫影响，影响范围广
5. **技术基础**：为后续无障碍功能奠定基础，具有战略意义

## 8. 风险与缓解

### 8.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 闪光检测算法误报率高 | 用户体验下降 | 结合机器学习模型，持续优化阈值 |
| 性能开销影响帧率 | 游戏流畅度降低 | 预计算安全评分，GPU 加速检测 |
| 替代动画质量不足 | 视觉体验下降 | 设计师团队专项制作静态替代方案 |

### 8.2 业务风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 用户不理解设置含义 | 设置使用率低 | 提供预设模板和智能