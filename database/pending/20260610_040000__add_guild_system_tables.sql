-- ============================================================
-- REQ-00058: 公会系统与团队社交功能
-- 数据库迁移：创建公会相关的所有表结构
-- ============================================================

-- 公会主表
CREATE TABLE IF NOT EXISTS guilds (
    id SERIAL PRIMARY KEY,
    guild_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    badge_url VARCHAR(500),
    banner_url VARCHAR(500),
    
    -- 等级与经验
    level INTEGER DEFAULT 1 CHECK (level >= 1 AND level <= 50),
    experience INTEGER DEFAULT 0,
    max_members INTEGER DEFAULT 50,
    
    -- 资源
    treasury INTEGER DEFAULT 0, -- 公会资金（金币）
    total_contribution INTEGER DEFAULT 0, -- 总贡献值
    
    -- 加入设置
    join_type VARCHAR(20) DEFAULT 'apply' CHECK (join_type IN ('public', 'apply', 'invite_only')),
    min_level INTEGER DEFAULT 5,
    min_pokedex_count INTEGER DEFAULT 0,
    application_form TEXT,
    invite_code VARCHAR(20) UNIQUE,
    
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
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
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
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS invite_code VARCHAR(20);
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
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guilds') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_key', 'name', 'description', 'badge_url', 'banner_url', 'level', 'experience', 'max_members', 'treasury', 'total_contribution', 'join_type', 'min_level', 'min_pokedex_count', 'application_form', 'invite_code', 'active_buffs', 'buffs_expires_at', 'status', 'total_battles_won', 'total_raids_completed', 'total_tasks_completed', 'created_at', 'updated_at', 'last_active_at', 'created_by', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guilds ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
    
    CONSTRAINT unique_guild_member UNIQUE (guild_id, user_id),
    CONSTRAINT one_guild_per_user EXCLUDE (user_id WITH =) WHERE (role != 'novice')
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
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_members') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'user_id', 'role', 'contribution', 'weekly_contribution', 'total_donated', 'battles_participated', 'raids_participated', 'tasks_completed', 'permissions', 'joined_at', 'last_contribution_at', 'last_active_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_members ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 为 one_guild_per_user 约束创建唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_members_user_unique ON guild_members(user_id) 
    WHERE role != 'novice';

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
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_applications') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'user_id', 'status', 'application_text', 'reviewed_by', 'reviewed_at', 'review_note', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_applications ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;
CREATE UNIQUE INDEX IF NOT EXISTS unique_pending_application ON guild_applications (guild_id, user_id) WHERE (status = 'pending');

-- 公会邀请表
CREATE TABLE IF NOT EXISTS guild_invitations (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES users(id),
    invitee_id UUID NOT NULL REFERENCES users(id),
    
    invite_code VARCHAR(20) UNIQUE,
    
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
    
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    responded_at TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS inviter_id UUID;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS invitee_id UUID;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS invite_code VARCHAR(20);
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days');
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_invitations ADD COLUMN IF NOT EXISTS responded_at TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_invitations') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'inviter_id', 'invitee_id', 'invite_code', 'status', 'expires_at', 'created_at', 'responded_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_invitations ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;
CREATE UNIQUE INDEX IF NOT EXISTS unique_pending_invitation ON guild_invitations (guild_id, invitee_id) WHERE (status = 'pending');

-- 公会仓库表（共享道具）
CREATE TABLE IF NOT EXISTS guild_warehouse (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    item_type VARCHAR(50) NOT NULL,
    item_data JSONB NOT NULL,
    quantity INTEGER DEFAULT 1,
    
    donated_by UUID REFERENCES users(id),
    donated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS item_type VARCHAR(50);
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS item_data JSONB;
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS donated_by UUID;
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS donated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_warehouse ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_warehouse') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'item_type', 'item_data', 'quantity', 'donated_by', 'donated_at', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_warehouse ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会仓库领取记录
CREATE TABLE IF NOT EXISTS guild_warehouse_claims (
    id SERIAL PRIMARY KEY,
    warehouse_item_id INTEGER NOT NULL REFERENCES guild_warehouse(id) ON DELETE CASCADE,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    quantity INTEGER DEFAULT 1,
    
    claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_warehouse_claims ADD COLUMN IF NOT EXISTS warehouse_item_id INTEGER;
ALTER TABLE guild_warehouse_claims ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_warehouse_claims ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_warehouse_claims ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE guild_warehouse_claims ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_warehouse_claims') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('warehouse_item_id', 'guild_id', 'user_id', 'quantity', 'claimed_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_warehouse_claims ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

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
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_donations') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'user_id', 'donation_type', 'amount', 'contribution_gained', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_donations ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会任务表
CREATE TABLE IF NOT EXISTS guild_tasks (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    task_key VARCHAR(100) NOT NULL,
    
    title VARCHAR(200) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'donate', 'raid'
    
    requirement JSONB NOT NULL,
    rewards JSONB NOT NULL,
    
    -- 任务周期
    task_period VARCHAR(20) DEFAULT 'weekly' CHECK (task_period IN ('daily', 'weekly', 'monthly', 'special')),
    
    -- 进度
    current_progress INTEGER DEFAULT 0,
    target_progress INTEGER NOT NULL,
    
    -- 限制
    max_completions INTEGER DEFAULT 0, -- 0 = 无限
    contribution_reward INTEGER DEFAULT 0,
    
    -- 时间
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    
    is_completed BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_guild_task UNIQUE (guild_id, task_key, task_period)
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
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_tasks') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'task_key', 'title', 'description', 'task_type', 'requirement', 'rewards', 'task_period', 'current_progress', 'target_progress', 'max_completions', 'contribution_reward', 'starts_at', 'ends_at', 'is_completed', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_tasks ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 用户公会任务完成记录
CREATE TABLE IF NOT EXISTS user_guild_tasks (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES guild_tasks(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    
    progress INTEGER DEFAULT 0,
    completed_count INTEGER DEFAULT 0,
    
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_user_task UNIQUE (task_id, user_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS task_id INTEGER;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS completed_count INTEGER DEFAULT 0;
ALTER TABLE user_guild_tasks ADD COLUMN IF NOT EXISTS last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.user_guild_tasks') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'task_id', 'user_id', 'progress', 'completed_count', 'last_updated', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE user_guild_tasks ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会战表
CREATE TABLE IF NOT EXISTS guild_wars (
    id SERIAL PRIMARY KEY,
    attacking_guild_id INTEGER NOT NULL REFERENCES guilds(id),
    defending_guild_id INTEGER NOT NULL REFERENCES guilds(id),
    
    war_type VARCHAR(20) DEFAULT 'regular' CHECK (war_type IN ('regular', 'championship', 'friendly')),
    
    status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'preparation', 'active', 'completed', 'cancelled')),
    
    -- 准备期和战斗期
    preparation_starts_at TIMESTAMP,
    battle_starts_at TIMESTAMP,
    battle_ends_at TIMESTAMP,
    
    -- 结果
    winner_guild_id INTEGER REFERENCES guilds(id),
    attacking_score INTEGER DEFAULT 0,
    defending_score INTEGER DEFAULT 0,
    
    -- 战利品
    war_chest INTEGER DEFAULT 0,
    experience_reward INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS attacking_guild_id INTEGER;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS defending_guild_id INTEGER;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS war_type VARCHAR(20) DEFAULT 'regular';
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'scheduled';
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS preparation_starts_at TIMESTAMP;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS battle_starts_at TIMESTAMP;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS battle_ends_at TIMESTAMP;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS winner_guild_id INTEGER;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS attacking_score INTEGER DEFAULT 0;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS defending_score INTEGER DEFAULT 0;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS war_chest INTEGER DEFAULT 0;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS experience_reward INTEGER DEFAULT 0;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_wars ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_wars') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('attacking_guild_id', 'defending_guild_id', 'war_type', 'status', 'preparation_starts_at', 'battle_starts_at', 'battle_ends_at', 'winner_guild_id', 'attacking_score', 'defending_score', 'war_chest', 'experience_reward', 'created_at', 'completed_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_wars ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会战参与记录
CREATE TABLE IF NOT EXISTS guild_war_participations (
    id SERIAL PRIMARY KEY,
    war_id INTEGER NOT NULL REFERENCES guild_wars(id) ON DELETE CASCADE,
    guild_id INTEGER NOT NULL REFERENCES guilds(id),
    user_id UUID NOT NULL REFERENCES users(id),
    
    battles_won INTEGER DEFAULT 0,
    battles_lost INTEGER DEFAULT 0,
    stars_earned INTEGER DEFAULT 0,
    
    contribution_score INTEGER DEFAULT 0,
    
    CONSTRAINT unique_war_participation UNIQUE (war_id, user_id)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS war_id INTEGER;
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS battles_won INTEGER DEFAULT 0;
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS battles_lost INTEGER DEFAULT 0;
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS stars_earned INTEGER DEFAULT 0;
ALTER TABLE guild_war_participations ADD COLUMN IF NOT EXISTS contribution_score INTEGER DEFAULT 0;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_war_participations') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('war_id', 'guild_id', 'user_id', 'battles_won', 'battles_lost', 'stars_earned', 'contribution_score', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_war_participations ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会排行榜
CREATE TABLE IF NOT EXISTS guild_leaderboard (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER UNIQUE NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    
    leaderboard_type VARCHAR(20) NOT NULL CHECK (leaderboard_type IN ('global', 'regional', 'contribution', 'war')),
    
    score INTEGER DEFAULT 0,
    rank INTEGER,
    
    period VARCHAR(20) DEFAULT 'all_time' CHECK (period IN ('daily', 'weekly', 'monthly', 'all_time')),
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS leaderboard_type VARCHAR(20);
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS rank INTEGER;
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS period VARCHAR(20) DEFAULT 'all_time';
ALTER TABLE guild_leaderboard ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_leaderboard') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'leaderboard_type', 'score', 'rank', 'period', 'updated_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_leaderboard ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会增益效果表
CREATE TABLE IF NOT EXISTS guild_buffs (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    buff_type VARCHAR(50) NOT NULL,
    
    buff_value DECIMAL(10, 2) NOT NULL,
    duration_hours INTEGER NOT NULL,
    
    activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    
    cost INTEGER NOT NULL, -- 消耗的公会资金
    
    CONSTRAINT unique_guild_buff UNIQUE (guild_id, buff_type)
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS buff_type VARCHAR(50);
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS buff_value DECIMAL(10, 2);
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS duration_hours INTEGER;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE guild_buffs ADD COLUMN IF NOT EXISTS cost INTEGER;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_buffs') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'buff_type', 'buff_value', 'duration_hours', 'activated_at', 'expires_at', 'cost', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_buffs ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会聊天消息表
CREATE TABLE IF NOT EXISTS guild_chat_messages (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'announcement')),
    
    content TEXT NOT NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_chat_messages') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'user_id', 'message_type', 'content', 'created_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_chat_messages ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 公会公告表
CREATE TABLE IF NOT EXISTS guild_announcements (
    id SERIAL PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id),
    
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    
    is_pinned BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);
-- [fix_sql_dialect] 补齐已存在旧表缺少的列
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS guild_id INTEGER;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS author_id UUID;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS title VARCHAR(200);
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
-- [fix_sql_dialect] 放开旧表中新定义没有的非主键列的 NOT NULL
DO $relax$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.guild_announcements') AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
             AND a.attname NOT IN ('guild_id', 'author_id', 'title', 'content', 'is_pinned', 'created_at', 'expires_at', 'id')
             AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey))
  LOOP
    EXECUTE format('ALTER TABLE guild_announcements ALTER COLUMN %I DROP NOT NULL', c.attname);
  END LOOP;
END $relax$;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_guilds_level ON guilds(level DESC);
CREATE INDEX IF NOT EXISTS idx_guilds_status ON guilds(status);
CREATE INDEX IF NOT EXISTS idx_guilds_join_type ON guilds(join_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_user ON guild_members(user_id);
CREATE INDEX IF NOT EXISTS idx_guild_members_contribution ON guild_members(guild_id, contribution DESC);
CREATE INDEX IF NOT EXISTS idx_guild_members_role ON guild_members(role);
CREATE INDEX IF NOT EXISTS idx_guild_applications_status ON guild_applications(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_guild_applications_user ON guild_applications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_guild_tasks_guild ON guild_tasks(guild_id, task_period);
CREATE INDEX IF NOT EXISTS idx_guild_tasks_active ON guild_tasks(guild_id, starts_at, ends_at) WHERE is_completed = FALSE;
CREATE INDEX IF NOT EXISTS idx_guild_wars_status ON guild_wars(status);
CREATE INDEX IF NOT EXISTS idx_guild_wars_guild ON guild_wars(attacking_guild_id, defending_guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_chat_guild_time ON guild_chat_messages(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guild_leaderboard_rank ON guild_leaderboard(leaderboard_type, rank);
CREATE INDEX IF NOT EXISTS idx_guild_leaderboard_type ON guild_leaderboard(leaderboard_type, period);
CREATE INDEX IF NOT EXISTS idx_guild_buffs_expires ON guild_buffs(guild_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_guild_donations_guild ON guild_donations(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guild_donations_user ON guild_donations(user_id, created_at DESC);

-- 添加注释
COMMENT ON TABLE guilds IS '公会主表';
COMMENT ON TABLE guild_members IS '公会成员表';
COMMENT ON TABLE guild_applications IS '公会申请表';
COMMENT ON TABLE guild_invitations IS '公会邀请表';
COMMENT ON TABLE guild_warehouse IS '公会仓库（共享道具）';
COMMENT ON TABLE guild_tasks IS '公会任务表';
COMMENT ON TABLE guild_wars IS '公会战表';
COMMENT ON TABLE guild_leaderboard IS '公会排行榜';
COMMENT ON TABLE guild_buffs IS '公会增益效果表';
COMMENT ON TABLE guild_chat_messages IS '公会聊天消息表';

-- 原"默认公会配置"插入了 guild_id = 0 的排行榜行，而 guilds 中不存在 id=0，违反外键；排行榜行由公会创建时生成，已移除。
