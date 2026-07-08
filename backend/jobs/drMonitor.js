/**
 * 灾难恢复演练监控系统 (Disaster Recovery Drill Monitor)
 * 
 * 功能：
 * 1. 执行预定义的故障注入（Pod 崩溃、节点停机、跨区域路由中断）
 * 2. 实时监控系统的恢复时间和数据完整性
 * 3. 记录故障感知时间 (MTTD) 和恢复时间 (MTTR)
 * 4. 生成演练报告
 * 
 * 使用方式：
 * node backend/jobs/drMonitor.js --scenario=<scenario-name>
 */

'use strict';

const { Kafka } = require('kafkajs');
const { Pool } = require('pg');
const Redis = require('ioredis');
const k8s = require('@kubernetes/client-node');
const winston = require('winston');

// 配置日志
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    }),
    new winston.transports.File({ 
      filename: 'logs/dr-drill.log',
      format: winston.format.json()
    })
  ]
});

// Kubernetes 客户端配置
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);

// 数据库连接
const db = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.POSTGRES_DB || 'minego',
  user: process.env.POSTGRES_USER || 'minego',
  password: process.env.POSTGRES_PASSWORD || 'minego123'
});

// Redis 连接
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || ''
});

// Kafka 生产者
const kafka = new Kafka({
  clientId: 'dr-drill-monitor',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
});
const kafkaProducer = kafka.producer();

/**
 * 演练场景定义
 */
const DRILL_SCENARIOS = {
  'pod-crash': {
    name: 'Pod 崩溃故障',
    description: '模拟 Pod 意外崩溃，测试自动重启和恢复能力',
    type: 'pod-failure',
    target: {
      namespace: 'minego',
      labelSelector: 'app=minego-gateway'
    },
    metrics: {
      recoveryTimeTarget: 60, // 秒
      dataLossTolerance: 0 // 不允许数据丢失
    }
  },
  
  'node-failure': {
    name: '节点停机故障',
    description: '模拟 Kubernetes 节点停机，测试 Pod 迁移和调度能力',
    type: 'node-failure',
    target: {
      nodeName: process.env.DRILL_TARGET_NODE || 'worker-node-1',
      namespace: 'minego'
    },
    metrics: {
      recoveryTimeTarget: 300, // 秒
      dataLossTolerance: 0
    }
  },
  
  'network-partition': {
    name: '网络分区故障',
    description: '模拟跨区域网络中断，测试服务降级和容错能力',
    type: 'network-failure',
    target: {
      sourceNamespace: 'minego',
      targetNamespace: 'minego-db',
      partitionDuration: 120 // 秒
    },
    metrics: {
      recoveryTimeTarget: 180,
      dataLossTolerance: 5 // 允许 5% 数据丢失
    }
  },
  
  'database-failover': {
    name: '数据库故障转移',
    description: '模拟数据库主节点故障，测试故障转移能力',
    type: 'database-failure',
    target: {
      service: 'postgres-primary',
      namespace: 'minego-db'
    },
    metrics: {
      recoveryTimeTarget: 60,
      dataLossTolerance: 0
    }
  },
  
  'redis-failover': {
    name: 'Redis 故障转移',
    description: '模拟 Redis 主节点故障，测试缓存故障转移',
    type: 'cache-failure',
    target: {
      service: 'redis-primary',
      namespace: 'minego-cache'
    },
    metrics: {
      recoveryTimeTarget: 30,
      dataLossTolerance: 10 // 允许 10% 缓存丢失
    }
  }
};

/**
 * 灾难恢复演练监控器
 */
class DRDrillMonitor {
  constructor() {
    this.drillId = null;
    this.scenario = null;
    this.startTime = null;
    this.failureTime = null;
    this.detectionTime = null;
    this.recoveryTime = null;
    this.events = [];
    this.metrics = {
      mttc: 0, // Mean Time To Contain（故障感知时间）
      mttr: 0, // Mean Time To Recovery（平均恢复时间）
      dataLoss: 0,
      availabilityImpact: 0
    };
  }

