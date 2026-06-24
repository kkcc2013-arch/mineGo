# REQ-00320: 游戏客户端渲染性能优化与帧率稳定系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00320 |
| 标题 | 游戏客户端渲染性能优化与帧率稳定系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、frontend/game-client/src/rendering、frontend/game-client/src/game、gateway、location-service |
| 创建时间 | 2026-06-24 12:00 |

## 需求描述

游戏客户端在复杂场景下（多精灵同时出现、特效密集、地图缩放）可能出现帧率下降、卡顿现象，影响玩家体验。本需求旨在实现一套完整的渲染性能优化系统，包括：

1. **帧率监控与自适应降级**：实时监控帧率，自动降级特效以保证流畅度
2. **地图渲染优化**：精灵实例合并、图层缓存、视口裁剪
3. **动画性能优化**：GPU 加速、骨骼动画优化、粒子系统池化
4. **内存管理优化**：纹理压缩、资源生命周期管理、内存泄漏检测
5. **性能分析工具**：帧时间分析、渲染瓶颈定位、性能报告生成

### 目标
- 稳定帧率在 60 FPS（低端设备 30 FPS）
- 降低内存占用 30%
- 减少渲染管线延迟
- 提升低端设备兼容性

## 技术方案

### 1. 帧率监控与自适应降级系统

```javascript
// frontend/game-client/src/rendering/FrameRateMonitor.js

class FrameRateMonitor {
  constructor(options = {}) {
    this.targetFps = options.targetFps || 60;
    this.lowFpsThreshold = options.lowFpsThreshold || 30;
    this.sampleSize = options.sampleSize || 60; // 采样帧数
    
    this.frameTimes = [];
    this.lastFrameTime = performance.now();
    this.currentFps = 60;
    this.qualityLevel = 'high'; // high, medium, low
    
    this.qualitySettings = {
      high: {
        particleCount: 100,
        shadowQuality: 'high',
        antialiasing: true,
        textureQuality: 1.0
      },
      medium: {
        particleCount: 50,
        shadowQuality: 'medium',
        antialiasing: false,
        textureQuality: 0.75
      },
      low: {
        particleCount: 20,
        shadowQuality: 'off',
        antialiasing: false,
        textureQuality: 0.5
      }
    };
    
    this.listeners = [];
  }
  
  // 记录帧时间
  recordFrame() {
    const now = performance.now();
    const frameTime = now - this.lastFrameTime;
    this.lastFrameTime = now;
    
    this.frameTimes.push(frameTime);
    
    if (this.frameTimes.length > this.sampleSize) {
      this.frameTimes.shift();
    }
    
    this.updateMetrics();
  }
  
  // 更新性能指标
  updateMetrics() {
    if (this.frameTimes.length < 10) return;
    
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.currentFps = 1000 / avgFrameTime;
    
    // 自适应降级逻辑
    if (this.currentFps < this.lowFpsThreshold && this.qualityLevel !== 'low') {
      this.downgradeQuality();
    } else if (this.currentFps > this.targetFps * 0.9 && this.qualityLevel !== 'high') {
      this.upgradeQuality();
    }
  }
  
  // 降级画质
  downgradeQuality() {
    const levels = ['high', 'medium', 'low'];
    const currentIndex = levels.indexOf(this.qualityLevel);
    
    if (currentIndex < levels.length - 1) {
      this.qualityLevel = levels[currentIndex + 1];
      this.applyQualitySettings();
      this.emit('qualityChange', this.qualityLevel);
      
      console.warn(`[FrameRateMonitor] 降级画质至 ${this.qualityLevel}，当前帧率: ${this.currentFps.toFixed(1)} FPS`);
    }
  }
  
  // 升级画质
  upgradeQuality() {
    const levels = ['high', 'medium', 'low'];
    const currentIndex = levels.indexOf(this.qualityLevel);
    
    if (currentIndex > 0) {
      // 连续 5 秒稳定后才升级
      if (this.stableFrames++ > 300) {
        this.qualityLevel = levels[currentIndex - 1];
        this.applyQualitySettings();
        this.emit('qualityChange', this.qualityLevel);
        this.stableFrames = 0;
        
        console.log(`[FrameRateMonitor] 升级画质至 ${this.qualityLevel}`);
      }
    }
  }
  
  // 应用画质设置
  applyQualitySettings() {
    const settings = this.qualitySettings[this.qualityLevel];
    
    // 通知各渲染模块
    if (window.game) {
      window.game.particleSystem?.setMaxParticles(settings.particleCount);
      window.game.shadowRenderer?.setQuality(settings.shadowQuality);
      window.game.textureManager?.setQuality(settings.textureQuality);
    }
  }
  
  // 获取性能报告
  getPerformanceReport() {
    const frameTimes = this.frameTimes;
    const sortedTimes = [...frameTimes].sort((a, b) => a - b);
    
    return {
      currentFps: this.currentFps,
      averageFps: 1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length),
      minFps: 1000 / sortedTimes[sortedTimes.length - 1],
      maxFps: 1000 / sortedTimes[0],
      p95FrameTime: sortedTimes[Math.floor(sortedTimes.length * 0.95)],
      qualityLevel: this.qualityLevel,
      frameTimeVariance: this.calculateVariance(frameTimes)
    };
  }
  
  calculateVariance(arr) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
  }
  
  on(event, callback) {
    this.listeners.push({ event, callback });
  }
  
  emit(event, data) {
    this.listeners
      .filter(l => l.event === event)
      .forEach(l => l.callback(data));
  }
}

export default FrameRateMonitor;
```

