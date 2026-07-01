# REQ-00401: 精灵 AR 捕捉模式增强系统

## 元信息
| 字段 | 值 |
|------|------|
| 编号 | REQ-00401 |
| 标题 | 精灵 AR 捕捉模式增强系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、gateway、catch-service、location-service、backend/shared |
| 创建时间 | 2026-07-01 00:00 UTC |

## 需求描述

为精灵捕捉场景提供增强现实（AR）模式，让玩家能够通过手机摄像头在真实环境中看到精灵，提升沉浸感和游戏体验。

### 核心功能
1. **AR 场景渲染引擎** - 将精灵 3D 模型实时渲染到摄像头画面中
2. **平面检测与精灵放置** - 自动检测水平/垂直平面，智能放置精灵
3. **光照匹配系统** - 根据环境光调整精灵渲染效果
4. **手势交互增强** - 支持捏合、旋转、拖拽等手势操作
5. **AR 截图与分享** - 捕捉 AR 画面并分享到社交平台
6. **AR 模式降级策略** - 设备不支持时自动切换到普通模式

### 技术目标
- AR 模式帧率 ≥ 30 FPS（中端设备）
- 平面检测延迟 < 500ms
- 精灵渲染延迟 < 100ms
- 内存占用增量 < 150MB
- 兼容 iOS 12+ / Android 8+

## 技术方案

### 1. AR 场景渲染引擎

