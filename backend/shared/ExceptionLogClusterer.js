/**
 * REQ-00555: 异常日志聚类器
 * 实时聚类异常日志，自动聚合相似异常
 */

const ExceptionFingerprintGenerator = require('./ExceptionFingerprintGenerator');

class ExceptionLogClusterer {
  constructor(config = {}) {
    this.fingerprintGenerator = new ExceptionFingerprintGenerator(config.fingerprint);
    
    // 聚类存储
    this.clusters = new Map();  // fingerprintId -> Cluster
    this.recentLogs = [];       // 最近的日志条目（用于滑动窗口）
    
    // 配置
    this.config = {
      windowSize: config.windowSize || 300,           // 5分钟窗口（秒）
      similarityThreshold: config.similarityThreshold || 0.85,
      maxClusters: config.maxClusters || 1000,
      maxMembersPerCluster: config.maxMembersPerCluster || 100,
      cleanupInterval: config.cleanupInterval || 60000,  // 1分钟清理一次
    };
    
    // 统计信息
    this.stats = {
      totalProcessed: 0,
      totalClustered: 0,
      totalUnique: 0,
      lastCleanup: new Date()
    };
    
    // 启动定时清理
    this._startCleanup();
  }

  /**
   * 处理单条日志
   * @param {Object} logEntry - 日志条目
   * @returns {Object} 聚类结果
   */
  processLog(logEntry) {
    this.stats.totalProcessed++;
    
    // 只处理错误级别日志
    if (!this._isErrorLog(logEntry)) {
      return null;
    }
    
    // 生成指纹
    const fingerprint = this.fingerprintGenerator.generateFingerprint(logEntry);
    
    // 查找匹配的集群
    let cluster = this._findMatchingCluster(fingerprint);
    
    if (cluster) {
      // 添加到现有集群
      cluster.addMember(logEntry, fingerprint);
      this.stats.totalClustered++;
    } else {
      // 创建新集群
      cluster = this._createCluster(logEntry, fingerprint);
      this.stats.totalUnique++;
    }
    
    // 保存最近日志
    this._addToRecentLogs(logEntry, fingerprint);
    
    return {
      fingerprint,
      cluster: cluster.getSummary(),
      isNew: cluster.memberCount === 1
    };
  }

  /**
   * 批量处理日志
   */
  processBatch(logEntries) {
    return logEntries
      .map(log => this.processLog(log))
      .filter(Boolean);
  }

  /**
   * 查找匹配的集群
   */
  _findMatchingCluster(fingerprint) {
    // 先尝试精确匹配
    const exactMatch = this.clusters.get(fingerprint.fingerprintId);
    if (exactMatch && !exactMatch.isFull()) {
      return exactMatch;
    }
    
    // 相似度匹配
    for (const cluster of this.clusters.values()) {
      if (cluster.isFull()) continue;
      
      const similarity = this.fingerprintGenerator.calculateSimilarity(
        cluster.representativeFingerprint,
        fingerprint
      );
      
      if (similarity >= this.config.similarityThreshold) {
        return cluster;
      }
    }
    
    return null;
  }

  /**
   * 创建新集群
   */
  _createCluster(logEntry, fingerprint) {
    // 检查是否达到最大集群数
    if (this.clusters.size >= this.config.maxClusters) {
      this._evictOldestCluster();
    }
    
    const cluster = new LogCluster(fingerprint, logEntry, this.config.maxMembersPerCluster);
    this.clusters.set(fingerprint.fingerprintId, cluster);
    
    return cluster;
  }

