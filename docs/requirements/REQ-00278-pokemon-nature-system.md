# REQ-00278: 精灵性格系统与战斗风格塑造

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00278 |
| 标题 | 精灵性格系统与战斗风格塑造 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service, battle-service, user-service |
| 创建时间 | 2026-06-22 03:00 |

## 需求描述

精灵性格系统是核心玩法深度的重要组成部分，每只精灵应具有独特的性格特征，影响其战斗表现、能力成长和互动行为。通过性格系统，玩家可以培养出风格各异的精灵，增加策略深度和培养乐趣。

### 核心功能
1. **性格类型系统** - 25种基础性格（参考官方设定）+ 5种稀有性格
2. **性格能力修正** - 不同性格影响能力值成长方向
3. **战斗风格塑造** - 性格影响战斗中的行为倾向
4. **性格互动表现** - 不同性格的精灵在日常互动中有不同表现
5. **性格培养与调整** - 通过特殊道具和训练可以微调性格

## 技术方案

### 1. 性格数据模型

```go
// 性格类型定义
type NatureType string

const (
    // 基础性格（25种）
    NatureHardy    NatureType = "hardy"     // 勤奋 - 无修正
    NatureLonely   NatureType = "lonely"    // 孤僻 - 攻击+ 防御-
    NatureBrave    NatureType = "brave"     // 勇敢 - 攻击+ 速度-
    NatureAdamant  NatureType = "adamant"   // 固执 - 攻击+ 特攻-
    NatureNaughty  NatureType = "naughty"   // 调皮 - 攻击+ 特防-
    NatureBold     NatureType = "bold"      // 大胆 - 防御+ 攻击-
    NatureDocile   NatureType = "docile"    // 坦率 - 无修正
    NatureRelaxed  NatureType = "relaxed"   // 悠闲 - 防御+ 速度-
    NatureImpish   NatureType = "impish"    // 淘气 - 防御+ 特攻-
    NatureLax      NatureType = "lax"       // 乐天 - 防御+ 特防-
    NatureTimid    NatureType = "timid"     // 胆小 - 速度+ 攻击-
    NatureHasty    NatureType = "hasty"     // 急躁 - 速度+ 防御-
    NatureSerious  NatureType = "serious"   // 认真 - 无修正
    NatureJolly    NatureType = "jolly"     // 开朗 - 速度+ 特攻-
    NatureNaive    NatureType = "naive"     // 天真 - 速度+ 特防-
    NatureModest   NatureType = "modest"    // 保守 - 特攻+ 攻击-
    NatureMild     NatureType = "mild"      // 稳重 - 特攻+ 防御-
    NatureQuiet    NatureType = "quiet"     // 冷静 - 特攻+ 速度-
    NatureBashful  NatureType = "bashful"   // 害羞 - 无修正
    NatureRash     NatureType = "rash"      // 马虎 - 特攻+ 特防-
    NatureCalm     NatureType = "calm"      // 沉着 - 特防+ 攻击-
    NatureGentle   NatureType = "gentle"    // 温顺 - 特防+ 防御-
    NatureSassy    NatureType = "sassy"     // 自大 - 特防+ 速度-
    NatureCareful  NatureType = "careful"   // 慎重 - 特防+ 特攻-
    NatureQuirky   NatureType = "quirky"    // 浮躁 - 无修正
    
    // 稀有性格（5种）- 需要特殊条件解锁
    NatureLegendary NatureType = "legendary" // 传说 - 所有属性+3%
    NatureMythical  NatureType = "mythical"  // 神话 - 技能威力+5%
    NatureAncient   NatureType = "ancient"   // 远古 - 抗性+10%
    NatureMystic    NatureType = "mystic"    // 神秘 - 暴击率+5%
    NatureRoyal     NatureType = "royal"     // 皇家 - 经验获取+20%
)

// 性格能力修正
type NatureModifier struct {
    Nature        NatureType `json:"nature"`
    IncreaseStat  string     `json:"increase_stat"`  // 增加的能力
    DecreaseStat  string     `json:"decrease_stat"`  // 减少的能力
    IncreaseRatio float64    `json:"increase_ratio"` // 增加比例（默认10%）
    DecreaseRatio float64    `json:"decrease_ratio"` // 减少比例（默认10%）
}

// 精灵性格信息
type PokemonNature struct {
    ID             string          `json:"id" gorm:"primaryKey"`
    PokemonID      string          `json:"pokemon_id" gorm:"index"`
    Nature         NatureType      `json:"nature"`
    HiddenNature   *NatureType     `json:"hidden_nature,omitempty"` // 隐藏性格（影响喜好）
    
    // 性格强度（0-100，影响修正效果）
    Intensity      int             `json:"intensity"`
    
    // 战斗风格倾向
    BattleStyle    BattleStyle     `json:"battle_style"`
    
    // 性格培养记录
    TrainingHistory []NatureTraining `json:"training_history" gorm:"-"`
    
    CreatedAt      time.Time       `json:"created_at"`
    UpdatedAt      time.Time       `json:"updated_at"`
}

// 战斗风格
type BattleStyle struct {
    Aggressiveness  int    `json:"aggressiveness"`  // 进攻性 0-100
    Defensiveness   int    `json:"defensiveness"`   // 防守性 0-100
    RiskTaking      int    `json:"risk_taking"`     // 冒险倾向 0-100
    TeamPlay        int    `json:"team_play"`       // 团队配合 0-100
    Patience        int    `json:"patience"`        // 耐心程度 0-100
    PreferredMove   string `json:"preferred_move"`  // 偏好招式类型
}

// 性格培养记录
type NatureTraining struct {
    ID          string    `json:"id" gorm:"primaryKey"`
    PokemonID   string    `json:"pokemon_id" gorm:"index"`
    TrainingType string   `json:"training_type"`
    BeforeIntensity int    `json:"before_intensity"`
    AfterIntensity  int    `json:"after_intensity"`
    ItemUsed      string   `json:"item_used,omitempty"`
    TrainerID     string   `json:"trainer_id"`
    CreatedAt     time.Time `json:"created_at"`
}
```

