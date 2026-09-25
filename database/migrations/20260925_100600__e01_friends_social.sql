-- E01 好友与社交互动（REQ-00048 / REQ-00228 / REQ-00326 / REQ-00377 / REQ-00388）
-- 好友相关表收敛为一套权威结构，并补齐隐私、精灵好友、互动增强所需的表。全部幂等（IF NOT EXISTS / ON CONFLICT）。
--
-- 权威结构：
--   friends            双向两行（A→B、B→A），友情点 friendship_points 同时驱动友情等级（1-5）与亲密度等级（1-10）；
--                      A→B 行上保存 A 对 B 的个人设置（分组、权限级别、备注、收藏、权限覆盖）
--   friend_requests    好友申请（7 天过期），同一对用户同时只能有一条 pending
--   friend_gifts       V1 表 + 扩展列；触发器同步 sender_id/from_user_id、receiver_id/to_user_id、opened/status
--   friend_interactions 互动流水
-- 兼容：friendships(user_a,user_b) 由 friends 触发器同步，交易/对战/GDPR 等旧读者继续可用。

-- ============================================================
-- 0. 用户：好友码（12 位数字）与生日
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_code VARCHAR(16);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE;

CREATE OR REPLACE FUNCTION gen_friend_code() RETURNS VARCHAR AS $$
DECLARE c VARCHAR;
BEGIN
  LOOP
    c := lpad((floor(random() * 1000000000000))::bigint::text, 12, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE friend_code = c);
  END LOOP;
  RETURN c;
END $$ LANGUAGE plpgsql VOLATILE;

-- 旧数据里重复/非 12 位数字的好友码重新生成
UPDATE users u SET friend_code = NULL
 WHERE friend_code IS NOT NULL
   AND (friend_code !~ '^[0-9]{12}$'
        OR EXISTS (SELECT 1 FROM users u2 WHERE u2.friend_code = u.friend_code AND u2.id < u.id));
UPDATE users SET friend_code = gen_friend_code() WHERE friend_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_friend_code ON users(friend_code);

CREATE OR REPLACE FUNCTION trg_users_friend_code_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.friend_code IS NULL OR NEW.friend_code = '' THEN
    NEW.friend_code := gen_friend_code();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_users_friend_code ON users;
CREATE TRIGGER trg_users_friend_code BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION trg_users_friend_code_fn();

DO $$ BEGIN
  -- 昵称模糊搜索：有 pg_trgm 时建 trigram 索引（无扩展时退化为顺序扫描，不影响正确性）
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_users_nickname_trgm ON users USING gin (nickname gin_trgm_ops)';
  END IF;
END $$;

