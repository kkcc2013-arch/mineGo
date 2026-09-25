# REQ-00387: 玩家资料卡与档案展示系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00387 |
| 标题 | 玩家资料卡与档案展示系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | user-service、social-service、pokemon-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-30 12:00 |

## 需求描述

实现一个完整的玩家资料卡与档案展示系统，允许玩家自定义个人资料展示，包括头像框、背景主题、签名档、成就徽章、统计数据等。系统支持资料卡分享、好友查看、社交互动等功能。

### 核心功能
1. **资料卡自定义**：头像框选择、背景主题、签名档编辑
2. **成就徽章展示**：已解锁成就的精选展示（最多展示6个）
3. **统计数据可视化**：捕捉数量、道馆战绩、社交活跃度等
4. **资料卡分享**：生成图片分享到社交媒体
5. **隐私控制**：资料卡可见性设置（公开/好友/私密）

## 技术方案

### 1. 数据库设计

```sql
-- 玩家资料卡配置表
CREATE TABLE player_profile_configs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    avatar_frame_id INTEGER REFERENCES avatar_frames(id),
    background_theme_id INTEGER REFERENCES profile_themes(id),
    signature TEXT CHECK(LENGTH(signature) <= 100),
    visibility VARCHAR(20) NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'friends', 'private')),
    selected_badges INTEGER[] NOT NULL DEFAULT '{}', -- 最多6个成就ID
    selected_pokemon INTEGER[] NOT NULL DEFAULT '{}', -- 展示的精灵ID（最多3个）
    stats_layout JSONB NOT NULL DEFAULT '{}', -- 统计数据布局配置
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

-- 头像框资源表
CREATE TABLE avatar_frames (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    image_url TEXT NOT NULL,
    rarity VARCHAR(20) NOT NULL DEFAULT 'common' CHECK(rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
    unlock_condition JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 资料卡背景主题表
CREATE TABLE profile_themes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    preview_url TEXT NOT NULL,
    full_url TEXT NOT NULL,
    theme_type VARCHAR(20) NOT NULL DEFAULT 'static' CHECK(theme_type IN ('static', 'animated', 'seasonal')),
    rarity VARCHAR(20) NOT NULL DEFAULT 'common',
    unlock_condition JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 资料卡访问日志
CREATE TABLE profile_view_logs (
    id BIGSERIAL PRIMARY KEY,
    profile_user_id INTEGER NOT NULL,
    viewer_id INTEGER, -- NULL表示匿名访问
    view_source VARCHAR(20) NOT NULL DEFAULT 'in_app' CHECK(view_source IN ('in_app', 'share_link', 'qr_code')),
    ip_hash VARCHAR(64),
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (viewed_at);

-- 创建分区索引
CREATE INDEX idx_profile_view_logs_profile_user ON profile_view_logs(profile_user_id, viewed_at DESC);
CREATE INDEX idx_profile_view_logs_viewer ON profile_view_logs(viewer_id, viewed_at DESC);
```

### 2. user-service 核心实现

```javascript
// backend/services/user-service/routes/profileRoutes.js
const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const authMiddleware = require('../../../shared/middleware/auth');
const rateLimiter = require('../../../shared/middleware/rateLimiter');

/**
 * @route GET /api/v1/users/:userId/profile
 * @desc 获取玩家资料卡
 * @access Public (受隐私设置控制)
 */
router.get('/:userId/profile', 
  rateLimiter({ windowMs: 60000, max: 60 }),
  profileController.getProfile
);

/**
 * @route PUT /api/v1/users/me/profile
 * @desc 更新当前用户资料卡配置
 * @access Private
 */
router.put('/me/profile',
  authMiddleware,
  profileController.updateProfile
);

/**
 * @route POST /api/v1/users/me/profile/share
 * @desc 生成资料卡分享链接
 * @access Private
 */
router.post('/me/profile/share',
  authMiddleware,
  rateLimiter({ windowMs: 60000, max: 5 }),
  profileController.generateShareLink
);

/**
 * @route GET /api/v1/users/me/profile/badges/available
 * @desc 获取可用展示的成就徽章列表
 * @access Private
 */
router.get('/me/profile/badges/available',
  authMiddleware,
  profileController.getAvailableBadges
);

module.exports = router;
```

