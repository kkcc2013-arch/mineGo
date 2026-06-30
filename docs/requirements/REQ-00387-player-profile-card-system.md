# REQ-00387: 玩家资料卡与档案展示系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00387 |
| 标题 | 玩家资料卡与档案展示系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
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