```javascript
// frontend/game-client/src/ar/ArRenderer.js
import * as THREE from 'three';
import { ARjs } from 'ar.js';

class ArRenderer {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.arToolkitSource = null;
    this.arToolkitContext = null;
    this.pokemonMeshes = new Map();
    this.isEnabled = false;
    this.frameRate = 0;
    this.lastFrameTime = 0;
  }

  async initialize(canvas, options = {}) {
    // 初始化 Three.js 场景
    this.scene = new THREE.Scene();
    
    // 创建 AR 相机
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.01,
      1000
    );
    
    // WebGL 渲染器配置（启用 alpha 用于 AR 叠加）
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    
    // 初始化 AR.js
    await this.initArToolkit(options);
    
    // 设置环境光
    this.setupLighting();
    
    return this;
  }

  async initArToolkit(options) {
    // 检测设备 AR 能力
    const capabilities = await this.detectArCapabilities();
    
    if (capabilities.webxr) {
      // WebXR AR 模式（现代标准）
      await this.initWebXrAr();
    } else if (capabilities.arjs) {
      // AR.js 后备模式
      await this.initArJsMode();
    } else {
      // 设备不支持 AR
      throw new Error('AR_NOT_SUPPORTED');
    }
  }

  async initWebXrAr() {
    if (!navigator.xr) {
      throw new Error('WebXR not supported');
    }
    
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      throw new Error('AR session not supported');
    }
    
    // WebXR 会话配置
    this.xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'hit-test'],
      optionalFeatures: ['dom-overlay', 'light-estimation', 'plane-detection']
    });
    
    // 创建 XR 渲染层
    this.xrSession.updateRenderState({
      baseLayer: new XRWebGLLayer(this.xrSession, this.renderer.getContext())
    });
    
    // 设置 XR 参考空间
    this.xrReferenceSpace = await this.xrSession.requestReferenceSpace('local');
    
    // 监听平面检测事件
    this.setupPlaneDetection();
    
    // 监听光照估计
    this.setupLightEstimation();
  }

  setupPlaneDetection() {
    this.detectedPlanes = new Map();
    
    this.xrSession.addEventListener('planesdetected', (event) => {
      event.detectedPlanes.forEach((plane) => {
        const planeId = plane.planeSpace;
        this.detectedPlanes.set(planeId, {
          plane,
          pose: null,
          polygon: this.extractPlanePolygon(plane)
        });
      });
      
      this.emit('planesUpdated', Array.from(this.detectedPlanes.values()));
    });
  }

  setupLightEstimation() {
    this.lightProbe = null;
    
    this.xrSession.requestLightProbe().then((probe) => {
      this.lightProbe = probe;
    }).catch((err) => {
      console.warn('Light estimation not available:', err);
    });
  }

  updateLighting(frame) {
    if (!this.lightProbe) return;
    
    const lightEstimate = frame.getLightEstimate(this.lightProbe);
    if (!lightEstimate) return;
    
    // 更新环境光强度
    const { primaryLightDirection, primaryLightIntensity, sphericalHarmonicsCoefficients } = lightEstimate;
    
    if (this.directionalLight) {
      this.directionalLight.position.set(
        primaryLightDirection.x,
        primaryLightDirection.y,
        primaryLightDirection.z
      );
      this.directionalLight.color.setRGB(
        primaryLightIntensity.x / 255,
        primaryLightIntensity.y / 255,
        primaryLightIntensity.z / 255
      );
    }
    
    // 更新环境贴图
    if (sphericalHarmonicsCoefficients && this.envLight) {
      this.envLight.probe.fromSphericalHarmonics(sphericalHarmonicsCoefficients);
    }
  }

  setupLighting() {
    // 环境光
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambientLight);
    
    // 主方向光（用于光照匹配）
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.directionalLight.position.set(0, 10, 5);
    this.directionalLight.castShadow = true;
    this.scene.add(this.directionalLight);
    
    // 半球光（天空/地面光照）
    const hemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0x8B4513, 0.6);
    this.scene.add(hemisphereLight);
  }

  async loadPokemonModel(pokemonId, variant = null) {
    const cacheKey = `pokemon_${pokemonId}_${variant || 'default'}`;
    
    if (this.pokemonMeshes.has(cacheKey)) {
      return this.pokemonMeshes.get(cacheKey).clone();
    }
    
    // 从缓存或网络加载模型
    const modelUrl = `/api/v1/pokemon/${pokemonId}/model/${variant || 'default'}`;
    const loader = new THREE.GLTFLoader();
    
    return new Promise((resolve, reject) => {
      loader.load(
        modelUrl,
        (gltf) => {
          const model = gltf.scene;
          
          // 配置阴影
          model.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              
              // AR 优化材质
              if (child.material) {
                child.material.envMapIntensity = 1.0;
              }
            }
          });
          
          // 优化动画
          if (gltf.animations && gltf.animations.length > 0) {
            const mixer = new THREE.AnimationMixer(model);
            model.userData.mixer = mixer;
            model.userData.animations = gltf.animations;
          }
          
          this.pokemonMeshes.set(cacheKey, model);
          resolve(model.clone());
        },
        undefined,
        reject
      );
    });
  }

  placePokemonOnPlane(pokemon, plane, offset = { x: 0, y: 0, z: 0 }) {
    const pose = plane.pose;
    const position = new THREE.Vector3(
      pose.transform.position.x + offset.x,
      pose.transform.position.y + offset.y,
      pose.transform.position.z + offset.z
    );
    
    pokemon.position.copy(position);
    pokemon.rotation.setFromRotationMatrix(
      new THREE.Matrix4().fromArray(pose.transform.matrix)
    );
    
    this.scene.add(pokemon);
    
    return pokemon;
  }

  playPokemonAnimation(pokemon, animationName) {
    const mixer = pokemon.userData.mixer;
    const animations = pokemon.userData.animations;
    
    if (!mixer || !animations) return;
    
    const clip = animations.find(anim => anim.name === animationName);
    if (clip) {
      mixer.stopAllAction();
      const action = mixer.clipAction(clip);
      action.play();
    }
  }

  render(timestamp, frame) {
    if (!this.xrSession) {
      // 非 XR 模式渲染
      this.renderer.render(this.scene, this.camera);
      this.updateFrameRate(timestamp);
      return;
    }
    
    // WebXR 帧渲染
    this.xrSession.requestAnimationFrame((time, xrFrame) => {
      const pose = xrFrame.getViewerPose(this.xrReferenceSpace);
      
      if (pose) {
        const view = pose.views[0];
        const viewport = this.xrSession.renderState.baseLayer.getViewport(view);
        
        this.renderer.setSize(viewport.width, viewport.height);
        
        this.camera.projectionMatrix.fromArray(view.projectionMatrix);
        this.camera.matrix.fromArray(view.transform.matrix);
        this.camera.matrix.decompose(
          this.camera.position,
          this.camera.quaternion,
          this.camera.scale
        );
        
        // 更新光照估计
        this.updateLighting(xrFrame);
        
        // 更新动画
        this.updateAnimations(time);
        
        // 渲染场景
        this.renderer.render(this.scene, this.camera);
      }
      
      this.updateFrameRate(time);
    });
  }

  updateAnimations(time) {
    const delta = time - this.lastAnimationTime;
    this.lastAnimationTime = time;
    
    this.scene.traverse((object) => {
      if (object.userData.mixer) {
        object.userData.mixer.update(delta / 1000);
      }
    });
  }

  updateFrameRate(timestamp) {
    this.frameCount++;
    
    if (timestamp - this.lastFpsUpdateTime >= 1000) {
      this.frameRate = this.frameCount;
      this.frameCount = 0;
      this.lastFpsUpdateTime = timestamp;
      
      this.emit('fpsUpdate', this.frameRate);
      
      // 性能警告
      if (this.frameRate < 25) {
        this.emit('performanceWarning', { fps: this.frameRate });
      }
    }
  }

  async detectArCapabilities() {
    const capabilities = {
      webxr: false,
      arjs: false,
      camera: false,
      gyroscope: false,
      accelerometer: false
    };
    
    // 检测 WebXR
    if (navigator.xr) {
      capabilities.webxr = await navigator.xr.isSessionSupported('immersive-ar');
    }
    
    // 检测设备传感器
    if ('DeviceOrientationEvent' in window) {
      capabilities.gyroscope = true;
      capabilities.accelerometer = true;
    }
    
    // 检测摄像头权限
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      capabilities.camera = true;
      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      capabilities.camera = false;
    }
    
    // AR.js 可用性
    capabilities.arjs = capabilities.camera && capabilities.gyroscope;
    
    return capabilities;
  }

  captureScreenshot() {
    return new Promise((resolve) => {
      // 确保渲染完成
      this.renderer.render(this.scene, this.camera);
      
      const dataUrl = this.renderer.domElement.toDataURL('image/png', 1.0);
      resolve(dataUrl);
    });
  }

  dispose() {
    // 清理资源
    this.pokemonMeshes.forEach((mesh) => {
      mesh.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    });
    
    this.pokemonMeshes.clear();
    
    if (this.xrSession) {
      this.xrSession.end();
    }
    
    this.renderer.dispose();
  }
}

export default ArRenderer;
```

