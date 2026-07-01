# REQ-00078：金丝雀发布与流量分割系统

- **编号**：REQ-00078
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、infrastructure/k8s、.github/workflows、backend/shared
- **创建时间**：2026-06-10 04:00
- **依赖需求**：REQ-00006（K8s 滚动更新与回滚自动化）

## 1. 背景与问题

当前项目使用蓝绿部署（REQ-00024）和滚动更新（REQ-00006），但这两种方式都是全量发布：

**全量发布的风险**：
1. **故障影响面大**：新版本有 Bug 时，100% 流量受影响
2. **回滚时间长**：发现问题后需要完整回滚，恢复慢
3. **无法逐步验证**：无法在小范围用户中验证新功能
4. **缺乏流量控制**：无法精确控制新版本的流量比例

**金丝雀发布的优势**：
- 先让 5% 流量到新版本，验证无误后逐步扩大
- 发现问题可快速切回旧版本（秒级）
- 支持按用户特征分流（VIP 用户、地区等）
- 降低发布风险，提高发布频率

**当前缺口**：
- `deploy-with-rollback.yml` 只支持全量部署
- 缺少流量分割机制
- 缺少金丝雀发布策略配置
- 缺少自动化金丝雀验证流程

## 2. 目标

实现完整的金丝雀发布系统，支持：
1. **渐进式发布**：5% → 25% → 50% → 100% 流量切换
2. **智能流量分割**：按百分比、用户特征、地区分流
3. **自动化验证**：监控关键指标，异常自动回滚
4. **快速回滚**：秒级切回旧版本
5. **发布可视化**：实时查看发布进度和流量分布

## 3. 范围

### 包含
- 流量分割中间件（Gateway 层）
- 金丝雀发布策略配置系统
- 自动化金丝雀验证（错误率、延迟、业务指标）
- 金丝雀发布 API 和 CLI 工具
- GitHub Actions 金丝雀发布工作流
- 金丝雀发布监控仪表板

### 不包含
- A/B 测试功能（属于产品层，需要独立的实验平台）
- 服务网格（Istio/Linkerd）集成（可后续扩展）
- 多集群金丝雀发布（当前仅单集群）

## 4. 详细需求

### 4.1 流量分割中间件

#### backend/gateway/src/middleware/canaryRouter.js