### 2. 地图渲染优化 - 精灵实例合并

```javascript
// frontend/game-client/src/rendering/SpriteBatchRenderer.js

class SpriteBatchRenderer {
  constructor(gl) {
    this.gl = gl;
    this.maxSprites = 10000;
    this.vertexSize = 9; // x, y, r, g, b, a, u, v, textureIndex
    
    this.vertexBuffer = new Float32Array(this.maxSprites * 4 * this.vertexSize);
    this.indexBuffer = new Uint16Array(this.maxSprites * 6);
    
    this.spriteCount = 0;
    this.textures = new Map();
    this.currentTextures = [];
    
    this.initBuffers();
    this.initShaders();
  }
  
  initBuffers() {
    // 创建索引缓冲区
    for (let i = 0; i < this.maxSprites; i++) {
      const offset = i * 6;
      const vertexOffset = i * 4;
      
      this.indexBuffer[offset] = vertexOffset;
      this.indexBuffer[offset + 1] = vertexOffset + 1;
      this.indexBuffer[offset + 2] = vertexOffset + 2;
      this.indexBuffer[offset + 3] = vertexOffset;
      this.indexBuffer[offset + 4] = vertexOffset + 2;
      this.indexBuffer[offset + 5] = vertexOffset + 3;
    }
    
    // 创建 WebGL 缓冲区
    this.vbo = this.gl.createBuffer();
    this.ibo = this.gl.createBuffer();
    
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer, this.gl.STATIC_DRAW);
  }
  
  initShaders() {
    const vertexShaderSource = `
      attribute vec2 a_position;
      attribute vec4 a_color;
      attribute vec2 a_texCoord;
      attribute float a_textureIndex;
      
      uniform mat4 u_projection;
      
      varying vec4 v_color;
      varying vec2 v_texCoord;
      varying float v_textureIndex;
      
      void main() {
        gl_Position = u_projection * vec4(a_position, 0.0, 1.0);
        v_color = a_color;
        v_texCoord = a_texCoord;
        v_textureIndex = a_textureIndex;
      }
    `;
    
    const fragmentShaderSource = `
      precision mediump float;
      
      varying vec4 v_color;
      varying vec2 v_texCoord;
      varying float v_textureIndex;
      
      uniform sampler2D u_textures[8];
      
      void main() {
        vec4 texColor;
        int index = int(v_textureIndex);
        
        if (index == 0) texColor = texture2D(u_textures[0], v_texCoord);
        else if (index == 1) texColor = texture2D(u_textures[1], v_texCoord);
        else if (index == 2) texColor = texture2D(u_textures[2], v_texCoord);
        else if (index == 3) texColor = texture2D(u_textures[3], v_texCoord);
        else if (index == 4) texColor = texture2D(u_textures[4], v_texCoord);
        else if (index == 5) texColor = texture2D(u_textures[5], v_texCoord);
        else if (index == 6) texColor = texture2D(u_textures[6], v_texCoord);
        else texColor = texture2D(u_textures[7], v_texCoord);
        
        gl_FragColor = v_color * texColor;
      }
    `;
    
    this.shader = this.compileShaderProgram(vertexShaderSource, fragmentShaderSource);
  }
  
  // 添加精灵到批次
  addSprite(sprite) {
    if (this.spriteCount >= this.maxSprites) {
      this.flush();
    }
    
    // 获取纹理索引
    let textureIndex = this.currentTextures.indexOf(sprite.texture);
    if (textureIndex === -1) {
      if (this.currentTextures.length >= 8) {
        this.flush();
      }
      this.currentTextures.push(sprite.texture);
      textureIndex = this.currentTextures.length - 1;
    }
    
    // 计算顶点数据
    const offset = this.spriteCount * 4 * this.vertexSize;
    const vertices = this.calculateVertices(sprite, textureIndex);
    
    this.vertexBuffer.set(vertices, offset);
    this.spriteCount++;
  }
  
  calculateVertices(sprite, textureIndex) {
    const { x, y, width, height, color, uvs } = sprite;
    const [r, g, b, a] = color;
    
    // 四个顶点的数据
    return new Float32Array([
      // 左上
      x, y, r, g, b, a, uvs[0], uvs[1], textureIndex,
      // 右上
      x + width, y, r, g, b, a, uvs[2], uvs[1], textureIndex,
      // 右下
      x + width, y + height, r, g, b, a, uvs[2], uvs[3], textureIndex,
      // 左下
      x, y + height, r, g, b, a, uvs[0], uvs[3], textureIndex
    ]);
  }
  
  // 提交渲染
  flush() {
    if (this.spriteCount === 0) return;
    
    const gl = this.gl;
    
    // 绑定着色器
    gl.useProgram(this.shader);
    
    // 绑定纹理
    this.currentTextures.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(this.shader, `u_textures[${index}]`), index);
    });
    
    // 上传顶点数据
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexBuffer, gl.DYNAMIC_DRAW);
    
    // 设置顶点属性
    const stride = this.vertexSize * 4;
    const posLoc = gl.getAttribLocation(this.shader, 'a_position');
    const colorLoc = gl.getAttribLocation(this.shader, 'a_color');
    const texCoordLoc = gl.getAttribLocation(this.shader, 'a_texCoord');
    const texIndexLoc = gl.getAttribLocation(this.shader, 'a_textureIndex');
    
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);
    
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 4, gl.FLOAT, false, stride, 8);
    
    gl.enableVertexAttribArray(texCoordLoc);
    gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, stride, 24);
    
    gl.enableVertexAttribArray(texIndexLoc);
    gl.vertexAttribPointer(texIndexLoc, 1, gl.FLOAT, false, stride, 32);
    
    // 绘制
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.drawElements(gl.TRIANGLES, this.spriteCount * 6, gl.UNSIGNED_SHORT, 0);
    
    // 重置
    this.spriteCount = 0;
    this.currentTextures = [];
  }
  
  compileShaderProgram(vss, fss) {
    // WebGL shader compilation logic
    // ... 省略实现细节
  }
}

export default SpriteBatchRenderer;
```

