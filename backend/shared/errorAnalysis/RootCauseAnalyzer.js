/**
 * RootCauseAnalyzer - 根因分析引擎
 * 
 * 功能：
 * - 关联错误与最近部署、配置变更
 * - 检查依赖服务状态
 * - 匹配历史错误模式
 * - 生成修复建议
 * 
 * @module backend/shared/errorAnalysis/RootCauseAnalyzer
 */

'use strict';

class RootCauseAnalyzer {
  /**
   * 构造函数
   * @param {Object} dependencies - 依赖项
   */
  constructor(dependencies = {}) {
    this.deploymentClient = dependencies.deploymentClient;  // CI/CD API
    this.configClient = dependencies.configClient;           // Config Center
    this.serviceClient = dependencies.serviceClient;          // Service Registry
    this.metricsClient = dependencies.metricsClient;          // Prometheus
    this.dbClient = dependencies.dbClient;                    // PostgreSQL
    
    // 根因模式库
    this.patternLibrary = this._initializePatternLibrary();
  }

  /**
   * 分析错误根因
   * @param {Object} errorGroup - 错误聚合组
   * @returns {Object} 根因分析结果
   */
  async analyze(errorGroup) {
    const causes = [];

    // 并行执行各项检查
    const [
      deployments,
      dependencies,
      configChanges,
      trafficAnomaly,
      historicalMatch
    ] = await Promise.all([
      this._checkRecentDeployments(errorGroup),
      this._checkDependencies(errorGroup),
      this._checkConfigChanges(errorGroup),
      this._checkTrafficAnomaly(errorGroup),
      this._matchHistoricalPattern(errorGroup)
    ]);

    // 汇总发现的根因
    if (deployments.length > 0) {
      causes.push({
        type: 'deployment',
        confidence: 0.8,
        details: deployments,
        description: this._describeDeploymentCause(deployments)
      });
    }

    if (dependencies.length > 0) {
      causes.push({
        type: 'dependency',
        confidence: 0.9,
        details: dependencies,
        description: this._describeDependencyCause(dependencies)
      });
    }

    if (configChanges.length > 0) {
      causes.push({
        type: 'config_change',
        confidence: 0.7,
        details: configChanges,
        description: this._describeConfigCause(configChanges)
      });
    }

    if (trafficAnomaly) {
      causes.push({
        type: 'traffic_anomaly',
        confidence: 0.6,
        details: trafficAnomaly,
        description: this._describeTrafficCause(trafficAnomaly)
      });
    }

    if (historicalMatch) {
      causes.push({
        type: 'known_issue',
        confidence: 0.95,
        details: historicalMatch,
        description: this._describeHistoricalCause(historicalMatch)
      });
    }

    // 按置信度排序
    causes.sort((a, b) => b.confidence - a.confidence);

    return {
      errorGroup: errorGroup.id,
      causes,
      recommendation: this._generateRecommendation(causes),
      analyzedAt: new Date()
    };
  }

  /**
   * 检查最近部署
   * @private
   */
  async _checkRecentDeployments(errorGroup) {
    const deployments = [];
    const timeWindow = 30 * 60 * 1000; // 30 分钟窗口

    // 如果有部署客户端，查询最近部署
    if (this.deploymentClient) {
      try {
        const recentDeploys = await this.deploymentClient.getRecentDeploys({
          service: errorGroup.service,
          since: new Date(Date.now() - timeWindow)
        });

        for (const deploy of recentDeploys) {
          // 检查部署时间是否与错误首次出现时间接近
          const deployTime = new Date(deploy.timestamp).getTime();
          const errorTime = errorGroup.firstSeen.getTime();
          const timeDiff = Math.abs(errorTime - deployTime);

          if (timeDiff < timeWindow) {
            deployments.push({
              deployId: deploy.id,
              version: deploy.version,
              timestamp: deploy.timestamp,
              timeDiff: Math.round(timeDiff / 1000 / 60), // 分钟
              changes: deploy.changes || []
            });
          }
        }
      } catch (err) {
        console.error('Failed to check deployments:', err.message);
      }
    }

    return deployments;
  }

