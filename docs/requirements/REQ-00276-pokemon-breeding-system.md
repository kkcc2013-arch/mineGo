# REQ-00276: 精灵培育系统与基因遗传机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00276 |
| 标题 | 精灵培育系统与基因遗传机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service, reward-service, user-service |
| 创建时间 | 2026-06-22 02:00 |

## 需求描述

精灵培育系统是 mineGo 游戏的核心玩法之一，允许玩家通过两只精灵进行培育，生成具有遗传特征的后代精灵。系统需要实现基因遗传、孵化机制、培育环境等核心功能，为玩家提供深度的精灵养成体验。

### 核心功能

1. **培育屋系统**：玩家可以放置精灵进行培育
2. **基因遗传机制**：后代继承父母精灵的基因特征
3. **孵化系统**：培育后获得精灵蛋，需要孵化才能获得精灵
4. **培育记录**：记录培育历史和血统追踪
5. **遗传优化**：通过特殊道具提升遗传概率和品质

## 技术方案

### 1. 培育屋数据模型

```go
// BreedingHouse 培育屋结构
type BreedingHouse struct {
    ID            string    `json:"id" gorm:"primaryKey"`
    UserID        string    `json:"user_id" gorm:"index"`
    SlotCount     int       `json:"slot_count"`       // 培育槽位数（默认2个）
    ActiveSlots   int       `json:"active_slots"`     // 正在使用的槽位
    CreatedAt     time.Time `json:"created_at"`
    UpdatedAt     time.Time `json:"updated_at"`
}

// BreedingSlot 培育槽
type BreedingSlot struct {
    ID            string    `json:"id" gorm:"primaryKey"`
    HouseID       string    `json:"house_id" gorm:"index"`
    FatherID      string    `json:"father_id"`        // 父方精灵ID
    MotherID      string    `json:"mother_id"`        // 母方精灵ID
    StartTime     time.Time `json:"start_time"`
    EndTime       time.Time `json:"end_time"`         // 预计完成时间
    Status        string    `json:"status"`           // idle, breeding, ready
    ResultEggID   *string   `json:"result_egg_id"`
    CreatedAt     time.Time `json:"created_at"`
}

// PokemonGene 精灵基因
type PokemonGene struct {
    ID           string    `json:"id" gorm:"primaryKey"`
    PokemonID    string    `json:"pokemon_id" gorm:"index"`
    GeneType     string    `json:"gene_type"`        // stats, skill, trait, color
    GeneKey      string    `json:"gene_key"`         // hp, attack, skill_id, etc.
    GeneValue    float64   `json:"gene_value"`
    Dominance    float64   `json:"dominance"`        // 显性度 0-1
    Heritability float64   `json:"heritability"`     // 遗传概率
    CreatedAt    time.Time `json:"created_at"`
}

// PokemonEgg 精灵蛋
type PokemonEgg struct {
    ID           string    `json:"id" gorm:"primaryKey"`
    UserID       string    `json:"user_id" gorm:"index"`
    FatherID     string    `json:"father_id"`
    MotherID     string    `json:"mother_id"`
    SpeciesID    string    `json:"species_id"`       // 预设种族
    GeneSet      string    `json:"gene_set"`         // JSON: 继承的基因集合
    Rarity       string    `json:"rarity"`           // normal, rare, epic, legendary
    HatchSteps   int       `json:"hatch_steps"`      // 孵化所需步数
    CurrentSteps int       `json:"current_steps"`    // 当前步数
    Status       string    `json:"status"`           // unhatched, hatching, hatched
    HatchedAt    *time.Time `json:"hatched_at"`
    CreatedAt    time.Time `json:"created_at"`
}

// BreedingRecord 培育记录
type BreedingRecord struct {
    ID           string    `json:"id" gorm:"primaryKey"`
    UserID       string    `json:"user_id" gorm:"index"`
    FatherID     string    `json:"father_id"`
    MotherID     string    `json:"mother_id"`
    ResultEggID  string    `json:"result_egg_id"`
    HatchedPokemonID *string `json:"hatched_pokemon_id"`
    Generation   int       `json:"generation"`       // 第几代
    CreatedAt    time.Time `json:"created_at"`
}
```

