# REQ-00367: API 请求限流智能优化与动态配额分配系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00367 |
| 标题 | API 请求限流智能优化与动态配额分配系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、所有微服务、backend/shared、Redis、PostgreSQL |
| 创建时间 | 2026-06-29 15:00 UTC |

## 需求描述

### 背景
当前系统的 API 限流策略采用固定阈值，缺乏智能调节能力。高峰期固定限流可能导致用户体验下降，低谷期资源利用率不足。同时，不同用户群体（免费用户、付费用户、VIP用户）的配额管理不够灵活，无法根据实际业务价值和系统负载动态调整。

### 目标
实现智能限流与动态配额分配系统，具备以下能力：
1. **基于负载的自适应限流**：根据系统实时负载动态调整限流阈值
2. **用户分层配额管理**：支持多级用户配额策略，配额可动态调整
3. **请求优先级队列**：关键请求优先处理，非关键请求排队或降级
4. **配额预测与预警**：预测配额使用趋势，提前预警
5. **成本归因与优化建议**：将资源消耗与用户/业务关联，提供优化建议

### 核心价值
- 提升系统资源利用率 30%+
- 减少高峰期用户投诉 50%+
- 支持精细化成本管控
- 增强系统弹性与可观测性

## 技术方案

### 1. 智能限流引擎

#### 1.1 多维度限流策略
```javascript
// backend/shared/rateLimiter/IntelligentRateLimiter.js

class IntelligentRateLimiter {
  constructor(options = {}) {
    this.redis = options.redis;
    this.config = {
      // 基础限流配置
      baseLimits: {
        perSecond: 100,
        perMinute: 1000,
        perHour: 10000
      },
      // 系统负载阈值
      loadThresholds: {
        cpu: { low: 50, medium: 75, high: 90 },
        memory: { low: 60, medium: 80, high: 95 },
        connections: { low: 500, medium: 1000, high: 2000 }
      },
      // 动态调整因子
      adjustmentFactors: {
        low: 1.5,    // 低负载时放宽 50%
        medium: 1.0, // 中等负载保持不变
        high: 0.6    // 高负载时收紧 40%
      }
    };
    
    this.metricsCollector = options.metricsCollector;
    this.userTierManager = options.userTierManager;
  }

  /**
   * 计算动态限流阈值
   */
  async calculateDynamicLimit(userId, endpoint) {
    // 1. 获取用户层级
    const userTier = await this.userTierManager.getUserTier(userId);
    
    // 2. 获取基础限流配置
    const baseLimit = this.getBaseLimitForTier(userTier, endpoint);
    
    // 3. 获取系统当前负载
    const systemLoad = await this.metricsCollector.getSystemLoad();
    
    // 4. 计算负载等级
    const loadLevel = this.calculateLoadLevel(systemLoad);
    
    // 5. 应用动态调整因子
    const adjustmentFactor = this.config.adjustmentFactors[loadLevel];
    
    // 6. 计算最终限流阈值
    const dynamicLimit = Math.floor(baseLimit * adjustmentFactor);
    
    return {
      baseLimit,
      dynamicLimit,
      loadLevel,
      adjustmentFactor,
      systemLoad
    };
  }

  /**
   * 计算系统负载等级
   */
  calculateLoadLevel(systemLoad) {
    const scores = {
      cpu: this.getLoadScore(systemLoad.cpu, this.config.loadThresholds.cpu),
      memory: this.getLoadScore(systemLoad.memory, this.config.loadThresholds.memory),
      connections: this.getLoadScore(systemLoad.connections, this.config.loadThresholds.connections)
    };
    
    const avgScore = (scores.cpu + scores.memory + scores.connections) / 3;
    
    if (avgScore <= 1) return 'low';
    if (avgScore <= 2) return 'medium';
    return 'high';
  }

  getLoadScore(value, thresholds) {
    if (value <= thresholds.low) return 1;
    if (value <= thresholds.medium) return 2;
    return 3;
  }

  /**
   * 检查请求是否允许
   */
  async checkRateLimit(userId, endpoint, requestId) {
    const limit = await this.calculateDynamicLimit(userId, endpoint);
    const key = `ratelimit:${userId}:${endpoint}`;
    
    const current = await this.redis.incr(key);
    
    if (current === 1) {
      // 设置过期时间（滑动窗口）
      await this.redis.expire(key, 60);
    }
    
    const allowed = current <= limit.dynamicLimit;
    
    return {
      allowed,
      current,
      limit: limit.dynamicLimit,
      remaining: Math.max(0, limit.dynamicLimit - current),
      resetAt: Date.now() + 60000,
      loadLevel: limit.loadLevel
    };
  }
}
```

