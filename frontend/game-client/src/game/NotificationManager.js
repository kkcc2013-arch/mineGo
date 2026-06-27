// frontend/game-client/src/game/NotificationManager.js
// Real-time push notification system - REQ-00026
// Updated: REQ-00335 - Distance unit localization
'use strict';

import { i18n } from '../i18n/index.js';
import { formatDistance } from '../utils/unitSystem.js';

const WS_BASE = window.PMG_CONFIG?.wsBase || 'wss://api.pocketmonstergo.com';
const HEARTBEAT_INTERVAL = 30000;
const MAX_RETRIES = 5;
const MAX_HISTORY = 50;

// Notification type definitions
export const NOTIFICATION_TYPES = {
  RARE_SPAWN: {
    name: 'RARE_SPAWN',
    icon: '🐉',
    title: (data) => i18n.t('notifications.rareSpawn.title'),
    body: (data) => {
      const distanceStr = formatDistance(data.distance, { shortForm: false });
      return i18n.t('notifications.rareSpawn.body', { 
        speciesName: data.speciesName, 
        distance: distanceStr 
      });
    },
    action: (data) => ({ type: 'NAVIGATE', lat: data.lat, lng: data.lng }),
  },
  RAID_STARTED: {
    name: 'RAID_STARTED',
    icon: '⚔️',
    title: (data) => i18n.t('notifications.raidStarted.title'),
    body: (data) => i18n.t('notifications.raidStarted.body', { 
      bossName: data.bossName, 
      gymName: data.gymName 
    }),
    action: (data) => ({ type: 'JOIN_RAID', raidId: data.raidId, gymId: data.gymId }),
  },
  FRIEND_REQUEST: {
    name: 'FRIEND_REQUEST',
    icon: '👥',
    title: (data) => i18n.t('notifications.friendRequest.title'),
    body: (data) => i18n.t('notifications.friendRequest.body', { 
      fromUserName: data.fromUserName 
    }),
    action: (data) => ({ type: 'VIEW_FRIENDS', tab: 'requests' }),
  },
  GIFT_RECEIVED: {
    name: 'GIFT_RECEIVED',
    icon: '🎁',
    title: (data) => i18n.t('notifications.giftReceived.title'),
    body: (data) => i18n.t('notifications.giftReceived.body', { 
      fromUserName: data.fromUserName 
    }),
    action: (data) => ({ type: 'VIEW_FRIENDS', tab: 'gifts' }),
  },
  QUEST_COMPLETE: {
    name: 'QUEST_COMPLETE',
    icon: '✅',
    title: (data) => i18n.t('notifications.questComplete.title'),
    body: (data) => i18n.t('notifications.questComplete.body', { 
      questName: data.questName 
    }),
    action: (data) => ({ type: 'VIEW_REWARDS', questId: data.questId }),
  },
  GYM_UNDER_ATTACK: {
    name: 'GYM_UNDER_ATTACK',
    icon: '🛡️',
    title: (data) => i18n.t('notifications.gymUnderAttack.title'),
    body: (data) => i18n.t('notifications.gymUnderAttack.body', { 
      gymName: data.gymName 
    }),
    action: (data) => ({ type: 'VIEW_GYM', gymId: data.gymId }),
  },
  GYM_LOST: {
    name: 'GYM_LOST',
    icon: '💔',
    title: (data) => i18n.t('notifications.gymLost.title'),
    body: (data) => i18n.t('notifications.gymLost.body', { 
      gymName: data.gymName 
    }),
    action: (data) => ({ type: 'VIEW_GYM', gymId: data.gymId }),
  },
};

/**
 * NotificationManager - Real-time push notification system
 * 
 * Features:
 * - WebSocket connection management with auto-reconnect
 * - Notification preferences sync
 * - In-game toast/banner notifications
 * - Notification history (last 50)
 * - Sound and vibration feedback
 */
