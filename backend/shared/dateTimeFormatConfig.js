// backend/shared/dateTimeFormatConfig.js
// Date and time formatting configuration for different locales
// REQ-00524: 游戏日期时间格式本地化与智能显示系统
'use strict';

/**
 * DateTime format configurations for zh-CN, en-US, ja-JP
 */
const DATETIME_CONFIGS = {
  'zh-CN': {
    // 相对时间格式
    relative: {
      justNow: '刚刚',
      minutesAgo: '{n}分钟前',
      hoursAgo: '{n}小时前',
      today: '今天 {time}',
      yesterday: '昨天 {time}',
      daysAgo: '{n}天前',
      weeksAgo: '{n}周前',
      monthsAgo: '{n}个月前',
      yearsAgo: '{n}年前',
      
      // 未来时间
      inMinutes: '{n}分钟后',
      inHours: '{n}小时后',
      tomorrow: '明天 {time}',
      inDays: '{n}天后',
      inWeeks: '{n}周后',
      inMonths: '{n}个月后',
      inYears: '{n}年后'
    },
    
    // 倒计时格式
    countdown: {
      days: '{d}天',
      hours: '{h}小时',
      minutes: '{m}分钟',
      seconds: '{s}秒',
      
      // 组合格式
      daysHours: '{d}天{h}小时',
      hoursMinutes: '{h}小时{m}分钟',
      minutesSeconds: '{m}分钟{s}秒',
      
      // 简短格式
      shortDays: '{d}天',
      shortHours: '{h}小时',
      shortMinutes: '{m}分',
      shortSeconds: '{s}秒'
    },
    
    // 日期格式
    date: {
      full: '{year}年{month}月{day}日 {weekday}',
      long: '{year}年{month}月{day}日',
      medium: '{month}月{day}日',
      short: '{month}/{day}',
      
      // ISO 格式（用于 API）
      iso: 'YYYY-MM-DD'
    },
    
    // 时间格式
    time: {
      full: '{hour}:{minute}:{second}',
      long: '{hour}:{minute}',
      short: '{hour}:{minute}',
      
      // 12小时制
      am: '上午',
      pm: '下午',
      ampmTime: '{ampm} {hour}:{minute}'
    },
    
    // 日期时间组合格式
    datetime: {
      full: '{year}年{month}月{day}日 {ampm}{hour}:{minute}:{second}',
      long: '{year}年{month}月{day}日 {ampm}{hour}:{minute}',
      medium: '{month}月{day}日 {ampm}{hour}:{minute}',
      short: '{month}/{day} {hour}:{minute}'
    },
    
    // 星期名称
    weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
    weekdaysShort: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    
    // 月份名称
    months: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
    monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    
    // 活动状态
    eventStatus: {
      notStarted: '即将开始',
      inProgress: '进行中',
      endingSoon: '即将结束',
      ended: '已结束',
      
      // 附加信息
      startsIn: '将在{time}开始',
      endsIn: '将在{time}结束',
      startedAt: '已于{time}开始',
      endedAt: '已于{time}结束'
    },
    
    // 技能冷却
    cooldown: {
      ready: '可用',
      cooling: '冷却中',
      remaining: '剩余{time}',
      seconds: '{s}秒',
      minutes: '{m}分钟',
      hours: '{h}小时'
    },
    
    // 孵化时间
    incubation: {
      hatching: '孵化中',
      remaining: '还需{time}',
      ready: '可孵化'
    },
    
    // AM/PM 标记
    ampm: {
      am: '上午',
      pm: '下午'
    },
    
    // 格式化选项
    formatOptions: {
      hour12: false, // 24小时制
      defaultDateFormat: 'long',
      defaultTimeFormat: 'long',
      defaultDatetimeFormat: 'long'
    }
  },
  
  'en-US': {
    // 相对时间格式
    relative: {
      justNow: 'just now',
      minutesAgo: '{n} minutes ago',
      hoursAgo: '{n} hours ago',
      today: 'Today, {time}',
      yesterday: 'Yesterday, {time}',
      daysAgo: '{n} days ago',
      weeksAgo: '{n} weeks ago',
      monthsAgo: '{n} months ago',
      yearsAgo: '{n} years ago',
      
      // 单数形式
      minuteAgo: '1 minute ago',
      hourAgo: '1 hour ago',
      dayAgo: '1 day ago',
      weekAgo: '1 week ago',
      monthAgo: '1 month ago',
      yearAgo: '1 year ago',
      
      // 未来时间
      inMinutes: 'in {n} minutes',
      inHours: 'in {n} hours',
      tomorrow: 'Tomorrow, {time}',
      inDays: 'in {n} days',
      inWeeks: 'in {n} weeks',
      inMonths: 'in {n} months',
      inYears: 'in {n} years',
      
      // 单数未来
      inMinute: 'in 1 minute',
      inHour: 'in 1 hour',
      inDay: 'in 1 day',
      inWeek: 'in 1 week',
      inMonth: 'in 1 month',
      inYear: 'in 1 year'
    },
    
    // 倒计时格式
    countdown: {
      days: '{d} days',
      hours: '{h} hours',
      minutes: '{m} minutes',
      seconds: '{s} seconds',
      
      // 组合格式（短格式）
      daysHours: '{d}d {h}h',
      hoursMinutes: '{h}h {m}m',
      minutesSeconds: '{m}m {s}s',
      
      // 简短格式
      shortDays: '{d}d',
      shortHours: '{h}h',
      shortMinutes: '{m}m',
      shortSeconds: '{s}s'
    },
    
    // 日期格式
    date: {
      full: '{weekday}, {month} {day}, {year}',
      long: '{month} {day}, {year}',
      medium: '{month} {day}',
      short: '{month}/{day}',
      
      iso: 'YYYY-MM-DD'
    },
    
    // 时间格式
    time: {
      full: '{hour}:{minute}:{second} {ampm}',
      long: '{hour}:{minute} {ampm}',
      short: '{hour}:{minute} {ampm}',
      
      am: 'AM',
      pm: 'PM',
      ampmTime: '{hour}:{minute} {ampm}'
    },
    
    // 日期时间组合格式
    datetime: {
      full: '{weekday}, {month} {day}, {year} at {hour}:{minute}:{second} {ampm}',
      long: '{month} {day}, {year} at {hour}:{minute} {ampm}',
      medium: '{month} {day} at {hour}:{minute} {ampm}',
      short: '{month}/{day} {hour}:{minute}'
    },
    
    // 星期名称
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    
    // 月份名称
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    
    // 活动状态
    eventStatus: {
      notStarted: 'Starting Soon',
      inProgress: 'In Progress',
      endingSoon: 'Ending Soon',
      ended: 'Ended',
      
      startsIn: 'Starts in {time}',
      endsIn: 'Ends in {time}',
      startedAt: 'Started at {time}',
      endedAt: 'Ended at {time}'
    },
    
    // 技能冷却
    cooldown: {
      ready: 'Ready',
      cooling: 'Cooling',
      remaining: '{time} remaining',
      seconds: '{s}s',
      minutes: '{m}m',
      hours: '{h}h'
    },
    
    // 孵化时间
    incubation: {
      hatching: 'Hatching',
      remaining: '{time} remaining',
      ready: 'Ready to hatch'
    },
    
    // AM/PM 标记
    ampm: {
      am: 'AM',
      pm: 'PM'
    },
    
    // 格式化选项
    formatOptions: {
      hour12: true, // 12小时制
      defaultDateFormat: 'long',
      defaultTimeFormat: 'long',
      defaultDatetimeFormat: 'long'
    }
  },
  
  'ja-JP': {
    // 相对时间格式
    relative: {
      justNow: 'たった今',
      minutesAgo: '{n}分前',
      hoursAgo: '{n}時間前',
      today: '今日 {time}',
      yesterday: '昨日 {time}',
      daysAgo: '{n}日前',
      weeksAgo: '{n}週間前',
      monthsAgo: '{n}ヶ月前',
      yearsAgo: '{n}年前',
      
      // 未来时间
      inMinutes: '{n}分後',
      inHours: '{n}時間後',
      tomorrow: '明日 {time}',
      inDays: '{n}日後',
      inWeeks: '{n}週間後',
      inMonths: '{n}ヶ月後',
      inYears: '{n}年後'
    },
    
    // 倒计时格式
    countdown: {
      days: '{d}日',
      hours: '{h}時間',
      minutes: '{m}分',
      seconds: '{s}秒',
      
      // 组合格式
      daysHours: '{d}日{h}時間',
      hoursMinutes: '{h}時間{m}分',
      minutesSeconds: '{m}分{s}秒',
      
      // 简短格式
      shortDays: '{d}日',
      shortHours: '{h}時間',
      shortMinutes: '{m}分',
      shortSeconds: '{s}秒'
    },
    
    // 日期格式
    date: {
      full: '{year}年{month}月{day}日 {weekday}',
      long: '{year}年{month}月{day}日',
      medium: '{month}月{day}日',
      short: '{month}/{day}',
      
      iso: 'YYYY-MM-DD'
    },
    
    // 时间格式
    time: {
      full: '{hour}:{minute}:{second}',
      long: '{hour}:{minute}',
      short: '{hour}:{minute}',
      
      // 日本常用午前/午後表示
      am: '午前',
      pm: '午後',
      ampmTime: '{ampm}{hour}:{minute}'
    },
    
    // 日期时间组合格式
    datetime: {
      full: '{year}年{month}月{day}日 {ampm}{hour}:{minute}:{second}',
      long: '{year}年{month}月{day}日 {ampm}{hour}:{minute}',
      medium: '{month}月{day}日 {ampm}{hour}:{minute}',
      short: '{month}/{day} {hour}:{minute}'
    },
    
    // 星期名称
    weekdays: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
    weekdaysShort: ['日', '月', '火', '水', '木', '金', '土'],
    
    // 月份名称
    months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    monthsShort: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    
    // 活动状态
    eventStatus: {
      notStarted: 'もうすぐ開始',
      inProgress: '開催中',
      endingSoon: 'もうすぐ終了',
      ended: '終了',
      
      startsIn: '{time}後に開始',
      endsIn: '{time}後に終了',
      startedAt: '{time}に開始',
      endedAt: '{time}に終了'
    },
    
    // 技能冷却
    cooldown: {
      ready: '使用可能',
      cooling: '冷却中',
      remaining: '残り{time}',
      seconds: '{s}秒',
      minutes: '{m}分',
      hours: '{h}時間'
    },
    
    // 孵化时间
    incubation: {
      hatching: '孵化中',
      remaining: '残り{time}',
      ready: '孵化可能'
    },
    
    // AM/PM 标记
    ampm: {
      am: '午前',
      pm: '午後'
    },
    
    // 格式化选项
    formatOptions: {
      hour12: false, // 日本通常使用24小时制
      defaultDateFormat: 'long',
      defaultTimeFormat: 'long',
      defaultDatetimeFormat: 'long'
    }
  }
};

