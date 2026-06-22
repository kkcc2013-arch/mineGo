# REQ-00283: 精灵天赋系统与隐藏属性机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00283 |
| 标题 | 精灵天赋系统与隐藏属性机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service, battle-service, user-service |
| 创建时间 | 2026-06-22 06:00 |

## 需求描述

为精灵引入天赋系统与隐藏属性机制，每只精灵在出生时随机分配天赋值，影响其战斗能力、成长潜力、特殊技能触发概率等。该系统增加游戏深度和策略性，让每只精灵都具有独特价值，促进玩家之间的交流和交易需求。

### 核心功能
1. **天赋池系统**：定义 50+ 种天赋，分为攻击、防御、辅助、特殊四大类
2. **隐藏属性**：潜力值（IV）、遗传因子、隐性特性
3. **天赋觉醒**：通过特定道具或条件激活隐藏天赋
4. **天赋成长**：天赋等级随精灵成长而提升
5. **天赋组合效果**：多天赋组合产生额外加成或特殊效果
6. **天赋继承**：繁殖时有概率继承父母天赋

## 技术方案

### 1. 天赋数据模型

```go
// 天赋定义
type Talent struct {
    ID          string     `json:"id" db:"id"`
    Name        string     `json:"name" db:"name"`
    Category    TalentType `json:"category" db:"category"` // attack, defense, support, special
    Description string     `json:"description" db:"description"`
    
    // 效果定义
    Effects     []TalentEffect `json:"effects" db:"effects"`
    
    // 触发条件
    TriggerCondition *TalentTrigger `json:"trigger_condition" db:"trigger_condition"`
    
    // 稀有度 (1-5)
    Rarity      int        `json:"rarity" db:"rarity"`
    
    // 是否可遗传
    Inheritable bool       `json:"inheritable" db:"inheritable"`
    
    // 最大等级
    MaxLevel    int        `json:"max_level" db:"max_level"`
    
    CreatedAt   time.Time  `json:"created_at" db:"created_at"`
    UpdatedAt   time.Time  `json:"updated_at" db:"updated_at"`
}

type TalentType string

const (
    TalentTypeAttack  TalentType = "attack"
    TalentTypeDefense TalentType = "defense"
    TalentTypeSupport TalentType = "support"
    TalentTypeSpecial TalentType = "special"
)

type TalentEffect struct {
    Type        EffectType `json:"type"`
    Target      string     `json:"target"`      // self, enemy, ally, all
    Value       float64    `json:"value"`       // 基础值
    ScaleType   string     `json:"scale_type"`  // flat, percent
    Duration    int        `json:"duration"`    // 持续回合数，0表示永久
    Stackable   bool       `json:"stackable"`
    MaxStacks   int        `json:"max_stacks"`
}

type EffectType string

const (
    EffectTypeDamageBoost     EffectType = "damage_boost"
    EffectTypeDefenseBoost    EffectType = "defense_boost"
    EffectTypeSpeedBoost      EffectType = "speed_boost"
    EffectTypeCriticalChance  EffectType = "critical_chance"
    EffectTypeCriticalDamage  EffectType = "critical_damage"
    EffectTypeHealing         EffectType = "healing"
    EffectTypeDamageReduction EffectType = "damage_reduction"
    EffectTypeDodgeChance     EffectType = "dodge_chance"
    EffectTypeAccuracyBoost   EffectType = "accuracy_boost"
    EffectTypeSpecialTrigger  EffectType = "special_trigger"
)

type TalentTrigger struct {
    Type      TriggerType `json:"type"`
    Condition string      `json:"condition"` // 条件表达式
    Chance    float64     `json:"chance"`    // 触发概率
}

type TriggerType string

const (
    TriggerTypeOnBattleStart   TriggerType = "on_battle_start"
    TriggerTypeOnAttack        TriggerType = "on_attack"
    TriggerTypeOnHit           TriggerType = "on_hit"
    TriggerTypeOnCritical      TriggerType = "on_critical"
    TriggerTypeOnDefeat        TriggerType = "on_defeat"
    TriggerTypeOnLowHP         TriggerType = "on_low_hp"
    TriggerTypeOnWeatherChange TriggerType = "on_weather_change"
    TriggerTypeOnTurnEnd       TriggerType = "on_turn_end"
)

// 精灵天赋实例
type PokemonTalent struct {
    ID         string    `json:"id" db:"id"`
    PokemonID  string    `json:"pokemon_id" db:"pokemon_id"`
    TalentID   string    `json:"talent_id" db:"talent_id"`
    
    // 当前等级
    Level      int       `json:"level" db:"level"`
    
    // 是否已觉醒
    Awakened   bool      `json:"awakened" db:"awakened"`
    
    // 觉醒时间
    AwakenedAt *time.Time `json:"awakened_at" db:"awakened_at"`
    
    // 经验值
    Experience int       `json:"experience" db:"experience"`
    
    CreatedAt  time.Time `json:"created_at" db:"created_at"`
    UpdatedAt  time.Time `json:"updated_at" db:"updated_at"`
}
```

