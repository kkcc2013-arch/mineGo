# REQ-00229：游戏界面复数形式与性别语法本地化系统

- **编号**：REQ-00229
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/i18n、gateway、所有微服务（多语言消息）、backend/shared/i18n.js
- **创建时间**：2026-06-15 19:05
- **依赖需求**：REQ-00011（游戏客户端多语言国际化支持）

## 1. 背景与问题

当前 mineGo 项目已实现基础的多语言国际化支持（REQ-00011），支持中文、英文、日文三种语言，但 i18n 系统存在以下关键缺陷：

### 1.1 缺少复数形式支持

游戏中有大量涉及数量的 UI 文本，例如：
- "捕捉了 1 只精灵" vs "捕捉了 5 只精灵"
- "获得 1 个道具" vs "获得 3 个道具"  
- "距离 1 公里" vs "距离 5 公里"

**英文复数规则复杂**：
- 单数：1 Pokéball
- 复数：2 Pokéballs
- 不规则：1 foot → 2 feet

**斯拉夫语系（如俄语）更复杂**：
- 1 штука, 2-4 штуки, 5+ штук

当前代码直接拼接字符串，无法正确处理复数：
```javascript
// 当前实现（错误）
const msg = `${count} ${t('pokemon.caught')}`; // "5 Pokémon captured" (英文 OK)
// 但中文应为 "捕捉了 5 只精灵"，英文应为 "Captured 5 Pokémon"
```

### 1.2 缺少性别语法支持

某些语言（如法语、西班牙语、德语）存在语法性别，影响：
- 形容词变化：西班牙语 "bueno"（阳性）vs "buena"（阴性）
- 冠词变化：法语 "le"（阳性）vs "la"（阴性）
- 动词变位：某些语言根据主语性别改变动词形式

精灵的性别信息（male/female/unknown）在 UI 显示时需要根据性别调整文本。

### 1.3 缺少序数词本地化

排行榜、成就等场景需要显示序数词：
- 英文：1st, 2nd, 3rd, 4th...
- 中文：第 1 名, 第 2 名...
- 日文：1位, 2位...
- 法语：1er, 2e, 3e...

当前代码使用硬编码格式：
```javascript
// 硬编码，无法国际化
const rankText = `#${rank}`; // 只适用于部分语言
```

## 2. 目标

构建完整的复数形式与性别语法本地化系统，使游戏文本在所有支持语言下语法正确、自然流畅：

1. **复数形式正确**：所有涉及数量的文本根据语言规则正确显示复数形式
2. **性别语法准确**：精灵性别相关的文本根据语法性别正确变形
3. **序数词标准化**：排行榜、成就等序数显示符合各语言习惯
4. **翻译友好**：支持 ICU Message Format 标准，方便翻译人员维护

## 3. 范围

### 包含

- **复数形式引擎**：实现 ICU MessageFormat 的 plural 选择器
  - 支持 zero/one/two/few/many/other 复数类别
  - 支持英语、中文、日语、法语、德语、西班牙语、葡萄牙语、韩语、俄语等常见语言规则
  - 支持 `=0`, `=1`, `=2` 精确匹配语法
  
- **性别语法支持**：实现 select 选择器
  - 支持 male/female/other 三种性别分类
  - 根据精灵性别动态选择正确的文本形式
  
- **序数词格式化**：实现 selectordinal 选择器
  - 支持各语言的序数词规则（英文 1st/2nd/3rd，日文 1位/2位）
  
- **翻译文件升级**：
  - 将所有涉及数量的文本迁移到 ICU MessageFormat
  - 添加性别相关的选择器翻译
  - 添加序数词翻译模板

- **API 响应本地化**：
  - 后端返回的消息支持复数形式
  - 错误消息中的数量词正确处理

### 不包含

- 自动翻译功能（仍需人工翻译）
- 新增语言支持（仅优化现有 3 种语言 + 预留扩展能力）
- 语音合成（仅文本显示）

## 4. 详细需求

### 4.1 ICU MessageFormat 语法支持

扩展 `frontend/game-client/src/i18n/index.js`，支持 ICU MessageFormat：

```javascript
// 示例：复数形式
t('pokemon.catched', { count: 5 })
// 翻译键：
// "pokemon.catched": "{count, plural, one{Caught # Pokémon} other{Caught # Pokémon}}"

// 示例：性别选择
t('pokemon.genderLabel', { gender: 'female' })
// 翻译键：
// "pokemon.genderLabel": "{gender, select, male{♂ Male} female{♀ Female} other{? Unknown}}"

