# REQ-00411：游戏语音内容本地化与音频翻译管理系统

- **编号**：REQ-00411
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：pokemon-service、user-service、reward-service、gateway、game-client、backend/shared/audioLocalization、backend/jobs、database/migrations、cdn
- **创建时间**：2026-07-01 13:05
- **依赖需求**：REQ-00011（多语言国际化支持）、REQ-00294（动态语言切换）

## 1. 背景与问题

mineGo 游戏包含大量语音内容：精灵叫声、NPC 对话、战斗提示音、任务引导语音等。当前 i18n 模块仅支持文本翻译，缺乏对音频文件的本地化管理能力。

**核心问题**：
- 游戏内语音文件仅支持单一语言（英语），无法根据玩家语言设置自动切换
- 语音文件分散存储在各服务中，缺乏统一的管理系统和版本控制
- 新增语言时需要手动处理音频文件上传、格式转换、CDN 分发，流程低效
- 缺乏语音文件与文本翻译的同步机制，容易导致翻译不一致
- 音频文件缺乏智能压缩和自适应码率，影响加载速度和带宽成本
- 缺乏语音内容的翻译状态跟踪和质量审核流程

**影响范围**：
- 国际用户体验差：非英语玩家听到不匹配的语音内容
- 运营成本高：每次新增语言需要手动处理数百个音频文件
- 内容不一致：语音与文本翻译可能不同步
- 加载性能差：所有用户下载相同大小的音频文件

## 2. 目标

构建完整的游戏语音内容本地化管理系统，实现：
- **多语言语音切换**：根据玩家语言设置自动加载对应语音文件
- **统一管理平台**：集中管理所有语音文件的翻译、审核、发布流程
- **智能 CDN 分发**：基于用户地理位置和语言选择最优 CDN 节点
- **自动格式转换**：支持多格式音频文件（MP3、OGG、AAC）的自动转换和优化
- **翻译状态同步**：语音翻译与文本翻译关联，确保一致性
- **质量审核流程**：内置翻译审核、质量评分、玩家反馈机制
- **性能优化**：自适应码率、预加载、缓存策略，提升加载速度

## 3. 范围

### 包含
- 语音文件元数据管理系统（数据库表设计、API 接口）
- 多语言音频文件存储与 CDN 集成
- 音频格式自动转换服务（FFmpeg 集成）
- 游戏客户端音频加载器（支持语言切换、预加载、缓存）
- 翻译审核工作流（翻译状态、审核队列、质量评分）
- 音频文件版本控制系统（热更新、灰度发布）
- 管理后台音频管理界面（上传、编辑、审核、发布）
- 性能监控与告警（加载时间、带宽使用、错误率）

### 不包含
- 语音合成（TTS）功能（属于 REQ-00062 游戏音效系统）
- 实时语音聊天翻译（属于 REQ-00116 语音聊天系统）
- 用户生成内容（UGC）音频审核（属于独立需求）
- 音乐文件本地化（背景音乐通常不需要翻译）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 语音文件主表
CREATE TABLE audio_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL UNIQUE,           -- 唯一标识符，如 'pokemon.001.cry'
  category VARCHAR(100) NOT NULL,             -- 分类：pokemon_cry, npc_dialogue, battle_hint, quest_guide
  context JSONB DEFAULT '{}',                 -- 上下文信息：精灵ID、NPC ID等
  duration_seconds DECIMAL(6,2),              -- 时长
  file_size_bytes INTEGER,                    -- 文件大小
  formats JSONB DEFAULT '{}',                 -- 支持的格式：{"mp3": "url", "ogg": "url", "aac": "url"}
  default_locale VARCHAR(10) NOT NULL,        -- 默认语言
  status VARCHAR(20) DEFAULT 'draft',         -- draft, pending_review, approved, published
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP
);

-- 语音翻译表
CREATE TABLE audio_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_file_id UUID NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
  locale VARCHAR(10) NOT NULL,                -- 语言代码
  text_transcript TEXT,                       -- 文字转录（用于字幕、搜索）
  text_translation_key VARCHAR(255),          -- 关联的文本翻译键
  file_url VARCHAR(500),                      -- 音频文件 URL
  file_format VARCHAR(20),                    -- 文件格式
  file_size_bytes INTEGER,
  duration_seconds DECIMAL(6,2),
  checksum VARCHAR(64),                       -- 文件校验和
  translator_id UUID,                         -- 翻译者 ID
  reviewer_id UUID,                           -- 审核者 ID
  quality_score DECIMAL(3,2),                 -- 质量评分 0-5
  status VARCHAR(20) DEFAULT 'pending',       -- pending, in_review, approved, rejected
  rejection_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(audio_file_id, locale)
);

