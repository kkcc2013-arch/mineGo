# REQ-00370：翻译缺失检测与智能回退机制系统

- **编号**：REQ-00370
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、backend/shared/i18n、admin-dashboard、backend/jobs、database/migrations
- **创建时间**：2026-06-29 17:00 UTC
- **依赖需求**：REQ-00294（动态本地化系统）、REQ-00353（翻译管理系统）

## 1. 背景与问题

当前 mineGo 项目已实现动态本地化系统（REQ-00294）和翻译管理功能，支持中文、英文、日文三种语言。然而，在翻译管理方面存在以下关键缺口：

### 1.1 翻译缺失问题
1. **静默失败**：当请求的语言缺少某个翻译键时，系统直接返回键名，用户看到类似 "pokemon.pikachu.description" 的占位文本，严重影响用户体验
2. **缺失检测困难**：开发人员和翻译人员无法快速识别哪些翻译键缺失，需要手动检查每个语言文件
3. **不一致的用户体验**：不同语言的用户可能看到部分翻译、部分键名混合的界面

### 1.2 回退机制不完善
1. **单一回退路径**：当前仅支持 `zh-CN → en-US → key` 的简单回退，未考虑语言变体（如 `zh-TW → zh-CN → en-US`）
2. **区域偏好丢失**：回退时未保留用户的区域偏好信息，导致货币、日期格式等同时回退
3. **无智能匹配**：未实现基于语言相似性的智能回退（如 `en-GB` 缺失时优先回退到 `en-US` 而非 `zh-CN`）

### 1.3 运维痛点
1. **翻译覆盖率报告缺失**：无法查看各语言的翻译完成度
2. **批量检测工具缺失**：新增翻译键后无法批量检测缺失
3. **告警机制缺失**：翻译缺失无自动告警，依赖用户反馈

## 2. 目标

构建翻译缺失检测与智能回退系统，实现：
1. **实时翻译缺失检测**：请求时自动检测并记录缺失的翻译键
2. **智能回退链**：基于语言相似性构建多级回退链，最小化用户感知
3. **翻译覆盖率可视化**：提供各语言翻译完成度仪表板
4. **自动告警与报告**：翻译缺失时自动通知翻译团队

## 3. 范围

### 包含
- 翻译缺失检测中间件与日志记录
- 多级智能回退链配置与执行引擎
- 翻译覆盖率计算与存储
- 翻译缺失告警服务
- Admin Dashboard 翻译覆盖率仪表板
- 翻译缺失报告 API

### 不包含
- 自动机器翻译（已有 REQ-00353）
- 翻译质量评分系统
- 翻译记忆库功能
- 术语库管理

## 4. 详细需求

### 4.1 翻译缺失检测中间件

```javascript
// backend/shared/i18n/missingTranslationDetector.js
class MissingTranslationDetector {
  constructor() {
    this.missingKeys = new Map(); // locale -> Set<key>
    this.reportQueue = [];
  }

  /**
   * 检测翻译缺失并记录
   */
  detectMissing(key, locale, fallbackUsed) {
    if (fallbackUsed) {
      const keySet = this.missingKeys.get(locale) || new Set();
      keySet.add(key);
      this.missingKeys.set(locale, keySet);
      
      // 异步记录到数据库
      this.recordMissing(key, locale);
    }
  }

  /**
   * 记录缺失到数据库
   */
  async recordMissing(key, locale) {
    await query(`
      INSERT INTO translation_missing (translation_key, locale, detected_at, occurrence_count)
      VALUES ($1, $2, NOW(), 1)
      ON CONFLICT (translation_key, locale) 
      DO UPDATE SET 
        occurrence_count = translation_missing.occurrence_count + 1,
        last_detected_at = NOW()
    `, [key, locale]);
  }
}
```

### 4.2 智能回退链引擎

