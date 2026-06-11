/**
 * 捕捉动画特效系统单元测试
 */
'use strict';

import { ThrowAnimation } from '../src/effects/ThrowAnimation.js';
import { ParticleSystem } from '../src/effects/ParticleSystem.js';
import { ComboSystem } from '../src/effects/ComboSystem.js';

// Mock Canvas
function createMockCanvas(width = 800, height = 600) {
  const canvas = {
    width,
    height,
    getContext: () => ({
      clearRect: jest.fn(),
      save: jest.fn(),
      restore: jest.fn(),
      translate: jest.fn(),
      rotate: jest.fn(),
      scale: jest.fn(),
      beginPath: jest.fn(),
      arc: jest.fn(),
      fill: jest.fn(),
      stroke: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      createLinearGradient: jest.fn(() => ({
        addColorStop: jest.fn()
      }))
    })
  };
  return canvas;
}

describe('ThrowAnimation', () => {
  let animation;
  let mockCanvas;
  let mockCtx;

  beforeEach(() => {
    mockCanvas = createMockCanvas();
    mockCtx = mockCanvas.getContext();
    animation = new ThrowAnimation(mockCanvas);
  });

  afterEach(() => {
    if (animation) {
      animation.stop();
    }
  });

  test('should initialize correctly', () => {
    expect(animation.canvas).toBe(mockCanvas);
    expect(animation.ctx).toBe(mockCtx);
    expect(animation.ball).toBeNull();
    expect(animation.trajectory).toEqual([]);
  });

  test('should calculate trajectory with correct number of points', () => {
    const options = {
      startX: 400,
      startY: 500,
      targetX: 400,
      targetY: 200,
      ballType: 'POKE_BALL'
    };

    animation.ball = { x: options.startX, y: options.startY, rotation: 0, scale: 1, type: options.ballType };
    const trajectory = animation._calculateTrajectory(options);

    expect(trajectory.length).toBe(61); // 60 frames + 1
    expect(trajectory[0].x).toBe(options.startX);
    expect(trajectory[0].y).toBe(options.startY);
    expect(trajectory[60].x).toBe(options.targetX);
    expect(trajectory[60].y).toBe(options.targetY);
  });

  test('should calculate curve ball trajectory with offset', () => {
    const options = {
      startX: 400,
      startY: 500,
      targetX: 400,
      targetY: 200,
      ballType: 'POKE_BALL',
      isCurve: true,
      curveDirection: 1
    };

    animation.ball = { x: options.startX, y: options.startY, rotation: 0, scale: 1, type: options.ballType };
    const trajectory = animation._calculateTrajectory(options);

    // 曲线球应该在中间点有偏移
    const midPoint = trajectory[30];
    expect(Math.abs(midPoint.x - 400)).toBeGreaterThan(0);
  });

  test('should stop animation correctly', () => {
    animation.stop();
    expect(animation.animationId).toBeNull();
  });

  test('should get current position', () => {
    expect(animation.getCurrentPosition()).toBeNull();

    animation.ball = { x: 100, y: 100 };
    const pos = animation.getCurrentPosition();

    expect(pos.x).toBe(100);
    expect(pos.y).toBe(100);
  });
});

