# REQ-00289: 精灵交换欺诈检测与交易安全系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00289 |
| 标题 | 精灵交换欺诈检测与交易安全系统 |
| 类别 | 反作弊 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | exchange-service, trade-service, user-service, notification-service |
| 创建时间 | 2026-06-22 10:00 |

## 需求描述

精灵交换系统是游戏核心社交功能之一，但存在多种欺诈风险：
- **价值不对等欺诈**：利用信息不对称诱导玩家交换低价值精灵
- **虚假属性展示**：修改客户端展示虚假的精灵属性/技能
- **中间人攻击**：劫持交换通信篡改交易内容
- **恶意撤销**：在交换确认后强制断开连接导致交易异常
- **账号盗用交易**：盗号后转移高价值精灵
- **洗号团伙**：有组织的精灵转移团伙

本需求构建多层次欺诈检测与交易安全系统，保障玩家资产安全。

## 技术方案

### 1. 交易价值评估引擎

```typescript
// 精灵价值评估模型
interface PokemonValuation {
  pokemonId: string;
  baseValue: number;      // 基础价值（稀有度、等级）
  marketValue: number;    // 市场价值（近期交易均价）
  rarity: number;         // 稀有度评分 1-100
  potential: number;      // 潜力值（IV、天赋、技能）
  sentimental: number;    // 情感价值（陪伴时长、事件精灵）
  totalValue: number;     // 综合价值
}

class PokemonValuationEngine {
  // 价值评估算法
  async evaluate(pokemon: Pokemon): Promise<PokemonValuation> {
    const baseValue = this.calculateBaseValue(pokemon);
    const marketValue = await this.getMarketValue(pokemon.speciesId);
    const rarity = this.calculateRarity(pokemon);
    const potential = this.calculatePotential(pokemon);
    const sentimental = await this.calculateSentimental(pokemon);
    
    const totalValue = this.weightedSum({
      base: { value: baseValue, weight: 0.3 },
      market: { value: marketValue, weight: 0.25 },
      rarity: { value: rarity, weight: 0.2 },
      potential: { value: potential, weight: 0.15 },
      sentimental: { value: sentimental, weight: 0.1 }
    });
    
    return { pokemonId: pokemon.id, baseValue, marketValue, rarity, potential, sentimental, totalValue };
  }
  
  // 价值差异评估
  async evaluateTradeFairness(offer: Pokemon, receive: Pokemon): Promise<TradeFairnessResult> {
    const offerValue = await this.evaluate(offer);
    const receiveValue = await this.evaluate(receive);
    
    const ratio = offerValue.totalValue / receiveValue.totalValue;
    const difference = Math.abs(offerValue.totalValue - receiveValue.totalValue);
    
    let risk: 'safe' | 'warning' | 'danger';
    if (ratio >= 0.7 && ratio <= 1.4) {
      risk = 'safe';
    } else if (ratio >= 0.4 && ratio <= 2.5) {
      risk = 'warning';
    } else {
      risk = 'danger';
    }
    
    return {
      offerValue: offerValue.totalValue,
      receiveValue: receiveValue.totalValue,
      ratio,
      difference,
      risk,
      recommendation: this.getRecommendation(risk, ratio)
    };
  }
}
```

### 2. 实时欺诈检测系统

