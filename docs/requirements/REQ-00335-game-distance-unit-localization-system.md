# REQ-00335：游戏距离单位本地化与智能转换系统

- **编号**：REQ-00335
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、frontend/game-client/src/utils、frontend/game-client/src/components、gateway、user-service、backend/shared
- **创建时间**：2026-06-26 05:00 UTC
- **依赖需求**：REQ-00011（游戏客户端多语言国际化支持）

## 1. 背景与问题

当前项目已实现客户端多语言支持（REQ-00011）、时区本地化（REQ-00029）和多货币支持（REQ-00051），但在距离单位显示方面存在以下问题：

### 1.1 硬编码的距离单位

通过代码审查发现多处距离单位硬编码：

```javascript
// frontend/game-client/src/game/NotificationManager.js
'notifications.rareSpawn.body': '{{speciesName}} is {{distance}}m away'

// frontend/game-client/src/accessibility/announcer.js
this.announce(`附近出现了一只${speciesName}，距离${distance}米`);

// frontend/game-client/src/components/WeatherWidget.js
${windSpeed ? `<span class="weather-wind">💨 ${windSpeed} km/h</span>` : ''}
```

### 1.2 缺少单位制适配

- **美国、利比里亚、缅甸**使用英制单位（英里、英尺）
- **中国、日本、欧洲**等大多数地区使用公制单位（公里、米）
- 当前系统没有根据用户地区自动切换单位制

### 1.3 用户体验影响

- 美国用户看到 "500m away" 需要换算成英里（0.31 英里）
- 降低游戏沉浸感和本地化体验
- 影响国际化产品的用户满意度

### 1.4 相关需求覆盖情况

| 需求编号 | 需求标题 | 状态 | 覆盖内容 |
|---------|---------|------|---------|
| REQ-00011 | 游戏客户端多语言国际化支持 | done | 语言切换、翻译管理 |
| REQ-00029 | 游戏事件时区本地化 | done | 时区转换、时间格式化 |
| REQ-00051 | 多货币支持与汇率转换系统 | done | 货币格式化、汇率转换 |
| REQ-00101 | 后端 API 错误消息国际化系统 | new | API 错误消息翻译 |
| REQ-00137 | 游戏内容本地化内容管理与翻译工作流系统 | new | 翻译管理工具 |
| **本需求** | **距离单位本地化** | **new** | **度量单位制转换** |

## 2. 目标

建立完整的游戏距离单位本地化系统，实现：

1. **自动检测用户单位制偏好**：根据用户地区自动选择公制/英制
2. **智能单位转换**：后端统一存储公制单位（米），前端按用户偏好显示
3. **统一格式化 API**：提供距离、速度、温度等物理量的本地化格式化
4. **无缝切换**：用户可在设置中手动切换单位制
5. **全场景覆盖**：精灵距离、风速、移动速度、温度等所有物理量

### 2.1 量化目标

- 支持 **2 种单位制**：公制（SI）、英制（Imperial）
- 覆盖 **5 类物理量**：距离、速度、温度、重量、面积
- 转换误差 < 0.1%
- 性能开销 < 5ms per conversion

## 3. 范围

### 包含

- **单位制配置服务**：用户单位制偏好存储、自动检测、手动切换
- **距离格式化工具**：`formatDistance(meters, options)` 支持智能单位选择
- **速度格式化工具**：`formatSpeed(mps)` → km/h 或 mph
- **温度格式化工具**：`formatTemperature(celsius)` → °C 或 °F
- **重量格式化工具**：`formatWeight(kg)` → kg 或 lb
- **面积格式化工具**：`formatArea(sqMeters)` → m² 或 ft²
- **单位制检测**：根据浏览器语言、IP 地理位置自动检测
- **设置界面**：用户可在设置中手动切换单位制
- **全场景替换**：通知、天气、精灵详情、道馆等所有距离显示

### 不包含

- 后端数据库单位转换（后端统一使用公制存储）
- 科学/工程级精度计算（游戏场景精度足够）
- 其他物理量（如压力、体积等，游戏场景不需要）

## 4. 详细需求

### 4.1 单位制配置服务

#### 4.1.1 单位制枚举

```javascript
// frontend/game-client/src/utils/unitSystem.js

export const UnitSystem = {
  METRIC: 'metric',    // 公制：km, m, kg, °C
  IMPERIAL: 'imperial' // 英制：mi, ft, lb, °F
};

// 国家/地区到单位制的映射
export const COUNTRY_UNIT_SYSTEM = {
  'US': 'imperial',    // 美国
  'LR': 'imperial',    // 利比里亚
  'MM': 'imperial',    // 缅甸
  // 其他所有国家默认 metric
  'default': 'metric'
};
```

#### 4.1.2 单位制检测逻辑

```javascript
/**
 * 自动检测用户单位制偏好
 * 优先级：用户设置 > 浏览器语言 > IP 地理位置 > 默认公制
 */
export async function detectUnitSystem() {
  // 1. 检查用户设置
  const saved = localStorage.getItem('pmg_unit_system');
  if (saved && Object.values(UnitSystem).includes(saved)) {
    return saved;
  }
  
  // 2. 根据浏览器语言推断
  const locale = navigator.language || navigator.userLanguage;
  if (locale.startsWith('en-US') || locale === 'en-LR' || locale === 'my') {
    return UnitSystem.IMPERIAL;
  }
  
  // 3. 默认公制
  return UnitSystem.METRIC;
}
```