### 2. 隐藏属性系统

```go
// 隐藏属性 (Individual Values)
type HiddenAttributes struct {
    PokemonID string `json:"pokemon_id" db:"pokemon_id"`
    
    // 基础潜力值 (0-31)
    HPIV          int `json:"hp_iv" db:"hp_iv"`
    AttackIV      int `json:"attack_iv" db:"attack_iv"`
    DefenseIV     int `json:"defense_iv" db:"defense_iv"`
    SpAttackIV    int `json:"sp_attack_iv" db:"sp_attack_iv"`
    SpDefenseIV   int `json:"sp_defense_iv" db:"sp_defense_iv"`
    SpeedIV       int `json:"speed_iv" db:"speed_iv"`
    
    // 总潜力评分
    PotentialScore int `json:"potential_score" db:"potential_score"`
    
    // 隐藏特性
    HiddenAbility  string `json:"hidden_ability" db:"hidden_ability"`
    
    // 遗传因子
    GeneticFactors []GeneticFactor `json:"genetic_factors" db:"genetic_factors"`
    
    // 觉醒度 (0-100)
    AwakeningLevel int `json:"awakening_level" db:"awakening_level"`
    
    CreatedAt time.Time `json:"created_at" db:"created_at"`
    UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

type GeneticFactor struct {
    GeneID    string `json:"gene_id"`
    Name      string `json:"name"`
    Inherited bool   `json:"inherited"` // 是否从父母继承
    Active    bool   `json:"active"`    // 是否激活
}

// 潜力值计算服务
type PotentialService struct {
    db *sql.DB
}

func (s *PotentialService) CalculatePotential(iv HiddenAttributes) int {
    // 总潜力评分 = 各项IV加权平均
    total := iv.HPIV + iv.AttackIV + iv.DefenseIV + 
             iv.SpAttackIV + iv.SpDefenseIV + iv.SpeedIV
    return int(float64(total) / 186.0 * 100) // 最高186，转换为0-100评分
}

// 生成随机IV
func (s *PotentialService) GenerateRandomIVs(rarity int) HiddenAttributes {
    rand.Seed(time.Now().UnixNano())
    
    // 根据稀有度调整IV范围
    baseMin := 0
    baseMax := 31
    
    if rarity >= 4 {
        baseMin = 15 // 高稀有度精灵保底IV
    }
    if rarity == 5 {
        baseMin = 25 // 传说级精灵高保底
    }
    
    return HiddenAttributes{
        HPIV:        randInt(baseMin, baseMax),
        AttackIV:    randInt(baseMin, baseMax),
        DefenseIV:   randInt(baseMin, baseMax),
        SpAttackIV:  randInt(baseMin, baseMax),
        SpDefenseIV: randInt(baseMin, baseMax),
        SpeedIV:     randInt(baseMin, baseMax),
    }
}
```

### 3. 天赋服务实现

