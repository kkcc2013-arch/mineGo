// frontend/game-client/src/game/LocationManager.js
// Manages real-time GPS tracking, speed anti-cheat, and POI proximity
'use strict';

const LOCATION_INTERVAL_MS = 2000;   // Report every 2s
const WARN_SPEED_KMH       = 25;
const MOVEMENT_THRESHOLD_M = 5;      // Ignore jitter < 5m

export class LocationManager extends EventTarget {
  constructor(apiClient) {
    super();
    this._api          = apiClient;
    this._watchId      = null;
    this._lastPos      = null;
    this._lastReported = 0;
    this._totalDistKm  = 0;
    this._isActive     = false;
    this._queue        = [];          // buffered updates
    this._flushTimer   = null;
  }

  // ── Start tracking ────────────────────────────────────────
  start() {
    if (this._isActive) return;
    if (!navigator.geolocation) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'GPS not supported' }));
      return;
    }

    this._isActive = true;
    this._watchId  = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(pos),
      (err) => this._onError(err),
      {
        enableHighAccuracy: true,
        timeout:            10000,
        maximumAge:         2000,
      }
    );

    // Flush queue every 2s
    this._flushTimer = setInterval(() => this._flush(), LOCATION_INTERVAL_MS);
    console.log('[Location] Tracking started');
  }

  stop() {
    if (this._watchId != null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._isActive = false;
    console.log('[Location] Tracking stopped');
  }

  get currentPosition() { return this._lastPos; }
  get totalDistanceKm()  { return this._totalDistKm; }

  // ── Position handler ──────────────────────────────────────
  _onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const now = Date.now();

    if (this._lastPos) {
      const distM  = this._haversineM(this._lastPos.lat, this._lastPos.lng, lat, lng);
      const timeSec = (now - this._lastPos.ts) / 1000;

      // Filter jitter
      if (distM < MOVEMENT_THRESHOLD_M) return;

      // Speed check
      const speedKmh = (distM / 1000) / (timeSec / 3600);
      if (speedKmh > WARN_SPEED_KMH) {
        console.warn(`[Location] Speed anomaly: ${speedKmh.toFixed(1)} km/h`);
        this.dispatchEvent(new CustomEvent('speedAnomaly', { detail: { speedKmh, distM } }));
        // Don't update position for obvious cheats (> 100 km/h)
        if (speedKmh > 100) return;
      }

      this._totalDistKm += distM / 1000;
    }

    this._lastPos = { lat, lng, accuracy, ts: now };

    // Dispatch to UI
    this.dispatchEvent(new CustomEvent('position', {
      detail: { lat, lng, accuracy, totalDistKm: this._totalDistKm }
    }));

    // Queue server update
    this._queue.push({ lat, lng, accuracy, timestamp: now });
  }

  _onError(err) {
    const MSG = {
      1: 'GPS 权限被拒绝，请在设置中开启定位',
      2: 'GPS 信号不可用',
      3: 'GPS 定位超时',
    };
    this.dispatchEvent(new CustomEvent('error', { detail: MSG[err.code] || err.message }));
  }

  // ── Batch flush to server ─────────────────────────────────
  async _flush() {
    if (!this._queue.length || !this._lastPos) return;

    // Take the most recent position only (server only needs latest)
    const latest = this._queue[this._queue.length - 1];
    this._queue   = [];

    try {
      const result = await this._api.updateLocation(latest.lat, latest.lng, latest.accuracy);
      if (result.nearbyAlert) {
        this.dispatchEvent(new CustomEvent('nearbyAlert', { detail: result }));
      }
      if (result.warning === 'speed_anomaly') {
        console.warn('[Location] Server flagged speed anomaly');
      }
    } catch (err) {
      // Network errors on location update are non-critical
      if (err.name !== 'AbortError') console.debug('[Location] Update failed:', err.message);
    }
  }

  // ── Distance utilities ────────────────────────────────────
  _haversineM(lat1, lng1, lat2, lng2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat/2)**2 +
                 Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  distanceTo(lat, lng) {
    if (!this._lastPos) return Infinity;
    return this._haversineM(this._lastPos.lat, this._lastPos.lng, lat, lng);
  }

  isWithinRange(lat, lng, radiusM) {
    return this.distanceTo(lat, lng) <= radiusM;
  }
}