```javascript
/**
 * 金丝雀流量路由中间件
 * 
 * 支持多种分流策略：
 * 1. 百分比分流：随机 5% 流量到新版本
 * 2. Header 分流：X-Canary: true 的请求到新版本
 * 3. 用户特征分流：VIP 用户、特定地区等
 * 4. Cookie 分流：特定 Cookie 值的请求
 */

const CanaryRouter = {
  /**
   * 金丝雀配置缓存
   */
  canaryConfigs: new Map(), // service -> config
  
  /**
   * 初始化金丝雀配置
   */
  async initialize() {
    // 从数据库加载所有活跃的金丝雀发布
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status IN ('active', 'promoting')
      ORDER BY created_at DESC
    `);
    
    for (const row of result.rows) {
      this.canaryConfigs.set(row.service_name, {
        canaryVersion: row.canary_version,
        stableVersion: row.stable_version,
        trafficSplit: row.traffic_split,
        strategy: row.strategy,
        rules: row.rules,
        startTime: row.started_at,
        metricsBaseline: row.metrics_baseline
      });
    }
    
    // 定期刷新配置
    setInterval(() => this.refreshConfigs(), 5000);
  },
  
  /**
   * 刷新配置
   */
  async refreshConfigs() {
    // 检查是否有新的金丝雀发布
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status IN ('active', 'promoting') 
        AND updated_at > NOW() - INTERVAL '10 seconds'
    `);
    
    for (const row of result.rows) {
      this.canaryConfigs.set(row.service_name, {
        canaryVersion: row.canary_version,
        stableVersion: row.stable_version,
        trafficSplit: row.traffic_split,
        strategy: row.strategy,
        rules: row.rules,
        startTime: row.started_at,
        metricsBaseline: row.metrics_baseline
      });
    }
  },
  
  /**
   * 流量路由中间件
   */
  middleware() {
    return async (req, res, next) => {
      const serviceName = this.getTargetService(req.path);
      
      if (!serviceName) {
        return next();
      }
      
      const config = this.canaryConfigs.get(serviceName);
      
      if (!config) {
        // 没有金丝雀发布，走稳定版本
        req.targetVersion = 'stable';
        return next();
      }
      
      // 决定是否路由到金丝雀版本
      const shouldRouteToCanary = this.shouldRouteToCanary(req, config);
      
      if (shouldRouteToCanary) {
        req.targetVersion = 'canary';
        req.canaryVersion = config.canaryVersion;
        
        // 添加金丝雀追踪 Header
        res.setHeader('X-Canary', 'true');
        res.setHeader('X-Canary-Version', config.canaryVersion);
      } else {
        req.targetVersion = 'stable';
      }
      
      next();
    };
  },
  
  /**
   * 判断是否路由到金丝雀版本
   */
  shouldRouteToCanary(req, config) {
    const strategy = config.strategy;
    
    // 策略 1: 强制金丝雀（测试用）
    if (strategy === 'force-canary') {
      return true;
    }
    
    // 策略 2: Header 分流
    if (strategy === 'header') {
      return req.headers['x-canary'] === 'true';
    }
    
    // 策略 3: Cookie 分流
    if (strategy === 'cookie') {
      const cookieValue = req.cookies?.[config.rules.cookieName];
      return cookieValue === config.rules.cookieValue;
    }
    
    // 策略 4: 用户特征分流
    if (strategy === 'user-segment') {
      const user = req.user;
      if (!user) return false;
      
      // VIP 用户分流
      if (config.rules.vipOnly && user.isVip) {
        return true;
      }
      
      // 特定用户 ID 分流
      if (config.rules.userIds?.includes(user.id)) {
        return true;
      }
      
      // 特定地区分流
      if (config.rules.regions?.length > 0) {
        const userRegion = user.region || 'unknown';
        return config.rules.regions.includes(userRegion);
      }
      
      return false;
    }
    
    // 策略 5: 百分比分流（默认）
    if (strategy === 'percentage' || !strategy) {
      const percentage = config.trafficSplit;
      
      // 使用用户 ID 或 Session ID 做一致性哈希
      const hashKey = req.user?.id || req.sessionID || req.ip;
      const hash = this.hashString(hashKey);
      
      // 相同用户始终路由到同一版本（一致性）
      return (hash % 100) < percentage;
    }
    
    return false;
  },
  
  /**
   * 字符串哈希
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  },
  
  /**
   * 获取目标服务名
   */
  getTargetService(path) {
    const pathMap = {
      '/api/catch': 'catch-service',
      '/api/users': 'user-service',
      '/api/pokemon': 'pokemon-service',
      '/api/location': 'location-service',
      '/api/gym': 'gym-service',
      '/api/social': 'social-service',
      '/api/reward': 'reward-service',
      '/api/payment': 'payment-service'
    };
    
    for (const [prefix, service] of Object.entries(pathMap)) {
      if (path.startsWith(prefix)) {
        return service;
      }
    }
    
    return null;
  }
};

module.exports = CanaryRouter;
```

### 4.2 金丝雀发布管理服务

#### backend/shared/canaryManager.js

```javascript
/**
 * 金丝雀发布管理器
 */

const { db } = require('./db');
const { EventBus, EVENTS } = require('./EventBus');

class CanaryManager {
  constructor() {
    // 金丝雀发布策略
    this.strategies = {
      progressive: [5, 25, 50, 100], // 渐进式：5% -> 25% -> 50% -> 100%
      manual: [], // 手动控制
      auto: [10, 30, 50, 80, 100] // 自动：10% -> 30% -> 50% -> 80% -> 100%
    };
    
    // 验证指标阈值
    this.metricThresholds = {
      errorRate: 0.05, // 错误率 < 5%
      latencyP95: 1000, // P95 延迟 < 1000ms
      successRate: 0.95 // 成功率 > 95%
    };
  }
  
  /**
   * 创建金丝雀发布
   */
  async createCanaryDeployment(options) {
    const {
      serviceName,
      canaryVersion,
      stableVersion,
      strategy = 'progressive',
      initialTraffic = 5,
      autoPromote = true,
      metricsBaseline = {}
    } = options;
    
    // 检查是否已有活跃的金丝雀发布
    const existing = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE service_name = $1 AND status IN ('active', 'promoting')
    `, [serviceName]);
    
    if (existing.rows.length > 0) {
      throw new Error('Active canary deployment already exists for this service');
    }
    
    // 创建金丝雀发布记录
    const result = await db.query(`
      INSERT INTO canary_deployments 
        (service_name, canary_version, stable_version, traffic_split, 
         strategy, auto_promote, metrics_baseline, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
      RETURNING *
    `, [serviceName, canaryVersion, stableVersion, initialTraffic, 
        strategy, autoPromote, JSON.stringify(metricsBaseline)]);
    
    const deployment = result.rows[0];
    
    // 发布事件
    await EventBus.publish(EVENTS.CANARY_DEPLOYMENT_STARTED, {
      deploymentId: deployment.id,
      serviceName,
      canaryVersion,
      initialTraffic,
      timestamp: new Date()
    });
    
    return deployment;
  }
  
  /**
   * 调整金丝雀流量
   */
  async adjustTraffic(deploymentId, newTraffic) {
    const deployment = await this.getDeployment(deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    
    if (deployment.status !== 'active') {
      throw new Error('Deployment is not active');
    }
    
    // 验证流量百分比
    if (newTraffic < 0 || newTraffic > 100) {
      throw new Error('Traffic must be between 0 and 100');
    }
    
    // 更新流量分割
    await db.query(`
      UPDATE canary_deployments 
      SET traffic_split = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [newTraffic, deploymentId]);
    
    // 记录历史
    await this.recordHistory(deploymentId, 'traffic_adjusted', {
      oldTraffic: deployment.traffic_split,
      newTraffic
    });
    
    // 发布事件
    await EventBus.publish(EVENTS.CANARY_TRAFFIC_ADJUSTED, {
      deploymentId,
      serviceName: deployment.service_name,
      oldTraffic: deployment.traffic_split,
      newTraffic,
      timestamp: new Date()
    });
    
    return { success: true, newTraffic };
  }
  
  /**
   * 推进金丝雀发布
   */
  async promoteCanary(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    
    // 验证指标是否正常
    const metricsValid = await this.validateMetrics(deploymentId);
    
    if (!metricsValid.valid) {
      throw new Error(`Metrics validation failed: ${metricsValid.reason}`);
    }
    
    const strategy = this.strategies[deployment.strategy] || this.strategies.progressive;
    const currentIndex = strategy.indexOf(deployment.traffic_split);
    const nextTraffic = strategy[currentIndex + 1] || 100;
    
    if (nextTraffic === 100) {
      // 完成金丝雀发布，全部切换到新版本
      return await this.completeCanary(deploymentId);
    } else {
      // 推进到下一阶段
      return await this.adjustTraffic(deploymentId, nextTraffic);
    }
  }
  
  /**
   * 完成金丝雀发布
   */
  async completeCanary(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    
    // 更新状态为完成
    await db.query(`
      UPDATE canary_deployments 
      SET status = 'completed', 
          completed_at = CURRENT_TIMESTAMP,
          traffic_split = 100
      WHERE id = $1
    `, [deploymentId]);
    
    // 记录历史
    await this.recordHistory(deploymentId, 'completed', {
      canaryVersion: deployment.canary_version
    });
    
    // 发布事件
    await EventBus.publish(EVENTS.CANARY_DEPLOYMENT_COMPLETED, {
      deploymentId,
      serviceName: deployment.service_name,
      canaryVersion: deployment.canary_version,
      timestamp: new Date()
    });
    
    return { success: true, status: 'completed' };
  }
  
  /**
   * 回滚金丝雀发布
   */
  async rollbackCanary(deploymentId, reason = '') {
    const deployment = await this.getDeployment(deploymentId);
    
    if (!deployment) {
      throw new Error('Deployment not found');
    }
    
    // 立即将流量切换回稳定版本
    await db.query(`
      UPDATE canary_deployments 
      SET status = 'rolled_back',
          traffic_split = 0,
          rollback_reason = $1,
          rolled_back_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [reason, deploymentId]);
    
    // 记录历史
    await this.recordHistory(deploymentId, 'rolled_back', { reason });
    
    // 发布事件
    await EventBus.publish(EVENTS.CANARY_DEPLOYMENT_ROLLED_BACK, {
      deploymentId,
      serviceName: deployment.service_name,
      reason,
      timestamp: new Date()
    });
    
    return { success: true, status: 'rolled_back' };
  }
  
  /**
   * 验证指标
   */
  async validateMetrics(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    const metrics = await this.collectMetrics(deploymentId);
    
    // 对比基线指标
    const baseline = deployment.metrics_baseline || {};
    
    // 错误率检查
    if (metrics.errorRate > this.metricThresholds.errorRate) {
      return {
        valid: false,
        reason: `Error rate ${metrics.errorRate} exceeds threshold ${this.metricThresholds.errorRate}`
      };
    }
    
    // 延迟检查
    if (metrics.latencyP95 > this.metricThresholds.latencyP95) {
      return {
        valid: false,
        reason: `P95 latency ${metrics.latencyP95}ms exceeds threshold ${this.metricThresholds.latencyP95}ms`
      };
    }
    
    // 成功率检查
    if (metrics.successRate < this.metricThresholds.successRate) {
      return {
        valid: false,
        reason: `Success rate ${metrics.successRate} below threshold ${this.metricThresholds.successRate}`
      };
    }
    
    return { valid: true, metrics };
  }
  
  /**
   * 收集指标
   */
  async collectMetrics(deploymentId) {
    const deployment = await this.getDeployment(deploymentId);
    
    // 从 Prometheus 查询指标
    const query = `
      sum(rate(http_requests_total{service="${deployment.service_name}",version="${deployment.canary_version}",status!~"5.."}[5m]))
      /
      sum(rate(http_requests_total{service="${deployment.service_name}",version="${deployment.canary_version}"}[5m]))
    `;
    
    // 这里简化为模拟数据，实际应查询 Prometheus
    const metrics = {
      errorRate: Math.random() * 0.1, // 模拟错误率 0-10%
      latencyP95: 500 + Math.random() * 500, // 模拟延迟 500-1000ms
      successRate: 0.9 + Math.random() * 0.1, // 模拟成功率 90-100%
      requestRate: 1000 + Math.random() * 500 // 模拟请求率
    };
    
    // 保存指标快照
    await db.query(`
      INSERT INTO canary_metrics_snapshots 
        (deployment_id, metrics, created_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
    `, [deploymentId, JSON.stringify(metrics)]);
    
    return metrics;
  }
  
  /**
   * 自动推进金丝雀发布
   */
  async autoPromoteCanary() {
    // 查询所有启用自动推进的活跃金丝雀发布
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status = 'active' AND auto_promote = true
    `);
    
    for (const deployment of result.rows) {
      try {
        // 验证指标
        const validation = await this.validateMetrics(deployment.id);
        
        if (validation.valid) {
          // 检查是否已在当前流量百分比停留足够时间
          const timeSinceUpdate = Date.now() - new Date(deployment.updated_at).getTime();
          const minDuration = 5 * 60 * 1000; // 5 分钟
          
          if (timeSinceUpdate > minDuration) {
            // 自动推进
            await this.promoteCanary(deployment.id);
          }
        } else {
          // 指标异常，自动回滚
          await this.rollbackCanary(deployment.id, validation.reason);
        }
      } catch (error) {
        console.error(`Auto promote failed for deployment ${deployment.id}:`, error);
      }
    }
  }
  
  /**
   * 获取部署详情
   */
  async getDeployment(deploymentId) {
    const result = await db.query(
      'SELECT * FROM canary_deployments WHERE id = $1',
      [deploymentId]
    );
    return result.rows[0];
  }
  
  /**
   * 获取服务的活跃金丝雀发布
   */
  async getActiveCanary(serviceName) {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE service_name = $1 AND status IN ('active', 'promoting')
    `, [serviceName]);
    return result.rows[0];
  }
  
  /**
   * 记录历史
   */
  async recordHistory(deploymentId, action, details) {
    await db.query(`
      INSERT INTO canary_deployment_history 
        (deployment_id, action, details, created_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    `, [deploymentId, action, JSON.stringify(details)]);
  }
}

