-- REQ-00059: 新手引导与教程系统
-- 数据库迁移：创建教程进度、新手任务、智能提示等表

-- 教程进度表
CREATE TABLE IF NOT EXISTS tutorial_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 教程步骤完成状态
    completed_steps JSONB DEFAULT '[]'::jsonb,
    current_step VARCHAR(50),
    
    -- 新手任务进度
    tutorial_tasks JSONB DEFAULT '{}'::jsonb,
    
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
    target_element VARCHAR(100),
    highlight_style JSONB DEFAULT '{}'::jsonb,
    position VARCHAR(20) DEFAULT 'bottom',
    
    -- 操作要求
    required_action VARCHAR(100),
    required_params JSONB DEFAULT '{}'::jsonb,
    
    -- 奖励
    rewards JSONB DEFAULT '{}'::jsonb,
    
    -- 流程控制
    next_step VARCHAR(50),
    prerequisite_steps JSONB DEFAULT '[]'::jsonb,
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
    prerequisite_tasks JSONB DEFAULT '[]'::jsonb,
    
    -- 显示配置
    display_order INTEGER DEFAULT 0,
    category VARCHAR(50) DEFAULT 'basic',
    
    -- 时间限制
    time_limit_hours INTEGER,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户新手任务完成记录
CREATE TABLE IF NOT EXISTS user_beginner_tasks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES beginner_tasks(id) ON DELETE CASCADE,
    
    progress INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_id, task_id)
);