### 2. 用户配额管理系统

#### 2.1 分层配额策略
```javascript
// backend/shared/quota/UserQuotaManager.js

class UserQuotaManager {
  constructor(options = {}) {
    this.redis = options.redis;
    this.db = options.db;
    
    // 用户层级配额定义
    this.tierQuotas = {
      free: {
        requestsPerDay: 1000,
        requestsPerHour: 100,
        priority: 'normal',
        features: ['basic_catch', 'basic_battle', 'view_pokemon']
      },
      premium: {
        requestsPerDay: 10000,
        requestsPerHour: 500,
        priority: 'high',
        features: ['all_basic', 'advanced_battle', 'trade', 'special_events']
      },
      vip: {
        requestsPerDay: 50000,
        requestsPerHour: 2000,
        priority: 'highest',
        features: ['all_features', 'early_access', 'exclusive_pokemon']
      }
    };
  }

  /**
   * 获取用户配额
   */
  async getUserQuota(userId) {
    const tier = await this.getUserTier(userId);
    const quota = this.tierQuotas[tier];
    
    // 获取今日已使用量
    const usedToday = await this.getDailyUsage(userId);
    const usedThisHour = await this.getHourlyUsage(userId);
    
    return {
      tier,
      dailyLimit: quota.requestsPerDay,
      dailyUsed: usedToday,
      dailyRemaining: quota.requestsPerDay - usedToday,
      hourlyLimit: quota.requestsPerHour,
      hourlyUsed: usedThisHour,
      hourlyRemaining: quota.requestsPerHour - usedThisHour,
      priority: quota.priority,
      features: quota.features
    };
  }

  /**
   * 动态调整用户配额
   */
  async adjustQuota(userId, adjustment) {
    const key = `quota_adjustment:${userId}`;
    const currentAdjustment = await this.redis.get(key) || 0;
    const newAdjustment = currentAdjustment + adjustment;
    
    await this.redis.set(key, newAdjustment, 'EX', 86400); // 24小时有效
    
    // 记录调整原因
    await this.db.query(`
      INSERT INTO quota_adjustments (user_id, adjustment, reason, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [userId, adjustment, adjustment > 0 ? 'bonus' : 'penalty']);
    
    return newAdjustment;
  }

  /**
   * 配额预警检测
   */
  async checkQuotaWarning(userId) {
    const quota = await this.getUserQuota(userId);
    const usagePercentage = (quota.dailyUsed / quota.dailyLimit) * 100;
    
    const warnings = [];
    
    if (usagePercentage >= 80 && usagePercentage < 90) {
      warnings.push({
        level: 'warning',
        message: '配额使用已超过 80%',
        recommendation: '建议升级至 Premium 套餐或等待配额重置'
      });
    } else if (usagePercentage >= 90) {
      warnings.push({
        level: 'critical',
        message: '配额即将用尽',
        recommendation: '请立即升级套餐或减少使用频率'
      });
    }
    
    return {
      usagePercentage,
      warnings,
      quota
    };
  }
}
```

### 3. 请求优先级队列系统

```javascript
// backend/shared/priorityQueue/RequestPriorityQueue.js

class RequestPriorityQueue {
  constructor(options = {}) {
    this.redis = options.redis;
    this.queues = {
      highest: [],   // VIP 用户、关键业务请求
      high: [],      // Premium 用户、重要请求
      normal: [],    // 普通用户、常规请求
      low: []        // 批量操作、非关键请求
    };
    
    this.priorityWeights = {
      highest: 4,
      high: 3,
      normal: 2,
      low: 1
    };
    
    this.maxQueueSize = options.maxQueueSize || 10000;
  }