#### 4.1.3 用户偏好存储

**数据库迁移**：`database/migrations/YYYYMMDDHHMMSS_add_user_unit_system.js`

```sql
ALTER TABLE users ADD COLUMN unit_system VARCHAR(10) DEFAULT 'metric';

-- 更新现有用户（根据国家推断）
UPDATE users u
SET unit_system = 'imperial'
WHERE u.country IN ('US', 'LR', 'MM');

CREATE INDEX idx_users_unit_system ON users(unit_system);
```

### 4.2 距离格式化工具

#### 4.2.1 核心格式化函数

```javascript
/**
 * 格式化距离（智能选择单位）
 * @param {number} meters - 距离（米）
 * @param {Object} options - 格式化选项
 * @returns {string} 本地化的距离字符串
 * 
 * @example
 * formatDistance(150)  // 公制: "150 m" | 英制: "492 ft"
 * formatDistance(2500) // 公制: "2.5 km" | 英制: "1.6 mi"
 */
export function formatDistance(meters, options = {}) {
  const {
    precision = 1,         // 小数位数
    shortForm = false,     // 是否使用简写（km vs 千米）
    locale = getCurrentLocale()
  } = options;
  
  const unitSystem = getCurrentUnitSystem();
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    // 公制 → 英制转换
    const feet = meters * 3.28084;
    const miles = meters * 0.000621371;
    
    if (miles >= 0.1) {
      // 大于 0.1 英里，显示英里
      return `${miles.toFixed(precision)} ${shortForm ? 'mi' : i18n('unit.mile')}`;
    } else {
      // 小于 0.1 英里，显示英尺
      return `${Math.round(feet)} ${shortForm ? 'ft' : i18n('unit.foot')}`;
    }
  } else {
    // 公制
    if (meters >= 1000) {
      const km = meters / 1000;
      return `${km.toFixed(precision)} ${shortForm ? 'km' : i18n('unit.kilometer')}`;
    } else {
      return `${Math.round(meters)} ${shortForm ? 'm' : i18n('unit.meter')}`;
    }
  }
}
```

#### 4.2.2 速度格式化

```javascript
/**
 * 格式化速度
 * @param {number} metersPerSecond - 速度（米/秒）
 * @returns {string} 本地化的速度字符串
 * 
 * @example
 * formatSpeed(10) // 公制: "36 km/h" | 英制: "22 mph"
 */
export function formatSpeed(metersPerSecond, options = {}) {
  const unitSystem = getCurrentUnitSystem();
  const { precision = 0 } = options;
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    const mph = metersPerSecond * 2.23694;
    return `${mph.toFixed(precision)} mph`;
  } else {
    const kmh = metersPerSecond * 3.6;
    return `${kmh.toFixed(precision)} km/h`;
  }
}
```

#### 4.2.3 温度格式化

```javascript
/**
 * 格式化温度
 * @param {number} celsius - 温度（摄氏度）
 * @returns {string} 本地化的温度字符串
 * 
 * @example
 * formatTemperature(25) // 公制: "25°C" | 英制: "77°F"
 */
export function formatTemperature(celsius, options = {}) {
  const unitSystem = getCurrentUnitSystem();
  const { precision = 0 } = options;
  
  if (unitSystem === UnitSystem.IMPERIAL) {
    const fahrenheit = celsius * 9/5 + 32;
    return `${fahrenheit.toFixed(precision)}°F`;
  } else {
    return `${celsius.toFixed(precision)}°C`;
  }
}
```

### 4.3 i18n 翻译键

扩展 `frontend/game-client/src/i18n/locales/*.json`：

```json
{
  "unit": {
    "meter": "米",
    "meters": "米",
    "kilometer": "千米",
    "kilometers": "千米",
    "foot": "英尺",
    "feet": "英尺",
    "mile": "英里",
    "miles": "英里",
    "kilogram": "千克",
    "kg": "kg",
    "pound": "磅",
    "lb": "lb"
  },
  "settings": {
    "unitSystem": "单位制",
    "unitSystemMetric": "公制（千米、千克）",
    "unitSystemImperial": "英制（英里、磅）"
  }
}
```

### 4.4 场景替换清单

#### 4.4.1 精灵距离显示

**文件**：`frontend/game-client/src/game/NotificationManager.js`

```javascript
// 改造前
'notifications.rareSpawn.body': '{{speciesName}} is {{distance}}m away'

// 改造后
'notifications.rareSpawn.body': '{{speciesName}} is {{distance}} away'

// 使用时
const distanceStr = formatDistance(notification.distance);
this.show({
  body: i18n('notifications.rareSpawn.body', {
    speciesName: notification.speciesName,
    distance: distanceStr
  })
});
```

#### 4.4.2 天气风速显示

**文件**：`frontend/game-client/src/components/WeatherWidget.js`

