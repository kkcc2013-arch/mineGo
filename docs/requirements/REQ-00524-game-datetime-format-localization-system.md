# REQ-00524：游戏日期时间格式本地化与智能显示系统

- **编号**：REQ-00524
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/dateTimeFormat.js、gateway/middleware、user-service、game-client、admin-dashboard
- **创建时间**：2026-07-09 04:05 UTC
- **依赖需求**：REQ-00029(时区本地化已完成)、REQ-00500(数字格式化已完成)

## 1. 背景与问题

当前 mineGo 项目已实现时区转换中间件(`timezoneMiddleware.js`)，但**缺少日期时间显示格式的本地化系统**：

### 代码现状分析

1. **时区转换存在但格式单一**：
   - `backend/shared/timezoneMiddleware.js` 仅返回 ISO 8601 格式和 Unix 时间戳
   - 缺少本地化的日期时间显示格式（如"2026年7月9日 星期四"）

2. **硬编码时间格式**：
   - 各服务中存在大量 `new Date().toLocaleString()` 调用，格式不一致
   - 前端游戏客户端可能硬编码日期格式

3. **游戏特有时间场景缺失**：
   - 倒计时显示（"3天后"、"2小时30分钟"）
   - 相对时间（"刚刚"、"5分钟前"、"昨天"）
   - 游戏活动时间（"活动进行中"、"即将开始"、"已结束"）
   - 精灵孵化时间、技能冷却时间等

4. **跨区域格式差异**：
   - zh-CN: "2026年7月9日 上午4:05"
   - en-US: "July 9, 2026, 4:05 AM"
   - ja-JP: "2026年7月9日 午前4:05"

### 对已有需求的影响

- REQ-00029(时区本地化)已完成时区转换，但格式统一由客户端处理
- REQ-00500(数字格式化)提供了数字本地化，但日期时间独立
- REQ-00488(文本本地化)未覆盖日期时间格式

## 2. 目标

构建完整的日期时间格式本地化系统，实现：

1. **统一格式化 API**：提供 `DateTimeFormatter` 模块，支持 zh-CN/en-US/ja-JP 三语言
2. **游戏场景优化**：倒计时、相对时间、活动时间等游戏专用格式
3. **智能缓存机制**：高频格式化结果缓存，减少重复计算
4. **前后端一致性**：服务端格式化 + 客户端 JS 同步
5. **性能目标**：格式化延迟 <1ms，缓存命中率 >95%

## 3. 范围

- **包含**：
  - `backend/shared/dateTimeFormat.js`：核心格式化模块
  - 相对时间计算：刚刚、N分钟前、今天/昨天、N天前
  - 游戏倒计时：N天N小时N分钟、剩余时间智能显示
  - 活动时间状态：进行中、即将开始、已结束、即将结束
  - 技能冷却/孵化时间：精确到秒的倒计时
  - 客户端 JS 库：`game-client/shared/dateTimeFormat.js`
  - API 响应格式化中间件
  - 单元测试：覆盖所有格式化场景

- **不包含**：
  - 时区转换（已由 REQ-00029 实现）
  - 数字格式化（已由 REQ-00500 实现）
  - 日历系统集成（如农历、日本年号）
  - 实时时钟更新（客户端定时刷新）

## 4. 详细需求

### 4.1 DateTimeFormatter 核心模块

```javascript
// backend/shared/dateTimeFormat.js
const DateTimeFormatter = {
  // 基础格式化
  formatDateTime(date, locale, options),
  formatDate(date, locale, options),
  formatTime(date, locale, options),
  
  // 相对时间
  formatRelative(date, locale, referenceDate),
  
  // 游戏倒计时
  formatCountdown(seconds, locale, options),
  
  // 活动时间
  formatEventTime(startTime, endTime, locale),
  
  // 技能冷却
  formatCooldown(seconds, locale),
  
  // 智能显示（自动选择格式）
  formatSmart(date, locale, options)
};
```

### 4.2 相对时间格式