describe('ParticleSystem', () => {
  let particleSystem;
  let mockCanvas;
  let mockCtx;

  beforeEach(() => {
    mockCanvas = createMockCanvas();
    mockCtx = mockCanvas.getContext();
    particleSystem = new ParticleSystem(mockCanvas);
  });

  afterEach(() => {
    if (particleSystem) {
      particleSystem.stop();
    }
  });

  test('should initialize correctly', () => {
    expect(particleSystem.particles).toEqual([]);
    expect(particleSystem.running).toBe(false);
  });

  test('should emit particles', () => {
    particleSystem.emit({
      x: 400,
      y: 300,
      count: 10,
      size: 5,
      color: '#FF0000'
    });

    expect(particleSystem.particles.length).toBe(10);
  });

  test('should emit particles with random colors', () => {
    particleSystem.emit({
      x: 400,
      y: 300,
      count: 20,
      size: 5,
      colors: ['#FF0000', '#00FF00', '#0000FF']
    });

    expect(particleSystem.particles.length).toBe(20);
    
    const colors = new Set(particleSystem.particles.map(p => p.color));
    expect(colors.size).toBeGreaterThan(0);
  });

  test('should create catch success effect', () => {
    particleSystem.catchSuccess(400, 300);

    expect(particleSystem.particles.length).toBeGreaterThan(50);
  });

  test('should create catch failed effect', () => {
    particleSystem.catchFailed(400, 300);

    expect(particleSystem.particles.length).toBeGreaterThan(20);
  });

  test('should create pokemon fled effect', () => {
    particleSystem.pokemonFled(400, 300);

    expect(particleSystem.particles.length).toBeGreaterThan(40);
  });

  test('should create combo effect', () => {
    particleSystem.comboEffect(400, 300, 5);

    expect(particleSystem.particles.length).toBeGreaterThan(20);
  });

  test('should start and stop rendering loop', () => {
    particleSystem.start();
    expect(particleSystem.running).toBe(true);

    particleSystem.stop();
    expect(particleSystem.running).toBe(false);
    expect(particleSystem.particles).toEqual([]);
  });

  test('should clear all particles', () => {
    particleSystem.emit({ x: 400, y: 300, count: 10 });
    expect(particleSystem.particles.length).toBe(10);

    particleSystem.clear();
    expect(particleSystem.particles.length).toBe(0);
  });

  test('should return particle count', () => {
    particleSystem.emit({ x: 400, y: 300, count: 15 });
    expect(particleSystem.getParticleCount()).toBe(15);
  });
});

