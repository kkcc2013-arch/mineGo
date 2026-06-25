# REQ-00322：Cookie 同意管理与隐私偏好中心

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00322 |
| 标题 | Cookie 同意管理与隐私偏好中心 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、game-client、admin-dashboard、backend/shared、database/migrations |
| 创建时间 | 2026-06-25 00:01 UTC |
| 依赖需求 | REQ-00016（GDPR 合规与用户数据隐私保护）、REQ-00305（GDPR 数据主体权利请求自动化管理系统） |

## 1. 背景与问题

根据 GDPR、CCPA、PIPL 等隐私法规要求，网站和应用必须：

1. **在首次访问时获取用户对 Cookie 的明确同意**
2. **提供细粒度的 Cookie 类别选择**（必要、分析、营销、功能性）
3. **允许用户随时修改隐私偏好**
4. **记录和存储用户的同意历史**
5. **根据用户选择动态加载第三方脚本和追踪工具**

当前项目存在的问题：
- 缺少 Cookie 同意横幅和偏好管理界面
- 无法记录用户的同意状态和选择历史
- 第三方分析工具（如 Google Analytics）在用户拒绝后仍会加载
- 缺少隐私偏好中心页面供用户管理数据使用权限
- 无法满足 GDPR "隐私设计"（Privacy by Design）原则

## 2. 目标

构建完整的 Cookie 同意管理与隐私偏好系统：

- 符合 GDPR、CCPA、PIPL 等主要隐私法规要求
- 提供用户友好的同意横幅和偏好中心界面
- 支持细粒度 Cookie 类别管理（4-6 个类别）
- 记录完整的同意历史，支持审计需求
- 动态控制第三方脚本加载，尊重用户选择
- 集成到现有用户偏好系统，提供 API 接口

## 3. 范围

### 包含
- Cookie 同意横幅组件（game-client 和 admin-dashboard）
- 隐私偏好中心页面
- 同意状态存储和查询 API（user-service）
- 同意历史记录和审计日志
- 第三方脚本动态加载控制器
- 管理后台同意统计仪表板
- 数据库表结构和迁移脚本

### 不包含
- 跨域 Cookie 同步（需独立需求）
- 隐私影响评估自动化（REQ-00309 已规划）
- 数据主体权利请求处理（REQ-00305 已规划）

## 4. 详细需求

### 4.1 Cookie 类别定义

系统支持以下 Cookie 类别：

| 类别 | 必要性 | 说明 | 示例 |
|------|--------|------|------|
| `necessary` | 必需 | 网站基本功能，无法禁用 | 会话 token、安全 cookie |
| `functional` | 可选 | 增强功能，如语言偏好 | 语言设置、主题偏好 |
| `analytics` | 可选 | 匿名统计数据收集 | Google Analytics、Matomo |
| `marketing` | 可选 | 广告和营销追踪 | Facebook Pixel、广告追踪 |
| `social` | 可选 | 社交媒体集成 | 社交分享、嵌入式内容 |
| `performance` | 可选 | 性能监控和优化 | Sentry、性能追踪工具 |

### 4.2 数据模型

```sql
-- Cookie 同意记录表
CREATE TABLE cookie_consents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(255),  -- 匿名用户设备标识
    consent_version VARCHAR(20) NOT NULL DEFAULT '1.0',
    
    -- 同意状态（JSON 格式）
    categories JSONB NOT NULL DEFAULT '{}',
    
    -- 元数据
    ip_address VARCHAR(45),
    user_agent TEXT,
    country_code VARCHAR(3),
    
    -- 时间戳
    consented_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    
    -- 来源
    source VARCHAR(20) DEFAULT 'banner',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cookie_consents_user ON cookie_consents(user_id, consented_at DESC);
CREATE INDEX idx_cookie_consents_device ON cookie_consents(device_id, consented_at DESC);

-- 同意历史审计表
CREATE TABLE cookie_consent_audit_logs (
    id SERIAL PRIMARY KEY,
    consent_id INTEGER REFERENCES cookie_consents(id) ON DELETE CASCADE,
    user_id INTEGER,
    device_id VARCHAR(255),
    action VARCHAR(20) NOT NULL,
    previous_categories JSONB,
    new_categories JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Cookie 定义表（管理后台配置）
CREATE TABLE cookie_definitions (
    id SERIAL PRIMARY KEY,
    category VARCHAR(20) NOT NULL,
    name VARCHAR(100) NOT NULL,
    provider VARCHAR(100),
    description TEXT NOT NULL,
    purpose TEXT,
    duration VARCHAR(50),
    third_party BOOLEAN DEFAULT false,
    script_url TEXT,
    script_type VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, name)
);

-- 隐私偏好表
CREATE TABLE privacy_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    allow_personalization BOOLEAN DEFAULT true,
    allow_third_party_sharing BOOLEAN DEFAULT false,
    allow_analytics BOOLEAN DEFAULT true,
    allow_marketing BOOLEAN DEFAULT false,
    allow_email_notifications BOOLEAN DEFAULT true,
    allow_push_notifications BOOLEAN DEFAULT true,
    allow_in_game_messages BOOLEAN DEFAULT true,
    data_retention_preference VARCHAR(20) DEFAULT 'standard',
    do_not_track BOOLEAN DEFAULT false,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 4.3 API 接口设计

```javascript
// POST /api/v1/privacy/consent - 提交同意
// GET /api/v1/privacy/consent - 获取当前同意状态
// PUT /api/v1/privacy/consent - 更新同意
// POST /api/v1/privacy/consent/withdraw - 撤回同意
// GET /api/v1/privacy/consent/history - 获取历史记录

// GET /api/v1/privacy/preferences - 获取隐私偏好
// PUT /api/v1/privacy/preferences - 更新隐私偏好

// GET /api/v1/admin/privacy/consents/stats - 管理后台统计
// GET/POST/PUT/DELETE /api/v1/admin/privacy/cookie-definitions - Cookie 定义管理
```

### 4.4 前端组件

#### Cookie 同意横幅
- 首次访问时显示
- 包含"接受所有"、"仅必要"、"管理偏好"三个按钮
- 支持深色/浅色主题

#### 隐私偏好中心
- 显示所有 Cookie 类别及说明
- 每个类别可独立开关（necessary 除外）
- 集成数据删除请求入口

#### 第三方脚本控制器
- 根据同意状态动态加载脚本
- 支持 Google Tag Manager 同意模式
- 用户拒绝后禁用追踪

## 5. 验收标准

- [ ] Cookie 同意横幅在首次访问时正确显示
- [ ] 点击"接受所有"后，所有类别同意被记录到数据库
- [ ] 用户拒绝 analytics 后，Google Analytics 不加载
- [ ] 同意过期后，横幅重新显示
- [ ] 隐私偏好中心正确加载和保存用户偏好
- [ ] 所有同意操作记录到审计日志
- [ ] 管理后台统计仪表板显示正确数据

## 6. 工作量估算

**规模：L**

**理由：**
- 需要设计并实现完整的前后端系统
- 涉及多个数据表和 API 接口
- 需要实现第三方脚本动态加载控制器
- 需要集成到现有用户服务和中间件
- 预计开发时间：3-5 天

## 7. 优先级理由

P1 - 符合隐私法规要求是项目上线的前提条件，缺少 Cookie 同意系统将面临：
- GDPR 罚款风险（最高全球营业额 4%）
- CCPA 合规风险
- 用户信任度下降

该需求是 REQ-00016（GDPR 合规）和 REQ-00305（GDPR 数据主体权利）的重要补充，完善了隐私合规体系。
