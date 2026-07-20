/**
 * 灾难演练引擎
 * 
 * 提供自动化灾难恢复演练能力，包括：
 * - 演练场景定义和管理
 * - Chaos Mesh 集成
 * - SLO 监控
 * - 演练报告生成
 * 
 * @module backend/shared/drillEngine
 */

'use strict';

const logger = require('./logger')('drill-engine');
const { KubernetesClient } = require('./k8sClient');
const { PrometheusClient } = require('./prometheusClient');
const fs = require('fs').promises;
const path = require('path');

/**
 * 演练场景定义
 */
class DrillScenario {
  constructor(config) {
    this.id = config.id || `drill-${Date.now()}`;
    this.name = config.name;
    this.type = config.type || 'full'; // full, partial, dry-run
    this.description = config.description;
    this.chaosExperiments = config.chaosExperiments || [];
    this.duration = config.duration || 1800000; // 默认 30 分钟
    this.targetServices = config.targetServices || [];
    this.targetRegion = config.targetRegion;
    this.rtoTarget = config.rtoTarget || 300000; // 5 分钟
    this.rpoTarget = config.rpoTarget || 60000; // 1 分钟
    this.autoRollback = config.autoRollback !== false;
    this.notifyChannels = config.notifyChannels || ['slack'];
    this.metadata = config.metadata || {};
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      description: this.description,
      chaosExperiments: this.chaosExperiments,
      duration: this.duration,
      targetServices: this.targetServices,
      targetRegion: this.targetRegion,
      rtoTarget: this.rtoTarget,
      rpoTarget: this.rpoTarget,
      autoRollback: this.autoRollback,
      notifyChannels: this.notifyChannels,
      metadata: this.metadata
    };
  }
}

/**
 * 演练执行器
 */
class DrillExecutor {
  constructor(k8sClient, prometheusClient) {
    this.k8s = k8sClient;
    this.prometheus = prometheusClient;
    this.activeExperiments = new Map();
  }

  /**
   * 执行演练场景
   */
  async executeScenario(scenario) {
    logger.info({ scenarioId: scenario.id, name: scenario.name }, '开始执行演练场景');

    const execution = {
      id: `exec-${Date.now()}`,
      scenarioId: scenario.id,
      startTime: new Date().toISOString(),
      status: 'running',
      experiments: [],
      metrics: {
        baseline: {},
        during: {},
        after: {}
      }
    };

    try {
      // 1. 收集基准指标
      logger.info('收集基准指标...');
      execution.metrics.baseline = await this.collectBaselineMetrics();

      // 2. 注入混沌实验
      logger.info({ count: scenario.chaosExperiments.length }, '注入混沌实验');
      for (const experiment of scenario.chaosExperiments) {
        const result = await this.injectChaos(experiment);
        execution.experiments.push(result);
        this.activeExperiments.set(result.experimentId, result);
      }

      // 3. 监控演练过程
      logger.info('监控演练过程...');
      const monitoringInterval = setInterval(async () => {
        const metrics = await this.collectCurrentMetrics();
        execution.metrics.during = { ...execution.metrics.during, ...metrics };
      }, 30000); // 每 30 秒收集一次

      // 4. 等待演练完成
      await this.sleep(scenario.duration);

      // 5. 停止监控
      clearInterval(monitoringInterval);

      // 6. 回滚混沌实验
      if (scenario.autoRollback) {
        logger.info('自动回滚混沌实验...');
        await this.rollbackAll();
      }

      // 7. 收集恢复后指标
      logger.info('收集恢复后指标...');
      await this.sleep(60000); // 等待 1 分钟让系统稳定
      execution.metrics.after = await this.collectCurrentMetrics();

      // 8. 计算演练结果
      execution.status = 'completed';
      execution.endTime = new Date().toISOString();
      execution.duration = new Date(execution.endTime) - new Date(execution.startTime);
      execution.results = this.calculateResults(execution);

      logger.info({ executionId: execution.id }, '演练场景执行完成');
      return execution;

    } catch (error) {
      logger.error({ error: error.message }, '演练执行失败');
      execution.status = 'failed';
      execution.error = error.message;
      execution.endTime = new Date().toISOString();

      // 自动回滚
      if (scenario.autoRollback) {
        await this.rollbackAll();
      }

      throw error;
    }
  }