  /**
   * 检查依赖服务状态
   * @private
   */
  async _checkDependencies(errorGroup) {
    const failures = [];

    // 定义服务依赖关系
    const serviceDependencies = {
      'catch-service': ['pokemon-service', 'location-service', 'user-service'],
      'gym-service': ['user-service', 'pokemon-service'],
      'payment-service': ['user-service', 'reward-service'],
      'social-service': ['user-service'],
      'gateway': ['all']
    };

    const deps = serviceDependencies[errorGroup.service] || [];

    if (this.serviceClient) {
      for (const dep of deps) {
        try {
          const health = await this.serviceClient.getHealth(dep);
          if (health.status !== 'healthy') {
            failures.push({
              service: dep,
              status: health.status,
              errorRate: health.errorRate,
              latency: health.latency
            });
          }
        } catch (err) {
          failures.push({
            service: dep,
            status: 'unknown',
            error: err.message
          });
        }
      }
    }

    return failures;
  }

  /**
   * 检查配置变更
   * @private
   */
  async _checkConfigChanges(errorGroup) {
    const changes = [];
    const timeWindow = 60 * 60 * 1000; // 1 小时窗口

    if (this.configClient) {
      try {
        const recentChanges = await this.configClient.getChanges({
          service: errorGroup.service,
          since: new Date(Date.now() - timeWindow)
        });

        for (const change of recentChanges) {
          const changeTime = new Date(change.timestamp).getTime();
          const errorTime = errorGroup.firstSeen.getTime();
          const timeDiff = Math.abs(errorTime - changeTime);

          if (timeDiff < timeWindow) {
            changes.push({
              configKey: change.key,
              oldValue: change.oldValue,
              newValue: change.newValue,
              timestamp: change.timestamp,
              changedBy: change.changedBy
            });
          }
        }
      } catch (err) {
        console.error('Failed to check config changes:', err.message);
      }
    }

    return changes;
  }

  /**
   * 检查流量异常
   * @private
   */
  async _checkTrafficAnomaly(errorGroup) {
    if (!this.metricsClient) return null;

    try {
      const metrics = await this.metricsClient.query({
        service: errorGroup.service,
        metric: 'http_requests_total',
        range: '1h'
      });

      // 计算流量变化率
      const currentRate = metrics.current || 0;
      const baselineRate = metrics.baseline || 0;
      
      if (baselineRate > 0) {
        const changeRate = (currentRate - baselineRate) / baselineRate;
        
        // 流量突增超过 50%
        if (changeRate > 0.5) {
          return {
            type: 'spike',
            changeRate: Math.round(changeRate * 100),
            currentRate,
            baselineRate
          };
        }
      }
    } catch (err) {
      console.error('Failed to check traffic anomaly:', err.message);
    }

    return null;
  }

  /**
   * 匹配历史模式
   * @private
   */
  async _matchHistoricalPattern(errorGroup) {
    if (!this.dbClient) return null;

    try {
      // 查询相似的已解决错误
      const result = await this.dbClient.query(`
        SELECT 
          id, error_code, message_pattern, resolution, resolved_at,
          similarity(key_frames, $1) as sim_score
        FROM error_groups
        WHERE status = 'resolved'
          AND resolution IS NOT NULL
        ORDER BY sim_score DESC
        LIMIT 5
      `, [JSON.stringify(errorGroup.keyFrames)]);

      if (result.rows.length > 0 && result.rows[0].sim_score > 0.7) {
        return {
          matchedGroupId: result.rows[0].id,
          similarity: result.rows[0].sim_score,
          previousResolution: result.rows[0].resolution,
          resolvedAt: result.rows[0].resolved_at
        };
      }
    } catch (err) {
      console.error('Failed to match historical pattern:', err.message);
    }

    return null;
  }