```go
// talent_service.go
type TalentService struct {
    db         *sql.DB
    cache      *redis.Client
    eventBus   *events.EventBus
    talentRepo TalentRepository
}

// 精灵生成时分配天赋
func (s *TalentService) AssignTalentsOnCapture(
    ctx context.Context, 
    pokemonID string, 
    speciesID string,
    rarity int,
) ([]PokemonTalent, error) {
    // 获取该物种可用的天赋池
    availableTalents, err := s.talentRepo.GetTalentsForSpecies(ctx, speciesID)
    if err != nil {
        return nil, err
    }
    
    // 根据稀有度确定天赋数量
    talentCount := s.calculateTalentCount(rarity)
    
    // 随机选择天赋
    selected := s.randomSelectTalents(availableTalents, talentCount)
    
    // 创建天赋实例
    var talents []PokemonTalent
    for _, t := range selected {
        pt := PokemonTalent{
            ID:        uuid.New().String(),
            PokemonID: pokemonID,
            TalentID:  t.ID,
            Level:     1,
            Awakened:  false,
            Experience: 0,
            CreatedAt: time.Now(),
        }
        
        if err := s.talentRepo.CreatePokemonTalent(ctx, pt); err != nil {
            return nil, err
        }
        talents = append(talents, pt)
    }
    
    // 发布事件
    s.eventBus.Publish(events.PokemonTalentsAssigned{
        PokemonID: pokemonID,
        Talents:   talents,
    })
    
    return talents, nil
}

// 天赋觉醒
func (s *TalentService) AwakenTalent(
    ctx context.Context,
    pokemonID string,
    talentID string,
    itemID string, // 觉醒道具
) error {
    // 检查道具是否足够
    if !s.hasAwakeningItem(ctx, itemID) {
        return errors.New("insufficient awakening items")
    }
    
    // 获取天赋实例
    pt, err := s.talentRepo.GetPokemonTalent(ctx, pokemonID, talentID)
    if err != nil {
        return err
    }
    
    if pt.Awakened {
        return errors.New("talent already awakened")
    }
    
    // 检查觉醒条件
    if err := s.checkAwakeningConditions(ctx, pt); err != nil {
        return err
    }
    
    // 执行觉醒
    now := time.Now()
    pt.Awakened = true
    pt.AwakenedAt = &now
    
    // 消耗道具
    s.consumeAwakeningItem(ctx, itemID)
    
    // 更新数据库
    if err := s.talentRepo.UpdatePokemonTalent(ctx, pt); err != nil {
        return err
    }
    
    // 发布觉醒事件
    s.eventBus.Publish(events.TalentAwakened{
        PokemonID: pokemonID,
        TalentID:  talentID,
    })
    
    return nil
}

// 天赋升级
func (s *TalentService) LevelUpTalent(
    ctx context.Context,
    pokemonID string,
    talentID string,
    experienceGain int,
) error {
    pt, err := s.talentRepo.GetPokemonTalent(ctx, pokemonID, talentID)
    if err != nil {
        return err
    }
    
    // 获取天赋定义
    talent, err := s.talentRepo.GetTalentByID(ctx, talentID)
    if err != nil {
        return err
    }
    
    if pt.Level >= talent.MaxLevel {
        return errors.New("talent at max level")
    }
    
    // 计算升级所需经验
    requiredExp := s.calculateRequiredExperience(pt.Level)
    
    pt.Experience += experienceGain
    
    // 检查是否升级
    if pt.Experience >= requiredExp {
        pt.Level++
        pt.Experience -= requiredExp
        
        s.eventBus.Publish(events.TalentLeveledUp{
            PokemonID: pokemonID,
            TalentID:  talentID,
            NewLevel:  pt.Level,
        })
    }
    
    return s.talentRepo.UpdatePokemonTalent(ctx, pt)
}

// 计算天赋组合效果
func (s *TalentService) CalculateTalentComboEffects(
    ctx context.Context,
    talents []PokemonTalent,
) ([]ComboEffect, error) {
    // 获取所有觉醒天赋的ID
    awakenedIDs := make([]string, 0)
    for _, t := range talents {
        if t.Awakened {
            awakenedIDs = append(awakenedIDs, t.TalentID)
        }
    }
    
    // 查找匹配的组合
    combos, err := s.talentRepo.FindComboEffects(ctx, awakenedIDs)
    if err != nil {
        return nil, err
    }
    
    return combos, nil
}

func (s *TalentService) calculateTalentCount(rarity int) int {
    // 基础天赋数量 + 随机浮动
    base := 1
    if rarity >= 3 {
        base = 2
    }
    if rarity >= 5 {
        base = 3
    }
    
    // 50%概率多一个天赋
    if rand.Float64() < 0.5 {
        base++
    }
    
    return base
}
```

