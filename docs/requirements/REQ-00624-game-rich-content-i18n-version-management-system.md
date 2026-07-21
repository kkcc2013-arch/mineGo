# REQ-00624：游戏内富文本内容本地化与版本管理系统

- **编号**：REQ-00624
- **类别**：国际化/本地化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：gateway、user-service、reward-service、backend/shared/i18n、admin-dashboard、database/migrations
- **创建时间**：2026-07-21 12:00
- **依赖需求**：REQ-00294（动态本地化与语言自适应系统）

## 1. 背景与问题

mineGo 项目已实现基础的多语言国际化支持（REQ-00011）和动态本地化系统（REQ-00294），但在游戏内富文本内容的本地化管理方面仍存在以下问题：

### 1.1 富文本内容本地化缺失
- **邮件系统**：系统邮件、奖励通知等富文本内容缺乏多语言支持
- **活动公告**：游戏公告、活动描述等需要人工翻译多个版本，效率低
- **推送通知**：推送消息模板仅支持单一语言，无法根据用户语言偏好发送
- **帮助文档**：游戏内帮助文档、FAQ 等缺乏本地化版本

### 1.2 版本管理混乱
- 翻译内容更新后无法回滚到历史版本
- 缺少翻译内容的审核与发布流程
- 多人协作编辑时缺乏冲突解决机制
- 翻译内容与游戏版本未关联，导致版本不一致

### 1.3 内容一致性差
- 同一术语在不同位置翻译不一致（如 "精灵" vs "Pocket Monster"）
- 缺少术语库和翻译记忆库支持
- 翻译质量依赖人工审核，效率低下

### 1.4 运营效率低
- 每次新增活动都需要手动翻译大量文本
- 缺少批量导入导出工具
- 无法预览不同语言下的显示效果

## 2. 目标

构建游戏内富文本内容本地化管理平台，实现：

1. **统一内容管理**：邮件、公告、推送、帮助文档等富文本内容的集中管理
2. **多语言版本控制**：翻译内容的版本管理、回滚、审核与发布
3. **术语一致性保障**：术语库、翻译记忆库、一致性检查
4. **运营效率提升**：批量操作、预览工具、机器翻译辅助
5. **实时同步**：内容更新后实时推送至客户端，无需重启

**可量化目标：**
- 富文本内容本地化覆盖率从 30% 提升至 95%
- 内容发布效率提升 70%（从 2 天缩短至 4 小时）
- 翻译一致性错误减少 80%
- 支持实时预览与回滚

## 3. 范围

### 包含
- 富文本内容本地化数据库表设计
- 内容版本管理系统（创建、更新、审核、发布、回滚）
- 术语库与翻译记忆库
- 批量导入导出工具（JSON/CSV/XLIFF 格式）
- 管理后台界面：内容编辑、翻译管理、版本控制、预览
- REST API：内容查询、更新、版本操作
- Redis 缓存层：多语言内容缓存
- 客户端 SDK：内容拉取与本地缓存

### 不包含
- 语音内容本地化（后续需求）
- AR 界面文本本地化（后续需求）
- 第三方翻译服务集成（已在 REQ-00294 中实现）
- 玩家社区翻译功能（后续需求）

## 4. 详细需求

### 4.1 数据库表结构设计

#### 4.1.1 富文本内容表

```sql
CREATE TABLE localized_content (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_type    VARCHAR(50) NOT NULL,    -- 'email', 'announcement', 'push', 'help_doc', 'faq'
  content_key     VARCHAR(100) NOT NULL,   -- 业务标识符
  language_code   VARCHAR(10) NOT NULL,    -- 'zh-CN', 'en-US', 'ja-JP'
  title           VARCHAR(255),
  body            TEXT NOT NULL,           -- 支持 Markdown/HTML
  variables       JSONB,                   -- 模板变量定义
  metadata        JSONB,                   -- 扩展元数据
  version         INTEGER NOT NULL DEFAULT 1,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft', -- 'draft', 'pending_review', 'approved', 'published', 'archived'
  created_by      VARCHAR(100),
  updated_by      VARCHAR(100),
  reviewed_by     VARCHAR(100),
  published_by    VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMP,
  published_at    TIMESTAMP,
  expires_at      TIMESTAMP,               -- 过期时间（可选）
  UNIQUE(content_type, content_key, language_code, version)
);

CREATE INDEX idx_content_type_key ON localized_content(content_type, content_key);
CREATE INDEX idx_content_lang ON localized_content(language_code);
CREATE INDEX idx_content_status ON localized_content(status);
CREATE INDEX idx_content_published ON localized_content(status, published_at DESC) WHERE status = 'published';
```

