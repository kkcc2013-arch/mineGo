/**
 * Pokemon 3D Viewer - Three.js 集成
 * 支持 360° 旋转、动作、稀有精灵特效
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Pokemon3DViewer {
  constructor(container, options = {}) {
    this._container = container;
    this._options = options;
    
    // Three.js 核心组件
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._controls = null;
    
    // 模型和动画
    this._model = null;
    this._mixer = null;
    this._actions = {};
    this._currentAction = 'idle';
    
    // 特效
    this._particles = null;
    this._glowMesh = null;
    
    // 状态
    this._isInitialized = false;
    this._isDowngraded = false;
    this._animationId = null;
    
    // 初始化
    this._init();
  }

  /**
   * 初始化 Three.js 场景
   */
  _init() {
    try {
      // 检测 WebGL 支持
      if (!this._checkWebGL()) {
        this.downgradeTo2D();
        return;
      }

      // 创建场景
      this._scene = new THREE.Scene();
      this._scene.background = new THREE.Color(0x0d0f14);

      // 创建相机
      const aspect = this._container.clientWidth / this._container.clientHeight;
      this._camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
      this._camera.position.set(0, 2, 6);

      // 创建渲染器
      this._renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
      });
      this._renderer.setSize(this._container.clientWidth, this._container.clientHeight);
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this._renderer.shadowMap.enabled = true;
      this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this._container.appendChild(this._renderer.domElement);

      // 创建控制器
      this._controls = new OrbitControls(this._camera, this._renderer.domElement);
      this._controls.enableDamping = true;
      this._controls.dampingFactor = 0.05;
      this._controls.minDistance = 2;
      this._controls.maxDistance = 10;
      this._controls.maxPolarAngle = Math.PI / 1.5;
      this._controls.minPolarAngle = Math.PI / 6;

      // 添加灯光
      this._setupLights();

      // 添加地面网格
      this._addGroundGrid();

      // 监听窗口大小变化
      window.addEventListener('resize', () => this._onResize());

      this._isInitialized = true;
      
      // 开始渲染循环
      this._animate();
    } catch (error) {
      console.error('[Pokemon3DViewer] Initialization failed:', error);
      this.downgradeTo2D();
    }
  }

  /**
   * 检查 WebGL 支持
   */
  _checkWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      
      if (!gl) {
        console.warn('[Pokemon3DViewer] WebGL not supported');
        return false;
      }

      // 检测低端 GPU
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        
        // 低端 Intel 集成显卡降级
        if (renderer.includes('Intel') && !renderer.includes('Iris') && !renderer.includes('Arc')) {
          console.warn('[Pokemon3DViewer] Low-end GPU detected:', renderer);
          if (this._options.autoDowngrade !== false) {
            return false;
          }
        }
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 设置灯光
   */
  _setupLights() {
    // 环境光
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this._scene.add(ambientLight);

    // 主方向光
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
    mainLight.position.set(5, 10, 5);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 1024;
    mainLight.shadow.mapSize.height = 1024;
    this._scene.add(mainLight);

    // 补光
    const fillLight = new THREE.DirectionalLight(0x4488ff, 0.3);
    fillLight.position.set(-5, 5, -5);
    this._scene.add(fillLight);

    // 背光
    const backLight = new THREE.DirectionalLight(0xffffff, 0.2);
    backLight.position.set(0, 5, -10);
    this._scene.add(backLight);
  }

  /**
   * 添加地面网格
   */
  _addGroundGrid() {
    // 地面圆形平台
    const geometry = new THREE.CircleGeometry(3, 64);
    const material = new THREE.MeshStandardMaterial({
      color: 0x1a1e28,
      metalness: 0.3,
      roughness: 0.8,
      transparent: true,
      opacity: 0.6
    });
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this._scene.add(ground);

    // 网格线
    const gridHelper = new THREE.GridHelper(6, 12, 0x252938, 0x1a1e28);
    gridHelper.position.y = -0.49;
    this._scene.add(gridHelper);
  }

  /**
   * 加载精灵 3D 模型
   */
  async loadModel(speciesId, variant = 'normal') {
    if (!this._isInitialized) {
      throw new Error('Viewer not initialized');
    }

    try {
      // 移除旧模型
      if (this._model) {
        this._scene.remove(this._model);
        this._model = null;
      }

      // 清理动画
      if (this._mixer) {
        this._mixer.stopAllAction();
        this._mixer = null;
      }
      this._actions = {};

      // 加载 GLTF 模型
      const loader = new GLTFLoader();
      const modelPath = `/assets/3d/pokemon/${speciesId}.gltf`;
      
      const gltf = await new Promise((resolve, reject) => {
        loader.load(
          modelPath,
          (gltf) => resolve(gltf),
          (progress) => {
            const percent = (progress.loaded / progress.total * 100).toFixed(0);
            console.log(`[Pokemon3DViewer] Loading: ${percent}%`);
          },
          (error) => {
            console.warn('[Pokemon3DViewer] Model load failed:', error);
            reject(error);
          }
        );
      });

      this._model = gltf.scene;

      // 设置模型属性
      this._model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          
          // 根据变体调整材质
          if (variant === 'shiny') {
            if (child.material) {
              child.material.emissive = new THREE.Color(0x222222);
              child.material.emissiveIntensity = 0.3;
            }
          }
        }
      });

      // 计算模型边界盒并居中
      const box = new THREE.Box3().setFromObject(this._model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      
      this._model.position.sub(center);
      this._model.position.y += size.y / 2;

      // 自动调整相机距离
      const maxDim = Math.max(size.x, size.y, size.z);
      this._camera.position.z = maxDim * 2.5;
      this._controls.update();

      // 设置动画
      if (gltf.animations && gltf.animations.length > 0) {
        this._mixer = new THREE.AnimationMixer(this._model);
        
        gltf.animations.forEach((clip) => {
          const action = this._mixer.clipAction(clip);
          const actionName = this._parseActionName(clip.name);
          this._actions[actionName] = action;
        });

        // 播放默认动作
        this.playAction('idle');
      } else {
        // 如果没有动画，创建简单的浮动动画
        this._createIdleAnimation();
      }

      this._scene.add(this._model);
      
      console.log('[Pokemon3DViewer] Model loaded successfully:', speciesId);
      return true;
    } catch (error) {
      console.error('[Pokemon3DViewer] Failed to load model:', error);
      
      // 如果加载失败，创建占位几何体
      if (this._options.fallbackGeometry !== false) {
        await this._createFallbackGeometry(speciesId);
        return true;
      }
      
      throw error;
    }
  }

  /**
   * 解析动画名称
   */
  _parseActionName(name) {
    const nameMap = {
      'idle': 'idle',
      'stand': 'idle',
      'waiting': 'idle',
      'attack': 'attack',
      'attacking': 'attack',
      'hit': 'hit',
      'hurt': 'hit',
      'damage': 'hit',
      'celebrate': 'celebrate',
      'victory': 'celebrate',
      'win': 'celebrate'
    };

    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(nameMap)) {
      if (lowerName.includes(key)) {
        return value;
      }
    }
    
    return name;
  }

  /**
   * 创建简单浮动动画
   */
  _createIdleAnimation() {
    // 通过位置动画实现浮动效果
    const originalY = this._model.position.y;
    let time = 0;
    
    const animate = () => {
      if (!this._model) return;
      time += 0.02;
      this._model.position.y = originalY + Math.sin(time) * 0.05;
    };
    
    this._idleFloatAnimation = animate;
  }

  /**
   * 创建占位几何体（模型加载失败时）
   */
  async _createFallbackGeometry(speciesId) {
    // 创建一个简单的球形代表精灵
    const geometry = new THREE.SphereGeometry(1, 32, 32);
    
    // 根据 speciesId 生成颜色
    const hue = (speciesId % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 0.7, 0.5);
    
    const material = new THREE.MeshStandardMaterial({
      color: color,
      metalness: 0.3,
      roughness: 0.7,
      emissive: color,
      emissiveIntensity: 0.2
    });

    this._model = new THREE.Mesh(geometry, material);
    this._model.castShadow = true;
    this._model.receiveShadow = true;
    
    this._scene.add(this._model);
    
    // 创建浮动动画
    this._createIdleAnimation();
    
    console.log('[Pokemon3DViewer] Created fallback geometry for species:', speciesId);
  }

  /**
   * 播放动作
   */
  playAction(actionName) {
    if (!this._mixer || !this._actions[actionName]) {
      console.warn('[Pokemon3DViewer] Action not found:', actionName);
      return;
    }

    const action = this._actions[actionName];
    
    // 如果是循环动作，直接播放
    if (actionName === 'idle') {
      action.reset().setLoop(THREE.LoopRepeat, Infinity).play();
    } else {
      // 单次动作，播放后回到 idle
      action.reset().setLoop(THREE.LoopOnce, 1).play();
      
      action.getMixer().addEventListener('finished', () => {
        this.playAction('idle');
      });
    }

    this._currentAction = actionName;
  }

  /**
   * 设置稀有特效
   */
  setRarityEffect(rarity) {
    // 移除现有特效
    this._clearEffects();

    if (rarity < 4) return;

    // 稀有度配置
    const rarityConfigs = {
      4: {
        glowColor: 0x9932CC,
        glowIntensity: 0.8,
        particleColor: 0xDDA0DD,
        particleCount: 50
      },
      5: {
        glowColor: 0xFFD700,
        glowIntensity: 1.2,
        particleColor: 0xFFFF00,
        particleCount: 100,
        rainbow: true
      }
    };

    const config = rarityConfigs[rarity];
    if (!config) return;

    // 添加光晕
    this._addGlowEffect(config.glowColor, config.glowIntensity);

    // 添加粒子
    this._addParticleEffect(config.particleColor, config.particleCount);

    // 彩虹效果（仅 5 星）
    if (config.rainbow) {
      this._addRainbowEffect();
    }
  }

  /**
   * 添加光晕效果
   */
  _addGlowEffect(color, intensity) {
    if (!this._model) return;

    // 创建光晕材质
    const glowGeometry = new THREE.SphereGeometry(1.5, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.3,
      side: THREE.BackSide
    });

    this._glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    this._glowMesh.position.copy(this._model.position);
    this._scene.add(this._glowMesh);

    // 光晕脉冲动画
    let time = 0;
    this._glowAnimation = () => {
      time += 0.05;
      const scale = 1.5 + Math.sin(time) * 0.2;
      this._glowMesh.scale.setScalar(scale);
      this._glowMesh.material.opacity = 0.3 + Math.sin(time) * 0.1;
    };
  }

  /**
   * 添加粒子效果
   */
  _addParticleEffect(color, count) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const velocities = [];

    for (let i = 0; i < count; i++) {
      // 球形分布
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 1.5 + Math.random() * 1;

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);

      velocities.push({
        x: (Math.random() - 0.5) * 0.02,
        y: Math.random() * 0.02,
        z: (Math.random() - 0.5) * 0.02
      });
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: color,
      size: 0.08,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });

    this._particles = new THREE.Points(geometry, material);
    this._particles.userData.velocities = velocities;
    
    if (this._model) {
      this._particles.position.copy(this._model.position);
    }
    
    this._scene.add(this._particles);
  }

  /**
   * 添加彩虹效果
   */
  _addRainbowEffect() {
    let hue = 0;
    this._rainbowAnimation = () => {
      hue = (hue + 0.01) % 1;
      if (this._glowMesh) {
        this._glowMesh.material.color.setHSL(hue, 1, 0.5);
      }
      if (this._particles) {
        this._particles.material.color.setHSL((hue + 0.5) % 1, 1, 0.5);
      }
    };
  }

  /**
   * 清除特效
   */
  _clearEffects() {
    if (this._particles) {
      this._scene.remove(this._particles);
      this._particles.geometry.dispose();
      this._particles.material.dispose();
      this._particles = null;
    }

    if (this._glowMesh) {
      this._scene.remove(this._glowMesh);
      this._glowMesh.geometry.dispose();
      this._glowMesh.material.dispose();
      this._glowMesh = null;
    }

    this._glowAnimation = null;
    this._rainbowAnimation = null;
  }

  /**
   * 设置交互
   */
  setInteractive(enabled) {
    if (this._controls) {
      this._controls.enabled = enabled;
    }
  }

  /**
   * 降级到 2D 模式
   */
  downgradeTo2D() {
    this._isDowngraded = true;
    
    // 清理 3D 资源
    this.dispose();
    
    // 触发降级事件
    this._container.dispatchEvent(new CustomEvent('downgrade', { 
      detail: { reason: 'webgl-unsupported' } 
    }));
    
    console.log('[Pokemon3DViewer] Downgraded to 2D mode');
  }

  /**
   * 窗口大小变化处理
   */
  _onResize() {
    if (!this._isInitialized || !this._renderer) return;

    const width = this._container.clientWidth;
    const height = this._container.clientHeight;

    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(width, height);
  }

  /**
   * 动画循环
   */
  _animate() {
    if (!this._isInitialized) return;

    this._animationId = requestAnimationFrame(() => this._animate());

    // 更新控制器
    if (this._controls) {
      this._controls.update();
    }

    // 更新动画混合器
    if (this._mixer) {
      this._mixer.update(0.016);
    }

    // 浮动动画
    if (this._idleFloatAnimation) {
      this._idleFloatAnimation();
    }

    // 特效动画
    if (this._glowAnimation) {
      this._glowAnimation();
    }

    if (this._rainbowAnimation) {
      this._rainbowAnimation();
    }

    // 粒子动画
    if (this._particles) {
      const positions = this._particles.geometry.attributes.position.array;
      const velocities = this._particles.userData.velocities;
      
      for (let i = 0; i < velocities.length; i++) {
        positions[i * 3] += velocities[i].x;
        positions[i * 3 + 1] += velocities[i].y;
        positions[i * 3 + 2] += velocities[i].z;

        // 重置超出范围的粒子
        const distance = Math.sqrt(
          positions[i * 3] ** 2 +
          positions[i * 3 + 1] ** 2 +
          positions[i * 3 + 2] ** 2
        );

        if (distance > 3) {
          positions[i * 3] = 0;
          positions[i * 3 + 1] = 0;
          positions[i * 3 + 2] = 0;
        }
      }

      this._particles.geometry.attributes.position.needsUpdate = true;
    }

    // 渲染场景
    if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  /**
   * 销毁查看器
   */
  dispose() {
    // 停止动画循环
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }

    // 清理特效
    this._clearEffects();

    // 清理模型
    if (this._model) {
      this._scene.remove(this._model);
      this._model.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this._model = null;
    }

    // 清理动画混合器
    if (this._mixer) {
      this._mixer.stopAllAction();
      this._mixer = null;
    }

    // 清理控制器
    if (this._controls) {
      this._controls.dispose();
      this._controls = null;
    }

    // 清理渲染器
    if (this._renderer) {
      this._renderer.dispose();
      if (this._renderer.domElement && this._renderer.domElement.parentNode) {
        this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
      }
      this._renderer = null;
    }

    // 清理场景和相机
    this._scene = null;
    this._camera = null;

    this._isInitialized = false;
    
    console.log('[Pokemon3DViewer] Disposed');
  }

  /**
   * 获取性能信息
   */
  getPerformanceInfo() {
    if (!this._renderer) return null;

    const info = this._renderer.info;
    return {
      triangles: info.render.triangles,
      drawCalls: info.render.calls,
      textures: info.memory.textures,
      geometries: info.memory.geometries
    };
  }
}

export default Pokemon3DViewer;