// 默认配置
const DEFAULT_CONFIG = DATETIME_CONFIGS['zh-CN'];

// 支持的语言
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

// 默认语言
const DEFAULT_LANGUAGE = 'zh-CN';

// 缓存配置
const CACHE_CONFIG = {
  maxSize: 10000,
  ttlMs: 60000, // 1分钟
  enabled: true
};

// 相对时间阈值（秒）
const RELATIVE_THRESHOLDS = {
  justNow: 60,        // <60秒 = 刚刚
  minutes: 3600,      // <1小时 = N分钟前
  hours: 86400,       // <24小时 = N小时前
  today: 86400,       // 同一天 = 今天
  yesterday: 172800,  // <2天 = 昨天/明天
  days: 604800,       // <7天 = N天前
  weeks: 2592000,     // <30天 = N周前
  months: 31536000,   // <365天 = N个月前
  years: Infinity     // >=365天 = N年前
};

// 活动状态阈值
const EVENT_THRESHOLDS = {
  startingSoon: 3600, // 开始前1小时内 = 即将开始
  endingSoon: 1800    // 结束前30分钟内 = 即将结束
};

module.exports = {
  DATETIME_CONFIGS,
  DEFAULT_CONFIG,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  CACHE_CONFIG,
  RELATIVE_THRESHOLDS,
  EVENT_THRESHOLDS
};