-- 智能提示配置表
CREATE TABLE IF NOT EXISTS smart_tips (
    id SERIAL PRIMARY KEY,
    tip_key VARCHAR(100) UNIQUE NOT NULL,
    
    title VARCHAR(200),
    content TEXT NOT NULL,
    
    -- 触发条件
    trigger_type VARCHAR(50) NOT NULL,
    trigger_conditions JSONB NOT NULL,
    
    -- 显示配置
    display_type VARCHAR(20) DEFAULT 'tooltip',
    priority INTEGER DEFAULT 0,
    
    -- 限制
    max_displays INTEGER DEFAULT 3,
    cooldown_hours INTEGER DEFAULT 24,
    
    -- 过期条件
    dismiss_conditions JSONB DEFAULT '{}'::jsonb,
    
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户提示显示记录
CREATE TABLE IF NOT EXISTS user_tip_displays (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tip_id INTEGER NOT NULL REFERENCES smart_tips(id) ON DELETE CASCADE,
    
    display_count INTEGER DEFAULT 1,
    last_displayed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    dismissed BOOLEAN DEFAULT FALSE,
    
    UNIQUE(user_id, tip_id)
);

-- 功能解锁表
CREATE TABLE IF NOT EXISTS feature_unlocks (
    id SERIAL PRIMARY KEY,
    feature_key VARCHAR(100) UNIQUE NOT NULL,
    
    feature_name VARCHAR(200) NOT NULL,
    description TEXT,
    
    -- 解锁条件
    unlock_type VARCHAR(20) NOT NULL CHECK (unlock_type IN ('level', 'tutorial', 'quest', 'manual')),
    unlock_requirement JSONB NOT NULL,
    
    -- 解锁提示
    unlock_message TEXT,
    unlock_image VARCHAR(500),
    
    -- 相关教程步骤
    tutorial_step VARCHAR(50),
    
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户功能解锁记录
CREATE TABLE IF NOT EXISTS user_feature_unlocks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_id INTEGER NOT NULL REFERENCES feature_unlocks(id) ON DELETE CASCADE,
    
    unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    notification_shown BOOLEAN DEFAULT FALSE,
    
    UNIQUE(user_id, feature_id)
);

-- 帮助中心FAQ表
CREATE TABLE IF NOT EXISTS help_faq (
    id SERIAL PRIMARY KEY,
    category VARCHAR(100) NOT NULL,
    
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    
    -- 搜索优化
    keywords JSONB DEFAULT '[]'::jsonb,
    
    -- 统计
    view_count INTEGER DEFAULT 0,
    helpful_count INTEGER DEFAULT 0,
    not_helpful_count INTEGER DEFAULT 0,
    
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户帮助反馈表
CREATE TABLE IF NOT EXISTS help_feedback (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    faq_id INTEGER REFERENCES help_faq(id) ON DELETE CASCADE,
    
    was_helpful BOOLEAN,
    feedback_text TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 新手分析事件表
CREATE TABLE IF NOT EXISTS beginner_analytics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    event_type VARCHAR(50) NOT NULL,
    event_data JSONB DEFAULT '{}'::jsonb,
    
    -- 上下文
    tutorial_step VARCHAR(50),
    task_key VARCHAR(100),
    session_id VARCHAR(100),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tutorial_progress_user ON tutorial_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_tutorial_steps_order ON tutorial_steps(display_order);
CREATE INDEX IF NOT EXISTS idx_beginner_tasks_category ON beginner_tasks(category, display_order);
CREATE INDEX IF NOT EXISTS idx_user_beginner_tasks_user ON user_beginner_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_smart_tips_trigger ON smart_tips(trigger_type, is_active);
CREATE INDEX IF NOT EXISTS idx_user_tip_displays_user ON user_tip_displays(user_id);
CREATE INDEX IF NOT EXISTS idx_feature_unlocks_type ON feature_unlocks(unlock_type);
CREATE INDEX IF NOT EXISTS idx_user_feature_unlocks_user ON user_feature_unlocks(user_id);
CREATE INDEX IF NOT EXISTS idx_help_faq_category ON help_faq(category);
CREATE INDEX IF NOT EXISTS idx_beginner_analytics_user ON beginner_analytics(user_id, created_at);

-- 插入默认教程步骤
INSERT INTO tutorial_steps (step_key, title, description, step_type, target_element, position, required_action, rewards, next_step, can_skip, display_order) VALUES
('welcome', '欢迎来到 mineGo!', '开始你的精灵训练师之旅', 'dialogue', NULL, 'center', NULL, '{}'::jsonb, 'choose_starter', TRUE, 1),
('choose_starter', '选择你的初始精灵', '从三只初始精灵中选择一只作为你的伙伴', 'action_required', '.starter-selection', 'bottom', 'choose_starter', '{"coins": 100}'::jsonb, 'first_catch', FALSE, 2),
('first_catch', '捕捉你的第一只精灵', '在地图上找到精灵并尝试捕捉', 'action_required', '.catch-button', 'top', 'catch_pokemon', '{"pokeballs": 5}'::jsonb, 'visit_pokestop', TRUE, 3),
('visit_pokestop', '访问精灵站点', '访问附近的精灵站点获取补给', 'action_required', '.pokestop-marker', 'right', 'visit_pokestop', '{"potions": 5}'::jsonb, 'first_battle', TRUE, 4),
('first_battle', '你的第一场战斗', '挑战一个道馆，体验战斗系统', 'action_required', '.gym-marker', 'left', 'battle_gym', '{"coins": 200}'::jsonb, 'add_friend', TRUE, 5),
('add_friend', '添加好友', '添加好友可以互相帮助和交换精灵', 'action_required', '.add-friend-button', 'bottom', 'add_friend', '{"stardust": 500}'::jsonb, 'tutorial_complete', TRUE, 6),
('tutorial_complete', '恭喜完成新手教程!', '你已经准备好开始真正的冒险了', 'cutscene', NULL, 'center', NULL, '{"coins": 1000, "pokeballs": 20, "potions": 10, "revives": 5}'::jsonb, NULL, FALSE, 7)
ON CONFLICT (step_key) DO NOTHING;

-- 插入默认新手任务
INSERT INTO beginner_tasks (task_key, title, description, task_type, requirement, target_count, rewards, category, display_order) VALUES
('catch_first_pokemon', '捕捉第一只精灵', '捕捉你的第一只精灵', 'catch_pokemon', '{}'::jsonb, 1, '{"coins": 100, "xp": 500}'::jsonb, 'basic', 1),
('catch_10_pokemon', '精灵收藏家', '捕捉 10 只精灵', 'catch_pokemon', '{}'::jsonb, 10, '{"coins": 500, "pokeballs": 10}'::jsonb, 'basic', 2),
('visit_5_pokestops', '探索者', '访问 5 个精灵站点', 'visit_pokestop', '{}'::jsonb, 5, '{"potions": 10, "revives": 5}'::jsonb, 'basic', 3),
('win_first_battle', '初次胜利', '赢得第一场道馆战斗', 'win_battle', '{}'::jsonb, 1, '{"coins": 300, "xp": 1000}'::jsonb, 'basic', 4),
('add_first_friend', '社交达人', '添加你的第一个好友', 'add_friend', '{}'::jsonb, 1, '{"stardust": 1000}'::jsonb, 'social', 5),
('evolve_first_pokemon', '进化之路', '进化你的第一只精灵', 'evolve_pokemon', '{}'::jsonb, 1, '{"coins": 500, "candy": 50}'::jsonb, 'advanced', 6),
('reach_level_5', '训练师成长', '达到 5 级', 'reach_level', '{"level": 5}'::jsonb, 1, '{"coins": 1000, "incense": 1}'::jsonb, 'basic', 7),
('join_first_raid', '团队战斗', '参加你的第一次 Raid', 'join_raid', '{}'::jsonb, 1, '{"coins": 500, "rare_candy": 3}'::jsonb, 'advanced', 8)
ON CONFLICT (task_key) DO NOTHING;

-- 插入默认智能提示
INSERT INTO smart_tips (tip_key, title, content, trigger_type, trigger_conditions, display_type, priority, max_displays) VALUES
('backpack_full', '背包已满', '你的背包已满，建议清理一些不需要的物品', 'state', '{"backpackFull": true}'::jsonb, 'banner', 10, 3),
('low_pokeballs', '精灵球不足', '你的精灵球数量不足 5 个，建议访问精灵站点补充', 'state', '{"lowPokeballs": true}'::jsonb, 'tooltip', 8, 5),
('near_gym', '附近有道馆', '附近有一个道馆，快去挑战吧！', 'location', '{"nearGym": true}'::jsonb, 'tooltip', 5, 10),
('daily_bonus', '每日奖励', '别忘了领取你的每日奖励！', 'time', '{"timeRange": {"start": 0, "end": 12}}'::jsonb, 'banner', 7, 1)
ON CONFLICT (tip_key) DO NOTHING;

-- 插入默认功能解锁
INSERT INTO feature_unlocks (feature_key, feature_name, description, unlock_type, unlock_requirement, unlock_message, display_order) VALUES
('catch_pokemon', '捕捉精灵', '在野外捕捉精灵', 'tutorial', '{}'::jsonb, '你现在可以捕捉精灵了！', 1),
('visit_gym', '访问道馆', '挑战道馆获得奖励', 'tutorial', '{}'::jsonb, '你现在可以挑战道馆了！', 2),
('add_friend', '添加好友', '与其他玩家成为好友', 'tutorial', '{}'::jsonb, '你现在可以添加好友了！', 3),
('trade_pokemon', '交换精灵', '与好友交换精灵', 'level', '{"level": 10}'::jsonb, '达到 10 级后可以交换精灵', 4),
('join_raid', '参加 Raid', '参加团队战斗', 'level', '{"level": 20}'::jsonb, '达到 20 级后可以参加 Raid', 5)
ON CONFLICT (feature_key) DO NOTHING;

-- 插入默认 FAQ
INSERT INTO help_faq (category, question, answer, keywords, display_order) VALUES
('getting_started', '如何捕捉精灵？', '在地图上找到野生精灵，点击它开始捕捉。使用精灵球投掷，瞄准圆环越小捕捉率越高。', '["捕捉", "精灵球", "投掷"]'::jsonb, 1),
('getting_started', '如何获得精灵球？', '访问地图上的精灵站点（蓝色立方体）可以获得精灵球和其他物品。', '["精灵球", "补给", "精灵站点"]'::jsonb, 2),
('getting_started', '道馆战斗是什么？', '道馆是玩家可以争夺的地点。击败防守精灵可以占领道馆，获得每日奖励。', '["道馆", "战斗", "占领"]'::jsonb, 3),
('gameplay', '什么是属性克制？', '每种精灵都有属性（如火、水、草）。某些属性对其他属性有克制效果，伤害会增加或减少。', '["属性", "克制", "伤害"]'::jsonb, 4),
('gameplay', '如何进化精灵？', '收集足够的糖果后可以进化精灵。糖果通过捕捉同种精灵或与好友交换获得。', '["进化", "糖果", "捕捉"]'::jsonb, 5),
('social', '如何添加好友？', '在好友页面输入对方的训练师代码，或扫描对方的二维码即可添加好友。', '["好友", "添加", "二维码"]'::jsonb, 6),
('troubleshooting', 'GPS 定位不准确怎么办？', '请确保已授予应用位置权限，并在设置中启用高精度定位。避免在室内或信号差的地方游戏。', '["GPS", "定位", "权限"]'::jsonb, 7)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE tutorial_progress IS 'REQ-00059: 用户教程进度跟踪';
COMMENT ON TABLE tutorial_steps IS 'REQ-00059: 教程步骤定义';
COMMENT ON TABLE beginner_tasks IS 'REQ-00059: 新手任务定义';
COMMENT ON TABLE user_beginner_tasks IS 'REQ-00059: 用户新手任务完成记录';
COMMENT ON TABLE smart_tips IS 'REQ-00059: 智能提示配置';
COMMENT ON TABLE user_tip_displays IS 'REQ-00059: 用户提示显示记录';
COMMENT ON TABLE feature_unlocks IS 'REQ-00059: 功能解锁定义';
COMMENT ON TABLE user_feature_unlocks IS 'REQ-00059: 用户功能解锁记录';
COMMENT ON TABLE help_faq IS 'REQ-00059: 帮助中心FAQ';
COMMENT ON TABLE help_feedback IS 'REQ-00059: 用户帮助反馈';
COMMENT ON TABLE beginner_analytics IS 'REQ-00059: 新手分析事件';