  /**
   * 将请求加入优先级队列
   */
  async enqueue(request) {
    const priority = this.determinePriority(request);
    const queueKey = `queue:${priority}`;
    
    // 检查队列大小
    const queueSize = await this.redis.llen(queueKey);
    if (queueSize >= this.maxQueueSize) {
      throw new Error('Queue is full, request rejected');
    }
    
    // 加入队列
    await this.redis.rpush(queueKey, JSON.stringify({
      ...request,
      enqueuedAt: Date.now(),
      priority
    }));
    
    // 更新队列监控指标
    await this.updateQueueMetrics(priority, 'enqueued');
    
    return { queued: true, priority, queuePosition: queueSize + 1 };
  }

  /**
   * 从队列中取出请求（按优先级）
   */
  async dequeue() {
    // 按优先级顺序检查队列
    for (const priority of ['highest', 'high', 'normal', 'low']) {
      const queueKey = `queue:${priority}`;
      const request = await this.redis.lpop(queueKey);
      
      if (request) {
        const parsedRequest = JSON.parse(request);
        await this.updateQueueMetrics(priority, 'dequeued');
        
        return {
          ...parsedRequest,
          waitTime: Date.now() - parsedRequest.enqueuedAt
        };
      }
    }
    
    return null; // 所有队列都为空
  }

  /**
   * 确定请求优先级
   */
  determinePriority(request) {
    // VIP 用户
    if (request.userTier === 'vip') return 'highest';
    
    // Premium 用户
    if (request.userTier === 'premium') return 'high';
    
    // 关键业务端点
    const criticalEndpoints = [
      '/api/auth/login',
      '/api/payment/process',
      '/api/gym/battle/start'
    ];
    if (criticalEndpoints.includes(request.endpoint)) return 'high';
    
    // 批量操作
    if (request.isBatch) return 'low';
    
    // 默认普通优先级
    return 'normal';
  }

  /**
   * 获取队列状态
   */
  async getQueueStatus() {
    const status = {};
    
    for (const priority of Object.keys(this.queues)) {
      const queueKey = `queue:${priority}`;
      status[priority] = {
        size: await this.redis.llen(queueKey),
        maxCapacity: this.maxQueueSize,
        utilization: (await this.redis.llen(queueKey)) / this.maxQueueSize * 100
      };
    }
    
    return status;
  }
}
```

### 4. 配额预测与预警系统

```javascript
// backend/shared/quota/QuotaPredictor.js

class QuotaPredictor {
  constructor(options = {}) {
    this.redis = options.redis;
    this.db = options.db;
    this.mlModel = options.mlModel; // 可选的机器学习模型
  }

  /**
   * 预测用户配额使用趋势
   */
  async predictUsageTrend(userId, hoursAhead = 24) {
    // 获取历史使用数据
    const historicalData = await this.getHistoricalUsage(userId, 7); // 过去7天
    
    // 分析使用模式
    const patterns = this.analyzePatterns(historicalData);
    
    // 预测未来使用
    const predictions = [];
    const quota = await this.getUserQuota(userId);
    
    for (let i = 1; i <= hoursAhead; i++) {
      const predictedUsage = this.predictHourlyUsage(patterns, i);
      const currentUsage = await this.getHourlyUsage(userId, 0);
      const cumulativeUsage = currentUsage + predictedUsage.cumulative;
      
      predictions.push({
        hour: i,
        predictedRequests: predictedUsage.requests,
        cumulativeUsage,
        remainingQuota: quota.dailyLimit - cumulativeUsage,
        willExhaust: cumulativeUsage >= quota.dailyLimit * 0.95
      });
    }
    
    return {
      userId,
      currentQuota: quota,
      predictions,
      warningHours: predictions.filter(p => p.willExhaust).map(p => p.hour)
    };
  }

