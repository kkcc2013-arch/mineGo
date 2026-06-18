# REQ-00258: 精灵捕捉动画特效系统增强与粒子效果优化

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00258 |
| 标题 | 精灵捕捉动画特效系统增强与粒子效果优化 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、frontend/game-client/src/effects、frontend/game-client/src/game/CatchEngine.js、gateway |
| 创建时间 | 2026-06-18 14:00 |

## 需求描述

精灵捕捉是游戏核心体验之一，捕捉动画的视觉效果直接影响玩家的成就感和沉浸感。当前的捕捉动画较为简单，缺乏足够的视觉冲击力和反馈层次。

### 核心问题

1. **动画单调性**：不同精灵类型的捕捉动画缺乏差异化，稀有度区分不明显
2. **粒子效果性能瓶颈**：低端设备上粒子数量过多导致帧率下降
3. **缺少音效同步**：动画与音效、触觉反馈缺乏精确同步
4. **无质量适配**：未根据设备性能动态调整特效质量

### 目标

- 增强捕捉动画视觉冲击力，提升玩家成就感
- 根据精灵稀有度、属性呈现差异化动画效果
- 智能适配设备性能，保证流畅体验
- 实现动画、音效、触觉反馈的精确同步

## 技术方案

### 1. 捕捉动画特效引擎

