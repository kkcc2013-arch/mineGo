// frontend/game-client/src/network/NetworkMonitor.js
// Advanced network status monitoring and connection quality detection
'use strict';

/**
 * NetworkMonitor - Monitors network status and connection quality
 * Supports online/offline detection, connection quality measurement, and retry strategies
 */
export class NetworkMonitor {
  constructor(options = {}) {
    this.options = {
      pingEndpoint: options.pingEndpoint || '/api/health/ping',
      pingInterval: options.pingInterval || 30000, // 30 seconds
      qualityThresholds: options.qualityThresholds || {
        excellent: 200, // < 200ms
        good: 500,      // < 500ms
        fair: 1000,     // < 1000ms
        poor: 3000      // < 3000ms
      },
      ...options
    };

    this._isOnline = navigator.onLine;
    this._connectionQuality = 'unknown';
    this._lastPingTime = null;
    this._pingTimer = null;
    this._listeners = new Map();
    this._rttHistory = [];
    this._maxRttHistory = 10;
  }

  /**
   * Initialize network monitoring
   */
  init() {
    // Listen to online/offline events
    window.addEventListener('online', () => this._handleOnlineStatusChange(true));
    window.addEventListener('offline', () => this._handleOnlineStatusChange(false));

    // Start periodic connection quality check
    this.startQualityMonitoring();

    // Initial quality check
    if (this._isOnline) {
      this.checkConnectionQuality();
    }

    console.log('[NetworkMonitor] Initialized, online:', this._isOnline);
  }

  /**
   * Get current online status
   * @returns {boolean}
   */
  isOnline() {
    return this._isOnline;
  }

  /**
   * Get current connection quality
   * @returns {'excellent'|'good'|'fair'|'poor'|'offline'|'unknown'}
   */
  getQuality() {
    if (!this._isOnline) {
      return 'offline';
    }
    return this._connectionQuality;
  }

  /**
   * Get average RTT (Round Trip Time)
   * @returns {number|null} RTT in milliseconds
   */
  getAverageRTT() {
    if (this._rttHistory.length === 0) {
      return null;
    }
    return Math.round(
      this._rttHistory.reduce((a, b) => a + b, 0) / this._rttHistory.length
    );
  }

  /**
   * Check connection quality by pinging server
   * @returns {Promise<{quality: string, rtt: number}>}
   */
  async checkConnectionQuality() {
    if (!navigator.onLine) {
      this._connectionQuality = 'offline';
      return { quality: 'offline', rtt: Infinity };
    }

    const startTime = Date.now();

    try {
      // Use fetch with AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(this.options.pingEndpoint, {
        method: 'HEAD',
        cache: 'no-cache',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const rtt = Date.now() - startTime;
      this._lastPingTime = Date.now();

      // Update RTT history
      this._rttHistory.push(rtt);
      if (this._rttHistory.length > this._maxRttHistory) {
        this._rttHistory.shift();
      }

      // Determine quality based on RTT
      const thresholds = this.options.qualityThresholds;
      let quality = 'poor';
      if (rtt < thresholds.excellent) {
        quality = 'excellent';
      } else if (rtt < thresholds.good) {
        quality = 'good';
      } else if (rtt < thresholds.fair) {
        quality = 'fair';
      }

      this._connectionQuality = quality;

      this._emit('quality-change', { quality, rtt });

      return { quality, rtt };
    } catch (error) {
      console.warn('[NetworkMonitor] Connection quality check failed:', error);

      // If fetch fails, we might be offline (even if navigator.onLine says true)
      if (error.name === 'AbortError') {
        this._connectionQuality = 'poor';
        return { quality: 'poor', rtt: 5000 };
      }

      this._connectionQuality = 'unknown';
      return { quality: 'unknown', rtt: Infinity };
    }
  }

  /**
   * Start periodic connection quality monitoring
   */
  startQualityMonitoring() {
    if (this._pingTimer) {
      this.stopQualityMonitoring();
    }

    this._pingTimer = setInterval(() => {
      if (this._isOnline) {
        this.checkConnectionQuality();
      }
    }, this.options.pingInterval);
  }

