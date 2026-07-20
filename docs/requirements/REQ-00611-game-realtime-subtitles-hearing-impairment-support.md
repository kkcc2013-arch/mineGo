# REQ-00611：游戏实时字幕与听觉障碍支持系统

- **编号**：REQ-00611
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、backend/shared/subtitles、user-service、所有音频播放模块
- **创建时间**：2026-07-20 15:00
- **依赖需求**：无

## 1. 背景与问题

mineGo 作为 AR 手游，大量游戏内容依赖音频传递信息，包括：
1. **精灵出现提示音**：不同精灵有独特音效，听力障碍玩家无法识别
2. **战斗技能音效**：技能释放、命中、躲避等关键信息依赖声音
3. **社交语音消息**：好友间可发送语音消息
4. **游戏事件提示**：活动开始、任务完成等通过声音通知
5. **环境音效**：地理位置变化、天气变化等环境反馈

当前系统缺少为听觉障碍玩家（包括聋人、重听、老年听力衰退等群体）提供视觉替代方案，违反 WCAG 2.1 AAA 级听觉无障碍标准。

## 2. 目标

建立完整的听觉障碍支持系统：

- 为所有音频内容提供实时字幕和视觉提示
- 将关键音效转换为视觉信号（闪烁、震动、图标）
- 支持语音消息转文字
- 提供可自定义的视觉反馈强度和样式
- 符合 WCAG 2.1 AAA 和 Game Accessibility Guidelines 听觉标准

**可量化目标**：
- 音频内容视觉替代覆盖率 ≥ 95%
- 字幕生成延迟 < 200ms（实时流）
- 语音转文字准确率 ≥ 90%（中文/英文）
- 用户满意度 ≥ 85%

## 3. 范围

### 包含
- 游戏内实时字幕系统
- 音效视觉化映射引擎
- 语音消息转文字服务
- 视觉提示自定义面板
- 字幕样式配置（字体、颜色、位置、背景）
- 音频事件视觉反馈（闪光、震动、图标动画）

### 不包含
- 视频内容字幕（已有独立系统）
- 第三方语音通话集成
- 手语翻译服务（未来考虑）

## 4. 详细需求

### 4.1 实时字幕系统

```javascript
// backend/shared/subtitles/RealtimeSubtitleService.js

class RealtimeSubtitleService {
  constructor() {
    this.subtitleQueue = [];
    this.displayDuration = 5000; // 默认显示 5 秒
    this.maxLines = 3; // 最多显示 3 行
    this.providers = {
      'google': new GoogleSpeechToText(),
      'azure': new AzureSpeechToText(),
      'local': new LocalWhisperModel()
    };
  }

  /**
   * 为音频流生成实时字幕
   */
  async generateSubtitles(audioStream, options = {}) {
    const {
      language = 'zh-CN',
      provider = 'google',
      enableTranslation = false,
      targetLanguage = 'en'
    } = options;

    const speechProvider = this.providers[provider];
    
    // 实时转录
    const subtitleStream = await speechProvider.streamTranscribe(audioStream, {
      language,
      interimResults: true,
      enableWordTimeOffsets: true
    });

    // 字幕处理管道
    for await (const result of subtitleStream) {
      const subtitle = {
        id: generateId(),
        text: result.transcript,
        isFinal: result.isFinal,
        confidence: result.confidence,
        words: result.words, // 单词级时间戳
        timestamp: Date.now(),
        duration: this.calculateDisplayDuration(result.transcript)
      };

      // 可选：翻译字幕
      if (enableTranslation && language !== targetLanguage) {
        subtitle.translation = await this.translateText(result.transcript, targetLanguage);
      }

      // 广播给客户端
      this.broadcastSubtitle(subtitle);

      yield subtitle;
    }
  }

  /**
   * 为预录音频生成字幕
   */
  async generateSubtitlesForFile(audioFile, options = {}) {
    const result = await this.providers[options.provider || 'google'].transcribeFile(audioFile, {
      language: options.language || 'zh-CN',
      enableWordTimeOffsets: true
    });

    // 生成分段字幕
    const subtitles = this.segmentSubtitles(result.segments, {
      maxCharsPerLine: 40,
      maxDuration: 5000
    });

    return {
      subtitles,
      fullText: result.transcript,
      language: result.language,
      duration: result.duration
    };
  }

  /**
   * 分段字幕
   */
  segmentSubtitles(segments, options) {
    const subtitles = [];
    let currentLine = '';
    let currentStartTime = 0;
    let charCount = 0;

    for (const segment of segments) {
      if (charCount === 0) {
        currentStartTime = segment.startTime;
      }

      currentLine += ' ' + segment.text;
      charCount += segment.text.length;

      // 达到行限制或时间限制
      if (charCount >= options.maxCharsPerLine || 
          segment.endTime - currentStartTime >= options.maxDuration) {
        subtitles.push({
          id: generateId(),
          text: currentLine.trim(),
          startTime: currentStartTime,
          endTime: segment.endTime,
          words: segment.words
        });
        currentLine = '';
        charCount = 0;
      }
    }

    return subtitles;
  }

  /**
   * 计算显示时长
   */
  calculateDisplayDuration(text) {
    // 基于文本长度和阅读速度计算
    const wordsPerMinute = 150; // 平均阅读速度
    const words = text.split(/\s+/).length;
    const duration = (words / wordsPerMinute) * 60000;
    return Math.max(2000, Math.min(duration, 8000));
  }
}

module.exports = RealtimeSubtitleService;
```

