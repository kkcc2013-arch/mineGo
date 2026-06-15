# REQ-00218: 游戏客户端截图内容安全审核系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00218 |
| 标题 | 游戏客户端截图内容安全审核系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、user-service、backend/shared/contentSafety.js |
| 创建时间 | 2026-06-15 01:00 |
| 依赖需求 | REQ-00153（游戏内截图分享与社交传播系统，已完成） |

## 需求描述

### 背景与问题

mineGo 项目已在 REQ-00153 中实现截图分享功能，允许玩家截取游戏画面并分享到社交媒体。然而，当前实现存在以下安全隐患：

1. **用户生成内容（UGC）风险**：玩家可能在截图中包含不当内容，如：
   - 利用游戏内文字系统生成侮辱性、仇恨言论内容
   - 通过修改客户端显示不雅图片或违规信息
   - 利用精灵昵称系统创建违规名称并截图传播

2. **品牌声誉风险**：违规截图一旦通过官方分享功能传播，可能：
   - 损害游戏品牌形象
   - 触发应用商店下架风险
   - 引发法律合规问题（如涉及未成年人保护）

3. **缺乏审核机制**：当前分享流程直接上传，无任何内容安全检测环节

### 目标

实现游戏客户端截图内容安全审核系统，达成以下目标：

1. **实时审核**：在截图分享前自动进行内容安全审核，审核通过后方可分享
2. **多维检测**：支持文字 OCR、图像识别、敏感词过滤等多种检测手段
3. **合规保障**：符合《网络安全法》《未成年人保护法》等法规要求
4. **用户友好**：审核过程透明，审核失败提供明确反馈和申诉渠道

### 范围

**包含**：
- 截图上传预处理与审核流程
- 文字内容 OCR 提取与敏感词检测
- 图像内容安全识别（暴力、色情、政治敏感）
- 审核结果缓存与性能优化
- 用户申诉与人工复审机制
- Prometheus 监控指标

**不包含**：
- 第三方内容审核服务商深度集成（保留接口抽象层）
- 实时视频流审核
- 语音内容审核

## 技术方案

### 1. 架构设计

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│  game-client │───▶│   gateway    │───▶│ contentSafety   │
│  (截图)      │    │  /api/share  │    │   服务模块      │
└─────────────┘    └──────────────┘    └─────────────────┘
                           │                    │
                           ▼                    ▼
                   ┌──────────────┐    ┌─────────────────┐
                   │  user-service │    │  第三方审核 API │
                   │  (申诉管理)   │    │  (可插拔适配器) │
                   └──────────────┘    └─────────────────┘
```

### 2. 核心模块实现

#### 2.1 内容审核中间件

```javascript
// backend/shared/contentSafety.js
class ContentSafetyService {
  constructor(options = {}) {
    this.providers = options.providers || [];
    this.cache = new Map(); // 审核结果缓存
    this.cacheTTL = options.cacheTTL || 3600000; // 1小时
    this.sensitiveWords = new Set(); // 敏感词库
  }

  /**
   * 审核截图内容
   * @param {Buffer} imageBuffer - 图片 Buffer
   * @param {Object} metadata - 元数据（用户ID、截图时间等）
   * @returns {Promise<{approved: boolean, reasons: string[], appealId?: string}>}
   */
  async auditScreenshot(imageBuffer, metadata) {
    const cacheKey = this.generateCacheKey(imageBuffer);
    
    // 检查缓存
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const results = {
      approved: true,
      reasons: [],
      scores: {}
    };

    // 1. OCR 文字提取与敏感词检测
    const ocrResult = await this.extractText(imageBuffer);
    if (ocrResult.text) {
      const wordCheck = this.checkSensitiveWords(ocrResult.text);
      if (wordCheck.found) {
        results.approved = false;
        results.reasons.push(`检测到敏感词: ${wordCheck.words.join(', ')}`);
        results.scores.sensitiveWords = wordCheck.score;
      }
    }

    // 2. 图像内容安全检测
    for (const provider of this.providers) {
      const imageResult = await provider.analyze(imageBuffer);
      results.scores[provider.name] = imageResult.score;
      
      if (imageResult.score > provider.threshold) {
        results.approved = false;
        results.reasons.push(`${provider.name}: ${imageResult.label}`);
      }
    }

    // 3. 缓存结果
    this.cache.set(cacheKey, results);
    setTimeout(() => this.cache.delete(cacheKey), this.cacheTTL);

    // 4. 审核未通过时生成申诉ID
    if (!results.approved) {
      results.appealId = await this.createAppealRecord(imageBuffer, metadata, results);
    }

    return results;
  }

