# REQ-00346：游戏时区智能转换与跨时区活动同步系统

- **编号**：REQ-00346
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、reward-service、location-service、game-client、backend/shared/timezone、database/migrations
- **创建时间**：2026-06-27 03:00 UTC
- **依赖需求**：REQ-00294（动态本地化系统）

## 1. 背景与问题

当前 mineGo 在全球化运营中面临时区相关挑战：

1. **活动时间混乱**：全球玩家看到的活动时间都是服务器时区（UTC），缺乏本地时间转换，导致玩家错过活动或误判时间
2. **跨时区活动不同步**：限时活动在不同时区同时开始/结束，但玩家看到的倒计时不准确
3. **历史记录时区问题**：捕捉记录、战斗记录等时间戳缺乏时区信息，玩家查看历史时难以理解实际时间
4. **社交互动障碍**：来自不同时区的玩家组队或交易时，时间协调困难

当前代码中，`reward-service` 和 `location-service` 的活动时间都硬编码为 UTC，前端 `game-client` 缺乏时区转换逻辑。

## 2. 目标

实现游戏时区智能转换与跨时区活动同步系统，提升全球化用户体验：

- 所有时间显示自动转换为玩家本地时区
- 活动开始/结束时间精确到秒，支持时区偏移显示
- 历史记录时间戳支持时区转换和相对时间（如"2小时前"）
- 社交功能支持时区提示（如"对方时区：UTC+8，比您早 3 小时"）

## 3. 范围

- **包含**：
  - 后端时区转换中间件和工具函数
  - 用户时区偏好存储与自动检测
  - 活动时间同步 API（支持时区参数）
  - 前端时区转换组件和格式化工具
  - 历史记录时间转换
  - 社交功能时区提示

- **不包含**：
  - 实时位置时区追踪（GPS 自动识别时区）
  - 跨时区排行榜（属于独立需求）
  - 时区相关的推送通知优化（属于推送系统需求）

## 4. 详细需求

### 4.1 后端时区基础设施

```javascript
// backend/shared/timezone/TimezoneManager.js
class TimezoneManager {
  /**
   * 将 UTC 时间转换为指定时区的本地时间
   * @param {Date|string} utcTime - UTC 时间
   * @param {string} timezone - IANA 时区标识符（如 'Asia/Shanghai'）
   * @returns {Object} 本地时间对象 { datetime, offset, timezone }
   */
  static convertToLocalTime(utcTime, timezone) { /* ... */ }
  
  /**
   * 将本地时间转换为 UTC
   * @param {Date|string} localTime - 本地时间
   * @param {string} timezone - 时区
   * @returns {Date} UTC 时间
   */
  static convertToUTC(localTime, timezone) { /* ... */ }
  
  /**
   * 获取时区偏移（如 +08:00）
   * @param {string} timezone - 时区
   * @param {Date} date - 日期（考虑夏令时）
   * @returns {string} 偏移字符串
   */
  static getOffset(timezone, date) { /* ... */ }
  
  /**
   * 计算相对时间（如"2小时前"、"明天 14:00"）
   * @param {Date} targetTime - 目标时间
   * @param {Date} referenceTime - 参考时间
   * @param {string} language - 语言代码
   * @returns {string} 相对时间文本
   */
  static getRelativeTime(targetTime, referenceTime, language) { /* ... */ }
  
  /**
   * 计算两个时区之间的时间差
   * @param {string} tz1 - 时区1
   * @param {string} tz2 - 时区2
   * @returns {number} 小时差
   */
  static getTimeDifference(tz1, tz2) { /* ... */ }
}
```

### 4.2 用户时区偏好存储

```sql
-- database/migrations/20260627030000_add_user_timezone.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_auto_detected BOOLEAN DEFAULT false;

CREATE INDEX idx_users_timezone ON users(timezone);
```

### 4.3 活动时间同步 API

```javascript
// reward-service/routes/events-with-timezone.js
router.get('/events', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const timezone = req.headers['x-timezone'] || req.user.timezone || 'UTC';
  
  const events = await query(`
    SELECT 
      id, name, description,
      start_time, end_time,
      $1 AS user_timezone,
      timezone_convert(start_time, $1) AS local_start_time,
      timezone_convert(end_time, $1) AS local_end_time,
      EXTRACT(EPOCH FROM (start_time - NOW())) / 3600 AS hours_until_start
    FROM events
    WHERE end_time > NOW()
    ORDER BY start_time ASC
  `, [timezone]);
  
  res.json({ events, timezone, offset: TimezoneManager.getOffset(timezone, new Date()) });
});
```

### 4.4 前端时区转换组件

