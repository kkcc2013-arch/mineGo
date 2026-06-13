# REQ-00155: OpenAPI 文档多语言描述与国际化支持

- **编号**：REQ-00155
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、docs/api-spec/openapi、backend/shared/openapiI18n.js、backend/scripts/merge-openapi.js
- **创建时间**：2026-06-13 08:00
- **依赖需求**：REQ-00011（多语言国际化支持）、REQ-00101（后端 API 错误消息国际化）

## 1. 背景与问题

### 现状分析
mineGo 项目已实现多语言国际化能力：
- 前端游戏客户端支持中/英/日三语言（REQ-00011）
- 后端错误消息国际化中间件（backend/shared/i18n.js）
- 用户时区本地化支持（REQ-00029）
- 翻译管理系统已规划（REQ-00137）

然而，**OpenAPI 文档缺少多语言描述支持**：

1. **API 文档只有中文描述**：base.yaml 中所有 description、summary 字段都是中文
   - 国际开发者无法理解 API 用途
   - Swagger UI 显示的文档对非中文用户不友好
2. **错误码说明未国际化**：错误码范围说明、错误消息示例都是中文
3. **参数说明缺少多语言**：query/path/header 参数的 description 只有中文
4. **响应示例语言单一**：Success/Error 示例的 message 字段只有中文

### 影响范围
- 国际开发者接入成本高，需要自行翻译理解 API
- 与前端多语言体验不一致（前端已支持三语言，文档却只有中文）
- 不符合国际化产品的文档标准

## 2. 目标

构建 OpenAPI 文档多语言支持系统：
1. **多语言描述文件**：为每个 OpenAPI 节点提供中/英/日三语言描述
2. **语言切换机制**：Swagger UI 支持语言切换，动态加载对应语言文档
3. **错误码国际化**：错误码说明、示例消息支持多语言
4. **自动化工具**：翻译键提取、缺失检测、批量导入工具
5. **CI 集成**：自动验证所有 OpenAPI 节点都有三语言描述

## 3. 范围

- **包含**：
  - OpenAPI 多语言描述文件结构设计
  - 语言切换 API 端点
  - Swagger UI 语言切换集成
  - 翻译键提取与验证工具
  - 错误码描述国际化
  - CI 检查规则

- **不包含**：
  - 前端游戏客户端国际化（REQ-00011 已实现）
  - 后端错误消息翻译（REQ-00101 已规划）
  - 翻译管理后台（REQ-00137 已规划）

## 4. 详细需求

### 4.1 多语言描述文件结构

```yaml
# docs/api-spec/openapi/translations/zh-CN.yaml
openapi: "3.0.3"
info:
  title: "mineGo API"
  description: |
    基于 GPS 的 AR 精灵捕捉手游 API
    
    ## 认证方式
    
    大部分接口需要 JWT 认证，在请求头中添加：
    ```
    Authorization: Bearer {accessToken}
    ```
    
    ## 错误处理
    
    所有错误使用统一格式：
    ```json
    {
      "code": 2001,
      "message": "该手机号已注册",
      "data": null,
      "traceId": "abc-123"
    }
    ```
    
    ## 错误码范围
    
    - 1000-1999: 通用错误
    - 2000-2999: 用户相关
    - 3000-3999: 精灵/捕捉
    - 4000-4999: 道馆/社交
    - 5000-5999: 支付
    - 9000-9999: 系统错误

tags:
  - name: Auth
    description: "认证相关（注册、登录、Token 刷新）"
  - name: Users
    description: "用户管理（资料、队伍、货币）"
  - name: Map
    description: "地图与位置（GPS、精灵刷新）"
  - name: Catch
    description: "精灵捕捉（投球、结算）"
  - name: Pokemon
    description: "精灵管理（仓库、图鉴、进化）"
  - name: Gym
    description: "道馆系统（占领、战斗、Raid）"
  - name: Social
    description: "社交系统（好友、礼物、交换）"
  - name: Reward
    description: "任务奖励（签到、成就、排行榜）"
  - name: Payment
    description: "支付系统（订单、充值）"

paths:
  /auth/register:
    post:
      summary: "用户注册"
      description: "使用手机号和密码注册新用户账号"
      requestBody:
        description: "注册信息"
      responses:
        "201":
          description: "注册成功"
        "400":
          description: "请求参数无效"
        "409":
          description: "该手机号已注册"
```