  /**
   * 敏感词检测
   */
  checkSensitiveWords(text) {
    const found = [];
    for (const word of this.sensitiveWords) {
      if (text.includes(word)) {
        found.push(word);
      }
    }
    return {
      found: found.length > 0,
      words: found,
      score: found.length * 10
    };
  }
}
```

#### 2.2 第三方审核服务适配器

```javascript
// backend/shared/contentSafety/adapters/BaseAdapter.js
class BaseContentSafetyAdapter {
  constructor(config) {
    this.name = config.name;
    this.threshold = config.threshold || 0.8;
  }

  async analyze(imageBuffer) {
    throw new Error('Must implement analyze method');
  }
}

// backend/shared/contentSafety/adapters/AliyunGreenAdapter.js
class AliyunGreenAdapter extends BaseContentSafetyAdapter {
  constructor(config) {
    super(config);
    this.client = new GreenClient(config.accessKeyId, config.accessKeySecret);
  }

  async analyze(imageBuffer) {
    const response = await this.client.imageSyncScan({
      scenes: ['porn', 'terrorism', 'ad', 'live'],
      tasks: [{
        dataId: uuidv4(),
        image: imageBuffer.toString('base64')
      }]
    });

    const result = response.data[0];
    return {
      label: result.label,
      score: result.rate,
      suggestion: result.suggestion // pass, review, block
    };
  }
}
```

#### 2.3 Gateway API 端点

```javascript
// backend/services/gateway/src/routes/share.js
router.post('/screenshot', 
  authMiddleware,
  rateLimit({ windowMs: 60000, max: 10 }), // 每分钟最多10次
  upload.single('screenshot'),
  async (req, res) => {
    const { user } = req;
    const screenshot = req.file.buffer;

    // 内容审核
    const auditResult = await contentSafety.auditScreenshot(screenshot, {
      userId: user.id,
      timestamp: Date.now()
    });

    if (!auditResult.approved) {
      return res.status(400).json({
        code: 'CONTENT_REJECTED',
        message: '截图内容审核未通过',
        reasons: auditResult.reasons,
        appealId: auditResult.appealId
      });
    }

    // 审核通过，继续分享流程
    const shareUrl = await shareService.upload(screenshot, user.id);
    
    res.json({
      code: 'SUCCESS',
      shareUrl,
      auditId: auditResult.id
    });
  }
);
```

#### 2.4 用户申诉系统

```javascript
// backend/services/user-service/src/routes/appeal.js
router.post('/content-appeal', 
  authMiddleware,
  async (req, res) => {
    const { appealId, reason } = req.body;
    
    // 创建申诉记录
    const appeal = await appealModel.create({
      id: uuidv4(),
      appealId,
      userId: req.user.id,
      reason,
      status: 'pending',
      createdAt: new Date()
    });

    // 通知管理员
    await notificationService.notifyAdmin({
      type: 'content_appeal',
      appealId: appeal.id
    });

    res.json({
      code: 'SUCCESS',
      message: '申诉已提交，将在3个工作日内处理',
      appealId: appeal.id
    });
  }
);

// 管理员审核接口
router.post('/admin/appeal/:id/review',
  adminAuthMiddleware,
  async (req, res) => {
    const { id } = req.params;
    const { approved, adminNote } = req.body;

    const appeal = await appealModel.update(id, {
      status: approved ? 'approved' : 'rejected',
      adminNote,
      reviewedAt: new Date(),
      reviewerId: req.admin.id
    });

    // 通知用户
    await notificationService.notifyUser(appeal.userId, {
      type: 'appeal_result',
      approved,
      message: approved ? '您的申诉已通过' : `申诉被拒绝: ${adminNote}`
    });

    res.json({ code: 'SUCCESS', appeal });
  }
);
```

### 3. 客户端集成

```javascript
// game-client/src/share/ScreenshotShare.js
class ScreenshotShare {
  async share(canvas) {
    // 1. 生成截图
    const blob = await this.captureCanvas(canvas);
    
    // 2. 显示上传提示
    this.showUploadingIndicator();

    // 3. 提交审核
    const formData = new FormData();
    formData.append('screenshot', blob, 'screenshot.png');

    const response = await fetch('/api/share/screenshot', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: formData
    });

    const result = await response.json();

    if (result.code === 'CONTENT_REJECTED') {
      // 显示审核失败原因和申诉入口
      this.showAuditFailedDialog(result);
      return;
    }

    // 分享成功
    this.showShareSuccessDialog(result.shareUrl);
  }

  showAuditFailedDialog(result) {
    const dialog = new Dialog({
      title: '分享审核未通过',
      content: `
        <p>您的截图未能通过内容安全审核。</p>
        <p>原因：${result.reasons.join('、')}</p>
        <p>如有异议，可点击下方按钮申诉。</p>
      `,
      buttons: [
        { text: '取消', action: 'close' },
        { text: '提交申诉', action: 'appeal', primary: true }
      ]
    });

    dialog.onAction('appeal', () => {
      this.openAppealForm(result.appealId);
    });

    dialog.show();
  }
}
```

### 4. 数据库迁移

```sql
-- backend/database/migrations/20260615010000_content_safety_tables.sql

