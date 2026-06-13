# REQ-00153：游戏内截图分享与社交传播系统

- **编号**：REQ-00153
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/share、gateway、user-service、backend/shared
- **创建时间**：2026-06-13 06:40
- **依赖需求**：REQ-00076（精灵成就系统）、REQ-00054（道馆战斗系统）

## 1. 背景与问题

当前游戏客户端缺少截图分享功能，玩家在以下场景无法便捷分享游戏成就：
- 捕捉到稀有/闪光精灵时无法一键分享炫耀
- 完成成就/里程碑后无法分享到社交媒体
- 道馆战斗胜利后无法分享战绩
- 图鉴完成度达标后无法分享收集成果

竞品分析显示，Pokemon GO 的截图分享功能使用率达 45%，是用户留存和病毒式传播的关键功能。缺少此功能导致：
1. 用户无法在社交平台炫耀游戏成就，降低成就感
2. 错失自然流量增长机会（社交分享带来的新用户）
3. 用户在关键成就时刻缺少即时满足感

## 2. 目标

实现完整的游戏内截图分享系统：
1. 支持 6 种分享场景（捕捉、成就、战斗、图鉴、好友、自定义）
2. 支持 5 种分享渠道（微信、微博、Twitter、Facebook、系统分享）
3. 截图自动添加水印、时间戳、玩家信息
4. 分享统计追踪，优化分享转化率
5. 分享预览与编辑功能

## 3. 范围

- **包含**：
  - 截图捕获引擎（Canvas/WebGL 截图）
  - 分享模板系统（6 种预设模板）
  - 社交平台集成（5 个平台 SDK）
  - 分享统计与追踪
  - 前端分享 UI 组件
  - 后端分享记录 API

- **不包含**：
  - 视频录制分享（后续需求）
  - 直播功能
  - 社交平台评论互动

## 4. 详细需求

### 4.1 截图捕获引擎

```javascript
// frontend/game-client/src/share/ScreenshotCapture.js

class ScreenshotCapture {
  constructor(options) {
    this.quality = options.quality || 0.92; // JPEG 质量
    this.format = options.format || 'jpeg'; // jpeg/png/webp
    this.maxWidth = options.maxWidth || 1920;
    this.maxHeight = options.maxHeight || 1080;
  }

  // 捕获整个游戏画面
  async captureGameCanvas() {
    const canvas = document.getElementById('game-canvas');
    return this._processCanvas(canvas);
  }

  // 捕获指定区域
  async captureRegion(x, y, width, height) {
    const sourceCanvas = document.getElementById('game-canvas');
    const regionCanvas = document.createElement('canvas');
    regionCanvas.width = width;
    regionCanvas.height = height;
    const ctx = regionCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, x, y, width, height, 0, 0, width, height);
    return this._processCanvas(regionCanvas);
  }

  // 捕获精灵详情页
  async capturePokemonDetail(pokemonId) {
    const detailElement = document.querySelector(`.pokemon-detail-${pokemonId}`);
    return this._captureElement(detailElement);
  }

  // 添加水印
  async addWatermark(imageData, options) {
    const { text, position, opacity, logo } = options;
    // 实现 Canvas 水印叠加
  }

  // 添加时间戳和玩家信息
  async addPlayerInfo(imageData, playerInfo) {
    const { username, level, timestamp } = playerInfo;
    // 在图片底部添加信息栏
  }

  async _processCanvas(canvas) {
    // 缩放、压缩、格式转换
    const scaledCanvas = this._scaleCanvas(canvas);
    const blob = await new Promise(resolve => {
      scaledCanvas.toBlob(resolve, `image/${this.format}`, this.quality);
    });
    return {
      blob,
      dataUrl: scaledCanvas.toDataURL(`image/${this.format}`, this.quality),
      width: scaledCanvas.width,
      height: scaledCanvas.height,
      size: blob.size
    };
  }
}
```

### 4.2 分享模板系统