#### 4.1.2 术语库表

```sql
CREATE TABLE terminology_glossary (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  term_key        VARCHAR(100) NOT NULL,
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  source_term     VARCHAR(255) NOT NULL,
  target_term     VARCHAR(255) NOT NULL,
  context         TEXT,                    -- 使用场景说明
  category        VARCHAR(50),             -- 分类（UI、战斗、物品等）
  approved        BOOLEAN DEFAULT false,
  created_by      VARCHAR(100),
  approved_by     VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(term_key, source_language, target_language)
);

CREATE INDEX idx_glossary_langs ON terminology_glossary(source_language, target_language);
CREATE INDEX idx_glossary_term ON terminology_glossary(source_term);
```

#### 4.1.3 翻译记忆库表

```sql
CREATE TABLE translation_memory (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_language VARCHAR(10) NOT NULL,
  target_language VARCHAR(10) NOT NULL,
  source_text     TEXT NOT NULL,
  target_text     TEXT NOT NULL,
  context         TEXT,
  content_type    VARCHAR(50),
  similarity_score DECIMAL(5,2),           -- 与其他翻译的相似度
  usage_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tm_langs ON translation_memory(source_language, target_language);
CREATE INDEX idx_tm_source ON translation_memory(source_text);
CREATE INDEX idx_tm_similarity ON translation_memory(similarity_score DESC);
```

#### 4.1.4 内容版本历史表

```sql
CREATE TABLE content_version_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id      UUID NOT NULL REFERENCES localized_content(id),
  version         INTEGER NOT NULL,
  title           VARCHAR(255),
  body            TEXT NOT NULL,
  change_summary  TEXT,
  changed_by      VARCHAR(100),
  changed_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  restore_point   BOOLEAN DEFAULT false,   -- 是否为可恢复的检查点
  UNIQUE(content_id, version)
);

CREATE INDEX idx_version_content ON content_version_history(content_id);
CREATE INDEX idx_version_time ON content_version_history(content_id, changed_at DESC);
```

### 4.2 REST API 设计

#### 4.2.1 内容管理 API

```javascript
// GET /api/v1/content/:type/:key
// 获取已发布的富文本内容
router.get('/:type/:key', async (req, res) => {
  const { type, key } = req.params;
  const locale = req.locale || 'zh-CN';
  
  const content = await LocalizedContent.findOne({
    where: {
      content_type: type,
      content_key: key,
      language_code: locale,
      status: 'published'
    },
    order: [['published_at', 'DESC']]
  });
  
  if (!content) {
    return res.status(404).json({ error: 'CONTENT_NOT_FOUND' });
  }
  
  // 渲染模板变量
  const rendered = renderTemplate(content.body, req.query);
  
  res.json({
    title: content.title,
    body: rendered,
    metadata: content.metadata
  });
});

// POST /api/v1/content/:type
// 创建新的富文本内容（需要管理员权限）
router.post('/:type', auth.requireAdmin, async (req, res) => {
  const { type } = req.params;
  const { key, language, title, body, variables, metadata } = req.body;
  
  const content = await LocalizedContent.create({
    content_type: type,
    content_key: key,
    language_code: language,
    title,
    body,
    variables,
    metadata,
    status: 'draft',
    created_by: req.user.id
  });
  
  res.status(201).json(content);
});

// PUT /api/v1/content/:id
// 更新内容（创建新版本）
router.put('/:id', auth.requireAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  await sequelize.transaction(async (t) => {
    const current = await LocalizedContent.findByPk(id, { transaction: t });
    
    // 保存历史版本
    await ContentVersionHistory.create({
      content_id: id,
      version: current.version,
      title: current.title,
      body: current.body,
      changed_by: req.user.id,
      change_summary: updates.changeSummary
    }, { transaction: t });
    
    // 更新当前版本
    await current.update({
      ...updates,
      version: current.version + 1,
      updated_by: req.user.id,
      status: 'draft'
    }, { transaction: t });
  });
  
  res.json({ success: true });
});
```

