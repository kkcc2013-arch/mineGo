# REQ-00337：精灵详情语音描述与盲人友好信息系统

- **编号**：REQ-00337
- **类别**：无障碍(a11y)
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、pokemon-service、gateway、backend/shared
- **创建时间**：2026-06-26 06:00 UTC
- **依赖需求**：REQ-00017（无障碍访问支持）、REQ-00162（屏幕阅读器语音导航增强）

## 1. 背景与问题

mineGo 作为一款 AR 精灵捕捉游戏，需要为视觉障碍玩家提供完整的无障碍支持。当前 `frontend/game-client/src/accessibility/` 目录已实现键盘导航、屏幕阅读器公告、字体大小、色盲模式等基础功能，但精灵详情页面的语音描述仍不完善：

1. **精灵详情缺乏结构化语音描述**：当前精灵卡片仅有图片和简单文字，屏幕阅读器无法完整描述精灵外观、属性、技能等关键信息。
2. **捕捉场景缺少音频反馈**：视觉障碍玩家在捕捉精灵时无法通过音频判断精灵位置、距离、捕捉成功率。
3. **精灵属性数据未适配语音输出**：属性值、技能列表、进化路径等关键数据需要转换为自然语言描述。
4. **缺少精灵语音档案库**：每个精灵应该有预设的语音描述模板，支持多语言本地化。

根据 WCAG 2.1 AA 标准，游戏需要为非文本内容提供替代文本，并为动态内容提供实时音频描述。

## 2. 目标

为视觉障碍玩家构建完整的精灵信息语音描述系统，确保：

1. 精灵详情页面的所有信息可通过屏幕阅读器完整获取
2. 捕捉场景提供音频定位和状态反馈
3. 精灵属性、技能、进化路径自动生成自然语言描述
4. 支持多语言语音描述，与现有 i18n 系统集成
5. 达成 WCAG 2.1 AA 无障碍标准

## 3. 范围

- **包含**：
  - 精灵详情语音描述生成器（PokemonVoiceDescription.js）
  - 精灵属性自然语言转换模块
  - 捕捉场景音频反馈系统
  - 精灵语音档案数据结构与后端 API
  - 与现有 A11yAnnouncer 和 KeyboardNavigator 集成
  - 多语言支持（中/英/日等）

- **不包含**：
  - TTS 引擎开发（使用浏览器原生 Web Speech API 或系统屏幕阅读器）
  - 全局语音导航系统（已在 REQ-00162 实现）
  - 高对比度模式（已在 REQ-00144 实现）

## 4. 详细需求

### 4.1 精灵详情语音描述生成器