```javascript
// backend/shared/i18n/intelligentFallbackEngine.js
class IntelligentFallbackEngine {
  constructor() {
    // 语言相似性图
    this.fallbackGraph = {
      'zh-CN': ['zh-TW', 'en-US', 'ja-JP'],
      'zh-TW': ['zh-CN', 'en-US', 'ja-JP'],
      'en-US': ['en-GB', 'zh-CN'],
      'en-GB': ['en-US', 'zh-CN'],
      'ja-JP': ['en-US', 'zh-CN']
    };
    
    // 语言元数据
    this.localeMetadata = {
      'zh-CN': { script: 'Hans', region: 'CN', family: 'Sino-Tibetan' },
      'zh-TW': { script: 'Hant', region: 'TW', family: 'Sino-Tibetan' },
      'en-US': { script: 'Latn', region: 'US', family: 'Indo-European' },
      'en-GB': { script: 'Latn', region: 'GB', family: 'Indo-European' },
      'ja-JP': { script: 'Jpan', region: 'JP', family: 'Japonic' }
    };
  }

  /**
   * 获取回退链
   */
  getFallbackChain(locale) {
    return this.fallbackGraph[locale] || ['en-US'];
  }

  /**
   * 智能查找翻译
   */
  async findTranslation(key, locale, translations) {
    const chain = [locale, ...this.getFallbackChain(locale)];
    
    for (const loc of chain) {
      if (translations[loc]?.[key]) {
        return {
          value: translations[loc][key],
          actualLocale: loc,
          isFallback: loc !== locale
        };
      }
    }
    
    return {
      value: key,
      actualLocale: null,
      isFallback: true,
      missing: true
    };
  }
}
```

### 4.3 翻译覆盖率计算服务

```javascript
// backend/jobs/translationCoverageCalculator.js
class TranslationCoverageCalculator {
  /**
   * 计算各语言翻译覆盖率
   */
  async calculateCoverage() {
    const results = {};
    
    // 获取所有翻译键
    const { rows: allKeys } = await query(`
      SELECT DISTINCT translation_key FROM translation_keys
    `);
    const totalKeys = allKeys.length;
    
    // 计算每个语言的覆盖率
    for (const locale of SUPPORTED_LOCALES) {
      const { rows: translated } = await query(`
        SELECT COUNT(DISTINCT translation_key) as count
        FROM translations
        WHERE locale = $1 AND value IS NOT NULL AND value != ''
      `, [locale]);
      
      const { rows: missing } = await query(`
        SELECT COUNT(DISTINCT translation_key) as count
        FROM translation_missing
        WHERE locale = $1 AND resolved_at IS NULL
      `, [locale]);
      
      results[locale] = {
        total: totalKeys,
        translated: translated[0].count,
        missing: missing[0].count,
        coverage: (translated[0].count / totalKeys * 100).toFixed(2)
      };
    }
    
    // 存储覆盖率报告
    await query(`
      INSERT INTO translation_coverage_report (report_data, generated_at)
      VALUES ($1, NOW())
    `, [JSON.stringify(results)]);
    
    return results;
  }
}
```

### 4.4 数据库表结构

```sql
-- database/migrations/20260629_170000_translation_missing_system.sql

-- 翻译缺失记录表
CREATE TABLE translation_missing (
  id SERIAL PRIMARY KEY,
  translation_key VARCHAR(255) NOT NULL,
  locale VARCHAR(10) NOT NULL,
  detected_at TIMESTAMP DEFAULT NOW(),
  last_detected_at TIMESTAMP DEFAULT NOW(),
  occurrence_count INTEGER DEFAULT 1,
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(255),
  UNIQUE(translation_key, locale)
);

CREATE INDEX idx_translation_missing_locale ON translation_missing(locale);
CREATE INDEX idx_translation_missing_unresolved ON translation_missing(locale) WHERE resolved_at IS NULL;

-- 翻译覆盖率报告表
CREATE TABLE translation_coverage_report (
  id SERIAL PRIMARY KEY,
  report_data JSONB NOT NULL,
  generated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_coverage_report_generated ON translation_coverage_report(generated_at DESC);

-- 翻译键定义表（用于统计）
CREATE TABLE translation_keys (
  id SERIAL PRIMARY KEY,
  translation_key VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  category VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 回退链配置表
CREATE TABLE translation_fallback_chain (
  id SERIAL PRIMARY KEY,
  locale VARCHAR(10) NOT NULL,
  fallback_locale VARCHAR(10) NOT NULL,
  priority INTEGER NOT NULL,
  UNIQUE(locale, fallback_locale)
);

-- 初始化默认回退链
INSERT INTO translation_fallback_chain (locale, fallback_locale, priority) VALUES
('zh-CN', 'zh-TW', 1),
('zh-CN', 'en-US', 2),
('zh-TW', 'zh-CN', 1),
('zh-TW', 'en-US', 2),
('en-US', 'en-GB', 1),
('en-GB', 'en-US', 1),
('ja-JP', 'en-US', 1);
```

