-- =====================================================
-- REQ-00054: 道馆战斗系统数据库迁移
-- 创建时间: 2026-06-09 16:00
-- 说明: 实现完整的道馆战斗系统，包括战斗记录、回放、状态效果等
-- =====================================================

-- 兼容补丁: 现有 gym_battles 表使用 attacker_id 而非 attacker_user_id
-- Add attacker_user_id as an alias column for index compatibility
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS attacker_user_id UUID;
UPDATE gym_battles SET attacker_user_id = attacker_id WHERE attacker_user_id IS NULL;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS turns_played INTEGER DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS prestige_gained INTEGER DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS experience_gained INTEGER DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS coins_gained INTEGER DEFAULT 0;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS battle_duration_ms INTEGER;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE gym_battles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE gym_battles SET created_at = battled_at WHERE created_at IS NULL AND battled_at IS NOT NULL;

-- 道馆战斗记录表
CREATE TABLE IF NOT EXISTS gym_battles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    attacker_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attacker_team UUID[] NOT NULL, -- 参战精灵ID列表
    defender_pokemon_id UUID REFERENCES pokemon_instances(id) ON DELETE SET NULL,
    result TEXT NOT NULL CHECK (result IN ('win', 'lose', 'retreat')),
    prestige_gained INTEGER DEFAULT 0,
    experience_gained INTEGER DEFAULT 0,
    coins_gained INTEGER DEFAULT 0,
    battle_duration_ms INTEGER,
    turns_played INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- 战斗回放表
CREATE TABLE IF NOT EXISTS battle_replays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID NOT NULL REFERENCES gym_battles(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    attacker_pokemon_id UUID,
    defender_pokemon_id UUID,
    move_id VARCHAR(32) REFERENCES moves(id),
    damage_dealt INTEGER DEFAULT 0,
    damage_taken INTEGER DEFAULT 0,
    status_effects JSONB DEFAULT '{}',
    action_log JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 状态效果表
CREATE TABLE IF NOT EXISTS status_effects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    effect_type TEXT NOT NULL CHECK (effect_type IN ('burn', 'paralyze', 'freeze', 'poison', 'toxic', 'sleep', 'confusion')),
    damage_per_turn INTEGER DEFAULT 0,
    action_chance REAL DEFAULT 1.0,
    duration_turns INTEGER,
    stat_modifier JSONB DEFAULT '{}',
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 战斗队伍预设表
CREATE TABLE IF NOT EXISTS battle_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    pokemon_ids UUID[] NOT NULL CHECK (array_length(pokemon_ids, 1) <= 6),
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, name)
);

-- 精灵战斗统计表
CREATE TABLE IF NOT EXISTS pokemon_battle_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    battles_won INTEGER DEFAULT 0,
    battles_lost INTEGER DEFAULT 0,
    total_damage_dealt BIGINT DEFAULT 0,
    total_damage_taken BIGINT DEFAULT 0,
    ko_count INTEGER DEFAULT 0,
    fainted_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pokemon_id)
);

-- 插入状态效果数据
INSERT INTO status_effects (name, effect_type, damage_per_turn, action_chance, duration_turns, stat_modifier, description) VALUES
('灼伤', 'burn', 0, 1.0, NULL, '{"attack": 0.5}', '灼伤状态，每回合损失 1/8 HP，物理攻击降低 50%'),
('麻痹', 'paralyze', 0, 0.75, NULL, '{"speed": 0.5}', '麻痹状态，速度降低 50%，有 25% 概率无法行动'),
('冰冻', 'freeze', 0, 0.2, NULL, '{}', '冰冻状态，有 80% 概率无法行动，被火属性技能攻击后解除'),
('中毒', 'poison', 0, 1.0, NULL, '{}', '中毒状态，每回合损失 1/8 HP'),
('剧毒', 'toxic', 0, 1.0, NULL, '{}', '剧毒状态，每回合损失递增 HP（n/16）'),
('睡眠', 'sleep', 0, 0.0, 2, '{}', '睡眠状态，无法行动 1-3 回合后自动醒来'),
('混乱', 'confusion', 0, 0.67, 3, '{}', '混乱状态，有 33% 概率攻击自己')
ON CONFLICT (name) DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_gym_battles_gym_id ON gym_battles(gym_id);
CREATE INDEX IF NOT EXISTS idx_gym_battles_attacker ON gym_battles(attacker_user_id);
CREATE INDEX IF NOT EXISTS idx_gym_battles_created ON gym_battles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gym_battles_result ON gym_battles(result);
CREATE INDEX IF NOT EXISTS idx_battle_replays_battle ON battle_replays(battle_id);
CREATE INDEX IF NOT EXISTS idx_battle_replays_turn ON battle_replays(battle_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_battle_teams_user ON battle_teams(user_id);
CREATE INDEX IF NOT EXISTS idx_battle_teams_default ON battle_teams(user_id, is_default) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS idx_pokemon_battle_stats ON pokemon_battle_stats(pokemon_id);

-- 更新 gym_defenders 表添加战斗相关字段 (gym_pokemon -> gym_defenders)
ALTER TABLE gym_defenders
ADD COLUMN IF NOT EXISTS battles_defended INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS berries_earned INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_fed_at TIMESTAMPTZ;

-- 添加注释
COMMENT ON TABLE gym_battles IS '道馆战斗记录表';
COMMENT ON TABLE battle_replays IS '战斗回放表，记录每回合的详细信息';
COMMENT ON TABLE status_effects IS '状态效果定义表';
COMMENT ON TABLE battle_teams IS '玩家战斗队伍预设表';
COMMENT ON TABLE pokemon_battle_stats IS '精灵战斗统计表';