```javascript
// frontend/game-client/src/effects/CatchAnimationEngine.js

import { ParticleSystem } from './ParticleSystem.js';
import { GlowEffect } from './GlowEffect.js';
import { ScreenShake } from './ScreenShake.js';
import { PerformanceMonitor } from '../utils/PerformanceMonitor.js';

export class CatchAnimationEngine {
  constructor(options = {}) {
    this.performanceMonitor = new PerformanceMonitor();
    this.qualityLevel = this.performanceMonitor.getQualityLevel();
    
    // 稀有度配置
    this.rarityConfigs = {
      common: {
        particleCount: 50,
        glowIntensity: 0.6,
        shakeIntensity: 2,
        duration: 800,
        colors: ['#FFFFFF', '#E0E0E0', '#BDBDBD'],
        soundEffect: 'catch_common'
      },
      uncommon: {
        particleCount: 80,
        glowIntensity: 0.75,
        shakeIntensity: 3,
        duration: 1000,
        colors: ['#4CAF50', '#81C784', '#A5D6A7'],
        soundEffect: 'catch_uncommon'
      },
      rare: {
        particleCount: 120,
        glowIntensity: 0.85,
        shakeIntensity: 4,
        duration: 1200,
        colors: ['#2196F3', '#64B5F6', '#90CAF9'],
        soundEffect: 'catch_rare'
      },
      epic: {
        particleCount: 180,
        glowIntensity: 0.9,
        shakeIntensity: 6,
        duration: 1500,
        colors: ['#9C27B0', '#BA68C8', '#CE93D8'],
        soundEffect: 'catch_epic'
      },
      legendary: {
        particleCount: 250,
        glowIntensity: 1.0,
        shakeIntensity: 8,
        duration: 2000,
        colors: ['#FFD700', '#FFC107', '#FF9800'],
        soundEffect: 'catch_legendary',
        specialEffect: 'rainbow_aura'
      },
      mythic: {
        particleCount: 350,
        glowIntensity: 1.0,
        shakeIntensity: 10,
        duration: 3000,
        colors: ['#FF1744', '#F50057', '#D500F9', '#651FFF', '#2979FF'],
        soundEffect: 'catch_mythic',
        specialEffect: 'cosmic_explosion'
      }
    };
    
    // 属性类型粒子效果配置
    this.typeConfigs = {
      fire: {
        particleShape: 'flame',
        trailEffect: true,
        gravity: -0.5 // 火焰上升
      },
      water: {
        particleShape: 'droplet',
        trailEffect: true,
        gravity: 0.3
      },
      electric: {
        particleShape: 'spark',
        trailEffect: false,
        gravity: 0,
        flashEffect: true
      },
      grass: {
        particleShape: 'leaf',
        trailEffect: true,
        gravity: 0.1,
        spiralMotion: true
      },
      ice: {
        particleShape: 'crystal',
        trailEffect: true,
        gravity: 0.2,
        shatterEffect: true
      },
      psychic: {
        particleShape: 'ring',
        trailEffect: false,
        gravity: -0.1,
        spiralMotion: true
      },
      dragon: {
        particleShape: 'dragon_scale',
        trailEffect: true,
        gravity: 0.05,
        auraGlow: true
      },
      dark: {
        particleShape: 'shadow',
        trailEffect: false,
        gravity: -0.2,
        fadeIn: true
      },
      fairy: {
        particleShape: 'star',
        trailEffect: true,
        gravity: -0.15,
        sparkleEffect: true
      }
    };
  }
  
  /**
   * 播放捕捉动画
   * @param {Object} pokemon - 捕捉的精灵信息
   * @param {Object} options - 动画选项
   */
  async playCatchAnimation(pokemon, options = {}) {
    const config = this.getAnimationConfig(pokemon);
    const adjustedConfig = this.adjustForPerformance(config);
    
    // 创建动画序列
    const animationSequence = this.createAnimationSequence(adjustedConfig, pokemon);
    
    // 同步播放所有效果
    await Promise.all([
      this.playParticleEffect(animationSequence.particles, adjustedConfig),
      this.playGlowEffect(animationSequence.glow, adjustedConfig),
      this.playScreenShake(adjustedConfig),
      this.playSoundEffect(adjustedConfig),
      this.playHapticFeedback(adjustedConfig)
    ]);
    
    // 特殊效果
    if (adjustedConfig.specialEffect) {
      await this.playSpecialEffect(adjustedConfig.specialEffect, pokemon);
    }
  }
  
  /**
   * 获取动画配置
   */
  getAnimationConfig(pokemon) {
    const rarity = pokemon.rarity || 'common';
    const types = pokemon.types || ['normal'];
    
    const baseConfig = { ...this.rarityConfigs[rarity] };
    const typeConfig = types.map(type => this.typeConfigs[type] || {});
    
    // 合并属性配置
    baseConfig.typeEffects = typeConfig;
    baseConfig.primaryType = types[0];
    
    return baseConfig;
  }
  
  /**
   * 根据性能调整配置
   */
  adjustForPerformance(config) {
    const fps = this.performanceMonitor.getCurrentFPS();
    const qualityMultiplier = this.qualityLevel === 'high' ? 1.0 :
                             this.qualityLevel === 'medium' ? 0.6 :
                             this.qualityLevel === 'low' ? 0.3 : 0.2;
    
    return {
      ...config,
      particleCount: Math.floor(config.particleCount * qualityMultiplier),
      glowIntensity: config.glowIntensity * qualityMultiplier,
      shakeIntensity: Math.floor(config.shakeIntensity * qualityMultiplier),
      enableTrailEffect: fps > 45 && config.trailEffect,
      enablePostProcessing: this.qualityLevel === 'high'
    };
  }
  
  /**
   * 创建动画序列
   */
  createAnimationSequence(config, pokemon) {
    return {
      particles: this.createParticleSequence(config, pokemon),
      glow: this.createGlowSequence(config, pokemon)
    };
  }
  
  /**
   * 创建粒子序列
   */
  createParticleSequence(config, pokemon) {
    const particles = [];
    const { particleCount, colors, duration, typeEffects } = config;
    
    for (let i = 0; i < particleCount; i++) {
      const particle = {
        id: `particle_${i}`,
        startTime: Math.random() * duration * 0.3,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 4 + Math.random() * 8,
        velocity: {
          x: (Math.random() - 0.5) * 10,
          y: (Math.random() - 0.5) * 10
        },
        lifetime: duration * (0.5 + Math.random() * 0.5),
        type: typeEffects[0]?.particleShape || 'circle'
      };
      
      // 应用属性特定效果
      if (typeEffects[0]?.gravity) {
        particle.gravity = typeEffects[0].gravity;
      }
      
      particles.push(particle);
    }
    
    return particles;
  }
  
  /**
   * 播放粒子效果
   */
  async playParticleEffect(particles, config) {
    const particleSystem = new ParticleSystem({
      maxParticles: config.particleCount,
      enableTrails: config.enableTrailEffect
    });
    
    return new Promise((resolve) => {
      let startTime = null;
      let particleIndex = 0;
      
      const animate = (timestamp) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        
        // 发射粒子
        while (particleIndex < particles.length && 
               particles[particleIndex].startTime <= elapsed) {
          particleSystem.emit(particles[particleIndex]);
          particleIndex++;
        }
        
        // 更新和渲染
        particleSystem.update(elapsed);
        particleSystem.render();
        
        if (elapsed < config.duration) {
          requestAnimationFrame(animate);
        } else {
          particleSystem.clear();
          resolve();
        }
      };
      
      requestAnimationFrame(animate);
    });
  }
  
  /**
   * 播放辉光效果
   */
  async playGlowEffect(glowSequence, config) {
    const glowEffect = new GlowEffect({
      intensity: config.glowIntensity,
      duration: config.duration,
      colors: config.colors
    });
    
    return glowEffect.play();
  }
  
  /**
   * 播放屏幕震动
   */
  async playScreenShake(config) {
    const screenShake = new ScreenShake({
      intensity: config.shakeIntensity,
      duration: config.duration * 0.5
    });
    
    return screenShake.play();
  }
  
  /**
   * 播放音效
   */
  async playSoundEffect(config) {
    const { AudioManager } = await import('../audio/AudioManager.js');
    const audioManager = AudioManager.getInstance();
    
    return audioManager.playEffect(config.soundEffect, {
      volume: 0.8,
      spatial: true
    });
  }
  
  /**
   * 播放触觉反馈
   */
  async playHapticFeedback(config) {
    if (!navigator.vibrate) return;
    
    const patterns = {
      common: [50],
      uncommon: [50, 30, 50],
      rare: [80, 40, 80, 40, 80],
      epic: [100, 50, 100, 50, 100, 50, 100],
      legendary: [150, 50, 150, 50, 150, 50, 150, 50, 150],
      mythic: [200, 50, 200, 50, 200, 50, 200, 50, 200, 50, 200]
    };
    
    const pattern = patterns[config.rarity] || patterns.common;
    
    try {
      await navigator.vibrate(pattern);
    } catch (e) {
      // 静默失败
    }
  }
  
  /**
   * 播放特殊效果
   */
  async playSpecialEffect(effectType, pokemon) {
    switch (effectType) {
      case 'rainbow_aura':
        await this.playRainbowAura(pokemon);
        break;
      case 'cosmic_explosion':
        await this.playCosmicExplosion(pokemon);
        break;
    }
  }
  
  /**
   * 彩虹光环效果
   */
  async playRainbowAura(pokemon) {
    const { SpecialEffectRenderer } = await import('./SpecialEffectRenderer.js');
    const renderer = new SpecialEffectRenderer();
    
    return renderer.renderRainbowAura({
      target: pokemon,
      duration: 3000,
      ringCount: 3
    });
  }
  
  /**
   * 宇宙爆炸效果
   */
  async playCosmicExplosion(pokemon) {
    const { SpecialEffectRenderer } = await import('./SpecialEffectRenderer.js');
    const renderer = new SpecialEffectRenderer();
    
    return renderer.renderCosmicExplosion({
      target: pokemon,
      duration: 4000,
      starCount: 50,
      nebulaEffect: true
    });
  }
}
```

