/**
 * 根因分析引擎
 * 
 * 功能：
 * - 关联错误与最近部署
 * - 检查依赖服务状态
 * - 分析配置变更
 * - 匹配历史已知问题
 * - 生成根因推荐
 * 
 * @module RootCauseAnalyzer
 */

const logger = require('../logger');
const redis = require('../redis');

class RootCauseAnalyzer {
  constructor(dependencies = {}) {
    // 外部依赖（可注入或使用默认实现）
    this.deploymentClient = dependencies.deploymentClient || null;
    this.configClient = dependencies.configClient || null;
    this.serviceClient = dependencies.serviceClient || null;
    this.metricsClient = dependencies.metricsClient || null;
    
    // 配置
    this.config = {
      deploymentWindowMs: dependencies.deploymentWindowMs || 3600000, // 1小时
      configChangeWindowMs: dependencies.configChangeWindowMs || 1800000, // 30分钟
      dependencyCheckWindowMs: dependencies.dependencyCheckWindowMs || 300000, // 5分钟
      minConfidence: dependencies.minConfidence || 0.5
    };
    
    // Redis keys
    this.historyKey = 'error:rootcause:history';
    this.patternsKey = 'error:rootcause:patterns';
  }

  /**
   * 分析错误根因
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Object} 根因分析结果
   */
  async analyze(errorGroup) {
    try {
      const causes = [];
      
      // 并行执行所有分析任务
      const [
        deploymentCauses,
        dependencyCauses,
        configCauses,
        historicalCauses,
        trafficCauses
      ] = await Promise.all([
        this._checkRecentDeployments(errorGroup),
        this._checkDependencies(errorGroup),
        this._checkConfigChanges(errorGroup),
        this._matchHistoricalPattern(errorGroup),
        this._checkTrafficAnomaly(errorGroup)
      ]);
      
      // 合并所有原因
      causes.push(
        ...deploymentCauses,
        ...dependencyCauses,
        ...configCauses,
        ...historicalCauses,
        ...trafficCauses
      );
      
      // 按置信度排序
      causes.sort((a, b) => b.confidence - a.confidence);
      
      // 过滤低置信度结果
      const filteredCauses = causes.filter(c => c.confidence >= this.config.minConfidence);
      
      // 生成建议
      const recommendation = this._generateRecommendation(filteredCauses, errorGroup);
      
      // 保存分析结果
      await this._saveAnalysisResult(errorGroup.id, {
        causes: filteredCauses,
        recommendation
      });
      
      return {
        errorGroup: errorGroup.id,
        service: errorGroup.service,
        analyzedAt: new Date().toISOString(),
        causes: filteredCauses,
        recommendation
      };
    } catch (error) {
      logger.error('Root cause analysis failed', {
        error: error.message,
        groupId: errorGroup.id
      });
      
      return {
        errorGroup: errorGroup.id,
        analyzedAt: new Date().toISOString(),
        causes: [],
        recommendation: '分析失败，请手动排查',
        error: error.message
      };
    }
  }

  /**
   * 检查最近部署
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Array} 部署相关原因
   */
  async _checkRecentDeployments(errorGroup) {
    const causes = [];
    const firstSeen = new Date(errorGroup.firstSeen);
    const windowStart = new Date(firstSeen.getTime() - this.config.deploymentWindowMs);
    
    try {
      // 查询最近的部署记录
      const deployments = await this._getRecentDeployments(
        errorGroup.service,
        windowStart,
        firstSeen
      );
      
      for (const deployment of deployments) {
        const timeDiff = firstSeen.getTime() - new Date(deployment.deployedAt).getTime();
        const timeProximity = 1 - (timeDiff / this.config.deploymentWindowMs);
        
        causes.push({
          type: 'deployment',
          confidence: Math.min(0.9, 0.6 + timeProximity * 0.3),
          details: {
            deploymentId: deployment.id,
            version: deployment.version,
            deployedAt: deployment.deployedAt,
            deployedBy: deployment.deployedBy,
            commit: deployment.commit,
            timeDiff: `${Math.round(timeDiff / 60000)} minutes before error`
          },
          suggestion: deployment.rollbackAvailable 
            ? `考虑回滚到版本 ${deployment.previousVersion}`
            : `检查版本 ${deployment.version} 的变更日志`
        });
      }
    } catch (error) {
      logger.warn('Failed to check recent deployments', {
        error: error.message,
        service: errorGroup.service
      });
    }
    
    return causes;
  }

