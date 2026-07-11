/**
 * 错误聚合引擎
 * 
 * 功能：
 * - 基于错误码、堆栈指纹、服务聚合错误
 * - 自动检测相似错误并归类
 * - 维护错误聚合组统计
 * 
 * @module ErrorAggregator
 */

const { v4: uuidv4 } = require('crypto');
const redis = require('../redis');
const logger = require('../logger');
const StackFingerprintGenerator = require('./StackFingerprintGenerator');

class ErrorAggregator {
  constructor(config = {}) {
    this.similarityThreshold = config.similarityThreshold || 0.85;
    this.aggregationWindowMs = config.aggregationWindowMs || 300000; // 5分钟
    this.maxGroupSize = config.maxGroupSize || 1000;
    this.maxRecentEvents = config.maxRecentEvents || 100;
    
    this.fingerprintGenerator = new StackFingerprintGenerator(config.fingerprintConfig);
    
    // Redis keys
    this.groupPrefix = 'error:group:';
    this.groupsListKey = 'error:groups:active';
    this.eventsListKey = 'error:events:recent';
    this.statsKey = 'error:stats:daily';
  }

  /**
   * 聚合错误事件
   * @param {Object} errorEvent - 错误事件
   * @returns {Object} 聚合结果（包含聚合组ID）
   */
  async aggregate(errorEvent) {
    try {
      // 1. 生成指纹
      const fingerprint = this.fingerprintGenerator.generateFromEvent(errorEvent);
      
      // 2. 查找相似聚合组
      let group = await this._findSimilarGroup(fingerprint, errorEvent);
      
      if (group) {
        // 3a. 更新现有聚合组
        await this._updateGroup(group, errorEvent, fingerprint);
      } else {
        // 3b. 创建新聚合组
        group = await this._createGroup(errorEvent, fingerprint);
      }
      
      // 4. 更新统计数据
      await this._updateStats(errorEvent, group);
      
      // 5. 保存最近事件
      await this._saveRecentEvent(errorEvent, group.id);
      
      return {
        groupId: group.id,
        fingerprint: fingerprint.fingerprint,
        isNew: !group.existed,
        occurrenceCount: group.occurrenceCount,
        affectedUsers: group.affectedUsers
      };
    } catch (error) {
      logger.error('Error aggregation failed', {
        error: error.message,
        event: errorEvent
      });
      throw error;
    }
  }

  /**
   * 查找相似的错误聚合组
   * @param {Object} fingerprint - 错误指纹
   * @param {Object} errorEvent - 错误事件
   * @returns {Object|null} 聚合组
   */
  async _findSimilarGroup(fingerprint, errorEvent) {
    // 1. 精确匹配：按指纹查找
    const exactMatch = await this._findGroupByFingerprint(fingerprint.fingerprint);
    if (exactMatch) {
      return { ...exactMatch, existed: true };
    }
    
    // 2. 模糊匹配：查找相似度高的组
    const activeGroups = await this._getActiveGroups(errorEvent.service);
    
    for (const group of activeGroups) {
      const groupFingerprint = {
        fingerprint: group.fingerprint,
        errorName: group.errorName,
        messagePattern: group.messagePattern,
        keyFrames: group.keyFrames || []
      };
      
      const similarity = this.fingerprintGenerator.similarity(fingerprint, groupFingerprint);
      
      if (similarity >= this.similarityThreshold) {
        return { ...group, existed: true };
      }
    }
    
    return null;
  }

  /**
   * 根据指纹查找聚合组
   * @param {string} fingerprint - 错误指纹
   * @returns {Object|null} 聚合组
   */
  async _findGroupByFingerprint(fingerprint) {
    const key = `${this.groupPrefix}fingerprint:${fingerprint}`;
    const groupId = await redis.get(key);
    
    if (groupId) {
      return await this.getGroup(groupId);
    }
    
    return null;
  }

  /**
   * 获取活跃的聚合组列表
   * @param {string} service - 服务名称（可选）
   * @returns {Array} 聚合组列表
   */
  async _getActiveGroups(service = null) {
    const now = Date.now();
    const windowStart = now - this.aggregationWindowMs;
    
    let groupIds = await redis.zrangebyscore(
      this.groupsListKey,
      windowStart,
      now
    );
    
    const groups = [];
    for (const groupId of groupIds) {
      const group = await this.getGroup(groupId);
      if (group) {
        if (!service || group.service === service) {
          groups.push(group);
        }
      }
    }
    
    return groups;
  }