### 3. 视口裁剪与 LOD 系统

```javascript
// frontend/game-client/src/rendering/ViewportCulling.js

class ViewportCulling {
  constructor(camera, options = {}) {
    this.camera = camera;
    this.tileSize = options.tileSize || 256;
    this.lodLevels = options.lodLevels || [0, 1, 2]; // 0: high, 1: medium, 2: low
    this.lodDistances = options.lodDistances || [500, 1000, 2000]; // 像素距离
    
    this.visibleEntities = new Set();
    this.lodMap = new Map();
  }
  
  // 更新可见实体
  update(entities) {
    this.visibleEntities.clear();
    this.lodMap.clear();
    
    const viewport = this.camera.getViewport();
    
    entities.forEach(entity => {
      // 视口裁剪
      if (this.isInViewport(entity, viewport)) {
        this.visibleEntities.add(entity.id);
        
        // 计算 LOD 级别
        const distance = this.calculateDistance(entity, this.camera.position);
        const lod = this.calculateLOD(distance);
        this.lodMap.set(entity.id, lod);
      }
    });
    
    return {
      visibleEntities: this.visibleEntities,
      lodMap: this.lodMap
    };
  }
  
  // 判断是否在视口内（带缓冲区）
  isInViewport(entity, viewport) {
    const buffer = this.tileSize * 2; // 缓冲区，避免边缘闪烁
    
    return (
      entity.x >= viewport.x - buffer &&
      entity.x <= viewport.x + viewport.width + buffer &&
      entity.y >= viewport.y - buffer &&
      entity.y <= viewport.y + viewport.height + buffer
    );
  }
  
  // 计算距离
  calculateDistance(entity, cameraPos) {
    const dx = entity.x - cameraPos.x;
    const dy = entity.y - cameraPos.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  // 计算 LOD 级别
  calculateLOD(distance) {
    for (let i = 0; i < this.lodDistances.length; i++) {
      if (distance < this.lodDistances[i]) {
        return this.lodLevels[i];
      }
    }
    return this.lodLevels[this.lodLevels.length - 1];
  }
  
  // 获取实体应使用的资源
  getResourceForEntity(entityId, resourceType) {
    const lod = this.lodMap.get(entityId) || 0;
    
    const resourceMap = {
      sprite: ['sprite_high', 'sprite_medium', 'sprite_low'],
      animation: ['anim_60fps', 'anim_30fps', 'anim_15fps'],
      particle: ['particles_full', 'particles_half', 'particles_minimal']
    };
    
    return resourceMap[resourceType]?.[lod] || resourceMap[resourceType]?.[0];
  }
}

export default ViewportCulling;
```