  /**
   * 注入混沌实验
   */
  async injectChaos(experimentConfig) {
    const experimentId = `chaos-${Date.now()}`;
    
    logger.info({ experimentId, type: experimentConfig.kind }, '注入混沌实验');

    try {
      // 使用 Kubernetes API 创建 Chaos Mesh 资源
      const chaosResource = {
        apiVersion: 'chaos-mesh.org/v1alpha1',
        kind: experimentConfig.kind,
        metadata: {
          name: experimentId,
          namespace: 'minego'
        },
        spec: experimentConfig.spec
      };

      const result = await this.k8s.createCustomResource(chaosResource);
      
      return {
        experimentId,
        kind: experimentConfig.kind,
        status: 'injected',
        createdAt: new Date().toISOString(),
        resource: result
      };

    } catch (error) {
      logger.error({ error: error.message, experimentId }, '注入混沌实验失败');
      throw error;
    }
  }

  /**
   * 回滚所有混沌实验
   */
  async rollbackAll() {
    logger.info({ count: this.activeExperiments.size }, '回滚所有混沌实验');

    const rollbackPromises = [];
    
    for (const [experimentId, experiment] of this.activeExperiments) {
      rollbackPromises.push(this.rollbackExperiment(experimentId, experiment.kind));
    }

    await Promise.allSettled(rollbackPromises);
    this.activeExperiments.clear();
  }

  /**
   * 回滚单个混沌实验
   */
  async rollbackExperiment(experimentId, kind) {
    try {
      logger.info({ experimentId, kind }, '回滚混沌实验');
      
      await this.k8s.deleteCustomResource({
        apiVersion: 'chaos-mesh.org/v1alpha1',
        kind: kind,
        namespace: 'minego',
        name: experimentId
      });

      logger.info({ experimentId }, '混沌实验已回滚');
      return { experimentId, status: 'rolled-back' };

    } catch (error) {
      logger.error({ error: error.message, experimentId }, '回滚混沌实验失败');
      throw error;
    }
  }

  /**
   * 收集基准指标
   */
  async collectBaselineMetrics() {
    const metrics = {};

    try {
      // 收集关键服务的 SLO 指标
      metrics.availability = await this.prometheus.query('avg_over_time(up{namespace="minego"}[5m])');
      metrics.latency = await this.prometheus.query('avg_over_time(http_request_duration_seconds_bucket{namespace="minego"}[5m])');
      metrics.errorRate = await this.prometheus.query('avg_over_time(http_requests_total{status=~"5..",namespace="minego"}[5m])');
      metrics.throughput = await this.prometheus.query('sum(rate(http_requests_total{namespace="minego"}[5m]))');

      logger.info({ metrics }, '基准指标收集完成');
      return metrics;

    } catch (error) {
      logger.error({ error: error.message }, '收集基准指标失败');
      return {};
    }
  }

  /**
   * 收集当前指标
   */
  async collectCurrentMetrics() {
    const timestamp = Date.now();
    const metrics = {};

    try {
      metrics.availability = await this.prometheus.query('avg(up{namespace="minego"})');
      metrics.latency = await this.prometheus.query('avg(http_request_duration_seconds_bucket{namespace="minego"})');
      metrics.errorRate = await this.prometheus.query('sum(rate(http_requests_total{status=~"5..",namespace="minego"}[1m]))');
      metrics.throughput = await this.prometheus.query('sum(rate(http_requests_total{namespace="minego"}[1m]))');
      metrics.timestamp = timestamp;

      return metrics;

    } catch (error) {
      logger.error({ error: error.message }, '收集当前指标失败');
      return { timestamp };
    }
  }

