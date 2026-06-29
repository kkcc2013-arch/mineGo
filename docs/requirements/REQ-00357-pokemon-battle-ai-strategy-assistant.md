# REQ-00357: 精灵团队战斗AI策略助手系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00357 |
| 标题 | 精灵团队战斗AI策略助手系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gym-service、pokemon-service、user-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 07:00 UTC |

## 需求描述

### 背景
精灵对战系统（PVP和道馆战斗）已实现基础功能，但玩家缺乏获取战术建议的渠道。新手玩家不熟悉属性克制、技能搭配、出场顺序等策略，导致战斗体验不佳；资深玩家也希望获得数据驱动的优化建议。

### 目标
构建精灵团队战斗AI策略助手系统，为玩家提供：
1. **实时战术建议**：基于当前战况，推荐最佳技能使用、切换时机、防御策略
2. **赛前阵容优化**：分析玩家精灵库，推荐最优出战阵容和出场顺序
3. **对手分析**：预测对手可能的精灵配置和战术倾向
4. **战后复盘**：分析战斗数据，提供改进建议
5. **训练模式**：AI陪练功能，帮助玩家提升战斗技巧

## 技术方案

### 1. 数据层设计

#### 1.1 战斗数据采集表
```sql
-- 战斗记录表（扩展）
CREATE TABLE battle_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID REFERENCES battles(id),
    user_id UUID REFERENCES users(id),
    pokemon_id UUID REFERENCES pokemons(id),
    -- 战斗统计
    damage_dealt INT DEFAULT 0,
    damage_received INT DEFAULT 0,
    skills_used JSONB DEFAULT '[]',
    effectiveness_scores JSONB DEFAULT '{}',
    survival_turns INT DEFAULT 0,
    knockout_count INT DEFAULT 0,
    -- AI评估
    ai_prediction_accuracy DECIMAL(3,2),
    strategy_score DECIMAL(3,2),
    -- 时间戳
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI策略模型表
CREATE TABLE ai_strategy_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_type VARCHAR(50) NOT NULL, -- 'battle_prediction', 'lineup_optimizer', 'skill_recommender'
    version VARCHAR(20) NOT NULL,
    model_data JSONB NOT NULL,
    accuracy_metrics JSONB DEFAULT '{}',
    training_data_size INT DEFAULT 0,
    is_active BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户策略偏好表
CREATE TABLE user_strategy_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) UNIQUE,
    preferred_playstyle VARCHAR(50) DEFAULT 'balanced', -- 'aggressive', 'defensive', 'balanced'
    risk_tolerance VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high'
    favorite_pokemon_types JSONB DEFAULT '[]',
    learning_goals JSONB DEFAULT '[]',
    ai_assistance_level VARCHAR(20) DEFAULT 'full', -- 'minimal', 'moderate', 'full'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 战斗复盘分析表
CREATE TABLE battle_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID REFERENCES battles(id),
    user_id UUID REFERENCES users(id),
    -- 关键决策点分析
    critical_moments JSONB DEFAULT '[]',
    -- 改进建议
    improvement_suggestions JSONB DEFAULT '[]',
    -- 表现评分
    overall_rating DECIMAL(3,2),
    skill_usage_score DECIMAL(3,2),
    timing_score DECIMAL(3,2),
    team_composition_score DECIMAL(3,2),
    -- AI生成内容
    ai_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 2. AI策略引擎

#### 2.1 战斗预测服务
```javascript
// backend/gym-service/src/ai/BattlePredictor.js
class BattlePredictor {
    constructor() {
        this.typeChart = this.loadTypeChart();
        this.skillDatabase = this.loadSkillDatabase();
    }

    /**
     * 预测战斗结果概率
     * @param {Object} attacker - 攻击方精灵数据
     * @param {Object} defender - 防守方精灵数据
     * @param {Object} battleContext - 战斗上下文（天气、场地等）
     * @returns {Object} 预测结果
     */
    predictBattleOutcome(attacker, defender, battleContext = {}) {
        const predictions = {
            winProbability: 0,
            estimatedTurns: 0,
            recommendedSkills: [],
            riskFactors: [],
            counterStrategy: null
        };

        // 1. 计算属性克制优势
        const typeAdvantage = this.calculateTypeAdvantage(
            attacker.types,
            defender.types
        );

        // 2. 计算技能效果预测
        const skillPredictions = this.predictSkillOutcomes(
            attacker.skills,
            defender,
            battleContext
        );

        // 3. 计算速度优势和回合控制
        const speedAdvantage = this.calculateSpeedAdvantage(
            attacker.stats.speed,
            defender.stats.speed
        );

        // 4. 综合计算胜率
        predictions.winProbability = this.calculateWinProbability({
            typeAdvantage,
            skillPredictions,
            speedAdvantage,
            attackerHP: attacker.currentHP / attacker.stats.hp,
            defenderHP: defender.currentHP / defender.stats.hp
        });

        // 5. 推荐最佳技能
        predictions.recommendedSkills = this.recommendBestSkills(
            skillPredictions,
            predictions.winProbability
        );

        return predictions;
    }