```typescript
// 欺诈检测服务
interface FraudDetectionRequest {
  tradeId: string;
  initiatorId: string;
  receiverId: string;
  initiatorOffer: Pokemon[];
  receiverOffer: Pokemon[];
  context: TradeContext;
}

interface TradeContext {
  initiatorAccountAge: number;      // 账号年龄（天）
  receiverAccountAge: number;
  initiatorTradeHistory: TradeHistory;
  receiverTradeHistory: TradeHistory;
  initiatorLoginPattern: LoginPattern;
  receiverLoginPattern: LoginPattern;
  initiatorDeviceFingerprint: string;
  receiverDeviceFingerprint: string;
  initiatorIPAddress: string;
  receiverIPAddress: string;
  geoDistance: number;              // 地理距离（km）
}

class FraudDetectionService {
  private detectors: FraudDetector[] = [
    new ValueDisparityDetector(),
    new AccountAnomalyDetector(),
    new DeviceFingerprintDetector(),
    new BehavioralPatternDetector(),
    new NetworkAnomalyDetector(),
    new GroupDetectionDetector()
  ];
  
  async analyze(request: FraudDetectionRequest): Promise<FraudAnalysisResult> {
    const scores: FraudScore[] = [];
    
    for (const detector of this.detectors) {
      const score = await detector.detect(request);
      scores.push(score);
    }
    
    const overallScore = this.aggregateScores(scores);
    const riskLevel = this.determineRiskLevel(overallScore);
    
    return {
      tradeId: request.tradeId,
      scores,
      overallScore,
      riskLevel,
      recommendation: this.getRecommendation(riskLevel),
      requiredActions: this.getRequiredActions(riskLevel),
      timestamp: Date.now()
    };
  }
  
  private determineRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score < 0.2) return 'low';
    if (score < 0.5) return 'medium';
    if (score < 0.8) return 'high';
    return 'critical';
  }
  
  private getRequiredActions(riskLevel: string): RequiredAction[] {
    const actions: Record<string, RequiredAction[]> = {
      low: ['proceed'],
      medium: ['proceed', 'send_warning', 'log_details'],
      high: ['require_confirmation', 'cool_down_period', 'notify_support'],
      critical: ['block_trade', 'flag_accounts', 'auto_review']
    };
    return actions[riskLevel];
  }
}

// 价值不对等检测器
class ValueDisparityDetector implements FraudDetector {
  async detect(request: FraudDetectionRequest): Promise<FraudScore> {
    const valuationEngine = new PokemonValuationEngine();
    
    let initiatorTotalValue = 0;
    let receiverTotalValue = 0;
    
    for (const pokemon of request.initiatorOffer) {
      const valuation = await valuationEngine.evaluate(pokemon);
      initiatorTotalValue += valuation.totalValue;
    }
    
    for (const pokemon of request.receiverOffer) {
      const valuation = await valuationEngine.evaluate(pokemon);
      receiverTotalValue += valuation.totalValue;
    }
    
    const ratio = initiatorTotalValue / receiverTotalValue;
    
    // 极端不对等
    if (ratio < 0.1 || ratio > 10) {
      return {
        type: 'value_disparity',
        score: 0.9,
        details: { initiatorTotalValue, receiverTotalValue, ratio },
        indicators: ['extreme_value_disparity']
      };
    }
    
    // 中等不对等
    if (ratio < 0.3 || ratio > 3) {
      return {
        type: 'value_disparity',
        score: 0.5,
        details: { initiatorTotalValue, receiverTotalValue, ratio },
        indicators: ['moderate_value_disparity']
      };
    }
    
    return {
      type: 'value_disparity',
      score: 0,
      details: { initiatorTotalValue, receiverTotalValue, ratio },
      indicators: []
    };
  }
}

// 账号异常检测器
class AccountAnomalyDetector implements FraudDetector {
  async detect(request: FraudDetectionRequest): Promise<FraudScore> {
    const indicators: string[] = [];
    let score = 0;
    
    const { initiatorAccountAge, receiverAccountAge, initiatorTradeHistory, receiverTradeHistory } = request.context;
    
    // 新账号风险
    if (initiatorAccountAge < 7 || receiverAccountAge < 7) {
      score += 0.3;
      indicators.push('new_account_involved');
    }
    
    // 交易历史异常
    if (initiatorTradeHistory.totalTrades === 0 && initiatorAccountAge > 30) {
      score += 0.2;
      indicators.push('dormant_account_sudden_activity');
    }
    
    // 高频交易
    if (initiatorTradeHistory.tradesLast24h > 10) {
      score += 0.25;
      indicators.push('high_frequency_trading');
    }
    
    // 单向转移模式（只给不给或只拿不给）
    if (initiatorTradeHistory.givenCount > initiatorTradeHistory.receivedCount * 5) {
      score += 0.35;
      indicators.push('one_way_transfer_pattern');
    }
    
    return {
      type: 'account_anomaly',
      score: Math.min(score, 1),
      indicators
    };
  }
}

// 行为模式检测器
class BehavioralPatternDetector implements FraudDetector {
  async detect(request: FraudDetectionRequest): Promise<FraudScore> {
    const indicators: string[] = [];
    let score = 0;
    
    // 检测交易前后的异常行为
    const initiatorBehavior = await this.getRecentBehavior(request.initiatorId);
    const receiverBehavior = await this.getRecentBehavior(request.receiverId);
    
    // 突然高价值精灵获取
    if (initiatorBehavior.recentHighValueAcquisitions > 3) {
      score += 0.4;
      indicators.push('sudden_high_value_acquisitions');
    }
    
    // 交易后立即下线
    // 检测交易前后的在线时长变化
    if (receiverBehavior.lastSessionDuration < 300 && receiverBehavior.totalTrades > 0) {
      score += 0.3;
      indicators.push('quick_logout_after_trade');
    }
    
    // 密码重置后立即交易
    if (initiatorBehavior.recentPasswordChange) {
      score += 0.35;
      indicators.push('trade_after_password_change');
    }
    
    return {
      type: 'behavioral_pattern',
      score: Math.min(score, 1),
      indicators
    };
  }
}
```