  /**
   * 计算演练结果
   */
  calculateResults(execution) {
    const results = {
      sloCompliance: {},
      rto: 0,
      rpo: 0,
      impactAnalysis: {},
      recoveryAnalysis: {}
    };

    try {
      const baseline = execution.metrics.baseline;
      const during = execution.metrics.during;
      const after = execution.metrics.after;

      // 计算 SLO 合规性
      if (baseline.availability && after.availability) {
        const availabilityDrop = baseline.availability - during.availability;
        const recoveryRate = after.availability / baseline.availability;
        
        results.sloCompliance.availability = {
          baseline: baseline.availability,
          minimum: during.availability,
          recovered: after.availability,
          drop: availabilityDrop,
          recoveryRate: recoveryRate,
          passed: availabilityDrop < 0.05 // 可用性下降不超过 5%
        };
      }

      // 计算延迟影响
      if (baseline.latency && after.latency) {
        const latencyIncrease = (during.latency - baseline.latency) / baseline.latency;
        
        results.sloCompliance.latency = {
          baseline: baseline.latency,
          peak: during.latency,
          recovered: after.latency,
          increase: latencyIncrease,
          passed: latencyIncrease < 0.5 // 延迟增加不超过 50%
        };
      }

      // 计算错误率影响
      if (baseline.errorRate && after.errorRate) {
        results.sloCompliance.errorRate = {
          baseline: baseline.errorRate,
          peak: during.errorRate,
          recovered: after.errorRate,
          passed: during.errorRate < 0.05 // 错误率不超过 5%
        };
      }

      // 估算 RTO（恢复时间目标）
      // 从第一个混沌实验注入到最后恢复到基线的时间
      const recoveryTime = new Date(execution.endTime) - new Date(execution.startTime);
      results.rto = recoveryTime;

      // 估算 RPO（恢复点目标）
      // 这里简化处理，实际需要检查数据备份和恢复情况
      results.rpo = 60000; // 假设 1 分钟

      // 影响分析
      results.impactAnalysis = {
        affectedServices: execution.experiments.length,
        totalExperiments: execution.chaosExperiments,
        duration: execution.duration,
        overallImpact: this.calculateOverallImpact(results.sloCompliance)
      };

      // 恢复分析
      results.recoveryAnalysis = {
        autoRollbackSuccess: true,
        recoveryTime: recoveryTime,
        dataLoss: false, // 需要实际检查
        recoveredServices: execution.experiments.length
      };

      logger.info({ results }, '演练结果计算完成');
      return results;

    } catch (error) {
      logger.error({ error: error.message }, '计算演练结果失败');
      return results;
    }
  }

  /**
   * 计算总体影响评分
   */
  calculateOverallImpact(sloCompliance) {
    const scores = [];
    
    for (const key of Object.keys(sloCompliance)) {
      if (sloCompliance[key].passed) {
        scores.push(1);
      } else {
        scores.push(0);
      }
    }

    if (scores.length === 0) return 'unknown';
    
    const average = scores.reduce((a, b) => a + b, 0) / scores.length;
    
    if (average >= 0.8) return 'low';
    if (average >= 0.5) return 'medium';
    return 'high';
  }

  /**
   * 辅助方法：休眠
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 演练报告生成器
 */
class DrillReportGenerator {
  constructor() {
    this.reportTemplates = {
      standard: this.generateStandardReport.bind(this),
      detailed: this.generateDetailedReport.bind(this),
      summary: this.generateSummaryReport.bind(this)
    };
  }

  /**
   * 生成演练报告
   */
  async generateReport(execution, format = 'standard') {
    logger.info({ executionId: execution.id, format }, '生成演练报告');

    const generator = this.reportTemplates[format] || this.reportTemplates.standard;
    const report = await generator(execution);

    return report;
  }

