# REQ-00593：灾备故障场景自动发现与混沌验证覆盖系统

- **编号**：REQ-00593
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/disasterRecovery, backend/shared/ChaosEngine, admin-dashboard, monitoring
- **创建时间**：2026-07-19 03:00
- **依赖需求**：REQ-00078 (金丝雀发布), REQ-00376 (灾备管理), REQ-00292 (混沌测试)

## 1. 背景与问题

### 现状分析
mineGo 项目已具备以下灾备能力：
- **灾备引擎**（DisasterRecoveryEngine）：健康检查、故障转移决策、RTO/RPO 监控
- **混沌引擎**（ChaosEngine）：故障注入、实验编排、稳态验证
- **数据复制**：PostgreSQL 流复制、Redis 跨区域同步、Kafka MirrorMaker
- **流量调度**：GSLB 控制器、区域路由

### 核心痛点
1. **故障场景依赖人工枚举**：当前混沌实验的故障场景需要手动配置，难以覆盖所有潜在风险
2. **缺少场景发现能力**：系统无法自动识别单点故障（SPOF）、依赖链脆弱点、级联故障风险
3. **验证覆盖率未知**：灾备切换能力只验证了部分预设场景，缺少系统性覆盖率度量
4. **潜在风险盲区**：新增服务、依赖变更后，可能引入新的故障场景但未被发现

### 真实风险案例
- 某次新增 payment-service 依赖 Kafka 时，未验证 Kafka 分区场景，导致支付失败扩散
- Redis 主从切换时，部分缓存键未预热，引发"缓存雪崩"影响捕捉服务
- 数据库连接池耗尽时，健康检查超时未触发熔断，导致全链路阻塞

## 2. 目标

构建灾备故障场景自动发现与混沌验证覆盖系统：
1. **自动发现故障场景**：分析服务拓扑、依赖图、配置，自动生成潜在故障场景
2. **场景优先级排序**：基于影响范围、发生概率、恢复难度计算场景风险评分
3. **混沌测试映射**：将发现的场景自动转换为混沌引擎可执行的实验
4. **覆盖率度量**：量化灾备能力覆盖度，识别验证盲区
5. **持续扫描**：服务变更时自动更新场景库

## 3. 范围

### 包含
- 服务拓扑分析器：解析 Docker Compose、K8s Deployment、服务发现配置
- 依赖图构建器：分析服务间 HTTP/RPC/Kafka/Redis 调用链
- 故障场景生成器：基于拓扑和依赖生成单点故障、级联故障、网络分区等场景
- 风险评分引擎：计算场景风险分数（影响面 × 概率 × 恢复难度）
- 混沌实验映射器：将场景转换为 ChaosEngine 实验配置
- 覆盖率计算器：度量已验证场景占比
- 场景仪表盘：admin-dashboard 展示场景库、风险矩阵、覆盖率趋势
- REST API：场景查询、生成、验证触发、覆盖率报告

### 不包含
- 生产环境实际故障注入（仅生成测试配置）
- 外部云服务商故障模拟（如 AWS 区域宕机）
- 业务逻辑级别的故障（如余额不足）

## 4. 详细需求

### 4.1 服务拓扑分析器（ServiceTopologyAnalyzer）

```javascript
// backend/shared/disasterRecovery/ServiceTopologyAnalyzer.js

class ServiceTopologyAnalyzer {
  constructor(options = {}) {
    this.k8sClient = options.k8sClient;
    this.dockerClient = options.dockerClient;
    this.serviceRegistry = options.serviceRegistry;
  }

  /**
   * 分析服务拓扑
   * @returns {Promise<ServiceTopology>}
   */
  async analyze() {
    const topology = {
      services: new Map(),
      dependencies: [],
      infraComponents: [],
      singlePointsOfFailure: []
    };

    // 解析 K8s Deployments
    const deployments = await this.k8sClient.listDeployments();
    for (const deploy of deployments) {
      topology.services.set(deploy.metadata.name, {
        name: deploy.metadata.name,
        replicas: deploy.spec.replicas,
        containers: deploy.spec.template.spec.containers.map(c => c.name),
        resources: deploy.spec.template.spec.containers[0].resources,
        healthCheck: deploy.spec.template.spec.containers[0].livenessProbe
      });
    }

    // 识别单点故障
    for (const [name, service] of topology.services) {
      if (service.replicas < 2) {
        topology.singlePointsOfFailure.push({
          type: 'service-singles-instance',
          target: name,
          severity: 'high'
        });
      }
    }

    return topology;
  }
}
```