### 2. 性格服务实现

```go
// pokemon-service/internal/nature/service.go

type NatureService struct {
    db           *gorm.DB
    cache        *redis.Client
    natureConfig *NatureConfig
    eventBus     *events.EventBus
}

// 获取性格能力修正
func (s *NatureService) GetNatureModifier(nature NatureType) (*NatureModifier, error) {
    // 从缓存获取
    cacheKey := fmt.Sprintf("nature:modifier:%s", nature)
    if cached, err := s.cache.Get(context.Background(), cacheKey).Result(); err == nil {
        var modifier NatureModifier
        json.Unmarshal([]byte(cached), &modifier)
        return &modifier, nil
    }
    
    // 从配置获取
    modifier, exists := s.natureConfig.Modifiers[nature]
    if !exists {
        return nil, fmt.Errorf("unknown nature: %s", nature)
    }
    
    // 缓存
    data, _ := json.Marshal(modifier)
    s.cache.Set(context.Background(), cacheKey, data, 24*time.Hour)
    
    return &modifier, nil
}

// 应用性格修正到能力值
func (s *NatureService) ApplyNatureModifier(
    baseStats *BaseStats,
    nature NatureType,
    intensity int,
) *ModifiedStats {
    modifier, _ := s.GetNatureModifier(nature)
    
    // 计算实际修正比例（基于性格强度）
    actualRatio := float64(intensity) / 100.0 * 0.1 // 最大10%
    
    modified := &ModifiedStats{
        HP:        baseStats.HP,
        Attack:    baseStats.Attack,
        Defense:   baseStats.Defense,
        SpAttack:  baseStats.SpAttack,
        SpDefense: baseStats.SpDefense,
        Speed:     baseStats.Speed,
    }
    
    // 应用增加修正
    if modifier.IncreaseStat != "" {
        switch modifier.IncreaseStat {
        case "attack":
            modified.Attack = int(float64(baseStats.Attack) * (1 + actualRatio))
        case "defense":
            modified.Defense = int(float64(baseStats.Defense) * (1 + actualRatio))
        case "sp_attack":
            modified.SpAttack = int(float64(baseStats.SpAttack) * (1 + actualRatio))
        case "sp_defense":
            modified.SpDefense = int(float64(baseStats.SpDefense) * (1 + actualRatio))
        case "speed":
            modified.Speed = int(float64(baseStats.Speed) * (1 + actualRatio))
        }
    }
    
    // 应用减少修正
    if modifier.DecreaseStat != "" {
        switch modifier.DecreaseStat {
        case "attack":
            modified.Attack = int(float64(baseStats.Attack) * (1 - actualRatio))
        case "defense":
            modified.Defense = int(float64(baseStats.Defense) * (1 - actualRatio))
        case "sp_attack":
            modified.SpAttack = int(float64(baseStats.SpAttack) * (1 - actualRatio))
        case "sp_defense":
            modified.SpDefense = int(float64(baseStats.SpDefense) * (1 - actualRatio))
        case "speed":
            modified.Speed = int(float64(baseStats.Speed) * (1 - actualRatio))
        }
    }
    
    return modified
}

// 计算战斗风格倾向
func (s *NatureService) CalculateBattleStyle(nature NatureType) *BattleStyle {
    styleMap := map[NatureType]BattleStyle{
        NatureBrave: {
            Aggressiveness: 80,
            Defensiveness:  30,
            RiskTaking:     70,
            TeamPlay:       40,
            Patience:       20,
            PreferredMove:  "physical",
        },
        NatureTimid: {
            Aggressiveness: 30,
            Defensiveness:  60,
            RiskTaking:     20,
            TeamPlay:       70,
            Patience:       80,
            PreferredMove:  "status",
        },
        NatureAdamant: {
            Aggressiveness: 90,
            Defensiveness:  20,
            RiskTaking:     80,
            TeamPlay:       30,
            Patience:       10,
            PreferredMove:  "physical",
        },
        NatureModest: {
            Aggressiveness: 70,
            Defensiveness:  30,
            RiskTaking:     60,
            TeamPlay:       50,
            Patience:       40,
            PreferredMove:  "special",
        },
        NatureCalm: {
            Aggressiveness: 40,
            Defensiveness:  70,
            RiskTaking:     30,
            TeamPlay:       80,
            Patience:       90,
            PreferredMove:  "support",
        },
        // ... 其他性格配置
    }
    
    if style, exists := styleMap[nature]; exists {
        return &style
    }
    
    // 默认平衡风格
    return &BattleStyle{
        Aggressiveness: 50,
        Defensiveness:  50,
        RiskTaking:     50,
        TeamPlay:       50,
        Patience:       50,
        PreferredMove:  "balanced",
    }
}

// 性格培养
func (s *NatureService) TrainNature(
    ctx context.Context,
    pokemonID string,
    trainerID string,
    trainingType string,
    itemID string,
) error {
    // 获取当前性格信息
    var pokemonNature PokemonNature
    if err := s.db.Where("pokemon_id = ?", pokemonID).First(&pokemonNature).Error; err != nil {
        return err
    }
    
    // 检查培养限制
    if pokemonNature.Intensity >= 100 {
        return fmt.Errorf("nature intensity already at maximum")
    }
    
    // 计算强度提升
    intensityGain := s.calculateIntensityGain(trainingType, itemID)
    newIntensity := min(pokemonNature.Intensity+intensityGain, 100)
    
    // 记录培养历史
    training := NatureTraining{
        ID:              uuid.New().String(),
        PokemonID:       pokemonID,
        TrainingType:    trainingType,
        BeforeIntensity: pokemonNature.Intensity,
        AfterIntensity:  newIntensity,
        ItemUsed:        itemID,
        TrainerID:       trainerID,
        CreatedAt:       time.Now(),
    }
    
    // 更新性格强度
    err := s.db.Transaction(func(tx *gorm.DB) error {
        if err := tx.Create(&training).Error; err != nil {
            return err
        }
        
        return tx.Model(&pokemonNature).Updates(map[string]interface{}{
            "intensity":  newIntensity,
            "updated_at": time.Now(),
        }).Error
    })
    
    if err != nil {
        return err
    }
    
    // 发布性格培养事件
    s.eventBus.Publish(events.NatureTrainedEvent{
        PokemonID:   pokemonID,
        Nature:      pokemonNature.Nature,
        NewIntensity: newIntensity,
    })
    
    return nil
}

// 随机生成性格
func (s *NatureService) GenerateRandomNature(isRare bool) NatureType {
    if isRare && rand.Float64() < 0.01 { // 1% 概率生成稀有性格
        rareNatures := []NatureType{
            NatureLegendary, NatureMythical, NatureAncient,
            NatureMystic, NatureRoyal,
        }
        return rareNatures[rand.Intn(len(rareNatures))]
    }
    
    // 从基础性格中随机选择
    basicNatures := []NatureType{
        NatureHardy, NatureLonely, NatureBrave, NatureAdamant, NatureNaughty,
        NatureBold, NatureDocile, NatureRelaxed, NatureImpish, NatureLax,
        NatureTimid, NatureHasty, NatureSerious, NatureJolly, NatureNaive,
        NatureModest, NatureMild, NatureQuiet, NatureBashful, NatureRash,
        NatureCalm, NatureGentle, NatureSassy, NatureCareful, NatureQuirky,
    }
    return basicNatures[rand.Intn(len(basicNatures))]
}
```

