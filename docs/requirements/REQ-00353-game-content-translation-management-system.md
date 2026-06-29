# REQ-00353：游戏内容翻译管理与翻译工作流自动化系统

- **编号**：REQ-00353
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、pokemon-service、backend/shared/i18n、admin-dashboard、backend/jobs、database/migrations
- **创建时间**：2026-06-29 02:00 UTC
- **依赖需求**：REQ-00294（动态本地化系统）

## 1. 背景与问题

当前 mineGo 项目已实现基础的国际化框架（REQ-00294），支持界面文本的多语言翻译。然而，游戏核心内容（精灵名称、精灵描述、技能名称、技能描述、道具名称、道具描述等）的翻译管理存在以下问题：

1. **翻译工作流缺失**：新增精灵或技能时，翻译人员需要手动在多个 JSON 文件中添加条目，缺乏自动化工具支持
2. **翻译状态追踪困难**：无法追踪哪些内容已翻译、哪些待翻译、哪些翻译质量需要审核
3. **翻译版本控制不完善**：翻译内容更新时缺乏版本追踪和回滚机制
4. **批量翻译效率低**：当新增大量内容时，翻译人员需要逐条处理，缺乏批量翻译工具
5. **翻译质量反馈机制缺失**：玩家无法对翻译质量进行反馈，翻译人员无法收集改进意见

现有代码中，`frontend/game-client/src/i18n/index.js` 仅处理界面文本翻译，`backend/gateway/src/routes/i18n.js` 提供基础的翻译 API，但缺乏针对游戏内容的专业翻译管理功能。

## 2. 目标

建立一套完整的游戏内容翻译管理系统，实现：

1. 翻译工作流自动化：新增游戏内容时自动生成待翻译任务
2. 翻译状态可视化管理：管理员可查看翻译进度、待处理条目
3. 批量翻译工具集成：支持 AI 机器翻译预填充 + 人工审核修正
4. 翻译版本追踪：支持翻译内容的历史版本查看和回滚
5. 翻译质量反馈：玩家可对翻译内容评分反馈，支持改进建议

## 3. 范围

- **包含**：
  - 翻译任务管理服务（TranslationTaskService）
  - 翻译工作流自动化 Job（TranslationWorkflowJob）
  - 管理后台翻译管理界面（admin-dashboard/translations）
  - 翻译状态追踪数据表（translation_tasks、translation_history）
  - 批量翻译 API 与机器翻译预填充功能
  - 翻译版本控制与回滚机制
  - 翻译质量反馈收集接口

- **不包含**：
  - 界面文本翻译（已在 REQ-00294 实现）
  - 多语言 SEO 优化
  - 翻译服务商深度集成（仅使用现有机器翻译接口）

## 4. 详细需求

### 4.1 翻译任务管理服务

创建 `backend/shared/i18n/translationTaskService.js`：

```javascript
// 核心功能
class TranslationTaskService {
  // 自动检测新增游戏内容，创建翻译任务
  async createTranslationTasks(contentType, contentIds) {}
  
  // 获取待翻译任务列表（按优先级、内容类型筛选）
  async getPendingTasks(filters) {}
  
  // 批量创建翻译任务
  async batchCreateTasks(sourceLocale, targetLocales, contentType) {}
  
  // 更新翻译任务状态（pending → in_progress → completed → approved）
  async updateTaskStatus(taskId, status, translatorId) {}
  
  // 获取翻译任务详情
  async getTaskDetail(taskId) {}
  
  // 提交翻译内容
  async submitTranslation(taskId, locale, content) {}
  
  // 审核翻译内容
  async approveTranslation(taskId, reviewerId) {}
}
```

### 4.2 翻译工作流自动化 Job

创建 `backend/jobs/translationWorkflowJob.js`：

```javascript
// 定时任务（每小时执行）
// 1. 检测新增精灵/技能/道具，自动创建翻译任务
// 2. 检测过期翻译任务，发送提醒通知
// 3. 统计翻译进度，生成报告
class TranslationWorkflowJob {
  async run() {
    await this.detectNewContent();
    await this.checkExpiredTasks();
    await this.generateProgressReport();
  }
}
```

### 4.3 数据库表设计