module.exports = new CanaryManager();
```

### 4.3 数据库迁移

#### database/pending/20260610_040000__add_canary_deployment_tables.sql

```sql
-- 金丝雀发布主表
CREATE TABLE canary_deployments (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    
    -- 版本信息
    canary_version VARCHAR(100) NOT NULL,
    stable_version VARCHAR(100) NOT NULL,
    
    -- 流量控制
    traffic_split INTEGER DEFAULT 0 CHECK (traffic_split >= 0 AND traffic_split <= 100),
    
    -- 策略
    strategy VARCHAR(20) DEFAULT 'progressive' CHECK (strategy IN ('progressive', 'manual', 'auto', 'header', 'cookie', 'user-segment')),
    rules JSONB DEFAULT '{}',
    auto_promote BOOLEAN DEFAULT true,
    
    -- 指标基线
    metrics_baseline JSONB DEFAULT '{}',
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'promoting', 'completed', 'rolled_back', 'cancelled')),
    
    -- 回滚信息
    rollback_reason TEXT,
    rolled_back_at TIMESTAMP,
    
    -- 时间戳
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    
    created_by INTEGER REFERENCES users(id),
    
    CONSTRAINT unique_active_canary UNIQUE (service_name, status) 
      WHERE status IN ('active', 'promoting')
);