    /**
     * 实时战术建议生成
     */
    generateRealTimeAdvice(battleState) {
        const advice = {
            action: 'attack', // 'attack', 'switch', 'defend', 'item'
            confidence: 0,
            reasoning: [],
            alternatives: []
        };

        const currentPokemon = battleState.myPokemon;
        const opponentPokemon = battleState.opponentPokemon;

        // 分析当前局势
        const situation = this.analyzeSituation(battleState);

        // 生成最佳行动建议
        if (situation.urgency === 'critical') {
            // 紧急情况：推荐切换或使用道具
            if (this.hasViableSwitch(battleState)) {
                advice.action = 'switch';
                advice.reasoning.push('当前精灵处于劣势，建议切换');
            } else {
                advice.action = 'item';
                advice.reasoning.push('建议使用回复道具');
            }
        } else {
            // 正常情况：推荐最佳攻击技能
            const bestSkill = this.findBestSkill(currentPokemon, opponentPokemon);
            advice.action = 'attack';
            advice.recommendedSkill = bestSkill;
            advice.reasoning.push(`推荐使用${bestSkill.name}，预期伤害${bestSkill.expectedDamage}`);
        }

        advice.confidence = this.calculateAdviceConfidence(situation);

        return advice;
    }
}

module.exports = BattlePredictor;
```

#### 2.2 阵容优化服务
```javascript
// backend/gym-service/src/ai/LineupOptimizer.js
class LineupOptimizer {
    /**
     * 优化出战阵容
     * @param {Array} availablePokemon - 可用精灵列表
     * @param {Object} opponentInfo - 对手信息（已知精灵、历史数据）
     * @param {Object} constraints - 约束条件（最大数量、禁用精灵等）
     * @returns {Object} 优化后的阵容建议
     */
    optimizeLineup(availablePokemon, opponentInfo = {}, constraints = {}) {
        const result = {
            recommendedLineup: [],
            order: [],
            alternatives: [],
            reasoning: '',
            expectedWinRate: 0
        };

        // 1. 评估每个精灵的综合战力
        const pokemonScores = availablePokemon.map(p => ({
            pokemon: p,
            score: this.evaluatePokemon(p, opponentInfo)
        }));

        // 2. 考虑团队协同效应
        const teamCombinations = this.generateTeamCombinations(
            pokemonScores,
            constraints.maxSize || 6
        );

        // 3. 选择最优阵容
        const optimalTeam = this.selectOptimalTeam(
            teamCombinations,
            opponentInfo
        );

        result.recommendedLineup = optimalTeam.members;
        result.order = this.optimizeOrder(optimalTeam.members, opponentInfo);
        result.expectedWinRate = optimalTeam.winProbability;
        result.reasoning = this.generateLineupReasoning(optimalTeam);

        return result;
    }

    /**
     * 评估单个精灵的战斗价值
     */
    evaluatePokemon(pokemon, opponentInfo) {
        let score = 0;

        // 基础属性权重
        const statWeights = {
            attack: 0.25,
            defense: 0.15,
            hp: 0.20,
            speed: 0.25,
            specialAttack: 0.10,
            specialDefense: 0.05
        };

        // 计算属性得分
        for (const [stat, weight] of Object.entries(statWeights)) {
            score += pokemon.stats[stat] * weight;
        }

        // 技能多样性加成
        const skillDiversity = this.calculateSkillDiversity(pokemon.skills);
        score *= (1 + skillDiversity * 0.2);

        // 属性克制加成（针对对手已知精灵）
        if (opponentInfo.knownPokemon) {
            const matchupBonus = this.calculateMatchupBonus(
                pokemon,
                opponentInfo.knownPokemon
            );
            score *= (1 + matchupBonus * 0.3);
        }

        return score;
    }
}

