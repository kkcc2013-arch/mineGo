-- 公会系统数据库迁移
-- REQ-00058: 公会系统与团队社交功能

-- 公会主表
CREATE TABLE IF NOT EXISTS guilds (
    id SERIAL PRIMARY KEY,
    guild_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    badge_url VARCHAR(500),
    banner_url VARCHAR(500),
    
    -- 等级与经验
    level INTEGER DEFAULT 1,
    experience INTEGER DEFAULT 0,
    max_members INTEGER DEFAULT 50,
    
    -- 资源
    treasury INTEGER DEFAULT 0,
    total_contribution INTEGER DEFAULT 0,
    
    -- 加入设置
    join_type VARCHAR(20) DEFAULT 'apply' CHECK (join_type IN ('public', 'apply', 'invite_only')),
    min_level INTEGER DEFAULT 5,
    min_pokedex_count INTEGER DEFAULT 0,
    application_form TEXT,
    
    -- 公会增益
    active_buffs JSONB DEFAULT '{}',
    buffs_expires_at JSONB DEFAULT '{}',
    
    -- 状态
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'disbanded')),
    
    -- 统计数据
    total_battles_won INTEGER DEFAULT 0,
    total_raids_completed INTEGER DEFAULT 0,
    total_tasks_completed INTEGER DEFAULT 0,
    
    -- 时间戳
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    created_by UUID REFERENCES users(id),
    
    CONSTRAINT valid_guild_level CHECK (level >= 1 AND level <= 50)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS guild_key VARCHAR(50);
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS badge_url VARCHAR(500);
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS banner_url VARCHAR(500);
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS experience INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS max_members INTEGER DEFAULT 50;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS treasury INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_contribution INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS join_type VARCHAR(20) DEFAULT 'apply';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS min_level INTEGER DEFAULT 5;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS min_pokedex_count INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS application_form TEXT;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS active_buffs JSONB DEFAULT '{}';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS buffs_expires_at JSONB DEFAULT '{}';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_battles_won INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_raids_completed INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_tasks_completed INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS created_by UUID;

CREATE INDEX IF NOT EXISTS idx_guilds_key ON guilds(guild_key);
CREATE INDEX IF NOT EXISTS idx_guilds_status ON guilds(status);
CREATE INDEX IF NOT EXISTS idx_guilds_level ON guilds(level DESC);
CREATE INDEX IF NOT EXISTS idx_guilds_created ON guilds(created_at DESC);

