/**
 * 社交平台集成
 * REQ-00153: 游戏内截图分享与社交传播系统
 */

class SocialPlatformIntegration {
  constructor() {
    this.platforms = new Map();
    this._initPlatforms();
  }

  /**
   * 初始化平台配置
   */
  _initPlatforms() {
    // 微信
    this.registerPlatform('wechat', {
      name: '微信',
      icon: 'wechat-icon',
      color: '#07C160',
      share: async (data) => {
        // 微信 JS-SDK 分享
        if (typeof wx !== 'undefined' && wx.ready) {
          return new Promise((resolve) => {
            wx.ready(() => {
              wx.shareAppMessage({
                title: data.title,
                desc: data.desc,
                link: data.link || window.location.href,
                imgUrl: data.imageUrl,
                success: () => resolve({ success: true, platform: 'wechat' }),
                fail: (err) => resolve({ success: false, error: err })
              });
            });
          });
        }
        // 回退：复制链接
        return this._fallbackShare('wechat', data);
      }
    });

    // 微博
    this.registerPlatform('weibo', {
      name: '微博',
      icon: 'weibo-icon',
      color: '#E6162D',
      share: async (data) => {
        const text = encodeURIComponent(data.text || '');
        const imageUrl = encodeURIComponent(data.imageUrl || '');
        const weiboUrl = `https://service.weibo.com/share/share.php?title=${text}&pic=${imageUrl}`;
        window.open(weiboUrl, '_blank', 'width=600,height=400');
        return { success: true, platform: 'weibo' };
      }
    });

    // Twitter
    this.registerPlatform('twitter', {
      name: 'Twitter',
      icon: 'twitter-icon',
      color: '#1DA1F2',
      share: async (data) => {
        const text = encodeURIComponent(data.text || '');
        const url = encodeURIComponent(data.link || window.location.href);
        const twitterUrl = `https://twitter.com/intent/tweet?text=${text}&url=${url}`;
        window.open(twitterUrl, '_blank', 'width=600,height=400');
        return { success: true, platform: 'twitter' };
      }
    });

    // Facebook
    this.registerPlatform('facebook', {
      name: 'Facebook',
      icon: 'facebook-icon',
      color: '#1877F2',
      share: async (data) => {
        const url = encodeURIComponent(data.link || window.location.href);
        const quote = encodeURIComponent(data.quote || '');
        const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${url}&quote=${quote}`;
        window.open(fbUrl, '_blank', 'width=600,height=400');
        return { success: true, platform: 'facebook' };
      }
    });

    // 系统分享
    this.registerPlatform('system', {
      name: '系统分享',
      icon: 'share-icon',
      color: '#666666',
      share: async (data) => {
        if (navigator.share) {
          try {
            await navigator.share({
              title: data.title,
              text: data.text,
              url: data.link || window.location.href,
              files: data.files ? [data.files] : undefined
            });
            return { success: true, platform: 'system' };
          } catch (err) {
            if (err.name === 'AbortError') {
              return { success: false, reason: 'cancelled' };
            }
            throw err;
          }
        }
        // 回退：复制到剪贴板
        return this._fallbackShare('system', data);
      }
    });
  }

  /**
   * 注册平台
   */
  registerPlatform(platformId, config) {
    this.platforms.set(platformId, {
      id: platformId,
      ...config
    });
  }

  /**
   * 获取平台配置
   */
  getPlatform(platformId) {
    return this.platforms.get(platformId);
  }

  /**
   * 获取所有平台
   */
  getAllPlatforms() {
    return Array.from(this.platforms.values());
  }

  /**
   * 检查平台是否可用
   */
  isPlatformAvailable(platformId) {
    switch (platformId) {
      case 'wechat':
        return typeof wx !== 'undefined';
      case 'system':
        return typeof navigator.share === 'function';
      default:
        return true;
    }
  }

  /**
   * 执行分享
   */
  async share(platformId, data) {
    const platform = this.getPlatform(platformId);
    if (!platform) {
      throw new Error(`Platform not found: ${platformId}`);
    }

    if (!this.isPlatformAvailable(platformId)) {
      return this._fallbackShare(platformId, data);
    }

    try {
      const result = await platform.share(data);
      
      // 记录分享事件
      this._trackShare(platformId, result.success);
      
      return result;
    } catch (error) {
      console.error(`Share failed on ${platformId}:`, error);
      return { success: false, platform: platformId, error: error.message };
    }
  }

  /**
   * 回退分享方案
   */
  async _fallbackShare(platformId, data) {
    const textToCopy = `${data.title || ''}\n${data.text || data.desc || ''}\n${data.link || window.location.href}`;
    
    try {
      await navigator.clipboard.writeText(textToCopy);
      return {
        success: true,
        platform: platformId,
        method: 'clipboard',
        message: '内容已复制到剪贴板'
      };
    } catch (err) {
      // 旧浏览器回退
      const textarea = document.createElement('textarea');
      textarea.value = textToCopy;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      
      return {
        success,
        platform: platformId,
        method: 'clipboard',
        message: success ? '内容已复制到剪贴板' : '复制失败'
      };
    }
  }

  /**
   * 追踪分享事件
   */
  _trackShare(platformId, success) {
    // 发送到分析服务
    if (typeof gtag !== 'undefined') {
      gtag('event', 'share', {
        platform: platformId,
        success: success
      });
    }

    // 发送到后端统计
    fetch('/api/v1/share/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: platformId,
        success: success,
        timestamp: Date.now()
      })
    }).catch(() => {}); // 静默失败
  }

  /**
   * 批量分享到多个平台
   */
  async shareToMultiple(platformIds, data) {
    const results = await Promise.allSettled(
      platformIds.map(platformId => this.share(platformId, data))
    );
    
    return results.map((result, index) => ({
      platform: platformIds[index],
      ...(result.status === 'fulfilled' ? result.value : { success: false, error: result.reason })
    }));
  }
}

// 导出单例
module.exports = new SocialPlatformIntegration();
module.exports.SocialPlatformIntegration = SocialPlatformIntegration;