### 2. 基因遗传算法

```go
package breeding

import (
    "math/rand"
    "github.com/google/uuid"
)

// GeneInheritanceConfig 基因遗传配置
type GeneInheritanceConfig struct {
    BaseHeritability   float64 `json:"base_heritability"`    // 基础遗传概率 0.3
    StatInheritanceRate float64 `json:"stat_inheritance_rate"` // 属性遗传率 0.5
    SkillInheritanceRate float64 `json:"skill_inheritance_rate"` // 技能遗传率 0.6
    TraitInheritanceRate float64 `json:"trait_inheritance_rate"` // 特性遗传率 0.7
    MutationRate       float64 `json:"mutation_rate"`        // 变异概率 0.05
    HiddenGeneRate     float64 `json:"hidden_gene_rate"`     // 隐性基因表达率
}

// GeneInheritanceEngine 基因遗传引擎
type GeneInheritanceEngine struct {
    config GeneInheritanceConfig
}

// InheritGenes 执行基因遗传
func (e *GeneInheritanceEngine) InheritGenes(fatherGenes, motherGenes []PokemonGene) ([]PokemonGene, error) {
    var inheritedGenes []PokemonGene
    
    // 1. 属性基因遗传（HP, 攻击, 防御, 速度等）
    statGenes := e.inheritStatGenes(fatherGenes, motherGenes)
    inheritedGenes = append(inheritedGenes, statGenes...)
    
    // 2. 技能基因遗传
    skillGenes := e.inheritSkillGenes(fatherGenes, motherGenes)
    inheritedGenes = append(inheritedGenes, skillGenes...)
    
    // 3. 特性基因遗传
    traitGenes := e.inheritTraitGenes(fatherGenes, motherGenes)
    inheritedGenes = append(inheritedGenes, traitGenes...)
    
    // 4. 颜色/外观基因遗传
    colorGenes := e.inheritColorGenes(fatherGenes, motherGenes)
    inheritedGenes = append(inheritedGenes, colorGenes...)
    
    // 5. 变异检测
    if rand.Float64() < e.config.MutationRate {
        mutatedGene := e.applyMutation(inheritedGenes)
        if mutatedGene != nil {
            inheritedGenes = append(inheritedGenes, *mutatedGene)
        }
    }
    
    return inheritedGenes, nil
}

// inheritStatGenes 属性基因遗传
func (e *GeneInheritanceEngine) inheritStatGenes(father, mother []PokemonGene) []PokemonGene {
    var result []PokemonGene
    statKeys := []string{"hp", "attack", "defense", "sp_attack", "sp_defense", "speed"}
    
    for _, key := range statKeys {
        fatherGene := e.findGene(father, "stats", key)
        motherGene := e.findGene(mother, "stats", key)
        
        if fatherGene == nil && motherGene == nil {
            continue
        }
        
        // 遗传算法：加权平均 + 随机波动
        inheritedValue := e.calculateInheritedValue(fatherGene, motherGene)
        
        result = append(result, PokemonGene{
            ID:           uuid.New().String(),
            GeneType:     "stats",
            GeneKey:      key,
            GeneValue:    inheritedValue,
            Dominance:    e.calculateDominance(fatherGene, motherGene),
            Heritability: e.config.StatInheritanceRate,
        })
    }
    
    return result
}

// calculateInheritedValue 计算遗传值
func (e *GeneInheritanceEngine) calculateInheritedValue(father, mother *PokemonGene) float64 {
    if father == nil {
        return mother.GeneValue * (0.8 + rand.Float64()*0.4)
    }
    if mother == nil {
        return father.GeneValue * (0.8 + rand.Float64()*0.4)
    }
    
    // 父母基因加权平均，考虑显性度
    weightF := father.Dominance / (father.Dominance + mother.Dominance)
    weightM := mother.Dominance / (father.Dominance + mother.Dominance)
    
    baseValue := father.GeneValue*weightF + mother.GeneValue*weightM
    
    // 添加随机波动（±15%）
    variation := 0.85 + rand.Float64()*0.3
    return baseValue * variation
}

// inheritSkillGenes 技能基因遗传
func (e *GeneInheritanceEngine) inheritSkillGenes(father, mother []PokemonGene) []PokemonGene {
    var result []PokemonGene
    fatherSkills := e.filterGenes(father, "skill")
    motherSkills := e.filterGenes(mother, "skill")
    
    // 每个技能独立判断是否遗传
    allSkills := append(fatherSkills, motherSkills...)
    
    for _, skill := range allSkills {
        if rand.Float64() < e.config.SkillInheritanceRate {
            result = append(result, PokemonGene{
                ID:           uuid.New().String(),
                GeneType:     "skill",
                GeneKey:      skill.GeneKey,
                GeneValue:    1.0,
                Dominance:    rand.Float64(),
                Heritability: skill.Heritability,
            })
        }
    }
    
    // 限制最大技能数量（4个）
    if len(result) > 4 {
        result = result[:4]
    }
    
    return result
}

// applyMutation 应用变异
func (e *GeneInheritanceEngine) applyMutation(genes []PokemonGene) *PokemonGene {
    // 随机选择一个基因进行变异
    if len(genes) == 0 {
        return nil
    }
    
    idx := rand.Intn(len(genes))
    mutated := genes[idx]
    
    // 变异类型：增强、减弱、类型变更
    mutationType := rand.Intn(3)
    
    switch mutationType {
    case 0: // 增强
        mutated.GeneValue *= 1.5
        mutated.Dominance = 1.0
    case 1: // 减弱
        mutated.GeneValue *= 0.5
    case 2: // 类型变更（极小概率）
        mutated.GeneKey = "hidden_" + mutated.GeneKey
    }
    
    mutated.ID = uuid.New().String()
    
    return &mutated
}
```