```sql
-- translation_tasks 翻译任务表
CREATE TABLE translation_tasks (
  id SERIAL PRIMARY KEY,
  content_type VARCHAR(50) NOT NULL,  -- 'pokemon', 'skill', 'item', 'quest'
  content_id VARCHAR(50) NOT NULL,
  source_locale VARCHAR(10) NOT NULL,
  target_locale VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, approved
  source_text TEXT NOT NULL,
  translated_text TEXT,
  machine_translation TEXT,  -- AI 机器翻译预填充
  priority INTEGER DEFAULT 1,
  translator_id VARCHAR(50),
  reviewer_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  approved_at TIMESTAMP
);

-- translation_history 翻译历史版本表
CREATE TABLE translation_history (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES translation_tasks(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  translator_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  is_current BOOLEAN DEFAULT FALSE
);

-- translation_feedback 翻译质量反馈表
CREATE TABLE translation_feedback (
  id SERIAL PRIMARY KEY,
  task_id INTEGER REFERENCES translation_tasks(id),
  user_id VARCHAR(50) NOT NULL,
  rating INTEGER NOT NULL,  -- 1-5
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4.4 管理后台翻译界面

在 `admin-dashboard` 中新增翻译管理模块：

- `/admin/translations` - 翻译任务列表（支持筛选、搜索）
- `/admin/translations/new` - 新建翻译任务
- `/admin/translations/:id` - 翻译详情编辑
- `/admin/translations/batch` - 批量翻译界面
- `/admin/translations/report` - 翻译进度报告

### 4.5 API 接口设计

```yaml
# 翻译任务 API
POST /api/v1/translations/tasks         # 创建翻译任务
GET  /api/v1/translations/tasks         # 获取任务列表
GET  /api/v1/translations/tasks/:id     # 获取任务详情
PUT  /api/v1/translations/tasks/:id     # 更新任务（提交翻译）
POST /api/v1/translations/tasks/:id/approve  # 审核通过
POST /api/v1/translations/batch         # 批量创建任务
POST /api/v1/translations/batch/translate   # 批量机器翻译预填充
GET  /api/v1/translations/report        # 翻译进度报告

# 翻译反馈 API
POST /api/v1/translations/feedback      # 提交翻译反馈
GET  /api/v1/translations/feedback/stats  # 获取反馈统计

# 翻译历史 API
GET  /api/v1/translations/tasks/:id/history  # 获取翻译历史版本
POST /api/v1/translations/tasks/:id/rollback # 回滚到指定版本
```

### 4.6 翻译内容同步机制

当翻译任务完成并审核通过后，自动更新对应的翻译文件：

```javascript
// 同步精灵名称翻译到 locale 文件
async syncToLocaleFiles(locale) {
  // 更新 /i18n/locales/pokemon/{locale}.json
  // 更新 /i18n/locales/skills/{locale}.json
  // 更新 /i18n/locales/items/{locale}.json
}
```

## 5. 验收标准（可测试）

- [ ] 新增精灵时，系统自动创建 zh-CN、en-US、ja-JP 三语言翻译任务
- [ ] 管理员可通过 admin-dashboard 查看待翻译任务列表，支持按内容类型、目标语言筛选
- [ ] 批量翻译界面支持一键生成机器翻译预填充，翻译人员可修正后提交
- [ ] 翻译提交后状态从 pending → in_progress → completed → approved 自动流转
- [ ] 翻译审核通过后，内容自动同步到对应 locale 文件
- [ ] 翻译历史版本可查看，支持回滚到任意历史版本
- [ ] 玩家可通过游戏内反馈按钮对翻译内容评分（1-5星）
- [ ] 翻译进度报告按日/周/月统计，展示完成率、待处理数量
- [ ] API 接口返回数据格式符合 OpenAPI 规范
- [ ] 单元测试覆盖率达到 80%+

## 6. 工作量估算

**L（大型）**
- 涉及数据库表设计、后端服务实现、管理后台界面开发
- 需要与现有国际化系统（REQ-00294）集成
- 批量翻译和版本控制逻辑复杂
- 预计开发时间：3-4 天

## 7. 优先级理由

P1 级别：
- 国际化是游戏全球化运营的基础，翻译管理系统直接影响海外用户体验
- 当前翻译工作流缺失导致翻译效率低，影响新内容上线速度
- 与 REQ-00294（动态本地化系统）配套，完善国际化基础设施
- 属于国际化类别的关键功能缺口