### 3. 战斗系统集成

```go
// battle-service/internal/nature/battle_integration.go

type NatureBattleIntegration struct {
    natureClient *naturepb.NatureServiceClient
}

// 在战斗计算中应用性格修正
func (n *NatureBattleIntegration) ApplyNatureInBattle(
    ctx context.Context,
    pokemon *BattlePokemon,
    battleContext *BattleContext,
) *BattleModifiers {
    // 获取性格信息
    natureInfo, err := n.natureClient.GetNatureInfo(ctx, &naturepb.GetNatureInfoRequest{
        PokemonId: pokemon.ID,
    })
    if err != nil {
        return &BattleModifiers{} // 默认无修正
    }
    
    modifiers := &BattleModifiers{}
    
    // 应用能力修正
    modifier, _ := n.natureClient.GetNatureModifier(ctx, &naturepb.GetNatureModifierRequest{
        Nature: string(natureInfo.Nature),
    })
    
    if modifier.IncreaseStat != "" {
        modifiers.StatBoost[modifier.IncreaseStat] = float64(natureInfo.Intensity) / 1000.0
    }
    if modifier.DecreaseStat != "" {
        modifiers.StatBoost[modifier.DecreaseStat] = -float64(natureInfo.Intensity) / 1000.0
    }
    
    // 应用战斗风格偏好
    battleStyle := natureInfo.BattleStyle
    
    // 进攻性性格：攻击招式威力提升
    if battleStyle.Aggressiveness > 70 {
        modifiers.AttackPowerBonus = float64(battleStyle.Aggressiveness-70) / 300.0
    }
    
    // 防守性性格：受到伤害减少
    if battleStyle.Defensiveness > 70 {
        modifiers.DamageReduction = float64(battleStyle.Defensiveness-70) / 500.0
    }
    
    // 冒险性格：暴击率提升但防御降低
    if battleStyle.RiskTaking > 80 {
        modifiers.CritRateBonus = 0.05
        modifiers.DefensePenalty = 0.05
    }
    
    // 团队配合性格：队友技能效果提升
    if battleStyle.TeamPlay > 75 {
        modifiers.TeamSkillBonus = float64(battleStyle.TeamPlay-75) / 500.0
    }
    
    // 耐心性格：持久战能力提升
    if battleStyle.Patience > 70 {
        modifiers.TurnCountBonus = float64(battleStyle.Patience-70) / 200.0 // 每回合增加属性
    }
    
    // 稀有性格特殊效果
    switch natureInfo.Nature {
    case "legendary":
        modifiers.AllStatBonus = 0.03
    case "mythical":
        modifiers.MovePowerBonus = 0.05
    case "ancient":
        modifiers.ResistanceBonus = 0.10
    case "mystic":
        modifiers.CritRateBonus = 0.05
    case "royal":
        // 经验加成在战斗结束后应用
        modifiers.ExpBonus = 0.20
    }
    
    return modifiers
}

// AI决策时考虑性格
func (n *NatureBattleIntegration) GetNatureInfluencedMove(
    ctx context.Context,
    pokemon *BattlePokemon,
    availableMoves []*Move,
    battleContext *BattleContext,
) *Move {
    natureInfo, err := n.natureClient.GetNatureInfo(ctx, &naturepb.GetNatureInfoRequest{
        PokemonId: pokemon.ID,
    })
    if err != nil {
        return availableMoves[0] // 默认第一个招式
    }
    
    battleStyle := natureInfo.BattleStyle
    preferredMoveType := battleStyle.PreferredMove
    
    // 根据性格偏好选择招式
    var preferredMoves []*Move
    for _, move := range availableMoves {
        // 检查招式类型是否符合性格偏好
        if n.matchesPreferredStyle(move, preferredMoveType, battleStyle) {
            preferredMoves = append(preferredMoves, move)
        }
    }
    
    if len(preferredMoves) > 0 {
        // 从偏好招式中选择最优
        return n.selectOptimalMove(preferredMoves, battleContext)
    }
    
    // 没有偏好招式，随机选择
    return availableMoves[rand.Intn(len(availableMoves))]
}

func (n *NatureBattleIntegration) matchesPreferredStyle(
    move *Move,
    preferredType string,
    style *BattleStyle,
) bool {
    switch preferredType {
    case "physical":
        return move.Category == "physical"
    case "special":
        return move.Category == "special"
    case "status":
        return move.Category == "status"
    case "support":
        return move.SupportMove
    case "balanced":
        return true
    default:
        return true
    }
}
```