### 4.2 音效视觉化映射引擎

```javascript
// backend/shared/subtitles/SoundVisualizer.js

class SoundVisualizer {
  constructor() {
    // 音效到视觉提示的映射
    this.soundMappings = new Map([
      // 精灵出现
      ['pokemon_spawn_common', {
        icon: '🔔',
        color: '#4CAF50',
        animation: 'pulse',
        duration: 2000,
        vibrate: [100, 50, 100],
        flash: false,
        priority: 'low'
      }],
      ['pokemon_spawn_rare', {
        icon: '⭐',
        color: '#FFD700',
        animation: 'glow',
        duration: 3000,
        vibrate: [200, 100, 200, 100, 200],
        flash: true,
        flashColor: '#FFD700',
        priority: 'medium'
      }],
      ['pokemon_spawn_legendary', {
        icon: '🌟',
        color: '#FF6B6B',
        animation: 'rainbow',
        duration: 5000,
        vibrate: [300, 50, 300, 50, 300, 50, 300],
        flash: true,
        flashColor: '#FF6B6B',
        priority: 'high'
      }],
      
      // 战斗音效
      ['battle_skill_use', {
        icon: '⚔️',
        color: '#2196F3',
        animation: 'slide-right',
        duration: 1500,
        vibrate: [150],
        flash: false,
        priority: 'medium'
      }],
      ['battle_skill_hit', {
        icon: '💥',
        color: '#FF5722',
        animation: 'shake',
        duration: 1000,
        vibrate: [100, 50, 100],
        flash: true,
        flashColor: '#FF5722',
        priority: 'high'
      }],
      ['battle_skill_miss', {
        icon: '💨',
        color: '#9E9E9E',
        animation: 'fade-out',
        duration: 800,
        vibrate: [],
        flash: false,
        priority: 'low'
      }],
      ['battle_victory', {
        icon: '🏆',
        color: '#4CAF50',
        animation: 'bounce',
        duration: 3000,
        vibrate: [100, 50, 100, 50, 100, 200, 100],
        flash: true,
        flashColor: '#4CAF50',
        priority: 'high'
      }],
      
      // 社交通知
      ['social_message', {
        icon: '💬',
        color: '#00BCD4',
        animation: 'slide-left',
        duration: 2000,
        vibrate: [200],
        flash: false,
        priority: 'medium'
      }],
      ['social_gift', {
        icon: '🎁',
        color: '#E91E63',
        animation: 'bounce',
        duration: 2000,
        vibrate: [100, 100, 200],
        flash: false,
        priority: 'medium'
      }],
      
      // 游戏事件
      ['event_start', {
        icon: '🎉',
        color: '#9C27B0',
        animation: 'pulse',
        duration: 5000,
        vibrate: [500],
        flash: true,
        flashColor: '#9C27B0',
        priority: 'high'
      }],
      ['quest_complete', {
        icon: '✅',
        color: '#4CAF50',
        animation: 'checkmark',
        duration: 2000,
        vibrate: [100, 50, 100],
        flash: false,
        priority: 'medium'
      }],
      
      // 环境音效
      ['weather_rain', {
        icon: '🌧️',
        color: '#607D8B',
        animation: 'drizzle',
        duration: 0, // 持续显示
        vibrate: [],
        flash: false,
        priority: 'low',
        position: 'top-right'
      }],
      ['location_change', {
        icon: '📍',
        color: '#FF9800',
        animation: 'pulse',
        duration: 2000,
        vibrate: [100],
        flash: false,
        priority: 'low'
      }]
    ]);

    this.userPreferences = new Map();
  }

  /**
   * 将音效转换为视觉提示
   */
  visualizeSound(soundId, context = {}) {
    const mapping = this.soundMappings.get(soundId);
    if (!mapping) {
      // 未映射的音效，使用默认提示
      return this.getDefaultVisualization(soundId);
    }

    // 应用用户自定义
    const userPrefs = this.userPreferences.get(context.userId);
    const customized = this.applyUserPreferences(mapping, userPrefs);

    // 构建视觉提示对象
    const visual = {
      id: generateId(),
      soundId,
      icon: customized.icon,
      color: customized.color,
      animation: customized.animation,
      duration: customized.duration,
      vibrate: customized.vibrateEnabled ? customized.vibrate : [],
      flash: customized.flashEnabled ? customized.flash : false,
      flashColor: customized.flashColor,
      priority: customized.priority,
      timestamp: Date.now(),
      context
    };

    return visual;
  }

  /**
   * 应用用户偏好
   */
  applyUserPreferences(mapping, preferences) {
    if (!preferences) return mapping;

    const customized = { ...mapping };

    // 禁用震动
    if (!preferences.enableVibration) {
      customized.vibrate = [];
    }

    // 禁用闪光
    if (!preferences.enableFlash) {
      customized.flash = false;
    }

    // 自定义颜色主题
    if (preferences.colorTheme) {
      customized.color = this.applyColorTheme(mapping.color, preferences.colorTheme);
    }

    // 动画速度
    if (preferences.animationSpeed) {
      customized.duration = customized.duration / preferences.animationSpeed;
    }

    return customized;
  }

  /**
   * 获取默认可视化
   */
  getDefaultVisualization(soundId) {
    return {
      id: generateId(),
      soundId,
      icon: '🔊',
      color: '#757575',
      animation: 'fade-in',
      duration: 1500,
      vibrate: [100],
      flash: false,
      priority: 'low',
      timestamp: Date.now()
    };
  }

  /**
   * 批量可视化
   */
  visualizeSoundBatch(sounds) {
    return sounds.map(sound => this.visualizeSound(sound.id, sound.context));
  }

  /**
   * 注册自定义音效映射
   */
  registerSoundMapping(soundId, mapping) {
    this.soundMappings.set(soundId, {
      icon: mapping.icon || '🔊',
      color: mapping.color || '#757575',
      animation: mapping.animation || 'fade-in',
      duration: mapping.duration || 1500,
      vibrate: mapping.vibrate || [],
      flash: mapping.flash || false,
      flashColor: mapping.flashColor,
      priority: mapping.priority || 'low'
    });
  }

  /**
   * 设置用户偏好
   */
  setUserPreferences(userId, preferences) {
    this.userPreferences.set(userId, {
      enableVibration: preferences.enableVibration !== false,
      enableFlash: preferences.enableFlash !== false,
      colorTheme: preferences.colorTheme || 'default',
      animationSpeed: preferences.animationSpeed || 1.0,
      subtitlePosition: preferences.subtitlePosition || 'bottom',
      subtitleSize: preferences.subtitleSize || 'medium',
      showEnvironmentalSounds: preferences.showEnvironmentalSounds !== false
    });
  }
}

module.exports = SoundVisualizer;
```