  /**
   * 初始化模式库
   * @private
   */
  _initializePatternLibrary() {
    return [
      {
        pattern: /ECONNREFUSED/,
        type: 'network',
        cause: '服务连接被拒绝',
        solution: '检查目标服务是否运行，防火墙配置是否正确'
      },
      {
        pattern: /ETIMEDOUT/,
        type: 'timeout',
        cause: '请求超时',
        solution: '检查网络延迟、目标服务负载，考虑增加超时时间'
      },
      {
        pattern: /Out of memory/,
        type: 'resource',
        cause: '内存不足',
        solution: '检查内存泄漏，增加容器内存限制'
      },
      {
        pattern: /duplicate key value/,
        type: 'database',
        cause: '数据库唯一约束冲突',
        solution: '检查数据插入逻辑，确保唯一性约束正确'
      },
      {
        pattern: /connection pool exhausted/,
        type: 'database',
        cause: '数据库连接池耗尽',
        solution: '检查连接泄漏，增加连接池大小'
      }
    ];
  }

  /**
   * 生成修复建议
   * @private
   */
  _generateRecommendation(causes) {
    if (causes.length === 0) {
      return {
        priority: 'medium',
        actions: ['查看详细日志', '检查服务健康状态', '联系开发团队']
      };
    }

    const topCause = causes[0];
    
    switch (topCause.type) {
      case 'deployment':
        return {
          priority: 'high',
          actions: [
            '回滚到上一版本',
            '检查新版本变更内容',
            '查看部署日志'
          ],
          rollbackVersion: topCause.details[0]?.version
        };

      case 'dependency':
        return {
          priority: 'critical',
          actions: [
            '检查依赖服务状态',
            '启用服务降级',
            '联系依赖服务负责人'
          ],
          affectedServices: topCause.details.map(d => d.service)
        };

      case 'config_change':
        return {
          priority: 'high',
          actions: [
            '回滚配置变更',
            '验证配置值正确性',
            '检查配置影响范围'
          ]
        };

      case 'traffic_anomaly':
        return {
          priority: 'medium',
          actions: [
            '启用限流',
            '增加服务副本数',
            '检查异常流量来源'
          ]
        };

      case 'known_issue':
        return {
          priority: 'low',
          actions: [
            '参考历史解决方案',
            '复用之前修复方案',
            '验证修复效果'
          ],
          previousSolution: topCause.details.previousResolution
        };

      default:
        return {
          priority: 'medium',
          actions: ['调查根因', '查看详细日志']
        };
    }
  }

  /**
   * 描述部署根因
   * @private
   */
  _describeDeploymentCause(deployments) {
    if (deployments.length === 0) return '';
    const d = deployments[0];
    return `服务 ${d.version} 版本部署后 ${d.timeDiff} 分钟出现错误`;
  }

  /**
   * 描述依赖服务根因
   * @private
   */
  _describeDependencyCause(dependencies) {
    if (dependencies.length === 0) return '';
    return `依赖服务 ${dependencies[0].service} 状态异常: ${dependencies[0].status}`;
  }

  /**
   * 描述配置变更根因
   * @private
   */
  _describeConfigCause(changes) {
    if (changes.length === 0) return '';
    return `配置 ${changes[0].configKey} 已变更`;
  }

  /**
   * 描述流量异常根因
   * @private
   */
  _describeTrafficCause(anomaly) {
    if (!anomaly) return '';
    return `流量增加 ${anomaly.changeRate}%`;
  }

  /**
   * 描述历史匹配根因
   * @private
   */
  _describeHistoricalCause(match) {
    if (!match) return '';
    return `与历史问题相似度 ${Math.round(match.similarity * 100)}%`;
  }
}

module.exports = RootCauseAnalyzer;