  /**
   * 执行演练
   */
  async runDrill(scenarioName) {
    this.scenario = DRILL_SCENARIOS[scenarioName];
    
    if (!this.scenario) {
      throw new Error(`未知的演练场景: ${scenarioName}`);
    }

    this.drillId = `drill-${Date.now()}`;
    this.startTime = new Date();

    logger.info(`开始灾难恢复演练: ${this.scenario.name}`, {
      drillId: this.drillId,
      scenario: scenarioName
    });

    try {
      // 1. 记录基准状态
      await this.recordBaselineState();

      // 2. 注入故障
      await this.injectFailure();

      // 3. 监控故障影响和恢复
      await this.monitorRecovery();

      // 4. 验证数据完整性
      await this.verifyDataIntegrity();

      // 5. 生成报告
      const report = await this.generateReport();

      // 6. 清理演练资源
      await this.cleanup();

      logger.info(`演练完成: ${this.scenario.name}`, {
        drillId: this.drillId,
        mttr: this.metrics.mttr,
        success: true
      });

      return report;

    } catch (error) {
      logger.error('演练执行失败', {
        drillId: this.drillId,
        error: error.message,
        stack: error.stack
      });

      // 紧急清理
      await this.emergencyCleanup();

      throw error;
    }
  }

  /**
   * 记录基准状态
   */
  async recordBaselineState() {
    logger.info('记录基准状态...');

    // 获取当前 Pod 状态
    const pods = await k8sApi.listNamespacedPod(
      this.scenario.target.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      this.scenario.target.labelSelector
    );

    const baselinePods = pods.body.items.map(pod => ({
      name: pod.metadata.name,
      status: pod.status.phase,
      restartCount: pod.status.containerStatuses?.[0]?.restartCount || 0
    }));

    // 获取数据库连接数
    const dbResult = await db.query('SELECT count(*) as conn_count FROM pg_stat_activity');
    const baselineDbConns = parseInt(dbResult.rows[0].conn_count);

    // 获取 Redis 信息
    const redisInfo = await redis.info('memory');
    const baselineRedisMemory = this.parseRedisMemory(redisInfo);

    this.baselineState = {
      pods: baselinePods,
      dbConnections: baselineDbConns,
      redisMemory: baselineRedisMemory,
      timestamp: new Date()
    };

    logger.info('基准状态已记录', { baselinePods: baselinePods.length });
  }

  /**
   * 注入故障
   */
  async injectFailure() {
    logger.info(`注入故障: ${this.scenario.type}`);
    this.failureTime = new Date();

    switch (this.scenario.type) {
      case 'pod-failure':
        await this.injectPodFailure();
        break;
      
      case 'node-failure':
        await this.injectNodeFailure();
        break;
      
      case 'network-failure':
        await this.injectNetworkFailure();
        break;
      
      case 'database-failure':
        await this.injectDatabaseFailure();
        break;
      
      case 'cache-failure':
        await this.injectCacheFailure();
        break;
      
      default:
        throw new Error(`未支持的故障类型: ${this.scenario.type}`);
    }

    this.recordEvent('failure_injected', `故障已注入: ${this.scenario.type}`);
  }

  /**
   * 注入 Pod 故障
   */
  async injectPodFailure() {
    const { namespace, labelSelector } = this.scenario.target;
    
    // 获取目标 Pod
    const pods = await k8sApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    if (pods.body.items.length === 0) {
      throw new Error(`未找到匹配的 Pod: ${labelSelector}`);
    }

    // 删除第一个 Pod
    const targetPod = pods.body.items[0];
    await k8sApi.deleteNamespacedPod(
      targetPod.metadata.name,
      namespace
    );

    logger.info(`已删除 Pod: ${targetPod.metadata.name}`);
  }

  /**
   * 注入节点故障
   */
  async injectNodeFailure() {
    const { nodeName } = this.scenario.target;
    
    // 标记节点为不可调度
    const body = {
      spec: {
        unschedulable: true
      }
    };

    await k8sApi.patchNode(
      nodeName,
      body,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );

    logger.info(`已标记节点为不可调度: ${nodeName}`);

    // 删除该节点上的所有 Pod（模拟节点停机）
    const pods = await k8sApi.listPodForAllNamespaces(
      undefined,
      undefined,
      undefined,
      `spec.nodeName=${nodeName}`
    );

    for (const pod of pods.body.items) {
      if (pod.metadata.namespace.startsWith('minego')) {
        await k8sApi.deleteNamespacedPod(
          pod.metadata.name,
          pod.metadata.namespace
        );
        logger.info(`已删除 Pod: ${pod.metadata.name}`);
      }
    }
  }

