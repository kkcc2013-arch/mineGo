# REQ-00064：风险触发式人机验证（CAPTCHA）系统

- **编号**：REQ-00064
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、game-client、backend/shared、Redis
- **创建时间**：2026-06-09 20:15
- **依赖需求**：REQ-00010（GPS伪造检测）、REQ-00028（行为异常检测）、REQ-00045（设备完整性检测）

## 1. 背景与问题

### 现状分析

mineGo 项目已实现多层反作弊检测能力：
- **GPS 伪造检测**（REQ-00010）：速度异常、位置跳变、精度检测
- **行为异常检测**（REQ-00028）：捕捉成功率、移动轨迹、战斗异常、资源增长
- **设备完整性检测**（REQ-00045）：模拟器检测、Root/越狱检测、设备指纹

然而，**缺少关键的人机验证环节**：

1. **无法区分高级作弊与误判**：当检测到可疑行为时，系统只能直接拦截或降低可信度，无法让用户自证清白
2. **缺少"二次验证"机制**：正常玩家在极端情况下可能触发误判（如开车、高铁），缺少申诉通道
3. **无法应对智能脚本**：行为分析依赖统计阈值，智能脚本可控制在阈值内持续作弊
4. **用户体验差**：误判的正常玩家被错误限制功能，影响游戏体验

### 典型场景

- **场景 1**：玩家乘坐高铁，速度触发阈值，被系统标记为作弊，但无法继续游戏
- **场景 2**：运气好的玩家稀有精灵捕捉成功率异常，被误判为作弊，缺少申诉机制
- **场景 3**：脚本控制捕捉频率在阈值内，但 24 小时持续操作，无法通过人机验证阻断
- **场景 4**：多账号群控被检测到设备关联，但无法通过验证区分是否为同一家庭用户

### 影响评估

- 误判率 2-5%，影响正常玩家体验
- 智能脚本可绕过统计阈值检测
- 缺少"灰度处理"机制，只能"通过"或"封禁"

## 2. 目标

构建风险触发式人机验证系统，实现：

1. **智能触发**：基于风险评分自动触发验证，而非固定规则
2. **多类型验证**：支持滑动验证、图形点选、数字计算、行为验证
3. **难度自适应**：根据风险等级调整验证难度（低风险简单验证，高风险复杂验证）
4. **验证结果联动**：验证通过恢复正常，验证失败降级处置
5. **防机器人**：阻止自动化脚本通过验证（时间、轨迹、设备特征）
6. **用户体验优化**：验证过程流畅，不影响正常玩家

**预期效果**：
- 降低误判率至 0.1% 以下
- 阻止 95%+ 智能脚本作弊
- 为可疑玩家提供"自证清白"通道

## 3. 范围

### 包含

- **触发机制**
  - 风险评分阈值触发（可信度 < 60 触发验证）
  - 高风险操作触发（跨区域登录、异常捕捉、设备切换）
  - 定期验证（高风险用户每周强制验证一次）
  - 申诉触发（用户主动申请验证以恢复账号）

- **验证类型**
  - 滑动验证：拖动滑块完成拼图
  - 图形点选：按顺序点击指定字符/图形
  - 数字计算：简单加减法验证
  - 行为验证：基于鼠标轨迹/触摸轨迹判断是否人类

- **难度分级**
  - 低风险（60-80）：简单滑动验证
  - 中风险（40-60）：图形点选 + 计算
  - 高风险（<40）：多重验证（滑动 + 点选 + 计算）

- **后端验证**
  - 验证答案校验
  - 验证时间检测（过快 = 机器人）
  - 验证轨迹分析（过于平滑 = 脚本）
  - 设备指纹校验（验证期间设备一致性）

- **验证结果处理**
  - 验证通过：恢复可信度 + 10 分，清除临时限制
  - 验证失败：降低可信度 - 10 分，限制敏感操作
  - 连续失败 3 次：账号临时冻结，需人工申诉

- **管理后台**
  - 验证记录查询
  - 验证统计（通过率、失败率、平均时间）
  - 验证配置（触发阈值、难度设置）

### 不包含

