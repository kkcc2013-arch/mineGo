# REQ-00495：文化敏感内容本地化过滤与合规适配系统

- **编号**：REQ-00495
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、pokemon-service、social-service、admin-dashboard、backend/jobs
- **创建时间**：2026-07-08 04:00
- **依赖需求**：REQ-00011(多语言支持已完成)、REQ-00384(GDPR合规已完成)

## 1. 背景与问题

mineGo 作为一款全球化 AR 精灵捕捉手游，需要部署到中国、日本、美国、欧洲等多个地区。然而，当前系统缺少**文化敏感内容的本地化适配与合规过滤机制**：

### 1.1 文化敏感性缺口
1. **精灵设计争议**：某些精灵的名称、外观在特定文化中可能具有宗教、政治敏感性（如龙类精灵在西方 vs 东方文化寓意不同）
2. **道具/技能命名**：部分道具名称直译后可能在目标文化中产生负面含义
3. **任务/活动内容**：节日活动（万圣节、圣诞节）在某些地区可能不被接受
4. **用户生成内容**：玩家昵称、公会名称、社交内容缺少文化敏感度过滤

### 1.2 合规风险
1. **地区法律法规**：中国（游戏版号、防沉迷）、日本（赌博要素限制）、德国（暴力内容）、中东（宗教内容）等
2. **年龄分级差异**：PEGI（欧洲）、ESRB（美国）、CERO（日本）、CADPA（中国）标准不同
3. **支付合规**：某些地区的支付方式、货币展示要求不同

### 1.3 当前代码现状
- `backend/shared/i18n.js` 仅支持语言翻译，无文化适配层
- 精灵、道具、技能数据表缺少 `region_restricted` 或 `cultural_variant` 字段
- 社交模块的用户昵称过滤仅检查脏词库，缺少文化敏感词库
- 节日活动配置硬编码在代码中，无地区开关

## 2. 目标

构建文化敏感内容的本地化过滤与合规适配系统，实现：

1. **内容文化分级**：精灵、道具、技能按文化敏感度标记，支持按地区显示/隐藏
2. **动态内容过滤**：根据用户所在地区/IP 自动过滤敏感内容
3. **合规规则引擎**：配置各地区法律法规要求的合规规则（年龄分级、支付限制等）
4. **用户生成内容审核**：昵称、公会名称多文化敏感度审核
5. **活动地区适配**：节日活动、营销内容按地区启用/禁用

## 3. 范围

### 包含
- 数据库设计：`cultural_content_rules`、`region_restricted_entities`、`content_age_ratings` 表
- 文化内容过滤服务：`CulturalContentFilter`
- 合规规则引擎：`ComplianceRuleEngine`
- 用户内容审核扩展：多文化敏感词库
- Admin Dashboard：文化规则配置、地区内容管理界面
- API 设计：地区内容查询、合规规则应用

### 不包含
- 图像内容审核（已有 REQ-00308）
- 语音内容审核
- 自动翻译（已有 REQ-00353）
- 法律咨询建议（需人工确认）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- database/migrations/20260708_040000_cultural_content_localization_system.sql

-- 文化内容规则表
CREATE TABLE cultural_content_rules (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,     -- pokemon/skill/item/activity/ugc
  entity_id INTEGER,
  content_field VARCHAR(50),            -- name/description/image
  sensitivity_level VARCHAR(20) NOT NULL, -- low/medium/high/critical
  cultural_context VARCHAR(50) NOT NULL,  -- religion/politics/violence/gambling/adult
  affected_regions JSONB,                 -- ["CN", "JP", "DE", "SA"]
  restriction_type VARCHAR(20) NOT NULL,  -- hide/rename/warn/age_gate
  alternative_content JSONB,              -- {"name": {"zh-CN": "替代名称"}}
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cultural_rules_entity ON cultural_content_rules(entity_type, entity_id);
CREATE INDEX idx_cultural_rules_regions ON cultural_content_rules USING GIN(affected_regions);

-- 地区限制实体表（精灵/道具/技能）
CREATE TABLE region_restricted_entities (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  region_code VARCHAR(10) NOT NULL,       -- ISO 3166-1 alpha-2
  restriction_level VARCHAR(20) NOT NULL, -- blocked/restricted/modified
  reason TEXT,
  effective_from TIMESTAMP,
  effective_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, region_code)
);

