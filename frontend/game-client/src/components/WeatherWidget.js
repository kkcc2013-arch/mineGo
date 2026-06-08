/**
 * 天气组件 - 显示当前天气和加成信息
 * 集成真实天气 API，提供天气可视化和精灵加成信息
 * 
 * @module WeatherWidget
 */

const { i18n } = require('../i18n');

class WeatherWidget {
  /**
   * 构造函数
   * @param {string} containerId - 容器元素 ID
   * @param {Object} options - 配置选项
   */
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.weatherData = null;
    this.apiBaseUrl = options.apiBaseUrl || window.API_BASE_URL || '';
    this.onWeatherUpdate = options.onWeatherUpdate || null;
    this.updateInterval = options.updateInterval || 900000; // 15 分钟
    
    this.startAutoUpdate();
  }

  /**
   * 获取天气数据
   * @param {number} lat 纬度
   * @param {number} lng 经度
   */
  async fetchWeather(lat, lng) {
    try {
      const token = this.getToken();
      if (!token) {
        console.warn('WeatherWidget: No auth token available');
        return;
      }

      const response = await fetch(
        `${this.apiBaseUrl}/map/weather?lat=${lat}&lng=${lng}`,
        { 
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Accept-Language': i18n.getLanguage() || 'zh-CN'
          } 
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      this.weatherData = data.data;
      this.render();
      
      // 触发回调
      if (this.onWeatherUpdate) {
        this.onWeatherUpdate(this.weatherData);
      }
    } catch (error) {
      console.error('Failed to fetch weather:', error);
      this.renderError();
    }
  }

  /**
   * 渲染天气组件
   */
  render() {
    if (!this.weatherData || !this.container) return;

    const { 
      weather, 
      description, 
      temperature, 
      humidity,
      windSpeed,
      location,
      boostedTypesZh,
      fallback 
    } = this.weatherData;

    const emoji = this.getWeatherEmoji(weather);
    const weatherLabel = i18n.t(`weather.${weather.toLowerCase()}`) || weather;

    this.container.innerHTML = `
      <div class="weather-widget ${fallback ? 'weather-fallback' : ''}" 
           role="region" 
           aria-label="${i18n.t('weather.current_weather') || '当前天气'}">
        <div class="weather-icon" aria-hidden="true">${emoji}</div>
        <div class="weather-info">
          <div class="weather-status">
            <span class="weather-label">${weatherLabel}</span>
            <span class="weather-temp">${Math.round(temperature)}°C</span>
          </div>
          <div class="weather-details">
            <span class="weather-location">${location}</span>
            ${humidity ? `<span class="weather-humidity">💧 ${humidity}%</span>` : ''}
            ${windSpeed ? `<span class="weather-wind">💨 ${windSpeed} km/h</span>` : ''}
          </div>
          ${boostedTypesZh && boostedTypesZh.length > 0 ? `
            <div class="weather-bonus">
              <span class="bonus-label">${i18n.t('weather.boosted') || '天气加成'}:</span>
              <span class="bonus-types">${boostedTypesZh.join(' / ')}</span>
            </div>
          ` : ''}
          ${fallback ? `
            <div class="weather-notice">
              <span class="notice-icon">⚠️</span>
              <span class="notice-text">${i18n.t('weather.fallback_notice') || '天气数据暂不可用，使用模拟数据'}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    // 应用天气效果到地图
    this.applyWeatherEffects(weather);
  }

  /**
   * 渲染错误状态
   */
  renderError() {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="weather-widget weather-error" role="alert">
        <div class="weather-icon">🌤️</div>
        <div class="weather-info">
          <div class="weather-status">${i18n.t('weather.unavailable') || '天气数据不可用'}</div>
        </div>
      </div>
    `;
  }

  /**
   * 获取天气对应的 emoji
   * @param {string} weather 天气类型
   * @returns {string} emoji
   */
  getWeatherEmoji(weather) {
    const emojis = {
      SUNNY: '☀️',
      CLOUDY: '☁️',
      RAINY: '🌧️',
      SNOWY: '❄️',
      WINDY: '💨',
      FOGGY: '🌫️'
    };
    return emojis[weather] || '🌤️';
  }

  /**
   * 应用天气视觉效果到地图容器
   * @param {string} weather 天气类型
   */
  applyWeatherEffects(weather) {
    const mapContainer = document.getElementById('map-container') || 
                         document.querySelector('.game-map');
    if (!mapContainer) return;

    // 移除旧天气效果
    mapContainer.classList.remove(
      'weather-sunny', 'weather-cloudy', 'weather-rainy', 
      'weather-snowy', 'weather-windy', 'weather-foggy'
    );
    
    // 添加新天气效果
    const effectClass = `weather-${weather.toLowerCase()}`;
    mapContainer.classList.add(effectClass);

    // 添加天气粒子效果（可选）
    this.addWeatherParticles(weather, mapContainer);
  }

  /**
   * 添加天气粒子效果
   * @param {string} weather 天气类型
   * @param {HTMLElement} container 容器元素
   */
  addWeatherParticles(weather, container) {
    // 移除旧粒子
    const oldParticles = container.querySelector('.weather-particles');
    if (oldParticles) {
      oldParticles.remove();
    }

    // 雨天和雪天添加粒子效果
    if (weather === 'RAINY' || weather === 'SNOWY') {
      const particles = document.createElement('div');
      particles.className = 'weather-particles';
      particles.setAttribute('aria-hidden', 'true');
      container.appendChild(particles);
    }
  }

  /**
   * 获取认证 token
   * @returns {string|null} token
   */
  getToken() {
    return localStorage.getItem('token') || 
           localStorage.getItem('auth_token') ||
           sessionStorage.getItem('token');
  }

  /**
   * 启动自动更新
   */
  startAutoUpdate() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    // 每 15 分钟更新一次
    this.updateTimer = setInterval(() => {
      if (this.lastLat && this.lastLng) {
        this.fetchWeather(this.lastLat, this.lastLng);
      }
    }, this.updateInterval);
  }

  /**
   * 停止自动更新
   */
  stopAutoUpdate() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /**
   * 更新位置并获取天气
   * @param {number} lat 纬度
   * @param {number} lng 经度
   */
  updatePosition(lat, lng) {
    this.lastLat = lat;
    this.lastLng = lng;
    this.fetchWeather(lat, lng);
  }

  /**
   * 销毁组件
   */
  destroy() {
    this.stopAutoUpdate();
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// 导出模块
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WeatherWidget;
} else if (typeof window !== 'undefined') {
  window.WeatherWidget = WeatherWidget;
}