### 4.3 语音消息转文字服务

```javascript
// backend/shared/subtitles/VoiceMessageTranscription.js

const speech = require('@google-cloud/speech');
const translate = require('@google-cloud/translate');

class VoiceMessageTranscription {
  constructor() {
    this.speechClient = new speech.SpeechClient();
    this.translateClient = new translate.TranslationServiceClient();
    this.supportedLanguages = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];
  }

  /**
   * 转录语音消息
   */
  async transcribeVoiceMessage(voiceBuffer, options = {}) {
    const {
      language = 'zh-CN',
      enableTranslation = false,
      targetLanguage = 'en',
      userId
    } = options;

    const startTime = Date.now();

    try {
      // 1. 语音转文字
      const [response] = await this.speechClient.recognize({
        audio: { content: voiceBuffer.toString('base64') },
        config: {
          encoding: 'OGG_OPUS',
          sampleRateHertz: 16000,
          languageCode: language,
          enableAutomaticPunctuation: true,
          enableWordTimeOffsets: true,
          model: 'latest_long'
        }
      });

      const transcript = response.results
        .map(result => result.alternatives[0].transcript)
        .join(' ');

      const confidence = response.results[0]?.alternatives[0]?.confidence || 0;

      // 2. 可选翻译
      let translation = null;
      if (enableTranslation && language !== targetLanguage) {
        translation = await this.translateText(transcript, language, targetLanguage);
      }

      // 3. 检测情感和关键词
      const sentiment = await this.detectSentiment(transcript, language);
      const keywords = this.extractKeywords(transcript);

      const result = {
        id: generateId(),
        userId,
        transcript,
        confidence,
        language,
        translation,
        sentiment,
        keywords,
        duration: response.totalBilledTime?.seconds || 0,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };

      // 保存到数据库
      await this.saveTranscription(result);

      return result;
    } catch (error) {
      console.error('Voice transcription error:', error);
      throw error;
    }
  }

  /**
   * 翻译文本
   */
  async translateText(text, sourceLanguage, targetLanguage) {
    const [response] = await this.translateClient.translateText({
      parent: `projects/${process.env.GOOGLE_PROJECT_ID}/locations/global`,
      contents: [text],
      mimeType: 'text/plain',
      sourceLanguageCode: sourceLanguage.split('-')[0],
      targetLanguageCode: targetLanguage
    });

    return response.translations[0].translatedText;
  }

  /**
   * 情感检测
   */
  async detectSentiment(text, language) {
    const languageClient = require('@google-cloud/language').v1.LanguageServiceClient;
    const client = new languageClient();

    const [result] = await client.analyzeSentiment({
      document: {
        content: text,
        type: 'PLAIN_TEXT',
        language: language.split('-')[0]
      }
    });

    const sentiment = result.documentSentiment;
    return {
      score: sentiment.score, // -1.0 to 1.0
      magnitude: sentiment.magnitude, // 0.0 to +inf
      label: this.getSentimentLabel(sentiment.score)
    };
  }

  /**
   * 获取情感标签
   */
  getSentimentLabel(score) {
    if (score >= 0.25) return 'positive';
    if (score <= -0.25) return 'negative';
    return 'neutral';
  }

  /**
   * 提取关键词
   */
  extractKeywords(text) {
    // 简单的关键词提取（实际应用可使用 NLP 库）
    const stopWords = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那']);
    const words = text.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));
    return [...new Set(words)].slice(0, 5);
  }

  /**
   * 保存转录记录
   */
  async saveTranscription(result) {
    // 保存到数据库供后续查询
    const query = `
      INSERT INTO voice_transcriptions 
      (id, user_id, transcript, confidence, language, translation, sentiment, keywords, duration, processing_time, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;
    
    await db.query(query, [
      result.id,
      result.userId,
      result.transcript,
      result.confidence,
      result.language,
      result.translation,
      JSON.stringify(result.sentiment),
      JSON.stringify(result.keywords),
      result.duration,
      result.processingTime,
      result.timestamp
    ]);
  }
}