#### 4.2.2 版本控制 API

```javascript
// POST /api/v1/content/:id/publish
// 发布内容
router.post('/:id/publish', auth.requireAdmin, async (req, res) => {
  const { id } = req.params;
  
  const content = await LocalizedContent.findByPk(id);
  
  if (content.status !== 'approved') {
    return res.status(400).json({ error: 'CONTENT_NOT_APPROVED' });
  }
  
  await content.update({
    status: 'published',
    published_by: req.user.id,
    published_at: new Date()
  });
  
  // 清除缓存
  await cacheInvalidation(content);
  
  res.json({ success: true, publishedAt: content.published_at });
});

// POST /api/v1/content/:id/rollback/:version
// 回滚到指定版本
router.post('/:id/rollback/:version', auth.requireAdmin, async (req, res) => {
  const { id, version } = req.params;
  
  const history = await ContentVersionHistory.findOne({
    where: { content_id: id, version: parseInt(version) }
  });
  
  if (!history) {
    return res.status(404).json({ error: 'VERSION_NOT_FOUND' });
  }
  
  await sequelize.transaction(async (t) => {
    const current = await LocalizedContent.findByPk(id, { transaction: t });
    
    // 保存当前版本到历史
    await ContentVersionHistory.create({
      content_id: id,
      version: current.version,
      title: current.title,
      body: current.body,
      changed_by: req.user.id,
      change_summary: `Rollback from version ${current.version} to ${version}`
    }, { transaction: t });
    
    // 恢复历史版本
    await current.update({
      title: history.title,
      body: history.body,
      version: current.version + 1,
      updated_by: req.user.id,
      status: 'draft'
    }, { transaction: t });
  });
  
  res.json({ success: true, rolledBackTo: parseInt(version) });
});
```

#### 4.2.3 术语库 API

```javascript
// GET /api/v1/glossary/search
// 搜索术语翻译
router.get('/search', async (req, res) => {
  const { term, sourceLang, targetLang } = req.query;
  
  const results = await TerminologyGlossary.findAll({
    where: {
      source_language: sourceLang,
      target_language: targetLang,
      source_term: { [Op.iLike]: `%${term}%` },
      approved: true
    }
  });
  
  res.json(results);
});

// POST /api/v1/glossary
// 添加术语（需要审核）
router.post('/', auth.requireTranslator, async (req, res) => {
  const { termKey, sourceLang, targetLang, sourceTerm, targetTerm, context, category } = req.body;
  
  const glossary = await TerminologyGlossary.create({
    term_key: termKey,
    source_language: sourceLang,
    target_language: targetLang,
    source_term: sourceTerm,
    target_term: targetTerm,
    context,
    category,
    approved: false,
    created_by: req.user.id
  });
  
  res.status(201).json(glossary);
});
```

### 4.3 翻译记忆库集成