### 4. 战斗中天赋效果应用

```go
// battle_talent_handler.go
type BattleTalentHandler struct {
    talentService *TalentService
}

// 战斗开始时处理天赋
func (h *BattleTalentHandler) OnBattleStart(
    ctx context.Context,
    battle *Battle,
) error {
    for _, participant := range battle.Participants {
        // 获取精灵天赋
        talents, err := h.talentService.GetActiveTalents(ctx, participant.PokemonID)
        if err != nil {
            return err
        }
        
        // 应用开场触发天赋
        for _, t := range talents {
            if t.Trigger.Type == TriggerTypeOnBattleStart {
                h.applyTalentEffect(ctx, battle, participant, t)
            }
        }
        
        // 计算组合效果
        combos, _ := h.talentService.CalculateTalentComboEffects(ctx, talents)
        for _, combo := range combos {
            h.applyComboEffect(ctx, battle, participant, combo)
        }
    }
    
    return nil
}

// 攻击时处理天赋
func (h *BattleTalentHandler) OnAttack(
    ctx context.Context,
    battle *Battle,
    attacker *BattleParticipant,
    defender *BattleParticipant,
    damage *DamageInfo,
) error {
    talents, _ := h.talentService.GetActiveTalents(ctx, attacker.PokemonID)
    
    for _, t := range talents {
        switch t.Trigger.Type {
        case TriggerTypeOnAttack:
            // 攻击加成
            if rand.Float64() < t.Trigger.Chance {
                damage.Multiplier *= (1 + t.Effects[0].Value)
            }
            
        case TriggerTypeOnCritical:
            // 暴击时额外效果
            if damage.IsCritical {
                h.applyTalentEffect(ctx, battle, attacker, t)
            }
        }
    }
    
    return nil
}

func (h *BattleTalentHandler) applyTalentEffect(
    ctx context.Context,
    battle *Battle,
    participant *BattleParticipant,
    talent *Talent,
) {
    for _, effect := range talent.Effects {
        switch effect.Type {
        case EffectTypeDamageBoost:
            participant.TempStats.DamageBoost += effect.Value
            
        case EffectTypeDefenseBoost:
            participant.TempStats.DefenseBoost += effect.Value
            
        case EffectTypeSpeedBoost:
            participant.TempStats.SpeedBoost += effect.Value
            
        case EffectTypeCriticalChance:
            participant.TempStats.CritChance += effect.Value
            
        case EffectTypeHealing:
            participant.CurrentHP = min(
                participant.MaxHP,
                participant.CurrentHP + int(effect.Value * float64(participant.MaxHP)),
            )
        }
    }
}
```

### 5. 天赋继承系统