### 3. 培育服务实现

```go
package breeding

import (
    "context"
    "errors"
    "time"
    
    "github.com/go-redis/redis/v8"
    "gorm.io/gorm"
)

// BreedingService 培育服务
type BreedingService struct {
    db          *gorm.DB
    redis       *redis.Client
    geneEngine  *GeneInheritanceEngine
    eventPub    EventPublisher
}

// StartBreeding 开始培育
func (s *BreedingService) StartBreeding(ctx context.Context, req StartBreedingRequest) (*BreedingSlot, error) {
    // 1. 验证培育条件
    if err := s.validateBreedingConditions(ctx, req); err != nil {
        return nil, err
    }
    
    // 2. 获取培育屋
    house, err := s.getOrCreateHouse(ctx, req.UserID)
    if err != nil {
        return nil, err
    }
    
    // 3. 检查空闲槽位
    if house.ActiveSlots >= house.SlotCount {
        return nil, errors.New("no available breeding slots")
    }
    
    // 4. 获取父母精灵基因
    fatherGenes, err := s.getPokemonGenes(ctx, req.FatherID)
    if err != nil {
        return nil, err
    }
    motherGenes, err := s.getPokemonGenes(ctx, req.MotherID)
    if err != nil {
        return nil, err
    }
    
    // 5. 创建培育槽
    breedingTime := s.calculateBreedingTime(fatherGenes, motherGenes)
    
    slot := &BreedingSlot{
        ID:        uuid.New().String(),
        HouseID:   house.ID,
        FatherID:  req.FatherID,
        MotherID:  req.MotherID,
        StartTime: time.Now(),
        EndTime:   time.Now().Add(breedingTime),
        Status:    "breeding",
    }
    
    if err := s.db.Create(slot).Error; err != nil {
        return nil, err
    }
    
    // 6. 更新培育屋状态
    house.ActiveSlots++
    s.db.Save(house)
    
    // 7. 发布培育事件
    s.eventPub.Publish(ctx, "breeding.started", map[string]interface{}{
        "user_id":    req.UserID,
        "slot_id":    slot.ID,
        "father_id":  req.FatherID,
        "mother_id":  req.MotherID,
        "end_time":   slot.EndTime,
    })
    
    return slot, nil
}

// CompleteBreeding 完成培育
func (s *BreedingService) CompleteBreeding(ctx context.Context, slotID string) (*PokemonEgg, error) {
    // 1. 获取培育槽
    var slot BreedingSlot
    if err := s.db.First(&slot, "id = ?", slotID).Error; err != nil {
        return nil, err
    }
    
    if slot.Status != "breeding" {
        return nil, errors.New("breeding slot not in breeding status")
    }
    
    if time.Now().Before(slot.EndTime) {
        return nil, errors.New("breeding not completed yet")
    }
    
    // 2. 获取基因
    fatherGenes, _ := s.getPokemonGenes(ctx, slot.FatherID)
    motherGenes, _ := s.getPokemonGenes(ctx, slot.MotherID)
    
    // 3. 执行基因遗传
    inheritedGenes, err := s.geneEngine.InheritGenes(fatherGenes, motherGenes)
    if err != nil {
        return nil, err
    }
    
    // 4. 确定后代种族
    speciesID := s.determineOffspringSpecies(ctx, slot.FatherID, slot.MotherID, inheritedGenes)
    
    // 5. 计算稀有度
    rarity := s.calculateRarity(inheritedGenes)
    
    // 6. 创建精灵蛋
    egg := &PokemonEgg{
        ID:          uuid.New().String(),
        UserID:      slot.UserID(),
        FatherID:    slot.FatherID,
        MotherID:    slot.MotherID,
        SpeciesID:   speciesID,
        GeneSet:     s.serializeGenes(inheritedGenes),
        Rarity:      rarity,
        HatchSteps:  s.calculateHatchSteps(speciesID, rarity),
        Status:      "unhatched",
        CreatedAt:   time.Now(),
    }
    
    if err := s.db.Create(egg).Error; err != nil {
        return nil, err
    }
    
    // 7. 更新培育槽
    slot.Status = "ready"
    slot.ResultEggID = &egg.ID
    s.db.Save(&slot)
    
    // 8. 创建培育记录
    record := &BreedingRecord{
        ID:          uuid.New().String(),
        UserID:      egg.UserID,
        FatherID:    slot.FatherID,
        MotherID:    slot.MotherID,
        ResultEggID: egg.ID,
        Generation:  s.calculateGeneration(ctx, slot.FatherID, slot.MotherID),
        CreatedAt:   time.Now(),
    }
    s.db.Create(record)
    
    return egg, nil
}

// HatchEgg 孵化精灵蛋
func (s *BreedingService) HatchEgg(ctx context.Context, eggID string) (*Pokemon, error) {
    // 1. 获取精灵蛋
    var egg PokemonEgg
    if err := s.db.First(&egg, "id = ?", eggID).Error; err != nil {
        return nil, err
    }
    
    if egg.Status != "unhatched" {
        return nil, errors.New("egg already hatched")
    }
    
    // 2. 检查孵化步数
    if egg.CurrentSteps < egg.HatchSteps {
        return nil, errors.New("not enough steps to hatch")
    }
    
    // 3. 解析基因
    genes := s.deserializeGenes(egg.GeneSet)
    
    // 4. 创建精灵
    pokemon := &Pokemon{
        ID:        uuid.New().String(),
        UserID:    egg.UserID,
        SpeciesID: egg.SpeciesID,
        Level:     1,
        Exp:       0,
        IVs:       s.extractIVs(genes),
        Nature:    s.determineNature(genes),
        CreatedAt: time.Now(),
    }
    
    if err := s.db.Create(pokemon).Error; err != nil {
        return nil, err
    }
    
    // 5. 创建精灵基因记录
    for _, gene := range genes {
        gene.ID = uuid.New().String()
        gene.PokemonID = pokemon.ID
        s.db.Create(&gene)
    }
    
    // 6. 更新精灵蛋状态
    now := time.Now()
    egg.Status = "hatched"
    egg.HatchedAt = &now
    egg.HatchedPokemonID = &pokemon.ID
    s.db.Save(&egg)
    
    // 7. 更新培育记录
    s.db.Model(&BreedingRecord{}).
        Where("result_egg_id = ?", eggID).
        Update("hatched_pokemon_id", pokemon.ID)
    
    // 8. 发布孵化事件
    s.eventPub.Publish(ctx, "egg.hatched", map[string]interface{}{
        "user_id":    egg.UserID,
        "egg_id":     eggID,
        "pokemon_id": pokemon.ID,
        "species_id": pokemon.SpeciesID,
        "rarity":     egg.Rarity,
    })
    
    return pokemon, nil
}

// AddHatchSteps 添加孵化步数
func (s *BreedingService) AddHatchSteps(ctx context.Context, userID string, steps int) error {
    // 获取用户所有未孵化的蛋
    var eggs []PokemonEgg
    s.db.Where("user_id = ? AND status = 'unhatched'", userID).Find(&eggs)
    
    for _, egg := range eggs {
        egg.CurrentSteps += steps
        if egg.CurrentSteps >= egg.HatchSteps {
            egg.CurrentSteps = egg.HatchSteps
            egg.Status = "hatching" // 可以孵化状态
        }
        s.db.Save(&egg)
    }
    
    return nil
}
```