  /**
   * 创建新的聚合组
   * @param {Object} errorEvent - 错误事件
   * @param {Object} fingerprint - 错误指纹
   * @returns {Object} 新聚合组
   */
  async _createGroup(errorEvent, fingerprint) {
    const groupId = this._generateGroupId();
    const now = new Date();
    
    const group = {
      id: groupId,
      fingerprint: fingerprint.fingerprint,
      errorCode: errorEvent.errorCode || errorEvent.code,
      errorName: errorEvent.errorName || errorEvent.name,
      messagePattern: fingerprint.messagePattern,
      keyFrames: fingerprint.keyFrames,
      service: errorEvent.service,
      status: 'active',
      firstSeen: now.toISOString(),
      lastSeen: now.toISOString(),
      occurrenceCount: 1,
      affectedUsers: errorEvent.userId ? 1 : 0,
      sampleError: {
        message: errorEvent.message,
        stackTrace: errorEvent.stackTrace || errorEvent.stack
      }
    };
    
    // 保存到 Redis
    await this._saveGroup(group);
    
    // 添加到活跃列表
    await redis.zadd(this.groupsListKey, now.getTime(), groupId);
    
    // 保存指纹映射
    const fingerprintKey = `${this.groupPrefix}fingerprint:${fingerprint.fingerprint}`;
    await redis.setex(fingerprintKey, 86400, groupId); // 1天过期
    
    logger.info('Created new error group', {
      groupId,
      fingerprint: fingerprint.fingerprint,
      service: errorEvent.service
    });
    
    return { ...group, existed: false };
  }

  /**
   * 更新聚合组
   * @param {Object} group - 聚合组
   * @param {Object} errorEvent - 错误事件
   * @param {Object} fingerprint - 错误指纹
   */
  async _updateGroup(group, errorEvent, fingerprint) {
    const now = new Date();
    
    // 更新统计
    group.lastSeen = now.toISOString();
    group.occurrenceCount += 1;
    
    if (errorEvent.userId) {
      // 检查是否是新用户
      const affectedUsersKey = `${this.groupPrefix}${group.id}:users`;
      const isNewUser = await redis.sadd(affectedUsersKey, errorEvent.userId);
      if (isNewUser) {
        group.affectedUsers += 1;
      }
    }
    
    // 更新活跃列表分数
    await redis.zadd(this.groupsListKey, now.getTime(), group.id);
    
    // 保存更新后的聚合组
    await this._saveGroup(group);
  }

  /**
   * 保存聚合组到 Redis
   * @param {Object} group - 聚合组
   */
  async _saveGroup(group) {
    const key = `${this.groupPrefix}${group.id}`;
    await redis.setex(key, 604800, JSON.stringify(group)); // 7天过期
  }

  /**
   * 获取聚合组详情
   * @param {string} groupId - 聚合组ID
   * @returns {Object|null} 聚合组详情
   */
  async getGroup(groupId) {
    const key = `${this.groupPrefix}${groupId}`;
    const data = await redis.get(key);
    
    if (!data) {
      return null;
    }
    
    try {
      return JSON.parse(data);
    } catch (error) {
      logger.error('Failed to parse group data', { groupId, error: error.message });
      return null;
    }
  }

  /**
   * 更新统计数据
   * @param {Object} errorEvent - 错误事件
   * @param {Object} group - 聚合组
   */
  async _updateStats(errorEvent, group) {
    const today = new Date().toISOString().split('T')[0];
    const statsKey = `${this.statsKey}:${today}`;
    
    // 使用 Redis 的 HINCRBY 进行计数
    const multi = redis.multi();
    
    // 总错误数
    multi.hincrby(statsKey, 'total', 1);
    
    // 按服务统计
    multi.hincrby(`${statsKey}:service`, errorEvent.service, 1);
    
    // 按错误码统计
    if (errorEvent.errorCode) {
      multi.hincrby(`${statsKey}:code`, errorEvent.errorCode, 1);
    }
    
    // 按聚合组统计
    multi.hincrby(`${statsKey}:group`, group.id, 1);
    
    await multi.exec();
  }