export class NotificationManager extends EventTarget {
  constructor(apiClient) {
    super();
    
    this._api = apiClient;
    this._ws = null;
    this._userId = null;
    this._accessToken = null;
    
    this._preferences = {
      rare_spawn: true,
      raid_started: true,
      friend_request: true,
      gift_received: true,
      quest_complete: true,
      gym_under_attack: true,
      gym_lost: false,
      sound_enabled: true,
      vibration_enabled: true,
    };
    
    this._history = [];
    this._enabled = true;
    this._heartbeat = null;
    this._retries = 0;
    this._retryTimer = null;
    
    // Bind methods
    this._handleMessage = this._handleMessage.bind(this);
    this._handleClose = this._handleClose.bind(this);
  }

  // ── Initialization ─────────────────────────────────────────
  
  /**
   * Initialize notification manager
   * @param {string} userId - User ID
   * @param {string} token - Access token
   */
  async init(userId, token) {
    this._userId = userId;
    this._accessToken = token;
    
    // Load preferences from server
    try {
      const prefs = await this._api.get('/notifications/preferences');
      if (prefs) {
        this._preferences = { ...this._preferences, ...prefs };
      }
    } catch (err) {
      console.warn('[NotificationManager] Failed to load preferences:', err);
    }
    
    // Load history from localStorage
    this._loadHistory();
    
    // Connect WebSocket
    this._connectWS();
    
    console.log('[NotificationManager] Initialized');
  }

  // ── WebSocket Connection ───────────────────────────────────
  
  _connectWS() {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return;
    }
    
    const url = `${WS_BASE}/ws/notifications?token=${this._accessToken}`;
    this._ws = new WebSocket(url);
    
    this._ws.onopen = () => {
      console.log('[NotificationManager] WebSocket connected');
      this._retries = 0;
      this._startHeartbeat();
      this.dispatchEvent(new CustomEvent('connected'));
    };
    