module.exports = VoiceMessageTranscription;
```

### 4.4 客户端字幕显示组件

```javascript
// frontend/game-client/src/components/SubtitleDisplay.js

class SubtitleDisplay {
  constructor(options = {}) {
    this.container = this.createContainer(options);
    this.subtitleQueue = [];
    this.currentSubtitles = [];
    this.maxLines = options.maxLines || 3;
    this.style = {
      position: options.position || 'bottom',
      fontSize: options.fontSize || '18px',
      fontFamily: options.fontFamily || 'Arial, sans-serif',
      backgroundColor: options.backgroundColor || 'rgba(0, 0, 0, 0.7)',
      textColor: options.textColor || '#FFFFFF',
      padding: options.padding || '10px 15px',
      borderRadius: options.borderRadius || '5px',
      opacity: options.opacity || 0.95
    };
    
    this.applyStyles();
    this.startRenderLoop();
  }

  /**
   * 创建字幕容器
   */
  createContainer(options) {
    const container = document.createElement('div');
    container.id = 'subtitle-display';
    container.className = 'subtitle-container';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', '实时字幕');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
  }

  /**
   * 应用样式
   */
  applyStyles() {
    Object.assign(this.container.style, {
      position: 'fixed',
      left: this.style.position === 'bottom' ? '50%' : '10px',
      bottom: this.style.position === 'bottom' ? '80px' : 'auto',
      top: this.style.position === 'top' ? '80px' : 'auto',
      transform: this.style.position === 'bottom' ? 'translateX(-50%)' : 'none',
      zIndex: '9999',
      fontSize: this.style.fontSize,
      fontFamily: this.style.fontFamily,
      color: this.style.textColor,
      backgroundColor: this.style.backgroundColor,
      padding: this.style.padding,
      borderRadius: this.style.borderRadius,
      opacity: this.style.opacity,
      maxWidth: '80%',
      textAlign: 'center',
      pointerEvents: 'none',
      transition: 'opacity 0.3s ease'
    });
  }

