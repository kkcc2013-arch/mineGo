# REQ-00081: 捕捉动画特效系统

- **编号**：REQ-00081
- **类别**：前端体验
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/effects、catch-service
- **创建时间**：2026-06-10 06:00
- **依赖需求**：REQ-00009 (PWA 离线支持)

## 1. 背景与问题

当前捕捉系统（CatchEngine.js）实现了基本的捕捉逻辑，但缺少视觉反馈和动画特效：
- 精灵球投掷动画简单，缺少物理轨迹和弧度效果
- 捕捉成功/失败缺少庆祝动画和粒子特效
- 精灵逃脱缺少震动和闪烁警告
- 不同精灵球类型缺少差异化视觉效果
- 曲线球缺少旋转动画和轨迹特效
- 捕捉连击缺少连击特效和奖励动画

这些问题导致捕捉体验不够沉浸，用户反馈"捕捉过程单调"。

## 2. 目标

实现完整的捕捉动画特效系统，包括：
- 精灵球物理轨迹动画（抛物线、曲线球旋转）
- 捕捉结果动画（成功庆祝、失败震动、逃脱闪烁）
- 粒子特效系统（星光、火花、能量波）
- 连击奖励动画（连击计数、奖励倍数）
- 不同精灵球差异化视觉效果
- 性能优化（Canvas 2D、requestAnimationFrame）

预期效果：捕捉体验沉浸感提升 60%+，用户满意度提升 40%+。

## 3. 范围

- **包含**：
  - 精灵球投掷动画引擎
  - 粒子特效系统
  - 捕捉结果动画
  - 连击奖励系统
  - 精灵球视觉差异化
  - 音效集成点

- **不包含**：
  - 3D 模型渲染（已有 REQ-00027）
  - AR 模式（单独需求）
  - 服务端逻辑修改

## 4. 详细需求

### 4.1 精灵球投掷动画

