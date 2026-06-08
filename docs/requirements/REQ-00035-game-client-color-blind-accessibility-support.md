# REQ-00035：游戏客户端色盲模式支持

- **编号**：REQ-00035
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：done
- **涉及服务/模块**：game-client、frontend、game-client/src/components
- **创建时间**：2026-06-07 22:00
- **依赖需求**：REQ-00017（游戏客户端无障碍访问支持）

## 1. 背景与问题

当前 game-client 已实现基础的无障碍支持（REQ-00017），包括屏幕阅读器支持、键盘导航和高对比度模式。然而，项目缺少对色盲用户的专门支持。根据世界卫生组织统计，全球约 8% 的男性和 0.5% 的女性存在不同程度的色觉障碍。

当前问题：
1. 精灵稀有度仅通过颜色区分（普通-绿色、稀有-蓝色、史诗-紫色、传说-金色），色盲用户无法准确识别
2. 地图上的精灵图钉颜色编码对不同类型色盲用户可能混淆
3. 战斗状态效果（中毒-紫色、烧伤-红色、麻痹-黄色）仅靠颜色传达信息
4. 道馆阵营颜色（红/蓝/黄）对部分色盲用户可能无法区分

## 2. 目标

为游戏客户端添加完整的色盲模式支持，确保所有关键信息可通过非颜色方式传达，提升游戏可达性，覆盖至少 95% 的色觉障碍类型。

## 3. 范围

- **包含**：
  - 色盲模式设置界面（4 种预设：红色盲、绿色盲、蓝色盲、全色盲）
  - 精灵稀有度图标化标识系统
  - 地图精灵图钉形状+颜色双重编码
  - 战斗状态效果图标化显示
  - 阵营标识符号化（增加几何形状标识）
  - 色盲模拟器预览功能
  - WCAG 2.1 AA 级对比度验证

- **不包含**：
  - 服务端无障碍功能（已在 REQ-00017 完成）
  - 管理后台的色盲模式（非面向普通用户）
  - 第三方地图 SDK 的色盲适配（依赖 SDK 原生支持）

## 4. 详细需求

### 4.1 色盲模式设置系统
```javascript
// game-client/src/accessibility/ColorBlindMode.js
const COLOR_BLIND_TYPES = {
  normal: '正常视觉',
  protanopia: '红色盲（无法识别红色）',
  deuteranopia: '绿色盲（无法识别绿色）',
  tritanopia: '蓝色盲（无法识别蓝色）',
  achromatopsia: '全色盲（仅灰度）'
};

// 每种模式对应不同的颜色映射策略
const COLOR_PALETTES = {
  protanopia: {
    // 使用蓝橙色系替代红绿色系
    primary: '#0077BB',    // 蓝
    secondary: '#EE7733',  // 橙
    warning: '#CCBB44',    // 黄
    danger: '#EE3377'      // 粉红
  },
  deuteranopia: {
    primary: '#0077BB',
    secondary: '#EE7733',
    warning: '#CCBB44',
    danger: '#EE3377'
  },
  tritanopia: {
    primary: '#009988',    // 青绿
    secondary: '#EE3377',
    warning: '#DDAA33',
    danger: '#BB4411'
  },
  achromatopsia: {
    // 高对比度灰度方案
    primary: '#333333',
    secondary: '#666666',
    warning: '#999999',
    danger: '#111111'
  }
};
```

### 4.2 精灵稀有度图标标识
为每种稀有度添加独特的图标形状，确保非颜色识别：
```javascript
const RARITY_ICONS = {
  common: {
    color: '#4CAF50',
    icon: '●',        // 实心圆
    shape: 'circle',
    label: '普通'
  },
  rare: {
    color: '#2196F3',
    icon: '◆',        // 实心菱形
    shape: 'diamond',
    label: '稀有'
  },
  epic: {
    color: '#9C27B0',
    icon: '★',        // 五角星
    shape: 'star',
    label: '史诗'
  },
  legendary: {
    color: '#FFD700',
    icon: '☆',        // 空心五角星带边框
    shape: 'star-outline',
    label: '传说'
  }
};
```