### 4. 性格互动系统

```go
// pokemon-service/internal/nature/interaction.go

type NatureInteractionService struct {
    db         *gorm.DB
    natureSvc  *NatureService
    eventBus   *events.EventBus
}

// 性格互动表现
func (s *NatureInteractionService) GetNatureInteraction(
    ctx context.Context,
    pokemonID string,
    interactionType string,
) (*NatureInteraction, error) {
    natureInfo, err := s.natureSvc.GetPokemonNature(ctx, pokemonID)
    if err != nil {
        return nil, err
    }
    
    interaction := &NatureInteraction{
        PokemonID:       pokemonID,
        Nature:          natureInfo.Nature,
        InteractionType: interactionType,
    }
    
    // 根据性格设置互动反应
    switch natureInfo.Nature {
    case NatureBrave:
        interaction.Reaction = "confident_pose"
        interaction.Dialogue = []string{"让我来挑战吧！", "我不会退缩的！"}
        interaction.Animation = "brave_stance"
        
    case NatureTimid:
        interaction.Reaction = "shy_hide"
        interaction.Dialogue = []string{"好害怕...", "能保护我吗？"}
        interaction.Animation = "timid_flinch"
        
    case NatureJolly:
        interaction.Reaction = "happy_bounce"
        interaction.Dialogue = []string{"太棒了！", "一起来玩吧！"}
        interaction.Animation = "jolly_dance"
        
    case NatureCalm:
        interaction.Reaction = "peaceful_meditation"
        interaction.Dialogue = []string{"保持冷静...", "一切都会好起来的。"}
        interaction.Animation = "calm_breath"
        
    // ... 其他性格的互动表现
    }
    
    // 稀有性格特殊互动
    if s.isRareNature(natureInfo.Nature) {
        interaction.SpecialEffect = s.getRareNatureEffect(natureInfo.Nature)
    }
    
    return interaction, nil
}

// 性格喜好物品
func (s *NatureInteractionService) GetNaturePreferences(
    ctx context.Context,
    nature NatureType,
) (*NaturePreferences, error) {
    prefs := &NaturePreferences{
        Nature: nature,
    }
    
    // 每种性格有不同喜好
    preferenceMap := map[NatureType]NaturePreferences{
        NatureAdamant: {
            FavoriteBerry:   "spicy",
            FavoriteFlavor:  "spicy",
            DislikedFlavor:  "dry",
            FavoriteToy:     "punching_bag",
            FavoriteActivity: "battle_training",
        },
        NatureModest: {
            FavoriteBerry:   "dry",
            FavoriteFlavor:  "dry",
            DislikedFlavor:  "spicy",
            FavoriteToy:     "puzzle_game",
            FavoriteActivity: "mental_training",
        },
        NatureJolly: {
            FavoriteBerry:   "sweet",
            FavoriteFlavor:  "sweet",
            DislikedFlavor:  "bitter",
            FavoriteToy:     "ball",
            FavoriteActivity: "play",
        },
        // ... 其他性格偏好
    }
    
    if pref, exists := preferenceMap[nature]; exists {
        return &pref, nil
    }
    
    // 默认偏好
    return &NaturePreferences{
        Nature:           nature,
        FavoriteBerry:    "neutral",
        FavoriteFlavor:   "neutral",
        FavoriteToy:      "any",
        FavoriteActivity: "any",
    }, nil
}
```