  /**
   * 检查依赖服务状态
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Array} 依赖服务原因
   */
  async _checkDependencies(errorGroup) {
    const causes = [];
    const firstSeen = new Date(errorGroup.firstSeen);
    const windowStart = new Date(firstSeen.getTime() - this.config.dependencyCheckWindowMs);
    
    try {
      // 获取服务的依赖列表
      const dependencies = await this._getServiceDependencies(errorGroup.service);
      
      for (const dependency of dependencies) {
        const healthStatus = await this._getServiceHealth(
          dependency.name,
          windowStart,
          firstSeen
        );
        
        if (healthStatus && healthStatus.hasIssue) {
          causes.push({
            type: 'dependency',
            confidence: 0.9,
            details: {
              dependency: dependency.name,
              issueType: healthStatus.issueType,
              errorRate: healthStatus.errorRate,
              latency: healthStatus.latency,
              affectedTimeRange: `${windowStart.toISOString()} - ${firstSeen.toISOString()}`
            },
            suggestion: `检查 ${dependency.name} 服务状态，当前错误率 ${healthStatus.errorRate}%`
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to check dependencies', {
        error: error.message,
        service: errorGroup.service
      });
    }
    
    return causes;
  }

  /**
   * 检查配置变更
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Array} 配置变更原因
   */
  async _checkConfigChanges(errorGroup) {
    const causes = [];
    const firstSeen = new Date(errorGroup.firstSeen);
    const windowStart = new Date(firstSeen.getTime() - this.config.configChangeWindowMs);
    
    try {
      const configChanges = await this._getRecentConfigChanges(
        errorGroup.service,
        windowStart,
        firstSeen
      );
      
      for (const change of configChanges) {
        causes.push({
          type: 'config_change',
          confidence: 0.7,
          details: {
            configKey: change.key,
            oldValue: change.oldValue,
            newValue: change.newValue,
            changedAt: change.changedAt,
            changedBy: change.changedBy
          },
          suggestion: `检查配置项 ${change.key} 的变更，考虑回滚或验证新值`
        });
      }
    } catch (error) {
      logger.warn('Failed to check config changes', {
        error: error.message,
        service: errorGroup.service
      });
    }
    
    return causes;
  }

  /**
   * 匹配历史已知问题
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Array} 历史匹配原因
   */
  async _matchHistoricalPattern(errorGroup) {
    const causes = [];
    
    try {
      // 从历史记录中查找相似问题
      const historicalMatches = await this._findHistoricalMatches(errorGroup);
      
      for (const match of historicalMatches) {
        causes.push({
          type: 'known_issue',
          confidence: match.similarity,
          details: {
            historicalGroupId: match.groupId,
            historicalTime: match.occurredAt,
            resolution: match.resolution,
            resolvedBy: match.resolvedBy
          },
          suggestion: match.resolution 
            ? `已知问题：${match.resolution}`
            : '此问题在历史记录中出现过，但未记录解决方案'
        });
      }
    } catch (error) {
      logger.warn('Failed to match historical patterns', {
        error: error.message,
        groupId: errorGroup.id
      });
    }
    
    return causes;
  }

  /**
   * 检查流量异常
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Array} 流量相关原因
   */
  async _checkTrafficAnomaly(errorGroup) {
    const causes = [];
    const firstSeen = new Date(errorGroup.firstSeen);
    
    try {
      // 检查是否有流量突增
      const trafficData = await this._getTrafficData(errorGroup.service, firstSeen);
      
      if (trafficData && trafficData.hasSpike) {
        causes.push({
          type: 'traffic_spike',
          confidence: 0.75,
          details: {
            normalRate: trafficData.normalRate,
            currentRate: trafficData.currentRate,
            spikeRatio: trafficData.spikeRatio,
            spikeTime: trafficData.spikeTime
          },
          suggestion: `流量突增 ${trafficData.spikeRatio} 倍，考虑扩容或限流`
        });
      }
    } catch (error) {
      logger.warn('Failed to check traffic anomaly', {
        error: error.message,
        service: errorGroup.service
      });
    }
    
    return causes;
  }

  /**
   * 生成建议
   * @param {Array} causes - 原因列表
   * @param {Object} errorGroup - 错误聚合组
   * @returns {string} 建议
   */
  _generateRecommendation(causes, errorGroup) {
    if (causes.length === 0) {
      return '未找到明确的根因，建议手动排查日志和监控';
    }
    
    const topCause = causes[0];
    
    switch (topCause.type) {
      case 'deployment':
        return `【优先处理】新部署版本可能存在问题。${topCause.suggestion}`;
        
      case 'dependency':
        return `【优先处理】依赖服务 ${topCause.details.dependency} 异常。${topCause.suggestion}`;
        
      case 'config_change':
        return `【建议检查】最近有配置变更。${topCause.suggestion}`;
        
      case 'known_issue':
        return `【已知问题】${topCause.suggestion}`;
        
      case 'traffic_spike':
        return `【流量问题】${topCause.suggestion}`;
        
      default:
        return topCause.suggestion || '请手动排查';
    }
  }

  /**
   * 保存分析结果
   * @param {string} groupId - 聚合组ID
   * @param {Object} result - 分析结果
   */
  async _saveAnalysisResult(groupId, result) {
    try {
      const key = `${this.historyKey}:${groupId}`;
      await redis.setex(key, 2592000, JSON.stringify({
        ...result,
        analyzedAt: new Date().toISOString()
      }));
    } catch (error) {
      logger.error('Failed to save analysis result', {
        error: error.message,
        groupId
      });
    }
  }

  /**
   * 获取历史分析结果
   * @param {string} groupId - 聚合组ID
   * @returns {Object|null} 历史分析结果
   */
  async getHistoricalAnalysis(groupId) {
    try {
      const key = `${this.historyKey}:${groupId}`;
      const data = await redis.get(key);
      
      if (data) {
        return JSON.parse(data);
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get historical analysis', {
        error: error.message,
        groupId
      });
      return null;
    }
  }

  // ========== 模拟数据方法（实际项目中应替换为真实数据源） ==========

  /**
   * 获取最近部署记录
   */
  async _getRecentDeployments(service, startTime, endTime) {
    // 实际实现：从 CI/CD 系统（如 GitHub Actions）获取部署记录
    // 这里返回模拟数据
    if (!this.deploymentClient) return [];
    
    try {
      return await this.deploymentClient.getDeployments({
        service,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString()
      });
    } catch {
      return [];
    }
  }

  /**
   * 获取服务依赖列表
   */
  async _getServiceDependencies(service) {
    // 实际实现：从服务注册中心获取依赖关系
    // 这里返回常见依赖
    const dependencyMap = {
      'gateway': ['user-service', 'pokemon-service', 'catch-service'],
      'catch-service': ['pokemon-service', 'location-service', 'reward-service'],
      'gym-service': ['user-service', 'pokemon-service', 'reward-service'],
      'social-service': ['user-service', 'notification-service'],
      'payment-service': ['user-service', 'reward-service'],
      'user-service': [],
      'pokemon-service': [],
      'location-service': [],
      'reward-service': []
    };
    
    return (dependencyMap[service] || []).map(name => ({ name }));
  }

  /**
   * 获取服务健康状态
   */
  async _getServiceHealth(serviceName, startTime, endTime) {
    // 实际实现：从 Prometheus 查询服务健康指标
    if (!this.metricsClient) return null;
    
    try {
      const errorRate = await this.metricsClient.query(
        `rate(http_requests_total{service="${serviceName}",status=~"5.."}[5m])`,
        startTime,
        endTime
      );
      
      return {
        hasIssue: errorRate > 5,
        issueType: errorRate > 20 ? 'critical' : 'degraded',
        errorRate: Math.round(errorRate * 100) / 100,
        latency: await this.metricsClient.query(
          `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{service="${serviceName}"}[5m]))`,
          startTime,
          endTime
        )
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取最近配置变更
   */
  async _getRecentConfigChanges(service, startTime, endTime) {
    // 实际实现：从配置中心获取变更记录
    if (!this.configClient) return [];
    
    try {
      return await this.configClient.getChanges({
        service,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString()
      });
    } catch {
      return [];
    }
  }

  /**
   * 查找历史匹配
   */
  async _findHistoricalMatches(errorGroup) {
    // 从 Redis 历史记录中查找相似问题
    try {
      const patternKey = `error:pattern:${errorGroup.fingerprint}`;
      const match = await redis.get(patternKey);
      
      if (match) {
        return [JSON.parse(match)];
      }
      
      return [];
    } catch {
      return [];
    }
  }

  /**
   * 获取流量数据
   */
  async _getTrafficData(service, time) {
    // 实际实现：从 Prometheus 查询流量指标
    if (!this.metricsClient) return null;
    
    try {
      const currentRate = await this.metricsClient.query(
        `rate(http_requests_total{service="${service}"}[5m])`,
        time
      );
      
      const baselineRate = await this.metricsClient.query(
        `avg_over_time(rate(http_requests_total{service="${service}"}[5m])[1h])`,
        time
      );
      
      const spikeRatio = currentRate / baselineRate;
      
      return {
        hasSpike: spikeRatio > 2,
        normalRate: baselineRate,
        currentRate,
        spikeRatio: Math.round(spikeRatio * 10) / 10,
        spikeTime: time.toISOString()
      };
    } catch {
      return null;
    }
  }

  /**
   * 注册已知问题模式
   * @param {Object} pattern - 问题模式
   */
  async registerPattern(pattern) {
    try {
      const key = `error:pattern:${pattern.fingerprint}`;
      await redis.setex(key, 7776000, JSON.stringify({
        groupId: pattern.groupId,
        occurredAt: pattern.occurredAt,
        resolution: pattern.resolution,
        resolvedBy: pattern.resolvedBy,
        similarity: 0.95
      }));
      
      logger.info('Registered error pattern', { fingerprint: pattern.fingerprint });
    } catch (error) {
      logger.error('Failed to register pattern', { error: error.message });
    }
  }
}

module.exports = RootCauseAnalyzer;