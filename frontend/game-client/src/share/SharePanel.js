/**
 * 分享面板 UI 组件
 * REQ-00153: 游戏内截图分享与社交传播系统
 */

const ShareManager = require('./ShareManager');

class SharePanel {
  constructor(container) {
    this.container = container;
    this.shareManager = ShareManager;
    this.isVisible = false;
    this.currentScene = null;
    this.currentData = null;
    this.previewImage = null;
    
    this._initUI();
  }

  /**
   * 初始化 UI
   */
  _initUI() {
    this.panel = document.createElement('div');
    this.panel.className = 'share-panel';
    this.panel.style.cssText = `
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(26, 26, 46, 0.98);
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding: 20px;
      transform: translateY(100%);
      transition: transform 0.3s ease;
      z-index: 10000;
      max-height: 80vh;
      overflow-y: auto;
    `;

    this.panel.innerHTML = `
      <div class="share-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="color: #fff; margin: 0; font-size: 18px;">分享到</h3>
        <button class="share-close" style="background: none; border: none; color: #fff; font-size: 24px; cursor: pointer;">×</button>
      </div>
      
      <div class="share-preview" style="margin-bottom: 16px; text-align: center;">
        <img class="preview-image" style="max-width: 100%; max-height: 200px; border-radius: 8px; display: none;" />
        <div class="preview-loading" style="color: #888; padding: 40px;">加载预览中...</div>
      </div>
      
      <div class="share-content-editor" style="margin-bottom: 16px;">
        <textarea class="share-text" style="
          width: 100%;
          height: 80px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          color: #fff;
          padding: 12px;
          resize: none;
          font-size: 14px;
        " placeholder="添加分享文字..."></textarea>
      </div>
      
      <div class="share-platforms" style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;">
        <!-- 平台按钮将动态生成 -->
      </div>
      
      <div class="share-options" style="display: flex; gap: 16px; margin-bottom: 16px; color: #aaa; font-size: 14px;">
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input type="checkbox" class="option-watermark" checked />
          添加水印
        </label>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
          <input type="checkbox" class="option-player-info" checked />
          显示玩家信息
        </label>
      </div>
      
      <div class="share-stats" style="color: #666; font-size: 12px; text-align: center;">
        <!-- 分享统计 -->
      </div>
    `;

    // 绑定事件
    this.panel.querySelector('.share-close').addEventListener('click', () => this.hide());
    
    document.body.appendChild(this.panel);
  }

  /**
   * 显示分享面板
   */
  async show(scene, data) {
    this.currentScene = scene;
    this.currentData = data;
    this.isVisible = true;

    // 显示面板
    this.panel.style.transform = 'translateY(0)';

    // 生成预览
    await this._generatePreview();

    // 生成平台按钮
    this._renderPlatformButtons();

    // 更新统计
    this._updateStats();
  }

  /**
   * 隐藏分享面板
   */
  hide() {
    this.isVisible = false;
    this.panel.style.transform = 'translateY(100%)';
  }

  /**
   * 生成预览
   */
  async _generatePreview() {
    const previewImg = this.panel.querySelector('.preview-image');
    const loadingDiv = this.panel.querySelector('.preview-loading');

    try {
      loadingDiv.style.display = 'block';
      previewImg.style.display = 'none';

      // 捕获截图
      const screenshot = await this.shareManager.screenshotCapture.captureGameCanvas();
      
      // 获取预设
      const preset = this.shareManager.screenshotCapture.getScenePreset(this.currentScene);

      // 添加水印
      let imageData = screenshot;
      if (this.panel.querySelector('.option-watermark').checked && preset.watermark) {
        imageData = await this.shareManager.screenshotCapture.addWatermark(imageData, preset.watermark);
      }

      // 显示预览
      previewImg.src = imageData.dataUrl;
      previewImg.style.display = 'block';
      loadingDiv.style.display = 'none';
      this.previewImage = imageData;

      // 预填充分享文字
      const content = this.shareManager.templateManager.generateContent(this.currentScene, this.currentData);
      this.panel.querySelector('.share-text').value = `${content.title}\n\n${content.description}`;

    } catch (error) {
      console.error('Preview generation failed:', error);
      loadingDiv.textContent = '预览生成失败';
    }
  }

  /**
   * 渲染平台按钮
   */
  _renderPlatformButtons() {
    const container = this.panel.querySelector('.share-platforms');
    const platforms = this.shareManager.getAvailablePlatforms(this.currentScene);

    container.innerHTML = platforms.map(platformId => {
      const platform = this.shareManager.platformIntegration.getPlatform(platformId);
      const available = this.shareManager.platformIntegration.isPlatformAvailable(platformId);
      
      return `
        <button class="share-platform-btn" data-platform="${platformId}" style="
          flex: 1;
          min-width: 80px;
          padding: 12px 16px;
          background: ${platform.color};
          border: none;
          border-radius: 8px;
          color: #fff;
          font-size: 14px;
          font-weight: bold;
          cursor: ${available ? 'pointer' : 'not-allowed'};
          opacity: ${available ? 1 : 0.5};
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        ">
          <span class="platform-icon">${this._getPlatformIcon(platformId)}</span>
          ${platform.name}
        </button>
      `;
    }).join('');

    // 绑定点击事件
    container.querySelectorAll('.share-platform-btn').forEach(btn => {
      btn.addEventListener('click', () => this._handleShare(btn.dataset.platform));
    });
  }

  /**
   * 获取平台图标
   */
  _getPlatformIcon(platformId) {
    const icons = {
      wechat: '💬',
      weibo: '📢',
      twitter: '🐦',
      facebook: '📘',
      system: '📤'
    };
    return icons[platformId] || '📤';
  }

  /**
   * 处理分享
   */
  async _handleShare(platform) {
    const btn = this.panel.querySelector(`[data-platform="${platform}"]`);
    const originalText = btn.innerHTML;
    
    try {
      btn.disabled = true;
      btn.innerHTML = '分享中...';

      const customText = this.panel.querySelector('.share-text').value;
      const showWatermark = this.panel.querySelector('.option-watermark').checked;
      const showPlayerInfo = this.panel.querySelector('.option-player-info').checked;

      const result = await this.shareManager.share({
        scene: this.currentScene,
        platform,
        data: {
          ...this.currentData,
          customText
        },
        screenshot: this.previewImage,
        showWatermark,
        showPlayerInfo
      });

      if (result.success) {
        btn.innerHTML = '✓ 已分享';
        btn.style.background = '#28a745';
        
        // 1.5 秒后关闭面板
        setTimeout(() => this.hide(), 1500);
      } else {
        throw new Error(result.error || '分享失败');
      }

    } catch (error) {
      console.error('Share failed:', error);
      btn.innerHTML = '分享失败';
      btn.style.background = '#dc3545';
      
      setTimeout(() => {
        btn.innerHTML = originalText;
        btn.style.background = '';
        btn.disabled = false;
      }, 2000);
    }
  }

  /**
   * 更新统计
   */
  _updateStats() {
    const stats = this.shareManager.getShareStats();
    const statsDiv = this.panel.querySelector('.share-stats');
    
    if (stats.total > 0) {
      statsDiv.innerHTML = `
        累计分享 ${stats.total} 次 · 成功率 ${(stats.successRate * 100).toFixed(1)}%
      `;
    }
  }

  /**
   * 销毁
   */
  destroy() {
    this.panel.remove();
  }
}

module.exports = SharePanel;
