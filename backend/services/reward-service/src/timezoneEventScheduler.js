/**
 * 时区感知型活动调度引擎 - REQ-00612
 * 支持绝对时间触发和用户本地相对时间触发
 */

'use strict';

const { createLogger } = require('../../../shared/logger');
const db = require('../../../shared/db');
const moment = require('moment-timezone');
const { TimezoneUtils } = require('../../gateway/src/middleware/timezone');

const logger = createLogger('event-scheduler');

/**
 * 活动调度器
 */
class TimezoneAwareEventScheduler {
  constructor() {
    this.eventCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 分钟缓存
  }

  /**
   * 创建时区感知活动
   */
  async createEvent(eventData) {
    const {
      name,
      description,
      startTime,        // ISO 时间戳或相对时间配置
      endTime,
      isTimezoneRelative, // true: 相对时间, false: 绝对时间
      targetTimezone,     // 目标时区（相对时间模式）
      type = 'global',
      rewards = {},
      metadata = {}
    } = eventData;

    // 验证时区
    if (isTimezoneRelative && targetTimezone) {
      if (!TimezoneUtils.isValidTimezone(targetTimezone)) {
        throw new Error(`Invalid timezone: ${targetTimezone}`);
      }
    }

    // 计算活动时间（存储为 UTC）
    const eventTimes = this.calculateEventTimes({
      startTime,
      endTime,
      isTimezoneRelative,
      targetTimezone
    });

    const result = await db.query(
      `INSERT INTO events (
        name, description, start_time, end_time,
        is_timezone_relative, target_timezone, type, rewards, metadata,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      RETURNING *`,
      [
        name,
        description,
        eventTimes.startTimeUTC,
        eventTimes.endTimeUTC,
        isTimezoneRelative,
        targetTimezone || null,
        type,
        JSON.stringify(rewards),
        JSON.stringify(metadata)
      ]
    );

    const event = result.rows[0];
    logger.info({ eventId: event.id, name, isTimezoneRelative }, 'Event created');

    // 预计算并缓存活动触发时间
    await this.cacheEventTriggerTimes(event);

    return this.formatEvent(event);
  }

  /**
   * 计算活动时间（转换为 UTC）
   */
  calculateEventTimes({ startTime, endTime, isTimezoneRelative, targetTimezone }) {
    if (isTimezoneRelative && targetTimezone) {
      // 相对时间模式：在目标时区的特定时间触发
      // startTime 格式：'20:00' 表示当地时间 20:00
      const today = moment().tz(targetTimezone).format('YYYY-MM-DD');
      
      const startLocal = moment.tz(`${today} ${startTime}`, 'YYYY-MM-DD HH:mm', targetTimezone);
      const endLocal = moment.tz(`${today} ${endTime}`, 'YYYY-MM-DD HH:mm', targetTimezone);

      return {
        startTimeUTC: startLocal.utc().toISOString(),
        endTimeUTC: endLocal.utc().toISOString()
      };
    } else {
      // 绝对时间模式：startTime 已经是 UTC 时间
      return {
        startTimeUTC: startTime,
        endTimeUTC: endTime
      };
    }
  }

  /**
   * 预计算活动触发时间（按支持时区）
   */
  async cacheEventTriggerTimes(event) {
    const supportedTimezones = TimezoneUtils.getSupportedTimezones();

    for (const timezone of supportedTimezones) {
      const cacheKey = `${event.id}:${timezone}`;
      
      // 计算该时区的本地触发时间
      const localStart = TimezoneUtils.utcToLocal(event.start_time, timezone);
      const localEnd = TimezoneUtils.utcToLocal(event.end_time, timezone);

      this.eventCache.set(cacheKey, {
        eventId: event.id,
        timezone,
        localStart,
        localEnd,
        cachedAt: Date.now()
      });
    }

    logger.info({ eventId: event.id, timezones: supportedTimezones.length }, 'Event trigger times cached');
  }

  /**
   * 获取用户可见的活动列表（根据时区）
   */
  async getEventsForUser(userId, userTimezone) {
    const cacheKey = `user:${userId}:${userTimezone}`;
    const cached = this.eventCache.get(cacheKey);

    // 检查缓存是否有效
    if (cached && Date.now() - cached.cachedAt < this.cacheExpiry) {
      return cached.events;
    }

    // 查询当前进行中和即将开始的活动
    const now = moment.utc();
    const result = await db.query(
      `SELECT * FROM events 
       WHERE end_time > $1 
       ORDER BY start_time ASC`,
      [now.toISOString()]
    );

    // 转换为用户时区显示
    const events = result.rows.map(event => {
      const formatted = this.formatEventForTimezone(event, userTimezone);
      return {
        ...formatted,
        localStart: TimezoneUtils.utcToLocal(event.start_time, userTimezone),
        localEnd: TimezoneUtils.utcToLocal(event.end_time, userTimezone),
        localStartTime: TimezoneUtils.formatTime(event.start_time, userTimezone, 'HH:mm'),
        localEndTime: TimezoneUtils.formatTime(event.end_time, userTimezone, 'HH:mm')
      };
    });

    // 缓存结果
    this.eventCache.set(cacheKey, {
      events,
      cachedAt: Date.now()
    });

    return events;
  }

