# REQ-00177: 服务网格流量镜像测试系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00177 |
| 标题 | 服务网格流量镜像测试系统 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、infrastructure/k8s、backend/tests/traffic |
| 创建时间 | 2026-06-14 02:00 |

## 需求描述

实现服务网格级别的流量镜像（Traffic Mirroring / Shadow Traffic）测试系统，将生产环境真实流量实时复制到测试环境进行回归验证，在不影响生产业务的前提下验证新版本服务的正确性和性能表现，实现零风险的灰度验证机制。

### 核心目标

1. **零风险测试**：生产流量不影响生产服务，仅用于测试验证
2. **真实场景覆盖**：使用真实用户请求测试，覆盖边缘场景
3. **性能对比分析**：对比新旧版本响应时间、错误率等指标
4. **自动化回归**：新版本部署前自动触发流量镜像测试

## 技术方案

### 1. Istio 流量镜像配置

```yaml
# infrastructure/k8s/istio/virtual-service-mirror.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: gateway-mirror
  namespace: minego-production
spec:
  hosts:
    - gateway.minego.com
  http:
    - route:
        - destination:
            host: gateway-service
            port:
              number: 3000
          weight: 100
      mirror:
        host: gateway-service-staging.minego-staging.svc.cluster.local
        port:
          number: 3000
      mirrorPercentage:
        value: 10  # 镜像 10% 流量到测试环境
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: gateway-staging
  namespace: minego-staging
spec:
  host: gateway-service-staging.minego-staging.svc.cluster.local
  trafficPolicy:
    connectionPool:
      http:
        h2UpgradePolicy: UPGRADE
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 30s
      baseEjectionTime: 60s
```

### 2. 流量镜像控制器