  /**
   * 添加字幕
   */
  addSubtitle(subtitle) {
    this.subtitleQueue.push({
      ...subtitle,
      addedAt: Date.now()
    });

    // 如果是实时字幕，立即显示
    if (subtitle.isRealtime) {
      this.renderSubtitles();
    }
  }

  /**
   * 渲染字幕
   */
  renderSubtitles() {
    const now = Date.now();
    
    // 过滤过期字幕
    this.currentSubtitles = this.currentSubtitles.filter(s => {
      return now - s.addedAt < s.duration;
    });

    // 添加新字幕（保持最大行数限制）
    while (this.currentSubtitles.length < this.maxLines && this.subtitleQueue.length > 0) {
      this.currentSubtitles.push(this.subtitleQueue.shift());
    }

    // 渲染到 DOM
    if (this.currentSubtitles.length > 0) {
      const html = this.currentSubtitles.map((s, index) => {
        const isNew = now - s.addedAt < 500;
        const opacity = this.calculateOpacity(s, now);
        
        return `
          <div class="subtitle-line ${isNew ? 'subtitle-new' : ''}" 
               style="opacity: ${opacity}; margin-bottom: ${index < this.currentSubtitles.length - 1 ? '8px' : '0'}">
            ${this.escapeHtml(s.text)}
            ${s.translation ? `<div class="subtitle-translation" style="font-size: 0.9em; opacity: 0.8; margin-top: 4px">[${s.translation}]</div>` : ''}
          </div>
        `;
      }).join('');

      this.container.innerHTML = html;
      this.container.style.display = 'block';
    } else {
      this.container.style.display = 'none';
    }
  }

  /**
   * 计算透明度（淡出效果）
   */
  calculateOpacity(subtitle, now) {
    const age = now - subtitle.addedAt;
    const remaining = subtitle.duration - age;
    
    // 最后 500ms 淡出
    if (remaining < 500) {
      return remaining / 500;
    }
    
    return 1.0;
  }

  /**
   * HTML 转义
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * 开始渲染循环
   */
  startRenderLoop() {
    this.renderInterval = setInterval(() => {
      if (this.currentSubtitles.length > 0) {
        this.renderSubtitles();
      }
    }, 100);
  }

  /**
   * 清除所有字幕
   */
  clear() {
    this.subtitleQueue = [];
    this.currentSubtitles = [];
    this.container.innerHTML = '';
    this.container.style.display = 'none';
  }

  /**
   * 更新样式
   */
  updateStyle(newStyle) {
    Object.assign(this.style, newStyle);
    this.applyStyles();
  }