### 4. 孵化系统API

```go
package api

import (
    "net/http"
    "github.com/gin-gonic/gin"
)

// BreedingHandler 培育API处理器
type BreedingHandler struct {
    breedingService *BreedingService
}

// POST /api/v1/breeding/start
func (h *BreedingHandler) StartBreeding(c *gin.Context) {
    var req StartBreedingRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }
    
    userID := c.GetString("user_id")
    req.UserID = userID
    
    slot, err := h.breedingService.StartBreeding(c.Request.Context(), req)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusOK, gin.H{
        "slot_id":   slot.ID,
        "end_time":  slot.EndTime,
        "status":    slot.Status,
    })
}

// GET /api/v1/breeding/slots
func (h *BreedingHandler) GetBreedingSlots(c *gin.Context) {
    userID := c.GetString("user_id")
    
    slots, err := h.breedingService.GetUserSlots(c.Request.Context(), userID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusOK, gin.H{"slots": slots})
}

// POST /api/v1/breeding/complete/:slotId
func (h *BreedingHandler) CompleteBreeding(c *gin.Context) {
    slotID := c.Param("slotId")
    
    egg, err := h.breedingService.CompleteBreeding(c.Request.Context(), slotID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusOK, gin.H{
        "egg_id":      egg.ID,
        "species_id":  egg.SpeciesID,
        "rarity":      egg.Rarity,
        "hatch_steps": egg.HatchSteps,
    })
}

// GET /api/v1/eggs
func (h *BreedingHandler) GetUserEggs(c *gin.Context) {
    userID := c.GetString("user_id")
    
    eggs, err := h.breedingService.GetUserEggs(c.Request.Context(), userID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusOK, gin.H{"eggs": eggs})
}

// POST /api/v1/eggs/:eggId/hatch
func (h *BreedingHandler) HatchEgg(c *gin.Context) {
    eggID := c.Param("eggId")
    
    pokemon, err := h.breedingService.HatchEgg(c.Request.Context(), eggID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusOK, gin.H{
        "pokemon_id": pokemon.ID,
        "species_id": pokemon.SpeciesID,
        "level":      pokemon.Level,
    })
}

// GET /api/v1/breeding/records
func (h *BreedingHandler) GetBreedingRecords(c *gin.Context) {
    userID := c.GetString("user_id")
    
    records, err := h.breedingService.GetBreedingRecords(c.Request.Context(), userID)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }
    
    c.JSON(http.StatusOK, gin.H{"records": records})
}
```