### 4.2 依赖图构建器（DependencyGraphBuilder）

```javascript
// backend/shared/disasterRecovery/DependencyGraphBuilder.js

class DependencyGraphBuilder {
  constructor(options = {}) {
    this.redis = options.redis;
    this.pool = options.pool;
  }

  /**
   * 构建依赖图
   * 通过分析：HTTP 调用日志、Kafka Topic 订阅、Redis 键访问模式
   */
  async build() {
    const graph = {
      nodes: [],
      edges: [],
      criticalPaths: []
    };

    // 从 Redis 获取服务调用链路缓存
    const callChains = await this.redis.lrange('service:call:chains', 0, -1);
    
    // 从数据库查询 Kafka Topic 订阅关系
    const kafkaDeps = await this.pool.query(`
      SELECT consumer_service, topic, partition_count, lag_threshold
      FROM kafka_topic_dependencies
    `);

    // 构建边
    for (const chain of callChains) {
      const [from, to, protocol] = JSON.parse(chain);
      graph.edges.push({
        from, to, protocol,
        criticality: await this.assessCriticality(from, to)
      });
    }

    // 识别关键路径（最长依赖链）
    graph.criticalPaths = this.findCriticalPaths(graph);

    return graph;
  }

  /**
   * 评估依赖关键性
   */
  async assessCriticality(from, to) {
    // 基于：调用频率、超时历史、是否有降级策略
    const stats = await this.pool.query(`
      SELECT 
        COUNT(*) as call_count,
        AVG(duration_ms) as avg_duration,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as error_count
      FROM service_call_logs
      WHERE caller = $1 AND callee = $2
        AND created_at > NOW() - INTERVAL '7 days'
    `, [from, to]);

    const errorRate = stats.rows[0].error_count / stats.rows[0].call_count;
    return {
      level: errorRate > 0.01 ? 'critical' : errorRate > 0.001 ? 'high' : 'medium',
      errorRate,
      callCount: stats.rows[0].call_count
    };
  }
}
```

### 4.3 故障场景生成器（FaultScenarioGenerator）

```javascript
// backend/shared/disasterRecovery/FaultScenarioGenerator.js

const SCENARIO_TEMPLATES = [
  {
    type: 'service-down',
    description: '服务实例全部宕机',
    faultType: 'service-unavailable',
    params: { duration: 60000 }
  },
  {
    type: 'service-partial-down',
    description: '服务部分实例宕机',
    faultType: 'pod-kill',
    params: { killRatio: 0.5, duration: 120000 }
  },
  {
    type: 'database-connection-exhaust',
    description: '数据库连接池耗尽',
    faultType: 'resource-exhaustion',
    params: { resource: 'db-connections', target: 'pool' }
  },
  {
    type: 'redis-cache-miss',
    description: 'Redis 缓存大面积失效',
    faultType: 'cache-eviction',
    params: { keyPattern: '*', ratio: 0.8 }
  },
  {
    type: 'kafka-partition-unavailable',
    description: 'Kafka 分区不可用',
    faultType: 'kafka-partition-down',
    params: { topic: '*', partition: -1 }
  },
  {
    type: 'network-partition',
    description: '网络分区（服务间通信中断）',
    faultType: 'network-partition',
    params: { direction: 'both' }
  },
  {
    type: 'dns-failure',
    description: 'DNS 解析失败',
    faultType: 'dns-block',
    params: { domain: '*' }
  },
  {
    type: 'cascade-failure',
    description: '级联故障（上游服务故障导致下游连锁失败）',
    faultType: 'cascade',
    params: { triggerService: '*', cascadeDepth: 3 }
  }
];

class FaultScenarioGenerator {
  constructor(options = {}) {
    this.topologyAnalyzer = options.topologyAnalyzer;
    this.dependencyBuilder = options.dependencyBuilder;
    this.chaosEngine = options.chaosEngine;
  }

  /**
   * 自动生成故障场景
   */
  async generate() {
    const topology = await this.topologyAnalyzer.analyze();
    const dependencyGraph = await this.dependencyBuilder.build();
    
    const scenarios = [];

    // 1. 基于拓扑生成场景
    for (const spof of topology.singlePointsOfFailure) {
      scenarios.push(this.createScenarioFromSPOF(spof, topology));
    }

    // 2. 基于依赖图生成场景
    for (const edge of dependencyGraph.edges) {
      if (edge.criticality.level === 'critical') {
        scenarios.push(this.createScenarioFromDependency(edge, dependencyGraph));
      }
    }

    // 3. 基于模板生成通用场景
    for (const service of topology.services.keys()) {
      for (const template of SCENARIO_TEMPLATES) {
        scenarios.push(this.applyTemplate(template, service, topology));
      }
    }

    // 去重并排序
    return this.deduplicateAndRank(scenarios);
  }

  /**
   * 创建单点故障场景
   */
  createScenarioFromSPOF(spof, topology) {
    return {
      id: `scenario-spof-${spof.target}-${Date.now()}`,
      type: spof.type,
      name: `${spof.target} 单点故障`,
      description: `服务 ${spof.target} 仅有一个实例，存在单点故障风险`,
      target: spof.target,
      severity: spof.severity,
      faultType: 'service-unavailable',
      faultParams: { target: spof.target, duration: 60000 },
      impact: this.assessImpact(spof.target, topology),
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 计算风险评分
   * Risk = Impact × Probability × Recovery Difficulty
   */
  calculateRiskScore(scenario) {
    const impactWeight = 0.4;
    const probabilityWeight = 0.3;
    const recoveryWeight = 0.3;

    const impact = scenario.impact.score || 50; // 0-100
    const probability = this.estimateProbability(scenario); // 0-100
    const recovery = this.estimateRecoveryDifficulty(scenario); // 0-100

    return Math.round(impact * impactWeight + probability * probabilityWeight + recovery * recoveryWeight);
  }
}
```

