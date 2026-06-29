-- REQ-00370: 精灵训练营系统数据库迁移
-- 创建时间：2026-06-29 19:10 UTC

-- 训练营配置表
CREATE TABLE training_camps (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('experience', 'skill', 'friendship')),
    description TEXT,
    max_level INT DEFAULT 10,
    base_capacity INT DEFAULT 3,
    capacity_per_level INT DEFAULT 1,
    icon_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 训练课程配置表
CREATE TABLE training_courses (
    id SERIAL PRIMARY KEY,
    camp_id INT REFERENCES training_camps(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    duration_minutes INT NOT NULL,
    cost_type VARCHAR(50) CHECK (cost_type IN ('gold', 'stardust', 'premium', 'free')),
    cost_amount INT NOT NULL DEFAULT 0,
    exp_reward INT DEFAULT 0,
    exp_reward_per_level INT DEFAULT 0, -- 每级增加的经验
    skill_id INT, -- 可学习的技能ID
    friendship_reward INT DEFAULT 0,
    friendship_reward_per_level INT DEFAULT 0,
    required_camp_level INT DEFAULT 1,
    max_pokemon_level INT, -- 适用精灵等级上限
    min_pokemon_level INT DEFAULT 1,
    is_premium BOOLEAN DEFAULT FALSE,
    daily_limit INT DEFAULT 0, -- 0 表示无限制
    icon_url VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 玩家训练营等级表
CREATE TABLE user_training_camps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    camp_id INT REFERENCES training_camps(id),
    level INT DEFAULT 1,
    capacity INT DEFAULT 3,
    unlocked_at TIMESTAMP DEFAULT NOW(),
    upgraded_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, camp_id)
);

-- 训练队列表
CREATE TABLE training_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    camp_id INT NOT NULL REFERENCES training_camps(id),
    slot_index INT NOT NULL CHECK (slot_index >= 0 AND slot_index < 20),
    
    -- 训练的精灵
    pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    course_id INT NOT NULL REFERENCES training_courses(id),
    
    -- 训练状态
    status VARCHAR(20) NOT NULL DEFAULT 'training' CHECK (status IN ('training', 'completed', 'cancelled')),
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    
    -- 训练配置
    boost_used BOOLEAN DEFAULT FALSE, -- 是否使用加速
    boost_type VARCHAR(50), -- 加速类型
    boost_ends_at TIMESTAMP,
    
    -- 预计算奖励
    expected_exp INT NOT NULL DEFAULT 0,
    expected_friendship INT NOT NULL DEFAULT 0,
    expected_skill_id INT,
    
    -- 实际获得
    actual_exp INT DEFAULT 0,
    actual_friendship INT DEFAULT 0,
    skill_learned BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(user_id, camp_id, slot_index),
    CONSTRAINT valid_slot CHECK (slot_index < 
        (SELECT capacity FROM user_training_camps WHERE user_id = training_slots.user_id AND camp_id = training_slots.camp_id)
    )
);

-- 训练报告表
CREATE TABLE training_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_id UUID NOT NULL REFERENCES training_slots(id) ON DELETE CASCADE,
    pokemon_id UUID NOT NULL REFERENCES user_pokemon(id) ON DELETE CASCADE,
    
    -- 训练信息
    camp_type VARCHAR(50) NOT NULL,
    course_name VARCHAR(100) NOT NULL,
    duration_minutes INT NOT NULL,
    
    -- 收益
    exp_gained INT NOT NULL DEFAULT 0,
    friendship_gained INT NOT NULL DEFAULT 0,
    skill_learned_id INT,
    skill_learned_name VARCHAR(100),
    
    -- 资源消耗
    cost_type VARCHAR(50) NOT NULL,
    cost_amount INT NOT NULL DEFAULT 0,
    
    -- 评级
    rating VARCHAR(20) DEFAULT 'normal' CHECK (rating IN ('poor', 'normal', 'good', 'excellent')),
    
    completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 训练加速道具表
CREATE TABLE training_boosts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    boost_type VARCHAR(50) NOT NULL CHECK (boost_type IN ('time_50', 'time_75', 'instant', 'exp_double')),
    remaining_uses INT NOT NULL DEFAULT 1,
    expires_at TIMESTAMP,
    purchased_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_user_training_camps_user ON user_training_camps(user_id);
CREATE INDEX idx_training_slots_user ON training_slots(user_id);
CREATE INDEX idx_training_slots_status ON training_slots(status, ends_at);
CREATE INDEX idx_training_slots_pokemon ON training_slots(pokemon_id);
CREATE INDEX idx_training_reports_user ON training_reports(user_id, completed_at DESC);
CREATE INDEX idx_training_boosts_user ON training_boosts(user_id);

-- 插入默认训练营配置
INSERT INTO training_camps (name, type, description, max_level, base_capacity, capacity_per_level) VALUES
('经验训练营', 'experience', '专注于精灵经验值提升的训练营', 10, 3, 1),
('技能训练营', 'skill', '帮助精灵学习新技能的训练营', 10, 2, 1),
('亲密度训练营', 'friendship', '提升精灵与玩家亲密度关系的训练营', 10, 3, 1);

-- 插入默认训练课程
INSERT INTO training_courses (camp_id, name, description, duration_minutes, cost_type, cost_amount, exp_reward, exp_reward_per_level, friendship_reward, friendship_reward_per_level, required_camp_level) VALUES
-- 经验训练营课程
(1, '基础训练', '基础经验训练课程', 30, 'free', 0, 100, 20, 0, 0, 1),
(1, '进阶训练', '进阶经验训练课程，效果更好', 60, 'gold', 500, 300, 50, 0, 0, 2),
(1, '强化训练', '高强度经验训练', 120, 'gold', 1000, 800, 100, 0, 0, 3),
(1, '精英训练', '精英级经验训练', 180, 'stardust', 500, 2000, 200, 0, 0, 5),
(1, '大师训练', '大师级经验训练', 240, 'premium', 50, 5000, 500, 0, 0, 8),

-- 技能训练营课程
(2, '技能入门', '学习基础技能', 60, 'gold', 200, 0, 0, 0, 0, 1),
(2, '技能进阶', '学习进阶技能', 120, 'gold', 500, 0, 0, 0, 0, 2),
(2, '技能精通', '学习高级技能', 180, 'stardust', 300, 0, 0, 0, 0, 4),
(2, '技能大师', '学习大师技能', 240, 'premium', 100, 0, 0, 0, 0, 6),

-- 亲密度训练营课程
(3, '互动训练', '基础亲密度提升', 30, 'free', 0, 0, 0, 5, 1, 1),
(3, '陪伴训练', '中等亲密度提升', 60, 'gold', 300, 50, 10, 15, 3, 2),
(3, '深度陪伴', '高强度亲密度提升', 120, 'gold', 600, 100, 20, 30, 5, 3),
(3, '心灵契约', '大幅亲密度提升', 180, 'stardust', 400, 200, 30, 50, 8, 5),
(3, '永恒羁绊', '最高亲密度提升', 240, 'premium', 80, 500, 50, 100, 15, 8);

COMMENT ON TABLE training_camps IS '训练营类型配置';
COMMENT ON TABLE training_courses IS '训练课程配置';
COMMENT ON TABLE user_training_camps IS '玩家训练营等级和容量';
COMMENT ON TABLE training_slots IS '训练队列槽位';
COMMENT ON TABLE training_reports IS '训练完成报告';
COMMENT ON TABLE training_boosts IS '训练加速道具';