-- 内容审核记录表
CREATE TABLE content_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  image_hash VARCHAR(64) NOT NULL,
  approved BOOLEAN NOT NULL,
  reasons TEXT[],
  scores JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_created (user_id, created_at),
  INDEX idx_approved (approved)
);

-- 申诉记录表
CREATE TABLE content_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_log_id UUID NOT NULL REFERENCES content_audit_logs(id),
  user_id UUID NOT NULL REFERENCES users(id),
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  admin_note TEXT,
  reviewer_id UUID REFERENCES admins(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  INDEX idx_status (status),
  INDEX idx_user (user_id)
);

-- 敏感词库表
CREATE TABLE sensitive_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word VARCHAR(100) NOT NULL UNIQUE,
  category VARCHAR(50), -- violence, adult, politics, etc.
  severity INTEGER DEFAULT 1, -- 1-10
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_word (word)
);

-- 插入默认敏感词
INSERT INTO sensitive_words (word, category, severity) VALUES
  ('敏感词1', 'politics', 10),
  ('敏感词2', 'violence', 8),
  ('敏感词3', 'adult', 9);
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics/contentSafetyMetrics.js
const contentSafetyMetrics = {
  // 审核请求总数
  auditRequestsTotal: new Counter({
    name: 'content_audit_requests_total',
    help: 'Total content audit requests',
    labelNames: ['status'] // approved, rejected, error
  }),

  // 审核耗时
  auditDurationMs: new Histogram({
    name: 'content_audit_duration_ms',
    help: 'Content audit duration in milliseconds',
    labelNames: ['provider'],
    buckets: [100, 500, 1000, 2000, 5000]
  }),

  // 缓存命中率
  cacheHitRate: new Gauge({
    name: 'content_audit_cache_hit_rate',
    help: 'Content audit cache hit rate'
  }),

  // 敏感词命中数
  sensitiveWordHits: new Counter({
    name: 'content_sensitive_word_hits_total',
    help: 'Total sensitive word hits',
    labelNames: ['category']
  }),

  // 申诉统计
  appealsTotal: new Counter({
    name: 'content_appeals_total',
    help: 'Total content appeals',
    labelNames: ['status'] // pending, approved, rejected
  })
};
```

### 6. 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `CONTENT_SAFETY_ENABLED` | true | 是否启用内容审核 |
| `CONTENT_SAFETY_CACHE_TTL` | 3600000 | 审核结果缓存TTL（毫秒）|
| `CONTENT_SAFETY_TIMEOUT` | 5000 | 审核超时时间（毫秒）|
| `CONTENT_SAFETY_SENSITIVE_THRESHOLD` | 0.8 | 敏感内容阈值 |
| `CONTENT_SAFETY_APPEAL_DEADLINE_DAYS` | 3 | 申诉处理时限（天）|
| `ALIYUN_GREEN_ACCESS_KEY` | - | 阿里云绿网 AccessKey |
| `ALIYUN_GREEN_ACCESS_SECRET` | - | 阿里云绿网 AccessSecret |

## 验收标准

- [ ] 单元测试：敏感词检测模块正确识别测试敏感词
- [ ] 单元测试：审核结果缓存机制正常工作
- [ ] 集成测试：上传包含敏感词的截图，返回审核失败响应
- [ ] 集成测试：上传正常截图，审核通过并返回分享链接
- [ ] 集成测试：用户申诉流程完整可用
- [ ] E2E测试：客户端分享流程中审核失败时显示申诉入口
- [ ] 性能测试：审核接口 P99 延迟 < 2秒
- [ ] 监控验证：Prometheus 指标正确上报
- [ ] 合规验证：审核日志保留时长满足法规要求

## 影响范围

- `game-client/src/share/`：新增审核失败处理逻辑
- `backend/services/gateway/src/routes/share.js`：集成内容审核中间件
- `backend/shared/contentSafety/`：新增内容审核核心模块
- `backend/services/user-service/src/routes/appeal.js`：新增申诉管理接口
- `database/migrations/`：新增审核相关数据表

## 参考

- [阿里云内容安全 API 文档](https://help.aliyun.com/document_detail/28427.html)
- [腾讯云天御内容审核](https://cloud.tencent.com/product/cms)
- 《网络安全法》第二十一条：网络运营者应当要求用户提供真实身份信息
- 《未成年人保护法》第七十四条：网络产品和服务提供者不得向未成年人提供诱导其沉迷的产品和服务

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 第三方审核服务不可用 | 用户无法分享截图 | 实现本地基础审核作为降级方案 |
| 审核误判 | 用户投诉 | 提供明确的申诉渠道和快速响应机制 |
| 审核延迟影响用户体验 | 用户流失 | 异步审核+缓存优化，P99 < 2秒 |
| 敏感词库过时 | 审核失效 | 定期更新敏感词库，支持热更新 |