```javascript
// backend/shared/trafficMirror.js
const { Kafka } = require('kafkajs');
const prometheus = require('prom-client');

class TrafficMirrorController {
  constructor(config = {}) {
    this.kafka = new Kafka({
      clientId: 'traffic-mirror',
      brokers: config.kafkaBrokers || ['kafka:9092']
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'mirror-processor' });
    
    // 镜像流量指标
    this.mirrorCounter = new prometheus.Counter({
      name: 'traffic_mirror_total',
      help: 'Total mirrored traffic requests',
      labelNames: ['service', 'endpoint', 'status']
    });
    
    this.latencyHistogram = new prometheus.Histogram({
      name: 'traffic_mirror_latency_seconds',
      help: 'Mirrored request latency',
      labelNames: ['service', 'version'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
    });
    
    this.errorCounter = new prometheus.Counter({
      name: 'traffic_mirror_errors_total',
      help: 'Mirrored request errors',
      labelNames: ['service', 'error_type']
    });
  }
  
  async initialize() {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: 'traffic-mirror', fromBeginning: false });
    console.log('[TrafficMirror] Controller initialized');
  }
  
  /**
   * 捕获并镜像请求
   */
  async mirrorRequest(serviceName, req, res, next) {
    const startTime = Date.now();
    
    try {
      // 克隆请求对象
      const mirroredRequest = {
        id: req.id || this.generateRequestId(),
        method: req.method,
        path: req.path,
        query: req.query,
        headers: this.sanitizeHeaders(req.headers),
        body: this.sanitizeBody(req.body),
        userId: req.user?.id,
        timestamp: new Date().toISOString(),
        source: 'production'
      };
      
      // 发送到镜像队列
      await this.producer.send({
        topic: 'traffic-mirror',
        messages: [{
          key: mirroredRequest.id,
          value: JSON.stringify(mirroredRequest),
          headers: {
            'service': serviceName,
            'mirror-time': Date.now().toString()
          }
        }]
      });
      
      this.mirrorCounter.inc({ 
        service: serviceName, 
        endpoint: req.path,
        status: 'queued' 
      });
      
    } catch (error) {
      console.error('[TrafficMirror] Mirror request failed:', error);
      this.errorCounter.inc({ 
        service: serviceName, 
        error_type: error.code || 'unknown' 
      });
      // 镜像失败不影响正常请求
    }
    
    // 继续正常请求处理
    next();
  }
  
  /**
   * 处理镜像流量
   */
  async processMirroredTraffic() {
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const startTime = Date.now();
        
        try {
          const request = JSON.parse(message.value.toString());
          const serviceName = message.headers.service?.toString() || 'unknown';
          
          // 转发到测试环境
          const response = await this.forwardToStaging(serviceName, request);
          
          const latency = (Date.now() - startTime) / 1000;
          this.latencyHistogram.observe({ 
            service: serviceName, 
            version: 'staging' 
          }, latency);
          
          // 对比响应结果
          await this.compareResponses(request.id, response);
          
          this.mirrorCounter.inc({ 
            service: serviceName, 
            endpoint: request.path,
            status: 'success' 
          });
          
        } catch (error) {
          console.error('[TrafficMirror] Process failed:', error);
          this.errorCounter.inc({ 
            service: 'processor', 
            error_type: error.code || 'processing_error' 
          });
        }
      }
    });
  }
  
  /**
   * 转发请求到测试环境
   */
  async forwardToStaging(serviceName, request) {
    const stagingUrl = this.getStagingUrl(serviceName);
    
    const response = await fetch(`${stagingUrl}${request.path}`, {
      method: request.method,
      headers: {
        ...request.headers,
        'X-Mirror-Request': 'true',
        'X-Mirror-Source': 'production',
        'X-Mirror-Timestamp': request.timestamp
      },
      body: request.method !== 'GET' ? JSON.stringify(request.body) : undefined
    });
    
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.json().catch(() => null)
    };
  }
  
  /**
   * 对比生产与测试响应
   */
  async compareResponses(requestId, stagingResponse) {
    // 从 Redis 获取生产环境响应
    const productionResponse = await this.getProductionResponse(requestId);
    
    if (!productionResponse) return;
    
    const diff = this.computeDiff(productionResponse, stagingResponse);
    
    if (diff.hasSignificantDiff) {
      await this.reportDifference(requestId, diff);
    }
  }
  
  /**
   * 计算响应差异
   */
  computeDiff(prod, staging) {
    const diff = {
      statusMatch: prod.status === staging.status,
      bodyDiff: null,
      hasSignificantDiff: false
    };
    
    // 忽略动态字段（如 timestamp、requestId）
    const ignoreFields = ['timestamp', 'requestId', 'correlationId', 'duration'];
    
    const prodBody = this.filterFields(prod.body, ignoreFields);
    const stagingBody = this.filterFields(staging.body, ignoreFields);
    
    diff.bodyDiff = this.deepCompare(prodBody, stagingBody);
    diff.hasSignificantDiff = !diff.statusMatch || diff.bodyDiff.hasDiff;
    
    return diff;
  }
  
  /**
   * 报告差异
   */
  async reportDifference(requestId, diff) {
    await this.kafka.producer().send({
      topic: 'traffic-mirror-diff',
      messages: [{
        key: requestId,
        value: JSON.stringify({
          requestId,
          diff,
          timestamp: new Date().toISOString()
        })
      }]
    });
  }
  
  /**
   * 生成请求 ID
   */
  generateRequestId() {
    return `mirror-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * 清理敏感头信息
   */
  sanitizeHeaders(headers) {
    const sensitive = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
    const sanitized = { ...headers };
    sensitive.forEach(key => {
      if (sanitized[key]) {
        sanitized[key] = '[REDACTED]';
      }
    });
    return sanitized;
  }
  
  /**
   * 清理敏感请求体
   */
  sanitizeBody(body) {
    if (!body) return body;
    const sanitized = JSON.parse(JSON.stringify(body));
    const sensitiveFields = ['password', 'creditCard', 'ssn', 'token'];
    sensitiveFields.forEach(field => {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    });
    return sanitized;
  }
}

module.exports = TrafficMirrorController;
```

### 3. 镜像流量分析器

```javascript
// backend/tests/traffic/TrafficMirrorAnalyzer.js
const { WebClient } = require('@slack/web-api');
const TrafficMirrorController = require('../../shared/trafficMirror');