  /**
   * 生成标准报告
   */
  async generateStandardReport(execution) {
    const report = {
      metadata: {
        reportId: `report-${Date.now()}`,
        generatedAt: new Date().toISOString(),
        executionId: execution.id,
        scenarioId: execution.scenarioId
      },
      summary: {
        status: execution.status,
        duration: execution.duration,
        startTime: execution.startTime,
        endTime: execution.endTime
      },
      sloCompliance: execution.results?.sloCompliance || {},
      impact: execution.results?.impactAnalysis || {},
      recovery: execution.results?.recoveryAnalysis || {},
      recommendations: this.generateRecommendations(execution)
    };

    return report;
  }

  /**
   * 生成详细报告
   */
  async generateDetailedReport(execution) {
    const standardReport = await this.generateStandardReport(execution);
    
    // 添加详细指标
    standardReport.detailedMetrics = {
      baseline: execution.metrics.baseline,
      during: execution.metrics.during,
      after: execution.metrics.after
    };

    // 添加实验详情
    standardReport.experiments = execution.experiments.map(exp => ({
      id: exp.experimentId,
      kind: exp.kind,
      status: exp.status,
      createdAt: exp.createdAt
    }));

    // 添加时间线
    standardReport.timeline = this.generateTimeline(execution);

    return standardReport;
  }

  /**
   * 生成摘要报告
   */
  async generateSummaryReport(execution) {
    const report = {
      executionId: execution.id,
      scenarioId: execution.scenarioId,
      status: execution.status,
      duration: execution.duration,
      overallImpact: execution.results?.impactAnalysis?.overallImpact || 'unknown',
      rto: execution.results?.rto || 0,
      rpo: execution.results?.rpo || 0,
      passed: this.evaluateDrillPass(execution),
      timestamp: new Date().toISOString()
    };

    return report;
  }

  /**
   * 生成时间线
   */
  generateTimeline(execution) {
    const timeline = [];

    // 开始时间
    timeline.push({
      timestamp: execution.startTime,
      event: 'drill-started',
      description: '演练开始'
    });

    // 混沌实验注入
    for (const exp of execution.experiments) {
      timeline.push({
        timestamp: exp.createdAt,
        event: 'chaos-injected',
        description: `注入混沌实验: ${exp.kind}`,
        experimentId: exp.experimentId
      });
    }

    // 结束时间
    timeline.push({
      timestamp: execution.endTime,
      event: 'drill-completed',
      description: '演练结束'
    });

    return timeline;
  }

  /**
   * 生成建议
   */
  generateRecommendations(execution) {
    const recommendations = [];

    // 基于演练结果生成建议
    if (execution.results?.rto > 300000) {
      recommendations.push({
        category: 'performance',
        severity: 'high',
        message: 'RTO 超过目标值，建议优化故障检测和恢复流程',
        metric: 'rto',
        currentValue: execution.results.rto,
        targetValue: 300000
      });
    }

    if (execution.results?.sloCompliance?.availability?.drop > 0.05) {
      recommendations.push({
        category: 'availability',
        severity: 'high',
        message: '可用性下降超过阈值，建议增加冗余和容错机制',
        metric: 'availability-drop',
        currentValue: execution.results.sloCompliance.availability.drop,
        threshold: 0.05
      });
    }

    if (execution.results?.sloCompliance?.latency?.increase > 0.5) {
      recommendations.push({
        category: 'performance',
        severity: 'medium',
        message: '延迟增加显著，建议优化服务性能和资源配额',
        metric: 'latency-increase',
        currentValue: execution.results.sloCompliance.latency.increase,
        threshold: 0.5
      });
    }

    return recommendations;
  }