### 4. 纹理压缩与资源管理

```javascript
// frontend/game-client/src/rendering/TextureManager.js

class TextureManager {
  constructor(gl) {
    this.gl = gl;
    this.textures = new Map();
    this.textureCache = new Map();
    this.compressionFormats = this.detectCompressionFormats();
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    
    // LRU 缓存配置
    this.cacheSize = 256 * 1024 * 1024; // 256 MB
    this.currentCacheSize = 0;
    this.lruList = [];
  }
  
  // 检测支持的压缩格式
  detectCompressionFormats() {
    const gl = this.gl;
    const formats = [];
    
    // ASTC (Adaptive Scalable Texture Compression)
    if (gl.getExtension('WEBGL_compressed_texture_astc')) {
      formats.push('astc');
    }
    
    // ETC2 (Ericsson Texture Compression 2)
    if (gl.getExtension('WEBGL_compressed_texture_etc2') || 
        gl.getExtension('WEBGL_compressed_texture_etc')) {
      formats.push('etc2');
    }
    
    // S3TC (S3 Texture Compression / DXT)
    if (gl.getExtension('WEBGL_compressed_texture_s3tc')) {
      formats.push('s3tc');
    }
    
    // PVRTC (PowerVR Texture Compression)
    if (gl.getExtension('WEBGL_compressed_texture_pvrtc')) {
      formats.push('pvrtc');
    }
    
    return formats;
  }
  
  // 加载纹理（支持压缩格式）
  async loadTexture(url, options = {}) {
    const cacheKey = this.getCacheKey(url, options);
    
    // 检查缓存
    if (this.textures.has(cacheKey)) {
      this.updateLRU(cacheKey);
      return this.textures.get(cacheKey);
    }
    
    // 检查内存限制
    await this.ensureCacheSpace(options.estimatedSize || 1024 * 1024);
    
    // 尝试加载压缩纹理
    const compressionFormat = this.selectCompressionFormat(options.quality);
    const compressedUrl = this.getCompressedUrl(url, compressionFormat);
    
    try {
      const texture = await this.loadTextureData(compressedUrl, compressionFormat);
      this.textures.set(cacheKey, texture);
      this.addToLRU(cacheKey, texture.size);
      
      return texture;
    } catch (error) {
      // 降级到未压缩格式
      console.warn(`[TextureManager] 压缩纹理加载失败，降级至原始格式: ${url}`);
      return await this.loadTextureData(url, 'none');
    }
  }
  
  // 选择压缩格式
  selectCompressionFormat(quality = 'high') {
    if (this.compressionFormats.length === 0) return 'none';
    
    // 根据质量选择格式
    if (quality === 'high' && this.compressionFormats.includes('astc')) {
      return 'astc';
    } else if (quality === 'medium' && this.compressionFormats.includes('etc2')) {
      return 'etc2';
    } else if (this.compressionFormats.includes('s3tc')) {
      return 's3tc';
    }
    
    return this.compressionFormats[0] || 'none';
  }
  
  // 获取压缩纹理 URL
  getCompressedUrl(originalUrl, format) {
    if (format === 'none') return originalUrl;
    
    const ext = originalUrl.split('.').pop();
    const basePath = originalUrl.replace(`.${ext}`, '');
    
    // 服务端需要提供对应的压缩版本
    return `${basePath}_${format}.ktx2`;
  }
  
  // 加载纹理数据
  async loadTextureData(url, format) {
    const gl = this.gl;
    const texture = gl.createTexture();
    
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    if (format !== 'none') {
      // 加载压缩纹理
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      
      // 解析 KTX2 格式
      const { width, height, data, internalFormat } = this.parseKTX2(arrayBuffer);
      
      gl.compressedTexImage2D(
        gl.TEXTURE_2D, 
        0, 
        internalFormat, 
        width, 
        height, 
        0, 
        data
      );
      
      texture.width = width;
      texture.height = height;
      texture.size = data.byteLength;
    } else {
      // 加载标准纹理
      const image = new Image();
      
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      
      texture.width = image.width;
      texture.height = image.height;
      texture.size = image.width * image.height * 4; // RGBA
    }
    
    // 设置纹理参数
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    gl.generateMipmap(gl.TEXTURE_2D);
    
    return texture;
  }
  
  // LRU 缓存管理
  async ensureCacheSpace(requiredSize) {
    while (this.currentCacheSize + requiredSize > this.cacheSize && this.lruList.length > 0) {
      const oldest = this.lruList.shift();
      const texture = this.textures.get(oldest);
      
      if (texture) {
        this.gl.deleteTexture(texture);
        this.textures.delete(oldest);
        this.currentCacheSize -= texture.size;
      }
    }
  }
  
  updateLRU(key) {
    const index = this.lruList.indexOf(key);
    if (index !== -1) {
      this.lruList.splice(index, 1);
      this.lruList.push(key);
    }
  }
  
  addToLRU(key, size) {
    this.lruList.push(key);
    this.currentCacheSize += size;
  }
  
  // KTX2 解析（简化版）
  parseKTX2(arrayBuffer) {
    // 实际实现需要完整的 KTX2 解析器
    // 这里提供简化示例
    const view = new DataView(arrayBuffer);
    
    // 读取 KTX2 头部
    // ... 省略具体实现
    
    return {
      width: 0,
      height: 0,
      data: new Uint8Array(),
      internalFormat: 0
    };
  }
  
  getCacheKey(url, options) {
    return `${url}_${options.quality || 'default'}`;
  }
  
  // 清理所有纹理
  dispose() {
    this.textures.forEach(texture => {
      this.gl.deleteTexture(texture);
    });
    this.textures.clear();
    this.textureCache.clear();
    this.lruList = [];
    this.currentCacheSize = 0;
  }
}

export default TextureManager;
```