class TrafficMirrorAnalyzer {
  constructor(config = {}) {
    this.mirror = new TrafficMirrorController(config);
    this.analysisWindow = 3600000; // 1 小时分析窗口
    this.diffThreshold = 0.05; // 5% 差异阈值
    this.slack = new WebClient(config.slackToken);
    
    this.stats = {
      totalRequests: 0,
      successfulMirrors: 0,
      failedMirrors: 0,
      responseDiffs: 0
    };
  }
  
  /**
   * 运行流量镜像测试
   */
  async runMirrorTest(config) {
    console.log('[Analyzer] Starting traffic mirror test...');
    
    const testId = `test-${Date.now()}`;
    const startTime = Date.now();
    const duration = config.duration || 3600000; // 默认 1 小时
    
    // 初始化镜像控制器
    await this.mirror.initialize();
    
    // 启动流量处理
    this.startProcessing(testId);
    
    // 等待测试完成
    await this.waitForCompletion(duration);
    
    // 生成测试报告
    const report = await this.generateReport(testId, startTime);
    
    // 发送通知
    if (config.notifyOnComplete) {
      await this.sendNotification(report);
    }
    
    return report;
  }
  
  /**
   * 启动流量处理
   */
  startProcessing(testId) {
    this.processingInterval = setInterval(() => {
      this.stats.totalRequests++;
      this.analyzeSample(testId);
    }, 1000);
  }
  
  /**
   * 分析样本
   */
  async analyzeSample(testId) {
    // 从 Kafka 消费差异消息
    const diffs = await this.getDifferences(testId);
    
    diffs.forEach(diff => {
      this.stats.responseDiffs++;
      this.classifyDifference(diff);
    });
  }
  
  /**
   * 分类差异
   */
  classifyDifference(diff) {
    const classification = {
      type: 'unknown',
      severity: 'low',
      recommendation: ''
    };
    
    if (diff.statusMatch === false) {
      classification.type = 'status_mismatch';
      classification.severity = 'high';
      classification.recommendation = '检查测试环境服务状态和配置';
    } else if (diff.bodyDiff?.missingFields?.length > 0) {
      classification.type = 'missing_fields';
      classification.severity = 'medium';
      classification.recommendation = '检查测试环境数据库迁移是否完成';
    } else if (diff.bodyDiff?.extraFields?.length > 0) {
      classification.type = 'extra_fields';
      classification.severity = 'low';
      classification.recommendation = '检查测试环境是否有额外功能';
    }
    
    return classification;
  }
  
  /**
   * 等待测试完成
   */
  waitForCompletion(duration) {
    return new Promise(resolve => {
      setTimeout(() => {
        clearInterval(this.processingInterval);
        resolve();
      }, duration);
    });
  }
  
  /**
   * 生成测试报告
   */
  async generateReport(testId, startTime) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    const successRate = (this.stats.successfulMirrors / this.stats.totalRequests * 100).toFixed(2);
    const diffRate = (this.stats.responseDiffs / this.stats.totalRequests * 100).toFixed(2);
    
    const report = {
      testId,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      duration: `${duration / 1000}s`,
      statistics: {
        totalRequests: this.stats.totalRequests,
        successfulMirrors: this.stats.successfulMirrors,
        failedMirrors: this.stats.failedMirrors,
        responseDiffs: this.stats.responseDiffs,
        successRate: `${successRate}%`,
        diffRate: `${diffRate}%`
      },
      assessment: {
        passed: parseFloat(diffRate) < this.diffThreshold * 100,
        grade: this.calculateGrade(successRate, diffRate),
        recommendation: this.getRecommendation(diffRate)
      }
    };
    
