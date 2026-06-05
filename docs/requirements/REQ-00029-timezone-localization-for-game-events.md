# REQ-00029：游戏事件时区本地化与多时区支持

- **编号**：REQ-00029
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、user-service、gym-service、reward-service、game-client、frontend
- **创建时间**：2026-06-05 21:15
- **完成时间**：2026-06-05 22:30
- **依赖需求**：REQ-00011（多语言国际化支持）

## 1. 背景与问题

### 当前痛点

1. **时区缺失影响游戏体验**
   - Raid 倒计时显示 UTC 时间，非英语用户需要手动换算
   - 活动开始/结束时间无时区转换，导致玩家错过时间窗口
   - 排行榜重置时间显示不友好（"2026-06-05 00:00:00 UTC" 对玩家无意义）

2. **国际化不完整**
   - REQ-00011 实现了多语言支持，但时间显示仍为固定 UTC
   - 缺少用户时区偏好存储和使用机制
   - 前端时间格式化不统一（有的用 Date 对象，有的用字符串）

3. **服务端时间处理不一致**
   - 数据库存储均为 UTC（正确），但返回时未考虑客户端时区
   - 没有 API 规范说明时间字段的时区约定
   - 定时任务（如每日奖励重置）缺少多时区支持

### 实际案例

```javascript
// 当前代码（gym-service）
res.json(successResp({
  endsAt: raid.ends_at,  // "2026-06-06T02:00:00Z" UTC时间
  // 上海玩家看到: 2026-06-06 02:00（以为是凌晨2点，实际是上午10点）
  // 纽约玩家看到: 2026-06-06 02:00（实际是前一天晚上10点）
}));

// 前端直接显示
element.textContent = data.endsAt; // 显示原始UTC字符串
```

## 2. 目标

1. **用户体验提升**
   - 玩家看到的时间均为本地时区时间
   - 自动识别用户时区，支持手动切换
   - 相对时间显示（如"2小时后开始"、"剩余3天"）

2. **系统规范统一**
   - API 时间字段统一使用 ISO 8601 UTC 格式
   - 前端统一使用 `Intl.DateTimeFormat` 格式化
   - 用户时区偏好存储到数据库，支持跨设备同步

3. **多时区事件处理**
   - 全球统一事件（如社区日）按各时区显示
   - 本地事件（如地区活动）显示正确时区
   - 定时任务支持多时区调度

## 3. 范围

### 包含

- **后端**
  - 用户时区偏好字段（user-service）
  - API 时间字段规范（ISO 8601 UTC，带时区提示）
  - 时区查询 API（获取可用时区列表）
  - 定时任务多时区支持（reward-service 每日重置）

- **前端**
  - 自动检测用户时区
  - 时区选择器组件
  - 统一时间格式化工具函数
  - 相对时间显示（moment/ date-fns 风格）

- **数据库**
  - users 表新增 timezone 字段
  - 迁移脚本更新现有用户

### 不包含

- 日历导出功能（Outlook/Google Calendar）
- 夏令时自动调整提示（依赖系统时区库）
- 时区相关成就/任务

## 4. 详细需求

### 4.1 用户时区偏好

#### 数据库迁移

```sql
-- database/pending/20260605_211500__add_user_timezone.sql
ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC';

-- 更新现有用户时区（基于注册IP或默认UTC）
UPDATE users SET timezone = 'UTC' WHERE timezone IS NULL;

CREATE INDEX idx_users_timezone ON users(timezone);
```

#### API 接口

```http
PUT /api/user/timezone
Content-Type: application/json
Authorization: Bearer <token>

{
  "timezone": "Asia/Shanghai"
}

Response 200:
{
  "success": true,
  "data": {
    "timezone": "Asia/Shanghai",
    "currentOffset": "+08:00",
    "localTime": "2026-06-06T05:15:00+08:00"
  }
}
```

### 4.2 前端时区检测与选择

#### 自动检测

