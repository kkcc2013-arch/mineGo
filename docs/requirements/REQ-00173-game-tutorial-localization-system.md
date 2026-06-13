# REQ-00173: 游戏教程本地化与动态提示系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00173 |
| 标题 | 游戏教程本地化与动态提示系统 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、user-service、pokemon-service、backend/shared、database/migrations |
| 创建时间 | 2026-06-13 23:05 UTC |
| 依赖需求 | REQ-00011 (多语言支持), REQ-00167 (游戏内容本地化数据层) |

## 1. 背景与问题

### 现状
当前项目已实现基础的 i18n 支持：
- `backend/shared/i18n.js` 提供错误消息翻译（中/英/日三语）
- `frontend/game-client/src/i18n/` 目录存在
- 用户语言偏好存储在数据库中

### 问题
1. **教程内容未本地化**：新手引导、游戏提示仅有中文版本，国际用户体验差
2. **动态提示缺失**：无法根据用户语言动态显示游戏内提示（如精灵捕捉技巧、道馆攻略）
3. **教程内容硬编码**：教程文案散落在代码中，难以维护和扩展
4. **缺少多语言内容管理**：无法通过后台动态更新多语言内容

### 影响
- 非中文用户上手困难，流失率高
- 教程内容更新需要修改代码并重新部署
- 无法根据用户区域推送个性化提示

## 2. 目标

建立完整的游戏教程本地化系统：
1. 教程内容支持多语言版本（中/英/日）
2. 动态提示根据用户语言自动切换
3. 教程内容可配置、可热更新
4. 后台管理界面支持多语言内容编辑

## 3. 范围

### 包含
- 教程内容数据库表设计（多语言教程步骤）
- 教程服务 API（获取、进度跟踪）
- 前端教程组件本地化渲染
- 动态提示系统（游戏内 Hint 根据 context 显示）
- 教程进度同步（跨设备）

### 不包含
- 翻译工作流管理（已在 REQ-00137 实现）
- 语音教程支持
- 视频教程托管

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 教程配置表
CREATE TABLE tutorials (
  id SERIAL PRIMARY KEY,
  tutorial_key VARCHAR(100) NOT NULL UNIQUE,
  category VARCHAR(50) NOT NULL, -- 'beginner', 'advanced', 'feature'
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 教程步骤表（多语言）
CREATE TABLE tutorial_steps (
  id SERIAL PRIMARY KEY,
  tutorial_id INTEGER REFERENCES tutorials(id),
  step_number INTEGER NOT NULL,
  title JSONB NOT NULL, -- {"zh-CN": "...", "en-US": "...", "ja-JP": "..."}
  content JSONB NOT NULL,
  highlight_element VARCHAR(200), -- UI 元素选择器
  action_type VARCHAR(50), -- 'tap', 'swipe', 'wait'
  action_target VARCHAR(200),
  delay_ms INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tutorial_id, step_number)
);

-- 用户教程进度表
CREATE TABLE user_tutorial_progress (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  tutorial_id INTEGER REFERENCES tutorials(id),
  current_step INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMP,
  skipped BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, tutorial_id)
);