  /**
   * 分析使用模式
   */
  analyzePatterns(historicalData) {
    const patterns = {
      hourlyDistribution: new Array(24).fill(0),
      weekdayDistribution: new Array(7).fill(0),
      averageRequestsPerHour: 0,
      peakHours: [],
      trendDirection: 'stable' // 'increasing', 'decreasing', 'stable'
    };
    
    // 计算每小时分布
    historicalData.forEach(day => {
      day.hourlyUsage.forEach((count, hour) => {
        patterns.hourlyDistribution[hour] += count;
      });
      patterns.weekdayDistribution[day.weekday] += day.totalUsage;
    });
    
    // 归一化
    const totalDays = historicalData.length;
    patterns.hourlyDistribution = patterns.hourlyDistribution.map(
      h => h / totalDays
    );
    
    // 找出高峰时段
    const avgHourlyUsage = patterns.hourlyDistribution.reduce((a, b) => a + b) / 24;
    patterns.peakHours = patterns.hourlyDistribution
      .map((usage, hour) => ({ hour, usage }))
      .filter(h => h.usage > avgHourlyUsage * 1.5)
      .map(h => h.hour);
    
    // 分析趋势
    const recentTrend = historicalData.slice(-3);
    const olderTrend = historicalData.slice(0, -3);
    
    const recentAvg = recentTrend.reduce((sum, d) => sum + d.totalUsage, 0) / recentTrend.length;
    const olderAvg = olderTrend.reduce((sum, d) => sum + d.totalUsage, 0) / olderTrend.length;
    
    if (recentAvg > olderAvg * 1.1) patterns.trendDirection = 'increasing';
    else if (recentAvg < olderAvg * 0.9) patterns.trendDirection = 'decreasing';
    
    return patterns;
  }

  /**
   * 智能预警系统
   */
  async generateWarnings(userId) {
    const prediction = await this.predictUsageTrend(userId, 24);
    const warnings = [];
    
    // 配额即将用尽预警
    if (prediction.warningHours.length > 0) {
      warnings.push({
        type: 'quota_exhaustion',
        severity: 'high',
        message: `预计在未来 ${prediction.warningHours[0]} 小时内配额将用尽`,
        recommendations: [
          '升级至更高层级套餐',
          '在非高峰时段使用服务',
          '减少批量操作频率'
        ]
      });
    }
    
    // 使用趋势异常预警
    if (prediction.patterns?.trendDirection === 'increasing') {
      warnings.push({
        type: 'usage_spike',
        severity: 'medium',
        message: '检测到使用量异常增长趋势',
        recommendations: [
          '检查是否有自动化脚本在使用',
          '考虑优化请求频率',
          '联系客服了解优化建议'
        ]
      });
    }
    
    return warnings;
  }
}
```

### 5. 成本归因与优化建议引擎

```javascript
// backend/shared/cost/CostAttributionEngine.js

class CostAttributionEngine {
  constructor(options = {}) {
    this.db = options.db;
    this.redis = options.redis;
  }

  /**
   * 计算资源成本归因
   */
  async calculateCostAttribution(timeRange = '24h') {
    const metrics = await this.collectResourceMetrics(timeRange);
    
    const attribution = {
      byUser: {},
      byEndpoint: {},
      byTier: {},
      totalCost: 0
    };
    
    // 计算各维度成本
    for (const record of metrics) {
      const cost = this.calculateRequestCost(record);
      
      // 用户维度
      if (!attribution.byUser[record.userId]) {
        attribution.byUser[record.userId] = { requests: 0, cost: 0 };
      }
      attribution.byUser[record.userId].requests++;
      attribution.byUser[record.userId].cost += cost;
      
      // 端点维度
      if (!attribution.byEndpoint[record.endpoint]) {
        attribution.byEndpoint[record.endpoint] = { requests: 0, cost: 0 };
      }
      attribution.byEndpoint[record.endpoint].requests++;
      attribution.byEndpoint[record.endpoint].cost += cost;
      
      // 用户层级维度
      const tier = record.userTier || 'free';
      if (!attribution.byTier[tier]) {
        attribution.byTier[tier] = { requests: 0, cost: 0, users: new Set() };
      }
      attribution.byTier[tier].requests++;
      attribution.byTier[tier].cost += cost;
      attribution.byTier[tier].users.add(record.userId);
      
      attribution.totalCost += cost;
    }
    
    // 转换 Set 为数量
    Object.keys(attribution.byTier).forEach(tier => {
      attribution.byTier[tier].uniqueUsers = attribution.byTier[tier].users.size;
      delete attribution.byTier[tier].users;
    });
    
    return attribution;
  }