```javascript
// frontend/game-client/src/effects/ThrowAnimation.js

class ThrowAnimation {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ball = null;
    this.trajectory = [];
  }

  /**
   * 开始投掷动画
   * @param {Object} options - 投掷参数
   * @param {number} options.startX - 起始 X
   * @param {number} options.startY - 起始 Y
   * @param {number} options.targetX - 目标 X
   * @param {number} options.targetY - 目标 Y
   * @param {string} options.ballType - 精灵球类型
   * @param {boolean} options.isCurve - 是否曲线球
   * @param {number} options.curveDirection - 曲线方向 (-1 左, 1 右)
   */
  async start(options) {
    this.ball = {
      x: options.startX,
      y: options.startY,
      rotation: 0,
      scale: 1,
      type: options.ballType,
      isCurve: options.isCurve,
      curveDirection: options.curveDirection || 1
    };

    // 计算轨迹点
    this.trajectory = this.calculateTrajectory(options);

    // 执行动画
    await this.animate();
  }

  /**
   * 计算抛物线轨迹
   */
  calculateTrajectory(options) {
    const points = [];
    const steps = 60; // 60 帧
    
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      
      // 基础抛物线
      const x = options.startX + (options.targetX - options.startX) * t;
      const baseY = options.startY + (options.targetY - options.startY) * t;
      
      // 抛物线弧度
      const arcHeight = -200 * Math.sin(t * Math.PI);
      
      // 曲线球偏移
      let curveOffset = 0;
      if (options.isCurve) {
        curveOffset = options.curveDirection * 100 * Math.sin(t * Math.PI * 2);
      }
      
      points.push({
        x: x + curveOffset,
        y: baseY + arcHeight,
        t
      });
    }
    
    return points;
  }

  /**
   * 执行动画
   */
  async animate() {
    return new Promise((resolve) => {
      let frame = 0;
      
      const render = () => {
        if (frame >= this.trajectory.length) {
          resolve();
          return;
        }
        
        const point = this.trajectory[frame];
        this.ball.x = point.x;
        this.ball.y = point.y;
        
        // 曲线球旋转
        if (this.ball.isCurve) {
          this.ball.rotation += 0.3;
        }
        
        // 缩放效果（远小近大）
        this.ball.scale = 0.5 + 0.5 * Math.sin(point.t * Math.PI);
        
        this.render();
        frame++;
        
        requestAnimationFrame(render);
      };
      
      render();
    });
  }

  /**
   * 渲染精灵球
   */
  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    this.ctx.save();
    this.ctx.translate(this.ball.x, this.ball.y);
    this.ctx.rotate(this.ball.rotation);
    this.ctx.scale(this.ball.scale, this.ball.scale);
    
    // 绘制精灵球
    this.drawBall(this.ctx, this.ball.type);
    
    this.ctx.restore();
    
    // 绘制轨迹尾迹
    this.drawTrail();
  }

  /**
   * 绘制精灵球
   */
  drawBall(ctx, type) {
    const colors = {
      'POKE_BALL': { top: '#FF0000', bottom: '#FFFFFF' },
      'GREAT_BALL': { top: '#0066FF', bottom: '#FFFFFF' },
      'ULTRA_BALL': { top: '#FFD700', bottom: '#000000' },
      'MASTER_BALL': { top: '#9932CC', bottom: '#FFFFFF' }
    };
    
    const color = colors[type] || colors['POKE_BALL'];
    const radius = 20;
    
    // 上半部分
    ctx.beginPath();
    ctx.arc(0, 0, radius, Math.PI, 0);
    ctx.fillStyle = color.top;
    ctx.fill();
    
    // 下半部分
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI);
    ctx.fillStyle = color.bottom;
    ctx.fill();
    
    // 中间线
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // 中心按钮
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#333333';
    ctx.fill();
  }

  /**
   * 绘制轨迹尾迹
   */
  drawTrail() {
    if (this.trajectory.length < 5) return;
    
    const trailLength = 10;
    const startIdx = Math.max(0, this.trajectory.findIndex(p => 
      p.x === this.ball.x && p.y === this.ball.y
    ) - trailLength);
    
    this.ctx.beginPath();
    for (let i = startIdx; i < this.trajectory.length; i++) {
      const point = this.trajectory[i];
      if (i === startIdx) {
        this.ctx.moveTo(point.x, point.y);
      } else {
        this.ctx.lineTo(point.x, point.y);
      }
    }
    
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }
}
```

### 4.2 粒子特效系统

