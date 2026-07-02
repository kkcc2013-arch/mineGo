# REQ-00426: 游戏界面屏幕阅读器智能增强与语义化标注系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00426 |
| 标题 | 游戏界面屏幕阅读器智能增强与语义化标注系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、shared/a11y、admin-dashboard |
| 创建时间 | 2026-07-03 01:00 |

## 需求描述

为视障玩家提供完整的屏幕阅读器支持，通过智能语义化标注、动态上下文描述、焦点管理优化等技术，让玩家能够通过语音反馈完整体验游戏内容。这包括精灵信息、战斗状态、地图导航、社交交互等核心场景的无障碍支持。

### 背景

- 目前游戏界面缺乏 ARIA 标签和语义化标注
- 屏幕阅读器无法读取动态生成的内容（精灵属性、战斗信息）
- 焦点管理混乱，用户难以通过键盘导航
- 缺少实时状态变化的语音通知

### 目标

1. 100% 的游戏界面元素支持屏幕阅读器
2. 动态内容实时语音更新
3. 智能焦点管理，优化导航体验
4. 支持主流屏幕阅读器（VoiceOver、TalkBack、NVDA、JAWS）

## 技术方案

### 1. 语义化标注引擎（SemanticLabelingEngine）

```typescript
// game-client/src/a11y/SemanticLabelingEngine.ts

interface SemanticContext {
  elementType: 'sprite' | 'battle' | 'map' | 'social' | 'item' | 'menu';
  priority: 'high' | 'medium' | 'low';
  liveRegion: 'polite' | 'assertive' | 'off';
  role: AriaRole;
}

class SemanticLabelingEngine {
  private labelingRules: Map<string, LabelingRule>;
  private contextCache: WeakMap<Element, SemanticContext>;
  
  async initialize(): Promise<void> {
    await this.loadLabelingRules();
    this.setupMutationObserver();
  }
  
  // 智能标注生成
  generateLabel(element: Element, context: GameContext): AriaLabel {
    const rule = this.matchRule(element, context);
    const label = this.buildSemanticLabel(element, rule);
    
    return {
      'aria-label': label.text,
      'aria-roledescription': label.role,
      'aria-live': label.liveRegion,
      'aria-atomic': 'true',
      role: label.role
    };
  }
  
  // 动态精灵信息标注
  generateSpriteLabel(sprite: Sprite): SpriteAriaLabel {
    const parts: string[] = [];
    
    // 基础信息
    parts.push(`${sprite.name}`);
    parts.push(`等级${sprite.level}`);
    parts.push(`类型：${sprite.type}`);
    
    // 状态信息
    if (sprite.hp < sprite.maxHp * 0.3) {
      parts.push('生命值低');
    }
    if (sprite.statusEffects.length > 0) {
      parts.push(`状态：${sprite.statusEffects.map(e => e.name).join('、')}`);
    }
    
    // 稀有度
    if (sprite.rarity !== 'common') {
      parts.push(`${sprite.rarity}稀有`);
    }
    
    return {
      full: parts.join('，'),
      brief: `${sprite.name}，Lv.${sprite.level}`,
      detailed: `${sprite.name}，${sprite.type}类型，等级${sprite.level}，${sprite.hp}/${sprite.maxHp}生命值，攻击${sprite.attack}，防御${sprite.defense}`
    };
  }
  
  // 战斗状态标注
  generateBattleLabel(battleState: BattleState): BattleAriaLabel {
    const turnInfo = `第${battleState.turn}回合`;
    const currentPlayer = battleState.isPlayerTurn ? '你的回合' : '对方回合';
    
    const myTeam = battleState.myTeam.map(s => 
      `${s.name} ${s.hp}/${s.maxHp}HP`
    ).join('；');
    
    const enemyTeam = battleState.enemyTeam.map(s => 
      `${s.name} ${s.hp}/${s.maxHp}HP`
    ).join('；');
    
    return {
      summary: `${turnInfo}，${currentPlayer}`,
      myTeam: `我方：${myTeam}`,
      enemyTeam: `对方：${enemyTeam}`,
      action: battleState.lastAction ? 
        `${battleState.lastAction.attacker}使用${battleState.lastAction.skill}，造成${battleState.lastAction.damage}点伤害` : 
        ''
    };
  }
}

interface LabelingRule {
  selector: string;
  elementType: string;
  labelTemplate: (el: Element, ctx: GameContext) => string;
  priority: number;
}
```