  /**
   * 保存最近错误事件
   * @param {Object} errorEvent - 错误事件
   * @param {string} groupId - 聚合组ID
   */
  async _saveRecentEvent(errorEvent, groupId) {
    const event = {
      id: this._generateEventId(),
      groupId: groupId,
      errorCode: errorEvent.errorCode || errorEvent.code,
      errorName: errorEvent.errorName || errorEvent.name,
      message: errorEvent.message,
      service: errorEvent.service,
      userId: errorEvent.userId,
      requestId: errorEvent.requestId,
      traceId: errorEvent.traceId,
      occurredAt: new Date().toISOString()
    };
    
    // 使用 LPUSH 添加到列表头部
    await redis.lpush(this.eventsListKey, JSON.stringify(event));
    
    // 限制列表长度
    await redis.ltrim(this.eventsListKey, 0, this.maxRecentEvents - 1);
  }

  /**
   * 获取活跃聚合组列表
   * @param {Object} filters - 过滤条件
   * @returns {Array} 聚合组列表
   */
  async getActiveGroups(filters = {}) {
    const { service, errorCode, status = 'active', limit = 50 } = filters;
    
    const now = Date.now();
    const windowStart = now - this.aggregationWindowMs;
    
    let groupIds = await redis.zrangebyscore(
      this.groupsListKey,
      windowStart,
      now,
      'WITHSCORES',
      'LIMIT',
      0,
      limit
    );
    
    const groups = [];
    for (let i = 0; i < groupIds.length; i += 2) {
      const groupId = groupIds[i];
      const score = parseInt(groupIds[i + 1], 10);
      
      const group = await this.getGroup(groupId);
      
      if (group) {
        // 应用过滤条件
        if (service && group.service !== service) continue;
        if (errorCode && group.errorCode !== errorCode) continue;
        if (status && group.status !== status) continue;
        
        groups.push({
          ...group,
          lastSeenTimestamp: score
        });
      }
    }
    
    return groups.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
  }

  /**
   * 获取错误趋势数据
   * @param {Object} params - 查询参数
   * @returns {Object} 趋势数据
   */
  async getTrend(params = {}) {
    const { service, hours = 24, granularity = 'hour' } = params;
    
    const now = new Date();
    const points = [];
    
    for (let i = hours; i >= 0; i--) {
      const time = new Date(now.getTime() - i * 3600000);
      const hourKey = time.toISOString().split('T')[0] + ':' + time.getHours();
      
      let count = 0;
      
      if (service) {
        count = await redis.hget(`${this.statsKey}:service:${hourKey}`, service) || 0;
      } else {
        count = await redis.hget(`${this.statsKey}:${hourKey}`, 'total') || 0;
      }
      
      points.push({
        time: time.toISOString(),
        count: parseInt(count, 10)
      });
    }
    
    return {
      service,
      granularity,
      points
    };
  }

  /**
   * 标记聚合组为已解决
   * @param {string} groupId - 聚合组ID
   * @param {Object} resolution - 解决信息
   * @returns {Object} 更新后的聚合组
   */
  async resolveGroup(groupId, resolution = {}) {
    const group = await this.getGroup(groupId);
    
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }
    
    group.status = 'resolved';
    group.resolution = resolution.description || resolution.comment;
    group.resolvedAt = new Date().toISOString();
    group.resolvedBy = resolution.userId || 'system';
    
    await this._saveGroup(group);
    
    // 从活跃列表中移除
    await redis.zrem(this.groupsListKey, groupId);
    
    logger.info('Error group resolved', {
      groupId,
      resolution: group.resolution,
      resolvedBy: group.resolvedBy
    });
    
    return group;
  }

  /**
   * 生成聚合组ID
   * @returns {string} 聚合组ID
   */
  _generateGroupId() {
    return `eg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 生成事件ID
   * @returns {string} 事件ID
   */
  _generateEventId() {
    return `ev-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 清理过期数据
   */
  async cleanup() {
    const now = Date.now();
    const threshold = now - this.aggregationWindowMs;
    
    // 清理过期的活跃聚合组
    await redis.zremrangebyscore(this.groupsListKey, '-inf', threshold);
    
    logger.info('Error aggregator cleanup completed');
  }
}

module.exports = ErrorAggregator;