# REQ-00188：用户语言偏好持久化与跨设备同步系统

- **编号**：REQ-00188
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、gateway、game-client、database/migrations、backend/shared/i18n.js
- **创建时间**：2026-06-14 08:05
- **依赖需求**：REQ-00011（多语言国际化支持）、REQ-00167（游戏内容本地化数据层）

## 1. 背景与问题

当前 mineGo 项目的语言偏好设置存在以下问题：

1. **仅客户端存储**：语言偏好仅存储在浏览器 localStorage 中，用户更换设备或清除浏览器数据后语言设置丢失
2. **无跨设备同步**：用户在手机设置中文后，在平板或电脑上仍显示默认语言，体验不一致
3. **数据库缺失字段**：users 表没有 `language_preference` 字段，无法持久化用户语言偏好
4. **服务端未利用偏好**：`i18n.js` 中间件虽然支持 `req.user.language_preference`，但该字段从未被设置
5. **无语言切换审计**：语言偏好变更没有审计日志，无法追溯用户设置变更历史

经代码审查：
- `frontend/game-client/src/i18n/index.js` 仅使用 localStorage 存储语言
- `backend/shared/i18n.js` 的 `getLanguageFromRequest()` 优先检查 `req.user.language_preference`，但数据库无此字段
- `users` 表结构中没有语言相关字段

## 2. 目标

1. 在数据库层面添加用户语言偏好字段，实现持久化存储
2. 提供语言偏好设置 API，支持用户主动切换语言
3. 实现跨设备语言同步，用户登录后自动应用已保存的语言偏好
4. 记录语言偏好变更审计日志，支持合规审计
5. 优化客户端语言检测逻辑，优先使用服务端偏好设置

## 3. 范围

### 包含

- 数据库迁移：users 表添加 language_preference 字段
- user-service 语言偏好设置 API
- gateway 语言偏好中间件优化
- game-client 语言偏好同步模块
- 语言偏好变更审计日志
- 单元测试与集成测试

### 不包含

- 语言偏好推荐算法（基于地区自动推荐）
- 批量用户语言偏好迁移工具
- 语言偏好统计分析仪表板

## 4. 详细需求

### 4.1 数据库迁移

```sql
-- database/pending/20260614_080500__add_user_language_preference.sql

-- 添加用户语言偏好字段
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS language_preference VARCHAR(10) DEFAULT 'zh-CN'
    CHECK (language_preference IN ('zh-CN', 'en-US', 'ja-JP')),
  ADD COLUMN IF NOT EXISTS language_preference_updated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS language_preference_updated_by VARCHAR(20) DEFAULT 'user'
    CHECK (language_preference_updated_by IN ('user', 'system', 'admin'));

-- 创建索引用于语言偏好统计
CREATE INDEX IF NOT EXISTS idx_users_language_pref 
  ON users(language_preference) WHERE language_preference IS NOT NULL;

-- 添加字段注释
COMMENT ON COLUMN users.language_preference IS '用户界面语言偏好：zh-CN(简体中文), en-US(English), ja-JP(日本語)';
COMMENT ON COLUMN users.language_preference_updated_at IS '语言偏好最后更新时间';
COMMENT ON COLUMN users.language_preference_updated_by IS '语言偏好更新来源：user(用户主动), system(系统自动), admin(管理员设置)';

-- 创建语言偏好变更审计表
CREATE TABLE IF NOT EXISTS language_preference_audit (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_language VARCHAR(10),
  new_language VARCHAR(10) NOT NULL,
  changed_by VARCHAR(20) NOT NULL,
  device_info JSONB,              -- {userAgent, platform, deviceId}
  ip_address INET,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lang_audit_user 
  ON language_preference_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lang_audit_time 
  ON language_preference_audit(created_at DESC);

COMMENT ON TABLE language_preference_audit IS '用户语言偏好变更审计日志';
```

### 4.2 user-service 语言偏好 API