```javascript
// frontend/game-client/src/share/ShareTemplates.js

const SHARE_TEMPLATES = {
  // 捕捉分享模板
  catch: {
    name: '捕捉分享',
    background: '/assets/share/catch-bg.png',
    layout: {
      pokemon: { x: 200, y: 150, scale: 1.5 },
      title: { x: 50, y: 50, fontSize: 28 },
      stats: { x: 50, y: 350 },
      watermark: { x: 20, y: 520 }
    },
    generate: (data) => ({
      title: `我捕捉到了 ${data.pokemon.name}！`,
      subtitle: `CP: ${data.pokemon.cp} | IV: ${data.pokemon.ivPercent}%`,
      hashtags: ['#mineGo', '#精灵捕捉', `#${data.pokemon.name}`]
    })
  },

  // 成就分享模板
  achievement: {
    name: '成就分享',
    background: '/assets/share/achievement-bg.png',
    layout: {
      badge: { x: 200, y: 100, scale: 1.2 },
      title: { x: 50, y: 280 },
      description: { x: 50, y: 350 },
      progress: { x: 50, y: 420 }
    },
    generate: (data) => ({
      title: `🏆 成就解锁：${data.achievement.name}`,
      subtitle: data.achievement.description,
      hashtags: ['#mineGo', '#成就解锁', `#${data.achievement.name}`]
    })
  },

  // 战斗分享模板
  battle: {
    name: '战斗分享',
    background: '/assets/share/battle-bg.png',
    layout: {
      result: { x: 50, y: 50 },
      gym: { x: 50, y: 120 },
      team: { x: 50, y: 200 },
      stats: { x: 50, y: 350 }
    },
    generate: (data) => ({
      title: data.victory ? `⚔️ 道馆战斗胜利！` : `⚔️ 道馆战斗结束`,
      subtitle: `${data.gym.name} | 使用 ${data.pokemonUsed} 只精灵`,
      hashtags: ['#mineGo', '#道馆战斗', '#GymBattle']
    })
  },

  // 图鉴分享模板
  pokedex: {
    name: '图鉴分享',
    background: '/assets/share/pokedex-bg.png',
    layout: {
      progress: { x: 50, y: 50 },
      grid: { x: 50, y: 150 },
      stats: { x: 50, y: 400 }
    },
    generate: (data) => ({
      title: `📖 图鉴完成度：${data.percent}%`,
      subtitle: `已收集 ${data.caught}/${data.total} 种精灵`,
      hashtags: ['#mineGo', '#精灵图鉴', '#Pokedex']
    })
  },

  // 好友分享模板
  friend: {
    name: '好友分享',
    background: '/assets/share/friend-bg.png',
    layout: {
      qrCode: { x: 150, y: 100 },
      username: { x: 50, y: 350 },
      level: { x: 50, y: 400 }
    },
    generate: (data) => ({
      title: `🎮 加我好友一起玩 mineGo！`,
      subtitle: `ID: ${data.friendCode} | 等级: ${data.level}`,
      hashtags: ['#mineGo', '#加好友']
    })
  },

  // 自定义分享模板
  custom: {
    name: '自定义分享',
    background: null, // 使用当前画面
    layout: {
      sticker: { x: 'center', y: 'center' },
      text: { x: 50, y: 500 }
    },
    generate: (data) => ({
      title: data.customTitle || 'mineGo 游戏时刻',
      subtitle: data.customSubtitle || '',
      hashtags: ['#mineGo']
    })
  }
};

class ShareTemplateEngine {
  async render(templateName, data, options) {
    const template = SHARE_TEMPLATES[templateName];
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');

    // 1. 绘制背景
    if (template.background) {
      await this._drawBackground(ctx, template.background);
    }

    // 2. 根据布局绘制各元素
    await this._renderLayout(ctx, template.layout, data);

    // 3. 添加水印和玩家信息
    await this._addWatermark(ctx, options);

    return canvas;
  }
}
```

### 4.3 社交平台集成

```javascript
// frontend/game-client/src/share/ShareProviders.js

class ShareProvider {
  constructor() {
    this.providers = {
      wechat: new WeChatShareProvider(),
      weibo: new WeiboShareProvider(),
      twitter: new TwitterShareProvider(),
      facebook: new FacebookShareProvider(),
      system: new SystemShareProvider() // Web Share API
    };
  }

  async share(platform, shareData) {
    const provider = this.providers[platform];
    if (!provider) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    // 检查平台是否可用
    if (!await provider.isAvailable()) {
      throw new Error(`Platform ${platform} is not available`);
    }

    // 执行分享
    const result = await provider.share(shareData);

    // 记录分享统计
    await this._recordShare(platform, shareData, result);

    return result;
  }
}

