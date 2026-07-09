/**
 * ErrorAggregator - 错误聚合引擎
 * 
 * 功能：
 * - 按错误码、堆栈指纹、服务等维度聚合错误
 * - 自动识别相同根因的错误
 * - 维护聚合组统计信息
 * 
 * @module backend/shared/errorAnalysis/ErrorAggregator
 */

'use strict';

const crypto = require('crypto');
const StackFingerprintGenerator = require('./StackFingerprintGenerator');

class ErrorAggregator {
  /**
   * 构造函数
   * @param {Object} config - 配置选项
   * @param {Object} dependencies - 依赖项
   */
  constructor(config = {}, dependencies = {}) {
    this.similarityThreshold = config.similarityThreshold || 0.85;
    this.aggregationWindowMs = config.aggregationWindowMs || 300000; // 5分钟
    this.maxGroupSize = config.maxGroupSize || 1000;
    this.maxGroups = config.maxGroups || 10000;
    
    this.fingerprintGenerator = new StackFingerprintGenerator(config.fingerprint);
    this.redisClient = dependencies.redisClient;
    this.dbClient = dependencies.dbClient;
    
    // 内存缓存（用于实时聚合）
    this.groupCache = new Map();
    this.lastCleanupTime = Date.now();
  }

  /**
   * 聚合错误事件
   * @param {Object} errorEvent - 错误事件
   * @returns {Object} 聚合结果
   */
  async aggregate(errorEvent) {
    // 生成指纹
    const fingerprint = this.fingerprintGenerator.generate(errorEvent.error);
    
    // 查找相似聚合组
    const existingGroup = await this._findSimilarGroup(fingerprint, errorEvent);
    
    if (existingGroup) {
      // 添加到现有组
      await this._addToGroup(existingGroup, errorEvent, fingerprint);
      return {
        groupId: existingGroup.id,
        isNew: false,
        fingerprint: fingerprint.fingerprint
      };
    } else {
      // 创建新组
      const newGroup = await this._createGroup(errorEvent, fingerprint);
      return {
        groupId: newGroup.id,
        isNew: true,
        fingerprint: fingerprint.fingerprint
      };
    }
  }

  /**
   * 查找相似聚合组
   * @private
   */
  async _findSimilarGroup(fingerprint, errorEvent) {
    // 1. 先检查完全匹配（指纹相同）
    const exactMatch = this.groupCache.get(fingerprint.fingerprint);
    if (exactMatch && exactMatch.status === 'active') {
      return exactMatch;
    }

    // 2. 检查相似组（遍历活跃组）
    for (const [groupId, group] of this.groupCache) {
      if (group.status !== 'active') continue;
      if (group.service !== errorEvent.service) continue;
      
      const similarity = this.fingerprintGenerator.similarity(fingerprint, group.fingerprint);
      if (similarity >= this.similarityThreshold) {
        return group;
      }
    }

    return null;
  }

  /**
   * 创建新聚合组
   * @private
   */
  async _createGroup(errorEvent, fingerprint) {
    const groupId = this._generateGroupId();
    
    const group = {
      id: groupId,
      fingerprint: fingerprint,
      errorCode: errorEvent.errorCode || errorEvent.error?.code,
      errorName: fingerprint.errorName,
      messagePattern: fingerprint.messagePattern,
      keyFrames: fingerprint.keyFrames,
      service: errorEvent.service,
      status: 'active',
      firstSeen: new Date(),
      lastSeen: new Date(),
      occurrenceCount: 1,
      affectedUsers: new Set([errorEvent.userId]),
      lastOccurrences: [errorEvent],
      createdAt: new Date()
    };

    // 存入缓存
    this.groupCache.set(groupId, group);
    this.groupCache.set(fingerprint.fingerprint, group);

    // 清理缓存（防止内存溢出）
    this._cleanupCache();

    return group;
  }

  /**
   * 添加错误到聚合组
   * @private
   */
  async _addToGroup(group, errorEvent, fingerprint) {
    group.lastSeen = new Date();
    group.occurrenceCount++;
    
    if (errorEvent.userId) {
      group.affectedUsers.add(errorEvent.userId);
    }

    // 保留最近 10 次发生
    group.lastOccurrences.push(errorEvent);
    if (group.lastOccurrences.length > 10) {
      group.lastOccurrences.shift();
    }

    // 更新缓存
    this.groupCache.set(group.id, group);
    this.groupCache.set(fingerprint.fingerprint, group);
  }

