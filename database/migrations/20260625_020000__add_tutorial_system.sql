-- REQ-00059: 新手引导与教程系统
-- 数据库迁移脚本

-- 教程进度表
CREATE TABLE IF NOT EXISTS tutorial_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 教程步骤完成状态
    completed_steps JSONB DEFAULT '[]',
    current_step VARCHAR(50),
    
    -- 新手任务进度
    tutorial_tasks JSONB DEFAULT '{}',
    
    -- 跳过状态
    skipped BOOLEAN DEFAULT FALSE,
    skipped_at TIMESTAMP,
    
    -- 时间统计
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    total_time_seconds INTEGER DEFAULT 0,
    
    -- 标记
    is_first_time_player BOOLEAN DEFAULT TRUE,
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 教程步骤定义表
CREATE TABLE IF NOT EXISTS tutorial_steps (
    id SERIAL PRIMARY KEY,
    step_key VARCHAR(50) UNIQUE NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    
    -- 步骤类型
    step_type VARCHAR(20) NOT NULL CHECK (step_type IN ('instruction', 'action_required', 'dialogue', 'cutscene')),
    
    -- 引导配置
    target_element VARCHAR(100), -- CSS选择器
    highlight_style JSONB DEFAULT '{}',
    position VARCHAR(20) DEFAULT 'bottom', -- tooltip位置
    
    -- 操作要求
    required_action VARCHAR(100), -- 'catch_pokemon', 'visit_gym', etc.
    required_params JSONB DEFAULT '{}',
    
    -- 奖励
    rewards JSONB DEFAULT '{}',
    
    -- 流程控制
    next_step VARCHAR(50),
    prerequisite_steps JSONB DEFAULT '[]',
    can_skip BOOLEAN DEFAULT TRUE,
    
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 新手任务表
CREATE TABLE IF NOT EXISTS beginner_tasks (
    id SERIAL PRIMARY KEY,
    task_key VARCHAR(100) UNIQUE NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    
    -- 任务类型
    task_type VARCHAR(50) NOT NULL,
    
    -- 要求
    requirement JSONB NOT NULL,
    target_count INTEGER DEFAULT 1,
    
    -- 奖励
    rewards JSONB NOT NULL,
    
    -- 依赖关系
    prerequisite_tasks JSONB DEFAULT '[]',
    
    -- 显示配置
    display_order INTEGER DEFAULT 0,
    category VARCHAR(50) DEFAULT 'basic', -- 'basic', 'advanced', 'social'
    
    -- 时间限制（可选）
    time_limit_hours INTEGER,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 智能提示表
CREATE TABLE IF NOT EXISTS smart_hints (
    id SERIAL PRIMARY KEY,
    hint_key VARCHAR(100) UNIQUE NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    
    -- 触发条件
    trigger_condition JSONB NOT NULL, -- {'level': '<5', 'bag_full': true, ...}
    priority INTEGER DEFAULT 0,
    
    -- 显示配置
    display_type VARCHAR(20) DEFAULT 'tooltip', -- 'tooltip', 'modal', 'banner'
    icon VARCHAR(50),
    
    -- 操作
    action_url VARCHAR(200),
    action_text VARCHAR(100),
    
    -- 频率控制
    max_displays INTEGER DEFAULT 3,
    cooldown_hours INTEGER DEFAULT 24,
    
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 教程分析表
CREATE TABLE IF NOT EXISTS tutorial_analytics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 步骤信息
    step_key VARCHAR(50) NOT NULL,
    action VARCHAR(50) NOT NULL, -- 'started', 'completed', 'skipped', 'failed'
    
    -- 时间数据
    time_spent_seconds INTEGER,
    
    -- 上下文
    context JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tutorial_progress_user ON tutorial_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_tutorial_steps_key ON tutorial_steps(step_key);
CREATE INDEX IF NOT EXISTS idx_tutorial_steps_order ON tutorial_steps(display_order);
CREATE INDEX IF NOT EXISTS idx_beginner_tasks_key ON beginner_tasks(task_key);
CREATE INDEX IF NOT EXISTS idx_beginner_tasks_category ON beginner_tasks(category, display_order);
CREATE INDEX IF NOT EXISTS idx_smart_hints_key ON smart_hints(hint_key);
CREATE INDEX IF NOT EXISTS idx_tutorial_analytics_user ON tutorial_analytics(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tutorial_analytics_step ON tutorial_analytics(step_key, action);

-- 插入默认教程步骤
INSERT INTO tutorial_steps (step_key, title, description, step_type, target_element, position, required_action, rewards, next_step, display_order, can_skip) VALUES
('welcome', '欢迎来到 mineGo!', '开始你的精灵训练师之旅', 'dialogue', NULL, 'center', NULL, '{}', 'choose_starter', 1, TRUE),
('choose_starter', '选择你的初始精灵', '从三只初始精灵中选择一只作为你的伙伴', 'action_required', '.starter-selection', 'top', 'choose_starter', '{"coins": 100}', 'first_catch', 2, FALSE),
('first_catch', '捕捉你的第一只精灵', '在地图上找到精灵并尝试捕捉', 'action_required', '.catch-button', 'top', 'catch_pokemon', '{"pokeballs": 5}', 'visit_pokestop', 3, FALSE),
('visit_pokestop', '访问精灵站点', '访问附近的精灵站点获取补给', 'action_required', '.pokestop-marker', 'top', 'visit_pokestop', '{"potions": 5}', 'first_battle', 4, TRUE),
('first_battle', '你的第一场战斗', '挑战一个道馆，体验战斗系统', 'action_required', '.gym-marker', 'top', 'battle_gym', '{"coins": 200}', 'add_friend', 5, TRUE),
('add_friend', '添加好友', '添加好友可以互相帮助和交换精灵', 'action_required', '.friends-button', 'bottom', 'add_friend', '{"coins": 100}', 'tutorial_complete', 6, TRUE),
('tutorial_complete', '教程完成', '恭喜！你已经了解了游戏的基本操作', 'dialogue', NULL, 'center', NULL, '{"coins": 500, "pokeballs": 10, "potions": 10}', NULL, 7, FALSE)
ON CONFLICT (step_key) DO NOTHING;

-- 插入新手任务
INSERT INTO beginner_tasks (task_key, title, description, task_type, requirement, target_count, rewards, prerequisite_tasks, display_order, category) VALUES
-- 基础任务
('catch_first_pokemon', '捕捉第一只精灵', '在地图上找到并捕捉一只精灵', 'catch', '{"action": "catch_pokemon"}', 1, '{"coins": 100, "pokeballs": 5}', '[]', 1, 'basic'),
('catch_5_pokemon', '精灵收集者', '捕捉 5 只精灵', 'catch', '{"action": "catch_pokemon"}', 5, '{"coins": 200, "pokeballs": 10}', '["catch_first_pokemon"]', 2, 'basic'),
('visit_pokestop', '补给站', '访问一个精灵站点', 'explore', '{"action": "visit_pokestop"}', 1, '{"potions": 5, "pokeballs": 5}', '[]', 3, 'basic'),
('visit_5_pokestops', '探索者', '访问 5 个精灵站点', 'explore', '{"action": "visit_pokestop"}', 5, '{"coins": 300, "potions": 10}', '["visit_pokestop"]', 4, 'basic'),
('win_first_battle', '初次胜利', '在道馆战斗中获胜', 'battle', '{"action": "win_battle"}', 1, '{"coins": 300, "stardust": 500}', '["catch_first_pokemon"]', 5, 'basic'),
('win_3_battles', '战斗新星', '赢得 3 场战斗', 'battle', '{"action": "win_battle"}', 3, '{"coins": 500, "stardust": 1000}', '["win_first_battle"]', 6, 'basic'),

-- 高级任务
('evolve_pokemon', '进化大师', '进化一只精灵', 'evolution', '{"action": "evolve_pokemon"}', 1, '{"coins": 500, "candy": 10}', '["catch_5_pokemon"]', 7, 'advanced'),
('power_up_pokemon', '强化训练', '强化一只精灵', 'powerup', '{"action": "power_up"}', 1, '{"coins": 200}', '["catch_5_pokemon"]', 8, 'advanced'),
('catch_10_pokemon', '精灵大师', '捕捉 10 只精灵', 'catch', '{"action": "catch_pokemon"}', 10, '{"coins": 500, "stardust": 1000, "incubator": 1}', '["catch_5_pokemon"]', 9, 'advanced'),
('win_gym_battle', '道馆挑战者', '赢得一场道馆战斗', 'battle', '{"action": "win_gym_battle"}', 1, '{"coins": 500, "stardust": 1000}', '["win_3_battles"]', 10, 'advanced'),

-- 社交任务
('add_friend', '交友达人', '添加一位好友', 'social', '{"action": "add_friend"}', 1, '{"coins": 100}', '[]', 11, 'social'),
('send_gift', '礼物使者', '给好友发送一份礼物', 'social', '{"action": "send_gift"}', 1, '{"coins": 100, "stardust": 200}', '["add_friend"]', 12, 'social'),
('trade_pokemon', '交易大师', '与好友交换一只精灵', 'social', '{"action": "trade_pokemon"}', 1, '{"coins": 300, "candy": 5}', '["add_friend", "catch_5_pokemon"]', 13, 'social'),
('join_guild', '公会成员', '加入一个公会', 'social', '{"action": "join_guild"}', 1, '{"coins": 500}', '["add_friend"]', 14, 'social')
ON CONFLICT (task_key) DO NOTHING;

-- 插入智能提示
INSERT INTO smart_hints (hint_key, title, message, trigger_condition, priority, display_type, icon, action_url, action_text, max_displays, cooldown_hours) VALUES
('bag_full', '背包已满', '你的背包已满，请清理不需要的物品', '{"bag_full": true}', 10, 'modal', 'bag', '/bag', '打开背包', 5, 24),
('low_pokeballs', '精灵球不足', '你的精灵球数量不足，访问精灵站点补充', '{"pokeballs": "<10"}', 8, 'banner', 'pokeball', '/map', '查看地图', 3, 48),
('pokemon_hurt', '精灵受伤', '你的精灵需要治疗，使用药水恢复HP', '{"pokemon_hurt": true}', 9, 'tooltip', 'heart', '/pokemon', '查看精灵', 5, 24),
('nearby_rare', '稀有精灵', '附近出现了稀有精灵！', '{"nearby_rare": true}', 10, 'banner', 'star', '/map', '前往捕捉', 3, 1),
('evolution_ready', '可以进化', '你的精灵已经满足进化条件！', '{"evolution_ready": true}', 7, 'tooltip', 'evolve', '/pokemon', '查看精灵', 5, 48),
('daily_task_available', '每日任务', '你有未完成的每日任务，完成任务获得奖励！', '{"daily_task_available": true}', 5, 'banner', 'task', '/tasks', '查看任务', 10, 6),
('friend_gift', '好友礼物', '你有好友送来的礼物待领取', '{"friend_gift_available": true}', 6, 'tooltip', 'gift', '/friends', '查看好友', 10, 24),
('level_up_reward', '升级奖励', '你升级了！领取你的奖励', '{"level_up": true}', 10, 'modal', 'level', '/rewards', '领取奖励', 1, 1)
ON CONFLICT (hint_key) DO NOTHING;

-- 创建视图：教程完成率统计
CREATE OR REPLACE VIEW tutorial_completion_stats AS
SELECT 
    step_key,
    COUNT(CASE WHEN action = 'started' THEN 1 END) as started_count,
    COUNT(CASE WHEN action = 'completed' THEN 1 END) as completed_count,
    COUNT(CASE WHEN action = 'skipped' THEN 1 END) as skipped_count,
    ROUND(
        COUNT(CASE WHEN action = 'completed' THEN 1 END)::DECIMAL / 
        NULLIF(COUNT(CASE WHEN action = 'started' THEN 1 END), 0) * 100, 
        2
    ) as completion_rate,
    AVG(CASE WHEN action = 'completed' THEN time_spent_seconds END) as avg_time_seconds
FROM tutorial_analytics
GROUP BY step_key
ORDER BY (SELECT display_order FROM tutorial_steps WHERE step_key = tutorial_analytics.step_key);

-- 创建视图：新手任务完成情况
CREATE OR REPLACE VIEW beginner_task_completion_stats AS
SELECT 
    task_key,
    title,
    category,
    COUNT(DISTINCT tp.user_id) as users_in_progress,
    COUNT(CASE WHEN tp.tutorial_tasks->task_key->>'status' = 'completed' THEN 1 END) as completed_count
FROM beginner_tasks bt
LEFT JOIN tutorial_progress tp ON tp.tutorial_tasks ? bt.task_key
GROUP BY bt.id, bt.task_key, bt.title, bt.category
ORDER BY bt.category, bt.display_order;

-- 注释
COMMENT ON TABLE tutorial_progress IS 'REQ-00059: 教程进度跟踪表';
COMMENT ON TABLE tutorial_steps IS 'REQ-00059: 教程步骤定义表';
COMMENT ON TABLE beginner_tasks IS 'REQ-00059: 新手任务定义表';
COMMENT ON TABLE smart_hints IS 'REQ-00059: 智能提示配置表';
COMMENT ON TABLE tutorial_analytics IS 'REQ-00059: 教程数据分析表';

-- 更新触发器
CREATE OR REPLACE FUNCTION update_tutorial_progress_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_tutorial_progress_updated_at ON tutorial_progress;
CREATE TRIGGER trigger_update_tutorial_progress_updated_at
    BEFORE UPDATE ON tutorial_progress
    FOR EACH ROW
    EXECUTE FUNCTION update_tutorial_progress_updated_at();