```yaml
# docs/api-spec/openapi/translations/en-US.yaml
openapi: "3.0.3"
info:
  title: "mineGo API"
  description: |
    GPS-based AR Pokémon catching game API
    
    ## Authentication
    
    Most endpoints require JWT authentication. Add the header:
    ```
    Authorization: Bearer {accessToken}
    ```
    
    ## Error Handling
    
    All errors use a unified format:
    ```json
    {
      "code": 2001,
      "message": "Phone number already registered",
      "data": null,
      "traceId": "abc-123"
    }
    ```
    
    ## Error Code Ranges
    
    - 1000-1999: General errors
    - 2000-2999: User-related
    - 3000-3999: Pokémon/Catch
    - 4000-4999: Gym/Social
    - 5000-5999: Payment
    - 9000-9999: System errors

tags:
  - name: Auth
    description: "Authentication (register, login, token refresh)"
  - name: Users
    description: "User management (profile, team, currency)"
  - name: Map
    description: "Map & Location (GPS, Pokémon spawning)"
  - name: Catch
    description: "Pokémon catching (throw, settlement)"
  - name: Pokemon
    description: "Pokémon management (bag, Pokédex, evolution)"
  - name: Gym
    description: "Gym system (capture, battle, Raid)"
  - name: Social
    description: "Social system (friends, gifts, trading)"
  - name: Reward
    description: "Tasks & Rewards (check-in, achievements, leaderboard)"
  - name: Payment
    description: "Payment system (orders, top-up)"

paths:
  /auth/register:
    post:
      summary: "User Registration"
      description: "Register a new user account with phone number and password"
      requestBody:
        description: "Registration information"
      responses:
        "201":
          description: "Registration successful"
        "400":
          description: "Invalid request parameters"
        "409":
          description: "Phone number already registered"
```

```yaml
# docs/api-spec/openapi/translations/ja-JP.yaml
openapi: "3.0.3"
info:
  title: "mineGo API"
  description: |
    GPSベースのARポケモン捕獲ゲームAPI
    
    ## 認証方法
    
    ほとんどのエンドポイントはJWT認証が必要です。ヘッダーに追加：
    ```
    Authorization: Bearer {accessToken}
    ```
    
    ## エラー処理
    
    すべてのエラーは統一形式を使用：
    ```json
    {
      "code": 2001,
      "message": "この電話番号は既に登録されています",
      "data": null,
      "traceId": "abc-123"
    }
    ```
    
    ## エラーコード範囲
    
    - 1000-1999: 一般エラー
    - 2000-2999: ユーザー関連
    - 3000-3999: ポケモン/捕獲
    - 4000-4999: ジム/ソーシャル
    - 5000-5999: 支払い
    - 9000-9999: システムエラー

tags:
  - name: Auth
    description: "認証（登録、ログイン、トークン更新）"
  - name: Users
    description: "ユーザー管理（プロフィール、チーム、通貨）"
  - name: Map
    description: "マップと位置（GPS、ポケモン出現）"
  - name: Catch
    description: "ポケモン捕獲（投球、決済）"
  - name: Pokemon
    description: "ポケモン管理（バッグ、図鑑、進化）"
  - name: Gym
    description: "ジムシステム（占領、バトル、レイド）"
  - name: Social
    description: "ソーシャルシステム（友達、ギフト、交換）"
  - name: Reward
    description: "タスクと報酬（チェックイン、実績、ランキング）"
  - name: Payment
    description: "決済システム（注文、チャージ）"

paths:
  /auth/register:
    post:
      summary: "ユーザー登録"
      description: "電話番号とパスワードで新しいユーザーアカウントを登録"
      requestBody:
        description: "登録情報"
      responses:
        "201":
          description: "登録成功"
        "400":
          description: "リクエストパラメータが無効"
        "409":
          description: "この電話番号は既に登録されています"
```

### 4.2 语言切换 API 端点