### 2. 智能焦点管理器（FocusManager）

```typescript
// game-client/src/a11y/FocusManager.ts

interface FocusTrap {
  container: Element;
  focusableElements: Element[];
  initialFocus?: Element;
  onEscape?: () => void;
}

class FocusManager {
  private focusStack: FocusTrap[] = [];
  private focusHistory: Element[] = [];
  private announceQueue: AnnounceQueue;
  
  constructor() {
    this.announceQueue = new AnnounceQueue();
    this.setupKeyboardNavigation();
  }
  
  // 焦点陷阱管理（用于模态框、菜单等）
  pushFocusTrap(trap: FocusTrap): void {
    // 保存当前焦点
    this.focusHistory.push(document.activeElement);
    
    // 应用焦点陷阱
    this.focusStack.push(trap);
    trap.focusableElements[0]?.focus();
    
    // 通知屏幕阅读器
    this.announce(`进入${trap.container.getAttribute('aria-label') || '新区域'}`);
  }
  
  popFocusTrap(): void {
    const trap = this.focusStack.pop();
    if (!trap) return;
    
    // 恢复之前焦点
    const previousFocus = this.focusHistory.pop();
    previousFocus?.focus();
    
    this.announce('返回上一区域');
  }
  
  // 智能焦点导航
  navigateFocus(direction: 'next' | 'prev' | 'up' | 'down' | 'left' | 'right'): void {
    const currentTrap = this.focusStack[this.focusStack.length - 1];
    if (!currentTrap) return;
    
    const currentIndex = currentTrap.focusableElements.indexOf(document.activeElement);
    const grid = this.buildFocusGrid(currentTrap);
    
    let nextIndex: number;
    if (direction === 'next' || direction === 'right') {
      nextIndex = (currentIndex + 1) % currentTrap.focusableElements.length;
    } else if (direction === 'prev' || direction === 'left') {
      nextIndex = (currentIndex - 1 + currentTrap.focusableElements.length) % currentTrap.focusableElements.length;
    } else {
      // 网格导航（上下）
      nextIndex = this.findGridAdjacent(grid, currentIndex, direction);
    }
    
    currentTrap.focusableElements[nextIndex]?.focus();
  }
  
  // 快捷键焦点跳转
  jumpToSection(section: GameSection): void {
    const sectionElement = document.querySelector(`[data-section="${section}"]`);
    if (sectionElement) {
      const firstFocusable = this.findFirstFocusable(sectionElement);
      firstFocusable?.focus();
      this.announce(`跳转到${section}`);
    }
  }
  
  // 屏幕阅读器通知
  announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
    this.announceQueue.add(message, priority);
  }
  
  private setupKeyboardNavigation(): void {
    document.addEventListener('keydown', (e) => {
      // Alt + 数字键：快速跳转
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        const sections = ['map', 'sprites', 'battle', 'social', 'shop', 'settings', 'inventory', 'quests', 'profile'];
        this.jumpToSection(sections[parseInt(e.key) - 1] as GameSection);
        e.preventDefault();
      }
      
      // Escape：退出当前焦点陷阱
      if (e.key === 'Escape') {
        this.popFocusTrap();
        e.preventDefault();
      }
      
      // Tab导航已由浏览器处理，这里只需拦截特殊情况
      if (e.key === 'Tab' && this.focusStack.length > 0) {
        // 焦点陷阱已激活，浏览器会正确循环焦点
      }
    });
  }
}

enum GameSection {
  Map = 'map',
  Sprites = 'sprites',
  Battle = 'battle',
  Social = 'social',
  Shop = 'shop',
  Settings = 'settings',
  Inventory = 'inventory',
  Quests = 'quests',
  Profile = 'profile'
}
```

### 3. 实时状态播报系统（LiveAnnouncer）