```javascript
// backend/shared/i18n/translationMemory.js

class TranslationMemory {
  constructor() {
    this.minSimilarity = 0.85; // 85% 相似度阈值
  }
  
  /**
   * 查找相似翻译
   * @param {string} sourceText - 源文本
   * @param {string} sourceLang - 源语言
   * @param {string} targetLang - 目标语言
   * @returns {Promise<Object|null>} - 匹配的翻译
   */
  async findSimilarTranslation(sourceText, sourceLang, targetLang) {
    const cache = await this.getMemoryCache(sourceLang, targetLang);
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const entry of cache) {
      const similarity = this.calculateSimilarity(sourceText, entry.source_text);
      
      if (similarity >= this.minSimilarity && similarity > bestScore) {
        bestScore = similarity;
        bestMatch = entry;
      }
    }
    
    return bestMatch ? { ...bestMatch, similarity: bestScore } : null;
  }
  
  /**
   * 计算文本相似度（Levenshtein 距离）
   */
  calculateSimilarity(text1, text2) {
    const len1 = text1.length;
    const len2 = text2.length;
    
    if (len1 === 0) return len2 === 0 ? 1 : 0;
    if (len2 === 0) return 0;
    
    const matrix = [];
    
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = text1[i - 1] === text2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // 删除
          matrix[i][j - 1] + 1,      // 插入
          matrix[i - 1][j - 1] + cost // 替换
        );
      }
    }
    
    const distance = matrix[len1][len2];
    return 1 - (distance / Math.max(len1, len2));
  }
  
  /**
   * 保存翻译到记忆库
   */
  async saveTranslation(sourceText, targetText, sourceLang, targetLang, contentType) {
    await TranslationMemoryModel.create({
      source_language: sourceLang,
      target_language: targetLang,
      source_text: sourceText,
      target_text: targetText,
      content_type: contentType,
      usage_count: 1
    });
  }
  
  /**
   * 更新使用次数
   */
  async incrementUsage(id) {
    await TranslationMemoryModel.increment('usage_count', { where: { id } });
  }
}
```

### 4.4 管理后台界面

```html
<!-- admin-dashboard/content-editor.html -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>内容编辑器 - mineGo Admin</title>
  <link rel="stylesheet" href="/css/admin.css">
  <script src="/js/ckeditor.js"></script>
</head>
<body>
  <div class="content-editor">
    <div class="sidebar">
      <h3>内容列表</h3>
      <div class="content-tree" id="contentTree">
        <!-- 动态加载内容树 -->
      </div>
      <button class="btn btn-primary" onclick="createNewContent()">+ 新建内容</button>
    </div>
    
    <div class="main-editor">
      <div class="toolbar">
        <select id="languageSelect" onchange="loadLanguageContent()">
          <option value="zh-CN">中文</option>
          <option value="en-US">English</option>
          <option value="ja-JP">日本語</option>
        </select>
        <button class="btn" onclick="saveDraft()">保存草稿</button>
        <button class="btn" onclick="submitForReview()">提交审核</button>
        <button class="btn btn-primary" onclick="publish()">发布</button>
      </div>
      
      <div class="editor-form">
        <input type="text" id="contentTitle" placeholder="标题">
        <textarea id="contentBody"></textarea>
      </div>
      
      <div class="variables-section">
        <h4>模板变量</h4>
        <div id="variablesList"></div>
        <button class="btn btn-sm" onclick="addVariable()">+ 添加变量</button>
      </div>
      
      <div class="version-history">
        <h4>版本历史</h4>
        <table id="versionTable">
          <thead>
            <tr>
              <th>版本</th>
              <th>修改者</th>
              <th>修改时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
    
    <div class="preview-panel">
      <h3>预览</h3>
      <div id="previewContent"></div>
      <button class="btn" onclick="previewInGame()">游戏内预览</button>
    </div>
  </div>
  
  <script>
    // 初始化富文本编辑器
    const editor = CKEDITOR.replace('contentBody', {
      language: 'zh-cn',
      height: 400,
      toolbar: [
        { name: 'basicstyles', items: ['Bold', 'Italic', 'Underline'] },
        { name: 'paragraph', items: ['NumberedList', 'BulletedList'] },
        { name: 'links', items: ['Link', 'Unlink'] },
        { name: 'insert', items: ['Image', 'Table'] },
        { name: 'tools', items: ['Maximize'] }
      ]
    });
    
    // 实时预览
    editor.on('change', function() {
      updatePreview();
    });
    
    function updatePreview() {
      const title = document.getElementById('contentTitle').value;
      const body = editor.getData();
      const preview = document.getElementById('previewContent');
      
      preview.innerHTML = `
        <h2>${title}</h2>
        <div class="content-body">${body}</div>
      `;
    }
    
    async function saveDraft() {
      const content = {
        type: currentContentType,
        key: currentContentKey,
        language: document.getElementById('languageSelect').value,
        title: document.getElementById('contentTitle').value,
        body: editor.getData(),
        variables: getVariables()
      };
      
      const response = await fetch('/api/v1/content/' + currentContentId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...content, changeSummary: '保存草稿' })
      });
      
      if (response.ok) {
        alert('草稿已保存');
        loadVersionHistory();
      }
    }
    
    async function rollbackToVersion(version) {
      if (!confirm(`确定要回滚到版本 ${version} 吗？`)) return;
      
      const response = await fetch(`/api/v1/content/${currentContentId}/rollback/${version}`, {
        method: 'POST'
      });
      
      if (response.ok) {
        alert('已回滚到版本 ' + version);
        loadContent(currentContentId);
      }
    }
  </script>
</body>
</html>
```