### 5. 性能分析工具

```javascript
// frontend/game-client/src/rendering/PerformanceProfiler.js

class PerformanceProfiler {
  constructor() {
    this.enabled = true;
    this.frames = [];
    this.maxFrames = 300;
    
    this.timings = {
      update: [],
      render: [],
      physics: [],
      network: [],
      total: []
    };
    
    this.counters = {
      drawCalls: 0,
      triangles: 0,
      textureBinds: 0,
      shaderBinds: 0
    };
    
    this.marks = new Map();
    this.measures = [];
  }
  
  // 开始帧
  beginFrame() {
    this.frameStart = performance.now();
    this.counters.drawCalls = 0;
    this.counters.triangles = 0;
  }
  
  // 结束帧
  endFrame() {
    const frameEnd = performance.now();
    const frameTime = frameEnd - this.frameStart;
    
    this.frames.push({
      time: frameTime,
      timestamp: this.frameStart,
      counters: { ...this.counters }
    });
    
    if (this.frames.length > this.maxFrames) {
      this.frames.shift();
    }
  }
  
  // 性能标记
  mark(name) {
    this.marks.set(name, performance.now());
  }
  
  // 性能测量
  measure(name, startMark, endMark) {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark) || performance.now();
    
    if (start) {
      const duration = end - start;
      
      if (!this.timings[name]) {
        this.timings[name] = [];
      }
      
      this.timings[name].push(duration);
      
      if (this.timings[name].length > this.maxFrames) {
        this.timings[name].shift();
      }
    }
  }
  
  // 增加计数器
  incrementCounter(name, value = 1) {
    this.counters[name] = (this.counters[name] || 0) + value;
  }
  
  // 获取统计信息
  getStats(category) {
    const data = this.timings[category] || [];
    
    if (data.length === 0) return null;
    
    const sum = data.reduce((a, b) => a + b, 0);
    const avg = sum / data.length;
    const sorted = [...data].sort((a, b) => a - b);
    
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: avg,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
  
  // 生成性能报告
  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      frames: {
        total: this.frames.length,
        avgFrameTime: 0,
        avgFps: 0
      },
      timings: {},
      counters: this.counters,
      bottlenecks: []
    };
    
    // 计算平均帧时间
    if (this.frames.length > 0) {
      const avgFrameTime = this.frames.reduce((sum, f) => sum + f.time, 0) / this.frames.length;
      report.frames.avgFrameTime = avgFrameTime;
      report.frames.avgFps = 1000 / avgFrameTime;
    }
    
    // 各阶段统计
    Object.keys(this.timings).forEach(key => {
      report.timings[key] = this.getStats(key);
    });
    
    // 识别瓶颈
    this.identifyBottlenecks(report);
    
    return report;
  }
  
  // 识别性能瓶颈
  identifyBottlenecks(report) {
    const thresholds = {
      update: 8, // 8ms
      render: 12, // 12ms
      physics: 4, // 4ms
      network: 2 // 2ms
    };
    
    Object.keys(thresholds).forEach(key => {
      const stats = report.timings[key];
      if (stats && stats.avg > thresholds[key]) {
        report.bottlenecks.push({
          category: key,
          avgTime: stats.avg,
          threshold: thresholds[key],
          severity: stats.avg > thresholds[key] * 2 ? 'high' : 'medium'
        });
      }
    });
  }
  
  // 导出为 JSON
  exportJSON() {
    return JSON.stringify(this.generateReport(), null, 2);
  }
  
  // 可视化（返回用于绘制图表的数据）
  getChartData() {
    return {
      frameTimes: this.frames.map(f => f.time),
      timestamps: this.frames.map(f => f.timestamp),
      categories: Object.keys(this.timings).map(key => ({
        name: key,
        data: this.timings[key]
      }))
    };
  }
}

export default PerformanceProfiler;
```