CREATE INDEX idx_region_restricted_lookup ON region_restricted_entities(entity_type, entity_id, region_code);

-- 内容年龄分级表
CREATE TABLE content_age_ratings (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  rating_system VARCHAR(20) NOT NULL,     -- PEGI/ESRB/CERO/CADPA
  region_code VARCHAR(10) NOT NULL,
  age_rating VARCHAR(20) NOT NULL,        -- PEGI: 3/7/12/16/18, ESRB: E/T/M/AO
  content_descriptors JSONB,              -- ["violence", "gambling"]
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id, rating_system, region_code)
);

-- 合规规则配置表
CREATE TABLE compliance_rules (
  id SERIAL PRIMARY KEY,
  region_code VARCHAR(10) NOT NULL,
  rule_type VARCHAR(50) NOT NULL,         -- age_verification/payment_limit/playtime_limit
  rule_config JSONB NOT NULL,
  effective_from TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(region_code, rule_type)
);

-- 文化敏感词库表
CREATE TABLE cultural_sensitive_words (
  id SERIAL PRIMARY KEY,
  word VARCHAR(255) NOT NULL,
  language VARCHAR(10) NOT NULL,
  sensitivity_type VARCHAR(50) NOT NULL,  -- religion/politics/offensive/adult
  cultural_context VARCHAR(100),          -- 适用文化背景说明
  action VARCHAR(20) DEFAULT 'reject',    -- reject/warn/review
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sensitive_words_lookup ON cultural_sensitive_words(word, language);
```

### 4.2 CulturalContentFilter 服务

```javascript
// backend/shared/CulturalContentFilter.js
class CulturalContentFilter {
  constructor(dbPool, redisClient) {
    this.db = dbPool;
    this.redis = redisClient;
    this.cache = new Map();
  }

  /**
   * 过滤实体列表，移除或替换地区敏感内容
   * @param {Array} entities - 精灵/道具/技能列表
   * @param {string} regionCode - 用户所在地区（ISO 3166-1 alpha-2）
   * @param {number} userAge - 用户年龄（用于年龄分级过滤）
   * @returns {Array} 过滤后的实体列表
   */
  async filterEntities(entities, regionCode, userAge = null) {
    const rules = await this.loadRegionRules(regionCode);
    const results = [];

    for (const entity of entities) {
      const entityRestriction = await this.checkEntityRestriction(
        entity.type, 
        entity.id, 
        regionCode, 
        userAge
      );

      if (entityRestriction.level === 'blocked') {
        continue; // 完全隐藏
      }

      if (entityRestriction.level === 'modified') {
        // 应用替代内容
        const modifiedEntity = this.applyModification(entity, entityRestriction);
        results.push(modifiedEntity);
        continue;
      }

      if (entityRestriction.level === 'restricted' && userAge) {
        // 检查年龄分级
        const ageRating = await this.getAgeRating(entity.type, entity.id, regionCode);
        if (ageRating && userAge < ageRating.minAge) {
          continue; // 年龄不足，隐藏
        }
      }

      results.push(entity);
    }

    return results;
  }

  /**
   * 检查实体是否受地区限制
   */
  async checkEntityRestriction(entityType, entityId, regionCode, userAge) {
    const cacheKey = `${entityType}:${entityId}:${regionCode}`;
    
    // 检查本地缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // 查询数据库
    const { rows } = await this.db.query(`
      SELECT restriction_level, alternative_content, reason
      FROM region_restricted_entities
      WHERE entity_type = $1 AND entity_id = $2 AND region_code = $3
        AND (effective_from IS NULL OR effective_from <= NOW())
        AND (effective_until IS NULL OR effective_until >= NOW())
      LIMIT 1
    `, [entityType, entityId, regionCode]);

    const result = rows.length > 0 ? {
      level: rows[0].restriction_level,
      alternative: rows[0].alternative_content,
      reason: rows[0].reason
    } : { level: 'none' };

    // 缓存结果（5分钟）
    this.cache.set(cacheKey, result);
    setTimeout(() => this.cache.delete(cacheKey), 300000);

    return result;
  }

  /**
   * 应用替代内容修改
   */
  applyModification(entity, restriction) {
    if (!restriction.alternative) return entity;

    const modified = { ...entity };
    if (restriction.alternative.name) {
      modified.name = restriction.alternative.name[entity.language] || entity.name;
    }
    if (restriction.alternative.description) {
      modified.description = restriction.alternative.description[entity.language] || entity.description;
    }
    if (restriction.alternative.image_url) {
      modified.image_url = restriction.alternative.image_url;
    }

    return modified;
  }

  /**
   * 获取实体年龄分级
   */
  async getAgeRating(entityType, entityId, regionCode) {
    const ratingSystem = this.getRatingSystemForRegion(regionCode);
    
    const { rows } = await this.db.query(`
      SELECT age_rating, content_descriptors
      FROM content_age_ratings
      WHERE entity_type = $1 AND entity_id = $2 
        AND rating_system = $3 AND region_code = $4
      LIMIT 1
    `, [entityType, entityId, ratingSystem, regionCode]);

    if (rows.length === 0) return null;

    return {
      rating: rows[0].age_rating,
      minAge: this.ageRatingToMinAge(rows[0].age_rating, ratingSystem),
      descriptors: rows[0].content_descriptors
    };
  }

  /**
   * 根据地区获取分级系统
   */
  getRatingSystemForRegion(regionCode) {
    const regionToRating = {
      'US': 'ESRB', 'CA': 'ESRB',
      'GB': 'PEGI', 'DE': 'PEGI', 'FR': 'PEGI', 'IT': 'PEGI', 'ES': 'PEGI',
      'JP': 'CERO',
      'CN': 'CADPA',
      'KR': 'GRAC',
      'AU': 'ACB'
    };
    return regionToRating[regionCode] || 'PEGI';
  }

  /**
   * 年龄分级转换为最低年龄
   */
  ageRatingToMinAge(rating, system) {
    const ageMap = {
      'PEGI': { '3': 3, '7': 7, '12': 12, '16': 16, '18': 18 },
      'ESRB': { 'E': 6, 'E10+': 10, 'T': 13, 'M': 17, 'AO': 18 },
      'CERO': { 'A': 3, 'B': 12, 'C': 15, 'D': 17, 'Z': 18 },
      'CADPA': { '8+': 8, '12+': 12, '16+': 16, '18+': 18 }
    };
    return ageMap[system]?.[rating] || 0;
  }
}

module.exports = CulturalContentFilter;
```

### 4.3 ComplianceRuleEngine 合规规则引擎

```javascript
// backend/shared/ComplianceRuleEngine.js
class ComplianceRuleEngine {
  constructor(dbPool) {
    this.db = dbPool;
    this.rules = new Map();
  }

  /**
   * 加载地区合规规则
   */
  async loadRegionRules(regionCode) {
    if (this.rules.has(regionCode)) {
      return this.rules.get(regionCode);
    }

    const { rows } = await this.db.query(`
      SELECT rule_type, rule_config
      FROM compliance_rules
      WHERE region_code = $1 AND is_active = true
        AND (effective_from IS NULL OR effective_from <= NOW())
    `, [regionCode]);

    const rules = {};
    rows.forEach(row => {
      rules[row.rule_type] = row.rule_config;
    });

    this.rules.set(regionCode, rules);
    return rules;
  }

  /**
   * 检查支付限制（如中国未成年人支付限额）
   */
  async checkPaymentLimit(userId, regionCode, amount, userAge) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.payment_limit) return { allowed: true };

    const { max_single_amount, max_monthly_amount, age_threshold } = rules.payment_limit;
    
    // 年龄检查
    if (age_threshold && userAge < age_threshold) {
      return {
        allowed: false,
        reason: `age_below_${age_threshold}`,
        maxAmount: max_single_amount || 0
      };
    }

    // 单次支付限额
    if (max_single_amount && amount > max_single_amount) {
      return {
        allowed: false,
        reason: 'exceeds_single_limit',
        maxAmount: max_single_amount
      };
    }

    // 月度支付限额检查
    if (max_monthly_amount) {
      const { rows: [monthly] } = await this.db.query(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM payment_transactions
        WHERE user_id = $1 
          AND created_at >= DATE_TRUNC('month', NOW())
          AND status = 'completed'
      `, [userId]);

      if (monthly.total + amount > max_monthly_amount) {
        return {
          allowed: false,
          reason: 'exceeds_monthly_limit',
          remaining: max_monthly_amount - monthly.total
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 检查游玩时间限制（如中国防沉迷）
   */
  async checkPlaytimeLimit(userId, regionCode, userAge) {
    const rules = await this.loadRegionRules(regionCode);
    
    if (!rules.playtime_limit) return { allowed: true };

    const { daily_limit_hours, night_restriction, age_threshold } = rules.playtime_limit;
    
    if (age_threshold && userAge >= age_threshold) {
      return { allowed: true }; // 成年人无限制
    }

    // 检查夜间禁玩时段
    if (night_restriction) {
      const hour = new Date().getHours();
      const { start_hour, end_hour } = night_restriction;
      if (hour >= start_hour || hour < end_hour) {
        return {
          allowed: false,
          reason: 'night_restriction',
          allowedFrom: `${end_hour}:00`
        };
      }
    }

    // 检查当日游玩时长
    if (daily_limit_hours) {
      const { rows: [today] } = await this.db.query(`
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at))/3600), 0) as hours
        FROM play_sessions
        WHERE user_id = $1 
          AND started_at >= CURRENT_DATE
      `, [userId]);

      if (today.hours >= daily_limit_hours) {
        return {
          allowed: false,
          reason: 'daily_limit_exceeded',
          limitHours: daily_limit_hours
        };
      }

      return {
        allowed: true,
        remainingHours: daily_limit_hours - today.hours
      };
    }

    return { allowed: true };
  }

  /**
   * 应用年龄验证要求
   */
  async getAgeVerificationRequirement(regionCode) {
    const rules = await this.loadRegionRules(regionCode);
    return rules.age_verification || null;
  }
}

module.exports = ComplianceRuleEngine;
```

