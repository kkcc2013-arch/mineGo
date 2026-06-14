/**
 * 业务指标仪表板组件
 * REQ-00094: 实时业务指标仪表板与运营监控系统
 */

class BusinessDashboard {
  constructor(options = {}) {
    this.containerId = options.containerId || 'business-dashboard';
    this.refreshInterval = options.refreshInterval || 30000; // 30秒刷新
    this.apiBase = options.apiBase || '/api/admin/metrics';
    this.charts = {};
    this.metrics = null;
    this.autoRefreshTimer = null;
  }

  /**
   * 初始化仪表板
   */
  async init() {
    console.log('Initializing Business Dashboard...');
    
    // 创建容器
    this.createContainer();
    
    // 加载初始数据
    await this.loadMetrics();
    
    // 渲染组件
    this.renderOverviewCards();
    this.renderPlayerChart();
    this.renderRevenueChart();
    this.renderGeoMap();
    this.renderAlerts();
    
    // 启动自动刷新
    this.startAutoRefresh();
    
    console.log('Business Dashboard initialized');
  }

  /**
   * 创建容器
   */
  createContainer() {
    const container = document.getElementById(this.containerId);
    if (!container) {
      console.error(`Container #${this.containerId} not found`);
      return;
    }
    
    container.innerHTML = `
      <div class="dashboard-header">
        <h2>🎮 mineGo 业务监控仪表板</h2>
        <div class="refresh-info">
          <span id="last-update">最后更新: --</span>
          <button onclick="dashboard.refresh()" class="refresh-btn">刷新</button>
        </div>
      </div>
      
      <div class="dashboard-grid">
        <!-- 概览卡片 -->
        <div id="overview-cards" class="overview-section"></div>
        
        <!-- 玩家趋势图 -->
        <div class="chart-section">
          <h3>📈 玩家趋势</h3>
          <canvas id="player-chart" width="800" height="300"></canvas>
        </div>
        
        <!-- 收入趋势图 -->
        <div class="chart-section">
          <h3>💰 收入趋势</h3>
          <canvas id="revenue-chart" width="800" height="300"></canvas>
        </div>
        
        <!-- 地理分布 -->
        <div class="map-section">
          <h3>🌍 地理分布</h3>
          <div id="geo-map"></div>
        </div>
        
        <!-- 告警列表 -->
        <div class="alerts-section">
          <h3>⚠️ 业务告警</h3>
          <div id="alerts-list"></div>
        </div>
      </div>
    `;
  }

  /**
   * 加载指标数据
   */
  async loadMetrics() {
    try {
      const response = await fetch(`${this.apiBase}/realtime`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      this.metrics = await response.json();
      this.updateLastUpdateTime();
      
    } catch (error) {
      console.error('Failed to load metrics:', error);
      this.showError('加载指标失败，请检查网络连接');
    }
  }

  /**
   * 渲染概览卡片
   */
  renderOverviewCards() {
    if (!this.metrics) return;
    
    const container = document.getElementById('overview-cards');
    const cards = [
      {
        title: '在线玩家',
        value: this.formatNumber(this.metrics.players.online),
        icon: '👥',
        trend: '+5%',
        trendClass: 'trend-up'
      },
      {
        title: '今日 DAU',
        value: this.formatNumber(this.metrics.players.dau),
        icon: '📈',
        trend: '+12%',
        trendClass: 'trend-up'
      },
      {
        title: '捕捉成功率',
        value: `${(this.metrics.pokemon.catchRate * 100).toFixed(1)}%`,
        icon: '🎯',
        trend: null
      },
      {
        title: '今日收入',
        value: `¥${(this.metrics.payment.revenue / 100).toFixed(2)}`,
        icon: '💰',
        trend: '+8%',
        trendClass: 'trend-up'
      },
      {
        title: '付费转化率',
        value: `${(this.metrics.payment.conversion * 100).toFixed(2)}%`,
        icon: '💳',
        trend: null
      },
      {
        title: '今日订单',
        value: this.formatNumber(this.metrics.payment.orders),
        icon: '📦',
        trend: null
      }
    ];
    
    container.innerHTML = cards.map(card => `
      <div class="metric-card">
        <div class="card-icon">${card.icon}</div>
        <div class="card-content">
          <div class="card-title">${card.title}</div>
          <div class="card-value">${card.value}</div>
          ${card.trend ? `<div class="card-trend ${card.trendClass}">${card.trend}</div>` : ''}
        </div>
      </div>
    `).join('');
  }

  /**
   * 渲染玩家趋势图
   */
  async renderPlayerChart() {
    try {
      const response = await fetch(`${this.apiBase}/hourly`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const data = await response.json();
      
      // 使用 Chart.js 渲染（假设已加载）
      if (typeof Chart !== 'undefined') {
        const ctx = document.getElementById('player-chart').getContext('2d');
        
        if (this.charts.player) {
          this.charts.player.destroy();
        }
        
        this.charts.player = new Chart(ctx, {
          type: 'line',
          data: {
            labels: data.data.map(d => new Date(d.hour).toLocaleTimeString()),
            datasets: [{
              label: '活跃用户',
              data: data.data.map(d => d.active_users),
              borderColor: 'rgb(75, 192, 192)',
              tension: 0.1
            }]
          },
          options: {
            responsive: true,
            scales: {
              y: {
                beginAtZero: true
              }
            }
          }
        });
      }
    } catch (error) {
      console.error('Failed to render player chart:', error);
    }
  }

  /**
   * 渲染收入趋势图
   */
  async renderRevenueChart() {
    try {
      const response = await fetch(`${this.apiBase}/daily`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const data = await response.json();
      
      if (typeof Chart !== 'undefined') {
        const ctx = document.getElementById('revenue-chart').getContext('2d');
        
        if (this.charts.revenue) {
          this.charts.revenue.destroy();
        }
        
        this.charts.revenue = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: data.data.map(d => d.date),
            datasets: [{
              label: '收入 (¥)',
              data: data.data.map(d => d.revenue / 100),
              backgroundColor: 'rgba(54, 162, 235, 0.5)'
            }]
          },
          options: {
            responsive: true,
            scales: {
              y: {
                beginAtZero: true
              }
            }
          }
        });
      }
    } catch (error) {
      console.error('Failed to render revenue chart:', error);
    }
  }

