// frontend/game-client/src/components/TimezoneSelector.js
// REQ-00029: 游戏事件时区本地化与多时区支持
// 时区选择器组件

'use strict';

import { detectUserTimezone, setTimezone, getTimezoneOffset, getCurrentLocalTime } from '../utils/timezone.js';

export class TimezoneSelector {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      onTimezoneChange: null,
      showLocalTime: true,
      ...options
    };
    
    // 常用时区列表
    this.timezones = [
      { id: 'UTC', label: 'UTC (协调世界时)', offset: '+00:00' },
      { id: 'Asia/Shanghai', label: '中国标准时间 (北京)', offset: '+08:00' },
      { id: 'Asia/Tokyo', label: '日本标准时间', offset: '+09:00' },
      { id: 'Asia/Seoul', label: '韩国标准时间', offset: '+09:00' },
      { id: 'Asia/Hong_Kong', label: '香港时间', offset: '+08:00' },
      { id: 'Asia/Taipei', label: '台北时间', offset: '+08:00' },
      { id: 'Asia/Singapore', label: '新加坡时间', offset: '+08:00' },
      { id: 'America/New_York', label: '美国东部时间', offset: '-05:00' },
      { id: 'America/Chicago', label: '美国中部时间', offset: '-06:00' },
      { id: 'America/Denver', label: '美国山地时间', offset: '-07:00' },
      { id: 'America/Los_Angeles', label: '美国太平洋时间', offset: '-08:00' },
      { id: 'Europe/London', label: '英国时间', offset: '+00:00' },
      { id: 'Europe/Paris', label: '中欧时间', offset: '+01:00' },
      { id: 'Europe/Berlin', label: '德国时间', offset: '+01:00' },
      { id: 'Europe/Moscow', label: '莫斯科时间', offset: '+03:00' },
      { id: 'Australia/Sydney', label: '悉尼时间', offset: '+11:00' },
      { id: 'Pacific/Auckland', label: '新西兰时间', offset: '+13:00' }
    ];
    
    this.currentTimezone = detectUserTimezone();
    this.render();
    this.attachEventListeners();
    this.startLocalTimeUpdate();
  }

  render() {
    const current = this.currentTimezone;
    const offset = getTimezoneOffset(current);
    const localTime = getCurrentLocalTime(current);

    this.container.innerHTML = `
      <div class="timezone-selector">
        <div class="timezone-current">
          <span class="timezone-label">时区:</span>
          <span class="timezone-value">${current} (${offset})</span>
          ${this.options.showLocalTime ? `
            <span class="timezone-local-time" id="local-time-display">
              ${localTime}
            </span>
          ` : ''}
        </div>
        
        <div class="timezone-controls">
          <select id="timezone-select" class="timezone-select-input" aria-label="选择时区">
            <optgroup label="常用时区">
              ${this.timezones.map(tz => `
                <option value="${tz.id}" ${tz.id === current ? 'selected' : ''}>
                  ${tz.label} (${tz.offset})
                </option>
              `).join('')}
            </optgroup>
            <optgroup label="其他">
              <option value="custom">自定义时区...</option>
            </optgroup>
          </select>
          
          <input 
            type="text" 
            id="custom-timezone" 
            class="custom-timezone-input"
            placeholder="输入时区，如 Asia/Shanghai"
            style="display: none;"
            aria-label="自定义时区输入"
          />
        </div>
        
        <div class="timezone-info" id="timezone-info" style="display: none;">
          <p class="timezone-warning">⚠️ 时区设置将影响所有时间显示</p>
        </div>
      </div>
      
      <style>
        .timezone-selector {
          padding: 16px;
          background: var(--bg-secondary, #f5f5f5);
          border-radius: 8px;
          margin: 8px 0;
        }
        
        .timezone-current {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        
        .timezone-label {
          font-weight: 600;
          color: var(--text-secondary, #666);
        }
        
        .timezone-value {
          color: var(--accent-primary, #0052cc);
          font-family: monospace;
        }
        
        .timezone-local-time {
          background: var(--bg-primary, #fff);
          padding: 4px 8px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 14px;
        }
        
        .timezone-controls {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        
        .timezone-select-input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border-color, #ddd);
          border-radius: 4px;
          background: var(--bg-primary, #fff);
          font-size: 14px;
          cursor: pointer;
        }
        
        .custom-timezone-input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border-color, #ddd);
          border-radius: 4px;
          background: var(--bg-primary, #fff);
          font-size: 14px;
        }
        
        .timezone-info {
          margin-top: 12px;
          padding: 8px;
          background: var(--warning-bg, #fff3cd);
          border-radius: 4px;
          font-size: 13px;
        }
        
        .timezone-warning {
          margin: 0;
          color: var(--warning-text, #856404);
        }
      </style>
    `;
  }

  attachEventListeners() {
    const select = this.container.querySelector('#timezone-select');
    const customInput = this.container.querySelector('#custom-timezone');
    const info = this.container.querySelector('#timezone-info');

    select.addEventListener('change', (e) => {
      const value = e.target.value;
      
      if (value === 'custom') {
        // 显示自定义输入框
        select.style.display = 'none';
        customInput.style.display = 'block';
        customInput.focus();
        info.style.display = 'block';
      } else {
        this.setTimezone(value);
      }
    });

    customInput.addEventListener('blur', () => {
      const value = customInput.value.trim();
      if (value && this.validateTimezone(value)) {
        this.setTimezone(value);
      } else {
        // 恢复选择框
        customInput.style.display = 'none';
        select.style.display = 'block';
        info.style.display = 'none';
      }
    });

    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const value = customInput.value.trim();
        if (value && this.validateTimezone(value)) {
          this.setTimezone(value);
        } else {
          alert('无效的时区，请使用 IANA 时区标识符，如 Asia/Shanghai');
        }
      } else if (e.key === 'Escape') {
        // 取消
        customInput.style.display = 'none';
        select.style.display = 'block';
        info.style.display = 'none';
      }
    });

    // 监听全局时区变化事件
    window.addEventListener('timezoneChanged', (e) => {
      this.currentTimezone = e.detail.timezone;
      this.render();
      this.attachEventListeners();
    });
  }

  validateTimezone(timezone) {
    try {
      // 尝试使用时区格式化，如果无效会抛出错误
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch (err) {
      return false;
    }
  }

  async setTimezone(timezone) {
    if (!this.validateTimezone(timezone)) {
      alert('无效的时区');
      return;
    }

    // 更新本地存储
    setTimezone(timezone);
    this.currentTimezone = timezone;

    // 同步到服务器
    try {
      const response = await fetch('/api/users/me/timezone', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ timezone })
      });

      if (response.ok) {
        console.log('Timezone synced to server:', timezone);
      } else {
        console.warn('Failed to sync timezone to server');
      }
    } catch (err) {
      console.error('Error syncing timezone:', err);
    }

    // 触发回调
    if (this.options.onTimezoneChange) {
      this.options.onTimezoneChange(timezone);
    }

    // 重新渲染
    this.render();
    this.attachEventListeners();
  }

  startLocalTimeUpdate() {
    if (!this.options.showLocalTime) return;

    // 每秒更新本地时间显示
    setInterval(() => {
      const localTimeDisplay = this.container.querySelector('#local-time-display');
      if (localTimeDisplay) {
        const localTime = getCurrentLocalTime(this.currentTimezone);
        localTimeDisplay.textContent = localTime;
      }
    }, 1000);
  }
}

// 导出工厂函数
export function createTimezoneSelector(container, options = {}) {
  return new TimezoneSelector(container, options);
}

export default TimezoneSelector;
