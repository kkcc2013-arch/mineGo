# REQ-00550：协同作弊团伙检测系统

- **编号**：REQ-00550
- **类别**：反作弊
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：gateway、user-service、social-service、backend/shared/gangDetection.js、Redis、PostgreSQL、Kafka
- **创建时间**：2026-07-15 01:00
- **依赖需求**：REQ-00028（行为异常检测）、REQ-00045（设备完整性检测）、REQ-00270（攻击模式检测）

## 1. 背景与问题

mineGo 已实现多个单账号维度的反作弊系统（GPS伪造检测、设备完整性、行为异常等），但**协同作弊（Gang Cheating）仍是一个重大盲区**：

### 现实痛点
1. **小号团伙刷资源**：玩家创建多个小号，在同一时间、同一地点同步捕捉稀有精灵，将资源转移给主号
2. **道馆占占领作弊团伙**：多人协同攻击同一道馆，通过时间窗口操纵快速占领
3. **虚假交易链**：小号之间进行虚假精灵交换，制造虚假交易流水
4. **公会排名作弊**：公会成员通过小号刷贡献、刷活跃度
5. **代练网络**：一批账号被用于代练服务，行为模式高度一致

### 数据现状
- 日均检测到疑似协同捕捉事件：约 5000 次
- 涉及协同作弊的账号占比：约 2-3%
- 作弊团伙平均规模：5-15 人
- 每个团伙日均非法获取资源价值：约 100 元

### 风险影响
- 破坏游戏公平性，导致正常玩家流失
- 虚假活跃数据影响运营决策
- 影响游戏经济系统稳定性

## 2. 目标

建立协同作弊团伙检测系统，**识别并打击 85%+ 的协同作弊行为**，将误判率控制在 0.1% 以内。

### 核心收益
1. **团伙识别**：自动发现作弊团伙，输出团伙成员关系图谱
2. **协同行为检测**：识别协同捕捉、协同道馆战、虚假交易等模式
3. **分级处置**：根据团伙规模和影响范围，实施差异化处置策略
4. **威慑效应**：形成有效的作弊成本，降低作弊意愿

## 3. 范围

### 包含
- 团伙关系图谱构建（基于时空共现、交易关系、好友关系）
- 协同捕捉检测（同一时间、同一地点、同一精灵）
- 协同道馆战检测（时间窗口操纵、快速轮换占领）
- 虚假交易链检测（闭环交易、异常价值交易）
- 团伙风险评分与分级
- 自动化处置引擎（警告、限制、封禁）
- 团伙证据链与可视化报告

### 不包含
- 支付欺诈检测（已在 REQ-00003 实现）
- 单账号作弊检测（已在 REQ-00028 实现）
- 设备级作弊检测（已在 REQ-00045 实现）

## 4. 详细需求

### 4.1 团伙关系图谱构建