```javascript
// frontend/game-client/src/accessibility/PokemonVoiceDescription.js
export class PokemonVoiceDescription {
  constructor(pokemonData) {
    this.data = pokemonData;
    this.i18n = window.i18n;
  }

  /**
   * 生成完整的精灵语音描述
   */
  generateFullDescription() {
    return {
      summary: this.generateSummary(),
      appearance: this.generateAppearanceDescription(),
      stats: this.generateStatsDescription(),
      skills: this.generateSkillsDescription(),
      evolution: this.generateEvolutionDescription(),
      location: this.generateLocationInfo()
    };
  }

  /**
   * 生成精灵摘要（用于列表项）
   */
  generateSummary() {
    const { name, level, types, rarity } = this.data;
    return this.i18n.t('pokemon.voice.summary', {
      name,
      level,
      types: types.map(t => this.i18n.t(`pokemon.types.${t}`)).join('、'),
      rarity: this.i18n.t(`pokemon.rarity.${rarity}`)
    });
    // 示例输出："皮卡丘，等级 25，电属性，稀有精灵"
  }

  /**
   * 生成外观描述
   */
  generateAppearanceDescription() {
    const { name, types, color, shape, features } = this.data;
    const descriptions = [];
    
    // 基于属性生成描述
    if (types.includes('electric')) {
      descriptions.push(this.i18n.t('pokemon.appearance.electric.default'));
    }
    
    // 基于预设特征生成
    if (features?.length) {
      descriptions.push(...features.map(f => this.i18n.t(`pokemon.features.${f}`)));
    }
    
    return descriptions.join('。');
    // 示例输出："黄色小巧精灵，有尖尖的耳朵，脸颊两侧有红色电囊，尾巴呈闪电形状"
  }

  /**
   * 生成属性值描述
   */
  generateStatsDescription() {
    const { stats, level } = this.data;
    const descriptions = [];
    
    for (const [stat, value] of Object.entries(stats)) {
      const rating = this.getStatRating(value, level);
      descriptions.push(this.i18n.t('pokemon.voice.stat', {
        stat: this.i18n.t(`pokemon.stats.${stat}`),
        value,
        rating
      }));
    }
    
    return descriptions.join('。');
    // 示例输出："攻击力 85，属于较高水平。防御力 50，属于中等水平。速度 90，非常快"
  }

  /**
   * 生成技能描述
   */
  generateSkillsDescription() {
    const { skills, unlockedSkills, lockedSkills } = this.data;
    const descriptions = [];
    
    descriptions.push(this.i18n.t('pokemon.voice.skills.unlocked', {
      count: unlockedSkills.length
    }));
    
    for (const skill of unlockedSkills) {
      descriptions.push(this.i18n.t('pokemon.voice.skill.detail', {
        name: skill.name,
        type: this.i18n.t(`pokemon.types.${skill.type}`),
        power: skill.power,
        cooldown: skill.cooldown
      }));
    }
    
    if (lockedSkills.length > 0) {
      descriptions.push(this.i18n.t('pokemon.voice.skills.locked', {
        count: lockedSkills.length,
        nextLevel: lockedSkills[0].unlockLevel
      }));
    }
    
    return descriptions.join('。');
  }

  /**
   * 生成进化描述
   */
  generateEvolutionDescription() {
    const { evolution, currentStage, maxStage } = this.data;
    
    if (!evolution) {
      return this.i18n.t('pokemon.voice.evolution.none');
    }
    
    if (currentStage === maxStage) {
      return this.i18n.t('pokemon.voice.evolution.final');
    }
    
    const { nextForm, requirement } = evolution;
    return this.i18n.t('pokemon.voice.evolution.next', {
      nextForm: nextForm.name,
      requirement: this.formatEvolutionRequirement(requirement)
    });
  }

  /**
   * 生成定位信息
   */
  generateLocationInfo() {
    const { lastLocation, distance } = this.data;
    
    if (!lastLocation) {
      return this.i18n.t('pokemon.voice.location.unknown');
    }
    
    return this.i18n.t('pokemon.voice.location.found', {
      distance,
      direction: this.getDirectionDescription(lastLocation)
    });
  }

  /**
   * 获取属性评级
   */
  getStatRating(value, level) {
    const ratio = value / (level * 10);
    if (ratio >= 9) return this.i18n.t('pokemon.rating.excellent');
    if (ratio >= 7) return this.i18n.t('pokemon.rating.high');
    if (ratio >= 5) return this.i18n.t('pokemon.rating.medium');
    return this.i18n.t('pokemon.rating.low');
  }

  /**
   * 格式化进化条件
   */
  formatEvolutionRequirement(requirement) {
    const parts = [];
    
    if (requirement.level) {
      parts.push(this.i18n.t('pokemon.evolution.req.level', { level: requirement.level }));
    }
    
    if (requirement.item) {
      parts.push(this.i18n.t('pokemon.evolution.req.item', { item: requirement.item }));
    }
    
    if (requirement.friendship) {
      parts.push(this.i18n.t('pokemon.evolution.req.friendship'));
    }
    
    return parts.join('，');
  }

  /**
   * 获取方向描述
   */
  getDirectionDescription(location) {
    // 基于玩家朝向计算相对方向
    const bearing = this.calculateBearing(window.playerLocation, location);
    return this.i18n.t(`pokemon.direction.${this.bearingToDirection(bearing)}`);
  }
}
```