### 4.5 批量导入导出

```javascript
// backend/shared/i18n/contentImporter.js

const XLIFF = require('xliff');
const Papa = require('papaparse');

class ContentImporter {
  /**
   * 导出内容为 XLIFF 格式
   * @param {string} sourceLang - 源语言
   * @param {string} targetLang - 目标语言
   * @param {Array<string>} contentTypes - 内容类型列表
   */
  async exportToXLIFF(sourceLang, targetLang, contentTypes) {
    const contents = await LocalizedContent.findAll({
      where: {
        language_code: sourceLang,
        content_type: contentTypes,
        status: 'published'
      }
    });
    
    const xliffData = {
      version: '1.2',
      sourceLanguage: sourceLang,
      targetLanguage: targetLang,
      units: contents.map(c => ({
        id: `${c.content_type}_${c.content_key}`,
        source: c.body,
        target: null, // 待翻译
        note: c.title
      }))
    };
    
    return XLIFF.create(xliffData);
  }
  
  /**
   * 从 XLIFF 导入翻译
   */
  async importFromXLIFF(xliffContent, overwrite = false) {
    const parsed = XLIFF.parse(xliffContent);
    
    for (const unit of parsed.units) {
      const [contentType, contentKey] = unit.id.split('_');
      
      // 检查是否已存在
      const existing = await LocalizedContent.findOne({
        where: {
          content_type: contentType,
          content_key: contentKey,
          language_code: parsed.targetLanguage
        }
      });
      
      if (existing && !overwrite) {
        continue; // 跳过已存在的
      }
      
      if (existing) {
        // 更新现有内容
        await existing.update({
          body: unit.target,
          version: existing.version + 1,
          updated_by: 'import'
        });
      } else {
        // 创建新内容
        await LocalizedContent.create({
          content_type: contentType,
          content_key: contentKey,
          language_code: parsed.targetLanguage,
          body: unit.target,
          status: 'draft',
          created_by: 'import'
        });
      }
    }
    
    return { imported: parsed.units.length };
  }
  
  /**
   * 导出为 CSV 格式
   */
  async exportToCSV(language, contentTypes) {
    const contents = await LocalizedContent.findAll({
      where: {
        language_code: language,
        content_type: contentTypes,
        status: 'published'
      }
    });
    
    const csv = Papa.unparse(contents.map(c => ({
      '内容类型': c.content_type,
      '内容键': c.content_key,
      '标题': c.title,
      '正文': c.body,
      '状态': c.status,
      '版本': c.version
    })));
    
    return csv;
  }
}
```

### 4.6 Redis 缓存层