- 第三方 CAPTCHA 服务集成（如 reCAPTCHA、阿里云滑动验证）
- 图像识别验证（识别图片中的物体）
- 短信/邮箱验证码（已有 REQ-00057 MFA）
- 实名认证（不在本需求范围）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 验证会话表
CREATE TABLE captcha_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_type VARCHAR(20) NOT NULL, -- 'slide', 'click', 'calculate', 'behavior'
  difficulty VARCHAR(20) NOT NULL, -- 'low', 'medium', 'high'
  trigger_reason VARCHAR(50) NOT NULL, -- 'risk_score', 'high_risk_action', 'periodic', 'appeal'
  challenge_data JSONB NOT NULL, -- 验证题目数据（加密）
  expected_answer JSONB NOT NULL, -- 预期答案（加密）
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'passed', 'failed', 'expired'
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL, -- 5分钟后过期
  completed_at TIMESTAMPTZ,
  client_data JSONB, -- 客户端验证数据（时间、轨迹、设备指纹）
  ip_address INET,
  device_fingerprint VARCHAR(128),
  
  INDEX idx_captcha_sessions_user (user_id, created_at DESC),
  INDEX idx_captcha_sessions_status (status, expires_at)
);

-- 验证历史统计表
CREATE TABLE captcha_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_verifications INTEGER DEFAULT 0,
  passed_verifications INTEGER DEFAULT 0,
  failed_verifications INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER,
  last_verification_at TIMESTAMPTZ,
  
  UNIQUE(user_id)
);

-- 验证配置表
CREATE TABLE captcha_config (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 初始配置
INSERT INTO captcha_config (key, value, description) VALUES
('trigger_thresholds', '{"low_risk": 80, "medium_risk": 60, "high_risk": 40}', '风险评分触发阈值'),
('session_timeout_seconds', '300', '验证会话超时时间'),
('max_attempts', '3', '最大尝试次数'),
('difficulty_mapping', '{"low": ["slide"], "medium": ["slide", "click"], "high": ["slide", "click", "calculate"]}', '难度对应验证类型'),
('trust_score_recovery', '10', '验证通过后恢复的可信度'),
('trust_score_penalty', '10', '验证失败后扣除的可信度');
```

### 4.2 验证挑战生成

```javascript
// backend/shared/captchaChallenge.js

/**
 * 滑动验证挑战
 */
function generateSlideChallenge(difficulty) {
  const gridSize = difficulty === 'high' ? 4 : 3;
  const pieces = [];
  
  // 生成拼图块
  for (let i = 0; i < gridSize * gridSize; i++) {
    pieces.push({
      id: i,
      correctPosition: i,
      shufflePosition: null
    });
  }
  
  // 打乱位置
  const shuffled = shuffleArray([...pieces]);
  shuffled.forEach((p, i) => p.shufflePosition = i);
  
  // 空出最后一块作为滑动目标
  const emptySlot = shuffled.pop();
  
  return {
    type: 'slide',
    grid: gridSize,
    pieces: shuffled,
    emptySlot: emptySlot.correctPosition,
    difficulty
  };
}

/**
 * 图形点选挑战
 */
function generateClickChallenge(difficulty) {
  const charSets = {
    low: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''),
    medium: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz'.split(''),
    high: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz!@#$%&*'.split('')
  };
  
  const chars = charSets[difficulty];
  const gridSize = difficulty === 'high' ? 6 : 5;
  const targetCount = difficulty === 'high' ? 4 : 3;
  
  // 随机选择目标字符
  const targetChars = [];
  for (let i = 0; i < targetCount; i++) {
    targetChars.push(chars[Math.floor(Math.random() * chars.length)]);
  }
  
  // 生成网格
  const grid = [];
  for (let i = 0; i < gridSize * gridSize; i++) {
    grid.push(chars[Math.floor(Math.random() * chars.length)]);
  }
  
  // 放置目标字符（确保存在）
  targetChars.forEach(char => {
    const positions = grid.map((c, i) => c === char ? i : -1).filter(i => i >= 0);
    if (positions.length === 0) {
      const randomPos = Math.floor(Math.random() * grid.length);
      grid[randomPos] = char;
    }
  });
  
  return {
    type: 'click',
    grid: gridSize,
    chars: grid,
    targetChars,
    sequence: true, // 是否需要按顺序点击
    difficulty
  };
}

/**
 * 数字计算挑战
 */