### 4.2 捕捉场景音频反馈系统

```javascript
// frontend/game-client/src/accessibility/CatchAudioFeedback.js
export class CatchAudioFeedback {
  constructor() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.announcer = window.a11yAnnouncer;
    this.i18n = window.i18n;
    
    // 音频提示配置
    this.soundProfiles = {
      pokemonNear: { frequency: 440, duration: 100, type: 'sine' },
      pokemonFar: { frequency: 220, duration: 200, type: 'sine' },
      catchSuccess: { frequency: 880, duration: 300, type: 'square' },
      catchFailed: { frequency: 200, duration: 400, type: 'sawtooth' },
      pokemonMoved: { frequency: 330, duration: 150, type: 'triangle' }
    };
  }

  /**
   * 播放距离提示音
   */
  playDistanceIndicator(distance) {
    const profile = distance < 50 ? this.soundProfiles.pokemonNear 
                                  : this.soundProfiles.pokemonFar;
    
    // 距离越近，音调越高
    const frequency = profile.frequency * (1 + (100 - distance) / 100);
    this.playTone(frequency, profile.duration, profile.type);
    
    // 同时播放距离语音描述
    this.announcer.announce(
      this.i18n.t('catch.voice.distance', { distance: Math.round(distance) })
    );
  }

  /**
   * 播放捕捉结果音效
   */
  playCatchResult(success, pokemon) {
    const profile = success ? this.soundProfiles.catchSuccess 
                            : this.soundProfiles.catchFailed;
    
    this.playTone(profile.frequency, profile.duration, profile.type);
    
    const message = success 
      ? this.i18n.t('catch.voice.success', { name: pokemon.name })
      : this.i18n.t('catch.voice.failed', { name: pokemon.name });
    
    this.announcer.announce(message);
  }

  /**
   * 精灵移动提醒
   */
  announcePokemonMovement(direction, distance) {
    this.playTone(
      this.soundProfiles.pokemonMoved.frequency,
      this.soundProfiles.pokemonMoved.duration,
      this.soundProfiles.pokemonMoved.type
    );
    
    this.announcer.announce(
      this.i18n.t('catch.voice.movement', { 
        direction: this.i18n.t(`direction.${direction}`),
        distance 
      })
    );
  }

  /**
   * 捕捉成功率语音提示
   */
  announceCatchProbability(probability, factors) {
    const percentage = Math.round(probability * 100);
    const rating = this.getProbabilityRating(probability);
    
    let message = this.i18n.t('catch.voice.probability', { 
      percentage, 
      rating: this.i18n.t(`catch.rating.${rating}`)
    });
    
    // 添加影响因素说明
    if (factors.length > 0) {
      const factorDescriptions = factors.map(f => 
        this.i18n.t(`catch.factor.${f.type}`, { value: f.value })
      ).join('，');
      message += '。' + this.i18n.t('catch.voice.factors', { factors: factorDescription });
    }
    
    this.announcer.announce(message);
  }

  /**
   * 播放基础音调
   */
  playTone(frequency, duration, type = 'sine') {
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    oscillator.frequency.value = frequency;
    oscillator.type = type;
    
    gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration / 1000);
    
    oscillator.start();
    oscillator.stop(this.audioContext.currentTime + duration / 1000);
  }

  /**
   * 获取成功率评级
   */
  getProbabilityRating(probability) {
    if (probability >= 0.7) return 'high';
    if (probability >= 0.4) return 'medium';
    return 'low';
  }
}
```

### 4.3 后端精灵语音档案 API