  /**
   * 根据时区格式化活动
   */
  formatEventForTimezone(event, timezone) {
    return {
      id: event.id,
      name: event.name,
      description: event.description,
      startTime: event.start_time,
      endTime: event.end_time,
      isTimezoneRelative: event.is_timezone_relative,
      targetTimezone: event.target_timezone,
      type: event.type,
      rewards: event.rewards,
      metadata: event.metadata,
      status: this.getEventStatus(event, timezone)
    };
  }

  /**
   * 获取活动状态
   */
  getEventStatus(event, timezone) {
    const now = moment.utc();
    const start = moment.utc(event.start_time);
    const end = moment.utc(event.end_time);

    if (now.isBefore(start)) {
      const diff = start.diff(now, 'minutes');
      if (diff <= 60) {
        return 'starting_soon';
      }
      return 'upcoming';
    } else if (now.isAfter(end)) {
      return 'ended';
    } else {
      return 'active';
    }
  }

  /**
   * 格式化活动响应
   */
  formatEvent(event) {
    return {
      id: event.id,
      name: event.name,
      description: event.description,
      startTime: event.start_time,
      endTime: event.end_time,
      isTimezoneRelative: event.is_timezone_relative,
      targetTimezone: event.target_timezone,
      type: event.type,
      rewards: event.rewards,
      metadata: event.metadata,
      createdAt: event.created_at,
      updatedAt: event.updated_at
    };
  }

  /**
   * 清理过期缓存
   */
  cleanupCache() {
    const now = Date.now();
    const expiredKeys = [];

    for (const [key, value] of this.eventCache.entries()) {
      if (now - value.cachedAt > this.cacheExpiry) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.eventCache.delete(key);
    }

    logger.info({ expiredCount: expiredKeys.length }, 'Event cache cleaned up');
  }

  /**
   * 更新活动配置（热更新）
   */
  async updateEvent(eventId, updates) {
    const { isTimezoneRelative, targetTimezone, startTime, endTime, ...otherUpdates } = updates;

    // 如果更新了时间相关字段，重新计算
    if (startTime || endTime) {
      const currentEvent = await db.query('SELECT * FROM events WHERE id = $1', [eventId]);
      if (currentEvent.rows.length === 0) {
        throw new Error('Event not found');
      }

      const event = currentEvent.rows[0];
      const eventTimes = this.calculateEventTimes({
        startTime: startTime || event.start_time,
        endTime: endTime || event.end_time,
        isTimezoneRelative: isTimezoneRelative !== undefined ? isTimezoneRelative : event.is_timezone_relative,
        targetTimezone: targetTimezone || event.target_timezone
      });

      updates.start_time = eventTimes.startTimeUTC;
      updates.end_time = eventTimes.endTimeUTC;
    }

    // 构建更新 SQL
    const fields = [];
    const values = [eventId];
    let paramCount = 2;

    for (const [key, value] of Object.entries(updates)) {
      if (['name', 'description', 'type', 'rewards', 'metadata'].includes(key)) {
        fields.push(`${this.toSnakeCase(key)} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (isTimezoneRelative !== undefined) {
      fields.push(`is_timezone_relative = $${paramCount}`);
      values.push(isTimezoneRelative);
      paramCount++;
    }

    if (targetTimezone !== undefined) {
      fields.push(`target_timezone = $${paramCount}`);
      values.push(targetTimezone);
      paramCount++;
    }

    fields.push('updated_at = NOW()');

    const result = await db.query(
      `UPDATE events SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );

    const event = result.rows[0];
    
    // 重新缓存触发时间
    await this.cacheEventTriggerTimes(event);

    logger.info({ eventId, updates: Object.keys(updates) }, 'Event updated');

    return this.formatEvent(event);
  }

  /**
   * 转换为蛇形命名
   */
  toSnakeCase(str) {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }
}

// 创建单例
const scheduler = new TimezoneAwareEventScheduler();

// 定期清理缓存
setInterval(() => {
  scheduler.cleanupCache();
}, 10 * 60 * 1000); // 每 10 分钟

module.exports = scheduler;