```javascript
// backend/gateway/src/routes/openapiI18n.js
'use strict';

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('../../shared/i18n');

const router = express.Router();

const TRANSLATIONS_DIR = path.join(__dirname, '../../../docs/api-spec/openapi/translations');

/**
 * GET /api-docs/:lang - 获取指定语言的 OpenAPI 文档
 * 
 * @param {string} lang - 语言代码 (zh-CN, en-US, ja-JP)
 * @returns {object} OpenAPI 规范对象
 */
router.get('/:lang', async (req, res, next) => {
  try {
    const lang = req.params.lang;
    
    // 验证语言代码
    if (!SUPPORTED_LANGUAGES.includes(lang)) {
      return res.status(400).json({
        error: 'Unsupported language',
        supportedLanguages: SUPPORTED_LANGUAGES
      });
    }
    
    // 读取对应语言的 OpenAPI 文件
    const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
    const content = await fs.readFile(filePath, 'utf-8');
    
    // 解析 YAML
    const yaml = require('js-yaml');
    const openapiSpec = yaml.load(content);
    
    // 设置响应头
    res.set('Content-Type', 'application/json');
    res.set('Content-Language', lang);
    res.json(openapiSpec);
    
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Language file not found' });
    }
    next(err);
  }
});

/**
 * GET /api-docs/languages - 获取支持的语言列表
 */
router.get('/languages', (req, res) => {
  res.json({
    default: DEFAULT_LANGUAGE,
    supported: SUPPORTED_LANGUAGES.map(lang => ({
      code: lang,
      name: {
        'zh-CN': '简体中文',
        'en-US': 'English',
        'ja-JP': '日本語'
      }[lang]
    }))
  });
});

/**
 * GET /api-docs/compare/:lang1/:lang2 - 对比两种语言的翻译覆盖率
 * 
 * 用于检测缺失的翻译键
 */
router.get('/compare/:lang1/:lang2', async (req, res, next) => {
  try {
    const { lang1, lang2 } = req.params;
    
    if (!SUPPORTED_LANGUAGES.includes(lang1) || !SUPPORTED_LANGUAGES.includes(lang2)) {
      return res.status(400).json({ error: 'Invalid language code' });
    }
    
    const [spec1, spec2] = await Promise.all([
      loadOpenAPISpec(lang1),
      loadOpenAPISpec(lang2)
    ]);
    
    const keys1 = extractDescriptionKeys(spec1);
    const keys2 = extractDescriptionKeys(spec2);
    
    const missing = keys1.filter(k => !keys2.includes(k));
    const extra = keys2.filter(k => !keys1.includes(k));
    
    res.json({
      lang1,
      lang2,
      lang1Count: keys1.length,
      lang2Count: keys2.length,
      missingInLang2: missing,
      extraInLang2: extra,
      coverage: ((keys1.length - missing.length) / keys1.length * 100).toFixed(2) + '%'
    });
    
  } catch (err) {
    next(err);
  }
});

async function loadOpenAPISpec(lang) {
  const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
  const content = await fs.readFile(filePath, 'utf-8');
  const yaml = require('js-yaml');
  return yaml.load(content);
}

function extractDescriptionKeys(spec, prefix = '') {
  const keys = [];
  
  if (spec.description) {
    keys.push(`${prefix}.description`);
  }
  if (spec.summary) {
    keys.push(`${prefix}.summary`);
  }
  
  if (spec.paths) {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        keys.push(...extractDescriptionKeys(operation, `paths.${path}.${method}`));
      }
    }
  }
  
  return keys;
}

module.exports = router;
```

### 4.3 Swagger UI 语言切换集成

```javascript
// backend/gateway/src/index.js 中集成
const openapiI18nRouter = require('./routes/openapiI18n');

// ── API Documentation (Swagger UI with i18n) ───────────────────────
app.use('/api-docs', openapiI18nRouter);

// 默认 Swagger UI（根据 Accept-Language 或用户偏好选择语言）
app.get('/api-docs', async (req, res, next) => {
  try {
    const lang = getLanguageFromRequest(req); // 复用 i18n 中间件
    res.redirect(`/api-docs/${lang}`);
  } catch (err) {
    next(err);
  }
});

// Swagger UI 静态资源（带语言切换 UI）
app.use('/swagger-ui', express.static(path.join(__dirname, '../public/swagger-ui')));
```