```javascript
// backend/services/pokemon-service/routes/voiceDescription.js
const express = require('express');
const router = express.Router();
const { Pokemon, PokemonSpecies } = require('../models');
const voiceDescriptionService = require('../services/voiceDescriptionService');

/**
 * 获取精灵语音描述档案
 * GET /api/pokemon/:id/voice-description
 */
router.get('/:id/voice-description', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'zh-CN' } = req.query;
    
    const pokemon = await Pokemon.findByPk(id, {
      include: [{ model: PokemonSpecies, as: 'species' }]
    });
    
    if (!pokemon) {
      return res.status(404).json({ error: 'Pokemon not found' });
    }
    
    const voiceDescription = await voiceDescriptionService.generate(pokemon, lang);
    
    res.json({
      pokemonId: id,
      language: lang,
      description: voiceDescription
    });
  } catch (error) {
    console.error('[VoiceDescription] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * 批量获取精灵语音描述（用于列表）
 * POST /api/pokemon/voice-descriptions
 */
router.post('/voice-descriptions', async (req, res) => {
  try {
    const { pokemonIds, lang = 'zh-CN' } = req.body;
    
    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ error: 'Invalid pokemonIds' });
    }
    
    const descriptions = await voiceDescriptionService.generateBatch(pokemonIds, lang);
    
    res.json({ descriptions });
  } catch (error) {
    console.error('[VoiceDescription] Batch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

### 4.4 语音描述服务

```javascript
// backend/services/pokemon-service/services/voiceDescriptionService.js
const { Pokemon, PokemonSpecies, Skill } = require('../models');
const i18n = require('../../../shared/i18n');

class VoiceDescriptionService {
  constructor() {
    this.appearanceTemplates = this.loadAppearanceTemplates();
  }

  /**
   * 加载外观描述模板
   */
  loadAppearanceTemplates() {
    return {
      electric: {
        default: 'electric_default',
        mouse: 'electric_mouse',
        rodent: 'electric_rodent'
      },
      fire: {
        default: 'fire_default',
        dragon: 'fire_dragon'
      },
      water: {
        default: 'water_default',
        fish: 'water_fish'
      },
      // ... 更多属性模板
    };
  }

  /**
   * 生成单个精灵的语音描述
   */
  async generate(pokemon, lang = 'zh-CN') {
    const species = pokemon.species;
    const t = i18n.getTranslator(lang);
    
    return {
      summary: this.generateSummary(pokemon, t),
      appearance: await this.generateAppearance(species, lang, t),
      stats: this.generateStats(pokemon, t),
      skills: await this.generateSkills(pokemon, t),
      evolution: this.generateEvolution(species, pokemon, t),
      tips: this.generateTips(pokemon, t)
    };
  }

  /**
   * 批量生成
   */
  async generateBatch(pokemonIds, lang = 'zh-CN') {
    const pokemons = await Pokemon.findAll({
      where: { id: pokemonIds },
      include: [{ model: PokemonSpecies, as: 'species' }]
    });
    
    const results = {};
    for (const pokemon of pokemons) {
      results[pokemon.id] = await this.generate(pokemon, lang);
    }
    
    return results;
  }

  /**
   * 生成摘要
   */
  generateSummary(pokemon, t) {
    const types = pokemon.species.types.map(type => 
      t(`pokemon.types.${type}`)
    ).join(t('common.and'));
    
    return t('pokemon.voice.summary', {
      name: pokemon.nickname || pokemon.species.name,
      level: pokemon.level,
      types,
      rarity: t(`pokemon.rarity.${pokemon.species.rarity}`)
    });
  }

  /**
   * 生成外观描述
   */
  async generateAppearance(species, lang, t) {
    const parts = [];
    
    // 基础颜色
    if (species.color) {
      parts.push(t(`pokemon.colors.${species.color}`));
    }
    
    // 体型
    if (species.shape) {
      parts.push(t(`pokemon.shapes.${species.shape}`));
    }
    
    // 属性特定描述
    for (const type of species.types) {
      const template = this.getAppearanceTemplate(type, species.category);
      if (template) {
        parts.push(t(`pokemon.appearance.${template}`));
      }
    }
    
    // 特征标记
    if (species.features?.length > 0) {
      for (const feature of species.features) {
        parts.push(t(`pokemon.features.${feature}`));
      }
    }
    
    return parts.join('，');
  }

