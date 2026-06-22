# REQ-00279：反作弊行为模式机器学习检测系统

- **编号**：REQ-00279
- **类别**：反作弊
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、catch-service、gym-service、location-service、ml-service（新增）
- **创建时间**：2026-06-22 03:15
- **依赖需求**：REQ-00010（GPS 伪造检测）、REQ-00028（行为异常检测）

## 1. 背景与问题

当前反作弊系统（REQ-00010、REQ-00028）基于规则引擎实现，存在以下局限：

1. **规则僵化**：基于固定阈值（如速度限制、捕捉频率），作弊者可通过"打擦边球"绕过
2. **误报率**：正常用户可能因网络波动、GPS 漂移被误判
3. **新型作弊**：模拟器、自动化脚本、AI 代玩等新型作弊手段难以通过规则检测
4. **无学习能力**：系统无法从历史作弊案例中自动学习新特征

代码现状：
- `backend/shared/anti-cheat.js` 实现了基础速度检测和行为频率检查
- `backend/shared/behaviorAnalyzer.js` 实现了简单的行为模式分析
- 缺少机器学习模型，无法识别复杂作弊模式

## 2. 目标

构建基于机器学习的智能反作弊系统，实现：

1. **异常行为检测**：使用 Isolation Forest 算法检测异常捕捉、移动、战斗模式
2. **作弊分类器**：使用 XGBoost 分类器区分作弊类型（GPS 伪造、自动化脚本、模拟器）
3. **实时推理**：通过 ONNX Runtime 提供低延迟（<10ms）的实时检测
4. **模型训练管道**：定期使用历史数据重新训练模型，持续优化检测能力
5. **可解释性**：提供作弊判定原因，支持人工审核

预期收益：
- 检测准确率提升至 95%+（当前规则引擎约 80%）
- 误报率降低至 <3%（当前约 8%）
- 支持 10+ 种作弊模式识别
- 自动适应新型作弊手段

## 3. 范围

- **包含**：
  - 特征工程：用户行为特征提取与标准化
  - 模型训练：Isolation Forest、XGBoost 模型训练脚本
  - 模型服务：ONNX Runtime 推理服务
  - 实时检测 API：集成到现有反作弊中间件
  - 训练数据管道：历史数据提取、标注、特征工程
  - 模型版本管理：MLflow 模型注册与版本控制
  - Prometheus 指标：模型预测分布、检测准确率

- **不包含**：
  - 图像识别（截图检测）
  - 深度学习模型（Transformer、RNN）
  - 第三方反作弊服务（如腾讯游戏安全）
  - 客户端反作弊（需原生代码集成）

## 4. 详细需求

### 4.1 特征工程

```javascript
// 用户行为特征向量（30+ 维度）
const USER_BEHAVIOR_FEATURES = {
  // 位置相关（8 维）
  location: {
    avgSpeed7d: '过去 7 天平均移动速度',
    maxSpeed24h: '过去 24 小时最大速度',
    locationVariance: '位置方差',
    uniqueLocationsCount: '独立位置数量',
    teleportEventsCount: '瞬移事件次数',
    distanceTotal: '总移动距离',
    straightLineRatio: '直线移动比例',
    accuracyAvg: 'GPS 精度平均值'
  },
  
  // 捕捉相关（8 维）
  catch: {
    successRate: '捕捉成功率',
    avgCatchTime: '平均捕捉耗时',
    rarePokemonRatio: '稀有精灵捕捉比例',
    catchCountPerHour: '每小时捕捉数',
    perfectThrowRatio: '完美投掷比例',
    curveBallRatio: '弧线球比例',
    berryUsageRate: '浆果使用率',
    fleeRate: '精灵逃跑率'
  },
  
  // 战斗相关（6 维）
  battle: {
    winRate: '胜率',
    avgBattleDuration: '平均战斗时长',
    damageEfficiency: '伤害效率',
    dodgeSuccessRate: '闪避成功率',
    typeAdvantageUsage: '属性克制使用率',
  gymAttackFrequency: '道馆攻击频率'
  },
  
  // 时间相关（5 维）
  temporal: {
    activeHoursPerDay: '每日活跃小时数',
    sessionDurationAvg: '平均会话时长',
    actionRegularity: '行为规律性（标准差）',
    nightActivityRatio: '夜间活动比例',
    weekendActivityRatio: '周末活动比例'
  },
  
  // 设备相关（3 维）
  device: {
    deviceChangeCount: '设备变更次数',
    emulatorScore: '模拟器检测分数',
    rootDetection: '越狱/root 检测'
  }
};
```

### 4.2 模型设计

#### 4.2.1 异常检测模型（Isolation Forest）

```python
# 训练脚本：ml-service/train_anomaly_detector.py
from sklearn.ensemble import IsolationForest
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

# 模型参数
model = IsolationForest(
    n_estimators=100,
    contamination=0.05,  # 预期作弊比例 5%
    max_samples=256,
    random_state=42
)

# 训练
model.fit(X_train)

# 转换为 ONNX
initial_type = [('float_input', FloatTensorType([None, 30]))]
onnx_model = convert_sklearn(model, initial_types=initial_type)

# 保存
with open('models/anomaly_detector.onnx', 'wb') as f:
    f.write(onnx_model.SerializeToString())
```