### 4.4 用户生成内容审核扩展

```javascript
// backend/social/services/ContentModerator.js
class ContentModerator {
  constructor(dbPool) {
    this.db = dbPool;
    this.culturalFilter = new CulturalContentFilter(dbPool);
  }

  /**
   * 多文化敏感内容审核
   */
  async moderateUserContent(content, language, regionCode) {
    // 1. 基础脏词过滤（已有）
    const basicCheck = await this.checkProfanity(content, language);
    if (!basicCheck.passed) {
      return basicCheck;
    }

    // 2. 文化敏感词检查
    const culturalCheck = await this.checkCulturalSensitivity(content, language);
    if (!culturalCheck.passed) {
      return culturalCheck;
    }

    // 3. 政治敏感内容检测（特定地区）
    if (['CN', 'HK', 'MO'].includes(regionCode)) {
      const politicalCheck = await this.checkPoliticalSensitivity(content, language);
      if (!politicalCheck.passed) {
        return politicalCheck;
      }
    }

    // 4. 宗教敏感内容检测（中东地区）
    if (['SA', 'AE', 'KW', 'QA', 'BH', 'OM'].includes(regionCode)) {
      const religiousCheck = await this.checkReligiousSensitivity(content, language);
      if (!religiousCheck.passed) {
        return religiousCheck;
      }
    }

    return { passed: true };
  }

  /**
   * 文化敏感词检查
   */
  async checkCulturalSensitivity(content, language) {
    const { rows } = await this.db.query(`
      SELECT word, sensitivity_type, cultural_context, action
      FROM cultural_sensitive_words
      WHERE language = $1 OR language = 'all'
    `, [language]);

    const detected = [];
    const lowerContent = content.toLowerCase();

    for (const row of rows) {
      if (lowerContent.includes(row.word.toLowerCase())) {
        detected.push({
          word: row.word,
          type: row.sensitivity_type,
          context: row.cultural_context,
          action: row.action
        });
      }
    }

    if (detected.length > 0) {
      const shouldReject = detected.some(d => d.action === 'reject');
      return {
        passed: false,
        reason: shouldReject ? 'cultural_sensitivity_violation' : 'cultural_review_required',
        detected: detected,
        action: shouldReject ? 'reject' : 'manual_review'
      };
    }

    return { passed: true };
  }
}

module.exports = ContentModerator;
```