function generateCalculateChallenge(difficulty) {
  const ranges = {
    low: { min: 1, max: 10 },
    medium: { min: 10, max: 50 },
    high: { min: 50, max: 100 }
  };
  
  const range = ranges[difficulty];
  const operators = ['+', '-'];
  
  const a = Math.floor(Math.random() * (range.max - range.min)) + range.min;
  const b = Math.floor(Math.random() * (range.max - range.min)) + range.min;
  const op = operators[Math.floor(Math.random() * operators.length)];
  
  const question = `${a} ${op} ${b} = ?`;
  const answer = op === '+' ? a + b : a - b;
  
  return {
    type: 'calculate',
    question,
    answer,
    difficulty
  };
}
```

### 4.3 验证触发器

```javascript
// backend/shared/captchaTrigger.js

const TRIGGER_CONFIG = {
  // 可信度阈值触发
  TRUST_SCORE: {
    LOW: 80,    // < 80: 低风险验证
    MEDIUM: 60, // < 60: 中风险验证
    HIGH: 40    // < 40: 高风险验证
  },
  
  // 高风险操作触发
  HIGH_RISK_ACTIONS: {
    CROSS_REGION_LOGIN: true,      // 跨区域登录
    ANOMALOUS_CATCH: true,         // 异常捕捉
    DEVICE_SWITCH: true,           // 设备切换
    BULK_OPERATION: true,          // 批量操作
    NIGHT_ACTIVITY: true           // 深夜活动（2-6点）
  },
  
  // 定期验证
  PERIODIC: {
    HIGH_RISK_USER_DAYS: 7,  // 高风险用户每周验证
    NORMAL_USER_DAYS: 30     // 正常用户每月验证
  }
};

/**
 * 检查是否需要触发验证
 */
async function shouldTriggerCaptcha(userId, action, context) {
  const user = await getUserTrustData(userId);
  const triggers = [];
  
  // 1. 可信度阈值检查
  if (user.trustScore < TRIGGER_CONFIG.TRUST_SCORE.HIGH) {
    triggers.push({
      reason: 'risk_score',
      difficulty: 'high',
      score: user.trustScore
    });
  } else if (user.trustScore < TRIGGER_CONFIG.TRUST_SCORE.MEDIUM) {
    triggers.push({
      reason: 'risk_score',
      difficulty: 'medium',
      score: user.trustScore
    });
  } else if (user.trustScore < TRIGGER_CONFIG.TRUST_SCORE.LOW) {
    triggers.push({
      reason: 'risk_score',
      difficulty: 'low',
      score: user.trustScore
    });
  }
  
  // 2. 高风险操作检查
  if (action === 'login' && isCrossRegion(context.previousLocation, context.currentLocation)) {
    triggers.push({
      reason: 'cross_region_login',
      difficulty: 'medium'
    });
  }
  
  if (action === 'catch' && await isAnomalousCatch(userId, context)) {
    triggers.push({
      reason: 'anomalous_catch',
      difficulty: 'medium'
    });
  }
  
  // 3. 定期验证检查
  const lastVerification = await getLastVerification(userId);
  const periodicDays = user.trustScore < 60 
    ? TRIGGER_CONFIG.PERIODIC.HIGH_RISK_USER_DAYS 
    : TRIGGER_CONFIG.PERIODIC.NORMAL_USER_DAYS;
  
  if (!lastVerification || daysSince(lastVerification) >= periodicDays) {
    triggers.push({
      reason: 'periodic',
      difficulty: user.trustScore < 60 ? 'medium' : 'low'
    });
  }
  
  return triggers.length > 0 ? triggers[0] : null;
}
```

### 4.4 验证答案校验

```javascript
// backend/shared/captchaValidator.js

/**
 * 验证答案
 */