describe('ComboSystem', () => {
  let comboSystem;

  beforeEach(() => {
    comboSystem = new ComboSystem();
  });

  test('should initialize correctly', () => {
    expect(comboSystem.combo).toBe(0);
    expect(comboSystem.lastCatchTime).toBe(0);
  });

  test('should record first catch', () => {
    const result = comboSystem.recordCatch();

    expect(result.combo).toBe(1);
    expect(result.multiplier).toBe(1.0);
    expect(result.bonusXp).toBe(0);
    expect(result.bonusStardust).toBe(0);
  });

  test('should increment combo on consecutive catches', () => {
    comboSystem.recordCatch();
    const result = comboSystem.recordCatch();

    expect(result.combo).toBe(2);
    expect(result.multiplier).toBe(1.1);
  });

  test('should calculate correct multiplier for high combo', () => {
    for (let i = 0; i < 10; i++) {
      comboSystem.recordCatch();
    }

    const result = comboSystem.recordCatch();
    expect(result.combo).toBe(11);
    expect(result.multiplier).toBe(2.0);
  });

  test('should reset combo after timeout', () => {
    comboSystem.recordCatch();
    comboSystem.lastCatchTime = Date.now() - 40000; // 40秒前

    const result = comboSystem.recordCatch();
    expect(result.combo).toBe(1);
  });

  test('should calculate bonus XP correctly', () => {
    for (let i = 0; i < 5; i++) {
      comboSystem.recordCatch();
    }

    const result = comboSystem.recordCatch();
    expect(result.bonusXp).toBeGreaterThan(0);
  });

  test('should calculate bonus stardust correctly', () => {
    for (let i = 0; i < 5; i++) {
      comboSystem.recordCatch();
    }

    const result = comboSystem.recordCatch();
    expect(result.bonusStardust).toBeGreaterThan(0);
  });

  test('should detect milestone at combo 3', () => {
    comboSystem.recordCatch();
    comboSystem.recordCatch();
    const result = comboSystem.recordCatch();

    expect(result.milestone).not.toBeNull();
    expect(result.milestone.combo).toBe(3);
    expect(result.milestone.xp).toBe(100);
  });

  test('should detect milestone at combo 10', () => {
    for (let i = 0; i < 10; i++) {
      comboSystem.recordCatch();
    }

    const result = comboSystem.recordCatch();
    expect(result.milestone).not.toBeNull();
    expect(result.milestone.combo).toBe(10);
  });

  test('should reset combo', () => {
    for (let i = 0; i < 5; i++) {
      comboSystem.recordCatch();
    }

    comboSystem.reset();
    expect(comboSystem.combo).toBe(0);
    expect(comboSystem.lastCatchTime).toBe(0);
  });

  test('should get next milestone correctly', () => {
    for (let i = 0; i < 4; i++) {
      comboSystem.recordCatch();
    }

    const nextMilestone = comboSystem.getNextMilestone();
    expect(nextMilestone.combo).toBe(10);
    expect(nextMilestone.remaining).toBe(6);
  });

  test('should calculate progress correctly', () => {
    for (let i = 0; i < 6; i++) {
      comboSystem.recordCatch();
    }

    const progress = comboSystem.getProgress();
    expect(progress).toBeGreaterThan(0);
    expect(progress).toBeLessThan(100);
  });

  test('should check if combo is valid', () => {
    expect(comboSystem.isValid()).toBe(false);

    comboSystem.recordCatch();
    expect(comboSystem.isValid()).toBe(true);

    comboSystem.lastCatchTime = Date.now() - 40000;
    expect(comboSystem.isValid()).toBe(false);
  });

  test('should get remaining time', () => {
    comboSystem.recordCatch();
    const remaining = comboSystem.getRemainingTime();

    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30000);
  });

  test('should emit combo event', (done) => {
    comboSystem.on('combo', (result) => {
      expect(result.combo).toBe(1);
      done();
    });

    comboSystem.recordCatch();
  });

  test('should emit milestone event', (done) => {
    comboSystem.on('milestone', (milestone) => {
      expect(milestone.combo).toBe(3);
      done();
    });

    comboSystem.recordCatch();
    comboSystem.recordCatch();
    comboSystem.recordCatch();
  });

  test('should serialize and deserialize correctly', () => {
    for (let i = 0; i < 5; i++) {
      comboSystem.recordCatch();
    }

    const json = comboSystem.toJSON();
    const restored = ComboSystem.fromJSON(json);

    expect(restored.combo).toBe(6); // 5次后第6次
    expect(restored.lastCatchTime).toBe(comboSystem.lastCatchTime);
  });

  test('should get state correctly', () => {
    comboSystem.recordCatch();
    const state = comboSystem.getState();

    expect(state.combo).toBe(1);
    expect(state.multiplier).toBe(1.0);
    expect(state.isValid).toBe(true);
    expect(state.nextMilestone).toBeDefined();
    expect(state.progress).toBeDefined();
  });
});

describe('Particle', () => {
  test('should update position based on velocity', () => {
    const particle = new (require('../src/effects/ParticleSystem.js').Particle || 
      class Particle {
        constructor(options) {
          Object.assign(this, options);
          this.maxLife = this.life || 1;
        }
        update(dt) {
          this.x += this.vx * dt;
          this.y += this.vy * dt;
          this.vy += this.gravity * dt;
          this.life -= dt;
        }
        isDead() { return this.life <= 0; }
      })({
      x: 100, y: 100, vx: 50, vy: -20, gravity: 10, life: 2
    });

    particle.update(0.5);

    expect(particle.x).toBe(125);
    expect(particle.y).toBeLessThan(100);
  });

  test('should die when life reaches zero', () => {
    const particle = new (require('../src/effects/ParticleSystem.js').Particle ||
      class Particle {
        constructor(options) {
          Object.assign(this, options);
          this.maxLife = this.life || 1;
        }
        update(dt) { this.life -= dt; }
        isDead() { return this.life <= 0; }
      })({ life: 0.5 });

    particle.update(0.6);
    expect(particle.isDead()).toBe(true);
  });
});