  /**
   * 生成组 ID
   * @private
   */
  _generateGroupId() {
    return `eg-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * 清理缓存
   * @private
   */
  _cleanupCache() {
    const now = Date.now();
    
    // 每 5 分钟清理一次
    if (now - this.lastCleanupTime < 300000) {
      return;
    }

    this.lastCleanupTime = now;

    // 清理超过聚合窗口的非活跃组
    for (const [groupId, group] of this.groupCache) {
      if (group.status === 'resolved' || group.status === 'ignored') {
        const ageMs = now - group.lastSeen.getTime();
        if (ageMs > this.aggregationWindowMs * 2) {
          this.groupCache.delete(groupId);
          this.groupCache.delete(group.fingerprint?.fingerprint);
        }
      }
    }

    // 如果超过最大组数，清理最旧的
    if (this.groupCache.size > this.maxGroups) {
      const entries = Array.from(this.groupCache.entries());
      entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      
      const toDelete = entries.slice(0, entries.length - this.maxGroups);
      for (const [groupId, group] of toDelete) {
        this.groupCache.delete(groupId);
        this.groupCache.delete(group.fingerprint?.fingerprint);
      }
    }
  }

  /**
   * 获取聚合组详情
   * @param {string} groupId - 聚合组ID
   * @returns {Object|null} 聚合组详情
   */
  getGroup(groupId) {
    const group = this.groupCache.get(groupId);
    if (!group) return null;

    return {
      id: group.id,
      errorCode: group.errorCode,
      errorName: group.errorName,
      messagePattern: group.messagePattern,
      keyFrames: group.keyFrames,
      service: group.service,
      status: group.status,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      occurrenceCount: group.occurrenceCount,
      affectedUsersCount: group.affectedUsers.size,
      sampleError: group.lastOccurrences[0]
    };
  }

  /**
   * 获取活跃聚合组列表
   * @param {Object} filters - 过滤条件
   * @returns {Array} 聚合组列表
   */
  getActiveGroups(filters = {}) {
    let groups = Array.from(this.groupCache.values())
      .filter(g => g.status === 'active');

    // 应用过滤条件
    if (filters.service) {
      groups = groups.filter(g => g.service === filters.service);
    }
    if (filters.errorCode) {
      groups = groups.filter(g => g.errorCode === filters.errorCode);
    }
    if (filters.timeRange) {
      const startTime = new Date(filters.timeRange.start);
      const endTime = new Date(filters.timeRange.end);
      groups = groups.filter(g => 
        g.lastSeen >= startTime && g.lastSeen <= endTime
      );
    }

    // 按发生次数排序
    groups.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

    // 限制返回数量
    const limit = filters.limit || 100;
    return groups.slice(0, limit).map(g => ({
      id: g.id,
      errorCode: g.errorCode,
      errorName: g.errorName,
      messagePattern: g.messagePattern,
      service: g.service,
      occurrenceCount: g.occurrenceCount,
      affectedUsersCount: g.affectedUsers.size,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen
    }));
  }

  /**
   * 标记聚合组为已解决
   * @param {string} groupId - 聚合组ID
   * @param {Object} resolution - 解决信息
   */
  async resolveGroup(groupId, resolution) {
    const group = this.groupCache.get(groupId);
    if (!group) return false;

    group.status = 'resolved';
    group.resolution = resolution;
    group.resolvedAt = new Date();
    group.resolvedBy = resolution.resolvedBy;

    return true;
  }

  /**
   * 获取聚合统计信息
   * @returns {Object} 统计信息
   */
  getStatistics() {
    const groups = Array.from(this.groupCache.values());
    
    const activeGroups = groups.filter(g => g.status === 'active');
    const resolvedGroups = groups.filter(g => g.status === 'resolved');
    
    const serviceCounts = {};
    const errorCodeCounts = {};
    
    for (const group of activeGroups) {
      serviceCounts[group.service] = (serviceCounts[group.service] || 0) + 1;
      if (group.errorCode) {
        errorCodeCounts[group.errorCode] = (errorCodeCounts[group.errorCode] || 0) + 1;
      }
    }

    return {
      totalGroups: groups.length,
      activeGroups: activeGroups.length,
      resolvedGroups: resolvedGroups.length,
      totalOccurrences: activeGroups.reduce((sum, g) => sum + g.occurrenceCount, 0),
      totalAffectedUsers: new Set(activeGroups.flatMap(g => Array.from(g.affectedUsers))).size,
      topServices: Object.entries(serviceCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      topErrorCodes: Object.entries(errorCodeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
    };
  }

  /**
   * 批量聚合错误
   * @param {Array<Object>} errorEvents - 错误事件数组
   * @returns {Object} 批量聚合结果
   */
  async aggregateBatch(errorEvents) {
    const results = [];
    
    for (const event of errorEvents) {
      const result = await this.aggregate(event);
      results.push(result);
    }

    return {
      totalProcessed: errorEvents.length,
      newGroups: results.filter(r => r.isNew).length,
      existingGroups: results.filter(r => !r.isNew).length,
      results
    };
  }
}

module.exports = ErrorAggregator;