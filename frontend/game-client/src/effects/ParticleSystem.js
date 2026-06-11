/**
 * 粒子特效系统
 * 支持捕捉成功、失败、逃脱、连击等多种特效
 */
'use strict';

/**
 * 单个粒子类
 */
class Particle {
  constructor(options) {
    this.x = options.x || 0;
    this.y = options.y || 0;
    this.vx = options.vx || 0;
    this.vy = options.vy || 0;
    this.life = options.life || 1;
    this.maxLife = this.life;
    this.size = options.size || 5;
    this.color = options.color || '#FFFFFF';
    this.type = options.type || 'circle'; // circle, star, spark, ring
    this.gravity = options.gravity || 0;
    this.fade = options.fade !== false;
    this.shrink = options.shrink !== false;
    this.rotation = options.rotation || 0;
    this.rotationSpeed = options.rotationSpeed || 0;
  }

  /**
   * 更新粒子状态
   */
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += this.gravity * dt;
    this.life -= dt;
    this.rotation += this.rotationSpeed * dt;
  }

  /**
   * 渲染粒子
   */
  render(ctx) {
    const alpha = this.fade ? Math.max(0, this.life / this.maxLife) : 1;
    const size = this.shrink ? Math.max(0.1, this.size * (this.life / this.maxLife)) : this.size;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    switch (this.type) {
      case 'circle':
        this._drawCircle(ctx, size);
        break;
      case 'star':
        this._drawStar(ctx, size);
        break;
      case 'spark':
        this._drawSpark(ctx, size);
        break;
      case 'ring':
        this._drawRing(ctx, size);
        break;
    }

    ctx.restore();
  }

  _drawCircle(ctx, size) {
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }

  _drawStar(ctx, size) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const angle = (i * 4 * Math.PI) / 5 - Math.PI / 2;
      const x = size * Math.cos(angle);
      const y = size * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
  }

  _drawSpark(ctx, size) {
    ctx.beginPath();
    ctx.moveTo(-size, 0);
    ctx.lineTo(size, 0);
    ctx.moveTo(0, -size);
    ctx.lineTo(0, size);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  _drawRing(ctx, size) {
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /**
   * 判断粒子是否死亡
   */
  isDead() {
    return this.life <= 0;
  }
}

/**
 * 粒子系统主类
 */
export class ParticleSystem {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.running = false;
    this.lastTime = 0;
    this.animationId = null;
  }

  /**
   * 发射粒子
   */
  emit(options) {
    const count = options.count || 1;
    const particles = [];

    for (let i = 0; i < count; i++) {
      const particle = new Particle({
        x: options.x + (options.spreadX ? (Math.random() - 0.5) * options.spreadX : 0),
        y: options.y + (options.spreadY ? (Math.random() - 0.5) * options.spreadY : 0),
        vx: (options.vx || 0) + (Math.random() - 0.5) * (options.randomVx || 0),
        vy: (options.vy || 0) + (Math.random() - 0.5) * (options.randomVy || 0),
        life: (options.life || 1) + Math.random() * (options.randomLife || 0),
        size: (options.size || 5) + Math.random() * (options.randomSize || 0),
        color: options.colors 
          ? options.colors[Math.floor(Math.random() * options.colors.length)] 
          : options.color || '#FFFFFF',
        type: options.type || 'circle',
        gravity: options.gravity || 0,
        fade: options.fade !== false,
        shrink: options.shrink !== false,
        rotationSpeed: options.rotationSpeed || 0
      });
      particles.push(particle);
    }

    this.particles.push(...particles);
    return particles;
  }

  /**
   * 捕捉成功特效
   */
  catchSuccess(x, y) {
    // 星光爆发
    this.emit({
      x, y,
      count: 30,
      vx: 0, vy: 0,
      randomVx: 400, randomVy: 400,
      life: 1,
      size: 8,
      colors: ['#FFD700', '#FFA500', '#FF6347', '#FFFFFF'],
      type: 'star',
      gravity: 100,
      rotationSpeed: 3
    });

    // 火花
    this.emit({
      x, y,
      count: 50,
      vx: 0, vy: -200,
      randomVx: 300, randomVy: 100,
      life: 0.8,
      size: 4,
      colors: ['#FF4500', '#FF6347', '#FFD700'],
      type: 'spark',
      gravity: 200
    });

    // 能量环
    this.emit({
      x, y,
      count: 15,
      vx: 0, vy: 0,
      randomVx: 150, randomVy: 150,
      life: 1.5,
      size: 20,
      color: '#00BFFF',
      type: 'ring',
      fade: true,
      shrink: false
    });

    // 金色光点
    this.emit({
      x, y,
      count: 40,
      vx: 0, vy: -100,
      randomVx: 200, randomVy: 150,
      life: 1.2,
      size: 6,
      colors: ['#FFD700', '#FFFF00', '#FFA500'],
      type: 'circle',
      gravity: 80
    });
  }

  /**
   * 捕捉失败特效
   */
  catchFailed(x, y) {
    // 红色闪烁
    this.emit({
      x, y,
      count: 25,
      vx: 0, vy: 0,
      randomVx: 200, randomVy: 200,
      life: 0.5,
      size: 12,
      colors: ['#FF0000', '#FF4500', '#FF6347'],
      type: 'circle',
      fade: true,
      shrink: true
    });

    // 红色火花
    this.emit({
      x, y,
      count: 20,
      vx: 0, vy: -100,
      randomVx: 150, randomVy: 80,
      life: 0.6,
      size: 3,
      colors: ['#FF0000', '#FF4500'],
      type: 'spark',
      gravity: 150
    });
  }

  /**
   * 精灵逃脱特效
   */
  pokemonFled(x, y) {
    // 烟雾效果
    this.emit({
      x, y,
      count: 40,
      vx: 0, vy: -30,
      randomVx: 80, randomVy: 40,
      life: 1.5,
      size: 25,
      randomSize: 15,
      colors: ['#888888', '#AAAAAA', '#666666'],
      type: 'circle',
      gravity: -20,
      fade: true,
      shrink: true
    });

    // 白色闪光
    this.emit({
      x, y,
      count: 15,
      vx: 0, vy: 0,
      randomVx: 100, randomVy: 100,
      life: 0.3,
      size: 30,
      color: '#FFFFFF',
      type: 'circle',
      fade: true,
      shrink: true
    });
  }

  /**
   * 连击特效
   */
  comboEffect(x, y, comboCount) {
    // 根据连击数调整强度
    const intensity = Math.min(comboCount, 10);

    // 彩色星星
    this.emit({
      x, y,
      count: intensity * 4,
      vx: 0, vy: -150,
      randomVx: 250, randomVy: 100,
      life: 0.8,
      size: 8,
      colors: ['#FFD700', '#FF69B4', '#00FF00', '#00BFFF', '#FF6347'],
      type: 'star',
      gravity: 120,
      rotationSpeed: 5
    });

    // 能量波
    this.emit({
      x, y,
      count: intensity * 2,
      vx: 0, vy: 0,
      randomVx: 100, randomVy: 100,
      life: 1,
      size: 15,
      colors: ['#FFD700', '#00BFFF'],
      type: 'ring',
      fade: true,
      shrink: false
    });
  }

  /**
   * 精灵球晃动特效
   */
  ballShake(x, y) {
    this.emit({
      x, y,
      count: 10,
      spreadX: 20,
      spreadY: 20,
      vx: 0, vy: -50,
      randomVx: 50, randomVy: 30,
      life: 0.4,
      size: 4,
      colors: ['#FFFFFF', '#FFD700'],
      type: 'circle',
      fade: true
    });
  }

  /**
   * 优秀投掷特效
   */
  excellentThrow(x, y) {
    // 大量金色星星
    this.emit({
      x, y,
      count: 50,
      vx: 0, vy: 0,
      randomVx: 500, randomVy: 500,
      life: 1.2,
      size: 10,
      colors: ['#FFD700', '#FFFF00', '#FFA500'],
      type: 'star',
      gravity: 80,
      rotationSpeed: 4
    });

    // 彩虹环
    this.emit({
      x, y,
      count: 20,
      vx: 0, vy: 0,
      randomVx: 200, randomVy: 200,
      life: 1.5,
      size: 15,
      colors: ['#FF0000', '#FFA500', '#FFFF00', '#00FF00', '#0000FF', '#8B00FF'],
      type: 'ring',
      fade: true,
      shrink: false
    });
  }

  /**
   * 开始渲染循环
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this._loop();
  }

  /**
   * 停止渲染
   */
  stop() {
    this.running = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.particles = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * 渲染循环
   * @private
   */
  _loop() {
    if (!this.running) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1); // 限制最大 dt
    this.lastTime = now;

    // 更新所有粒子
    for (const particle of this.particles) {
      particle.update(dt);
    }

    // 移除死亡粒子
    this.particles = this.particles.filter(p => !p.isDead());

    // 渲染
    this._render();

    this.animationId = requestAnimationFrame(() => this._loop());
  }

  /**
   * 渲染所有粒子
   * @private
   */
  _render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const particle of this.particles) {
      particle.render(this.ctx);
    }
  }

  /**
   * 获取活跃粒子数量
   */
  getParticleCount() {
    return this.particles.length;
  }

  /**
   * 清除所有粒子
   */
  clear() {
    this.particles = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
