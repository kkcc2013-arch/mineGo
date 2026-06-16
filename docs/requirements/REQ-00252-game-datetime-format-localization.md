# REQ-00252：游戏内日期时间格式本地化系统

- **编号**：REQ-00252
- **类别**：国际化/本地化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/i18n、backend/shared/i18n.js、gateway、所有微服务
- **创建时间**：2026-06-16 09:00
- **依赖需求**：REQ-00011

## 1. 背景与问题

当前 mineGo 项目的国际化系统（i18n.js）已支持错误消息翻译，但日期时间显示格式未本地化。不同地区用户对日期时间格式有不同习惯：

- **中国**：YYYY-MM-DD HH:mm（24小时制）
- **美国**：MM/DD/YYYY h:mm AM/PM（12小时制）
- **日本**：YYYY年MM月DD日 HH:mm（24小时制）
- **欧洲**：DD.MM.YYYY HH:mm（24小时制）

当前所有日期时间均使用 ISO 格式或固定格式显示，导致非中国用户体验不佳。例如活动倒计时、精灵捕获时间、道馆战斗时间等均未本地化。

## 2. 目标

建立完整的日期时间格式本地化系统：
1. 根据用户语言偏好自动选择日期时间格式
2. 支持相对时间显示（如"3分钟前"、"2小时后"）
3. 支持时区感知的时间显示
4. 前后端统一的格式化接口

## 3. 范围

- **包含**：
  - 后端日期时间格式化工具函数
  - 前端日期时间格式化组件
  - 相对时间计算（ago/in）
  - 各语言的格式配置
  - API 响应时间字段格式化选项

- **不包含**：
  - 时区数据库维护
  - 日历系统集成
  - 历史时间轴功能

## 4. 详细需求

### 4.1 后端日期时间格式化

```javascript
// backend/shared/DateTimeFormatter.js
const DATE_FORMATS = {
  'zh-CN': {
    date: 'YYYY-MM-DD',
    time: 'HH:mm',
    datetime: 'YYYY-MM-DD HH:mm',
    full: 'YYYY年MM月DD日 HH:mm:ss',
    hour12: false
  },
  'en-US': {
    date: 'MM/DD/YYYY',
    time: 'h:mm A',
    datetime: 'MM/DD/YYYY h:mm A',
    full: 'MMMM Do, YYYY h:mm:ss A',
    hour12: true
  },
  'ja-JP': {
    date: 'YYYY/MM/DD',
    time: 'HH:mm',
    datetime: 'YYYY年MM月DD日 HH:mm',
    full: 'YYYY年MM月DD日 HH時mm分ss秒',
    hour12: false
  }
};

// 格式化函数
function formatDate(date, lang, format = 'datetime');
function formatRelative(date, lang, reference = new Date());
function formatDuration(ms, lang);
```

### 4.2 前端格式化组件

```javascript
// frontend/game-client/src/i18n/DateTime.js
class DateTimeFormatter {
  // 格式化日期
  format(date, options = {});
  
  // 相对时间：刚刚、3分钟前、2小时前、昨天、3天前
  relative(date);
  
  // 倒计时：剩余 5分钟、剩余 2小时30分
  countdown(targetDate);
  
  // 时长：3小时25分钟
  duration(ms);
}
```

### 4.3 相对时间翻译

```javascript
const relativeTimeMessages = {
  'zh-CN': {
    just_now: '刚刚',
    seconds_ago: '{n}秒前',
    minutes_ago: '{n}分钟前',
    hours_ago: '{n}小时前',
    days_ago: '{n}天前',
    yesterday: '昨天',
    in_seconds: '{n}秒后',
    in_minutes: '{n}分钟后',
    in_hours: '{n}小时后',
    in_days: '{n}天后',
    tomorrow: '明天'
  },
  'en-US': {
    just_now: 'just now',
    seconds_ago: '{n} seconds ago',
    minutes_ago: '{n} minutes ago',
    hours_ago: '{n} hours ago',
    days_ago: '{n} days ago',
    yesterday: 'yesterday',
    in_seconds: 'in {n} seconds',
    in_minutes: 'in {n} minutes',
    in_hours: 'in {n} hours',
    in_days: 'in {n} days',
    tomorrow: 'tomorrow'
  }
};
```

### 4.4 API 响应时间格式选项

- 支持 `X-Date-Format: relative|absolute|iso` 请求头
- 响应中同时提供 ISO 时间和本地化时间
- 活动列表、精灵详情等接口优先支持

## 5. 验收标准（可测试）

- [ ] 后端 DateTimeFormatter 支持 zh-CN/en-US/ja-JP 三种语言格式
- [ ] 前端 DateTimeFormatter 组件正确显示相对时间
- [ ] 美国用户看到 12 小时制时间（如 3:30 PM）
- [ ] 中国用户看到 24 小时制时间（如 15:30）
- [ ] 日本用户看到日式日期格式（如 2026年6月16日）
- [ ] 相对时间正确处理"刚刚"、"昨天"、"明天"等边界情况
- [ ] 倒计时功能在活动页面正确显示
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M（中等）**
- 后端格式化工具：2-3 小时
- 前端组件开发：3-4 小时
- 翻译消息补充：1 小时
- 单元测试：2 小时
- 总计：8-10 小时

## 7. 优先级理由

P2 优先级：属于用户体验优化，不影响核心功能。但日期时间本地化是国际化系统的重要组成部分，对非中国用户体验有显著影响。依赖 REQ-00011 的基础国际化框架。