async function validateCaptchaAnswer(sessionId, answer, clientData) {
  const session = await getCaptchaSession(sessionId);
  
  if (!session) {
    return { valid: false, error: 'session_not_found' };
  }
  
  if (session.status !== 'pending') {
    return { valid: false, error: 'session_already_completed' };
  }
  
  if (new Date() > session.expires_at) {
    await updateSessionStatus(sessionId, 'expired');
    return { valid: false, error: 'session_expired' };
  }
  
  // 检查尝试次数
  if (session.attempt_count >= session.max_attempts) {
    await updateSessionStatus(sessionId, 'failed');
    return { valid: false, error: 'max_attempts_exceeded' };
  }
  
  // 验证答案正确性
  const isCorrect = verifyAnswer(session.challenge_data, session.expected_answer, answer);
  
  // 验证时间（防机器人）
  const responseTime = clientData.responseTimeMs || 0;
  const minTime = session.difficulty === 'high' ? 3000 : 
                  session.difficulty === 'medium' ? 2000 : 1000;
  
  if (responseTime < minTime && isCorrect) {
    // 响应过快，疑似机器人
    logger.warn({ sessionId, responseTime, minTime }, 'Captcha response too fast, possible bot');
    await recordSuspiciousActivity(session.user_id, 'fast_captcha_response');
  }
  
  // 验证轨迹（防脚本）
  if (clientData.trajectory && session.session_type === 'slide') {
    const trajectoryScore = analyzeTrajectory(clientData.trajectory);
    if (trajectoryScore < 0.5) {
      logger.warn({ sessionId, trajectoryScore }, 'Suspicious trajectory, possible script');
      await recordSuspiciousActivity(session.user_id, 'suspicious_trajectory');
    }
  }
  
  // 更新尝试次数
  await incrementAttemptCount(sessionId);
  
  if (isCorrect) {
    // 验证通过
    await updateSessionStatus(sessionId, 'passed', clientData);
    await updateTrustScore(session.user_id, CONFIG.TRUST_SCORE_RECOVERY, 'captcha_passed');
    await updateCaptchaStats(session.user_id, true, responseTime);
    
    return {
      valid: true,
      message: 'Verification passed',
      trustScoreRecovery: CONFIG.TRUST_SCORE_RECOVERY
    };
  } else {
    // 验证失败
    await updateTrustScore(session.user_id, -CONFIG.TRUST_SCORE_PENALTY, 'captcha_failed');
    await updateCaptchaStats(session.user_id, false, responseTime);
    
    const remainingAttempts = session.max_attempts - session.attempt_count - 1;
    
    if (remainingAttempts === 0) {
      await updateSessionStatus(sessionId, 'failed', clientData);
      
      // 连续失败，检查是否需要冻结账号
      const recentFailures = await countRecentFailures(session.user_id, 24);
      if (recentFailures >= 3) {
        await freezeAccount(session.user_id, 'captcha_failures', 24 * 3600);
        return {
          valid: false,
          error: 'account_frozen',
          message: 'Account temporarily frozen due to multiple verification failures',
          contactSupport: true
        };
      }
    }
    
    return {
      valid: false,
      error: 'incorrect_answer',
      remainingAttempts,
      message: `Incorrect answer. ${remainingAttempts} attempts remaining.`
    };
  }
}

/**
 * 轨迹分析（判断是否为人类行为）
 */
function analyzeTrajectory(trajectory) {
  if (!trajectory || trajectory.length < 10) {
    return 0;
  }
  
  // 计算速度变化
  const speeds = [];
  for (let i = 1; i < trajectory.length; i++) {
    const dx = trajectory[i].x - trajectory[i-1].x;
    const dy = trajectory[i].y - trajectory[i-1].y;
    const dt = trajectory[i].t - trajectory[i-1].t;
    speeds.push(Math.sqrt(dx*dx + dy*dy) / dt);
  }
  
  // 人类特征：速度变化不均匀
  const speedVariance = calculateVariance(speeds);
  
  // 人类特征：有微小抖动
  const jitter = calculateJitter(trajectory);
  
  // 人类特征：起点和终点有停顿
  const hasPauses = trajectory[0].duration > 100 || trajectory[trajectory.length-1].duration > 100;
  
  // 综合评分
  const score = 
    (speedVariance > 0.1 ? 0.3 : 0) +
    (jitter > 0.5 ? 0.3 : 0) +
    (hasPauses ? 0.4 : 0);
  
  return score;
}
```

### 4.5 API 接口

```yaml
# 验证触发
POST /api/captcha/trigger
Request:
  userId: integer
  action: string (login|catch|gym|trade|...)
  context: object
Response:
  required: boolean
  sessionId: string (if required)
  challengeType: string (slide|click|calculate)
  difficulty: string (low|medium|high)
  challengeData: object

# 提交验证
POST /api/captcha/verify
Request:
  sessionId: string
  answer: object
  clientData:
    responseTimeMs: integer
    trajectory: array
    deviceFingerprint: string
Response:
  valid: boolean
  message: string
  remainingAttempts: integer
  trustScoreRecovery: integer

# 获取新挑战（当前失败后重新获取）
GET /api/captcha/challenge/:sessionId
Response:
  challengeType: string
  difficulty: string
  challengeData: object

# 验证状态查询
GET /api/captcha/status/:userId
Response:
  lastVerification: timestamp
  totalVerifications: integer
  passRate: number
  currentTrustScore: integer