    this._ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('[NotificationManager] Parse error:', e);
      }
    };
    
    this._ws.onclose = (ev) => this._handleClose(ev);
    
    this._ws.onerror = (err) => {
      console.error('[NotificationManager] WebSocket error:', err);
    };
  }
  
  _handleMessage(msg) {
    if (msg.type === 'NOTIFICATION') {
      this._handleNotification(msg.payload);
    } else if (msg.type === 'PONG') {
      // Heartbeat response
    } else {
      console.log('[NotificationManager] Unknown message type:', msg.type);
    }
  }
  
  _handleClose(ev) {
    this._stopHeartbeat();
    
    if (ev.code === 4001) {
      // Auth failure - don't retry
      this.dispatchEvent(new CustomEvent('authError'));
      return;
    }
    
    // Auto reconnect
    if (this._userId && this._retries < MAX_RETRIES) {
      const delay = Math.min(1000 * 2 ** this._retries, 30000);
      console.log(`[NotificationManager] Reconnecting in ${delay}ms (attempt ${this._retries + 1})`);
      
      this._retryTimer = setTimeout(() => {
        this._retries++;
        this._connectWS();
      }, delay);
    } else {
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { permanent: true } }));
    }
  }
  
  _startHeartbeat() {
    this._heartbeat = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, HEARTBEAT_INTERVAL);
  }
  
  _stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  // ── Notification Handling ──────────────────────────────────
  
  /**
   * Handle incoming notification
   */
  _handleNotification(payload) {
    const { eventType, data, timestamp } = payload;
    
    // Check if this notification type is enabled
    const typeConfig = NOTIFICATION_TYPES[eventType];
    if (!typeConfig) {
      console.warn('[NotificationManager] Unknown notification type:', eventType);
      return;
    }
    
    // Check preferences
    const prefKey = eventType.toLowerCase();
    if (!this._preferences[prefKey]) {
      console.log('[NotificationManager] Notification disabled by preference:', eventType);
      return;
    }
    
    // Create notification object
    const notification = {
      id: Date.now(),
      type: eventType,
      icon: typeConfig.icon,
      title: typeConfig.title(data),
      body: typeConfig.body(data),
      action: typeConfig.action(data),
      data,
      timestamp: timestamp || new Date().toISOString(),
      read: false,
    };
    
    // Add to history
    this._addToHistory(notification);
    
    // Show notification
    this.showNotification(notification);
    
    // Dispatch event
    this.dispatchEvent(new CustomEvent('notification', { detail: notification }));
  }
  
  /**
   * Show in-game notification
   */
  showNotification(notification) {
    if (!this._enabled) return;
    
    // Play sound
    if (this._preferences.sound_enabled) {
      this._playSound(notification.type);
    }
    
    // Vibrate
    if (this._preferences.vibration_enabled && navigator.vibrate) {
      navigator.vibrate(200);
    }
    
    // Show toast
    this._showToast(notification);
    
    // Show banner if important
    const importantTypes = ['RARE_SPAWN', 'RAID_STARTED', 'GYM_UNDER_ATTACK'];
    if (importantTypes.includes(notification.type)) {
      this._showBanner(notification);
    }
  }
  
  /**
   * Show toast notification
   */
  _showToast(notification) {
    const container = this._getToastContainer();
    
    const toast = document.createElement('div');
    toast.className = `notification-toast ${notification.type.toLowerCase()}`;
    toast.innerHTML = `
      <div class="toast-icon">${notification.icon}</div>
      <div class="toast-content">
        <div class="toast-title">${notification.title}</div>
        <div class="toast-body">${notification.body}</div>
      </div>
    `;
    
    // Auto dismiss after 5 seconds
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
    
    container.appendChild(toast);
  }
  
  /**
   * Show banner notification (for important events)
   */
  _showBanner(notification) {
    const container = this._getBannerContainer();
    
    // Remove existing banner
    container.innerHTML = '';
    
    const banner = document.createElement('div');
    banner.className = `notification-banner ${notification.type.toLowerCase()}`;
    banner.innerHTML = `
      <div class="notif-icon">${notification.icon}</div>
      <div class="notif-content">
        <div class="notif-title">${notification.title}</div>
        <div class="notif-body">${notification.body}</div>
      </div>
      <button class="notif-action">${i18n.t('common.go')}</button>
      <button class="notif-close">✕</button>
    `;
    
    // Action button
    const actionBtn = banner.querySelector('.notif-action');
    actionBtn.addEventListener('click', () => {
      this._handleAction(notification);
      banner.remove();
    });
    
    // Close button
    const closeBtn = banner.querySelector('.notif-close');
    closeBtn.addEventListener('click', () => banner.remove());
    
    container.appendChild(banner);
    
    // Auto dismiss after 15 seconds
    setTimeout(() => {
      if (banner.parentElement) {
        banner.classList.add('fade-out');
        setTimeout(() => banner.remove(), 300);
      }
    }, 15000);
  }
  
  /**
   * Handle notification action
   */
  _handleAction(notification) {
    if (!notification.action) return;
    
    this.dispatchEvent(new CustomEvent('action', { 
      detail: notification.action 
    }));
    
    // Dispatch specific action events
    switch (notification.action.type) {
      case 'NAVIGATE':
        window.dispatchEvent(new CustomEvent('map:navigate', { 
          detail: { lat: notification.action.lat, lng: notification.action.lng }
        }));
        break;
      case 'JOIN_RAID':
        window.dispatchEvent(new CustomEvent('raid:join', { 
          detail: { raidId: notification.action.raidId }
        }));
        break;
      case 'VIEW_GYM':
        window.dispatchEvent(new CustomEvent('gym:view', { 
          detail: { gymId: notification.action.gymId }
        }));
        break;
      case 'VIEW_FRIENDS':
        window.dispatchEvent(new CustomEvent('friends:view', { 
          detail: { tab: notification.action.tab }
        }));
        break;
      case 'VIEW_REWARDS':
        window.dispatchEvent(new CustomEvent('rewards:view', { 
          detail: { questId: notification.action.questId }
        }));
        break;
    }
  }
  
  /**
   * Play notification sound
   */
  _playSound(type) {
    const sounds = {
      RARE_SPAWN: '/sounds/rare-spawn.mp3',
      RAID_STARTED: '/sounds/raid-started.mp3',
      FRIEND_REQUEST: '/sounds/friend-request.mp3',
      GIFT_RECEIVED: '/sounds/gift-received.mp3',
      QUEST_COMPLETE: '/sounds/quest-complete.mp3',
      GYM_UNDER_ATTACK: '/sounds/gym-attack.mp3',
      GYM_LOST: '/sounds/gym-lost.mp3',
    };
    
    const soundFile = sounds[type];
    if (soundFile) {
      const audio = new Audio(soundFile);
      audio.volume = 0.5;
      audio.play().catch(() => {
        // Ignore autoplay errors
      });
    }
  }

  // ── Preferences ────────────────────────────────────────────
  
  /**
   * Update notification preferences
   */
  async updatePreferences(prefs) {
    try {
      const updated = await this._api.put('/notifications/preferences', prefs);
      this._preferences = { ...this._preferences, ...updated };
      
      console.log('[NotificationManager] Preferences updated');
      this.dispatchEvent(new CustomEvent('preferencesUpdated', { 
        detail: this._preferences 
      }));
      
      return this._preferences;
    } catch (err) {
      console.error('[NotificationManager] Failed to update preferences:', err);
      throw err;
    }
  }
  
  /**
   * Get current preferences
   */
  getPreferences() {
    return { ...this._preferences };
  }

  // ── History ────────────────────────────────────────────────
  
  /**
   * Get notification history
   */
  getHistory(limit = 50) {
    return this._history.slice(0, limit);
  }
  
  /**
   * Add notification to history
   */
  _addToHistory(notification) {
    this._history.unshift(notification);
    
    // Keep only last 50
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(0, MAX_HISTORY);
    }
    
    // Save to localStorage
    this._saveHistory();
  }
  
  /**
   * Clear notification history
   */
  async clearHistory() {
    this._history = [];
    localStorage.removeItem('pmg_notification_history');
    
    try {
      await this._api.delete('/notifications');
    } catch (err) {
      console.warn('[NotificationManager] Failed to clear history on server:', err);
    }
    
    this.dispatchEvent(new CustomEvent('historyCleared'));
  }
  
  /**
   * Mark notification as read
   */
  async markAsRead(notificationId) {
    const notification = this._history.find(n => n.id === notificationId);
    if (notification) {
      notification.read = true;
      this._saveHistory();
    }
    
    try {
      await this._api.put(`/notifications/${notificationId}/read`);
    } catch (err) {
      console.warn('[NotificationManager] Failed to mark as read on server:', err);
    }
  }
  
  /**
   * Mark all as read
   */
  async markAllAsRead() {
    this._history.forEach(n => n.read = true);
    this._saveHistory();
    
    try {
      await this._api.put('/notifications/read-all');
    } catch (err) {
      console.warn('[NotificationManager] Failed to mark all as read on server:', err);
    }
  }
  
  _loadHistory() {
    try {
      const saved = localStorage.getItem('pmg_notification_history');
      if (saved) {
        this._history = JSON.parse(saved);
      }
    } catch (err) {
      console.warn('[NotificationManager] Failed to load history:', err);
    }
  }
  
  _saveHistory() {
    try {
      localStorage.setItem('pmg_notification_history', JSON.stringify(this._history));
    } catch (err) {
      console.warn('[NotificationManager] Failed to save history:', err);
    }
  }

  // ── UI Helpers ──────────────────────────────────────────────
  
  _getToastContainer() {
    let container = document.getElementById('notification-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'notification-toast-container';
      container.className = 'notification-toast-container';
      document.body.appendChild(container);
    }
    return container;
  }
  
  _getBannerContainer() {
    let container = document.getElementById('notification-banner-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'notification-banner-container';
      container.className = 'notification-banner-container';
      document.body.appendChild(container);
    }
    return container;
  }

  // ── Enable/Disable ─────────────────────────────────────────
  
  setEnabled(enabled) {
    this._enabled = enabled;
  }
  
  isEnabled() {
    return this._enabled;
  }

  // ── Cleanup ────────────────────────────────────────────────
  
  disconnect() {
    this._stopHeartbeat();
    
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    
    console.log('[NotificationManager] Disconnected');
  }
}