### 4.4 混沌实验映射器（ChaosExperimentMapper）

```javascript
// backend/shared/disasterRecovery/ChaosExperimentMapper.js

class ChaosExperimentMapper {
  constructor(options = {}) {
    this.chaosEngine = options.chaosEngine;
  }

  /**
   * 将故障场景转换为混沌实验
   */
  mapToExperiment(scenario) {
    const experiment = {
      id: `exp-${scenario.id}`,
      name: `Auto: ${scenario.name}`,
      description: scenario.description,
      hypotheses: [
        {
          premise: `${scenario.target} 在 ${scenario.faultType} 场景下保持可用`,
          validation: 'steady-state'
        }
      ],
      faults: this.buildFaults(scenario),
      steadyStateSpecs: this.buildSteadyStateSpecs(scenario),
      rollbackStrategy: {
        automatic: true,
        timeoutMs: 120000
      },
      metadata: {
        generatedFrom: 'FaultScenarioGenerator',
        scenarioId: scenario.id,
        riskScore: scenario.riskScore,
        autoGenerated: true
      }
    };

    return experiment;
  }

  /**
   * 构建故障注入配置
   */
  buildFaults(scenario) {
    const faultMap = {
      'service-unavailable': (s) => [{
        type: 'service-down',
        target: s.target,
        duration: s.faultParams.duration || 60000
      }],
      'pod-kill': (s) => [{
        type: 'pod-kill',
        target: s.target,
        killRatio: s.faultParams.killRatio || 0.5
      }],
      'resource-exhaustion': (s) => [{
        type: 'stress',
        target: s.faultParams.target || s.target,
        resource: s.faultParams.resource,
        intensity: 'high'
      }],
      'network-partition': (s) => [{
        type: 'network-partition',
        source: s.target,
        destination: s.faultParams.destination || '*',
        direction: s.faultParams.direction || 'both'
      }],
      'cache-eviction': (s) => [{
        type: 'redis-flush',
        pattern: s.faultParams.keyPattern || '*',
        ratio: s.faultParams.ratio || 0.5
      }],
      'kafka-partition-down': (s) => [{
        type: 'kafka-partition-block',
        topic: s.faultParams.topic,
        partition: s.faultParams.partition
      }],
      'cascade': (s) => [{
        type: 'cascade-failure',
        trigger: s.faultParams.triggerService,
        cascadeDepth: s.faultParams.cascadeDepth || 3
      }]
    };

    const builder = faultMap[scenario.faultType];
    return builder ? builder(scenario) : [];
  }

  /**
   * 构建稳态验证规范
   */
  buildSteadyStateSpecs(scenario) {
    return [
      {
        type: 'metric-threshold',
        metric: 'service_availability',
        target: scenario.target,
        operator: '>=',
        value: 99,
        window: '5m'
      },
      {
        type: 'error-rate',
        target: scenario.target,
        operator: '<',
        value: 5,
        window: '5m'
      },
      {
        type: 'latency-p99',
        target: scenario.target,
        operator: '<',
        value: 2000,
        window: '5m'
      }
    ];
  }
}
```