#### 数据模型
```sql
-- 团伙实体表
CREATE TABLE cheating_gangs (
  id SERIAL PRIMARY KEY,
  gang_id VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(128),
  status VARCHAR(32) DEFAULT 'active', -- active/confirmed/disbanded
  risk_score DECIMAL(5,2),
  risk_level VARCHAR(16), -- low/medium/high/critical
  member_count INT DEFAULT 0,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity TIMESTAMPTZ,
  first_activity TIMESTAMPTZ,
  affected_resources JSONB, -- {pokemon_count, stardust, candy, gym_wins}
  evidence JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  INDEX idx_gang_status (status, risk_level),
  INDEX idx_gang_detected (detected_at)
);

-- 团伙成员关系表
CREATE TABLE gang_members (
  id SERIAL PRIMARY KEY,
  gang_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  role VARCHAR(32) DEFAULT 'member', -- leader/core/member/peripheral
  join_score DECIMAL(5,2), -- 加入团伙的置信度
  first_detected TIMESTAMPTZ,
  last_activity TIMESTAMPTZ,
  violations JSONB, -- [{type, count, last_time}]
  status VARCHAR(32) DEFAULT 'active', -- active/banned/left
  UNIQUE(gang_id, user_id),
  INDEX idx_user_gang (user_id),
  INDEX idx_gang_role (gang_id, role)
);

-- 团伙关系边（用于图分析）
CREATE TABLE gang_edges (
  id SERIAL PRIMARY KEY,
  gang_id VARCHAR(64) NOT NULL,
  user_id_a VARCHAR(64) NOT NULL,
  user_id_b VARCHAR(64) NOT NULL,
  edge_type VARCHAR(32) NOT NULL, -- spatial_temporal/trade/friend/gym_collab
  weight DECIMAL(5,2) DEFAULT 1.0,
  evidence_count INT DEFAULT 1,
  first_evidence TIMESTAMPTZ,
  last_evidence TIMESTAMPTZ,
  UNIQUE(gang_id, user_id_a, user_id_b, edge_type),
  INDEX idx_gang_edges (gang_id),
  INDEX idx_user_edges (user_id_a, user_id_b)
);

-- 协同作弊事件表
CREATE TABLE collab_cheat_events (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(128) UNIQUE NOT NULL,
  gang_id VARCHAR(64),
  event_type VARCHAR(32) NOT NULL, -- collab_catch/gym_collab/fake_trade/resource_transfer
  participants JSONB NOT NULL, -- [{user_id, role, location, timestamp}]
  location GEOMETRY(POINT, 4326),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  affected_pokemon_id VARCHAR(64),
  affected_gym_id VARCHAR(64),
  value_score DECIMAL(10,2), -- 作弊涉及价值
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  evidence JSONB,
  action_taken VARCHAR(32), -- logged/warned/restricted/banned
  created_at TIMESTAMPTZ DEFAULT NOW(),
  INDEX idx_gang_events (gang_id, detected_at),
  INDEX idx_event_type (event_type, detected_at)
);
```

#### 团伙发现算法
```javascript
// backend/shared/gangDetection.js
class GangDetectionEngine {
  constructor() {
    this.spatialThreshold = 50; // 50米内视为共现
    this.temporalThreshold = 60000; // 60秒内视为同步
    this.minCooccurrence = 5; // 最少共现次数
    this.minClusterSize = 3; // 最小团伙规模
  }

  // 构建时空共现图谱
  async buildSpatioTemporalGraph(userId, timeWindow = 3600000) {
    // 1. 获取用户最近的所有活动（捕捉、道馆战、交易）
    const activities = await this.getUserActivities(userId, timeWindow);
    
    // 2. 查找每个活动的共现用户
    const cooccurrences = new Map();
    for (const act of activities) {
      const nearby = await this.findNearbyUsers(act.location, this.spatialThreshold);
      const coincident = await this.findCoincidentUsers(act.timestamp, this.temporalThreshold, nearby);
      
      for (const otherId of coincident) {
        if (otherId === userId) continue;
        const key = `${userId}:${otherId}`;
        cooccurrences.set(key, (cooccurrences.get(key) || 0) + 1);
      }
    }
    
    return cooccurrences;
  }

  // 基于谱聚类发现团伙
  async detectGangs(graph) {
    // 1. 构建邻接矩阵
    const nodes = [...new Set([...graph.keys()].flatMap(k => k.split(':')))];
    const n = nodes.length;
    const adjacency = Array(n).fill(null).map(() => Array(n).fill(0));
    const nodeIndex = new Map(nodes.map((id, i) => [id, i]));
    
    for (const [key, weight] of graph) {
      const [a, b] = key.split(':');
      const i = nodeIndex.get(a);
      const j = nodeIndex.get(b);
      if (i !== undefined && j !== undefined) {
        adjacency[i][j] = weight;
        adjacency[j][i] = weight;
      }
    }

    // 2. 计算拉普拉斯矩阵
    const degree = adjacency.map(row => row.reduce((s, v) => s + v, 0));
    const laplacian = adjacency.map((row, i) =>
      row.map((v, j) => (i === j ? degree[i] : -v))
    );

    // 3. 计算特征向量并聚类
    const eigenVectors = this.computeEigenVectors(laplacian, Math.ceil(n / 3));
    const clusters = this.kMeans(eigenVectors, this.estimateK(eigenVectors));

    // 4. 过滤有效团伙
    return clusters
      .filter(c => c.length >= this.minClusterSize)
      .map(cluster => ({
        members: cluster.map(i => nodes[i]),
        density: this.computeClusterDensity(cluster, adjacency, nodeIndex)
      }));
  }

  // 计算团伙风险评分
  calculateGangRiskScore(gang) {
    let score = 0;

    // 1. 团伙规模（越大风险越高）
    score += Math.min(30, gang.members.length * 2);

    // 2. 关系密度
    score += gang.density * 20;

    // 3. 协同行为频率
    const collabEvents = gang.collabEvents || [];
    const recentEvents = collabEvents.filter(e => 
      Date.now() - new Date(e.detected_at).getTime() < 7 * 24 * 3600000
    ).length;
    score += Math.min(30, recentEvents * 3);

    // 4. 涉及价值
    const totalValue = collabEvents.reduce((s, e) => s + (e.value_score || 0), 0);
    score += Math.min(20, totalValue / 1000);

    return Math.min(100, score);
  }
}
```