  /**
   * Stop periodic quality monitoring
   */
  stopQualityMonitoring() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  /**
   * Get retry delay based on exponential backoff
   * @param {number} attempt - Current attempt number (starting from 0)
   * @param {object} options - Backoff options
   * @returns {number} Delay in milliseconds
   */
  getRetryDelay(attempt, options = {}) {
    const {
      baseDelay = 1000,
      maxDelay = 60000,
      jitter = true
    } = options;

    // Exponential backoff: baseDelay * 2^attempt
    let delay = baseDelay * Math.pow(2, attempt);

    // Apply max delay cap
    delay = Math.min(delay, maxDelay);

    // Add jitter to prevent thundering herd
    if (jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    // Adjust based on connection quality
    const qualityMultiplier = {
      excellent: 0.5,
      good: 1,
      fair: 1.5,
      poor: 2,
      unknown: 1,
      offline: 5
    };

    delay = delay * (qualityMultiplier[this._connectionQuality] || 1);

    return Math.round(delay);
  }

  /**
   * Execute a function with automatic retry on network failure
   * @param {Function} fn - Function to execute
   * @param {object} options - Retry options
   * @returns {Promise<any>}
   */
  async withRetry(fn, options = {}) {
    const {
      maxRetries = 3,
      shouldRetry = (error) => this._isRetryableError(error),
      onRetry = null
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Check if we should retry
        if (attempt === maxRetries || !shouldRetry(error)) {
          throw error;
        }

        // Calculate retry delay
        const delay = this.getRetryDelay(attempt, options);

        console.log(`[NetworkMonitor] Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);

        if (onRetry) {
          onRetry(error, attempt, delay);
        }

        // Wait before retry
        await this._sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Check if error is retryable
   * @param {Error} error 
   * @returns {boolean}
   */
  _isRetryableError(error) {
    // Network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return true;
    }

    // HTTP status codes that are retryable
    if (error.status) {
      const retryableStatuses = [408, 429, 500, 502, 503, 504];
      return retryableStatuses.includes(error.status);
    }

    // Abort errors are not retryable
    if (error.name === 'AbortError') {
      return false;
    }

    // Default: don't retry
    return false;
  }

  /**
   * Handle online/offline status change
   * @param {boolean} isOnline 
   */
  _handleOnlineStatusChange(isOnline) {
    const wasOnline = this._isOnline;
    this._isOnline = isOnline;

    console.log('[NetworkMonitor] Online status changed:', isOnline);

    if (isOnline && !wasOnline) {
      // Just came online
      this._connectionQuality = 'unknown';
      this._emit('online');

      // Check connection quality
      this.checkConnectionQuality();
    } else if (!isOnline && wasOnline) {
      // Just went offline
      this._connectionQuality = 'offline';
      this._emit('offline');
    }
  }

  /**
   * Add event listener
   * @param {string} event - Event name ('online', 'offline', 'quality-change')
   * @param {Function} callback 
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
  }

  /**
   * Remove event listener
   * @param {string} event 
   * @param {Function} callback 
   */
  off(event, callback) {
    if (!this._listeners.has(event)) {
      return;
    }
    const listeners = this._listeners.get(event);
    const index = listeners.indexOf(callback);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Emit event
   * @param {string} event 
   * @param {any} data 
   */
  _emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.forEach(callback => callback(data));
    }
  }

  /**
   * Sleep helper
   * @param {number} ms 
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get connection info for debugging
   * @returns {object}
   */
  getConnectionInfo() {
    return {
      isOnline: this._isOnline,
      quality: this._connectionQuality,
      averageRTT: this.getAverageRTT(),
      lastPingTime: this._lastPingTime,
      rttHistory: [...this._rttHistory]
    };
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.stopQualityMonitoring();
    this._listeners.clear();
  }
}

// Singleton instance
export const networkMonitor = new NetworkMonitor();