module.exports = LineupOptimizer;
```

### 3. API接口设计

#### 3.1 实时战术建议接口
```javascript
// backend/gym-service/src/routes/aiRoutes.js
router.post('/battle/:battleId/advice', authenticate, async (req, res) => {
    try {
        const { battleId } = req.params;
        const userId = req.user.id;

        // 获取当前战斗状态
        const battleState = await battleService.getBattleState(battleId, userId);

        // 验证玩家参与权限
        if (!battleState.isParticipant) {
            return res.status(403).json({ error: 'NOT_PARTICIPANT' });
        }

        // 检查AI助手使用配额
        const quota = await checkAIQuota(userId);
        if (!quota.allowed) {
            return res.status(429).json({
                error: 'QUOTA_EXCEEDED',
                resetAt: quota.resetAt
            });
        }

        // 生成战术建议
        const advice = await aiStrategyService.generateRealTimeAdvice(battleState);

        // 记录AI使用
        await recordAIUsage(userId, 'battle_advice', battleId);

        res.json({
            success: true,
            advice: {
                action: advice.action,
                confidence: advice.confidence,
                reasoning: advice.reasoning,
                recommendedSkill: advice.recommendedSkill,
                alternatives: advice.alternatives,
                generatedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        logger.error('AI advice generation failed', { error: error.message });
        res.status(500).json({ error: 'AI_ADVICE_FAILED' });
    }
});

// 阵容优化接口
router.post('/lineup/optimize', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const { battleType, opponentId, constraints } = req.body;

        // 获取用户可用精灵
        const availablePokemon = await pokemonService.getUserPokemon(userId, {
            includeStats: true,
            includeSkills: true
        });

        // 获取对手信息（如果有）
        const opponentInfo = opponentId ?
            await getUserBattleHistory(opponentId) : null;

        // 执行阵容优化
        const optimization = await aiStrategyService.optimizeLineup(
            availablePokemon,
            opponentInfo,
            constraints
        );

        res.json({
            success: true,
            optimization
        });
    } catch (error) {
        logger.error('Lineup optimization failed', { error: error.message });
        res.status(500).json({ error: 'OPTIMIZATION_FAILED' });
    }
});

// 战后复盘接口
router.post('/battle/:battleId/review', authenticate, async (req, res) => {
    try {
        const { battleId } = req.params;
        const userId = req.user.id;

        // 验证战斗归属
        const battle = await battleService.getBattleById(battleId);
        if (battle.userId !== userId) {
            return res.status(403).json({ error: 'NOT_OWNER' });
        }

        // 生成战斗复盘
        const review = await aiStrategyService.generateBattleReview(battleId);

        res.json({
            success: true,
            review
        });
    } catch (error) {
        logger.error('Battle review generation failed', { error: error.message });
        res.status(500).json({ error: 'REVIEW_FAILED' });
    }
});
```

### 4. 前端集成

#### 4.1 战术建议UI组件
```javascript
// frontend/game-client/src/components/BattleAIAdvisor.jsx
import React, { useState, useEffect } from 'react';
import { useBattle } from '../hooks/useBattle';

export function BattleAIAdvisor({ battleId }) {
    const [advice, setAdvice] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showReasoning, setShowReasoning] = useState(false);
    const { battleState, executeAction } = useBattle();

    const requestAdvice = async () => {
        setLoading(true);
        try {
            const response = await fetch(`/api/gym/battle/${battleId}/advice`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${getAuthToken()}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            if (data.success) {
                setAdvice(data.advice);
            }
        } catch (error) {
            console.error('Failed to get AI advice', error);
        } finally {
            setLoading(false);
        }
    };

    const executeRecommendedAction = () => {
        if (!advice) return;

        if (advice.action === 'attack' && advice.recommendedSkill) {
            executeAction('useSkill', { skillId: advice.recommendedSkill.id });
        } else if (advice.action === 'switch') {
            // 显示精灵选择界面
            showPokemonSwitchModal();
        }
    };

    return (
        <div className="ai-advisor">
            <div className="advisor-header">
                <span className="advisor-icon">🤖</span>
                <span>AI 战术助手</span>
                <button
                    className="request-advice-btn"
                    onClick={requestAdvice}
                    disabled={loading}
                >
                    {loading ? '分析中...' : '获取建议'}
                </button>
            </div>

            {advice && (
                <div className="advice-content">
                    <div className="action-recommendation">
                        <span className="action-type">
                            {getActionLabel(advice.action)}
                        </span>
                        <span className="confidence-bar">
                            <div
                                className="confidence-fill"
                                style={{ width: `${advice.confidence * 100}%` }}
                            />
                        </span>
                        <span className="confidence-value">
                            {Math.round(advice.confidence * 100)}% 信心
                        </span>
                    </div>

                    {advice.recommendedSkill && (
                        <div className="skill-recommendation">
                            <span className="skill-name">
                                {advice.recommendedSkill.name}
                            </span>
                            <span className="expected-damage">
                                预期伤害: {advice.recommendedSkill.expectedDamage}
                            </span>
                        </div>
                    )}

                    <button
                        className="show-reasoning-btn"
                        onClick={() => setShowReasoning(!showReasoning)}
                    >
                        {showReasoning ? '隐藏' : '查看'}分析理由
                    </button>

                    {showReasoning && (
                        <ul className="reasoning-list">
                            {advice.reasoning.map((reason, idx) => (
                                <li key={idx}>{reason}</li>
                            ))}
                        </ul>
                    )}

                    <button
                        className="execute-btn"
                        onClick={executeRecommendedAction}
                    >
                        执行建议
                    </button>
                </div>
            )}
        </div>
    );
}
```

### 5. AI模型训练管道

```javascript
// backend/gym-service/src/ai/ModelTrainer.js
class ModelTrainer {
    /**
     * 使用历史战斗数据训练策略模型
     */
    async trainBattlePredictionModel(trainingData) {
        const model = {
            typeCoefficients: {},
            skillWeights: {},
            speedFactors: {},
            situationalModifiers: {}
        };

        // 1. 分析属性克制模式
        const typeMatchups = this.analyzeTypeMatchups(trainingData);
        model.typeCoefficients = this.optimizeTypeCoefficients(typeMatchups);

        // 2. 技能效果权重学习
        const skillOutcomes = this.analyzeSkillOutcomes(trainingData);
        model.skillWeights = this.optimizeSkillWeights(skillOutcomes);

        // 3. 速度决策因子
        const speedDecisions = this.analyzeSpeedDecisions(trainingData);
        model.speedFactors = this.optimizeSpeedFactors(speedDecisions);

        // 4. 局势修正因子
        const situationalFactors = this.analyzeSituationalFactors(trainingData);
        model.situationalModifiers = this.optimizeSituationalModifiers(situationalFactors);

        // 5. 验证模型准确性
        const accuracy = await this.validateModel(model, trainingData.validationSet);

        return { model, accuracy };
    }

    /**
     * 定期模型更新（增量学习）
     */
    async incrementalUpdate(existingModel, newBattles) {
        // 合并新数据，重新优化参数
        const updatedModel = { ...existingModel };

        for (const battle of newBattles) {
            const insights = this.extractInsights(battle);
            this.applyModelUpdates(updatedModel, insights);
        }

        return updatedModel;
    }
}

module.exports = ModelTrainer;
```

## 验收标准

- [ ] 实时战术建议API响应时间 < 500ms（P95）
- [ ] AI建议准确率 > 70%（胜率预测偏差 < 10%）
- [ ] 阵容优化建议在3秒内完成
- [ ] 战后复盘分析覆盖率 100%（所有已结束战斗）
- [ ] 用户AI助手满意度 > 80%（问卷调查）
- [ ] 每日AI建议请求配额限制功能正常
- [ ] AI模型支持A/B测试与灰度发布
- [ ] 战斗数据分析仪表板（运营后台）

## 影响范围

- backend/gym-service/src/ai/（新增AI策略引擎）
- backend/gym-service/src/routes/aiRoutes.js（新增AI接口）
- backend/gym-service/src/services/aiStrategyService.js（新增服务层）
- backend/pokemon-service（精灵数据查询扩展）
- backend/user-service（用户策略偏好管理）
- backend/shared/aiCore/（共享AI组件）
- frontend/game-client/src/components/BattleAIAdvisor.jsx（UI组件）
- frontend/game-client/src/components/LineupOptimizer.jsx（阵容优化界面）
- frontend/game-client/src/components/BattleReview.jsx（复盘界面）
- database/migrations/（新增表结构）
- docs/api-spec/openapi.yaml（API文档更新）

## 参考

- Pokemon Showdown 战斗计算器：https://calc.pokemonshowdown.com/
- Pokemon Battle AI研究论文
- WCAG 2.1 无障碍指南
- OpenAI Gym 强化学习框架