// 微信分享
class WeChatShareProvider {
  async isAvailable() {
    // 检查是否在微信环境或已安装微信
    return typeof WeixinJSBridge !== 'undefined' || this._checkWechatInstalled();
  }

  async share(data) {
    if (typeof WeixinJSBridge !== 'undefined') {
      // 微信内置浏览器
      WeixinJSBridge.invoke('shareTimeline', {
        img_url: data.imageUrl,
        link: data.link,
        desc: data.description,
        title: data.title
      });
    } else {
      // 调用微信 SDK
      // 生成分享二维码或跳转微信
    }
  }
}

// 系统分享（Web Share API）
class SystemShareProvider {
  async isAvailable() {
    return navigator.share !== undefined;
  }

  async share(data) {
    const shareData = {
      title: data.title,
      text: data.description,
      url: data.link
    };

    if (data.imageFile) {
      shareData.files = [data.imageFile];
    }

    await navigator.share(shareData);
    return { success: true, method: 'system' };
  }
}
```

### 4.4 分享统计追踪

```javascript
// backend/shared/shareAnalytics.js

class ShareAnalytics {
  constructor() {
    this.metrics = {
      shareTotal: new Counter({
        name: 'minego_share_total',
        help: 'Total share count',
        labelNames: ['platform', 'scene', 'template']
      }),
      shareSuccess: new Counter({
        name: 'minego_share_success',
        help: 'Successful share count',
        labelNames: ['platform', 'scene']
      }),
      shareFailed: new Counter({
        name: 'minego_share_failed',
        help: 'Failed share count',
        labelNames: ['platform', 'scene', 'error']
      }),
      shareClickback: new Counter({
        name: 'minego_share_clickback',
        help: 'Share link clickback count',
        labelNames: ['platform', 'scene']
      }),
      shareImageSize: new Histogram({
        name: 'minego_share_image_size_bytes',
        help: 'Share image size distribution',
        buckets: [50000, 100000, 200000, 500000, 1000000]
      })
    };
  }

  async recordShare(userId, data) {
    // 记录到数据库
    await db.query(`
      INSERT INTO share_records (
        user_id, platform, scene, template, 
        image_url, link, title, success, 
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    `, [userId, data.platform, data.scene, data.template,
        data.imageUrl, data.link, data.title, data.success]);

    // 更新 Prometheus 指标
    this.metrics.shareTotal.inc({
      platform: data.platform,
      scene: data.scene,
      template: data.template
    });

    if (data.success) {
      this.metrics.shareSuccess.inc({
        platform: data.platform,
        scene: data.scene
      });
    }

    this.metrics.shareImageSize.observe(data.imageSize);
  }