#### 4.2.2 作弊分类模型（XGBoost）

```python
# 训练脚本：ml-service/train_cheat_classifier.py
import xgboost as xgb
from onnxmltools import convert_xgboost

# 作弊类型标签
CHEAT_TYPES = {
  0: 'NORMAL',
  1: 'GPS_FAKE',
  2: 'AUTO_SCRIPT',
  3: 'EMULATOR',
  4: 'ACCOUNT_SHARING',
  5: 'SPEED_HACK'
}

# 模型参数
model = xgb.XGBClassifier(
    max_depth=6,
    n_estimators=200,
    learning_rate=0.1,
    objective='multi:softprob',
    num_class=6
)

# 训练
model.fit(X_train, y_train)

# 转换为 ONNX
onnx_model = convert_xgboost(model, initial_types=[('input', FloatTensorType([None, 30]))])

# 保存
with open('models/cheat_classifier.onnx', 'wb') as f:
    f.write(onnx_model.SerializeToString())
```

### 4.3 推理服务

```javascript
// backend/shared/mlInferenceService.js
const ort = require('onnxruntime-node');

class MLInferenceService {
  constructor() {
    this.anomalySession = null;
    this.classifierSession = null;
    this.initialized = false;
  }

  async initialize() {
    // 加载 ONNX 模型
    this.anomalySession = await ort.InferenceSession.create('models/anomaly_detector.onnx');
    this.classifierSession = await ort.InferenceSession.create('models/cheat_classifier.onnx');
    this.initialized = true;
  }

  /**
   * 异常检测
   * @param {number[]} features - 用户行为特征向量
   * @returns {Promise<{isAnomaly: boolean, score: number}>}
   */
  async detectAnomaly(features) {
    if (!this.initialized) await this.initialize();

    const input = new ort.Tensor('float32', features, [1, features.length]);
    const results = await this.anomalySession.run({ input: input });
    const score = results.output.data[0];

    // Isolation Forest: score < 0 为异常
    return {
      isAnomaly: score < 0,
      score: score
    };
  }

  /**
   * 作弊分类
   * @param {number[]} features - 用户行为特征向量
   * @returns {Promise<{type: string, confidence: number, probabilities: number[]}>}
   */
  async classifyCheat(features) {
    if (!this.initialized) await this.initialize();

    const input = new ort.Tensor('float32', features, [1, features.length]);
    const results = await this.classifierSession.run({ input: input });
    const probabilities = Array.from(results.output.data);

    const maxIndex = probabilities.indexOf(Math.max(...probabilities));
    const cheatTypes = ['NORMAL', 'GPS_FAKE', 'AUTO_SCRIPT', 'EMULATOR', 'ACCOUNT_SHARING', 'SPEED_HACK'];

    return {
      type: cheatTypes[maxIndex],
      confidence: probabilities[maxIndex],
      probabilities: probabilities
    };
  }
}

module.exports = new MLInferenceService();
```

### 4.4 特征提取服务

```javascript
// backend/shared/featureExtractor.js
class FeatureExtractor {
  /**
   * 提取用户行为特征
   * @param {string} userId - 用户ID
   * @returns {Promise<number[]>} 特征向量
   */
  async extractFeatures(userId) {
    const [
      locationFeatures,
      catchFeatures,
      battleFeatures,
      temporalFeatures,
      deviceFeatures
    ] = await Promise.all([
      this.extractLocationFeatures(userId),
      this.extractCatchFeatures(userId),
      this.extractBattleFeatures(userId),
      this.extractTemporalFeatures(userId),
      this.extractDeviceFeatures(userId)
    ]);

    return [
      ...Object.values(locationFeatures),
      ...Object.values(catchFeatures),
      ...Object.values(battleFeatures),
      ...Object.values(temporalFeatures),
      ...Object.values(deviceFeatures)
    ];
  }

  async extractLocationFeatures(userId) {
    // 从 Redis 和数据库聚合位置特征
    const redis = getRedis();
    const history = await getJSON(`anticheat:location:${userId}`) || [];
    
    // 计算统计特征
    return {
      avgSpeed7d: this.calculateAvgSpeed(history),
      maxSpeed24h: this.calculateMaxSpeed(history, 24 * 60 * 60 * 1000),
      locationVariance: this.calculateVariance(history),
      // ... 其他特征
    };
  }

  // ... 其他特征提取方法
}
```

### 4.5 集成到反作弊中间件