### 2. AR 捕捉模式管理器

```javascript
// frontend/game-client/src/ar/ArCatchManager.js
import ArRenderer from './ArRenderer';
import { ErrorHandler } from '../utils/ErrorHandler';

class ArCatchManager {
  constructor(eventBus, gameStore) {
    this.eventBus = eventBus;
    this.gameStore = gameStore;
    this.arRenderer = null;
    this.isActive = false;
    this.currentPokemon = null;
    this.detectedPlanes = [];
    this.selectedPlane = null;
    this.arEnabled = false;
    this.performanceMode = 'high'; // high | medium | low
  }

  async startArCatchSession(pokemon, location) {
    try {
      // 检查 AR 能力
      const capabilities = await this.checkArCapability();
      
      if (!capabilities.supported) {
        this.eventBus.emit('ar:notSupported', capabilities.reason);
        return this.fallbackToNormalCatch(pokemon, location);
      }
      
      // 根据设备性能选择模式
      this.performanceMode = this.determinePerformanceMode(capabilities);
      
      // 初始化 AR 渲染器
      this.arRenderer = new ArRenderer();
      await this.arRenderer.initialize(this.getArCanvas(), {
        performanceMode: this.performanceMode
      });
      
      // 加载精灵模型
      const pokemonMesh = await this.arRenderer.loadPokemonModel(
        pokemon.id, 
        pokemon.variant
      );
      
      // 设置事件监听
      this.setupArEventListeners();
      
      this.currentPokemon = pokemon;
      this.isActive = true;
      this.arEnabled = true;
      
      this.eventBus.emit('ar:sessionStarted', {
        pokemon,
        performanceMode: this.performanceMode
      });
      
      // 开始渲染循环
      this.startRenderLoop();
      
      return { success: true, arEnabled: true };
      
    } catch (error) {
      ErrorHandler.handleError(error, 'ArCatchManager.startArCatchSession');
      
      // AR 失败，降级到普通模式
      return this.fallbackToNormalCatch(pokemon, location);
    }
  }

  async checkArCapability() {
    const result = {
      supported: true,
      reason: null,
      webxr: false,
      camera: false,
      sensors: false,
      performance: 'unknown'
    };
    
    // 检测 WebXR
    if (navigator.xr) {
      result.webxr = await navigator.xr.isSessionSupported('immersive-ar');
    }
    
    // 检测摄像头
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
      });
      result.camera = true;
      stream.getTracks().forEach(t => t.stop());
    } catch (e) {
      result.camera = false;
      result.supported = false;
      result.reason = 'CAMERA_PERMISSION_DENIED';
    }
    
    // 检测传感器
    result.sensors = 'DeviceOrientationEvent' in window;
    
    // 检测设备性能
    result.performance = await this.estimateDevicePerformance();
    
    if (result.performance === 'low') {
      result.supported = false;
      result.reason = 'DEVICE_PERFORMANCE_TOO_LOW';
    }
    
    return result;
  }

  async estimateDevicePerformance() {
    // WebGL 性能测试
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    
    if (!gl) return 'low';
    
    // 检测 GPU 渲染器信息
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo 
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) 
      : 'unknown';
    
    // 检测内存
    const memory = navigator.deviceMemory || 4;
    
    // 检测 CPU 核心
    const cores = navigator.hardwareConcurrency || 4;
    
    // 性能评分
    let score = 0;
    
    // 内存评分
    if (memory >= 8) score += 3;
    else if (memory >= 4) score += 2;
    else score += 1;
    
    // CPU 评分
    if (cores >= 8) score += 3;
    else if (cores >= 4) score += 2;
    else score += 1;
    
    // GPU 评分（简单检测）
    if (renderer.includes('Adreno') || renderer.includes('Mali')) {
      const match = renderer.match(/\d+/);
      if (match && parseInt(match[0]) >= 600) score += 3;
      else score += 1;
    } else if (renderer.includes('Apple')) {
      score += 3;
    } else {
      score += 2;
    }
    
    if (score >= 8) return 'high';
    if (score >= 5) return 'medium';
    return 'low';
  }

  determinePerformanceMode(capabilities) {
    // 低性能设备强制使用低质量模式
    if (capabilities.performance === 'low') {
      return 'low';
    }
    
    // 中等性能设备使用中等质量
    if (capabilities.performance === 'medium') {
      return 'medium';
    }
    
    // 用户设置优先
    const userPreference = this.gameStore.get('arPerformanceMode');
    if (userPreference && ['high', 'medium', 'low'].includes(userPreference)) {
      return userPreference;
    }
    
    return 'high';
  }

  setupArEventListeners() {
    // 平面检测更新
    this.arRenderer.on('planesUpdated', (planes) => {
      this.detectedPlanes = planes;
      this.eventBus.emit('ar:planesDetected', planes);
    });
    
    // 帧率监控
    this.arRenderer.on('fpsUpdate', (fps) => {
      this.gameStore.set('ar.currentFps', fps);
      
      // 自动降级
      if (fps < 20 && this.performanceMode !== 'low') {
        this.downgradePerformance();
      }
    });
    
    // 性能警告
    this.arRenderer.on('performanceWarning', (data) => {
      this.eventBus.emit('ar:performanceWarning', data);
    });
  }

  downgradePerformance() {
    const modes = ['high', 'medium', 'low'];
    const currentIndex = modes.indexOf(this.performanceMode);
    
    if (currentIndex < modes.length - 1) {
      this.performanceMode = modes[currentIndex + 1];
      this.applyPerformanceSettings();
      
      this.eventBus.emit('ar:performanceDowngraded', {
        newMode: this.performanceMode
      });
    }
  }

  applyPerformanceSettings() {
    const settings = {
      high: {
        antialias: true,
        pixelRatio: Math.min(window.devicePixelRatio, 2),
        shadowMapSize: 2048,
        animationQuality: 'full'
      },
      medium: {
        antialias: false,
        pixelRatio: 1.0,
        shadowMapSize: 1024,
        animationQuality: 'reduced'
      },
      low: {
        antialias: false,
        pixelRatio: 0.75,
        shadowMapSize: 512,
        animationQuality: 'minimal'
      }
    };
    
    const config = settings[this.performanceMode];
    
    this.arRenderer.updateQualitySettings(config);
  }

  selectPlane(planeId) {
    const plane = this.detectedPlanes.find(p => p.id === planeId);
    
    if (plane) {
      this.selectedPlane = plane;
      this.eventBus.emit('ar:planeSelected', plane);
      
      // 在选中的平面上放置精灵
      this.placePokemonOnSelectedPlane();
    }
  }

  async placePokemonOnSelectedPlane() {
    if (!this.selectedPlane || !this.currentPokemon) return;
    
    const pokemonMesh = await this.arRenderer.loadPokemonModel(
      this.currentPokemon.id,
      this.currentPokemon.variant
    );
    
    this.arRenderer.placePokemonOnPlane(
      pokemonMesh,
      this.selectedPlane,
      { x: 0, y: 0.5, z: 0 }
    );
    
    // 播放待机动画
    this.arRenderer.playPokemonAnimation(pokemonMesh, 'idle');
    
    this.eventBus.emit('ar:pokemonPlaced', {
      pokemon: this.currentPokemon,
      plane: this.selectedPlane
    });
  }

  async captureArScreenshot() {
    if (!this.arRenderer) return null;
    
    try {
      const dataUrl = await this.arRenderer.captureScreenshot();
      
      // 上传截图
      const response = await fetch('/api/v1/media/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ar_screenshot',
          data: dataUrl.split(',')[1],
          format: 'png',
          metadata: {
            pokemonId: this.currentPokemon?.id,
            location: this.gameStore.get('currentLocation'),
            timestamp: Date.now()
          }
        })
      });
      
      const result = await response.json();
      
      this.eventBus.emit('ar:screenshotCaptured', result);
      
      return result;
      
    } catch (error) {
      ErrorHandler.handleError(error, 'ArCatchManager.captureArScreenshot');
      return null;
    }
  }

  fallbackToNormalCatch(pokemon, location) {
    this.arEnabled = false;
    
    this.eventBus.emit('ar:fallbackToNormal', {
      pokemon,
      location,
      reason: 'AR_NOT_SUPPORTED'
    });
    
    return { success: true, arEnabled: false };
  }

  endArCatchSession() {
    if (this.arRenderer) {
      this.arRenderer.dispose();
      this.arRenderer = null;
    }
    
    this.isActive = false;
    this.currentPokemon = null;
    this.detectedPlanes = [];
    this.selectedPlane = null;
    
    this.eventBus.emit('ar:sessionEnded');
  }

  startRenderLoop() {
    const render = (timestamp, frame) => {
      if (!this.isActive) return;
      
      this.arRenderer.render(timestamp, frame);
      requestAnimationFrame(render);
    };
    
    requestAnimationFrame(render);
  }

  getArCanvas() {
    let canvas = document.getElementById('ar-canvas');
    
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'ar-canvas';
      canvas.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 1000;
      `;
      document.body.appendChild(canvas);
    }
    
    return canvas;
  }
}