| 场景 | zh-CN | en-US | ja-JP |
|------|-------|-------|-------|
| <1分钟 | 刚刚 | just now | たった今 |
| <60分钟 | N分钟前 | N minutes ago | N分前 |
| 今天 | 今天 HH:mm | Today, h:mm A | 今日 午前/午後h:mm |
| 昨天 | 昨天 HH:mm | Yesterday, h:mm A | 昨日 午前/午後h:mm |
| <7天 | N天前 | N days ago | N日前 |
| >=7天 | MM月DD日 | MMM D | M月D日 |
| >=365天 | YYYY年MM月DD日 | MMM D, YYYY | YYYY年M月D日 |

### 4.3 游戏倒计时格式

| 时间范围 | zh-CN | en-US | ja-JP |
|----------|-------|-------|-------|
| >=24小时 | X天X小时 | Xd Xh | X日X時間 |
| >=1小时 | X小时X分钟 | Xh Xm | X時間X分 |
| >=1分钟 | X分钟X秒 | Xm Xs | X分X秒 |
| <1分钟 | X秒 | Xs | X秒 |

### 4.4 活动时间状态

```javascript
const EVENT_STATUS = {
  NOT_STARTED: { zh: '即将开始', en: 'Starting Soon', ja: 'もうすぐ開始' },
  IN_PROGRESS: { zh: '进行中', en: 'In Progress', ja: '開催中' },
  ENDING_SOON: { zh: '即将结束', en: 'Ending Soon', ja: 'もうすぐ終了' },
  ENDED: { zh: '已结束', en: 'Ended', ja: '終了' }
};
```

### 4.5 API 响应中间件

```javascript
// gateway/middleware/dateTimeFormatMiddleware.js
function dateTimeFormatMiddleware(req, res, next) {
  res.locals.formatDateTime = (date) => 
    DateTimeFormatter.formatSmart(date, req.language);
  next();
}
```

### 4.6 数据库表设计

```sql
-- 缓存常用格式化结果（可选优化）
CREATE TABLE datetime_format_cache (
  timestamp_utc TIMESTAMPTZ NOT NULL,
  locale VARCHAR(10) NOT NULL,
  format_type VARCHAR(20) NOT NULL,
  formatted_text TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (timestamp_utc, locale, format_type)
);
```

### 4.7 性能优化

- LRU 缓存：最近 10000 次格式化结果
- 预计算：启动时预计算未来 24 小时常用时间点
- 批量格式化：支持数组批量处理，减少重复计算

## 5. 验收标准（可测试）

- [ ] 实现 `DateTimeFormatter` 模块，支持 zh-CN/en-US/ja-JP 三语言
- [ ] 相对时间格式正确：测试 <1分钟、<1小时、今天、昨天、<7天、>=7天 场景
- [ ] 游戏倒计时格式正确：测试 >=24h、>=1h、>=1m、<1m 四种情况
- [ ] 活动时间状态正确：测试未开始、进行中、即将结束、已结束四种状态
- [ ] 技能冷却格式化正确：测试 0s、30s、90s、1h、2h 场景
- [ ] API 响应中间件集成：所有时间字段自动格式化
- [ ] 单元测试覆盖率 ≥90%：包含边界值测试
- [ ] 性能测试：格式化延迟 <1ms，缓存命中率 >95%
- [ ] 客户端 JS 库同步：前后端格式化结果一致

## 6. 工作量估算

**L（Large）** - 预计 16-20 小时

- 核心模块开发：6h
- 相对时间算法：3h
- 游戏场景优化：3h
- API 中间件集成：2h
- 客户端 JS 库：2h
- 单元测试：4h

## 7. 优先级理由

**P1（高优先级）**：

1. **用户体验影响大**：日期时间显示在几乎所有游戏界面（精灵列表、活动中心、技能冷却等），影响全球用户第一印象

2. **国际化关键环节**：已有数字格式化(REQ-00500)、时区转换(REQ-00029)、文本本地化(REQ-00488)，日期时间是本地化系统的最后一块拼图

3. **性能优化机会**：当前硬编码格式效率低，统一格式化 + 缓存可减少 90%+ 重复计算

4. **降低维护成本**：统一 API 替代各服务中分散的 `toLocaleString()` 调用，减少未来修改工作量

5. **竞品对标**：Pokémon GO 等主流游戏均提供完善的日期时间本地化显示