-- ============================================================
-- 1. 好友分组（REQ-00228）——friends.group_id 引用
-- ============================================================
CREATE TABLE IF NOT EXISTS friend_groups (
  id               SERIAL PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             VARCHAR(50) NOT NULL,
  permission_level VARCHAR(20) NOT NULL DEFAULT 'regular'
                   CHECK (permission_level IN ('regular', 'close_friends', 'family')),
  color            VARCHAR(7) NOT NULL DEFAULT '#4CAF50',
  icon             VARCHAR(50),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_friend_groups_user ON friend_groups(user_id, sort_order);

-- ============================================================
-- 2. friends：个人设置列、亲密度等级、索引
-- ============================================================
CREATE TABLE IF NOT EXISTS friends (
  id                  SERIAL PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              VARCHAR(20) NOT NULL DEFAULT 'accepted',
  friendship_level    INTEGER DEFAULT 1,
  friendship_points   INTEGER DEFAULT 0,
  last_interaction_at TIMESTAMP,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_friends_pair UNIQUE (user_id, friend_user_id)
);
ALTER TABLE friends ADD COLUMN IF NOT EXISTS intimacy_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE friends ADD COLUMN IF NOT EXISTS permission_level VARCHAR(20) NOT NULL DEFAULT 'regular';
ALTER TABLE friends ADD COLUMN IF NOT EXISTS group_id INTEGER;
ALTER TABLE friends ADD COLUMN IF NOT EXISTS nickname VARCHAR(50);
ALTER TABLE friends ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE friends ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE friends ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE friends ADD COLUMN IF NOT EXISTS permission_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE friends ADD COLUMN IF NOT EXISTS interaction_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE friends ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_friends_group') THEN
    ALTER TABLE friends ADD CONSTRAINT fk_friends_group FOREIGN KEY (group_id) REFERENCES friend_groups(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_friends_permission_level') THEN
    ALTER TABLE friends ADD CONSTRAINT chk_friends_permission_level
      CHECK (permission_level IN ('regular', 'close_friends', 'family'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_friends_not_self') THEN
    ALTER TABLE friends ADD CONSTRAINT chk_friends_not_self CHECK (user_id <> friend_user_id) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_friends_user_points ON friends(user_id, friendship_points DESC) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_friends_user_recent ON friends(user_id, last_interaction_at DESC NULLS LAST) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_friends_group ON friends(group_id) WHERE group_id IS NOT NULL;

-- 旧 friendships 中的好友关系回填为 friends 双向两行（等级映射为不低于该等级阈值的友情点）
INSERT INTO friends (user_id, friend_user_id, status, friendship_level, friendship_points,
                     last_interaction_at, created_at, accepted_at)
SELECT x.u, x.f, 'accepted', x.lvl, x.pts, x.last_at, x.created_at, x.created_at
FROM (
  SELECT fs.user_a AS u, fs.user_b AS f, fs.last_interaction_at AS last_at, fs.created_at,
         CASE fs.level WHEN 'BEST' THEN 4 WHEN 'ULTRA' THEN 3 WHEN 'GREAT' THEN 2 ELSE 1 END AS lvl,
         GREATEST(COALESCE(fs.friendship_points, 0),
                  CASE fs.level WHEN 'BEST' THEN 1000 WHEN 'ULTRA' THEN 500 WHEN 'GREAT' THEN 100 ELSE 0 END) AS pts
    FROM friendships fs
  UNION ALL
  SELECT fs.user_b, fs.user_a, fs.last_interaction_at, fs.created_at,
         CASE fs.level WHEN 'BEST' THEN 4 WHEN 'ULTRA' THEN 3 WHEN 'GREAT' THEN 2 ELSE 1 END,
         GREATEST(COALESCE(fs.friendship_points, 0),
                  CASE fs.level WHEN 'BEST' THEN 1000 WHEN 'ULTRA' THEN 500 WHEN 'GREAT' THEN 100 ELSE 0 END)
    FROM friendships fs
) x
ON CONFLICT (user_id, friend_user_id) DO NOTHING;

-- friends → friendships 同步（旧读者：交易星尘折扣、对战、用户资料好友数、GDPR）
CREATE OR REPLACE FUNCTION friends_sync_legacy_friendships() RETURNS trigger AS $$
DECLARE a UUID; b UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    a := LEAST(OLD.user_id, OLD.friend_user_id);
    b := GREATEST(OLD.user_id, OLD.friend_user_id);
    DELETE FROM friendships WHERE user_a = a AND user_b = b;
    RETURN OLD;
  END IF;
  IF NEW.status IS DISTINCT FROM 'accepted' THEN
    RETURN NEW;
  END IF;
  a := LEAST(NEW.user_id, NEW.friend_user_id);
  b := GREATEST(NEW.user_id, NEW.friend_user_id);
  INSERT INTO friendships (user_a, user_b, level, friendship_points, friendship_level, last_interaction_at)
  VALUES (a, b,
          (CASE WHEN COALESCE(NEW.friendship_level, 1) >= 4 THEN 'BEST'
                WHEN NEW.friendship_level = 3 THEN 'ULTRA'
                WHEN NEW.friendship_level = 2 THEN 'GREAT'
                ELSE 'GOOD' END)::friendship_level_enum,
          COALESCE(NEW.friendship_points, 0),
          LEAST(GREATEST(COALESCE(NEW.friendship_level, 1), 1), 5),
          COALESCE(NEW.last_interaction_at, NOW()))
  ON CONFLICT (user_a, user_b) DO UPDATE
     SET level = EXCLUDED.level,
         friendship_points = EXCLUDED.friendship_points,
         friendship_level = EXCLUDED.friendship_level,
         last_interaction_at = GREATEST(friendships.last_interaction_at, EXCLUDED.last_interaction_at);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_friends_sync_legacy ON friends;
CREATE TRIGGER trg_friends_sync_legacy
  AFTER INSERT OR DELETE OR UPDATE OF status, friendship_level, friendship_points, last_interaction_at ON friends
  FOR EACH ROW EXECUTE FUNCTION friends_sync_legacy_friendships();

-- ============================================================
-- 3. friend_requests：审批信息、来源、同一对用户仅一条 pending
-- ============================================================
CREATE TABLE IF NOT EXISTS friend_requests (
  id           SERIAL PRIMARY KEY,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message      TEXT,
  status       VARCHAR(20) DEFAULT 'pending',
  expires_at   TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_friend_requests_pair UNIQUE (from_user_id, to_user_id)
);
ALTER TABLE friend_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE friend_requests ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE friend_requests ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'search';

UPDATE friend_requests SET status = 'expired', updated_at = NOW()
 WHERE status = 'pending' AND expires_at <= NOW();
UPDATE friend_requests r SET status = 'expired', updated_at = NOW()
 WHERE r.status = 'pending'
   AND EXISTS (SELECT 1 FROM friend_requests r2
                WHERE r2.status = 'pending' AND r2.id > r.id
                  AND LEAST(r2.from_user_id, r2.to_user_id) = LEAST(r.from_user_id, r.to_user_id)
                  AND GREATEST(r2.from_user_id, r2.to_user_id) = GREATEST(r.from_user_id, r.to_user_id));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_friend_requests_status') THEN
    ALTER TABLE friend_requests ADD CONSTRAINT chk_friend_requests_status
      CHECK (status IN ('pending', 'accepted', 'rejected', 'ignored', 'cancelled', 'expired')) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_friend_requests_pending_pair
  ON friend_requests (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id))
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_friend_requests_to_pending ON friend_requests(to_user_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_friend_requests_from_pending ON friend_requests(from_user_id) WHERE status = 'pending';

-- ============================================================
-- 4. friend_gifts：V1 表 + 扩展列；新旧列由触发器保持一致
-- ============================================================
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS from_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS to_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS gift_type VARCHAR(50);
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS gift_id VARCHAR(50);
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS gift_name VARCHAR(100);
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days');
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS friendship_points INTEGER DEFAULT 10;
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS message VARCHAR(200);
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS wrapping VARCHAR(30);
ALTER TABLE friend_gifts ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE friend_gifts ALTER COLUMN gift_id TYPE VARCHAR(50);

UPDATE friend_gifts SET from_user_id = sender_id WHERE from_user_id IS NULL;
UPDATE friend_gifts SET to_user_id = receiver_id WHERE to_user_id IS NULL;
UPDATE friend_gifts SET gift_type = 'standard' WHERE gift_type IS NULL;
UPDATE friend_gifts SET status = 'claimed', claimed_at = COALESCE(claimed_at, opened_at, NOW())
 WHERE opened AND COALESCE(status, 'pending') <> 'claimed';
UPDATE friend_gifts SET status = 'pending' WHERE status IS NULL;

CREATE OR REPLACE FUNCTION friend_gifts_sync_cols() RETURNS trigger AS $$
BEGIN
  NEW.sender_id    := COALESCE(NEW.sender_id, NEW.from_user_id);
  NEW.from_user_id := COALESCE(NEW.from_user_id, NEW.sender_id);
  NEW.receiver_id  := COALESCE(NEW.receiver_id, NEW.to_user_id);
  NEW.to_user_id   := COALESCE(NEW.to_user_id, NEW.receiver_id);
  NEW.status       := COALESCE(NEW.status, 'pending');
  IF NEW.status = 'claimed' THEN
    NEW.opened     := true;
    NEW.claimed_at := COALESCE(NEW.claimed_at, NEW.opened_at, NOW());
    NEW.opened_at  := COALESCE(NEW.opened_at, NEW.claimed_at);
  ELSIF NEW.opened AND NEW.status = 'pending' THEN
    NEW.status     := 'claimed';
    NEW.claimed_at := COALESCE(NEW.claimed_at, NEW.opened_at, NOW());
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_friend_gifts_sync ON friend_gifts;
CREATE TRIGGER trg_friend_gifts_sync BEFORE INSERT OR UPDATE ON friend_gifts
  FOR EACH ROW EXECUTE FUNCTION friend_gifts_sync_cols();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_friend_gifts_status') THEN
    ALTER TABLE friend_gifts ADD CONSTRAINT chk_friend_gifts_status
      CHECK (status IN ('pending', 'claimed', 'expired', 'rejected')) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_friend_gifts_to_pending ON friend_gifts(to_user_id, sent_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_friend_gifts_from_sent ON friend_gifts(from_user_id, sent_at DESC);

-- ============================================================
-- 5. friend_interactions
-- ============================================================
CREATE TABLE IF NOT EXISTS friend_interactions (
  id                       SERIAL PRIMARY KEY,
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interaction_type         VARCHAR(50) NOT NULL,
  metadata                 JSONB,
  friendship_points_earned INTEGER DEFAULT 0,
  created_at               TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_friend_interactions_user_friend ON friend_interactions(user_id, friend_user_id, created_at DESC);

-- 配置（服务启动时读取，缺失时用代码默认值）
CREATE TABLE IF NOT EXISTS friend_system_config (
  key         VARCHAR(50) PRIMARY KEY,
  value       INTEGER NOT NULL,
  description TEXT,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO friend_system_config (key, value, description) VALUES
  ('max_friends', 400, '最大好友数量'),
  ('max_pending_requests', 50, '最大待处理好友请求数'),
  ('max_daily_gifts', 50, '每日最大礼物发送数量'),
  ('request_expire_days', 7, '好友请求过期天数'),
  ('gift_expire_days', 30, '礼物过期天数'),
  ('online_threshold_minutes', 5, '在线状态判定阈值（分钟）'),
  ('away_threshold_minutes', 60, '离开状态判定阈值（分钟）')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 6. 隐私设置 / 黑名单（REQ-00228）
-- ============================================================
CREATE TABLE IF NOT EXISTS privacy_settings (
  user_id                       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_visibility            VARCHAR(20) NOT NULL DEFAULT 'public',
  online_status_visibility      VARCHAR(20) NOT NULL DEFAULT 'friends',
  location_visibility           VARCHAR(20) NOT NULL DEFAULT 'close_friends',
  pokemon_collection_visibility VARCHAR(20) NOT NULL DEFAULT 'friends',
  pokemon_stats_visibility      VARCHAR(20) NOT NULL DEFAULT 'friends',
  pokemon_shinies_visibility    VARCHAR(20) NOT NULL DEFAULT 'close_friends',
  friend_list_visibility        VARCHAR(20) NOT NULL DEFAULT 'friends',
  battle_history_visibility     VARCHAR(20) NOT NULL DEFAULT 'friends',
  achievements_visibility       VARCHAR(20) NOT NULL DEFAULT 'public',
  activity_visibility           VARCHAR(20) NOT NULL DEFAULT 'friends',
  custom_groups                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  allow_friend_requests         BOOLEAN NOT NULL DEFAULT true,
  allow_trade_requests          BOOLEAN NOT NULL DEFAULT true,
  allow_battle_requests         BOOLEAN NOT NULL DEFAULT true,
  allow_gifts                   BOOLEAN NOT NULL DEFAULT true,
  allow_location_sharing        BOOLEAN NOT NULL DEFAULT false,
  searchable                    BOOLEAN NOT NULL DEFAULT true,
  notify_friend_online          BOOLEAN NOT NULL DEFAULT true,
  version                       INTEGER NOT NULL DEFAULT 1,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blocked_users (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason          VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, blocked_user_id),
  CHECK (user_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users(blocked_user_id);

-- ============================================================
-- 7. 精灵数据可见性（REQ-00377）
-- ============================================================
CREATE TABLE IF NOT EXISTS user_privacy_defaults (
  user_id                         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_pokemon_visibility      VARCHAR(20) NOT NULL DEFAULT 'friends'
                                  CHECK (default_pokemon_visibility IN ('public', 'friends', 'private', 'hidden')),
  default_show_cp                 BOOLEAN NOT NULL DEFAULT true,
  default_show_level              BOOLEAN NOT NULL DEFAULT true,
  default_show_skills             BOOLEAN NOT NULL DEFAULT false,
  default_show_iv                 BOOLEAN NOT NULL DEFAULT false,
  default_show_nature             BOOLEAN NOT NULL DEFAULT true,
  default_show_moves              BOOLEAN NOT NULL DEFAULT false,
  default_friend_level_threshold  INTEGER NOT NULL DEFAULT 1 CHECK (default_friend_level_threshold BETWEEN 1 AND 5),
  default_battle_anonymous        BOOLEAN NOT NULL DEFAULT false,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pokemon_privacy_settings (
  pokemon_id             UUID PRIMARY KEY REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  overall_visibility     VARCHAR(20) NOT NULL DEFAULT 'friends'
                         CHECK (overall_visibility IN ('public', 'friends', 'private', 'hidden')),
  show_cp                BOOLEAN NOT NULL DEFAULT true,
  show_level             BOOLEAN NOT NULL DEFAULT true,
  show_skills            BOOLEAN NOT NULL DEFAULT false,
  show_iv                BOOLEAN NOT NULL DEFAULT false,
  show_nature            BOOLEAN NOT NULL DEFAULT true,
  show_moves             BOOLEAN NOT NULL DEFAULT false,
  friend_level_threshold INTEGER NOT NULL DEFAULT 1 CHECK (friend_level_threshold BETWEEN 1 AND 5),
  battle_anonymous       BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pokemon_privacy_user ON pokemon_privacy_settings(user_id);

-- 新精灵入库时继承主人的默认隐私配置（未设置默认配置的用户不写行，读取时回落到系统默认）
CREATE OR REPLACE FUNCTION pokemon_privacy_inherit_defaults() RETURNS trigger AS $$
BEGIN
  INSERT INTO pokemon_privacy_settings (pokemon_id, user_id, overall_visibility, show_cp, show_level, show_skills,
                                        show_iv, show_nature, show_moves, friend_level_threshold, battle_anonymous)
  SELECT NEW.id, NEW.user_id, d.default_pokemon_visibility, d.default_show_cp, d.default_show_level,
         d.default_show_skills, d.default_show_iv, d.default_show_nature, d.default_show_moves,
         d.default_friend_level_threshold, d.default_battle_anonymous
    FROM user_privacy_defaults d
   WHERE d.user_id = NEW.user_id
  ON CONFLICT (pokemon_id) DO NOTHING;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pokemon_privacy_inherit ON pokemon_instances;
CREATE TRIGGER trg_pokemon_privacy_inherit AFTER INSERT ON pokemon_instances
  FOR EACH ROW EXECUTE FUNCTION pokemon_privacy_inherit_defaults();

-- ============================================================
-- 8. 精灵好友（REQ-00326）
-- ============================================================
CREATE TABLE IF NOT EXISTS pokemon_friendships (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pokemon_id          UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  friend_pokemon_id   UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  requester_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message             VARCHAR(200),
  friendship_level    INTEGER NOT NULL DEFAULT 1 CHECK (friendship_level BETWEEN 1 AND 10),
  intimacy_score      INTEGER NOT NULL DEFAULT 0 CHECK (intimacy_score BETWEEN 0 AND 10000),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at        TIMESTAMPTZ,
  accepted_at         TIMESTAMPTZ,
  last_interaction_at TIMESTAMPTZ,
  interaction_count   INTEGER NOT NULL DEFAULT 0,
  CHECK (pokemon_id <> friend_pokemon_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pokemon_friendships_pair
  ON pokemon_friendships (LEAST(pokemon_id, friend_pokemon_id), GREATEST(pokemon_id, friend_pokemon_id));
CREATE INDEX IF NOT EXISTS idx_pokemon_friendships_pokemon ON pokemon_friendships(pokemon_id, status);
CREATE INDEX IF NOT EXISTS idx_pokemon_friendships_friend ON pokemon_friendships(friend_pokemon_id, status);
CREATE INDEX IF NOT EXISTS idx_pokemon_friendships_addressee ON pokemon_friendships(addressee_user_id, status);

CREATE TABLE IF NOT EXISTS pokemon_interactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  friendship_id    UUID NOT NULL REFERENCES pokemon_friendships(id) ON DELETE CASCADE,
  actor_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  interaction_type VARCHAR(20) NOT NULL CHECK (interaction_type IN ('visit', 'gift', 'adventure', 'photo', 'training')),
  interaction_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  intimacy_gained  INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pokemon_interactions_cooldown
  ON pokemon_interactions(friendship_id, interaction_type, actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pokemon_keepsakes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  friendship_id UUID NOT NULL REFERENCES pokemon_friendships(id) ON DELETE CASCADE,
  keepsake_type VARCHAR(50) NOT NULL,
  keepsake_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  rarity        VARCHAR(20) NOT NULL DEFAULT 'common',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pokemon_keepsakes_friendship ON pokemon_keepsakes(friendship_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pokemon_friendship_rewards (
  id            BIGSERIAL PRIMARY KEY,
  friendship_id UUID NOT NULL REFERENCES pokemon_friendships(id) ON DELETE CASCADE,
  pokemon_id    UUID NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level         INTEGER NOT NULL,
  reward_type   VARCHAR(20) NOT NULL,
  reward        JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at    TIMESTAMPTZ,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (friendship_id, pokemon_id, level)
);
CREATE INDEX IF NOT EXISTS idx_pokemon_friendship_rewards_pokemon ON pokemon_friendship_rewards(pokemon_id);

-- ============================================================
-- 9. 好友互动增强（REQ-00388）
-- ============================================================
CREATE TABLE IF NOT EXISTS intimacy_levels (
  level       INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 10),
  min_points  INTEGER NOT NULL,
  max_points  INTEGER NOT NULL,
  level_name  VARCHAR(50) NOT NULL,
  benefits    JSONB NOT NULL DEFAULT '{}'::jsonb,
  badge_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO intimacy_levels (level, min_points, max_points, level_name, benefits) VALUES
  (1, 0, 99, '陌生人', '{"gift_types": ["standard", "item"]}'),
  (2, 100, 299, '点头之交', '{"gift_types": ["standard", "item", "candy", "stardust"]}'),
  (3, 300, 599, '泛泛之交', '{"gift_types": ["standard", "item", "candy", "stardust", "pokemon_egg"], "joint_missions": true}'),
  (4, 600, 999, '普通朋友', '{"gift_types": ["standard", "item", "candy", "stardust", "pokemon_egg", "coins"]}'),
  (5, 1000, 1499, '好友', '{"bonus_rewards": 1.1}'),
  (6, 1500, 2199, '好朋友', '{"bonus_rewards": 1.15}'),
  (7, 2200, 2999, '密友', '{"exclusive_missions": true, "bonus_rewards": 1.2}'),
  (8, 3000, 3999, '挚友', '{"bonus_rewards": 1.25}'),
  (9, 4000, 4999, '知己', '{"special_gifts": true, "bonus_rewards": 1.3}'),
  (10, 5000, 999999, '生死之交', '{"all_benefits": true, "bonus_rewards": 1.5}')
ON CONFLICT (level) DO NOTHING;

CREATE TABLE IF NOT EXISTS gift_types (
  id                      SERIAL PRIMARY KEY,
  code                    VARCHAR(30) NOT NULL UNIQUE,
  name                    VARCHAR(100) NOT NULL,
  description             TEXT,
  gift_type               VARCHAR(30) NOT NULL
                          CHECK (gift_type IN ('standard', 'item', 'candy', 'stardust', 'coins', 'pokemon_egg')),
  item_id                 VARCHAR(50),
  rarity                  VARCHAR(20) NOT NULL DEFAULT 'common',
  icon_url                TEXT,
  required_intimacy_level INTEGER NOT NULL DEFAULT 1,
  daily_limit             INTEGER,
  max_quantity            INTEGER NOT NULL DEFAULT 1,
  friendship_points       INTEGER NOT NULL DEFAULT 10,
  is_seasonal             BOOLEAN NOT NULL DEFAULT false,
  season_start            DATE,
  season_end              DATE,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO gift_types (code, name, description, gift_type, rarity, required_intimacy_level, daily_limit, max_quantity, friendship_points) VALUES
  ('standard', '好友礼物包', '系统礼物包：精灵球/星尘/浆果，友情等级越高内容越好，可能含精灵蛋', 'standard', 'common', 1, NULL, 1, 10),
  ('item', '道具', '从背包赠送道具（精灵球、浆果、药水等）', 'item', 'common', 1, NULL, 20, 10),
  ('candy', '精灵糖果', '赠送指定精灵的糖果', 'candy', 'uncommon', 2, NULL, 50, 15),
  ('stardust', '星尘', '赠送星尘', 'stardust', 'uncommon', 2, NULL, 5000, 15),
  ('pokemon_egg', '精灵蛋', '赠送背包里的 7 公里精灵蛋', 'pokemon_egg', 'rare', 3, 5, 1, 25),
  ('coins', '金币', '赠送金币', 'coins', 'rare', 4, 5, 500, 20)
ON CONFLICT (code) DO NOTHING;

-- 精灵蛋作为可堆叠道具入 player_inventory（外键 items.item_id）
INSERT INTO items (id, item_id, category, name_zh, name_en, name, description_zh, is_premium)
VALUES ('EGG_7KM', 'EGG_7KM', 'egg', '7公里精灵蛋', '7km Egg', '7km Egg', '好友礼物中获得的精灵蛋', false)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS joint_missions (
  id                      SERIAL PRIMARY KEY,
  code                    VARCHAR(50) NOT NULL UNIQUE,
  mission_type            VARCHAR(50) NOT NULL,
  title                   VARCHAR(200) NOT NULL,
  description             TEXT,
  requirements            JSONB NOT NULL DEFAULT '{}'::jsonb,
  rewards                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_intimacy_level INTEGER NOT NULL DEFAULT 1,
  time_limit_hours        INTEGER,
  difficulty              VARCHAR(20) NOT NULL DEFAULT 'medium'
                          CHECK (difficulty IN ('easy', 'medium', 'hard', 'legendary')),
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO joint_missions (code, mission_type, title, description, requirements, rewards, required_intimacy_level, time_limit_hours, difficulty) VALUES
  ('gift_exchange', 'gift_exchange', '礼尚往来', '双方各给对方送出 1 份礼物',
   '{"type": "gift_exchange", "each": 1}', '{"stardust": 300, "friendship_points": 30}', 1, 48, 'easy'),
  ('catch_together', 'catch', '一起去捕捉', '双方合计捕捉 10 只精灵',
   '{"type": "catch", "count": 10}', '{"stardust": 500, "items": [{"type": "POKE_BALL", "qty": 5}], "friendship_points": 50}', 1, 24, 'easy'),
  ('fire_hunt', 'catch_type', '火焰猎人', '双方合计捕捉 5 只火属性精灵',
   '{"type": "catch_type", "pokemonType": "fire", "count": 5}', '{"stardust": 800, "items": [{"type": "GREAT_BALL", "qty": 5}], "friendship_points": 80}', 3, 72, 'medium'),
  ('catch_marathon', 'catch', '捕捉马拉松', '双方合计捕捉 50 只精灵',
   '{"type": "catch", "count": 50}', '{"stardust": 2000, "items": [{"type": "ULTRA_BALL", "qty": 5}], "friendship_points": 150}', 5, 168, 'hard'),
  ('legend_duo', 'catch', '传说搭档', '双方合计捕捉 150 只精灵',
   '{"type": "catch", "count": 150}', '{"stardust": 5000, "items": [{"type": "MASTER_BALL", "qty": 1}], "friendship_points": 300}', 7, 336, 'legendary')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS joint_mission_progress (
  id                BIGSERIAL PRIMARY KEY,
  mission_id        INTEGER NOT NULL REFERENCES joint_missions(id),
  user1_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user2_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initiated_by      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  progress          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed', 'failed', 'expired')),
  reward_claimed_by UUID[] NOT NULL DEFAULT '{}',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  CHECK (user1_id < user2_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_joint_mission_active
  ON joint_mission_progress(mission_id, user1_id, user2_id) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_joint_mission_progress_users ON joint_mission_progress(user1_id, user2_id, status);
CREATE INDEX IF NOT EXISTS idx_joint_mission_progress_status ON joint_mission_progress(status, expires_at);

CREATE TABLE IF NOT EXISTS friend_activities (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type VARCHAR(50) NOT NULL CHECK (activity_type IN (
                  'catch_pokemon', 'battle_win', 'gym_conquer', 'achievement_unlock',
                  'level_up', 'friend_add', 'gift_receive', 'joint_mission_complete', 'friendship_level_up')),
  content       JSONB NOT NULL DEFAULT '{}'::jsonb,
  visibility    VARCHAR(20) NOT NULL DEFAULT 'friends' CHECK (visibility IN ('public', 'friends', 'private')),
  like_count    INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_friend_activities_user ON friend_activities(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS friend_activity_likes (
  activity_id BIGINT NOT NULL REFERENCES friend_activities(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, user_id)
);

CREATE TABLE IF NOT EXISTS friend_recommendations (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recommended_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recommendation_reason VARCHAR(50) NOT NULL,
  score                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_dismissed          BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  UNIQUE (user_id, recommended_user_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_recommendations_user ON friend_recommendations(user_id, is_dismissed, score DESC);

CREATE TABLE IF NOT EXISTS interaction_reminders (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_type   VARCHAR(50) NOT NULL CHECK (reminder_type IN (
                    'friend_online', 'birthday', 'achievement_unlocked', 'gym_invite', 'gift_received',
                    'joint_mission_invite', 'intimacy_level_up', 'long_time_no_see', 'friend_request',
                    'friend_accepted', 'pokemon_friend_request', 'pokemon_friendship_level_up')),
  related_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content         JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      VARCHAR(120),
  is_read         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_interaction_reminders_user ON interaction_reminders(user_id, is_read, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_reminders_dedupe ON interaction_reminders(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ============================================================
-- 10. 排行榜物化视图与推荐所需索引
-- ============================================================
-- 全服社交排行榜：每个用户的好友数与友情点总和（social-service 每小时 REFRESH CONCURRENTLY）
CREATE MATERIALIZED VIEW IF NOT EXISTS friend_leaderboard AS
SELECT f.user_id,
       COUNT(*)::int                                  AS friend_count,
       COALESCE(SUM(f.friendship_points), 0)::bigint AS total_friendship_points,
       MAX(f.last_interaction_at)                     AS last_active,
       NOW()                                          AS refreshed_at
  FROM friends f
 WHERE f.status = 'accepted'
 GROUP BY f.user_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_leaderboard_user ON friend_leaderboard(user_id);
CREATE INDEX IF NOT EXISTS idx_friend_leaderboard_points ON friend_leaderboard(total_friendship_points DESC);

-- 附近玩家推荐：按经纬度范围查找
CREATE INDEX IF NOT EXISTS idx_users_last_lat_lng ON users(last_lat, last_lng) WHERE last_lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_level_active ON users(level, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_pokemon_instances_user_caught ON pokemon_instances(user_id, caught_at DESC);