```javascript
// backend/services/user-service/src/routes/language.js
'use strict';

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../../shared/logger');
const { auditLog } = require('../../../shared/auditLog');

const logger = createLogger('user-language');

/**
 * GET /api/user/language
 * 获取当前用户语言偏好
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await req.db.query(`
      SELECT language_preference, language_preference_updated_at
      FROM users WHERE id = $1
    `, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'USER_NOT_FOUND' }
      });
    }
    
    res.json({
      success: true,
      data: {
        language: result.rows[0].language_preference,
        updatedAt: result.rows[0].language_preference_updated_at
      }
    });
  } catch (err) {
    logger.error('Failed to get language preference', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR' }
    });
  }
});

/**
 * PUT /api/user/language
 * 更新用户语言偏好
 */
router.put('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { language, deviceId } = req.body;
    
    // 验证语言代码
    const supportedLanguages = ['zh-CN', 'en-US', 'ja-JP'];
    if (!supportedLanguages.includes(language)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_LANGUAGE', supported: supportedLanguages }
      });
    }
    
    // 获取当前语言偏好
    const currentResult = await req.db.query(`
      SELECT language_preference FROM users WHERE id = $1
    `, [userId]);
    
    const oldLanguage = currentResult.rows[0]?.language_preference;
    
    // 如果语言相同，直接返回成功
    if (oldLanguage === language) {
      return res.json({
        success: true,
        data: { language, unchanged: true }
      });
    }
    
    // 更新语言偏好
    await req.db.query(`
      UPDATE users 
      SET language_preference = $1,
          language_preference_updated_at = NOW(),
          language_preference_updated_by = 'user'
      WHERE id = $2
    `, [language, userId]);
    
    // 记录审计日志
    await req.db.query(`
      INSERT INTO language_preference_audit 
        (user_id, old_language, new_language, changed_by, device_info, ip_address)
      VALUES ($1, $2, $3, 'user', $4, $5)
    `, [
      userId,
      oldLanguage,
      language,
      JSON.stringify({
        userAgent: req.headers['user-agent'],
        deviceId: deviceId || null
      }),
      req.ip
    ]);
    
    // 发送审计事件
    await auditLog({
      userId,
      action: 'LANGUAGE_PREFERENCE_CHANGED',
      details: { from: oldLanguage, to: language },
      serviceName: 'user-service'
    });
    
    logger.info('Language preference updated', {
      userId,
      from: oldLanguage,
      to: language
    });
    
    res.json({
      success: true,
      data: {
        language,
        previousLanguage: oldLanguage,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error('Failed to update language preference', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR' }
    });
  }
});

/**
 * POST /api/user/language/sync
 * 同步客户端语言偏好（登录后调用）
 * 如果服务端有偏好，返回服务端偏好；否则将客户端偏好保存到服务端
 */
router.post('/sync', async (req, res) => {
  try {
    const userId = req.user.id;
    const { clientLanguage, deviceId } = req.body;
    
    // 获取服务端语言偏好
    const result = await req.db.query(`
      SELECT language_preference, language_preference_updated_at
      FROM users WHERE id = $1
    `, [userId]);
    
    const serverLanguage = result.rows[0]?.language_preference;
    const serverUpdatedAt = result.rows[0]?.language_preference_updated_at;
    
    // 如果服务端有偏好，返回服务端偏好
    if (serverLanguage) {
      return res.json({
        success: true,
        data: {
          language: serverLanguage,
          source: 'server',
          updatedAt: serverUpdatedAt
        }
      });
    }
    
    // 服务端无偏好，保存客户端偏好
    const supportedLanguages = ['zh-CN', 'en-US', 'ja-JP'];
    const languageToSave = supportedLanguages.includes(clientLanguage) 
      ? clientLanguage 
      : 'zh-CN';
    
    await req.db.query(`
      UPDATE users 
      SET language_preference = $1,
          language_preference_updated_at = NOW(),
          language_preference_updated_by = 'system'
      WHERE id = $2
    `, [languageToSave, userId]);
    
    // 记录审计日志
    await req.db.query(`
      INSERT INTO language_preference_audit 
        (user_id, old_language, new_language, changed_by, device_info, ip_address)
      VALUES ($1, NULL, $2, 'system', $3, $4)
    `, [
      userId,
      languageToSave,
      JSON.stringify({
        userAgent: req.headers['user-agent'],
        deviceId: deviceId || null,
        detectedLanguage: clientLanguage
      }),
      req.ip
    ]);
    
    logger.info('Language preference synced from client', {
      userId,
      language: languageToSave
    });
    
    res.json({
      success: true,
      data: {
        language: languageToSave,
        source: 'client',
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error('Failed to sync language preference', { error: err.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR' }
    });
  }
});

module.exports = router;
```

### 4.3 game-client 语言同步模块