### 4.5 Admin Dashboard 管理界面

新增文化内容管理页面：

- **文化规则列表**：按地区、实体类型筛选
- **实体限制配置**：设置精灵/道具的地区限制
- **年龄分级管理**：为内容设置各分级系统的评级
- **合规规则配置**：设置各地区的支付、游玩时间限制
- **敏感词库管理**：添加/编辑文化敏感词

### 4.6 API 设计

```
GET /api/v2/content/filter?region={regionCode}&type={entityType}
Response: {
  "blocked_entities": [25, 39],
  "modified_entities": {
    "52": { "name": "Alternative Name", "reason": "cultural_adaptation" }
  },
  "age_gated_entities": [150]
}

POST /api/admin/cultural/rules
Body: {
  "entity_type": "pokemon",
  "entity_id": 39,
  "sensitivity_level": "high",
  "cultural_context": "religion",
  "affected_regions": ["SA", "AE", "KW"],
  "restriction_type": "hide",
  "alternative_content": null
}

GET /api/v2/compliance/check?type=payment&region={regionCode}&userId={userId}&amount={amount}
Response: {
  "allowed": false,
  "reason": "exceeds_monthly_limit",
  "remaining": 500
}
```

## 5. 验收标准（可测试）

- [ ] 数据库表创建成功，包含所有索引和约束
- [ ] `CulturalContentFilter.filterEntities()` 能根据地区正确过滤精灵列表
- [ ] 中国地区用户无法看到被标记为 `blocked` 的敏感精灵
- [ ] 中东地区精灵名称自动替换为替代版本
- [ ] 年龄分级检查正确：未满 12 岁用户无法看到 PEGI 12+ 内容
- [ ] 中国地区支付限额检查生效：未成年人单次支付超过限额被拒绝
- [ ] 夜间游玩限制生效：22:00-08:00 未成年人无法登录
- [ ] 用户昵称包含文化敏感词时被拒绝或进入人工审核
- [ ] Admin Dashboard 可配置文化规则、地区限制、年龄分级
- [ ] 合规规则 API 返回正确的支付/游玩时间限制状态
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L - 大型工作量**
- 数据库表设计 + 索引：2 小时
- CulturalContentFilter 服务：4 小时
- ComplianceRuleEngine 引擎：3 小时
- 用户内容审核扩展：2 小时
- Admin Dashboard 管理界面：4 小时
- API 路由 + 集成：2 小时
- 合规规则数据初始化：2 小时
- 单元测试：3 小时

总计约 22 小时，需 3 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **合规必需**：全球化游戏必须遵守各地区法律法规，否则面临下架风险
2. **文化风险规避**：文化敏感内容可能引发公关危机，影响品牌形象
3. **用户信任保护**：年龄分级、支付限制保护未成年人，提升家长信任
4. **成熟度评分提升**：完成后"国际化/本地化"维度从 5 分提升至 9 分
5. **当前缺口严重**：系统完全没有文化适配层，是国际化的重大缺失

此需求是游戏全球化运营的基础设施，应在产品正式国际化部署前完成。