### 4.2 协同捕捉检测

```javascript
class CollabCatchDetector {
  // 检测同一精灵的协同捕捉
  async detectCoordinatedCatch(pokemonSpawnId) {
    // 1. 获取所有捕捉该精灵的会话
    const sessions = await this.getCatchSessions(pokemonSpawnId);
    
    if (sessions.length < 2) return null;

    // 2. 按时间聚类
    const timeClusters = this.clusterByTime(sessions, 5000); // 5秒窗口
    
    for (const cluster of timeClusters) {
      if (cluster.length >= 3) {
        // 3. 检查空间聚集
        const locations = cluster.map(s => s.location);
        const centroid = this.computeCentroid(locations);
        const maxDistance = Math.max(...locations.map(l => 
          this.distance(l, centroid)
        ));

        if (maxDistance < 50) { // 50米内
          // 4. 验证为协同捕捉
          return {
            type: 'COORDINATED_CATCH',
            participants: cluster.map(s => ({
              userId: s.user_id,
              location: s.location,
              catchTime: s.catch_timestamp,
              ballType: s.ball_type,
              success: s.success
            })),
            centroid,
            timeWindow: {
              start: Math.min(...cluster.map(s => s.catch_timestamp)),
              end: Math.max(...cluster.map(s => s.catch_timestamp))
            },
            pokemonSpawnId
          };
        }
      }
    }

    return null;
  }

  // 批量检测最近N分钟的协同捕捉
  async batchDetectCoordinatedCatches(minutes = 30) {
    const startTime = Date.now() - minutes * 60 * 1000;
    const spawns = await this.getRecentPokemonSpawns(startTime);
    const detected = [];

    for (const spawn of spawns) {
      const result = await this.detectCoordinatedCatch(spawn.id);
      if (result) {
        detected.push(result);
        // 触发事件
        await this.publishCollabCheatEvent(result);
      }
    }

    return detected;
  }
}
```

### 4.3 协同道馆战检测

```javascript
class GymCollabDetector {
  // 检测道馆战的协同作弊
  async detectGymCollab(gymId) {
    // 1. 获取道馆最近N小时的战斗记录
    const battles = await this.getGymBattles(gymId, 24);
    
    // 2. 检测时间窗口操纵
    const patterns = [];
    
    // 模式1：快速轮换占领
    const ownershipChanges = await this.getOwnershipChanges(gymId, 24);
    const rapidTurnover = this.detectRapidTurnover(ownershipChanges);
    if (rapidTurnover) patterns.push(rapidTurnover);

    // 模式2：协同攻击同一时间窗口
    const attackClusters = this.clusterAttacksByTime(battles);
    for (const cluster of attackClusters) {
      if (cluster.length >= 3) {
        const participants = [...new Set(cluster.map(b => b.attacker_id))];
        if (participants.length >= 3) {
          patterns.push({
            type: 'COORDINATED_ATTACK',
            participants,
            gymId,
            attackCount: cluster.length,
            timeWindow: {
              start: Math.min(...cluster.map(b => b.start_time)),
              end: Math.max(...cluster.map(b => b.end_time))
            }
          });
        }
      }
    }

    // 模式3：守护时间异常短
    const shortDefenses = this.detectShortDefenses(ownershipChanges);
    if (shortDefenses.length > 0) patterns.push(...shortDefenses);

    return patterns.length > 0 ? patterns : null;
  }
}
```