```javascript
// game-client/src/utils/TimezoneConverter.js
export class TimezoneConverter {
  constructor(userTimezone) {
    this.userTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  
  /**
   * 格式化时间为本地时间
   * @param {string} utcTime - UTC 时间字符串
   * @param {Object} options - 格式化选项
   * @returns {string} 格式化后的本地时间
   */
  formatLocalTime(utcTime, options = {}) {
    const date = new Date(utcTime);
    const formatter = new Intl.DateTimeFormat(
      navigator.language,
      {
        timeZone: this.userTimezone,
        year: options.showDate ? 'numeric' : undefined,
        month: options.showDate ? 'short' : undefined,
        day: options.showDate ? 'numeric' : undefined,
        hour: '2-digit',
        minute: '2-digit',
        hour12: !options.use24Hour
      }
    );
    return formatter.format(date);
  }
  
  /**
   * 生成倒计时文本
   * @param {string} endTime - 结束时间（UTC）
   * @returns {string} 倒计时文本（如"2天 5小时 30分钟"）
   */
  getCountdown(endTime) { /* ... */ }
}
```

### 4.5 社交功能时区提示

```javascript
// social-service/friend-timezone-hint.js
// 当玩家查看好友信息时，显示时区提示
async function getFriendWithTimezoneHint(friendId, viewerTimezone) {
  const friend = await query('SELECT id, username, timezone FROM users WHERE id = $1', [friendId]);
  const timeDiff = TimezoneManager.getTimeDifference(viewerTimezone, friend.timezone);
  const hint = timeDiff > 0 
    ? `对方时区比您晚 ${timeDiff} 小时` 
    : timeDiff < 0 
      ? `对方时区比您早 ${Math.abs(timeDiff)} 小时`
      : '与您同一时区';
  
  return { ...friend, timezoneHint: hint };
}
```

### 4.6 中间件：自动注入时区信息

```javascript
// gateway/middleware/timezoneInjection.js
async function timezoneInjectionMiddleware(req, res, next) {
  // 从请求头获取时区
  const clientTimezone = req.headers['x-timezone'];
  
  // 如果未提供，从用户记录获取
  if (!clientTimezone && req.user) {
    const user = await query('SELECT timezone FROM users WHERE id = $1', [req.user.id]);
    req.timezone = user.timezone || 'UTC';
  } else {
    req.timezone = clientTimezone || 'UTC';
  }
  
  // 设置响应头
  res.setHeader('X-Server-Timezone', 'UTC');
  res.setHeader('X-Client-Timezone', req.timezone);
  
  next();
}
```

## 5. 验收标准（可测试）

- [ ] 所有活动 API 返回的 `start_time` 和 `end_time` 包含本地时间转换结果
- [ ] 用户可以设置和修改时区偏好，修改后立即生效
- [ ] 前端显示的所有时间都使用用户本地时区格式化
- [ ] 历史记录（捕捉记录、战斗记录）支持相对时间显示（"2小时前"、"昨天 14:30"）
- [ ] 好友列表显示时区提示（"比您早 3 小时"）
- [ ] 时区转换准确率 100%（使用标准 IANA 时区数据库）
- [ ] 性能：时区转换延迟 < 5ms（不包含数据库查询）
- [ ] 支持夏令时自动调整

## 6. 工作量估算

**L（Large）**

**理由**：
- 需要修改多个微服务（gateway、user-service、reward-service、location-service、social-service）
- 需要创建新的共享模块（backend/shared/timezone）
- 需要数据库迁移添加时区字段
- 需要前端时区转换组件和格式化逻辑
- 需要处理时区相关的边缘情况（夏令时、跨日期变更线等）
- 预计工作量：3-4 天

## 7. 优先级理由

**P1 理由**：

1. **用户体验关键**：时区混乱直接影响玩家参与活动、使用社交功能，是全球化运营的核心痛点
2. **依赖其他需求**：后续的跨时区推送通知、跨时区排行榜等功能需要此基础设施
3. **成熟度提升**：完善国际化/本地化能力，将"国际化/本地化"维度评分从 4/5 提升到 5/5
4. **影响范围广**：涉及活动系统、社交系统、历史记录等多个核心功能模块
5. **技术风险可控**：使用成熟的时区库（Luxon、date-fns-tz），无复杂技术挑战

## 8. 技术依赖

- **后端库**：Luxon（推荐）或 date-fns-tz，支持 IANA 时区数据库
- **前端库**：Intl.DateTimeFormat（浏览器原生）+ Luxon
- **数据库**：PostgreSQL 内置时区函数（`timezone_convert` 需自定义或使用扩展）
- **测试**：需要测试全球主要时区（UTC-12 到 UTC+14）的转换准确性