```html
<!-- backend/gateway/public/swagger-ui/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>mineGo API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    .language-selector {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 9999;
      background: white;
      padding: 8px 16px;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .language-selector select {
      margin-left: 8px;
      padding: 4px 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="language-selector">
    <label>Language:</label>
    <select id="langSelect">
      <option value="zh-CN">简体中文</option>
      <option value="en-US">English</option>
      <option value="ja-JP">日本語</option>
    </select>
  </div>
  <div id="swagger-ui"></div>
  
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    // 从 URL 或 localStorage 获取语言
    const urlParams = new URLSearchParams(window.location.search);
    const savedLang = localStorage.getItem('swagger-lang') || 'zh-CN';
    const lang = urlParams.get('lang') || savedLang;
    
    document.getElementById('langSelect').value = lang;
    
    // 初始化 Swagger UI
    const ui = SwaggerUIBundle({
      url: `/api-docs/${lang}`,
      dom_id: '#swagger-ui',
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: "BaseLayout"
    });
    
    // 语言切换
    document.getElementById('langSelect').addEventListener('change', (e) => {
      const newLang = e.target.value;
      localStorage.setItem('swagger-lang', newLang);
      window.location.href = `?lang=${newLang}`;
    });
  </script>
</body>
</html>
```

### 4.4 翻译键提取与验证工具

```javascript
// backend/scripts/extract-openapi-keys.js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * 从 OpenAPI 规范中提取所有需要翻译的键
 */
function extractTranslationKeys(spec, prefix = '') {
  const keys = [];
  
  // info 字段
  if (spec.info) {
    if (spec.info.title) keys.push({ key: 'info.title', text: spec.info.title });
    if (spec.info.description) keys.push({ key: 'info.description', text: spec.info.description });
  }
  
  // tags
  if (spec.tags) {
    spec.tags.forEach((tag, i) => {
      if (tag.description) {
        keys.push({ key: `tags.${tag.name}.description`, text: tag.description });
      }
    });
  }
  
  // paths
  if (spec.paths) {
    for (const [pathName, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const pathPrefix = `paths.${pathName}.${method}`;
        
        if (operation.summary) {
          keys.push({ key: `${pathPrefix}.summary`, text: operation.summary });
        }
        if (operation.description) {
          keys.push({ key: `${pathPrefix}.description`, text: operation.description });
        }
        
        // parameters
        if (operation.parameters) {
          operation.parameters.forEach((param, i) => {
            if (param.description) {
              keys.push({ 
                key: `${pathPrefix}.parameters.${param.name}.description`, 
                text: param.description 
              });
            }
          });
        }
        
        // requestBody
        if (operation.requestBody?.description) {
          keys.push({ key: `${pathPrefix}.requestBody.description`, text: operation.requestBody.description });
        }
        
        // responses
        if (operation.responses) {
          for (const [status, response] of Object.entries(operation.responses)) {
            if (response.description) {
              keys.push({ key: `${pathPrefix}.responses.${status}.description`, text: response.description });
            }
          });
        }
      }
    }
  }
  
  return keys;
}

/**
 * 主函数
 */
function main() {
  const baseFile = path.join(__dirname, '../../docs/api-spec/openapi/base.yaml');
  const content = fs.readFileSync(baseFile, 'utf-8');
  const spec = yaml.load(content);
  
  const keys = extractTranslationKeys(spec);
  
  console.log(`\n📊 提取结果：共 ${keys.length} 个翻译键\n`);
  
  // 输出为 JSON（供翻译工具使用）
  const outputFile = path.join(__dirname, '../../docs/api-spec/openapi/translation-keys.json');
  fs.writeFileSync(outputFile, JSON.stringify(keys, null, 2));
  console.log(`✅ 已写入: ${outputFile}\n`);
  
  // 按类别分组统计
  const grouped = {};
  keys.forEach(k => {
    const category = k.key.split('.')[0];
    grouped[category] = (grouped[category] || 0) + 1;
  });
  
  console.log('📈 分类统计：');
  Object.entries(grouped).forEach(([cat, count]) => {
    console.log(`  ${cat}: ${count}`);
  });
}

main();
```