    return report;
  }
  
  /**
   * 计算测试等级
   */
  calculateGrade(successRate, diffRate) {
    const sr = parseFloat(successRate);
    const dr = parseFloat(diffRate);
    
    if (sr >= 99 && dr < 1) return 'A+';
    if (sr >= 95 && dr < 3) return 'A';
    if (sr >= 90 && dr < 5) return 'B';
    if (sr >= 85 && dr < 10) return 'C';
    return 'D';
  }
  
  /**
   * 获取建议
   */
  getRecommendation(diffRate) {
    const dr = parseFloat(diffRate);
    
    if (dr < 1) return '测试环境表现优秀，可以安全部署';
    if (dr < 5) return '存在少量差异，建议检查差异详情后部署';
    if (dr < 10) return '差异较多，建议修复后再部署';
    return '差异严重，不建议部署，需深入排查';
  }
  
  /**
   * 发送通知
   */
  async sendNotification(report) {
    const message = {
      channel: '#deployments',
      text: `流量镜像测试完成 - ${report.testId}`,
      attachments: [{
        color: report.assessment.passed ? 'good' : 'warning',
        fields: [
          { title: '测试时长', value: report.duration, short: true },
          { title: '总请求数', value: report.statistics.totalRequests.toString(), short: true },
          { title: '成功率', value: report.statistics.successRate, short: true },
          { title: '差异率', value: report.statistics.diffRate, short: true },
          { title: '测试等级', value: report.assessment.grade, short: true },
          { title: '建议', value: report.assessment.recommendation, short: false }
        ]
      }]
    };
    
    await this.slack.chat.postMessage(message);
  }
}

module.exports = TrafficMirrorAnalyzer;
```

### 4. CI/CD 集成

```yaml
# .github/workflows/traffic-mirror-test.yaml
name: Traffic Mirror Test

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize]
  workflow_dispatch:
    inputs:
      duration:
        description: 'Test duration in minutes'
        required: false
        default: '30'

jobs:
  traffic-mirror:
    runs-on: ubuntu-latest
    if: github.event.pull_request.draft == false
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Configure Istio mirroring
        run: |
          kubectl apply -f infrastructure/k8s/istio/virtual-service-mirror.yaml
          echo "Traffic mirroring configured"
          
      - name: Run traffic mirror test
        run: |
          node backend/tests/traffic/runMirrorTest.js \
            --duration=${{ github.event.inputs.duration || 30 }} \
            --notify-on-complete
        env:
          KAFKA_BROKERS: ${{ secrets.KAFKA_BROKERS }}
          REDIS_URL: ${{ secrets.REDIS_URL }}
          SLACK_TOKEN: ${{ secrets.SLACK_TOKEN }}
          STAGING_GATEWAY_URL: ${{ secrets.STAGING_GATEWAY_URL }}
          
      - name: Analyze test results
        run: node backend/tests/traffic/analyzeResults.js
        id: analyze
        
      - name: Comment on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('mirror-test-report.json', 'utf8'));
            
            const body = `## 🔍 流量镜像测试报告
            
            | 指标 | 值 |
            |------|-----|
            | 测试时长 | ${report.duration} |
            | 总请求数 | ${report.statistics.totalRequests} |
            | 成功率 | ${report.statistics.successRate} |
            | 差异率 | ${report.statistics.diffRate} |
            | 测试等级 | ${report.assessment.grade} |
            
            **建议**: ${report.assessment.recommendation}
            
            ${report.assessment.passed ? '✅ 测试通过，可以合并' : '⚠️ 建议检查差异详情'}`;
            
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: body
            });
            
      - name: Fail if test grade is D
        if: steps.analyze.outputs.grade == 'D'
        run: |
          echo "Traffic mirror test grade is D, failing the workflow"
          exit 1
```

### 5. 测试脚本

```javascript
// backend/tests/traffic/runMirrorTest.js
const TrafficMirrorAnalyzer = require('./TrafficMirrorAnalyzer');
const argv = require('minimist')(process.argv.slice(2));

