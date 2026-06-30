# REQ-00377: 精灵数据可见性控制与隐私分级系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00377 |
| 标题 | 精灵数据可见性控制与隐私分级系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、social-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-30 00:00 UTC |

## 需求描述

实现精灵数据的多级可见性控制系统，允许玩家自定义精灵信息的隐私等级，控制不同社交关系下的数据暴露程度。

### 核心功能
1. **精灵隐私等级**：公开(public)、好友可见(friends)、仅自己可见(private)、隐藏(hidden)
2. **属性可见性控制**：控制精灵的CP、技能、IV值、性格等属性是否显示给其他玩家
3. **社交关系分级**：基于好友亲密度/等级的差异化数据访问
4. **匿名展示模式**：战斗时隐藏精灵详细信息，只显示基本外观

### 业务价值
- 增强用户隐私控制感，提升信任度
- 防止精灵数据被用于不公平竞争分析
- 支持玩家间的"神秘对战"玩法

## 技术方案

### 1. 数据库设计
```sql
-- 精灵隐私配置表
CREATE TABLE pokemon_privacy_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    overall_visibility VARCHAR(20) NOT NULL DEFAULT 'friends',
    -- 属性可见性配置
    show_cp BOOLEAN DEFAULT true,
    show_skills BOOLEAN DEFAULT false,
    show_iv BOOLEAN DEFAULT false,
    show_nature BOOLEAN DEFAULT true,
    show_level BOOLEAN DEFAULT true,
    show_moves BOOLEAN DEFAULT false,
    -- 社交分级配置
    friend_level_threshold INTEGER DEFAULT 1, -- 哪级好友可看详细
    battle_anonymous BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, pokemon_id)
);

-- 用户隐私偏好默认配置
CREATE TABLE user_privacy_defaults (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) UNIQUE,
    default_pokemon_visibility VARCHAR(20) DEFAULT 'friends',
    default_show_cp BOOLEAN DEFAULT true,
    default_show_skills BOOLEAN DEFAULT false,
    default_show_iv BOOLEAN DEFAULT false,
    default_show_nature BOOLEAN DEFAULT true,
    default_battle_anonymous BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### 2. 后端 API 设计
```javascript
// pokemon-service 新增路由
router.get('/pokemon/:id/visibility', auth, async (req, res) => {
    const pokemon = await Pokemon.findById(req.params.id);
    const privacy = await PrivacySettings.findByPokemon(pokemon.id);
    const viewer = req.user;
    const relationship = await Friendship.getRelationship(pokemon.owner_id, viewer.id);
    
    // 根据隐私配置和社交关系计算可见内容
    const visibleData = applyVisibilityRules(pokemon, privacy, relationship);
    res.json(visibleData);
});

router.put('/pokemon/:id/privacy', auth, async (req, res) => {
    const settings = req.body;
    await PrivacySettings.update(req.params.id, req.user.id, settings);
    res.json({ success: true });
});

router.put('/user/privacy-defaults', auth, async (req, res) => {
    await UserPrivacyDefaults.update(req.user.id, req.body);
    res.json({ success: true });
});
```

### 3. 可见性规则引擎
```javascript
// backend/shared/VisibilityEngine.js
class VisibilityEngine {
    static applyRules(pokemon, privacy, viewerRelationship) {
        const result = {
            id: pokemon.id,
            species_id: pokemon.species_id,
            nickname: pokemon.nickname,
            appearance: pokemon.appearance_data
        };
        
        // 基础可见性判断
        const visibility = privacy.overall_visibility;
        
        if (visibility === 'public') {
            return this.applyFullVisibility(pokemon, privacy);
        }
        
        if (visibility === 'private' && viewerRelationship.isOwner) {
            return this.applyFullVisibility(pokemon, privacy);
        }
        
        if (visibility === 'friends' && viewerRelationship.isFriend) {
            // 根据好友等级过滤
            if (viewerRelationship.friendLevel >= privacy.friend_level_threshold) {
                return this.applyPartialVisibility(pokemon, privacy);
            }
            return this.applyBasicVisibility(pokemon);
        }
        
        // 默认返回基础信息
        return this.applyBasicVisibility(pokemon);
    }
    
    static applyFullVisibility(pokemon, privacy) {
        return {
            ...this.applyBasicVisibility(pokemon),
            cp: privacy.show_cp ? pokemon.cp : null,
            level: privacy.show_level ? pokemon.level : null,
            skills: privacy.show_skills ? pokemon.skills : null,
            iv: privacy.show_iv ? pokemon.iv : null,
            nature: privacy.show_nature ? pokemon.nature : null,
            moves: privacy.show_moves ? pokemon.moves : null
        };
    }
    
    static applyPartialVisibility(pokemon, privacy) {
        return {
            ...this.applyBasicVisibility(pokemon),
            cp: privacy.show_cp ? pokemon.cp : null,
            level: privacy.show_level ? pokemon.level : null,
            nature: privacy.show_nature ? pokemon.nature : null
            // IV和技能默认不显示给好友
        };
    }
    