### 4.5 覆盖率计算器（CoverageCalculator）

```javascript
// backend/shared/disasterRecovery/CoverageCalculator.js

class CoverageCalculator {
  constructor(options = {}) {
    this.pool = options.pool;
    this.redis = options.redis;
  }

  /**
   * 计算灾备覆盖率
   */
  async calculate() {
    // 获取所有已识别场景
    const allScenarios = await this.pool.query(`
      SELECT id, type, target, risk_score, severity
      FROM fault_scenarios
      WHERE is_active = true
    `);

    // 获取已验证场景
    const verifiedScenarios = await this.pool.query(`
      SELECT DISTINCT scenario_id
      FROM chaos_experiment_results
      WHERE success = true
        AND executed_at > NOW() - INTERVAL '90 days'
    `);

    // 按类型分组计算
    const coverage = {
      overall: 0,
      byType: {},
      byService: {},
      gaps: []
    };

    // 总体覆盖率
    coverage.overall = allScenarios.rows.length > 0
      ? (verifiedScenarios.rows.length / allScenarios.rows.length) * 100
      : 0;

    // 按类型分组
    for (const row of allScenarios.rows) {
      if (!coverage.byType[row.type]) {
        coverage.byType[row.type] = { total: 0, verified: 0 };
      }
      coverage.byType[row.type].total++;
      if (verifiedScenarios.rows.some(v => v.scenario_id === row.id)) {
        coverage.byType[row.type].verified++;
      }
    }

    // 识别覆盖缺口（高优先级未验证场景）
    coverage.gaps = allScenarios.rows
      .filter(s => s.severity === 'high' || s.severity === 'critical')
      .filter(s => !verifiedScenarios.rows.some(v => v.scenario_id === s.id))
      .map(s => ({
        id: s.id,
        type: s.type,
        target: s.target,
        riskScore: s.risk_score
      }));

    // 存储覆盖率快照
    await this.storeSnapshot(coverage);

    return coverage;
  }

  /**
   * 存储覆盖率快照（用于趋势分析）
   */
  async storeSnapshot(coverage) {
    await this.pool.query(`
      INSERT INTO disaster_recovery_coverage_snapshots
        (coverage_overall, coverage_by_type, gaps_count, recorded_at)
      VALUES ($1, $2, $3, NOW())
    `, [
      coverage.overall,
      JSON.stringify(coverage.byType),
      coverage.gaps.length
    ]);
  }
}
```

### 4.6 REST API 端点

