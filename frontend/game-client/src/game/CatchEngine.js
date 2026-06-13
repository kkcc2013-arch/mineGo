// frontend/game-client/src/game/CatchEngine.js
// Handles the complete catch interaction: physics simulation + server round-trips + visual effects
'use strict';

import { hapticManager } from '../haptics/HapticManager.js';

const THROW_RING_SHRINK_RATE = 0.004;  // Ring shrinks each frame
const RING_MIN_SCALE = 0.2;
const RING_MAX_SCALE = 1.0;

export class CatchEngine extends EventTarget {
  constructor(apiClient, canvas = null) {
    super();
    this._api     = apiClient;
    this._session = null;         // Active catch session
    this._ball    = null;         // In-flight ball state
    this._ring    = { scale: RING_MAX_SCALE, shrinking: true };
    this._frameId = null;
    this._canvas  = canvas;
    this._ctx     = canvas ? canvas.getContext('2d') : null;
    this._isBusy  = false;

    // 动画特效系统（延迟加载）
    this._effectsSystem = null;
    this._effectsEnabled = false;
  }

  /**
   * 初始化特效系统
   */
  initEffects(canvas) {
    if (this._effectsSystem) return;
    
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    
    // 动态加载特效模块
    import('../effects/ThrowAnimation.js').then(module => {
      this._ThrowAnimation = module.ThrowAnimation;
    });
    
    import('../effects/ParticleSystem.js').then(module => {
      this._ParticleSystem = module.ParticleSystem;
      if (this._effectsSystem && this._effectsSystem.particles) {
        this._effectsSystem.particles.start();
      }
    });
    
    import('../effects/ComboSystem.js').then(module => {
      this._ComboSystem = module.ComboSystem;
      if (this._effectsSystem) {
        this._effectsSystem.combo = new this._ComboSystem();
      }
    });

    this._effectsSystem = {
      throwAnimation: null,
      particles: null,
      combo: null
    };
    
    this._effectsEnabled = true;
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

    // 触发投掷震动
    hapticManager.vibrate('catch_throw');

    // 执行投掷动画（如果启用了特效系统）
    if (this._effectsEnabled && this._ThrowAnimation && this._canvas) {
      await this._animateThrowWithEffects({
        startX, startY, endX, endY, velocityX, velocityY, isCurve
      });
    } else {
      // 原有动画逻辑
      this._ball = { x: startX, y: startY, vx: velocityX * 0.016, vy: velocityY * 0.016 - 5, phase: 'flying' };
      await this._animateBallFlight(endX, endY);
    }

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
        // 触发捕捉成功震动
        hapticManager.vibrate('catch_success');
        
        // 优秀投掷额外震动
        if (throwRating === 'EXCELLENT') {
          setTimeout(() => hapticManager.vibrate('throw_excellent'), 200);
        } else if (throwRating === 'GREAT') {
          setTimeout(() => hapticManager.vibrate('throw_great'), 200);
        } else if (throwRating === 'NICE') {
          setTimeout(() => hapticManager.vibrate('throw_nice'), 200);
        }
        
        // 播放捕捉成功特效
        this._playCatchSuccessEffect(endX, endY, throwRating);
        
        this._stopAnimation();
        this._isBusy = false;
        this._session = null;
        this.dispatchEvent(new CustomEvent('caught', { detail: result }));
      } else if (result.result === 'FLED') {
        // 触发逃脱震动
        hapticManager.vibrate('catch_fled');
        
        // 播放逃脱特效
        this._playFledEffect(endX, endY);
        
        this._stopAnimation();
        this._isBusy = false;
        this._session = null;
        this.dispatchEvent(new CustomEvent('fled', { detail: result }));
      } else {
        // Ball used, pokemon still free — shake animation
        this.dispatchEvent(new CustomEvent('ballUsed', { detail: result }));
        
        // 触发命中震动
        hapticManager.vibrate('catch_hit');
        
        // 播放晃动特效
        this._playBallShakeEffect(endX, endY);
        
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

  /**
   * 使用特效系统的投掷动画
   * @private
   */
  async _animateThrowWithEffects({ startX, startY, endX, endY, velocityX, velocityY, isCurve }) {
    if (!this._effectsSystem.throwAnimation && this._ThrowAnimation) {
      this._effectsSystem.throwAnimation = new this._ThrowAnimation(this._canvas);
    }

    if (this._effectsSystem.throwAnimation) {
      await this._effectsSystem.throwAnimation.start({
        startX, startY,
        targetX: endX, targetY: endY,
        ballType: this._session.ballType,
        isCurve,
        curveDirection: velocityX > 0 ? 1 : -1
      });
    } else {
      // 降级到原有动画
      this._ball = { x: startX, y: startY, vx: velocityX * 0.016, vy: velocityY * 0.016 - 5, phase: 'flying' };
      await this._animateBallFlight(endX, endY);
    }
  }

  /**
   * 播放捕捉成功特效
   * @private
   */
  _playCatchSuccessEffect(x, y, throwRating) {
    if (!this._effectsEnabled || !this._ParticleSystem) return;

    // 初始化粒子系统
    if (!this._effectsSystem.particles) {
      this._effectsSystem.particles = new this._ParticleSystem(this._canvas);
      this._effectsSystem.particles.start();
    }

    // 播放成功特效
    this._effectsSystem.particles.catchSuccess(x, y);

    // 优秀投掷额外特效
    if (throwRating === 'EXCELLENT') {
      setTimeout(() => {
        this._effectsSystem.particles.excellentThrow(x, y);
      }, 300);
    }

    // 更新连击
    if (this._effectsSystem.combo) {
      const comboResult = this._effectsSystem.combo.recordCatch();
      
      if (comboResult.combo >= 3) {
        setTimeout(() => {
          this._effectsSystem.particles.comboEffect(x, y, comboResult.combo);
        }, 500);
        
        this.dispatchEvent(new CustomEvent('combo', { detail: comboResult }));
      }

      if (comboResult.milestone) {
        this.dispatchEvent(new CustomEvent('milestone', { detail: comboResult.milestone }));
      }
    }
  }

  /**
   * 播放逃脱特效
   * @private
   */
  _playFledEffect(x, y) {
    if (!this._effectsEnabled || !this._ParticleSystem) return;

    if (!this._effectsSystem.particles) {
      this._effectsSystem.particles = new this._ParticleSystem(this._canvas);
      this._effectsSystem.particles.start();
    }

    this._effectsSystem.particles.pokemonFled(x, y);

    // 重置连击
    if (this._effectsSystem.combo) {
      this._effectsSystem.combo.reset();
    }
  }

  /**
   * 播放精灵球晃动特效
   * @private
   */
  _playBallShakeEffect(x, y) {
    if (!this._effectsEnabled || !this._ParticleSystem) return;

    if (!this._effectsSystem.particles) {
      this._effectsSystem.particles = new this._ParticleSystem(this._canvas);
      this._effectsSystem.particles.start();
    }

    this._effectsSystem.particles.ballShake(x, y);
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
    
    // 停止特效系统
    if (this._effectsSystem && this._effectsSystem.particles) {
      this._effectsSystem.particles.stop();
    }
    
    this.dispatchEvent(new CustomEvent('abandoned'));
  }

  /**
   * 获取连击状态
   */
  getComboState() {
    if (!this._effectsSystem || !this._effectsSystem.combo) {
      return null;
    }
    return this._effectsSystem.combo.getState();
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
  get effectsEnabled() { return this._effectsEnabled; }
}