-- 金丝雀发布历史表
CREATE TABLE canary_deployment_history (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 金丝雀指标快照表
CREATE TABLE canary_metrics_snapshots (
    id SERIAL PRIMARY KEY,
    deployment_id INTEGER NOT NULL REFERENCES canary_deployments(id) ON DELETE CASCADE,
    metrics JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_canary_deployments_service ON canary_deployments(service_name, status);
CREATE INDEX idx_canary_deployments_status ON canary_deployments(status);
CREATE INDEX idx_canary_history_deployment ON canary_deployment_history(deployment_id);
CREATE INDEX idx_canary_metrics_deployment ON canary_metrics_snapshots(deployment_id, created_at DESC);

-- 注释
COMMENT ON TABLE canary_deployments IS '金丝雀发布主表';
COMMENT ON TABLE canary_deployment_history IS '金丝雀发布历史记录';
COMMENT ON TABLE canary_metrics_snapshots IS '金丝雀指标快照';
```

### 4.4 金丝雀发布 API

#### backend/gateway/src/routes/canary.js

```javascript
/**
 * 金丝雀发布管理 API
 */

const express = require('express');
const router = express.Router();
const canaryManager = require('../../shared/canaryManager');
const { requireAdmin } = require('../middleware/auth');

/**
 * GET /api/canary/deployments
 * 获取所有金丝雀发布
 */
router.get('/deployments', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      ORDER BY created_at DESC
      LIMIT 100
    `);
    
    res.json({ deployments: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id
 * 获取单个金丝雀发布详情
 */
router.get('/deployments/:id', requireAdmin, async (req, res) => {
  try {
    const deployment = await canaryManager.getDeployment(req.params.id);
    
    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found' });
    }
    
    // 获取最新指标
    const metrics = await canaryManager.collectMetrics(req.params.id);
    
    res.json({ deployment, metrics });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/canary/deployments
 * 创建金丝雀发布
 */
router.post('/deployments', requireAdmin, async (req, res) => {
  try {
    const deployment = await canaryManager.createCanaryDeployment(req.body);
    res.status(201).json(deployment);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/canary/deployments/:id/traffic
 * 调整金丝雀流量
 */
router.put('/deployments/:id/traffic', requireAdmin, async (req, res) => {
  try {
    const { traffic } = req.body;
    const result = await canaryManager.adjustTraffic(req.params.id, traffic);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/promote
 * 推进金丝雀发布
 */
router.post('/deployments/:id/promote', requireAdmin, async (req, res) => {
  try {
    const result = await canaryManager.promoteCanary(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/rollback
 * 回滚金丝雀发布
 */
router.post('/deployments/:id/rollback', requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await canaryManager.rollbackCanary(req.params.id, reason);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id/history
 * 获取金丝雀发布历史
 */
router.get('/deployments/:id/history', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM canary_deployment_history 
      WHERE deployment_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.id]);
    
    res.json({ history: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id/metrics
 * 获取金丝雀发布指标
 */
router.get('/deployments/:id/metrics', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM canary_metrics_snapshots 
      WHERE deployment_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.params.id]);
    
    res.json({ metrics: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/validate
 * 验证金丝雀发布指标
 */
router.post('/deployments/:id/validate', requireAdmin, async (req, res) => {
  try {
    const result = await canaryManager.validateMetrics(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 4.5 GitHub Actions 金丝雀发布工作流

#### .github/workflows/canary-deploy.yml

```yaml
name: Canary Deployment

on:
  workflow_dispatch:
    inputs:
      service:
        description: 'Service to deploy (e.g., catch-service)'
        required: true
      canary_version:
        description: 'Canary version tag'
        required: true
      initial_traffic:
        description: 'Initial traffic percentage (default: 5)'
        required: false
        default: '5'
      strategy:
        description: 'Deployment strategy'
        type: choice
        options:
          - progressive
          - manual
          - auto
        default: progressive
      auto_promote:
        description: 'Auto promote if metrics are healthy'
        type: boolean
        default: true

env:
  DEPLOY_DIR: /data/mineGo

jobs:
  canary-deploy:
    name: 🐤 Canary Deploy
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - name: Initialize Canary Deployment
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            set -euo pipefail
            
            SERVICE="${{ github.event.inputs.service }}"
            CANARY_VERSION="${{ github.event.inputs.canary_version }}"
            INITIAL_TRAFFIC="${{ github.event.inputs.initial_traffic }}"
            STRATEGY="${{ github.event.inputs.strategy }}"
            AUTO_PROMOTE="${{ github.event.inputs.auto_promote }}"
            
            echo "╔══════════════════════════════════════════╗"
            echo "║  🐤 Canary Deployment                    ║"
            echo "║  Service: $SERVICE"
            echo "║  Version: $CANARY_VERSION"
            echo "║  Traffic: ${INITIAL_TRAFFIC}%"
            echo "║  Strategy: $STRATEGY"
            echo "╚══════════════════════════════════════════╝"
            
            cd "$DEPLOY_DIR"
            
            # 获取当前稳定版本
            STABLE_VERSION=$(curl -s http://localhost:8080/api/version | jq -r '.version')
            echo "Stable version: $STABLE_VERSION"
            
            # 创建金丝雀发布
            curl -X POST http://localhost:8080/api/canary/deployments \
              -H "Content-Type: application/json" \
              -H "Authorization: Bearer ${{ secrets.ADMIN_TOKEN }}" \
              -d "{
                \"serviceName\": \"$SERVICE\",
                \"canaryVersion\": \"$CANARY_VERSION\",
                \"stableVersion\": \"$STABLE_VERSION\",
                \"initialTraffic\": $INITIAL_TRAFFIC,
                \"strategy\": \"$STRATEGY\",
                \"autoPromote\": $AUTO_PROMOTE
              }"
            
            echo "✅ Canary deployment created"

      - name: Monitor Canary Metrics
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            set -euo pipefail
            
            SERVICE="${{ github.event.inputs.service }}"
            MONITOR_DURATION=300  # 5 minutes
            
            echo "📊 Monitoring canary metrics for ${MONITOR_DURATION}s..."
            
            START=$(date +%s)
            
            while true; do
              CURRENT=$(date +%s)
              ELAPSED=$((CURRENT - START))
              
              if [ $ELAPSED -ge $MONITOR_DURATION ]; then
                echo "✅ Monitoring complete"
                break
              fi
              
              # 检查金丝雀健康
              HEALTH=$(curl -s "http://localhost:8080/api/canary/deployments?service=$SERVICE" | \
                       jq -r '.deployments[0].status')
              
              if [ "$HEALTH" = "rolled_back" ]; then
                echo "❌ Canary deployment was rolled back"
                exit 1
              fi
              
              echo "[$ELAPSED s] Status: $HEALTH"
              sleep 30
            done

      - name: Notify on Success
        if: success()
        run: |
          curl -X POST "${{ secrets.SLACK_WEBHOOK }}" \
            -H 'Content-Type: application/json' \
            -d "{\"text\":\"🐤 Canary deployment started for ${{ github.event.inputs.service }}\nVersion: ${{ github.event.inputs.canary_version }}\nTraffic: ${{ github.event.inputs.initial_traffic }}%\"}"

      - name: Notify on Failure
        if: failure()
        run: |
          curl -X POST "${{ secrets.SLACK_WEBHOOK }}" \
            -H 'Content-Type: application/json' \
            -d "{\"text\":\"❌ Canary deployment failed for ${{ github.event.inputs.service }}\"}"
```

### 4.6 Prometheus 指标

#### backend/shared/canaryMetrics.js

```javascript
/**
 * 金丝雀发布 Prometheus 指标
 */

const client = require('prom-client');

// 金丝雀流量比例
const canaryTrafficGauge = new client.Gauge({
  name: 'canary_traffic_percentage',
  help: 'Current traffic percentage for canary deployment',
  labelNames: ['service', 'canary_version']
});

// 金丝雀请求计数
const canaryRequestsTotal = new client.Counter({
  name: 'canary_requests_total',
  help: 'Total requests routed to canary version',
  labelNames: ['service', 'canary_version', 'status']
});

// 金丝雀错误计数
const canaryErrorsTotal = new client.Counter({
  name: 'canary_errors_total',
  help: 'Total errors from canary version',
  labelNames: ['service', 'canary_version', 'error_type']
});

// 金丝雀延迟直方图
const canaryLatencyHistogram = new client.Histogram({
  name: 'canary_request_duration_seconds',
  help: 'Request latency for canary version',
  labelNames: ['service', 'canary_version'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
});

// 金丝雀部署状态
const canaryDeploymentStatus = new client.Gauge({
  name: 'canary_deployment_status',
  help: 'Current status of canary deployment (0=inactive, 1=active, 2=promoting, 3=completed, 4=rolled_back)',
  labelNames: ['service']
});

// 金丝雀指标验证结果
const canaryMetricsValid = new client.Gauge({
  name: 'canary_metrics_valid',
  help: 'Whether canary metrics are within thresholds (1=valid, 0=invalid)',
  labelNames: ['service', 'deployment_id']
});

module.exports = {
  canaryTrafficGauge,
  canaryRequestsTotal,
  canaryErrorsTotal,
  canaryLatencyHistogram,
  canaryDeploymentStatus,
  canaryMetricsValid
};
```

## 5. 验收标准（可测试）

- [ ] **金丝雀发布创建**：可通过 API 创建金丝雀发布，初始流量设置为指定百分比
- [ ] **流量分割正确**：请求按配置的百分比路由到金丝雀版本
- [ ] **渐进式发布**：支持 5% → 25% → 50% → 100% 渐进式流量切换
- [ ] **指标验证**：系统自动监控错误率、延迟、成功率等指标
- [ ] **自动回滚**：当指标异常时自动回滚到稳定版本
- [ ] **手动回滚**：支持手动触发回滚，秒级切换回稳定版本
- [ ] **多策略支持**：支持百分比、Header、Cookie、用户特征等多种分流策略
- [ ] **一致性路由**：相同用户始终路由到同一版本
- [ ] **历史记录**：所有操作（创建、调整、回滚）都有完整历史记录
- [ ] **监控指标**：提供 Prometheus 指标用于监控金丝雀发布状态
- [ ] **API 完