  /**
   * 计算单个请求成本
   */
  calculateRequestCost(record) {
    const baseCost = 0.0001; // 基础请求成本
    
    // 根据请求类型加权
    const weights = {
      '/api/catch': 2.0,        // 捕捉请求成本较高
      '/api/gym/battle': 3.0,   // 战斗请求成本最高
      '/api/pokemon/list': 0.5, // 列表查询成本较低
      'default': 1.0
    };
    
    const weight = weights[record.endpoint] || weights.default;
    
    // 考虑响应时间和数据大小
    const responseTimeFactor = Math.min(record.responseTime / 100, 2); // 响应时间因子
    const dataSizeFactor = Math.min(record.responseSize / 1024, 1.5); // 数据大小因子
    
    return baseCost * weight * responseTimeFactor * dataSizeFactor;
  }

  /**
   * 生成优化建议
   */
  async generateOptimizationSuggestions(userId) {
    const attribution = await this.calculateCostAttribution('7d');
    const userMetrics = attribution.byUser[userId];
    
    if (!userMetrics) return [];
    
    const suggestions = [];
    
    // 高频低价值请求优化
    const userEndpoints = await this.getUserEndpointUsage(userId);
    const lowValueEndpoints = userEndpoints.filter(
      e => e.count > 100 && e.avgResponseTime < 50
    );
    
    if (lowValueEndpoints.length > 0) {
      suggestions.push({
        type: 'caching',
        priority: 'high',
        title: '启用客户端缓存',
        description: `检测到 ${lowValueEndpoints.length} 个端点可启用本地缓存以减少请求`,
        potentialSavings: userMetrics.cost * 0.2,
        implementation: '在前端添加请求去重和本地缓存逻辑'
      });
    }
    
    // 批量操作优化
    const batchOperations = await this.getUserBatchOperations(userId);
    if (batchOperations.length > 0) {
      suggestions.push({
        type: 'batch_optimization',
        priority: 'medium',
        title: '优化批量请求策略',
        description: `检测到 ${batchOperations.length} 个批量操作，建议合并或延迟执行`,
        potentialSavings: userMetrics.cost * 0.15,
        implementation: '使用消息队列延迟处理非紧急批量请求'
      });
    }
    
    // 套餐升级建议
    const quotaUsage = await this.getUserQuotaUsage(userId);
    if (quotaUsage.utilization > 0.9) {
      suggestions.push({
        type: 'upgrade',
        priority: 'high',
        title: '升级用户套餐',
        description: '当前套餐使用率超过 90%，升级可获更高配额和更好体验',
        benefits: ['更高的请求配额', '优先队列处理', '专属功能解锁'],
        roi: `每月可节省 ${(quotaUsage.exceededRequests * 0.001).toFixed(2)} 美元`
      });
    }
    
    return suggestions;
  }
}
```

### 6. API 端点与中间件集成

```javascript
// backend/shared/middleware/smartRateLimitMiddleware.js

const intelligentRateLimiter = require('../rateLimiter/IntelligentRateLimiter');
const userQuotaManager = require('../quota/UserQuotaManager');
const requestPriorityQueue = require('../priorityQueue/RequestPriorityQueue');

async function smartRateLimitMiddleware(req, res, next) {
  const userId = req.user?.id;
  const endpoint = req.path;
  
  if (!userId) {
    return next(); // 未认证请求使用基础限流
  }
  
  try {
    // 1. 检查智能限流
    const rateLimitResult = await intelligentRateLimiter.checkRateLimit(
      userId,
      endpoint,
      req.requestId
    );
    
    // 2. 检查配额预警
    const quotaWarning = await userQuotaManager.checkQuotaWarning(userId);
    if (quotaWarning.warnings.length > 0) {
      res.setHeader('X-Quota-Warning', JSON.stringify(quotaWarning.warnings));
    }
    
    // 3. 根据系统负载决定处理策略
    if (!rateLimitResult.allowed) {
      // 高负载时，将请求加入队列
      if (rateLimitResult.loadLevel === 'high') {
        const queueResult = await requestPriorityQueue.enqueue({
          requestId: req.requestId,
          userId,
          endpoint,
          userTier: req.user.tier,
          timestamp: Date.now()
        });
        
        return res.status(202).json({
          message: '系统负载较高，请求已加入队列',
          queuePosition: queueResult.queuePosition,
          estimatedWaitTime: queueResult.queuePosition * 100, // 估算等待时间
          requestId: req.requestId
        });
      }
      
      // 正常限流拒绝
      return res.status(429).json({
        error: '请求过于频繁，请稍后再试',
        retryAfter: rateLimitResult.resetAt,
        current: rateLimitResult.current,
        limit: rateLimitResult.limit,
        remaining: rateLimitResult.remaining
      });
    }
    
    // 4. 添加限流信息到响应头
    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.resetAt);
    res.setHeader('X-System-Load', rateLimitResult.loadLevel);
    
    next();
  } catch (error) {
    console.error('Smart rate limit middleware error:', error);
    next(); // 出错时放行，不影响用户体验
  }
}