```javascript
// frontend/game-client/src/utils/timezone.js
export function detectUserTimezone() {
  // 优先使用用户设置
  const saved = localStorage.getItem('pmg_timezone');
  if (saved) return saved;
  
  // 自动检测
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (detected) {
    localStorage.setItem('pmg_timezone', detected);
    return detected;
  }
  
  return 'UTC';
}

export function formatTime(isoString, options = {}) {
  const timezone = detectUserTimezone();
  const date = new Date(isoString);
  
  return new Intl.DateTimeFormat(navigator.language, {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...options
  }).format(date);
}

export function formatRelative(isoString) {
  const now = Date.now();
  const target = new Date(isoString).getTime();
  const diff = target - now;
  
  const rtf = new Intl.RelativeTimeFormat(navigator.language, {
    numeric: 'auto'
  });
  
  const absDiff = Math.abs(diff);
  
  if (absDiff < 60000) return rtf.format(Math.round(diff / 1000), 'second');
  if (absDiff < 3600000) return rtf.format(Math.round(diff / 60000), 'minute');
  if (absDiff < 86400000) return rtf.format(Math.round(diff / 3600000), 'hour');
  return rtf.format(Math.round(diff / 86400000), 'day');
}
```

#### 时区选择器

```javascript
// frontend/game-client/src/components/TimezoneSelector.js
export class TimezoneSelector {
  constructor(container) {
    this.container = container;
    this.timezones = this.loadTimezones();
    this.render();
  }
  
  loadTimezones() {
    // 常用时区列表
    return [
      { id: 'UTC', label: 'UTC (协调世界时)', offset: '+00:00' },
      { id: 'Asia/Shanghai', label: '中国标准时间 (北京)', offset: '+08:00' },
      { id: 'Asia/Tokyo', label: '日本标准时间', offset: '+09:00' },
      { id: 'America/New_York', label: '美国东部时间', offset: '-05:00' },
      { id: 'America/Los_Angeles', label: '美国太平洋时间', offset: '-08:00' },
      { id: 'Europe/London', label: '英国时间', offset: '+00:00' },
      { id: 'Europe/Paris', label: '中欧时间', offset: '+01:00' },
      // 更多时区...
    ];
  }
  
  render() {
    const current = detectUserTimezone();
    
    this.container.innerHTML = `
      <select id="timezone-select" class="timezone-select">
        ${this.timezones.map(tz => `
          <option value="${tz.id}" ${tz.id === current ? 'selected' : ''}>
            ${tz.label} (${tz.offset})
          </option>
        `).join('')}
      </select>
    `;
    
    this.container.querySelector('select').addEventListener('change', (e) => {
      this.setTimezone(e.target.value);
    });
  }
  
  async setTimezone(timezone) {
    await apiClient.setTimezone(timezone);
    localStorage.setItem('pmg_timezone', timezone);
    window.dispatchEvent(new CustomEvent('timezoneChanged', { detail: { timezone } }));
  }
}
```

### 4.3 服务端时间字段规范化

#### API 响应格式

```javascript
// backend/shared/responseFormatter.js
function formatTimeForAPI(date, fieldName = 'time') {
  if (!date) return null;
  
  const isoString = new Date(date).toISOString();
  
  return {
    [fieldName]: isoString,          // ISO 8601 UTC
    [`${fieldName}Local`]: null,     // 客户端自行转换
    [`${fieldName}Unix`]: Math.floor(new Date(date).getTime() / 1000)
  };
}

// 使用示例（gym-service）
res.json(successResp({
  raidId,
  bossSpeciesId,
  endsAt: raid.ends_at,      // 保持 UTC ISO 格式
  endsAtUnix: Math.floor(new Date(raid.ends_at).getTime() / 1000)
}));
```

#### 时区中间件

```javascript
// backend/shared/timezoneMiddleware.js
function timezoneMiddleware(req, res, next) {
  // 从请求头或用户偏好获取时区
  const userTimezone = req.user?.timezone || 
                       req.headers['x-timezone'] || 
                       'UTC';
  
  req.timezone = userTimezone;
  
  // 添加到响应locals，方便后续使用
  res.locals.timezone = userTimezone;
  
  next();
}

module.exports = { timezoneMiddleware };
```