### 4.3 地图图钉双重编码
地图上的精灵图钉采用形状+颜色双重编码：
```javascript
const MAP_PIN_STYLES = {
  wild_pokemon: {
    shape: 'circle',      // 圆形图钉
    icon: 'P'
  },
  gym: {
    shape: 'triangle',    // 三角形图钉
    icon: 'G'
  },
  pokestop: {
    shape: 'square',      // 方形图钉
    icon: 'S'
  },
  raid: {
    shape: 'star',        // 星形图钉
    icon: 'R'
  }
};
```

### 4.4 战斗状态图标化
所有战斗状态效果添加图标标识：
```javascript
const STATUS_EFFECTS = {
  poison: {
    icon: '☠️',
    symbol: 'P',
    color: '#9C27B0',
    label: '中毒'
  },
  burn: {
    icon: '🔥',
    symbol: 'B',
    color: '#F44336',
    label: '烧伤'
  },
  paralysis: {
    icon: '⚡',
    symbol: 'L',
    color: '#FFEB3B',
    label: '麻痹'
  },
  freeze: {
    icon: '❄️',
    symbol: 'F',
    color: '#00BCD4',
    label: '冰冻'
  },
  sleep: {
    icon: '💤',
    symbol: 'S',
    color: '#9E9E9E',
    label: '睡眠'
  }
};
```

### 4.5 阵营标识符号化
为三大阵营增加几何形状标识：
```javascript
const TEAM_IDENTITIES = {
  valor: {
    color: '#F44336',
    shape: '▲',        // 三角形向上
    name: 'Valor',
    icon: 'flame'
  },
  mystic: {
    color: '#2196F3',
    shape: '■',        // 方形
    name: 'Mystic',
    icon: 'crystal'
  },
  instinct: {
    color: '#FFEB3B',
    shape: '●',        // 圆形
    name: 'Instinct',
    icon: 'lightning'
  }
};
```

### 4.6 色盲模拟器预览
集成色盲模拟器，帮助开发者测试：
```javascript
// game-client/src/utils/colorBlindSimulator.js
class ColorBlindSimulator {
  // 使用 Brettel, Viénot, Mollon 算法
  simulate(imageData, type) {
    const matrix = this.getTransformationMatrix(type);
    // 应用颜色变换矩阵
    return this.transform(imageData, matrix);
  }
  
  previewMode(type) {
    // 实时预览当前界面在色盲视角下的效果
    document.body.classList.add(`color-blind-${type}`);
  }
}
```

## 5. 验收标准（可测试）

- [ ] 色盲模式设置界面可访问，支持 4 种预设类型
- [ ] 精灵稀有度在色盲模式下仍可通过图标/形状准确识别
- [ ] 地图图钉在色盲模式下通过形状区分不同类型（精灵/道馆/补给站）
- [ ] 战斗状态效果在色盲模式下通过图标+文字清晰传达
- [ ] 三大阵营在色盲模式下通过几何形状明确区分
- [ ] 所有 UI 元素在 4 种色盲模式下均符合 WCAG 2.1 AA 级对比度标准（至少 4.5:1）
- [ ] 色盲模拟器可实时预览界面效果
- [ ] 单元测试覆盖色盲模式核心逻辑（至少 20 个测试用例）
- [ ] 无障碍测试通过（使用 axe-core 或类似工具）
- [ ] 用户设置持久化存储，刷新页面后保持

## 6. 工作量估算

**M（中等）**

理由：
1. 主要涉及前端视觉调整和配置系统，不涉及复杂后端逻辑
2. 需要创建约 6-8 个新组件/模块
3. 需要对现有 UI 组件进行批量改造（约 20+ 处）
4. 色盲模拟器可使用现成算法库
5. 预计开发时间：2-3 天

## 7. 优先级理由

定为 **P2**（重要但不紧急）的原因：
1. 项目已有基础无障碍支持（REQ-00017），色盲模式是进一步优化
2. 不影响核心游戏功能，但显著提升用户体验和合规性
3. 符合 WCAG 2.1 标准有助于应用商店审核通过率
4. 扩大潜在用户群体（约 4.5% 全球人口）
5. 优先级低于 P0/P1 的核心功能，但对产品完整度有重要贡献