### 2. 高性能粒子系统

```javascript
// frontend/game-client/src/effects/ParticleSystem.js

export class ParticleSystem {
  constructor(options = {}) {
    this.maxParticles = options.maxParticles || 1000;
    this.enableTrails = options.enableTrails || false;
    
    // 使用对象池优化性能
    this.particlePool = [];
    this.activeParticles = [];
    
    // WebGL 渲染器（高性能模式）
    this.useWebGL = this.detectWebGLSupport() && options.enableWebGL !== false;
    
    if (this.useWebGL) {
      this.initWebGLRenderer();
    } else {
      this.initCanvasRenderer();
    }
    
    // 预分配粒子对象池
    this.preallocateParticles(this.maxParticles);
  }
  
  /**
   * 预分配粒子对象池
   */
  preallocateParticles(count) {
    for (let i = 0; i < count; i++) {
      this.particlePool.push({
        id: null,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        size: 4,
        color: '#FFFFFF',
        alpha: 1,
        lifetime: 0,
        age: 0,
        gravity: 0,
        active: false,
        type: 'circle'
      });
    }
  }
  
  /**
   * 从对象池获取粒子
   */
  getParticle() {
    for (const particle of this.particlePool) {
      if (!particle.active) {
        particle.active = true;
        return particle;
      }
    }
    
    // 对象池耗尽，创建新粒子
    const newParticle = {
      id: null,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: 4,
      color: '#FFFFFF',
      alpha: 1,
      lifetime: 0,
      age: 0,
      gravity: 0,
      active: true,
      type: 'circle'
    };
    this.particlePool.push(newParticle);
    return newParticle;
  }
  
  /**
   * 发射粒子
   */
  emit(config) {
    const particle = this.getParticle();
    
    particle.id = config.id;
    particle.x = config.x || window.innerWidth / 2;
    particle.y = config.y || window.innerHeight / 2;
    particle.vx = config.velocity?.x || (Math.random() - 0.5) * 10;
    particle.vy = config.velocity?.y || (Math.random() - 0.5) * 10;
    particle.size = config.size || 4;
    particle.color = config.color || '#FFFFFF';
    particle.alpha = 1;
    particle.lifetime = config.lifetime || 1000;
    particle.age = 0;
    particle.gravity = config.gravity || 0;
    particle.type = config.type || 'circle';
    
    if (config.trail) {
      particle.trail = [];
      particle.trailLength = config.trailLength || 10;
    }
    
    this.activeParticles.push(particle);
  }
  
  /**
   * 更新所有粒子
   */
  update(deltaTime) {
    const gravity = 0.1;
    
    for (let i = this.activeParticles.length - 1; i >= 0; i--) {
      const particle = this.activeParticles[i];
      
      // 更新年龄
      particle.age += deltaTime;
      
      // 检查生命周期
      if (particle.age >= particle.lifetime) {
        this.releaseParticle(particle, i);
        continue;
      }
      
      // 更新速度
      particle.vx *= 0.99; // 阻力
      particle.vy += gravity * (particle.gravity || 1);
      
      // 更新位置
      particle.x += particle.vx;
      particle.y += particle.vy;
      
      // 更新透明度（渐隐）
      const lifeRatio = 1 - (particle.age / particle.lifetime);
      particle.alpha = lifeRatio;
      
      // 更新轨迹
      if (particle.trail && this.enableTrails) {
        particle.trail.unshift({ x: particle.x, y: particle.y });
        if (particle.trail.length > particle.trailLength) {
          particle.trail.pop();
        }
      }
    }
  }
  
  /**
   * 释放粒子回对象池
   */
  releaseParticle(particle, index) {
    particle.active = false;
    this.activeParticles.splice(index, 1);
  }
  
  /**
   * 渲染粒子
   */
  render() {
    if (this.useWebGL) {
      this.renderWebGL();
    } else {
      this.renderCanvas();
    }
  }
  
  /**
   * Canvas 渲染
   */
  renderCanvas() {
    const ctx = this.canvasCtx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    for (const particle of this.activeParticles) {
      ctx.save();
      ctx.globalAlpha = particle.alpha;
      
      // 绘制轨迹
      if (particle.trail && particle.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(particle.trail[0].x, particle.trail[0].y);
        for (let i = 1; i < particle.trail.length; i++) {
          ctx.lineTo(particle.trail[i].x, particle.trail[i].y);
        }
        ctx.strokeStyle = particle.color;
        ctx.lineWidth = particle.size * 0.5;
        ctx.stroke();
      }
      
      // 绘制粒子
      ctx.fillStyle = particle.color;
      
      switch (particle.type) {
        case 'circle':
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          ctx.fill();
          break;
          
        case 'star':
          this.drawStar(ctx, particle.x, particle.y, particle.size);
          break;
          
        case 'spark':
          this.drawSpark(ctx, particle.x, particle.y, particle.size);
          break;
          
        case 'flame':
          this.drawFlame(ctx, particle.x, particle.y, particle.size);
          break;
          
        default:
          ctx.fillRect(
            particle.x - particle.size / 2,
            particle.y - particle.size / 2,
            particle.size,
            particle.size
          );
      }
      
      ctx.restore();
    }
  }
  
  /**
   * 绘制星星形状
   */
  drawStar(ctx, x, y, size) {
    const spikes = 5;
    const outerRadius = size;
    const innerRadius = size / 2;
    
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i * Math.PI) / spikes - Math.PI / 2;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
    ctx.fill();
  }
  
  /**
   * 绘制火花
   */
  drawSpark(ctx, x, y, size) {
    const length = size * 2;
    
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2;
      ctx.moveTo(x, y);
      ctx.lineTo(
        x + Math.cos(angle) * length,
        y + Math.sin(angle) * length
      );
    }
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  
  /**
   * 绘制火焰
   */
  drawFlame(ctx, x, y, size) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y - size, size);
    gradient.addColorStop(0, '#FFEB3B');
    gradient.addColorStop(0.5, '#FF9800');
    gradient.addColorStop(1, 'rgba(255, 152, 0, 0)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(x - size, y + size);
    ctx.quadraticCurveTo(x - size * 0.5, y - size * 2, x, y - size * 1.5);
    ctx.quadraticCurveTo(x + size * 0.5, y - size * 2, x + size, y + size);
    ctx.closePath();
    ctx.fill();
  }
  
  /**
   * 清除所有粒子
   */
  clear() {
    for (const particle of this.activeParticles) {
      particle.active = false;
    }
    this.activeParticles = [];
  }
  
  /**
   * 检测 WebGL 支持
   */
  detectWebGLSupport() {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && 
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }
  
  /**
   * 初始化 WebGL 渲染器
   */
  initWebGLRenderer() {
    // WebGL 初始化代码（高性能模式）
    // 使用 shader 批量渲染粒子
  }
  
  /**
   * 初始化 Canvas 渲染器
   */
  initCanvasRenderer() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'particle-canvas';
    this.canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 9999;
    `;
    document.body.appendChild(this.canvas);
    this.canvasCtx = this.canvas.getContext('2d');
    
    // 调整画布尺寸
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }
  
  /**
   * 调整画布尺寸
   */
  resizeCanvas() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }
}
```

### 3. 性能监控与质量自适应

```javascript
// frontend/game-client/src/utils/PerformanceMonitor.js