```typescript
// game-client/src/a11y/LiveAnnouncer.ts

interface AnnounceConfig {
  priority: 'polite' | 'assertive';
  delay?: number;
  clearPrevious?: boolean;
  category?: 'battle' | 'social' | 'system' | 'navigation';
}

class LiveAnnouncer {
  private liveRegion: HTMLDivElement;
  private politeregion: HTMLDivElement;
  private assertiveRegion: HTMLDivElement;
  private announceQueue: AnnounceItem[] = [];
  private isProcessing = false;
  private userPreferences: A11yPreferences;
  
  constructor() {
    this.createLiveRegions();
    this.loadUserPreferences();
  }
  
  private createLiveRegions(): void {
    // 创建隐藏的 ARIA live regions
    this.liveRegion = document.createElement('div');
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');
    this.liveRegion.setAttribute('aria-atomic', 'true');
    this.liveRegion.className = 'sr-only';
    
    this.assertiveRegion = document.createElement('div');
    this.assertiveRegion.setAttribute('role', 'alert');
    this.assertiveRegion.setAttribute('aria-live', 'assertive');
    this.assertiveRegion.setAttribute('aria-atomic', 'true');
    this.assertiveRegion.className = 'sr-only';
    
    document.body.appendChild(this.liveRegion);
    document.body.appendChild(this.assertiveRegion);
  }
  
  // 播报消息
  announce(message: string, config: AnnounceConfig = { priority: 'polite' }): void {
    const item: AnnounceItem = {
      message,
      config,
      timestamp: Date.now()
    };
    
    // 根据用户偏好过滤
    if (!this.shouldAnnounce(item)) return;
    
    this.announceQueue.push(item);
    this.processQueue();
  }
  
  // 战斗事件播报
  announceBattleEvent(event: BattleEvent): void {
    const messages: string[] = [];
    
    switch (event.type) {
      case 'damage':
        messages.push(`${event.attacker}对${event.target}造成${event.damage}点伤害`);
        if (event.critical) messages.push('暴击！');
        break;
      case 'heal':
        messages.push(`${event.source}为${event.target}恢复了${event.amount}点生命值`);
        break;
      case 'status':
        messages.push(`${event.target}${event.effect === 'apply' ? '陷入' : '摆脱'}${event.statusName}状态`);
        break;
      case 'faint':
        messages.push(`${event.target}倒下了`);
        break;
      case 'victory':
        messages.push('战斗胜利！');
        break;
      case 'defeat':
        messages.push('战斗失败');
        break;
    }
    
    messages.forEach(msg => this.announce(msg, { 
      priority: event.type === 'victory' || event.type === 'defeat' ? 'assertive' : 'polite',
      category: 'battle'
    }));
  }
  
  // 精灵捕捉结果播报
  announceCatchResult(result: CatchResult): void {
    if (result.success) {
      this.announce(
        `成功捕捉${result.sprite.name}！${result.isNew ? '这是新收录的精灵！' : ''}`,
        { priority: 'assertive', category: 'system' }
      );
    } else {
      this.announce(
        `${result.sprite.name}逃跑了`,
        { priority: 'polite', category: 'system' }
      );
    }
  }
  
  // 地图导航播报
  announceMapNavigation(location: MapLocation): void {
    const nearbyPoints = location.pointsOfInterest
      .filter(poi => poi.distance < 50)
      .map(poi => `${poi.name}，${poi.distance}米`)
      .join('；');
    
    if (nearbyPoints) {
      this.announce(`附近：${nearbyPoints}`, { priority: 'polite', category: 'navigation' });
    }
  }
  
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.announceQueue.length === 0) return;
    
    this.isProcessing = true;
    const item = this.announceQueue.shift();
    
    // 延迟播报，避免重叠
    await this.delay(item.config.delay || 100);
    
    const region = item.config.priority === 'assertive' ? 
      this.assertiveRegion : this.liveRegion;
    
    // 清空并设置新内容
    region.textContent = '';
    await this.delay(50);
    region.textContent = item.message;
    
    // 等待播报完成（估算）
    await this.delay(this.estimateReadTime(item.message));
    
    this.isProcessing = false;
    this.processQueue();
  }
  
  private shouldAnnounce(item: AnnounceItem): boolean {
    const prefs = this.userPreferences;
    
    // 检查用户是否禁用了该类别的播报
    if (item.config.category && !prefs.enabledCategories.includes(item.config.category)) {
      return false;
    }
    
    // 检查静音模式
    if (prefs.silentMode) return false;
    
    // 检查重复消息
    const lastAnnounce = this.announceQueue[this.announceQueue.length - 1];
    if (lastAnnounce && lastAnnounce.message === item.message) {
      return false;
    }
    
    return true;
  }
  
  private estimateReadTime(text: string): number {
    // 平均阅读速度：中文 200字/分钟，英文 150词/分钟
    const charCount = text.length;
    const wordsPerMinute = 200;
    return (charCount / wordsPerMinute) * 60000; // 毫秒
  }
}

interface A11yPreferences {
  enabledCategories: string[];
  silentMode: boolean;
  announceVolume: number;
  speechRate: 'slow' | 'normal' | 'fast';
}
```

