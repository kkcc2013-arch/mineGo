# REQ-00062：游戏音效与背景音乐系统

- **编号**：REQ-00062
- **类别**：前端体验
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、frontend/audio、game-client/src/components
- **创建时间**：2026-06-09 19:15
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 游戏客户端完全缺乏音效和背景音乐支持，影响游戏沉浸感和用户体验：

**当前状态分析**：
- `index.html` 和 `main.js` 中没有任何音频相关代码
- 捕捉、投球、点击等核心操作没有任何声音反馈
- 游戏体验显得过于"安静"，缺乏移动游戏应有的沉浸感
- 用户无法通过声音获得操作反馈和游戏状态提示

**用户影响**：
- 精灵捕捉时缺乏成就感反馈
- UI 交互缺乏响应感
- 长时间游戏容易感到单调
- 与主流 AR 手游（如 Pokémon GO）体验差距明显

## 2. 目标

构建完整的游戏音频系统，显著提升游戏沉浸感和用户满意度：

- **沉浸感提升**：通过背景音乐和场景音效营造游戏氛围
- **操作反馈**：捕捉、投球、点击等操作获得即时声音反馈
- **个性化控制**：支持音量调节、独立控制音乐/音效、静音模式
- **性能优化**：懒加载音频资源，避免影响首屏加载速度
- **无障碍兼容**：尊重系统静音设置，支持振动作为替代反馈

## 3. 范围

### 包含
- 音频管理器核心模块（AudioManager.js）
- Web Audio API 封装与兼容性处理
- 背景音乐播放系统（登录、地图、捕捉、战斗场景）
- 游戏音效库（UI、捕捉、成就、错误等 15+ 种音效）
- 音频设置面板（音量滑块、音乐/音效开关）
- 音频资源懒加载与缓存策略
- 移动端音频解锁机制（用户交互后自动启用）
- 音频状态持久化（localStorage）

### 不包含
- 语音聊天功能
- 自定义音效上传
- 多语言语音播报
- 第三方音乐平台集成

## 4. 详细需求

### 4.1 音频管理器架构

```
frontend/game-client/src/audio/
├── AudioManager.js      # 核心音频管理器
├── SoundPool.js         # 音效池管理
├── MusicPlayer.js       # 背景音乐播放器
├── AudioSettings.js     # 音频设置面板组件
├── sounds/              # 音效资源目录
│   ├── ui/
│   │   ├── click.mp3
│   │   ├── back.mp3
│   │   └── notification.mp3
│   ├── catch/
│   │   ├── throw.mp3
│   │   ├── hit.mp3
│   │   ├── caught.mp3
│   │   ├── fled.mp3
│   │   └── excellent.mp3
│   └── achievement/
│       ├── level-up.mp3
│       └── reward.mp3
└── music/
    ├── login.mp3        # 登录场景音乐
    ├── map.mp3          # 地图场景音乐
    ├── catch.mp3        # 捕捉场景音乐
    └── battle.mp3       # 战斗场景音乐
```

### 4.2 AudioManager API 设计

```javascript
class AudioManager {
  constructor() {
    this.context = null;           // AudioContext
    this.masterGain = null;        // 主音量控制
    this.musicGain = null;         // 音乐音量
    this.sfxGain = null;           // 音效音量
    this.musicPlayer = null;       // 背景音乐播放器
    this.soundPool = new Map();    // 音效缓存池
    this.settings = this.loadSettings();
  }

  // 初始化（需在用户交互后调用）
  async init() {}

  // 播放音效（支持队列防止重叠）
  async playSfx(name, options = {}) {}

  // 播放/暂停背景音乐
  async playMusic(name, { fade = true, loop = true }) {}
  pauseMusic() {}
  resumeMusic() {}

  // 音量控制
  setMasterVolume(value) {}  // 0-1
  setMusicVolume(value) {}
  setSfxVolume(value) {}

  // 静音
  toggleMute() {}
  setMuted(muted) {}

  // 预加载音效
  async preloadSounds(names) {}

  // 场景切换
  transitionToScene(sceneName) {}

  // 设置持久化
  loadSettings() {}
  saveSettings() {}
}
```

### 4.3 音效列表