export class PerformanceMonitor {
  constructor() {
    this.fpsHistory = [];
    this.maxHistoryLength = 60;
    this.qualityLevel = 'high';
    this.lastFrameTime = performance.now();
    
    this.startMonitoring();
  }
  
  /**
   * 开始性能监控
   */
  startMonitoring() {
    const measureFPS = () => {
      const now = performance.now();
      const delta = now - this.lastFrameTime;
      this.lastFrameTime = now;
      
      const fps = 1000 / delta;
      this.fpsHistory.push(fps);
      
      if (this.fpsHistory.length > this.maxHistoryLength) {
        this.fpsHistory.shift();
      }
      
      // 动态调整质量等级
      this.adjustQualityLevel();
      
      requestAnimationFrame(measureFPS);
    };
    
    requestAnimationFrame(measureFPS);
  }
  
  /**
   * 获取当前 FPS
   */
  getCurrentFPS() {
    if (this.fpsHistory.length === 0) return 60;
    return this.fpsHistory[this.fpsHistory.length - 1];
  }
  
  /**
   * 获取平均 FPS
   */
  getAverageFPS() {
    if (this.fpsHistory.length === 0) return 60;
    const sum = this.fpsHistory.reduce((a, b) => a + b, 0);
    return sum / this.fpsHistory.length;
  }
  