### 6. 内存泄漏检测

```javascript
// frontend/game-client/src/rendering/MemoryMonitor.js

class MemoryMonitor {
  constructor(options = {}) {
    this.checkInterval = options.checkInterval || 10000; // 10 秒
    this.warningThreshold = options.warningThreshold || 0.1; // 10% 增长
    this.criticalThreshold = options.criticalThreshold || 0.3; // 30% 增长
    
    this.snapshots = [];
    this.objectCounts = new Map();
    this.listeners = [];
  }
  
  // 开始监控
  start() {
    this.intervalId = setInterval(() => {
      this.takeSnapshot();
      this.analyze();
    }, this.checkInterval);
    
    // 初始快照
    this.takeSnapshot();
  }
  
  // 停止监控
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  
  // 记录对象创建
  trackObject(type, obj) {
    if (!this.objectCounts.has(type)) {
      this.objectCounts.set(type, { created: 0, destroyed: 0, active: new WeakSet() });
    }
    
    const counter = this.objectCounts.get(type);
    counter.created++;
    counter.active.add(obj);
    
    // 返回销毁函数
    return () => {
      counter.destroyed++;
      counter.active.delete(obj);
    };
  }
  
  // 获取内存快照
  takeSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      memory: this.getMemoryInfo(),
      objects: this.getObjectCounts(),
      resources: this.getResourceCounts()
    };
    
    this.snapshots.push(snapshot);
    
    // 保留最近 100 个快照
    if (this.snapshots.length > 100) {
      this.snapshots.shift();
    }
    
    return snapshot;
  }
  
  // 获取内存信息
  getMemoryInfo() {
    if (performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
      };
    }
    return null;
  }
  
  // 获取对象计数
  getObjectCounts() {
    const counts = {};
    
    this.objectCounts.forEach((counter, type) => {
      counts[type] = {
        created: counter.created,
        destroyed: counter.destroyed,
        active: counter.active.size || (counter.created - counter.destroyed)
      };
    });
    
    return counts;
  }
  
  // 获取资源计数（WebGL 等）
  getResourceCounts() {
    const gl = window.game?.gl;
    if (!gl) return null;
    
    return {
      textures: gl.getParameter(gl.TEXTURE_BINDING_2D) ? 'active' : 'none',
      buffers: gl.getParameter(gl.ARRAY_BUFFER_BINDING) ? 'active' : 'none',
      shaders: gl.getParameter(gl.CURRENT_PROGRAM) ? 'active' : 'none'
    };
  }
  
  // 分析内存趋势
  analyze() {
    if (this.snapshots.length < 2) return;
    
    const recent = this.snapshots[this.snapshots.length - 1];
    const baseline = this.snapshots[0];
    
    if (!recent.memory || !baseline.memory) return;
    
    const growth = (recent.memory.usedJSHeapSize - baseline.memory.usedJSHeapSize) / baseline.memory.usedJSHeapSize;
    
    // 检测内存泄漏
    if (growth > this.criticalThreshold) {
      this.emit('memoryLeak', {
        severity: 'critical',
        growth: growth,
        current: recent.memory.usedJSHeapSize,
        baseline: baseline.memory.usedJSHeapSize,
        details: recent.objects
      });
    } else if (growth > this.warningThreshold) {
      this.emit('memoryWarning', {
        severity: 'warning',
        growth: growth,
        current: recent.memory.usedJSHeapSize
      });
    }
  }
  
  // 生成报告
  generateReport() {
    if (this.snapshots.length === 0) return null;
    
    const latest = this.snapshots[this.snapshots.length - 1];
    const oldest = this.snapshots[0];
    
    return {
      duration: latest.timestamp - oldest.timestamp,
      snapshots: this.snapshots.length,
      memory: {
        current: latest.memory,
        growth: latest.memory ? 
          ((latest.memory.usedJSHeapSize - oldest.memory.usedJSHeapSize) / oldest.memory.usedJSHeapSize) : 0
      },
      objects: latest.objects,
      potentialLeaks: this.detectPotentialLeaks()
    };
  }
  
  // 检测潜在泄漏
  detectPotentialLeaks() {
    const leaks = [];
    
    this.objectCounts.forEach((counter, type) => {
      const activeCount = counter.created - counter.destroyed;
      
      // 如果活跃对象数量持续增长
      if (counter.created > 100 && counter.destroyed / counter.created < 0.5) {
        leaks.push({
          type: type,
          created: counter.created,
          destroyed: counter.destroyed,
          active: activeCount,
          retentionRate: activeCount / counter.created
        });
      }
    });
    
    return leaks;
  }
  
  on(event, callback) {
    this.listeners.push({ event, callback });
  }
  
  emit(event, data) {
    this.listeners
      .filter(l => l.event === event)
      .forEach(l => l.callback(data));
  }
}

export default MemoryMonitor;
```