### 5. API 接口定义

```go
// pokemon-service/api/nature.proto

syntax = "proto3";

package nature;

option go_package = "github.com/mineGo/pokemon-service/api/naturepb";

service NatureService {
    // 获取精灵性格信息
    rpc GetNatureInfo(GetNatureInfoRequest) returns (GetNatureInfoResponse);
    
    // 获取性格修正
    rpc GetNatureModifier(GetNatureModifierRequest) returns (GetNatureModifierResponse);
    
    // 性格培养
    rpc TrainNature(TrainNatureRequest) returns (TrainNatureResponse);
    
    // 性格互动
    rpc GetNatureInteraction(GetNatureInteractionRequest) returns (GetNatureInteractionResponse);
    
    // 性格偏好
    rpc GetNaturePreferences(GetNaturePreferencesRequest) returns (GetNaturePreferencesResponse);
    
    // 列出所有性格
    rpc ListNatures(ListNaturesRequest) returns (ListNaturesResponse);
}

message GetNatureInfoRequest {
    string pokemon_id = 1;
}

message GetNatureInfoResponse {
    string id = 1;
    string pokemon_id = 2;
    string nature = 3;
    string hidden_nature = 4;
    int32 intensity = 5;
    BattleStyle battle_style = 6;
    int64 created_at = 7;
    int64 updated_at = 8;
}

message BattleStyle {
    int32 aggressiveness = 1;
    int32 defensiveness = 2;
    int32 risk_taking = 3;
    int32 team_play = 4;
    int32 patience = 5;
    string preferred_move = 6;
}

message GetNatureModifierRequest {
    string nature = 1;
}

message GetNatureModifierResponse {
    string nature = 1;
    string increase_stat = 2;
    string decrease_stat = 3;
    double increase_ratio = 4;
    double decrease_ratio = 5;
}

message TrainNatureRequest {
    string pokemon_id = 1;
    string trainer_id = 2;
    string training_type = 3;
    string item_id = 4;
}

message TrainNatureResponse {
    bool success = 1;
    int32 new_intensity = 2;
    string message = 3;
}

message GetNatureInteractionRequest {
    string pokemon_id = 1;
    string interaction_type = 2;
}

message GetNatureInteractionResponse {
    string pokemon_id = 1;
    string nature = 2;
    string interaction_type = 3;
    string reaction = 4;
    repeated string dialogue = 5;
    string animation = 6;
    string special_effect = 7;
}

message GetNaturePreferencesRequest {
    string nature = 1;
}

message GetNaturePreferencesResponse {
    string nature = 1;
    string favorite_berry = 2;
    string favorite_flavor = 3;
    string disliked_flavor = 4;
    string favorite_toy = 5;
    string favorite_activity = 6;
}

message ListNaturesRequest {
    bool include_rare = 1;
}

message ListNaturesResponse {
    repeated NatureInfo natures = 1;
}

message NatureInfo {
    string name = 1;
    string display_name = 2;
    string description = 3;
    bool is_rare = 4;
    string increase_stat = 5;
    string decrease_stat = 6;
}
```