-- 公会成员表
CREATE TABLE IF NOT EXISTS guild_members (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- 职位
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('leader', 'co_leader', 'elder', 'member', 'novice')),
    
    -- 贡献
    contribution INTEGER DEFAULT 0,
    weekly_contribution INTEGER DEFAULT 0,
    total_donated INTEGER DEFAULT 0,
    
    -- 统计
    battles_participated INTEGER DEFAULT 0,
    raids_participated INTEGER DEFAULT 0,
    tasks_completed INTEGER DEFAULT 0,
    
    -- 权限
    permissions JSONB DEFAULT '{}',
    
    -- 时间
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_contribution_at TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(guild_id, user_id),
    UNIQUE(user_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member';
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS contribution INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS weekly_contribution INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS total_donated INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS battles_participated INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS raids_participated INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS tasks_completed INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}';
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS last_contribution_at TIMESTAMP;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_user ON guild_members(user_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_role ON guild_members(guild_id, role);

-- 公会申请表
CREATE TABLE IF NOT EXISTS guild_applications (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    
    application_text TEXT,
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_note TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(guild_id, user_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS application_text TEXT;
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS reviewed_by UUID;
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE guild_applications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_applications_guild ON guild_applications(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_guild_applications_user ON guild_applications(user_id);

-- 公会邀请表
CREATE TABLE IF NOT EXISTS guild_invitations (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES users(id),
    invitee_id UUID NOT NULL REFERENCES users(id),
    
    invite_code VARCHAR(20) UNIQUE,
    
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    
    expires_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP,
    
    UNIQUE(guild_id, invitee_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS inviter_id UUID;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS invitee_id UUID;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS invite_code VARCHAR(20);
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_invitations_code ON guild_invitations(invite_code);
CREATE INDEX IF NOT EXISTS idx_guild_invitations_invitee ON guild_invitations(invitee_id, status);

-- 公会资金捐赠记录
CREATE TABLE IF NOT EXISTS guild_donations (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    donation_type VARCHAR(20) NOT NULL CHECK (donation_type IN ('coins', 'items', 'pokemon')),
    amount INTEGER NOT NULL,
    contribution_gained INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_donations ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_donations ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_donations ADD COLUMN IF NOT EXISTS donation_type VARCHAR(20);
ALTER TABLE guild_donations ADD COLUMN IF NOT EXISTS amount INTEGER;
ALTER TABLE guild_donations ADD COLUMN IF NOT EXISTS contribution_gained INTEGER DEFAULT 0;
ALTER TABLE guild_donations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_donations_guild ON guild_donations(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guild_donations_user ON guild_donations(user_id);

-- 公会任务表
CREATE TABLE IF NOT EXISTS guild_tasks (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    task_key VARCHAR(100) NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL,
    
    requirement JSONB NOT NULL,
    rewards JSONB NOT NULL,
    
    task_period VARCHAR(20) DEFAULT 'weekly' CHECK (task_period IN ('daily', 'weekly', 'monthly', 'special')),
    
    current_progress INTEGER DEFAULT 0,
    target_progress INTEGER NOT NULL,
    
    max_completions INTEGER DEFAULT 0,
    contribution_reward INTEGER DEFAULT 0,
    
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    
    is_completed BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(guild_id, task_key, task_period)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS task_key VARCHAR(100);
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS title VARCHAR(200);
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(50);
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS requirement JSONB;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS rewards JSONB;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS task_period VARCHAR(20) DEFAULT 'weekly';
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS current_progress INTEGER DEFAULT 0;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS target_progress INTEGER;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS max_completions INTEGER DEFAULT 0;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS contribution_reward INTEGER DEFAULT 0;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS starts_at TIMESTAMP;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS ends_at TIMESTAMP;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT FALSE;
ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_tasks_guild ON guild_tasks(guild_id, task_period);
CREATE INDEX IF NOT EXISTS idx_guild_tasks_active ON guild_tasks(guild_id, starts_at, ends_at) WHERE is_completed = FALSE;

-- 用户公会任务完成记录
CREATE TABLE IF NOT EXISTS user_guild_tasks (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES guild_tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    
    progress INTEGER DEFAULT 0,
    completed_count INTEGER DEFAULT 0,
    
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(task_id, user_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS task_id INTEGER;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS completed_count INTEGER DEFAULT 0;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_user_guild_tasks_task ON user_guild_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_user_guild_tasks_user ON user_guild_tasks(user_id);

-- 公会增益效果表
CREATE TABLE IF NOT EXISTS guild_buffs (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    buff_type VARCHAR(50) NOT NULL,
    
    buff_value DECIMAL(10, 2) NOT NULL,
    duration_hours INTEGER NOT NULL,
    
    activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    
    cost INTEGER NOT NULL,
    
    UNIQUE(guild_id, buff_type)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS buff_type VARCHAR(50);
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS buff_value DECIMAL(10, 2);
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS duration_hours INTEGER;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS cost INTEGER;

CREATE INDEX IF NOT EXISTS idx_guild_buffs_guild ON guild_buffs(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_buffs_active ON guild_buffs(guild_id, expires_at);  -- 谓词不能用 CURRENT_TIMESTAMP（非 IMMUTABLE）

-- 公会聊天消息表
CREATE TABLE IF NOT EXISTS guild_chat_messages (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'announcement')),
    content TEXT NOT NULL,
    
    metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_chat_guild ON guild_chat_messages(guild_id, created_at DESC);

-- 公会公告表
CREATE TABLE IF NOT EXISTS guild_announcements (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id),
    
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    
    is_pinned BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS author_id UUID;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS title VARCHAR(200);
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_announcements_guild ON guild_announcements(guild_id, is_pinned, created_at DESC);

-- 公会排行榜
CREATE TABLE IF NOT EXISTS guild_leaderboard (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER UNIQUE NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    
    leaderboard_type VARCHAR(20) NOT NULL DEFAULT 'global' CHECK (leaderboard_type IN ('global', 'regional', 'contribution', 'war')),
    
    score INTEGER DEFAULT 0,
    rank INTEGER,
    
    period VARCHAR(20) DEFAULT 'all_time' CHECK (period IN ('daily', 'weekly', 'monthly', 'all_time')),
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS leaderboard_type VARCHAR(20) DEFAULT 'global';
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS rank INTEGER;
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS period VARCHAR(20) DEFAULT 'all_time';
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_guild_leaderboard_rank ON guild_leaderboard(leaderboard_type, period, rank);
CREATE INDEX IF NOT EXISTS idx_guild_leaderboard_score ON guild_leaderboard(leaderboard_type, period, score DESC);

-- 添加用户表中的公会关联字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS guild_id INTEGER REFERENCES guilds(id) ON DELETE SET NULL;

-- 注释
COMMENT ON TABLE guilds IS '公会主表 - 存储公会基本信息';
COMMENT ON TABLE guild_members IS '公会成员表 - 存储成员信息和贡献';
COMMENT ON TABLE guild_applications IS '公会申请表 - 存储加入申请';
COMMENT ON TABLE guild_invitations IS '公会邀请表 - 存储邀请记录';
COMMENT ON TABLE guild_donations IS '公会捐赠记录表';
COMMENT ON TABLE guild_tasks IS '公会任务表 - 每日/每周任务';
COMMENT ON TABLE user_guild_tasks IS '用户公会任务进度表';
COMMENT ON TABLE guild_buffs IS '公会增益效果表';
COMMENT ON TABLE guild_chat_messages IS '公会聊天消息表';
COMMENT ON TABLE guild_announcements IS '公会公告表';
COMMENT ON TABLE guild_leaderboard IS '公会排行榜表';