## 验收标准

- [ ] 帧率稳定在 60 FPS（中端设备），低端设备稳定在 30 FPS
- [ ] 帧率监控系统能够自动检测性能下降并降级画质
- [ ] 精灵实例合并渲染器支持至少 10000 个精灵同屏
- [ ] 视口裁剪减少至少 50% 的离屏实体渲染
- [ ] 纹理压缩支持 ASTC/ETC2/S3TC 至少一种格式
- [ ] 内存占用降低 30%（相比优化前）
- [ ] 性能分析工具能够定位渲染瓶颈
- [ ] 内存泄漏检测能识别常见泄漏模式
- [ ] 低端设备（2GB 内存）能够流畅运行
- [ ] 所有优化项可通过配置开关控制
- [ ] 提供性能报告生成和导出功能
- [ ] 文档包含性能优化最佳实践指南

## 影响范围

- `frontend/game-client/src/rendering/` - 新增性能优化模块
- `frontend/game-client/src/game/Game.js` - 集成帧率监控
- `frontend/game-client/src/game/MapRenderer.js` - 集成精灵批处理
- `frontend/game-client/src/game/EntityManager.js` - 集成视口裁剪
- `frontend/game-client/src/resources/TextureLoader.js` - 集成纹理压缩
- `game-client/package.json` - 新增性能监控依赖
- `docs/performance-optimization.md` - 新增性能优化文档

## 参考

- [WebGL Performance Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- [Texture Compression Formats](https://www.khronos.org/opengl/wiki/Texture_Compression)
- [Game Performance Optimization Patterns](https://gameprogrammingpatterns.com/)
- [WebGL Stats - Hardware Capabilities](https://webglstats.com/)
- 相关需求：REQ-00001（缓存优化）、REQ-00031（API 缓存）、REQ-00110（前端懒加载）