### 4.4 虚假交易链检测

```javascript
class FakeTradeDetector {
  // 检测闭环交易链
  async detectClosedLoopTrade(userId, depth = 5) {
    // 1. 构建交易图
    const trades = await this.getUserTradeHistory(userId, 30); // 30天
    const graph = new Map();

    for (const trade of trades) {
      const key1 = `${trade.sender_id}:${trade.receiver_id}`;
      const key2 = `${trade.receiver_id}:${trade.sender_id}`;
      graph.set(key1, (graph.get(key1) || 0) + 1);
      graph.set(key2, (graph.get(key2) || 0) + 1);
    }

    // 2. 检测闭环
    const loops = this.findAllLoops(userId, graph, depth);
    
    // 3. 计算闭环可疑度
    const suspiciousLoops = [];
    for (const loop of loops) {
      // 检查交易价值是否平衡（闭环交易的典型特征）
      const values = await this.getLoopTradeValues(loop);
      const variance = this.calculateValueVariance(values);
      
      if (variance < 0.1) { // 价值差异小于10%
        suspiciousLoops.push({
          loop,
          trades: loop.length,
          totalValue: values.reduce((s, v) => s + v, 0),
          variance,
          risk: 'high'
        });
      }
    }

    return suspiciousLoops.length > 0 ? suspiciousLoops : null;
  }
}
```

### 4.5 团伙处置引擎

```javascript
class GangActionEngine {
  constructor() {
    this.actionThresholds = {
      low: { minScore: 0, action: 'monitor' },
      medium: { minScore: 40, action: 'restrict' },
      high: { minScore: 70, action: 'restrict_hard' },
      critical: { minScore: 85, action: 'ban' }
    };
  }

  // 执行处置决策
  async executeAction(gang, action) {
    const results = [];

    switch (action) {
      case 'monitor':
        // 仅记录，不干预
        await this.logGangActivity(gang);
        break;

      case 'restrict':
        // 轻度限制：禁止小号交易、限制捕捉数量
        for (const member of gang.members) {
          await this.applyRestrictions(member, [
            'no_trading_with_new_accounts',
            'limited_catch_quota',
            'no_gym_battle_rewards'
          ]);
          results.push({ userId: member.user_id, action: 'restricted' });
        }
        break;

      case 'restrict_hard':
        // 中度限制：禁止交易、禁止道馆战、限制精灵转移
        for (const member of gang.members) {
          await this.applyRestrictions(member, [
            'no_trading',
            'no_gym_battles',
            'no_pokemon_transfer',
            'limited_catch_quota'
          ]);
          results.push({ userId: member.user_id, action: 'restricted_hard' });
        }
        break;

      case 'ban':
        // 封禁：永久封禁核心成员，临时封禁外围成员
        for (const member of gang.members) {
          if (member.role === 'leader' || member.role === 'core') {
            await this.banUser(member.user_id, { reason: 'GANG_CHEATING', duration: 'permanent' });
            results.push({ userId: member.user_id, action: 'banned_permanent' });
          } else {
            await this.banUser(member.user_id, { reason: 'GANG_ASSOCIATION', duration: '30d' });
            results.push({ userId: member.user_id, action: 'banned_temporary' });
          }
        }
        break;
    }

    // 记录处置结果
    await this.logGangAction(gang.gang_id, action, results);

    return results;
  }
}
```

### 4.6 API 端点设计