  /**
   * 销毁
   */
  destroy() {
    clearInterval(this.renderInterval);
    this.container.remove();
  }
}

export default SubtitleDisplay;
```

### 4.5 音效视觉化显示组件

```javascript
// frontend/game-client/src/components/SoundVisualDisplay.js

class SoundVisualDisplay {
  constructor(options = {}) {
    this.container = this.createContainer();
    this.activeVisuals = new Map();
    this.soundVisualizer = options.soundVisualizer;
    this.enableVibration = options.enableVibration !== false;
    this.enableFlash = options.enableFlash !== false;
  }

  /**
   * 创建容器
   */
  createContainer() {
    const container = document.createElement('div');
    container.id = 'sound-visual-display';
    container.className = 'sound-visual-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'assertive');
    document.body.appendChild(container);
    return container;
  }

  /**
   * 显示音效视觉化
   */
  showSoundVisualization(visual) {
    const element = this.createVisualElement(visual);
    
    // 添加到容器
    this.container.appendChild(element);
    this.activeVisuals.set(visual.id, element);

    // 触发震动
    if (this.enableVibration && visual.vibrate.length > 0 && navigator.vibrate) {
      navigator.vibrate(visual.vibrate);
    }

    // 触发屏幕闪光
    if (this.enableFlash && visual.flash) {
      this.triggerFlash(visual.flashColor);
    }

    // 设置自动移除
    if (visual.duration > 0) {
      setTimeout(() => {
        this.removeVisual(visual.id);
      }, visual.duration);
    }

    // 屏幕阅读器通知
    this.announceToScreenReader(visual);
  }

  /**
   * 创建视觉元素
   */
  createVisualElement(visual) {
    const element = document.createElement('div');
    element.className = `sound-visual ${visual.animation}`;
    element.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 48px;
      color: ${visual.color};
      z-index: 10000;
      animation: ${visual.animation} ${visual.duration}ms ease-out;
      text-shadow: 0 0 10px ${visual.color};
    `;
    element.textContent = visual.icon;
    element.setAttribute('aria-hidden', 'true');

    return element;
  }

  /**
   * 触发屏幕闪光
   */
  triggerFlash(color) {
    const flash = document.createElement('div');
    flash.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: ${color};
      opacity: 0;
      z-index: 9999;
      pointer-events: none;
      animation: flash 300ms ease-out;
    `;
    
    document.body.appendChild(flash);
    
    setTimeout(() => flash.remove(), 300);
  }

  /**
   * 移除视觉元素
   */
  removeVisual(visualId) {
    const element = this.activeVisuals.get(visualId);
    if (element) {
      element.style.animation = 'fade-out 300ms ease-out';
      setTimeout(() => {
        element.remove();
        this.activeVisuals.delete(visualId);
      }, 300);
    }
  }