### 6. 数据库迁移

```sql
-- migrations/20260622030000_create_nature_tables.sql

-- 性格配置表
CREATE TABLE nature_configs (
    id VARCHAR(36) PRIMARY KEY,
    nature VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    is_rare BOOLEAN DEFAULT FALSE,
    increase_stat VARCHAR(20),
    decrease_stat VARCHAR(20),
    increase_ratio DECIMAL(5,4) DEFAULT 0.1,
    decrease_ratio DECIMAL(5,4) DEFAULT 0.1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 精灵性格表
CREATE TABLE pokemon_natures (
    id VARCHAR(36) PRIMARY KEY,
    pokemon_id VARCHAR(36) UNIQUE NOT NULL,
    nature VARCHAR(50) NOT NULL,
    hidden_nature VARCHAR(50),
    intensity INT DEFAULT 50 CHECK (intensity >= 0 AND intensity <= 100),
    aggressiveness INT DEFAULT 50,
    defensiveness INT DEFAULT 50,
    risk_taking INT DEFAULT 50,
    team_play INT DEFAULT 50,
    patience INT DEFAULT 50,
    preferred_move VARCHAR(20) DEFAULT 'balanced',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (pokemon_id) REFERENCES pokemons(id) ON DELETE CASCADE,
    FOREIGN KEY (nature) REFERENCES nature_configs(nature)
);

-- 性格培养记录表
CREATE TABLE nature_trainings (
    id VARCHAR(36) PRIMARY KEY,
    pokemon_id VARCHAR(36) NOT NULL,
    training_type VARCHAR(50) NOT NULL,
    before_intensity INT NOT NULL,
    after_intensity INT NOT NULL,
    item_used VARCHAR(36),
    trainer_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (pokemon_id) REFERENCES pokemons(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX idx_pokemon_natures_pokemon_id ON pokemon_natures(pokemon_id);
CREATE INDEX idx_pokemon_natures_nature ON pokemon_natures(nature);
CREATE INDEX idx_nature_trainings_pokemon_id ON nature_trainings(pokemon_id);
CREATE INDEX idx_nature_trainings_trainer_id ON nature_trainings(trainer_id);

-- 初始化性格配置
INSERT INTO nature_configs (id, nature, display_name, description, is_rare, increase_stat, decrease_stat) VALUES
(UUID(), 'hardy', '勤奋', '平衡发展的性格', FALSE, NULL, NULL),
(UUID(), 'lonely', '孤僻', '倾向于攻击，忽视防御', FALSE, 'attack', 'defense'),
(UUID(), 'brave', '勇敢', '勇敢无畏，但行动迟缓', FALSE, 'attack', 'speed'),
(UUID(), 'adamant', '固执', '坚持物理攻击，忽视特殊攻击', FALSE, 'attack', 'sp_attack'),
(UUID(), 'naughty', '调皮', '喜欢攻击，忽视特防', FALSE, 'attack', 'sp_defense'),
(UUID(), 'bold', '大胆', '注重防御，放弃攻击', FALSE, 'defense', 'attack'),
(UUID(), 'docile', '坦率', '直率坦诚的性格', FALSE, NULL, NULL),
(UUID(), 'relaxed', '悠闲', '从容不迫，速度较慢', FALSE, 'defense', 'speed'),
(UUID(), 'impish', '淘气', '调皮捣蛋，不擅长特殊攻击', FALSE, 'defense', 'sp_attack'),
(UUID(), 'lax', '乐天', '乐观开朗，忽视特防', FALSE, 'defense', 'sp_defense'),
(UUID(), 'timid', '胆小', '行动迅速，但攻击较弱', FALSE, 'speed', 'attack'),
(UUID(), 'hasty', '急躁', '急于行动，防御不足', FALSE, 'speed', 'defense'),
(UUID(), 'serious', '认真', '认真严肃的性格', FALSE, NULL, NULL),
(UUID(), 'jolly', '开朗', '活泼开朗，不喜欢特殊攻击', FALSE, 'speed', 'sp_attack'),
(UUID(), 'naive', '天真', '天真烂漫，特防较弱', FALSE, 'speed', 'sp_defense'),
(UUID(), 'modest', '保守', '注重特殊攻击，放弃物理攻击', FALSE, 'sp_attack', 'attack'),
(UUID(), 'mild', '稳重', '稳重内敛，防御较弱', FALSE, 'sp_attack', 'defense'),
(UUID(), 'quiet', '冷静', '冷静沉稳，速度较慢', FALSE, 'sp_attack', 'speed'),
(UUID(), 'bashful', '害羞', '害羞腼腆的性格', FALSE, NULL, NULL),
(UUID(), 'rash', '马虎', '粗心大意，特防较弱', FALSE, 'sp_attack', 'sp_defense'),
(UUID(), 'calm', '沉着', '沉着冷静，攻击较弱', FALSE, 'sp_defense', 'attack'),
(UUID(), 'gentle', '温顺', '温柔顺从，防御较弱', FALSE, 'sp_defense', 'defense'),
(UUID(), 'sassy', '自大', '自信满满，速度较慢', FALSE, 'sp_defense', 'speed'),
(UUID(), 'careful', '慎重', '谨慎小心，不喜欢特殊攻击', FALSE, 'sp_defense', 'sp_attack'),
(UUID(), 'quirky', '浮躁', '变化多端的性格', FALSE, NULL, NULL);

-- 稀有性格
INSERT INTO nature_configs (id, nature, display_name, description, is_rare, increase_stat, decrease_stat) VALUES
(UUID(), 'legendary', '传说', '传说中的稀有性格，全面提升', TRUE, 'all', NULL),
(UUID(), 'mythical', '神话', '神话般的性格，技能威力增强', TRUE, 'power', NULL),
(UUID(), 'ancient', '远古', '古老的性格，拥有强大抗性', TRUE, 'resistance', NULL),
(UUID(), 'mystic', '神秘', '神秘的性格，暴击率提升', TRUE, 'crit', NULL),
(UUID(), 'royal', '皇家', '高贵的性格，成长速度加快', TRUE, 'exp', NULL);
```

## 验收标准

- [ ] 30种性格（25基础+5稀有）全部实现
- [ ] 性格能力修正正确应用（±10%）
- [ ] 性格强度系统可培养（0-100）
- [ ] 战斗风格影响AI决策
- [ ] 稀有性格有独特效果
- [ ] 性格互动系统完整（对话、动画）
- [ ] 性格喜好系统正常工作
- [ ] 性格培养记录可追溯
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] API 文档完整
- [ ] 性能测试：性格查询 < 10ms（缓存命中）
- [ ] 数据库迁移脚本无错误

## 影响范围

- **pokemon-service**: 新增性格服务模块
- **battle-service**: 战斗系统集成性格修正
- **user-service**: 玩家精灵管理界面
- **database**: 新增 nature 相关表
- **frontend**: 性格展示和培养界面

## 参考

- [Pokémon Nature System](https://bulbapedia.bulbagarden.net/wiki/Nature)
- [Game Design: Personality Systems](https://www.gamedeveloper.com/design/personality-systems-in-games)
- REQ-00276: 精灵培育系统与基因遗传机制（相关需求）
- REQ-00197: 精灵天赋系统与隐藏属性机制（相关需求）