// ============================================================
// CSS Styles (injected)
// ============================================================

const styles = `
.notification-toast-container {
  position: fixed;
  top: 60px;
  right: 20px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 320px;
}

.notification-toast {
  display: flex;
  align-items: center;
  background: rgba(0, 0, 0, 0.85);
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  animation: slideIn 0.3s ease-out;
}

.notification-toast.fade-out {
  animation: slideOut 0.3s ease-out forwards;
}

.toast-icon {
  font-size: 24px;
  margin-right: 12px;
}

.toast-content {
  flex: 1;
}

.toast-title {
  font-weight: bold;
  font-size: 14px;
  color: #fff;
  margin-bottom: 4px;
}

.toast-body {
  font-size: 13px;
  color: #ccc;
}

.notification-banner-container {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10000;
  padding: 10px;
}

.notification-banner {
  display: flex;
  align-items: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  animation: slideDown 0.3s ease-out;
}

.notification-banner.fade-out {
  animation: slideUp 0.3s ease-out forwards;
}

.notification-banner.rare_spawn {
  background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
}

.notification-banner.raid_started {
  background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
}

.notification-banner.gym_under_attack {
  background: linear-gradient(135deg, #fa709a 0%, #fee140 100%);
}

.notif-icon {
  font-size: 32px;
  margin-right: 12px;
}

.notif-content {
  flex: 1;
}

.notif-title {
  font-weight: bold;
  font-size: 16px;
  color: #fff;
  margin-bottom: 4px;
}

.notif-body {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.9);
}

.notif-action {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  color: #fff;
  padding: 8px 16px;
  border-radius: 4px;
  font-weight: bold;
  cursor: pointer;
  margin-right: 8px;
}

.notif-action:hover {
  background: rgba(255, 255, 255, 0.3);
}

.notif-close {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  font-size: 20px;
  cursor: pointer;
  padding: 4px;
}

.notif-close:hover {
  color: #fff;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideOut {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}

@keyframes slideDown {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slideUp {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(-100%);
    opacity: 0;
  }
}
`;