```

### 4.6 前端组件

```javascript
// game-client/src/components/CaptchaDialog.js

class CaptchaDialog {
  constructor(container, challenge) {
    this.container = container;
    this.challenge = challenge;
    this.startTime = Date.now();
    this.trajectory = [];
  }
  
  render() {
    const html = `
      <div class="captcha-overlay">
        <div class="captcha-dialog">
          <div class="captcha-header">
            <h3>Security Verification</h3>
            <p>Please complete the verification to continue</p>
          </div>
          <div class="captcha-body" id="captcha-content">
            ${this.renderChallenge()}
          </div>
          <div class="captcha-footer">
            <button id="captcha-refresh">Refresh</button>
            <button id="captcha-submit">Verify</button>
          </div>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.bindEvents();
    this.startTracking();
  }
  
  renderChallenge() {
    switch (this.challenge.type) {
      case 'slide':
        return this.renderSlideChallenge();
      case 'click':
        return this.renderClickChallenge();
      case 'calculate':
        return this.renderCalculateChallenge();
    }
  }
  
  renderSlideChallenge() {
    const { grid, pieces, emptySlot } = this.challenge.challengeData;
    const size = 100 / grid;
    
    return `
      <div class="captcha-slide-container" style="width: ${grid * 60}px; height: ${grid * 60}px;">
        ${pieces.map(p => `
          <div class="captcha-piece" 
               data-id="${p.id}" 
               data-correct="${p.correctPosition}"
               style="width: ${size}%; height: ${size}%; 
                      background-position: ${(p.correctPosition % grid) * size}% ${(Math.floor(p.correctPosition / grid)) * size}%;
                      left: ${(p.shufflePosition % grid) * size}%;
                      top: ${Math.floor(p.shufflePosition / grid) * size}%;">
          </div>
        `).join('')}
        <div class="captcha-empty-slot" style="left: ${(emptySlot % grid) * size}%; top: ${Math.floor(emptySlot / grid) * size}%;"></div>
      </div>
      <p>Drag the pieces to complete the puzzle</p>
    `;
  }
  
  renderClickChallenge() {
    const { grid, chars, targetChars, sequence } = this.challenge.challengeData;
    const size = 100 / grid;
    
    return `
      <div class="captcha-click-instruction">
        ${sequence 
          ? `Click in order: <strong>${targetChars.join(' → ')}</strong>`
          : `Click all: <strong>${targetChars.join(', ')}</strong>`
        }
      </div>
      <div class="captcha-click-grid" style="width: ${grid * 50}px;">
        ${chars.map((char, i) => `
          <div class="captcha-char" data-index="${i}" data-char="${char}">
            ${char}
          </div>
        `).join('')}
      </div>
    `;
  }
  
  startTracking() {
    // 追踪鼠标/触摸轨迹
    document.addEventListener('mousemove', this.trackMouse.bind(this));
    document.addEventListener('touchmove', this.trackTouch.bind(this));
  }
  
  trackMouse(e) {
    this.trajectory.push({
      x: e.clientX,
      y: e.clientY,
      t: Date.now() - this.startTime
    });
  }
  
  async submit() {
    const responseTime = Date.now() - this.startTime;
    
    const response = await fetch('/api/captcha/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.challenge.sessionId,
        answer: this.getAnswer(),
        clientData: {
          responseTimeMs: responseTime,
          trajectory: this.trajectory,
          deviceFingerprint: getDeviceFingerprint()
        }
      })
    });
    
    const result = await response.json();
    
    if (result.valid) {
      this.onSuccess(result);
    } else {
      this.onFailure(result);
    }
  }
}
```

### 4.7 Prometheus 指标

```javascript
const captchaMetrics = {
  // 验证触发总数
  triggersTotal: new promClient.Counter({
    name: 'minego_captcha_triggers_total',
    help: 'Total captcha triggers by reason and difficulty',
    labelNames: ['reason', 'difficulty'],
    registers: [register]
  }),
  
  // 验证结果
  resultsTotal: new promClient.Counter({
    name: 'minego_captcha_results_total',
    help: 'Total captcha results by type and status',
    labelNames: ['type', 'status'], // status: passed, failed, expired
    registers: [register]
  }),
  
  // 响应时间
  responseTime: new promClient.Histogram({
    name: 'minego_captcha_response_time_seconds',
    help: 'Captcha response time distribution',
    labelNames: ['type', 'difficulty'],
    buckets: [1, 2, 5, 10, 20, 30, 60],
    registers: [register]
  }),
  
  // 通过率
  passRate: new promClient.Gauge({
    name: 'minego_captcha_pass_rate',
    help: 'Current captcha pass rate',
    registers: [register]
  }),
  
  // 活跃会话数
  activeSessions: new promClient.Gauge({
    name: 'minego_captcha_active_sessions',
    help: 'Current active captcha sessions',
    registers: [register]
  })
};
```

## 5. 验收标准（可测试）

- [ ] **触发机制**
  - 可信度 < 40 触发高风险验证
  - 可信度 40-60 触发中风险验证
  - 可信度 60-80 触发低风险验证
  - 跨区域登录触发验证
  - 异常捕捉触发验证
  - 高风险用户 7 天未验证触发定期验证

- [ ] **验证类型**
  - 滑动验证正常工作（3x3 和 4x4 网格）
  - 图形点选正常工作（按顺序/不按顺序）
  - 数字计算正常工作（加减法）
  - 难度根据风险等级自动调整

- [ ] **答案验证**
  - 正确答案验证通过
  - 错误答案验证失败
  - 超时会话自动过期
  - 最大尝试次数限制生效

- [ ] **反机器人检测**
  - 响应时间 < 最小阈值的验证被标记
  - 轨迹过于平滑的验证被标记
  - 设备指纹不一致的验证被标记

- [ ] **结果处理**
  - 验证通过恢复可信度 +10
  - 验证失败降低可信度 -10
  - 连续 3 次失败账号冻结 24 小时

- [ ] **API 接口**
  - POST /api/captcha/trigger 正常工作
  - POST /api/captcha/verify 正常工作
  - GET /api/captcha/status/:userId 正常工作

- [ ] **前端组件**
  - 滑动验证 UI 正常显示
  - 图形点选 UI 正常显示
  - 计算验证 UI 正常显示
  - 验证结果反馈正确

- [ ] **监控指标**
  - 所有 Prometheus 指标正常上报
  - 验证通过率统计准确
  - 响应时间统计准确

- [ ] **单元测试**
  - 挑战生成测试覆盖所有类型
  - 答案验证测试覆盖所有场景
  - 轨迹分析测试覆盖机器人特征
  - 触发条件测试覆盖所有规则

## 6. 工作量估算

**L（Large）** - 预计 3-4 天

- 后端核心逻辑：1 天（挑战生成、答案验证、轨迹分析）
- 数据库设计与迁移：0.5 天
- API 接口开发：0.5 天
- 前端组件开发：1 天（三种验证类型 UI + 交互）
- 单元测试：0.5 天
- 集成测试与调优：0.5 天

## 7. 优先级理由

**P1 理由**：

1. **补全反作弊闭环**：已有检测能力（GPS、行为、设备），缺少验证处置环节
2. **降低误判影响**：当前 2-5% 误判率影响正常玩家体验，急需降低
3. **应对智能作弊**：统计阈值检测无法应对智能脚本，需要人机验证阻断
4. **用户申诉通道**：缺少"自证清白"机制，影响用户满意度
5. **对"项目可用"贡献大**：完善反作弊体系，提升安全与合规维度评分

**不设 P0 的原因**：
- 已有基础反作弊能力（GPS、行为、设备检测）
- 验证系统是"增强"而非"基础"安全需求
- 可与其他 P1 需求并行开发

## 8. 风险与依赖

### 风险

1. **用户体验影响**：频繁验证可能影响正常玩家 → 设置合理的触发阈值，提供"记住设备"选项
2. **验证破解**：自动化脚本可能绕过简单验证 → 多重验证 + 轨迹分析 + 时间检测
3. **性能影响**：验证逻辑可能增加响应延迟 → 使用 Redis 缓存会话，异步分析轨迹

### 依赖

- REQ-00010：需要 GPS 伪造检测提供的可信度评分
- REQ-00028：需要行为异常检测提供的风险信号
- REQ-00045：需要设备指纹进行设备一致性验证
- Redis：用于验证会话缓存和频率限制

## 9. 后续扩展

本需求完成后，可考虑：

1. **第三方 CAPTCHA 集成**：集成 reCAPTCHA、阿里云滑动验证等商业方案
2. **图像识别验证**：增加"识别图片中的交通信号灯"等高级验证
3. **生物特征验证**：基于滑动行为的生物特征识别
4. **无感验证**：基于用户行为模式的隐形验证（无需显式操作）