```javascript
// backend/scripts/validate-openapi-i18n.js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];
const TRANSLATIONS_DIR = path.join(__dirname, '../../docs/api-spec/openapi/translations');

/**
 * 验证所有语言的翻译完整性
 */
function validateTranslations() {
  console.log('🔍 开始验证 OpenAPI 多语言翻译...\n');
  
  const errors = [];
  const warnings = [];
  
  // 检查翻译文件是否存在
  for (const lang of SUPPORTED_LANGUAGES) {
    const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
    
    if (!fs.existsSync(filePath)) {
      errors.push(`❌ 缺少翻译文件: ${lang}.yaml`);
      continue;
    }
    
    // 验证 YAML 语法
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      yaml.load(content);
      console.log(`✅ ${lang}.yaml 语法正确`);
    } catch (err) {
      errors.push(`❌ ${lang}.yaml 语法错误: ${err.message}`);
    }
  }
  
  // 对比翻译键覆盖率
  if (errors.length === 0) {
    const specs = {};
    for (const lang of SUPPORTED_LANGUAGES) {
      const content = fs.readFileSync(path.join(TRANSLATIONS_DIR, `${lang}.yaml`), 'utf-8');
      specs[lang] = yaml.load(content);
    }
    
    // 提取所有键
    const allKeys = {};
    for (const [lang, spec] of Object.entries(specs)) {
      allKeys[lang] = extractAllKeys(spec);
    }
    
    // 对比
    const baseKeys = allKeys['zh-CN'];
    for (const lang of ['en-US', 'ja-JP']) {
      const langKeys = allKeys[lang];
      const missing = baseKeys.filter(k => !langKeys.includes(k));
      const extra = langKeys.filter(k => !baseKeys.includes(k));
      
      if (missing.length > 0) {
        warnings.push(`⚠️  ${lang} 缺少 ${missing.length} 个翻译键`);
        missing.slice(0, 5).forEach(k => warnings.push(`    - ${k}`));
        if (missing.length > 5) warnings.push(`    ... 还有 ${missing.length - 5} 个`);
      }
      
      if (extra.length > 0) {
        warnings.push(`⚠️  ${lang} 多出 ${extra.length} 个翻译键`);
      }
      
      const coverage = ((baseKeys.length - missing.length) / baseKeys.length * 100).toFixed(2);
      console.log(`📊 ${lang} 覆盖率: ${coverage}%`);
    }
  }
  
  // 输出结果
  console.log('\n' + '='.repeat(50));
  
  if (errors.length > 0) {
    console.log('\n❌ 错误：');
    errors.forEach(e => console.log(e));
    process.exit(1);
  }
  
  if (warnings.length > 0) {
    console.log('\n⚠️  警告：');
    warnings.forEach(w => console.log(w));
  }
  
  if (errors.length === 0 && warnings.length === 0) {
    console.log('\n✅ 所有翻译验证通过！');
  }
}

function extractAllKeys(obj, prefix = '') {
  const keys = [];
  
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    
    if (typeof value === 'string' && (key === 'description' || key === 'summary')) {
      keys.push(fullKey);
    } else if (typeof value === 'object' && value !== null) {
      keys.push(...extractAllKeys(value, fullKey));
    }
  }
  
  return keys;
}

validateTranslations();
```

### 4.5 CI 集成

```yaml
# .github/workflows/openapi-i18n-check.yml
name: OpenAPI i18n Check

on:
  pull_request:
    paths:
      - 'docs/api-spec/openapi/**'
      - 'backend/gateway/src/routes/openapiI18n.js'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      
      - name: Install dependencies
        run: |
          cd backend
          npm install
      
      - name: Validate OpenAPI i18n
        run: |
          node backend/scripts/validate-openapi-i18n.js
      
      - name: Check syntax
        run: |
          node --check backend/gateway/src/routes/openapiI18n.js
          node --check backend/scripts/extract-openapi-keys.js
          node --check backend/scripts/validate-openapi-i18n.js
```

### 4.6 数据库表设计