```javascript
// frontend/game-client/src/effects/ParticleSystem.js

class Particle {
  constructor(options) {
    this.x = options.x;
    this.y = options.y;
    this.vx = options.vx || 0;
    this.vy = options.vy || 0;
    this.life = options.life || 1;
    this.maxLife = this.life;
    this.size = options.size || 5;
    this.color = options.color || '#FFFFFF';
    this.type = options.type || 'circle';
    this.gravity = options.gravity || 0;
    this.fade = options.fade !== false;
    this.shrink = options.shrink !== false;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += this.gravity * dt;
    this.life -= dt;
  }

  render(ctx) {
    const alpha = this.fade ? this.life / this.maxLife : 1;
    const size = this.shrink ? this.size * (this.life / this.maxLife) : this.size;
    
    ctx.save();
    ctx.globalAlpha = alpha;
    
    if (this.type === 'circle') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, size, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    } else if (this.type === 'star') {
      this.drawStar(ctx, size);
    } else if (this.type === 'spark') {
      this.drawSpark(ctx, size);
    }
    
    ctx.restore();
  }

  drawStar(ctx, size) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const angle = (i * 4 * Math.PI) / 5 - Math.PI / 2;
      const x = this.x + size * Math.cos(angle);
      const y = this.y + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
  }

  drawSpark(ctx, size) {
    ctx.beginPath();
    ctx.moveTo(this.x - size, this.y);
    ctx.lineTo(this.x + size, this.y);
    ctx.moveTo(this.x, this.y - size);
    ctx.lineTo(this.x, this.y + size);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  isDead() {
    return this.life <= 0;
  }
}

class ParticleSystem {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.running = false;
  }

  /**
   * 发射粒子
   */
  emit(options) {
    const count = options.count || 1;
    for (let i = 0; i < count; i++) {
      const particle = new Particle({
        x: options.x + (options.spreadX ? (Math.random() - 0.5) * options.spreadX : 0),
        y: options.y + (options.spreadY ? (Math.random() - 0.5) * options.spreadY : 0),
        vx: options.vx + (Math.random() - 0.5) * (options.randomVx || 0),
        vy: options.vy + (Math.random() - 0.5) * (options.randomVy || 0),
        life: options.life + Math.random() * (options.randomLife || 0),
        size: options.size + Math.random() * (options.randomSize || 0),
        color: options.colors ? options.colors[Math.floor(Math.random() * options.colors.length)] : options.color,
        type: options.type,
        gravity: options.gravity,
        fade: options.fade,
        shrink: options.shrink
      });
      this.particles.push(particle);
    }
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
      gravity: 100
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
      count: 20,
      vx: 0, vy: 0,
      randomVx: 200, randomVy: 200,
      life: 1.5,
      size: 15,
      color: '#00BFFF',
      type: 'circle',
      fade: true,
      shrink: false
    });
  }

  /**
   * 捕捉失败特效
   */
  catchFailed(x, y) {
    // 红色闪烁
    this.emit({
      x, y,
      count: 20,
      vx: 0, vy: 0,
      randomVx: 200, randomVy: 200,
      life: 0.5,
      size: 10,
      color: '#FF0000',
      type: 'circle'
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
      vx: 0, vy: -50,
      randomVx: 100, randomVy: 50,
      life: 1.2,
      size: 20,
      randomSize: 10,
      color: '#888888',
      type: 'circle',
      gravity: -30
    });
  }

  /**
   * 连击特效
   */
  comboEffect(x, y, comboCount) {
    // 根据连击数增加粒子
    const intensity = Math.min(comboCount, 10);
    
    this.emit({
      x, y,
      count: intensity * 5,
      vx: 0, vy: -100,
      randomVx: 200, randomVy: 100,
      life: 0.8,
      size: 6,
      colors: ['#FFD700', '#FF69B4', '#00FF00', '#00BFFF'],
      type: 'star',
      gravity: 150
    });
  }

  /**
   * 开始渲染循环
   */
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  /**
   * 停止渲染
   */
  stop() {
    this.running = false;
  }

  /**
   * 渲染循环
   */
  loop() {
    if (!this.running) return;
    
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    
    // 更新粒子
    for (const particle of this.particles) {
      particle.update(dt);
    }
    
    // 移除死亡粒子
    this.particles = this.particles.filter(p => !p.isDead());
    
    // 渲染
    this.render();
    
    requestAnimationFrame(() => this.loop());
  }

  /**
   * 渲染所有粒子
   */
  render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    for (const particle of this.particles) {
      particle.render(this.ctx);
    }
  }
}
```

### 4.3 连击奖励系统