```javascript
// backend/gateway/src/routes/admin/disasterRecoveryScenarios.js

const router = express.Router();

/**
 * GET /admin/disaster-recovery/scenarios
 * 获取故障场景列表
 */
router.get('/scenarios', async (req, res) => {
  const { type, service, minRisk, limit = 50 } = req.query;
  
  let query = `
    SELECT * FROM fault_scenarios
    WHERE is_active = true
  `;
  const params = [];
  
  if (type) {
    params.push(type);
    query += ` AND type = $${params.length}`;
  }
  if (service) {
    params.push(service);
    query += ` AND target = $${params.length}`;
  }
  if (minRisk) {
    params.push(parseInt(minRisk));
    query += ` AND risk_score >= $${params.length}`;
  }
  
  query += ` ORDER BY risk_score DESC LIMIT $${params.length + 1}`;
  params.push(parseInt(limit));
  
  const result = await pool.query(query, params);
  res.json({ success: true, data: result.rows });
});

/**
 * POST /admin/disaster-recovery/scenarios/generate
 * 触发场景自动发现
 */
router.post('/scenarios/generate', async (req, res) => {
  const generator = new FaultScenarioGenerator({
    topologyAnalyzer,
    dependencyBuilder,
    chaosEngine
  });
  
  const scenarios = await generator.generate();
  
  // 存储场景
  for (const scenario of scenarios) {
    await pool.query(`
      INSERT INTO fault_scenarios
        (id, type, name, description, target, severity, fault_type, 
         fault_params, risk_score, impact, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        risk_score = EXCLUDED.risk_score,
        impact = EXCLUDED.impact,
        updated_at = NOW()
    `, [
      scenario.id, scenario.type, scenario.name, scenario.description,
      scenario.target, scenario.severity, scenario.faultType,
      JSON.stringify(scenario.faultParams), scenario.riskScore,
      JSON.stringify(scenario.impact), scenario.createdAt
    ]);
  }
  
  res.json({
    success: true,
    data: {
      generatedCount: scenarios.length,
      scenarios: scenarios.slice(0, 10) // 返回前 10 个预览
    }
  });
});

/**
 * POST /admin/disaster-recovery/scenarios/:id/verify
 * 触发混沌验证
 */
router.post('/scenarios/:id/verify', async (req, res) => {
  const { id } = req.params;
  
  const scenarioResult = await pool.query(
    'SELECT * FROM fault_scenarios WHERE id = $1',
    [id]
  );
  
  if (scenarioResult.rows.length === 0) {
    return res.status(404).json({ success: false, error: '场景不存在' });
  }
  
  const scenario = scenarioResult.rows[0];
  const mapper = new ChaosExperimentMapper({ chaosEngine });
  const experiment = mapper.mapToExperiment(scenario);
  
  // 通过混沌引擎执行
  const result = await chaosEngine.executeExperiment(experiment);
  
  // 记录验证结果
  await pool.query(`
    INSERT INTO chaos_experiment_results
      (experiment_id, scenario_id, success, duration_ms, 
       steady_state_passed, error, executed_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `, [
    experiment.id, id, result.success, result.duration,
    result.steadyStatePassed, result.error || null
  ]);
  
  res.json({ success: true, data: result });
});

/**
 * GET /admin/disaster-recovery/coverage
 * 获取覆盖率报告
 */
router.get('/coverage', async (req, res) => {
  const calculator = new CoverageCalculator({ pool, redis });
  const coverage = await calculator.calculate();
  
  // 获取历史趋势
  const trend = await pool.query(`
    SELECT 
      DATE_TRUNC('day', recorded_at) as day,
      AVG(coverage_overall) as coverage,
      SUM(gaps_count) as gaps
    FROM disaster_recovery_coverage_snapshots
    WHERE recorded_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE_TRUNC('day', recorded_at)
    ORDER BY day ASC
  `);
  
  res.json({
    success: true,
    data: {
      current: coverage,
      trend: trend.rows
    }
  });
});

/**
 * GET /admin/disaster-recovery/risk-matrix
 * 获取风险矩阵
 */
router.get('/risk-matrix', async (req, res) => {
  const result = await pool.query(`
    SELECT 
      type,
      severity,
      COUNT(*) as scenario_count,
      AVG(risk_score) as avg_risk_score,
      SUM(CASE WHEN verified THEN 1 ELSE 0 END) as verified_count
    FROM fault_scenarios
    WHERE is_active = true
    GROUP BY type, severity
    ORDER BY avg_risk_score DESC
  `);
  
  res.json({ success: true, data: result.rows });
});
```

### 4.7 数据库迁移

```sql
-- database/migrations/20260719_030000__fault_scenario_tables.sql

-- 故障场景表
CREATE TABLE fault_scenarios (
  id VARCHAR(100) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  target VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  fault_type VARCHAR(50) NOT NULL,
  fault_params JSONB DEFAULT '{}',
  risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
  impact JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  verified BOOLEAN DEFAULT false,
  last_verified_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_fault_scenarios_type ON fault_scenarios(type);
CREATE INDEX idx_fault_scenarios_target ON fault_scenarios(target);
CREATE INDEX idx_fault_scenarios_risk ON fault_scenarios(risk_score DESC);

-- 验证结果表
CREATE TABLE chaos_experiment_results (
  id SERIAL PRIMARY KEY,
  experiment_id VARCHAR(100) NOT NULL,
  scenario_id VARCHAR(100) REFERENCES fault_scenarios(id),
  success BOOLEAN NOT NULL,
  duration_ms INTEGER,
  steady_state_passed BOOLEAN,
  metrics JSONB DEFAULT '{}',
  error TEXT,
  executed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_experiment_results_scenario ON chaos_experiment_results(scenario_id);
CREATE INDEX idx_experiment_results_time ON chaos_experiment_results(executed_at DESC);

-- 覆盖率快照表
CREATE TABLE disaster_recovery_coverage_snapshots (
  id SERIAL PRIMARY KEY,
  coverage_overall DECIMAL(5,2),
  coverage_by_type JSONB DEFAULT '{}',
  gaps_count INTEGER,
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_coverage_snapshots_time ON disaster_recovery_coverage_snapshots(recorded_at);

-- 视图：未验证的高风险场景
CREATE VIEW v_unverified_high_risk_scenarios AS
SELECT * FROM fault_scenarios
WHERE is_active = true
  AND risk_score >= 70
  AND verified = false
ORDER BY risk_score DESC;
```

### 4.8 Admin Dashboard 界面

```html
<!-- admin-dashboard/disaster-scenarios.html 关键组件 -->

<template id="scenario-risk-matrix">
  <div class="risk-matrix">
    <div class="matrix-header">
      <h3>风险矩阵</h3>
      <div class="legend">
        <span class="critical">高风险</span>
        <span class="high">中高风险</span>
        <span class="medium">中风险</span>
        <span class="low">低风险</span>
      </div>
    </div>
    <div class="matrix-grid">
      <!-- 风险矩阵可视化 -->
    </div>
  </div>
</template>

<template id="coverage-trend-chart">
  <div class="coverage-chart">
    <canvas id="coverageTrend"></canvas>
    <div class="stats">
      <div class="stat">
        <span class="value" id="currentCoverage">--</span>
        <span class="label">当前覆盖率</span>
      </div>
      <div class="stat">
        <span class="value" id="totalScenarios">--</span>
        <span class="label">总场景数</span>
      </div>
      <div class="stat">
        <span class="value" id="verifiedCount">--</span>
        <span class="label">已验证</span>
      </div>
      <div class="stat alert">
        <span class="value" id="gapsCount">--</span>
        <span class="label">覆盖缺口</span>
      </div>
    </div>
  </div>
</template>
```

## 5. 验收标准（可测试）

- [ ] 场景自动发现：执行 `/admin/disaster-recovery/scenarios/generate` 后，生成场景数 >= 50 个
- [ ] 风险评分：每个场景都有 riskScore（0-100），高严重度场景（critical/high）评分 >= 70
- [ ] 混沌映射：场景可通过 ChaosExperimentMapper 成功转换为混沌实验配置
- [ ] 覆盖率计算：`/admin/disaster-recovery/coverage` 返回覆盖率百分比和覆盖缺口列表
- [ ] 验证执行：调用 `/scenarios/:id/verify` 能触发混沌引擎执行实验并记录结果
- [ ] 单点故障检测：自动识别 replicas=1 的服务并生成 SPOF 场景
- [ ] 依赖链分析：能识别关键依赖链（深度 >= 2）并生成级联故障场景
- [ ] 趋势图：覆盖率历史趋势可查询（过去 30 天）
- [ ] 风险矩阵：`/admin/disaster-recovery/risk-matrix` 按 type × severity 聚合展示

## 6. 工作量估算

**L（Large）** - 约 3-5 天

- 服务拓扑分析器：1 天
- 依赖图构建器：1 天
- 故障场景生成器：1 天
- 混沌实验映射器：0.5 天
- 覆盖率计算器：0.5 天
- API 与数据库迁移：0.5 天
- Admin Dashboard 界面：0.5 天

## 7. 优先级理由

**P1 理由**：
1. 灾备系统有效性依赖于全面覆盖潜在故障场景，当前依赖人工枚举存在重大盲区
2. 系统已有混沌引擎基础，自动发现能力能快速提升灾备验证覆盖率
3. 与生产可用目标直接相关——未发现的故障场景可能成为生产事故根源
4. 服务拓扑变化频繁（新增微服务、依赖变更），需要自动化持续扫描能力
