-- E02 + E34：公会（REQ-00058）、小队实时协作与语音（REQ-00558）
--
-- 命名约定（避免与已有概念混淆）：
--   users.team            = 阵营（Mystic/Valor/Instinct），不动
--   teams / team_members  = REQ-00109 道馆团战队伍（gym-service 使用），不动
--   guild_*               = 公会：长期社交组织（本迁移对齐旧表结构 + 新增日历/仓库库存）
--   squads / squad_*      = 小队：临时组队（2–20 人，Raid/道馆/休闲），语音与位置共享以小队为单位，
--                           可挂在公会下（squads.guild_id），小队战绩汇总到公会经验/贡献
--
-- 依赖：V1 users(id UUID)。guild_* 表此前由 pending/20260610_040000__add_guild_system_tables.sql 与
-- migrations/20260625_000100__add_guild_system.sql 创建（两份结构略有差异），这里先兜底 CREATE TABLE IF NOT EXISTS，
-- 再用 ADD COLUMN IF NOT EXISTS / 约束归一，保证无论旧迁移是否跑过、跑的是哪一份，最终结构一致。全部幂等。

-- ============================================================
-- 1. 公会：兜底建表（旧迁移都没跑过时）
-- ============================================================
CREATE TABLE IF NOT EXISTS guilds (
  id                    SERIAL PRIMARY KEY,
  guild_key             VARCHAR(50) UNIQUE NOT NULL,
  name                  VARCHAR(100) NOT NULL,
  description           TEXT DEFAULT '',
  badge_url             VARCHAR(500),
  level                 INTEGER DEFAULT 1,
  experience            INTEGER DEFAULT 0,
  max_members           INTEGER DEFAULT 50,
  treasury              INTEGER DEFAULT 0,
  total_contribution    INTEGER DEFAULT 0,
  join_type             VARCHAR(20) DEFAULT 'apply' CHECK (join_type IN ('public', 'apply', 'invite_only')),
  min_level             INTEGER DEFAULT 5,
  invite_code           VARCHAR(20),
  status                VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'disbanded')),
  total_battles_won     INTEGER DEFAULT 0,
  total_raids_completed INTEGER DEFAULT 0,
  total_tasks_completed INTEGER DEFAULT 0,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT valid_guild_level CHECK (level >= 1 AND level <= 50)
);