-- 音频使用记录表（性能监控）
CREATE TABLE audio_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_file_id UUID REFERENCES audio_files(id),
  locale VARCHAR(10),
  user_id UUID,
  device_type VARCHAR(50),
  load_time_ms INTEGER,
  cache_hit BOOLEAN DEFAULT FALSE,
  error_code VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_audio_files_category ON audio_files(category);
CREATE INDEX idx_audio_files_status ON audio_files(status);
CREATE INDEX idx_audio_translations_locale ON audio_translations(locale);
CREATE INDEX idx_audio_translations_status ON audio_translations(status);
CREATE INDEX idx_audio_usage_logs_created_at ON audio_usage_logs(created_at);
```

### 4.2 核心模块设计

#### 4.2.1 AudioLocalizationManager（backend/shared/audioLocalization/manager.js）

```javascript
class AudioLocalizationManager {
  constructor() {
    this.audioFileModel = new AudioFileModel();
    this.translationModel = new AudioTranslationModel();
    this.formatConverter = new AudioFormatConverter();
    this.cdnManager = new CDNManager();
    this.cacheManager = new AudioCacheManager();
  }

  /**
   * 获取指定语言的音频文件
   * @param {string} key - 音频文件标识符
   * @param {string} locale - 语言代码
   * @param {object} options - 选项：format, quality
   * @returns {object} - 音频文件信息
   */
  async getAudio(key, locale, options = {}) {
    const { format = 'mp3', quality = 'standard' } = options;
    
    // 1. 检查缓存
    const cacheKey = `audio:${key}:${locale}:${format}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;
    
    // 2. 查询音频文件
    const audioFile = await this.audioFileModel.findByKey(key);
    if (!audioFile || audioFile.status !== 'published') {
      throw new Error(`Audio file not found or not published: ${key}`);
    }
    
    // 3. 查询翻译
    let translation = await this.translationModel.findByAudioAndLocale(audioFile.id, locale);
    
    // 4. 回退到默认语言
    if (!translation || translation.status !== 'approved') {
      translation = await this.translationModel.findByAudioAndLocale(
        audioFile.id, 
        audioFile.default_locale
      );
    }
    
    // 5. 返回最优格式
    const audioData = {
      id: audioFile.id,
      key: audioFile.key,
      locale: translation?.locale || audioFile.default_locale,
      url: this.getOptimalUrl(translation, format, quality),
      duration: translation?.duration_seconds || audioFile.duration_seconds,
      transcript: translation?.text_transcript,
      format,
      quality
    };
    
    // 6. 写入缓存
    await this.cacheManager.set(cacheKey, audioData, 3600);
    
    return audioData;
  }

  /**
   * 批量获取音频文件（预加载）
   */
  async getBatchAudio(keys, locale, options = {}) {
    const results = await Promise.allSettled(
      keys.map(key => this.getAudio(key, locale, options))
    );
    
    return results.map((result, index) => ({
      key: keys[index],
      success: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason.message : null
    }));
  }

  /**
   * 上传音频文件
   */
  async uploadAudio(file, metadata) {
    const { key, category, context, locale } = metadata;
    
    // 1. 验证文件格式
    const validFormats = ['audio/mpeg', 'audio/ogg', 'audio/aac'];
    if (!validFormats.includes(file.mimetype)) {
      throw new Error(`Invalid audio format: ${file.mimetype}`);
    }
    
    // 2. 转换格式
    const convertedFiles = await this.formatConverter.convert(file, ['mp3', 'ogg', 'aac']);
    
    // 3. 上传到 CDN
    const cdnUrls = await this.cdnManager.uploadBatch(convertedFiles, {
      folder: `audio/${category}/${key}`,
      locale
    });
    
    // 4. 保存到数据库
    const audioFile = await this.audioFileModel.create({
      key,
      category,
      context,
      default_locale: locale,
      formats: cdnUrls,
      status: 'draft'
    });
    
    return audioFile;
  }

  /**
   * 提交翻译
   */
  async submitTranslation(audioFileId, locale, translationData) {
    const { file, textTranscript, textTranslationKey, translatorId } = translationData;
    
    // 1. 上传音频文件
    const cdnUrl = await this.cdnManager.upload(file, {
      folder: `audio/translations/${locale}`,
      locale
    });
    
    // 2. 获取文件信息
    const fileInfo = await this.formatConverter.getFileInfo(file);
    
    // 3. 创建翻译记录
    const translation = await this.translationModel.create({
      audio_file_id: audioFileId,
      locale,
      text_transcript: textTranscript,
      text_translation_key: textTranslationKey,
      file_url: cdnUrl,
      file_format: fileInfo.format,
      file_size_bytes: fileInfo.size,
      duration_seconds: fileInfo.duration,
      translator_id: translatorId,
      status: 'pending'
    });
    
    return translation;
  }

  /**
   * 审核翻译
   */
  async reviewTranslation(translationId, reviewData) {
    const { reviewerId, approved, qualityScore, rejectionReason } = reviewData;
    
    const updateData = {
      reviewer_id: reviewerId,
      quality_score: qualityScore,
      status: approved ? 'approved' : 'rejected',
      rejection_reason: approved ? null : rejectionReason
    };
    
    const translation = await this.translationModel.update(translationId, updateData);
    
    // 如果审核通过，检查是否所有语言都已就绪
    if (approved) {
      await this.checkAndUpdateAudioFileStatus(translation.audio_file_id);
    }
    
    return translation;
  }
}
```

#### 4.2.2 AudioFormatConverter（backend/shared/audioLocalization/formatConverter.js）

```javascript
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const { createLogger } = require('../logger');

const logger = createLogger('audio-format-converter');

class AudioFormatConverter {
  constructor() {
    this.supportedFormats = ['mp3', 'ogg', 'aac'];
    this.qualityPresets = {
      high: { bitrate: '192k', sampleRate: 48000 },
      standard: { bitrate: '128k', sampleRate: 44100 },
      low: { bitrate: '64k', sampleRate: 22050 }
    };
  }

  /**
   * 转换音频格式
   */
  async convert(inputFile, targetFormats, quality = 'standard') {
    const preset = this.qualityPresets[quality];
    const results = {};
    
    const inputPath = typeof inputFile === 'string' ? inputFile : inputFile.path;
    
    for (const format of targetFormats) {
      if (!this.supportedFormats.includes(format)) {
        logger.warn(`Unsupported format: ${format}`);
        continue;
      }
      
      const outputPath = `${inputPath}.${format}`;
      
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .audioBitrate(preset.bitrate)
            .audioFrequency(preset.sampleRate)
            .audioChannels(2)
            .format(format)
            .on('error', reject)
            .on('end', resolve)
            .save(outputPath);
        });
        
        const stats = await fs.stat(outputPath);
        results[format] = {
          path: outputPath,
          size: stats.size
        };
        
        logger.info({ format, size: stats.size }, 'Audio converted successfully');
      } catch (err) {
        logger.error({ err, format }, 'Failed to convert audio');
        throw err;
      }
    }
    
    return results;
  }

  /**
   * 获取音频文件信息
   */
  async getFileInfo(inputFile) {
    const inputPath = typeof inputFile === 'string' ? inputFile : inputFile.path;
    
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(err);
        
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
        
        resolve({
          format: metadata.format.format_name,
          duration: parseFloat(metadata.format.duration),
          size: parseInt(metadata.format.size),
          bitrate: parseInt(metadata.format.bit_rate),
          sampleRate: audioStream?.sample_rate,
          channels: audioStream?.channels
        });
      });
    });
  }

  /**
   * 生成音频波形图（用于可视化）
   */
  async generateWaveform(inputFile, options = {}) {
    const { width = 800, height = 100, color = '#00ff00' } = options;
    const outputPath = `${inputFile}.waveform.png`;
    
    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .complex_filter([
          `aformat=channel_layouts=mono`,
          `showwavespic=s=${width}x${height}:colors=${color}`
        ])
        .on('error', reject)
        .on('end', resolve)
        .save(outputPath);
    });
    
    return outputPath;
  }
}
```

#### 4.2.3 AudioCacheManager（backend/shared/audioLocalization/cacheManager.js）

```javascript
const Redis = require('ioredis');
const { createLogger } = require('../logger');

const logger = createLogger('audio-cache-manager');

class AudioCacheManager {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.prefix = 'audio:cache:';
    this.ttl = 3600; // 1 小时
  }

  /**
   * 获取缓存
   */
  async get(key) {
    const cacheKey = this.prefix + key;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      logger.debug({ key }, 'Audio cache hit');
      return JSON.parse(cached);
    }
    
    logger.debug({ key }, 'Audio cache miss');
    return null;
  }

  /**
   * 设置缓存
   */
  async set(key, value, ttl = this.ttl) {
    const cacheKey = this.prefix + key;
    await this.redis.setex(cacheKey, ttl, JSON.stringify(value));
    logger.debug({ key, ttl }, 'Audio cached');
  }

  /**
   * 清除缓存
   */
  async clear(pattern = '*') {
    const keys = await this.redis.keys(this.prefix + pattern);
    if (keys.length > 0) {
      await this.redis.del(keys);
      logger.info({ count: keys.length }, 'Audio cache cleared');
    }
  }
}
```

### 4.3 API 接口设计

#### 4.3.1 获取音频文件
```http
GET /api/v1/audio/:key
Query Parameters:
  - locale: string (可选，默认使用用户语言)
  - format: string (可选，mp3/ogg/aac，默认 mp3)
  - quality: string (可选，high/standard/low，默认 standard)

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "key": "pokemon.001.cry",
    "locale": "zh-CN",
    "url": "https://cdn.example.com/audio/pokemon/001/zh-CN.mp3",
    "duration": 2.5,
    "transcript": "皮卡丘！",
    "format": "mp3",
    "quality": "standard",
    "cacheKey": "audio:pokemon.001.cry:zh-CN:mp3"
  }
}
```

#### 4.3.2 批量获取音频（预加载）
```http
POST /api/v1/audio/batch
Request Body:
{
  "keys": ["pokemon.001.cry", "pokemon.002.cry", "battle.victory"],
  "locale": "zh-CN",
  "format": "mp3",
  "quality": "standard"
}

Response:
{
  "success": true,
  "data": [
    {
      "key": "pokemon.001.cry",
      "success": true,
      "data": { ... }
    },
    ...
  ],
  "stats": {
    "total": 3,
    "success": 3,
    "failed": 0
  }
}
```

#### 4.3.3 上传音频文件（管理员）
```http
POST /api/v1/admin/audio/upload
Content-Type: multipart/form-data

Request Body:
  - file: audio file
  - key: string (唯一标识符)
  - category: string (分类)
  - context: json (上下文信息)
  - locale: string (默认语言)

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "key": "pokemon.025.cry",
    "category": "pokemon_cry",
    "status": "draft",
    "formats": {
      "mp3": "https://cdn.example.com/audio/pokemon/025/mp3",
      "ogg": "https://cdn.example.com/audio/pokemon/025/ogg",
      "aac": "https://cdn.example.com/audio/pokemon/025/aac"
    }
  }
}
```

#### 4.3.4 提交翻译
```http
POST /api/v1/admin/audio/:audioFileId/translations
Content-Type: multipart/form-data

Request Body:
  - file: audio file
  - locale: string
  - textTranscript: string (文字转录)
  - textTranslationKey: string (关联文本翻译键)

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "audio_file_id": "uuid",
    "locale": "ja-JP",
    "status": "pending"
  }
}
```

#### 4.3.5 审核翻译（管理员）
```http
POST /api/v1/admin/audio/translations/:translationId/review
Request Body:
{
  "approved": true,
  "qualityScore": 4.5,
  "rejectionReason": null
}

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "approved",
    "quality_score": 4.5
  }
}
```

### 4.4 游戏客户端集成

#### 4.4.1 AudioManager（frontend/game-client/src/audio/AudioManager.js）

```javascript
class AudioManager {
  constructor() {
    this.cache = new Map();
    this.preloadQueue = [];
    this.currentLocale = 'en-US';
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  /**
   * 初始化音频管理器
   */
  async init() {
    // 1. 获取用户语言设置
    const userLocale = await this.getUserLocale();
    this.currentLocale = userLocale;
    
    // 2. 预加载常用音频
    await this.preloadCommon();
    
    // 3. 监听语言切换事件
    document.addEventListener('localeChanged', (e) => {
      this.onLocaleChanged(e.detail.locale);
    });
  }

  /**
   * 播放音频
   */
  async play(key, options = {}) {
    const { locale = this.currentLocale, volume = 1.0, loop = false } = options;
    
    // 1. 检查缓存
    const cacheKey = `${key}:${locale}`;
    let audioData = this.cache.get(cacheKey);
    
    // 2. 从服务器加载
    if (!audioData) {
      audioData = await this.loadAudio(key, locale);
      this.cache.set(cacheKey, audioData);
    }
    
    // 3. 创建音频元素
    const audio = new Audio(audioData.url);
    audio.volume = volume;
    audio.loop = loop;
    
    // 4. 播放
    await audio.play();
    
    // 5. 记录使用日志
    this.logUsage(key, locale, audioData.loadTime);
    
    return audio;
  }

  /**
   * 加载音频
   */
  async loadAudio(key, locale) {
    const startTime = Date.now();
    
    const response = await fetch(
      `/api/v1/audio/${key}?locale=${locale}&format=mp3&quality=standard`
    );
    
    const result = await response.json();
    
    return {
      ...result.data,
      loadTime: Date.now() - startTime
    };
  }

  /**
   * 批量预加载
   */
  async preload(keys, locale = this.currentLocale) {
    const response = await fetch('/api/v1/audio/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, locale, format: 'mp3', quality: 'standard' })
    });
    
    const result = await response.json();
    
    // 缓存所有音频
    for (const item of result.data) {
      if (item.success) {
        const cacheKey = `${item.key}:${locale}`;
        this.cache.set(cacheKey, item.data);
      }
    }
    
    return result;
  }

  /**
   * 语言切换处理
   */
  async onLocaleChanged(newLocale) {
    this.currentLocale = newLocale;
    
    // 清空缓存，重新加载
    this.cache.clear();
    
    // 预加载新语言的常用音频
    await this.preloadCommon();
  }

  /**
   * 预加载常用音频
   */
  async preloadCommon() {
    const commonKeys = [
      'ui.click',
      'ui.success',
      'ui.error',
      'battle.victory',
      'battle.defeat',
      'catch.success'
    ];
    
    await this.preload(commonKeys);
  }
}
```

### 4.5 性能优化

#### 4.5.1 自适应码率
- 根据用户网络状况自动选择合适的音频质量
- 高速网络：high quality (192kbps)
- 普通网络：standard quality (128kbps)
- 弱网环境：low quality (64kbps)

#### 4.5.2 CDN 优化
- 基于用户地理位置选择最近的 CDN 节点
- 支持 HTTP/2 和 Range 请求（部分加载）
- 自动缓存预热

#### 4.5.3 预加载策略
- 启动时预加载常用音频（UI 音效、战斗提示音）
- 进入场景前预加载场景相关音频（精灵叫声、NPC 对话）
- 后台预加载下一关卡音频

## 5. 验收标准（可测试）

- [ ] 管理员可通过 API 上传音频文件，系统自动生成多种格式
- [ ] 游戏客户端可根据用户语言设置自动加载对应语音文件
- [ ] 当请求的语言不存在时，系统自动回退到默认语言
- [ ] 音频文件支持批量预加载，加载时间 < 500ms（缓存命中）
- [ ] 翻译审核工作流完整：提交 → 待审核 → 审核通过/拒绝
- [ ] 音频文件支持热更新，无需重启服务
- [ ] 性能监控完整：加载时间、缓存命中率、错误率
- [ ] CDN 集成完成，支持多节点分发
- [ ] 游戏客户端支持语言切换，音频自动更新
- [ ] 管理后台界面完整：上传、编辑、审核、发布、统计

## 6. 工作量估算

**L** (Large)

**理由**：
- 需要设计完整的数据库表结构（3 张表）
- 实现多个核心模块（Manager、Converter、CacheManager、CDNManager）
- 集成 FFmpeg 进行音频格式转换
- 开发管理后台界面
- 游戏客户端音频管理器集成
- CDN 配置和多节点分发
- 预计开发时间：3-5 天

## 7. 优先级理由

**P1**（高优先级）

**理由**：
1. **国际化战略关键**：语音本地化是多语言游戏的标配功能，直接影响国际用户体验
2. **运营效率提升**：自动化音频管理可大幅降低新增语言的成本
3. **内容一致性保障**：语音与文本翻译同步，避免翻译不一致问题
4. **性能优化收益**：智能压缩和 CDN 分发可降低带宽成本 30-50%
5. **用户反馈驱动**：国际玩家反馈语音不匹配问题，急需解决
6. **依赖需求已完成**：REQ-00011 和 REQ-00294 已实现，基础设施就绪

**对"项目可用"的贡献**：
- 提升 **国际化/本地化** 维度成熟度
- 改善 **前端体验** 维度（音频加载性能）
- 支持 **国际化/本地化** 战略，助力全球化部署