```sql
-- database/pending/20260613_080000__add_openapi_i18n_tables.sql

-- OpenAPI 翻译键表（用于追踪翻译状态）
CREATE TABLE openapi_translation_keys (
  id SERIAL PRIMARY KEY,
  key VARCHAR(512) NOT NULL UNIQUE,
  category VARCHAR(64) NOT NULL, -- info, tags, paths
  source_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_openapi_keys_category ON openapi_translation_keys(category);

-- OpenAPI 翻译表
CREATE TABLE openapi_translations (
  id SERIAL PRIMARY KEY,
  key_id INTEGER REFERENCES openapi_translation_keys(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL, -- zh-CN, en-US, ja-JP
  translated_text TEXT NOT NULL,
  translated_by VARCHAR(64), -- 翻译者（手动翻译时记录）
  status VARCHAR(20) DEFAULT 'pending', -- pending, reviewed, approved
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(key_id, language)
);

CREATE INDEX idx_openapi_translations_lang ON openapi_translations(language);
CREATE INDEX idx_openapi_translations_status ON openapi_translations(status);

-- 翻译审计日志
CREATE TABLE openapi_translation_audit (
  id SERIAL PRIMARY KEY,
  key_id INTEGER REFERENCES openapi_translation_keys(id),
  language VARCHAR(10),
  action VARCHAR(32) NOT NULL, -- created, updated, deleted, reviewed
  old_value TEXT,
  new_value TEXT,
  changed_by VARCHAR(64),
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_openapi_audit_key ON openapi_translation_audit(key_id);
CREATE INDEX idx_openapi_audit_time ON openapi_translation_audit(changed_at DESC);
```

### 4.7 Prometheus 指标

```javascript
// backend/shared/metrics.js 新增指标

// OpenAPI 文档请求计数
const openapiDocRequests = new Counter({
  name: 'minego_openapi_doc_requests_total',
  help: 'Total OpenAPI documentation requests',
  labelNames: ['language', 'status']
});

// 翻译覆盖率
const openapiTranslationCoverage = new Gauge({
  name: 'minego_openapi_translation_coverage',
  help: 'OpenAPI translation coverage percentage',
  labelNames: ['language']
});

// 翻译键数量
const openapiTranslationKeys = new Gauge({
  name: 'minego_openapi_translation_keys_total',
  help: 'Total number of OpenAPI translation keys',
  labelNames: ['category']
});
```

## 5. 验收标准

- [ ] `node --check backend/gateway/src/routes/openapiI18n.js` 通过
- [ ] `node --check backend/scripts/extract-openapi-keys.js` 通过
- [ ] `node --check backend/scripts/validate-openapi-i18n.js` 通过
- [ ] `curl -sf http://localhost:8080/api-docs/zh-CN` 返回 OpenAPI JSON
- [ ] `curl -sf http://localhost:8080/api-docs/en-US` 返回英文 OpenAPI JSON
- [ ] `curl -sf http://localhost:8080/api-docs/ja-JP` 返回日文 OpenAPI JSON
- [ ] `curl -sf http://localhost:8080/api-docs/languages` 返回支持语言列表
- [ ] 数据库迁移文件存在并可通过 `node scripts/run-migrations.js` 执行
- [ ] 单元测试 `node backend/tests/unit/openapi-i18n.test.js` 通过（25+ 测试用例）
- [ ] CI 工作流 `.github/workflows/openapi-i18n-check.yml` 存在
- [ ] 翻译文件 `docs/api-spec/openapi/translations/*.yaml` 存在且语法正确

## 6. 工作量估算

**M（Medium）**

理由：
- 需要创建 3 个语言版本的 OpenAPI 描述文件
- 需要实现语言切换 API 和 Swagger UI 集成
- 需要开发翻译键提取和验证工具
- 预计 6-8 个文件，约 25KB 代码

## 7. 优先级理由

**P1 理由**：
1. OpenAPI 文档是开发者接入的关键入口，国际化是必需品
2. 与前端多语言、后端错误消息国际化形成完整的国际化体系
3. 实现后可显著降低国际开发者接入成本
4. 对"项目可用"贡献：提升开发者体验，支持全球化部署

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 翻译文件与 base.yaml 不同步 | CI 自动验证翻译键覆盖率 |
| 翻译质量不一致 | 建立翻译审核流程，记录翻译者 |
| 新增 API 时忘记翻译 | CI 阻断：翻译覆盖率必须 100% |
| YAML 语法错误 | 验证工具自动检测语法 |