  /**
   * 生成属性描述
   */
  generateStats(pokemon, t) {
    const descriptions = [];
    const stats = ['hp', 'attack', 'defense', 'speed', 'specialAttack', 'specialDefense'];
    
    for (const stat of stats) {
      const value = pokemon.stats[stat];
      const rating = this.getStatRating(value, pokemon.level);
      
      descriptions.push(t('pokemon.voice.stat', {
        stat: t(`pokemon.stats.${stat}`),
        value,
        rating: t(`pokemon.rating.${rating}`)
      }));
    }
    
    return descriptions.join('。');
  }

  /**
   * 生成技能描述
   */
  async generateSkills(pokemon, t) {
    const descriptions = [];
    const skills = await pokemon.getSkills();
    
    descriptions.push(t('pokemon.voice.skills.count', { count: skills.length }));
    
    for (const skill of skills.slice(0, 4)) { // 只描述前4个技能
      descriptions.push(t('pokemon.voice.skill.brief', {
        name: skill.name,
        type: t(`pokemon.types.${skill.type}`),
        power: skill.power || t('pokemon.skill.noPower')
      }));
    }
    
    return descriptions.join('。');
  }

  /**
   * 生成进化描述
   */
  generateEvolution(species, pokemon, t) {
    if (!species.evolutionChain) {
      return t('pokemon.voice.evolution.none');
    }
    
    const currentStage = pokemon.evolutionStage;
    const chain = species.evolutionChain;
    
    if (currentStage >= chain.length) {
      return t('pokemon.voice.evolution.final');
    }
    
    const nextEvolution = chain[currentStage];
    return t('pokemon.voice.evolution.next', {
      nextForm: nextEvolution.name,
      requirement: this.formatRequirement(nextEvolution.requirement, t)
    });
  }

  /**
   * 生成提示
   */
  generateTips(pokemon, t) {
    const tips = [];
    
    // 属性克制提示
    const weaknesses = pokemon.species.weaknesses || [];
    if (weaknesses.length > 0) {
      tips.push(t('pokemon.voice.tips.weakness', {
        types: weaknesses.slice(0, 3).map(w => t(`pokemon.types.${w}`)).join('、')
      }));
    }
    
    // 推荐用途
    if (pokemon.level >= 30) {
      tips.push(t('pokemon.voice.tips.battle.ready'));
    }
    
    return tips.join('。');
  }

  /**
   * 获取外观模板
   */
  getAppearanceTemplate(type, category) {
    const typeTemplates = this.appearanceTemplates[type];
    if (!typeTemplates) return null;
    
    return typeTemplates[category] || typeTemplates.default;
  }

  /**
   * 获取属性评级
   */
  getStatRating(value, level) {
    const ratio = value / (level * 10);
    if (ratio >= 9) return 'excellent';
    if (ratio >= 7) return 'high';
    if (ratio >= 5) return 'medium';
    return 'low';
  }

  /**
   * 格式化进化条件
   */
  formatRequirement(requirement, t) {
    const parts = [];
    
    if (requirement.minLevel) {
      parts.push(t('pokemon.evolution.req.level', { level: requirement.minLevel }));
    }
    
    if (requirement.item) {
      parts.push(t('pokemon.evolution.req.item', { item: t(`items.${requirement.item}`) }));
    }
    
    if (requirement.timeOfDay) {
      parts.push(t('pokemon.evolution.req.time', { time: t(`time.${requirement.timeOfDay}`) }));
    }
    
    if (requirement.friendship) {
      parts.push(t('pokemon.evolution.req.friendship'));
    }
    
    return parts.join(t('common.and'));
  }
}

