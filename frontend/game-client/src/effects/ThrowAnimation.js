/**
 * 精灵球投掷动画引擎
 * 支持抛物线轨迹、曲线球旋转、轨迹尾迹、精灵球类型差异化
 */
'use strict';

export class ThrowAnimation {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ball = null;
    this.trajectory = [];
    this.currentFrame = 0;
    this.animationId = null;
    this.trailPoints = [];
    this.maxTrailLength = 15;
  }

  /**
   * 开始投掷动画
   * @param {Object} options - 投掷参数
   * @param {number} options.startX - 起始 X
   * @param {number} options.startY - 起始 Y
   * @param {number} options.targetX - 目标 X
   * @param {number} options.targetY - 目标 Y
   * @param {string} options.ballType - 精灵球类型 (POKE_BALL, GREAT_BALL, ULTRA_BALL, MASTER_BALL)
   * @param {boolean} options.isCurve - 是否曲线球
   * @param {number} options.curveDirection - 曲线方向 (-1 左, 1 右)
   * @param {Function} options.onComplete - 动画完成回调
   */
  async start(options) {
    this.ball = {
      x: options.startX,
      y: options.startY,
      rotation: 0,
      scale: 1,
      type: options.ballType || 'POKE_BALL',
      isCurve: options.isCurve || false,
      curveDirection: options.curveDirection || 1
    };

    this.trailPoints = [];
    this.currentFrame = 0;

    // 计算轨迹点
    this.trajectory = this._calculateTrajectory(options);

    // 执行动画
    return new Promise((resolve) => {
      this._animate(resolve, options.onComplete);
    });
  }

  /**
   * 计算抛物线轨迹
   * @private
   */
  _calculateTrajectory(options) {
    const points = [];
    const steps = 60; // 60 帧 @ 60fps = 1秒
    
    const dx = options.targetX - options.startX;
    const dy = options.targetY - options.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    // 根据距离调整弧度高度
    const arcHeight = -Math.min(300, distance * 0.4);
    
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      
      // 基础抛物线
      const x = options.startX + dx * t;
      const baseY = options.startY + dy * t;
      
      // 抛物线弧度 (sin 曲线)
      const arc = arcHeight * Math.sin(t * Math.PI);
      
      // 曲线球偏移 (正弦波)
      let curveOffset = 0;
      if (options.isCurve) {
        curveOffset = options.curveDirection * 80 * Math.sin(t * Math.PI * 2);
      }
      
      points.push({
        x: x + curveOffset,
        y: baseY + arc,
        t,
        rotation: options.isCurve ? t * Math.PI * 4 : 0
      });
    }
    
    return points;
  }

  /**
   * 执行动画循环
   * @private
   */
  _animate(resolve, onComplete) {
    const render = () => {
      if (this.currentFrame >= this.trajectory.length) {
        // 动画完成
        if (onComplete) onComplete();
        resolve();
        return;
      }

      const point = this.trajectory[this.currentFrame];
      this.ball.x = point.x;
      this.ball.y = point.y;
      this.ball.rotation = point.rotation;
      
      // 缩放效果（远小近大）
      const midT = 0.5;
      const scaleBase = 0.6;
      const scaleRange = 0.4;
      this.ball.scale = scaleBase + scaleRange * (1 - Math.abs(point.t - midT) * 2);

      // 记录轨迹点
      this.trailPoints.push({ x: point.x, y: point.y, alpha: 1 });
      if (this.trailPoints.length > this.maxTrailLength) {
        this.trailPoints.shift();
      }

      // 更新轨迹透明度
      this.trailPoints.forEach((p, idx) => {
        p.alpha = (idx + 1) / this.trailPoints.length;
      });

      this._render();
      this.currentFrame++;

      this.animationId = requestAnimationFrame(render);
    };

    render();
  }

  /**
   * 渲染精灵球和轨迹
   * @private
   */
  _render() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 绘制轨迹尾迹
    this._drawTrail();

    // 绘制精灵球
    this.ctx.save();
    this.ctx.translate(this.ball.x, this.ball.y);
    this.ctx.rotate(this.ball.rotation);
    this.ctx.scale(this.ball.scale, this.ball.scale);

    this._drawBall(this.ctx, this.ball.type);

    this.ctx.restore();
  }

  /**
   * 绘制精灵球
   * @private
   */
  _drawBall(ctx, type) {
    const colors = {
      'POKE_BALL': { top: '#FF0000', bottom: '#FFFFFF', button: '#333333' },
      'GREAT_BALL': { top: '#0066FF', bottom: '#FFFFFF', button: '#FF0000' },
      'ULTRA_BALL': { top: '#FFD700', bottom: '#000000', button: '#FFD700' },
      'MASTER_BALL': { top: '#9932CC', bottom: '#FFFFFF', button: '#FF69B4' }
    };

    const color = colors[type] || colors['POKE_BALL'];
    const radius = 20;

    // 阴影
    ctx.beginPath();
    ctx.arc(2, 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.fill();

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

    // 中间黑线
    ctx.beginPath();
    ctx.moveTo(-radius, 0);
    ctx.lineTo(radius, 0);
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 中心白色按钮
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = color.button;
    ctx.fill();

    // 高光
    ctx.beginPath();
    ctx.arc(-5, -8, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fill();
  }

  /**
   * 绘制轨迹尾迹
   * @private
   */
  _drawTrail() {
    if (this.trailPoints.length < 2) return;

    this.ctx.beginPath();
    this.ctx.moveTo(this.trailPoints[0].x, this.trailPoints[0].y);

    for (let i = 1; i < this.trailPoints.length; i++) {
      const point = this.trailPoints[i];
      this.ctx.lineTo(point.x, point.y);
    }

    // 渐变尾迹
    const gradient = this.ctx.createLinearGradient(
      this.trailPoints[0].x, this.trailPoints[0].y,
      this.trailPoints[this.trailPoints.length - 1].x, 
      this.trailPoints[this.trailPoints.length - 1].y
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.5)');

    this.ctx.strokeStyle = gradient;
    this.ctx.lineWidth = 3;
    this.ctx.lineCap = 'round';
    this.ctx.stroke();
  }

  /**
   * 停止动画
   */
  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * 获取当前位置
   */
  getCurrentPosition() {
    return this.ball ? { x: this.ball.x, y: this.ball.y } : null;
  }
}
