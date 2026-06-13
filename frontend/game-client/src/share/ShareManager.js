/**
 * 分享管理器
 * REQ-00153: 游戏内截图分享与社交传播系统
 */

const ScreenshotCapture = require('./ScreenshotCapture');
const ShareTemplateManager = require('./ShareTemplateManager');
const SocialPlatformIntegration = require('./SocialPlatformIntegration');

class ShareManager {
  constructor() {
    this.screenshotCapture = ScreenshotCapture;
    this.templateManager = ShareTemplateManager;
    this.platformIntegration = SocialPlatformIntegration;
    this.shareHistory = [];
    this.maxHistorySize = 50;
  }

  /**
   * 执行完整分享流程
   */
  async share(options) {
    const {
      scene,           // 分享场景：catch/achievement/battle/pokedex/friend/custom
      platform,        // 目标平台
      data,            // 场景数据
      screenshot,      // 可选：预截图的图片数据
      showWatermark = true,
      showPlayerInfo = true,
      playerInfo       // 玩家信息
    } = options;

    try {
      // 1. 获取或生成截图
      let imageData = screenshot;
      if (!imageData) {
        imageData = await this._captureScene(scene, data);
      }

      // 2. 获取场景预设
      const preset = this.screenshotCapture.getScenePreset(scene);

      // 3. 添加水印
      if (showWatermark && preset.watermark) {
        imageData = await this.screenshotCapture.addWatermark(imageData, preset.watermark);
      }

      // 4. 添加玩家信息
      if (showPlayerInfo && playerInfo && preset.showPlayerInfo) {
        imageData = await this.screenshotCapture.addPlayerInfo(imageData, playerInfo);
      }

      // 5. 生成分享内容
      const content = this.templateManager.generateContent(scene, data);
      const platformContent = this.templateManager.formatForPlatform(content, platform);

      // 6. 构造分享数据
      const shareData = {
        ...platformContent,
        imageUrl: imageData.dataUrl,
        link: options.link || this._generateShareLink(scene, data),
        timestamp: Date.now()
      };

      // 7. 执行分享
      const result = await this.platformIntegration.share(platform, shareData);

      // 8. 记录分享历史
      this._recordShare({
        scene,
        platform,
        success: result.success,
        data: {
          content,
          imageData: imageData.dataUrl.substring(0, 100) + '...' // 截断存储
        }
      });

      return {
        ...result,
        imageData,
        content
      };

    } catch (error) {
      console.error('Share failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 捕获场景截图
   */
  async _captureScene(scene, data) {
    switch (scene) {
      case 'catch':
        return this.screenshotCapture.capturePokemonDetail(data.pokemonId);
      
      case 'achievement':
        return this.screenshotCapture.captureAchievement(data.achievementId);
      
      case 'battle':
        return this.screenshotCapture.captureBattleResult();
      
      case 'pokedex':
        return this.screenshotCapture.capturePokedex();
      
      case 'friend':
      case 'custom':
      default:
        return this.screenshotCapture.captureGameCanvas();
    }
  }

  /**
   * 生成分享链接
   */
  _generateShareLink(scene, data) {
    const baseUrl = window.location.origin;
    const params = new URLSearchParams({
      scene,
      ref: 'share',
      t: Date.now()
    });

    // 添加场景特定参数
    if (data.pokemonId) params.set('pokemon', data.pokemonId);
    if (data.achievementId) params.set('achievement', data.achievementId);
    if (data.userId) params.set('user', data.userId);

    return `${baseUrl}/share?${params.toString()}`;
  }

  /**
   * 快速分享 - 捕捉场景
   */
  async shareCatch(pokemonData, platform = 'system') {
    return this.share({
      scene: 'catch',
      platform,
      data: pokemonData,
      playerInfo: await this._getPlayerInfo()
    });
  }

  /**
   * 快速分享 - 成就场景
   */
  async shareAchievement(achievementData, platform = 'system') {
    return this.share({
      scene: 'achievement',
      platform,
      data: achievementData,
      playerInfo: await this._getPlayerInfo()
    });
  }

  /**
   * 快速分享 - 战斗场景
   */
  async shareBattle(battleData, platform = 'system') {
    return this.share({
      scene: 'battle',
      platform,
      data: battleData,
      playerInfo: await this._getPlayerInfo()
    });
  }

  /**
   * 快速分享 - 图鉴场景
   */
  async sharePokedex(pokedexData, platform = 'system') {
    return this.share({
      scene: 'pokedex',
      platform,
      data: pokedexData,
      playerInfo: await this._getPlayerInfo()
    });
  }

  /**
   * 获取玩家信息
   */
  async _getPlayerInfo() {
    // 从游戏状态获取玩家信息
    try {
      const response = await fetch('/api/v1/user/profile');
      const profile = await response.json();
      return {
        username: profile.username,
        level: profile.level,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        username: 'Player',
        level: 1,
        timestamp: Date.now()
      };
    }
  }

  /**
   * 记录分享历史
   */
  _recordShare(record) {
    this.shareHistory.push({
      ...record,
      timestamp: Date.now()
    });

    // 限制历史大小
    if (this.shareHistory.length > this.maxHistorySize) {
      this.shareHistory.shift();
    }

    // 持久化到 localStorage
    try {
      localStorage.setItem('shareHistory', JSON.stringify(this.shareHistory.slice(-20)));
    } catch (e) {
      // 忽略存储错误
    }
  }

  /**
   * 获取分享历史
   */
  getShareHistory() {
    return this.shareHistory;
  }

  /**
   * 获取分享统计
   */
  getShareStats() {
    const stats = {
      total: this.shareHistory.length,
      byPlatform: {},
      byScene: {},
      successRate: 0
    };

    let successCount = 0;
    for (const record of this.shareHistory) {
      stats.byPlatform[record.platform] = (stats.byPlatform[record.platform] || 0) + 1;
      stats.byScene[record.scene] = (stats.byScene[record.scene] || 0) + 1;
      if (record.success) successCount++;
    }

    stats.successRate = stats.total > 0 ? successCount / stats.total : 0;
    return stats;
  }

  /**
   * 获取可用平台列表
   */
  getAvailablePlatforms(scene) {
    const template = this.templateManager.getTemplate(scene);
    if (!template) return [];

    return template.platforms.filter(platformId => 
      this.platformIntegration.isPlatformAvailable(platformId)
    );
  }
}

// 导出单例
module.exports = new ShareManager();
module.exports.ShareManager = ShareManager;