```javascript
// frontend/game-client/src/i18n/languageSync.js
'use strict';

import i18n from './index.js';
import { apiClient } from '../api/index.js';

const LANGUAGE_SYNC_KEY = 'pmg_language_synced';
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24小时

/**
 * 语言偏好同步管理器
 */
class LanguageSyncManager {
  constructor() {
    this.isSynced = false;
    this.lastSyncTime = null;
  }

  /**
   * 登录后同步语言偏好
   * 优先使用服务端偏好，实现跨设备同步
   */
  async syncOnLogin() {
    try {
      const clientLanguage = i18n.getCurrentLanguage();
      
      const response = await apiClient.post('/api/user/language/sync', {
        clientLanguage,
        deviceId: this.getDeviceId()
      });

      if (response.success && response.data) {
        const { language, source } = response.data;
        
        // 如果服务端有偏好，应用到客户端
        if (source === 'server' && language !== clientLanguage) {
          await i18n.changeLanguage(language);
          console.log(`[LanguageSync] Applied server language: ${language}`);
        }
        
        this.isSynced = true;
        this.lastSyncTime = Date.now();
        localStorage.setItem(LANGUAGE_SYNC_KEY, JSON.stringify({
          synced: true,
          time: this.lastSyncTime,
          language
        }));
        
        return { success: true, language, source };
      }
    } catch (err) {
      console.warn('[LanguageSync] Sync failed:', err);
    }
    
    return { success: false };
  }

  /**
   * 用户切换语言时同步到服务端
   */
  async syncLanguageChange(newLanguage) {
    try {
      const response = await apiClient.put('/api/user/language', {
        language: newLanguage,
        deviceId: this.getDeviceId()
      });

      if (response.success) {
        this.lastSyncTime = Date.now();
        console.log(`[LanguageSync] Language synced to server: ${newLanguage}`);
        return true;
      }
    } catch (err) {
      console.warn('[LanguageSync] Failed to sync language change:', err);
    }
    
    return false;
  }

  /**
   * 检查是否需要重新同步
   */
  needsSync() {
    const stored = localStorage.getItem(LANGUAGE_SYNC_KEY);
    if (!stored) return true;
    
    try {
      const { synced, time } = JSON.parse(stored);
      if (!synced) return true;
      
      // 超过24小时需要重新同步
      if (Date.now() - time > SYNC_INTERVAL_MS) return true;
      
      return false;
    } catch {
      return true;
    }
  }

  /**
   * 获取设备ID（用于审计）
   */
  getDeviceId() {
    let deviceId = localStorage.getItem('pmg_device_id');
    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('pmg_device_id', deviceId);
    }
    return deviceId;
  }
}

export const languageSync = new LanguageSyncManager();
export default languageSync;
```

### 4.4 i18n 中间件优化

```javascript
// backend/shared/i18n.js 优化
// 在现有的 getLanguageFromRequest 函数中，确保正确使用用户的 language_preference

function getLanguageFromRequest(req) {
  // Priority: user preference in DB > header > default
  // 注意：req.user.language_preference 现在会从数据库正确获取
  
  if (req.user?.language_preference && SUPPORTED_LANGUAGES.includes(req.user.language_preference)) {
    return req.user.language_preference;
  }
  
  // ... 其他逻辑保持不变
}
```

## 5. 验收标准（可测试）

- [ ] users 表成功添加 language_preference 字段及相关字段
- [ ] language_preference_audit 表正确创建并记录变更日志
- [ ] `GET /api/user/language` 正确返回用户语言偏好
- [ ] `PUT /api/user/language` 正确更新语言偏好并记录审计日志
- [ ] `POST /api/user/language/sync` 实现服务端/客户端语言同步逻辑
- [ ] game-client 登录后自动同步语言偏好
- [ ] 用户切换语言后自动同步到服务端
- [ ] 跨设备登录时语言偏好一致
- [ ] 语言偏好变更审计日志完整记录
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M** - 需要添加数据库字段、实现 API、修改客户端同步逻辑、添加审计日志

## 7. 优先级理由

用户语言偏好持久化是国际化功能的基础完善：

1. **用户体验**：跨设备语言一致性，避免用户每次换设备都要重新设置
2. **数据完整性**：服务端存储用户偏好，支持个性化服务
3. **合规审计**：记录语言偏好变更，满足数据保护审计要求
4. **依赖解锁**：为后续基于语言的内容推荐、地区化运营提供基础

P1 优先级是因为这是国际化功能的必要完善，直接影响用户体验。