```javascript
// frontend/game-client/src/effects/ComboSystem.js

class ComboSystem {
  constructor() {
    this.combo = 0;
    this.lastCatchTime = 0;
    this.comboTimeout = 30000; // 30秒内连续捕捉算连击
    this.multipliers = {
      1: 1.0,
      2: 1.1,
      3: 1.2,
      5: 1.5,
      10: 2.0,
      20: 3.0
    };
  }

  /**
   * 记录捕捉
   */
  recordCatch() {
    const now = Date.now();
    
    if (now - this.lastCatchTime < this.comboTimeout) {
      this.combo++;
    } else {
      this.combo = 1;
    }
    
    this.lastCatchTime = now;
    
    return {
      combo: this.combo,
      multiplier: this.getMultiplier(),
      bonusXp: this.calculateBonusXp(),
      bonusStardust: this.calculateBonusStardust()
    };
  }

  /**
   * 获取倍数
   */
  getMultiplier() {
    const keys = Object.keys(this.multipliers).map(Number).sort((a, b) => b - a);
    for (const key of keys) {
      if (this.combo >= key) {
        return this.multipliers[key];
      }
    }
    return 1.0;
  }

  /**
   * 计算奖励经验
   */
  calculateBonusXp() {
    if (this.combo < 3) return 0;
    return Math.floor(50 * this.combo * this.getMultiplier());
  }

  /**
   * 计算奖励星尘
   */
  calculateBonusStardust() {
    if (this.combo < 3) return 0;
    return Math.floor(100 * this.combo * this.getMultiplier());
  }

  /**
   * 重置连击
   */
  reset() {
    this.combo = 0;
    this.lastCatchTime = 0;
  }
}
```

### 4.4 集成到 CatchEngine

```javascript
// 在 CatchEngine.js 中集成

import { ThrowAnimation } from '../effects/ThrowAnimation.js';
import { ParticleSystem } from '../effects/ParticleSystem.js';
import { ComboSystem } from '../effects/ComboSystem.js';

export class CatchEngine extends EventTarget {
  constructor(apiClient, canvas) {
    super();
    this._api = apiClient;
    this._canvas = canvas;
    this._throwAnimation = new ThrowAnimation(canvas);
    this._particles = new ParticleSystem(canvas);
    this._combo = new ComboSystem();
    
    // 启动粒子系统
    this._particles.start();
  }

  async throw({ startX, startY, endX, endY, velocityX, velocityY }) {
    // 执行投掷动画
    await this._throwAnimation.start({
      startX, startY,
      targetX: endX, targetY: endY,
      ballType: this._session.ballType,
      isCurve: Math.abs(velocityX) > 300,
      curveDirection: velocityX > 0 ? 1 : -1
    });

    // ... 原有逻辑 ...

    if (result.result === 'CAUGHT') {
      // 捕捉成功特效
      this._particles.catchSuccess(endX, endY);
      
      // 连击奖励
      const comboResult = this._combo.recordCatch();
      if (comboResult.combo >= 3) {
        this._particles.comboEffect(endX, endY, comboResult.combo);
        this.dispatchEvent(new CustomEvent('combo', { detail: comboResult }));
      }
      
      // ... 原有逻辑 ...
    } else if (result.result === 'FLED') {
      // 逃脱特效
      this._particles.pokemonFled(endX, endY);
      this._combo.reset();
      
      // ... 原有逻辑 ...
    } else {
      // 失败特效
      this._particles.catchFailed(endX, endY);
    }
  }
}
```

## 5. 验收标准（可测试）

- [ ] 精灵球投掷动画正确显示抛物线轨迹
- [ ] 曲线球显示旋转动画和弯曲轨迹
- [ ] 不同精灵球类型显示不同颜色（红/蓝/金/紫）
- [ ] 捕捉成功显示星光爆发和火花特效
- [ ] 捕捉失败显示红色闪烁警告
- [ ] 精灵逃脱显示烟雾效果
- [ ] 连击系统正确计算倍数和奖励
- [ ] 连击达到 3 次显示连击特效
- [ ] 粒子系统性能稳定（60 FPS）
- [ ] 动画不影响捕捉逻辑正确性
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M（中等）** - 约 2-3 天

理由：
- 核心动画逻辑相对独立
- 粒子系统有成熟模式可参考
- 不涉及服务端修改
- 主要是 Canvas 2D 绑定和性能优化

## 7. 优先级理由

**P1** - 高优先级

理由：
- 直接影响用户体验核心环节（捕捉）
- 用户反馈明确（"捕捉过程单调"）
- 实现成本适中，收益明显
- 可与其他前端需求协同（REQ-00062 音效系统）