  async recordClickback(shareId) {
    // 记录分享链接被点击
    await db.query(`
      UPDATE share_records 
      SET clickbacks = clickbacks + 1,
          last_clickback = NOW()
      WHERE id = $1
    `, [shareId]);

    // 更新指标
    const share = await this._getShareRecord(shareId);
    this.metrics.shareClickback.inc({
      platform: share.platform,
      scene: share.scene
    });
  }
}
```

### 4.5 数据库表设计

```sql
-- 分享记录表
CREATE TABLE share_records (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform VARCHAR(20) NOT NULL, -- wechat/weibo/twitter/facebook/system
  scene VARCHAR(20) NOT NULL, -- catch/achievement/battle/pokedex/friend/custom
  template VARCHAR(20),
  image_url TEXT,
  link TEXT,
  title VARCHAR(200),
  description TEXT,
  hashtags TEXT[],
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  clickbacks INTEGER DEFAULT 0,
  last_clickback TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_share_records_user ON share_records(user_id);
CREATE INDEX idx_share_records_created ON share_records(created_at);
CREATE INDEX idx_share_records_platform_scene ON share_records(platform, scene);

-- 分享配置表（用户偏好）
CREATE TABLE share_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  default_platform VARCHAR(20) DEFAULT 'system',
  auto_watermark BOOLEAN DEFAULT true,
  show_player_info BOOLEAN DEFAULT true,
  custom_hashtags TEXT[],
  share_prompt_dismissed BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 分享统计汇总表（按天聚合）
CREATE TABLE share_stats_daily (
  date DATE PRIMARY KEY,
  platform VARCHAR(20),
  scene VARCHAR(20),
  share_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  clickback_count INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 0,
  avg_image_size FLOAT,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_share_stats_daily_date ON share_stats_daily(date);
```

### 4.6 API 端点设计

```
POST /api/v1/share/record
  - 记录分享行为
  - Body: { platform, scene, template, imageUrl, link, title, success }

GET /api/v1/share/history
  - 获取用户分享历史
  - Query: limit, offset, scene

GET /api/v1/share/stats
  - 获取分享统计（管理员）
  - Query: startDate, endDate, platform, scene

PUT /api/v1/share/preferences
  - 更新分享偏好设置
  - Body: { defaultPlatform, autoWatermark, showPlayerInfo, customHashtags }

GET /api/v1/share/link/:shareId
  - 分享链接跳转（记录 clickback）
  - 重定向到游戏或下载页
```

### 4.7 前端 UI 组件

```javascript
// frontend/game-client/src/components/SharePanel.js

class SharePanel {
  constructor(options) {
    this.scene = options.scene; // catch/achievement/battle/...
    this.data = options.data;
    this.onShare = options.onShare;
    this.providers = new ShareProvider();
  }

  async show() {
    // 1. 生成分享图片
    const image = await this._generateShareImage();

    // 2. 显示分享面板 UI
    const panel = this._createPanel(image);
    document.body.appendChild(panel);

    // 3. 绑定平台按钮事件
    this._bindEvents(panel, image);
  }

  _createPanel(image) {
    return `
      <div class="share-panel">
        <div class="share-preview">
          <img src="${image.dataUrl}" alt="分享预览">
        </div>
        <div class="share-platforms">
          <button class="share-btn wechat" data-platform="wechat">
            <icon>微信</icon>
          </button>
          <button class="share-btn weibo" data-platform="weibo">
            <icon>微博</icon>
          </button>
          <button class="share-btn twitter" data-platform="twitter">
            <icon>Twitter</icon>
          </button>
          <button class="share-btn facebook" data-platform="facebook">
            <icon>Facebook</icon>
          </button>
          <button class="share-btn system" data-platform="system">
            <icon>更多</icon>
          </button>
        </div>
        <div class="share-options">
          <label><input type="checkbox" checked> 添加水印</label>
          <label><input type="checkbox" checked> 显示玩家信息</label>
        </div>
        <button class="share-close">取消</button>
      </div>
    `;
  }

  async _handleShare(platform) {
    try {
      const result = await this.providers.share(platform, {
        title: this.data.title,
        description: this.data.description,
        imageUrl: this.image.url,
        imageFile: this.image.blob,
        link: this._generateShareLink(),
        hashtags: this.data.hashtags
      });

      // 显示成功提示
      this._showSuccessToast(platform);

      // 回调
      if (this.onShare) {
        this.onShare({ platform, success: true });
      }
    } catch (error) {
      this._showErrorToast(platform, error);
    }
  }
}
```

## 5. 验收标准（可测试）

- [ ] 截图捕获引擎支持 Canvas/WebGL 截图，输出 JPEG/PNG/WebP 格式
- [ ] 6 种分享模板（catch/achievement/battle/pokedex/friend/custom）可正确渲染
- [ ] 5 个社交平台（微信/微博/Twitter/Facebook/系统分享）集成可用
- [ ] 分享图片自动添加水印、时间戳、玩家信息
- [ ] 分享行为记录到数据库，包含 platform/scene/template 等字段
- [ ] 分享链接点击回调（clickback）正确追踪
- [ ] Prometheus 指标正确暴露（share_total/share_success/share_clickback 等）
- [ ] 前端 SharePanel 组件正确显示预览和平台按钮
- [ ] 用户分享偏好设置可保存和读取
- [ ] 单元测试覆盖核心模块，覆盖率 > 80%

## 6. 工作量估算

**M（中等）**

理由：
- 截图捕获使用 Canvas API，实现相对简单
- 分享模板系统需要设计 6 套模板，工作量适中
- 社交平台集成需要处理各平台 SDK 差异
- 后端 API 和数据库表设计清晰
- 预计 2-3 天完成

## 7. 优先级理由

**P1 理由**：
1. **用户留存**：社交分享是现代手游标配，缺失此功能降低用户成就感
2. **增长引擎**：社交分享带来自然流量，是低成本获客渠道
3. **竞品对标**：Pokemon GO 分享使用率 45%，是核心功能
4. **实现成本低**：基于现有 Canvas 和 Web API，无需复杂依赖
5. **数据价值**：分享数据可分析用户行为和传播效果