### 4. 视觉元素描述生成器（VisualDescriber）

```typescript
// game-client/src/a11y/VisualDescriber.ts

class VisualDescriber {
  private spriteDatabase: SpriteDatabase;
  private mapDatabase: MapDatabase;
  
  // 描述精灵外观
  describeSprite(sprite: Sprite): string {
    const parts: string[] = [];
    
    // 基础形态
    parts.push(`${sprite.name}是一只${sprite.bodyType}型${sprite.category}类精灵`);
    
    // 颜色与特征
    parts.push(`主要颜色为${sprite.primaryColor}`);
    if (sprite.secondaryColor) {
      parts.push(`带有${sprite.secondaryColor}色点缀`);
    }
    
    // 特殊特征
    if (sprite.features.length > 0) {
      parts.push(`特征：${sprite.features.join('、')}`);
    }
    
    // 大小与体型
    parts.push(`身高约${sprite.height}米，体重${sprite.weight}公斤`);
    
    // 表情状态
    if (sprite.expression !== 'neutral') {
      parts.push(`表情${sprite.expression}`);
    }
    
    return parts.join('。');
  }
  
  // 描述地图场景
  describeMapScene(scene: MapScene): string {
    const parts: string[] = [];
    
    // 地点类型
    parts.push(`当前位置：${scene.locationName}，${scene.locationType}`);
    
    // 环境
    parts.push(`环境：${scene.weather}，${scene.timeOfDay}`);
    
    // 地形特征
    parts.push(`地形：${scene.terrain}`);
    
    // 可见精灵
    if (scene.visibleSprites.length > 0) {
      const spriteList = scene.visibleSprites.map(s => `${s.name}（${s.distance}米外）`).join('、');
      parts.push(`可见精灵：${spriteList}`);
    }
    
    // 可交互对象
    if (scene.interactables.length > 0) {
      const interactableList = scene.interactables.map(i => `${i.name}（${i.direction}方向${i.distance}米）`).join('、');
      parts.push(`附近物体：${interactableList}`);
    }
    
    return parts.join('。');
  }
  
  // 描述战斗场景
  describeBattleScene(battle: BattleScene): string {
    const parts: string[] = [];
    
    // 场景类型
    parts.push(`战斗场景：${battle.arena}，${battle.terrainType}地形`);
    
    // 天气效果
    if (battle.weatherEffect) {
      parts.push(`天气效果：${battle.weatherEffect}`);
    }
    
    // 我方精灵位置
    battle.myTeam.forEach((sprite, index) => {
      const position = ['前排左侧', '前排右侧', '后排'][index] || `位置${index + 1}`;
      parts.push(`我方${position}：${sprite.name}`);
    });
    
    // 敌方精灵位置
    battle.enemyTeam.forEach((sprite, index) => {
      const position = ['前排', '后排'][Math.floor(index / 2)] || `位置${index + 1}`;
      parts.push(`敌方${position}：${sprite.name}`);
    });
    
    return parts.join('。');
  }
}
```

### 5. 无障碍配置管理

