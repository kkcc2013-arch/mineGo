# REQ-00162：游戏内屏幕阅读器语音导航增强系统

- **编号**：REQ-00162
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、frontend/game-client/src/components
- **创建时间**：2026-06-13 17:05
- **依赖需求**：REQ-00017

## 1. 背景与问题

当前 mineGo 的无障碍支持已经实现了：
- 色盲模式（4 种类型）
- 高对比度模式
- 减少动画效果（reduced motion）
- 键盘导航基础支持
- ARIA live region 通知系统（A11yAnnouncer）

**存在的问题：**
1. 屏幕阅读器用户无法有效获取游戏地图信息（精灵位置、道馆位置、距离等）
2. 缺少游戏场景的语义化描述（如"地图上有 3 只精灵，方向分别为..."）
3. 无语音播报设置选项（语速、音量、播报级别）
4. 捕捉、战斗等动态交互场景缺少实时语音反馈
5. 移动端屏幕阅读器（VoiceOver/TalkBack）兼容性不完整

视障玩家在 AR 游戏中的体验严重受限，无法像普通玩家一样享受游戏乐趣。

## 2. 目标

为视障玩家提供完整的语音导航体验：
1. 游戏地图语音描述（精灵/道馆/补给站的空间位置）
2. 动态事件实时语音播报
3. 可自定义的语音设置（语速、音量、播报级别）
4. 原生屏幕阅读器深度集成
5. 空间音频提示帮助定位游戏元素

## 3. 范围

- **包含**：
  - 地图场景语音描述系统
  - 游戏事件语音播报增强
  - 语音设置管理面板
  - 空间音频定位提示
  - VoiceOver/TalkBack 优化适配
  - ARIA 属性深度优化

- **不包含**：
  - 语音控制/命令系统（属于单独需求）
  - 完整的 TTS 引擎（使用浏览器原生 Web Speech API）
  - 第三方屏幕阅读器插件开发

## 4. 详细需求

### 4.1 地图语音描述系统

```javascript
// frontend/game-client/src/accessibility/MapDescriber.js
class MapDescriber {
  constructor() {
    this.lastDescription = null;
    this.descriptionInterval = null;
  }

  // 描述当前地图状态
  describeMap(playerLocation, nearbyEntities) {
    const { pokemon, gyms, pokestops } = nearbyEntities;
    
    let description = [];
    
    // 精灵描述
    if (pokemon.length > 0) {
      const byDirection = this.groupByDirection(pokemon, playerLocation);
      description.push(`地图上有 ${pokemon.length} 只精灵`);
      
      for (const [direction, mons] of Object.entries(byDirection)) {
        const names = mons.map(m => m.speciesName).join('、');
        description.push(`你的${direction}方有${names}`);
      }
    }
    
    // 道馆描述
    if (gyms.length > 0) {
      const nearestGym = gyms[0];
      const distance = this.calculateDistance(playerLocation, nearestGym);
      const direction = this.getDirection(playerLocation, nearestGym);
      description.push(`最近的道馆在${direction}方，距离${distance}米`);
    }
    
    return description.join('。');
  }

  // 方向分组
  groupByDirection(entities, playerLoc) {
    const directions = {
      '北': [], '东北': [], '东': [], '东南': [],
      '南': [], '西南': [], '西': [], '西北': []
    };
    
    for (const entity of entities) {
      const dir = this.getDirection(playerLoc, entity);
      directions[dir].push(entity);
    }
    
    // 过滤空方向
    return Object.fromEntries(
      Object.entries(directions).filter(([_, v]) => v.length > 0)
    );
  }

  // 计算方向
  getDirection(from, to) {
    const dx = to.lng - from.lng;
    const dy = to.lat - from.lat;
    const angle = Math.atan2(dx, dy) * 180 / Math.PI;
    
    if (angle >= -22.5 && angle < 22.5) return '北';
    if (angle >= 22.5 && angle < 67.5) return '东北';
    if (angle >= 67.5 && angle < 112.5) return '东';
    if (angle >= 112.5 && angle < 157.5) return '东南';
    if (angle >= 157.5 || angle < -157.5) return '南';
    if (angle >= -157.5 && angle < -112.5) return '西南';
    if (angle >= -112.5 && angle < -67.5) return '西';
    if (angle >= -67.5 && angle < -22.5) return '西北';
    return '北';
  }
}
```

### 4.2 Web Speech API 语音播报

