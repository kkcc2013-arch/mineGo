/**
 * Cookie 同意横幅组件
 * REQ-00322: Cookie 同意管理与隐私偏好中心
 */

class CookieConsentBanner {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.onAccept = options.onAccept || (() => {});
    this.onReject = options.onReject || (() => {});
    this.onPreferencesOpen = options.onPreferencesOpen || (() => {});
    
    this.consent = null;
    this.isVisible = false;
    
    this.init();
  }

  async init() {
    // 检查是否已有同意记录
    await this.loadConsent();
    
    // 如果没有同意记录，显示横幅
    if (!this.consent?.hasConsent) {
      this.show();
    } else {
      // 应用已保存的同意设置
      this.applyConsent(this.consent.categories);
    }
  }

  async loadConsent() {
    try {
      const response = await fetch('/api/v1/privacy/consent', {
        credentials: 'include'
      });
      const data = await response.json();
      
      if (data.success) {
        this.consent = data.data;
      }
    } catch (error) {
      console.error('Failed to load consent:', error);
    }
  }

  show() {
    if (this.isVisible) return;
    
    const banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.innerHTML = this.render();
    
    this.container.appendChild(banner);
    this.isVisible = true;
    
    // 绑定事件
    this.bindEvents(banner);
  }

  hide() {
    const banner = document.getElementById('cookie-consent-banner');
    if (banner) {
      banner.remove();
      this.isVisible = false;
    }
  }

  render() {
    return `
      <div class="cookie-banner-overlay">
        <div class="cookie-banner">
          <div class="cookie-banner-header">
            <h3>🍪 Cookie 使用说明</h3>
            <button class="close-btn" aria-label="关闭">×</button>
          </div>
          
          <div class="cookie-banner-content">
            <p>
              我们使用 Cookie 和类似技术来提供、改进和个性化我们的服务。
              点击"接受所有"即表示您同意我们使用所有 Cookie。
              您也可以选择仅使用必要 Cookie 或自定义您的偏好设置。
            </p>
            <p class="learn-more">
              <a href="/privacy/cookies" target="_blank">了解有关 Cookie 的更多信息</a>
            </p>
          </div>
          
          <div class="cookie-banner-actions">
            <button class="btn-reject" id="btn-reject-all">
              仅必要 Cookie
            </button>
            <button class="btn-preferences" id="btn-preferences">
              管理偏好
            </button>
            <button class="btn-accept" id="btn-accept-all">
              接受所有
            </button>
          </div>
        </div>
      </div>
      
      <style>
        .cookie-banner-overlay {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: rgba(0, 0, 0, 0.8);
          backdrop-filter: blur(4px);
          z-index: 9999;
          padding: 16px;
          animation: slideUp 0.3s ease-out;
        }
        
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        
        .cookie-banner {
          max-width: 1200px;
          margin: 0 auto;
          background: #ffffff;
          border-radius: 12px;
          padding: 24px;
          box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.2);
        }
        
        .cookie-banner-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }
        
        .cookie-banner-header h3 {
          margin: 0;
          font-size: 20px;
          color: #333;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 28px;
          color: #666;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: #333;
        }
        
        .cookie-banner-content p {
          margin: 0 0 12px 0;
          color: #555;
          line-height: 1.6;
        }
        
        .learn-more {
          font-size: 14px;
        }
        
        .learn-more a {
          color: #2196F3;
          text-decoration: none;
        }
        
        .learn-more a:hover {
          text-decoration: underline;
        }
        
        .cookie-banner-actions {
          display: flex;
          gap: 12px;
          margin-top: 20px;
          flex-wrap: wrap;
        }
        
        .cookie-banner-actions button {
          flex: 1;
          min-width: 140px;
          padding: 12px 24px;
          border: none;
          border-radius: 6px;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .btn-accept {
          background: #4CAF50;
          color: white;
        }
        
        .btn-accept:hover {
          background: #45a049;
        }
        
        .btn-reject {
          background: #f5f5f5;
          color: #333;
          border: 1px solid #ddd;
        }
        
        .btn-reject:hover {
          background: #e0e0e0;
        }
        
        .btn-preferences {
          background: #2196F3;
          color: white;
        }
        
        .btn-preferences:hover {
          background: #1976D2;
        }
        
        @media (max-width: 768px) {
          .cookie-banner {
            padding: 16px;
          }
          
          .cookie-banner-actions {
            flex-direction: column;
          }
          
          .cookie-banner-actions button {
            width: 100%;
          }
        }
      </style>
    `;
  }

  bindEvents(banner) {
    const acceptBtn = banner.querySelector('#btn-accept-all');
    const rejectBtn = banner.querySelector('#btn-reject-all');
    const preferencesBtn = banner.querySelector('#btn-preferences');
    const closeBtn = banner.querySelector('.close-btn');
    
    acceptBtn?.addEventListener('click', () => this.acceptAll());
    rejectBtn?.addEventListener('click', () => this.rejectAll());
    preferencesBtn?.addEventListener('click', () => this.openPreferences());
    closeBtn?.addEventListener('click', () => this.hide());
  }

  async acceptAll() {
    try {
      const response = await fetch('/api/v1/privacy/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ acceptAll: true, source: 'banner' })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.consent = { hasConsent: true, categories: data.data.categories };
        this.applyConsent(data.data.categories);
        this.hide();
        this.onAccept(data.data.categories);
      }
    } catch (error) {
      console.error('Failed to accept cookies:', error);
    }
  }

  async rejectAll() {
    try {
      const response = await fetch('/api/v1/privacy/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ rejectAll: true, source: 'banner' })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.consent = { hasConsent: true, categories: data.data.categories };
        this.applyConsent(data.data.categories);
        this.hide();
        this.onReject(data.data.categories);
      }
    } catch (error) {
      console.error('Failed to reject cookies:', error);
    }
  }

  openPreferences() {
    this.hide();
    this.onPreferencesOpen();
  }

  applyConsent(categories) {
    // 启用/禁用第三方脚本
    if (categories.analytics) {
      this.enableGoogleAnalytics();
    } else {
      this.disableGoogleAnalytics();
    }
    
    if (categories.marketing) {
      this.enableFacebookPixel();
    } else {
      this.disableFacebookPixel();
    }
    
    // 更新 Google Tag Manager 同意模式
    if (window.gtag) {
      window.gtag('consent', 'update', {
        'analytics_storage': categories.analytics ? 'granted' : 'denied',
        'ad_storage': categories.marketing ? 'granted' : 'denied',
        'functionality_storage': categories.functional ? 'granted' : 'denied',
        'personalization_storage': categories.functional ? 'granted' : 'denied'
      });
    }
    
    // 保存到 localStorage 以供快速访问
    localStorage.setItem('cookieConsent', JSON.stringify(categories));
  }

  enableGoogleAnalytics() {
    if (!window.gaInitialized && window.gaId) {
      const script = document.createElement('script');
      script.src = `https://www.googletagmanager.com/gtag/js?id=${window.gaId}`;
      script.async = true;
      document.head.appendChild(script);
      
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', window.gaId);
      
      window.gaInitialized = true;
    }
  }

  disableGoogleAnalytics() {
    if (window.gaInitialized) {
      window[`ga-disable-${window.gaId}`] = true;
    }
  }

  enableFacebookPixel() {
    if (!window.fbq) {
      const script = document.createElement('script');
      script.innerHTML = `
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(window, document,'script',
        'https://connect.facebook.net/en_US/fbevents.js');
        fbq('init', '${window.fbPixelId}');
        fbq('track', 'PageView');
      `;
      document.head.appendChild(script);
    }
  }

  disableFacebookPixel() {
    if (window.fbq) {
      window.fbq('consent', 'revoke');
    }
  }
}

module.exports = CookieConsentBanner;
