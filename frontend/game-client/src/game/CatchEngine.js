// frontend/game-client/src/game/CatchEngine.js
// Handles the complete catch interaction: physics simulation + server round-trips
'use strict';

const THROW_RING_SHRINK_RATE = 0.004;  // Ring shrinks each frame
const RING_MIN_SCALE = 0.2;
const RING_MAX_SCALE = 1.0;

export class CatchEngine extends EventTarget {
  constructor(apiClient) {
    super();
    this._api     = apiClient;
    this._session = null;         // Active catch session
    this._ball    = null;         // In-flight ball state
    this._ring    = { scale: RING_MAX_SCALE, shrinking: true };
    this._frameId = null;
    this._canvas  = null;
    this._ctx     = null;
    this._isBusy  = false;
  }

  // ── Start a catch encounter ───────────────────────────────
  async startCatch(spawnId, playerLat, playerLng) {
    if (this._isBusy) throw new Error('Already in a catch session');
    this._isBusy = true;

    try {
      const session = await this._api.startCatch(spawnId, playerLat, playerLng);
      this._session = {
        ...session,
        ballType:  'POKE_BALL',
        berryUsed: 'NONE',
        throws:    0,
      };
      this._ring  = { scale: RING_MAX_SCALE, shrinking: true };
      this._startAnimation();
      this.dispatchEvent(new CustomEvent('sessionStarted', { detail: session }));
      return session;
    } catch (err) {
      this._isBusy = false;
      throw err;
    }
  }

  // ── Throw a ball ──────────────────────────────────────────
  async throw({ startX, startY, endX, endY, velocityX, velocityY }) {
    if (!this._session) throw new Error('No active session');

    // Determine throw rating based on ring scale at throw time
    const throwRating = this._calcThrowRating(this._ring.scale);
    const isCurve     = Math.abs(velocityX) > 300; // Fast horizontal = curve

    // Animate ball flight
    this._ball = { x: startX, y: startY, vx: velocityX * 0.016, vy: velocityY * 0.016 - 5, phase: 'flying' };

    // Wait for ball to reach target (animation)
    await this._animateBallFlight(endX, endY);

    if (throwRating === 'MISS') {
      this.dispatchEvent(new CustomEvent('throwMiss'));
      this._ball = null;
      return { result: 'MISS' };
    }

    // Send to server
    this.dispatchEvent(new CustomEvent('throwPending', { detail: { throwRating, isCurve } }));

    try {
      const result = await this._api.throwBall(
        this._session.sessionId,
        this._session.ballType,
        throwRating,
        isCurve,
        this._session.berryUsed
      );

      this._session.throws++;

      if (result.result === 'CAUGHT') {
        this._stopAnimation();
        this._isBusy = false;
        this._session = null;
        this.dispatchEvent(new CustomEvent('caught', { detail: result }));
      } else if (result.result === 'FLED') {
        this._stopAnimation();
        this._isBusy = false;
        this._session = null;
        this.dispatchEvent(new CustomEvent('fled', { detail: result }));
      } else {
        // Ball used, pokemon still free — shake animation
        this.dispatchEvent(new CustomEvent('ballUsed', { detail: result }));
        this._ring.scale = RING_MAX_SCALE; // Reset ring
      }

      this._ball = null;
      return result;
    } catch (err) {
      this._ball  = null;
      this._isBusy = false;
      throw err;
    }
  }

  // ── Berry selection ───────────────────────────────────────
  selectBerry(berryType) {
    if (!this._session) return;
    this._session.berryUsed = berryType;
    this.dispatchEvent(new CustomEvent('berrySelected', { detail: { berryType } }));
  }

  selectBall(ballType) {
    if (!this._session) return;
    this._session.ballType = ballType;
    this.dispatchEvent(new CustomEvent('ballSelected', { detail: { ballType } }));
  }

  abandon() {
    this._stopAnimation();
    this._session = null;
    this._isBusy  = false;
    this.dispatchEvent(new CustomEvent('abandoned'));
  }

  // ── Throw rating from ring scale ─────────────────────────
  _calcThrowRating(ringScale) {
    // If the ring shrank below 30% and player hit inside → Excellent
    // Ring 30-65%  → Great
    // Ring > 65%   → Nice
    // Outside ring → Miss (determined by hit detection in UI layer)
    if (ringScale < 0.30) return 'EXCELLENT';
    if (ringScale < 0.65) return 'GREAT';
    return 'NICE';
  }

  // ── Animation loop ────────────────────────────────────────
  _startAnimation() {
    const tick = () => {
      // Shrink / expand ring
      if (this._ring.shrinking) {
        this._ring.scale -= THROW_RING_SHRINK_RATE;
        if (this._ring.scale <= RING_MIN_SCALE) this._ring.shrinking = false;
      } else {
        this._ring.scale += THROW_RING_SHRINK_RATE;
        if (this._ring.scale >= RING_MAX_SCALE) this._ring.shrinking = true;
      }

      this.dispatchEvent(new CustomEvent('frame', {
        detail: { ring: { ...this._ring }, ball: this._ball ? { ...this._ball } : null }
      }));

      this._frameId = requestAnimationFrame(tick);
    };
    this._frameId = requestAnimationFrame(tick);
  }

  _stopAnimation() {
    if (this._frameId) {
      cancelAnimationFrame(this._frameId);
      this._frameId = null;
    }
  }

  _animateBallFlight(targetX, targetY) {
    return new Promise(resolve => {
      const FLIGHT_FRAMES = 24; // ~400ms at 60fps
      let frame = 0;
      const tick = () => {
        frame++;
        const t = frame / FLIGHT_FRAMES;
        // Parabolic arc
        if (this._ball) {
          this._ball.x = this._ball.x + (targetX - this._ball.x) * 0.08;
          this._ball.y = this._ball.y + (targetY - this._ball.y) * 0.08 - Math.sin(t * Math.PI) * 40;
        }
        if (frame >= FLIGHT_FRAMES) { resolve(); }
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  get session()   { return this._session; }
  get ringScale() { return this._ring.scale; }
  get isBusy()    { return this._isBusy; }
}