```javascript
// frontend/game-client/src/accessibility/SpeechService.js
class SpeechService {
  constructor() {
    this.synth = window.speechSynthesis;
    this.currentUtterance = null;
    this.settings = {
      enabled: false,
      rate: 1.0,      // 语速 0.1-10
      pitch: 1.0,     // 音调 0-2
      volume: 1.0,    // 音量 0-1
      voice: null,    // 语音角色
      language: 'zh-CN',
      announceLevel: 'full'  // full/minimal/critical-only
    };
    
    this.loadSettings();
  }

  loadSettings() {
    const saved = localStorage.getItem('speech-settings');
    if (saved) {
      this.settings = { ...this.settings, ...JSON.parse(saved) };
    }
  }

  saveSettings() {
    localStorage.setItem('speech-settings', JSON.stringify(this.settings));
  }

  // 播放语音
  speak(text, options = {}) {
    if (!this.settings.enabled) return;
    
    // 检查播报级别
    if (options.level === 'info' && this.settings.announceLevel === 'critical-only') {
      return;
    }
    if (options.level === 'info' && this.settings.announceLevel === 'minimal') {
      return;
    }

    // 取消当前播放
    this.synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = this.settings.rate;
    utterance.pitch = this.settings.pitch;
    utterance.volume = this.settings.volume;
    utterance.lang = this.settings.language;
    
    if (this.settings.voice) {
      const voices = this.synth.getVoices();
      const selectedVoice = voices.find(v => v.name === this.settings.voice);
      if (selectedVoice) utterance.voice = selectedVoice;
    }

    utterance.onend = () => {
      this.currentUtterance = null;
    };

    utterance.onerror = (event) => {
      console.error('[Speech] Error:', event.error);
    };

    this.currentUtterance = utterance;
    this.synth.speak(utterance);
  }

  // 停止播放
  stop() {
    this.synth.cancel();
    this.currentUtterance = null;
  }

  // 暂停/继续
  toggle() {
    if (this.synth.paused) {
      this.synth.resume();
    } else {
      this.synth.pause();
    }
  }

  // 获取可用语音列表
  getAvailableVoices() {
    return this.synth.getVoices().map(v => ({
      name: v.name,
      lang: v.lang,
      default: v.default
    }));
  }
}

export const speechService = new SpeechService();
```

### 4.3 语音设置面板 UI

```javascript
// frontend/game-client/src/accessibility/SpeechSettingsPanel.js
class SpeechSettingsPanel {
  constructor() {
    this.panel = null;
    this.isOpen = false;
  }

  render() {
    return `
      <div id="speech-settings-panel" class="a11y-panel" role="dialog" aria-labelledby="speech-title">
        <h2 id="speech-title">语音导航设置</h2>
        
        <div class="setting-group">
          <label>
            <input type="checkbox" id="speech-enabled" 
                   ${speechService.settings.enabled ? 'checked' : ''}>
            启用语音导航
          </label>
        </div>

        <div class="setting-group">
          <label for="speech-rate">语速</label>
          <input type="range" id="speech-rate" min="0.5" max="2" step="0.1"
                 value="${speechService.settings.rate}">
          <span id="rate-value">${speechService.settings.rate}</span>
        </div>

        <div class="setting-group">
          <label for="speech-pitch">音调</label>
          <input type="range" id="speech-pitch" min="0.5" max="1.5" step="0.1"
                 value="${speechService.settings.pitch}">
          <span id="pitch-value">${speechService.settings.pitch}</span>
        </div>

        <div class="setting-group">
          <label for="speech-volume">音量</label>
          <input type="range" id="speech-volume" min="0" max="1" step="0.1"
                 value="${speechService.settings.volume}">
          <span id="volume-value">${speechService.settings.volume * 100}%</span>
        </div>

        <div class="setting-group">
          <label for="announce-level">播报级别</label>
          <select id="announce-level">
            <option value="full" ${speechService.settings.announceLevel === 'full' ? 'selected' : ''}>
              完整播报（所有事件）
            </option>
            <option value="minimal" ${speechService.settings.announceLevel === 'minimal' ? 'selected' : ''}>
              精简播报（重要事件）
            </option>
            <option value="critical-only" ${speechService.settings.announceLevel === 'critical-only' ? 'selected' : ''}>
              仅关键提示
            </option>
          </select>
        </div>

        <div class="setting-group">
          <label for="voice-select">语音角色</label>
          <select id="voice-select"></select>
        </div>

        <button id="test-speech" class="btn-test">测试语音</button>
        <button id="close-speech-panel" class="btn-close">关闭</button>
      </div>
    `;
  }

  bindEvents() {
    document.getElementById('speech-enabled').addEventListener('change', (e) => {
      speechService.settings.enabled = e.target.checked;
      speechService.saveSettings();
    });

    document.getElementById('speech-rate').addEventListener('input', (e) => {
      speechService.settings.rate = parseFloat(e.target.value);
      document.getElementById('rate-value').textContent = e.target.value;
      speechService.saveSettings();
    });

    document.getElementById('speech-pitch').addEventListener('input', (e) => {
      speechService.settings.pitch = parseFloat(e.target.value);
      document.getElementById('pitch-value').textContent = e.target.value;
      speechService.saveSettings();
    });

    document.getElementById('speech-volume').addEventListener('input', (e) => {
      speechService.settings.volume = parseFloat(e.target.value);
      document.getElementById('volume-value').textContent = `${Math.round(e.target.value * 100)}%`;
      speechService.saveSettings();
    });

    document.getElementById('announce-level').addEventListener('change', (e) => {
      speechService.settings.announceLevel = e.target.value;
      speechService.saveSettings();
    });

    document.getElementById('test-speech').addEventListener('click', () => {
      speechService.speak('这是一条测试语音，欢迎使用 mineGo 语音导航系统', { level: 'critical' });
    });

    document.getElementById('close-speech-panel').addEventListener('click', () => {
      this.close();
    });
  }
}
```