// Inject styles
if (typeof document !== 'undefined' && !document.getElementById('notification-manager-styles')) {
  const styleSheet = document.createElement('style');
  styleSheet.id = 'notification-manager-styles';
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);
}

// Global i18n fallback
const i18n = window.i18n || {
  t: (key, params = {}) => {
    // Fallback translations
    const fallbacks = {
      'common.go': 'Go',
      'notifications.rareSpawn.title': 'Rare Pokémon Appeared!',
      'notifications.rareSpawn.body': '{{speciesName}} is {{distance}}m away',
      'notifications.raidStarted.title': 'Raid Started!',
      'notifications.raidStarted.body': '{{bossName}} at {{gymName}}',
      'notifications.friendRequest.title': 'Friend Request',
      'notifications.friendRequest.body': '{{fromUserName}} wants to be friends',
      'notifications.giftReceived.title': 'Gift Received!',
      'notifications.giftReceived.body': '{{fromUserName}} sent you a gift',
      'notifications.questComplete.title': 'Quest Complete!',
      'notifications.questComplete.body': '{{questName}} completed',
      'notifications.gymUnderAttack.title': 'Gym Under Attack!',
      'notifications.gymUnderAttack.body': '{{gymName}} is being attacked',
      'notifications.gymLost.title': 'Gym Lost',
      'notifications.gymLost.body': '{{gymName}} was taken over',
    };
    
    let text = fallbacks[key] || key;
    Object.keys(params).forEach(p => {
      text = text.replace(`{{${p}}}`, params[p]);
    });
    return text;
  },
};