module.exports = new VoiceDescriptionService();
```

### 4.5 多语言支持

```json
// frontend/game-client/src/i18n/locales/zh-CN/pokemon-voice.json
{
  "pokemon.voice.summary": "{{name}}，等级 {{level}}，{{types}}，{{rarity}}",
  "pokemon.voice.stat": "{{stat}} {{value}}，属于{{rating}}",
  "pokemon.voice.skills.count": "已学会 {{count}} 个技能",
  "pokemon.voice.skill.brief": "{{name}}，{{type}}属性，威力 {{power}}",
  "pokemon.voice.skill.detail": "{{name}}，{{type}}属性，威力 {{power}}，冷却时间 {{cooldown}} 秒",
  "pokemon.voice.evolution.none": "该精灵无法进化",
  "pokemon.voice.evolution.final": "已达到最终进化形态",
  "pokemon.voice.evolution.next": "下一进化形态为 {{nextForm}}，需要 {{requirement}}",
  "pokemon.voice.location.unknown": "位置信息未知",
  "pokemon.voice.location.found": "在 {{distance}} 米外的{{direction}}发现过",
  
  "pokemon.rating.excellent": "优秀水平",
  "pokemon.rating.high": "较高水平",
  "pokemon.rating.medium": "中等水平",
  "pokemon.rating.low": "基础水平",
  
  "pokemon.features.sharpEars": "有尖尖的耳朵",
  "pokemon.features.lightningTail": "尾巴呈闪电形状",
  "pokemon.features.redCheeks": "脸颊两侧有红色电囊",
  
  "catch.voice.distance": "精灵距离约 {{distance}} 米",
  "catch.voice.success": "成功捕捉 {{name}}！",
  "catch.voice.failed": "{{name}} 逃脱了",
  "catch.voice.movement": "精灵向{{direction}}移动了 {{distance}} 米",
  "catch.voice.probability": "捕捉成功率 {{percentage}}%，属于{{rating}}",
  "catch.rating.high": "高成功率",
  "catch.rating.medium": "中等成功率",
  "catch.rating.low": "低成功率",
  
  "direction.north": "北方",
  "direction.northeast": "东北方",
  "direction.east": "东方",
  "direction.southeast": "东南方",
  "direction.south": "南方",
  "direction.southwest": "西南方",
  "direction.west": "西方",
  "direction.northwest": "西北方"
}
```

## 5. 验收标准（可测试）

- [ ] 精灵详情页面可通过键盘快捷键（V）触发完整语音描述
- [ ] 语音描述包含精灵名称、等级、属性、外观、属性值、技能、进化路径等完整信息
- [ ] 捕捉场景提供距离音频提示（距离越近音调越高）
- [ ] 捕捉成功/失败播放不同音效并播报结果
- [ ] 精灵移动时播报方向和距离
- [ ] 支持中/英/日三语语音描述
- [ ] 与现有屏幕阅读器兼容（NVDA、JAWS、VoiceOver）
- [ ] 满足 WCAG 2.1 AA 标准（SC 1.1.1 非文本内容、SC 1.3.1 信息和关系）
- [ ] 后端 API `/api/pokemon/:id/voice-description` 返回结构化语音描述数据
- [ ] 批量 API 支持列表场景的语音描述获取

## 6. 工作量估算

**L（Large）**

理由：
- 需要前后端协同开发
- 语音描述模板需覆盖大量精灵（>100种）
- 多语言翻译工作量大
- 需要与现有无障碍系统深度集成
- 需要进行 WCAG 合规测试

## 7. 优先级理由

**P1** 理由：
1. 无障碍是产品合规的必要条件，支持视觉障碍玩家符合企业社会责任
2. WCAG 2.1 AA 标准要求非文本内容提供替代文本
3. 当前键盘导航已完善，语音描述是缺失的关键无障碍功能
4. 与 REQ-00017、REQ-00162 形成完整的无障碍体系
5. 对"项目可用"的贡献度高，提升用户覆盖面