```
POST /api/v1/gang/analyze
  - 功能：分析用户是否属于作弊团伙
  - 请求体：{ userId }
  - 响应：{ gangId, role, riskScore, evidence }

GET /api/v1/gang/:gangId
  - 功能：获取团伙详情
  - 响应：{ members, events, riskLevel, evidenceChain }

GET /api/v1/gang/:gangId/members
  - 功能：获取团伙成员列表
  - 响应：{ members: [{ userId, role, joinScore, violations }] }

GET /api/v1/gang/:gangId/events
  - 功能：获取团伙作弊事件
  - 响应：{ events: [{ type, participants, evidence, action }] }

POST /api/v1/gang/:gangId/action
  - 功能：对团伙执行处置（需 admin 权限）
  - 请求体：{ action: 'monitor'|'restrict'|'ban', reason }
  - 响应：{ results: [{ userId, action }] }

GET /api/v1/gang/stats
  - 功能：获取团伙统计数据（需 admin 权限）
  - 响应：{ totalGangs, byRiskLevel, topGangs }
```

### 4.7 Prometheus 指标

```javascript
const metrics = {
  // 检测到的团伙总数
  gangsDetectedTotal: new promClient.Counter({
    name: 'minego_gangs_detected_total',
    help: 'Total gangs detected',
    labelNames: ['risk_level']
  }),

  // 协同作弊事件
  collabCheatEventsTotal: new promClient.Counter({
    name: 'minego_collab_cheat_events_total',
    help: 'Collaborative cheat events detected',
    labelNames: ['event_type', 'action']
  }),

  // 团伙成员数
  gangMembersTotal: new promClient.Gauge({
    name: 'minego_gang_members_total',
    help: 'Total gang members by risk level',
    labelNames: ['risk_level']
  }),

  // 处置次数
  gangActionsTotal: new promClient.Counter({
    name: 'minego_gang_actions_total',
    help: 'Gang actions executed',
    labelNames: ['action_type']
  }),

  // 检测耗时
  gangDetectionLatency: new promClient.Histogram({
    name: 'minego_gang_detection_latency_seconds',
    help: 'Gang detection latency',
    buckets: [0.1, 0.5, 1, 2, 5, 10]
  })
};
```

## 5. 验收标准（可测试）

- [ ] 团伙关系图谱构建完成，支持时空共现、交易关系、好友关系三种边类型
- [ ] 协同捕捉检测模块实现，能检测同一时间同一地点3人以上协同捕捉
- [ ] 协同道馆战检测模块实现，能检测快速轮换占领、协同攻击等模式
- [ ] 虚假交易链检测模块实现，能识别闭环交易和价值异常交易
- [ ] 团伙风险评分算法实现，输出0-100分，包含规模、密度、行为频率等维度
- [ ] 处置引擎实现，支持4级处置策略（监控/轻度限制/重度限制/封禁）
- [ ] 6个API端点实现，返回格式符合规范
- [ ] 数据库迁移文件创建，包含4个表
- [ ] 单元测试覆盖率 ≥ 75%，包含至少25个测试用例
- [ ] Prometheus指标集成，5个指标正常上报
- [ ] 协同作弊检测准确率 ≥ 85%，误判率 ≤ 0.1%

## 6. 工作量估算

**XL** - 预计 3-4 天

理由：
- 涉及复杂的图算法（谱聚类、团发现）
- 需要处理大量实时数据分析
- 需要与现有多个反作弊系统集成
- 处置策略需要精细设计，避免误伤

## 7. 优先级理由

**P0** - 最高优先级

理由：
1. **作弊手段升级**：团伙作弊是当前最主要的作弊方式，单账号检测已无法应对
2. **经济系统影响大**：团伙作弊涉及大量资源非法获取，严重破坏游戏经济
3. **用户公平性**：团伙作弊对正常玩家影响最大，直接破坏游戏体验
4. **技术可行性强**：基于现有反作弊基础设施，可快速实现
5. **威慑效应明显**：团伙封禁可形成强烈震慑，降低整体作弊率