```go
// talent_inheritance.go
type TalentInheritanceService struct {
    talentService *TalentService
    db           *sql.DB
}

// 繁殖时计算天赋继承
func (s *TalentInheritanceService) CalculateInheritance(
    ctx context.Context,
    parent1ID string,
    parent2ID string,
) (*InheritanceResult, error) {
    // 获取父母天赋
    parent1Talents, _ := s.talentService.GetActiveTalents(ctx, parent1ID)
    parent2Talents, _ := s.talentService.GetActiveTalents(ctx, parent2ID)
    
    result := &InheritanceResult{
        InheritedTalents: make([]TalentInheritInfo, 0),
    }
    
    // 计算可继承天赋
    allInheritable := make([]PokemonTalent, 0)
    for _, t := range parent1Talents {
        if t.Inheritable {
            allInheritable = append(allInheritable, t)
        }
    }
    for _, t := range parent2Talents {
        if t.Inheritable {
            allInheritable = append(allInheritable, t)
        }
    }
    
    // 随机选择继承天赋
    inheritCount := min(len(allInheritable), 2) // 最多继承2个
    for i := 0; i < inheritCount; i++ {
        if len(allInheritable) == 0 {
            break
        }
        
        idx := rand.Intn(len(allInheritable))
        selected := allInheritable[idx]
        
        // 继承概率 = 30% + 父母天赋等级 * 5%
        inheritChance := 0.3 + float64(selected.Level) * 0.05
        if rand.Float64() < inheritChance {
            result.InheritedTalents = append(result.InheritedTalents, TalentInheritInfo{
                TalentID: selected.TalentID,
                Level:    max(1, selected.Level - 1), // 继承时等级-1
                Source:   "inheritance",
            })
        }
        
        allInheritable = append(allInheritable[:idx], allInheritable[idx+1:]...)
    }
    
    return result, nil
}

type InheritanceResult struct {
    InheritedTalents []TalentInheritInfo `json:"inherited_talents"`
}

type TalentInheritInfo struct {
    TalentID string `json:"talent_id"`
    Level    int    `json:"level"`
    Source   string `json:"source"`
}
```

### 6. API 接口

```go
// talent_handler.go
func (h *Handler) GetPokemonTalents(c *gin.Context) {
    pokemonID := c.Param("id")
    
    talents, err := h.talentService.GetPokemonTalents(c.Request.Context(), pokemonID)
    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(200, gin.H{
        "talents": talents,
    })
}

func (h *Handler) AwakenTalent(c *gin.Context) {
    var req AwakenTalentRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }
    
    err := h.talentService.AwakenTalent(
        c.Request.Context(),
        req.PokemonID,
        req.TalentID,
        req.ItemID,
    )
    if err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(200, gin.H{
        "success": true,
        "message": "Talent awakened successfully",
    })
}

func (h *Handler) GetTalentDetail(c *gin.Context) {
    talentID := c.Param("id")
    
    talent, err := h.talentService.GetTalentDetail(c.Request.Context(), talentID)
    if err != nil {
        c.JSON(404, gin.H{"error": "Talent not found"})
        return
    }
    
    c.JSON(200, talent)
}

func (h *Handler) GetTalentComboPreview(c *gin.Context) {
    var req ComboPreviewRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }
    
    combos, err := h.talentService.GetComboPreview(
        c.Request.Context(),
        req.TalentIDs,
    )
    if err != nil {
        c.JSON(500, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(200, gin.H{
        "combos": combos,
    })
}
```

### 7. 数据库迁移