```javascript
// 改造前
${windSpeed ? `<span class="weather-wind">💨 ${windSpeed} km/h</span>` : ''}

// 改造后
${windSpeed ? `<span class="weather-wind">💨 ${formatSpeed(windSpeed)}</span>` : ''}
```

#### 4.4.3 无障碍播报

**文件**：`frontend/game-client/src/accessibility/announcer.js`

```javascript
// 改造前
this.announce(`附近出现了一只${speciesName}，距离${distance}米`);

// 改造后
const distanceStr = formatDistance(distance, { shortForm: false });
this.announce(i18n('accessibility.pokemonSpawn', {
  speciesName,
  distance: distanceStr
}));
```

### 4.5 后端 API 支持

#### 4.5.1 用户偏好接口

**文件**：`backend/services/user-service/src/routes/preferences.js`

```javascript
// GET /api/v1/user/preferences
router.get('/preferences', async (req, res) => {
  const user = await getUser(req.userId);
  res.json({
    language: user.language,
    timezone: user.timezone,
    unitSystem: user.unit_system, // 新增
    // ... 其他偏好
  });
});

// PATCH /api/v1/user/preferences
router.patch('/preferences', async (req, res) => {
  const { unitSystem } = req.body;
  
  if (unitSystem && !['metric', 'imperial'].includes(unitSystem)) {
    return res.status(400).json({ error: 'Invalid unit system' });
  }
  
  await updateUser(req.userId, { unit_system: unitSystem });
  res.json({ success: true });
});
```

#### 4.5.2 后端距离计算保持公制

**原则**：后端所有距离计算、存储、API 返回统一使用公制（米、千米），前端负责按用户偏好转换显示。

```javascript
// 正确示例：后端返回公制单位
// GET /api/v1/pokemon/nearby
{
  "pokemon": [
    {
      "id": "pikachu-123",
      "species": "Pikachu",
      "distance": 150,  // 单位：米
      "lat": 39.9042,
      "lng": 116.4074
    }
  ]
}
```

### 4.6 设置界面

**文件**：`frontend/game-client/src/components/SettingsPanel.js`

```javascript
// 单位制选择器
<div class="setting-item">
  <label>${i18n('settings.unitSystem')}</label>
  <select id="unit-system-select" onchange="handleUnitSystemChange(this.value)">
    <option value="metric" ${currentUnitSystem === 'metric' ? 'selected' : ''}>
      ${i18n('settings.unitSystemMetric')}
    </option>
    <option value="imperial" ${currentUnitSystem === 'imperial' ? 'selected' : ''}>
      ${i18n('settings.unitSystemImperial')}
    </option>
  </select>
</div>

<script>
async function handleUnitSystemChange(system) {
  await api.patch('/api/v1/user/preferences', { unitSystem: system });
  localStorage.setItem('pmg_unit_system', system);
  
  // 触发全局更新事件
  window.dispatchEvent(new CustomEvent('unitSystemChanged', { 
    detail: { unitSystem: system } 
  }));
  
  // 刷新所有距离显示
  refreshAllDistances();
}
</script>
```

## 5. 验收标准（可测试）

- [ ] 用户设置中新增单位制选择器，支持公制/英制切换
- [ ] 切换单位制后，页面所有距离显示实时更新
- [ ] 精灵距离通知正确显示本地化单位（公制：m/km，英制：ft/mi）
- [ ] 天气组件风速正确显示本地化单位（公制：km/h，英制：mph）
- [ ] 无障碍播报使用本地化距离单位
- [ ] 后端 API 距离统一返回公制单位（米）
- [ ] 数据库 users 表新增 unit_system 字段
- [ ] 用户未设置时，根据浏览器语言自动推断单位制
- [ ] 美国用户（en-US）默认显示英制单位
- [ ] 中国/日本用户默认显示公制单位
- [ ] 距离转换精度误差 < 0.1%
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**L（Large）**

**理由**：
- 需要新增数据库迁移、前端工具函数、API 接口
- 需要修改多个现有组件（通知、天气、无障碍等）
- 需要扩展 i18n 翻译文件（3 种语言 × 多个键）
- 需要编写单元测试、集成测试

**预估工时**：2-3 天

## 7. 优先级理由

**P1 理由**：

1. **国际化产品必需**：美国是重要市场，英制单位缺失影响用户体验
2. **影响范围广**：涉及游戏中所有距离显示场景
3. **与已完成需求形成闭环**：已有语言（REQ-00011）、时区（REQ-00029）、货币（REQ-00051）本地化，距离单位是最后一块拼图
4. **技术成熟**：实现方案清晰，风险可控
5. **用户感知明显**：正确显示本地单位能显著提升沉浸感

## 8. 相关需求

- **REQ-00011**：游戏客户端多语言国际化支持（前置依赖）
- **REQ-00029**：游戏事件时区本地化（类似需求，可参考实现）
- **REQ-00051**：多货币支持与汇率转换系统（类似需求，可参考实现）
- **REQ-00101**：后端 API 错误消息国际化系统（并行需求）
- **REQ-00137**：游戏内容本地化内容管理与翻译工作流系统（并行需求）