  /**
   * 评估演练是否通过
   */
  evaluateDrillPass(execution) {
    if (execution.status !== 'completed') return false;

    const results = execution.results;
    if (!results) return false;

    // 检查 SLO 合规性
    const sloCompliance = results.sloCompliance;
    for (const key of Object.keys(sloCompliance)) {
      if (!sloCompliance[key].passed) {
        return false;
      }
    }

    // 检查 RTO
    if (results.rto > 300000) return false;

    // 检查 RPO
    if (results.rpo > 60000) return false;

    return true;
  }
}

/**
 * 演练场景库
 */
class DrillScenarioLibrary {
  constructor(scenariosDir = './drill-scenarios') {
    this.scenariosDir = scenariosDir;
    this.scenarios = new Map();
    this.loadScenarios();
  }

  /**
   * 加载场景定义
   */
  async loadScenarios() {
    try {
      const files = await fs.readdir(this.scenariosDir);
      
      for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.json')) {
          const filePath = path.join(this.scenariosDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          
          let scenario;
          if (file.endsWith('.yaml')) {
            const yaml = require('js-yaml');
            scenario = yaml.load(content);
          } else {
            scenario = JSON.parse(content);
          }
          
          this.scenarios.set(scenario.id, new DrillScenario(scenario));
          logger.info({ scenarioId: scenario.id, name: scenario.name }, '加载演练场景');
        }
      }

      logger.info({ count: this.scenarios.size }, '演练场景加载完成');

    } catch (error) {
      logger.warn({ error: error.message }, '加载演练场景失败，使用默认场景');
      this.createDefaultScenarios();
    }
  }

  /**
   * 创建默认场景
   */
  createDefaultScenarios() {
    // 区域服务下线场景
    this.scenarios.set('region-outage', new DrillScenario({
      id: 'region-outage',
      name: '区域服务下线演练',
      type: 'full',
      description: '模拟整个区域的服务不可用',
      chaosExperiments: [
        {
          kind: 'NetworkChaos',
          spec: {
            action: 'partition',
            mode: 'all',
            selector: {
              namespaces: ['minego'],
              labelSelectors: { region: 'beijing' }
            },
            direction: 'both',
            duration: '10m'
          }
        }
      ],
      duration: 1800000,
      targetServices: ['gateway', 'user-service', 'pokemon-service'],
      targetRegion: 'beijing',
      rtoTarget: 300000,
      rpoTarget: 60000
    }));

    // 数据库故障场景
    this.scenarios.set('database-failure', new DrillScenario({
      id: 'database-failure',
      name: '数据库故障演练',
      type: 'partial',
      description: '模拟数据库主从切换',
      chaosExperiments: [
        {
          kind: 'PodChaos',
          spec: {
            action: 'pod-kill',
            mode: 'one',
            selector: {
              namespaces: ['minego'],
              labelSelectors: { app: 'postgresql-primary' }
            },
            gracePeriodSeconds: 5
          }
        }
      ],
      duration: 600000,
      targetServices: ['database'],
      rtoTarget: 120000,
      rpoTarget: 30000
    }));

    // 网络延迟场景
    this.scenarios.set('network-latency', new DrillScenario({
      id: 'network-latency',
      name: '网络延迟演练',
      type: 'partial',
      description: '模拟网络延迟增加',
      chaosExperiments: [
        {
          kind: 'NetworkChaos',
          spec: {
            action: 'delay',
            mode: 'all',
            selector: {
              namespaces: ['minego'],
              labelSelectors: { app: 'gateway' }
            },
            delay: {
              latency: '500ms',
              jitter: '100ms'
            },
            duration: '10m'
          }
        }
      ],
      duration: 900000,
      targetServices: ['gateway'],
      rtoTarget: 60000,
      rpoTarget: 0
    }));

    logger.info({ count: this.scenarios.size }, '默认演练场景创建完成');
  }

  /**
   * 获取场景
   */
  getScenario(scenarioId) {
    return this.scenarios.get(scenarioId);
  }

  /**
   * 获取所有场景
   */
  getAllScenarios() {
    return Array.from(this.scenarios.values());
  }
}

module.exports = {
  DrillScenario,
  DrillExecutor,
  DrillReportGenerator,
  DrillScenarioLibrary
};