async function main() {
  const analyzer = new TrafficMirrorAnalyzer({
    kafkaBrokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
    slackToken: process.env.SLACK_TOKEN
  });
  
  const duration = (parseInt(argv.duration) || 30) * 60 * 1000; // 分钟转毫秒
  
  const report = await analyzer.runMirrorTest({
    duration,
    notifyOnComplete: argv['notify-on-complete'] || false
  });
  
  // 保存报告
  const fs = require('fs');
  fs.writeFileSync('mirror-test-report.json', JSON.stringify(report, null, 2));
  
  console.log('\n========================================');
  console.log('Traffic Mirror Test Report');
  console.log('========================================');
  console.log(`Test ID: ${report.testId}`);
  console.log(`Duration: ${report.duration}`);
  console.log(`Success Rate: ${report.statistics.successRate}`);
  console.log(`Diff Rate: ${report.statistics.diffRate}`);
  console.log(`Grade: ${report.assessment.grade}`);
  console.log(`Recommendation: ${report.assessment.recommendation}`);
  console.log('========================================\n');
  
  // 如果差异率过高，返回非零退出码
  if (!report.assessment.passed) {
    process.exit(1);
  }
}

main().catch(console.error);
```

### 6. Grafana 监控面板

```json
// infrastructure/k8s/monitoring/grafana-dashboards/traffic-mirror.json
{
  "dashboard": {
    "title": "Traffic Mirror Monitoring",
    "panels": [
      {
        "title": "Mirrored Traffic Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(traffic_mirror_total[5m])",
            "legendFormat": "{{service}} - {{endpoint}}"
          }
        ]
      },
      {
        "title": "Mirror Latency Distribution",
        "type": "heatmap",
        "targets": [
          {
            "expr": "rate(traffic_mirror_latency_seconds_bucket[5m])",
            "legendFormat": "{{le}}"
          }
        ]
      },
      {
        "title": "Mirror Error Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(traffic_mirror_errors_total[5m])",
            "legendFormat": "{{service}} - {{error_type}}"
          }
        ]
      },
      {
        "title": "Response Diff Rate",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(rate(traffic_mirror_response_diff_total[1h])) / sum(rate(traffic_mirror_total[1h]))",
            "legendFormat": "Diff Rate"
          }
        ],
        "thresholds": [
          { "value": 0.05, "color": "green" },
          { "value": 0.10, "color": "yellow" },
          { "value": 0.20, "color": "red" }
        ]
      }
    ]
  }
}
```

## 验收标准

- [ ] Istio 流量镜像配置正确部署到 K8s 集群
- [ ] 流量镜像控制器成功捕获并转发生产流量
- [ ] 测试环境接收镜像流量并正确处理
- [ ] 响应差异检测准确率达 95% 以上
- [ ] CI/CD 集成测试成功运行
- [ ] Grafana 监控面板展示流量镜像指标
- [ ] 测试报告自动生成并通知团队
- [ ] 镜像流量不影响生产服务性能（延迟增加 < 5ms）

## 影响范围

- **新增文件**:
  - `infrastructure/k8s/istio/virtual-service-mirror.yaml`
  - `backend/shared/trafficMirror.js`
  - `backend/tests/traffic/TrafficMirrorAnalyzer.js`
  - `backend/tests/traffic/runMirrorTest.js`
  - `backend/tests/traffic/analyzeResults.js`
  - `.github/workflows/traffic-mirror-test.yaml`
  - `infrastructure/k8s/monitoring/grafana-dashboards/traffic-mirror.json`

- **修改文件**:
  - `infrastructure/k8s/istio/` - 添加镜像配置
  - `.github/workflows/` - 添加流量镜像测试工作流
  - `backend/shared/metrics.js` - 注册镜像指标

- **依赖服务**:
  - Istio 服务网格
  - Kafka 消息队列
  - Redis 缓存
  - Grafana 监控
  - Slack 通知

## 参考

- [Istio Traffic Mirroring](https://istio.io/latest/docs/tasks/traffic-management/mirroring/)
- [Shadow Testing Best Practices](https://martinfowler.com/bliki/ShadowTesting.html)
- [Kafka Consumer Group Management](https://kafka.apache.org/documentation/#consumerconfigs)