  /**
   * 获取质量等级
   */
  getQualityLevel() {
    return this.qualityLevel;
  }
  
  /**
   * 调整质量等级
   */
  adjustQualityLevel() {
    const avgFPS = this.getAverageFPS();
    
    if (avgFPS >= 55) {
      this.qualityLevel = 'high';
    } else if (avgFPS >= 45) {
      this.qualityLevel = 'medium';
    } else if (avgFPS >= 30) {
      this.qualityLevel = 'low';
    } else {
      this.qualityLevel = 'very_low';
    }
  }
  
  /**
   * 获取设备性能等级
   */
  getDevicePerformanceLevel() {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    let score = 0;
    
    // CPU 核心数评分
    if (cores >= 8) score += 3;
    else if (cores >= 4) score += 2;
    else score += 1;
    
    // 内存评分
    if (memory >= 8) score += 3;
    else if (memory >= 4) score += 2;
    else score += 1;
    
    // 移动设备降权
    if (isMobile) score -= 1;
    
    if (score >= 5) return 'high';
    if (score >= 3) return 'medium';
    return 'low';
  }
}
```

### 4. 辉光效果系统

```javascript
// frontend/game-client/src/effects/GlowEffect.js

export class GlowEffect {
  constructor(options = {}) {
    this.intensity = options.intensity || 0.8;
    this.duration = options.duration || 1000;
    this.colors = options.colors || ['#FFFFFF'];
    this.targetElement = options.target || document.body;
  }
  