CREATE TABLE IF NOT EXISTS guild_members (
  id                   SERIAL PRIMARY KEY,
  guild_id             INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 VARCHAR(20) DEFAULT 'member' CHECK (role IN ('leader', 'co_leader', 'elder', 'member', 'novice')),
  contribution         INTEGER DEFAULT 0,
  weekly_contribution  INTEGER DEFAULT 0,
  total_donated        INTEGER DEFAULT 0,
  battles_participated INTEGER DEFAULT 0,
  raids_participated   INTEGER DEFAULT 0,
  tasks_completed      INTEGER DEFAULT 0,
  permissions          JSONB DEFAULT '{}',
  joined_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_contribution_at TIMESTAMP,
  last_active_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS guild_applications (
  id               SERIAL PRIMARY KEY,
  guild_id         INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  application_text TEXT,
  reviewed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMP,
  review_note      TEXT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_invitations (
  id           SERIAL PRIMARY KEY,
  guild_id     INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  inviter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code  VARCHAR(20),
  status       VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  expires_at   TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_donations (
  id                  SERIAL PRIMARY KEY,
  guild_id            INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  donation_type       VARCHAR(20) NOT NULL CHECK (donation_type IN ('coins', 'items', 'pokemon')),
  amount              INTEGER NOT NULL,
  contribution_gained INTEGER DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_tasks (
  id                  SERIAL PRIMARY KEY,
  guild_id            INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  task_key            VARCHAR(100) NOT NULL,
  title               VARCHAR(200) NOT NULL,
  description         TEXT,
  task_type           VARCHAR(50) NOT NULL,
  requirement         JSONB NOT NULL DEFAULT '{}',
  rewards             JSONB NOT NULL DEFAULT '{}',
  task_period         VARCHAR(20) DEFAULT 'weekly' CHECK (task_period IN ('daily', 'weekly', 'monthly', 'special')),
  current_progress    INTEGER DEFAULT 0,
  target_progress     INTEGER NOT NULL,
  max_completions     INTEGER DEFAULT 0,
  contribution_reward INTEGER DEFAULT 0,
  starts_at           TIMESTAMP NOT NULL,
  ends_at             TIMESTAMP NOT NULL,
  is_completed        BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_buffs (
  id             SERIAL PRIMARY KEY,
  guild_id       INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  buff_type      VARCHAR(50) NOT NULL,
  buff_value     DECIMAL(10, 2) NOT NULL,
  duration_hours INTEGER NOT NULL,
  activated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at     TIMESTAMP NOT NULL,
  cost           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_chat_messages (
  id           SERIAL PRIMARY KEY,
  guild_id     INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'system', 'announcement')),
  content      TEXT NOT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guild_announcements (
  id         SERIAL PRIMARY KEY,
  guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  title      VARCHAR(200) NOT NULL,
  content    TEXT NOT NULL,
  is_pinned  BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP
);

-- ============================================================
-- 2. 公会：列与约束归一（两份旧迁移的差异 + 本需求新增列）
-- ============================================================
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS invite_code VARCHAR(20);
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS badge_icon VARCHAR(16) DEFAULT '🛡️';
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS disbanded_at TIMESTAMP;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_battles_won INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_raids_completed INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS total_tasks_completed INTEGER DEFAULT 0;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_guilds_invite_code ON guilds(invite_code);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'guilds 中存在重复邀请码，未创建 uq_guilds_invite_code';
END $$;

-- 同名公会：活跃公会名称大小写不敏感唯一（旧数据有重名时不建，输出 NOTICE，由服务层兜底检查）
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_guilds_name_active ON guilds (lower(name)) WHERE status <> 'disbanded';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'guilds 中存在重名活跃公会，未创建 uq_guilds_name_active';
END $$;

ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS contribution_week DATE;   -- weekly_contribution 所属周（周一日期），跨周懒重置
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS battles_participated INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS raids_participated INTEGER DEFAULT 0;
ALTER TABLE guild_members ADD COLUMN IF NOT EXISTS last_contribution_at TIMESTAMP;
-- 一人只能在一个公会：pending 迁移只对非 novice 角色建了排他约束，这里补全表唯一（旧数据冲突时跳过并提示）
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_guild_members_one_guild ON guild_members(user_id);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'guild_members 中有用户属于多个公会，未创建 uq_guild_members_one_guild（服务层仍按一人一会处理）';
END $$;
CREATE INDEX IF NOT EXISTS idx_guild_members_guild_contrib ON guild_members(guild_id, contribution DESC);

-- 申请/邀请：只约束"同时只有一条 pending"（旧 20260625 迁移的全列唯一会让被拒后无法再次申请/邀请）
ALTER TABLE guild_applications DROP CONSTRAINT IF EXISTS guild_applications_guild_id_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS unique_pending_application ON guild_applications (guild_id, user_id) WHERE (status = 'pending');
CREATE INDEX IF NOT EXISTS idx_guild_applications_guild_status ON guild_applications(guild_id, status, created_at);
ALTER TABLE guild_invitations DROP CONSTRAINT IF EXISTS guild_invitations_guild_id_invitee_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS unique_pending_invitation ON guild_invitations (guild_id, invitee_id) WHERE (status = 'pending');
CREATE INDEX IF NOT EXISTS idx_guild_invitations_invitee_status ON guild_invitations(invitee_id, status);

CREATE INDEX IF NOT EXISTS idx_guild_donations_guild_time ON guild_donations(guild_id, created_at DESC);

ALTER TABLE guild_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_guild_tasks_key_window ON guild_tasks(guild_id, task_key, starts_at);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'guild_tasks 中有重复任务窗口，未创建 uq_guild_tasks_key_window';
END $$;
-- 旧约束 UNIQUE(guild_id, task_key, task_period) 会让"每周任务"只能创建一次（第二周插入冲突），改为按周期起点唯一
ALTER TABLE guild_tasks DROP CONSTRAINT IF EXISTS unique_guild_task;
ALTER TABLE guild_tasks DROP CONSTRAINT IF EXISTS guild_tasks_guild_id_task_key_task_period_key;

DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_guild_buffs_type ON guild_buffs(guild_id, buff_type);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'guild_buffs 中有重复增益行，未创建 uq_guild_buffs_type';
END $$;

-- 系统消息（成员加入/离开等）没有发送者
ALTER TABLE guild_chat_messages ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE guild_chat_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';
CREATE INDEX IF NOT EXISTS idx_guild_chat_guild_id_desc ON guild_chat_messages(guild_id, id DESC);

ALTER TABLE guild_announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_guild_announcements_list ON guild_announcements(guild_id, is_pinned DESC, created_at DESC);

-- 用户所属公会（冗余，便于其他服务展示公会标签；由 social-service 在加入/退出/解散事务内维护）
ALTER TABLE users ADD COLUMN IF NOT EXISTS guild_id INTEGER REFERENCES guilds(id) ON DELETE SET NULL;

-- ============================================================
-- 3. 公会：活动日历、共享仓库库存与流水（新）
-- ============================================================
CREATE TABLE IF NOT EXISTS guild_events (
  id          SERIAL PRIMARY KEY,
  guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type  VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (event_type IN ('raid', 'meetup', 'battle', 'community_day', 'other')),
  title       VARCHAR(100) NOT NULL,
  description TEXT,
  location    VARCHAR(200),
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_guild_events_guild_start ON guild_events(guild_id, starts_at);

-- 仓库按道具聚合库存（旧 guild_warehouse 是逐笔捐赠行、item_data 必填，无法做原子扣减，保留不用）
CREATE TABLE IF NOT EXISTS guild_item_stock (
  guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  item_id    VARCHAR(64) NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, item_id)
);

CREATE TABLE IF NOT EXISTS guild_item_log (
  id         BIGSERIAL PRIMARY KEY,
  guild_id   INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  item_id    VARCHAR(64) NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  action     VARCHAR(10) NOT NULL CHECK (action IN ('donate', 'claim')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guild_item_log_guild ON guild_item_log(guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guild_item_log_user_day ON guild_item_log(user_id, action, created_at);

-- ============================================================
-- 4. 小队（临时组队）
-- ============================================================
CREATE TABLE IF NOT EXISTS squads (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         VARCHAR(40) NOT NULL,
  leader_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id     INTEGER REFERENCES guilds(id) ON DELETE SET NULL,
  squad_type   VARCHAR(10) NOT NULL DEFAULT 'casual' CHECK (squad_type IN ('raid', 'gym', 'casual')),
  max_members  SMALLINT NOT NULL DEFAULT 5 CHECK (max_members BETWEEN 2 AND 20),
  join_policy  VARCHAR(10) NOT NULL DEFAULT 'invite' CHECK (join_policy IN ('invite', 'friends', 'guild', 'open')),
  join_code    VARCHAR(8),
  status       VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_battle', 'disbanded')),
  raid_target  JSONB,                                  -- 队长发起的 Raid/道馆目标 { raidId, gymId, calledAt }
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disbanded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_squads_join_code ON squads(join_code);
CREATE INDEX IF NOT EXISTS idx_squads_guild_active ON squads(guild_id) WHERE status <> 'disbanded';
CREATE INDEX IF NOT EXISTS idx_squads_leader ON squads(leader_id);

CREATE TABLE IF NOT EXISTS squad_members (
  id             BIGSERIAL PRIMARY KEY,
  squad_id       UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'member')),
  share_location BOOLEAN NOT NULL DEFAULT FALSE,        -- 每名成员自己的位置共享开关（默认关闭）
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at        TIMESTAMPTZ,
  leave_reason   VARCHAR(10) CHECK (leave_reason IN ('left', 'kicked', 'disbanded'))
);
-- 同一时间一人只在一个小队；同一小队内同一用户只有一条在队记录
CREATE UNIQUE INDEX IF NOT EXISTS uq_squad_members_active_user ON squad_members(user_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_squad_members_squad_active ON squad_members(squad_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_squad_members_user_hist ON squad_members(user_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS squad_invitations (
  id           BIGSERIAL PRIMARY KEY,
  squad_id     UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  inviter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_squad_invitations_pending ON squad_invitations(squad_id, invitee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_squad_invitations_invitee ON squad_invitations(invitee_id, status, expires_at);

-- 小队战绩：由 gym-service 结算后经 Redis Stream / 内部接口上报（见 backend/shared/squad/battleReport.js）
CREATE TABLE IF NOT EXISTS squad_battles (
  id               BIGSERIAL PRIMARY KEY,
  idempotency_key  VARCHAR(200) NOT NULL UNIQUE,       -- source:battleRef:squadId，重复上报不重复计分
  squad_id         UUID REFERENCES squads(id) ON DELETE SET NULL,
  guild_id         INTEGER REFERENCES guilds(id) ON DELETE SET NULL,
  source           VARCHAR(10) NOT NULL CHECK (source IN ('raid', 'gym', 'pvp', 'other')),
  battle_ref       VARCHAR(64) NOT NULL,
  outcome          VARCHAR(8) NOT NULL CHECK (outcome IN ('won', 'lost', 'draw', 'aborted')),
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  total_score      INTEGER NOT NULL DEFAULT 0,
  details          JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_squad_battles_squad ON squad_battles(squad_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_squad_battles_guild ON squad_battles(guild_id, ended_at DESC) WHERE guild_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_squad_battles_ref ON squad_battles(source, battle_ref);

CREATE TABLE IF NOT EXISTS squad_battle_members (
  battle_id    BIGINT NOT NULL REFERENCES squad_battles(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  damage       INTEGER NOT NULL DEFAULT 0 CHECK (damage >= 0),
  healing      INTEGER NOT NULL DEFAULT 0 CHECK (healing >= 0),
  catches      INTEGER NOT NULL DEFAULT 0 CHECK (catches >= 0),
  hold_seconds INTEGER NOT NULL DEFAULT 0 CHECK (hold_seconds >= 0),   -- 道馆占领时长
  score        INTEGER NOT NULL DEFAULT 0,
  reward_share NUMERIC(6, 4) NOT NULL DEFAULT 0,
  is_leader    BOOLEAN NOT NULL DEFAULT FALSE,
  is_mvp       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (battle_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_squad_battle_members_user ON squad_battle_members(user_id);

-- 语音会话质量汇总（每次加入语音一行，离开时写入；实时指标走 Prometheus）
CREATE TABLE IF NOT EXISTS voice_sessions (
  id                  BIGSERIAL PRIMARY KEY,
  squad_id            UUID REFERENCES squads(id) ON DELETE SET NULL,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode                VARCHAR(10) NOT NULL CHECK (mode IN ('mesh', 'floor')),
  joined_at           TIMESTAMPTZ NOT NULL,
  left_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  samples             INTEGER NOT NULL DEFAULT 0,
  avg_rtt_ms          REAL,
  max_rtt_ms          REAL,
  avg_jitter_ms       REAL,
  avg_loss_pct        REAL,
  avg_mos             REAL,
  min_mos             REAL,
  reconnect_attempts  INTEGER NOT NULL DEFAULT 0,
  reconnect_successes INTEGER NOT NULL DEFAULT 0,
  user_agent_family   VARCHAR(16)
);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_time ON voice_sessions(left_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_user ON voice_sessions(user_id, left_at DESC);

COMMENT ON TABLE squads IS 'REQ-00558 小队（临时组队 2–20 人）；与阵营 users.team、团战 teams 表无关';
COMMENT ON TABLE squad_members IS 'REQ-00558 小队成员（left_at 为空=在队）；share_location 为成员自己的位置共享开关';
COMMENT ON TABLE squad_battles IS 'REQ-00558 小队战绩（gym-service 结算后上报，idempotency_key 去重）';
COMMENT ON TABLE squad_battle_members IS 'REQ-00558 小队战斗成员贡献与奖励分配比例';
COMMENT ON TABLE voice_sessions IS 'REQ-00558 小队语音会话质量汇总';
COMMENT ON TABLE guild_events IS 'REQ-00058 公会活动日历';
COMMENT ON TABLE guild_item_stock IS 'REQ-00058 公会共享仓库库存';