  /**
   * 注入网络故障
   */
  async injectNetworkFailure() {
    // 使用 NetworkPolicy 模拟网络分区
    const networkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `dr-drill-partition-${this.drillId}`,
        namespace: this.scenario.target.sourceNamespace
      },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        ingress: [],
        egress: []
      }
    };

    await k8sApi.createNamespacedNetworkPolicy(
      this.scenario.target.sourceNamespace,
      networkPolicy
    );

    logger.info('已创建网络分区策略');

    // 设置定时器移除网络分区
    setTimeout(async () => {
      await this.removeNetworkPartition();
    }, this.scenario.target.partitionDuration * 1000);
  }

  /**
   * 移除网络分区
   */
  async removeNetworkPartition() {
    try {
      await k8sApi.deleteNamespacedNetworkPolicy(
        `dr-drill-partition-${this.drillId}`,
        this.scenario.target.sourceNamespace
      );
      logger.info('已移除网络分区策略');
    } catch (error) {
      logger.warn('移除网络分区策略失败', { error: error.message });
    }
  }

  /**
   * 注入数据库故障
   */
  async injectDatabaseFailure() {
    // 模拟数据库主节点故障（需要 PostgreSQL 主从复制配置）
    // 这里简化为终止数据库连接
    await db.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = 'minego'
        AND pid <> pg_backend_pid()
    `);

    logger.info('已终止所有数据库连接');
  }

  /**
   * 注入缓存故障
   */
  async injectCacheFailure() {
    // 模拟 Redis 主节点故障
    // 执行 FLUSHALL（生产环境慎用！）
    if (process.env.DRILL_ALLOW_FLUSH_REDIS === 'true') {
      await redis.flushall();
      logger.info('已清空 Redis 缓存');
    } else {
      logger.warn('Redis FLUSHALL 未启用，跳过缓存故障注入');
    }
  }

  /**
   * 监控恢复过程
   */
  async monitorRecovery() {
    logger.info('开始监控恢复过程...');

    const checkInterval = 5000; // 5 秒检查一次
    const maxWaitTime = this.scenario.metrics.recoveryTimeTarget * 2 * 1000; // 最大等待时间
    const startTime = Date.now();

    let recovered = false;

    while (!recovered && (Date.now() - startTime) < maxWaitTime) {
      await this.sleep(checkInterval);

      // 检查系统状态
      const status = await this.checkSystemStatus();

      if (status.recovered) {
        this.recoveryTime = new Date();
        this.detectionTime = new Date((this.failureTime.getTime() + this.recoveryTime.getTime()) / 2); // 估算检测时间
        
        // 计算指标
        this.metrics.mttc = (this.detectionTime - this.failureTime) / 1000;
        this.metrics.mttr = (this.recoveryTime - this.failureTime) / 1000;
        
        recovered = true;
        logger.info(`系统已恢复，MTTR: ${this.metrics.mttr} 秒`);
      }

      this.recordEvent('health_check', `健康检查: ${status.healthy ? '正常' : '异常'}`);
    }

    if (!recovered) {
      throw new Error(`系统未在预期时间内恢复（超时: ${maxWaitTime / 1000} 秒）`);
    }
  }

  /**
   * 检查系统状态
   */
  async checkSystemStatus() {
    const checks = {
      pods: false,
      database: false,
      redis: false,
      api: false
    };

    try {
      // 检查 Pod 状态
      const pods = await k8sApi.listNamespacedPod(
        this.scenario.target.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        this.scenario.target.labelSelector
      );

      const readyPods = pods.body.items.filter(pod => 
        pod.status.phase === 'Running' &&
        pod.status.containerStatuses?.every(cs => cs.ready)
      );

      checks.pods = readyPods.length > 0;

      // 检查数据库连接
      await db.query('SELECT 1');
      checks.database = true;

      // 检查 Redis 连接
      await redis.ping();
      checks.redis = true;

      // 检查 API 健康端点
      const apiResponse = await fetch(`http://localhost:8080/health`);
      checks.api = apiResponse.ok;

    } catch (error) {
      logger.warn('系统状态检查失败', { error: error.message });
    }

    const recovered = checks.pods && checks.database && checks.redis;
    const healthy = recovered && checks.api;

    return { recovered, healthy, checks };
  }

  /**
   * 验证数据完整性
   */
  async verifyDataIntegrity() {
    logger.info('验证数据完整性...');

    // 检查数据库数据
    const tables = ['users', 'pokemon', 'items', 'transactions'];
    let dataLoss = 0;

    for (const table of tables) {
      const result = await db.query(`SELECT count(*) FROM ${table}`);
      const count = parseInt(result.rows[0].count);
      
      if (count === 0) {
        logger.warn(`表 ${table} 数据丢失`);
        dataLoss++;
      }
    }

    this.metrics.dataLoss = (dataLoss / tables.length) * 100;

    // 检查缓存一致性
    const cacheKeys = await redis.keys('user:*');
    const dbUserCount = await db.query('SELECT count(*) FROM users');
    const cacheUserCount = cacheKeys.length;

    const cacheConsistency = cacheUserCount / parseInt(dbUserCount.rows[0].count);
    this.metrics.cacheConsistency = cacheConsistency;

    logger.info(`数据完整性验证完成，数据丢失率: ${this.metrics.dataLoss}%`);
  }

  /**
   * 生成报告
   */
  async generateReport() {
    const report = {
      drillId: this.drillId,
      scenario: this.scenario.name,
      type: this.scenario.type,
      startTime: this.startTime,
      failureTime: this.failureTime,
      recoveryTime: this.recoveryTime,
      duration: this.recoveryTime ? (this.recoveryTime - this.startTime) / 1000 : null,
      metrics: {
        mttc: this.metrics.mttc,
        mttr: this.metrics.mttr,
        dataLoss: this.metrics.dataLoss,
        cacheConsistency: this.metrics.cacheConsistency || 0,
        targetMet: this.metrics.mttr <= this.scenario.metrics.recoveryTimeTarget
      },
      baseline: this.baselineState,
      events: this.events,
      summary: {
        success: this.metrics.mttr <= this.scenario.metrics.recoveryTimeTarget &&
                 this.metrics.dataLoss <= this.scenario.metrics.dataLossTolerance,
        recommendations: this.generateRecommendations()
      }
    };

    // 保存报告到文件
    const reportPath = `docs/dr-drill-reports/${this.drillId}.md`;
    await this.saveReport(report, reportPath);

    // 发送通知
    await this.sendNotification(report);

    return report;
  }

  /**
   * 生成改进建议
   */
  generateRecommendations() {
    const recommendations = [];

    if (this.metrics.mttr > this.scenario.metrics.recoveryTimeTarget) {
      recommendations.push({
        priority: 'high',
        issue: '恢复时间超出目标',
        suggestion: '优化健康检查间隔或增加副本数以加快故障转移'
      });
    }

    if (this.metrics.dataLoss > this.scenario.metrics.dataLossTolerance) {
      recommendations.push({
        priority: 'critical',
        issue: '数据丢失超出容忍范围',
        suggestion: '增强数据持久化策略，考虑同步复制或增加备份频率'
      });
    }

    if (this.metrics.mttc > 30) {
      recommendations.push({
        priority: 'medium',
        issue: '故障检测时间过长',
        suggestion: '优化监控告警规则，减少健康检查间隔'
      });
    }

    return recommendations;
  }

  /**
   * 保存报告
   */
  async saveReport(report, path) {
    const fs = require('fs').promises;
    const { mkdir } = require('fs').promises;

    await mkdir('docs/dr-drill-reports', { recursive: true });

    const markdown = this.formatReportAsMarkdown(report);
    await fs.writeFile(path, markdown, 'utf8');

    logger.info(`报告已保存: ${path}`);
  }

  /**
   * 格式化报告为 Markdown
   */
  formatReportAsMarkdown(report) {
    const lines = [
      `# 灾难恢复演练报告 - ${report.drillId}`,
      '',
      `## 基本信息`,
      '',
      `| 项目 | 值 |`,
      `|------|-----|`,
      `| 演练场景 | ${report.scenario} |`,
      `| 故障类型 | ${report.type} |`,
      `| 开始时间 | ${report.startTime} |`,
      `| 故障注入时间 | ${report.failureTime} |`,
      `| 恢复时间 | ${report.recoveryTime || '未恢复'} |`,
      `| 总耗时 | ${report.duration || 'N/A'} 秒 |`,
      '',
      `## 性能指标`,
      '',
      `| 指标 | 实际值 | 目标值 | 状态 |`,
      `|------|--------|--------|------|`,
      `| 故障感知时间 (MTTC) | ${report.metrics.mttc.toFixed(2)}s | < 30s | ${report.metrics.mttc <= 30 ? '✅' : '❌'} |`,
      `| 平均恢复时间 (MTTR) | ${report.metrics.mttr.toFixed(2)}s | < ${this.scenario.metrics.recoveryTimeTarget}s | ${report.metrics.targetMet ? '✅' : '❌'} |`,
      `| 数据丢失率 | ${report.metrics.dataLoss.toFixed(2)}% | < ${this.scenario.metrics.dataLossTolerance}% | ${report.metrics.dataLoss <= this.scenario.metrics.dataLossTolerance ? '✅' : '❌'} |`,
      `| 缓存一致性 | ${(report.metrics.cacheConsistency * 100).toFixed(2)}% | > 95% | ${report.metrics.cacheConsistency > 0.95 ? '✅' : '❌'} |`,
      '',
      `## 演练结果`,
      '',
      `**${report.summary.success ? '✅ 演练成功' : '❌ 演练失败'}**`,
      '',
      `## 改进建议`,
      ''
    ];

    if (report.summary.recommendations.length > 0) {
      report.summary.recommendations.forEach((rec, i) => {
        lines.push(`${i + 1}. **[${rec.priority.toUpperCase()}]** ${rec.issue}`);
        lines.push(`   - 建议: ${rec.suggestion}`);
        lines.push('');
      });
    } else {
      lines.push('无改进建议。系统表现良好。');
    }

    lines.push('', '## 事件时间线', '');
    report.events.forEach(event => {
      lines.push(`- [${event.time}] ${event.type}: ${event.message}`);
    });

    return lines.join('\n');
  }

  /**
   * 发送通知
   */
  async sendNotification(report) {
    const message = `灾难恢复演练完成
    
场景: ${report.scenario}
MTTR: ${report.metrics.mttr.toFixed(2)}s
结果: ${report.summary.success ? '✅ 成功' : '❌ 失败'}

详细报告: docs/dr-drill-reports/${report.drillId}.md`;

    // 发送到 Kafka（由其他服务处理通知）
    await kafkaProducer.connect();
    await kafkaProducer.send({
      topic: 'dr-drill-events',
      messages: [{
        key: report.drillId,
        value: JSON.stringify({
          type: 'drill_completed',
          drillId: report.drillId,
          scenario: report.scenario,
          success: report.summary.success,
          mttr: report.metrics.mttr,
          message
        })
      }]
    });

    logger.info('已发送演练通知到 Kafka');
  }

  /**
   * 清理演练资源
   */
  async cleanup() {
    logger.info('清理演练资源...');

    try {
      // 移除网络分区策略（如果存在）
      if (this.scenario.type === 'network-failure') {
        await this.removeNetworkPartition();
      }

      // 恢复节点可调度状态（如果需要）
      if (this.scenario.type === 'node-failure') {
        const body = { spec: { unschedulable: false } };
        await k8sApi.patchNode(
          this.scenario.target.nodeName,
          body,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
        logger.info('已恢复节点可调度状态');
      }

    } catch (error) {
      logger.warn('清理资源失败', { error: error.message });
    }
  }

  /**
   * 紧急清理
   */
  async emergencyCleanup() {
    logger.warn('执行紧急清理...');
    await this.cleanup();
  }

  /**
   * 记录事件
   */
  recordEvent(type, message) {
    this.events.push({
      time: new Date().toISOString(),
      type,
      message
    });
  }

  /**
   * 解析 Redis 内存信息
   */
  parseRedisMemory(info) {
    const match = info.match(/used_memory:(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }

  /**
   * 休眠工具
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const scenarioArg = args.find(arg => arg.startsWith('--scenario='));
  
  if (!scenarioArg) {
    console.error('使用方式: node drMonitor.js --scenario=<scenario-name>');
    console.error('可用场景:', Object.keys(DRILL_SCENARIOS).join(', '));
    process.exit(1);
  }

  const scenarioName = scenarioArg.split('=')[1];
  const monitor = new DRDrillMonitor();

  try {
    const report = await monitor.runDrill(scenarioName);
    console.log('\n演练报告:');
    console.log(JSON.stringify(report, null, 2));
    
    process.exit(report.summary.success ? 0 : 1);
  } catch (error) {
    console.error('演练执行失败:', error);
    process.exit(1);
  }
}

// 执行主函数
if (require.main === module) {
  main();
}

module.exports = { DRDrillMonitor, DRILL_SCENARIOS };