| 音效名称 | 触发场景 | 文件路径 | 时长 |
|---------|---------|---------|------|
| `ui_click` | 按钮/卡片点击 | sounds/ui/click.mp3 | 0.1s |
| `ui_back` | 返回操作 | sounds/ui/back.mp3 | 0.15s |
| `ui_notification` | Toast 弹出 | sounds/ui/notification.mp3 | 0.3s |
| `ui_error` | 错误提示 | sounds/ui/error.mp3 | 0.25s |
| `catch_throw` | 投球动画开始 | sounds/catch/throw.mp3 | 0.2s |
| `catch_hit` | 球命中精灵 | sounds/catch/hit.mp3 | 0.15s |
| `catch_caught` | 捕捉成功 | sounds/catch/caught.mp3 | 1.0s |
| `catch_fled` | 精灵逃跑 | sounds/catch/fled.mp3 | 0.4s |
| `catch_excellent` | Excellent 投球 | sounds/catch/excellent.mp3 | 0.5s |
| `catch_great` | Great 投球 | sounds/catch/great.mp3 | 0.3s |
| `catch_nice` | Nice 投球 | sounds/catch/nice.mp3 | 0.2s |
| `level_up` | 等级提升 | sounds/achievement/level-up.mp3 | 1.5s |
| `reward` | 获得奖励 | sounds/achievement/reward.mp3 | 0.5s |
| `pokestop_spin` | 补给站旋转 | sounds/pokestop/spin.mp3 | 0.6s |
| `item_pickup` | 拾取道具 | sounds/item/pickup.mp3 | 0.2s |

### 4.4 背景音乐场景映射

| 场景 | 音乐文件 | 特点 | 循环 |
|------|---------|------|------|
| 登录 | music/login.mp3 | 轻快、冒险感 | 是 |
| 地图（白天） | music/map_day.mp3 | 轻松、探索感 | 是 |
| 地图（夜晚） | music/map_night.mp3 | 宁静、神秘感 | 是 |
| 捕捉 | music/catch.mp3 | 紧张、刺激 | 否 |
| 战斗 | music/battle.mp3 | 激烈、动感 | 是 |
| 道馆 | music/gym.mp3 | 史诗、庄严 | 是 |

### 4.5 音频设置面板

在用户设置页面新增音频设置区域：

```html
<div class="audio-settings">
  <div class="setting-row">
    <label>总音量</label>
    <input type="range" id="master-volume" min="0" max="100" value="80">
    <span id="master-volume-val">80%</span>
  </div>
  <div class="setting-row">
    <label>背景音乐</label>
    <input type="range" id="music-volume" min="0" max="100" value="60">
    <span id="music-volume-val">60%</span>
    <button id="music-toggle" class="toggle-btn">ON</button>
  </div>
  <div class="setting-row">
    <label>音效</label>
    <input type="range" id="sfx-volume" min="0" max="100" value="100">
    <span id="sfx-volume-val">100%</span>
    <button id="sfx-toggle" class="toggle-btn">ON</button>
  </div>
</div>
```

### 4.6 移动端音频解锁

iOS/Android 要求用户交互后才能播放音频：

```javascript
// 在首次 touch/click 时解锁音频
const unlockAudio = () => {
  if (audioManager.context?.state === 'suspended') {
    audioManager.context.resume();
  }
  // 播放一个静音的短音效以解锁
  audioManager.playSfx('_unlock', { volume: 0 });
  document.removeEventListener('touchstart', unlockAudio);
  document.removeEventListener('click', unlockAudio);
};
document.addEventListener('touchstart', unlockAudio, { once: true });
document.addEventListener('click', unlockAudio, { once: true });
```

### 4.7 性能优化策略

1. **懒加载**：音频文件按需加载，首屏不阻塞
2. **预加载关键音效**：登录后预加载常用 UI 音效
3. **音频压缩**：MP3 格式，单文件 < 200KB
4. **缓存策略**：使用 Cache API 缓存音频资源
5. **并发限制**：同时播放音效数量限制为 5 个
6. **内存管理**：长时间未使用的音效自动释放

## 5. 验收标准（可测试）

- [ ] 音频管理器模块可正常初始化，AudioContext 状态正确
- [ ] 背景音乐可在登录、地图、捕捉、战斗场景间平滑切换（淡入淡出 1s）
- [ ] 15 种音效均可正常播放，无延迟（< 50ms）
- [ ] 音量滑块实时生效，数值范围 0-100 映射到 0-1 增益
- [ ] 音乐/音效开关可独立控制静音
- [ ] 设置持久化到 localStorage，刷新页面后保持
- [ ] 移动端首次触摸后音频自动解锁
- [ ] 音频资源懒加载，首屏加载时间增加 < 100ms
- [ ] 无障碍：静音时显示振动提示（如果设备支持）
- [ ] 单元测试覆盖 AudioManager 核心方法（15+ 测试用例）

## 6. 工作量估算

**L (Large)** - 约 3-4 天工作量

理由：
- 需要设计并实现完整的音频管理架构
- 需要准备/生成 15+ 音效和 5+ 背景音乐文件
- 移动端兼容性处理较复杂（iOS/Android 解锁机制不同）
- 需要与现有 UI 组件集成
- 需要编写较完整的单元测试

## 7. 优先级理由

**P1** - 高优先级

1. **用户体验关键因素**：音效是移动游戏的基本要素，缺失严重影响沉浸感
2. **竞品对比差距**：主流 AR 手游都具备完整音频系统
3. **用户反馈预期**：声音反馈是游戏"手感"的重要组成部分
4. **技术可行性高**：Web Audio API 成熟，实现风险低
5. **对现有功能无侵入**：可独立开发，不影响现有代码