```javascript
// backend/shared/i18n/contentCache.js

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

class ContentCache {
  constructor() {
    this.prefix = 'content:';
    this.ttl = 3600; // 1 小时
  }
  
  /**
   * 获取缓存的内容
   */
  async get(contentType, contentKey, language) {
    const key = this.buildKey(contentType, contentKey, language);
    const cached = await redis.get(key);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    return null;
  }
  
  /**
   * 设置缓存
   */
  async set(contentType, contentKey, language, content) {
    const key = this.buildKey(contentType, contentKey, language);
    await redis.setex(key, this.ttl, JSON.stringify(content));
  }
  
  /**
   * 清除缓存（内容更新时调用）
   */
  async invalidate(contentType, contentKey) {
    const pattern = this.prefix + `${contentType}:${contentKey}:*`;
    const keys = await redis.keys(pattern);
    
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
  
  /**
   * 批量预热缓存
   */
  async warmup(contentType, language) {
    const contents = await LocalizedContent.findAll({
      where: {
        content_type: contentType,
        language_code: language,
        status: 'published'
      }
    });
    
    for (const content of contents) {
      await this.set(contentType, content.content_key, language, content);
    }
    
    return { warmed: contents.length };
  }
  
  buildKey(type, key, lang) {
    return `${this.prefix}${type}:${key}:${lang}`;
  }
}
```

### 4.7 客户端 SDK

```javascript
// frontend/game-client/src/i18n/contentClient.js

class ContentClient {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 30 * 60 * 1000; // 30 分钟
  }
  
  /**
   * 获取内容
   * @param {string} type - 内容类型
   * @param {string} key - 内容键
   * @param {Object} variables - 模板变量
   */
  async get(type, key, variables = {}) {
    const locale = getCurrentLocale();
    const cacheKey = `${type}:${key}:${locale}`;
    
    // 检查本地缓存
    const cached = this.getFromLocalCache(cacheKey);
    if (cached) {
      return this.renderTemplate(cached, variables);
    }
    
    // 从服务器获取
    try {
      const response = await fetch(`/api/v1/content/${type}/${key}`, {
        headers: { 'Accept-Language': locale }
      });
      
      if (!response.ok) {
        return this.getFallback(type, key);
      }
      
      const content = await response.json();
      
      // 保存到本地缓存
      this.setLocalCache(cacheKey, content);
      
      return this.renderTemplate(content, variables);
    } catch (error) {
      console.error('Content fetch error:', error);
      return this.getFallback(type, key);
    }
  }
  
  /**
   * 渲染模板
   */
  renderTemplate(content, variables) {
    let body = content.body;
    
    for (const [key, value] of Object.entries(variables)) {
      body = body.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    
    return {
      title: content.title,
      body: body
    };
  }
  
  /**
   * 本地缓存管理
   */
  getFromLocalCache(key) {
    const cached = this.cache.get(key);
    
    if (!cached) return null;
    
    if (Date.now() > cached.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  setLocalCache(key, data) {
    this.cache.set(key, {
      data,
      expiry: Date.now() + this.cacheExpiry
    });
  }
  
  /**
   * 预加载内容
   */
  async preload(contentList) {
    const promises = contentList.map(({ type, key }) => 
      this.get(type, key).catch(() => null)
    );
    
    await Promise.all(promises);
  }
}

// 使用示例
const contentClient = new ContentClient();

// 获取系统邮件
const email = await contentClient.get('email', 'welcome_bonus', {
  username: '玩家名称',
  reward: '100 精币'
});

console.log(email.title); // 欢迎奖励
console.log(email.body);  // 尊敬的玩家名称，恭喜您获得 100 精币！
```

### 4.8 一致性检查工具