    static applyBasicVisibility(pokemon) {
        return {
            id: pokemon.id,
            species_id: pokemon.species_id,
            nickname: pokemon.nickname,
            appearance: pokemon.appearance_data
        };
    }
}
```

### 4. 战斗匿名模式
```javascript
// gym-service/battle 匿名战斗支持
async function createAnonymousBattle(attackerPokemon, defenderPokemon) {
    // 获取隐私配置
    const attackerPrivacy = await PrivacySettings.get(attackerPokemon.id);
    const defenderPrivacy = await PrivacySettings.get(defenderPokemon.id);
    
    // 如果任一方设置匿名模式，隐藏详细信息
    const battleInfo = {
        attacker: {
            id: attackerPokemon.id,
            species_id: attackerPokemon.species_id,
            appearance_only: attackerPrivacy.battle_anonymous
        },
        defender: {
            id: defenderPokemon.id,
            species_id: defenderPokemon.species_id,
            appearance_only: defenderPrivacy.battle_anonymous
        }
    };
    
    // 战斗计算使用完整数据，但展示只显示外观
    return {
        battleInfo,
        fullDataForCalculation: {
            attacker: attackerPokemon,
            defender: defenderPokemon
        }
    };
}
```

### 5. 前端 UI 组件
```javascript
// game-client/src/components/PokemonPrivacySettings.vue
<template>
    <div class="privacy-settings">
        <h3>精灵隐私设置</h3>
        <div class="visibility-level">
            <label>整体可见性</label>
            <select v-model="settings.overall_visibility">
                <option value="public">公开 - 所有玩家可见</option>
                <option value="friends">好友可见</option>
                <option value="private">仅自己可见</option>
                <option value="hidden">完全隐藏</option>
            </select>
        </div>
        
        <div class="attribute-controls">
            <label>属性可见性</label>
            <div class="toggle-group">
                <toggle v-model="settings.show_cp">CP值</toggle>
                <toggle v-model="settings.show_level">等级</toggle>
                <toggle v-model="settings.show_skills">技能</toggle>
                <toggle v-model="settings.show_iv">IV值</toggle>
                <toggle v-model="settings.show_nature">性格</toggle>
            </div>
        </div>
        
        <div class="friend-level-control">
            <label>好友等级阈值</label>
            <input type="number" v-model="settings.friend_level_threshold" min="1" max="5">
            <span class="hint">达到此等级的好友可查看详细属性</span>
        </div>
        
        <div class="battle-anonymous">
            <toggle v-model="settings.battle_anonymous">
                战斗匿名模式
            </toggle>
            <span class="hint">战斗时隐藏精灵详细信息</span>
        </div>
    </div>
</template>
```

### 6. 批量隐私设置
```javascript
// 支持批量设置多个精灵的隐私
router.post('/pokemon/privacy/batch', auth, async (req, res) => {
    const { pokemon_ids, settings } = req.body;
    
    // 验证所有权
    const ownedPokemon = await Pokemon.findOwned(req.user.id, pokemon_ids);
    if (ownedPokemon.length !== pokemon_ids.length) {
        return res.status(400).json({ error: '部分精灵不属于当前用户' });
    }
    
    // 批量更新
    await PrivacySettings.batchUpdate(pokemon_ids, req.user.id, settings);
    res.json({ 
        success: true,
        updated_count: pokemon_ids.length
    });
});
```

## 验收标准

- [ ] 精灵隐私设置表创建完成，支持整体可见性和属性级控制
- [ ] 可见性规则引擎实现，支持 4 种隐私等级
- [ ] 前端隐私设置 UI 完成设计，包含属性切换控件
- [ ] 好友等级阈值配置生效，差异化数据访问正确
- [ ] 战斗匿名模式支持，隐藏详细属性但保持战斗公平
- [ ] 批量隐私设置 API 可用，支持一键设置多个精灵
- [ ] 用户默认隐私配置可持久化，新精灵继承默认设置
- [ ] API 响应不泄露用户未授权查看的数据
- [ ] 集成测试覆盖隐私边界场景（好友/陌生人/自己）
- [ ] 性能测试验证可见性计算不影响响应时间（<50ms）

## 影响范围

- **数据库**：新增 pokemon_privacy_settings、user_privacy_defaults 表
- **pokemon-service**：新增隐私配置路由和可见性规则引擎
- **social-service**：提供好友关系等级查询接口
- **gym-service**：战斗匿名模式支持
- **gateway**：隐私中间件，验证数据访问权限
- **game-client**：隐私设置 UI 和数据展示过滤

## 参考

- GDPR 数据最小化原则
- Pokemon GO 隐私设计参考
- REQ-00228 游戏社交隐私设置与好友权限管理系统（已有基础）