  /**
   * 驱逐最老的集群
   */
  _evictOldestCluster() {
    let oldestKey = null;
    let oldestTime = Infinity;
    
    for (const [key, cluster] of this.clusters.entries()) {
      if (cluster.lastUpdated < oldestTime) {
        oldestTime = cluster.lastUpdated;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      this.clusters.delete(oldestKey);
    }
  }

  /**
   * 检查是否为错误日志
   */
  _isErrorLog(logEntry) {
    const level = (logEntry.level || '').toLowerCase();
    return level === 'error' || level === 'fatal' || level === 'critical';
  }

  /**
   * 添加到最近日志列表
   */
  _addToRecentLogs(logEntry, fingerprint) {
    this.recentLogs.push({
      log: logEntry,
      fingerprint,
      timestamp: Date.now()
    });
    
    // 维护窗口大小
    this._trimRecentLogs();
  }

  /**
   * 清理过期的最近日志
   */
  _trimRecentLogs() {
    const cutoff = Date.now() - this.config.windowSize * 1000;
    while (this.recentLogs.length > 0 && this.recentLogs[0].timestamp < cutoff) {
      this.recentLogs.shift();
    }
  }

  /**
   * 启动定时清理
   */
  _startCleanup() {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * 清理过期集群
   */
  cleanup() {
    const cutoff = Date.now() - this.config.windowSize * 1000;
    
    for (const [key, cluster] of this.clusters.entries()) {
      if (cluster.lastUpdated < cutoff) {
        this.clusters.delete(key);
      }
    }
    
    this._trimRecentLogs();
    this.stats.lastCleanup = new Date();
  }

  /**
   * 获取集群统计信息
   */
  getClusterStats() {
    const clusters = Array.from(this.clusters.values());
    
    return {
      totalClusters: clusters.length,
      totalMembers: clusters.reduce((sum, c) => sum + c.memberCount, 0),
      topClusters: clusters
        .sort((a, b) => b.memberCount - a.memberCount)
        .slice(0, 10)
        .map(c => c.getSummary()),
      recentLogCount: this.recentLogs.length,
      stats: this.stats
    };
  }

  /**
   * 获取指定集群详情
   */
  getClusterDetails(fingerprintId) {
    const cluster = this.clusters.get(fingerprintId);
    return cluster ? cluster.getDetails() : null;
  }

  /**
   * 停止清理器
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

/**
 * 日志集群类
 */
class LogCluster {
  constructor(fingerprint, firstLog, maxMembers) {
    this.fingerprintId = fingerprint.fingerprintId;
    this.representativeFingerprint = fingerprint;
    this.representativeLog = firstLog;
    this.members = [{
      log: firstLog,
      fingerprint,
      timestamp: Date.now()
    }];
    this.maxMembers = maxMembers;
    this.createdAt = Date.now();
    this.lastUpdated = Date.now();
    
    // 统计
    this.occurrences = 1;
    this.services = new Set([fingerprint.service]);
  }

  addMember(logEntry, fingerprint) {
    if (this.members.length >= this.maxMembers) {
      // 移除最老的成员
      this.members.shift();
    }
    
    this.members.push({
      log: logEntry,
      fingerprint,
      timestamp: Date.now()
    });
    
    this.occurrences++;
    this.services.add(fingerprint.service);
    this.lastUpdated = Date.now();
  }

  isFull() {
    return this.members.length >= this.maxMembers;
  }

  get memberCount() {
    return this.occurrences;  // 总出现次数
  }

  getSummary() {
    return {
      fingerprintId: this.fingerprintId,
      exceptionType: this.representativeFingerprint.exceptionType,
      message: this.representativeFingerprint.normalizedMessage.substring(0, 100),
      memberCount: this.occurrences,
      serviceCount: this.services.size,
      services: Array.from(this.services).slice(0, 5),
      createdAt: new Date(this.createdAt).toISOString(),
      lastUpdated: new Date(this.lastUpdated).toISOString()
    };
  }

  getDetails() {
    return {
      ...this.getSummary(),
      representativeLog: this.representativeLog,
      stackSignature: this.representativeFingerprint.stackSignature,
      codeLocations: this.representativeFingerprint.codeLocations,
      recentMembers: this.members.slice(-20).map(m => ({
        timestamp: new Date(m.timestamp).toISOString(),
        service: m.fingerprint.service,
        message: m.log.message?.substring(0, 50)
      }))
    };
  }
}

module.exports = ExceptionLogClusterer;