### 3. 交易确认与保护机制

```typescript
// 交易确认服务
class TradeConfirmationService {
  // 高风险交易需要额外确认
  async confirmHighRiskTrade(
    tradeId: string,
    userId: string,
    riskAnalysis: FraudAnalysisResult
  ): Promise<ConfirmationResult> {
    // 冷却期
    if (riskAnalysis.riskLevel === 'high') {
      await this.enforceCoolDown(userId, 30 * 60 * 1000); // 30分钟
    }
    
    // 双重确认
    const confirmationToken = await this.generateConfirmationToken(tradeId, userId);
    
    // 发送确认通知
    await this.notificationService.send({
      userId,
      type: 'trade_confirmation_required',
      data: {
        tradeId,
        riskLevel: riskAnalysis.riskLevel,
        warnings: riskAnalysis.scores.flatMap(s => s.indicators),
        confirmationToken,
        expiresIn: 3600
      }
    });
    
    return {
      status: 'pending_confirmation',
      confirmationToken,
      expiresIn: 3600
    };
  }
  
  // 精灵价值差异提示
  async showValueWarning(
    userId: string,
    trade: Trade,
    valuation: TradeFairnessResult
  ): Promise<void> {
    if (valuation.risk !== 'safe') {
      const warning = {
        type: 'value_disparity_warning',
        message: this.getWarningMessage(valuation),
        details: {
          yourPokemonValue: valuation.offerValue,
          theirPokemonValue: valuation.receiveValue,
          ratio: valuation.ratio
        },
        acknowledged: false
      };
      
      // 用户必须确认才能继续
      await this.tradeUI.showWarning(userId, warning);
    }
  }
}

// 交易回滚机制
class TradeRollbackService {
  private rollbackWindow = 24 * 60 * 60 * 1000; // 24小时回滚窗口
  
  async rollback(tradeId: string, reason: string): Promise<RollbackResult> {
    const trade = await this.tradeRepository.getById(tradeId);
    
    if (Date.now() - trade.timestamp > this.rollbackWindow) {
      throw new Error('Rollback window expired');
    }
    
    // 原子性回滚
    const transaction = await this.db.beginTransaction();
    try {
      // 返还精灵
      await this.returnPokemon(trade.initiatorId, trade.initiatorOffer, transaction);
      await this.returnPokemon(trade.receiverId, trade.receiverOffer, transaction);
      
      // 记录回滚
      await this.auditLog.log({
        type: 'trade_rollback',
        tradeId,
        reason,
        timestamp: Date.now()
      }, transaction);
      
      await transaction.commit();
      
      // 通知双方
      await this.notifyRollback(trade.initiatorId, trade.receiverId, reason);
      
      return { success: true, tradeId };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}
```

### 4. 团伙检测与关联分析