```javascript
// backend/services/user-service/controllers/profileController.js
const { Pool } = require('pg');
const Redis = require('ioredis');
const { AchievementCalculator } = require('../../../shared/utils/AchievementCalculator');

class ProfileController {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = new Redis(process.env.REDIS_URL);
    this.achievementCalculator = new AchievementCalculator();
  }

  /**
   * 获取玩家资料卡
   */
  getProfile = async (req, res) => {
    try {
      const { userId } = req.params;
      const viewerId = req.user?.id || null;
      const cacheKey = `profile:${userId}:${viewerId || 'anon'}`;

      // 尝试从缓存获取
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      // 获取资料卡配置
      const configResult = await this.db.query(`
        SELECT 
          ppc.*,
          af.name as frame_name,
          af.image_url as frame_url,
          pt.name as theme_name,
          pt.full_url as theme_url,
          u.username,
          u.avatar_url,
          u.level,
          u.experience,
          u.created_at as join_date
        FROM player_profile_configs ppc
        LEFT JOIN avatar_frames af ON ppc.avatar_frame_id = af.id
        LEFT JOIN profile_themes pt ON ppc.background_theme_id = pt.id
        JOIN users u ON ppc.user_id = u.id
        WHERE ppc.user_id = $1
      `, [userId]);

      if (configResult.rows.length === 0) {
        return res.status(404).json({ error: 'PROFILE_NOT_FOUND' });
      }

      const config = configResult.rows[0];

      // 隐私检查
      if (config.visibility === 'private' && viewerId !== parseInt(userId)) {
        return res.status(403).json({ error: 'PROFILE_PRIVATE' });
      }

      if (config.visibility === 'friends' && viewerId !== parseInt(userId)) {
        const isFriend = await this.checkFriendship(userId, viewerId);
        if (!isFriend) {
          return res.status(403).json({ error: 'PROFILE_FRIENDS_ONLY' });
        }
      }

      // 并行获取统计数据
      const [stats, badges, featuredPokemon] = await Promise.all([
        this.getUserStats(userId),
        this.getSelectedBadges(config.selected_badges),
        this.getFeaturedPokemon(config.selected_pokemon)
      ]);

      const profile = {
        user: {
          id: userId,
          username: config.username,
          avatar: config.avatar_url,
          avatarFrame: config.frame_url ? {
            name: config.frame_name,
            url: config.frame_url
          } : null,
          level: config.level,
          experience: config.experience,
          joinDate: config.join_date
        },
        theme: {
          name: config.theme_name,
          url: config.theme_url
        },
        signature: config.signature,
        stats,
        badges,
        featuredPokemon,
        visibility: config.visibility
      };

      // 缓存5分钟
      await this.redis.setex(cacheKey, 300, JSON.stringify(profile));

      // 记录访问日志（异步）
      this.logProfileView(userId, viewerId, req.ip).catch(console.error);

      res.json(profile);
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  };

  /**
   * 更新资料卡配置
   */
  updateProfile = async (req, res) => {
    try {
      const userId = req.user.id;
      const {
        avatarFrameId,
        backgroundThemeId,
        signature,
        visibility,
        selectedBadges,
        selectedPokemon,
        statsLayout
      } = req.body;

      // 验证徽章数量
      if (selectedBadges && selectedBadges.length > 6) {
        return res.status(400).json({ 
          error: 'BADGE_LIMIT_EXCEEDED',
          message: '最多展示6个徽章'
        });
      }

      // 验证精灵数量
      if (selectedPokemon && selectedPokemon.length > 3) {
        return res.status(400).json({ 
          error: 'POKEMON_LIMIT_EXCEEDED',
          message: '最多展示3只精灵'
        });
      }

      // 验证签名长度
      if (signature && signature.length > 100) {
        return res.status(400).json({ 
          error: 'SIGNATURE_TOO_LONG',
          message: '签名不能超过100字符'
        });
      }

      // 验证玩家是否拥有所选资源
      await this.validateOwnership(userId, {
        avatarFrameId,
        backgroundThemeId,
        selectedBadges,
        selectedPokemon
      });

      const result = await this.db.query(`
        INSERT INTO player_profile_configs (
          user_id, avatar_frame_id, background_theme_id, signature,
          visibility, selected_badges, selected_pokemon, stats_layout
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (user_id) DO UPDATE SET
          avatar_frame_id = EXCLUDED.avatar_frame_id,
          background_theme_id = EXCLUDED.background_theme_id,
          signature = EXCLUDED.signature,
          visibility = EXCLUDED.visibility,
          selected_badges = EXCLUDED.selected_badges,
          selected_pokemon = EXCLUDED.selected_pokemon,
          stats_layout = EXCLUDED.stats_layout,
          updated_at = NOW()
        RETURNING *
      `, [userId, avatarFrameId, backgroundThemeId, signature, 
          visibility || 'public', selectedBadges || [], selectedPokemon || [], 
          statsLayout || {}]);

      // 清除缓存
      await this.redis.del(`profile:${userId}:*`);
      await this.redis.del(`profile:${userId}:anon`);

      res.json({ 
        success: true, 
        profile: result.rows[0] 
      });
    } catch (error) {
      console.error('Update profile error:', error);
      if (error.code === 'OWNERSHIP_VALIDATION_FAILED') {
        return res.status(403).json({ error: error.message });
      }
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  };

  /**
   * 获取用户统计数据
   */
  async getUserStats(userId) {
    const result = await this.db.query(`
      SELECT 
        (SELECT COUNT(*) FROM catches WHERE user_id = $1) as total_catches,
        (SELECT COUNT(*) FROM gyms WHERE owner_id = $1) as gyms_owned,
        (SELECT COUNT(*) FROM friendships 
         WHERE (user1_id = $1 OR user2_id = $1) AND status = 'accepted') as friends_count,
        (SELECT COUNT(DISTINCT pokemon_id) FROM catches WHERE user_id = $1) as unique_species,
        (SELECT SUM(battles_won) FROM gym_stats WHERE user_id = $1) as battles_won,
        (SELECT SUM(battles_total) FROM gym_stats WHERE user_id = $1) as battles_total,
        (SELECT COALESCE(SUM(distance_traveled), 0) FROM user_activities WHERE user_id = $1) as distance_km
    `, [userId]);

    return result.rows[0];
  }

  /**
   * 生成分享链接
   */
  generateShareLink = async (req, res) => {
    try {
      const userId = req.user.id;
      const shareToken = this.generateShareToken();
      
      const shareUrl = `${process.env.APP_URL}/profile/${userId}?share=${shareToken}`;
      
      // 存储分享令牌（24小时有效）
      await this.redis.setex(`share:${shareToken}`, 86400, userId);
      
      res.json({
        shareUrl,
        qrCodeUrl: `${process.env.API_URL}/v1/users/${userId}/profile/qr/${shareToken}`,
        expiresAt: new Date(Date.now() + 86400000)
      });
    } catch (error) {
      console.error('Generate share link error:', error);
      res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  };

  /**
   * 检查好友关系
   */
  async checkFriendship(userId, viewerId) {
    if (!viewerId) return false;
    const result = await this.db.query(`
      SELECT 1 FROM friendships 
      WHERE ((user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1))
      AND status = 'accepted'
    `, [userId, viewerId]);
    return result.rows.length > 0;
  }

  /**
   * 记录访问日志
   */
  async logProfileView(profileUserId, viewerId, ip) {
    const ipHash = require('crypto').createHash('sha256').update(ip).digest('hex').substring(0, 16);
    await this.db.query(`
      INSERT INTO profile_view_logs (profile_user_id, viewer_id, ip_hash)
      VALUES ($1, $2, $3)
    `, [profileUserId, viewerId, ipHash]);
  }

  generateShareToken() {
    return require('crypto').randomBytes(16).toString('base64url');
  }
}

module.exports = new ProfileController();
```

### 3. 资料卡渲染服务（图片生成）

```javascript
// backend/services/user-service/utils/ProfileCardRenderer.js
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');

class ProfileCardRenderer {
  constructor() {
    this.width = 600;
    this.height = 800;
    this.initializeFonts();
  }

  async initializeFonts() {
    try {
      registerFont(path.join(__dirname, '../../../assets/fonts/NotoSansSC-Regular.ttf'), { family: 'Noto Sans SC' });
      registerFont(path.join(__dirname, '../../../assets/fonts/NotoSansSC-Bold.ttf'), { family: 'Noto Sans SC', weight: 'bold' });
    } catch (error) {
      console.warn('Font registration failed, using default font');
    }
  }

  /**
   * 渲染资料卡为图片
   */
  async render(profileData) {
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    // 绘制背景主题
    await this.drawBackground(ctx, profileData.theme);

    // 绘制头像框
    await this.drawAvatar(ctx, profileData.user);

    // 绘制用户名和等级
    this.drawUserInfo(ctx, profileData.user);

    // 绘制签名
    this.drawSignature(ctx, profileData.signature);

    // 绘制统计数据
    this.drawStats(ctx, profileData.stats);

    // 绘制成就徽章
    await this.drawBadges(ctx, profileData.badges);

    // 绘制精选精灵
    await this.drawFeaturedPokemon(ctx, profileData.featuredPokemon);

    // 水印
    this.drawWatermark(ctx);

    return canvas.toBuffer('image/png');
  }

  async drawBackground(ctx, theme) {
    if (theme?.url) {
      try {
        const bgImage = await loadImage(theme.url);
        ctx.drawImage(bgImage, 0, 0, this.width, this.height);
      } catch {
        this.drawDefaultBackground(ctx);
      }
    } else {
      this.drawDefaultBackground(ctx);
    }
  }

  drawDefaultBackground(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, '#667eea');
    gradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  async drawAvatar(ctx, user) {
    const avatarSize = 120;
    const avatarX = this.width / 2 - avatarSize / 2;
    const avatarY = 80;

    // 绘制头像
    if (user.avatar) {
      try {
        const avatarImage = await loadImage(user.avatar);
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.width / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatarImage, avatarX, avatarY, avatarSize, avatarSize);
        ctx.restore();
      } catch {
        this.drawPlaceholderAvatar(ctx, avatarX, avatarY, avatarSize);
      }
    } else {
      this.drawPlaceholderAvatar(ctx, avatarX, avatarY, avatarSize);
    }

    // 绘制头像框
    if (user.avatarFrame?.url) {
      try {
        const frameImage = await loadImage(user.avatarFrame.url);
        ctx.drawImage(frameImage, avatarX - 10, avatarY - 10, avatarSize + 20, avatarSize + 20);
      } catch (error) {
        console.warn('Failed to load avatar frame');
      }
    }
  }

  drawPlaceholderAvatar(ctx, x, y, size) {
    ctx.fillStyle = '#cccccc';
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  drawUserInfo(ctx, user) {
    ctx.font = 'bold 28px "Noto Sans SC"';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(user.username, this.width / 2, 240);

    // 等级标签
    ctx.font = '18px "Noto Sans SC"';
    ctx.fillStyle = '#ffd700';
    ctx.fillText(`Lv.${user.level}`, this.width / 2, 270);
  }

  drawSignature(ctx, signature) {
    if (!signature) return;
    
    ctx.font = '16px "Noto Sans SC"';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.textAlign = 'center';
    
    // 限制签名显示宽度
    const maxWidth = 400;
    const truncated = this.truncateText(ctx, signature, maxWidth);
    ctx.fillText(`"${truncated}"`, this.width / 2, 310);
  }

  drawStats(ctx, stats) {
    const statItems = [
      { label: '捕捉数', value: stats.total_catches || 0, icon: '🎯' },
      { label: '图鉴', value: stats.unique_species || 0, icon: '📖' },
      { label: '好友', value: stats.friends_count || 0, icon: '👥' },
      { label: '道馆', value: stats.gyms_owned || 0, icon: '🏆' },
    ];

    const startY = 360;
    const itemWidth = 140;
    const startX = 30;

    statItems.forEach((item, index) => {
      const x = startX + (index % 4) * itemWidth;
      const y = startY;

      // 背景
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.roundRect(x, y, itemWidth - 10, 60, 8);
      ctx.fill();

      // 数值
      ctx.font = 'bold 24px "Noto Sans SC"';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(item.icon + ' ' + this.formatNumber(item.value), x + (itemWidth - 10) / 2, y + 28);

      // 标签
      ctx.font = '12px "Noto Sans SC"';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillText(item.label, x + (itemWidth - 10) / 2, y + 50);
    });
  }

  async drawBadges(ctx, badges) {
    if (!badges || badges.length === 0) return;

    const badgeSize = 50;
    const spacing = 15;
    const totalWidth = badges.length * badgeSize + (badges.length - 1) * spacing;
    const startX = (this.width - totalWidth) / 2;
    const y = 450;

    ctx.font = '14px "Noto Sans SC"';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.textAlign = 'center';
    ctx.fillText('— 成就徽章 —', this.width / 2, y - 15);

    for (let i = 0; i < badges.length; i++) {
      const badge = badges[i];
      const x = startX + i * (badgeSize + spacing);

      try {
        const badgeImage = await loadImage(badge.icon_url);
        ctx.drawImage(badgeImage, x, y, badgeSize, badgeSize);
      } catch {
        // 占位符
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.arc(x + badgeSize / 2, y + badgeSize / 2, badgeSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  async drawFeaturedPokemon(ctx, pokemon) {
    if (!pokemon || pokemon.length === 0) return;

    const pokemonSize = 80;
    const spacing = 30;
    const totalWidth = pokemon.length * pokemonSize + (pokemon.length - 1) * spacing;
    const startX = (this.width - totalWidth) / 2;
    const y = 550;

    ctx.font = '14px "Noto Sans SC"';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.textAlign = 'center';
    ctx.fillText('— 精选精灵 —', this.width / 2, y - 15);

    for (let i = 0; i < pokemon.length; i++) {
      const p = pokemon[i];
      const x = startX + i * (pokemonSize + spacing);

      try {
        const pokeImage = await loadImage(p.image_url);
        ctx.drawImage(pokeImage, x, y, pokemonSize, pokemonSize);
      } catch {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath();
        ctx.arc(x + pokemonSize / 2, y + pokemonSize / 2, pokemonSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // 精灵名称
      ctx.font = '12px "Noto Sans SC"';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.name, x + pokemonSize / 2, y + pokemonSize + 15);
    }
  }

  drawWatermark(ctx) {
    ctx.font = '12px "Noto Sans SC"';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'right';
    ctx.fillText('mineGo', this.width - 20, this.height - 20);
  }

  truncateText(ctx, text, maxWidth) {
    let truncated = text;
    while (ctx.measureText(truncated).width > maxWidth && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    return truncated.length < text.length ? truncated + '...' : truncated;
  }

  formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
}

module.exports = new ProfileCardRenderer();
```

### 4. 前端组件实现

```javascript
// frontend/game-client/src/components/ProfileCard.js
class ProfileCard {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      userId: null,
      editable: false,
      showActions: true,
      ...options
    };
    this.data = null;
    this.init();
  }

  async init() {
    await this.loadProfile();
    this.render();
  }

  async loadProfile() {
    try {
      const response = await fetch(`/api/v1/users/${this.options.userId}/profile`);
      if (!response.ok) throw new Error('Failed to load profile');
      this.data = await response.json();
    } catch (error) {
      console.error('Load profile error:', error);
      this.showError();
    }
  }

  render() {
    if (!this.data) return;

    this.container.innerHTML = `
      <div class="profile-card" style="--theme-bg: url('${this.data.theme?.url || ''}')">
        <div class="profile-header">
          <div class="avatar-container">
            <img src="${this.data.user.avatar}" alt="Avatar" class="avatar" />
            ${this.data.user.avatarFrame ? `<img src="${this.data.user.avatarFrame.url}" class="avatar-frame" />` : ''}
          </div>
          <div class="user-info">
            <h2 class="username">${this.escapeHtml(this.data.user.username)}</h2>
            <span class="level-badge">Lv.${this.data.user.level}</span>
          </div>
        </div>
        
        ${this.data.signature ? `
          <div class="signature">
            <p>"${this.escapeHtml(this.data.signature)}"</p>
          </div>
        ` : ''}
        
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-icon">🎯</span>
            <span class="stat-value">${this.formatNumber(this.data.stats.total_catches)}</span>
            <span class="stat-label">捕捉数</span>
          </div>
          <div class="stat-item">
            <span class="stat-icon">📖</span>
            <span class="stat-value">${this.data.stats.unique_species}</span>
            <span class="stat-label">图鉴</span>
          </div>
          <div class="stat-item">
            <span class="stat-icon">👥</span>
            <span class="stat-value">${this.data.stats.friends_count}</span>
            <span class="stat-label">好友</span>
          </div>
          <div class="stat-item">
            <span class="stat-icon">🏆</span>
            <span class="stat-value">${this.data.stats.gyms_owned}</span>
            <span class="stat-label">道馆</span>
          </div>
        </div>
        
        ${this.data.badges.length > 0 ? `
          <div class="badges-section">
            <h3>成就徽章</h3>
            <div class="badges-grid">
              ${this.data.badges.map(badge => `
                <div class="badge-item" title="${this.escapeHtml(badge.name)}">
                  <img src="${badge.icon_url}" alt="${this.escapeHtml(badge.name)}" />
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${this.data.featuredPokemon.length > 0 ? `
          <div class="featured-section">
            <h3>精选精灵</h3>
            <div class="pokemon-grid">
              ${this.data.featuredPokemon.map(pokemon => `
                <div class="pokemon-item">
                  <img src="${pokemon.image_url}" alt="${this.escapeHtml(pokemon.name)}" />
                  <span class="pokemon-name">${this.escapeHtml(pokemon.name)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${this.options.showActions ? `
          <div class="profile-actions">
            <button class="btn-share" onclick="profileCard.share()">
              <i class="icon-share"></i> 分享
            </button>
            ${this.options.editable ? `
              <button class="btn-edit" onclick="profileCard.openEditor()">
                <i class="icon-edit"></i> 编辑
              </button>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  async share() {
    try {
      const response = await fetch('/api/v1/users/me/profile/share', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const { shareUrl } = await response.json();
      
      // 尝试使用 Web Share API
      if (navigator.share) {
        await navigator.share({
          title: `${this.data.user.username}的资料卡`,
          url: shareUrl
        });
      } else {
        // 复制链接到剪贴板
        await navigator.clipboard.writeText(shareUrl);
        this.showToast('链接已复制到剪贴板');
      }
    } catch (error) {
      console.error('Share error:', error);
    }
  }

  openEditor() {
    window.location.href = '/profile/edit';
  }

  formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showError() {
    this.container.innerHTML = `
      <div class="profile-error">
        <p>无法加载资料卡</p>
        <button onclick="location.reload()">重试</button>
      </div>
    `;
  }
}

module.exports = ProfileCard;
```

### 5. API Gateway 集成

```yaml
# infrastructure/k8s/gateway-routes.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: profile-routes
  namespace: minego
spec:
  parentRefs:
    - name: minego-gateway
  hostnames:
    - "api.minego.game"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/v1/users/
        - path:
            type: PathPrefix
            value: /profile/
      backendRefs:
        - name: user-service
          port: 3002
      filters:
        - type: RateLimit
          rateLimit:
            type: Global
            global:
              rules:
                - clientSelectors:
                    - headers:
                        - name: Authorization
                  limit:
                    requests: 60
                    unit: Minute
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: profile-share-route
  namespace: minego
spec:
  parentRefs:
    - name: minego-gateway
  hostnames:
    - "share.minego.game"
  rules:
    - matches:
        - path:
            type: Exact
            value: /profile/
      backendRefs:
        - name: user-service
          port: 3002
```

## 验收标准

- [ ] 玩家可以自定义头像框、背景主题和签名档
- [ ] 成就徽章可选择展示（最多6个）
- [ ] 精选精灵可选择展示（最多3只）
- [ ] 统计数据实时更新并正确显示
- [ ] 隐私设置生效（公开/好友/私密）
- [ ] 资料卡分享功能正常，生成分享链接和二维码
- [ ] 资料卡图片生成正确，包含所有信息
- [ ] 访问日志正确记录
- [ ] 缓存策略生效，避免频繁数据库查询
- [ ] 移动端资料卡样式适配
- [ ] API响应时间 < 200ms (缓存命中)
- [ ] 图片生成时间 < 3s

## 影响范围

- **新增文件**:
  - `backend/services/user-service/routes/profileRoutes.js`
  - `backend/services/user-service/controllers/profileController.js`
  - `backend/services/user-service/utils/ProfileCardRenderer.js`
  - `frontend/game-client/src/components/ProfileCard.js`
  - `frontend/game-client/src/components/ProfileEditor.js`
  - `frontend/game-client/src/styles/profile.css`

- **数据库迁移**:
  - `database/migrations/0387_player_profile_system.sql`

- **API 变更**:
  - `GET /api/v1/users/:userId/profile`
  - `PUT /api/v1/users/me/profile`
  - `POST /api/v1/users/me/profile/share`
  - `GET /api/v1/users/me/profile/badges/available`

## 参考

- [社交系统设计文档](./REQ-00048-friend-social-system.md)
- [成就系统设计文档](./REQ-00076-achievement-system.md)
- [Canvas API 文档](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)

## 实现记录（2026-09-24）

> E05「成就/称号/资料卡/收藏室」与 E13「消息中心与推送」统一实现：REQ-00076 / 00106 / 00327 / 00359 / 00387 / 00403 与 REQ-00099 / 00261 / 00425 共用同一套游戏事件 outbox、成就引擎与消息中心。
> 状态 `implemented`：代码已全部完成，**未做服务级验证**（2026-09-25 18:30 起规则）。此前迁移 `20260925_130000`、`20260925_131000` 曾在隔离 CI 栈（栈 8）的存量库上执行无失败，user-service 启动后事件消费者、消息分发器、WebSocket 均正常监听；之后新增的迁移 `20260925_132000`、`20260925_133000`、全部接口、前端界面只做了静态检查（`node --check`、`scripts/check-deps.js`、宿主机纯逻辑/内存替身单测），**待验证**。

**共用架构**

- 事件来源：业务表上的触发器把"发生了什么"写入 outbox 表 `achievement_events`（与业务同事务，业务回滚事件也不存在；触发器内部异常只 `RAISE WARNING`，不影响业务）并 `pg_notify('pmg_game_events')`。接入的表：`catch_sessions`（捕捉成功）、`pokestop_spins`、`trainer_level_ups`（升级，覆盖所有加经验路径）、`friendships`/`friends`、`friend_requests`、`friend_gifts`、`pokemon_trades`、`gym_battles`、`raid_participants`、`pvp_battles`、`egg_hatching`、`event_participations`；收藏室的展示/装饰/被点赞由 JS 在同事务写事件。
- 消费：`backend/shared/achievementEngine.js`，user-service 启动时 `LISTEN` 实时处理 + 10 秒兜底扫描 + 每小时清理；pokemon-service 查询成就前按需处理该玩家未处理事件。`FOR UPDATE SKIP LOCKED` 保证多消费者不重复处理；每个事件一个 SAVEPOINT，单事件失败不影响其他事件，失败 5 次后放弃并保留 `last_error`。
- 规则：`backend/shared/achievementRules.js`（事件 → 指标、过滤条件、奖励拆分、事件 → 消息、多语言，纯函数）。
- 消息：`backend/shared/notificationCenter.js`（生成/列表/未读/已读/删除/偏好/广播/分析/清理）、`notificationPolicy.js`（分类、偏好、免打扰、投递计划，纯函数）、`notificationRealtime.js`（`/ws/messages` 与 LISTEN 分发）、`pushProviders.js`（FCM/APNs）。
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`（成就/称号收敛 + outbox 触发器）、`20260925_131000__e13_notification_center.sql`（消息中心）、`20260925_132000__e05_collection_room.sql`（收藏室）、`20260925_133000__e05_player_profile.sql`（资料卡）。均 `IF NOT EXISTS`/`ON CONFLICT` 幂等，外键均按 `users.id UUID`；依赖的表（`achievements`、`title_definitions`、`trainer_level_ups`、`notification_templates`、E01 的 `privacy_settings`/`blocked_users` 等）都在更早的迁移中创建（已逐条核对）。
- 测试：单测 `cd backend && node --test tests/unit/achievementRules.test.js tests/unit/achievementEngine.test.js tests/unit/notificationPolicy.test.js tests/unit/notificationCenter.test.js tests/unit/profileRules.test.js tests/unit/collectionRoomRules.test.js tests/unit/securityNotifier.test.js`（53 例，已加入 `test:unit`，宿主机已运行通过；引擎与消息中心用 `tests/unit/helpers/fakeGameDb.js` 内存替身，不依赖数据库）；经网关冒烟 `BASE_URL=… node scripts/smoke-profile-notify.js`（约 97 项，**未运行**）；压测 `node scripts/bench-profile-notify.js`（**未运行**）；前端 `cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js`（Mock 接口，**未运行**）。
- 前端：`frontend/game-client/src/features/profileNotify.js` + `src/features/profile-notify/*`（由 `src/bootstrap/features.js` 注册一行）：底部导航「消息」🔔、「我的」页「成长与收藏」卡片（成就、称号、资料卡、我的收藏室、热门收藏室、收藏家排行、消息与通知设置）。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 玩家可以自定义头像框、背景主题和签名档 | ✅ | `PUT /v1/users/me/profile {avatarFrameId, backgroundThemeId, signature, visibility, selectedBadges, selectedPokemon, statsLayout}`；`GET /v1/users/me/profile/customization` 返回头像框 8 个、资料背景 6 个及解锁状态（条件：训练师等级 / 收藏家等级 / 指定成就），未解锁的返回 403。签名 ≤ 100 字、去除尖括号与控制字符 |
| 成就徽章可选择展示（最多6个） | ✅ | `GET /v1/users/me/profile/badges/available`；只能选已完成的成就（否则 400），最多 6 个（接口与表 CHECK 双重限制），按选择顺序展示 |
| 精选精灵可选择展示（最多3只） | ✅ | 必须是自己拥有且未放生的精灵；最多 3 只，收藏家 2 级起 5 只（REQ-00327 特权；表 CHECK ≤ 5） |
| 统计数据实时更新并正确显示 | ✅ | 统计实时聚合；缓存随被查看者的资料/称号/成就/收藏室变化即时失效（捕捉等事件经成就引擎处理后 bump 版本号） |
| 隐私设置生效（公开/好友/私密） | ✅ | `visibility` public/friends/private，与 E01 `privacy_settings.profile_visibility` 取更严格者；被对方拉黑视同受限；私密/受限资料不能生成资料卡（403）；分享链接只对公开资料有效 |
| 资料卡分享功能正常，生成分享链接和二维码 | ✅ | `POST /v1/users/me/profile/share`：分享码（`player_profile_configs.share_code`，唯一）、分享链接 `${PUBLIC_WEB_BASE}/p/<code>`、二维码（`qrcode` 生成 PNG data URL，扫码来源记 `qr_code`）、卡片图片地址；匿名访问 `GET /v1/profile-cards/:code`（数据）/ `:code.svg`（图片）。前端：复制链接、二维码、保存 PNG、系统分享 |
| 资料卡图片生成正确，包含所有信息 | ✅ | SVG 600×340：背景主题渐变、头像框颜色、昵称、等级、队伍色、称号、收藏家等级与积分、最多 6 个徽章、已捕捉/种类/闪光/成就四项统计、签名、分享链接；所有用户输入 XML 转义、颜色白名单（单测覆盖注入） |
| 访问日志正确记录 | ✅ | 他人查看写 `profile_view_logs`（查看者、来源 in_app/share_link/qr_code、IP 哈希），同一查看者 10 分钟内只记一次（Redis NX）；本人资料返回总查看数、近 7 天独立访客、分享打开次数；日志随账号删除级联 |
| 缓存策略生效，避免频繁数据库查询 | ✅ | 资料按"被查看者+可见范围+语言"缓存 120 秒（带版本号，变更即失效）；响应带 `cache.hit` 便于观察 |
| 移动端资料卡样式适配 | ✅ | `profileNotify.css` 移动优先（全屏面板、44px 触控目标、统计网格 3 列、图片自适应宽度）；待真机验证 |
| API响应时间 < 200ms (缓存命中) | ⚠️ | 未实测；`scripts/bench-profile-notify.js` 含 `GET /v1/users/:id/profile`（缓存命中）的 P95（阈值 200ms） |
| 图片生成时间 < 3s | ⚠️ | 未实测；服务端只是拼接 SVG 字符串（无 canvas/无头浏览器依赖），开销为资料查询本身；PNG 在客户端转换 |

- 入口：user-service `src/routes/profile.js`（`/users/me/profile*`、`/users/:id/profile`、`/users/:id/profile/card(.svg)`、`/users/:id/stats`；公开路由 `/profile-cards`）、`src/profile/profileService.js`、`backend/shared/profileRules.js`（配置校验、隐私过滤、SVG 渲染）、`backend/shared/profileStats.js`；网关 `/v1/users/*`（鉴权）与 `/v1/profile-cards/*`（公开）
- 前端：`src/features/profile-notify/profileCard.js`（资料卡、编辑器、分享、查看他人资料、收藏家排行）
- 迁移：`database/migrations/20260925_133000__e05_player_profile.sql`：`player_profile_configs`、`avatar_frames`、`profile_themes`、`profile_view_logs`、`collector_scores`
- 测试：`tests/unit/profileRules.test.js`（9 例，已通过）；冒烟资料卡/隐私相关约 15 项（未运行）
- 偏差：头像框/主题主键用字符串代码（与称号/成就一致、便于解锁条件引用），`user_id` 为 UUID；访问日志用普通表 + 索引（原方案按月分区，当前量级不需要）；图片为 SVG（原方案 Canvas 渲染 PNG，服务端无 canvas 依赖），客户端转 PNG；K8s gateway-routes 未改（生产用 PM2 + 网关代码路由）
- 待验证：① 分享链接在未登录浏览器中打开卡片；② 二维码可被扫描；③ 前端编辑器保存与解锁提示