```sql
-- migrations/083_create_talent_tables.sql

-- 天赋定义表
CREATE TABLE talents (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(20) NOT NULL CHECK (category IN ('attack', 'defense', 'support', 'special')),
    description TEXT,
    effects JSONB NOT NULL DEFAULT '[]',
    trigger_condition JSONB,
    rarity INT NOT NULL CHECK (rarity BETWEEN 1 AND 5),
    inheritable BOOLEAN DEFAULT true,
    max_level INT DEFAULT 10,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_talents_category ON talents(category);
CREATE INDEX idx_talents_rarity ON talents(rarity);

-- 精灵天赋实例表
CREATE TABLE pokemon_talents (
    id VARCHAR(36) PRIMARY KEY,
    pokemon_id VARCHAR(36) NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    talent_id VARCHAR(36) NOT NULL REFERENCES talents(id),
    level INT DEFAULT 1,
    awakened BOOLEAN DEFAULT false,
    awakened_at TIMESTAMP,
    experience INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(pokemon_id, talent_id)
);

CREATE INDEX idx_pokemon_talents_pokemon ON pokemon_talents(pokemon_id);
CREATE INDEX idx_pokemon_talents_awakened ON pokemon_talents(awakened);

-- 隐藏属性表
CREATE TABLE hidden_attributes (
    pokemon_id VARCHAR(36) PRIMARY KEY REFERENCES pokemons(id) ON DELETE CASCADE,
    hp_iv INT CHECK (hp_iv BETWEEN 0 AND 31),
    attack_iv INT CHECK (attack_iv BETWEEN 0 AND 31),
    defense_iv INT CHECK (defense_iv BETWEEN 0 AND 31),
    sp_attack_iv INT CHECK (sp_attack_iv BETWEEN 0 AND 31),
    sp_defense_iv INT CHECK (sp_defense_iv BETWEEN 0 AND 31),
    speed_iv INT CHECK (speed_iv BETWEEN 0 AND 31),
    potential_score INT CHECK (potential_score BETWEEN 0 AND 100),
    hidden_ability VARCHAR(100),
    genetic_factors JSONB DEFAULT '[]',
    awakening_level INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 天赋组合效果表
CREATE TABLE talent_combos (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    required_talents TEXT[] NOT NULL, -- 需要的天赋ID数组
    effects JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_talent_combos_talents ON talent_combos USING GIN(required_talents);

-- 物种可用天赋关联表
CREATE TABLE species_talents (
    species_id VARCHAR(36) NOT NULL REFERENCES pokemon_species(id),
    talent_id VARCHAR(36) NOT NULL REFERENCES talents(id),
    weight INT DEFAULT 1, -- 权重，用于随机选择
    PRIMARY KEY (species_id, talent_id)
);

-- 触发事件日志
CREATE TABLE talent_trigger_logs (
    id VARCHAR(36) PRIMARY KEY,
    battle_id VARCHAR(36),
    pokemon_id VARCHAR(36) NOT NULL,
    talent_id VARCHAR(36) NOT NULL,
    trigger_type VARCHAR(50) NOT NULL,
    effect_applied JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_talent_trigger_logs_battle ON talent_trigger_logs(battle_id);
CREATE INDEX idx_talent_trigger_logs_pokemon ON talent_trigger_logs(pokemon_id);
```

### 8. 预置天赋数据

```go
// seed_talents.go
func SeedTalents(db *sql.DB) error {
    talents := []Talent{
        {
            ID:          "talent-fierce-fang",
            Name:        "Fierce Fang",
            Category:    TalentTypeAttack,
            Description: "Increases critical damage by 30%",
            Effects: []TalentEffect{
                {Type: EffectTypeCriticalDamage, Value: 0.3, ScaleType: "percent"},
            },
            Rarity:      3,
            Inheritable: true,
            MaxLevel:    10,
        },
        {
            ID:          "talent-iron-hide",
            Name:        "Iron Hide",
            Category:    TalentTypeDefense,
            Description: "Reduces incoming damage by 15% when HP is below 30%",
            Effects: []TalentEffect{
                {Type: EffectTypeDamageReduction, Value: 0.15, ScaleType: "percent"},
            },
            TriggerCondition: &TalentTrigger{
                Type:      TriggerTypeOnLowHP,
                Condition: "hp_percent < 30",
                Chance:    1.0,
            },
            Rarity:      4,
            Inheritable: true,
            MaxLevel:    10,
        },
        {
            ID:          "talent-swift-wind",
            Name:        "Swift Wind",
            Category:    TalentTypeSupport,
            Description: "15% chance to dodge attacks",
            Effects: []TalentEffect{
                {Type: EffectTypeDodgeChance, Value: 0.15, ScaleType: "percent"},
            },
            Rarity:      3,
            Inheritable: true,
            MaxLevel:    10,
        },
        {
            ID:          "talent-adrenaline",
            Name:        "Adrenaline",
            Category:    TalentTypeSpecial,
            Description: "When defeating an enemy, heal 20% HP and boost speed by 20% for 3 turns",
            Effects: []TalentEffect{
                {Type: EffectTypeHealing, Value: 0.2, ScaleType: "percent"},
                {Type: EffectTypeSpeedBoost, Value: 0.2, ScaleType: "percent", Duration: 3},
            },
            TriggerCondition: &TalentTrigger{
                Type:   TriggerTypeOnDefeat,
                Chance: 1.0,
            },
            Rarity:      5,
            Inheritable: false,
            MaxLevel:    5,
        },
        {
            ID:          "talent-elemental-harmony",
            Name:        "Elemental Harmony",
            Category:    TalentTypeSpecial,
            Description: "Elemental attacks deal 25% more damage",
            Effects: []TalentEffect{
                {Type: EffectTypeDamageBoost, Value: 0.25, ScaleType: "percent"},
            },
            Rarity:      4,
            Inheritable: true,
            MaxLevel:    10,
        },
    }
    
    for _, t := range talents {
        query := `INSERT INTO talents (id, name, category, description, effects, trigger_condition, rarity, inheritable, max_level)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                  ON CONFLICT (id) DO UPDATE SET name = $2, category = $3`
        
        effectsJSON, _ := json.Marshal(t.Effects)
        var triggerJSON []byte
        if t.TriggerCondition != nil {
            triggerJSON, _ = json.Marshal(t.TriggerCondition)
        }
        
        _, err := db.Exec(query, t.ID, t.Name, t.Category, t.Description, effectsJSON, triggerJSON, t.Rarity, t.Inheritable, t.MaxLevel)
        if err != nil {
            return err
        }
    }
    
    return nil
}
```