  /**
   * 通知屏幕阅读器
   */
  announceToScreenReader(visual) {
    const announcement = document.createElement('div');
    announcement.setAttribute('role', 'alert');
    announcement.setAttribute('aria-live', 'polite');
    announcement.className = 'sr-only';
    announcement.textContent = this.getSoundDescription(visual);
    
    document.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  /**
   * 获取音效描述
   */
  getSoundDescription(visual) {
    const descriptions = {
      'pokemon_spawn_common': '常见精灵出现',
      'pokemon_spawn_rare': '稀有精灵出现',
      'pokemon_spawn_legendary': '传说精灵出现',
      'battle_skill_use': '使用技能',
      'battle_skill_hit': '技能命中',
      'battle_victory': '战斗胜利',
      'social_message': '收到新消息',
      'event_start': '活动开始'
    };
    
    return descriptions[visual.soundId] || '音效提示';
  }

  /**
   * 清除所有视觉元素
   */
  clearAll() {
    this.activeVisuals.forEach((element, id) => {
      this.removeVisual(id);
    });
  }
}

// 添加 CSS 动画
const style = document.createElement('style');
style.textContent = `
  @keyframes pulse {
    0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    50% { transform: translate(-50%, -50%) scale(1.2); opacity: 0.8; }
  }
  
  @keyframes glow {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(1.5); }
  }
  
  @keyframes shake {
    0%, 100% { transform: translate(-50%, -50%) rotate(0deg); }
    25% { transform: translate(-50%, -50%) rotate(-10deg); }
    75% { transform: translate(-50%, -50%) rotate(10deg); }
  }
  
  @keyframes bounce {
    0%, 100% { transform: translate(-50%, -50%) translateY(0); }
    50% { transform: translate(-50%, -50%) translateY(-20px); }
  }
  
  @keyframes fade-out {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  
  @keyframes flash {
    0% { opacity: 0.3; }
    100% { opacity: 0; }
  }
  
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
`;
document.head.appendChild(style);

export default SoundVisualDisplay;
```

### 4.6 用户偏好配置 API

```javascript
// backend/gateway/src/routes/hearingAccessibilityRoutes.js

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const HearingAccessibilityService = require('../../../shared/subtitles/HearingAccessibilityService');

const service = new HearingAccessibilityService();

/**
 * 获取用户听觉无障碍配置
 */
router.get('/config', authenticate, async (req, res) => {
  try {
    const config = await service.getUserConfig(req.user.id);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get config' });
  }
});

/**
 * 更新用户配置
 */
router.put('/config', authenticate, async (req, res) => {
  try {
    const config = await service.updateUserConfig(req.user.id, req.body);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

/**
 * 转录语音消息
 */
router.post('/transcribe', authenticate, async (req, res) => {
  try {
    const { voiceBuffer, language, enableTranslation, targetLanguage } = req.body;
    const result = await service.transcribeVoiceMessage(voiceBuffer, {
      language,
      enableTranslation,
      targetLanguage,
      userId: req.user.id
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Transcription failed' });
  }
});

/**
 * 获取字幕样式预设
 */
router.get('/subtitle-presets', authenticate, async (req, res) => {
  const presets = [
    {
      id: 'default',
      name: '默认',
      fontSize: '18px',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      textColor: '#FFFFFF'
    },
    {
      id: 'large',
      name: '大字体',
      fontSize: '24px',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      textColor: '#FFFFFF'
    },
    {
      id: 'high-contrast',
      name: '高对比度',
      fontSize: '20px',
      backgroundColor: '#000000',
      textColor: '#FFFF00'
    },
    {
      id: 'transparent',
      name: '透明背景',
      fontSize: '18px',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      textColor: '#FFFFFF',
      textShadow: '2px 2px 4px rgba(0, 0, 0, 1)'
    }
  ];
  
  res.json(presets);
});

/**
 * 获取音效映射列表
 */
router.get('/sound-mappings', authenticate, async (req, res) => {
  const mappings = await service.getSoundMappings();
  res.json(mappings);
});

/**
 * 自定义音效映射
 */
router.post('/sound-mappings', authenticate, async (req, res) => {
  try {
    const mapping = await service.createCustomSoundMapping(req.user.id, req.body);
    res.json(mapping);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create mapping' });
  }
});

module.exports = router;
```

## 5. 验收标准（可测试）

- [ ] **实时字幕**
  - [ ] 字幕生成延迟 < 200ms
  - [ ] 支持中英日韩多语言
  - [ ] 字幕自动分段和显示时长合理
  - [ ] 字幕样式可自定义（字体、颜色、位置）

- [ ] **音效视觉化**
  - [ ] 所有游戏音效都有对应的视觉提示
  - [ ] 视觉提示包含图标、动画、颜色、闪光
  - [ ] 支持震动反馈（移动设备）
  - [ ] 屏幕闪光效果可开关

- [ ] **语音消息转文字**
  - [ ] 语音转文字准确率 ≥ 90%
  - [ ] 支持自动翻译
  - [ ] 处理时间 < 2s（10秒语音）
  - [ ] 情感检测功能正常

- [ ] **用户偏好**
  - [ ] 字幕样式可自定义
  - [ ] 视觉提示强度可调节
  - [ ] 震动和闪光可单独开关
  - [ ] 配置持久化保存

- [ ] **无障碍合规**
  - [ ] WCAG 2.1 AAA 级听觉标准合规
  - [ ] 所有功能可通过键盘访问
  - [ ] 屏幕阅读器兼容

- [ ] **测试覆盖