module.exports = smartRateLimitMiddleware;
```

### 7. 数据库 Schema 设计

```sql
-- 用户配额调整记录表
CREATE TABLE quota_adjustments (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  adjustment INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL, -- 'bonus', 'penalty', 'event', 'manual'
  admin_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_id (user_id),
  INDEX idx_created_at (created_at)
);

-- 请求成本归因表
CREATE TABLE request_cost_attribution (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  request_id VARCHAR(255),
  response_time_ms INTEGER,
  response_size_bytes INTEGER,
  cost_usd DECIMAL(10, 8),
  user_tier VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_created (user_id, created_at),
  INDEX idx_endpoint (endpoint),
  INDEX idx_created_at (created_at)
);

-- 用户使用历史表（用于预测分析）
CREATE TABLE user_usage_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  hour INTEGER NOT NULL,
  request_count INTEGER DEFAULT 0,
  unique_users INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE KEY uk_user_date_hour (user_id, date, hour),
  INDEX idx_date (date)
);
```

## 验收标准

- [ ] 智能限流引擎完成开发并集成到 gateway
- [ ] 用户分层配额管理系统支持 free/premium/vip 三层
- [ ] 请求优先级队列系统支持 4 级优先级
- [ ] 配额预测准确率达到 85%+（预测 4 小时内的使用量）
- [ ] 成本归因引擎支持按用户/端点/层级归因
- [ ] 优化建议引擎至少生成 3 种类型建议
- [ ] 系统负载自适应限流在高负载时自动触发
- [ ] 所有 API 响应包含限流信息头（X-RateLimit-*）
- [ ] 配额预警功能在达到 80% 和 90% 时触发
- [ ] 队列系统最大容量 10000，超出后拒绝请求
- [ ] 完整的单元测试覆盖率 80%+
- [ ] 集成测试验证端到端流程
- [ ] 监控面板显示实时限流状态和配额使用情况
- [ ] 文档完整，包括 API 说明和配置指南

## 影响范围

### 新增文件
- `backend/shared/rateLimiter/IntelligentRateLimiter.js`
- `backend/shared/quota/UserQuotaManager.js`
- `backend/shared/quota/QuotaPredictor.js`
- `backend/shared/priorityQueue/RequestPriorityQueue.js`
- `backend/shared/cost/CostAttributionEngine.js`
- `backend/shared/middleware/smartRateLimitMiddleware.js`
- `database/migrations/20260629_add_quota_tables.sql`

### 修改文件
- `gateway/src/middleware/rateLimit.js` - 升级为智能限流
- `gateway/src/app.js` - 集成新的限流中间件
- `user-service/src/routes/quota.js` - 新增配额查询 API
- `backend/shared/index.js` - 导出新模块

### 依赖服务
- Redis - 存储限流计数器和队列
- PostgreSQL - 存储历史数据和归因记录
- Prometheus - 限流指标监控
- Grafana - 可视化面板

## 参考

- [Token Bucket 算法](https://en.wikipedia.org/wiki/Token_bucket)
- [Redis Rate Limiting](https://redis.io/glossary/rate-limiting/)
- [Google Cloud Quota Management](https://cloud.google.com/docs/quota)
- [AWS API Gateway Throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)