### 4.5 Admin Dashboard API

```javascript
// gateway/src/routes/translationCoverage.js

/**
 * GET /api/admin/translation/coverage
 * 获取翻译覆盖率报告
 */
async function getCoverageReport(req, res) {
  const { rows: [latest] } = await query(`
    SELECT report_data, generated_at 
    FROM translation_coverage_report 
    ORDER BY generated_at DESC 
    LIMIT 1
  `);
  
  res.json({
    success: true,
    data: latest?.report_data || {},
    generatedAt: latest?.generated_at
  });
}

/**
 * GET /api/admin/translation/missing
 * 获取缺失翻译列表
 */
async function getMissingTranslations(req, res) {
  const { locale, limit = 100, offset = 0 } = req.query;
  
  let sql = `
    SELECT translation_key, locale, occurrence_count, last_detected_at
    FROM translation_missing
    WHERE resolved_at IS NULL
  `;
  
  if (locale) {
    sql += ` AND locale = $1`;
  }
  
  sql += ` ORDER BY occurrence_count DESC, last_detected_at DESC LIMIT $2 OFFSET $3`;
  
  const { rows } = await query(sql, locale ? [locale, limit, offset] : [limit, offset]);
  
  res.json({ success: true, data: rows });
}

/**
 * POST /api/admin/translation/missing/:key/resolve
 * 标记缺失翻译为已解决
 */
async function resolveMissingTranslation(req, res) {
  const { key } = req.params;
  const { locale } = req.body;
  
  await query(`
    UPDATE translation_missing 
    SET resolved_at = NOW(), resolved_by = $1
    WHERE translation_key = $2 AND locale = $3
  `, [req.user.id, key, locale]);
  
  res.json({ success: true });
}
```

## 5. 验收标准（可测试）

- [ ] 访问缺失翻译键时，系统自动回退到下一优先语言而非显示键名
- [ ] 翻译缺失自动记录到 `translation_missing` 表
- [ ] `GET /api/admin/translation/coverage` 返回各语言覆盖率百分比
- [ ] `GET /api/admin/translation/missing` 返回缺失翻译列表
- [ ] 回退链支持至少 2 级（如 zh-TW → zh-CN → en-US）
- [ ] 翻译缺失告警邮件发送成功（缺失数 > 10 时触发）
- [ ] 覆盖率报告每日自动生成
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M（中等）**：约 2-3 人日
- 翻译缺失检测中间件：0.5 人日
- 智能回退引擎：0.5 人日
- 覆盖率计算服务：0.5 人日
- Admin Dashboard API：0.5 人日
- 测试与文档：0.5 人日

## 7. 优先级理由

**P1 理由**：
1. **用户体验关键**：翻译缺失直接影响非英语用户的游戏体验，可能导致用户流失
2. **国际化必要组件**：随着游戏扩展到更多地区，翻译质量至关重要
3. **运维效率提升**：自动检测和报告大幅减少人工排查成本
4. **依赖链支持**：为后续多语言扩展（如韩语、西班牙语）奠定基础