### 5. 培育道具系统

```go
// BreedingItem 培育道具
type BreedingItem struct {
    ID          string  `json:"id"`
    Name        string  `json:"name"`
    Type        string  `json:"type"`        // gene_boost, hatch_accel, rarity_boost
    Effect      string  `json:"effect"`      // 效果描述
    BoostRate   float64 `json:"boost_rate"`  // 提升比例
    Duration    int     `json:"duration"`    // 持续时间（分钟）
}

// 使用基因增强道具
func (s *BreedingService) ApplyGeneBoostItem(ctx context.Context, slotID, itemID string) error {
    // 1. 获取道具信息
    item, err := s.getItemInfo(itemID)
    if err != nil {
        return err
    }
    
    // 2. 获取培育槽
    var slot BreedingSlot
    if err := s.db.First(&slot, "id = ?", slotID).Error; err != nil {
        return err
    }
    
    // 3. 应用道具效果
    // 基因增强道具会提升后代的基因品质
    s.redis.Set(ctx, fmt.Sprintf("breeding:boost:%s", slotID), item.BoostRate, time.Duration(item.Duration)*time.Minute)
    
    return nil
}

// 使用孵化加速道具
func (s *BreedingService) ApplyHatchAccelerator(ctx context.Context, eggID, itemID string) error {
    item, _ := s.getItemInfo(itemID)
    
    var egg PokemonEgg
    s.db.First(&egg, "id = ?", eggID)
    
    // 减少孵化所需步数
    reducedSteps := int(float64(egg.HatchSteps) * item.BoostRate)
    egg.HatchSteps = max(1, egg.HatchSteps-reducedSteps)
    
    return s.db.Save(&egg).Error
}
```