```javascript
// backend/scripts/checkTranslationConsistency.js

const TerminologyGlossary = require('../models/terminologyGlossary');
const LocalizedContent = require('../models/localizedContent');

class TranslationConsistencyChecker {
  /**
   * 检查内容中的术语一致性
   */
  async checkContent(contentId) {
    const content = await LocalizedContent.findByPk(contentId);
    
    if (!content) {
      throw new Error('Content not found');
    }
    
    const issues = [];
    
    // 获取术语库
    const glossary = await TerminologyGlossary.findAll({
      where: {
        source_language: 'zh-CN',
        target_language: content.language_code,
        approved: true
      }
    });
    
    // 检查每个术语
    for (const term of glossary) {
      if (content.body.includes(term.source_term)) {
        if (!content.body.includes(term.target_term)) {
          issues.push({
            type: 'term_inconsistent',
            sourceTerm: term.source_term,
            expectedTarget: term.target_term,
            message: `术语 "${term.source_term}" 的翻译不一致，建议使用 "${term.target_term}"`
          });
        }
      }
    }
    
    // 检查变量占位符
    const variablePattern = /{{(\w+)}}/g;
    const sourceVariables = content.variables || {};
    const foundVariables = [];
    
    let match;
    while ((match = variablePattern.exec(content.body)) !== null) {
      foundVariables.push(match[1]);
    }
    
    for (const variable of foundVariables) {
      if (!sourceVariables[variable]) {
        issues.push({
          type: 'undefined_variable',
          variable: variable,
          message: `变量 {{${variable}}} 未定义`
        });
      }
    }
    
    return {
      contentId,
      language: content.language_code,
      issues,
      passed: issues.length === 0
    };
  }
  
  /**
   * 批量检查所有内容
   */
  async checkAll() {
    const contents = await LocalizedContent.findAll({
      where: { status: 'published' }
    });
    
    const results = [];
    
    for (const content of contents) {
      const result = await this.checkContent(content.id);
      results.push(result);
    }
    
    const summary = {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      issuesByType: {}
    };
    
    for (const result of results) {
      for (const issue of result.issues) {
        summary.issuesByType[issue.type] = (summary.issuesByType[issue.type] || 0) + 1;
      }
    }
    
    return summary;
  }
}

module.exports = TranslationConsistencyChecker;
```

## 5. 验收标准（可测试）

- [ ] 数据库表创建成功，支持富文本内容的多语言存储
- [ ] REST API 实现完成，支持内容的 CRUD、版本控制、发布/回滚
- [ ] 术语库和翻译记忆库功能正常，术语一致性检查工具可用
- [ ] 管理后台界面完成，支持富文本编辑、多语言切换、版本历史查看
- [ ] 批量导入导出功能正常，支持 XLIFF、CSV、JSON 格式
- [ ] Redis 缓存层实现，内容查询延迟 < 50ms（P95）
- [ ] 客户端 SDK 完成并集成到游戏客户端
- [ ] 单元测试覆盖率 ≥ 80%，集成测试覆盖核心流程
- [ ] 已发布内容的回滚功能正常，可恢复到任意历史版本
- [ ] 翻译一致性检查工具可用，能检测出不一致的术语翻译

## 6. 工作量估算

**L（Large）**

- 数据库设计与迁移：2 天
- REST API 开发：3 天
- 管理后台界面：4 天
- 客户端 SDK：2 天
- 缓存层与性能优化：2 天
- 测试与文档：2 天
- 总计：约 15 个工作日

## 7. 优先级理由

**P2（中等优先级）**

1. **支持全球化运营**：富文本内容本地化是全球化运营的基础设施，影响邮件、公告、推送等核心功能
2. **提升运营效率**：版本管理和批量工具可显著提升内容发布效率（预计提升 70%）
3. **保障翻译质量**：术语库和一致性检查可减少翻译错误，提升用户体验
4. **技术债务**：当前邮件、公告等系统缺少本地化支持，属于功能性缺失
5. **非阻塞性**：基础国际化已实现（REQ-00294），本需求为增强功能，不影响核心业务流程

**对"项目可用"的贡献：**
- 完善国际化支持，提升全球用户体验
- 优化运营流程，降低内容管理成本
- 建立规范化流程，支持团队协作

## 8. 相关需求

- REQ-00011：游戏客户端多语言国际化支持（基础）
- REQ-00294：动态本地化与语言自适应系统（前置需求）
- REQ-00268：游戏内容数据库多语言支持（相关）
- REQ-00101：后端 API 错误消息国际化（相关）