-- 动态提示表
CREATE TABLE dynamic_hints (
  id SERIAL PRIMARY KEY,
  hint_key VARCHAR(100) NOT NULL UNIQUE,
  context VARCHAR(100) NOT NULL, -- 'catch', 'gym', 'map', 'bag'
  trigger_condition JSONB, -- {"level_min": 5, "pokemon_count_max": 10}
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 提示内容表（多语言）
CREATE TABLE hint_contents (
  id SERIAL PRIMARY KEY,
  hint_id INTEGER REFERENCES dynamic_hints(id),
  language VARCHAR(10) NOT NULL,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  cta_text VARCHAR(100), -- 行动按钮文字
  cta_action VARCHAR(200), -- 点击后动作
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(hint_id, language)
);

-- 索引
CREATE INDEX idx_tutorial_category ON tutorials(category, is_active);
CREATE INDEX idx_tutorial_steps ON tutorial_steps(tutorial_id, step_number);
CREATE INDEX idx_user_tutorial ON user_tutorial_progress(user_id);
CREATE INDEX idx_hints_context ON dynamic_hints(context, is_active);
CREATE INDEX idx_hint_contents ON hint_contents(hint_id, language);
```

### 4.2 教程服务 API

```javascript
// backend/services/user-service/src/routes/tutorial.js

/**
 * GET /tutorials
 * 获取用户可用的教程列表
 */
router.get('/tutorials', auth.requireAuth, async (req, res) => {
  const lang = req.language;
  const userLevel = req.user.level;
  
  const tutorials = await db('tutorials')
    .where({ is_active: true })
    .whereRaw('(min_level IS NULL OR min_level <= ?)', [userLevel])
    .orderBy('sort_order');
    
  const progress = await db('user_tutorial_progress')
    .where({ user_id: req.user.id });
    
  res.json({
    tutorials: tutorials.map(t => ({
      id: t.id,
      key: t.tutorial_key,
      category: t.category,
      progress: progress.find(p => p.tutorial_id === t.id)?.current_step || 0,
      completed: progress.find(p => p.tutorial_id === t.id)?.completed || false
    }))
  });
});

/**
 * GET /tutorials/:key/steps
 * 获取教程步骤（已本地化）
 */
router.get('/tutorials/:key/steps', auth.requireAuth, async (req, res) => {
  const lang = req.language;
  const tutorial = await db('tutorials')
    .where({ tutorial_key: req.params.key })
    .first();
    
  if (!tutorial) {
    return res.status(404).json({ error: 'Tutorial not found' });
  }
  
  const steps = await db('tutorial_steps')
    .where({ tutorial_id: tutorial.id })
    .orderBy('step_number');
    
  res.json({
    tutorial: tutorial.tutorial_key,
    steps: steps.map(s => ({
      step: s.step_number,
      title: s.title[lang] || s.title['en-US'],
      content: s.content[lang] || s.content['en-US'],
      highlight: s.highlight_element,
      action: s.action_type,
      target: s.action_target,
      delay: s.delay_ms
    }))
  });
});

/**
 * POST /tutorials/:key/progress
 * 更新教程进度
 */
router.post('/tutorials/:key/progress', auth.requireAuth, async (req, res) => {
  const { step, completed } = req.body;
  
  const tutorial = await db('tutorials')
    .where({ tutorial_key: req.params.key })
    .first();
    
  await db('user_tutorial_progress')
    .insert({
      user_id: req.user.id,
      tutorial_id: tutorial.id,
      current_step: step,
      completed: completed || false,
      completed_at: completed ? new Date() : null
    })
    .onConflict(['user_id', 'tutorial_id'])
    .merge();
    
  res.json({ success: true, step, completed });
});

/**
 * GET /hints/:context
 * 获取当前上下文的动态提示
 */
router.get('/hints/:context', auth.requireAuth, async (req, res) => {
  const lang = req.language;
  const context = req.params.context;
  
  const hints = await db('dynamic_hints')
    .where({ context, is_active: true })
    .join('hint_contents', 'dynamic_hints.id', 'hint_contents.hint_id')
    .where('hint_contents.language', lang)
    .select('dynamic_hints.*', 'hint_contents.*')
    .orderBy('priority');
    
  // 过滤符合触发条件的提示
  const userStats = await getUserStats(req.user.id);
  const applicableHints = hints.filter(h => 
    matchesCondition(h.trigger_condition, userStats)
  );
  
  res.json({
    hints: applicableHints.map(h => ({
      key: h.hint_key,
      title: h.title,
      content: h.content,
      cta: h.cta_text,
      action: h.cta_action
    }))
  });
});
```

### 4.3 前端教程管理器

```javascript
// frontend/game-client/src/tutorial/TutorialManager.js

class TutorialManager {
  constructor(apiClient, i18n) {
    this.api = apiClient;
    this.i18n = i18n;
    this.activeTutorial = null;
    this.currentStep = 0;
    this.steps = [];
    this.overlay = null;
  }

  async startTutorial(tutorialKey) {
    const response = await this.api.get(`/tutorials/${tutorialKey}/steps`);
    this.steps = response.steps;
    this.currentStep = 0;
    this.activeTutorial = tutorialKey;
    
    this.showStep(0);
  }

  showStep(stepIndex) {
    const step = this.steps[stepIndex];
    if (!step) {
      this.completeTutorial();
      return;
    }

    // 创建或更新覆盖层
    this.renderOverlay(step);
    
    // 高亮目标元素
    if (step.highlight) {
      this.highlightElement(step.highlight);
    }
    
    // 延迟后自动进入下一步
    if (step.delay > 0 && step.action === 'wait') {
      setTimeout(() => this.nextStep(), step.delay);
    }
  }

  renderOverlay(step) {
    // 使用当前语言渲染内容
    const content = this.i18n.t(step.content);
    
    this.overlay = document.createElement('div');
    this.overlay.className = 'tutorial-overlay';
    this.overlay.innerHTML = `
      <div class="tutorial-tooltip">
        <div class="tutorial-title">${this.i18n.t(step.title)}</div>
        <div class="tutorial-content">${content}</div>
        <div class="tutorial-actions">
          <button class="btn-skip">${this.i18n.t('tutorial.skip')}</button>
          <button class="btn-next">${this.i18n.t('tutorial.next')}</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.overlay);
  }

  async nextStep() {
    this.currentStep++;
    
    // 保存进度
    await this.api.post(`/tutorials/${this.activeTutorial}/progress`, {
      step: this.currentStep
    });
    
    this.hideOverlay();
    this.showStep(this.currentStep);
  }

  async skipTutorial() {
    await this.api.post(`/tutorials/${this.activeTutorial}/progress`, {
      step: this.steps.length,
      completed: false,
      skipped: true
    });
    
    this.hideOverlay();
    this.activeTutorial = null;
  }

  async completeTutorial() {
    await this.api.post(`/tutorials/${this.activeTutorial}/progress`, {
      step: this.steps.length,
      completed: true
    });
    
    this.hideOverlay();
    this.activeTutorial = null;
    
    // 触发完成事件
    window.dispatchEvent(new CustomEvent('tutorial:complete', {
      detail: { tutorialKey: this.activeTutorial }
    }));
  }
}
```

### 4.4 初始教程数据

```sql
-- 插入新手教程
INSERT INTO tutorials (tutorial_key, category, sort_order) VALUES
('welcome', 'beginner', 1),
('catch-basics', 'beginner', 2),
('map-navigation', 'beginner', 3),
('pokestop-usage', 'beginner', 4),
('gym-intro', 'beginner', 5);

-- 插入教程步骤（示例：欢迎教程）
INSERT INTO tutorial_steps (tutorial_id, step_number, title, content, highlight_element, action_type) VALUES
(1, 1, 
  '{"zh-CN": "欢迎来到精灵世界", "en-US": "Welcome to the Pokémon World", "ja-JP": "ポケモンの世界へようこそ"}',
  '{"zh-CN": "在这里，你将开始一段精彩的冒险旅程。点击继续开始你的探索！", "en-US": "Your exciting adventure begins here. Tap continue to start exploring!", "ja-JP": "ここから素晴らしい冒険が始まります。続行をタップして探索を始めましょう！"}',
  null, 'tap'),
(1, 2,
  '{"zh-CN": "这是你的角色", "en-US": "This is your avatar", "ja-JP": "これがあなたのアバターです"}',
  '{"zh-CN": "点击可以自定义你的外观，包括发型、服装和配饰。", "en-US": "Tap to customize your look, including hairstyle, outfit, and accessories.", "ja-JP": "タップして髪型、服装、アクセサリーをカスタマイズできます。"}',
  '.avatar-icon', 'tap'),
(1, 3,
  '{"zh-CN": "开始探索吧！", "en-US": "Start Exploring!", "ja-JP": "探索を始めよう！"}',
  '{"zh-CN": "四处走动，发现野生精灵。祝你狩猎愉快！", "en-US": "Walk around to discover wild Pokémon. Happy hunting!", "ja-JP": "歩き回って野生のポケモンを見つけましょう。良い狩りを！"}',
  null, 'tap');

-- 插入动态提示
INSERT INTO dynamic_hints (hint_key, context, trigger_condition, priority) VALUES
('first-pokemon', 'map', '{"pokemon_count": 0}', 100),
('low-pokeballs', 'catch', '{"pokeball_count_max": 5}', 80),
('gym-available', 'map', '{"level_min": 5, "gym_nearby": true}', 70);

-- 插入提示内容
INSERT INTO hint_contents (hint_id, language, title, content, cta_text, cta_action) VALUES
(1, 'zh-CN', '捕捉你的第一只精灵', '点击地图上的精灵开始捕捉，使用精灵球投掷命中即可收服！', '开始捕捉', 'navigate:catch'),
(1, 'en-US', 'Catch Your First Pokémon', 'Tap a Pokémon on the map to start catching. Throw a Pokéball to capture it!', 'Start Catching', 'navigate:catch'),
(1, 'ja-JP', '最初のポケモンを捕まえよう', 'マップのポケモンをタップして捕獲を開始。モンスターボールを投げて捕まえよう！', '捕獲開始', 'navigate:catch'),
(2, 'zh-CN', '精灵球不足', '你的精灵球快用完了，去附近的补给站补充吧！', '前往补给站', 'navigate:nearest-pokestop'),
(2, 'en-US', 'Low on Pokéballs', 'You are running low on Pokéballs. Visit a nearby Pokéstop to restock!', 'Find Pokéstop', 'navigate:nearest-pokestop'),
(2, 'ja-JP', 'モンスターボール不足', 'モンスターボールが少なくなっています。近くのポケストップで補充しましょう！', 'ポケストップへ', 'navigate:nearest-pokestop');
```

## 5. 验收标准

- [ ] 数据库迁移成功，包含所有教程相关表
- [ ] API 接口支持多语言内容返回
- [ ] 前端能根据用户语言显示对应的教程内容
- [ ] 教程进度正确保存和恢复（跨设备同步）
- [ ] 动态提示根据上下文和用户状态正确触发
- [ ] 支持中/英/日三语言教程内容
- [ ] 管理后台可编辑多语言教程内容
- [ ] 单元测试覆盖教程服务和提示逻辑
- [ ] 性能：教程步骤加载时间 < 200ms

## 6. 工作量估算

**M (Medium)**
- 数据库设计和迁移：2小时
- 后端 API 开发：3小时
- 前端 TutorialManager 组件：3小时
- 初始教程内容填充：2小时
- 测试和调试：2小时
- 总计：约 12 小时

## 7. 优先级理由

**P1 - 高优先级**

1. **用户体验关键**：新手引导直接影响用户留存率，尤其是国际用户
2. **基础功能完善**：项目已有 i18n 基础，教程本地化是国际化战略的关键一环
3. **依赖已有实现**：REQ-00011 和 REQ-00167 已完成，具备实现条件
4. **影响范围适中**：不涉及核心业务逻辑修改，风险可控
