// frontend/game-client/src/game/RaidManager.js
// Manages real-time Raid WebSocket connection and battle state
'use strict';

const WS_BASE   = window.PMG_CONFIG?.wsBase || 'wss://api.pocketmonstergo.com';
const HEARTBEAT_INTERVAL = 30000;
const MAX_RETRIES        = 5;

export class RaidManager extends EventTarget {
  constructor(apiClient) {
    super();
    this._api         = apiClient;
    this._ws          = null;
    this._raidId      = null;
    this._raidState   = null;
    this._heartbeat   = null;
    this._retries     = 0;
    this._retryTimer  = null;
    this._accessToken = null;
  }

  // ── Join and connect to a Raid ────────────────────────────
  async joinRaid(raidId) {
    // First: REST join call to register participation
    const data = await this._api.joinRaid(raidId);

    this._raidId    = raidId;
    this._raidState = {
      raidId,
      bossSpeciesId:  data.bossSpeciesId,
      bossHpMax:      data.bossHpMax,
      bossHpCurrent:  data.bossHpMax,
      raidLevel:      data.raidLevel,
      endsAt:         data.endsAt,
      participants:   [],
      myDamage:       0,
      ballsLeft:      data.ballsGranted,
    };

    this._accessToken = localStorage.getItem('pmg_access_token');
    this._connectWS();
    this.dispatchEvent(new CustomEvent('joined', { detail: this._raidState }));
    return this._raidState;
  }

  // ── Attack ────────────────────────────────────────────────
  attack(moveId, estimatedDamage) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._send({ type: 'ATTACK', moveId, damage: estimatedDamage });
    this._raidState.myDamage += estimatedDamage;
  }

  leave() {
    this._cleanup();
    this._raidId   = null;
    this._raidState = null;
    this.dispatchEvent(new CustomEvent('left'));
  }

  get state() { return this._raidState; }

  // ── WebSocket ─────────────────────────────────────────────
  _connectWS() {
    const url = `${WS_BASE}/ws/raid?token=${this._accessToken}&raidId=${this._raidId}`;
    this._ws  = new WebSocket(url);

    this._ws.onopen = () => {
      console.log(`[Raid WS] Connected to raid ${this._raidId}`);
      this._retries = 0;
      this._startHeartbeat();
      this.dispatchEvent(new CustomEvent('connected'));
    };

    this._ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this._handleMessage(msg);
      } catch (e) { console.error('[Raid WS] Parse error', e); }
    };

    this._ws.onclose = (ev) => {
      this._stopHeartbeat();
      if (ev.code === 4001) {
        // Auth failure — don't retry
        this.dispatchEvent(new CustomEvent('authError'));
        return;
      }
      if (this._raidId && this._retries < MAX_RETRIES) {
        const delay = Math.min(1000 * 2 ** this._retries, 30000);
        console.log(`[Raid WS] Reconnecting in ${delay}ms (attempt ${this._retries + 1})`);
        this._retryTimer = setTimeout(() => {
          this._retries++;
          this._connectWS();
        }, delay);
      } else {
        this.dispatchEvent(new CustomEvent('disconnected', { detail: { permanent: true } }));
      }
    };

    this._ws.onerror = (err) => {
      console.error('[Raid WS] Error:', err);
    };
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'PLAYER_JOINED':
        this._raidState.participants = [...(this._raidState.participants || []), msg.userId].filter((v,i,a)=>a.indexOf(v)===i);
        this.dispatchEvent(new CustomEvent('participantUpdate', { detail: { count: msg.participants, participants: this._raidState.participants } }));
        break;

      case 'PLAYER_LEFT':
        this._raidState.participants = (this._raidState.participants || []).filter(id => id !== msg.userId);
        this.dispatchEvent(new CustomEvent('participantUpdate', { detail: { count: msg.participants } }));
        break;

      case 'RAID_ATTACK':
        this._raidState.bossHpCurrent = Math.max(0, msg.bossHpRemaining);
        this.dispatchEvent(new CustomEvent('bossHpUpdate', {
          detail: {
            bossHpCurrent:  this._raidState.bossHpCurrent,
            bossHpMax:      this._raidState.bossHpMax,
            bossHpPercent:  Math.round(this._raidState.bossHpCurrent / this._raidState.bossHpMax * 100),
            attackerId:     msg.attackerId,
            damage:         msg.damage,
            bossDefeated:   msg.bossDefeated,
          }
        }));
        if (msg.bossDefeated) {
          this.dispatchEvent(new CustomEvent('bossDefeated'));
        }
        break;

      case 'RAID_COMPLETED':
        this._cleanup();
        this.dispatchEvent(new CustomEvent('completed', { detail: { raidId: msg.raidId } }));
        break;

      case 'PONG':
        // Heartbeat response — connection alive
        break;

      default:
        console.log('[Raid WS] Unknown message type:', msg.type);
    }
  }

  _send(data) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  _startHeartbeat() {
    this._heartbeat = setInterval(() => this._send({ type: 'PING' }), HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  _cleanup() {
    this._stopHeartbeat();
    if (this._retryTimer)  { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._ws) {
      this._ws.onclose = null; // Prevent retry on intentional close
      this._ws.close(1000, 'Left raid');
      this._ws = null;
    }
  }
}