export default ArCatchManager;
```

### 3. AR 设置面板组件

```javascript
// frontend/game-client/src/components/ArSettingsPanel.js
import React, { useState, useEffect } from 'react';
import { useGameStore } from '../game/GameStore';

const ArSettingsPanel = ({ onSettingsChange }) => {
  const gameStore = useGameStore();
  const [settings, setSettings] = useState({
    performanceMode: 'auto',
    planeDetectionEnabled: true,
    lightEstimationEnabled: true,
    shadowEnabled: true,
    screenshotQuality: 'high'
  });

  const [arCapabilities, setArCapabilities] = useState(null);
  const [currentFps, setCurrentFps] = useState(0);

  useEffect(() => {
    checkArCapabilities();
    
    const unsubscribe = gameStore.subscribe('ar.currentFps', (fps) => {
      setCurrentFps(fps);
    });
    
    return unsubscribe;
  }, []);

  const checkArCapabilities = async () => {
    const response = await fetch('/api/v1/ar/capabilities');
    const capabilities = await response.json();
    setArCapabilities(capabilities);
  };

  const handleSettingChange = (key, value) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    
    onSettingsChange(newSettings);
    
    // 持久化设置
    localStorage.setItem('arSettings', JSON.stringify(newSettings));
  };

  const performanceModes = [
    { value: 'auto', label: '自动（推荐）' },
    { value: 'high', label: '高画质' },
    { value: 'medium', label: '中画质' },
    { value: 'low', label: '省电模式' }
  ];

  const screenshotQualities = [
    { value: 'low', label: '低（快速）' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高（最佳）' }
  ];

  return (
    <div className="ar-settings-panel">
      <h3>AR 设置</h3>
      
      {arCapabilities && (
        <div className="ar-capabilities">
          <div className="capability-item">
            <span>WebXR 支持</span>
            <span className={arCapabilities.webxr ? 'supported' : 'unsupported'}>
              {arCapabilities.webxr ? '✓' : '✗'}
            </span>
          </div>
          <div className="capability-item">
            <span>摄像头</span>
            <span className={arCapabilities.camera ? 'supported' : 'unsupported'}>
              {arCapabilities.camera ? '✓' : '✗'}
            </span>
          </div>
          <div className="capability-item">
            <span>传感器</span>
            <span className={arCapabilities.sensors ? 'supported' : 'unsupported'}>
              {arCapabilities.sensors ? '✓' : '✗'}
            </span>
          </div>
          <div className="capability-item">
            <span>设备性能</span>
            <span className={`performance-${arCapabilities.performance}`}>
              {arCapabilities.performance === 'high' ? '高性能' : 
               arCapabilities.performance === 'medium' ? '中等' : '低端'}
            </span>
          </div>
        </div>
      )}
      
      <div className="fps-indicator">
        <span>当前帧率: </span>
        <span className={currentFps >= 30 ? 'fps-good' : currentFps >= 20 ? 'fps-ok' : 'fps-bad'}>
          {currentFps} FPS
        </span>
      </div>
      
      <div className="setting-group">
        <label>画质模式</label>
        <select 
          value={settings.performanceMode}
          onChange={(e) => handleSettingChange('performanceMode', e.target.value)}
        >
          {performanceModes.map(mode => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </div>
      
      <div className="setting-group">
        <label>
          <input
            type="checkbox"
            checked={settings.planeDetectionEnabled}
            onChange={(e) => handleSettingChange('planeDetectionEnabled', e.target.checked)}
          />
          平面检测
        </label>
      </div>
      
      <div className="setting-group">
        <label>
          <input
            type="checkbox"
            checked={settings.lightEstimationEnabled}
            onChange={(e) => handleSettingChange('lightEstimationEnabled', e.target.checked)}
          />
          光照匹配
        </label>
      </div>
      
      <div className="setting-group">
        <label>
          <input
            type="checkbox"
            checked={settings.shadowEnabled}
            onChange={(e) => handleSettingChange('shadowEnabled', e.target.checked)}
          />
          阴影效果
        </label>
      </div>
      
      <div className="setting-group">
        <label>截图质量</label>
        <select 
          value={settings.screenshotQuality}
          onChange={(e) => handleSettingChange('screenshotQuality', e.target.value)}
        >
          {screenshotQualities.map(quality => (
            <option key={quality.value} value={quality.value}>
              {quality.label}
            </option>
          ))}
        </select>
      </div>
      
      <div className="ar-tips">
        <h4>使用提示</h4>
        <ul>
          <li>缓慢移动设备以检测平面</li>
          <li>点击检测到的平面放置精灵</li>
          <li>在光线充足的环境下效果最佳</li>
          <li>如遇卡顿可降低画质模式</li>
        </ul>
      </div>
    </div>
  );
};

export default ArSettingsPanel;
```

### 4. 后端 AR 配置服务

```javascript
// backend/services/gateway/routes/ar.js
const express = require('express');
const router = express.Router();
const ArConfigService = require('../../../shared/ArConfigService');
const { authenticate, optionalAuth } = require('../../../shared/auth');

// 获取 AR 配置
router.get('/config', optionalAuth, async (req, res) => {
  try {
    const config = await ArConfigService.getConfig(req.user?.id);
    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 检测设备 AR 能力
router.post('/capabilities', optionalAuth, async (req, res) => {
  try {
    const { userAgent, deviceMemory, hardwareConcurrency, gpuRenderer } = req.body;
    
    const capabilities = ArConfigService.analyzeCapabilities({
      userAgent,
      deviceMemory: deviceMemory || 4,
      hardwareConcurrency: hardwareConcurrency || 4,
      gpuRenderer: gpuRenderer || 'unknown'
    });
    
    // 记录设备信息用于分析
    if (req.user) {
      await ArConfigService.recordDeviceCapabilities(req.user.id, capabilities);
    }
    
    res.json({
      success: true,
      data: capabilities
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 上传 AR 截图
router.post('/screenshot', authenticate, async (req, res) => {
  try {
    const { image, metadata } = req.body;
    
    const result = await ArConfigService.saveScreenshot(req.user.id, {
      image,
      metadata
    });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// AR 使用统计
router.post('/analytics', authenticate, async (req, res) => {
  try {
    const { event, duration, performanceData } = req.body;
    
    await ArConfigService.recordAnalytics(req.user.id, {
      event,
      duration,
      performanceData,
      timestamp: Date.now()
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 5. AR 配置服务核心

```javascript
// backend/shared/ArConfigService.js
const { redis, db } = require('./database');
const { logger } = require('./logger');

class ArConfigService {
  constructor() {
    this.configCache = new Map();
    this.defaultConfig = {
      minDeviceMemory: 4,
      minCpuCores: 4,
      supportedGpuPatterns: [
        /Adreno [6-9]\d{2}/i,
        /Mali-G[7-9]\d/i,
        /Apple GPU/i,
        /Apple M[1-9]/i
      ],
      qualityPresets: {
        high: {
          maxModelVertices: 50000,
          textureResolution: 2048,
          shadowMapSize: 2048,
          antialias: true
        },
        medium: {
          maxModelVertices: 30000,
          textureResolution: 1024,
          shadowMapSize: 1024,
          antialias: false
        },
        low: {
          maxModelVertices: 15000,
          textureResolution: 512,
          shadowMapSize: 512,
          antialias: false
        }
      }
    };
  }

  async getConfig(userId) {
    // 检查缓存
    const cacheKey = `ar:config:${userId || 'default'}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 获取用户自定义配置
    let userConfig = null;
    if (userId) {
      const result = await db.query(
        'SELECT ar_config FROM user_preferences WHERE user_id = $1',
        [userId]
      );
      userConfig = result.rows[0]?.ar_config;
    }
    
    const config = {
      ...this.defaultConfig,
      userOverrides: userConfig || {},
      featureFlags: await this.getFeatureFlags()
    };
    
    // 缓存配置
    await redis.setex(cacheKey, 3600, JSON.stringify(config));
    
    return config;
  }

  analyzeCapabilities(deviceInfo) {
    const capabilities = {
      supported: true,
      reason: null,
      webxr: this.checkWebXrSupport(deviceInfo.userAgent),
      camera: true, // 假设已通过前端验证
      sensors: this.checkSensorSupport(deviceInfo.userAgent),
      performance: this.estimatePerformance(deviceInfo),
      recommendedQuality: 'medium'
    };
    
    // 确定推荐画质
    if (capabilities.performance === 'high') {
      capabilities.recommendedQuality = 'high';
    } else if (capabilities.performance === 'low') {
      capabilities.supported = false;
      capabilities.reason = 'DEVICE_PERFORMANCE_TOO_LOW';
    }
    
    return capabilities;
  }

  checkWebXrSupport(userAgent) {
    // iOS Safari 支持 WebXR 从 iOS 15 开始
    if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
      const iosMatch = userAgent.match(/OS (\d+)/);
      if (iosMatch && parseInt(iosMatch[1]) >= 15) {
        return true;
      }
      return false;
    }
    
    // Android Chrome 支持 WebXR 从 Chrome 79 开始
    if (userAgent.includes('Android')) {
      const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
      if (chromeMatch && parseInt(chromeMatch[1]) >= 79) {
        return true;
      }
      return false;
    }
    
    // 桌面浏览器通常不支持 AR
    return false;
  }

  checkSensorSupport(userAgent) {
    // 所有移动设备都有传感器
    return userAgent.includes('Mobile') || userAgent.includes('iPhone');
  }

  estimatePerformance(deviceInfo) {
    let score = 0;
    
    // 内存评分
    if (deviceInfo.deviceMemory >= 8) score += 4;
    else if (deviceInfo.deviceMemory >= 6) score += 3;
    else if (deviceInfo.deviceMemory >= 4) score += 2;
    else score += 1;
    
    // CPU 评分
    if (deviceInfo.hardwareConcurrency >= 8) score += 4;
    else if (deviceInfo.hardwareConcurrency >= 6) score += 3;
    else if (deviceInfo.hardwareConcurrency >= 4) score += 2;
    else score += 1;
    
    // GPU 评分
    const gpuScore = this.evaluateGpu(deviceInfo.gpuRenderer);
    score += gpuScore;
    
    // 最终评级
    if (score >= 10) return 'high';
    if (score >= 6) return 'medium';
    return 'low';
  }

  evaluateGpu(gpuRenderer) {
    if (!gpuRenderer || gpuRenderer === 'unknown') return 2;
    
    for (const pattern of this.defaultConfig.supportedGpuPatterns) {
      if (pattern.test(gpuRenderer)) {
        return 4;
      }
    }
    
    return 2;
  }

  async getFeatureFlags() {
    const flags = await redis.hgetall('feature_flags:ar');
    return {
      planeDetection: flags?.planeDetection !== 'false',
      lightEstimation: flags?.lightEstimation !== 'false',
      arScreenshots: flags?.arScreenshots !== 'false',
      arSharing: flags?.arSharing !== 'false'
    };
  }

  async recordDeviceCapabilities(userId, capabilities) {
    try {
      await db.query(`
        INSERT INTO ar_device_stats (user_id, capabilities, created_at)
        VALUES ($1, $2, NOW())
      `, [userId, JSON.stringify(capabilities)]);
    } catch (error) {
      logger.error('Failed to record device capabilities', { error, userId });
    }
  }

  async saveScreenshot(userId, data) {
    const { image, metadata } = data;
    
    // 生成唯一 ID
    const screenshotId = `ar_screenshot_${userId}_${Date.now()}`;
    
    // 存储到对象存储（这里简化为数据库）
    await db.query(`
      INSERT INTO ar_screenshots (id, user_id, image_data, metadata, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [screenshotId, userId, image, JSON.stringify(metadata)]);
    
    return {
      id: screenshotId,
      url: `/api/v1/media/ar-screenshot/${screenshotId}`,
      shareUrl: `/share/ar/${screenshotId}`
    };
  }

  async recordAnalytics(userId, data) {
    try {
      await db.query(`
        INSERT INTO ar_analytics (user_id, event, duration, performance_data, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [userId, data.event, data.duration, JSON.stringify(data.performanceData)]);
      
      // 更新聚合统计
      await this.updateAggregateStats(data);
    } catch (error) {
      logger.error('Failed to record AR analytics', { error, userId });
    }
  }

  async updateAggregateStats(data) {
    const today = new Date().toISOString().split('T')[0];
    
    await redis.hincrby(`ar:stats:${today}`, data.event, 1);
    
    if (data.duration) {
      await redis.hincrbyfloat(`ar:stats:${today}`, `${data.event}_duration_total`, data.duration);
    }
    
    if (data.performanceData?.fps) {
      await redis.hincrbyfloat(`ar:stats:${today}`, 'fps_sum', data.performanceData.fps);
      await redis.hincrby(`ar:stats:${today}`, 'fps_count', 1);
    }
  }
}

module.exports = new ArConfigService();
```

### 6. 数据库迁移

```sql
-- database/migrations/20260701_00_ar_support.sql
-- AR 功能支持表

-- AR 设备统计表
CREATE TABLE IF NOT EXISTS ar_device_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  capabilities JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ar_device_stats_user ON ar_device_stats(user_id);
CREATE INDEX idx_ar_device_stats_created ON ar_device_stats(created_at);

-- AR 截图表
CREATE TABLE IF NOT EXISTS ar_screenshots (
  id VARCHAR(100) PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  image_data TEXT NOT NULL,
  metadata JSONB,
  is_public BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ar_screenshots_user ON ar_screenshots(user_id);
CREATE INDEX idx_ar_screenshots_created ON ar_screenshots(created_at);

-- AR 分析表
CREATE TABLE IF NOT EXISTS ar_analytics (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  event VARCHAR(50) NOT NULL,
  duration INTEGER,
  performance_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ar_analytics_user ON ar_analytics(user_id);
CREATE INDEX idx_ar_analytics_event ON ar_analytics(event);
CREATE INDEX idx_ar_analytics_created ON ar_analytics(created_at);

-- 用户 AR 偏好
ALTER TABLE user_preferences 
ADD COLUMN IF NOT EXISTS ar_config JSONB DEFAULT '{
  "performanceMode": "auto",
  "planeDetection": true,
  "lightEstimation": true,
  "shadowEnabled": true,
  "screenshotQuality": "high"
}'::jsonb;

COMMENT ON TABLE ar_device_stats IS 'AR 设备能力统计';
COMMENT ON TABLE ar_screenshots IS 'AR 截图存储';
COMMENT ON TABLE ar_analytics IS 'AR 使用分析';
```

## 验收标准

- [ ] AR 模式在支持的设备上正常启动
- [ ] 平面检测功能正常，能检测水平/垂直平面
- [ ] 精灵 3D 模型正确渲染在 AR 场景中
- [ ] 光照匹配系统根据环境光调整渲染效果
- [ ] AR 模式帧率 ≥ 30 FPS（中端设备）
- [ ] 不支持 AR 的设备自动降级到普通模式
- [ ] AR 截图功能正常，可保存和分享
- [ ] AR 设置面板可调整画质和效果
- [ ] 性能自动降级机制在低帧率时生效
- [ ] 内存占用增量 < 150MB
- [ ] AR 使用统计数据正确记录

## 影响范围

- **新增文件**:
  - `frontend/game-client/src/ar/ArRenderer.js`
  - `frontend/game-client/src/ar/ArCatchManager.js`
  - `frontend/game-client/src/components/ArSettingsPanel.js`
  - `backend/shared/ArConfigService.js`
  - `backend/services/gateway/routes/ar.js`
  - `database/migrations/20260701_00_ar_support.sql`

- **修改文件**:
  - `frontend/game-client/src/game/CatchEngine.js` - 集成 AR 模式
  - `frontend/game-client/src/game/GameStore.js` - 添加 AR 状态管理
  - `backend/services/gateway/server.js` - 注册 AR 路由

## 参考

- [WebXR Device API](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API)
- [AR.js Documentation](https://ar-js-org.github.io/AR.js-Docs/)
- [Three.js AR Examples](https://threejs.org/examples/#webxr_vr_sandbox)
- [Apple ARKit Guidelines](https://developer.apple.com/documentation/arkit)
- [Google ARCore Overview](https://developers.google.com/ar)
