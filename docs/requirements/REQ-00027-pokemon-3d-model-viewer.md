# REQ-00027：精灵详情页 3D 模型展示与交互

- **编号**：REQ-00027
- **类别**：前端体验
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend/3d、pokemon-service
- **创建时间**：2026-06-05 19:00
- **依赖需求**：无

## 1. 背景与问题

当前游戏客户端精灵详情页仅显示静态图片和文字信息，缺少沉浸式体验：

1. **视觉单调**：精灵以 2D 静态图片展示，无法展现精灵的动态特征
2. **交互缺失**：玩家无法旋转查看精灵、点击触发动作
3. **差异化不足**：所有精灵展示方式相同，稀有精灵没有特殊展示效果
4. **与原作差距**：原作游戏支持 3D 模型旋转、动作预览，体验更丰富

## 2. 目标

为精灵详情页添加 3D 模型展示和交互能力：

- 支持 360° 旋转查看精灵
- 支持触发精灵动作（待机、攻击、受击、庆祝）
- 稀有精灵添加特殊光效和粒子效果
- 低端设备自动降级到 2D 模式

## 3. 范围

**包含：**
- Three.js 3D 渲染引擎集成
- 精灵 3D 模型加载器（GLTF 格式）
- 触摸/鼠标交互控制（旋转、缩放）
- 精灵动作系统（4 种基础动作）
- 稀有精灵特效（光晕、粒子）
- 性能降级策略

**不包含：**
- 3D 模型制作（使用现有开源模型或占位几何体）
- AR 模式（属于单独需求）
- 精灵对战动画（属于 gym-service）

## 4. 详细需求

### 4.1 3D 渲染引擎集成

```javascript
// frontend/game-client/src/3d/Pokemon3DViewer.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Pokemon3DViewer {
  constructor(container, options = {}) {
    this._container = container;
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._mixer = null; // AnimationMixer
    this._model = null;
    this._actions = {};
    this._currentAction = 'idle';
  }

  // 加载精灵 3D 模型
  async loadModel(speciesId, variant = 'normal');

  // 播放动作
  playAction(actionName); // idle, attack, hit, celebrate

  // 设置稀有特效
  setRarityEffect(rarity); // 1-5 星

  // 启用/禁用交互
  setInteractive(enabled);

  // 性能降级
  downgradeTo2D();

  // 销毁
  dispose();
}
```

### 4.2 精灵动作系统

| 动作名 | 触发条件 | 循环 | 说明 |
|--------|----------|------|------|
| idle | 默认 | 是 | 待机呼吸动画 |
| attack | 点击攻击按钮 | 否 | 攻击动作，结束后回到 idle |
| hit | 受到伤害 | 否 | 受击反馈 |
| celebrate | 捕捉成功/升级 | 否 | 庆祝动作 |

### 4.3 稀有精灵特效

```javascript
// 稀有度 4-5 星精灵特效
const rarityEffects = {
  4: {
    glow: { color: 0x9932CC, intensity: 0.8 }, // 紫色光晕
    particles: { count: 50, color: 0xDDA0DD }   // 淡紫色粒子
  },
  5: {
    glow: { color: 0xFFD700, intensity: 1.2 }, // 金色光晕
    particles: { count: 100, color: 0xFFFF00 }, // 金色粒子
    rainbow: true // 彩虹渐变
  }
};
```

### 4.4 性能降级策略

```javascript
// 检测设备性能
function detectPerformance() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  
  if (!gl) return '2d'; // 不支持 WebGL
  
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
  
  // 检测低端 GPU
  if (renderer.includes('Intel') && !renderer.includes('Iris')) {
    return '2d-fallback';
  }
  
  return '3d';
}
```

### 4.5 3D 模型资源

- 模型格式：GLTF 2.0
- 模型路径：`/assets/3d/pokemon/{speciesId}.gltf`
- 模型大小：每个 < 500KB（压缩后）
- 降级图片：`/assets/images/pokemon/{speciesId}.png`

### 4.6 UI 集成

```html
<!-- 精灵详情页 3D 展示区域 -->
<div class="pokemon-3d-viewer" id="viewer-container">
  <!-- Three.js 渲染到这里 -->
</div>
<div class="viewer-controls">
  <button class="action-btn" data-action="attack">⚔️ 攻击</button>
  <button class="action-btn" data-action="celebrate">🎉 庆祝</button>
  <button class="toggle-2d">切换 2D</button>
</div>
```

## 5. 验收标准（可测试）

- [ ] Three.js 成功集成，精灵详情页显示 3D 模型
- [ ] 支持触摸/鼠标拖拽旋转精灵（360°）
- [ ] 支持双指缩放/滚轮缩放
- [ ] 点击动作按钮触发对应动画（idle/attack/hit/celebrate）
- [ ] 稀有精灵（4-5星）显示光晕和粒子特效
- [ ] 低端设备自动降级到 2D 图片模式
- [ ] 手动切换 2D/3D 模式功能正常
- [ ] 模型加载失败时降级到 2D 图片
- [ ] 内存占用 < 50MB（单个模型）
- [ ] 帧率 >= 30 FPS（中端设备）

## 6. 工作量估算

**M (中等)**

- Three.js 集成和基础渲染：1 天
- 交互控制和动作系统：1 天
- 稀有特效系统：0.5 天
- 性能降级策略：0.5 天
- 测试和优化：1 天

## 7. 优先级理由

**P2** - 属于体验增强功能，不影响核心玩法。3D 展示能提升游戏沉浸感和差异化，但不是生产可用的必要条件。可在核心功能稳定后逐步完善。