```typescript
// shared/a11y/A11yConfig.ts

interface A11yConfig {
  // 屏幕阅读器设置
  screenReader: {
    enabled: boolean;
    preferredReader: 'auto' | 'voiceover' | 'talkback' | 'nvda' | 'jaws';
    speechRate: number; // 0.5 - 2.0
    pitch: number; // 0.5 - 2.0
    volume: number; // 0 - 1
  };
  
  // 播报设置
  announcements: {
    battle: boolean;
    social: boolean;
    navigation: boolean;
    system: boolean;
    catch: boolean;
  };
  
  // 焦点设置
  focus: {
    showIndicator: boolean;
    indicatorStyle: 'highlight' | 'outline' | 'none';
    navigationMode: 'linear' | 'spatial' | 'smart';
    skipHidden: boolean;
  };
  
  // 详细程度
  verbosity: 'minimal' | 'normal' | 'verbose';
  
  // 快捷键映射
  keyBindings: {
    [action: string]: string[];
  };
}

class A11yConfigManager {
  private config: A11yConfig;
  
  async initialize(): Promise<void> {
    // 检测用户使用的屏幕阅读器
    const detectedReader = await this.detectScreenReader();
    
    // 加载保存的配置或使用默认值
    this.config = await this.loadConfig();
    
    if (this.config.screenReader.preferredReader === 'auto') {
      this.config.screenReader.preferredReader = detectedReader;
    }
    
    // 应用配置
    this.applyConfig();
  }
  
  private async detectScreenReader(): Promise<ScreenReaderType> {
    // 检测平台
    const ua = navigator.userAgent.toLowerCase();
    const platform = navigator.platform.toLowerCase();
    
    if (platform.includes('mac') || platform.includes('iphone') || platform.includes('ipad')) {
      return 'voiceover';
    } else if (platform.includes('android')) {
      return 'talkback';
    } else if (ua.includes('windows')) {
      // Windows 上需要检测具体使用的读屏软件
      return 'nvda';
    }
    
    return 'nvda'; // 默认
  }
  
  getDefaultConfig(): A11yConfig {
    return {
      screenReader: {
        enabled: true,
        preferredReader: 'auto',
        speechRate: 1.0,
        pitch: 1.0,
        volume: 1.0
      },
      announcements: {
        battle: true,
        social: true,
        navigation: true,
        system: true,
        catch: true
      },
      focus: {
        showIndicator: true,
        indicatorStyle: 'highlight',
        navigationMode: 'smart',
        skipHidden: true
      },
      verbosity: 'normal',
      keyBindings: {
        'navigate_next': ['Tab', 'ArrowRight'],
        'navigate_prev': ['Shift+Tab', 'ArrowLeft'],
        'navigate_up': ['ArrowUp'],
        'navigate_down': ['ArrowDown'],
        'jump_map': ['Alt+1'],
        'jump_sprites': ['Alt+2'],
        'jump_battle': ['Alt+3'],
        'jump_social': ['Alt+4'],
        'jump_shop': ['Alt+5'],
        'jump_settings': ['Alt+6'],
        'jump_inventory': ['Alt+7'],
        'jump_quests': ['Alt+8'],
        'jump_profile': ['Alt+9'],
        'back': ['Escape'],
        'select': ['Enter', 'Space'],
        'context_menu': ['Shift+F10', 'Menu']
      }
    };
  }
}
```

## 验收标准

- [ ] 所有游戏界面元素具有正确的 ARIA 标签
- [ ] 动态精灵信息能够被屏幕阅读器正确读取
- [ ] 战斗状态变化实时播报
- [ ] 焦点管理符合 WAI-ARIA 规范
- [ ] 支持键盘完整导航（100% 功能可通过键盘访问）
- [ ] 支持 VoiceOver（iOS/macOS）、TalkBack（Android）、NVDA/JAWS（Windows）
- [ ] 用户可配置播报详细程度和类别
- [ ] 快捷键可自定义
- [ ] 通过 axe-core 自动化测试（无严重问题）
- [ ] 通过手动屏幕阅读器测试（覆盖核心流程）

## 影响范围

- `game-client/src/components/` - 所有 UI 组件添加 ARIA 属性
- `game-client/src/a11y/` - 新增无障碍模块
- `shared/a11y/` - 共享无障碍配置和工具
- `admin-dashboard/src/components/a11y/` - 无障碍设置管理界面
- `docs/a11y-guide.md` - 无障碍开发指南

## 参考

- [WAI-ARIA Authoring Practices](https://www.w3.org/TR/wai-aria-practices-1.2/)
- [WebAIM Screen Reader User Survey](https://webaim.org/projects/screenreadersurvey/)
- [Apple VoiceOver Documentation](https://developer.apple.com/accessibility/ios/)
- [Android Accessibility Developer Guide](https://developer.android.com/guide/topics/ui/accessibility)
- [WCAG 2.1 Guidelines](https://www.w3.org/TR/WCAG21/)