### 4.4 多时区定时任务

#### 每日奖励重置

```javascript
// backend/services/reward-service/src/dailyResetScheduler.js
const CRON_EXPRESSIONS = {
  'UTC': '0 0 * * *',           // UTC 00:00
  'Asia/Shanghai': '0 0 * * *', // 北京时间 00:00 (实际 UTC 16:00)
  'America/New_York': '0 5 * * *', // 纽约时间 00:00 (实际 UTC 05:00)
};

function scheduleDailyResetForTimezone(timezone, offsetHours) {
  // 使用 node-cron 调度
  cron.schedule(CRON_EXPRESSIONS[timezone], async () => {
    await processDailyReset(timezone);
  }, {
    timezone: timezone
  });
}

// 为主要时区设置调度
['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London'].forEach(tz => {
  scheduleDailyResetForTimezone(tz);
});
```

### 4.5 Raid 倒计时显示

```javascript
// frontend/game-client/src/game/RaidManager.js 修改
import { formatTime, formatRelative } from '../utils/timezone.js';

_handleMessage(msg) {
  switch (msg.type) {
    case 'RAID_UPDATE':
      this._raidState.endsAt = msg.endsAt;
      this._raidState.endsAtLocal = formatTime(msg.endsAt);
      this._raidState.endsAtRelative = formatRelative(msg.endsAt);
      
      this.dispatchEvent(new CustomEvent('raidTimeUpdate', {
        detail: {
          endsAt: msg.endsAt,
          endsAtLocal: this._raidState.endsAtLocal,
          endsAtRelative: this._raidState.endsAtRelative
        }
      }));
      break;
  }
}
```

## 5. 验收标准（可测试）

- [ ] **数据库迁移**
  - users 表新增 timezone 字段
  - 默认值为 'UTC'
  - 现有用户成功更新

- [ ] **用户时区设置 API**
  - PUT /api/user/timezone 返回 200
  - 无效时区返回 400 错误
  - 时区偏移计算正确

- [ ] **前端时区检测**
  - 自动检测用户浏览器时区
  - localStorage 存储时区偏好
  - 切换时区后所有时间更新

- [ ] **时间格式化**
  - formatTime 显示本地时区时间
  - formatRelative 显示相对时间（"2小时后"）
  - 多语言环境正确显示

- [ ] **Raid 时间显示**
  - 倒计时显示本地时区
  - 结束时间显示正确
  - 跨时区玩家看到不同时间

- [ ] **每日任务重置**
  - 北京时间 00:00 重置测试通过
  - 纽约时间 00:00 重置测试通过
  - UTC 时间 00:00 重置测试通过

- [ ] **单元测试覆盖**
  - 时区检测函数测试
  - 时间格式化函数测试
  - API 端点测试
  - 至少 25 个测试用例

## 6. 工作量估算

**M（中等）**

- 理由：
  - 后端：新增 1 个字段 + 2 个 API + 中间件（2-3小时）
  - 前端：时区工具函数 + 选择器组件 + 应用到各页面（4-5小时）
  - 数据库迁移：简单 ALTER + 更新（0.5小时）
  - 测试：单元测试 + 集成测试（2-3小时）
  - 文档：API 文档更新（0.5小时）
  - 总计：9-12 小时

## 7. 优先级理由

**P1（高优先级）**

1. **用户体验关键**
   - 时间显示错误会导致玩家错过活动
   - 影响全球玩家的游戏体验
   - 国际化必须项（语言 + 时区）

2. **依赖影响**
   - 后续活动系统依赖此时区基础
   - 排行榜、成就系统需要正确的时间处理

3. **相对容易实现**
   - 技术成熟（Intl API + 时区数据库）
   - 不涉及复杂算法
   - 可快速验证和测试

4. **补充 REQ-00011**
   - REQ-00011 实现了多语言，但时间仍为 UTC
   - 时区是国际化的另一半
   - 两者结合才是完整的国际化支持