### 6. 数据库迁移

```sql
-- 培育屋表
CREATE TABLE breeding_houses (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    slot_count INT DEFAULT 2,
    active_slots INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
);

-- 培育槽表
CREATE TABLE breeding_slots (
    id VARCHAR(36) PRIMARY KEY,
    house_id VARCHAR(36) NOT NULL,
    father_id VARCHAR(36) NOT NULL,
    mother_id VARCHAR(36) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    status ENUM('idle', 'breeding', 'ready') DEFAULT 'idle',
    result_egg_id VARCHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_house_id (house_id),
    INDEX idx_status (status)
);

-- 精灵基因表
CREATE TABLE pokemon_genes (
    id VARCHAR(36) PRIMARY KEY,
    pokemon_id VARCHAR(36) NOT NULL,
    gene_type ENUM('stats', 'skill', 'trait', 'color') NOT NULL,
    gene_key VARCHAR(50) NOT NULL,
    gene_value DECIMAL(10, 4) NOT NULL,
    dominance DECIMAL(3, 2) DEFAULT 0.5,
    heritability DECIMAL(3, 2) DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pokemon_id (pokemon_id),
    INDEX idx_gene_type (gene_type)
);

-- 精灵蛋表
CREATE TABLE pokemon_eggs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    father_id VARCHAR(36) NOT NULL,
    mother_id VARCHAR(36) NOT NULL,
    species_id VARCHAR(36) NOT NULL,
    gene_set JSON NOT NULL,
    rarity ENUM('normal', 'rare', 'epic', 'legendary') DEFAULT 'normal',
    hatch_steps INT NOT NULL,
    current_steps INT DEFAULT 0,
    status ENUM('unhatched', 'hatching', 'hatched') DEFAULT 'unhatched',
    hatched_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status)
);

-- 培育记录表
CREATE TABLE breeding_records (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    father_id VARCHAR(36) NOT NULL,
    mother_id VARCHAR(36) NOT NULL,
    result_egg_id VARCHAR(36) NOT NULL,
    hatched_pokemon_id VARCHAR(36),
    generation INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_father_id (father_id),
    INDEX idx_mother_id (mother_id)
);
```

## 验收标准

- [ ] 玩家可以放置两只精灵进入培育屋
- [ ] 培育完成后生成精灵蛋
- [ ] 精灵蛋通过步数累积完成孵化
- [ ] 后代精灵继承父母基因特征（属性、技能、特性）
- [ ] 基因遗传遵循概率规则（显性/隐性）
- [ ] 支持基因变异机制（小概率发生）
- [ ] 培育记录可追溯（血统追踪）
- [ ] 支持培育道具（基因增强、孵化加速）
- [ ] 培育时间根据精灵品质动态计算
- [ ] API 响应时间 < 200ms
- [ ] 单元测试覆盖率 > 80%
- [ ] 压测：支持 1000 并发培育请求

## 影响范围

- **新增服务**：pokemon-service/breeding 模块
- **数据库迁移**：新增 5 张表
- **新增 API**：6 个培育相关接口
- **事件系统**：培育开始、完成、孵化事件
- **奖励系统**：培育道具奖励
- **监控指标**：培育成功率、孵化时间、基因变异率

## 参考

- 宝可梦培育机制：https://bulbapedia.bulbagarden.net/wiki/Pokémon_breeding
- 基因遗传算法：Mendelian inheritance patterns
- 精灵个体值（IV）系统：https://www.serebii.net/games/ivs.shtml