  /**
   * 渲染地理分布
   */
  async renderGeoMap() {
    try {
      const response = await fetch(`${this.apiBase}/geo`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const data = await response.json();
      const container = document.getElementById('geo-map');
      
      // 简单的表格展示（实际项目中可使用地图库）
      container.innerHTML = `
        <table class="geo-table">
          <thead>
            <tr>
              <th>国家/地区</th>
              <th>玩家数</th>
            </tr>
          </thead>
          <tbody>
            ${data.distribution.slice(0, 20).map(item => `
              <tr>
                <td>${item.country} - ${item.region}</td>
                <td>${this.formatNumber(item.player_count)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (error) {
      console.error('Failed to render geo map:', error);
    }
  }

  /**
   * 渲染告警列表
   */
  renderAlerts() {
    const container = document.getElementById('alerts-list');
    
    // 模拟告警数据（实际应从 Prometheus Alertmanager 获取）
    const alerts = [
      {
        severity: 'info',
        message: '捕捉成功率正常 (45.2%)',
        time: new Date()
      }
    ];
    
    if (alerts.length === 0) {
      container.innerHTML = '<p class="no-alerts">✅ 无业务告警</p>';
      return;
    }
    
    container.innerHTML = alerts.map(alert => `
      <div class="alert-item alert-${alert.severity}">
        <span class="alert-time">${new Date(alert.time).toLocaleTimeString()}</span>
        <span class="alert-message">${alert.message}</span>
      </div>
    `).join('');
  }

  /**
   * 启动自动刷新
   */
  startAutoRefresh() {
    this.autoRefreshTimer = setInterval(async () => {
      await this.refresh();
    }, this.refreshInterval);
  }

  /**
   * 停止自动刷新
   */
  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  /**
   * 手动刷新
   */
  async refresh() {
    await this.loadMetrics();
    this.renderOverviewCards();
    this.renderPlayerChart();
    this.renderRevenueChart();
    this.renderGeoMap();
  }

  /**
   * 更新最后更新时间
   */
  updateLastUpdateTime() {
    const element = document.getElementById('last-update');
    if (element) {
      element.textContent = `最后更新: ${new Date().toLocaleTimeString()}`;
    }
  }

  /**
   * 显示错误
   */
  showError(message) {
    const container = document.getElementById(this.containerId);
    if (container) {
      container.innerHTML = `
        <div class="error-message">
          <p>❌ ${message}</p>
          <button onclick="dashboard.init()">重试</button>
        </div>
      `;
    }
  }

  /**
   * 格式化数字
   */
  formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  /**
   * 销毁
   */
  destroy() {
    this.stopAutoRefresh();
    Object.values(this.charts).forEach(chart => {
      if (chart && chart.destroy) {
        chart.destroy();
      }
    });
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BusinessDashboard;
}

// 全局实例（用于 HTML onclick）
let dashboard;