```javascript
// backend/shared/anti-cheat.js 新增方法
const mlInferenceService = require('./mlInferenceService');
const featureExtractor = require('./featureExtractor');

/**
 * 机器学习增强的作弊检测
 */
async function detectCheatWithML(userId) {
  try {
    // 提取特征
    const features = await featureExtractor.extractFeatures(userId);

    // 并行执行异常检测和分类
    const [anomalyResult, classifyResult] = await Promise.all([
      mlInferenceService.detectAnomaly(features),
      mlInferenceService.classifyCheat(features)
    ]);

    // 结合规则引擎和 ML 结果
    const isCheat = anomalyResult.isAnomaly || classifyResult.type !== 'NORMAL';
    const cheatType = classifyResult.type;
    const confidence = classifyResult.confidence;

    // 记录检测结果
    await logMLDetection(userId, anomalyResult, classifyResult);

    // 更新 Prometheus 指标
    metrics.mlDetectionsTotal?.inc({ 
      type: cheatType, 
      isCheat: isCheat.toString() 
    });

    return {
      isCheat,
      cheatType,
      confidence,
      anomalyScore: anomalyResult.score,
      features: features
    };
  } catch (error) {
    logger.error('ML cheat detection failed', { userId, error: error.message });
    // 降级：返回 null，使用规则引擎
    return null;
  }
}
```

### 4.6 数据库设计

```sql
-- ML 检测结果表
CREATE TABLE ml_cheat_detections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  is_cheat        BOOLEAN NOT NULL,
  cheat_type      VARCHAR(50),
  confidence      DECIMAL(5,4),
  anomaly_score   DECIMAL(10,6),
  features        JSONB,
  model_version   VARCHAR(50) NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_user_created (user_id, created_at DESC),
  INDEX idx_cheat_type (cheat_type)
);

-- 模型版本管理表
CREATE TABLE ml_model_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name      VARCHAR(100) NOT NULL,
  version         VARCHAR(50) NOT NULL,
  file_path       TEXT NOT NULL,
  metrics         JSONB,
  trained_at      TIMESTAMP NOT NULL,
  deployed_at     TIMESTAMP,
  is_active       BOOLEAN DEFAULT false,
  UNIQUE(model_name, version)
);

-- 特征快照表（用于模型训练）
CREATE TABLE user_feature_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  features        JSONB NOT NULL,
  is_cheat        BOOLEAN,
  cheat_type      VARCHAR(50),
  captured_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  INDEX idx_captured (captured_at DESC)
);
```

### 4.7 API 端点

```
POST /internal/anticheat/ml-detect
  - 实时 ML 作弊检测
  - 返回作弊类型、置信度

GET /internal/anticheat/features/:userId
  - 获取用户特征向量

POST /admin/anticheat/ml/retrain
  - 触发模型重新训练
  - 返回训练任务 ID

GET /admin/anticheat/ml/models
  - 查看模型版本列表

POST /admin/anticheat/ml/models/:version/deploy
  - 部署指定版本模型
```

### 4.8 训练管道

```yaml
# .github/workflows/ml-training.yml
name: ML Model Training

on:
  schedule:
    - cron: '0 2 * * 0'  # 每周日凌晨 2 点
  workflow_dispatch:

jobs:
  train:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
      
      - name: Install dependencies
        run: |
          pip install -r ml-service/requirements.txt
      
      - name: Extract training data
        run: |
          python ml-service/extract_training_data.py
      
      - name: Train models
        run: |
          python ml-service/train_anomaly_detector.py
          python ml-service/train_cheat_classifier.py
      
      - name: Evaluate models
        run: |
          python ml-service/evaluate_models.py
      
      - name: Register models to MLflow
        run: |
          python ml-service/register_models.py
      
      - name: Upload model artifacts
        uses: actions/upload-artifact@v3
        with:
          name: models
          path: models/
```

## 5. 验收标准（可测试）

- [ ] 特征提取：能正确提取 30+ 维用户行为特征，耗时 <500ms
- [ ] 异常检测：Isolation Forest 模型 AUC > 0.85
- [ ] 作弊分类：XGBoost 分类器准确率 > 90%，召回率 > 85%
- [ ] 实时推理：ONNX Runtime 推理延迟 <10ms（P99）
- [ ] 降级机制：ML 服务异常时自动降级到规则引擎，不影响正常请求
- [ ] 模型版本管理：支持模型版本切换，回滚时间 <1 分钟
- [ ] Prometheus 指标：ml_detections_total、ml_inference_latency_seconds 正确上报
- [ ] 可解释性：检测结果包含作弊类型、置信度、关键特征

## 6. 工作量估算

**XL（Extra Large）**

理由：
- 需要新建 ml-service 微服务
- 涉及机器学习模型训练、部署、监控全流程
- 需要构建训练数据管道
- 模型优化和调参需要大量实验
- 需要完整的测试覆盖
- 预计 5-7 天完成

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **安全升级**：规则引擎已到瓶颈，ML 是提升检测能力的必经之路
2. **作弊对抗**：新型作弊手段（AI 代玩、高级脚本）需要 ML 识别
3. **用户体验**：降低误报率，减少正常用户被误判
4. **技术储备**：ML 反作弊是行业标准，团队需要相关经验
5. **成熟度提升**：STATUS.md 安全维度需提升至 15/15