  /**
   * 播放辉光效果
   */
  async play() {
    return new Promise((resolve) => {
      const overlay = this.createOverlay();
      this.targetElement.appendChild(overlay);
      
      // 动画序列
      let startTime = null;
      
      const animate = (timestamp) => {
        if (!startTime) startTime = timestamp;
        const progress = timestamp - startTime;
        
        const phase = progress / this.duration;
        
        if (phase < 0.3) {
          // 扩张阶段
          const scale = 1 + (phase / 0.3) * 0.5;
          overlay.style.transform = `scale(${scale})`;
          overlay.style.opacity = phase / 0.3 * this.intensity;
        } else if (phase < 0.7) {
          // 维持阶段
          overlay.style.opacity = this.intensity;
        } else {
          // 收缩阶段
          const fadeProgress = (phase - 0.7) / 0.3;
          overlay.style.opacity = this.intensity * (1 - fadeProgress);
          overlay.style.transform = `scale(${1.5 + fadeProgress * 0.5})`;
        }
        
        if (progress < this.duration) {
          requestAnimationFrame(animate);
        } else {
          overlay.remove();
          resolve();
        }
      };
      
      requestAnimationFrame(animate);
    });
  }
  
  /**
   * 创建辉光覆盖层
   */
  createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'glow-effect-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      width: 200px;
      height: 200px;
      transform: translate(-50%, -50%) scale(1);
      border-radius: 50%;
      background: radial-gradient(circle, 
        ${this.colors[0]} 0%, 
        ${this.colors[1] || this.colors[0]} 50%, 
        transparent 70%
      );
      pointer-events: none;
      z-index: 9998;
      mix-blend-mode: screen;
      filter: blur(20px);
    `;
    
    return overlay;
  }
}
```

### 5. 屏幕震动效果

```javascript
// frontend/game-client/src/effects/ScreenShake.js

export class ScreenShake {
  constructor(options = {}) {
    this.intensity = options.intensity || 5;
    this.duration = options.duration || 300;
    this.container = options.container || document.body;
  }
  
  /**
   * 播放震动效果
   */
  async play() {
    return new Promise((resolve) => {
      const startTime = performance.now();
      const originalTransform = this.container.style.transform;
      
      const shake = (timestamp) => {
        const elapsed = timestamp - startTime;
        
        if (elapsed < this.duration) {
          const progress = elapsed / this.duration;
          const decay = 1 - progress;
          const currentIntensity = this.intensity * decay;
          
          const x = (Math.random() - 0.5) * currentIntensity * 2;
          const y = (Math.random() - 0.5) * currentIntensity * 2;
          const rotation = (Math.random() - 0.5) * currentIntensity * 0.5;
          
          this.container.style.transform = 
            `translate(${x}px, ${y}px) rotate(${rotation}deg) ${originalTransform}`;
          
          requestAnimationFrame(shake);
        } else {
          this.container.style.transform = originalTransform;
          resolve();
        }
      };
      
      requestAnimationFrame(shake);
    });
  }
}
```

### 6. 集成到捕捉引擎

```javascript
// frontend/game-client/src/game/CatchEngine.js (扩展)

import { CatchAnimationEngine } from '../effects/CatchAnimationEngine.js';

export class CatchEngine {
  constructor() {
    this.animationEngine = new CatchAnimationEngine();
    // ... 其他初始化
  }
  
  /**
   * 处理捕捉结果
   */
  async handleCatchResult(result, pokemon) {
    if (result.success) {
      // 播放成功动画
      await this.animationEngine.playCatchAnimation(pokemon, {
        position: result.catchPosition
      });
      
      // 显示成功 UI
      this.showCatchSuccessUI(pokemon);
    } else {
      // 播放失败动画（精灵逃跑）
      await this.playEscapeAnimation(pokemon);
    }
  }
}
```

## 验收标准

- [ ] 捕捉动画根据精灵稀有度呈现差异化效果（至少 6 种稀有度配置）
- [ ] 捕捉动画根据精灵属性类型呈现差异化粒子效果（至少 9 种属性效果）
- [ ] 粒子系统支持 Canvas 和 WebGL 双模式渲染
- [ ] 性能监控系统实时检测帧率并自动调整特效质量
- [ ] 低端设备（<30 FPS）特效质量自动降级，保证流畅度
- [ ] 动画、音效、触觉反馈精确同步（延迟 < 50ms）
- [ ] 传奇/神话级精灵展示特殊效果（彩虹光环/宇宙爆炸）
- [ ] 粒子对象池预分配，避免运行时内存分配
- [ ] 所有动画组件包含单元测试覆盖
- [ ] 前端性能监控集成到 Sentry/LogRocket

## 影响范围

- `game-client` - 游戏客户端主入口
- `frontend/game-client/src/effects/` - 新增特效模块
- `frontend/game-client/src/game/CatchEngine.js` - 捕捉引擎集成
- `frontend/game-client/src/utils/PerformanceMonitor.js` - 性能监控工具
- `frontend/game-client/src/audio/AudioManager.js` - 音效同步集成

## 参考

- [Canvas 粒子系统最佳实践](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial)
- [WebGL 粒子渲染优化](https://webglfundamentals.org/)
- [Web Vitals 性能指标](https://web.dev/vitals/)
- [Pokemon GO 捕捉动画设计分析](https://pokemongolive.com/)