```typescript
// 团伙检测服务
class FraudRingDetector {
  // 关联图谱分析
  async analyzeTradeNetwork(): Promise<FraudRingReport> {
    // 构建交易图谱
    const graph = await this.buildTradeGraph();
    
    // 检测异常聚集
    const clusters = await this.detectAnomalousClusters(graph);
    
    // 分析团伙特征
    const rings: FraudRing[] = [];
    
    for (const cluster of clusters) {
      const ring = await this.analyzeCluster(cluster);
      if (ring.suspicionScore > 0.7) {
        rings.push(ring);
      }
    }
    
    return {
      totalClusters: clusters.length,
      suspiciousRings: rings,
      recommendations: this.generateRingRecommendations(rings)
    };
  }
  
  private async analyzeCluster(cluster: TradeCluster): Promise<FraudRing> {
    const members = cluster.members;
    const trades = cluster.trades;
    
    // 计算团伙特征
    const characteristics = {
      // 精灵流向集中度
      pokemonFlowConcentration: this.calculateFlowConcentration(trades),
      // 交易时间聚集度
      timeClustering: this.calculateTimeClustering(trades),
      // 账号创建时间聚集度
      accountAgeClustering: this.calculateAccountAgeClustering(members),
      // 设备/IP 重叠度
      deviceOverlap: this.calculateDeviceOverlap(members),
      // 单向交易比例
      oneWayTradeRatio: this.calculateOneWayRatio(trades)
    };
    
    const suspicionScore = this.calculateSuspicionScore(characteristics);
    
    return {
      id: cluster.id,
      members: members.map(m => m.id),
      characteristics,
      suspicionScore,
      riskLevel: suspicionScore > 0.9 ? 'critical' : suspicionScore > 0.7 ? 'high' : 'medium'
    };
  }
}
```

### 5. 审计与监控

```typescript
// 交易审计服务
class TradeAuditService {
  // 记录完整交易日志
  async logTradeEvent(event: TradeEvent): Promise<void> {
    const auditRecord = {
      tradeId: event.tradeId,
      timestamp: Date.now(),
      eventType: event.type,
      
      // 交易双方信息
      initiator: {
        id: event.initiatorId,
        ip: event.initiatorIP,
        device: event.initiatorDevice,
        geo: event.initiatorGeo
      },
      receiver: {
        id: event.receiverId,
        ip: event.receiverIP,
        device: event.receiverDevice,
        geo: event.receiverGeo
      },
      
      // 交易内容
      tradeContent: {
        initiatorOffer: event.initiatorOffer,
        receiverOffer: event.receiverOffer
      },
      
      // 风险评估
      riskAnalysis: event.riskAnalysis,
      
      // 系统信息
      serverNode: process.env.HOSTNAME,
      traceId: event.traceId
    };
    
    await this.auditStore.insert(auditRecord);
  }
  
  // 异常交易报表
  async generateAnomalyReport(timeRange: TimeRange): Promise<AnomalyReport> {
    const anomalies = await this.auditStore.query({
      timeRange,
      filters: { 'riskAnalysis.riskLevel': { $in: ['high', 'critical'] } }
    });
    
    return {
      totalAnomalies: anomalies.length,
      byType: this.groupBy(anomalies, a => a.riskAnalysis.scores[0].type),
      byRiskLevel: this.groupBy(anomalies, a => a.riskAnalysis.riskLevel),
      trends: await this.calculateTrends(anomalies),
      recommendations: this.generateRecommendations(anomalies)
    };
  }
}
```

## 验收标准

- [ ] 价值评估引擎上线，能准确评估精灵综合价值
- [ ] 6 种欺诈检测器全部实现并上线
- [ ] 高风险交易拦截率达到 95% 以上
- [ ] 误报率控制在 3% 以下（避免影响正常玩家）
- [ ] 交易回滚机制可用，回滚时间 < 5 分钟
- [ ] 团伙检测系统能识别 5 人以上欺诈团伙
- [ ] 所有欺诈交易日志保存 2 年以上
- [ ] 异常交易日报/周报自动生成
- [ ] 前端交易确认 UI 上线，价值警告清晰展示
- [ ] 冷却期机制生效，30 分钟冷却强制执行

## 影响范围

- `exchange-service`: 交易逻辑增加欺诈检测调用
- `trade-service`: 新增价值评估、确认、回滚服务
- `user-service`: 提供账号信息、设备指纹、行为数据
- `notification-service`: 风险警告通知
- `game-client`: 交易确认 UI、价值提示展示
- `audit-service`: 交易审计日志存储
- `monitoring-service`: 欺诈监控仪表盘

## 参考

- [Pokémon GO Trading Guidelines](https://pokemongolive.com/post/trading/)
- [Financial Fraud Detection ML Techniques](https://www.example.com/fraud-ml)
- [Account Takeover Prevention Best Practices](https://www.example.com/ato-prevention)
- REQ-00247: 精灵捕捉地点伪造检测系统
- REQ-00270: 攻击模式检测与实时威胁识别系统