### 9. 缓存策略

```go
// talent_cache.go
type TalentCache struct {
    redis  *redis.Client
    ttl    time.Duration
}

const (
    TalentCacheTTL       = 30 * time.Minute
    TalentDetailCacheKey = "talent:detail:%s"
    PokemonTalentCacheKey = "pokemon:talents:%s"
)

func (c *TalentCache) GetTalent(ctx context.Context, talentID string) (*Talent, error) {
    key := fmt.Sprintf(TalentDetailCacheKey, talentID)
    data, err := c.redis.Get(ctx, key).Bytes()
    if err == redis.Nil {
        return nil, nil
    }
    if err != nil {
        return nil, err
    }
    
    var talent Talent
    if err := json.Unmarshal(data, &talent); err != nil {
        return nil, err
    }
    
    return &talent, nil
}

func (c *TalentCache) SetTalent(ctx context.Context, talent *Talent) error {
    key := fmt.Sprintf(TalentDetailCacheKey, talent.ID)
    data, err := json.Marshal(talent)
    if err != nil {
        return err
    }
    
    return c.redis.Set(ctx, key, data, c.ttl).Err()
}

func (c *TalentCache) InvalidatePokemonTalents(ctx context.Context, pokemonID string) error {
    key := fmt.Sprintf(PokemonTalentCacheKey, pokemonID)
    return c.redis.Del(ctx, key).Err()
}
```

## 验收标准

- [ ] 天赋系统完整实现，支持 50+ 种天赋定义
- [ ] 精灵捕捉时自动分配 1-3 个天赋
- [ ] 天赋等级系统和经验值机制正常工作
- [ ] 天赋觉醒功能可用，消耗正确道具
- [ ] 战斗中天赋效果正确触发和应用
- [ ] 天赋组合效果系统正常工作
- [ ] 天赋继承在繁殖时正确计算
- [ ] 隐藏属性（IV）系统正确生成和存储
- [ ] 潜力值计算准确反映精灵品质
- [ ] API 接口完整且响应时间 < 100ms
- [ ] 缓存策略有效，缓存命中率 > 80%
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试验证完整流程

## 影响范围

- **pokemon-service**: 新增天赋和隐藏属性管理
- **battle-service**: 集成天赋效果计算和应用
- **user-service**: 用户精灵天赋展示
- **database**: 新增 6 张表
- **cache**: Redis 缓存天赋数据
- **events**: 新增天赋相关事件

## 参考

- Pokémon 个体值(IV)系统设计
- RPG 游戏天赋树设计模式
- 遗传算法在游戏中的应用