### 4.4 空间音频定位提示

```javascript
// frontend/game-client/src/accessibility/SpatialAudio.js
class SpatialAudio {
  constructor() {
    this.audioContext = null;
    this.pannerNode = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.pannerNode = this.audioContext.createPanner();
    this.pannerNode.panningModel = 'HRTF';
    this.pannerNode.distanceModel = 'inverse';
    this.pannerNode.refDistance = 1;
    this.pannerNode.maxDistance = 10000;
    this.pannerNode.rolloffFactor = 1;
    this.pannerNode.coneInnerAngle = 360;
    this.pannerNode.coneOuterAngle = 360;
    this.pannerNode.coneOuterGain = 0;
    
    this.pannerNode.connect(this.audioContext.destination);
    this.initialized = true;
  }

  // 播放定位音效
  async playPositionedSound(audioUrl, position) {
    await this.init();
    
    // 更新听者位置（玩家位置）
    const listener = this.audioContext.listener;
    if (listener.positionX) {
      listener.positionX.value = 0;
      listener.positionY.value = 0;
      listener.positionZ.value = 0;
    }

    // 设置音源位置
    this.pannerNode.positionX.value = position.x;
    this.pannerNode.positionY.value = position.y;
    this.pannerNode.positionZ.value = position.z;

    // 加载并播放音效
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.pannerNode);
    source.start();
  }

  // 将地理坐标转换为空间音频坐标
  geoToSpatial(playerLat, playerLng, targetLat, targetLng, scale = 100) {
    const dx = (targetLng - playerLng) * scale;
    const dy = (targetLat - playerLat) * scale;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    return {
      x: dx,
      y: 0,
      z: -dy,
      distance
    };
  }
}

export const spatialAudio = new SpatialAudio();
```

### 4.5 ARIA 属性优化

```javascript
// 地图区域语义化
<div id="game-map" 
     role="application"
     aria-label="游戏地图"
     aria-describedby="map-description">
  <span id="map-description" class="sr-only">
    使用方向键导航，按空格键与附近精灵互动
  </span>
</div>

// 精灵标记无障碍化
<div class="pokemon-marker" 
     role="button"
     tabindex="0"
     aria-label="${speciesName}，距离 ${distance} 米，${direction} 方向"
     aria-describedby="pokemon-actions">
  <span class="sr-only" id="pokemon-actions">
    按回车键尝试捕捉
  </span>
</div>

// 战斗场景实时状态
<div id="battle-scene"
     role="region"
     aria-live="polite"
     aria-atomic="false"
     aria-label="道馆战斗">
  <span id="battle-status" class="sr-only">
    ${playerPokemon.name} 攻击了 ${enemyPokemon.name}，造成 ${damage} 点伤害
  </span>
</div>
```

## 5. 验收标准（可测试）

- [ ] 语音导航开关可正常开启/关闭，设置持久化到 localStorage
- [ ] 地图语音描述能正确播报精灵数量、方向、距离
- [ ] 语速、音调、音量滑块实时生效，范围符合规范
- [ ] 播报级别设置生效：full 播报所有事件，minimal 仅重要事件，critical-only 仅关键提示
- [ ] VoiceOver（iOS Safari）能正确朗读地图区域和精灵信息
- [ ] TalkBack（Android Chrome）能正确朗读地图区域和精灵信息
- [ ] 空间音频能根据精灵位置播放定位音效
- [ ] 所有交互元素有正确的 aria-label 和 tabindex
- [ ] 无键盘陷阱，Tab 键可在所有可交互元素间循环
- [ ] 单元测试覆盖率 ≥ 70%

## 6. 工作量估算

**L** - 大型需求

理由：
1. 需要新增多个核心模块（语音服务、地图描述器、空间音频）
2. 需要深度集成 Web Speech API 和 Web Audio API
3. 需要适配多个屏幕阅读器平台
4. 需要大量 ARIA 属性优化和测试
5. 预计开发时间：3-4 天

## 7. 优先级理由

**P2** - 中等优先级

1. 无障碍功能对特定用户群体（视障玩家）至关重要，体现产品包容性
2. 当前已有基础无障碍支持，此需求是增强而非基础功能
3. P0/P1 需求大多已完成，应开始推进 P2 需求
4. 有助于满足 WCAG 2.1 AA 级别标准，符合合规要求
5. 体现企业社会责任，提升品牌形象