// 示例：序数词
t('ranking.position', { rank: 1 })
// 英文："1st place"
// 中文："第 1 名"
// 日文："1位"
```

### 4.2 复数规则实现

创建 `frontend/game-client/src/i18n/pluralRules.js`：

```javascript
const PLURAL_RULES = {
  'zh-CN': (n) => n === 1 ? 'one' : 'other',
  'en-US': (n) => {
    if (n === 0) return 'zero';
    if (n === 1) return 'one';
    return 'other';
  },
  'ja-JP': (n) => 'other',
  // 预留其他语言规则
  'ru-RU': (n) => {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'one';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'few';
    return 'many';
  }
};
```

### 4.3 翻译文件迁移

更新 `frontend/game-client/src/i18n/locales/*.json`：

**zh-CN.json**：
```json
{
  "game": {
    "pokemon": {
      "caught": "捕捉了 {count} 只精灵",
      "nearby": "附近有 {count, plural, one{# 只精灵} other{# 只精灵}}",
      "released": "放生了 {count} 只精灵"
    },
    "items": {
      "obtained": "获得了 {count, plural, one{# 个道具} other{# 个道具}}",
      "used": "使用了 {count, plural, one{# 个道具} other{# 个道具}}"
    }
  }
}
```

**en-US.json**：
```json
{
  "game": {
    "pokemon": {
      "caught": "{count, plural, one{Caught # Pokémon} other{Caught # Pokémon}}",
      "nearby": "{count, plural, one{# Pokémon nearby} other{# Pokémon nearby}}",
      "released": "{count, plural, one{Released # Pokémon} other{Released # Pokémon}}"
    },
    "items": {
      "obtained": "{count, plural, one{Obtained # item} other{Obtained # items}}",
      "used": "{count, plural, one{Used # item} other{Used # items}}"
    }
  }
}
```

**ja-JP.json**：
```json
{
  "game": {
    "pokemon": {
      "caught": "{count}匹のポケモンを捕まえた",
      "nearby": "近くに{count}匹のポケモン",
      "released": "{count}匹のポケモンを逃がした"
    },
    "items": {
      "obtained": "{count}個のアイテムを獲得",
      "used": "{count}個のアイテムを使用"
    }
  }
}
```

### 4.4 后端消息本地化

扩展 `backend/shared/i18n.js`，支持后端返回的消息使用 ICU MessageFormat：

```javascript
// 示例：API 响应
{
  "success": true,
  "message": "caught_pokemon",
  "messageParams": { "count": 3 },
  // 前端根据用户语言渲染：t('messages.caught_pokemon', { count: 3 })
}

// 数据库存储消息模板
CREATE TABLE i18n_messages (
  message_key VARCHAR(100) PRIMARY KEY,
  translations JSONB NOT NULL
);

-- 示例数据
INSERT INTO i18n_messages VALUES (
  'caught_pokemon',
  '{"zh-CN": "捕捉了 {count} 只精灵", "en-US": "{count, plural, one{Caught # Pokémon} other{Caught # Pokémon}}", "ja-JP": "{count}匹のポケモンを捕まえた"}'
);
```

### 4.5 序数词格式化

创建 `frontend/game-client/src/i18n/ordinalRules.js`：

```javascript
const ORDINAL_RULES = {
  'en-US': (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  },
  'zh-CN': (n) => `第 ${n} 名`,
  'ja-JP': (n) => `${n}位`
};
```

### 4.6 单元测试

创建 `frontend/tests/i18n/plural.test.js`：

```javascript
describe('Plural Rules', () => {
  test('English plural - 1 item', () => {
    expect(t('items.obtained', { count: 1, lang: 'en-US' }))
      .toBe('Obtained 1 item');
  });
  
  test('English plural - 2 items', () => {
    expect(t('items.obtained', { count: 2, lang: 'en-US' }))
      .toBe('Obtained 2 items');
  });
  
  test('Chinese - no plural change', () => {
    expect(t('items.obtained', { count: 1, lang: 'zh-CN' }))
      .toBe('获得了 1 个道具');
    expect(t('items.obtained', { count: 5, lang: 'zh-CN' }))
      .toBe('获得了 5 个道具');
  });
});
```

## 5. 验收标准（可测试）

- [ ] **复数形式正确**：英文环境下，"1 item" 和 "2 items" 显示正确
- [ ] **中文复数自然**：中文环境下，"1 个道具" 和 "5 个道具" 都显示自然
- [ ] **日文数字格式**：日文环境下，数字直接嵌入文本，无复数变化
- [ ] **序数词本地化**：排行榜第 1 名在英文显示 "1st place"，中文显示 "第 1 名"，日文显示 "1位"
- [ ] **性别文本正确**：精灵性别为 female 时，相关描述文本使用阴性形式（法语/西班牙语）
- [ ] **后端消息支持**：API 返回的带数量消息在前端正确渲染
- [ ] **性能不下降**：翻译查找性能 < 1ms（缓存优化）
- [ ] **测试覆盖**：复数规则单元测试覆盖率 ≥ 90%
- [ ] **向后兼容**：现有翻译键不受影响，仍可正常工作

## 6. 工作量估算

**L（大型）**

理由：
- 需要重构 i18n 核心引擎，支持 ICU MessageFormat 解析
- 需要迁移大量现有翻译文件（3 种语言 × 200+ 翻译键）
- 需要实现后端消息本地化系统
- 需要编写完整的单元测试和集成测试
- 需要更新所有使用数量文本的 UI 组件

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **用户体验关键**：错误的复数形式会让游戏显得不专业，影响玩家沉浸感
2. **扩展性基础**：为未来支持更多语言（法语、德语、西班牙语、俄语）打下基础
3. **国际化合规**：若在欧盟市场运营，正确的本地化是法律要求
4. **依赖其他需求**：排行榜系统、成就系统、交易系统都依赖正确的数量文本
5. **影响面广**：几乎所有游戏模块都涉及数量文本，修复收益巨大
